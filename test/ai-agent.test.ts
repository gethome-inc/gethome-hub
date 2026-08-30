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
  effectiveModel,
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
type AgentExchange = import('../src/ai/agent-core.js').AgentExchange;

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
  it('offers exactly one model per provider, and it is that provider’s default', () => {
    for (const provider of ['anthropic', 'openai'] as const) {
      const choices = PROVIDER_MODELS[provider].choices;
      // The model is a fact the apps state, not a decision they ask for: the
      // cheaper tier was retired after Sonnet 5 submitted descriptors the tool
      // handler kept bouncing and then named `custom` as an outlet's primary,
      // which renders as no control at all.
      expect(choices).toHaveLength(1);
      expect(choices[0]?.recommended).toBe(true);
      expect(isSupportedModel(choices[0]!.id, provider)).toBe(true);
      expect(isSupportedModel(defaultModelFor(provider), provider)).toBe(true);
      expect(defaultModelFor(provider)).toBe(choices[0]?.id);
    }
  });

  /**
   * Each is named by an **explicit** id. `gpt-5.6` routes to Sol today and is
   * OpenAI's to re-point tomorrow, which would move which model a home runs
   * and what a run costs with nothing in this repository changed to explain
   * it; the alias stays priced so a hub that stored it keeps working, and
   * stays out of `choices` so nothing new picks it up.
   */
  it('pins Opus 5 and Sol by their explicit ids', () => {
    expect(PROVIDER_MODELS.anthropic.choices.map((choice) => choice.id)).toEqual(['claude-opus-5']);
    expect(PROVIDER_MODELS.openai.choices.map((choice) => choice.id)).toEqual(['gpt-5.6-sol']);
    expect(defaultModelFor('openai')).toBe('gpt-5.6-sol');

    // Retired from the picker, still priced: a run recorded months ago names
    // the model it ran on, and reading that log back has to cost it correctly.
    expect(isSupportedModel('claude-sonnet-5', 'anthropic')).toBe(true);
    expect(isSupportedModel('gpt-5.6-terra', 'openai')).toBe(true);

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

  /**
   * Retiring a model is only half a decision if the homes that had chosen it
   * carry on running it — those are exactly the homes the retirement is for,
   * and nothing on any screen would have changed to say so.
   */
  it('runs a stored model only while it is still offered', () => {
    expect(effectiveModel('anthropic', 'claude-sonnet-5')).toBe('claude-opus-5');
    expect(effectiveModel('openai', 'gpt-5.6-terra')).toBe('gpt-5.6-sol');
    // The bare alias was never offered, so it was never a preference either.
    expect(effectiveModel('openai', 'gpt-5.6')).toBe('gpt-5.6-sol');

    // A model still on the list is still honoured, and so is silence.
    expect(effectiveModel('anthropic', 'claude-opus-5')).toBe('claude-opus-5');
    expect(effectiveModel('anthropic', null)).toBe('claude-opus-5');
    expect(effectiveModel('anthropic', undefined)).toBe('claude-opus-5');
    // Nothing a stranger could put in the column becomes a model either.
    expect(effectiveModel('anthropic', 'gpt-5.6-sol')).toBe('claude-opus-5');
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

  /**
   * A plug layers 1 and 2 place completely: a typed switch, typed power, and
   * a generic field for every setting. `uncovered` is empty, so there is
   * genuinely nothing for the agent to do — and an owner pressing "Work it
   * out again" starts a run on it anyway.
   */
  const plug: Z2mDevice = {
    ieee_address: '0x54ef44100047c1bf',
    friendly_name: 'Light TV',
    supported: true,
    definition: {
      vendor: 'Aqara',
      model: 'SP-EUC01',
      description: 'Smart plug EU',
      exposes: [
        {
          type: 'switch',
          features: [
            { type: 'binary', name: 'state', property: 'state', access: 7, value_on: 'ON', value_off: 'OFF' },
          ],
        },
        { type: 'numeric', name: 'power', property: 'power', access: 1, unit: 'W' },
        { type: 'numeric', name: 'voltage', property: 'voltage', access: 1, unit: 'V' },
        { type: 'numeric', name: 'current', property: 'current', access: 1, unit: 'A' },
        { type: 'numeric', name: 'device_temperature', property: 'device_temperature', access: 1, unit: '°C' },
        { type: 'binary', name: 'button_lock', property: 'button_lock', access: 7, value_on: 'ON', value_off: 'OFF' },
      ],
    },
  };

  /**
   * The task message had no way to say "there is nothing to add", so a model
   * with nothing to add invented something — both vendors did, in the two
   * ways available: restating fields that already existed, and declaring
   * fields for diagnostics the hub hides plus a property the device has not
   * got. The empty answer has to be describable.
   */
  it('says what an empty answer looks like when nothing is uncovered', () => {
    const profile = mapExposes(plug);
    expect(profile.uncovered).toEqual([]);

    const prompt = buildMappingUserPrompt(plug, profile, []);
    expect(prompt).toMatch(/Nothing is `uncovered`/);
    expect(prompt).toMatch(/submit the hub's own mapping back unchanged/);
    // Both upgrades stay on the table — this is the branch with the least
    // work in it, not the branch with none.
    expect(prompt).toMatch(/promoting a generic field to a typed capability/);
    expect(prompt).toMatch(/none of the lists above mention/);
    // And that padding it is the wrong move, which is what both runs did.
    expect(prompt).toMatch(/must not become is padding/);
  });

  /**
   * The empty device gets it backwards. Everything this one publishes is on
   * the hidden list, so layers 1–2 place *nothing* — one endpoint, no
   * capabilities — and `uncovered` is still empty, because nothing was left
   * over to be uncovered. That is the case with the most work in it, and
   * `needsHelp`'s `staticallyEmpty` arm is what starts a run for it; being
   * told to submit the hub's own mapping back unchanged would be a request
   * for a descriptor the schema refuses.
   */
  it('does not offer the empty answer to a device with no static mapping', () => {
    const opaque: Z2mDevice = {
      ieee_address: '0x00124b0022000009',
      friendly_name: 'Opaque',
      supported: true,
      definition: {
        vendor: 'Acme',
        model: 'AC-OPAQUE',
        description: 'Publishes only what the hub hides',
        exposes: [
          { type: 'numeric', name: 'linkquality', property: 'linkquality', access: 1 },
          { type: 'numeric', name: 'voltage', property: 'voltage', access: 1, unit: 'mV' },
        ],
      },
    };
    const profile = mapExposes(opaque);
    expect(profile.uncovered).toEqual([]);
    expect(profile.endpoints.every((endpoint) => endpoint.capabilities.length === 0)).toBe(true);

    expect(buildMappingUserPrompt(opaque, profile, [])).not.toMatch(/Nothing is `uncovered`/);
  });

  /**
   * **One sentence, and no list.** An earlier version named the hidden
   * properties per device and told the model what to do about each. That was
   * the hub pre-chewing a judgement the model is better placed to make — and
   * its first wording forbade the one useful thing a run had done. What is
   * left is the fact the model cannot derive: those properties are absent
   * from all three lists *on purpose*, which is what stops `uncovered: []`
   * reading as "nothing here needs looking at".
   */
  it('says the absence is deliberate without reciting which properties', () => {
    const prompt = buildMappingUserPrompt(plug, mapExposes(plug), []);
    expect(prompt).toMatch(/telemetry the static mapper hides by default/);
    expect(prompt).toMatch(/so judge it/);
    // No per-device catalogue, and no verdict handed down about one.
    expect(prompt).not.toMatch(/hides these by default/);
    expect(prompt).not.toMatch(/- .*: voltage, current/);
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

  /**
   * Recording is a convenience; recognising the device is the job. So the
   * proof that matters is not that a round was written down — it is that
   * writing it down changed *nothing*: the same requests on the wire, byte
   * for byte, and the same descriptor out.
   */
  it('records rounds without changing a byte of what is sent or returned', async () => {
    const twoRounds = () => [
      reply({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'I think it is a plug.' }] }),
      reply({ stop_reason: 'tool_use', content: [submitCall(validDescriptor)] }),
    ];

    queue(...twoRounds());
    const quiet = await agent().generate('system prompt', 'user prompt');
    const quietRequests = sent.map((request) => JSON.stringify(request));

    sent.length = 0;
    replies.length = 0;
    queue(...twoRounds());
    const rounds: AgentExchange[] = [];
    const loud = await agent().generate('system prompt', 'user prompt', {
      onExchange: (exchange) => rounds.push(exchange),
    });

    expect(loud).toEqual(quiet);
    expect(sent.map((request) => JSON.stringify(request))).toEqual(quietRequests);
    expect(rounds.map((round) => round.seq)).toEqual([1, 2]);
    // Per round, because a run can be retried against the other vendor.
    expect(rounds.every((round) => round.provider === 'anthropic')).toBe(true);
    expect(rounds.every((round) => round.modelId === DEFAULT_MODEL)).toBe(true);
  });

  /**
   * The delta rule. The system prompt is 9.9 KB and the `submit_mapping`
   * schema 6.7 KB, and an agent loop resends both on every turn — so a round
   * that recorded its request whole would write them once per turn and make
   * the last round the size of the run.
   */
  it('carries the prompt once and then records only what each turn added', async () => {
    queue(
      reply({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'prose' }] }),
      reply({ stop_reason: 'tool_use', content: [submitCall(validDescriptor)] }),
    );
    const rounds: AgentExchange[] = [];
    await agent().generate('THE SYSTEM PROMPT', 'the device schema', {
      onExchange: (exchange) => rounds.push(exchange),
    });

    const flat = (round: AgentExchange) => JSON.stringify(round.sent);
    expect(flat(rounds[0]!)).toContain('THE SYSTEM PROMPT');
    expect(flat(rounds[0]!)).toContain('the device schema');
    // Round two adds the assistant's prose and the nudge, and nothing else.
    expect(flat(rounds[1]!)).not.toContain('THE SYSTEM PROMPT');
    expect(flat(rounds[1]!)).not.toContain('the device schema');
    expect(flat(rounds[1]!)).toContain('prose');

    // Tool *names*, never the 6.7 KB generated schema they carry.
    expect(flat(rounds[0]!)).toContain('submit_mapping');
    expect(flat(rounds[0]!)).not.toContain('input_schema');
  });

  it('keeps a refused round’s status and the provider’s own words', async () => {
    createMock.mockImplementation(async () => {
      throw Object.assign(new Error('400 {"type":"error"}'), {
        status: 400,
        error: { type: 'invalid_request_error', message: 'anthropic-workspace-id is required' },
        headers: { 'x-api-key': 'sk-ant-secret' },
      });
    });
    const rounds: AgentExchange[] = [];
    await expect(
      agent().generate('system', 'user', { onExchange: (exchange) => rounds.push(exchange) }),
    ).rejects.toThrow();

    expect(rounds).toHaveLength(1);
    expect(rounds[0]!.ok).toBe(false);
    expect(rounds[0]!.status).toBe(400);
    expect(JSON.stringify(rounds[0]!.received)).toContain('anthropic-workspace-id');
    // Bodies only, never headers — that is where a credential would be.
    expect(JSON.stringify(rounds[0])).not.toContain('sk-ant-secret');
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
