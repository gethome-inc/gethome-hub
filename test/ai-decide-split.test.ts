import { describe, expect, it } from 'vitest';
import type { Logger } from '../src/logging.js';
import { MAX_PARTS } from '../src/ai/decide/questions.js';
import {
  SPLIT_SYSTEM_PROMPT,
  checkParts,
  splitRequest,
  type SplitInput,
} from '../src/ai/decide/split.js';

/**
 * Splitting one sentence into the requests in it — the one step of the fast
 * path a decision model cannot take, because it is writing.
 *
 * Both vendors are driven through their real clients with only `fetch` stood
 * in for, answering with **real `Response` objects** — the SDK's own request
 * building, header handling and parsing all run. What is asserted is what the
 * hub must never do: act on a split it cannot read, retry in front of somebody
 * waiting, or throw into the turn that asked.
 */

const log = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Logger;

interface Sent {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function stubFetch(
  respond: (sent: Sent, signal: AbortSignal | undefined) => Response | Promise<Response>,
): { sent: Sent[]; fetch: typeof fetch } {
  const sent: Sent[] = [];
  const fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String((input as Request).url);
    const entry: Sent = {
      url,
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    };
    sent.push(entry);
    return respond(entry, init?.signal ?? undefined);
  }) as typeof globalThis.fetch;
  return { sent, fetch };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const untilAborted = (signal: AbortSignal | undefined): Promise<Response> =>
  new Promise((_, reject) => {
    signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });

const said = 'turn off the TV and close the blinds';
const twoParts = { parts: ['turn off the TV', 'close the blinds'] };

const anthropicMessage = (text: string, overrides: Record<string, unknown> = {}) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5',
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 400, output_tokens: 30 },
  ...overrides,
});

const openAiResponse = (text: string, overrides: Record<string, unknown> = {}) => ({
  id: 'resp_1',
  status: 'completed',
  output: [
    { type: 'reasoning', summary: [] },
    { type: 'message', content: [{ type: 'output_text', text }] },
  ],
  usage: { input_tokens: 300, output_tokens: 20 },
  ...overrides,
});

const anthropic = (fetch: typeof globalThis.fetch, extra: Partial<SplitInput> = {}): SplitInput => ({
  provider: 'anthropic',
  modelId: 'claude-opus-5',
  secret: 'sk-ant-test',
  said,
  log,
  fetch,
  ...extra,
});

const openai = (fetch: typeof globalThis.fetch, extra: Partial<SplitInput> = {}): SplitInput => ({
  provider: 'openai',
  modelId: 'gpt-5.6-sol',
  secret: 'sk-openai-test',
  said,
  log,
  fetch,
  ...extra,
});

describe('reading a split', () => {
  it('takes one to four short, non-empty parts, trimmed', () => {
    expect(checkParts({ parts: [' turn off the TV ', 'close the blinds'] })).toEqual([
      'turn off the TV',
      'close the blinds',
    ]);
    expect(checkParts({ parts: ['one request'] })).toEqual(['one request']);
  });

  it('refuses rather than repairs anything else', () => {
    // A part cut short or a list with a fifth request in it is a different
    // sentence from the one somebody said.
    expect(checkParts(null)).toBeNull();
    expect(checkParts('turn off the TV')).toBeNull();
    expect(checkParts({})).toBeNull();
    expect(checkParts({ parts: 'turn off the TV' })).toBeNull();
    expect(checkParts({ parts: [] })).toBeNull();
    expect(checkParts({ parts: ['a', '  '] })).toBeNull();
    expect(checkParts({ parts: ['a', 7] })).toBeNull();
    expect(checkParts({ parts: ['x'.repeat(301)] })).toBeNull();
    expect(checkParts({ parts: Array.from({ length: MAX_PARTS + 1 }, (_, i) => `part ${i}`) })).toBeNull();
  });
});

describe('the prompt', () => {
  it('keeps their words, keeps a group whole, and hands back one request unchanged', () => {
    expect(SPLIT_SYSTEM_PROMPT).toContain('Keep their words and their language');
    expect(SPLIT_SYSTEM_PROMPT).toContain('stays whole');
    expect(SPLIT_SYSTEM_PROMPT).toContain('return it unchanged as the only item');
    expect(SPLIT_SYSTEM_PROMPT).toContain(`more than ${MAX_PARTS}`);
  });
});

