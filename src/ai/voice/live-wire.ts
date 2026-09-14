/**
 * The GPT-Live wire, and **the only place in this repository that names one of
 * its fields**.
 *
 * That is a deliberate containment rather than tidiness. The API is weeks old,
 * its shape is the one thing on this surface nobody can check by running the
 * suite, and it has already been got wrong twice here — so every constant and
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
 * - **A session is created over HTTP**, here, with the project key. The client
 *   is handed an answer to its own connection offer and never a credential.
 * - **Tools are gone; delegation replaces them.** The model makes no structured
 *   function calls. `session.delegation.created` carries an id, a target and a
 *   timing offset — *no request text, no tool name, no parsed arguments* — and
 *   the client answers with `session.commentary.append`,
 *   `session.thinking.append` or `session.instructions.append`, each carrying
 *   that `delegation_id`.
 * - **There is no manual turn control and no turn-completed event.** Audio
 *   streams continuously, the model decides when to speak, and nothing marks
 *   the end of a spoken reply — transcript rows are assembled from fragments
 *   by the client, on a gap it chooses.
 * - **Transcription is native**, so there is no transcription model to name.
 *
 * **And the transport is WebRTC, which is the API's own answer rather than a
 * preference.** Live has two: a primary WebSocket at
 * `wss://api.openai.com/v1/live/sessions`, authenticated with the **project
 * API key** and documented "for server-side audio integrations", and WebRTC,
 * documented for "browser and mobile applications". There is no ephemeral
 * client secret anywhere in the family — the thing Realtime had, and the thing
 * the first version of this file was built on. So a phone cannot hold a Live
 * WebSocket without holding the home's key, which is the one rule this whole
 * surface exists to keep. WebRTC is what makes the split possible at all: the
 * hub does the offer/answer exchange with the key, and the phone ends up
 * holding an audio connection it was never given a credential for.
 *
 * It is also the better transport by some distance, which is a bonus rather
 * than the argument. A WebSocket carries 24 kHz PCM16 as base64 over TCP —
 * about 64 kB a second, with head-of-line blocking, retransmission instead of
 * concealment, and no congestion control; WebRTC carries Opus over SRTP at a
 * twentieth of that, with a jitter buffer, packet-loss concealment and
 * congestion control, on a path built for conversation.
 */

/** The live voice model. */
export const LIVE_MODEL = 'gpt-live-1';

/**
 * Where a live session is created — one route for both transports.
 *
 * For WebRTC this is a `POST` carrying the session **and the client's own SDP
 * offer**, answered with an SDP answer and the session's id. Authenticated
 * with the home's key, here, which is the whole point.
 */
export const LIVE_SESSIONS_URL = 'https://api.openai.com/v1/live/sessions';

/**
 * Where the hub attaches its own connection to a running session.
 *
 * A **sideband**: a second socket onto the *same* session, authenticated with
 * the home's key, carrying every event the phone's data channel carries and
 * accepting every command. It is what lets the delegation loop live here
 * rather than on the phone — see `sideband.ts`. The session must already be
 * running: an attached socket never sends `session.start`.
 */
export function liveSidebandUrl(liveSessionId: string): string {
  return `wss://api.openai.com/v1/live/sessions/${encodeURIComponent(liveSessionId)}/attach`;
}

/** The events the hub acts on, off its sideband. */
export const LIVE_EVENTS = {
  /** A fragment of what the person is saying. **Not a turn** — there is no
   *  event that is, so a request is assembled from these. */
  heard: 'session.input_transcript.delta',
  /** A fragment of what the assistant is saying. */
  said: 'session.output_transcript.delta',
  /** The model wants help, and has said nothing about what with. */
  delegated: 'session.delegation.created',
  /** Cumulative seconds on the line. A snapshot, not an increment. */
  usage: 'session.usage.updated',
  /** Finalised, with the last word on usage and a reason. */
  closed: 'session.closed',
  error: 'error',
} as const;

