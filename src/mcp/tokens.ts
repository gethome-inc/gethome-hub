import { and, desc, eq, isNull } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { mcpTokens } from '../db/schema.js';
import { generateToken, sha256Hex } from '../core/crypto.js';

/**
 * How stale `last_used_at` is allowed to get.
 *
 * The same hour `PairingService` uses, for the same reason: an assistant that
 * is answering questions makes a burst of calls, and writing a row for each of
 * them would be write amplification onto an SD card for a number a person
 * reads in units of days.
 */
const LAST_USED_RESOLUTION_MS = 60 * 60 * 1000;

/**
 * Prefix on every token this service mints.
 *
 * It exists so the string is recognisable where it ends up: not in a keychain
 * but pasted into `claude_desktop_config.json` or `~/.codex/config.toml`,
 * where somebody reading their own config months later has to be able to tell
 * what it belongs to. It is not a namespace and nothing parses it.
 */
const TOKEN_PREFIX = 'ghm_';

/** What a verified MCP token is allowed to be and do. */
export interface McpIdentity {
  tokenId: string;
  label: string;
  /** The member who minted it — whose name the activity log will carry. */
  memberId: string;
  /** Whether this connection may work the home, or only look at it. */
  canControl: boolean;
}

/** One connection, as the management route describes it. Never a secret. */
export interface McpTokenSummary {
  id: string;
  label: string;
  canControl: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export interface MintedMcpToken extends McpTokenSummary {
  /** The plaintext, returned exactly once and never stored. */
  token: string;
}

/**
 * The MCP server's credentials — minted, verified and revoked here and nowhere
 * else.
 *
 * Deliberately a sibling of `PairingService` rather than a method on it: these
 * tokens live in their own table (see `db/schema.ts`) precisely so that
 * `requireMember` can never accept one, and putting both mints behind one
 * class is how that separation would quietly stop being true.
 */
export class McpTokenService {
  constructor(private readonly db: Db) {}

  /**
   * Resolve a token to what it may do, or `null`.
   *
   * A revoked row answers `null` rather than being deleted, so the string a
   * client is still holding stops working the moment somebody says so, and the
   * person who revoked it can still see in the list what they turned off.
   */
  async verify(token: string): Promise<McpIdentity | null> {
    const row = await this.db.query.mcpTokens.findFirst({
      where: eq(mcpTokens.tokenHash, sha256Hex(token)),
    });
    if (!row || row.revokedAt !== null) return null;

    const last = row.lastUsedAt?.getTime() ?? 0;
    if (Date.now() - last > LAST_USED_RESOLUTION_MS) {
      try {
        await this.db
          .update(mcpTokens)
          .set({ lastUsedAt: new Date() })
          .where(eq(mcpTokens.id, row.id));
      } catch {
        // Never fail a request because a timestamp didn't stick.
      }
    }

    return {
      tokenId: row.id,
      label: row.label,
      memberId: row.memberId,
      canControl: row.canControl,
    };
  }

  /** The live connections, newest first. */
  async list(): Promise<McpTokenSummary[]> {
    const rows = await this.db.query.mcpTokens.findMany({
      where: isNull(mcpTokens.revokedAt),
      orderBy: [desc(mcpTokens.createdAt)],
    });
    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      canControl: row.canControl,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
    }));
  }

  async mint(input: {
    label: string;
    canControl: boolean;
    memberId: string;
  }): Promise<MintedMcpToken> {
    const token = TOKEN_PREFIX + generateToken();
    const createdAt = new Date();
    const [row] = await this.db
      .insert(mcpTokens)
      .values({
        label: input.label,
        memberId: input.memberId,
        tokenHash: sha256Hex(token),
        canControl: input.canControl,
        createdAt,
      })
      .returning({ id: mcpTokens.id });

    return {
      id: row!.id,
      label: input.label,
      canControl: input.canControl,
      createdAt,
      lastUsedAt: null,
      token,
    };
  }

  /** Returns false when there was no live token with that id to revoke. */
  async revoke(id: string): Promise<boolean> {
    const result = await this.db
      .update(mcpTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(mcpTokens.id, id), isNull(mcpTokens.revokedAt)))
      .returning({ id: mcpTokens.id });
    return result.length > 0;
  }
}
