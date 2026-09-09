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

/** Returns the PNG bytes. Throws `PortraitDrawError` for anything else. */
export async function drawPortrait(options: DrawOptions): Promise<Buffer> {
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

  const png = firstImage(body);
  if (!png) throw new PortraitDrawError('OpenAI answered without an image.', 'refused');
  return png;
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

/** The GPT image models always answer base64; there is no `url` form to handle. */
function firstImage(body: string): Buffer | null {
  try {
    const parsed = JSON.parse(body) as { data?: Array<{ b64_json?: string }> };
    const encoded = parsed.data?.[0]?.b64_json;
    if (typeof encoded !== 'string' || encoded.length === 0) return null;
    return Buffer.from(encoded, 'base64');
  } catch {
    return null;
  }
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
