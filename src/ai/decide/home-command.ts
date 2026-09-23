/**
 * Working out, in one request, what somebody asked the home to do — and which
 * commands, on which devices, that means.
 *
 * This is the vendor's own smart-home shape, step for step: one request
 * carrying the routing questions *and* every family's action question at once,
 * of which the code reads exactly the ones the resolved devices select. The
 * action questions are speculative because that is free — the questions are
 * answered in parallel, latency is roughly flat in their number, and a second
 * request would cost more than all of them together. A sentence that is
 * several requests is split by a generative model and its parts read here in
 * one more request (`decideParts`), which is the demo's other half.
 *
 * **It is a skip-ahead and nothing else.** Every gate below falls through to
 * the assistant round that would have happened anyway, so being unsure, being
 * wrong about the shape, or not answering at all each cost exactly what the
 * hub cost before. What it must never do is widen what is possible: every
 * command it returns is carried out through the same path the model's own tool
 * takes, past the same guards, into the same activity row.
 *
 * `docs/jev.md` is canonical.
 */
import type {
  CapabilityKind,
  DeviceKind,
  EndpointState,
  HubCommand,
} from '../../schema/index.js';
import type { Decider, DecisionAnswer, DecisionMiss, Questions } from './decider.js';
import {
  ACT_CONFIDENCE_MIN,
  ANY_COMMAND_QUESTION,
  DECISION_TIMEOUT_MS,
  EFFORT_CONFIDENCE_MIN,
  EFFORT_QUESTION,
  EFFORT_SIMPLE_MAX,
  FAMILIES,
  MAX_COMMANDS,
  MAX_DEVICE_OPTIONS,
  MAX_PARTS,
  NEGATIVE_NOUL_MAX,
  NONE_OF_THESE,
  NOT_SAID,
  POSITIVE_NOUL_MIN,
  SELF_CONTAINED_QUESTION,
  SPLIT_NOUL_MIN,
  UNCHANGED,
  WHOLE_HOME,
  amountIn,
  amountQuestion,
  deviceQuestion,
  deviceTypeQuestion,
  familyQuestion,
  intentQuestion,
  laterQuestion,
  multipleQuestion,
  negatedQuestion,
  placeQuestion,
  routeQuestion,
  scopeQuestion,
  type DeviceOption,
  type Family,
  type PlaceOption,
  type Subject,
} from './questions.js';

/* ------------------------------------------------------------------ *
 * The home, as a reading needs it.
 * ------------------------------------------------------------------ */

/** One device, as the decider is told about it and answers over. */
export interface DecidableDevice {
  id: string;
  name: string;
  roomId: string | null;
  online?: boolean | undefined;
  endpoints: readonly {
    endpointId: number;
    deviceKind?: DeviceKind | undefined;
    capabilities: readonly CapabilityKind[];
  }[];
}

/** What the decider is told about the home, and what it answers over. */
export interface DecidableHome {
  rooms: readonly { id: string; name: string; zoneId?: string | null | undefined }[];
  zones?: readonly { id: string; name: string }[] | undefined;
  devices: readonly DecidableDevice[];
  /**
   * What a device reports right now — for the requests that are relative to
   * it: brighter, warmer, faster, and "switch it on first" for a light that is
   * off. Code does that arithmetic; the model never sees a value.
   */
  stateOf?: ((deviceId: string, endpointId: number) => EndpointState | undefined) | undefined;
}

/* ------------------------------------------------------------------ *
 * What a reading concludes.
 * ------------------------------------------------------------------ */

/**
 * What was done to a device, in the two forms it is said in.
 *
 * `phrase` puts the device in the middle — "set **Light TV** to 40%
 * brightness" — and the participle leaves it out — "set to 40% brightness".
 * The trail uses the first ("Jev set Light TV to 40% brightness") and the
 * model's priming the second ("Light TV (Living room): set to 40%
 * brightness"), so neither has to be parsed back out of the other.
 */
export interface Wording {
  before: string;
  after: string;
}

/** One device, and the commands the reading resolved for it. */
export interface DeviceAction {
  deviceId: string;
  deviceName: string;
  roomName?: string | undefined;
  commands: { endpointId: number; command: HubCommand }[];
  /** What this device will have had done to it, in order. */
  wordings: Wording[];
}

/** Everything one request resolved to — one device or a group of them. */
export interface CommandPlan {
  actions: DeviceAction[];
  /**
   * What it was done to, the way a person says it: a device's own name, or
   * "4 lights in the Kitchen".
   */
  target: string;
  /** Whether `target` is several things — "them" rather than "it". */
  plural: boolean;
  /** What was done, for the whole plan — the family's words, before any per-device extras. */
  wordings: Wording[];
  /**
   * Members of a group the hub already knows are offline, left out of
   * `actions` — see the group arm of `readSubject`. Always empty for one
   * device, which is tried whatever it last reported: it was named, and the
   * adapter's answer is the true one.
   */
  offline: { deviceName: string; roomName?: string | undefined; wordings: Wording[] }[];
  /**
   * The weakest link in the chain of answers the plan rests on — which is the
   * honest one to report, and the vendor's own function-calling cookbook's
   * rule: one wrong argument spoils the call.
   */
  confidence: number;
}

/**
 * Why a reading ended without acting — the question that settled it, what it
 * answered, and the number it was measured by.
 *
 * **Every `none` carries one, because "why was that slow?" deserves a better
 * answer than a guess.** A stand-down used to leave no trace at all: the round
 * that followed was the one that would have run anyway, so a light that took
 * four seconds instead of one looked exactly like a hub without a key, and the
 * only way to learn which question had fallen short was to replay the sentence
 * by hand. `AssistantChat` writes this into the log on every turn, and into the
 * trail when it is a stand-down somebody could have expected to go the other
 * way — `describeStandDown` is where that line is drawn.
 *
 * **One flat shape, so the log line and the trail step are drawn from the same
 * facts** and cannot come to disagree about why. `question` is the battery's
 * own id, or `home` for the size bound, `model` when nothing came back, and
 * `split` when the parts of a sentence could not be had.
 */
export interface StandDown {
  question: string;
  /**
   * - `missed` — no reading came back; `miss` says why when the decider did.
   * - `size` — the home was empty, too big to offer as options, or the group
   *   it resolved to was bigger than one request may move.
   * - `unanswered` — the reading left out a question this path needs.
   * - `unsure` — the answer did not clear its bar.
   * - `declined` — sure, and sure it was not a device command: the ordinary
   *   case for every question somebody asks, and not a failure of anything.
   * - `blocked` — sure, and sure of something this path never acts on: a
   *   delay, a change of mind, no matching device, an unlock of a whole house.
   * - `disagreed` — the place and the device were both confident, and pointed
   *   at different places.
   */
  reason: 'missed' | 'size' | 'unanswered' | 'unsure' | 'declined' | 'blocked' | 'disagreed';
  miss?: DecisionMiss;
  /** The option it chose, by its own id. */
  answer?: string;
  /** The same, as a person reads it — a thing's own name, or `OPTION_WORDS`. */
  label?: string;
  /**
   * The option it nearly chose, as a person reads it, when the distribution
   * was genuinely split — which is what an unsure answer usually *is*.
   */
  runnerUp?: string;
  /** The number it was measured by: a confidence, a noul, a device count. */
  value?: number;
  /** The bar that number had to reach… */
  min?: number;
  /** …or stay at or under. */
  max?: number;
  /** The device the reading got as far as, by name. */
  device?: string;
  /** For `disagreed`: where that device really is. */
  deviceRoom?: string;
  /** Why a `blocked` was blocked, when the option alone does not say. */
  because?: string;
  /** How long the reading took — or, for a timeout, how long it was waited for. */
  durationMs?: number;
  /** The request had to open a connection first. */
  newConnection?: boolean;
  /** The vendor's own id for the request, so a log line can be traced. */
  requestId?: string;
  /** For one part of a split sentence: which part. */
  part?: string;
}

/**
 * What one reading of a sentence concluded about how hard the round should
 * work. `'low'` or nothing: this may only ever make a round cheaper — see
 * `EFFORT_QUESTION` on why the other direction is not offered.
 */
export type EffortHint = 'low' | undefined;

/** How one reading was paid for and how long it took, carried on every arm. */
interface Reading {
  costUsd: number;
  durationMs: number;
  newConnection?: boolean | undefined;
  requestId?: string | undefined;
}

/** What one reading of a sentence concluded. */
export type HomeDecision =
  /** Carry these out — one device or a group. */
  | ({ kind: 'act'; plan: CommandPlan; effort: EffortHint } & Reading)
  /** Hand the whole sentence to this agent, as its own brief. */
  | ({ kind: 'route'; agentKey: string; confidence: number; effort: EffortHint } & Reading)
  /**
   * Several requests, at least one a command: split it into its parts, and
   * read those (`decideParts`).
   */
  | ({ kind: 'split'; confidence: number; effort: EffortHint } & Reading)
  | { kind: 'none'; costUsd: number; effort: EffortHint; standDown: StandDown };

/** What reading each part of a split sentence concluded. */
export interface PartsDecision extends Reading {
  parts: {
    text: string;
    reading: { kind: 'act'; plan: CommandPlan } | { kind: 'none'; standDown: StandDown };
  }[];
}

