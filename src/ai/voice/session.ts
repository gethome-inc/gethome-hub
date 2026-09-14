import type { Logger } from '../../logging.js';
import { classifyApiError } from '../errors.js';
import { assistantTools } from '../assistant-tools.js';
import {
  ASK_HOME_TOOL,
  CLIENT_SECRETS_URL,
  LIVE_AUDIO_RATE,
  LIVE_MODEL,
  LIVE_TRANSCRIBE_MODEL,
  LIVE_VOICE,
  type LiveClientSecret,
  type LiveSessionConfig,
  type LiveTool,
} from './live-wire.js';

/**
 * Opening a live voice session, which the hub does and the phone holds.
 *
 * **The split is the design.** The audio has to go straight from the phone to
 * OpenAI or it is not a conversation — a hop through a Raspberry Pi on the way
 * to and from the west coast is latency nobody would tolerate, and the hub is a
 * 1 GHz core that has better things to do than relay PCM. But the home's key
 * must not leave the hub (`docs/portraits.md`'s rule, and the reason portraits
 * are drawn here), and what the model is *told* is the home's business. So the
 * hub builds the entire session — instructions, tools, voice, formats — mints
 * an ephemeral secret against it, and hands the phone a value that expires and
 * is not a key.
 *
 * **The tool catalog is generated from the assistant's own**, which is the
 * `delegate` rule applied one layer out: a tool added to `assistant-tools.ts`
 * reaches the voice with no app release, because the app never sees a tool name
 * it did not get from here.
 */

/**
 * What the voice may do without asking anybody.
 *
 * The assistant's own tools minus the two that make no sense out loud.
 * `ask_user` is gone because *speaking* is how this one asks a question — a
 * tool that suspends a turn for tappable options is a page's idiom, and the
 * person is standing in a room. `delegate` is gone because the voice does not
 * hand jobs to sub-agents directly: it hands them to the assistant, which is
 * the thing that knows how to delegate, and one route out keeps the assistant's
 * transcript the record of what was asked for.
 */
const WITHHELD = new Set(['ask_user', 'delegate']);

/** The catalog the session declares, in the hub's own vocabulary. */
export function liveTools(): LiveTool[] {
  const fromAssistant = assistantTools([])
    .filter((tool) => !WITHHELD.has(tool.name))
    .map((tool) => ({
      type: 'function' as const,
      name: tool.name,
      description: tool.description,
      parameters: tool.schema(),
    }));
  return [...fromAssistant, ASK_HOME_TOOL];
}

export interface LiveSessionRequest {
  /** The home's OpenAI key. Used here and never returned. */
  secret: string;
  instructions: string;
  log: Logger;
}

/**
 * Mint the ephemeral secret the phone connects with.
 *
 * Answers OpenAI's own sentence on a refusal rather than one invented here —
 * `classifyApiError` branches on HTTP status, which is why it is structural and
 * works for a vendor it has never been pointed at before.
 */
export async function openLiveSession(
  request: LiveSessionRequest,
): Promise<{ secret: LiveClientSecret; config: LiveSessionConfig }> {
  const config: LiveSessionConfig = {
    type: 'realtime',
    model: LIVE_MODEL,
    instructions: request.instructions,
    audio: {
      input: {
        format: { type: 'audio/pcm', rate: LIVE_AUDIO_RATE },
        transcription: { model: LIVE_TRANSCRIBE_MODEL },
        turn_detection: { type: 'semantic_vad', interrupt_response: true },
      },
      output: { format: { type: 'audio/pcm', rate: LIVE_AUDIO_RATE }, voice: LIVE_VOICE },
    },
    tools: liveTools(),
  };

  let response: Response;
  try {
    response = await fetch(CLIENT_SECRETS_URL, {
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
