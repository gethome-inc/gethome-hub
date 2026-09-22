import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { settings } from '../db/schema.js';
import { decryptSecret, encryptSecret, type EncryptedValue } from './crypto.js';
// A real edge into the AI module, and deliberately the only one: `models.ts`
// imports `AiProvider` back with `import type`, which is erased, so there is
// no runtime cycle. It is worth it to make `getAiSettings` answer with the
// model that will *run* rather than the column — the mapper's one expensive
// bug was exactly that gap between the two.
import { effectiveAgentModel, type UsableProviders } from '../ai/models.js';
// What the decision model is called on each route, for the same reason as the
// line above: the API answers what will *run*. The table sits beside the seam
// (`decide/decider.ts`), which imports nothing — never in the vendor client —
// so reporting it never loads the client a hub without a Jev key has no use for.
import { DECISION_ROUTES } from '../ai/decide/routes.js';
// Where each vendor's requests go. Types and a parser, nothing that dials.
import { aiRouteOf, type AiConnection, type AiRoute } from '../ai/gateway.js';

/**
 * The providers the hub can hold a credential for.
 *
 * Two, and they do different jobs: Anthropic recognises unknown Zigbee devices
 * (`src/ai/`), OpenAI draws device portraits (`src/portraits/`) and can also
 * recognise devices. A home may configure either, both, or neither — which is
 * why every provider-shaped answer below is per provider rather than one
 * `hasKey` boolean with a `provider` beside it.
 */
export type AiProvider = 'anthropic' | 'openai';

export const AI_PROVIDERS = ['anthropic', 'openai'] as const satisfies readonly AiProvider[];

/**
 * Whose model answers: the two generative providers, and the decision model.
 *
 * **Wider than `AiProvider`, and that is the point.** Jev is a decision model:
 * it returns typed answers and cannot write a sentence, so it is never in
 * `PROVIDER_MODELS` or `AGENT_MODELS` and can never answer a chat — but the
 * hub holds a key for it, and a route to it (`src/ai/gateway.ts`), exactly as
 * it does for the other two. Keeping the two vocabularies apart is what stops
 * somebody's assistant being pointed at a model that cannot talk.
 *
 * **Do not widen `AiProvider` to make this shorter.** `PRICING`,
 * `PROVIDER_MODELS` and `AGENT_MODELS` in `src/ai/models.ts` are all
 * `Record<AiProvider, …>`, so adding a member there fails the typecheck on
 * exactly the three tables a decision model must never be in. That break is
 * the guard, and it is invisible unless somebody says so here.
 * `docs/jev.md` is canonical.
 */
export type AiVendor = AiProvider | 'typesafe';

export const AI_VENDORS = ['anthropic', 'openai', 'typesafe'] as const satisfies readonly AiVendor[];

/**
 * A row in the settings table that holds an AI credential: each vendor's own
 * key, and the gateway's.
 *
 * **The gateway is a fourth key and not a fourth vendor.** It answers nothing
 * itself — it buys the three vendors' models with one key — so it is a slot a
 * route can point at (`ai_route_<vendor>`) and never something a picker offers
 * as a model. `docs/api.md` is canonical for the wire.
 */
export type AiCredentialSlot = AiVendor | 'vercel';

export const AI_CREDENTIAL_SLOTS = [
  'anthropic',
  'openai',
  'typesafe',
  'vercel',
] as const satisfies readonly AiCredentialSlot[];

/**
 * Legacy value of the removed `ai_auth_type` setting. Hubs configured before
 * the mapping agent moved to the Messages API may still hold a Claude
 * subscription token, which that API cannot authenticate with — it is read
 * only so the hub can say so instead of failing with a bare 401.
 */
const LEGACY_OAUTH_AUTH_TYPE = 'oauth_token';

/** Where each provider's credential and model live in the settings table. */
const SLOTS: Record<AiProvider, { key: string; model: string }> = {
  // Unchanged on purpose. `install.sh` rolls back to the previous release when
  // a build fails its health check, and that build reads exactly these two.
  anthropic: { key: 'ai_key_encrypted', model: 'ai_model' },
  openai: { key: 'ai_openai_key_encrypted', model: 'ai_openai_model' },
};

