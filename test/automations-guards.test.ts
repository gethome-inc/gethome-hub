import { describe, expect, it } from 'vitest';
import { emptyState, type EndpointState } from '../src/schema/index.js';
import {
  AutomationGuards,
  DEFAULT_GUARD_LIMITS,
  wouldChangeNothing,
} from '../src/automations/guards.js';
import {
  compare,
  evaluateEdge,
  readPath,
  timeOfDayIn,
  withinTimeRange,
  type EdgeState,
} from '../src/automations/evaluate.js';

/**
 * The safety half of the engine, tested with no bus, no database and no
 * radio — every decision here is a pure function of a value and a clock, and
 * keeping it that way is what makes a day of a home's behaviour checkable in
 * a millisecond.
 */

const origin = { automationId: 'a', runId: 'r', depth: 0 };

function state(patch: Partial<EndpointState>): EndpointState {
  return { ...emptyState(), ...patch };
}

// ── Idempotence ──────────────────────────────────────────────────────────────

describe('a command that would change nothing', () => {
  it('is recognised for every command that has a resting state', () => {
    expect(wouldChangeNothing({ type: 'power', on: true }, state({ onOff: true }))).toBe(true);
    expect(wouldChangeNothing({ type: 'power', on: true }, state({ onOff: false }))).toBe(false);
    expect(
      wouldChangeNothing({ type: 'setLevel', level: 128 }, state({ level: { current: 128, min: 1, max: 254 } })),
    ).toBe(true);
    expect(wouldChangeNothing({ type: 'lock', engage: true }, state({ lock: 1 }))).toBe(true);
    expect(wouldChangeNothing({ type: 'lock', engage: false }, state({ lock: 1 }))).toBe(false);
    expect(
      wouldChangeNothing(
        { type: 'openCovering' },
        state({ covering: { currentPositionLiftPercent100ths: 0, isMoving: false } }),
      ),
    ).toBe(true);
    expect(
      wouldChangeNothing(
        { type: 'closeCovering' },
        state({ covering: { currentPositionLiftPercent100ths: 0, isMoving: false } }),
      ),
    ).toBe(false);
  });

  it('never claims it about the three commands with no resting state', () => {
    // `toggle` is defined by what it does, `stopCovering` is an interrupt and
    // `irSend` is a transmission with nothing behind it.
    expect(wouldChangeNothing({ type: 'toggle' }, state({ onOff: true }))).toBe(false);
    expect(
      wouldChangeNothing(
        { type: 'stopCovering' },
        state({ covering: { currentPositionLiftPercent100ths: 5_000, isMoving: true } }),
      ),
    ).toBe(false);
    expect(wouldChangeNothing({ type: 'irSend', commandId: 'x' }, state({}))).toBe(false);
  });

  it('sends when the device has never reported the thing being written', () => {
    // Silence is not evidence. A device that has said nothing about its own
    // level must still receive the command.
    expect(wouldChangeNothing({ type: 'setLevel', level: 10 }, state({}))).toBe(false);
    expect(wouldChangeNothing({ type: 'power', on: true }, undefined)).toBe(false);
  });
});

// ── The five layers ──────────────────────────────────────────────────────────

