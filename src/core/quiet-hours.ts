import { z } from 'zod';
import type { ActivityService } from './activity.js';
import type { ActivityEvent, AutomationRunEvent, HubEventBus } from './bus.js';
import type { SettingsService } from './settings.js';
import type { Logger } from '../logging.js';
// The scheduler's own clock, deliberately: "three in the morning" has to mean
// the hour this home's rules already run by, in the home's own timezone, and
// "is the clock real yet" has one answer in this process, not two.
import { MIN_PLAUSIBLE_CLOCK, timeOfDayIn } from '../automations/evaluate.js';

/**
 * When this home is used, hour by hour — so the hub can update itself when it
 * isn't.
 *
 * An update takes the hub off the network for minutes, and in that time no
 * command reaches a device and no rule runs. So the question an automatic
 * update has to answer is not "when is it night" but "when does this home stop
 * asking the hub for things" — which, for somebody on night shifts, or a house
 * whose heating rule fires at half past three, is not three in the morning.
 *
 * **What counts is what an update would interrupt, and nothing else.** Two
 * things, both already on the bus: an activity row with a member on it — a
 * person asked for something, a command, a press, a setting, through an app, a
 * key or a conversation — and a rule that ran and sent at least one command,
 * which is the home doing something by itself. A sensor report that caused
 * nothing is deliberately absent: somebody walking past a motion sensor that
 * switches nothing is not disturbed by the hub being away.
 *
 * **It is its own record, because the activity log cannot carry this.** The
 * log is bounded at 5 000 rows, which is three days in a busy home, and only a
 * *manual* run reaches it — so the rules that fire by themselves, exactly the
 * ones an update at the wrong hour breaks, are not in it at all.
 *
 * **It records only while automatic updates are on**, and starts again from
 * nothing each time they are switched on: a home that turned them off for a
 * fortnight was not quiet for that fortnight, and a gap read as silence would
 * put the next update in the middle of somebody's evening. Switching them off
 * forgets what was learned, because a record kept for a feature that is off is
 * a record nobody asked the hub to keep.
 *
 * Four more rules, each the one a module like this gets wrong:
 *
 *  - **Nothing touches the disk on the event path.** A use is a map increment;
 *    the record is written at most hourly, and not at all by a quiet hub — the
 *    `STATE_FLUSH_MS` line, held once more.
 *  - **Buckets are UTC hours**, the way `history.ts`'s are, and become the
 *    home's own hours only when a window is chosen. Correcting a home's
 *    timezone then re-reads every count it already has in the right place.
 *  - **Nothing is counted against an implausible clock.** A Pi has no RTC, and
 *    a boot's first seconds would otherwise land in 1970.
 *  - **Too little history is not a quiet home.** Under three days the answer
 *    is the night everybody would guess, 03:00–05:00, and it says so.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** How far back the rhythm looks: both halves of a week, twice. */
export const RHYTHM_DAYS = 14;

/** Below this much history the rhythm is not trusted and the default night is used. */
export const MIN_LEARNING_DAYS = 3;

/** How long a window is. Long enough to wait out a busy moment inside it. */
export const WINDOW_HOURS = 2;

/** Where the default window opens, in the home's own time. */
export const DEFAULT_WINDOW_START = 3;

/**
 * What a scheduled rule weighs in the hour it fires, per day.
 *
 * Far above anything a home asks for in an hour, so a window is not placed over
 * a rule the hub knows is coming — and still a weight rather than a wall,
 * because a home with a rule in every hour must still get a window, and the
 * check right before an update waits out a rule that is about to run anyway.
 */
const SCHEDULED_WEIGHT = 100;

/** Scores closer than this are a tie, which the default night breaks. */
const TIE = 1e-9;

const FLUSH_MS = HOUR_MS;

const RHYTHM_KEY = 'update_rhythm';

/**
 * The stored record. `hours` is `[UTC hour index, uses]`, oldest first.
 *
 * A record this build cannot read is started again rather than trusted: it is
 * derived data, and a rolled-back build meeting a newer shape loses nothing
 * worse than a few days of learning.
 */
const storedSchema = z.object({
  v: z.literal(1),
  since: z.number(),
  hours: z.array(z.tuple([z.number().int(), z.number().int().nonnegative()])),
});

type StoredRhythm = z.infer<typeof storedSchema>;

