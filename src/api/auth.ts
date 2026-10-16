import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Member } from '../core/pairing.js';
import type { PairingService } from '../core/pairing.js';
import { isKeyGrantable, type AccessService, type PermissionKey } from '../core/access.js';
import { apiKeyState, type ApiKeyRecord, type ApiKeyService } from '../core/api-keys.js';
import { looksLikeApiKey } from '../core/crypto.js';

/**
 * What an API key may do on a route — declared on every route, and checked
 * before anything else about a request made with a key.
 *
 *  - `public` — no credential at all: `GET /hub`, `POST /pair`, `POST /hub/proof`.
 *  - `read` — any key. Only a `GET` may be this: reading the home is what a
 *    key gives without being asked, and a route that changes something and
 *    says `read` would be every key's to call.
 *  - `control` — working the home: a command, pressing a scene, switching a
 *    mode. A key needs `control`.
 *  - `permission` — the route names a permission (`needs(…)`), and a key
 *    needs it granted, grantable, and still held by its member.
 *  - `handler` — the handler asks, because one field of the body decides
 *    which question to ask (`PATCH /devices/:id`), or because it authenticates
 *    for itself (`/ws`).
 *  - `deny` — never with a key: minting a credential, changing or ending a
 *    membership, and every conversation.
 *
 * A route that declares nothing gets `read` if it is a `GET` and `deny`
 * otherwise, so a write added tomorrow with no thought given to keys is closed
 * to them rather than open. `server.ts` records the whole table and
 * `test/api-keys.test.ts` pins it.
 */
export type ApiKeyPolicy = 'public' | 'read' | 'control' | 'permission' | 'handler' | 'deny';

/** One row of that table, as `app.apiKeyPolicies` holds it. */
export interface RoutePolicy {
  method: string;
  url: string;
  policy: ApiKeyPolicy;
  permission?: PermissionKey;
  /** Whether the route resolves a credential before its handler runs. */
  authenticated: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Who is asking — the member row, always, including for a request made
     * through one of their keys. Everything that writes a member id (the
     * activity log, favorites, who wrote a rule) keeps working unchanged,
     * because a key acts *as* its member.
     */
    member: Member | null;
    /** The key the request came through, or null for the member themselves. */
    apiKey: ApiKeyRecord | null;
  }
  interface FastifyContextConfig {
    apiKey?: ApiKeyPolicy;
    permission?: PermissionKey;
  }
  interface FastifyInstance {
    /** Every route and what a key may do there — for the suite that pins it. */
    apiKeyPolicies: readonly RoutePolicy[];
  }
}

/** A credential as it arrived, and where. */
export interface Credential {
  token: string;
  /** Whether it came in the query string rather than the `Authorization` header. */
  inQuery: boolean;
}

/**
 * The bearer credential on this request — the `Authorization` header first,
 * then `?token=`, which the apps' sockets have used and which therefore stays
 * for a member token.
 */
export function extractCredential(request: FastifyRequest): Credential | null {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const token = header.slice('Bearer '.length).trim();
    if (token.length > 0) return { token, inQuery: false };
  }
  const query = request.query as Record<string, unknown> | undefined;
  if (typeof query?.token === 'string' && query.token.length > 0) {
    return { token: query.token, inQuery: true };
  }
  return null;
}

/** The path of a request without its query string, which may hold a credential. */
export function pathOf(url: string): string {
  const cut = url.indexOf('?');
  return cut === -1 ? url : url.slice(0, cut);
}

export interface PrincipalDeps {
  pairing: PairingService;
  apiKeys: ApiKeyService;
  access: AccessService;
}

/** Who a credential turned out to be — or why it is no good. */
export type Authentication =
  | { ok: true; member: Member; key: ApiKeyRecord | null }
  | {
      ok: false;
      status: 401 | 429;
      body: Record<string, unknown>;
      /** Set for a 429, in milliseconds. */
      retryAfterMs?: number;
    };

const UNAUTHORIZED = { error: 'unauthorized' } as const;