/**
 * The two audio events, dropped before they are parsed.
 *
 * **They should never arrive, and the guard stays anyway.** The claim used to
 * be that a sideband is sent copies of both directions as base64 PCM16 — about
 * a megabit a second — and that dropping them off a bounded prefix was the one
 * thing that made attaching affordable on a Pi. That was read across from the
 * WebSocket transport and is wrong for every session this hub opens: the
 * reference marks `session.input_audio.append` and `session.output_audio.delta`
 * **WebSocket only**, and a WebRTC session carries its media on the negotiated
 * track, so there is no JSON audio in existence for a sideband to be copied.
 *
 * It is kept because it costs one set lookup against a string this code has
 * already got, and because the one session shape that *would* flood a sideband
 * is the one a later change might reach for. What it is not is a justification:
 * `frameType`'s prefix scan is worth having for the transcript deltas, which
 * are real, frequent and equally uninteresting most of the time.
 */
export const LIVE_AUDIO_EVENTS: ReadonlySet<string> = new Set([
  'session.input_audio.append',
  'session.output_audio.delta',
]);

/**
 * Audio, and **WebRTC negotiates it rather than being told.**
 *
 * `session.audio.format` is a WebSocket field and WebRTC *rejects* it, so the
 * config below deliberately carries none. This number is still the contract
 * with the app: it is the rate the session runs at, and the app's audio graph
 * is pointed at it. A mismatch is not an error anywhere — it is a conversation
 * that sounds like a chipmunk.
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
 * How much prior conversation a session opens on.
 *
 * The API's own caps are 128 messages and 8,192 combined tokens, and this is
 * well inside both — **deliberately, because the live model's context window is
 * small** and the prompting guide says so in as many words. What this is for is
 * the last exchange or two: somebody typed a question, then pressed the
 * microphone to carry it on out loud. A transcript a fortnight deep seeded into
 * a voice session is money spent on context nobody is about to refer to.
 */
export const LIVE_HISTORY_MESSAGES = 12;

/**
 * How long one piece of context handed to a running session may be.
 *
 * The three append events take at most **500 tokens** of plain string, and an
 * append over that is refused — which on this surface is not an error anybody
 * sees, it is a person standing in a room hearing nothing back. So the bound is
 * set from the *worst* side rather than the average one.
 *
 * It was 1,800, from four characters to the token, which is English. Cyrillic
 * runs closer to two, so a Russian home's answer hit the cap at about half the
 * length an English one did and the refusal fell on exactly the homes least
 * likely to be testing this. Nine hundred is inside 500 tokens in either
 * script, and it is still around fifteen seconds of speech — far more than a
 * spoken answer should be, now that the backend is told it is being spoken to
 * (`assistantSystemPrompt`'s *SOMETIMES YOU ARE BEING SPOKEN TO*).
 *
 * Characters rather than tokens because nothing here counts tokens, and the
 * conservative direction is the one where a sentence is a little short.
 */
export const LIVE_APPEND_CHARS = 900;

/**
 * How long one attached sideband may live, in seconds.
 *
 * A bound rather than a policy: the session itself expires, the phone closes
 * it, or the connection drops — all three end it sooner. What the ceiling
 * stops is a socket held for ever against a session nobody told us about, on a
 * board that measures its memory in hundreds of megabytes.
 *
 * It lives here rather than in `sideband.ts` because `AssistantChat` clamps
 * what it writes into the ledger to the same figure: the sideband is what
 * reads the usage, so nothing can be billed for longer than it stayed
 * attached, and two numbers for that would eventually disagree.
 */
export const SIDEBAND_MAX_SECONDS = 60 * 60;

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
 *
 * No `audio.format`: WebRTC negotiates its own and refuses the field.
 */
export interface LiveSessionConfig {
  model: string;
  instructions: string;
  input: LiveHistoryMessage[];
  audio: { output: { voice: string } };
  delegation: { type: 'client' };
}

/** What the hub posts: the session, and the phone's own connection offer. */
export interface LiveWebRtcRequest {
  session: LiveSessionConfig;
  transport: { type: 'webrtc'; sdp: string };
}
