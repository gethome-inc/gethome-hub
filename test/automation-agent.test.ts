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
import { automationSystemPrompt } from '../src/ai/automation-prompts.js';

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
          // The agent subscribes to **both** delta streams, so a chat is not a
          // silent minute; a mock without `on` would let either be deleted
          // unnoticed. `thinking` is the one that matters most here — with the
          // default `display` the real API streams thinking blocks empty, so a
          // mock that ignored the subscription would hide a run that shows
          // nothing for the longest part of every round.
          on: (event: string, handler: (delta: string) => void) => {
            const blocks = (message as {
              content: { type: string; text?: string; thinking?: string }[];
            }).content;
            for (const block of blocks) {
              if (event === 'text' && block.type === 'text' && block.text) handler(block.text);
              if (event === 'thinking' && block.type === 'thinking' && block.thinking) {
                handler(block.thinking);
              }
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
/** A summarized reasoning block, which is what `display: 'summarized'` returns
 *  and what the chat streams while nothing else is happening yet. */
const thinking = (value: string) => ({ type: 'thinking', thinking: value });

/**
 * Every `tool_use` id the conversation had answered by the time request `index`
 * went out.
 *
 * **Searched, not read off the tail.** The loop hands the *same* `messages`
 * array to every request and keeps pushing to it, so a mock call's `messages`
 * is the live array rather than a snapshot — asserting on `at(-1)` reads
 * whatever was appended last, which is usually the wrong message entirely.
 */
function closedToolIds(index: number): string[] {
  const request = streamMock.mock.calls[index]?.[0] as
    | { messages: { role: string; content: unknown }[] }
    | undefined;
  const ids: string[] = [];
  for (const message of request?.messages ?? []) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content as { type: string; tool_use_id?: string }[]) {
      if (block.type === 'tool_result' && block.tool_use_id) ids.push(block.tool_use_id);
    }
  }
  return ids;
}
const toolUse = (name: string, input: unknown, id: string = randomUUID()) => ({
  type: 'tool_use',
  id,
  name,
  input,
});

/** Set to make the home lookup throw — the "a tool blew up mid-round" path. */
let homeThrows = false;

