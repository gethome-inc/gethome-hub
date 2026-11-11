import type { StatsFs } from 'node:fs';
import { mkdir, statfs } from 'node:fs/promises';

/**
 * How much room the hub's data directory has — the one measurement that
 * decides whether the hub may keep photos.
 *
 * **The machine is measured, never named.** A photo is written to the disk the
 * hub runs from, not to its memory, so a Zero 2 W with a 32 GB card has as much
 * room for photos as a Pi 5 with the same card — the radio budget's rule from
 * the other side: what decides is a reading of this machine, and the board's
 * name is never the claim.
 */
export interface Space {
  /**
   * What the hub's own account could ever hold: the partition less the blocks
   * ext4 keeps for root. So `totalBytes - freeBytes` is what is really stored.
   */
  totalBytes: number;
  /** What the hub's own account may still write — the reserve left out here too. */
  freeBytes: number;
}

/** A filesystem's answer, the way `statfs` gives it. */
export type SpaceMeasure = (dir: string) => Promise<Space | null>;

/** The four `statfs` figures a reading is made of. */
export type BlockCounts = Pick<StatsFs, 'blocks' | 'bfree' | 'bavail' | 'bsize'>;

/**
 * Both figures as the hub's own account sees the partition, so they add up.
 *
 * `bavail`, not `bfree`, for what is free: the blocks this unprivileged account
 * may write, which leaves out what ext4 reserves for root — measuring the
 * reserve as room would promise the hub space it can never have. **And the
 * total leaves out the same reserve**, because `blocks` beside `bavail` counts
 * it as space in use: on a 64 GB card that was 2.55 GB nothing had written, drawn on the photos page as "everything else" beside 6.85 GB that
 * really was — the bar a third longer than the card's contents. `df` makes the
 * same split (its Size, Used and Avail do not add up); a page with one bar and
 * one sentence cannot carry that, so the hub sends figures that do.
 */
export function spaceOf(stats: BlockCounts): Space {
  const reserved = Math.max(stats.bfree - stats.bavail, 0);
  return {
    totalBytes: Math.max(stats.blocks - reserved, 0) * stats.bsize,
    freeBytes: stats.bavail * stats.bsize,
  };
}

/**
 * `statfs` on the data directory, creating it first if it is not there yet.
 *
 * **Never throws.** A filesystem that will not answer is an unknown, and the
 * callers decide what an unknown means — `GET /photos` leaves the bar out, and
 * keeping goes ahead and lets the write itself say whether there was room,
 * which is the stance the portraits' own space check takes.
 */
export const measureSpace: SpaceMeasure = async (dir) => {
  try {
    const stats = await statfs(dir).catch(async () => {
      await mkdir(dir, { recursive: true });
      return statfs(dir);
    });
    return spaceOf(stats);
  } catch {
    return null;
  }
};

/**
 * One reading, kept for a moment.
 *
 * A page somebody has open asks for this every time the socket says photos
 * changed, and a drawing asks once per photo it keeps; a `statfs` is cheap but
 * not free on an SD card, and the answer cannot move by more than one photo in
 * thirty seconds. `invalidate()` after a write or a delete makes the next
 * reading fresh, so a page never shows space that was just used or freed as
 * if it were not.
 */
export class SpaceReader {
  private cached: { at: number; value: Space | null } | null = null;

  constructor(
    private readonly dir: string,
    private readonly measure: SpaceMeasure = measureSpace,
    private readonly ttlMs = 30_000,
  ) {}

  async read(now = Date.now()): Promise<Space | null> {
    if (this.cached !== null && now - this.cached.at < this.ttlMs) return this.cached.value;
    const value = await this.measure(this.dir);
    this.cached = { at: now, value };
    return value;
  }

  invalidate(): void {
    this.cached = null;
  }
}
