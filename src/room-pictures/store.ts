import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readFile, rm, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { estimateCostUsd } from '../ai/models.js';
import type { AiRunLog } from '../core/ai-runs.js';
import type { HubEventBus } from '../core/bus.js';
import type { AiProvider } from '../core/settings.js';
import type { Logger } from '../logging.js';
import { drawRoomPicture, pictureCostUsd, RoomPictureDrawError, ROOM_PICTURE_MODEL, type PictureUsage } from './draw.js';
import { LocateError, locateDevices } from './locate.js';
import { dayPrompt, NIGHT_PROMPT, type PictureDevice } from './prompts.js';

/**
 * Pictures of the home's rooms — each room drawn from photos of it as the
 * isometric cutaway a smart-home app shows, by day and by night, with a
 * marker for every device standing on the thing it is.
 *
 * **It is the house's, so it lives here**, the portraits' argument: one person
 * draws the living room and everybody's app shows it, markers and all.
 *
 * **One drawing is three requests, and the answer comes after two.** The day
 * picture (photos in, the room out, on a transparent ground), then the devices
 * read off it (`locate.ts`) — and the record goes back to the app there, so a
 * phone shows the room after about a minute. The night picture is an edit of
 * the day, drawn after the answer while the hub stays busy, and announced when
 * it lands (`roomPicturesChanged`); it comes back on an opaque ground, and the
 * apps cut it out with the day picture's outline — no image library on this
 * board, for the portraits' reason. A night that fails keeps the day.
 *
 * **Markers are fractions of the picture**, read by the model or placed by a
 * person, and a placed one is never read over. **Files and a manifest**: one
 * deliberate write per drawing, bounded by bulk — a few per room, a budget for
 * all, a refusal to draw on a nearly full card. The photos are not kept.
 */

export const MAX_PER_ROOM = 3;
export const BUDGET_BYTES = 200 * 1024 * 1024;
export const MIN_FREE_BYTES = 500 * 1024 * 1024;
/** Photos one drawing may be sent; device portraits ride beside them. */
export const MAX_PHOTOS = 8;
export const MAX_PORTRAITS = 3;

export type PictureOrientation = 'portrait' | 'landscape';

/** Where a device stands on a picture. */
export interface RoomPictureMarker {
  deviceId: string;
  /** Fractions of the picture's width and height, from its top-left corner. */
  x: number;
  y: number;
  /** `seen` and `guessed` are the model's; `placed` is a person's. Open. */
  source: string;
}

export interface RoomPictureRecord {
  id: string;
  roomId: string;
  at: string;
  orientation: PictureOrientation;
  width: number;
  height: number;
  /** False until the night picture lands, and for good if it could not be drawn. */
  hasNight: boolean;
  photoCount: number;
  markers: RoomPictureMarker[];
  bytes: number;
  model: string;
  drawnBy?: { id: string | null; name: string };
}

export interface PictureCapability {
  model: string;
  maxPerRoom: number;
  maxPhotos: number;
}

/** Who reads the devices off a picture — device recognition's provider and key. */
export type Locator = () => Promise<{ provider: AiProvider; modelId: string; apiKey: string } | null>;

export interface DrawInput {
  roomId: string;
  roomName: string;
  orientation: PictureOrientation;
  photos: { bytes: Buffer; contentType: string }[];
  devices: PictureDevice[];
  /** Pictures of some of the devices, to show what they look like. */
  portraits: { device: PictureDevice; bytes: Buffer }[];
  apiKey: string;
  locator: Locator;
  member?: { id: string; name: string };
}

export class PictureBusyError extends Error {
  constructor() {
    super('A room is already being drawn.');
  }
}

export class PictureSpaceError extends Error {
  constructor() {
    super('The hub is nearly out of space, so it won’t draw another picture.');
  }
}

export interface PictureLimits {
  maxPerRoom: number;
  budgetBytes: number;
  minFreeBytes: number;
}

