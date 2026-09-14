import type { Logger } from '../../logging.js';
import { classifyApiError } from '../errors.js';
import {
  LIVE_AUDIO_RATE,
  LIVE_CLIENT_SECRETS_URL,
  LIVE_HISTORY_MESSAGES,
  LIVE_MODEL,
  LIVE_SOCKET_URL,
  LIVE_VOICE,
  type LiveClientSecret,
  type LiveHistoryMessage,
  type LiveSessionConfig,
  type LiveStartFrame,
} from './live-wire.js';

/**
 * Opening a live voice session, which the hub describes and the phone holds.
 *
 * **The split is the design.** The audio has to go straight from the phone to
 * OpenAI or it is not a conversation — a hop through a Raspberry Pi on the way
 * to and from the west coast is latency nobody would tolerate, and the hub is a
 * 1 GHz core that has better things to do than relay PCM. But the home's key
 * must not leave the hub (`docs/portraits.md`'s rule, and the reason portraits
 * are drawn here), and what the model is *told* is the home's business. So the
 * hub builds the entire `session.start` frame — instructions, voice, history,
 * delegation mode — mints a credential, and hands the phone a finished string
 * to put on the socket plus a value that expires.
 *
 * **The phone is handed JSON rather than fields**, which is the containment
 * rule one step further than it used to go. It used to receive a model id and a
 * tool catalog and assemble a session; now it forwards an opaque frame, so
 * `LiveWire.swift` names only the events coming *back* and nothing about what a
 * session is. A prompt change, a voice change, a new configuration field: all
 * of them reach the microphone with no app release.
 *
 * **And there is no tool catalog at all any more.** Client delegation does not
 * make structured function calls — `session.delegation.created` carries an id
 * and nothing else — so the voice has no catalog to declare and no fast path of
 * its own. Every request reaches this hub's assistant, which is where the
 * tools, the model choice and the transcript already were. See `live-wire.ts`.
 */

export interface LiveSessionRequest {
  /** The home's OpenAI key. Used here and never returned. */
  secret: string;
  /** How to sound, and when to ask this hub for help. */
  instructions: string;
  /** What the conversation has already said, newest last. */
  history?: LiveHistoryMessage[] | undefined;
  log: Logger;
}

/** Everything the phone needs, and nothing it could compose itself. */
export interface OpenedLiveSession {
  secret: LiveClientSecret;
  config: LiveSessionConfig;
  /** The socket to dial. Answered rather than pinned — see `live-wire.ts`. */
  socketUrl: string;
  /** The first frame, serialised, for the phone to send verbatim. */
  startFrame: string;
  audioRate: number;
}

/**
 * Mint the credential the phone connects with, and describe the session.
 *
 * Answers OpenAI's own sentence on a refusal rather than one invented here —
 * `classifyApiError` branches on HTTP status, which is why it is structural and
 * works for a vendor it has never been pointed at before. **That matters more
 * than usual on this route**, because the credential question is the open one
 * (see `live-wire.ts`): if this API mints no client secret for a socket, the
 * failure arrives here, with OpenAI's wording, and reaches the person as a
 * `502` naming the real problem rather than as a microphone that does nothing.
 */
export async function openLiveSession(request: LiveSessionRequest): Promise<OpenedLiveSession> {
  const config: LiveSessionConfig = {
    model: LIVE_MODEL,
    instructions: request.instructions,
    // Newest last, and bounded here rather than by the caller: the API's own
    // caps are 128 messages and 8,192 tokens, and what this is for is the last
    // exchange or two.
    input: (request.history ?? []).slice(-LIVE_HISTORY_MESSAGES),
    // No `audio.format`: 24 kHz mono PCM16 is the documented default, and
    // taking a default is the one answer that cannot be wrong about a field's
    // shape. `audio.format` is also immutable for the life of a session, so
    // there is nothing to revisit later.
    audio: { output: { voice: LIVE_VOICE } },
    delegation: { type: 'client' },
  };
  const start: LiveStartFrame = { type: 'session.start', session: config };

  let response: Response;
  try {
    response = await fetch(LIVE_CLIENT_SECRETS_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${request.secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ session: config }),
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
    value?: unknown;
    expires_at?: unknown;
    client_secret?: { value?: unknown; expires_at?: unknown };
  };
  // The value has lived at two depths across this API's short life, so both are
  // read rather than one being asserted — a shape that moves under a field
  // nobody can check from here is exactly what `live-wire.ts` exists to contain.
  const value = pickString(parsed.value) ?? pickString(parsed.client_secret?.value);
  const expires = pickExpiry(parsed.expires_at) ?? pickExpiry(parsed.client_secret?.expires_at);
  if (value === null) throw new Error('OpenAI opened a voice session without a client secret');

  return {
    secret: {
      value,
      // An absent expiry is read as the API's documented half-hour rather than
      // as "for ever": the app closes and re-mints on it, and the failure of
      // guessing short is one extra round trip where guessing long is a session
      // that dies mid-sentence.
      expiresAt: expires ?? new Date(Date.now() + 30 * 60_000).toISOString(),
    },
    config,
    socketUrl: LIVE_SOCKET_URL,
    startFrame: JSON.stringify(start),
    audioRate: LIVE_AUDIO_RATE,
  };
}

function pickString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Epoch seconds or an ISO instant, whichever this build of the API sends. */
function pickExpiry(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }
  return pickString(value);
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
