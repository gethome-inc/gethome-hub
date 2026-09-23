import { describe, expect, it } from 'vitest';
import { DECISION_MODEL, type Decider, type Questions } from '../src/ai/decide/decider.js';
import {
  ACT_CONFIDENCE_MIN,
  CALIBRATED_AGAINST,
  DECISION_TIMEOUT_MS,
  FAMILIES,
  MAX_COMMANDS,
  MAX_PARTS,
  NEGATIVE_NOUL_MAX,
  NONE_OF_THESE,
  NOT_SAID,
  POSITIVE_NOUL_MIN,
  SPLIT_NOUL_MIN,
  UNCHANGED,
  WHOLE_HOME,
  amountField,
  amountIn,
  amountQuestion,
  deviceQuestion,
  deviceTypeQuestion,
  familyQuestion,
  intentQuestion,
  multipleQuestion,
  placeQuestion,
  routeQuestion,
  scopeQuestion,
} from '../src/ai/decide/questions.js';
import {
  OPTION_WORDS,
  decideHomeCommand,
  decideParts,
  describeStandDown,
  participle,
  phrase,
  type DecidableDevice,
  type DecidableHome,
  type HomeDecision,
} from '../src/ai/decide/home-command.js';
import { emptyState, type EndpointState } from '../src/schema/index.js';

/**
 * The wording is the contract, and the thresholds are only meaningful beside
 * the model they were set against — so both are pinned here, and so is every
 * rule about what a reading may and may not turn into.
 *
 * `test/voice-prompts.test.ts`'s precedent: the way this regresses is somebody
 * flattening a question into prose, inlining one at a call site, or bumping
 * the model and leaving the numbers behind.
 */

/* ------------------------------------------------------------------ *
 * The home every case below reads against.
 * ------------------------------------------------------------------ */

const DEVICES: DecidableDevice[] = [
  // d1
  {
    id: 'kitchen-light',
    name: 'Kitchen light',
    roomId: 'kitchen',
    endpoints: [{ endpointId: 1, deviceKind: 'light', capabilities: ['onOff', 'level', 'colorTemperature'] }],
  },
  // d2
  {
    id: 'spots',
    name: 'Spots',
    roomId: 'kitchen',
    endpoints: [{ endpointId: 1, deviceKind: 'light', capabilities: ['onOff'] }],
  },
  // d3
  {
    id: 'tv-light',
    name: 'Light TV',
    roomId: 'living',
    endpoints: [{ endpointId: 1, deviceKind: 'light', capabilities: ['onOff', 'level', 'color'] }],
  },
  // d4
  {
    id: 'tv',
    name: 'TV',
    roomId: 'living',
    endpoints: [{ endpointId: 1, deviceKind: 'tv', capabilities: ['onOff', 'mediaPlayback'] }],
  },
  // d5
  {
    id: 'blind',
    name: 'Blind',
    roomId: 'living',
    endpoints: [{ endpointId: 1, deviceKind: 'shade', capabilities: ['windowCovering'] }],
  },
  // d6 — reports nothing yet, for the requests that need to know where it is now.
  {
    id: 'lamp',
    name: 'Bedside lamp',
    roomId: 'bedroom',
    endpoints: [{ endpointId: 1, deviceKind: 'light', capabilities: ['onOff', 'level'] }],
  },
  // d7 — in no room at all.
  {
    id: 'door',
    name: 'Front door',
    roomId: null,
    endpoints: [{ endpointId: 1, deviceKind: 'lock', capabilities: ['doorLock'] }],
  },
  // d8
  {
    id: 'thermostat',
    name: 'Thermostat',
    roomId: 'living',
    endpoints: [{ endpointId: 1, deviceKind: 'climate', capabilities: ['thermostat'] }],
  },
  // d9
  {
    id: 'fan',
    name: 'Ceiling fan',
    roomId: 'bedroom',
    endpoints: [{ endpointId: 1, deviceKind: 'fan', capabilities: ['onOff', 'fan'] }],
  },
  // d10 — a fridge on a plug, which "everything" must never reach.
  {
    id: 'plug',
    name: 'Fridge plug',
    roomId: 'kitchen',
    endpoints: [{ endpointId: 1, deviceKind: 'outlet', capabilities: ['onOff'] }],
  },
];

const STATES: Record<string, EndpointState> = {
  'kitchen-light': {
    ...emptyState(),
    onOff: false,
    level: { current: 100, min: 1, max: 254 },
    colorTemperature: { mireds: 300, minMireds: 153, maxMireds: 333 },
  },
  spots: { ...emptyState(), onOff: true },
  'tv-light': { ...emptyState(), onOff: true, level: { current: 200, min: 1, max: 254 } },
  tv: { ...emptyState(), onOff: true, playbackPlaying: true },
  blind: {
    ...emptyState(),
    covering: { currentPositionLiftPercent100ths: 0, isMoving: false },
  },
  thermostat: {
    ...emptyState(),
    thermostat: {
      occupiedHeatingSetpointCenti: 2000,
      occupiedCoolingSetpointCenti: 2400,
      heatSetpointMinCenti: 700,
      heatSetpointMaxCenti: 3000,
      coolSetpointMinCenti: 1600,
      coolSetpointMaxCenti: 3200,
      systemMode: 4,
    },
  },
  fan: { ...emptyState(), onOff: true, fan: { mode: 2, percentCurrent: 50 } },
  plug: { ...emptyState(), onOff: true },
};

function homeWith(input: {
  devices?: DecidableDevice[];
  states?: Record<string, EndpointState>;
} = {}): DecidableHome {
  const states = { ...STATES, ...input.states };
  return {
    rooms: [
      { id: 'kitchen', name: 'Kitchen', zoneId: 'down' },
      { id: 'living', name: 'Living room', zoneId: 'down' },
      { id: 'bedroom', name: 'Bedroom', zoneId: 'up' },
    ],
    zones: [
      { id: 'down', name: 'Downstairs' },
      { id: 'up', name: 'Upstairs' },
    ],
    devices: input.devices ?? DEVICES,
    stateOf: (deviceId) => states[deviceId],
  };
}

const HOME = homeWith();

const DELEGATES = [
  { key: 'automations', title: 'automations agent', decisionCriterion: 'Rules the home runs by itself.' },
];

/* ------------------------------------------------------------------ *
 * Answers.
 * ------------------------------------------------------------------ */

const choice = (value: string, confidence = 0.97, probabilities?: Record<string, number>) => ({
  type: 'choice' as const,
  choice: value,
  probabilities: probabilities ?? { [value]: confidence },
  confidence,
});
const noul = (value: number) => ({ type: 'noul' as const, noul: value });
const score = (value: number, confidence: number) => ({
  type: 'score' as const,
  score: value,
  legend: {},
  probabilities: {},
  confidence,
});

/** Every action family, answered "not this". */
const UNCHANGED_ALL = Object.fromEntries(FAMILIES.map((family) => [family, choice(UNCHANGED)]));

/** Everything a plain "turn off the kitchen light" answers. */
const OFF_KITCHEN_LIGHT: Record<string, unknown> = {
  intent: choice('device_command', 0.98),
  later: noul(0.2),
  negated: noul(0.2),
  scope: choice('one_device', 0.97),
  place: choice('r1', 0.95),
  deviceType: choice('lights', 0.9),
  device: choice('d1', 0.96),
  ...UNCHANGED_ALL,
  power: choice('off', 0.97),
  multiple: noul(0.25),
  anyCommand: noul(0.95),
  route: choice('here', 0.99),
  selfContained: noul(0.9),
};

