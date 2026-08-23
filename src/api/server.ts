import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { randomUUID } from 'node:crypto';
import { eq, max } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { invites, members, rooms, zones } from '../db/schema.js';
import type { DeviceRegistry } from '../core/registry.js';
import type { PairingService } from '../core/pairing.js';
import type { ActivityService } from '../core/activity.js';
import type { HomeService } from '../core/home.js';
import type { FavoritesService } from '../core/favorites.js';
import type { SettingsService } from '../core/settings.js';
import type { HomeStructure, HubEventBus } from '../core/bus.js';
import type { Logger } from '../logging.js';
import { commandSchema } from '../schema/index.js';
import type { MatterAdapter } from '../adapters/matter/adapter.js';
import type { ZigbeeAdapter } from '../adapters/zigbee/adapter.js';
// Dependency-free model catalog (a price table and an allowlist) — importing
// it here does not pull the AI stack into the API layer.
import { isSupportedModel, supportedModelIds } from '../ai/models.js';
// Local operations on stored JSON — zod only, no Anthropic SDK in this graph.
// `MappingLibrary.repair` loads the agent on demand.
import type { MappingLibrary } from '../ai/library.js';
import type { AiRunLog } from '../core/ai-runs.js';
import { RADIO_MODES, writeRadioMode, type RadioBudget, type RadioMode } from '../core/radio.js';
import type { MqttObserver } from '../core/mqtt-observer.js';
import { MAX_WINDOW_SECONDS, type PermitJoinService } from '../core/permit-join.js';
import { createHubStatusReader } from '../core/hub-status.js';
import { deviceWire } from './dto.js';
import { extractToken, requireMember, requireOwner } from './auth.js';
import { attachWebSocket, MemberSessions, UNAUTHORIZED_CLOSE_CODE } from './ws.js';

export interface ApiDeps {
  db: Db;
  log: Logger;
  events: HubEventBus;
  registry: DeviceRegistry;
  /** Who has pinned what — favorites are per member, not per home. */
  favorites: FavoritesService;
  pairing: PairingService;
  activity: ActivityService;
  settings: SettingsService;
  /**
   * The hub's name, and the one place it lives. `GET /hub`, `GET /home` and the
   * WebSocket hello all read it from here, so a rename cannot move one of them
   * and leave the others behind — see `core/home.ts`.
   */
  home: HomeService;
  hubId: string;
  version: string;
  /** CI's build stamp, when this install came from a published bundle. */
  build?: string;
  /** Present when the corresponding adapter is enabled and running. */
  matter?: MatterAdapter;
  zigbee?: ZigbeeAdapter;
  /** Where the owner's radio choice is stored, and how many radios fit. */
  dataDir: string;
  radioBudget: RadioBudget;
  /** Zigbee2MQTT's data directory — read only to say *why* Zigbee is down. */
  z2mDataDir: string;
  /**
   * The broker tap behind the apps' traffic inspector. Absent when the MQTT
   * adapter is off, in which case the `mqtt` WebSocket stream is simply not
   * advertised — the socket says what it can offer rather than failing a
   * subscription the client had no way to know about.
   */
  mqttObserver?: MqttObserver;
  /** Owns the Zigbee join window and its countdown. */
  permitJoin: PermitJoinService;
  /** What the mapping agent did — one row per run. */
  aiRuns: AiRunLog;
  /** Every device model this hub knows how to interpret. */
  mappings: MappingLibrary;
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
 * What a member may be called — one rule, wherever a name arrives.
 *
 * `.trim()` runs before the length checks, so " " is a 400 and not a member
 * nobody can identify in a list. 80 characters is what `PATCH /home` and the
 * device names already allow; a name is a label in a list, not a sentence.
 */
const memberNameSchema = z.string().trim().min(1).max(80);

/** A device model's identity in the mapping library: a sha256 hex digest. */
const hashParam = z.object({ exposesHash: z.string().regex(/^[0-9a-f]{64}$/) });

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
  /**
   * Who is holding a live event stream, so removing them can hang it up.
   *
   * Owned by the server rather than injected: the sockets belong to this
   * instance, and a registry outliving it would be a registry of dead ones.
   */
  const sessions = new MemberSessions();

  /**
   * Why an explicitly requested agent run must not start, or `null` to go
   * ahead. Two reasons, and they need different words in the app: a hub with
   * no credential has never been able to do this, while one whose owner turned
   * adaptation off is being obeyed.
   */
  const aiUnavailableReason = async (): Promise<'ai_not_configured' | 'ai_disabled' | null> => {
    const ai = await deps.settings.getAiSettings();
    if (!ai.hasKey) return 'ai_not_configured';
    if (!ai.enabled) return 'ai_disabled';
    return null;
  };

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

