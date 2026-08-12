import { randomUUID } from 'node:crypto';
import { integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * The hub's store is a single SQLite file (`<data>/hub.db`).
 *
 * It used to be Postgres, which cost a second daemon, a TCP connection pool
 * and — with stock `shared_buffers` — more memory than the hub itself on a
 * 512 MB Raspberry Pi. Nothing here needed a server: one process writes, the
 * reads are small and local, and there is not a transaction in the codebase.
 *
 * Three conventions carry over from the Postgres schema and must stay, because
 * the column names are the wire contract with the GetHome apps:
 *  - ids are uuid *text*, generated in JS (`randomUUID`) rather than by
 *    `gen_random_uuid()`;
 *  - JSON columns are text in `json` mode — drizzle serialises on the way in
 *    and parses on the way out, so callers see the same objects as before;
 *  - timestamps are integer milliseconds in `timestamp_ms` mode, which still
 *    hands JavaScript a `Date`, so `JSON.stringify` still emits ISO-8601.
 */

const uuidPk = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => randomUUID());

const createdAt = (column = 'created_at') =>
  integer(column, { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date());

/**
 * One hub hosts exactly one home — sharing means granting members access to
 * this hub. The single `home` row is created at first boot.
 */
export const home = sqliteTable('home', {
  id: uuidPk(),
  name: text('name').notNull(),
  createdAt: createdAt(),
});

/**
 * The optional layer above rooms: "Upstairs", "Garden", "Guest house".
 *
 * Deliberately a *zone* rather than a floor. A room with no zone is the normal
 * case — a flat has no floors, and a garage isn't one either — where a room
 * with no *floor* reads as missing data somebody should go and fill in. It is
 * also Apple Home's own word (`HMZone`), which matters because the GetHome app
 * mirrors Apple Homes beside hub homes and both have to use one vocabulary.
 */
export const zones = sqliteTable('zones', {
  id: uuidPk(),
  name: text('name').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: createdAt(),
});

export const rooms = sqliteTable('rooms', {
  id: uuidPk(),
  name: text('name').notNull(),
  /**
   * Null is a room that belongs to no zone — the ordinary case, not a gap.
   *
   * **No `onDelete` action, and the route does that work instead.** SQLite
   * cannot attach a referential action to a column added by `ALTER TABLE`, and
   * the usual workaround — rebuild the table — is unsafe here: drizzle runs
   * migrations inside a transaction, `PRAGMA foreign_keys=OFF` is a no-op
   * inside one, and dropping `rooms` with enforcement on fires
   * `devices.room_id`'s own set-null, quietly emptying every room in the home
   * on upgrade. So `DELETE /zones/:id` clears this column first, and the plain
   * foreign key stays as the backstop that refuses if it ever forgets to.
   */
  zoneId: text('zone_id').references(() => zones.id),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: createdAt(),
});

export const devices = sqliteTable(
  'devices',
  {
    id: uuidPk(),
    /** Owning protocol adapter: zigbee | mqtt | matter. */
    adapter: text('adapter').notNull(),
    /** Adapter-scoped stable id: IEEE address, MQTT device id, Matter node id. */
    externalId: text('external_id').notNull(),
    vendor: text('vendor'),
    model: text('model'),
    name: text('name').notNull(),
    roomId: text('room_id').references(() => rooms.id, { onDelete: 'set null' }),
    /**
     * **Legacy, and kept only so a rollback still boots.** A favorite is one
     * person's pin, not a property of the home — see `deviceFavorites` — so
     * nothing reads this column any more. It is maintained as the *union* of
     * everybody's pins, because `install.sh` flips back to the previous release
     * when a new build fails its health check, and by then this migration has
     * already run: a dropped column would meet an older build that selects it
     * on every `GET /devices` and turn a routine rollback into a dead hub.
     * Dropping it belongs to a release nobody would roll back across.
     */
    favorite: integer('favorite', { mode: 'boolean' }).notNull().default(false),
    online: integer('online', { mode: 'boolean' }).notNull().default(true),
    /** Set when automatic (static or AI) mapping was incomplete. */
    needsReview: integer('needs_review', { mode: 'boolean' }).notNull().default(false),
    /**
     * How this device came to be understood — `DeviceRecognition` as JSON.
     *
     * `needsReview` is the *verdict* and was the only thing recorded, so the
     * apps could say "something is missing" and never which layer had placed
     * the device or which properties were left over. Kept on the row rather
     * than asked of the adapter, so it survives a restart and costs no
     * round-trip on `GET /devices`.
     */
    recognition: text('recognition', { mode: 'json' }),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex('devices_adapter_external_id').on(table.adapter, table.externalId)],
);

export const endpoints = sqliteTable(
  'endpoints',
  {
    id: uuidPk(),
    deviceId: text('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    endpointId: integer('endpoint_id').notNull(),
    deviceKind: text('device_kind').notNull(),
    /** CapabilityKind[] as JSON. */
    capabilities: text('capabilities', { mode: 'json' }).notNull(),
    primaryCapability: text('primary_capability').notNull(),
    /** Latest canonical EndpointState as JSON — survives restarts. */
    state: text('state', { mode: 'json' }).notNull(),
    updatedAt: createdAt('updated_at'),
  },
  (table) => [uniqueIndex('endpoints_device_endpoint').on(table.deviceId, table.endpointId)],
);

/**
 * Who has pinned what — one row per (device, member).
 *
 * Favorites used to be a boolean on the device row, which made them a property
 * of the *home*: one person pinning the kettle put it on the dashboard of
 * everybody who lived there, and unpinning it took it off theirs. Names and
 * rooms are shared because they describe the house; a favorite describes a
 * person, so it is keyed by member and travels with them. Both foreign keys
 * cascade, so a removed device or a departing member takes their pins with
 * them (`foreign_keys = ON`, see `db/client.ts`).
 */
export const deviceFavorites = sqliteTable(
  'device_favorites',
  {
    deviceId: text('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex('device_favorites_device_member').on(table.deviceId, table.memberId)],
);

export const members = sqliteTable('members', {
  id: uuidPk(),
  name: text('name').notNull(),
  /** owner | member */
  role: text('role').notNull(),
  createdAt: createdAt(),
});

export const tokens = sqliteTable('tokens', {
  id: uuidPk(),
  memberId: text('member_id')
    .notNull()
    .references(() => members.id, { onDelete: 'cascade' }),
  /** sha256 hex of the opaque bearer token; the plaintext is never stored. */
  tokenHash: text('token_hash').notNull().unique(),
  deviceName: text('device_name'),
  createdAt: createdAt(),
  lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
});

export const invites = sqliteTable('invites', {
  id: uuidPk(),
  /** sha256 hex of the 8-digit invite code. */
  codeHash: text('code_hash').notNull(),
  role: text('role').notNull().default('member'),
  createdBy: text('created_by').references(() => members.id, { onDelete: 'set null' }),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  usedBy: text('used_by').references(() => members.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
});

export const activity = sqliteTable('activity', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  at: createdAt('at'),
  memberId: text('member_id').references(() => members.id, { onDelete: 'set null' }),
  deviceId: text('device_id').references(() => devices.id, { onDelete: 'set null' }),
  kind: text('kind').notNull(),
  message: text('message').notNull(),
  data: text('data', { mode: 'json' }),
});

export const aiMappings = sqliteTable(
  'ai_mappings',
  {
    id: uuidPk(),
    adapter: text('adapter').notNull(),
    vendor: text('vendor'),
    model: text('model'),
    /** sha256 of the canonicalized exposes/definition JSON — the cache key. */
    exposesHash: text('exposes_hash').notNull(),
    /** MappingDescriptor as JSON. */
    descriptor: text('descriptor', { mode: 'json' }).notNull(),
    /** generated | verified | rejected */
    status: text('status').notNull().default('generated'),
    /**
     * Where the descriptor came from: `ai` (the mapping agent) or `imported`
     * (a file somebody uploaded). Separate from `status`, which says whether
     * it is *usable* — an imported descriptor can be rejected and an
     * AI-generated one can be perfect, and the apps need to say which is which
     * when they offer to have the agent repair it.
     */
    source: text('source').notNull().default('ai'),
    /** Why a rejected descriptor was rejected — `string[]` as JSON. Kept so a
     *  failed import can be explained, and handed to the agent to repair. */
    problems: text('problems', { mode: 'json' }),
    provider: text('provider'),
    createdAt: createdAt(),
    /**
     * Nullable, and it has to be: SQLite cannot `ADD COLUMN … NOT NULL`
     * without a SQL-level default, and drizzle's `$defaultFn` runs in JS. Null
     * on a row written before this column existed, which reads correctly as
     * "never touched since" — callers fall back to `createdAt`.
     */
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }),
  },
  (table) => [uniqueIndex('ai_mappings_adapter_hash').on(table.adapter, table.exposesHash)],
);

/**
 * What the mapping agent did, one row per run.
 *
 * A *summary*, never a transcript: the searches it made, the pages it read,
 * what it submitted and why that was refused. Enough for an owner to see where
 * their money went and why a device is or isn't understood, without storing
 * model prose on an SD card. Pruned to `RETAIN_RUNS` — see `core/ai-runs.ts`.
 */
export const aiRuns = sqliteTable('ai_runs', {
  id: uuidPk(),
  at: createdAt('at'),
  /** map | repair */
  kind: text('kind').notNull(),
  adapter: text('adapter').notNull(),
  vendor: text('vendor'),
  model: text('model'),
  exposesHash: text('exposes_hash').notNull(),
  /** Which Claude model ran it. */
  modelId: text('model_id'),
  /** Whether the run produced a mapping the hub accepted. */
  ok: integer('ok', { mode: 'boolean' }).notNull().default(false),
  costUsd: real('cost_usd'),
  turns: integer('turns'),
  durationMs: integer('duration_ms'),
  errorKind: text('error_kind'),
  errorMessage: text('error_message'),
  /** `AgentStep[]` as JSON. */
  steps: text('steps', { mode: 'json' }).notNull(),
});

/**
 * Key-value settings. AI provider keys are stored here encrypted with the
 * hub secret (AES-256-GCM) — never in plaintext, never returned by the API.
 */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
});
