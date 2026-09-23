/**
 * The decider a caller actually holds: fail-open, bounded, and behind a
 * dynamic import.
 *
 * `src/ai/lazy.ts`'s shape and `chat/transport.ts`'s import. The honest reason
 * for the dynamic import is `lazy.ts`'s **second** property rather than bundle
 * size: the credential is read on every call, so a key saved later works with
 * no restart, and a hub with no key never constructs a client at all.
 *
 * Everything that makes "an outage is invisible" true lives here, in one
 * place, because `Decider.decide` promises never to throw and a promise kept at every
 * call site is a promise that eventually is not.
 */
import { createHash } from 'node:crypto';
import type { SettingsService } from '../../core/settings.js';
import type { Logger } from '../../logging.js';
import type { DecisionTransport } from './connection.js';
import {
  DECISION_MODEL,
  type Decider,
  type DecisionMiss,
  type DecisionMissDetail,
  type DecisionResult,
  type Questions,
} from './decider.js';

/**
 * How long the breaker stays open, and how many failures open it.
 *
 * **A breaker rather than a retry.** The vendor's contract says to back off on
 * 429 and 529, and as policy here that would be exactly wrong: these calls sit
 * in front of somebody waiting, so a retry turns a 180 ms saving into a
 * two-second regression. One request, one short deadline, then today's path.
 * What the breaker adds is that a revoked key stops costing every turn a full
 * timeout — "invisible" has to mean *no added latency*, not merely no error.
 */
const BREAKER_FAILURES = 3;
const BREAKER_OPEN_MS = 60_000;

/**
 * The credential a judgement was made about.
 *
 * `mapper.ts`'s backoff-gate rule: a gate that outlives the account it was
 * armed against is a gate that silences the fix. Keyed on the secret, so
 * saving a new key retires it with no channel from the settings routes to keep
 * in step.
 */
function credentialId(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 16);
}

export function lazyDecider(options: {
  settings: SettingsService;
  log: Logger;
  /**
   * What carries the requests. The kept-alive connection unless a test hands
   * in its own — which stands in for the network and nothing else, the
   * `createConversation` rule.
   */
  transport?: DecisionTransport;
}): Decider {
  let breaker: { credential: string; failures: number; openUntil: number } | undefined;
  /**
   * How many requests are out right now.
   *
   * **A count, not a slot, and nothing in flight is ever aborted.** The first
   * version ran one call at a time and aborted a speculation when a live call
   * arrived — and aborting a request mid-flight destroys the connection under
   * it, so the live call that was supposed to be helped then paid for a fresh
   * handshake instead. Now a live call simply goes, alongside whatever is out.
   */
  let inFlight = 0;
  let warming: Promise<void> | undefined;

  const transport = async (): Promise<DecisionTransport> =>
    options.transport ?? (await import('./connection.js')).keepAliveTransport;

  /** The key, when a decision may be made at all. */
  async function credential(): Promise<string | null> {
    const ai = await options.settings.getAiSettings();
    if (!ai.decision.hasKey || !ai.decision.enabled) return null;
    return options.settings.aiKey('typesafe');
  }

  async function decide<Q extends Questions>(input: {
    state: string | Readonly<Record<string, unknown>> | readonly unknown[];
    questions: Q;
    timeoutMs: number;
    priority?: 'live' | 'speculative';
    onMiss?: (why: DecisionMiss, detail?: DecisionMissDetail) => void;
  }): Promise<DecisionResult<Q> | null> {
    const priority = input.priority ?? 'live';
    // Every `null` below says which one it is. Told, never branched on — see
    // `DecisionMiss`.
    const miss = (why: DecisionMiss, detail?: DecisionMissDetail): null => {
      input.onMiss?.(why, detail);
      return null;
    };
    /**
     * **A guess gives way; the real thing never does.**
     *
     * A speculation is a reading of a sentence somebody is still saying, so
     * while anything else is out it is simply dropped — dropped rather than
     * queued, because a queued decision arrives after the thing it was
     * deciding. A live call is the turn itself and always goes: it is never
     * dropped for a speculation, and never turned away because a second
     * person in the house is talking to it at the same moment.
     */
    if (priority === 'speculative' && inFlight > 0) return miss('busy');

    const secret = await credential();
    if (secret === null) return miss('off');

    const id = credentialId(secret);
    if (breaker !== undefined && breaker.credential !== id) breaker = undefined;
    if (breaker !== undefined && Date.now() < breaker.openUntil) return miss('resting');

    const wire = await transport();
    // Asked before the request is sent: once it is out, the socket it took is
    // no longer free, so "was there one?" can only be answered now.
    const newConnection = !wire.isWarm();
    inFlight += 1;
    try {
      const { runDecision } = await import('./typesafe.js');
      const result = await runDecision({
        secret,
        state: input.state,
        questions: input.questions,
        timeoutMs: input.timeoutMs,
        fetch: wire.fetch,
        log: options.log,
      });
      breaker = undefined;
      return { ...result, newConnection };
    } catch (error) {
      const failures = (breaker?.credential === id ? breaker.failures : 0) + 1;
      breaker = {
        credential: id,
        failures,
        openUntil: failures >= BREAKER_FAILURES ? Date.now() + BREAKER_OPEN_MS : 0,
      };
      // Read by name: `typesafe.ts` is only ever held behind the import above,
      // and a static import of its class would load the client on a hub with
      // no key.
      const timedOut = error instanceof Error && error.name === 'DecisionTimeoutError';
      options.log.warn(
        { err: error, failures, priority, newConnection },
        timedOut
          ? 'decision model did not answer in time — falling back to the ordinary path'
          : 'decision model unavailable — falling back to the ordinary path',
      );
      return miss(timedOut ? 'timeout' : 'failed', { newConnection });
    } finally {
      inFlight -= 1;
    }
  }

  /**
   * Open the connection before anybody is waiting on it.
   *
   * **The first sentence was the slow one**, every time: the connection a
   * decision needs had been closed for minutes, so what somebody noticed as
   * "Jev is slow" was the hub dialling a vendor from a Pi. The assistant's page
   * opening is the moment somebody is about to ask something, and a warm-up
   * then costs nothing a person can see.
   *
   * It does nothing without a key, while the owner has decisions paused, while
   * the breaker is resting, when a connection is already open, or while
   * anything is out — and it never throws.
   */
  async function warm(): Promise<void> {
    if (warming !== undefined) return warming;
    warming = (async () => {
      try {
        const secret = await credential();
        if (secret === null) return;
        if (breaker !== undefined && Date.now() < breaker.openUntil) return;
        const wire = await transport();
        if (inFlight > 0 || wire.isWarm()) return;
        const { warmConnection } = await import('./connection.js');
        await warmConnection({ secret, transport: wire });
      } catch {
        // A warm-up is a convenience. The decision after it dials as it would have.
      }
    })().finally(() => {
      warming = undefined;
    });
    return warming;
  }

  return { modelId: DECISION_MODEL, decide, warm };
}