  /**
   * Zigbee's state, and — when it is down — why.
   *
   * `connected: false` is a fact with several very different causes behind it,
   * and the answer used to live only in a log on the machine. That is the wrong
   * place: the person who needs it is looking at an app somewhere else. The hub
   * can read Zigbee2MQTT's own log (same service account, no privileges) so it
   * does, and every app gets the reason for free.
   *
   * Cached, and only consulted while Zigbee is actually down. `GET /hub` is
   * public and unauthenticated, so it must not turn into a file read per
   * request — and a failure that has just been diagnosed does not change from
   * one second to the next.
   */
  const hubStatus = createHubStatusReader(deps);

  app.get('/api/v1/hub', async () => ({
    hubId: deps.hubId,
    // The home's name. One hub hosts one home, so a hub with a name of its own
    // was only ever a second place for the same fact to go stale — this route
    // and `GET /home` answer the same string, and `PATCH /home` moves both.
    name: deps.home.name,
    version: deps.version,
    // Additive. `version` moves once per release; this identifies the exact
    // build, which is what someone asking "did my update land?" needs.
    ...(deps.build ? { build: deps.build } : {}),
    apiVersion: 1,
    claimed: deps.pairing.claimed,
    // Additive: an app that doesn't know about this field ignores it, and one
    // that does can say "plug a coordinator in" instead of showing an empty
    // Zigbee section with no explanation.
    // `zigbee` and `radio` are additive, and are the same two blocks the
    // `hubStatus` WebSocket frame pushes when they change — one snapshot,
    // taken in one place, so a client cannot be told two different things
    // depending on which arrived first.
    ...hubStatus.snapshot(),
  }));

  app.post('/api/v1/pair', async (request, reply) => {
    const body = z
      .object({
        code: z.string().min(4).max(16),
        // Trimmed before it is measured, so a name that is only whitespace is
        // refused rather than stored — the client's own tidying is not
        // something this can assume, and a blank member row is unfixable from
        // any app: it has nothing to click on.
        memberName: memberNameSchema,
        deviceName: z.string().trim().max(120).optional(),
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
      data: { memberName: result.member.name },
    });
    return result;
  });

  // ── Home & rooms ─────────────────────────────────────────────────────────

  app.get('/api/v1/home', authed, async () => deps.home.snapshot());

  /**
   * Rename the home — which renames the hub, because they are the same thing.
   *
   * The new name reaches `GET /hub` (public, so Studio's hub list sees it
   * without a token), the WebSocket hello, and the mDNS advertisement, without
   * touching root-owned config and without a restart. Nothing else about the
   * hub changes: the id is minted on the machine's own disk and is what devices,
   * tokens and saved hubs are keyed by.
   *
   * Trimmed before it is measured, so a name of spaces is refused rather than
   * stored — `min(1)` on an untrimmed string accepts "   " and every screen
   * showing it then has a hub with no name.
   */
  app.patch('/api/v1/home', ownerOnly, async (request) => {
    const body = z.object({ name: z.string().trim().min(1).max(80) }).parse(request.body);
    const result = await deps.home.rename(body.name);
    await deps.activity.record({
      kind: 'home.renamed',
      message: `${request.member!.name} renamed the home to “${body.name}”.`,
      memberId: request.member!.id,
      data: { homeName: body.name, memberName: request.member!.name },
    });
    return result;
  });

  /**
   * The shape of the home, as `GET /rooms` + `GET /zones` would answer it.
   *
   * One read, because every mutation below broadcasts both lists: a room that
   * moved between zones changes a room row and nothing else, but the client
   * redraws its zone sections from the pair, and sending half of it would make
   * every app hold the other half from memory.
   */
  const readStructure = async (): Promise<HomeStructure> => {
    const [roomRows, zoneRows] = await Promise.all([
      deps.db.query.rooms.findMany({ orderBy: (table, { asc }) => [asc(table.sortOrder)] }),
      deps.db.query.zones.findMany({ orderBy: (table, { asc }) => [asc(table.sortOrder)] }),
    ]);
    return {
      rooms: roomRows.map((row) => ({
        id: row.id,
        name: row.name,
        zoneId: row.zoneId,
        icon: row.icon,
        accent: row.accent,
        sortOrder: row.sortOrder,
      })),
      zones: zoneRows.map((row) => ({ id: row.id, name: row.name, sortOrder: row.sortOrder })),
    };
  };

  /**
   * Tell every open socket what the home looks like now.
   *
   * Rooms are shared, so one person adding one has to reach the other phones
   * without them reconnecting — which, before this, was the only thing that
   * ever re-read them.
   */
  const announceStructure = async (): Promise<HomeStructure> => {
    const structure = await readStructure();
    deps.events.emit('structureChanged', structure);
    return structure;
  };

  /**
   * A room or zone name, with one rule in one place.
   *
   * Trimmed before it is measured, exactly like a member's name and the home's:
   * `min(1)` on an untrimmed string accepts "   " and leaves a room nobody can
   * point at in a list.
   */
  const placeNameSchema = z.string().trim().min(1).max(80);