/** A group request: every light in one place, switched off. */
const OFF_LIGHTS_IN = (place: string): Record<string, unknown> => ({
  ...OFF_KITCHEN_LIGHT,
  scope: choice('group', 0.95),
  place: choice(place, 0.95),
  deviceType: choice('lights', 0.95),
  device: choice(NONE_OF_THESE, 0.9),
});

/** A decider that answers exactly what a case needs, and records the ask. */
function decider(
  answers: Record<string, unknown>,
  extra: { newConnection?: boolean; requestId?: string } = {},
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
        ...extra,
      };
    },
  };
}

async function read(
  answers: Record<string, unknown>,
  said = 'something',
  home: DecidableHome = HOME,
): Promise<HomeDecision> {
  return decideHomeCommand({ decider: decider(answers), home, delegates: DELEGATES, said });
}

/** The plan a reading acted on, or a failed expectation saying what it did instead. */
function planOf(decision: HomeDecision) {
  if (decision.kind !== 'act') {
    throw new Error(`expected a plan, got ${JSON.stringify(decision)}`);
  }
  return decision.plan;
}

function standDownOf(decision: HomeDecision) {
  if (decision.kind !== 'none') {
    throw new Error(`expected a stand-down, got ${decision.kind}`);
  }
  return decision.standDown;
}

/** Every command a plan would send, flattened, in order. */
function commandsOf(decision: HomeDecision) {
  return planOf(decision).actions.flatMap((action) =>
    action.commands.map((entry) => ({ deviceId: action.deviceId, ...entry })),
  );
}

/* ------------------------------------------------------------------ */

describe('the questions themselves', () => {
  it('names the model the thresholds were calibrated against', () => {
    // Calibration does not transfer between models. If these ever differ, the
    // numbers below are about a model nobody measured.
    expect(CALIBRATED_AGAINST).toBe(DECISION_MODEL);
  });

  it('gives every closed question a way out', () => {
    // Without one, an unrelated sentence has to be forced into the nearest
    // box — which is how "who won the World Series" becomes a device command.
    expect(Object.keys(intentQuestion().criteria)).toContain('other');
    expect(Object.keys(scopeQuestion().criteria)).toContain('none');
    expect(Object.keys(deviceTypeQuestion().criteria)).toContain('other');
    expect(Object.keys(amountQuestion().criteria)).toContain('other');
    expect(Object.keys(placeQuestion([]).criteria)).toEqual([WHOLE_HOME, NOT_SAID]);
    expect(Object.keys(deviceQuestion([]).criteria)).toEqual([NONE_OF_THESE]);
    for (const family of FAMILIES) {
      expect(Object.keys(familyQuestion(family).criteria), family).toContain(UNCHANGED);
    }
  });

  it('states each family premise, since the families cannot see each other', () => {
    // They are answered in parallel and none knows which kind of device the
    // request turned out to be about, so each carries its own "suppose…".
    for (const family of FAMILIES) {
      expect(familyQuestion(family).instructions, family).toMatch(/^Suppose `said` is about/);
    }
  });

  it('says what "unchanged" looks like wherever a sentence could be misread', () => {
    // The model reads literally and the premise invites an answer: "turn off
    // the TV" read under the brightness premise has to have somewhere to go.
    for (const family of ['power', 'brightness', 'colour', 'playback', 'fan'] as const) {
      expect(familyQuestion(family).criteria[UNCHANGED], family).toMatch(/for example/);
    }
  });

  it('never asks the model to read a number, only what a number is of', () => {
    // The sharpest rule in the file: this model is not a calculator. Code
    // finds the number; the question offers kinds of number, never values.
    const kinds = Object.keys(amountQuestion().criteria);
    expect(kinds).toEqual(['brightness', 'temperature', 'fan_speed', 'time', 'name', 'other']);
    for (const kind of kinds) expect(kind).not.toMatch(/\d/);
    expect(amountQuestion().instructions).toContain('`amount`');
  });

  it('points one wording at a part of a split sentence by its path', () => {
    // The vendor's advice for several questions with similar instructions:
    // point each at its own field rather than paraphrase.
    expect(intentQuestion('parts[1]').instructions).toContain('`parts[1]`');
    expect(familyQuestion('power', 'parts[2]').instructions).toContain('`parts[2]`');
    expect(amountField('said')).toBe('amount');
    expect(amountField('parts[3]')).toBe('amounts[3]');
    expect(amountQuestion('parts[3]').instructions).toContain('`amounts[3]`');
  });

  it('tells a group from several requests in the question that splits', () => {
    // A group is one request however many devices it moves, and the split
    // prompt says the same — the two cannot be allowed to disagree.
    const multiple = multipleQuestion();
    expect(multiple.criteria?.false).toContain('all the lights');
    expect(multiple.criteria?.true).toContain('the kitchen light and the hall light');
  });

  it('reads "all the lights" with no room as the whole home, and a bare "the lights" as no place', () => {
    const place = placeQuestion([]);
    expect(place.criteria[WHOLE_HOME]).toContain('"All the lights"');
    expect(place.criteria[NOT_SAID]).toContain('"turn off the lights"');
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
    // A split sits between the two: being wrong about it is cheap both ways.
    expect(SPLIT_NOUL_MIN).toBeGreaterThan(NEGATIVE_NOUL_MAX);
    expect(SPLIT_NOUL_MIN).toBeLessThan(POSITIVE_NOUL_MIN);
  });

  it('gives a decision time to reach the vendor from a Pi, and no more', () => {
    // 700 ms was the fault a real hub's log showed: a fresh connection alone
    // is most of that from the far side of the world.
    expect(DECISION_TIMEOUT_MS).toBeGreaterThanOrEqual(1_000);
    expect(DECISION_TIMEOUT_MS).toBeLessThanOrEqual(2_000);
  });

  it('keys rooms and devices plainly and puts the name in the description', () => {
    // A key is what comes back, so it has to survive the wire whatever
    // somebody called their kitchen.
    const devices = deviceQuestion([
      { key: 'd1', name: 'Лампа "у окна"', kindWords: 'A light', roomName: 'Кухня' },
      { key: 'd2', name: 'Kettle', kindWords: 'A plug or socket' },
    ]);
    expect(Object.keys(devices.criteria)).toEqual(['d1', 'd2', NONE_OF_THESE]);
    expect(devices.criteria['d1']).toBe('"Лампа "у окна"" — a light in the Кухня.');
    expect(devices.criteria['d2']).toBe('"Kettle" — a plug or socket, in no particular room.');

    const places = placeQuestion([
      { key: 'r1', kind: 'room', name: 'Kitchen', zoneName: 'Downstairs' },
      { key: 'r2', kind: 'room', name: 'Garage' },
      { key: 'z1', kind: 'zone', name: 'Downstairs' },
    ]);
    expect(Object.keys(places.criteria)).toEqual(['r1', 'r2', 'z1', WHOLE_HOME, NOT_SAID]);
    expect(places.criteria['r1']).toBe('"Kitchen", a room in "Downstairs".');
    expect(places.criteria['z1']).toContain('every room in it');
  });
});

describe('finding a number in a sentence', () => {
  const cases: [string, { text: string; value: number } | undefined][] = [
    ['set the kitchen light to 40%', { text: '40%', value: 40 }],
    ['set the kitchen light to 40 %', { text: '40 %', value: 40 }],
    ['heating to 21.5°', { text: '21.5°', value: 21.5 }],
    ['поставь 21,5 градуса', { text: '21,5', value: 21.5 }],
    ['set it to 21 degrees', { text: '21', value: 21 }],
    // Part of a name, not a number.
    ['turn on lamp2 to 40', { text: '40', value: 40 }],
    // A year is not a brightness.
    ['what happened in 2026', undefined],
    // Two numbers are two things to tell apart, which is the model's job.
    ['from 20 to 40 percent', undefined],
    ['turn off the lights', undefined],
  ];
  for (const [said, expected] of cases) {
    it(`reads "${said}"`, () => {
      expect(amountIn(said)).toEqual(expected);
    });
  }
});

