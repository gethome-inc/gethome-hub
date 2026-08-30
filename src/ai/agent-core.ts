import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import { mappingDescriptorSchema, sanityCheckDescriptor } from './descriptor.js';

/**
 * Everything about a mapping run that is not one vendor's API.
 *
 * The hub can run the mapping agent on Anthropic (`agent.ts`) or on OpenAI
 * (`openai-agent.ts`), and the two loops differ only in how a request is
 * shaped and how the answer comes back. The guardrails, the step vocabulary,
 * the seam the mapper talks through and the validate-and-resubmit rule are the
 * same run either way, so they live here — where **no provider SDK is
 * imported**, which is the load-bearing half: a hub configured with only an
 * OpenAI key must never load the Anthropic SDK to satisfy an import chain.
 */

/** How many times a run may be reminded that prose is not an answer. */
export const MAX_NUDGES = 2;

/** What that reminder says. One wording, so the two loops nudge alike. */
export const NUDGE_TEXT =
  'You have not called submit_mapping yet, and it is the only way to return an answer. ' +
  'Submit the MappingDescriptor now.';

/**
 * Output ceiling per turn, covering thinking *and* the tool call. Generous
 * on purpose: a truncated `submit_mapping` call is a wasted run, and a
 * multi-endpoint descriptor plus high-effort reasoning is not small.
 */
export const MAX_OUTPUT_TOKENS = 32_000;

/**
 * How hard the model thinks, and deliberately **not** something the owner is
 * asked to choose.
 *
 * Device adaptation is reasoning-heavy and runs a handful of times in a hub's
 * life, so `high` is the level worth paying for — and the cost lever a person
 * actually has is the *model*, which is the choice the apps offer. Two
 * settings for one decision would be one too many, and the second one is the
 * one nobody can calibrate.
 */
export const EFFORT = 'high' as const;

/** Agentic turns — one request/response round each. */
export const AGENT_MAX_TURNS = 40;
/** Hard ceiling per run, checked against the running cost estimate. */
export const AGENT_MAX_BUDGET_USD = 2;
export const AGENT_TIMEOUT_MS = 10 * 60 * 1000;

/** Everything the runner needs beyond the prompts (absent in unit-test mocks). */
export interface AgentRunContext {
  /** Receives run statistics when the run produced them. */
  onStats?: (stats: AgentRunStats) => void;
  /** Receives a line per notable thing the run did. Must not throw. */
  onStep?: (step: AgentStep) => void;
  /**
   * Receives one entry per request/response round, **and its absence is the
   * off switch**. A run nobody asked to record never builds one of these, so
   * the JSON is never serialised and the bodies are never held — the
   * `MqttObserver` rule, where watching costs nothing when nobody is
   * watching. Must not throw.
   */
  onExchange?: (exchange: AgentExchange) => void;
}

/**
 * One request/response round with a provider, kept so somebody can find out
 * what was actually said.
 *
 * This is the deliberate exception to *a summary, never a transcript*, and two
 * things are what make the exception affordable. It is recorded **only while
 * the owner has asked for it** — `AgentStep` is what every run records
 * forever. And it is the round's **main data rather than its bodies**: a
 * labelled part per thing that was sent or came back, excerpted, which is both
 * what a person can read and a fraction of what the wire carried.
 *
 * The reason to want it at all is that a refusal is often about the request —
 * a model that will not take a parameter, a key that names no workspace — and
 * the run log's one sentence cannot answer "what did we actually send?".
 *
 * Three rules. **A turn records what it added, not the conversation so far**:
 * an agent loop resends the whole history every turn, so recording each
 * request whole is quadratic — the system prompt and the tool schema alone are
 * 9.9 KB and 6.7 KB on *every* one of up to `AGENT_MAX_TURNS` rounds, so a run
 * would write them forty times over. **Nothing carries a credential**: request
 * *bodies* only, never headers, and neither provider puts a key in a body.
 * And **a cut part says it was cut** (`bytes` is what it weighed whole), the
 * `payloadBytes` rule the MQTT inspector follows, so an app never asserts a
 * constant from this file.
 */