/**
 * Where the decision model's credential lives.
 *
 * **No model row beside it**, unlike `SLOTS`: the model is pinned in the build
 * (`DECISION_MODEL`), because the thresholds in `src/ai/decide/questions.ts`
 * are calibrated against it and calibration does not transfer between models.
 * A settable model would silently invalidate every threshold in that file —
 * the `src/portraits/CLAUDE.md` pinned-image-model argument, and the same one
 * as "Effort is `high` on both and is not exposed".
 */
const DECISION_KEY_ROW = 'ai_typesafe_key_encrypted';

/** Where the gateway's key lives — one key, whichever vendors it buys for. */
const GATEWAY_KEY_ROW = 'ai_vercel_key_encrypted';

/**
 * Where one vendor's route is stored. **Absent means direct**, so a hub
 * configured before routes existed reads exactly as it did, and a route is only
 * ever written as the one value that is not the default.
 */
function routeRowOf(vendor: AiVendor): string {
  return `ai_route_${vendor}`;
}

/**
 * The first cut of the gateway: a route stored beside the TypeSafe key, which
 * therefore held a Vercel key on a home buying its decisions that way. Read
 * once, at boot, by `adoptLegacyDecisionRoute`, and never written again.
 */
const LEGACY_DECISION_ROUTE_ROW = 'ai_decision_route';

/** The settings row holding one slot's secret. */
function keyRowOf(slot: AiCredentialSlot): string {
  switch (slot) {
    case 'typesafe':
      return DECISION_KEY_ROW;
    case 'vercel':
      return GATEWAY_KEY_ROW;
    default:
      return SLOTS[slot].key;
  }
}

export interface AiProviderSettings {
  /**
   * Whether the provider's **own** key is configured — the secret itself is
   * never exposed. A provider reached through the gateway can work with this
   * false; `usable` is the question "can it answer".
   */
  hasKey: boolean;
  /** The model this provider runs the mapping agent on; null means the default. */
  model: string | null;
  /** Whose key buys it: its own (`direct`) or the gateway's. */
  route: AiRoute;
  /**
   * Whether an agent can authenticate to it on that route: the gateway's key
   * when it goes through the gateway, its own key otherwise — and never a
   * stored Claude subscription token, which is a key the hub holds and cannot
   * use.
   */
  usable: boolean;
}

/**
 * Which model one agent runs on.
 *
 * One shape for both, and a column each — the assistant and the automations
 * agent are offered the same two models (`AGENT_MODELS`) and choose
 * independently, because "answer questions about the house" and "write the
 * rules it runs by itself" are different jobs somebody may want to spend
 * differently on.
 */
export interface AiAgentSettings {
  /**
   * The model the agent runs on, as it will actually run — never the stored
   * column. Null is not a state here: `effectiveAgentModel` has already
   * turned an absent or retired choice into the default.
   *
   * Empty only when neither provider can authenticate, which the caller has
   * already refused on (`hasKey`); `provider` is null in exactly that case.
   */
  model: string;
  /**
   * Whose key answers, derived from the model rather than stored beside it.
   *
   * Ids do not collide across vendors, so one column says both things and the
   * two can never disagree — `agentProviderOf`'s whole argument. Null means no
   * provider this hub holds a usable key for, which is the `ai_not_configured`
   * case and not a setting anybody chose.
   */
  provider: AiProvider | null;
}

/**
 * The decision model, as the API reports it.
 *
 * **Deliberately a different shape from `AiProviderSettings`**, which carries
 * a `model` the owner chooses from a list. Nothing should be able to loop over
 * "the providers and Jev": they answer different questions, and a shared shape
 * is the first step towards a picker that offers a model which cannot write.
 */
export interface AiDecisionSettings {
  /**
   * Whether TypeSafe's **own** key is configured — the secret itself is never
   * exposed. Decisions bought through the gateway work with this false.
   */
  hasKey: boolean;
  /**
   * Whose key buys the decisions — TypeSafe's own, or the gateway's.
   *
   * **Not a model choice.** Both routes serve the same model; this says which
   * address and which key, because a home may already hold a gateway key and
   * ought not to open a second account to reach a model it can already buy.
   */
  route: AiRoute;
  /** Whether there is a key on that route, so a decision can be asked at all. */
  usable: boolean;
  /**
   * What the chosen route calls the model, which is the same model either way.
   *
   * Pinned per route rather than settable: the thresholds in
   * `src/ai/decide/questions.ts` are calibrated against this one model and
   * calibration does not transfer. Reported so an app can say what answered.
   */
  model: string;
  /**
   * The owner's pause switch, absent meaning on.
   *
   * `ai_enabled`'s shape, for `ai_enabled`'s reason: "stop spending my money
   * on this for now" and "forget my API key" have very different costs to
   * undo, and deleting the key must not be the only way to ask for the first.
   */
  enabled: boolean;
}