/* ------------------------------------------------------------------ */

describe('asking', () => {
  it('asks every question in one request', async () => {
    // Latency is roughly flat in question count, so a second request would
    // cost more than every question in this one — the vendor's fan-out rule.
    const stub = decider(OFF_KITCHEN_LIGHT);
    await decideHomeCommand({ decider: stub, home: HOME, delegates: DELEGATES, said: 'turn off the kitchen light' });
    expect(stub.asked).toHaveLength(1);
    expect(Object.keys(stub.asked[0] ?? {})).toEqual([
      'intent',
      'later',
      'negated',
      'scope',
      'place',
      'deviceType',
      'device',
      ...FAMILIES,
      'multiple',
      'anyCommand',
      'route',
      'selfContained',
      'effort',
    ]);
  });

  it('offers the whole home as options, under plain keys', async () => {
    const stub = decider(OFF_KITCHEN_LIGHT);
    await decideHomeCommand({ decider: stub, home: HOME, delegates: DELEGATES, said: 'turn off the kitchen light' });
    const asked = stub.asked[0] as Record<string, { criteria: Record<string, string> }>;
    expect(Object.keys(asked['device']?.criteria ?? {})).toEqual([
      ...DEVICES.map((_, index) => `d${index + 1}`),
      NONE_OF_THESE,
    ]);
    expect(asked['device']?.criteria['d1']).toBe('"Kitchen light" — a light in the Kitchen.');
    expect(asked['device']?.criteria['d7']).toBe('"Front door" — a door lock, in no particular room.');
    expect(Object.keys(asked['place']?.criteria ?? {})).toEqual(['r1', 'r2', 'r3', 'z1', 'z2', WHOLE_HOME, NOT_SAID]);
  });

  it('sends the sentence as the state and nothing else', async () => {
    // Accuracy falls as the state fills with content unrelated to the
    // question, and the rooms and devices are already the criteria of their
    // own questions.
    const stub = decider(OFF_KITCHEN_LIGHT);
    await decideHomeCommand({ decider: stub, home: HOME, delegates: DELEGATES, said: 'turn off the kitchen light' });
    expect(stub.states[0]).toEqual({ said: 'turn off the kitchen light' });
  });

  it('puts one number in the state as it was written, and asks what it is of', async () => {
    const stub = decider(OFF_KITCHEN_LIGHT);
    await decideHomeCommand({
      decider: stub,
      home: HOME,
      delegates: DELEGATES,
      said: 'set the kitchen light to 40%',
    });
    expect(stub.states[0]).toEqual({ said: 'set the kitchen light to 40%', amount: '40%' });
    expect(Object.keys(stub.asked[0] ?? {})).toContain('amount');
  });
});

/* ------------------------------------------------------------------ */

