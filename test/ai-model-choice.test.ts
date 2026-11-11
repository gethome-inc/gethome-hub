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
const {
  AGENT_MODELS,
  AGENT_TIERS,
  PROVIDER_MODELS,
  agentCounterpart,
  agentTier,
  closestOnLadder,
  defaultModelFor,
  effectiveAgentModel,
  effectiveModel,
  estimateCostUsd,
  modelLabel,
} = await import('../src/ai/models.js');
const { openTestDb, resetDb } = await import('./helpers/db.js');
const { settings: settingsTable } = await import('../src/db/schema.js');
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
    // Luna is offered to the agents and never to recognition — the shape of a
    // model this list does not run, with no successor of its own to move to.
    await settings.setAiModel('gpt-6-luna', 'openai');
    const mapper = new AiDeviceMapper(db, settings, log);
    await mapper.requestMapping(lamp, mapExposes(lamp), { force: true });

    expect(new Set(modelsGiven(createOpenAiMappingAgent))).toEqual(
      new Set([defaultModelFor('openai')]),
    );
  });

  it('leaves a model that is still offered alone', async () => {
    await settings.setAiSettings({ model: 'claude-opus-5-5', apiKey: 'sk-ant-api-key-0000' });
    const mapper = new AiDeviceMapper(db, settings, log);
    await mapper.requestMapping(lamp, mapExposes(lamp), { force: true });

    expect(new Set(modelsGiven(createMappingAgent))).toEqual(new Set(['claude-opus-5-5']));
  });

  it('leaves the more thorough of Anthropic’s two alone as well', async () => {
    await settings.setAiSettings({ model: 'claude-fable-5-2', apiKey: 'sk-ant-api-key-0000' });
    const mapper = new AiDeviceMapper(db, settings, log);
    await mapper.requestMapping(lamp, mapExposes(lamp), { force: true });

    expect(new Set(modelsGiven(createMappingAgent))).toEqual(new Set(['claude-fable-5-2']));
  });

  /**
   * A home that chose Fable 5.1 chose the top rung, and keeps it: every
   * surface runs Fable 5.2, never the default a rung below, while each column
   * still says what somebody wrote in it — so the build before this one, which
   * has never heard of Fable 5.2, reads them exactly as it always did.
   */
  it('moves a home on Fable 5.1 to Fable 5.2, and leaves the columns alone', async () => {
    await settings.setAiSettings({ model: 'claude-fable-5-1', apiKey: 'sk-ant-api-key-0000' });
    await settings.setAssistantModel('claude-fable-5-1');
    await settings.setAutomationsModel('claude-fable-5-1');
    const mapper = new AiDeviceMapper(db, settings, log);
    await mapper.requestMapping(lamp, mapExposes(lamp), { force: true });

    expect(new Set(modelsGiven(createMappingAgent))).toEqual(new Set(['claude-fable-5-2']));
    const ai = await settings.getAiSettings();
    expect(effectiveModel('anthropic', ai.anthropic.model)).toBe('claude-fable-5-2');
    expect(ai.assistant).toMatchObject({ provider: 'anthropic', model: 'claude-fable-5-2' });
    expect(ai.automations).toMatchObject({ provider: 'anthropic', model: 'claude-fable-5-2' });

    const stored = new Map(
      (await db.select().from(settingsTable)).map((row) => [row.key, row.value] as const),
    );
    expect(stored.get('ai_model')).toBe('claude-fable-5-1');
    expect(stored.get('ai_assistant_model')).toBe('claude-fable-5-1');
    expect(stored.get('ai_automations_model')).toBe('claude-fable-5-1');
  });

  it('leaves the more thorough of OpenAI’s two alone as well', async () => {
    await settings.setAiKey('openai', 'sk-openai-key-0000');
    await settings.setAiModel('gpt-6-astra', 'openai');
    const mapper = new AiDeviceMapper(db, settings, log);
    await mapper.requestMapping(lamp, mapExposes(lamp), { force: true });

    expect(new Set(modelsGiven(createOpenAiMappingAgent))).toEqual(new Set(['gpt-6-astra']));
  });

  /**
   * **What updating a hub does to a home that chose a model this build
   * retired**: it runs the model that replaced it — Opus 5 → Opus 5.5, GPT-6
   * Sol → GPT-6.1 Sol — and nobody has to do anything. GPT-5.6 Terra lands on
   * GPT-6.1 Sol here as well, for a different reason: its successor is GPT-6.1
   * Terra, which recognition does not offer, so the walk runs off the end of
   * the chain and recognition's default is what runs.
   */
  it('hands a run the successor of a retired model, on either provider', async () => {
    await settings.setAiSettings({ model: 'claude-opus-5', apiKey: 'sk-ant-api-key-0000' });
    const anthropic = new AiDeviceMapper(db, settings, log);
    await anthropic.requestMapping(lamp, mapExposes(lamp), { force: true });
    expect(new Set(modelsGiven(createMappingAgent))).toEqual(new Set(['claude-opus-5-5']));

    await resetDb(db);
    settings = new SettingsService(db, Buffer.alloc(32).toString('base64'));
    await settings.setAiKey('openai', 'sk-openai-key-0000');
    await settings.setAiModel('gpt-5.6-terra', 'openai');
    const openai = new AiDeviceMapper(db, settings, log);
    await openai.requestMapping(lamp, mapExposes(lamp), { force: true });
    expect(new Set(modelsGiven(createOpenAiMappingAgent))).toEqual(new Set(['gpt-6.1-sol']));

    await resetDb(db);
    settings = new SettingsService(db, Buffer.alloc(32).toString('base64'));
    await settings.setAiKey('openai', 'sk-openai-key-0000');
    // The default until GPT-6.1 Sol: a home that never chose is on it too.
    await settings.setAiModel('gpt-6-sol', 'openai');
    const sol = new AiDeviceMapper(db, settings, log);
    await sol.requestMapping(lamp, mapExposes(lamp), { force: true });
    expect(new Set(modelsGiven(createOpenAiMappingAgent))).toEqual(new Set(['gpt-6.1-sol']));
    expect(modelsGiven(createOpenAiMappingAgent)).not.toContain('gpt-6-sol');
  });

  /**
   * **And nothing is written back**, which is the whole of why this is safe to
   * roll back. `install.sh` puts the previous build back when a new one fails
   * its health check; that build has never heard of `gpt-6.1-sol`, and an agent
   * column it reads with an unknown id falls to "the first vendor with a usable
   * key" — a home that chose OpenAI would silently move to Anthropic. The
   * column still saying what somebody chose is what keeps the older build
   * reading it exactly as it always did.
   */
  it('succeeds a retired model without rewriting the stored choice', async () => {
    await settings.setAiKey('anthropic', 'sk-ant-api-key-0000');
    await settings.setAiKey('openai', 'sk-openai-key-0000');
    await settings.setAiModel('gpt-5.6-sol', 'openai');
    await settings.setAssistantModel('gpt-5.6-terra');
    await settings.setAutomationsModel('claude-opus-5');

    const ai = await settings.getAiSettings();
    expect(effectiveModel('openai', ai.openai.model)).toBe('gpt-6.1-sol');
    expect(ai.assistant).toMatchObject({ provider: 'openai', model: 'gpt-6.1-terra' });
    expect(ai.automations).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5-5' });

    // And straight from the rows: exactly what was written, every one.
    const stored = new Map(
      (await db.select().from(settingsTable)).map((row) => [row.key, row.value] as const),
    );
    expect(stored.get('ai_openai_model')).toBe('gpt-5.6-sol');
    expect(stored.get('ai_assistant_model')).toBe('gpt-5.6-terra');
    expect(stored.get('ai_automations_model')).toBe('claude-opus-5');
  });
});

