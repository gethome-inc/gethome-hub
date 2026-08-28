import {
  RPC_INTERNAL_ERROR,
  RPC_INVALID_PARAMS,
  RPC_METHOD_NOT_FOUND,
  negotiateVersion,
  rpcError,
  rpcResult,
  type ParsedMessage,
  type RpcResponse,
} from './protocol.js';
import { TOOLS, TOOLS_BY_NAME, toolListEntry, type McpContext } from './catalog.js';

/**
 * The MCP server proper: five methods, dispatched.
 *
 * It is handed a fully-resolved `McpContext` per request rather than holding
 * one, because `canControl`, the member the activity log names and the label
 * of the connection all come from the token that made the call — two
 * assistants on one hub are two different sets of permissions and two
 * different names in the home's history.
 */

const SERVER_NAME = 'gethome-hub';

export function handleRpc(message: ParsedMessage, ctx: McpContext): Promise<RpcResponse | null> {
  if (message.kind === 'error') return Promise.resolve(message.response);

  // A notification is answered with silence and a 202 — the spec's rule, and
  // the only one MCP actually sends is `notifications/initialized`.
  if (message.kind === 'notification') return Promise.resolve(null);

  return dispatch(message.method, message.params, ctx)
    .then((result) => rpcResult(message.id, result))
    .catch((error: unknown) => {
      if (error instanceof RpcFault) {
        return rpcError(message.id, error.code, error.message);
      }
      return rpcError(
        message.id,
        RPC_INTERNAL_ERROR,
        error instanceof Error ? error.message : 'The hub failed to answer that.',
      );
    });
}

/**
 * Thrown by a handler to answer with a specific JSON-RPC error.
 *
 * Only for *protocol* faults — an unknown method, an unknown tool, a malformed
 * argument. A tool that ran and failed is not this: it answers with
 * `isError: true` and a sentence, because the model is supposed to read what
 * went wrong and try something else, and a transport-level error is not shown
 * to it.
 *
 * **There is one of these, and it is deliberately not exported.** `protocol.ts`
 * carried an `RpcException` with this same job and this same doc comment, and
 * nothing ever threw or caught it — `handleRpc` catches only this class. Two
 * classes for one concept, one of them exported from the module a contributor
 * reads first, is an even chance of throwing the one nothing catches, which
 * surfaces as a generic `-32603` instead of the code that was meant. Anything
 * that needs to raise a protocol fault belongs in this file.
 */
class RpcFault extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

async function dispatch(method: string, params: unknown, ctx: McpContext): Promise<unknown> {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: negotiateVersion(
          (params as { protocolVersion?: unknown } | undefined)?.protocolVersion,
        ),
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, title: ctx.home.name, version: ctx.version },
        instructions:
          `This is ${ctx.home.name}, a GetHome smart-home hub. Call get_home first to learn ` +
          `what the home contains, then list_devices or find_device to locate something, then ` +
          `get_device or control_device. Devices can be named by their id, their short ref or ` +
          `their name. Everything is in ordinary units — percentages, °C, kelvin.`,
      };

    case 'ping':
      return {};

    case 'tools/list':
      return { tools: TOOLS.map(toolListEntry) };

    case 'tools/call':
      return callTool(params, ctx);

    default:
      throw new RpcFault(RPC_METHOD_NOT_FOUND, `This hub does not implement "${method}".`);
  }
}

/**
 * Run one tool.
 *
 * The split between a JSON-RPC error and `isError: true` is the spec's and it
 * matters: a protocol fault (no such tool, arguments that do not fit the
 * schema) is a transport-level error the model never sees, while a tool that
 * ran and could not do the thing answers normally with `isError` set, so the
 * model reads the reason and can try something else. "There is no device
 * called that" belongs in the second category, which is why `resolveDevice`
 * returns a sentence rather than throwing.
 */
async function callTool(params: unknown, ctx: McpContext): Promise<unknown> {
  const call = params as { name?: unknown; arguments?: unknown } | undefined;
  if (typeof call?.name !== 'string') {
    throw new RpcFault(RPC_INVALID_PARAMS, 'A tools/call needs a "name".');
  }

  const tool = TOOLS_BY_NAME.get(call.name);
  if (!tool) throw new RpcFault(RPC_METHOD_NOT_FOUND, `There is no tool called "${call.name}".`);

  const parsed = tool.schema.safeParse(call.arguments ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new RpcFault(RPC_INVALID_PARAMS, `Those arguments do not fit ${tool.name}: ${issues}`);
  }

  const outcome = await tool.run(parsed.data, ctx);

  return {
    content: [{ type: 'text', text: outcome.text }],
    ...(outcome.structured !== undefined ? { structuredContent: outcome.structured } : {}),
    ...(outcome.isError ? { isError: true } : {}),
  };
}