describe('one device', () => {
  it('switches off the one it was asked to', async () => {
    const decision = await read(OFF_KITCHEN_LIGHT, 'turn off the kitchen light');
    const plan = planOf(decision);
    expect(plan.actions).toEqual([
      {
        deviceId: 'kitchen-light',
        deviceName: 'Kitchen light',
        roomName: 'Kitchen',
        commands: [{ endpointId: 1, command: { type: 'power', on: false } }],
        wordings: [{ before: 'switched off', after: '' }],
      },
    ]);
    expect(plan.target).toBe('Kitchen light');
    expect(plan.plural).toBe(false);
    expect(plan.offline).toEqual([]);
    // The weakest link in the chain of answers it rests on.
    expect(plan.confidence).toBe(0.96);
    expect(phrase(plan.wordings, plan.target, plan.plural)).toBe('switched off Kitchen light');
    expect(decision.kind === 'act' && decision.durationMs).toBe(180);
  });

  it('carries the connection and the request id through, for the log line', async () => {
    const decision = await decideHomeCommand({
      decider: decider(OFF_KITCHEN_LIGHT, { newConnection: true, requestId: 'req-9' }),
      home: HOME,
      delegates: DELEGATES,
      said: 'turn off the kitchen light',
    });
    expect(decision).toMatchObject({ kind: 'act', newConnection: true, requestId: 'req-9' });
  });

  it('lets off win: switched off is the whole request', async () => {
    // "Turn off the TV" read under the playback premise says "pause", and the
    // TV light read under the brightness premise may say "dimmer".
    const decision = await read(
      {
        ...OFF_KITCHEN_LIGHT,
        device: choice('d4'),
        place: choice('r2'),
        playback: choice('pause', 0.95),
        brightness: choice('dimmer', 0.95),
      },
      'turn off the TV',
    );
    expect(commandsOf(decision)).toEqual([
      { deviceId: 'tv', endpointId: 1, command: { type: 'power', on: false } },
    ]);
  });

  it('reads the family the device selects, never the one the sentence sounded like', async () => {
    // A lock has no switch, so "off" read under the power premise is never
    // read for it: only the lock family is.
    const decision = await read(
      { ...OFF_KITCHEN_LIGHT, device: choice('d7'), power: choice('off', 0.99), lock: choice('lock', 0.95) },
      'lock the front door',
    );
    expect(commandsOf(decision)).toEqual([
      { deviceId: 'door', endpointId: 1, command: { type: 'lock', engage: true } },
    ]);
    expect(phrase(planOf(decision).wordings, 'Front door', false)).toBe('locked Front door');
  });

  it('never reads an answer given under a premise the device does not have', async () => {
    // Every family below answers something, and a thermostat has none of
    // their capabilities but its own — so only "heat" reaches it.
    const decision = await read(
      {
        ...OFF_KITCHEN_LIGHT,
        device: choice('d8'),
        place: choice('r2'),
        power: choice('off', 0.99),
        cover: choice('close', 0.95),
        climate: choice('heat', 0.95),
      },
      'put the heating on',
    );
    expect(commandsOf(decision)).toEqual([
      { deviceId: 'thermostat', endpointId: 1, command: { type: 'setSystemMode', mode: 4 } },
    ]);
  });

  describe('brightness', () => {
    it('sets a percentage it found in code, switching an off light on first', async () => {
      const decision = await read(
        {
          ...OFF_KITCHEN_LIGHT,
          power: choice(UNCHANGED),
          brightness: choice('percent', 0.95),
          amount: choice('brightness', 0.96),
        },
        'set the kitchen light to 40%',
      );
      expect(commandsOf(decision)).toEqual([
        { deviceId: 'kitchen-light', endpointId: 1, command: { type: 'power', on: true } },
        // 40% of 254, rounded — code's arithmetic, never the model's.
        { deviceId: 'kitchen-light', endpointId: 1, command: { type: 'setLevel', level: 102 } },
      ]);
      const plan = planOf(decision);
      expect(phrase(plan.wordings, plan.target, plan.plural)).toBe(
        'switched on Kitchen light and set it to 40% brightness',
      );
      expect(participle(plan.actions[0]!.wordings)).toBe('switched on and set to 40% brightness');
    });

    it('leaves a light that is already on alone', async () => {
      const decision = await read(
        {
          ...OFF_KITCHEN_LIGHT,
          device: choice('d3'),
          place: choice('r2'),
          power: choice(UNCHANGED),
          brightness: choice('percent', 0.95),
          amount: choice('brightness', 0.96),
        },
        'set the TV light to 40%',
      );
      expect(commandsOf(decision)).toEqual([
        { deviceId: 'tv-light', endpointId: 1, command: { type: 'setLevel', level: 102 } },
      ]);
    });

    it('stands down when the number is not a brightness', async () => {
      const decision = await read(
        {
          ...OFF_KITCHEN_LIGHT,
          power: choice(UNCHANGED),
          brightness: choice('percent', 0.95),
          amount: choice('time', 0.95),
        },
        'set the kitchen light to 40 in a minute',
      );
      expect(standDownOf(decision)).toMatchObject({
        question: 'amount',
        reason: 'blocked',
        label: 'a time',
        device: 'Kitchen light',
      });
    });

    it('stands down on a percentage with no number to go with it', async () => {
      const decision = await read(
        { ...OFF_KITCHEN_LIGHT, power: choice(UNCHANGED), brightness: choice('percent', 0.95) },
        'set the kitchen light to forty percent',
      );
      expect(standDownOf(decision)).toMatchObject({
        question: 'brightness',
        reason: 'blocked',
        because: 'no single number was said',
      });
    });

    it('works "brighter" out from where the light is now', async () => {
      const decision = await read(
        {
          ...OFF_KITCHEN_LIGHT,
          device: choice('d3'),
          place: choice('r2'),
          power: choice(UNCHANGED),
          brightness: choice('brighter', 0.95),
        },
        'brighter',
      );
      // 200 + a quarter of the range, held at the top of it.
      expect(commandsOf(decision)).toEqual([
        { deviceId: 'tv-light', endpointId: 1, command: { type: 'setLevel', level: 254 } },
      ]);
    });

    it('does not switch a light on to dim it', async () => {
      const decision = await read(
        { ...OFF_KITCHEN_LIGHT, power: choice(UNCHANGED), brightness: choice('dimmer', 0.95) },
        'dim the kitchen light',
      );
      expect(commandsOf(decision)).toEqual([
        { deviceId: 'kitchen-light', endpointId: 1, command: { type: 'setLevel', level: 36 } },
      ]);
    });

    it('stands down on "brighter" when how bright it is now is not known', async () => {
      const decision = await read(
        {
          ...OFF_KITCHEN_LIGHT,
          device: choice('d6'),
          place: choice('r3'),
          power: choice(UNCHANGED),
          brightness: choice('brighter', 0.95),
        },
        'make the bedside lamp brighter',
      );
      expect(standDownOf(decision)).toMatchObject({
        question: 'brightness',
        reason: 'blocked',
        because: 'how bright it is now is not known',
      });
    });
  });

  describe('colour', () => {
    it('gives a colour light a colour', async () => {
      const decision = await read(
        {
          ...OFF_KITCHEN_LIGHT,
          device: choice('d3'),
          place: choice('r2'),
          power: choice(UNCHANGED),
          colour: choice('red', 0.95),
        },
        'make the TV light red',
      );
      expect(commandsOf(decision)).toEqual([
        { deviceId: 'tv-light', endpointId: 1, command: { type: 'setHueSaturation', hue: 0, saturation: 254 } },
      ]);
      expect(phrase(planOf(decision).wordings, 'Light TV', false)).toBe('set Light TV to red');
    });

    it('holds a white inside what the light can do', async () => {
      const decision = await read(
        { ...OFF_KITCHEN_LIGHT, power: choice(UNCHANGED), colour: choice('warm_white', 0.95) },
        'warm white in the kitchen',
      );
      // 370 mireds asked for, 333 is as warm as this one goes; and it was off.
      expect(commandsOf(decision)).toEqual([
        { deviceId: 'kitchen-light', endpointId: 1, command: { type: 'power', on: true } },
        { deviceId: 'kitchen-light', endpointId: 1, command: { type: 'setColorTemperature', mireds: 333 } },
      ]);
    });

    it('stands down on a colour a white-only light cannot show', async () => {
      const decision = await read(
        { ...OFF_KITCHEN_LIGHT, power: choice(UNCHANGED), colour: choice('red', 0.95) },
        'make the kitchen light red',
      );
      expect(standDownOf(decision)).toMatchObject({
        question: 'colour',
        reason: 'blocked',
        because: 'Kitchen light cannot change colour',
      });
    });
  });

  describe('blinds, media, locks', () => {
    it('sends a blind halfway', async () => {
      const decision = await read(
        { ...OFF_KITCHEN_LIGHT, device: choice('d5'), place: choice('r2'), cover: choice('half', 0.95) },
        'blind halfway',
      );
      // 0 is fully open in these units, so halfway is 5000 either way round.
      expect(commandsOf(decision)).toEqual([
        { deviceId: 'blind', endpointId: 1, command: { type: 'setCoveringPercent', percent100ths: 5000 } },
      ]);
      expect(phrase(planOf(decision).wordings, 'Blind', false)).toBe('set Blind halfway');
    });

    it('pauses a TV without switching it off', async () => {
      const decision = await read(
        {
          ...OFF_KITCHEN_LIGHT,
          device: choice('d4'),
          place: choice('r2'),
          power: choice(UNCHANGED),
          playback: choice('pause', 0.95),
        },
        'pause the TV',
      );
      expect(commandsOf(decision)).toEqual([
        { deviceId: 'tv', endpointId: 1, command: { type: 'playPause', play: false } },
      ]);
    });

    it('unlocks one door it was asked to', async () => {
      const decision = await read(
        { ...OFF_KITCHEN_LIGHT, device: choice('d7'), lock: choice('unlock', 0.95) },
        'unlock the front door',
      );
      expect(commandsOf(decision)).toEqual([
        { deviceId: 'door', endpointId: 1, command: { type: 'lock', engage: false } },
      ]);
    });
  });

  describe('climate', () => {
    const thermostat = { ...OFF_KITCHEN_LIGHT, device: choice('d8'), place: choice('r2') };

    it('sets a temperature it found in code', async () => {
      const decision = await read(
        { ...thermostat, climate: choice('degrees', 0.95), amount: choice('temperature', 0.95) },
        'set the thermostat to 21',
      );
      expect(commandsOf(decision)).toEqual([
        { deviceId: 'thermostat', endpointId: 1, command: { type: 'setHeatingSetpoint', centi: 2100 } },
      ]);
      expect(phrase(planOf(decision).wordings, 'Thermostat', false)).toBe('set Thermostat to 21°');
    });

    it('says where "warmer" ended up', async () => {
      const decision = await read({ ...thermostat, climate: choice('warmer', 0.95) }, 'a bit warmer');
      expect(commandsOf(decision)).toEqual([
        { deviceId: 'thermostat', endpointId: 1, command: { type: 'setHeatingSetpoint', centi: 2100 } },
      ]);
      expect(phrase(planOf(decision).wordings, 'Thermostat', false)).toBe('turned Thermostat up to 21°');
    });

    it('moves the cooling setpoint while it is cooling', async () => {
      const cooling = homeWith({
        states: {
          thermostat: {
            ...STATES['thermostat']!,
            thermostat: { ...STATES['thermostat']!.thermostat!, systemMode: 3 },
          },
        },
      });
      const decision = await read({ ...thermostat, climate: choice('cooler', 0.95) }, 'cooler', cooling);
      expect(commandsOf(decision)).toEqual([
        { deviceId: 'thermostat', endpointId: 1, command: { type: 'setCoolingSetpoint', centi: 2300 } },
      ]);
    });

    it('stands down on a temperature nobody means for a room', async () => {
      const decision = await read(
        { ...thermostat, climate: choice('degrees', 0.95), amount: choice('temperature', 0.95) },
        'set the thermostat to 40',
      );
      expect(standDownOf(decision)).toMatchObject({ question: 'climate', reason: 'blocked' });
    });

    it('stands down outside what the device can be set to', async () => {
      const decision = await read(
        { ...thermostat, climate: choice('degrees', 0.95), amount: choice('temperature', 0.95) },
        'set the thermostat to 32',
      );
      expect(standDownOf(decision)).toMatchObject({
        question: 'climate',
        reason: 'blocked',
        because: '32° is outside what it can be set to',
      });
    });

    it('switches the heating off by its mode', async () => {
      const decision = await read({ ...thermostat, climate: choice('off', 0.95) }, 'heating off');
      expect(commandsOf(decision)).toEqual([
        { deviceId: 'thermostat', endpointId: 1, command: { type: 'setSystemMode', mode: 0 } },
      ]);
    });
  });

  describe('fans', () => {
    const fan = { ...OFF_KITCHEN_LIGHT, device: choice('d9'), place: choice('r3'), power: choice(UNCHANGED) };

    it('sets a speed', async () => {
      const decision = await read({ ...fan, fan: choice('high', 0.95) }, 'fan on high');
      expect(commandsOf(decision)).toEqual([
        { deviceId: 'fan', endpointId: 1, command: { type: 'setFanMode', mode: 3 } },
      ]);
    });

    it('leaves "turn the fan on" to its switch when it has one', async () => {
      const decision = await read(
        { ...fan, power: choice('on', 0.97), fan: choice('on', 0.95) },
        'turn the fan on',
      );
      expect(commandsOf(decision)).toEqual([
        { deviceId: 'fan', endpointId: 1, command: { type: 'power', on: true } },
      ]);
    });

    it('steps "faster" from the speed it is on', async () => {
      const decision = await read({ ...fan, fan: choice('faster', 0.95) }, 'faster');
      expect(commandsOf(decision)).toEqual([
        { deviceId: 'fan', endpointId: 1, command: { type: 'setFanMode', mode: 3 } },
      ]);
    });

    it('sets a percentage it found in code', async () => {
      const decision = await read(
        { ...fan, fan: choice('percent', 0.95), amount: choice('fan_speed', 0.95) },
        'fan to 60%',
      );
      expect(commandsOf(decision)).toEqual([
        { deviceId: 'fan', endpointId: 1, command: { type: 'setFanPercent', percent: 60 } },
      ]);
    });
  });

  it('asks which part of a two-gang switch was meant, rather than guessing', async () => {
    const home = homeWith({
      devices: [
        ...DEVICES,
        {
          id: 'double',
          name: 'Double switch',
          roomId: 'kitchen',
          endpoints: [
            { endpointId: 1, deviceKind: 'wallSwitch', capabilities: ['onOff'] },
            { endpointId: 2, deviceKind: 'wallSwitch', capabilities: ['onOff'] },
          ],
        },
      ],
    });
    const decision = await read({ ...OFF_KITCHEN_LIGHT, device: choice('d11') }, 'double switch off', home);
    expect(standDownOf(decision)).toMatchObject({
      question: 'action',
      reason: 'blocked',
      because: 'Double switch has 2 parts that could be meant',
    });
  });

  it('stands down when the place and the device disagree', async () => {
    // The two are answered blind and cannot see each other, so when both are
    // confident and point different ways, one is wrong and nothing can tell
    // which. This is the shape a catalog gets wrong in a home with three
    // lights called Ceiling light.
    const decision = await read({ ...OFF_KITCHEN_LIGHT, place: choice('r2', 0.96) }, 'living room light off');
    expect(standDownOf(decision)).toMatchObject({
      question: 'place',
      reason: 'disagreed',
      label: 'Living room',
      device: 'Kitchen light',
      deviceRoom: 'Kitchen',
    });
  });

  it('acts when the place agrees, abstains, or is the zone the room is in', async () => {
    for (const place of [
      choice('z1', 0.96),
      choice(NOT_SAID, 0.99),
      choice(WHOLE_HOME, 0.95),
      choice('r2', 0.4),
    ]) {
      const decision = await read({ ...OFF_KITCHEN_LIGHT, place }, 'kitchen light off');
      expect(decision.kind, JSON.stringify(place)).toBe('act');
    }
  });
});

