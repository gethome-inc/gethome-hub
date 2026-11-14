import { pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { asc, count, eq } from 'drizzle-orm';
import type { HubEventBus } from './bus.js';
import type { Db } from '../db/client.js';
import { mqttDeviceAccounts } from '../db/schema.js';
import type { Logger } from '../logging.js';

/**
 * A broker account for each device, so a board is confined to its own topics
 * and stops working the moment it is taken out of the home.
 *
 * The broker had two accounts, and every board somebody set up was handed the
 * same one — `gethome`, which may write anywhere under `gethome/`. So any
 * board could publish another device's state, discovery document or commands,
 * and a board that was switched off while it was deleted came straight back
 * when it was switched on: the hub clears its retained topics, which leaves
 * nothing for it to hear, and its password still worked.
 *
 * An account here is **the device's id as a broker username**, which is what
 * lets one static line in mosquitto's ACL confine every account at once
 * (`pattern readwrite gethome/device/%u/#`): the broker substitutes whoever
 * signed in, so there is no per-device rule to write, and none to get wrong.
 * The one thing that is per device is the project a device says it is part
 * of, which adds that project's own branch and no other.
 *
 * **In the shape an API key has** (`core/api-keys.ts`): the password exists in
 * the answer to the request that made it and nowhere afterwards, the row keeps
 * a hash, and taking the account away ends it. The hash is the broker's own —
 * the line mosquitto's password file holds — rather than this hub's sha256,
 * because the broker is what checks the password and the hub never does.
 *
 * **The hub records; root applies.** The password file and the ACL are root's
 * and mosquitto's, and the account this process runs as cannot touch either —
 * which is the point of that account. So the shape `core/wifi-networks.ts`
 * has: the whole list goes into the hub's own data directory,
 * `gethome-mqtt-accounts.path` notices, and `deploy/mqtt-accounts.sh` rebuilds
 * the two files and has the broker read them again. What crosses is hashes and
 * names, never a password. And it is the **whole list every time**, not a
 * change to make: a request that was missed is healed by the next one, and
 * `install.sh` — which writes the password file afresh on every update — puts
 * the same list back by running the same script.
 */

const ACCOUNTS_DIR = 'mqtt-accounts';

/**
 * What a device id is on the MQTT convention, and so what a broker username
 * here is. The same pattern as `DEVICE_ID_PATTERN` in the adapter's
 * `convention.ts`, written out because `core/` does not import an adapter;
 * `test/mqtt-device-accounts.test.ts` holds the two together. Letters, digits,
 * `_` and `-` — none of which mosquitto's `%u` substitution, its password
 * file's `:` separator or a line-based file can trip over.
 */
export const MQTT_ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * How many devices may hold an account. The root script enforces the same
 * number; this is the hub saying so before it asks. A bound because every
 * line is re-checked by the broker on each reload, and because a client stuck
 * in a loop must not be able to grow a file root reads without limit.
 */
export const MAX_MQTT_DEVICE_ACCOUNTS = 250;

/**
 * mosquitto's own default for the passwords it hashes itself, and deliberately
 * no higher: the password is 128 random bits, which no number of rounds makes
 * harder to guess, while the broker re-derives every connected client's hash
 * on each reload — on a board with one core to spare.
 */
const PBKDF2_ROUNDS = 101;

/**
 * How long a device that was just removed is left its connection.
 *
 * Removing a device clears its retained topics, and a device listening to its
 * own config topic hears that as "you were removed — stay out until you are
 * set up again". Taking the account away drops the connection, so it must not
 * get there first: a board cut off before it heard why goes on knocking with a
 * password that will never work again. The row goes at once — nothing can
 * bring the account back — and only the broker's reload waits.
 */
export const REVOKE_SETTLE_MS = 2000;

export type MqttDeviceAccountsAvailability =
  | { available: true }
  /**
   * Nothing on this machine applies the list: an installer from before this,
   * a broker that takes connections with no password, or one whose password
   * file this hub does not know how to write a line for.
   */
  | { available: false; reason: 'not-installed' };

/** A device's account as the table holds it — never its password. */
export interface MqttDeviceAccount {
  deviceId: string;
  projectKey: string | null;
  memberId: string | null;
  memberName: string;
  createdAt: Date;
}

/** The root script's own vocabulary for what went wrong. */
export type MqttAccountsApplyError = 'no-hub-account' | 'no-acl' | 'write' | 'unreadable';

export interface MqttAccountsApplyResult {
  id: string;
  state: 'applied' | 'failed';
  error?: MqttAccountsApplyError;
  detail?: string;
  at?: string;
}

export type MintMqttAccountOutcome =
  | {
      ok: true;
      account: MqttDeviceAccount;
      /** The only time this exists anywhere but in the caller's hands. */
      password: string;
      /** The device already had an account, and this one took its place. */
      replaced: boolean;
      /**
       * …and it was this same member who gave it the one it had. Setting your
       * own board up again says nothing the home has not already been told,
       * which is why a caller logs the first account and somebody else's
       * replacement, and not this.
       */
      replacedOwn: boolean;
      /**
       * `applied` once the broker has read the new list. `pending` when the
       * root script did not answer inside the wait: the account is recorded
       * and still on its way, which a slow board makes ordinary.
       */
      state: 'applied' | 'pending';
    }
  | {
      ok: false;
      /**
       * `unavailable` — this machine gives no device an account. `reserved` —
       * the id is one of the broker's own two names. `limit` — the hub holds
       * as many as it will. `failed` — the root script refused the list, in
       * `detail`'s words; nothing was kept.
       */
      reason: 'unavailable' | 'reserved' | 'limit' | 'failed';
      detail?: string;
    };

/**
 * A password in the form mosquitto's password file holds it:
 * `$7$<rounds>$<salt>$<hash>`, PBKDF2-HMAC-SHA512 over the password with a
 * 12-byte salt and a 64-byte result, both base64 — byte for byte what
 * `mosquitto_passwd` writes (`test/deploy-mqtt-acl.test.ts` signs in to a real
 * broker with one).
 */
export function brokerPasswordHash(password: string, salt: Buffer = randomBytes(12)): string {
  const hash = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, PBKDF2_ROUNDS, 64, 'sha512');
  return `$7$${PBKDF2_ROUNDS}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/**
 * A new account's password: 16 random bytes as hex, the shape `install.sh`
 * gives the broker's own two — and for its reason. It ends up in a board's
 * flash and in a JSON file on somebody's computer, and hex survives every
 * quoting rule on the way there.
 */
function generatePassword(): string {
  return randomBytes(16).toString('hex');
}

/** The topic filters an account may publish to and read, in the broker's own syntax. */
export function mqttAccountTopics(deviceId: string, projectKey: string | null): string[] {
  return [
    `gethome/device/${deviceId}/#`,
    `gethome/discovery/${deviceId}/#`,
    ...(projectKey !== null ? [`gethome/project/${projectKey}/#`] : []),
  ];
}

