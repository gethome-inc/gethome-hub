import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildServer } from '../src/api/server.js';
import { HubEventBus } from '../src/core/bus.js';
import { ActivityService } from '../src/core/activity.js';
import { PairingService } from '../src/core/pairing.js';
import { SettingsService } from '../src/core/settings.js';
import { DeviceRegistry } from '../src/core/registry.js';
import { PermitJoinService } from '../src/core/permit-join.js';
import { AiRunLog } from '../src/core/ai-runs.js';
import { MappingLibrary } from '../src/ai/library.js';
import { aiRuns as aiRunsTable, members as membersTable } from '../src/db/schema.js';
import type { AutomationEngine, EngineRegistry } from '../src/automations/engine.js';
import type { AutomationHomeView } from '../src/automations/targets.js';
import { createAnthropicTransport } from '../src/ai/chat/anthropic-transport.js';
import { createOpenAiTransport } from '../src/ai/chat/openai-transport.js';
import {
  StopRequested,
  TurnAbort,
  tokensIn,
  type ChatTransportOptions,
} from '../src/ai/chat/agent-loop.js';
import {
  ASSISTANT_TIMEOUT_MS,
  createAssistantConversation,
  type AssistantTurn,
} from '../src/ai/assistant-agent.js';
import { createAutomationConversation } from '../src/ai/automation-agent.js';
import type { AssistantToolContext } from '../src/ai/assistant-tools.js';
import type {
  AutomationConversation,
  AutomationTurn,
  AutomationTurnContext,
} from '../src/ai/automation-conversation.js';
import type { AgentConversation, ChatTurnContext } from '../src/ai/chat/chat-runtime.js';
import { AGENT_MODELS, estimateCostUsd } from '../src/ai/models.js';
import { AiUnavailableError } from '../src/ai/errors.js';
import type { HubCommand } from '../src/schema/index.js';
import {
  bootedHome,
  loadedAccess,
  loadedFavorites,
  openTestDb,
  resetDb,
  startedAutomations,
  startedHistory,
  testBroker,
  testPortraits,
  type TestDb,
} from './helpers/db.js';

/**
 * Stopping a round part-way: the person's stop, from the route down to the
 * vendor's stream and back up as a transcript.
 *
 * What is pinned is what a stop **keeps** as much as what it ends. The words
 * that reached the page are the answer; a device already switched stays
 * switched and the note says so; a job already handed over is still a card,
 * and a rule the model was told is saved is saved. What is never started is
 * never started, every tool call still gets its result so the conversation can
 * go on, and what the round had spent is in the ledger. Only the round
 * somebody is watching stops — a message sent behind it still runs.
 *
 * And the watchdog is per turn now, which a test here holds to: a turn that
 * timed out used to leave the conversation's one controller aborted for good.
 */

const log = pino({ level: 'silent' });

// ── Anthropic's stream, with the SDK's own abort ────────────────────────────

const { anthropicStream } = vi.hoisted(() => ({
  anthropicStream: vi.fn<(params: unknown, options: { signal?: AbortSignal }) => unknown>(),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = {
      create: async () => {
        throw new Error('A chat never uses the non-streaming call.');
      },
      stream: (params: unknown, options: { signal?: AbortSignal } = {}) =>
        anthropicStream(params, options),
    };
  },
}));

/** What the API counted when the reply began, as `message_start` carries it. */
const STARTED_USAGE = {
  input_tokens: 1_200,
  output_tokens: 1,
  cache_read_input_tokens: 3_000,
  cache_creation_input_tokens: 0,
};

/**
 * A reply that streams some reasoning and some words, then waits for an abort
 * it never finishes before — the SDK's own behaviour reproduced: `finalMessage`
 * rejects, and the snapshot `message_start` opened is still readable. What the
 * snapshot holds is the half-built reply, a signature-less thinking block and
 * all, which is exactly what must never reach the history.
 */
function heldAnthropicReply(thinking: string, words: string, signal: AbortSignal | undefined) {
  const handlers: Record<string, ((delta: string) => void)[]> = {};
  const snapshot = {
    content: [
      { type: 'thinking', thinking, signature: '' },
      { type: 'text', text: words },
      { type: 'tool_use', id: 'toolu_half', name: 'control_device', input: {} },
    ],
    stop_reason: null,
    usage: STARTED_USAGE,
  };
  return {
    on(event: string, handler: (delta: string) => void) {
      (handlers[event] ??= []).push(handler);
      return this;
    },
    get currentMessage() {
      return snapshot;
    },
    finalMessage: () =>
      new Promise((_, reject) => {
        for (const handler of handlers['thinking'] ?? []) handler(thinking);
        for (const handler of handlers['text'] ?? []) handler(words);
        const abort = () => reject(Object.assign(new Error('Request was aborted.'), { name: 'APIUserAbortError' }));
        if (signal?.aborted === true) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      }),
  };
}