/* ------------------------------------------------------------------ */

describe('a group', () => {
  it('switches off every light in a room, and names them as a group', async () => {
    const decision = await read(OFF_LIGHTS_IN('r1'), 'turn off the lights in the kitchen');
    expect(commandsOf(decision)).toEqual([
      { deviceId: 'kitchen-light', endpointId: 1, command: { type: 'power', on: false } },
      { deviceId: 'spots', endpointId: 1, command: { type: 'power', on: false } },
    ]);
    const plan = planOf(decision);
    expect(plan.target).toBe('2 lights in the Kitchen');
    expect(plan.plural).toBe(true);
    expect(phrase(plan.wordings, plan.target, plan.plural)).toBe('switched off 2 lights in the Kitchen');
    // The fridge on a plug in the same room is not a light.
    expect(plan.actions.map((action) => action.deviceId)).not.toContain('plug');
  });

  it('reaches every room in a zone', async () => {
    const plan = planOf(await read(OFF_LIGHTS_IN('z1'), 'lights off downstairs'));
    expect(plan.actions.map((action) => action.deviceId)).toEqual(['kitchen-light', 'spots', 'tv-light']);
    expect(plan.target).toBe('3 lights in Downstairs');
  });

  it('reaches the whole home when that is what was said', async () => {
    const plan = planOf(await read(OFF_LIGHTS_IN(WHOLE_HOME), 'turn off all the lights'));
    expect(plan.actions.map((action) => action.deviceId)).toEqual(['kitchen-light', 'spots', 'tv-light', 'lamp']);
    expect(plan.target).toBe('4 lights across the home');
  });

  it('reads "turn off the lights" with no place as every light in the home', async () => {
    // Said to a phone, there is nowhere else it could mean — and off is the
    // direction that is safe to get wrong.
    const plan = planOf(await read(OFF_LIGHTS_IN(NOT_SAID), 'выключи свет'));
    expect(plan.actions.map((action) => action.deviceId)).toEqual(['kitchen-light', 'spots', 'tv-light', 'lamp']);
    expect(plan.target).toBe('4 lights across the home');
  });

  it('locks and pauses with no place, and leaves anything else with no place to the model', async () => {
    const locked = await read(
      { ...OFF_LIGHTS_IN(NOT_SAID), deviceType: choice('locks', 0.95), power: choice(UNCHANGED), lock: choice('lock', 0.95) },
      'lock the doors',
    );
    expect(commandsOf(locked)).toEqual([
      { deviceId: 'door', endpointId: 1, command: { type: 'lock', engage: true } },
    ]);

    // "Turn on the lights" with every lamp in every bedroom at the end of it.
    const on = await read({ ...OFF_LIGHTS_IN(NOT_SAID), power: choice('on', 0.97) }, 'turn on the lights');
    expect(standDownOf(on)).toMatchObject({ question: 'place', reason: 'blocked', answer: NOT_SAID });

    const opened = await read(
      { ...OFF_LIGHTS_IN(NOT_SAID), deviceType: choice('blinds', 0.95), power: choice(UNCHANGED), cover: choice('open', 0.95) },
      'open the blinds',
    );
    expect(standDownOf(opened)).toMatchObject({ question: 'place', reason: 'blocked', answer: NOT_SAID });

    // Dimming is not switching off, and a light that is off would be switched on to be seen.
    const dimmed = await read(
      { ...OFF_LIGHTS_IN(NOT_SAID), power: choice(UNCHANGED), brightness: choice('full', 0.95) },
      'full brightness',
    );
    expect(standDownOf(dimmed)).toMatchObject({ question: 'place', reason: 'blocked' });
  });

  it('dims the lights that can dim and leaves the rest alone', async () => {
    const decision = await read(
      { ...OFF_LIGHTS_IN('r1'), power: choice(UNCHANGED), brightness: choice('dimmer', 0.95) },
      'dim the kitchen lights',
    );
    expect(commandsOf(decision)).toEqual([
      { deviceId: 'kitchen-light', endpointId: 1, command: { type: 'setLevel', level: 36 } },
    ]);
  });

  it('reads "everything" narrowly: what a person switches off leaving a room', async () => {
    const decision = await read(
      { ...OFF_LIGHTS_IN('r2'), deviceType: choice('everything', 0.95) },
      'turn everything off in the living room',
    );
    const plan = planOf(decision);
    // The light and the TV — not the blind, not the thermostat.
    expect(plan.actions.map((action) => action.deviceId)).toEqual(['tv-light', 'tv']);
    expect(plan.target).toBe('everything in the Living room');
  });

  it('never reaches a fridge on a plug through "everything"', async () => {
    const plan = planOf(
      await read({ ...OFF_LIGHTS_IN('r1'), deviceType: choice('everything', 0.95) }, 'everything off in the kitchen'),
    );
    expect(plan.actions.map((action) => action.deviceId)).toEqual(['kitchen-light', 'spots']);
  });

  it('never switches everything in the home on at once', async () => {
    const decision = await read(
      { ...OFF_LIGHTS_IN(WHOLE_HOME), deviceType: choice('everything', 0.95), power: choice('on', 0.97) },
      'turn everything on',
    );
    expect(standDownOf(decision)).toMatchObject({
      question: 'power',
      reason: 'blocked',
      because: 'everything in the home is never switched on at once',
    });
  });

  it('switches everything in one room on', async () => {
    const decision = await read(
      { ...OFF_LIGHTS_IN('r2'), deviceType: choice('everything', 0.95), power: choice('on', 0.97) },
      'turn everything on in the living room',
    );
    expect(planOf(decision).actions.map((action) => action.deviceId)).toEqual(['tv-light', 'tv']);
  });

  it('locks every lock, and never unlocks them all', async () => {
    const locks = { ...OFF_LIGHTS_IN(WHOLE_HOME), deviceType: choice('locks', 0.95), power: choice(UNCHANGED) };
    const locked = await read({ ...locks, lock: choice('lock', 0.95) }, 'lock all the doors');
    expect(commandsOf(locked)).toEqual([
      { deviceId: 'door', endpointId: 1, command: { type: 'lock', engage: true } },
    ]);
    const unlocked = await read({ ...locks, lock: choice('unlock', 0.95) }, 'unlock all the doors');
    expect(standDownOf(unlocked)).toMatchObject({
      question: 'lock',
      reason: 'blocked',
      because: 'a group of locks is never unlocked at once',
    });
  });

  it('says when a place has none of that kind', async () => {
    const decision = await read(
      { ...OFF_LIGHTS_IN('r3'), deviceType: choice('blinds', 0.95), power: choice(UNCHANGED), cover: choice('close') },
      'close the blinds in the bedroom',
    );
    expect(standDownOf(decision)).toMatchObject({
      question: 'deviceType',
      reason: 'blocked',
      because: 'no blinds in the Bedroom',
    });
  });

  it('works every endpoint of a two-gang switch in a group', async () => {
    const home = homeWith({
      devices: [
        ...DEVICES,
        {
          id: 'double',
          name: 'Double switch',
          roomId: 'kitchen',
          endpoints: [
            { endpointId: 1, deviceKind: 'wallSwitch', capabilities: ['onOff'] },
            { endpointId: 2, deviceKind: 'wallSwitch', capabilities: ['onOff'] },
          ],
        },
      ],
    });
    const decision = await read(
      { ...OFF_LIGHTS_IN('r1'), deviceType: choice('sockets', 0.95) },
      'switch off the switches in the kitchen',
      home,
    );
    // The fridge plug is named for what it is here, so it is in the group.
    expect(commandsOf(decision)).toEqual([
      { deviceId: 'plug', endpointId: 1, command: { type: 'power', on: false } },
      { deviceId: 'double', endpointId: 1, command: { type: 'power', on: false } },
      { deviceId: 'double', endpointId: 2, command: { type: 'power', on: false } },
    ]);
  });

  it('does not try a member the hub knows is offline, and names it', async () => {
    const home = homeWith({
      devices: DEVICES.map((device) => (device.id === 'spots' ? { ...device, online: false } : device)),
    });
    const plan = planOf(await read(OFF_LIGHTS_IN('r1'), 'kitchen lights off', home));
    expect(plan.actions.map((action) => action.deviceId)).toEqual(['kitchen-light']);
    expect(plan.offline).toEqual([
      { deviceName: 'Spots', roomName: 'Kitchen', wordings: [{ before: 'switched off', after: '' }] },
    ]);
  });

  it('stands down when every member is offline', async () => {
    const home = homeWith({
      devices: DEVICES.map((device) =>
        device.roomId === 'kitchen' ? { ...device, online: false } : device,
      ),
    });
    const decision = await read(OFF_LIGHTS_IN('r1'), 'kitchen lights off', home);
    expect(standDownOf(decision)).toMatchObject({
      question: 'action',
      reason: 'blocked',
      because: 'every one of the lights in the Kitchen is offline',
    });
  });

  it('stands down on a group bigger than one request may move', async () => {
    const lights = Array.from({ length: MAX_COMMANDS + 6 }, (_, index) => ({
      id: `light-${index}`,
      name: `Light ${index}`,
      roomId: 'kitchen',
      endpoints: [{ endpointId: 1, deviceKind: 'light' as const, capabilities: ['onOff' as const] }],
    }));
    const decision = await read(OFF_LIGHTS_IN('r1'), 'kitchen lights off', homeWith({ devices: lights }));
    expect(standDownOf(decision)).toMatchObject({
      question: 'group',
      reason: 'size',
      value: MAX_COMMANDS + 6,
      max: MAX_COMMANDS,
    });
  });
});

