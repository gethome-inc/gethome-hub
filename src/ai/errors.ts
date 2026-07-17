/**
 * Failure taxonomy for AI mapping runs.
 *
 * Two classes of failure exist and they must never be conflated:
 *
 * - `AiUnavailableError` — the *account or service* is unavailable (rate
 *   limit, exhausted subscription window, bad credentials, capacity, network).
 *   These are transient: the mapper backs off and retries later, and nothing
 *   is cached — the device keeps its static mapping until the account works
 *   again.
 * - A plain `Error` / an invalid descriptor — the *run itself* failed. Only
 *   an invalid descriptor candidate is a permanent, cacheable outcome
 *   (`rejected` in `ai_mappings`); everything else is logged and retried on
 *   the next natural trigger.
 */

export type AiFailureKind =
  | 'rate_limited' // API 429 / too many requests
  | 'usage_limit' // subscription 5-hour/weekly window exhausted
  | 'auth_failed' // invalid or revoked key / expired OAuth token
  | 'billing' // out of credit / payment required
  | 'overloaded' // API 529 / capacity
  | 'network' // transport, spawn, or unclassified execution failure
  | 'aborted'; // the hub's own watchdog cancelled the run

export class AiUnavailableError extends Error {
  readonly kind: AiFailureKind;
  /** When the account is expected to work again, if the provider said so. */
  readonly resetAt: Date | undefined;

  constructor(kind: AiFailureKind, message: string, resetAt?: Date) {
    super(message);
    this.name = 'AiUnavailableError';
    this.kind = kind;
    this.resetAt = resetAt;
  }
}

// Order matters: subscription-limit wording ("usage limit", "session limit")
// also contains "limit", so it must be tested before the generic rate-limit
// patterns. All matching is heuristic — the Agent SDK surfaces API failures
// as error text, not structured codes (the structured `rate_limit_event`
// stream message is handled separately in agent.ts).
const USAGE_LIMIT = /usage limit|session limit|weekly limit|\b5-hour limit|limit reached|out of extra usage/i;
const RATE_LIMIT = /rate.?limit|\b429\b|too many requests|number of request/i;
const AUTH = /\b401\b|authentication|unauthorized|forbidden|invalid (?:api.?key|bearer|token)|api.?key.*invalid|token.*(?:expired|revoked)|expired.*token|oauth.*(?:error|invalid|expired)|please run \/login/i;
const BILLING = /\b402\b|billing|credit balance|insufficient credit|payment required|purchase credits/i;
const OVERLOADED = /\b529\b|overloaded|capacity constraints/i;
const NETWORK = /\benotfound\b|\beconnrefused\b|\betimedout\b|\beconnreset\b|fetch failed|network error|socket hang up/i;

/**
 * Classify an error/result text from an agent run into a transient
 * availability failure, or `null` when the text does not look like an
 * account/service problem (i.e. the run failed on its own merits).
 */
export function classifyAgentFailure(text: string): AiUnavailableError | null {
  if (USAGE_LIMIT.test(text)) {
    return new AiUnavailableError('usage_limit', text, parseResetHint(text));
  }
  if (RATE_LIMIT.test(text)) {
    return new AiUnavailableError('rate_limited', text, parseResetHint(text));
  }
  if (AUTH.test(text)) return new AiUnavailableError('auth_failed', text);
  if (BILLING.test(text)) return new AiUnavailableError('billing', text);
  if (OVERLOADED.test(text)) return new AiUnavailableError('overloaded', text);
  if (NETWORK.test(text)) return new AiUnavailableError('network', text);
  return null;
}

/**
 * Best-effort extraction of a "when does the limit reset" hint from the
 * provider's wording. Known shapes:
 *   "Claude AI usage limit reached|1752710400"          (unix seconds)
 *   "You've hit your session limit · resets 11pm (UTC)" (wall clock, UTC)
 *   "…resets at 07:30 (UTC)"
 */
export function parseResetHint(text: string, now: Date = new Date()): Date | undefined {
  const epoch = /\|(\d{9,13})\b/.exec(text);
  if (epoch) {
    const n = Number(epoch[1]);
    const date = new Date(n > 1e12 ? n : n * 1000);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  const clock = /resets(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text);
  if (clock) {
    const rawHour = Number(clock[1]);
    const minute = clock[2] ? Number(clock[2]) : 0;
    const meridiem = clock[3]?.toLowerCase();
    if (rawHour > 23 || minute > 59) return undefined;
    let hour = rawHour;
    if (meridiem === 'pm' && rawHour < 12) hour = rawHour + 12;
    if (meridiem === 'am' && rawHour === 12) hour = 0;
    // The provider phrases these in UTC; without a zone we still assume UTC —
    // an hour or two of skew only delays a retry, never breaks anything.
    const candidate = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute, 0, 0),
    );
    if (candidate.getTime() <= now.getTime()) candidate.setUTCDate(candidate.getUTCDate() + 1);
    return candidate;
  }
  return undefined;
}
