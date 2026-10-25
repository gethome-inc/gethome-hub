import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { HubEventBus } from '../src/core/bus.js';
import { drawRoomPicture, pictureCostUsd, RoomPictureDrawError } from '../src/room-pictures/draw.js';
import { LocateError, locateDevices, normaliseAnswer } from '../src/room-pictures/locate.js';
import { dayPrompt, describeKind, locatePrompt } from '../src/room-pictures/prompts.js';
import { PictureBusyError, RoomPictureService, type Locator } from '../src/room-pictures/store.js';

/**
 * Room pictures, minus the network: the image model and the reader are stubs,
 * and what is pinned is the hub's own behaviour around them — what it sends,
 * what it keeps, when it answers, and what survives a half that fails.
 */

const usage = { inputTextTokens: 275, inputImageTokens: 4480, outputTokens: 1372 };
const png = (marker: number) => Buffer.alloc(4096, marker);
const devices = [
  { id: 'tv', name: 'Light TV', kind: 'outlet' },
  { id: 'sensor', name: 'Climate sensor', kind: 'sensor' },
];
const locator: Locator = async () => ({ provider: 'openai', modelId: 'gpt-6.1-sol', apiKey: 'sk-reader' });

type Fn = ReturnType<typeof vi.fn>;

function service(options: { draw?: Fn; locate?: Fn; collect?: Fn; limits?: object } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gethome-room-pictures-'));
  const events = new HubEventBus();
  const heard: string[] = [];
  events.on('roomPicturesChanged', (roomId) => heard.push(roomId));
  const draw = options.draw ?? vi.fn(async () => ({ png: png(1), usage }));
  const locate =
    options.locate ??
    vi.fn(async () => ({
      located: [
        { deviceId: 'tv', x: 0.1, y: 0.3, seen: true },
        { deviceId: 'sensor', x: 0.5, y: 0.4, seen: false },
      ],
      usage: { input_tokens: 2000, output_tokens: 500 },
    }));
  const collect = options.collect ?? vi.fn();
  const pictures = new RoomPictureService(
    dir,
    events,
    undefined,
    undefined,
    options.limits ?? {},
    draw as never,
    locate as never,
    collect as never,
  );
  return { dir, heard, draw, locate, collect, pictures };
}

const input = {
  roomId: 'room-living',
  roomName: 'Living Room',
  orientation: 'portrait' as const,
  photos: [
    { bytes: png(3), contentType: 'image/jpeg' },
    { bytes: png(4), contentType: 'image/jpeg' },
  ],
  devices,
  apiKey: 'sk-test',
  locator,
  member: { id: 'member-1', name: 'Georgy' },
};

