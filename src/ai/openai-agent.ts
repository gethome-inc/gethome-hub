import type { Logger } from '../logging.js';
import { AiUnavailableError, classifyApiError } from './errors.js';
import {
  AGENT_MAX_BUDGET_USD,
  AGENT_MAX_TURNS,
  AGENT_TIMEOUT_MS,
  EFFORT,
  MAX_NUDGES,
  MAX_OUTPUT_TOKENS,
  NUDGE_TEXT,
  SUBMIT_MAPPING_DESCRIPTION,
  agentStep,
  evaluateSubmission,
  submitMappingSchema,
  type AgentAuth,
  type AgentRunContext,
  type AgentRunStats,
  type MappingProvider,
  type SubmitCapture,
} from './agent-core.js';
import { defaultModelFor, estimateCostUsd, isSupportedModel, supportedModelIds } from './models.js';

/**
 * The mapping agent on OpenAI's Responses API — the same run as `agent.ts`,
 * against the other vendor.
 *
 * **Why plain `fetch` and no SDK.** The hub ships `dist/` plus its production
 * `node_modules` to a Raspberry Pi, and everything this loop needs is one JSON
 * POST with an array of items coming back. The Anthropic SDK earns its keep by
 * typing forty turns of content blocks; a second SDK for a second provider
 * would be a second dependency subtree on a board with 415 MB of RAM, and
 * every vulnerable package this repo has ever shipped arrived transitively.
 *
 * **Search, and deliberately no fetch.** Anthropic's `web_fetch` will only
 * fetch URLs already in the conversation, which is what lets `prompts.ts` name
 * the device's likely zigbee2mqtt.io page and have the model read it directly.
 * OpenAI's hosted tool set has no equivalent, and the alternative — a fetch
 * tool the *hub* executes — would break the promise that the hub opens no
 * connection to third-party sites (`docs/ai-adaptation.md`, Privacy). So this
 * provider searches for that page instead of fetching it: slightly weaker on a
 * genuinely obscure device, and honest about where the hub's traffic goes.
 *
 * **Stateless.** `store: false`, so OpenAI keeps no copy of the conversation;
 * reasoning items then come back carrying `encrypted_content` and are echoed
 * verbatim on the next turn, which is what keeps the model's own chain of
 * thought across a tool call without anything being retained server-side.
 */

const RESPONSES_URL = 'https://api.openai.com/v1/responses';

/**
 * OpenAI's web search has no per-run use limit of its own, so what bounds the
 * research here is the turn cap and the cost cap — the same two that bound
 * everything else about a run.
 */
interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
}

/**
 * Items are echoed back verbatim, so the loop deliberately understands as
 * little of them as it can: enough to spot a tool call, a refusal and a search,
 * and nothing more. An item type this build has never heard of travels through
 * untouched rather than being dropped, which is what stops a new kind of
 * reasoning block breaking the conversation.
 */
interface ResponseItem {
  type: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  action?: { type?: string; query?: string };
  content?: Array<{ type: string; refusal?: string }>;
  [key: string]: unknown;
}

interface ResponseBody {
  status?: string;
  incomplete_details?: { reason?: string };
  output?: ResponseItem[];
  usage?: ResponsesUsage;
}

/** Running total across every turn of one run. */
class RunUsage {
  private input = 0;
  private output = 0;
  private cacheRead = 0;
  private webSearches = 0;

  constructor(private readonly model: string) {}

  add(usage: ResponsesUsage | undefined, searches: number): void {
    this.webSearches += searches;
    if (!usage) return;
    // OpenAI reports cached input inside the input count rather than beside it,
    // so the cached share is subtracted out before it is billed at its own rate
    // — otherwise a cached prompt would be counted twice.
    const cached = usage.input_tokens_details?.cached_tokens ?? 0;
    this.input += Math.max((usage.input_tokens ?? 0) - cached, 0);
    this.cacheRead += cached;
    this.output += usage.output_tokens ?? 0;
  }

  costUsd(): number {
    return estimateCostUsd(this.model, {
      input_tokens: this.input,
      output_tokens: this.output,
      cache_read_input_tokens: this.cacheRead,
      webSearchRequests: this.webSearches,
    });
  }
}

