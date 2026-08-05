import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { PairingService } from '../src/core/pairing.js';
import { sha256Hex, generateToken, encryptSecret, decryptSecret } from '../src/core/crypto.js';
import { invites, tokens } from '../src/db/schema.js';
import { openTestDb, resetDb } from './helpers/db.js';

const handle = await openTestDb();
const log = pino({ level: 'silent' });

describe.skipIf(!handle)('PairingService', () => {
  // Skipped suites still have their body collected, so never deref a null
  // handle here; `db` is only read once the suite actually runs.
  const db = handle?.db!;
  let dataDir: string;
  let pairing: PairingService;

  beforeEach(async () => {
    await resetDb(db);
    dataDir = mkdtempSync(path.join(tmpdir(), 'gethome-pairing-'));
    pairing = new PairingService(db, dataDir, log);
    await pairing.boot();
  });

  afterAll(async () => {
    await handle?.close();
  });

  it('writes the boot pairing code to disk while unclaimed', () => {
    expect(pairing.claimed).toBe(false);
    const code = readFileSync(path.join(dataDir, 'pairing-code'), 'utf8').trim();
    expect(code).toMatch(/^\d{8}$/);
  });

  it('rejects a wrong code and accepts the right one exactly once', async () => {
    const code = readFileSync(path.join(dataDir, 'pairing-code'), 'utf8').trim();
    expect(await pairing.claim('00000001', 'Mallory')).toBeNull();

    const result = await pairing.claim(code, 'Georgy', 'iPhone');
    expect(result).not.toBeNull();
    expect(result!.member.role).toBe('owner');
    expect(pairing.claimed).toBe(true);
    expect(existsSync(path.join(dataDir, 'pairing-code'))).toBe(false);

    // Boot code is dead after the claim.
    expect(await pairing.claim(code, 'Mallory')).toBeNull();
  });

  it('returns the original owner result when a timed-out claim is retried', async () => {
    const code = readFileSync(path.join(dataDir, 'pairing-code'), 'utf8').trim();
    const claimId = '9a7a72e7-90e6-4b1e-859a-902abf7e7c4a';

    const first = await pairing.claim(code, 'Georgy', 'Studio Mac', claimId);
    const resumed = await pairing.claim(code, 'Georgy', 'Studio Mac', claimId);

    expect(first).not.toBeNull();
    expect(resumed).toEqual(first);
  });

  it('stores only the token hash', async () => {
    const code = readFileSync(path.join(dataDir, 'pairing-code'), 'utf8').trim();
    const result = await pairing.claim(code, 'Georgy');
    const rows = await db.select().from(tokens);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(sha256Hex(result!.token));
    expect(rows[0]!.tokenHash).not.toBe(result!.token);
  });

  it('verifies tokens back to their member', async () => {
    const code = readFileSync(path.join(dataDir, 'pairing-code'), 'utf8').trim();
    const result = await pairing.claim(code, 'Georgy');
    const member = await pairing.verifyToken(result!.token);
    expect(member?.name).toBe('Georgy');
    expect(member?.role).toBe('owner');
    expect(await pairing.verifyToken(generateToken())).toBeNull();
  });

  it('admits members through invites, once, until expiry', async () => {
    const bootCode = readFileSync(path.join(dataDir, 'pairing-code'), 'utf8').trim();
    const owner = await pairing.claim(bootCode, 'Georgy');

    const invite = await pairing.createInvite(owner!.member.id);
    const joined = await pairing.claim(invite.code, 'Anna', 'iPhone 17');
    expect(joined?.member.role).toBe('member');

    // Single use.
    expect(await pairing.claim(invite.code, 'Boris')).toBeNull();

    // Expired invites don't work.
    const stale = await pairing.createInvite(owner!.member.id);
    await db.update(invites).set({ expiresAt: new Date(Date.now() - 1000) });
    expect(await pairing.claim(stale.code, 'Boris')).toBeNull();
  });

  it('does not re-issue a boot code once claimed', async () => {
    const code = readFileSync(path.join(dataDir, 'pairing-code'), 'utf8').trim();
    await pairing.claim(code, 'Georgy');

    const rebooted = new PairingService(db, dataDir, log);
    await rebooted.boot();
    expect(rebooted.claimed).toBe(true);
    expect(existsSync(path.join(dataDir, 'pairing-code'))).toBe(false);
  });

  it('cleans up temp dirs', () => {
    rmSync(dataDir, { recursive: true, force: true });
  });
});

describe('secret encryption', () => {
  it('round-trips AES-256-GCM and rejects tampering', () => {
    const key = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');
    const encrypted = encryptSecret('sk-ant-secret', key);
    expect(decryptSecret(encrypted, key)).toBe('sk-ant-secret');
    const tampered = { ...encrypted, data: Buffer.from('junkjunk').toString('base64') };
    expect(() => decryptSecret(tampered, key)).toThrow();
  });
});
