import { describe, expect, it } from 'vitest';
import { DECISION_MODEL, type Decider, type Questions } from '../src/ai/decide/decider.js';
import {
  ACT_CONFIDENCE_MIN,
  CALIBRATED_AGAINST,
  DECISION_TIMEOUT_MS,
  DEVICE_LEAN_MIN,
  FAMILIES,
  MAX_COMMANDS,
  MAX_PARTS,
  MAX_TARGET_QUESTIONS,
  NEGATIVE_NOUL_MAX,
  NONE_OF_THESE,
  ON_TARGETS_MAX,
  PART_CANDIDATES_MAX,
  POSITIVE_NOUL_MIN,
  SHAPE_NOTHING,
  SHAPE_ONE,
  SHAPE_ONE_AND_MORE,
  SHAPE_SEVERAL,
  SPLIT_MIN,
  TARGET_NO,
  TARGET_YES,
  UNCHANGED,
  amountField,
  amountIn,
  amountQuestion,
  deviceQuestion,
  familyQuestion,
  intentQuestion,
  routeQuestion,
  shapeQuestion,
  targetQuestion,
} from '../src/ai/decide/questions.js';
import { SPLIT_SYSTEM_PROMPT } from '../src/ai/decide/split.js';
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
  // d3 — a light whose name has a TV in it, beside the TV itself.
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

/** `count` lights in the kitchen, for the cases about how many one request may move. */
function lights(count: number): DecidableDevice[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `light-${index}`,
    name: `Light ${index}`,
    roomId: 'kitchen',
    endpoints: [{ endpointId: 1, deviceKind: 'light' as const, capabilities: ['onOff' as const] }],
  }));
}

/** The home with one more device on the end — `d11`. */
function homePlus(device: DecidableDevice): DecidableHome {
  return homeWith({ devices: [...DEVICES, device] });
}

const DOUBLE_SWITCH: DecidableDevice = {
  id: 'double',
  name: 'Double switch',
  roomId: 'kitchen',
  endpoints: [
    { endpointId: 1, deviceKind: 'wallSwitch', capabilities: ['onOff'] },
    { endpointId: 2, deviceKind: 'wallSwitch', capabilities: ['onOff'] },
  ],
};

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

/**
 * Every device's own yes/no — a clear no unless a case says otherwise, which
 * is what a reading of a sentence about one or two devices looks like.
 */
function targets(yes: Record<string, number> = {}, count = DEVICES.length): Record<string, unknown> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => {
      const key = `d${index + 1}`;
      return [`target_${key}`, noul(yes[key] ?? 0.1)];
    }),
  );
}

/** Everything a plain "turn off the kitchen light" answers. */
const OFF_KITCHEN_LIGHT: Record<string, unknown> = {
  intent: choice('device_command', 0.98),
  shape: choice(SHAPE_ONE, 0.96),
  later: noul(0.2),
  negated: noul(0.2),
  device: choice('d1', 0.96),
  ...targets({ d1: 0.95 }),
  single: noul(0.9),
  everything: noul(0.1),
  ...UNCHANGED_ALL,
  power: choice('off', 0.97),
  route: choice('here', 0.99),
  selfContained: noul(0.9),
};

/** The same sentence about another single device. */
function ONE(key: string, extra: Record<string, unknown> = {}, count = DEVICES.length): Record<string, unknown> {
  return { ...OFF_KITCHEN_LIGHT, device: choice(key, 0.96), ...targets({ [key]: 0.95 }, count), ...extra };
}

/**
 * A request about a set of devices: each one's own yes/no a clear yes, the
 * relative choice naming none of them, and `single` hearing more than one.
 */
function SET(
  keys: readonly string[],
  extra: Record<string, unknown> = {},
  count = DEVICES.length,
): Record<string, unknown> {
  return {
    ...OFF_KITCHEN_LIGHT,
    device: choice(NONE_OF_THESE, 0.9),
    single: noul(0.1),
    ...targets(Object.fromEntries(keys.map((key) => [key, 0.95])), count),
    ...extra,
  };
}

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
    throw new Error(`expected a stand-down, got ${JSON.stringify(decision)}`);
  }
  return decision.standDown;
}

/** Every command a plan would send, flattened, in order. */
function commandsOf(decision: HomeDecision) {
  return planOf(decision).actions.flatMap((action) =>
    action.commands.map((entry) => ({ deviceId: action.deviceId, ...entry })),
  );
}

