import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { devicePanels } from '../db/schema.js';
import type { HubEventBus } from '../core/bus.js';
import type { Logger } from '../logging.js';

/**
 * Panels: the cards a device's page shows in the gethome apps — a gauge, a
 * chart, a few buttons — made for that device and installed through
 * `PUT /devices/:id/panels/:panelId`.
 *
 * **One collection for every kind of panel.** A panel's `kind` says how the
 * apps draw it, and `web` — a few files of HTML, CSS and script — is the only
 * one today. A later kind is a new word in `PANEL_KINDS`, with its own checks
 * where `write` checks a `web` panel's files, stored in the same table under
 * the same ids: a device never has two panels with one id, whatever kind each
 * is, so an app can key anything it remembers about a panel on the id alone.
 *
 * **A panel is code that runs on every phone in the house**, so everything
 * here is about bounding it: a handful of plain files of known types, a few
 * hundred kilobytes, a strict name for every path, and an answer for each
 * request taken from the stored manifest rather than from whatever happens to
 * be on disk. What a panel may *do* on the phone — no network, only its own
 * device's commands — is the apps' half (each app's panel host).
 */

/** The kinds of panel this hub keeps, each named for how the apps draw it. */
export const PANEL_KINDS = ['web'] as const;
export type PanelKind = (typeof PANEL_KINDS)[number];

export function isPanelKind(kind: string): kind is PanelKind {
  return (PANEL_KINDS as readonly string[]).includes(kind);
}

export interface PanelFile {
  path: string;
  bytes: number;
  sha256: string;
  type: string;
}

/**
 * What the device wire carries for each panel. `kind` is read by the apps as
 * an open word: one they don't draw is left off the page, never an error.
 */
export interface PanelSummary {
  id: string;
  kind: string;
  title: string;
  height: number;
  sha256: string;
  updatedAt: number;
}

export interface PanelLimits {
  /** A `web` panel's files together, decoded. */
  maxBytes: number;
  /** A `web` panel's files. */
  maxFiles: number;
  /** Panels on one device, of every kind together. */
  perDevice: number;
  /** Every panel on the hub together. */
  budgetBytes: number;
  /** A write is refused below this much free space. */
  minFreeBytes: number;
}

export const DEFAULT_PANEL_LIMITS: PanelLimits = {
  maxBytes: 512 * 1024,
  maxFiles: 64,
  perDevice: 4,
  budgetBytes: 20 * 1024 * 1024,
  minFreeBytes: 64 * 1024 * 1024,
};

export type PanelRefusal =
  | 'invalid_panel'
  | 'unsupported_panel_kind'
  | 'too_many_panels'
  | 'panels_full'
  | 'storage_low';

export class PanelError extends Error {
  constructor(
    readonly code: PanelRefusal,
    message: string,
  ) {
    super(message);
  }
}

export const PANEL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** The file types a `web` panel may contain, by extension. */
const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  woff2: 'font/woff2',
};

export interface PanelUpload {
  /** How the apps draw it — one of `PANEL_KINDS`, refused otherwise. */
  kind: string;
  title: string;
  height?: number;
  files: Array<{ path: string; dataBase64: string }>;
}

interface StoredPanel extends PanelSummary {
  bytes: number;
  files: PanelFile[];
}

