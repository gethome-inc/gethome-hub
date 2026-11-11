import { localDateIn } from './evaluate.js';

/**
 * Whether a rule is working.
 *
 * A list of rules used to say what each one *would* do and nothing about
 * whether it does: a motion light that had not fired since Tuesday and one
 * that fired a minute ago were the same card. This is the second half — when a
 * rule last ran and how that went, how busy it has been today, the last thing
 * that went wrong, in a sentence — and it rides on every automation the API
 * sends.
 *
 * **Three outcomes, kept apart, because they answer three questions.** A *run*
 * is a firing that got as far as its actions. A *skip* is the rule declining
 * before it did anything — a condition did not hold, it was already running —
 * which for "only at night" is most firings and is the rule working. A
 * *problem* is a run in which something was asked for and did not happen: a
 * device that did not answer, a relay the hub protected, the circuit breaker.
 * Counting skips as runs would say a night light fired two hundred times
 * today; counting them as problems would paint it red for doing its job.
 *
 * **A device that was already the way a rule wanted it is not a problem.** The
 * idempotence guard declines that command and the trace says "was already
 * on" — the house is as asked.
 *
 * **"Today" is the home's own day**, in the home's timezone, and it rolls over
 * when it is *read* as well as when it is written: a rule that last fired
 * yesterday answers zero this morning without anything having to happen first.
 *
 * Held in memory and written down on a timer (`AutomationStore.saveStatus`),
 * because a rule can fire every few seconds and none of this is worth an SD
 * card write per firing. What is lost with the power is at most the last
 * minute of counting.
 */

// A `type`, not an `interface`: the bus carries it as a plain record.
export type AutomationStatus = {
  /** The last firing that got as far as its actions. */
  lastRun?: {
    at: string;
    /** `ran` · `failed` · `refused` · `interrupted` — an open string. */
    outcome: string;
    /** What set it off, as the run's own `cause` says it. */
    cause: string;
    /** What went wrong in it, in a sentence. Absent when nothing did. */
    problem?: string;
  };
  /** The last firing the rule declined before doing anything, and why. */
  lastSkipped?: { at: string; cause: string; reason: string };
  /** The last run in which something asked for did not happen. */
  lastProblem?: { at: string; outcome: string; reason: string };
  /** The home's own day: how many runs, how many of them with a problem, and
   *  how many firings were skipped before acting. */
  today: { date: string; runs: number; problems: number; skipped: number };
  /** A button or a mode: when somebody last pressed or switched it, and who. */
  lastPressed?: { at: string; by?: string };
  /** A mode that is on: since when. */
  activeSince?: string;
  /** A rule on a clock: when it fires next. */
  nextRunAt?: string;
};

/** What is remembered — everything above that is not worked out per read. */
type Remembered = Omit<AutomationStatus, 'nextRunAt'>;

export interface StatusNote {
  outcome: 'ran' | 'skipped' | 'refused' | 'failed' | 'interrupted';
  cause: string;
  /** Why it was skipped, or what went wrong — a whole sentence. */
  reason?: string | undefined;
  /** Whether anything asked for in this run did not happen. */
  problem?: boolean | undefined;
  /** Set when a person started it. */
  pressedBy?: string | undefined;
}

/** How one firing was written down — see `AutomationStatusBook.note`. */
export interface NotedRun {
  at: string;
  /** The home's day it was counted in. */
  date: string;
  /** Whether it has been counted as a run with a problem. */
  problem: boolean;
}

const iso = (at: number): string => new Date(at).toISOString();

export class AutomationStatusBook {
  private readonly entries = new Map<string, Remembered>();
  private readonly dirty = new Set<string>();

  constructor(
    private readonly now: () => number,
    private readonly timezone: () => string,
  ) {}

  /** The home's calendar date. A timezone `Intl` cannot use falls back to UTC
   *  rather than taking the count down with it. */
  private date(): string {
    try {
      return localDateIn(this.timezone(), this.now());
    } catch {
      return iso(this.now()).slice(0, 10);
    }
  }

