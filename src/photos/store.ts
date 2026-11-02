import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { and, asc, eq, inArray, lt, notInArray, sql } from 'drizzle-orm';
import type { HubEventBus } from '../core/bus.js';
import type { SettingsService } from '../core/settings.js';
import type { Db } from '../db/client.js';
import { automationChatMessages, devicePortraits, keptPhotos, keptPhotoUses, memberPhotoSettings } from '../db/schema.js';
import type { Logger } from '../logging.js';
import { measureSpace, SpaceReader, type Space, type SpaceMeasure } from './space.js';

/**
 * The photos a home, or one person, chose to keep on the hub — the photos a
 * room was drawn from, the photo a portrait was drawn from, and the photos a
 * person added to a chat. `docs/api.md` (*Photos the hub keeps*) is canonical;
 * `src/photos/CLAUDE.md` has the rules.
 *
 * Five things hold it up.
 *
 * **Off, until asked twice.** A photo is kept only when the request carrying
 * it said so (`keepPhotos`) *and* the switch for its kind is on — the home's
 * for rooms and portraits, the sender's own for chat. Every app that shipped
 * before this tells people their photos stay on the device that took them, and
 * an app that never asks is an app whose sentence stays true.
 *
 * **A photo lives as long as what it is kept for.** Each one has uses — the
 * room pictures, portraits or chat messages it belongs to — and goes with the
 * last of them (`release`). So a room's photos last as long as a drawing made
 * from them, a portrait's as long as the portrait, and a chat photo as long as
 * its conversation's fortnight; the switch is about *new* photos and never
 * deletes anything by itself.
 *
 * **Room, never a board.** Photos are kept only while the hub's data partition
 * keeps more than `PHOTOS_MIN_FREE_BYTES` free after the write — far above the
 * 500 MB where drawing stops, so photos always stop first and never cost the
 * home a drawing — and resume at `PHOTOS_RESUME_FREE_BYTES`. Nothing kept is
 * deleted to make room: a full disk pauses keeping, and says so.
 *
 * **Storing is not processing.** A photo is written from the buffer the route
 * already decoded: no copy, no re-encode, no thumbnail and no image library —
 * the portraits' rule, for a board whose RAM is spent on drawing.
 *
 * **Keeping is not sending.** Nothing here reaches a provider. A kept photo is
 * sent again only when somebody draws again from it, through the ordinary
 * drawing routes.
 */

export const PHOTO_KINDS = ['room', 'portrait', 'chat'] as const;
export type PhotoKind = (typeof PHOTO_KINDS)[number];
/** The kinds that are the home's to switch — chat is each person's own. */
export const HOME_PHOTO_KINDS = ['room', 'portrait'] as const;
export type HomePhotoKind = (typeof HOME_PHOTO_KINDS)[number];

const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;

/** Keep nothing new that would leave less than this free. */
export const PHOTOS_MIN_FREE_BYTES = 2 * GIB;
/** Once paused for space, start again only with this much free. */
export const PHOTOS_RESUME_FREE_BYTES = PHOTOS_MIN_FREE_BYTES + 512 * MIB;
/**
 * Every member's chat photos together. A safety net rather than a target: a
 * fortnight of somebody sending a photo or two a day is tens of megabytes, and
 * past this the oldest go first — they would go within the fortnight anyway.
 */
export const CHAT_PHOTOS_BUDGET_BYTES = 512 * MIB;
/**
 * How long a chat photo is kept: the fortnight its conversation is — kept in
 * step with `RETAIN_TRANSCRIPT_DAYS` (`src/ai/chat/chat-runtime.ts`), which a
 * suite holds the two together on. A number of its own rather than an import,
 * so this module pulls nothing from the AI subsystem.
 */
export const CHAT_PHOTO_RETAIN_DAYS = 14;
/**
 * A photo with no use left is deleted at once by `release`; this is for the
 * ones that never got a use at all — written, and then the drawing or the row
 * they were for did not land. Long enough that a sweep can never meet one in
 * the moment between being written and being attached.
 */
const ORPHAN_GRACE_MS = 60 * 60_000;
/** How often the chat fortnight, the budget and the orphans are swept. */
const SWEEP_MS = 60 * 60_000;

const SETTING_KEY: Record<HomePhotoKind, string> = {
  room: 'photos_keep_rooms',
  portrait: 'photos_keep_portraits',
};

const EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** The bounds, overridable so a suite can prove them without filling a disk. */
export interface PhotoLimits {
  minFreeBytes: number;
  resumeFreeBytes: number;
  chatBudgetBytes: number;
  chatRetainDays: number;
}

/** What `GET /hub` carries. Its presence is what says this hub can keep photos. */
export interface PhotoCapability {
  kinds: readonly PhotoKind[];
  minFreeBytes: number;
  chatRetainDays: number;
}

/**
 * Why a photo that was asked to be kept was not. An open word on the wire,
 * the `commandFailed.kind` rule: an app falls back for one it has never met.
 */
export type KeepRefusal = 'off' | 'low-space' | 'failed';

/** What happened to the photos a request asked to keep. */
export interface KeepOutcome {
  kept: number;
  reason?: KeepRefusal;
}

export interface PhotoInput {
  bytes: Buffer;
  mediaType: string;
  width?: number | undefined;
  height?: number | undefined;
  /** A chat photo's name in the app that sent it. */
  ref?: string | undefined;
}

export interface PhotoRecord {
  id: string;
  kind: string;
  subjectId: string;
  at: string;
  bytes: number;
  mediaType: string;
  width?: number;
  height?: number;
  ref?: string;
  /** Who took or sent it; `id` is null once they have left the home. */
  takenBy?: { id: string | null; name: string };
}

/** One kind, as `GET /photos` reports it. */
export interface KindState {
  keep: boolean;
  count: number;
  bytes: number;
}

/** `GET /photos`, before the route adds what was drawn. */
export interface PhotosState {
  /** Absent when the disk would not say. */
  space?: Space;
  minFreeBytes: number;
  /** True while the hub would keep nothing new for lack of room. */
  paused: boolean;
  reason?: 'low-space';
  chatRetainDays: number;
  home: Record<HomePhotoKind, KindState>;
  mine: { chat: KindState & { clearedAt?: string } };
}

type PhotoRow = typeof keptPhotos.$inferSelect;