/** A reply that finishes, recording what the request carried at that moment. */
function finishedAnthropicReply(text: string, seen: unknown[][]) {
  return (params: unknown) => {
    // A snapshot: the transport keeps pushing to the same array.
    seen.push(JSON.parse(JSON.stringify((params as { messages: unknown[] }).messages)) as unknown[]);
    const message = {
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 10 },
    };
    return {
      on(event: string, handler: (delta: string) => void) {
        if (event === 'text') handler(text);
        return this;
      },
      currentMessage: message,
      finalMessage: async () => message,
    };
  };
}

const options = (modelId: string): ChatTransportOptions => ({
  secret: 'test',
  modelId,
  systemPrompt: 'system',
  tools: [],
  label: 'the assistant',
  timeoutMs: 60_000,
  effort: 'medium',
  log,
});

// ── OpenAI's stream, over a stubbed fetch ───────────────────────────────────

/** One SSE frame, exactly as the Responses stream writes it. */
const frame = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * A request that answers in full — unless its signal was aborted before it was
 * sent, which a real fetch refuses outright. A stub that answered anyway would
 * be laxer than the thing it stands in for, and would pass a conversation whose
 * every request goes out already aborted.
 */
const answering = (output: unknown[]) => (_url: unknown, init?: RequestInit) => {
  if (init?.signal?.aborted === true) return Promise.reject(init.signal.reason as Error);
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
  return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
};

/**
 * A request that streams some words and then holds until it is aborted — the
 * way a real fetch errors a body whose request was aborted, and refuses one
 * whose signal was aborted before it was sent.
 */
const holding = (words: string) => (_url: unknown, init?: RequestInit) => {
  const signal = init?.signal ?? undefined;
  if (signal?.aborted === true) return Promise.reject(signal.reason as Error);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (words.length > 0) {
        controller.enqueue(new TextEncoder().encode(frame('response.output_text.delta', { delta: words })));
      }
      const fail = () => controller.error(new DOMException('This operation was aborted', 'AbortError'));
      if (signal?.aborted === true) fail();
      else signal?.addEventListener('abort', fail, { once: true });
    },
  });
  return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
};

const message = (text: string) => ({ type: 'message', content: [{ type: 'output_text', text }] });
const call = (id: string, name: string, input: unknown) => ({
  type: 'function_call',
  call_id: id,
  name,
  arguments: JSON.stringify(input),
});

/** Stub `fetch` with one responder per request, in order. */
function script(...responders: ((url: unknown, init?: RequestInit) => Promise<Response>)[]) {
  const fetchMock = vi.fn<(url: unknown, init?: RequestInit) => Promise<Response>>();
  for (const responder of responders) fetchMock.mockImplementationOnce(responder);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The body request `index` carried, parsed. */
function bodyOf(fetchMock: ReturnType<typeof script>, index: number) {
  const init = fetchMock.mock.calls[index]?.[1];
  return JSON.parse(String(init?.body)) as { input: Record<string, unknown>[] };
}

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
      endpoints: [{ endpointId: 1, deviceKind: 'light' as const, capabilities: ['onOff' as const] }],
    })),
  };
}

function toolsFor(home: AutomationHomeView): AssistantToolContext & {
  sent: { deviceId: string; command: HubCommand }[];
} {
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
    delegate: async () => ({ sessionId: 'delegated-session', text: 'Handed over.' }),
    delegates: [],
  };
}

const assistantOn = (tools: AssistantToolContext) =>
  createAssistantConversation({
    auth: { secret: 'sk-proj-test' },
    provider: 'openai',
    modelId: AGENT_MODELS.openai.default,
    systemPrompt: 'system',
    taskPrompt: 'this home',
    tools,
    log,
  });

const automationOn = () =>
  createAutomationConversation({
    auth: { secret: 'sk-proj-test' },
    provider: 'openai',
    modelId: AGENT_MODELS.openai.default,
    systemPrompt: 'system',
    taskPrompt: 'this home',
    log,
    tools: {
      home: () => ({ devices: [], rooms: [], zones: [], automations: [] }),
      timezone: () => 'UTC',
      stateOf: () => undefined,
    },
  });

