import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/client.js';
import { invites, members, tokens } from '../db/schema.js';
import { generateNumericCode, generateToken, sha256Hex } from './crypto.js';
import type { Logger } from '../logging.js';

export type MemberRole = 'owner' | 'member';

export interface Member {
  id: string;
  name: string;
  role: MemberRole;
}

export interface ClaimResult {
  token: string;
  member: Member;
}

const INVITE_TTL_MS = 15 * 60 * 1000;

/**
 * Pairing-code claim flow:
 *
 * - While the hub has no owner, boot generates an 8-digit pairing code,
 *   logs it, and writes it to <dataDir>/pairing-code so installers (the
 *   Studio app, install.sh) can surface it.
 * - The first successful `claim` with that code creates the `owner` member
 *   and invalidates the boot code.
 * - Owners mint short-lived invite codes; claiming one creates a `member`.
 * - Tokens are opaque 32-byte values returned in plaintext exactly once;
 *   only their sha256 is stored.
 */
export class PairingService {
  private bootCode: string | null = null;
  /**
   * Claims change the database and invalidate the boot code. Serializing them
   * prevents two overlapping HTTP requests from both becoming the owner while
   * the first insert is waiting on Postgres.
   */
  private claimQueue: Promise<void> = Promise.resolve();
  /**
   * URLSession can time out after the Pi has already committed the owner and
   * before its response reaches Studio. Retaining the response briefly turns a
   * retry with the same opaque claim id into a safe resume instead of an
   * alarming `invalid_code` dead end. The token remains memory-only, exactly as
   * it is during the original response.
   */
  private readonly recentClaims = new Map<string, { result: ClaimResult; expiresAt: number }>();

  constructor(
    private readonly db: Db,
    private readonly dataDir: string,
    private readonly log: Logger,
  ) {}

  async boot(): Promise<void> {
    const owner = await this.db.query.members.findFirst({ where: eq(members.role, 'owner') });
    if (owner) {
      this.clearBootCode();
      return;
    }
    this.bootCode = generateNumericCode();
    mkdirSync(this.dataDir, { recursive: true });
    writeFileSync(path.join(this.dataDir, 'pairing-code'), this.bootCode + '\n', { mode: 0o600 });
    this.log.info(
      `Hub is unclaimed. Pairing code: ${this.bootCode} — enter it in the GetHome app to become the owner.`,
    );
  }

  get claimed(): boolean {
    return this.bootCode === null;
  }

  async claim(
    code: string,
    memberName: string,
    deviceName?: string,
    claimId?: string,
  ): Promise<ClaimResult | null> {
    const work = this.claimQueue.then(() => this.claimUnlocked(code, memberName, deviceName, claimId));
    this.claimQueue = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  }

  private async claimUnlocked(
    code: string,
    memberName: string,
    deviceName?: string,
    claimId?: string,
  ): Promise<ClaimResult | null> {
    this.dropExpiredClaims();
    if (claimId) {
      const previous = this.recentClaims.get(claimId);
      if (previous) return previous.result;
    }
    const normalized = code.replace(/\D/g, '');

    if (this.bootCode !== null) {
      if (normalized !== this.bootCode) return null;
      const [owner] = await this.db
        .insert(members)
        .values({ name: memberName, role: 'owner' })
        .returning();
      if (!owner) return null;
      this.clearBootCode();
      this.log.info(`Hub claimed by owner "${memberName}".`);
      return this.rememberClaim(claimId, await this.issueToken(owner.id, owner.name, 'owner', deviceName));
    }

    // Claimed hub: the code must match a live, unused invite.
    const codeHash = sha256Hex(normalized);
    const invite = await this.db.query.invites.findFirst({
      where: and(eq(invites.codeHash, codeHash), isNull(invites.usedBy), gt(invites.expiresAt, sql`now()`)),
    });
    if (!invite) return null;
    const role = invite.role === 'owner' ? 'owner' : 'member';
    const [member] = await this.db.insert(members).values({ name: memberName, role }).returning();
    if (!member) return null;
    await this.db.update(invites).set({ usedBy: member.id }).where(eq(invites.id, invite.id));
    this.log.info(`Member "${memberName}" joined via invite.`);
    return this.rememberClaim(claimId, await this.issueToken(member.id, member.name, role, deviceName));
  }

  async createInvite(createdBy: string, role: MemberRole = 'member'): Promise<{ code: string; expiresAt: Date }> {
    const code = generateNumericCode();
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    await this.db.insert(invites).values({
      codeHash: sha256Hex(code),
      role,
      createdBy,
      expiresAt,
    });
    return { code, expiresAt };
  }

  /** Resolve a bearer token to its member, updating last_used_at. */
  async verifyToken(token: string): Promise<Member | null> {
    const row = await this.db.query.tokens.findFirst({ where: eq(tokens.tokenHash, sha256Hex(token)) });
    if (!row) return null;
    const member = await this.db.query.members.findFirst({ where: eq(members.id, row.memberId) });
    if (!member) return null;
    void this.db
      .update(tokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(tokens.id, row.id))
      .catch(() => {});
    return { id: member.id, name: member.name, role: member.role as MemberRole };
  }

  private async issueToken(
    memberId: string,
    memberName: string,
    role: MemberRole,
    deviceName?: string,
  ): Promise<ClaimResult> {
    const token = generateToken();
    await this.db.insert(tokens).values({
      memberId,
      tokenHash: sha256Hex(token),
      deviceName: deviceName ?? null,
    });
    return { token, member: { id: memberId, name: memberName, role } };
  }

  private clearBootCode(): void {
    this.bootCode = null;
    rmSync(path.join(this.dataDir, 'pairing-code'), { force: true });
  }

  private rememberClaim(claimId: string | undefined, result: ClaimResult): ClaimResult {
    if (claimId) {
      this.recentClaims.set(claimId, { result, expiresAt: Date.now() + 5 * 60 * 1000 });
    }
    return result;
  }

  private dropExpiredClaims(): void {
    const now = Date.now();
    for (const [id, claim] of this.recentClaims) {
      if (claim.expiresAt <= now) this.recentClaims.delete(id);
    }
  }
}
