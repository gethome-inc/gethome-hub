import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import type { AdapterBus, ProtocolAdapter } from '../src/adapters/adapter.js';
import { HubEventBus } from '../src/core/bus.js';
import { ActivityService } from '../src/core/activity.js';
import { PairingService } from '../src/core/pairing.js';
import { SettingsService } from '../src/core/settings.js';
import { DeviceRegistry } from '../src/core/registry.js';
import { PermitJoinService } from '../src/core/permit-join.js';
import { AiRunLog } from '../src/core/ai-runs.js';
import { MappingLibrary } from '../src/ai/library.js';
import type { RoleWire } from '../src/core/access.js';
import { brokerPasswordHash } from '../src/core/mqtt-device-accounts.js';
import { activity, mqttDeviceAccounts } from '../src/db/schema.js';
import {
  startedAutomations,
  bootedHome,
  loadedAccess,
  loadedFavorites,
  openTestDb,
  resetDb,
  startedHistory,
  testBroker,
  testPortraits,
} from './helpers/db.js';
import {
  brokerMachine,
  passwdUsers,
  watchForAccountRequests,
  type BrokerMachine,
} from './helpers/mqtt-accounts.js';

/**
 * `/api/v1/mqtt/device-accounts`, driven end to end: a route records the
 * account, the real `deploy/mqtt-accounts.sh` applies it to a staged pair of
 * broker files — started the way `gethome-mqtt-accounts.path` would start it —
 * and the route answers with what happened.
 *
 * What a real broker then makes of those files is
 * `test/deploy-mqtt-acl.test.ts`; who may call each route is here and in
 * `test/roles.test.ts`, and that no API key may is in `test/api-keys.test.ts`.
 */

const handle = await openTestDb();
const log = pino({ level: 'silent' });

/** Stands in for the MQTT adapter: a device on the convention, and what was forgotten. */
class FakeMqttAdapter implements ProtocolAdapter {
  readonly id = 'mqtt' as const;
  bus: AdapterBus | null = null;
  forgotten: string[] = [];
  async start(bus: AdapterBus): Promise<void> {
    this.bus = bus;
  }
  async stop(): Promise<void> {}
  async execute(): Promise<void> {}
  async forget(externalId: string): Promise<void> {
    this.forgotten.push(externalId);
  }
}

const board = (externalId: string, name: string) => ({
  adapter: 'mqtt' as const,
  externalId,
  vendor: 'Acme',
  model: 'Desk light',
  suggestedName: name,
  endpoints: [
    {
      endpointId: 1,
      deviceKind: 'light' as const,
      capabilities: ['onOff'] as 'onOff'[],
      primary: 'onOff' as const,
    },
  ],
});

interface AccountWire {
  deviceId: string;
  username: string;
  projectKey: string | null;
  topics: string[];
  createdAt: string;
  createdBy: string;
  device: { id: string; name: string } | null;
}

