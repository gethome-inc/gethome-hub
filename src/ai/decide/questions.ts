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
 * Five rules govern everything below, and each is a documented property of
 * this class of model rather than a preference:
 *
 * 1. **Questions in one request cannot see one another's answers.** They are
 *    evaluated in parallel, so no question may refer to another's result — a
 *    speculative branch has to *state its own premise* instead. That is what
 *    makes asking every branch at once affordable: latency is roughly flat in
 *    the number of questions, so one request with twenty questions beats two
 *    with ten. The vendor calls it speculative fan-out, and its own smart-home
 *    demo is built on it.
 * 2. **No arithmetic, no counting, no ordering dates, no double negatives.**
 *    The vendor publishes these as weaknesses. A number somebody said is found
 *    in *code* (`amountIn`), and the model is asked only what it is a number
 *    *of* — a semantic judgement, which is the half it is good at. Every
 *    calculation after that is code.
 * 3. **Thresholds live beside the wording, and beside the model.** Calibration
 *    does not transfer between models, so a threshold is only meaningful next
 *    to the `DECISION_MODEL` it was set against. Each one says whether it was
 *    *measured* or *assumed* — today every one is assumed, and says so.
 * 4. **The state is what was said; what a question needs to compare lives in
 *    the question.** Accuracy falls as the state fills with content unrelated
 *    to a question, and every question reads the whole state — so the state is
 *    the sentence (or the parts it was split into) and the one number in it,
 *    nothing else. What a question has to *know* to answer rides with that
 *    question: the device list is the criteria of `device`, each device's own
 *    description is in its own `target_` question along with the names it
 *    could be confused with, and the names that are several words long are in
 *    `shape`, so "turn on the Light TV" is not read as a light and a TV.
 *    Questions name a field with backticks, the way the docs reference a
 *    nested path.
 * 5. **Every closed question has a way out.** The model cannot abstain — it
 *    always answers — so each carries a no-match option, and each speculative
 *    action question carries `unchanged` with an example of the sentence that
 *    should choose it, because it reads literally.
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
 * **It was 700 ms, and that was the fault a real hub's log showed.** Typical
 * is 100–400 ms for the model, but a decision also has to *reach* it, and from
 * a Pi on the far side of the world a fresh connection is DNS, TCP and TLS
 * before the request is even sent — most of 700 ms on its own. The connection
 * is now kept open (`connection.ts`), which puts the ordinary case back near
 * the model's own time; this is the deadline for the case where it is not.
 *
 * Still a **deadline, not a retry budget**, and still well inside what it
 * saves: the ordinary path for a command is a whole model round to call the
 * tool before the round that says it happened, which is seconds rather than
 * milliseconds. A decision that has not landed by now has spent more than it
 * can save.
 */
export const DECISION_TIMEOUT_MS = 1_500;

/**
 * The same, for a speculation nobody is waiting on. As long as the live one:
 * it is what opens the connection a spoken turn then reuses, and giving up on
 * it early wastes the handshake it has already paid for.
 */
export const SPECULATION_TIMEOUT_MS = 1_500;

/**
 * How long a finished sentence waits for a speculation still in flight on the
 * same conversation before deciding on its own.
 *
 * Waiting briefly is usually faster than not: the speculation holds the one
 * open connection, and when it lands the live reading goes out on that same
 * socket — or is not needed at all, when the speculation read exactly this
 * sentence. The bound is what keeps a slow speculation from becoming the wait.
 */
export const SPECULATION_WAIT_MS = 400;

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
 * How long a reading of a partial sentence stays worth reusing.
 *
 * A speculation is only reused when the finished sentence is *the same
 * sentence* — see `sameSentence` — which is the strong half of the check. This
 * is the weak half, for a sentence left hanging for a minute while somebody is
 * interrupted, whose home has moved on underneath it.
 */
export const SPECULATION_REUSE_MS = 30_000;

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

/**
 * How sure a device's own `target_` question has to be before the device is
 * one the request acts on, and how far below the middle it must sit to be one
 * it does not.
 *
 * **One yes/no per device, not a chain of gates.** The vendor's function-calling
 * cookbook answers a list-valued argument — "compare nvda, amd and msft" — with
 * one noul per candidate, and a request's devices are exactly that: "the
 * kitchen light and the hall light", "all the lights", or the one lamp named
 * "Light TV". Between the two numbers a device is *in doubt*, and a reading with
 * a device in doubt acts only when the relative `device` choice settles it.
 * Both assumed; the vendor's own worked example uses 0.8 and 0.2.
 */
