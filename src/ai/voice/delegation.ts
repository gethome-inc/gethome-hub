import type { Logger } from '../../logging.js';
import { LIVE_APPEND_CHARS, LIVE_AUDIO_EVENTS, LIVE_EVENTS } from './live-wire.js';
import {
  SPECULATE_EVERY_MS,
  SPECULATIONS_PER_UTTERANCE,
  SPECULATION_MIN_CHARS,
} from '../decide/questions.js';

/**
 * What a live voice session's frames *mean*, with no connection in it.
 *
 * **This is a separate file for the reason `adapters/matter/settling.ts` is
 * one**: reading these rules through `sideband.ts` means constructing a `ws`
 * connection to `api.openai.com`, so a rule every spoken request in the house
 * goes through would be a rule no test could reach. The socket is the
 * sideband's; the decisions are here, and `test/voice-sideband.test.ts` drives
 * them frame by frame.
 *
 * Four things it owns, and the rule is the API's own — assign one owner per
 * action, because the phone's connection sees every one of these events too:
 *
 * - **Delegations.** Client delegation says "I need help" and nothing else, so
 *   the request is assembled here from what has been transcribed.
 * - **The transcript.** `askAloud` writes the person's row and the answer, so a
 *   spoken exchange leaves exactly what a typed one does.
 * - **What it cost.** `session.usage.updated` and `session.closed` carry the
 *   seconds OpenAI will bill, read here rather than measured by a stopwatch on
 *   a phone that may be force-quit.
 * - **Nothing about audio.** Media stays on the phone's WebRTC connection and
 *   never becomes JSON, so none of it reaches here; the audio event names are
 *   still dropped on sight as insurance, and this is explicitly not a place to
 *   send any.
 */

/** What answering a delegation needs from the hub, narrowed to three calls. */
export interface VoiceDelegationHost {
  askAloud(input: {
    sessionId: string;
    memberId: string;
    question: string;
  }): Promise<string | null>;
  recordVoiceSpend(input: { sessionId: string; seconds: number }): Promise<void>;
  /**
   * Get ready for a sentence that is still being said.
   *
   * **Read-only, and the narrowing is the mechanism rather than the comment.**
   * There is deliberately nothing here that can reach the home: a speculative
   * turn may never write, because "turn the bedroom light on — no, off" is a
   * sentence that would otherwise make the lamp flash. What it buys is
   * everything *around* the answer — the session, the transport, the vendor
   * client's first import, the state digest — so that when the sentence does
   * finish, the only thing left to do is the thing that had to wait for it.
   *
   * It answers nothing and it never throws: a warm that did not happen costs
   * exactly the hub before it existed.
   */
  warmForSpeech(input: { sessionId: string; memberId: string; partial: string }): Promise<void>;
}

export interface VoiceDelegationOptions {
  /** The assistant conversation this session writes into. */
  sessionId: string;
  /** Whose conversation it is — the member whose phone is holding the audio. */
  memberId: string;
  host: VoiceDelegationHost;
  log: Logger;
  /** Put one frame on whatever is holding the session. */
  send(frame: Record<string, unknown>): void;
  /** Let the session go — the two things a connection can be asked to do. */
  close(): void;
}

/** How much of a frame is scanned for its `type` before giving up and parsing. */
const TYPE_SCAN_CHARS = 400;

/** How many of our own append ids are kept, for correlating a refusal. */
const APPENDS_REMEMBERED = 32;