function accountsDir(dataDir: string): string {
  return path.join(dataDir, ACCOUNTS_DIR);
}

/**
 * Whether this machine gives devices their own accounts at all.
 *
 * `install.sh` writes `enabled` in the same breath as the unit that applies
 * the list, and only once the broker really is asking for a password and
 * writes its own lines the way this module does — so the file cannot promise
 * plumbing that was never installed. Never throws: `GET /hub` reads the
 * answer, and nothing that route reads may.
 */
export function mqttDeviceAccountsAvailability(dataDir: string): MqttDeviceAccountsAvailability {
  try {
    if (existsSync(path.join(accountsDir(dataDir), 'enabled'))) return { available: true };
  } catch {
    // Unreadable is the same answer as absent.
  }
  return { available: false, reason: 'not-installed' };
}

const APPLY_ERRORS = new Set<string>(['no-hub-account', 'no-acl', 'write', 'unreadable']);

/** What became of the last list the root script applied, or nothing. */
export function readMqttAccountsResult(dataDir: string): MqttAccountsApplyResult | undefined {
  let raw: string;
  try {
    raw = readFileSync(path.join(accountsDir(dataDir), 'result'), 'utf8');
  } catch {
    return undefined;
  }
  const values = new Map<string, string>();
  for (const line of raw.split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    if (!values.has(key)) values.set(key, line.slice(eq + 1));
  }
  const id = values.get('id');
  const state = values.get('state');
  if (id === undefined || id.length === 0) return undefined;
  if (state !== 'applied' && state !== 'failed') return undefined;
  const error = values.get('error');
  const detail = values.get('detail');
  const at = values.get('at');
  return {
    id,
    state,
    ...(error !== undefined && APPLY_ERRORS.has(error) ? { error: error as MqttAccountsApplyError } : {}),
    ...(detail !== undefined && detail.length > 0 ? { detail } : {}),
    ...(at !== undefined && at.length > 0 ? { at } : {}),
  };
}

