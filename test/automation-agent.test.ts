import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { HubEventBus } from '../src/core/bus.js';
import { ActivityService } from '../src/core/activity.js';
import { AiRunLog } from '../src/core/ai-runs.js';
import { SettingsService } from '../src/core/settings.js';
import {
  aiRuns as aiRunsTable,
  members as membersTable,
  settings as settingsTable,
} from '../src/db/schema.js';
import { openTestDb, resetDb, startedAutomations, type TestDb } from './helpers/db.js';
import type { AutomationConversation, AutomationTurn } from '../src/ai/automation-conversation.js';

/**
 * The automation agent: the loop over a mocked SDK, and the conversation
 * service over a stand-in for one.
 *
 * **The mock reproduces the SDK's own client-side guards**, which is the
 * lesson `test/ai-agent.test.ts` paid for: `create` refuses a non-streaming
 * request whose `max_tokens` could run past the API's ten-minute ceiling, so a
 * bare `vi.fn()` accepts what the real client refuses and the suite ends up
 * testing the mock. Every reply here goes through `stream`, and `create`
 * throws exactly as the SDK does.
 */
const { streamMock, nonStreamingCeiling } = vi.hoisted(() => ({
  streamMock: vi.fn(),
  nonStreamingCeiling: Math.floor((600_000 * 128_000) / 3_600_000),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = {
      create: async (params: { max_tokens: number }) => {
        if (params.max_tokens > nonStreamingCeiling) {
          throw new Error(
            'Streaming is required for operations that may take longer than 10 minutes.',
          );
        }
        return streamMock(params);
      },
      stream: (params: unknown) => {
        const message = streamMock(params);
        return {
          // The agent subscribes to text deltas so a chat is not a silent
          // minute; a mock without `on` would let that be deleted unnoticed.
          on: (event: string, handler: (delta: string) => void) => {
            if (event !== 'text') return;
            for (const block of (message as { content: { type: string; text?: string }[] }).content) {
              if (block.type === 'text' && block.text) handler(block.text);
            }
          },
          finalMessage: async () => message,
        };
      },
    };
  },
}));

const { createAutomationConversation } = await import('../src/ai/automation-agent.js');
const { AutomationChat, AutomationNotConfiguredError } = await import('../src/ai/automation-chat.js');

const log = pino({ level: 'silent' });
const deviceId = randomUUID();

// ── Fixtures ─────────────────────────────────────────────────────────────────

const goodDocument = {
  version: 1,
  name: 'Evening lights',
  mode: 'single',
  triggers: [{ kind: 'manual' }],
  actions: [{ kind: 'logActivity', message: 'Evening' }],
};

