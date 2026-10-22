import { describe, expect, it, vi } from 'vitest';
import { FloorPlanReadError, floorPlanPrompt, normaliseReading, readFloorPlan } from '../src/ai/floor-plan.js';

/**
 * Reading a floor plan: what the hub sends each vendor, and — the part worth
 * pinning hardest — what it lets through from the answer.
 */

const image = { bytes: Buffer.from('not really a png, nothing here decodes it'), contentType: 'image/png' };
const homeRooms = [
  { id: 'room-kitchen', name: 'Kitchen' },
  { id: 'room-bed', name: 'Bedroom' },
];

const reading = {
  rooms: [
    {
      name: 'Kitchen',
      matches: 'room-kitchen',
      story: 0,
      outline: [
        [0, 0],
        [3.4, 0],
        [3.4, 2.8],
        [0, 2.8],
      ],
      doors: [{ x: 3.4, z: 1.2, width: 0.8 }],
      windows: [{ x: 1.7, z: 0, width: 1.4 }],
    },
  ],
  scale: 'labels',
  note: null,
};

/** A `fetch` that answers once with `body` and remembers what it was sent. */
function answering(body: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('normaliseReading', () => {
  it('drops what cannot be drawn and keeps the rest', () => {
    const result = normaliseReading(
      {
        rooms: [
          reading.rooms[0],
          // Two corners is not a room.
          { ...reading.rooms[0], name: 'Line', outline: [[0, 0], [1, 1]] },
          // A kilometre away is not this home.
          { ...reading.rooms[0], name: 'Far', outline: [[0, 0], [1000, 0], [1000, 3], [0, 3]] },
          // A sliver with no floor.
          { ...reading.rooms[0], name: 'Sliver', outline: [[0, 0], [5, 0], [5, 0.01], [0, 0.01]] },
          'not even an object',
        ],
        scale: 'labels',
        note: null,
      },
      new Set(['room-kitchen']),
    );
    expect(result.rooms.map((room) => room.name)).toEqual(['Kitchen']);
    expect(result.rooms[0]!.doors).toEqual([{ x: 3.4, z: 1.2, width: 0.8 }]);
  });

  it('clears a match that names no room of this home, and a second claim on one', () => {
    const result = normaliseReading(
      {
        rooms: [
          { ...reading.rooms[0], matches: 'room-elsewhere' },
          { ...reading.rooms[0], name: 'Kitchen 2', matches: 'room-bed' },
          { ...reading.rooms[0], name: 'Also bedroom', matches: 'room-bed' },
        ],
        scale: 'door',
        note: 'No dimensions on the drawing.',
      },
      new Set(homeRooms.map((room) => room.id)),
    );
    expect(result.rooms.map((room) => room.matches)).toEqual([null, 'room-bed', null]);
    expect(result.note).toBe('No dimensions on the drawing.');
  });

  it('leaves out an opening it cannot read without losing the room', () => {
    const result = normaliseReading(
      { rooms: [{ ...reading.rooms[0], doors: [{ x: 1, z: 0 }, { x: 1, z: 0, width: 0.9 }] }], scale: 'x', note: null },
      new Set(),
    );
    expect(result.rooms[0]!.doors).toEqual([{ x: 1, z: 0, width: 0.9 }]);
  });

  it('refuses an answer that is not a plan at all', () => {
    expect(() => normaliseReading({ hello: 'world' }, new Set())).toThrow(FloorPlanReadError);
  });
});

describe('readFloorPlan', () => {
  it('asks Anthropic with the drawing and a tool to answer through', async () => {
    const { fetchImpl, calls } = answering({
      content: [
        { type: 'thinking', thinking: '…' },
        { type: 'tool_use', id: 't1', name: 'submit_floor_plan', input: reading },
      ],
      usage: { input_tokens: 1800, output_tokens: 2600 },
    });
    const result = await readFloorPlan({
      provider: 'anthropic',
      modelId: 'claude-opus-5-5',
      apiKey: 'sk-ant-test',
      image,
      homeRooms,
      fetchImpl,
    });
    expect(result.reading.rooms[0]).toMatchObject({ name: 'Kitchen', matches: 'room-kitchen' });
    expect(result.usage).toMatchObject({ input_tokens: 1800, output_tokens: 2600 });

    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    const sent = JSON.parse(String(calls[0]!.init.body));
    expect(sent.model).toBe('claude-opus-5-5');
    expect(sent.tools[0].name).toBe('submit_floor_plan');
    expect(sent.messages[0].content[0]).toMatchObject({ type: 'image', source: { media_type: 'image/png' } });
    // The home's rooms are in the prompt, so labels can be matched to them.
    expect(sent.messages[0].content[1].text).toContain('room-kitchen: Kitchen');
  });

  it('asks OpenAI for the same answer as strict JSON', async () => {
    const { fetchImpl, calls } = answering({
      output: [
        { type: 'reasoning', summary: [] },
        { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(reading) }] },
      ],
      usage: { input_tokens: 2000, output_tokens: 3000, input_tokens_details: { cached_tokens: 0 } },
    });
    const result = await readFloorPlan({
      provider: 'openai',
      modelId: 'gpt-6.1-sol',
      apiKey: 'sk-test',
      image,
      homeRooms,
      fetchImpl,
    });
    expect(result.reading.scale).toBe('labels');
    const sent = JSON.parse(String(calls[0]!.init.body));
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/responses');
    expect(sent.text.format).toMatchObject({ type: 'json_schema', strict: true });
    expect(sent.input[0].content[0].image_url).toMatch(/^data:image\/png;base64,/);
    expect(sent.store).toBe(false);
  });

  it('says why the provider refused, in its words', async () => {
    const { fetchImpl } = answering({ error: { message: 'invalid x-api-key' } }, 401);
    const failure = readFloorPlan({
      provider: 'anthropic',
      modelId: 'claude-opus-5-5',
      apiKey: 'wrong',
      image,
      homeRooms,
      fetchImpl,
    });
    await expect(failure).rejects.toMatchObject({ kind: 'auth_failed', message: 'invalid x-api-key' });
  });

  it('treats an answer with no reading in it as unreadable', async () => {
    const { fetchImpl } = answering({ content: [{ type: 'text', text: 'I cannot see a plan.' }] });
    await expect(
      readFloorPlan({ provider: 'anthropic', modelId: 'claude-opus-5-5', apiKey: 'k', image, homeRooms, fetchImpl }),
    ).rejects.toMatchObject({ kind: 'unreadable' });
  });
});

describe('floorPlanPrompt', () => {
  it('says so when the home has no rooms yet', () => {
    expect(floorPlanPrompt([])).toContain('(the home has no rooms yet)');
  });
});