const goodDocument = {
  version: 1,
  name: 'Evening lights',
  mode: 'single',
  triggers: [{ kind: 'manual' }],
  actions: [{ kind: 'logActivity', message: 'Evening' }],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ── The transports ───────────────────────────────────────────────────────────

describe('a round stopped part-way, on each vendor', () => {
  beforeEach(() => {
    anthropicStream.mockReset();
  });

  it('keeps what reached the page on Anthropic, and only the words of it', async () => {
    const transport = createAnthropicTransport(options('claude-opus-5-5'));
    const stop = new AbortController();
    const abort = new TurnAbort(stop.signal, 60_000);
    anthropicStream.mockImplementationOnce((_params, { signal }) =>
      heldAnthropicReply('Looking at the kitchen', 'I will switch the', signal),
    );
    transport.pushUser('switch the kitchen off');

    const round = await transport.round({ onDelta: () => stop.abort() }, abort.signal);
    abort.dispose();

    expect(round).toEqual({ said: 'I will switch the', calls: [], stop: 'halted' });
    // Priced off the prompt the API counted and the words that streamed — not
    // nothing, which is what a stopped round used to leave in the ledger.
    expect(transport.costUsd()).toBeCloseTo(
      estimateCostUsd('claude-opus-5-5', {
        ...STARTED_USAGE,
        output_tokens: tokensIn('Looking at the kitchen'.length + 'I will switch the'.length),
      }),
      10,
    );

    // The next request carries the words as what was said, and none of the
    // half-built reply: no thinking without its signature, no call without
    // its input — either is a conversation the API refuses for good.
    const seen: unknown[][] = [];
    anthropicStream.mockImplementationOnce(finishedAnthropicReply('All right.', seen));
    transport.pushUser('never mind');
    await transport.round(undefined, new AbortController().signal);
    expect(seen[0]?.[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'I will switch the' }],
    });
    expect(JSON.stringify(seen[0])).not.toContain('toolu_half');
  });

  it('puts nothing on the history for a round stopped before a word', async () => {
    const transport = createAnthropicTransport(options('claude-opus-5-5'));
    const stop = new AbortController();
    stop.abort(new StopRequested());
    anthropicStream.mockImplementationOnce((_params, { signal }) =>
      heldAnthropicReply('', '', signal),
    );
    transport.pushUser('hello');

    const round = await transport.round(undefined, stop.signal);

    expect(round).toEqual({ said: '', calls: [], stop: 'halted' });
    const seen: unknown[][] = [];
    anthropicStream.mockImplementationOnce(finishedAnthropicReply('Hello.', seen));
    transport.pushUser('hello?');
    await transport.round(undefined, new AbortController().signal);
    expect(seen[0]?.map((entry) => (entry as { role: string }).role)).toEqual(['user', 'user']);
  });

  it('still treats the watchdog as a failure with its sentence', async () => {
    const transport = createAnthropicTransport(options('claude-opus-5-5'));
    const watchdog = new AbortController();
    anthropicStream.mockImplementationOnce((_params, { signal }) =>
      heldAnthropicReply('', 'Half', signal),
    );
    transport.pushUser('hello');

    const round = transport.round({ onDelta: () => watchdog.abort() }, watchdog.signal);

    await expect(round).rejects.toBeInstanceOf(AiUnavailableError);
    await expect(round).rejects.toThrow(/stopped answering after 60s/);
  });

  it('keeps what reached the page on OpenAI, as an assistant message of its own', async () => {
    const fetchMock = script(holding('The kitchen light is'), answering([message('Okay.')]));
    const transport = createOpenAiTransport(options(AGENT_MODELS.openai.default));
    const stop = new AbortController();
    const abort = new TurnAbort(stop.signal, 60_000);
    transport.pushUser('is the kitchen light on?');

    const round = await transport.round({ onDelta: () => stop.abort() }, abort.signal);
    abort.dispose();

    expect(round).toEqual({ said: 'The kitchen light is', calls: [], stop: 'halted' });
    // No usage ever arrives for it on this API, so it is estimated rather than
    // left out of the ledger.
    expect(transport.costUsd()).toBeGreaterThan(0);

    transport.pushUser('never mind');
    await transport.round(undefined, new AbortController().signal);
    expect(bodyOf(fetchMock, 1).input).toEqual([
      { role: 'user', content: 'is the kitchen light on?' },
      { role: 'assistant', content: 'The kitchen light is' },
      { role: 'user', content: 'never mind' },
    ]);
  });

  it('prices a photo in a stopped round as a photo, never as its base64', async () => {
    script(holding(''));
    const model = AGENT_MODELS.openai.default;
    const transport = createOpenAiTransport(options(model));
    const data = randomBytes(1024 * 1024).toString('base64');
    transport.pushUser('what is this?', [{ mediaType: 'image/jpeg', data }]);
    const stop = new AbortController();
    stop.abort(new StopRequested());

    await transport.round(undefined, stop.signal);

    // Priced as text, a megabyte of base64 would be a third of a million
    // tokens; as a photo it is under a thousand.
    const asText = estimateCostUsd(model, { input_tokens: tokensIn(data.length) });
    expect(transport.costUsd()).toBeGreaterThan(0);
    expect(transport.costUsd()).toBeLessThan(asText / 100);
  });
});