  private entry(id: string): Remembered {
    const date = this.date();
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { today: { date, runs: 0, problems: 0, skipped: 0 } };
      this.entries.set(id, entry);
    }
    if (entry.today.date !== date) entry.today = { date, runs: 0, problems: 0, skipped: 0 };
    return entry;
  }

  /**
   * Take back what an earlier boot wrote down.
   *
   * Read defensively, field by field: the row may be an older build's or a
   * newer one's (`install.sh` rolls back after a migration has run), and a
   * status that cannot be understood is one that starts again, never one that
   * stops the engine.
   */
  restore(rows: ReadonlyMap<string, unknown>): void {
    for (const [id, raw] of rows) {
      if (typeof raw !== 'object' || raw === null) continue;
      const row = raw as Partial<Remembered>;
      const today = row.today;
      const entry: Remembered = {
        today:
          today !== undefined &&
          typeof today.date === 'string' &&
          [today.runs, today.problems, today.skipped].every((count) => Number.isInteger(count))
            ? { date: today.date, runs: today.runs, problems: today.problems, skipped: today.skipped }
            : { date: this.date(), runs: 0, problems: 0, skipped: 0 },
        ...(isStamped(row.lastRun) ? { lastRun: row.lastRun } : {}),
        ...(isStamped(row.lastSkipped) ? { lastSkipped: row.lastSkipped } : {}),
        ...(isStamped(row.lastProblem) ? { lastProblem: row.lastProblem } : {}),
        ...(isStamped(row.lastPressed) ? { lastPressed: row.lastPressed } : {}),
        ...(typeof row.activeSince === 'string' ? { activeSince: row.activeSince } : {}),
      };
      this.entries.set(id, entry);
    }
  }

  /**
   * One firing, however it ended. Answers how it was written down — when, in
   * which of the home's days, and whether it already counted as a run with a
   * problem — for a failure that is only reported afterwards (`lateProblem`).
   */
  note(id: string, note: StatusNote): NotedRun {
    const entry = this.entry(id);
    const at = iso(this.now());
    let counted = false;

    if (note.pressedBy !== undefined) {
      entry.lastPressed = { at, by: note.pressedBy };
    }

    if (note.outcome === 'skipped') {
      entry.today.skipped += 1;
      entry.lastSkipped = { at, cause: note.cause, reason: note.reason ?? 'It was skipped.' };
    } else {
      const problem = note.problem === true || note.outcome === 'failed' || note.outcome === 'refused';
      entry.today.runs += 1;
      if (problem) entry.today.problems += 1;
      counted = problem;
      entry.lastRun = {
        at,
        outcome: note.outcome,
        cause: note.cause,
        ...(problem ? { problem: note.reason ?? 'Something did not go through.' } : {}),
      };
      if (problem) {
        entry.lastProblem = {
          at,
          outcome: note.outcome,
          reason: note.reason ?? 'Something did not go through.',
        };
      }
    }
    this.dirty.add(id);
    return { at, date: entry.today.date, problem: counted };
  }

  /**
   * A command a run sent turned out not to have landed, after the run was
   * written down as fine.
   *
   * A radio reports a write that failed seconds after it took the message, so
   * a run can end "ran" over a lamp that never moved. This puts that right:
   * the run counts as one with a problem — once, however many of its commands
   * failed, and only in the day it ran in — and the reason is kept as the
   * last problem unless a newer one already is.
   */
  lateProblem(id: string, run: NotedRun, reason: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (!run.problem) {
      run.problem = true;
      if (this.entry(id).today.date === run.date) entry.today.problems += 1;
    }
    if (entry.lastRun?.at === run.at && entry.lastRun.problem === undefined) {
      entry.lastRun = { ...entry.lastRun, problem: reason };
    }
    if (entry.lastProblem === undefined || entry.lastProblem.at <= run.at) {
      entry.lastProblem = { at: run.at, outcome: 'ran', reason };
    }
    this.dirty.add(id);
  }

  /** A mode was switched. Remembers since when it has been on. */
  setActive(id: string, active: boolean): void {
    const entry = this.entry(id);
    if (active) entry.activeSince = iso(this.now());
    else delete entry.activeSince;
    this.dirty.add(id);
  }

  /** What is remembered about one rule, with today brought up to date. */
  read(id: string): Remembered {
    const entry = this.entries.get(id);
    const date = this.date();
    if (!entry) return { today: { date, runs: 0, problems: 0, skipped: 0 } };
    return entry.today.date === date
      ? entry
      : { ...entry, today: { date, runs: 0, problems: 0, skipped: 0 } };
  }

  /** Drop every rule the home no longer has. */
  keepOnly(ids: ReadonlySet<string>): void {
    for (const id of [...this.entries.keys()]) {
      if (!ids.has(id)) {
        this.entries.delete(id);
        this.dirty.delete(id);
      }
    }
  }

  /** What has moved since it was last asked — and it is then no longer owed. */
  takeDirty(): Map<string, unknown> {
    const moved = new Map<string, unknown>();
    for (const id of this.dirty) {
      const entry = this.entries.get(id);
      if (entry) moved.set(id, entry);
    }
    this.dirty.clear();
    return moved;
  }
}

function isStamped<T extends { at: string }>(value: T | undefined): value is T {
  return typeof value === 'object' && value !== null && typeof value.at === 'string';
}