/* ------------------------------------------------------------------ *
 * The vocabularies code owns.
 * ------------------------------------------------------------------ */

/**
 * Which capability each family is read for.
 *
 * **The device decides which answers are read, never the sentence.** A family
 * is only consulted for a device that has one of these; the rest were asked
 * under a premise that did not hold and are ignored. "Turn off the TV" read as
 * if it were about the heating says "off", and that answer must never reach a
 * thermostat.
 */
const FAMILY_CAPABILITIES: Readonly<Record<Family, readonly CapabilityKind[]>> = {
  power: ['onOff'],
  brightness: ['level'],
  colour: ['color', 'colorTemperature'],
  cover: ['windowCovering'],
  lock: ['doorLock'],
  playback: ['mediaPlayback'],
  climate: ['thermostat'],
  fan: ['fan'],
};

/** What the device question calls a kind of device, and a group of them. */
const KIND_WORDS: Readonly<Record<DeviceKind, { one: string; many: string }>> = {
  light: { one: 'A light', many: 'lights' },
  outlet: { one: 'A plug or socket', many: 'plugs' },
  wallSwitch: { one: 'A wall switch', many: 'switches' },
  shade: { one: 'A blind or curtain', many: 'blinds' },
  lock: { one: 'A door lock', many: 'locks' },
  tv: { one: 'A TV', many: 'TVs' },
  speaker: { one: 'A speaker', many: 'speakers' },
  fan: { one: 'A fan', many: 'fans' },
  airPurifier: { one: 'An air purifier', many: 'air purifiers' },
  climate: { one: 'A thermostat or heater', many: 'thermostats' },
  vacuum: { one: 'A robot vacuum', many: 'vacuums' },
  appliance: { one: 'An appliance', many: 'appliances' },
  sensor: { one: 'A sensor', many: 'sensors' },
  camera: { one: 'A camera', many: 'cameras' },
  energy: { one: 'An energy meter', many: 'meters' },
  remote: { one: 'A remote or button', many: 'remotes' },
};

/**
 * Which devices a group is made of.
 *
 * **"Everything" is read narrowly, and that is a safety rule rather than a
 * gap.** "Turn everything off in the kitchen" means the lights, the TV and the
 * fan — not the fridge on a smart plug, the heating, or the lock on the back
 * door. So `everything` is the things somebody switches off when they leave a
 * room, and a plug, an appliance or a thermostat is only ever moved when it is
 * named for what it is ("the plugs in the kitchen").
 */
const GROUP_KINDS: Readonly<Record<string, { kinds: readonly DeviceKind[]; capability?: CapabilityKind }>> = {
  lights: { kinds: ['light'] },
  sockets: { kinds: ['outlet', 'wallSwitch'] },
  blinds: { kinds: ['shade'], capability: 'windowCovering' },
  locks: { kinds: ['lock'], capability: 'doorLock' },
  media: { kinds: ['tv', 'speaker'] },
  fans: { kinds: ['fan', 'airPurifier'] },
  climate: { kinds: ['climate'], capability: 'thermostat' },
  everything: { kinds: ['light', 'wallSwitch', 'tv', 'speaker', 'fan', 'airPurifier'] },
};

/** How a group of each kind is named in a sentence, when it has one name. */
const GROUP_WORDS: Readonly<Record<string, string>> = {
  lights: 'lights',
  sockets: 'plugs',
  blinds: 'blinds',
  locks: 'locks',
  media: 'TVs and speakers',
  fans: 'fans',
  climate: 'thermostats',
  everything: 'devices',
};

/** Hue and saturation in cluster units (0–254) for each named colour. */
const COLOURS: Readonly<Record<string, { hue: number; saturation: number; words: string }>> = {
  red: { hue: 0, saturation: 254, words: 'red' },
  orange: { hue: 21, saturation: 254, words: 'orange' },
  yellow: { hue: 42, saturation: 254, words: 'yellow' },
  green: { hue: 85, saturation: 254, words: 'green' },
  cyan: { hue: 127, saturation: 254, words: 'cyan' },
  blue: { hue: 170, saturation: 254, words: 'blue' },
  purple: { hue: 198, saturation: 254, words: 'purple' },
  pink: { hue: 233, saturation: 180, words: 'pink' },
};

/** Colour temperatures in mireds for each named white: 2700 K, 4000 K, 6500 K. */
const WHITES: Readonly<Record<string, { mireds: number; words: string }>> = {
  warm_white: { mireds: 370, words: 'warm white' },
  neutral_white: { mireds: 250, words: 'neutral white' },
  cool_white: { mireds: 154, words: 'cool white' },
};

/** How far "brighter" and "dimmer" move a light: a quarter of the range. */
const LEVEL_STEP = 64;
/** How far "warmer" and "cooler" move a setpoint: one degree, in centi-°C. */
const SETPOINT_STEP_CENTI = 100;
/** How far "faster" and "slower" move a fan set by percent. */
const FAN_PERCENT_STEP = 25;
/** A temperature somebody could mean for a room, in °C. Outside it, the model decides. */
const SETPOINT_RANGE = { min: 5, max: 35 } as const;

/** SystemMode values — 0 off, 1 auto, 3 cool, 4 heat. */
const SYSTEM_MODES: Readonly<Record<string, number>> = { off: 0, auto: 1, cool: 3, heat: 4 };
/** FanMode values — 0 off, 1 low, 2 medium, 3 high, 4 on, 5 auto. */
const FAN_MODES: Readonly<Record<string, number>> = { off: 0, low: 1, medium: 2, high: 3, on: 4, auto: 5 };

/**
 * Each of the battery's own options, the way a person reads it.
 *
 * A stand-down is written for somebody asking why their light took four
 * seconds, and `device_command: 0.62` is a sentence only its author can read.
 * Keyed by the option ids in `questions.ts`, and `test/ai-decide-questions.
 * test.ts` holds the two together, so an option added there without words here
 * fails a test rather than reaching a trail as an identifier.
 */
export const OPTION_WORDS: Readonly<Record<string, string>> = {
  device_command: 'a device command',
  home_question: 'a question about the home',
  scene: 'a scene',
  automation_work: 'an automation',
  app_question: 'a question about the app',
  other: 'something else',
  one_device: 'one device',
  several_devices: 'several devices',
  group: 'a group of devices',
  none: 'no device',
  [WHOLE_HOME]: 'the whole home',
  [NOT_SAID]: 'no place',
  lights: 'lights',
  sockets: 'plugs',
  blinds: 'blinds',
  locks: 'locks',
  media: 'TVs and speakers',
  fans: 'fans',
  climate: 'heating and cooling',
  everything: 'everything',
  on: 'on',
  off: 'off',
  brighter: 'brighter',
  dimmer: 'dimmer',
  full: 'full brightness',
  lowest: 'lowest brightness',
  percent: 'a percentage',
  red: 'red',
  orange: 'orange',
  yellow: 'yellow',
  green: 'green',
  cyan: 'cyan',
  blue: 'blue',
  purple: 'purple',
  pink: 'pink',
  warm_white: 'warm white',
  neutral_white: 'neutral white',
  cool_white: 'cool white',
  open: 'open',
  close: 'close',
  stop: 'stop',
  half: 'halfway',
  lock: 'lock',
  unlock: 'unlock',
  play: 'play',
  pause: 'pause',
  heat: 'heat',
  cool: 'cool',
  auto: 'auto',
  warmer: 'warmer',
  cooler: 'cooler',
  degrees: 'a temperature',
  low: 'low',
  medium: 'medium',
  high: 'high',
  faster: 'faster',
  slower: 'slower',
  brightness: 'a brightness',
  temperature: 'a temperature',
  fan_speed: 'a fan speed',
  time: 'a time',
  name: 'part of a name',
  [UNCHANGED]: 'unchanged',
  here: 'the assistant',
  [NONE_OF_THESE]: 'none of these',
};

/* ------------------------------------------------------------------ *
 * The catalog: the home's names as option keys.
 * ------------------------------------------------------------------ */


interface Catalog {
  deviceOptions: DeviceOption[];
  deviceByKey: Map<string, DecidableDevice>;
  placeOptions: PlaceOption[];
  placeByKey: Map<string, { kind: 'room' | 'zone'; id: string; name: string }>;
  roomName: Map<string, string>;
  zoneOfRoom: Map<string, string>;
  zoneName: Map<string, string>;
}

/** The kind a device is best described as — the first endpoint that says. */
function kindOf(device: DecidableDevice): DeviceKind | undefined {
  return device.endpoints.find((endpoint) => endpoint.deviceKind !== undefined)?.deviceKind;
}

