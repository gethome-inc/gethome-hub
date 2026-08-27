import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { count, eq } from 'drizzle-orm';
import { pino } from 'pino';
import { HubEventBus } from '../src/core/bus.js';
import { BUCKET_MS, HistoryService } from '../src/core/history.js';
import { devices, endpoints, history, historySeries } from '../src/db/schema.js';
import type { EndpointState } from '../src/schema/index.js';
import { openTestDb, resetDb } from './helpers/db.js';

const handle = await openTestDb();
const log = pino({ level: 'silent' });
const DAY_MS = 24 * 60 * 60 * 1000;

const DEVICE_ID = '11111111-1111-4111-a111-111111111111';

function state(patch: Partial<EndpointState> = {}): EndpointState {
  return { reachable: true, sensors: {}, ...patch };
}

describe.skipIf(!handle)('HistoryService', () => {
  const db = handle?.db!;
  let events: HubEventBus;
  let service: HistoryService;
  /** A bucket boundary the whole test measures from — see `at`. */
  let origin: number;

  beforeEach(async () => {
    await resetDb(db);
    origin = Math.floor(Date.now() / BUCKET_MS) * BUCKET_MS;
    await db.insert(devices).values({
      id: DEVICE_ID,
      adapter: 'mqtt',
      externalId: 'sensor-1',
      name: 'Hall sensor',
    });
    await db.insert(endpoints).values({
      deviceId: DEVICE_ID,
      endpointId: 1,
      deviceKind: 'sensor',
      capabilities: ['temperature'],
      primaryCapability: 'temperature',
      state: state(),
    });
    events = new HubEventBus();
    service = new HistoryService(db, events, log);
    await service.start();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await service.stop();
  });

  afterAll(async () => {
    await handle?.close();
  });

  const rows = async () => db.select().from(history);
  const rowCount = async () => (await db.select({ n: count() }).from(history))[0]!.n;

  const report = (patch: Partial<EndpointState>, endpointId = 1) => {
    events.emit('stateChanged', DEVICE_ID, endpointId, state(patch));
  };

  /**
   * Move the clock to a whole bucket, counted from the test's fixed origin.
   *
   * Deliberately not "from now": reading the current time here would make
   * every call relative to the last one, so `at(-12)` followed by `at(-11)`
   * walked *backwards* twenty-three buckets instead of forwards one.
   */
  const at = (buckets: number) => {
    vi.setSystemTime(origin + buckets * BUCKET_MS);
  };

  it('writes nothing while a bucket is still being filled', async () => {
    vi.useFakeTimers();
    at(0);
    report({ sensors: { temperatureCenti: 2_100 } });
    report({ sensors: { temperatureCenti: 2_300 } });
    await service.flush();

    // The whole point: a report is not a write. A power meter reporting every
    // few seconds must not become a row every few seconds on an SD card.
    expect(await rowCount()).toBe(0);

    // …and it is still on the chart, read out of memory, so the line ends now
    // rather than up to five minutes ago.
    const page = await service.read(DEVICE_ID, { from: Date.now() - DAY_MS, to: Date.now() });
    expect(page.series).toHaveLength(1);
    expect(page.series[0]!.points.at(-1)!.slice(1)).toEqual([2_100, 2_300, 2_200]);
  });

  it('lands one row per bucket, carrying its low, high and mean', async () => {
    vi.useFakeTimers();
    at(0);
    report({ sensors: { temperatureCenti: 2_100 } });
    report({ sensors: { temperatureCenti: 2_300 } });
    report({ sensors: { temperatureCenti: 2_200 } });
    at(1);
    report({ sensors: { temperatureCenti: 1_900 } });
    await service.flush();

    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ min: 2_100, max: 2_300, sum: 6_600, n: 3 });
  });

  it('merges a bucket a restart had already half written', async () => {
    vi.useFakeTimers();
    at(0);
    report({ sensors: { temperatureCenti: 2_000 } });
    // A shutdown inside the bucket writes what it has.
    await service.stop();
    expect(await rowCount()).toBe(1);

    // The hub comes back up inside the same bucket and keeps recording. The
    // upsert has to combine the two halves, which is exactly why `sum`/`n` are
    // stored and the mean is computed on read — an average cannot be merged.
    const events2 = new HubEventBus();
    const revived = new HistoryService(db, events2, log);
    await revived.start();
    events2.emit('stateChanged', DEVICE_ID, 1, state({ sensors: { temperatureCenti: 2_400 } }));
    await revived.stop();

    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ min: 2_000, max: 2_400, sum: 4_400, n: 2 });

    const page = await revived.read(DEVICE_ID, { from: Date.now() - DAY_MS, to: Date.now() });
    expect(page.series[0]!.points[0]!.slice(1)).toEqual([2_000, 2_400, 2_200]);
  });

  it('records every numeric quantity the state carries, in the wire’s own units', async () => {
    vi.useFakeTimers();
    at(0);
    report({
      sensors: {
        temperatureCenti: 2_150,
        humidityCenti: 4_800,
        illuminanceLux: 312.7,
        pressureHPa: 1013.25,
        co2ppm: 640,
        pm25: 7.42,
      },
      power: { activeMilliwatts: 12_500 },
      battery: { percent: 88 },
    });
    at(1);
    await service.flush();

    const page = await service.read(DEVICE_ID, { from: Date.now() - DAY_MS, to: Date.now() });
    const byKind = Object.fromEntries(
      page.series.map((entry) => [entry.kind, { unit: entry.unit, value: entry.points[0]![3] }]),
    );
    expect(byKind).toEqual({
      temperature: { unit: 'centiCelsius', value: 2_150 },
      humidity: { unit: 'centiPercent', value: 4_800 },
      // A whole lux and a tenth of a hPa are far below anything a chart shows,
      // and an integer costs a varint where a float costs eight bytes.
      illuminance: { unit: 'lux', value: 313 },
      pressure: { unit: 'deciHectopascal', value: 10_133 },
      co2: { unit: 'ppm', value: 640 },
      pm25: { unit: 'deciMicrogramsPerCubicMetre', value: 74 },
      power: { unit: 'milliwatt', value: 12_500 },
      battery: { unit: 'percent', value: 88 },
    });
  });

  it('ignores a value that is not a number', async () => {
    vi.useFakeTimers();
    at(0);
    report({ sensors: { temperatureCenti: Number.NaN, humidityCenti: 4_000 } });
    at(1);
    await service.flush();
    const page = await service.read(DEVICE_ID, { from: Date.now() - DAY_MS, to: Date.now() });
    expect(page.series.map((entry) => entry.kind)).toEqual(['humidity']);
  });

  it('leaves a hole where nothing was recorded rather than inventing a value', async () => {
    vi.useFakeTimers();
    at(-12);
    report({ sensors: { temperatureCenti: 2_000 } });
    at(-11);
    report({ sensors: { temperatureCenti: 2_010 } });
    // …an hour of silence…
    at(0);
    report({ sensors: { temperatureCenti: 2_100 } });
    at(1);
    await service.flush();

    const page = await service.read(DEVICE_ID, {
      from: Date.now() - 2 * 60 * 60 * 1000,
      to: Date.now(),
      points: 1_000,
    });
    const offsets = page.series[0]!.points.map((point) => point[0]);
    // Three points, not fifteen: the offsets that are missing *are* the hole,
    // which is what lets an app break its line instead of drawing through it.
    expect(offsets).toHaveLength(3);
    expect(offsets[1]! - offsets[0]!).toBe(1);
    expect(offsets[2]! - offsets[1]!).toBe(11);
  });

  it('sizes the gap threshold from the series’ own cadence', async () => {
    vi.useFakeTimers();
    // A sensor that reports every half hour: six buckets apart.
    for (let step = 12; step >= 0; step -= 6) {
      at(-step);
      report({ sensors: { temperatureCenti: 2_000 + step } });
    }
    at(1);
    await service.flush();

    const page = await service.read(DEVICE_ID, {
      from: Date.now() - 2 * 60 * 60 * 1000,
      to: Date.now(),
      points: 1_000,
    });
    // Four times the median spacing — so a sensor with its own slow cadence is
    // drawn as a continuous line and only a real outage breaks it.
    expect(page.series[0]!.gapBuckets).toBe(24);
  });

  it('thins a long window to what a phone can draw, and says how wide it made a point', async () => {
    vi.useFakeTimers();
    for (let step = 60; step >= 0; step -= 1) {
      at(-step);
      report({ sensors: { temperatureCenti: 2_000 + step } });
    }
    at(1);
    await service.flush();
    expect(await rowCount()).toBe(61);

    const page = await service.read(DEVICE_ID, {
      from: Date.now() - 61 * BUCKET_MS,
      to: Date.now(),
      points: 10,
    });
    // 62 stored buckets into at most 10 points is seven to a point — rounded up
    // to twelve, an hour, because a width a clock recognises is what the card's
    // footnote and the time axis both have to read out. The answer states the
    // width it chose rather than leaving the app to assume one.
    expect(page.bucketMs).toBe(12 * BUCKET_MS);
    expect(page.series[0]!.points.length).toBeLessThanOrEqual(10);
    // Thinning folds rather than samples: the band still reaches the real
    // extremes of the window.
    const lows = page.series[0]!.points.map((point) => point[1]);
    const highs = page.series[0]!.points.map((point) => point[2]);
    expect(Math.min(...lows)).toBe(2_000);
    expect(Math.max(...highs)).toBe(2_060);
  });

  it('rounds a point’s width up to something a clock recognises', async () => {
    vi.useFakeTimers();
    // Five hours of a sensor reporting in every bucket.
    for (let step = 60; step >= 0; step -= 1) {
      at(-step);
      report({ sensors: { temperatureCenti: 2_000 + (step % 20) } });
    }
    at(1);
    await service.flush();

    // 62 buckets into at most 14 points is five buckets — twenty-five minutes,
    // which the card would print under the chart and the axis would label with
    // unrepeatable moments. Half an hour is the next width a clock has a word
    // for.
    const page = await service.read(DEVICE_ID, {
      from: Date.now() - 61 * BUCKET_MS,
      to: Date.now(),
      points: 14,
    });
    expect(page.bucketMs).toBe(6 * BUCKET_MS);

    // An hour asked for with headroom keeps every stored bucket — the range
    // the whole rounding exists to protect. `points` is "at most this many",
    // and an hour touches *thirteen* bucket indices, not twelve, so a caller
    // that asks for exactly twelve is asking to be thinned by one fencepost.
    // Callers ask for room.
    const hour = await service.read(DEVICE_ID, {
      from: Date.now() - 12 * BUCKET_MS,
      to: Date.now(),
      points: 120,
    });
    expect(hour.bucketMs).toBe(BUCKET_MS);
    expect(hour.series[0]!.points.length).toBeGreaterThan(10);
  });

  it('folds one quantity reported on several endpoints into one line', async () => {
    vi.useFakeTimers();
    at(0);
    report({ power: { activeMilliwatts: 1_000 } }, 1);
    report({ power: { activeMilliwatts: 3_000 } }, 2);
    at(1);
    await service.flush();

    const page = await service.read(DEVICE_ID, { from: Date.now() - DAY_MS, to: Date.now() });
    expect(page.series).toHaveLength(1);
    expect(page.series[0]!.points).toHaveLength(1);
    expect(page.series[0]!.points[0]!.slice(1)).toEqual([1_000, 3_000, 2_000]);
  });

  it('never looks further back than it keeps', async () => {
    vi.useFakeTimers();
    at(0);
    report({ sensors: { temperatureCenti: 2_000 } });
    const page = await service.read(DEVICE_ID, { from: Date.now() - 90 * DAY_MS, to: Date.now() });
    // Clamped to the retention window: an empty two months in front of the
    // data would read as "nothing happened" rather than "never recorded".
    expect(Date.now() - page.start).toBeLessThanOrEqual(7 * DAY_MS + BUCKET_MS);
  });

  it('drops buckets past the age bound, and the series rows left empty behind them', async () => {
    vi.useFakeTimers();
    at(0);
    report({ sensors: { temperatureCenti: 2_000 } });
    at(1);
    await service.flush();
    const [series] = await db.select().from(historySeries);
    expect(series).toBeDefined();

    // Age the rows and the dictionary entry past the window, then let the
    // hourly prune run — it hangs off a write, so a quiet hub never wakes for it.
    const ancient = Math.floor((Date.now() - 30 * DAY_MS) / BUCKET_MS);
    await db.update(history).set({ bucket: ancient }).where(eq(history.seriesId, series!.id));
    await db
      .update(historySeries)
      .set({ createdAt: new Date(Date.now() - 30 * DAY_MS) })
      .where(eq(historySeries.id, series!.id));

    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
    report({ sensors: { temperatureCenti: 2_100 } });
    vi.setSystemTime(Date.now() + BUCKET_MS);
    await service.flush();

    const remaining = await rows();
    expect(remaining.every((row) => row.bucket > ancient)).toBe(true);
    const kept = await db.select().from(historySeries);
    // The one series is still here — it has fresh rows. The sweep only takes
    // dictionary entries with nothing left *and* older than the window.
    expect(kept).toHaveLength(1);
  });

  it('stops adding new quantities once it is at its cap', async () => {
    vi.useFakeTimers();
    at(0);
    // One device, many endpoints: the cheapest way to reach the cap, and a
    // real shape — a multi-channel meter is one device with several.
    for (let endpointId = 0; endpointId < 520; endpointId += 1) {
      report({ sensors: { temperatureCenti: 2_000 } }, endpointId);
    }
    at(1);
    await service.flush();

    expect((await db.select({ n: count() }).from(historySeries))[0]!.n).toBe(500);
  });

  it('carries the reading before the window, so a chart can start at its edge', async () => {
    vi.useFakeTimers();
    // Eleven consecutive buckets, each a different temperature, so the one
    // that comes back is identifiable rather than merely present.
    for (let bucket = 0; bucket <= 10; bucket += 1) {
      at(bucket);
      report({ sensors: { temperatureCenti: 2_000 + bucket * 10 } });
    }
    at(11);
    await service.flush();

    // A window that deliberately starts *after* the series does. Without a
    // leading row the app has nothing to draw from the left edge to the first
    // reading, so an hour of a sensor that speaks every twenty minutes opens
    // with a third of the card empty and reads as "nothing recorded".
    const page = await service.read(DEVICE_ID, {
      from: origin + 6 * BUCKET_MS,
      to: origin + 10 * BUCKET_MS,
    });

    const series = page.series[0]!;
    expect(series.points).toHaveLength(5);
    expect(series.leading).toEqual({
      at: origin + 5 * BUCKET_MS,
      min: 2_050,
      max: 2_050,
      avg: 2_050,
    });
    // Epoch ms, not an offset: it does not sit on the emitted grid.
    expect(series.leading!.at).toBeLessThan(page.start);
  });

  it('leaves the reading before the window out when the silence is a hole', async () => {
    vi.useFakeTimers();
    // One reading, then a long silence, then the window's own readings. The
    // old one is real, and joining a line to it across twenty buckets of
    // nothing would be exactly the invention the missing-offset design avoids.
    at(0);
    report({ sensors: { temperatureCenti: 1_000 } });
    for (let bucket = 20; bucket <= 24; bucket += 1) {
      at(bucket);
      report({ sensors: { temperatureCenti: 2_000 + bucket } });
    }
    at(25);
    await service.flush();

    const page = await service.read(DEVICE_ID, {
      from: origin + 20 * BUCKET_MS,
      to: origin + 24 * BUCKET_MS,
    });

    expect(page.series[0]!.points).toHaveLength(5);
    expect(page.series[0]!.leading).toBeUndefined();
  });

  it('forgets a removed device rather than writing against rows the cascade took', async () => {
    vi.useFakeTimers();
    at(0);
    report({ sensors: { temperatureCenti: 2_000 } });
    at(1);
    await service.flush();
    expect(await rowCount()).toBe(1);

    // What the registry does when a Zigbee device drops off the network: the
    // row goes, the cascade takes the history, and this has to let go of the
    // series id or the next flush inserts against one that no longer exists.
    await db.delete(devices).where(eq(devices.id, DEVICE_ID));
    events.emit('deviceRemoved', DEVICE_ID);
    expect(await rowCount()).toBe(0);

    report({ sensors: { temperatureCenti: 2_100 } });
    at(2);
    await service.flush();
    expect(await rowCount()).toBe(0);
    expect((await db.select({ n: count() }).from(historySeries))[0]!.n).toBe(0);
  });
});
