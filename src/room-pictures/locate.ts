import type Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AiProvider } from '../core/settings.js';
import { callsIn, replyCostUsd, withFallbacks } from '../ai/anthropic-fallback.js';
import { classifyApiError, readableFailure } from '../ai/errors.js';
import type { TokenUsage } from '../ai/models.js';
import { locatePrompt, type PictureDevice } from './prompts.js';

/**
 * Where each device stands in a room's picture.
 *
 * **Read off the picture, not projected onto it.** The picture is drawn from
 * photos, so the only thing that knows where the lamp ended up is the picture:
 * a vision model is shown it with the room's devices by name and answers a
 * point for each — on the device where it is drawn, on what it works where it
 * is a plug, and where it would plausibly be otherwise. People correct what it
 * gets wrong by dragging (`PATCH /room-pictures/:id`), and a point somebody
 * placed is never read over.
 *
 * It runs on the provider the home chose for **device recognition**, on the
 * home's own key — reading what is in a picture is recognition — but at that
 * provider's middle rung (`LOCATOR_MODELS`: Sonnet 5.5, GPT-6.1 Terra) rather
 * than on recognition's own model, which is strong-only for a mapping's sake;
 * `store.ts`'s `homeLocator` makes the choice. One request: OpenAI's over plain
 * `fetch`, as everything of that vendor's here is, and Anthropic's through its
 * SDK (`askAnthropic`). The answer is model output: parsed, clamped to the
 * picture and filtered to the devices asked about.
 */

const OPENAI_URL = 'https://api.openai.com/v1/responses';

/** Two minutes — a reading is one image and a few lines of answer. */
const TIMEOUT_MS = 2 * 60 * 1000;
const MAX_OUTPUT_TOKENS = 8_000;
/**
 * How hard the model looks, the same word on both vendors. Said rather than
 * left to each model's default, which is not the same everywhere — Sonnet 5.5
 * defaults higher than GPT-6.1 Terra — and a reading has an
 * eight-thousand-token reply and a two-minute deadline to fit its thinking
 * into.
 */
const EFFORT = 'medium';
/** Bytes of picture per piece of base64: a multiple of three, so the pieces join without padding. */
const PIECE = 48 * 1024;

export class LocateError extends Error {
  constructor(
    message: string,
    readonly kind: string,
  ) {
    super(message);
    this.name = 'LocateError';
  }
}

/** One device's point, as a fraction of the picture's width and height. */
export interface LocatedDevice {
  deviceId: string;
  x: number;
  y: number;
  /** Whether the device itself is drawn, or the point is the model's guess. */
  seen: boolean;
}

export interface LocateInput {
  provider: AiProvider;
  modelId: string;
  apiKey: string;
  picture: Buffer;
  devices: PictureDevice[];
  fetchImpl?: typeof fetch;
}

const ANSWER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['devices'],
  properties: {
    devices: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'x', 'y', 'seen'],
        properties: {
          id: { type: 'string' },
          x: { type: 'number', description: 'Fraction of the image width, 0 at the left.' },
          y: { type: 'number', description: 'Fraction of the image height, 0 at the top.' },
          seen: { type: 'boolean' },
        },
      },
    },
  },
} as const;

/** The model's answer made safe: devices asked about only, once each, inside the picture. */
export function normaliseAnswer(raw: unknown, devices: PictureDevice[]): LocatedDevice[] {
  const parsed = z.object({ devices: z.array(z.unknown()).max(400) }).safeParse(raw);
  if (!parsed.success) throw new LocateError('The answer was not a list of devices.', 'unreadable');
  const wanted = new Set(devices.map((device) => device.id));
  const found = new Map<string, LocatedDevice>();
  for (const candidate of parsed.data.devices) {
    const entry = z
      .object({ id: z.string(), x: z.number(), y: z.number(), seen: z.boolean().catch(false) })
      .safeParse(candidate);
    if (!entry.success || !wanted.has(entry.data.id) || found.has(entry.data.id)) continue;
    const clamp = (value: number) => Math.round(Math.min(0.98, Math.max(0.02, value)) * 10_000) / 10_000;
    found.set(entry.data.id, {
      deviceId: entry.data.id,
      x: clamp(entry.data.x),
      y: clamp(entry.data.y),
      seen: entry.data.seen,
    });
  }
  return [...found.values()];
}