export interface MqttDeviceAccountsOptions {
  db: Db;
  dataDir: string;
  /**
   * Where the registry says a device has left the home. Given, the service
   * follows it by itself and takes a removed device's account away — the
   * `FavoritesService` arrangement, so nothing else has to remember to.
   */
  events?: HubEventBus;
  /**
   * The broker's own two usernames. A device may not be given either name:
   * its account would be the hub's or the integrations account under a new
   * password. The root script refuses the same two, against the broker's own
   * file rather than this list.
   */
  reserved: readonly string[];
  log: Logger;
  /** How long a change waits for the root script before it answers `pending`. */
  applyWaitMs?: number;
  /** See `REVOKE_SETTLE_MS`. A suite makes it zero. */
  revokeSettleMs?: number;
}

type AccountRow = typeof mqttDeviceAccounts.$inferSelect;

export class MqttDeviceAccounts {
  private readonly db: Db;
  private readonly dataDir: string;
  private readonly reserved: ReadonlySet<string>;
  private readonly log: Logger;
  private readonly applyWaitMs: number;
  private readonly revokeSettleMs: number;
  /** One change at a time: each rewrites the whole list and waits on one answer. */
  private queue: Promise<unknown> = Promise.resolve();
  private settleTimer: NodeJS.Timeout | undefined;

  constructor(options: MqttDeviceAccountsOptions) {
    this.db = options.db;
    this.dataDir = options.dataDir;
    this.reserved = new Set(options.reserved.filter((name) => name.length > 0));
    this.log = options.log;
    this.applyWaitMs = options.applyWaitMs ?? 15_000;
    this.revokeSettleMs = options.revokeSettleMs ?? REVOKE_SETTLE_MS;
    options.events?.on('deviceRemoved', (_deviceId, device) => {
      // Only a device on the MQTT convention is named the way an account is.
      // A Zigbee device's address or a Matter node id is never a username here.
      if (device?.adapter === 'mqtt') this.forgetDevice(device.externalId);
    });
  }

  availability(): MqttDeviceAccountsAvailability {
    return mqttDeviceAccountsAvailability(this.dataDir);
  }

  /** A name a device cannot hold an account under. */
  isReserved(deviceId: string): boolean {
    return this.reserved.has(deviceId);
  }

  async list(): Promise<MqttDeviceAccount[]> {
    const rows = await this.db.query.mqttDeviceAccounts.findMany({
      orderBy: (table) => [asc(table.createdAt), asc(table.deviceId)],
    });
    return rows.map(record);
  }

  async get(deviceId: string): Promise<MqttDeviceAccount | undefined> {
    const row = await this.db.query.mqttDeviceAccounts.findFirst({
      where: eq(mqttDeviceAccounts.deviceId, deviceId),
    });
    return row ? record(row) : undefined;
  }

  /**
   * Give a device its own account, or a new password for the one it has.
   *
   * **Asking again replaces.** A board that is set up a second time is handed
   * a fresh password and the old one stops working, which is the only honest
   * thing to do with a secret this hub never kept: there is nothing to hand
   * back. The broker drops whatever was still connected with the old one.
   *
   * The row is written before the broker is asked, and **taken back when the
   * broker's side says no** — an account the broker never learnt of is a
   * password that can never sign in, and leaving the row would have the next
   * list read claim a device holds one.
   */
  async mint(input: {
    deviceId: string;
    projectKey?: string | undefined;
    member: { id: string; name: string };
  }): Promise<MintMqttAccountOutcome> {
    if (!MQTT_ACCOUNT_ID.test(input.deviceId)) throw new Error('not a device id');
    if (input.projectKey !== undefined && !MQTT_ACCOUNT_ID.test(input.projectKey)) {
      throw new Error('not a project key');
    }
    if (!this.availability().available) return { ok: false, reason: 'unavailable' };
    if (this.isReserved(input.deviceId)) return { ok: false, reason: 'reserved' };

    return this.serial(async () => {
      const password = generatePassword();
      const values = {
        deviceId: input.deviceId,
        passwordHash: brokerPasswordHash(password),
        projectKey: input.projectKey ?? null,
        memberId: input.member.id,
        memberName: input.member.name,
        createdAt: new Date(),
      };
      // The count and the write are one synchronous transaction, with no
      // `await` between them — the `ApiKeyService.create` rule, so requests
      // sent together cannot each find room for one more.
      const written = this.db.transaction((tx) => {
        const previous = tx
          .select()
          .from(mqttDeviceAccounts)
          .where(eq(mqttDeviceAccounts.deviceId, input.deviceId))
          .get();
        if (previous === undefined) {
          const held = tx.select({ n: count() }).from(mqttDeviceAccounts).get();
          if ((held?.n ?? 0) >= MAX_MQTT_DEVICE_ACCOUNTS) return undefined;
        }
        const row = tx
          .insert(mqttDeviceAccounts)
          .values(values)
          .onConflictDoUpdate({ target: mqttDeviceAccounts.deviceId, set: values })
          .returning()
          .get();
        return { row, previous };
      });
      if (written === undefined) return { ok: false, reason: 'limit' } as const;

      // A list that could not even be written is the same outcome as one the
      // root script refused: the broker never learnt of the account.
      let result: MqttAccountsApplyResult | undefined;
      try {
        result = await this.apply(this.applyWaitMs);
      } catch (error) {
        this.log.warn({ err: error, deviceId: input.deviceId }, 'Could not write the list of device accounts');
        result = { id: '', state: 'failed' };
      }
      if (result?.state === 'failed') {
        await this.restore(input.deviceId, written.previous);
        // The list and its request go out together or not at all, so the
        // root script never finds one naming a revision the other lacks.
        await this.apply(0).catch(() => undefined);
        this.log.warn(
          { deviceId: input.deviceId, error: result.error },
          'The broker did not take a device account; it was not kept',
        );
        return {
          ok: false,
          reason: 'failed',
          ...(result.detail !== undefined ? { detail: result.detail } : {}),
        } as const;
      }
      return {
        ok: true,
        account: record(written.row),
        password,
        replaced: written.previous !== undefined,
        replacedOwn: written.previous !== undefined && written.previous.memberId === input.member.id,
        state: result !== undefined ? 'applied' : 'pending',
      } as const;
    });
  }

