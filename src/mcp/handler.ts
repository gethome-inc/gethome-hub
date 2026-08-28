import type { AccessService } from '../core/access.js';
import type { ActivityService } from '../core/activity.js';
import type { HomeStructure, HubEventBus } from '../core/bus.js';
import type { HistoryService } from '../core/history.js';
import type { HomeService } from '../core/home.js';
import type { DeviceRegistry } from '../core/registry.js';
import type { McpContext } from './catalog.js';
import { parseMessage, type RpcResponse } from './protocol.js';
import { handleRpc } from './server.js';
import type { McpIdentity } from './tokens.js';

/**
 * The seam between Fastify and the MCP server.
 *
 * `src/api/server.ts` imports this file **dynamically**, on the first request
 * to an enabled hub, so a home that has never switched assistant access on
 * never parses the tool catalog, zod's JSON Schema converter, or anything
 * under `src/mcp/` at all. That is the argument `src/index.ts` already makes
 * for `@matter/main`: the largest thing in a graph should not be loaded to
 * find out nobody wanted it.
 *
 * Everything below the seam takes hub services, never a request or a reply —
 * the adapter-boundary rule the rest of this codebase follows.
 */

export interface AnswerInput {
  body: unknown;
  identity: McpIdentity;
  registry: DeviceRegistry;
  history: HistoryService;
  activity: ActivityService;
  home: HomeService;
  events: HubEventBus;
  access: AccessService;
  readStructure: () => Promise<HomeStructure>;
  version: string;
  build?: string;
}

/** `null` means "this was a notification" — the caller answers 202 with no body. */
export async function answer(input: AnswerInput): Promise<RpcResponse | null> {
  const ctx: McpContext = {
    registry: input.registry,
    history: input.history,
    activity: input.activity,
    home: input.home,
    events: input.events,
    access: input.access,
    readStructure: input.readStructure,
    canControl: input.identity.canControl,
    memberId: input.identity.memberId,
    clientLabel: input.identity.label,
    version: input.version,
    ...(input.build ? { build: input.build } : {}),
  };

  return handleRpc(parseMessage(input.body), ctx);
}
