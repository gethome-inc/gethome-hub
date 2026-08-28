import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import type { MappingDescriptor } from '../src/ai/descriptor.js';
import { AiUnavailableError } from '../src/ai/errors.js';
import { createOpenAiMappingAgent } from '../src/ai/openai-agent.js';
import { defaultModelFor } from '../src/ai/models.js';

/**
 * The mapping agent on OpenAI, exercised over a mocked `fetch`.
 *
 * The Anthropic loop is mocked at its SDK; this one has no SDK, so the seam is
 * the HTTP call itself — which is the more honest place to test it anyway,
 * because the request body *is* the contract with the vendor.
 */
const log = pino({ level: 'silent' });

const validDescriptor: MappingDescriptor = {
  version: 1,
  endpoints: [
    {
      endpointId: 1,
      deviceKind: 'sensor',
      capabilities: ['humidity'],
      primary: 'humidity',
      stateRules: [
        { property: 'soil_moisture', to: 'sensors.humidityCenti', transform: { kind: 'multiply', factor: 100 } },
      ],
      commandRules: [],
      customFields: [],
    },
  ],
};

/** One `function_call` item asking to submit a descriptor. */
const submitCall = (input: unknown, callId = 'call_1') => ({
  type: 'function_call',
  id: `fc_${callId}`,
  call_id: callId,
  name: 'submit_mapping',
  arguments: JSON.stringify(input),
});

/** A reasoning item as stateless mode returns one — opaque, and echoed back. */
const reasoning = (id = 'rs_1') => ({
  type: 'reasoning',
  id,
  summary: [],
  encrypted_content: 'gAAAAA-opaque',
});

const prose = (text = 'I think it is a soil sensor.') => ({
  type: 'message',
  id: 'msg_1',
  role: 'assistant',
  content: [{ type: 'output_text', text }],
});

interface SentRequest {
  model: string;
  instructions: string;
  input: Array<Record<string, unknown>>;
  tools: Array<Record<string, unknown>>;
  include: string[];
  reasoning: { effort: string };
  store: boolean;
  max_output_tokens: number;
}