describe('RoomPictureService', () => {
  it('answers with the day picture and the devices read off it, then draws the night', async () => {
    const { pictures, draw, locate, heard } = service();
    const record = await pictures.draw(input);

    // The day: the photos and nothing else, on a transparent ground — no
    // device named and no portrait, so none is drawn the photos don't show.
    const day = (draw.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect((day['images'] as unknown[]).length).toBe(2);
    expect(day['background']).toBe('transparent');
    expect(day['size']).toBe('1024x1536');
    expect(String(day['prompt'])).toContain('“Living Room”');
    expect(String(day['prompt'])).not.toContain('Light TV');
    expect(String(day['prompt'])).toContain('Draw only what the photos show.');

    // The devices were read off the day picture, and the answer came before the night.
    expect(locate).toHaveBeenCalledTimes(1);
    expect(record.markers).toEqual([
      { deviceId: 'tv', x: 0.1, y: 0.3, source: 'seen' },
      { deviceId: 'sensor', x: 0.5, y: 0.4, source: 'guessed' },
    ]);
    expect(record).toMatchObject({ roomId: 'room-living', hasNight: false, photoCount: 2, width: 1024, height: 1536 });
    expect(pictures.isDrawing).toBe(true);

    await pictures.settled();
    const night = (draw.mock.calls[1] as unknown[])[0] as Record<string, unknown>;
    expect(night['background']).toBe('opaque');
    expect(pictures.get(record.id)?.hasNight).toBe(true);
    expect(await pictures.bytes(record.id, 'night')).not.toBeNull();
    expect(pictures.isDrawing).toBe(false);
    expect(heard).toEqual(['room-living', 'room-living']);
  });

  it('keeps the day when the night fails', async () => {
    const draw = vi
      .fn()
      .mockResolvedValueOnce({ png: png(1), usage })
      .mockRejectedValueOnce(new RoomPictureDrawError('busy', 'overloaded'));
    const { pictures } = service({ draw });
    const record = await pictures.draw(input);
    await pictures.settled();
    expect(pictures.get(record.id)?.hasNight).toBe(false);
    expect(await pictures.bytes(record.id, 'night')).toBeNull();
    expect(await pictures.bytes(record.id, 'day')).not.toBeNull();
  });

  it('keeps nothing when the day fails, and is free again', async () => {
    const draw = vi.fn().mockRejectedValue(new RoomPictureDrawError('no', 'auth_failed'));
    const { pictures } = service({ draw });
    await expect(pictures.draw(input)).rejects.toMatchObject({ kind: 'auth_failed' });
    expect(pictures.list()).toEqual([]);
    expect(pictures.isDrawing).toBe(false);
  });

  // On a 512 MB board a drawing's garbage held the hub at its memory limit
  // long enough for the pressure watch to stand Matter down (store.ts). What
  // is pinned is *when*: once the day has been answered and before the night
  // is asked for, and once the drawing is over, however it ended.
  it('gives its memory back once the day is answered and once it is over', async () => {
    const steps: string[] = [];
    const draw = vi.fn(async (edit: { background: string }) => {
      steps.push(edit.background === 'transparent' ? 'day' : 'night');
      return { png: png(1), usage };
    });
    const { pictures } = service({ draw, collect: vi.fn(() => steps.push('collect')) });
    await pictures.draw(input);
    steps.push('answered');
    await pictures.settled();
    expect(steps).toEqual(['day', 'answered', 'collect', 'night', 'collect']);

    const failed = service({ draw: vi.fn().mockRejectedValue(new RoomPictureDrawError('no', 'auth_failed')) });
    await expect(failed.pictures.draw(input)).rejects.toBeInstanceOf(RoomPictureDrawError);
    expect(failed.collect).toHaveBeenCalledTimes(1);
  });

  it('keeps a drawing whose devices could not be read, with no markers', async () => {
    const locate = vi.fn().mockRejectedValue(new LocateError('nope', 'refused'));
    const { pictures } = service({ locate });
    const record = await pictures.draw(input);
    expect(record.markers).toEqual([]);
    await pictures.settled();
  });

  it('reads nothing when the home has no key to read with', async () => {
    const { pictures, locate } = service();
    const record = await pictures.draw({ ...input, locator: async () => null });
    expect(locate).not.toHaveBeenCalled();
    expect(record.markers).toEqual([]);
    await pictures.settled();
  });

  it('refuses a second drawing until the first one’s night has landed', async () => {
    const pending: ((value: { png: Buffer; usage: typeof usage }) => void)[] = [];
    const draw = vi.fn(() => new Promise<{ png: Buffer; usage: typeof usage }>((resolve) => pending.push(resolve)));
    const { pictures } = service({ draw });
    const first = pictures.draw(input);
    await expect(pictures.draw(input)).rejects.toBeInstanceOf(PictureBusyError);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0]!({ png: png(1), usage });
    await first;
    // Answered, but the night is still being drawn: still busy.
    await expect(pictures.draw(input)).rejects.toBeInstanceOf(PictureBusyError);
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1]!({ png: png(2), usage });
    await pictures.settled();
    expect(pictures.isDrawing).toBe(false);
  });

  it('never reads over a marker a person placed', async () => {
    const { pictures, locate } = service();
    const record = await pictures.draw(input);
    await pictures.settled();
    pictures.setMarkers(record.id, [{ deviceId: 'tv', x: 0.7, y: 0.7, source: 'placed' }]);
    const again = await pictures.relocate(record.id, devices, locator);
    expect(again?.markers.find((marker) => marker.deviceId === 'tv')).toEqual({
      deviceId: 'tv',
      x: 0.7,
      y: 0.7,
      source: 'placed',
    });
    // Only the device nobody placed was asked about the second time.
    const asked = ((locate.mock.calls[1] as unknown[])[0] as { devices: { id: string }[] }).devices.map((d) => d.id);
    expect(asked).toEqual(['sensor']);
  });

  it('shows the newest drawing, lets an older one be chosen, and hands the choice on when it goes', async () => {
    const { pictures } = service();
    const first = await pictures.draw(input);
    await pictures.settled();
    const second = await pictures.draw(input);
    await pictures.settled();
    expect(pictures.get(second.id)?.selected).toBe(true);
    expect(pictures.get(first.id)?.selected).toBe(false);

    expect(pictures.select(first.id)?.selected).toBe(true);
    expect(pictures.get(second.id)?.selected).toBe(false);
    expect(pictures.select('missing')).toBeNull();

    await pictures.remove(first.id);
    expect(pictures.get(second.id)?.selected).toBe(true);
  });

  it('never lets the budget take the picture a room shows', async () => {
    const { pictures } = service({ limits: { budgetBytes: 1 } });
    const bedroom = await pictures.draw({ ...input, roomId: 'room-bed' });
    await pictures.settled();
    await pictures.draw(input);
    await pictures.settled();
    const newest = await pictures.draw(input);
    await pictures.settled();
    // Over budget, everything goes but the newest drawing and what each room
    // shows — and the bedroom's picture is older than both of the living room's.
    expect(pictures.list().map((record) => record.id).sort()).toEqual([bedroom.id, newest.id].sort());
    expect(pictures.get(bedroom.id)?.selected).toBe(true);
  });

  it('keeps a few per room, forgets a deleted room, and reads back after a restart', async () => {
    const { pictures, dir, draw, locate } = service({ limits: { maxPerRoom: 2 } });
    const one = await pictures.draw(input);
    await pictures.settled();
    await pictures.draw(input);
    await pictures.settled();
    await pictures.draw(input);
    await pictures.settled();
    expect(pictures.list()).toHaveLength(2);
    expect(existsSync(path.join(dir, 'room-pictures', `${one.id}-day.png`))).toBe(false);
    const reopened = new RoomPictureService(dir, undefined, undefined, undefined, {}, draw as never, locate as never);
    expect(reopened.list()).toHaveLength(2);
    await reopened.forgetRoom('room-living');
    expect(reopened.list()).toEqual([]);
  });
});

