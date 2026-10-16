import { count, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { apiKeys } from '../db/schema.js';
import { KEY_GRANTABLE, type KeyGrant, type PermissionKey } from './access.js';
import { generateApiKeySecret, sha256Hex } from './crypto.js';
import { lastUsedDue } from './last-used.js';

/**
 * A member's keys for their own software.
 *
 * A key is **a member's token with a leash**: it acts as the member who made
 * it — their name is on everything it does, their role bounds it, and it goes
 * when they do — but only for what they chose to hand it (`control`, and a few
 * grantable permissions), and only while their role still lets them have keys
 * at all. `AccessService.canThrough` is the answer to "may this key do that";
 * this service is the keys themselves, and what the hub has seen them do.
 *
 * **The table is the truth, and it is read on every request.** A key is looked
 * up by the hash of the secret, which is one indexed read — the same cost a
 * member token pays — and that leaves nothing in memory that could disagree
 * with the row. What *is* held here is what is deliberately not a row:
 *
 *  - when and from where each key was last used, exactly, while the row is
 *    written at most hourly (the `tokens.last_used_at` rule, because a script
 *    polling once a second would otherwise be a row write a second on an SD
 *    card);
 *  - the last refusal a key met, which is the answer to "why has my
 *    integration stopped" and is worth nothing after a restart;
 *  - a token bucket per key, so one runaway script cannot take a Zero 2 W's
 *    whole attention away from the house.
 */

/** A member who wants more than this wants one key per integration, not more keys. */
export const MAX_KEYS_PER_MEMBER = 25;
/** Ten years — "never" is `null`, and a number bigger than this is a typo. */
export const MAX_KEY_LIFETIME_DAYS = 3650;

/**
 * The rate a key may sustain, and the burst it may spend first.
 *
 * Ten a second is a dashboard polling several things at once with room to
 * spare, and fifty is a script waking up and reading the whole home. What it
 * stops is the loop with no sleep in it, which on a 512 MB board is the
 * difference between a slow integration and a hub nobody can reach.
 */
export const KEY_RATE_PER_SECOND = 10;
export const KEY_RATE_BURST = 50;

/** How many event streams one key may hold open at once. */
export const MAX_SOCKETS_PER_KEY = 5;

/**
 * A key as the table holds it. `control` and `permissions` are its
 * `KeyGrant` — what it was given, with `permissions` read back through the
 * allowlist — and are declared there alone, so the two cannot drift apart.
 */
export interface ApiKeyRecord extends KeyGrant {
  id: string;
  memberId: string;
  name: string;
  /** The secret's last four characters. */
  hint: string;
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  lastUsedFrom: string | null;
}

/**
 * Whether a key works right now.
 *
 * **An open vocabulary**, the `commandFailed.kind` rule: an app that meets a
 * word it does not know says the key is not working and shows the rest.
 *
 *  - `active` — it works.
 *  - `expired` — its time ran out. Changing its expiry brings it back.
 *  - `suspended` — its member's role no longer lets them have keys. Nothing
 *    about the key changed, and giving the role `hub.apikeys` back resumes
 *    every key it paused.
 */
export type ApiKeyState = 'active' | 'expired' | 'suspended';

/** The last thing a key was told no, and where. */
export interface ApiKeyRefusal {
  at: Date;
  status: number;
  error: string;
  /** The permission a `forbidden` or `key_not_allowed` named. */
  permission?: string;
  /** The reason a `401` gave — `key_expired`, `key_in_query`… */
  reason?: string;
  method: string;
  /** The path, never the query string — a key may have been in it. */
  path: string;
}

export interface NewApiKey {
  memberId: string;
  name: string;
  control: boolean;
  permissions: readonly PermissionKey[];
  expiresAt: Date | null;
}

export interface ApiKeyPatch {
  name?: string;
  control?: boolean;
  permissions?: readonly PermissionKey[];
  expiresAt?: Date | null;
}

/** Keep only what a key may be given, in catalog order, once each. */
export function grantablePermissions(raw: unknown): PermissionKey[] {
  const wanted = new Set(
    Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === 'string') : [],
  );
  return KEY_GRANTABLE.filter((key) => wanted.has(key));
}