/** Which devices a plan moves, in order. */
function movedBy(decision: HomeDecision): string[] {
  return planOf(decision).actions.map((action) => action.deviceId);
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
    expect(Object.keys(shapeQuestion([]).criteria)).toContain(SHAPE_NOTHING);
    expect(Object.keys(amountQuestion().criteria)).toContain('other');
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
    expect(shapeQuestion([], 'parts[1]').instructions).toContain('`parts[1]`');
    expect(familyQuestion('power', 'parts[2]').instructions).toContain('`parts[2]`');
    expect(
      targetQuestion({ key: 'd1', name: 'Lamp', kindWords: 'A light' }, [], 'parts[2]').instructions,
    ).toContain('`parts[2]`');
    expect(amountField('said')).toBe('amount');
    expect(amountField('parts[3]')).toBe('amounts[3]');
    expect(amountQuestion('parts[3]').instructions).toContain('`amounts[3]`');
  });

  it('counts one action on several devices as one thing, in the question and in the split alike', () => {
    // It is the split that is the exception, and the two must never disagree
    // about what is one request — a set of devices is carried by the per-device
    // questions, and splitting it only costs a model round.
    const shape = shapeQuestion([]);
    expect(shape.criteria[SHAPE_ONE]).toContain('"turn off the kitchen light and the hall light"');
    expect(shape.criteria[SHAPE_ONE]).toContain('"turn off all the lights"');
    expect(shape.criteria[SHAPE_SEVERAL]).toContain('"turn off the TV and close the blinds"');
    expect(SPLIT_SYSTEM_PROMPT).toContain('"turn off the kitchen light and the hall light"');
    expect(SPLIT_SYSTEM_PROMPT).toContain('stays whole');
  });

  it('tells the question that splits which names are one device however many words they have', () => {
    // "Turn on the light tv" was read as a light and a TV, split in two, and
    // neither half named anything in the home.
    const told = shapeQuestion(['Light TV', 'Kitchen light']).instructions;
    expect(told).toContain('"Light TV", "Kitchen light"');
    expect(told).toContain('one thing however many words it has');
    expect(shapeQuestion([]).instructions).not.toContain('"');
    expect(SPLIT_SYSTEM_PROMPT).toContain('never split a name');
  });

  it("describes each device in its own question, and names the ones it could be mistaken for", () => {
    const light = { key: 'd3', name: 'Light TV', kindWords: 'A light', roomName: 'Living room', zoneName: 'Downstairs' };
    const tv = { key: 'd4', name: 'TV', kindWords: 'A TV', roomName: 'Living room', zoneName: 'Downstairs' };
    // A kind is lower-cased at its first letter only: "a TV", never "a tv".
    expect(targetQuestion(tv, []).instructions).toBe(
      '`said` asks for something to be done to "TV" — a TV in the Living room, Downstairs.',
    );
    const beside = targetQuestion(tv, [light]);
    expect(beside.instructions).toContain(
      'It is a different device from "Light TV" (a light in the Living room, Downstairs).',
    );
    expect(beside.criteria?.false).toContain('names a different device with a similar name');
    // A set of them is one question per device — the whole kind, when asked.
    expect(beside.criteria?.true).toContain('"turn off all the lights"');
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
    expect(SPLIT_MIN).toBeGreaterThan(NEGATIVE_NOUL_MAX);
    expect(SPLIT_MIN).toBeLessThan(ACT_CONFIDENCE_MIN);
    // A device's own yes/no has a band in the middle that is neither.
    expect(TARGET_NO).toBeLessThan(0.5);
    expect(TARGET_YES).toBeGreaterThan(0.5);
    // Leaning is lower than acting on the choice alone only because it is
    // never alone.
    expect(DEVICE_LEAN_MIN).toBeGreaterThan(0.5);
    expect(DEVICE_LEAN_MIN).toBeLessThan(ACT_CONFIDENCE_MIN);
    // Switching on is bounded well inside what one request may move at all.
    expect(ON_TARGETS_MAX).toBeLessThan(MAX_COMMANDS);
  });

  it('gives a decision time to reach the vendor from a Pi, and no more', () => {
    // 700 ms was the fault a real hub's log showed: a fresh connection alone
    // is most of that from the far side of the world.
    expect(DECISION_TIMEOUT_MS).toBeGreaterThanOrEqual(1_000);
    expect(DECISION_TIMEOUT_MS).toBeLessThanOrEqual(2_000);
  });

  it('keys devices plainly and puts the name in the description', () => {
    // A key is what comes back, so it has to survive the wire whatever
    // somebody called their lamp.
    const devices = deviceQuestion([
      { key: 'd1', name: 'Лампа "у окна"', kindWords: 'A light', roomName: 'Кухня' },
      { key: 'd2', name: 'Kettle', kindWords: 'A plug or socket' },
    ]);
    expect(Object.keys(devices.criteria)).toEqual(['d1', 'd2', NONE_OF_THESE]);
    expect(devices.criteria['d1']).toBe('"Лампа "у окна"" — a light in the Кухня.');
    expect(devices.criteria['d2']).toBe('"Kettle" — a plug or socket, in no particular room.');
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
      'shape',
      'later',
      'negated',
      'device',
      'single',
      'everything',
      ...DEVICES.map((_, index) => `target_d${index + 1}`),
      ...FAMILIES,
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
    expect(asked['device']?.criteria['d1']).toBe('"Kitchen light" — a light in the Kitchen, Downstairs.');
    expect(asked['device']?.criteria['d7']).toBe('"Front door" — a door lock, in no particular room.');
  });

  it("names, in each device's own question, the devices it could be mistaken for", async () => {
    const stub = decider(OFF_KITCHEN_LIGHT);
    await decideHomeCommand({ decider: stub, home: HOME, delegates: DELEGATES, said: 'turn on the light tv' });
    const asked = stub.asked[0] as Record<string, { instructions: string }>;
    // "The light tv" has to be able to say no to the TV…
    expect(asked['target_d4']?.instructions).toBe(
      '`said` asks for something to be done to "TV" — a TV in the Living room, Downstairs. ' +
        'It is a different device from "Light TV" (a light in the Living room, Downstairs).',
    );
    // …and "switch the light on" has to know there is more than one light:
    // the one sharing a word first, then the others of its kind, its own room
    // before anywhere else.
    expect(asked['target_d1']?.instructions).toContain(
      'It is a different device from each of these: "Light TV" (a light in the Living room, Downstairs); ' +
        '"Spots" (a light in the Kitchen, Downstairs); "Bedside lamp" (a light in the Bedroom, Upstairs).',
    );
    // A lock is nothing like a lamp, and is not named beside one.
    expect(asked['target_d1']?.instructions).not.toContain('Front door');
  });

  it('tells the question that splits the names a split could cut in two', async () => {
    const stub = decider(OFF_KITCHEN_LIGHT);
    await decideHomeCommand({ decider: stub, home: HOME, delegates: DELEGATES, said: 'turn on the light tv' });
    const asked = stub.asked[0] as Record<string, { instructions: string }>;
    // The names of more than one word, and only those: "Spots" cannot be cut.
    expect(asked['shape']?.instructions).toContain(
      '"Kitchen light", "Light TV", "Bedside lamp", "Front door", "Ceiling fan", "Fridge plug"',
    );
    expect(asked['shape']?.instructions).not.toContain('"Spots"');
  });

  it('sends the sentence as the state and nothing else', async () => {
    // Accuracy falls as the state fills with content unrelated to the
    // question, and the devices are already in their own questions.
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

  it('reads a home too large for a yes/no per device by the choice alone', async () => {
    const big = homeWith({ devices: lights(MAX_TARGET_QUESTIONS + 1) });
    const stub = decider({ ...OFF_KITCHEN_LIGHT, device: choice('d5', 0.95) });
    const decision = await decideHomeCommand({
      decider: stub,
      home: big,
      delegates: DELEGATES,
      said: 'turn off the fifth light',
    });
    expect(Object.keys(stub.asked[0] ?? {}).some((id) => id.startsWith('target_'))).toBe(false);
    expect(commandsOf(decision)).toEqual([
      { deviceId: 'light-4', endpointId: 1, command: { type: 'power', on: false } },
    ]);

    // …which names one device and never a set, and has its own bar to clear.
    const unsure = await read(
      { ...OFF_KITCHEN_LIGHT, device: choice('d5', 0.6, { d5: 0.6, d6: 0.35, [NONE_OF_THESE]: 0.05 }) },
      'turn off that light',
      big,
    );
    expect(standDownOf(unsure)).toMatchObject({
      question: 'device',
      reason: 'unsure',
      label: 'Light 4',
      runnerUp: 'Light 5',
      value: 0.6,
      min: ACT_CONFIDENCE_MIN,
    });
  });
});

