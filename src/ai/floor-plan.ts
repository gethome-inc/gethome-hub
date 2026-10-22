import { z } from 'zod';
import type { AiProvider } from '../core/settings.js';
import { classifyApiError } from './errors.js';
import type { TokenUsage } from './models.js';

/**
 * Reading a floor plan: a picture of a drawing in, the home's rooms as shapes
 * in metres out.
 *
 * **Why the hub reads it.** A home's 3D plan is put together from scans, and a
 * scan needs a LiDAR phone and somebody walking the whole home in one go. Most
 * homes already have a better source for how the rooms fit together: the plan
 * from the listing, the builder, or a sketch on paper. A vision model reads one
 * of those well — the outlines, the dimension labels, which door opens where —
 * and that is a recognition job, so it runs on the provider and model the home
 * chose for device recognition, on the home's own key, like everything else
 * here that spends it.
 *
 * **Stateless, and nothing is kept.** The answer goes back to the app that
 * asked, which shows it, lets somebody put it right, and saves it through
 * `PUT /space` like any other change to the plan. The picture is not stored and
 * the reading is not either; what the hub records is the run's cost, in
 * `ai_runs`, because that table answers what the home has spent.
 *
 * **Model output is data, never trusted shape.** The answer is parsed with zod,
 * clamped and filtered (`normaliseReading`): an outline with two corners, a
 * coordinate a kilometre away or a room list of a thousand is dropped rather
 * than handed on, so the app never has to defend itself against what a model
 * made up.
 *
 * **Plain `fetch`, like the portraits.** One request with one image, no tool
 * loop, so neither SDK earns its weight on a Pi.
 */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const OPENAI_URL = 'https://api.openai.com/v1/responses';

/**
 * Five minutes. A reading is one request, but with the effort turned up on a
 * busy drawing it can think for a while, and the app holds the request open
 * behind a "Reading your plan…" line. Anything tighter would cut off a reading
 * the provider is still working on and has already billed.
 */
const TIMEOUT_MS = 5 * 60 * 1000;

/** Thinking and the answer together. A plan's JSON is a few thousand tokens. */
const MAX_OUTPUT_TOKENS = 16_000;

/** The most rooms one reading may return — a drawing of a whole building. */
export const MAX_PLAN_ROOMS = 60;

/** Something the caller can put on screen, with the vendor's own words in it. */
export class FloorPlanReadError extends Error {
  constructor(
    message: string,
    /** `auth_failed` | `rate_limited` | `billing` | `overloaded` | `network` | `refused` | `unreadable`. */
    readonly kind: string,
  ) {
    super(message);
    this.name = 'FloorPlanReadError';
  }
}

/** One room as the drawing shows it. Metres, x to the right, z down the page. */
export interface FloorPlanRoom {
  name: string;
  /** The home room this is, when the drawing and the home agree on it. */
  matches: string | null;
  story: number;
  /** The floor, corner by corner — the room's inner face. */
  outline: [number, number][];
  doors: FloorPlanOpening[];
  windows: FloorPlanOpening[];
}

/** A door or window: its middle, on the room's outline, and how wide it is. */
export interface FloorPlanOpening {
  x: number;
  z: number;
  width: number;
}

export interface FloorPlanReading {
  rooms: FloorPlanRoom[];
  /** How the scale was found: `labels` · `door` · `guess`. Open. */
  scale: string;
  /** One sentence about anything the drawing left unclear. */
  note: string | null;
}

export interface ReadInput {
  provider: AiProvider;
  modelId: string;
  apiKey: string;
  image: { bytes: Buffer; contentType: string };
  /** The home's rooms, so the drawing's labels can be matched to them. */
  homeRooms: { id: string; name: string }[];
  /** For tests. */
  fetchImpl?: typeof fetch;
}

export interface ReadResult {
  reading: FloorPlanReading;
  usage: TokenUsage;
}

// ── The answer's shape ──────────────────────────────────────────────────────

/**
 * What the model is asked to answer with — one JSON Schema for both vendors.
 *
 * Every property is required and nullable where it may be absent, because
 * OpenAI's strict mode accepts nothing else; Anthropic reads the same schema
 * as a tool's input.
 */
const OPENING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['x', 'z', 'width'],
  properties: {
    x: { type: 'number' },
    z: { type: 'number' },
    width: { type: 'number', description: 'Metres.' },
  },
} as const;