/**
 * Resolve a credential to a member, or to a member's key.
 *
 * A key is told apart by its shape (`gethome_…`) and looked up first; one that
 * is not found falls through to the member tokens, so an unlucky member token
 * of that shape is still a member token. Then, for a key:
 *
 *  - **Not in the query string**, except where `allowKeyInQuery` says so —
 *    the event stream, where some clients cannot set a header. Anywhere else a
 *    URL is something proxies, shells and browsers write down, and a key is a
 *    secret that lasts for years.
 *  - **Its member is read now**, on every request, as a token's is: a key
 *    whose member has gone is worth nothing even for the instant before the
 *    cascade, and the name on what it does is the member's current one.
 *  - **Expired and suspended are refusals with a reason**, so the integration
 *    that stopped can say why rather than "unauthorized".
 *  - **And it is rate-limited** — per key, never per member token.
 *
 * Every refusal of a key that *was* found is noted against it, which is how an
 * app can show the owner of a broken integration what the hub last said to it.
 */
export async function authenticate(
  deps: PrincipalDeps,
  credential: Credential,
  context: { method: string; path: string; ip: string; allowKeyInQuery: boolean },
): Promise<Authentication> {
  if (looksLikeApiKey(credential.token)) {
    const key = await deps.apiKeys.find(credential.token);
    if (key) {
      const refuse = (
        status: 401 | 429,
        body: { error: string; reason?: string; retryAfterMs?: number },
      ): Authentication => {
        deps.apiKeys.noteRefusal(key.id, {
          at: new Date(),
          status,
          error: body.error,
          ...(body.reason !== undefined ? { reason: body.reason } : {}),
          method: context.method,
          path: context.path,
        });
        return {
          ok: false,
          status,
          body,
          ...(body.retryAfterMs !== undefined ? { retryAfterMs: body.retryAfterMs } : {}),
        };
      };
      if (credential.inQuery && !context.allowKeyInQuery) {
        return refuse(401, { ...UNAUTHORIZED, reason: 'key_in_query' });
      }
      const member = await deps.pairing.member(key.memberId);
      if (!member) return { ok: false, status: 401, body: { ...UNAUTHORIZED } };
      const state = apiKeyState(key, deps.access);
      if (state === 'expired') return refuse(401, { ...UNAUTHORIZED, reason: 'key_expired' });
      if (state === 'suspended') return refuse(401, { ...UNAUTHORIZED, reason: 'key_suspended' });
      const allowed = deps.apiKeys.take(key.id);
      if (!allowed.ok) {
        return refuse(429, { error: 'rate_limited', retryAfterMs: allowed.retryAfterMs });
      }
      // A use is noted only once the request is through the door. A request
      // turned away at it is a refusal and nothing else: counting it would
      // move "last used" on — and write the row, when the address is new —
      // for a script the hub is busy refusing.
      deps.apiKeys.noteUse(key, context.ip);
      return { ok: true, member, key };
    }
  }
  const member = await deps.pairing.verifyToken(credential.token);
  return member
    ? { ok: true, member, key: null }
    : { ok: false, status: 401, body: { ...UNAUTHORIZED } };
}

/** The preHandlers that resolve a credential, so the route table can tell. */
const principalHandlers = new WeakSet<object>();

export function isPrincipalHandler(handler: unknown): boolean {
  return typeof handler === 'function' && principalHandlers.has(handler);
}

/**
 * preHandler: resolves the bearer credential to a member — or to one of a
 * member's keys — or replies 401. For a key it then holds the route to its
 * declared policy, before any handler runs.
 */
export function requirePrincipal(deps: PrincipalDeps) {
  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
    const credential = extractCredential(request);
    if (!credential) {
      await reply.code(401).send({ ...UNAUTHORIZED });
      return reply;
    }
    const result = await authenticate(deps, credential, {
      method: request.method,
      path: pathOf(request.url),
      ip: request.ip,
      allowKeyInQuery: false,
    });
    if (!result.ok) {
      if (result.retryAfterMs !== undefined) {
        void reply.header('retry-after', String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))));
      }
      await reply.code(result.status).send(result.body);
      return reply;
    }
    request.member = result.member;
    request.apiKey = result.key;
    if (result.key) {
      const refusal = keyPolicyRefusal(deps.access, request, result.member, result.key);
      if (refusal) {
        await reply.code(403).send(refusal);
        return reply;
      }
    }
    return undefined;
  };
  principalHandlers.add(handler);
  return handler;
}

