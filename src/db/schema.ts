import { randomUUID } from 'node:crypto';
import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

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

export const rooms = sqliteTable('rooms', {
  id: uuidPk(),
  name: text('name').notNull(),
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
    favorite: integer('favorite', { mode: 'boolean' }).notNull().default(false),
    online: integer('online', { mode: 'boolean' }).notNull().default(true),
    /** Set when automatic (static or AI) mapping was incomplete. */
    needsReview: integer('needs_review', { mode: 'boolean' }).notNull().default(false),
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
    provider: text('provider'),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex('ai_mappings_adapter_hash').on(table.adapter, table.exposesHash)],
);

/**
 * Key-value settings. AI provider keys are stored here encrypted with the
 * hub secret (AES-256-GCM) — never in plaintext, never returned by the API.
 */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
});
