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
const { DECISION_MODEL } = await import('../src/ai/decide/decider.js');
const { openTestDb, resetDb } = await import('./helpers/db.js');
const { mapExposes } = await import('../src/adapters/zigbee/exposes-mapper.js');
type Z2mDevice = import('../src/adapters/zigbee/exposes-mapper.js').Z2mDevice;

const handle = await openTestDb();
const log = pino({ level: 'silent' });

// **Closed at file scope, not inside a suite.** The handle is shared by every
// describe below, so a suite that closed it on its own way out left the ones
// after it talking to a database that had gone.
afterAll(async () => {
  await handle?.close();
});

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
   * `AGENT_MODELS` for a conversation — and `modelLabel` read only the
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

/**
 * A decision model is not a provider, and the hub has to keep behaving as if
 * it had no key at all everywhere a *generative* one is meant.
 *
 * This suite already owns this class of bug — a setting that reports one thing
 * and runs another — which is why the cases belong here rather than in a file
 * of their own.
 */
describe.skipIf(!handle)('a hub that holds only a decision key', () => {
  const db = handle?.db!;
  let settings: InstanceType<typeof SettingsService>;

  beforeEach(async () => {
    await resetDb(db);
    settings = new SettingsService(db, Buffer.alloc(32).toString('base64'));
  });

  it('is still a hub with no AI key', async () => {
    // The flat `hasKey` means "can an agent run at all". If a decision key
    // made it true, `lazy.ts` would build a mapper and `openConversation`
    // would pass its own `ai_not_configured` check and fail at the provider.
    await settings.setAiKey('typesafe', 'ts-some-key-value');
    const ai = await settings.getAiSettings();
    expect(ai.decision.hasKey).toBe(true);
    expect(ai.hasKey).toBe(false);
    expect(ai.provider).toBeNull();
    expect(ai.assistant.provider).toBeNull();
    expect(ai.automations.provider).toBeNull();
  });

  it('never makes recognition a choice', async () => {
    // `mappingChoosable` is "there are two generative keys and somebody has to
    // pick" — a third slot that cannot read an exposes tree is not a choice.
    await settings.setAiKey('typesafe', 'ts-some-key-value');
    await settings.setAiKey('anthropic', 'sk-ant-api-key-0000');
    const ai = await settings.getAiSettings();
    expect(ai.mappingChoosable).toBe(false);
  });

  it('reports the model it will run, which nobody may change', async () => {
    // Pinned in the build because the thresholds are calibrated against it,
    // and calibration does not transfer.
    const ai = await settings.getAiSettings();
    expect(ai.decision.model).toBe(DECISION_MODEL);
  });

  it('is on unless the owner has said otherwise, and forgetting the key is a different act', async () => {
    await settings.setAiKey('typesafe', 'ts-some-key-value');
    expect((await settings.getAiSettings()).decision.enabled).toBe(true);

    await settings.setDecisionsEnabled(false);
    const paused = await settings.getAiSettings();
    // Switched off, with the key still there — the two have very different
    // costs to undo, which is `ai_enabled`'s own argument.
    expect(paused.decision.enabled).toBe(false);
    expect(paused.decision.hasKey).toBe(true);
  });

  it('forgets one slot without touching the others', async () => {
    await settings.setAiKey('anthropic', 'sk-ant-api-key-0000');
    await settings.setAiKey('typesafe', 'ts-some-key-value');
    await settings.clearAiCredential('typesafe');
    const ai = await settings.getAiSettings();
    expect(ai.decision.hasKey).toBe(false);
    expect(ai.anthropic.hasKey).toBe(true);
  });

  it('is cleared along with everything else', async () => {
    await settings.setAiKey('typesafe', 'ts-some-key-value');
    await settings.setDecisionsEnabled(false);
    await settings.clearAiSettings();
    const ai = await settings.getAiSettings();
    expect(ai.decision.hasKey).toBe(false);
    // Back to the default rather than a stale `false`, the reason
    // `clearAiSettings` already unsets `ai_enabled`.
    expect(ai.decision.enabled).toBe(true);
  });
});

/**
 * A vendor bought through the gateway.
 *
 * The route decides which key a vendor is asked with — its own, or the
 * gateway's — and *only* the route: a gateway key saved for Jev must not make
 * Claude reachable on a home that never moved Claude onto it, and a home that
 * holds both an OpenAI key and a gateway routed for OpenAI has said which one
 * it wants spent.
 */
