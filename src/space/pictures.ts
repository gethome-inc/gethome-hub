import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readFile, rm, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AiRunLog } from '../core/ai-runs.js';
import type { HubEventBus } from '../core/bus.js';
import type { Logger } from '../logging.js';
import { drawRoomPicture, pictureCostUsd, RoomPictureDrawError, ROOM_PICTURE_MODEL } from './picture-draw.js';
import { dayPrompt, NIGHT_PROMPT } from './picture-prompts.js';

/**
 * Pictures of the home's rooms: the plain 3D model of a room, redrawn by an
 * image model in the room's own colours from photos of it — by day, and the
 * same picture by night.
 *
 * **It is the house's, so it lives here** — the portraits' argument, and the
 * plan's. One person draws the living room and everybody's 3D view shows it.
 *
 * **The hub keeps pictures and never looks inside them.** The app renders the
 * clay model (it has the plan and the renderer), sends it with the photos and
 * the camera it rendered from, and gets back a record with that camera on it;
 * the camera is the app's vocabulary and is kept exactly as sent, the plan's
 * rule. The night picture comes back on an opaque ground and the apps cut it
 * out with the day picture's own outline — no image library on this board,
 * for the portraits' reason.
 *
 * **Files and a manifest, the plan's shape rather than a table.** A picture is
 * one deliberate write per press of a button, a few megabytes, so it is
 * bounded by bulk: a few per room, a budget for all of them, and a refusal to
 * draw on a nearly full card. The photos it was drawn from are not kept.
 */

/** Per room: the newest, and two to go back to. */
export const MAX_PER_ROOM = 3;

/** Per hub, every room's pictures together. */
export const BUDGET_BYTES = 200 * 1024 * 1024;

/** Below this much free disk the hub refuses to draw — the portraits' line. */
export const MIN_FREE_BYTES = 500 * 1024 * 1024;

/** The most photos one drawing is sent — the API takes sixteen images in all. */
export const MAX_PHOTOS = 8;

export type PictureSize = '1024x1536' | '1536x1024';

export interface RoomPictureRecord {
  id: string;
  /** The plan room it is a picture of. */
  roomId: string;
  at: string;
  /** The camera the app rendered the clay from — its vocabulary, kept whole. */
  view: Record<string, unknown>;
  size: PictureSize;
  /** False when the night picture could not be drawn; the day one stands alone. */
  hasNight: boolean;
  /** How many photos it was drawn from — 0 is a picture dressed by the model's guess. */
  photoCount: number;
  bytes: number;
  model: string;
  /** The plan revision it was drawn against, so an app can say a room changed since. */
  planRevision: number | null;
  drawnBy?: { id: string | null; name: string };
}

export interface PictureCapability {
  model: string;
  maxPerRoom: number;
  maxPhotos: number;
}

export interface PictureLimits {
  maxPerRoom: number;
  budgetBytes: number;
  minFreeBytes: number;
}

export interface PictureDrawInput {
  roomId: string;
  roomName: string;
  view: Record<string, unknown>;
  size: PictureSize;
  structure: Buffer;
  photos: { bytes: Buffer; contentType: string }[];
  planRevision: number | null;
  apiKey: string;
  member?: { id: string; name: string };
}

export class PictureBusyError extends Error {
  constructor() {
    super('A room picture is already being drawn.');
  }
}

export class PictureSpaceError extends Error {
  constructor() {
    super('The hub is nearly out of space, so it won’t draw another picture.');
  }
}

export class RoomPictureService {
  private readonly root: string;
  private readonly manifest: string;
  private readonly limits: PictureLimits;
  private records: RoomPictureRecord[] | null = null;
  /** One at a time: refused, not queued — every drawing bills the home. */
  private drawing = false;

