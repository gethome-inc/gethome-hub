import type { EndpointState } from '../schema/index.js';
import type { AutomationCondition, Comparator, ReadablePath } from './schema.js';
import { resolveTarget, type AutomationHomeView } from './targets.js';

/**
 * Reading the home and answering questions about it — the pure half of the
 * engine, with no clock of its own, no bus and no I/O.
 *
 * Everything here is a function of (document, home, states, now), which is
 * what makes the engine testable at all: a rule's behaviour over a day can be
 * checked in a millisecond by moving `now`, and the parts that decide whether
 * something fires can be checked without a database or a radio.
 */

/** Where a rule reads current values from: device id → endpoint id → state. */
export type StateLookup = (deviceId: string, endpointId: number) => EndpointState | undefined;

/**
 * Pull a canonical path out of a state.
 *
 * A generic dotted walk rather than a switch, deliberately: `READABLE_PATHS`
 * is already the whitelist and every key in it is literally the path through
 * `EndpointState`, so a hand-written switch would be a second copy of that
 * list to keep in step. Anything that is not a number or a boolean at the end
 * of the walk reads as absent, which is the honest answer for a device that
 * has never reported it.
 */
export function readPath(state: EndpointState | undefined, path: ReadablePath): number | boolean | undefined {
  if (!state) return undefined;
  let current: unknown = state;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === 'number' || typeof current === 'boolean' ? current : undefined;
}

export function compare(
  value: number | boolean | undefined,
  op: Comparator,
  target: number | boolean | undefined,
): boolean {
  // A device that has never reported the thing being asked about answers
  // "no" to every question, including `ne`. Saying "it is not 5" about a
  // value nobody has ever seen would let a rule fire on ignorance.
  if (value === undefined) return false;
  switch (op) {
    case 'eq':
      return value === target;
    case 'ne':
      return value !== target;
    case 'lt':
      return typeof value === 'number' && typeof target === 'number' && value < target;
    case 'lte':
      return typeof value === 'number' && typeof target === 'number' && value <= target;
    case 'gt':
      return typeof value === 'number' && typeof target === 'number' && value > target;
    case 'gte':
      return typeof value === 'number' && typeof target === 'number' && value >= target;
    case 'changed':
      // Handled by the caller, which is the only thing holding the previous
      // value. Here it is never a standing answer — see `sanity.ts`.
      return false;
  }
}

// ── Edge triggering ──────────────────────────────────────────────────────────

/**
 * One watched (rule, trigger, device) pair's memory.
 *
 * `latched` is "this test was true last time I looked, and I have already
 * fired for it". `seen` is what makes the first evaluation adopt rather than
 * fire — see the note on the `deviceState` trigger in `schema.ts`.
 */
export interface EdgeState {
  seen: boolean;
  latched: boolean;
  /** For `changed`: the value last observed. */
  previous?: number | boolean | undefined;
}

export interface EdgeOutcome {
  fires: boolean;
  next: EdgeState;
}

/**
 * Should this reading fire the trigger?
 *
 * Three rules in one small function, and each of them exists because of a
 * failure mode rather than a preference:
 *
 *  - **Fire on the crossing.** A test that is still true is not news.
 *  - **Adopt on first sight.** A hub that has just restarted has watched no
 *    transitions, so it announces none.
 *  - **Re-arm outside the band.** Without hysteresis a value resting on the
 *    threshold crosses it every time it wobbles, and each crossing is a real
 *    edge — which is why an edge alone is not enough on a noisy reading and
 *    why `sanity.ts` insists on one of the two.
 */