export class PanelService {
  private readonly root: string;
  private readonly limits: PanelLimits;
  /**
   * Every panel by device, in memory — what `GET /devices` reads. That route's
   * wire is built synchronously, device by device, so this is loaded once at
   * boot and kept current by every write, as favorites are.
   */
  private readonly index = new Map<string, StoredPanel[]>();
  /**
   * Writes run one at a time. Each one checks the limits against the index and
   * then awaits the disk, so two uploads side by side would both pass the
   * per-device count and the second to finish would put back an index without
   * the first. Writes are rare and a few hundred kilobytes, so one queue for
   * the whole hub costs nothing.
   */
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: Db,
    private readonly events: HubEventBus,
    dataDir: string,
    private readonly log: Logger,
    limits: Partial<PanelLimits> = {},
  ) {
    this.root = path.join(dataDir, 'panels');
    this.limits = { ...DEFAULT_PANEL_LIMITS, ...limits };
    // The rows go with a device by cascade; the files do not.
    events.on('deviceRemoved', (deviceId) => {
      this.index.delete(deviceId);
      void rm(this.deviceDir(deviceId), { recursive: true, force: true });
    });
  }

  /**
   * Every row, whatever its kind. A kind this build doesn't know was written
   * by a newer one — a hub that rolled back — and is kept, listed and served
   * as it was: the wire says what it is, and an app that doesn't draw it
   * leaves it off the page.
   */
  async load(): Promise<void> {
    const rows = await this.db.select().from(devicePanels);
    this.index.clear();
    for (const row of rows) {
      const list = this.index.get(row.deviceId) ?? [];
      list.push({
        id: row.panelId,
        kind: row.kind,
        title: row.title,
        height: row.height,
        sha256: row.sha256,
        updatedAt: row.updatedAt.getTime(),
        bytes: row.bytes,
        files: row.manifest as PanelFile[],
      });
      this.index.set(row.deviceId, list);
    }
  }

  /**
   * What `GET /hub` advertises — presence is the capability, and so is each
   * kind: a client offers a kind of panel only where `kinds` names it, so a
   * later kind never reaches a hub that would refuse it.
   */
  describe(): { perDevice: number; kinds: { web: { maxBytes: number; maxFiles: number } } } {
    return {
      perDevice: this.limits.perDevice,
      kinds: { web: { maxBytes: this.limits.maxBytes, maxFiles: this.limits.maxFiles } },
    };
  }

  /** A device's panels, for its wire. */
  list(deviceId: string): PanelSummary[] {
    return (this.index.get(deviceId) ?? []).map(summary);
  }

  /**
   * Installs a panel, or replaces the one with that id — whatever kind either
   * is. Returns whether anything changed: an upload identical to what is
   * stored writes nothing, so a tool that installs on every run costs the card
   * nothing.
   */
  put(
    deviceId: string,
    panelId: string,
    upload: PanelUpload,
    member: { id: string; name: string } | null,
  ): Promise<{ changed: boolean; panel: PanelSummary }> {
    return this.serially(() => this.write(deviceId, panelId, upload, member));
  }

  remove(deviceId: string, panelId: string): Promise<boolean> {
    return this.serially(() => this.erase(deviceId, panelId));
  }

  private serially<T>(work: () => Promise<T>): Promise<T> {
    const run = this.writes.then(work, work);
    this.writes = run.catch(() => {});
    return run;
  }

  private async write(
    deviceId: string,
    panelId: string,
    upload: PanelUpload,
    member: { id: string; name: string } | null,
  ): Promise<{ changed: boolean; panel: PanelSummary }> {
    if (!PANEL_ID_PATTERN.test(panelId)) {
      throw new PanelError('invalid_panel', 'A panel id is lowercase letters, digits and dashes, up to 40.');
    }
    // Before anything else about it: the rest of the checks are a kind's own.
    if (!isPanelKind(upload.kind)) {
      throw new PanelError(
        'unsupported_panel_kind',
        `This hub keeps ${PANEL_KINDS.map((kind) => `“${kind}”`).join(', ')} panels, not “${upload.kind}”.`,
      );
    }
    const kind = upload.kind;
    const title = upload.title.trim();
    if (title.length === 0 || title.length > 60) throw new PanelError('invalid_panel', 'A panel needs a title of up to 60 characters.');
    const height = upload.height ?? 240;
    if (!Number.isInteger(height) || height < 60 || height > 800) {
      throw new PanelError('invalid_panel', 'A panel is between 60 and 800 points tall.');
    }
    const decoded = this.decode(upload.files);
    const files = decoded.map(({ path: filePath, data }) => ({
      path: filePath,
      bytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
      type: TYPES[extension(filePath)]!,
    }));
    const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
    const digest = panelDigest(files);

    const existing = this.index.get(deviceId) ?? [];
    const current = existing.find((panel) => panel.id === panelId);
    if (
      current &&
      current.kind === kind &&
      current.sha256 === digest &&
      current.title === title &&
      current.height === height
    ) {
      return { changed: false, panel: summary(current) };
    }
    if (!current && existing.length >= this.limits.perDevice) {
      throw new PanelError('too_many_panels', `A device holds up to ${String(this.limits.perDevice)} panels.`);
    }
    const used = [...this.index.values()].flat().reduce((sum, panel) => sum + panel.bytes, 0) - (current?.bytes ?? 0);
    if (used + bytes > this.limits.budgetBytes) {
      throw new PanelError('panels_full', 'The hub holds no more panels — remove one first.');
    }
    await this.requireFreeSpace();

    // Written beside the old one and swapped in by rename, so a reader never
    // sees half of each and a failed write leaves the old panel whole.
    const directory = this.panelDir(deviceId, panelId);
    const staging = path.join(this.deviceDir(deviceId), `.staging-${randomUUID()}`);
    try {
      for (const file of decoded) {
        const target = path.join(staging, file.path);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, file.data);
      }
      const retired = path.join(this.deviceDir(deviceId), `.retired-${randomUUID()}`);
      await rename(directory, retired).catch(() => {});
      await rename(staging, directory);
      await rm(retired, { recursive: true, force: true });
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      this.log.error({ err: error, deviceId, panelId }, 'Writing a panel failed');
      throw error;
    }

    const updatedAt = new Date();
    const row = {
      deviceId,
      panelId,
      kind,
      title,
      sha256: digest,
      bytes,
      height,
      manifest: files,
      updatedAt,
      memberId: member?.id ?? null,
      memberName: member?.name ?? null,
    };
    await this.db
      .insert(devicePanels)
      .values(row)
      .onConflictDoUpdate({
        target: [devicePanels.deviceId, devicePanels.panelId],
        set: {
          kind,
          title,
          sha256: digest,
          bytes,
          height,
          manifest: files,
          updatedAt,
          memberId: row.memberId,
          memberName: row.memberName,
        },
      });

    const stored: StoredPanel = { id: panelId, kind, title, height, sha256: digest, updatedAt: updatedAt.getTime(), bytes, files };
    this.index.set(deviceId, [...existing.filter((panel) => panel.id !== panelId), stored]);
    this.events.emit('panelsChanged', deviceId);
    return { changed: true, panel: summary(stored) };
  }

  private async erase(deviceId: string, panelId: string): Promise<boolean> {
    const existing = this.index.get(deviceId) ?? [];
    if (!existing.some((panel) => panel.id === panelId)) return false;
    await this.db
      .delete(devicePanels)
      .where(and(eq(devicePanels.deviceId, deviceId), eq(devicePanels.panelId, panelId)));
    await rm(this.panelDir(deviceId, panelId), { recursive: true, force: true });
    const remaining = existing.filter((panel) => panel.id !== panelId);
    if (remaining.length > 0) this.index.set(deviceId, remaining);
    else this.index.delete(deviceId);
    this.events.emit('panelsChanged', deviceId);
    return true;
  }

  /**
   * One file of a panel, **found in the manifest**, never by asking the disk:
   * a path the manifest doesn't name is a 404 whatever is there. An empty path
   * is a `web` panel's `index.html`.
   */
  async file(deviceId: string, panelId: string, filePath: string): Promise<{ data: Buffer; file: PanelFile } | null> {
    const panel = (this.index.get(deviceId) ?? []).find((candidate) => candidate.id === panelId);
    const wanted = filePath === '' ? 'index.html' : filePath;
    const file = panel?.files.find((candidate) => candidate.path === wanted);
    if (!panel || !file) return null;
    try {
      return { data: await readFile(path.join(this.panelDir(deviceId, panelId), file.path)), file };
    } catch {
      return null;
    }
  }

  // MARK: Pieces

  private deviceDir(deviceId: string): string {
    return path.join(this.root, deviceId);
  }

  private panelDir(deviceId: string, panelId: string): string {
    return path.join(this.deviceDir(deviceId), panelId);
  }

  /** A `web` panel's files: plain names of known types, `index.html` at the top, bounded. */
  private decode(files: PanelUpload['files']): Array<{ path: string; data: Buffer }> {
    if (!Array.isArray(files) || files.length === 0) throw new PanelError('invalid_panel', 'A panel needs at least an index.html.');
    if (files.length > this.limits.maxFiles) {
      throw new PanelError('invalid_panel', `A panel has at most ${String(this.limits.maxFiles)} files.`);
    }
    const seen = new Set<string>();
    let total = 0;
    const decoded = files.map(({ path: filePath, dataBase64 }) => {
      const problem = pathProblem(filePath);
      if (problem) throw new PanelError('invalid_panel', `${filePath}: ${problem}`);
      if (seen.has(filePath)) throw new PanelError('invalid_panel', `${filePath} is in the panel twice.`);
      seen.add(filePath);
      if (!isStrictBase64(dataBase64)) throw new PanelError('invalid_panel', `${filePath} is not base64.`);
      const data = Buffer.from(dataBase64, 'base64');
      total += data.length;
      if (total > this.limits.maxBytes) {
        throw new PanelError('invalid_panel', `A panel is at most ${String(Math.round(this.limits.maxBytes / 1024))} KB.`);
      }
      return { path: filePath, data };
    });
    if (!seen.has('index.html')) throw new PanelError('invalid_panel', 'A panel needs an index.html at its top.');
    return decoded;
  }

  private async requireFreeSpace(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const stats = await statfs(this.root);
    if (stats.bavail * stats.bsize < this.limits.minFreeBytes) {
      throw new PanelError('storage_low', 'The hub’s card is nearly full.');
    }
  }
}

