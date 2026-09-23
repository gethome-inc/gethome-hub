/**
 * Working out, in one request, whether what somebody said is one plain device
 * command — and which command, on which device.
 *
 * This is the vendor's own smart-home shape: a single request carrying the
 * routing questions *and* every branch's action question at once, of which the
 * code reads exactly one branch. The branches are speculative because that is
 * free — the questions are answered in parallel, latency is roughly flat in
 * their number, and a second request would cost more than all of them together.
 *
 * **It is a skip-ahead and nothing else.** Every gate below falls through to
 * the assistant round that would have happened anyway, so being unsure, being
 * wrong about the shape, or not answering at all each cost exactly what the
 * hub cost before. What it must never do is widen what is possible: the
 * command it returns is carried out through the same path the model's own tool
 * takes, past the same guards, into the same activity row.
 *
 * `docs/jev.md` is canonical.
 */
import type { CapabilityKind, HubCommand } from '../../schema/index.js';
import type { Decider, DecisionMiss } from './decider.js';
import {
  ACT_CONFIDENCE_MIN,
  COVERING_ACTION_QUESTION,
  DECISION_TIMEOUT_MS,
  EFFORT_CONFIDENCE_MIN,
  EFFORT_QUESTION,
  EFFORT_SIMPLE_MAX,
  INTENT_QUESTION,
  LOCK_ACTION_QUESTION,
  MAX_DEVICE_OPTIONS,
  MULTIPLE_QUESTION,
  NEEDS_VALUE_QUESTION,
  NEGATIVE_NOUL_MAX,
  NONE_OF_THESE,
  PLAYBACK_ACTION_QUESTION,
  POSITIVE_NOUL_MIN,
  SCOPE_QUESTION,
  SELF_CONTAINED_QUESTION,
  SWITCH_ACTION_QUESTION,
  deviceQuestion,
  roomQuestion,
  routeQuestion,
} from './questions.js';

/** What the decider is told about the home, and what it answers over. */
export interface DecidableHome {
  rooms: readonly { id: string; name: string; zoneName?: string | undefined }[];
  devices: readonly {
    id: string;
    name: string;
    roomId: string | null;
    endpoints: readonly { endpointId: number; capabilities: readonly CapabilityKind[] }[];
  }[];
}

/**
 * What one reading also concluded about how hard the round should work.
 *
 * `'low'` or nothing: this may only ever make a round cheaper — see
 * `EFFORT_QUESTION` on why the other direction is not offered.
 */
export type EffortHint = 'low' | undefined;

/** One resolved command, ready for the path the model's own tool uses. */
export interface DecidedCommand {
  deviceId: string;
  deviceName: string;
  endpointId: number;
  command: HubCommand;
  /** For the step the app draws, and for a log line that can be argued with. */
  confidence: number;
  durationMs: number;
  costUsd: number;
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
 * own id, or `home` for the size bound and `model` when nothing came back.
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
   * - `blocked` — sure, and sure of something this path never acts on: more
   *   than one request, an amount, a whole room, no matching device.
   * - `disagreed` — the room and the device were both confident, and pointed
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
  /** For `disagreed`: the room that device is really in. */
  deviceRoom?: string;
  /** How long the reading took — or, for a timeout, how long it was waited for. */
  durationMs?: number;
  /** The vendor's own id for the request, so a log line can be traced. */
  requestId?: string;
}

/** What one reading of a sentence concluded. */
export type HomeDecision =
  | { kind: 'command'; command: DecidedCommand; effort: EffortHint }
  /** Hand the whole sentence to this agent, as its own brief. */
  | {
      kind: 'route';
      agentKey: string;
      confidence: number;
      costUsd: number;
      durationMs: number;
      effort: EffortHint;
    }
  | { kind: 'none'; costUsd: number; effort: EffortHint; standDown: StandDown };

