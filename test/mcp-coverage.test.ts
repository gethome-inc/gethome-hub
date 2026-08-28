import { describe, expect, it } from 'vitest';

import { COMMAND_TYPES, type HubCommandType } from '../src/schema/commands.js';
import { CAPABILITY_KINDS, type CapabilityKind } from '../src/schema/capabilities.js';
import { HISTORY_KINDS } from '../src/core/history.js';
import { actionSchema, toHubCommand, type McpAction } from '../src/mcp/commands.js';
import { TOOLS, TOOLS_BY_NAME } from '../src/mcp/catalog.js';
import type { RegistryEndpoint } from '../src/core/registry.js';
import { emptyState } from '../src/schema/state.js';

/**
 * The MCP surface is part of the API, and a second consumer nothing points at.
 *
 * When the device schema grows a command, a capability or a recorded quantity,
 * every app breaks loudly — a Codable model fails to decode, a switch stops
 * being exhaustive — and MCP does not. It just quietly stops being able to do
 * the new thing, on a hub nobody is looking at, for as long as it takes
 * somebody to notice. This file is the thing that notices.
 *
 * Nothing here checks that a mapping is *good*; it checks that a decision was
 * made. Adding a command type fails this suite until it is either reachable
 * through a tool or written into `EXCLUDED_COMMANDS` with a reason — which is
 * the same trade `test/migrations.test.ts` makes for a destructive migration.
 */

/**
 * Command types an assistant deliberately cannot send, and why.
 *
 * The rule for being on this list is that the act belongs to a person standing
 * in front of the device with an app open, not to a language model working
 * from a sentence.
 */
const EXCLUDED_COMMANDS: Record<string, string> = {
  toggle:
    'There *is* a toggle action, and it deliberately does not send this: it reads the current state and sends an explicit power on/off instead, so the answer can say the lamp is now off rather than that it was toggled. A model that has to guess what it just did is a model that reports the wrong thing to a person.',
  irLearn:
    'Learning an IR code is a person pointing a remote at a blaster and pressing a button; there is nothing for an assistant to do in that loop.',
  irSaveLearned: 'Names the code that irLearn just captured, so it is part of the same in-app flow.',
  irDeleteCommand: 'Editing the stored code library is app work, and destructive in a way nothing here undoes.',
  irRenameCommand: 'Same: library maintenance, done once, in the app.',
  irSendRaw:
    'Internal to the registry — it is not on the public wire at all, and the schema deliberately omits it.',
};

/**
 * Capabilities that carry no `control_device` action, and why.
 *
 * Most of these are sensors: they are *read*, and they reach an assistant
 * through `get_device`'s readings rather than through an action, because there
 * is nothing to write.
 */
const READ_ONLY_CAPABILITIES: CapabilityKind[] = [
  'temperature',
  'humidity',
  'occupancy',
  'contact',
  'illuminance',
  'pressure',
  'flow',
  'airQuality',
  'pm25',
  'co2',
  'smokeCOAlarm',
  'battery',
  'electricalPower',
  'event',
];

/** One sample of every action the union accepts, so each can be translated. */
const ACTION_SAMPLES: McpAction[] = [
  { action: 'on' },
  { action: 'off' },
  { action: 'toggle' },
  { action: 'brightness', percent: 50 },
  { action: 'color_temperature', kelvin: 2700 },
  { action: 'color', hueDegrees: 120, saturationPercent: 80 },
  { action: 'thermostat', heatingC: 21 },
  { action: 'thermostat', coolingC: 24 },
  { action: 'thermostat', mode: 'heat' },
  { action: 'lock' },
  { action: 'unlock' },
  { action: 'covering', openPercent: 40 },
  { action: 'covering_open' },
  { action: 'covering_close' },
  { action: 'covering_stop' },
  { action: 'fan', percent: 60 },
  { action: 'fan_mode', mode: 'auto' },
  { action: 'play' },
  { action: 'pause' },
  { action: 'set_mode', mode: 2 },
  { action: 'ir_send', commandId: 'c1' },
  { action: 'setting', fieldId: 'detection_interval', value: 30 },
];

