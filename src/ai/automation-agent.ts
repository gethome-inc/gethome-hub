import Anthropic from '@anthropic-ai/sdk';
import type { Logger } from '../logging.js';
import { automationDocumentSchema } from '../automations/schema.js';
import { sanityCheckAutomation } from '../automations/sanity.js';
import { AiUnavailableError, classifyApiError } from './errors.js';
import { EFFORT, MAX_OUTPUT_TOKENS, type AgentAuth } from './agent-core.js';
import { estimateCostUsd, isSupportedModel, supportedModelIds } from './models.js';
import {
  AUTOMATION_MAX_BUDGET_USD,
  AUTOMATION_MAX_TURNS,
  AUTOMATION_TIMEOUT_MS,
  type AutomationConversation,
  type AutomationTurn,
  type AutomationTurnContext,
} from './automation-conversation.js';
import {
  AUTOMATION_TOOLS,
  askUserInput,
  runAutomationTool,
  submitAutomationInput,
  type AutomationToolContext,
} from './automation-tools.js';
import { automationShape, describeAutomation } from '../automations/summarize.js';

/**
 * The automation agent: a tool-use conversation on the Anthropic Messages API.
 *
 * A plain API loop for the reason `agent.ts` is one — the Claude Agent SDK
 * ships a 276 MB native binary and spawns a ~315 MB subprocess per run, which
 * is unusable on the smallest board this hub supports — and *not* a cloud
 * agent for a reason of its own: this agent's tools are the home, and the home
 * is on a local network a provider's container cannot reach. Every tool call
 * would have to be relayed back through a tunnel that does not exist.
 *
 * Three things differ from the mapping loop, and each is because somebody is
 * waiting:
 *
 *  - **it streams**, and the text reaches the socket as it arrives. A mapping
 *    run takes minutes with nobody watching; a chat that shows nothing for
 *    ninety seconds has failed whatever the model is doing;
 *  - **thinking is summarised** rather than omitted. On Opus 5 the default is
 *    `omitted`, which streams empty thinking blocks — correct for a batch job
 *    and, on a chat, a long pause with nothing to show;
 *  - **it suspends.** `ask_user` and a prose ending both hand control back and
 *    the conversation waits, possibly for minutes, inside an object that
 *    outlives the request.
 *
 * There is **no web search and no fetch**. An agent writing a rule for
 * somebody's house has nothing to look up, and leaving the tools out is a
 * plainer promise than any prompt about not using them.
 */

/** Two breakpoints, the shape `agent.ts` arrived at: the explicit one covers
 *  the tools and the system prompt (tools sort ahead of system in the prefix),
 *  and the top-level field puts a second on the growing conversation tail —
 *  which here carries the home inventory and every round of clarification. */
function buildTools(): Anthropic.Tool[] {
  return AUTOMATION_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.schema() as Anthropic.Tool['input_schema'],
  }));
}

class RunUsage {
  private input = 0;
  private output = 0;
  private cacheRead = 0;
  private cacheWrite = 0;

  constructor(private readonly model: string) {}

  add(usage: Anthropic.Usage | undefined): void {
    if (!usage) return;
    this.input += usage.input_tokens ?? 0;
    this.output += usage.output_tokens ?? 0;
    this.cacheRead += usage.cache_read_input_tokens ?? 0;
    this.cacheWrite += usage.cache_creation_input_tokens ?? 0;
  }

  costUsd(): number {
    return estimateCostUsd(this.model, {
      input_tokens: this.input,
      output_tokens: this.output,
      cache_read_input_tokens: this.cacheRead,
      cache_creation_input_tokens: this.cacheWrite,
    });
  }
}

export interface AutomationAgentOptions {
  auth: AgentAuth;
  modelId: string;
  systemPrompt: string;
  /** The first user message: this home, and what was asked. */
  taskPrompt: string;
  tools: AutomationToolContext;
  log: Logger;
}

