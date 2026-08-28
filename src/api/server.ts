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
import { AI_PROVIDERS, type AiProvider, type SettingsService } from '../core/settings.js';
import type { HomeStructure, HubEventBus } from '../core/bus.js';
import type { Logger } from '../logging.js';
import { commandSchema } from '../schema/index.js';
import type { MatterAdapter } from '../adapters/matter/adapter.js';
import type { ZigbeeAdapter } from '../adapters/zigbee/adapter.js';
// Dependency-free model catalog (a price table and an allowlist) — importing
// it here does not pull the AI stack into the API layer.
import { defaultModelFor, isSupportedModel, PROVIDER_MODELS, supportedModelIds } from '../ai/models.js';
// Local operations on stored JSON — zod only, no Anthropic SDK in this graph.
// `MappingLibrary.repair` loads the agent on demand.
import type { MappingLibrary } from '../ai/library.js';
import type { AiRunLog } from '../core/ai-runs.js';
import { RADIO_MODES, writeRadioMode, type RadioBudget, type RadioMode } from '../core/radio.js';
import {
  canApplyUpdate,
  checkForUpdate,
  parseBuild,
  readUpdateLog,
  readUpdateRun,
  requestUpdate,
} from '../core/update.js';
import type { MqttObserver } from '../core/mqtt-observer.js';
import { isHistoryKind, type HistoryKind, type HistoryService } from '../core/history.js';
// Files and rows, and `fetch` when it draws. No SDK, so no dynamic import.
import { PortraitSpaceError, type PortraitService } from '../portraits/store.js';
import { PortraitDrawError } from '../portraits/openai-images.js';
import { MAX_WINDOW_SECONDS, type PermitJoinService } from '../core/permit-join.js';
import { createHubStatusReader } from '../core/hub-status.js';
import { deviceWire } from './dto.js';
import { extractToken, requireMember, requirePermission } from './auth.js';
import {
  OWNER_ROLE_KEY,
  PERMISSIONS,
  PERMISSION_KEYS,
  type AccessService,
  type PermissionKey,
} from '../core/access.js';
import { attachWebSocket, MemberSessions, UNAUTHORIZED_CLOSE_CODE } from './ws.js';

export interface ApiDeps {
  db: Db;
  log: Logger;
  events: HubEventBus;
  registry: DeviceRegistry;
  /** Who has pinned what — favorites are per member, not per home. */
  favorites: FavoritesService;
  /** Roles, the permission catalog, and every "may this member?" answer. */
  access: AccessService;
  pairing: PairingService;
  activity: ActivityService;
  /** What the home's readings did over the last few days — `core/history.ts`. */
  history: HistoryService;
  /** The pictures a home has had drawn of its devices — `portraits/store.ts`. */
  portraits: PortraitService;
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

/**
 * Whether two commits are the same one.
 *
 * A build stamp carries seven characters and GitHub can answer with forty, so
 * these are compared by prefix in whichever direction is shorter. Same test
 * Studio makes.
 */
function sameCommit(a: string, b: string): boolean {
  return a.startsWith(b) || b.startsWith(a);
}

interface CommissionJob {
  id: string;
  status: 'running' | 'done' | 'failed';
  nodeId?: string;
  error?: string;
}

/**
 * A downscaled phone photo is a few hundred kilobytes and base64 inflates it by
 * a third; this leaves room for a big one without letting the route become a
 * way to hand a Raspberry Pi ten megabytes of anything.
 */
const PHOTO_BODY_LIMIT = 12 * 1024 * 1024;

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

  /**
   * The floor: any member of this home, whatever their role.
   *
   * Reading the home, renaming yourself, leaving and pinning your own
   * favorites are what being a member *means*, so none of them is a permission
   * and none appears in the matrix. A role that could take them away would
   * leave somebody holding a token that can only 401, behind an app with
   * nothing to draw.
   */
  const authed = { preHandler: [requireMember(deps.pairing)] };
  /** Everything else names the permission it needs. */
  const needs = (permission: PermissionKey) => ({
    preHandler: [requireMember(deps.pairing), requirePermission(deps.access, permission)],
  });
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