// ── The loops ────────────────────────────────────────────────────────────────

describe('the assistant’s loop, stopped', () => {
  it('ends with the words that reached the page, and carries on afterwards', async () => {
    const fetchMock = script(holding('Switching the kitchen'), answering([message('Okay.')]));
    const conversation = await assistantOn(toolsFor(homeOf(2)));
    const stop = new AbortController();

    const turn = await conversation.send('switch everything off', {
      signal: stop.signal,
      onDelta: () => stop.abort(),
    });

    expect(turn).toEqual({ kind: 'said', text: 'Switching the kitchen', halted: { acted: false } });
    const next = await conversation.send('never mind');
    expect(next).toEqual({ kind: 'said', text: 'Okay.' });
    expect(bodyOf(fetchMock, 1).input).toContainEqual({
      role: 'assistant',
      content: 'Switching the kitchen',
    });
  });

  it('finishes the command in flight, runs none after it, and answers every call', async () => {
    const tools = toolsFor(homeOf(3));
    const stop = new AbortController();
    // The person presses stop while the first command is on its way.
    tools.control = async (deviceId, _endpointId, command) => {
      tools.sent.push({ deviceId, command });
      stop.abort();
    };
    const fetchMock = script(
      answering(
        ['light-0', 'light-1', 'light-2'].map((deviceId, index) =>
          call(`call_${index}`, 'control_device', { deviceId, command: { type: 'power', on: false } }),
        ),
      ),
      answering([message('Only the first one went off.')]),
    );
    const conversation = await assistantOn(tools);

    const turn = await conversation.send('turn everything off', { signal: stop.signal });

    expect(turn).toEqual({ kind: 'said', text: '', halted: { acted: true } });
    expect(tools.sent.map((entry) => entry.deviceId)).toEqual(['light-0']);

    await conversation.send('what happened?');
    const outputs = bodyOf(fetchMock, 1).input.filter((item) => item.type === 'function_call_output');
    expect(outputs.map((item) => item.call_id)).toEqual(['call_0', 'call_1', 'call_2']);
    expect(outputs[0]?.output).toBe('Sent. Note that reaching a battery device can take until it next wakes.');
    expect(outputs[1]?.output).toContain('Not done: they stopped this answer before it ran.');
    expect(outputs[2]?.output).toContain('Not done');
  });

  it('keeps a job it had already handed over, and starts nothing after it', async () => {
    const tools = toolsFor(homeOf(1));
    const stop = new AbortController();
    tools.delegate = async () => {
      stop.abort();
      return { sessionId: 'delegated-session', text: 'Handed over.' };
    };
    script(
      answering([
        call('call_0', 'delegate', { agent: 'automations', brief: 'Lights off at 23:00.' }),
        call('call_1', 'control_device', { deviceId: 'light-0', command: { type: 'power', on: false } }),
      ]),
    );
    const conversation = await assistantOn(tools);

    const turn = await conversation.send('lights off at eleven, and now', { signal: stop.signal });

    expect(turn).toEqual({
      kind: 'handed',
      handoffs: [{ agent: 'automations', brief: 'Lights off at 23:00.', sessionId: 'delegated-session' }],
      text: '',
      halted: { acted: true },
    });
    expect(tools.sent).toEqual([]);
  });

  it('withdraws a question it had not yet put, rather than asking somebody who said stop', async () => {
    const tools = toolsFor(homeOf(1));
    const stop = new AbortController();
    tools.control = async (deviceId, _endpointId, command) => {
      tools.sent.push({ deviceId, command });
      stop.abort();
    };
    const fetchMock = script(
      answering([
        call('call_0', 'ask_user', { question: 'Which lamp?', options: ['Left', 'Right'] }),
        call('call_1', 'control_device', { deviceId: 'light-0', command: { type: 'power', on: true } }),
      ]),
      answering([message('Fine.')]),
    );
    const conversation = await assistantOn(tools);

    const turn = await conversation.send('a lamp on', { signal: stop.signal });

    expect(turn).toEqual({ kind: 'said', text: '', halted: { acted: true } });
    expect(conversation.awaitingAnswer()).toBe(false);
    await conversation.send('fine');
    const outputs = bodyOf(fetchMock, 1).input.filter((item) => item.type === 'function_call_output');
    expect(outputs.map((item) => item.call_id).sort()).toEqual(['call_0', 'call_1']);
  });

  /**
   * The bug the per-turn signal fixes. One controller for the conversation's
   * life aborts once and stays aborted, so a turn that hit the watchdog left
   * every later request refused the instant it was sent.
   */
  it('answers the next message after a turn that timed out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    script(holding(''), answering([message('Here now.')]));
    const conversation = await assistantOn(toolsFor(homeOf(1)));

    const first = conversation.send('hello');
    const failed = expect(first).rejects.toThrow(/stopped answering after 120s/);
    await vi.advanceTimersByTimeAsync(ASSISTANT_TIMEOUT_MS);
    await failed;

    await expect(conversation.send('hello again')).resolves.toEqual({ kind: 'said', text: 'Here now.' });
  });
});