export function createAutomationConversation(
  options: AutomationAgentOptions,
): AutomationConversation {
  const { auth, modelId, systemPrompt, taskPrompt, tools, log } = options;
  if (!isSupportedModel(modelId)) {
    throw new Error(
      `model "${modelId}" cannot run the automation agent (supported: ${supportedModelIds().join(', ')})`,
    );
  }

  const client = new Anthropic({ apiKey: auth.secret, maxRetries: 3 });
  const definitions = buildTools();
  const usage = new RunUsage(modelId);

  const messages: Anthropic.MessageParam[] = [];
  /** The `ask_user` call the conversation is waiting on, if any. */
  let pendingQuestion: string | null = null;
  let opened = false;

  /**
   * Run rounds until the conversation has something to hand back.
   *
   * The loop ends on the first thing a person could act on, which is what
   * makes this a chat rather than a batch: a question, a submission, prose,
   * or a guardrail.
   */
  async function pump(context: AutomationTurnContext | undefined): Promise<AutomationTurn> {
    const controller = new AbortController();
    const watchdog = setTimeout(() => controller.abort(), AUTOMATION_TIMEOUT_MS);
    watchdog.unref?.();

    try {
      for (let turn = 1; turn <= AUTOMATION_MAX_TURNS; turn += 1) {
        if (usage.costUsd() >= AUTOMATION_MAX_BUDGET_USD) {
          return {
            kind: 'stopped',
            reason:
              'This conversation has reached its cost limit. Start a new one, or write the rule ' +
              'by hand.',
          };
        }

        let response: Anthropic.Message;
        try {
          const stream = client.messages.stream(
            {
              model: modelId,
              max_tokens: MAX_OUTPUT_TOKENS,
              system: [
                { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
              ],
              cache_control: { type: 'ephemeral' },
              messages,
              tools: definitions,
              // `display: 'summarized'` on purpose: the default on Opus 5 is
              // `omitted`, which streams empty thinking blocks — right for a
              // job nobody watches, and a silent minute in a chat.
              thinking: { type: 'adaptive', display: 'summarized' },
              output_config: { effort: EFFORT },
            },
            { signal: controller.signal },
          );
          if (context?.onDelta) stream.on('text', (delta) => context.onDelta?.(delta));
          response = await stream.finalMessage();
        } catch (error) {
          if (controller.signal.aborted) {
            throw new AiUnavailableError(
              'aborted',
              `the automation agent stopped answering after ${AUTOMATION_TIMEOUT_MS / 1000}s`,
            );
          }
          throw classifyApiError(error) ?? error;
        }

        usage.add(response.usage);
        // Verbatim, thinking blocks included — the API requires it when a
        // thinking conversation continues.
        messages.push({ role: 'assistant', content: response.content });

        if (response.stop_reason === 'pause_turn') {
          continue;
        }
        if (response.stop_reason === 'refusal') {
          return {
            kind: 'stopped',
            reason: 'The model declined to answer that. Try asking for it differently.',
          };
        }

        const said = response.content
          .filter((block): block is Anthropic.TextBlock => block.type === 'text')
          .map((block) => block.text)
          .join('\n')
          .trim();

        const calls = response.content.filter(
          (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
        );

        // Prose and nothing else: the model has handed back. That is a
        // perfectly good end to a turn here, unlike in the mapping run where
        // it means the answer channel went unused.
        if (calls.length === 0) {
          return { kind: 'said', text: said || 'Ready when you are.' };
        }

        const results: Anthropic.ToolResultBlockParam[] = [];
        let handedBack: AutomationTurn | null = null;

        for (const call of calls) {
          if (call.name === 'ask_user') {
            const parsed = askUserInput.safeParse(call.input);
            if (!parsed.success) {
              results.push({
                type: 'tool_result',
                tool_use_id: call.id,
                content: `That question could not be asked: ${parsed.error.issues
                  .map((issue) => issue.message)
                  .join('; ')}`,
                is_error: true,
              });
              continue;
            }
            // The conversation stops here and the answer closes this call —
            // which is why `answer()` exists separately from `send()`.
            pendingQuestion = call.id;
            context?.onStep?.('Asked a question.', parsed.data.question);
            handedBack = { kind: 'question', question: parsed.data };
            break;
          }

          if (call.name === 'submit_automation') {
            const outcome = evaluateSubmission(call.input, tools);
            results.push({
              type: 'tool_result',
              tool_use_id: call.id,
              content: outcome.text,
              ...(outcome.accepted ? {} : { is_error: true }),
            });
            context?.onStep?.(
              outcome.accepted ? 'Submitted a rule.' : 'Submitted a rule — it was refused.',
              outcome.accepted ? undefined : outcome.text,
            );
            if (outcome.accepted) {
              handedBack = {
                kind: 'submitted',
                document: outcome.document,
                accepted: true,
                text: said,
                ...(outcome.note !== undefined ? { note: outcome.note } : {}),
              };
            }
            continue;
          }

          const result = runAutomationTool(call.name, call.input, tools);
          context?.onStep?.(`Looked up ${call.name}.`);
          results.push({
            type: 'tool_result',
            tool_use_id: call.id,
            content: result.text,
            ...(result.isError ? { is_error: true } : {}),
          });
        }

        if (handedBack?.kind === 'question') {
          // Nothing is appended: the pending call stays open and `answer()`
          // closes it. Appending a partial result set here would leave the
          // conversation with a tool call the API expects a result for.
          return handedBack;
        }

        messages.push({ role: 'user', content: results });

        if (handedBack) return handedBack;
      }

      return {
        kind: 'stopped',
        reason:
          `The agent used all ${AUTOMATION_MAX_TURNS} steps without finishing. Try saying what ` +
          `you want more directly, or in smaller pieces.`,
      };
    } finally {
      clearTimeout(watchdog);
    }
  }

  /**
   * Check a submission the way the API will, and hand the reasons back inside
   * the same turn.
   *
   * The `submit_mapping` contract: a refusal is a `tool_result`, not the end
   * of a conversation, so the model fixes its document and resubmits without
   * the person ever seeing that it got it wrong once.
   */
  function evaluateSubmission(
    input: unknown,
    context: AutomationToolContext,
  ): { accepted: boolean; text: string; document?: unknown; note?: string | undefined } {
    const outer = submitAutomationInput.safeParse(input);
    if (!outer.success) {
      return {
        accepted: false,
        text: `The submission was not shaped right: ${outer.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ')}`,
      };
    }
    const parsed = automationDocumentSchema.safeParse(outer.data.document);
    if (!parsed.success) {
      return {
        accepted: false,
        text:
          'The rule was refused — schema errors:\n' +
          parsed.error.issues
            .map((issue) => `- ${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('\n'),
      };
    }
    const home = context.home();
    const report = sanityCheckAutomation(parsed.data, home);
    if (report.problems.length > 0) {
      return {
        accepted: false,
        text:
          'The rule was refused — the home cannot use it as written:\n' +
          report.problems.map((problem) => `- ${problem}`).join('\n'),
      };
    }
    const warnings =
      report.warnings.length > 0
        ? `\nWorth telling them about:\n${report.warnings.map((entry) => `- ${entry}`).join('\n')}`
        : '';
    return {
      accepted: true,
      document: parsed.data,
      note: outer.data.note,
      text:
        `Accepted, as a ${automationShape(parsed.data)}: ${describeAutomation(parsed.data, home)}` +
        `${warnings}\nIt is saved switched off. Tell them what it will do, briefly, and stop.`,
    };
  }

  return {
    provider: 'anthropic',
    modelId,

    async send(text, context) {
      if (pendingQuestion !== null) {
        // Somebody typed instead of tapping an option. That is an answer, and
        // treating it as a fresh message would leave the model's question
        // unclosed and the API refusing the conversation.
        return this.answer(text, context);
      }
      messages.push({
        role: 'user',
        content: opened ? text : `${taskPrompt}\n\n${text}`.trim(),
      });
      opened = true;
      log.debug({ model: modelId }, 'automation agent: user message');
      return pump(context);
    },

    async answer(text, context) {
      if (pendingQuestion === null) return this.send(text, context);
      const toolUseId = pendingQuestion;
      pendingQuestion = null;
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }],
      });
      return pump(context);
    },

    awaitingAnswer() {
      return pendingQuestion !== null;
    },

    costUsd() {
      return usage.costUsd();
    },
  };
}
