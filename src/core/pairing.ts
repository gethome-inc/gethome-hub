import { and, eq, gt, isNull } from 'drizzle-orm';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/client.js';
import { invites, members, tokens } from '../db/schema.js';
import { generateNumericCode, generateToken, sha256Hex } from './crypto.js';
import type { AccessService } from './access.js';
import type { Logger } from '../logging.js';

/**
 * The legacy two-word vocabulary, kept because `members.role` is kept.
 *
 * What a member may actually do comes from `AccessService` and the role row
 * `roleId` points at — a home can have as many roles as it likes. This says
 * only "is this the owner", which is still a real question: the owner cannot
 * be removed, cannot have its role changed, and is answered `true` by every
 * permission check without a table being read.
 */
export type MemberRole = 'owner' | 'member';

export interface Member {
  id: string;
  name: string;
  role: MemberRole;
  /** The role row this member holds; null on a row an older build wrote. */
  roleId: string | null;
}

export interface ClaimResult {
  token: string;
  member: Member;
}

const INVITE_TTL_MS = 15 * 60 * 1000;
const CLAIM_REPLAY_TTL_MS = 5 * 60 * 1000;
const LAST_USED_RESOLUTION_MS = 60 * 60 * 1000;

/**
 * Pairing-code claim flow:
 *
 * - While the hub has no owner, boot makes sure an 8-digit pairing code exists,
 *   logs it, and keeps it in <dataDir>/pairing-code so installers (the Studio
 *   app, `gethome-hubctl`) can surface it.
 * - The first successful `claim` with that code creates the `owner` member
 *   and invalidates the code.
 * - Owners mint short-lived invite codes; claiming one creates a `member`.
 * - Tokens are opaque 32-byte values returned in plaintext exactly once;
 *   only their sha256 is stored.
 *
 * **The code survives restarts on purpose.** It used to be re-minted on every
 * boot, which meant any code that had been read — the `@@PAIRING@@` marker from
 * the install, or a value Studio fetched over SSH a minute ago — was a
 * different number by the time somebody pressed Claim. On a small board where
 * the hub restarts (an update, an OOM kill, a power cut) that turned a finished
 * install into `invalid_code` with nothing the user could do about it. Rotation
 * bought nothing either: the code only ever proves physical access to the
 * machine, and reading the file *is* that access. So the file is now the source
 * of truth, and it is deleted the moment the hub is claimed.
 */
export class PairingService {
  private bootCode: string | null = null;

  /**
   * Claims write to the database and invalidate the code. Serialising them
   * stops two overlapping requests both becoming owner while the first insert
   * is still in flight.
   */
  private claimQueue: Promise<unknown> = Promise.resolve();

  /**
   * A claim that succeeded on the hub but whose response never arrived — a
   * timeout on a busy Pi, a Wi-Fi blip — used to look identical to a wrong
   * code, because the retry found the code already spent. A client that sends
   * the same opaque `claimId` twice gets the same answer twice instead.
   */
  private readonly recentClaims = new Map<string, { result: ClaimResult; expiresAt: number }>();

  /** Called when the hub gains its owner, so mDNS can re-publish `claimed`. */
  onClaimed?: () => void;

  constructor(
    private readonly db: Db,
    private readonly dataDir: string,
    private readonly log: Logger,
    /**
     * Who may do what. Claiming has to write `role_id`, not only the legacy
     * word, and the new member has to be in the in-memory map before their
     * first request — which arrives immediately, since the token is handed
     * back by this very call.
     */
    private readonly access: AccessService,
  ) {}

  async boot(): Promise<void> {
    const owner = await this.db.query.members.findFirst({ where: eq(members.role, 'owner') });
    if (owner) {
      this.clearBootCode();
      return;
    }
    this.bootCode = this.readStoredCode() ?? this.mintAndStoreCode();
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
    const work = this.claimQueue.then(
      () => this.claimSerialized(code, memberName, deviceName, claimId),
      () => this.claimSerialized(code, memberName, deviceName, claimId),
    );
    // The queue must not reject, or every later claim inherits the failure.
    this.claimQueue = work.catch(() => undefined);
    return work;
  }

  private async claimSerialized(
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
      const ownerRoleId = this.access.builtinRoleId('owner') ?? null;
      const [owner] = await this.db
        .insert(members)
        .values({ name: memberName, role: 'owner', roleId: ownerRoleId })
        .returning();
      if (!owner) return null;
      this.access.noteMember(owner.id, ownerRoleId);
      this.clearBootCode();
      this.log.info(`Hub claimed by owner "${memberName}".`);
      this.onClaimed?.();
      return this.rememberClaim(
        claimId,
        await this.issueToken(owner.id, owner.name, 'owner', ownerRoleId, deviceName),
      );
    }