export const TARGET_YES = 0.75;
export const TARGET_NO = 0.35;

/**
 * How sure the `device` choice has to be when that device's own `target_`
 * question agrees with it.
 *
 * **Lower than `ACT_CONFIDENCE_MIN` because it is never alone.** Acting this
 * way needs the relative choice to lean to one device *and* its own yes/no to
 * be the only clear yes in the home — two readings of different kinds, both
 * wrong in the same direction, before the wrong lamp moves. It is what lets
 * "turn on the light tv" act when the choice is 0.8 sure of *Light TV* and the
 * *TV* beside it is only in doubt. Assumed.
 */
export const DEVICE_LEAN_MIN = 0.6;

/**
 * How sure "several different things are asked" has to be before the
 * sentence is split by a generative model.
 *
 * **Lower than `ACT_CONFIDENCE_MIN`, because being wrong is cheap both ways.**
 * A split that was not needed comes back as one part, and the reading of the
 * whole sentence is used after all; one that was needed and not made sends
 * the sentence to the ordinary round, which is the hub before any of this.
 * Assumed.
 */
export const SPLIT_MIN = 0.6;

/**
 * The most parts a sentence is split into and still read here.
 *
 * Four covers "turn off the TV, close the blinds, lock the door and tell me
 * the time". A sentence that is five requests is a speech rather than a
 * command, and the ordinary round is the better reader of one.
 */
export const MAX_PARTS = 4;

/**
 * How many devices may be offered as options.
 *
 * The API's own ceiling is 255. This is lower because a long list is also a
 * long request, and accuracy falls as the state grows — a home past this is
 * one the fast path stands down on rather than guesses in.
 */
export const MAX_DEVICE_OPTIONS = 180;

/**
 * How many devices get a `target_` question of their own.
 *
 * One per device is what lets a request name several of them — and it is one
 * more question each, about sixty tokens, in a request whose latency is flat
 * in its question count. Past this a home is read with the `device` choice
 * alone, which names one device and never a set. Assumed.
 */
export const MAX_TARGET_QUESTIONS = 120;

/**
 * The most devices the parts of a split sentence are asked about.
 *
 * The first reading has already said which devices the sentence mentions at
 * all — anything its `target_` question did not answer with a clear no — so
 * the parts are asked about those, not the whole house: the vendor's skill
 * cookbook's shape, a cheap read of everything and then a close look at a
 * few.
 */
export const PART_CANDIDATES_MAX = 24;

/**
 * The most device names `shape` is shown.
 *
 * Only names of more than one word are there at all — they are the ones that
 * can be misread as two things — so this bounds a very large home rather than
 * an ordinary one.
 */
export const SHAPE_NAMES_MAX = 60;

/* ------------------------------------------------------------------ *
 * What was said, and what it is.
 * ------------------------------------------------------------------ */

/**
 * What the questions about one request point at.
 *
 * `said` for the sentence itself, and `parts[0]`… for the requests a compound
 * sentence was split into — so the same wording asks the same thing of either,
 * with only the backticked path changing. The vendor's advice for several
 * questions with similar instructions is exactly this: point each at its own
 * field rather than paraphrase.
 */
export type Subject = 'said' | `parts[${number}]`;

/** The field a subject's number lives in, when it has one — see `amountIn`. */
export function amountField(subject: Subject): string {
  return subject === 'said' ? 'amount' : subject.replace('parts', 'amounts');
}

/**
 * What the person is asking for at all.
 *
 * Every option is a positive description of a case, and `other` is the
 * no-match outcome: without one the model has to force an unrelated sentence
 * into the nearest box, which is how "who won the World Series" becomes a
 * device command.
 */
export function intentQuestion(subject: Subject = 'said'): ChoiceQuestion {
  return {
    type: 'choice',
    instructions:
      `Somebody is talking to the assistant in their own smart home, and \`${subject}\` is ` +
      'what they asked. What are they asking for?',
    criteria: {
      device_command:
        'Something in the home changed now: switched on or off, dimmed or brightened, given a ' +
        'colour, opened or closed, locked or unlocked, played or paused, or set to a ' +
        'temperature or a speed.',
      home_question:
        'What the home or a device is doing, or a reading from it — a question, not a change.',
      scene: 'One of the home’s scenes or modes run or switched, by its name — like "movie night".',
      automation_work:
        'A rule the home runs by itself made or changed — a schedule, or something that happens ' +
        'when a sensor sees somebody.',
      app_question: 'The gethome app or hub itself, or how to do something in it.',
      other: 'Anything else, including chat and questions about the world.',
    },
  };
}