/**
 * Which capability an action needs, so the endpoint is chosen by what it can
 * do rather than by what it is called.
 *
 * A device is a list of endpoints and only some of them can take a given
 * command; picking the first one would put a lock command on a battery
 * endpoint. The command itself is built here too, and **every one of them is
 * number-free** — the model is never asked for a quantity, so there is never
 * one to get wrong.
 */
const ACTIONS: Record<string, { capability: CapabilityKind; command: HubCommand }> = {
  turn_on: { capability: 'onOff', command: { type: 'power', on: true } },
  turn_off: { capability: 'onOff', command: { type: 'power', on: false } },
  open: { capability: 'windowCovering', command: { type: 'openCovering' } },
  close: { capability: 'windowCovering', command: { type: 'closeCovering' } },
  stop: { capability: 'windowCovering', command: { type: 'stopCovering' } },
  lock: { capability: 'doorLock', command: { type: 'lock', engage: true } },
  unlock: { capability: 'doorLock', command: { type: 'lock', engage: false } },
  play: { capability: 'mediaPlayback', command: { type: 'playPause', play: true } },
  pause: { capability: 'mediaPlayback', command: { type: 'playPause', play: false } },
};

/**
 * Which branch's answer to read, decided by the device rather than by the
 * model.
 *
 * The four action questions each state their own premise and are answered
 * blind; what settles which one *applies* is what the resolved device can
 * actually do. That ordering matters: a lock is asked about locking, and a
 * lamp is never asked to be unlocked, whatever the sentence sounded like.
 */
function branchFor(
  capabilities: readonly CapabilityKind[],
): 'switchAction' | 'coveringAction' | 'lockAction' | 'playbackAction' | null {
  if (capabilities.includes('doorLock')) return 'lockAction';
  if (capabilities.includes('windowCovering')) return 'coveringAction';
  if (capabilities.includes('onOff')) return 'switchAction';
  if (capabilities.includes('mediaPlayback')) return 'playbackAction';
  return null;
}

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
  automation_work: 'an automation',
  app_question: 'a question about the app',
  other: 'something else',
  specific_device: 'one device',
  room: 'a whole room',
  whole_home: 'the whole home',
  turn_on: 'turn on',
  turn_off: 'turn off',
  open: 'open',
  close: 'close',
  stop: 'stop',
  lock: 'lock',
  unlock: 'unlock',
  play: 'play',
  pause: 'pause',
  neither: 'neither',
  here: 'the assistant',
  [NONE_OF_THESE]: 'none of these',
};