  /**
   * Take a device's account away, now, and wait for the broker to have done
   * it. False when it had none.
   *
   * For somebody who asks for exactly this — a board that never arrived, or
   * one to cut off without taking it out of the home. Undefined when the
   * device had no account; `pending` means what it does for `mint`: the row is
   * gone and the broker has not confirmed yet.
   */
  async revoke(deviceId: string): Promise<{ state: 'applied' | 'pending' } | undefined> {
    return this.serial(async () => {
      const removed = await this.db
        .delete(mqttDeviceAccounts)
        .where(eq(mqttDeviceAccounts.deviceId, deviceId))
        .returning();
      if (removed.length === 0) return undefined;
      if (!this.availability().available) return { state: 'pending' } as const;
      // The row is gone whatever happens next. A list that could not be
      // written or applied leaves the broker behind the table, which is what
      // `reconcile` exists to notice at the next start.
      const result = await this.apply(this.applyWaitMs).catch((error: unknown) => {
        this.log.warn({ err: error, deviceId }, 'Could not write the list of device accounts');
        return undefined;
      });
      return { state: result?.state === 'applied' ? 'applied' : 'pending' } as const;
    });
  }

  /**
   * A device left the home: its account goes with it.
   *
   * Whoever removed it and however — deleted in an app, or a device that
   * withdrew its own discovery document — the account is the device's, and a
   * device that is not in the home has no business on its broker. **The row
   * goes now and the broker is told a moment later** (`REVOKE_SETTLE_MS`), so
   * a board that is listening hears that it was removed before its connection
   * is dropped. Never throws and never waits: it is called from the registry's
   * own removal, which must not be held up by a broker.
   */
  forgetDevice(deviceId: string): void {
    void this.serial(async () => {
      const removed = await this.db
        .delete(mqttDeviceAccounts)
        .where(eq(mqttDeviceAccounts.deviceId, deviceId))
        .returning();
      if (removed.length === 0) return;
      this.log.info({ deviceId }, 'A removed device’s broker account was revoked');
      this.applySoon();
    }).catch((error: unknown) => {
      this.log.warn({ err: error, deviceId }, 'Could not revoke a removed device’s broker account');
    });
  }

  /**
   * At start: make the broker's list the table's, if it is not already.
   *
   * The two can part while the hub is down or its root half is — a removal
   * whose reload never ran, a restart inside `REVOKE_SETTLE_MS` — and nothing
   * else would ever bring them back together. Asked only when what the table
   * says differs from what was last applied, so an ordinary start writes
   * nothing and does not have the broker re-read anything. The first start
   * after this was installed does ask, with an empty list: the broker's file
   * may hold accounts from a home whose data was since reset, and an answer
   * about an empty list is what says it does not. Never throws.
   */
  async reconcile(): Promise<void> {
    try {
      if (!this.availability().available) return;
      await this.serial(async () => {
        const body = this.listBody(await this.rows());
        const current = this.readList();
        const result = readMqttAccountsResult(this.dataDir);
        const settled =
          current !== undefined &&
          current.body === body &&
          result?.state === 'applied' &&
          result.id === current.revision;
        if (settled) return;
        await this.apply(0);
      });
    } catch (error) {
      this.log.warn({ err: error }, 'Could not reconcile the broker’s device accounts');
    }
  }

