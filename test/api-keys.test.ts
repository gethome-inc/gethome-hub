import { readdirSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pino, type Logger } from 'pino';
import WebSocket from 'ws';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { attachWebSocket, LATE_ADMISSION_MS, MemberSessions } from '../src/api/ws.js';
import { ApiKeyService, type ApiKeyRecord, type NewApiKey } from '../src/core/api-keys.js';
import type { HubStatusReader } from '../src/core/hub-status.js';
import { HubEventBus } from '../src/core/bus.js';
import { ActivityService } from '../src/core/activity.js';
import { PairingService } from '../src/core/pairing.js';
import { SettingsService } from '../src/core/settings.js';
import { DeviceRegistry } from '../src/core/registry.js';
import { PermitJoinService } from '../src/core/permit-join.js';
import { AiRunLog } from '../src/core/ai-runs.js';
import { sha256Hex } from '../src/core/crypto.js';
import { MappingLibrary } from '../src/ai/library.js';
import { KEY_GRANTABLE, PERMISSION_KEYS, type AccessService, type RoleWire } from '../src/core/access.js';
import type { AutomationEngine } from '../src/automations/engine.js';
import { apiKeys as apiKeysTable } from '../src/db/schema.js';
import type { AdapterBus, ProtocolAdapter } from '../src/adapters/adapter.js';
import type { HubCommand } from '../src/schema/index.js';
import {
  bootedHome,
  loadedAccess,
  loadedFavorites,
  openTestDb,
  resetDb,
  startedAutomations,
  startedHistory,
  testBroker,
  testPortraits,
} from './helpers/db.js';

/**
 * API keys, from the outside: a member's token with a leash.
 *
 * `test/access.test.ts` proves `canThrough` on its own; this is the leash as a
 * piece of software meets it — every route's declared policy, what each shape
 * of key may and may not do, the four ways a key stops working, who may see
 * and revoke whose, what the activity log says about a key's actions, the
 * event stream, the rate limit, and that a key never reaches the journal.
 */

const handle = await openTestDb();
const silent = pino({ level: 'silent' });

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

/** One key, as `GET /api-keys` and `POST /api-keys` render it. */
interface KeyWire {
  id: string;
  name: string;
  hint: string;
  memberId: string;
  memberName: string | null;
  isMine: boolean;
  state: string;
  control: boolean;
  permissions: string[];
  effective: string[];
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  lastUsedFrom: string | null;
  connections: number;
  lastRefusal?: {
    at: string;
    status: number;
    error: string;
    permission?: string;
    reason?: string;
    method: string;
    path: string;
  };
}

interface ActivityRow {
  kind: string;
  message: string;
  memberId: string | null;
  data: Record<string, unknown> | null;
}

