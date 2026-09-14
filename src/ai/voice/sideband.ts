import WebSocket from 'ws';
import type { Logger } from '../../logging.js';
import {
  LIVE_APPEND_CHARS,
  LIVE_AUDIO_EVENTS,
  LIVE_EVENTS,
  liveSidebandUrl,
} from './live-wire.js';

/**
 * The hub's own connection to a live voice session, beside the phone's.
 *
 * **This is where the delegation loop belongs, and it took three goes to see
 * it.** GPT-Live's client delegation says "I need help" and nothing else, so
 * somebody has to assemble the request from the transcript and answer it. That
 * was the phone, which meant every spoken request went OpenAI → phone → hub →
 * phone → OpenAI: two LAN legs added to the one thing on this surface that is
 * measured in how quickly a lamp goes off. A **sideband** attaches a second
 * connection to the *same* session from here, so the request never leaves the
 * machine that can answer it.
 *
 * Four things it owns outright, and the rule is the API's own: assign one owner
 * per action, because both connections see every event.
 *
 * - **Delegations.** The phone no longer answers them at all.
 * - **The transcript.** `askAloud` writes the person's row and the answer, so a
 *   spoken exchange leaves exactly what a typed one does.
 * - **What it cost.** `session.usage.updated` and `session.closed` carry the
 *   seconds OpenAI will bill, read here rather than measured by a stopwatch on
 *   a phone that may be force-quit.
 * - **Nothing about audio.** Media stays on the phone's WebRTC connection. The
 *   sideband is explicitly not a place to send microphone audio.
 *
 * **And it receives audio whether it wants to or not**, which is the one thing
 * about this that costs a Raspberry Pi something: a sideband is sent *copies*
 * of both directions as base64 PCM16 at 24 kHz — about a megabit a second,
 * arriving as several kilobytes of JSON every twenty milliseconds, with no way
 * to decline it. So the type is read off a **bounded prefix** of the raw frame
 * and audio is dropped before anything is parsed. A full parse is still the
 * fallback for a frame whose `type` is not in the first few hundred
 * characters — correct, and never reached in practice.
 */

/** What the sideband needs from the hub, narrowed to two calls. */
export interface VoiceSidebandHost {
  askAloud(input: {
    sessionId: string;
    memberId: string;
    question: string;
  }): Promise<string | null>;
  recordVoiceSpend(input: { sessionId: string; seconds: number }): Promise<void>;
}

export interface VoiceSidebandOptions {
  /** OpenAI's own id for the live session, from the creation response. */
  liveSessionId: string;
  /** The assistant conversation this session writes into. */
  sessionId: string;
  /** Whose conversation it is — the member whose phone is holding the audio. */
  memberId: string;
  /** The home's OpenAI key. Used to attach and never returned. */
  secret: string;
  host: VoiceSidebandHost;
  log: Logger;
}

/**
 * How long one attached sideband may live.
 *
 * A bound rather than a policy: the session itself expires, the phone closes
 * it, or the connection drops — all three end this. What the ceiling stops is
 * a socket held for ever against a session nobody told us about, on a board
 * that measures its memory in hundreds of megabytes.
 */
const SIDEBAND_MAX_MS = 60 * 60 * 1000;

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

export class VoiceSideband {
  private socket: WebSocket | undefined;
  private ceiling: NodeJS.Timeout | undefined;
  /** What the person has said since the last delegation was handed over. */
  private heard = '';
  /** Delegations already taken, so a duplicate delivery runs one job. */
  private readonly claimed = new Set<string>();
  /** Which thing the person said we are on — see `answer`. */
  private asked = 0;
  private seconds: number | undefined;
  private spent = false;

  constructor(private readonly options: VoiceSidebandOptions) {}

  /**
   * Attach to the running session.
   *
   * Nothing is sent to configure it: the session was created over HTTP with
   * the whole configuration, and the API is explicit that an attached socket
   * must not send `session.start` again.
   */
  attach(): void {
    if (this.socket) return;
    const socket = new WebSocket(liveSidebandUrl(this.options.liveSessionId), {
      headers: { authorization: `Bearer ${this.options.secret}` },
    });
    this.socket = socket;

    socket.on('message', (data: WebSocket.RawData) => {
      this.read(typeof data === 'string' ? data : data.toString('utf8'));
    });
    socket.on('error', (error: Error) => {
      this.options.log.warn({ error }, 'voice: the sideband failed');
    });
    socket.on('close', () => {
      // The last usage we saw is the honest answer: the API's own advice for a
      // connection that ends before `session.closed`.
      void this.settle();
    });

    this.ceiling = setTimeout(() => {
      this.options.log.warn('voice: a sideband outlived its ceiling');
      this.close();
    }, SIDEBAND_MAX_MS);
    this.ceiling.unref?.();
  }

