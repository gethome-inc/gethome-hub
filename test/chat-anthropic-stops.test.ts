import { beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { refusalSentence, type ChatTransportOptions } from '../src/ai/chat/agent-loop.js';

/**
 * A round that did not end on the model's own terms, on Anthropic: what it
 * leaves on the history, and what it hands a pump to run.
 *
 * Two of them, and the vendor's rule for each is about the history rather
 * than the reply. A **refusal** is discarded whole — before a word it is an
 * empty `content`, and an assistant message with nothing in it is refused
 * anywhere but last, so keeping it answered every later message in the
 * conversation with a 400. A reply **cut off** at `max_tokens` (or by the
 * context window) is an answer, but a tool call in it may be cut off half way
 * through its input and still parse, so none is run and only the words stay.
 *
 * The fixture is what the next request carried, cloned at the moment of the
 * call, because the transport keeps pushing to the same array.
 */

const { replies, sent } = vi.hoisted(() => ({
  replies: [] as unknown[],
  sent: [] as ({ messages: { role: string; content: unknown }[] } & Record<string, unknown>)[],
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = {
      create: async () => {
        throw new Error('A chat never uses the non-streaming call.');
      },
      stream: (params: { messages: { role: string; content: unknown }[] }) => {
        sent.push(structuredClone(params));
        const message = replies.shift();
        if (message === undefined) throw new Error('No reply queued for this request.');
        return { on: () => undefined, finalMessage: async () => message };
      },
    };
    // The loops talk to `client.beta.messages` (server-side fallbacks), which
    // is the same endpoint; the mock answers there with the same functions.
    beta = { messages: this.messages };
  },
}));

const { createAnthropicTransport } = await import('../src/ai/chat/anthropic-transport.js');
const { estimateCostUsd } = await import('../src/ai/models.js');

const log = pino({ level: 'silent' });
/** A round's signal that nothing ever aborts. */
const unstopped = new AbortController().signal;

const options: ChatTransportOptions = {
  secret: 'test',
  modelId: 'claude-opus-5-5',
  systemPrompt: 'system',
  tools: [],
  label: 'the assistant',
  timeoutMs: 60_000,
  effort: 'medium',
  log,
};

const usage = { input_tokens: 400, output_tokens: 20 };

/** A reply the model finished, in words. */
const answer = (text: string) => ({
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn',
  stop_details: null,
  usage,
});

/** The `messages` the last request carried. */
const lastSent = () => sent.at(-1)!.messages;

/** Every tool call id anywhere in what was sent. */
const toolIdsIn = (messages: { content: unknown }[]) =>
  messages.flatMap((message) =>
    Array.isArray(message.content)
      ? (message.content as { type: string; id?: string }[])
          .filter((block) => block.type === 'tool_use')
          .map((block) => block.id)
      : [],
  );

beforeEach(() => {
  replies.length = 0;
  sent.length = 0;
});

describe('a refusal on Anthropic', () => {
  it('leaves no empty turn behind, so the next message is one the API takes', async () => {
    const transport = createAnthropicTransport(options);
    transport.pushUser('how would somebody get into my network?');
    replies.push({
      content: [],
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'cyber', explanation: 'Declined.' },
      usage: { input_tokens: 400, output_tokens: 0 },
    });

    const round = await transport.round(undefined, unstopped);
    expect(round).toEqual({ said: '', calls: [], stop: 'refusal', refusal: refusalSentence('cyber') });

    transport.pushUser('which of my devices are on Zigbee?');
    replies.push(answer('The hall light and the door sensor.'));
    await transport.round(undefined, unstopped);

    // Two user turns, which the API reads as one — and no assistant message
    // with nothing in it, which it would refuse.
    expect(lastSent().map((message) => message.role)).toEqual(['user', 'user']);
    for (const message of lastSent()) {
      const content = message.content as string | unknown[];
      expect(content.length).toBeGreaterThan(0);
    }
  });

  it('keeps none of what it had begun when it declined part way through', async () => {
    const transport = createAnthropicTransport(options);
    transport.pushUser('switch the hall light off');
    replies.push({
      // Reasoning cut off before its signature, a sentence, and a call cut off
      // before its input — what a decline mid-stream leaves in `content`.
      content: [
        { type: 'thinking', thinking: 'Weighing it', signature: '' },
        { type: 'text', text: 'Sure, the first' },
        { type: 'tool_use', id: 'toolu_cut', name: 'control_device', input: {} },
      ],
      stop_reason: 'refusal',
      stop_details: null,
      usage,
    });

    const round = await transport.round(undefined, unstopped);
    // Nothing for a pump to run, and an absent category is the generic
    // sentence rather than a gap.
    expect(round).toEqual({ said: '', calls: [], stop: 'refusal', refusal: refusalSentence(null) });

    transport.pushUser('the kitchen one, then');
    replies.push(answer('Done.'));
    await transport.round(undefined, unstopped);
    expect(lastSent().map((message) => message.role)).toEqual(['user', 'user']);
    expect(toolIdsIn(lastSent())).toEqual([]);
  });
});