export class RoomPictureService {
  private readonly root: string;
  private readonly manifest: string;
  private readonly limits: PictureLimits;
  private records: RoomPictureRecord[] | null = null;
  /** One at a time, day to night: refused, not queued — every drawing bills the home. */
  private drawing = false;
  /** The night still being drawn after a drawing answered — for tests to wait on. */
  private night: Promise<void> | null = null;

  constructor(
    dataDir: string,
    private readonly events: HubEventBus | undefined,
    private readonly log: Logger | undefined,
    private readonly runs: AiRunLog | undefined,
    limits: Partial<PictureLimits> = {},
    private readonly draw_ = drawRoomPicture,
    private readonly locate_ = locateDevices,
  ) {
    this.root = path.join(dataDir, 'room-pictures');
    this.manifest = path.join(this.root, 'pictures.json');
    this.limits = {
      maxPerRoom: limits.maxPerRoom ?? MAX_PER_ROOM,
      budgetBytes: limits.budgetBytes ?? BUDGET_BYTES,
      minFreeBytes: limits.minFreeBytes ?? MIN_FREE_BYTES,
    };
  }

  describe(): PictureCapability {
    return { model: ROOM_PICTURE_MODEL, maxPerRoom: this.limits.maxPerRoom, maxPhotos: MAX_PHOTOS };
  }

  get isDrawing(): boolean {
    return this.drawing;
  }

  /** Resolves once a night picture still being drawn has landed. */
  async settled(): Promise<void> {
    await this.night;
  }

  /** Newest first. */
  list(): RoomPictureRecord[] {
    return [...this.read()].sort((a, b) => b.at.localeCompare(a.at));
  }

  get(id: string): RoomPictureRecord | undefined {
    return this.read().find((record) => record.id === id);
  }

  async bytes(id: string, variant: 'day' | 'night'): Promise<Buffer | null> {
    const record = this.get(id);
    if (!record || (variant === 'night' && !record.hasNight)) return null;
    try {
      return await readFile(this.fileFor(id, variant));
    } catch {
      return null;
    }
  }

  async draw(input: DrawInput): Promise<RoomPictureRecord> {
    if (this.drawing) throw new PictureBusyError();
    this.drawing = true;
    let handedOn = false;
    try {
      const record = await this.drawDay(input);
      handedOn = true;
      this.night = this.drawNight(record, input.apiKey).finally(() => {
        this.drawing = false;
        this.night = null;
      });
      return record;
    } finally {
      if (!handedOn) this.drawing = false;
    }
  }

  private async drawDay(input: DrawInput): Promise<RoomPictureRecord> {
    await this.assertSpace();
    const size = input.orientation === 'landscape' ? '1536x1024' : '1024x1536';
    const run = this.runs?.begin({
      kind: 'roompicture',
      adapter: 'room-pictures',
      exposesHash: '',
      provider: 'openai',
      modelId: ROOM_PICTURE_MODEL,
    });
    const photos = input.photos.slice(0, MAX_PHOTOS);
    const portraits = input.portraits.slice(0, MAX_PORTRAITS);
    let day;
    try {
      day = await this.draw_({
        apiKey: input.apiKey,
        prompt: dayPrompt(
          input.roomName,
          photos.length,
          input.devices,
          portraits.map((portrait) => portrait.device),
          input.orientation,
        ),
        images: [...photos, ...portraits.map((portrait) => ({ bytes: portrait.bytes, contentType: 'image/png' }))],
        size,
        background: 'transparent',
      });
    } catch (error) {
      await run?.finish({
        ok: false,
        ...(error instanceof RoomPictureDrawError ? { errorKind: error.kind } : {}),
        ...(error instanceof Error ? { errorMessage: error.message } : {}),
      });
      throw error;
    }
    const costUsd = pictureCostUsd([day.usage]);
    await run?.finish({ ok: true, ...(costUsd !== undefined ? { costUsd } : {}) });

    const markers = await this.readMarkers(day.png, input.devices, input.locator, []);
    const id = randomUUID();
    mkdirSync(this.root, { recursive: true });
    await writeFile(this.fileFor(id, 'day'), day.png);
    const [width, height] = size.split('x').map(Number) as [number, number];
    const record: RoomPictureRecord = {
      id,
      roomId: input.roomId,
      at: new Date().toISOString(),
      orientation: input.orientation,
      width,
      height,
      hasNight: false,
      photoCount: photos.length,
      markers,
      bytes: day.png.byteLength,
      model: ROOM_PICTURE_MODEL,
      ...(input.member ? { drawnBy: { id: input.member.id, name: input.member.name } } : {}),
    };
    this.write([...this.read(), record]);
    await this.prune(input.roomId);
    this.events?.emit('roomPicturesChanged', input.roomId);
    return record;
  }

