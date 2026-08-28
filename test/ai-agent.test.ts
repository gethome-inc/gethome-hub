import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Logger } from '../src/logging.js';
import type { MappingDescriptor } from '../src/ai/descriptor.js';
import type { Z2mDevice } from '../src/adapters/zigbee/exposes-mapper.js';
import { mapExposes } from '../src/adapters/zigbee/exposes-mapper.js';
import { classifyAgentFailure, classifyApiError, parseResetHint } from '../src/ai/errors.js';
import { buildMappingUserPrompt, zigbee2mqttDevicePage } from '../src/ai/prompts.js';
import {
  DEFAULT_MODEL,
  PROVIDER_MODELS,
  defaultModelFor,
  estimateCostUsd,
  isSupportedModel,
  supportedModelIds,
} from '../src/ai/models.js';

// The agent constructs its own Anthropic client, so the loop is exercised by
// mocking the SDK rather than by threading a client through the signature.
//
// **The mock reproduces the SDK's own client-side guards, and that is the
// point of it rather than a flourish.** This file used to stub `create` with a
// bare `vi.fn()`, which is strictly more permissive than the real SDK — so the
// whole suite passed over an agent that could not make a single request: the
// SDK refuses a *non-streaming* call whose `max_tokens` could run past the
// API's ten-minute ceiling, and MAX_OUTPUT_TOKENS is well over that line. A
// mock that accepts what the real client refuses does not test the code, it
// tests the mock. `create` therefore throws exactly as the SDK does, and every
// reply goes through `stream`.
const { createMock, nonStreamingCeiling } = vi.hoisted(() => ({
  createMock: vi.fn(),
  // The SDK's arithmetic: a request is refused when its expected generation
  // time (an hour per 128K output tokens) exceeds the ten-minute default.
  nonStreamingCeiling: Math.floor((600_000 * 128_000) / 3_600_000),
}));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = {
      create: async (params: { max_tokens: number }) => {
        if (params.max_tokens > nonStreamingCeiling) {
          throw new Error('Streaming is required for operations that may take longer than 10 minutes.');
        }
        return createMock(params);
      },
      stream: (params: unknown) => ({ finalMessage: async () => createMock(params) }),
    };
  },
}));

const { AGENT_MAX_TURNS, createMappingAgent, evaluateSubmission, submitMappingTool } = await import(
  '../src/ai/agent.js'
);
const { MAX_OUTPUT_TOKENS } = await import('../src/ai/agent-core.js');

// ── Failure classification ────────────────────────────────────────────────

describe('classifyAgentFailure', () => {
  it('recognizes account usage caps (with reset hints)', () => {
    const epoch = classifyAgentFailure('Claude AI usage limit reached|1752710400');
    expect(epoch?.kind).toBe('usage_limit');
    expect(epoch?.resetAt?.getTime()).toBe(1752710400 * 1000);

    expect(classifyAgentFailure('Monthly limit reached for this organization')?.kind).toBe('usage_limit');
  });

  it('recognizes API rate limits, overload, auth, and billing failures', () => {
    expect(classifyAgentFailure('API Error: 429 {"type":"rate_limit_error"}')?.kind).toBe('rate_limited');
    expect(classifyAgentFailure('Too many requests, slow down')?.kind).toBe('rate_limited');
    expect(classifyAgentFailure('API Error: 529 {"type":"overloaded_error"}')?.kind).toBe('overloaded');
    expect(classifyAgentFailure('401 {"type":"authentication_error","message":"invalid x-api-key"}')?.kind).toBe(
      'auth_failed',
    );
    expect(classifyAgentFailure('Your credit balance is too low to access the API')?.kind).toBe('billing');
    expect(classifyAgentFailure('fetch failed: getaddrinfo ENOTFOUND api.anthropic.com')?.kind).toBe('network');
  });

  it('returns null for text that is not an availability problem', () => {
    expect(classifyAgentFailure('the descriptor was missing an endpoint')).toBeNull();
    expect(classifyAgentFailure('error_max_turns')).toBeNull();
  });
});