  constructor(
    dataDir: string,
    private readonly events: HubEventBus | undefined,
    private readonly log: Logger | undefined,
    private readonly runs: AiRunLog | undefined,
    limits: Partial<PictureLimits> = {},
    /** For tests: stands in for the provider. */
    private readonly draw_ = drawRoomPicture,
  ) {
    this.root = path.join(dataDir, 'space', 'pictures');
    this.manifest = path.join(dataDir, 'space', 'pictures.json');
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

  /** Newest first. */
  list(): RoomPictureRecord[] {
    return [...this.read()].sort((a, b) => b.at.localeCompare(a.at));
  }

  async bytes(id: string, variant: 'day' | 'night'): Promise<Buffer | null> {
    const record = this.read().find((candidate) => candidate.id === id);
    if (!record || (variant === 'night' && !record.hasNight)) return null;
    try {
      return await readFile(this.fileFor(id, variant));
    } catch {
      return null;
    }
  }

  async remove(id: string): Promise<string | null> {
    const records = this.read();
    const record = records.find((candidate) => candidate.id === id);
    if (!record) return null;
    this.write(records.filter((candidate) => candidate.id !== id));
    await this.deleteFiles(id);
    this.events?.emit('spacePicturesChanged', record.roomId);
    return record.roomId;
  }

  /** Every picture of a room — the room left the plan. */
  async forgetRoom(roomId: string): Promise<void> {
    const records = this.read();
    const gone = records.filter((record) => record.roomId === roomId);
    if (gone.length === 0) return;
    this.write(records.filter((record) => record.roomId !== roomId));
    for (const record of gone) await this.deleteFiles(record.id);
    this.events?.emit('spacePicturesChanged', roomId);
  }

  async draw(input: PictureDrawInput): Promise<RoomPictureRecord> {
    if (this.drawing) throw new PictureBusyError();
    this.drawing = true;
    try {
      return await this.drawNow(input);
    } finally {
      this.drawing = false;
    }
  }

  private async drawNow(input: PictureDrawInput): Promise<RoomPictureRecord> {
    await this.assertSpace();
    const run = this.runs?.begin({
      kind: 'roompicture',
      adapter: 'space',
      exposesHash: '',
      provider: 'openai',
      modelId: ROOM_PICTURE_MODEL,
    });

    let day;
    try {
      day = await this.draw_({
        apiKey: input.apiKey,
        prompt: dayPrompt(input.roomName, input.photos.length),
        images: [{ bytes: input.structure, contentType: 'image/png' }, ...input.photos.slice(0, MAX_PHOTOS)],
        size: input.size,
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

    // The night is a bonus on the day, never a reason to lose it: a refusal
    // here keeps the day picture, said so by `hasNight`.
    let night;
    try {
      night = await this.draw_({
        apiKey: input.apiKey,
        prompt: NIGHT_PROMPT,
        images: [{ bytes: day.png, contentType: 'image/png' }],
        size: input.size,
        background: 'opaque',
      });
    } catch (error) {
      this.log?.warn({ err: error }, 'The night picture could not be drawn; keeping the day one.');
    }

    const id = randomUUID();
    mkdirSync(this.root, { recursive: true });
    await writeFile(this.fileFor(id, 'day'), day.png);
    if (night) await writeFile(this.fileFor(id, 'night'), night.png);
    const record: RoomPictureRecord = {
      id,
      roomId: input.roomId,
      at: new Date().toISOString(),
      view: input.view,
      size: input.size,
      hasNight: night !== undefined,
      photoCount: Math.min(input.photos.length, MAX_PHOTOS),
      bytes: day.png.byteLength + (night?.png.byteLength ?? 0),
      model: ROOM_PICTURE_MODEL,
      planRevision: input.planRevision,
      ...(input.member ? { drawnBy: { id: input.member.id, name: input.member.name } } : {}),
    };
    this.write([...this.read(), record]);
    await this.prune(input.roomId);

    const costUsd = pictureCostUsd([day.usage, night?.usage]);
    await run?.finish({ ok: true, ...(costUsd !== undefined ? { costUsd } : {}) });
    this.events?.emit('spacePicturesChanged', input.roomId);
    return record;
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
      // The newest always stays, whatever it weighs.
      if (total > this.limits.budgetBytes && record !== records[0]) doomed.add(record.id);
    }
    if (doomed.size === 0) return;
    this.write(this.read().filter((record) => !doomed.has(record.id)));
    for (const id of doomed) await this.deleteFiles(id);
  }

  private async assertSpace(): Promise<void> {
    try {
      const stats = await statfs(path.dirname(this.root));
      if (stats.bavail * stats.bsize < this.limits.minFreeBytes) throw new PictureSpaceError();
    } catch (error) {
      if (error instanceof PictureSpaceError) throw error;
      // A filesystem that can't say is not one to refuse on.
    }
  }

  private fileFor(id: string, variant: 'day' | 'night'): string {
    return path.join(this.root, `${id.replace(/[^a-zA-Z0-9-]/g, '')}-${variant}.png`);
  }

  private async deleteFiles(id: string): Promise<void> {
    await rm(this.fileFor(id, 'day'), { force: true });
    await rm(this.fileFor(id, 'night'), { force: true });
  }

  private read(): RoomPictureRecord[] {
    if (this.records) return this.records;
    try {
      const parsed = JSON.parse(readFileSync(this.manifest, 'utf8')) as { pictures?: unknown };
      this.records = Array.isArray(parsed.pictures)
        ? (parsed.pictures.filter((entry) => typeof entry === 'object' && entry !== null) as RoomPictureRecord[])
        : [];
    } catch {
      this.records = [];
    }
    return this.records;
  }

  /** Beside a temporary and renamed over, so a power cut leaves the last list. */
  private write(records: RoomPictureRecord[]): void {
    mkdirSync(path.dirname(this.manifest), { recursive: true });
    const temporary = `${this.manifest}.tmp`;
    writeFileSync(temporary, JSON.stringify({ pictures: records }));
    renameSync(temporary, this.manifest);
    this.records = records;
  }
}
