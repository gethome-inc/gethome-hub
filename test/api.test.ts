import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
import { FavoritesService } from '../src/core/favorites.js';
import { PermitJoinService } from '../src/core/permit-join.js';
import { AiRunLog } from '../src/core/ai-runs.js';
import { MappingLibrary } from '../src/ai/library.js';
import type { AdapterBus, ProtocolAdapter } from '../src/adapters/adapter.js';
import type { HubCommand } from '../src/schema/index.js';
import {
  bootedHome,
  loadedAccess,
  openTestDb,
  resetDb,
  startedHistory,
  testPortraits,
} from './helpers/db.js';

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
  let favorites: FavoritesService;
  let events: HubEventBus;
  let access: Awaited<ReturnType<typeof loadedAccess>>;
  let history: Awaited<ReturnType<typeof startedHistory>>;
  let dataDir: string;
  let ownerToken: string;
  let memberToken: string;

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    await resetDb(db);
    dataDir = mkdtempSync(path.join(tmpdir(), 'gethome-api-'));
    events = new HubEventBus();
    const activity = new ActivityService(db, events);
    access = await loadedAccess(db, events);
    const pairing = new PairingService(db, dataDir, log, access);
    await pairing.boot();
    adapter = new FakeAdapter();
    registry = new DeviceRegistry(db, events, activity, log);
    registry.registerAdapter(adapter);
    await registry.start();
    const settings = new SettingsService(db, Buffer.alloc(32).toString('base64'));
    favorites = new FavoritesService(db, events);
    await favorites.load();
    history = await startedHistory(db, events);
    app = await buildServer({
      db,
      log,
      events,
      registry,
      favorites,
      access,
      pairing,
      activity,
      history,
      portraits: testPortraits(db, events, dataDir),
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
    await history.stop();
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
      // The *presence* of this block is what tells an app the hub records
      // readings at all, which is how it knows to offer a chart rather than a
      // doorway to a 404.
      history: { bucketSeconds: 300, retentionDays: 7 },
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
      // The address on its own protocol, beside the UUID this hub minted —
      // the only handle an app has for tying a device to something a radio
      // said about it.
      externalId: 'lamp-1',
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

  it('serves a device\u2019s recorded readings to any member, and 404s an unknown device', async () => {
    const devices = (
      await app.inject({ method: 'GET', url: '/api/v1/devices', headers: auth(memberToken) })
    ).json() as Array<{ id: string }>;
    const deviceId = devices[0]!.id;

    adapter.bus!.stateChanged('mqtt', 'lamp-1', 1, {
      sensors: { temperatureCenti: 2_140 },
      power: { activeMilliwatts: 8_000 },
    });
    await registry.flush();
    await history.flush();

    // Reading the home is the floor, so the plainest member gets this — the
    // same answer `GET /devices` gives, and for the same reason.
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/devices/${deviceId}/history`,
      headers: auth(memberToken),
    });
    expect(response.statusCode).toBe(200);
    const page = response.json() as {
      bucketMs: number;
      start: number;
      retentionDays: number;
      series: Array<{ kind: string; unit: string; points: number[][] }>;
    };
    expect(page.retentionDays).toBe(7);
    expect(page.series.map((entry) => entry.kind).sort()).toEqual(['power', 'temperature']);
    const temperature = page.series.find((entry) => entry.kind === 'temperature')!;
    expect(temperature.unit).toBe('centiCelsius');
    expect(temperature.points).toHaveLength(1);
    expect(temperature.points[0]!.slice(1)).toEqual([2_140, 2_140, 2_140]);

    // `series=` narrows to the line actually on screen.
    const narrowed = (
      await app.inject({
        method: 'GET',
        url: `/api/v1/devices/${deviceId}/history?series=power`,
        headers: auth(memberToken),
      })
    ).json() as { series: Array<{ kind: string }> };
    expect(narrowed.series.map((entry) => entry.kind)).toEqual(['power']);

    const missing = await app.inject({
      method: 'GET',
      url: '/api/v1/devices/44444444-4444-4444-a444-444444444444/history',
      headers: auth(memberToken),
    });
    expect(missing.statusCode).toBe(404);

    const backwards = await app.inject({
      method: 'GET',
      url: `/api/v1/devices/${deviceId}/history?from=${Date.now()}&to=${Date.now() - 1_000}`,
      headers: auth(memberToken),
    });
    expect(backwards.statusCode).toBe(400);
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

  /**
   * A device's name is the house's; a favorite is one person's.
   *
   * Renaming used to be owner-only, which read as caution and in practice
   * locked the feature away from everybody who lives here: Studio claims a hub
   * as *the Mac*, so the owner is usually a laptop in a drawer and every phone
   * joined by invite. A device called "0x54ef44100047c1bf" has to be fixable by
   * whoever is standing in front of it.
   */
  it('lets any member rename a device, and keeps favorites personal', async () => {
    const devices = (
      await app.inject({ method: 'GET', url: '/api/v1/devices', headers: auth(memberToken) })
    ).json() as Array<{ id: string }>;
    const deviceId = devices[0]!.id;

    const rename = await app.inject({
      method: 'PATCH',
      url: `/api/v1/devices/${deviceId}`,
      headers: auth(memberToken),
      payload: { name: 'Reading light' },
    });
    expect(rename.statusCode).toBe(200);
    expect((rename.json() as { name: string }).name).toBe('Reading light');
    // Everybody sees the new name: it describes the house.
    const forOwner = (
      await app.inject({ method: 'GET', url: '/api/v1/devices', headers: auth(ownerToken) })
    ).json() as Array<{ id: string; name: string; favorite: boolean }>;
    expect(forOwner.find((device) => device.id === deviceId)?.name).toBe('Reading light');

    // A favorite does not. The owner pins it; the member's list is unmoved.
    const pinned = await app.inject({
      method: 'PATCH',
      url: `/api/v1/devices/${deviceId}`,
      headers: auth(ownerToken),
      payload: { favorite: true },
    });
    expect(pinned.statusCode).toBe(200);
    expect((pinned.json() as { favorite: boolean }).favorite).toBe(true);

    const asMember = (
      await app.inject({ method: 'GET', url: '/api/v1/devices', headers: auth(memberToken) })
    ).json() as Array<{ id: string; favorite: boolean }>;
    expect(asMember.find((device) => device.id === deviceId)?.favorite).toBe(false);

    // And each side can unpin its own without touching the other's.
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/devices/${deviceId}`,
      headers: auth(memberToken),
      payload: { favorite: true },
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/devices/${deviceId}`,
      headers: auth(ownerToken),
      payload: { favorite: false },
    });
    const stillPinned = (
      await app.inject({ method: 'GET', url: '/api/v1/devices', headers: auth(memberToken) })
    ).json() as Array<{ id: string; favorite: boolean }>;
    expect(stillPinned.find((device) => device.id === deviceId)?.favorite).toBe(true);
  });

  /**
   * Both edits are written down with the name of whoever made them — which is
   * the whole basis for letting any member make them.
   *
   * The move entry is the one that needs a test: `updateDevice` mutates the
   * cached device and hands the *same object* back, so a "did the room
   * actually change?" check reading it after the call compares the new value
   * with itself and silently never records anything.
   */
  it('writes down who renamed a device and who moved it', async () => {
    const roomId = (
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/rooms',
          headers: auth(memberToken),
          payload: { name: 'Study' },
        })
      ).json() as { id: string }
    ).id;
    const devices = (
      await app.inject({ method: 'GET', url: '/api/v1/devices', headers: auth(memberToken) })
    ).json() as Array<{ id: string }>;
    const deviceId = devices[0]!.id;

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/devices/${deviceId}`,
      headers: auth(memberToken),
      payload: { name: 'Desk lamp', roomId },
    });

    const entries = (
      await app.inject({ method: 'GET', url: '/api/v1/activity', headers: auth(memberToken) })
    ).json() as Array<{
      kind: string;
      message: string;
      data?: { deviceName?: string; previousName?: string; roomName?: string; memberName?: string };
    }>;
    const renamed = entries.find((entry) => entry.kind === 'device.renamed');
    expect(renamed).toBeDefined();
    const moved = entries.find((entry) => entry.kind === 'device.moved');
    expect(moved?.message).toContain('Study');
    // The name in the sentence is the one it has now, not the one it had.
    expect(moved?.message).toContain('Desk lamp');

    // Structured beside the sentence, so an app can word it its own way — the
    // same contract every other kind here follows.
    expect(renamed?.data?.deviceName).toBe('Desk lamp');
    expect(renamed?.data?.previousName).toBe('Reading light');
    expect(moved?.data?.roomName).toBe('Study');
    expect(moved?.data?.memberName).toBeTruthy();
  });

  it('refuses a name of spaces and a room that does not exist', async () => {
    const devices = (
      await app.inject({ method: 'GET', url: '/api/v1/devices', headers: auth(memberToken) })
    ).json() as Array<{ id: string }>;
    const deviceId = devices[0]!.id;

    const blank = await app.inject({
      method: 'PATCH',
      url: `/api/v1/devices/${deviceId}`,
      headers: auth(memberToken),
      payload: { name: '   ' },
    });
    expect(blank.statusCode).toBe(400);

    const nowhere = await app.inject({
      method: 'PATCH',
      url: `/api/v1/devices/${deviceId}`,
      headers: auth(memberToken),
      payload: { roomId: '11111111-2222-4333-8444-555555555555' },
    });
    expect(nowhere.statusCode).toBe(404);
    expect((nowhere.json() as { error: string }).error).toBe('unknown_room');
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

  /**
   * Rooms and zones are the shape of a shared home, and anybody who lives in
   * it may change them. The owner-only rule that used to sit here guarded the
   * wrong thing: taking devices and people *away* is still the owner's.
   */
  it('lets any member add rooms and zones, and put one inside the other', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/rooms',
      headers: auth(memberToken),
      payload: { name: 'Kitchen' },
    });
    expect(created.statusCode).toBe(201);
    const room = created.json() as { id: string; name: string; zoneId: string | null };
    expect(room.zoneId).toBeNull();

    const zone = await app.inject({
      method: 'POST',
      url: '/api/v1/zones',
      headers: auth(memberToken),
      payload: { name: 'Ground floor' },
    });
    expect(zone.statusCode).toBe(201);
    const zoneId = (zone.json() as { id: string }).id;

    const moved = await app.inject({
      method: 'PATCH',
      url: `/api/v1/rooms/${room.id}`,
      headers: auth(memberToken),
      payload: { zoneId },
    });
    expect(moved.statusCode).toBe(200);
    expect((moved.json() as { zoneId: string | null }).zoneId).toBe(zoneId);

    // Out of the zone again — `null` is a real answer, not a missing field.
    const loose = await app.inject({
      method: 'PATCH',
      url: `/api/v1/rooms/${room.id}`,
      headers: auth(memberToken),
      payload: { zoneId: null },
    });
    expect((loose.json() as { zoneId: string | null }).zoneId).toBeNull();

    const unknownZone = await app.inject({
      method: 'PATCH',
      url: `/api/v1/rooms/${room.id}`,
      headers: auth(memberToken),
      payload: { zoneId: '11111111-2222-4333-8444-555555555555' },
    });
    expect(unknownZone.statusCode).toBe(404);
  });

  /**
   * A room's glyph and colour are the house's, like its name — and null is a
   * real answer that puts it back to whatever the app would have derived.
   */
  it('stores a room\u2019s look, and lets it be cleared again', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/rooms',
      headers: auth(memberToken),
      payload: { name: 'Garage', icon: 'car', accent: 'sky' },
    });
    expect(created.statusCode).toBe(201);
    const room = created.json() as { id: string; icon: string | null; accent: string | null };
    expect(room.icon).toBe('car');
    expect(room.accent).toBe('sky');

    // A room nobody has styled carries no look at all — that is what tells an
    // app to derive one rather than to draw a default it was handed.
    const plain = await app.inject({
      method: 'POST',
      url: '/api/v1/rooms',
      headers: auth(memberToken),
      payload: { name: 'Hallway' },
    });
    expect((plain.json() as { icon: string | null }).icon).toBeNull();

    // Leaving a field out keeps it; only `null` clears it.
    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/v1/rooms/${room.id}`,
      headers: auth(memberToken),
      payload: { name: 'Carport' },
    });
    expect((renamed.json() as { icon: string | null }).icon).toBe('car');

    const cleared = await app.inject({
      method: 'PATCH',
      url: `/api/v1/rooms/${room.id}`,
      headers: auth(memberToken),
      payload: { icon: null, accent: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect((cleared.json() as { icon: string | null }).icon).toBeNull();
    expect((cleared.json() as { accent: string | null }).accent).toBeNull();

    // The list route answers with the same shape the writes do.
    const listed = (
      await app.inject({ method: 'GET', url: '/api/v1/rooms', headers: auth(memberToken) })
    ).json() as Array<{ id: string; icon: string | null; accent: string | null }>;
    expect(listed.find((entry) => entry.id === room.id)?.accent).toBeNull();

    // A token nobody recognises is still stored: the vocabulary belongs to the
    // apps, and a hub that refused one would need upgrading for every colour.
    const unknown = await app.inject({
      method: 'PATCH',
      url: `/api/v1/rooms/${room.id}`,
      headers: auth(memberToken),
      payload: { icon: 'chandelier' },
    });
    expect((unknown.json() as { icon: string | null }).icon).toBe('chandelier');

    // Bounded, though — a token is a word, not a payload.
    const tooLong = await app.inject({
      method: 'PATCH',
      url: `/api/v1/rooms/${room.id}`,
      headers: auth(memberToken),
      payload: { icon: 'x'.repeat(41) },
    });
    expect(tooLong.statusCode).toBe(400);
  });

  /**
   * A zone's name is copied onto every room in it by the apps, so renaming one
   * moves what other people see — and used to be the one structural edit that
   * said nothing in the log.
   */
  it('records a zone rename the way it records a room rename', async () => {
    const zone = await app.inject({
      method: 'POST',
      url: '/api/v1/zones',
      headers: auth(memberToken),
      payload: { name: 'Upstairs' },
    });
    const zoneId = (zone.json() as { id: string }).id;

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/v1/zones/${zoneId}`,
      headers: auth(memberToken),
      payload: { name: 'First floor' },
    });
    expect(renamed.statusCode).toBe(200);

    const entries = (
      await app.inject({ method: 'GET', url: '/api/v1/activity', headers: auth(memberToken) })
    ).json() as Array<{
      kind: string;
      message: string;
      data?: { zoneName?: string; previousName?: string };
    }>;
    const entry = entries.find((row) => row.kind === 'zone.renamed');
    expect(entry?.message).toContain('First floor');
    expect(entry?.data?.zoneName).toBe('First floor');
    expect(entry?.data?.previousName).toBe('Upstairs');

    // A name that is already in force is not a change, so it writes nothing.
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/zones/${zoneId}`,
      headers: auth(memberToken),
      payload: { name: 'First floor' },
    });
    const after = (
      await app.inject({ method: 'GET', url: '/api/v1/activity', headers: auth(memberToken) })
    ).json() as Array<{ kind: string }>;
    expect(after.filter((row) => row.kind === 'zone.renamed')).toHaveLength(1);

    const missing = await app.inject({
      method: 'PATCH',
      url: '/api/v1/zones/11111111-2222-4333-8444-555555555555',
      headers: auth(memberToken),
      payload: { name: 'Nowhere' },
    });
    expect(missing.statusCode).toBe(404);
  });

  /** Deleting "Upstairs" must never be a way to lose a bedroom. */
  it('keeps the rooms when their zone is deleted', async () => {
    const zoneId = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/zones',
        headers: auth(memberToken),
        payload: { name: 'Attic' },
      })
    ).json() as { id: string };
    const roomId = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/rooms',
        headers: auth(memberToken),
        payload: { name: 'Studio', zoneId: zoneId.id },
      })
    ).json() as { id: string };

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/zones/${zoneId.id}`,
      headers: auth(memberToken),
    });
    expect(deleted.statusCode).toBe(204);

    const rooms = (
      await app.inject({ method: 'GET', url: '/api/v1/rooms', headers: auth(memberToken) })
    ).json() as Array<{ id: string; zoneId: string | null }>;
    const survivor = rooms.find((entry) => entry.id === roomId.id);
    expect(survivor).toBeDefined();
    expect(survivor?.zoneId).toBeNull();
  });

  /**
   * A deleted room leaves its devices behind, and the *cache* has to hear
   * about it. The database sets `devices.room_id` to null on its own; the
   * registry would have gone on serving a room id pointing at nothing until
   * the hub restarted, so every app would have kept drawing the section.
   */
  it('empties a deleted room instead of its devices', async () => {
    const roomId = (
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/rooms',
          headers: auth(memberToken),
          payload: { name: 'Hallway' },
        })
      ).json() as { id: string }
    ).id;
    const devices = (
      await app.inject({ method: 'GET', url: '/api/v1/devices', headers: auth(memberToken) })
    ).json() as Array<{ id: string }>;
    const deviceId = devices[0]!.id;

    const placed = await app.inject({
      method: 'PATCH',
      url: `/api/v1/devices/${deviceId}`,
      headers: auth(memberToken),
      payload: { roomId },
    });
    expect((placed.json() as { roomId: string | null }).roomId).toBe(roomId);

    await app.inject({ method: 'DELETE', url: `/api/v1/rooms/${roomId}`, headers: auth(memberToken) });

    const after = (
      await app.inject({ method: 'GET', url: '/api/v1/devices', headers: auth(memberToken) })
    ).json() as Array<{ id: string; roomId: string | null }>;
    expect(after.find((device) => device.id === deviceId)?.roomId).toBeNull();
  });

  it('records and serves activity', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/activity', headers: auth(memberToken) });
    expect(response.statusCode).toBe(200);
    const entries = response.json() as Array<{ kind: string; data?: Record<string, unknown> }>;
    expect(entries.some((entry) => entry.kind === 'member.joined')).toBe(true);

    // A command carries the whole intent beside the sentence, so an app can
    // say "Turned on" and name the device even after the row's ids are nulled.
    const command = entries.find((entry) => entry.kind === 'device.command');
    expect(command).toBeDefined();
    expect(command!.data).toMatchObject({
      command: { type: 'setLevel', level: 128 },
      deviceName: expect.any(String),
      memberName: expect.any(String),
    });
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
    // Every flat field the wire has always carried, unchanged: an app that
    // predates the second provider reads exactly what it always did.
    expect(body).toMatchObject({
      provider: 'anthropic',
      model: null,
      hasKey: true,
      // On unless the owner has said otherwise, so saving a key is enough.
      enabled: true,
      legacySubscriptionToken: false,
      status: {},
    });
    // And the per-provider half beside them. The models list is the hub's own,
    // so an app one version behind still draws a complete picker rather than
    // offering an id this hub would refuse.
    expect(body).toMatchObject({
      providers: {
        anthropic: { hasKey: true, model: 'claude-opus-5' },
        openai: { hasKey: false },
      },
      // One key, so there is nothing to choose between.
      mapping: { provider: 'anthropic', choosable: false },
    });
    const providers = body.providers as { anthropic: { models: unknown[] } };
    expect(providers.anthropic.models).toHaveLength(2);
    expect(JSON.stringify(body)).not.toContain('sk-ant');

    // A member may read and write this now — see the `hub.ai` note in
    // `core/access.ts`. A guest still may not, which `roles.test.ts` pins.
    const allowed = await app.inject({ method: 'GET', url: '/api/v1/settings/ai', headers: auth(memberToken) });
    expect(allowed.statusCode).toBe(200);
  });

  /**
   * The second credential, and the two things about it that are not obvious:
   * one route carries both keys without either disturbing the other, and the
   * hub tells the keys apart by their prefix rather than trusting the field
   * they arrived in — with two secure fields on one screen, pasting into the
   * wrong one is the ordinary mistake.
   */
  /**
   * The switch that keeps what a run said, end to end.
   *
   * Studio *hides* the control on a hub whose settings never mention the
   * field — a switch that cannot do anything is worse than no switch — so a
   * field that never reached the wire would make the whole feature invisible
   * rather than merely broken. That is the shape of gap this pins.
   */
  it('answers whether it keeps what a run said, and lets a member change it', async () => {
    const before = await app.inject({
      method: 'GET',
      url: '/api/v1/settings/ai',
      headers: auth(memberToken),
    });
    // Off, and *said* to be off: nil at the app would hide the control.
    expect(before.json()).toMatchObject({ recordExchanges: false });

    const on = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings/ai',
      headers: auth(memberToken),
      payload: { recordExchanges: true },
    });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toMatchObject({ recordExchanges: true });

    // And it is read back from the hub rather than assumed by the caller.
    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/settings/ai',
      headers: auth(memberToken),
    });
    expect(after.json()).toMatchObject({ recordExchanges: true });
  });

  it('holds an OpenAI key beside the Anthropic one, and refuses each in the other’s field', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/ai',
      headers: auth(ownerToken),
      payload: { apiKey: 'sk-ant-api-1234567890' },
    });

    const saved = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings/ai',
      headers: auth(memberToken),
      payload: { openaiApiKey: 'sk-proj-1234567890', openaiModel: 'gpt-5.6-terra' },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      hasKey: true,
      providers: {
        anthropic: { hasKey: true, model: 'claude-opus-5' },
        openai: { hasKey: true, model: 'gpt-5.6-terra' },
      },
      // Both keys, so which one recognises devices is now somebody's choice.
      mapping: { provider: 'anthropic', choosable: true },
    });
    expect(JSON.stringify(saved.json())).not.toContain('sk-');

    const swapped = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings/ai',
      headers: auth(memberToken),
      payload: { openaiApiKey: 'sk-ant-api-1234567890' },
    });
    expect(swapped.statusCode).toBe(400);
    // And the sentence reaches the app: a schema message written to be read is
    // no use at all if every refusal arrives as a bare `invalid_body`.
    expect(swapped.json()).toMatchObject({
      error: 'invalid_body',
      detail: expect.stringContaining('Anthropic key'),
    });

    // A *subscription* token in the OpenAI field is the same mistake, and the
    // sentence has to be about the field it was pasted into: `detail` is the
    // first issue, so an ungated `sk-ant-oat` check answered "the hub needs an
    // Anthropic API key" — advice about the other box entirely.
    const subscription = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings/ai',
      headers: auth(memberToken),
      payload: { openaiApiKey: 'sk-ant-oat01-subscription-token-000000' },
    });
    expect(subscription.statusCode).toBe(400);
    expect(subscription.json()).toMatchObject({
      error: 'invalid_body',
      detail: expect.stringContaining('belongs in the Anthropic field'),
    });

    // In the field it does belong in, it still says what kind of key is wanted.
    const inItsOwnField = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings/ai',
      headers: auth(memberToken),
      payload: { anthropicApiKey: 'sk-ant-oat01-subscription-token-000000' },
    });
    expect(inItsOwnField.statusCode).toBe(400);
    expect(inItsOwnField.json()).toMatchObject({
      error: 'invalid_body',
      detail: expect.stringContaining('subscription token'),
    });

    const chosen = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings/ai',
      headers: auth(memberToken),
      payload: { mappingProvider: 'openai' },
    });
    expect(chosen.json()).toMatchObject({ provider: 'openai', mapping: { provider: 'openai' } });

    // Forgetting one leaves the other alone — and takes the stale choice with
    // it, rather than pointing the agent at a provider it cannot authenticate.
    const cleared = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings/ai',
      headers: auth(memberToken),
      payload: { clear: 'openai' },
    });
    expect(cleared.json()).toMatchObject({
      provider: 'anthropic',
      providers: { anthropic: { hasKey: true }, openai: { hasKey: false } },
      mapping: { provider: 'anthropic', choosable: false },
    });
  });

  it('refuses to point the agent at a provider with no key', async () => {
    const refused = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings/ai',
      headers: auth(memberToken),
      payload: { mappingProvider: 'openai' },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: 'provider_not_configured', provider: 'openai' });
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

  /**
   * `hub.ai` guards the library, and it moved into the member's set with the
   * second credential — the `hub.update` argument again: Studio claims a hub as
   * the Mac, so an owner-only key is one nobody in the house holds. Guest is
   * where the line falls now, which `roles.test.ts` pins.
   */
  it('opens the mapping library to a member', async () => {
    const allowed = await app.inject({
      method: 'GET',
      url: '/api/v1/device-mappings',
      headers: auth(memberToken),
    });
    expect(allowed.statusCode).toBe(200);
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

  it('refuses a radio it has never heard of', async () => {
    const nonsense = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/radio',
      headers: auth(ownerToken),
      payload: { mode: 'bluetooth' },
    });
    expect(nonsense.statusCode).toBe(400);
    // The refused request must not have moved anything.
    expect(readFileSync(path.join(dataDir, 'radio-mode'), 'utf8').trim()).toBe('matter');
  });

  /**
   * Owner-only guards the *shape* of a home — who is in it, what the rooms
   * are, removing a device somebody else relies on. Which radio is running,
   * and pairing a device onto it, is not that: a member is somebody the owner
   * invited in, and a home whose second phone cannot pair the lamp it is
   * standing next to is a home with a support call in it.
   */
  it('lets a member switch the radio, and records who did', async () => {
    const switched = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/radio',
      headers: auth(memberToken),
      payload: { mode: 'zigbee' },
    });
    expect(switched.statusCode).toBe(200);
    expect(readFileSync(path.join(dataDir, 'radio-mode'), 'utf8').trim()).toBe('zigbee');

    // Named, because it is no longer only the owner who can have done it: a
    // radio switch takes half a home offline and the log has to say whose
    // phone asked for it.
    const feed = await app.inject({ method: 'GET', url: '/api/v1/activity', headers: auth(ownerToken) });
    const rows = feed.json() as Array<{ kind: string; message: string; data?: { memberName?: string } }>;
    const row = rows.find((entry) => entry.kind === 'hub.radio');
    expect(row?.message).toContain('zigbee');
    expect(row?.message).toContain("Anna's iPhone");
    expect(row?.data?.memberName).toBe("Anna's iPhone");

    // Put it back for whatever runs next.
    await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/radio',
      headers: auth(ownerToken),
      payload: { mode: 'matter' },
    });
  });

  /**
   * The same rule, on the two routes that actually pair a device. This hub has
   * neither radio, so the honest answer is `409 <radio>_disabled` — which is
   * the assertion: a member reaches the route and is told what is missing,
   * rather than being turned away at the door with a 403 they cannot act on.
   */
  it('lets a member reach the pairing routes rather than turning them away', async () => {
    const zigbee = await app.inject({
      method: 'POST',
      url: '/api/v1/zigbee/permit-join',
      headers: auth(memberToken),
      payload: { seconds: 300 },
    });
    expect(zigbee.statusCode).toBe(409);
    expect(zigbee.json()).toMatchObject({ error: 'zigbee_disabled' });

    const matter = await app.inject({
      method: 'POST',
      url: '/api/v1/matter/commission',
      headers: auth(memberToken),
      payload: { pairingCode: '34970112332' },
    });
    expect(matter.statusCode).toBe(409);
    expect(matter.json()).toMatchObject({ error: 'matter_disabled' });

    // Still a token away from anyone at all, though.
    const anonymous = await app.inject({
      method: 'POST',
      url: '/api/v1/zigbee/permit-join',
      payload: { seconds: 300 },
    });
    expect(anonymous.statusCode).toBe(401);
  });

  /**
   * The address of the running server, starting it on the first call.
   * Fastify throws on a second `listen`, and more than one test here needs a
   * real socket rather than `inject`.
   */
  async function listeningPort(): Promise<number> {
    if (!app.server.listening) await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    return address.port;
  }

  it('streams events over the WebSocket', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${await listeningPort()}/api/v1/ws?token=${ownerToken}`);

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

  /**
   * The other app in the house has to hear a radio switch it didn't make.
   *
   * `PUT /settings/radio` writes a file and returns; the hub restarts a moment
   * later *only* when the change actually moves Matter, so a client cannot
   * wait for a socket to bounce — and the GetHome iOS app does not poll
   * `GET /hub` at all. Without the push, a mode set from GetHome Studio simply
   * never reached the phone.
   */
  it('pushes the new radio mode to sockets that did not ask for it', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${await listeningPort()}/api/v1/ws?token=${memberToken}`);

    const gotStatus = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no hubStatus frame')), 5000);
      socket.on('message', (data) => {
        const frame = JSON.parse(String(data)) as Record<string, unknown>;
        if (frame.type !== 'hubStatus') return;
        clearTimeout(timer);
        resolve(frame);
      });
      socket.on('open', () => {
        void app.inject({
          method: 'PUT',
          url: '/api/v1/settings/radio',
          headers: auth(ownerToken),
          payload: { mode: 'zigbee' },
        });
      });
      socket.on('error', reject);
    });

    const frame = (await gotStatus) as { radio: { mode: string }; zigbee: unknown };
    socket.close();
    expect(frame.radio.mode).toBe('zigbee');
    // The whole snapshot, not a radio-shaped fragment: one shape for one fact,
    // so a client cannot be told two different things by two frames.
    expect(frame.zigbee).toBeDefined();

    await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/radio',
      headers: auth(ownerToken),
      payload: { mode: 'matter' },
    });
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

  /**
   * Everyone in the house is looking at the same rooms, so one person adding
   * one has to reach the other phones now — not whenever they next reconnect,
   * which used to be the only thing that re-read the structure.
   */
  it('announces rooms and zones to every open socket', async () => {
    const { socket, waitFor } = await openSocket(memberToken);

    await app.inject({
      method: 'POST',
      url: '/api/v1/zones',
      headers: auth(ownerToken),
      payload: { name: 'Basement' },
    });

    const frame = (await waitFor('structure')) as {
      rooms: Array<{ id: string; name: string; zoneId: string | null }>;
      zones: Array<{ name: string }>;
    };
    // Both lists, every time: a client redraws its zone sections from the pair
    // and would otherwise have to hold half of it from memory.
    expect(frame.zones.some((zone) => zone.name === 'Basement')).toBe(true);
    expect(Array.isArray(frame.rooms)).toBe(true);
    socket.close();
  });

  /**
   * Updating the hub.
   *
   * The interesting half is the refusals: every one of them is a sentence an
   * app has to be able to say, and a bare status code is not one.
   */
  describe('updating the hub', () => {
    const updateDir = () => path.join(dataDir, 'update');

    it('tells any member what is installed', async () => {
      // Information is the home's, even though only the owner may act on it —
      // somebody who cannot press the button still has to be able to see why
      // the hub is unreachable for the next two minutes.
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/system/update',
        headers: auth(memberToken),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ canApply: false });
    });

    it('says it cannot tell rather than saying up to date', async () => {
      // This hub has no CI stamp, so there is nothing to compare a commit
      // against. `available` must be *absent*: an app reading a missing field
      // as `false` would tell somebody they are current on no evidence at all.
      const body = await app
        .inject({ method: 'GET', url: '/api/v1/system/update', headers: auth(ownerToken) })
        .then((r) => r.json());
      expect(body.checkError).toBe('no_build_stamp');
      expect(body).not.toHaveProperty('available');
      expect(body).not.toHaveProperty('latest');
    });

    it('lets any member start one', async () => {
      // Owner-only here meant the phone in the owner's own hand could never
      // update their own hub: Studio claims a hub as *the Mac*, so the owner is
      // a laptop in a drawer, every phone joins by invite, and there is no
      // ownership transfer to fix it with. A member is refused below, but for
      // the machine's sake and never for being a member.
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/system/update',
        headers: auth(memberToken),
      });
      expect(response.statusCode).not.toBe(403);
    });

    it('refuses a machine with no update plumbing, by name', async () => {
      // A hub installed before any of this existed. Letting the request sit in
      // a directory nothing is watching looks, from an app, exactly like an
      // update that never starts.
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/system/update',
        headers: auth(memberToken),
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: 'update_unsupported' });
    });

    it('records the request and names who made it', async () => {
      mkdirSync(updateDir(), { recursive: true });
      writeFileSync(path.join(updateDir(), 'enabled'), '');

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/system/update',
        headers: auth(ownerToken),
      });
      expect(response.statusCode).toBe(202);
      const { id } = response.json() as { id: string };
      // The receipt and the file agree: the runner copies this id into its
      // status, which is how an app tells its own run from somebody else's.
      expect(readFileSync(path.join(updateDir(), 'request'), 'utf8').trim()).toBe(id);

      // Written while this process is still alive to write it — the outcome is
      // recorded at the next boot, by which time there is no member to name.
      const feed = await app
        .inject({ method: 'GET', url: '/api/v1/activity?limit=5', headers: auth(ownerToken) })
        .then((r) => r.json() as Array<{ kind: string; message: string }>);
      expect(feed.some((e) => e.kind === 'hub.update' && e.message.includes('started a hub update')))
        .toBe(true);
    });

    it('refuses a second update while one is running', async () => {
      // A .path unit does not fire while its service is active, so a second
      // request during a run would be silently dropped. Saying so is the only
      // honest option.
      writeFileSync(
        path.join(updateDir(), 'status.json'),
        JSON.stringify({
          id: 'run-1',
          state: 'running',
          step: 'download',
          startedAt: new Date().toISOString(),
          heartbeat: new Date().toISOString(),
          fromBuild: '0.1.0-test',
          hubAnswering: false,
          warnings: [],
        }),
      );
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/system/update',
        headers: auth(ownerToken),
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: 'update_in_progress' });
    });

    it('reports the run to every member', async () => {
      const body = await app
        .inject({ method: 'GET', url: '/api/v1/system/update', headers: auth(memberToken) })
        .then((r) => r.json() as { run?: { state: string; step: string } });
      expect(body.run).toMatchObject({ state: 'running', step: 'download' });
    });

    it('serves the installer log, empty and all', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/system/update/log?tail=10',
        headers: auth(memberToken),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ lines: [], total: 0 });
    });
  });

  it('rejects unauthorized WebSocket connections', async () => {
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/v1/ws?token=bogus`);
    const code = await new Promise<number>((resolve) => socket.on('close', resolve));
    expect(code).toBe(4001);
  });
});
