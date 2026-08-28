import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { devicePortraits } from '../db/schema.js';
import type { HubEventBus } from '../core/bus.js';
import type { Logger } from '../logging.js';
import type { DeviceKind } from '../schema/index.js';
import type { AiProvider } from '../core/settings.js';
import { drawPortrait, PORTRAIT_MODEL } from './openai-images.js';
import { EDIT_PROMPT, generatePrompt } from './prompts.js';

/**
 * A device's portraits: the picture the apps float on its page, drawn once and
 * shared by everybody in the home.
 *
 * **The bytes are files, the record is a row.** A 1024² transparent PNG is a
 * megabyte or two; putting that in SQLite would push it through the WAL and
 * every checkpoint, which is the write amplification the whole store is
 * arranged around. Files sit under `<data>/portraits/`, inside the systemd
 * unit's `ReadWritePaths`, beside `update/` and matter.js's own storage.
 *
 * **This is not the `STATE_FLUSH_MS` case, and the difference is the point.**
 * Every other bound in this repository is about write *frequency* — a power
 * meter reporting for ever onto an SD card. A portrait is one deliberate write
 * per press of a button. What it needs instead is a bound on *bulk*, and it
 * gets the two this codebase always uses: how many a device keeps, and how much
 * disk the lot may take. Plus a third that only a large file needs — refusing
 * to write at all when the card is nearly full, because filling the card the
 * home runs on is a far worse outcome than not getting a picture.
 *
 * **No thumbnails are made here.** That would mean an image library — a native
 * dependency, cross-compiled, on a board with 415 MB of RAM — for something
 * each app already derives from the full PNG and caches locally.
 */

/** Per device. Enough to browse and go back to one; not a photo album. */
export const MAX_PER_DEVICE = 6;

/** Per hub. About 150 portraits, an order of magnitude more than a home makes. */
export const BUDGET_BYTES = 300 * 1024 * 1024;

/**
 * Below this much free disk the hub refuses to draw. A Pi's card holds the
 * home's database, its Zigbee network key and its logs, and none of those
 * survive a full disk well.
 */
export const MIN_FREE_BYTES = 500 * 1024 * 1024;

export interface PortraitRecord {
  id: string;
  at: string;
  bytes: number;
  provider: AiProvider;
  model: string;
  fromPhoto: boolean;
  selected: boolean;
}

/** What `GET /hub` carries. Its *presence* is what says this hub can draw. */
export interface PortraitCapability {
  model: string;
  maxPerDevice: number;
  budgetBytes: number;
}

/**
 * The three numbers, overridable so a suite can prove the bounds without
 * writing three hundred megabytes — the same seam `GETHOME_ZIGBEE_SCAN_DIR`
 * gives the coordinator detector.
 */
export interface PortraitLimits {
  maxPerDevice: number;
  budgetBytes: number;
  minFreeBytes: number;
}

export interface DrawInput {
  deviceId: string;
  kind: DeviceKind;
  apiKey: string;
  photo?: { bytes: Buffer; contentType: string };
}

export class PortraitService {
  private readonly root: string;
  private readonly limits: PortraitLimits;
  /**
   * One at a time, hub-wide: a Zero 2 W holds two of these in memory at once.
   *
   * A second asker is **refused, not queued**, and the reason is money before
   * it is anything else: every drawing bills the home, so a queue turns four
   * impatient taps into four charges while a refusal makes the second one
   * free. The rest follows — one image in memory at a time on a 512 MB board,
   * and a `409` that arrives at once and names the reason, which is what the
   * apps show, rather than a connection held open behind somebody else's.
   */
  private drawing = false;

  constructor(
    private readonly db: Db,
    private readonly events: HubEventBus,
    dataDir: string,
    private readonly log: Logger,
    limits: Partial<PortraitLimits> = {},
  ) {
    this.limits = {
      maxPerDevice: limits.maxPerDevice ?? MAX_PER_DEVICE,
      budgetBytes: limits.budgetBytes ?? BUDGET_BYTES,
      minFreeBytes: limits.minFreeBytes ?? MIN_FREE_BYTES,
    };
    this.root = path.join(dataDir, 'portraits');
    // The rows go with the device by cascade; the files do not. Same wiring as
    // `FavoritesService` and `HistoryService`, and for the same reason: the
    // delete is done by the database, so nothing else would ever hear about it.
    events.on('deviceRemoved', (deviceId) => {
      void this.forgetDevice(deviceId);
    });
  }

  describe(): PortraitCapability {
    return {
      model: PORTRAIT_MODEL,
      maxPerDevice: this.limits.maxPerDevice,
      budgetBytes: this.limits.budgetBytes,
    };
  }

