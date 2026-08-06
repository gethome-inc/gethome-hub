import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { home, invites, members, rooms } from '../db/schema.js';
import type { DeviceRegistry } from '../core/registry.js';
import type { PairingService } from '../core/pairing.js';
import type { ActivityService } from '../core/activity.js';
import type { SettingsService } from '../core/settings.js';
import type { HubEventBus } from '../core/bus.js';
import type { Logger } from '../logging.js';
import { commandSchema } from '../schema/index.js';
import type { MatterAdapter } from '../adapters/matter/adapter.js';
import type { ZigbeeAdapter } from '../adapters/zigbee/adapter.js';
import { deviceWire } from './dto.js';
import { extractToken, requireMember, requireOwner } from './auth.js';
import { attachWebSocket } from './ws.js';

export interface ApiDeps {
  db: Db;
  log: Logger;
  events: HubEventBus;
  registry: DeviceRegistry;
  pairing: PairingService;
  activity: ActivityService;
  settings: SettingsService;
  hubId: string;
  hubName: string;
  version: string;
  /** Present when the corresponding adapter is enabled and running. */
  matter?: MatterAdapter;
  zigbee?: ZigbeeAdapter;
}

interface CommissionJob {
  id: string;
  status: 'running' | 'done' | 'failed';
  nodeId?: string;
  error?: string;
}

const COMMISSION_JOB_TTL_MS = 10 * 60 * 1000;
const PAIR_MAX_FAILURES = 10;
const PAIR_WINDOW_MS = 5 * 60 * 1000;

/**
 * The hub's local API: REST under /api/v1 plus a WebSocket event stream.
 * Auth is a bearer token issued by the pairing claim flow; `GET /api/v1/hub`
 * is the only unauthenticated route (discovery/health).
 */
