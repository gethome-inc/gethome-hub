/**
 * The only file that names TypeSafe's API.
 *
 * `voice/live-wire.ts`'s containment rule, for the same reason: this is the
 * one thing here nobody can check by running the suite, so the wire lives in a
 * file small enough to read in one go and the rest of the subsystem talks to
 * `Decider`. Plain `fetch` and **no dependency** — `src/ai/CLAUDE.md` refuses a
 * second SDK for a Pi to download, twice over, and a decision model is a POST
 * with a JSON body.
 *
 * It **throws**; `lazy.ts` is what turns a failure into `null`. Splitting them
 * that way is what lets the wrapper classify the throw, arm its breaker and
 * fail open in one place rather than at every call site.
 */
import { classifyApiError } from '../errors.js';
import type { Logger } from '../../logging.js';
import {
  DECISION_MODEL,
  type DecisionQuestion,
  type DecisionResult,
  type Questions,
} from './decider.js';

const DECISION_URL = 'https://api.typesafe.ai/v1/systemone';

/**
 * $0.042 per million input tokens, read 2026-09-22; **output is free**.
 *
 * Reported and not billed, so the estimate counts input alone — folding free
 * tokens into a cost would make this the one number in the ledger that was
 * never true of anything, which is the rule `ai_runs.effort` already follows
 * for null. A published price in one file with a date on it is the
 * `gpt-5.6-sol` precedent.
 */
const DECISION_INPUT_PER_MTOK = 0.042;

/**
 * How much state one request may carry, in characters.
 *
 * Far below the API's own 32k-token ceiling, and the bound is about
 * **accuracy** rather than the cap: this model's documented failure is that
 * accuracy falls as the state fills with content unrelated to the question, so
 * the useful limit is reached long before the refusal is. Filter in code
 * first.
 */
export const MAX_STATE_CHARS = 8_000;

export function estimateDecisionCostUsd(usage: { inputTokens: number }): number {
  return (usage.inputTokens / 1_000_000) * DECISION_INPUT_PER_MTOK;
}

/** Raised when the state is too big. Deliberately not an availability failure. */
export class DecisionStateTooLargeError extends Error {
  constructor(chars: number) {
    super(`decision state is ${chars} characters, over the ${MAX_STATE_CHARS} bound`);
    this.name = 'DecisionStateTooLargeError';
  }
}

interface WireUsage {
  input_tokens?: unknown;
  output_tokens?: unknown;
}

interface WireBody {
  model?: unknown;
  answers?: unknown;
  usage?: WireUsage;
}

/** The request body, which is the questions exactly as the caller wrote them. */
function wireQuestions(questions: Questions): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(questions)) {
    out[id] =
      question.type === 'noul'
        ? { type: 'noul', instructions: question.instructions }
        : { type: question.type, instructions: question.instructions, criteria: question.criteria };
  }
  return out;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function probabilities(value: unknown): Record<string, number> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const probability = finite(raw);
    if (probability === undefined) return undefined;
    out[key] = probability;
  }
  return out;
}

/**
 * Turn one raw answer into the typed one, or **drop it**.
 *
 * The types say a choice is one of the keys the caller offered and a noul is a
 * probability. This function is what makes that true at runtime: an answer it
 * cannot place is left `undefined` rather than coerced into something the
 * caller's `switch` has no arm for. `test/ai-openai-chat.test.ts`'s rule —
 * a mock laxer than the thing it stands in for tests the mock — pointed at the
 * vendor instead of at a stub.
 */