describe('classifyApiError', () => {
  const now = new Date('2026-07-16T10:00:00Z');

  it('reads the HTTP status rather than the message text', () => {
    // The message deliberately says nothing useful — the status is the signal.
    expect(classifyApiError({ status: 429, message: 'request failed' }, now)?.kind).toBe('rate_limited');
    expect(classifyApiError({ status: 401, message: 'request failed' }, now)?.kind).toBe('auth_failed');
    expect(classifyApiError({ status: 403, message: 'request failed' }, now)?.kind).toBe('auth_failed');
    expect(classifyApiError({ status: 402, message: 'request failed' }, now)?.kind).toBe('billing');
    expect(classifyApiError({ status: 529, message: 'request failed' }, now)?.kind).toBe('overloaded');
    expect(classifyApiError({ status: 503, message: 'request failed' }, now)?.kind).toBe('overloaded');
  });

  it('prefers the provider retry-after header over any heuristic', () => {
    const fromSeconds = classifyApiError(
      { status: 429, message: 'slow down', headers: { 'retry-after': '90' } },
      now,
    );
    expect(fromSeconds?.resetAt?.toISOString()).toBe('2026-07-16T10:01:30.000Z');

    // A Headers-like object works the same way.
    const fromHeaders = classifyApiError(
      { status: 429, message: 'slow down', headers: { get: (k: string) => (k === 'retry-after' ? '30' : null) } },
      now,
    );
    expect(fromHeaders?.resetAt?.toISOString()).toBe('2026-07-16T10:00:30.000Z');
  });

  it('separates an exhausted account cap from an ordinary 429', () => {
    expect(classifyApiError({ status: 429, message: 'monthly limit reached' }, now)?.kind).toBe('usage_limit');
    expect(classifyApiError({ status: 429, message: 'too many requests' }, now)?.kind).toBe('rate_limited');
  });

  it('treats a 400 as our own bug unless it is really a billing problem', () => {
    expect(classifyApiError({ status: 400, message: 'tools.0: unexpected field' }, now)).toBeNull();
    expect(classifyApiError({ status: 400, message: 'Your credit balance is too low' }, now)?.kind).toBe('billing');
  });

  it('falls back to the text when the failure never reached HTTP', () => {
    expect(classifyApiError({ message: 'Connection error.' }, now)?.kind).toBe('network');
    expect(classifyApiError({ message: 'socket hang up' }, now)?.kind).toBe('network');
  });
});

describe('parseResetHint', () => {
  const now = new Date('2026-07-16T10:00:00Z');

  it('parses epoch suffixes in both seconds and milliseconds', () => {
    expect(parseResetHint('usage limit reached|1752710400', now)?.getTime()).toBe(1752710400 * 1000);
    expect(parseResetHint('usage limit reached|1752710400000', now)?.getTime()).toBe(1752710400000);
  });

  it('parses wall-clock reset hints as the next UTC occurrence', () => {
    expect(parseResetHint('resets 11pm (UTC)', now)?.toISOString()).toBe('2026-07-16T23:00:00.000Z');
    expect(parseResetHint('resets at 07:30 (UTC)', now)?.toISOString()).toBe('2026-07-17T07:30:00.000Z');
    expect(parseResetHint('resets 12am (UTC)', now)?.toISOString()).toBe('2026-07-17T00:00:00.000Z');
  });

  it('returns undefined when there is no hint', () => {
    expect(parseResetHint('rate limited', now)).toBeUndefined();
  });
});

// ── The model allowlist ───────────────────────────────────────────────────

/**
 * The loosest cap pattern is `limit reached`, and OpenAI's ordinary 429 says
 * exactly that — "Rate limit reached for …". Reading it as an exhausted
 * account cap would wait for a reset that is a minute away and tell the owner
 * their month is spent.
 */
describe('a rate limit is not an account cap', () => {
  it('reads OpenAI’s own 429 sentence as a rate limit', () => {
    const failure = classifyApiError({
      status: 429,
      message: 'Rate limit reached for gpt-5.6 in organization org-1 on tokens per min.',
    });
    expect(failure?.kind).toBe('rate_limited');
  });

  it('still reads a real cap as one, however it is worded', () => {
    expect(classifyApiError({ status: 429, message: 'You have hit your monthly limit.' })?.kind).toBe(
      'usage_limit',
    );
    expect(classifyAgentFailure('Credit limit reached for this workspace.')?.kind).toBe('usage_limit');
  });
});

