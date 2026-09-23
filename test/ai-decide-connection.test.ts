import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Agent, createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import {
  IDLE_MS,
  createKeepAliveFetch,
  warmConnection,
  type DecisionTransport,
} from '../src/ai/decide/connection.js';

/**
 * The connection a decision rides on — which is where almost all of a
 * decision's latency was going.
 *
 * **Against a real server, over a real socket.** The whole point of this
 * transport is what it does with a connection: keep it, reuse it, and survive
 * the far end having let go of it. A stub `fetch` can say none of that, so the
 * transport is built from its parts — a plain `http` agent and `http.request`
 * against a server on a loopback port — and the server counts what actually
 * arrived. `test/CLAUDE.md`'s rule: a test that cannot reach the thing it
 * asserts on is a test of nothing.
 */

interface Harness {
  url: string;
  /** Sockets the server accepted — one per handshake the client paid for. */
  connections: number;
  /** Requests the server read, in order. */
  requests: { method: string; url: string; body: string; headers: IncomingMessage['headers'] }[];
  /** What the server does with each request, by its position. */
  handle: (index: number, req: IncomingMessage, res: ServerResponse) => void;
}

let server: Server;
let harness: Harness;
let agent: Agent;
const sockets = new Set<Socket>();

beforeEach(async () => {
  harness = {
    url: '',
    connections: 0,
    requests: [],
    handle: (_index, _req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-typesafe-request-id': 'req-1' });
      res.end('{"ok":true}');
    },
  };
  server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => {
      const index = harness.requests.length;
      harness.requests.push({ method: req.method ?? '', url: req.url ?? '', body, headers: req.headers });
      harness.handle(index, req, res);
    });
  });
  server.keepAliveTimeout = 60_000;
  server.on('connection', (socket) => {
    harness.connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  harness.url = `http://127.0.0.1:${port}`;
  agent = new Agent({ keepAlive: true, maxSockets: 4, maxFreeSockets: 2 });
});

afterEach(async () => {
  agent.destroy();
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const keepAlive = () => createKeepAliveFetch({ agent, request });

describe('a kept-alive connection', () => {
  it('hands back a real Response, headers and body included', async () => {
    const fetch = keepAlive();
    const response = await fetch(`${harness.url}/v1/systemone`, {
      method: 'POST',
      headers: { authorization: 'Bearer ts-key', 'content-type': 'application/json' },
      body: '{"question":"é"}',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-typesafe-request-id')).toBe('req-1');
    expect(await response.json()).toEqual({ ok: true });

    const [sent] = harness.requests;
    expect(sent?.method).toBe('POST');
    expect(sent?.url).toBe('/v1/systemone');
    expect(sent?.body).toBe('{"question":"é"}');
    expect(sent?.headers['authorization']).toBe('Bearer ts-key');
    // Bytes, not characters: "é" is two of them.
    expect(sent?.headers['content-length']).toBe(String(Buffer.byteLength('{"question":"é"}')));
  });

  it('hands back an error status as a Response rather than throwing', async () => {
    harness.handle = (_index, _req, res) => {
      res.writeHead(429, { 'retry-after': '1' });
      res.end('{"error":"slow down"}');
    };
    const response = await keepAlive()(`${harness.url}/`, { method: 'GET' });
    expect(response.status).toBe(429);
    expect(response.ok).toBe(false);
    expect(await response.text()).toBe('{"error":"slow down"}');
  });

  it('reuses one connection for the next request', async () => {
    // The whole reason this exists: Node's own `fetch` let an idle connection
    // go after about four seconds, so nearly every sentence paid for DNS, TCP
    // and TLS from a Pi before the question was even sent.
    const fetch = keepAlive();
    await (await fetch(`${harness.url}/a`, { method: 'GET' })).text();
    await (await fetch(`${harness.url}/b`, { method: 'GET' })).text();
    await (await fetch(`${harness.url}/c`, { method: 'GET' })).text();
    expect(harness.requests.map((entry) => entry.url)).toEqual(['/a', '/b', '/c']);
    expect(harness.connections).toBe(1);
  });

  it('sends a request again when the far end let go of an idle connection', async () => {
    // The second request goes out on the kept socket, which the server closes
    // without answering — the race every keep-alive client meets. It never
    // reached anybody, so it is sent once more on a fresh connection.
    harness.handle = (index, req, res) => {
      if (index === 1) {
        req.socket.destroy();
        return;
      }
      res.writeHead(200);
      res.end(`answer ${index}`);
    };
    const fetch = keepAlive();
    expect(await (await fetch(`${harness.url}/`, { method: 'GET' })).text()).toBe('answer 0');
    expect(await (await fetch(`${harness.url}/`, { method: 'GET' })).text()).toBe('answer 2');
    expect(harness.requests).toHaveLength(3);
    expect(harness.connections).toBe(2);
  });

  it('does not send it again on a fresh connection, where the refusal is real', async () => {
    harness.handle = (_index, req) => {
      req.socket.destroy();
    };
    await expect(keepAlive()(`${harness.url}/`, { method: 'GET' })).rejects.toThrow();
    expect(harness.requests).toHaveLength(1);
  });

  it('stops when it is told to, and does not try again', async () => {
    // The deadline in `typesafe.ts` is an abort; a retry after it would be a
    // request nobody is waiting for any more.
    harness.handle = () => {
      // Never answers.
    };
    const controller = new AbortController();
    const pending = keepAlive()(`${harness.url}/`, { method: 'GET', signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(harness.requests).toHaveLength(1);
  });

  it('refuses a reply cut off part-way rather than returning half of it', async () => {
    harness.handle = (_index, req, res) => {
      res.writeHead(200, { 'content-length': '100' });
      res.write('{"ans');
      setTimeout(() => req.socket.destroy(), 10);
    };
    await expect(keepAlive()(`${harness.url}/`, { method: 'GET' })).rejects.toThrow();
  });

  it('keeps an idle connection for minutes, not seconds', () => {
    expect(IDLE_MS).toBeGreaterThanOrEqual(60_000);
  });
});

describe('warming it', () => {
  it('asks the vendor for its model list, with the key, and reads nothing', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const transport: DecisionTransport = {
      fetch: async (url, init) => {
        calls.push({ url, init });
        return new Response('{}');
      },
      isWarm: () => false,
    };
    await warmConnection({ secret: 'ts-key', transport });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.typesafe.ai/v1/models');
    expect(calls[0]?.init.method).toBe('GET');
    expect(calls[0]?.init.headers).toEqual({ authorization: 'Bearer ts-key' });
    // Bounded, so a warm-up can never hang about.
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('never throws', async () => {
    const transport: DecisionTransport = {
      fetch: async () => {
        throw new Error('ENOTFOUND api.typesafe.ai');
      },
      isWarm: () => false,
    };
    await expect(warmConnection({ secret: 'k', transport })).resolves.toBeUndefined();
  });
});
