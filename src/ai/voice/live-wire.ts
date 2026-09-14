/**
 * The GPT-Live wire, and **the only place in this repository that names one of
 * its fields**.
 *
 * That is a deliberate containment rather than tidiness. The API is weeks old,
 * its shape is the one thing on this surface nobody can check by running the
 * suite, and it has already been got wrong once here — so every constant and
 * every key lives in this file, the app's own `LiveWire.swift` is its mirror,
 * and a field that turns out different is one edit in one place rather than a
 * hunt through an audio pipeline.
 *
 * **GPT-Live is not the Realtime API with a different model id.** The first
 * phone to dial got `Model "gpt-live-1" is not supported in realtime mode`, and
 * the mistake was reading that as a wrong model. It is not: `gpt-live-1` is
 * right, and so is the $0.05 a minute below. The *mode* was wrong — this is a
 * different endpoint family, and four things about it change the design rather
 * than a field name:
 *
 * - **The socket opens with a `session.start` frame** carrying the whole
 *   session, and waits for `session.started`. Nothing is described in a query
 *   item or minted-and-forgotten.
 * - **Tools are gone; delegation replaces them.** The model does not make
 *   structured function calls. `session.delegation.created` carries an id,
 *   a target and a timing offset — *no request text, no tool name, no parsed
 *   arguments* — and the client answers with `session.commentary.append`,
 *   `session.thinking.append` or `session.instructions.append`, each carrying
 *   that `delegation_id`.
 * - **There is no manual turn control and no turn-completed event.** Audio
 *   streams continuously, the model decides when to speak, and nothing marks
 *   the end of a spoken reply — transcript rows are assembled from fragments
 *   by the client, on a gap it chooses.
 * - **Transcription is native.** `session.input_transcript.delta` and
 *   `session.output_transcript.delta` carry text with `start_ms`/`end_ms`, so
 *   there is no transcription model to name.
 *
 * **One thing here is still a guess, and it is named rather than buried.**
 * `LIVE_SOCKET_URL` is inferred from the one Live socket URL the guides spell
 * out — the fork, at `wss://api.openai.com/v1/live/sessions/{id}/fork` — and
 * the credential question underneath it is open: the guides' two client paths
 * are WebRTC, where a server exchanges the SDP and the client holds nothing,
 * and WebSocket, described as server-side and dialled by the SDK with a
 * project key. Whether Live mints an ephemeral client secret for a WebSocket
 * the way Realtime did is what `guides/voice-websockets?api=live` answers, and
 * `developers.openai.com` is blocked by this session's egress policy. So the
 * URL is **sent to the phone** rather than compiled into it (see
 * `openLiveSession`): if it moves, it is one line here and no app release.
 *
 * **What the hub does and does not do with this.** The hub builds the entire
 * `session.start` frame — instructions, voice, history, delegation mode — and
 * hands the phone the finished JSON plus a credential, so the phone composes
 * nothing and the home's OpenAI key never leaves the machine that holds it. The
 * phone then holds the audio connection itself, because that is the whole point
 * of GPT-Live: the voice layer talks directly to OpenAI at conversational
 * latency, and the reasoning is delegated back here where the home is.
 */

/** The live voice model. */
export const LIVE_MODEL = 'gpt-live-1';

/** Where a live session is created, and where a stored one is forked. */
export const LIVE_SESSIONS_URL = 'https://api.openai.com/v1/live/sessions';

/**
 * The primary socket, which carries audio and control events both ways.
 *
 * **The one unverified line in this file** — see the header. It is answered to
 * the phone rather than pinned in the app, so being wrong about it costs one
 * edit here.
 */
export const LIVE_SOCKET_URL = 'wss://api.openai.com/v1/live';

/** Where an ephemeral client secret is minted, if this API mints one. */
export const LIVE_CLIENT_SECRETS_URL = 'https://api.openai.com/v1/live/client_secrets';

/**
 * Audio, in the one format this path uses in both directions.
 *
 * 24 kHz mono PCM16 is the session default, so `audio.format` is **omitted**
 * from the config rather than declared: the guides give the default in as many
 * words and give the field's own shape only by reference, so taking the default
 * is both what we want and the one answer that cannot be wrong about a field
 * nobody here can check. The phone's `AVAudioConverter` is pointed at exactly
 * this number — a mismatch is not an error anywhere, it is a conversation that
 * sounds like a chipmunk.
 */
export const LIVE_AUDIO_RATE = 24_000;

/**
 * What a minute on the line costs, and **it is the voice layer alone**.
 *
 * $0.05 a minute, billed per second. Whatever model does the thinking behind it
 * is billed on top and is already recorded by `ChatRuntime.bank` as an ordinary
 * `assist` row — so a home that asks what it spent gets two numbers for one
 * conversation, which is the honest answer rather than an accident.
 *
 * **Active time includes silence.** The meter runs while the person speaks,
 * while the assistant speaks, while neither does, and while the backend is
 * working — which is the whole reason the app closes an idle session rather
 * than leaving one open behind a page somebody walked away from.
 */
export const LIVE_USD_PER_MINUTE = 0.05;

/** The voice it speaks in. One, chosen here, because it is the home's. */
export const LIVE_VOICE = 'marin';

/**
 * How much prior conversation a session may open on.
 *
 * The API's own caps are 128 messages and 8,192 combined tokens; this is well
 * inside both, because what it is *for* is the last exchange or two — somebody
 * typed a question, then pressed the microphone to carry it on out loud. A
 * transcript fortnight deep seeded into a voice session is money spent on
 * context nobody is about to refer to.
 */
export const LIVE_HISTORY_MESSAGES = 12;

/**
 * How long one piece of context handed to a running session may be.
 *
 * The three append events take at most 500 tokens of plain string. Characters
 * rather than tokens because nothing here counts tokens and four per token is
 * the conservative direction — an answer clipped a little short is a sentence
 * the model paraphrases, where one refused is silence in a room.
 */
export const LIVE_APPEND_CHARS = 1_800;

/** A message a session opens knowing about. */
export interface LiveHistoryMessage {
  type: 'message';
  role: 'developer' | 'user' | 'assistant';
  content: [{ type: 'input_text' | 'output_text'; text: string }];
}

/**
 * The session the phone is about to hold, built entirely by the hub.
 *
 * `delegation: { type: 'client' }` is the whole architecture in one field: the
 * voice asks *this hub* for help rather than a model OpenAI hosts, so the home
 * keeps its own agent, its own tools, its own transcript and whichever provider
 * it picked. The alternative — `responses` — hands task reasoning to a hosted
 * OpenAI model, which would quietly make the home's model choice not apply the
 * moment somebody started talking.
 */
export interface LiveSessionConfig {
  model: string;
  instructions: string;
  input: LiveHistoryMessage[];
  audio: { output: { voice: string } };
  delegation: { type: 'client' };
}

/** The first frame on the socket. The phone forwards it verbatim. */
export interface LiveStartFrame {
  type: 'session.start';
  session: LiveSessionConfig;
}

/** What the mint answers with, and all the phone is ever handed. */
export interface LiveClientSecret {
  /** An `ek_…` value. Not the home's key, and it expires. */
  value: string;
  /** When it stops working, as an ISO instant. */
  expiresAt: string;
}
