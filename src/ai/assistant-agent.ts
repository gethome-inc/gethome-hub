import Anthropic from '@anthropic-ai/sdk';
import type { Logger } from '../logging.js';
import { type AgentAuth } from './agent-core.js';
import { isSupportedModel, supportedModelIds } from './models.js';
import { QuestionGate, RunUsage, streamTurn } from './chat/agent-loop.js';
import type { AgentConversation, ChatTurnContext } from './chat/chat-runtime.js';
import { askUserInput, type AskUser } from './automation-tools.js';
import {
  ASSISTANT_MAX_COMMANDS_PER_TURN,
  assistantToolStep,
  assistantTools,
  delegateInput,
  runAssistantTool,
  type AssistantToolContext,
} from './assistant-tools.js';

/**
 * The assistant's loop.
 *
 * The same shape as the automations agent's and none of the same tools, with
 * everything that is the *API's* shape rather than this agent's shared through
 * `chat/agent-loop.ts` — the cache breakpoints, the summarized thinking, the
 * abort that becomes a sentence, and the rule that no request may carry a
 * `tool_use` with no `tool_result` after it.
 *
 * What is different here, and deliberately:
 *
 * **Effort is `medium`.** The mapper runs at `high` because its answer is
 * cached against a device model and shapes every unit of it a home ever meets;
 * a chat is many small rounds, read the moment they arrive, and answered with
 * another message when the reply is poor. It is not exposed — two settings for
 * one decision is one too many, which is the rule the mapper already keeps.
 *
 * **No mid-conversation system messages.** They would be the natural way to
 * inject a changing home, and Sonnet 5 rejects them outright — and the model
 * here is switchable, so the one shape has to work on both.
 *
 * **A turn can end with work handed to another agent.** `delegate` is an
 * ordinary tool that returns in milliseconds: it starts the other agent's
 * conversation and hands back its id, so the model can say what it did in the
 * same breath. What it never does is wait, which is the whole point — the
 * other agent's rounds are its own and never enter this context.
 */

/** Provider rounds one *user message* may cost. A person is waiting, and this
 *  one is usually answering rather than building something. */
export const ASSISTANT_MAX_TURNS = 10;
/** What one conversation may spend, in total. */
export const ASSISTANT_MAX_BUDGET_USD = 0.5;
/** One turn's wall clock. Two minutes, not the automations agent's three: this
 *  one is not writing a document and a silent two minutes has already failed. */
export const ASSISTANT_TIMEOUT_MS = 2 * 60_000;

/** One job handed to another agent, as the chat will write it down. */
export interface AssistantHandoff {
  agent: string;
  brief: string;
  sessionId: string;
}

export type AssistantTurn =
  | { kind: 'question'; question: AskUser }
  | { kind: 'said'; text: string }
  | { kind: 'stopped'; reason: string }
  | { kind: 'handed'; handoffs: AssistantHandoff[]; text: string };

export interface AssistantAgentOptions {
  auth: AgentAuth;
  modelId: string;
  systemPrompt: string;
  /** The first user message: this home, and what was asked. */
  taskPrompt: string;
  tools: AssistantToolContext;
  log: Logger;
}

