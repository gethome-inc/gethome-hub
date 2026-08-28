/**
 * MCP's wire format, by hand.
 *
 * The Model Context Protocol is JSON-RPC 2.0 over one HTTP POST — five methods
 * and a handful of shapes — and this file is all of it. There is an official
 * TypeScript SDK and this repository deliberately does not use it: it was in
 * this dependency graph once, underneath the Claude Agent SDK, and left with
 * it (`@modelcontextprotocol/sdk → hono`) in the change that took the bundle
 * from 117 MB to 29 MB. Taking it back for two hundred lines of dispatch would
 * undo that trade on the board this hub is built for.
 *
 * Nothing here knows about Fastify, devices, or the hub. It parses, routes and
 * formats; `server.ts` supplies the handlers.
 */

/**
 * Spec revisions this server will agree to speak. Newest first.
 *
 * **`2026-07-28` is deliberately absent, and it is not a matter of being
 * behind.** That revision is a different protocol wearing the same name: it
 * *removes* the `initialize` / `notifications/initialized` handshake, makes
 * every request self-describing through `_meta`
 * (`io.modelcontextprotocol/protocolVersion`, `/clientInfo`,
 * `/clientCapabilities`), retires `Mcp-Session-Id`, and **requires** servers to
 * implement `server/discover`. This server implements the handshake and none
 * of that.
 *
 * Listing it anyway would be a lie told at the worst moment: a client that
 * sends no `protocolVersion` — or one we do not know — is answered with the
 * newest entry here, so it would be told `2026-07-28` and could then proceed
 * on the modern dispatch path, which this endpoint answers `-32601` to. The
 * version we name has to be one we can actually behave like.
 *
 * Adding it back is a real piece of work, not a line: `server/discover`, per
 * request `_meta` validation, and a second dispatch path beside this one.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
] as const;

export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export type ProtocolVersion = (typeof SUPPORTED_PROTOCOL_VERSIONS)[number];

/** The JSON-RPC 2.0 error codes, plus nothing of our own. */
export const RPC_PARSE_ERROR = -32_700;
export const RPC_INVALID_REQUEST = -32_600;
export const RPC_METHOD_NOT_FOUND = -32_601;
export const RPC_INVALID_PARAMS = -32_602;
export const RPC_INTERNAL_ERROR = -32_603;

export type RpcId = string | number;

export interface RpcRequest {
  jsonrpc: '2.0';
  id?: RpcId;
  method: string;
  params?: unknown;
}

export interface RpcSuccess {
  jsonrpc: '2.0';
  id: RpcId;
  result: unknown;
}

export interface RpcFailure {
  jsonrpc: '2.0';
  id: RpcId | null;
  error: { code: number; message: string; data?: unknown };
}

export type RpcResponse = RpcSuccess | RpcFailure;

export function rpcResult(id: RpcId, result: unknown): RpcSuccess {
  return { jsonrpc: '2.0', id, result };
}

export function rpcError(
  id: RpcId | null,
  code: number,
  message: string,
  data?: unknown,
): RpcFailure {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

/**
 * Thrown by a handler to answer with a specific JSON-RPC error.
 *
 * Only for *protocol* faults — an unknown tool, a malformed argument. A tool
 * that ran and failed is not this: it answers with `isError: true` and a
 * sentence, because the model is supposed to read what went wrong and try
 * something else, and a transport-level error is not shown to it.
 */
export class RpcException extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'RpcException';
  }
}

/**
 * Agree a protocol version with the client.
 *
 * The rule is the spec's: answer with the client's own version when we speak
 * it, and with our newest when we don't, leaving the client to decide whether
 * it can live with that. A client that sends nothing at all gets our newest —
 * an omission is not a disagreement.
 */
export function negotiateVersion(requested: unknown): string {
  if (typeof requested !== 'string') return LATEST_PROTOCOL_VERSION;
  return (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : LATEST_PROTOCOL_VERSION;
}

/**
 * What a parsed body turned out to be.
 *
 * `notification` is its own outcome rather than a request with no id, because
 * the two are answered differently all the way out to HTTP: a request gets a
 * JSON body, a notification gets 202 and nothing at all.
 */
export type ParsedMessage =
  | { kind: 'request'; id: RpcId; method: string; params: unknown }
  | { kind: 'notification'; method: string; params: unknown }
  | { kind: 'error'; response: RpcFailure };

/**
 * Read one JSON-RPC message out of a request body.
 *
 * **A batch is refused.** JSON-RPC batching was removed from MCP in the
 * 2025-06-18 revision, so an array here is either a client speaking something
 * older than anything we support or a client that has gone wrong — and
 * accepting it would mean a second code path through every handler, with
 * fan-out and partial failure to get right, for a shape the spec has dropped.
 */
export function parseMessage(body: unknown): ParsedMessage {
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return {
        kind: 'error',
        response: rpcError(null, RPC_PARSE_ERROR, 'The request body is not valid JSON.'),
      };
    }
  }

  if (Array.isArray(body)) {
    return {
      kind: 'error',
      response: rpcError(
        null,
        RPC_INVALID_REQUEST,
        'Batched requests are not supported — send one JSON-RPC message per POST.',
      ),
    };
  }

  if (typeof body !== 'object' || body === null) {
    return {
      kind: 'error',
      response: rpcError(null, RPC_INVALID_REQUEST, 'The request body must be a JSON object.'),
    };
  }

  const message = body as Record<string, unknown>;
  const id = message['id'];
  const hasId = typeof id === 'string' || typeof id === 'number';

  if (message['jsonrpc'] !== '2.0') {
    return {
      kind: 'error',
      response: rpcError(
        hasId ? (id as RpcId) : null,
        RPC_INVALID_REQUEST,
        'Every message must carry "jsonrpc": "2.0".',
      ),
    };
  }

  if (typeof message['method'] !== 'string') {
    return {
      kind: 'error',
      response: rpcError(
        hasId ? (id as RpcId) : null,
        RPC_INVALID_REQUEST,
        'Every message must carry a "method" string.',
      ),
    };
  }

  const method = message['method'];
  const params = message['params'];

  return hasId
    ? { kind: 'request', id: id as RpcId, method, params }
    : { kind: 'notification', method, params };
}
