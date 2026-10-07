import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { HubEventBus } from '../src/core/bus.js';
import { ActivityService } from '../src/core/activity.js';
import { PairingService } from '../src/core/pairing.js';
import { SettingsService } from '../src/core/settings.js';
import { DeviceRegistry } from '../src/core/registry.js';
import { PermitJoinService } from '../src/core/permit-join.js';
import { AiRunLog } from '../src/core/ai-runs.js';
import { MappingLibrary } from '../src/ai/library.js';
import type { RoleWire } from '../src/core/access.js';
import { passwordProblem, ssidProblem, wpaPsk } from '../src/core/wifi-networks.js';
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
  machine,
  profilesOf,
  runWifiScript,
  watchForRequests,
  type Machine,
} from './helpers/fake-nmcli.js';

/**
 * The hub's half of "add another Wi-Fi network for my hub", driven end to end:
 * the routes write a request, the real `deploy/wifi-networks.sh` applies it to
 * a pretend NetworkManager — started the way `gethome-wifi.path` would start
 * it — and the routes answer with what happened.
 */

const handle = await openTestDb();
const log = pino({ level: 'silent' });

const HOME_ID = '11111111-2222-3333-4444-555555555555';
const SPARE_ID = '66666666-7777-8888-9999-000000000000';

describe('what a network and its password may be', () => {
  it('derives the WPA key the way every router does', () => {
    // IEEE 802.11i's own test vector, which Studio's `SDProvisioner.wpaPSK` is
    // matched against too: the two must produce the same key for the same
    // network, or a network added from an app and one written to a card differ.
    expect(wpaPsk('IEEE', 'password')).toBe(
      'f42c6fc52df0ebef9ebb4b90b38a5f902e83fe1b135a70e23aed762e9710a12e',
    );
  });

  it('passes a 64-hex key through, which is what a card carries', () => {
    const key = 'A'.repeat(64);
    expect(wpaPsk('Anything', key)).toBe('a'.repeat(64));
    expect(passwordProblem(key)).toBeUndefined();
  });

  it('refuses an open network, a short password, and a name Wi-Fi does not allow', () => {
    expect(passwordProblem('')).toMatch(/only joins Wi-Fi networks that have a password/);
    expect(passwordProblem('short')).toMatch(/8 to 63/);
    expect(ssidProblem('')).toBeDefined();
    // 32 *bytes*, not characters — eleven Cyrillic letters are 22 bytes and
    // seventeen are 34.
    expect(ssidProblem('Д'.repeat(16))).toBeUndefined();
    expect(ssidProblem('Д'.repeat(17))).toMatch(/32 bytes/);
    expect(ssidProblem('Flat\n3')).toMatch(/line breaks/);
  });
});

