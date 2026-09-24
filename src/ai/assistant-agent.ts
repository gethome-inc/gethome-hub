import type { AiProvider } from '../core/settings.js';
import type { Logger } from '../logging.js';
import { type AgentAuth } from './agent-core.js';
import { budgetScale, isSupportedModel, supportedModelIds } from './models.js';
import { QuestionGate, type ChatToolResult } from './chat/agent-loop.js';
import { createChatTransport } from './chat/transport.js';
import { AGENT_EFFORT } from './chat/chat-runtime.js';
import type { AgentConversation, ChatTurnContext } from './chat/chat-runtime.js';
import { askUserInput, type AskUser } from './automation-tools.js';
import {
  ASSISTANT_MAX_COMMANDS_PER_DEVICE,
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
 * everything that is the *API's* shape rather than this agent's behind
 * `ChatTransport` — the cache breakpoints, the summarized thinking, the abort
 * that becomes a sentence, and the rule that no request may carry a tool call
 * with no result after it.
 *
 * **It imports no SDK**, and that is what makes the model setting mean
 * anything: the transport is chosen by `createChatTransport` and loaded on
 * demand, so a home with only an OpenAI key never pulls the Anthropic client
 * into its graph. Before that, both agents imported `@anthropic-ai/sdk` at the
 * top of the file, and "the assistant runs on Claude" was a fact about the
 * module graph rather than about anything anybody could change.
 *
 * What is different here from the mapper, and deliberately:
 *
 * **Effort is `medium`.** The mapper runs at `high` because its answer is
 * cached against a device model and shapes every unit of it a home ever meets;
 * a chat is many small rounds, read the moment they arrive, and answered with
 * another message when the reply is poor. It is not exposed — two settings for
 * one decision is one too many, which is the rule the mapper already keeps.
 *
 * **No mid-conversation system messages.** They would be the natural way to
 * inject a changing home, and Sonnet 5 rejects them outright — and the model
 * here is switchable, so the one shape has to work on all of them.
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
/** What one conversation may spend, in total — in Opus 5's dollars, which
 *  `budgetScale` stretches for a model priced above it. */
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
  provider: AiProvider;
  modelId: string;
  systemPrompt: string;
  /** The first user message: this home, and what was asked. */
  taskPrompt: string;
  tools: AssistantToolContext;
  log: Logger;
}