function assistant(content: unknown[], stopReason = 'tool_use') {
  return {
    content,
    stop_reason: stopReason,
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

const text = (value: string) => ({ type: 'text', text: value });
const toolUse = (name: string, input: unknown, id: string = randomUUID()) => ({
  type: 'tool_use',
  id,
  name,
  input,
});

function conversationFor(homeDevices: { id: string; name: string }[] = []) {
  return createAutomationConversation({
    auth: { secret: 'sk-ant-test' },
    modelId: 'claude-opus-5',
    systemPrompt: 'system',
    taskPrompt: 'this home',
    log,
    tools: {
      home: () => ({
        devices: homeDevices.map((device) => ({
          id: device.id,
          name: device.name,
          roomId: null,
          online: true,
          endpoints: [
            { endpointId: 1, deviceKind: 'light' as const, capabilities: ['onOff' as const] },
          ],
        })),
        rooms: [],
        zones: [],
        automations: [],
      }),
      timezone: () => 'UTC',
      stateOf: () => undefined,
    },
  });
}

// ── The loop ─────────────────────────────────────────────────────────────────

describe('the automation conversation', () => {
  beforeEach(() => {
    streamMock.mockReset();
  });

  it('streams what the model says and hands back when it stops with prose', async () => {
    streamMock.mockReturnValueOnce(assistant([text('Which lamp did you mean?')], 'end_turn'));
    const conversation = conversationFor();
    const deltas: string[] = [];

    const turn = await conversation.send('do something', {
      onDelta: (delta) => deltas.push(delta),
    });

    expect(turn.kind).toBe('said');
    // Prose is a perfectly good end to a *chat* turn — unlike the mapping run,
    // where it means the answer channel went unused.
    expect((turn as { text: string }).text).toContain('Which lamp');
    expect(deltas.join('')).toContain('Which lamp');
  });

  it('never uses the non-streaming call, whose ceiling it would exceed', async () => {
    streamMock.mockReturnValueOnce(assistant([text('hello')], 'end_turn'));
    await conversationFor().send('hi');
    // The parameters the loop actually sent — proof it went through `stream`,
    // since `create` would have thrown on the way in.
    expect(streamMock.mock.calls[0]?.[0]).toMatchObject({
      model: 'claude-opus-5',
      thinking: { type: 'adaptive', display: 'summarized' },
    });
  });

  it('caches the system prompt and the conversation tail', async () => {
    streamMock.mockReturnValueOnce(assistant([text('hello')], 'end_turn'));
    await conversationFor().send('hi');
    const params = streamMock.mock.calls[0]?.[0] as {
      system: { cache_control?: unknown }[];
      cache_control?: unknown;
    };
    // Two breakpoints: the explicit one covers the tools with the system
    // prompt, and the top-level field covers the growing tail — which here
    // carries the home inventory over every round of clarification.
    expect(params.system[0]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(params.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('suspends on a question and closes it with the answer', async () => {
    const callId = 'ask-1';
    streamMock
      .mockReturnValueOnce(
        assistant([
          toolUse('ask_user', { question: 'Which lamp?', options: [{ id: 'a', label: 'Bedside' }] }, callId),
        ]),
      )
      .mockReturnValueOnce(assistant([toolUse('submit_automation', { document: goodDocument })]));

    const conversation = conversationFor();
    const first = await conversation.send('lights please');
    expect(first.kind).toBe('question');
    expect((first as { question: { options?: unknown[] } }).question.options).toHaveLength(1);
    expect(conversation.awaitingAnswer()).toBe(true);

    const second = await conversation.answer('Bedside');
    expect(second.kind).toBe('submitted');
    expect(conversation.awaitingAnswer()).toBe(false);

    // The answer went back as a `tool_result` for the open call — a plain user
    // message there is a conversation the API refuses.
    //
    // Searched rather than indexed from the end: `messages` is passed to the
    // client by reference and the loop keeps pushing onto the same array, so
    // the last element by the time a test looks is not what was sent.
    const secondRequest = streamMock.mock.calls[1]?.[0] as {
      messages: { role: string; content: unknown }[];
    };
    const answered = secondRequest.messages.find(
      (message) =>
        message.role === 'user' &&
        Array.isArray(message.content) &&
        (message.content as { type: string }[]).some((block) => block.type === 'tool_result'),
    );
    expect(answered?.content).toEqual([
      { type: 'tool_result', tool_use_id: callId, content: 'Bedside' },
    ]);
  });

  it('treats a typed reply to a question as the answer to it', async () => {
    streamMock
      .mockReturnValueOnce(assistant([toolUse('ask_user', { question: 'Which lamp?' }, 'ask-2')]))
      .mockReturnValueOnce(assistant([text('Right you are.')], 'end_turn'));

    const conversation = conversationFor();
    await conversation.send('lights');
    // `send` rather than `answer`: somebody typed instead of tapping, and
    // treating that as a fresh message would leave the call unclosed.
    await conversation.send('the bedside one');
    const request = streamMock.mock.calls[1]?.[0] as { messages: unknown[] };
    expect(JSON.stringify(request.messages)).toContain('tool_result');
    expect(JSON.stringify(request.messages)).toContain('the bedside one');
  });

  it('hands a refused document back inside the same turn, so the model fixes it', async () => {
    streamMock
      .mockReturnValueOnce(
        assistant([
          toolUse('submit_automation', {
            document: { ...goodDocument, triggers: [], actions: [] },
          }),
        ]),
      )
      .mockReturnValueOnce(assistant([toolUse('submit_automation', { document: goodDocument })]));

    const turn = await conversationFor().send('write me a rule');
    expect(turn.kind).toBe('submitted');
    // The person never saw the first attempt: the refusal went back as a tool
    // result and the model resubmitted in the same turn.
    const second = streamMock.mock.calls[1]?.[0] as { messages: { content: unknown }[] };
    expect(JSON.stringify(second.messages)).toContain('refused');
  });

  it('refuses a rule the home cannot use, with the reason', async () => {
    streamMock
      .mockReturnValueOnce(
        assistant([
          toolUse('submit_automation', {
            document: {
              ...goodDocument,
              triggers: [
                {
                  kind: 'deviceState',
                  target: { deviceIds: [deviceId] },
                  path: 'power.activeMilliwatts',
                  op: 'lt',
                  value: 2000,
                },
              ],
            },
          }),
        ]),
      )
      .mockReturnValueOnce(assistant([text('I will fix that.')], 'end_turn'));

    const turn = await conversationFor([{ id: deviceId, name: 'Lamp' }]).send('washing machine');
    expect(turn.kind).toBe('said');
    const second = streamMock.mock.calls[1]?.[0] as { messages: unknown[] };
    expect(JSON.stringify(second.messages)).toContain('changes continuously');
  });

  it('answers an ordinary tool call and carries on', async () => {
    streamMock
      .mockReturnValueOnce(assistant([toolUse('list_devices', {})]))
      .mockReturnValueOnce(assistant([toolUse('submit_automation', { document: goodDocument })]));

    const steps: string[] = [];
    const turn = await conversationFor([{ id: deviceId, name: 'Kitchen lamp' }]).send('what have I got', {
      onStep: (summary) => steps.push(summary),
    });
    expect(turn.kind).toBe('submitted');
    expect(steps.join(' ')).toContain('list_devices');
    const second = streamMock.mock.calls[1]?.[0] as { messages: unknown[] };
    expect(JSON.stringify(second.messages)).toContain('Kitchen lamp');
  });

  it('stops rather than looping for ever', async () => {
    // A model that only ever looks things up. The cap is what a person waiting
    // is protected by.
    streamMock.mockReturnValue(assistant([toolUse('list_rooms_zones', {})]));
    const turn = await conversationFor().send('go on then');
    expect(turn.kind).toBe('stopped');
    expect((turn as { reason: string }).reason).toContain('steps');
  });

  it('says so when the model declines', async () => {
    streamMock.mockReturnValueOnce(assistant([], 'refusal'));
    const turn = await conversationFor().send('something');
    expect(turn.kind).toBe('stopped');
    expect((turn as { reason: string }).reason).toContain('declined');
  });
});

// ── The conversation service ─────────────────────────────────────────────────

let handle: TestDb;
const startedEngines: { stop: () => Promise<void> }[] = [];

afterAll(async () => {
  // Each engine attaches bus listeners; leaving them would leak one set per
  // test against the bus's cap of a hundred.
  await Promise.allSettled(startedEngines.map((engine) => engine.stop()));
  await handle?.close();
});

describe('the chat service', () => {
  let events: HubEventBus;
  let settings: SettingsService;
  let memberId: string;
  /** `gate`, when given, is what the scripted turn waits on before answering —
   *  a provider that is taking its time, which is the ordinary case. */
  let chatFor: (turns: AutomationTurn[], gate?: Promise<void>) => Promise<{
    chat: InstanceType<typeof AutomationChat>;
    engine: Awaited<ReturnType<typeof startedAutomations>>['engine'];
  }>;

  beforeEach(async () => {
    handle ??= (await openTestDb())!;
    await resetDb(handle.db);
    events = new HubEventBus();
    settings = new SettingsService(handle.db, Buffer.alloc(32).toString('base64'));
    await settings.setAiKey('anthropic', 'sk-ant-api03-test');
    // A real row: `automation_chat_messages.member_id` is a foreign key, and a
    // made-up id makes every write fail silently into the transcript's own
    // catch — which is exactly how a missing transcript would look in
    // production too.
    memberId = randomUUID();
    await handle.db.insert(membersTable).values({ id: memberId, name: 'Anna', role: 'member' });

    chatFor = async (turns, gate) => {
      const activity = new ActivityService(handle.db, events);
      const registry = { listDevices: () => [], execute: async () => {} };
      const { engine, store } = await startedAutomations(handle.db, events, registry, activity);
      startedEngines.push(engine);
      let index = 0;
      const scripted: AutomationConversation = {
        provider: 'anthropic',
        modelId: 'claude-opus-5',
        awaitingAnswer: () => false,
        costUsd: () => 0.12,
        send: async () => {
          await gate;
          return turns[index++] ?? { kind: 'said', text: 'nothing left to say' };
        },
        answer: async () => {
          await gate;
          return turns[index++] ?? { kind: 'said', text: 'nothing left to say' };
        },
      };
      const chat = new AutomationChat({
        db: handle.db,
        settings,
        engine,
        store,
        events,
        runs: new AiRunLog(handle.db, events),
        log,
        createConversation: () => scripted,
      });
      return { chat, engine };
    };
  });

  it('saves a submitted rule switched off, and shows it as a preview', async () => {
    const { chat, engine } = await chatFor([
      { kind: 'submitted', document: goodDocument, accepted: true, text: 'Here you go.' },
    ]);

    // `start` answers the moment the message is taken — an acknowledgement,
    // not an outcome — so the assertion belongs on the stored transcript,
    // which is what the app actually draws.
    const reply = await chat.start({ memberId: memberId, message: 'evening lights please' });
    expect(reply.messages.map((message) => message.role)).toEqual(['user']);
    await chat.idle();

    const transcript = await chat.transcript(reply.sessionId);
    const preview = transcript.find((message) => message.role === 'preview');
    expect(preview).toBeDefined();
    const data = preview?.data as { automationId: string; enabled: boolean };
    expect(data.enabled).toBe(false);

    // The rule really exists, and really is off — the one moment somebody can
    // still look at what is about to start happening in their house.
    const saved = engine.get(data.automationId);
    expect(saved?.name).toBe('Evening lights');
    expect(saved?.enabled).toBe(false);
  });

  it('writes the transcript, and it outlives the conversation', async () => {
    const { chat } = await chatFor([
      { kind: 'question', question: { question: 'Which lamp?', options: [{ id: 'a', label: 'Bedside' }] } },
      { kind: 'said', text: 'Right you are.' },
    ]);

    const started = await chat.start({ memberId: memberId, message: 'lights' });
    await chat.idle();
    await chat.reply(started.sessionId, memberId, 'the bedside one');
    await chat.idle();

    const transcript = await chat.transcript(started.sessionId);
    expect(transcript.map((message) => message.role)).toEqual([
      'user',
      'question',
      'user',
      'agent',
    ]);
    // The options ride along, because a person taps one rather than typing.
    expect((transcript[1]?.data as { options: unknown[] }).options).toHaveLength(1);

    await chat.close(started.sessionId);
    // Gone as a conversation, still there as history: the split that makes
    // keeping a chat affordable at all.
    expect(chat.isLive(started.sessionId)).toBe(false);
    expect(await chat.transcript(started.sessionId)).toHaveLength(4);
  });

  it('records what the conversation spent, in the one AI list', async () => {
    const { chat } = await chatFor([
      { kind: 'submitted', document: goodDocument, accepted: true, text: '' },
    ]);
    await chat.start({ memberId: memberId, message: 'go' });
    // The spend is written by the *turn*, not by the request that started it —
    // which is the whole point of answering as soon as the message is taken.
    await chat.idle();

    const rows = await handle.db.select().from(aiRunsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('automate');
    expect(rows[0]?.costUsd).toBeCloseTo(0.12);
    // A conversation is not about a device model, and says so rather than
    // inventing a hash.
    expect(rows[0]?.exposesHash).toBe('');
  });

  it('refuses when the owner has switched AI off, and says which of the two it is', async () => {
    await settings.setAiEnabled(false);
    const { chat } = await chatFor([]);
    await expect(chat.start({ memberId: memberId, message: 'go' })).rejects.toBeInstanceOf(
      AutomationNotConfiguredError,
    );
    await expect(chat.start({ memberId: memberId, message: 'go' })).rejects.toMatchObject({
      code: 'ai_disabled',
    });

    await settings.setAiEnabled(true);
    await settings.clearAiProvider('anthropic');
    await expect(chat.start({ memberId: memberId, message: 'go' })).rejects.toMatchObject({
      code: 'ai_not_configured',
    });
  });

  it('answers nothing for a conversation that has gone', async () => {
    const { chat } = await chatFor([]);
    // What the route turns into a 410: the transcript is still readable, and
    // what is gone is the ability to continue.
    expect(await chat.reply(randomUUID(), memberId, 'still there?')).toBeNull();
  });

  it('answers as soon as the message is taken, not when the turn ends', async () => {
    // **The bug this exists to stop coming back.** A turn is a loop against a
    // provider with a three-minute watchdog, and the request that started it
    // was held open for the whole thing — against a client that gives a hub
    // ten seconds. A conversation that was working perfectly reported "the
    // request timed out" every time, and the reply it went on to produce
    // arrived on a socket nobody was still waiting on.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { chat } = await chatFor([{ kind: 'said', text: 'took a while' }], held);

    // The turn cannot finish yet, so anything that waited on it would hang
    // here — the whole assertion is that this line returns at all.
    const started = await chat.start({ memberId, message: 'go' });

    // And what comes back is an acknowledgement: the person's own row, so the
    // app draws what was typed straight away. The agent's answer arrives on
    // the socket.
    expect(started.messages.map((message) => message.role)).toEqual(['user']);
    expect(await chat.transcript(started.sessionId)).toHaveLength(1);

    release();
    await chat.idle();
    expect((await chat.transcript(started.sessionId)).map((m) => m.role)).toEqual(['user', 'agent']);
  });

  it('will not let one member continue another member’s conversation', async () => {
    const { chat } = await chatFor([{ kind: 'said', text: 'hello' }]);
    const started = await chat.start({ memberId: memberId, message: 'go' });
    expect(await chat.reply(started.sessionId, randomUUID(), 'and me')).toBeNull();
  });
});

/**
 * Which provider a conversation runs on, and what it says when it cannot run.
 *
 * **These are the only tests here that do not stub the provider seam**, and
 * that is the whole point: every other test in this file hands
 * `createConversation` a scripted conversation, so the code that decides
 * *whether there is a conversation to have* had no coverage at all — and it
 * shipped refusing a home for the wrong reason and answering 500 when it did.
 */
describe('AutomationChat provider selection', () => {
  // `TestDb`, not the helper's optional return: `openTestDb()` answers `null`
  // where the suite is skipped, and every use below would otherwise need a
  // non-null assertion. The `beforeEach` asserts it once, as the suite above
  // does.
  let handle: TestDb;
  let events: HubEventBus;
  let settings: SettingsService;
  let memberId: string;

  /** A chat with the seam recording what it was handed, so a test can see
   *  which key a conversation would have run on without making a request. */
  let chatFor: () => Promise<{
    chat: InstanceType<typeof AutomationChat>;
    handed: { secret?: string; modelId?: string };
  }>;

  beforeEach(async () => {
    handle ??= (await openTestDb())!;
    await resetDb(handle.db);
    events = new HubEventBus();
    settings = new SettingsService(handle.db, Buffer.alloc(32).toString('base64'));
    memberId = randomUUID();
    await handle.db.insert(membersTable).values({ id: memberId, name: 'Anna', role: 'member' });

    chatFor = async () => {
      const activity = new ActivityService(handle.db, events);
      const registry = { listDevices: () => [], execute: async () => {} };
      const { engine, store } = await startedAutomations(handle.db, events, registry, activity);
      startedEngines.push(engine);
      const handed: { secret?: string; modelId?: string } = {};
      const chat = new AutomationChat({
        db: handle.db,
        settings,
        engine,
        store,
        events,
        runs: new AiRunLog(handle.db, events),
        log,
        createConversation: ({ secret, modelId }) => {
          handed.secret = secret;
          handed.modelId = modelId;
          return {
            provider: 'anthropic',
            modelId,
            awaitingAnswer: () => false,
            costUsd: () => 0,
            send: async () => ({ kind: 'said', text: 'hello' }) as AutomationTurn,
            answer: async () => ({ kind: 'said', text: 'hello' }) as AutomationTurn,
          };
        },
      });
      return { chat, handed };
    };
  });

  const refusal = async (chat: InstanceType<typeof AutomationChat>) => {
    try {
      await chat.start({ memberId, message: 'lights at ten please' });
      return null;
    } catch (error) {
      return error;
    }
  };

  it('runs on Anthropic even when the home recognises devices with OpenAI', async () => {
    // The bug this file exists to stop coming back. `ai.provider` answers
    // "which model reads a device's exposes tree" — an unrelated preference —
    // and reading it here refused a home that had the very key this agent
    // needs, then reported the refusal as a 500.
    await settings.setAiKey('anthropic', 'sk-ant-api03-the-right-one');
    await settings.setAiKey('openai', 'sk-openai-the-wrong-one');
    await settings.setMappingProvider('openai');

    const { chat, handed } = await chatFor();
    await chat.start({ memberId, message: 'lights at ten please' });
    await chat.idle();

    expect(handed.secret).toBe('sk-ant-api03-the-right-one');
  });

  it('refuses a home whose only key is OpenAI’s, in words and with a code', async () => {
    await settings.setAiKey('openai', 'sk-openai-only');

    const { chat } = await chatFor();
    const error = await refusal(chat);

    // A *refusal*, not a failure: the home is configured, just not for this.
    // The route turns this into a 409 an app can branch on; anything else
    // reaches a phone as "The hub answered 500."
    expect(error).toBeInstanceOf(AutomationNotConfiguredError);
    expect((error as InstanceType<typeof AutomationNotConfiguredError>).code).toBe(
      'automation_needs_anthropic',
    );
    // And it carries a sentence, so an app that has never met the code still
    // has something true to print.
    expect((error as Error).message).toMatch(/Anthropic key/);
  });

  it('treats a legacy subscription token as no Anthropic key at all', async () => {
    // The loop authenticates with `x-api-key`, so the subscription token a
    // hub configured before the Agent SDK was removed still holds cannot run
    // it — and a home in that state needs to be told which *kind* of key to
    // add, not that it has none. The state only exists on an upgraded hub, so
    // the test writes the stored setting the way that hub carries it.
    await settings.setAiKey('openai', 'sk-openai-only');
    await settings.setAiKey('anthropic', 'legacy-subscription-token');
    await handle.db
      .insert(settingsTable)
      .values({ key: 'ai_auth_type', value: 'oauth_token' })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value: 'oauth_token' } });
    expect((await settings.getAiSettings()).legacySubscriptionToken).toBe(true);

    const { chat } = await chatFor();
    const error = await refusal(chat);

    expect((error as InstanceType<typeof AutomationNotConfiguredError>).code).toBe(
      'automation_needs_anthropic',
    );
  });

  it('says nothing is configured when the home has no key at all', async () => {
    const { chat } = await chatFor();
    const error = await refusal(chat);

    expect((error as InstanceType<typeof AutomationNotConfiguredError>).code).toBe(
      'ai_not_configured',
    );
  });

  it('says AI is switched off rather than unconfigured when the owner turned it off', async () => {
    // Two codes because they lead to two different screens, and this one must
    // not send somebody looking for a key they already have.
    await settings.setAiKey('anthropic', 'sk-ant-api03-test');
    await settings.setAiEnabled(false);

    const { chat } = await chatFor();
    const error = await refusal(chat);

    expect((error as InstanceType<typeof AutomationNotConfiguredError>).code).toBe('ai_disabled');
  });
});
