import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { settings } from '../db/schema.js';
import { decryptSecret, encryptSecret, type EncryptedValue } from './crypto.js';

export type AiProvider = 'anthropic';

/**
 * Legacy value of the removed `ai_auth_type` setting. Hubs configured before
 * the mapping agent moved to the Messages API may still hold a Claude
 * subscription token, which that API cannot authenticate with — it is read
 * only so the hub can say so instead of failing with a bare 401.
 */
const LEGACY_OAUTH_AUTH_TYPE = 'oauth_token';

export interface AiSettings {
  provider: AiProvider | null;
  model: string | null;
  /** Whether a key is configured — the secret itself is never exposed. */
  hasKey: boolean;
  /**
   * The owner's switch, deliberately separate from whether a key is stored.
   *
   * Turning AI adaptation off used to mean deleting the credential, which is
   * not the same request: "stop spending my money on this for now" and "forget
   * my API key" have different costs to undo. Absent means on, so a hub
   * configured before this existed keeps behaving exactly as it did.
   */
  enabled: boolean;
  /**
   * The stored secret is a Claude subscription token from before the move to
   * the Messages API and can no longer be used. The owner has to save an
   * Anthropic API key; until they do, mapping runs are skipped and
   * `status.lastError` says why.
   */
  legacySubscriptionToken: boolean;
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
 * Key-value settings with encrypted secrets. The AI secret (API key or
 * subscription token) is stored AES-256-GCM-encrypted with the hub secret and
 * only ever decrypted in-process to run the mapping agent.
 */
export class SettingsService {
  constructor(
    private readonly db: Db,
    private readonly aesKey: string,
  ) {}

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
    const provider = await this.get<AiProvider>('ai_provider');
    const authType = await this.get<string>('ai_auth_type');
    const model = await this.get<string>('ai_model');
    const encrypted = await this.get<EncryptedValue>('ai_key_encrypted');
    const enabled = await this.get<boolean>('ai_enabled');
    return {
      provider,
      model,
      hasKey: encrypted !== null,
      enabled: enabled !== false,
      legacySubscriptionToken: encrypted !== null && authType === LEGACY_OAUTH_AUTH_TYPE,
    };
  }

  async setAiEnabled(enabled: boolean): Promise<void> {
    await this.set('ai_enabled', enabled);
  }

  /** Change which model runs the agent, leaving the credential alone. */
  async setAiModel(model: string | null): Promise<void> {
    // A JS null would become SQL NULL against a NOT NULL json column; absence
    // of the row already means "use the default model".
    if (model === null) await this.unset('ai_model');
    else await this.set('ai_model', model);
  }

  async setAiSettings(input: { model: string | null; apiKey: string }): Promise<void> {
    await this.set('ai_provider', 'anthropic' satisfies AiProvider);
    // Saving a key clears the legacy marker: whatever is stored now is an
    // API key, so the hub must stop reporting the subscription problem.
    await this.unset('ai_auth_type');
    // A JS null would become SQL NULL and violate the jsonb NOT NULL — absence
    // of the row already means "use the default model".
    if (input.model === null) {
      await this.unset('ai_model');
    } else {
      await this.set('ai_model', input.model);
    }
    await this.set('ai_key_encrypted', encryptSecret(input.apiKey, this.aesKey));
    // A fresh credential wipes stale health state.
    await this.unset('ai_status');
  }

  async clearAiSettings(): Promise<void> {
    await this.unset('ai_provider');
    await this.unset('ai_auth_type');
    await this.unset('ai_model');
    await this.unset('ai_key_encrypted');
    await this.unset('ai_status');
    // Back to the default. Leaving a stale `false` behind would mean a hub
    // whose owner cleared the credential and saved a new one got no AI
    // adaptation and no indication why.
    await this.unset('ai_enabled');
  }

  /** Decrypt the configured AI secret — in-process use only. */
  async aiKey(): Promise<string | null> {
    const encrypted = await this.get<EncryptedValue>('ai_key_encrypted');
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
