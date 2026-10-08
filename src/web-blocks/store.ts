import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { deviceWebBlocks } from '../db/schema.js';
import type { HubEventBus } from '../core/bus.js';
import type { Logger } from '../logging.js';

/**
 * Web blocks: small HTML panels a device's page shows in the gethome apps —
 * a gauge, a chart, a few buttons — that somebody made for a device of their
 * own and installed through `PUT /devices/:id/web-blocks/:blockId`.
 *
 * **A block is code that runs on every phone in the house**, so everything
 * here is about bounding it: a handful of plain files of known types, a few
 * hundred kilobytes, a strict name for every path, and an answer for each
 * request taken from the stored manifest rather than from whatever happens to
 * be on disk. What a block may *do* on the phone — no network, only its own
 * device's commands — is the apps' half (each app's web-block host).
 */

export interface WebBlockFile {
  path: string;
  bytes: number;
  sha256: string;
  type: string;
}

/** What the device wire carries for each block. */
export interface WebBlockSummary {
  id: string;
  title: string;
  height: number;
  sha256: string;
  updatedAt: number;
}

export interface WebBlockLimits {
  maxBytes: number;
  maxFiles: number;
  perDevice: number;
  /** Every block on the hub together. */
  budgetBytes: number;
  /** A write is refused below this much free space. */
  minFreeBytes: number;
}

export const DEFAULT_WEB_BLOCK_LIMITS: WebBlockLimits = {
  maxBytes: 512 * 1024,
  maxFiles: 64,
  perDevice: 4,
  budgetBytes: 20 * 1024 * 1024,
  minFreeBytes: 64 * 1024 * 1024,
};

export type WebBlockRefusal =
  | 'invalid_block'
  | 'too_many_web_blocks'
  | 'web_blocks_full'
  | 'storage_low';

export class WebBlockError extends Error {
  constructor(
    readonly code: WebBlockRefusal,
    message: string,
  ) {
    super(message);
  }
}

export const BLOCK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** The file types a block may contain, by extension. */
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

export interface WebBlockUpload {
  title: string;
  height?: number;
  files: Array<{ path: string; dataBase64: string }>;
}

interface StoredBlock extends WebBlockSummary {
  bytes: number;
  files: WebBlockFile[];
}

export class WebBlockService {
  private readonly root: string;
  private readonly limits: WebBlockLimits;
  /**
   * Every block by device, in memory — what `GET /devices` reads. That route's
   * wire is built synchronously, device by device, so this is loaded once at
   * boot and kept current by every write, as favorites are.
   */
  private readonly index = new Map<string, StoredBlock[]>();

  constructor(
    private readonly db: Db,
    private readonly events: HubEventBus,
    dataDir: string,
    private readonly log: Logger,
    limits: Partial<WebBlockLimits> = {},
  ) {
    this.root = path.join(dataDir, 'web-blocks');
    this.limits = { ...DEFAULT_WEB_BLOCK_LIMITS, ...limits };
    // The rows go with a device by cascade; the files do not.
    events.on('deviceRemoved', (deviceId) => {
      this.index.delete(deviceId);
      void rm(this.deviceDir(deviceId), { recursive: true, force: true });
    });
  }

  async load(): Promise<void> {
    const rows = await this.db.select().from(deviceWebBlocks);
    this.index.clear();
    for (const row of rows) {
      const list = this.index.get(row.deviceId) ?? [];
      list.push({
        id: row.blockId,
        title: row.title,
        height: row.height,
        sha256: row.sha256,
        updatedAt: row.updatedAt.getTime(),
        bytes: row.bytes,
        files: row.manifest as WebBlockFile[],
      });
      this.index.set(row.deviceId, list);
    }
  }

  /** What `GET /hub` advertises — presence is the capability. */
  describe(): { maxBytes: number; maxFiles: number; perDevice: number } {
    return { maxBytes: this.limits.maxBytes, maxFiles: this.limits.maxFiles, perDevice: this.limits.perDevice };
  }

  /** A device's blocks, for its wire. */
  list(deviceId: string): WebBlockSummary[] {
    return (this.index.get(deviceId) ?? []).map(({ id, title, height, sha256, updatedAt }) => ({
      id,
      title,
      height,
      sha256,
      updatedAt,
    }));
  }

  /**
   * Installs a block, or replaces the one with that id. Returns whether
   * anything changed: an upload identical to what is stored writes nothing,
   * so a tool that installs on every run costs the card nothing.
   */
  async put(
    deviceId: string,
    blockId: string,
    upload: WebBlockUpload,
    member: { id: string; name: string } | null,
  ): Promise<{ changed: boolean; block: WebBlockSummary }> {
    if (!BLOCK_ID_PATTERN.test(blockId)) {
      throw new WebBlockError('invalid_block', 'A block id is lowercase letters, digits and dashes, up to 40.');
    }
    const title = upload.title.trim();
    if (title.length === 0 || title.length > 60) throw new WebBlockError('invalid_block', 'A block needs a title of up to 60 characters.');
    const height = upload.height ?? 240;
    if (!Number.isInteger(height) || height < 60 || height > 800) {
      throw new WebBlockError('invalid_block', 'A block is between 60 and 800 points tall.');
    }
    const decoded = this.decode(upload.files);
    const files = decoded.map(({ path: filePath, data }) => ({
      path: filePath,
      bytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
      type: TYPES[extension(filePath)]!,
    }));
    const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
    const digest = blockDigest(files);

    const existing = this.index.get(deviceId) ?? [];
    const current = existing.find((block) => block.id === blockId);
    if (current && current.sha256 === digest && current.title === title && current.height === height) {
      return { changed: false, block: summary(current) };
    }
    if (!current && existing.length >= this.limits.perDevice) {
      throw new WebBlockError('too_many_web_blocks', `A device holds up to ${String(this.limits.perDevice)} blocks.`);
    }
    const used = [...this.index.values()].flat().reduce((sum, block) => sum + block.bytes, 0) - (current?.bytes ?? 0);
    if (used + bytes > this.limits.budgetBytes) {
      throw new WebBlockError('web_blocks_full', 'The hub holds no more web blocks — remove one first.');
    }
    await this.requireFreeSpace();

    // Written beside the old one and swapped in by rename, so a reader never
    // sees half of each and a failed write leaves the old block whole.
    const directory = this.blockDir(deviceId, blockId);
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
      this.log.error({ err: error, deviceId, blockId }, 'Writing a web block failed');
      throw error;
    }

