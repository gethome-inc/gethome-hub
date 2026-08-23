import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { count } from 'drizzle-orm';
import { ActivityService } from '../src/core/activity.js';
import { HubEventBus } from '../src/core/bus.js';
import type { ActivityEvent } from '../src/core/bus.js';
import { activity } from '../src/db/schema.js';
import { openTestDb, resetDb } from './helpers/db.js';

const handle = await openTestDb();
const DAY_MS = 24 * 60 * 60 * 1000;

describe.skipIf(!handle)('ActivityService', () => {
  const db = handle?.db!;
  let events: HubEventBus;
  let service: ActivityService;

  beforeEach(async () => {
    await resetDb(db);
    events = new HubEventBus();
    // A fresh service has never pruned, so the first `record` prunes.
    service = new ActivityService(db, events);
  });

  afterAll(async () => {
    await handle?.close();
  });

  const rowCount = async () => (await db.select({ n: count() }).from(activity))[0]!.n;

  it('carries structured data to the row and to the broadcast event', async () => {
    const seen: ActivityEvent[] = [];
    events.on('activity', (entry) => seen.push(entry));

    await service.record({
      kind: 'device.command',
      message: 'Anna · Desk lamp: power',
      data: { command: { type: 'power', on: true }, deviceName: 'Desk lamp', memberName: 'Anna' },
    });

    const [row] = await db.select().from(activity);
    expect(row!.data).toEqual({
      command: { type: 'power', on: true },
      deviceName: 'Desk lamp',
      memberName: 'Anna',
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.data).toEqual(row!.data);
  });

  it('leaves data off an entry that has none, rather than sending null', async () => {
    const seen: ActivityEvent[] = [];
    events.on('activity', (entry) => seen.push(entry));
    await service.record({ kind: 'hub.radio', message: 'Radio set to auto' });
    expect(seen[0]!).not.toHaveProperty('data');
  });

  it('drops entries older than the age bound', async () => {
    const now = Date.now();
    await db.insert(activity).values([
      { kind: 'device.command', message: 'ancient', at: new Date(now - 40 * DAY_MS) },
      { kind: 'device.command', message: 'a fortnight ago', at: new Date(now - 14 * DAY_MS) },
    ]);

    await service.record({ kind: 'device.command', message: 'now' });

    const messages = (await db.select().from(activity)).map((row) => row.message);
    expect(messages).toEqual(['a fortnight ago', 'now']);
  });

  it('holds the row cap however young the rows are', async () => {
    const at = new Date();
    for (let batch = 0; batch < 11; batch += 1) {
      await db.insert(activity).values(
        Array.from({ length: 500 }, (_, index) => ({
          kind: 'device.command',
          message: `row ${batch * 500 + index}`,
          at,
        })),
      );
    }
    expect(await rowCount()).toBe(5_500);

    await service.record({ kind: 'device.command', message: 'the one that prunes' });

    // Trimmed to the cap and then written, so the log sits at the cap plus
    // whatever has happened since the last pass — an hourly bound, not a
    // per-row one. Nothing here rewrites a row to make room for the new one.
    expect(await rowCount()).toBe(5_001);
    const newest = await service.list(1);
    expect(newest[0]!.message).toBe('the one that prunes');
  });

  it('prunes at most once an hour, so a busy home does not scan per event', async () => {
    await service.record({ kind: 'device.command', message: 'first' });
    await db.insert(activity).values({
      kind: 'device.command',
      message: 'ancient',
      at: new Date(Date.now() - 40 * DAY_MS),
    });

    await service.record({ kind: 'device.command', message: 'second' });

    const messages = (await db.select().from(activity)).map((row) => row.message);
    expect(messages).toContain('ancient');
  });
});