/** How many things a sentence asks to be done — see `shapeQuestion`. */
export const SHAPE_ONE = 'one';
export const SHAPE_ONE_AND_MORE = 'one_and_more';
export const SHAPE_SEVERAL = 'several';
export const SHAPE_NOTHING = 'nothing';

/**
 * How many different things the sentence asks to be done to the home.
 *
 * **This is the question that decides whether a sentence is split**, and the
 * vendor's smart-home demo asks it as "more than one distinct action". It is a
 * choice rather than a yes/no because the four answers lead four ways: one
 * thing is read and done; one thing beside a question is done and the rest is
 * the model's; several different things are split by a generative model and
 * read part by part; nothing done is the model's.
 *
 * **One action on several devices is one thing.** "Turn off the kitchen light
 * and the hall light" is one action with a set of devices, which the
 * `target_` questions carry, so it is never split.
 *
 * **And it is told the device names that are several words long**, because it
 * was not, and "turn on the light tv" — the device called *Light TV* — was
 * read as a light and a TV, split into two requests, and neither of them
 * matched anything. A name is one device however many words it has.
 */
export function shapeQuestion(
  multiWordNames: readonly string[],
  subject: Subject = 'said',
): ChoiceQuestion {
  const names =
    multiWordNames.length > 0
      ? ` A device's name is one thing however many words it has — this home has devices called ${multiWordNames
          .map((name) => `"${name}"`)
          .join(', ')}.`
      : '';
  return {
    type: 'choice',
    instructions: `How many different things does \`${subject}\` ask to be done to the home?${names}`,
    criteria: {
      [SHAPE_ONE]:
        'One thing, even to many devices — "turn off all the lights", "turn off the kitchen light ' +
        'and the hall light", "set the bedroom lamp to 40%".',
      [SHAPE_ONE_AND_MORE]:
        'One thing done, and beside it a question or a remark that asks for nothing to be done — ' +
        '"switch the fan off and tell me the time".',
      [SHAPE_SEVERAL]:
        'Two or more different things done — "turn off the TV and close the blinds", "turn on the ' +
        'lamp and turn off the fan".',
      [SHAPE_NOTHING]:
        'Nothing done to the home now — a question, chat, or a rule for the home to follow later.',
    },
  };
}

/**
 * Whether the request is for later, for a while, or on a condition.
 *
 * **The guard that keeps "in ten minutes" from meaning now.** Nothing here
 * can wait or schedule, and a command read without its "at seven" would be
 * carried out immediately — so any timing at all ends the attempt and the
 * sentence goes to the model, which can say what is and is not possible.
 */
export function laterQuestion(subject: Subject = 'said'): NoulQuestion {
  return {
    type: 'noul',
    instructions: `\`${subject}\` asks for something to happen later, for a while, or only on a condition.`,
    criteria: {
      true:
        'A delay, a time, a length of time or a condition is attached — "in ten minutes", ' +
        '"at 7", "for an hour", "when I leave".',
      false: 'It is for right now — "turn off the light", "open the blinds".',
    },
  };
}

/**
 * Whether the sentence takes something back.
 *
 * "Turn the bedroom light on — no, off" is an ordinary thing to say, and a
 * reader that caught the first half would make the lamp flash. So any
 * negation or change of mind ends the attempt; the model reads the sentence
 * whole, which is what it is good at.
 */
export function negatedQuestion(subject: Subject = 'said'): NoulQuestion {
  return {
    type: 'noul',
    instructions: `\`${subject}\` tells the assistant not to do something, or changes its mind part-way through.`,
    criteria: {
      true: 'Like "don’t turn off the light", "never mind", or "turn it on — no, off".',
      false: 'A plain request, like "turn off the light".',
    },
  };
}

/** The option `device` carries when nothing in it fits. */
export const NONE_OF_THESE = 'none_of_these';

/**
 * One device, as the questions describe it, under the key the model answers
 * `device` with.
 *
 * **Keys are short and plain — `d1`, `d2` — and the name is in the
 * description.** A key is what comes back, so it has to survive the wire
 * whatever somebody called the device: a name in Cyrillic, with quotes or emoji
 * in it, or shared with another device. The description carries the meaning,
 * which is what the model reads to choose.
 */