describe('supported models', () => {
  it('only allows models that can drive the server-side research tools', () => {
    expect(isSupportedModel(DEFAULT_MODEL)).toBe(true);
    // The _20260209 web tools do not exist on Haiku or the 4.5 generation, so
    // these would 400 rather than degrade.
    expect(isSupportedModel('claude-haiku-4-5')).toBe(false);
    expect(isSupportedModel('claude-sonnet-4-5')).toBe(false);
    expect(isSupportedModel('gpt-4')).toBe(false);
  });

  it('does not offer Claude Fable 5', () => {
    const every = [...supportedModelIds('anthropic'), ...supportedModelIds('openai')];
    expect(every.some((id) => id.includes('fable') || id.includes('mythos'))).toBe(false);
  });

  /**
   * The allowlist is validation and `choices` is the picker, and they are
   * deliberately different lengths: a hub already set to an older model has to
   * keep working, while asking somebody to choose between six is asking them to
   * research six.
   */
  it('offers two models per provider, one of them recommended, all of them allowed', () => {
    for (const provider of ['anthropic', 'openai'] as const) {
      const choices = PROVIDER_MODELS[provider].choices;
      expect(choices).toHaveLength(2);
      expect(choices.filter((choice) => choice.recommended)).toHaveLength(1);
      expect(choices[0]?.recommended).toBe(true);
      for (const choice of choices) expect(isSupportedModel(choice.id, provider)).toBe(true);
      expect(isSupportedModel(defaultModelFor(provider), provider)).toBe(true);
    }
    // Each provider's default is the thorough one it offers first.
    expect(defaultModelFor('anthropic')).toBe(PROVIDER_MODELS.anthropic.choices[0]?.id);
    expect(defaultModelFor('openai')).toBe(PROVIDER_MODELS.openai.choices[0]?.id);
  });

  /**
   * The two pairs are the same shape on purpose — the thorough tier and the
   * cheaper one — and each is named by an **explicit** id. `gpt-5.6` routes to
   * Sol today and is OpenAI's to re-point tomorrow, which would move which
   * model a home runs and what a run costs with nothing in this repository
   * changed to explain it; the alias stays priced so a hub that stored it
   * keeps working, and stays out of `choices` so nothing new picks it up.
   */
  it('pins Opus 5 / Sonnet 5 and Sol / Terra by their explicit ids', () => {
    expect(PROVIDER_MODELS.anthropic.choices.map((choice) => choice.id)).toEqual([
      'claude-opus-5',
      'claude-sonnet-5',
    ]);
    expect(PROVIDER_MODELS.openai.choices.map((choice) => choice.id)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
    ]);
    expect(defaultModelFor('openai')).toBe('gpt-5.6-sol');

    // Accepted, priced, and never offered.
    expect(isSupportedModel('gpt-5.6', 'openai')).toBe(true);
    expect(PROVIDER_MODELS.openai.choices.some((choice) => choice.id === 'gpt-5.6')).toBe(false);
    expect(estimateCostUsd('gpt-5.6', { input_tokens: 1_000_000 })).toBe(
      estimateCostUsd('gpt-5.6-sol', { input_tokens: 1_000_000 }),
    );

    // Luna is cheap and is not on the list: this job is reasoning-heavy and
    // runs a handful of times in a hub's life.
    expect(isSupportedModel('gpt-5.6-luna', 'openai')).toBe(false);
  });

  it('keeps the two allowlists apart, so a model cannot be sent to the wrong API', () => {
    expect(isSupportedModel('claude-opus-5', 'openai')).toBe(false);
    expect(isSupportedModel('gpt-5.6', 'anthropic')).toBe(false);
    expect(isSupportedModel('gpt-5.6', 'openai')).toBe(true);
  });

  /**
   * Sonnet 5 was priced at Sonnet 4.6's rate for a while, which is not a
   * cosmetic error: `estimateCostUsd` feeds the per-run budget cap, so every
   * run on it was billed 50% high against a $2 ceiling and stopped early.
   */
  it('prices Sonnet 5 at its own rate rather than Sonnet 4.6’s', () => {
    const sonnet5 = estimateCostUsd('claude-sonnet-5', { input_tokens: 1_000_000, output_tokens: 1_000_000 });
    const sonnet46 = estimateCostUsd('claude-sonnet-4-6', { input_tokens: 1_000_000, output_tokens: 1_000_000 });
    expect(sonnet5).toBeCloseTo(12, 5);
    expect(sonnet46).toBeCloseTo(18, 5);
  });

  it('prices a run from its token usage', () => {
    // 1M input + 1M output on Opus-tier list prices.
    const cost = estimateCostUsd('claude-opus-5', { input_tokens: 1_000_000, output_tokens: 1_000_000 });
    expect(cost).toBeCloseTo(30, 5);
  });

  it('bills cache reads at a tenth of the input rate', () => {
    const cached = estimateCostUsd('claude-opus-5', { cache_read_input_tokens: 1_000_000 });
    expect(cached).toBeCloseTo(0.5, 5);
  });

  it('counts web searches, which are billed per request', () => {
    expect(estimateCostUsd('claude-opus-5', { webSearchRequests: 100 })).toBeCloseTo(1, 5);
  });

  it('falls back to the most expensive tier for an unknown model, so the cap trips early', () => {
    const unknown = estimateCostUsd('claude-something-new', { output_tokens: 1_000_000 });
    const cheapest = estimateCostUsd('claude-sonnet-5', { output_tokens: 1_000_000 });
    expect(unknown).toBeGreaterThanOrEqual(cheapest);
  });
});

