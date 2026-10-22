import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { HubEventBus } from '../src/core/bus.js';
import { RoomPictureDrawError, pictureCostUsd } from '../src/space/picture-draw.js';
import { dayPrompt } from '../src/space/picture-prompts.js';
import { PictureBusyError, RoomPictureService } from '../src/space/pictures.js';

/**
 * Room pictures, minus the network: the provider is a stub, and what is pinned
 * is the hub's own behaviour around it — what it keeps, what it sends, and
 * what it does when half of a drawing fails.
 */

const usage = { inputTextTokens: 480, inputImageTokens: 6016, outputTokens: 1372 };
const png = (marker: number) => Buffer.alloc(4096, marker);

type Draw = ReturnType<typeof vi.fn>;

function service(draw: Draw = vi.fn(async () => ({ png: png(1), usage })), limits = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gethome-pictures-'));
  const events = new HubEventBus();
  const heard: string[] = [];
  events.on('spacePicturesChanged', (roomId) => heard.push(roomId));
  return { dir, heard, draw, pictures: new RoomPictureService(dir, events, undefined, undefined, limits, draw as never) };
}

const input = {
  roomId: 'room-living',
  roomName: 'Living Room',
  view: { yaw: 0.785, pitch: 0.86, future: { kept: true } },
  size: '1024x1536' as const,
  structure: png(9),
  photos: [{ bytes: png(3), contentType: 'image/jpeg' }],
  planRevision: 7,
  apiKey: 'sk-test',
  member: { id: 'member-1', name: 'Georgy' },
};

describe('RoomPictureService', () => {
  it('draws the day from the clay and the photos, then the night from the day', async () => {
    const { pictures, draw, heard } = service();
    const record = await pictures.draw(input);

    expect(draw).toHaveBeenCalledTimes(2);
    const [day, night] = draw.mock.calls.map((call) => (call as unknown[])[0] as Record<string, unknown>);
    // The clay first, then the photos — the order the prompt names them in.
    expect((day!['images'] as { contentType: string }[]).map((image) => image.contentType)).toEqual([
      'image/png',
      'image/jpeg',
    ]);
    expect(day!['background']).toBe('transparent');
    expect(night!['background']).toBe('opaque');
    expect(String(day!['prompt'])).toContain('“Living Room”');

    // The camera is the app's, and comes back exactly as it went.
    expect(record).toMatchObject({ roomId: 'room-living', hasNight: true, photoCount: 1, planRevision: 7, view: input.view });
    expect(record.drawnBy).toEqual({ id: 'member-1', name: 'Georgy' });
    expect(await pictures.bytes(record.id, 'day')).not.toBeNull();
    expect(await pictures.bytes(record.id, 'night')).not.toBeNull();
    expect(heard).toEqual(['room-living']);
  });

  it('keeps the day when the night fails', async () => {
    const draw = vi
      .fn()
      .mockResolvedValueOnce({ png: png(1), usage })
      .mockRejectedValueOnce(new RoomPictureDrawError('busy', 'overloaded'));
    const { pictures } = service(draw);
    const record = await pictures.draw(input);
    expect(record.hasNight).toBe(false);
    expect(await pictures.bytes(record.id, 'night')).toBeNull();
  });

  it('keeps nothing when the day fails', async () => {
    const draw = vi.fn().mockRejectedValue(new RoomPictureDrawError('no', 'auth_failed'));
    const { pictures } = service(draw);
    await expect(pictures.draw(input)).rejects.toMatchObject({ kind: 'auth_failed' });
    expect(pictures.list()).toEqual([]);
  });

  it('refuses a second drawing while one is under way, rather than queueing a second bill', async () => {
    const pending: ((value: { png: Buffer; usage: typeof usage }) => void)[] = [];
    const draw = vi.fn(() => new Promise<{ png: Buffer; usage: typeof usage }>((resolve) => pending.push(resolve)));
    const { pictures } = service(draw);
    const first = pictures.draw(input);
    await expect(pictures.draw(input)).rejects.toBeInstanceOf(PictureBusyError);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0]!({ png: png(1), usage });
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1]!({ png: png(2), usage });
    await first;
    // Free again once it is done.
    expect(pictures.isDrawing).toBe(false);
  });

  it('keeps a few per room and reads them back after a restart', async () => {
    const { pictures, dir, draw } = service(undefined, { maxPerRoom: 2 });
    const one = await pictures.draw(input);
    await pictures.draw(input);
    await pictures.draw(input);
    expect(pictures.list()).toHaveLength(2);
    expect(existsSync(path.join(dir, 'space', 'pictures', `${one.id}-day.png`))).toBe(false);
    const reopened = new RoomPictureService(dir, undefined, undefined, undefined, {}, draw as never);
    expect(reopened.list()).toHaveLength(2);
  });

  it('removes one, and every picture of a room', async () => {
    const { pictures } = service();
    const record = await pictures.draw(input);
    await pictures.draw({ ...input, roomId: 'room-bed' });
    expect(await pictures.remove(record.id)).toBe('room-living');
    await pictures.forgetRoom('room-bed');
    expect(pictures.list()).toEqual([]);
  });
});

describe('room picture prompts and price', () => {
  it('asks for a guess at materials when there are no photos', () => {
    expect(dayPrompt('Bedroom', 0)).toContain('There are no photos of this room');
    expect(dayPrompt('Bedroom', 3)).toContain('draw what the photos show');
  });

  it('prices what the provider reported, and nothing it did not', () => {
    expect(pictureCostUsd([undefined])).toBeUndefined();
    expect(pictureCostUsd([usage])).toBeCloseTo(0.0917, 3);
  });
});