describe('reading the devices off a picture', () => {
  it('keeps devices asked about, once each, inside the picture', () => {
    const answer = normaliseAnswer(
      {
        devices: [
          { id: 'tv', x: 1.4, y: -0.2, seen: true },
          { id: 'tv', x: 0.5, y: 0.5, seen: true },
          { id: 'stranger', x: 0.5, y: 0.5, seen: true },
          { id: 'sensor', x: 0.3, y: 0.4 },
        ],
      },
      devices,
    );
    expect(answer).toEqual([
      { deviceId: 'tv', x: 0.98, y: 0.02, seen: true },
      { deviceId: 'sensor', x: 0.3, y: 0.4, seen: false },
    ]);
  });

  it('asks OpenAI with the picture and a strict schema', async () => {
    const calls: RequestInit[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response(
        JSON.stringify({
          output: [{ type: 'message', content: [{ type: 'output_text', text: '{"devices":[{"id":"tv","x":0.2,"y":0.3,"seen":true}]}' }] }],
          usage: { input_tokens: 2100, output_tokens: 400 },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const result = await locateDevices({ provider: 'openai', modelId: 'gpt-6.1-sol', apiKey: 'k', picture: png(1), devices, fetchImpl });
    expect(result.located).toEqual([{ deviceId: 'tv', x: 0.2, y: 0.3, seen: true }]);
    const sent = JSON.parse(await (calls[0]!.body as Blob).text());
    expect(sent.text.format.strict).toBe(true);
    expect(sent.input[0].content[1].text).toContain('tv: “Light TV”');
  });

  // The body is a Blob with the base64 spliced in, in pieces, so the picture
  // is never one string on the heap (`withPicture`). What has to hold is that
  // the pieces join into exactly the base64 of the picture — for a picture of
  // several pieces whose length is not a multiple of three.
  it.each(['openai', 'anthropic'] as const)('sends the whole picture to %s, exactly', async (provider) => {
    const picture = randomBytes(3 * 48 * 1024 + 1001);
    let sent: Record<string, unknown> = {};
    let contentType: string | null = null;
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      sent = JSON.parse(await (init!.body as Blob).text());
      contentType = new Headers(init!.headers).get('content-type');
      return new Response(
        JSON.stringify(
          provider === 'openai'
            ? { output: [{ type: 'message', content: [{ type: 'output_text', text: '{"devices":[]}' }] }] }
            : { content: [{ type: 'tool_use', name: 'submit_points', input: { devices: [] } }] },
        ),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    await locateDevices({ provider, modelId: 'm', apiKey: 'k', picture, devices, fetchImpl });
    expect(contentType).toBe('application/json');
    const content = (provider === 'openai' ? (sent['input'] as { content: unknown[] }[]) : (sent['messages'] as { content: unknown[] }[]))[0]!
      .content[0] as { image_url?: string; source?: { data: string } };
    const base64 = provider === 'openai' ? content.image_url!.replace('data:image/png;base64,', '') : content.source!.data;
    expect(base64).toBe(picture.toString('base64'));
    expect(JSON.stringify(sent)).not.toContain('picture-');
  });

  it('says why the provider refused', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ error: { message: 'invalid x-api-key' } }), { status: 401 }),
    ) as unknown as typeof fetch;
    await expect(
      locateDevices({ provider: 'anthropic', modelId: 'claude-opus-5-5', apiKey: 'bad', picture: png(1), devices, fetchImpl }),
    ).rejects.toMatchObject({ kind: 'auth_failed' });
  });
});

