/**
 * Failure taxonomy for AI mapping runs.
 *
 * Two classes of failure exist and they must never be conflated:
 *
 * - `AiUnavailableError` — the *account or service* is unavailable (rate
 *   limit, exhausted account cap, bad credentials, capacity, network).
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
  | 'usage_limit' // an account-level usage or spend cap is exhausted
  | 'auth_failed' // invalid or revoked API key
  | 'billing' // out of credit / payment required
  | 'overloaded' // API 529 / capacity
  | 'network' // transport or unclassified execution failure
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

// Order matters: usage-cap wording ("usage limit", "spend limit") also
// contains "limit", so it must be tested before the generic rate-limit
// patterns. Text matching is now the *fallback* — `classifyApiError` below
// reads the HTTP status the Messages API actually returned, and only falls
// through to here for the cases a status code cannot separate (a 400 that is
// really an exhausted credit balance) or for errors that never reached HTTP.
const USAGE_LIMIT = /usage limit|spend limit|monthly limit|weekly limit|limit reached|quota exceeded/i;
const RATE_LIMIT = /rate.?limit|\b429\b|too many requests|number of request/i;
const AUTH = /\b401\b|\b403\b|authentication|unauthorized|forbidden|invalid (?:api.?key|bearer|token)|api.?key.*invalid|token.*(?:expired|revoked)|expired.*token/i;
const BILLING = /\b402\b|billing|credit balance|insufficient credit|payment required|purchase credits/i;
const OVERLOADED = /\b529\b|overloaded|capacity constraints/i;
const NETWORK = /\benotfound\b|\beconnrefused\b|\betimedout\b|\beconnreset\b|fetch failed|network error|socket hang up|connection error/i;

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
 * The parts of an Anthropic SDK error this module reads. Matched structurally
 * rather than with `instanceof` so the taxonomy stays testable with plain
 * objects and this file never has to import the SDK.
 */
interface ApiErrorLike {
  status?: unknown;
  headers?: unknown;
  message?: unknown;
}

/**
 * Classify a thrown Messages API error.
 *
 * The HTTP status is the primary signal and is far more reliable than the
 * text matching below it — that was only ever a workaround for the Agent
 * SDK, which relayed API failures as subprocess output with the status code
 * lost somewhere in the middle. Two statuses still need the text: a 400 can
 * be an exhausted credit balance (Anthropic reports that as an
 * `invalid_request_error`, not a 402), and an error that never reached HTTP
 * has no status at all.
 *
 * Returns `null` when the failure is not an account/service problem — a
 * malformed request is the hub's own bug, and arming a backoff gate over it
 * would hide it behind a retry timer.
 */
export function classifyApiError(error: unknown, now: Date = new Date()): AiUnavailableError | null {
  if (error === null || typeof error !== 'object') {
    return typeof error === 'string' ? classifyAgentFailure(error) : null;
  }
  const candidate = error as ApiErrorLike;
  const message = typeof candidate.message === 'string' ? candidate.message : String(error);
  const status = typeof candidate.status === 'number' ? candidate.status : undefined;
  const retryAfter = readRetryAfter(candidate.headers, now);

  if (status === 429) {
    // A 429 is a rate limit unless the body says an account cap is exhausted
    // — those want the provider's own reset time, not a short retry.
    const kind: AiFailureKind = USAGE_LIMIT.test(message) ? 'usage_limit' : 'rate_limited';
    return new AiUnavailableError(kind, message, retryAfter ?? parseResetHint(message, now));
  }
  if (status === 401 || status === 403) return new AiUnavailableError('auth_failed', message);
  if (status === 402) return new AiUnavailableError('billing', message);
  if (status === 529) return new AiUnavailableError('overloaded', message, retryAfter);
  if (status !== undefined && status >= 500) return new AiUnavailableError('overloaded', message, retryAfter);
  if (status === 400) {
    // Only a 400 that is really a billing problem is transient. Every other
    // 400 means the hub sent something the API rejected — surface it.
    return BILLING.test(message) ? new AiUnavailableError('billing', message) : null;
  }
  if (status !== undefined) return null;

  // No status: a transport failure, an aborted socket, or something the SDK
  // threw before it ever issued a request.
  return classifyAgentFailure(message) ?? new AiUnavailableError('network', message);
}

/**
 * `retry-after` is the provider telling us exactly when to come back, which
 * beats every heuristic in this file. Seconds or an HTTP date, from either a
 * `Headers` instance or a plain object.
 */
function readRetryAfter(headers: unknown, now: Date): Date | undefined {
  const raw = readHeader(headers, 'retry-after');
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return new Date(now.getTime() + seconds * 1000);
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function readHeader(headers: unknown, name: string): string | undefined {
  if (headers === null || typeof headers !== 'object') return undefined;
  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === 'function') {
    const value = (getter as (key: string) => unknown).call(headers, name);
    return typeof value === 'string' ? value : undefined;
  }
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() === name && typeof value === 'string') return value;
  }
  return undefined;
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