export interface AgentExchange {
  /** 1-based, in the order the rounds happened. */
  seq: number;
  at: string;
  durationMs: number;
  /** anthropic | openai — which vendor this round went to. */
  provider: string;
  /** Which of that vendor's models answered it. */
  modelId: string;
  /** The HTTP status, when the round reached one. */
  status?: number;
  /** Whether this round came back with an answer at all. */
  ok: boolean;
  /** What this turn added to the request. */
  sent: ExchangePart[];
  /** What came back — or, on a failure, the provider's own words. */
  received: ExchangePart[];
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * One labelled thing inside a round.
 *
 * `kind` is an open string on purpose, the same rule `commandFailed.kind`
 * follows: each provider names the parts of its own protocol, and an app that
 * meets a word it has never seen renders the label and the text rather than
 * failing to draw the round.
 */
export interface ExchangePart {
  /** `system`, `prompt`, `text`, `thinking`, `tool_use`, `search`, `error`… */
  kind: string;
  /** One line naming it: a role, a tool, a query, a stop reason. */
  label: string;
  /** The content, excerpted. */
  text?: string;
  /** What `text` weighed whole — present only when it was cut. */
  bytes?: number;
}

/**
 * Per part. Long enough for the device schema the first prompt carries and for
 * a whole turn of ordinary model output, short enough that a round is a couple
 * of kilobytes rather than tens.
 */
export const MAX_EXCHANGE_TEXT = 4000;

/** Parts per round. A round with more than this has gone wrong in a way the
 *  first two dozen already show — the `MAX_STEPS` argument, one level down. */
export const MAX_EXCHANGE_PARTS = 24;

/** Build one part, with the excerpt bound applied here rather than at every
 *  call site in two provider loops. */
export function exchangePart(kind: string, label: string, text?: unknown): ExchangePart {
  if (text === undefined || text === null) return { kind, label };
  let rendered: string;
  try {
    rendered = typeof text === 'string' ? text : JSON.stringify(text, null, 2) ?? String(text);
  } catch (error) {
    // A circular structure or a getter that threw. Say so — an empty box
    // would read as "nothing was sent".
    return { kind, label, text: `[could not be recorded: ${(error as Error).message}]` };
  }
  // Bytes, not characters: `String.length` is UTF-16 units and under-reports a
  // payload full of non-Latin names by up to three times.
  const bytes = Buffer.byteLength(rendered);
  if (bytes <= MAX_EXCHANGE_TEXT) return { kind, label, text: rendered };
  // Cut on a character — `subarray().toString('utf8')` splits a multi-byte
  // sequence and leaves U+FFFD on the end of every Cyrillic or CJK name.
  const decoder = new StringDecoder('utf8');
  return {
    kind,
    label,
    text: decoder.write(Buffer.from(rendered).subarray(0, MAX_EXCHANGE_TEXT)),
    bytes,
  };
}

/** Assemble a round. The part cap is applied here, once, for both loops. */
export function agentExchange(input: {
  seq: number;
  startedAt: number;
  provider: string;
  modelId: string;
  status?: number | undefined;
  ok: boolean;
  sent: ExchangePart[];
  received: ExchangePart[];
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
}): AgentExchange {
  return {
    seq: input.seq,
    at: new Date().toISOString(),
    durationMs: Date.now() - input.startedAt,
    provider: input.provider,
    modelId: input.modelId,
    ...(input.status !== undefined ? { status: input.status } : {}),
    ok: input.ok,
    sent: input.sent.slice(0, MAX_EXCHANGE_PARTS),
    received: input.received.slice(0, MAX_EXCHANGE_PARTS),
    ...(input.inputTokens !== undefined ? { inputTokens: input.inputTokens } : {}),
    ...(input.outputTokens !== undefined ? { outputTokens: input.outputTokens } : {}),
  };
}

/**
 * Hand one exchange to whoever is recording, and never let that fail a run.
 *
 * **The whole of the work happens inside the guard, which is why it takes a
 * thunk rather than a value.** Recognising the device is the job; this log is
 * a convenience, and a convenience must not be able to end a run that has
 * already been paid for. Building the parts means walking content blocks from
 * a vendor's SDK, and a shape nobody here anticipated must cost the run
 * nothing — so the distillation, the excerpting and the callback all sit
 * together under one `catch`.
 *
 * The other half of costing nothing is `onExchange` being absent: a run that
 * nobody asked to record never calls the thunk, so no walk happens and no
 * string is built.
 */
export function record(
  run: AgentRunContext | undefined,
  build: () => Parameters<typeof agentExchange>[0],
): void {
  if (!run?.onExchange) return;
  try {
    run.onExchange(agentExchange(build()));
  } catch {
    // Deliberately silent: see above.
  }
}

/**
 * What a thrown provider error is worth writing down.
 *
 * Matched structurally rather than with `instanceof`, for the reason
 * `classifyApiError` is: this file imports no SDK, and the two providers throw
 * different shapes. Everything an SDK hangs off its error that a person could
 * use is kept — the status, the message, and the parsed body when there is
 * one — and nothing else, because `headers` is where a credential would be.
 */
export function describeThrown(error: unknown): ExchangePart[] {
  if (error === null || typeof error !== 'object') {
    return [exchangePart('error', 'The run threw', String(error))];
  }
  const candidate = error as { status?: unknown; message?: unknown; error?: unknown; name?: unknown };
  const label = typeof candidate.status === 'number' ? `Refused with ${candidate.status}` : 'The run threw';
  const parts: ExchangePart[] = [
    exchangePart(
      'error',
      label,
      typeof candidate.message === 'string' ? candidate.message : String(error),
    ),
  ];
  // The provider's own structured body, when it sent one. This is the half
  // that names a fix — an `anthropic-workspace-id` refusal lives in here.
  if (candidate.error !== undefined) parts.push(exchangePart('error', 'Body', candidate.error));
  return parts;
}


/**
 * One thing a run did, in the order it did it.
 *
 * A summary rather than a transcript, and the distinction is the whole design:
 * a hub owner watching an unknown device being adapted needs to know what was
 * searched for, what was read, what was submitted and why it was refused —
 * none of which requires storing model prose on an SD card. `detail` is one
 * short string (a query, a URL, a validation error), never a message body.
 */
export interface AgentStep {
  at: string;
  type: 'prompt' | 'search' | 'fetch' | 'submit' | 'note';
  summary: string;
  detail?: string;
}

/** Keep one step small enough that sixty runs of them stay in the tens of KB. */
export const MAX_STEP_DETAIL = 2000;

export function agentStep(type: AgentStep['type'], summary: string, detail?: string): AgentStep {
  return {
    at: new Date().toISOString(),
    type,
    summary,
    ...(detail !== undefined ? { detail: detail.slice(0, MAX_STEP_DETAIL) } : {}),
  };
}

export interface AgentRunStats {
  /** Estimated from token usage and list prices — see models.ts. */
  costUsd: number;
  numTurns: number;
  durationMs: number;
}

/**
 * The seam the mapper talks through (and tests override): produce a raw,
 * unvalidated MappingDescriptor candidate or throw. `AiUnavailableError`
 * means "the account/service is down, back off"; any other error means "this
 * run failed" and is not cached.
 */
export interface MappingProvider {
  generate(systemPrompt: string, userPrompt: string, run?: AgentRunContext): Promise<unknown>;
}

export interface AgentAuth {
  /**
   * The provider's API key. Anthropic subscription tokens are not accepted —
   * the Messages API cannot authenticate one, and `settings.ts` reports a
   * stored one as `legacySubscriptionToken` rather than failing with a 401.
   */
  secret: string;
}

/** The last candidate the model submitted, valid or not. */
export interface SubmitCapture {
  submitted: unknown;
}

export interface SubmissionOutcome {
  /** True when the descriptor passed both schema and sanity checks. */
  accepted: boolean;
  isError: boolean;
  text: string;
}

/**
 * The `submit_mapping` tool's input schema, generated from the live descriptor
 * schema so it cannot drift from what the mapper will accept — and because the
 * whitelisted canonical state paths are a zod enum inside that schema, the
 * model receives them here rather than in a separate reference file.
 *
 * Deliberately not used with either vendor's *strict* mode: strict tool use
 * guarantees the *shape* of the input but cannot express the descriptor's
 * semantic rules (a declared capability needs a state rule for it, `primary`
 * has to be one of the capabilities), and it rejects the numeric and string
 * constraints this schema uses. The validate-and-resubmit loop covers both, so
 * the model gets a real error message instead of a silently narrowed schema.
 */
export function submitMappingSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(mappingDescriptorSchema, { target: 'draft-7' }) as Record<string, unknown>;
  // `$schema` is metadata about the document, not about the tool input.
  delete schema.$schema;
  return schema;
}

