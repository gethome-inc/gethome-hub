import {
  bigserial,
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * One hub hosts exactly one home — sharing means granting members access to
 * this hub. The single `home` row is created at first boot.
 */
export const home = pgTable('home', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const rooms = pgTable('rooms', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Owning protocol adapter: zigbee | mqtt | matter. */
    adapter: text('adapter').notNull(),
    /** Adapter-scoped stable id: IEEE address, MQTT device id, Matter node id. */
    externalId: text('external_id').notNull(),
    vendor: text('vendor'),
    model: text('model'),
    name: text('name').notNull(),
    roomId: uuid('room_id').references(() => rooms.id, { onDelete: 'set null' }),
    favorite: boolean('favorite').notNull().default(false),
    online: boolean('online').notNull().default(true),
    /** Set when automatic (static or AI) mapping was incomplete. */
    needsReview: boolean('needs_review').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('devices_adapter_external_id').on(table.adapter, table.externalId)],
);

export const endpoints = pgTable(
  'endpoints',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    endpointId: integer('endpoint_id').notNull(),
    deviceKind: text('device_kind').notNull(),
    /** CapabilityKind[] as JSON. */
    capabilities: jsonb('capabilities').notNull(),
    primaryCapability: text('primary_capability').notNull(),
    /** Latest canonical EndpointState as JSON — survives restarts. */
    state: jsonb('state').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('endpoints_device_endpoint').on(table.deviceId, table.endpointId)],
);

export const members = pgTable('members', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  /** owner | member */
  role: text('role').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const tokens = pgTable('tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  memberId: uuid('member_id')
    .notNull()
    .references(() => members.id, { onDelete: 'cascade' }),
  /** sha256 hex of the opaque bearer token; the plaintext is never stored. */
  tokenHash: text('token_hash').notNull().unique(),
  deviceName: text('device_name'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
});

export const invites = pgTable('invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** sha256 hex of the 8-digit invite code. */
  codeHash: text('code_hash').notNull(),
  role: text('role').notNull().default('member'),
  createdBy: uuid('created_by').references(() => members.id, { onDelete: 'set null' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedBy: uuid('used_by').references(() => members.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const activity = pgTable('activity', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  memberId: uuid('member_id').references(() => members.id, { onDelete: 'set null' }),
  deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
  kind: text('kind').notNull(),
  message: text('message').notNull(),
  data: jsonb('data'),
});

export const aiMappings = pgTable(
  'ai_mappings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    adapter: text('adapter').notNull(),
    vendor: text('vendor'),
    model: text('model'),
    /** sha256 of the canonicalized exposes/definition JSON — the cache key. */
    exposesHash: text('exposes_hash').notNull(),
    /** MappingDescriptor as JSON. */
    descriptor: jsonb('descriptor').notNull(),
    /** generated | verified | rejected */
    status: text('status').notNull().default('generated'),
    provider: text('provider'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('ai_mappings_adapter_hash').on(table.adapter, table.exposesHash)],
);

/**
 * Key-value settings. AI provider keys are stored here encrypted with the
 * hub secret (AES-256-GCM) — never in plaintext, never returned by the API.
 */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
});
