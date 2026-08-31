import { randomUUID } from 'node:crypto';
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

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
  /**
   * How the apps draw this room: a glyph token and a palette token.
   *
   * Both are the *house's*, exactly like the room's name — everybody who opens
   * the home sees the same kitchen, in the same colour — which is the whole
   * reason they are here rather than in each phone's own storage.
   *
   * **Null means "you decide", and that is the ordinary state.** The apps
   * derive a glyph from the name (a room called Garage draws a car) and hand
   * out colours in turn, so a room nobody has styled has no rows to write and
   * keeps whatever the app would have chosen anyway. A value here is somebody
   * having overruled that, and it wins from then on.
   *
   * The hub deliberately does **not** validate the vocabulary. Which glyphs
   * exist and what "sky" looks like belong to the apps; an allowlist here
   * would mean a hub upgrade every time one of them adds a colour, and the
   * cost of a token an app doesn't know is that it falls back to the derived
   * look — which is where the room started.
   */
  icon: text('icon'),
  accent: text('accent'),
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

/**
 * A named set of permissions — what a role is allowed to do in this home.
 *
 * Roles are the *house's*, exactly like room names: everybody who opens the
 * home sees the same Guest, so they are rows here rather than a preference on
 * anybody's phone. Three ship built in (`owner`, `member`, `guest`) and the
 * home can add its own.
 *
 * **`permissions` is a JSON array rather than a join table**, for the reason
 * `endpoints.capabilities` is one: a home has a handful of roles and the
 * catalog is a dozen keys, the set is only ever read whole, and this runs on
 * an SD card where a join per authenticated request is a cost with nothing to
 * show for it. `core/access.ts` holds the whole table in memory anyway.
 *
 * **The owner's row is never consulted.** `AccessService.can` answers `true`
 * for the owner without reading `permissions`, which is what makes a hub
 * impossible to lock out of and what gives a future permission to the owner
 * automatically. The row exists so an app can draw the word "Owner"; editing
 * or deleting it is refused.
 */
export const roles = sqliteTable('roles', {
  id: uuidPk(),
  /**
   * The stable handle: `owner`, `member`, `guest`, or a minted one for a role
   * somebody in the home created. Names are renameable and translated; this
   * is what code compares against, and only ever for the three built-ins.
   */
  key: text('key').notNull().unique(),
  name: text('name').notNull(),
  /** Built-in roles cannot be deleted, and `owner` cannot be edited either. */
  builtin: integer('builtin', { mode: 'boolean' }).notNull().default(false),
  /**
   * `PermissionKey[]` as JSON.
   *
   * A key this build has never heard of is **ignored on read** — a role row
   * written by a newer build, met after `install.sh` rolled back to this one,
   * must not make `can()` throw or the role unreadable, and a permission this
   * build cannot enforce is one it must not claim to. The row keeps it, so
   * rolling forward restores it.
   *
   * It *is* dropped on write, and that asymmetry is the safer half of a real
   * trade: keeping unknown keys through an edit would mean a home that
   * revoked something on the older build finds it granted again the moment the
   * newer one comes back, with the matrix having said otherwise the whole
   * time. Losing a grant is visible and one tap to redo; a revoke that quietly
   * did not happen is neither.
   */
  permissions: text('permissions', { mode: 'json' }).notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: createdAt(),
});