/* ------------------------------------------------------------------ */

describe('one device', () => {
  it('switches off the one it was asked to, and says that was everything', async () => {
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
    expect(plan.doubt).toEqual([]);
    // The weakest link in the chain of answers it rests on.
    expect(plan.confidence).toBe(0.96);
    expect(phrase(plan.wordings, plan.target, plan.plural)).toBe('switched off Kitchen light');
    expect(decision).toMatchObject({ kind: 'act', complete: true, durationMs: 180 });
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
      ONE('d4', { playback: choice('pause', 0.95), brightness: choice('dimmer', 0.95) }),
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
      ONE('d7', { power: choice('off', 0.99), lock: choice('lock', 0.95) }),
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
      ONE('d8', { power: choice('off', 0.99), cover: choice('close', 0.95), climate: choice('heat', 0.95) }),
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
        ONE('d3', {
          power: choice(UNCHANGED),
          brightness: choice('percent', 0.95),
          amount: choice('brightness', 0.96),
        }),
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
        ONE('d3', { power: choice(UNCHANGED), brightness: choice('brighter', 0.95) }),
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
        ONE('d6', { power: choice(UNCHANGED), brightness: choice('brighter', 0.95) }),
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
        ONE('d3', { power: choice(UNCHANGED), colour: choice('red', 0.95) }),
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
      const decision = await read(ONE('d5', { cover: choice('half', 0.95) }), 'blind halfway');
      // 0 is fully open in these units, so halfway is 5000 either way round.
      expect(commandsOf(decision)).toEqual([
        { deviceId: 'blind', endpointId: 1, command: { type: 'setCoveringPercent', percent100ths: 5000 } },
      ]);
      expect(phrase(planOf(decision).wordings, 'Blind', false)).toBe('set Blind halfway');
    });

    it('pauses a TV without switching it off', async () => {
      const decision = await read(
        ONE('d4', { power: choice(UNCHANGED), playback: choice('pause', 0.95) }),
        'pause the TV',
      );
      expect(commandsOf(decision)).toEqual([
        { deviceId: 'tv', endpointId: 1, command: { type: 'playPause', play: false } },
      ]);
    });

    it('unlocks one door it was asked to', async () => {
      const decision = await read(ONE('d7', { lock: choice('unlock', 0.95) }), 'unlock the front door');
      expect(commandsOf(decision)).toEqual([
        { deviceId: 'door', endpointId: 1, command: { type: 'lock', engage: false } },
      ]);
    });
  });

  describe('climate', () => {
    const thermostat = ONE('d8');

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
    const fan = ONE('d9', { power: choice(UNCHANGED) });

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
    const decision = await read(ONE('d11', {}, 11), 'double switch off', homePlus(DOUBLE_SWITCH));
    expect(standDownOf(decision)).toMatchObject({
      question: 'action',
      reason: 'blocked',
      because: 'Double switch has 2 parts that could be meant',
    });
  });
});

/* ------------------------------------------------------------------ */