export interface AiSettings {
  /**
   * Which provider would recognise a device right now, or null when neither
   * has a key. Kept as a flat field because it is the shape the API has always
   * answered with.
   */
  provider: AiProvider | null;
  /** The Anthropic model, flat, for the same reason. */
  model: string | null;
  /**
   * Whether the mapping agent has *any* usable credential. `lazy.ts` and the
   * API's `ai_not_configured` check read this, and both mean "can the agent
   * run at all" rather than "is Anthropic configured".
   */
  hasKey: boolean;
  /**
   * The owner's switch, deliberately separate from whether a key is stored.
   *
   * Turning AI adaptation off used to mean deleting the credential, which is
   * not the same request: "stop spending my money on this for now" and "forget
   * my API key" have different costs to undo. Absent means on, so a hub
   * configured before this existed keeps behaving exactly as it did.
   *
   * It governs device *adaptation* only. Portraits are asked for by hand, one
   * press at a time, and are not gated on it.
   */
  enabled: boolean;
  /**
   * Whether each request/response round is kept, and **off unless somebody
   * asked**.
   *
   * The run log is a summary by design, because model prose on an SD card is
   * the write amplification the rest of this store avoids. This is the switch
   * that suspends that rule while something is being worked out — a refusal
   * that is really about the request, a model that answers differently than
   * expected — and it is a *setting* rather than a build flag because the
   * person who needs it is looking at a hub they cannot rebuild. Absent means
   * off, so nothing starts recording on an upgrade.
   */
  recordExchanges: boolean;
  /**
   * The stored Anthropic secret is a Claude subscription token from before the
   * move to the Messages API and can no longer be used. The owner has to save
   * an API key; until they do, mapping runs are skipped and
   * `status.lastError` says why.
   */
  legacySubscriptionToken: boolean;
  anthropic: AiProviderSettings;
  openai: AiProviderSettings;
  /**
   * The fast decision model, which is **not** one of the two above.
   *
   * It never answers a chat, recognises a device or draws a portrait — it
   * routes what somebody said before a generative model is asked. Absent key
   * means every one of those paths runs exactly as it did before.
   */
  decision: AiDecisionSettings;
  /**
   * The gateway's own key, which buys any vendor whose route points at it.
   *
   * Only `hasKey`: which vendors use it is each vendor's `route`, stated where
   * that vendor is described, so there is one answer to "who pays for Claude"
   * rather than one here and another there.
   */
  gateway: { hasKey: boolean };
  /** What the assistant runs on. Its own choice, not the mapper's. */
  assistant: AiAgentSettings;
  /** What writes the home's rules. Its own choice, not the assistant's. */
  automations: AiAgentSettings;
  /**
   * True when both keys are stored, so which provider recognises devices is a
   * choice somebody has to make rather than one the hub can derive. An app
   * shows the picker on this and never on a key count of its own.
   */
  mappingChoosable: boolean;
}

/** Observable AI health, safe to return over the API (never contains secrets). */
export interface AiStatus {
  lastError?: {
    kind: string;
    message: string;
    at: string;
    resetAt?: string;
  };
  lastRun?: {
    at: string;
    ok: boolean;
    costUsd?: number;
    model?: string;
  };
}

/**
 * Key-value settings with encrypted secrets. An AI secret (an API key) is
 * stored AES-256-GCM-encrypted with the hub secret and only ever decrypted
 * in-process to run the mapping agent or draw a portrait.
 */
