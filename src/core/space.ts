import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { HubEventBus } from './bus.js';

/**
 * The home's 3D plan: the rooms somebody scanned with a phone, and where each
 * device stands in them.
 *
 * **It is the house's, so it lives here.** The same reasoning as rooms and
 * portraits: a plan kept on one phone is one person's. Kept on the hub, a room
 * scanned on one phone is there for every member.
 *
 * **The hub keeps it whole and does not read it.** A plan is the client's own
 * document — walls as lines with openings measured along them, furniture as
 * labelled boxes, a vocabulary the client grows — and a second schema for it
 * here would go stale the first time a client learns a new piece of furniture. What
 * the hub owns is the envelope: that it is an object with the two lists in it,
 * a bound on its size, a **revision** that counts saves, and who saved last.
 * The revision is what lets two phones scan two rooms at once: a save names
 * the revision it was read at, and a hub that has seen a save since answers
 * 409 so the app can read the newer plan and make its change to that.
 *
 * **A file, not a row.** One document, written once per deliberate save — a
 * scan finished, a lamp moved by hand — so it is the portrait case rather
 * than the `STATE_FLUSH_MS` one: what needs bounding is bulk, not frequency.
 * Written beside a temporary and renamed over the old one, so a power cut
 * mid-write leaves the previous plan rather than half of a new one. A
 * thirty-room house is a few hundred kilobytes; `MAX_SPACE_BYTES` leaves room
 * for one ten times that and no more.
 */

/** The largest plan a hub keeps. Also what `GET /hub` advertises. */
export const MAX_SPACE_BYTES = 4 * 1024 * 1024;

/** Rooms and placements a plan may list — far beyond any home. */
export const MAX_SPACE_ROOMS = 400;
export const MAX_SPACE_PLACEMENTS = 4000;

export interface SpaceAuthor {
  id: string | null;
  name: string;
}

export interface SpaceRecord {
  /** The app's document, exactly as it was saved. `null` when none has been. */
  space: Record<string, unknown> | null;
  /** Counts saves, from 0 for a hub that has never had one. */
  revision: number;
  updatedAt: string | null;
  updatedBy: SpaceAuthor | null;
}

/** Why a save was refused, in the words the route answers with. */
export class SpaceSaveError extends Error {
  constructor(
    readonly code: 'space_conflict' | 'space_too_large',
    readonly revision: number,
  ) {
    super(code);
  }
}

export class SpaceStore {
  private readonly file: string;
  private record: SpaceRecord | null = null;

  constructor(
    dataDir: string,
    private readonly events?: HubEventBus,
  ) {
    this.file = path.join(dataDir, 'space', 'plan.json');
  }

  /** What `GET /hub` carries. Its presence is the capability. */
  describe(): { maxBytes: number } {
    return { maxBytes: MAX_SPACE_BYTES };
  }

  read(): SpaceRecord {
    if (this.record) return this.record;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<SpaceRecord>;
      this.record = {
        space: isObject(parsed.space) ? parsed.space : null,
        revision: typeof parsed.revision === 'number' ? parsed.revision : 0,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
        updatedBy: parsed.updatedBy ?? null,
      };
    } catch {
      // No file is the ordinary state of a hub nobody has scanned for. An
      // unreadable one is treated the same — the app still has its own copy,
      // and the next save writes a good file over it.
      this.record = { space: null, revision: 0, updatedAt: null, updatedBy: null };
    }
    return this.record;
  }

  /**
   * Keeps `space` as the home's plan. `baseRevision` is the revision the app
   * read before changing it; a different current revision means somebody
   * else saved in between, and nothing is written.
   */
  save(space: Record<string, unknown>, baseRevision: number | null | undefined, author: SpaceAuthor): SpaceRecord {
    const current = this.read();
    if (baseRevision != null && baseRevision !== current.revision) {
      throw new SpaceSaveError('space_conflict', current.revision);
    }
    const next: SpaceRecord = {
      space,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
      updatedBy: author,
    };
    const body = JSON.stringify(next);
    if (Buffer.byteLength(body) > MAX_SPACE_BYTES) {
      throw new SpaceSaveError('space_too_large', current.revision);
    }
    this.write(body);
    this.record = next;
    this.events?.emit('spaceChanged', next.revision);
    return next;
  }

  /** Forgets the plan. The revision carries on, so a stale save still loses. */
  clear(author: SpaceAuthor): SpaceRecord {
    const current = this.read();
    const next: SpaceRecord = {
      space: null,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
      updatedBy: author,
    };
    this.write(JSON.stringify(next));
    this.record = next;
    this.events?.emit('spaceChanged', next.revision);
    return next;
  }

  private write(body: string): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    try {
      writeFileSync(temporary, body, { mode: 0o644 });
      renameSync(temporary, this.file);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