/**
 * Succession for the agents, which is key-aware where the mapper's is not.
 *
 * The vendor is the stored model's — a successor never crosses to the other
 * vendor, because the vendor was a choice somebody made (they pasted its key)
 * and the retired id was not. Only when that vendor has no usable key does the
 * hub fall back to the one that does, at that vendor's default.
 */
describe('which model an agent is given once its own is retired', () => {
  const both = { anthropic: true, openai: true };

  it('moves each retired model to its successor', () => {
    expect(effectiveAgentModel('claude-opus-5', both)).toEqual({ provider: 'anthropic', modelId: 'claude-opus-5-5' });
    expect(effectiveAgentModel('claude-sonnet-5', both)).toEqual({
      provider: 'anthropic',
      modelId: 'claude-sonnet-5-5',
    });
    expect(effectiveAgentModel('gpt-6-sol', both)).toEqual({ provider: 'openai', modelId: 'gpt-6.1-sol' });
    // Down a chain again: GPT-5.6 Sol was replaced by GPT-6 Sol, which GPT-6.1
    // Sol has replaced in turn.
    expect(effectiveAgentModel('gpt-5.6-sol', both)).toEqual({ provider: 'openai', modelId: 'gpt-6.1-sol' });
    expect(effectiveAgentModel('gpt-5.6', both)).toEqual({ provider: 'openai', modelId: 'gpt-6.1-sol' });
    // And a tier keeps its tier: GPT-5.6 Terra went to Sol only while GPT-6
    // had no Terra, and is GPT-6.1 Terra's now there is one.
    expect(effectiveAgentModel('gpt-5.6-terra', both)).toEqual({ provider: 'openai', modelId: 'gpt-6.1-terra' });
    // Down a chain: every Opus before 5 walks to 5.5 rather than stopping.
    expect(effectiveAgentModel('claude-opus-4-6', both)).toEqual({
      provider: 'anthropic',
      modelId: 'claude-opus-5-5',
    });
    // The cheaper tier keeps its tier, down its own chain: Sonnet 4.6 became
    // Sonnet 5 and then Sonnet 5.5, never Opus.
    expect(effectiveAgentModel('claude-sonnet-4-6', both)).toEqual({
      provider: 'anthropic',
      modelId: 'claude-sonnet-5-5',
    });
  });

  it('leaves every model still offered exactly where it is', () => {
    for (const provider of ['anthropic', 'openai'] as const) {
      for (const choice of AGENT_MODELS[provider].choices) {
        expect(effectiveAgentModel(choice.id, both)).toEqual({ provider, modelId: choice.id });
      }
    }
  });

  it('falls back to the vendor that has a key when the successor’s has none', () => {
    // Terra's successor is OpenAI's, and this home only has Anthropic.
    expect(effectiveAgentModel('gpt-5.6-terra', { anthropic: true, openai: false })).toEqual({
      provider: 'anthropic',
      modelId: AGENT_MODELS.anthropic.default,
    });
    expect(effectiveAgentModel('claude-opus-5', { anthropic: false, openai: true })).toEqual({
      provider: 'openai',
      modelId: AGENT_MODELS.openai.default,
    });
    expect(effectiveAgentModel('claude-opus-5', { anthropic: false, openai: false })).toBeNull();
  });
});