describe('which device', () => {
  it('hears "the light tv" as the one device called Light TV, not as a light and a TV', async () => {
    // The sentence a real home's log stood down on: split into "turn on the
    // light" and "turn on the tv", neither of which named anything.
    const decision = await read(
      ONE('d3', { device: choice('d3', 0.93), ...targets({ d3: 0.92, d4: 0.2 }), power: choice('on', 0.97) }),
      'turn on the light tv',
    );
    expect(commandsOf(decision)).toEqual([
      { deviceId: 'tv-light', endpointId: 1, command: { type: 'power', on: true } },
    ]);
    expect(decision).toMatchObject({ kind: 'act', complete: true });
  });

  it("trusts the choice over another device's yes, and leaves that one to the model", async () => {
    // A yes/no cannot compare itself with the question beside it, so the TV's
    // may say yes to "the light tv"; the choice weighed them against each
    // other and is sure. The TV is named to the model rather than switched on.
    const decision = await read(
      ONE('d3', { device: choice('d3', 0.93), ...targets({ d3: 0.9, d4: 0.8 }), power: choice('on', 0.97) }),
      'turn on the light tv',
    );
    expect(movedBy(decision)).toEqual(['tv-light']);
    expect(planOf(decision).doubt).toEqual(['TV']);
    // Something was left for the model to judge, so this was not everything.
    expect(decision).toMatchObject({ kind: 'act', complete: false });
  });

  it("acts when the choice leans to a device and that device's own yes/no is the only clear yes", async () => {
    const decision = await read(
      ONE('d3', {
        device: choice('d3', 0.7, { d3: 0.7, d4: 0.25, [NONE_OF_THESE]: 0.05 }),
        ...targets({ d3: 0.9, d4: 0.5 }),
        power: choice('on', 0.97),
      }),
      'turn on the light tv',
    );
    expect(movedBy(decision)).toEqual(['tv-light']);
    expect(planOf(decision).doubt).toEqual(['TV']);
    // Two readings leaning together are as sure as the less sure of them.
    expect(planOf(decision).confidence).toBe(0.7);
  });

  it('does not lean on a choice below its bar', async () => {
    const decision = await read(
      ONE('d3', {
        device: choice('d3', DEVICE_LEAN_MIN - 0.1),
        ...targets({ d3: 0.9, d4: 0.5 }),
        power: choice('on', 0.97),
      }),
      'turn on the tv light',
    );
    expect(standDownOf(decision)).toMatchObject({
      question: 'targets',
      reason: 'unsure',
      devices: [
        { name: 'Light TV', value: 0.9 },
        { name: 'TV', value: 0.5 },
      ],
      min: TARGET_YES,
      max: TARGET_NO,
    });
  });

  it('acts on the one clear yes when the choice cannot say', async () => {
    const decision = await read(
      { ...OFF_KITCHEN_LIGHT, device: choice(NONE_OF_THESE, 0.6), ...targets({ d6: 0.9 }) },
      'turn off the lamp',
    );
    expect(movedBy(decision)).toEqual(['lamp']);
    expect(planOf(decision)).toMatchObject({ target: 'Bedside lamp', plural: false, doubt: [] });
  });

  it("stands down when the choice is sure and the device's own yes/no is sure it was not asked for", async () => {
    // One of the two is wrong, and nothing can tell which.
    const decision = await read(
      { ...OFF_KITCHEN_LIGHT, ...targets({ d1: 0.2 }) },
      'turn off the kitchen light',
    );
    expect(standDownOf(decision)).toMatchObject({
      question: 'targets',
      reason: 'disagreed',
      label: 'Kitchen light',
      device: 'Kitchen light',
      value: 0.2,
    });
  });

  it('stands down when nothing in this home was named', async () => {
    const decision = await read(
      { ...OFF_KITCHEN_LIGHT, device: choice(NONE_OF_THESE, 0.95), ...targets() },
      'turn off the garage light',
    );
    expect(standDownOf(decision)).toMatchObject({
      question: 'targets',
      reason: 'blocked',
      label: 'none of these',
      because: 'no device in this home was named',
    });
  });
});

/* ------------------------------------------------------------------ */