export function evaluateEdge(
  previous: EdgeState | undefined,
  value: number | boolean | undefined,
  op: Comparator,
  target: number | boolean | undefined,
  hysteresis: number | undefined,
): EdgeOutcome {
  if (op === 'changed') {
    const seen = previous?.seen ?? false;
    const before = previous?.previous;
    const fires = seen && value !== undefined && value !== before;
    return { fires, next: { seen: true, latched: false, previous: value } };
  }

  const matches = compare(value, op, target);

  if (!previous?.seen) {
    // First sight: take the answer, say nothing.
    return { fires: false, next: { seen: true, latched: matches, previous: value } };
  }

  if (!previous.latched && matches) {
    return { fires: true, next: { seen: true, latched: true, previous: value } };
  }

  if (previous.latched && !matches) {
    const outsideBand =
      hysteresis === undefined ||
      hysteresis <= 0 ||
      (typeof value === 'number' && typeof target === 'number'
        ? Math.abs(value - target) >= hysteresis
        : true);
    return { fires: false, next: { seen: true, latched: !outsideBand, previous: value } };
  }

  return { fires: false, next: { seen: true, latched: previous.latched, previous: value } };
}

// ── Time ─────────────────────────────────────────────────────────────────────

/**
 * Before this, the clock is not to be trusted.
 *
 * A Raspberry Pi has no real-time clock: it boots at whatever the last shutdown
 * wrote, or at the epoch, and NTP corrects it seconds to minutes later. A
 * scheduler that ran during that window would fire every rule whose time
 * happened to match a fictional clock. Nothing is skipped by waiting — the
 * tick fires on the minute it *is* in, so the moment the clock is right the
 * right minute comes round.
 *
 * Exported because it is not only the scheduler's: the hub's automatic updates
 * read the same clock to decide when the home is asleep, and two copies of
 * "when is the clock real" would be two places for one of them to be wrong.
 */
export const MIN_PLAUSIBLE_CLOCK = Date.UTC(2025, 0, 1);

const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * `HH:MM` and the weekday, in the home's own timezone.
 *
 * A hub sits in the house it automates and the person writing "at ten in the
 * evening" means their own ten. `Intl` is what makes that work without a
 * timezone database of our own, and `hourCycle: 'h23'` is load-bearing: the
 * default `hour12: false` renders midnight as **24** in several locales,
 * which would make a schedule at 00:00 unreachable.
 */
function partsIn(timezone: string, at: number): { time: string; day: number } {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      weekday: 'short',
    });
    formatters.set(timezone, formatter);
  }
  const parts = formatter.formatToParts(new Date(at));
  const hour = parts.find((part) => part.type === 'hour')?.value ?? '00';
  const minute = parts.find((part) => part.type === 'minute')?.value ?? '00';
  const weekday = parts.find((part) => part.type === 'weekday')?.value ?? 'Sun';
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return { time: `${hour}:${minute}`, day: Math.max(0, days.indexOf(weekday)) };
}

export function timeOfDayIn(timezone: string, at: number): string {
  return partsIn(timezone, at).time;
}

export function dayOfWeekIn(timezone: string, at: number): number {
  return partsIn(timezone, at).day;
}

/**
 * Is `now` inside the window?
 *
 * A window whose end is before its start wraps midnight — 22:00 to 06:00 is
 * one night, and treating it as empty would silently break every rule anybody
 * writes about the evening.
 */
export function withinTimeRange(now: string, from: string, to: string): boolean {
  if (from <= to) return now >= from && now < to;
  return now >= from || now < to;
}

// ── Conditions ───────────────────────────────────────────────────────────────

export interface ConditionContext {
  home: AutomationHomeView;
  states: StateLookup;
  now: number;
  timezone: string;
  /** Whether a manual toggle is currently switched on. */
  isActive: (automationId: string) => boolean;
}

