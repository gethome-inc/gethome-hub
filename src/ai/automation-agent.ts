import type { AiProvider } from '../core/settings.js';
import type { Logger } from '../logging.js';
import { automationDocumentSchema } from '../automations/schema.js';
import { sanityCheckAutomation } from '../automations/sanity.js';
import { type AgentAuth } from './agent-core.js';
import { budgetScale, isSupportedModel, supportedModelIds } from './models.js';
import {
  NOT_ASKED,
  QuestionGate,
  TurnAbort,
  notDone,
  type ChatToolResult,
} from './chat/agent-loop.js';
import { createChatTransport } from './chat/transport.js';
import { AGENT_EFFORT } from './chat/chat-runtime.js';
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
 * The automation agent: a tool-use conversation on whichever vendor answers —
 * Anthropic's Messages API or OpenAI's Responses API, behind one
 * `ChatTransport` (`chat/transport.ts`), so nothing in this file branches on
 * which.
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
 *  - **thinking is summarised** rather than omitted. On Opus 5 and after the
 *    default is `omitted`, which streams empty thinking blocks — correct for a batch job
 *    and, on a chat, a long pause with nothing to show;
 *  - **it suspends.** `ask_user` and a prose ending both hand control back and
 *    the conversation waits, possibly for minutes, inside an object that
 *    outlives the request.
 *
 * There is **no web search and no fetch**. An agent writing a rule for
 * somebody's house has nothing to look up, and leaving the tools out is a
 * plainer promise than any prompt about not using them.
 */

export interface AutomationAgentOptions {
  auth: AgentAuth;
  provider: AiProvider;
  modelId: string;
  systemPrompt: string;
  /** The first user message: this home, and what was asked. */
  taskPrompt: string;
  tools: AutomationToolContext;
  log: Logger;
}

