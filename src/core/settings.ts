import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { settings } from '../db/schema.js';
import { decryptSecret, encryptSecret, type EncryptedValue } from './crypto.js';

export type AiProvider = 'anthropic';
/** How the stored secret authenticates: an Anthropic API key, or a Claude
 *  subscription OAuth token minted by the owner with `claude setup-token`. */
export type AiAuthType = 'api_key' | 'oauth_token';

export interface AiSettings {
  provider: AiProvider | null;
  authType: AiAuthType;
  model: string | null;
  /** Whether a key/token is configured — the secret itself is never exposed. */
  hasKey: boolean;
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
    const authType = (await this.get<AiAuthType>('ai_auth_type')) ?? 'api_key';
    const model = await this.get<string>('ai_model');
    const encrypted = await this.get<EncryptedValue>('ai_key_encrypted');
    return { provider, authType, model, hasKey: encrypted !== null };
  }

  async setAiSettings(input: { authType: AiAuthType; model: string | null; apiKey: string }): Promise<void> {
    await this.set('ai_provider', 'anthropic' satisfies AiProvider);
    await this.set('ai_auth_type', input.authType);
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
