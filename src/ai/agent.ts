import Anthropic from '@anthropic-ai/sdk';
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
  describeThrown,
  exchangePart,
  evaluateSubmission,
  record,
  submitMappingSchema,
  type AgentAuth,
  type AgentExchange,
  type AgentRunContext,
  type AgentRunStats,
  type ExchangePart,
  type MappingProvider,
  type SubmitCapture,
} from './agent-core.js';
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
// Re-exported because this module is where callers learned to find them, and
// because a provider is the only thing that changed — see `agent-core.ts`.
export {
  agentStep,
  evaluateSubmission,
  AGENT_MAX_BUDGET_USD,
  AGENT_MAX_TURNS,
  AGENT_TIMEOUT_MS,
  MAX_STEP_DETAIL,
  type AgentAuth,
  type AgentExchange,
  type AgentRunContext,
  type AgentRunStats,
  type AgentStep,
  type MappingProvider,
  type SubmissionOutcome,
  type SubmitCapture,
} from './agent-core.js';

/** Research budget per run. High enough for a genuinely obscure device,
 *  low enough that a confused run cannot spend the whole cost cap on search. */
const WEB_SEARCH_MAX_USES = 8;
const WEB_FETCH_MAX_USES = 8;

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
  return {
    name: 'submit_mapping',
    description: SUBMIT_MAPPING_DESCRIPTION,
    input_schema: submitMappingSchema() as Anthropic.Tool['input_schema'],
  };
}

/**
 * Report the run's server-side research as steps.
 *
 * `web_search` and `web_fetch` execute on Anthropic's infrastructure, so the
 * only trace of them is a `server_tool_use` block in the reply. Reading the
 * query and the URL out of it is what lets the apps say *what was looked up*
 * about a device rather than only that "something was".
 */
/**
 * The main data in what this turn added to the request.
 *
 * Not the request body: an agent loop resends everything every turn, and the
 * system prompt and the tool schema alone are 9.9 KB and 6.7 KB of it. What a
 * person wants is what is *new* — and, once, what the run was configured with.
 * The tool **names** rather than their schemas for the same reason: the
 * `submit_mapping` schema is generated from the descriptor and is identical in
 * every run of a build.
 *
 * Only ever called from inside `record`, so a content shape this does not
 * expect costs the run nothing.
 */
function sentParts(
  firstRound: boolean,
  modelId: string,
  systemPrompt: string,
  tools: Anthropic.ToolUnion[],
  added: Anthropic.MessageParam[],
): ExchangePart[] {
  const parts: ExchangePart[] = [];
  if (firstRound) {
    parts.push(
      exchangePart(
        'config',
        `${modelId} · effort ${EFFORT} · max_tokens ${MAX_OUTPUT_TOKENS}`,
        `tools: ${tools.map((tool) => ('name' in tool ? tool.name : tool.type)).join(', ')}`,
      ),
      exchangePart('system', 'System prompt', systemPrompt),
    );
  }
  for (const message of added) {
    if (typeof message.content === 'string') {
      parts.push(exchangePart('message', message.role, message.content));
      continue;
    }
    for (const block of message.content) {
      if (block.type === 'text') {
        parts.push(exchangePart('message', message.role, block.text));
      } else if (block.type === 'tool_result') {
        parts.push(
          exchangePart(
            'tool_result',
            block.is_error ? 'Tool result — refused' : 'Tool result',
            block.content,
          ),
        );
      } else if (block.type === 'tool_use') {
        parts.push(exchangePart('tool_use', `Called ${block.name}`, block.input));
      }
      // Thinking blocks are replayed verbatim because the API requires it,
      // and they are the model's own from the previous round — already in
      // that round's `received`. Recording them again would double the log.
    }
  }
  return parts;
}

/**
 * The main data in what came back: why the turn stopped, and one part per
 * content block. Server-side search and fetch appear here as the query and
 * the URL, which is the same thing `reportResearch` puts in the run's steps —
 * said twice on purpose, because a step is the run's story and this is the
 * round's.
 */
