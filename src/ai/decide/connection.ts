/**
 * The one connection this hub keeps open to the decision model — which is
 * where almost all of a decision's latency was going.
 *
 * **A decision is about a fifth of a second of work behind a handshake that
 * cost more than that.** Node's global `fetch` keeps an idle connection for
 * about four seconds and then closes it, so nearly every sentence somebody
 * typed or said arrived to a closed connection: DNS, TCP and TLS from a
 * Raspberry Pi to the vendor, two or three round trips before the request was
 * even sent. Measured from a home a few thousand kilometres away that is most
 * of a 700 ms deadline, and it is what `Jev stood down — didn't answer in time`
 * in a real hub's log turned out to be: not the model being slow, the hub
 * dialling it from scratch every time.
 *
 * So this is `node:https` with a keep-alive agent of its own, and **no
 * dependency** — `undici` would give `fetch` a dispatcher to configure, and it
 * is not in the tree; the built-in agent does the one thing needed. Three
 * properties, each deliberate:
 *
 * - **Idle connections are kept for minutes, not seconds** (`IDLE_MS`), and a
 *   server's own `Keep-Alive: timeout=` hint still wins when it is shorter —
 *   `https.Agent` honours it — so the hub never holds a socket the other end
 *   has already let go of on purpose.
 * - **A socket the server closed while it sat idle is not a failure.** The
 *   request never reached anybody, so it is sent once more on a fresh
 *   connection (`req.reusedSocket`, the documented pattern). Anything else goes
 *   up exactly as it came.
 * - **It returns a real `Response`**, so `typesafe.ts` reads a reply the same
 *   way whichever transport carried it, and a test can stand a stub in for
 *   this with nothing about the parsing changing.
 *
 * `warm` opens the connection before anybody needs it — when the assistant's
 * page opens, or a voice session starts — so the first sentence is as fast as
 * the second. `docs/jev.md` is canonical.
 */