export class PhotoStore {
  private readonly root: string;
  private readonly limits: PhotoLimits;
  private readonly space: SpaceReader;
  /** Whether keeping is paused for room — the hysteresis between the two bounds. */
  private paused = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Db,
    private readonly settings: Pick<SettingsService, 'get' | 'set' | 'unset'>,
    dataDir: string,
    private readonly events?: HubEventBus | undefined,
    private readonly log?: Logger | undefined,
    limits: Partial<PhotoLimits> = {},
    measure: SpaceMeasure = measureSpace,
    private readonly now: () => number = Date.now,
  ) {
    this.root = path.join(dataDir, 'photos');
    this.limits = {
      minFreeBytes: limits.minFreeBytes ?? PHOTOS_MIN_FREE_BYTES,
      resumeFreeBytes: limits.resumeFreeBytes ?? PHOTOS_RESUME_FREE_BYTES,
      chatBudgetBytes: limits.chatBudgetBytes ?? CHAT_PHOTOS_BUDGET_BYTES,
      chatRetainDays: limits.chatRetainDays ?? CHAT_PHOTO_RETAIN_DAYS,
    };
    this.space = new SpaceReader(dataDir, measure);
  }

  /** Static, because `GET /hub` is the health check and must never throw. */
  describe(): PhotoCapability {
    return {
      kinds: PHOTO_KINDS,
      minFreeBytes: this.limits.minFreeBytes,
      chatRetainDays: this.limits.chatRetainDays,
    };
  }

  // ── The switches ──────────────────────────────────────────────────────────

  async homeSwitches(): Promise<Record<HomePhotoKind, boolean>> {
    return {
      room: (await this.settings.get<boolean>(SETTING_KEY.room)) === true,
      portrait: (await this.settings.get<boolean>(SETTING_KEY.portrait)) === true,
    };
  }

  /**
   * Turn the home's switches. `true` is written and off is the key's absence,
   * the `update_automatic` pattern — so a hub that has never heard of this, or
   * a rollback to one, reads "off" for both.
   */
  async setHome(change: { [kind in HomePhotoKind]?: boolean | undefined }): Promise<Record<HomePhotoKind, boolean>> {
    for (const kind of HOME_PHOTO_KINDS) {
      const on = change[kind];
      if (on === undefined) continue;
      if (on) await this.settings.set(SETTING_KEY[kind], true);
      else await this.settings.unset(SETTING_KEY[kind]);
    }
    this.events?.emit('photosChanged', null);
    return this.homeSwitches();
  }

  async memberKeepsChat(memberId: string): Promise<boolean> {
    const row = await this.db.query.memberPhotoSettings.findFirst({
      where: eq(memberPhotoSettings.memberId, memberId),
    });
    return row?.keepChat === true;
  }

  async setMine(memberId: string, keepChat: boolean): Promise<void> {
    await this.db
      .insert(memberPhotoSettings)
      .values({ memberId, keepChat })
      .onConflictDoUpdate({ target: memberPhotoSettings.memberId, set: { keepChat } });
    this.events?.emit('photosChanged', memberId);
  }

  // ── What there is ─────────────────────────────────────────────────────────

  async state(memberId: string): Promise<PhotosState> {
    const space = await this.space.read(this.now());
    const paused = !this.judge(space, 0);
    const switches = await this.homeSwitches();
    const totals = await this.db
      .select({
        kind: keptPhotos.kind,
        count: sql<number>`count(*)`,
        bytes: sql<number>`coalesce(sum(${keptPhotos.bytes}), 0)`,
      })
      .from(keptPhotos)
      .where(inArray(keptPhotos.kind, [...HOME_PHOTO_KINDS]))
      .groupBy(keptPhotos.kind);
    const [mine] = await this.db
      .select({ count: sql<number>`count(*)`, bytes: sql<number>`coalesce(sum(${keptPhotos.bytes}), 0)` })
      .from(keptPhotos)
      .where(and(eq(keptPhotos.kind, 'chat'), eq(keptPhotos.subjectId, memberId)));
    const settingsRow = await this.db.query.memberPhotoSettings.findFirst({
      where: eq(memberPhotoSettings.memberId, memberId),
    });
    const totalOf = (kind: HomePhotoKind) => totals.find((row) => row.kind === kind);
    return {
      ...(space !== null ? { space } : {}),
      minFreeBytes: this.limits.minFreeBytes,
      paused,
      ...(paused ? { reason: 'low-space' as const } : {}),
      chatRetainDays: this.limits.chatRetainDays,
      home: {
        room: { keep: switches.room, count: totalOf('room')?.count ?? 0, bytes: totalOf('room')?.bytes ?? 0 },
        portrait: {
          keep: switches.portrait,
          count: totalOf('portrait')?.count ?? 0,
          bytes: totalOf('portrait')?.bytes ?? 0,
        },
      },
      mine: {
        chat: {
          keep: settingsRow?.keepChat === true,
          count: mine?.count ?? 0,
          bytes: mine?.bytes ?? 0,
          ...(settingsRow?.chatClearedAt ? { clearedAt: settingsRow.chatClearedAt.toISOString() } : {}),
        },
      },
    };
  }

  async get(id: string): Promise<PhotoRecord | null> {
    const row = await this.db.query.keptPhotos.findFirst({ where: eq(keptPhotos.id, id) });
    return row ? recordOf(row) : null;
  }

  /** The bytes, for an app to draw or a drawing to be made again from. */
  async read(id: string): Promise<{ record: PhotoRecord; bytes: Buffer } | null> {
    const row = await this.db.query.keptPhotos.findFirst({ where: eq(keptPhotos.id, id) });
    if (!row) return null;
    try {
      return { record: recordOf(row), bytes: await readFile(this.fileFor(row.id, row.mediaType)) };
    } catch {
      // The row outlived its file — somebody tidying the data directory, or a
      // write cut short. Say "gone": the app draws its placeholder, and the
      // next reconcile takes the row.
      this.log?.warn({ photoId: id }, 'Kept photo row has no file on disk.');
      return null;
    }
  }

  /** The photos kept for each of these uses, oldest first. */
  async forUses(useIds: readonly string[]): Promise<Map<string, PhotoRecord[]>> {
    const result = new Map<string, PhotoRecord[]>();
    if (useIds.length === 0) return result;
    const rows = await this.db
      .select({ useId: keptPhotoUses.useId, photo: keptPhotos })
      .from(keptPhotoUses)
      .innerJoin(keptPhotos, eq(keptPhotos.id, keptPhotoUses.photoId))
      .where(inArray(keptPhotoUses.useId, [...useIds]))
      .orderBy(asc(keptPhotos.at));
    for (const row of rows) {
      const list = result.get(row.useId) ?? [];
      list.push(recordOf(row.photo));
      result.set(row.useId, list);
    }
    return result;
  }

  // ── Keeping ───────────────────────────────────────────────────────────────

  /**
   * Keep these photos, if the switch for their kind is on and the hub has
   * room — and attach them to `useId` when there is one already.
   *
   * Answers an id per photo (null where it was not kept) and what happened, so
   * the route can say it at once. **Never throws**: a photo the hub could not
   * keep is a photo that stays where it was, which is how every photo worked
   * before this, and nothing a drawing or a message did may fail on it.
   */
  async keep(input: {
    kind: PhotoKind;
    subjectId: string;
    /** Who took or sent them. A chat photo needs no name: it is only ever its sender's. */
    member?: { id: string; name?: string | undefined } | undefined;
    photos: readonly PhotoInput[];
    useId?: string | undefined;
  }): Promise<{ ids: (string | null)[]; outcome: KeepOutcome }> {
    const none = (reason: KeepRefusal) => ({ ids: input.photos.map(() => null), outcome: { kept: 0, reason } });
    if (input.photos.length === 0) return { ids: [], outcome: { kept: 0 } };
    try {
      const on =
        input.kind === 'chat'
          ? input.member !== undefined && (await this.memberKeepsChat(input.member.id))
          : (await this.homeSwitches())[input.kind];
      if (!on) return none('off');

      // The same photo sent again for the same room or device — a room drawn
      // again from the photos the phone that took them still has — is the copy
      // already here, attached to the new use rather than written a second
      // time, so a room drawn five times from one walk round it keeps one set.
      // It costs no room, so it is attached even while keeping is paused.
      // Chat photos are never compared: each is its sender's, for one message.
      const copies: (string | undefined)[] = [];
      for (const photo of input.photos) {
        copies.push(input.kind === 'chat' ? undefined : await this.keptCopyOf(input.kind, input.subjectId, photo.bytes));
      }
      const fresh = input.photos.filter((_, index) => copies[index] === undefined);
      const incoming = fresh.reduce((sum, photo) => sum + photo.bytes.byteLength, 0);
      const fits = fresh.length === 0 || this.judge(await this.space.read(this.now()), incoming);
      if (!fits && fresh.length === input.photos.length) return none('low-space');
      if (fits && input.kind === 'chat') await this.fitChat(incoming);

      if (fits && fresh.length > 0) await mkdir(this.root, { recursive: true });
      const ids: (string | null)[] = [];
      let failed = false;
      for (const [index, photo] of input.photos.entries()) {
        const copy = copies[index];
        if (copy !== undefined) {
          const attached = input.useId === undefined || (await this.attach([copy], input.useId)).length > 0;
          ids.push(attached ? copy : null);
          if (!attached) failed = true;
          continue;
        }
        if (!fits) {
          ids.push(null);
          continue;
        }
        const id = randomUUID();
        try {
          const file = this.fileFor(id, photo.mediaType);
          // Beside a temporary and renamed over, so a power cut leaves either
          // the whole photo or none of it — never half a JPEG with a row.
          await writeFile(`${file}.tmp`, photo.bytes, { mode: 0o600 });
          await rename(`${file}.tmp`, file);
          await this.db.insert(keptPhotos).values({
            id,
            kind: input.kind,
            subjectId: input.subjectId,
            memberId: input.member?.id ?? null,
            memberName: input.member?.name ?? null,
            ref: photo.ref ?? null,
            mediaType: photo.mediaType,
            bytes: photo.bytes.byteLength,
            width: photo.width ?? null,
            height: photo.height ?? null,
            // The store's own clock, which is the one the fortnight is swept by.
            at: new Date(this.now()),
          });
          if (input.useId !== undefined) {
            await this.db.insert(keptPhotoUses).values({ photoId: id, useId: input.useId }).onConflictDoNothing();
          }
          ids.push(id);
        } catch (error) {
          failed = true;
          ids.push(null);
          await rm(this.fileFor(id, photo.mediaType), { force: true }).catch(() => undefined);
          this.log?.warn({ err: error, kind: input.kind }, 'A photo could not be kept.');
        }
      }
      this.space.invalidate();
      const kept = ids.filter((id) => id !== null).length;
      if (kept > 0) this.events?.emit('photosChanged', input.kind === 'chat' ? (input.member?.id ?? null) : null);
      const reason: KeepRefusal | undefined = failed ? 'failed' : fits ? undefined : 'low-space';
      return { ids, outcome: { kept, ...(reason !== undefined ? { reason } : {}) } };
    } catch (error) {
      this.log?.warn({ err: error, kind: input.kind }, 'Photos could not be kept.');
      return none('failed');
    }
  }

  /**
   * A photo of this room or device already kept with exactly these bytes. The
   * hub stores a photo as it was sent and never re-encodes one, so a photo
   * sent twice is the same bytes twice; only rows of the same size are read.
   */
  private async keptCopyOf(kind: PhotoKind, subjectId: string, bytes: Buffer): Promise<string | undefined> {
    const candidates = await this.db
      .select({ id: keptPhotos.id, mediaType: keptPhotos.mediaType })
      .from(keptPhotos)
      .where(and(eq(keptPhotos.kind, kind), eq(keptPhotos.subjectId, subjectId), eq(keptPhotos.bytes, bytes.byteLength)));
    for (const candidate of candidates) {
      const stored = await readFile(this.fileFor(candidate.id, candidate.mediaType)).catch(() => undefined);
      if (stored?.equals(bytes) === true) return candidate.id;
    }
    return undefined;
  }

  /**
   * Attach photos already kept to another use — a drawing made again from
   * them. Answers the ids it attached: one that went in the meantime (deleted
   * while the drawing ran) is left out with a line in the log, never thrown
   * into a drawing the home has already paid for.
   */
  async attach(photoIds: readonly string[], useId: string): Promise<string[]> {
    const attached: string[] = [];
    for (const photoId of photoIds) {
      try {
        await this.db.insert(keptPhotoUses).values({ photoId, useId }).onConflictDoNothing();
        attached.push(photoId);
      } catch (error) {
        this.log?.warn({ err: error, photoId, useId }, 'A kept photo could not be attached to what was drawn from it.');
      }
    }
    return attached;
  }

  /**
   * What `useId` was kept for has gone — a drawing deleted or pruned, a
   * portrait removed. Its photos go too, unless something else still uses them.
   */
  async release(useId: string): Promise<number> {
    const gone = await this.db
      .delete(keptPhotoUses)
      .where(eq(keptPhotoUses.useId, useId))
      .returning({ photoId: keptPhotoUses.photoId });
    if (gone.length === 0) return 0;
    const candidates = [...new Set(gone.map((row) => row.photoId))];
    const stillUsed = await this.db
      .select({ photoId: keptPhotoUses.photoId })
      .from(keptPhotoUses)
      .where(inArray(keptPhotoUses.photoId, candidates));
    const used = new Set(stillUsed.map((row) => row.photoId));
    const doomed = candidates.filter((id) => !used.has(id));
    return this.deleteRows(await this.rowsById(doomed));
  }

  /** Every photo of one subject — a room deleted, a device removed. */
  async forgetSubject(kind: PhotoKind, subjectId: string): Promise<number> {
    const rows = await this.db
      .select()
      .from(keptPhotos)
      .where(and(eq(keptPhotos.kind, kind), eq(keptPhotos.subjectId, subjectId)));
    return this.deleteRows(rows);
  }

  /**
   * Somebody left the home. Their chat photos go with them — nobody else could
   * ever see those — while a room or a portrait photo they took stays the
   * house's, with their name kept on it.
   */
  async forgetMember(memberId: string): Promise<number> {
    const removed = await this.forgetSubject('chat', memberId);
    await this.db.delete(memberPhotoSettings).where(eq(memberPhotoSettings.memberId, memberId));
    return removed;
  }

  /**
   * Delete every kept photo of one of the home's kinds. Answers what went, so
   * the route can say how many and tell each room or device that changed.
   */
  async deleteHome(kind: HomePhotoKind): Promise<{ count: number; subjects: string[] }> {
    const rows = await this.db.select().from(keptPhotos).where(eq(keptPhotos.kind, kind));
    const count = await this.deleteRows(rows);
    return { count, subjects: [...new Set(rows.map((row) => row.subjectId))] };
  }

  /**
   * Delete one person's chat photos, and remember when — the moment their
   * other devices let go of their own copies from, including one that was
   * away when it happened.
   */
  async clearChat(memberId: string): Promise<{ count: number; clearedAt: string }> {
    const count = await this.forgetSubject('chat', memberId);
    const at = new Date(this.now());
    await this.db
      .insert(memberPhotoSettings)
      .values({ memberId, chatClearedAt: at })
      .onConflictDoUpdate({ target: memberPhotoSettings.memberId, set: { chatClearedAt: at } });
    this.events?.emit('photosChanged', memberId);
    return { count, clearedAt: at.toISOString() };
  }

  /** Delete one photo, from every use it had. */
  async remove(id: string): Promise<PhotoRecord | null> {
    const rows = await this.rowsById([id]);
    const row = rows[0];
    if (!row) return null;
    await this.deleteRows(rows);
    return recordOf(row);
  }

  // ── Upkeep ────────────────────────────────────────────────────────────────

  /** The hourly sweep, on a timer that never keeps the process alive. */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.sweep().catch((error: unknown) => this.log?.warn({ err: error }, 'Photo sweep failed.'));
    }, SWEEP_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * The chat fortnight, the chat budget, and photos that never found a use.
   *
   * On a clock rather than hung off the next write — the activity log's way —
   * because "kept for 14 days" is a promise about somebody's pictures, and a
   * quiet hub that wrote nothing for a month must still keep it.
   */
  async sweep(): Promise<number> {
    const now = this.now();
    const expired = await this.db
      .select()
      .from(keptPhotos)
      .where(
        and(
          eq(keptPhotos.kind, 'chat'),
          lt(keptPhotos.at, new Date(now - this.limits.chatRetainDays * 24 * 60 * 60_000)),
        ),
      );
    let removed = await this.deleteRows(expired);
    const unused = await this.db
      .select()
      .from(keptPhotos)
      .where(
        and(
          lt(keptPhotos.at, new Date(now - ORPHAN_GRACE_MS)),
          notInArray(keptPhotos.id, this.db.select({ id: keptPhotoUses.photoId }).from(keptPhotoUses)),
        ),
      );
    removed += await this.deleteRows(unused);
    removed += await this.fitChat(0);
    return removed;
  }

  /**
   * Put the store and the disk back in agreement, once, at boot.
   *
   * Three disagreements are possible, and an older build after a rollback can
   * make the first: a use whose drawing, portrait or message is gone (the
   * older build deleted it without knowing about photos); a row whose file is
   * gone; and a file — or a half-written temporary — with no row. Room
   * pictures live in a manifest rather than a table, so their ids are handed
   * in; portraits and messages are read here.
   */
  async reconcile(valid: { roomPictureIds?: Iterable<string> } = {}): Promise<void> {
    try {
      const portraits = this.db.select({ id: devicePortraits.id }).from(devicePortraits);
      const messages = this.db.select({ id: automationChatMessages.id }).from(automationChatMessages);
      const kindOf = (kind: PhotoKind) => this.db.select({ id: keptPhotos.id }).from(keptPhotos).where(eq(keptPhotos.kind, kind));
      await this.db
        .delete(keptPhotoUses)
        .where(and(inArray(keptPhotoUses.photoId, kindOf('portrait')), notInArray(keptPhotoUses.useId, portraits)));
      await this.db
        .delete(keptPhotoUses)
        .where(and(inArray(keptPhotoUses.photoId, kindOf('chat')), notInArray(keptPhotoUses.useId, messages)));
      if (valid.roomPictureIds !== undefined) {
        const rooms = [...valid.roomPictureIds];
        await this.db
          .delete(keptPhotoUses)
          .where(
            rooms.length > 0
              ? and(inArray(keptPhotoUses.photoId, kindOf('room')), notInArray(keptPhotoUses.useId, rooms))
              : inArray(keptPhotoUses.photoId, kindOf('room')),
          );
      }
      // Nothing is in flight at boot, so a photo with no use is not waiting
      // for one: it is left over.
      const orphans = await this.db
        .select()
        .from(keptPhotos)
        .where(notInArray(keptPhotos.id, this.db.select({ id: keptPhotoUses.photoId }).from(keptPhotoUses)));
      await this.deleteRows(orphans);

      const rows = await this.db.select().from(keptPhotos);
      const expected = new Map(rows.map((row) => [path.basename(this.fileFor(row.id, row.mediaType)), row]));
      // Only a folder that is not there is a folder with no files. One that
      // could not be read says nothing about them, and every row would read
      // as missing — so that is thrown to the catch below, rows untouched.
      const files = await readdir(this.root).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [] as string[];
        throw error;
      });
      const present = new Set(files);
      for (const file of files) {
        if (!expected.has(file)) await rm(path.join(this.root, file), { force: true }).catch(() => undefined);
      }
      const missing = rows.filter((row) => !present.has(path.basename(this.fileFor(row.id, row.mediaType))));
      if (missing.length > 0) {
        await this.db.delete(keptPhotos).where(inArray(keptPhotos.id, missing.map((row) => row.id)));
      }
    } catch (error) {
      // Tidying must never be what stops a hub starting.
      this.log?.warn({ err: error }, 'Kept photos could not be reconciled.');
    }
  }

  // ── Plumbing ──────────────────────────────────────────────────────────────

  /**
   * Whether `incoming` bytes may be kept, with the hysteresis between the two
   * bounds. Unknown room keeps the last judgement — the write itself says
   * whether there was space, which is the portraits' stance.
   */
  private judge(space: Space | null, incoming: number): boolean {
    if (space === null) return !this.paused;
    if (this.paused && space.freeBytes >= this.limits.resumeFreeBytes) this.paused = false;
    if (!this.paused && space.freeBytes < this.limits.minFreeBytes) this.paused = true;
    if (this.paused) return false;
    return space.freeBytes - incoming >= this.limits.minFreeBytes;
  }

  /** Make room for `incoming` within the chat budget, oldest first. */
  private async fitChat(incoming: number): Promise<number> {
    const [total] = await this.db
      .select({ bytes: sql<number>`coalesce(sum(${keptPhotos.bytes}), 0)` })
      .from(keptPhotos)
      .where(eq(keptPhotos.kind, 'chat'));
    let used = (total?.bytes ?? 0) + incoming;
    if (used <= this.limits.chatBudgetBytes) return 0;
    const oldest = await this.db
      .select()
      .from(keptPhotos)
      .where(eq(keptPhotos.kind, 'chat'))
      .orderBy(asc(keptPhotos.at));
    const doomed: PhotoRow[] = [];
    for (const row of oldest) {
      if (used <= this.limits.chatBudgetBytes) break;
      doomed.push(row);
      used -= row.bytes;
    }
    return this.deleteRows(doomed);
  }

  private async rowsById(ids: readonly string[]): Promise<PhotoRow[]> {
    if (ids.length === 0) return [];
    return this.db.select().from(keptPhotos).where(inArray(keptPhotos.id, [...ids]));
  }

  /** Rows first, then files: a file left behind is swept, a row left behind is a 404. */
  private async deleteRows(rows: readonly PhotoRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    await this.db.delete(keptPhotos).where(
      inArray(
        keptPhotos.id,
        rows.map((row) => row.id),
      ),
    );
    for (const row of rows) await rm(this.fileFor(row.id, row.mediaType), { force: true }).catch(() => undefined);
    this.space.invalidate();
    const members = new Set(rows.filter((row) => row.kind === 'chat').map((row) => row.subjectId));
    if (rows.some((row) => row.kind !== 'chat')) this.events?.emit('photosChanged', null);
    for (const member of members) this.events?.emit('photosChanged', member);
    return rows.length;
  }

  private fileFor(id: string, mediaType: string): string {
    return path.join(this.root, `${id.replace(/[^a-zA-Z0-9-]/g, '')}.${EXTENSION[mediaType] ?? 'bin'}`);
  }
}

function recordOf(row: PhotoRow): PhotoRecord {
  return {
    id: row.id,
    kind: row.kind,
    subjectId: row.subjectId,
    at: row.at.toISOString(),
    bytes: row.bytes,
    mediaType: row.mediaType,
    ...(row.width !== null ? { width: row.width } : {}),
    ...(row.height !== null ? { height: row.height } : {}),
    ...(row.ref !== null ? { ref: row.ref } : {}),
    ...(row.memberName !== null ? { takenBy: { id: row.memberId, name: row.memberName } } : {}),
  };
}