export function createAssistantConversation(
  options: AssistantAgentOptions,
): AgentConversation<AssistantTurn> {
  const { auth, modelId, systemPrompt, taskPrompt, tools, log } = options;
  if (!isSupportedModel(modelId)) {
    throw new Error(
      `model "${modelId}" cannot run the assistant (supported: ${supportedModelIds().join(', ')})`,
    );
  }

  const client = new Anthropic({ apiKey: auth.secret, maxRetries: 3 });
  const definitions = assistantTools(tools.delegates).map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.schema() as Anthropic.Tool['input_schema'],
  }));
  const usage = new RunUsage(modelId);

  const messages: Anthropic.MessageParam[] = [];
  const gate = new QuestionGate(messages, log, 'assistant');
  let opened = false;

  async function pump(context: ChatTurnContext | undefined): Promise<AssistantTurn> {
    const controller = new AbortController();
    const watchdog = setTimeout(() => controller.abort(), ASSISTANT_TIMEOUT_MS);
    watchdog.unref?.();

    /**
     * What this whole turn has handed over, and how many devices it has
     * worked.
     *
     * Both are per *turn* rather than per round, because both are about what
     * one reply does to somebody's house: a model that has misread "everything
     * off" would otherwise spend its cap, be told no, and spend it again on
     * the next round of the same reply.
     */
    const handoffs: AssistantHandoff[] = [];
    const budget = { commands: 0 };

    try {
      for (let turn = 1; turn <= ASSISTANT_MAX_TURNS; turn += 1) {
        /**
         * **Say something before the request, not after it.** The first thing
         * that happens in a round is tens of seconds of the model reading and
         * deciding — no tool called, no word written — and that was the whole
         * of what somebody saw.
         */
        context?.onStep?.(turn === 1 ? 'Reading your home' : 'Working it out', 'thinking');

        if (usage.costUsd() >= ASSISTANT_MAX_BUDGET_USD) {
          return {
            kind: 'stopped',
            reason: 'This conversation has reached its cost limit. Start a new one to carry on.',
          };
        }

        const round = await streamTurn({
          client,
          modelId,
          systemPrompt,
          messages,
          tools: definitions,
          signal: controller.signal,
          usage,
          context,
          label: 'the assistant',
          timeoutMs: ASSISTANT_TIMEOUT_MS,
          // See the note at the top of the file: a chat, not a cached
          // descriptor.
          effort: 'medium',
        });

        if (round.response.stop_reason === 'refusal') {
          return {
            kind: 'stopped',
            reason: 'The model declined to answer that. Try asking for it differently.',
          };
        }

        const { said, calls } = round;

        // A pause is the API asking to be called again with the same
        // conversation — but only once anything it *did* call has been
        // answered, so this is asked after the calls are in hand.
        if (calls.length === 0 && round.response.stop_reason === 'pause_turn') continue;

        // Prose and nothing else: the model has handed back, which is the
        // ordinary end of a turn here. Anything handed to another agent during
        // this turn rides out with the sentence that describes it.
        if (calls.length === 0) {
          const text = said || 'Ready when you are.';
          return handoffs.length > 0 ? { kind: 'handed', handoffs, text } : { kind: 'said', text };
        }

        const results: Anthropic.ToolResultBlockParam[] = [];
        let question: AssistantTurn | null = null;

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
            if (gate.isOpen) {
              // Two questions in one response. Only one can be outstanding —
              // an answer closes one call id — so the second is refused here
              // rather than left open, which would be the same 400 by another
              // route.
              results.push({
                type: 'tool_result',
                tool_use_id: call.id,
                content:
                  'Only one question can be outstanding at a time. Ask this one after the ' +
                  'first is answered.',
                is_error: true,
              });
              continue;
            }
            // The conversation stops here and the answer closes this call —
            // which is why `answer()` exists separately from `send()`.
            //
            // **`continue`, never `break`.** Every other call in this same
            // response still needs its result, and skipping them leaves the
            // assistant turn half-answered and the API refusing the whole
            // conversation on the next request.
            gate.open(call.id);
            context?.onStep?.('Asking you something', 'asking', parsed.data.question);
            question = { kind: 'question', question: parsed.data };
            continue;
          }

          if (call.name === 'delegate') {
            const parsed = delegateInput.safeParse(call.input);
            if (!parsed.success) {
              results.push({
                type: 'tool_result',
                tool_use_id: call.id,
                content: 'That handover needs an agent key and a brief.',
                is_error: true,
              });
              continue;
            }
            const outcome = await tools.delegate(parsed.data.agent, parsed.data.brief);
            if (outcome.refused !== undefined) {
              context?.onStep?.('Could not hand that over', 'writing', outcome.refused);
              results.push({
                type: 'tool_result',
                tool_use_id: call.id,
                content: outcome.refused,
                is_error: true,
              });
              continue;
            }
            handoffs.push({
              agent: parsed.data.agent,
              brief: parsed.data.brief,
              sessionId: outcome.sessionId,
            });
            context?.onStep?.('Handed this to another agent', 'writing', parsed.data.brief);
            results.push({ type: 'tool_result', tool_use_id: call.id, content: outcome.text });
            continue;
          }

          const result = await runAssistantTool(call.name, call.input, tools, budget);
          const step = assistantToolStep(call.name);
          // The tool's own line about what it actually did — which device, how
          // many matched. Absent for a tool with nothing worth reading under
          // its name.
          context?.onStep?.(step.summary, step.kind, result.detail);
          results.push({
            type: 'tool_result',
            tool_use_id: call.id,
            content: result.text,
            ...(result.isError ? { is_error: true } : {}),
          });
        }

        if (question !== null) {
          // Nothing is appended *yet*: the API wants one user message carrying
          // a result for every call in the assistant turn, and the question's
          // own result is the person's answer, which does not exist until they
          // give it. So the rest are stashed and `answer()` sends them all
          // together.
          gate.stash(results);
          return question;
        }

        messages.push({ role: 'user', content: results });
      }

      // Out of rounds. Anything already handed over still happened and still
      // has to be said, or a rule would be written with nothing on screen
      // saying who asked for it.
      const text =
        `I have used all ${ASSISTANT_MAX_TURNS} steps on that without finishing. ` +
        'Try asking for it more directly, or in smaller pieces.';
      return handoffs.length > 0
        ? { kind: 'handed', handoffs, text }
        : { kind: 'stopped', reason: text };
    } finally {
      clearTimeout(watchdog);
    }
  }

  return {
    provider: 'anthropic',
    modelId,

    async send(text, context) {
      if (gate.isOpen) {
        // Somebody typed instead of tapping an option. That is an answer, and
        // treating it as a fresh message would leave the model's question
        // unclosed and the API refusing the conversation.
        return this.answer(text, context);
      }
      // **Nothing is ever sent with a `tool_use` left unanswered.** Here
      // rather than beside the request, which is where it can never fire:
      // mid-loop the last message is always the results of the round before.
      gate.settleDangling();
      messages.push({
        role: 'user',
        content: opened ? text : `${taskPrompt}\n\n${text}`.trim(),
      });
      opened = true;
      log.debug({ model: modelId }, 'assistant: user message');
      return pump(context);
    },

    async answer(text, context) {
      if (!gate.isOpen) return this.send(text, context);
      // The answer **and** every other call the same response made. One
      // message, every `tool_use` in the assistant turn accounted for.
      gate.answer(text);
      return pump(context);
    },

    awaitingAnswer() {
      return gate.isOpen;
    },

    costUsd() {
      return usage.costUsd();
    },
  };
}

export { ASSISTANT_MAX_COMMANDS_PER_TURN };
