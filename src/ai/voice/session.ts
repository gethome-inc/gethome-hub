import type { Logger } from '../../logging.js';
import { classifyApiError } from '../errors.js';
import {
  LIVE_AUDIO_RATE,
  LIVE_HISTORY_MESSAGES,
  LIVE_MODEL,
  LIVE_SESSIONS_URL,
  LIVE_VOICE,
  type LiveHistoryMessage,
  type LiveSessionConfig,
  type LiveWebRtcRequest,
} from './live-wire.js';

/**
 * Opening a live voice session: the hub describes it and answers the phone's
 * own connection offer.
 *
 * **The split is the design, and WebRTC is what makes it possible.** The audio
 * has to go straight from the phone to OpenAI or it is not a conversation — a
 * hop through a Raspberry Pi on the way to and from the west coast is latency
 * nobody would tolerate, and the hub is a 1 GHz core that has better things to
 * do than relay PCM. But the home's key must not leave the hub
 * (`docs/portraits.md`'s rule, and the reason portraits are drawn here), and
 * what the model is *told* is the home's business.
 *
 * Live's WebSocket transport cannot serve that: it authenticates with the
 * **project API key** and is documented for server-side audio, and there is no
 * ephemeral client secret anywhere in the family. WebRTC is the API's own
 * answer for a phone, and it is a better containment than the secret this file
 * was first built around — the phone ends up holding an audio connection it was
 * never given a credential of any kind for. The hub takes its SDP offer,
 * attaches the whole session, posts both with the home's key, and hands back
 * the answer.
 *
 * **And there is no tool catalog.** Client delegation makes no structured
 * function calls — `session.delegation.created` carries an id and nothing else
 * — so the voice has no catalog to declare and no fast path of its own. Every
 * request reaches this hub's assistant, which is where the tools, the model
 * choice and the transcript already were. See `live-wire.ts`.
 */

export interface LiveSessionRequest {
  /** The home's OpenAI key. Used here and never returned. */
  secret: string;
  /** How to sound, and when to ask this hub for help. */
  instructions: string;
  /** What the conversation has already said, newest last. */
  history?: LiveHistoryMessage[] | undefined;
  /** The phone's own SDP offer, forwarded unread. */
  offerSdp: string;
  log: Logger;
}

/** Everything the phone needs, and nothing it could compose itself. */
export interface OpenedLiveSession {
  config: LiveSessionConfig;
  /** The SDP answer, for the phone's peer connection. */
  answerSdp: string;
  /** OpenAI's own id for the session. Opaque; kept for the log and a fork. */
  liveSessionId: string | undefined;
  audioRate: number;
}

/**
 * Create the session, and answer the phone's offer.
 *
 * Answers OpenAI's own sentence on a refusal rather than one invented here —
 * `classifyApiError` branches on HTTP status, which is why it is structural and
 * works for a vendor it has never been pointed at before. **That matters more
 * than usual on this route**, because everything that can go wrong with a
 * voice session goes wrong here: a revoked key, a balance that has run out, a
 * rate limit, an SDP the far end will not take. All of it arrives as one HTTP
 * status with a sentence, and reaches the person as a `502` naming the real
 * problem rather than as a microphone that does nothing.
 */
export async function openLiveSession(request: LiveSessionRequest): Promise<OpenedLiveSession> {
  const config: LiveSessionConfig = {
    model: LIVE_MODEL,
    instructions: request.instructions,
    // Newest last, and bounded here rather than by the caller: the live model's
    // context window is small, and what this is for is the last exchange or two.
    input: (request.history ?? []).slice(-LIVE_HISTORY_MESSAGES),
    // No `audio.format`: WebRTC negotiates its own and refuses the field.
    audio: { output: { voice: LIVE_VOICE } },
    delegation: { type: 'client' },
  };
  const body: LiveWebRtcRequest = {
    session: config,
    transport: { type: 'webrtc', sdp: request.offerSdp },
  };

  let response: Response;
  try {
    response = await fetch(LIVE_SESSIONS_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${request.secret}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(
      `could not reach OpenAI to open a voice session: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const text = await response.text();
  if (!response.ok) {
    const message = messageIn(text) ?? `OpenAI answered ${response.status}.`;
    request.log.warn({ status: response.status }, 'voice: OpenAI refused a session');
    throw (
      classifyApiError({ status: response.status, headers: response.headers, message }) ??
      new Error(message)
    );
  }

  const parsed = JSON.parse(text) as {
    sdp?: unknown;
    session?: { id?: unknown };
    transport?: { sdp?: unknown };
  };
  // Read the answer at both depths rather than asserting one. The documented
  // shape is `transport.sdp` beside `session.id`; a flat `sdp` is read too,
  // because a shape that moves under a field nobody here can check is exactly
  // what `live-wire.ts` exists to contain.
  const answerSdp = pickString(parsed.transport?.sdp) ?? pickString(parsed.sdp);
  if (answerSdp === null) {
    throw new Error('OpenAI opened a voice session without answering the connection offer');
  }

  return {
    config,
    answerSdp,
    liveSessionId: pickString(parsed.session?.id) ?? undefined,
    audioRate: LIVE_AUDIO_RATE,
  };
}

function pickString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function messageIn(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    const message = parsed.error?.message;
    return typeof message === 'string' && message.length > 0 ? message.slice(0, 400) : null;
  } catch {
    return null;
  }
}
