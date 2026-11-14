import { z } from 'zod';

/**
 * Where a rule came from: who added it, and how it reached the hub.
 *
 * The question it answers is the one a shared home asks about a rule that
 * switches the hall light on at three in the morning — *who put that there?*
 * — and, for a rule nobody remembers adding, *did a person write this, or did
 * something?* The activity log answers both for thirty days and the version
 * notes for ten edits; a rule lives for years.
 *
 * Two facts, kept apart because they age differently:
 *
 *  - **who** is `automations.created_by`, a live reference: it follows a
 *    member's rename and empties when they leave the home, and nothing here
 *    keeps a copy of their name to outlive them;
 *  - **how** is `StoredOrigin`, written once at creation. It is a fact about
 *    one moment, so nothing afterwards changes it — an edit made in a chat
 *    does not make a template's rule a chat's.
 *
 * And the hub records only what it can see for itself. It knows the route a
 * rule arrived by and the credential that carried it; it does not know which
 * app was holding that credential, and `document` deliberately does not
 * pretend to.
 */

/**
 * How a rule reached the hub.
 *
 *  - `chat` — written in a conversation with the hub's own agent.
 *  - `template` — installed from a shipped template.
 *  - `document` — a rule document sent to `POST /automations`.
 *
 * **An open vocabulary on the wire**, the `commandFailed.kind` rule: an app
 * draws the kinds it knows and shows `sentence` for one it does not. It is
 * also open in the *store*, because `install.sh` rolls back after a migration
 * has run — a build may meet a word a newer one wrote, and has to carry it
 * through rather than drop the row's origin over it.
 */
export const ORIGIN_KINDS = ['chat', 'template', 'document'] as const;
export type OriginKind = (typeof ORIGIN_KINDS)[number];

/** What the `automations.origin` column holds. */
export interface StoredOrigin {
  kind: string;
  /** The template's key, for `template`. */
  template?: string;
  /**
   * The API key that sent it, when one did — beside `kind` rather than a kind
   * of its own, because a key can install a template as well as send a
   * document. The name is the key's name on the day, kept for the reason the
   * activity log copies names: the key may be gone by the time anybody asks.
   */
  apiKeyId?: string;
  apiKeyName?: string;
}

const storedOriginSchema = z.object({
  kind: z.string().min(1).max(40),
  template: z.string().min(1).max(60).optional(),
  apiKeyId: z.string().min(1).max(64).optional(),
  apiKeyName: z.string().min(1).max(200).optional(),
});

/**
 * Read the column back, tolerantly.
 *
 * Never throws and never refuses the rule: a row this build cannot make sense
 * of is a rule whose origin is unknown, which costs one line on one page. The
 * list of rules is not something an origin may take down.
 */
export function readStoredOrigin(raw: unknown): StoredOrigin | null {
  const parsed = storedOriginSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { kind, template, apiKeyId, apiKeyName } = parsed.data;
  return {
    kind,
    ...(template !== undefined ? { template } : {}),
    ...(apiKeyId !== undefined ? { apiKeyId } : {}),
    ...(apiKeyName !== undefined ? { apiKeyName } : {}),
  };
}

/**
 * An origin as this build writes one — a kind it knows. Reading is the open
 * half (`StoredOrigin`); writing is closed, so a new way of making a rule has
 * to add its word above rather than pass a string nobody has documented.
 */
export type NewOrigin = StoredOrigin & { kind: OriginKind };

/** The API key a request was made with, as an origin remembers it. */
export function originThroughKey(
  key: { id: string; name: string } | null | undefined,
): Pick<StoredOrigin, 'apiKeyId' | 'apiKeyName'> {
  return key ? { apiKeyId: key.id, apiKeyName: key.name } : {};
}

/**
 * A rule's origin as the apps read it.
 *
 * `sentence` is the only field that is always there, and it is the whole
 * answer in words — the `summary` rule, and the activity log's `message`. The
 * rest repeats it structured so an app can write its own line, and uses the
 * names an activity row already uses for the same things (`memberName`,
 * `via: "api"`, `apiKeyId`, `apiKeyName`, `template`), so there is one
 * vocabulary for "who did this" rather than two.
 */
export interface AutomationOriginWire {
  sentence: string;
  /** Absent on a rule from before the hub kept it. */
  kind?: string;
  /** Present while the member who added it is still in the home. */
  memberId?: string;
  memberName?: string;
  /** Present when an API key sent it — the three fields travel together. */
  via?: 'api';
  apiKeyId?: string;
  apiKeyName?: string;
  /** The template's key, and its title while this build still ships it. */
  template?: string;
  templateTitle?: string;
}

export interface OriginFacts {
  stored: StoredOrigin | null;
  /** `created_by`, resolved — null once that member has left the home. */
  member: { id: string; name: string } | null;
  /** The key's name as it is now, when the key still exists. */
  apiKeyName?: string;
  /** The template's title, when this build still ships that template. */
  templateTitle?: string;
}

/**
 * Put the two facts into one answer, or `null` when there is nothing to say.
 *
 * `null` is an honest answer and not an error: a rule from before the hub
 * kept this whose author has since left the home has no origin anybody can
 * state, and a sentence invented for it would be the one line on the page
 * that was never true.
 */
export function describeOrigin(facts: OriginFacts): AutomationOriginWire | null {
  const { stored, member } = facts;
  const throughKey = stored?.apiKeyId !== undefined || stored?.apiKeyName !== undefined;
  const keyName = throughKey ? (facts.apiKeyName ?? stored?.apiKeyName) : undefined;

  // The activity log's own way of naming a key beside its member.
  const quotedKey = keyName !== undefined ? `“${keyName}”` : null;
  const who = throughKey
    ? member
      ? quotedKey
        ? `${member.name}’s ${quotedKey}`
        : `an API key of ${member.name}’s`
      : quotedKey
        ? `the API key ${quotedKey}`
        : 'an API key'
    : (member?.name ?? null);

  const how =
    stored?.kind === 'chat'
      ? ' in a chat'
      : stored?.kind === 'template'
        ? facts.templateTitle !== undefined
          ? ` from the “${facts.templateTitle}” template`
          : ' from a template'
        : '';

  if (who === null && how === '') return null;
  const sentence = who !== null ? `Added by ${who}${how}` : `Added${how}`;

  return {
    sentence,
    ...(stored ? { kind: stored.kind } : {}),
    ...(member ? { memberId: member.id, memberName: member.name } : {}),
    ...(throughKey ? { via: 'api' as const } : {}),
    ...(stored?.apiKeyId !== undefined ? { apiKeyId: stored.apiKeyId } : {}),
    ...(keyName !== undefined ? { apiKeyName: keyName } : {}),
    ...(stored?.template !== undefined ? { template: stored.template } : {}),
    ...(stored?.kind === 'template' && facts.templateTitle !== undefined
      ? { templateTitle: facts.templateTitle }
      : {}),
  };
}
