/**
 * Every question the hub asks a decision model, and every threshold it reads
 * the answers against.
 *
 * **One file, because the wording is the contract.** A question's text and its
 * criteria *are* its behaviour — editing them at a call site changes what the
 * hub decides with nothing in the diff to say so, and two call sites asking
 * the same thing in slightly different words are two behaviours nobody meant
 * to have. `voice/prompts.ts` holds the same line for the same reason, and the
 * way it regresses is somebody inlining "just this one".
 *
 * Four rules govern everything below, and each is a documented property of
 * this class of model rather than a preference:
 *
 * 1. **Questions in one request cannot see one another's answers.** They are
 *    evaluated in parallel, so no question may refer to another's result — a
 *    speculative branch has to *state its own premise* instead. That is what
 *    makes asking every branch at once affordable: latency is roughly flat in
 *    the number of questions and concurrent requests queue, so one request
 *    with a dozen questions beats two with six.
 * 2. **No counting, no comparing numbers, no ordering dates, no double
 *    negatives.** The vendor publishes these as weaknesses. `needsValue` below
 *    exists precisely so a request carrying a number leaves this layer
 *    entirely rather than having one guessed at.
 * 3. **Thresholds live beside the wording, and beside the model.** Calibration
 *    does not transfer between models, so a threshold is only meaningful next
 *    to the `DECISION_MODEL` it was set against. Each one says whether it was
 *    *measured* or *assumed* — today every one is assumed, and says so.
 * 4. **The state is small on purpose.** Accuracy falls as the state fills with
 *    content unrelated to the question, so what goes in is the sentence and
 *    the catalog it has to be resolved against, and nothing else.
 *
 * Nothing here decides whether something is *allowed*. An answer picks a road;
 * every road ends at the guards it always did. `docs/jev.md` is canonical.
 */
import {
  DECISION_MODEL,
  type ChoiceQuestion,
  type NoulQuestion,
  type ScoreQuestion,
} from './decider.js';

/**
 * The model these thresholds were set against.
 *
 * Re-exported rather than re-declared so a model bump cannot leave the numbers
 * pointing at a model nobody calibrated them for — `test/ai-decide-questions.
 * test.ts` asserts the two are the same string.
 */
export const CALIBRATED_AGAINST = DECISION_MODEL;

/**
 * How long a decision may take before the hub stops waiting for it.
 *
 * Typical is 100–400 ms. This is a **deadline, not a retry budget**: the
 * ordinary path costs a model round anyway, so a decision that has not landed
 * by now has already spent more than it can save.
 */
export const DECISION_TIMEOUT_MS = 700;

/** The same, for a speculation nobody is waiting on. */
export const SPECULATION_TIMEOUT_MS = 500;

/**
 * How often a partial sentence may be re-read, and how many times in one
 * utterance.
 *
 * The per-utterance cap is the one that matters. The voice prompt's own
 * "don't treat a television as a request" hazard, one layer down: a room with
 * a film on produces transcript deltas indefinitely, and a bound on the rate
 * alone would turn a negligible cost into a bill.
 */
export const SPECULATE_EVERY_MS = 700;
export const SPECULATIONS_PER_UTTERANCE = 4;

/** The shortest partial worth reading. Below this there is nothing to decide. */
export const SPECULATION_MIN_CHARS = 12;

/**
 * Confidence a `choice` must reach before the hub acts on it.
 *
 * **Assumed, not measured.** 0.85 is where one published integration landed
 * after sweeping its own labelled data; this hub has swept none. It is set
 * high deliberately: every consumer is a *skip-ahead* over a path that already
 * works, so a threshold that is too high costs a little latency and one that
 * is too low costs somebody's lamp.
 *
 * `confidence` measures how concentrated the distribution is — **not** the
 * probability that the answer is right. Two genuinely good options spread it.
 */
export const ACT_CONFIDENCE_MIN = 0.85;

/**
 * How far a "no" has to be from the middle before it counts as a no.
 *
 * **Higher than it looks like it should be, and that is the model.** A noul is
 * a probability, and this one has a documented floor: on records that are
 * plainly clean it still answers 0.2–0.5 where a generative model would say
 * 0.0. A gate at 0.15 would therefore refuse almost everything, which is a
 * feature that silently never fires. 0.4 is the assumed middle and is the
 * first number to re-sweep against a real home.
 */
export const NEGATIVE_NOUL_MAX = 0.4;

/** How sure a yes/no has to be before it is treated as a yes. Assumed. */
export const POSITIVE_NOUL_MIN = 0.85;

