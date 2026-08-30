import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';

/**
 * The model a run is *given*, which is a different question from the model a
 * hub has stored and from the model it reports.
 *
 * `effectiveModel` reads a stored setting as a preference among what is still
 * offered, so retiring a model moves the homes that had chosen it. Every
 * surface that *reports* which model answered went through it — `GET
 * /settings/ai`, `ai_runs.modelId`, `status.lastRun.model`, the backoff gate's
 * credential id — and the one place that picks the model to actually *run*
 * did not, which is the only place where being wrong costs anything. So a hub
 * set to a retired model kept running it while every screen and every recorded
 * row said otherwise: silently, because `isSupportedModel` is deliberately the
 * broad price-table allowlist (a stored setting must never start 400-ing) and
 * let it straight through.
 */

type AgentFactory = (auth: { secret: string }, model: string | null, log: unknown) => {
  generate: () => Promise<unknown>;
};
const stub: AgentFactory = () => ({ generate: async () => ({}) });
const createMappingAgent = vi.fn(stub);
const createOpenAiMappingAgent = vi.fn(stub);

/** Every model this run was handed — `resolveProvider` is consulted more than
 *  once per run, and what matters is that no call names the retired id. */
const modelsGiven = (spy: typeof createMappingAgent) => spy.mock.calls.map((call) => call[1]);

vi.mock('../src/ai/agent.js', () => ({ createMappingAgent }));
vi.mock('../src/ai/openai-agent.js', () => ({ createOpenAiMappingAgent }));

const { SettingsService } = await import('../src/core/settings.js');
const { AiDeviceMapper } = await import('../src/ai/mapper.js');
const { defaultModelFor } = await import('../src/ai/models.js');
const { openTestDb, resetDb } = await import('./helpers/db.js');
const { mapExposes } = await import('../src/adapters/zigbee/exposes-mapper.js');
type Z2mDevice = import('../src/adapters/zigbee/exposes-mapper.js').Z2mDevice;

const handle = await openTestDb();
const log = pino({ level: 'silent' });

/** An address, a published schema, and one property nothing static can place —
 *  which is what makes this device ask for a run at all. */
const lamp = {
  ieee_address: '0x00158d0001abcdef',
  friendly_name: 'porch lamp',
  definition: {
    vendor: 'Acme',
    model: 'AC-LAMP-1',
    exposes: [
      {
        type: 'light',
        features: [
          { type: 'binary', name: 'state', property: 'state', access: 7, value_on: 'ON', value_off: 'OFF' },
        ],
      },
      { type: 'composite', name: 'mystery', property: 'mystery', access: 1, features: [] },
    ],
  },
} as unknown as Z2mDevice;

describe.skipIf(!handle)('which model a run is given', () => {
  const db = handle?.db!;
  let settings: InstanceType<typeof SettingsService>;

  beforeEach(async () => {
    await resetDb(db);
    createMappingAgent.mockClear();
    createOpenAiMappingAgent.mockClear();
    settings = new SettingsService(db, Buffer.alloc(32).toString('base64'));
  });

  afterAll(async () => {
    await handle?.close();
  });

  it('runs the model the hub offers, not a retired one it still has stored', async () => {
    await settings.setAiSettings({ model: 'claude-sonnet-5', apiKey: 'sk-ant-api-key-0000' });
    // The route accepts a retired id rather than 400-ing an older app, so a
    // hub really can hold one — this is that hub.
    expect((await settings.getAiSettings()).anthropic.model).toBe('claude-sonnet-5');

    const mapper = new AiDeviceMapper(db, settings, log);
    await mapper.requestMapping(lamp, mapExposes(lamp), { force: true });

    expect(modelsGiven(createMappingAgent).length).toBeGreaterThan(0);
    expect(new Set(modelsGiven(createMappingAgent))).toEqual(
      new Set([defaultModelFor('anthropic')]),
    );
    expect(modelsGiven(createMappingAgent)).not.toContain('claude-sonnet-5');
  });

  it('does the same for the other provider', async () => {
    await settings.setAiKey('openai', 'sk-openai-key-0000');
    await settings.setAiModel('gpt-5.6-terra', 'openai');
    const mapper = new AiDeviceMapper(db, settings, log);
    await mapper.requestMapping(lamp, mapExposes(lamp), { force: true });

    expect(new Set(modelsGiven(createOpenAiMappingAgent))).toEqual(
      new Set([defaultModelFor('openai')]),
    );
  });

  it('leaves a model that is still offered alone', async () => {
    await settings.setAiSettings({ model: 'claude-opus-5', apiKey: 'sk-ant-api-key-0000' });
    const mapper = new AiDeviceMapper(db, settings, log);
    await mapper.requestMapping(lamp, mapExposes(lamp), { force: true });

    expect(new Set(modelsGiven(createMappingAgent))).toEqual(new Set(['claude-opus-5']));
  });
});
