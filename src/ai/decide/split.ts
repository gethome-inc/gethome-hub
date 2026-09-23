/**
 * Splitting one sentence into the separate requests in it — the one step of
 * the fast path a decision model cannot take, because it is writing.
 *
 * **This is the vendor's own smart-home demo, step for step.** A noul asks
 * whether the sentence holds more than one request; when it does, a
 * generative model splits it into atomic requests, and those go back to the
 * decision model to be read one by one — all in one more request
 * (`decideParts`). So "turn off the TV and close the blinds" is two commands
 * carried out before the conversation's model has been asked anything, and
 * "turn off the light and what's the temperature?" is one command carried out
 * and one question left for the model to answer.
 *
 * Four things keep it small:
 *
 * - **The home's own model, on the home's own key.** The split runs on what
 *   the assistant runs on — the owner chose that model and pays for it, and a
 *   second vendor or a model nobody picked would be a cost the settings page
 *   never mentions. At the lowest effort, since the job is a sentence.
 * - **Structured output.** The answer is a JSON list under a schema, never
 *   prose to be parsed, and it is checked again here: a part that is empty or
 *   runs long, or more parts than `MAX_PARTS`, and the split is refused.
 * - **One short deadline, no retry.** It sits in front of somebody waiting,
 *   the reason `lazy.ts` gives for having no retry either. A split that fails
 *   sends the sentence to the ordinary round whole — the hub before any of
 *   this.
 * - **Nothing it writes is acted on unread.** Every part is read by the
 *   decision model and must clear every bar a sentence does; a part it is
 *   unsure of is left for the conversation's model, which also sees the whole
 *   sentence as it was said.
 *
 * `docs/jev.md` is canonical.
 */
import type { AiProvider } from '../../core/settings.js';
import type { Logger } from '../../logging.js';
import { estimateCostUsd } from '../models.js';
import { MAX_PARTS } from './questions.js';

/** How long a split may take before the sentence goes to the model whole. */
export const SPLIT_TIMEOUT_MS = 6_000;

/** The longest one part may be. A "part" longer than this is not an atomic request. */
const MAX_PART_CHARS = 300;

/**
 * Room for the answer — a handful of short strings — with a wide margin. On
 * OpenAI it also covers the little reasoning a lowest-effort round does, which
 * is billed as output and counted against this.
 */
const SPLIT_MAX_TOKENS = 2_048;

const RESPONSES_URL = 'https://api.openai.com/v1/responses';

/**
 * What the model is told.
 *
 * Its whole job is to rewrite one sentence as a list, so everything here is
 * about fidelity: their words and their language, nothing added, nothing
 * dropped, nothing answered. The one liberty it is given is the one a part
 * needs to stand on its own — carrying the verb and the place across, so "the
 * hall one" becomes "turn off the hall light". A group stays one request,
 * which is what `multipleQuestion` also says, so the two cannot disagree about
 * "all the lights in the kitchen".
 */
export const SPLIT_SYSTEM_PROMPT = [
  'You split a message somebody said to the assistant in their smart home into the separate',
  'requests it holds.',
  '',
  'Return each separate request as one item of `parts`, in the order they were said, each written',
  'so it makes sense on its own: carry the verb and the place across, so "turn off the kitchen',
  'light and the hall one" becomes "turn off the kitchen light" and "turn off the hall light".',
  '',
  'Keep their words and their language. Do not add anything they did not ask for, do not drop',
  'anything, do not merge requests, and do not answer or change any of them — a question stays a',
  'question.',
  '',
  'A request about every device of one kind in one place is one request: "turn off all the lights',
  'in the kitchen" stays whole.',
  '',
  `If it is really one request, return it unchanged as the only item. If it holds more than ${MAX_PARTS}`,
  'requests, return the whole message unchanged as the only item.',
].join('\n');

/** The answer's shape — the same schema for both vendors. */
const PARTS_SCHEMA = {
  type: 'object',
  properties: { parts: { type: 'array', items: { type: 'string' } } },
  required: ['parts'],
  additionalProperties: false,
} as const;

export interface SplitInput {
  provider: AiProvider;
  modelId: string;
  secret: string;
  said: string;
  log: Logger;
  timeoutMs?: number;
  /** What carries the request. The global `fetch` unless a test hands in its own. */
  fetch?: typeof fetch;
}