/* ------------------------------------------------------------------ *
 * The device-command battery.
 * ------------------------------------------------------------------ */

/**
 * What the person is asking for at all.
 *
 * Every option is a positive description of a case, and `other` is the
 * no-match outcome: without one the model has to force an unrelated sentence
 * into the nearest box, which is how "who won the World Series" becomes a
 * device command.
 */
export const INTENT_QUESTION: ChoiceQuestion = {
  type: 'choice',
  instructions:
    'The person is talking to the assistant in their smart home. What are they asking for?',
  criteria: {
    device_command: 'They want something in the home switched, opened, closed, locked or run now.',
    home_question: 'They are asking what the home or a device is doing, or for a reading from it.',
    automation_work:
      'They want a rule the home runs by itself — a schedule, something that happens when a sensor sees somebody, or a scene they can press.',
    app_question: 'They are asking about the gethome app or hub itself, or how to do something in it.',
    other: 'Anything else, including chat and questions about the world.',
  },
};

/**
 * Whether one sentence carries more than one instruction.
 *
 * A high answer takes the whole request out of this layer: splitting a
 * sentence into parts is writing, which a decision model cannot do, and the
 * assistant already issues several tool calls in one round — cheaper than the
 * split-and-re-ask the vendor's own demo performs.
 */
export const MULTIPLE_QUESTION: NoulQuestion = {
  type: 'noul',
  instructions:
    'The person asked for more than one separate thing to be done, rather than one thing.',
};

/**
 * Whether answering needs a number read out of the sentence.
 *
 * **The sharpest guard in this file.** This model is not a calculator: it is
 * documented as unreliable at counting and at comparing numbers, and it reads
 * dates as text. So it is never asked to extract one — "dim it to fifty
 * percent" and "set it to twenty-one degrees" leave this layer here and are
 * answered the way they always were.
 */
export const NEEDS_VALUE_QUESTION: NoulQuestion = {
  type: 'noul',
  instructions:
    'The request names a particular amount: a brightness, a percentage, a temperature, a colour, a duration or a time.',
};

/**
 * How much of the home the request is about.
 *
 * The hub acts on `specific_device` alone today. The other two are asked
 * because the answer is free and it is what tells the fast path to stand down
 * — not because anything acts on them yet.
 */
export const SCOPE_QUESTION: ChoiceQuestion = {
  type: 'choice',
  instructions: 'How much of the home is the request about?',
  criteria: {
    specific_device: 'One particular device.',
    room: 'Everything of one sort in one room, or the whole room.',
    whole_home: 'The whole home at once.',
  },
};

/**
 * What should happen, asked once per family of device.
 *
 * **Each states its own premise**, because these run in parallel and none can
 * see which family the request turned out to be about. That is the speculative
 * fan-out: all four are answered every time, the code reads the one the
 * resolved device's capabilities select, and the rest cost nothing.
 *
 * Every option is **number-free**. The vocabulary is exactly what can be
 * carried out without reading a quantity out of the sentence.
 */
export const SWITCH_ACTION_QUESTION: ChoiceQuestion = {
  type: 'choice',
  instructions:
    'Suppose this request is about something that switches on and off — a light, a socket, a fan, an appliance or a speaker. What should happen to it?',
  criteria: {
    turn_on: 'Switch it on, or start it.',
    turn_off: 'Switch it off, or stop it.',
    neither: 'Neither: the request is not about switching this on or off.',
  },
};

export const COVERING_ACTION_QUESTION: ChoiceQuestion = {
  type: 'choice',
  instructions:
    'Suppose this request is about a blind, a curtain or a garage door. What should happen to it?',
  criteria: {
    open: 'Open it fully.',
    close: 'Close it fully.',
    stop: 'Stop it where it is.',
    neither: 'Neither: the request is not about opening or closing anything.',
  },
};

export const LOCK_ACTION_QUESTION: ChoiceQuestion = {
  type: 'choice',
  instructions: 'Suppose this request is about a lock. What should happen to it?',
  criteria: {
    lock: 'Lock it.',
    unlock: 'Unlock it.',
    neither: 'Neither: the request is not about locking or unlocking anything.',
  },
};

export const PLAYBACK_ACTION_QUESTION: ChoiceQuestion = {
  type: 'choice',
  instructions:
    'Suppose this request is about something playing music or video. What should happen to it?',
  criteria: {
    play: 'Start or resume playing.',
    pause: 'Pause or stop playing.',
    neither: 'Neither: the request is not about starting or stopping playback.',
  },
};

/** The option every catalog question carries when nothing in it fits. */
export const NONE_OF_THESE = 'none_of_these';

