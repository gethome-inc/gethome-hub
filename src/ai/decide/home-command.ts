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
import type { Decider } from './decider.js';
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
  | { kind: 'none'; costUsd: number; effort: EffortHint };

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
 * Read one sentence against this home.
 *
 * Answers `none` for everything the hub should handle the way it always did,
 * which is most sentences — that is the design rather than a disappointment.
 */
export async function decideHomeCommand(input: {
  decider: Decider;
  home: DecidableHome;
  /**
   * The agents a job could be handed to, from the registry.
   *
   * Passed in rather than imported so this module stays a pure reading of a
   * sentence — and so the routing question is built from the one table that
   * knows what agents exist.
   */
  delegates: readonly { key: string; decisionCriterion: string }[];
  said: string;
  timeoutMs?: number;
  /** `speculative` gives way to a live call — see `Decider.decide`. */
  priority?: 'live' | 'speculative';
}): Promise<HomeDecision> {
  const { home, said } = input;
  // A home past the bound is one this stands down on rather than guesses in:
  // a long option list is a long state, and accuracy falls as the state grows.
  if (home.devices.length === 0 || home.devices.length > MAX_DEVICE_OPTIONS) {
    return { kind: 'none', costUsd: 0, effort: undefined };
  }

  const roomName = new Map(home.rooms.map((room) => [room.id, room.name]));
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
    timeoutMs: input.timeoutMs ?? DECISION_TIMEOUT_MS,
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
  });
  if (result === null) return { kind: 'none', costUsd: 0, effort: undefined };
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

  const intent = answers.intent;
  if (intent === undefined || intent.confidence < ACT_CONFIDENCE_MIN) {
    return { kind: 'none', costUsd, effort };
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
  if (intent.choice !== 'device_command') return { kind: 'none', costUsd, effort };

  // Two sentences in one is a split, which is writing. The assistant already
  // issues several tool calls in one round, so it is cheaper to hand the whole
  // thing over than to take the demo's split-and-re-ask path.
  const multiple = answers.multiple;
  if (multiple === undefined || multiple.noul > NEGATIVE_NOUL_MAX) return { kind: 'none', costUsd, effort };

  // A quantity in the sentence ends it here. The model is documented as
  // unreliable at numbers and is never asked to read one out.
  const needsValue = answers.needsValue;
  if (needsValue === undefined || needsValue.noul > NEGATIVE_NOUL_MAX) {
    return { kind: 'none', costUsd, effort };
  }

  // One device only, today. A wrong answer then costs one device rather than a
  // room — which is the difference between a surprise and a house.
  const scope = answers.scope;
  if (scope === undefined || scope.choice !== 'specific_device') return { kind: 'none', costUsd, effort };
  if (scope.confidence < ACT_CONFIDENCE_MIN) return { kind: 'none', costUsd, effort };

  const chosen = answers.device;
  if (chosen === undefined || chosen.choice === NONE_OF_THESE) return { kind: 'none', costUsd, effort };
  if (chosen.confidence < ACT_CONFIDENCE_MIN) return { kind: 'none', costUsd, effort };
  const device = home.devices.find((entry) => entry.id === chosen.choice);
  if (device === undefined) return { kind: 'none', costUsd, effort };

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
    return { kind: 'none', costUsd, effort };
  }

  // The endpoint is picked by capability, and the branch with it.
  for (const endpoint of device.endpoints) {
    const branch = branchFor(endpoint.capabilities);
    if (branch === null) continue;
    const action = answers[branch];
    if (action === undefined || action.confidence < ACT_CONFIDENCE_MIN) continue;
    const resolved = ACTIONS[action.choice];
    if (resolved === undefined) continue;
    if (!endpoint.capabilities.includes(resolved.capability)) continue;
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
  return { kind: 'none', costUsd, effort };
}