    // Claimed hub: the code must match a live, unused invite.
    const codeHash = sha256Hex(normalized);
    const invite = await this.db.query.invites.findFirst({
      where: and(eq(invites.codeHash, codeHash), isNull(invites.usedBy), gt(invites.expiresAt, new Date())),
    });
    if (!invite) return null;
    // The invite names the role. A code minted before roles existed carries
    // only the legacy word, and `member` is what that has always meant.
    const roleRecord =
      (invite.roleId ? this.access.role(invite.roleId) : undefined) ??
      this.access.roleByKeyName(invite.role === 'owner' ? 'owner' : 'member');
    const roleId = roleRecord?.id ?? null;
    const role = roleRecord?.key === 'owner' ? 'owner' : 'member';
    const [member] = await this.db
      .insert(members)
      .values({ name: memberName, role, roleId })
      .returning();
    if (!member) return null;
    this.access.noteMember(member.id, roleId);
    await this.db.update(invites).set({ usedBy: member.id }).where(eq(invites.id, invite.id));
    this.log.info(`Member "${memberName}" joined via invite as ${roleRecord?.name ?? role}.`);
    return this.rememberClaim(
      claimId,
      await this.issueToken(member.id, member.name, role, roleId, deviceName),
    );
  }

  /**
   * Mint an invite code, for a role.
   *
   * `invites.role` has carried a role since the first migration and the claim
   * path has honoured it just as long — the route simply never passed one, so
   * every invite was a `member` invite. `roleId` is the real answer now and
   * the word beside it is the rollback mirror, exactly as on `members`.
   */
  async createInvite(
    createdBy: string,
    roleId?: string,
  ): Promise<{ code: string; expiresAt: Date; roleId: string | null }> {
    const code = generateNumericCode();
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    const role = roleId ? this.access.role(roleId) : undefined;
    const resolved = role?.id ?? this.access.builtinRoleId('member') ?? null;
    await this.db.insert(invites).values({
      codeHash: sha256Hex(code),
      role: role?.key === 'owner' ? 'owner' : 'member',
      roleId: resolved,
      createdBy,
      expiresAt,
    });
    return { code, expiresAt, roleId: resolved };
  }

  /** Resolve a bearer token to its member, refreshing last_used_at now and then. */
  async verifyToken(token: string): Promise<Member | null> {
    const row = await this.db.query.tokens.findFirst({ where: eq(tokens.tokenHash, sha256Hex(token)) });
    if (!row) return null;
    const member = await this.db.query.members.findFirst({ where: eq(members.id, row.memberId) });
    if (!member) return null;
    // Every authenticated request would otherwise write a row. "Last used" is
    // shown to a human in units of days; an hour's resolution is plenty, and
    // this runs on a machine whose disk is an SD card.
    const last = row.lastUsedAt?.getTime() ?? 0;
    if (Date.now() - last > LAST_USED_RESOLUTION_MS) {
      try {
        await this.db.update(tokens).set({ lastUsedAt: new Date() }).where(eq(tokens.id, row.id));
      } catch {
        // Never fail a request because a timestamp didn't stick.
      }
    }
    return {
      id: member.id,
      name: member.name,
      role: member.role === 'owner' ? 'owner' : 'member',
      roleId: member.roleId,
    };
  }

  private async issueToken(
    memberId: string,
    memberName: string,
    role: MemberRole,
    roleId: string | null,
    deviceName?: string,
  ): Promise<ClaimResult> {
    const token = generateToken();
    await this.db.insert(tokens).values({
      memberId,
      tokenHash: sha256Hex(token),
      deviceName: deviceName ?? null,
    });
    return { token, member: { id: memberId, name: memberName, role, roleId } };
  }

  private get codeFile(): string {
    return path.join(this.dataDir, 'pairing-code');
  }

  private readStoredCode(): string | null {
    try {
      if (!existsSync(this.codeFile)) return null;
      const stored = readFileSync(this.codeFile, 'utf8').replace(/\D/g, '');
      return stored.length >= 6 ? stored : null;
    } catch {
      return null;
    }
  }

  private mintAndStoreCode(): string {
    const code = generateNumericCode();
    mkdirSync(this.dataDir, { recursive: true });
    writeFileSync(this.codeFile, code + '\n', { mode: 0o600 });
    return code;
  }

  private clearBootCode(): void {
    this.bootCode = null;
    rmSync(this.codeFile, { force: true });
  }

  private rememberClaim(claimId: string | undefined, result: ClaimResult): ClaimResult {
    if (claimId) {
      this.recentClaims.set(claimId, { result, expiresAt: Date.now() + CLAIM_REPLAY_TTL_MS });
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