describe('device guards', () => {
  it('drops a command that would leave the device where it is', () => {
    const guards = new AutomationGuards(() => 1_000);
    const verdict = guards.admit('d', 1, { type: 'power', on: true }, state({ onOff: true }), origin);
    expect(verdict?.kind).toBe('unchanged');
  });

  it('holds a minimum gap between two commands to one endpoint', () => {
    let now = 1_000;
    const guards = new AutomationGuards(() => now);

    expect(guards.admit('d', 1, { type: 'toggle' }, undefined, origin)).toBeNull();
    guards.record('d', 1, origin);

    now += 500;
    // A relay rated for 100 000 operations switched once a second is dead
    // within a day and a half.
    expect(guards.admit('d', 1, { type: 'toggle' }, undefined, origin)?.kind).toBe('too_soon');

    now += DEFAULT_GUARD_LIMITS.minCommandIntervalMs;
    expect(guards.admit('d', 1, { type: 'toggle' }, undefined, origin)).toBeNull();
  });

  it('keeps a separate gap per endpoint', () => {
    const guards = new AutomationGuards(() => 1_000);
    guards.record('d', 1, origin);
    // Endpoint 2 of a two-gang switch is a different relay.
    expect(guards.admit('d', 2, { type: 'toggle' }, undefined, origin)).toBeNull();
  });

  it('stops at an hourly budget and again at a daily one', () => {
    let now = 0;
    const guards = new AutomationGuards(() => now);
    for (let index = 0; index < DEFAULT_GUARD_LIMITS.maxCommandsPerHour; index += 1) {
      now += DEFAULT_GUARD_LIMITS.minCommandIntervalMs;
      expect(guards.admit('d', 1, { type: 'toggle' }, undefined, origin)).toBeNull();
      guards.record('d', 1, origin);
    }
    now += DEFAULT_GUARD_LIMITS.minCommandIntervalMs;
    expect(guards.admit('d', 1, { type: 'toggle' }, undefined, origin)?.kind).toBe('hourly_budget');

    // An hour later the window has rolled and the device is workable again.
    now += 60 * 60_000;
    expect(guards.admit('d', 1, { type: 'toggle' }, undefined, origin)).toBeNull();
  });

  it('refuses a command too far down a chain of automations', () => {
    const guards = new AutomationGuards(() => 1_000);
    const deep = { ...origin, depth: DEFAULT_GUARD_LIMITS.maxCausationDepth + 1 };
    expect(guards.admit('d', 1, { type: 'toggle' }, undefined, deep)?.kind).toBe('too_deep');
  });
});

// ── Causation ────────────────────────────────────────────────────────────────

describe('working out who caused a state change', () => {
  it('remembers our own command briefly, and forgets it after the window', () => {
    let now = 10_000;
    const guards = new AutomationGuards(() => now);
    guards.record('d', 1, { automationId: 'night', runId: 'r1', depth: 0 });

    expect(guards.causeOf('d', 1)?.automationId).toBe('night');

    now += DEFAULT_GUARD_LIMITS.causationWindowMs + 1;
    // A change a minute later is nobody's fault, which is what lets a person
    // flipping a wall switch start a rule at depth 0.
    expect(guards.causeOf('d', 1)).toBeNull();
  });

  it('says nothing about a device no automation has written to', () => {
    const guards = new AutomationGuards(() => 1_000);
    expect(guards.causeOf('untouched', 1)).toBeNull();
  });
});

// ── The circuit breaker ──────────────────────────────────────────────────────

describe('the runaway breaker', () => {
  it('lets an ordinary rule run and stops one that has run away', () => {
    let now = 0;
    const guards = new AutomationGuards(() => now);

    for (let index = 0; index < DEFAULT_GUARD_LIMITS.runawayRuns; index += 1) {
      now += 1_000;
      expect(guards.noteRun('rule').runaway).toBe(false);
    }
    now += 1_000;
    const verdict = guards.noteRun('rule');
    expect(verdict.runaway).toBe(true);
    expect(verdict.detail).toContain('switched off');
  });

  it('counts inside a rolling window, so a rule that fires all day is fine', () => {
    let now = 0;
    const guards = new AutomationGuards(() => now);
    for (let index = 0; index < DEFAULT_GUARD_LIMITS.runawayRuns * 3; index += 1) {
      now += DEFAULT_GUARD_LIMITS.runawayWindowMs;
      expect(guards.noteRun('rule').runaway).toBe(false);
    }
  });

  it('counts per rule, not per home', () => {
    let now = 0;
    const guards = new AutomationGuards(() => now);
    for (let index = 0; index <= DEFAULT_GUARD_LIMITS.runawayRuns; index += 1) {
      now += 1_000;
      guards.noteRun('noisy');
    }
    expect(guards.noteRun('quiet').runaway).toBe(false);
  });
});

// ── Reading and comparing ────────────────────────────────────────────────────

