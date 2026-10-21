import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { CameraError, CameraProxy, MultipartReader, type CameraOpener } from '../src/cameras/proxy.js';

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

async function startCamera(
  options: { id?: string; redirect?: boolean; html?: boolean; slowIdMs?: number } = {},
): Promise<Camera> {
  const state = { streamRequests: 0 };
  const server = http.createServer((request, response) => {
    if (request.url === '/gethome/id') {
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: options.id ?? 'porch-cam', sdk: '0.1.0' }));
      }, options.slowIdMs ?? 0);
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

/** The proxy's output, read from a real HTTP response — asked for by a person, or by `opener`. */
async function startViewerServer(
  proxy: CameraProxy,
  target: { key: string; externalId: string; url: string },
  opener?: CameraOpener,
) {
  const server = http.createServer((request, response) => {
    proxy
      .watch(target, response, (listener) => request.on('close', listener), opener)
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

/** Asks for a stream: a refusal with its body, or a stream that is open, with the request to hang up. */
function ask(url: string): Promise<{ status: number; body: string; request: http.ClientRequest }> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      const status = response.statusCode ?? 0;
      if (status === 200) {
        response.resume();
        resolve({ status, body: '', request });
        return;
      }
      let body = '';
      response.on('data', (chunk: Buffer) => (body += chunk.toString()));
      response.on('end', () => resolve({ status, body, request }));
    });
    request.on('error', reject);
  });
}

/** Waits for something the proxy does once a viewer has gone. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(condition()).toBe(true);
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

/**
 * Software holding an API key shares the hub's few streams with the people in
 * the home, so it may open one at a time and never the last free one — and
 * may always join one that is already open, which costs the hub nothing.
 */
describe('camera proxy, for a key', () => {
  const key: CameraOpener = { keyId: 'key-1' };
  const opened: Array<{ close(): void | Promise<void> }> = [];

  afterEach(async () => {
    for (const thing of opened.splice(0).reverse()) await thing.close();
  });

  /** A proxy relaying `maxUpstreams` streams at once, closed after the test. */
  const proxyFor = (maxUpstreams: number) => {
    const made = new CameraProxy({ log, addressAllowed: (host) => host === '127.0.0.1', maxUpstreams });
    opened.push(made);
    return made;
  };

  /** Where `opener` asks `on` for stream `stream` of `from` (the suite's camera unless named). */
  const viewer = async (on: CameraProxy, stream: string, opener?: CameraOpener, from: Camera = camera) => {
    const server = await startViewerServer(
      on,
      { key: `${stream}/1/live`, externalId: 'porch-cam', url: `${from.url}/stream` },
      opener,
    );
    opened.push(server);
    return server.url;
  };

  it('lets a key open one stream at a time, and leaves people and other keys their own', async () => {
    const wide = proxyFor(4);
    const first = await frames(await viewer(wide, 'a', key), 1);
    expect(first.frames).toHaveLength(1);
    expect(await ask(await viewer(wide, 'b', key))).toMatchObject({ status: 502, body: 'camera_busy' });
    // A person opens the same stream the key was refused, and another key opens one of its own.
    const person = await frames(await viewer(wide, 'b'), 1);
    const other = await frames(await viewer(wide, 'c', { keyId: 'key-2' }), 1);
    expect(wide.streaming).toBe(3);
    // Once its stream has closed, the key may open another.
    first.request.destroy();
    await until(() => wide.streaming === 2);
    const next = await frames(await viewer(wide, 'd', key), 1);
    expect(next.frames).toHaveLength(1);
    for (const watching of [person, other, next]) watching.request.destroy();
  });

  it('never gives a key the last free stream, and a person can still take it', async () => {
    const narrow = proxyFor(2);
    const person = await frames(await viewer(narrow, 'a'), 1);
    expect(await ask(await viewer(narrow, 'b', key))).toMatchObject({ status: 502, body: 'camera_busy' });
    const second = await frames(await viewer(narrow, 'b'), 1);
    expect(narrow.streaming).toBe(2);
    // On a hub relaying one stream, that one is always a person's to open.
    expect(await ask(await viewer(proxy, 'a', key))).toMatchObject({ status: 502, body: 'camera_busy' });
    person.request.destroy();
    second.request.destroy();
  });

  it('lets a key join a stream somebody already opened, however full the hub is', async () => {
    // One stream at once, and a person holds it: the key watches alongside them.
    const person = await frames(await viewer(proxy, 'a'), 1);
    const joined = await frames(await viewer(proxy, 'a', key), 2);
    expect(joined.frames).toHaveLength(2);
    expect(proxy.streaming).toBe(1);
    expect(camera.streamRequests).toBe(1);
    person.request.destroy();
    joined.request.destroy();

    // A key with a stream of its own open may still join somebody else's.
    const wide = proxyFor(3);
    const own = await frames(await viewer(wide, 'b', key), 1);
    const theirs = await frames(await viewer(wide, 'c'), 1);
    const alongside = await frames(await viewer(wide, 'c', key), 1);
    expect(alongside.frames).toHaveLength(1);
    expect(wide.streaming).toBe(2);
    for (const watching of [own, theirs, alongside]) watching.request.destroy();
  });

  it('holds a key to one stream when it asks for two at once', async () => {
    // A board slow to prove itself, so both requests are past the first check
    // before either has been verified: the second check is the one that holds.
    const slow = await startCamera({ slowIdMs: 100 });
    opened.push(slow);
    const wide = proxyFor(4);
    const answers = await Promise.all([
      ask(await viewer(wide, 'a', key, slow)),
      ask(await viewer(wide, 'b', key, slow)),
    ]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 502]);
    expect(answers.find((answer) => answer.status === 502)?.body).toBe('camera_busy');
    expect(wide.streaming).toBe(1);
    expect(slow.streamRequests).toBe(1);
    for (const answer of answers) answer.request.destroy();
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
