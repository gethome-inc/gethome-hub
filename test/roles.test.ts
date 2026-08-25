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

  it('refuses to edit or delete the owner’s role, or to hand it to anybody', async () => {
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

    // There is no ownership transfer, so no route may create a second owner.
    const members = (
      await app.inject({ method: 'GET', url: '/api/v1/members', headers: auth(ownerToken) })
    ).json() as MemberRow[];
    const anna = members.find((row) => row.name === 'Anna')!;
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/v1/members/${anna.id}`,
          headers: auth(ownerToken),
          payload: { roleId: owner },
        })
      ).json(),
    ).toMatchObject({ error: 'cannot_change_owner' });

    // Nor may the owner's own role be changed out from under them.
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

    socket.close();
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/roles/${await roleId('member')}`,
      headers: auth(ownerToken),
      payload: { permissions: [...BUILTIN_ROLES[1].permissions] },
    });
  });
});