/** A stretch of the home's day the hub may update in. */
export interface QuietWindow {
  /** The home-local hour it opens, 0–23. */
  startHour: number;
  /** How many hours it lasts. */
  hours: number;
  /** Whether it was learned from this home, or is the default night. */
  learned: boolean;
}

export interface QuietHoursDeps {
  settings: Pick<SettingsService, 'get' | 'set' | 'unset'>;
  events: HubEventBus;
  activity: Pick<ActivityService, 'lastAskedAt'>;
  log: Logger;
  now?: () => number;
  flushMs?: number;
}

export class QuietHours {
  private readonly now: () => number;
  /** When learning began, or undefined while automatic updates are off. */
  private since: number | undefined;
  /** UTC hour index → how many times the home was used in it. */
  private readonly counts = new Map<number, number>();
  private dirty = false;
  /** When a person was last about — see `lastUseAt`. */
  private lastUse: number | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;
  /**
   * The last window worked out, kept for the hour it was worked out in. A
   * window moves by the hour at most, and asking for it is a pass through every
   * stored hour with a timezone formatter each — fine once an hour on a Zero 2
   * W, not on every look at the clock and every app opening the Software card.
   */
  private memo: { key: string; window: QuietWindow } | undefined;

  constructor(private readonly deps: QuietHoursDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** Read what was learned so far, and when somebody last asked for anything. */
  async load(): Promise<void> {
    try {
      const stored = storedSchema.safeParse(await this.deps.settings.get<unknown>(RHYTHM_KEY));
      if (stored.success) {
        this.since = stored.data.since;
        this.counts.clear();
        for (const [hour, uses] of stored.data.hours) this.counts.set(hour, uses);
      }
    } catch (error) {
      this.deps.log.warn({ err: error }, 'Could not read when this home is used');
    }
    try {
      // The bus says nothing about the minutes before this process started,
      // which on the night of an update is exactly the half hour that matters.
      this.lastUse = await this.deps.activity.lastAskedAt();
    } catch {
      // Nothing to seed from; the bus fills it in from here.
    }
  }

  start(): void {
    if (this.timer !== null) return;
    this.deps.events.on('activity', this.onActivity);
    this.deps.events.on('automationRun', this.onRun);
    this.timer = setInterval(() => {
      void this.flush();
    }, this.deps.flushMs ?? FLUSH_MS);
    // Never the reason a quiet hub stays awake.
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.deps.events.off('activity', this.onActivity);
    this.deps.events.off('automationRun', this.onRun);
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // The hour being counted right now — this is its one chance.
    await this.flush();
  }

  /** Whether the hub is learning, which is whether automatic updates are on. */
  get recording(): boolean {
    return this.since !== undefined;
  }

  /** Start learning from nothing. Called when automatic updates are switched on. */
  async begin(): Promise<void> {
    this.since = this.now();
    this.counts.clear();
    this.dirty = true;
    await this.flush();
  }

  /** Stop learning and forget what was learned. Called when they are switched off. */
  async end(): Promise<void> {
    this.since = undefined;
    this.counts.clear();
    this.dirty = false;
    try {
      await this.deps.settings.unset(RHYTHM_KEY);
    } catch (error) {
      this.deps.log.warn({ err: error }, 'Could not forget when this home is used');
    }
  }

  /**
   * When a person was last about: somebody asked for something, or a device
   * set off a rule that did something.
   *
   * Narrower than what is counted, on purpose. A rule the clock sets off is the
   * home on its own — an update interrupts it, so it counts toward the rhythm —
   * but it is not somebody awake, and a rule that runs every ten minutes all
   * night would otherwise keep a hub from ever finding a quiet moment.
   */
  lastUseAt(): number | undefined {
    return this.lastUse;
  }

  /**
   * The stretch of the day to update in.
   *
   * `scheduledHours` are the home-local hours enabled rules are set to fire in,
   * one entry per rule, weighted so a window is not placed over one.
   */
  window(timezone: string, scheduledHours: readonly number[] = []): QuietWindow {
    const now = this.now();
    const key = `${timezone}|${Math.floor(now / HOUR_MS)}|${this.since ?? ''}|${scheduledHours.join(',')}`;
    if (this.memo?.key === key) return this.memo.window;
    const window = this.workOut(timezone, scheduledHours, now);
    this.memo = { key, window };
    return window;
  }

  private workOut(timezone: string, scheduledHours: readonly number[], now: number): QuietWindow {
    const fallback: QuietWindow = { startHour: DEFAULT_WINDOW_START, hours: WINDOW_HOURS, learned: false };
    if (this.since === undefined || now - this.since < MIN_LEARNING_DAYS * DAY_MS) return fallback;

    const observedDays = Math.min(RHYTHM_DAYS, (now - this.since) / DAY_MS);
    const oldest = Math.floor((now - RHYTHM_DAYS * DAY_MS) / HOUR_MS);
    const perHour = new Array<number>(24).fill(0);
    try {
      for (const [hour, uses] of this.counts) {
        if (hour < oldest) continue;
        // The middle of the bucket, so a timezone half an hour off UTC still
        // lands each one in the local hour it mostly covered.
        const local = Number(timeOfDayIn(timezone, hour * HOUR_MS + HOUR_MS / 2).slice(0, 2));
        if (local >= 0 && local < 24) perHour[local] = (perHour[local] ?? 0) + uses / observedDays;
      }
    } catch {
      // A timezone `Intl` cannot use. There is no home-local hour to put a
      // window in, and the default is at least the night everybody would guess.
      return fallback;
    }
    for (const hour of scheduledHours) {
      if (hour >= 0 && hour < 24) perHour[hour] = (perHour[hour] ?? 0) + SCHEDULED_WEIGHT;
    }
    return { startHour: quietestStart(perHour), hours: WINDOW_HOURS, learned: true };
  }

  /** Write what was counted, if anything was. */
  async flush(): Promise<void> {
    if (!this.dirty || this.since === undefined) return;
    this.dirty = false;
    const oldest = Math.floor((this.now() - RHYTHM_DAYS * DAY_MS) / HOUR_MS);
    for (const hour of [...this.counts.keys()]) {
      if (hour < oldest) this.counts.delete(hour);
    }
    const record: StoredRhythm = {
      v: 1,
      since: this.since,
      hours: [...this.counts.entries()].sort((a, b) => a[0] - b[0]),
    };
    try {
      await this.deps.settings.set(RHYTHM_KEY, record);
    } catch (error) {
      // Kept in memory and written with the next flush.
      this.dirty = true;
      this.deps.log.warn({ err: error }, 'Could not save when this home is used');
    }
  }

  // ── Counting ───────────────────────────────────────────────────────────────

  private readonly onActivity = (entry: ActivityEvent): void => {
    // A person asked for something. Rows the hub writes about itself — a device
    // dropping off the network, an update's outcome — carry no member, and are
    // not anybody using the home.
    if (entry.memberId === undefined) return;
    this.note(true);
  };

  private readonly onRun = (run: AutomationRunEvent): void => {
    if (run.outcome !== 'ran' || run.commands <= 0) return;
    // A press already arrived as its activity row, with the person on it.
    if (run.trigger === 'manual') return;
    this.note(run.trigger === 'deviceState' || run.trigger === 'deviceEvent');
  };

  private note(somebody: boolean): void {
    const now = this.now();
    if (now < MIN_PLAUSIBLE_CLOCK) return;
    if (somebody) this.lastUse = now;
    if (this.since === undefined) return;
    const hour = Math.floor(now / HOUR_MS);
    this.counts.set(hour, (this.counts.get(hour) ?? 0) + 1);
    this.dirty = true;
  }
}

/**
 * The hour a window should open at, from the uses of each home-local hour.
 *
 * A window scores its own hours plus half of each hour either side, so it is
 * not chosen hard up against the hour the house wakes in. Candidates are tried
 * outwards from the default night, earlier before later, and only a strictly
 * lower score moves the answer — so a tie, including the home that never uses
 * the hub at all, goes to the start nearest 03:00.
 */
export function quietestStart(perHour: readonly number[]): number {
  const at = (hour: number): number => perHour[((hour % 24) + 24) % 24] ?? 0;
  let best = DEFAULT_WINDOW_START;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let distance = 0; distance <= 12; distance++) {
    const earlier = (DEFAULT_WINDOW_START - distance + 24) % 24;
    const later = (DEFAULT_WINDOW_START + distance) % 24;
    for (const start of earlier === later ? [earlier] : [earlier, later]) {
      let score = 0.5 * (at(start - 1) + at(start + WINDOW_HOURS));
      for (let offset = 0; offset < WINDOW_HOURS; offset++) score += at(start + offset);
      if (score < bestScore - TIE) {
        best = start;
        bestScore = score;
      }
    }
  }
  return best;
}