export const SUBMIT_MAPPING_DESCRIPTION =
  'Submit the final MappingDescriptor for this device. Call this once you have decided how every property ' +
  'the hub does not already handle maps onto the canonical schema — it is the only way to return an answer, ' +
  'and a run that ends without it produced nothing. If the descriptor fails validation the errors are ' +
  'returned to you: fix them and call this again. A successful submission ends the task.';

/**
 * Validate a submission and record it. An invalid *last* submission is still
 * captured — the mapper records the rejection, which is what stops the hub
 * re-asking about a device model whose descriptor the model cannot get right.
 */
export function evaluateSubmission(input: unknown, capture: SubmitCapture): SubmissionOutcome {
  const parsed = mappingDescriptorSchema.safeParse(input);
  if (!parsed.success) {
    capture.submitted = input;
    const issues = parsed.error.issues
      .map((issue) => `- ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    return { accepted: false, isError: true, text: `Descriptor rejected — schema errors:\n${issues}` };
  }
  const problems = sanityCheckDescriptor(parsed.data);
  if (problems.length > 0) {
    capture.submitted = parsed.data;
    return {
      accepted: false,
      isError: true,
      text: `Descriptor rejected — sanity checks failed:\n${problems.map((p) => `- ${p}`).join('\n')}`,
    };
  }
  capture.submitted = parsed.data;
  return { accepted: true, isError: false, text: 'Mapping accepted. You are done — end your reply now.' };
}

