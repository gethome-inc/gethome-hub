import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { CameraError, CameraProxy, MultipartReader } from '../src/cameras/proxy.js';

/**
 * The camera proxy against a camera on loopback. Loopback is exactly what the
 * real address policy refuses, so the suite hands the proxy its own policy —
 * and one test proves the default refuses it.
 */

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7), Buffer.from([0xff, 0xd9])]);

interface Camera {
  url: string;
  port: number;
  /** How many requests reached /stream — one upstream per stream is the point. */
  streamRequests: number;
  close(): Promise<void>;
}

async function startCamera(options: { id?: string; redirect?: boolean; html?: boolean } = {}): Promise<Camera> {
  const state = { streamRequests: 0 };
  const server = http.createServer((request, response) => {
    if (request.url === '/gethome/id') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: options.id ?? 'porch-cam', sdk: '0.1.0' }));
      return;
    }
    if (request.url === '/snapshot') {
      if (options.redirect) {
        response.writeHead(302, { location: 'http://192.168.1.1/' });
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': options.html ? 'text/html' : 'image/jpeg' });
      response.end(options.html ? '<html></html>' : JPEG);
      return;
    }
    if (request.url === '/stream') {
      state.streamRequests += 1;
      response.writeHead(200, { 'content-type': 'multipart/x-mixed-replace;boundary=gethome-frame' });
      const timer = setInterval(() => {
        response.write(`\r\n--gethome-frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${String(JPEG.length)}\r\n\r\n`);
        response.write(JPEG);
      }, 20);
      request.on('close', () => clearInterval(timer));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    port,
    get streamRequests() {
      return state.streamRequests;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** The proxy's output, read from a real HTTP response. */
async function startViewerServer(proxy: CameraProxy, target: { key: string; externalId: string; url: string }) {
  const server = http.createServer((request, response) => {
    proxy
      .watch(target, response, (listener) => request.on('close', listener))
      .catch((error: unknown) => {
        response.writeHead(error instanceof CameraError ? 502 : 500);
        response.end(error instanceof CameraError ? error.code : 'error');
      });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${String(port)}/`, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

/** Reads frames from an MJPEG response until `count` have arrived. */
function frames(url: string, count: number): Promise<{ type: string; frames: Buffer[]; request: http.ClientRequest }> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      const type = String(response.headers['content-type']);
      const got: Buffer[] = [];
      const boundary = /boundary=([^;]+)/.exec(type)?.[1] ?? 'x';
      const reader = new MultipartReader(boundary, 1024 * 1024, (frame) => {
        got.push(frame);
        if (got.length === count) resolve({ type, frames: got, request });
      });
      response.on('data', (chunk: Buffer) => reader.push(chunk));
      response.on('end', () => {
        if (got.length < count) resolve({ type, frames: got, request });
      });
    });
    request.on('error', reject);
  });
}

const log = pino({ level: 'silent' });
let camera: Camera;
let proxy: CameraProxy;

beforeEach(async () => {
  camera = await startCamera();
  proxy = new CameraProxy({ log, addressAllowed: (host) => host === '127.0.0.1', maxUpstreams: 1 });
});

afterEach(async () => {
  proxy.close();
  await camera.close();
});

describe('camera proxy', () => {
  it('relays a still once the board has said it is the device', async () => {
    const jpeg = await proxy.snapshot({ key: 'd/1/still', externalId: 'porch-cam', url: `${camera.url}/snapshot` });
    expect(jpeg.equals(JPEG)).toBe(true);
  });

  it('refuses a board that answers as a different device', async () => {
    await camera.close();
    camera = await startCamera({ id: 'somebody-else' });
    await expect(proxy.snapshot({ key: 'd/1/still', externalId: 'porch-cam', url: `${camera.url}/snapshot` })).rejects.toMatchObject({
      code: 'camera_unverified',
    });
  });

  it('refuses what the default policy refuses — loopback included — before any request', async () => {
    const strict = new CameraProxy({ log });
    await expect(strict.snapshot({ key: 'd/1/still', externalId: 'porch-cam', url: `${camera.url}/snapshot` })).rejects.toMatchObject({
      code: 'camera_address_refused',
    });
    await expect(proxy.snapshot({ key: 'd/1/still', externalId: 'porch-cam', url: 'http://user:pw@127.0.0.1/snapshot' })).rejects.toMatchObject({
      code: 'camera_address_refused',
    });
  });

  it('follows no redirect and relays nothing that is not a JPEG', async () => {
    await camera.close();
    camera = await startCamera({ redirect: true });
    await expect(proxy.snapshot({ key: 'd/1/still', externalId: 'porch-cam', url: `${camera.url}/snapshot` })).rejects.toMatchObject({
      code: 'camera_bad_response',
    });
    await camera.close();
    camera = await startCamera({ html: true });
    await expect(proxy.snapshot({ key: 'd/1/still', externalId: 'porch-cam', url: `${camera.url}/snapshot` })).rejects.toMatchObject({
      code: 'camera_bad_response',
    });
  });

  it('refuses a still larger than a still should be', async () => {
    const small = new CameraProxy({ log, addressAllowed: () => true, maxSnapshotBytes: 100 });
    await expect(small.snapshot({ key: 'd/1/still', externalId: 'porch-cam', url: `${camera.url}/snapshot` })).rejects.toMatchObject({
      code: 'camera_bad_response',
    });
  });

  it('says a camera that is switched off is unreachable', async () => {
    const port = camera.port;
    await camera.close();
    await expect(proxy.snapshot({ key: 'd/1/still', externalId: 'porch-cam', url: `http://127.0.0.1:${String(port)}/snapshot` })).rejects.toMatchObject({
      code: 'camera_unreachable',
    });
  });

  it('shares one upstream between two viewers, re-framed in the hub’s own multipart', async () => {
    const target = { key: 'd/1/live', externalId: 'porch-cam', url: `${camera.url}/stream` };
    const viewer = await startViewerServer(proxy, target);
    try {
      const [first, second] = await Promise.all([frames(viewer.url, 3), frames(viewer.url, 3)]);
      expect(first.type).toContain('multipart/x-mixed-replace');
      expect(first.frames[0]!.equals(JPEG)).toBe(true);
      expect(second.frames).toHaveLength(3);
      expect(camera.streamRequests).toBe(1);
      expect(proxy.streaming).toBe(1);
      first.request.destroy();
      second.request.destroy();
      // The last viewer leaving closes the upstream.
      for (let i = 0; i < 50 && proxy.streaming > 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(proxy.streaming).toBe(0);
    } finally {
      await viewer.close();
    }
  });

  it('is busy past the number of cameras it relays at once', async () => {
    const other = await startCamera();
    const first = await startViewerServer(proxy, { key: 'a/1/live', externalId: 'porch-cam', url: `${camera.url}/stream` });
    const second = await startViewerServer(proxy, { key: 'b/1/live', externalId: 'porch-cam', url: `${other.url}/stream` });
    try {
      const watching = await frames(first.url, 1);
      const refused = await new Promise<{ status: number; body: string }>((resolve) => {
        http.get(second.url, (response) => {
          let body = '';
          response.on('data', (chunk: Buffer) => (body += chunk.toString()));
          response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
        });
      });
      expect(refused).toEqual({ status: 502, body: 'camera_busy' });
      watching.request.destroy();
    } finally {
      await first.close();
      await second.close();
      await other.close();
    }
  });
});

describe('multipart reader', () => {
  it('reads parts by length, and by boundary when they carry none', () => {
    const got: string[] = [];
    const reader = new MultipartReader('b', 1024, (part) => got.push(part.toString()));
    reader.push(Buffer.from('--b\r\nContent-Type: image/jpeg\r\nContent-Length: 3\r\n\r\nabc\r\n--b\r\nContent-Type: image/jpeg\r\n\r\nxyz\r\n--b'));
    expect(got).toEqual(['abc', 'xyz']);
  });

  it('refuses a part over the limit', () => {
    const reader = new MultipartReader('b', 4, () => {});
    expect(() => reader.push(Buffer.from('--b\r\nContent-Length: 10\r\n\r\n'))).toThrow();
  });
});