describe('the automations agent’s loop, stopped', () => {
  it('saves a rule it was told is saved, with the words that reached the page above it', async () => {
    script(
      // A rule accepted with nothing said about it, which sends it back once
      // for its sentence …
      answering([call('call_0', 'submit_automation', { document: goodDocument, replaces: null })]),
      // … and the person stops that round mid-sentence.
      holding('Saved your evening'),
    );
    const conversation = await automationOn();
    const stop = new AbortController();

    const turn = await conversation.send('evening lights', {
      signal: stop.signal,
      onDelta: () => stop.abort(),
    });

    expect(turn).toMatchObject({ kind: 'submitted', text: 'Saved your evening', halted: { acted: true } });
    expect((turn as Extract<AutomationTurn, { kind: 'submitted' }>).rules).toHaveLength(1);
  });

  it('keeps a rule accepted before the stop and answers the calls after it as not done', async () => {
    const fetchMock = script(
      answering([
        call('call_0', 'submit_automation', { document: goodDocument, replaces: null }),
        call('call_1', 'submit_automation', {
          document: { ...goodDocument, name: 'Morning lights' },
          replaces: null,
        }),
      ]),
      answering([message('Noted.')]),
    );
    const conversation = await automationOn();
    const stop = new AbortController();
    const context: AutomationTurnContext = {
      signal: stop.signal,
      // Pressed the moment the first rule is in.
      onStep: (summary) => {
        if (summary === 'Wrote the rule') stop.abort();
      },
    };

    const turn = await conversation.send('evening and morning lights', context);

    expect(turn).toMatchObject({ kind: 'submitted', text: '', halted: { acted: true } });
    const rules = (turn as Extract<AutomationTurn, { kind: 'submitted' }>).rules;
    expect(rules.map((rule) => (rule.document as { name: string }).name)).toEqual(['Evening lights']);

    await conversation.send('thanks');
    const outputs = bodyOf(fetchMock, 1).input.filter((item) => item.type === 'function_call_output');
    expect(outputs.map((item) => item.call_id)).toEqual(['call_0', 'call_1']);
    expect(outputs[1]?.output).toContain('Not done');
  });
});

// ── The runtime ──────────────────────────────────────────────────────────────

/** Resolves when a signal aborts — never, for one that never will. */
const stopped = (signal: AbortSignal | undefined) =>
  new Promise<void>((resolve) => {
    if (signal === undefined) return;
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });

/** Wait for something a turn running off the request is about to do. */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

type Script<Turn> = (text: string, context: ChatTurnContext | undefined) => Promise<Turn>;

