import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { Logger } from '../logging.js';
import { mappingDescriptorSchema, sanityCheckDescriptor } from './descriptor.js';
import { AiUnavailableError, classifyApiError } from './errors.js';
import { DEFAULT_MODEL, estimateCostUsd, isSupportedModel, supportedModelIds } from './models.js';

/**
 * The mapping agent: a tool-use loop on the Anthropic Messages API that
 * researches an unknown Zigbee device and submits a MappingDescriptor.
 *
 * **Why this is a plain API loop and not the Claude Agent SDK.** It used to
 * be the latter, and the Agent SDK is a better fit for the job on paper — it
 * brought its own agent loop, file tools and permission model. What it also
 * brought was a 276 MB native `claude` executable: 74% of everything a hub
 * downloads, and a ~315 MB subprocess per run, of which ~224 MB is the
 * binary's own pages mapped in from disk. On a Raspberry Pi Zero 2 W that
 * subprocess does not get OOM-killed — it thrashes, re-reading its own code
 * off an SD card through a cgroup that is already at its `MemoryHigh` mark,
 * and a run reliably outlived the 10-minute watchdog below without
 * finishing. AI adaptation was therefore installed-but-unusable on the
 * smallest board the hub supports. This loop makes the same requests from
 * inside the hub process, costing a few megabytes and no subprocess at all.
 * `docs/ai-adaptation.md` is canonical; the trade is that Claude
 * subscription tokens no longer work, only Anthropic API keys.
 *
 * Shape of a run:
 *  - the hub puts the whole research brief in the task message (prompts.ts):
 *    exposes tree, recent payloads, the static mapping, and the device's
 *    likely zigbee2mqtt.io page — `web_fetch` will only fetch URLs already
 *    in the conversation, so naming it is what makes it reachable;
 *  - the model researches with the server-side `web_search` / `web_fetch`
 *    tools, which run on Anthropic's infrastructure — the hub itself needs
 *    no egress beyond api.anthropic.com;
 *  - the only client-side tool, and the only way to answer, is
 *    `submit_mapping`, whose input schema *is* the descriptor's zod schema
 *    and whose handler re-validates and hands errors back so the model can
 *    fix and resubmit within the same run;
 *  - guardrails: a turn cap, a cost cap computed from token usage, and a
 *    wall-clock watchdog.
 *
 * The descriptor remains data, not code — it is re-validated by the mapper
 * and interpreted exactly as before. Model output is never executed.
 */

export { DEFAULT_MODEL } from './models.js';

/** Agentic turns — one request/response round each. */
export const AGENT_MAX_TURNS = 40;
/** Hard ceiling per run, checked against the running cost estimate. */
export const AGENT_MAX_BUDGET_USD = 2;
export const AGENT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Output ceiling per turn, covering thinking *and* the tool call. Generous
 * on purpose: a truncated `submit_mapping` call is a wasted run, and a
 * multi-endpoint descriptor plus high-effort reasoning is not small.
 */
const MAX_OUTPUT_TOKENS = 32_000;

/**
 * Kept at `high`, which is what the Agent SDK run used. Device adaptation is
 * reasoning-heavy, but this migration deliberately changes one thing at a
 * time — raising effort would quietly raise the per-run bill at the same
 * moment the footprint dropped, and that is the owner's call to make.
 */
const EFFORT = 'high' as const;

/** Research budget per run. High enough for a genuinely obscure device,
 *  low enough that a confused run cannot spend the whole cost cap on search. */
const WEB_SEARCH_MAX_USES = 8;
const WEB_FETCH_MAX_USES = 8;

/** How many times a run may be reminded that prose is not an answer. */
const MAX_NUDGES = 2;

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
  /** An Anthropic API key. Subscription tokens are not accepted — see the
   *  note at the top of this file. */
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
 * The `submit_mapping` tool definition. Its `input_schema` is generated from
 * the live descriptor schema, so it cannot drift from what the mapper will
 * accept — and because the whitelisted canonical state paths are a zod enum
 * inside that schema, the model receives them here rather than in a separate
 * reference file.
 *
 * Deliberately not `strict`: strict tool use guarantees the *shape* of the
 * input but cannot express the descriptor's semantic rules (a declared
 * capability needs a state rule for it, `primary` has to be one of the
 * capabilities), and it rejects the numeric and string constraints this
 * schema uses. The validate-and-resubmit loop below covers both, so the
 * model gets a real error message instead of a silently narrowed schema.
 */