/** Why a path can't be part of a `web` panel, or null. Plain names, one to four folders deep, of a known type. */
export function pathProblem(filePath: string): string | null {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.length > 120) return 'not a usable path';
  const segments = filePath.split('/');
  if (segments.length > 4) return 'nested too deeply';
  // The apps serve their own theme and fonts at `/_app/` inside every panel,
  // so a file of the panel's own there would never be the one loaded.
  if (segments[0] === '_app') return 'the _app folder is the apps’ own';
  for (const segment of segments) {
    if (!/^[A-Za-z0-9._-]+$/.test(segment) || segment === '.' || segment === '..' || segment.startsWith('.')) {
      return 'a path is letters, digits, dots, dashes and underscores, with no hidden files';
    }
  }
  if (!TYPES[extension(filePath)]) return 'not a file type a panel may contain';
  return null;
}

function extension(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  return dot < 0 ? '' : filePath.slice(dot + 1).toLowerCase();
}

/** Canonical base64 only — `Buffer.from` would quietly skip anything else. */
function isStrictBase64(value: unknown): value is string {
  return typeof value === 'string' && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}

/** One digest for the whole panel: every file's path and digest, in path order. */
function panelDigest(files: PanelFile[]): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(`${file.path}\0${file.sha256}\n`);
  }
  return hash.digest('hex');
}

function summary(panel: StoredPanel): PanelSummary {
  return {
    id: panel.id,
    kind: panel.kind,
    title: panel.title,
    height: panel.height,
    sha256: panel.sha256,
    updatedAt: panel.updatedAt,
  };
}
