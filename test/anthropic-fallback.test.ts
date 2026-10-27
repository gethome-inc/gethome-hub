import { afterEach, describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import {
  FALLBACK_BETA,
  callsIn,
  echoed,
  fallbackFields,
  fellBack,
  forgetRefusedFallbacks,
  handOvers,
  replyCostUsd,
  saidIn,
  withFallbacks,
} from '../src/ai/anthropic-fallback.js';
import { AGENT_MODELS, PROVIDER_MODELS, estimateCostUsd } from '../src/ai/models.js';

/**
 * A request a Claude declines is asked again of another Claude in the same
 * call, and a reply answered that way is read differently in four ways — its
 * history, its words, its calls and its price.
 *
 * The case pinned hardest is the one with no hand-over in it, because that is
 * every reply but a rare one: opting in must not move a byte of an ordinary
 * conversation, nor a cent of what it costs.
 */

type Block = Anthropic.Beta.BetaContentBlock;
const blocks = (...content: unknown[]) => content as Block[];

const handOver = (from: string, to: string) => ({
  type: 'fallback',
  from: { model: from },
  to: { model: to },
  trigger: { type: 'refusal', category: 'cyber' },
});

const usage = (overrides: Record<string, unknown> = {}) =>
  ({
    input_tokens: 1_000,
    output_tokens: 200,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    iterations: null,
    ...overrides,
  }) as unknown as Anthropic.Beta.BetaUsage;

const iteration = (type: 'message' | 'fallback_message', model: string | null, input: number, output: number) => ({
  type,
  model,
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_creation: null,
});

describe('who is asked to fall back', () => {
  it('opts every Claude a home can run in, under the default form’s own beta', () => {
    const claudes = [
      ...AGENT_MODELS.anthropic.choices.map((choice) => choice.id),
      ...PROVIDER_MODELS.anthropic.choices.map((choice) => choice.id),
    ].filter((id) => !id.startsWith('claude-haiku-'));
    expect(claudes.length).toBeGreaterThan(0);
    for (const id of claudes) {
      expect(fallbackFields(id)).toEqual({ betas: [FALLBACK_BETA], fallbacks: 'default' });
    }
    // The array form is gated by a different date, and pairing either with the
    // other form is a 400.
    expect(FALLBACK_BETA).toBe('server-side-fallback-2026-07-01');
  });

  it('sends Haiku nothing, since it has no fallback and a list is a 400', () => {
    expect(fallbackFields('claude-haiku-5-5')).toEqual({});
  });
});

describe('a reply nothing fell back on', () => {
  const content = blocks(
    { type: 'thinking', thinking: 'The hall light.', signature: 'sig' },
    { type: 'text', text: 'I’ll switch it off.' },
    { type: 'tool_use', id: 'toolu_1', name: 'control_device', input: {} },
    { type: 'text', text: 'Done.' },
  );

  it('goes back verbatim, reasoning included', () => {
    expect(echoed(content)).toEqual(content);
  });

  it('says what it always said, and runs every call', () => {
    expect(saidIn(content)).toBe('I’ll switch it off.\nDone.');
    expect(callsIn(content).map((call) => call.id)).toEqual(['toolu_1']);
    expect(handOvers(content)).toEqual([]);
  });

  it('costs exactly what it always cost', () => {
    const spent = usage({ cache_read_input_tokens: 4_000, server_tool_use: { web_search_requests: 2 } });
    expect(fellBack(spent)).toBe(false);
    expect(replyCostUsd('claude-opus-5-5', spent)).toBe(
      estimateCostUsd('claude-opus-5-5', {
        input_tokens: 1_000,
        output_tokens: 200,
        cache_read_input_tokens: 4_000,
        cache_creation_input_tokens: 0,
        webSearchRequests: 2,
      }),
    );
    // One ordinary attempt listed is still no hand-over.
    expect(
      replyCostUsd('claude-opus-5-5', usage({ iterations: [iteration('message', 'claude-opus-5-5', 1_000, 200)] })),
    ).toBe(estimateCostUsd('claude-opus-5-5', { input_tokens: 1_000, output_tokens: 200 }));
    expect(replyCostUsd('claude-opus-5-5', undefined)).toBe(0);
  });
});

describe('a reply another Claude finished', () => {
  /** A decline part way through: what the first model had begun, the
   *  hand-over, and the answering model's own blocks. */
  const content = blocks(
    { type: 'thinking', thinking: 'Weighing the lock.', signature: 'sig-a' },
    { type: 'redacted_thinking', data: 'opaque' },
    { type: 'server_tool_use', id: 'srv_paired', name: 'web_search', input: { query: 'lock pairing' } },
    { type: 'web_search_tool_result', tool_use_id: 'srv_paired', content: [] },
    { type: 'server_tool_use', id: 'srv_alone', name: 'web_fetch', input: { url: 'https://example.com' } },
    { type: 'text', text: 'The front door lock is' },
    { type: 'tool_use', id: 'toolu_declined', name: 'control_device', input: { deviceId: 'door' } },
    { type: 'something_new', detail: 'a block this build has never met' },
    handOver('claude-opus-5-5', 'claude-opus-4-8'),
    { type: 'thinking', thinking: 'Carrying on.', signature: 'sig-b' },
    { type: 'text', text: ' locked, so nothing needs doing.' },
    { type: 'tool_use', id: 'toolu_answering', name: 'get_device', input: { deviceId: 'door' } },
  );

  it('goes back without what the declined model had begun, and with the rest as it came', () => {
    expect(echoed(content)).toEqual([
      // A search that has its result stays; one left without its result goes.
      content[2],
      content[3],
      // Words stay, and the hand-over stays where it was.
      content[5],
      content[8],
      // Everything after the boundary is the answering model's own.
      content[9],
      content[10],
      content[11],
    ]);
  });

  it('continues the declined model’s sentence rather than starting a new line', () => {
    expect(saidIn(content)).toBe('The front door lock is locked, so nothing needs doing.');
  });

  it('runs only the answering model’s calls', () => {
    expect(callsIn(content).map((call) => call.id)).toEqual(['toolu_answering']);
  });

  it('names who handed over to whom, in the hub’s own words for them', () => {
    expect(handOvers(content)).toEqual([{ from: 'Opus 5.5', to: 'Opus 4.8' }]);
  });

  it('keeps an earlier hand-over in place and cuts at the last one', () => {
    const twice = blocks(
      { type: 'text', text: 'One' },
      handOver('claude-fable-5-1', 'claude-opus-5'),
      { type: 'thinking', thinking: 'Opus 5 began.', signature: 'sig' },
      { type: 'text', text: ', two' },
      handOver('claude-opus-5', 'claude-opus-4-8'),
      { type: 'text', text: ', three.' },
    );
    expect(echoed(twice)).toEqual([twice[0], twice[1], twice[3], twice[4], twice[5]]);
    expect(saidIn(twice)).toBe('One, two, three.');
    expect(handOvers(twice)).toEqual([
      { from: 'Fable 5.1', to: 'Opus 5' },
      { from: 'Opus 5', to: 'Opus 4.8' },
    ]);
  });

  it('is priced per attempt, each at its own model’s rates', () => {
    const spent = usage({
      input_tokens: 1_100,
      output_tokens: 300,
      server_tool_use: { web_search_requests: 1 },
      iterations: [
        iteration('message', 'claude-opus-5-5', 1_000, 40),
        iteration('fallback_message', 'claude-opus-4-8', 1_100, 300),
      ],
    });
    expect(fellBack(spent)).toBe(true);
    expect(replyCostUsd('claude-opus-5-5', spent)).toBeCloseTo(
      estimateCostUsd('claude-opus-5-5', { input_tokens: 1_000, output_tokens: 40 }) +
        estimateCostUsd('claude-opus-4-8', { input_tokens: 1_100, output_tokens: 300 }) +
        estimateCostUsd('claude-opus-5-5', { webSearchRequests: 1 }),
      12,
    );
  });

  it('prices an attempt that does not say which model ran it as the one asked for', () => {
    const spent = usage({
      iterations: [
        iteration('message', null, 1_000, 40),
        iteration('fallback_message', 'claude-opus-4-8', 1_100, 300),
      ],
    });
    expect(replyCostUsd('claude-fable-5-1', spent)).toBeCloseTo(
      estimateCostUsd('claude-fable-5-1', { input_tokens: 1_000, output_tokens: 40 }) +
        estimateCostUsd('claude-opus-4-8', { input_tokens: 1_100, output_tokens: 300 }),
      12,
    );
  });
});

/**
 * The beta has been renamed twice, and a hub is a board somebody updates when
 * they think to. A request the API refuses *because of the field* is sent
 * again without it, and the field is not sent again — so a retired beta costs
 * a home its fallback and never its assistant. Any other refusal reaches the
 * caller exactly as it came.
 */
describe('a hub that outlives the beta', () => {
  afterEach(() => forgetRefusedFallbacks());

  const refused = (message: string) =>
    Object.assign(new Error(`400 {"type":"error","error":{"type":"invalid_request_error","message":"${message}"}}`), {
      status: 400,
    });

  it('sends the request again without the field, and stops sending it', async () => {
    const sent: object[] = [];
    const answer = await withFallbacks('claude-opus-5-5', async (fields) => {
      sent.push(fields);
      if ('fallbacks' in fields) {
        throw refused('Unexpected value(s) `server-side-fallback-2026-07-01` for the `anthropic-beta` header.');
      }
      return 'answered';
    });
    expect(answer).toBe('answered');
    expect(sent).toEqual([{ betas: [FALLBACK_BETA], fallbacks: 'default' }, {}]);

    // The next request goes without it from the start.
    expect(fallbackFields('claude-opus-5-5')).toEqual({});
    const next: object[] = [];
    await withFallbacks('claude-opus-5-5', async (fields) => {
      next.push(fields);
      return 'answered';
    });
    expect(next).toEqual([{}]);
  });

  it('reads a parameter the API no longer takes the same way', async () => {
    let calls = 0;
    await withFallbacks('claude-sonnet-5-5', async (fields) => {
      calls += 1;
      if ('fallbacks' in fields) throw refused('fallbacks: Extra inputs are not permitted');
      return 'answered';
    });
    expect(calls).toBe(2);
  });

  it('leaves every other refusal alone', async () => {
    const other = refused('messages: roles must alternate');
    let calls = 0;
    await expect(
      withFallbacks('claude-opus-5-5', async () => {
        calls += 1;
        throw other;
      }),
    ).rejects.toBe(other);
    expect(calls).toBe(1);
    // A busy API is not a refused field either.
    const busy = Object.assign(new Error('529 overloaded fallback'), { status: 529 });
    await expect(withFallbacks('claude-opus-5-5', async () => Promise.reject(busy))).rejects.toBe(busy);
    expect(fallbackFields('claude-opus-5-5')).toEqual({ betas: [FALLBACK_BETA], fallbacks: 'default' });
  });
});
