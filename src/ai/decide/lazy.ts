/**
 * The decider a caller actually holds: fail-open, single-flight, and behind a
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
import { DECISION_MODEL, type Decider, type DecisionResult, type Questions } from './decider.js';

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

export function lazyDecider(options: { settings: SettingsService; log: Logger }): Decider {
  let breaker: { credential: string; failures: number; openUntil: number } | undefined;
  /**
   * The one call in flight, if there is one, and what it is worth.
   *
   * One at a time hub-wide, because concurrent requests queue at the other end
   * anyway — but *which* one gives way is a decision rather than a race. See
   * `decide`.
   */
  let inFlight: { priority: 'live' | 'speculative'; stop: AbortController } | undefined;

  async function decide<Q extends Questions>(input: {
    state: string | Readonly<Record<string, unknown>> | readonly unknown[];
    questions: Q;
    timeoutMs: number;
    priority?: 'live' | 'speculative';
  }): Promise<DecisionResult<Q> | null> {
    const priority = input.priority ?? 'live';
    /**
     * **Dropped, not queued — and a guess gives way to the real thing.**
     *
     * A queued decision arrives after the thing it was deciding, which is
     * `Request superseded` one subsystem over: a newer ask taking this one's
     * place is not a failure, and waiting for a slot is the one behaviour that
     * could make this slower than not having it at all.
     *
     * The asymmetry is what was missing. A speculation runs on a sentence
     * somebody is still saying, so it steps aside for anything real; a live
     * call is the turn itself. Treating them alike meant a speculation in
     * flight silently took the fast path away from the very command it was
     * started for — the feature making the thing it helps slower.
     */
    if (inFlight !== undefined) {
      if (priority === 'speculative' || inFlight.priority === 'live') return null;
      inFlight.stop.abort();
    }

    const ai = await options.settings.getAiSettings();
    if (!ai.decision.hasKey || !ai.decision.enabled) return null;
    const secret = await options.settings.aiKey('typesafe');
    if (secret === null) return null;

    const credential = credentialId(secret);
    if (breaker !== undefined && breaker.credential !== credential) breaker = undefined;
    if (breaker !== undefined && Date.now() < breaker.openUntil) return null;

    const stop = new AbortController();
    inFlight = { priority, stop };
    try {
      const { runDecision } = await import('./typesafe.js');
      const result = await runDecision({
        secret,
        state: input.state,
        questions: input.questions,
        timeoutMs: input.timeoutMs,
        signal: stop.signal,
        log: options.log,
      });
      breaker = undefined;
      return result;
    } catch (error) {
      // A speculation a live call overtook is not a failure of anything, and
      // must not count towards the breaker — otherwise a talkative minute
      // would open it against a perfectly good key.
      if (stop.signal.aborted && priority === 'speculative') return null;
      const failures = (breaker?.credential === credential ? breaker.failures : 0) + 1;
      breaker = {
        credential,
        failures,
        openUntil: failures >= BREAKER_FAILURES ? Date.now() + BREAKER_OPEN_MS : 0,
      };
      options.log.warn(
        { err: error, failures },
        'decision model unavailable — falling back to the ordinary path',
      );
      return null;
    } finally {
      // Only if it is still *this* call's: a live call that overtook a
      // speculation has already replaced the entry, and the loser clearing it
      // on the way out would leave the winner unguarded.
      if (inFlight?.stop === stop) inFlight = undefined;
    }
  }

  return { modelId: DECISION_MODEL, decide };
}