function catalogOf(home: DecidableHome): Catalog {
  const roomName = new Map(home.rooms.map((room) => [room.id, room.name]));
  const zoneName = new Map((home.zones ?? []).map((zone) => [zone.id, zone.name]));
  const zoneOfRoom = new Map<string, string>();
  for (const room of home.rooms) {
    if (room.zoneId !== null && room.zoneId !== undefined) zoneOfRoom.set(room.id, room.zoneId);
  }

  // Short plain keys, the name in the description — see `PlaceOption`.
  const deviceOptions: DeviceOption[] = [];
  const deviceByKey = new Map<string, DecidableDevice>();
  for (const [index, device] of home.devices.entries()) {
    const room = device.roomId !== null ? roomName.get(device.roomId) : undefined;
    const key = `d${index + 1}`;
    const kind = kindOf(device);
    deviceOptions.push({
      key,
      name: device.name,
      kindWords: kind !== undefined ? KIND_WORDS[kind].one : 'A device',
      roomName: room,
    });
    deviceByKey.set(key, device);
  }

  const placeOptions: PlaceOption[] = [];
  const placeByKey = new Map<string, { kind: 'room' | 'zone'; id: string; name: string }>();
  for (const [index, room] of home.rooms.entries()) {
    const zone = zoneOfRoom.has(room.id) ? zoneName.get(zoneOfRoom.get(room.id)!) : undefined;
    const key = `r${index + 1}`;
    placeOptions.push({ key, kind: 'room', name: room.name, zoneName: zone });
    placeByKey.set(key, { kind: 'room', id: room.id, name: room.name });
  }
  for (const [index, zone] of (home.zones ?? []).entries()) {
    const key = `z${index + 1}`;
    placeOptions.push({ key, kind: 'zone', name: zone.name });
    placeByKey.set(key, { kind: 'zone', id: zone.id, name: zone.name });
  }

  return { deviceOptions, deviceByKey, placeOptions, placeByKey, roomName, zoneOfRoom, zoneName };
}

/* ------------------------------------------------------------------ *
 * Reading one request's answers.
 * ------------------------------------------------------------------ */

/**
 * How far below the winner a split distribution has to be before the
 * runner-up is named.
 *
 * An unsure answer is usually *two* answers, and naming the second is what
 * turns a bare number into a reason — "the TV light or the ceiling light".
 * Below a tenth it is noise rather than a rival, and naming it would invent a
 * doubt the model never had.
 */
const RUNNER_UP_MIN = 0.1;

/** The option a split distribution nearly chose, when it genuinely nearly did. */
function runnerUpOf(answer: {
  choice: string;
  probabilities: Readonly<Record<string, number>>;
}): string | undefined {
  let best: { option: string; probability: number } | undefined;
  for (const [option, probability] of Object.entries(answer.probabilities)) {
    if (option === answer.choice || probability < RUNNER_UP_MIN) continue;
    if (best === undefined || probability > best.probability) best = { option, probability };
  }
  return best?.option;
}

type ChoiceRead = Extract<DecisionAnswer, { type: 'choice' }>;
type NoulRead = Extract<DecisionAnswer, { type: 'noul' }>;

/** The answers to one subject's questions, by the battery's own ids. */
interface SubjectAnswers {
  choice(id: string): ChoiceRead | undefined;
  noul(id: string): NoulRead | undefined;
}

type SubjectReading = { kind: 'act'; plan: CommandPlan } | { kind: 'none'; standDown: StandDown };

/** A stand-down, with nothing about the request that produced it yet. */
function stood(standDown: StandDown): SubjectReading {
  return { kind: 'none', standDown };
}

/**
 * Whether a command only ever switches something off or shuts it — what a
 * group may send across the whole home when no place was said. Pausing,
 * locking and a mode of 0 are the same direction as switching off: each is
 * safe to get wrong, and one tap puts it back.
 */
function switchesOff(command: HubCommand): boolean {
  switch (command.type) {
    case 'power':
      return !command.on;
    case 'playPause':
      return !command.play;
    case 'lock':
      return command.engage;
    case 'setFanMode':
    case 'setSystemMode':
      return command.mode === 0;
    default:
      return false;
  }
}

/**
 * Read one request — the sentence, or one part of a split sentence — into a
 * plan, or say why not.
 *
 * Everything here is code over typed answers: which device, which endpoint,
 * which command, and every number. The model has already said what it thinks
 * each thing is; this decides whether that is enough to act on.
 */
function readSubject(input: {
  answers: SubjectAnswers;
  catalog: Catalog;
  home: DecidableHome;
  amount: { text: string; value: number } | undefined;
  /** A part of a split sentence rather than the sentence itself. */
  part: boolean;
}): SubjectReading {
  const { answers, catalog, home } = input;
  /** An option as a person reads it: a thing's own name, or the battery's words for it. */
  const spoken = (option: string): string =>
    catalog.deviceByKey.get(option)?.name ??
    catalog.placeByKey.get(option)?.name ??
    OPTION_WORDS[option] ??
    option;
  /** What a choice answered, its number, and what it nearly answered instead. */
  const read = (answer: ChoiceRead) => {
    const nearly = runnerUpOf(answer);
    return {
      answer: answer.choice,
      label: spoken(answer.choice),
      value: answer.confidence,
      ...(nearly !== undefined ? { runnerUp: spoken(nearly) } : {}),
    };
  };
  /** A choice this path needs, confident — or the stand-down saying why not. */
  const sure = (id: string): ChoiceRead | StandDown => {
    const answer = answers.choice(id);
    if (answer === undefined) return { question: id, reason: 'unanswered' };
    if (answer.confidence < ACT_CONFIDENCE_MIN) {
      return { question: id, reason: 'unsure', ...read(answer), min: ACT_CONFIDENCE_MIN };
    }
    return answer;
  };
  const isStandDown = (value: ChoiceRead | StandDown): value is StandDown => 'reason' in value;
  /** A guard that has to read as a clear no. */
  const guard = (id: string): StandDown | undefined => {
    const answer = answers.noul(id);
    if (answer === undefined) return { question: id, reason: 'unanswered' };
    if (answer.noul > NEGATIVE_NOUL_MAX) {
      return { question: id, reason: 'blocked', value: answer.noul, max: NEGATIVE_NOUL_MAX };
    }
    return undefined;
  };

  const intent = sure('intent');
  if (isStandDown(intent)) return stood(intent);
  if (intent.choice !== 'device_command') {
    return stood({ question: 'intent', reason: 'declined', ...read(intent) });
  }

  // A time, a delay or a condition ends it: nothing here can wait, and a
  // command read without its "at seven" would happen now.
  const later = guard('later');
  if (later !== undefined) return stood(later);
  // So does taking something back — "on — no, off" is for the model to read whole.
  const negated = guard('negated');
  if (negated !== undefined) return stood(negated);
  // A part was split to be one request; if it is still several, it is the model's.
  if (input.part) {
    const multiple = guard('multiple');
    if (multiple !== undefined) return stood(multiple);
  }

  const scope = sure('scope');
  if (isStandDown(scope)) return stood(scope);
  if (scope.choice !== 'one_device' && scope.choice !== 'group') {
    return stood({ question: 'scope', reason: 'blocked', ...read(scope) });
  }

  const families = new Map<Family, ChoiceRead | undefined>(
    FAMILIES.map((family) => [family, answers.choice(family)]),
  );
  const amountKind = input.amount !== undefined ? answers.choice('amount') : undefined;
  const numbers = { amount: input.amount, kind: amountKind };

  if (scope.choice === 'one_device') {
    const chosen = sure('device');
    if (isStandDown(chosen)) return stood(chosen);
    if (chosen.choice === NONE_OF_THESE) {
      return stood({ question: 'device', reason: 'blocked', ...read(chosen) });
    }
    const device = catalog.deviceByKey.get(chosen.choice);
    if (device === undefined) return stood({ question: 'device', reason: 'blocked', ...read(chosen) });

    /**
     * The place has to agree, and this is the only thing that reads it for
     * one device.
     *
     * Asked blind beside the device question — the two cannot see each other
     * — so when both are confident and they *disagree*, one of them is wrong
     * and there is no way to tell which. Standing down is the cheap answer:
     * this is the shape a catalog gets wrong in a home with three lights
     * called Ceiling light, where "turn the kitchen light off" resolves to the
     * bedroom by a name that matched better than the room did.
     *
     * A device in no room, an unconfident place, the whole home and no place
     * at all abstain rather than object — none of them is disagreement.
     */
    const place = answers.choice('place');
    const claimed = place !== undefined && place.confidence >= ACT_CONFIDENCE_MIN
      ? catalog.placeByKey.get(place.choice)
      : undefined;
    if (claimed !== undefined && device.roomId !== null) {
      const inside =
        claimed.kind === 'room'
          ? device.roomId === claimed.id
          : catalog.zoneOfRoom.get(device.roomId) === claimed.id;
      if (!inside) {
        return stood({
          question: 'place',
          reason: 'disagreed',
          ...read(place!),
          device: device.name,
          deviceRoom: catalog.roomName.get(device.roomId) ?? device.roomId,
        });
      }
    }

    const planned = planDevice({ device, families, numbers, home, catalog, group: false });
    if ('reason' in planned) return stood(planned);
    return {
      kind: 'act',
      plan: {
        actions: [planned.action],
        target: device.name,
        plural: false,
        wordings: planned.action.wordings,
        offline: [],
        confidence: Math.min(
          intent.confidence,
          scope.confidence,
          chosen.confidence,
          ...planned.confidences,
        ),
      },
    };
  }

  // ── A group: every device of one kind in one place ─────────────────────
  const place = sure('place');
  if (isStandDown(place)) return stood(place);
  /**
   * **No place said is the whole home — for switching things off, and only
   * then.** "Turn off the lights" said to a phone has nowhere else it could
   * mean: the hub does not know which room the person is in, and the
   * assistants people already use read it as every light in the house. Off is
   * also the direction that is safe to get wrong — a light somebody wanted on
   * is one tap back — so an unplaced group is read as the whole home, and
   * stands down unless every command it would send `switchesOff`. "Turn on the
   * lights", with every lamp in every bedroom at the end of it, is still the
   * model's to read, or to ask about.
   */
  const unplaced = place.choice === NOT_SAID;
  const where =
    place.choice === WHOLE_HOME || unplaced ? undefined : catalog.placeByKey.get(place.choice);
  if (place.choice !== WHOLE_HOME && !unplaced && where === undefined) {
    return stood({ question: 'place', reason: 'blocked', ...read(place) });
  }

  const type = sure('deviceType');
  if (isStandDown(type)) return stood(type);
  const selection = GROUP_KINDS[type.choice];
  if (selection === undefined) return stood({ question: 'deviceType', reason: 'blocked', ...read(type) });

  const members = home.devices.filter((device) => {
    if (where !== undefined) {
      if (device.roomId === null) return false;
      const inside =
        where.kind === 'room'
          ? device.roomId === where.id
          : catalog.zoneOfRoom.get(device.roomId) === where.id;
      if (!inside) return false;
    }
    return device.endpoints.some(
      (endpoint) =>
        (endpoint.deviceKind !== undefined && selection.kinds.includes(endpoint.deviceKind)) ||
        (selection.capability !== undefined && endpoint.capabilities.includes(selection.capability)),
    );
  });
  const placeWords =
    where === undefined
      ? 'across the home'
      : where.kind === 'room'
        ? `in the ${where.name}`
        : `in ${where.name}`;
  if (members.length === 0) {
    return stood({
      question: 'deviceType',
      reason: 'blocked',
      ...read(type),
      because: `no ${GROUP_WORDS[type.choice] ?? 'devices'} ${placeWords}`,
    });
  }

  const actions: DeviceAction[] = [];
  const offline: CommandPlan['offline'] = [];
  const confidences: number[] = [];
  let wordings: Wording[] | undefined;
  for (const device of members) {
    const planned = planDevice({
      device,
      families,
      numbers,
      home,
      catalog,
      group: true,
      everything: type.choice === 'everything',
      wholeHome: where === undefined,
    });
    // A device the group's action does not apply to — a light that cannot
    // dim, in "dim the lights" — is left alone; anything else unsure about it
    // is unsure about the group.
    if ('reason' in planned) {
      if (planned.reason === 'blocked' && planned.question === 'action') continue;
      return stood({ ...planned, device: device.name });
    }
    if (unplaced && !planned.action.commands.every(({ command }) => switchesOff(command))) {
      return stood({
        question: 'place',
        reason: 'blocked',
        ...read(place),
        because: 'with no place said, only switching off reaches the whole home',
      });
    }
    confidences.push(...planned.confidences);
    wordings ??= planned.familyWordings;
    /**
     * **A member the hub knows is offline is not tried.** A command to a
     * device that cannot hear it is at best an error and at worst a wait —
     * a Matter node that has dropped off holds its command through every
     * retransmission — and one bulb in a hallway must not keep the rest of
     * the house waiting for the sentence that says the lights are off. It is
     * named instead, so the reply can say which one did not go off.
     */
    if (device.online === false) {
      offline.push({
        deviceName: planned.action.deviceName,
        roomName: planned.action.roomName,
        wordings: planned.action.wordings,
      });
      continue;
    }
    actions.push(planned.action);
  }
  if (actions.length === 0 && offline.length > 0) {
    return stood({
      question: 'action',
      reason: 'blocked',
      because: `every one of the ${GROUP_WORDS[type.choice] ?? 'devices'} ${placeWords} is offline`,
    });
  }
  if (actions.length === 0 || wordings === undefined) {
    return stood({
      question: 'action',
      reason: 'blocked',
      because: `nothing ${placeWords} can do that`,
    });
  }
  const commandCount = actions.reduce((sum, action) => sum + action.commands.length, 0);
  if (commandCount > MAX_COMMANDS) {
    return stood({ question: 'group', reason: 'size', value: commandCount, max: MAX_COMMANDS });
  }

  const only = actions.length === 1 ? actions[0] : undefined;
  return {
    kind: 'act',
    plan: {
      actions,
      target:
        only !== undefined
          ? only.deviceName
          : type.choice === 'everything'
            ? `everything ${placeWords}`
            : `${actions.length} ${GROUP_WORDS[type.choice] ?? 'devices'} ${placeWords}`,
      plural: only === undefined,
      wordings,
      offline,
      confidence: Math.min(intent.confidence, scope.confidence, place.confidence, type.confidence, ...confidences),
    },
  };
}