  close(): void {
    if (this.ceiling) clearTimeout(this.ceiling);
    this.ceiling = undefined;
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
    void this.settle();
  }

  // ── Reading ────────────────────────────────────────────────────────────────

  private read(raw: string): void {
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
        // **A fragment is not a thing said.** The counter moves when the buffer
        // *opens* — at the start, or after a delegation took it — because a
        // count of fragments would demote an answer to `thinking` the moment
        // somebody said "ok" while waiting for it, which is most rounds.
        if (this.heard === '') this.asked += 1;
        this.heard = (this.heard + delta).slice(-CONTEXT_CHARS);
        return;
      }
      case LIVE_EVENTS.delegated: {
        const delegation = frame['delegation'] as Record<string, unknown> | undefined;
        const id = delegation?.['id'];
        const target = delegation?.['target'];
        if (typeof id !== 'string') return;
        if (target !== undefined && target !== 'client') return;
        void this.answer(id);
        return;
      }
      case LIVE_EVENTS.usage: {
        const usage = frame['usage'] as Record<string, unknown> | undefined;
        const seconds = usage?.['seconds'];
        if (typeof seconds === 'number' && Number.isFinite(seconds)) this.seconds = seconds;
        return;
      }
      case LIVE_EVENTS.closed: {
        const usage = frame['usage'] as Record<string, unknown> | undefined;
        const seconds = usage?.['seconds'];
        if (typeof seconds === 'number' && Number.isFinite(seconds)) this.seconds = seconds;
        this.close();
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
  private async answer(delegationId: string): Promise<void> {
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
    const askedAt = this.asked;

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
    this.send(this.asked === askedAt ? 'commentary' : 'thinking', delegationId, answer);
  }

  private send(kind: 'commentary' | 'thinking', delegationId: string, content: string): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(
      JSON.stringify({
        type: `session.${kind}.append`,
        event_id: `${kind}_${this.claimed.size}_${Date.now()}`,
        delegation_id: delegationId,
        content: content.slice(0, LIVE_APPEND_CHARS),
      }),
    );
  }

  /**
   * Write down what the line cost, **once**.
   *
   * A session that closes twice — the event, then the socket — must not be
   * billed twice, and one that ends without ever saying records nothing rather
   * than guessing.
   */
  private async settle(): Promise<void> {
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

/**
 * The frame's `type`, off a bounded prefix. Exported for the one test worth
 * having about it: that an audio frame is recognised without being parsed.
 *
 *
 * **The whole point is not parsing the frame.** A sideband is sent copies of
 * every audio frame in both directions, so most of what arrives here is a few
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

/**
 * The sidebands this process is holding, one per live voice session.
 *
 * **A module-level registry rather than a service threaded through `ApiDeps`**,
 * and that is a deliberate trade. One hub is one home and one process, so
 * there is exactly one of these however it is passed; and every field added to
 * `ApiDeps` is a field two `buildServer` call sites in `test/` have to learn
 * about — which has already cost this repository a CI failure that read as
 * `list.map is not a function` a hundred lines from its cause. What is stored
 * is a socket per *open conversation*, closed when the session ends and
 * replaced when one is reopened, so it cannot grow.
 */
const attached = new Map<string, VoiceSideband>();

/** Attach one, replacing any this conversation was already holding. */
export function attachSideband(options: VoiceSidebandOptions): void {
  attached.get(options.sessionId)?.close();
  const sideband = new VoiceSideband(options);
  attached.set(options.sessionId, sideband);
  sideband.attach();
}

/** Let one go — the hub shutting down, or a conversation being closed. */
export function detachSideband(sessionId: string): void {
  attached.get(sessionId)?.close();
  attached.delete(sessionId);
}

/** Let all of them go. For shutdown, and for a suite that opened one. */
export function detachAllSidebands(): void {
  for (const sideband of attached.values()) sideband.close();
  attached.clear();
}
