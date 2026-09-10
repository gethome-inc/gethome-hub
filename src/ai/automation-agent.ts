import Anthropic from '@anthropic-ai/sdk';
import type { Logger } from '../logging.js';
import { automationDocumentSchema } from '../automations/schema.js';
import { sanityCheckAutomation } from '../automations/sanity.js';
import { type AgentAuth } from './agent-core.js';
import { isSupportedModel, supportedModelIds } from './models.js';
import { QuestionGate, RunUsage, refusalSentence, streamTurn } from './chat/agent-loop.js';
import {
  AUTOMATION_MAX_BUDGET_USD,
  AUTOMATION_MAX_RULES_PER_TURN,
  AUTOMATION_MAX_TURNS,
  AUTOMATION_TIMEOUT_MS,
  type AutomationConversation,
  type AutomationTurn,
  type AutomationTurnContext,
  type SubmittedRule,
  type SubmittedTurn,
} from './automation-conversation.js';
import {
  AUTOMATION_TOOLS,
  askUserInput,
  runAutomationTool,
  submitAutomationInput,
  toolStep,
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
  /**
   * The question this conversation is waiting on, and the other results from
   * the same response that travel with its answer.
   *
   * Shared with the assistant (`chat/agent-loop.ts`), because the two bugs it
   * exists for are the API's rule rather than this agent's: every `tool_use`
   * in a response needs a `tool_result` in the very next message, and a
   * conversation that breaks that is refused outright and for ever.
   */
  const gate = new QuestionGate(messages, log, 'automation agent');

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

    /**
     * A rule that was accepted with nothing said about it, held back for one
     * more round so the model can say its line.
     *
     * **A card with no words above it is the worst answer this agent gives.**
     * The prompt asks for the sentence in the same message as the call — the
     * turn ends the moment a rule is accepted, so anything planned for
     * "afterwards" is never written — and a model that forgets leaves somebody
     * who asked for a change staring at a rule card with no idea what was
     * decided or why. The rule is already saved by then, so there is nothing
     * to undo; what is missing is only the sentence, and the one thing that
     * can supply it is the model.
     *
     * So the accepted submission is *kept* rather than returned, the results
     * (which already say "Accepted") go back, and the loop runs once more.
     * Exactly once: the flag is what ends it, so a model that answers with
     * more tool calls hands the card over with whatever it did say rather than
     * spending another round. It costs a round trip only in the case where the
     * words are missing, which the prompt is written to make rare.
     */
    // A holder rather than a bare `let`: read before the assignment that fills
    // it, a `let` is flow-narrowed to `null` for the whole first pass, and the
    // read below is exactly there — one round earlier in the same loop.
    const silence: { submission: SubmittedTurn | null } = { submission: null };

    try {
      for (let turn = 1; turn <= AUTOMATION_MAX_TURNS; turn += 1) {
        /**
         * **Say something before the request, not after it.**
         *
         * Every other step here is reported once something has happened, and
         * the first thing that happens in a round is tens of seconds of the
         * model reading the home and deciding — no tool called, no word of the
         * reply written. That was the whole of what somebody saw: a spinner.
         * The wording splits on the round because it is a different wait: the
         * first is reading a home it has just been handed, and every one after
         * is working with what the tools came back with.
         */
        context?.onStep?.(
          turn === 1 ? 'Reading your home' : 'Working it out',
          'thinking',
        );

        if (usage.costUsd() >= AUTOMATION_MAX_BUDGET_USD) {
          return {
            kind: 'stopped',
            reason:
              'This conversation has reached its cost limit. Start a new one, or write the rule ' +
              'by hand.',
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
          label: 'the automation agent',
          timeoutMs: AUTOMATION_TIMEOUT_MS,
        });
        const response = round.response;

        if (response.stop_reason === 'refusal') {
          return {
            kind: 'stopped',
            reason: refusalSentence(response),
          };
        }

        const { said, calls } = round;

        // A pause is the API asking to be called again with the same
        // conversation — but only once anything it *did* call has been
        // answered, so this is asked after the calls are in hand rather than
        // before, which used to skip straight past them and leave the turn
        // half-answered.
        if (calls.length === 0 && response.stop_reason === 'pause_turn') {
          continue;
        }

        // Prose and nothing else: the model has handed back. That is a
        // perfectly good end to a turn here, unlike in the mapping run where
        // it means the answer channel went unused — a question about the home
        // is answered by writing back and by nothing else.
        if (calls.length === 0) {
          // The words a silent submission was sent back for. The rule is
          // already saved; this is the sentence that goes above its card.
          const submitted = silence.submission;
          if (submitted !== null) return { ...submitted, text: said };
          return { kind: 'said', text: said || 'Ready when you are.' };
        }

        const results: Anthropic.ToolResultBlockParam[] = [];
        let handedBack: AutomationTurn | null = null;
        /**
         * Every rule accepted in *this* response, in the order they were
         * submitted.
         *
         * One reply can legitimately carry two — "lights on when I come in and
         * off when I leave" is two rules, which the prompt has always said —
         * and a single `handedBack` meant the second overwrote the first: both
         * were told "Accepted" and only one was ever saved.
         */
        const submitted: SubmittedRule[] = [];

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
            if (handedBack?.kind === 'submitted') {
              // A rule was accepted earlier in this same response, and that
              // ends the turn: the person is handed a preview to look at. A
              // question asked beside it has nothing to attach to — the turn
              // is over before it could be answered — and the loop can only
              // hand one thing back, so leaving both set was how one of them
              // got silently dropped. Refused inside the turn, which the
              // model can act on, rather than after it, which nobody can.
              results.push({
                type: 'tool_result',
                tool_use_id: call.id,
                content:
                  'A rule has already been submitted in this response, which ends the turn. ' +
                  'Ask this once they have replied.',
                is_error: true,
              });
              continue;
            }
            // The conversation stops here and the answer closes this call —
            // which is why `answer()` exists separately from `send()`.
            //
            // **`continue`, never `break`.** Every other call in this same
            // response still needs its result, and skipping them left the
            // assistant turn half-answered and the API refusing the whole
            // conversation on the next request.
            gate.open(call.id);
            context?.onStep?.(toolStep('ask_user').summary, 'asking', parsed.data.question);
            handedBack = { kind: 'question', question: parsed.data };
            continue;
          }

          if (call.name === 'submit_automation') {
            if (submitted.length >= AUTOMATION_MAX_RULES_PER_TURN) {
              // Bounded rather than refused outright: what is already accepted
              // is saved and shown, and the rest are asked for again once the
              // person has seen these — a reply that writes a page of rules
              // into somebody's home is a misread, not an answer.
              results.push({
                type: 'tool_result',
                tool_use_id: call.id,
                content:
                  `That is more than ${AUTOMATION_MAX_RULES_PER_TURN} rules in one reply. The ` +
                  'ones already accepted are saved; tell them what those do and offer the rest ' +
                  'once they have replied.',
                is_error: true,
              });
              continue;
            }
            const outcome = evaluateSubmission(call.input, tools);
            results.push({
              type: 'tool_result',
              tool_use_id: call.id,
              content: outcome.text,
              ...(outcome.accepted ? {} : { is_error: true }),
            });
            context?.onStep?.(
              // The refusal is worth naming: a resubmission is the ordinary
              // shape of a working run, and a trail that showed "Writing the
              // rule" twice with nothing between them reads as a stutter.
              outcome.accepted ? 'Wrote the rule' : 'Fixing the rule',
              'writing',
              outcome.accepted ? undefined : outcome.text,
            );
            if (outcome.accepted) {
              submitted.push({
                document: outcome.document,
                replaces: outcome.replaces ?? null,
                ...(outcome.note !== undefined ? { note: outcome.note } : {}),
              });
              // **The other order of the same collision**, and the more
              // expensive one: with a question already open, overwriting it
              // here left `ask_user`'s call with no result and the next
              // request carrying a half-answered assistant turn — `400
              // tool_use ids were found without tool_result blocks`, the
              // conversation refused outright and unrecoverable, since
              // `pendingQuestion` then routed the person's reply into a
              // second orphaned result. Returning the question instead would
              // be worse in a quieter way: the model was told "Accepted" and
              // the rule would never be written.
              //
              // So the submission wins and the question is retracted, in the
              // turn, where the model can see it happen.
              gate.retract(
                results,
                'That question was not asked: a rule was submitted in the same response, ' +
                  'which ends the turn. Ask it once they have replied.',
              );
              handedBack = { kind: 'submitted', rules: submitted, text: said };
            }
            continue;
          }

          const result = runAutomationTool(call.name, call.input, tools);
          const step = toolStep(call.name);
          // The tool's own line about what it actually did — which device, how
          // many matched, the sentence a draft would carry. Absent for a tool
          // that has nothing worth reading under its name.
          context?.onStep?.(step.summary, step.kind, result.detail);
          results.push({
            type: 'tool_result',
            tool_use_id: call.id,
            content: result.text,
            ...(result.isError ? { is_error: true } : {}),
          });
        }

        if (handedBack?.kind === 'question') {
          // Nothing is appended *yet*: the API wants one user message carrying
          // a result for every call in the assistant turn, and the question's
          // own result is the person's answer, which does not exist until they
          // give it. So the rest are stashed and `answer()` sends them all
          // together.
          gate.stash(results);
          return handedBack;
        }

        messages.push({ role: 'user', content: results });

        // A rule accepted with nothing said about it: keep it, and give the
        // model one round to say what it did. Anything it says next comes back
        // through the no-calls branch above, carrying this submission with it.
        if (handedBack?.kind === 'submitted' && handedBack.text.trim().length === 0) {
          if (silence.submission !== null) return handedBack;
          silence.submission = handedBack;
          context?.onStep?.('Writing it up for you', 'thinking');
          continue;
        }

        if (handedBack) return handedBack;

        // **Exactly one round, whatever that round turns out to be.** The rule
        // is already saved and the person is waiting in front of it, so a model
        // that answered the ask with more tool calls does not get to spend a
        // third round on a sentence: it is handed over with whatever it did
        // say, which is usually nothing and is no worse than before.
        const held = silence.submission;
        if (held !== null) return { ...held, text: said };
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
  ): {
    accepted: boolean;
    text: string;
    document?: unknown;
    note?: string | undefined;
    replaces?: string | null;
  } {
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
      replaces: outer.data.replaces,
      // **An outcome, not an instruction.** This used to end "Tell them what it
      // will do, briefly, and stop" — advice the model can never take, since
      // accepting a submission ends the turn and this result is only read on
      // the *next* one, where it is stale and reads as a request to describe a
      // rule from last time. Asking for that line belongs in the system
      // prompt, where it is read before the response is composed.
      text:
        `Accepted, as a ${automationShape(parsed.data)}: ${describeAutomation(parsed.data, home)}` +
        `${warnings}\n` +
        (outer.data.replaces === null
          ? 'It is saved as a new rule, switched off, and they have been shown a card for it.'
          : 'It replaces the rule you named, and they have been shown a card for it.'),
    };
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
      /**
       * **Nothing is ever sent with a `tool_use` left unanswered**, which is
       * the API's one structural rule about this loop: every call in an
       * assistant turn needs a result in the very next message, and a
       * conversation that breaks it is refused *outright*, for ever, with
       * `messages.N: tool_use ids were found without tool_result blocks`.
       *
       * Here rather than beside the request, which is where it was first put
       * and where it can never fire: mid-loop the last message is always the
       * results of the round before. A round that *ended* badly is what leaves
       * a dangling turn, and this is the next thing that happens after one —
       * `exchange` catches the throw, writes a note and leaves the
       * conversation open, so the damage is invisible until somebody says
       * something else and is then refused, along with everything after it.
       *
       * `answer()` deliberately does not do this: a pending question's turn is
       * outstanding by design and `pendingResults` already accounts for every
       * other call in it.
       */
      gate.settleDangling();
      messages.push({
        role: 'user',
        content: opened ? text : `${taskPrompt}\n\n${text}`.trim(),
      });
      opened = true;
      log.debug({ model: modelId }, 'automation agent: user message');
      return pump(context);
    },

    async answer(text, context) {
      if (!gate.isOpen) return this.send(text, context);
      // The answer **and** every other call the same response made. One
      // message, every `tool_use` in the assistant turn accounted for — which
      // is the API's actual rule, and sending only the answer is what used to
      // refuse the conversation outright.
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