export function evaluateCondition(condition: AutomationCondition, context: ConditionContext): boolean {
  switch (condition.kind) {
    case 'deviceState': {
      const resolved = resolveTarget(condition.target, context.home);
      if (resolved.length === 0) return false;
      const answers = resolved.map((entry) =>
        compare(
          readPath(context.states(entry.deviceId, entry.endpointId), condition.path),
          condition.op,
          condition.value,
        ),
      );
      // `any` is the default because it is what the words mean: "if a window
      // is open" is true when one is, not only when all of them are.
      return condition.match === 'all' ? answers.every(Boolean) : answers.some(Boolean);
    }
    case 'timeRange':
      return withinTimeRange(
        timeOfDayIn(context.timezone, context.now),
        condition.from,
        condition.to,
      );
    case 'dayOfWeek':
      return condition.days.includes(dayOfWeekIn(context.timezone, context.now));
    case 'automationActive':
      return context.isActive(condition.automationId) === condition.is;
    case 'all':
      return condition.conditions.every((nested) => evaluateCondition(nested, context));
    case 'any':
      return condition.conditions.some((nested) => evaluateCondition(nested, context));
    case 'not':
      return !evaluateCondition(condition.condition, context);
  }
}

export function evaluateConditions(
  conditions: readonly AutomationCondition[] | undefined,
  context: ConditionContext,
): boolean {
  if (!conditions || conditions.length === 0) return true;
  return conditions.every((condition) => evaluateCondition(condition, context));
}

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

/** The home's own calendar date, `YYYY-MM-DD` — what "today" means in it. */
export function localDateIn(timezone: string, at: number): string {
  let formatter = dateFormatters.get(timezone);
  if (!formatter) {
    // `en-CA` writes a date the ISO way round, which is the one property wanted.
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dateFormatters.set(timezone, formatter);
  }
  return formatter.format(new Date(at));
}

/**
 * The instant a wall-clock `HH:MM` falls on a calendar date in a timezone, or
 * `null` when that date has no such minute (the hour a clock skips in spring).
 *
 * Found by guessing the instant as if the zone were UTC and correcting by how
 * far the zone's own reading of that guess is from what was asked — twice,
 * because the first correction can land on the other side of a change of
 * summer time. The answer is then *checked* with the helpers `tick` itself
 * uses, so "when will this fire" cannot disagree with "did this fire".
 */
function instantOf(timezone: string, date: string, time: string): number | null {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  if ([year, month, day, hour, minute].some((part) => part === undefined || Number.isNaN(part))) {
    return null;
  }
  const wanted = Date.UTC(year!, month! - 1, day!, hour!, minute!);
  const readAsUtc = (at: number): number => {
    const [y, m, d] = localDateIn(timezone, at).split('-').map(Number);
    const [h, min] = timeOfDayIn(timezone, at).split(':').map(Number);
    return Date.UTC(y!, m! - 1, d!, h!, min!);
  };
  let guess = wanted;
  for (let pass = 0; pass < 2; pass += 1) guess += wanted - readAsUtc(guess);
  return localDateIn(timezone, guess) === date && timeOfDayIn(timezone, guess) === time
    ? guess
    : null;
}

/**
 * When a set of `schedule` triggers next fires after `now`, or `null`.
 *
 * Looked for over the coming eight days — a schedule names days of the week,
 * so one that is going to fire at all fires within seven — and a timezone
 * `Intl` cannot use answers `null`, exactly as `tick` holds every schedule in
 * one.
 */
export function nextScheduleAt(
  schedules: readonly { at: string; days?: readonly number[] | undefined }[],
  timezone: string,
  now: number,
): number | null {
  if (schedules.length === 0) return null;
  let next: number | null = null;
  try {
    const seen = new Set<string>();
    // Stepped in half days so a 23- or 25-hour day cannot be stepped over.
    for (let step = 0; step <= 16; step += 1) {
      const date = localDateIn(timezone, now + step * 12 * 60 * 60_000);
      if (seen.has(date)) continue;
      seen.add(date);
      for (const schedule of schedules) {
        const at = instantOf(timezone, date, schedule.at);
        if (at === null || at <= now) continue;
        if (schedule.days !== undefined && !schedule.days.includes(dayOfWeekIn(timezone, at))) continue;
        if (next === null || at < next) next = at;
      }
    }
  } catch {
    return null;
  }
  return next;
}
