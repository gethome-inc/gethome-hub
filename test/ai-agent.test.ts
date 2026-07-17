import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createSubmitMappingTool, type SubmitCapture } from '../src/ai/agent.js';
import { buildAgentContext, ensureAgentHome } from '../src/ai/context.js';
import { classifyAgentFailure, parseResetHint } from '../src/ai/errors.js';
import type { MappingDescriptor } from '../src/ai/descriptor.js';
import type { Z2mDevice } from '../src/adapters/zigbee/exposes-mapper.js';
import { mapExposes } from '../src/adapters/zigbee/exposes-mapper.js';

// ── Failure classification ────────────────────────────────────────────────

describe('classifyAgentFailure', () => {
  it('recognizes subscription usage limits (with reset hints)', () => {
    // Real-world strings the Claude Code runtime emits.
    const session = classifyAgentFailure("You've hit your session limit · resets 11pm (UTC)");
    expect(session?.kind).toBe('usage_limit');
    expect(session?.resetAt).toBeInstanceOf(Date);

    const epoch = classifyAgentFailure('Claude AI usage limit reached|1752710400');
    expect(epoch?.kind).toBe('usage_limit');
    expect(epoch?.resetAt?.getTime()).toBe(1752710400 * 1000);

    expect(classifyAgentFailure('Weekly limit reached for Claude')?.kind).toBe('usage_limit');
  });

  it('recognizes API rate limits, overload, auth, and billing failures', () => {
    expect(classifyAgentFailure('API Error: 429 {"type":"rate_limit_error"}')?.kind).toBe('rate_limited');
    expect(classifyAgentFailure('Too many requests, slow down')?.kind).toBe('rate_limited');
    expect(classifyAgentFailure('API Error: 529 {"type":"overloaded_error"}')?.kind).toBe('overloaded');
    expect(classifyAgentFailure('401 {"type":"authentication_error","message":"invalid x-api-key"}')?.kind).toBe(
      'auth_failed',
    );
    expect(classifyAgentFailure('OAuth token has expired. Please run /login.')?.kind).toBe('auth_failed');
    expect(classifyAgentFailure('Your credit balance is too low to access the API')?.kind).toBe('billing');
    expect(classifyAgentFailure('fetch failed: getaddrinfo ENOTFOUND api.anthropic.com')?.kind).toBe('network');
  });

  it('returns null for text that is not an availability problem', () => {
    expect(classifyAgentFailure('the descriptor was missing an endpoint')).toBeNull();
    expect(classifyAgentFailure('error_max_turns')).toBeNull();
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

// ── The submit_mapping tool ───────────────────────────────────────────────

const validDescriptor: MappingDescriptor = {
  version: 1,
  endpoints: [
    {
      endpointId: 1,
      deviceKind: 'sensor',
      capabilities: ['humidity'],
      primary: 'humidity',
      stateRules: [{ property: 'soil_moisture', to: 'sensors.humidityCenti', transform: { kind: 'multiply', factor: 100 } }],
      commandRules: [],
    },
  ],
};

describe('submit_mapping tool', () => {
  it('returns schema errors and captures the invalid candidate', async () => {
    const capture: SubmitCapture = { submitted: null };
    const toolDef = createSubmitMappingTool(capture);
    const result = await toolDef.handler({ version: 1, endpoints: [] } as never, {});
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('schema errors');
    expect(capture.submitted).toEqual({ version: 1, endpoints: [] });
  });

  it('returns sanity problems for schema-valid but incoherent descriptors', async () => {
    const capture: SubmitCapture = { submitted: null };
    const toolDef = createSubmitMappingTool(capture);
    const incoherent = {
      ...validDescriptor,
      endpoints: [{ ...validDescriptor.endpoints[0]!, primary: 'temperature' }],
    };
    const result = await toolDef.handler(incoherent as never, {});
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('sanity checks');
  });

  it('accepts a valid descriptor and captures the parsed data', async () => {
    const capture: SubmitCapture = { submitted: null };
    const toolDef = createSubmitMappingTool(capture);
    const result = await toolDef.handler(validDescriptor as never, {});
    expect(result.isError).toBeUndefined();
    expect(JSON.stringify(result.content)).toContain('accepted');
    // The capture holds the *parsed* descriptor — schema defaults applied.
    expect(capture.submitted).toEqual({
      ...validDescriptor,
      endpoints: [{ ...validDescriptor.endpoints[0]!, customFields: [] }],
    });
  });
});

// ── The research workspace ────────────────────────────────────────────────

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

describe('buildAgentContext', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'gethome-agent-ctx-'));

  afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

  it('writes the research files and cleans up after itself', () => {
    const context = buildAgentContext(dataDir, 'abcdef0123456789', probe, mapExposes(probe), [
      { soil_moisture: 41 },
    ]);

    const device = JSON.parse(readFileSync(path.join(context.dir, 'device.json'), 'utf8')) as Record<string, unknown>;
    expect(device.vendor).toBe('Tuya');
    expect(device.model).toBe('TS0601_soil');

    const samples = JSON.parse(readFileSync(path.join(context.dir, 'samples.json'), 'utf8')) as unknown[];
    expect(samples).toEqual([{ soil_moisture: 41 }]);

    const staticMapping = JSON.parse(
      readFileSync(path.join(context.dir, 'static-mapping.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(Array.isArray(staticMapping.endpoints)).toBe(true);

    const reference = readFileSync(path.join(context.dir, 'schema-reference.md'), 'utf8');
    expect(reference).toContain('MappingDescriptor');
    expect(reference).toContain('sensors.humidityCenti');

    context.cleanup();
    expect(existsSync(context.dir)).toBe(false);
  });

  it('omits static-mapping.json when there is no static profile', () => {
    const context = buildAgentContext(dataDir, 'ffff000011112222', probe, null, []);
    expect(existsSync(path.join(context.dir, 'device.json'))).toBe(true);
    expect(existsSync(path.join(context.dir, 'static-mapping.json'))).toBe(false);
    context.cleanup();
  });
});

describe('ensureAgentHome', () => {
  it('creates a stable claude-agent home under the data dir', () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'gethome-agent-home-'));
    try {
      const home = ensureAgentHome(dataDir);
      expect(home).toBe(path.resolve(dataDir, 'claude-agent'));
      expect(existsSync(home)).toBe(true);
      expect(ensureAgentHome(dataDir)).toBe(home);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
