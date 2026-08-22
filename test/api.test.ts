import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import WebSocket from 'ws';
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
import type { AdapterBus, ProtocolAdapter } from '../src/adapters/adapter.js';
import type { HubCommand } from '../src/schema/index.js';
import { bootedHome, openTestDb, resetDb } from './helpers/db.js';

const handle = await openTestDb();
const log = pino({ level: 'silent' });

class FakeAdapter implements ProtocolAdapter {
  readonly id = 'mqtt' as const;
  bus: AdapterBus | null = null;
  executed: Array<{ externalId: string; endpointId: number; command: HubCommand }> = [];
  async start(bus: AdapterBus) {
    this.bus = bus;
  }
  async stop() {}
  async execute(externalId: string, endpointId: number, command: HubCommand) {
    this.executed.push({ externalId, endpointId, command });
  }
}

describe.skipIf(!handle)('hub API', () => {
  // Skipped suites still have their body collected, so never deref a null
  // handle here; `db` is only read once the suite actually runs.
  const db = handle?.db!;
  let app: FastifyInstance;
  let adapter: FakeAdapter;
  let registry: DeviceRegistry;
  let events: HubEventBus;
  let dataDir: string;
  let ownerToken: string;
  let memberToken: string;

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    await resetDb(db);
    dataDir = mkdtempSync(path.join(tmpdir(), 'gethome-api-'));
    events = new HubEventBus();
    const activity = new ActivityService(db, events);
    const pairing = new PairingService(db, dataDir, log);
    await pairing.boot();
    adapter = new FakeAdapter();
    registry = new DeviceRegistry(db, events, activity, log);
    registry.registerAdapter(adapter);
    await registry.start();
    const settings = new SettingsService(db, Buffer.alloc(32).toString('base64'));
    app = await buildServer({
      db,
      log,
      events,
      registry,
      pairing,
      activity,
      settings,
      hubId: 'hub-test-1234',
      home: await bootedHome(db, 'Test Hub'),
      version: '0.1.0-test',
      dataDir,
      // The interesting case: a board that affords one radio, so the switch is
      // offered and the hub has a real choice to record.
      radioBudget: 'one',
      // Nothing there to read, which is the ordinary state for a hub with no
      // coordinator — and must stay silent rather than becoming an error.
      z2mDataDir: path.join(dataDir, 'zigbee2mqtt'),
      // No radio, so it reports a closed window and publishes nothing.
      permitJoin: new PermitJoinService(undefined, log, () => {}),
      aiRuns: new AiRunLog(db, events),
      // No Zigbee adapter: the library still lists, stores and deletes, which
      // is the point — none of that needs a radio or a credential.
      mappings: new MappingLibrary({ db, settings, registry, log }),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await handle?.close();
  });

  it('serves unauthenticated hub info while unclaimed', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/hub' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      hubId: 'hub-test-1234',
      apiVersion: 1,
      claimed: false,
    });
  });

  it('rejects API calls without a token', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/devices' });
    expect(response.statusCode).toBe(401);
  });

  it('claims the hub: wrong code 401, right code issues an owner token', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/pair',
      payload: { code: '00000000', memberName: 'Mallory' },
    });
    expect(bad.statusCode).toBe(401);

    const code = readFileSync(path.join(dataDir, 'pairing-code'), 'utf8').trim();
    const good = await app.inject({
      method: 'POST',
      url: '/api/v1/pair',
      payload: { code, memberName: 'Georgy', deviceName: 'iPhone' },
    });
    expect(good.statusCode).toBe(200);
    const body = good.json() as { token: string; member: { role: string } };
    expect(body.member.role).toBe('owner');
    ownerToken = body.token;

    const info = await app.inject({ method: 'GET', url: '/api/v1/hub' });
    expect(info.json()).toMatchObject({ claimed: true });
  });

  it('admits a member through an invite', async () => {
    const invite = await app.inject({
      method: 'POST',
      url: '/api/v1/invites',
      headers: auth(ownerToken),
    });
    expect(invite.statusCode).toBe(201);
    const { code } = invite.json() as { code: string };

    const joined = await app.inject({
      method: 'POST',
      url: '/api/v1/pair',
      payload: { code, memberName: 'Anna' },
    });
    expect(joined.statusCode).toBe(200);
    const body = joined.json() as { token: string; member: { role: string } };
    expect(body.member.role).toBe('member');
    memberToken = body.token;
  });

  it('points each caller at its own row in the member list', async () => {
    type Row = { id: string; name: string; role: string; isSelf: boolean };
    const asMember = (
      await app.inject({ method: 'GET', url: '/api/v1/members', headers: auth(memberToken) })
    ).json() as Row[];
    expect(asMember.find((row) => row.name === 'Anna')).toMatchObject({ role: 'member', isSelf: true });
    expect(asMember.find((row) => row.name === 'Georgy')).toMatchObject({ role: 'owner', isSelf: false });

    // The same list, read by the other member: only the flag moves.
    const asOwner = (
      await app.inject({ method: 'GET', url: '/api/v1/members', headers: auth(ownerToken) })
    ).json() as Row[];
    expect(asOwner.find((row) => row.name === 'Georgy')?.isSelf).toBe(true);
    expect(asOwner.find((row) => row.name === 'Anna')?.isSelf).toBe(false);
  });

  it('lets a member rename itself, trimming and refusing an empty name', async () => {
    const renamed = await app.inject({
      method: 'PATCH',
      url: '/api/v1/members/me',
      headers: auth(memberToken),
      payload: { name: "  Anna's iPhone  " },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ name: "Anna's iPhone", role: 'member' });

    const rows = (
      await app.inject({ method: 'GET', url: '/api/v1/members', headers: auth(ownerToken) })
    ).json() as Array<{ name: string; role: string }>;
    expect(rows.map((row) => row.name).sort()).toEqual(["Anna's iPhone", 'Georgy']);

    const feed = (
      await app.inject({ method: 'GET', url: '/api/v1/activity', headers: auth(ownerToken) })
    ).json() as Array<{ kind: string; message: string }>;
    expect(feed[0]).toMatchObject({
      kind: 'member.renamed',
      message: "Anna is now called Anna's iPhone.",
    });

    for (const name of ['   ', 'n'.repeat(81)]) {
      const refused = await app.inject({
        method: 'PATCH',
        url: '/api/v1/members/me',
        headers: auth(memberToken),
        payload: { name },
      });
      expect(refused.statusCode).toBe(400);
    }

    // No token, no member to rename — the token *is* the identity here.
    const anonymous = await app.inject({
      method: 'PATCH',
      url: '/api/v1/members/me',
      payload: { name: 'Mallory' },
    });
    expect(anonymous.statusCode).toBe(401);
  });

  // Both removal routes, against members minted for the purpose: the suite's
  // own `memberToken` is what every later test authenticates with, and a test
  // that revoked it would fail the rest of the file rather than itself.
  it('lets a member leave, and an owner remove somebody — taking their token with them', async () => {
    // Leaving: their own decision, so their own token is enough.
    const leaver = await join('Kolya');
    const left = await app.inject({
      method: 'DELETE',
      url: '/api/v1/members/me',
      headers: auth(leaver.token),
    });
    expect(left.statusCode).toBe(204);
    // The token went with the row — this is the whole point of removing
    // somebody, and it rests on the tokens cascade.
    const afterLeaving = await app.inject({
      method: 'GET',
      url: '/api/v1/members',
      headers: auth(leaver.token),
    });
    expect(afterLeaving.statusCode).toBe(401);

    // Removing: the owner's call, by id.
    const removed = await join('Masha');
    const gone = await app.inject({
      method: 'DELETE',
      url: `/api/v1/members/${removed.member.id}`,
      headers: auth(ownerToken),
    });
    expect(gone.statusCode).toBe(204);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/devices',
          headers: auth(removed.token),
        })
      ).statusCode,
    ).toBe(401);

    // A member cannot remove another member, and the owner cannot be removed
    // by anyone — including itself, by either route.
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/v1/members/${removed.member.id}`,
          headers: auth(memberToken),
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({ method: 'DELETE', url: '/api/v1/members/me', headers: auth(ownerToken) })
      ).statusCode,
    ).toBe(409);

    const owner = (
      await app.inject({ method: 'GET', url: '/api/v1/members', headers: auth(ownerToken) })
    ).json() as Array<{ id: string; isSelf: boolean }>;
    const ownerRow = owner.find((row) => row.isSelf)!;
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/v1/members/${ownerRow.id}`,
          headers: auth(ownerToken),
        })
      ).statusCode,
    ).toBe(409);

    // Both departures are in the log, named — the row they describe is gone,
    // so the sentence is the only place the name survives. The entry carries
    // no `memberId` for that reason, and recording one would fail the insert.
    const feed = (
      await app.inject({ method: 'GET', url: '/api/v1/activity', headers: auth(ownerToken) })
    ).json() as Array<{ kind: string; message: string; memberId?: string | null }>;
    expect(feed.find((row) => row.kind === 'member.left')?.message).toBe('Kolya left the home.');
    expect(feed.find((row) => row.kind === 'member.removed')?.message).toBe(
      'Georgy removed Masha from the home.',
    );
    expect(feed.find((row) => row.kind === 'member.left')?.memberId ?? null).toBeNull();
  });

  it('serves devices announced by adapters in the wire shape', async () => {
    adapter.bus!.deviceUpserted({
      adapter: 'mqtt',
      externalId: 'lamp-1',
      vendor: 'Acme',
      model: 'L1',
      suggestedName: 'Desk lamp',
      endpoints: [{ endpointId: 1, deviceKind: 'light', capabilities: ['onOff', 'level'], primary: 'onOff' }],
    });
    await registry.flush();
    adapter.bus!.stateChanged('mqtt', 'lamp-1', 1, { onOff: true, level: { current: 200, min: 1, max: 254 } });
    await registry.flush();

    const response = await app.inject({ method: 'GET', url: '/api/v1/devices', headers: auth(memberToken) });
    expect(response.statusCode).toBe(200);
    const devices = response.json() as Array<Record<string, unknown>>;
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({
      name: 'Desk lamp',
      adapter: 'mqtt',
      online: true,
      endpoints: [
        {
          endpointId: 1,
          deviceKind: 'light',
          primaryCapability: 'onOff',
          capabilities: ['onOff', 'level'],
          state: { reachable: true, onOff: true, level: { current: 200, min: 1, max: 254 } },
        },
      ],
    });
  });

  it('accepts canonical commands and routes them to the adapter', async () => {
    const devices = (
      await app.inject({ method: 'GET', url: '/api/v1/devices', headers: auth(memberToken) })
    ).json() as Array<{ id: string }>;
    const deviceId = devices[0]!.id;

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/devices/${deviceId}/endpoints/1/commands`,
      headers: auth(memberToken),
      payload: { type: 'setLevel', level: 128 },
    });
    expect(response.statusCode).toBe(202);
    expect(adapter.executed).toContainEqual({
      externalId: 'lamp-1',
      endpointId: 1,
      command: { type: 'setLevel', level: 128 },
    });

    const invalid = await app.inject({
      method: 'POST',
      url: `/api/v1/devices/${deviceId}/endpoints/1/commands`,
      headers: auth(memberToken),
      payload: { type: 'warpDrive' },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('lets members favorite but not rename devices', async () => {
    const devices = (
      await app.inject({ method: 'GET', url: '/api/v1/devices', headers: auth(memberToken) })
    ).json() as Array<{ id: string }>;
    const deviceId = devices[0]!.id;

    const favorite = await app.inject({
      method: 'PATCH',
      url: `/api/v1/devices/${deviceId}`,
      headers: auth(memberToken),
      payload: { favorite: true },
    });
    expect(favorite.statusCode).toBe(200);

    const rename = await app.inject({
      method: 'PATCH',
      url: `/api/v1/devices/${deviceId}`,
      headers: auth(memberToken),
      payload: { name: 'Hacked name' },
    });
    expect(rename.statusCode).toBe(403);

    const ownerRename = await app.inject({
      method: 'PATCH',
      url: `/api/v1/devices/${deviceId}`,
      headers: auth(ownerToken),
      payload: { name: 'Reading light' },
    });
    expect(ownerRename.statusCode).toBe(200);
    expect((ownerRename.json() as { name: string }).name).toBe('Reading light');
  });

  /**
   * The hub's name and the home's name are one string.
   *
   * They used to be two: `GET /hub` answered `HUB_NAME` from the environment
   * and `GET /home` answered the database, so renaming a hub from an app moved
   * one of them and left every other screen — GetHome Studio's hub list, the
   * mDNS advertisement — calling it whatever the installer had written a year
   * earlier. This is the test that stops them drifting apart again.
   */
  it('renames the hub and the home together, for the owner only', async () => {
    const before = await app.inject({ method: 'GET', url: '/api/v1/hub' });
    expect((before.json() as { name: string }).name).toBe('Test Hub');

    const denied = await app.inject({
      method: 'PATCH',
      url: '/api/v1/home',
      headers: auth(memberToken),
      payload: { name: 'Not yours' },
    });
    expect(denied.statusCode).toBe(403);

    const renamed = await app.inject({
      method: 'PATCH',
      url: '/api/v1/home',
      headers: auth(ownerToken),
      payload: { name: '  Дача  ' },
    });
    expect(renamed.statusCode).toBe(200);
    // Trimmed on the way in, so no screen ever renders the padding.
    expect((renamed.json() as { name: string }).name).toBe('Дача');

    // The public route is the one Studio's hub list polls without a token, so
    // it is the one that has to have moved.
    const hub = await app.inject({ method: 'GET', url: '/api/v1/hub' });
    expect((hub.json() as { name: string }).name).toBe('Дача');

    const home = await app.inject({
      method: 'GET',
      url: '/api/v1/home',
      headers: auth(memberToken),
    });
    expect((home.json() as { name: string }).name).toBe('Дача');
  });

  it('refuses a nameless home rather than storing one', async () => {
    for (const name of ['', '   ']) {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/v1/home',
        headers: auth(ownerToken),
        payload: { name },
      });
      expect(response.statusCode).toBe(400);
    }
    const hub = await app.inject({ method: 'GET', url: '/api/v1/hub' });
    expect((hub.json() as { name: string }).name).toBe('Дача');
  });

  it('gates room management to the owner', async () => {
    const denied = await app.inject({
      method: 'POST',
      url: '/api/v1/rooms',
      headers: auth(memberToken),
      payload: { name: 'Kitchen' },
    });
    expect(denied.statusCode).toBe(403);

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/rooms',
      headers: auth(ownerToken),
      payload: { name: 'Kitchen' },
    });
    expect(created.statusCode).toBe(201);
  });

  it('records and serves activity', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/activity', headers: auth(memberToken) });
    expect(response.statusCode).toBe(200);
    const entries = response.json() as Array<{ kind: string }>;
    expect(entries.some((entry) => entry.kind === 'member.joined')).toBe(true);
    expect(entries.some((entry) => entry.kind === 'device.command')).toBe(true);
  });

  it('stores AI settings without ever returning the key', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/ai',
      headers: auth(ownerToken),
      payload: { provider: 'anthropic', apiKey: 'sk-ant-test-1234567890' },
    });
    expect(put.statusCode).toBe(200);
    const body = put.json() as Record<string, unknown>;
    expect(body).toEqual({
      provider: 'anthropic',
      model: null,
      hasKey: true,
      // On unless the owner has said otherwise, so saving a key is enough.
      enabled: true,
      legacySubscriptionToken: false,
      status: {},
    });
    expect(JSON.stringify(body)).not.toContain('sk-ant');

    const denied = await app.inject({ method: 'GET', url: '/api/v1/settings/ai', headers: auth(memberToken) });
    expect(denied.statusCode).toBe(403);
  });

  it('switches adaptation off without asking for the key again', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/ai',
      headers: auth(ownerToken),
      payload: { apiKey: 'sk-ant-test-1234567890' },
    });

    const patched = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings/ai',
      headers: auth(ownerToken),
      payload: { enabled: false },
    });
    expect(patched.statusCode).toBe(200);
    const body = patched.json() as { enabled: boolean; hasKey: boolean };
    // Off, and the credential is still there — those are different requests.
    expect(body).toMatchObject({ enabled: false, hasKey: true });
  });

  it('refuses an agent run while adaptation is switched off, and says so', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/ai',
      headers: auth(ownerToken),
      payload: { apiKey: 'sk-ant-test-1234567890' },
    });
    await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings/ai',
      headers: auth(ownerToken),
      payload: { enabled: false },
    });
    const hash = 'f'.repeat(64);
    await app.inject({
      method: 'PUT',
      url: `/api/v1/device-mappings/${hash}`,
      headers: auth(ownerToken),
      payload: { version: 1, endpoints: [{ endpointId: 1 }] },
    });

    const repair = await app.inject({
      method: 'POST',
      url: `/api/v1/device-mappings/${hash}/repair`,
      headers: auth(ownerToken),
    });

    // Not the same refusal as "no key": the hub has a credential and is
    // declining to use it, and an app has to be able to tell a person which
    // of the two they need to change.
    expect(repair.statusCode).toBe(409);
    expect((repair.json() as { error: string }).error).toBe('ai_disabled');

    await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings/ai',
      headers: auth(ownerToken),
      payload: { enabled: true },
    });
  });

  it('rejects an uploaded mapping with the reasons, not a bare 400', async () => {
    const hash = 'd'.repeat(64);
    const bad = await app.inject({
      method: 'PUT',
      url: `/api/v1/device-mappings/${hash}`,
      headers: auth(ownerToken),
      payload: { version: 1, endpoints: [{ endpointId: 1 }] },
    });

    // 422, not 400: the request was well-formed and understood — what was
    // refused is the content, and the difference is what tells an app to offer
    // a repair rather than blame the upload.
    expect(bad.statusCode).toBe(422);
    const body = bad.json() as { error: string; problems: string[] };
    expect(body.error).toBe('invalid_mapping');
    expect(body.problems.length).toBeGreaterThan(0);

    // Kept, so the repair route has something to work from.
    const listed = (await app.inject({
      method: 'GET',
      url: '/api/v1/device-mappings',
      headers: auth(ownerToken),
    })).json() as Array<{ exposesHash: string; status: string }>;
    expect(listed.find((entry) => entry.exposesHash === hash)?.status).toBe('rejected');
  });

  it('will not repair a mapping without a credential, and says which of the two is missing', async () => {
    await app.inject({ method: 'DELETE', url: '/api/v1/settings/ai', headers: auth(ownerToken) });
    const hash = 'e'.repeat(64);
    await app.inject({
      method: 'PUT',
      url: `/api/v1/device-mappings/${hash}`,
      headers: auth(ownerToken),
      payload: { version: 1, endpoints: [{ endpointId: 1 }] },
    });

    const repair = await app.inject({
      method: 'POST',
      url: `/api/v1/device-mappings/${hash}/repair`,
      headers: auth(ownerToken),
    });
    expect(repair.statusCode).toBe(409);
    expect((repair.json() as { error: string }).error).toBe('ai_not_configured');
  });

  it('keeps the mapping library to the owner', async () => {
    const denied = await app.inject({
      method: 'GET',
      url: '/api/v1/device-mappings',
      headers: auth(memberToken),
    });
    expect(denied.statusCode).toBe(403);
  });

  it('still accepts an authType field from an app that has not been updated', async () => {
    // The field is gone from the contract but older Studio builds still send
    // it; ignoring it beats 400-ing an app mid-rollout.
    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/ai',
      headers: auth(ownerToken),
      payload: { authType: 'api_key', apiKey: 'sk-ant-api03-1234567890' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).not.toHaveProperty('authType');
  });

  it('refuses a Claude subscription token and says what to paste instead', async () => {
    // The Messages API cannot authenticate an sk-ant-oat token, and finding
    // that out on the next device announcement is a 401 the owner can't read.
    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/ai',
      headers: auth(ownerToken),
      payload: { apiKey: 'sk-ant-oat01-subscription-token-000000' },
    });
    expect(put.statusCode).toBe(400);
    expect(put.body).toContain('Anthropic API key');
    expect(put.body).not.toContain('oat01-subscription');
  });

  it('refuses a model the mapping agent cannot run on', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/ai',
      headers: auth(ownerToken),
      payload: { apiKey: 'sk-ant-api03-1234567890', model: 'claude-haiku-4-5' },
    });
    expect(put.statusCode).toBe(400);
    expect(put.body).toContain('claude-opus-5');
  });

  it('rejects the removed openai provider', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/ai',
      headers: auth(ownerToken),
      payload: { provider: 'openai', apiKey: 'sk-test-1234567890' },
    });
    expect(put.statusCode).toBe(400);
  });

  it('says what this hub can talk to, since it is not the same on every board', async () => {
    const info = await app.inject({ method: 'GET', url: '/api/v1/hub' });
    expect((info.json() as { radio: unknown }).radio).toEqual({
      budget: 'one',
      mode: 'auto',
      // Live, not requested — this hub was built without a Matter adapter.
      matter: false,
      canRunBoth: false,
    });
  });

  it("records the owner's radio choice without applying it itself", async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/radio',
      headers: auth(ownerToken),
      payload: { mode: 'matter' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ mode: 'matter', budget: 'one', applying: true });

    // The file is the entire mechanism. A path unit notices it and
    // gethome-zigbee-detect does the work — editing root-owned config,
    // stopping Zigbee2MQTT, restarting the hub — so the hub itself never needs
    // sudo for any of it.
    expect(readFileSync(path.join(dataDir, 'radio-mode'), 'utf8').trim()).toBe('matter');

    const info = await app.inject({ method: 'GET', url: '/api/v1/hub' });
    expect((info.json() as { radio: { mode: string } }).radio.mode).toBe('matter');
  });

  it('refuses a radio it has never heard of, and anyone who is not the owner', async () => {
    const nonsense = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/radio',
      headers: auth(ownerToken),
      payload: { mode: 'bluetooth' },
    });
    expect(nonsense.statusCode).toBe(400);

    const denied = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/radio',
      headers: auth(memberToken),
      payload: { mode: 'auto' },
    });
    expect(denied.statusCode).toBe(403);
    // The refused request must not have moved anything.
    expect(readFileSync(path.join(dataDir, 'radio-mode'), 'utf8').trim()).toBe('matter');
  });

  it('streams events over the WebSocket', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/v1/ws?token=${ownerToken}`);

    const frames: Array<Record<string, unknown>> = [];
    const gotState = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for state frame')), 5000);
      socket.on('message', (data) => {
        const frame = JSON.parse(String(data)) as Record<string, unknown>;
        frames.push(frame);
        if (frame.type === 'state') {
          clearTimeout(timer);
          resolve();
        }
      });
      socket.on('open', () => {
        adapter.bus!.stateChanged('mqtt', 'lamp-1', 1, { onOff: false });
      });
      socket.on('error', reject);
    });

    await gotState;
    socket.close();
    expect(frames[0]).toMatchObject({ type: 'hello', hubId: 'hub-test-1234' });
    const stateFrame = frames.find((frame) => frame.type === 'state') as { state: { onOff: boolean } };
    expect(stateFrame.state.onOff).toBe(false);
  });

  /** Mint a throwaway member, so a test can revoke one without revoking the suite's. */
  async function join(name: string): Promise<{ token: string; member: { id: string } }> {
    const invite = await app.inject({
      method: 'POST',
      url: '/api/v1/invites',
      headers: auth(ownerToken),
    });
    const { code } = invite.json() as { code: string };
    const paired = await app.inject({
      method: 'POST',
      url: '/api/v1/pair',
      payload: { code, memberName: name },
    });
    return paired.json() as { token: string; member: { id: string } };
  }

  /** Open an authorized socket and collect its frames. */
  async function openSocket(token: string = ownerToken): Promise<{
    socket: WebSocket;
    frames: Array<Record<string, unknown>>;
    waitFor: (type: string) => Promise<Record<string, unknown>>;
  }> {
    // Harmless when an earlier test already bound it; this keeps each test
    // standing on its own rather than on declaration order.
    await app.listen({ port: 0, host: '127.0.0.1' }).catch(() => undefined);
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/v1/ws?token=${token}`);
    const frames: Array<Record<string, unknown>> = [];
    const waiters: Array<{ type: string; resolve: (frame: Record<string, unknown>) => void }> = [];
    socket.on('message', (data) => {
      const frame = JSON.parse(String(data)) as Record<string, unknown>;
      frames.push(frame);
      for (const waiter of [...waiters]) {
        if (waiter.type !== frame.type) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(frame);
      }
    });
    const waitFor = (type: string) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const existing = frames.find((frame) => frame.type === type);
        if (existing) return resolve(existing);
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), 5000);
        waiters.push({
          type,
          resolve: (frame) => {
            clearTimeout(timer);
            resolve(frame);
          },
        });
      });
    await waitFor('hello');
    return { socket, frames, waitFor };
  }

  /**
   * The case a Raspberry Pi Zero produces every time somebody pulls the Zigbee
   * stick out: the devices go offline (frames of their own), and *why* they
   * went has to travel too. It used to reach an app only through `GET /hub`,
   * which nothing asks for at that moment — so a phone drew six grey cards
   * under a chip still reading "Zigbee · on".
   */
  it('pushes the hub status when a radio comes up or goes down', async () => {
    const { socket, waitFor } = await openSocket();

    registry.radioReachabilityChanged('zigbee', false);
    const frame = await waitFor('hubStatus');

    // The same two blocks the health check answers with, because they come
    // from the same snapshot — a client must never have to reconcile them.
    const health = await app.inject({ method: 'GET', url: '/api/v1/hub' });
    const body = health.json() as Record<string, unknown>;
    expect(frame.zigbee).toEqual(body.zigbee);
    expect(frame.radio).toEqual(body.radio);
    expect(frame.radio).toMatchObject({ budget: 'one', canRunBoth: false, matter: false });

    socket.close();
  });

  // The half a token cascade cannot do on its own. A socket authorizes once,
  // when it opens, so a removed member's REST access ended immediately while
  // the stream they were already holding carried on.
  it('hangs up the event stream a removed member is already holding', async () => {
    const doomed = await join('Vitya');
    const { socket, frames } = await openSocket(doomed.token);

    const closedWith = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the socket was never closed')), 5000);
      socket.on('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/members/${doomed.member.id}`,
      headers: auth(ownerToken),
    });
    expect(removed.statusCode).toBe(204);

    // 4001 — the same code an unauthorized socket gets, because it means the
    // same thing and clients already know to stop reconnecting on it rather
    // than retrying a token that will never work again.
    expect(await closedWith).toBe(4001);

    // And the last thing they heard was not the announcement of their own
    // removal: the sockets go before the activity record is written.
    expect(frames.some((frame) => frame.type === 'activity')).toBe(false);
  });

  it('advertises which optional streams this hub can offer', async () => {
    const { socket, waitFor } = await openSocket();
    const hello = await waitFor('hello');

    // This server is built without an MQTT observer, so the traffic inspector
    // is not on offer — and the socket says so rather than leaving a client to
    // infer it from the hub's version.
    expect(hello.streams).toEqual(['zigbee', 'ai']);
    socket.close();
  });

  it('sends optional-stream events only to a socket that asked for them', async () => {
    const { socket, frames, waitFor } = await openSocket();

    events.emit('zigbeeEvent', { at: new Date().toISOString(), type: 'joined', ieee: '0xabc' });
    // An always-on event emitted after it: if the opt-in frame were being
    // delivered anyway, it would already be in `frames` by the time this
    // arrives, because both travel the same socket in emit order.
    adapter.bus!.stateChanged('mqtt', 'lamp-1', 1, { onOff: true });
    await waitFor('state');

    expect(frames.some((frame) => frame.type === 'zigbeeEvent')).toBe(false);
    socket.close();
  });

  it('delivers the Zigbee stream once subscribed, and reports what it refused', async () => {
    const { socket, waitFor } = await openSocket();
    socket.send(JSON.stringify({ type: 'subscribe', streams: ['zigbee', 'mqtt', 'nonsense'] }));

    const ack = await waitFor('subscribed');
    expect(ack.streams).toEqual(['zigbee']);
    // Asked for, but this hub has no broker tap to give.
    expect(ack.unavailable).toEqual(['mqtt']);

    events.emit('zigbeeEvent', {
      at: new Date().toISOString(),
      type: 'interviewing',
      ieee: '0xabc',
      name: 'porch sensor',
    });
    const event = (await waitFor('zigbeeEvent')) as { event: { type: string; name: string } };
    expect(event.event).toMatchObject({ type: 'interviewing', name: 'porch sensor' });

    socket.close();
  });

  it('stops delivering a stream that was unsubscribed', async () => {
    const { socket, frames, waitFor } = await openSocket();
    socket.send(JSON.stringify({ type: 'subscribe', streams: ['zigbee'] }));
    await waitFor('subscribed');

    socket.send(JSON.stringify({ type: 'unsubscribe', streams: ['zigbee'] }));
    // The second ack: an empty stream list.
    await new Promise<void>((resolve) => {
      const check = () => {
        const acks = frames.filter((frame) => frame.type === 'subscribed');
        if (acks.length >= 2) return resolve();
        setTimeout(check, 20);
      };
      check();
    });

    events.emit('zigbeeEvent', { at: new Date().toISOString(), type: 'left', ieee: '0xabc' });
    adapter.bus!.stateChanged('mqtt', 'lamp-1', 1, { onOff: false });
    const before = frames.filter((frame) => frame.type === 'zigbeeEvent').length;
    await waitFor('state');

    expect(frames.filter((frame) => frame.type === 'zigbeeEvent')).toHaveLength(before);
    socket.close();
  });

  it('rejects unauthorized WebSocket connections', async () => {
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/v1/ws?token=bogus`);
    const code = await new Promise<number>((resolve) => socket.on('close', resolve));
    expect(code).toBe(4001);
  });
});