  /** Stop the one timer this holds, so a closing hub is not kept open by it. */
  stop(): void {
    if (this.settleTimer !== undefined) clearTimeout(this.settleTimer);
    this.settleTimer = undefined;
  }

  // ── The list, and asking for it to be applied ───────────────────────────

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async rows(): Promise<AccountRow[]> {
    return this.db.query.mqttDeviceAccounts.findMany({
      orderBy: (table) => [asc(table.deviceId)],
    });
  }

  /** Put back what a refused change replaced, or take the new row away. */
  private async restore(deviceId: string, previous: AccountRow | undefined): Promise<void> {
    if (previous === undefined) {
      await this.db.delete(mqttDeviceAccounts).where(eq(mqttDeviceAccounts.deviceId, deviceId));
      return;
    }
    await this.db
      .update(mqttDeviceAccounts)
      .set(previous)
      .where(eq(mqttDeviceAccounts.deviceId, deviceId));
  }

  /**
   * One `account=<id> <project key or -> <hash>` line per device, sorted by id
   * so the same table always renders the same text — which is what lets
   * `reconcile` tell "already applied" from "changed" by comparing.
   */
  private listBody(rows: readonly AccountRow[]): string {
    return rows
      .filter((row) => MQTT_ACCOUNT_ID.test(row.deviceId) && !this.reserved.has(row.deviceId))
      .map((row) => `account=${row.deviceId} ${row.projectKey ?? '-'} ${row.passwordHash}\n`)
      .join('');
  }

  private readList(): { revision: string; body: string } | undefined {
    let raw: string;
    try {
      raw = readFileSync(path.join(accountsDir(this.dataDir), 'accounts'), 'utf8');
    } catch {
      return undefined;
    }
    const newline = raw.indexOf('\n');
    const first = newline < 0 ? raw : raw.slice(0, newline);
    if (!first.startsWith('revision=')) return undefined;
    return { revision: first.slice('revision='.length), body: newline < 0 ? '' : raw.slice(newline + 1) };
  }

  /**
   * Write the list down, whole, under a new revision — and return it.
   *
   * Beside its final name and renamed into place, so the root script never
   * reads half a list: a list with accounts missing is accounts revoked.
   * 0600, the hub's own; the script reads it as the hub's account.
   */
  private writeList(rows: readonly AccountRow[]): string {
    const revision = randomUUID();
    const dir = accountsDir(this.dataDir);
    mkdirSync(dir, { recursive: true });
    const text = `revision=${revision}\n${this.listBody(rows)}`;
    const target = path.join(dir, 'accounts');
    const staging = `${target}.tmp.${process.pid}`;
    writeFileSync(staging, text, { mode: 0o600 });
    renameSync(staging, target);
    return revision;
  }

  /**
   * Write the list and ask for it to be applied; wait up to `waitMs` for the
   * root script's answer about *this* revision.
   *
   * The request is its own small file, written in place as one write, for the
   * reason `requestWifiChange` gives: `PathModified` is guaranteed to notice a
   * single write-and-close, which a rename into the watched name is not. It
   * carries the revision and nothing else — the list is already in place by
   * the time anything reads the request.
   */
  private async apply(waitMs: number): Promise<MqttAccountsApplyResult | undefined> {
    const rows = await this.rows();
    const revision = this.writeList(rows);
    writeFileSync(path.join(accountsDir(this.dataDir), 'request'), `id=${revision}\n`, { mode: 0o600 });
    const deadline = Date.now() + waitMs;
    for (;;) {
      const result = readMqttAccountsResult(this.dataDir);
      if (result?.id === revision) return result;
      const left = deadline - Date.now();
      if (left <= 0) return undefined;
      await new Promise((resolve) => setTimeout(resolve, Math.min(200, left)));
    }
  }

  /** One reload a little later, however many devices were removed meanwhile. */
  private applySoon(): void {
    if (!this.availability().available) return;
    if (this.settleTimer !== undefined) return;
    this.settleTimer = setTimeout(() => {
      this.settleTimer = undefined;
      void this.serial(() => this.apply(0)).catch((error: unknown) => {
        this.log.warn({ err: error }, 'Could not ask for the broker’s device accounts to be applied');
      });
    }, this.revokeSettleMs);
    this.settleTimer.unref();
  }
}

function record(row: AccountRow): MqttDeviceAccount {
  return {
    deviceId: row.deviceId,
    projectKey: row.projectKey,
    memberId: row.memberId,
    memberName: row.memberName,
    createdAt: row.createdAt,
  };
}