export async function buildServer(deps: ApiDeps): Promise<FastifyInstance> {
  // pino v10 instance vs fastify's bundled pino types — structurally identical.
  // Fastify logs two `info` lines per request. The apps poll, so on a hub
  // that is simply working that is thousands of lines a day of "200 OK" —
  // write amplification on an SD card, and noise in the log somebody reads
  // when something is actually wrong. Lifting this one child logger to `warn`
  // drops them while leaving the error handler's `request.log.error` intact,
  // and leaving every other module at the configured level. An operator who
  // asked for `debug` or `trace` clearly wants the requests, so they keep them.
  const verbose = deps.log.level === 'trace' || deps.log.level === 'debug';
  const app = Fastify({
    loggerInstance: deps.log.child(
      { module: 'api' },
      verbose ? {} : { level: 'warn' },
    ) as unknown as FastifyBaseLogger,
  });
  await app.register(websocket);

  const authed = { preHandler: [requireMember(deps.pairing)] };
  const ownerOnly = { preHandler: [requireMember(deps.pairing), requireOwner] };
  const commissionJobs = new Map<string, CommissionJob>();

  /** Forget finished commissioning jobs; the map used to grow for the uptime. */
  const forgetJobLater = (jobId: string) => {
    setTimeout(() => commissionJobs.delete(jobId), COMMISSION_JOB_TTL_MS).unref?.();
  };

  /**
   * `POST /pair` is unauthenticated and checks an 8-digit code, so without a
   * lid it is a hundred million guesses at LAN speed. This is deliberately
   * crude — a home hub has a handful of clients — and it counts *failures*, so
   * a person retyping a code they misread is never locked out by their own
   * successful attempt.
   */
  const pairFailures = new Map<string, { count: number; until: number }>();
  const pairAttemptAllowed = (address: string): boolean => {
    const record = pairFailures.get(address);
    if (!record) return true;
    if (Date.now() > record.until) {
      pairFailures.delete(address);
      return true;
    }
    return record.count < PAIR_MAX_FAILURES;
  };
  const recordPairFailure = (address: string): void => {
    const now = Date.now();
    const record = pairFailures.get(address);
    if (!record || now > record.until) {
      pairFailures.set(address, { count: 1, until: now + PAIR_WINDOW_MS });
      return;
    }
    record.count += 1;
  };

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.code(400).send({ error: 'invalid_body', issues: error.issues });
    }
    const err = error as Error & { statusCode?: number };
    request.log.error({ err }, 'request failed');
    return reply.code(err.statusCode ?? 500).send({ error: err.message });
  });

  // ── System ────────────────────────────────────────────────────────────────

  app.get('/api/v1/hub', async () => ({
    hubId: deps.hubId,
    name: deps.hubName,
    version: deps.version,
    apiVersion: 1,
    claimed: deps.pairing.claimed,
    // Additive: an app that doesn't know about this field ignores it, and one
    // that does can say "plug a coordinator in" instead of showing an empty
    // Zigbee section with no explanation.
    zigbee: {
      enabled: deps.zigbee !== undefined,
      connected: deps.zigbee?.connected ?? false,
    },
  }));

  app.post('/api/v1/pair', async (request, reply) => {
    const body = z
      .object({
        code: z.string().min(4).max(16),
        memberName: z.string().min(1).max(80),
        deviceName: z.string().max(120).optional(),
        // A client keeps this random value while retrying. It makes a response
        // lost to a slow Pi or a dropped connection recoverable, instead of
        // presenting a claim that already succeeded as a wrong code.
        claimId: z.uuid().optional(),
      })
      .parse(request.body);
    if (!pairAttemptAllowed(request.ip)) {
      return reply.code(429).send({ error: 'too_many_attempts' });
    }
    const result = await deps.pairing.claim(
      body.code,
      body.memberName,
      body.deviceName,
      body.claimId,
    );
    if (!result) {
      recordPairFailure(request.ip);
      return reply.code(401).send({ error: 'invalid_code' });
    }
    await deps.activity.record({
      kind: 'member.joined',
      message: `${result.member.name} joined the home.`,
      memberId: result.member.id,
    });
    return result;
  });

  // ── Home & rooms ─────────────────────────────────────────────────────────

  app.get('/api/v1/home', authed, async () => {
    const row = await deps.db.query.home.findFirst();
    return { id: row?.id ?? deps.hubId, name: row?.name ?? deps.hubName };
  });

  app.patch('/api/v1/home', ownerOnly, async (request) => {
    const body = z.object({ name: z.string().min(1).max(80) }).parse(request.body);
    const row = await deps.db.query.home.findFirst();
    if (row) await deps.db.update(home).set({ name: body.name }).where(eq(home.id, row.id));
    return { id: row?.id, name: body.name };
  });

  app.get('/api/v1/rooms', authed, async () => {
    const rows = await deps.db.query.rooms.findMany({ orderBy: (table, { asc }) => [asc(table.sortOrder)] });
    return rows.map((row) => ({ id: row.id, name: row.name, sortOrder: row.sortOrder }));
  });

  app.post('/api/v1/rooms', ownerOnly, async (request, reply) => {
    const body = z.object({ name: z.string().min(1).max(80), sortOrder: z.number().int().optional() }).parse(request.body);
    const [row] = await deps.db
      .insert(rooms)
      .values({ name: body.name, sortOrder: body.sortOrder ?? 0 })
      .returning();
    return reply.code(201).send({ id: row!.id, name: row!.name, sortOrder: row!.sortOrder });
  });

  app.patch('/api/v1/rooms/:id', ownerOnly, async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z
      .object({ name: z.string().min(1).max(80).optional(), sortOrder: z.number().int().optional() })
      .parse(request.body);
    const [row] = await deps.db.update(rooms).set(body).where(eq(rooms.id, id)).returning();
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return { id: row.id, name: row.name, sortOrder: row.sortOrder };
  });

  app.delete('/api/v1/rooms/:id', ownerOnly, async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    await deps.db.delete(rooms).where(eq(rooms.id, id));
    return reply.code(204).send();
  });

  // ── Devices & commands ───────────────────────────────────────────────────

  app.get('/api/v1/devices', authed, async () => deps.registry.listDevices().map(deviceWire));

  app.patch('/api/v1/devices/:id', authed, async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z
      .object({
        name: z.string().min(1).max(80).optional(),
        roomId: z.uuid().nullable().optional(),
        favorite: z.boolean().optional(),
      })
      .parse(request.body);
    // Renaming and room assignment shape the shared home — owner only.
    if ((body.name !== undefined || body.roomId !== undefined) && request.member?.role !== 'owner') {
      return reply.code(403).send({ error: 'owner_only' });
    }
    const device = await deps.registry.updateDevice(id, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.roomId !== undefined ? { roomId: body.roomId } : {}),
      ...(body.favorite !== undefined ? { favorite: body.favorite } : {}),
    });
    if (!device) return reply.code(404).send({ error: 'not_found' });
    return deviceWire(device);
  });

  app.delete('/api/v1/devices/:id', ownerOnly, async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const removed = await deps.registry.removeDevice(id);
    if (!removed) return reply.code(404).send({ error: 'not_found' });
    return reply.code(204).send();
  });

  app.post('/api/v1/devices/:id/endpoints/:endpointId/commands', authed, async (request, reply) => {
    const params = z
      .object({ id: z.uuid(), endpointId: z.coerce.number().int().min(0) })
      .parse(request.params);
    // zod's optional-field inference vs exactOptionalPropertyTypes: same shape.
    const command = commandSchema.parse(request.body) as import('../schema/index.js').HubCommand;
    const device = deps.registry.getDevice(params.id);
    if (!device) return reply.code(404).send({ error: 'not_found' });
    try {
      await deps.registry.execute(params.id, params.endpointId, command);
    } catch (error) {
      return reply.code(409).send({ error: (error as Error).message });
    }
    await deps.activity.record({
      kind: 'device.command',
      message: `${request.member!.name} · ${device.name}: ${command.type}`,
      deviceId: device.id,
      memberId: request.member!.id,
    });
    return reply.code(202).send({ accepted: true });
  });

  app.post('/api/v1/devices/:id/remap', ownerOnly, async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const device = deps.registry.getDevice(id);
    if (!device) return reply.code(404).send({ error: 'not_found' });
    if (device.adapter !== 'zigbee' || !deps.zigbee) {
      return reply.code(409).send({ error: 'remap_only_for_zigbee' });
    }
    const ok = await deps.zigbee.remap(device.externalId);
    return { requested: ok };
  });

  // ── Matter commissioning & Zigbee joining ────────────────────────────────

  app.post('/api/v1/matter/commission', ownerOnly, async (request, reply) => {
    if (!deps.matter) return reply.code(409).send({ error: 'matter_disabled' });
    const body = z.object({ pairingCode: z.string().min(8).max(128) }).parse(request.body);
    const job: CommissionJob = { id: randomUUID(), status: 'running' };
    commissionJobs.set(job.id, job);
    deps.events.emit('commissioningProgress', job.id, 'running');
    void deps
      .matter!.commission(body.pairingCode)
      .then((nodeId) => {
        job.status = 'done';
        job.nodeId = nodeId;
        deps.events.emit('commissioningProgress', job.id, 'done', nodeId);
      })
      .catch((error: Error) => {
        job.status = 'failed';
        job.error = error.message;
        deps.events.emit('commissioningProgress', job.id, 'failed', error.message);
      })
      .finally(() => forgetJobLater(job.id));
    return reply.code(202).send({ jobId: job.id });
  });

  app.get('/api/v1/matter/commission/:jobId', authed, async (request, reply) => {
    const { jobId } = z.object({ jobId: z.uuid() }).parse(request.params);
    const job = commissionJobs.get(jobId);
    if (!job) return reply.code(404).send({ error: 'not_found' });
    return job;
  });

  app.post('/api/v1/zigbee/permit-join', ownerOnly, async (request, reply) => {
    if (!deps.zigbee) return reply.code(409).send({ error: 'zigbee_disabled' });
    const body = z.object({ seconds: z.number().int().min(0).max(254) }).parse(request.body);
    await deps.zigbee.permitJoin(body.seconds);
    deps.events.emit('permitJoin', body.seconds > 0, body.seconds);
    return { permitJoin: body.seconds > 0, seconds: body.seconds };
  });

  // ── Members, invites, activity ───────────────────────────────────────────

  app.get('/api/v1/members', authed, async () => {
    const rows = await deps.db.query.members.findMany();
    return rows.map((row) => ({ id: row.id, name: row.name, role: row.role, createdAt: row.createdAt }));
  });

  app.delete('/api/v1/members/:id', ownerOnly, async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const target = await deps.db.query.members.findFirst({ where: eq(members.id, id) });
    if (!target) return reply.code(404).send({ error: 'not_found' });
    if (target.role === 'owner') return reply.code(409).send({ error: 'cannot_remove_owner' });
    await deps.db.delete(members).where(eq(members.id, id));
    return reply.code(204).send();
  });

  app.get('/api/v1/invites', ownerOnly, async () => {
    const rows = await deps.db.query.invites.findMany();
    const now = Date.now();
    return rows
      .filter((row) => row.usedBy === null && row.expiresAt.getTime() > now)
      .map((row) => ({ id: row.id, role: row.role, expiresAt: row.expiresAt }));
  });

  app.post('/api/v1/invites', ownerOnly, async (request, reply) => {
    const invite = await deps.pairing.createInvite(request.member!.id);
    return reply.code(201).send(invite);
  });

  app.get('/api/v1/activity', authed, async (request) => {
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(50), before: z.coerce.number().int().optional() })
      .parse(request.query);
    const rows = await deps.activity.list(query.limit, query.before);
    return rows.map((row) => ({
      id: row.id,
      at: row.at.toISOString(),
      kind: row.kind,
      message: row.message,
      deviceId: row.deviceId,
      memberId: row.memberId,
    }));
  });

  // ── AI settings ──────────────────────────────────────────────────────────

  const aiSettingsResponse = async () => {
    const [ai, status] = await Promise.all([deps.settings.getAiSettings(), deps.settings.getAiStatus()]);
    return { ...ai, status };
  };

  app.get('/api/v1/settings/ai', ownerOnly, aiSettingsResponse);

  app.put('/api/v1/settings/ai', ownerOnly, async (request) => {
    const body = z
      .object({
        // Anthropic is the only provider — tolerated for older clients.
        provider: z.literal('anthropic').optional(),
        authType: z.enum(['api_key', 'oauth_token']).default('api_key'),
        model: z.string().min(1).max(120).nullable().optional(),
        // An Anthropic API key or a Claude subscription OAuth token
        // (`claude setup-token`) — write-only, stored encrypted.
        apiKey: z.string().min(8).max(4000),
      })
      .parse(request.body);
    await deps.settings.setAiSettings({
      authType: body.authType,
      model: body.model ?? null,
      apiKey: body.apiKey,
    });
    return aiSettingsResponse();
  });

  app.delete('/api/v1/settings/ai', ownerOnly, async (_request, reply) => {
    await deps.settings.clearAiSettings();
    return reply.code(204).send();
  });

  // ── WebSocket event stream ───────────────────────────────────────────────

  app.get('/api/v1/ws', { websocket: true }, (socket, request) => {
    // Subscribe synchronously, before the async token check, so an event
    // fired the moment the socket opens is buffered instead of lost in the
    // gap between "connected" and "authorized".
    const handle = attachWebSocket(socket, deps);
    void (async () => {
      const token = extractToken(request);
      const member = token ? await deps.pairing.verifyToken(token) : null;
      if (!member) {
        handle.close();
        socket.close(4001, 'unauthorized');
        return;
      }
      handle.authorize();
    })();
  });

  return app;
}
