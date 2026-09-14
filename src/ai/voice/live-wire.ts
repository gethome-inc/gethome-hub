/**
 * The GPT-Live wire, and **the only place in this repository that names one of
 * its fields**.
 *
 * That is a deliberate containment rather than tidiness. This was written
 * against OpenAI's published guides for `gpt-live-1` and the model ids,
 * endpoint, audio format and event names below are what those describe — but
 * the API is weeks old and its shape is the one thing here nobody can check by
 * running the suite. So every constant and every key lives in this file, the
 * app's own `LiveWire.swift` is its mirror, and a field that turns out
 * different is one edit in one place rather than a hunt through an audio
 * pipeline. Read the guides before changing anything in it.
 *
 * **What the hub does and does not do with this.** The hub mints the ephemeral
 * secret and builds the whole session config — the instructions, the tools, the
 * voice — so the phone composes nothing and the home's OpenAI key never leaves
 * the machine that holds it. The phone then holds the audio connection itself,
 * because that is the whole point of GPT-Live: the voice layer talks directly
 * to OpenAI at conversational latency, and the reasoning is delegated back here
 * where the home is.
 */

/** The live voice model. */
export const LIVE_MODEL = 'gpt-live-1';

/** What turns the person's speech into the text a transcript row is made of. */
export const LIVE_TRANSCRIBE_MODEL = 'gpt-live-transcribe';

/** Where an ephemeral client secret is minted. */
export const CLIENT_SECRETS_URL = 'https://api.openai.com/v1/realtime/client_secrets';

/**
 * Audio, in the one format this path uses in both directions.
 *
 * 24 kHz mono PCM16 is what the API takes and returns, and the phone's
 * `AVAudioConverter` is pointed at exactly this — a mismatch is not an error
 * anywhere, it is a conversation that sounds like a chipmunk.
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

/** A tool as the live session declares it. */
export interface LiveTool {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** The session the phone is about to hold, built entirely by the hub. */
export interface LiveSessionConfig {
  type: 'realtime';
  model: string;
  instructions: string;
  audio: {
    input: {
      format: { type: 'audio/pcm'; rate: number };
      transcription: { model: string };
      /**
       * The model decides when a turn has ended rather than waiting for a
       * button, which is what makes this a conversation instead of a
       * walkie-talkie — and `interrupt_response` is what lets somebody talk
       * over an answer that has gone wrong, which is the whole of why a
       * full-duplex model is worth the trouble.
       */
      turn_detection: { type: 'semantic_vad'; interrupt_response: true };
    };
    output: { format: { type: 'audio/pcm'; rate: number }; voice: string };
  };
  tools: LiveTool[];
}

/** What the mint answers with, and all the phone is ever handed. */
export interface LiveClientSecret {
  /** An `ek_…` value. Not the home's key, and it expires. */
  value: string;
  /** When it stops working, as an ISO instant. */
  expiresAt: string;
}

/**
 * The one tool that is not a tool the assistant already has.
 *
 * **This is the delegation**, and it is the whole reason the model choice still
 * means something once somebody starts talking: GPT-Live handles the listening
 * and the speaking, and anything that needs working out is handed to the
 * agent on this hub running whatever model the home picked. Everything else in
 * the catalog is there so the *fast* things stay fast — switching a lamp is one
 * LAN hop, not a round with a reasoning model.
 *
 * Its description is written for the model and is the only thing it knows about
 * the arrangement, so it says what to hand over **and what not to**: a tool
 * call that could have been `control_device` costs seconds somebody is standing
 * there for.
 */
export const ASK_HOME_TOOL: LiveTool = {
  type: 'function',
  name: 'ask_home',
  description:
    'Hand a question or a job to the assistant on this home’s hub, which thinks harder than you ' +
    'do and can do anything you cannot. Use it for anything that needs working out — "make it ' +
    'cosy in here", "why did the hall light come on", "what is using the most power" — and for ' +
    'anything about automations, schedules or rules, which only it can write. Do NOT use it for ' +
    'something you can already do: switching, dimming, setting a colour, running a scene and ' +
    'reading the home are yours, and they happen in a moment where this takes a few seconds. ' +
    'Say what you are doing while you wait — you can keep talking and listening the whole time. ' +
    'Write `question` as one self-contained message in the person’s own words.',
  parameters: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'The whole request, in one self-contained message.',
      },
    },
    required: ['question'],
    additionalProperties: false,
  },
};