/**
 * Why this key may not use this route, or undefined if it may.
 *
 * `permission` is checked here as well as by `requirePermission`, which comes
 * next: a route declared `permission` that somehow lost its second preHandler
 * must still not be a key's for the asking.
 */
function keyPolicyRefusal(
  access: AccessService,
  request: FastifyRequest,
  member: Member,
  key: ApiKeyRecord,
): Record<string, unknown> | undefined {
  const config = request.routeOptions.config;
  switch (config.apiKey) {
    case 'public':
    case 'read':
    case 'handler':
      return undefined;
    case 'control':
      return key.control ? undefined : { error: 'key_read_only' };
    case 'permission':
      return permissionRefusal(access, member, key, config.permission);
    case 'deny':
    default:
      return { error: 'key_not_allowed' };
  }
}

/**
 * The refusal a key gets for a permission, or undefined if it holds it.
 *
 * Two different answers, because they need two different fixes. A permission
 * no key may ever hold (`key_not_allowed`) is a route this integration has to
 * do without, or ask a person to do; one it simply was not given, or its
 * member no longer has (`forbidden`), is fixed by changing the key or the
 * role — the same `{error, permission}` a member is refused with, so the
 * apps' sentence for it already exists.
 */
function permissionRefusal(
  access: AccessService,
  member: Member,
  key: ApiKeyRecord,
  permission: PermissionKey | undefined,
): Record<string, unknown> | undefined {
  if (permission === undefined) return { error: 'key_not_allowed' };
  if (!isKeyGrantable(permission)) return { error: 'key_not_allowed', permission };
  if (!access.canThrough(member.id, permission, key)) return { error: 'forbidden', permission };
  return undefined;
}

/**
 * preHandler add-on: requires the caller to hold a permission.
 *
 * This replaced `requireOwner`, which was one string comparison guarding
 * fifteen routes — the only knob anybody had was which side of the owner line
 * a whole route sat on. There is deliberately no second mechanism left beside
 * it: a route is either open to every member (the floor — reading the home,
 * renaming yourself, leaving) or it names the permission it needs.
 *
 * **The refusal names the permission**, because "the hub said no" leaves a
 * person with no idea what to ask for. Apps turn `{error, permission}` into a
 * sentence; the owner is answered `true` without any of this being consulted,
 * so a home can never lock itself out — and a key is answered by
 * `canThrough`, which the owner rule never reaches.
 */
export function requirePermission(access: AccessService, permission: PermissionKey) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const member = request.member;
    if (!member) {
      await reply.code(403).send({ error: 'forbidden', permission });
      return reply;
    }
    const refusal = request.apiKey
      ? permissionRefusal(access, member, request.apiKey, permission)
      : access.can(member.id, permission)
        ? undefined
        : { error: 'forbidden', permission };
    if (refusal) {
      await reply.code(403).send(refusal);
      return reply;
    }
    return undefined;
  };
}

/**
 * May the caller do this — the member, or the member through the key the
 * request came in on?
 *
 * **Every check a handler makes for itself goes through here**, never through
 * `access.can(request.member.id, …)`: that asks about the member, and a key
 * is the member narrowed. `test/api-keys.test.ts` scans `src/api` for the
 * other spelling, because it compiles, passes every member test, and widens
 * every key to its member's whole role.
 */
export function can(access: AccessService, request: FastifyRequest, permission: PermissionKey): boolean {
  const member = request.member;
  if (!member) return false;
  return access.canAs(member.id, permission, request.apiKey);
}

/** Whether a key-held request may work the home. A member always may. */
export function mayControl(request: FastifyRequest): boolean {
  return request.apiKey === null || request.apiKey.control;
}
