import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
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
// Runtime, and safe to be: this module imports nothing itself, which is what
// keeps `@matter/main` out of the graph of a hub that isn't running Matter.
import {
  CommissionError,
  commissionFailure,
  type CommissionFailure,
} from '../adapters/matter/commission-failures.js';
import type { CommissionStep } from '../adapters/matter/adapter.js';
import type { ZigbeeAdapter } from '../adapters/zigbee/adapter.js';
// Dependency-free model catalog (a price table and an allowlist) — importing
// it here does not pull the AI stack into the API layer.
import {
  AGENT_MODELS,
  agentProviderOf,
  effectiveModel,
  isSupportedModel,
  modelLabel,
  offeredModelIds,
  PROVIDER_MODELS,
} from '../ai/models.js';
// Local operations on stored JSON — zod only, no Anthropic SDK in this graph.
// `MappingLibrary.repair` loads the agent on demand.
import type { MappingLibrary } from '../ai/library.js';
import { RoomPictureDrawError } from '../room-pictures/draw.js';
import {
  MAX_PHOTOS,
  PictureBusyError,
  PictureSpaceError,
  RoomPictureService,
  type Locator,
} from '../room-pictures/store.js';
import type { AiRunLog } from '../core/ai-runs.js';
import type { AutomationEngine, AutomationPresser } from '../automations/engine.js';
import {
  AutomationNotConfiguredError,
  type AutomationChat,
} from '../ai/automation-chat.js';
import type { AssistantChat } from '../ai/assistant-chat.js';
import {
  base64Bytes,
  CHAT_CAPABILITY,
  CHAT_EFFORTS,
  CHAT_IMAGE_MAX_BASE64,
  CHAT_IMAGE_MAX_BYTES,
  CHAT_IMAGE_MAX_COUNT,
  CHAT_IMAGE_MEDIA_TYPES,
  ChatPhotosBusyError,
  type ChatEffort,
  type ChatTurnRequest,
} from '../ai/chat/chat-runtime.js';
import type { AutomationStore } from '../automations/store.js';
import { automationDocumentSchema } from '../automations/schema.js';
import { sanityCheckAutomation } from '../automations/sanity.js';
import { automationCatalog } from '../automations/catalog.js';
import { AUTOMATION_TEMPLATES, findTemplate } from '../automations/templates.js';
import { automationOutline } from '../automations/outline.js';
import { automationShape, describeAutomation } from '../automations/summarize.js';
import { automationRoom } from '../automations/scope.js';
import type { AutomationHomeView } from '../automations/targets.js';
import type { MemoryPressure } from '../core/radio-pressure.js';
import { recordRadioChoice, RADIO_MODES, writeRadioMode, type RadioBudget, type RadioMode } from '../core/radio.js';
import { createAutoUpdater, type AutoUpdater } from '../core/auto-update.js';
import {
  canApplyUpdate,
  checkForUpdate,
  parseBuild,
  readUpdateLog,
  readUpdateRun,
  requestUpdate,
  sameCommit,
} from '../core/update.js';
import {
  awaitWifiChange,
  MAX_WIFI_NETWORKS,
  passwordProblem,
  readSavedNetworks,
  readWifiChangeResult,
  requestWifiChange,
  ssidProblem,
  wifiAvailability,
  wifiChangePending,
  wpaPsk,
  type WifiChangeError,
  type WifiChangeResult,
} from '../core/wifi-networks.js';
import { ownIPv4Addresses, proofAddress, proveIdentity } from '../core/hub-proof.js';
import type { HubWifiView } from '../core/device-network.js';
import type { MqttObserver } from '../core/mqtt-observer.js';
import { hostFromRequest, mqttAccess, type MqttBrokerConfig } from '../core/mqtt-access.js';
import { isHistoryKind, type HistoryKind, type HistoryService } from '../core/history.js';
// Files and rows, and `fetch` when it draws. No SDK, so no dynamic import.
import { PortraitBusyError, PortraitSpaceError, type PortraitService } from '../portraits/store.js';
import { PortraitDrawError } from '../portraits/openai-images.js';
import { MAX_WINDOW_SECONDS, type PermitJoinService } from '../core/permit-join.js';
import { createHubStatusReader } from '../core/hub-status.js';
import { deviceWire, deviceWireView } from './dto.js';
import {
  authenticate,
  can,
  extractCredential,
  isPrincipalHandler,
  mayControl,
  pathOf,
  requirePermission,
  requirePrincipal,
  type ApiKeyPolicy,
  type RoutePolicy,
} from './auth.js';
import { createHostCheck, createRefusalLogGate, hostnameFromHeader } from './host-guard.js';
import {
  isKeyGrantable,
  KEY_GRANTABLE,
  OWNER_ROLE_KEY,
  PERMISSIONS,
  PERMISSION_KEYS,
  type AccessService,
  type PermissionKey,
} from '../core/access.js';
import {
  apiKeyState,
  ApiKeyService,
  MAX_KEY_LIFETIME_DAYS,
  MAX_KEYS_PER_MEMBER,
  MAX_SOCKETS_PER_KEY,
  type ApiKeyRecord,
} from '../core/api-keys.js';
import {
  attachWebSocket,
  KEY_LIMIT_CLOSE_CODE,
  KEY_RATE_CLOSE_CODE,
  MemberSessions,
  UNAUTHORIZED_CLOSE_CODE,
} from './ws.js';

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
  /**
   * The hub updating itself, when its home has said it may — `core/auto-update.ts`.
   *
   * Optional, for the reason `allowedHosts` is: a required field is one every
   * `buildServer` call in `test/` has to grow. Left out, the server makes its
   * own from the deps it already has, loaded and switched off and never
   * started — which is a hub where nobody has turned automatic updates on, so
   * every suite still meets the real routes. `src/index.ts` always passes the
   * one it started.
   */
  autoUpdate?: AutoUpdater;
  /** Present when the corresponding adapter is enabled and running. */
  matter?: MatterAdapter;
  zigbee?: ZigbeeAdapter;
  /**
   * Names this hub answers to beyond the local ones `api/host-guard.ts`
   * recognises on its own — `EXTRA_ALLOWED_HOSTS`, split on commas.
   *
   * Optional, and empty is the ordinary hub: addresses, `localhost`, a bare
   * machine name and `.local` all pass without being listed. Optional also
   * because a required field here is a field every `buildServer` call site in
   * `test/` has to grow, which is the trap `access` fell into twice.
   */
  allowedHosts?: string;
  /** Where the owner's radio choice is stored, and how many radios fit. */
  dataDir: string;
  radioBudget: RadioBudget;
  /**
   * The memory watch, for what it is seeing right now.
   *
   * Structurally typed and optional so a suite can leave it out — and so this
   * module pulls nothing from `core/radio-pressure.ts` at runtime. The
   * *record* of a stand-down is on disk and read from there; this is the live
   * half, which only exists in the process doing the watching.
   */
  radioPressure?: { pressure(): MemoryPressure | undefined };
  /**
   * How long a Wi-Fi network change waits for the root script before it
   * answers `202` instead of the outcome. Optional so a suite can make it short
   * and every `buildServer` call site does not have to grow it.
   */
  wifiApplyWaitMs?: number;
  /**
   * The IPv4 addresses this machine holds, for `POST /hub/proof`, which signs
   * only for one of them. Optional so a suite can name the address it dials;
   * the hub reads the interfaces afresh on every request.
   */
  ownAddresses?: () => readonly string[];
  /**
   * What the hub knows about its own Wi-Fi, for saying a device is offline
   * because the hub is on another network (`core/device-network.ts`).
   * Optional so a suite can name the networks; the hub reads its list afresh
   * on every render, because a hub that has just moved is the one asked about.
   */
  hubWifi?: () => HubWifiView | undefined;
  /**
   * Where the coordinator detector records what it found — read only to tell
   * "no Zigbee stick" apart from "the stick is here and Matter has the board".
   */
  zigbeeEnvFile: string;
  /** Zigbee2MQTT's data directory — read only to say *why* Zigbee is down. */
  z2mDataDir: string;
  /**
   * How to sign in to this hub's broker, for `GET /settings/mqtt`.
   *
   * Required rather than optional: an absent one would have to answer
   * "no password" — indistinguishable from an open broker — which is the
   * single most misleading thing this route could say.
   */
  mqtt: MqttBrokerConfig;
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
  /** The rules the home runs by itself, and the scenes the apps draw. */
  automations: AutomationEngine;
  automationStore: AutomationStore;
  /**
   * The conversations rules get written in. Constructed unconditionally — a
   * hub with no key never builds a provider client and the routes answer
   * `409 ai_not_configured`, which is the answer an app needs rather than a
   * missing route it cannot tell from an old hub.
   */
  automationChat: AutomationChat;
  /**
   * The assistant's conversations. Constructed unconditionally for the reason
   * the automations chat is: a hub with no key never builds a provider client
   * and the routes answer `409 ai_not_configured`, which is the answer an app
   * needs rather than a missing route it cannot tell from an old hub.
   */
  assistantChat: AssistantChat;
}

/**
 * A Matter pairing, as the app watches it.
 *
 * **Everything new here is additive, and that is the whole design.** `status`
 * keeps its three words exactly — GetHome Studio reads this route too, and a
 * fourth value is a value an existing client silently drops on the floor. So
 * the two facts worth adding arrive beside it rather than inside it.
 *
 * `step` is the difference between "hold the accessory's button until it
 * blinks" and "leave it alone now", which is the only advice worth giving
 * during the two minutes this takes — a screen saying "working…" through both
 * is a screen somebody unplugs the accessory in the middle of.
 *
 * `failure` is the named reason (`adapters/matter/commission-failures.ts`),
 * and it is also where a **cancel** lives: a job somebody called off is
 * `failed` with `kind: 'cancelled'`, so an old client shows its ordinary "that
 * didn't pair" and a new one goes quietly back to the viewfinder. `error`
 * stays beside it carrying the same sentence, because it is what a client
 * built before any of this reads and there is no version for it to check.
 */
interface CommissionJob {
  id: string;
  status: 'running' | 'done' | 'failed';
  /** Where a running job has got to. Absent once it has finished. */
  step?: CommissionStep;
  nodeId?: string;
  error?: string;
  failure?: CommissionFailure;
  /** Who started it, kept for the activity trail rather than for the guard. */
  memberId?: string;
  /** When it started, so a client that reconnects can size its own patience. */
  startedAt: number;
  /** The hub's own deadline, so a screen counts down rather than guessing. */
  deadline: number;
}

/**
 * A downscaled phone photo is a few hundred kilobytes and base64 inflates it by
 * a third; this leaves room for a big one without letting the route become a
 * way to hand a Raspberry Pi ten megabytes of anything.
 */
const PHOTO_BODY_LIMIT = 12 * 1024 * 1024;

/**
 * One photo at the ceiling as a JSON encoder writes it: its base64, plus room
 * for `/` written as `\/`.
 *
 * **Apple's encoders escape every slash by default** — `JSONSerialization`
 * and `JSONEncoder` without `.withoutEscapingSlashes` — and `/` is one base64
 * character in sixty-four, so four photos at the ceiling came to the door
 * about 128 KB heavier than their parsed size: past the slack this limit had,
 * and refused with a bare 413 a request the schema would have taken. The
 * allowance is twice the expected share, since a photo's bytes are not
 * perfectly random.
 */
const CHAT_IMAGE_MAX_JSON = CHAT_IMAGE_MAX_BASE64 + Math.ceil(CHAT_IMAGE_MAX_BASE64 / 32);

/**
 * A chat message carrying as many photos as it may, each as large as it may
 * be, with room for the words and the JSON around them.
 *
 * **Per route, on the four that take a message, and never on the server** —
 * `PHOTO_BODY_LIMIT`'s rule: nothing else on this API grows a mouth this size
 * (the two photo routes take 12 MB, every other route Fastify's one-megabyte
 * default). It is the ceiling, not the expectation: the apps downscale a photo
 * to a few hundred kilobytes before sending it, and a message with one is well
 * under the default. Derived rather than written out, so raising the count or
 * the size cannot leave a request the schema accepts — as an ordinary JSON
 * encoder writes it, slashes escaped included — refused at the door with a
 * 413. (No bound covers every encoding JSON allows: `\u002f` is six bytes for
 * one character.)
 */
const CHAT_BODY_LIMIT = CHAT_IMAGE_MAX_COUNT * CHAT_IMAGE_MAX_JSON + 64 * 1024;

/**
 * Whether a string is well-formed base64, checked by walking it.
 *
 * A loop rather than a regular expression, because the string can be two
 * million characters — `CHAT_IMAGE_MAX_BASE64`, and no longer, since the
 * schema's `.max` before this check aborts on a string past it (zod runs a
 * refine even after a failed `.max` otherwise, and the body limit would have
 * let one of eight million through) — and a pattern that has to count its way
 * through groups of four is a backtracking stack that size. Well-formed means
 * what both vendors decode: a length that is a multiple of four, the standard
 * alphabet, and at most two `=` at the very end.
 */
function isBase64(data: string): boolean {
  if (data.length === 0 || data.length % 4 !== 0) return false;
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  for (let index = 0; index < data.length - padding; index += 1) {
    const code = data.charCodeAt(index);
    const ok =
      (code >= 65 && code <= 90) || // A-Z
      (code >= 97 && code <= 122) || // a-z
      (code >= 48 && code <= 57) || // 0-9
      code === 43 || // +
      code === 47; // /
    if (!ok) return false;
  }
  return true;
}

const COMMISSION_JOB_TTL_MS = 10 * 60 * 1000;
/**
 * What the hub promises a pairing will take at most, so an app can count down
 * instead of guessing.
 *
 * Deliberately a little longer than the adapter's own budget rather than the
 * same number: this is the deadline a *screen* is drawn against, and one that
 * expires a second before the hub answers turns every ordinary failure into
 * two contradicting messages. The adapter is the authority on when to stop;
 * this is the promise about it.
 */
const MATTER_COMMISSION_BUDGET_MS = 5 * 60 * 1000;
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

/** A string with any query string cut off; anything else as it was. */
function withoutQuery(value: unknown): unknown {
  return typeof value === 'string' ? pathOf(value) : value;
}

/**
 * The request as the log writes it — Fastify's own fields, with the path and
 * never the query, which is where a credential travels when it travels badly.
 */
function requestForLog(request: FastifyRequest) {
  return {
    method: request.method,
    url: pathOf(request.url),
    host: request.host,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  };
}

/**
 * An API key as an app draws it — `GET /api-keys`, and the answer to every
 * route that makes or changes one.
 *
 * **What it was given beside what it can do now**: `permissions` is the
 * grant, and `effective` is that grant narrowed by what its member may do
 * today, so an app can say "can rename devices — but Alex's role no longer
 * allows that" rather than leaving somebody to work out why a key stopped. And
 * `state` says whether it works at all, separately, because a paused key still
 * has a grant worth showing.
 */
function apiKeyWire(
  key: ApiKeyRecord,
  context: {
    access: AccessService;
    memberName: string | null;
    callerId: string;
    connections: number;
    lastRefusal: ReturnType<ApiKeyService['lastRefusal']>;
  },
) {
  return {
    id: key.id,
    name: key.name,
    hint: key.hint,
    memberId: key.memberId,
    memberName: context.memberName,
    isMine: key.memberId === context.callerId,
    state: apiKeyState(key, context.access),
    control: key.control,
    permissions: key.permissions,
    effective: context.access.permissionsThrough(key.memberId, key),
    createdAt: key.createdAt.toISOString(),
    expiresAt: key.expiresAt?.toISOString() ?? null,
    lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
    lastUsedFrom: key.lastUsedFrom,
    /** Event streams open on it right now. */
    connections: context.connections,
    ...(context.lastRefusal !== undefined
      ? {
          lastRefusal: {
            at: context.lastRefusal.at.toISOString(),
            status: context.lastRefusal.status,
            error: context.lastRefusal.error,
            ...(context.lastRefusal.permission !== undefined
              ? { permission: context.lastRefusal.permission }
              : {}),
            ...(context.lastRefusal.reason !== undefined ? { reason: context.lastRefusal.reason } : {}),
            method: context.lastRefusal.method,
            path: context.lastRefusal.path,
          },
        }
      : {}),
  };
}

