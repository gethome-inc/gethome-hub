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

/** What every API key starts with — see `generateApiKeySecret`. */
export const API_KEY_PREFIX = 'gethome_';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** 256 bits need 43 base-62 digits; every key is padded to exactly that. */
const API_KEY_DIGITS = 43;

/**
 * A new API key: `gethome_` and 32 random bytes in base 62.
 *
 * **Base 62 because a key is something a person copies.** A member token never
 * leaves an app, so base64url is fine there; a key is pasted into a terminal,
 * a `.env` file, a Node-RED field — and `-` and `_` end a double-click
 * selection in most of those, so a base64url key gets copied in pieces. Letters
 * and digits select whole.
 *
 * **The prefix is what makes a leaked key recognisable** — to the hub, which
 * tells a key from a member token without a second lookup; to a secret scanner;
 * and to a person who finds one in a file and wonders what it opens. It is
 * fixed-length (51 characters) for the same reason: a string of exactly this
 * shape is a gethome key and nothing else.
 */
export function generateApiKeySecret(): string {
  let value = BigInt(`0x${randomBytes(32).toString('hex')}`);
  let digits = '';
  while (value > 0n) {
    digits = BASE62[Number(value % 62n)] + digits;
    value /= 62n;
  }
  return API_KEY_PREFIX + digits.padStart(API_KEY_DIGITS, '0');
}

/** Whether a presented credential has the shape of an API key at all. */
export function looksLikeApiKey(credential: string): boolean {
  return (
    credential.length === API_KEY_PREFIX.length + API_KEY_DIGITS &&
    credential.startsWith(API_KEY_PREFIX) &&
    /^[0-9A-Za-z]+$/.test(credential.slice(API_KEY_PREFIX.length))
  );
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