describe.skipIf(!handle)('a vendor bought through the gateway', () => {
  const db = handle?.db!;
  let settings: InstanceType<typeof SettingsService>;

  beforeEach(async () => {
    await resetDb(db);
    createMappingAgent.mockClear();
    createOpenAiMappingAgent.mockClear();
    settings = new SettingsService(db, Buffer.alloc(32).toString('base64'));
  });

  it('reaches nothing until a vendor is moved onto it', async () => {
    await settings.setAiKey('vercel', 'vck_gateway_key_0000');
    const ai = await settings.getAiSettings();
    expect(ai.gateway.hasKey).toBe(true);
    // Still a hub with no AI: nothing is routed, so no vendor has a credential
    // on its route — `lazy.ts` must not build a mapper over this.
    expect(ai.hasKey).toBe(false);
    expect(ai.provider).toBeNull();
    expect(ai.assistant.provider).toBeNull();
    expect(ai.decision.usable).toBe(false);
    expect(await settings.aiConnection('openai')).toBeNull();
  });

  it('asks a routed vendor on the gateway key, even with its own key beside it', async () => {
    await settings.setAiKey('openai', 'sk-proj-own-key-0000');
    await settings.setAiKey('vercel', 'vck_gateway_key_0000');
    expect(await settings.aiConnection('openai')).toEqual({
      secret: 'sk-proj-own-key-0000',
      route: 'direct',
    });

    await settings.setAiRoute('openai', 'vercel');
    expect(await settings.aiConnection('openai')).toEqual({
      secret: 'vck_gateway_key_0000',
      route: 'vercel',
    });

    // And the mapper is handed that pair, which is what puts the request on
    // the gateway's address with the gateway's spelling of the same model.
    const mapper = new AiDeviceMapper(db, settings, log);
    await mapper.requestMapping(lamp, mapExposes(lamp), { force: true });
    expect(createOpenAiMappingAgent.mock.calls[0]?.[0]).toEqual({
      secret: 'vck_gateway_key_0000',
      route: 'vercel',
    });
    // The model is the canonical id: only the wire spells it the gateway's way.
    expect(modelsGiven(createOpenAiMappingAgent)[0]).toBe(defaultModelFor('openai'));
  });

  it('lets an agent run on a vendor that has no key of its own', async () => {
    await settings.setAiKey('vercel', 'vck_gateway_key_0000');
    await settings.setAiRoute('anthropic', 'vercel');
    const ai = await settings.getAiSettings();
    expect(ai.hasKey).toBe(true);
    expect(ai.anthropic).toMatchObject({ hasKey: false, route: 'vercel', usable: true });
    expect(ai.assistant.provider).toBe('anthropic');
    expect(ai.automations.provider).toBe('anthropic');
    expect(ai.provider).toBe('anthropic');
  });

  it('does not let a Claude subscription token stand in the way of the gateway', async () => {
    // The token is only a problem when it is what Claude would be asked with.
    // On the gateway it is a row nobody reads, and reporting it then would
    // tell an app the home cannot talk to a model it is talking to.
    await settings.setAiKey('anthropic', 'legacy-subscription-token');
    await settings.set('ai_auth_type', 'oauth_token');
    expect((await settings.getAiSettings()).legacySubscriptionToken).toBe(true);
    expect((await settings.getAiSettings()).anthropic.usable).toBe(false);

    // Saving the gateway's key is not saving an Anthropic key, so the marker
    // stays — and is simply no longer what Claude is asked with once routed.
    await settings.setAiKey('vercel', 'vck_gateway_key_0000');
    await settings.setAiRoute('anthropic', 'vercel');
    const routed = await settings.getAiSettings();
    expect(routed.legacySubscriptionToken).toBe(false);
    expect(routed.anthropic.usable).toBe(true);
    expect(routed.assistant.provider).toBe('anthropic');
  });

  it('sends every vendor it carried back to its own key when its key is forgotten', async () => {
    await settings.setAiKey('openai', 'sk-proj-own-key-0000');
    await settings.setAiKey('vercel', 'vck_gateway_key_0000');
    await settings.setAiRoute('openai', 'vercel');
    await settings.setAiRoute('typesafe', 'vercel');

    await settings.clearAiCredential('vercel');
    const ai = await settings.getAiSettings();
    expect(ai.gateway.hasKey).toBe(false);
    expect(ai.openai).toMatchObject({ route: 'direct', usable: true });
    expect(ai.decision).toMatchObject({ route: 'direct', usable: false });
    expect(await settings.aiConnection('openai')).toEqual({
      secret: 'sk-proj-own-key-0000',
      route: 'direct',
    });
  });

  it('keeps deciding through the gateway when TypeSafe’s own key goes', async () => {
    // The route says whose key buys the decisions; forgetting a key that was
    // not being used for them changes nothing about where they come from.
    await settings.setAiKey('typesafe', 'ts-own-key-0000');
    await settings.setAiKey('vercel', 'vck_gateway_key_0000');
    await settings.setAiRoute('typesafe', 'vercel');
    await settings.clearAiCredential('typesafe');
    const ai = await settings.getAiSettings();
    expect(ai.decision).toMatchObject({ hasKey: false, route: 'vercel', usable: true });
    expect(ai.decision.model).toBe('typesafe-ai/jev');
  });

  it('moves a key the first cut of the gateway left in the TypeSafe slot', async () => {
    // That cut stored a route beside the TypeSafe key, so a home buying its
    // decisions through Vercel held a Vercel key in TypeSafe's slot. After the
    // move the home decides exactly as it did — through the gateway, on the
    // same key — and the TypeSafe slot is empty, as it always really was.
    await settings.setAiKey('typesafe', 'vck_gateway_key_0000');
    await settings.set('ai_decision_route', 'vercel');

    await settings.adoptLegacyDecisionRoute();
    const ai = await settings.getAiSettings();
    expect(ai.gateway.hasKey).toBe(true);
    expect(ai.decision).toMatchObject({ hasKey: false, route: 'vercel', usable: true });
    expect(await settings.aiConnection('typesafe')).toEqual({
      secret: 'vck_gateway_key_0000',
      route: 'vercel',
    });
    expect(await settings.get('ai_decision_route')).toBeNull();

    // Once: a second boot finds nothing to do.
    await settings.adoptLegacyDecisionRoute();
    expect((await settings.getAiSettings()).decision.route).toBe('vercel');
  });

  it('leaves a TypeSafe key where it is when the first cut had it on TypeSafe', async () => {
    await settings.setAiKey('typesafe', 'ts-own-key-0000');
    await settings.set('ai_decision_route', 'typesafe');
    await settings.adoptLegacyDecisionRoute();
    const ai = await settings.getAiSettings();
    expect(ai.gateway.hasKey).toBe(false);
    expect(ai.decision).toMatchObject({ hasKey: true, route: 'direct', usable: true });
    expect(await settings.get('ai_decision_route')).toBeNull();
  });
});