describe('a stop, in the runtime', () => {
  let handle: TestDb | null = null;
  let events: HubEventBus;
  let settings: SettingsService;
  let memberId: string;
  const engines: AutomationEngine[] = [];

  afterAll(async () => {
    await Promise.allSettled(engines.map((engine) => engine.stop()));
    await handle?.close();
  });

  beforeEach(async () => {
    handle ??= (await openTestDb())!;
    await resetDb(handle.db);
    events = new HubEventBus();
    settings = new SettingsService(handle.db, Buffer.alloc(32).toString('base64'));
    await settings.setAiKey('anthropic', 'sk-ant-api03-test');
    memberId = randomUUID();
    await handle.db.insert(membersTable).values({ id: memberId, name: 'Anna', role: 'owner' });
  });

  /**
   * Both agents over stand-ins that run a script — which can wait for the
   * person's stop the way a real loop does — recording what each round was
   * sent, priming included.
   */
  async function runtimes(scripts: {
    assistant?: Script<AssistantTurn>;
    automation?: Script<AutomationTurn>;
  }) {
    const sent: string[] = [];
    const stand = <Turn>(run: Script<Turn> | undefined, fallback: Turn) => {
      let spent = 0;
      const round = async (text: string, context?: ChatTurnContext): Promise<Turn> => {
        sent.push(text);
        spent += 0.01;
        context?.onStep?.('Reading your home', 'thinking');
        return run === undefined ? fallback : run(text, context);
      };
      return {
        provider: 'anthropic',
        modelId: 'claude-opus-5-5',
        effort: 'medium' as const,
        awaitingAnswer: () => false,
        costUsd: () => spent,
        send: round,
        answer: round,
      };
    };
    const registry = { listDevices: () => [], execute: async () => undefined } as unknown as EngineRegistry;
    const started = await startedAutomations(handle!.db, events, registry, new ActivityService(handle!.db, events), {
      settings,
      createAssistantConversation: () =>
        stand<AssistantTurn>(scripts.assistant, { kind: 'said', text: 'Done.' }) as AgentConversation<AssistantTurn>,
      createConversation: () =>
        stand<AutomationTurn>(scripts.automation, { kind: 'said', text: 'Done.' }) as AutomationConversation,
    });
    engines.push(started.engine);
    return { ...started, sent };
  }

  /** A script that waits for the stop on a message saying "slow", then winds
   *  down with `ending`; anything else is answered at once. */
  const slowly =
    (ending: AssistantTurn): Script<AssistantTurn> =>
    async (text, context) => {
      if (!text.includes('slow')) return { kind: 'said', text: 'Done.' };
      await stopped(context?.signal);
      return ending;
    };

  it('keeps what was said, then says it stopped, and banks the round', async () => {
    const { assistant, sent } = await runtimes({
      assistant: slowly({ kind: 'said', text: 'The kitchen is', halted: { acted: false } }),
    });
    const frames: string[] = [];
    events.on('assistantChat', (event) => {
      if (event.phase === 'turn') frames.push(event.text);
    });
    const started = await assistant.start({ memberId, message: 'a slow question' });
    await until(() => sent.length === 1, 'the round to begin');

    expect(assistant.stop(started.sessionId, memberId)).toBe('stopped');
    await assistant.idle();

    const rows = await assistant.transcript(started.sessionId);
    expect(rows.map((row) => [row.role, row.text])).toEqual([
      ['user', 'a slow question'],
      ['agent', 'The kitchen is'],
      ['note', 'Stopped.'],
    ]);
    // The working went on the first row the round wrote; the note is the note.
    expect((rows[1]?.data as { steps?: unknown[] }).steps).toHaveLength(1);
    expect(rows[2]?.data).toEqual({ stopped: true });
    // The round ended like any other — the frame that takes a spinner down.
    expect(frames).toEqual(['said']);
    const runs = await handle!.db.select().from(aiRunsTable).where(eq(aiRunsTable.sessionId, started.sessionId));
    expect(runs.reduce((sum, run) => sum + (run.costUsd ?? 0), 0)).toBeCloseTo(0.01, 10);
  });

  it('says what was already done stays done, on a note that carries the working', async () => {
    const { assistant, sent } = await runtimes({
      assistant: slowly({ kind: 'said', text: '', halted: { acted: true } }),
    });
    const started = await assistant.start({ memberId, message: 'a slow request' });
    await until(() => sent.length === 1, 'the round to begin');

    assistant.stop(started.sessionId, memberId);
    await assistant.idle();

    const rows = await assistant.transcript(started.sessionId);
    expect(rows.map((row) => [row.role, row.text])).toEqual([
      ['user', 'a slow request'],
      ['note', 'Stopped. What was already done stays done.'],
    ]);
    const data = rows[1]?.data as { stopped?: boolean; steps?: unknown[]; tookMs?: number };
    expect(data.stopped).toBe(true);
    expect(data.steps).toHaveLength(1);
    expect(typeof data.tookMs).toBe('number');
  });

  it('stops only the round being watched: a message sent behind it still runs, told about the stop', async () => {
    const { assistant, sent } = await runtimes({
      assistant: slowly({ kind: 'said', text: 'The kitchen is', halted: { acted: false } }),
    });
    const started = await assistant.start({ memberId, message: 'a slow question' });
    await until(() => sent.length === 1, 'the round to begin');
    await assistant.reply(started.sessionId, memberId, 'and the hall?');

    assistant.stop(started.sessionId, memberId);
    await assistant.idle();

    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('They stopped your last answer part-way through');
    expect(sent[1]).toMatch(/and the hall\?$/);
    const rows = await assistant.transcript(started.sessionId);
    expect(rows.map((row) => [row.role, row.text])).toEqual([
      ['user', 'a slow question'],
      ['user', 'and the hall?'],
      ['agent', 'The kitchen is'],
      ['note', 'Stopped.'],
      ['agent', 'Done.'],
    ]);
  });

  it('says there is nothing to stop, and stops nobody else’s round', async () => {
    const { assistant, sent } = await runtimes({
      assistant: slowly({ kind: 'said', text: 'Half', halted: { acted: false } }),
    });
    expect(assistant.stop(randomUUID(), memberId)).toBe('idle');

    const quick = await assistant.start({ memberId, message: 'a quick one' });
    await assistant.idle();
    expect(assistant.stop(quick.sessionId, memberId)).toBe('idle');

    const slow = await assistant.start({ memberId, message: 'a slow one' });
    await until(() => sent.length === 2, 'the slow round to begin');
    expect(assistant.stop(slow.sessionId, randomUUID())).toBe('not_yours');
    expect(assistant.stop(slow.sessionId, memberId)).toBe('stopped');
    await assistant.idle();

    // The finished conversation was left exactly as it was.
    const rows = await assistant.transcript(quick.sessionId);
    expect(rows.map((row) => row.role)).toEqual(['user', 'agent']);
  });

  it('calls a stop a stop even when the round threw on its way out', async () => {
    const { assistant, sent } = await runtimes({
      assistant: async (_text, context) => {
        await stopped(context?.signal);
        throw new Error('socket hang up');
      },
    });
    const started = await assistant.start({ memberId, message: 'hello' });
    await until(() => sent.length === 1, 'the round to begin');

    assistant.stop(started.sessionId, memberId);
    await assistant.idle();

    const rows = await assistant.transcript(started.sessionId);
    expect(rows.map((row) => [row.role, row.text])).toEqual([
      ['user', 'hello'],
      ['note', 'Stopped.'],
    ]);
  });

  it('saves the rules a stopped automations round had delivered', async () => {
    const { chat, engine, sent } = await runtimes({
      automation: async (_text, context) => {
        await stopped(context?.signal);
        return {
          kind: 'submitted',
          rules: [{ document: goodDocument, replaces: null }],
          text: '',
          halted: { acted: true },
        };
      },
    });
    const started = await chat.start({ memberId, message: 'evening lights' });
    await until(() => sent.length === 1, 'the round to begin');

    expect(chat.stop(started.sessionId, memberId)).toBe('stopped');
    await chat.idle();

    const rows = await chat.transcript(started.sessionId);
    expect(rows.map((row) => [row.role, row.text.slice(0, 7)])).toEqual([
      ['user', 'evening'],
      ['preview', expect.any(String) as unknown as string],
      ['note', 'Stopped'],
    ]);
    expect(rows[2]?.text).toBe('Stopped. What was already done stays done.');
    const id = (rows[1]?.data as { automationId: string }).automationId;
    expect(engine.get(id)?.document.name).toBe('Evening lights');
  });
});