/**
 * The hub's local API: REST under /api/v1 plus a WebSocket event stream.
 * Auth is a bearer token — a member's, issued by the pairing claim flow, or one
 * of a member's API keys (`core/api-keys.ts`). `GET /hub`, `POST /pair` and
 * `POST /hub/proof` are the only unauthenticated routes.
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
  // Pictures of the home's rooms (`room-pictures/store.ts`): files beside the
  // database, drawn with the home's OpenAI key.
  const roomPictures = new RoomPictureService(
    deps.dataDir,
    deps.events,
    deps.log.child({ module: 'room-pictures' }),
    deps.aiRuns,
  );
  const app = Fastify({
    loggerInstance: deps.log.child(
      { module: 'api' },
      {
        ...(verbose ? {} : { level: 'warn' }),
        // **No query string reaches the journal.** A credential may be in one
        // — the apps' sockets have sent `?token=`, and an API key sent that way
        // is refused but has still arrived — and an operator who turns the log
        // up to `debug` to find a fault must not end up with a log file that
        // opens their home. Fastify's own request line is the `req` serializer;
        // `url` and `path` cover the lines that name a request directly (the
        // host guard's, and the WebSocket plugin's).
        serializers: { req: requestForLog },
        redact: { paths: ['url', 'path'], censor: (value: unknown) => withoutQuery(value) },
      },
    ) as unknown as FastifyBaseLogger,
  });
  await app.register(websocket);

  // See `ApiDeps.autoUpdate`. Loaded, never started: it answers and it
  // switches, and only the process that owns the clock lets it look at one.
  const autoUpdate =
    deps.autoUpdate ??
    (await (async () => {
      const made = createAutoUpdater({
        dataDir: deps.dataDir,
        build: deps.build,
        settings: deps.settings,
        timezone: () => deps.settings.timezone,
        activity: deps.activity,
        events: deps.events,
        rules: deps.automations,
        log: deps.log.child({ module: 'update' }),
      });
      await made.load();
      return made;
    })());

  app.decorateRequest('member', null);
  app.decorateRequest('apiKey', null);

  /**
   * What an API key may do on every route, decided when the route is
   * registered — and **closed unless a route says otherwise**.
   *
   * A route that declares nothing is `read` if it is a `GET` and `deny` if it
   * changes anything, so a write added tomorrow by somebody who never thought
   * about keys is not something a key can call. And a write that *declares*
   * `read` does not build at all: that would be every key's to call, and the
   * reason it would happen is the floor's `authed` copied onto a `POST` —
   * which is exactly the mistake worth refusing loudly rather than shipping.
   *
   * Recorded whole on `app.apiKeyPolicies`, which `test/api-keys.test.ts`
   * holds against the routes one by one.
   */
  const policies: RoutePolicy[] = [];
  app.addHook('onRoute', (route) => {
    const methods = (Array.isArray(route.method) ? route.method : [route.method]).map((m) =>
      String(m).toUpperCase(),
    );
    const reads = methods.every((method) => method === 'GET' || method === 'HEAD');
    const declared = route.config?.apiKey;
    const policy: ApiKeyPolicy = declared ?? (reads ? 'read' : 'deny');
    const label = `${methods.join(',')} ${route.url}`;
    if (policy === 'read' && !reads) {
      throw new Error(
        `${label}: a route that changes something cannot be open to every API key — ` +
          'declare it controls, keyAware, memberOnly or needs(…) instead of authed',
      );
    }
    if (policy === 'permission' && route.config?.permission === undefined) {
      throw new Error(`${label}: a permission policy has to name its permission`);
    }
    route.config = { ...route.config, apiKey: policy };
    const preHandlers = [route.preHandler].flat().filter((handler) => handler !== undefined);
    policies.push({
      method: methods.join(','),
      url: route.url,
      policy,
      ...(route.config.permission !== undefined ? { permission: route.config.permission } : {}),
      authenticated: preHandlers.some((handler) => isPrincipalHandler(handler)),
    });
  });
  app.decorate('apiKeyPolicies', policies);

  /** A member's keys for their own software — `core/api-keys.ts`. */
  const apiKeys = new ApiKeyService(deps.db);
  const principal = requirePrincipal({ pairing: deps.pairing, apiKeys, access: deps.access });

  /**
   * The floor: any member of this home, whatever their role.
   *
   * Reading the home, renaming yourself, leaving and pinning your own
   * favorites are what being a member *means*, so none of them is a permission
   * and none appears in the matrix. A role that could take them away would
   * leave somebody holding a token that can only 401, behind an app with
   * nothing to draw.
   *
   * **Reading only, as far as a key is concerned.** Every key reads what its
   * member reads; the floor's *writes* are split out below, because a key
   * that may read has not thereby been given the house.
   */
  const authed = { preHandler: [principal], config: { apiKey: 'read' as const } };
  /** The floor's writes — working a device, pressing a scene. A key needs `control`. */
  const controls = { preHandler: [principal], config: { apiKey: 'control' as const } };
  /** The handler asks for itself, because the body decides which question. */
  const keyAware = { preHandler: [principal], config: { apiKey: 'handler' as const } };
  /** The member and never one of their keys. */
  const memberOnly = { preHandler: [principal], config: { apiKey: 'deny' as const } };
  /** Everything else names the permission it needs. */
  const needs = (permission: PermissionKey) => ({
    preHandler: [principal, requirePermission(deps.access, permission)],
    config: { apiKey: 'permission' as const, permission },
  });
  /** A permission's route that no key may call even with the permission. */
  const memberOnlyNeeds = (permission: PermissionKey) => ({
    ...needs(permission),
    config: { apiKey: 'deny' as const, permission },
  });

  /**
   * Who did it, as the activity log writes it down.
   *
   * **A key acts as its member, and says so.** `memberId` and
   * `data.memberName` stay the member's, so every row is still somebody's —
   * the apps' "who" and the narrowing of the feed for a member without
   * `activity.read` both keep working — and the key rides beside it as
   * `data.via: "api"` with its id and name. The *sentence* names the key,
   * because `message` is what an app that has never heard of keys shows: a
   * light that went on at three in the morning reads "Alex’s “Node-RED” ·
   * Desk lamp: power" rather than blaming Alex's phone.
   *
   * An explicit helper at every site rather than something ambient, because
   * the obvious ambient answer — AsyncLocalStorage — would follow a key into
   * every timer the automation engine sets up while one of its requests is
   * running, and attribute a rule's next firing to it.
   */
  const actor = (request: FastifyRequest) => {
    const member = request.member!;
    const key = request.apiKey;
    if (!key) {
      return { name: member.name, memberId: member.id, data: { memberName: member.name } };
    }
    return {
      name: `${member.name}’s “${key.name}”`,
      memberId: member.id,
      data: { memberName: member.name, via: 'api', apiKeyId: key.id, apiKeyName: key.name },
    };
  };

  /**
   * Who pressed a scene or switched a mode, for the run's activity row:
   * `actor` without `data.memberName`, the one field that row must not
   * carry. The iPhone app titles a line about no device by `memberName`, and
   * a phone keeps whichever build it has — so that row would read "Anna" over
   * "Anna pressed I’m leaving", the name twice, where it has always read
   * "Hub". `memberId` and a key's fields change nothing an app draws, and they
   * are what makes the row the presser's.
   */
  const presser = (request: FastifyRequest): AutomationPresser => {
    const { name, memberId, data } = actor(request);
    const { memberName: _shownTwice, ...attribution } = data;
    return { name, memberId, data: attribution };
  };

  /**
   * What a key met, written down where its owner can find it.
   *
   * Every refusal after a key has been recognised passes through here — the
   * route guards', the handlers' and the error handler's alike — which is the
   * one place that sees them all without each route remembering to. The body
   * is a few bytes of JSON on an error path, and this runs only for a request
   * made with a key.
   */
  app.addHook('onSend', async (request, reply, payload) => {
    const key = request.apiKey;
    if (key === null || reply.statusCode < 400) return payload;
    let body: Record<string, unknown> = {};
    if (typeof payload === 'string') {
      try {
        const parsed: unknown = JSON.parse(payload);
        if (parsed !== null && typeof parsed === 'object') body = parsed as Record<string, unknown>;
      } catch {
        // Not JSON — the status is still worth having.
      }
    }
    apiKeys.noteRefusal(key.id, {
      at: new Date(),
      status: reply.statusCode,
      error: typeof body.error === 'string' ? body.error : String(reply.statusCode),
      ...(typeof body.permission === 'string' ? { permission: body.permission } : {}),
      ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
      method: request.method,
      path: pathOf(request.url),
    });
    return payload;
  });

  /**
   * Fastify's own 404, without the line its default handler logs: that one
   * writes the whole URL — query string, and any credential in it — at `info`.
   * The body is the one it has always answered with, less the query it echoed.
   */
  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      message: `Route ${request.method}:${pathOf(request.url)} not found`,
      error: 'Not Found',
      statusCode: 404,
    }),
  );

  const commissionJobs = new Map<string, CommissionJob>();
  /**
   * Who is holding a live event stream, so removing them can hang it up.
   *
   * Owned by the server rather than injected: the sockets belong to this
   * instance, and a registry outliving it would be a registry of dead ones.
   */
  const sessions = new MemberSessions();

  /**
   * Why an explicitly requested **recognition** run must not start, or `null`
   * to go ahead. Two reasons, and they need different words in the app: a hub
   * with no credential has never been able to do this, while one whose owner
   * turned recognition off is being obeyed. Only the recognition routes ask
   * it — `ai_enabled` is that job's switch alone.
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

  /**
   * Refuse a request that reached this hub under a name the local network
   * cannot mean — the DNS-rebinding guard, whose whole argument is in
   * `api/host-guard.ts`.
   *
   * `onRequest` rather than a per-route `preHandler`, and that placement is
   * the point: it lands before the body is read, before every route including
   * the three unauthenticated ones, and before the WebSocket upgrade — and
   * `GET /hub` is exactly what a rebinding page is after, so exempting the
   * public route would be exempting the target.
   *
   * `403` with the name echoed back, because the person who meets this is
   * almost never an attacker: it is somebody who reached their own hub by a
   * name nobody anticipated, and the answer has to tell them which name was
   * refused so `EXTRA_ALLOWED_HOSTS` is a thing they can act on rather than
   * guess at.
   */
  const hostAllowed = createHostCheck(deps.allowedHosts);
  const shouldLogRefusal = createRefusalLogGate();
  app.addHook('onRequest', async (request, reply) => {
    if (hostAllowed(request.headers.host)) return undefined;
    const hostname = hostnameFromHeader(request.headers.host);
    if (shouldLogRefusal(hostname)) {
      deps.log.warn(
        // The path and never the query: `deps.log` is not the API's redacting
        // logger, and a query string is where a credential travels badly.
        { host: hostname, url: pathOf(request.url) },
        'Refused a request addressed to a name this hub does not answer to. If this is how you ' +
          'reach your own hub, add it to EXTRA_ALLOWED_HOSTS in /etc/gethome/hub.env.',
      );
    }
    await reply.code(403).send({ error: 'host_not_allowed', host: hostname });
    return reply;
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) {
      // `issues` is the whole of what was wrong, for a developer. `detail` is
      // the first message, for a person: several of these schemas carry a
      // sentence written to be read — "that is a Claude subscription token",
      // "that looks like an OpenAI key — it belongs in the OpenAI field" — and
      // without somewhere for an app to find one, every such refusal reads as
      // a bare "the hub didn't accept that", which is the least useful true
      // thing it could say.
      return reply
        .code(400)
        .send({ error: 'invalid_body', detail: error.issues[0]?.message, issues: error.issues });
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
  const wifiNetworksCapability = wifiAvailability(deps.dataDir);

  /** No credential at all — the health check, the claim, and the proof. */
  const open = { config: { apiKey: 'public' as const } };

  app.get('/api/v1/hub', open, async () => ({
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
    // Additive, and presence is the capability, the portraits' way: a hub
    // carrying this block draws pictures of rooms (`/room-pictures`).
    roomPictures: roomPictures.describe(),
    // Additive, and presence is the capability once more: a hub carrying this
    // block mints **sign-in codes** (`POST /invites {memberId}`), so somebody
    // already in the home comes back on another device as themselves rather
    // than as a second person with the same name.
    //
    // An app that does not find it must not offer one, and the reason is
    // sharper than the usual "don't draw a button that can only fail": an
    // older hub's route parses the body with a schema that has never heard of
    // `memberId`, and zod *strips* what it does not know — so the request
    // succeeds and answers with an ordinary **invite**. Claiming that would
    // add exactly the duplicate person this exists to prevent, which is the
    // one refusal that must not be discovered afterwards.
    pairing: { signInCodes: true },
    // Additive, and presence is the capability: a hub carrying this block has
    // `GET/POST/DELETE /settings/wifi…`, so an app may offer to add the Wi-Fi
    // network a hub is about to be carried to. `available: false` says this
    // machine cannot — no NetworkManager, or an installer older than this —
    // with the reason, so an app can say which. Read once, at start: the
    // installer writes it and then restarts the hub, so it cannot change
    // underneath a running one, and this route must not touch the disk.
    wifiNetworks: wifiNetworksCapability,
    // Additive, and presence is the capability: a hub carrying this block has
    // `/api-keys`, so an app may offer to make a key and an agent may tell the
    // person it is helping that this hub can be given one. `grantable` is what
    // a key may be handed beyond reading and `control`, so an app draws the
    // choices this hub will accept rather than a list from its own build.
    // Static, and therefore cannot throw — this route is the health check.
    apiKeys: { grantable: KEY_GRANTABLE },
    // Additive, and presence is the capability: a hub carrying this block
    // takes `model`, `effort` and `attachments` on a chat message, with the
    // words `effort` accepts and how many photos of what size and type. An
    // older hub's zod strips all three and answers 201 — a photo the model
    // never saw, a model the chat never moved to — so an app that does not
    // find this offers none of them. A constant, so it cannot throw either.
    chat: CHAT_CAPABILITY,
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
   * Prove this hub is itself, at this address, to an app holding one of its
   * tokens — before that app sends the token here. `core/hub-proof.ts` has the
   * argument; this is what an app asks a hub it has followed to a new address.
   *
   * Public, like `GET /hub`, because the whole point is that no credential has
   * been sent yet. One refusal for an unknown token and for an address that is
   * not this hub's, so the route answers neither question on its own. And no
   * capability on `GET /hub` for it, deliberately: the address being checked is
   * the one that cannot be trusted to say so, and a hub without this route
   * answers 404, which an app treats as "not proven" and does not follow.
   */
  const ownAddresses = deps.ownAddresses ?? ownIPv4Addresses;
  app.post('/api/v1/hub/proof', open, async (request, reply) => {
    const body = z
      .object({
        nonce: z.string().regex(/^[0-9a-f]{32,128}$/),
        address: z.string().max(64),
        tokenId: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .parse(request.body);
    const target = proofAddress(body.address);
    // The port too, not only the host: an address check alone signed for any
    // port on the hub's own addresses, so anything able to listen on another
    // port on this machine could relay an app's challenge here under its own
    // address and get a proof back for it. The port the challenge arrived on
    // is the one the app dialled whenever nothing stood in between. It is
    // unknown only for a request with no socket at all — a suite's `inject` —
    // and every real connection has one.
    const arrivedOn = request.socket.localPort;
    const tokenHash =
      target !== undefined &&
      ownAddresses().includes(target.host) &&
      (arrivedOn === undefined || target.port === arrivedOn)
        ? await deps.pairing.tokenHashForProof(body.tokenId)
        : undefined;
    if (tokenHash === undefined) return reply.code(403).send({ error: 'proof_refused' });
    return {
      hubId: deps.hubId,
      proof: proveIdentity(tokenHash, deps.hubId, body.nonce, body.address),
    };
  });

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

  app.post('/api/v1/pair', open, async (request, reply) => {
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
    // Two arrivals, two sentences. A sign-in adds a device to somebody who is
    // already here, so saying they "joined the home as Member" would report a
    // person arriving every time they picked up their tablet — and the feed is
    // read a week later, where that reads as somebody being added twice.
    const joinMessage = role
      ? `${result.member.name} joined the home as ${role.name}.`
      : `${result.member.name} joined the home.`;
    // The device rides in the **sentence**, not in `data.deviceName`: that key
    // means a device *in the home* everywhere else in this log, and an app
    // reading it would title the row "iPad" as though somebody had paired one.
    const signedInMessage = body.deviceName
      ? `${result.member.name} signed in on ${body.deviceName}.`
      : `${result.member.name} signed in on another device.`;
    await deps.activity.record({
      kind: result.signedIn ? 'member.signed-in' : 'member.joined',
      message: result.signedIn ? signedInMessage : joinMessage,
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
        permissions: deps.access.permissionsAs(result.member.id, null),
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
    const who = actor(request);
    await deps.activity.record({
      kind: 'home.renamed',
      message: `${who.name} renamed the home to “${body.name}”.`,
      memberId: who.memberId,
      data: { homeName: body.name, ...who.data },
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
    const who = actor(request);
    await deps.activity.record({
      kind: 'room.added',
      message: `${who.name} added the room “${body.name}”.`,
      memberId: who.memberId,
      data: { roomName: body.name, ...who.data },
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
      const who = actor(request);
      await deps.activity.record({
        kind: 'room.renamed',
        message: `${who.name} renamed “${before.name}” to “${body.name}”.`,
        memberId: who.memberId,
        data: {
          roomName: body.name,
          previousName: before.name,
          ...who.data,
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
    // A picture of a room that is gone is a picture of nothing.
    await roomPictures.forgetRoom(id);
    const who = actor(request);
    await deps.activity.record({
      kind: 'room.removed',
      message: `${who.name} removed the room “${room.name}”.`,
      memberId: who.memberId,
      data: { roomName: room.name, ...who.data },
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
    const who = actor(request);
    await deps.activity.record({
      kind: 'zone.added',
      message: `${who.name} added the zone “${body.name}”.`,
      memberId: who.memberId,
      data: { zoneName: body.name, ...who.data },
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
      const who = actor(request);
      await deps.activity.record({
        kind: 'zone.renamed',
        message: `${who.name} renamed the zone “${before.name}” to “${body.name}”.`,
        memberId: who.memberId,
        data: {
          zoneName: body.name,
          previousName: before.name,
          ...who.data,
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
    const who = actor(request);
    await deps.activity.record({
      kind: 'zone.removed',
      message: `${who.name} removed the zone “${zone.name}”.`,
      memberId: who.memberId,
      data: { zoneName: zone.name, ...who.data },
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

  // ── Room pictures — `room-pictures/store.ts`, `docs/api.md` → *Room pictures*

  /**
   * Who reads the devices off a picture: device recognition's provider and
   * model, on the home's key — and nobody, when the home has no usable key,
   * which leaves the markers to the apps and to people.
   */
  const pictureLocator: Locator = async () => {
    const ai = await deps.settings.getAiSettings();
    let provider = ai.provider;
    if (provider === 'anthropic' && ai.legacySubscriptionToken) provider = ai.openai.hasKey ? 'openai' : null;
    if (!provider) return null;
    const apiKey = await deps.settings.aiKey(provider);
    if (!apiKey) return null;
    return { provider, modelId: effectiveModel(provider, ai[provider].model), apiKey };
  };

  /** A room's devices as the picture prompts name them. */
  const pictureDevices = (roomId: string) =>
    deps.registry
      .listDevices()
      .filter((device) => device.roomId === roomId)
      .map((device) => ({ id: device.id, name: device.name, kind: device.endpoints[0]?.deviceKind ?? 'appliance' }));

  /** Every room's pictures, newest first. Reading is the floor. */
  app.get('/api/v1/room-pictures', authed, async () => ({ pictures: roomPictures.list() }));

  /** One picture's PNG, by day or by night — never changes once drawn. */
  app.get('/api/v1/room-pictures/:id/:variant', authed, async (request, reply) => {
    const params = z.object({ id: z.uuid(), variant: z.enum(['day', 'night']) }).parse(request.params);
    const etag = `"${params.id}-${params.variant}"`;
    if (request.headers['if-none-match'] === etag) return reply.code(304).send();
    const bytes = await roomPictures.bytes(params.id, params.variant);
    if (!bytes) return reply.code(404).send({ error: 'not_found' });
    return reply
      .header('content-type', 'image/png')
      .header('cache-control', 'public, max-age=31536000, immutable')
      .header('etag', etag)
      .send(bytes);
  });

  /**
   * Draw a room from photos of it. `hub.ai`, because it spends the home's
   * money — the portraits' key for the portraits' reason — and OpenAI's job,
   * so its own refusal when that key is missing. Answers once the day picture
   * is drawn and its devices read off it, about a minute; the night follows
   * and is announced. One at a time, refused rather than queued.
   */
  app.post(
    '/api/v1/room-pictures',
    { ...needs('hub.ai'), bodyLimit: PHOTO_BODY_LIMIT },
    async (request, reply) => {
      const body = z
        .object({
          roomId: z.uuid(),
          orientation: z.enum(['portrait', 'landscape']).default('portrait'),
          photos: z
            .array(z.object({ data: z.string().min(64), type: z.enum(['image/jpeg', 'image/png']).default('image/jpeg') }))
            .min(1)
            .max(MAX_PHOTOS),
        })
        .parse(request.body);
      const room = await deps.db.query.rooms.findFirst({ where: eq(rooms.id, body.roomId) });
      if (!room) return reply.code(404).send({ error: 'not_found' });

      const apiKey = await deps.settings.aiKey('openai');
      if (!apiKey) return reply.code(409).send({ error: 'openai_not_configured' });

      // For the reading afterwards only: the drawing is told about no device,
      // so it draws none the photos don't show (`room-pictures/prompts.ts`).
      const devices = pictureDevices(room.id);

      try {
        return await roomPictures.draw({
          roomId: room.id,
          roomName: room.name,
          orientation: body.orientation,
          photos: body.photos.map((photo) => ({ bytes: Buffer.from(photo.data, 'base64'), contentType: photo.type })),
          devices,
          apiKey,
          locator: pictureLocator,
          member: { id: request.member!.id, name: request.member!.name },
        });
      } catch (error) {
        if (error instanceof PictureBusyError) {
          return reply.code(409).send({ error: 'picture_busy', detail: error.message });
        }
        if (error instanceof PictureSpaceError) {
          return reply.code(409).send({ error: 'no_space', detail: error.message });
        }
        if (error instanceof RoomPictureDrawError) {
          return reply.code(502).send({ error: 'provider_failed', kind: error.kind, detail: error.message });
        }
        throw error;
      }
    },
  );

  /**
   * Where the devices stand on a picture, as a person placed them. The whole
   * list, replacing the old — `home.structure`, since it is how the home is
   * shown to everybody in it.
   */
  /**
   * Where the devices stand on a picture, and which picture its room shows —
   * both how the home is shown, so both `home.structure`. Either or both.
   */
  app.patch('/api/v1/room-pictures/:id', needs('home.structure'), async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z
      .object({
        markers: z
          .array(
            z.object({
              deviceId: z.string().min(1).max(160),
              x: z.number().min(0).max(1),
              y: z.number().min(0).max(1),
              source: z.string().max(20).default('placed'),
            }),
          )
          .max(400)
          .optional(),
        selected: z.literal(true).optional(),
      })
      .refine((value) => value.markers !== undefined || value.selected === true, 'nothing to change')
      .parse(request.body);
    if (!roomPictures.get(id)) return reply.code(404).send({ error: 'not_found' });
    if (body.markers) roomPictures.setMarkers(id, body.markers);
    if (body.selected) roomPictures.select(id);
    return roomPictures.get(id);
  });

  /** Read the devices off a picture again — for devices added since. Keeps placed markers. */
  app.post('/api/v1/room-pictures/:id/locate', needs('hub.ai'), async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const existing = roomPictures.get(id);
    if (!existing) return reply.code(404).send({ error: 'not_found' });
    const record = await roomPictures.relocate(id, pictureDevices(existing.roomId), pictureLocator);
    if (!record) return reply.code(404).send({ error: 'not_found' });
    return record;
  });

  app.delete('/api/v1/room-pictures/:id', needs('home.structure'), async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const roomId = await roomPictures.remove(id);
    if (roomId === null) return reply.code(404).send({ error: 'not_found' });
    return reply.code(204).send();
  });

  app.get('/api/v1/devices', authed, async (request) => {
    const memberId = request.member!.id;
    const view = deviceWireView(deps, memberId, request.apiKey);
    return deps.registry
      .listDevices()
      .map((device) => deviceWire(device, deps.favorites.isFavorite(memberId, device.id), view));
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
   *
   * **And it is why a key is asked here too**: a pin is the floor's write, so
   * a key needs `control` for it, while the house's half is `device.edit`
   * through the key like anywhere else.
   */
  app.patch('/api/v1/devices/:id', keyAware, async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z
      .object({
        name: z.string().trim().min(1).max(80).optional(),
        roomId: z.uuid().nullable().optional(),
        favorite: z.boolean().optional(),
        /**
         * "This one being offline is fine" — or, false, taking that back.
         *
         * A boolean in and a moment back out, because what an app sends is a
         * decision and what it draws is *since when*. It is the house's, so it
         * sits with `name` and `roomId` under `device.edit` rather than beside
         * `favorite`: silencing the home's own alarm for everybody is not
         * something a guest staying the weekend should be able to do.
         */
        offlineExpected: z.boolean().optional(),
      })
      .parse(request.body);
    const memberId = request.member!.id;
    const touchesTheHouse =
      body.name !== undefined || body.roomId !== undefined || body.offlineExpected !== undefined;
    if (touchesTheHouse && !can(deps.access, request, 'device.edit')) {
      return reply.code(403).send({ error: 'forbidden', permission: 'device.edit' });
    }
    if (body.favorite !== undefined && !mayControl(request)) {
      return reply.code(403).send({ error: 'key_read_only' });
    }
    const who = actor(request);
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
    const wasExcused = before.offlineExpectedAt !== null;

    if (body.favorite !== undefined) {
      await deps.favorites.set(memberId, id, body.favorite);
    }

    if (body.offlineExpected !== undefined && body.offlineExpected !== wasExcused) {
      await deps.registry.setOfflineExpected(
        id,
        body.offlineExpected ? { id: memberId, name: request.member!.name } : undefined,
      );
      // One row per decision, and only when it *is* one — an app re-sending
      // what the hub already holds says nothing worth reading in a week. The
      // automatic clear writes nothing of its own: the device coming back
      // already writes `device.online`, and two lines for one event is the
      // burst the feed's whole shape exists to avoid.
      await deps.activity.record({
        kind: 'device.offline-expected',
        message: body.offlineExpected
          ? `${who.name} said ${before.name} being offline is expected.`
          : `${who.name} said ${before.name} being offline is not expected after all.`,
        deviceId: id,
        memberId,
        data: {
          deviceName: before.name,
          ...who.data,
          expected: body.offlineExpected,
        },
      });
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
        message: `${who.name} renamed “${previousName}” to “${body.name}”.`,
        deviceId: device.id,
        memberId,
        data: {
          deviceName: body.name,
          previousName,
          ...who.data,
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
          ? `${who.name} moved ${device.name} to ${room.name}.`
          : `${who.name} took ${device.name} out of its room.`,
        deviceId: device.id,
        memberId,
        data: {
          deviceName: device.name,
          // Absent is "out of every room", which is a real answer and the
          // reason the sentence above has two forms.
          ...(room ? { roomName: room.name } : {}),
          ...who.data,
        },
      });
    }
    return deviceWire(
      device,
      deps.favorites.isFavorite(memberId, id),
      deviceWireView(deps, memberId, request.apiKey),
    );
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
   *
   * A key needs `control` — the floor is the member's, and a key that may
   * read has not thereby been given the house. Locks included: a key with
   * `control` can unlock the door its member can.
   */
  app.post('/api/v1/devices/:id/endpoints/:endpointId/commands', controls, async (request, reply) => {
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
    const who = actor(request);
    await deps.activity.record({
      kind: 'device.command',
      message: `${who.name} · ${device.name}: ${command.type}`,
      deviceId: device.id,
      memberId: who.memberId,
      // The whole command, not a summary of it: it is schema-bounded (the
      // largest is a 400-character custom field) and it is what lets an app
      // write "Turned on" instead of "power". The two names ride along
      // because both ids are `ON DELETE SET NULL` — a week later this row may
      // be all that is left of the device.
      data: { command, deviceName: device.name, ...who.data },
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
    // Answers as soon as the run is under way, never when it ends — see
    // `ZigbeeAdapter.remap`. What the agent then did arrives on the `ai`
    // stream and in `GET /ai/runs`.
    return { requested: deps.zigbee.remap(device.externalId) };
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
   * Deliberately synchronous. It holds the request for the minutes an image
   * takes — two to five on a real hub — which is what lets the app show one
   * uninterrupted animation from "reading your photo" to the finished portrait;
   * and if the phone gives up or walks out of range, the hub finishes, stores
   * and announces it anyway, so nothing is lost but the animation.
   *
   * A second asker gets `409 portrait_busy` rather than a place in a queue,
   * and the reason is money before it is time: every drawing bills the home,
   * so a queue turns four impatient taps into four charges while a refusal
   * makes the second one free. See `PortraitService.draw`.
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
      // gated on `ai_enabled`, which is device recognition's switch — nobody
      // draws a portrait by accident, so there is nothing to switch off.
      const apiKey = await deps.settings.aiKey('openai');
      if (!apiKey) return reply.code(409).send({ error: 'openai_not_configured' });

      const kind = device.endpoints[0]?.deviceKind;
      if (!kind) return reply.code(409).send({ error: 'device_has_no_kind' });

      try {
        const portrait = await deps.portraits.draw({
          deviceId: id,
          kind,
          apiKey,
          // Recorded on the picture as well as in the log below: the log is
          // bounded at 30 days and a portrait is not, so this is the copy that
          // is still there when somebody asks who drew it.
          member: { id: request.member!.id, name: request.member!.name },
          ...(body.photo !== undefined
            ? { photo: { bytes: Buffer.from(body.photo, 'base64'), contentType: body.photoType } }
            : {}),
        });
        // Recorded because it spent money and everybody in the home now sees a
        // different picture. Only the drawing: choosing between portraits and
        // deleting one are restyles, and a restyle is not what somebody reads
        // the log for a week later — the same line `rooms.icon` holds.
        const who = actor(request);
        await deps.activity.record({
          kind: 'device.portrait',
          message: `${who.name} had a new portrait drawn for ${device.name}.`,
          memberId: who.memberId,
          deviceId: id,
          data: { ...who.data, deviceName: device.name },
        });
        announcePortraits(id);
        return portrait;
      } catch (error) {
        if (error instanceof PortraitBusyError) {
          return reply.code(409).send({ error: 'portrait_busy', detail: error.message });
        }
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
    const body = z
      .object({
        pairingCode: z.string().min(8).max(128),
        /**
         * The Wi-Fi to hand an accessory that has none, for a hub that cannot
         * read its own (`core/wifi.ts`). Never logged and never stored: it goes
         * straight into the commissioning conversation and is forgotten with
         * the job.
         */
        wifi: z
          .object({ ssid: z.string().min(1).max(32), passphrase: z.string().min(8).max(63) })
          .optional(),
      })
      .parse(request.body);
    // One at a time, and said as a refusal rather than a queue: the second
    // caller is a second *person*, in a house where somebody is already
    // standing over an accessory holding its button down.
    if (deps.matter.isCommissioning) {
      return reply.code(409).send({ error: 'already_commissioning' });
    }
    // Recorded on the *request*, not on the result: the hub's log is what was
    // asked for, and the accessory's own arrival is the registry's
    // `device.added` a moment later. The pairing code never goes in — it is a
    // credential for the accessory, and this log is read by every member.
    const who = actor(request);
    await deps.activity.record({
      kind: 'matter.commission',
      message: `${who.name} started pairing a Matter accessory.`,
      memberId: who.memberId,
      data: { ...who.data },
    });
    const startedAt = Date.now();
    const job: CommissionJob = {
      id: randomUUID(),
      status: 'running',
      step: 'looking',
      memberId: request.member!.id,
      startedAt,
      deadline: startedAt + MATTER_COMMISSION_BUDGET_MS,
    };
    commissionJobs.set(job.id, job);
    /**
     * One place that moves a job and tells everybody, so the frame and the
     * polled route can never disagree about it — which is exactly how a screen
     * ends up stranded on "working…" while `GET` already says it failed.
     */
    const move = (
      status: CommissionJob['status'],
      extra?: { step?: CommissionStep; nodeId?: string; failure?: CommissionFailure },
    ): void => {
      job.status = status;
      const step = status === 'running' ? (extra?.step ?? job.step) : undefined;
      if (step === undefined) delete job.step;
      else job.step = step;
      if (extra?.nodeId !== undefined) job.nodeId = extra.nodeId;
      if (extra?.failure !== undefined) {
        job.failure = extra.failure;
        job.error = extra.failure.summary;
      }
      deps.events.emit('commissioningProgress', {
        jobId: job.id,
        status,
        ...(job.step !== undefined ? { step: job.step } : {}),
        ...(job.nodeId !== undefined ? { nodeId: job.nodeId } : {}),
        ...(job.failure !== undefined ? { failure: job.failure } : {}),
        deadline: job.deadline,
      });
    };
    move('running', { step: 'looking' });
    void deps
      .matter!.commission({
        pairingCode: body.pairingCode,
        ...(body.wifi !== undefined
          ? { wifi: { ssid: body.wifi.ssid, passphrase: body.wifi.passphrase } }
          : {}),
        onProgress: (step) => {
          // Only forwards, and only while the job is still running: a late
          // `pairing` arriving after a cancel would reopen a finished screen.
          if (step === 'pairing' && job.status === 'running' && job.step === 'looking') {
            move('running', { step: 'pairing' });
          }
        },
      })
      .then((nodeId) => move('done', { nodeId }))
      .catch((error: unknown) => {
        const failure =
          error instanceof CommissionError ? error.failure : commissionFailure('failed', String(error));
        // **Logged**, which it was not. A pairing that fails is the single most
        // asked-about thing this hub does, and until now the only record of one
        // was a WebSocket frame that had already gone — so the journal of a hub
        // whose owner could not pair anything showed one line saying discovery
        // had started and nothing else, ever.
        deps.log.warn({ kind: failure.kind, detail: failure.detail }, 'Matter pairing failed.');
        move('failed', { failure });
      })
      .finally(() => forgetJobLater(job.id));
    return reply.code(202).send({ jobId: job.id, deadline: job.deadline });
  });

  /**
   * What the hub can hear right now.
   *
   * **The question this answers is asked before the code is typed, not after
   * the pairing fails.** Bluetooth range is the one part of this whole flow
   * nobody can see, and `not-found` is the same sentence for "too far from the
   * hub" and "never went into pairing mode" — two problems with completely
   * different fixes, and an app that cannot tell them apart sends half the
   * people who meet it to do the wrong thing.
   *
   * `device.add`, because it *is* adding a device: the same permission, the
   * same act, one step earlier. And it drives a radio for a few seconds, which
   * is reason enough not to put it behind the floor where anything could poll
   * it.
   */
  app.get('/api/v1/matter/discoverable', needs('device.add'), async (request, reply) => {
    if (!deps.matter) return reply.code(409).send({ error: 'matter_disabled' });
    // Bounded low deliberately: this holds the request open for its whole
    // length. Long enough for an accessory advertising on the usual cadence to
    // be heard at least once, short enough that a screen can ask on arrival.
    const { seconds } = z
      .object({ seconds: z.coerce.number().int().min(2).max(15).default(6) })
      .parse(request.query ?? {});
    if (deps.matter.isCommissioning) {
      return reply.code(409).send({ error: 'already_commissioning' });
    }
    try {
      const devices = await deps.matter.discoverable(seconds);
      return {
        /** So a client can say how long it listened rather than guessing. */
        scannedMs: seconds * 1000,
        /** Whether Bluetooth was part of the listening — see `GET /hub`. */
        bluetooth: deps.matter.bleStatus.enabled,
        devices,
      };
    } catch (error) {
      deps.log.warn({ err: error }, 'Matter: could not look for accessories.');
      return reply.code(409).send({ error: 'already_commissioning' });
    }
  });

  app.get('/api/v1/matter/commission/:jobId', authed, async (request, reply) => {
    const { jobId } = z.object({ jobId: z.uuid() }).parse(request.params);
    const job = commissionJobs.get(jobId);
    if (!job) return reply.code(404).send({ error: 'not_found' });
    return job;
  });

  /**
   * Call off a pairing.
   *
   * Worth having because the wait is long and the commonest reason to abandon
   * it is knowing already that it will fail — the wrong code, the wrong box,
   * an accessory whose light stopped blinking while somebody looked for their
   * phone. Three minutes of a spinner they cannot stop is three minutes of an
   * app that looks broken.
   *
   * **Whoever started it, or anybody who could have.** The permission is the
   * same one that starts a pairing: a hub does one at a time, so "cancel" is
   * about the *hub*, and a second member who cannot stop the first one's
   * abandoned job cannot pair anything either until it times out.
   */
  app.post('/api/v1/matter/commission/:jobId/cancel', needs('device.add'), async (request, reply) => {
    const { jobId } = z.object({ jobId: z.uuid() }).parse(request.params);
    const job = commissionJobs.get(jobId);
    if (!job) return reply.code(404).send({ error: 'not_found' });
    // Already finished is not an error: the app pressed Cancel a moment after
    // the hub gave up, and telling it off for that would be telling it off for
    // the race the hub arranged. The job's own status is the answer.
    if (job.status !== 'running') return job;
    deps.matter?.cancelCommissioning();
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
    const who = actor(request);
    await deps.activity.record(
      state.active
        ? {
            kind: 'zigbee.permit-join',
            message: `${who.name} opened the Zigbee network for ${Math.round(state.remainingSeconds / 60)} min.`,
            memberId: who.memberId,
            data: { ...who.data, seconds: state.remainingSeconds },
          }
        : {
            kind: 'zigbee.permit-join-closed',
            message: `${who.name} closed the Zigbee network.`,
            memberId: who.memberId,
            data: { ...who.data },
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
    const key = request.apiKey;
    return {
      id: me.id,
      name: me.name,
      role: role ? { id: role.id, key: role.key, name: role.name } : null,
      // Through a key, what *this key* may do — its grant, narrowed by what
      // its member may do now — because that is the question its software is
      // asking. `role` and `isOwner` stay facts about the member.
      permissions: deps.access.permissionsAs(me.id, key),
      isOwner: deps.access.isOwner(me.id),
      // Present only through a key, which is how software tells that it is
      // holding one and what it was given — `control` above all, since
      // working the home is not a permission and so is never in the list.
      ...(key
        ? {
            apiKey: {
              id: key.id,
              name: key.name,
              control: key.control,
              permissions: key.permissions,
              state: apiKeyState(key, deps.access),
              expiresAt: key.expiresAt?.toISOString() ?? null,
            },
          }
        : {}),
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
    const who = actor(request);
    await deps.activity.record({
      kind: 'role.added',
      message: `${who.name} added the role ${role.name}.`,
      memberId: who.memberId,
      data: { roleName: role.name, ...who.data },
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
    const who = actor(request);
    if (body.permissions !== undefined) {
      await deps.activity.record({
        kind: 'role.changed',
        message: `${who.name} changed what ${result.name} can do.`,
        memberId: who.memberId,
        data: { roleName: result.name, ...who.data },
      });
    }
    if (body.name !== undefined && before && before.name !== result.name) {
      await deps.activity.record({
        kind: 'role.renamed',
        message: `${who.name} renamed the role ${before.name} to ${result.name}.`,
        memberId: who.memberId,
        data: {
          roleName: result.name,
          previousName: before.name,
          ...who.data,
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
    const who = actor(request);
    await deps.activity.record({
      kind: 'role.removed',
      message: `${who.name} removed the role ${name ?? 'that was there'}.`,
      memberId: who.memberId,
      data: { ...(name ? { roleName: name } : {}), ...who.data },
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
    const who = actor(request);
    await deps.activity.record({
      kind: 'member.role-changed',
      message: `${who.name} made ${target.name} ${wanted.name}.`,
      memberId: who.memberId,
      data: {
        ...who.data,
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
   *
   * **The member's and never a key's**: what somebody is called is theirs to
   * say, and a script renaming its own person would put words in their mouth.
   */
  app.patch('/api/v1/members/me', memberOnly, async (request) => {
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
      permissions: deps.access.permissionsAs(before.id, request.apiKey),
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
   *
   * Never through a key: a key acts as its member, and leaving is the one
   * decision that has to be the member's own.
   */
  app.delete('/api/v1/members/me', memberOnly, async (request, reply) => {
    const member = request.member!;
    if (deps.access.isLastOwner(member.id)) {
      return reply.code(409).send({ error: 'cannot_remove_owner' });
    }
    await deleteMemberRow(member.id);
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
    await deleteMemberRow(id);
    await endMembership(
      target.id,
      `${actor(request).name} removed ${target.name} from the home.`,
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
  /**
   * Delete a member row, taking any **sign-in codes** minted for them with it.
   *
   * `invites.member_id` is a column added by `ALTER TABLE`, so it carries no
   * `ON DELETE` action — SQLite cannot attach one — and the raw foreign key
   * would refuse the delete, turning "remove somebody from the home" into a
   * 500 whenever a code for them was still in the air. This is the
   * `invites.role_id` rule pointed at a member, and it comes out the same way:
   * a code whose whole content is "sign in as this person" means nothing once
   * that person is gone, and leaving it to expire would be a fifteen-minute
   * window in which a removed member could still let themselves back in. Used
   * and expired rows go too, since nothing reads them and a row that isn't
   * there is simply not a code.
   */
  async function deleteMemberRow(memberId: string) {
    await deps.db.delete(invites).where(eq(invites.memberId, memberId));
    await deps.db.delete(members).where(eq(members.id, memberId));
  }

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
    // Their keys went with the row too (`api_keys.member_id` cascades), and
    // their sockets with `sessions.revoke` above; this drops what was held
    // about the keys in memory — last use, last refusal, the rate bucket.
    apiKeys.forgetMember(memberId);
    await deps.activity.record({ kind, message });
  }

  /**
   * The codes that are still live.
   *
   * `memberId` is what tells an **invite** from a **sign-in code**: null means
   * claiming it adds somebody, a value means it lets that person on to another
   * device. A derived `kind` beside it would be a second copy of one fact, so
   * there isn't one — the same shape `roomId: null` gives a rule about the
   * whole house.
   */
  app.get('/api/v1/invites', needs('member.invite'), async () => {
    const rows = await deps.db.query.invites.findMany();
    const memberNames = new Map(
      (await deps.db.query.members.findMany()).map((row) => [row.id, row.name]),
    );
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
          memberId: row.memberId,
          memberName: row.memberId ? (memberNames.get(row.memberId) ?? null) : null,
          expiresAt: row.expiresAt,
        };
      });
  });

  /**
   * Mint a code — for a role, or **for somebody who is already here**.
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
   *
   * **`memberId` makes it a sign-in code instead**, and that is the whole of
   * how a second device — or one whose app was deleted and installed again —
   * comes back as the same person. Claiming it inserts nobody, so the AI
   * conversations, the activity attributed to them and their own favorites are
   * still theirs. It is deliberately the *same* route, table, expiry, single
   * use and `/pair` endpoint: two ways to mint one code beats a second code
   * with its own rate limit, its own replay window and its own way of being
   * wrong. Naming both is `400 invalid_target` rather than a silent
   * precedence, because a `roleId` beside a member who already has one can
   * only be a client that meant something.
   *
   * **Who may ask is asked of the body**, which is why this is `authed` with
   * the check inside rather than `needs(…)`. `PATCH /devices/:id` is the
   * precedent and the reason is the same: one field decides which question to
   * ask. Three answers.
   *
   * *Your own* is the **floor** — no permission at all, and `me` is accepted
   * as the id for a client that has never learnt its own. It grants exactly
   * the authority the caller is already holding a token for, and anybody who
   * can ask for one could simply copy that token to the other device, so a key
   * over it would be a lock on the front door of a house with no walls. The
   * companion to `PATCH /members/me` and `DELETE /members/me`.
   *
   * *Somebody else's* is `member.invite`, because it is that permission's own
   * sentence — putting a person into this home — with the person already
   * named. What it adds over minting them a fresh invite is their *history*,
   * not authority: whoever can invite could already create a peer at any
   * non-owner role. That is worth a line in the activity log, which it gets,
   * and it is not worth a permission of its own that every home would have to
   * understand for a thing that happens once a year.
   *
   * *An owner's* needs an owner (`403 not_owner`), because there the identity
   * **is** the authority: without it `member.invite` — which a home may hand
   * to a role it invented — would quietly mean "become the owner". The same
   * guard `POST /invites {roleId: owner}` and `PATCH /members/:id` carry, and
   * the same code, which both apps already read as "ask an owner".
   */
  app.post('/api/v1/invites', memberOnly, async (request, reply) => {
    const body = z
      .object({
        roleId: z.uuid().optional(),
        // `me` for the same reason `PATCH /members/me` takes it: the member id
        // is handed back exactly once, by `POST /pair`, and a client that
        // claimed over SSH never saw one at all.
        memberId: z.union([z.literal('me'), z.uuid()]).optional(),
      })
      .parse(request.body ?? {});
    const caller = request.member!;

    if (body.memberId !== undefined) {
      if (body.roleId) return reply.code(400).send({ error: 'invalid_target' });
      const targetId = body.memberId === 'me' ? caller.id : body.memberId;
      const target = await deps.db.query.members.findFirst({ where: eq(members.id, targetId) });
      if (!target) return reply.code(404).send({ error: 'unknown_member' });
      const forSelf = target.id === caller.id;
      if (!forSelf && !can(deps.access, request, 'member.invite')) {
        return reply.code(403).send({ error: 'forbidden', permission: 'member.invite' });
      }
      if (!forSelf && deps.access.isOwner(target.id) && !deps.access.isOwner(caller.id)) {
        return reply.code(403).send({ error: 'not_owner' });
      }
      const code = await deps.pairing.createSignInCode(caller.id, target.id);
      if (!code) return reply.code(404).send({ error: 'unknown_member' });
      // Minting one for yourself is your own business and logging every "and
      // my iPad too" would be noise. Minting one for somebody else hands over
      // their identity for fifteen minutes, and a home that can delegate
      // `member.invite` has to be able to see who did that — the same reason
      // reading the broker password writes a line.
      if (!forSelf) {
        await deps.activity.record({
          kind: 'member.signin-code',
          message: `${caller.name} created a sign-in code for ${target.name}.`,
          memberId: caller.id,
          // `subjectName` rather than a word of its own: `member.role-changed`
          // already means "who this was done to" by it, and one idea in two
          // vocabularies is how an app comes to render one of them as nothing.
          data: { memberName: caller.name, subjectName: target.name },
        });
      }
      return reply.code(201).send({
        code: code.code,
        expiresAt: code.expiresAt,
        roleId: null,
        roleName: null,
        memberId: code.memberId,
        memberName: code.memberName,
      });
    }

    if (!can(deps.access, request, 'member.invite')) {
      return reply.code(403).send({ error: 'forbidden', permission: 'member.invite' });
    }
    if (body.roleId) {
      const role = deps.access.role(body.roleId);
      if (!role) return reply.code(404).send({ error: 'unknown_role' });
      if (role.key === OWNER_ROLE_KEY && !deps.access.isOwner(caller.id)) {
        return reply.code(403).send({ error: 'not_owner' });
      }
    }
    const invite = await deps.pairing.createInvite(caller.id, body.roleId);
    const role = invite.roleId ? deps.access.role(invite.roleId) : undefined;
    return reply.code(201).send({
      code: invite.code,
      expiresAt: invite.expiresAt,
      roleId: invite.roleId,
      roleName: role?.name ?? null,
      memberId: null,
      memberName: null,
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
    // Through a key, the key's own grant decides — a key without
    // `activity.read` reads its member's rows, as its member would without it.
    const mine = can(deps.access, request, 'activity.read') ? undefined : request.member!.id;
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

  // ── API keys ─────────────────────────────────────────────────────────────

  /**
   * Keys for a person's own software — a script, a bridge, an AI agent.
   *
   * **Every route here is the member's and never a key's**: a key does not
   * make, change, read or revoke keys, so a leaked one cannot mint a
   * replacement that outlives the revoke. `core/api-keys.ts` and
   * `AccessService.canThrough` are the model; these are the four doors.
   */
  const keyFields = {
    name: z.string().trim().min(1).max(80),
    control: z.boolean(),
    permissions: z.array(z.string().min(1).max(64)).max(32),
    expiresInDays: z.number().int().min(1).max(MAX_KEY_LIFETIME_DAYS).nullable(),
  };
  /**
   * **Strict**, unlike nearly every other body here, and that is the point:
   * zod strips what it does not know, so a field a later build adds to narrow
   * a key — rooms, devices — would be silently dropped by this one, which
   * would then make a key *broader* than the person asked for. A 400 instead
   * is the only safe answer an older hub can give.
   */
  const createKeySchema = z
    .object({
      name: keyFields.name,
      control: keyFields.control.optional(),
      permissions: keyFields.permissions.optional(),
      expiresInDays: keyFields.expiresInDays.optional(),
    })
    .strict();
  const changeKeySchema = z
    .object({
      name: keyFields.name.optional(),
      control: keyFields.control.optional(),
      permissions: keyFields.permissions.optional(),
      expiresInDays: keyFields.expiresInDays.optional(),
    })
    .strict();

  const expiryFrom = (days: number | null | undefined): Date | null =>
    days === null || days === undefined ? null : new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  /**
   * Why a grant cannot be given, or undefined if it can.
   *
   * Three refusals, in the order a person would fix them. A permission no key
   * may ever hold is `400 not_grantable` — it is the request that is wrong.
   * `automation.manage` without `control` is `400 needs_control`, because a
   * rule switches devices on its own and a key that may write one but not
   * work the home would work it a minute later. And a permission the person
   * does not hold themselves is `403 forbidden`, the refusal they would meet
   * using it: **nobody can give a key more than they have.** Only what is
   * being *added* is asked of the role, so renaming a key whose member has
   * since lost something is not refused for it — that part of the grant is
   * already inert, and `effective` says so.
   */
  const grantRefusal = (
    request: FastifyRequest,
    control: boolean,
    permissions: readonly string[],
    already: readonly PermissionKey[] = [],
  ): { status: number; body: Record<string, unknown> } | undefined => {
    for (const permission of permissions) {
      if (!isKeyGrantable(permission)) {
        return { status: 400, body: { error: 'not_grantable', permission } };
      }
    }
    if (permissions.includes('automation.manage') && !control) {
      return { status: 400, body: { error: 'needs_control', permission: 'automation.manage' } };
    }
    for (const permission of permissions as readonly PermissionKey[]) {
      if (!already.includes(permission) && !can(deps.access, request, permission)) {
        return { status: 403, body: { error: 'forbidden', permission } };
      }
    }
    return undefined;
  };

  /**
   * A key as the caller sees it, named without a query per key: a caller's
   * own key carries the caller's name, which the request already holds, and
   * anybody else's is named from the one read of the members table that
   * listing everybody's makes.
   */
  const renderKey = (
    key: ApiKeyRecord,
    caller: { id: string; name: string },
    names?: ReadonlyMap<string, string>,
  ) =>
    apiKeyWire(key, {
      access: deps.access,
      memberName: key.memberId === caller.id ? caller.name : (names?.get(key.memberId) ?? null),
      callerId: caller.id,
      connections: sessions.countKey(key.id),
      lastRefusal: apiKeys.lastRefusal(key.id),
    });

  /**
   * The caller's keys — or, with `member.remove`, everybody's.
   *
   * Your own are the floor: somebody whose role no longer lets them make keys
   * can still see the ones they made, paused, and revoke them. Everybody's
   * goes with `member.remove` because ending somebody's access is that
   * permission's own sentence, and a key is access.
   */
  app.get('/api/v1/api-keys', memberOnly, async (request) => {
    const me = request.member!;
    const everybody = can(deps.access, request, 'member.remove');
    const keys = await apiKeys.list(everybody ? undefined : me.id);
    // Only everybody's needs other people's names; a list of the caller's own
    // reads nobody else's row.
    const names = everybody
      ? new Map((await deps.db.query.members.findMany()).map((row) => [row.id, row.name]))
      : undefined;
    return keys.map((key) => renderKey(key, me, names));
  });

  /**
   * Make a key. The secret is in this answer and nowhere else, ever: the hub
   * keeps its hash, and an app that loses it makes another.
   */
  app.post('/api/v1/api-keys', memberOnlyNeeds('hub.apikeys'), async (request, reply) => {
    const body = createKeySchema.parse(request.body ?? {});
    const control = body.control ?? false;
    const permissions = [...new Set(body.permissions ?? [])];
    const refused = grantRefusal(request, control, permissions);
    if (refused) return reply.code(refused.status).send(refused.body);
    const me = request.member!;
    const created = await apiKeys.create({
      memberId: me.id,
      name: body.name,
      control,
      permissions: permissions as PermissionKey[],
      expiresAt: expiryFrom(body.expiresInDays),
    });
    if (!created) {
      return reply.code(409).send({ error: 'too_many_keys', limit: MAX_KEYS_PER_MEMBER });
    }
    const { record, secret } = created;
    const who = actor(request);
    await deps.activity.record({
      kind: 'apikey.added',
      message: `${who.name} created the API key “${record.name}”.`,
      memberId: who.memberId,
      data: { ...who.data, apiKeyId: record.id, apiKeyName: record.name },
    });
    return reply.code(201).send({ key: renderKey(record, me), secret });
  });

  /**
   * Rename a key, change what it may do, or when it expires — **your own
   * only**. A key is its member's authority, and nobody else's edit should be
   * able to reshape it; the people who may end somebody's access revoke
   * instead.
   */
  app.patch('/api/v1/api-keys/:id', memberOnlyNeeds('hub.apikeys'), async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = changeKeySchema.parse(request.body ?? {});
    const key = await apiKeys.get(id);
    if (!key) return reply.code(404).send({ error: 'not_found' });
    const me = request.member!;
    if (key.memberId !== me.id) return reply.code(403).send({ error: 'not_your_key' });

    const control = body.control ?? key.control;
    const permissions =
      body.permissions !== undefined ? [...new Set(body.permissions)] : [...key.permissions];
    const refused = grantRefusal(request, control, permissions, key.permissions);
    if (refused) return reply.code(refused.status).send(refused.body);

    const updated = await apiKeys.update(id, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.control !== undefined ? { control: body.control } : {}),
      ...(body.permissions !== undefined ? { permissions: permissions as PermissionKey[] } : {}),
      ...(body.expiresInDays !== undefined ? { expiresAt: expiryFrom(body.expiresInDays) } : {}),
    });
    if (!updated) return reply.code(404).send({ error: 'not_found' });

    // Its open streams render with the new grant from the next frame, and
    // the `access` frame every socket re-sends is how they hear it now.
    sessions.rekey(updated);
    deps.events.emit('accessChanged');

    const accessMoved =
      updated.control !== key.control ||
      updated.permissions.join() !== key.permissions.join();
    const expiryMoved = (updated.expiresAt?.getTime() ?? null) !== (key.expiresAt?.getTime() ?? null);
    const who = actor(request);
    const message = accessMoved
      ? `${who.name} changed what the API key “${updated.name}” can do.`
      : expiryMoved
        ? `${who.name} changed when the API key “${updated.name}” expires.`
        : updated.name !== key.name
          ? `${who.name} renamed the API key “${key.name}” to “${updated.name}”.`
          : undefined;
    if (message !== undefined) {
      await deps.activity.record({
        kind: 'apikey.changed',
        message,
        memberId: who.memberId,
        data: {
          ...who.data,
          apiKeyId: updated.id,
          apiKeyName: updated.name,
          ...(updated.name !== key.name ? { previousName: key.name } : {}),
        },
      });
    }
    return renderKey(updated, me);
  });

  /**
   * Revoke a key. Your own is the floor — a person must always be able to
   * stop their own software, whatever their role now says. Somebody else's is
   * `member.remove`, and an owner's needs an owner, for the reason
   * `DELETE /members/:id` gives: ending an owner's access is the owner's call.
   *
   * Its streams are hung up **before** the row goes and the line is written,
   * with the same 4001 a removed member's get.
   */
  app.delete('/api/v1/api-keys/:id', memberOnly, async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const key = await apiKeys.get(id);
    if (!key) return reply.code(404).send({ error: 'not_found' });
    const me = request.member!;
    const mine = key.memberId === me.id;
    if (!mine && !can(deps.access, request, 'member.remove')) {
      return reply.code(403).send({ error: 'forbidden', permission: 'member.remove' });
    }
    if (!mine && deps.access.isOwner(key.memberId) && !deps.access.isOwner(me.id)) {
      return reply.code(403).send({ error: 'not_owner' });
    }
    const owner = mine ? me.name : ((await deps.pairing.member(key.memberId))?.name ?? null);
    const closed = sessions.revokeKey(id);
    if (closed > 0) deps.log.info({ apiKeyId: id, closed }, 'Closed event streams for a revoked API key');
    await apiKeys.remove(id);
    const who = actor(request);
    await deps.activity.record({
      kind: 'apikey.removed',
      message:
        mine || owner === null
          ? `${who.name} revoked the API key “${key.name}”.`
          : `${who.name} revoked ${owner}’s API key “${key.name}”.`,
      memberId: who.memberId,
      data: {
        ...who.data,
        apiKeyId: key.id,
        apiKeyName: key.name,
        ...(!mine && owner !== null ? { subjectName: owner } : {}),
      },
    });
    return reply.code(204).send();
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
    /**
     * One agent's block: who answers, on what, and what else it could be.
     *
     * **`models` stays the *chosen provider's* list**, which is what an app a
     * version behind reads to draw its picker — so a hub that has grown a
     * second provider does not hand that app a list mixing two vendors it has
     * no control for. `choices` is the whole table for an app that knows about
     * both, and `choosable` is "there is a decision to make here" — both
     * vendors are ones an agent can actually authenticate as, which is
     * narrower than `mapping.choosable`: a stored Claude subscription token is
     * a key the hub holds and no conversation can use, so counting it offered
     * a vendor switch that could only answer `automation_needs_anthropic`.
     *
     * `provider` is derived from the model rather than stored beside it — see
     * `agentProviderOf` — so the two can never disagree, and a picker writes
     * that provider's default model id rather than a second setting.
     *
     * `effort` is the home's word for a typed round nobody chose one for, and
     * `efforts` the words it may be — the list a chat message is validated
     * against. **Their presence is the capability**: a hub older than them ran
     * every typed round at `medium` and strips `assistantEffort` from a PATCH
     * without a word, so an app offers the control only where it finds them.
     */
    const forAgent = (agent: {
      model: string;
      provider: AiProvider | null;
      choosable: boolean;
      effort: ChatEffort;
    }) => ({
      model: agent.model,
      provider: agent.provider,
      models: agent.provider === null ? [] : AGENT_MODELS[agent.provider].choices,
      choices: { anthropic: AGENT_MODELS.anthropic.choices, openai: AGENT_MODELS.openai.choices },
      choosable: agent.choosable,
      effort: agent.effort,
      efforts: CHAT_EFFORTS,
    });
    const forProvider = (provider: AiProvider) => ({
      hasKey: ai[provider].hasKey,
      model: effectiveModel(provider, ai[provider].model),
      models: PROVIDER_MODELS[provider].choices,
    });
    return {
      ...ai,
      status,
      providers: { anthropic: forProvider('anthropic'), openai: forProvider('openai') },
      // Device recognition's own block: who recognises, whether that is a
      // choice, and **whether it runs at all**. `enabled` repeats the flat
      // field of the same name on purpose — the flat one is what every app
      // already reads and writes — and its *presence here* is the capability:
      // a hub that sends it asks the switch before recognition and nothing
      // else, while an older one also paused both agents and the voice with
      // it, and an app has to know which it is talking to before it closes a
      // composer over a switch somebody flipped to save money on devices.
      mapping: { provider: ai.provider, choosable: ai.mappingChoosable, enabled: ai.enabled },
      // What answers in the assistant, and what it could answer on. Its own
      // block rather than more fields on `providers`, because it is a
      // different question from "which model reads a device's exposes tree"
      // and is offered a different list for reasons that have nothing to do
      // with the other one.
      assistant: forAgent(ai.assistant),
      // And what writes the home's rules, which is a separate choice on the
      // same list: answering questions about the house and writing the rules
      // it runs by itself are different jobs, and a home may want to spend
      // differently on them. Its own block for the reason the assistant's is
      // its own, and it replaces this agent having quietly read the mapper's.
      automations: forAgent(ai.automations),
      portraits: deps.portraits.describe(),
    };
  };

  const modelField = (provider: AiProvider) =>
    z
      .string()
      .min(1)
      .max(120)
      // Any id the hub has ever known is *taken* — a retired one is succeeded
      // when it is read, so an app a version behind is never refused for
      // naming what it was shown — but the sentence names only what
      // recognition is offered, because that is what a run will actually use.
      .refine((model) => isSupportedModel(model, provider), {
        message: `unsupported model — device recognition runs on: ${offeredModelIds(provider).join(', ')}`,
      })
      .nullable()
      .optional();

  const apiKeyField = (provider: AiProvider) =>
    z
      .string()
      .min(8)
      .max(4000)
      // Anthropic's field only. `detail` is `issues[0]`, and an `sk-ant-oat…`
      // trips this *and* the OpenAI-field check below — so pasted into the
      // OpenAI box it answered "the hub needs an Anthropic API key", which is
      // advice about the other field. Gated here, the right sentence surfaces:
      // an `sk-ant-` anything belongs in the Anthropic field, and once it is
      // there this says what kind of Anthropic key it has to be.
      .refine((key) => (provider === 'anthropic' ? !key.trim().startsWith('sk-ant-oat') : true), {
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
    /**
     * Which model answers in the assistant.
     *
     * Deliberately **not** validated against the offered list. The list moves,
     * a retired id is still priced, and `getAiSettings` already turns an
     * unoffered choice into the default on the way out — so refusing one here
     * would only 400 an app a version behind for a value that is harmless.
     * `null` clears it back to the default.
     */
    assistantModel: z.string().min(1).max(120).nullable().optional(),
    /** Which model writes the home's rules. Unvalidated for the reason above. */
    automationsModel: z.string().min(1).max(120).nullable().optional(),
    /**
     * How hard each agent works on a typed round nobody chose an effort for.
     *
     * **Validated, unlike the models beside it**, and the difference is the
     * point: a model id this build has never heard of is harmless to store
     * because `getAiSettings` answers with what will run, while an effort is
     * put on the wire as written and a word one vendor does not take is a 400
     * in the middle of somebody's conversation. `null` puts it back on
     * `AGENT_EFFORT`.
     */
    assistantEffort: z.enum(CHAT_EFFORTS).nullable().optional(),
    automationsEffort: z.enum(CHAT_EFFORTS).nullable().optional(),
    anthropicApiKey: apiKeyField('anthropic'),
    openaiApiKey: apiKeyField('openai'),
    mappingProvider: z.enum(AI_PROVIDERS).optional(),
    /** Forget one provider's key and model, leaving the other one alone. */
    clear: z.enum(AI_PROVIDERS).optional(),
    /** Keep what each round of a run sent and received — see `GET /ai/runs`. */
    recordExchanges: z.boolean().optional(),
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
          .refine((model) => isSupportedModel(model), {
            message: `unsupported model — device recognition runs on: ${offeredModelIds('anthropic').join(', ')}`,
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
   * lets one route carry two credentials, a model per job, the mapping provider and
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
    // Its own column, because the assistant is offered its own list. A model
    // this build has retired is stored rather than refused — `getAiSettings`
    // already answers with what will *run* — so an older app naming one is
    // never 400-ed for it.
    if (body.automationsModel !== undefined) {
      await deps.settings.setAutomationsModel(body.automationsModel);
    }
    if (body.assistantModel !== undefined) {
      await deps.settings.setAssistantModel(body.assistantModel);
    }
    if (body.assistantEffort !== undefined) {
      await deps.settings.setAgentEffort('assistant', body.assistantEffort);
    }
    if (body.automationsEffort !== undefined) {
      await deps.settings.setAgentEffort('automations', body.automationsEffort);
    }
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
    if (body.recordExchanges !== undefined) {
      await deps.settings.setAiRecordExchanges(body.recordExchanges);
    }
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
    // How many rounds each run kept, so an app knows whether to offer the
    // disclosure at all — one grouped read rather than a body per run, since
    // the bodies are the expensive half and most runs have none.
    const counts = await deps.aiRuns.exchangeCounts(rows.map((row) => row.id));
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
      /**
       * What it ran at, and how it was asked — `low`/`medium`/`high` and
       * `voice`/`typed`. Both null on a row written before this and on a run
       * the idea does not apply to (a portrait has no effort; a device
       * recognition nobody asked for has no `via`).
       */
      effort: row.effort,
      via: row.via,
      ok: row.ok,
      costUsd: row.costUsd,
      turns: row.turns,
      durationMs: row.durationMs,
      errorKind: row.errorKind,
      errorMessage: row.errorMessage,
      steps: row.steps,
      /** Rounds kept for this run — 0 unless recording was on when it ran. */
      exchanges: counts.get(row.id) ?? 0,
    }));
  });

  /**
   * What was said to the provider, round by round, for one run.
   *
   * Fetched rather than streamed, and only when somebody opens it: this is
   * kilobytes per run and nobody reads it on a hub that is working — the same
   * stance `HubLogsDisclosure` takes towards a Pi's install log. An empty list
   * is the ordinary answer, because recording is off unless the owner asked
   * for it; a run whose rounds have aged out answers the same way, which is
   * why the list carries a count rather than a boolean somebody could read as
   * a promise.
   */
  app.get('/api/v1/ai/runs/:id/exchanges', needs('hub.ai'), async (request) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const rows = await deps.aiRuns.exchangesOf(id);
    return rows.map((row) => ({
      seq: row.seq,
      at: row.at.toISOString(),
      durationMs: row.durationMs,
      provider: row.provider,
      modelId: row.modelId,
      status: row.status,
      ok: row.ok,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      sent: row.sent,
      received: row.received,
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
   * The broker credentials, for somebody wiring their own device into this home.
   *
   * There are two accounts and this returns the ones the caller may use, never
   * a list with the passwords blanked out — a row somebody cannot act on reads
   * as broken. `hub.mqtt` is the base and gets the limited account;
   * `hub.mqtt.admin` adds the hub's own full-access one, and is deliberately an
   * *addition* rather than a second door, so there is still one guard per route.
   *
   * **It writes to the activity log, which no other GET here does.** That is
   * the point rather than an oversight: everything else this API hands out is a
   * request the hub carries out and can stop carrying out, while a broker
   * password is a secret that leaves the building and cannot be taken back. The
   * whole reason it is safe to delegate `hub.mqtt` in the matrix is that the
   * home can see afterwards who was given one.
   */
  app.get('/api/v1/settings/mqtt', needs('hub.mqtt'), async (request) => {
    const admin = can(deps.access, request, 'hub.mqtt.admin');
    const answer = mqttAccess({
      config: deps.mqtt,
      requestHost: hostFromRequest(request.headers.host),
      canUseIntegrations: true,
      canUseFullAccess: admin,
    });
    const who = actor(request);
    await deps.activity.record({
      kind: 'hub.mqtt',
      message: admin
        ? `${who.name} looked up the MQTT broker credentials, including full access.`
        : `${who.name} looked up the MQTT credentials for connecting a device.`,
      memberId: who.memberId,
      data: { ...who.data, full: admin },
    });
    return answer;
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
    // **Before** the mode, for the reason every write on this path is ordered:
    // writing the mode wakes the unit that restarts this process. Somebody
    // choosing a radio — `both` included — has by definition seen where the
    // hub left them, so the notice is answered, the hub stops or starts
    // holding a second radio for them, and asking for both hands back the two
    // automatic tries. The lifetime *count* survives all of it, because that
    // is what an app offering `both` again should be able to say.
    recordRadioChoice(deps.dataDir, body.mode);
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
    const who = actor(request);
    await deps.activity.record({
      kind: 'hub.radio',
      // `both` is not a radio, so it cannot be set *to* one: on a board
      // measured for one this is the sentence somebody re-reads later, when
      // they are working out why the hub started handing radios back.
      message:
        body.mode === 'both'
          ? `${who.name} set the hub to run both radios at once.`
          : `${who.name} set the radio to ${body.mode}.`,
      memberId: who.memberId,
      data: { ...who.data, mode: body.mode },
    });
    // The whole `radio` block `GET /hub` answers with, from the same snapshot
    // — because two shapes for one fact drift, and this response and that one
    // are read by the same screen seconds apart. `applying` is true here
    // because `writeRadioMode` has just recorded the request; what is *live*
    // still comes from the adapters, and is deliberately stale.
    return hubStatus.snapshot().radio;
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
      // Always present on a hub that has automatic updates at all, so its
      // presence is how an app knows to offer the switch — see `PUT` below.
      automatic: autoUpdate.describe(),
    };
  });

  /**
   * Let the hub update itself, or stop it.
   *
   * **`hub.update`, the same key as pressing the button**: whoever may start an
   * update now may decide that the hub starts one at an hour the home is quiet,
   * which is less disruption rather than more. A key that holds it may switch
   * this too, as it may `POST` — nothing new is grantable.
   *
   * **The body is strict**, the `/api-keys` reasoning: a field a later build
   * adds to *narrow* this — certain nights, say — would be stripped by an
   * older hub, which would then update itself more freely than it was asked
   * to. A 400 is the only safe answer from a build that cannot read it.
   *
   * Switching it on where this machine has no update runner is the refusal
   * `POST` already gives there: an app offering a switch that cannot do
   * anything is the same dead end as a button that cannot. Switching it off is
   * always allowed.
   */
  app.put('/api/v1/system/update/automatic', needs('hub.update'), async (request, reply) => {
    const body = z.object({ enabled: z.boolean() }).strict().parse(request.body);
    if (body.enabled && !autoUpdate.enabled && !canApplyUpdate(deps.dataDir)) {
      return reply.code(409).send({ error: 'update_unsupported' });
    }
    const changed = body.enabled !== autoUpdate.enabled;
    const automatic = await autoUpdate.setEnabled(body.enabled);
    if (changed) {
      // Read a week later by somebody asking why the hub restarted at three in
      // the morning — so it names who said it could.
      const who = actor(request);
      await deps.activity.record({
        kind: 'hub.update',
        message: body.enabled
          ? `${who.name} turned on automatic hub updates.`
          : `${who.name} turned off automatic hub updates.`,
        memberId: who.memberId,
        data: { ...who.data, outcome: body.enabled ? 'auto-on' : 'auto-off' },
      });
    }
    return { automatic };
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
    const who = actor(request);
    await deps.activity.record({
      kind: 'hub.update',
      message: `${who.name} started a hub update.`,
      memberId: who.memberId,
      data: {
        ...who.data,
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

  // ── Wi-Fi networks ───────────────────────────────────────────────────────

  /**
   * The networks this hub knows, which one it is on, and what became of the
   * last change — the answer every route below also ends with, so a screen is
   * redrawn from one shape whichever of them it called.
   *
   * Read fresh from the root script's files every time; nothing here is held
   * in memory, because the list changes on an association this process never
   * hears about. **Passwords never come back**: the hub does not have them —
   * the script reads names and nothing else — and an app that wants to show
   * one has nothing to show.
   */
  const wifiSettings = () => {
    const availability = wifiAvailability(deps.dataDir);
    const list = readSavedNetworks(deps.dataDir);
    const last = readWifiChangeResult(deps.dataDir);
    return {
      ...availability,
      networks: list?.networks ?? [],
      ...(list?.updatedAt !== undefined ? { updatedAt: list.updatedAt } : {}),
      // What the hub's radio can join, absent when the list does not say (a
      // build older than the field wrote it, or the machine has no Wi-Fi
      // device). An app warns before a network the hub cannot hear is added.
      ...(list?.bands !== undefined ? { bands: list.bands } : {}),
      maxNetworks: MAX_WIFI_NETWORKS,
      pending: wifiChangePending(deps.dataDir) || wifiChangeUnsettled(last),
      ...(last !== undefined ? { lastChange: last } : {}),
    };
  };

  /**
   * The script's own words for a refusal, as this API says them. Each is a new
   * situation and so a new code — never one an older app already reads as
   * something else — and `detail` carries NetworkManager's own sentence for
   * the one that has no better name.
   */
  const WIFI_REFUSALS: Record<WifiChangeError, readonly [number, string]> = {
    exists: [409, 'wifi_network_exists'],
    limit: [409, 'wifi_network_limit'],
    connected: [409, 'wifi_network_connected'],
    not_found: [404, 'not_found'],
    unsupported: [409, 'wifi_unsupported'],
    invalid: [409, 'wifi_change_failed'],
    nmcli: [409, 'wifi_change_failed'],
  };

  /**
   * A change is being applied and its route has not answered yet.
   *
   * The request file stops saying so the moment the script starts work — it is
   * consumed first — so on its own it let a second change through while the
   * first was still being applied: a second request, a second result written
   * over the first before the first route had read it, and that route answering
   * "still adding" about a network that had been added. In memory, because
   * nothing awaits between the check and the write that sets it.
   */
  let wifiChangeInFlight = false;

  /**
   * A change answered `202`: the script may have consumed it and still be
   * applying it, and the route has stopped waiting. Without this the lock went
   * with the route, so a second change could be written while the first was
   * still in hand, and its result written over the first before `GET` could
   * report the first one landing. Held until that change's own result appears,
   * and for two minutes at most — a script that died says nothing at all.
   */
  let wifiChangeAwaited: { id: string; until: number } | undefined;
  const WIFI_CHANGE_HOLD_MS = 2 * 60 * 1000;

  /** Whether a change answered `202` has still not been answered by the machine. */
  const wifiChangeUnsettled = (last = readWifiChangeResult(deps.dataDir)): boolean => {
    if (wifiChangeAwaited === undefined) return false;
    if (Date.now() >= wifiChangeAwaited.until || last?.id === wifiChangeAwaited.id) {
      wifiChangeAwaited = undefined;
      return false;
    }
    return true;
  };

  /** The refusals every change makes before it writes anything. */
  const wifiChangeBlocked = (reply: FastifyReply): FastifyReply | undefined => {
    const availability = wifiAvailability(deps.dataDir);
    if (!availability.available) {
      return reply.code(409).send({ error: 'wifi_unsupported', reason: availability.reason });
    }
    // One at a time, and refused rather than queued: a second request written
    // over the first before the script reads it would lose the first without a
    // word, and the script's path unit does not re-fire while it is running.
    if (wifiChangeInFlight || wifiChangePending(deps.dataDir) || wifiChangeUnsettled()) {
      return reply.code(409).send({ error: 'wifi_change_pending' });
    }
    return undefined;
  };

  /**
   * Wait for the root script, then answer with what happened.
   *
   * It is quick — a path unit, one `nmcli` call and a list — so the route
   * answers with the outcome instead of a receipt to poll, which is what lets
   * an app say "added" or say why not on the same screen. A board too busy to
   * finish inside the wait gets `202` and `change.state: 'pending'`; the change
   * is still queued, and `GET /settings/wifi` reports it when it lands.
   */
  const settleWifiChange = async (
    reply: FastifyReply,
    id: string,
    onSettled: (result: WifiChangeResult | undefined) => Promise<void>,
  ) => {
    const result = await awaitWifiChange(deps.dataDir, id, deps.wifiApplyWaitMs ?? 20_000);
    if (result === undefined) {
      wifiChangeAwaited = { id, until: Date.now() + WIFI_CHANGE_HOLD_MS };
      await onSettled(undefined);
      return reply.code(202).send({ ...wifiSettings(), change: { id, state: 'pending' } });
    }
    if (result.state === 'applied') {
      await onSettled(result);
      return reply.code(200).send({ ...wifiSettings(), change: result });
    }
    const [status, error] = WIFI_REFUSALS[result.error ?? 'nmcli'];
    return reply.code(status).send({ error, ...(result.detail !== undefined ? { detail: result.detail } : {}) });
  };

  /**
   * Reading is `hub.wifi` too, not the floor. The list is where the hub has
   * been — a holiday house, a parent's flat — and that is not "reading the
   * home" in the sense every member is owed; a guest sees nothing here.
   */
  app.get('/api/v1/settings/wifi', needs('hub.wifi'), async () => wifiSettings());

  /**
   * Tell the hub about another Wi-Fi network, for it to join when it is
   * somewhere that network reaches.
   *
   * Nothing changes now: NetworkManager does not leave a network it is on for
   * one it has just been told about, and when both are in range it prefers the
   * one it used last. So this is safe to do from the sofa the evening before
   * the move, which is exactly when somebody does it.
   *
   * The password is turned into the network's key before anything is written
   * (`core/wifi-networks.ts`), and is never logged, stored or returned.
   */
  app.post('/api/v1/settings/wifi/networks', needs('hub.wifi'), async (request, reply) => {
    const body = z
      .object({
        ssid: z.string().superRefine((ssid, ctx) => {
          const problem = ssidProblem(ssid);
          if (problem !== undefined) ctx.addIssue({ code: 'custom', message: problem });
        }),
        passphrase: z.string().superRefine((passphrase, ctx) => {
          const problem = passwordProblem(passphrase);
          if (problem !== undefined) ctx.addIssue({ code: 'custom', message: problem });
        }),
        hidden: z.boolean().optional(),
      })
      .parse(request.body);

    const blocked = wifiChangeBlocked(reply);
    if (blocked !== undefined) return blocked;
    const list = readSavedNetworks(deps.dataDir);
    if (list?.networks.some((network) => network.ssid === body.ssid)) {
      return reply.code(409).send({ error: 'wifi_network_exists' });
    }
    if (list !== undefined && list.networks.length >= MAX_WIFI_NETWORKS) {
      return reply.code(409).send({ error: 'wifi_network_limit' });
    }

    wifiChangeInFlight = true;
    try {
      const id = requestWifiChange(deps.dataDir, {
        action: 'add',
        ssid: body.ssid,
        psk: wpaPsk(body.ssid, body.passphrase),
        hidden: body.hidden === true,
      });
      deps.log.info({ id, member: request.member!.id }, 'Wi-Fi network addition requested');
      return await settleWifiChange(reply, id, async (result) => {
        const who = actor(request);
        const name = who.name;
        await deps.activity.record({
          kind: 'hub.wifi',
          message:
            result !== undefined
              ? `${name} added the Wi-Fi network “${body.ssid}” to the hub.`
              : `${name} asked the hub to add the Wi-Fi network “${body.ssid}”.`,
          memberId: who.memberId,
          data: {
            ...who.data,
            action: 'add',
            ssid: body.ssid,
            outcome: result !== undefined ? 'applied' : 'pending',
          },
        });
      });
    } finally {
      wifiChangeInFlight = false;
    }
  });

  /**
   * Make the hub forget a network.
   *
   * **Never the one it is connected through**, which is refused here and again
   * by the root script against NetworkManager itself: deleting the active
   * profile takes the connection down with it, and a hub off its only network
   * is one no app can reach to put it back. That is the single change here
   * whose cost is a trip to the Pi, so it is not offered behind a confirmation
   * — it is not offered at all.
   */
  app.delete('/api/v1/settings/wifi/networks/:id', needs('hub.wifi'), async (request, reply) => {
    const { id: networkId } = request.params as { id: string };
    if (!/^[0-9a-f-]{36}$/i.test(networkId)) return reply.code(404).send({ error: 'not_found' });

    const blocked = wifiChangeBlocked(reply);
    if (blocked !== undefined) return blocked;
    const list = readSavedNetworks(deps.dataDir);
    const known = list?.networks.find((network) => network.id === networkId.toLowerCase());
    if (list !== undefined && known === undefined) return reply.code(404).send({ error: 'not_found' });
    if (known?.connected === true) return reply.code(409).send({ error: 'wifi_network_connected' });

    wifiChangeInFlight = true;
    try {
      const id = requestWifiChange(deps.dataDir, { action: 'remove', networkId: networkId.toLowerCase() });
      deps.log.info({ id, member: request.member!.id }, 'Wi-Fi network removal requested');
      return await settleWifiChange(reply, id, async (result) => {
        const who = actor(request);
        const name = who.name;
        const ssid = result?.ssid ?? known?.ssid;
        const network = ssid !== undefined ? `the Wi-Fi network “${ssid}”` : 'a Wi-Fi network';
        await deps.activity.record({
          kind: 'hub.wifi',
          message:
            result !== undefined
              ? `${name} removed ${network} from the hub.`
              : `${name} asked the hub to forget ${network}.`,
          memberId: who.memberId,
          data: {
            ...who.data,
            action: 'remove',
            ...(ssid !== undefined ? { ssid } : {}),
            outcome: result !== undefined ? 'applied' : 'pending',
          },
        });
      });
    } finally {
      wifiChangeInFlight = false;
    }
  });

  // ── Automations ──────────────────────────────────────────────────────────

  /**
   * A rule as the apps read it.
   *
   * `summary` is the contract and the document is the convenience — the
   * activity log's `message`/`data` split, for the same reason: an app a
   * version behind meets a node it cannot parse and must still be able to draw
   * a card that says something true. `shape` is what it draws: a button, a
   * toggle (a mode), or a rule that watches the home and has nothing to press.
   */
  const automationWire = (
    record: ReturnType<AutomationEngine['list']>[number],
    /**
     * The home to read the rule against, so a route drawing a list builds it
     * once rather than once per rule. `homeView()` walks every device and every
     * record, and both the sentence and the room below are read out of it —
     * per rule that is two rebuilds of the whole home for each line of the
     * list. Defaulted, so a route answering with a single rule stays a
     * one-liner.
     */
    home: AutomationHomeView = deps.automations.homeView(),
  ) => ({
    id: record.id,
    name: record.name,
    /**
     * The mark somebody chose, or null for "the app decides" — the room rule
     * (`icon`/`accent`) applied to a rule. An app derives one from the name
     * and the shape when this is empty, which is what every rule written
     * before anybody restyled it carries.
     */
    icon: record.icon,
    description: record.document.description ?? null,
    enabled: record.enabled,
    active: record.active,
    disabledReason: record.disabledReason,
    shape: automationShape(record.document),
    summary: describeAutomation(record.document, home),
    /**
     * The same rule as a **storyboard** — when, only if, then — so an app can
     * draw it rather than print it (`automationOutline`).
     *
     * `summary` stays the contract and this is the picture beside it: neither
     * app decodes the document, because the DSL will keep growing and a second
     * copy of it in Swift would go stale here without anybody noticing. A
     * sentence was the only thing that left an app able to show, and a sentence
     * is a poor answer to "what does this actually do" for somebody who does
     * not write software. Every field but `title` is optional and `glyph` is an
     * opaque token, so a step kind added later reaches an older app as a
     * generic mark over a line that is still true.
     */
    outline: automationOutline(record.document, home),
    /**
     * The room this rule is *one room's*, or null for a rule about the whole
     * house — derived from the document and the home as it is right now
     * (`automationRoom`), never stored. A selector naming a room declares one
     * before anything is paired into it; a device moved to another room
     * changes the answer with the rule untouched, which is why this is
     * computed on every read rather than written down anywhere.
     */
    roomId: automationRoom(record.document, home),
    document: record.document,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  });

  /**
   * Reading the home is the floor, and a rule is the home.
   *
   * `unreadable` rides along rather than being hidden: a document written by a
   * newer build is kept and not run (see `AutomationStore.load`), and an app
   * that simply did not list it would show a rule silently vanishing after a
   * rollback.
   */
  app.get('/api/v1/automations', authed, async () => {
    const home = deps.automations.homeView();
    return {
      automations: deps.automations.list().map((record) => automationWire(record, home)),
      unreadable: deps.automations.unreadableRules(),
    };
  });

  /**
   * What an automation can be made of — generated from the live zod schema, so
   * a catalog cannot drift from what the validator accepts. The `GET
   * /permissions` rule applied to a vocabulary that will keep growing: the apps
   * render this rather than shipping a copy of it.
   */
  app.get('/api/v1/automations/capabilities', authed, async () => automationCatalog());

  app.get('/api/v1/automations/templates', authed, async () =>
    AUTOMATION_TEMPLATES.map((template) => ({
      key: template.key,
      title: template.title,
      summary: template.summary,
      glyph: template.glyph,
      inputs: template.inputs,
    })),
  );

  app.get('/api/v1/automations/:id', authed, async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const record = deps.automations.get(id);
    if (!record) return reply.code(404).send({ error: 'not_found' });
    return automationWire(record);
  });

  /**
   * Why the light came on at three in the morning.
   *
   * The floor, like the activity log and the reading history: this is the home
   * explaining itself, and a member who cannot read it is one who cannot find
   * out what the house did to them.
   */
  app.get('/api/v1/automations/:id/runs', authed, async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    if (!deps.automations.get(id)) return reply.code(404).send({ error: 'not_found' });
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(100).optional() }).parse(
      request.query ?? {},
    );
    return deps.automationStore.runs(id, limit ?? 20);
  });

  /**
   * Press it.
   *
   * **The floor, deliberately.** Pressing "I'm leaving" switches lights and
   * locks doors, and working the home is what being a member means — the same
   * argument that killed `device.control`. A role that may work every light
   * individually and not the button that works them together would be a rule
   * nobody asked for.
   *
   * A key needs `control`, which is what working the home is for a key.
   */
  app.post('/api/v1/automations/:id/run', controls, async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const record = deps.automations.get(id);
    if (!record) return reply.code(404).send({ error: 'not_found' });
    if (!record.enabled) return reply.code(409).send({ error: 'automation_disabled' });
    if (automationShape(record.document) === 'watching') {
      return reply.code(409).send({ error: 'not_pressable' });
    }
    // The sentence the run writes names who pressed it — a key by name, so a
    // scene a script pressed at three in the morning says which script — and
    // the row is theirs, the way every row a key causes is its member's.
    await deps.automations.runManually(id, presser(request));
    return reply.code(202).send({ accepted: true });
  });

  /**
   * Switch a mode on or off — "Security is on".
   *
   * Also the floor, and a *different* thing from `enabled` below. Turning a
   * mode on is working the home; enabling a rule is editing it. Two words, two
   * permissions, and keeping them apart is what lets a guest arm the house
   * without being able to rewrite what arming it does.
   *
   * A key needs `control` here too: switching a mode on is working the home.
   */
  app.put('/api/v1/automations/:id/active', controls, async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const { active } = z.object({ active: z.boolean() }).parse(request.body);
    const record = deps.automations.get(id);
    if (!record) return reply.code(404).send({ error: 'not_found' });
    if (!record.enabled) return reply.code(409).send({ error: 'automation_disabled' });
    if (automationShape(record.document) !== 'toggle') {
      return reply.code(409).send({ error: 'not_a_toggle' });
    }
    await deps.automations.setActive(id, active, presser(request));
    return { active };
  });

  /**
   * Check a document without saving it.
   *
   * What the agent calls before it submits, and what an app can call to draw a
   * preview. Warnings come back beside problems because the interesting ones
   * are not refusals: a loop is sometimes a bug and sometimes a thermostat, and
   * saying so beats both refusing and staying quiet.
   */
  app.post('/api/v1/automations/dry-run', needs('automation.manage'), async (request, reply) => {
    const parsed = automationDocumentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(422).send({
        error: 'invalid_automation',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    const report = sanityCheckAutomation(parsed.data, deps.automations.homeView());
    return {
      ...report,
      shape: automationShape(parsed.data),
      summary: describeAutomation(parsed.data, deps.automations.homeView()),
      outline: automationOutline(parsed.data, deps.automations.homeView()),
    };
  });

  /**
   * Save a new rule — **switched off**.
   *
   * That is not a default anybody has to remember: `AutomationStore.create`
   * writes `enabled: false` whatever the caller says, because the moment
   * between "here is what I wrote for you" and "your house is now doing it" is
   * the only one in which somebody can still look.
   */
  app.post('/api/v1/automations', needs('automation.manage'), async (request, reply) => {
    const parsed = automationDocumentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(422).send({
        error: 'invalid_automation',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    const report = sanityCheckAutomation(parsed.data, deps.automations.homeView());
    if (report.problems.length > 0) {
      return reply.code(422).send({ error: 'invalid_automation', ...report });
    }
    const record = await deps.automationStore.create(parsed.data, request.member!.id);
    await deps.automations.reload();
    deps.events.emit('automationChanged', record.id);
    const who = actor(request);
    await deps.activity.record({
      kind: 'automation.added',
      message: `${who.name} added the automation “${record.name}”`,
      memberId: who.memberId,
      data: { automationId: record.id, automationName: record.name, ...who.data },
    });
    const saved = deps.automations.get(record.id);
    return reply
      .code(201)
      .send({ ...(saved ? automationWire(saved) : {}), warnings: report.warnings });
  });

  /**
   * Edit it, rename it, restyle it, or switch it on and off.
   *
   * All in one route because all of them are editing: `enabled` is whether the
   * rule exists as far as the home is concerned, which is a decision about the
   * rule rather than about the house. Switching it back on clears whatever the
   * circuit breaker wrote, since a stale explanation on a working rule is
   * worse than none.
   *
   * **`name` and `icon` are what a rule is called and how it is drawn**, and
   * they are here rather than only inside `document` because a rename is a
   * different act from an edit: what the house *does* is unchanged, the apps
   * hold the summary rather than the document (`summary` is the contract —
   * see `automationWire`), and asking a phone to send back a whole rule
   * document to fix a typo would mean every app carrying a second copy of the
   * DSL. `name` is written into the document too — see
   * `AutomationStore.setLook` for why that is not optional — and `icon` is the
   * room rule: `null` puts it back to the mark the app derives, leaving the
   * field out keeps whatever it wears.
   */
  app.patch('/api/v1/automations/:id', needs('automation.manage'), async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z
      .object({
        document: z.unknown().optional(),
        enabled: z.boolean().optional(),
        // The document's own bound, so a name can never be typed here that a
        // later edit in conversation would have to refuse.
        name: z.string().trim().min(1).max(80).optional(),
        icon: lookTokenSchema,
      })
      .parse(request.body ?? {});
    const record = deps.automations.get(id);
    if (!record) return reply.code(404).send({ error: 'not_found' });

    let warnings: string[] = [];
    if (body.document !== undefined) {
      const parsed = automationDocumentSchema.safeParse(body.document);
      if (!parsed.success) {
        return reply.code(422).send({
          error: 'invalid_automation',
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        });
      }
      const report = sanityCheckAutomation(parsed.data, deps.automations.homeView(), { selfId: id });
      if (report.problems.length > 0) {
        return reply.code(422).send({ error: 'invalid_automation', ...report });
      }
      warnings = report.warnings;
      await deps.automationStore.update(id, parsed.data, request.member!.id);
    }
    if (body.name !== undefined || body.icon !== undefined) {
      await deps.automationStore.setLook(id, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.icon !== undefined ? { icon: body.icon } : {}),
      });
    }
    if (body.enabled !== undefined) {
      await deps.automationStore.setEnabled(id, body.enabled);
    }

    await deps.automations.reload();
    deps.events.emit('automationChanged', id);
    // A rename is logged and a restyle is not, the rooms rule: the activity
    // log is read a week later, and "somebody changed that rule's icon" is not
    // what anybody is looking for in it — while "who renamed this" is exactly
    // the sort of thing a shared home asks.
    const who = actor(request);
    if (body.name !== undefined && body.name !== record.name) {
      await deps.activity.record({
        kind: 'automation.renamed',
        message: `${who.name} renamed the automation “${record.name}” to “${body.name}”`,
        memberId: who.memberId,
        data: {
          automationId: id,
          automationName: body.name,
          previousName: record.name,
          ...who.data,
        },
      });
    }
    if (body.enabled !== undefined) {
      // The name as it stands *after* this request, so a rename and a switch
      // made in one call do not leave two rows in the feed disagreeing about
      // what the rule is called.
      const name = body.name ?? record.name;
      await deps.activity.record({
        kind: body.enabled ? 'automation.enabled' : 'automation.disabled',
        message: `${who.name} switched the automation “${name}” ${body.enabled ? 'on' : 'off'}`,
        memberId: who.memberId,
        data: { automationId: id, automationName: name, ...who.data },
      });
    }
    const saved = deps.automations.get(id);
    return { ...(saved ? automationWire(saved) : {}), warnings };
  });

  app.delete('/api/v1/automations/:id', needs('automation.manage'), async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const record = deps.automations.get(id);
    if (!record) return reply.code(404).send({ error: 'not_found' });
    await deps.automationStore.remove(id);
    await deps.automations.reload();
    deps.events.emit('automationChanged', id);
    const who = actor(request);
    await deps.activity.record({
      kind: 'automation.removed',
      message: `${who.name} removed the automation “${record.name}”`,
      memberId: who.memberId,
      data: { automationId: id, automationName: record.name, ...who.data },
    });
    return reply.code(204).send();
  });

  /**
   * What it used to say.
   *
   * An agent rewrites a rule, the home behaves oddly at three in the morning,
   * and without this the only way back is remembering. Reverting is an
   * ordinary edit, so it writes a version of its own.
   */
  app.get('/api/v1/automations/:id/versions', needs('automation.manage'), async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    if (!deps.automations.get(id)) return reply.code(404).send({ error: 'not_found' });
    return deps.automationStore.versions(id);
  });

  app.post('/api/v1/automations/:id/revert', needs('automation.manage'), async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const { versionId } = z.object({ versionId: z.uuid() }).parse(request.body);
    if (!deps.automations.get(id)) return reply.code(404).send({ error: 'not_found' });
    const version = (await deps.automationStore.versions(id)).find((row) => row.id === versionId);
    if (!version) return reply.code(404).send({ error: 'unknown_version' });
    const parsed = automationDocumentSchema.safeParse(version.document);
    if (!parsed.success) return reply.code(422).send({ error: 'invalid_automation' });
    await deps.automationStore.update(id, parsed.data, request.member!.id, 'reverted');
    await deps.automations.reload();
    deps.events.emit('automationChanged', id);
    const saved = deps.automations.get(id);
    return saved ? automationWire(saved) : reply.code(404).send({ error: 'not_found' });
  });

  /**
   * Install a shipped template.
   *
   * A template can install more than one rule — "light on movement" is
   * genuinely two, one for arriving and one for leaving — so this answers with
   * a list. Sanity problems are reported per rule rather than aborting the
   * whole thing halfway: a home missing the devices for one half should still
   * get the other.
   */
  app.post('/api/v1/automations/templates/:key', needs('automation.manage'), async (request, reply) => {
    const { key } = z.object({ key: z.string().min(1).max(60) }).parse(request.params);
    const inputs = z.record(z.string(), z.string()).parse(request.body ?? {});
    const template = findTemplate(key);
    if (!template) return reply.code(404).send({ error: 'unknown_template' });

    let documents;
    try {
      documents = template.build(inputs);
    } catch (error) {
      return reply.code(400).send({ error: 'bad_inputs', detail: (error as Error).message });
    }

    const created: string[] = [];
    const warnings: string[] = [];
    for (const document of documents) {
      const report = sanityCheckAutomation(document, deps.automations.homeView());
      warnings.push(...report.warnings);
      if (report.problems.length > 0) {
        warnings.push(...report.problems);
        continue;
      }
      const record = await deps.automationStore.create(document, request.member!.id, `from ${key}`);
      created.push(record.id);
    }
    await deps.automations.reload();
    for (const id of created) deps.events.emit('automationChanged', id);
    const who = actor(request);
    await deps.activity.record({
      kind: 'automation.added',
      message: `${who.name} added “${template.title}”`,
      memberId: who.memberId,
      data: { template: key, count: created.length, ...who.data },
    });
    // Read after the reload above, and once for the whole answer rather than
    // per rule — a template can install several.
    const home = deps.automations.homeView();
    return reply.code(201).send({
      automations: created
        .map((id) => deps.automations.get(id))
        .filter((record) => record !== undefined)
        .map((record) => automationWire(record, home)),
      warnings,
    });
  });

  /**
   * The home's timezone, which is what "at ten in the evening" means.
   *
   * Reading it is the floor; setting it needs `automation.manage`, because
   * schedules are the only thing that reads it and getting it wrong is how a
   * heating rule fires at three in the morning. The system's zone seeds it and
   * the database owns it afterwards — the `HUB_NAME` split.
   */
  app.get('/api/v1/settings/timezone', authed, async () => ({
    timezone: deps.settings.timezone,
  }));

  app.put('/api/v1/settings/timezone', needs('automation.manage'), async (request, reply) => {
    const { timezone } = z.object({ timezone: z.string().min(1).max(80) }).parse(request.body);
    if (!(await deps.settings.setTimezone(timezone))) {
      return reply.code(400).send({ error: 'unknown_timezone' });
    }
    return { timezone: deps.settings.timezone };
  });

  // ── Writing a rule in conversation ───────────────────────────────────────

  // **No conversation route takes an API key — reading one included.** A
  // transcript is what a person in the home said, and a conversation spends
  // the home's AI money on somebody's behalf: a key that could read them would
  // read other people's words, and one that could write would put words in its
  // member's mouth. Software that wants a rule writes the document itself
  // (`POST /automations`), where `dry-run` says what it will do first.

  /**
   * Two permissions, and the route asks for both.
   *
   * `automation.manage` because a conversation ends in a saved rule, and
   * `hub.ai` because it spends the home's money — the same key that guards
   * recognising a device and drawing a portrait. `needs()` takes one, so the
   * second is checked here and refused in the same shape, since an app turns
   * `{error, permission}` into a sentence and has no way to read a bare 403.
   *
   * **It answers whether it refused, never the reply.** It used to hand back
   * `reply` itself — and a Fastify reply is a *thenable*, so the `await` at
   * every call site adopted it and resolved to `undefined`: the 403 went out
   * and the handler carried straight on past `if (refused)`, starting a
   * conversation on the home's money for a member the guard had just turned
   * away, then failing to send its own answer over the one already sent. A
   * boolean cannot be mistaken for a promise.
   */
  const chatGuard = async (request: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    if (!can(deps.access, request, 'hub.ai')) {
      await reply.code(403).send({ error: 'forbidden', permission: 'hub.ai' });
      return true;
    }
    return false;
  };

  /**
   * Turn a configuration refusal into a code an app can branch on **and a
   * sentence it can show**.
   *
   * The codes lead to different screens — "there is no key", "the owner
   * switched this off", "this needs the other vendor's key" — and `detail`
   * rides along so an app that has never met a code a later build added still
   * has something true to print. Without it, one of these reached a phone as
   * "The hub answered 500." over a home that was configured perfectly well.
   */
  const chatRefusal = (error: unknown, reply: FastifyReply) => {
    if (error instanceof AutomationNotConfiguredError) {
      return reply.code(409).send({ error: error.code, detail: error.message });
    }
    // Photos past what the hub can hold at once, refused before anything was
    // taken — the `portrait_busy` rule, in bytes (`ChatPhotoBudget`).
    if (error instanceof ChatPhotosBusyError) {
      return reply.code(409).send({ error: error.code, detail: error.message });
    }
    throw error;
  };

  /**
   * One photo sent with a message.
   *
   * Everything about it is checked here, before a byte of it reaches a turn:
   * the type against the short list both vendors take, the size against the
   * hub's own bound (from the length — `base64Bytes` — never by decoding it),
   * and the alphabet, so a garbled upload is a 400 the app can say rather than
   * a provider error read out as the model having failed. `ref`, `width` and
   * `height` are the app's own, stored beside the row so it can draw its copy;
   * the hub does nothing else with them.
   */
  const chatImageSchema = z.object({
    type: z.literal('image'),
    mediaType: z.enum(CHAT_IMAGE_MEDIA_TYPES, {
      message: 'A photo has to be a JPEG, PNG or WebP image.',
    }),
    data: z
      .string()
      .max(CHAT_IMAGE_MAX_BASE64, {
        message: `Each photo can be at most ${CHAT_IMAGE_MAX_BYTES / (1024 * 1024)} MB.`,
        // Stop here: walking eight million characters to report the same
        // thing twice is work for nobody — see `isBase64`.
        abort: true,
      })
      .refine(isBase64, { message: 'A photo has to be sent as base64.' })
      .refine((data) => base64Bytes(data) <= CHAT_IMAGE_MAX_BYTES, {
        message: `Each photo can be at most ${CHAT_IMAGE_MAX_BYTES / (1024 * 1024)} MB.`,
      }),
    ref: z.string().min(1).max(64).optional(),
    width: z.number().int().min(1).max(20_000).optional(),
    height: z.number().int().min(1).max(20_000).optional(),
  });

  /**
   * What a chat message may carry besides its words, on all four routes that
   * take one. **All optional**: an older app sends none of them and sees
   * exactly what it always did, and `GET /hub`'s `chat` block is how a newer
   * one knows they will be read rather than stripped.
   */
  const chatTurnFields = {
    /** An agent model id, checked against what this home can run below. */
    model: z.string().trim().min(1).max(120).optional(),
    effort: z.enum(CHAT_EFFORTS).optional(),
    attachments: z
      .array(chatImageSchema)
      .max(CHAT_IMAGE_MAX_COUNT, {
        message: `At most ${CHAT_IMAGE_MAX_COUNT} photos can go with one message.`,
      })
      .optional(),
  };

  /**
   * **A message is words, a photo, or both** — never neither. `message` lost
   * its `min(1)` for a picture sent on its own, and this is what keeps an
   * empty send a 400, as it always was.
   */
  const saysSomething = (body: { message: string; attachments?: unknown[] | undefined }) =>
    body.message.length > 0 || (body.attachments?.length ?? 0) > 0;
  const saysSomethingIssue = { message: 'Say something, or attach a photo.', path: ['message'] };

  const chatMessageSchema = z
    .object({ message: z.string().trim().max(2_000), ...chatTurnFields })
    .refine(saysSomething, saysSomethingIssue);

  /** The parsed extras, as the turn the runtime runs. */
  const turnOf = (body: {
    model?: string | undefined;
    effort?: (typeof CHAT_EFFORTS)[number] | undefined;
    attachments?: z.infer<typeof chatImageSchema>[] | undefined;
  }): ChatTurnRequest | undefined => {
    const images = (body.attachments ?? []).map((image) => ({
      mediaType: image.mediaType,
      data: image.data,
      ...(image.ref !== undefined ? { ref: image.ref } : {}),
      ...(image.width !== undefined ? { width: image.width } : {}),
      ...(image.height !== undefined ? { height: image.height } : {}),
    }));
    if (body.model === undefined && body.effort === undefined && images.length === 0) {
      return undefined;
    }
    return {
      ...(body.model !== undefined ? { model: body.model } : {}),
      ...(body.effort !== undefined ? { effort: body.effort } : {}),
      ...(images.length > 0 ? { images } : {}),
    };
  };

  /**
   * Refuse a chat's own model when this home cannot run it — **before** the
   * message is taken, so nothing is written for a turn that would not run.
   *
   * `409 model_unavailable`, a **new code for a new situation** rather than a
   * reuse of `ai_not_configured`: that one sends an app to add a key, and the
   * fix here is usually to pick another model from a list the app already has.
   * `detail` names which, because an older app shows it for a code it has never
   * met. Two cases. An id no agent is offered — a typo, a model retired since
   * the app read the list. And an offered model whose vendor has no usable key
   * here while the other vendor's does, since the picker draws both vendors'
   * models. A home with no usable key at all is left to the conversation's own
   * refusal, which is the more useful sentence: there is nothing to pick.
   *
   * Never let an unknown id reach the conversation: the agents throw a plain
   * `Error` for a model they cannot run, which is a 500.
   */
  const modelRefusal = async (model: string | undefined, reply: FastifyReply): Promise<boolean> => {
    if (model === undefined) return false;
    const provider = agentProviderOf(model);
    const usable = await deps.settings.agentProviders();
    if (provider !== null && usable[provider]) return false;
    if (provider !== null && !usable.anthropic && !usable.openai) return false;
    const vendor = provider === 'openai' ? 'OpenAI' : 'Anthropic';
    await reply.code(409).send({
      error: 'model_unavailable',
      detail:
        provider === null
          ? 'That isn’t a model this hub offers for chats. Pick one from the list.'
          : `${modelLabel(provider, model)} runs on ${vendor}, and this home has no ${vendor} key ` +
            'it can use. Pick another model, or add the key in the home’s AI settings.',
    });
    // Whether it refused, never the reply — see `chatGuard` on why a reply
    // handed back through an `await` reads as "carry on".
    return true;
  };

  /**
   * What `POST …/chat/:id/stop` answers, on either agent.
   *
   * **An acknowledgement, the rule every chat route keeps**: the round winds
   * down at its next safe point and says so on the socket like any other turn
   * — what had reached the page kept as the answer, then a note that it
   * stopped — so `stopped` is that a round was told to, and `false` that none
   * was running, which a round that finished a moment earlier is too. Only the
   * person whose conversation it is may stop it, refused in the words the voice
   * route already uses for the same situation (`not_your_conversation`).
   */
  const stopAnswer = (outcome: 'stopped' | 'idle' | 'not_yours', reply: FastifyReply) => {
    if (outcome === 'not_yours') {
      return reply.code(409).send({
        error: 'not_your_conversation',
        detail: 'That conversation belongs to somebody else in this home, so only they can stop it.',
      });
    }
    return { stopped: outcome === 'stopped' };
  };

  app.post(
    '/api/v1/automations/chat',
    { ...memberOnlyNeeds('automation.manage'), bodyLimit: CHAT_BODY_LIMIT },
    async (request, reply) => {
      if (await chatGuard(request, reply)) return reply;
      const body = z
        .object({
          message: z.string().trim().max(2_000),
          automationId: z.uuid().optional(),
          ...chatTurnFields,
        })
        .refine(saysSomething, saysSomethingIssue)
        .parse(request.body);
      if (body.automationId !== undefined && !deps.automations.get(body.automationId)) {
        return reply.code(404).send({ error: 'not_found' });
      }
      if (await modelRefusal(body.model, reply)) return reply;
      const turn = turnOf(body);
      try {
        const reply_ = await deps.automationChat.start({
          memberId: request.member!.id,
          message: body.message,
          ...(body.automationId !== undefined ? { automationId: body.automationId } : {}),
          ...(turn !== undefined ? { turn } : {}),
        });
        return reply.code(201).send(reply_);
      } catch (error) {
        return chatRefusal(error, reply);
      }
    },
  );

  app.post(
    '/api/v1/automations/chat/:id/messages',
    { ...memberOnlyNeeds('automation.manage'), bodyLimit: CHAT_BODY_LIMIT },
    async (request, reply) => {
      if (await chatGuard(request, reply)) return reply;
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      const body = chatMessageSchema.parse(request.body);
      if (await modelRefusal(body.model, reply)) return reply;
      let answered;
      try {
        // Continuing a conversation the hub has forgotten opens a new one, and
        // that can be refused like starting one — a 409 with a sentence, not
        // the 500 it used to fall through as.
        answered = await deps.automationChat.reply(id, request.member!.id, body.message, turnOf(body));
      } catch (error) {
        return chatRefusal(error, reply);
      }
      /**
       * `410` rather than `404`, and the difference matters: the conversation
       * existed and its transcript is still readable — what is gone is the
       * ability to *continue* it, because the model's own history lives in
       * memory and the hub restarted. An app tells somebody to start a new one
       * rather than that nothing was ever there.
       */
      if (!answered) return reply.code(410).send({ error: 'conversation_ended' });
      return answered;
    },
  );

  /** Stop the round a conversation is running — see `stopAnswer`. */
  app.post(
    '/api/v1/automations/chat/:id/stop',
    memberOnlyNeeds('automation.manage'),
    async (request, reply) => {
      if (await chatGuard(request, reply)) return reply;
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      return stopAnswer(deps.automationChat.stop(id, request.member!.id), reply);
    },
  );

  /**
   * Every conversation this home has had.
   *
   * Listed **before** the `:id` route below, or Fastify would try to parse
   * `chats` as a session uuid. Reading is guarded like the rest of the chat
   * surface: a transcript names the home's devices and what somebody asked
   * for, which is the same shape of thing the rules themselves are.
   */
  app.get('/api/v1/automations/chats', memberOnlyNeeds('automation.manage'), async (request, reply) => {
    if (await chatGuard(request, reply)) return reply;
    // Who is asking, so each row can say whether it is theirs (`mine`).
    return deps.automationChat.list(request.member!.id);
  });

  app.get('/api/v1/automations/chat/:id', memberOnlyNeeds('automation.manage'), async (request, reply) => {
    if (await chatGuard(request, reply)) return reply;
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    // The same `spend` block the list carries, so a chat opened straight from
    // a link says what it cost without the list having been read first.
    const spend = await deps.automationChat.spend(id);
    // Where it came from, when the assistant handed it over — so a chat opened
    // straight from a card can say so and go back, without the list.
    const handedFrom = await deps.automationChat.handedFrom(id);
    return {
      sessionId: id,
      live: deps.automationChat.isLive(id),
      ...(spend !== undefined ? { spend } : {}),
      ...(handedFrom !== undefined ? { handedFrom } : {}),
      messages: await deps.automationChat.transcript(id),
    };
  });

  app.delete('/api/v1/automations/chat/:id', memberOnlyNeeds('automation.manage'), async (request, reply) => {
    if (await chatGuard(request, reply)) return reply;
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    await deps.automationChat.close(id);
    return reply.code(204).send();
  });

  // ── The assistant ────────────────────────────────────────────────────────

  /**
   * The conversation behind the assistant button, and it is guarded by
   * **`hub.ai` alone**.
   *
   * Not `automation.manage`, which the automations chat needs: asking what the
   * kitchen is doing and switching a lamp on is the floor — an app whose whole
   * job is working the home cannot have a member who may not work the home,
   * and reading it is the floor everywhere else here too. `hub.ai` is asked
   * because a conversation spends the home's money, which is the one thing
   * about this that is not free.
   *
   * Handing a job to another agent is where a permission is asked, and it is
   * asked *there* — when the tool runs, against that agent's own key — so a
   * guest gets a sentence the model can read out rather than a feature that is
   * silently absent.
   */
  app.post(
    '/api/v1/assistant/chat',
    { ...memberOnlyNeeds('hub.ai'), bodyLimit: CHAT_BODY_LIMIT },
    async (request, reply) => {
      const body = chatMessageSchema.parse(request.body);
      if (await modelRefusal(body.model, reply)) return reply;
      const turn = turnOf(body);
      try {
        const started = await deps.assistantChat.start({
          memberId: request.member!.id,
          message: body.message,
          ...(turn !== undefined ? { turn } : {}),
        });
        return reply.code(201).send(started);
      } catch (error) {
        return chatRefusal(error, reply);
      }
    },
  );

  app.post(
    '/api/v1/assistant/chat/:id/messages',
    { ...memberOnlyNeeds('hub.ai'), bodyLimit: CHAT_BODY_LIMIT },
    async (request, reply) => {
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      const body = chatMessageSchema.parse(request.body);
      if (await modelRefusal(body.model, reply)) return reply;
      let answered;
      try {
        // A forgotten conversation is reopened here, which can be refused the
        // way starting one is — a 409 with a sentence rather than a 500.
        answered = await deps.assistantChat.reply(id, request.member!.id, body.message, turnOf(body));
      } catch (error) {
        return chatRefusal(error, reply);
      }
      // `410` rather than `404`: the conversation existed and its transcript is
      // still readable — what is gone is the ability to continue it.
      if (!answered) return reply.code(410).send({ error: 'conversation_ended' });
      return answered;
    },
  );

  /**
   * Stop the round a conversation is running — see `stopAnswer`. A job the
   * assistant has already handed over goes on: it is the other agent's
   * conversation now, with its own stop.
   */
  app.post('/api/v1/assistant/chat/:id/stop', memberOnlyNeeds('hub.ai'), async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return stopAnswer(deps.assistantChat.stop(id, request.member!.id), reply);
  });

  /** Listed before the `:id` route below, or Fastify parses `chats` as a uuid. */
  app.get('/api/v1/assistant/chats', memberOnlyNeeds('hub.ai'), async (request) =>
    // Who is asking, so each row can say whether it is theirs (`mine`).
    deps.assistantChat.list(request.member!.id),
  );

  app.get('/api/v1/assistant/chat/:id', memberOnlyNeeds('hub.ai'), async (request) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const spend = await deps.assistantChat.spend(id);
    return {
      sessionId: id,
      live: deps.assistantChat.isLive(id),
      ...(spend !== undefined ? { spend } : {}),
      messages: await deps.assistantChat.transcript(id),
    };
  });

  // ── The assistant's voice ─────────────────────────────────────────────────

  /**
   * Open a live voice session, and answer the phone's connection offer.
   *
   * **The hub builds the session and the phone holds it**, which is the whole
   * arrangement: audio has to go straight from the phone to OpenAI or it is not
   * a conversation, while what the model is told — the home, how to speak, when
   * to ask for help — is the home's business, and the home's key must never
   * leave the machine that holds it.
   *
   * **WebRTC is what makes that possible rather than a preference.** Live's
   * WebSocket transport authenticates with the *project API key* and is
   * documented for server-side audio; there is no ephemeral client secret
   * anywhere in the family. So this takes the phone's SDP offer, attaches the
   * session, posts both with the home's key, and hands back the answer — and
   * the phone ends up holding an audio connection it was never given a
   * credential of any kind for, which is a stronger containment than the
   * expiring secret this route was first built around.
   *
   * **A refusal of its own, and it is a real one.** GPT-Live is OpenAI's and
   * there is no substitute, so a home running its assistant perfectly well on
   * Anthropic still cannot *speak* without an OpenAI key. That is a thing to
   * say plainly — `openai_not_configured`, with a sentence — rather than a 500
   * or, worse, a microphone button that fails on the first word.
   *
   * **`ai_enabled` is not asked**, exactly as the typed assistant does not ask
   * it: that switch is device recognition's, and talking to the house is not
   * recognising a device.
   */
  app.post('/api/v1/assistant/voice/session', memberOnlyNeeds('hub.ai'), async (request, reply) => {
    // **Carrying on rather than forking.** Somebody stops listening and starts
    // again on the same page, and that is one conversation — so the app hands
    // back the id it already has and the transcript keeps going. Absent is the
    // ordinary case: a fresh page mints one. Somebody *else's* is refused
    // below: reading a home's transcripts is shared by design and writing into
    // one is not, which is the guard `revive()` already holds for a typed
    // conversation.
    //
    // **And the phone's own connection offer**, which is what makes the whole
    // arrangement possible: Live authenticates a WebSocket with the *project
    // key* and has no ephemeral client secret anywhere in the family, so a
    // phone can only hold a Live session over WebRTC — where the hub does the
    // offer/answer exchange with the key and the phone is handed no credential
    // at all. Required, so a client that cannot do WebRTC is a `400` rather
    // than a session nothing can connect to.
    const asked = z
      .object({ sessionId: z.uuid().optional(), sdp: z.string().min(1).max(64_000) })
      .parse(request.body ?? {});
    const ai = await deps.settings.getAiSettings();
    if (!ai.openai.hasKey) {
      return reply.code(409).send({
        error: 'openai_not_configured',
        detail:
          'Talking out loud runs on OpenAI’s voice model, so this home needs an OpenAI key — ' +
          'even if the assistant itself answers on Anthropic. Add one in the home’s AI settings.',
      });
    }
    const secret = await deps.settings.aiKey('openai');
    // The same sentence as the check above, not a bare code: this is the race
    // where the key went away between `hasKey` and the read, and an app that
    // falls back to its own wording for `openai_not_configured` is holding one
    // written for *portraits* — the code means "no OpenAI key" on both routes
    // and only the detail says which thing cannot happen.
    if (!secret) {
      return reply.code(409).send({
        error: 'openai_not_configured',
        detail:
          'Talking out loud runs on OpenAI’s voice model, so this home needs an OpenAI key — ' +
          'even if the assistant itself answers on Anthropic. Add one in the home’s AI settings.',
      });
    }

    const [{ openLiveSession }, { liveInstructions, liveHistory }, { attachSideband }] =
      await Promise.all([
        import('../ai/voice/session.js'),
        import('../ai/voice/prompts.js'),
        import('../ai/voice/sideband.js'),
      ]);
    /**
     * **A conversation somebody else is having is refused here**, before a
     * session is opened and before anything is spent.
     *
     * `askAloud` holds the same line, because it is the one that actually
     * writes; this is the sentence, since the alternative is a microphone that
     * transcribes perfectly and answers "that could not be worked out" to
     * everything. `409` rather than `403`: nothing about the caller's role is
     * wrong, and both apps read a 403 as "this home doesn't let your role do
     * that", which would send somebody to the wrong page.
     */
    if (
      asked.sessionId !== undefined &&
      !(await deps.assistantChat.maySpeakInto(asked.sessionId, request.member!.id))
    ) {
      return reply.code(409).send({
        error: 'not_your_conversation',
        detail:
          'That conversation belongs to somebody else in this home. Start a new one to talk out ' +
          'loud.',
      });
    }

    const personName = await deps.assistantChat.personName(request.member!.id);
    // **What the session opens knowing.** Carrying a conversation on means the
    // voice should already have read it — somebody who typed a question and
    // then pressed the microphone is having one conversation, not two — so the
    // last few exchanges go into `session.input`, which the API reads before
    // the first word. A fresh conversation seeds nothing, and a transcript
    // that cannot be read (a session id the app has invented, a role without
    // the rows) is an empty list rather than a refusal.
    const history =
      asked.sessionId === undefined
        ? []
        : liveHistory(await deps.assistantChat.transcript(asked.sessionId));
    /**
     * **A provider that refuses must not reach the app as a 500**, which is a
     * lesson this repository has already paid for once: the automations agent's
     * OpenAI refusal threw past the route's handler, Fastify answered
     * `{"statusCode":500,…}`, and the app drew "The hub answered 500." over a
     * home that was working perfectly and had just said what was wrong.
     *
     * `502` rather than `409`, because the two are different screens: a `409`
     * is something in this home's settings, and the way out is on a page
     * somebody can open. This is OpenAI saying no — a key that has been
     * revoked, a balance that has run out, a rate limit — so the detail is
     * *their* sentence, which is always better than one invented here.
     */
    let opened: Awaited<ReturnType<typeof openLiveSession>>;
    try {
      opened = await openLiveSession({
        secret,
        instructions: liveInstructions({
          home: deps.automations.homeView(),
          timezone: deps.settings.timezone,
          ...(personName !== undefined ? { personName } : {}),
        }),
        history,
        offerSdp: asked.sdp,
        log: deps.log,
      });
    } catch (error) {
      return reply.code(502).send({
        error: 'voice_unavailable',
        detail: error instanceof Error ? error.message : 'OpenAI would not open a voice session.',
      });
    }

    /**
     * **The hub attaches its own connection, and that is where the delegation
     * loop lives.** Client delegation says "I need help" and nothing else, so
     * somebody has to assemble the request from the transcript and answer it —
     * and doing that on the phone added two LAN legs to the one thing on this
     * surface measured in how fast a lamp goes off. A sideband is a second
     * socket onto the *same* session from here, so the request never leaves
     * the machine that can answer it. `src/ai/voice/sideband.ts` is canonical,
     * including what it deliberately does **not** own: audio stays on the
     * phone's WebRTC connection.
     *
     * A failure to attach is logged and nothing more. The session is real and
     * the phone can talk over it; what is lost is the house answering, which
     * the voice reports itself when a delegation goes unanswered.
     *
     * **The id is minted here and the conversation is marked as spoken
     * afterwards**, which is an ordering rather than a style: attaching
     * *replaces* whatever sideband this conversation was holding, and a
     * replaced sideband settles — which is what clears that mark. Marked first,
     * stopping and restarting the microphone quickly cleared the mark the new
     * session had just set. And a session nothing attaches to is never marked
     * at all, since nothing would ever settle it and a conversation left
     * marked logs a typed follow-up as speech. See `beginVoice`.
     */
    const sessionId = asked.sessionId ?? randomUUID();
    if (opened.liveSessionId !== undefined) {
      attachSideband({
        liveSessionId: opened.liveSessionId,
        sessionId,
        memberId: request.member!.id,
        secret,
        host: deps.assistantChat,
        log: deps.log,
      });
      deps.assistantChat.beginVoice(sessionId);
    } else {
      deps.log.warn('voice: OpenAI opened a session without an id, so nothing can attach');
    }

    return reply.code(201).send({
      // **The answer to the phone's offer, and nothing it could have got for
      // itself.** The session — the model, the voice, the instructions, the
      // history, the delegation mode — was described here and is never sent to
      // the app at all, so a prompt change, a voice change or a configuration
      // key this API grows next month reaches the microphone with no app
      // release. And no credential crosses: the key stayed on this machine and
      // what the phone receives is an SDP answer.
      answerSdp: opened.answerSdp,
      // OpenAI's own id for the session is deliberately **not** sent. It is
      // what the hub attaches its sideband with, and the app has no use for
      // one — `session.started` carries it on the data channel if a log line
      // ever wants it.
      audioRate: opened.audioRate,
      // The conversation the phone will write into. A plain id: nothing on this
      // hub is holding a model conversation for it, and the transcript is what
      // makes it findable, readable and — by typing — continuable afterwards.
      sessionId,
    });
  });

  /**
   * **Two routes used to live here and the sideband replaced both.**
   *
   * `POST /assistant/voice/said` wrote down what was said, because the hub was
   * not in the audio path and the phone was the only thing that knew. And
   * `POST /assistant/voice/ended` reported what a session cost, measured with
   * a stopwatch on that phone — the softest number in this ledger, and gone
   * entirely when somebody force-quit.
   *
   * The hub's own sideband receives the transcript and the usage from the
   * session itself, so both facts now come from the thing that owns them:
   * `askAloud` writes the rows a spoken exchange leaves, and
   * `session.usage.updated` / `session.closed` carry the seconds OpenAI will
   * bill. Which leaves **one** voice route — opening a session — and the rule
   * the API states for two connections onto one session: assign one owner per
   * action. See `src/ai/voice/sideband.ts`.
   */

  app.delete('/api/v1/assistant/chat/:id', memberOnlyNeeds('hub.ai'), async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    await deps.assistantChat.close(id);
    return reply.code(204).send();
  });

  // ── WebSocket event stream ───────────────────────────────────────────────

  /**
   * **No `HEAD` twin.** Fastify gives every `GET` one, and `@fastify/websocket`
   * deliberately leaves a `HEAD` route's handler untouched — so the twin ran
   * the handler below as an ordinary HTTP handler, with the *request* standing
   * in for the socket. `attachWebSocket` put a listener on every always-on bus
   * event, then threw on `socket.on`, before the close handler that takes them
   * off was ever registered: an unauthenticated `HEAD` from anywhere on the LAN
   * left thirteen listeners behind for the life of the process. Without the
   * twin a `HEAD` here is the ordinary 404.
   *
   * **It authenticates inside the handler, keys included**, and that is not a
   * shortcut: a preHandler that refuses an upgrade reaches the client as a
   * failed handshake — a 1006 with no reason — and never as the 4001 every
   * client already stops reconnecting on. So a key that is expired, paused or
   * revoked closes 4001 like a member token that is no good; one opened faster
   * than its rate allows closes 1013, "try again later"; and one holding
   * `MAX_SOCKETS_PER_KEY` streams already closes 1008. A key may arrive as
   * `?token=` here and nowhere else, because some socket clients cannot set a
   * header — and the query string never reaches the log (see the logger above).
   */
  app.get(
    '/api/v1/ws',
    { websocket: true, exposeHeadRoute: false, config: { apiKey: 'handler' } },
    (socket, request) => {
      // Subscribe synchronously, before the async token check, so an event
      // fired the moment the socket opens is held — and rendered once the
      // socket knows who is reading — instead of lost in the gap between
      // "connected" and "authorized".
      const handle = attachWebSocket(socket, deps, sessions, hubStatus);
      void (async () => {
        const credential = extractCredential(request);
        const result = credential
          ? await authenticate({ pairing: deps.pairing, apiKeys, access: deps.access }, credential, {
              method: request.method,
              path: pathOf(request.url),
              ip: request.ip,
              allowKeyInQuery: true,
            })
          : undefined;
        if (!result?.ok) {
          handle.close();
          if (result?.status === 429) socket.close(KEY_RATE_CLOSE_CODE, 'rate limited');
          else socket.close(UNAUTHORIZED_CLOSE_CODE, 'unauthorized');
          return;
        }
        if (result.key && sessions.countKey(result.key.id) >= MAX_SOCKETS_PER_KEY) {
          apiKeys.noteRefusal(result.key.id, {
            at: new Date(),
            status: 429,
            error: 'too_many_connections',
            method: request.method,
            path: pathOf(request.url),
          });
          handle.close();
          socket.close(KEY_LIMIT_CLOSE_CODE, 'too many connections for this key');
          return;
        }
        handle.authorize(result.member.id, result.key);
      })();
    },
  );

  return app;
}