export async function createAssistantConversation(
  options: AssistantAgentOptions,
): Promise<AgentConversation<AssistantTurn>> {
  const { auth, provider, modelId, systemPrompt, taskPrompt, tools, log } = options;
  if (!isSupportedModel(modelId, provider)) {
    throw new Error(
      `model "${modelId}" cannot run the assistant ` +
        `(supported: ${supportedModelIds(provider).join(', ')})`,
    );
  }

  /**
   * One controller for the conversation's life rather than one per turn.
   *
   * The transport is built once and holds the signal, so the watchdog is armed
   * around each `round()` and disarmed after it — `AbortSignal.timeout` per
   * request would need a new transport per turn, which is the history thrown
   * away every round.
   */
  const controller = new AbortController();
  const transport = await createChatTransport(provider, {
    secret: auth.secret,
    modelId,
    systemPrompt,
    tools: assistantTools(tools.delegates),
    label: 'the assistant',
    timeoutMs: ASSISTANT_TIMEOUT_MS,
    // See the note at the top of the file: a chat, not a cached descriptor.
    effort: AGENT_EFFORT,
    signal: controller.signal,
    log,
  });

  const gate = new QuestionGate(transport);
  let opened = false;
  /**
   * The conversation's cap in its own model's dollars — see `budgetScale`.
   * It was sized against Opus 5, and a model priced twice as high would
   * otherwise end a conversation at half the rounds any other one allows.
   */
  const budgetUsd = ASSISTANT_MAX_BUDGET_USD * budgetScale(modelId);

  async function pump(context: ChatTurnContext | undefined): Promise<AssistantTurn> {
    const watchdog = setTimeout(() => controller.abort(), ASSISTANT_TIMEOUT_MS);
    watchdog.unref?.();

    /**
     * What this whole turn has handed over, and how many commands it has sent
     * each device.
     *
     * Both are per *turn* rather than per round, because both are about what
     * one reply does to somebody's house: a model working one lamp over and
     * over would otherwise be told no, and start again on the next round of
     * the same reply. See `ASSISTANT_MAX_COMMANDS_PER_DEVICE` for why there is
     * no bound on how many devices one reply may work.
     */
    const handoffs: AssistantHandoff[] = [];
    const budget = { perDevice: new Map<string, number>() };

    try {
      for (let turn = 1; turn <= ASSISTANT_MAX_TURNS; turn += 1) {
        /**
         * **Say something before the request, not after it.** The first thing
         * that happens in a round is tens of seconds of the model reading and
         * deciding — no tool called, no word written — and that was the whole
         * of what somebody saw.
         */
        context?.onStep?.(turn === 1 ? 'Reading your home' : 'Working it out', 'thinking');

        if (transport.costUsd() >= budgetUsd) {
          return {
            kind: 'stopped',
            reason: 'This conversation has reached its cost limit. Start a new one to carry on.',
          };
        }

        const round = await transport.round(context);

        if (round.stop === 'refusal') {
          return { kind: 'stopped', reason: round.refusal ?? 'The model declined to answer that.' };
        }

        const { said, calls } = round;

        // A pause is the API asking to be called again with the same
        // conversation — but only once anything it *did* call has been
        // answered, so this is asked after the calls are in hand.
        if (calls.length === 0 && round.stop === 'pause') continue;

        // Prose and nothing else: the model has handed back, which is the
        // ordinary end of a turn here. Anything handed to another agent during
        // this turn rides out with the sentence that describes it.
        if (calls.length === 0) {
          const text = said || 'Ready when you are.';
          return handoffs.length > 0 ? { kind: 'handed', handoffs, text } : { kind: 'said', text };
        }

        const results: ChatToolResult[] = [];
        let question: AssistantTurn | null = null;

        for (const call of calls) {
          if (call.name === 'ask_user') {
            const parsed = askUserInput.safeParse(call.input);
            if (!parsed.success) {
              results.push({
                id: call.id,
                text: `That question could not be asked: ${parsed.error.issues
                  .map((issue) => issue.message)
                  .join('; ')}`,
                isError: true,
              });
              continue;
            }
            if (gate.isOpen) {
              // Two questions in one response. Only one can be outstanding —
              // an answer closes one call id — so the second is refused here
              // rather than left open, which would be the same 400 by another
              // route.
              results.push({
                id: call.id,
                text:
                  'Only one question can be outstanding at a time. Ask this one after the ' +
                  'first is answered.',
                isError: true,
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
                id: call.id,
                text: 'That handover needs an agent key and a brief.',
                isError: true,
              });
              continue;
            }
            const outcome = await tools.delegate(
              parsed.data.agent,
              parsed.data.brief,
              parsed.data.fresh,
            );
            if (outcome.refused !== undefined) {
              context?.onStep?.('Could not hand that over', 'writing', outcome.refused);
              results.push({ id: call.id, text: outcome.refused, isError: true });
              continue;
            }
            handoffs.push({
              agent: parsed.data.agent,
              brief: parsed.data.brief,
              sessionId: outcome.sessionId,
            });
            context?.onStep?.('Handed this to another agent', 'writing', parsed.data.brief);
            results.push({ id: call.id, text: outcome.text });
            continue;
          }

          const result = await runAssistantTool(call.name, call.input, tools, budget);
          const step = assistantToolStep(call.name);
          // The tool's own line about what it actually did — which device, how
          // many matched. Absent for a tool with nothing worth reading under
          // its name.
          context?.onStep?.(step.summary, step.kind, result.detail);
          results.push({
            id: call.id,
            text: result.text,
            ...(result.isError ? { isError: true } : {}),
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

        transport.pushToolResults(results);
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

  /**
   * Named rather than returned inline, because `send` and `answer` route into
   * each other and `this` inside an object literal typed by a *promised*
   * return is the union of the two — the price of the constructor becoming
   * async so it can load one vendor's transport and not the other.
   */
  const conversation: AgentConversation<AssistantTurn> = {
    provider,
    modelId,
    // What this conversation works at, for the run log to read back rather
    // than re-derive. A single turn may still ask for something else.
    effort: AGENT_EFFORT,

    async send(text, context) {
      if (gate.isOpen) {
        // Somebody typed instead of tapping an option. That is an answer, and
        // treating it as a fresh message would leave the model's question
        // unclosed and the API refusing the conversation.
        return conversation.answer(text, context);
      }
      // **Nothing is ever sent with a tool call left unanswered.** Here rather
      // than beside the request, which is where it can never fire: mid-loop the
      // last message is always the results of the round before.
      gate.settleDangling();
      transport.pushUser(opened ? text : `${taskPrompt}\n\n${text}`.trim());
      opened = true;
      log.debug({ model: modelId, provider }, 'assistant: user message');
      return pump(context);
    },

    async answer(text, context) {
      if (!gate.isOpen) return conversation.send(text, context);
      // The answer **and** every other call the same response made. One
      // message, every call in the assistant turn accounted for.
      gate.answer(text);
      return pump(context);
    },

    awaitingAnswer() {
      return gate.isOpen;
    },

    costUsd() {
      return transport.costUsd();
    },
  };
  return conversation;
}

export { ASSISTANT_MAX_COMMANDS_PER_DEVICE };
