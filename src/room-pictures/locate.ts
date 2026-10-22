import { z } from 'zod';
import type { AiProvider } from '../core/settings.js';
import { classifyApiError } from '../ai/errors.js';
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
 * It runs on the provider and model the home chose for **device
 * recognition** — reading what is in a picture is recognition — on the home's
 * own key, one request, plain `fetch`. The answer is model output: parsed,
 * clamped to the picture and filtered to the devices asked about.
 */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const OPENAI_URL = 'https://api.openai.com/v1/responses';

/** Two minutes — a reading is one image and a few lines of answer. */
const TIMEOUT_MS = 2 * 60 * 1000;
const MAX_OUTPUT_TOKENS = 8_000;

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

export async function locateDevices(input: LocateInput): Promise<{ located: LocatedDevice[]; usage: TokenUsage }> {
  if (input.devices.length === 0) return { located: [], usage: {} };
  const doFetch = input.fetchImpl ?? fetch;
  const prompt = locatePrompt(input.devices);
  const base64 = input.picture.toString('base64');

  let response: Response;
  try {
    response =
      input.provider === 'openai'
        ? await doFetch(OPENAI_URL, {
            method: 'POST',
            signal: AbortSignal.timeout(TIMEOUT_MS),
            headers: { authorization: `Bearer ${input.apiKey}`, 'content-type': 'application/json' },
            body: JSON.stringify({
              model: input.modelId,
              reasoning: { effort: 'medium' },
              max_output_tokens: MAX_OUTPUT_TOKENS,
              store: false,
              input: [
                {
                  role: 'user',
                  content: [
                    { type: 'input_image', image_url: `data:image/png;base64,${base64}` },
                    { type: 'input_text', text: prompt },
                  ],
                },
              ],
              text: { format: { type: 'json_schema', name: 'device_points', schema: ANSWER_SCHEMA, strict: true } },
            }),
          })
        : await doFetch(ANTHROPIC_URL, {
            method: 'POST',
            signal: AbortSignal.timeout(TIMEOUT_MS),
            headers: {
              'x-api-key': input.apiKey,
              'anthropic-version': '2023-06-01',
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              model: input.modelId,
              max_tokens: MAX_OUTPUT_TOKENS,
              thinking: { type: 'adaptive' },
              // One answer channel, the mapper's way; `auto`, because a
              // forced tool turns thinking off.
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
                    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } },
                    { type: 'text', text: `${prompt}\n\nAnswer by calling submit_points.` },
                  ],
                },
              ],
            }),
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
  const answer = input.provider === 'openai' ? openAiAnswer(body) : anthropicAnswer(body);
  if (answer === undefined) throw new LocateError('The model answered without the devices.', 'unreadable');
  return { located: normaliseAnswer(answer, input.devices), usage: usageOf(input.provider, body) };
}

function anthropicAnswer(body: Record<string, unknown> | null): unknown {
  const content = Array.isArray(body?.['content']) ? (body['content'] as Record<string, unknown>[]) : [];
  return content.find((block) => block['type'] === 'tool_use' && block['name'] === 'submit_points')?.['input'];
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

function usageOf(provider: AiProvider, body: Record<string, unknown> | null): TokenUsage {
  const usage = (body?.['usage'] ?? {}) as Record<string, unknown>;
  const number = (value: unknown) => (typeof value === 'number' ? value : 0);
  if (provider === 'openai') {
    const details = (usage['input_tokens_details'] ?? {}) as Record<string, unknown>;
    const cached = number(details['cached_tokens']);
    return {
      input_tokens: Math.max(number(usage['input_tokens']) - cached, 0),
      output_tokens: number(usage['output_tokens']),
      cache_read_input_tokens: cached,
    };
  }
  return {
    input_tokens: number(usage['input_tokens']),
    output_tokens: number(usage['output_tokens']),
    cache_read_input_tokens: number(usage['cache_read_input_tokens']),
    cache_creation_input_tokens: number(usage['cache_creation_input_tokens']),
  };
}