export interface SplitResult {
  parts: string[];
  costUsd: number;
  durationMs: number;
}

/**
 * The parts, checked — or null when the answer is not a split this path will
 * read. Refused rather than repaired: a part cut short or a list with a fifth
 * request in it is a different sentence from the one somebody said.
 */
export function checkParts(raw: unknown): string[] | null {
  if (raw === null || typeof raw !== 'object') return null;
  const parts = (raw as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return null;
  const cleaned = parts.map((part) => (typeof part === 'string' ? part.trim() : ''));
  if (cleaned.length === 0 || cleaned.length > MAX_PARTS) return null;
  if (cleaned.some((part) => part === '' || part.length > MAX_PART_CHARS)) return null;
  return cleaned;
}

/**
 * Split one sentence. **Never throws**: null means "read it whole", which is
 * what the hub does anyway.
 */
export async function splitRequest(input: SplitInput): Promise<SplitResult | null> {
  const started = Date.now();
  const timeoutMs = input.timeoutMs ?? SPLIT_TIMEOUT_MS;
  try {
    const answered =
      input.provider === 'anthropic'
        ? await viaAnthropic(input, timeoutMs)
        : await viaOpenAi(input, timeoutMs);
    if (answered === null) return null;
    const parts = checkParts(answered.json);
    if (parts === null) {
      input.log.info({ answer: answered.json }, 'the split came back in a shape the hub will not read');
      return null;
    }
    return { parts, costUsd: answered.costUsd, durationMs: Date.now() - started };
  } catch (error) {
    input.log.warn({ err: error, provider: input.provider }, 'could not split a request — reading it whole');
    return null;
  }
}

/** One JSON answer and what it cost, from either vendor. */
interface Answered {
  json: unknown;
  costUsd: number;
}

async function viaAnthropic(input: SplitInput, timeoutMs: number): Promise<Answered | null> {
  // Imported here rather than at the top, the `lazy.ts` seam: a home on
  // OpenAI never loads the Anthropic client to split a sentence.
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({
    apiKey: input.secret,
    // No retry, for the reason this module gives: somebody is waiting.
    maxRetries: 0,
    timeout: timeoutMs,
    ...(input.fetch !== undefined ? { fetch: input.fetch } : {}),
  });
  const response = await client.messages.create({
    model: input.modelId,
    max_tokens: SPLIT_MAX_TOKENS,
    system: SPLIT_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: input.said }],
    // A rewrite, not a problem to work out: every token of thinking would be
    // a moment somebody waits for their lights with nothing to show for it.
    thinking: { type: 'disabled' },
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: PARTS_SCHEMA as unknown as Record<string, unknown> },
    },
  });
  const costUsd = estimateCostUsd(input.modelId, response.usage);
  if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') return null;
  const text = response.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
    .trim();
  if (text === '') return null;
  return { json: JSON.parse(text) as unknown, costUsd };
}

interface ResponsesBody {
  status?: unknown;
  output?: { type?: unknown; content?: { type?: unknown; text?: unknown }[] }[];
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
}

async function viaOpenAi(input: SplitInput, timeoutMs: number): Promise<Answered | null> {
  // Plain `fetch`, the decision `openai-transport.ts` made: no second SDK for a
  // Pi to download.
  const send = input.fetch ?? fetch;
  const response = await send(RESPONSES_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${input.secret}`, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model: input.modelId,
      instructions: SPLIT_SYSTEM_PROMPT,
      input: input.said,
      reasoning: { effort: 'low' },
      text: { format: { type: 'json_schema', name: 'parts', schema: PARTS_SCHEMA, strict: true } },
      max_output_tokens: SPLIT_MAX_TOKENS,
      store: false,
    }),
  });
  if (!response.ok) {
    input.log.warn({ status: response.status }, 'OpenAI refused to split a request');
    return null;
  }
  const body = (await response.json()) as ResponsesBody;
  const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  const costUsd = estimateCostUsd(input.modelId, {
    input_tokens: number(body.usage?.input_tokens),
    output_tokens: number(body.usage?.output_tokens),
  });
  if (body.status !== undefined && body.status !== 'completed') return null;
  const text = (body.output ?? [])
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content ?? [])
    .map((part) => (part.type === 'output_text' && typeof part.text === 'string' ? part.text : ''))
    .join('')
    .trim();
  if (text === '') return null;
  return { json: JSON.parse(text) as unknown, costUsd };
}