describe('a reply cut off on Anthropic', () => {
  it('runs none of its calls, and keeps only its words on the history', async () => {
    const transport = createAnthropicTransport(options);
    transport.pushUser('switch the hall light off');
    replies.push({
      content: [
        { type: 'thinking', thinking: 'The hall light.', signature: 'sig' },
        { type: 'text', text: 'I’ll switch the hall light off.' },
        // Cut off part way through its input, which still parses.
        { type: 'tool_use', id: 'toolu_cut', name: 'control_device', input: { deviceId: 'hall' } },
      ],
      stop_reason: 'max_tokens',
      stop_details: null,
      usage,
    });

    const round = await transport.round(undefined, unstopped);
    expect(round).toEqual({ said: 'I’ll switch the hall light off.', calls: [], stop: 'end' });

    transport.pushUser('did that work?');
    replies.push(answer('Not yet — shall I try again?'));
    await transport.round(undefined, unstopped);
    expect(lastSent()[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'I’ll switch the hall light off.' }],
    });
    expect(toolIdsIn(lastSent())).toEqual([]);
  });

  it('treats the context window running out as the same cut', async () => {
    const transport = createAnthropicTransport(options);
    transport.pushUser('switch everything off');
    replies.push({
      content: [{ type: 'tool_use', id: 'toolu_cut', name: 'control_device', input: {} }],
      stop_reason: 'model_context_window_exceeded',
      stop_details: null,
      usage,
    });

    const round = await transport.round(undefined, unstopped);
    expect(round).toEqual({ said: '', calls: [], stop: 'end' });

    // Nothing was said, so nothing is kept: the next message joins the last.
    transport.pushUser('hello?');
    replies.push(answer('Here.'));
    await transport.round(undefined, unstopped);
    expect(lastSent().map((message) => message.role)).toEqual(['user', 'user']);
  });
});

describe('a round that finishes on Anthropic', () => {
  it('still hands back its calls and keeps the reply verbatim, reasoning included', async () => {
    const transport = createAnthropicTransport(options);
    transport.pushUser('switch the hall light off');
    const content = [
      { type: 'thinking', thinking: 'The hall light.', signature: 'sig' },
      { type: 'tool_use', id: 'toolu_1', name: 'control_device', input: { deviceId: 'hall' } },
    ];
    replies.push({ content, stop_reason: 'tool_use', stop_details: null, usage });

    const round = await transport.round(undefined, unstopped);
    expect(round).toEqual({
      said: '',
      calls: [{ id: 'toolu_1', name: 'control_device', input: { deviceId: 'hall' } }],
      stop: 'tools',
    });

    transport.pushToolResults([{ id: 'toolu_1', text: 'Done.' }]);
    replies.push(answer('It is off.'));
    await transport.round(undefined, unstopped);
    expect(lastSent()[1]).toEqual({ role: 'assistant', content });
  });
});

/**
 * A round a Claude declined and another Claude answered, in the same request
 * (`fallbacks: 'default'`). What the transport owes it is the four things in
 * `anthropic-fallback.ts` — and one more of its own: saying who answered, since
 * the chat's header names the model somebody chose.
 */