/**
 * Where the home's timezone is stored, and why it is a setting rather than a
 * fact read from the machine.
 *
 * A schedule says "at ten in the evening" and means the evening of the house
 * the hub is standing in. `Intl` gives the operating system's answer, which is
 * right for a Pi somebody set up at home and wrong for one imaged on a laptop
 * in another country or left on UTC by a headless install — and the person who
 * notices is the one whose heating came on at three in the morning. So the
 * system's answer **seeds** it and the database owns it afterwards, which is
 * the same split `HUB_NAME` has with the home's name.
 */
const TIMEZONE_KEY = 'home_timezone';

function systemTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export class SettingsService {
  /**
   * Held in memory, for the reason `HomeService` holds the home's name: the
   * automation engine asks for this on every scheduler tick and inside every
   * time condition, and neither may become a database read.
   */
  private cachedTimezone = systemTimezone();

  constructor(
    private readonly db: Db,
    private readonly aesKey: string,
  ) {}

  /** Read the stored timezone into memory. Called once, at boot. */
  async loadTimezone(): Promise<void> {
    const stored = await this.get<string>(TIMEZONE_KEY);
    if (typeof stored === 'string' && stored.length > 0) this.cachedTimezone = stored;
  }

  /** The home's timezone, synchronously. */
  get timezone(): string {
    return this.cachedTimezone;
  }

  /**
   * Set it, refusing one `Intl` cannot use.
   *
   * An unusable zone would take every schedule in the home down with it, on
   * every tick, silently — so it is checked here, once, where somebody is
   * still holding the request that can be told no.
   */
  async setTimezone(timezone: string): Promise<boolean> {
    try {
      new Intl.DateTimeFormat('en-GB', { timeZone: timezone }).format(0);
    } catch {
      return false;
    }
    await this.set(TIMEZONE_KEY, timezone);
    this.cachedTimezone = timezone;
    return true;
  }

  async get<T>(key: string): Promise<T | null> {
    const row = await this.db.query.settings.findFirst({ where: eq(settings.key, key) });
    return row ? (row.value as T) : null;
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value } });
  }

  private async unset(key: string): Promise<void> {
    await this.db.delete(settings).where(eq(settings.key, key));
  }

  async getAiSettings(): Promise<AiSettings> {
    const authType = await this.get<string>('ai_auth_type');
    const enabled = await this.get<boolean>('ai_enabled');
    const anthropic = await this.ownKeyAndModel('anthropic');
    const openai = await this.ownKeyAndModel('openai');
    const chosen = await this.get<AiProvider>('ai_mapping_provider');
    const decisionKey = await this.get<EncryptedValue>(DECISION_KEY_ROW);
    const decisionsEnabled = await this.get<boolean>('ai_decisions_enabled');
    const gatewayHasKey = (await this.get<EncryptedValue>(GATEWAY_KEY_ROW)) !== null;
    const routes = await this.routes();
    /**
     * Whether a vendor has a credential **on its route**: the gateway's key
     * when it goes through the gateway, its own otherwise.
     *
     * One rule for all three, and asked of the route rather than of the keys
     * that happen to exist — a gateway key does not make Claude reachable on a
     * home that has not moved Claude onto it, which is the whole of "only if
     * somebody wants it".
     */
    const reaches = (vendor: AiVendor, ownKey: boolean) =>
      routes[vendor] === 'vercel' ? gatewayHasKey : ownKey;
    const reachable: UsableProviders = {
      anthropic: reaches('anthropic', anthropic.hasKey),
      openai: reaches('openai', openai.hasKey),
    };
    /**
     * A Claude subscription token is only in the way when it is what Claude
     * would be asked with. On the gateway it is simply a row nobody reads, and
     * reporting it then would tell an app the home cannot talk to a model it
     * is talking to perfectly well.
     */
    const legacy =
      anthropic.hasKey && authType === LEGACY_OAUTH_AUTH_TYPE && routes.anthropic === 'direct';
    /**
     * Which providers an *agent* could authenticate as.
     *
     * A stored Anthropic subscription token is a key the hub holds and cannot
     * use — the chat loops authenticate with an API key — so it is not
     * usability, and treating it as such would point every conversation at a
     * vendor that answers 401 while a working OpenAI key sat beside it.
     */
    const usable: UsableProviders = {
      anthropic: reachable.anthropic && !legacy,
      openai: reachable.openai,
    };
    return {
      provider: this.resolveMappingProvider(chosen, reachable),
      model: anthropic.model,
      // **Generative credentials only, and that is load-bearing.** `lazy.ts`
      // and the API's `ai_not_configured` check both read this to mean "can an
      // agent run at all". A Jev key making it true would build a mapper and
      // let `openConversation` past its own check, to fail at the provider —
      // which is also why a gateway key counts only for a provider routed
      // through it.
      hasKey: reachable.anthropic || reachable.openai,
      enabled: enabled !== false,
      recordExchanges: (await this.get<boolean>('ai_record_exchanges')) === true,
      legacySubscriptionToken: legacy,
      anthropic: { ...anthropic, route: routes.anthropic, usable: usable.anthropic },
      openai: { ...openai, route: routes.openai, usable: usable.openai },
      decision: {
        hasKey: decisionKey !== null,
        route: routes.typesafe,
        usable: reaches('typesafe', decisionKey !== null),
        model: DECISION_ROUTES[routes.typesafe].modelId,
        enabled: decisionsEnabled !== false,
      },
      gateway: { hasKey: gatewayHasKey },
      // Both *generative* providers: which model reads a device's exposes tree
      // is a choice between those two and Jev is not one of them.
      mappingChoosable: reachable.anthropic && reachable.openai,
      assistant: agentSettings(await this.get<string>('ai_assistant_model'), usable),
      automations: agentSettings(await this.get<string>('ai_automations_model'), usable),
    };
  }

  private async ownKeyAndModel(provider: AiProvider): Promise<{ hasKey: boolean; model: string | null }> {
    const slot = SLOTS[provider];
    const encrypted = await this.get<EncryptedValue>(slot.key);
    return { hasKey: encrypted !== null, model: await this.get<string>(slot.model) };
  }

  /** Every vendor's route, as stored — absent reading as `direct`. */
  private async routes(): Promise<Record<AiVendor, AiRoute>> {
    return {
      anthropic: aiRouteOf(await this.get<string>(routeRowOf('anthropic'))),
      openai: aiRouteOf(await this.get<string>(routeRowOf('openai'))),
      typesafe: aiRouteOf(await this.get<string>(routeRowOf('typesafe'))),
    };
  }

  /**
   * Which provider recognises devices.
   *
   * A stored choice only counts while the provider it names still has a
   * credential on its route — otherwise clearing one would leave the hub
   * pointed at a provider it cannot authenticate, with nothing on screen
   * saying so. With one there is no choice to make; with none there is no
   * provider.
   *
   * **Reachable, not usable**, deliberately: a Claude subscription token still
   * counts here, so the mapper reaches the one place that says what is wrong
   * with it instead of skipping recognition with nothing recorded.
   */
  private resolveMappingProvider(
    chosen: AiProvider | null,
    reachable: UsableProviders,
  ): AiProvider | null {
    if (chosen === 'openai' && reachable.openai) return 'openai';
    if (chosen === 'anthropic' && reachable.anthropic) return 'anthropic';
    if (reachable.anthropic) return 'anthropic';
    if (reachable.openai) return 'openai';
    return null;
  }

  /**
   * The decision model's own pause switch.
   *
   * Separate from `ai_enabled`, which governs device *adaptation*: a home may
   * well want the fast routing while it has stopped paying for recognition,
   * and one switch for two budgets is a switch somebody turns off to fix one
   * thing and finds out about the other.
   */
  async setDecisionsEnabled(enabled: boolean): Promise<void> {
    await this.set('ai_decisions_enabled', enabled);
  }

  /**
   * Whose key buys one vendor's models: its own, or the gateway's.
   *
   * `direct` is written as the row's absence, so the default is the only
   * value that never needs storing and a hub rolled back to a build that
   * predates routes simply never sees one.
   */
  async setAiRoute(vendor: AiVendor, route: AiRoute): Promise<void> {
    if (route === 'direct') await this.unset(routeRowOf(vendor));
    else await this.set(routeRowOf(vendor), route);
    // A different credential answers a generative vendor now, so what the
    // mapper last said about the old one is stale — the rule saving a key
    // already follows. The decision model keeps no status of its own; its
    // breaker is keyed on the secret and retires itself.
    if (vendor !== 'typesafe') await this.unset('ai_status');
  }

  /**
   * Move a key from the first cut of the gateway to where it belongs, once.
   *
   * That cut stored a route beside the TypeSafe key, so a home buying its
   * decisions through Vercel held a Vercel key in the **TypeSafe** slot — the
   * row an app then had to rename to stay truthful. The key moves to the
   * gateway's own slot and the decision route to the per-vendor row, which
   * leaves the home deciding exactly as it did the minute before. Called at
   * boot; a hub that never ran that cut has no row and does nothing.
   *
   * The ciphertext moves as it is: it is sealed with the hub's key and names
   * no row, so re-encrypting it would be the same bytes' worth of work to
   * produce the same secret.
   */
  async adoptLegacyDecisionRoute(): Promise<void> {
    const legacy = await this.get<string>(LEGACY_DECISION_ROUTE_ROW);
    if (legacy === null) return;
    if (legacy === 'vercel') {
      const held = await this.get<EncryptedValue>(DECISION_KEY_ROW);
      const gateway = await this.get<EncryptedValue>(GATEWAY_KEY_ROW);
      if (held !== null && gateway === null) {
        await this.set(GATEWAY_KEY_ROW, held);
        await this.unset(DECISION_KEY_ROW);
      }
      if (held !== null || gateway !== null) await this.set(routeRowOf('typesafe'), 'vercel');
    }
    await this.unset(LEGACY_DECISION_ROUTE_ROW);
  }

  async setAiEnabled(enabled: boolean): Promise<void> {
    await this.set('ai_enabled', enabled);
  }

  /** Start or stop keeping what each round of a run sent and received. */
  async setAiRecordExchanges(record: boolean): Promise<void> {
    await this.set('ai_record_exchanges', record);
  }

  /** Change which model runs the agent, leaving the credential alone. */
  async setAiModel(model: string | null, provider: AiProvider = 'anthropic'): Promise<void> {
    // A JS null would become SQL NULL against a NOT NULL json column; absence
    // of the row already means "use the default model".
    if (model === null) await this.unset(SLOTS[provider].model);
    else await this.set(SLOTS[provider].model, model);
  }

  /**
   * Which model the assistant answers on.
   *
   * Its own key rather than a second use of `ai_model`, which is the mapper's
   * and answers a different question — a descriptor is cached against a device
   * model for ever, a conversation is many small rounds — and one column would
   * make changing either change both.
   */
  async setAssistantModel(model: string | null): Promise<void> {
    if (model === null) await this.unset('ai_assistant_model');
    else await this.set('ai_assistant_model', model);
  }

  /**
   * Which model writes the home's rules.
   *
   * **Its own key, and it did not have one.** This agent read `ai_model` — the
   * *mapper's* column — so "which model recognises a device" and "which model
   * writes a rule" shared an answer. It never showed, because the mapper
   * offers one model and Sonnet is not on its list, so `effectiveModel` handed
   * back Opus whatever was stored; the coupling was one added choice away from
   * being a bug somebody had to find. Absent means the default, as everywhere
   * else here.
   */
  async setAutomationsModel(model: string | null): Promise<void> {
    if (model === null) await this.unset('ai_automations_model');
    else await this.set('ai_automations_model', model);
  }

  /** Which provider recognises devices when both keys are configured. */
  async setMappingProvider(provider: AiProvider): Promise<void> {
    await this.set('ai_mapping_provider', provider);
  }

  /**
   * Store one provider's key, leaving the other provider — and the model, and
   * the owner's switch — exactly as they were.
   */
  async setAiKey(slot: AiCredentialSlot, apiKey: string): Promise<void> {
    if (slot === 'anthropic') {
      // Kept for the rolled-back build, which reads this row to decide whether
      // it has a provider at all. An OpenAI-only hub leaves it absent, so that
      // build correctly runs no agent rather than trying the wrong key.
      await this.set('ai_provider', 'anthropic' satisfies AiProvider);
      // Saving a key clears the legacy marker: whatever is stored now is an
      // API key, so the hub must stop reporting the subscription problem.
      await this.unset('ai_auth_type');
    }
    await this.set(keyRowOf(slot), encryptSecret(apiKey, this.aesKey));
    // A fresh credential wipes stale health state. That includes the decision
    // model's breaker, which is keyed on the secret and retires itself — see
    // `src/ai/decide/lazy.ts`; nothing to clear here.
    await this.unset('ai_status');
  }

  async setAiSettings(input: { model: string | null; apiKey: string }): Promise<void> {
    await this.setAiModel(input.model, 'anthropic');
    await this.setAiKey('anthropic', input.apiKey);
  }

  /** Forget one slot's credential and model; the other slots are untouched. */
  async clearAiCredential(slot: AiCredentialSlot): Promise<void> {
    if (slot === 'typesafe') {
      // No model row and no legacy marker: the decision model has neither.
      // And the route stays: it says whose key buys the decisions, and a home
      // buying them through the gateway keeps deciding when TypeSafe's own
      // key goes.
      await this.unset(DECISION_KEY_ROW);
      return;
    }
    if (slot === 'vercel') {
      await this.unset(GATEWAY_KEY_ROW);
      // **Nothing is left pointing at a gateway with no key.** Every vendor
      // it carried goes back to its own key — and a vendor with none stops,
      // which is what removing the only key that bought it means, rather than
      // a route that answers 401 on every request with nothing on screen
      // saying why.
      const routes = await this.routes();
      for (const vendor of AI_VENDORS) {
        if (routes[vendor] !== 'direct') await this.unset(routeRowOf(vendor));
      }
      await this.unset('ai_status');
      return;
    }
    if (slot === 'anthropic') {
      await this.unset('ai_provider');
      await this.unset('ai_auth_type');
    }
    await this.unset(SLOTS[slot].key);
    await this.unset(SLOTS[slot].model);
    await this.unset('ai_status');
  }

  async clearAiSettings(): Promise<void> {
    await this.clearAiCredential('anthropic');
    await this.clearAiCredential('openai');
    await this.clearAiCredential('typesafe');
    // Last, because it is what takes the routes with it.
    await this.clearAiCredential('vercel');
    await this.unset('ai_mapping_provider');
    await this.unset('ai_decisions_enabled');
    // Back to the default. Leaving a stale `false` behind would mean a hub
    // whose owner cleared the credential and saved a new one got no AI
    // adaptation and no indication why.
    await this.unset('ai_enabled');
  }

  /**
   * Decrypt one slot's key — in-process use only.
   *
   * **Read a slot only for the things that never take a route**, which today
   * is the voice alone: GPT-Live's WebRTC offer and its sideband are
   * OpenAI's own. Everything that asks a vendor for a model asks
   * `aiConnection`, or a home routed through the gateway would be answered on
   * a key it had chosen not to use.
   */
  async aiKey(slot: AiCredentialSlot = 'anthropic'): Promise<string | null> {
    const encrypted = await this.get<EncryptedValue>(keyRowOf(slot));
    if (!encrypted) return null;
    return decryptSecret(encrypted, this.aesKey);
  }

  /**
   * The credential one vendor is asked with, and which way it goes.
   *
   * The route decides the slot: the vendor's own key when it is `direct`, the
   * gateway's when it goes through the gateway — never "whichever exists",
   * because a home that routed Claude through Vercel and still holds an
   * Anthropic key has said which one it wants spent. `null` when that slot is
   * empty, which every caller already reads as "not configured".
   */
  async aiConnection(vendor: AiVendor): Promise<AiConnection | null> {
    const route = aiRouteOf(await this.get<string>(routeRowOf(vendor)));
    const secret = await this.aiKey(route === 'vercel' ? 'vercel' : vendor);
    return secret === null ? null : { secret, route };
  }

  async getAiStatus(): Promise<AiStatus> {
    return (await this.get<AiStatus>('ai_status')) ?? {};
  }

  /** Replaces the stored status — pass the complete object you want visible. */
  async setAiStatus(status: AiStatus): Promise<void> {
    await this.set('ai_status', status);
  }
}

/**
 * One stored column, as the pair of facts every caller needs.
 *
 * Written once and used for both agents: the assistant and the automations
 * agent ask the identical question of two different columns, and two copies of
 * the "what is null" reasoning is exactly where the two would drift.
 */
function agentSettings(stored: string | null, usable: UsableProviders): AiAgentSettings {
  const resolved = effectiveAgentModel(stored, usable);
  return resolved === null
    ? { model: '', provider: null }
    : { model: resolved.modelId, provider: resolved.provider };
}