describe('several devices', () => {
  it('switches off two devices named one by one, in one reading and no split', async () => {
    const decision = await read(SET(['d1', 'd4']), 'turn off the kitchen light and the TV');
    expect(commandsOf(decision)).toEqual([
      { deviceId: 'kitchen-light', endpointId: 1, command: { type: 'power', on: false } },
      { deviceId: 'tv', endpointId: 1, command: { type: 'power', on: false } },
    ]);
    const plan = planOf(decision);
    expect(plan.target).toBe('Kitchen light and TV');
    expect(plan.plural).toBe(true);
    expect(phrase(plan.wordings, plan.target, plan.plural)).toBe('switched off Kitchen light and TV');
    expect(decision).toMatchObject({ kind: 'act', complete: true });
  });

  it('switches off the lights in a room, and leaves the fridge in it alone', async () => {
    const decision = await read(SET(['d1', 'd2']), 'turn off the lights in the kitchen');
    expect(movedBy(decision)).toEqual(['kitchen-light', 'spots']);
    expect(planOf(decision).target).toBe('Kitchen light and Spots');
  });

  it('reads "turn off the lights" with no place as every light in the home', async () => {
    // "No place said" and "the whole home" used to be two answers to one
    // question, and a reading stood down when it could not choose between
    // them — for a sentence where both meant the same lamps.
    const decision = await read(SET(['d1', 'd2', 'd3', 'd6']), 'выключи свет');
    expect(movedBy(decision)).toEqual(['kitchen-light', 'spots', 'tv-light', 'lamp']);
    expect(planOf(decision).target).toBe('4 lights across the home');
  });

  it('names more than three devices in one room by the room', async () => {
    const decision = await read(
      SET(['d1', 'd2', 'd3', 'd4', 'd5'], {}, 6),
      'turn off the kitchen lights',
      homeWith({ devices: lights(6) }),
    );
    expect(planOf(decision).target).toBe('5 lights in the Kitchen');
  });

  it('asks which one when one device was asked for and several fit', async () => {
    // "Switch the light off" in a home with four lights: four clear yeses to a
    // sentence that asked for one. Never all four.
    const decision = await read(SET(['d1', 'd2', 'd3', 'd6'], { single: noul(0.9) }), 'switch the light off');
    expect(standDownOf(decision)).toMatchObject({
      question: 'single',
      reason: 'unsure',
      value: 0.9,
      devices: [
        { name: 'Kitchen light', value: 0.95 },
        { name: 'Spots', value: 0.95 },
        { name: 'Light TV', value: 0.95 },
        { name: 'Bedside lamp', value: 0.95 },
      ],
    });
  });

  it('stands down when a device between yes and no could be in the set', async () => {
    const decision = await read(SET(['d1'], { ...targets({ d1: 0.95, d2: 0.5 }) }), 'kitchen lights off');
    expect(standDownOf(decision)).toMatchObject({
      question: 'targets',
      reason: 'unsure',
      devices: [
        { name: 'Kitchen light', value: 0.95 },
        { name: 'Spots', value: 0.5 },
      ],
    });
  });

  it(`switches a few on, and never more than ${ON_TARGETS_MAX} at once`, async () => {
    const few = await read(SET(['d1', 'd2'], { power: choice('on', 0.97) }), 'kitchen lights on');
    expect(movedBy(few)).toEqual(['kitchen-light', 'spots']);

    const count = ON_TARGETS_MAX + 2;
    const many = await read(
      SET(Array.from({ length: count }, (_, index) => `d${index + 1}`), { power: choice('on', 0.97) }, count),
      'turn on all the lights',
      homeWith({ devices: lights(count) }),
    );
    expect(standDownOf(many)).toMatchObject({
      question: 'action',
      reason: 'size',
      value: count,
      max: ON_TARGETS_MAX,
      because: `more than ${ON_TARGETS_MAX} devices are never switched on at once`,
    });
  });

  it('switches any number off, which is the direction that is safe to get wrong', async () => {
    const count = ON_TARGETS_MAX + 2;
    const decision = await read(
      SET(Array.from({ length: count }, (_, index) => `d${index + 1}`), {}, count),
      'turn off all the lights',
      homeWith({ devices: lights(count) }),
    );
    expect(movedBy(decision)).toHaveLength(count);
  });

  it('dims the lights that can dim and leaves the rest alone', async () => {
    const decision = await read(
      SET(['d1', 'd2'], { power: choice(UNCHANGED), brightness: choice('dimmer', 0.95) }),
      'dim the kitchen lights',
    );
    expect(commandsOf(decision)).toEqual([
      { deviceId: 'kitchen-light', endpointId: 1, command: { type: 'setLevel', level: 36 } },
    ]);
  });

  it('reads "everything" narrowly: what a person switches off leaving a room', async () => {
    const decision = await read(
      SET(['d3', 'd4', 'd5', 'd8'], { everything: noul(0.92) }),
      'turn everything off in the living room',
    );
    // The light and the TV — not the blind, not the thermostat.
    expect(movedBy(decision)).toEqual(['tv-light', 'tv']);
  });

  it('never reaches a fridge on a plug through "everything"', async () => {
    const decision = await read(
      SET(['d1', 'd2', 'd10'], { everything: noul(0.92) }),
      'everything off in the kitchen',
    );
    expect(movedBy(decision)).toEqual(['kitchen-light', 'spots']);
  });

  it('asks when it cannot tell whether "everything" was meant and a plug would be reached', async () => {
    const decision = await read(
      SET(['d1', 'd2', 'd10'], { everything: noul(0.5) }),
      'turn it all off in the kitchen',
    );
    expect(standDownOf(decision)).toMatchObject({ question: 'everything', reason: 'unsure', value: 0.5 });
  });

  it('moves a plug named for what it is', async () => {
    const decision = await read(SET(['d1', 'd10']), 'turn off the kitchen light and the fridge plug');
    expect(movedBy(decision)).toEqual(['kitchen-light', 'plug']);
  });

  it('only switches everything on or off — never gives it all a colour', async () => {
    const decision = await read(
      SET(['d3', 'd4'], { everything: noul(0.92), power: choice(UNCHANGED), colour: choice('red', 0.95) }),
      'make everything red',
    );
    expect(standDownOf(decision)).toMatchObject({
      question: 'colour',
      reason: 'blocked',
      because: 'only switching on or off, and pausing, apply to everything',
    });
  });

  it('locks every lock, and never unlocks them all', async () => {
    const home = homePlus({
      id: 'back-door',
      name: 'Back door',
      roomId: 'kitchen',
      endpoints: [{ endpointId: 1, deviceKind: 'lock', capabilities: ['doorLock'] }],
    });
    const locks = (lock: string) => SET(['d7', 'd11'], { power: choice(UNCHANGED), lock: choice(lock, 0.95) }, 11);
    const locked = await read(locks('lock'), 'lock the doors', home);
    expect(commandsOf(locked)).toEqual([
      { deviceId: 'door', endpointId: 1, command: { type: 'lock', engage: true } },
      { deviceId: 'back-door', endpointId: 1, command: { type: 'lock', engage: true } },
    ]);
    const unlocked = await read(locks('unlock'), 'unlock the doors', home);
    expect(standDownOf(unlocked)).toMatchObject({
      question: 'lock',
      reason: 'blocked',
      because: 'a group of locks is never unlocked at once',
    });
  });

  it('works every endpoint of a two-gang switch in a set', async () => {
    const decision = await read(SET(['d10', 'd11'], {}, 11), 'switch off the kitchen switches', homePlus(DOUBLE_SWITCH));
    expect(commandsOf(decision)).toEqual([
      { deviceId: 'plug', endpointId: 1, command: { type: 'power', on: false } },
      { deviceId: 'double', endpointId: 1, command: { type: 'power', on: false } },
      { deviceId: 'double', endpointId: 2, command: { type: 'power', on: false } },
    ]);
  });

  it('does not try one the hub knows is offline, and names it', async () => {
    const home = homeWith({
      devices: DEVICES.map((device) => (device.id === 'spots' ? { ...device, online: false } : device)),
    });
    const plan = planOf(await read(SET(['d1', 'd2']), 'kitchen lights off', home));
    expect(plan.actions.map((action) => action.deviceId)).toEqual(['kitchen-light']);
    expect(plan.offline).toEqual([
      { deviceName: 'Spots', roomName: 'Kitchen', wordings: [{ before: 'switched off', after: '' }] },
    ]);
  });

  it('stands down when every one of them is offline', async () => {
    const home = homeWith({
      devices: DEVICES.map((device) => (device.roomId === 'kitchen' ? { ...device, online: false } : device)),
    });
    const decision = await read(SET(['d1', 'd2']), 'kitchen lights off', home);
    expect(standDownOf(decision)).toMatchObject({
      question: 'action',
      reason: 'blocked',
      because: 'every device it was asked about is offline',
    });
  });

  it('stands down on more commands than one request may send', async () => {
    const count = MAX_COMMANDS + 6;
    const decision = await read(
      SET(Array.from({ length: count }, (_, index) => `d${index + 1}`), {}, count),
      'kitchen lights off',
      homeWith({ devices: lights(count) }),
    );
    expect(standDownOf(decision)).toMatchObject({
      question: 'action',
      reason: 'size',
      value: count,
      max: MAX_COMMANDS,
    });
  });
});

