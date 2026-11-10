import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { automationDevices } from '../src/automations/scope.js';
import { automationDocumentSchema } from '../src/automations/schema.js';
import type { AutomationHomeView } from '../src/automations/targets.js';

/**
 * The devices a rule uses, as the two lists every rule on the wire carries —
 * what lets a device's page name the rules that use it.
 */

const kitchen = randomUUID();
const hall = randomUUID();
const motion = randomUUID();
const door = randomUUID();
const lamp = randomUUID();
const hallLamp = randomUUID();
const plug = randomUUID();

const device = (
  id: string,
  name: string,
  roomId: string | null,
  deviceKind: 'light' | 'sensor' | 'outlet',
  capabilities: ('onOff' | 'level' | 'occupancy' | 'contact' | 'electricalPower')[],
) => ({ id, name, roomId, online: true, endpoints: [{ endpointId: 1, deviceKind, capabilities }] });

const home: AutomationHomeView = {
  devices: [
    device(motion, 'Motion', kitchen, 'sensor', ['occupancy']),
    device(door, 'Door', hall, 'sensor', ['contact']),
    device(lamp, 'Lamp', kitchen, 'light', ['onOff', 'level']),
    device(hallLamp, 'Hall lamp', hall, 'light', ['onOff']),
    device(plug, 'Plug', kitchen, 'outlet', ['onOff', 'electricalPower']),
  ],
  rooms: [
    { id: kitchen, name: 'Kitchen', zoneId: null },
    { id: hall, name: 'Hall', zoneId: null },
  ],
  zones: [],
  automations: [],
};

describe('the devices a rule uses', () => {
  it('lists what it watches and what it works, conditions and the off-branch included', () => {
    const document = automationDocumentSchema.parse({
      name: 'Kitchen',
      triggers: [
        { kind: 'deviceState', target: { deviceIds: [motion] }, path: 'sensors.occupied', op: 'eq', value: true },
      ],
      conditions: [
        {
          kind: 'not',
          condition: {
            kind: 'deviceState',
            target: { deviceIds: [door] },
            path: 'sensors.contactClosed',
            op: 'eq',
            value: false,
          },
        },
      ],
      actions: [
        // A selector means what it resolves to today: the Kitchen's lights.
        {
          kind: 'deviceCommand',
          target: { select: { kind: 'light', roomId: kitchen } },
          command: { type: 'power', on: true },
        },
        { kind: 'wait', ms: 1000 },
      ],
    });
    expect(automationDevices(document, home)).toEqual({ reads: [motion, door], controls: [lamp] });
  });

  it('names a device once, and in both lists when a rule reads and works it', () => {
    const document = automationDocumentSchema.parse({
      name: 'Standby',
      triggers: [
        {
          kind: 'deviceState',
          target: { deviceIds: [plug] },
          path: 'power.activeMilliwatts',
          op: 'lt',
          value: 5000,
          for: 60_000,
        },
      ],
      actions: [
        { kind: 'deviceCommand', target: { deviceIds: [plug] }, command: { type: 'power', on: false } },
        { kind: 'deviceCommand', target: { deviceIds: [plug, hallLamp] }, command: { type: 'power', on: false } },
      ],
    });
    expect(automationDevices(document, home)).toEqual({ reads: [plug], controls: [plug, hallLamp] });
  });

  it('answers two empty lists for a rule that touches no device', () => {
    const document = automationDocumentSchema.parse({
      name: 'Note',
      triggers: [{ kind: 'manual' }],
      actions: [{ kind: 'logActivity', message: 'hello' }],
    });
    expect(automationDevices(document, home)).toEqual({ reads: [], controls: [] });
  });
});