/**
 * How long a delegation may go unanswered before the hub says so out loud.
 *
 * **This is a timeout fix wearing the clothes of a nicety.** The phone closes
 * a line after a minute with nothing said and nothing playing
 * (`VoiceConversation`'s idle clock), and the assistant is allowed a two-minute
 * round — so a slow answer arrived at a session that had already hung up, and
 * the person heard the voice say "one moment" and then nothing, ever. Making
 * the phone more patient is the wrong side to fix it on: that clock exists for
 * a page left on a kitchen counter, where being generous is a meter running in
 * an empty room. This side is the one that *knows* a round is running.
 *
 * So the hub says so, on the same delegation, as
 * `session.commentary.append` — the API's own "information the model should
 * speak aloud" — and the model speaking resets the phone's clock through the
 * transcript deltas it already watches. Twenty seconds is comfortably inside
 * the minute and nowhere near a normal round, which finishes in two or three;
 * it repeats, because two minutes is four of these and a round that long is
 * pathological rather than impossible.
 *
 * **It is a signal rather than a guarantee.** The model decides when to speak,
 * and commentary is content it may paraphrase or fold into what it is already
 * saying. What it cannot do is leave the hub silent for a minute, which is the
 * failure this replaces.
 */
const PATIENCE_MS = 20_000;

/**
 * How much of what was said is carried into one request.
 *
 * A delegation is about what the person has been saying, and "the last thing"
 * is usually a sentence but is sometimes two — a clarifying question answered
 * with three words needs the question in front of it. This is the bound on
 * that, in characters, oldest dropped first.
 */
const CONTEXT_CHARS = 1_200;

/**
 * How long a pause has to be before two things said are two things said.
 *
 * The deltas carry no punctuation between utterances, so "Hi", a pause, and
 * then "turn the kitchen light off" concatenated into one line reading
 * `Hi turn the kitchen light off` — which is what the agent was asked and what
 * the transcript row then showed, with the greeting stuck on the front of the
 * request as if it were part of it. The session's own clock already says
 * otherwise, so a real pause is written down as a line break: the agent reads
 * two sentences, and the row an app draws has them on two lines.
 *
 * The phone's `VoiceConversation.captionGap` is the same number doing the same
 * job on the live caption, so the two agree about where one thing said ends.
 */
const UTTERANCE_GAP_MS = 2_000;

/**
 * One thing the person said, with where it sits on the session's own clock.
 *
 * **A list rather than a string, because the voice answers some of these
 * itself.** `heard` used to be one buffer cleared only when a delegation took
 * it, so an utterance the model answered out loud — a greeting, "what can you
 * do", anything the policy says not to delegate — stayed in the buffer and was
 * handed over on the front of the *next* request. Observed: "what else can you
 * do", answered aloud, arriving at the agent glued to "tell me what's on then"
 * as one two-line question, with the answer the voice had already given
 * nowhere on the page. Keeping them apart is what lets `spent` retire one
 * without touching its neighbours.
 */
interface Utterance {
  text: string;
  /** Where it began and where it has been transcribed to, when the API said. */
  start: number | undefined;
  end: number | undefined;
  /** The voice answered this one by itself — see `retire`. */
  answered: boolean;
}

export class VoiceDelegation {
  /** What the person has said since the last delegation was handed over. */
  private heard: Utterance[] = [];
  /** Where the assistant's own most recent speech began on the session clock. */
  private saidFrom: number | undefined;
  /** Delegations already taken, so a duplicate delivery runs one job. */
  private readonly claimed = new Set<string>();
  /**
   * The session's own timeline, which is the only thing that can tell the tail
   * of a request from a new one — see the `heard` case and `answer`. The
   * newest fragment's start and the furthest end seen; `askedUntil` is where
   * the last delegation was handed over.
   */
  private latestStart: number | undefined;
  private latestEnd: number | undefined;
  private askedUntil: number | undefined;
  private seconds: number | undefined;
  private spent = false;
  /**
   * When the last speculation went out, and how many this utterance has had.
   *
   * There is deliberately **no revision counter beside these**. One was
   * written here for a cache that then landed somewhere better: the reading is
   * kept on the conversation and reused only when the finished sentence
   * *extends* the partial it ran on, so every structural change this would
   * have tracked — a new utterance, a retirement, a drop by the bound — is
   * already a string that is not a superset. A second mechanism agreeing with
   * that one is a second mechanism to get wrong.
   */
  private lastSpeculationAt = 0;
  private speculationsThisUtterance = 0;

  constructor(private readonly options: VoiceDelegationOptions) {}