export const READING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['rooms', 'scale', 'note'],
  properties: {
    rooms: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'matches', 'story', 'outline', 'doors', 'windows'],
        properties: {
          name: { type: 'string', description: 'The room as labelled, or what it plainly is.' },
          matches: {
            type: ['string', 'null'],
            description: "The id of the home's room this is, or null when none clearly is.",
          },
          story: { type: 'integer', description: '0 for the ground floor, 1 for the one above.' },
          outline: {
            type: 'array',
            description: 'The floor of the room, corner by corner, in metres: [x, z].',
            items: { type: 'array', items: { type: 'number' } },
          },
          doors: { type: 'array', items: OPENING_SCHEMA },
          windows: { type: 'array', items: OPENING_SCHEMA },
        },
      },
    },
    scale: { type: 'string', enum: ['labels', 'door', 'guess'] },
    note: { type: ['string', 'null'] },
  },
} as const;

const coordinate = z.number().min(-200).max(200);
const openingSchema = z.object({
  x: coordinate,
  z: coordinate,
  width: z.number().min(0.3).max(6),
});

const roomSchema = z.object({
  name: z.string().trim().min(1).max(60),
  matches: z.string().max(80).nullable().catch(null),
  story: z.number().int().min(-3).max(20).catch(0),
  outline: z.array(z.tuple([coordinate, coordinate])).min(3).max(200),
  doors: z.array(z.unknown()).max(40).catch([]),
  windows: z.array(z.unknown()).max(40).catch([]),
});

/** The openings that can be read, rounded; the rest left out one by one. */
function openings(raw: unknown[]): FloorPlanOpening[] {
  return raw.flatMap((candidate) => {
    const parsed = openingSchema.safeParse(candidate);
    return parsed.success ? [roundOpening(parsed.data)] : [];
  });
}

/**
 * The model's answer made safe to hand on: rooms that can't be drawn dropped,
 * openings that can't be read dropped, a match that names no room of this
 * home cleared, and nothing else let through.
 */
export function normaliseReading(raw: unknown, homeRoomIds: ReadonlySet<string>): FloorPlanReading {
  const envelope = z
    .object({
      rooms: z.array(z.unknown()).max(MAX_PLAN_ROOMS * 2),
      scale: z.string().max(20).catch('guess'),
      note: z.string().max(400).nullable().catch(null),
    })
    .safeParse(raw);
  if (!envelope.success) throw new FloorPlanReadError('The answer was not a floor plan.', 'unreadable');

  const rooms: FloorPlanRoom[] = [];
  const claimed = new Set<string>();
  for (const candidate of envelope.data.rooms) {
    const parsed = roomSchema.safeParse(candidate);
    if (!parsed.success) continue;
    const room = parsed.data;
    if (Math.abs(signedArea(room.outline)) < 0.5) continue;
    // One drawing room per home room: a second claim is a guess.
    let matches = room.matches !== null && homeRoomIds.has(room.matches) ? room.matches : null;
    if (matches !== null && claimed.has(matches)) matches = null;
    if (matches !== null) claimed.add(matches);
    rooms.push({
      name: room.name,
      matches,
      story: room.story,
      outline: room.outline.map(([x, zz]) => [round(x), round(zz)]),
      doors: openings(room.doors),
      windows: openings(room.windows),
    });
    if (rooms.length >= MAX_PLAN_ROOMS) break;
  }
  return { rooms, scale: envelope.data.scale, note: envelope.data.note };
}

function signedArea(points: [number, number][]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [x1, z1] = points[i]!;
    const [x2, z2] = points[(i + 1) % points.length]!;
    sum += x1 * z2 - x2 * z1;
  }
  return sum / 2;
}

const round = (value: number) => Math.round(value * 1000) / 1000;
const roundOpening = (opening: FloorPlanOpening): FloorPlanOpening => ({
  x: round(opening.x),
  z: round(opening.z),
  width: round(opening.width),
});

// ── The prompt ──────────────────────────────────────────────────────────────