export interface DeviceOption {
  key: string;
  name: string;
  /** "A light", "A plug or socket" — see `KIND_WORDS` in `home-command.ts`. */
  kindWords: string;
  roomName?: string | undefined;
  /** The zone the room is in, so "the lights downstairs" has something to match. */
  zoneName?: string | undefined;
}

/** "a light in the Kitchen, Downstairs" — the one description every question uses. */
export function describeDevice(device: DeviceOption): string {
  // Only the first letter: "A TV" is "a TV", never "a tv".
  const kind = device.kindWords.charAt(0).toLowerCase() + device.kindWords.slice(1);
  if (device.roomName === undefined) return `${kind}, in no particular room`;
  return device.zoneName === undefined
    ? `${kind} in the ${device.roomName}`
    : `${kind} in the ${device.roomName}, ${device.zoneName}`;
}

/**
 * Which **one** device, over the home's own names — the relative half of
 * finding a request's devices.
 *
 * A choice compares its options, which one yes/no per device cannot: asked
 * separately, "turn on the light tv" is plausibly about a device called *TV*
 * as well as the one called *Light TV*. So this settles *which* when one device
 * is meant, and the `target_` questions settle *which ones* when several are —
 * the jaggedness page's own pairing of the two.
 */
export function deviceQuestion(
  devices: readonly DeviceOption[],
  subject: Subject = 'said',
): ChoiceQuestion {
  const criteria: Record<string, string> = {};
  for (const device of devices) criteria[device.key] = `"${device.name}" — ${describeDevice(device)}.`;
  criteria[NONE_OF_THESE] = 'None of these, several of them, or a device that is not listed.';
  return {
    type: 'choice',
    instructions:
      `Which one device in this home is \`${subject}\` about? Go by the name they used, the ` +
      'kind of device, and the room they mentioned.',
    criteria,
  };
}

/**
 * Whether the request is for something to be done to **this** device — one
 * yes/no per device, which is how a request names a set of them.
 *
 * Yes for the device named, and for every device like it when the request is
 * for all of a kind in a room, a zone or the house. The other devices it could
 * be confused with — those sharing a word of its name — are named in the
 * question, because a yes/no cannot compare itself with the question beside it
 * and "the light tv" has to be heard as *Light TV* and not as *TV*.
 */
export function targetQuestion(
  device: DeviceOption,
  confusable: readonly DeviceOption[],
  subject: Subject = 'said',
): NoulQuestion {
  // Semicolons between them, because a description has a comma of its own.
  const others = confusable.map((other) => `"${other.name}" (${describeDevice(other)})`);
  const apart =
    others.length === 0
      ? ''
      : others.length === 1
        ? ` It is a different device from ${others[0]!}.`
        : ` It is a different device from each of these: ${others.join('; ')}.`;
  return {
    type: 'noul',
    instructions:
      `\`${subject}\` asks for something to be done to "${device.name}" — ${describeDevice(device)}.` +
      apart,
    criteria: {
      true:
        'It names this device, or asks for every device like it in its room, its zone or the whole ' +
        'home — "turn off all the lights", "everything in the living room".',
      false:
        'It is about other devices, names a different device with a similar name, or asks for ' +
        'nothing to be done.',
    },
  };
}

/**
 * Whether the request is for one single device.
 *
 * **Read only when several devices' own `target_` questions said yes**, as a
 * veto on acting on all of them. "Switch the light on" in a home with three
 * lights is plausibly about each of them taken one at a time — three yeses to
 * one question — and this is what hears that the sentence asked for one, so
 * the model can ask which. It is never a gate on acting on one device: the
 * chain it replaced stood down on "one device or a group" for a home with a
 * single light in it.
 */
export function singleQuestion(subject: Subject = 'said'): NoulQuestion {
  return {
    type: 'noul',
    instructions: `\`${subject}\` asks for something to be done to one single device.`,
    criteria: {
      true: 'One device — "turn off the lamp", "switch the light on", "close the bedroom blind".',
      false:
        'Several devices, or every device of a kind — "turn off the lights", "the lamp and the fan", ' +
        '"everything in the kitchen".',
    },
  };
}