/**
 * Whether a key works, given its member's standing.
 *
 * Expiry is asked first: it is the one a person can fix on the key itself,
 * while a suspension is fixed in the role matrix — and an expired key would
 * still be expired the moment the role came back.
 */
export function apiKeyState(
  key: Pick<ApiKeyRecord, 'memberId' | 'expiresAt'>,
  access: { can(memberId: string, permission: PermissionKey): boolean },
  now = Date.now(),
): ApiKeyState {
  if (key.expiresAt !== null && key.expiresAt.getTime() <= now) return 'expired';
  if (!access.can(key.memberId, 'hub.apikeys')) return 'suspended';
  return 'active';
}

type ApiKeyRow = typeof apiKeys.$inferSelect;

export class ApiKeyService {
  /** The exact last use, ahead of the row — see the class comment. */
  private readonly uses = new Map<string, { at: Date; from: string; writtenAt: number; writtenFrom: string | null }>();
  private readonly refusals = new Map<string, ApiKeyRefusal>();
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  /** Whose each key is, for `forgetMember` after the cascade has taken the rows. */
  private readonly memberOf = new Map<string, string>();

  constructor(private readonly db: Db) {}

  /** The key this secret is, if it is one. */
  async find(secret: string): Promise<ApiKeyRecord | undefined> {
    const row = await this.db.query.apiKeys.findFirst({
      where: eq(apiKeys.keyHash, sha256Hex(secret)),
    });
    return row ? this.record(row) : undefined;
  }

  async get(id: string): Promise<ApiKeyRecord | undefined> {
    const row = await this.db.query.apiKeys.findFirst({ where: eq(apiKeys.id, id) });
    return row ? this.record(row) : undefined;
  }

  /** Every key, or one member's, oldest first. */
  async list(memberId?: string): Promise<ApiKeyRecord[]> {
    const rows = await this.db.query.apiKeys.findMany({
      ...(memberId !== undefined ? { where: eq(apiKeys.memberId, memberId) } : {}),
      orderBy: (table, { asc }) => [asc(table.createdAt)],
    });
    return rows.map((row) => this.record(row));
  }

  /**
   * Make a key, and hand back its secret — the only time it exists anywhere
   * but in the caller's hands. The row keeps its hash and its last four
   * characters, which is enough to recognise it and never enough to use it.
   *
   * `undefined` when the member already holds `MAX_KEYS_PER_MEMBER`. **The
   * count and the insert are one synchronous transaction**, deliberately with
   * no `await` between them: counted in one query and inserted in the next,
   * requests sent together each found room for one more, and a member could
   * pass the cap by as many as they could send at once.
   */
  async create(input: NewApiKey): Promise<{ record: ApiKeyRecord; secret: string } | undefined> {
    const secret = generateApiKeySecret();
    const row = this.db.transaction((tx) => {
      const held = tx
        .select({ n: count() })
        .from(apiKeys)
        .where(eq(apiKeys.memberId, input.memberId))
        .get();
      if ((held?.n ?? 0) >= MAX_KEYS_PER_MEMBER) return undefined;
      return tx
        .insert(apiKeys)
        .values({
          memberId: input.memberId,
          name: input.name,
          keyHash: sha256Hex(secret),
          hint: secret.slice(-4),
          control: input.control,
          permissions: grantablePermissions(input.permissions),
          expiresAt: input.expiresAt,
        })
        .returning()
        .get();
    });
    return row ? { record: this.record(row), secret } : undefined;
  }