/** What `planDevice` resolved for one device, or why it could not. */
type DevicePlan =
  | {
      action: DeviceAction;
      /** The confidences the device's commands rest on. */
      confidences: number[];
      /** The family's own words, before any per-device extra such as switching a light on first. */
      familyWordings: Wording[];
    }
  | StandDown;

/**
 * The commands one device needs to do what the answers asked — every number
 * worked out here, in code.
 *
 * Only the families the device has a capability for are read, and among those
 * an `unchanged` is skipped and anything else must clear the bar. So "switch
 * off the lamp" on a dimmable lamp reads power (`off`) and brightness
 * (`unchanged`) and nothing more, and "dim the TV" on a TV that cannot dim
 * finds nothing to do and stands down rather than switching it off.
 */
function planDevice(input: {
  device: DecidableDevice;
  families: Map<Family, ChoiceRead | undefined>;
  numbers: { amount: { text: string; value: number } | undefined; kind: ChoiceRead | undefined };
  home: DecidableHome;
  catalog: Catalog;
  group: boolean;
  /** "Everything in the kitchen": only switched off, or on in one room, and paused. */
  everything?: boolean;
  wholeHome?: boolean;
}): DevicePlan {
  const { device, families, home } = input;
  const has = (capability: CapabilityKind) =>
    device.endpoints.some((endpoint) => endpoint.capabilities.includes(capability));

  const wanted = new Map<Family, ChoiceRead>();
  for (const family of FAMILIES) {
    if (!FAMILY_CAPABILITIES[family].some(has)) continue;
    const answer = families.get(family);
    if (answer === undefined) return { question: family, reason: 'unanswered', device: device.name };
    if (answer.choice === UNCHANGED) continue;
    if (answer.confidence < ACT_CONFIDENCE_MIN) {
      const nearly = runnerUpOf(answer);
      return {
        question: family,
        reason: 'unsure',
        answer: answer.choice,
        label: OPTION_WORDS[answer.choice] ?? answer.choice,
        value: answer.confidence,
        min: ACT_CONFIDENCE_MIN,
        device: device.name,
        ...(nearly !== undefined ? { runnerUp: OPTION_WORDS[nearly] ?? nearly } : {}),
      };
    }
    wanted.set(family, answer);
  }
  if (wanted.size === 0) return { question: 'action', reason: 'blocked', device: device.name };

  // "Everything" moves only what a person switches off leaving a room.
  if (input.everything === true) {
    for (const [family, answer] of wanted) {
      const allowed =
        (family === 'power' && (answer.choice === 'off' || input.wholeHome !== true)) ||
        (family === 'playback' && answer.choice === 'pause');
      if (!allowed) {
        return {
          question: family,
          reason: 'blocked',
          answer: answer.choice,
          label: OPTION_WORDS[answer.choice] ?? answer.choice,
          device: device.name,
          because:
            family === 'power'
              ? 'everything in the home is never switched on at once'
              : 'only switching off and pausing apply to everything',
        };
      }
    }
  }

  /**
   * The endpoints that carry a capability — exactly one for a single device,
   * every one of them for a group. A two-gang switch named on its own is two
   * things somebody could have meant, and which of them is the model's to ask.
   */
  const endpointsFor = (capability: CapabilityKind): number[] | StandDown => {
    const found = device.endpoints
      .filter((endpoint) => endpoint.capabilities.includes(capability))
      .map((endpoint) => endpoint.endpointId);
    if (found.length === 0) return { question: 'action', reason: 'blocked', device: device.name };
    if (found.length > 1 && !input.group) {
      return {
        question: 'action',
        reason: 'blocked',
        device: device.name,
        because: `${device.name} has ${found.length} parts that could be meant`,
      };
    }
    return found;
  };
  const stateAt = (endpointId: number): EndpointState | undefined =>
    home.stateOf?.(device.id, endpointId);

  const commands: { endpointId: number; command: HubCommand }[] = [];
  const wordings: Wording[] = [];
  const familyWordings: Wording[] = [];
  const confidences: number[] = [];
  /** Add a command on every endpoint carrying the capability; the stand-down if none can. */
  const add = (
    capability: CapabilityKind,
    build: (endpointId: number) => HubCommand | StandDown,
    wording: Wording,
    confidence: number,
    options: { familyWording?: boolean } = {},
  ): StandDown | undefined => {
    const endpoints = endpointsFor(capability);
    if (!Array.isArray(endpoints)) return endpoints;
    for (const endpointId of endpoints) {
      const command = build(endpointId);
      if ('reason' in command) return command;
      commands.push({ endpointId, command });
    }
    wordings.push(wording);
    if (options.familyWording !== false) familyWordings.push(wording);
    confidences.push(confidence);
    return undefined;
  };
  /** A number said in the sentence, when the model agrees it is a number of this. */
  const amountOf = (kind: string, family: Family): number | StandDown => {
    const { amount, kind: said } = input.numbers;
    if (amount === undefined) {
      return { question: family, reason: 'blocked', device: device.name, because: 'no single number was said' };
    }
    if (said === undefined) return { question: 'amount', reason: 'unanswered', device: device.name };
    if (said.confidence < ACT_CONFIDENCE_MIN || said.choice !== kind) {
      return {
        question: 'amount',
        reason: said.confidence < ACT_CONFIDENCE_MIN ? 'unsure' : 'blocked',
        answer: said.choice,
        label: OPTION_WORDS[said.choice] ?? said.choice,
        value: said.confidence,
        min: ACT_CONFIDENCE_MIN,
        device: device.name,
      };
    }
    confidences.push(said.confidence);
    return amount.value;
  };
  const outOfRange = (family: Family, because: string): StandDown => ({
    question: family,
    reason: 'blocked',
    device: device.name,
    because,
  });

  const power = wanted.get('power');
  // **Off wins.** "Turn off the TV" read as a TV also says "pause", and read
  // as a light it may say "dimmer": switched off is the whole request.
  if (power?.choice === 'off') {
    const stop = add('onOff', () => ({ type: 'power', on: false }), { before: 'switched off', after: '' }, power.confidence);
    if (stop !== undefined) return stop;
    return finish();
  }

  const lock = wanted.get('lock');
  if (lock !== undefined) {
    // **A whole group is never unlocked.** Locking every door is the thing
    // somebody asks when they leave; unlocking every door is a misreading
    // with a front door at the end of it, and the model can ask.
    if (lock.choice === 'unlock' && input.group) {
      return {
        question: 'lock',
        reason: 'blocked',
        answer: 'unlock',
        label: 'unlock',
        device: device.name,
        because: 'a group of locks is never unlocked at once',
      };
    }
    const engage = lock.choice === 'lock';
    const failed = add(
      'doorLock',
      () => ({ type: 'lock', engage }),
      { before: engage ? 'locked' : 'unlocked', after: '' },
      lock.confidence,
    );
    if (failed !== undefined) return failed;
  }

  const cover = wanted.get('cover');
  if (cover !== undefined) {
    const shapes: Record<string, { command: HubCommand; wording: Wording }> = {
      open: { command: { type: 'openCovering' }, wording: { before: 'opened', after: '' } },
      close: { command: { type: 'closeCovering' }, wording: { before: 'closed', after: '' } },
      stop: { command: { type: 'stopCovering' }, wording: { before: 'stopped', after: '' } },
      // 0 is fully open in these units, so halfway is 5000 either way round.
      half: {
        command: { type: 'setCoveringPercent', percent100ths: 5_000 },
        wording: { before: 'set', after: ' halfway' },
      },
    };
    const shape = shapes[cover.choice];
    if (shape === undefined) return outOfRange('cover', 'an unknown covering action');
    const failed = add('windowCovering', () => shape.command, shape.wording, cover.confidence);
    if (failed !== undefined) return failed;
  }

  if (power?.choice === 'on') {
    const failed = add('onOff', () => ({ type: 'power', on: true }), { before: 'switched on', after: '' }, power.confidence);
    if (failed !== undefined) return failed;
  }

  // Brightness and colour on a light that is off switch it on first: "make it
  // red" means a red light, not a red setting on a dark bulb. Only when this
  // reading did not already say on or off, and only for asking it to be seen.
  const brightness = wanted.get('brightness');
  const colour = wanted.get('colour');
  const lightsUp =
    (brightness !== undefined && brightness.choice !== 'dimmer' && brightness.choice !== 'lowest') ||
    colour !== undefined;
  if (power === undefined && lightsUp && has('onOff')) {
    const onOff = endpointsFor('onOff');
    if (Array.isArray(onOff) && onOff.some((endpointId) => stateAt(endpointId)?.onOff === false)) {
      const failed = add(
        'onOff',
        () => ({ type: 'power', on: true }),
        { before: 'switched on', after: '' },
        (brightness ?? colour)!.confidence,
        { familyWording: false },
      );
      if (failed !== undefined) return failed;
    }
  }

  if (brightness !== undefined) {
    let target: ((endpointId: number) => number | StandDown) | undefined;
    let wording: Wording;
    switch (brightness.choice) {
      case 'full':
        target = () => 254;
        wording = { before: 'set', after: ' to full brightness' };
        break;
      case 'lowest':
        target = () => 1;
        wording = { before: 'set', after: ' to its lowest brightness' };
        break;
      case 'brighter':
      case 'dimmer': {
        const step = brightness.choice === 'brighter' ? LEVEL_STEP : -LEVEL_STEP;
        target = (endpointId) => {
          const current = stateAt(endpointId)?.level?.current;
          if (current === undefined) return outOfRange('brightness', 'how bright it is now is not known');
          return Math.max(1, Math.min(254, current + step));
        };
        wording = { before: brightness.choice === 'brighter' ? 'brightened' : 'dimmed', after: '' };
        break;
      }
      case 'percent': {
        const percent = amountOf('brightness', 'brightness');
        if (typeof percent !== 'number') return percent;
        if (percent < 1 || percent > 100) return outOfRange('brightness', `${percent}% is not a brightness`);
        target = () => Math.max(1, Math.round((percent / 100) * 254));
        wording = { before: 'set', after: ` to ${Math.round(percent)}% brightness` };
        break;
      }
      default:
        return outOfRange('brightness', 'an unknown brightness');
    }
    const level = target;
    const failed = add(
      'level',
      (endpointId) => {
        const value = level(endpointId);
        return typeof value === 'number' ? { type: 'setLevel', level: value } : value;
      },
      wording,
      brightness.confidence,
    );
    if (failed !== undefined) return failed;
  }

  if (colour !== undefined) {
    const hue = COLOURS[colour.choice];
    const white = WHITES[colour.choice];
    if (hue !== undefined) {
      if (!has('color')) return outOfRange('colour', `${device.name} cannot change colour`);
      const failed = add(
        'color',
        () => ({ type: 'setHueSaturation', hue: hue.hue, saturation: hue.saturation }),
        { before: 'set', after: ` to ${hue.words}` },
        colour.confidence,
      );
      if (failed !== undefined) return failed;
    } else if (white !== undefined) {
      if (!has('colorTemperature')) return outOfRange('colour', `${device.name} has no shades of white`);
      const failed = add(
        'colorTemperature',
        (endpointId) => {
          const range = stateAt(endpointId)?.colorTemperature;
          const mireds =
            range === undefined
              ? white.mireds
              : Math.max(range.minMireds, Math.min(range.maxMireds, white.mireds));
          return { type: 'setColorTemperature', mireds };
        },
        { before: 'set', after: ` to ${white.words}` },
        colour.confidence,
      );
      if (failed !== undefined) return failed;
    } else {
      return outOfRange('colour', 'an unknown colour');
    }
  }

  const playback = wanted.get('playback');
  if (playback !== undefined) {
    const play = playback.choice === 'play';
    const failed = add(
      'mediaPlayback',
      () => ({ type: 'playPause', play }),
      play ? { before: 'started', after: ' playing' } : { before: 'paused', after: '' },
      playback.confidence,
    );
    if (failed !== undefined) return failed;
  }

  const climate = wanted.get('climate');
  if (climate !== undefined) {
    const mode = SYSTEM_MODES[climate.choice];
    if (mode !== undefined) {
      const failed = add(
        'thermostat',
        () => ({ type: 'setSystemMode', mode }),
        climate.choice === 'off'
          ? { before: 'switched off', after: '' }
          : { before: 'set', after: ` to ${climate.choice}` },
        climate.confidence,
      );
      if (failed !== undefined) return failed;
    } else if (climate.choice === 'warmer' || climate.choice === 'cooler' || climate.choice === 'degrees') {
      let named: number | undefined;
      if (climate.choice === 'degrees') {
        const degrees = amountOf('temperature', 'climate');
        if (typeof degrees !== 'number') return degrees;
        if (degrees < SETPOINT_RANGE.min || degrees > SETPOINT_RANGE.max) {
          return outOfRange('climate', `${degrees}° is not a room temperature`);
        }
        named = Math.round(degrees * 100);
      }
      let settled: number | undefined;
      const generic: Wording =
        named !== undefined
          ? { before: 'set', after: ` to ${named / 100}°` }
          : { before: 'turned', after: climate.choice === 'warmer' ? ' up a degree' : ' down a degree' };
      const failed = add(
        'thermostat',
        (endpointId) => {
          const thermostat = stateAt(endpointId)?.thermostat;
          if (thermostat === undefined) return outOfRange('climate', 'what it is set to is not known');
          // The setpoint that is in charge: cooling when it is cooling, and the
          // heating setpoint otherwise — which is the only one a heater has.
          const cooling =
            thermostat.systemMode === 3 && thermostat.occupiedCoolingSetpointCenti !== undefined;
          const current = cooling
            ? thermostat.occupiedCoolingSetpointCenti
            : thermostat.occupiedHeatingSetpointCenti;
          if (current === undefined) return outOfRange('climate', 'what it is set to is not known');
          const wantedCenti =
            named ?? current + (climate.choice === 'warmer' ? SETPOINT_STEP_CENTI : -SETPOINT_STEP_CENTI);
          const [min, max] = cooling
            ? [thermostat.coolSetpointMinCenti, thermostat.coolSetpointMaxCenti]
            : [thermostat.heatSetpointMinCenti, thermostat.heatSetpointMaxCenti];
          if (wantedCenti < min || wantedCenti > max) {
            return outOfRange('climate', `${wantedCenti / 100}° is outside what it can be set to`);
          }
          settled = wantedCenti;
          return cooling
            ? { type: 'setCoolingSetpoint', centi: wantedCenti }
            : { type: 'setHeatingSetpoint', centi: wantedCenti };
        },
        generic,
        climate.confidence,
      );
      if (failed !== undefined) return failed;
      // The device's own line says where it ended up — "turned up to 22°" —
      // while a group's says only what was done to all of them.
      if (settled !== undefined && named === undefined) {
        wordings[wordings.length - 1] = {
          before: 'turned',
          after: ` ${climate.choice === 'warmer' ? 'up' : 'down'} to ${settled / 100}°`,
        };
      }
    } else {
      return outOfRange('climate', 'an unknown climate action');
    }
  }

  // "Turn the fan on" on a fan that has a switch is the switch's; the fan's
  // own "on" is for one that has only speeds.
  const fan =
    wanted.get('fan')?.choice === 'on' && power !== undefined ? undefined : wanted.get('fan');
  if (fan !== undefined) {
    const mode = FAN_MODES[fan.choice];
    if (mode !== undefined) {
      const failed = add(
        'fan',
        () => ({ type: 'setFanMode', mode }),
        fan.choice === 'off'
          ? { before: 'stopped', after: '' }
          : fan.choice === 'on'
            ? { before: 'switched on', after: '' }
            : { before: 'set', after: ` to ${fan.choice}` },
        fan.confidence,
      );
      if (failed !== undefined) return failed;
    } else if (fan.choice === 'faster' || fan.choice === 'slower') {
      const up = fan.choice === 'faster';
      const failed = add(
        'fan',
        (endpointId) => {
          const state = stateAt(endpointId)?.fan;
          if (state === undefined) return outOfRange('fan', 'how fast it is going is not known');
          // Stepped by mode while it is on one of the three speeds, and by
          // percent otherwise — "on" and "auto" have no step above or below.
          if (state.mode >= 1 && state.mode <= 3) {
            return { type: 'setFanMode', mode: Math.max(1, Math.min(3, state.mode + (up ? 1 : -1))) };
          }
          const from = state.percentSetting ?? state.percentCurrent;
          return {
            type: 'setFanPercent',
            percent: Math.max(0, Math.min(100, from + (up ? FAN_PERCENT_STEP : -FAN_PERCENT_STEP))),
          };
        },
        { before: 'turned', after: up ? ' up' : ' down' },
        fan.confidence,
      );
      if (failed !== undefined) return failed;
    } else if (fan.choice === 'percent') {
      const percent = amountOf('fan_speed', 'fan');
      if (typeof percent !== 'number') return percent;
      if (percent < 0 || percent > 100) return outOfRange('fan', `${percent}% is not a fan speed`);
      const failed = add(
        'fan',
        () => ({ type: 'setFanPercent', percent: Math.round(percent) }),
        { before: 'set', after: ` to ${Math.round(percent)}% speed` },
        fan.confidence,
      );
      if (failed !== undefined) return failed;
    } else {
      return outOfRange('fan', 'an unknown fan speed');
    }
  }

  return finish();

  function finish(): DevicePlan {
    if (commands.length === 0) return { question: 'action', reason: 'blocked', device: device.name };
    const roomName = device.roomId !== null ? input.catalog.roomName.get(device.roomId) : undefined;
    return {
      action: {
        deviceId: device.id,
        deviceName: device.name,
        ...(roomName !== undefined ? { roomName } : {}),
        commands,
        wordings,
      },
      confidences,
      familyWordings: familyWordings.length > 0 ? familyWordings : wordings,
    };
  }
}