/**
 * Whether the request is for *everything* — all devices at once, whatever
 * their kind.
 *
 * **The one word read narrowly on purpose.** "Turn everything off in the
 * kitchen" means the lights, the TV and the fan — not the fridge on a smart
 * plug, the heating, or the lock on the back door — and a `target_` question
 * answering yes for the fridge plug is answering the sentence correctly. So
 * this is asked beside them, and when it is a yes the set is narrowed in code
 * to what somebody switches off leaving a room (`EVERYTHING_KINDS`).
 */
export function everythingQuestion(subject: Subject = 'said'): NoulQuestion {
  return {
    type: 'noul',
    instructions: `\`${subject}\` asks for everything to be changed at once, whatever kind of device it is.`,
    criteria: {
      true: 'Like "turn everything off", "all off", "everything in the kitchen".',
      false: 'It names devices, or a kind of device — "the lights", "the TV and the lamp".',
    },
  };
}

/* ------------------------------------------------------------------ *
 * What should happen — one speculative question per family.
 * ------------------------------------------------------------------ */

/**
 * The option each action question uses for "this request does not ask this".
 * One word for all of them, so the planner has one thing to recognise.
 */
export const UNCHANGED = 'unchanged';

/**
 * The families, each asked every time and read only for a device that has the
 * capability — see `FAMILY_CAPABILITIES` in `home-command.ts`.
 *
 * **Each states its own premise**, because these run in parallel and none can
 * see which kind of device the request turned out to be about. That is the
 * speculative fan-out: all of them are answered, the code reads the ones the
 * resolved device's capabilities select, and the rest cost nothing. A family
 * answered for a device that cannot do it is never read — "turn off the TV"
 * read under the heating's premise says "off", and that must not reach a
 * thermostat.
 *
 * Every `unchanged` carries an example of the sentence that should choose it,
 * because the model reads literally and the premise invites an answer.
 */
export type Family =
  | 'power'
  | 'brightness'
  | 'colour'
  | 'cover'
  | 'lock'
  | 'playback'
  | 'climate'
  | 'fan';

export const FAMILIES: readonly Family[] = [
  'power',
  'brightness',
  'colour',
  'cover',
  'lock',
  'playback',
  'climate',
  'fan',
];

export function familyQuestion(family: Family, subject: Subject = 'said'): ChoiceQuestion {
  const s = `\`${subject}\``;
  switch (family) {
    case 'power':
      return {
        type: 'choice',
        instructions:
          `Suppose ${s} is about something that switches on and off — a light, a plug, a fan, ` +
          'an appliance, a TV or a speaker. Should it be switched on or off?',
        criteria: {
          on: 'Switched on — or started, for an appliance.',
          off: 'Switched off — or stopped, for an appliance.',
          [UNCHANGED]:
            'Neither — it does not ask for it to be switched on or off, for example it only asks ' +
            'to dim it, change its colour or pause the music.',
        },
      };
    case 'brightness':
      return {
        type: 'choice',
        instructions: `Suppose ${s} is about a light that can be dimmed. What brightness does it ask for?`,
        criteria: {
          brighter: 'Brighter than it is now, with no number — "brighter", "turn it up".',
          dimmer: 'Dimmer than it is now, with no number — "dim it", "a bit darker".',
          full: 'As bright as it goes — "full brightness", "max".',
          lowest: 'As dim as it goes while still on — "lowest", "as dim as possible".',
          percent: 'A brightness they named as a number — "to 40 percent".',
          [UNCHANGED]: 'Nothing about brightness — for example it only asks to switch it on or off.',
        },
      };
    case 'colour':
      return {
        type: 'choice',
        instructions: `Suppose ${s} is about a light that can change colour. Which colour does it ask for?`,
        criteria: {
          red: 'Red.',
          orange: 'Orange.',
          yellow: 'Yellow.',
          green: 'Green.',
          cyan: 'Cyan or turquoise.',
          blue: 'Blue.',
          purple: 'Purple or violet.',
          pink: 'Pink.',
          warm_white: 'Warm white — soft and yellowish.',
          neutral_white: 'Neutral white.',
          cool_white: 'Cool white — bluish, like daylight.',
          [UNCHANGED]: 'No colour — for example it only asks to switch it on or off, or to dim it.',
        },
      };
    case 'cover':
      return {
        type: 'choice',
        instructions: `Suppose ${s} is about a blind, a curtain, a shutter or a garage door. What should it do?`,
        criteria: {
          open: 'Open all the way.',
          close: 'Close all the way.',
          stop: 'Stop where it is.',
          half: 'Go halfway.',
          [UNCHANGED]: 'None of these.',
        },
      };
    case 'lock':
      return {
        type: 'choice',
        instructions: `Suppose ${s} is about a door lock. Should it be locked or unlocked?`,
        criteria: { lock: 'Locked.', unlock: 'Unlocked.', [UNCHANGED]: 'Neither.' },
      };
    case 'playback':
      return {
        type: 'choice',
        instructions:
          `Suppose ${s} is about a TV or a speaker that plays music or video. Should it start ` +
          'or stop playing?',
        criteria: {
          play: 'Start or carry on playing.',
          pause: 'Pause or stop playing.',
          [UNCHANGED]: 'Neither — for example it only asks to switch it on or off.',
        },
      };
    case 'climate':
      return {
        type: 'choice',
        instructions:
          `Suppose ${s} is about heating, air conditioning or a thermostat. What should it do?`,
        criteria: {
          heat: 'Heat — the heating switched on.',
          cool: 'Cool — the air conditioning switched on.',
          auto: 'Heat or cool by itself, as needed.',
          off: 'Heating and cooling switched off.',
          warmer: 'Warmer than it is set to now, with no number — "turn the heating up".',
          cooler: 'Cooler than it is set to now, with no number — "a bit cooler".',
          degrees: 'A temperature they named as a number — "to 21 degrees".',
          [UNCHANGED]: 'None of these.',
        },
      };
    case 'fan':
      return {
        type: 'choice',
        instructions: `Suppose ${s} is about a fan or an air purifier. What speed should it run at?`,
        criteria: {
          low: 'Low.',
          medium: 'Medium.',
          high: 'High, or full speed.',
          auto: 'Automatic.',
          faster: 'Faster than now, with no number.',
          slower: 'Slower than now, with no number.',
          percent: 'A speed they named as a number — "to 60 percent".',
          on: 'Running, with no speed named — "turn the fan on".',
          off: 'Stopped.',
          [UNCHANGED]: 'Nothing about speed — for example it only asks to switch it on or off.',
        },
      };
  }
}

