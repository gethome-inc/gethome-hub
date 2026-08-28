import { z } from 'zod';

import type { HomeStructure } from '../core/bus.js';
import type { ActivityService } from '../core/activity.js';
import type { HistoryService, HistoryKind } from '../core/history.js';
import { HISTORY_KINDS } from '../core/history.js';
import type { HomeService } from '../core/home.js';
import type { DeviceRegistry } from '../core/registry.js';
import type { HubEventBus } from '../core/bus.js';
import { actionSchema, sendAndConfirm, toHubCommand, type McpAction } from './commands.js';
import {
  DEVICE_PAGE_LIMIT,
  deviceDetail,
  deviceRow,
  displayUnit,
  displayValue,
  primaryEndpoint,
  resolveDevice,
  structureIndex,
} from './devices.js';

/**
 * The tools an assistant is given, and nothing else.
 *
 * Seven, chosen so that each one answers a question a person actually asks of
 * their home. The hub's REST surface is much wider than this and the width is
 * deliberately not passed through: members, roles, invites, the radio switch,
 * the hub update and every structural edit are absent, because an assistant
 * that can reorganise the house or take the hub offline is a different product
 * with a different set of risks, and none of it is what "turn the kitchen
 * light off" needs. `docs/mcp.md` records what is excluded and why, and
 * `test/mcp-coverage.test.ts` fails if that list stops matching the schema.
 */

export interface McpContext {
  registry: DeviceRegistry;
  history: HistoryService;
  activity: ActivityService;
  home: HomeService;
  events: HubEventBus;
  readStructure: () => Promise<HomeStructure>;
  /** Whether this connection may work the home, or only look at it. */
  canControl: boolean;
  /** Who the activity log names for anything this connection does. */
  memberId: string;
  /** What the connection is called, for the activity log's `data`. */
  clientLabel: string;
  version: string;
  build?: string;
}

/** What a tool hands back. `structuredContent` is optional; the text is not. */
export interface ToolOutcome {
  text: string;
  structured?: unknown;
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  schema: z.ZodType;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  run: (input: unknown, ctx: McpContext) => Promise<ToolOutcome>;
}

/**
 * Annotations for a tool that only reads.
 *
 * These are not decoration. A host uses them to decide whether to interrupt
 * the person and ask before running something, and the spec's defaults are
 * `destructiveHint: true` and `openWorldHint: true` — so a tool that says
 * nothing is treated as though it might destroy something in an unbounded
 * world. Left unset, asking "is the back door locked?" would prompt for
 * confirmation.
 */
const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const emptySchema = z.object({});

const deviceRef = z
  .string()
  .min(1)
  .describe('A device id, the short ref from list_devices, or the device’s name.');

/**
 * Turn a zod schema into the JSON Schema `tools/list` has to publish.
 *
 * `z.toJSONSchema` is zod's own, from 4.3 onwards, so this costs no
 * dependency — which matters here more than usual, since the whole reason
 * this server is written by hand is that the official SDK brought a subtree
 * back with it.
 */
function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' }) as Record<
    string,
    unknown
  >;
}

export function toolListEntry(tool: ToolDefinition): Record<string, unknown> {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: jsonSchema(tool.schema),
    annotations: { title: tool.title, ...tool.annotations },
  };
}

async function indexFor(ctx: McpContext) {
  return structureIndex(await ctx.readStructure());
}