// ── The routes ───────────────────────────────────────────────────────────────

describe('POST …/chat/:id/stop', () => {
  let handle: TestDb;
  let app: FastifyInstance;
  let engine: AutomationEngine;
  /** Both agents, so a test can wait for the round a stop winds down. */
  let idle: () => Promise<void>;
  let token: string;
  let otherToken: string;
  const sent: string[] = [];

  const auth = (bearer: string) => ({ authorization: `Bearer ${bearer}` });
  const post = (url: string, bearer = token, payload?: object) =>
    app.inject({ method: 'POST', url, headers: auth(bearer), ...(payload !== undefined ? { payload } : {}) });

  /** Every stand-in waits for its stop on "slow", whichever agent it is. */
  function standIn<Turn>(halted: Turn) {
    const round = async (text: string, context?: ChatTurnContext): Promise<Turn> => {
      sent.push(text);
      if (!text.includes('slow')) return { kind: 'said', text: 'Done.' } as Turn;
      await stopped(context?.signal);
      return halted;
    };
    return {
      provider: 'anthropic',
      modelId: 'claude-opus-5-5',
      effort: 'medium' as const,
      awaitingAnswer: () => false,
      costUsd: () => 0,
      send: round,
      answer: round,
    };
  }

  beforeAll(async () => {
    handle = (await openTestDb())!;
    await resetDb(handle.db);
    const db = handle.db;
    const dir = mkdtempSync(path.join(tmpdir(), 'gethome-chat-stop-'));
    const events = new HubEventBus();
    const access = await loadedAccess(db, events);
    const pairing = new PairingService(db, dir, log, access);
    await pairing.boot();
    const activity = new ActivityService(db, events);
    const registry = new DeviceRegistry(db, events, activity, log);
    const settings = new SettingsService(db, Buffer.alloc(32).toString('base64'));
    await settings.setAiKey('anthropic', 'sk-ant-api03-test');
    const started = await startedAutomations(db, events, registry, activity, {
      settings,
      access,
      createConversation: () =>
        standIn<AutomationTurn>({ kind: 'said', text: 'Half', halted: { acted: false } }) as AutomationConversation,
      createAssistantConversation: () =>
        standIn<AssistantTurn>({ kind: 'said', text: 'Half', halted: { acted: false } }) as AgentConversation<AssistantTurn>,
    });
    engine = started.engine;
    idle = async () => {
      await started.assistant.idle();
      await started.chat.idle();
    };

    app = await buildServer({
      db,
      log,
      events,
      registry,
      favorites: await loadedFavorites(db, events),
      access,
      pairing,
      activity,
      automations: engine,
      automationStore: started.store,
      automationChat: started.chat,
      assistantChat: started.assistant,
      history: await startedHistory(db, events),
      portraits: testPortraits(db, events),
      settings,
      home: await bootedHome(db, 'Stop Hub'),
      hubId: 'hub-chat-stop-test',
      version: '0.1.0-test',
      dataDir: dir,
      radioBudget: 'one',
      z2mDataDir: path.join(dir, 'zigbee2mqtt'),
      zigbeeEnvFile: path.join(dir, 'zigbee.env'),
      mqtt: testBroker(),
      permitJoin: new PermitJoinService(undefined, log, () => {}),
      aiRuns: new AiRunLog(db, events),
      mappings: new MappingLibrary({ db, settings, registry, log }),
    });

    const code = readFileSync(path.join(dir, 'pairing-code'), 'utf8').trim();
    const claimed = await app.inject({
      method: 'POST',
      url: '/api/v1/pair',
      payload: { code, memberName: 'Georgy', deviceName: 'iPhone' },
    });
    token = (claimed.json() as { token: string }).token;

    // Somebody else in the home, as an ordinary member.
    const invite = await post('/api/v1/invites', token, {});
    const joined = await app.inject({
      method: 'POST',
      url: '/api/v1/pair',
      payload: { code: (invite.json() as { code: string }).code, memberName: 'Kolya' },
    });
    otherToken = (joined.json() as { token: string }).token;
  });

  afterAll(async () => {
    await engine?.stop();
    await app?.close();
    await handle?.close();
  });

  for (const surface of ['assistant', 'automations'] as const) {
    it(`stops a running ${surface} round, and answers at once`, async () => {
      const before = sent.length;
      const started = await post(`/api/v1/${surface}/chat`, token, { message: 'a slow question' });
      expect(started.statusCode).toBe(201);
      const { sessionId } = started.json() as { sessionId: string };
      await until(() => sent.length === before + 1, 'the round to begin');

      // Somebody else in the home may read it, and may not stop it.
      const theirs = await post(`/api/v1/${surface}/chat/${sessionId}/stop`, otherToken);
      expect(theirs.statusCode).toBe(409);
      expect(theirs.json()).toMatchObject({ error: 'not_your_conversation' });

      const stop = await post(`/api/v1/${surface}/chat/${sessionId}/stop`);
      expect(stop.statusCode).toBe(200);
      expect(stop.json()).toEqual({ stopped: true });

      // The answer is the acknowledgement; the round winds down after it.
      await idle();
      const read = await app.inject({
        method: 'GET',
        url: `/api/v1/${surface}/chat/${sessionId}`,
        headers: auth(token),
      });
      const rows = (read.json() as { messages: { role: string; text: string; data?: unknown }[] }).messages;
      expect(rows.map((row) => [row.role, row.text])).toEqual([
        ['user', 'a slow question'],
        ['agent', 'Half'],
        ['note', 'Stopped.'],
      ]);
      expect(rows[2]?.data).toEqual({ stopped: true });

      // Nothing is running now, which is not a refusal.
      const again = await post(`/api/v1/${surface}/chat/${sessionId}/stop`);
      expect(again.statusCode).toBe(200);
      expect(again.json()).toEqual({ stopped: false });
    });
  }

  it('says there is nothing to stop in a conversation the hub holds no memory of', async () => {
    const response = await post(`/api/v1/assistant/chat/${randomUUID()}/stop`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ stopped: false });
  });

  it('says on GET /hub that a round can be stopped', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/hub' });
    expect((response.json() as { chat?: { stop?: unknown } }).chat?.stop).toBe(true);
  });
});
