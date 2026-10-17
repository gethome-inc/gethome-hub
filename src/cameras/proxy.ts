import http from 'node:http';
import os from 'node:os';
import type { Logger } from '../logging.js';
import { isPrivateIPv4 } from './policy.js';

/**
 * The hub's camera proxy: an app asks the hub for a still or a live stream,
 * and the hub fetches it from the camera on the LAN and relays it.
 *
 * **The app never learns where the camera is, and the hub fetches only what
 * the rules allow** (`policy.ts` for the address; the board's own id, below).
 * Limits make sure a misbehaving board can cost the hub a bounded amount:
 * three seconds to connect, five for a still and 2 MB, 1 MB a frame, ten
 * seconds of silence, never a redirect, never the app's token passed on, and
 * at most four cameras streaming at once.
 *
 * **One upstream per stream, however many people watch.** An ESP32 serves one
 * client at a time, so the second phone opening the porch camera joins the
 * first one's stream rather than knocking it off. Frames are re-framed into
 * the hub's own multipart stream, so a viewer whose connection is slow
 * skips frames instead of holding everybody else back, and nothing is
 * written to disk.
 */

export type CameraRefusal =
  | 'camera_address_refused'
  | 'camera_unverified'
  | 'camera_unreachable'
  | 'camera_bad_response'
  | 'camera_busy';

export class CameraError extends Error {
  constructor(
    readonly code: CameraRefusal,
    message: string,
  ) {
    super(message);
  }
}

/** The HTTP status each refusal is answered with. */
export function cameraStatus(code: CameraRefusal): number {
  return code === 'camera_busy' ? 409 : 502;
}

export interface CameraTarget {
  /** The stream, as `<deviceId>/<endpointId>/<streamId>` — one upstream each. */
  key: string;
  /** The device's own id, which the board must answer `/gethome/id` with. */
  externalId: string;
  url: string;
}

export interface CameraProxyOptions {
  log: Logger;
  /**
   * Whether the hub may connect to this host. The default allows a private
   * IPv4 address that isn't one of the hub's own; tests, whose camera is on
   * loopback, pass their own.
   */
  addressAllowed?: (host: string) => boolean;
  maxUpstreams?: number;
  connectTimeoutMs?: number;
  snapshotTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxSnapshotBytes?: number;
  maxPartBytes?: number;
  /** How long a board's proof of identity is trusted. */
  attestationTtlMs?: number;
}

const BOUNDARY = 'gethomeframe';
/** A viewer more than this far behind skips frames until it catches up. */
const VIEWER_BACKLOG_BYTES = 512 * 1024;

export class CameraProxy {
  private readonly upstreams = new Map<string, Upstream>();
  private readonly attested = new Map<string, number>();
  private readonly options: Required<Omit<CameraProxyOptions, 'addressAllowed'>> & {
    addressAllowed: (host: string) => boolean;
  };

  constructor(options: CameraProxyOptions) {
    this.options = {
      log: options.log,
      addressAllowed: options.addressAllowed ?? defaultAddressAllowed,
      maxUpstreams: options.maxUpstreams ?? 4,
      connectTimeoutMs: options.connectTimeoutMs ?? 3_000,
      snapshotTimeoutMs: options.snapshotTimeoutMs ?? 5_000,
      idleTimeoutMs: options.idleTimeoutMs ?? 10_000,
      maxSnapshotBytes: options.maxSnapshotBytes ?? 2 * 1024 * 1024,
      maxPartBytes: options.maxPartBytes ?? 1024 * 1024,
      attestationTtlMs: options.attestationTtlMs ?? 10 * 60_000,
    };
  }

  /** What `GET /hub` advertises. */
  describe(): { kinds: string[]; maxStreams: number } {
    return { kinds: ['snapshot', 'mjpeg'], maxStreams: this.options.maxUpstreams };
  }

  /** How many cameras are streaming right now. */
  get streaming(): number {
    return this.upstreams.size;
  }

