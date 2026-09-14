import { afterEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { createOpenAiTransport } from '../src/ai/chat/openai-transport.js';
import { QuestionGate, type ChatTransportOptions } from '../src/ai/chat/agent-loop.js';

/**
 * The OpenAI half of a conversation.
 *
 * The Anthropic loop has been exercised for two agents' worth of releases; this
 * one is new, and everything in it that can be wrong is wrong in a way that
 * only shows against a real stream — an event name that never fires, a tool
 * call that arrives as a string of JSON nobody parsed, a dangling call that
 * refuses the whole conversation on the *next* message rather than this one.
 *
 * So the fixture is the wire: `fetch` is stubbed with a real SSE body and the
 * assertions are about what came out of it. A mock that answered with a parsed
 * object instead would be laxer than the thing it stands in for, which is the
 * trap `test/ai-agent.test.ts` paid for once already.
 */

const log = pino({ level: 'silent' });

/** One SSE frame, exactly as the Responses stream writes it. */
function frame(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A stubbed streaming response whose body is those frames, in chunks. */
function streamOf(frames: string[], chunkAt = 0): Response {
  const text = frames.join('');
  // Cut mid-frame on purpose when asked: the parser buffers across chunks, and
  // a fixture that only ever delivers whole frames tests the wrong thing.
  const pieces =
    chunkAt > 0 ? [text.slice(0, chunkAt), text.slice(chunkAt)] : [text];
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** The body the last request carried, parsed. */
function sentBody(): Record<string, unknown> {
  const call = vi.mocked(globalThis.fetch).mock.calls.at(-1);
  const init = call?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

function transportFor(): ReturnType<typeof createOpenAiTransport> {
  const options: ChatTransportOptions = {
    secret: 'sk-proj-test',
    modelId: 'gpt-5.6-sol',
    systemPrompt: 'system',
    tools: [
      {
        name: 'list_devices',
        description: 'every device',
        schema: () => ({ type: 'object', properties: {} }),
      },
    ],
    label: 'the assistant',
    timeoutMs: 60_000,
    effort: 'medium',
    signal: new AbortController().signal,
    log,
  };
  return createOpenAiTransport(options);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the OpenAI chat transport', () => {
  it('streams the reply and the reasoning out separately, across chunk boundaries', async () => {
    const frames = [
      frame('response.reasoning_summary_text.delta', { delta: 'Checking the kitchen' }),
      frame('response.output_text.delta', { delta: 'The lamp ' }),
      frame('response.output_text.delta', { delta: 'is on.' }),
      frame('response.completed', {
        response: {
          status: 'completed',
          output: [
            { type: 'message', content: [{ type: 'output_text', text: 'The lamp is on.' }] },
          ],
          usage: { input_tokens: 100, output_tokens: 20 },
        },
      }),
    ];
    // Split inside the second delta frame, which is where a parser that reads
    // whole chunks rather than buffering would lose a word.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamOf(frames, 120)));

    const transport = transportFor();
    const deltas: string[] = [];
    const thinking: string[] = [];
    transport.pushUser('is the kitchen lamp on?');
    const round = await transport.round({
      onDelta: (delta) => deltas.push(delta),
      onThinking: (delta) => thinking.push(delta),
    });

    expect(deltas.join('')).toBe('The lamp is on.');
    expect(thinking.join('')).toBe('Checking the kitchen');
    expect(round.said).toBe('The lamp is on.');
    expect(round.stop).toBe('end');
    expect(round.calls).toEqual([]);
    expect(transport.costUsd()).toBeGreaterThan(0);
  });

  it('asks for the two things that make a chat legible on this vendor', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        streamOf([frame('response.completed', { response: { status: 'completed', output: [] } })]),
      ),
    );
    const transport = transportFor();
    transport.pushUser('hello');
    await transport.round(undefined);

    const body = sentBody();
    // Without `stream` there are no deltas and the page shows three dots for
    // the whole round; without `summary` the reasoning arrives empty, which is
    // this vendor's spelling of the `display: 'summarized'` lesson.
    expect(body['stream']).toBe(true);
    expect(body['reasoning']).toEqual({ effort: 'medium', summary: 'auto' });
    // Stateless, with the opaque reasoning replayed by us rather than retained
    // by them.
    expect(body['store']).toBe(false);
    expect(body['include']).toEqual(['reasoning.encrypted_content']);
  });

  it('hands a tool call back parsed, and sends its result as the call it answers', async () => {
    // A fresh body per call: a `ReadableStream` is consumed once, so one
    // resolved `Response` handed back twice is a second round reading nothing.
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          streamOf([
            frame('response.completed', {
              response: {
                status: 'completed',
                output: [
                  {
                    type: 'function_call',
                    call_id: 'call_1',
                    name: 'list_devices',
                    arguments: '{"roomId":"kitchen"}',
                  },
                ],
              },
            }),
          ]),
        ),
      ),
    );

    const transport = transportFor();
    transport.pushUser('what is in the kitchen?');
    const round = await transport.round(undefined);

    // Arguments arrive as a JSON *string* on this API. A caller handed the
    // string would `safeParse` it and refuse every call it ever made.
    expect(round.calls).toEqual([
      { id: 'call_1', name: 'list_devices', input: { roomId: 'kitchen' } },
    ]);
    expect(round.stop).toBe('tools');

    transport.pushToolResults([{ id: 'call_1', text: 'one lamp' }]);
    await transport.round(undefined);
    const input = sentBody()['input'] as Record<string, unknown>[];
    expect(input.at(-1)).toEqual({
      type: 'function_call_output',
      call_id: 'call_1',
      output: 'one lamp',
    });
  });

  it('carries a failure in words, because this API has no is_error to carry it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        streamOf([frame('response.completed', { response: { status: 'completed', output: [] } })]),
      ),
    );
    const transport = transportFor();
    transport.pushToolResults([{ id: 'call_1', text: 'no such device.', isError: true }]);
    await transport.round(undefined);

    const input = sentBody()['input'] as Record<string, unknown>[];
    expect(input.at(-1)).toMatchObject({ output: 'That failed. no such device.' });
  });

  it('closes the calls a failed round left open, and leaves an open question alone', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          streamOf([
            frame('response.completed', {
              response: {
                status: 'completed',
                output: [
                  { type: 'function_call', call_id: 'asked', name: 'ask_user', arguments: '{}' },
                  {
                    type: 'function_call',
                    call_id: 'dropped',
                    name: 'list_devices',
                    arguments: '{}',
                  },
                ],
              },
            }),
          ]),
        ),
      ),
    );

    const transport = transportFor();
    const gate = new QuestionGate(transport);
    transport.pushUser('something');
    await transport.round(undefined);
    gate.open('asked');

    // The round threw before its results were written — the case that refuses
    // every later message rather than this one, which is what makes it hard to
    // find.
    gate.settleDangling();

    await transport.round(undefined);
    const input = sentBody()['input'] as Record<string, unknown>[];
    const answered = input
      .filter((item) => item['type'] === 'function_call_output')
      .map((item) => item['call_id']);
    // The question is outstanding on purpose: `QuestionGate.answer()` closes it
    // with the person's reply, and closing it here would throw that away.
    expect(answered).toEqual(['dropped']);
  });

  it('reads a refusal as an outcome rather than as prose', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        streamOf([
          frame('response.completed', {
            response: {
              status: 'completed',
              output: [
                { type: 'message', content: [{ type: 'refusal', refusal: 'I can’t help with that.' }] },
              ],
            },
          }),
        ]),
      ),
    );
    const transport = transportFor();
    transport.pushUser('something');
    const round = await transport.round(undefined);

    expect(round.stop).toBe('refusal');
    expect(round.refusal).toBe('I can’t help with that.');
  });

  it('does not read a failed or unfinished stream as an answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        streamOf([
          frame('response.failed', { response: { error: { message: 'the model is overloaded' } } }),
        ]),
      ),
    );
    const transport = transportFor();
    transport.pushUser('something');
    await expect(transport.round(undefined)).rejects.toThrow(/overloaded/);

    // A stream that simply stops is the other half: continuing from it would
    // push a half-round onto the history and refuse the conversation later.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamOf([])));
    await expect(transport.round(undefined)).rejects.toThrow(/without completing/);
  });

  it('reports the vendor’s own sentence when the request itself is refused', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'Incorrect API key provided' } }), {
          status: 401,
        }),
      ),
    );
    const transport = transportFor();
    transport.pushUser('something');
    await expect(transport.round(undefined)).rejects.toThrow(/Incorrect API key/);
  });
});