/* ------------------------------------------------------------------ *
 * A number somebody said.
 * ------------------------------------------------------------------ */

/**
 * What a number found in the sentence is a number *of*.
 *
 * **The model never reads the number.** Code finds it (`amountIn`) and puts it
 * in the state as its own field; this asks only the semantic half — brightness
 * or temperature, a time, or part of a name like "lamp 2" — and code does
 * everything numeric after that: the range check, the unit, the arithmetic.
 * That is the vendor's pre-parsed extraction pattern, and it is how this model
 * is meant to meet a number at all.
 */
export function amountQuestion(subject: Subject = 'said'): ChoiceQuestion {
  const field = amountField(subject);
  return {
    type: 'choice',
    instructions: `\`${field}\` is a number written in \`${subject}\`. What is it?`,
    criteria: {
      brightness: 'A brightness for a light, as a percentage.',
      temperature: 'A temperature to set, in degrees.',
      fan_speed: 'A fan speed, as a percentage.',
      time: 'A time of day, a delay, or a length of time.',
      name: 'Part of the name of a device, a room or a scene — like "lamp 2".',
      other: 'Something else.',
    },
  };
}

/**
 * The number in a sentence, when there is exactly one.
 *
 * Digits only, and only one: two numbers are two things to tell apart, and a
 * number spelled as words is left to the model that can read it. The text is
 * what goes into the state — "40%", "21.5", as written — and the value is
 * what code acts on.
 */
export function amountIn(text: string): { text: string; value: number } | undefined {
  // Bounded on both sides, so "2026" is no match rather than "202", and "lamp2"
  // is part of a name rather than a number.
  const found = [
    ...text.matchAll(/(?<![\p{L}\d.,])(\d{1,3}(?:[.,]\d{1,2})?)(?![\d\p{L}])(?:\s?(%|°))?/gu),
  ];
  if (found.length !== 1) return undefined;
  const [match] = found;
  const digits = match?.[1];
  if (match === undefined || digits === undefined) return undefined;
  const value = Number(digits.replace(',', '.'));
  return Number.isFinite(value) ? { text: match[0].trim(), value } : undefined;
}

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
      'The assistant can answer `said` itself or hand it to a specialist. Which should happen?',
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
  instructions: 'How much work does answering `said` properly take?',
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
    '`said` says enough on its own for somebody who has not read the rest of the ' +
    'conversation to carry it out.',
};