/* ------------------------------------------------------------------ */

describe('the shape of a sentence', () => {
  it('splits several different things, and carries the reading of the whole along', async () => {
    const decision = await read(
      { ...OFF_KITCHEN_LIGHT, shape: choice(SHAPE_SEVERAL, 0.8) },
      'turn off the kitchen light and close the blind',
    );
    expect(decision).toMatchObject({ kind: 'split', confidence: 0.8 });
    if (decision.kind !== 'split') throw new Error('expected a split');
    // For a split that comes back as one part: nothing more to pay to act.
    expect(decision.whole.kind).toBe('act');
    // A small home's parts are asked about all of it…
    expect(decision.candidates).toEqual(DEVICES.map((device) => device.id));
    // …and the split is told the names it could cut in two.
    expect(decision.deviceNames).toEqual([
      'Kitchen light',
      'Light TV',
      'Bedside lamp',
      'Front door',
      'Ceiling fan',
      'Fridge plug',
    ]);
  });

  it('carries the reason along when the whole sentence could not have been acted on', async () => {
    const decision = await read(
      { ...OFF_KITCHEN_LIGHT, shape: choice(SHAPE_SEVERAL, 0.8), later: noul(0.9) },
      'turn off the light and close the blind at seven',
    );
    if (decision.kind !== 'split') throw new Error('expected a split');
    expect(decision.whole).toMatchObject({
      kind: 'none',
      standDown: { question: 'later', reason: 'blocked', durationMs: 180 },
    });
  });

  it('shortlists the devices a split sentence mentions, likeliest first, in a larger home', async () => {
    const count = 40;
    const decision = await read(
      {
        ...SET([], { device: choice(NONE_OF_THESE, 0.85, { [NONE_OF_THESE]: 0.85, d12: 0.15 }) }, count),
        ...targets({ d7: 0.9, d3: 0.8 }, count),
        shape: choice(SHAPE_SEVERAL, 0.8),
      },
      'turn off light 6 and light 2',
      homeWith({ devices: lights(count) }),
    );
    if (decision.kind !== 'split') throw new Error('expected a split');
    expect(decision.candidates).toHaveLength(PART_CANDIDATES_MAX);
    expect(decision.candidates.slice(0, 3)).toEqual(['light-6', 'light-2', 'light-11']);
  });

  it('does not split one action on several devices', async () => {
    const decision = await read(SET(['d1', 'd4']), 'turn off the kitchen light and the TV');
    expect(decision.kind).toBe('act');
  });

  it('does the one thing said beside a question, and leaves the question to the model', async () => {
    const decision = await read(
      {
        ...ONE('d9'),
        shape: choice(SHAPE_ONE_AND_MORE, 0.9),
        // Read whole, the sentence is as much a question as a command.
        intent: choice('home_question', 0.6),
      },
      'switch the fan off and tell me the time',
    );
    expect(movedBy(decision)).toEqual(['fan']);
    // The question is still the model's, so this was not everything.
    expect(decision).toMatchObject({ kind: 'act', complete: false });
  });

  it('leaves a sentence that is neither clearly one thing nor clearly several to the model', async () => {
    const decision = await read(
      {
        ...OFF_KITCHEN_LIGHT,
        shape: choice(SHAPE_ONE, 0.6, { [SHAPE_ONE]: 0.6, [SHAPE_SEVERAL]: 0.3, [SHAPE_NOTHING]: 0.1 }),
      },
      'kitchen light off and so on',
    );
    expect(standDownOf(decision)).toMatchObject({
      question: 'shape',
      reason: 'unsure',
      label: 'one thing to do',
      runnerUp: 'several different things to do',
      value: 0.6,
      min: ACT_CONFIDENCE_MIN,
    });
  });

  it('reads a question as nothing to do, in its own words when it has them', async () => {
    const question = await read(
      { ...OFF_KITCHEN_LIGHT, shape: choice(SHAPE_NOTHING, 0.95), intent: choice('home_question', 0.95) },
      'is the door locked and what is the temperature',
    );
    expect(standDownOf(question)).toMatchObject({
      question: 'intent',
      reason: 'declined',
      label: 'a question about the home',
    });

    const chat = await read(
      { ...OFF_KITCHEN_LIGHT, shape: choice(SHAPE_NOTHING, 0.95), intent: choice('other', 0.6) },
      'nice weather',
    );
    expect(standDownOf(chat)).toMatchObject({ question: 'shape', reason: 'declined', label: 'nothing to do' });
  });

  it('routes a confident, self-contained automation request', async () => {
    const decision = await read(
      {
        ...OFF_KITCHEN_LIGHT,
        shape: choice(SHAPE_NOTHING, 0.9),
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
        shape: choice(SHAPE_NOTHING, 0.9),
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

  it('never hands a device command away', async () => {
    const decision = await read(
      { ...OFF_KITCHEN_LIGHT, route: choice('automations', 0.97), selfContained: noul(0.95) },
      'turn off the kitchen light',
    );
    expect(decision.kind).toBe('act');
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
    ['no device of this home was named', { device: choice(NONE_OF_THESE, 0.95), ...targets() }, 'targets', 'blocked'],
    ['it cannot tell which device', { device: choice('d1', 0.5), ...targets({ d1: 0.6 }) }, 'targets', 'unsure'],
    ['the action is a guess', { power: choice('off', 0.5) }, 'power', 'unsure'],
    ['it asks nothing of this device', { power: choice(UNCHANGED, 0.95) }, 'action', 'blocked'],
    ['it heard something other than a device command', { intent: choice('scene', 0.6) }, 'intent', 'unsure'],
    ['it is a question rather than a command', { intent: choice('home_question', 0.99) }, 'intent', 'declined'],
    ['it is about something else entirely', { intent: choice('other', 0.99) }, 'intent', 'declined'],
    [
      'it cannot tell how many things were asked',
      { shape: choice(SHAPE_ONE, 0.6, { [SHAPE_ONE]: 0.6, [SHAPE_SEVERAL]: 0.4 }) },
      'shape',
      'unsure',
    ],
    ['how many things went unanswered', { shape: undefined }, 'shape', 'unanswered'],
    ['the device choice went unanswered', { device: undefined }, 'device', 'unanswered'],
    ["a device's own yes/no went unanswered", { target_d5: undefined }, 'targets', 'unanswered'],
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

  it('names the devices it could not tell about, each with its own number', async () => {
    const decision = await read({
      ...OFF_KITCHEN_LIGHT,
      device: choice('d1', 0.5, { d1: 0.52, d2: 0.4, [NONE_OF_THESE]: 0.08 }),
      ...targets({ d1: 0.62, d2: 0.55 }),
    });
    expect(standDownOf(decision)).toMatchObject({
      question: 'targets',
      reason: 'unsure',
      devices: [
        { name: 'Kitchen light', value: 0.62 },
        { name: 'Spots', value: 0.55 },
      ],
      min: TARGET_YES,
      max: TARGET_NO,
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

  const OFF_TV = ONE('d4');
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
    // A part is split to be one thing, so how many things it asks is a guard…
    expect(ids).toContain('p0_shape');
    // …each part has its own yes/no for each device…
    expect(ids).toContain('p0_target_d4');
    expect(ids).toContain('p1_target_d1');
    // …and only the part with a number is asked what it is of.
    expect(ids).not.toContain('p0_amount');
    expect(ids).toContain('p1_amount');
    // The routing questions are the sentence's, not a part's.
    expect(ids).not.toContain('p0_route');
    expect(ids).not.toContain('p0_effort');
    expect(stub.states[0]).toEqual({
      parts: ['turn off the TV', 'set the kitchen light to 40%'],
      amounts: [null, '40%'],
    });
    const asked = stub.asked[0] as Record<string, { instructions: string }>;
    expect(asked['p1_intent']?.instructions).toContain('`parts[1]`');
    expect(asked['p1_target_d1']?.instructions).toContain('`parts[1]`');
    expect(asked['p1_amount']?.instructions).toContain('`amounts[1]`');
  });

  it('asks the parts about the shortlist rather than the whole house', async () => {
    const stub = decider({});
    await decideParts({
      decider: stub,
      home: HOME,
      parts: ['turn off the TV', 'close the blind'],
      // Likeliest first, and an id the home no longer has is simply not asked about.
      candidates: ['tv', 'blind', 'no-such-device'],
    });
    const asked = stub.asked[0] as Record<string, { criteria: Record<string, string> }>;
    expect(Object.keys(asked['p0_device']?.criteria ?? {})).toEqual(['d1', 'd2', NONE_OF_THESE]);
    expect(asked['p0_device']?.criteria['d1']).toBe('"TV" — a TV in the Living room, Downstairs.');
    expect(Object.keys(asked).filter((id) => id.startsWith('p0_target_'))).toEqual([
      'p0_target_d1',
      'p0_target_d2',
    ]);
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

  it('leaves a part that still asks for several things to the model', async () => {
    const result = await decideParts({
      decider: decider(under('p0_', { ...OFF_TV, shape: choice(SHAPE_SEVERAL, 0.8) })),
      home: HOME,
      parts: ['turn off the TV and open the blind'],
    });
    expect(result.parts[0]?.reading).toMatchObject({
      kind: 'none',
      standDown: { question: 'shape', reason: 'blocked', value: 0.8, max: NEGATIVE_NOUL_MAX },
    });
  });

  it('leaves a part it is not sure is a command to the model', async () => {
    // A part stands on its own, so it has to be sure of itself.
    const result = await decideParts({
      decider: decider(under('p0_', { ...OFF_TV, intent: choice('device_command', 0.6) })),
      home: HOME,
      parts: ['the TV'],
    });
    expect(result.parts[0]?.reading).toMatchObject({
      kind: 'none',
      standDown: { question: 'intent', reason: 'unsure', value: 0.6, min: ACT_CONFIDENCE_MIN },
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

  it('lists the devices it could not tell about, and the two bars they sat between', () => {
    const words = describeStandDown({
      ...base,
      question: 'targets',
      reason: 'unsure',
      devices: [
        { name: 'Kitchen light', value: 0.62 },
        { name: 'Spots', value: 0.55 },
      ],
      min: TARGET_YES,
      max: TARGET_NO,
    });
    expect(words.text).toBe("Jev wasn't sure which devices were meant");
    expect(words.detail).toBe('Kitchen light 0.62, Spots 0.55 — each needs 0.75, or at most 0.35 · 180 ms');
  });

  it('says when one device was asked for and several fit', () => {
    const words = describeStandDown({
      ...base,
      question: 'single',
      reason: 'unsure',
      value: 0.9,
      devices: [
        { name: 'Kitchen light', value: 0.95 },
        { name: 'Spots', value: 0.9 },
      ],
    });
    expect(words.text).toBe('Jev heard one device asked for, and more than one fits');
    expect(words.detail).toBe('one device: 0.90 · Kitchen light 0.95, Spots 0.90 · 180 ms');
  });

  it('says what a yes/no was the probability of, so the number never stands alone', () => {
    const words = describeStandDown({
      ...base,
      question: 'later',
      reason: 'blocked',
      value: 0.8,
      max: NEGATIVE_NOUL_MAX,
    });
    expect(words.text).toBe('Jev heard a time, a delay or a condition');
    expect(words.detail).toBe('later or on a condition: 0.80, needs at most 0.40 · 180 ms');
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

  it("says when the choice and the device's own yes/no pointed different ways", () => {
    const words = describeStandDown({
      ...base,
      question: 'targets',
      reason: 'disagreed',
      answer: 'd1',
      label: 'Kitchen light',
      value: 0.2,
      device: 'Kitchen light',
    });
    expect(words.text).toBe('Jev picked Kitchen light, then read it as not asked for');
    expect(words.detail).toBe('its own yes/no: 0.20 · 180 ms');
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

  it('says a request was too big, and by how much', () => {
    const words = describeStandDown({ ...base, question: 'action', reason: 'size', value: 30, max: MAX_COMMANDS });
    expect(words.text).toBe('Jev found more devices than one request may move');
    expect(words.detail).toBe(`30 commands, up to ${MAX_COMMANDS} · 180 ms`);
  });

  it('says it never switches that many on at once', () => {
    const words = describeStandDown({
      ...base,
      question: 'action',
      reason: 'size',
      value: 8,
      max: ON_TARGETS_MAX,
      because: `more than ${ON_TARGETS_MAX} devices are never switched on at once`,
    });
    expect(words.text).toBe(`Jev stood down: more than ${ON_TARGETS_MAX} devices are never switched on at once`);
    expect(words.detail).toBe('8 devices · 180 ms');
  });

  /**
   * **Most stand-downs are the design working**, and the trail is where a
   * person reads. A step on every question somebody asks would bury the one
   * that matters — so a sentence read confidently as nothing to do is logged
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
    expect(
      describeStandDown({
        ...base,
        question: 'shape',
        reason: 'declined',
        answer: SHAPE_NOTHING,
        label: 'nothing to do',
        value: 0.95,
      }),
    ).toMatchObject({ phrase: 'read it as nothing to do', audience: 'logged' });
    expect(describeStandDown({ question: 'model', reason: 'missed', miss: 'off' }).audience).toBe('quiet');
    expect(describeStandDown({ question: 'home', reason: 'size', value: 0, max: 180 }).audience).toBe('quiet');
  });

  it('has words for every option the battery can answer', () => {
    // An option added to a question without words here would reach a trail
    // as an identifier — `one_and_more: 0.62` is a sentence only its author
    // can read.
    const options = [
      intentQuestion(),
      shapeQuestion([]),
      amountQuestion(),
      deviceQuestion([]),
      routeQuestion([]),
      ...FAMILIES.map((family) => familyQuestion(family)),
    ].flatMap((question) => Object.keys(question.criteria));
    for (const option of options) {
      expect(OPTION_WORDS[option], option).toBeDefined();
    }
  });
});