  /**
   * A glyph or palette token — an app's own vocabulary, kept opaque here.
   *
   * Nullable *and* optional, and the two mean different things: leaving the
   * field out keeps whatever the room has, while `null` puts the room back to
   * the look the app derives from its name. Bounded rather than checked
   * against a list, because the list belongs to the apps — see `schema.ts`.
   */
  const lookTokenSchema = z.string().trim().min(1).max(40).nullable().optional();

  // Rooms and zones are the shape of a shared home, and **any member may change
  // them.** They were owner-only, which sounds careful and in practice was not:
  // GetHome Studio claims a hub as *the Mac*, so the owner is usually a laptop
  // in a drawer and every phone in the house joins by invite as a plain member.
  // That made "add a room" a button nobody who lives there could press. What
  // the rule really guards is who may take things away — removing a device or a
  // member is still the owner's — and every edit here is written to the
  // activity log with the name of whoever made it.

  /** One shape for a room, so the two routes that answer with one can't drift. */
  const roomWire = (row: typeof rooms.$inferSelect) => ({
    id: row.id,
    name: row.name,
    zoneId: row.zoneId,
    icon: row.icon,
    accent: row.accent,
    sortOrder: row.sortOrder,
  });

  app.get('/api/v1/rooms', authed, async () => (await readStructure()).rooms);

  app.post('/api/v1/rooms', authed, async (request, reply) => {
    const body = z
      .object({
        name: placeNameSchema,
        zoneId: z.uuid().nullable().optional(),
        icon: lookTokenSchema,
        accent: lookTokenSchema,
        sortOrder: z.number().int().optional(),
      })
      .parse(request.body);
    if (body.zoneId && !(await zoneExists(body.zoneId))) {
      return reply.code(404).send({ error: 'unknown_zone' });
    }
    const [row] = await deps.db
      .insert(rooms)
      .values({
        name: body.name,
        zoneId: body.zoneId ?? null,
        icon: body.icon ?? null,
        accent: body.accent ?? null,
        sortOrder: body.sortOrder ?? (await nextSortOrder(rooms)),
      })
      .returning();
    await deps.activity.record({
      kind: 'room.added',
      message: `${request.member!.name} added the room “${body.name}”.`,
      memberId: request.member!.id,
    });
    await announceStructure();
    return reply.code(201).send(roomWire(row!));
  });