  /** One JPEG from a camera. */
  async snapshot(target: CameraTarget): Promise<Buffer> {
    const url = this.checkedUrl(target.url);
    await this.attest(url, target.externalId);
    const response = await this.request(url, this.options.snapshotTimeoutMs);
    try {
      if (response.statusCode !== 200) {
        throw new CameraError('camera_bad_response', `The camera answered ${String(response.statusCode)}.`);
      }
      if (!mediaType(response.headers['content-type']).startsWith('image/jpeg')) {
        throw new CameraError('camera_bad_response', 'The camera sent something that is not a JPEG.');
      }
      return await readBody(response, this.options.maxSnapshotBytes, this.options.snapshotTimeoutMs);
    } finally {
      response.destroy();
    }
  }

  /**
   * Streams a camera to `viewer`, sharing the upstream with anybody already
   * watching it. Resolves once the viewer is attached and the multipart
   * headers are written; throws a `CameraError` before anything is written.
   * The viewer is detached when `onClose` fires (the app went away).
   */
  async watch(
    target: CameraTarget,
    viewer: http.ServerResponse,
    onClose: (listener: () => void) => void,
  ): Promise<void> {
    let upstream = this.upstreams.get(target.key);
    if (!upstream) {
      if (this.upstreams.size >= this.options.maxUpstreams) {
        throw new CameraError('camera_busy', 'The hub is already streaming as many cameras as it relays at once.');
      }
      const url = this.checkedUrl(target.url);
      await this.attest(url, target.externalId);
      // Someone else may have started it while this one was being verified.
      upstream = this.upstreams.get(target.key);
      if (!upstream) {
        const created = new Upstream(target.key, url, this.options, () => this.upstreams.delete(target.key));
        this.upstreams.set(target.key, created);
        try {
          await created.open();
        } catch (error) {
          // Ends anybody who joined while it was opening, and forgets it.
          created.close();
          throw error;
        }
        upstream = created;
      }
    }
    viewer.writeHead(200, {
      'content-type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      connection: 'close',
    });
    const attached = upstream;
    attached.add(viewer);
    onClose(() => attached.remove(viewer));
  }

  /** Stops every stream — the hub is shutting down. */
  close(): void {
    for (const upstream of this.upstreams.values()) upstream.close();
    this.upstreams.clear();
  }

  // MARK: The rules

  /**
   * The announcement was checked when it arrived (`readCameraAnnouncement`);
   * this is the same rule asked again where the request is made, with the
   * address decided by `addressAllowed` — which also knows the hub's own
   * addresses, as the announcement check cannot.
   */
  private checkedUrl(raw: string): URL {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new CameraError('camera_address_refused', 'The camera announced something that is not a URL.');
    }
    if (url.protocol !== 'http:' || url.username || url.password || !this.options.addressAllowed(url.hostname)) {
      throw new CameraError('camera_address_refused', 'The hub does not fetch from that address.');
    }
    return url;
  }

  /**
   * The board proves it is the device before anything is relayed: its
   * `/gethome/id` must answer with the id the hub knows it by. Without this,
   * any board holding the shared broker account could announce a camera at
   * the router's address and have the hub fetch from it on a phone's behalf.
   *
   * Asked on the stream's own port first, then on port 80 — the device
   * library serves the id beside the still, on 80, and the live stream on a
   * port of its own. A port that doesn't answer, or has no such page, just
   * moves on to the next; **an id that is somebody else's ends it**. Trusted
   * for ten minutes once proved.
   */
  private async attest(url: URL, externalId: string): Promise<void> {
    const cacheKey = `${url.hostname}|${externalId}`;
    const until = this.attested.get(cacheKey);
    if (until && until > Date.now()) return;
    let reached = false;
    for (const port of [...new Set([url.port || '80', '80'])]) {
      const probe = new URL(`http://${url.hostname}:${port}/gethome/id`);
      let response: http.IncomingMessage;
      try {
        response = await this.request(probe, this.options.snapshotTimeoutMs);
      } catch {
        continue;
      }
      reached = true;
      try {
        if (response.statusCode !== 200) continue;
        const body = await readBody(response, 4096, this.options.snapshotTimeoutMs);
        let id: unknown;
        try {
          id = (JSON.parse(body.toString('utf8')) as { id?: unknown }).id;
        } catch {
          continue;
        }
        if (id !== externalId) {
          throw new CameraError('camera_unverified', 'The board at that address is not this device.');
        }
        this.attested.set(cacheKey, Date.now() + this.options.attestationTtlMs);
        return;
      } catch (error) {
        if (error instanceof CameraError && error.code === 'camera_unverified') throw error;
      } finally {
        response.destroy();
      }
    }
    // A camera that is down says so; one that answered without proving itself is unverified.
    throw reached
      ? new CameraError('camera_unverified', 'The hub could not confirm the camera is this device.')
      : new CameraError('camera_unreachable', 'The camera could not be reached.');
  }

  private request(url: URL, timeoutMs: number): Promise<http.IncomingMessage> {
    return openRequest(url, this.options.connectTimeoutMs, timeoutMs);
  }
}

