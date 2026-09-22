import { describe, expect, it } from 'vitest';
import { DECISION_MODEL, type Decider, type Questions } from '../src/ai/decide/decider.js';
import {
  ACT_CONFIDENCE_MIN,
  CALIBRATED_AGAINST,
  COVERING_ACTION_QUESTION,
  INTENT_QUESTION,
  LOCK_ACTION_QUESTION,
  NEGATIVE_NOUL_MAX,
  NONE_OF_THESE,
  PLAYBACK_ACTION_QUESTION,
  POSITIVE_NOUL_MIN,
  SCOPE_QUESTION,
  SWITCH_ACTION_QUESTION,
  deviceQuestion,
  roomQuestion,
  routeQuestion,
} from '../src/ai/decide/questions.js';
import { decideHomeCommand } from '../src/ai/decide/home-command.js';

/**
 * The wording is the contract, and the thresholds are only meaningful beside
 * the model they were set against — so both are pinned here.
 *
 * `test/voice-prompts.test.ts`'s precedent: the way this regresses is somebody
 * flattening a question into prose, inlining one at a call site, or bumping
 * the model and leaving the numbers behind.
 */

describe('the questions themselves', () => {
  it('names the model the thresholds were calibrated against', () => {
    // Calibration does not transfer between models. If these ever differ, the
    // numbers below are about a model nobody measured.
    expect(CALIBRATED_AGAINST).toBe(DECISION_MODEL);
  });

  it('gives every closed question a no-match answer', () => {
    // Without one, an unrelated sentence has to be forced into the nearest
    // box — which is how "who won the World Series" becomes a device command.
    expect(Object.keys(INTENT_QUESTION.criteria)).toContain('other');
    for (const question of [
      SWITCH_ACTION_QUESTION,
      COVERING_ACTION_QUESTION,
      LOCK_ACTION_QUESTION,
      PLAYBACK_ACTION_QUESTION,
    ]) {
      expect(Object.keys(question.criteria)).toContain('neither');
    }
    expect(Object.keys(roomQuestion([]).criteria)).toContain(NONE_OF_THESE);
    expect(Object.keys(deviceQuestion([]).criteria)).toContain(NONE_OF_THESE);
  });

  it('states each speculative branch premise, since the branches cannot see each other', () => {
    // They are answered in parallel and none knows which one applies, so each
    // has to carry its own "suppose this is about…".
    for (const question of [
      SWITCH_ACTION_QUESTION,
      COVERING_ACTION_QUESTION,
      LOCK_ACTION_QUESTION,
      PLAYBACK_ACTION_QUESTION,
    ]) {
      expect(question.instructions.toLowerCase()).toContain('suppose this request is about');
    }
  });

  it('offers no action that needs a number read out of the sentence', () => {
    // The sharpest guard in the file: this model is not a calculator, so it is
    // never asked for a quantity and there is never one to get wrong.
    const actions = [
      SWITCH_ACTION_QUESTION,
      COVERING_ACTION_QUESTION,
      LOCK_ACTION_QUESTION,
      PLAYBACK_ACTION_QUESTION,
    ].flatMap((question) => Object.keys(question.criteria));
    for (const action of actions) expect(action).not.toMatch(/percent|degree|level|set_/);
  });

  it('builds the routing question from the registry rather than from a list here', () => {
    const built = routeQuestion([
      { key: 'automations', decisionCriterion: 'Rules the home runs by itself.' },
      { key: 'invented', decisionCriterion: 'Something a later build added.' },
    ]);
    expect(Object.keys(built.criteria)).toEqual(['here', 'automations', 'invented']);
  });

  it('keeps the gates where a skip-ahead is safe', () => {
    // High on purpose: too high costs a little latency, too low costs
    // somebody's lamp.
    expect(ACT_CONFIDENCE_MIN).toBeGreaterThanOrEqual(0.8);
    expect(POSITIVE_NOUL_MIN).toBeGreaterThanOrEqual(0.8);
    // And the negative gate is *not* near zero: a noul on this model has a
    // documented floor, so a cut at 0.15 would refuse everything and the
    // feature would silently never fire.
    expect(NEGATIVE_NOUL_MAX).toBeGreaterThan(0.15);
    expect(NEGATIVE_NOUL_MAX).toBeLessThan(0.5);
  });

  it('names rooms and devices by id, so an answer needs no second lookup', () => {
    const rooms = roomQuestion([{ id: 'room-1', name: 'Kitchen' }]);
    expect(Object.keys(rooms.criteria)).toEqual(['room-1', NONE_OF_THESE]);
    const devices = deviceQuestion([{ id: 'dev-1', name: 'Kettle', roomName: 'Kitchen' }]);
    expect(devices.criteria['dev-1']).toContain('Kettle');
    expect(devices.criteria['dev-1']).toContain('Kitchen');
  });
});