  // ── Reading ────────────────────────────────────────────────────────────────

  read(raw: string): void {
    // The cheap half: the type is read off a bounded prefix, so an audio frame
    // is dropped without being parsed. A WebRTC session sends none — see
    // `LIVE_AUDIO_EVENTS` — but the transcript deltas below arrive several
    // times a second and the scan is what keeps that off a 1 GHz core.
    if (LIVE_AUDIO_EVENTS.has(frameType(raw) ?? '')) return;

    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = frame['type'];
    if (typeof type !== 'string' || LIVE_AUDIO_EVENTS.has(type)) return;

    switch (type) {
      case LIVE_EVENTS.heard: {
        const delta = frame['delta'];
        if (typeof delta !== 'string') return;
        const start = finite(frame['start_ms']);
        const end = finite(frame['end_ms']);
        // Where the last thing said stopped, read before this fragment moves
        // it — the gap between the two is what separates two utterances.
        const previousEnd = this.latestEnd;
        if (start !== undefined) this.latestStart = Math.max(this.latestStart ?? start, start);
        if (end !== undefined) this.latestEnd = Math.max(this.latestEnd ?? end, end);
        // **Transcription lags the delegation, and that is the whole of this
        // rule.** The model asks for help as soon as it has understood, so the
        // closing fragments of "turn the kitchen light off" land *after* the
        // notice — which is why a fragment that began before the last
        // hand-over is dropped rather than appended. Keeping it would put
        // "off" on the front of the next request, and counting it as speech
        // would make an answer look superseded by the very sentence that asked
        // for it. Anything that began *after* the ask is genuinely new.
        if (start !== undefined && this.askedUntil !== undefined && start < this.askedUntil) {
          return;
        }
        this.hear(delta, start, end, previousEnd);
        return;
      }
      case LIVE_EVENTS.said: {
        // **The voice answering by itself is what retires an utterance**, and
        // reading it is the whole of why this case exists. See `retire`.
        const start = finite(frame['start_ms']);
        this.saidFrom = start ?? this.latestEnd ?? this.saidFrom;
        this.retire();
        return;
      }
      case LIVE_EVENTS.delegated: {
        const delegation = frame['delegation'] as Record<string, unknown> | undefined;
        const id = delegation?.['id'];
        const target = delegation?.['target'];
        if (typeof id !== 'string') return;
        if (target !== undefined && target !== 'client') return;
        // The notice's own place on the session timeline, read off either shape
        // it arrives in — this API has already moved one field from the frame
        // into its object and back.
        const offset = finite(frame['offset_ms']) ?? finite(delegation?.['offset_ms']);
        void this.answer(id, offset);
        return;
      }
      case LIVE_EVENTS.usage: {
        this.readSeconds(frame);
        return;
      }
      case LIVE_EVENTS.closed: {
        this.readSeconds(frame);
        this.options.close();
        return;
      }
      case LIVE_EVENTS.error: {
        const error = frame['error'] as Record<string, unknown> | undefined;
        // **A refused append is silence in a room, so it is named as one.**
        // `error.client_event_id` is the API's own correlation back to the
        // command that failed, and the command that matters here is the one
        // carrying an answer — an append over the 500-token cap is refused,
        // the person hears nothing, and a line reading "the session reported
        // an error" is the least useful possible way to find that out.
        const cause = error?.['client_event_id'];
        const wasOurs = typeof cause === 'string' && this.appended.has(cause);
        this.options.log.warn(
          { detail: error?.['message'], code: error?.['code'], ...(wasOurs ? { cause } : {}) },
          wasOurs
            ? 'voice: the session refused an answer, so nothing was said'
            : 'voice: the session reported an error',
        );
        return;
      }
      default:
        // Everything else, the acknowledgements included. A stream that grows
        // an event must not break a conversation.
        return;
    }
  }

