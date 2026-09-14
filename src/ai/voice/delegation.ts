import type { Logger } from '../../logging.js';
import { LIVE_APPEND_CHARS, LIVE_AUDIO_EVENTS, LIVE_EVENTS } from './live-wire.js';

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
 * - **Nothing about audio.** Audio arrives here whether we want it or not and
 *   is dropped before it is parsed; media itself stays on the phone's WebRTC
 *   connection, and this is explicitly not a place to send any.
 */

/** What answering a delegation needs from the hub, narrowed to two calls. */
export interface VoiceDelegationHost {
  askAloud(input: {
    sessionId: string;
    memberId: string;
    question: string;
  }): Promise<string | null>;
  recordVoiceSpend(input: { sessionId: string; seconds: number }): Promise<void>;
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

/**
 * How much of what was said is carried into one request.
 *
 * A delegation is about what the person has been saying, and "the last thing"
 * is usually a sentence but is sometimes two — a clarifying question answered
 * with three words needs the question in front of it. This is the bound on
 * that, in characters, oldest dropped first.
 */
const CONTEXT_CHARS = 1_200;

export class VoiceDelegation {
  /** What the person has said since the last delegation was handed over. */
  private heard = '';
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

  constructor(private readonly options: VoiceDelegationOptions) {}

  // ── Reading ────────────────────────────────────────────────────────────────

  read(raw: string): void {
    // The cheap half: a frame whose type is audio is dropped without being
    // parsed at all, which is most of what arrives here.
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
        this.heard = (this.heard + delta).slice(-CONTEXT_CHARS);
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
        this.options.log.warn(
          { detail: error?.['message'], code: error?.['code'] },
          'voice: the session reported an error',
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
  private async answer(delegationId: string, offset?: number): Promise<void> {
    if (this.claimed.has(delegationId)) return;
    this.claimed.add(delegationId);

    const question = this.heard.trim();
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
    this.heard = '';
    // Where on the session's clock this was asked: the notice's own offset
    // when it carries one, and otherwise the furthest point anybody had been
    // transcribed to.
    this.askedUntil = offset ?? this.latestEnd ?? this.latestStart;
    const askedUntil = this.askedUntil;

    let answer: string | null = null;
    try {
      answer = await this.options.host.askAloud({
        sessionId: this.options.sessionId,
        memberId: this.options.memberId,
        question,
      });
    } catch (error) {
      this.options.log.warn({ error }, 'voice: could not ask the home');
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
    this.options.send({
      type: `session.${kind}.append`,
      event_id: `${kind}_${this.claimed.size}_${Date.now()}`,
      delegation_id: delegationId,
      content: content.slice(0, LIVE_APPEND_CHARS),
    });
  }

  /**
   * Write down what the line cost, **once**.
   *
   * A session that closes twice — the event, then the socket — must not be
   * billed twice, and one that ends without ever saying records nothing rather
   * than guessing.
   */
  async settle(): Promise<void> {
    if (this.spent) return;
    this.spent = true;
    const seconds = this.seconds;
    if (seconds === undefined || seconds <= 0) return;
    try {
      await this.options.host.recordVoiceSpend({ sessionId: this.options.sessionId, seconds });
    } catch (error) {
      this.options.log.warn({ error }, 'voice: could not record what a session cost');
    }
  }
}

/** A number the frame actually carried, or nothing. */
function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * The frame's `type`, off a bounded prefix.
 *
 * **The whole point is not parsing the frame.** A sideband is sent copies of
 * every audio frame in both directions, so most of what arrives is a few
 * kilobytes of base64 that nothing is going to read — and `JSON.parse` on all
 * of it, fifty times a second, is real work on a 1 GHz core. JSON does not
 * promise field order, so a frame whose `type` is not in the prefix falls
 * through to `undefined` and the caller parses properly; every frame this API
 * actually sends puts `type` first.
 */
export function frameType(raw: string): string | undefined {
  const match = /"type"\s*:\s*"([^"]+)"/.exec(raw.slice(0, TYPE_SCAN_CHARS));
  return match?.[1];
}
