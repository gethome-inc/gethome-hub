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
 * **`gpt-image-2` is pinned.** Its transparent-background support is currently
 * preview, but a transparent cut-out is the whole point: the apps float the
 * object over their own glow and contact shadow, so a baked-in white square
 * would be a grey slab on the page. If OpenAI changes that preview capability,
 * the request fails with the provider's own message rather than silently
 * returning a boxed image.
 */

import { classifyApiError } from '../ai/errors.js';

export const PORTRAIT_MODEL = 'gpt-image-2';

/** Square, because every surface that draws a portrait draws it in a square. */
const SIZE = '1024x1024';
const QUALITY = 'high';

const GENERATIONS_URL = 'https://api.openai.com/v1/images/generations';
const EDITS_URL = 'https://api.openai.com/v1/images/edits';

/**
 * Generous: an image is a single request that genuinely takes tens of seconds,
 * and the app is holding its own request open behind this one.
 */
const TIMEOUT_MS = 3 * 60 * 1000;

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
