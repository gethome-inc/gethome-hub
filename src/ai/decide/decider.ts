/**
 * The seam a decision model arrives at — no SDK, and no vendor.
 *
 * `agent-core.ts`'s rule and `chat/agent-loop.ts`'s rule, one subsystem over,
 * with one addition they do not need: this file names no URL, no header and no
 * field of anybody's API. A *decision* model is a different shape of thing from
 * the two generative seams beside it — it takes a state and a map of typed
 * questions and answers all of them in one parallel pass, returning values with
 * calibrated probabilities and never a sentence — so it gets its own interface
 * rather than a third implementation of `MappingProvider` or `ChatTransport`,
 * neither of which has anywhere to put "classify this".
 *
 * **Everything here is a skip-ahead over a path that already works.** No caller
 * may treat a decision as permission to do something it could not otherwise do:
 * an answer picks which of two roads the hub takes, and both roads end at the
 * same guards. `docs/jev.md` is canonical.
 */

/**
 * The model that answers, pinned in the build.
 *
 * **Not an alias.** `jev-latest` is the vendor's to re-point, and re-pointing
 * it would silently move the model every threshold in `questions.ts` was
 * calibrated against — calibration does not transfer, so a floating alias is a
 * config change nobody made. The same argument `models.ts` makes for naming a
 * dated id rather than a bare family.
 *
 * It lives in this file rather than in the vendor client so that *reporting*
 * which model answers — `GET /settings/ai`, `src/core/settings.ts` — never
 * loads a client a hub with no key has no use for. That is the only vendor
 * fact here, and it is a value rather than a contract.
 */
export const DECISION_MODEL = 'jev-1.13.0';

/** A yes/no judgement, answered with the probability that it holds. */
export interface NoulQuestion {
  readonly type: 'noul';
  readonly instructions: string;
}

/** One option from a set the caller defines. */
export interface ChoiceQuestion {
  readonly type: 'choice';
  readonly instructions: string;
  /** Option name → what it means. The names are the possible answers. */
  readonly criteria: Readonly<Record<string, string>>;
}

/** A position on an ordered rubric the caller defines. */
export interface ScoreQuestion {
  readonly type: 'score';
  readonly instructions: string;
  /** The levels, in order. The index is the score. */
  readonly criteria: readonly string[];
}

export type DecisionQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

/** Named questions, asked together. The ids are the caller's and are never sent. */
export type Questions = Readonly<Record<string, DecisionQuestion>>;

/**
 * The probability that a yes/no judgement holds.
 *
 * **There is no `confidence` beside it, and that is the API rather than an
 * omission here.** A noul near 0.5 means "as likely as not", never "medium
 * intensity" — code that reads `answer.confidence` on everything breaks on
 * exactly these, which is why this type does not have the field to read.
 */
export interface NoulAnswer {
  readonly type: 'noul';
  readonly noul: number;
}

/**
 * One option, with the whole distribution and how concentrated it is.
 *
 * `confidence` says how much the distribution agrees with itself — **not** the
 * probability that the answer is right, and not permission to act. Two
 * genuinely acceptable options spread the probability and lower it without
 * anything being wrong.
 */
export interface ChoiceAnswer<K extends string = string> {
  readonly type: 'choice';
  readonly choice: K;
  readonly probabilities: Readonly<Record<K, number>>;
  readonly confidence: number;
}

/** A position on the rubric, which may land between levels. */
export interface ScoreAnswer {
  readonly type: 'score';
  readonly score: number;
  readonly legend: Readonly<Record<string, string>>;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
}

export type DecisionAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

/**
 * The answer a given question shape produces.
 *
 * The choice arm narrows to the keys of that question's own `criteria`, which
 * is what makes a `switch` on an option the caller never offered a compile
 * error rather than a branch nobody takes. The client is what makes that type
 * true at runtime — see `typesafe.ts` on dropping an answer it cannot place.
 */
export type AnswerFor<Q extends DecisionQuestion> = Q extends NoulQuestion
  ? NoulAnswer
  : Q extends { readonly type: 'choice'; readonly criteria: infer C }
    ? ChoiceAnswer<Extract<keyof C, string>>
    : ScoreAnswer;

export interface DecisionResult<Q extends Questions> {
  /**
   * **Optional per question, on purpose.**
   *
   * A 200 that answered a subset is a real shape, and `answers.route!.choice`
   * is how that becomes `undefined` in somebody's kitchen. Every call site has
   * to carry a fallback, and leaving these optional is what makes the checker
   * enforce that rather than leaving it to discipline.
   */
  readonly answers: { readonly [K in keyof Q]?: AnswerFor<Q[K]> };
  readonly costUsd: number;
  readonly modelId: string;
  /** The vendor's own id for the request, for a log line that can be traced. */
  readonly requestId?: string | undefined;
  readonly durationMs: number;
}

/**
 * Why a decision came back empty — for a log line and a trail step, **never for
 * a branch**.
 *
 * Every miss falls back exactly the same way, which is what keeps `null` the
 * whole of `decide`'s contract; this only says which of the reasons it was, so
 * "why did the fast path not answer?" has an answer that is not a guess.
 *
 * - `off` — no key, or the owner has paused it. Nobody asked for an answer.
 * - `busy` — another call was in flight and this one gave way.
 * - `resting` — the breaker is open after repeated failures.
 * - `timeout` — nothing came back inside the deadline.
 * - `failed` — the request failed: refused, rate-limited or unreachable.
 */
export type DecisionMiss = 'off' | 'busy' | 'resting' | 'timeout' | 'failed';

/** What a decision cost, in the shape the ledger folds in. */
export interface DecisionUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface Decider {
  readonly modelId: string;
  /**
   * One request carrying every question, and **it never throws**.
   *
   * `null` is "no answer" — a refusal, a timeout, an open breaker, or a
   * request dropped because one was already in flight. Every caller falls back
   * to the path it had before, so a seam that threw would put a `try`/`catch`
   * at every call site instead of making fail-open a property of the type.
   * `ChatRuntime.bank`'s rule, one subsystem over.
   *
   * **Ask everything at once.** The questions are evaluated in parallel and
   * cannot see one another's answers, latency is roughly flat in their number,
   * and concurrent *requests* queue — so speculative branch questions belong
   * in this call rather than in a second one.
   */
  decide<Q extends Questions>(input: {
    state: string | Readonly<Record<string, unknown>> | readonly unknown[];
    questions: Q;
    timeoutMs: number;
    /**
     * Whether somebody is waiting for this.
     *
     * **`live` is the default, and the asymmetry is the point.** A speculation
     * is a guess about a sentence that has not finished, so it gives way to
     * anything real; a live call is the turn itself and must never be dropped
     * for a guess — which is exactly what a plain one-at-a-time rule does,
     * silently, to the third of spoken commands that happen to arrive while a
     * speculation is in flight.
     */
    priority?: 'live' | 'speculative';
    /**
     * Told why, when the answer is `null`. Informational only — see
     * `DecisionMiss` — so a decider that never calls it is still correct, and
     * a caller that ignores it loses a log line rather than a behaviour.
     */
    onMiss?: (why: DecisionMiss) => void;
  }): Promise<DecisionResult<Q> | null>;
}