  /** The night, as an edit of the day — after the drawing has answered. */
  private async drawNight(record: RoomPictureRecord, apiKey: string): Promise<void> {
    const day = await this.bytes(record.id, 'day');
    if (!day) return;
    const run = this.runs?.begin({
      kind: 'roompicture',
      adapter: 'room-pictures',
      exposesHash: '',
      provider: 'openai',
      modelId: ROOM_PICTURE_MODEL,
    });
    let usage: PictureUsage | undefined;
    try {
      const night = await this.draw_({
        apiKey,
        prompt: NIGHT_PROMPT,
        images: [{ bytes: day, contentType: 'image/png' }],
        size: record.orientation === 'landscape' ? '1536x1024' : '1024x1536',
        background: 'opaque',
      });
      usage = night.usage;
      // The drawing may have been removed while the night was drawn.
      if (!this.get(record.id)) return;
      await writeFile(this.fileFor(record.id, 'night'), night.png);
      this.update(record.id, (current) => ({ ...current, hasNight: true, bytes: current.bytes + night.png.byteLength }));
      this.events?.emit('roomPicturesChanged', record.roomId);
      const costUsd = pictureCostUsd([usage]);
      await run?.finish({ ok: true, ...(costUsd !== undefined ? { costUsd } : {}) });
    } catch (error) {
      this.log?.warn({ err: error }, 'The night picture could not be drawn; keeping the day one.');
      await run?.finish({
        ok: false,
        ...(error instanceof RoomPictureDrawError ? { errorKind: error.kind } : {}),
        ...(error instanceof Error ? { errorMessage: error.message } : {}),
      });
    }
  }

  /**
   * Reads the devices off a picture, keeping every marker a person placed.
   * A failed reading is no reason to lose a drawing: the devices it could not
   * place are left for the apps to put somewhere and people to move.
   */
  private async readMarkers(
    picture: Buffer,
    devices: PictureDevice[],
    locator: Locator,
    keep: RoomPictureMarker[],
  ): Promise<RoomPictureMarker[]> {
    const placed = keep.filter((marker) => marker.source === 'placed');
    const wanted = devices.filter((device) => !placed.some((marker) => marker.deviceId === device.id));
    if (wanted.length === 0) return placed;
    const who = await locator();
    if (!who) return [...placed, ...keep.filter((marker) => marker.source !== 'placed')];
    const run = this.runs?.begin({
      kind: 'roomlocate',
      adapter: 'room-pictures',
      exposesHash: '',
      provider: who.provider,
      modelId: who.modelId,
    });
    try {
      const { located, usage } = await this.locate_({ ...who, picture, devices: wanted });
      await run?.finish({ ok: true, costUsd: estimateCostUsd(who.modelId, usage) });
      return [
        ...placed,
        ...located.map((point) => ({
          deviceId: point.deviceId,
          x: point.x,
          y: point.y,
          source: point.seen ? 'seen' : 'guessed',
        })),
      ];
    } catch (error) {
      this.log?.warn({ err: error }, 'The devices could not be read off the picture.');
      await run?.finish({
        ok: false,
        ...(error instanceof LocateError ? { errorKind: error.kind } : {}),
        ...(error instanceof Error ? { errorMessage: error.message } : {}),
      });
      return [...placed, ...keep.filter((marker) => marker.source !== 'placed')];
    }
  }