// ── The submit_mapping tool ───────────────────────────────────────────────

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

describe('submitMappingTool', () => {
  it('publishes the live descriptor schema as its input schema', () => {
    const tool = submitMappingTool();
    expect(tool.name).toBe('submit_mapping');
    expect(tool.input_schema.type).toBe('object');
    // No `$schema` — that is metadata about the document, not the tool input.
    expect(tool.input_schema).not.toHaveProperty('$schema');
    // The whitelisted state paths ride along inside the schema, which is why
    // the agent no longer needs a separate reference file.
    expect(JSON.stringify(tool.input_schema)).toContain('sensors.humidityCenti');
  });
});

describe('evaluateSubmission', () => {
  it('returns schema errors and captures the invalid candidate', () => {
    const capture = { submitted: null as unknown };
    const outcome = evaluateSubmission({ version: 1, endpoints: [] }, capture);
    expect(outcome.accepted).toBe(false);
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain('schema errors');
    expect(capture.submitted).toEqual({ version: 1, endpoints: [] });
  });

  it('returns sanity problems for schema-valid but incoherent descriptors', () => {
    const capture = { submitted: null as unknown };
    const incoherent = {
      ...validDescriptor,
      endpoints: [{ ...validDescriptor.endpoints[0]!, primary: 'temperature' }],
    };
    const outcome = evaluateSubmission(incoherent, capture);
    expect(outcome.accepted).toBe(false);
    expect(outcome.text).toContain('sanity checks');
  });

  it('accepts a valid descriptor and captures the parsed data', () => {
    const capture = { submitted: null as unknown };
    const outcome = evaluateSubmission(validDescriptor, capture);
    expect(outcome.accepted).toBe(true);
    expect(outcome.isError).toBe(false);
    expect(capture.submitted).toEqual({
      ...validDescriptor,
      endpoints: [{ ...validDescriptor.endpoints[0]!, customFields: [] }],
    });
  });
});

// ── The research brief ────────────────────────────────────────────────────

const probe: Z2mDevice = {
  ieee_address: '0x00124b0022000001',
  friendly_name: 'Mystery probe',
  supported: true,
  definition: {
    vendor: 'Tuya',
    model: 'TS0601_soil',
    description: 'Soil sensor',
    exposes: [{ type: 'numeric', name: 'soil_moisture', property: 'soil_moisture', access: 1, unit: '%' }],
  },
};

describe('zigbee2mqttDevicePage', () => {
  it('names the page after the model, which is how those pages are generated', () => {
    expect(zigbee2mqttDevicePage('LLKZMK12LM')).toBe('https://www.zigbee2mqtt.io/devices/LLKZMK12LM.html');
  });

  it('escapes model strings that would break the path', () => {
    expect(zigbee2mqttDevicePage('ABC/DEF')).toBe('https://www.zigbee2mqtt.io/devices/ABC%2FDEF.html');
  });

  it('has nothing to offer when the model is unknown', () => {
    expect(zigbee2mqttDevicePage(null)).toBeNull();
    expect(zigbee2mqttDevicePage('  ')).toBeNull();
  });
});