describe('reading a canonical path', () => {
  it('walks the dotted path rather than keeping a second copy of the list', () => {
    const reading = state({
      onOff: true,
      sensors: { temperatureCenti: 2_150, occupied: false },
      power: { activeMilliwatts: 4_200 },
    });
    expect(readPath(reading, 'onOff')).toBe(true);
    expect(readPath(reading, 'sensors.temperatureCenti')).toBe(2_150);
    expect(readPath(reading, 'sensors.occupied')).toBe(false);
    expect(readPath(reading, 'power.activeMilliwatts')).toBe(4_200);
    expect(readPath(reading, 'battery.percent')).toBeUndefined();
  });

  it('answers no to every question about a value nobody has reported', () => {
    // Including `ne`: saying "it is not 5" about a value never seen would let
    // a rule fire on ignorance.
    expect(compare(undefined, 'ne', 5)).toBe(false);
    expect(compare(undefined, 'eq', 5)).toBe(false);
    expect(compare(undefined, 'lt', 5)).toBe(false);
  });
});

// ── Edge triggering ──────────────────────────────────────────────────────────

describe('edge triggering', () => {
  const cross = (previous: EdgeState | undefined, value: number, hysteresis?: number) =>
    evaluateEdge(previous, value, 'lt', 15, hysteresis);

  it('says nothing the first time it looks', () => {
    // A hub that has just restarted has watched no transitions, so it
    // announces none — otherwise every flat battery in the house is
    // re-announced on every boot.
    const first = cross(undefined, 12);
    expect(first.fires).toBe(false);
    expect(first.next.latched).toBe(true);
  });

  it('fires once on the crossing and stays quiet while it holds', () => {
    let edge = cross(undefined, 40).next;
    expect(cross(edge, 30).fires).toBe(false);
    edge = cross(edge, 30).next;

    const crossing = cross(edge, 12);
    expect(crossing.fires).toBe(true);
    edge = crossing.next;

    // A battery at 12% reports every hour for a month and says nothing more.
    for (const reading of [12, 11, 10, 9]) {
      const outcome = cross(edge, reading);
      expect(outcome.fires).toBe(false);
      edge = outcome.next;
    }
  });

  it('re-arms once the test stops holding', () => {
    let edge = cross(undefined, 40).next;
    edge = cross(edge, 12).next;
    edge = cross(edge, 40).next;
    expect(cross(edge, 12).fires).toBe(true);
  });

  it('will not re-arm inside a hysteresis band', () => {
    // The case an edge alone does nothing about: a reading resting on the
    // threshold crosses it every time it wobbles, and every crossing is a
    // real edge.
    let edge = cross(undefined, 40, 5).next;
    edge = cross(edge, 14, 5).next; // fires
    edge = cross(edge, 16, 5).next; // above the line but inside the band
    expect(cross(edge, 14, 5).fires).toBe(false);

    edge = cross(edge, 25, 5).next; // out past the band — re-armed
    expect(cross(edge, 14, 5).fires).toBe(true);
  });

  it('fires on every move for "changed", after the first sighting', () => {
    let edge = evaluateEdge(undefined, 1, 'changed', undefined, undefined).next;
    expect(evaluateEdge(edge, 2, 'changed', undefined, undefined).fires).toBe(true);
    edge = evaluateEdge(edge, 2, 'changed', undefined, undefined).next;
    expect(evaluateEdge(edge, 2, 'changed', undefined, undefined).fires).toBe(false);
  });
});

// ── Time ─────────────────────────────────────────────────────────────────────

describe('time of day', () => {
  it('reads the clock in the home’s own timezone', () => {
    const noonUtc = Date.UTC(2026, 5, 15, 12, 0, 0);
    expect(timeOfDayIn('UTC', noonUtc)).toBe('12:00');
    expect(timeOfDayIn('Europe/Moscow', noonUtc)).toBe('15:00');
    expect(timeOfDayIn('America/Los_Angeles', noonUtc)).toBe('05:00');
  });

  it('renders midnight as 00:00 rather than 24:00', () => {
    // `hour12: false` gives "24" in several locales, which would make a
    // schedule at midnight unreachable for ever.
    expect(timeOfDayIn('UTC', Date.UTC(2026, 5, 15, 0, 30, 0))).toBe('00:30');
  });

  it('treats a window that ends before it starts as one night', () => {
    expect(withinTimeRange('23:30', '22:00', '06:00')).toBe(true);
    expect(withinTimeRange('02:00', '22:00', '06:00')).toBe(true);
    expect(withinTimeRange('12:00', '22:00', '06:00')).toBe(false);
    expect(withinTimeRange('12:00', '09:00', '17:00')).toBe(true);
    expect(withinTimeRange('18:00', '09:00', '17:00')).toBe(false);
  });
});
