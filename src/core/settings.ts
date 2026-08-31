import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { settings } from '../db/schema.js';
import { decryptSecret, encryptSecret, type EncryptedValue } from './crypto.js';

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

export interface AiProviderSettings {
  /** Whether a key is configured — the secret itself is never exposed. */
  hasKey: boolean;
  /** The model this provider runs the mapping agent on; null means the default. */
  model: string | null;
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
    const anthropic = await this.providerSettings('anthropic');
    const openai = await this.providerSettings('openai');
    const chosen = await this.get<AiProvider>('ai_mapping_provider');
    return {
      provider: this.resolveMappingProvider(chosen, anthropic, openai),
      model: anthropic.model,
      hasKey: anthropic.hasKey || openai.hasKey,
      enabled: enabled !== false,
      recordExchanges: (await this.get<boolean>('ai_record_exchanges')) === true,
      legacySubscriptionToken: anthropic.hasKey && authType === LEGACY_OAUTH_AUTH_TYPE,
      anthropic,
      openai,
      mappingChoosable: anthropic.hasKey && openai.hasKey,
    };
  }

  private async providerSettings(provider: AiProvider): Promise<AiProviderSettings> {
    const slot = SLOTS[provider];
    const encrypted = await this.get<EncryptedValue>(slot.key);
    return { hasKey: encrypted !== null, model: await this.get<string>(slot.model) };
  }

  /**
   * Which provider recognises devices.
   *
   * A stored choice only counts while the provider it names still has a key —
   * otherwise clearing one credential would leave the hub pointed at a
   * provider it cannot authenticate, with nothing on screen saying so. With
   * one key there is no choice to make; with none there is no provider.
   */
  private resolveMappingProvider(
    chosen: AiProvider | null,
    anthropic: AiProviderSettings,
    openai: AiProviderSettings,
  ): AiProvider | null {
    if (chosen === 'openai' && openai.hasKey) return 'openai';
    if (chosen === 'anthropic' && anthropic.hasKey) return 'anthropic';
    if (anthropic.hasKey) return 'anthropic';
    if (openai.hasKey) return 'openai';
    return null;
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

  /** Which provider recognises devices when both keys are configured. */
  async setMappingProvider(provider: AiProvider): Promise<void> {
    await this.set('ai_mapping_provider', provider);
  }

  /**
   * Store one provider's key, leaving the other provider — and the model, and
   * the owner's switch — exactly as they were.
   */
  async setAiKey(provider: AiProvider, apiKey: string): Promise<void> {
    if (provider === 'anthropic') {
      // Kept for the rolled-back build, which reads this row to decide whether
      // it has a provider at all. An OpenAI-only hub leaves it absent, so that
      // build correctly runs no agent rather than trying the wrong key.
      await this.set('ai_provider', 'anthropic' satisfies AiProvider);
      // Saving a key clears the legacy marker: whatever is stored now is an
      // API key, so the hub must stop reporting the subscription problem.
      await this.unset('ai_auth_type');
    }
    await this.set(SLOTS[provider].key, encryptSecret(apiKey, this.aesKey));
    // A fresh credential wipes stale health state.
    await this.unset('ai_status');
  }

  async setAiSettings(input: { model: string | null; apiKey: string }): Promise<void> {
    await this.setAiModel(input.model, 'anthropic');
    await this.setAiKey('anthropic', input.apiKey);
  }

  /** Forget one provider's credential and model; the other one is untouched. */
  async clearAiProvider(provider: AiProvider): Promise<void> {
    if (provider === 'anthropic') {
      await this.unset('ai_provider');
      await this.unset('ai_auth_type');
    }
    await this.unset(SLOTS[provider].key);
    await this.unset(SLOTS[provider].model);
    await this.unset('ai_status');
  }

  async clearAiSettings(): Promise<void> {
    await this.clearAiProvider('anthropic');
    await this.clearAiProvider('openai');
    await this.unset('ai_mapping_provider');
    // Back to the default. Leaving a stale `false` behind would mean a hub
    // whose owner cleared the credential and saved a new one got no AI
    // adaptation and no indication why.
    await this.unset('ai_enabled');
  }

  /** Decrypt one provider's key — in-process use only. */
  async aiKey(provider: AiProvider = 'anthropic'): Promise<string | null> {
    const encrypted = await this.get<EncryptedValue>(SLOTS[provider].key);
    if (!encrypted) return null;
    return decryptSecret(encrypted, this.aesKey);
  }

  async getAiStatus(): Promise<AiStatus> {
    return (await this.get<AiStatus>('ai_status')) ?? {};
  }

  /** Replaces the stored status — pass the complete object you want visible. */
  async setAiStatus(status: AiStatus): Promise<void> {
    await this.set('ai_status', status);
  }
}