describe('a round another Claude answered', () => {
  const iteration = (type: 'message' | 'fallback_message', model: string, input: number, output: number) => ({
    type,
    model,
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_creation: null,
  });

  it('asks for it on every request, and leaves Haiku, which has none, alone', async () => {
    const opus = createAnthropicTransport(options);
    opus.pushUser('is the front door locked?');
    replies.push(answer('It is.'));
    await opus.round(undefined, unstopped);
    expect(sent.at(-1)).toMatchObject({ betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });

    const haiku = createAnthropicTransport({ ...options, modelId: 'claude-haiku-5-5' });
    haiku.pushUser('is the front door locked?');
    replies.push(answer('It is.'));
    await haiku.round(undefined, unstopped);
    expect(sent.at(-1)).not.toHaveProperty('fallbacks');
    expect(sent.at(-1)).not.toHaveProperty('betas');
  });

  it('runs only the answering model’s call, joins the reply, and says who answered', async () => {
    const transport = createAnthropicTransport(options);
    transport.pushUser('lock the front door');
    const content = [
      { type: 'thinking', thinking: 'Weighing it.', signature: 'sig-a' },
      { type: 'text', text: 'The front door is' },
      { type: 'tool_use', id: 'toolu_declined', name: 'control_device', input: { deviceId: 'door' } },
      {
        type: 'fallback',
        from: { model: 'claude-opus-5-5' },
        to: { model: 'claude-opus-4-8' },
        trigger: { type: 'refusal', category: 'cyber' },
      },
      { type: 'thinking', thinking: 'Locking it.', signature: 'sig-b' },
      { type: 'text', text: ' unlocked, so I’ll lock it.' },
      { type: 'tool_use', id: 'toolu_answering', name: 'control_device', input: { deviceId: 'door', locked: true } },
    ];
    replies.push({
      model: 'claude-opus-4-8',
      content,
      stop_reason: 'tool_use',
      stop_details: null,
      usage: {
        input_tokens: 600,
        output_tokens: 50,
        iterations: [
          iteration('message', 'claude-opus-5-5', 500, 20),
          iteration('fallback_message', 'claude-opus-4-8', 600, 50),
        ],
      },
    });

    const handOver = vi.fn();
    const round = await transport.round({ onHandOver: handOver }, unstopped);
    expect(round).toEqual({
      said: 'The front door is unlocked, so I’ll lock it.',
      calls: [{ id: 'toolu_answering', name: 'control_device', input: { deviceId: 'door', locked: true } }],
      stop: 'tools',
    });
    expect(handOver).toHaveBeenCalledExactlyOnceWith('Opus 5.5', 'Opus 4.8', false);
    // Each attempt at its own model's rates — the declined one billed for
    // what it wrote, the answering one at Opus 4.8's price.
    expect(transport.costUsd()).toBeCloseTo(
      estimateCostUsd('claude-opus-5-5', { input_tokens: 500, output_tokens: 20 }) +
        estimateCostUsd('claude-opus-4-8', { input_tokens: 600, output_tokens: 50 }),
      12,
    );

    // The turn goes back without what the declined model began, so the next
    // request answers exactly the one call that was run.
    transport.pushToolResults([{ id: 'toolu_answering', text: 'Locked.' }]);
    replies.push(answer('Locked.'));
    await transport.round(undefined, unstopped);
    expect(lastSent()[1]).toEqual({
      role: 'assistant',
      content: [content[1], content[3], content[4], content[5], content[6]],
    });
    expect(toolIdsIn(lastSent())).toEqual(['toolu_answering']);
  });

  it('says so when the API keeps routing a conversation to the model that took over', async () => {
    const transport = createAnthropicTransport(options);
    transport.pushUser('and the back door?');
    // No hand-over in the reply itself: the API answers with the fallback
    // model directly for a while after an earlier message was declined.
    replies.push({
      model: 'claude-opus-4-8',
      content: [{ type: 'text', text: 'Locked too.' }],
      stop_reason: 'end_turn',
      stop_details: null,
      usage: { input_tokens: 700, output_tokens: 10, iterations: [iteration('fallback_message', 'claude-opus-4-8', 700, 10)] },
    });

    const handOver = vi.fn();
    const round = await transport.round({ onHandOver: handOver }, unstopped);
    expect(round).toEqual({ said: 'Locked too.', calls: [], stop: 'end' });
    expect(handOver).toHaveBeenCalledExactlyOnceWith('Opus 5.5', 'Opus 4.8', true);
    expect(transport.costUsd()).toBeCloseTo(
      estimateCostUsd('claude-opus-4-8', { input_tokens: 700, output_tokens: 10 }),
      12,
    );
  });

  it('says nothing about who answered when the whole chain declined', async () => {
    const transport = createAnthropicTransport(options);
    transport.pushUser('how would somebody get into my network?');
    replies.push({
      model: 'claude-opus-4-8',
      content: [],
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'cyber', explanation: null },
      usage: {
        input_tokens: 400,
        output_tokens: 0,
        iterations: [
          iteration('message', 'claude-opus-5-5', 400, 0),
          iteration('fallback_message', 'claude-opus-4-8', 400, 0),
        ],
      },
    });

    const handOver = vi.fn();
    const round = await transport.round({ onHandOver: handOver }, unstopped);
    expect(round.stop).toBe('refusal');
    expect(handOver).not.toHaveBeenCalled();
  });

  it('prices an ordinary reply exactly as it always was', async () => {
    const transport = createAnthropicTransport(options);
    transport.pushUser('hello');
    replies.push(answer('Hello.'));
    await transport.round(undefined, unstopped);
    expect(transport.costUsd()).toBe(estimateCostUsd('claude-opus-5-5', usage));
  });
});
