/**
 * Working out, in one request, what somebody asked the home to do — and which
 * commands, on which devices, that means.
 *
 * This is the vendor's own smart-home shape, step for step: one request
 * carrying the routing questions *and* every family's action question at once,
 * of which the code reads exactly the ones the resolved devices select. The
 * action questions are speculative because that is free — the questions are
 * answered in parallel, latency is roughly flat in their number, and a second
 * request would cost more than all of them together. A sentence that asks for
 * several *different* things is split by a generative model and its parts read
 * here in one more request (`decideParts`), which is the demo's other half.
 *
 * **Which devices is one yes/no per device, and the relative `device` choice
 * beside it** — the vendor's function-calling cookbook's answer to a
 * list-valued argument, and its jaggedness page's pairing of the two: a choice
 * settles *which one*, a yes/no per candidate settles *which ones, if any*. It
 * replaced a chain of four gated questions — how many, where, what kind, which
 * — each of which had to clear its own bar, so a request stood down over
 * distinctions that changed nothing: "no place said" against "the whole home"
 * for a sentence where both meant the same lamp, "one device" against "a group"
 * for a home with one light in it.
 *
 * **It is a skip-ahead and nothing else.** Every gate below falls through to
 * the assistant round that would have happened anyway, so being unsure, being
 * wrong about the shape, or not answering at all each cost exactly what the
 * hub cost before. And it does only what it is sure of: whatever it leaves
 * alone is the model's, told precisely what was already done. What it must
 * never do is widen what is possible: every command it returns is carried out
 * through the same path the model's own tool takes, past the same guards, into
 * the same activity row.
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
  DECISION_TIMEOUT_MS,
  DEVICE_LEAN_MIN,
  EFFORT_CONFIDENCE_MIN,
  EFFORT_QUESTION,
  EFFORT_SIMPLE_MAX,
  FAMILIES,
  MAX_DEVICE_OPTIONS,
  MAX_PARTS,
  MAX_TARGET_QUESTIONS,
  NEGATIVE_NOUL_MAX,
  NONE_OF_THESE,
  PART_CANDIDATES_MAX,
  POSITIVE_NOUL_MIN,
  SELF_CONTAINED_QUESTION,
  SHAPE_NAMES_MAX,
  SHAPE_NOTHING,
  SHAPE_ONE,
  SHAPE_ONE_AND_MORE,
  SHAPE_SEVERAL,
  SPLIT_MIN,
  TARGET_NO,
  TARGET_YES,
  UNCHANGED,
  amountIn,
  amountQuestion,
  deviceQuestion,
  everythingQuestion,
  familyQuestion,
  intentQuestion,
  laterQuestion,
  negatedQuestion,
  routeQuestion,
  shapeQuestion,
  singleQuestion,
  targetQuestion,
  type DeviceOption,
  type Family,
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

/** Everything one request resolved to — one device or several. */
export interface CommandPlan {
  actions: DeviceAction[];
  /**
   * What it was done to, the way a person says it: a device's own name,
   * "Kitchen light and Hall light", or "4 lights in the Kitchen".
   */
  target: string;
  /** Whether `target` is several things — "them" rather than "it". */
  plural: boolean;
  /** What was done, for the whole plan — the family's words, before any per-device extras. */
  wordings: Wording[];
  /**
   * Devices the hub already knows are offline, left out of `actions` when the
   * request was for several — see `readSubject`. Always empty for one device,
   * which is tried whatever it last reported: it was named, and the adapter's
   * answer is the true one.
   */
  offline: { deviceName: string; roomName?: string | undefined; wordings: Wording[] }[];
  /**
   * Devices the request may also have meant, which the reading left alone —
   * the relative `device` choice settled on another, and their own yes/no did
   * not rule them out. The model is told, and they are its to judge.
   */
  doubt: string[];
  /**
   * Devices "everything" deliberately stepped around — the fridge on a plug,
   * the heating — that the request would otherwise have moved. Left as they
   * were, and named to the model, so a message that really meant them too
   * ("everything, the heating as well") still reaches them, through it.
   */
  spared: string[];
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
 * own id (`targets` for the per-device questions taken together), or `home`
 * for the size bound, `model` when nothing came back, and `split` when the
 * parts of a sentence could not be had.
 */
export interface StandDown {
  question: string;
  /**
   * - `missed` — no reading came back; `miss` says why when the decider did.
   * - `size` — the home was empty, or too big to offer as options.
   * - `unanswered` — the reading left out a question this path needs.
   * - `unsure` — the answer did not clear its bar.
   * - `declined` — sure, and sure it was not a device command: the ordinary
   *   case for every question somebody asks, and not a failure of anything.
   * - `blocked` — sure, and sure of something this path never acts on: a
   *   delay, a change of mind, no matching device, an unlock of every door.
   * - `disagreed` — the device choice and that device's own yes/no pointed
   *   different ways.
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
  /** For `targets`: the devices in doubt, each with its own yes/no. */
  devices?: { name: string; value: number }[];
  /** The device the reading got as far as, by name. */
  device?: string;
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

/** A reading of one request — the sentence, or one part of it. */
export type SubjectReading = { kind: 'act'; plan: CommandPlan } | { kind: 'none'; standDown: StandDown };

/** What one reading of a sentence concluded. */
export type HomeDecision =
  /**
   * Carry these out — one device or several. `complete` when the sentence was
   * surely one request and nothing was left for the model to judge (see
   * `leftNothing`): the model is then told that was everything.
   */
  | ({ kind: 'act'; plan: CommandPlan; complete: boolean; effort: EffortHint } & Reading)
  /** Hand the whole sentence to this agent, as its own brief. */
  | ({ kind: 'route'; agentKey: string; confidence: number; effort: EffortHint } & Reading)
  /**
   * Several different things asked: split it, and read the parts
   * (`decideParts`) against `candidates` — the devices the sentence mentions
   * at all. `whole` is this reading of the sentence as one request, for when
   * the split comes back as one part after all.
   */
  | ({
      kind: 'split';
      confidence: number;
      effort: EffortHint;
      whole: SubjectReading;
      candidates: string[];
      deviceNames: string[];
    } & Reading)
  | { kind: 'none'; costUsd: number; effort: EffortHint; standDown: StandDown };

/** What reading each part of a split sentence concluded. */
export interface PartsDecision extends Reading {
  parts: { text: string; reading: SubjectReading }[];
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

/** What the questions call a kind of device, and several of them. */
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
 * What "everything" reaches.
 *
 * **Read narrowly, because that is what the word means.** "Turn everything
 * off in the kitchen" means the lights, the TV and the fan — not the fridge on
 * a smart plug, the heating, or the lock on the back door. A plug, an
 * appliance or a thermostat is moved when it is named for what it is, and
 * what "everything" steps around is named to the model (`CommandPlan.spared`),
 * never silently dropped.
 */
const EVERYTHING_KINDS: ReadonlySet<DeviceKind> = new Set([
  'light',
  'wallSwitch',
  'tv',
  'speaker',
  'fan',
  'airPurifier',
]);

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
 * seconds, and `one: 0.62` is a sentence only its author can read. Keyed by the
 * option ids in `questions.ts`, and `test/ai-decide-questions.test.ts` holds the
 * two together, so an option added there without words here fails a test
 * rather than reaching a trail as an identifier.
 */
export const OPTION_WORDS: Readonly<Record<string, string>> = {
  device_command: 'a device command',
  home_question: 'a question about the home',
  scene: 'a scene',
  automation_work: 'an automation',
  app_question: 'a question about the app',
  other: 'something else',
  [SHAPE_ONE]: 'one thing to do',
  [SHAPE_ONE_AND_MORE]: 'one thing to do and a question',
  [SHAPE_SEVERAL]: 'several different things to do',
  [SHAPE_NOTHING]: 'nothing to do',
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
 * The catalog: the home's devices as the questions offer them.
 * ------------------------------------------------------------------ */

interface Catalog {
  options: DeviceOption[];
  byKey: Map<string, DecidableDevice>;
  /** Whether each device has a `target_` question of its own in this reading. */
  targeted: boolean;
  /** For each device, the others it could be mistaken for — see `confusables`. */
  confusable: Map<string, DeviceOption[]>;
  roomName: Map<string, string>;
}

/** The kind a device is best described as — the first endpoint that says. */
function kindOf(device: DecidableDevice): DeviceKind | undefined {
  return device.endpoints.find((endpoint) => endpoint.deviceKind !== undefined)?.deviceKind;
}

/** The words of a name, lower-cased, for telling which names could be mistaken for each other. */
function wordsOf(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 2);
}

/**
 * How many other devices a `target_` question names as not this one.
 *
 * Enough to cover a light called *Light TV* beside a *TV* and a *Ceiling
 * light*; bounded because every one is a clause in a question.
 */
const CONFUSABLE_MAX = 4;

/** What a device of no known kind is called — never a reason to think two devices alike. */
const UNKNOWN_KIND_WORDS = 'A device';

/**
 * The devices one could be mistaken for, most alike first: those sharing a
 * word of its name, then those of the same kind — in its own room before
 * anywhere else.
 *
 * A yes/no cannot compare itself with the question beside it, so "turn on the
 * light tv" read against a device called *TV* alone is plausibly about it, and
 * "switch the light on" read against one of three lights is plausibly about
 * each of them. Naming the others in the question is what lets it say no — or
 * say it cannot tell, which makes the reading stand down and the model ask.
 */
function confusables(options: readonly DeviceOption[]): Map<string, DeviceOption[]> {
  const words = new Map(options.map((option) => [option.key, new Set(wordsOf(option.name))]));
  const out = new Map<string, DeviceOption[]>();
  for (const option of options) {
    const mine = words.get(option.key)!;
    const scored: { other: DeviceOption; shared: number; sameKind: boolean; sameRoom: boolean }[] = [];
    for (const other of options) {
      if (other.key === option.key) continue;
      let shared = 0;
      for (const word of words.get(other.key)!) if (mine.has(word)) shared += 1;
      const sameKind = other.kindWords === option.kindWords && option.kindWords !== UNKNOWN_KIND_WORDS;
      if (shared === 0 && !sameKind) continue;
      scored.push({ other, shared, sameKind, sameRoom: other.roomName === option.roomName });
    }
    scored.sort(
      (a, b) =>
        b.shared - a.shared ||
        Number(b.sameKind) - Number(a.sameKind) ||
        Number(b.sameRoom) - Number(a.sameRoom),
    );
    out.set(
      option.key,
      scored.slice(0, CONFUSABLE_MAX).map((entry) => entry.other),
    );
  }
  return out;
}

function catalogOf(home: DecidableHome, devices: readonly DecidableDevice[] = home.devices): Catalog {
  const roomName = new Map(home.rooms.map((room) => [room.id, room.name]));
  const zoneName = new Map((home.zones ?? []).map((zone) => [zone.id, zone.name]));
  const zoneOfRoom = new Map<string, string>();
  for (const room of home.rooms) {
    if (room.zoneId !== null && room.zoneId !== undefined) zoneOfRoom.set(room.id, room.zoneId);
  }

  // Short plain keys, the name in the description — see `DeviceOption`.
  const options: DeviceOption[] = [];
  const byKey = new Map<string, DecidableDevice>();
  for (const [index, device] of devices.entries()) {
    const room = device.roomId !== null ? roomName.get(device.roomId) : undefined;
    const zoneId = device.roomId !== null ? zoneOfRoom.get(device.roomId) : undefined;
    const kind = kindOf(device);
    const key = `d${index + 1}`;
    options.push({
      key,
      name: device.name,
      kindWords: kind !== undefined ? KIND_WORDS[kind].one : UNKNOWN_KIND_WORDS,
      roomName: room,
      zoneName: zoneId !== undefined ? zoneName.get(zoneId) : undefined,
    });
    byKey.set(key, device);
  }
  const targeted = options.length <= MAX_TARGET_QUESTIONS;
  return {
    options,
    byKey,
    targeted,
    confusable: targeted ? confusables(options) : new Map(),
    roomName,
  };
}

/** The names `shape` is told about: those of more than one word, which are the ones misread as two things. */
function multiWordNames(catalog: Catalog): string[] {
  return catalog.options
    .map((option) => option.name.trim())
    .filter((name) => wordsOf(name).length > 1)
    .slice(0, SHAPE_NAMES_MAX);
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

/** A stand-down, with nothing about the request that produced it yet. */
function stood(standDown: StandDown): SubjectReading {
  return { kind: 'none', standDown };
}

/**
 * The devices a request is for, or why that is not clear enough to act on.
 *
 * Two signals, and the rule for combining them is the whole of it:
 *
 * - **The `device` choice is relative.** It weighs every device against every
 *   other, so it can tell "the light tv" is *Light TV* and not *TV* — and it
 *   can only ever name one.
 * - **Each device's own `target_` yes/no is absolute.** It can say yes for
 *   several ("the kitchen light and the hall light", "all the lights"), and no
 *   for all of them.
 *
 * **One device** when the choice is sure of it and its own yes/no does not say
 * no — or when the choice leans to it and its own yes/no is the only clear yes
 * in the home, two readings of different kinds agreeing. Any other device the
 * yes/nos did not rule out is left alone and named to the model.
 *
 * **Several** when the choice settles nothing and every yes/no is clear one
 * way or the other — unless `single` hears one device asked for, which is
 * "switch the light on" in a home with three of them, and the model asks.
 *
 * Otherwise the reading stands down, naming the devices it could not tell
 * about.
 */
function resolveTargets(input: {
  answers: SubjectAnswers;
  catalog: Catalog;
}): { devices: DecidableDevice[]; doubt: string[]; confidence: number } | StandDown {
  const { answers, catalog } = input;
  const picked = answers.choice('device');
  if (picked === undefined) return { question: 'device', reason: 'unanswered' };
  const pickedDevice = picked.choice === NONE_OF_THESE ? undefined : catalog.byKey.get(picked.choice);
  const named = (key: string): string => catalog.byKey.get(key)?.name ?? OPTION_WORDS[key] ?? key;

  // A home too large for a yes/no per device is read by the choice alone,
  // which names one device and never a set.
  if (!catalog.targeted) {
    if (pickedDevice !== undefined && picked.confidence >= ACT_CONFIDENCE_MIN) {
      return { devices: [pickedDevice], doubt: [], confidence: picked.confidence };
    }
    const nearly = runnerUpOf(picked);
    return {
      question: 'device',
      reason:
        picked.choice === NONE_OF_THESE && picked.confidence >= ACT_CONFIDENCE_MIN ? 'blocked' : 'unsure',
      answer: picked.choice,
      label: named(picked.choice),
      value: picked.confidence,
      min: ACT_CONFIDENCE_MIN,
      ...(nearly !== undefined ? { runnerUp: named(nearly) } : {}),
    };
  }

  const values = new Map<string, number>();
  for (const option of catalog.options) {
    const answer = answers.noul(`target_${option.key}`);
    if (answer === undefined) return { question: 'targets', reason: 'unanswered', device: option.name };
    values.set(option.key, answer.noul);
  }
  const valueOf = (option: DeviceOption): number => values.get(option.key)!;
  const yes = catalog.options.filter((option) => valueOf(option) >= TARGET_YES);
  const unsure = catalog.options.filter(
    (option) => valueOf(option) > TARGET_NO && valueOf(option) < TARGET_YES,
  );
  /** Devices with their own numbers, the likeliest first — for the model, and for a stand-down. */
  const listed = (options: readonly DeviceOption[]) =>
    options
      .map((option) => ({ name: option.name, value: valueOf(option) }))
      .sort((a, b) => b.value - a.value);

  if (pickedDevice !== undefined) {
    const own = values.get(picked.choice)!;
    const sure = picked.confidence >= ACT_CONFIDENCE_MIN;
    // Sure of one device, and that device's own yes/no sure it was not asked
    // for: one of the two is wrong, and there is no telling which.
    if (sure && own <= TARGET_NO) {
      return {
        question: 'targets',
        reason: 'disagreed',
        answer: picked.choice,
        label: pickedDevice.name,
        value: own,
        device: pickedDevice.name,
      };
    }
    const leaning =
      picked.confidence >= DEVICE_LEAN_MIN &&
      own >= TARGET_YES &&
      yes.every((option) => option.key === picked.choice);
    if (sure || leaning) {
      return {
        devices: [pickedDevice],
        doubt: listed([...yes, ...unsure].filter((option) => option.key !== picked.choice)).map(
          (entry) => entry.name,
        ),
        confidence: sure ? picked.confidence : Math.min(picked.confidence, own),
      };
    }
  }

  if (yes.length > 0 && unsure.length === 0) {
    if (yes.length > 1) {
      // Several clear yeses to a sentence that asked for one device: "switch
      // the light on" in a home with three lights. Which one is the model's to
      // ask — never all three.
      const single = answers.noul('single');
      if (single === undefined) return { question: 'single', reason: 'unanswered' };
      if (single.noul >= TARGET_YES) {
        return { question: 'single', reason: 'unsure', value: single.noul, devices: listed(yes) };
      }
    }
    // Every other device a clear no, which is a link in the chain too: the
    // reading rests on those being left alone as much as on these being moved.
    const rest = catalog.options.filter((option) => valueOf(option) < TARGET_YES);
    const clearestNo = Math.max(0, ...rest.map(valueOf));
    return {
      devices: yes.map((option) => catalog.byKey.get(option.key)!),
      doubt: [],
      confidence: Math.min(...yes.map(valueOf), 1 - clearestNo),
    };
  }

  if (yes.length === 0 && unsure.length === 0) {
    // Every device a clear no: nothing in this home was asked for.
    return {
      question: 'targets',
      reason: 'blocked',
      answer: picked.choice,
      label: named(picked.choice),
      value: picked.confidence,
      because: 'no device in this home was named',
    };
  }
  return {
    question: 'targets',
    reason: 'unsure',
    devices: listed([...yes, ...unsure]),
    min: TARGET_YES,
    max: TARGET_NO,
  };
}

/**
 * What to call a set of devices in a sentence — their own names for up to
 * three, and "4 lights in the Kitchen" past that.
 */
function nameOfSet(
  devices: readonly DecidableDevice[],
  catalog: Catalog,
  home: DecidableHome,
): { target: string; plural: boolean } {
  if (devices.length === 1) return { target: devices[0]!.name, plural: false };
  if (devices.length <= 3) {
    const names = devices.map((device) => device.name);
    return { target: `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]!}`, plural: true };
  }
  const kinds = new Set(devices.map((device) => kindOf(device)));
  const [kind] = kinds;
  const many = kinds.size === 1 && kind !== undefined ? KIND_WORDS[kind].many : 'devices';
  const rooms = new Set(devices.map((device) => device.roomId));
  const [room] = rooms;
  if (rooms.size === 1 && room !== null && room !== undefined) {
    return { target: `${devices.length} ${many} in the ${catalog.roomName.get(room) ?? room}`, plural: true };
  }
  const everyOne =
    kinds.size === 1 && home.devices.filter((device) => kindOf(device) === kind).length === devices.length;
  return { target: `${devices.length} ${many}${everyOne ? ' across the home' : ''}`, plural: true };
}

/**
 * Whether a plan left nothing for the model to judge: no device it was unsure
 * about, and none that "everything" stepped around. Half of `complete` — the
 * other half is whether the sentence was one request at all.
 */
export function leftNothing(plan: CommandPlan): boolean {
  return plan.doubt.length === 0 && plan.spared.length === 0;
}

/**
 * Read one request — the sentence, or one part of a split sentence — into a
 * plan, or say why not.
 *
 * Everything here is code over typed answers: which devices, which endpoint,
 * which command, and every number. The model has already said what it thinks
 * each thing is; this decides whether that is enough to act on.
 */
function readSubject(input: {
  answers: SubjectAnswers;
  catalog: Catalog;
  home: DecidableHome;
  amount: { text: string; value: number } | undefined;
  /**
   * What is known about the request's shape before this is read. `one`: the
   * sentence is surely one request, so it has to *be* a device command.
   * `more`: it is one thing done beside something else, so what it asks for is
   * a command whatever `intent` says about the whole. `part`: one part of a
   * split sentence, which has to be one device command on its own.
   */
  mode: 'one' | 'more' | 'part';
}): SubjectReading {
  const { answers, catalog, home } = input;
  /** An option as a person reads it: a thing's own name, or the battery's words for it. */
  const spoken = (option: string): string =>
    catalog.byKey.get(option)?.name ?? OPTION_WORDS[option] ?? option;
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
  /** A guard that has to read as a clear no. */
  const guard = (id: string): StandDown | undefined => {
    const answer = answers.noul(id);
    if (answer === undefined) return { question: id, reason: 'unanswered' };
    if (answer.noul > NEGATIVE_NOUL_MAX) {
      return { question: id, reason: 'blocked', value: answer.noul, max: NEGATIVE_NOUL_MAX };
    }
    return undefined;
  };

  const intent = answers.choice('intent');
  if (input.mode !== 'more') {
    if (intent === undefined) return stood({ question: 'intent', reason: 'unanswered' });
    // Something other than a device command is the model's — a scene, a rule,
    // a question about the app — and so is a sentence two questions disagree
    // about: `shape` heard something to do, and this heard something else.
    if (intent.choice !== 'device_command') {
      return intent.confidence >= ACT_CONFIDENCE_MIN
        ? stood({ question: 'intent', reason: 'declined', ...read(intent) })
        : stood({ question: 'intent', reason: 'unsure', ...read(intent), min: ACT_CONFIDENCE_MIN });
    }
    // A part stands on its own, so it has to be sure of itself.
    if (input.mode === 'part' && intent.confidence < ACT_CONFIDENCE_MIN) {
      return stood({ question: 'intent', reason: 'unsure', ...read(intent), min: ACT_CONFIDENCE_MIN });
    }
  }
  if (input.mode === 'part') {
    // A part was split to be one request; if it is still several, it is the model's.
    const shape = answers.choice('shape');
    if (shape === undefined) return stood({ question: 'shape', reason: 'unanswered' });
    const several = shape.probabilities[SHAPE_SEVERAL] ?? 0;
    if (several > NEGATIVE_NOUL_MAX) {
      return stood({ question: 'shape', reason: 'blocked', ...read(shape), value: several, max: NEGATIVE_NOUL_MAX });
    }
  }

  // A time, a delay or a condition ends it: nothing here can wait, and a
  // command read without its "at seven" would happen now.
  const later = guard('later');
  if (later !== undefined) return stood(later);
  // So does taking something back — "on — no, off" is for the model to read whole.
  const negated = guard('negated');
  if (negated !== undefined) return stood(negated);

  const targets = resolveTargets({ answers, catalog });
  if ('reason' in targets) return stood(targets);
  let devices = targets.devices;

  const families = new Map<Family, ChoiceRead | undefined>(
    FAMILIES.map((family) => [family, answers.choice(family)]),
  );
  const amountKind = input.amount !== undefined ? answers.choice('amount') : undefined;
  const numbers = { amount: input.amount, kind: amountKind };

  /**
   * **"Everything" is narrowed in code, and the model is told what it left.**
   * A device's own yes/no answering yes for the fridge plug in "everything off
   * in the kitchen" is answering the sentence correctly; what somebody means by
   * the word is the things they switch off leaving a room, and that list is
   * ours (`EVERYTHING_KINDS`). What it steps around and would otherwise have
   * moved is named in `spared`, so "everything, the heating too" still reaches
   * the heating — through the model, which reads the whole sentence.
   */
  const spared: string[] = [];
  if (devices.length > 1) {
    const all = answers.noul('everything');
    const reached = (device: DecidableDevice): boolean => {
      const kind = kindOf(device);
      return kind !== undefined && EVERYTHING_KINDS.has(kind);
    };
    if (all !== undefined && all.noul >= TARGET_YES) {
      for (const device of devices) {
        if (reached(device)) continue;
        const would = planDevice({ device, families, numbers, home, catalog, group: true });
        if (!('reason' in would)) spared.push(device.name);
      }
      devices = devices.filter(reached);
      if (devices.length === 0) {
        return stood({ question: 'everything', reason: 'blocked', because: 'nothing that "everything" reaches was asked for' });
      }
    } else if (!devices.every(reached)) {
      if (all === undefined) return stood({ question: 'everything', reason: 'unanswered' });
      if (all.noul > TARGET_NO) {
        return stood({ question: 'everything', reason: 'unsure', value: all.noul, min: TARGET_YES, max: TARGET_NO });
      }
    }
  }
  const several = devices.length > 1;

  const actions: DeviceAction[] = [];
  const offline: CommandPlan['offline'] = [];
  const confidences: number[] = [targets.confidence];
  let wordings: Wording[] | undefined;
  for (const device of devices) {
    const planned = planDevice({ device, families, numbers, home, catalog, group: several });
    if ('reason' in planned) {
      // A device the action does not apply to — a light that cannot dim, in
      // "dim the lights" — is left alone when several were asked for; anything
      // else unsure about one of them is unsure about the request.
      if (several && planned.reason === 'blocked' && planned.question === 'action') continue;
      return stood({ ...planned, device: device.name });
    }
    confidences.push(...planned.confidences);
    wordings ??= planned.familyWordings;
    /**
     * **One of several the hub knows is offline is not tried.** A command to a
     * device that cannot hear it is at best an error and at worst a wait — a
     * Matter node that has dropped off holds its command through every
     * retransmission — and one bulb in a hallway must not keep the rest of the
     * house waiting for the sentence that says the lights are off. It is named
     * instead, so the reply can say which one did not go off.
     */
    if (several && device.online === false) {
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
    return stood({ question: 'action', reason: 'blocked', because: 'every device it was asked about is offline' });
  }
  if (actions.length === 0 || wordings === undefined) {
    return stood({ question: 'action', reason: 'blocked', because: 'none of those devices can do that' });
  }

  /**
   * **A set of locks is never unlocked here — the one rule about how many.**
   * Every other mistake a reading can make is one tap to put right; a front
   * door unlocked because a sentence was misheard is not, so unlocking more
   * than one lock is left to the model, which reads the sentence itself and
   * can ask. Locking every door is what somebody asks leaving the house, and
   * goes ahead. There is deliberately **no count** beside it: the model has no
   * tool that moves more than one device, so a cap on how many lights a
   * reading may switch sent exactly the biggest requests — "turn off all the
   * lights" in a large home — to the slowest road, while the per-device
   * questions, the relative choice and `single` are what guard the misreading.
   */
  const unlocks = actions.filter((action) =>
    action.commands.some(({ command }) => command.type === 'lock' && !command.engage),
  );
  if (unlocks.length > 1) {
    return stood({ question: 'lock', reason: 'blocked', because: 'several locks are never unlocked at once' });
  }

  const acted = devices.filter((device) => actions.some((action) => action.deviceId === device.id));
  const { target, plural } = nameOfSet(acted, catalog, home);
  return {
    kind: 'act',
    plan: {
      actions,
      target,
      plural,
      // One device says what was done to *it* — "switched on and set to 40%" —
      // and several say what was done to all of them.
      wordings: several ? wordings : actions[0]!.wordings,
      offline,
      doubt: targets.doubt,
      spared,
      confidence: Math.min(...confidences),
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
    // Several locks unlocked at once is refused by the reading as a whole —
    // see `readSubject` — so one lock in a set is worked like any other device.
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

/**
 * The questions every request is asked, under a prefix so several can share
 * one request.
 *
 * `target_` is one question per device — the part that grows with the home,
 * and why `MAX_TARGET_QUESTIONS` exists — and each carries that device's own
 * description and the devices it could be mistaken for, so the state stays
 * the sentence alone (rule 4 in `questions.ts`).
 */
function subjectQuestions(input: {
  subject: Subject;
  prefix: string;
  catalog: Catalog;
  withAmount: boolean;
}): Record<string, Questions[string]> {
  const { subject, prefix, catalog } = input;
  const questions: Record<string, Questions[string]> = {
    [`${prefix}intent`]: intentQuestion(subject),
    [`${prefix}shape`]: shapeQuestion(multiWordNames(catalog), subject),
    [`${prefix}later`]: laterQuestion(subject),
    [`${prefix}negated`]: negatedQuestion(subject),
    [`${prefix}device`]: deviceQuestion(catalog.options, subject),
    [`${prefix}single`]: singleQuestion(subject),
    [`${prefix}everything`]: everythingQuestion(subject),
  };
  if (catalog.targeted) {
    for (const option of catalog.options) {
      questions[`${prefix}target_${option.key}`] = targetQuestion(
        option,
        catalog.confusable.get(option.key) ?? [],
        subject,
      );
    }
  }
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
 * The devices a sentence is about at all, likeliest first — what its parts are
 * asked about.
 *
 * Every device, in a home small enough; otherwise the ones the reading of the
 * whole sentence ranked highest, by the larger of their own yes/no and their
 * share of the `device` choice. The parts then look closely at those rather
 * than at the whole house again: the vendor's skill cookbook's shape — rank
 * wide, then look closely at a shortlist.
 */
function candidatesOf(answers: SubjectAnswers, catalog: Catalog): string[] {
  const idOf = (option: DeviceOption): string => catalog.byKey.get(option.key)!.id;
  if (catalog.options.length <= PART_CANDIDATES_MAX) return catalog.options.map(idOf);
  const picked = answers.choice('device');
  return catalog.options
    .map((option) => ({
      option,
      rank: Math.max(
        catalog.targeted ? (answers.noul(`target_${option.key}`)?.noul ?? 0) : 0,
        picked?.probabilities[option.key] ?? 0,
      ),
    }))
    .sort((a, b) => b.rank - a.rank)
    .slice(0, PART_CANDIDATES_MAX)
    .map((entry) => idOf(entry.option));
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
   * The shape, the guards, the devices, every family's action and the
   * handover, asked together because they are answered in parallel and
   * cannot see one another — so asking the action questions "just in case" is
   * what the parallelism is *for*, not a waste of it.
   */
  const questions = {
    ...subjectQuestions({ subject: 'said', prefix: '', catalog, withAmount: amount !== undefined }),
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
    // the number is *of* and never to read it. The devices are the criteria of
    // their own questions; repeating them here would be state that answers
    // nothing while every question pays for it.
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
  const timed = (why: StandDown): StandDown => ({
    ...why,
    durationMs: reading.durationMs,
    ...(reading.newConnection !== undefined ? { newConnection: reading.newConnection } : {}),
    ...(reading.requestId !== undefined ? { requestId: reading.requestId } : {}),
  });
  const standDown = (why: StandDown): HomeDecision => ({
    kind: 'none',
    costUsd: reading.costUsd,
    effort,
    standDown: timed(why),
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
  const told = (answer: ChoiceRead) => {
    const nearly = runnerUpOf(answer);
    return {
      answer: answer.choice,
      label: spoken(answer.choice),
      value: answer.confidence,
      ...(nearly !== undefined ? { runnerUp: spoken(nearly) } : {}),
    };
  };
  const subject = answersUnder(answers, '');

  const shape = choice('shape');
  if (shape === undefined) return standDown({ question: 'shape', reason: 'unanswered' });
  const share = (option: string): number => shape.probabilities[option] ?? 0;

  /**
   * **Several different things: split it — and only then.**
   *
   * The split is writing, which a generative model does (`split.ts`), and the
   * parts come back to `decideParts`, asked about the devices this reading
   * found the sentence mentions at all. It is the one road that costs a model
   * round of its own, so it is taken only when `shape` leans to it: one action
   * on several devices is one thing, which the `target_` questions carry, and a
   * device called *Light TV* is one device, which `shape` is told.
   *
   * Checked before anything else, because the rest of this reading is of the
   * sentence as one request, and a compound sentence read that way is usually
   * half right. That reading rides along as `whole` all the same, for a split
   * that comes back as one part: one request after all, on the model's word,
   * with nothing more to pay to act on it.
   */
  if (share(SHAPE_SEVERAL) >= SPLIT_MIN) {
    const whole = readSubject({ answers: subject, catalog, home, amount, mode: 'one' });
    return {
      kind: 'split',
      confidence: share(SHAPE_SEVERAL),
      effort,
      whole: whole.kind === 'none' ? { kind: 'none', standDown: timed(whole.standDown) } : whole,
      candidates: candidatesOf(subject, catalog),
      deviceNames: multiWordNames(catalog),
      ...reading,
    };
  }

  /**
   * Handing the job over is a *route*, not an action: writing a rule is
   * writing, and the agent that does it is the one that knows the format.
   *
   * Three answers have to agree before it happens. `route` says who should
   * take it; `selfContained` says whether the person's own sentence is enough
   * of a brief for somebody who has not read the conversation — which is the
   * one thing a fast route gives up against a handover the model composes, and
   * "make it half past instead" is exactly what it catches; and `intent` must
   * not have heard a device command, which is never handed away.
   */
  const intent = choice('intent');
  const route = choice('route');
  const selfContained = noul('selfContained');
  const handover = route !== undefined && route.choice !== 'here' && intent?.choice !== 'device_command';
  if (
    handover &&
    route.confidence >= ACT_CONFIDENCE_MIN &&
    selfContained !== undefined &&
    selfContained.noul >= POSITIVE_NOUL_MIN
  ) {
    return { kind: 'route', agentKey: route.choice, confidence: route.confidence, effort, ...reading };
  }

  const something = share(SHAPE_ONE) + share(SHAPE_ONE_AND_MORE);
  if (something < ACT_CONFIDENCE_MIN) {
    // Not clearly something to do now. When a handover was on the table and
    // one of its two answers fell short, *that* is why nothing happened.
    if (handover) {
      if (route.confidence < ACT_CONFIDENCE_MIN) {
        return standDown({ question: 'route', reason: 'unsure', ...told(route), min: ACT_CONFIDENCE_MIN });
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
    // Sure there is nothing to do — a question, chat, a rule for later — which
    // is most sentences, and the design working. Said in `intent`'s words
    // when it has them, since "a question about the home" says more than
    // "nothing to do".
    if (share(SHAPE_NOTHING) >= ACT_CONFIDENCE_MIN) {
      if (
        intent !== undefined &&
        intent.choice !== 'device_command' &&
        intent.confidence >= ACT_CONFIDENCE_MIN
      ) {
        return standDown({
          question: 'intent',
          reason: 'declined',
          answer: intent.choice,
          label: spoken(intent.choice),
          value: intent.confidence,
        });
      }
      return standDown({
        question: 'shape',
        reason: 'declined',
        answer: SHAPE_NOTHING,
        label: spoken(SHAPE_NOTHING),
        value: share(SHAPE_NOTHING),
      });
    }
    return standDown({ question: 'shape', reason: 'unsure', ...told(shape), min: ACT_CONFIDENCE_MIN });
  }

  /**
   * One thing to do — surely on its own (`one`), or beside a question or a
   * remark (`more`), whose other half is the model's whatever happens here.
   *
   * **`complete` only for the first, with nothing left for the model to
   * judge** — no device in doubt, none that "everything" stepped around: that
   * is when the model is told the reading was everything they asked for and
   * runs its round only to say so. Anything less and it is told what was done
   * and left to read the rest of the sentence itself.
   */
  const alone = share(SHAPE_ONE) >= ACT_CONFIDENCE_MIN;
  const read = readSubject({ answers: subject, catalog, home, amount, mode: alone ? 'one' : 'more' });
  if (read.kind === 'none') return standDown(read.standDown);
  return {
    kind: 'act',
    plan: { ...read.plan, confidence: Math.min(read.plan.confidence, something) },
    complete: alone && leftNothing(read.plan),
    effort,
    ...reading,
  };
}

/**
 * Read the parts a sentence was split into, all of them in one request.
 *
 * **One request, not one per part** — the vendor's fan-out rule, and the
 * reason the parts go into the state as a list: each question points at its
 * own part by path (`parts[1]`), so every part is read in parallel in the time
 * one would take. A part the reading is sure of becomes a plan; everything
 * else — a question, an automation, a part it was unsure about — is left for
 * the model, with the reason.
 *
 * **Against the shortlist, not the house.** `candidates` is what the reading
 * of the whole sentence found it mentions at all (`candidatesOf`), so a part
 * is asked one yes/no per likely device rather than per device in the home —
 * which is what keeps four parts of a large home inside one request.
 */
export async function decideParts(input: {
  decider: Decider;
  home: DecidableHome;
  parts: readonly string[];
  /** Device ids, likeliest first — the split's `candidates`. Every device when absent. */
  candidates?: readonly string[];
  timeoutMs?: number;
}): Promise<PartsDecision> {
  const { home } = input;
  const parts = input.parts.slice(0, MAX_PARTS);
  const byId = new Map(home.devices.map((device) => [device.id, device]));
  const shortlist = (input.candidates ?? []).flatMap((id) => {
    const device = byId.get(id);
    return device === undefined ? [] : [device];
  });
  const devices = shortlist.length > 0 ? shortlist : home.devices;
  if (devices.length === 0 || devices.length > MAX_DEVICE_OPTIONS) {
    const size: StandDown = { question: 'home', reason: 'size', value: devices.length, max: MAX_DEVICE_OPTIONS };
    return {
      costUsd: 0,
      durationMs: 0,
      parts: parts.map((text) => ({ text, reading: { kind: 'none', standDown: { ...size, part: text } } })),
    };
  }
  const catalog = catalogOf(home, devices);
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
        mode: 'part',
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
 *   was sure there was nothing for it to do.
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
  shape: 'how many things were asked',
  later: 'whether it was for now',
  negated: 'whether it was taken back',
  device: 'which device',
  targets: 'which devices',
  single: 'whether one device was meant',
  everything: 'whether it meant everything',
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
  shape: "wasn't sure how many things were asked",
  route: "wasn't sure who should take it",
  selfContained: 'needed the rest of the conversation',
  device: "wasn't sure which device",
  targets: "wasn't sure which devices were meant",
  single: 'heard one device asked for, and more than one fits',
  everything: "wasn't sure it meant everything",
  amount: "wasn't sure what the number was",
};

/** What a yes/no's number is the probability *of*, so it never stands alone. */
const NOUL_WORDS: Readonly<Record<string, string>> = {
  later: 'later or on a condition',
  negated: 'taken back',
  selfContained: 'stands on its own',
  single: 'one device',
  everything: 'everything',
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
  // The devices a reading could not tell about, each with its own yes/no — and
  // the two bars those sat between, when that is why.
  const listed = (): string | undefined => {
    if (standDown.devices === undefined || standDown.devices.length === 0) return undefined;
    const devices = standDown.devices.map((entry) => `${entry.name} ${two(entry.value)}`).join(', ');
    return standDown.value === undefined && standDown.min !== undefined && standDown.max !== undefined
      ? `${devices} — each needs ${two(standDown.min)}, or at most ${two(standDown.max)}`
      : devices;
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
      return standDown.value === undefined || standDown.value === 0
        ? told('had no devices to choose from', 'quiet')
        : told("isn't offered a home this large", 'shown', [
            `${standDown.value} devices, up to ${standDown.max ?? MAX_DEVICE_OPTIONS} are offered`,
          ]);
    case 'unanswered':
      return told('left a question unanswered', 'shown', [
        QUESTION_WORDS[standDown.question] ?? standDown.question,
        device !== undefined ? `about ${device}` : undefined,
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
      return told(phrase, 'shown', [measured({ named: true }), listed(), took]);
    }
    case 'blocked':
      switch (standDown.question) {
        case 'later':
          return told('heard a time, a delay or a condition', 'shown', [measured({ named: false }), took]);
        case 'negated':
          return told('heard something taken back', 'shown', [measured({ named: false }), took]);
        case 'shape':
          // One part of a split sentence that still asks for several things.
          return told('heard several things in one part', 'shown', [measured({ named: false }), took]);
        case 'targets':
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
      // The `device` choice was sure of one device, and that device's own
      // yes/no was sure it had not been asked for.
      return told(`picked ${device ?? 'a device'}, then read it as not asked for`, 'shown', [
        standDown.value !== undefined ? `its own yes/no: ${two(standDown.value)}` : undefined,
        took,
      ]);
  }
}