export const TOOLS: readonly ToolDefinition[] = [
  {
    name: 'get_home',
    title: 'Describe the home',
    description:
      'The home as a whole: its name, its rooms and zones, how many devices there are and how ' +
      'many are on, offline or need attention. Call this first when you do not yet know what ' +
      'this home contains.',
    schema: emptySchema,
    annotations: READ_ONLY,
    async run(_input, ctx) {
      const structure = await ctx.readStructure();
      const devices = ctx.registry.listDevices();
      const online = devices.filter((device) => device.online);
      const on = online.filter((device) => primaryEndpoint(device)?.state.onOff === true);

      const zoneName = new Map(structure.zones.map((zone) => [zone.id, zone.name]));
      const rooms = structure.rooms.map((room) => ({
        name: room.name,
        zone: room.zoneId ? (zoneName.get(room.zoneId) ?? null) : null,
        devices: devices.filter((device) => device.roomId === room.id).length,
      }));
      const unplaced = devices.filter((device) => device.roomId === null).length;

      const structured = {
        name: ctx.home.name,
        hubVersion: ctx.version,
        ...(ctx.build ? { hubBuild: ctx.build } : {}),
        deviceCount: devices.length,
        onlineCount: online.length,
        runningCount: on.length,
        rooms,
        ...(unplaced > 0 ? { devicesWithNoRoom: unplaced } : {}),
      };

      const roomLine = rooms.length
        ? rooms.map((room) => `${room.name} (${room.devices})`).join(', ')
        : 'no rooms yet';
      return {
        text:
          `${ctx.home.name}: ${devices.length} devices, ${online.length} online, ` +
          `${on.length} switched on. Rooms: ${roomLine}.`,
        structured,
      };
    },
  },

  {
    name: 'list_devices',
    title: 'List devices',
    description:
      'Every device in the home, one line each, optionally narrowed by room, kind, state or a ' +
      'search of the name. Returns a summary per device rather than full state — use get_device ' +
      'once you know which one you want.',
    schema: z.object({
      room: z.string().optional().describe('Only devices in this room, by name.'),
      kind: z.string().optional().describe('Only this device kind, e.g. light, lock, sensor.'),
      state: z
        .enum(['on', 'off', 'offline'])
        .optional()
        .describe('Only devices currently in this state.'),
      search: z.string().optional().describe('Only devices whose name contains this text.'),
    }),
    annotations: READ_ONLY,
    async run(input, ctx) {
      const args = input as {
        room?: string;
        kind?: string;
        state?: 'on' | 'off' | 'offline';
        search?: string;
      };
      const index = await indexFor(ctx);
      let rows = ctx.registry.listDevices().map((device) => deviceRow(device, index));

      if (args.room) {
        const wanted = args.room.toLowerCase();
        rows = rows.filter((row) => row.room?.toLowerCase() === wanted);
      }
      if (args.kind) {
        const wanted = args.kind.toLowerCase();
        rows = rows.filter((row) => row.kind.toLowerCase() === wanted);
      }
      if (args.search) {
        const wanted = args.search.toLowerCase();
        rows = rows.filter((row) => row.name.toLowerCase().includes(wanted));
      }
      if (args.state === 'offline') rows = rows.filter((row) => !row.online);
      if (args.state === 'on') rows = rows.filter((row) => row.online && row.state.startsWith('on'));
      if (args.state === 'off') rows = rows.filter((row) => row.online && row.state.startsWith('off'));

      const total = rows.length;
      const shown = rows.slice(0, DEVICE_PAGE_LIMIT);
      const truncated = total > shown.length;

      const text = shown.length
        ? shown
            .map((row) => `${row.name}${row.room ? ` — ${row.room}` : ''} · ${row.state} · ${row.ref}`)
            .join('\n')
        : 'No devices match that.';

      return {
        text: truncated
          ? `${text}\n\n(${shown.length} of ${total}; narrow the search to see the rest.)`
          : text,
        structured: { devices: shown, total, truncated },
      };
    },
  },

  {
    name: 'get_device',
    title: 'Look at one device',
    description:
      'Everything the hub knows about one device: every reading in ordinary units, and the list ' +
      'of actions control_device will accept for it.',
    schema: z.object({ device: deviceRef }),
    annotations: READ_ONLY,
    async run(input, ctx) {
      const { device: query } = input as { device: string };
      const index = await indexFor(ctx);
      const found = resolveDevice(ctx.registry.listDevices(), query, index.roomName);
      if (!found.found) return { text: found.reason, isError: true };

      const detail = deviceDetail(found.device, index);
      return {
        text:
          `${detail.name}${detail.room ? ` (${detail.room})` : ''} — ${detail.kind}, ` +
          `${detail.online ? 'online' : 'offline'}. ${detail.state}.`,
        structured: detail,
      };
    },
  },

  {
    name: 'find_device',
    title: 'Find a device by name',
    description:
      'Search devices by name, room or kind when you are not sure what something is called. ' +
      'Returns every match, so use it before control_device when a name might be ambiguous.',
    schema: z.object({ query: z.string().min(1) }),
    annotations: READ_ONLY,
    async run(input, ctx) {
      const { query } = input as { query: string };
      const index = await indexFor(ctx);
      const wanted = query.trim().toLowerCase();
      const matches = ctx.registry
        .listDevices()
        .map((device) => deviceRow(device, index))
        .filter(
          (row) =>
            row.name.toLowerCase().includes(wanted) ||
            row.room?.toLowerCase().includes(wanted) ||
            row.kind.toLowerCase().includes(wanted),
        )
        .slice(0, DEVICE_PAGE_LIMIT);

      return {
        text: matches.length
          ? matches
              .map((row) => `${row.name}${row.room ? ` — ${row.room}` : ''} · ${row.state} · ${row.ref}`)
              .join('\n')
          : `Nothing matches "${query}".`,
        structured: { devices: matches },
      };
    },
  },

  {
    name: 'control_device',
    title: 'Work a device',
    description:
      'Switch a device on or off, set a brightness, colour, temperature, lock, blind position, ' +
      'fan speed or playback. Everything is in ordinary units: percentages, degrees Celsius, ' +
      'kelvin. Call get_device first if you are unsure which actions a device accepts. The ' +
      'answer says whether the device actually confirmed the change.',
    schema: z.object({ device: deviceRef, action: actionSchema }),
    annotations: {
      readOnlyHint: false,
      // Switching a lamp on is reversible by switching it off; nothing here
      // deletes or overwrites anything the home cannot get back.
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async run(input, ctx) {
      const args = input as { device: string; action: McpAction };

      if (!ctx.canControl) {
        return {
          text:
            'This connection can only look at the home, not work it. Whoever set it up chose ' +
            'read-only; a new connection with control turned on would be needed.',
          isError: true,
        };
      }

      const index = await indexFor(ctx);
      const found = resolveDevice(ctx.registry.listDevices(), args.device, index.roomName);
      if (!found.found) return { text: found.reason, isError: true };

      const device = found.device;
      const endpoint = primaryEndpoint(device);
      if (!endpoint) {
        return { text: `${device.name} has no endpoint to command.`, isError: true };
      }

      let command;
      try {
        command = toHubCommand(args.action, endpoint);
      } catch (error) {
        return { text: error instanceof Error ? error.message : String(error), isError: true };
      }

      const outcome = await sendAndConfirm(ctx.registry, ctx.events, device, endpoint, command);

      // The home's history says an assistant did this, and names the person
      // whose connection it was — the log is shared by design, and "the
      // kitchen light went off by itself" is exactly what it exists to answer.
      await ctx.activity.record({
        kind: 'device.command',
        message: `${ctx.clientLabel} sent ${args.action.action} to ${device.name}`,
        deviceId: device.id,
        memberId: ctx.memberId,
        data: {
          command: args.action.action,
          deviceName: device.name,
          via: 'mcp',
          client: ctx.clientLabel,
        },
      });

      return {
        text: outcome.summary,
        structured: { ok: outcome.ok, summary: outcome.summary, state: outcome.state },
        ...(outcome.ok ? {} : { isError: true }),
      };
    },
  },

  {
    name: 'get_device_history',
    title: 'Read a device’s recorded readings',
    description:
      'What one measurement did over a window — temperature, humidity, CO₂, power and so on. ' +
      'The hub records five-minute buckets and keeps about a week, so anything older is gone.',
    schema: z.object({
      device: deviceRef,
      quantity: z
        .enum(HISTORY_KINDS as unknown as [HistoryKind, ...HistoryKind[]])
        .describe('Which measurement to read.'),
      range: z.enum(['hour', 'day', 'week']).default('day'),
      points: z.number().int().min(2).max(200).default(60),
    }),
    annotations: READ_ONLY,
    async run(input, ctx) {
      const args = input as {
        device: string;
        quantity: HistoryKind;
        range: 'hour' | 'day' | 'week';
        points: number;
      };
      const index = await indexFor(ctx);
      const found = resolveDevice(ctx.registry.listDevices(), args.device, index.roomName);
      if (!found.found) return { text: found.reason, isError: true };

      const to = Date.now();
      const span =
        args.range === 'hour' ? 60 * 60 * 1000 : args.range === 'day' ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;

      const page = await ctx.history.read(found.device.id, {
        from: to - span,
        to,
        points: args.points,
        kinds: [args.quantity],
      });

      const series = page.series[0];
      if (!series || series.points.length === 0) {
        return {
          text: `${found.device.name} has no recorded ${args.quantity} over the last ${args.range}.`,
          structured: { points: [] },
        };
      }

      // Converted here, and this is the one route that used to leak the wire.
      // `HistoryService` stores what the sensor reported in the hub's own
      // scale, because a stored average cannot be merged; every client
      // converts on read. A temperature handed over as `2150` beside the word
      // `centiCelsius` is one a model reports as two thousand degrees.
      const unit = displayUnit(series.unit);
      const show = (value: number) => displayValue(series.unit, value);
      const points = series.points.map(
        (point) => [point[0], show(point[1]), show(point[2]), show(point[3])] as const,
      );

      const values = points.map((point) => point[3]);
      const min = Math.min(...points.map((point) => point[1]));
      const max = Math.max(...points.map((point) => point[2]));
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length;

      return {
        text:
          `${found.device.name} ${args.quantity} over the last ${args.range}: ` +
          `low ${min} ${unit}, high ${max} ${unit}, ` +
          `average ${Math.round(mean * 10) / 10} ${unit}, from ${points.length} points.`,
        structured: {
          unit,
          bucketMs: page.bucketMs,
          start: page.start,
          end: page.end,
          retentionDays: page.retentionDays,
          points,
        },
      };
    },
  },

  {
    name: 'get_activity',
    title: 'Read what has happened in the home',
    description:
      'The home’s recent history, newest first — who changed what, and when. Each line is the ' +
      'hub’s own sentence.',
    schema: z.object({ limit: z.number().int().min(1).max(50).default(20) }),
    annotations: READ_ONLY,
    async run(input, ctx) {
      const { limit } = input as { limit: number };
      const rows = await ctx.activity.list(limit);
      return {
        text: rows.length
          ? rows.map((row) => `${row.at.toISOString()} — ${row.message}`).join('\n')
          : 'Nothing has been recorded yet.',
        structured: {
          entries: rows.map((row) => ({
            at: row.at.toISOString(),
            kind: row.kind,
            message: row.message,
          })),
        },
      };
    },
  },
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));
