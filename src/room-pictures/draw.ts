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
 * **`xhigh`, the tier above the `high` a room was drawn at until 2026-11-10.**
 * A room is drawn once and looked at every day, at the size of the screen and
 * closer when it is pinched into, so it takes the detail a portrait's tile
 * would throw away. The day and the night both take it: they are one picture
 * dissolving into the other, and should carry the same grain. **Four things
 * about it are not measured, and a first drawing is what tells.** The wait —
 * the ceiling below and the apps' own deadline were set when a room took about
 * half a minute at `high`, and the apps say "about a minute". The cost, which
 * is per token and so is read from each answer rather than assumed. The
 * transparent ground the day is asked for: the portraits stay at `high` over
 * a note that OpenAI's guidance puts a transparent background at its best at
 * medium or high (`src/portraits/openai-images.ts`), and nothing published
 * says how the two tiers above behave, so the outline is the first thing to
 * look at on a room drawn this way. And how closely the night keeps to the
 * day: the sentence above about edits names medium and high, and says nothing
 * of the tiers over them. OpenAI's own word on those tiers is to use them only
 * where they meet a need `high` does not, and that a higher setting does not
 * promise a better picture: if a room at `xhigh` is not visibly finer, `high`
 * is the answer again.
 *
 * **`complexity`, which 2.6 added, is the model's own default for the day and
 * `low` for the night.** It is how much the model plans before it renders. The
 * day is a whole room laid out from several photos — the scene of many things
 * and many constraints OpenAI says to leave at the default, `high` — and its
 * layout is what makes it this room. The night is an edit that may change one
 * thing. OpenAI recommends `low` for edits and says a higher setting can
 * introduce unwanted changes, and an unwanted change is the one fault a night
 * cannot carry: it is cut out by the day's outline and laid over the day's
 * depth, so anything that moved shows. Not compared on real rooms yet — if
 * nights come out duller for it, `NIGHT_COMPLEXITY` is what to put back.
 *
 * **The size stays 1024 × 1536, or its landscape.** 2.6 takes larger ones, and
 * a larger picture would be sharper when it is pinched into. It is not taken
 * along with `xhigh`, and not without measuring: a drawing is already the most
 * memory this hub holds at once, which on a 512 MB board once stood a radio
 * down; every app already shipped would be handed the larger picture to stand
 * up as a relief; and two settings moved together cannot be told apart in what
 * comes back. It is the next thing to try, by itself.
 *
 * **No SDK**, for the portraits' reason: one endpoint and one response field.
 */

export const ROOM_PICTURE_MODEL = 'gpt-image-2.6-sunburst';

/** How finely both pictures are rendered — see the note above. */
export const ROOM_PICTURE_QUALITY = 'xhigh';

export type PictureComplexity = 'low' | 'medium' | 'high';

/** How much the night's edit is planned — see the note above. The day sends none. */
export const NIGHT_COMPLEXITY: PictureComplexity = 'low';

const EDITS_URL = 'https://api.openai.com/v1/images/edits';

/**
 * Ten minutes, the portraits' ceiling. A room measured at about half a minute
 * here on 2.5 at `high`, and has not been measured at `xhigh`; the deadline is
 * a ceiling nobody should reach, kept generous because a drawing cut off is
 * one the provider has already billed.
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

export interface EditInput {
  apiKey: string;
  prompt: string;
  /** In the order the prompt names them. Never shared memory, so a Blob can take them as they are. */
  images: { bytes: Buffer<ArrayBuffer>; contentType: string }[];
  size: '1024x1536' | '1536x1024';
  background: 'transparent' | 'opaque';
  /** Left out, the model plans at its own default (`high`). */
  complexity?: PictureComplexity;
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
  form.set('quality', ROOM_PICTURE_QUALITY);
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
