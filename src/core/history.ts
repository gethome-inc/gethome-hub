import { and, eq, gte, inArray, lt, lte, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { history, historySeries } from '../db/schema.js';
import type { EndpointState } from '../schema/index.js';
import type { HubEventBus } from './bus.js';
import type { Logger } from '../logging.js';

/**
 * What the home's readings did over the last few days.
 *
 * The hub already knew what the temperature is; it had no way to say what it
 * *was*. `endpoints.state` is one row holding the current value, rewritten in
 * place, and the activity log deliberately records only what somebody asked
 * for — "a power meter reports every few seconds, forever, onto an SD card" is
 * the reason it does, and it is the same reason this file exists rather than a
 * table with a row per report.
 *
 * **Everything here follows from that one constraint.** Readings are
 * accumulated in memory and land as *one row per five minutes per quantity*,
 * which is the `STATE_FLUSH_MS` idea from `core/registry.ts` applied to
 * storage: an ordinary home writes ~288 batched transactions a day, against
 * the tens of thousands of whole-row rewrites a single chatty power meter
 * already costs. A week of that home is one to two megabytes.
 *
 * Four things are load-bearing and easy to undo by accident:
 *
 * 1. **Nothing touches the disk on the report path.** `observe` is a handful
 *    of field reads and a `Math.min`; the write happens when a bucket closes.
 * 2. **A bucket merges rather than replaces.** The upsert takes `min(…)`,
 *    `max(…)` and adds `sum`/`n`, so a hub restarting inside a bucket it had
 *    already half-written combines the two halves — and a clock that jumps
 *    backwards after NTP finally answers (a Pi has no RTC) cannot corrupt a row.
 *    Storing an average instead of `sum`/`n` would make that impossible, which
 *    is why it is computed on read.
 * 3. **A gap is an absence, not a zero.** A device that is offline reports
 *    nothing, so no sample exists, so the reader emits no point at that offset
 *    — and the apps draw a hole. Inventing a value there would be the hub
 *    claiming to know something it doesn't.
 * 4. **Two bounds, like the activity log.** Age (a week) and the number of
 *    recorded quantities (500). The age bound is also the row cap per series
 *    (2 016), so the only axis that could otherwise grow without limit is how
 *    many quantities a home has.
 */

/** How long readings coalesce before one row is written. */
export const BUCKET_MS = 5 * 60 * 1000;

/** How far back the hub keeps them. */
const RETAIN_DAYS = 7;
const RETAIN_MS = RETAIN_DAYS * 24 * 60 * 60 * 1000;

/**
 * How many distinct quantities this hub will record.
 *
 * The age bound already caps the rows *per* series at 2 016, so this is the
 * one axis left. 500 is far past a large home (a hundred devices with three
 * readings each is 300) and exists so that a misbehaving adapter — or a future
 * decision to record `custom` fields — cannot quietly turn a bounded table
 * into an unbounded one.
 */
const MAX_SERIES = 500;

const PRUNE_EVERY_MS = 60 * 60 * 1000;

/** Default and ceiling for how many points one series is drawn from. */
const DEFAULT_POINTS = 360;
const MAX_POINTS = 1_000;

/**
 * How long a hole has to be before it stops being a lull.
 *
 * `gapBuckets` is derived per series from its own observed cadence (see
 * `read`), so a sensor that reports twice an hour is not drawn as permanently
 * broken. This caps that derivation in *time* rather than in points, so the
 * rule means the same thing at every zoom level.
 */
const MAX_GAP_MS = 2 * 60 * 60 * 1000;

/**
 * The quantities the hub records, and the integer unit each is stored in.
 *
 * **The units are the wire's**, exactly (`docs/device-schema.md`): centi-°C,
 * centi-%, milliwatts, ppm, whole percent. Nothing is converted between the
 * device report and the chart. The three quantities the wire carries as a
 * float get an explicit scale here instead, because a `REAL` column would cost
 * eight bytes a value on a machine where a varint costs one or two — and the
 * resolution given up (a whole lux, a tenth of a hPa, a tenth of a µg/m³) is
 * far below anything a chart can show.
 *
 * Booleans are deliberately absent. "When was the light on" wants transitions
 * rather than buckets and a step chart rather than a line, which is a
 * different table and a different control — a later change, not a widening of
 * this one.
 */
const KINDS = [
  {
    kind: 'temperature',
    unit: 'centiCelsius',
    read: (state: EndpointState) => state.sensors.temperatureCenti,
  },
  {
    kind: 'humidity',
    unit: 'centiPercent',
    read: (state: EndpointState) => state.sensors.humidityCenti,
  },
  {
    kind: 'illuminance',
    unit: 'lux',
    read: (state: EndpointState) => state.sensors.illuminanceLux,
  },
  {
    kind: 'pressure',
    unit: 'deciHectopascal',
    read: (state: EndpointState) =>
      state.sensors.pressureHPa === undefined ? undefined : state.sensors.pressureHPa * 10,
  },
  { kind: 'co2', unit: 'ppm', read: (state: EndpointState) => state.sensors.co2ppm },
  {
    kind: 'pm25',
    unit: 'deciMicrogramsPerCubicMetre',
    read: (state: EndpointState) =>
      state.sensors.pm25 === undefined ? undefined : state.sensors.pm25 * 10,
  },
  {
    kind: 'flow',
    unit: 'milliCubicMetresPerHour',
    read: (state: EndpointState) =>
      state.sensors.flowCubicMetersPerHour === undefined
        ? undefined
        : state.sensors.flowCubicMetersPerHour * 1_000,
  },
  { kind: 'power', unit: 'milliwatt', read: (state: EndpointState) => state.power?.activeMilliwatts },
  { kind: 'battery', unit: 'percent', read: (state: EndpointState) => state.battery?.percent },
  {
    kind: 'thermostatTemperature',
    unit: 'centiCelsius',
    read: (state: EndpointState) => state.thermostat?.localTemperatureCenti,
  },
] as const satisfies ReadonlyArray<{
  kind: string;
  unit: string;
  read: (state: EndpointState) => number | undefined;
}>;

export type HistoryKind = (typeof KINDS)[number]['kind'];

/** The vocabulary, for the docs and for validating a `series=` filter. */
export const HISTORY_KINDS: readonly HistoryKind[] = KINDS.map((entry) => entry.kind);

export function isHistoryKind(value: unknown): value is HistoryKind {
  return typeof value === 'string' && (HISTORY_KINDS as readonly string[]).includes(value);
}

/** One point: an offset into the returned grid, then min, max and mean. */
export type HistoryPoint = [offset: number, min: number, max: number, avg: number];

export interface HistorySeriesPage {
  kind: HistoryKind;
  unit: string;
  /**
   * A run of this many empty offsets is a hole rather than a quiet stretch —
   * the app breaks its line there instead of drawing through it.
   */
  gapBuckets: number;
  points: HistoryPoint[];
}

export interface HistoryPage {
  /** Epoch ms of offset 0, and the width of one offset. */
  start: number;
  bucketMs: number;
  /** Epoch ms the window ends at. */
  end: number;
  retentionDays: number;
  series: HistorySeriesPage[];
}

/** One quantity's readings inside the bucket currently being filled. */
interface Accumulator {
  seriesKey: string;
  deviceId: string;
  endpointId: number;
  kind: HistoryKind;
  bucket: number;
  min: number;
  max: number;
  sum: number;
  n: number;
}

function seriesKey(deviceId: string, endpointId: number, kind: HistoryKind): string {
  return `${deviceId}:${endpointId}:${kind}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export class HistoryService {
  /** `deviceId:endpointId:kind` → the row id in `history_series`. */
  private readonly seriesIds = new Map<string, number>();
  /** The bucket each quantity is currently filling. */
  private readonly open = new Map<string, Accumulator>();
  /** Buckets that have closed and are waiting to be written. */
  private pending: Accumulator[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastPruneAt = 0;
  private warnedAboutCap = false;

  constructor(
    private readonly db: Db,
    private readonly events: HubEventBus,
    private readonly log: Logger,
  ) {
    // A device can leave without this service being asked — a Zigbee device
    // dropped from the network reaches the registry, not the API. The rows go
    // with the cascade; this keeps the map from holding a series id that the
    // database has already deleted, which the next flush would insert against.
    this.events.on('deviceRemoved', (deviceId) => this.forgetDevice(deviceId));
  }

  /** Read the known series into memory and start listening. */
  async start(): Promise<void> {
    const rows = await this.db.query.historySeries.findMany();
    for (const row of rows) {
      if (!isHistoryKind(row.kind)) continue;
      this.seriesIds.set(seriesKey(row.deviceId, row.endpointId, row.kind), row.id);
    }
    this.log.info(`History is recording ${this.seriesIds.size} quantit(ies), ${RETAIN_DAYS} days deep.`);

    this.events.on('stateChanged', (deviceId, endpointId, state) => {
      this.observe(deviceId, endpointId, state);
    });

    // One wakeup per bucket, and it must never be the reason a quiet hub stays
    // alive — the same `unref` the registry's flush timer carries. Precision
    // does not matter: `read` merges whatever is still in memory, so a bucket
    // that lingers a few minutes past its close is still on the chart.
    this.timer = setInterval(() => {
      void this.flush();
    }, BUCKET_MS);
    this.timer.unref?.();
  }

  /** Write the bucket that was still being filled, and stop. */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Everything, including the bucket still being filled — this is its one
    // chance, and half a bucket is worth more than none of it. The upsert
    // merges it with the other half when the hub comes back inside it.
    this.closeDue(Number.POSITIVE_INFINITY);
    await this.flush();
  }

  /** What `GET /hub` advertises, so an app never infers this from a version. */
  describe(): { bucketSeconds: number; retentionDays: number } {
    return { bucketSeconds: BUCKET_MS / 1000, retentionDays: RETAIN_DAYS };
  }

  // ── Recording ─────────────────────────────────────────────────────────────

  /**
   * Fold one state report into the open buckets.
   *
   * The report carries the endpoint's *merged* state, not just the fields that
   * arrived — so a series records what the hub believed at that moment rather
   * than only what the device just said. For "what was the temperature in this
   * room" that is the right reading, and it costs nothing: several samples of
   * the same value inside one bucket are still one row. A device that is
   * offline sends nothing at all, so its silence stays a real hole.
   */
  private observe(deviceId: string, endpointId: number, state: EndpointState): void {
    try {
      const now = Date.now();
      const bucket = Math.floor(now / BUCKET_MS);
      for (const spec of KINDS) {
        const raw = spec.read(state);
        if (raw === undefined || !Number.isFinite(raw)) continue;
        const value = Math.round(raw);
        const key = seriesKey(deviceId, endpointId, spec.kind);
        const current = this.open.get(key);
        if (current && current.bucket === bucket) {
          if (value < current.min) current.min = value;
          if (value > current.max) current.max = value;
          current.sum += value;
          current.n += 1;
          continue;
        }
        if (current) this.pending.push(current);
        this.open.set(key, {
          seriesKey: key,
          deviceId,
          endpointId,
          kind: spec.kind,
          bucket,
          min: value,
          max: value,
          sum: value,
          n: 1,
        });
      }
    } catch (error) {
      // A state report must never fail because the hub could not remember it.
      this.log.error({ err: error }, 'Recording history for a state report failed');
    }
  }

  /** Move every bucket older than the current one into the write queue. */
  private closeDue(nowBucket = Math.floor(Date.now() / BUCKET_MS)): void {
    for (const [key, accumulator] of this.open) {
      if (accumulator.bucket >= nowBucket) continue;
      this.pending.push(accumulator);
      this.open.delete(key);
    }
  }

  /**
   * Write the closed buckets, then prune if it is due.
   *
   * One statement per chunk, which SQLite runs as one transaction: a home with
   * thirty recorded quantities is a single insert of thirty rows, 288 times a
   * day. Failures put the rows back rather than dropping them — the next flush
   * is five minutes away and the alternative is losing readings to a busy
   * database.
   */
  async flush(): Promise<void> {
    // Closing is part of "write what is ready", not a separate step a caller
    // has to remember — a `flush()` that left a finished bucket in memory was
    // one wrong call away from readings that never reached the disk.
    this.closeDue();
    if (this.pending.length === 0) {
      await this.pruneIfDue();
      return;
    }
    const writing = this.pending;
    this.pending = [];

    const rows: Array<{ seriesId: number; bucket: number; min: number; max: number; sum: number; n: number }> = [];
    for (const accumulator of writing) {
      const seriesId = await this.resolveSeries(accumulator);
      if (seriesId === undefined) continue;
      rows.push({
        seriesId,
        bucket: accumulator.bucket,
        min: accumulator.min,
        max: accumulator.max,
        sum: accumulator.sum,
        n: accumulator.n,
      });
    }

    // Chunked so one statement never approaches SQLite's bound-parameter
    // ceiling, however many quantities a home turns out to have.
    for (let index = 0; index < rows.length; index += 200) {
      const chunk = rows.slice(index, index + 200);
      try {
        await this.db
          .insert(history)
          .values(chunk)
          .onConflictDoUpdate({
            target: [history.seriesId, history.bucket],
            // Merge, never replace — see the note at the top of this file.
            set: {
              min: sql`min(${history.min}, excluded."min")`,
              max: sql`max(${history.max}, excluded."max")`,
              sum: sql`${history.sum} + excluded."sum"`,
              n: sql`${history.n} + excluded."n"`,
            },
          });
      } catch (error) {
        this.log.error({ err: error }, 'Writing history failed');
      }
    }
    await this.pruneIfDue();
  }

  /**
   * The row id for one quantity, minting it the first time it is seen.
   *
   * Returns `undefined` once the hub is at its series cap, which is a refusal
   * to record a *new* quantity rather than a failure — everything already
   * being recorded carries on.
   */
  private async resolveSeries(accumulator: Accumulator): Promise<number | undefined> {
    const known = this.seriesIds.get(accumulator.seriesKey);
    if (known !== undefined) return known;
    if (this.seriesIds.size >= MAX_SERIES) {
      if (!this.warnedAboutCap) {
        this.warnedAboutCap = true;
        this.log.warn(
          `History is already recording ${MAX_SERIES} quantities — new ones are not being added.`,
        );
      }
      return undefined;
    }
    try {
      const [row] = await this.db
        .insert(historySeries)
        .values({
          deviceId: accumulator.deviceId,
          endpointId: accumulator.endpointId,
          kind: accumulator.kind,
        })
        .onConflictDoNothing()
        .returning();
      const id =
        row?.id ??
        (
          await this.db.query.historySeries.findFirst({
            where: and(
              eq(historySeries.deviceId, accumulator.deviceId),
              eq(historySeries.endpointId, accumulator.endpointId),
              eq(historySeries.kind, accumulator.kind),
            ),
          })
        )?.id;
      if (id === undefined) return undefined;
      this.seriesIds.set(accumulator.seriesKey, id);
      return id;
    } catch (error) {
      // Most likely the device was removed between the report and the flush.
      this.log.warn({ err: error }, 'Could not record a new history series');
      return undefined;
    }
  }

  /** Drop a removed device's series from memory; the cascade has the rows. */
  private forgetDevice(deviceId: string): void {
    const prefix = `${deviceId}:`;
    for (const key of [...this.seriesIds.keys()]) {
      if (key.startsWith(prefix)) this.seriesIds.delete(key);
    }
    for (const key of [...this.open.keys()]) {
      if (key.startsWith(prefix)) this.open.delete(key);
    }
    this.pending = this.pending.filter((entry) => entry.deviceId !== deviceId);
  }

  /**
   * Trim back inside the age bound, at most once an hour.
   *
   * **Per series, not globally.** `(series_id, bucket)` is the table's key, so
   * `series_id = ? AND bucket < ?` is a range delete on a prefix of it; a bare
   * `bucket < ?` would have to scan every row in the table. A few hundred cheap
   * statements once an hour is the better half of that trade, and hanging it
   * off a write means a hub with nothing happening never wakes up to do it —
   * the same shape as `ActivityService.pruneIfDue`.
   */
  private async pruneIfDue(): Promise<void> {
    const now = Date.now();
    if (now - this.lastPruneAt < PRUNE_EVERY_MS) return;
    this.lastPruneAt = now;
    const oldest = Math.floor((now - RETAIN_MS) / BUCKET_MS);
    try {
      for (const seriesId of this.seriesIds.values()) {
        await this.db
          .delete(history)
          .where(and(eq(history.seriesId, seriesId), lt(history.bucket, oldest)));
      }
      // A quantity a device has stopped reporting keeps its dictionary row for
      // ever otherwise, and those rows are what the series cap counts. Only
      // ones with nothing left *and* older than the window go, so a series
      // minted a minute ago is never swept out from under its first flush.
      const empty = await this.db
        .select({ id: historySeries.id })
        .from(historySeries)
        .where(
          and(
            lt(historySeries.createdAt, new Date(now - RETAIN_MS)),
            sql`not exists (select 1 from ${history} where ${history.seriesId} = ${historySeries.id})`,
          ),
        );
      if (empty.length > 0) {
        const ids = empty.map((row) => row.id);
        await this.db.delete(historySeries).where(inArray(historySeries.id, ids));
        for (const [key, id] of [...this.seriesIds]) {
          if (ids.includes(id)) this.seriesIds.delete(key);
        }
      }
    } catch {
      // A table that is a little too full is a nuisance; a failed prune must
      // never break the flush that triggered it.
    }
  }

  // ── Reading ───────────────────────────────────────────────────────────────

  /**
   * One device's history over a window, already thinned to a drawable size.
   *
   * The thinning is the hub's job rather than the app's: a week of one series
   * is 2 016 five-minute buckets and a phone draws ~360 points, so sending the
   * lot would be six times the bytes for a line nobody can tell apart. The
   * answer states the width it chose (`bucketMs`), so the app never has to
   * assume one.
   *
   * The bucket still being filled is merged in from memory, which is the
   * difference between a chart that ends *now* and one that ends up to five
   * minutes ago — with the live reading sitting in a tile right above it.
   */
  async read(
    deviceId: string,
    options: { from: number; to: number; points?: number; kinds?: readonly HistoryKind[] },
  ): Promise<HistoryPage> {
    const to = options.to;
    // Never look further back than the hub keeps: the answer would be an empty
    // stretch that reads as "nothing happened" rather than "never recorded".
    const from = Math.max(options.from, to - RETAIN_MS);
    const points = clamp(Math.round(options.points ?? DEFAULT_POINTS), 2, MAX_POINTS);

    const fromBucket = Math.floor(from / BUCKET_MS);
    const toBucket = Math.floor(to / BUCKET_MS);
    const span = Math.max(1, toBucket - fromBucket + 1);
    // How many stored buckets go into one emitted point.
    const step = Math.max(1, Math.ceil(span / points));
    const emittedMs = step * BUCKET_MS;

    const wanted = KINDS.filter(
      (spec) => options.kinds === undefined || options.kinds.includes(spec.kind),
    );

    const rows = await this.db
      .select({
        id: historySeries.id,
        kind: historySeries.kind,
        endpointId: historySeries.endpointId,
      })
      .from(historySeries)
      .where(eq(historySeries.deviceId, deviceId));

    // The bucket being filled right now has no row yet — and on a device that
    // has only just started reporting, no dictionary entry either. Both are
    // read out of memory, which is what makes a chart end *now* instead of up
    // to five minutes ago, with the live reading sitting in a tile above it.
    const live = [...this.open.values()].filter(
      (entry) =>
        entry.deviceId === deviceId && entry.bucket >= fromBucket && entry.bucket <= toBucket,
    );

    const series: HistorySeriesPage[] = [];
    for (const spec of wanted) {
      const matching = rows.filter((row) => row.kind === spec.kind);
      const open = live.filter((entry) => entry.kind === spec.kind);
      if (matching.length === 0 && open.length === 0) continue;

      // One quantity can exist on more than one endpoint of the same device
      // (a two-channel plug measuring both). They fold into one line: the
      // device page asks about the device, and a chart per channel is a
      // different feature with a different control. One query for all of them,
      // because the fold doesn't care which endpoint a bucket came from.
      const grouped = new Map<number, { min: number; max: number; sum: number; n: number }>();
      if (matching.length > 0) {
        const stored = await this.db
          .select({
            bucket: history.bucket,
            min: history.min,
            max: history.max,
            sum: history.sum,
            n: history.n,
          })
          .from(history)
          .where(
            and(
              inArray(
                history.seriesId,
                matching.map((row) => row.id),
              ),
              gte(history.bucket, fromBucket),
              lte(history.bucket, toBucket),
            ),
          );
        for (const entry of stored) {
          fold(grouped, Math.floor((entry.bucket - fromBucket) / step), entry);
        }
      }
      for (const entry of open) {
        fold(grouped, Math.floor((entry.bucket - fromBucket) / step), entry);
      }
      if (grouped.size === 0) continue;

      const offsets = [...grouped.keys()].sort((a, b) => a - b);
      const values: HistoryPoint[] = offsets.map((offset) => {
        const cell = grouped.get(offset)!;
        return [offset, cell.min, cell.max, Math.round(cell.sum / cell.n)];
      });
      series.push({
        kind: spec.kind,
        unit: spec.unit,
        gapBuckets: gapThreshold(offsets, emittedMs),
        points: values,
      });
    }

    return {
      start: fromBucket * BUCKET_MS,
      bucketMs: emittedMs,
      end: to,
      retentionDays: RETAIN_DAYS,
      series,
    };
  }
}

/** Merge one stored bucket into the emitted point it belongs to. */
function fold(
  grouped: Map<number, { min: number; max: number; sum: number; n: number }>,
  offset: number,
  entry: { min: number; max: number; sum: number; n: number },
): void {
  const cell = grouped.get(offset);
  if (!cell) {
    grouped.set(offset, { min: entry.min, max: entry.max, sum: entry.sum, n: entry.n });
    return;
  }
  if (entry.min < cell.min) cell.min = entry.min;
  if (entry.max > cell.max) cell.max = entry.max;
  cell.sum += entry.sum;
  cell.n += entry.n;
}

/**
 * How long a hole has to be before the app stops drawing through it.
 *
 * Derived from the series' own cadence — the median spacing between the points
 * that *are* there, times four — because a fixed threshold gets one of the two
 * cases wrong every time: a sensor reporting twice an hour would be drawn as
 * permanently broken, or a device that vanished for an afternoon would be
 * drawn as perfectly steady. Floored at three points so a dense series still
 * has to miss something real, and capped at two hours of wall time so the rule
 * means the same thing whichever window is on screen.
 */
function gapThreshold(offsets: number[], emittedMs: number): number {
  const ceiling = Math.max(3, Math.ceil(MAX_GAP_MS / emittedMs));
  if (offsets.length < 2) return ceiling;
  const spacing: number[] = [];
  for (let index = 1; index < offsets.length; index += 1) {
    spacing.push(offsets[index]! - offsets[index - 1]!);
  }
  spacing.sort((a, b) => a - b);
  const median = spacing[Math.floor(spacing.length / 2)] ?? 1;
  return clamp(Math.round(median * 4), 3, ceiling);
}