/* ------------------------------------------------------------------ */

const HOME = {
  rooms: [{ id: 'kitchen', name: 'Kitchen' }],
  devices: [
    {
      id: 'lamp',
      name: 'Kitchen light',
      roomId: 'kitchen',
      endpoints: [{ endpointId: 1, capabilities: ['onOff' as const, 'level' as const] }],
    },
    {
      id: 'door',
      name: 'Front door',
      roomId: 'kitchen',
      endpoints: [{ endpointId: 1, capabilities: ['doorLock' as const] }],
    },
  ],
};

const DELEGATES = [{ key: 'automations', decisionCriterion: 'Rules the home runs by itself.' }];

const choice = (value: string, confidence: number) => ({
  type: 'choice' as const,
  choice: value,
  probabilities: { [value]: confidence },
  confidence,
});
const noul = (value: number) => ({ type: 'noul' as const, noul: value });

/** A decider that answers exactly what a case needs, and records the ask. */
function decider(answers: Record<string, unknown>): Decider & { asked: Questions[] } {
  const asked: Questions[] = [];
  return {
    modelId: DECISION_MODEL,
    asked,
    decide: async (input) => {
      asked.push(input.questions);
      return {
        answers: answers as never,
        costUsd: 0.00002,
        modelId: DECISION_MODEL,
        durationMs: 180,
      };
    },
  };
}

/** Everything a plain "switch the kitchen light off" answers. */
const CONFIDENT_OFF = {
  intent: choice('device_command', 0.99),
  multiple: noul(0.03),
  needsValue: noul(0.05),
  scope: choice('specific_device', 0.98),
  room: choice('kitchen', 0.97),
  device: choice('lamp', 0.96),
  switchAction: choice('turn_off', 0.97),
  route: choice('here', 0.99),
  selfContained: noul(0.9),
};