/* ------------------------------------------------------------------ *
 * Asking.
 * ------------------------------------------------------------------ */

/** The questions every request is asked, under a prefix so several can share one request. */
function subjectQuestions(input: {
  subject: Subject;
  prefix: string;
  catalog: Catalog;
  withAmount: boolean;
  part: boolean;
}): Record<string, Questions[string]> {
  const { subject, prefix } = input;
  const questions: Record<string, Questions[string]> = {
    [`${prefix}intent`]: intentQuestion(subject),
    [`${prefix}later`]: laterQuestion(subject),
    [`${prefix}negated`]: negatedQuestion(subject),
    [`${prefix}scope`]: scopeQuestion(subject),
    [`${prefix}place`]: placeQuestion(input.catalog.placeOptions, subject),
    [`${prefix}deviceType`]: deviceTypeQuestion(subject),
    [`${prefix}device`]: deviceQuestion(input.catalog.deviceOptions, subject),
  };
  // The sentence's own `multiple` is asked beside `anyCommand` by the caller,
  // with the split in mind; a part asks it as a guard.
  if (input.part) questions[`${prefix}multiple`] = multipleQuestion(subject);
  for (const family of FAMILIES) questions[`${prefix}${family}`] = familyQuestion(family, subject);
  if (input.withAmount) questions[`${prefix}amount`] = amountQuestion(subject);
  return questions;
}

