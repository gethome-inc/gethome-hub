import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import type { Options, SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from '../logging.js';
import type { Z2mDevice, Z2mProfile } from '../adapters/zigbee/exposes-mapper.js';
import { mappingDescriptorSchema, sanityCheckDescriptor } from './descriptor.js';
import { buildAgentContext, ensureAgentHome } from './context.js';
import { AiUnavailableError, classifyAgentFailure } from './errors.js';

/**
 * The mapping agent: a Claude Agent SDK (Claude Code as a library) run that
 * researches an unknown Zigbee device and submits a MappingDescriptor.
 *
 * Shape of a run:
 *  - the hub prepares a read-only research workspace (context.ts) and uses it
 *    as the agent's cwd;
 *  - the agent gets research tools only — Read/Glob/Grep on that workspace
 *    plus WebSearch/WebFetch — never Bash/Write/Edit, `permissionMode:
 *    'dontAsk'` (deny anything unlisted) and `settingSources: []` (no host
 *    machine settings leak in);
 *  - the only way to answer is the in-process MCP tool `submit_mapping`,
 *    whose handler validates with the descriptor's zod schema + sanity
 *    checks and hands validation errors back so the agent can fix and
 *    resubmit within the same session;
 *  - guardrails: maxTurns, maxBudgetUsd, and a wall-clock watchdog.
 *
 * The descriptor itself remains data, not code — it is re-validated by the
 * mapper and interpreted exactly as before (docs/ai-adaptation.md).
 */

export const DEFAULT_MODEL = 'claude-opus-4-8';
export const AGENT_MAX_TURNS = 40;
export const AGENT_MAX_BUDGET_USD = 2;
export const AGENT_TIMEOUT_MS = 10 * 60 * 1000;

/** Everything the runner needs beyond the prompts (absent in unit-test mocks). */
export interface AgentRunContext {
  device: Z2mDevice;
  staticProfile: Z2mProfile | null;
  samples: Record<string, unknown>[];
  exposesHash: string;
  /** Receives run statistics when the underlying agent reported them. */
  onStats?: (stats: AgentRunStats) => void;
}

export interface AgentRunStats {
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
  authType: 'api_key' | 'oauth_token';
  secret: string;
}

/** The last candidate the agent submitted, valid or not. */
export interface SubmitCapture {
  submitted: unknown;
}

/**
 * The `submit_mapping` in-process MCP tool: the agent's only output channel.
 * The handler validates with the descriptor schema + sanity checks and hands
 * failures back as tool errors, so the agent can fix and resubmit within the
 * same session. An invalid *last* submission is still captured — the mapper
 * records the rejection exactly like the single-shot implementation did.
 */
export function createSubmitMappingTool(capture: SubmitCapture) {
  return tool(
    'submit_mapping',
    'Submit the final MappingDescriptor for this device. If validation fails, the errors are ' +
      'returned — fix the descriptor and call this tool again. A successful submission ends your task.',
    mappingDescriptorSchema.shape,
    async (args) => {
      const parsed = mappingDescriptorSchema.safeParse(args);
      if (!parsed.success) {
        capture.submitted = args;
        const issues = parsed.error.issues
          .map((issue) => `- ${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('\n');
        return {
          content: [{ type: 'text' as const, text: `Descriptor rejected — schema errors:\n${issues}` }],
          isError: true,
        };
      }
      const problems = sanityCheckDescriptor(parsed.data);
      if (problems.length > 0) {
        capture.submitted = parsed.data;
        return {
          content: [
            {
              type: 'text' as const,
              text: `Descriptor rejected — sanity checks failed:\n${problems.map((p) => `- ${p}`).join('\n')}`,
            },
          ],
          isError: true,
        };
      }
      capture.submitted = parsed.data;
      return {
        content: [{ type: 'text' as const, text: 'Mapping accepted. You are done — end your reply now.' }],
      };
    },
  );
}

export function createMappingAgent(
  auth: AgentAuth,
  model: string | null,
  dataDir: string,
  log: Logger,
): MappingProvider {
  return {
    async generate(systemPrompt, userPrompt, run) {
      const context = run
        ? buildAgentContext(dataDir, run.exposesHash, run.device, run.staticProfile, run.samples)
        : buildAgentContext(dataDir, 'adhoc0000', { ieee_address: 'unknown', friendly_name: 'unknown' }, null, []);

      const capture: SubmitCapture = { submitted: null };
      const mappingServer = createSdkMcpServer({
        name: 'mapping',
        version: '1.0.0',
        tools: [createSubmitMappingTool(capture)],
      });

      // The subprocess env REPLACES process.env when provided — rebuild it,
      // drop any host-machine Anthropic credentials, and inject exactly the
      // one the owner configured.
      const env: Record<string, string | undefined> = { ...process.env };
      delete env.ANTHROPIC_API_KEY;
      delete env.CLAUDE_CODE_OAUTH_TOKEN;
      delete env.ANTHROPIC_AUTH_TOKEN;
      env[auth.authType === 'oauth_token' ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'ANTHROPIC_API_KEY'] = auth.secret;
      env.CLAUDE_CONFIG_DIR = ensureAgentHome(dataDir);
      env.CLAUDE_AGENT_SDK_CLIENT_APP = 'gethome-hub';
      env.CLAUDE_CODE_MAX_RETRIES = env.CLAUDE_CODE_MAX_RETRIES ?? '3';

      const controller = new AbortController();
      const watchdog = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);
      watchdog.unref();

      const options: Options = {
        model: model ?? DEFAULT_MODEL,
        systemPrompt,
        cwd: context.dir,
        env,
        tools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
        allowedTools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'mcp__mapping__submit_mapping'],
        disallowedTools: ['Bash', 'Write', 'Edit'],
        permissionMode: 'dontAsk',
        settingSources: [],
        persistSession: false,
        maxTurns: AGENT_MAX_TURNS,
        maxBudgetUsd: AGENT_MAX_BUDGET_USD,
        effort: 'high',
        mcpServers: { mapping: mappingServer },
        abortController: controller,
        stderr: (data) => log.debug({ stderr: data.slice(0, 500) }, 'mapping agent stderr'),
      };

      let result: SDKResultMessage | null = null;
      // Structured subscription-limit signal — richer than any error text.
      let limitRejection: { resetsAt?: number; rateLimitType?: string } | null = null;

      try {
        for await (const message of query({ prompt: userPrompt, options })) {
          result = observe(message, log) ?? result;
          if (message.type === 'rate_limit_event' && message.rate_limit_info.status === 'rejected') {
            const info = message.rate_limit_info;
            limitRejection = {
              ...(info.resetsAt !== undefined ? { resetsAt: info.resetsAt } : {}),
              ...(info.rateLimitType !== undefined ? { rateLimitType: info.rateLimitType } : {}),
            };
          }
        }
      } catch (error) {
        if (controller.signal.aborted) {
          throw new AiUnavailableError('aborted', `mapping agent timed out after ${AGENT_TIMEOUT_MS / 1000}s`);
        }
        const text = error instanceof Error ? error.message : String(error);
        throw classifyAgentFailure(text) ?? new AiUnavailableError('network', text);
      } finally {
        clearTimeout(watchdog);
        context.cleanup();
      }

      if (result && run?.onStats) {
        run.onStats({
          costUsd: result.total_cost_usd,
          numTurns: result.num_turns,
          durationMs: result.duration_ms,
        });
      }
      if (result) {
        log.info(
          { costUsd: result.total_cost_usd, numTurns: result.num_turns, subtype: result.subtype },
          'Mapping agent run finished',
        );
      }

      // Whatever was submitted last is the run's answer: a valid descriptor
      // is used, an invalid one flows through the mapper's validation and is
      // cached as `rejected` — the same contract the single-shot caller had.
      if (capture.submitted !== null) return capture.submitted;

      // Nothing was submitted — figure out why, structured signal first.
      if (limitRejection) {
        const resetAt = limitRejection.resetsAt !== undefined ? epochToDate(limitRejection.resetsAt) : undefined;
        throw new AiUnavailableError(
          'usage_limit',
          `subscription ${limitRejection.rateLimitType ?? 'usage'} limit reached`,
          resetAt,
        );
      }
      if (!result) {
        throw new AiUnavailableError('network', 'mapping agent ended without a result message');
      }
      if (result.subtype !== 'success') {
        const text = result.errors.join('; ') || result.subtype;
        const classified = classifyAgentFailure(text);
        if (classified) throw classified;
        if (result.subtype === 'error_during_execution') {
          // Execution errors without a recognizable cause are still almost
          // always environmental — back off rather than hammering the API.
          throw new AiUnavailableError('network', text);
        }
        // Ran out of turns/budget: the account works, this run just failed.
        throw new Error(`mapping agent gave up (${result.subtype}): ${text.slice(0, 300)}`);
      }
      throw new Error(
        `mapping agent finished without calling submit_mapping: ${result.result.slice(0, 300)}`,
      );
    },
  };
}

/** Log the interesting bits of the stream; return the result message if this is one. */
function observe(message: SDKMessage, log: Logger): SDKResultMessage | null {
  if (message.type === 'result') return message;
  if (message.type === 'assistant') {
    for (const block of message.message.content) {
      if (block.type === 'tool_use') {
        log.debug({ tool: block.name }, 'mapping agent tool use');
      }
    }
  }
  return null;
}

function epochToDate(epoch: number): Date | undefined {
  const date = new Date(epoch > 1e12 ? epoch : epoch * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