/**
 * The table's own invariants — the ones a future edit to it could break
 * without any other test noticing.
 */
describe('the model table', () => {
  /** Every model a hub in the field may have stored, from every build so far. */
  const everShipped = {
    anthropic: [
      'claude-fable-5-2',
      'claude-fable-5-1',
      'claude-haiku-5-5',
      'claude-opus-5-5',
      'claude-opus-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-sonnet-5-5',
      'claude-sonnet-5',
      'claude-sonnet-4-6',
    ],
    openai: [
      'gpt-6-astra',
      'gpt-6.1-sol',
      'gpt-6.1-terra',
      'gpt-6-sol',
      'gpt-6-luna',
      'gpt-5.6-sol',
      'gpt-5.6',
      'gpt-5.6-terra',
    ],
  } as const;

  it('still knows, and names, every model a hub may have stored', () => {
    for (const provider of ['anthropic', 'openai'] as const) {
      for (const id of everShipped[provider]) {
        expect(modelLabel(provider, id)).not.toBe(id);
      }
    }
  });

  it('succeeds every retired model to one that is offered, on the same vendor', () => {
    for (const provider of ['anthropic', 'openai'] as const) {
      const offered = new Set(
        [...PROVIDER_MODELS[provider].choices, ...AGENT_MODELS[provider].choices].map((choice) => choice.id),
      );
      for (const id of everShipped[provider]) {
        // Whichever surface it lands on, it lands on this vendor — and on a
        // model somebody could pick today, never on another retired one.
        const agent = effectiveAgentModel(id, { anthropic: true, openai: true });
        expect(agent?.provider).toBe(provider);
        expect(offered.has(agent?.modelId ?? '')).toBe(true);
        expect(offered.has(effectiveModel(provider, id))).toBe(true);
      }
    }
  });

  it('offers every default, and recommends exactly it', () => {
    for (const table of [PROVIDER_MODELS, AGENT_MODELS]) {
      for (const provider of ['anthropic', 'openai'] as const) {
        const { default: fallback, choices } = table[provider];
        expect(choices.filter((choice) => choice.recommended).map((choice) => choice.id)).toEqual([fallback]);
      }
    }
  });
});

