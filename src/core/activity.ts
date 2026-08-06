import { desc, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { activity } from '../db/schema.js';
import type { ActivityEvent, HubEventBus } from './bus.js';

/**
 * How much history to keep. The log is a feed a person scrolls, not an audit
 * trail — and it grew without bound on a machine whose disk is an SD card, one
 * row per device event for the life of the hub.
 */
const RETAIN_ROWS = 5_000;
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
    };
    this.events.emit('activity', event);
  }

  async list(limit: number, before?: number) {
    return this.db
      .select()
      .from(activity)
      .where(before !== undefined ? lt(activity.id, before) : undefined)
      .orderBy(desc(activity.id))
      .limit(Math.min(Math.max(limit, 1), 200));
  }

  /**
   * Trim the log back to `RETAIN_ROWS`, at most once an hour.
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