  /**
   * The cumulative seconds off a usage-carrying frame.
   *
   * **A snapshot, never an increment** — the API sends the total so far, which
   * is why this assigns rather than adds, and why a frame that carries no
   * number leaves the last one we saw standing.
   */
  private readSeconds(frame: Record<string, unknown>): void {
    const usage = frame['usage'] as Record<string, unknown> | undefined;
    const seconds = usage?.['seconds'];
    if (typeof seconds === 'number' && Number.isFinite(seconds)) this.seconds = seconds;
  }

  // ── Answering ──────────────────────────────────────────────────────────────

  /**
   * Hand a delegation to the assistant, and say the answer out loud.
   *
   * **`commentary` when it still matters and `thinking` when it does not.** The
   * API's guidance is not to announce an outdated result, and the case it is
   * written for is a lookup for Thursday landing after somebody said Friday. A
   * home is a little different: by the time the answer is here the thing has
   * *already been done*, so throwing it away would leave somebody not knowing.
   * A superseded answer is handed over as something the model should know
   * rather than something it should say — the rule kept, the fact not lost.
   */
  /**
   * What goes between the last thing said and this fragment.
   *
   * Nothing, normally — the deltas of one sentence already carry their own
   * spacing. A line break where the clock says there was a real pause, so a
   * request assembled from two utterances reads as two. Silent when either end
   * of the gap is unknown, which is the honest answer: a build of this API
   * that stops sending a timeline gets the behaviour it had before.
   */
  private separator(start: number | undefined, previousEnd: number | undefined): boolean {
    if (this.heard.length === 0) return true;
    if (start === undefined || previousEnd === undefined) return false;
    return start - previousEnd >= UTTERANCE_GAP_MS;
  }

  /** One fragment onto the thing being said, or a new thing said. */
  private hear(
    delta: string,
    start: number | undefined,
    end: number | undefined,
    previousEnd: number | undefined,
  ): void {
    const opens = this.separator(start, previousEnd);
    const newest = this.heard[this.heard.length - 1];
    if (opens || newest === undefined) {
      this.heard.push({ text: delta, start, end, answered: false });
      this.speculationsThisUtterance = 0;
      // **Opening a new one is what retires the last**, and it has to be here
      // as well as on the voice's own speech: at the moment the voice answers,
      // the sentence it is answering is still the newest — which `retire`
      // never touches, since "one moment" is assistant speech landing after
      // the very request about to be delegated. It stops being the newest
      // exactly here.
      this.retire();
    } else {
      newest.text += delta;
      if (end !== undefined) newest.end = Math.max(newest.end ?? end, end);
    }
    this.bound();
    this.speculate();
  }

  /**
   * Mark what the voice has just answered by itself.
   *
   * **The newest thing said is never retired**, and that one line is what
   * makes this safe. The policy asks the model to say what it is doing
   * *before* it goes and does it, so "one moment" is assistant speech landing
   * a beat after the very request that is about to be delegated — retiring on
   * that would hand the agent an empty question. Anything older is a
   * different matter: the person moved on, and the only thing that can have
   * answered it in between is the voice, since a delegated round clears the
   * whole list when it is taken.
   *
   * It is a mark rather than a deletion because a retired utterance is still
   * *context* right up until the next one opens — and because `answer` is the
   * one place allowed to decide what a request is made of.
   */
  private retire(): void {
    const saidFrom = this.saidFrom;
    for (let index = 0; index < this.heard.length - 1; index += 1) {
      const utterance = this.heard[index];
      if (utterance === undefined || utterance.answered) continue;
      // With no timeline at all — a build of this API that stops sending one —
      // nothing is retired. The old behaviour, which is the conservative
      // direction: a request with too much context beats one with too little.
      if (saidFrom === undefined || utterance.end === undefined) continue;
      if (saidFrom >= utterance.end) {
        utterance.answered = true;
      }
    }
  }

  /** What one request is made of, newest kept, oldest dropped first. */
  private question(): string {
    // The newest is always in it — see `retire`. Everything before it is in
    // only if the voice did not already answer it.
    const kept = this.heard.filter(
      (utterance, index) => index === this.heard.length - 1 || !utterance.answered,
    );
    return kept
      .map((utterance) => utterance.text)
      .join('\n')
      .slice(-CONTEXT_CHARS)
      .trim();
  }