  async list(deviceId: string): Promise<PortraitRecord[]> {
    const rows = await this.db
      .select()
      .from(devicePortraits)
      .where(eq(devicePortraits.deviceId, deviceId))
      .orderBy(desc(devicePortraits.at));
    return rows.map((row) => ({
      id: row.id,
      at: row.at.toISOString(),
      bytes: row.bytes,
      provider: row.provider as AiProvider,
      model: row.model,
      fromPhoto: row.fromPhoto,
      selected: row.selected,
    }));
  }

  /**
   * The PNG, with a strong ETag so a phone downloads each portrait once.
   *
   * A portrait's bytes never change — a new one is a new id — so the etag is
   * the id itself, and the route may answer `immutable`.
   */
  async read(id: string): Promise<{ bytes: Buffer; etag: string } | null> {
    const row = await this.row(id);
    if (!row) return null;
    try {
      const bytes = await readFile(this.fileFor(row.deviceId, row.id));
      return { bytes, etag: `"${createHash('sha1').update(row.id).digest('hex')}"` };
    } catch {
      // The row outlived its file — a half-finished write, or somebody tidying
      // the data directory. Say "gone" rather than 500: the app draws its
      // sphere, and the next generation replaces the row.
      this.log.warn({ portraitId: id }, 'Portrait row has no file on disk.');
      return null;
    }
  }

  /**
   * Draw one. Serialised hub-wide, and the flag is taken *before the first
   * await* — which is what makes the space check below safe, since two
   * requests can no longer both pass it and then both write.
   */
  async draw(input: DrawInput): Promise<PortraitRecord> {
    if (this.drawing) throw new PortraitBusyError();
    this.drawing = true;
    try {
      return await this.drawNow(input);
    } finally {
      this.drawing = false;
    }
  }

  private async drawNow(input: DrawInput): Promise<PortraitRecord> {
    await this.assertSpace();
    // Imported normally, unlike the mapper behind `lazy.ts`: what that seam
    // exists to keep out of a keyless hub's memory is an SDK, and this is
    // `fetch` and two prompt strings.
    const png = await drawPortrait({
      apiKey: input.apiKey,
      prompt: input.photo ? EDIT_PROMPT : generatePrompt(input.kind),
      ...(input.photo !== undefined ? { photo: input.photo } : {}),
    });
    return this.store(input.deviceId, png, {
      provider: 'openai',
      model: PORTRAIT_MODEL,
      fromPhoto: input.photo !== undefined,
    });
  }

  private async store(
    deviceId: string,
    png: Buffer,
    meta: { provider: AiProvider; model: string; fromPhoto: boolean },
  ): Promise<PortraitRecord> {
    const id = randomUUID();
    await mkdir(path.join(this.root, safeSegment(deviceId)), { recursive: true });
    await writeFile(this.fileFor(deviceId, id), png);
    // The new one is what the home sees. Somebody who preferred an older
    // portrait — or the sphere — asked for this one knowing that.
    await this.db.update(devicePortraits).set({ selected: false }).where(eq(devicePortraits.deviceId, deviceId));
    await this.db.insert(devicePortraits).values({
      id,
      deviceId,
      bytes: png.byteLength,
      provider: meta.provider,
      model: meta.model,
      fromPhoto: meta.fromPhoto,
      selected: true,
    });
    await this.prune(deviceId);
    const stored = (await this.list(deviceId)).find((record) => record.id === id);
    if (!stored) throw new Error('portrait row vanished immediately after it was written');
    return stored;
  }

  /**
   * Which one the apps draw. `null` is a state rather than an absence: it means
   * somebody chose the procedural sphere over every picture they have, which is
   * a choice the apps have always offered and which would otherwise need a
   * column of its own to express.
   */
  async select(deviceId: string, portraitId: string | null): Promise<boolean> {
    if (portraitId !== null) {
      const row = await this.row(portraitId);
      if (!row || row.deviceId !== deviceId) return false;
    }
    await this.db.update(devicePortraits).set({ selected: false }).where(eq(devicePortraits.deviceId, deviceId));
    if (portraitId !== null) {
      await this.db
        .update(devicePortraits)
        .set({ selected: true })
        .where(and(eq(devicePortraits.id, portraitId), eq(devicePortraits.deviceId, deviceId)));
    }
    return true;
  }

  /** Returns the device the portrait belonged to, so the caller can announce it. */
  async remove(id: string): Promise<string | null> {
    const row = await this.row(id);
    if (!row) return null;
    await this.db.delete(devicePortraits).where(eq(devicePortraits.id, id));
    await this.unlink(row.deviceId, row.id);
    // Deleting the picture a home was looking at must not quietly turn the
    // device back into a sphere: `null` means somebody *chose* the sphere, and
    // nobody did. The newest remaining takes the slot, which is the same rule
    // `store` follows when a new one arrives. `prune` never reaches this — it
    // refuses to evict a selected portrait in the first place.
    if (row.selected) await this.promoteNewest(row.deviceId);
    return row.deviceId;
  }