  /** Reads the devices off a picture again — for devices added since. */
  async relocate(id: string, devices: PictureDevice[], locator: Locator): Promise<RoomPictureRecord | null> {
    const record = this.get(id);
    const day = record ? await this.bytes(id, 'day') : null;
    if (!record || !day) return null;
    const markers = await this.readMarkers(day, devices, locator, record.markers);
    const next = this.update(id, (current) => ({ ...current, markers }));
    if (next) this.events?.emit('roomPicturesChanged', next.roomId);
    return next ?? null;
  }

  /** A person's markers, replacing the list. */
  setMarkers(id: string, markers: RoomPictureMarker[]): RoomPictureRecord | null {
    const next = this.update(id, (current) => ({ ...current, markers }));
    if (next) this.events?.emit('roomPicturesChanged', next.roomId);
    return next ?? null;
  }

  async remove(id: string): Promise<string | null> {
    const record = this.get(id);
    if (!record) return null;
    this.write(this.read().filter((candidate) => candidate.id !== id));
    await this.deleteFiles(id);
    this.events?.emit('roomPicturesChanged', record.roomId);
    return record.roomId;
  }

  /** Every picture of a room — the room was deleted. */
  async forgetRoom(roomId: string): Promise<void> {
    const gone = this.read().filter((record) => record.roomId === roomId);
    if (gone.length === 0) return;
    this.write(this.read().filter((record) => record.roomId !== roomId));
    for (const record of gone) await this.deleteFiles(record.id);
    this.events?.emit('roomPicturesChanged', roomId);
  }

  /** Keeps `maxPerRoom` for the room, then the newest within the budget. */
  private async prune(roomId: string): Promise<void> {
    const records = this.list();
    const doomed = new Set<string>();
    records
      .filter((record) => record.roomId === roomId)
      .slice(this.limits.maxPerRoom)
      .forEach((record) => doomed.add(record.id));
    let total = 0;
    for (const record of records) {
      if (doomed.has(record.id)) continue;
      total += record.bytes;
      if (total > this.limits.budgetBytes && record !== records[0]) doomed.add(record.id);
    }
    if (doomed.size === 0) return;
    this.write(this.read().filter((record) => !doomed.has(record.id)));
    for (const id of doomed) await this.deleteFiles(id);
  }

  private async assertSpace(): Promise<void> {
    try {
      mkdirSync(this.root, { recursive: true });
      const stats = await statfs(this.root);
      if (stats.bavail * stats.bsize < this.limits.minFreeBytes) throw new PictureSpaceError();
    } catch (error) {
      if (error instanceof PictureSpaceError) throw error;
    }
  }

  private fileFor(id: string, variant: 'day' | 'night'): string {
    return path.join(this.root, `${id.replace(/[^a-zA-Z0-9-]/g, '')}-${variant}.png`);
  }

  private async deleteFiles(id: string): Promise<void> {
    await rm(this.fileFor(id, 'day'), { force: true });
    await rm(this.fileFor(id, 'night'), { force: true });
  }

  private update(id: string, change: (record: RoomPictureRecord) => RoomPictureRecord): RoomPictureRecord | undefined {
    let next: RoomPictureRecord | undefined;
    this.write(
      this.read().map((record) => {
        if (record.id !== id) return record;
        next = change(record);
        return next;
      }),
    );
    return next;
  }

  private read(): RoomPictureRecord[] {
    if (this.records) return this.records;
    try {
      const parsed = JSON.parse(readFileSync(this.manifest, 'utf8')) as { pictures?: unknown };
      this.records = Array.isArray(parsed.pictures)
        ? (parsed.pictures.filter((entry) => typeof entry === 'object' && entry !== null) as RoomPictureRecord[]).map(
            (record) => ({ ...record, markers: Array.isArray(record.markers) ? record.markers : [] }),
          )
        : [];
    } catch {
      this.records = [];
    }
    return this.records;
  }

  /** Beside a temporary and renamed over, so a power cut leaves the last list. */
  private write(records: RoomPictureRecord[]): void {
    mkdirSync(this.root, { recursive: true });
    const temporary = `${this.manifest}.tmp`;
    writeFileSync(temporary, JSON.stringify({ pictures: records }));
    renameSync(temporary, this.manifest);
    this.records = records;
  }
}