/** A private IPv4 address that isn't one of the hub's own. */
function defaultAddressAllowed(host: string): boolean {
  if (!isPrivateIPv4(host)) return false;
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && address.address === host) return false;
    }
  }
  return true;
}

function mediaType(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  return (value ?? '').toLowerCase().trim();
}

/** GET, with a connect deadline, a header deadline, no redirects followed and no credentials sent. */
function openRequest(url: URL, connectTimeoutMs: number, timeoutMs: number): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = http.get(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: `${url.pathname}${url.search}`,
        headers: { accept: 'image/jpeg, multipart/x-mixed-replace, application/json', 'user-agent': 'gethome-hub' },
        // Each request gets a fresh socket: a camera is not an origin a pool
        // should keep warm, and a stream holds its socket for its whole life.
        agent: false,
      },
      (response) => {
        clearTimeout(headerTimer);
        resolve(response);
      },
    );
    const connectTimer = setTimeout(() => {
      request.destroy(new CameraError('camera_unreachable', 'The camera did not answer.'));
    }, connectTimeoutMs);
    const headerTimer = setTimeout(() => {
      request.destroy(new CameraError('camera_unreachable', 'The camera took too long to answer.'));
    }, timeoutMs);
    request.on('socket', (socket) => {
      socket.once('connect', () => clearTimeout(connectTimer));
    });
    request.on('error', (error) => {
      clearTimeout(connectTimer);
      clearTimeout(headerTimer);
      reject(error instanceof CameraError ? error : new CameraError('camera_unreachable', 'The camera could not be reached.'));
    });
  });
}

/** The whole body, refused past `maxBytes` or `timeoutMs`. */
function readBody(response: http.IncomingMessage, maxBytes: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const timer = setTimeout(() => {
      response.destroy();
      reject(new CameraError('camera_unreachable', 'The camera took too long.'));
    }, timeoutMs);
    response.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        clearTimeout(timer);
        response.destroy();
        reject(new CameraError('camera_bad_response', 'The camera sent more than a still should be.'));
        return;
      }
      chunks.push(chunk);
    });
    response.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
    response.on('error', () => {
      clearTimeout(timer);
      reject(new CameraError('camera_unreachable', 'The camera hung up.'));
    });
  });
}