describe('on Anthropic', () => {
  it('asks for a schema-shaped answer at the lowest effort, with no thinking', async () => {
    const { sent, fetch } = stubFetch(() => json(anthropicMessage(JSON.stringify(twoParts))));
    const result = await splitRequest(anthropic(fetch));

    expect(result?.parts).toEqual(twoParts.parts);
    // 400 in and 30 out at Opus 5's own prices: what the owner's key paid.
    expect(result?.costUsd).toBeCloseTo((400 * 5 + 30 * 25) / 1_000_000, 9);
    expect(result?.durationMs).toBeGreaterThanOrEqual(0);

    expect(sent).toHaveLength(1);
    const [request] = sent;
    expect(request?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(request?.headers.get('x-api-key')).toBe('sk-ant-test');
    expect(request?.body).toMatchObject({
      model: 'claude-opus-5',
      system: SPLIT_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: said }],
      thinking: { type: 'disabled' },
      output_config: {
        effort: 'low',
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: { parts: { type: 'array', items: { type: 'string' } } },
            required: ['parts'],
            additionalProperties: false,
          },
        },
      },
    });
  });

  it('reads a refusal or a cut-off answer as no split', async () => {
    for (const stop of ['refusal', 'max_tokens']) {
      const { fetch } = stubFetch(() =>
        json(anthropicMessage(JSON.stringify(twoParts), { stop_reason: stop })),
      );
      expect(await splitRequest(anthropic(fetch)), stop).toBeNull();
    }
  });

  it('does not try again in front of somebody waiting', async () => {
    // One request, one deadline — `lazy.ts`'s reason for having no retry.
    const { sent, fetch } = stubFetch(() => json({ type: 'error', error: { type: 'overloaded_error' } }, 529));
    expect(await splitRequest(anthropic(fetch))).toBeNull();
    expect(sent).toHaveLength(1);
  });

  it('gives up at its deadline, and says nothing louder than null', async () => {
    const { fetch } = stubFetch((_sent, signal) => untilAborted(signal));
    expect(await splitRequest(anthropic(fetch, { timeoutMs: 30 }))).toBeNull();
  });

  it('reads an answer that is not JSON as no split, rather than throwing', async () => {
    const { fetch } = stubFetch(() => json(anthropicMessage('Here are the parts: turn off the TV, close the blinds')));
    expect(await splitRequest(anthropic(fetch))).toBeNull();
  });
});

describe('on OpenAI', () => {
  it('asks for a strict schema at the lowest effort, and keeps nothing', async () => {
    const { sent, fetch } = stubFetch(() => json(openAiResponse(JSON.stringify(twoParts))));
    const result = await splitRequest(openai(fetch));

    expect(result?.parts).toEqual(twoParts.parts);
    expect(result?.costUsd).toBeCloseTo((300 * 4 + 20 * 20) / 1_000_000, 9);

    expect(sent).toHaveLength(1);
    const [request] = sent;
    expect(request?.url).toBe('https://api.openai.com/v1/responses');
    expect(request?.headers.get('authorization')).toBe('Bearer sk-openai-test');
    expect(request?.body).toMatchObject({
      model: 'gpt-5.6-sol',
      instructions: SPLIT_SYSTEM_PROMPT,
      input: said,
      reasoning: { effort: 'low' },
      text: { format: { type: 'json_schema', name: 'parts', strict: true } },
      // A split is not a conversation anybody will come back to.
      store: false,
    });
  });

  it('reads a refusal, an unfinished answer or nonsense as no split', async () => {
    const cases: Response[] = [
      json({ error: { message: 'no' } }, 400),
      json(openAiResponse(JSON.stringify(twoParts), { status: 'incomplete' })),
      json(openAiResponse('not json at all')),
      json(openAiResponse(JSON.stringify({ parts: Array.from({ length: MAX_PARTS + 1 }, () => 'x') }))),
      json(openAiResponse('')),
    ];
    for (const response of cases) {
      const { fetch } = stubFetch(() => response);
      expect(await splitRequest(openai(fetch))).toBeNull();
    }
  });

  it('gives up at its deadline', async () => {
    const { fetch } = stubFetch((_sent, signal) => untilAborted(signal));
    expect(await splitRequest(openai(fetch, { timeoutMs: 30 }))).toBeNull();
  });

  it('hands back one request as one part, for the caller to read whole', async () => {
    const { fetch } = stubFetch(() => json(openAiResponse(JSON.stringify({ parts: [said] }))));
    expect((await splitRequest(openai(fetch)))?.parts).toEqual([said]);
  });
});