/** Read the answers under one prefix, dropping any whose shape is not the one asked. */
function answersUnder(answers: Readonly<Record<string, unknown>>, prefix: string): SubjectAnswers {
  const at = (id: string) => answers[`${prefix}${id}`] as DecisionAnswer | undefined;
  return {
    choice: (id) => {
      const answer = at(id);
      return answer?.type === 'choice' ? answer : undefined;
    },
    noul: (id) => {
      const answer = at(id);
      return answer?.type === 'noul' ? answer : undefined;
    },
  };
}

/**
 * Read one sentence against this home.
 *
 * Answers `none` for everything the hub should handle the way it always did,
 * which is most sentences — that is the design rather than a disappointment.
 * **Every `none` says why** (`StandDown`): which question settled it, what it
 * answered, and the number it was measured by.
 */
export async function decideHomeCommand(input: {
  decider: Decider;
  home: DecidableHome;
  /**
   * The agents a job could be handed to, from the registry.
   *
   * Passed in rather than imported so this module stays a pure reading of a
   * sentence — and so the routing question is built from the one table that
   * knows what agents exist. `title` is only ever read to name one in a
   * stand-down.
   */
  delegates: readonly { key: string; decisionCriterion: string; title?: string }[];
  said: string;
  timeoutMs?: number;
  /** `speculative` gives way when anything is already out — see `Decider.decide`. */
  priority?: 'live' | 'speculative';
}): Promise<HomeDecision> {
  const { home, said } = input;
  // A home past the bound is one this stands down on rather than guesses in:
  // a long option list is a long request, and accuracy falls as it grows.
  if (home.devices.length === 0 || home.devices.length > MAX_DEVICE_OPTIONS) {
    return {
      kind: 'none',
      costUsd: 0,
      effort: undefined,
      standDown: { question: 'home', reason: 'size', value: home.devices.length, max: MAX_DEVICE_OPTIONS },
    };
  }

  const catalog = catalogOf(home);
  const amount = amountIn(said);
  const agentName = new Map(input.delegates.map((agent) => [agent.key, agent.title ?? agent.key]));

  /**
   * Every question in one request.
   *
   * The routing questions, the guards, the catalog and every family's action,
   * asked together because they are answered in parallel and cannot see one
   * another — so asking the action questions "just in case" is what the
   * parallelism is *for*, not a waste of it.
   */
  const questions = {
    ...subjectQuestions({ subject: 'said', prefix: '', catalog, withAmount: amount !== undefined, part: false }),
    multiple: multipleQuestion('said'),
    anyCommand: ANY_COMMAND_QUESTION,
    // Asked in the same breath as the rest, because a second request would
    // cost more than every question in this one put together.
    route: routeQuestion(input.delegates),
    selfContained: SELF_CONTAINED_QUESTION,
    effort: EFFORT_QUESTION,
  };

  // Why a `null` came back, when the decider says. On an object rather than in
  // a `let`, because an assignment inside a callback is invisible to the
  // checker's narrowing of a local — it would read as `undefined` for ever.
  const heard: { miss?: DecisionMiss; newConnection?: boolean } = {};
  const timeoutMs = input.timeoutMs ?? DECISION_TIMEOUT_MS;
  const result = await input.decider.decide({
    // **Only what a question can use.** The sentence, and the one number in it
    // when there is exactly one — found by code, so the model is asked what
    // the number is *of* and never to read it. The rooms and devices are the
    // criteria of their own questions; repeating them here would be state that
    // answers nothing while every question pays for it.
    state: { said, ...(amount !== undefined ? { amount: amount.text } : {}) },
    questions,
    timeoutMs,
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    onMiss: (why, detail) => {
      heard.miss = why;
      if (detail?.newConnection !== undefined) heard.newConnection = detail.newConnection;
    },
  });
  if (result === null) {
    return {
      kind: 'none',
      costUsd: 0,
      effort: undefined,
      standDown: {
        question: 'model',
        reason: 'missed',
        ...(heard.miss !== undefined ? { miss: heard.miss } : {}),
        // For a timeout, how long it was waited for — the one duration there is.
        ...(heard.miss === 'timeout' ? { durationMs: timeoutMs } : {}),
        ...(heard.newConnection !== undefined ? { newConnection: heard.newConnection } : {}),
      },
    };
  }
  const answers = result.answers as Readonly<Record<string, DecisionAnswer | undefined>>;
  const reading: Reading = {
    costUsd: result.costUsd,
    durationMs: result.durationMs,
    ...(result.newConnection !== undefined ? { newConnection: result.newConnection } : {}),
    ...(result.requestId !== undefined ? { requestId: result.requestId } : {}),
  };

  // **One direction only.** A score is a position on a rubric, not a number to
  // do arithmetic with, so it is compared against the level below which the
  // work is plainly small — and nothing here can ask for *more* thinking.
  const scored = answers['effort'];
  const effort: EffortHint =
    scored?.type === 'score' &&
    scored.score <= EFFORT_SIMPLE_MAX &&
    scored.confidence >= EFFORT_CONFIDENCE_MIN
      ? 'low'
      : undefined;

  /**
   * Stand down, and say why. Every `none` from here on is one of these, so a
   * reading cannot end without its reason — and the reading's own timing and
   * request id ride along, for a log line that can be traced to the vendor.
   */
  const standDown = (why: StandDown): HomeDecision => ({
    kind: 'none',
    costUsd: reading.costUsd,
    effort,
    standDown: {
      ...why,
      durationMs: reading.durationMs,
      ...(reading.newConnection !== undefined ? { newConnection: reading.newConnection } : {}),
      ...(reading.requestId !== undefined ? { requestId: reading.requestId } : {}),
    },
  });
  const noul = (id: string) => {
    const answer = answers[id];
    return answer?.type === 'noul' ? answer : undefined;
  };
  const choice = (id: string) => {
    const answer = answers[id];
    return answer?.type === 'choice' ? answer : undefined;
  };
  const spoken = (option: string) => agentName.get(option) ?? OPTION_WORDS[option] ?? option;

  const intent = choice('intent');
  if (intent === undefined) return standDown({ question: 'intent', reason: 'unanswered' });

  /**
   * **Several requests, at least one a command: split it.**
   *
   * Asked before anything else is read, because the whole-sentence reading
   * of a compound sentence is usually unsure — "turn off the light and what's
   * the temperature" is half a command and half a question — and it is the
   * parts that can be acted on. The split itself is writing, which a
   * generative model does (`split.ts`); the parts then come back here.
   *
   * Two devices named one by one is the same case in different words: "the
   * kitchen light and the hall light" reads as one request about several
   * devices, and splitting it is what turns it into two commands this path
   * can carry out.
   */
  const anyCommand = noul('anyCommand');
  const multiple = noul('multiple');
  const scope = choice('scope');
  const severalNamed = scope?.choice === 'several_devices' && scope.confidence >= ACT_CONFIDENCE_MIN;
  if (
    anyCommand !== undefined &&
    anyCommand.noul >= SPLIT_NOUL_MIN &&
    ((multiple !== undefined && multiple.noul >= SPLIT_NOUL_MIN) || severalNamed)
  ) {
    return {
      kind: 'split',
      confidence: Math.min(anyCommand.noul, severalNamed ? scope.confidence : multiple!.noul),
      effort,
      ...reading,
    };
  }

  if (intent.confidence < ACT_CONFIDENCE_MIN) {
    const nearly = runnerUpOf(intent);
    return standDown({
      question: 'intent',
      reason: 'unsure',
      answer: intent.choice,
      label: spoken(intent.choice),
      value: intent.confidence,
      min: ACT_CONFIDENCE_MIN,
      ...(nearly !== undefined ? { runnerUp: spoken(nearly) } : {}),
    });
  }

  /**
   * Handing the job over is a *route*, not an action: writing a rule is
   * writing, and the agent that does it is the one that knows the format.
   *
   * Two answers have to agree before it happens. `route` says who should take
   * it; `selfContained` says whether the person's own sentence is enough of a
   * brief for somebody who has not read the conversation — which is the one
   * thing a fast route gives up against a handover the model composes, and
   * "make it half past instead" is exactly what it catches.
   */
  const route = choice('route');
  const selfContained = noul('selfContained');
  if (
    route !== undefined &&
    route.choice !== 'here' &&
    route.confidence >= ACT_CONFIDENCE_MIN &&
    selfContained !== undefined &&
    selfContained.noul >= POSITIVE_NOUL_MIN
  ) {
    return { kind: 'route', agentKey: route.choice, confidence: route.confidence, effort, ...reading };
  }
  if (intent.choice !== 'device_command') {
    // Not a device command. When a handover was on the table and one of its
    // two answers fell short, *that* is why nothing happened — otherwise the
    // sentence was simply never this path's, which is most of them.
    if (route !== undefined && route.choice !== 'here') {
      if (route.confidence < ACT_CONFIDENCE_MIN) {
        const nearly = runnerUpOf(route);
        return standDown({
          question: 'route',
          reason: 'unsure',
          answer: route.choice,
          label: spoken(route.choice),
          value: route.confidence,
          min: ACT_CONFIDENCE_MIN,
          ...(nearly !== undefined ? { runnerUp: spoken(nearly) } : {}),
        });
      }
      const agent = { answer: route.choice, label: spoken(route.choice) };
      if (selfContained === undefined) {
        return standDown({ question: 'selfContained', reason: 'unanswered', ...agent });
      }
      return standDown({
        question: 'selfContained',
        reason: 'unsure',
        ...agent,
        value: selfContained.noul,
        min: POSITIVE_NOUL_MIN,
      });
    }
    return standDown({
      question: 'intent',
      reason: 'declined',
      answer: intent.choice,
      label: spoken(intent.choice),
      value: intent.confidence,
    });
  }

  // Not clearly several requests, and not clearly one: the model reads it whole.
  if (multiple === undefined) return standDown({ question: 'multiple', reason: 'unanswered' });
  if (multiple.noul > NEGATIVE_NOUL_MAX) {
    return standDown({ question: 'multiple', reason: 'blocked', value: multiple.noul, max: NEGATIVE_NOUL_MAX });
  }

  const read = readSubject({ answers: answersUnder(answers, ''), catalog, home, amount, part: false });
  if (read.kind === 'none') return standDown(read.standDown);
  return { kind: 'act', plan: read.plan, effort, ...reading };
}

