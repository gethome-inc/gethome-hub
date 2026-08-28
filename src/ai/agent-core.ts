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