describe('buildMappingUserPrompt', () => {
  it('carries everything the old file workspace did', () => {
    const prompt = buildMappingUserPrompt(probe, mapExposes(probe), [{ soil_moisture: 41 }]);

    // device.json
    expect(prompt).toContain('Tuya');
    expect(prompt).toContain('TS0601_soil');
    expect(prompt).toContain('soil_moisture');
    // samples.json
    expect(prompt).toContain('{"soil_moisture":41}');
    // static-mapping.json
    expect(prompt).toContain('uncovered');
    expect(prompt).toContain('genericCustomFields');
  });

  it('names the device page so web_fetch can reach it at all', () => {
    // The server-side fetch tool only fetches URLs already in the
    // conversation, so an unmentioned page is unreachable however well the
    // model guesses.
    const prompt = buildMappingUserPrompt(probe, mapExposes(probe), []);
    expect(prompt).toContain('https://www.zigbee2mqtt.io/devices/TS0601_soil.html');
  });

  it('bounds how many payloads it inlines', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ soil_moisture: i }));
    const prompt = buildMappingUserPrompt(probe, mapExposes(probe), many);
    expect(prompt).toContain('{"soil_moisture":11}');
    expect(prompt).not.toContain('{"soil_moisture":0}');
  });
});

// ── The agent loop ────────────────────────────────────────────────────────

const log = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Logger;

interface FakeReply {
  stop_reason: string;
  content: unknown[];
  usage?: Record<string, unknown>;
}

/**
 * Replies the mocked API hands back, and a snapshot of the request body it
 * received each time. Snapshots matter: the loop appends to one `messages`
 * array across turns, so inspecting the live object after the run would only
 * ever show its final state.
 */
const replies: FakeReply[] = [];
const sent: Record<string, any>[] = [];

function reply(partial: FakeReply): FakeReply {
  return { usage: { input_tokens: 100, output_tokens: 100 }, ...partial };
}

function submitCall(input: unknown, id = 'toolu_1') {
  return { type: 'tool_use', id, name: 'submit_mapping', input };
}

function queue(...next: FakeReply[]): void {
  replies.push(...next);
}

