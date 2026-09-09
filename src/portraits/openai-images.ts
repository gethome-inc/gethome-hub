/**
 * The one call that draws a device portrait: OpenAI's Image API, over plain
 * HTTP.
 *
 * **No SDK on purpose.** The hub ships `dist/` plus its production
 * `node_modules` to a Raspberry Pi, and this is two endpoints and one response
 * field — the same reasoning that keeps the GitHub update check and the
 * installer's health poll on `fetch`. The Anthropic SDK earns its place by
 * handing back typed content blocks for a forty-turn tool loop; nothing here
 * needs that.
 *
 * **`gpt-image-2.5-flare` is pinned, and moving off `gpt-image-2` cost nothing
 * at the wire.** Same two endpoints, same fields, same base64 answer: 2.5 kept
 * the Image API's shape, so the migration is a model id plus a re-read of the
 * three facts that hang off it (transparency, format, quality). What changes is
 * the wait — Flare is the small, fast half of the 2.5 pair and draws in a
 * fraction of `gpt-image-2`'s time, which on a surface where somebody watches an
 * orb is the whole reason to move. The other half, `gpt-image-2.5-sunburst`, is
 * the quality tier and is deliberately **not** taken: a portrait here is one
 * matte object on a transparent ground in a fixed palette, drawn at card size by
 * every surface that shows it, so the tier that spends longer would spend it on
 * detail this render throws away.
 *
 * **A transparent cut-out is still the whole point** — the apps float the object
 * over their own glow and contact shadow, so a baked-in white square would be a
 * grey slab on the page. Both 2.5 models support `transparent` outright rather
 * than in preview, which is what makes this pin ordinary rather than a bet on a
 * capability that might be withdrawn; if it ever is, the request fails with the
 * provider's own message rather than silently returning a boxed image.
 */

import { classifyApiError } from '../ai/errors.js';

export const PORTRAIT_MODEL = 'gpt-image-2.5-flare';

/** Square, because every surface that draws a portrait draws it in a square. */
const SIZE = '1024x1024';

/**
 * 2.5 widened this to `low | medium | high | xhigh | max`, and `high` stays.
 *
 * Two reasons, and neither is thrift alone. OpenAI's own guidance puts a
 * transparent background at its best at medium or high, so the tiers above it
 * are not free of risk on the one capability this whole path exists for. And
 * the point of moving to Flare was the wait: spending the time it saves on
 * detail nobody can see on a device tile would be the migration undoing itself.
 */
const QUALITY = 'high';

/**
 * Asked for rather than assumed, because two things downstream depend on it and
 * neither would say so if it changed. `background: transparent` is honoured
 * only on an alpha-capable format — JPEG is refused outright — and the store
 * writes these bytes to `<id>.png` while the route serves them as `image/png`.
 * PNG is the current default, which is exactly the kind of fact that moves
 * under a model pin without anybody noticing.
 */
const OUTPUT_FORMAT = 'png';

const GENERATIONS_URL = 'https://api.openai.com/v1/images/generations';
const EDITS_URL = 'https://api.openai.com/v1/images/edits';

/**
 * Ten minutes, and the number comes from this hub rather than from the web.
 *
 * The published figures disagree wildly and both extremes are misleading.
 * OpenAI's own latency guidance says 30–45 s with a complex prompt "close to
 * two minutes"; blog posts measuring reseller proxies and small Azure quotas
 * report three to five, which is mostly their queue. **What a real GetHome hub
 * does is two to five minutes** — measured here, on this prompt, at
 * `quality: high` with a transparent background and a photo to restyle, which
 * is a heavier request than any benchmark runs.
 *
 * So the deadline is sized from the observation, not from either source: about
 * twice the slowest run seen. Anything tighter kills a drawing the provider is
 * still working on and has already billed — which is exactly what a four-minute
 * deadline would have done, and why this note now records where the number
 * came from.
 *
 * **That measurement is `gpt-image-2`'s, and the deadline is deliberately kept
 * as it is.** Flare draws in a fraction of that time, so ten minutes went from
 * merely safe to generous — which is the right direction for a ceiling nobody
 * should ever reach. Re-measure before tightening it: the figure above was
 * earned on this prompt, at this quality, with a photo to restyle, and nothing
 * here has been timed on the new model yet.
 */