export function floorPlanPrompt(homeRooms: { id: string; name: string }[]): string {
  const list =
    homeRooms.length > 0
      ? homeRooms.map((room) => `- ${room.id}: ${room.name}`).join('\n')
      : '(the home has no rooms yet)';
  return [
    'The image is a floor plan of a home: an architect’s drawing, a listing’s plan, or a sketch.',
    'Read every room off it as a shape in metres, so the home can be drawn in 3D.',
    '',
    'Coordinates: x to the right across the drawing, z down the drawing, metres, with the top-left',
    'corner of the drawing at about [0, 0]. Keep the rooms where the drawing has them relative to',
    'each other — how they fit together is the whole point.',
    '',
    'Scale: use the dimension labels when there are any (they may be in metres, centimetres or',
    'millimetres — "3.40", "340", "3400" are the same wall). Without labels, take a single interior',
    'door as 0.8 m wide, and say "door"; with neither, judge from beds, baths and kitchen counters',
    'and say "guess".',
    '',
    'Each room:',
    '- outline: the floor, corner by corner around the room — the inner face of its walls. Rooms',
    '  that share a wall stand the wall’s thickness apart (usually 0.1–0.25 m), as drawn.',
    '  L-shaped rooms keep their shape. Corridors, halls, bathrooms, closets you can walk into,',
    '  balconies and terraces are rooms too. Furniture, stairs and fixtures are not.',
    '- doors and windows: the middle of each, on that room’s outline, and its width. A door between',
    '  two rooms belongs to both. The entrance door belongs to the room it opens into.',
    '- story: 0 for the ground floor; a drawing of several floors numbers them up from 0.',
    '- name: the label on the drawing, in its own language; when there is none, what the room plainly',
    '  is ("Bathroom").',
    "- matches: the id of the home's room this is, when it clearly is the same room — by its label",
    '  or what it is for. Each home room matches at most one drawing room. Null when unsure.',
    '',
    "The home's rooms:",
    list,
    '',
    'note: one short sentence for the person about anything unclear (a missing scale, a floor that',
    'is cut off), or null.',
    '',
    'If the image is not a floor plan, answer with no rooms and say so in note.',
  ].join('\n');
}

// ── The call ────────────────────────────────────────────────────────────────

export async function readFloorPlan(input: ReadInput): Promise<ReadResult> {
  const doFetch = input.fetchImpl ?? fetch;
  const prompt = floorPlanPrompt(input.homeRooms);
  const ids = new Set(input.homeRooms.map((room) => room.id));
  const base64 = input.image.bytes.toString('base64');

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
              reasoning: { effort: 'high' },
              max_output_tokens: MAX_OUTPUT_TOKENS,
              store: false,
              input: [
                {
                  role: 'user',
                  content: [
                    { type: 'input_image', image_url: `data:${input.image.contentType};base64,${base64}` },
                    { type: 'input_text', text: prompt },
                  ],
                },
              ],
              text: { format: { type: 'json_schema', name: 'floor_plan', schema: READING_SCHEMA, strict: true } },
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
              // The answer has one channel, the way the mapper's does: a
              // tool whose input is the reading. `auto` rather than forcing
              // it, because a forced tool turns thinking off.
              tools: [
                {
                  name: 'submit_floor_plan',
                  description: 'Answer with the rooms read off the drawing. Call this exactly once.',
                  input_schema: READING_SCHEMA,
                },
              ],
              messages: [
                {
                  role: 'user',
                  content: [
                    {
                      type: 'image',
                      source: { type: 'base64', media_type: input.image.contentType, data: base64 },
                    },
                    { type: 'text', text: `${prompt}\n\nAnswer by calling submit_floor_plan.` },
                  ],
                },
              ],
            }),
          });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new FloorPlanReadError(message, classifyApiError(error)?.kind ?? 'network');
  }

  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    const detail = errorDetail(body) ?? `The provider answered ${response.status}.`;
    const kind = classifyApiError({ status: response.status, message: detail })?.kind ?? 'refused';
    throw new FloorPlanReadError(detail, kind);
  }

  const answer = input.provider === 'openai' ? openAiAnswer(body) : anthropicAnswer(body);
  if (answer === undefined) throw new FloorPlanReadError('The model answered without a plan.', 'unreadable');
  return { reading: normaliseReading(answer, ids), usage: usageOf(input.provider, body) };
}

function errorDetail(body: Record<string, unknown> | null): string | undefined {
  const error = body?.['error'];
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return undefined;
}

/** The tool call's input, which is the reading. */
function anthropicAnswer(body: Record<string, unknown> | null): unknown {
  const content = Array.isArray(body?.['content']) ? (body['content'] as Record<string, unknown>[]) : [];
  const call = content.find((block) => block['type'] === 'tool_use' && block['name'] === 'submit_floor_plan');
  return call?.['input'];
}

/** The message's text, which strict mode has made the reading's JSON. */
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
