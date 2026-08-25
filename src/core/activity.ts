import { and, desc, eq, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { activity } from '../db/schema.js';
import type { ActivityEvent, HubEventBus } from './bus.js';

/**
 * How much history to keep. The log is a feed a person scrolls, not an audit
 * trail — and it grew without bound on a machine whose disk is an SD card, one
 * row per device event for the life of the hub.
 *
 * Two bounds, because they answer different questions. The row cap protects
 * the disk and is the one that has to hold whatever happens; the age cap
 * protects relevance, because 5 000 rows is three days in a busy home with
 * four people and a year of nothing in a quiet one, and a feed that opens on
 * March is not a feed. Whichever bites first wins — they are one `DELETE`
 * each in the same pass.
 */
const RETAIN_ROWS = 5_000;
const RETAIN_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;

export interface ActivityInput {
  kind: string;
  message: string;
  deviceId?: string;
  memberId?: string;
  data?: Record<string, unknown>;
}

export class ActivityService {
  private lastPruneAt = 0;

  constructor(
    private readonly db: Db,
    private readonly events: HubEventBus,
  ) {}

  async record(input: ActivityInput): Promise<void> {
    await this.pruneIfDue();
    const [row] = await this.db
      .insert(activity)
      .values({
        kind: input.kind,
        message: input.message,
        deviceId: input.deviceId ?? null,
        memberId: input.memberId ?? null,
        data: input.data ?? null,
      })
      .returning();
    if (!row) return;
    const event: ActivityEvent = {
      id: row.id,
      at: row.at.toISOString(),
      kind: row.kind,
      message: row.message,
      ...(row.deviceId ? { deviceId: row.deviceId } : {}),
      ...(row.memberId ? { memberId: row.memberId } : {}),
      ...(row.data ? { data: row.data as Record<string, unknown> } : {}),
    };
    this.events.emit('activity', event);
  }

  /**
   * One page of the log, newest first.
   *
   * `onlyMember` narrows it to that member's own rows, which is what a member
   * without `activity.read` is served: the route answers rather than refusing,
   * because "what have I done in this house" is a fair question for anyone in
   * it, and an app whose Recent feed 403s is a broken screen rather than a
   * withheld one. Rows with no `member_id` — a device dropping off the
   * network, somebody leaving — are nobody's own and are correctly absent.
   */
  async list(limit: number, before?: number, onlyMember?: string) {
    const cursor = before !== undefined ? lt(activity.id, before) : undefined;
    const mine = onlyMember !== undefined ? eq(activity.memberId, onlyMember) : undefined;
    return this.db
      .select()
      .from(activity)
      .where(cursor && mine ? and(cursor, mine) : (cursor ?? mine))
      .orderBy(desc(activity.id))
      .limit(Math.min(Math.max(limit, 1), 200));
  }

  /**
   * Trim the log back inside both bounds, at most once an hour.
   *
   * Hung off `record` rather than a timer on purpose: a hub with nothing
   * happening has nothing to prune, and a timer would be one more thing
   * keeping a quiet process awake.
   */
  private async pruneIfDue(): Promise<void> {
    const now = Date.now();
    if (now - this.lastPruneAt < PRUNE_EVERY_MS) return;
    this.lastPruneAt = now;
    try {
      // `at` carries no index, but the scan it costs is bounded by the row cap
      // the second statement enforces, and it runs once an hour.
      await this.db.delete(activity).where(lt(activity.at, new Date(now - RETAIN_MS)));
      await this.db.delete(activity).where(
        lt(
          activity.id,
          sql`(select min(id) from (select id from ${activity} order by id desc limit ${RETAIN_ROWS}))`,
        ),
      );
    } catch {
      // A full log is a nuisance; a failed prune must never break the event
      // that triggered it.
    }
  }
}
