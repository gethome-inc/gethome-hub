import { afterEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { QuestionGate, type ChatTransport, type ChatTransportOptions } from '../src/ai/chat/agent-loop.js';
import type { ChatImage } from '../src/ai/chat/chat-runtime.js';

/**
 * A photo, as each vendor is sent it.
 *
 * The runtime hands a transport the person's words and their photos; what
 * reaches the wire is the vendor's own shape, and that is the only place a
 * mistake here would show — a text-only request that stopped being
 * byte-identical (and lost its cached prefix), an empty text block Anthropic
 * refuses, a photo put *ahead* of the tool results it has to follow. So the
 * fixture is what was sent: the SDK's `stream` captured (cloned at the moment
 * of the call, because the transport keeps pushing to the same array), and
 * `fetch` stubbed with a real SSE body for OpenAI, the rule
 * `test/ai-openai-chat.test.ts` gives for why.
 */

const { streamMock } = vi.hoisted(() => ({ streamMock: vi.fn() }));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = {
      create: async () => {
        // The SDK refuses a non-streaming request this large; the transport
        // must never ask for one, so reaching here is a failure in itself.
        throw new Error('Streaming is required for operations that may take longer than 10 minutes.');
      },
      stream: (params: unknown) => {
        // Cloned now: the transport pushes the reply onto this same array
        // straight after, and an assertion on the live one reads that instead.
        streamMock(structuredClone(params));
        const message = {
          content: [{ type: 'text', text: 'A lamp.' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        };
        return { on: () => undefined, finalMessage: async () => message };
      },
    };
  },
}));

const { createAnthropicTransport } = await import('../src/ai/chat/anthropic-transport.js');
const { createOpenAiTransport } = await import('../src/ai/chat/openai-transport.js');

const log = pino({ level: 'silent' });

const options = (modelId: string): ChatTransportOptions => ({
  secret: 'test',
  modelId,
  systemPrompt: 'system',
  tools: [],
  label: 'the assistant',
  timeoutMs: 60_000,
  effort: 'medium',
  signal: new AbortController().signal,
  log,
});

const jpeg: ChatImage = { mediaType: 'image/jpeg', data: 'AAAA' };
const png: ChatImage = { mediaType: 'image/png', data: 'BBBB' };

/** The `messages` the last Anthropic request carried. */
function anthropicSent(): { role: string; content: unknown }[] {
  const params = streamMock.mock.calls.at(-1)?.[0] as { messages: { role: string; content: unknown }[] };
  return params.messages;
}

describe('photos on Anthropic', () => {
  it('sends a text-only message exactly as it always did', async () => {
    const transport = createAnthropicTransport(options('claude-opus-5-5'));
    transport.pushUser('hello');
    await transport.round(undefined);
    // A plain string, not a one-block array: the cached prefix of every
    // conversation that never sends a photo stays byte-for-byte what it was.
    expect(anthropicSent()[0]).toEqual({ role: 'user', content: 'hello' });
  });

  it('puts the photos first and the words after them, in one user turn', async () => {
    const transport = createAnthropicTransport(options('claude-opus-5-5'));
    transport.pushUser('what is this?', [jpeg, png]);
    await transport.round(undefined);
    expect(anthropicSent()[0]).toEqual({
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BBBB' } },
        { type: 'text', text: 'what is this?' },
      ],
    });
  });

  it('sends a photo on its own with no empty text block, which the API refuses', async () => {
    const transport = createAnthropicTransport(options('claude-opus-5-5'));
    transport.pushUser('', [jpeg]);
    await transport.round(undefined);
    expect(anthropicSent()[0]).toEqual({
      role: 'user',
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } }],
    });
  });

  it('carries an answer’s photo after the tool results, never ahead of them', async () => {
    const transport = createAnthropicTransport(options('claude-opus-5-5'));
    transport.pushUser('which lamp?');
    transport.pushToolResults([{ id: 'toolu_1', text: 'this one' }], [jpeg]);
    await transport.round(undefined);
    expect(anthropicSent()[1]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'this one' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
      ],
    });
  });
});

/** One SSE frame, exactly as the Responses stream writes it. */
function frame(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function completed(): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          frame('response.completed', { response: { status: 'completed', output: [] } }),
        ),
      );
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** The `input` the last OpenAI request carried. */
function openAiSent(): unknown[] {
  const init = vi.mocked(globalThis.fetch).mock.calls.at(-1)?.[1] as RequestInit | undefined;
  return (JSON.parse(String(init?.body)) as { input: unknown[] }).input;
}

describe('photos on OpenAI', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const openAi = (): ChatTransport => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(completed())));
    return createOpenAiTransport(options('gpt-6.1-sol'));
  };

  it('sends a text-only message exactly as it always did', async () => {
    const transport = openAi();
    transport.pushUser('hello');
    await transport.round(undefined);
    expect(openAiSent()[0]).toEqual({ role: 'user', content: 'hello' });
  });

  it('sends the words and then each photo as a data URL, in one user item', async () => {
    const transport = openAi();
    transport.pushUser('what is this?', [jpeg, png]);
    await transport.round(undefined);
    expect(openAiSent()[0]).toEqual({
      role: 'user',
      content: [
        { type: 'input_text', text: 'what is this?' },
        { type: 'input_image', image_url: 'data:image/jpeg;base64,AAAA' },
        { type: 'input_image', image_url: 'data:image/png;base64,BBBB' },
      ],
    });
  });

  it('sends a photo on its own with no empty text part', async () => {
    const transport = openAi();
    transport.pushUser('', [jpeg]);
    await transport.round(undefined);
    expect(openAiSent()[0]).toEqual({
      role: 'user',
      content: [{ type: 'input_image', image_url: 'data:image/jpeg;base64,AAAA' }],
    });
  });

  it('follows the function outputs with the answer’s photo, as the next user item', async () => {
    const transport = openAi();
    transport.pushUser('which lamp?');
    transport.pushToolResults([{ id: 'call_1', text: 'this one' }], [jpeg]);
    await transport.round(undefined);
    const input = openAiSent();
    expect(input.slice(1)).toEqual([
      { type: 'function_call_output', call_id: 'call_1', output: 'this one' },
      { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/jpeg;base64,AAAA' }] },
    ]);
  });
});

describe('an answer that is only a photo', () => {
  it('closes the question with a sentence saying so, and sends the photo with it', () => {
    const pushed: { text: string; images: number }[] = [];
    const transport = {
      pushToolResults: (results: { text: string }[], images?: readonly ChatImage[]) => {
        pushed.push(...results.map((result) => ({ text: result.text, images: images?.length ?? 0 })));
      },
    } as unknown as ChatTransport;
    const gate = new QuestionGate(transport);
    gate.open('call_1');
    gate.answer('', [jpeg]);
    // A tool result has to say something, and an empty one is the request a
    // vendor is entitled to refuse.
    expect(pushed).toEqual([{ text: '(They answered with the photo below.)', images: 1 }]);
  });
});