describe('drawing', () => {
  it('sends every photo as it is, in order', async () => {
    const photos = [randomBytes(70_001), randomBytes(1_234)];
    let form: FormData | undefined;
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      form = init!.body as FormData;
      return new Response(JSON.stringify({ data: [{ b64_json: png(7).toString('base64') }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const drawing = await drawRoomPicture({
      apiKey: 'k',
      prompt: 'p',
      images: [
        { bytes: photos[0]!, contentType: 'image/jpeg' },
        { bytes: photos[1]!, contentType: 'image/png' },
      ],
      size: '1024x1536',
      background: 'transparent',
      fetchImpl,
    });
    expect(drawing.png.equals(png(7))).toBe(true);
    const sent = form!.getAll('image[]') as File[];
    expect(sent.map((file) => [file.name, file.type])).toEqual([
      ['image0.jpg', 'image/jpeg'],
      ['image1.png', 'image/png'],
    ]);
    for (const [index, file] of sent.entries()) expect(Buffer.from(await file.arrayBuffer()).equals(photos[index]!)).toBe(true);
  });
});

describe('the words', () => {
  it('draws from the photos alone, and reads the devices by name and kind', () => {
    const prompt = dayPrompt('Bedroom', 3, 'portrait');
    expect(prompt).toContain('first 3 images are phone photos');
    expect(prompt).toContain('no devices, sensors, gadgets');
    expect(locatePrompt(devices)).toContain('- tv: “Light TV” (a smart plug — look for what it powers)');
    expect(describeKind('kettle-of-the-future')).toBe('a smart device');
  });

  it('prices what the provider reported, and nothing it did not', () => {
    expect(pictureCostUsd([undefined])).toBeUndefined();
    expect(pictureCostUsd([usage])).toBeCloseTo(0.0779, 3);
  });
});