describe.skipIf(!handle)('a broker account for each device, over the API', () => {
  const db = handle?.db!;
  let app: FastifyInstance;
  let registry: DeviceRegistry;
  let adapter: FakeMqttAdapter;
  let dataDir: string;
  let m: BrokerMachine;
  let stopWatching: (() => void) | undefined;
  let ownerToken: string;
  let memberToken: string;
  let guestToken: string;
  const scratch: string[] = [];
  const tmp = () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gethome-mqttacct-api-'));
    scratch.push(dir);
    return dir;
  };

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const mint = (token: string, payload: object) =>
    app.inject({ method: 'POST', url: '/api/v1/mqtt/device-accounts', headers: auth(token), payload });
  const list = async (token: string) =>
    (
      await app.inject({ method: 'GET', url: '/api/v1/mqtt/device-accounts', headers: auth(token) })
    ).json() as { available: boolean; max: number; accounts: AccountWire[] };
  interface AccountRow {
    kind: string;
    message: string;
    memberId?: string;
    deviceId?: string | null;
    data?: Record<string, unknown>;
  }
  const rows = async (): Promise<AccountRow[]> =>
    (
      (await app.inject({ method: 'GET', url: '/api/v1/activity', headers: auth(ownerToken) })).json() as AccountRow[]
    ).filter((entry) => entry.kind === 'device.mqtt-account');
  const messages = async (): Promise<string[]> => (await rows()).map((entry) => entry.message);

  const waitFor = async (label: string, check: () => boolean, timeoutMs = 5000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  beforeAll(async () => {
    await resetDb(db);
    dataDir = tmp();
    // The installer writes the capability before it restarts the hub, so the
    // hub reads it at start; staged here the same way round.
    m = brokerMachine(tmp, { data: dataDir });
    const events = new HubEventBus();
    const activityLog = new ActivityService(db, events);
    const access = await loadedAccess(db, events);
    const pairing = new PairingService(db, dataDir, log, access);
    await pairing.boot();
    registry = new DeviceRegistry(db, events, activityLog, log);
    adapter = new FakeMqttAdapter();
    registry.registerAdapter(adapter);
    await registry.start();
    const settings = new SettingsService(db, Buffer.alloc(32).toString('base64'));
    const {
      engine: automations,
      store: automationStore,
      chat: automationChat,
      assistant: assistantChat,
    } = await startedAutomations(db, events, registry, activityLog);
    app = await buildServer({
      db,
      log,
      events,
      registry,
      favorites: await loadedFavorites(db, events),
      access,
      pairing,
      activity: activityLog,
      automations,
      automationStore,
      automationChat,
      assistantChat,
      history: await startedHistory(db, events),
      portraits: testPortraits(db, events),
      settings,
      hubId: 'hub-accounts-test',
      home: await bootedHome(db, 'Accounts Hub'),
      version: '0.1.0-test',
      dataDir,
      radioBudget: 'one',
      z2mDataDir: path.join(dataDir, 'zigbee2mqtt'),
      zigbeeEnvFile: path.join(dataDir, 'zigbee.env'),
      mqtt: testBroker({ publicHost: '192.168.1.20' }),
      permitJoin: new PermitJoinService(undefined, log, () => {}),
      aiRuns: new AiRunLog(db, events),
      mappings: new MappingLibrary({ db, settings, registry, log }),
      // Long enough for a bash script on a loaded CI runner, short enough that
      // the one test that wants a timeout does not sit on it.
      mqttAccountApplyWaitMs: 4000,
    });

    const code = readFileSync(path.join(dataDir, 'pairing-code'), 'utf8').trim();
    const claimed = await app.inject({
      method: 'POST',
      url: '/api/v1/pair',
      payload: { code, memberName: 'Georgy', deviceName: 'MacBook' },
    });
    ownerToken = (claimed.json() as { token: string }).token;
    const roles = (
      await app.inject({ method: 'GET', url: '/api/v1/roles', headers: auth(ownerToken) })
    ).json() as RoleWire[];
    const join = async (roleKey: string, memberName: string): Promise<string> => {
      const invite = await app.inject({
        method: 'POST',
        url: '/api/v1/invites',
        headers: auth(ownerToken),
        payload: { roleId: roles.find((role) => role.key === roleKey)!.id },
      });
      const joined = await app.inject({
        method: 'POST',
        url: '/api/v1/pair',
        payload: { code: (invite.json() as { code: string }).code, memberName },
      });
      return (joined.json() as { token: string }).token;
    };
    memberToken = await join('member', 'Anna');
    guestToken = await join('guest', 'Sam');
  });

  beforeEach(() => {
    stopWatching = watchForAccountRequests(m);
  });

  afterEach(async () => {
    stopWatching?.();
    stopWatching = undefined;
    await db.delete(mqttDeviceAccounts);
    for (const device of registry.listDevices()) await registry.removeDevice(device.id);
    await registry.flush();
    // Each test reads the feed as its own.
    await db.delete(activity);
    // The staged broker goes back to what an installer leaves.
    writeFileSync(
      m.passwd,
      `gethome-hub:${brokerPasswordHash('hub-secret')}\ngethome:${brokerPasswordHash('integration-secret')}\n`,
    );
  });

  afterAll(async () => {
    await app.close();
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  });

  it('says on GET /hub that this hub gives devices their own accounts', async () => {
    const hub = (await app.inject({ method: 'GET', url: '/api/v1/hub' })).json();
    expect(hub.mqtt).toEqual({ deviceAccounts: { available: true, max: 250 } });
  });

  it('gives a member’s board its own account, once, with everything needed to hand it over', async () => {
    const response = await mint(memberToken, { deviceId: 'desk-light-x7k2q9', projectKey: '9f3a11c2' });
    expect(response.statusCode).toBe(201);
    const body = response.json() as {
      account: AccountWire;
      password: string;
      host: string;
      port: number;
      state: string;
    };
    expect(body).toMatchObject({
      account: {
        deviceId: 'desk-light-x7k2q9',
        username: 'desk-light-x7k2q9',
        projectKey: '9f3a11c2',
        topics: [
          'gethome/device/desk-light-x7k2q9/#',
          'gethome/discovery/desk-light-x7k2q9/#',
          'gethome/project/9f3a11c2/#',
        ],
        createdBy: 'Anna',
        // Nothing has announced itself under that id yet.
        device: null,
      },
      host: '192.168.1.20',
      port: 1883,
      state: 'applied',
    });
    expect(body.password).toMatch(/^[0-9a-f]{32}$/);
    expect(passwdUsers(m)).toEqual(['gethome-hub', 'gethome', 'desk-light-x7k2q9']);

    // The password is in that answer and nowhere afterwards.
    const listed = await list(memberToken);
    expect(listed).toMatchObject({ available: true, max: 250 });
    expect(listed.accounts).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(body.password);
    expect(JSON.stringify(listed)).not.toContain('$7$');

    expect(await messages()).toEqual(['Anna gave “desk-light-x7k2q9” its own MQTT account.']);
    // The row is Anna's, and says so in its sentence alone. An iPhone build
    // that has never met this kind titles a row with no device by
    // `data.memberName`, over the hub's sentence — which already names her.
    const [row] = await rows();
    expect(row!.memberId).toBeTruthy();
    // No device to file it under yet: nothing has announced itself.
    expect(row!.deviceId ?? null).toBeNull();
    expect(row!.data).toEqual({ action: 'add', mqttDeviceId: 'desk-light-x7k2q9', projectKey: '9f3a11c2' });
  });

  it('names the device in the home once the board has arrived', async () => {
    await mint(ownerToken, { deviceId: 'desk-light-x7k2q9' });
    adapter.bus!.deviceUpserted(board('desk-light-x7k2q9', 'Desk light'));
    await registry.flush();
    const [account] = (await list(ownerToken)).accounts;
    expect(account!.device).toEqual({ id: registry.listDevices()[0]!.id, name: 'Desk light' });

    // Set up a second time by somebody else: a new password, the row says
    // whose it is now, and the home is told the account changed hands.
    const again = await mint(memberToken, { deviceId: 'desk-light-x7k2q9' });
    expect(again.statusCode).toBe(201);
    expect((await list(ownerToken)).accounts).toMatchObject([{ createdBy: 'Anna' }]);
    expect(await messages()).toEqual([
      'Anna gave Desk light a new password for its own MQTT account.',
      'Georgy gave “desk-light-x7k2q9” its own MQTT account.',
    ]);
    // Once the device is in the home the row is filed under it, so every app
    // titles the line with the device's name.
    const [replaced] = await rows();
    expect(replaced!.deviceId).toBe(registry.listDevices()[0]!.id);
    expect(replaced!.data).toEqual({
      action: 'replace',
      mqttDeviceId: 'desk-light-x7k2q9',
      deviceName: 'Desk light',
    });
  });

  it('says nothing more when somebody sets their own device up again', async () => {
    // A program deployed for the tenth time is given a fresh password each
    // time. The home was told who gave it an account the first time; nine
    // more lines saying so would bury what the feed is for.
    const first = await mint(memberToken, { deviceId: 'tide-table-m3n4p5' });
    const second = await mint(memberToken, { deviceId: 'tide-table-m3n4p5' });
    const third = await mint(memberToken, { deviceId: 'tide-table-m3n4p5', projectKey: '9f3a11c2' });
    expect([first.statusCode, second.statusCode, third.statusCode]).toEqual([201, 201, 201]);
    const passwords = [first, second, third].map((response) => (response.json() as { password: string }).password);
    expect(new Set(passwords).size).toBe(3);
    expect(await messages()).toEqual(['Anna gave “tide-table-m3n4p5” its own MQTT account.']);
  });

  it('refuses a body it does not wholly understand, and an id no device can have', async () => {
    for (const payload of [
      {},
      { deviceId: '' },
      { deviceId: 'two words' },
      { deviceId: 'slash/in/it' },
      { deviceId: 'plus+in-it' },
      { deviceId: 'x'.repeat(65) },
      { deviceId: 'desk-light-x7k2q9', projectKey: 'not/a/key' },
      // The list writes "no project" as `-`, so a key of `-` would make an
      // account with none while the answer named `gethome/project/-/#`.
      { deviceId: 'desk-light-x7k2q9', projectKey: '-' },
      // Strict: a field a later build adds to narrow an account must be a 400
      // here, never an account broader than the caller asked for.
      { deviceId: 'desk-light-x7k2q9', topics: ['gethome/#'] },
    ]) {
      const response = await mint(ownerToken, payload);
      expect([response.statusCode, payload]).toEqual([400, payload]);
    }
    expect((await list(ownerToken)).accounts).toEqual([]);
  });

  it('will not hand out the broker’s own two names', async () => {
    for (const deviceId of ['gethome-hub', 'gethome']) {
      const response = await mint(ownerToken, { deviceId });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: 'device_id_reserved' });
    }
  });

  it('ends a device’s account when the device is deleted in an app', async () => {
    await mint(ownerToken, { deviceId: 'desk-light-x7k2q9' });
    await mint(ownerToken, { deviceId: 'porch-cam-aa11bb' });
    adapter.bus!.deviceUpserted(board('desk-light-x7k2q9', 'Desk light'));
    await registry.flush();
    const device = registry.listDevices()[0]!;

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/devices/${device.id}`,
      headers: auth(ownerToken),
    });
    expect(removed.statusCode).toBe(204);

    // The account is gone from the list at once …
    expect((await list(ownerToken)).accounts.map((account) => account.deviceId)).toEqual([
      'porch-cam-aa11bb',
    ]);
    // … and from the broker a moment later — after the board has had the
    // chance to hear that it was removed (`REVOKE_SETTLE_MS`).
    await waitFor('the broker’s file to lose the device', () => !passwdUsers(m).includes('desk-light-x7k2q9'));
    expect(passwdUsers(m)).toEqual(['gethome-hub', 'gethome', 'porch-cam-aa11bb']);
  });

  it('ends it too when the device withdraws itself', async () => {
    await mint(ownerToken, { deviceId: 'desk-light-x7k2q9' });
    adapter.bus!.deviceUpserted(board('desk-light-x7k2q9', 'Desk light'));
    await registry.flush();
    // An empty retained discovery document, as the MQTT adapter reports it.
    adapter.bus!.deviceRemoved('mqtt', 'desk-light-x7k2q9');
    await registry.flush();
    await waitFor('the broker’s file to lose the device', () => !passwdUsers(m).includes('desk-light-x7k2q9'));
    expect((await list(ownerToken)).accounts).toEqual([]);
  });

  it('takes an account away on its own, for a board that never arrived', async () => {
    await mint(ownerToken, { deviceId: 'desk-light-x7k2q9' });
    const revoked = await app.inject({
      method: 'DELETE',
      url: '/api/v1/mqtt/device-accounts/desk-light-x7k2q9',
      headers: auth(ownerToken),
    });
    expect(revoked.statusCode).toBe(204);
    expect(passwdUsers(m)).toEqual(['gethome-hub', 'gethome']);
    expect((await messages())[0]).toBe('Georgy took away the MQTT account “desk-light-x7k2q9” had.');

    const again = await app.inject({
      method: 'DELETE',
      url: '/api/v1/mqtt/device-accounts/desk-light-x7k2q9',
      headers: auth(ownerToken),
    });
    expect(again.statusCode).toBe(404);
  });

  it('answers 202 with the account when the root script has not answered yet', async () => {
    stopWatching?.();
    stopWatching = undefined;
    const response = await mint(ownerToken, { deviceId: 'desk-light-x7k2q9' });
    expect(response.statusCode).toBe(202);
    const body = response.json() as { password: string; state: string };
    // The password is still handed over: it exists nowhere else, and the
    // account is recorded and on its way.
    expect(body.state).toBe('pending');
    expect(body.password).toMatch(/^[0-9a-f]{32}$/);
    expect((await list(ownerToken)).accounts).toHaveLength(1);
  }, 15_000);

  it('answers 502 and keeps nothing when the broker’s files cannot take it', async () => {
    writeFileSync(m.passwd, `gethome:${brokerPasswordHash('integration-secret')}\n`);
    const response = await mint(ownerToken, { deviceId: 'desk-light-x7k2q9' });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ error: 'mqtt_account_not_applied' });
    expect((await list(ownerToken)).accounts).toEqual([]);
    expect(await messages()).toEqual([]);
  });

  describe('who may', () => {
    it('lets a member make and list accounts, and only somebody who may remove devices end one', async () => {
      // `device.add` is in Member's default set; `device.remove` is not.
      expect((await mint(memberToken, { deviceId: 'desk-light-x7k2q9' })).statusCode).toBe(201);
      const listed = await app.inject({
        method: 'GET',
        url: '/api/v1/mqtt/device-accounts',
        headers: auth(memberToken),
      });
      expect(listed.statusCode).toBe(200);
      const revoke = await app.inject({
        method: 'DELETE',
        url: '/api/v1/mqtt/device-accounts/desk-light-x7k2q9',
        headers: auth(memberToken),
      });
      expect(revoke.statusCode).toBe(403);
      expect(revoke.json()).toMatchObject({ error: 'forbidden', permission: 'device.remove' });
      expect(passwdUsers(m)).toContain('desk-light-x7k2q9');
    });

    it('gives a guest nothing here', async () => {
      const made = await mint(guestToken, { deviceId: 'desk-light-x7k2q9' });
      expect(made.statusCode).toBe(403);
      expect(made.json()).toMatchObject({ error: 'forbidden', permission: 'device.add' });
      const listed = await app.inject({
        method: 'GET',
        url: '/api/v1/mqtt/device-accounts',
        headers: auth(guestToken),
      });
      expect(listed.statusCode).toBe(403);
      expect(passwdUsers(m)).toEqual(['gethome-hub', 'gethome']);
    });

    it('needs a token at all', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/mqtt/device-accounts',
        payload: { deviceId: 'desk-light-x7k2q9' },
      });
      expect(response.statusCode).toBe(401);
    });
  });
});

describe.skipIf(!handle)('a hub whose installer never set device accounts up', () => {
  const db = handle?.db!;
  let app: FastifyInstance;
  let ownerToken: string;
  const dirs: string[] = [];

  beforeAll(async () => {
    await resetDb(db);
    const dataDir = mkdtempSync(path.join(tmpdir(), 'gethome-mqttacct-old-'));
    dirs.push(dataDir);
    const events = new HubEventBus();
    const activityLog = new ActivityService(db, events);
    const access = await loadedAccess(db, events);
    const pairing = new PairingService(db, dataDir, log, access);
    await pairing.boot();
    const registry = new DeviceRegistry(db, events, activityLog, log);
    await registry.start();
    const settings = new SettingsService(db, Buffer.alloc(32).toString('base64'));
    const {
      engine: automations,
      store: automationStore,
      chat: automationChat,
      assistant: assistantChat,
    } = await startedAutomations(db, events, registry, activityLog);
    app = await buildServer({
      db,
      log,
      events,
      registry,
      favorites: await loadedFavorites(db, events),
      access,
      pairing,
      activity: activityLog,
      automations,
      automationStore,
      automationChat,
      assistantChat,
      history: await startedHistory(db, events),
      portraits: testPortraits(db, events),
      settings,
      hubId: 'hub-accounts-old',
      home: await bootedHome(db, 'Older Hub'),
      version: '0.1.0-test',
      dataDir,
      radioBudget: 'one',
      z2mDataDir: path.join(dataDir, 'zigbee2mqtt'),
      zigbeeEnvFile: path.join(dataDir, 'zigbee.env'),
      mqtt: testBroker(),
      permitJoin: new PermitJoinService(undefined, log, () => {}),
      aiRuns: new AiRunLog(db, events),
      mappings: new MappingLibrary({ db, settings, registry, log }),
    });
    const code = readFileSync(path.join(dataDir, 'pairing-code'), 'utf8').trim();
    const claimed = await app.inject({
      method: 'POST',
      url: '/api/v1/pair',
      payload: { code, memberName: 'Georgy', deviceName: 'MacBook' },
    });
    ownerToken = (claimed.json() as { token: string }).token;
  });

  afterAll(async () => {
    await app.close();
    // The last suite in the file, so the one that closes the database.
    await handle?.close();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it('says so on GET /hub, so an app hands the board the shared account instead', async () => {
    const hub = (await app.inject({ method: 'GET', url: '/api/v1/hub' })).json();
    expect(hub.mqtt).toEqual({
      deviceAccounts: { available: false, reason: 'not-installed', max: 250 },
    });
  });

  it('refuses to make one rather than recording an account no broker will ever hold', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/mqtt/device-accounts',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { deviceId: 'desk-light-x7k2q9' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'mqtt_device_accounts_unavailable' });
  });
});