export function submitMappingTool(): Anthropic.Tool {
  const schema = z.toJSONSchema(mappingDescriptorSchema, { target: 'draft-7' }) as Record<string, unknown>;
  // `$schema` is metadata about the document, not about the tool input.
  delete schema.$schema;
  return {
    name: 'submit_mapping',
    description:
      'Submit the final MappingDescriptor for this device. Call this once you have decided how every property ' +
      'the hub does not already handle maps onto the canonical schema — it is the only way to return an answer, ' +
      'and a run that ends without it produced nothing. If the descriptor fails validation the errors are ' +
      'returned to you: fix them and call this again. A successful submission ends the task.',
    input_schema: schema as Anthropic.Tool['input_schema'],
  };
}

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

/**
 * Report the run's server-side research as steps.
 *
 * `web_search` and `web_fetch` execute on Anthropic's infrastructure, so the
 * only trace of them is a `server_tool_use` block in the reply. Reading the
 * query and the URL out of it is what lets the apps say *what was looked up*
 * about a device rather than only that "something was".
 */
function reportResearch(content: Anthropic.ContentBlock[], run: AgentRunContext | undefined): void {
  if (!run?.onStep) return;
  for (const block of content) {
    if (block.type !== 'server_tool_use') continue;
    const input = block.input as { query?: unknown; url?: unknown } | null;
    if (block.name === 'web_search' && typeof input?.query === 'string') {
      run.onStep(agentStep('search', 'Searched the web.', input.query));
    } else if (block.name === 'web_fetch' && typeof input?.url === 'string') {
      run.onStep(agentStep('fetch', 'Read a page.', input.url));
    }
  }
}

/** The research tools, plus the one client-side tool the model answers with. */
function buildTools(): Anthropic.Messages.ToolUnion[] {
  return [
    { type: 'web_search_20260209', name: 'web_search', max_uses: WEB_SEARCH_MAX_USES },
    { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: WEB_FETCH_MAX_USES },
    submitMappingTool(),
  ];
}

/** Running total across every turn of one run. */
class RunUsage {
  private input = 0;
  private output = 0;
  private cacheRead = 0;
  private cacheWrite = 0;
  private webSearches = 0;

  constructor(private readonly model: string) {}

  add(usage: Anthropic.Usage | undefined): void {
    if (!usage) return;
    this.input += usage.input_tokens ?? 0;
    this.output += usage.output_tokens ?? 0;
    this.cacheRead += usage.cache_read_input_tokens ?? 0;
    this.cacheWrite += usage.cache_creation_input_tokens ?? 0;
    this.webSearches += usage.server_tool_use?.web_search_requests ?? 0;
  }

  costUsd(): number {
    return estimateCostUsd(this.model, {
      input_tokens: this.input,
      output_tokens: this.output,
      cache_read_input_tokens: this.cacheRead,
      cache_creation_input_tokens: this.cacheWrite,
      webSearchRequests: this.webSearches,
    });
  }
}