    const updatedAt = new Date();
    const row = {
      deviceId,
      blockId,
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
      .insert(deviceWebBlocks)
      .values(row)
      .onConflictDoUpdate({
        target: [deviceWebBlocks.deviceId, deviceWebBlocks.blockId],
        set: {
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

    const stored: StoredBlock = { id: blockId, title, height, sha256: digest, updatedAt: updatedAt.getTime(), bytes, files };
    this.index.set(deviceId, [...existing.filter((block) => block.id !== blockId), stored]);
    this.events.emit('webBlocksChanged', deviceId);
    return { changed: true, block: summary(stored) };
  }

  async remove(deviceId: string, blockId: string): Promise<boolean> {
    const existing = this.index.get(deviceId) ?? [];
    if (!existing.some((block) => block.id === blockId)) return false;
    await this.db
      .delete(deviceWebBlocks)
      .where(and(eq(deviceWebBlocks.deviceId, deviceId), eq(deviceWebBlocks.blockId, blockId)));
    await rm(this.blockDir(deviceId, blockId), { recursive: true, force: true });
    const remaining = existing.filter((block) => block.id !== blockId);
    if (remaining.length > 0) this.index.set(deviceId, remaining);
    else this.index.delete(deviceId);
    this.events.emit('webBlocksChanged', deviceId);
    return true;
  }

  /**
   * One file of a block, **found in the manifest**, never by asking the disk:
   * a path the manifest doesn't name is a 404 whatever is there.
   */
  async file(deviceId: string, blockId: string, filePath: string): Promise<{ data: Buffer; file: WebBlockFile } | null> {
    const block = (this.index.get(deviceId) ?? []).find((candidate) => candidate.id === blockId);
    const wanted = filePath === '' ? 'index.html' : filePath;
    const file = block?.files.find((candidate) => candidate.path === wanted);
    if (!block || !file) return null;
    try {
      return { data: await readFile(path.join(this.blockDir(deviceId, blockId), file.path)), file };
    } catch {
      return null;
    }
  }

  // MARK: Pieces

  private deviceDir(deviceId: string): string {
    return path.join(this.root, deviceId);
  }

  private blockDir(deviceId: string, blockId: string): string {
    return path.join(this.deviceDir(deviceId), blockId);
  }

  private decode(files: WebBlockUpload['files']): Array<{ path: string; data: Buffer }> {
    if (!Array.isArray(files) || files.length === 0) throw new WebBlockError('invalid_block', 'A block needs at least an index.html.');
    if (files.length > this.limits.maxFiles) {
      throw new WebBlockError('invalid_block', `A block has at most ${String(this.limits.maxFiles)} files.`);
    }
    const seen = new Set<string>();
    let total = 0;
    const decoded = files.map(({ path: filePath, dataBase64 }) => {
      const problem = pathProblem(filePath);
      if (problem) throw new WebBlockError('invalid_block', `${filePath}: ${problem}`);
      if (seen.has(filePath)) throw new WebBlockError('invalid_block', `${filePath} is in the block twice.`);
      seen.add(filePath);
      if (!isStrictBase64(dataBase64)) throw new WebBlockError('invalid_block', `${filePath} is not base64.`);
      const data = Buffer.from(dataBase64, 'base64');
      total += data.length;
      if (total > this.limits.maxBytes) {
        throw new WebBlockError('invalid_block', `A block is at most ${String(Math.round(this.limits.maxBytes / 1024))} KB.`);
      }
      return { path: filePath, data };
    });
    if (!seen.has('index.html')) throw new WebBlockError('invalid_block', 'A block needs an index.html at its top.');
    return decoded;
  }

  private async requireFreeSpace(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const stats = await statfs(this.root);
    if (stats.bavail * stats.bsize < this.limits.minFreeBytes) {
      throw new WebBlockError('storage_low', 'The hub’s card is nearly full.');
    }
  }
}

/** Why a path can't be part of a block, or null. Plain names, one to four folders deep, of a known type. */
export function pathProblem(filePath: string): string | null {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.length > 120) return 'not a usable path';
  const segments = filePath.split('/');
  if (segments.length > 4) return 'nested too deeply';
  for (const segment of segments) {
    if (!/^[A-Za-z0-9._-]+$/.test(segment) || segment === '.' || segment === '..' || segment.startsWith('.')) {
      return 'a path is letters, digits, dots, dashes and underscores, with no hidden files';
    }
  }
  if (!TYPES[extension(filePath)]) return 'not a file type a block may contain';
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

/** One digest for the whole block: every file's path and digest, in path order. */
function blockDigest(files: WebBlockFile[]): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(`${file.path}\0${file.sha256}\n`);
  }
  return hash.digest('hex');
}

function summary(block: StoredBlock): WebBlockSummary {
  return { id: block.id, title: block.title, height: block.height, sha256: block.sha256, updatedAt: block.updatedAt };
}