  app.patch('/api/v1/rooms/:id', authed, async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z
      .object({
        name: placeNameSchema.optional(),
        // `null` is "no zone", which is a real answer and not the same as
        // leaving the field out — hence nullable *and* optional.
        zoneId: z.uuid().nullable().optional(),
        icon: lookTokenSchema,
        accent: lookTokenSchema,
        sortOrder: z.number().int().optional(),
      })
      .parse(request.body);
    const before = await deps.db.query.rooms.findFirst({ where: eq(rooms.id, id) });
    if (!before) return reply.code(404).send({ error: 'not_found' });
    if (body.zoneId && !(await zoneExists(body.zoneId))) {
      return reply.code(404).send({ error: 'unknown_zone' });
    }
    const [row] = await deps.db
      .update(rooms)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.zoneId !== undefined ? { zoneId: body.zoneId } : {}),
        ...(body.icon !== undefined ? { icon: body.icon } : {}),
        ...(body.accent !== undefined ? { accent: body.accent } : {}),
        ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
      })
      .where(eq(rooms.id, id))
      .returning();
    if (!row) return reply.code(404).send({ error: 'not_found' });
    if (body.name !== undefined && body.name !== before.name) {
      await deps.activity.record({
        kind: 'room.renamed',
        message: `${request.member!.name} renamed “${before.name}” to “${body.name}”.`,
        memberId: request.member!.id,
      });
    }
    // A rename is logged and a restyle is not, deliberately: the activity log
    // is read a week later, and "somebody changed the kitchen's colour" is not
    // what anyone is looking for in it. The structure frame below still tells
    // every open app about it immediately.
    await announceStructure();
    return roomWire(row);
  });

  /**
   * Delete a room. Its devices are not deleted — they are simply in no room.
   *
   * `rooms.id` is `ON DELETE SET NULL` on the device row, so the database has
   * already done that by the time this returns; `registry.clearRoom` is what
   * stops the in-memory cache from serving a `roomId` pointing at a room that
   * is gone, and moves those cards in every app that is watching.
   */
  app.delete('/api/v1/rooms/:id', authed, async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const room = await deps.db.query.rooms.findFirst({ where: eq(rooms.id, id) });
    if (!room) return reply.code(404).send({ error: 'not_found' });
    await deps.db.delete(rooms).where(eq(rooms.id, id));
    deps.registry.clearRoom(id);
    await deps.activity.record({
      kind: 'room.removed',
      message: `${request.member!.name} removed the room “${room.name}”.`,
      memberId: request.member!.id,
    });
    await announceStructure();
    return reply.code(204).send();
  });

  /**
   * Zones: the optional layer above rooms — "Upstairs", "Garden", "Guest
   * house". A room belongs to one or to none, and none is the ordinary case.
   *
   * Deliberately not called floors. A flat has no floors and a garage isn't
   * one, so a *floor* field invites every home that isn't a house to leave it
   * blank or to lie in it; a zone that happens to be called "Second floor"
   * covers the house perfectly. It is also Apple Home's word (`HMZone`), and
   * the GetHome app shows Apple Homes beside hub homes.
   */
  app.get('/api/v1/zones', authed, async () => (await readStructure()).zones);

  app.post('/api/v1/zones', authed, async (request, reply) => {
    const body = z
      .object({ name: placeNameSchema, sortOrder: z.number().int().optional() })
      .parse(request.body);
    const [row] = await deps.db
      .insert(zones)
      .values({ name: body.name, sortOrder: body.sortOrder ?? (await nextSortOrder(zones)) })
      .returning();
    await deps.activity.record({
      kind: 'zone.added',
      message: `${request.member!.name} added the zone “${body.name}”.`,
      memberId: request.member!.id,
    });
    await announceStructure();
    return reply.code(201).send({ id: row!.id, name: row!.name, sortOrder: row!.sortOrder });
  });

  app.patch('/api/v1/zones/:id', authed, async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z
      .object({ name: placeNameSchema.optional(), sortOrder: z.number().int().optional() })
      .parse(request.body);
    const before = await deps.db.query.zones.findFirst({ where: eq(zones.id, id) });
    if (!before) return reply.code(404).send({ error: 'not_found' });
    const [row] = await deps.db
      .update(zones)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
      })
      .where(eq(zones.id, id))
      .returning();
    if (!row) return reply.code(404).send({ error: 'not_found' });
    // Logged like a room's rename, and for the same reason: a zone's name is
    // copied onto every room in it in the apps, so this moves what other
    // people see. Adding, renaming and removing a place are the three things
    // in this file that change the home's shape and all three say so.
    if (body.name !== undefined && body.name !== before.name) {
      await deps.activity.record({
        kind: 'zone.renamed',
        message: `${request.member!.name} renamed the zone “${before.name}” to “${body.name}”.`,
        memberId: request.member!.id,
      });
    }
    await announceStructure();
    return { id: row.id, name: row.name, sortOrder: row.sortOrder };
  });

  /**
   * Delete a zone. The rooms in it survive and belong to no zone — deleting
   * "Upstairs" must never be a way to lose a bedroom.
   *
   * The rooms are emptied here rather than by the foreign key, because SQLite
   * cannot attach `ON DELETE SET NULL` to a column added by `ALTER TABLE` and
   * rebuilding the table to get one would empty every *room* of its devices on
   * the way past (`db/schema.ts` has the whole story). The plain foreign key is
   * still there underneath: forget this line and the delete fails loudly rather
   * than leaving rooms pointing at a zone that has gone.
   */
  app.delete('/api/v1/zones/:id', authed, async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const zone = await deps.db.query.zones.findFirst({ where: eq(zones.id, id) });
    if (!zone) return reply.code(404).send({ error: 'not_found' });
    await deps.db.update(rooms).set({ zoneId: null }).where(eq(rooms.zoneId, id));
    await deps.db.delete(zones).where(eq(zones.id, id));
    await deps.activity.record({
      kind: 'zone.removed',
      message: `${request.member!.name} removed the zone “${zone.name}”.`,
      memberId: request.member!.id,
    });
    await announceStructure();
    return reply.code(204).send();
  });

  const zoneExists = async (id: string): Promise<boolean> =>
    (await deps.db.query.zones.findFirst({ where: eq(zones.id, id) })) !== undefined;

  /**
   * Put a new room or zone at the end rather than at the top.
   *
   * `sortOrder` defaulted to 0 for everything, so a home whose rooms had never
   * been ordered by hand listed them in whatever order SQLite happened to
   * return — and a room added today could appear above one added last year.
   */
  const nextSortOrder = async (table: typeof rooms | typeof zones): Promise<number> => {
    const [row] = await deps.db.select({ highest: max(table.sortOrder) }).from(table);
    return (row?.highest ?? -1) + 1;
  };

  // ── Devices & commands ───────────────────────────────────────────────────

  app.get('/api/v1/devices', authed, async (request) => {
    const memberId = request.member!.id;
    return deps.registry
      .listDevices()
      .map((device) => deviceWire(device, deps.favorites.isFavorite(memberId, device.id)));
  });

  /**
   * Rename a device, move it to another room, or pin it.
   *
   * Two different kinds of change share this route, and they are stored in two
   * different places. A **name and a room describe the house**: they are one
   * value on the device row, everybody sees the same one, and any member may
   * change it — a device called "0x54ef44100047c1bf" is unusable for whoever is
   * standing in front of it, and the person who can fix that is rarely the one
   * who happens to hold the owner token. A **favorite describes a person**: it
   * is stored per member (`core/favorites.ts`), so pinning the kettle puts it
   * on the caller's dashboard and on nobody else's.
   *
   * The response is this caller's view, which is what makes that invisible to
   * an app: the field is still `favorite`, and it is still a boolean.
   */
  app.patch('/api/v1/devices/:id', authed, async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z
      .object({
        name: z.string().trim().min(1).max(80).optional(),
        roomId: z.uuid().nullable().optional(),
        favorite: z.boolean().optional(),
      })
      .parse(request.body);
    const memberId = request.member!.id;
    const before = deps.registry.getDevice(id);
    if (!before) return reply.code(404).send({ error: 'not_found' });
    if (body.roomId && !(await roomExists(body.roomId))) {
      return reply.code(404).send({ error: 'unknown_room' });
    }
    // Copied out *now*, because `updateDevice` mutates this very object and
    // hands it back — reading `before.name` after the call reads the new name,
    // and the "did anything change?" tests below would all answer no.
    const previousName = before.name;
    const previousRoomId = before.roomId;

    if (body.favorite !== undefined) {
      await deps.favorites.set(memberId, id, body.favorite);
    }

    const device =
      body.name !== undefined || body.roomId !== undefined
        ? await deps.registry.updateDevice(id, {
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.roomId !== undefined ? { roomId: body.roomId } : {}),
          })
        : before;
    if (!device) return reply.code(404).send({ error: 'not_found' });

    if (body.name !== undefined && body.name !== previousName) {
      await deps.activity.record({
        kind: 'device.renamed',
        message: `${request.member!.name} renamed “${previousName}” to “${body.name}”.`,
        deviceId: device.id,
        memberId,
      });
    }
    if (body.roomId !== undefined && body.roomId !== previousRoomId) {
      const room = body.roomId
        ? await deps.db.query.rooms.findFirst({ where: eq(rooms.id, body.roomId) })
        : undefined;
      await deps.activity.record({
        kind: 'device.moved',
        message: room
          ? `${request.member!.name} moved ${device.name} to ${room.name}.`
          : `${request.member!.name} took ${device.name} out of its room.`,
        deviceId: device.id,
        memberId,
      });
    }
    return deviceWire(device, deps.favorites.isFavorite(memberId, id));
  });

  const roomExists = async (id: string): Promise<boolean> =>
    (await deps.db.query.rooms.findFirst({ where: eq(rooms.id, id) })) !== undefined;

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
      // The whole command, not a summary of it: it is schema-bounded (the
      // largest is a 400-character custom field) and it is what lets an app
      // write "Turned on" instead of "power". The two names ride along
      // because both ids are `ON DELETE SET NULL` — a week later this row may
      // be all that is left of the device.
      data: { command, deviceName: device.name, memberName: request.member!.name },
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
    // Off means off, including when a person asks by hand. Saying so is what
    // keeps an app from drawing a button whose only outcome is silence.
    const refusal = await aiUnavailableReason();
    if (refusal) return reply.code(409).send({ error: refusal });
    const ok = await deps.zigbee.remap(device.externalId);
    return { requested: ok };
  });

  // ── Matter commissioning & Zigbee joining ────────────────────────────────

  /**
   * **Any member, not just the owner** — see the note on permit-join below;
   * the two are one rule and pairing a device is not the shape of the home.
   */
  app.post('/api/v1/matter/commission', authed, async (request, reply) => {
    if (!deps.matter) return reply.code(409).send({ error: 'matter_disabled' });
    const body = z.object({ pairingCode: z.string().min(8).max(128) }).parse(request.body);
    // Recorded on the *request*, not on the result: the hub's log is what was
    // asked for, and the accessory's own arrival is the registry's
    // `device.added` a moment later. The pairing code never goes in — it is a
    // credential for the accessory, and this log is read by every member.
    await deps.activity.record({
      kind: 'matter.commission',
      message: `${request.member!.name} started pairing a Matter accessory.`,
      memberId: request.member!.id,
      data: { memberName: request.member!.name },
    });
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

  /**
   * Open (or close, with 0) the Zigbee network for joining.
   *
   * **Any member, not just the owner.** Owner-only is for the *shape* of the
   * home — who is in it, what the rooms are, removing a device somebody else
   * relies on. Adding one is not that: a member is somebody the owner invited
   * into their home, and a home where the second phone cannot pair the lamp it
   * is standing next to is a home with a support call in it. The window is
   * bounded and self-closing either way, and every open is in the activity log
   * with the member's name on it.
   *
   * The ceiling used to be 254 — the most a *single* grant can last, which is
   * a fact about the Zigbee protocol rather than about what a person needs.
   * `PermitJoinService` makes a longer window out of several grants, so the
   * limit here is a policy one: long enough to walk to a device and reset it,
   * short enough that "open forever" is never an accident.
   *
   * The reply reports the *live* window, not the request, because Zigbee2MQTT
   * may already have had one open.
   */
  app.post('/api/v1/zigbee/permit-join', authed, async (request, reply) => {
    if (!deps.zigbee) return reply.code(409).send({ error: 'zigbee_disabled' });
    const body = z
      .object({ seconds: z.number().int().min(0).max(MAX_WINDOW_SECONDS) })
      .parse(request.body);
    const state = await deps.permitJoin.open(body.seconds);
    // Opening a home's network to strangers for a few minutes is the one
    // moment it accepts them, and it is now any member's to do — so it is
    // recorded with the name of whoever did it, the way a command is. The
    // *live* window is what gets logged, not the request: Zigbee2MQTT may
    // already have had one open and is the authority on this.
    await deps.activity.record(
      state.active
        ? {
            kind: 'zigbee.permit-join',
            message: `${request.member!.name} opened the Zigbee network for ${Math.round(state.remainingSeconds / 60)} min.`,
            memberId: request.member!.id,
            data: { memberName: request.member!.name, seconds: state.remainingSeconds },
          }
        : {
            kind: 'zigbee.permit-join-closed',
            message: `${request.member!.name} closed the Zigbee network.`,
            memberId: request.member!.id,
            data: { memberName: request.member!.name },
          },
    );
    return { permitJoin: state.active, seconds: state.remainingSeconds };
  });

  // ── Members, invites, activity ───────────────────────────────────────────

  app.get('/api/v1/members', authed, async (request) => {
    const rows = await deps.db.query.members.findMany();
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      role: row.role,
      createdAt: row.createdAt,
      // Which of these is the caller. Additive, and the only way an app can
      // answer it: the member id is returned once, by `POST /pair`, and the
      // hub's own `gethome-hubctl claim` prints the hub id and the token and
      // nothing else — so a Mac that claimed its hub over SSH could not find
      // itself in a list of names it is standing in.
      isSelf: row.id === request.member!.id,
    }));
  });

  /**
   * Rename yourself.
   *
   * `me` rather than an id because the caller usually does not know its own:
   * see `isSelf` above. The token already says who this is, so asking for the
   * id as well would only add a way to get it wrong.
   *
   * Any member may do it — the owner-only rule guards the shape of the home
   * (its rooms, its devices, who is in it), and what somebody calls themselves
   * is none of that. Renaming *another* member is not offered at all: it is
   * the one member operation nobody has needed, and an owner who wants a
   * member gone already has `DELETE`.
   */
  app.patch('/api/v1/members/me', authed, async (request) => {
    const body = z.object({ name: memberNameSchema }).parse(request.body);
    const before = request.member!;
    if (body.name !== before.name) {
      await deps.db.update(members).set({ name: body.name }).where(eq(members.id, before.id));
      await deps.activity.record({
        kind: 'member.renamed',
        message: `${before.name} is now called ${body.name}.`,
        memberId: before.id,
        data: { memberName: body.name },
      });
    }
    return { id: before.id, name: body.name, role: before.role };
  });

  /**
   * Leave the home — the mirror of `PATCH /members/me`, and `me` for the same
   * reason: the token is the identity, and most callers never learn their own
   * id. Any member may do it, because leaving is the one decision about a
   * member that is entirely their own.
   *
   * The owner may not. There is no ownership transfer, so a home whose owner
   * walked out is one nobody can ever invite to, remove from, or configure
   * again — the same refusal, in the same words, as removing the owner by id.
   * An owner who is finished with a hub is finished with the hub, and that is
   * `gethome-hubctl` on the machine, not a route.
   */
  app.delete('/api/v1/members/me', authed, async (request, reply) => {
    const member = request.member!;
    if (member.role === 'owner') return reply.code(409).send({ error: 'cannot_remove_owner' });
    await deps.db.delete(members).where(eq(members.id, member.id));
    await endMembership(member.id, `${member.name} left the home.`, 'member.left');
    return reply.code(204).send();
  });

  app.delete('/api/v1/members/:id', ownerOnly, async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const target = await deps.db.query.members.findFirst({ where: eq(members.id, id) });
    if (!target) return reply.code(404).send({ error: 'not_found' });
    if (target.role === 'owner') return reply.code(409).send({ error: 'cannot_remove_owner' });
    await deps.db.delete(members).where(eq(members.id, id));
    await endMembership(
      target.id,
      `${request.member!.name} removed ${target.name} from the home.`,
      'member.removed',
    );
    return reply.code(204).send();
  });

  /**
   * Finish ending a membership: hang up on the member, then write it down.
   *
   * **Sockets first, and that ordering is the point.** Deleting the row takes
   * the member's tokens with it (`tokens.member_id` cascades, and this hub
   * runs with `foreign_keys = ON`), which ends every REST call they can
   * make — but a WebSocket authorizes once, when it opens, so the connection
   * they are already holding would have carried on streaming device state
   * until it happened to drop. `sessions.revoke` closes it with the same code
   * an unauthorized socket gets, because it means the same thing and clients
   * already know to stop reconnecting on it. Doing that *before* the activity
   * record is what stops the departing member receiving, as their last frame,
   * the announcement of their own departure.
   *
   * The entry carries **no `memberId`**, deliberately twice over.
   * `activity.member_id` is a foreign key, so naming a member who has just
   * been deleted fails the insert outright — and naming one about to be
   * deleted would be nulled by the cascade a moment later anyway. And a
   * departure is the one entry whose subject can never be looked up
   * afterwards, so the name belongs in the sentence, which is where a person
   * reading the log next week will look for it.
   */
  async function endMembership(
    memberId: string,
    message: string,
    kind: 'member.left' | 'member.removed',
  ) {
    const closed = sessions.revoke(memberId);
    if (closed > 0) deps.log.info({ memberId, closed }, 'Closed event streams for a former member');
    // Their pins went with the member row (`device_favorites.member_id`
    // cascades); this is the in-memory half of the same delete.
    deps.favorites.forgetMember(memberId);
    await deps.activity.record({ kind, message });
  }

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
      // Same field the `activity` WebSocket frame carries, so a client that
      // reads the backlog and then follows the stream renders both alike.
      data: row.data ?? null,
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
        // Older apps sent authType: "api_key" | "oauth_token". Subscription
        // tokens can no longer authenticate the Messages API, so the field is
        // accepted and ignored rather than 400-ing an app that hasn't shipped
        // an update yet — the key check below is what actually catches one.
        authType: z.string().optional(),
        model: z
          .string()
          .min(1)
          .max(120)
          .refine(isSupportedModel, {
            message: `unsupported model — the mapping agent runs on: ${supportedModelIds().join(', ')}`,
          })
          .nullable()
          .optional(),
        // An Anthropic API key — write-only, stored encrypted.
        apiKey: z
          .string()
          .min(8)
          .max(4000)
          .refine((key) => !key.trim().startsWith('sk-ant-oat'), {
            message:
              'that is a Claude subscription token; the hub needs an Anthropic API key (sk-ant-api…) from platform.claude.com',
          }),
      })
      .parse(request.body);
    await deps.settings.setAiSettings({
      model: body.model ?? null,
      apiKey: body.apiKey,
    });
    return aiSettingsResponse();
  });

  /**
   * Turn AI adaptation on or off, or change the model, without re-entering the
   * key.
   *
   * `PUT` requires an `apiKey`, so the only way to stop the agent running used
   * to be `DELETE` — which is a different request. "Stop spending my money on
   * this for now" and "forget my credential" have very different costs to
   * undo, and an owner who wanted the first had to pay the second.
   */
  app.patch('/api/v1/settings/ai', ownerOnly, async (request) => {
    const body = z
      .object({
        enabled: z.boolean().optional(),
        model: z
          .string()
          .min(1)
          .max(120)
          .refine(isSupportedModel, {
            message: `unsupported model — the mapping agent runs on: ${supportedModelIds().join(', ')}`,
          })
          .nullable()
          .optional(),
      })
      .parse(request.body);
    if (body.enabled !== undefined) await deps.settings.setAiEnabled(body.enabled);
    if (body.model !== undefined) await deps.settings.setAiModel(body.model);
    return aiSettingsResponse();
  });

  app.delete('/api/v1/settings/ai', ownerOnly, async (_request, reply) => {
    await deps.settings.clearAiSettings();
    return reply.code(204).send();
  });

  /**
   * What the mapping agent did, most recent first.
   *
   * Owner-only because it names device models and costs money, and because
   * `GET /settings/ai` — the other half of the same answer — already is.
   */
  app.get('/api/v1/ai/runs', ownerOnly, async (request) => {
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(100).default(30) })
      .parse(request.query);
    const rows = await deps.aiRuns.list(query.limit);
    return rows.map((row) => ({
      id: row.id,
      at: row.at.toISOString(),
      kind: row.kind,
      adapter: row.adapter,
      vendor: row.vendor,
      model: row.model,
      exposesHash: row.exposesHash,
      modelId: row.modelId,
      ok: row.ok,
      costUsd: row.costUsd,
      turns: row.turns,
      durationMs: row.durationMs,
      errorKind: row.errorKind,
      errorMessage: row.errorMessage,
      steps: row.steps,
    }));
  });

  // ── The device-mapping library ───────────────────────────────────────────

  /**
   * Every device model this hub knows how to interpret.
   *
   * The cache behind it has existed since AI adaptation shipped, and was
   * invisible: there was no way to see what the hub had learned, to carry it
   * to another hub, or to fix an entry that was nearly right. These five
   * routes are that, and only `repair` needs a credential.
   */
  app.get('/api/v1/device-mappings', ownerOnly, async () => deps.mappings.list());

  app.get('/api/v1/device-mappings/:exposesHash', ownerOnly, async (request, reply) => {
    const { exposesHash } = hashParam.parse(request.params);
    const envelope = await deps.mappings.get(exposesHash);
    if (!envelope) return reply.code(404).send({ error: 'not_found' });
    return envelope;
  });

  /**
   * Upload a mapping for one device model.
   *
   * A document that fails validation is a **422 with the reasons**, not a 400:
   * the request was well-formed and the hub understood it perfectly: what it
   * refused was the content. It is also stored, so `…/repair` can hand it to
   * the agent along with exactly what was wrong — the difference between a
   * dead end and a step.
   */
  app.put('/api/v1/device-mappings/:exposesHash', ownerOnly, async (request, reply) => {
    const { exposesHash } = hashParam.parse(request.params);
    const outcome = await deps.mappings.import(exposesHash, request.body);
    if (!outcome.ok) {
      return reply.code(422).send({
        error: 'invalid_mapping',
        problems: outcome.problems,
        ...(outcome.issues ? { issues: outcome.issues } : {}),
      });
    }
    return outcome;
  });

  app.delete('/api/v1/device-mappings/:exposesHash', ownerOnly, async (request, reply) => {
    const { exposesHash } = hashParam.parse(request.params);
    const removed = await deps.mappings.remove(exposesHash);
    if (!removed) return reply.code(404).send({ error: 'not_found' });
    return reply.code(204).send();
  });

  app.post('/api/v1/device-mappings/:exposesHash/repair', ownerOnly, async (request, reply) => {
    const { exposesHash } = hashParam.parse(request.params);
    const refusal = await aiUnavailableReason();
    if (refusal) return reply.code(409).send({ error: refusal });
    const outcome = await deps.mappings.repair(exposesHash);
    if (!outcome.ok) {
      return reply.code(outcome.reason === 'nothing_to_repair' ? 409 : 422).send({
        error: outcome.reason,
        message: outcome.message,
      });
    }
    return outcome;
  });

  /**
   * Pick the radio on a board that can only afford one.
   *
   * The hub records the choice and returns; it does not apply it. Applying it
   * edits root-owned config, stops or starts Zigbee2MQTT and restarts this
   * process — so `gethome-zigbee-detect` does it, woken by a path unit
   * watching the file written here. That keeps the hub free of any need for
   * sudo, and puts the decision in the one place that knows whether a
   * coordinator is plugged in.
   *
   * Expect this process to be restarted a moment after a mode change that
   * actually moves Matter. The response is sent first.
   */
  app.put('/api/v1/settings/radio', authed, async (request) => {
    // Built from the exported list rather than re-typed, so a mode added to
    // `core/radio.ts` cannot be one the API silently rejects.
    const modes = RADIO_MODES as readonly [RadioMode, ...RadioMode[]];
    const body = z.object({ mode: z.enum(modes) }).parse(request.body);
    writeRadioMode(deps.dataDir, body.mode);
    deps.log.info({ mode: body.mode }, 'Radio mode requested');
    // Tell every other client, now. The hub restarts a moment later *only* if
    // the change actually moves Matter, so a socket bouncing is not something
    // an app can wait for: switching between two modes that resolve the same
    // way changes `mode` and restarts nothing. Without this the other app in
    // the house learned the new mode by polling, if it polls at all — the
    // GetHome iOS app doesn't, so a switch made in Studio never reached it.
    // The frame carries a stale `matter` for the same reason the response
    // does; what is *live* still comes from the adapters.
    deps.events.emit('hubStatusChanged');
    await deps.activity.record({
      kind: 'hub.radio',
      message: `${request.member!.name} set the radio to ${body.mode}.`,
      memberId: request.member!.id,
      data: { memberName: request.member!.name, mode: body.mode },
    });
    return {
      budget: deps.radioBudget,
      mode: body.mode,
      matter: deps.matter !== undefined,
      canRunBoth: deps.radioBudget === 'both',
      /** The switch is applied out of process; poll GET /hub for the result. */
      applying: true,
    };
  });

  // ── WebSocket event stream ───────────────────────────────────────────────

  app.get('/api/v1/ws', { websocket: true }, (socket, request) => {
    // Subscribe synchronously, before the async token check, so an event
    // fired the moment the socket opens is buffered instead of lost in the
    // gap between "connected" and "authorized".
    const handle = attachWebSocket(socket, deps, sessions, hubStatus);
    void (async () => {
      const token = extractToken(request);
      const member = token ? await deps.pairing.verifyToken(token) : null;
      if (!member) {
        handle.close();
        socket.close(UNAUTHORIZED_CLOSE_CODE, 'unauthorized');
        return;
      }
      handle.authorize(member.id);
    })();
  });

  return app;
}