/**
 * The agents' line-ups read across the vendors, which is what a failed round is
 * offered on the other one (`chat/failure.ts`). A model an agent is offered
 * with no tier would be answered again on the other vendor's default whatever
 * it was — Opus 5.5 offered to a chat on GPT-6.1 Terra, at four times its
 * price, is the bug this exists for.
 */
describe('the agents’ tiers, read across the vendors', () => {
  const providers = ['anthropic', 'openai'] as const;
  const offered = (provider: (typeof providers)[number]) => AGENT_MODELS[provider].choices.map((choice) => choice.id);
  const blended = (model: string) => estimateCostUsd(model, { input_tokens: 1000, output_tokens: 1000 });

  it('places every model an agent is offered on a tier', () => {
    // The guard for a model added later: its row in MODELS needs a `tier`.
    for (const provider of providers) {
      for (const id of offered(provider)) expect(AGENT_TIERS, id).toContain(agentTier(id));
    }
  });

  it('keeps each vendor’s tiers in price order — a higher tier is never the cheaper', () => {
    for (const provider of providers) {
      for (const a of offered(provider)) {
        for (const b of offered(provider)) {
          if (AGENT_TIERS.indexOf(agentTier(a)!) < AGENT_TIERS.indexOf(agentTier(b)!)) {
            expect(blended(a), `${a} above ${b}`).toBeGreaterThan(blended(b));
          }
        }
      }
    }
  });

  it('answers each of today’s models with the other vendor’s on its tier, both ways round', () => {
    const pairs = [
      ['claude-fable-5-2', 'gpt-6-astra'],
      ['claude-opus-5-5', 'gpt-6.1-sol'],
      ['claude-sonnet-5-5', 'gpt-6.1-terra'],
      ['claude-haiku-5-5', 'gpt-6-luna'],
    ] as const;
    for (const [claude, gpt] of pairs) {
      expect(agentCounterpart(claude, 'openai')).toBe(gpt);
      expect(agentCounterpart(gpt, 'anthropic')).toBe(claude);
    }
  });

  it('never offers a model more than three times dearer or cheaper on either rate', () => {
    // The widest pairing a hub has run is 2.5× (Opus 5 against GPT-6 Sol); the
    // bug was 4×. A new model that breaks this is a decision, not a typo.
    const input = (model: string) => estimateCostUsd(model, { input_tokens: 1000 });
    const output = (model: string) => estimateCostUsd(model, { output_tokens: 1000 });
    for (const [from, to] of [['anthropic', 'openai'], ['openai', 'anthropic']] as const) {
      for (const id of offered(from)) {
        const other = agentCounterpart(id, to);
        for (const rate of [input, output]) {
          const [a, b] = [rate(id), rate(other)];
          expect(Math.max(a, b) / Math.min(a, b), `${id} → ${other}`).toBeLessThanOrEqual(3);
        }
      }
    }
  });

  describe('a line-up that does not exist yet', () => {
    const at = (id: string, tier: (typeof AGENT_TIERS)[number] | undefined, rate: number, recommended = false) => ({
      id,
      tier,
      rate,
      recommended,
    });

    it('chooses the nearer in price of two models a vendor offers on one tier', () => {
      // A vendor between versions: the old and the new both offered.
      const sol = { tier: 'main', rate: 12 } as const;
      expect(closestOnLadder(sol, [at('opus-6', 'main', 30, true), at('opus-5-5', 'main', 24)])).toBe('opus-5-5');
      // The same price: the one the vendor recommends, then the list's order.
      expect(closestOnLadder(sol, [at('opus-5-5', 'main', 24), at('opus-6', 'main', 24, true)])).toBe('opus-6');
      expect(closestOnLadder(sol, [at('opus-6', 'main', 24), at('opus-5-5', 'main', 24)])).toBe('opus-6');
    });

    it('keeps the tier ahead of the price', () => {
      // A cheaper model a tier down is not offered for an everyday one, even
      // when it is nearer the price.
      expect(closestOnLadder({ tier: 'main', rate: 12 }, [at('opus', 'main', 24), at('sonnet', 'quick', 12)])).toBe(
        'opus',
      );
    });

    it('answers from the nearest tier where the other vendor has none on this one', () => {
      const terra = { tier: 'quick', rate: 6 } as const;
      expect(closestOnLadder(terra, [at('opus', 'main', 24), at('haiku', 'lite', 0.6)])).toBe('opus');
      expect(closestOnLadder(terra, [at('opus', 'main', 60), at('haiku', 'lite', 3)])).toBe('haiku');
      expect(closestOnLadder({ tier: 'top', rate: 60 }, [at('opus', 'main', 24), at('haiku', 'lite', 0.6)])).toBe(
        'opus',
      );
    });

    it('never chooses a model nobody placed', () => {
      expect(closestOnLadder({ tier: 'main', rate: 12 }, [at('new', undefined, 12), at('haiku', 'lite', 0.6)])).toBe(
        'haiku',
      );
      expect(closestOnLadder({ tier: 'main', rate: 12 }, [at('new', undefined, 12)])).toBeUndefined();
    });
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
  it('uses the model’s own name while it is offered', () => {
    expect(modelLabel('anthropic', 'claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelLabel('openai', 'gpt-6.1-sol')).toBe('GPT-6.1 Sol');
    expect(modelLabel('openai', 'gpt-6-astra')).toBe('GPT-6 Astra');
  });

  /**
   * The bug this file was already watching for, from the direction it was not
   * watching.
   *
   * There are two vocabularies — `PROVIDER_MODELS` for recognising a device,
   * `AGENT_MODELS` for a conversation — and `modelLabel` read only the
   * first. Sonnet 5 was on the second alone, so every assistant chat that ran
   * on it reported `claude-sonnet-5` where a chat on Opus reported "Opus 5",
   * and the apps drew a raw id at the top of one conversation and a name at
   * the top of the next.
   *
   * The assertion below used to say the opposite, and it was right when it was
   * written: `claude-sonnet-5` was then priced and offered nowhere, which is
   * exactly the shape of a retired model. The assistant shipping made it an
   * offered one and nothing came back to this file — so the test went on
   * passing about a fact that had changed, which is how the bug reached a
   * screen. A genuinely retired id is used for that case now, and the premise
   * is asserted rather than assumed: Sonnet 5.5 replacing Sonnet 5 set the
   * same trap again.
   */
  it('names a model the assistant offers, though the mapper does not', () => {
    const ids = (choices: readonly { id: string }[]) => choices.map((choice) => choice.id);
    expect(ids(AGENT_MODELS.anthropic.choices)).toContain('claude-sonnet-5-5');
    expect(ids(PROVIDER_MODELS.anthropic.choices)).not.toContain('claude-sonnet-5-5');
    expect(ids(AGENT_MODELS.anthropic.choices)).toContain('claude-haiku-5-5');
    expect(ids(PROVIDER_MODELS.anthropic.choices)).not.toContain('claude-haiku-5-5');
    expect(ids(AGENT_MODELS.openai.choices)).toContain('gpt-6-luna');
    expect(ids(PROVIDER_MODELS.openai.choices)).not.toContain('gpt-6-luna');

    expect(modelLabel('anthropic', 'claude-sonnet-5-5')).toBe('Sonnet 5.5');
    expect(modelLabel('anthropic', 'claude-haiku-5-5')).toBe('Haiku 5.5');
    expect(modelLabel('openai', 'gpt-6-luna')).toBe('GPT-6 Luna');
    // Still not the mapper's to run: the two lists answer two questions, and
    // this is the one that has to keep saying no.
    expect(effectiveModel('anthropic', 'claude-sonnet-5-5')).toBe('claude-opus-5-5');
    expect(effectiveModel('anthropic', 'claude-haiku-5-5')).toBe('claude-opus-5-5');
  });

  /**
   * **A retired model keeps its name, and it is its own name — never the
   * model that replaced it.** This used to hand back the raw id, on the
   * argument that the only alternative was a second table of names nothing
   * kept honest. The name lives on the model's own row beside its price now,
   * so it is kept in step by construction — and without it, the day this
   * build retired Opus 5 and GPT-5.6 every conversation either app had ever
   * shown would have dropped from "Opus 5" to `claude-opus-5` at once.
   */
  it('names a retired model by its own name, never by its successor’s', () => {
    expect(effectiveModel('anthropic', 'claude-opus-5')).toBe('claude-opus-5-5');
    expect(modelLabel('anthropic', 'claude-opus-5')).toBe('Opus 5');
    expect(modelLabel('anthropic', 'claude-opus-4-6')).toBe('Opus 4.6');
    expect(modelLabel('openai', 'gpt-5.6-terra')).toBe('GPT-5.6 Terra');
    expect(effectiveModel('openai', 'gpt-6-sol')).toBe('gpt-6.1-sol');
    expect(modelLabel('openai', 'gpt-6-sol')).toBe('GPT-6 Sol');
    // The same for a chat on the cheaper tier: it ran on Sonnet 5, whatever
    // runs in its place now.
    expect(effectiveAgentModel('claude-sonnet-5', { anthropic: true, openai: true })?.modelId).toBe(
      'claude-sonnet-5-5',
    );
    expect(modelLabel('anthropic', 'claude-sonnet-5')).toBe('Sonnet 5');
  });

  it('hands back the raw id of a model this build never knew', () => {
    // Haiku 4.5 was never on any list — it cannot drive the research tools —
    // so a row naming it can only have come from somewhere else.
    expect(modelLabel('anthropic', 'claude-haiku-4-5')).toBe('claude-haiku-4-5');
  });

  it('does not name an Anthropic model under another provider', () => {
    // Looked up under the provider that ran it and nowhere else: the label says
    // who ran what, not merely whether the hub has ever heard of the id.
    expect(modelLabel('openai', 'claude-sonnet-5')).toBe('claude-sonnet-5');
  });

  it('survives a provider the build no longer knows', () => {
    // The column is read back as a plain string, so a provider retired
    // between the row being written and it being read must not throw.
    expect(modelLabel('mistral', 'some-model-9')).toBe('some-model-9');
  });
});