export async function createAutomationConversation(
  options: AutomationAgentOptions,
): Promise<AutomationConversation> {
  const { auth, provider, modelId, systemPrompt, taskPrompt, tools, log } = options;
  if (!isSupportedModel(modelId, provider)) {
    throw new Error(
      `model "${modelId}" cannot run the automation agent ` +
        `(supported: ${supportedModelIds(provider).join(', ')})`,
    );
  }

  const transport = await createChatTransport(provider, {
    secret: auth.secret,
    modelId,
    systemPrompt,
    tools: AUTOMATION_TOOLS,
    label: 'the automation agent',
    timeoutMs: AUTOMATION_TIMEOUT_MS,
    effort: AGENT_EFFORT,
    log,
  });

  /** The conversation's cap in its own model's dollars — see `budgetScale`. */
  const budgetUsd = AUTOMATION_MAX_BUDGET_USD * budgetScale(modelId);

  /**
   * The question this conversation is waiting on, and the other results from
   * the same response that travel with its answer.
   *
   * Shared with the assistant (`chat/agent-loop.ts`), because the two bugs it
   * exists for are the API's rule rather than this agent's: every tool call in
   * a response needs a result in the very next message, and a conversation
   * that breaks that is refused outright and for ever.
   */
  const gate = new QuestionGate(transport);

  let opened = false;

  /**
   * Run rounds until the conversation has something to hand back.
   *
   * The loop ends on the first thing a person could act on, which is what
   * makes this a chat rather than a batch: a question, a submission, prose,
   * or a guardrail.
   */
  async function pump(context: AutomationTurnContext | undefined): Promise<AutomationTurn> {
    // The watchdog and the person's stop, for this turn and no other — see
    // `TurnAbort` on the conversation-wide controller it replaced.
    const abort = new TurnAbort(context?.signal, AUTOMATION_TIMEOUT_MS);

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

    /**
     * What a response submitted, after what is held: one turn, one list, in the
     * order they came. The round for a silent rule's line can submit another —
     * "and one for the night" — with words or without, and handing the new
     * submission back on its own dropped the held one, which the model had been
     * told was saved a round earlier.
     */
    const withHeld = (submission: SubmittedTurn): SubmittedTurn => {
      const earlier = silence.submission;
      return earlier === null
        ? submission
        : { ...submission, rules: [...earlier.rules, ...submission.rules] };
    };

    /**
     * **The turn the person stopped, ended with what it had.** A rule the
     * model was told is saved is saved — the result said "Accepted", and a
     * history that says so about a rule that does not exist is a conversation
     * that lies to itself from then on — with the words it had said above its
     * card, or what reached the page before the stop where it had said none.
     * A rule accepted before the stop goes after one held for its line, never
     * in place of it.
     */
    const halted = (text: string, accepted: SubmittedTurn | null = null): AutomationTurn => {
      const held = accepted !== null ? withHeld(accepted) : silence.submission;
      if (held === null) return { kind: 'said', text, halted: { acted: false } };
      return {
        ...held,
        text: held.text.trim().length > 0 ? held.text : text,
        halted: { acted: true },
      };
    };

    /**
     * **Whatever ends the turn, a held rule is handed over.** Its results went
     * back saying "Accepted" — the model's own history says the rule is saved
     * and that they have been shown a card for it — so every way out of the
     * round spent on its line has to deliver it, and only the two that round
     * was written for did: the line, and more tool calls. The cost limit and a
     * refusal returned `stopped`, running out of rounds fell through to it, a
     * question was returned instead, a second submission was returned on its
     * own and a throw took the turn with it — each one a conversation whose
     * history says a rule exists that was never saved, contradicting itself
     * from then on over a card nobody saw.
     *
     * So every exit asks this first, and answers what it always answered only
     * when nothing is held (`handOver(…) ?? …`). `said` is whatever the round
     * got out before it ended; `stopped` is a sentence of the hub's own for
     * the note under the cards, which only the cost limit has. A person's stop
     * keeps the same promise through `halted`, above.
     */
    const handOver = (said: string, stopped?: string): SubmittedTurn | null => {
      const held = silence.submission;
      if (held === null) return null;
      return { ...held, text: said, ...(stopped !== undefined ? { stopped } : {}) };
    };

    try {
      for (let turn = 1; turn <= AUTOMATION_MAX_TURNS; turn += 1) {
        // Between rounds is the cleanest place a stop can land: every call so
        // far is answered and the next request has not gone.
        if (abort.halted) return halted('');

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

        if (transport.costUsd() >= budgetUsd) {
          /**
           * **The cap holds for the round a held rule's line would cost too**,
           * so nothing is spent past it and the rule goes over without its
           * line — and the limit is still said, under the cards rather than
           * instead of them. It is the one exit whose sentence is about what
           * comes next: every later message here meets this same check, and
           * somebody looking at a card with nothing above it should learn why
           * now rather than by being refused on the next thing they say.
           * Worded for what is on the page, since "write the rule by hand" is
           * advice for a turn that produced none.
           */
          return (
            handOver(
              '',
              'This conversation has reached its cost limit. Start a new one to carry on.',
            ) ?? {
              kind: 'stopped',
              reason:
                'This conversation has reached its cost limit. Start a new one, or write the rule ' +
                'by hand.',
            }
          );
        }

        const round = await transport.round(context, abort.signal);

        // Stopped while the model was answering: what it had said is the
        // answer, and nothing it was about to call was called.
        if (round.stop === 'halted') return halted(round.said);

        if (round.stop === 'refusal') {
          /**
           * **A refusal of the line is not a refusal of the request**, so with
           * a rule held the turn is not `refused`. Every refusal sentence is
           * written for a request that was declined — "try asking for it
           * differently" — and so is what the runtime does with one: offer
           * another model, and let the message go from the model's memory.
           * Here the rule that was asked for is saved and its card says what it
           * does; what the model declined was the line above it, which leaves
           * the card where more tool calls would have, handed over with
           * whatever the round kept. A refusal that is about the conversation
           * meets the next message, where all of that is true.
           */
          const held = handOver(round.said);
          if (held !== null) {
            log.info(
              { model: modelId, provider },
              'automation agent: the line for a saved rule was declined',
            );
            return held;
          }
          // Marked, because a refusal is the one stop another model may
          // answer — its note offers one, and the cost cap's does not.
          return {
            kind: 'stopped',
            reason: round.refusal ?? 'The model declined to answer that.',
            refused: true,
          };
        }

        const { said, calls } = round;

        // A pause is the API asking to be called again with the same
        // conversation — but only once anything it *did* call has been
        // answered, so this is asked after the calls are in hand rather than
        // before, which used to skip straight past them and leave the turn
        // half-answered.
        if (calls.length === 0 && round.stop === 'pause') {
          continue;
        }

        // Prose and nothing else: the model has handed back. That is a
        // perfectly good end to a turn here, unlike in the mapping run where
        // it means the answer channel went unused — a question about the home
        // is answered by writing back and by nothing else.
        if (calls.length === 0) {
          // The words a silent submission was sent back for. The rule is
          // already saved; this is the sentence that goes above its card.
          return handOver(said) ?? { kind: 'said', text: said || 'Ready when you are.' };
        }

        const results: ChatToolResult[] = [];
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
          // A stop is honoured before every call, never inside one: the calls
          // after it in this response are answered as not done.
          if (abort.halted) {
            results.push(notDone(call.id));
            continue;
          }

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
              results.push({                id: call.id,
                text:
                  'Only one question can be outstanding at a time. Ask this one after the ' +
                  'first is answered.',
                isError: true,
              });
              continue;
            }
            if (handedBack?.kind === 'submitted' || silence.submission !== null) {
              // A rule was accepted earlier in this turn — in this same
              // response, or held from the one before for its line — and that
              // ends the turn: the person is handed a preview to look at. A
              // question asked beside it has nothing to attach to — the turn
              // is over before it could be answered — and the loop can only
              // hand one thing back, so leaving both set was how one of them
              // got silently dropped. Refused inside the turn, which the
              // model can act on, rather than after it, which nobody can.
              results.push({                id: call.id,
                text:
                  'A rule has already been submitted, which ends the turn. ' +
                  'Ask this once they have replied.',
                isError: true,
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
            // The rules held for their line count too: a reply is one page of
            // cards however many responses it took to write.
            const accepted = submitted.length + (silence.submission?.rules.length ?? 0);
            if (accepted >= AUTOMATION_MAX_RULES_PER_TURN) {
              // Bounded rather than refused outright: what is already accepted
              // is saved and shown, and the rest are asked for again once the
              // person has seen these — a reply that writes a page of rules
              // into somebody's home is a misread, not an answer.
              results.push({                id: call.id,
                text:
                  `That is more than ${AUTOMATION_MAX_RULES_PER_TURN} rules in one reply. The ` +
                  'ones already accepted are saved; tell them what those do and offer the rest ' +
                  'once they have replied.',
                isError: true,
              });
              continue;
            }
            const outcome = evaluateSubmission(call.input, tools);
            results.push({
              id: call.id,
              text: outcome.text,
              ...(outcome.accepted ? {} : { isError: true }),
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
            id: call.id,
            text: result.text,
            ...(result.isError ? { isError: true } : {}),
          });
        }

        if (abort.halted) {
          // A question asked in this response is not put to somebody who has
          // just said stop — retracted, so its call is answered with the rest
          // — while a rule accepted before the stop is kept, and saved.
          gate.retract(results, NOT_ASKED);
          transport.pushToolResults(results);
          return halted('', handedBack?.kind === 'submitted' ? handedBack : null);
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

        transport.pushToolResults(results);

        if (handedBack?.kind === 'submitted') {
          // After whatever is held, in the order they came — see `withHeld`.
          const delivered = withHeld(handedBack);

          // A rule accepted with nothing said about it: keep it, and give the
          // model one round to say what it did. Anything it says next comes
          // back through the no-calls branch above, carrying this submission
          // with it — and nothing is held twice, so the line is asked for once
          // however many rules arrive without one.
          if (silence.submission === null && delivered.text.trim().length === 0) {
            silence.submission = delivered;
            // Announced only when there is a round left to spend on it. On the
            // last there is not, and running out hands the rule over below.
            if (turn < AUTOMATION_MAX_TURNS) {
              context?.onStep?.('Writing it up for you', 'thinking');
            }
            continue;
          }
          return delivered;
        }

        // **Exactly one round, whatever that round turns out to be.** The rule
        // is already saved and the person is waiting in front of it, so a model
        // that answered the ask with more tool calls does not get to spend a
        // third round on a sentence: it is handed over with whatever it did
        // say, which is usually nothing and is no worse than before.
        const held = handOver(said);
        if (held !== null) return held;
      }

      // Out of rounds. A rule held for its line goes over without one, and
      // with nothing said under it: the agent did finish, so "without
      // finishing" is not true of this turn.
      return (
        handOver('') ?? {
          kind: 'stopped',
          reason:
            `The agent used all ${AUTOMATION_MAX_TURNS} steps without finishing. Try saying what ` +
            `you want more directly, or in smaller pieces.`,
        }
      );
    } catch (error) {
      // A provider that fails in the round for a held rule's line — or
      // anything else that throws there — is one more way out of that round,
      // and the rule was saved before it. With nothing held the throw is the
      // runtime's, as it always was: a note, and the conversation left open.
      const held = handOver('');
      if (held === null) throw error;
      log.warn(
        { err: error, model: modelId, provider },
        'automation agent: the line for a saved rule could not be written',
      );
      return held;
    } finally {
      abort.dispose();
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

  /**
   * Named rather than returned inline, because `send` and `answer` route into
   * each other and `this` inside an object literal typed by a *promised*
   * return is the union of the two — the price of the constructor becoming
   * async so it can load one vendor's transport and not the other.
   */
  const conversation: AutomationConversation = {
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
      // A message's photos travel with it, for this round only — see the
      // runtime's `rebase`.
      transport.pushUser(opened ? text : `${taskPrompt}\n\n${text}`.trim(), context?.images);
      opened = true;
      log.debug({ model: modelId, provider }, 'automation agent: user message');
      return pump(context);
    },

    async answer(text, context) {
      if (!gate.isOpen) return conversation.send(text, context);
      // The answer **and** every other call the same response made. One
      // message, every `tool_use` in the assistant turn accounted for — which
      // is the API's actual rule, and sending only the answer is what used to
      // refuse the conversation outright.
      gate.answer(text, context?.images);
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
