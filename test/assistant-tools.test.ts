import { describe, expect, it } from 'vitest';
import type { AutomationHomeView } from '../src/automations/targets.js';
import {
  ASSISTANT_MAX_COMMANDS_PER_DEVICE,
  runAssistantTool,
  type AssistantToolContext,
} from '../src/ai/assistant-tools.js';
import type { HubCommand } from '../src/schema/index.js';

/**
 * `control_device`, the one tool the assistant writes to the home with.
 *
 * What is pinned here is how much one reply may do. It was eight commands per
 * reply, which cut every whole-home request short — "turn off all the lights"
 * in a flat with fifteen bulbs switched off eight and asked permission for the
 * rest — so a request somebody can say in one sentence could not be carried
 * out in one reply. The bound is per device now: every device in the house
 * once, and never one device over and over.
 */

function homeOf(count: number): AutomationHomeView {
  return {
    rooms: [{ id: 'kitchen', name: 'Kitchen', zoneId: null }],
    zones: [],
    automations: [],
    devices: Array.from({ length: count }, (_, index) => ({
      id: `light-${index}`,
      name: `Light ${index}`,
      roomId: 'kitchen',
      online: true,
      endpoints: [{ endpointId: 1, deviceKind: 'light' as const, capabilities: ['onOff' as const, 'level' as const] }],
    })),
  };
}

function contextFor(home: AutomationHomeView): AssistantToolContext & { sent: { deviceId: string; command: HubCommand }[] } {
  const sent: { deviceId: string; command: HubCommand }[] = [];
  return {
    sent,
    home: () => home,
    timezone: () => 'UTC',
    stateOf: () => undefined,
    control: async (deviceId, _endpointId, command) => {
      sent.push({ deviceId, command });
    },
    runAutomation: async () => true,
    delegate: async () => ({ sessionId: 's', text: '' }),
    delegates: [],
  };
}

describe('working the home from a reply', () => {
  it('works every device in a large home in one reply', async () => {
    const home = homeOf(40);
    const context = contextFor(home);
    const budget = { perDevice: new Map<string, number>() };
    for (const device of home.devices) {
      const result = await runAssistantTool(
        'control_device',
        { deviceId: device.id, command: { type: 'power', on: false } },
        context,
        budget,
      );
      expect(result.isError, device.name).toBeFalsy();
    }
    expect(context.sent).toHaveLength(40);
  });

  it('stops one device being worked over and over in one reply', async () => {
    const context = contextFor(homeOf(2));
    const budget = { perDevice: new Map<string, number>() };
    const level = (value: number) => ({
      deviceId: 'light-0',
      command: { type: 'setLevel', level: value },
    });
    for (let step = 1; step <= ASSISTANT_MAX_COMMANDS_PER_DEVICE; step += 1) {
      const result = await runAssistantTool('control_device', level(step * 10), context, budget);
      expect(result.isError, `command ${step}`).toBeFalsy();
    }
    const refused = await runAssistantTool('control_device', level(200), context, budget);
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('Light 0 has already been sent');
    // The other device was never touched, and is not held back by the first.
    const other = await runAssistantTool(
      'control_device',
      { deviceId: 'light-1', command: { type: 'power', on: true } },
      context,
      budget,
    );
    expect(other.isError).toBeFalsy();
    expect(context.sent).toHaveLength(ASSISTANT_MAX_COMMANDS_PER_DEVICE + 1);
  });

  it('refuses a device that is not in this home without counting it', async () => {
    const context = contextFor(homeOf(1));
    const budget = { perDevice: new Map<string, number>() };
    const result = await runAssistantTool(
      'control_device',
      { deviceId: 'nowhere', command: { type: 'power', on: true } },
      context,
      budget,
    );
    expect(result).toMatchObject({ isError: true, text: 'There is no device with that id in this home.' });
    expect(budget.perDevice.size).toBe(0);
  });
});
