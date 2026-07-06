import { desc, lt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { activity } from '../db/schema.js';
import type { ActivityEvent, HubEventBus } from './bus.js';

export interface ActivityInput {
  kind: string;
  message: string;
  deviceId?: string;
  memberId?: string;
  data?: Record<string, unknown>;
}

export class ActivityService {
  constructor(
    private readonly db: Db,
    private readonly events: HubEventBus,
  ) {}

  async record(input: ActivityInput): Promise<void> {
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
}