describe.skipIf(!handle)('API keys', () => {
  const db = handle?.db!;
  let app: FastifyInstance;
  let adapter: FakeAdapter;
  let registry: DeviceRegistry;
  let events: HubEventBus;
  let access: AccessService;
  let pairing: PairingService;
  let engine: AutomationEngine;
  let dataDir: string;
  let port: number;
  /** Everything the second, trace-level server needs to share the first's home. */
  let shared: Omit<Parameters<typeof buildServer>[0], 'log'>;

  let ownerToken: string;
  let ownerId: string;
  let memberToken: string;
  let memberId: string;
  let guestToken: string;
  let deviceId: string;

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  const roleId = async (key: string): Promise<string> => {
    const roles = (
      await app.inject({ method: 'GET', url: '/api/v1/roles', headers: auth(ownerToken) })
    ).json() as RoleWire[];
    const role = roles.find((entry) => entry.key === key);
    if (!role) throw new Error(`no role ${key}`);
    return role.id;
  };

  /** Invite somebody into a role and claim it; their token and id. */
  const join = async (name: string, key = 'member'): Promise<{ token: string; id: string }> => {
    const invite = await app.inject({
      method: 'POST',
      url: '/api/v1/invites',
      headers: auth(ownerToken),
      payload: { roleId: await roleId(key) },
    });
    const { code } = invite.json() as { code: string };
    const joined = await app.inject({
      method: 'POST',
      url: '/api/v1/pair',
      payload: { code, memberName: name },
    });
    const body = joined.json() as { token: string; member: { id: string } };
    return { token: body.token, id: body.member.id };
  };

  /** Make a key as this member, or fail the test saying why not. */
  const mint = async (
    token: string,
    body: { name: string; control?: boolean; permissions?: string[]; expiresInDays?: number | null },
  ): Promise<{ key: KeyWire; secret: string }> => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/api-keys',
      headers: auth(token),
      payload: body,
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as { key: KeyWire; secret: string };
  };

  const keysOf = async (token: string): Promise<KeyWire[]> =>
    (
      await app.inject({ method: 'GET', url: '/api/v1/api-keys', headers: auth(token) })
    ).json() as KeyWire[];

  const activity = async (limit = 20): Promise<ActivityRow[]> =>
    (
      await app.inject({
        method: 'GET',
        url: `/api/v1/activity?limit=${limit}`,
        headers: auth(ownerToken),
      })
    ).json() as ActivityRow[];

  beforeAll(async () => {
    await resetDb(db);
    dataDir = mkdtempSync(path.join(tmpdir(), 'gethome-keys-'));
    events = new HubEventBus();
    const activityService = new ActivityService(db, events);
    access = await loadedAccess(db, events);
    pairing = new PairingService(db, dataDir, silent, access);
    await pairing.boot();
    adapter = new FakeAdapter();
    registry = new DeviceRegistry(db, events, activityService, silent);
    registry.registerAdapter(adapter);
    await registry.start();
    const settings = new SettingsService(db, Buffer.alloc(32).toString('base64'));
    const automations = await startedAutomations(db, events, registry, activityService);
    engine = automations.engine;
    shared = {
      db,
      events,
      registry,
      favorites: await loadedFavorites(db, events),
      access,
      pairing,
      activity: activityService,
      automations: automations.engine,
      automationStore: automations.store,
      automationChat: automations.chat,
      assistantChat: automations.assistant,
      history: await startedHistory(db, events),
      portraits: testPortraits(db, events),
      settings,
      hubId: 'hub-keys-test',
      home: await bootedHome(db, 'Keys Hub'),
      version: '0.1.0-test',
      dataDir,
      radioBudget: 'one',
      z2mDataDir: path.join(dataDir, 'zigbee2mqtt'),
      zigbeeEnvFile: path.join(dataDir, 'zigbee.env'),
      mqtt: testBroker(),
      permitJoin: new PermitJoinService(undefined, silent, () => {}),
      aiRuns: new AiRunLog(db, events),
      mappings: new MappingLibrary({ db, settings, registry, log: silent }),
    };
    app = await buildServer({ ...shared, log: silent });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    port = typeof address === 'object' && address ? address.port : 0;

    const code = readFileSync(path.join(dataDir, 'pairing-code'), 'utf8').trim();
    const claimed = await app.inject({
      method: 'POST',
      url: '/api/v1/pair',
      payload: { code, memberName: 'Georgy' },
    });
    ownerToken = (claimed.json() as { token: string }).token;
    ownerId = (claimed.json() as { member: { id: string } }).member.id;
    ({ token: memberToken, id: memberId } = await join('Anna'));
    ({ token: guestToken } = await join('Kolya', 'guest'));

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
    await engine.stop();
    await app.close();
    await handle?.close();
  });

  // ── The route table ───────────────────────────────────────────────────────

  /**
   * **Every route, and what a key may do there.** Adding a route without
   * deciding fails this test, which is the point: the default is closed for a
   * write, but a route that *should* be open to keys and isn't is a bug too,
   * and only a person can say which.
   *
   * `permission X` is a route behind `needs(X)` — a key needs X granted, X
   * grantable, and X still held by its member. `deny` is the member and never
   * a key. `control` is working the home.
   */
  const EXPECTED: Record<string, string> = {
    'GET /api/v1/hub': 'public',
    'POST /api/v1/hub/proof': 'public',
    'POST /api/v1/pair': 'public',
    'GET /api/v1/home': 'read',
    'PATCH /api/v1/home': 'permission home.rename',
    'GET /api/v1/rooms': 'read',
    'POST /api/v1/rooms': 'permission home.structure',
    'PATCH /api/v1/rooms/:id': 'permission home.structure',
    'DELETE /api/v1/rooms/:id': 'permission home.structure',
    'GET /api/v1/zones': 'read',
    'POST /api/v1/zones': 'permission home.structure',
    'PATCH /api/v1/zones/:id': 'permission home.structure',
    'DELETE /api/v1/zones/:id': 'permission home.structure',
    'GET /api/v1/devices': 'read',
    // A pin is the floor's write and a name is `device.edit`, in one body.
    'PATCH /api/v1/devices/:id': 'handler',
    'DELETE /api/v1/devices/:id': 'permission device.remove',
    'POST /api/v1/devices/:id/endpoints/:endpointId/commands': 'control',
    'GET /api/v1/devices/:id/history': 'read',
    'POST /api/v1/devices/:id/remap': 'permission hub.ai',
    'GET /api/v1/devices/:id/portraits': 'read',
    'GET /api/v1/portraits/:portraitId': 'read',
    'POST /api/v1/devices/:id/portraits': 'permission hub.ai',
    'PATCH /api/v1/devices/:id/portraits': 'permission device.edit',
    'DELETE /api/v1/portraits/:portraitId': 'permission device.edit',
    'GET /api/v1/room-pictures': 'read',
    'GET /api/v1/room-pictures/:id/:variant': 'read',
    'POST /api/v1/room-pictures': 'permission hub.ai',
    'PATCH /api/v1/room-pictures/:id': 'permission home.structure',
    'POST /api/v1/room-pictures/:id/locate': 'permission hub.ai',
    'DELETE /api/v1/room-pictures/:id': 'permission home.structure',
    'POST /api/v1/matter/commission': 'permission device.add',
    // Two GETs with side effects — this one drives a radio for seconds, and
    // `GET /settings/mqtt` writes a row and hands out a password — which is
    // why they name permissions rather than being "just a read". Pinned here
    // so nobody tidies them into `read`.
    'GET /api/v1/matter/discoverable': 'permission device.add',
    'GET /api/v1/matter/commission/:jobId': 'read',
    'POST /api/v1/matter/commission/:jobId/cancel': 'permission device.add',
    'POST /api/v1/zigbee/permit-join': 'permission device.add',
    'GET /api/v1/members': 'read',
    'GET /api/v1/me': 'read',
    'GET /api/v1/permissions': 'read',
    'GET /api/v1/roles': 'read',
    'POST /api/v1/roles': 'permission role.manage',
    'PATCH /api/v1/roles/:id': 'permission role.manage',
    'DELETE /api/v1/roles/:id': 'permission role.manage',
    'PATCH /api/v1/members/:id': 'permission role.manage',
    'PATCH /api/v1/members/me': 'deny',
    'DELETE /api/v1/members/me': 'deny',
    'DELETE /api/v1/members/:id': 'permission member.remove',
    'GET /api/v1/invites': 'permission member.invite',
    'POST /api/v1/invites': 'deny',
    'GET /api/v1/activity': 'read',
    'GET /api/v1/api-keys': 'deny',
    'POST /api/v1/api-keys': 'deny',
    'PATCH /api/v1/api-keys/:id': 'deny',
    'DELETE /api/v1/api-keys/:id': 'deny',
    'GET /api/v1/settings/ai': 'permission hub.ai',
    'PUT /api/v1/settings/ai': 'permission hub.ai',
    'PATCH /api/v1/settings/ai': 'permission hub.ai',
    'DELETE /api/v1/settings/ai': 'permission hub.ai',
    'GET /api/v1/ai/runs': 'permission hub.ai',
    'GET /api/v1/ai/runs/:id/exchanges': 'permission hub.ai',
    'GET /api/v1/device-mappings': 'permission hub.ai',
    'GET /api/v1/device-mappings/:exposesHash': 'permission hub.ai',
    'PUT /api/v1/device-mappings/:exposesHash': 'permission hub.ai',
    'DELETE /api/v1/device-mappings/:exposesHash': 'permission hub.ai',
    'POST /api/v1/device-mappings/:exposesHash/repair': 'permission hub.ai',
    'GET /api/v1/settings/mqtt': 'permission hub.mqtt',
    'PUT /api/v1/settings/radio': 'permission hub.radio',
    'GET /api/v1/system/update': 'read',
    'POST /api/v1/system/update': 'permission hub.update',
    'PUT /api/v1/system/update/automatic': 'permission hub.update',
    'GET /api/v1/system/update/log': 'read',
    'GET /api/v1/settings/wifi': 'permission hub.wifi',
    'POST /api/v1/settings/wifi/networks': 'permission hub.wifi',
    'DELETE /api/v1/settings/wifi/networks/:id': 'permission hub.wifi',
    'GET /api/v1/automations': 'read',
    'GET /api/v1/automations/capabilities': 'read',
    'GET /api/v1/automations/templates': 'read',
    'GET /api/v1/automations/:id': 'read',
    'GET /api/v1/automations/:id/runs': 'read',
    'POST /api/v1/automations/:id/run': 'control',
    'PUT /api/v1/automations/:id/active': 'control',
    'POST /api/v1/automations/dry-run': 'permission automation.manage',
    'POST /api/v1/automations': 'permission automation.manage',
    'PATCH /api/v1/automations/:id': 'permission automation.manage',
    'DELETE /api/v1/automations/:id': 'permission automation.manage',
    'GET /api/v1/automations/:id/versions': 'permission automation.manage',
    'POST /api/v1/automations/:id/revert': 'permission automation.manage',
    'POST /api/v1/automations/templates/:key': 'permission automation.manage',
    'GET /api/v1/settings/timezone': 'read',
    'PUT /api/v1/settings/timezone': 'permission automation.manage',
    // Every conversation, reading included: what people said is not a key's.
    'POST /api/v1/automations/chat': 'deny',
    'POST /api/v1/automations/chat/:id/messages': 'deny',
    'POST /api/v1/automations/chat/:id/stop': 'deny',
    'GET /api/v1/automations/chats': 'deny',
    'GET /api/v1/automations/chat/:id': 'deny',
    'DELETE /api/v1/automations/chat/:id': 'deny',
    'POST /api/v1/assistant/chat': 'deny',
    'POST /api/v1/assistant/chat/:id/messages': 'deny',
    'POST /api/v1/assistant/chat/:id/stop': 'deny',
    'GET /api/v1/assistant/chats': 'deny',
    'GET /api/v1/assistant/chat/:id': 'deny',
    'POST /api/v1/assistant/voice/session': 'deny',
    'DELETE /api/v1/assistant/chat/:id': 'deny',
    'GET /api/v1/ws': 'handler',
  };

  const describePolicy = (row: { policy: string; permission?: string }) =>
    row.policy === 'permission' ? `permission ${row.permission}` : row.policy;

  describe('the route table', () => {
    it('declares what a key may do on every route, exactly as written here', () => {
      const recorded = Object.fromEntries(
        app.apiKeyPolicies
          .filter((row) => row.method !== 'HEAD')
          .map((row) => [`${row.method} ${row.url}`, describePolicy(row)]),
      );
      expect(recorded).toEqual(EXPECTED);
    });

    it('never opens a write to every key', () => {
      for (const row of app.apiKeyPolicies) {
        if (row.method === 'GET' || row.method === 'HEAD') continue;
        expect(row.policy, `${row.method} ${row.url}`).not.toBe('read');
      }
    });

    it('gives every GET a HEAD twin with the same policy — except the event stream', () => {
      const gets = app.apiKeyPolicies.filter((row) => row.method === 'GET');
      const heads = app.apiKeyPolicies.filter((row) => row.method === 'HEAD');
      for (const head of heads) {
        const get = gets.find((row) => row.url === head.url);
        expect(get, head.url).toBeDefined();
        expect(describePolicy(head), head.url).toBe(describePolicy(get!));
      }
      // The HEAD twin of the stream is what used to leak listeners.
      expect(heads.some((row) => row.url === '/api/v1/ws')).toBe(false);
      expect(heads).toHaveLength(gets.length - 1);
    });

    it('resolves a credential before every handler but the public three and the stream', () => {
      const open = app.apiKeyPolicies
        .filter((row) => !row.authenticated)
        .map((row) => `${row.method} ${row.url}`)
        .sort();
      expect(open).toEqual(
        [
          'GET /api/v1/hub',
          'HEAD /api/v1/hub',
          'POST /api/v1/hub/proof',
          'POST /api/v1/pair',
          // It authenticates inside the handler, because a preHandler refusing
          // an upgrade reaches the client as 1006 rather than the 4001 contract.
          'GET /api/v1/ws',
        ].sort(),
      );
      for (const row of app.apiKeyPolicies) {
        if (row.policy === 'permission') expect(PERMISSION_KEYS).toContain(row.permission);
      }
    });

    /**
     * The two ways the table protects itself: a route that says nothing is
     * closed to keys if it writes, and a write that copies the floor's `authed`
     * does not build at all.
     */
    it('closes an undeclared write and refuses to build a write open to every key', async () => {
      const extra = await buildServer({ ...shared, log: silent });
      try {
        extra.post('/api/v1/added-tomorrow', async () => ({ ok: true }));
        const added = extra.apiKeyPolicies.find((row) => row.url === '/api/v1/added-tomorrow');
        expect(added?.policy).toBe('deny');
        expect(() =>
          extra.post('/api/v1/careless', { config: { apiKey: 'read' } }, async () => ({ ok: true })),
        ).toThrow(/cannot be open to every API key/);
      } finally {
        await extra.close();
      }
    });
  });

  // ── Making a key ──────────────────────────────────────────────────────────

  describe('making a key', () => {
    it('says on GET /hub that this hub takes keys, and which permissions a key can be given', async () => {
      const hub = (await app.inject({ method: 'GET', url: '/api/v1/hub' })).json() as {
        apiKeys?: { grantable: string[] };
      };
      expect(hub.apiKeys).toEqual({ grantable: [...KEY_GRANTABLE] });
    });

    it('hands the secret back once, and keeps only its hash', async () => {
      const { key, secret } = await mint(memberToken, { name: 'Grafana' });
      expect(secret).toMatch(/^gethome_[0-9A-Za-z]{43}$/);
      expect(key).toMatchObject({
        name: 'Grafana',
        hint: secret.slice(-4),
        memberId,
        memberName: 'Anna',
        isMine: true,
        state: 'active',
        control: false,
        permissions: [],
        effective: [],
        expiresAt: null,
        lastUsedAt: null,
        connections: 0,
      });

      const row = await db.query.apiKeys.findFirst({ where: eq(apiKeysTable.id, key.id) });
      expect(row?.keyHash).toBe(sha256Hex(secret));
      // Nothing in the row is the secret, or carries it.
      for (const value of Object.values(row ?? {})) {
        expect(String(value)).not.toContain(secret.slice('gethome_'.length));
      }
      // And no answer after this one does either.
      const listed = await app.inject({ method: 'GET', url: '/api/v1/api-keys', headers: auth(memberToken) });
      expect(listed.body).not.toContain(secret);
      expect((listed.json() as KeyWire[]).some((entry) => entry.id === key.id)).toBe(true);
    });

    it('answers a change that changes nothing with the key as it stands', async () => {
      const { key } = await mint(memberToken, { name: 'Unchanged' });
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/api-keys/${key.id}`,
        headers: auth(memberToken),
        payload: {},
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ id: key.id, name: 'Unchanged' });
    });

    it('sets an expiry in days, or none', async () => {
      const { key } = await mint(memberToken, { name: 'Shortcut', expiresInDays: 30 });
      const days = (Date.parse(key.expiresAt!) - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(29.9);
      expect(days).toBeLessThanOrEqual(30);
    });

    /**
     * Strict, because the alternative is quietly broader: a narrowing field a
     * later build adds would be stripped by this one and the key made without
     * it. A 400 is the only safe thing an older hub can say.
     */
    it('refuses a body it does not fully understand', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/api-keys',
        headers: auth(memberToken),
        payload: { name: 'Kitchen only', rooms: ['kitchen'] },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'invalid_body' });
    });

    it('refuses what no key may hold, by name', async () => {
      for (const permission of ['hub.ai', 'member.invite', 'role.manage', 'hub.apikeys', 'hub.mqtt', 'hub.wifi', 'hub.timetravel']) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/api-keys',
          headers: auth(ownerToken),
          payload: { name: 'Greedy', control: true, permissions: [permission] },
        });
        expect(response.statusCode, permission).toBe(400);
        expect(response.json(), permission).toEqual({ error: 'not_grantable', permission });
      }
    });

    it('will not let a key write rules unless it may work the home', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/api-keys',
        headers: auth(memberToken),
        payload: { name: 'Rules', permissions: ['automation.manage'] },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'needs_control', permission: 'automation.manage' });
    });

    it('will not give a key more than its member has', async () => {
      // Renaming the home is not in Member's defaults.
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/api-keys',
        headers: auth(memberToken),
        payload: { name: 'Renamer', permissions: ['home.rename'] },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'forbidden', permission: 'home.rename' });
    });

    it('needs hub.apikeys to make one, and lets anybody see their own', async () => {
      const refused = await app.inject({
        method: 'POST',
        url: '/api/v1/api-keys',
        headers: auth(guestToken),
        payload: { name: 'Mine' },
      });
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toEqual({ error: 'forbidden', permission: 'hub.apikeys' });
      const own = await app.inject({ method: 'GET', url: '/api/v1/api-keys', headers: auth(guestToken) });
      expect(own.statusCode).toBe(200);
      expect(own.json()).toEqual([]);
    });

    it('stops at twenty-five keys a person', async () => {
      const masha = await join('Masha');
      for (let i = 0; i < 25; i += 1) await mint(masha.token, { name: `Key ${i}` });
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/api-keys',
        headers: auth(masha.token),
        payload: { name: 'One too many' },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: 'too_many_keys', limit: 25 });
    });

    it('holds the cap when the keys are asked for all at once', async () => {
      const sasha = await join('Sasha');
      const burst = 30;
      // Every request is held at the door of the insert until all of them
      // have reached it — the interleaving that put a member past the cap
      // when the count was a query of its own, made certain rather than left
      // to the scheduler, which on a synchronous driver almost never offers it.
      let arrived = 0;
      let release!: () => void;
      const everyone = new Promise<void>((resolve) => {
        release = resolve;
      });
      const real = ApiKeyService.prototype.create;
      const create = vi
        .spyOn(ApiKeyService.prototype, 'create')
        .mockImplementation(async function (this: ApiKeyService, input: NewApiKey) {
          arrived += 1;
          if (arrived === burst) release();
          await everyone;
          return real.call(this, input);
        });
      try {
        const responses = await Promise.all(
          Array.from({ length: burst }, (_, i) =>
            app.inject({
              method: 'POST',
              url: '/api/v1/api-keys',
              headers: auth(sasha.token),
              payload: { name: `Burst ${i}` },
            }),
          ),
        );
        expect(responses.filter((response) => response.statusCode === 201)).toHaveLength(25);
        expect(responses.filter((response) => response.statusCode === 409)).toHaveLength(burst - 25);
      } finally {
        create.mockRestore();
      }
      expect(await keysOf(sasha.token)).toHaveLength(25);
    });

    it('writes making, changing and revoking a key to the activity log', async () => {
      const { key } = await mint(memberToken, { name: 'Node-RED' });
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/api-keys/${key.id}`,
        headers: auth(memberToken),
        payload: { control: true },
      });
      await app.inject({ method: 'DELETE', url: `/api/v1/api-keys/${key.id}`, headers: auth(memberToken) });
      const rows = (await activity()).filter((row) => row.data?.apiKeyId === key.id);
      expect(rows.map((row) => [row.kind, row.message])).toEqual([
        ['apikey.removed', 'Anna revoked the API key “Node-RED”.'],
        ['apikey.changed', 'Anna changed what the API key “Node-RED” can do.'],
        ['apikey.added', 'Anna created the API key “Node-RED”.'],
      ]);
      for (const row of rows) {
        expect(row.memberId).toBe(memberId);
        expect(row.data).toMatchObject({ memberName: 'Anna', apiKeyName: 'Node-RED' });
        // Done *to* a key by a person, not *through* one.
        expect(row.data?.via).toBeUndefined();
      }
    });
  });

  // ── What a key may do ─────────────────────────────────────────────────────

  describe('what a key may do', () => {
    let readOnly: string;
    let controlKey: string;
    let editor: string;
    let rules: string;

    beforeAll(async () => {
      readOnly = (await mint(memberToken, { name: 'Dashboard' })).secret;
      controlKey = (await mint(memberToken, { name: 'Node-RED', control: true })).secret;
      editor = (await mint(memberToken, { name: 'Tidier', control: true, permissions: ['device.edit'] })).secret;
      rules = (
        await mint(memberToken, { name: 'Rule writer', control: true, permissions: ['automation.manage'] })
      ).secret;
    });

    // Each case is [method, url, payload, status, body], where body is what
    // the refusal must say. `object | undefined`, never `unknown` — see the
    // note in `test/roles.test.ts`.
    type Case = [string, string, object | undefined, number, object | undefined];

    const run = async (secret: string, cases: Case[]) => {
      for (const [method, url, payload, status, body] of cases) {
        const response = await app.inject({
          method: method as 'GET',
          url,
          headers: auth(secret),
          ...(payload !== undefined ? { payload } : {}),
        });
        expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(status);
        if (body !== undefined) expect(response.json(), `${method} ${url}`).toEqual(body);
      }
    };

    it('reads everything its member reads, and changes nothing', async () => {
      await run(readOnly, [
        ['GET', '/api/v1/devices', undefined, 200, undefined],
        ['GET', '/api/v1/rooms', undefined, 200, undefined],
        ['GET', '/api/v1/members', undefined, 200, undefined],
        ['GET', `/api/v1/devices/${deviceId}/history`, undefined, 200, undefined],
        ['GET', '/api/v1/automations', undefined, 200, undefined],
        ['POST', `/api/v1/devices/${deviceId}/endpoints/1/commands`, { type: 'power', on: true }, 403, { error: 'key_read_only' }],
        ['PATCH', `/api/v1/devices/${deviceId}`, { favorite: true }, 403, { error: 'key_read_only' }],
        ['PATCH', `/api/v1/devices/${deviceId}`, { name: 'Renamed' }, 403, { error: 'forbidden', permission: 'device.edit' }],
        ['POST', '/api/v1/rooms', { name: 'Shed' }, 403, { error: 'forbidden', permission: 'home.structure' }],
        ['POST', '/api/v1/automations/11111111-1111-4111-a111-111111111111/run', undefined, 403, { error: 'key_read_only' }],
      ]);
      const me = (await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(readOnly) })).json() as {
        id: string;
        permissions: string[];
        isOwner: boolean;
        apiKey: { name: string; control: boolean; permissions: string[]; state: string };
      };
      expect(me).toMatchObject({ id: memberId, permissions: [], isOwner: false });
      expect(me.apiKey).toMatchObject({ name: 'Dashboard', control: false, permissions: [], state: 'active' });
    });

    it('works the home with control — and still nothing of the house', async () => {
      adapter.executed.length = 0;
      await run(controlKey, [
        ['POST', `/api/v1/devices/${deviceId}/endpoints/1/commands`, { type: 'power', on: true }, 202, undefined],
        ['PATCH', `/api/v1/devices/${deviceId}`, { favorite: true }, 200, undefined],
        ['PATCH', `/api/v1/devices/${deviceId}`, { name: 'Renamed' }, 403, { error: 'forbidden', permission: 'device.edit' }],
        ['DELETE', `/api/v1/devices/${deviceId}`, undefined, 403, { error: 'forbidden', permission: 'device.remove' }],
        ['POST', '/api/v1/automations/dry-run', { name: 'x', triggers: [{ kind: 'manual' }], actions: [] }, 403, { error: 'forbidden', permission: 'automation.manage' }],
      ]);
      expect(adapter.executed).toEqual([{ externalId: 'lamp-1', endpointId: 1, command: { type: 'power', on: true } }]);
      // The pin is the member's own — a key works the home *as* them.
      const anna = (await app.inject({ method: 'GET', url: '/api/v1/devices', headers: auth(memberToken) })).json() as Array<{ id: string; favorite: boolean }>;
      expect(anna.find((device) => device.id === deviceId)?.favorite).toBe(true);
    });

    it('renames with device.edit, and the house hears who did it through what', async () => {
      await run(editor, [
        ['PATCH', `/api/v1/devices/${deviceId}`, { name: 'Reading lamp' }, 200, undefined],
      ]);
      const row = (await activity()).find((entry) => entry.kind === 'device.renamed');
      expect(row?.message).toBe('Anna’s “Tidier” renamed “Desk lamp” to “Reading lamp”.');
      expect(row?.memberId).toBe(memberId);
      expect(row?.data).toMatchObject({ memberName: 'Anna', via: 'api', apiKeyName: 'Tidier' });
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/devices/${deviceId}`,
        headers: auth(ownerToken),
        payload: { name: 'Desk lamp' },
      });
    });

    it('writes rules with automation.manage, switched off like everybody’s', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/automations',
        headers: auth(rules),
        payload: { name: 'From a script', triggers: [{ kind: 'manual' }], actions: [{ kind: 'logActivity', message: 'hi' }] },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ enabled: false });
      const row = (await activity()).find((entry) => entry.kind === 'automation.added');
      expect(row?.message).toBe('Anna’s “Rule writer” added the automation “From a script”');
    });

    it('names the key in a command’s line, on the member’s row', async () => {
      await run(controlKey, [
        ['POST', `/api/v1/devices/${deviceId}/endpoints/1/commands`, { type: 'power', on: false }, 202, undefined],
      ]);
      const row = (await activity()).find((entry) => entry.kind === 'device.command');
      expect(row?.message).toBe('Anna’s “Node-RED” · Desk lamp: power');
      expect(row?.memberId).toBe(memberId);
      expect(row?.data).toMatchObject({
        memberName: 'Anna',
        via: 'api',
        apiKeyName: 'Node-RED',
        deviceName: 'Desk lamp',
      });
      expect(typeof row?.data?.apiKeyId).toBe('string');
    });

    it('presses a scene with control, and the run says which key pressed it', async () => {
      const created = (
        await app.inject({
          method: 'POST',
          url: '/api/v1/automations',
          headers: auth(ownerToken),
          payload: { name: 'Leaving', triggers: [{ kind: 'manual' }], actions: [{ kind: 'logActivity', message: 'bye' }] },
        })
      ).json() as { id: string };
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/automations/${created.id}`,
        headers: auth(ownerToken),
        payload: { enabled: true },
      });
      await run(controlKey, [['POST', `/api/v1/automations/${created.id}/run`, undefined, 202, undefined]]);
      await engine.settled();
      const runs = (
        await app.inject({ method: 'GET', url: `/api/v1/automations/${created.id}/runs`, headers: auth(ownerToken) })
      ).json() as Array<{ cause: string }>;
      expect(runs[0]?.cause).toBe('Anna’s “Node-RED” pressed Leaving');
    });

    it('writes the press and the mode switch as its member’s, through the key', async () => {
      // A second lamp, so the mode's command is not refused by the two-second
      // floor the scene's command to the first one just started.
      adapter.bus!.deviceUpserted({
        adapter: 'mqtt',
        externalId: 'lamp-2',
        suggestedName: 'Floor lamp',
        endpoints: [{ endpointId: 1, deviceKind: 'light', capabilities: ['onOff'], primary: 'onOff' }],
      });
      await registry.flush();
      const floorLamp = registry.listDevices().find((device) => device.name === 'Floor lamp')!.id;
      const switching = (id: string) => [
        { kind: 'deviceCommand', target: { deviceIds: [id] }, command: { type: 'toggle' } },
      ];
      const make = async (payload: object): Promise<string> => {
        const created = (
          await app.inject({ method: 'POST', url: '/api/v1/automations', headers: auth(ownerToken), payload })
        ).json() as { id: string };
        await app.inject({
          method: 'PATCH',
          url: `/api/v1/automations/${created.id}`,
          headers: auth(ownerToken),
          payload: { enabled: true },
        });
        return created.id;
      };
      const scene = await make({ name: 'Lights out', triggers: [{ kind: 'manual' }], actions: switching(deviceId) });
      const mode = await make({
        name: 'Movie night',
        triggers: [{ kind: 'manual' }],
        actions: switching(floorLamp),
        offActions: switching(floorLamp),
      });
      await run(controlKey, [
        ['POST', `/api/v1/automations/${scene}/run`, undefined, 202, undefined],
        ['PUT', `/api/v1/automations/${mode}/active`, { active: true }, 200, undefined],
      ]);
      await engine.settled();
      const rows = (await activity()).filter((row) => row.kind === 'automation.ran');
      expect(rows.map((row) => row.message)).toEqual([
        'Anna’s “Node-RED” switched Movie night on',
        'Anna’s “Node-RED” pressed Lights out',
      ]);
      for (const row of rows) {
        expect(row.memberId).toBe(memberId);
        expect(row.data).toMatchObject({ via: 'api', apiKeyName: 'Node-RED' });
        expect(typeof row.data?.apiKeyId).toBe('string');
        // Left off on purpose: the iPhone app titles a line about no device
        // by it, over a sentence that already starts with it.
        expect(row.data?.memberName).toBeUndefined();
      }
    });

    /**
     * The owner rule — never evaluated — is about a person who can always put
     * the matrix back. A script cannot, so an owner's key holds what it was
     * given and nothing more.
     */
    it('gives an owner’s key what it was given, not what the owner has', async () => {
      const { secret } = await mint(ownerToken, { name: 'Owner’s reader' });
      await run(secret, [
        ['POST', '/api/v1/rooms', { name: 'Attic' }, 403, { error: 'forbidden', permission: 'home.structure' }],
        ['PATCH', '/api/v1/home', { name: 'Mine now' }, 403, { error: 'forbidden', permission: 'home.rename' }],
        ['GET', '/api/v1/settings/ai', undefined, 403, { error: 'key_not_allowed', permission: 'hub.ai' }],
      ]);
      const builder = (await mint(ownerToken, { name: 'Builder', permissions: ['home.structure'] })).secret;
      const room = await app.inject({ method: 'POST', url: '/api/v1/rooms', headers: auth(builder), payload: { name: 'Attic' } });
      expect(room.statusCode).toBe(201);
    });

    it('never mints a credential, changes a membership, or joins a conversation', async () => {
      const uuid = '44444444-4444-4444-a444-444444444444';
      const notAllowed = { error: 'key_not_allowed' };
      await run(controlKey, [
        ['POST', '/api/v1/invites', {}, 403, notAllowed],
        ['POST', '/api/v1/invites', { memberId: 'me' }, 403, notAllowed],
        ['PATCH', '/api/v1/members/me', { name: 'Script' }, 403, notAllowed],
        ['DELETE', '/api/v1/members/me', undefined, 403, notAllowed],
        ['GET', '/api/v1/api-keys', undefined, 403, notAllowed],
        ['POST', '/api/v1/api-keys', { name: 'Another' }, 403, notAllowed],
        ['PATCH', `/api/v1/api-keys/${uuid}`, { name: 'x' }, 403, notAllowed],
        ['DELETE', `/api/v1/api-keys/${uuid}`, undefined, 403, notAllowed],
        ['GET', '/api/v1/automations/chats', undefined, 403, notAllowed],
        ['GET', `/api/v1/automations/chat/${uuid}`, undefined, 403, notAllowed],
        ['POST', '/api/v1/automations/chat', { message: 'hi' }, 403, notAllowed],
        ['POST', `/api/v1/automations/chat/${uuid}/stop`, undefined, 403, notAllowed],
        ['GET', '/api/v1/assistant/chats', undefined, 403, notAllowed],
        ['GET', `/api/v1/assistant/chat/${uuid}`, undefined, 403, notAllowed],
        ['POST', '/api/v1/assistant/chat', { message: 'hi' }, 403, notAllowed],
        ['POST', `/api/v1/assistant/chat/${uuid}/stop`, undefined, 403, notAllowed],
        ['POST', '/api/v1/assistant/voice/session', { sdp: 'v=0' }, 403, notAllowed],
        // Permissions no key may hold say which, so the integration knows what
        // it has to do without.
        ['GET', '/api/v1/invites', undefined, 403, { error: 'key_not_allowed', permission: 'member.invite' }],
        ['GET', '/api/v1/settings/mqtt', undefined, 403, { error: 'key_not_allowed', permission: 'hub.mqtt' }],
        ['GET', '/api/v1/settings/wifi', undefined, 403, { error: 'key_not_allowed', permission: 'hub.wifi' }],
        ['POST', '/api/v1/roles', { name: 'Root' }, 403, { error: 'key_not_allowed', permission: 'role.manage' }],
        ['DELETE', `/api/v1/members/${ownerId}`, undefined, 403, { error: 'key_not_allowed', permission: 'member.remove' }],
      ]);
    });

    it('reads only its member’s lines without activity.read, and the home’s with it', async () => {
      const own = (
        await app.inject({ method: 'GET', url: '/api/v1/activity?limit=200', headers: auth(readOnly) })
      ).json() as ActivityRow[];
      expect(own.length).toBeGreaterThan(0);
      expect(own.every((row) => row.memberId === memberId)).toBe(true);
      const reader = (await mint(memberToken, { name: 'Feed', permissions: ['activity.read'] })).secret;
      const all = (
        await app.inject({ method: 'GET', url: '/api/v1/activity?limit=200', headers: auth(reader) })
      ).json() as ActivityRow[];
      expect(all.some((row) => row.memberId === ownerId)).toBe(true);
    });

    it('wants the key in the header — and a member token may still ride the query', async () => {
      const keyed = await app.inject({ method: 'GET', url: `/api/v1/devices?token=${readOnly}` });
      expect(keyed.statusCode).toBe(401);
      expect(keyed.json()).toEqual({ error: 'unauthorized', reason: 'key_in_query' });
      const member = await app.inject({ method: 'GET', url: `/api/v1/devices?token=${memberToken}` });
      expect(member.statusCode).toBe(200);
      const refused = (await keysOf(memberToken)).find((key) => key.name === 'Dashboard');
      expect(refused?.lastRefusal).toMatchObject({
        status: 401,
        error: 'unauthorized',
        reason: 'key_in_query',
        method: 'GET',
        // The path, never the query string the key arrived in.
        path: '/api/v1/devices',
      });
    });

    it('records when and from where each key was last used', async () => {
      const listed = (await keysOf(memberToken)).find((key) => key.name === 'Node-RED');
      expect(listed?.lastUsedFrom).toBe('127.0.0.1');
      expect(Date.now() - Date.parse(listed!.lastUsedAt!)).toBeLessThan(60_000);
      expect(listed?.effective).toEqual([]);
    });
  });

  // ── A key that has stopped working ───────────────────────────────────────

  describe('a key that has stopped working', () => {
    it('refuses an expired key, says so, and works again when its expiry moves', async () => {
      const { key, secret } = await mint(memberToken, { name: 'Holiday script', expiresInDays: 1 });
      await db.update(apiKeysTable).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(apiKeysTable.id, key.id));
      const refused = await app.inject({ method: 'GET', url: '/api/v1/devices', headers: auth(secret) });
      expect(refused.statusCode).toBe(401);
      expect(refused.json()).toEqual({ error: 'unauthorized', reason: 'key_expired' });
      const listed = (await keysOf(memberToken)).find((entry) => entry.id === key.id);
      expect(listed?.state).toBe('expired');
      expect(listed?.lastRefusal).toMatchObject({ status: 401, reason: 'key_expired' });

      const renewed = await app.inject({
        method: 'PATCH',
        url: `/api/v1/api-keys/${key.id}`,
        headers: auth(memberToken),
        payload: { expiresInDays: 7 },
      });
      expect(renewed.json()).toMatchObject({ state: 'active' });
      expect((await app.inject({ method: 'GET', url: '/api/v1/devices', headers: auth(secret) })).statusCode).toBe(200);
    });

    /**
     * One switch in the matrix pauses a role's keys, and switching it back
     * resumes them — the keys themselves are untouched.
     */
    it('pauses every key of a role that loses hub.apikeys, and resumes them', async () => {
      const { key, secret } = await mint(memberToken, { name: 'Paused', control: true });
      const memberRole = await roleId('member');
      const before = (await app.inject({ method: 'GET', url: '/api/v1/roles', headers: auth(ownerToken) })).json() as RoleWire[];
      const original = before.find((role) => role.id === memberRole)!.permissions;
      const set = (permissions: string[]) =>
        app.inject({ method: 'PATCH', url: `/api/v1/roles/${memberRole}`, headers: auth(ownerToken), payload: { permissions } });

      await set(original.filter((permission) => permission !== 'hub.apikeys'));
      try {
        const refused = await app.inject({ method: 'GET', url: '/api/v1/devices', headers: auth(secret) });
        expect(refused.statusCode).toBe(401);
        expect(refused.json()).toEqual({ error: 'unauthorized', reason: 'key_suspended' });
        expect((await keysOf(memberToken)).find((entry) => entry.id === key.id)?.state).toBe('suspended');
        // Their own keys stay theirs to see and to revoke.
        const making = await app.inject({ method: 'POST', url: '/api/v1/api-keys', headers: auth(memberToken), payload: { name: 'x' } });
        expect(making.json()).toEqual({ error: 'forbidden', permission: 'hub.apikeys' });
      } finally {
        await set(original);
      }
      expect((await app.inject({ method: 'GET', url: '/api/v1/devices', headers: auth(secret) })).statusCode).toBe(200);
    });

    it('narrows the moment its member does, without touching the grant', async () => {
      const lena = await join('Lena');
      const { key, secret } = await mint(lena.token, { name: 'Tidy', control: true, permissions: ['device.edit'] });
      const helper = (
        await app.inject({
          method: 'POST',
          url: '/api/v1/roles',
          headers: auth(ownerToken),
          payload: { name: 'Helper', permissions: ['hub.apikeys'] },
        })
      ).json() as { id: string };
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/members/${lena.id}`,
        headers: auth(ownerToken),
        payload: { roleId: helper.id },
      });
      const refused = await app.inject({
        method: 'PATCH',
        url: `/api/v1/devices/${deviceId}`,
        headers: auth(secret),
        payload: { name: 'Nope' },
      });
      expect(refused.json()).toEqual({ error: 'forbidden', permission: 'device.edit' });
      const listed = (await keysOf(lena.token)).find((entry) => entry.id === key.id);
      expect(listed).toMatchObject({ state: 'active', permissions: ['device.edit'], effective: [] });
      // Renaming the key is not refused for what its member no longer has.
      const renamed = await app.inject({
        method: 'PATCH',
        url: `/api/v1/api-keys/${key.id}`,
        headers: auth(lena.token),
        payload: { name: 'Tidy (old)' },
      });
      expect(renamed.statusCode).toBe(200);
    });

    it('is worth nothing once revoked, or once its member has gone', async () => {
      const { key, secret } = await mint(memberToken, { name: 'Revoked' });
      await app.inject({ method: 'DELETE', url: `/api/v1/api-keys/${key.id}`, headers: auth(memberToken) });
      expect((await app.inject({ method: 'GET', url: '/api/v1/devices', headers: auth(secret) })).json()).toEqual({
        error: 'unauthorized',
      });

      const vitya = await join('Vitya');
      const theirs = (await mint(vitya.token, { name: 'Leaving soon' })).secret;
      expect((await app.inject({ method: 'GET', url: '/api/v1/devices', headers: auth(theirs) })).statusCode).toBe(200);
      const removed = await app.inject({ method: 'DELETE', url: `/api/v1/members/${vitya.id}`, headers: auth(ownerToken) });
      expect(removed.statusCode).toBe(204);
      expect((await app.inject({ method: 'GET', url: '/api/v1/devices', headers: auth(theirs) })).statusCode).toBe(401);
      expect(await db.query.apiKeys.findMany({ where: eq(apiKeysTable.memberId, vitya.id) })).toEqual([]);
    });

    /**
     * The rollback this table exists for: a build from before keys reads only
     * `tokens`, so a key there is a 401 — never a full member token.
     */
    it('is not a member token to anything that only knows member tokens', async () => {
      const { secret } = await mint(memberToken, { name: 'Rollback' });
      expect(await pairing.verifyToken(secret)).toBeNull();
    });
  });

  // ── Other people's keys ───────────────────────────────────────────────────

  describe('other people’s keys', () => {
    it('shows everybody’s keys to member.remove, and only your own to everybody else', async () => {
      const mine = await mint(ownerToken, { name: 'Georgy’s' });
      const owners = await keysOf(ownerToken);
      expect(owners.some((key) => key.memberName === 'Anna' && !key.isMine)).toBe(true);
      expect(owners.find((key) => key.id === mine.key.id)?.isMine).toBe(true);
      const annas = await keysOf(memberToken);
      expect(annas.length).toBeGreaterThan(0);
      expect(annas.every((key) => key.memberId === memberId && key.isMine)).toBe(true);
    });

    it('lets nobody but its member change a key — owners included', async () => {
      const annas = await mint(memberToken, { name: 'Anna’s own' });
      const georgys = await mint(ownerToken, { name: 'Georgy’s own' });
      for (const [token, id] of [
        [ownerToken, annas.key.id],
        [memberToken, georgys.key.id],
      ] as const) {
        const response = await app.inject({
          method: 'PATCH',
          url: `/api/v1/api-keys/${id}`,
          headers: auth(token),
          payload: { name: 'Mine now' },
        });
        expect(response.statusCode).toBe(403);
        expect(response.json()).toEqual({ error: 'not_your_key' });
      }
    });

    it('revokes somebody else’s with member.remove, and an owner’s only as an owner', async () => {
      const georgys = await mint(ownerToken, { name: 'Owner script' });
      const refused = await app.inject({ method: 'DELETE', url: `/api/v1/api-keys/${georgys.key.id}`, headers: auth(memberToken) });
      expect(refused.json()).toEqual({ error: 'forbidden', permission: 'member.remove' });

      const doorkeeper = (
        await app.inject({
          method: 'POST',
          url: '/api/v1/roles',
          headers: auth(ownerToken),
          payload: { name: 'Doorkeeper', permissions: ['member.remove'] },
        })
      ).json() as { id: string };
      const petya = await join('Petya');
      await app.inject({ method: 'PATCH', url: `/api/v1/members/${petya.id}`, headers: auth(ownerToken), payload: { roleId: doorkeeper.id } });
      const notOwner = await app.inject({ method: 'DELETE', url: `/api/v1/api-keys/${georgys.key.id}`, headers: auth(petya.token) });
      expect(notOwner.json()).toEqual({ error: 'not_owner' });

      const annas = await mint(memberToken, { name: 'Anna’s bridge' });
      const byPetya = await app.inject({ method: 'DELETE', url: `/api/v1/api-keys/${annas.key.id}`, headers: auth(petya.token) });
      expect(byPetya.statusCode).toBe(204);
      const row = (await activity()).find((entry) => entry.kind === 'apikey.removed' && entry.data?.apiKeyId === annas.key.id);
      expect(row?.message).toBe('Petya revoked Anna’s API key “Anna’s bridge”.');
      expect(row?.data).toMatchObject({ memberName: 'Petya', subjectName: 'Anna' });
    });
  });

  // ── The event stream ──────────────────────────────────────────────────────

  /** Open a socket and keep what it hears, and how it ended. */
  const connect = (options: { secret: string; inQuery?: boolean }) => {
    const url = `ws://127.0.0.1:${port}/api/v1/ws${options.inQuery ? `?token=${options.secret}` : ''}`;
    const socket = new WebSocket(url, options.inQuery ? {} : { headers: auth(options.secret) });
    const frames: Array<Record<string, unknown>> = [];
    const closed = new Promise<number>((resolve) => socket.on('close', (code) => resolve(code)));
    socket.on('message', (data) => frames.push(JSON.parse(String(data)) as Record<string, unknown>));
    const waitFor = async (type: string, after = 0): Promise<Record<string, unknown>> => {
      const deadline = Date.now() + 5000;
      for (;;) {
        const found = frames.slice(after).find((frame) => frame.type === type);
        if (found) return found;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${type}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    return { socket, frames, closed, waitFor };
  };

  describe('the event stream', () => {
    it('says it is a key, what it may do, and which streams it can have', async () => {
      const { key, secret } = await mint(memberToken, { name: 'Watcher', permissions: ['activity.read'] });
      const { socket, waitFor } = connect({ secret });
      const hello = await waitFor('hello');
      expect(hello.apiKey).toEqual({ id: key.id, name: 'Watcher', control: false });
      expect(hello.permissions).toEqual(['activity.read']);
      // No broker tap on this test hub, and no AI stream for a key on any hub.
      expect(hello.streams).toEqual(['zigbee', 'automations']);

      socket.send(JSON.stringify({ type: 'subscribe', streams: ['automations', 'ai', 'zigbee'] }));
      const ack = await waitFor('subscribed');
      expect(ack).toMatchObject({ streams: ['automations', 'zigbee'], unavailable: ['ai'] });
      socket.close();
    });

    it('carries the rules firing and never a conversation', async () => {
      const { secret } = await mint(memberToken, { name: 'Rule watcher' });
      const { socket, frames, waitFor } = connect({ secret });
      await waitFor('hello');
      socket.send(JSON.stringify({ type: 'subscribe', streams: ['automations'] }));
      await waitFor('subscribed');
      const chat = { sessionId: '55555555-5555-4555-a555-555555555555', phase: 'delta' as const, at: new Date().toISOString(), text: 'private' };
      events.emit('automationChat', chat);
      events.emit('assistantChat', chat);
      events.emit('automationRun', {
        automationId: 'a',
        name: 'Night',
        at: new Date().toISOString(),
        trigger: 'manual',
        cause: 'test',
        outcome: 'ran',
        commands: 0,
        refused: 0,
      });
      await waitFor('automationRun');
      expect(frames.some((frame) => frame.type === 'automationChat' || frame.type === 'assistantChat')).toBe(false);
      socket.close();
    });

    it('takes a key in the query here, and refuses a bad one with 4001', async () => {
      const { secret } = await mint(memberToken, { name: 'Query socket' });
      const good = connect({ secret, inQuery: true });
      await good.waitFor('hello');
      good.socket.close();
      const bad = connect({ secret: `gethome_${'0'.repeat(43)}` });
      expect(await bad.closed).toBe(4001);
    });

    it('hangs up a revoked key’s streams with 4001', async () => {
      const { key, secret } = await mint(memberToken, { name: 'Revoke me' });
      const stream = connect({ secret });
      await stream.waitFor('hello');
      expect((await keysOf(memberToken)).find((entry) => entry.id === key.id)?.connections).toBe(1);
      await app.inject({ method: 'DELETE', url: `/api/v1/api-keys/${key.id}`, headers: auth(memberToken) });
      expect(await stream.closed).toBe(4001);
    });

    it('hangs up a key’s streams when its member is removed', async () => {
      const ira = await join('Ira');
      const { secret } = await mint(ira.token, { name: 'Ira’s bridge' });
      const stream = connect({ secret });
      await stream.waitFor('hello');
      await app.inject({ method: 'DELETE', url: `/api/v1/members/${ira.id}`, headers: auth(ownerToken) });
      expect(await stream.closed).toBe(4001);
    });

    it('tells an open stream when its key changes', async () => {
      const { key, secret } = await mint(memberToken, { name: 'Growing' });
      const stream = connect({ secret });
      await stream.waitFor('hello');
      const seen = stream.frames.length;
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/api-keys/${key.id}`,
        headers: auth(memberToken),
        payload: { permissions: ['activity.read'] },
      });
      const frame = await stream.waitFor('access', seen);
      expect(frame.permissions).toEqual(['activity.read']);
      stream.socket.close();
    });

    it('closes a paused key’s stream on the next thing the hub says', async () => {
      const { secret } = await mint(memberToken, { name: 'Will pause' });
      const stream = connect({ secret });
      await stream.waitFor('hello');
      const memberRole = await roleId('member');
      const roles = (await app.inject({ method: 'GET', url: '/api/v1/roles', headers: auth(ownerToken) })).json() as RoleWire[];
      const original = roles.find((role) => role.id === memberRole)!.permissions;
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/roles/${memberRole}`,
        headers: auth(ownerToken),
        payload: { permissions: original.filter((permission) => permission !== 'hub.apikeys') },
      });
      try {
        expect(await stream.closed).toBe(4001);
      } finally {
        await app.inject({ method: 'PATCH', url: `/api/v1/roles/${memberRole}`, headers: auth(ownerToken), payload: { permissions: original } });
      }
    });

    it('holds five streams a key, and closes a sixth with 1008', async () => {
      const { secret } = await mint(memberToken, { name: 'Many tabs' });
      const open = [];
      for (let i = 0; i < 5; i += 1) {
        const stream = connect({ secret });
        await stream.waitFor('hello');
        open.push(stream);
      }
      const sixth = connect({ secret });
      expect(await sixth.closed).toBe(1008);
      for (const stream of open) stream.socket.close();
    });
  });

  // ── The handshake ─────────────────────────────────────────────────────────

  /**
   * The gap between a socket's credential being read and the socket being
   * filed, driven directly. A real client cannot be made to land a revoke or
   * an activity row inside a handshake on cue, and a test that only sometimes
   * reaches the window it is about is a test of nothing.
   */
  describe('the handshake', () => {
    class FakeSocket extends EventEmitter {
      readonly OPEN = 1;
      readyState = 1;
      readonly sent: Array<Record<string, unknown>> = [];
      closedWith: number | undefined;
      send(data: string) {
        this.sent.push(JSON.parse(data) as Record<string, unknown>);
      }
      close(code: number) {
        this.closedWith = code;
        this.readyState = 3;
        this.emit('close', code);
      }
    }
    const hubStatus = { snapshot: () => ({}) } as unknown as HubStatusReader;
    const open = (sessions: MemberSessions) => {
      const socket = new FakeSocket();
      const handle = attachWebSocket(
        socket as unknown as WebSocket,
        { ...shared, log: silent },
        sessions,
        hubStatus,
      );
      return { socket, handle };
    };
    const record = async (id: string): Promise<ApiKeyRecord> => (await new ApiKeyService(db).get(id))!;
    const line = (id: number, member?: string) => ({
      id,
      at: new Date().toISOString(),
      kind: 'device.command',
      message: `line ${id}`,
      ...(member !== undefined ? { memberId: member } : {}),
    });
    const lineIds = (socket: FakeSocket) =>
      socket.sent
        .filter((frame) => frame.type === 'activity')
        .map((frame) => (frame.entry as { id: number }).id);

    it('renders what happened during it for the reader it turned out to be', async () => {
      const { key } = await mint(memberToken, { name: 'Late reader' });
      const narrow = open(new MemberSessions());
      // Somebody else's line, nobody's, and the reader's own, all landing
      // while the token is still being checked.
      events.emit('activity', line(-1, ownerId));
      events.emit('activity', line(-2));
      events.emit('activity', line(-3, memberId));
      expect(narrow.socket.sent).toEqual([]);
      narrow.handle.authorize(memberId, await record(key.id));
      expect(narrow.socket.sent[0]?.type).toBe('hello');
      expect(lineIds(narrow.socket)).toEqual([-3]);
      narrow.handle.close();

      // A key that may read the house is handed the house.
      const { key: reader } = await mint(memberToken, { name: 'Whole feed', permissions: ['activity.read'] });
      const wide = open(new MemberSessions());
      events.emit('activity', line(-4, ownerId));
      events.emit('activity', line(-5));
      wide.handle.authorize(memberId, await record(reader.id));
      expect(lineIds(wide.socket)).toEqual([-4, -5]);
      wide.handle.close();
    });

    it('turns a socket away when its key or member was revoked while it was let in', async () => {
      const { key } = await mint(memberToken, { name: 'Gone mid-handshake' });
      const read = await record(key.id);
      const sessions = new MemberSessions();

      // The key is read, the revoke lands and finds nothing open, and only
      // then does the socket ask to be filed.
      const keyed = open(sessions);
      expect(sessions.revokeKey(key.id)).toBe(0);
      keyed.handle.authorize(memberId, read);
      expect(keyed.socket.closedWith).toBe(4001);
      expect(keyed.socket.sent).toEqual([]);
      expect(sessions.countKey(key.id)).toBe(0);

      // The same gap, for somebody removed from the home.
      const member = open(sessions);
      expect(sessions.revoke(ownerId)).toBe(0);
      member.handle.authorize(ownerId, null);
      expect(member.socket.closedWith).toBe(4001);
      expect(member.socket.sent).toEqual([]);
    });

    it('lets a socket in with the grant an edit made while it was let in', async () => {
      const { key } = await mint(memberToken, { name: 'Before' });
      const read = await record(key.id);
      const sessions = new MemberSessions();
      const { socket, handle } = open(sessions);
      sessions.rekey({ ...read, name: 'After', permissions: ['activity.read'] });
      handle.authorize(memberId, read);
      const hello = socket.sent.find((frame) => frame.type === 'hello');
      expect(hello?.apiKey).toMatchObject({ id: key.id, name: 'After' });
      expect(hello?.permissions).toEqual(['activity.read']);
      handle.close();
    });

    it('forgets a revocation once no handshake could still be waiting on it', () => {
      const sessions = new MemberSessions();
      const session = { revoke: () => {}, rekey: () => {} };
      sessions.revoke(memberId, 0);
      expect(sessions.admit(memberId, session, null, LATE_ADMISSION_MS)).toBeNull();
      expect(sessions.admit(memberId, session, null, LATE_ADMISSION_MS + 1)).toEqual({ key: null });
    });
  });

  // ── The rate limit ────────────────────────────────────────────────────────

  describe('the rate limit', () => {
    it('lets a key burst, then answers 429 with when to come back', async () => {
      const { secret } = await mint(memberToken, { name: 'Busy loop' });
      // The bucket refills by the clock, ten tokens a second, and keeps the
      // fraction a refused request leaves in it — so whether it was still
      // empty when the stream below opened depended on how long the handshake
      // took. On a loaded runner it sometimes had a whole token again: the
      // stream was let in, nothing ever closed it, and the test waited out its
      // timeout. Held still, the clock leaves the bucket exactly as the
      // requests left it. Only `Date` is faked; timers and sockets are real.
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const statuses: number[] = [];
        let refused: Awaited<ReturnType<typeof app.inject>> | undefined;
        for (let i = 0; i < 120; i += 1) {
          const response = await app.inject({ method: 'GET', url: '/api/v1/home', headers: auth(secret) });
          statuses.push(response.statusCode);
          if (response.statusCode === 429 && refused === undefined) refused = response;
        }
        expect(statuses.slice(0, 50).every((status) => status === 200)).toBe(true);
        expect(statuses.slice(50).every((status) => status === 429)).toBe(true);
        const body = refused!.json() as { error: string; retryAfterMs: number };
        expect(body.error).toBe('rate_limited');
        expect(body.retryAfterMs).toBeGreaterThan(0);
        expect(Number(refused!.headers['retry-after'])).toBeGreaterThanOrEqual(1);

        // And a stream opened from the empty bucket is told to try again later.
        const stream = connect({ secret });
        expect(await stream.closed).toBe(1013);
      } finally {
        vi.useRealTimers();
      }
    });

    it('counts a request it turned away as a refusal, never as a use', async () => {
      const { key, secret } = await mint(memberToken, { name: 'Turned away' });
      // The bucket is empty for exactly one request — no timing to race.
      const take = vi
        .spyOn(ApiKeyService.prototype, 'take')
        .mockReturnValueOnce({ ok: false, retryAfterMs: 1000 });
      try {
        const response = await app.inject({ method: 'GET', url: '/api/v1/home', headers: auth(secret) });
        expect(response.statusCode).toBe(429);
      } finally {
        take.mockRestore();
      }
      const listed = (await keysOf(memberToken)).find((entry) => entry.id === key.id);
      expect(listed?.lastUsedAt).toBeNull();
      expect(listed?.lastUsedFrom).toBeNull();
      expect(listed?.lastRefusal).toMatchObject({ status: 429, error: 'rate_limited' });
    });

    it('leaves member tokens alone', async () => {
      for (let i = 0; i < 120; i += 1) {
        const response = await app.inject({ method: 'GET', url: '/api/v1/home', headers: auth(memberToken) });
        expect(response.statusCode).toBe(200);
      }
    });
  });

  // ── The code itself ───────────────────────────────────────────────────────

  /**
   * `access.can(request.member.id, …)` compiles, passes every member test, and
   * widens every key to its member's whole role. So no handler in `src/api`
   * may ask the access service directly — they ask `can()` or `canAs()`,
   * which know about keys.
   */
  it('asks every permission as the caller, never as the bare member', () => {
    const dir = path.resolve(import.meta.dirname, '../src/api');
    const files = readdirSync(dir).filter((file) => file.endsWith('.ts') && file !== 'auth.ts');
    expect(files).toContain('server.ts');
    for (const file of files) {
      const source = readFileSync(path.join(dir, file), 'utf8');
      expect(source, file).not.toMatch(/access\.can\(/);
      expect(source, file).not.toMatch(/access\.permissionsFor\(/);
    }
  });

  // ── The journal ───────────────────────────────────────────────────────────

  /**
   * An operator who turns the log up to find a fault must not end up with a
   * file that opens their home. Everything a credential can arrive in, at
   * `trace`, against a real listening server — and the log has to have
   * written the requests at all, or this proves nothing.
   */
  it('never writes a query-string credential to the log, at any level', async () => {
    const lines: string[] = [];
    const log: Logger = pino({ level: 'trace' }, { write: (line: string) => void lines.push(line) });
    const traced = await buildServer({ ...shared, log });
    await traced.listen({ port: 0, host: '127.0.0.1' });
    try {
      const address = traced.server.address();
      const tracedPort = typeof address === 'object' && address ? address.port : 0;
      const sentinel = 'SENTINEL0123456789';
      const { secret } = await mint(memberToken, { name: 'Logged?' });

      await traced.inject({ method: 'GET', url: `/api/v1/devices?token=${sentinel}` });
      await traced.inject({ method: 'GET', url: `/api/v1/devices?token=${secret}` });
      await traced.inject({ method: 'GET', url: `/api/v1/no-such-route?token=${sentinel}` });
      await traced.inject({
        method: 'GET',
        url: `/api/v1/hub?token=${sentinel}`,
        headers: { host: 'rebound.example.com' },
      });
      for (const url of [
        `ws://127.0.0.1:${tracedPort}/api/v1/ws?token=${secret}`,
        `ws://127.0.0.1:${tracedPort}/api/v1/ws?token=${sentinel}`,
        // An upgrade to a route that is not a socket: the WebSocket plugin
        // logs the path it refused.
        `ws://127.0.0.1:${tracedPort}/api/v1/devices?token=${sentinel}`,
      ]) {
        const socket = new WebSocket(url);
        await new Promise<void>((resolve) => {
          socket.on('message', () => socket.close());
          socket.on('close', () => resolve());
          socket.on('error', () => resolve());
        });
      }

      const written = lines.join('');
      expect(written).toContain('/api/v1/devices');
      expect(written).toContain('/api/v1/ws');
      expect(written).not.toContain(sentinel);
      expect(written).not.toContain(secret);
      expect(written).not.toContain(secret.slice('gethome_'.length));
    } finally {
      await traced.close();
    }
  });
});