  /**
   * Keep what is remembered inside `CONTEXT_CHARS`, oldest dropped first.
   *
   * The bound used to be a `slice` on one string, which cut mid-word and could
   * leave an utterance headless. Whole utterances go instead, which is the
   * same rule said properly: the newest exchange is the one somebody is about
   * to refer to.
   */
  private bound(): void {
    let total = this.heard.reduce((sum, utterance) => sum + utterance.text.length, 0);
    while (total > CONTEXT_CHARS && this.heard.length > 1) {
      const dropped = this.heard.shift();
      total -= dropped?.text.length ?? 0;
    }
  }

  /**
   * Get the hub ready while somebody is still talking.
   *
   * **The trick the demo videos are built on, with the write taken out of it.**
   * A spoken exchange is dominated by what happens *after* the sentence ends:
   * the session has to exist, the transport has to be built, the vendor client
   * has to be imported for the first time on a 1 GHz core, and the home's
   * current readings have to be gathered. None of that depends on how the
   * sentence finishes, and all of it can happen while it is still being said.
   *
   * What deliberately does **not** happen here is the answer, and above all
   * the action: `warmForSpeech` is narrowed so it cannot reach the home at
   * all. "Turn the bedroom light on — no, off" is an ordinary thing to say,
   * and a hub that acted on the first half would make the lamp flash. The
   * write waits for `session.delegation.created`, which is the model saying
   * the sentence is finished.
   *
   * Four bounds, and the per-utterance one is the one that matters: the voice
   * prompt's own "don't treat a television as a request" hazard, one layer
   * down — a room with a film on produces transcript deltas indefinitely, and
   * a rate limit alone would turn a negligible cost into a bill.
   */
  private speculate(): void {
    if (this.spent) return;
    // Already asked; the answer is on its way and the sentence is finished.
    if (this.askedUntil !== undefined && this.latestEnd !== undefined) {
      if (this.latestEnd <= this.askedUntil) return;
    }
    if (this.speculationsThisUtterance >= SPECULATIONS_PER_UTTERANCE) return;
    const now = Date.now();
    if (now - this.lastSpeculationAt < SPECULATE_EVERY_MS) return;
    const partial = this.question();
    if (partial.length < SPECULATION_MIN_CHARS) return;

    this.lastSpeculationAt = now;
    this.speculationsThisUtterance += 1;
    // Deliberately not awaited: nothing is waiting on it, and a warm that
    // takes longer than the sentence has simply missed its own point.
    void this.options.host
      .warmForSpeech({
        sessionId: this.options.sessionId,
        memberId: this.options.memberId,
        partial,
      })
      .catch(() => undefined);
  }

  private async answer(delegationId: string, offset?: number): Promise<void> {
    if (this.claimed.has(delegationId)) return;
    this.claimed.add(delegationId);

    const question = this.question();
    if (question === '') {
      // Nothing has been transcribed yet, so there is nothing this could be
      // about. The model carries on talking; a real request arrives with its
      // own delegation.
      this.options.log.debug('voice: a delegation arrived with nothing to hand over');
      return;
    }
    // Taken, so a second delegation about the same sentence does not run the
    // same job twice — and so the next request is assembled from what is said
    // next rather than from everything since the session opened.
    this.heard = [];
    // Where on the session's clock this was asked: the notice's own offset
    // when it carries one, and otherwise the furthest point anybody had been
    // transcribed to.
    this.askedUntil = offset ?? this.latestEnd ?? this.latestStart;
    // The sentence has been taken, so the next one starts its own count.
    this.speculationsThisUtterance = 0;
    const askedUntil = this.askedUntil;

    // See `PATIENCE_MS`: a round that outlives the phone's idle clock has to
    // say so, or the answer lands on a line that has already gone.
    const patience = setInterval(() => {
      this.send('commentary', delegationId, AWAY_TOO_LONG);
    }, PATIENCE_MS);
    patience.unref?.();

    let answer: string | null = null;
    try {
      answer = await this.options.host.askAloud({
        sessionId: this.options.sessionId,
        memberId: this.options.memberId,
        question,
      });
    } catch (error) {
      this.options.log.warn({ error }, 'voice: could not ask the home');
    } finally {
      clearInterval(patience);
    }

    if (answer === null || answer.trim() === '') {
      this.send('thinking', delegationId, 'That could not be worked out. Say so briefly.');
      return;
    }
    // **Superseded means the person started saying something new**, not that
    // more of the old sentence arrived. With no timeline at all — a build of
    // this API that stops sending one — it is spoken: the cost of a slightly
    // late sentence about something the hub has already done is far below the
    // cost of never hearing that it happened.
    const superseded =
      askedUntil !== undefined && this.latestStart !== undefined && this.latestStart > askedUntil;
    this.send(superseded ? 'thinking' : 'commentary', delegationId, answer);
  }