describe('the mapping agent on OpenAI', () => {
  const sent: SentRequest[] = [];
  const replies: unknown[] = [];
  let fetchMock: ReturnType<typeof vi.fn>;

  const queue = (...bodies: unknown[]) => replies.push(...bodies);
  const ok = (output: unknown[], usage?: Record<string, unknown>) => ({
    status: 'completed',
    output,
    usage: usage ?? { input_tokens: 1000, output_tokens: 200 },
  });

  beforeEach(() => {
    sent.length = 0;
    replies.length = 0;
    fetchMock = vi.fn(async (_url: unknown, init: { body: string }) => {
      sent.push(JSON.parse(init.body) as SentRequest);
      // The last queued reply repeats, so a test can either script a sequence
      // or pin one answer and let the loop run into a guardrail.
      const body = replies.length > 1 ? replies.shift() : replies[0];
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const agent = (model: string | null = null) =>
    createOpenAiMappingAgent({ secret: 'sk-proj-test' }, model, log);

  it('returns the descriptor the model submitted', async () => {
    queue(ok([reasoning(), submitCall(validDescriptor)]));
    const result = await agent().generate('system', 'user');
    expect(result).toMatchObject({ version: 1 });
    expect(sent).toHaveLength(1);
  });

  /**
   * The request body is the contract. `web_search` is the research half —
   * there is deliberately no fetch tool, because OpenAI has no hosted
   * equivalent and a hub-side one would mean the hub opening connections to
   * third-party sites.
   */
  it('sends hosted search, the submit tool, high effort, and stores nothing', async () => {
    queue(ok([submitCall(validDescriptor)]));
    await agent().generate('a system prompt', 'user');

    const request = sent[0]!;
    expect(request.tools.map((tool) => tool.type ?? tool.name)).toEqual(['web_search', 'function']);
    const submit = request.tools[1]!;
    expect(submit.name).toBe('submit_mapping');
    expect(submit.strict).toBe(false);
    expect((submit.parameters as { type: string }).type).toBe('object');
    // The descriptor's semantic rules are what the resubmit loop is for.
    expect(submit.parameters).not.toHaveProperty('$schema');

    expect(request.instructions).toBe('a system prompt');
    expect(request.include).toEqual(['reasoning.encrypted_content']);
    expect(request.reasoning.effort).toBe('high');
    expect(request.store).toBe(false);
    expect(request.model).toBe(defaultModelFor('openai'));
  });

  /**
   * Stateless mode is the whole reason reasoning has to travel: OpenAI keeps
   * no copy, so a run that dropped these items would lose the model's own
   * chain of thought across the tool call it just made.
   */
  it('echoes reasoning items back verbatim on the next turn', async () => {
    queue(
      ok([reasoning('rs_first'), submitCall({ version: 1, endpoints: [] })]),
      ok([reasoning('rs_second'), submitCall(validDescriptor, 'call_2')]),
    );
    await agent().generate('system', 'user');

    const secondTurn = sent[1]!.input;
    expect(secondTurn).toContainEqual(expect.objectContaining({ type: 'reasoning', id: 'rs_first' }));
    expect(secondTurn).toContainEqual(
      expect.objectContaining({ encrypted_content: 'gAAAAA-opaque' }),
    );
    // …and the tool result goes back keyed by `call_id`, not by item id.
    expect(secondTurn.at(-1)).toMatchObject({ type: 'function_call_output', call_id: 'call_1' });
  });

  it('hands validation errors back so the model can resubmit', async () => {
    queue(
      ok([submitCall({ version: 1, endpoints: [] })]),
      ok([submitCall(validDescriptor, 'call_2')]),
    );
    const result = await agent().generate('system', 'user');
    expect(result).toMatchObject({ version: 1 });
    expect(String(sent[1]!.input.at(-1)!.output)).toContain('schema errors');
  });

  it('keeps the last invalid submission so the mapper can cache the rejection', async () => {
    queue(ok([submitCall({ version: 1, endpoints: [] })]));
    const result = await agent().generate('system', 'user');
    // Returned rather than thrown: an invalid last answer is still the run's
    // answer, and caching it is what stops the hub re-asking for ever.
    expect(result).toMatchObject({ version: 1, endpoints: [] });
  });

  /**
   * Answering in prose has already cost the run its research, so it is worth a
   * reminder or two — but not the whole turn budget.
   */
  it('asks again when the model answers in prose, and gives up after two', async () => {
    queue(ok([prose()]));
    await expect(agent().generate('system', 'user')).rejects.toThrow(/without calling submit_mapping/);
    expect(sent).toHaveLength(3);
    expect(sent[1]!.input.at(-1)).toMatchObject({ role: 'user' });
    expect(String(sent[1]!.input.at(-1)!.content)).toContain('submit_mapping');
  });

  it('reports each hosted search as a step, with what was looked up', async () => {
    queue(
      ok([
        {
          type: 'web_search_call',
          id: 'ws_1',
          status: 'completed',
          action: { type: 'search', queries: ['aqara soil sensor zigbee2mqtt'] },
        },
        submitCall(validDescriptor),
      ]),
    );
    const steps: string[] = [];
    await agent().generate('system', 'user', { onStep: (step) => steps.push(`${step.type}:${step.detail ?? ''}`) });
    expect(steps).toContain('search:aqara soil sensor zigbee2mqtt');
  });

  it('stops on a refusal rather than nudging a model that has declined', async () => {
    queue(ok([{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'no' }] }]));
    await expect(agent().generate('system', 'user')).rejects.toThrow(/refused by the model/);
    expect(sent).toHaveLength(1);
  });

  it('stops when a turn runs out of output tokens', async () => {
    queue({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] });
    await expect(agent().generate('system', 'user')).rejects.toThrow(/max_output_tokens/);
  });

  it('does not mistake a failed response for prose and retry it', async () => {
    queue({ status: 'failed', error: { message: 'The response could not be completed.' }, output: [] });
    await expect(agent().generate('system', 'user')).rejects.toThrow(/response failed: The response could not be completed/);
    expect(sent).toHaveLength(1);
  });

  /**
   * The classifier branches on HTTP status rather than on a vendor's error
   * vocabulary, which is what lets one backoff gate serve both providers.
   */
  it('turns a rate limit into a backoff, carrying OpenAI’s own sentence', async () => {
    fetchMock.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify({ error: { message: 'Rate limit reached for gpt-5.6' } }), {
          status: 429,
          headers: { 'retry-after': '30' },
        }),
    );
    const failure = await agent()
      .generate('system', 'user')
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AiUnavailableError);
    expect((failure as AiUnavailableError).kind).toBe('rate_limited');
    expect((failure as Error).message).toContain('Rate limit reached');
  });

  it('refuses a model this hub would not accept, without arming the backoff', async () => {
    const wrong = createOpenAiMappingAgent({ secret: 'sk-proj-test' }, 'gpt-3.5-turbo', log);
    const failure = await wrong.generate('system', 'user').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(AiUnavailableError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * OpenAI reports cached input *inside* the input count rather than beside it,
   * so counting both at full rate would bill a cached prompt twice.
   */
  it('bills a cached prompt once, at the cache rate', async () => {
    queue(
      ok([submitCall(validDescriptor)], {
        input_tokens: 1_000_000,
        input_tokens_details: { cached_tokens: 1_000_000 },
        output_tokens: 0,
      }),
    );
    let cost = -1;
    await agent().generate('system', 'user', { onStats: (stats) => (cost = stats.costUsd) });
    // A million cached input tokens at a tenth of $4, and nothing else.
    expect(cost).toBeCloseTo(0.4, 5);
  });

  it('counts a cache write at its documented cache-write rate', async () => {
    queue(
      ok([submitCall(validDescriptor)], {
        input_tokens: 2_000_000,
        input_tokens_details: { cache_write_tokens: 1_000_000 },
        output_tokens: 0,
      }),
    );
    let cost = -1;
    await agent().generate('system', 'user', { onStats: (stats) => (cost = stats.costUsd) });
    // One million regular input tokens ($4) plus one million cache-write
    // tokens ($5 = 1.25x the input rate).
    expect(cost).toBeCloseTo(9, 5);
  });
});