/** A reading, and what it cost. */
export interface Located {
  located: LocatedDevice[];
  usage: TokenUsage;
  /**
   * What the reading cost, where `usage` alone cannot say it: a reading
   * another Claude answered after the one asked declined it bills each attempt
   * at its own model's rates (`replyCostUsd`). Absent means `usage` at the
   * reading model's price is the whole of it.
   */
  costUsd?: number;
}

export async function locateDevices(input: LocateInput): Promise<Located> {
  if (input.devices.length === 0) return { located: [], usage: {} };
  const prompt = locatePrompt(input.devices);
  const { answer, usage, costUsd } =
    input.provider === 'openai' ? await askOpenAi(input, prompt) : await askAnthropic(input, prompt);
  if (answer === undefined) throw new LocateError('The model answered without the devices.', 'unreadable');
  return {
    located: normaliseAnswer(answer, input.devices),
    usage,
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

/** What either vendor answered: the points, unparsed, and what they cost. */
interface Asked {
  answer: unknown;
  usage: TokenUsage;
  costUsd?: number;
}

async function askOpenAi(input: LocateInput, prompt: string): Promise<Asked> {
  const doFetch = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(OPENAI_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { authorization: `Bearer ${input.apiKey}`, 'content-type': 'application/json' },
      body: withPicture(input.picture, (picture) => ({
        model: input.modelId,
        reasoning: { effort: EFFORT },
        max_output_tokens: MAX_OUTPUT_TOKENS,
        store: false,
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_image', image_url: `data:image/png;base64,${picture}` },
              { type: 'input_text', text: prompt },
            ],
          },
        ],
        text: { format: { type: 'json_schema', name: 'device_points', schema: ANSWER_SCHEMA, strict: true } },
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new LocateError(message, classifyApiError(error)?.kind ?? 'network');
  }

  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    const error = body?.['error'] as { message?: unknown } | undefined;
    const detail = typeof error?.message === 'string' ? error.message : `The provider answered ${response.status}.`;
    throw new LocateError(detail, classifyApiError({ status: response.status, message: detail })?.kind ?? 'refused');
  }
  return { answer: openAiAnswer(body), usage: openAiUsage(body) };
}

/**
 * Anthropic's half, through the SDK — loaded here and only here, so a home
 * whose recognition runs on OpenAI never brings it into memory, the rule
 * `chat/transport.ts` keeps for the conversations.
 *
 * **The SDK rather than a hand-built request, for what it does that one
 * `fetch` did not**: it retries a 429, a 529 and a dropped connection with
 * backoff, waiting as long as `retry-after` asks. A single attempt left a room
 * drawn and paid for with no device on it the first time the API was busy,
 * and nothing tries again until somebody draws the room again.
 *
 * **And a reading the model declines is asked again of another Claude in the
 * same request** (`fallbacks: 'default'`, `anthropic-fallback.ts`): a picture
 * of a room with a camera, a lock and an alarm panel in it is the kind the
 * classifiers can read as security work. Not streamed, so a decline part way
 * through comes back without its partial at all — only the answering model's
 * call is read, and each attempt is priced at its own model's rates.
 *
 * **The body is the same Blob the OpenAI half sends** (`withPicture`), handed
 * to the client's own `post` rather than to `messages.create`, which would
 * build the request out of one base64 string and serialise it into a second.
 * The client sends a `Blob` as it is and retries with it — a Blob reads again
 * — so the reading keeps the SDK's retries and the 512 MB board keeps its one
 * copy of the picture. What the typed method would have said by itself is
 * said here instead: the beta goes as the `anthropic-beta` header the SDK
 * builds from `betas`, and the answer is the same `BetaMessage`.
 */
async function askAnthropic(input: LocateInput, prompt: string): Promise<Asked> {
  const { default: AnthropicClient } = await import('@anthropic-ai/sdk');
  const client = new AnthropicClient({
    apiKey: input.apiKey,
    maxRetries: 2,
    ...(input.fetchImpl !== undefined ? { fetch: input.fetchImpl } : {}),
  });

  let message: Anthropic.Beta.BetaMessage;
  try {
    // Sent once more without the fallback, should the API stop taking it.
    message = await withFallbacks(input.modelId, ({ betas, ...fallbacks }) =>
      client.post<Anthropic.Beta.BetaMessage>('/v1/messages', {
        body: withPicture(input.picture, (picture) => ({
          model: input.modelId,
          max_tokens: MAX_OUTPUT_TOKENS,
          thinking: { type: 'adaptive' },
          output_config: { effort: EFFORT },
          // One answer channel, the mapper's way; `auto`, because the models
          // this runs on refuse a forced tool outright.
          tools: [
            {
              name: 'submit_points',
              description: 'Answer with a point for every device. Call this exactly once.',
              input_schema: ANSWER_SCHEMA,
            },
          ],
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: picture } },
                { type: 'text', text: `${prompt}\n\nAnswer by calling submit_points.` },
              ],
            },
          ],
          ...fallbacks,
        })),
        headers: {
          'content-type': 'application/json',
          ...(betas !== undefined ? { 'anthropic-beta': betas.join(',') } : {}),
        },
        // One deadline for the whole reading, the retries included.
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }),
    );
  } catch (error) {
    // The SDK's message is the status with the whole response body glued to
    // it; the run log wants the sentence inside.
    const status = (error as { status?: unknown }).status;
    throw new LocateError(
      readableFailure(error),
      classifyApiError(error)?.kind ?? (typeof status === 'number' ? 'refused' : 'network'),
    );
  }

  // **Both stops that leave an answer untrustworthy are asked about before the
  // answer is read.** A refusal can arrive part way through, and its output is
  // to be discarded; a reply cut off at `max_tokens` can carry a call cut off
  // half way through its input, which still parses — as fewer devices, or a
  // number with digits missing — and would be drawn as if it were the reading.
  if (message?.stop_reason === 'refusal') {
    throw new LocateError('The model declined to read the picture.', 'refused');
  }
  if (message?.stop_reason === 'max_tokens') {
    throw new LocateError('The answer was cut off before every device was placed.', 'unreadable');
  }

  // The answering model's call — after a hand-over, never the declined one's.
  // Read defensively: the client's own `post` hands back whatever parsed, and a
  // body that is not a message is an answer with no devices in it, not a crash.
  const content = Array.isArray(message?.content) ? message.content : [];
  const call = callsIn(content).find((block) => block.name === 'submit_points');
  const usage = message?.usage;
  return {
    answer: call?.input,
    usage: {
      input_tokens: usage?.input_tokens ?? 0,
      output_tokens: usage?.output_tokens ?? 0,
      cache_read_input_tokens: usage?.cache_read_input_tokens ?? null,
      cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? null,
    },
    costUsd: replyCostUsd(input.modelId, usage),
  };
}

