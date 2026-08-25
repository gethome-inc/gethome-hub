import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { PairingService } from '../src/core/pairing.js';
import { sha256Hex, generateToken, encryptSecret, decryptSecret } from '../src/core/crypto.js';
import { invites, tokens } from '../src/db/schema.js';
import { HubEventBus } from '../src/core/bus.js';
import { openTestDb, resetDb, loadedAccess } from './helpers/db.js';

const handle = await openTestDb();
const log = pino({ level: 'silent' });

describe.skipIf(!handle)('PairingService', () => {
  // Skipped suites still have their body collected, so never deref a null
  // handle here; `db` is only read once the suite actually runs.
  const db = handle?.db!;
  let dataDir: string;
  let pairing: PairingService;
  // The pairing service asks this for the role a claim should land in — the
  // owner's on a boot code, the invite's otherwise — and tells it about the
  // member it has just created, so the first request that member makes finds
  // an answer already in memory.
  let access: Awaited<ReturnType<typeof loadedAccess>>;

  beforeEach(async () => {
    await resetDb(db);
    dataDir = mkdtempSync(path.join(tmpdir(), 'gethome-pairing-'));
    access = await loadedAccess(db, new HubEventBus());
    pairing = new PairingService(db, dataDir, log, access);
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

  /**
   * An invite carries the role somebody is being admitted *into*, which is the
   * only chance a home gets to say so — there is no screen between claiming and
   * being in the house. An invite with no role named stays a Member invite,
   * exactly as every invite this hub ever minted was.
   */
  it('admits a member into the role the invite named', async () => {
    const bootCode = readFileSync(path.join(dataDir, 'pairing-code'), 'utf8').trim();
    const owner = await pairing.claim(bootCode, 'Georgy');
    const guestRole = access.builtinRoleId('guest')!;

    const named = await pairing.createInvite(owner!.member.id, guestRole);
    expect(named.roleId).toBe(guestRole);
    const guest = await pairing.claim(named.code, 'Kolya');
    expect(guest?.member.roleId).toBe(guestRole);
    expect(access.roleFor(guest!.member.id)?.key).toBe('guest');
    // The legacy word is written for a build this hub might roll back to, and
    // it has only two: everybody who isn't the owner reads as a member there.
    expect(guest?.member.role).toBe('member');

    // An owner invite admits a second owner. The route above it decides who
    // may mint one; by the time a code is being claimed that is settled, and
    // the legacy word has to say `owner` for a build this hub might roll back
    // to — the one place two members legitimately read `owner` there.
    const asOwner = await pairing.createInvite(
      owner!.member.id,
      access.builtinRoleId('owner')!,
    );
    const second = await pairing.claim(asOwner.code, 'Gera');
    expect(second?.member.role).toBe('owner');
    expect(access.isOwner(second!.member.id)).toBe(true);
    expect(access.ownerCount()).toBe(2);

    const plain = await pairing.createInvite(owner!.member.id);
    expect(plain.roleId).toBe(access.builtinRoleId('member'));
    const anna = await pairing.claim(plain.code, 'Anna');
    expect(access.roleFor(anna!.member.id)?.key).toBe('member');

    // A code minted into a role that has since been deleted is nothing — not a
    // Member invite. `deleteRole` takes its invites with it precisely so this
    // cannot admit somebody with more access than the home ever offered.
    const custom = await access.createRole('Cleaner', ['activity.read']);
    const doomed = await pairing.createInvite(owner!.member.id, custom.id);
    await access.deleteRole(custom.id);
    expect(await pairing.claim(doomed.code, 'Masha')).toBeNull();
  });

  it('keeps the same pairing code across restarts while unclaimed', async () => {
    const code = readFileSync(path.join(dataDir, 'pairing-code'), 'utf8').trim();

    // The hub restarts — an update, a power cut, the OOM killer. A code that
    // Studio or the installer read a minute ago has to still be the code, or a
    // finished install ends at "invalid_code" with no way forward.
    const rebooted = new PairingService(db, dataDir, log, access);
    await rebooted.boot();

    expect(readFileSync(path.join(dataDir, 'pairing-code'), 'utf8').trim()).toBe(code);
    const result = await rebooted.claim(code, 'Georgy');
    expect(result?.member.role).toBe('owner');
  });

  it('replays a claim whose response was lost, instead of calling it a bad code', async () => {
    const code = readFileSync(path.join(dataDir, 'pairing-code'), 'utf8').trim();
    const claimId = '9a7a72e7-90e6-4b1e-859a-902abf7e7c4a';

    const first = await pairing.claim(code, 'Georgy', 'Studio Mac', claimId);
    const resumed = await pairing.claim(code, 'Georgy', 'Studio Mac', claimId);

    expect(first).not.toBeNull();
    expect(resumed).toEqual(first);
    // A retry without the id still sees a spent code, as it should.
    expect(await pairing.claim(code, 'Mallory')).toBeNull();
  });

  it('lets only one of two simultaneous claims become the owner', async () => {
    const code = readFileSync(path.join(dataDir, 'pairing-code'), 'utf8').trim();
    const [a, b] = await Promise.all([
      pairing.claim(code, 'Georgy'),
      pairing.claim(code, 'Mallory'),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it('does not re-issue a boot code once claimed', async () => {
    const code = readFileSync(path.join(dataDir, 'pairing-code'), 'utf8').trim();
    await pairing.claim(code, 'Georgy');

    const rebooted = new PairingService(db, dataDir, log, access);
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