  private send(kind: 'commentary' | 'thinking', delegationId: string, content: string): void {
    const eventId = `${kind}_${this.claimed.size}_${Date.now()}`;
    this.remember(eventId);
    this.options.send({
      type: `session.${kind}.append`,
      event_id: eventId,
      delegation_id: delegationId,
      content: content.slice(0, LIVE_APPEND_CHARS),
    });
  }

  /**
   * The appends this session has sent, so a refusal can be named as one.
   *
   * Bounded, because it exists only to read an `error` arriving moments later
   * and a session is minutes long — the oldest entry is one nothing could
   * still be failing about.
   */
  private readonly appended = new Set<string>();

  private remember(eventId: string): void {
    this.appended.add(eventId);
    if (this.appended.size > APPENDS_REMEMBERED) {
      const oldest = this.appended.values().next().value;
      if (oldest !== undefined) this.appended.delete(oldest);
    }
  }

  /**
   * Say the line has closed, **once**, and what it cost if the session said.
   *
   * A session that closes twice — the event, then the socket — must not be
   * billed twice, and one that ends without ever saying what it cost records
   * nothing rather than guessing.
   *
   * **But it is still told, which is the half that was missing.**
   * `session.usage.updated` arrives about once a minute, so a session that ran
   * for forty seconds and then dropped — a phone force-quit, a train tunnel —
   * never carried a number at all, and the early return meant the host was
   * never told the line had gone either. What the host hangs off that is
   * whether the conversation is still being *spoken* to, so the mark stayed
   * and a follow-up typed into it hours later was logged as speech. Zero is
   * the honest number for a line nobody could measure, and the host writes no
   * row for it.
   */
  async settle(): Promise<void> {
    if (this.spent) return;
    this.spent = true;
    try {
      await this.options.host.recordVoiceSpend({
        sessionId: this.options.sessionId,
        seconds: this.seconds ?? 0,
      });
    } catch (error) {
      this.options.log.warn({ error }, 'voice: could not record what a session cost');
    }
  }
}

/**
 * What the voice is given to say while the house is still being asked.
 *
 * Deliberately **not** a claim about what is happening — the hub knows a round
 * is running and nothing more, and "checking the kitchen light" would be a
 * sentence invented here about a tool call nobody here can see. The one true
 * thing is that it is taking a while, so that is what is said.
 */
const AWAY_TOO_LONG = 'This is taking longer than usual. Still working on it — say so briefly.';

/** A number the frame actually carried, or nothing. */
function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * The frame's `type`, off a bounded prefix.
 *
 * **The point is deciding what to ignore without parsing it.** JSON does not
 * promise field order, so a frame whose `type` is not in the prefix falls
 * through to `undefined` and the caller parses properly; every frame this API
 * actually sends puts `type` first.
 */
export function frameType(raw: string): string | undefined {
  const match = /"type"\s*:\s*"([^"]+)"/.exec(raw.slice(0, TYPE_SCAN_CHARS));
  return match?.[1];
}