  async update(id: string, patch: ApiKeyPatch): Promise<ApiKeyRecord | undefined> {
    const values = {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.control !== undefined ? { control: patch.control } : {}),
      ...(patch.permissions !== undefined
        ? { permissions: grantablePermissions(patch.permissions) }
        : {}),
      ...(patch.expiresAt !== undefined ? { expiresAt: patch.expiresAt } : {}),
    };
    // An empty body changes nothing, and drizzle refuses an empty `SET` with
    // a throw — which would reach somebody as a 500 for asking nothing.
    if (Object.keys(values).length === 0) return this.get(id);
    const [row] = await this.db.update(apiKeys).set(values).where(eq(apiKeys.id, id)).returning();
    return row ? this.record(row) : undefined;
  }

  async remove(id: string): Promise<boolean> {
    const removed = await this.db.delete(apiKeys).where(eq(apiKeys.id, id)).returning();
    this.forget(id);
    return removed.length > 0;
  }

  // ── What the hub has seen ────────────────────────────────────────────────

  /**
   * A request came in on this key, from this address.
   *
   * Held exactly in memory and written through at most hourly, or at once
   * when the address moves — "from where" changing is the one thing about use
   * that is worth a write the moment it happens, and it happens rarely.
   * Fire-and-forget: a request is never failed because a timestamp did not
   * stick.
   */
  noteUse(key: ApiKeyRecord, address: string, now = Date.now()): void {
    this.memberOf.set(key.id, key.memberId);
    const previous = this.uses.get(key.id);
    const writtenAt = previous?.writtenAt ?? key.lastUsedAt?.getTime() ?? 0;
    const writtenFrom = previous ? previous.writtenFrom : key.lastUsedFrom;
    const due = lastUsedDue(writtenAt, now) || writtenFrom !== address;
    this.uses.set(key.id, {
      at: new Date(now),
      from: address,
      writtenAt: due ? now : writtenAt,
      writtenFrom: due ? address : writtenFrom,
    });
    if (!due) return;
    void this.db
      .update(apiKeys)
      .set({ lastUsedAt: new Date(now), lastUsedFrom: address })
      .where(eq(apiKeys.id, key.id))
      .catch(() => undefined);
  }

  noteRefusal(keyId: string, refusal: ApiKeyRefusal): void {
    this.refusals.set(keyId, refusal);
  }

  lastRefusal(keyId: string): ApiKeyRefusal | undefined {
    return this.refusals.get(keyId);
  }

  /**
   * Spend one request from this key's bucket — or say how long until there is
   * one to spend.
   */
  take(keyId: string, now = Date.now()): { ok: true } | { ok: false; retryAfterMs: number } {
    const bucket = this.buckets.get(keyId) ?? { tokens: KEY_RATE_BURST, at: now };
    const refilled = Math.min(
      KEY_RATE_BURST,
      bucket.tokens + ((now - bucket.at) / 1000) * KEY_RATE_PER_SECOND,
    );
    if (refilled >= 1) {
      this.buckets.set(keyId, { tokens: refilled - 1, at: now });
      return { ok: true };
    }
    this.buckets.set(keyId, { tokens: refilled, at: now });
    return { ok: false, retryAfterMs: Math.ceil(((1 - refilled) / KEY_RATE_PER_SECOND) * 1000) };
  }

  /** A key is gone: drop what was held about it. */
  forget(keyId: string): void {
    this.uses.delete(keyId);
    this.refusals.delete(keyId);
    this.buckets.delete(keyId);
    this.memberOf.delete(keyId);
  }

  /**
   * Their keys went with the member row (`api_keys.member_id` cascades); this
   * is the in-memory half, the `FavoritesService.forgetMember` shape.
   */
  forgetMember(memberId: string): void {
    for (const [keyId, owner] of [...this.memberOf]) {
      if (owner === memberId) this.forget(keyId);
    }
  }

  private record(row: ApiKeyRow): ApiKeyRecord {
    this.memberOf.set(row.id, row.memberId);
    const use = this.uses.get(row.id);
    return {
      id: row.id,
      memberId: row.memberId,
      name: row.name,
      hint: row.hint,
      control: row.control,
      permissions: grantablePermissions(row.permissions),
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      lastUsedAt: use?.at ?? row.lastUsedAt,
      lastUsedFrom: use?.from ?? row.lastUsedFrom,
    };
  }
}