/**
 * Read the parts a sentence was split into, all of them in one request.
 *
 * **One request, not one per part** — the vendor's fan-out rule, and the
 * reason the parts go into the state as a list: each question points at its
 * own part by path (`parts[1]`), so every part is read in parallel against
 * the same catalog in the time one would take. A part the reading is sure of
 * becomes a plan; everything else — a question, an automation, a part it was
 * unsure about — is left for the model, with the reason.
 */
export async function decideParts(input: {
  decider: Decider;
  home: DecidableHome;
  parts: readonly string[];
  timeoutMs?: number;
}): Promise<PartsDecision> {
  const { home } = input;
  const parts = input.parts.slice(0, MAX_PARTS);
  const catalog = catalogOf(home);
  const amounts = parts.map((part) => amountIn(part));

  const questions: Record<string, Questions[string]> = {};
  parts.forEach((_, index) => {
    Object.assign(
      questions,
      subjectQuestions({
        subject: `parts[${index}]`,
        prefix: `p${index}_`,
        catalog,
        withAmount: amounts[index] !== undefined,
        part: true,
      }),
    );
  });

  const heard: { miss?: DecisionMiss; newConnection?: boolean } = {};
  const timeoutMs = input.timeoutMs ?? DECISION_TIMEOUT_MS;
  const result = await input.decider.decide({
    state: {
      parts,
      ...(amounts.some((amount) => amount !== undefined)
        ? { amounts: amounts.map((amount) => amount?.text ?? null) }
        : {}),
    },
    questions,
    timeoutMs,
    onMiss: (why, detail) => {
      heard.miss = why;
      if (detail?.newConnection !== undefined) heard.newConnection = detail.newConnection;
    },
  });

  if (result === null) {
    const missed: StandDown = {
      question: 'model',
      reason: 'missed',
      ...(heard.miss !== undefined ? { miss: heard.miss } : {}),
      ...(heard.miss === 'timeout' ? { durationMs: timeoutMs } : {}),
      ...(heard.newConnection !== undefined ? { newConnection: heard.newConnection } : {}),
    };
    return {
      costUsd: 0,
      durationMs: heard.miss === 'timeout' ? timeoutMs : 0,
      parts: parts.map((text) => ({ text, reading: { kind: 'none', standDown: { ...missed, part: text } } })),
    };
  }

  const answers = result.answers as Readonly<Record<string, unknown>>;
  return {
    costUsd: result.costUsd,
    durationMs: result.durationMs,
    ...(result.newConnection !== undefined ? { newConnection: result.newConnection } : {}),
    ...(result.requestId !== undefined ? { requestId: result.requestId } : {}),
    parts: parts.map((text, index) => {
      const read = readSubject({
        answers: answersUnder(answers, `p${index}_`),
        catalog,
        home,
        amount: amounts[index],
        part: true,
      });
      return {
        text,
        reading:
          read.kind === 'act'
            ? read
            : {
                kind: 'none',
                standDown: {
                  ...read.standDown,
                  part: text,
                  durationMs: result.durationMs,
                  ...(result.requestId !== undefined ? { requestId: result.requestId } : {}),
                },
              },
      };
    }),
  };
}

