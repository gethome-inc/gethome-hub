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
  sent: [] as { messages: { role: string; content: unknown }[] }[],
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
  },
}));

const { createAnthropicTransport } = await import('../src/ai/chat/anthropic-transport.js');

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