describe('the mapping agent loop', () => {
  beforeEach(() => {
    createMock.mockReset();
    replies.length = 0;
    sent.length = 0;
    createMock.mockImplementation(async (params: unknown) => {
      sent.push(JSON.parse(JSON.stringify(params)) as Record<string, any>);
      // The last queued reply repeats, so a test can either script a sequence
      // or pin one answer and let the loop run into a guardrail.
      return replies.length > 1 ? replies.shift()! : replies[0]!;
    });
  });

  const agent = () => createMappingAgent({ secret: 'sk-ant-api03-test' }, null, log);

  it('returns the descriptor the model submitted', async () => {
    queue(reply({ stop_reason: 'tool_use', content: [submitCall(validDescriptor)] }));
    const result = await agent().generate('system', 'user');
    expect(result).toMatchObject({ version: 1 });
    expect(sent).toHaveLength(1);
  });

  it('sends the research tools and caches the system prompt', async () => {
    queue(reply({ stop_reason: 'tool_use', content: [submitCall(validDescriptor)] }));
    await agent().generate('system prompt', 'user');

    const toolTypes = sent[0]!.tools.map((tool: Record<string, unknown>) => tool.type ?? tool.name);
    expect(toolTypes).toEqual(['web_search_20260209', 'web_fetch_20260209', 'submit_mapping']);
    expect(sent[0]!.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(sent[0]!.model).toBe(DEFAULT_MODEL);
  });

  it('caches the conversation tail as well as the system prefix', async () => {
    queue(reply({ stop_reason: 'tool_use', content: [submitCall(validDescriptor)] }));
    await agent().generate('system prompt', 'user');

    // Two breakpoints: the explicit one on the shared prefix, and the
    // top-level field, which places a second on the last block of `messages`.
    // Without it every turn re-sends the whole of the model's research at
    // full input price, and this loop runs for up to AGENT_MAX_TURNS turns.
    expect(sent[0]!.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('streams, because MAX_OUTPUT_TOKENS is past what a plain request may ask for', async () => {
    // The regression this file exists to stop coming back: at these token
    // counts the SDK refuses a non-streaming call before it reaches the
    // network, and the hub read that refusal as a transient *network* failure
    // — so device recognition armed its backoff gate and retried for ever,
    // with the real cause hidden behind the retry timer.
    expect(MAX_OUTPUT_TOKENS).toBeGreaterThan(nonStreamingCeiling);

    queue(reply({ stop_reason: 'tool_use', content: [submitCall(validDescriptor)] }));
    await expect(agent().generate('system', 'user')).resolves.toMatchObject({ version: 1 });
  });

  it('resumes a paused turn without inserting a user message', async () => {
    queue(
      reply({ stop_reason: 'pause_turn', content: [{ type: 'text', text: 'searching' }] }),
      reply({ stop_reason: 'tool_use', content: [submitCall(validDescriptor)] }),
    );
    const result = await agent().generate('system', 'user');
    expect(result).toMatchObject({ version: 1 });

    // The resumed request must end on the assistant turn — the API picks up
    // from the trailing server_tool_use block, and a "continue" breaks it.
    expect(sent[1]!.messages.at(-1).role).toBe('assistant');
  });

  it('hands validation errors back so the model can resubmit', async () => {
    queue(
      reply({ stop_reason: 'tool_use', content: [submitCall({ version: 1, endpoints: [] })] }),
      reply({ stop_reason: 'tool_use', content: [submitCall(validDescriptor, 'toolu_2')] }),
    );
    const result = await agent().generate('system', 'user');
    expect(result).toMatchObject({ version: 1 });

    const toolResult = sent[1]!.messages.at(-1).content[0];
    expect(toolResult.type).toBe('tool_result');
    expect(toolResult.is_error).toBe(true);
    expect(toolResult.content).toContain('schema errors');
  });

  it('keeps the last invalid submission so the mapper can cache the rejection', async () => {
    queue(reply({ stop_reason: 'tool_use', content: [submitCall({ version: 1, endpoints: [] })] }));
    const result = await agent().generate('system', 'user');
    expect(result).toEqual({ version: 1, endpoints: [] });
  });

  it('nudges a prose answer, then gives up rather than burning the turn budget', async () => {
    queue(reply({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'I think…' }] }));
    await expect(agent().generate('system', 'user')).rejects.toThrow(/without calling submit_mapping/);
    // The first turn plus two reminders — not all 40.
    expect(sent).toHaveLength(3);
    expect(sent[1]!.messages.at(-1).content).toContain('submit_mapping');
  });

  it('stops at the turn cap', async () => {
    queue(reply({ stop_reason: 'tool_use', content: [submitCall({ nonsense: true }, 'toolu_x')] }));
    await agent().generate('system', 'user');
    expect(sent).toHaveLength(AGENT_MAX_TURNS);
  });

  it('stops when the run has spent its cost cap', async () => {
    // ~$0.55 of Opus-tier output per turn, so the $2 cap lands well before
    // the turn cap does.
    queue(
      reply({
        stop_reason: 'tool_use',
        content: [submitCall({ nonsense: true }, 'toolu_x')],
        usage: { input_tokens: 1000, output_tokens: 22_000 },
      }),
    );
    await agent().generate('system', 'user');
    expect(sent.length).toBeLessThan(AGENT_MAX_TURNS);
    expect(sent.length).toBeGreaterThan(1);
  });

  it('refuses a model that cannot drive the research tools', async () => {
    const wrong = createMappingAgent({ secret: 'sk-ant-api03-test' }, 'claude-haiku-4-5', log);
    await expect(wrong.generate('system', 'user')).rejects.toThrow(/cannot run the mapping agent/);
    expect(sent).toHaveLength(0);
  });

  it('reports run statistics to the mapper', async () => {
    queue(reply({ stop_reason: 'tool_use', content: [submitCall(validDescriptor)] }));
    const stats: unknown[] = [];
    await agent().generate('system', 'user', { onStats: (s) => stats.push(s) });
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ numTurns: 1 });
    expect((stats[0] as { costUsd: number }).costUsd).toBeGreaterThan(0);
  });

  // How the loop turns an API failure into an AiUnavailableError is covered by
  // the `classifyApiError` cases above rather than here: a mocked API that
  // rejects makes Vitest report the rejection as a test failure even when the
  // loop catches it and throws its own error, which would mask the assertion.
});