/* ------------------------------------------------------------------ */

describe('the other roads', () => {
  it('splits several requests when at least one is a command', async () => {
    const decision = await read(
      { ...OFF_KITCHEN_LIGHT, multiple: noul(0.85), anyCommand: noul(0.93) },
      'turn off the TV and close the blinds',
    );
    expect(decision).toMatchObject({ kind: 'split', confidence: 0.85 });
  });

  it('splits two devices named one by one', async () => {
    // "The kitchen light and the hall light" is one request about several
    // devices — and two commands this path can carry out, once it is split.
    const decision = await read(
      { ...OFF_KITCHEN_LIGHT, scope: choice('several_devices', 0.92), multiple: noul(0.3) },
      'turn off the kitchen light and the spots',
    );
    expect(decision).toMatchObject({ kind: 'split', confidence: 0.92 });
  });

  it('does not split what holds no command', async () => {
    const decision = await read(
      {
        ...OFF_KITCHEN_LIGHT,
        intent: choice('home_question', 0.95),
        multiple: noul(0.9),
        anyCommand: noul(0.2),
      },
      'is the door locked and what is the temperature',
    );
    expect(standDownOf(decision)).toMatchObject({ question: 'intent', reason: 'declined' });
  });

  it('leaves a sentence that is neither clearly one request nor clearly several to the model', async () => {
    const decision = await read({ ...OFF_KITCHEN_LIGHT, multiple: noul(0.5) }, 'kitchen light off and so on');
    expect(standDownOf(decision)).toMatchObject({
      question: 'multiple',
      reason: 'blocked',
      value: 0.5,
      max: NEGATIVE_NOUL_MAX,
    });
  });

  it('routes a confident, self-contained automation request', async () => {
    const decision = await read(
      {
        ...OFF_KITCHEN_LIGHT,
        intent: choice('automation_work', 0.98),
        route: choice('automations', 0.97),
        selfContained: noul(0.93),
      },
      'turn the hall light on every night at eleven',
    );
    expect(decision).toMatchObject({ kind: 'route', agentKey: 'automations', confidence: 0.97 });
  });

  it('does not route a sentence that means nothing on its own', async () => {
    // "Make it half past instead" is a perfectly good follow-up and a useless
    // brief — which is the one thing a fast route gives up, and this catches.
    const decision = await read(
      {
        ...OFF_KITCHEN_LIGHT,
        intent: choice('automation_work', 0.98),
        route: choice('automations', 0.97),
        selfContained: noul(0.3),
      },
      'make it half past instead',
    );
    expect(standDownOf(decision)).toMatchObject({
      question: 'selfContained',
      reason: 'unsure',
      answer: 'automations',
      label: 'automations agent',
      value: 0.3,
      min: POSITIVE_NOUL_MIN,
    });
  });

  it('never asks for more thinking, only less', async () => {
    const easy = await read({ ...OFF_KITCHEN_LIGHT, effort: score(0.1, 0.95) });
    expect(easy.effort).toBe('low');
    const hard = await read({ ...OFF_KITCHEN_LIGHT, effort: score(2, 0.99) });
    // Not "high" — there is no such answer to give.
    expect(hard.effort).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */

describe('standing down, and saying why', () => {
  /**
   * Every gate, and **the reason it gives**. A stand-down used to be a bare
   * `none`, so "why was that not instant?" had no answer short of replaying
   * the sentence by hand.
   */
  const cases: [string, Record<string, unknown>, string, string][] = [
    ['it is for later', { later: noul(0.8) }, 'later', 'blocked'],
    ['it takes something back', { negated: noul(0.7) }, 'negated', 'blocked'],
    ['it is about no device', { scope: choice('none', 0.95) }, 'scope', 'blocked'],
    ['the scope is a guess', { scope: choice('one_device', 0.6) }, 'scope', 'unsure'],
    ['no device was picked out', { device: choice(NONE_OF_THESE, 0.99) }, 'device', 'blocked'],
    ['the device is a guess', { device: choice('d1', 0.5) }, 'device', 'unsure'],
    ['the action is a guess', { power: choice('off', 0.5) }, 'power', 'unsure'],
    ['it asks nothing of this device', { power: choice(UNCHANGED, 0.95) }, 'action', 'blocked'],
    ['the intent is a guess', { intent: choice('device_command', 0.4) }, 'intent', 'unsure'],
    ['it is a question rather than a command', { intent: choice('home_question', 0.99) }, 'intent', 'declined'],
    ['it is about something else entirely', { intent: choice('other', 0.99) }, 'intent', 'declined'],
    ['a question it needs went unanswered', { device: undefined }, 'device', 'unanswered'],
    ['an action it needs went unanswered', { power: undefined }, 'power', 'unanswered'],
  ];
  for (const [why, override, question, reason] of cases) {
    it(`stands down when ${why}`, async () => {
      const decision = await read({ ...OFF_KITCHEN_LIGHT, ...override }, 'turn off the kitchen light');
      const standDown = standDownOf(decision);
      expect(standDown).toMatchObject({ question, reason });
      // The reading's own timing rides along on every one, for a log line that
      // can be set against the round that followed.
      expect(standDown.durationMs).toBe(180);
      // And it still paid for the reading.
      expect(decision.costUsd).toBe(0.00002);
    });
  }

  it('names what it was unsure between, and the bar it missed', async () => {
    // An unsure answer is usually two answers. Naming the second is what turns
    // a bare 0.5 into a reason somebody can act on — rename one of them.
    const decision = await read({
      ...OFF_KITCHEN_LIGHT,
      device: choice('d1', 0.5, { d1: 0.52, d3: 0.4, [NONE_OF_THESE]: 0.08 }),
    });
    expect(standDownOf(decision)).toMatchObject({
      question: 'device',
      reason: 'unsure',
      answer: 'd1',
      label: 'Kitchen light',
      runnerUp: 'Light TV',
      value: 0.5,
      min: ACT_CONFIDENCE_MIN,
    });
  });

  it('stands down when the decider had no answer at all', async () => {
    const silent: Decider = { modelId: DECISION_MODEL, decide: async () => null };
    const decision = await decideHomeCommand({ decider: silent, home: HOME, delegates: DELEGATES, said: 'x' });
    expect(decision).toEqual({
      kind: 'none',
      costUsd: 0,
      effort: undefined,
      standDown: { question: 'model', reason: 'missed' },
    });
  });

  it('passes on why nothing came back, and whether it had to connect first', async () => {
    // A timeout is the one miss with a duration worth reporting: how long the
    // turn waited for an answer that never came.
    const slow: Decider = {
      modelId: DECISION_MODEL,
      decide: async (input) => {
        input.onMiss?.('timeout', { newConnection: true });
        return null;
      },
    };
    const decision = await decideHomeCommand({ decider: slow, home: HOME, delegates: DELEGATES, said: 'x' });
    expect(standDownOf(decision)).toEqual({
      question: 'model',
      reason: 'missed',
      miss: 'timeout',
      durationMs: DECISION_TIMEOUT_MS,
      newConnection: true,
    });
  });

  it('stands down on a home too big to offer as options, without asking', async () => {
    const crowded = homeWith({
      devices: Array.from({ length: 400 }, (_, index) => ({
        id: `dev-${index}`,
        name: `Device ${index}`,
        roomId: 'kitchen',
        endpoints: [{ endpointId: 1, capabilities: ['onOff' as const] }],
      })),
    });
    const stub = decider(OFF_KITCHEN_LIGHT);
    const decision = await decideHomeCommand({ decider: stub, home: crowded, delegates: DELEGATES, said: 'x' });
    expect(standDownOf(decision)).toEqual({ question: 'home', reason: 'size', value: 400, max: 180 });
    expect(stub.asked).toHaveLength(0);
  });

  it('asks nothing of an empty home', async () => {
    const stub = decider(OFF_KITCHEN_LIGHT);
    const decision = await decideHomeCommand({
      decider: stub,
      home: homeWith({ devices: [] }),
      delegates: DELEGATES,
      said: 'x',
    });
    expect(standDownOf(decision)).toMatchObject({ question: 'home', reason: 'size', value: 0 });
    expect(stub.asked).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */

describe('the parts of a split sentence', () => {
  /** Every answer for one part, under its prefix. */
  const under = (prefix: string, answers: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(answers).map(([id, answer]) => [`${prefix}${id}`, answer]));

  const OFF_TV = {
    ...OFF_KITCHEN_LIGHT,
    device: choice('d4'),
    place: choice('r2'),
  };
  const QUESTION = { ...OFF_KITCHEN_LIGHT, intent: choice('home_question', 0.96) };

  it('reads every part in one request, each question pointed at its own part', async () => {
    const stub = decider({});
    await decideParts({
      decider: stub,
      home: HOME,
      parts: ['turn off the TV', 'set the kitchen light to 40%'],
    });
    expect(stub.asked).toHaveLength(1);
    const ids = Object.keys(stub.asked[0] ?? {});
    expect(ids).toContain('p0_intent');
    expect(ids).toContain('p1_intent');
    // A part is split to be one request, so it is asked as a guard…
    expect(ids).toContain('p0_multiple');
    // …and only the part with a number is asked what it is of.
    expect(ids).not.toContain('p0_amount');
    expect(ids).toContain('p1_amount');
    // The routing questions are the sentence's, not a part's.
    expect(ids).not.toContain('p0_route');
    expect(ids).not.toContain('p0_anyCommand');
    expect(stub.states[0]).toEqual({
      parts: ['turn off the TV', 'set the kitchen light to 40%'],
      amounts: [null, '40%'],
    });
    const asked = stub.asked[0] as Record<string, { instructions: string }>;
    expect(asked['p1_intent']?.instructions).toContain('`parts[1]`');
    expect(asked['p1_amount']?.instructions).toContain('`amounts[1]`');
  });

  it('acts on the parts it is sure of and leaves the rest, quoted, for the model', async () => {
    const result = await decideParts({
      decider: decider({ ...under('p0_', OFF_TV), ...under('p1_', QUESTION) }),
      home: HOME,
      parts: ['turn off the TV', 'what is the temperature'],
    });
    expect(result.parts).toHaveLength(2);
    const [first, second] = result.parts;
    expect(first?.reading.kind).toBe('act');
    expect(first?.reading.kind === 'act' && first.reading.plan.actions[0]?.commands).toEqual([
      { endpointId: 1, command: { type: 'power', on: false } },
    ]);
    expect(second?.reading).toMatchObject({
      kind: 'none',
      standDown: { question: 'intent', reason: 'declined', part: 'what is the temperature', durationMs: 180 },
    });
  });

  it('reads each part against its own number', async () => {
    const result = await decideParts({
      decider: decider({
        ...under('p0_', OFF_TV),
        ...under('p1_', {
          ...OFF_KITCHEN_LIGHT,
          power: choice(UNCHANGED),
          brightness: choice('percent', 0.95),
          amount: choice('brightness', 0.95),
        }),
      }),
      home: HOME,
      parts: ['turn off the TV', 'set the kitchen light to 40%'],
    });
    const second = result.parts[1]?.reading;
    expect(second?.kind === 'act' && second.plan.actions[0]?.commands).toEqual([
      { endpointId: 1, command: { type: 'power', on: true } },
      { endpointId: 1, command: { type: 'setLevel', level: 102 } },
    ]);
  });

  it('leaves a part that is still several requests to the model', async () => {
    const result = await decideParts({
      decider: decider(under('p0_', { ...OFF_TV, multiple: noul(0.8) })),
      home: HOME,
      parts: ['turn off the TV and the lights'],
    });
    expect(result.parts[0]?.reading).toMatchObject({
      kind: 'none',
      standDown: { question: 'multiple', reason: 'blocked' },
    });
  });

  it('leaves every part to the model when nothing came back', async () => {
    const silent: Decider = {
      modelId: DECISION_MODEL,
      decide: async (input) => {
        input.onMiss?.('failed');
        return null;
      },
    };
    const result = await decideParts({ decider: silent, home: HOME, parts: ['a', 'b'] });
    expect(result.costUsd).toBe(0);
    expect(result.parts.map((part) => part.reading)).toEqual([
      { kind: 'none', standDown: { question: 'model', reason: 'missed', miss: 'failed', part: 'a' } },
      { kind: 'none', standDown: { question: 'model', reason: 'missed', miss: 'failed', part: 'b' } },
    ]);
  });

  it(`reads at most ${MAX_PARTS} parts`, async () => {
    const stub = decider({});
    const result = await decideParts({
      decider: stub,
      home: HOME,
      parts: ['a', 'b', 'c', 'd', 'e'],
    });
    expect(result.parts).toHaveLength(MAX_PARTS);
    expect(Object.keys(stub.asked[0] ?? {})).not.toContain(`p${MAX_PARTS}_intent`);
  });
});

/* ------------------------------------------------------------------ */

describe('saying what was done', () => {
  it('puts the thing in the middle, and a pronoun after it', () => {
    const wordings = [
      { before: 'switched on', after: '' },
      { before: 'set', after: ' to 40% brightness' },
    ];
    expect(phrase(wordings, 'Light TV', false)).toBe('switched on Light TV and set it to 40% brightness');
    expect(phrase(wordings, '4 lights in the Kitchen', true)).toBe(
      'switched on 4 lights in the Kitchen and set them to 40% brightness',
    );
    expect(participle(wordings)).toBe('switched on and set to 40% brightness');
  });
});

describe('saying why it stood down', () => {
  const base = { durationMs: 180 };

  it('names what it was unsure between, the number and the bar', () => {
    const words = describeStandDown({
      ...base,
      question: 'device',
      reason: 'unsure',
      answer: 'd3',
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
      question: 'power',
      reason: 'unsure',
      answer: 'on',
      label: 'on',
      value: 0.55,
      min: ACT_CONFIDENCE_MIN,
      device: 'Light TV',
    });
    expect(words.text).toBe("Jev wasn't sure what to do with Light TV");
    expect(words.detail).toBe('on: 0.55, needs 0.85 · 180 ms');
  });

  it('says where a device really is when the place it heard disagrees', () => {
    const words = describeStandDown({
      ...base,
      question: 'place',
      reason: 'disagreed',
      answer: 'r1',
      label: 'Kitchen',
      value: 0.96,
      device: 'Ceiling light',
      deviceRoom: 'Hallway',
    });
    expect(words.text).toBe('Jev matched a device outside the place it heard');
    expect(words.detail).toBe('Kitchen: 0.96 · Ceiling light is in Hallway · 180 ms');
  });

  it('says a timeout as a deadline, and whether it had to connect first', () => {
    const words = describeStandDown({
      question: 'model',
      reason: 'missed',
      miss: 'timeout',
      durationMs: 1500,
      newConnection: true,
    });
    expect(words.text).toBe("Jev didn't answer in time");
    expect(words.detail).toBe('nothing back within 1500 ms, new connection');
    expect(words.audience).toBe('shown');
  });

  it('says what became of a split', () => {
    expect(
      describeStandDown({ question: 'split', reason: 'missed', because: 'the model did not split it' }),
    ).toMatchObject({ text: "Jev couldn't have the request split", detail: 'the model did not split it' });
    expect(describeStandDown({ question: 'split', reason: 'blocked', durationMs: 900 })).toMatchObject({
      text: 'Jev was told it is one request after all',
      detail: 'split in 900 ms',
    });
  });

  it('says which part of a split sentence it is about', () => {
    const words = describeStandDown({
      ...base,
      question: 'intent',
      reason: 'unsure',
      label: 'a device command',
      value: 0.6,
      min: ACT_CONFIDENCE_MIN,
      part: 'the other thing',
    });
    expect(words.detail).toBe('a device command: 0.60, needs 0.85 · 180 ms · for “the other thing”');
  });

  it('says a group was too big, and by how much', () => {
    const words = describeStandDown({ ...base, question: 'group', reason: 'size', value: 30, max: MAX_COMMANDS });
    expect(words.text).toBe('Jev found more devices than one request may move');
    expect(words.detail).toBe(`30 commands, up to ${MAX_COMMANDS} · 180 ms`);
  });

  it('says what it found when a place has none of that kind', () => {
    const words = describeStandDown({
      ...base,
      question: 'deviceType',
      reason: 'blocked',
      label: 'blinds',
      value: 0.95,
      because: 'no blinds in the Bedroom',
    });
    expect(words.text).toBe('Jev found no blinds in the Bedroom');
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
    expect(describeStandDown({ question: 'home', reason: 'size', value: 0, max: 180 }).audience).toBe('quiet');
  });

  it('has words for every option the battery can answer', () => {
    // An option added to a question without words here would reach a trail
    // as an identifier — `one_device: 0.62` is a sentence only its author can
    // read.
    const options = [
      intentQuestion(),
      scopeQuestion(),
      deviceTypeQuestion(),
      amountQuestion(),
      placeQuestion([]),
      deviceQuestion([]),
      routeQuestion([]),
      ...FAMILIES.map((family) => familyQuestion(family)),
    ].flatMap((question) => Object.keys(question.criteria));
    for (const option of options) {
      expect(OPTION_WORDS[option], option).toBeDefined();
    }
  });
});
