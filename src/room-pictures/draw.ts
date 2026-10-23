import { classifyApiError } from '../ai/errors.js';

/**
 * The one call that draws a room: OpenAI’s Image API, over plain HTTP, with
 * the photos of the room in and one picture out.
 *
 * **`gpt-image-2.5-sunburst`, the quality half of the 2.5 pair**, where the
 * portraits take Flare. A portrait is one object at card size; a room is the
 * whole screen and a dozen things in it, with curtains, a hob and the magnets
 * on a fridge that the person who lives there will look for. Both bill the
 * same per token, and Sunburst takes about half a minute more — on a surface
 * that is drawn once and looked at every day, that is the trade to make.
 *
 * **No SDK**, for the portraits' reason: one endpoint and one response field.
 */

export const ROOM_PICTURE_MODEL = 'gpt-image-2.5-sunburst';

const EDITS_URL = 'https://api.openai.com/v1/images/edits';

/**
 * Ten minutes, the portraits' ceiling. A room has measured at about half a
 * minute here; the deadline is a ceiling nobody should reach, kept generous
 * because a drawing cut off is one the provider has already billed.
 */
const TIMEOUT_MS = 10 * 60 * 1000;

/** USD per million tokens — the 2.5 pair's shared rates. */
const PRICE_PER_MTOK = { textInput: 5, imageInput: 8, imageOutput: 30 } as const;

export class RoomPictureDrawError extends Error {
  constructor(
    message: string,
    /** `auth_failed` | `rate_limited` | `billing` | `overloaded` | `network` | `refused`. */
    readonly kind: string,
  ) {
    super(message);
    this.name = 'RoomPictureDrawError';
  }
}

export interface PictureUsage {
  inputTextTokens: number;
  inputImageTokens: number;
  outputTokens: number;
}

export interface Drawing {
  png: Buffer;
  usage?: PictureUsage;
}

export interface EditInput {
  apiKey: string;
  prompt: string;
  /** In the order the prompt names them. */
  images: { bytes: Buffer; contentType: string }[];
  size: '1024x1536' | '1536x1024';
  background: 'transparent' | 'opaque';
  signal?: AbortSignal;
  /** For tests. */
  fetchImpl?: typeof fetch;
}

export async function drawRoomPicture(input: EditInput): Promise<Drawing> {
  const form = new FormData();
  form.set('model', ROOM_PICTURE_MODEL);
  form.set('prompt', input.prompt);
  form.set('size', input.size);
  form.set('n', '1');
  form.set('quality', 'high');
  form.set('background', input.background);
  form.set('output_format', 'png');
  input.images.forEach((image, index) => {
    const extension = image.contentType === 'image/png' ? 'png' : 'jpg';
    form.append('image[]', new Blob([new Uint8Array(image.bytes)], { type: image.contentType }), `image${index}.${extension}`);
  });

  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(EDITS_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${input.apiKey}` },
      body: form,
      signal: input.signal ?? AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RoomPictureDrawError(message, classifyApiError(error)?.kind ?? 'network');
  }

  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    const error = body?.['error'] as { message?: unknown } | undefined;
    const detail = typeof error?.message === 'string' ? error.message : `OpenAI answered ${response.status}.`;
    const kind = classifyApiError({ status: response.status, message: detail })?.kind ?? 'refused';
    throw new RoomPictureDrawError(detail, kind);
  }
  const data = Array.isArray(body?.['data']) ? (body['data'] as Record<string, unknown>[]) : [];
  const encoded = data[0]?.['b64_json'];
  if (typeof encoded !== 'string') throw new RoomPictureDrawError('OpenAI answered without an image.', 'refused');
  return { png: Buffer.from(encoded, 'base64'), ...readUsage(body) };
}

function readUsage(body: Record<string, unknown> | null): { usage?: PictureUsage } {
  const usage = body?.['usage'] as Record<string, unknown> | undefined;
  if (!usage) return {};
  const input = (usage['input_tokens_details'] ?? {}) as Record<string, unknown>;
  const number = (value: unknown) => (typeof value === 'number' ? value : 0);
  return {
    usage: {
      inputTextTokens: number(input['text_tokens']),
      inputImageTokens: number(input['image_tokens']),
      outputTokens: number(usage['output_tokens']),
    },
  };
}

/** What drawings cost, or `undefined` when the provider said nothing — never a free `0`. */
export function pictureCostUsd(usages: (PictureUsage | undefined)[]): number | undefined {
  const known = usages.filter((usage): usage is PictureUsage => usage !== undefined);
  if (known.length === 0) return undefined;
  return known.reduce(
    (total, usage) =>
      total +
      (usage.inputTextTokens * PRICE_PER_MTOK.textInput +
        usage.inputImageTokens * PRICE_PER_MTOK.imageInput +
        usage.outputTokens * PRICE_PER_MTOK.imageOutput) /
        1_000_000,
    0,
  );
}