export function createOpenAiMappingAgent(
  auth: AgentAuth,
  model: string | null,
  log: Logger,
): MappingProvider {
  const modelId = model ?? defaultModelFor('openai');

  return {
    async generate(systemPrompt, userPrompt, run) {
      if (!isSupportedModel(modelId, 'openai')) {
        // Defensive: the settings route refuses these, so reaching here means
        // a hand-edited database. Not an availability failure — no backoff.
        throw new Error(
          `model "${modelId}" cannot run the mapping agent (supported: ${supportedModelIds('openai').join(', ')})`,
        );
      }

      const controller = new AbortController();
      const watchdog = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);
      watchdog.unref();

      const capture: SubmitCapture = { submitted: null };
      const usage = new RunUsage(modelId);
      const startedAt = Date.now();
      const input: unknown[] = [{ role: 'user', content: userPrompt }];

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

          const body = await askOpenAi(auth.secret, modelId, systemPrompt, input, controller.signal);
          const output = body.output ?? [];
          usage.add(body.usage, output.filter((item) => item.type === 'web_search_call').length);
          reportResearch(output, run);
          // Verbatim, reasoning items included: without them the model loses its
          // own chain of thought across the tool call it just made.
          input.push(...output);

          if (body.status === 'incomplete' && body.incomplete_details?.reason === 'max_output_tokens') {
            throw new Error(`mapping agent turn hit max_output_tokens (${MAX_OUTPUT_TOKENS}) before answering`);
          }
          const refusal = refusalIn(output);
          if (refusal) throw new Error(`mapping agent run was refused by the model: ${refusal}`);

          const calls = output.filter((item) => item.type === 'function_call');
          if (calls.length === 0) {
            // Answered in prose. Worth one or two reminders — the run has
            // already paid for the research — but not the whole turn budget.
            if (nudges >= MAX_NUDGES) break;
            nudges += 1;
            run?.onStep?.(agentStep('note', 'Answered in prose — asked again for a mapping.'));
            input.push({ role: 'user', content: NUDGE_TEXT });
            continue;
          }

          for (const call of calls) {
            if (call.name !== 'submit_mapping') {
              input.push({
                type: 'function_call_output',
                call_id: call.call_id,
                output: `Unknown tool "${call.name ?? '(unnamed)'}".`,
              });
              continue;
            }
            const outcome = evaluateSubmission(parseArguments(call.arguments), capture);
            log.debug({ accepted: outcome.accepted }, 'mapping agent submitted a descriptor');
            run?.onStep?.(
              agentStep(
                'submit',
                outcome.accepted ? 'Submitted a mapping — accepted.' : 'Submitted a mapping — rejected.',
                outcome.accepted ? undefined : outcome.text,
              ),
            );
            input.push({ type: 'function_call_output', call_id: call.call_id, output: outcome.text });
            if (outcome.accepted) accepted = true;
          }

          if (accepted) break;
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
        'Mapping agent run finished (OpenAI)',
      );

      // Whatever was submitted last is the run's answer: a valid descriptor is
      // used, an invalid one flows through the mapper's validation and is
      // cached as `rejected` — the same contract the Anthropic loop has.
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

/** One request/response round. Separated so the loop above reads as a loop. */
async function askOpenAi(
  apiKey: string,
  modelId: string,
  systemPrompt: string,
  input: unknown[],
  signal: AbortSignal,
): Promise<ResponseBody> {
  let response: Response;
  try {
    response = await fetch(RESPONSES_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      signal,
      body: JSON.stringify({
        model: modelId,
        instructions: systemPrompt,
        input,
        tools: [
          { type: 'web_search' },
          {
            type: 'function',
            name: 'submit_mapping',
            description: SUBMIT_MAPPING_DESCRIPTION,
            parameters: submitMappingSchema(),
            // See `submitMappingSchema` — the descriptor's semantic rules are
            // what the resubmit loop is for, and strict mode rejects the
            // numeric and string constraints this schema uses.
            strict: false,
          },
        ],
        reasoning: { effort: EFFORT },
        max_output_tokens: MAX_OUTPUT_TOKENS,
        // Nothing about this home is kept on OpenAI's servers. The cost is that
        // reasoning has to travel back and forth, which it does — see the note
        // at the top of this file.
        store: false,
      }),
    });
  } catch (error) {
    if (signal.aborted) {
      throw new AiUnavailableError('aborted', `mapping agent timed out after ${AGENT_TIMEOUT_MS / 1000}s`);
    }
    throw new AiUnavailableError(
      'network',
      `could not reach OpenAI: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const text = await response.text();
  if (!response.ok) {
    const message = messageIn(text) ?? `OpenAI answered ${response.status}.`;
    // The classifier branches on HTTP status rather than on any vendor's error
    // vocabulary, which is exactly why it is structural.
    throw classifyApiError({ status: response.status, headers: response.headers, message }) ??
      new Error(message);
  }
  try {
    return JSON.parse(text) as ResponseBody;
  } catch {
    throw new Error('OpenAI answered with something that was not JSON');
  }
}

/**
 * Report the run's hosted research as steps.
 *
 * Search runs on OpenAI's infrastructure, so the only trace of it is a
 * `web_search_call` item in the reply. Reading the query out of it is what lets
 * the apps say *what was looked up* about a device rather than only that
 * "something was".
 */
function reportResearch(output: ResponseItem[], run: AgentRunContext | undefined): void {
  if (!run?.onStep) return;
  for (const item of output) {
    if (item.type !== 'web_search_call') continue;
    const query = item.action?.query;
    run.onStep(
      typeof query === 'string'
        ? agentStep('search', 'Searched the web.', query)
        : agentStep('search', 'Searched the web.'),
    );
  }
}

function refusalIn(output: ResponseItem[]): string | null {
  for (const item of output) {
    for (const part of item.content ?? []) {
      if (part.type === 'refusal' && typeof part.refusal === 'string') return part.refusal;
    }
  }
  return null;
}

/**
 * Tool arguments arrive as a JSON *string*. Unparseable is not a crash — it is
 * a submission the validator refuses and the model is asked to fix, which is
 * the same path a structurally wrong descriptor takes.
 */
function parseArguments(raw: string | undefined): unknown {
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** OpenAI's own sentence, which is always better than one written here. */
function messageIn(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    const message = parsed.error?.message;
    return typeof message === 'string' && message.length > 0 ? message.slice(0, 400) : null;
  } catch {
    return null;
  }
}