import type { Agent as HttpAgent, ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import { Agent, request as httpsRequest } from 'node:https';

/**
 * How a decision reaches the vendor: `fetch`'s own signature, narrowed to what
 * is used, so the global `fetch` and a test's stub both fit it.
 */
export type DecisionFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface DecisionTransport {
  fetch: DecisionFetch;
  /**
   * Whether a connection is open and idle, so the next request skips the
   * handshake. For the log line that says why something was slow — never for
   * a branch.
   */
  isWarm(): boolean;
}

/**
 * How long an idle connection is kept.
 *
 * Long enough to cover somebody opening the assistant, reading, and typing a
 * sentence — the ordinary gap between `warm` and the first decision — and the
 * gap between one message and the next in a conversation. A free socket costs
 * a file descriptor and a TLS session and nothing else; a cold one costs the
 * person a second. The server's own hint is honoured when it is shorter.
 */
export const IDLE_MS = 4 * 60_000;

/**
 * TCP keep-alive probes on the idle socket, so a home router's NAT table does
 * not forget the connection while the TLS session is still perfectly good.
 */
const PROBE_MS = 30_000;

/**
 * At most this many connections at once.
 *
 * One is the ordinary case; a second exists for a live decision arriving while
 * a speculative one is still out, which is allowed to proceed rather than wait
 * (`lazy.ts`). Four is a bound, not a target.
 */
const MAX_SOCKETS = 4;

/** Where the vendor's model list lives — the cheapest request that opens a connection. */
const WARM_URL = 'https://api.typesafe.ai/v1/models';

/** The longest a warm-up may take. Nobody waits for it. */
const WARM_TIMEOUT_MS = 8_000;

const agent = new Agent({
  keepAlive: true,
  keepAliveMsecs: PROBE_MS,
  maxSockets: MAX_SOCKETS,
  maxFreeSockets: 2,
  timeout: IDLE_MS,
  // The most recently used socket first: it is the one most likely to still
  // be open at the other end.
  scheduling: 'lifo',
});

/** Is there an idle, open connection in this agent's pool? */
function hasFreeSocket(pool: HttpAgent): boolean {
  return Object.values(pool.freeSockets).some((sockets) => (sockets?.length ?? 0) > 0);
}

/**
 * The server let go of a kept-alive socket just as it was reused.
 *
 * `ECONNRESET` is also what "socket hang up" carries. Only ever asked about a
 * *reused* socket, which is what makes retrying safe: on a fresh connection
 * the same error means the server really did refuse.
 */
function isStale(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ECONNRESET' || code === 'EPIPE' || code === 'ECONNABORTED';
}

/** `fetch`'s headers, whichever of its three shapes they arrived in. */
function headerRecord(headers: RequestInit['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers === undefined) return out;
  new Headers(headers).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/** The response's headers as `fetch` would have handed them over. */
function responseHeaders(res: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(res.headers)) {
    if (value === undefined) continue;
    for (const one of Array.isArray(value) ? value : [value]) headers.append(key, one);
  }
  return headers;
}

/** Statuses a `Response` must be built without a body for. */
const NULL_BODY = new Set([101, 204, 205, 304]);

/**
 * A `fetch` over one keep-alive agent.
 *
 * Built from its parts so a test can hand it a plain `http` agent and a local
 * server, and assert what it does with a connection — which is the whole of
 * why it exists — rather than trusting that it does it.
 */
export function createKeepAliveFetch(options: {
  agent: HttpAgent;
  request: (url: string, options: RequestOptions, callback: (res: IncomingMessage) => void) => ClientRequest;
}): DecisionFetch {
  const send = (url: string, init: RequestInit, attempt: number): Promise<Response> =>
    new Promise<Response>((resolve, reject) => {
      const body = typeof init.body === 'string' ? init.body : undefined;
      const headers = headerRecord(init.headers);
      if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body));
      const signal = init.signal ?? undefined;

      let request: ClientRequest;
      try {
        request = options.request(
          url,
          {
            method: init.method ?? 'GET',
            headers,
            agent: options.agent,
            ...(signal !== undefined ? { signal } : {}),
          },
          (res) => {
            const chunks: Buffer[] = [];
            let ended = false;
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.once('end', () => {
              ended = true;
              const status = res.statusCode ?? 502;
              resolve(
                new Response(NULL_BODY.has(status) ? null : Buffer.concat(chunks), {
                  status,
                  headers: responseHeaders(res),
                }),
              );
            });
            res.once('error', reject);
            // A body cut off part-way — the caller's own abort, or the far end
            // going away — is an error rather than a short answer.
            res.once('close', () => {
              if (!ended) reject(new Error('the connection closed before the reply finished'));
            });
          },
        );
      } catch (error) {
        reject(error);
        return;
      }
      request.once('error', (error) => {
        if (attempt === 0 && request.reusedSocket && isStale(error) && signal?.aborted !== true) {
          send(url, init, 1).then(resolve, reject);
          return;
        }
        reject(error);
      });
      request.end(body);
    });

  return (url, init) => send(url, init, 0);
}

/** The transport every decision goes through, unless a test hands in its own. */
export const keepAliveTransport: DecisionTransport = {
  fetch: createKeepAliveFetch({ agent, request: httpsRequest }),
  isWarm: () => hasFreeSocket(agent),
};

/**
 * Open the connection now, so the first decision does not pay for it.
 *
 * **The request is the vendor's model list, and nothing reads the answer.** It
 * is the cheapest authenticated request there is — no questions, no tokens —
 * and what it buys is the handshake. The hub still never *chooses* a model
 * from it: the model is pinned (`DECISION_MODEL`) because every threshold was
 * set against it.
 *
 * Never throws: a warm-up that failed costs exactly the cold start it was
 * trying to save, and the decision that follows says so on its own.
 */
export async function warmConnection(input: {
  secret: string;
  transport: DecisionTransport;
}): Promise<void> {
  try {
    await input.transport.fetch(WARM_URL, {
      method: 'GET',
      headers: { authorization: `Bearer ${input.secret}` },
      signal: AbortSignal.timeout(WARM_TIMEOUT_MS),
    });
  } catch {
    // Nothing to do: the next decision dials as it always would have.
  }
}