function conversationFor(homeDevices: { id: string; name: string }[] = []) {
  return createAutomationConversation({
    auth: { secret: 'sk-ant-test' },
    modelId: 'claude-opus-5',
    systemPrompt: 'system',
    taskPrompt: 'this home',
    log,
    tools: {
      home: () => ({
        ...(homeThrows
          ? (() => {
              throw new Error('the registry fell over');
            })()
          : {}),
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
    homeThrows = false;
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

    const steps: { summary: string; kind: string }[] = [];
    const turn = await conversationFor([{ id: deviceId, name: 'Kitchen lamp' }]).send('what have I got', {
      onStep: (summary, kind) => steps.push({ summary, kind }),
    });
    expect(turn.kind).toBe('submitted');

    // **The trail is what somebody reads while they wait, so it is written for
    // them.** It used to be `Looked up list_devices.` — a function signature
    // read out loud, on the one screen whose whole job is telling somebody who
    // does not write software what their house is doing.
    expect(steps.map((step) => step.summary)).toEqual([
      'Reading your home',
      'Looking at your devices',
      'Working it out',
      'Wrote the rule',
    ]);
    // And a mark comes off `kind` rather than off the sentence, so an app does
    // not have to map seven tool names to draw one.
    expect(steps.map((step) => step.kind)).toEqual([
      'thinking',
      'reading',
      'thinking',
      'writing',
    ]);

    const second = streamMock.mock.calls[1]?.[0] as { messages: unknown[] };
    expect(JSON.stringify(second.messages)).toContain('Kitchen lamp');
  });

  it('closes every call in a response that also asked a question', async () => {
    /**
     * **The 400 this exists to stop coming back.** A model may look something
     * up *and* ask which lamp in one response, and the API's rule is per
     * response: every `tool_use` in an assistant turn must be answered by a
     * `tool_result` in the very next message. Handing the question back used
     * to `break` out of the call loop, so the other call was abandoned — and
     * the next request was refused outright with `messages.N: tool_use ids
     * were found without tool_result blocks`, which reached the chat as a
     * wall of JSON where the answer should have been.
     */
    // A call on **each side** of the question, because the two sides broke for
    // different reasons: the one before it was collected and then thrown away,
    // and the one after it was never run at all.
    streamMock
      .mockReturnValueOnce(
        assistant([
          toolUse('list_devices', {}, 'toolu_look'),
          toolUse('ask_user', { question: 'Which lamp?', options: [{ id: 'a', label: 'Bedside' }] }, 'toolu_ask'),
          toolUse('list_rooms_zones', {}, 'toolu_rooms'),
        ]),
      )
      .mockReturnValueOnce(assistant([text('Right you are.')], 'end_turn'));

    const conversation = conversationFor([{ id: deviceId, name: 'Bedside' }]);
    const asked = await conversation.send('lights');
    expect(asked.kind).toBe('question');

    await conversation.answer('the bedside one');

    // The message the answer produced has to account for **both** calls.
    //
    // Searched rather than read off the tail: the loop hands the *same*
    // `messages` array to every request and goes on pushing to it, so by the
    // time this runs the last entry is the final assistant turn. Asserting on
    // `at(-1)` here would be reading the wrong message.
    expect(new Set(closedToolIds(1))).toEqual(new Set(['toolu_look', 'toolu_ask', 'toolu_rooms']));
  });

  it('refuses a second question in one response rather than leaving it open', async () => {
    // Only one call id can be closed by an answer, so a second question is
    // answered here — leaving it open is the same 400 by another route.
    streamMock
      .mockReturnValueOnce(
        assistant([
          toolUse('ask_user', { question: 'Which lamp?', options: [{ id: 'a', label: 'Bedside' }] }, 'toolu_one'),
          toolUse('ask_user', { question: 'And when?', options: [{ id: 'b', label: 'At dusk' }] }, 'toolu_two'),
        ]),
      )
      .mockReturnValueOnce(assistant([text('Right you are.')], 'end_turn'));

    const conversation = conversationFor();
    const asked = await conversation.send('lights');
    expect(asked.kind).toBe('question');
    // The first is the one being waited on.
    if (asked.kind === 'question') expect(asked.question.question).toBe('Which lamp?');

    await conversation.answer('the bedside one');

    expect(new Set(closedToolIds(1))).toEqual(new Set(['toolu_one', 'toolu_two']));
  });

  it('keeps the rule and retracts the question when one response does both', async () => {
    /**
     * **The same 400 by a third route, and the one that also loses a rule.**
     * `handedBack` is a single slot, so a response carrying `ask_user` *and*
     * an accepted `submit_automation` used to overwrite one with the other —
     * whichever came second. With the question first, the submission won the
     * slot, the guard that stashes results never ran, and the next request
     * carried an assistant turn whose `ask_user` had no result: the
     * conversation refused outright, unrecoverably, since `pendingQuestion`
     * then routed the reply into a second orphaned result.
     *
     * A submission ends the turn, so the rule wins and the question is
     * retracted **inside** the turn, where the model can see it happen and
     * both calls are answered.
     */
    streamMock
      .mockReturnValueOnce(
        assistant([
          toolUse('ask_user', { question: 'Which lamp?', options: [{ id: 'a', label: 'Bedside' }] }, 'toolu_ask'),
          toolUse('submit_automation', { document: goodDocument }, 'toolu_submit'),
        ]),
      )
      .mockReturnValueOnce(assistant([text('unused')], 'end_turn'));

    const conversation = conversationFor();
    const turn = await conversation.send('evening lights');

    expect(turn.kind).toBe('submitted');
    // Both calls answered in the message the turn appended, so the next
    // request — whenever it comes — carries a whole assistant turn.
    expect(new Set(closedToolIds(0))).toEqual(new Set(['toolu_ask', 'toolu_submit']));
  });

  it('refuses a question asked after a rule was submitted in the same response', async () => {
    // The other order of the same collision. Here the question would have
    // taken the slot and the accepted rule would have been dropped silently —
    // the model told "Accepted" over a rule nothing ever wrote down.
    streamMock
      .mockReturnValueOnce(
        assistant([
          toolUse('submit_automation', { document: goodDocument }, 'toolu_submit'),
          toolUse('ask_user', { question: 'Anything else?', options: [{ id: 'a', label: 'No' }] }, 'toolu_ask'),
        ]),
      )
      .mockReturnValueOnce(assistant([text('unused')], 'end_turn'));

    const conversation = conversationFor();
    const turn = await conversation.send('evening lights');

    expect(turn.kind).toBe('submitted');
    expect(new Set(closedToolIds(0))).toEqual(new Set(['toolu_submit', 'toolu_ask']));
  });

  it('closes a tool call a failed round left open, instead of poisoning the chat', async () => {
    /**
     * **The 400 that never goes away.** The assistant turn is pushed the
     * moment it arrives, and anything that throws between that push and the
     * results leaves its `tool_use` unanswered. `exchange` catches the throw,
     * writes a note and leaves the conversation open — so the *next* message
     * is refused with `messages.N: tool_use ids were found without
     * tool_result blocks`, and so is every message after it. Seen on a real
     * hub, on a conversation whose question had just been answered.
     *
     * `evaluateSubmission` reading the home is a real one of those — it sits
     * outside `runAutomationTool`'s own catch, so a registry that falls over
     * while a rule is being checked throws straight out of the round.
     */
    homeThrows = true;

    streamMock
      .mockReturnValueOnce(
        assistant([toolUse('submit_automation', { document: goodDocument }, 'toolu_broken')]),
      )
      .mockReturnValueOnce(assistant([text('Right you are.')], 'end_turn'));

    const conversation = conversationFor();
    await expect(conversation.send('lights')).rejects.toThrow();

    // The conversation is still open, and saying something else has to work.
    homeThrows = false;
    const again = await conversation.send('try that again');
    expect(again.kind).toBe('said');

    // Every call the broken round made is accounted for in the request that
    // followed it — which is the whole of the API's rule.
    expect(closedToolIds(1)).toContain('toolu_broken');
  });

  it('answers the calls a paused turn made rather than skipping past them', async () => {
    // `pause_turn` asks to be called again with the same conversation. It was
    // read as "start the next round", which walked straight past any call the
    // paused response had made and left the turn half-answered.
    streamMock
      .mockReturnValueOnce(
        assistant([toolUse('list_rooms_zones', {}, 'toolu_paused')], 'pause_turn'),
      )
      .mockReturnValueOnce(assistant([text('Right you are.')], 'end_turn'));

    const turn = await conversationFor().send('lights');
    expect(turn.kind).toBe('said');
    expect(closedToolIds(1)).toContain('toolu_paused');
  });

  it('says something before the request, not only after it', async () => {
    // The longest silence in a round is *before* anything happens — the model
    // reading the home and deciding, with no tool called and no word written.
    // A step went up only once something had happened, so the whole of that
    // wait was a spinner.
    streamMock.mockReturnValueOnce(
      assistant([thinking('Weighing it up.'), text('Right you are.')], 'end_turn'),
    );

    const steps: string[] = [];
    let thought = '';
    await conversationFor().send('lights at ten', {
      onStep: (summary) => steps.push(summary),
      onThinking: (delta) => {
        thought += delta;
      },
    });

    expect(steps[0]).toBe('Reading your home');
    // And the reasoning is streamed as it arrives, which is what fills that
    // wait with words rather than with a dot.
    expect(thought).toBe('Weighing it up.');
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
  let chatFor: (
    turns: AutomationTurn[],
    gate?: Promise<void>,
    /** Make the disk refuse *after* the model has answered — the half of a
     *  turn that sits outside the provider call's own catch. */
    breakStore?: boolean,
  ) => Promise<{
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

    chatFor = async (turns, gate, breakStore) => {
      const activity = new ActivityService(handle.db, events);
      const registry = { listDevices: () => [], execute: async () => {} };
      const { engine, store } = await startedAutomations(handle.db, events, registry, activity);
      startedEngines.push(engine);
      if (breakStore) {
        store.create = async () => {
          throw new Error('database is locked');
        };
      }
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

    // **A line, then the card.** The card carries the rule's own sentence,
    // which is the same words for everybody; the line above it is the answer
    // to what was *asked* — what changed, in their language — and on an edit
    // it is the only thing that says so. It is the model's own prose from the
    // submitting response, never a canned "All done" written here.
    expect(transcript.map((message) => message.role)).toEqual([
      'user',
      'agent',
      'preview',
    ]);
    expect(transcript[1]?.text).toBe('Here you go.');

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

  it('asks for that line in the same message as the call, not after it', async () => {
    /**
     * **The turn ends when a submission is accepted**, so anything the model
     * plans to say afterwards is never said. The instruction to say it lived
     * in `submit_automation`'s own result — read only on the *next* turn,
     * where it is stale — and the paragraph above it in the prompt read as
     * "prose is not an answer". Between them a finished rule arrived as a
     * bare card with nothing said about it.
     */
    const prompt = automationSystemPrompt();
    expect(prompt).toContain('same message as that call');
    // And it says what the line is for: not the rule again, which the card
    // already carries.
    expect(prompt).toContain('do not describe it again');
  });

  it('survives a store that refuses after the model has already answered', async () => {
    /**
     * **The turn's promise must never reject.** Only the provider call was
     * inside a `try`, while everything after it touches the disk — the
     * transcript row, saving the rule, `engine.reload()`. A SQLite failure
     * there rejected the stored `inFlight` with nothing attached in that tick,
     * which on Node ≥15 takes the hub down, and made `close()` throw so the
     * conversation's spend was never written either.
     */
    const { chat } = await chatFor(
      [{ kind: 'submitted', document: goodDocument, accepted: true, text: 'Here you go.' }],
      undefined,
      true,
    );

    const started = await chat.start({ memberId: memberId, message: 'evening lights' });
    // `idle()` awaits the very promise that used to reject.
    await expect(chat.idle()).resolves.toBeUndefined();
    await expect(chat.close(started.sessionId)).resolves.toBeUndefined();

    // And the person is told, rather than left under a spinner.
    const transcript = await chat.transcript(started.sessionId);
    expect(transcript.some((message) => message.role === 'note')).toBe(true);
  });

  it('edits the rule it just wrote rather than writing a second one', async () => {
    /**
     * "Actually, make it half past seven" is the ordinary shape of this
     * conversation, and the model answers it by submitting a whole document
     * again — `submit_automation` is the only answer channel and it never
     * patches. The session only ever learned an id when the chat was *opened*
     * on an existing rule, so a second submission created a second rule and
     * left the draft nobody wanted sitting in the home.
     */
    const { chat, engine } = await chatFor([
      { kind: 'submitted', document: goodDocument, accepted: true, text: 'Here you go.' },
      {
        kind: 'submitted',
        document: { ...goodDocument, name: 'Evening lights, later' },
        accepted: true,
        text: 'Moved it.',
      },
    ]);

    const started = await chat.start({ memberId: memberId, message: 'evening lights' });
    await chat.idle();
    await chat.reply(started.sessionId, memberId, 'make it later');
    await chat.idle();

    expect(engine.list()).toHaveLength(1);
    expect(engine.list()[0]?.name).toBe('Evening lights, later');
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

  it('lists past conversations, newest first, and says which can go on', async () => {
    // **A chat you cannot get back to is a chat you have lost.** The
    // transcript outlives the conversation by a fortnight — the split that
    // makes keeping one affordable — and without this the only way back was a
    // session id nobody has written down.
    const { chat } = await chatFor([{ kind: 'said', text: 'hello' }]);
    const first = await chat.start({ memberId, message: 'lights in the hall' });
    await chat.idle();

    const { chat: other } = await chatFor([{ kind: 'said', text: 'hello' }]);
    const second = await other.start({ memberId, message: 'lock up at midnight' });
    await other.idle();
    // Ended as a conversation, still there as history.
    await other.close(second.sessionId);

    const listed = await chat.list();
    const ids = listed.map((entry) => entry.sessionId);
    expect(ids).toContain(first.sessionId);
    expect(ids).toContain(second.sessionId);

    // The title is the first thing the *person* said — the agent's own opening
    // is about the home rather than about what was asked.
    const hall = listed.find((entry) => entry.sessionId === first.sessionId);
    expect(hall?.title).toBe('lights in the hall');
    expect(hall?.messageCount).toBeGreaterThan(1);

    // Readable and continuable are two different things, and an app has to
    // say which one it is offering.
    expect(hall?.live).toBe(true);
    expect(listed.find((entry) => entry.sessionId === second.sessionId)?.live).toBe(false);

    // **Real dates, because the counting is done in SQLite now.** `min()` and
    // `max()` lose the column's `timestamp_ms` mapping on the way out, so the
    // aggregate hands back the stored integer — and a row whose date reads as
    // 1970, or as `Invalid Date`, is the whole of what this list is for.
    for (const entry of listed) {
      expect(Number.isNaN(Date.parse(entry.startedAt))).toBe(false);
      expect(Date.parse(entry.startedAt)).toBeGreaterThan(Date.parse('2020-01-01T00:00:00Z'));
      expect(Date.parse(entry.updatedAt)).toBeGreaterThanOrEqual(Date.parse(entry.startedAt));
    }
  });

  it('picks a conversation back up after the hub has forgotten it', async () => {
    /**
     * **The two halves of a chat have very different lifetimes, and the
     * shorter one was deciding.** The model's history is in memory — two hours
     * or one restart — while the transcript keeps for a fortnight, so almost
     * everything in the conversations list answered `410` and the app drew a
     * closed composer over it. On a real hub that included a conversation that
     * had worked perfectly and written a rule: "ask it to try again" was not a
     * thing anybody could do.
     */
    const { chat } = await chatFor([
      { kind: 'said', text: 'Done.' },
      { kind: 'said', text: 'Changed it.' },
    ]);

    const started = await chat.start({ memberId: memberId, message: 'lights in the hall' });
    await chat.idle();

    // The hub forgets how to continue it — a restart, or the idle sweep.
    await chat.close(started.sessionId);
    expect(chat.isLive(started.sessionId)).toBe(false);

    // Saying something else works anyway, and lands in the *same* transcript.
    const again = await chat.reply(started.sessionId, memberId, 'try that again');
    expect(again).not.toBeNull();
    await chat.idle();

    const transcript = await chat.transcript(started.sessionId);
    expect(transcript.map((message) => message.role)).toEqual([
      'user',
      'agent',
      'user',
      'agent',
    ]);
    expect(transcript.at(-1)?.text).toBe('Changed it.');

    // **The recap goes to the model, never into the transcript** — it is a
    // read-back of rows that are already there, and writing it down would put
    // the conversation inside itself as a message.
    expect(transcript[2]?.text).toBe('try that again');
  });

  it('refuses only a conversation with nothing left to read', async () => {
    // The honest `410`: rows aged out, or a session id that never existed.
    const { chat } = await chatFor([{ kind: 'said', text: 'hello' }]);
    expect(await chat.reply(randomUUID(), memberId, 'anyone there?')).toBeNull();
  });

  it('will not let one member continue another member’s conversation', async () => {
    const { chat } = await chatFor([{ kind: 'said', text: 'hello' }]);
    const started = await chat.start({ memberId: memberId, message: 'go' });
    expect(await chat.reply(started.sessionId, randomUUID(), 'and me')).toBeNull();
  });

  it('will not let one member revive another member’s conversation either', async () => {
    // A live session carries its member and is compared against it; a revived
    // one is built from the *caller's* id, so without reading the owner back
    // out of the rows, reopening anybody's chat by its id would take it over.
    const { chat } = await chatFor([{ kind: 'said', text: 'hello' }]);
    const started = await chat.start({ memberId: memberId, message: 'go' });
    await chat.idle();
    await chat.close(started.sessionId);

    expect(await chat.reply(started.sessionId, randomUUID(), 'and me')).toBeNull();
    // And the person whose conversation it is still gets it back.
    expect(await chat.reply(started.sessionId, memberId, 'carry on')).not.toBeNull();
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
