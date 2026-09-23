import { afterEach, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import type { AutomationHomeView } from '../src/automations/targets.js';
import { ASSISTANT_MAX_TURNS, createAssistantConversation } from '../src/ai/assistant-agent.js';
import { assistantSystemPrompt } from '../src/ai/assistant-prompts.js';
import {
  ASSISTANT_MAX_COMMANDS_PER_DEVICE,
  assistantTools,
  runAssistantTool,
  type AssistantToolContext,
} from '../src/ai/assistant-tools.js';
import { AGENT_MODELS } from '../src/ai/models.js';
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

/**
 * The same bound, seen from the loop: how many devices one *message* moves.
 *
 * `runAssistantTool` allows every device, but a message may take only
 * `ASSISTANT_MAX_TURNS` rounds — so a model left to work one device a round
 * would run out of them at about nine devices, with nothing wrong except the
 * pacing. Every call in a response is carried out, so the answer is one
 * response carrying all of them, and the prompt says so.
 */
describe('one message, the whole home', () => {
  /** One SSE frame, exactly as the Responses stream writes it. */
  const frame = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

  /** A fresh streamed body per request: a `ReadableStream` is read once. */
  const answering = (output: unknown[]) => () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            frame('response.completed', {
              response: { status: 'completed', output, usage: { input_tokens: 100, output_tokens: 50 } },
            }),
          ),
        );
        controller.close();
      },
    });
    return Promise.resolve(
      new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('carries out every device one response names, in that one round', async () => {
    // More devices than a message has rounds, so this cannot pass by pacing.
    const count = ASSISTANT_MAX_TURNS * 2;
    const home = homeOf(count);
    const context = contextFor(home);
    const calls = home.devices.map((device, index) => ({
      type: 'function_call',
      call_id: `call_${index}`,
      name: 'control_device',
      // A string of JSON on this API, never an object.
      arguments: JSON.stringify({ deviceId: device.id, command: { type: 'power', on: false } }),
    }));
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(answering(calls))
      .mockImplementationOnce(
        answering([{ type: 'message', content: [{ type: 'output_text', text: 'They are all off.' }] }]),
      );
    vi.stubGlobal('fetch', fetchMock);

    const conversation = await createAssistantConversation({
      auth: { secret: 'sk-proj-test' },
      provider: 'openai',
      modelId: AGENT_MODELS.openai.default,
      systemPrompt: 'system',
      taskPrompt: 'this home',
      tools: context,
      log: pino({ level: 'silent' }),
    });
    const turn = await conversation.send('turn off all the lights');

    expect(turn).toEqual({ kind: 'said', text: 'They are all off.' });
    expect(context.sent.map((entry) => entry.deviceId)).toEqual(home.devices.map((device) => device.id));
    // Two rounds: the one that did it, and the one that said so — with every
    // call answered in the second request, or the API refuses the next one.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const init = fetchMock.mock.calls[1]?.[1] as RequestInit | undefined;
    const second = JSON.parse(String(init?.body)) as { input: { type?: string }[] };
    expect(second.input.filter((item) => item.type === 'function_call_output')).toHaveLength(count);
  });

  it('asks the model for every device in the same response', () => {
    // The wording is the behaviour: without it a model may well pace itself a
    // device a round, and the test above could never catch that.
    expect(assistantSystemPrompt([])).toContain('in the same response, however many there are');
    const control = assistantTools([]).find((tool) => tool.name === 'control_device');
    expect(control?.description).toContain('all of them in the same response');
  });
});