describe.skipIf(!handle)('the Wi-Fi network routes', () => {
  const db = handle?.db!;
  let app: FastifyInstance;
  let dataDir: string;
  let m: Machine;
  let stopWatching: (() => void) | undefined;
  let ownerToken: string;
  let memberToken: string;
  const scratch: string[] = [];
  const tmp = () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gethome-wifiroutes-'));
    scratch.push(dir);
    return dir;
  };

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  /** A fresh pretend machine under the same data directory, listed. */
  const stage = () => {
    m = machine(
      tmp,
      [
        { uuid: HOME_ID, type: '802-11-wireless', active: true, name: 'preconfigured', ssid: 'Flat 3' },
        { uuid: SPARE_ID, type: '802-11-wireless', active: false, name: 'gethome', ssid: 'Old flat' },
      ],
      { data: dataDir },
    );
    for (const file of ['request', 'result', 'unsupported']) {
      rmSync(path.join(dataDir, 'wifi', file), { force: true });
    }
    writeFileSync(path.join(dataDir, 'wifi', 'enabled'), '');
    runWifiScript(m, ['--list']);
  };

  beforeAll(async () => {
    await resetDb(db);
    dataDir = tmp();
    // The installer writes the capability before it restarts the hub, so the
    // hub reads it at start; staged here the same way round.
    stage();
    const events = new HubEventBus();
    const activity = new ActivityService(db, events);
    const access = await loadedAccess(db, events);
    const pairing = new PairingService(db, dataDir, log, access);
    await pairing.boot();
    const registry = new DeviceRegistry(db, events, activity, log);
    await registry.start();
    const settings = new SettingsService(db, Buffer.alloc(32).toString('base64'));
    const {
      engine: automations,
      store: automationStore,
      chat: automationChat,
      assistant: assistantChat,
    } = await startedAutomations(db, events, registry, activity);
    app = await buildServer({
      db,
      log,
      events,
      registry,
      favorites: await loadedFavorites(db, events),
      access,
      pairing,
      activity,
      automations,
      automationStore,
      automationChat,
      assistantChat,
      history: await startedHistory(db, events),
      portraits: testPortraits(db, events),
      settings,
      hubId: 'hub-wifi-test',
      home: await bootedHome(db, 'Wi-Fi Hub'),
      version: '0.1.0-test',
      dataDir,
      radioBudget: 'one',
      z2mDataDir: path.join(dataDir, 'zigbee2mqtt'),
      zigbeeEnvFile: path.join(dataDir, 'zigbee.env'),
      mqtt: testBroker(),
      permitJoin: new PermitJoinService(undefined, log, () => {}),
      aiRuns: new AiRunLog(db, events),
      mappings: new MappingLibrary({ db, settings, registry, log }),
      // Long enough for a bash script on a loaded CI runner, short enough that
      // the one test that wants a timeout does not sit on it.
      wifiApplyWaitMs: 4000,
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
    const invite = await app.inject({
      method: 'POST',
      url: '/api/v1/invites',
      headers: auth(ownerToken),
      payload: { roleId: roles.find((role) => role.key === 'member')!.id },
    });
    const joined = await app.inject({
      method: 'POST',
      url: '/api/v1/pair',
      payload: { code: (invite.json() as { code: string }).code, memberName: 'Anna' },
    });
    memberToken = (joined.json() as { token: string }).token;
  });

  afterEach(() => {
    stopWatching?.();
    stopWatching = undefined;
    stage();
  });

  afterAll(async () => {
    await app.close();
    await handle?.close();
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  });

  it('says on GET /hub that this hub can change its networks', async () => {
    const hub = (await app.inject({ method: 'GET', url: '/api/v1/hub' })).json();
    expect(hub.wifiNetworks).toEqual({ available: true });
  });

  it('lists the networks this hub knows, the one it is on first', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/settings/wifi', headers: auth(memberToken) });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      available: true,
      maxNetworks: 16,
      pending: false,
      networks: [
        { id: HOME_ID, ssid: 'Flat 3', connected: true },
        { id: SPARE_ID, ssid: 'Old flat', connected: false },
      ],
    });
  });

  it('adds a network and answers with the outcome, for any member by default', async () => {
    stopWatching = watchForRequests(m);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/settings/wifi/networks',
      headers: auth(memberToken),
      payload: { ssid: 'Дача', passphrase: 'correct horse battery' },
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.change).toMatchObject({ action: 'add', state: 'applied', ssid: 'Дача' });
    expect(body.networks.map((n: { ssid: string }) => n.ssid)).toEqual(['Flat 3', 'Old flat', 'Дача']);
    expect(profilesOf(m).find((p) => p.ssid === 'Дача')).toBeDefined();

    // Named in the activity log, by the person, without the password.
    const feed = (
      await app.inject({ method: 'GET', url: '/api/v1/activity', headers: auth(ownerToken) })
    ).json() as Array<{ kind: string; message: string; data: Record<string, unknown> }>;
    const row = feed.find((entry) => entry.kind === 'hub.wifi');
    expect(row?.message).toBe('Anna added the Wi-Fi network “Дача” to the hub.');
    expect(row?.data).toMatchObject({ action: 'add', ssid: 'Дача', outcome: 'applied' });
    expect(JSON.stringify(row)).not.toContain('correct horse');
  });

  it('never writes the password as it was typed', async () => {
    stopWatching = watchForRequests(m);
    await app.inject({
      method: 'POST',
      url: '/api/v1/settings/wifi/networks',
      headers: auth(ownerToken),
      payload: { ssid: 'Dacha', passphrase: 'my-everywhere-password' },
    });
    for (const dir of [dataDir, m.nm]) {
      for (const file of readdirSync(dir, { recursive: true }) as string[]) {
        const full = path.join(dir, file);
        if (!statSync(full).isFile()) continue;
        expect(readFileSync(full, 'utf8'), full).not.toContain('my-everywhere-password');
      }
    }
  });

  it('refuses a network the hub already knows before asking the machine', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/settings/wifi/networks',
      headers: auth(ownerToken),
      payload: { ssid: 'Flat 3', passphrase: 'password1' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'wifi_network_exists' });
  });

  it('says which rule a password broke, in words', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/settings/wifi/networks',
      headers: auth(ownerToken),
      payload: { ssid: 'Cafe', passphrase: '' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().detail).toBe('The hub only joins Wi-Fi networks that have a password.');
  });

  it('removes a network the hub is not on', async () => {
    stopWatching = watchForRequests(m);
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/settings/wifi/networks/${SPARE_ID}`,
      headers: auth(memberToken),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().networks).toEqual([{ id: HOME_ID, ssid: 'Flat 3', connected: true }]);
    expect(profilesOf(m).map((p) => p.uuid)).toEqual([HOME_ID]);
  });

  it('never removes the network the hub is connected through', async () => {
    // Refused by the hub without writing a request — and by the script too,
    // which `test/deploy-wifi-networks.test.ts` proves on its own.
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/settings/wifi/networks/${HOME_ID}`,
      headers: auth(ownerToken),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'wifi_network_connected' });
    expect(profilesOf(m)).toHaveLength(2);
  });

  it('answers 404 for a network it does not know', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/v1/settings/wifi/networks/99999999-9999-9999-9999-999999999999',
      headers: auth(ownerToken),
    });
    expect(response.statusCode).toBe(404);
  });

  it('refuses a second change while the first is waiting', async () => {
    writeFileSync(path.join(dataDir, 'wifi', 'request'), 'id=0123456789abcdef\naction=remove\n');
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/settings/wifi/networks',
      headers: auth(ownerToken),
      payload: { ssid: 'Dacha', passphrase: 'password1' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'wifi_change_pending' });
  });

  it('answers 202 when the machine has not got to it yet, and says so in the log', async () => {
    const quick = await app.inject({
      method: 'POST',
      url: '/api/v1/settings/wifi/networks',
      headers: auth(ownerToken),
      payload: { ssid: 'Slow', passphrase: 'password1' },
    });
    // Nothing is watching, so the hub waits its whole budget and then hands
    // back a receipt rather than an error: the change is still queued.
    expect(quick.statusCode).toBe(202);
    expect(quick.json()).toMatchObject({ pending: true, change: { state: 'pending' } });
    const feed = (
      await app.inject({ method: 'GET', url: '/api/v1/activity', headers: auth(ownerToken) })
    ).json() as Array<{ kind: string; message: string }>;
    expect(feed.find((entry) => entry.kind === 'hub.wifi')?.message).toBe(
      'Georgy asked the hub to add the Wi-Fi network “Slow”.',
    );
  }, 20_000);

  it('passes on what the machine refused, when the hub could not have known', async () => {
    // The hub's list is a minute stale at worst; here the profile appeared on
    // the machine after it was written, and the script is what notices.
    stopWatching = watchForRequests(m);
    writeFileSync(
      path.join(m.nm, 'profiles'),
      `${readFileSync(path.join(m.nm, 'profiles'), 'utf8')}77777777-7777-7777-7777-777777777777\t802-11-wireless\tno\thand\tBy hand\n`,
    );
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/settings/wifi/networks',
      headers: auth(ownerToken),
      payload: { ssid: 'By hand', passphrase: 'password1' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'wifi_network_exists' });
  });

  it('says why on a machine that cannot, without writing anything', async () => {
    rmSync(path.join(dataDir, 'wifi', 'enabled'));
    writeFileSync(path.join(dataDir, 'wifi', 'unsupported'), 'no-networkmanager\n');
    const settings = await app.inject({ method: 'GET', url: '/api/v1/settings/wifi', headers: auth(ownerToken) });
    expect(settings.json()).toMatchObject({ available: false, reason: 'no-networkmanager' });
    const refused = await app.inject({
      method: 'POST',
      url: '/api/v1/settings/wifi/networks',
      headers: auth(ownerToken),
      payload: { ssid: 'Dacha', passphrase: 'password1' },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: 'wifi_unsupported', reason: 'no-networkmanager' });
  });
});
