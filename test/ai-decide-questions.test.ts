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
import {
  OPTION_WORDS,
  decideHomeCommand,
  describeStandDown,
  type StandDown,
} from '../src/ai/decide/home-command.js';

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
function decider(
  answers: Record<string, unknown>,
): Decider & { asked: Questions[]; states: unknown[] } {
  const asked: Questions[] = [];
  const states: unknown[] = [];
  return {
    modelId: DECISION_MODEL,
    asked,
    states,
    decide: async (input) => {
      asked.push(input.questions);
      states.push(input.state);
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

  /**
   * Every gate, and **the reason it gives**. A stand-down used to be a bare
   * `none`, so "why was that not instant?" had no answer short of replaying
   * the sentence by hand; the question and the reason are what the log line
   * and the trail step are drawn from, so they are pinned here with the gate.
   */
  const standsDown: [string, Record<string, unknown>, StandDown['question'], StandDown['reason']][] = [
    ['the sentence carries a number', { needsValue: noul(0.9) }, 'needsValue', 'blocked'],
    ['it asked for more than one thing', { multiple: noul(0.9) }, 'multiple', 'blocked'],
    ['it is about a whole room', { scope: choice('room', 0.99) }, 'scope', 'blocked'],
    ['it is about the whole home', { scope: choice('whole_home', 0.99) }, 'scope', 'blocked'],
    ['the scope is a guess', { scope: choice('specific_device', 0.6) }, 'scope', 'unsure'],
    ['no device was picked out', { device: choice(NONE_OF_THESE, 0.99) }, 'device', 'blocked'],
    ['the device is a guess', { device: choice('lamp', 0.5) }, 'device', 'unsure'],
    ['the action is a guess', { switchAction: choice('turn_off', 0.5) }, 'switchAction', 'unsure'],
    ['the action is neither', { switchAction: choice('neither', 0.95) }, 'switchAction', 'blocked'],
    ['the intent is a guess', { intent: choice('device_command', 0.4) }, 'intent', 'unsure'],
    ['it is a question rather than a command', { intent: choice('home_question', 0.99) }, 'intent', 'declined'],
    ['it is about something else entirely', { intent: choice('other', 0.99) }, 'intent', 'declined'],
    ['a question it needs went unanswered', { device: undefined }, 'device', 'unanswered'],
  ];
  for (const [why, override, question, reason] of standsDown) {
    it(`stands down when ${why}, and says so`, async () => {
      const result = await decideHomeCommand({
        decider: decider({ ...CONFIDENT_OFF, ...override }),
        home: HOME,
        delegates: DELEGATES,
        said: 'something',
      });
      expect(result.kind).toBe('none');
      if (result.kind !== 'none') return;
      expect(result.standDown).toMatchObject({ question, reason });
      // The reading's own timing rides along on every one, for a log line
      // that can be set against the round that followed.
      expect(result.standDown.durationMs).toBe(180);
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
    expect(result).toEqual({
      kind: 'none',
      costUsd: 0,
      effort: undefined,
      standDown: { question: 'model', reason: 'missed' },
    });
  });

  it('passes on why nothing came back, when the decider says', async () => {
    // A timeout is the one miss with a duration worth reporting: how long the
    // turn waited for an answer that never came.
    const slow: Decider = {
      modelId: DECISION_MODEL,
      decide: async (input) => {
        input.onMiss?.('timeout');
        return null;
      },
    };
    const result = await decideHomeCommand({
      decider: slow,
      home: HOME,
      delegates: DELEGATES,
      said: 'switch the kitchen light off',
      timeoutMs: 650,
    });
    expect(result.kind === 'none' && result.standDown).toEqual({
      question: 'model',
      reason: 'missed',
      miss: 'timeout',
      durationMs: 650,
    });
  });

  it('names what it was unsure between, and the bar it missed', async () => {
    // An unsure answer is usually two answers. Naming the second is what turns
    // a bare 0.5 into a reason somebody can act on — rename one of them.
    const result = await decideHomeCommand({
      decider: {
        ...decider({
          ...CONFIDENT_OFF,
          device: {
            type: 'choice',
            choice: 'lamp',
            probabilities: { lamp: 0.52, door: 0.4, [NONE_OF_THESE]: 0.08 },
            confidence: 0.5,
          },
        }),
      },
      home: HOME,
      delegates: DELEGATES,
      said: 'turn it off',
    });
    expect(result.kind === 'none' && result.standDown).toMatchObject({
      question: 'device',
      reason: 'unsure',
      answer: 'lamp',
      label: 'Kitchen light',
      runnerUp: 'Front door',
      value: 0.5,
      min: ACT_CONFIDENCE_MIN,
    });
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
    expect(result.kind === 'none' && result.standDown).toEqual({
      question: 'home',
      reason: 'size',
      value: 400,
      max: 180,
    });
    expect(stub.asked).toHaveLength(0);
  });

  it('stands down when the room and the device disagree', async () => {
    // The two are answered blind and cannot see each other, so when both are
    // confident and they point different ways, one is wrong and nothing can
    // tell which. This is the shape a catalog gets wrong in a home with three
    // lights called Ceiling light.
    const result = await decideHomeCommand({
      decider: decider({ ...CONFIDENT_OFF, room: choice('hallway', 0.96) }),
      home: {
        rooms: [...HOME.rooms, { id: 'hallway', name: 'Hallway' }],
        devices: HOME.devices,
      },
      delegates: DELEGATES,
      said: 'turn the hallway light off',
    });
    expect(result.kind === 'none' && result.standDown).toMatchObject({
      question: 'room',
      reason: 'disagreed',
      label: 'Hallway',
      device: 'Kitchen light',
      deviceRoom: 'Kitchen',
    });
  });

  it('acts when the room abstains rather than objecting', async () => {
    // No room named, or not confident about one, is not disagreement — and a
    // device in no room cannot contradict anything.
    for (const room of [choice(NONE_OF_THESE, 0.99), choice('hallway', 0.4)]) {
      const result = await decideHomeCommand({
        decider: decider({ ...CONFIDENT_OFF, room }),
        home: HOME,
        delegates: DELEGATES,
        said: 'switch the kitchen light off',
      });
      expect(result.kind).toBe('command');
    }
  });

  it('sends the sentence as the state and nothing else', async () => {
    // Accuracy falls as the state fills with content unrelated to the
    // question, and the rooms and devices are already the criteria of their
    // own questions — putting them in the state too is a list every question
    // pays for and only two can use.
    const stub = decider(CONFIDENT_OFF);
    await decideHomeCommand({
      decider: stub,
      home: HOME,
      delegates: DELEGATES,
      said: 'switch the kitchen light off',
    });
    expect(stub.states[0]).toEqual({ said: 'switch the kitchen light off' });
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
    // And it says the handover is what fell short, rather than that the
    // sentence was not a device command — which is true and not the reason.
    expect(result.kind === 'none' && result.standDown).toMatchObject({
      question: 'selfContained',
      reason: 'unsure',
      answer: 'automations',
      value: 0.3,
      min: POSITIVE_NOUL_MIN,
    });
  });

  it('says so when the device is one it cannot work', async () => {
    // A thermostat or a sensor: there is nothing to switch, open, lock or
    // play, which is a device the assistant can still work — just not here.
    const result = await decideHomeCommand({
      decider: decider({ ...CONFIDENT_OFF, device: choice('dial', 0.97), room: choice('kitchen', 0.9) }),
      home: {
        rooms: HOME.rooms,
        devices: [
          ...HOME.devices,
          {
            id: 'dial',
            name: 'Dimmer',
            roomId: 'kitchen',
            endpoints: [{ endpointId: 1, capabilities: ['level' as const] }],
          },
        ],
      },
      delegates: DELEGATES,
      said: 'turn the dimmer off',
    });
    expect(result.kind === 'none' && result.standDown).toMatchObject({
      question: 'action',
      reason: 'blocked',
      device: 'Dimmer',
    });
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

/* ------------------------------------------------------------------ */

describe('saying why it stood down', () => {
  const base = { durationMs: 180 };

  it('names what it was unsure between, the number and the bar', () => {
    const words = describeStandDown({
      ...base,
      question: 'device',
      reason: 'unsure',
      answer: 'lamp',
      label: 'Light TV',
      runnerUp: 'Ceiling light',
      value: 0.41,
      min: ACT_CONFIDENCE_MIN,
    });
    expect(words).toEqual({
      phrase: "wasn't sure which device",
      text: "Jev wasn't sure which device",
      detail: 'Light TV or Ceiling light: 0.41, needs 0.85 · 180 ms',
      audience: 'shown',
    });
  });

  it('says what a yes/no was the probability of, so the number never stands alone', () => {
    const words = describeStandDown({
      ...base,
      question: 'multiple',
      reason: 'blocked',
      value: 0.9,
      max: NEGATIVE_NOUL_MAX,
    });
    expect(words.text).toBe('Jev heard more than one request');
    expect(words.detail).toBe('more than one request: 0.90, needs at most 0.40 · 180 ms');
  });

  it('names the device an unsure action was about', () => {
    const words = describeStandDown({
      ...base,
      question: 'switchAction',
      reason: 'unsure',
      answer: 'turn_on',
      label: 'turn on',
      value: 0.55,
      min: ACT_CONFIDENCE_MIN,
      device: 'Light TV',
    });
    expect(words.text).toBe("Jev wasn't sure what to do with Light TV");
    expect(words.detail).toBe('turn on: 0.55, needs 0.85 · 180 ms');
  });

  it('says where a device really is when the room it heard disagrees', () => {
    const words = describeStandDown({
      ...base,
      question: 'room',
      reason: 'disagreed',
      answer: 'kitchen',
      label: 'Kitchen',
      value: 0.96,
      device: 'Ceiling light',
      deviceRoom: 'Hallway',
    });
    expect(words.detail).toBe('Kitchen: 0.96 · Ceiling light is in Hallway · 180 ms');
  });

  it('says a timeout as a deadline, not as a reading', () => {
    const words = describeStandDown({
      question: 'model',
      reason: 'missed',
      miss: 'timeout',
      durationMs: 700,
    });
    expect(words.text).toBe("Jev didn't answer in time");
    expect(words.detail).toBe('nothing back within 700 ms');
    expect(words.audience).toBe('shown');
  });

  /**
   * **Most stand-downs are the design working**, and the trail is where a
   * person reads. A step on every question somebody asks would bury the one
   * that matters — so a sentence read confidently as not a command is logged
   * and not drawn, and a hub without Jev switched on says nothing at all.
   */
  it('keeps the ordinary ones out of the trail', () => {
    expect(
      describeStandDown({
        ...base,
        question: 'intent',
        reason: 'declined',
        answer: 'home_question',
        label: 'a question about the home',
        value: 0.97,
      }),
    ).toMatchObject({ phrase: 'read it as a question about the home', audience: 'logged' });
    expect(describeStandDown({ question: 'model', reason: 'missed', miss: 'off' }).audience).toBe('quiet');
    expect(describeStandDown({ question: 'home', reason: 'size', value: 0, max: 180 }).audience).toBe(
      'quiet',
    );
  });

  it('has words for every option the battery can answer', () => {
    // An option added to a question without words here would reach a trail
    // as an identifier — `specific_device: 0.62` is a sentence only its
    // author can read.
    const options = [
      INTENT_QUESTION,
      SCOPE_QUESTION,
      SWITCH_ACTION_QUESTION,
      COVERING_ACTION_QUESTION,
      LOCK_ACTION_QUESTION,
      PLAYBACK_ACTION_QUESTION,
    ].flatMap((question) => Object.keys(question.criteria));
    for (const option of [...options, 'here', NONE_OF_THESE]) {
      expect(OPTION_WORDS[option], option).toBeDefined();
    }
  });
});