describe('reading a sentence against a home', () => {
  it('asks everything in one request', async () => {
    // Latency is roughly flat in question count and concurrent requests queue,
    // so a second request would cost more than every question in this one.
    const stub = decider(CONFIDENT_OFF);
    await decideHomeCommand({ decider: stub, home: HOME, delegates: DELEGATES, said: 'lights off' });
    expect(stub.asked).toHaveLength(1);
    expect(Object.keys(stub.asked[0] ?? {})).toEqual([
      'intent',
      'multiple',
      'needsValue',
      'scope',
      'room',
      'device',
      'switchAction',
      'coveringAction',
      'lockAction',
      'playbackAction',
      'route',
      'selfContained',
      'effort',
    ]);
  });

  it('resolves a confident single command', async () => {
    const result = await decideHomeCommand({
      decider: decider(CONFIDENT_OFF),
      home: HOME,
      delegates: DELEGATES,
      said: 'switch the kitchen light off',
    });
    expect(result.kind).toBe('command');
    if (result.kind !== 'command') return;
    expect(result.command.deviceId).toBe('lamp');
    expect(result.command.endpointId).toBe(1);
    expect(result.command.command).toEqual({ type: 'power', on: false });
  });

  it('reads the branch the device selects, not the one the sentence sounded like', async () => {
    // Every branch is answered blind. What settles which one applies is what
    // the resolved device can actually do — so a lock is never "turned off".
    const result = await decideHomeCommand({
      decider: decider({
        ...CONFIDENT_OFF,
        device: choice('door', 0.96),
        switchAction: choice('turn_off', 0.99),
        lockAction: choice('lock', 0.95),
      }),
      home: HOME,
      delegates: DELEGATES,
      said: 'lock the front door',
    });
    expect(result.kind).toBe('command');
    if (result.kind !== 'command') return;
    expect(result.command.command).toEqual({ type: 'lock', engage: true });
  });

  const standsDown: [string, Record<string, unknown>][] = [
    ['the sentence carries a number', { needsValue: noul(0.9) }],
    ['it asked for more than one thing', { multiple: noul(0.9) }],
    ['it is about a whole room', { scope: choice('room', 0.99) }],
    ['it is about the whole home', { scope: choice('whole_home', 0.99) }],
    ['no device was picked out', { device: choice(NONE_OF_THESE, 0.99) }],
    ['the device is a guess', { device: choice('lamp', 0.5) }],
    ['the action is a guess', { switchAction: choice('turn_off', 0.5) }],
    ['the intent is a guess', { intent: choice('device_command', 0.4) }],
    ['it is a question rather than a command', { intent: choice('home_question', 0.99) }],
    ['it is about something else entirely', { intent: choice('other', 0.99) }],
  ];
  for (const [why, override] of standsDown) {
    it(`stands down when ${why}`, async () => {
      const result = await decideHomeCommand({
        decider: decider({ ...CONFIDENT_OFF, ...override }),
        home: HOME,
        delegates: DELEGATES,
        said: 'something',
      });
      expect(result.kind).toBe('none');
    });
  }

  it('stands down when the decider had no answer at all', async () => {
    const silent: Decider = { modelId: DECISION_MODEL, decide: async () => null };
    const result = await decideHomeCommand({
      decider: silent,
      home: HOME,
      delegates: DELEGATES,
      said: 'switch the kitchen light off',
    });
    expect(result).toEqual({ kind: 'none', costUsd: 0, effort: undefined });
  });

  it('stands down on a home too big to offer as options', async () => {
    // A long option list is a long state, and accuracy falls as the state
    // grows — so past the bound this guesses in nothing.
    const crowded = {
      rooms: HOME.rooms,
      devices: Array.from({ length: 400 }, (_, index) => ({
        id: `dev-${index}`,
        name: `Device ${index}`,
        roomId: 'kitchen',
        endpoints: [{ endpointId: 1, capabilities: ['onOff' as const] }],
      })),
    };
    const stub = decider(CONFIDENT_OFF);
    const result = await decideHomeCommand({
      decider: stub,
      home: crowded,
      delegates: DELEGATES,
      said: 'lights off',
    });
    expect(result.kind).toBe('none');
    expect(stub.asked).toHaveLength(0);
  });

  it('routes a confident, self-contained automation request', async () => {
    const result = await decideHomeCommand({
      decider: decider({
        ...CONFIDENT_OFF,
        intent: choice('automation_work', 0.98),
        route: choice('automations', 0.97),
        selfContained: noul(0.93),
      }),
      home: HOME,
      delegates: DELEGATES,
      said: 'turn the hall light on every night at eleven',
    });
    expect(result.kind).toBe('route');
    if (result.kind !== 'route') return;
    expect(result.agentKey).toBe('automations');
  });

  it('does not route a sentence that means nothing on its own', async () => {
    // "Make it half past instead" is a perfectly good follow-up and a useless
    // brief — which is the one thing a fast route gives up, and this catches.
    const result = await decideHomeCommand({
      decider: decider({
        ...CONFIDENT_OFF,
        intent: choice('automation_work', 0.98),
        route: choice('automations', 0.97),
        selfContained: noul(0.3),
      }),
      home: HOME,
      delegates: DELEGATES,
      said: 'make it half past instead',
    });
    expect(result.kind).toBe('none');
  });

  it('never asks for more thinking, only less', async () => {
    const easy = await decideHomeCommand({
      decider: decider({
        ...CONFIDENT_OFF,
        effort: { type: 'score', score: 0.1, legend: {}, probabilities: {}, confidence: 0.95 },
      }),
      home: HOME,
      delegates: DELEGATES,
      said: 'lights off',
    });
    expect(easy.effort).toBe('low');

    const hard = await decideHomeCommand({
      decider: decider({
        ...CONFIDENT_OFF,
        effort: { type: 'score', score: 2, legend: {}, probabilities: {}, confidence: 0.99 },
      }),
      home: HOME,
      delegates: DELEGATES,
      said: 'lights off',
    });
    // Not "high" — there is no such answer to give.
    expect(hard.effort).toBeUndefined();
  });
});