const TIMEOUT_MS = 10 * 60 * 1000;

/** Something the caller can put on screen, with the vendor's own words in it. */
export class PortraitDrawError extends Error {
  constructor(
    message: string,
    /** `auth_failed` | `rate_limited` | `billing` | `overloaded` | `network` | `refused`. */
    readonly kind: string,
  ) {
    super(message);
    this.name = 'PortraitDrawError';
  }
}

export interface DrawOptions {
  apiKey: string;
  prompt: string;
  /** A photo to restyle. Absent means draw from the prompt alone. */
  photo?: { bytes: Buffer; contentType: string };
  signal?: AbortSignal;
}

/**
 * What the provider says one drawing consumed. Absent when it said nothing —
 * see `portraitCostUsd`, which answers `undefined` rather than `0` for that.
 */
export interface PortraitUsage {
  /** The prompt. */
  inputTextTokens: number;
  /** A reference photo, tokenised — zero on the generate path. */
  inputImageTokens: number;
  /** The picture itself, which is nearly all of the bill. */
  outputTokens: number;
}

export interface PortraitDrawing {
  png: Buffer;
  usage?: PortraitUsage;
}

/**
 * What the pinned model charges, in USD per million tokens.
 *
 * **It lives here rather than in `src/ai/models.ts` because it is a fact about
 * `PORTRAIT_MODEL`,** and the two have to move together: that file's `PRICING`
 * is the mapping agent's model list and carries two rates, while an image model
 * bills three — a reference photo is tokenised at the dearer image rate, which
 * is why the edit path costs more on the input side than the generate path.
 *
 * Output dominates: a 1024² render is thousands of output tokens against a
 * prompt of a few hundred, so an input rate that is a little wrong barely moves
 * the total while a missing output rate would be the whole of it.
 */
const PRICE_PER_MTOK = { textInput: 5, imageInput: 8, imageOutput: 30 } as const;

/**
 * What a drawing cost, or **`undefined` when the provider did not say**.
 *
 * Never `0`: this is `ai_runs`' own rule about a chat whose spend row has been
 * pruned — `$0.00` is a claim, and "nothing was reported" is the truth. A hub
 * meeting a response shape that carries no `usage` records a run with a
 * duration and no price rather than a free one.
 */
export function portraitCostUsd(usage: PortraitUsage | undefined): number | undefined {
  if (!usage) return undefined;
  return (
    (usage.inputTextTokens * PRICE_PER_MTOK.textInput +
      usage.inputImageTokens * PRICE_PER_MTOK.imageInput +
      usage.outputTokens * PRICE_PER_MTOK.imageOutput) /
    1_000_000
  );
}