function receivedParts(response: Anthropic.Message): ExchangePart[] {
  const parts: ExchangePart[] = [
    exchangePart('outcome', `Stopped: ${response.stop_reason ?? 'end_turn'}`),
  ];
  for (const block of response.content) {
    switch (block.type) {
      case 'thinking':
        parts.push(exchangePart('thinking', 'Thinking', block.thinking));
        break;
      case 'text':
        parts.push(exchangePart('text', 'Answered in prose', block.text));
        break;
      case 'tool_use':
        parts.push(exchangePart('tool_use', `Called ${block.name}`, block.input));
        break;
      case 'server_tool_use': {
        const input = block.input as { query?: unknown; url?: unknown } | null;
        const detail = typeof input?.query === 'string' ? input.query : input?.url;
        parts.push(exchangePart('research', `Ran ${block.name}`, detail));
        break;
      }
      default:
        // A block type this build has never met — named, not dropped, because
        // "the reply had something in it we cannot show" is worth knowing.
        parts.push(exchangePart(block.type, block.type));
    }
  }
  return parts;
}

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
      // How much of `messages` the exchange log has already seen. An agent
      // loop resends the whole conversation every turn, so recording each
      // request whole would write the first prompt once per turn and make the
      // last turn the size of the run — see `AgentExchange`.
      let recordedUpTo = 0;

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
          const roundStartedAt = Date.now();
          // Captured before the request because `messages` grows during it —
          // but only sliced, never walked: turning these into parts is work,
          // and it belongs inside `record`'s guard.
          const added = run?.onExchange ? messages.slice(recordedUpTo) : [];
          const firstRound = turns === 1;
          recordedUpTo = messages.length;
          try {
            // `stream()`, not `create()`, and that is load-bearing rather
            // than a preference: the SDK refuses a non-streaming request
            // whose `max_tokens` could take it past the API's ten-minute
            // ceiling, and the threshold is 21,333 — so at MAX_OUTPUT_TOKENS
            // every run threw `Streaming is required for operations that may
            // take longer than 10 minutes` before it ever reached the
            // network. Nothing here is displayed as it arrives, so
            // `finalMessage()` collects the whole `Message` and the loop
            // below is unchanged.
            const stream = client.messages.stream(
              {
                model: modelId,
                max_tokens: MAX_OUTPUT_TOKENS,
                // Two breakpoints, which is what the Messages API asks of an
                // agent loop. The explicit one covers the tool definitions
                // and the system prompt — the large, byte-identical prefix
                // every turn of every run shares, and tools sort ahead of
                // system in the cached prefix. The top-level field then
                // places a second one on the last block of `messages`, which
                // is the half that was missing: this conversation carries the
                // whole of the model's research and grows for up to
                // AGENT_MAX_TURNS turns, and without it every turn re-sent
                // all of it at full input price.
                system: [
                  { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
                ],
                cache_control: { type: 'ephemeral' },
                messages,
                tools,
                thinking: { type: 'adaptive' },
                output_config: { effort: EFFORT },
              },
              { signal: controller.signal },
            );
            response = await stream.finalMessage();
          } catch (error) {
            // Recorded before it is classified: the whole point of keeping
            // this is the refusal nobody could read, and by the time the
            // classifier has finished with it the status and the body are
            // behind an `AiUnavailableError`'s single message.
            record(run, () => ({
              seq: turns,
              startedAt: roundStartedAt,
              provider: 'anthropic',
              modelId,
              ok: false,
              sent: sentParts(firstRound, modelId, systemPrompt, tools, added),
              received: describeThrown(error),
              ...(typeof (error as { status?: unknown }).status === 'number'
                ? { status: (error as { status: number }).status }
                : {}),
            }));
            if (controller.signal.aborted) {
              throw new AiUnavailableError(
                'aborted',
                `mapping agent timed out after ${AGENT_TIMEOUT_MS / 1000}s`,
              );
            }
            throw classifyApiError(error) ?? error;
          }

          record(run, () => ({
            seq: turns,
            startedAt: roundStartedAt,
            provider: 'anthropic',
            modelId,
            status: 200,
            ok: true,
            sent: sentParts(firstRound, modelId, systemPrompt, tools, added),
            received: receivedParts(response),
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
          }));

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
              content: NUDGE_TEXT,
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
