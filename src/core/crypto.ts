import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomInt,
  randomUUID,
} from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Hub identity + encryption key, stored on disk (not in Postgres) so the hub
 * keeps its identity across database resets. Created at first boot, 0600.
 */
export interface HubSecret {
  hubId: string;
  /** base64, 32 bytes — AES-256-GCM key for encrypting settings secrets. */
  aesKey: string;
}

export function ensureHubSecret(dataDir: string): HubSecret {
  const file = path.join(dataDir, 'hub-secret.json');
  if (existsSync(file)) {
    return JSON.parse(readFileSync(file, 'utf8')) as HubSecret;
  }
  mkdirSync(dataDir, { recursive: true });
  const secret: HubSecret = {
    hubId: randomUUID(),
    aesKey: randomBytes(32).toString('base64'),
  };
  writeFileSync(file, JSON.stringify(secret, null, 2) + '\n', { mode: 0o600 });
  return secret;
}

/** Opaque bearer token: 32 random bytes, base64url. Only its hash is stored. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** 8-digit numeric code for pairing and invites (leading zeros allowed). */
export function generateNumericCode(): string {
  return String(randomInt(0, 100_000_000)).padStart(8, '0');
}

export interface EncryptedValue {
  iv: string;
  tag: string;
  data: string;
}

export function encryptSecret(plaintext: string, aesKeyBase64: string): EncryptedValue {
  const key = Buffer.from(aesKeyBase64, 'base64');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

export function decryptSecret(value: EncryptedValue, aesKeyBase64: string): string {
  const key = Buffer.from(aesKeyBase64, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]).toString('utf8');
}
