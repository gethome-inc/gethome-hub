import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { settings } from '../db/schema.js';
import { decryptSecret, encryptSecret, type EncryptedValue } from './crypto.js';

export type AiProvider = 'anthropic' | 'openai';

export interface AiSettings {
  provider: AiProvider | null;
  model: string | null;
  /** Whether a key is configured — the key itself is never exposed. */
  hasKey: boolean;
}

/**
 * Key-value settings with encrypted secrets. The AI provider key is stored
 * AES-256-GCM-encrypted with the hub secret and only ever decrypted in-process
 * to call the configured provider.
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

  async getAiSettings(): Promise<AiSettings> {
    const provider = await this.get<AiProvider>('ai_provider');
    const model = await this.get<string>('ai_model');
    const encrypted = await this.get<EncryptedValue>('ai_key_encrypted');
    return { provider, model, hasKey: encrypted !== null };
  }

  async setAiSettings(provider: AiProvider, model: string | null, apiKey: string): Promise<void> {
    await this.set('ai_provider', provider);
    // A JS null would become SQL NULL and violate the jsonb NOT NULL — absence
    // of the row already means "use the provider default".
    if (model === null) {
      await this.db.delete(settings).where(eq(settings.key, 'ai_model'));
    } else {
      await this.set('ai_model', model);
    }
    await this.set('ai_key_encrypted', encryptSecret(apiKey, this.aesKey));
  }

  async clearAiSettings(): Promise<void> {
    await this.db.delete(settings).where(eq(settings.key, 'ai_provider'));
    await this.db.delete(settings).where(eq(settings.key, 'ai_model'));
    await this.db.delete(settings).where(eq(settings.key, 'ai_key_encrypted'));
  }

  /** Decrypt the configured AI key — in-process use only. */
  async aiKey(): Promise<string | null> {
    const encrypted = await this.get<EncryptedValue>('ai_key_encrypted');
    if (!encrypted) return null;
    return decryptSecret(encrypted, this.aesKey);
  }
}
