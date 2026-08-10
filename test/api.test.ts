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
import type { AdapterBus, ProtocolAdapter } from '../src/adapters/adapter.js';
import type { HubCommand } from '../src/schema/index.js';
import { openTestDb, resetDb } from './helpers/db.js';

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
    app = await buildServer({
      db,
      log,
      events,
      registry,
      pairing,
      activity,
      settings: new SettingsService(db, Buffer.alloc(32).toString('base64')),
      hubId: 'hub-test-1234',
      hubName: 'Test Hub',
      version: '0.1.0-test',
      dataDir,
      // The interesting case: a board that affords one radio, so the switch is
      // offered and the hub has a real choice to record.
      radioBudget: 'one',
      // Nothing there to read, which is the ordinary state for a hub with no
      // coordinator — and must stay silent rather than becoming an error.
      z2mDataDir: path.join(dataDir, 'zigbee2mqtt'),
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
      legacySubscriptionToken: false,
      status: {},
    });
    expect(JSON.stringify(body)).not.toContain('sk-ant');

    const denied = await app.inject({ method: 'GET', url: '/api/v1/settings/ai', headers: auth(memberToken) });
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

  it('rejects unauthorized WebSocket connections', async () => {
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/v1/ws?token=bogus`);
    const code = await new Promise<number>((resolve) => socket.on('close', resolve));
    expect(code).toBe(4001);
  });
});