/** One camera's live stream, and everybody watching it. */
class Upstream {
  private readonly viewers = new Set<http.ServerResponse>();
  private response: http.IncomingMessage | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    private readonly key: string,
    private readonly url: URL,
    private readonly options: Required<Omit<CameraProxyOptions, 'addressAllowed'>>,
    private readonly onClosed: () => void,
  ) {}

  async open(): Promise<void> {
    const response = await openRequest(this.url, this.options.connectTimeoutMs, this.options.snapshotTimeoutMs);
    const type = mediaType(response.headers['content-type']);
    const boundary = /boundary="?([^";]+)"?/i.exec(type)?.[1];
    if (response.statusCode !== 200 || !type.startsWith('multipart/x-mixed-replace') || !boundary) {
      response.destroy();
      throw new CameraError('camera_bad_response', 'The camera did not send a live stream.');
    }
    this.response = response;
    const reader = new MultipartReader(boundary, this.options.maxPartBytes, (frame) => this.broadcast(frame));
    response.on('data', (chunk: Buffer) => {
      this.touch();
      try {
        reader.push(chunk);
      } catch (error) {
        this.options.log.warn({ err: error, stream: this.key }, 'A camera sent a stream the hub could not read');
        this.close();
      }
    });
    response.on('end', () => this.close());
    response.on('error', () => this.close());
    this.touch();
  }

  add(viewer: http.ServerResponse): void {
    this.viewers.add(viewer);
  }

  remove(viewer: http.ServerResponse): void {
    this.viewers.delete(viewer);
    if (this.viewers.size === 0) this.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.response?.destroy();
    for (const viewer of this.viewers) viewer.end();
    this.viewers.clear();
    this.onClosed();
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), this.options.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  private broadcast(frame: Buffer): void {
    const head = Buffer.from(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${String(frame.length)}\r\n\r\n`, 'latin1');
    for (const viewer of this.viewers) {
      // Behind by more than a frame or two: this one skips, nobody waits.
      if (viewer.writableLength > VIEWER_BACKLOG_BYTES) continue;
      viewer.write(head);
      viewer.write(frame);
      viewer.write('\r\n');
    }
  }
}

/**
 * Reads a `multipart/x-mixed-replace` body into its parts. A part with a
 * `Content-Length` is read by length, one without by the next boundary; a part
 * over `maxPart` bytes, or garbage with no boundary in it, throws.
 */
export class MultipartReader {
  private buffer: Buffer = Buffer.alloc(0);
  private readonly delimiter: Buffer;

  constructor(
    boundary: string,
    private readonly maxPart: number,
    private readonly onPart: (body: Buffer) => void,
  ) {
    this.delimiter = Buffer.from(`--${boundary}`, 'latin1');
  }

  push(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const start = this.buffer.indexOf(this.delimiter);
      if (start < 0) {
        if (this.buffer.length > this.maxPart + 8192) throw new Error('no multipart boundary');
        return;
      }
      const headerEnd = this.buffer.indexOf('\r\n\r\n', start, 'latin1');
      if (headerEnd < 0) {
        if (this.buffer.length - start > 8192) throw new Error('multipart headers too long');
        return;
      }
      const headers = this.buffer.subarray(start + this.delimiter.length, headerEnd).toString('latin1');
      const bodyStart = headerEnd + 4;
      let bodyEnd: number;
      const declared = /content-length:\s*(\d+)/i.exec(headers)?.[1];
      if (declared !== undefined) {
        const length = Number(declared);
        if (length > this.maxPart) throw new Error('multipart part too large');
        if (this.buffer.length < bodyStart + length) return;
        bodyEnd = bodyStart + length;
      } else {
        const next = this.buffer.indexOf(this.delimiter, bodyStart);
        if (next < 0) {
          if (this.buffer.length - bodyStart > this.maxPart) throw new Error('multipart part too large');
          return;
        }
        bodyEnd = next;
        while (bodyEnd > bodyStart && (this.buffer[bodyEnd - 1] === 0x0a || this.buffer[bodyEnd - 1] === 0x0d)) bodyEnd -= 1;
      }
      const type = /content-type:\s*([^\r\n;]+)/i.exec(headers)?.[1]?.trim().toLowerCase();
      if (type === undefined || type === 'image/jpeg') {
        this.onPart(Buffer.from(this.buffer.subarray(bodyStart, bodyEnd)));
      }
      this.buffer = this.buffer.subarray(bodyEnd);
    }
  }
}