/**
 * A JSON request body with the picture in it as base64, built as a Blob.
 *
 * **The picture is never one string.** A day picture is ~2.3 MB of PNG and
 * ~3 MB of base64, and written the obvious way — `toString('base64')`, into a
 * data URL, into `JSON.stringify`, into the bytes `fetch` sends — that was four
 * 3 MB copies at once, the strings among them too big for V8's young
 * generation and so kept until the next full collection: on a 512 MB board,
 * where the hub runs ~15 MB under its `MemoryHigh`, most of the margin. So the
 * JSON is written around a placeholder and the picture goes in between as
 * base64 in pieces: the Blob holds the one copy `fetch` streams, and no string
 * is bigger than a piece. `payload` is handed the placeholder where the base64
 * belongs.
 */
function withPicture(picture: Buffer, payload: (slot: string) => unknown): Blob {
  const slot = `picture-${randomUUID()}`;
  const [head = '', tail = ''] = JSON.stringify(payload(slot)).split(slot);
  const parts = [head];
  for (let at = 0; at < picture.length; at += PIECE) parts.push(picture.subarray(at, at + PIECE).toString('base64'));
  parts.push(tail);
  return new Blob(parts, { type: 'application/json' });
}

function openAiAnswer(body: Record<string, unknown> | null): unknown {
  const output = Array.isArray(body?.['output']) ? (body['output'] as Record<string, unknown>[]) : [];
  for (const item of output) {
    if (item['type'] !== 'message' || !Array.isArray(item['content'])) continue;
    for (const part of item['content'] as Record<string, unknown>[]) {
      if (part['type'] === 'output_text' && typeof part['text'] === 'string') {
        try {
          return JSON.parse(part['text']);
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

function openAiUsage(body: Record<string, unknown> | null): TokenUsage {
  const usage = (body?.['usage'] ?? {}) as Record<string, unknown>;
  const number = (value: unknown) => (typeof value === 'number' ? value : 0);
  const details = (usage['input_tokens_details'] ?? {}) as Record<string, unknown>;
  const cached = number(details['cached_tokens']);
  return {
    input_tokens: Math.max(number(usage['input_tokens']) - cached, 0),
    output_tokens: number(usage['output_tokens']),
    cache_read_input_tokens: cached,
  };
}