/**
 * Which room, and which device — over the home's own names.
 *
 * Built rather than written down, because the answer space *is* this home. The
 * ids are the option names so the answer needs no second lookup, and the
 * criteria are what a person would call the thing.
 */
export function roomQuestion(
  rooms: readonly { id: string; name: string; zoneName?: string | undefined }[],
): ChoiceQuestion {
  const criteria: Record<string, string> = {};
  for (const room of rooms) {
    criteria[room.id] =
      room.zoneName === undefined ? `The ${room.name}.` : `The ${room.name}, in the ${room.zoneName}.`;
  }
  criteria[NONE_OF_THESE] = 'No particular room, or a room that is not listed.';
  return {
    type: 'choice',
    instructions: 'Which room in this home is the person talking about?',
    criteria,
  };
}

export function deviceQuestion(
  devices: readonly { id: string; name: string; roomName?: string | undefined }[],
): ChoiceQuestion {
  const criteria: Record<string, string> = {};
  for (const device of devices) {
    criteria[device.id] =
      device.roomName === undefined
        ? `"${device.name}".`
        : `"${device.name}", in the ${device.roomName}.`;
  }
  criteria[NONE_OF_THESE] = 'No particular device, or a device that is not listed.';
  return {
    type: 'choice',
    instructions:
      'Which one device in this home should the request be carried out on? Go by the name the person used and the room they mentioned.',
    criteria,
  };
}

/**
 * How many devices may be offered as options.
 *
 * The API's own ceiling is 255. This is lower because a long list is also a
 * long state, and accuracy falls as the state grows — a home past this is one
 * the fast path stands down on rather than guesses in.
 */
export const MAX_DEVICE_OPTIONS = 180;

/* ------------------------------------------------------------------ *
 * Handing a job to another agent.
 * ------------------------------------------------------------------ */

/**
 * Which agent should take this, built from the delegate registry.
 *
 * **From the registry rather than written here**, so adding an agent stays one
 * entry — the rule `delegate`'s generated tool description already follows.
 * It reads `decisionCriterion` and deliberately **not** `description`: that
 * one is written for a model reading tool documentation and says "Not for
 * switching something on now, and not for questions about a rule" — two
 * negatives in one clause, which is a documented weakness of this model.
 */
export function routeQuestion(
  delegates: readonly { key: string; decisionCriterion: string }[],
): ChoiceQuestion {
  const criteria: Record<string, string> = { here: 'The assistant itself should answer this.' };
  for (const delegate of delegates) criteria[delegate.key] = delegate.decisionCriterion;
  return {
    type: 'choice',
    instructions:
      'The assistant can answer a request itself or hand it to a specialist. Which should happen with this one?',
    criteria,
  };
}

/**
 * How much thinking the answer is worth.
 *
 * **Down only, and the bar is deliberately high.** On a typed surface a few
 * seconds more deliberation is free — the answer is read when it lands — so
 * the value here is cost rather than speed, and the risk is a worse answer to
 * a question that only looked simple. That asymmetry is why nothing here can
 * raise the effort, why a spoken round never asks (it is already pinned low
 * for reasons that have nothing to do with the sentence), and why this is the
 * first thing to delete if it misbehaves rather than the first to tune.
 *
 * The levels are described situations rather than adjectives, because a rubric
 * has to stand on its own: the model is not shown the field name.
 */
export const EFFORT_QUESTION: ScoreQuestion = {
  type: 'score',
  instructions: 'How much work does answering this properly take?',
  criteria: [
    'A single plain fact about one device, or one thing switched on or off.',
    'A few devices or rooms at once, or a question needing one or two things looked up.',
    'Something that has to be worked out — comparing, planning, or a rule with conditions in it.',
  ],
};

/**
 * How far below the easiest level a score has to sit before the round is run
 * cheaply, and how sure the model has to be about it. Both assumed.
 */
export const EFFORT_SIMPLE_MAX = 0.4;
export const EFFORT_CONFIDENCE_MIN = 0.8;

/**
 * Whether the sentence stands on its own as a brief.
 *
 * The one thing a fast route gives up against a model-written handover is that
 * the brief is the person's own words rather than a restatement with the
 * context folded in. This is the question that notices when those words are
 * not enough on their own — "make it half past instead" means nothing to an
 * agent that has not read the conversation.
 */
export const SELF_CONTAINED_QUESTION: NoulQuestion = {
  type: 'noul',
  instructions:
    'This sentence says enough on its own for somebody who has not read the rest of the conversation to carry it out.',
};