/* ------------------------------------------------------------------ *
 * Saying it.
 * ------------------------------------------------------------------ */

/**
 * What was done, with the thing it was done to in the middle — "switched on
 * Light TV and set it to 40% brightness".
 */
export function phrase(wordings: readonly Wording[], target: string, plural: boolean): string {
  const [first, ...rest] = wordings;
  if (first === undefined) return target;
  const pronoun = plural ? 'them' : 'it';
  return [
    `${first.before} ${target}${first.after}`,
    ...rest.map((wording) => `${wording.before} ${pronoun}${wording.after}`),
  ].join(' and ');
}

/** What was done, without the thing — "switched on and set to 40% brightness". */
export function participle(wordings: readonly Wording[]): string {
  return wordings.map((wording) => `${wording.before}${wording.after}`).join(' and ');
}

/**
 * What to say about a stand-down, and to whom.
 *
 * **Three audiences, because most stand-downs are the design working.** Jev
 * reads every sentence somebody types, and most of them are questions: a trail
 * step saying so on every one of those turns would be noise in exactly the
 * place a person reads, and would bury the one that matters.
 *
 * - `quiet` — worth nothing above a debug line: Jev is not switched on, or the
 *   home has nothing in it to choose from.
 * - `logged` — a line in the hub's log and no more: it read the sentence and
 *   was sure it was not a device command.
 * - `shown` — the log line, **and** a quiet step in the trail: a stand-down
 *   somebody could have expected to go the other way, which is precisely when
 *   "why wasn't that instant?" gets asked.
 */
export interface StandDownWords {
  /** Past tense, without its subject — `wasn't sure which device`. */
  phrase: string;
  /** The step's own sentence: the phrase with Jev in front of it. */
  text: string;
  /** The numbers, the way they read under a step. */
  detail?: string;
  audience: 'quiet' | 'logged' | 'shown';
}

/** What each question was asking, for a reading that left it out. */
const QUESTION_WORDS: Readonly<Record<string, string>> = {
  intent: 'what was asked',
  multiple: 'whether it was one request',
  anyCommand: 'whether any of it was a command',
  later: 'whether it was for now',
  negated: 'whether it was taken back',
  scope: 'how many devices',
  place: 'where',
  deviceType: 'what kind of device',
  device: 'which device',
  route: 'who should take it',
  selfContained: 'whether it stood on its own',
  amount: 'what the number was',
  power: 'what to do with it',
  brightness: 'what to do with it',
  colour: 'what to do with it',
  cover: 'what to do with it',
  lock: 'what to do with it',
  playback: 'what to do with it',
  climate: 'what to do with it',
  fan: 'what to do with it',
};

/**
 * What falling short of each question's bar reads as. The action families are
 * absent on purpose: those name the device, which only the reading knows.
 */
const UNSURE_WORDS: Readonly<Record<string, string>> = {
  intent: "wasn't sure what was asked",
  route: "wasn't sure who should take it",
  selfContained: 'needed the rest of the conversation',
  scope: "wasn't sure how many devices",
  device: "wasn't sure which device",
  place: "wasn't sure where",
  deviceType: "wasn't sure what kind of device",
  amount: "wasn't sure what the number was",
};

/** What a yes/no's number is the probability *of*, so it never stands alone. */
const NOUL_WORDS: Readonly<Record<string, string>> = {
  multiple: 'more than one request',
  later: 'later or on a condition',
  negated: 'taken back',
  selfContained: 'stands on its own',
};

export function describeStandDown(standDown: StandDown): StandDownWords {
  const two = (value: number): string => value.toFixed(2);
  const told = (
    phrase: string,
    audience: StandDownWords['audience'],
    parts: readonly (string | undefined)[] = [],
  ): StandDownWords => {
    const detail = [
      ...parts,
      standDown.part !== undefined ? `for “${standDown.part}”` : undefined,
    ]
      .filter((part): part is string => part !== undefined && part !== '')
      .join(' · ');
    return { phrase, text: `Jev ${phrase}`, ...(detail !== '' ? { detail } : {}), audience };
  };

  // The number, what it is a number *of*, and the bar it was measured against —
  // "Light TV or Ceiling light: 0.41, needs 0.85".
  const measured = (options: { named: boolean }): string | undefined => {
    if (standDown.value === undefined) return undefined;
    const bar =
      standDown.min !== undefined
        ? `, needs ${two(standDown.min)}`
        : standDown.max !== undefined
          ? `, needs at most ${two(standDown.max)}`
          : '';
    const what =
      NOUL_WORDS[standDown.question] ??
      (options.named && standDown.label !== undefined
        ? standDown.runnerUp !== undefined
          ? `${standDown.label} or ${standDown.runnerUp}`
          : standDown.label
        : undefined);
    return what === undefined ? `${two(standDown.value)}${bar}` : `${what}: ${two(standDown.value)}${bar}`;
  };
  const took =
    standDown.durationMs !== undefined
      ? `${Math.round(standDown.durationMs)} ms${standDown.newConnection === true ? ', new connection' : ''}`
      : undefined;
  const device = standDown.device;

  switch (standDown.reason) {
    case 'missed':
      switch (standDown.miss) {
        case 'off':
          return told('is switched off', 'quiet');
        case 'busy':
          return told('was busy with another request', 'shown');
        case 'resting':
          return told('is resting after repeated errors', 'shown', ['it tries again within a minute']);
        case 'timeout':
          return told("didn't answer in time", 'shown', [
            took === undefined ? undefined : `nothing back within ${took}`,
          ]);
        case 'failed':
          return told("couldn't be reached", 'shown');
        default:
          return standDown.question === 'split'
            ? told("couldn't have the request split", 'shown', [standDown.because])
            : told("didn't answer", 'shown');
      }
    case 'size':
      if (standDown.question === 'group') {
        return told('found more devices than one request may move', 'shown', [
          `${standDown.value ?? '?'} commands, up to ${standDown.max ?? MAX_COMMANDS}`,
          took,
        ]);
      }
      return standDown.value === undefined || standDown.value === 0
        ? told('had no devices to choose from', 'quiet')
        : told("isn't offered a home this large", 'shown', [
            `${standDown.value} devices, up to ${standDown.max ?? MAX_DEVICE_OPTIONS} are offered`,
          ]);
    case 'unanswered':
      return told('left a question unanswered', 'shown', [
        QUESTION_WORDS[standDown.question] ?? standDown.question,
        took,
      ]);
    case 'declined':
      return told(`read it as ${standDown.label ?? 'something else'}`, 'logged', [
        measured({ named: false }),
        took,
      ]);
    case 'unsure': {
      const phrase =
        UNSURE_WORDS[standDown.question] ??
        (device !== undefined ? `wasn't sure what to do with ${device}` : "wasn't sure what to do");
      return told(phrase, 'shown', [measured({ named: true }), took]);
    }
    case 'blocked':
      switch (standDown.question) {
        case 'multiple':
          return told('heard more than one request', 'shown', [measured({ named: false }), took]);
        case 'later':
          return told('heard a time, a delay or a condition', 'shown', [measured({ named: false }), took]);
        case 'negated':
          return told('heard something taken back', 'shown', [measured({ named: false }), took]);
        case 'scope':
          return told(`heard ${standDown.label ?? 'something other than one device'}`, 'shown', [
            measured({ named: false }),
            took,
          ]);
        case 'place':
          return told(
            standDown.answer === NOT_SAID ? "didn't hear where" : "couldn't place where",
            'shown',
            [measured({ named: true }), took],
          );
        case 'deviceType':
          return told(
            standDown.because !== undefined ? `found ${standDown.because}` : "couldn't tell what kind of device",
            'shown',
            [measured({ named: true }), took],
          );
        case 'device':
          return told("couldn't match a device", 'shown', [measured({ named: true }), took]);
        case 'action':
          return told(
            standDown.because !== undefined
              ? `stood down: ${standDown.because}`
              : `can't work ${device ?? 'that device'} that way by itself`,
            'shown',
            [took],
          );
        case 'amount':
          return told(`read the number as ${standDown.label ?? 'something else'}`, 'shown', [
            measured({ named: false }),
            took,
          ]);
        case 'split':
          // The conversation's model was asked to split it and gave it back
          // whole: one request after all, and the model reads it as one.
          return told('was told it is one request after all', 'shown', [
            took === undefined ? undefined : `split in ${took}`,
          ]);
        default:
          return told(
            standDown.because !== undefined
              ? `stood down: ${standDown.because}`
              : `couldn't tell what to do with ${device ?? 'it'}`,
            'shown',
            [measured({ named: true }), took],
          );
      }
    case 'disagreed':
      return told('matched a device outside the place it heard', 'shown', [
        measured({ named: true }),
        device !== undefined && standDown.deviceRoom !== undefined
          ? `${device} is in ${standDown.deviceRoom}`
          : undefined,
        took,
      ]);
  }
}