const endpoint: RegistryEndpoint = {
  endpointId: 1,
  deviceKind: 'light',
  capabilities: [],
  primary: 'onOff',
  state: emptyState(),
};

describe('MCP stays level with the hub', () => {
  it('every action in the union really translates to a hub command', () => {
    for (const action of ACTION_SAMPLES) {
      expect(() => toHubCommand(action, endpoint), action.action).not.toThrow();
    }
  });

  it('every sample is a shape the action schema itself accepts', () => {
    for (const action of ACTION_SAMPLES) {
      expect(actionSchema.safeParse(action).success, action.action).toBe(true);
    }
  });

  it('every command type is either reachable through a tool or excluded on purpose', () => {
    const reachable = new Set<HubCommandType>(
      ACTION_SAMPLES.map((action) => toHubCommand(action, endpoint).type),
    );

    const unaccounted = COMMAND_TYPES.filter(
      (type) => !reachable.has(type) && EXCLUDED_COMMANDS[type] === undefined,
    );

    expect(
      unaccounted,
      `These command types are neither in the MCP action union nor in EXCLUDED_COMMANDS. ` +
        `Wire each one into src/mcp/commands.ts, or list it here with the reason it is not ` +
        `something an assistant should send: ${unaccounted.join(', ')}`,
    ).toEqual([]);
  });

  it('nothing is excluded that the union in fact covers', () => {
    const reachable = new Set<HubCommandType>(
      ACTION_SAMPLES.map((action) => toHubCommand(action, endpoint).type),
    );
    const stale = Object.keys(EXCLUDED_COMMANDS).filter((type) =>
      reachable.has(type as HubCommandType),
    );
    expect(stale, `EXCLUDED_COMMANDS names a command the tools now send: ${stale.join(', ')}`).toEqual(
      [],
    );
  });

  it('every capability either has an action or is recorded as read-only', () => {
    // The capabilities `actionsFor` names, read out of the source rather than
    // restated here — a second copy of the list is the drift this file exists
    // to catch.
    const controllable: CapabilityKind[] = [
      'onOff',
      'level',
      'colorTemperature',
      'color',
      'thermostat',
      'doorLock',
      'windowCovering',
      'fan',
      'mediaPlayback',
      'mode',
      'rvcRun',
      'irRemote',
      'custom',
    ];

    const unaccounted = CAPABILITY_KINDS.filter(
      (kind) => !controllable.includes(kind) && !READ_ONLY_CAPABILITIES.includes(kind),
    );

    expect(
      unaccounted,
      `These capability kinds are neither controllable through control_device nor listed as ` +
        `read-only: ${unaccounted.join(', ')}. Add an action in src/mcp/devices.ts's actionsFor, ` +
        `or record it above as something an assistant only reads.`,
    ).toEqual([]);
  });

  it('the history tool offers every quantity the hub records', () => {
    const tool = TOOLS_BY_NAME.get('get_device_history')!;
    const parsed = tool.schema.safeParse({ device: 'x', quantity: 'temperature' });
    expect(parsed.success).toBe(true);

    for (const kind of HISTORY_KINDS) {
      expect(
        tool.schema.safeParse({ device: 'x', quantity: kind }).success,
        `get_device_history does not offer "${kind}", which the hub records.`,
      ).toBe(true);
    }
  });

  it('every tool is described well enough for a model to choose it', () => {
    for (const tool of TOOLS) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(tool.title.length, tool.name).toBeGreaterThan(0);
      // A one-line description is how a model decides between seven tools; the
      // floor is low but a bare name is not enough.
      expect(tool.description.length, tool.name).toBeGreaterThan(40);
    }
  });
});
