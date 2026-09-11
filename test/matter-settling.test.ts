import { describe, expect, it } from 'vitest';
import {
  CONTROLLER_START_MS,
  NODE_SETTLE_MS,
  settlingUntil,
  type SettlingPhase,
} from '../src/adapters/matter/settling.js';

/**
 * "This device is offline" against "the hub has not found it yet".
 *
 * Caught on a real hub, on video: a switch to Matter put *Needs attention · 3
 * of 4 online · 1 offline* on a dashboard for half a minute, about an
 * accessory that was about to answer. Zigbee2MQTT hands its whole device list
 * over in one retained message, so a Zigbee home is complete a second after
 * the radio is; a Matter controller opens a CASE session per node, which is
 * twenty to thirty seconds on a Zero 2 W — and the devices come back from the
 * database with the `online: false` they were given when Matter was last
 * switched off.
 *
 * The rule lives in its own module because reading it through `adapter.ts`
 * would load `@matter/main`, by far the largest thing in the graph. Both apps
 * draw every Matter device off the answer, so it is worth a test that can run.
 */

const now = 1_800_000_000_000;

function phase(overrides: Partial<SettlingPhase> = {}): SettlingPhase {
  return {
    startingAt: 0,
    startedAt: 0,
    commissioned: [],
    connected: new Set<string>(),
    ...overrides,
  };
}

describe('a controller that has not started yet', () => {
  it('says nothing before the adapter has even been asked to run', () => {
    // Matter is off, or the hub is still building the adapter. There is
    // nothing to be patient about, and claiming otherwise would hide a home
    // that genuinely has no Matter behind "still looking".
    expect(settlingUntil(phase(), now)).toBeUndefined();
  });

  it('says it is still looking from the moment start() is entered', () => {
    // **The case the first version of this missed.** `start()` runs after the
    // API is listening — deliberately, so matter.js opening its storage on a
    // slow card cannot hold the health check closed — so every `GET /hub` in
    // those seconds was answered by an adapter that had not begun looking,
    // reporting a settled home while `radio.matter` already said `true`.
    const until = settlingUntil(phase({ startingAt: now }), now);
    expect(until).toBe(now + CONTROLLER_START_MS + NODE_SETTLE_MS);
  });

  it('does not spend the node budget on the controller coming up', () => {
    // The two phases are bounded separately on purpose: a clock running while
    // matter.js loads is a clock counting time in which no node *could* have
    // reported in, so charging it to the nodes shortens the window they
    // actually get — on precisely the boards slow enough to need all of it.
    const starting = settlingUntil(phase({ startingAt: now }), now)!;
    expect(starting - now).toBeGreaterThan(NODE_SETTLE_MS);
  });

  it('stops making excuses for a start() that never returns', () => {
    // A bound rather than a promise, here as everywhere else in this rule: a
    // controller that is not coming must not hide a genuinely unreachable
    // device for ever, and the registry has already marked those devices
    // offline by now.
    const late = now + CONTROLLER_START_MS + NODE_SETTLE_MS;
    expect(settlingUntil(phase({ startingAt: now }), late)).toBeUndefined();
  });
});

describe('a controller that is up and reaching its nodes', () => {
  it('carries the moment it stops making excuses for a silent device', () => {
    const until = settlingUntil(
      phase({ startingAt: now - 5_000, startedAt: now, commissioned: ['1', '2'] }),
      now,
    );
    expect(until).toBe(now + NODE_SETTLE_MS);
  });

  it('is over the moment the last node connects, not when the clock runs out', () => {
    // The whole reason this is an answer rather than a timer: the controller
    // knows what it owns and what it has reached, so a hub whose devices all
    // answer in four seconds stops making excuses after four seconds.
    const reached = phase({
      startedAt: now,
      commissioned: ['1', '2'],
      connected: new Set(['1', '2']),
    });
    expect(settlingUntil(reached, now + 4_000)).toBeUndefined();

    const half = { ...reached, connected: new Set(['1']) };
    expect(settlingUntil(half, now + 4_000)).toBe(now + NODE_SETTLE_MS);
  });

  it('runs out, so a node that never answers is offline in the end', () => {
    const silent = phase({ startedAt: now, commissioned: ['1'] });
    expect(settlingUntil(silent, now + NODE_SETTLE_MS)).toBeUndefined();
  });

  it('says nothing on a hub that owns no Matter devices at all', () => {
    // A hub that has never paired an accessory must not spend its first
    // minute explaining an empty home.
    expect(settlingUntil(phase({ startedAt: now }), now)).toBeUndefined();
  });

  it('never hands back a deadline that has already passed', () => {
    // Both phases answer `undefined` rather than a stale number, because the
    // apps schedule a rebuild *at* the deadline: one in the past is a timer
    // that fires immediately, for ever.
    const past = now + NODE_SETTLE_MS + 1;
    expect(settlingUntil(phase({ startedAt: now, commissioned: ['1'] }), past)).toBeUndefined();
    expect(settlingUntil(phase({ startingAt: now }), past + CONTROLLER_START_MS)).toBeUndefined();
  });
});