/**
 * How likely the runner-up has to be before it is named.
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
  /** `speculative` gives way to a live call — see `Decider.decide`. */
  priority?: 'live' | 'speculative';
}): Promise<HomeDecision> {
  const { home, said } = input;
  // A home past the bound is one this stands down on rather than guesses in:
  // a long option list is a long state, and accuracy falls as the state grows.
  if (home.devices.length === 0 || home.devices.length > MAX_DEVICE_OPTIONS) {
    return {
      kind: 'none',
      costUsd: 0,
      effort: undefined,
      standDown: {
        question: 'home',
        reason: 'size',
        value: home.devices.length,
        max: MAX_DEVICE_OPTIONS,
      },
    };
  }

  const roomName = new Map(home.rooms.map((room) => [room.id, room.name]));
  const deviceName = new Map(home.devices.map((device) => [device.id, device.name]));
  const agentName = new Map(input.delegates.map((agent) => [agent.key, agent.title ?? agent.key]));
  /** An option as a person reads it: a thing's own name, or the battery's words for it. */
  const spoken = (option: string): string =>
    deviceName.get(option) ??
    roomName.get(option) ??
    agentName.get(option) ??
    OPTION_WORDS[option] ??
    option;

  const devices = home.devices.map((device) => ({
    id: device.id,
    name: device.name,
    ...(device.roomId !== null && roomName.has(device.roomId)
      ? { roomName: roomName.get(device.roomId) }
      : {}),
  }));

  /**
   * Every question in one request.
   *
   * The six routing questions and all four branches, asked together because
   * they are answered in parallel and cannot see one another — so asking the
   * branch questions "just in case" is what the parallelism is *for*, not a
   * waste of it.
   */
  const questions = {
    intent: INTENT_QUESTION,
    multiple: MULTIPLE_QUESTION,
    needsValue: NEEDS_VALUE_QUESTION,
    scope: SCOPE_QUESTION,
    room: roomQuestion(home.rooms),
    device: deviceQuestion(devices),
    switchAction: SWITCH_ACTION_QUESTION,
    coveringAction: COVERING_ACTION_QUESTION,
    lockAction: LOCK_ACTION_QUESTION,
    playbackAction: PLAYBACK_ACTION_QUESTION,
    // Asked in the same breath as the rest, because a second request would
    // cost more than every question in this one put together.
    route: routeQuestion(input.delegates),
    selfContained: SELF_CONTAINED_QUESTION,
    effort: EFFORT_QUESTION,
  } as const;

  // Why a `null` came back, when the decider says. On an object rather than in
  // a `let`, because an assignment inside a callback is invisible to the
  // checker's narrowing of a local — it would read as `undefined` for ever.
  const heard: { miss?: DecisionMiss } = {};
  const timeoutMs = input.timeoutMs ?? DECISION_TIMEOUT_MS;
  const result = await input.decider.decide({
    // **Only what a question can use.** A named field rather than a bare
    // string so the questions can refer to `said` by name — and nothing
    // beside it, because the rooms and devices *are* the criteria of their own
    // questions and repeating them here would be state that answers nothing
    // while every question pays for it. Accuracy falls as the state fills with
    // content unrelated to the question, which is the whole reason this is one
    // field long.
    state: { said },
    questions,
    timeoutMs,
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    onMiss: (why) => {
      heard.miss = why;
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
      },
    };
  }
  const costUsd = result.costUsd;
  const answers = result.answers;

  // **One direction only.** A score is a position on a rubric, not a number to
  // do arithmetic with, so it is compared against the level below which the
  // work is plainly small — and nothing here can ask for *more* thinking.
  const scored = answers.effort;
  const effort: EffortHint =
    scored !== undefined &&
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
    costUsd,
    effort,
    standDown: {
      ...why,
      durationMs: result.durationMs,
      ...(result.requestId !== undefined ? { requestId: result.requestId } : {}),
    },
  });
  /** What a choice answered, its number, and what it nearly answered instead. */
  const read = (answer: {
    choice: string;
    confidence: number;
    probabilities: Readonly<Record<string, number>>;
  }) => {
    const nearly = runnerUpOf(answer);
    return {
      answer: answer.choice,
      label: spoken(answer.choice),
      value: answer.confidence,
      ...(nearly !== undefined ? { runnerUp: spoken(nearly) } : {}),
    };
  };

  const intent = answers.intent;
  if (intent === undefined) return standDown({ question: 'intent', reason: 'unanswered' });
  if (intent.confidence < ACT_CONFIDENCE_MIN) {
    return standDown({ question: 'intent', reason: 'unsure', ...read(intent), min: ACT_CONFIDENCE_MIN });
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
  const route = answers.route;
  const selfContained = answers.selfContained;
  if (
    route !== undefined &&
    route.choice !== 'here' &&
    route.confidence >= ACT_CONFIDENCE_MIN &&
    selfContained !== undefined &&
    selfContained.noul >= POSITIVE_NOUL_MIN
  ) {
    return {
      kind: 'route',
      agentKey: route.choice,
      confidence: route.confidence,
      costUsd,
      durationMs: result.durationMs,
      effort,
    };
  }
  if (intent.choice !== 'device_command') {
    // Not a device command. When a handover was on the table and one of its
    // two answers fell short, *that* is why nothing happened — otherwise the
    // sentence was simply never this path's, which is most of them.
    if (route !== undefined && route.choice !== 'here') {
      if (route.confidence < ACT_CONFIDENCE_MIN) {
        return standDown({ question: 'route', reason: 'unsure', ...read(route), min: ACT_CONFIDENCE_MIN });
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
    return standDown({ question: 'intent', reason: 'declined', ...read(intent) });
  }

  // Two sentences in one is a split, which is writing. The assistant already
  // issues several tool calls in one round, so it is cheaper to hand the whole
  // thing over than to take the demo's split-and-re-ask path.
  const multiple = answers.multiple;
  if (multiple === undefined) return standDown({ question: 'multiple', reason: 'unanswered' });
  if (multiple.noul > NEGATIVE_NOUL_MAX) {
    return standDown({ question: 'multiple', reason: 'blocked', value: multiple.noul, max: NEGATIVE_NOUL_MAX });
  }

  // A quantity in the sentence ends it here. The model is documented as
  // unreliable at numbers and is never asked to read one out.
  const needsValue = answers.needsValue;
  if (needsValue === undefined) return standDown({ question: 'needsValue', reason: 'unanswered' });
  if (needsValue.noul > NEGATIVE_NOUL_MAX) {
    return standDown({
      question: 'needsValue',
      reason: 'blocked',
      value: needsValue.noul,
      max: NEGATIVE_NOUL_MAX,
    });
  }

  // One device only, today. A wrong answer then costs one device rather than a
  // room — which is the difference between a surprise and a house. Unsure is
  // asked before *which*, so a split reading is reported as the doubt it was
  // rather than as whichever side happened to be on top.
  const scope = answers.scope;
  if (scope === undefined) return standDown({ question: 'scope', reason: 'unanswered' });
  if (scope.confidence < ACT_CONFIDENCE_MIN) {
    return standDown({ question: 'scope', reason: 'unsure', ...read(scope), min: ACT_CONFIDENCE_MIN });
  }
  if (scope.choice !== 'specific_device') return standDown({ question: 'scope', reason: 'blocked', ...read(scope) });

  const chosen = answers.device;
  if (chosen === undefined) return standDown({ question: 'device', reason: 'unanswered' });
  if (chosen.confidence < ACT_CONFIDENCE_MIN) {
    return standDown({ question: 'device', reason: 'unsure', ...read(chosen), min: ACT_CONFIDENCE_MIN });
  }
  if (chosen.choice === NONE_OF_THESE) return standDown({ question: 'device', reason: 'blocked', ...read(chosen) });
  const device = home.devices.find((entry) => entry.id === chosen.choice);
  if (device === undefined) return standDown({ question: 'device', reason: 'blocked', ...read(chosen) });

  /**
   * The room has to agree, and this is the only thing that reads it.
   *
   * Asked blind beside the device question — the two cannot see each other —
   * so when both are confident and they *disagree*, one of them is wrong and
   * there is no way to tell which. Standing down is the cheap answer: this is
   * the shape a catalog gets wrong in a home with three lights called Ceiling
   * light, where "turn the kitchen light off" resolves to the bedroom by a
   * name that matched better than the room did.
   *
   * A device in no room, an unconfident room answer, or `none_of_these` all
   * abstain rather than object — none of them is disagreement.
   */
  const room = answers.room;
  const roomIsClaimed =
    room !== undefined && room.choice !== NONE_OF_THESE && room.confidence >= ACT_CONFIDENCE_MIN;
  if (roomIsClaimed && device.roomId !== null && device.roomId !== room.choice) {
    return standDown({
      question: 'room',
      reason: 'disagreed',
      ...read(room),
      device: device.name,
      deviceRoom: roomName.get(device.roomId) ?? device.roomId,
    });
  }

  /**
   * Why no endpoint took it, from the first one that could have — the one the
   * sentence was most plausibly about. Kept rather than returned, because a
   * later endpoint may still take the command.
   */
  let fellShort: StandDown | undefined;
  // The endpoint is picked by capability, and the branch with it.
  for (const endpoint of device.endpoints) {
    const branch = branchFor(endpoint.capabilities);
    if (branch === null) continue;
    const action = answers[branch];
    if (action === undefined) {
      fellShort ??= { question: branch, reason: 'unanswered', device: device.name };
      continue;
    }
    if (action.confidence < ACT_CONFIDENCE_MIN) {
      fellShort ??= {
        question: branch,
        reason: 'unsure',
        ...read(action),
        min: ACT_CONFIDENCE_MIN,
        device: device.name,
      };
      continue;
    }
    const resolved = ACTIONS[action.choice];
    if (resolved === undefined || !endpoint.capabilities.includes(resolved.capability)) {
      fellShort ??= { question: branch, reason: 'blocked', ...read(action), device: device.name };
      continue;
    }
    return {
      kind: 'command',
      effort,
      command: {
        deviceId: device.id,
        deviceName: device.name,
        endpointId: endpoint.endpointId,
        command: resolved.command,
        // The weakest link in the chain, which is the honest one to report.
        confidence: Math.min(intent.confidence, chosen.confidence, action.confidence),
        durationMs: result.durationMs,
        costUsd,
      },
    };
  }
  // Nothing on it this path can switch, open, lock or play — a thermostat, a
  // sensor — which is a device the assistant can still work, just not this way.
  return standDown(fellShort ?? { question: 'action', reason: 'blocked', device: device.name });
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
  needsValue: 'whether it named an amount',
  scope: 'how much of the home',
  room: 'which room',
  device: 'which device',
  route: 'who should take it',
  selfContained: 'whether it stood on its own',
  switchAction: 'what to do with it',
  coveringAction: 'what to do with it',
  lockAction: 'what to do with it',
  playbackAction: 'what to do with it',
};

/**
 * What falling short of each question's bar reads as. The four action branches
 * are absent on purpose: those name the device, which only the reading knows.
 */
const UNSURE_WORDS: Readonly<Record<string, string>> = {
  intent: "wasn't sure what was asked",
  route: "wasn't sure who should take it",
  selfContained: 'needed the rest of the conversation',
  scope: "wasn't sure it was one device",
  device: "wasn't sure which device",
  room: "wasn't sure which room",
};

/** What a yes/no's number is the probability *of*, so it never stands alone. */
const NOUL_WORDS: Readonly<Record<string, string>> = {
  multiple: 'more than one request',
  needsValue: 'an amount',
  selfContained: 'stands on its own',
};

export function describeStandDown(standDown: StandDown): StandDownWords {
  const two = (value: number): string => value.toFixed(2);
  const told = (
    phrase: string,
    audience: StandDownWords['audience'],
    parts: readonly (string | undefined)[] = [],
  ): StandDownWords => {
    const detail = parts.filter((part): part is string => part !== undefined && part !== '').join(' · ');
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
    standDown.durationMs !== undefined ? `${Math.round(standDown.durationMs)} ms` : undefined;
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
          return told("didn't answer", 'shown');
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
        case 'needsValue':
          return told('heard an amount', 'shown', [measured({ named: false }), took]);
        case 'scope':
          return told(`heard ${standDown.label ?? 'more than one device'}`, 'shown', [
            measured({ named: false }),
            took,
          ]);
        case 'device':
          return told("couldn't match a device", 'shown', [measured({ named: true }), took]);
        case 'action':
          return told(`can't work ${device ?? 'that device'} by itself`, 'shown', [took]);
        default:
          return told(`couldn't tell what to do with ${device ?? 'it'}`, 'shown', [
            measured({ named: true }),
            took,
          ]);
      }
    case 'disagreed':
      return told('matched a device outside the room it heard', 'shown', [
        measured({ named: true }),
        device !== undefined && standDown.deviceRoom !== undefined
          ? `${device} is in ${standDown.deviceRoom}`
          : undefined,
        took,
      ]);
  }
}