  /**
   * A device's portraits moved, so tell every socket. The frame carries the id
   * and nothing else — the list is one short read, and the pictures themselves
   * are megabytes.
   */
  const announcePortraits = (deviceId: string) => deps.events.emit('portraitsChanged', deviceId);

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
    // Additive, and the *presence* of this block is what says the hub records
    // readings at all — an app that finds it absent leaves the chart section
    // off rather than offering a doorway to a 404. It carries the two numbers
    // an app would otherwise have to hard-code from this repository, which is
    // exactly how `activityRetentionNote` came to be deliberately vague.
    history: deps.history.describe(),
    // Additive, and presence is the capability again: an app that finds this
    // block knows the hub can draw device portraits and how many it keeps, and
    // one that doesn't simply never offers to. Whether a *key* has been saved
    // is a different question, and it is answered by `GET /settings/ai` —
    // which not every member of a home may read.
    portraits: deps.portraits.describe(),
    // Additive: an app that doesn't know about this field ignores it, and one
    // that does can say "plug a coordinator in" instead of showing an empty
    // Zigbee section with no explanation.
    // `zigbee` and `radio` are additive, and are the same two blocks the
    // `hubStatus` WebSocket frame pushes when they change — one snapshot,
    // taken in one place, so a client cannot be told two different things
    // depending on which arrived first.
    ...hubStatus.snapshot(),
  }));

  /**
   * One member, as every route that answers with one renders them.
   *
   * There used to be two shapes — `GET /members` answered
   * `{id, name, role, createdAt, isSelf}` and `PATCH /members/me` answered
   * `{id, name, role}` — which is two places for one entity to drift. Roles
   * added a third question ("and what may they do?"), so this is the moment to
   * fold them into one function.
   *
   * `role` stays the legacy two-word string beside the structured `roleId` /
   * `roleName`, because an app written before roles reads it and an app
   * written after has no use for anything but "is this the owner".
   */
  const memberWire = (row: { id: string; name: string; role: string; createdAt?: Date }, callerId?: string) => {
    const role = deps.access.roleFor(row.id);
    return {
      id: row.id,
      role: role?.key === OWNER_ROLE_KEY ? 'owner' : 'member',
      name: row.name,
      roleId: role?.id ?? null,
      roleKey: role?.key ?? null,
      roleName: role?.name ?? null,
      ...(row.createdAt !== undefined ? { createdAt: row.createdAt } : {}),
      // Which of these is the caller. Additive, and the only way an app can
      // answer it: the member id is returned once, by `POST /pair`, and the
      // hub's own `gethome-hubctl claim` prints the hub id and the token and
      // nothing else — so a Mac that claimed its hub over SSH could not find
      // itself in a list of names it is standing in.
      ...(callerId !== undefined ? { isSelf: row.id === callerId } : {}),
    };
  };

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
    const role = deps.access.roleFor(result.member.id);
    await deps.activity.record({
      kind: 'member.joined',
      message: role
        ? `${result.member.name} joined the home as ${role.name}.`
        : `${result.member.name} joined the home.`,
      memberId: result.member.id,
      data: {
        memberName: result.member.name,
        ...(role ? { roleName: role.name } : {}),
      },
    });
    // The permissions ride back with the token, so an app that has just joined
    // knows what it may draw before it has made a second request — and a guest
    // never flashes a screen full of controls it is about to lose.
    return {
      token: result.token,
      member: {
        ...memberWire({ id: result.member.id, name: result.member.name, role: result.member.role }),
        permissions: deps.access.permissionsFor(result.member.id),
      },
    };
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
  app.patch('/api/v1/home', needs('home.rename'), async (request) => {
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

  app.post('/api/v1/rooms', needs('home.structure'), async (request, reply) => {
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
      data: { roomName: body.name, memberName: request.member!.name },
    });
    await announceStructure();
    return reply.code(201).send(roomWire(row!));
  });

  app.patch('/api/v1/rooms/:id', needs('home.structure'), async (request, reply) => {
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
        data: {
          roomName: body.name,
          previousName: before.name,
          memberName: request.member!.name,
        },
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
  app.delete('/api/v1/rooms/:id', needs('home.structure'), async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const room = await deps.db.query.rooms.findFirst({ where: eq(rooms.id, id) });
    if (!room) return reply.code(404).send({ error: 'not_found' });
    await deps.db.delete(rooms).where(eq(rooms.id, id));
    deps.registry.clearRoom(id);
    await deps.activity.record({
      kind: 'room.removed',
      message: `${request.member!.name} removed the room “${room.name}”.`,
      memberId: request.member!.id,
      data: { roomName: room.name, memberName: request.member!.name },
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

  app.post('/api/v1/zones', needs('home.structure'), async (request, reply) => {
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
      data: { zoneName: body.name, memberName: request.member!.name },
    });
    await announceStructure();
    return reply.code(201).send({ id: row!.id, name: row!.name, sortOrder: row!.sortOrder });
  });

  app.patch('/api/v1/zones/:id', needs('home.structure'), async (request, reply) => {
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
        data: {
          zoneName: body.name,
          previousName: before.name,
          memberName: request.member!.name,
        },
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
  app.delete('/api/v1/zones/:id', needs('home.structure'), async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const zone = await deps.db.query.zones.findFirst({ where: eq(zones.id, id) });
    if (!zone) return reply.code(404).send({ error: 'not_found' });
    await deps.db.update(rooms).set({ zoneId: null }).where(eq(rooms.zoneId, id));
    await deps.db.delete(zones).where(eq(zones.id, id));
    await deps.activity.record({
      kind: 'zone.removed',
      message: `${request.member!.name} removed the zone “${zone.name}”.`,
      memberId: request.member!.id,
      data: { zoneName: zone.name, memberName: request.member!.name },
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
   *
   * **That split is why this is the one route whose permission check is not a
   * preHandler.** `device.edit` guards the house's half; the caller's own pin
   * is part of the floor and needs nothing, because a guest who can work the
   * lights must be able to put the kettle on their own dashboard. Checking the
   * whole route would have taken that away; not checking it at all would let a
   * guest rename everybody's devices. So the guard reads the body.
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
    const touchesTheHouse = body.name !== undefined || body.roomId !== undefined;
    if (touchesTheHouse && !deps.access.can(memberId, 'device.edit')) {
      return reply.code(403).send({ error: 'forbidden', permission: 'device.edit' });
    }
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
        data: {
          deviceName: body.name,
          previousName,
          memberName: request.member!.name,
        },
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
        data: {
          deviceName: device.name,
          // Absent is "out of every room", which is a real answer and the
          // reason the sentence above has two forms.
          ...(room ? { roomName: room.name } : {}),
          memberName: request.member!.name,
        },
      });
    }
    return deviceWire(device, deps.favorites.isFavorite(memberId, id));
  });

  const roomExists = async (id: string): Promise<boolean> =>
    (await deps.db.query.rooms.findFirst({ where: eq(rooms.id, id) })) !== undefined;

  app.delete('/api/v1/devices/:id', needs('device.remove'), async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const removed = await deps.registry.removeDevice(id);
    if (!removed) return reply.code(404).send({ error: 'not_found' });
    return reply.code(204).send();
  });

  /**
   * Work a device.
   *
   * **The floor, not a permission**, and it is the one line this whole system
   * rests on: an app whose job is switching the lights on cannot have a member
   * who may not switch the lights on — that is not a restricted member, it is a
   * member with no reason to open the app. Being able to work the home is what
   * being in the home *means*, alongside reading it, renaming yourself, leaving
   * and pinning your own favorites.
   *
   * There was a `device.control` key for a day and it is gone rather than left
   * in the catalog switched on for everybody: a permission every role must hold
   * is a row in the matrix that can only be wrong, and somebody would
   * eventually turn it off and find out what it means.
   */
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

  /**
   * What this device's readings did, over a window.
   *
   * **`authed`, with no permission of its own.** Reading the home is the floor
   * — the same answer `GET /devices` and `GET /activity` give — and a
   * temperature chart is the home being read. A role that may work the lights
   * but not look at how cold the room got would be a rule nobody asked for.
   *
   * `from`/`to` are epoch milliseconds and default to the last day; `points`
   * is how many the caller can draw, and the hub thins to it and *says which
   * width it chose*, so a phone never assumes one. `series` narrows to named
   * quantities, which is what lets the app fetch only the line on screen.
   *
   * An unknown `series` name is dropped rather than refused: the vocabulary
   * grows, and an app one version ahead asking for a quantity this hub has
   * never heard of should get the rest of its chart, not a 400.
   */
  app.get('/api/v1/devices/:id/history', authed, async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    if (!deps.registry.getDevice(id)) return reply.code(404).send({ error: 'not_found' });
    const query = z
      .object({
        from: z.coerce.number().int().optional(),
        to: z.coerce.number().int().optional(),
        points: z.coerce.number().int().min(2).max(1_000).optional(),
        series: z.string().optional(),
      })
      .parse(request.query);
    const to = query.to ?? Date.now();
    const from = query.from ?? to - 24 * 60 * 60 * 1000;
    if (from >= to) return reply.code(400).send({ error: 'invalid_range' });
    const named = query.series
      ?.split(',')
      .map((entry) => entry.trim())
      .filter(isHistoryKind);
    const kinds: readonly HistoryKind[] | undefined =
      named && named.length > 0 ? named : undefined;
    return deps.history.read(id, {
      from,
      to,
      ...(query.points !== undefined ? { points: query.points } : {}),
      ...(kinds !== undefined ? { kinds } : {}),
    });
  });

  app.post('/api/v1/devices/:id/remap', needs('hub.ai'), async (request, reply) => {
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

  // ── Device portraits ──────────────────────────────────────────────────────

  /**
   * The pictures this home has had drawn of a device.
   *
   * **Reading is the floor**, like the device list and its history: a portrait
   * is what the device *looks like* in the apps, so a guest whose dashboard
   * could not draw it would be looking at a different home from everybody else.
   */
  app.get('/api/v1/devices/:id/portraits', authed, async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    if (!deps.registry.getDevice(id)) return reply.code(404).send({ error: 'not_found' });
    return deps.portraits.list(id);
  });

  /**
   * The PNG itself — the first route in this API that answers something other
   * than JSON.
   *
   * A portrait's bytes never change (a new one gets a new id), so it is
   * `immutable` with a strong ETag and a phone downloads each one exactly once.
   * That matters more than it looks: these are one to two megabytes each, and
   * the alternative is every device grid re-fetching the whole set over a home
   * Wi-Fi network on every launch.
   */
  app.get('/api/v1/portraits/:portraitId', authed, async (request, reply) => {
    const { portraitId } = z.object({ portraitId: z.uuid() }).parse(request.params);
    const portrait = await deps.portraits.read(portraitId);
    if (!portrait) return reply.code(404).send({ error: 'not_found' });
    if (request.headers['if-none-match'] === portrait.etag) return reply.code(304).send();
    return reply
      .header('content-type', 'image/png')
      .header('cache-control', 'public, max-age=31536000, immutable')
      .header('etag', portrait.etag)
      .send(portrait.bytes);
  });

  /**
   * Draw one.
   *
   * `hub.ai` rather than `device.edit`, because this is the route that spends
   * the home's money — the same key that guards the credential it spends. It is
   * a member's to press for the reason `hub.update` is: the person standing in
   * front of the kettle is the one who wants a picture of it, and on a hub
   * Studio claimed as *the Mac* that person is never the owner.
   *
   * Deliberately synchronous. It holds the request for the tens of seconds an
   * image takes, which is what lets the app show one uninterrupted animation
   * from "reading your photo" to the finished portrait — and if the phone gives
   * up or walks out of range, the hub finishes, stores, and announces it
   * anyway, so nothing is lost but the animation.
   */
  app.post(
    '/api/v1/devices/:id/portraits',
    {
      ...needs('hub.ai'),
      // The default is 1 MiB, and a photo is several. Per route rather than on
      // the server, so nothing else on this API grows a mouth that size.
      bodyLimit: PHOTO_BODY_LIMIT,
    },
    async (request, reply) => {
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      const device = deps.registry.getDevice(id);
      if (!device) return reply.code(404).send({ error: 'not_found' });
      const body = z
        .object({
          /** A base64 photo to restyle. Absent draws from the device's kind alone. */
          photo: z.string().min(64).max(PHOTO_BODY_LIMIT).optional(),
          photoType: z.enum(['image/jpeg', 'image/png']).default('image/jpeg'),
        })
        .parse(request.body ?? {});

      // Its own refusal code, not `ai_not_configured`: portraits are drawn by
      // OpenAI and device recognition may be running on Anthropic, so a hub can
      // be perfectly configured for one and not the other. And deliberately not
      // gated on `ai_enabled`, which is the *adaptation* switch — nobody draws
      // a portrait by accident, so there is nothing to switch off.
      const apiKey = await deps.settings.aiKey('openai');
      if (!apiKey) return reply.code(409).send({ error: 'openai_not_configured' });

      const kind = device.endpoints[0]?.deviceKind;
      if (!kind) return reply.code(409).send({ error: 'device_has_no_kind' });

      try {
        const portrait = await deps.portraits.draw({
          deviceId: id,
          kind,
          apiKey,
          ...(body.photo !== undefined
            ? { photo: { bytes: Buffer.from(body.photo, 'base64'), contentType: body.photoType } }
            : {}),
        });
        // Recorded because it spent money and everybody in the home now sees a
        // different picture. Only the drawing: choosing between portraits and
        // deleting one are restyles, and a restyle is not what somebody reads
        // the log for a week later — the same line `rooms.icon` holds.
        await deps.activity.record({
          kind: 'device.portrait',
          message: `${request.member!.name} had a new portrait drawn for ${device.name}.`,
          memberId: request.member!.id,
          deviceId: id,
          data: { memberName: request.member!.name, deviceName: device.name },
        });
        announcePortraits(id);
        return portrait;
      } catch (error) {
        if (error instanceof PortraitSpaceError) {
          return reply.code(409).send({ error: 'no_space', detail: error.message });
        }
        if (error instanceof PortraitDrawError) {
          return reply.code(502).send({ error: 'provider_failed', kind: error.kind, detail: error.message });
        }
        throw error;
      }
    },
  );

  /**
   * Which portrait the home sees — `device.edit`, because that is the key for
   * the things about a device everybody shares, and picking one costs nothing.
   * `null` means the procedural sphere, which is a choice rather than an
   * absence and is why it is a nullable field instead of a delete.
   */
  app.patch('/api/v1/devices/:id/portraits', needs('device.edit'), async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    if (!deps.registry.getDevice(id)) return reply.code(404).send({ error: 'not_found' });
    const body = z.object({ selected: z.uuid().nullable() }).parse(request.body);
    const ok = await deps.portraits.select(id, body.selected);
    if (!ok) return reply.code(404).send({ error: 'not_found' });
    announcePortraits(id);
    return deps.portraits.list(id);
  });

  app.delete('/api/v1/portraits/:portraitId', needs('device.edit'), async (request, reply) => {
    const { portraitId } = z.object({ portraitId: z.uuid() }).parse(request.params);
    const deviceId = await deps.portraits.remove(portraitId);
    if (!deviceId) return reply.code(404).send({ error: 'not_found' });
    announcePortraits(deviceId);
    return reply.code(204).send();
  });

  // ── Matter commissioning & Zigbee joining ────────────────────────────────

  /**
   * **Any member, not just the owner** — see the note on permit-join below;
   * the two are one rule and pairing a device is not the shape of the home.
   */
  app.post('/api/v1/matter/commission', needs('device.add'), async (request, reply) => {
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
  app.post('/api/v1/zigbee/permit-join', needs('device.add'), async (request, reply) => {
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
    return rows.map((row) => memberWire(row, request.member!.id));
  });

  /**
   * Who am I, and what may I do?
   *
   * Every other answer to the first half is a search: the member id comes back
   * exactly once, from `POST /pair`, and `gethome-hubctl claim` — the route
   * every hub GetHome Studio installs is claimed through — prints the hub id
   * and the token and no member at all. So a client held a working token and
   * had to find itself by name in a list of names.
   *
   * The second half is the one an app cannot afford to guess. Drawing a button
   * that can only 403 is worse than drawing none, and inferring the answer
   * from a role name would put this build's assumptions in front of a home
   * that has edited its own matrix.
   */
  app.get('/api/v1/me', authed, async (request) => {
    const me = request.member!;
    const role = deps.access.roleFor(me.id);
    return {
      id: me.id,
      name: me.name,
      role: role ? { id: role.id, key: role.key, name: role.name } : null,
      permissions: deps.access.permissionsFor(me.id),
      isOwner: deps.access.isOwner(me.id),
    };
  });

  /**
   * The permission catalog — and **the hub owns its wording**.
   *
   * The apps render `title` and `summary` rather than shipping copy of their
   * own, which is the `activity.message` rule applied to a list that will
   * grow: an app a version behind still draws a complete, truthful matrix
   * instead of a row labelled with a key nobody can read. What an app hard-
   * codes is the handful of keys it gates its own screens on.
   */
  app.get('/api/v1/permissions', authed, async () => PERMISSIONS);

  // ── Roles ────────────────────────────────────────────────────────────────

  /**
   * Every role in the home, with how many people hold it.
   *
   * Open to any member on purpose: a phone rendering "Anna — Guest" needs the
   * names, and who is in the house and in what capacity is not a secret from
   * the people who live there. Changing any of it needs `role.manage`.
   */
  app.get('/api/v1/roles', authed, async () => deps.access.list());

  const roleRefusal = (
    reply: import('fastify').FastifyReply,
    refusal: 'role_is_owner' | 'role_is_builtin' | 'role_in_use' | 'not_found',
  ) =>
    refusal === 'not_found'
      ? reply.code(404).send({ error: 'not_found' })
      : reply.code(409).send({ error: refusal });

  const permissionListSchema = z.array(z.enum(PERMISSION_KEYS as [PermissionKey, ...PermissionKey[]]));
  /** A role's name follows the same rule every other name in the hub does. */
  const roleNameSchema = z.string().trim().min(1).max(80);

  app.post('/api/v1/roles', needs('role.manage'), async (request, reply) => {
    const body = z
      .object({ name: roleNameSchema, permissions: permissionListSchema.default([]) })
      .parse(request.body);
    const role = await deps.access.createRole(body.name, body.permissions);
    await deps.activity.record({
      kind: 'role.added',
      message: `${request.member!.name} added the role ${role.name}.`,
      memberId: request.member!.id,
      data: { roleName: role.name, memberName: request.member!.name },
    });
    return reply.code(201).send({ ...role, memberCount: 0 });
  });

  /**
   * Rename a role, change what it may do, or both.
   *
   * The owner's row is refused (`409 role_is_owner`). Nothing reads it —
   * `AccessService.can` answers `true` for the owner without consulting a
   * stored set — so editing it would move a number on a screen and nothing in
   * the world, while looking exactly like the control that could take
   * `role.manage` away from the only person guaranteed to have it. That
   * unconditional answer is also what makes `role.manage` safe to hand out
   * with no escalation guard behind it: however the matrix is edited, the
   * owner is still there and can put it back.
   */
  app.patch('/api/v1/roles/:id', needs('role.manage'), async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z
      .object({ name: roleNameSchema.optional(), permissions: permissionListSchema.optional() })
      .parse(request.body);
    const before = deps.access.role(id);
    const result = await deps.access.updateRole(id, body);
    if (typeof result === 'string') return roleRefusal(reply, result);

    // One sentence, and deliberately not the diff: this log is read a week
    // later, where "Georgy changed what Guest can do" is the whole of what
    // anybody is looking for. The `structure`-style live frame is what tells
    // an app that is open right now.
    if (body.permissions !== undefined) {
      await deps.activity.record({
        kind: 'role.changed',
        message: `${request.member!.name} changed what ${result.name} can do.`,
        memberId: request.member!.id,
        data: { roleName: result.name, memberName: request.member!.name },
      });
    }
    if (body.name !== undefined && before && before.name !== result.name) {
      await deps.activity.record({
        kind: 'role.renamed',
        message: `${request.member!.name} renamed the role ${before.name} to ${result.name}.`,
        memberId: request.member!.id,
        data: {
          roleName: result.name,
          previousName: before.name,
          memberName: request.member!.name,
        },
      });
    }
    const counted = deps.access.list().find((role) => role.id === id);
    return counted ?? { ...result, memberCount: 0 };
  });

  /**
   * Forget a role the home invented.
   *
   * Refused while anybody holds it (`409 role_in_use`) rather than quietly
   * moving those people somewhere else: `members.role_id` carries no
   * `ON DELETE` action — SQLite cannot attach one to a column added by
   * `ALTER TABLE` — so this check *is* the referential integrity, and changing
   * somebody's access as a side effect of a delete is not a behaviour worth
   * having anyway. Built-in roles never go (`409 role_is_builtin`).
   */
  app.delete('/api/v1/roles/:id', needs('role.manage'), async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const name = deps.access.role(id)?.name;
    const refusal = await deps.access.deleteRole(id);
    if (refusal) return roleRefusal(reply, refusal);
    await deps.activity.record({
      kind: 'role.removed',
      message: `${request.member!.name} removed the role ${name ?? 'that was there'}.`,
      memberId: request.member!.id,
      data: { ...(name ? { roleName: name } : {}), memberName: request.member!.name },
    });
    return reply.code(204).send();
  });

  /**
   * Put somebody in a different role — including the owner's.
   *
   * **Owner is an ordinary role**, invitable and assignable and revocable, and
   * two rules take the place of the blanket refusals that used to say
   * otherwise.
   *
   * **Only an owner may hand out the owner's role, or take it back.**
   * `role.manage` is what edits the matrix, and a home can grant it to a role
   * it invented — so if that permission alone could promote, it would silently
   * mean "can make myself owner" and every other permission would be a
   * formality. This route is the escalation surface and this check is the
   * guard; `403 not_owner` rather than `owner_only`, which both apps read as
   * "this hub is too old, update it" and would send somebody to fix a hub that
   * is working perfectly.
   *
   * **A home always keeps one owner.** That is the whole of what the old rule
   * was protecting: granting the role is itself owner-only, so a home that
   * lost its last one would have nobody left able to put it right. Moving the
   * last owner out is `409 cannot_change_owner` — the same code as before,
   * narrowed to the case that still matters, so an app a version behind shows
   * a sentence that is still true rather than nothing at all.
   */
  app.patch('/api/v1/members/:id', needs('role.manage'), async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ roleId: z.uuid() }).parse(request.body);
    const target = await deps.db.query.members.findFirst({ where: eq(members.id, id) });
    if (!target) return reply.code(404).send({ error: 'not_found' });
    const wanted = deps.access.role(body.roleId);
    if (!wanted) return reply.code(404).send({ error: 'unknown_role' });

    const touchesOwnership =
      wanted.key === OWNER_ROLE_KEY || deps.access.isOwner(target.id);
    if (touchesOwnership && !deps.access.isOwner(request.member!.id)) {
      return reply.code(403).send({ error: 'not_owner' });
    }
    if (wanted.key !== OWNER_ROLE_KEY && deps.access.isLastOwner(target.id)) {
      return reply.code(409).send({ error: 'cannot_change_owner' });
    }
    const before = deps.access.roleFor(target.id);
    if (before?.id === wanted.id) return memberWire(target, request.member!.id);

    await deps.access.assignRole(target.id, wanted.id);
    await deps.activity.record({
      kind: 'member.role-changed',
      message: `${request.member!.name} made ${target.name} ${wanted.name}.`,
      memberId: request.member!.id,
      data: {
        memberName: request.member!.name,
        subjectName: target.name,
        roleName: wanted.name,
        ...(before ? { previousName: before.name } : {}),
      },
    });
    return memberWire(target, request.member!.id);
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
    return {
      ...memberWire({ id: before.id, name: body.name, role: before.role }, before.id),
      permissions: deps.access.permissionsFor(before.id),
    };
  });

  /**
   * Leave the home — the mirror of `PATCH /members/me`, and `me` for the same
   * reason: the token is the identity, and most callers never learn their own
   * id. Any member may do it, because leaving is the one decision about a
   * member that is entirely their own.
   *
   * **The last owner may not**, and that is now the only thing stopping them.
   * An owner who has made somebody else one can walk out like anybody else;
   * the last one cannot, because granting the role is owner-only and a home
   * with nobody in it would have no way back. An owner who is finished with a
   * hub and is the only one left is finished with the hub, and that is
   * `gethome-hubctl` on the machine, not a route.
   */
  app.delete('/api/v1/members/me', authed, async (request, reply) => {
    const member = request.member!;
    if (deps.access.isLastOwner(member.id)) {
      return reply.code(409).send({ error: 'cannot_remove_owner' });
    }
    await deps.db.delete(members).where(eq(members.id, member.id));
    await endMembership(member.id, `${member.name} left the home.`, 'member.left');
    return reply.code(204).send();
  });

  app.delete('/api/v1/members/:id', needs('member.remove'), async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const target = await deps.db.query.members.findFirst({ where: eq(members.id, id) });
    if (!target) return reply.code(404).send({ error: 'not_found' });
    // Same two rules as moving somebody out of the role: only an owner may
    // take an owner out of the home, and never the last one.
    if (deps.access.isOwner(target.id) && !deps.access.isOwner(request.member!.id)) {
      return reply.code(403).send({ error: 'not_owner' });
    }
    if (deps.access.isLastOwner(target.id)) {
      return reply.code(409).send({ error: 'cannot_remove_owner' });
    }
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
    // cascades); this is the in-memory half of the same delete. `access` holds
    // the same kind of map, keyed the same way, and would otherwise answer for
    // a member who has left for the life of the process.
    deps.favorites.forgetMember(memberId);
    deps.access.forgetMember(memberId);
    await deps.activity.record({ kind, message });
  }

  app.get('/api/v1/invites', needs('member.invite'), async () => {
    const rows = await deps.db.query.invites.findMany();
    const now = Date.now();
    return rows
      .filter((row) => row.usedBy === null && row.expiresAt.getTime() > now)
      .map((row) => {
        const role = row.roleId ? deps.access.role(row.roleId) : undefined;
        return {
          id: row.id,
          role: row.role,
          roleId: role?.id ?? null,
          roleName: role?.name ?? null,
          expiresAt: row.expiresAt,
        };
      });
  });

  /**
   * Mint an invite code — for a role.
   *
   * `invites.role` has carried a role since the first migration and the claim
   * path has honoured it just as long; this route simply never passed one, so
   * every invite in the hub's history has been a `member` invite. Omitting
   * `roleId` still means exactly that, so nothing that already works changes.
   *
   * An **owner invite** is allowed, and gated the same way `PATCH /members/:id`
   * gates the role: only an owner may mint one. `PairingService.claim` already
   * reads the invite's role and writes the legacy `owner` word when its key
   * says so, so nothing downstream needed changing — this route was the only
   * thing refusing.
   */
  app.post('/api/v1/invites', needs('member.invite'), async (request, reply) => {
    const body = z
      .object({ roleId: z.uuid().optional() })
      .parse(request.body ?? {});
    if (body.roleId) {
      const role = deps.access.role(body.roleId);
      if (!role) return reply.code(404).send({ error: 'unknown_role' });
      if (role.key === OWNER_ROLE_KEY && !deps.access.isOwner(request.member!.id)) {
        return reply.code(403).send({ error: 'not_owner' });
      }
    }
    const invite = await deps.pairing.createInvite(request.member!.id, body.roleId);
    const role = invite.roleId ? deps.access.role(invite.roleId) : undefined;
    return reply.code(201).send({
      code: invite.code,
      expiresAt: invite.expiresAt,
      roleId: invite.roleId,
      roleName: role?.name ?? null,
    });
  });

  /**
   * The home's history.
   *
   * **`activity.read` narrows this; it never refuses it.** A member without it
   * still reads their own rows, which is what keeps a guest's Recent feed a
   * working screen instead of an error — and it is the honest answer to "what
   * have I done in this house". Everybody else's lines are the home's to share.
   *
   * The log used to promise it had no per-member scoping at all. It still has
   * none *among the people permitted to read it*: there is no filtering by
   * device, room or kind, and anyone with the permission sees every line by
   * name, which is the point in a family home.
   */
  app.get('/api/v1/activity', authed, async (request) => {
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(50), before: z.coerce.number().int().optional() })
      .parse(request.query);
    const mine = deps.access.can(request.member!.id, 'activity.read')
      ? undefined
      : request.member!.id;
    const rows = await deps.activity.list(query.limit, query.before, mine);
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

  /**
   * The AI settings, as an app draws them.
   *
   * Every field the flat shape has always carried is still here — `provider`,
   * `model`, `hasKey`, `enabled`, `legacySubscriptionToken`, `status` — because
   * the wire is a compatibility contract and an older app reads them. What is
   * new is per-provider, plus the two things an app must not decide for itself:
   * which models this hub will accept (with the hub's own labels, the
   * `GET /permissions` rule) and whether the mapping provider is a choice at
   * all.
   */
  const aiSettingsResponse = async () => {
    const [ai, status] = await Promise.all([deps.settings.getAiSettings(), deps.settings.getAiStatus()]);
    const forProvider = (provider: AiProvider) => ({
      hasKey: ai[provider].hasKey,
      model: ai[provider].model ?? defaultModelFor(provider),
      models: PROVIDER_MODELS[provider].choices,
    });
    return {
      ...ai,
      status,
      providers: { anthropic: forProvider('anthropic'), openai: forProvider('openai') },
      mapping: { provider: ai.provider, choosable: ai.mappingChoosable },
      portraits: deps.portraits.describe(),
    };
  };

  const modelField = (provider: AiProvider) =>
    z
      .string()
      .min(1)
      .max(120)
      .refine((model) => isSupportedModel(model, provider), {
        message: `unsupported model — the mapping agent runs on: ${supportedModelIds(provider).join(', ')}`,
      })
      .nullable()
      .optional();

  const apiKeyField = (provider: AiProvider) =>
    z
      .string()
      .min(8)
      .max(4000)
      .refine((key) => !key.trim().startsWith('sk-ant-oat'), {
        message:
          'that is a Claude subscription token; the hub needs an Anthropic API key (sk-ant-api…) from platform.claude.com',
      })
      .refine((key) => (provider === 'anthropic' ? !key.trim().startsWith('sk-proj-') : true), {
        message: 'that looks like an OpenAI key — it belongs in the OpenAI field',
      })
      .refine((key) => (provider === 'openai' ? !key.trim().startsWith('sk-ant-') : true), {
        message: 'that looks like an Anthropic key — it belongs in the Anthropic field',
      })
      .optional();

  const aiPatchSchema = z.object({
    enabled: z.boolean().optional(),
    /** The Anthropic model, under the name this route has always used. */
    model: modelField('anthropic'),
    anthropicModel: modelField('anthropic'),
    openaiModel: modelField('openai'),
    anthropicApiKey: apiKeyField('anthropic'),
    openaiApiKey: apiKeyField('openai'),
    mappingProvider: z.enum(AI_PROVIDERS).optional(),
    /** Forget one provider's key and model, leaving the other one alone. */
    clear: z.enum(AI_PROVIDERS).optional(),
  });

  app.get('/api/v1/settings/ai', needs('hub.ai'), aiSettingsResponse);

  app.put('/api/v1/settings/ai', needs('hub.ai'), async (request) => {
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
   * Change anything about the hub's AI without re-entering everything else.
   *
   * Every field is optional and absence means "leave this alone", which is what
   * lets one route carry two credentials, two models, the mapping provider and
   * the switch. `PUT` requires an `apiKey`, so the only way to stop the agent
   * running used to be `DELETE` — which is a different request. "Stop spending
   * my money on this for now" and "forget my credential" have very different
   * costs to undo, and an owner who wanted the first had to pay the second.
   *
   * The two keys are told apart by their prefixes rather than trusted to the
   * field they arrived in: with two secure fields on one screen, pasting into
   * the wrong one is the ordinary mistake, and "that is an Anthropic key" is a
   * far better answer than a 401 from the wrong vendor an hour later.
   */
  app.patch('/api/v1/settings/ai', needs('hub.ai'), async (request, reply) => {
    const body = aiPatchSchema.parse(request.body);
    if (body.clear !== undefined) await deps.settings.clearAiProvider(body.clear);
    if (body.anthropicApiKey !== undefined) await deps.settings.setAiKey('anthropic', body.anthropicApiKey);
    if (body.openaiApiKey !== undefined) await deps.settings.setAiKey('openai', body.openaiApiKey);
    const anthropicModel = body.anthropicModel !== undefined ? body.anthropicModel : body.model;
    if (anthropicModel !== undefined) await deps.settings.setAiModel(anthropicModel, 'anthropic');
    if (body.openaiModel !== undefined) await deps.settings.setAiModel(body.openaiModel, 'openai');
    if (body.mappingProvider !== undefined) {
      // Asked after the key writes above, so one request can save a key and
      // point the agent at it. A provider with no credential is refused rather
      // than stored: the hub would answer with the *other* provider on the next
      // read, and the app would show a picker that silently sprang back.
      const ai = await deps.settings.getAiSettings();
      if (!ai[body.mappingProvider].hasKey) {
        return reply.code(400).send({ error: 'provider_not_configured', provider: body.mappingProvider });
      }
      await deps.settings.setMappingProvider(body.mappingProvider);
    }
    if (body.enabled !== undefined) await deps.settings.setAiEnabled(body.enabled);
    return aiSettingsResponse();
  });

  app.delete('/api/v1/settings/ai', needs('hub.ai'), async (_request, reply) => {
    await deps.settings.clearAiSettings();
    return reply.code(204).send();
  });

  /**
   * What the mapping agent did, most recent first.
   *
   * Owner-only because it names device models and costs money, and because
   * `GET /settings/ai` — the other half of the same answer — already is.
   */
  app.get('/api/v1/ai/runs', needs('hub.ai'), async (request) => {
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
      // Which vendor ran it, beside which model. Absent on a row written
      // before the hub could run on more than one.
      provider: row.provider,
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
  app.get('/api/v1/device-mappings', needs('hub.ai'), async () => deps.mappings.list());

  app.get('/api/v1/device-mappings/:exposesHash', needs('hub.ai'), async (request, reply) => {
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
  app.put('/api/v1/device-mappings/:exposesHash', needs('hub.ai'), async (request, reply) => {
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

  app.delete('/api/v1/device-mappings/:exposesHash', needs('hub.ai'), async (request, reply) => {
    const { exposesHash } = hashParam.parse(request.params);
    const removed = await deps.mappings.remove(exposesHash);
    if (!removed) return reply.code(404).send({ error: 'not_found' });
    return reply.code(204).send();
  });

  app.post('/api/v1/device-mappings/:exposesHash/repair', needs('hub.ai'), async (request, reply) => {
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
  app.put('/api/v1/settings/radio', needs('hub.radio'), async (request) => {
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

  // ── Updating the hub ─────────────────────────────────────────────────────

  /**
   * What is installed, whether anything newer exists, and how a run is going.
   *
   * Deliberately its own route rather than more fields on `GET /hub`: that one
   * is the health check every app and installer polls, it must stay a cheap
   * read of things already in memory, and this one may go to the network.
   *
   * Reading is the floor — no permission at all — and starting one is
   * `hub.update`, whose reasoning is on `POST` below. That reading was never in
   * question is the point: the information is the home's, and somebody who
   * *cannot* press the button is exactly who needs to see why the hub dropped
   * off the network for two minutes.
   */
  app.get('/api/v1/system/update', authed, async (request) => {
    const { refresh } = z
      .object({ refresh: z.coerce.boolean().optional() })
      .parse(request.query ?? {});
    const current = parseBuild(deps.build);
    // A hub built from source has no stamp, so there is nothing to compare and
    // asking GitHub would answer a question we could not use. That is a reason
    // to say "cannot tell", never to say "up to date".
    const check = current
      ? await checkForUpdate(refresh === true)
      : { error: 'no_build_stamp' as const };
    const run = readUpdateRun(deps.dataDir);

    return {
      ...(current
        ? {
            current: {
              build: current.build,
              version: current.version,
              sha: current.sha,
              channel: current.channel,
            },
          }
        : { current: { build: deps.build ?? null, version: deps.version } }),
      ...(check.sha !== undefined
        ? {
            latest: { sha: check.sha, ...(check.checkedAt ? { checkedAt: check.checkedAt } : {}) },
            // Absent, never null, when the hub cannot say — the same three-value
            // shape every optional field on this wire uses. An app that reads a
            // missing `available` as `false` would tell somebody they are up to
            // date on the strength of a failed network call.
            available: current !== undefined && !sameCommit(current.sha, check.sha),
          }
        : {}),
      ...(check.error !== undefined ? { checkError: check.error } : {}),
      /** Whether this machine has the runner and the units at all. */
      canApply: canApplyUpdate(deps.dataDir),
      ...(run !== undefined ? { run } : {}),
    };
  });

  /**
   * Ask the hub to update itself.
   *
   * **`hub.update`, which the built-in Member holds** — and the history is why
   * it is a permission rather than either extreme. It was owner-only first, on
   * the reasoning that an update is not quite "bringing something new in": it
   * replaces the code every member depends on and runs migrations that
   * flipping the symlink back does not undo.
   *
   * What that missed is who the owner *is*. GetHome Studio claims a hub as
   * *the Mac*, so the owner is a laptop in a drawer and every phone joins by
   * invite as a plain member — and there is no ownership transfer, so that
   * never changes for the life of the hub. Owner-only therefore did not mean
   * "an update needs care"; it meant the phone in the owner's own hand could
   * never update their own hub, ever. Observed, on the first hub this shipped
   * to. It is the same discovery that moved renaming a device out of
   * `ownerOnly`, for the same reason.
   *
   * So it went to every member, which was right about the household and wrong
   * about the mechanism: "every member" is not a decision a home can revisit,
   * and this is exactly the kind of thing a home might want to keep away from
   * whoever is staying in the spare room. As a key it is both — the default
   * hands it to Member, so nobody who could update yesterday has lost
   * anything, while Guest arrives without it and a home that disagrees can
   * move it either way from the matrix.
   *
   * It passes the three tests every default here passes. **Bounded**:
   * install.sh unpacks beside the running build and only moves the symlink
   * once the new one answers, so a build that won't start puts itself back
   * unattended. **Destroys nothing**: no device leaves, no membership ends,
   * and migrations are written to be readable by the build before them — the
   * rollback is what makes that a rule rather than a hope. **Named**: the row
   * below carries the member's name, which is the accountability the old role
   * check stood in for.
   *
   * Taking something *away* is still guarded harder — a device, a member, the
   * credential that spends their money. That line is unchanged.
   *
   * The response is a receipt, not a state. Nothing has happened yet: a root
   * unit picks the request up a moment later and restarts this process on the
   * way. Poll this route for what became of it.
   */
  app.post('/api/v1/system/update', needs('hub.update'), async (request, reply) => {
    if (!canApplyUpdate(deps.dataDir)) {
      // A hub installed before any of this existed. Saying so beats letting the
      // request sit in a directory nothing is watching, which from an app looks
      // exactly like an update that never starts.
      return reply.code(409).send({ error: 'update_unsupported' });
    }
    const run = readUpdateRun(deps.dataDir);
    if (run?.state === 'running') {
      return reply.code(409).send({ error: 'update_in_progress' });
    }
    const id = requestUpdate(deps.dataDir);
    deps.log.info({ id, member: request.member!.id }, 'Hub update requested');
    // Written here, while this process is still alive to write it: the outcome
    // is recorded at the next boot, by which time there is no member to name.
    await deps.activity.record({
      kind: 'hub.update',
      message: `${request.member!.name} started a hub update.`,
      memberId: request.member!.id,
      data: {
        memberName: request.member!.name,
        outcome: 'started',
        ...(deps.build !== undefined ? { fromBuild: deps.build } : {}),
      },
    });
    return reply.code(202).send({ id, state: 'queued' });
  });

  /**
   * What the installer printed. Fetched on demand and never pushed: on a hub
   * that updates cleanly nobody opens this, and it must not cost every screen a
   * file read on arrival.
   */
  app.get('/api/v1/system/update/log', authed, async (request) => {
    const { tail } = z
      .object({ tail: z.coerce.number().int().min(1).max(2000).optional() })
      .parse(request.query ?? {});
    // The total goes back too, so an app can say what it is *not* showing
    // rather than letting a cut log read as the whole story.
    return readUpdateLog(deps.dataDir, tail ?? 200);
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
