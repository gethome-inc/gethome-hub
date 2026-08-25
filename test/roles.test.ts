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
import { BUILTIN_ROLES, PERMISSION_KEYS, type RoleWire } from '../src/core/access.js';
import type { AdapterBus, ProtocolAdapter } from '../src/adapters/adapter.js';
import type { HubCommand } from '../src/schema/index.js';
import { bootedHome, loadedAccess, loadedFavorites, openTestDb, resetDb } from './helpers/db.js';

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

interface MemberRow {
  id: string;
  name: string;
  role: string;
  roleId: string | null;
  roleName: string | null;
  isSelf?: boolean;
}

describe.skipIf(!handle)('roles and permissions', () => {
  const db = handle?.db!;
  let app: FastifyInstance;
  let adapter: FakeAdapter;
  let registry: DeviceRegistry;
  let events: HubEventBus;
  let dataDir: string;
  let port: number;

  let ownerToken: string;
  let memberToken: string;
  let guestToken: string;
  let guestId: string;
  let deviceId: string;
  let roomId: string;

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const roleId = async (key: string): Promise<string> => {
    const roles = (
      await app.inject({ method: 'GET', url: '/api/v1/roles', headers: auth(ownerToken) })
    ).json() as RoleWire[];
    const role = roles.find((entry) => entry.key === key);
    if (!role) throw new Error(`no role ${key}`);
    return role.id;
  };

  /** Mint an invite for a role and claim it, returning the new member's token. */
  const join = async (name: string, key: string): Promise<{ token: string; id: string }> => {
    const invite = await app.inject({
      method: 'POST',
      url: '/api/v1/invites',
      headers: auth(ownerToken),
      payload: { roleId: await roleId(key) },
    });
    expect(invite.statusCode).toBe(201);
    const { code } = invite.json() as { code: string };
    const joined = await app.inject({
      method: 'POST',
      url: '/api/v1/pair',
      payload: { code, memberName: name },
    });
    expect(joined.statusCode).toBe(200);
    const body = joined.json() as { token: string; member: { id: string } };
    return { token: body.token, id: body.member.id };
  };

  beforeAll(async () => {
    await resetDb(db);
    dataDir = mkdtempSync(path.join(tmpdir(), 'gethome-roles-'));
    events = new HubEventBus();
    const activity = new ActivityService(db, events);
    const access = await loadedAccess(db, events);
    const pairing = new PairingService(db, dataDir, log, access);
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
      favorites: await loadedFavorites(db, events),
      access,
      pairing,
      activity,
      settings,
      hubId: 'hub-roles-test',
      home: await bootedHome(db, 'Roles Hub'),
      version: '0.1.0-test',
      dataDir,
      radioBudget: 'one',
      z2mDataDir: path.join(dataDir, 'zigbee2mqtt'),
      permitJoin: new PermitJoinService(undefined, log, () => {}),
      aiRuns: new AiRunLog(db, events),
      mappings: new MappingLibrary({ db, settings, registry, log }),
    });
    // A real socket is needed for the `access` frame test, and `inject` gives
    // no port. Everything else uses `inject`.
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    port = typeof address === 'object' && address ? address.port : 0;

    // Claim as owner, then admit one Member and one Guest.
    const code = readFileSync(path.join(dataDir, 'pairing-code'), 'utf8').trim();
    const claimed = await app.inject({
      method: 'POST',
      url: '/api/v1/pair',
      payload: { code, memberName: 'Georgy', deviceName: 'MacBook' },
    });
    ownerToken = (claimed.json() as { token: string }).token;
    ({ token: memberToken } = await join('Anna', 'member'));
    ({ token: guestToken, id: guestId } = await join('Kolya', 'guest'));

    // One room and one device to act on.
    roomId = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/rooms',
        headers: auth(ownerToken),
        payload: { name: 'Kitchen' },
      })
    ).json().id as string;
    adapter.bus!.deviceUpserted({
      adapter: 'mqtt',
      externalId: 'lamp-1',
      suggestedName: 'Desk lamp',
      endpoints: [{ endpointId: 1, deviceKind: 'light', capabilities: ['onOff'], primary: 'onOff' }],
    });
    await registry.flush();
    deviceId = registry.listDevices()[0]!.id;
  });

  afterAll(async () => {
    await app.close();
    await handle?.close();
  });

  // ── The vocabulary ────────────────────────────────────────────────────────

  it('serves the permission catalog, so an app renders the hub’s own wording', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/permissions',
      headers: auth(guestToken),
    });
    expect(response.statusCode).toBe(200);
    const catalog = response.json() as Array<{ key: string; group: string; title: string; summary: string }>;
    expect(catalog.map((entry) => entry.key)).toEqual([...PERMISSION_KEYS]);
    // Every entry has to say something true, because an app one version behind
    // renders these strings rather than copy of its own.
    for (const entry of catalog) {
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.summary.length).toBeGreaterThan(0);
    }
  });

  it('tells each caller who they are and what they may do', async () => {
    const asGuest = (
      await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(guestToken) })
    ).json() as { name: string; role: { key: string }; permissions: string[]; isOwner: boolean };
    expect(asGuest).toMatchObject({ name: 'Kolya', isOwner: false });
    expect(asGuest.role.key).toBe('guest');
    expect(asGuest.permissions).toEqual(['device.control']);

    const asOwner = (
      await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(ownerToken) })
    ).json() as { permissions: string[]; isOwner: boolean };
    expect(asOwner.isOwner).toBe(true);
    expect(asOwner.permissions).toEqual([...PERMISSION_KEYS]);
  });

  // ── The claim this whole change rests on ──────────────────────────────────

  /**
   * The defaults are not a new policy — they are the old one, written down.
   *
   * `member` is, key for key, the routes that were `authed` before roles
   * existed, and the keys missing from it are the ones that were `ownerOnly`.
   * If this drifts, upgrading a hub silently changes what everybody in the
   * home can do, which is the one outcome this design must not have.
   *
   * `hub.update` is in the list for exactly that reason and not as a widening:
   * `POST /system/update` was `authed` when this branch met it, so a member who
   * could update yesterday still can. Guest is a role that did not exist, so it
   * takes nothing from anybody by arriving without it.
   */
  it('ships defaults that reproduce what the hub did before roles existed', async () => {
    const roles = (
      await app.inject({ method: 'GET', url: '/api/v1/roles', headers: auth(memberToken) })
    ).json() as RoleWire[];

    const member = roles.find((role) => role.key === 'member')!;
    expect(member.permissions).toEqual([
      'device.control',
      'device.edit',
      'device.add',
      'home.structure',
      'activity.read',
      'hub.radio',
      'hub.update',
    ]);
    // The four the old `ownerOnly` guarded, plus the two roles added.
    for (const ownerOnly of [
      'device.remove',
      'home.rename',
      'member.invite',
      'member.remove',
      'role.manage',
      'hub.ai',
    ]) {
      expect(member.permissions).not.toContain(ownerOnly);
    }

    expect(roles.find((role) => role.key === 'guest')!.permissions).toEqual(['device.control']);
    expect(roles.map((role) => role.key)).toEqual(BUILTIN_ROLES.map((role) => role.key));
    // Everybody who was here is somewhere, and the counts say where.
    expect(roles.find((role) => role.key === 'owner')!.memberCount).toBe(1);
    expect(roles.find((role) => role.key === 'member')!.memberCount).toBe(1);
    expect(roles.find((role) => role.key === 'guest')!.memberCount).toBe(1);
  });

  // ── What a guest is ───────────────────────────────────────────────────────

  it('lets a guest work the lights', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/devices/${deviceId}/endpoints/1/commands`,
      headers: auth(guestToken),
      payload: { type: 'power', on: true },
    });
    expect(response.statusCode).toBe(202);
    expect(adapter.executed.at(-1)?.command).toMatchObject({ type: 'power', on: true });
  });

  /**
   * A guest's own pin is part of the floor, which is why `PATCH /devices/:id`
   * is the one route whose permission check reads the body rather than sitting
   * in a preHandler. Guarding the whole route would take the kettle off the
   * guest's dashboard; guarding none of it would let them rename everybody's
   * devices.
   */
  it('lets a guest pin a device but not rename or move one', async () => {
    const pinned = await app.inject({
      method: 'PATCH',
      url: `/api/v1/devices/${deviceId}`,
      headers: auth(guestToken),
      payload: { favorite: true },
    });
    expect(pinned.statusCode).toBe(200);
    expect(pinned.json()).toMatchObject({ favorite: true });

    for (const payload of [{ name: 'Not yours' }, { roomId }]) {
      const refused = await app.inject({
        method: 'PATCH',
        url: `/api/v1/devices/${deviceId}`,
        headers: auth(guestToken),
        payload,
      });
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({ error: 'forbidden', permission: 'device.edit' });
    }

    // And the pin really was theirs alone.
    const ownerView = (
      await app.inject({ method: 'GET', url: '/api/v1/devices', headers: auth(ownerToken) })
    ).json() as Array<{ favorite: boolean }>;
    expect(ownerView[0]?.favorite).toBe(false);
  });

  it('refuses a guest the home’s shape, its name, and the network', async () => {
    const cases: Array<[string, string, string, unknown]> = [
      ['POST', '/api/v1/rooms', 'home.structure', { name: 'Cellar' }],
      ['PATCH', `/api/v1/rooms/${roomId}`, 'home.structure', { name: 'Scullery' }],
      ['DELETE', `/api/v1/rooms/${roomId}`, 'home.structure', undefined],
      ['POST', '/api/v1/zones', 'home.structure', { name: 'Upstairs' }],
      ['PATCH', '/api/v1/home', 'home.rename', { name: 'Not yours' }],
      ['POST', '/api/v1/zigbee/permit-join', 'device.add', { seconds: 60 }],
      ['POST', '/api/v1/matter/commission', 'device.add', { pairingCode: '34970112332' }],
      ['PUT', '/api/v1/settings/radio', 'hub.radio', { mode: 'matter' }],
      ['DELETE', `/api/v1/devices/${deviceId}`, 'device.remove', undefined],
      ['GET', '/api/v1/settings/ai', 'hub.ai', undefined],
      ['POST', '/api/v1/invites', 'member.invite', {}],
      ['GET', '/api/v1/roles', '', undefined],
    ];
    for (const [method, url, permission, payload] of cases) {
      const response = await app.inject({
        method: method as 'GET',
        url,
        headers: auth(guestToken),
        ...(payload !== undefined ? { payload } : {}),
      });
      if (permission === '') {
        // Reading who is in the home, and in what capacity, is the floor.
        expect(response.statusCode, url).toBe(200);
        continue;
      }
      expect(response.statusCode, url).toBe(403);
      expect(response.json(), url).toMatchObject({ error: 'forbidden', permission });
    }
  });

  /**
   * The floor is what being a member *means*, and no role can take it away: a
   * member with nothing at all is a token that can only 401 behind an app with
   * nothing to draw.
   */
  it('leaves the floor standing for a guest', async () => {
    for (const url of ['/api/v1/home', '/api/v1/rooms', '/api/v1/zones', '/api/v1/devices', '/api/v1/members']) {
      const response = await app.inject({ method: 'GET', url, headers: auth(guestToken) });
      expect(response.statusCode, url).toBe(200);
    }
    const renamed = await app.inject({
      method: 'PATCH',
      url: '/api/v1/members/me',
      headers: auth(guestToken),
      payload: { name: 'Kolya’s iPad' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ name: 'Kolya’s iPad', roleName: 'Guest' });
  });

  // ── The activity log ──────────────────────────────────────────────────────

  /**
   * `activity.read` narrows rather than refuses. A guest reading their own
   * actions is a working screen; a guest whose Recent feed 403s is a broken
   * one, and "what have I done in this house" is a fair question for anyone
   * standing in it.
   */
  it('shows a guest only their own lines, and everybody else the home’s', async () => {
    await app.inject({
      method: 'POST',
      url: `/api/v1/devices/${deviceId}/endpoints/1/commands`,
      headers: auth(memberToken),
      payload: { type: 'power', on: false },
    });
    await app.inject({
      method: 'POST',
      url: `/api/v1/devices/${deviceId}/endpoints/1/commands`,
      headers: auth(guestToken),
      payload: { type: 'power', on: true },
    });

    const asGuest = (
      await app.inject({ method: 'GET', url: '/api/v1/activity', headers: auth(guestToken) })
    ).json() as Array<{ memberId: string | null; message: string }>;
    expect(asGuest.length).toBeGreaterThan(0);
    expect(asGuest.every((row) => row.memberId === guestId)).toBe(true);

    const asMember = (
      await app.inject({ method: 'GET', url: '/api/v1/activity', headers: auth(memberToken) })
    ).json() as Array<{ memberId: string | null }>;
    expect(asMember.some((row) => row.memberId !== guestId)).toBe(true);
    expect(asMember.length).toBeGreaterThan(asGuest.length);
  });

  // ── Editing the matrix ────────────────────────────────────────────────────

  it('grants a permission and takes it back, and says so in the log', async () => {
    const guestRole = await roleId('guest');
    const granted = await app.inject({
      method: 'PATCH',
      url: `/api/v1/roles/${guestRole}`,
      headers: auth(ownerToken),
      payload: { permissions: ['device.control', 'home.structure'] },
    });
    expect(granted.statusCode).toBe(200);

    const allowed = await app.inject({
      method: 'POST',
      url: '/api/v1/zones',
      headers: auth(guestToken),
      payload: { name: 'Upstairs' },
    });
    expect(allowed.statusCode).toBe(201);

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/roles/${guestRole}`,
      headers: auth(ownerToken),
      payload: { permissions: ['device.control'] },
    });
    const refused = await app.inject({
      method: 'POST',
      url: '/api/v1/zones',
      headers: auth(guestToken),
      payload: { name: 'Cellar' },
    });
    expect(refused.statusCode).toBe(403);

    const log = (
      await app.inject({ method: 'GET', url: '/api/v1/activity', headers: auth(ownerToken) })
    ).json() as Array<{ kind: string; message: string }>;
    // A sentence, and deliberately not the diff: this log is read a week later.
    expect(log.filter((row) => row.kind === 'role.changed').length).toBe(2);
    expect(log.find((row) => row.kind === 'role.changed')?.message).toBe(
      'Georgy changed what Guest can do.',
    );
  });

  /**
   * The owner is answered without a table being read, which is what makes a
   * home impossible to lock out of itself — and what hands a permission added
   * by a later hub build to the owner automatically.
   */
  it('keeps the owner’s access when every stored role has been emptied', async () => {
    for (const key of ['member', 'guest']) {
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/roles/${await roleId(key)}`,
        headers: auth(ownerToken),
        payload: { permissions: [] },
      });
    }
    const stillOwner = await app.inject({
      method: 'GET',
      url: '/api/v1/settings/ai',
      headers: auth(ownerToken),
    });
    expect(stillOwner.statusCode).toBe(200);
    expect(
      (
        await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(ownerToken) })
      ).json(),
    ).toMatchObject({ permissions: [...PERMISSION_KEYS] });

    // Put them back for the tests that follow.
    for (const [key, permissions] of [
      ['member', BUILTIN_ROLES[1].permissions],
      ['guest', BUILTIN_ROLES[2].permissions],
    ] as const) {
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/roles/${await roleId(key)}`,
        headers: auth(ownerToken),
        payload: { permissions: [...permissions] },
      });
    }
  });

  it('refuses to edit or delete the owner’s role', async () => {
    const owner = await roleId('owner');
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/v1/roles/${owner}`,
          headers: auth(ownerToken),
          payload: { permissions: [] },
        })
      ).json(),
    ).toMatchObject({ error: 'role_is_owner' });
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/v1/roles/${owner}`,
          headers: auth(ownerToken),
        })
      ).json(),
    ).toMatchObject({ error: 'role_is_owner' });

    // The one owner this home has cannot be moved out of the role, because
    // granting it is itself owner-only and there would be nobody left who
    // could put it back. Assigning it to *somebody else* is allowed now, and
    // has its own test below.
    const members = (
      await app.inject({ method: 'GET', url: '/api/v1/members', headers: auth(ownerToken) })
    ).json() as MemberRow[];
    const georgy = members.find((row) => row.name === 'Georgy')!;
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/v1/members/${georgy.id}`,
          headers: auth(ownerToken),
          payload: { roleId: await roleId('guest') },
        })
      ).json(),
    ).toMatchObject({ error: 'cannot_change_owner' });

    // And they cannot leave or be removed while they are the only one.
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: '/api/v1/members/me',
          headers: auth(ownerToken),
        })
      ).json(),
    ).toMatchObject({ error: 'cannot_remove_owner' });

    // A built-in that isn't the owner cannot be deleted either.
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/v1/roles/${await roleId('guest')}`,
          headers: auth(ownerToken),
        })
      ).json(),
    ).toMatchObject({ error: 'role_is_builtin' });
  });

  // ── Roles the home invents ────────────────────────────────────────────────

  it('creates a role, assigns it, and refuses to delete it while it is worn', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/roles',
      headers: auth(ownerToken),
      payload: { name: 'Cleaner', permissions: ['device.control', 'activity.read'] },
    });
    expect(created.statusCode).toBe(201);
    const role = created.json() as RoleWire;
    expect(role).toMatchObject({ name: 'Cleaner', builtin: false, memberCount: 0 });

    const members = (
      await app.inject({ method: 'GET', url: '/api/v1/members', headers: auth(ownerToken) })
    ).json() as MemberRow[];
    const kolya = members.find((row) => row.name.startsWith('Kolya'))!;
    const assigned = await app.inject({
      method: 'PATCH',
      url: `/api/v1/members/${kolya.id}`,
      headers: auth(ownerToken),
      payload: { roleId: role.id },
    });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json()).toMatchObject({ roleName: 'Cleaner' });

    // Silently reassigning somebody's access as a side effect of a delete is
    // not a behaviour worth having — and `members.role_id` carries no
    // `ON DELETE` action, so this refusal *is* the referential integrity.
    const inUse = await app.inject({
      method: 'DELETE',
      url: `/api/v1/roles/${role.id}`,
      headers: auth(ownerToken),
    });
    expect(inUse.statusCode).toBe(409);
    expect(inUse.json()).toMatchObject({ error: 'role_in_use' });

    // The new role really is what answers for them now.
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(guestToken) })).json(),
    ).toMatchObject({ permissions: ['device.control', 'activity.read'] });

    // Move them back, and it goes.
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/members/${kolya.id}`,
      headers: auth(ownerToken),
      payload: { roleId: await roleId('guest') },
    });
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/v1/roles/${role.id}`,
          headers: auth(ownerToken),
        })
      ).statusCode,
    ).toBe(204);
  });

  it('mints an invite for a role, and a member without the permission cannot', async () => {
    const refused = await app.inject({
      method: 'POST',
      url: '/api/v1/invites',
      headers: auth(memberToken),
      payload: {},
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: 'forbidden', permission: 'member.invite' });

    const { token } = await join('Masha', 'guest');
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(token) })).json(),
    ).toMatchObject({ role: { key: 'guest' } });

    // An invite with no role named is still a `member` invite, exactly as
    // every invite this hub has ever minted was.
    const plain = await app.inject({
      method: 'POST',
      url: '/api/v1/invites',
      headers: auth(ownerToken),
      payload: {},
    });
    expect(plain.json()).toMatchObject({ roleName: 'Member' });
  });

  // ── Reaching an app that is already open ──────────────────────────────────

  /**
   * A role edit has to reach a phone that is already showing the home, or
   * somebody sits looking at controls that have quietly stopped working. Same
   * argument that put `structure` and `hubStatus` on the socket.
   */
  it('pushes an access frame when the role a socket is holding is edited', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws?token=${memberToken}`);
    const frames: Array<Record<string, unknown>> = [];
    socket.on('message', (data) => frames.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve());
      socket.on('error', reject);
    });

    const waitFor = (predicate: (frame: Record<string, unknown>) => boolean) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const found = frames.find(predicate);
        if (found) return resolve(found);
        const timer = setTimeout(() => reject(new Error('timed out')), 3000);
        const check = () => {
          const hit = frames.find(predicate);
          if (!hit) return;
          clearTimeout(timer);
          socket.off('message', poll);
          resolve(hit);
        };
        const poll = () => check();
        socket.on('message', poll);
      });

    // It arrives once behind `hello`, without being asked for.
    const hello = (await waitFor((frame) => frame.type === 'hello')) as { permissions: string[] };
    expect(hello.permissions).toContain('home.structure');
    const first = (await waitFor((frame) => frame.type === 'access')) as {
      role: { key: string };
      permissions: string[];
    };
    expect(first.role.key).toBe('member');
    expect(first.permissions).toContain('home.structure');

    frames.length = 0;
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/roles/${await roleId('member')}`,
      headers: auth(ownerToken),
      payload: { permissions: ['device.control'] },
    });
    const pushed = (await waitFor((frame) => frame.type === 'access')) as { permissions: string[] };
    expect(pushed.permissions).toEqual(['device.control']);

    // **A role this socket does not hold still reaches it**, because the frame
    // carries `roles` — the home's whole table — beside this member's own
    // permissions. This is the half that used to be silent, and the symptom
    // was a matrix that only moved when the page was closed and reopened.
    frames.length = 0;
    const added = await app.inject({
      method: 'POST',
      url: '/api/v1/roles',
      headers: auth(ownerToken),
      payload: { name: 'House sitter', permissions: ['device.control'] },
    });
    const houseSitter = added.json() as RoleWire;
    const onAdd = (await waitFor((frame) => frame.type === 'access')) as {
      permissions: string[];
      roles: RoleWire[];
    };
    // Its own permissions are untouched; the table it can see is not.
    expect(onAdd.permissions).toEqual(['device.control']);
    expect(onAdd.roles.map((role) => role.name)).toContain('House sitter');

    // Editing a role nobody on this socket holds — the owner's own case.
    frames.length = 0;
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/roles/${await roleId('guest')}`,
      headers: auth(ownerToken),
      payload: { permissions: ['device.control', 'activity.read'] },
    });
    const onEdit = (await waitFor((frame) => frame.type === 'access')) as { roles: RoleWire[] };
    expect(onEdit.roles.find((role) => role.key === 'guest')?.permissions).toEqual([
      'device.control',
      'activity.read',
    ]);

    // And deleting one, which by definition has no holders left to tell.
    frames.length = 0;
    await app.inject({
      method: 'DELETE',
      url: `/api/v1/roles/${houseSitter.id}`,
      headers: auth(ownerToken),
    });
    const onDelete = (await waitFor((frame) => frame.type === 'access')) as { roles: RoleWire[] };
    expect(onDelete.roles.map((role) => role.name)).not.toContain('House sitter');

    socket.close();
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/roles/${await roleId('guest')}`,
      headers: auth(ownerToken),
      payload: { permissions: [...BUILTIN_ROLES[2].permissions] },
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/roles/${await roleId('member')}`,
      headers: auth(ownerToken),
      payload: { permissions: [...BUILTIN_ROLES[1].permissions] },
    });
  });

  /**
   * `activity.read` narrows the socket the same way it narrows the route, and
   * the ask happens at **send** time rather than when the socket authorized.
   * A guest whose role gains the permission has to start seeing the home's
   * lines without reconnecting — an app has no reason to drop a working
   * connection because somebody edited a matrix on another phone.
   */
  it('narrows the activity stream per socket, and widens it without a reconnect', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws?token=${guestToken}`);
    const rows: Array<{ memberId: string | null; message: string }> = [];
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as {
        type: string;
        entry?: { memberId: string | null; message: string };
      };
      if (frame.type === 'activity' && frame.entry) rows.push(frame.entry);
    });
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve());
      socket.on('error', reject);
    });

    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 120));
    const flip = async (token: string, on: boolean) => {
      await app.inject({
        method: 'POST',
        url: `/api/v1/devices/${deviceId}/endpoints/1/commands`,
        headers: auth(token),
        payload: { type: 'power', on },
      });
      await settle();
    };

    // Somebody else's line does not reach a guest's socket; their own does.
    await flip(memberToken, false);
    expect(rows).toEqual([]);
    await flip(guestToken, true);
    expect(rows.map((row) => row.memberId)).toEqual([guestId]);

    // Grant it — on the socket that is already open.
    rows.length = 0;
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/roles/${await roleId('guest')}`,
      headers: auth(ownerToken),
      payload: { permissions: ['device.control', 'activity.read'] },
    });
    await flip(memberToken, false);
    expect(rows.some((row) => row.memberId !== guestId)).toBe(true);

    socket.close();
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/roles/${await roleId('guest')}`,
      headers: auth(ownerToken),
      payload: { permissions: [...BUILTIN_ROLES[2].permissions] },
    });
  });

  // ── The escalation surface ────────────────────────────────────────────────

  /**
   * Nothing else in this file proves that somebody without `role.manage`
   * cannot simply rewrite the matrix — which would make every other refusal
   * here a formality. Four routes, two tokens, and the table has to come back
   * unchanged afterwards.
   */
  it('refuses everyone without role.manage the matrix itself', async () => {
    const before = (
      await app.inject({ method: 'GET', url: '/api/v1/roles', headers: auth(ownerToken) })
    ).json() as RoleWire[];
    const guestRole = await roleId('guest');
    const members = (
      await app.inject({ method: 'GET', url: '/api/v1/members', headers: auth(ownerToken) })
    ).json() as MemberRow[];
    const anna = members.find((row) => row.name === 'Anna')!;

    const cases: Array<[string, string, unknown]> = [
      ['POST', '/api/v1/roles', { name: 'Superuser', permissions: [...PERMISSION_KEYS] }],
      ['PATCH', `/api/v1/roles/${guestRole}`, { permissions: [...PERMISSION_KEYS] }],
      ['DELETE', `/api/v1/roles/${guestRole}`, undefined],
      ['PATCH', `/api/v1/members/${anna.id}`, { roleId: await roleId('owner') }],
    ];
    for (const token of [memberToken, guestToken]) {
      for (const [method, url, payload] of cases) {
        const response = await app.inject({
          method: method as 'GET',
          url,
          headers: auth(token),
          ...(payload !== undefined ? { payload } : {}),
        });
        expect(response.statusCode, `${method} ${url}`).toBe(403);
        expect(response.json(), `${method} ${url}`).toMatchObject({
          error: 'forbidden',
          permission: 'role.manage',
        });
      }
    }

    const after = (
      await app.inject({ method: 'GET', url: '/api/v1/roles', headers: auth(ownerToken) })
    ).json() as RoleWire[];
    expect(after).toEqual(before);
  });

  /**
   * Deleting a role takes the codes minted into it, because an invite's whole
   * content is "join as this" and the alternative is worse in both directions:
   * a cleared column would admit its holder as a plain Member, and a refusal
   * would be a dead end, since no route revokes an invite. It is also the
   * shape that used to answer 500 — `invites.role_id` carries no `ON DELETE`
   * action either, so the raw foreign key was what refused.
   */
  it('takes the outstanding invites with a deleted role', async () => {
    const role = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/roles',
        headers: auth(ownerToken),
        payload: { name: 'Dog walker', permissions: ['device.control'] },
      })
    ).json() as RoleWire;
    const { code } = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/invites',
        headers: auth(ownerToken),
        payload: { roleId: role.id },
      })
    ).json() as { code: string };

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/roles/${role.id}`,
      headers: auth(ownerToken),
    });
    expect(removed.statusCode).toBe(204);

    const outstanding = (
      await app.inject({ method: 'GET', url: '/api/v1/invites', headers: auth(ownerToken) })
    ).json() as Array<{ roleId: string | null }>;
    expect(outstanding.every((row) => row.roleId !== role.id)).toBe(true);

    // And the code itself is nothing now — not a Member invite.
    const claimed = await app.inject({
      method: 'POST',
      url: '/api/v1/pair',
      payload: { code, memberName: 'Nobody' },
    });
    expect(claimed.statusCode).toBe(401);
  });

  /**
   * An owner invite is the one route that hands out the role with no member
   * row existing yet to check against, so it carries the same guard as
   * `PATCH /members/:id`: only an owner may mint one.
   */
  it('lets an owner mint an owner invite, and nobody else', async () => {
    const owner = await app.inject({
      method: 'POST',
      url: '/api/v1/invites',
      headers: auth(ownerToken),
      payload: { roleId: await roleId('owner') },
    });
    expect(owner.statusCode).toBe(201);
    expect(owner.json()).toMatchObject({ roleName: 'Owner' });

    // `member.invite` is not enough — this is the escalation surface.
    const grant = async (permissions: string[]) => {
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/roles/${await roleId('member')}`,
        headers: auth(ownerToken),
        payload: { permissions },
      });
    };
    await grant(['member.invite', 'role.manage']);
    const refused = await app.inject({
      method: 'POST',
      url: '/api/v1/invites',
      headers: auth(memberToken),
      payload: { roleId: await roleId('owner') },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: 'not_owner' });
    // Deliberately not `owner_only`: both apps read that as "this hub is too
    // old, update it" and would send somebody to fix a working hub.
    expect(refused.json()).not.toMatchObject({ error: 'owner_only' });
    await grant([...BUILTIN_ROLES[1].permissions]);

    const unknown = await app.inject({
      method: 'POST',
      url: '/api/v1/invites',
      headers: auth(ownerToken),
      payload: { roleId: '00000000-0000-4000-a000-000000000000' },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ error: 'unknown_role' });
  });

  // ── Owner is an ordinary role now ─────────────────────────────────────────

  /**
   * **The escalation surface, and the reason `role.manage` is still safe to
   * delegate.** A home can grant that permission to a role it invented, so if
   * it alone could promote, it would quietly mean "can make myself owner" and
   * every other permission in the matrix would be a formality. Granting the
   * owner's role is owner-only; everything else about the matrix is not.
   */
  it('refuses to promote anybody unless the caller is already an owner', async () => {
    const ownerRole = await roleId('owner');
    const members = (
      await app.inject({ method: 'GET', url: '/api/v1/members', headers: auth(ownerToken) })
    ).json() as MemberRow[];
    const anna = members.find((row) => row.name === 'Anna')!;
    const kolya = members.find((row) => row.name.startsWith('Kolya'))!;

    // A role with `role.manage` and nothing owner-shaped about it.
    const deputy = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/roles',
        headers: auth(ownerToken),
        payload: { name: 'Deputy', permissions: ['role.manage', 'member.remove'] },
      })
    ).json() as RoleWire;
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/members/${anna.id}`,
      headers: auth(ownerToken),
      payload: { roleId: deputy.id },
    });

    // It may move other people around — that is what the permission is for.
    const ordinary = await app.inject({
      method: 'PATCH',
      url: `/api/v1/members/${kolya.id}`,
      headers: auth(memberToken),
      payload: { roleId: await roleId('guest') },
    });
    expect(ordinary.statusCode).toBe(200);

    // It may not make anybody an owner, itself included.
    for (const target of [kolya.id, anna.id]) {
      const refused = await app.inject({
        method: 'PATCH',
        url: `/api/v1/members/${target}`,
        headers: auth(memberToken),
        payload: { roleId: ownerRole },
      });
      expect(refused.statusCode, target).toBe(403);
      expect(refused.json(), target).toMatchObject({ error: 'not_owner' });
    }

    // Put Anna back, and the role with her.
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/members/${anna.id}`,
      headers: auth(ownerToken),
      payload: { roleId: await roleId('member') },
    });
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/v1/roles/${deputy.id}`,
          headers: auth(ownerToken),
        })
      ).statusCode,
    ).toBe(204);
  });

  /**
   * The whole point of opening the role up: a second owner, and then the first
   * one able to step down. What no route may do is leave the home without one
   * — granting the role is owner-only, so there would be nobody left who could
   * put it right.
   */
  it('makes a second owner, lets the first step down, and keeps the last', async () => {
    const ownerRole = await roleId('owner');
    const members = (
      await app.inject({ method: 'GET', url: '/api/v1/members', headers: auth(ownerToken) })
    ).json() as MemberRow[];
    const anna = members.find((row) => row.name === 'Anna')!;
    const georgy = members.find((row) => row.name === 'Georgy')!;

    const promoted = await app.inject({
      method: 'PATCH',
      url: `/api/v1/members/${anna.id}`,
      headers: auth(ownerToken),
      payload: { roleId: ownerRole },
    });
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json()).toMatchObject({ roleName: 'Owner', role: 'owner' });

    // She really is one: the owner is answered without a stored set being read.
    const asAnna = (
      await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(memberToken) })
    ).json() as { isOwner: boolean; permissions: string[] };
    expect(asAnna.isOwner).toBe(true);
    expect(asAnna.permissions).toEqual([...PERMISSION_KEYS]);
    expect(
      (
        await app.inject({ method: 'GET', url: '/api/v1/roles', headers: auth(ownerToken) })
      ).json() as RoleWire[],
    ).toContainEqual(expect.objectContaining({ key: 'owner', memberCount: 2 }));

    // With two, either may step down — and Anna, now an owner, may do it.
    const steppedDown = await app.inject({
      method: 'PATCH',
      url: `/api/v1/members/${georgy.id}`,
      headers: auth(memberToken),
      payload: { roleId: await roleId('member') },
    });
    expect(steppedDown.statusCode).toBe(200);
    expect(steppedDown.json()).toMatchObject({ roleName: 'Member', role: 'member' });

    // Anna is the last owner now, so nothing may move or remove her.
    for (const [method, url, payload] of [
      ['PATCH', `/api/v1/members/${anna.id}`, { roleId: await roleId('guest') }],
      ['DELETE', `/api/v1/members/${anna.id}`, undefined],
    ] as const) {
      const refused = await app.inject({
        method,
        url,
        headers: auth(memberToken),
        ...(payload !== undefined ? { payload } : {}),
      });
      expect(refused.statusCode, method).toBe(409);
      expect(refused.json(), method).toMatchObject({
        error: method === 'DELETE' ? 'cannot_remove_owner' : 'cannot_change_owner',
      });
    }
    // Nor may she leave.
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: '/api/v1/members/me',
          headers: auth(memberToken),
        })
      ).json(),
    ).toMatchObject({ error: 'cannot_remove_owner' });

    // And a plain member cannot take the role off an owner either.
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/v1/members/${anna.id}`,
          headers: auth(ownerToken),
          payload: { roleId: await roleId('guest') },
        })
      ).statusCode,
    ).toBe(403);

    // Put the home back the way the rest of this file expects it.
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/members/${anna.id}`,
      headers: auth(memberToken),
      payload: { roleId: ownerRole },
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/members/${georgy.id}`,
      headers: auth(memberToken),
      payload: { roleId: ownerRole },
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/members/${anna.id}`,
      headers: auth(ownerToken),
      payload: { roleId: await roleId('member') },
    });
  });

  // ── Working the lights is a permission too ────────────────────────────────

  /**
   * `device.control` is the one key whose *refusal* nothing exercised, which
   * is a strange gap for the permission the iOS app hangs its whole
   * "this card has no control" state on. Taken off the guest role and put
   * straight back.
   */
  it('refuses the commands route to a role without device.control', async () => {
    const guestRole = await roleId('guest');
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/roles/${guestRole}`,
      headers: auth(ownerToken),
      payload: { permissions: [] },
    });

    const executed = adapter.executed.length;
    const refused = await app.inject({
      method: 'POST',
      url: `/api/v1/devices/${deviceId}/endpoints/1/commands`,
      headers: auth(guestToken),
      payload: { type: 'power', on: true },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: 'forbidden', permission: 'device.control' });
    // Refused before the adapter, not after it — a 403 over a lamp that came on
    // anyway is the worst of both.
    expect(adapter.executed.length).toBe(executed);

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/roles/${guestRole}`,
      headers: auth(ownerToken),
      payload: { permissions: [...BUILTIN_ROLES[2].permissions] },
    });
  });

  /**
   * Reading what the hub is running is the floor — somebody who cannot press
   * the button is exactly who needs to know why the home went quiet for two
   * minutes — while asking for it is `hub.update`, which Member holds and
   * Guest does not.
   *
   * A member gets past the guard and meets the *machine*: this test hub has no
   * runner installed, so `409 update_unsupported` is the guard having let them
   * through, which is the half being asserted.
   */
  it('lets anyone watch an update and only hub.update ask for one', async () => {
    for (const token of [ownerToken, memberToken, guestToken]) {
      const read = await app.inject({
        method: 'GET',
        url: '/api/v1/system/update',
        headers: auth(token),
      });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toMatchObject({ canApply: false });
    }

    const refused = await app.inject({
      method: 'POST',
      url: '/api/v1/system/update',
      headers: auth(guestToken),
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: 'forbidden', permission: 'hub.update' });

    const allowed = await app.inject({
      method: 'POST',
      url: '/api/v1/system/update',
      headers: auth(memberToken),
    });
    expect(allowed.statusCode).toBe(409);
    expect(allowed.json()).toMatchObject({ error: 'update_unsupported' });
  });

  // ── What the wire actually carries ────────────────────────────────────────

  /**
   * Every one of these fields is something an app cannot work out for itself.
   * `POST /pair` carries the permissions so a phone that has just joined knows
   * what to draw before its second request; `GET /members` carries the role
   * three ways because the key is for code, the name is for the screen, and
   * `isSelf` is the only way a client that claimed over SSH can find its own
   * row; and `PATCH /members/me` answers with the permissions because renaming
   * yourself is the floor and must not read as a refusal.
   */
  it('carries the role and the permissions on every shape an app reads', async () => {
    const invite = await app.inject({
      method: 'POST',
      url: '/api/v1/invites',
      headers: auth(ownerToken),
      payload: { roleId: await roleId('guest') },
    });
    expect(invite.json()).toMatchObject({ roleName: 'Guest' });
    const { code } = invite.json() as { code: string };

    const joined = await app.inject({
      method: 'POST',
      url: '/api/v1/pair',
      payload: { code, memberName: 'Dasha' },
    });
    const body = joined.json() as {
      token: string;
      member: { id: string; role: string; roleKey: string; roleName: string; permissions: string[] };
    };
    expect(body.member).toMatchObject({
      role: 'member',
      roleKey: 'guest',
      roleName: 'Guest',
      permissions: ['device.control'],
    });

    const rows = (
      await app.inject({ method: 'GET', url: '/api/v1/members', headers: auth(body.token) })
    ).json() as MemberRow[];
    const dasha = rows.find((row) => row.id === body.member.id)!;
    expect(dasha).toMatchObject({ roleName: 'Guest', isSelf: true });
    expect(dasha.roleId).toBe(await roleId('guest'));
    expect(rows.filter((row) => row.isSelf)).toHaveLength(1);

    const renamed = await app.inject({
      method: 'PATCH',
      url: '/api/v1/members/me',
      headers: auth(body.token),
      payload: { name: 'Dasha’s phone' },
    });
    expect(renamed.json()).toMatchObject({
      name: 'Dasha’s phone',
      roleName: 'Guest',
      permissions: ['device.control'],
      isSelf: true,
    });

    // Tidy up, so the counts the tests below read are the ones they set.
    await app.inject({
      method: 'DELETE',
      url: '/api/v1/members/me',
      headers: auth(body.token),
    });
  });

  // ── The log names what changed ────────────────────────────────────────────

  /**
   * Every edit to the matrix is written down by name — that accountability is
   * what the three-part test for a *default* leans on ("bounded, destroys
   * nothing, named"), so a kind that silently stopped being recorded would take
   * the argument with it. `message` is the contract: Studio renders that
   * sentence, and an app that has never heard of the kind still says something
   * true.
   */
  it('writes a sentence for every kind of matrix edit', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/roles',
      headers: auth(ownerToken),
      payload: { name: 'Gardener', permissions: ['device.control'] },
    });
    const role = created.json() as RoleWire;

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/roles/${role.id}`,
      headers: auth(ownerToken),
      payload: { name: 'Groundskeeper' },
    });

    const members = (
      await app.inject({ method: 'GET', url: '/api/v1/members', headers: auth(ownerToken) })
    ).json() as MemberRow[];
    const kolya = members.find((row) => row.name.startsWith('Kolya'))!;
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/members/${kolya.id}`,
      headers: auth(ownerToken),
      payload: { roleId: role.id },
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/members/${kolya.id}`,
      headers: auth(ownerToken),
      payload: { roleId: await roleId('guest') },
    });
    await app.inject({
      method: 'DELETE',
      url: `/api/v1/roles/${role.id}`,
      headers: auth(ownerToken),
    });

    const log = (
      await app.inject({
        method: 'GET',
        url: '/api/v1/activity?limit=200',
        headers: auth(ownerToken),
      })
    ).json() as Array<{ kind: string; message: string; data: Record<string, unknown> | null }>;
    const said = (kind: string) => log.find((row) => row.kind === kind);

    expect(said('role.added')?.message).toBe('Georgy added the role Gardener.');
    expect(said('role.renamed')?.message).toBe(
      'Georgy renamed the role Gardener to Groundskeeper.',
    );
    // Newest first, so this test's own two moves are the head of the list —
    // an earlier test moved the same member in and out of a role of its own.
    expect(
      log
        .filter((row) => row.kind === 'member.role-changed')
        .slice(0, 2)
        .map((row) => row.message),
    ).toEqual(['Georgy made Kolya’s iPad Guest.', 'Georgy made Kolya’s iPad Groundskeeper.']);
    expect(said('role.removed')?.message).toBe('Georgy removed the role Groundskeeper.');

    // `data` repeats it structured, so an app can pick an icon and write its
    // own wording — and it copies the *names*, because both ids are
    // `ON DELETE SET NULL` and this row may outlive the role it is about.
    expect(said('role.removed')?.data).toMatchObject({
      roleName: 'Groundskeeper',
      memberName: 'Georgy',
    });
  });

  // ── The rest of the guest table ───────────────────────────────────────────

  /**
   * The zone routes were missing from the guest refusal table, and a zone is
   * exactly the kind of thing somebody staying in the spare room should not be
   * able to dissolve. The mixed body is the other half of the `PATCH
   * /devices/:id` rule: a request that asks for both must be refused *whole*,
   * or a guest renames a device by sending a favorite along with it.
   */
  it('refuses a guest the rest of the home’s shape', async () => {
    const zone = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/zones',
        headers: auth(ownerToken),
        payload: { name: 'Garden' },
      })
    ).json() as { id: string };

    for (const [method, payload] of [
      ['PATCH', { name: 'Not yours' }],
      ['DELETE', undefined],
    ] as const) {
      const response = await app.inject({
        method,
        url: `/api/v1/zones/${zone.id}`,
        headers: auth(guestToken),
        ...(payload !== undefined ? { payload } : {}),
      });
      expect(response.statusCode, method).toBe(403);
      expect(response.json(), method).toMatchObject({
        error: 'forbidden',
        permission: 'home.structure',
      });
    }

    const mixed = await app.inject({
      method: 'PATCH',
      url: `/api/v1/devices/${deviceId}`,
      headers: auth(guestToken),
      payload: { favorite: false, name: 'Sneaky' },
    });
    expect(mixed.statusCode).toBe(403);
    // Refused whole: neither half was applied.
    const device = (
      await app.inject({ method: 'GET', url: '/api/v1/devices', headers: auth(guestToken) })
    ).json() as Array<{ name: string; favorite: boolean }>;
    expect(device[0]).toMatchObject({ name: 'Desk lamp', favorite: true });

    await app.inject({
      method: 'DELETE',
      url: `/api/v1/zones/${zone.id}`,
      headers: auth(ownerToken),
    });
  });

  /**
   * The two owner-side routes with no *allowed* case anywhere: taking a device
   * out of the home, and reading the invites that are outstanding. Last,
   * because the device does not come back.
   */
  it('lets the owner read the invites and take a device out of the home', async () => {
    const outstanding = await app.inject({
      method: 'GET',
      url: '/api/v1/invites',
      headers: auth(ownerToken),
    });
    expect(outstanding.statusCode).toBe(200);
    expect(Array.isArray(outstanding.json())).toBe(true);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/devices/${deviceId}`,
      headers: auth(ownerToken),
    });
    expect(removed.statusCode).toBe(204);
    expect(
      (
        await app.inject({ method: 'GET', url: '/api/v1/devices', headers: auth(ownerToken) })
      ).json(),
    ).toEqual([]);
  });
});