  /** The newest portrait a device still has becomes the one the home sees. */
  private async promoteNewest(deviceId: string): Promise<void> {
    const [newest] = await this.db
      .select({ id: devicePortraits.id })
      .from(devicePortraits)
      .where(eq(devicePortraits.deviceId, deviceId))
      .orderBy(desc(devicePortraits.at))
      .limit(1);
    if (!newest) return;
    await this.db.update(devicePortraits).set({ selected: true }).where(eq(devicePortraits.id, newest.id));
  }

  /**
   * The row goes with the device by cascade; the files do not, so this is wired
   * to `deviceRemoved` for the same reason `FavoritesService.forgetDevice` is.
   */
  async forgetDevice(deviceId: string): Promise<void> {
    await rm(path.join(this.root, safeSegment(deviceId)), { recursive: true, force: true }).catch(() => undefined);
  }

  // ── Bounds ────────────────────────────────────────────────────────────────

  /** Refuse before spending money, not after: OpenAI has already billed by then. */
  private async assertSpace(): Promise<void> {
    let free: number;
    try {
      const stats = await statfs(this.root).catch(async () => {
        await mkdir(this.root, { recursive: true });
        return statfs(this.root);
      });
      free = stats.bavail * stats.bsize;
    } catch {
      // A filesystem that will not answer is not a reason to refuse — the write
      // itself is about to say so far more accurately.
      return;
    }
    if (free < this.limits.minFreeBytes) {
      throw new PortraitSpaceError(
        `Your hub has ${Math.round(free / (1024 * 1024))} MB of disk left, which is too little to keep drawing.`,
      );
    }
  }

  /**
   * Two bounds, oldest first, and **a selected portrait is never evicted** —
   * dropping the picture a home is looking at to make room for one it is not
   * would be the worst possible trade. If the budget is still over after that,
   * say so once rather than deleting what is on screen.
   */
  private async prune(deviceId: string): Promise<void> {
    const mine = await this.list(deviceId);
    for (const record of mine.slice(this.limits.maxPerDevice).filter((record) => !record.selected)) {
      await this.remove(record.id);
    }

    const [used] = await this.db
      .select({ total: sql<number>`coalesce(sum(${devicePortraits.bytes}), 0)` })
      .from(devicePortraits);
    let total = used?.total ?? 0;
    if (total <= this.limits.budgetBytes) return;

    const oldest = await this.db
      .select()
      .from(devicePortraits)
      .where(eq(devicePortraits.selected, false))
      .orderBy(devicePortraits.at);
    // The sweep is hub-wide, so it takes pictures off devices nobody asked
    // about. The route announces the device being drawn and knows nothing of
    // those, and a phone left holding a portrait id that no longer exists asks
    // for bytes that answer 404 — so each one it touched is named here.
    const swept = new Set<string>();
    for (const row of oldest) {
      if (total <= this.limits.budgetBytes) break;
      await this.remove(row.id);
      total -= row.bytes;
      if (row.deviceId !== deviceId) swept.add(row.deviceId);
    }
    for (const id of swept) this.events.emit('portraitsChanged', id);
    // Only when the sweep genuinely could not get there: reaching the end of
    // the list having *just* come under budget is the sweep working, and
    // warning about it would report a healthy hub as a full one.
    if (total > this.limits.budgetBytes) {
      this.log.warn(
        { usedBytes: total, budgetBytes: this.limits.budgetBytes },
        'Device portraits are over their disk budget and every remaining one is in use.',
      );
    }
  }

  // ── Plumbing ──────────────────────────────────────────────────────────────

  private async row(id: string) {
    return this.db.query.devicePortraits.findFirst({ where: eq(devicePortraits.id, id) });
  }

  private fileFor(deviceId: string, portraitId: string): string {
    return path.join(this.root, safeSegment(deviceId), `${safeSegment(portraitId)}.png`);
  }

  private async unlink(deviceId: string, portraitId: string): Promise<void> {
    await rm(this.fileFor(deviceId, portraitId), { force: true }).catch(() => undefined);
  }
}

/**
 * Something else is already being drawn. Its own type because the way out is
 * simply to try again in a moment, which is a different sentence from every
 * other refusal this route can make.
 */
export class PortraitBusyError extends Error {
  constructor() {
    super('Your hub is already drawing a portrait. Try again in a moment.');
    this.name = 'PortraitBusyError';
  }
}

/** The card is nearly full. Its own type because the app has a way out to offer. */
export class PortraitSpaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PortraitSpaceError';
  }
}

/**
 * Ids are hub-minted UUIDs, so this can only ever be a no-op — which is exactly
 * why it is cheap to keep. A path segment built from a value that reached us
 * over HTTP is the one place a typo becomes a directory traversal.
 */
function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}