export const members = sqliteTable('members', {
  id: uuidPk(),
  name: text('name').notNull(),
  /**
   * **Legacy, and kept for the same reason `devices.favorite` is.** The role
   * is `roleId` now; this column is maintained as `'owner'` for the owner and
   * `'member'` for everybody else. `install.sh` rolls back to the previous
   * release when a build fails its health check — by which time this migration
   * has run — and that build reads this column on *every authenticated
   * request*. Dropping it would turn a routine rollback into a hub where
   * nobody can sign in.
   *
   * An older build therefore reads a guest as a member, which is more
   * permissive than the home asked for and lasts only as long as the failed
   * update. That is the honest trade: the alternative is a dead hub.
   */
  role: text('role').notNull(),
  /**
   * Which role this member holds.
   *
   * **Nullable, and with no `onDelete` action — both are forced.** SQLite
   * cannot `ADD COLUMN … NOT NULL` without a SQL-level default (drizzle's
   * `$defaultFn` runs in JS), and it cannot attach a referential action to a
   * column added by `ALTER TABLE` at all — the same pair of constraints that
   * shaped `rooms.zone_id`. So `DELETE /roles/:id` does that work by refusing
   * while a role still has members, and the plain foreign key is the backstop
   * that refuses if it ever forgets to. A null here resolves through `role`
   * above, which is what a row written by an older build looks like.
   */
  roleId: text('role_id').references(() => roles.id),
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
  /** Legacy mirror of `roleId`, kept for rollback — see `members.role`. */
  role: text('role').notNull().default('member'),
  /** Which role the person claiming this code joins as. Null = `member`. */
  roleId: text('role_id').references(() => roles.id),
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

/**
 * One recorded quantity: this device's temperature, that plug's power.
 *
 * A dictionary rather than three columns repeated on every sample — the whole
 * point of the split. A week of one series is 2 016 rows; carrying the uuid,
 * the endpoint and the word "temperature" on each of them would be more bytes
 * of *identity* than of readings, on a machine whose disk is an SD card.
 *
 * `id` is an autoincrement integer for the same reason: it is the first half
 * of every `history` row's key, and a uuid there would cost 36 bytes per
 * sample where a varint costs one or two.
 *
 * The cascade is real here, unlike `rooms.zone_id` — these are new
 * `CREATE TABLE`s rather than columns bolted on with `ALTER TABLE`, so SQLite
 * accepts a referential action and a removed device takes its history with it.
 */
export const historySeries = sqliteTable(
  'history_series',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    deviceId: text('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    endpointId: integer('endpoint_id').notNull(),
    /** `HistoryKind` — `temperature`, `humidity`, `power`… see `core/history.ts`. */
    kind: text('kind').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('history_series_device_endpoint_kind').on(
      table.deviceId,
      table.endpointId,
      table.kind,
    ),
  ],
);

/**
 * What a series did, five minutes at a time.
 *
 * **One row per bucket, never one per report.** This is the `STATE_FLUSH_MS`
 * rule from `core/registry.ts` carried into storage: a power meter reports
 * every few seconds, forever, and a table that took a row each time would put
 * tens of thousands of writes a day onto a card for one device. Readings are
 * accumulated in memory (`core/history.ts`) and one bucket lands as one row.
 *
 * `min`/`max` are what the chart's band is drawn from and `sum`/`n` are what
 * its line is: the average is computed on read rather than stored, because a
 * *stored* average cannot be merged — and merging is exactly what the write
 * has to do when a hub restarts inside a bucket it had already half written.
 *
 * Values are **integers in the canonical wire units** (centi-°C, centi-%, mW,
 * ppm, %), so a sample costs a varint or two and no conversion happens between
 * here and the app. The two quantities the wire carries as floats get an
 * explicit scale, documented with `HISTORY_KINDS`.
 *
 * The migration declares this `WITHOUT ROWID`, which drizzle has no way to
 * express: the table then *is* its own index on `(series_id, bucket)` — no
 * rowid, no second b-tree to keep, and a chart's week of one series is one
 * contiguous range scan. Roughly 20 bytes a row all in.
 */
export const history = sqliteTable(
  'history',
  {
    seriesId: integer('series_id')
      .notNull()
      .references(() => historySeries.id, { onDelete: 'cascade' }),
    /** `floor(epochMs / BUCKET_MS)` — see `core/history.ts`. */
    bucket: integer('bucket').notNull(),
    min: integer('min').notNull(),
    max: integer('max').notNull(),
    /** Running total and count, so buckets merge and the average is exact. */
    sum: integer('sum').notNull(),
    n: integer('n').notNull(),
  },
  (table) => [primaryKey({ columns: [table.seriesId, table.bucket] })],
);

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
  /** Which model ran it — `claude-…` or `gpt-…`, depending on the provider. */
  modelId: text('model_id'),
  /** anthropic | openai. Absent on rows written before the second provider. */
  provider: text('provider'),
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
 * What was actually said to a provider, round by round, for the runs somebody
 * asked to have recorded.
 *
 * `ai_runs` is a **summary** — searches, pages, submissions — and that is what
 * every run writes, forever, because model prose on an SD card is the write
 * amplification the rest of this store is arranged to avoid. This table is the
 * exception, and three things keep it affordable. It is written **only while
 * `ai_record_exchanges` is on**, so a hub nobody is debugging holds nothing.
 * It holds the round's **main data** rather than its bodies — a labelled,
 * excerpted part per thing sent or received, never the request as it went out,
 * which for a 40-turn loop would mean writing the same 9.9 KB system prompt
 * forty times. And it is bounded at **both ends**, seven days and a row cap,
 * whichever bites first — the two-bounds rule the activity log and the reading
 * history both follow.
 *
 * `run_id` cascades: this table was created with the foreign key rather than
 * gaining it by `ALTER TABLE`, so SQLite will accept the action and a pruned
 * run takes its rounds with it. See `core/ai-runs.ts`.
 */
export const aiRunExchanges = sqliteTable('ai_run_exchanges', {
  id: uuidPk(),
  runId: text('run_id')
    .notNull()
    .references(() => aiRuns.id, { onDelete: 'cascade' }),
  /** 1-based, in the order the rounds happened. */
  seq: integer('seq').notNull(),
  at: createdAt('at'),
  durationMs: integer('duration_ms'),
  /** anthropic | openai, and the model of theirs that answered — recorded per
   *  round rather than per run, because a run can be retried against another. */
  provider: text('provider').notNull(),
  modelId: text('model_id').notNull(),
  status: integer('status'),
  ok: integer('ok', { mode: 'boolean' }).notNull().default(false),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  /** `ExchangePart[]` as JSON — what this turn added to the request. */
  sent: text('sent', { mode: 'json' }).notNull(),
  /** `ExchangePart[]` as JSON — what came back, or the refusal. */
  received: text('received', { mode: 'json' }).notNull(),
}, (table) => ({
  // Every read of this table is "the rounds of one run", and every prune is
  // "the rounds of runs that are gone" — both a prefix of this key.
  byRun: index('ai_run_exchanges_run_idx').on(table.runId, table.seq),
}));

/**
 * A device's AI-drawn portraits — the picture the apps float on its page.
 *
 * A portrait is the *house's*, exactly like a room's icon: everybody in the
 * home should see the same kettle, so it is a row here rather than a file on
 * whoever generated it. The image itself is **not** in this table — a 1024²
 * transparent PNG is a megabyte or two, and putting that through the WAL on
 * every checkpoint is the write amplification the whole store is arranged to
 * avoid. The bytes live at `<data>/portraits/<device>/<id>.png`; this row is
 * the record of them, and the file is deleted with it.
 *
 * `selected` is which one the apps draw. **No row selected while portraits
 * exist is a state, not an absence**: it means somebody chose the procedural
 * sphere over every picture they have, which is a per-home preference the apps
 * already had and would otherwise need a column of its own to express.
 */
export const devicePortraits = sqliteTable(
  'device_portraits',
  {
    id: uuidPk(),
    deviceId: text('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    at: createdAt('at'),
    /** Size of the stored PNG, so the hub can bound its own disk without stat-ing every file. */
    bytes: integer('bytes').notNull(),
    /** Who drew it and with what — recorded because both will change. */
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    /** Whether a photo was the reference, which is the difference a person can see. */
    fromPhoto: integer('from_photo', { mode: 'boolean' }).notNull().default(false),
    selected: integer('selected', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => [index('device_portraits_device').on(table.deviceId)],
);

/**
 * Key-value settings. AI provider keys are stored here encrypted with the
 * hub secret (AES-256-GCM) — never in plaintext, never returned by the API.
 */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
});

/**
 * A rule the home runs by itself — and, with a `manual` trigger, the thing
 * the apps draw as a scene. There is deliberately no separate scenes table:
 * "press this and the house does that" is this object with one trigger kind,
 * and a second store would be a second vocabulary to keep in step.
 *
 * `document` is the whole `AutomationDocument` as JSON, validated by
 * `src/automations/schema.ts` on the way in and interpreted — never executed —
 * on the way out. `src/automations/` is canonical.
 */
export const automations = sqliteTable(
  'automations',
  {
    id: uuidPk(),
    name: text('name').notNull(),
    /**
     * Whether the rule exists and is listening. Changing this is an edit and
     * needs `automation.manage`.
     */
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    /**
     * Whether a *manual toggle* is currently switched on — "Security is on".
     * Deliberately a different column from `enabled` and a different
     * permission: switching a mode on is working the home, which is the
     * floor, while enabling a rule is editing it.
     */
    active: integer('active', { mode: 'boolean' }).notNull().default(false),
    /**
     * Why the hub switched this off by itself — today, only the runaway
     * circuit breaker in `src/automations/guards.ts`. Null when a person did
     * it, so an app can tell "I turned this off" from "the hub stopped it and
     * here is the sentence".
     */
    disabledReason: text('disabled_reason'),
    /** `AutomationDocument` as JSON. */
    document: text('document', { mode: 'json' }).notNull(),
    /**
     * Who wrote it. `ON DELETE SET NULL` like every other member reference
     * here: a rule outlives the person who added it, and the home keeps
     * running it.
     */
    createdBy: text('created_by').references(() => members.id, { onDelete: 'set null' }),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: createdAt('updated_at'),
  },
  (table) => [index('automations_enabled').on(table.enabled)],
);

/**
 * What a rule said before the last edit.
 *
 * An agent rewrites a document and the home behaves oddly at three in the
 * morning; without this the only way back is remembering what it used to say.
 * A document is a couple of kilobytes of JSON, so a handful of versions per
 * rule is nothing beside one portrait — this is a bound on *bulk*, like
 * `device_portraits`, not on write frequency.
 */
export const automationVersions = sqliteTable(
  'automation_versions',
  {
    id: uuidPk(),
    automationId: text('automation_id')
      .notNull()
      .references(() => automations.id, { onDelete: 'cascade' }),
    at: createdAt('at'),
    document: text('document', { mode: 'json' }).notNull(),
    /** Who made the edit this version replaced. */
    memberId: text('member_id').references(() => members.id, { onDelete: 'set null' }),
    /** One line: "created", "edited in chat", "reverted to an earlier version". */
    note: text('note'),
  },
  (table) => [index('automation_versions_automation').on(table.automationId, table.at)],
);

/**
 * One firing, and what happened in it — the answer to "why did the light come
 * on at three in the morning".
 *
 * **A row per firing, never a row per state report**, which is the line
 * `device.command` and the reading history both hold. A rule that fires twice
 * a day writes two rows; a rule that fires every few seconds is one the
 * circuit breaker switches off, so this table cannot become the SD card
 * problem by itself.
 *
 * `steps` carries what was evaluated and what was sent — including the
 * commands a guard refused, which is the half that would otherwise be
 * invisible: "nothing happened" and "the hub declined to switch that relay for
 * the fortieth time this hour" look identical from outside.
 */
export const automationRuns = sqliteTable(
  'automation_runs',
  {
    id: uuidPk(),
    automationId: text('automation_id')
      .notNull()
      .references(() => automations.id, { onDelete: 'cascade' }),
    at: createdAt('at'),
    /** manual | deviceState | deviceEvent | schedule | interval | action */
    trigger: text('trigger').notNull(),
    /** One sentence naming what set it off. */
    cause: text('cause').notNull(),
    /** ran | skipped | refused | failed | interrupted */
    outcome: text('outcome').notNull(),
    durationMs: integer('duration_ms'),
    /** `AutomationRunStep[]` as JSON — bounded when it is written. */
    steps: text('steps', { mode: 'json' }).notNull(),
  },
  (table) => [index('automation_runs_automation').on(table.automationId, table.at)],
);
