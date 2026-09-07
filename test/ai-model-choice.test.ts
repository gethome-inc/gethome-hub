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
const { defaultModelFor, effectiveModel, modelLabel } = await import('../src/ai/models.js');
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

/**
 * The other half of the same distinction, and the one that gets it backwards.
 *
 * `effectiveModel` is about the *future* — a stored preference read against
 * what is still offered — so it moves when the list moves, and that is the
 * whole point of it. Naming a model that has already run is about the past and
 * must not move at all: a conversation from last month cost what it cost, on
 * the model it was billed for, and re-deriving that would rewrite a record.
 */
describe('naming a model that has already run', () => {
  it('uses the offered label while the model is still offered', () => {
    expect(modelLabel('anthropic', 'claude-opus-5')).toBe('Opus 5');
    expect(modelLabel('openai', 'gpt-5.6-sol')).toBe('GPT-5.6 Sol');
  });

  /**
   * The bug this file was already watching for, from the direction it was not
   * watching.
   *
   * There are two vocabularies — `PROVIDER_MODELS` for recognising a device,
   * `ASSISTANT_MODELS` for a conversation — and `modelLabel` read only the
   * first. Sonnet 5 is on the second alone, so every assistant chat that ran
   * on it reported `claude-sonnet-5` where a chat on Opus reported "Opus 5",
   * and the apps drew a raw id at the top of one conversation and a name at
   * the top of the next.
   *
   * The assertion below used to say the opposite, and it was right when it was
   * written: `claude-sonnet-5` was then priced and offered nowhere, which is
   * exactly the shape of a retired model. The assistant shipping made it an
   * offered one and nothing came back to this file — so the test went on
   * passing about a fact that had changed, which is how the bug reached a
   * screen. A genuinely retired id is used for that case now.
   */
  it('names a model the assistant offers, though the mapper does not', () => {
    expect(modelLabel('anthropic', 'claude-sonnet-5')).toBe('Sonnet 5');
    // Still not the mapper's to run: the two lists answer two questions, and
    // this is the one that has to keep saying no.
    expect(effectiveModel('anthropic', 'claude-sonnet-5')).toBe('claude-opus-5');
  });

  it('hands back the raw id once it is retired, and never the current default', () => {
    // Priced, so a row really can name it, and on neither list — which is
    // what a model a home ran before it was retired looks like.
    expect(effectiveModel('anthropic', 'claude-opus-4-6')).toBe('claude-opus-5');
    expect(modelLabel('anthropic', 'claude-opus-4-6')).toBe('claude-opus-4-6');
  });

  it('does not name an Anthropic model under another provider', () => {
    // The assistant's list is Anthropic-only, so it is searched under that
    // provider and nowhere else: the label says who ran what, not merely
    // whether the hub has ever heard of the id.
    expect(modelLabel('openai', 'claude-sonnet-5')).toBe('claude-sonnet-5');
  });

  it('survives a provider the build no longer knows', () => {
    // The column is read back as a plain string, so a provider retired
    // between the row being written and it being read must not throw.
    expect(modelLabel('mistral', 'some-model-9')).toBe('some-model-9');
  });
});