/** Returns the PNG bytes and what the provider billed. Throws `PortraitDrawError` otherwise. */
export async function drawPortrait(options: DrawOptions): Promise<PortraitDrawing> {
  const abort = AbortSignal.timeout(TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, abort]) : abort;
  const request: RequestInit = options.photo
    ? { method: 'POST', body: editForm(options.prompt, options.photo) }
    : {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: PORTRAIT_MODEL,
          prompt: options.prompt,
          size: SIZE,
          n: 1,
          background: 'transparent',
          output_format: OUTPUT_FORMAT,
          quality: QUALITY,
        }),
      };

  let response: Response;
  try {
    response = await fetch(options.photo ? EDITS_URL : GENERATIONS_URL, {
      ...request,
      headers: { ...(request.headers as Record<string, string>), authorization: `Bearer ${options.apiKey}` },
      signal,
    });
  } catch (error) {
    // A refused DNS lookup, a hub with no route out, or our own deadline.
    throw new PortraitDrawError(
      error instanceof Error && error.name === 'TimeoutError'
        ? 'OpenAI took too long to answer.'
        : `Could not reach OpenAI: ${error instanceof Error ? error.message : String(error)}`,
      'network',
    );
  }

  const body = await response.text();
  if (!response.ok) {
    const detail = messageIn(body) ?? `OpenAI answered ${response.status}.`;
    // Reuse the mapper's classifier: it branches on HTTP status rather than on
    // any vendor's error vocabulary, which is exactly why it is structural.
    const kind = classifyApiError({ status: response.status, message: detail })?.kind ?? 'refused';
    throw new PortraitDrawError(detail, kind);
  }

  const drawing = readDrawing(body);
  if (!drawing) throw new PortraitDrawError('OpenAI answered without an image.', 'refused');
  return drawing;
}

function editForm(prompt: string, photo: { bytes: Buffer; contentType: string }): FormData {
  const form = new FormData();
  form.set('model', PORTRAIT_MODEL);
  form.set('prompt', prompt);
  form.set('size', SIZE);
  form.set('n', '1');
  form.set('background', 'transparent');
  form.set('output_format', OUTPUT_FORMAT);
  form.set('quality', QUALITY);
  form.set(
    'image',
    new Blob([new Uint8Array(photo.bytes)], { type: photo.contentType }),
    photo.contentType === 'image/png' ? 'device.png' : 'device.jpg',
  );
  return form;
}

/**
 * The GPT image models always answer base64; there is no `url` form to handle.
 *
 * `usage` rides on the same response and used to be thrown away with the rest
 * of it, which is why a portrait was the one thing the home spent money on with
 * no price against it. It is read defensively — the picture is the point, and a
 * response whose accounting moves must still yield a portrait.
 */
function readDrawing(body: string): PortraitDrawing | null {
  try {
    const parsed = JSON.parse(body) as {
      data?: Array<{ b64_json?: string }>;
      usage?: {
        input_tokens?: unknown;
        output_tokens?: unknown;
        input_tokens_details?: { text_tokens?: unknown; image_tokens?: unknown };
      };
    };
    const encoded = parsed.data?.[0]?.b64_json;
    if (typeof encoded !== 'string' || encoded.length === 0) return null;
    const png = Buffer.from(encoded, 'base64');
    const usage = readUsage(parsed.usage);
    return usage ? { png, usage } : { png };
  } catch {
    return null;
  }
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * The breakdown when it is there, and the **dearer** reading when it is not.
 *
 * `input_tokens_details` splits the prompt from a reference photo, and without
 * it there is no way to tell them apart — so the whole input is priced at the
 * image rate. That is deliberately the direction `mostExpensive()` picks in
 * `models.ts`: an estimate that reads low is the one that surprises somebody.
 */
function readUsage(raw: {
  input_tokens?: unknown;
  output_tokens?: unknown;
  input_tokens_details?: { text_tokens?: unknown; image_tokens?: unknown };
} | undefined): PortraitUsage | undefined {
  if (!raw) return undefined;
  const output = count(raw.output_tokens);
  if (output === undefined) return undefined;
  const text = count(raw.input_tokens_details?.text_tokens);
  const image = count(raw.input_tokens_details?.image_tokens);
  if (text !== undefined || image !== undefined) {
    return { inputTextTokens: text ?? 0, inputImageTokens: image ?? 0, outputTokens: output };
  }
  const input = count(raw.input_tokens) ?? 0;
  return { inputTextTokens: 0, inputImageTokens: input, outputTokens: output };
}

/** OpenAI's own sentence, which is always better than one written here. */
function messageIn(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    const message = parsed.error?.message;
    return typeof message === 'string' && message.length > 0 ? message.slice(0, 400) : null;
  } catch {
    return null;
  }
}