export function createMappingAgent(
  auth: AgentAuth,
  model: string | null,
  log: Logger,
): MappingProvider {
  const modelId = model ?? DEFAULT_MODEL;

  return {
    async generate(systemPrompt, userPrompt, run) {
      if (!isSupportedModel(modelId)) {
        // Defensive: PUT /settings/ai refuses these, so reaching here means
        // a hand-edited database. Not an availability failure — no backoff.
        throw new Error(
          `model "${modelId}" cannot run the mapping agent (supported: ${supportedModelIds().join(', ')})`,
        );
      }

      const client = new Anthropic({ apiKey: auth.secret, maxRetries: 3 });
      const controller = new AbortController();
      const watchdog = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);
      watchdog.unref();

      const capture: SubmitCapture = { submitted: null };
      const usage = new RunUsage(modelId);
      const startedAt = Date.now();
      const tools = buildTools();
      const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userPrompt }];

      let turns = 0;
      let nudges = 0;
      let accepted = false;
      let ranOutOf: 'turns' | 'budget' | null = null;

      try {
        for (turns = 1; turns <= AGENT_MAX_TURNS; turns++) {
          if (usage.costUsd() >= AGENT_MAX_BUDGET_USD) {
            ranOutOf = 'budget';
            break;
          }

          let response: Anthropic.Message;
          try {
            response = await client.messages.create(
              {
                model: modelId,
                max_tokens: MAX_OUTPUT_TOKENS,
                // One cached breakpoint covers the tool definitions and the
                // system prompt — the large, byte-identical prefix every turn
                // of every run shares.
                system: [
                  { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
                ],
                messages,
                tools,
                thinking: { type: 'adaptive' },
                output_config: { effort: EFFORT },
              },
              { signal: controller.signal },
            );
          } catch (error) {
            if (controller.signal.aborted) {
              throw new AiUnavailableError(
                'aborted',
                `mapping agent timed out after ${AGENT_TIMEOUT_MS / 1000}s`,
              );
            }
            throw classifyApiError(error) ?? error;
          }

          usage.add(response.usage);
          reportResearch(response.content, run);
          // The whole content goes back verbatim — thinking blocks included,
          // which the API requires when continuing a thinking conversation.
          messages.push({ role: 'assistant', content: response.content });

          if (response.stop_reason === 'pause_turn') {
            // The server-side tool loop hit its own iteration limit. Re-send
            // as-is; the API resumes from the trailing server_tool_use block
            // and must NOT be given an extra user turn here.
            continue;
          }
          if (response.stop_reason === 'refusal') {
            throw new Error('mapping agent run was refused by the model');
          }
          if (response.stop_reason === 'max_tokens') {
            throw new Error(`mapping agent turn hit max_tokens (${MAX_OUTPUT_TOKENS}) before answering`);
          }

          const toolUses = response.content.filter(
            (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
          );

          if (toolUses.length === 0) {
            // Answered in prose. Worth one or two reminders — the run has
            // already paid for the research — but not the whole turn budget.
            if (nudges >= MAX_NUDGES) break;
            nudges += 1;
            run?.onStep?.(
              agentStep('note', 'Answered in prose — asked again for a mapping.'),
            );
            messages.push({
              role: 'user',
              content:
                'You have not called submit_mapping yet, and it is the only way to return an answer. ' +
                'Submit the MappingDescriptor now.',
            });
            continue;
          }

          const results: Anthropic.ToolResultBlockParam[] = [];
          for (const call of toolUses) {
            if (call.name !== 'submit_mapping') {
              results.push({
                type: 'tool_result',
                tool_use_id: call.id,
                content: `Unknown tool "${call.name}".`,
                is_error: true,
              });
              continue;
            }
            const outcome = evaluateSubmission(call.input, capture);
            log.debug({ accepted: outcome.accepted }, 'mapping agent submitted a descriptor');
            run?.onStep?.(
              agentStep(
                'submit',
                outcome.accepted ? 'Submitted a mapping — accepted.' : 'Submitted a mapping — rejected.',
                outcome.accepted ? undefined : outcome.text,
              ),
            );
            results.push({
              type: 'tool_result',
              tool_use_id: call.id,
              content: outcome.text,
              ...(outcome.isError ? { is_error: true } : {}),
            });
            if (outcome.accepted) accepted = true;
          }

          if (accepted) break;
          messages.push({ role: 'user', content: results });
        }
        if (!accepted && ranOutOf === null && turns > AGENT_MAX_TURNS) ranOutOf = 'turns';
      } finally {
        clearTimeout(watchdog);
      }

      const stats: AgentRunStats = {
        costUsd: usage.costUsd(),
        numTurns: Math.min(turns, AGENT_MAX_TURNS),
        durationMs: Date.now() - startedAt,
      };
      run?.onStats?.(stats);
      log.info(
        { costUsd: Number(stats.costUsd.toFixed(4)), numTurns: stats.numTurns, accepted },
        'Mapping agent run finished',
      );

      // Whatever was submitted last is the run's answer: a valid descriptor
      // is used, an invalid one flows through the mapper's validation and is
      // cached as `rejected` — the same contract the Agent SDK run had.
      if (capture.submitted !== null) return capture.submitted;

      if (ranOutOf === 'budget') {
        throw new Error(
          `mapping agent hit its $${AGENT_MAX_BUDGET_USD} cost cap after ${stats.numTurns} turn(s) without submitting`,
        );
      }
      if (ranOutOf === 'turns') {
        throw new Error(`mapping agent used all ${AGENT_MAX_TURNS} turns without submitting`);
      }
      throw new Error('mapping agent finished without calling submit_mapping');
    },
  };
}
