import { classifyApiError, errorCodeIn } from '../ai/errors.js';

/**
 * The one call that draws a room: OpenAI’s Image API, over plain HTTP, with
 * the photos of the room in and one picture out.
 *
 * **`gpt-image-2.6-sunburst`, the quality half of the 2.6 pair**, where the
 * portraits take Flare. A portrait is one object at card size; a room is the
 * whole screen and a dozen things in it, with curtains, a hob and the magnets
 * on a fridge that the person who lives there will look for. Both bill the
 * same per token, and on 2.5 Sunburst took about half a minute more — on a
 * surface that is drawn once and looked at every day, that is the trade to
 * make. 2.6 gives it a second reason: at medium or high quality Sunburst keeps
 * details more consistent from one edit to the next, and the night is an edit
 * of the day.
 *
 * **The day and the night are asked for differently** (`DAY_SETTINGS`,
 * `NIGHT_SETTINGS`), because they are different jobs. The day is drawn once
 * from the photos and looked at every day, so it takes `xhigh`, one of the two
 * rungs above `high` — more detail at more cost, and nothing more on this
 * board, since the picture is the same size; `complexity` is left to the
 * model's default, `high`, which is where OpenAI says to start a complex layout
 * and a room put together from several photos is one. The night is an edit
 * that may change only the light, so it takes `complexity: low` — OpenAI's
 * advice for an edit, since a model that plans less reinterprets less — at
 * `high` quality, where OpenAI places Sunburst's consistency from one edit to
 * the next: the apps cut the night by the day's own outline and dissolve one
 * into the other, so a night that drifted would show at its edges.
 *
 * **No SDK**, for the portraits' reason: one endpoint and one response field.
 */

export const ROOM_PICTURE_MODEL = 'gpt-image-2.6-sunburst';

const EDITS_URL = 'https://api.openai.com/v1/images/edits';

/**
 * Ten minutes, the portraits' ceiling. A room measured at about half a minute
 * here on 2.5; the deadline is a ceiling nobody should reach, kept generous
 * because a drawing cut off is one the provider has already billed.
 */
const TIMEOUT_MS = 10 * 60 * 1000;

/** USD per million tokens — the 2.6 pair's shared rates, which are 2.5's unchanged. */
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

/** How much detail and how much planning one picture is drawn with — see the note at the top. */
export interface PictureSettings {
  /** `low` … `max`; only the two a room is drawn at are named. */
  quality: 'high' | 'xhigh';
  /** How much the model plans; absent leaves 2.6's own default, `high`. */
  complexity?: 'low' | 'medium' | 'high';
}

/** The day picture, drawn from the photos. */
export const DAY_SETTINGS: PictureSettings = { quality: 'xhigh' };

/** The night picture, an edit of the day that changes only its light. */
export const NIGHT_SETTINGS: PictureSettings = { quality: 'high', complexity: 'low' };

export interface EditInput extends PictureSettings {
  apiKey: string;
  prompt: string;
  /** In the order the prompt names them. Never shared memory, so a Blob can take them as they are. */
  images: { bytes: Buffer<ArrayBuffer>; contentType: string }[];
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
  form.set('quality', input.quality);
  if (input.complexity !== undefined) form.set('complexity', input.complexity);
  form.set('background', input.background);
  form.set('output_format', 'png');
  // The bytes as they are: a Blob copies what it is given, so copying them
  // first was one more photo-sized allocation per photo for nothing.
  input.images.forEach((image, index) => {
    const extension = image.contentType === 'image/png' ? 'png' : 'jpg';
    form.append('image[]', new Blob([image.bytes], { type: image.contentType }), `image${index}.${extension}`);
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
    const kind =
      classifyApiError({ status: response.status, message: detail, code: errorCodeIn(body) })?.kind ?? 'refused';
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