function readAnswer(question: DecisionQuestion, raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  if (value['type'] !== question.type) return undefined;

  if (question.type === 'noul') {
    const noul = finite(value['noul']);
    if (noul === undefined || noul < 0 || noul > 1) return undefined;
    return { type: 'noul', noul };
  }

  const confidence = finite(value['confidence']);
  const spread = probabilities(value['probabilities']);
  if (confidence === undefined || spread === undefined) return undefined;

  if (question.type === 'choice') {
    const choice = value['choice'];
    // The answer space is the caller's. A name outside it is not an answer.
    if (typeof choice !== 'string' || !(choice in question.criteria)) return undefined;
    return { type: 'choice', choice, probabilities: spread, confidence };
  }

  const score = finite(value['score']);
  if (score === undefined || score < 0 || score > question.criteria.length - 1) return undefined;
  const legend: Record<string, string> = {};
  question.criteria.forEach((level, index) => {
    legend[String(index)] = level;
  });
  return { type: 'score', score, legend, probabilities: spread, confidence };
}

/**
 * One request, every question in it.
 *
 * **Never fan out.** Latency is roughly flat in the number of questions and
 * concurrent requests queue behind one another, so two calls cost more than
 * one call with twice the questions — which is the whole reason speculative
 * branch questions are affordable.
 */
export async function runDecision<Q extends Questions>(input: {
  secret: string;
  state: string | Readonly<Record<string, unknown>> | readonly unknown[];
  questions: Q;
  timeoutMs: number;
  /** Cancelled from outside — a speculation giving way to a live call. */
  signal?: AbortSignal;
  log: Logger;
}): Promise<DecisionResult<Q>> {
  const state = typeof input.state === 'string' ? input.state : JSON.stringify(input.state);
  // **Refused, never truncated.** A cut state produces a confident answer to a
  // question about something else, which is worse than no answer at all.
  if (state.length > MAX_STATE_CHARS) throw new DecisionStateTooLargeError(state.length);

  const started = Date.now();
  const controller = new AbortController();
  const watchdog = setTimeout(() => controller.abort(), input.timeoutMs);
  // The caller's own reason to stop, folded into the same controller as the
  // deadline: a speculation that a live call has overtaken is cancelled the
  // same way a slow one is, and the request never reaches the network twice.
  const relay = () => controller.abort();
  input.signal?.addEventListener('abort', relay, { once: true });
  if (input.signal?.aborted === true) controller.abort();
  let response: Response;
  try {
    response = await fetch(DECISION_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.secret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: DECISION_MODEL,
        state: input.state,
        questions: wireQuestions(input.questions),
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(watchdog);
    input.signal?.removeEventListener('abort', relay);
  }

  const requestId = response.headers.get('x-typesafe-request-id') ?? undefined;
  const text = await response.text();
  if (!response.ok) {
    // Straight into the existing classifier, which branches on the status
    // rather than on any vendor's vocabulary — which is exactly why it works
    // for one it has never been pointed at. A 422 is our own malformed
    // question and comes back `null`, so it cannot hide behind a retry timer.
    throw (
      classifyApiError({
        status: response.status,
        headers: response.headers,
        message: text.slice(0, 500),
      }) ?? new Error(`decision request failed: ${response.status} ${text.slice(0, 200)}`)
    );
  }

  let body: WireBody;
  try {
    body = JSON.parse(text) as WireBody;
  } catch {
    throw new Error('decision response was not JSON');
  }

  const raw = (body.answers ?? {}) as Record<string, unknown>;
  const answers: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(input.questions)) {
    const answer = readAnswer(question, raw[id]);
    if (answer !== undefined) answers[id] = answer;
  }

  const inputTokens = finite(body.usage?.input_tokens) ?? 0;
  const durationMs = Date.now() - started;
  const asked = Object.keys(input.questions).length;
  const answered = Object.keys(answers).length;
  if (answered < asked) {
    input.log.warn(
      { requestId, asked, answered },
      'decision model left questions unanswered or unreadable',
    );
  }

  return {
    answers: answers as DecisionResult<Q>['answers'],
    costUsd: estimateDecisionCostUsd({ inputTokens }),
    modelId: typeof body.model === 'string' ? body.model : DECISION_MODEL,
    requestId,
    durationMs,
  };
}
