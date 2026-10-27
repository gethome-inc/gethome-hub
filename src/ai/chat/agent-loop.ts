import type { AiProvider } from '../../core/settings.js';
import type { Logger } from '../../logging.js';
import type { ChatEffort, ChatImage, ChatTurnContext } from './chat-runtime.js';

/**
 * The parts of a conversational agent loop that are neither a vendor's API nor
 * any one agent's.
 *
 * Two agents run this loop and they differ in what ends a turn — a rule for
 * one, a handoff for the other — which is a real difference and is why each
 * keeps its own `pump`. What they cannot be allowed to differ in is everything
 * here: the shape of a round, and above all the rule that no request may ever
 * carry a tool call with no result after it. Every one of those was learned by
 * breaking something, and a second copy is a second place to unlearn it.
 *
 * **This file imports no SDK, and that is load-bearing rather than tidy.** It
 * is `agent-core.ts`'s rule one subsystem over: a home configured with only an
 * OpenAI key must never load `@anthropic-ai/sdk` to satisfy an import chain, so
 * the vendor loops sit behind `ChatTransport` and `createChatTransport` imports
 * whichever half it needs. Before this split, `agent-loop.ts` typed every
 * signature against `Anthropic.*` and both agents imported the SDK at the top
 * of the file — which made "the assistant runs on Anthropic" a fact about the
 * *module graph* rather than about a setting anybody could change.
 */

/** A tool the model asked for. `input` is unparsed: each agent's own schemas
 *  validate it, and a call the model got wrong is a `tool_result` it can read
 *  rather than an exception. */
export interface ChatToolCall {
  id: string;
  name: string;
  input: unknown;
}

/** What a tool answered, on its way back into the conversation. */
export interface ChatToolResult {
  id: string;
  text: string;
  /** The model treats it as a step to retry rather than as an outcome. */
  isError?: boolean;
}

/**
 * Why a round stopped, in the five words a pump branches on.
 *
 * Deliberately not each vendor's own vocabulary. Anthropic says
 * `end_turn`/`tool_use`/`refusal`/`pause_turn`; OpenAI answers a `status` with
 * a refusal content block inside the output. Both collapse to the same four
 * questions — did it finish, does it want tools, did it decline, should we ask
 * again — and a pump that branched on the raw value would be a pump per vendor.
 *
 * The fifth is neither vendor's: **`halted`** is the person stopping the round
 * part-way (`StopRequested`). It is a round rather than a throw because what
 * reached the page before the stop is the answer they will read, and a throw
 * would lose it on the way to the note saying something failed.
 */
export type ChatStop = 'end' | 'tools' | 'refusal' | 'pause' | 'halted';

/** One streamed round of a conversation. */
export interface ChatRound {
  /** Everything the model said this round, joined. */
  said: string;
  calls: ChatToolCall[];
  stop: ChatStop;
  /**
   * Why it declined, when it did.
   *
   * Only ever read for `stop: 'refusal'`, and worded by the transport — a
   * category is a vendor's vocabulary and the sentence a person reads is not.
   */
  refusal?: string;
}

/**
 * One vendor's API, as a conversation this repository can drive.
 *
 * The transport owns the message history, because its *shape* is the vendor's:
 * Anthropic wants content blocks with thinking replayed verbatim, OpenAI wants
 * an item array with encrypted reasoning echoed back. Neither is something a
 * pump should know about, and a neutral history converted at the boundary would
 * be a third representation to keep correct.
 */
export interface ChatTransport {
  readonly provider: AiProvider;
  readonly modelId: string;

  /**
   * The person's message (or a revival's priming) as the next user turn.
   *
   * **Photos ride in the same turn, and only when there are any**: with none,
   * the request is byte-for-byte what it always was, which keeps the cached
   * prefix of every conversation that never sends one exactly as warm. A
   * message that is only a photo sends no empty text beside it — Anthropic
   * refuses an empty text block, and a picture is a complete user turn on
   * both vendors.
   */
  pushUser(text: string, images?: readonly ChatImage[]): void;

  /**
   * Results for the calls in the last round, as one user turn — and, when the
   * answer that closed a question came with photos, those photos after them,
   * in the same turn where the vendor allows it and as the very next one where
   * it does not.
   */
  pushToolResults(results: ChatToolResult[], images?: readonly ChatImage[]): void;

  /**
   * One streamed round, with the model's reply pushed onto the history.
   *
   * Narrowed to the halves of the context it actually drives, rather than
   * taking the whole thing: `onStep`'s `kind` is each agent's own vocabulary,
   * and a callback taking one agent's step kinds cannot stand in for one taking
   * `string` — contravariance rather than a nuisance, since it would accept a
   * word the caller cannot handle.
   *
   * **`signal` is the round's own** — a `TurnAbort`'s, which is the watchdog
   * and the person's stop behind one signal. Aborted by the watchdog it is the
   * sentence it always was, thrown; aborted by a stop it is a `halted` round
   * carrying what had streamed, with only the words of it — never a thinking
   * block cut off before its signature or a tool call cut off halfway through
   * its input — pushed onto the history, and what the round had cost by then
   * added to `costUsd()`.
   */
  round(
    context:
      | Pick<ChatTurnContext, 'onDelta' | 'onThinking' | 'onSaid' | 'onHandOver' | 'effort'>
      | undefined,
    signal: AbortSignal,
  ): Promise<ChatRound>;

  /**
   * Close anything the last assistant turn left open, except the one call id
   * an outstanding question owns.
   *
   * The vendors phrase it differently and mean the same thing, which is why
   * this is on the transport rather than in `QuestionGate` — see
   * `settleDangling` below for *when* it is called and why that matters.
   */
  settleDangling(exceptCallId: string | null): void;

  costUsd(): number;
}

/** What every transport needs to be built. */
export interface ChatTransportOptions {
  secret: string;
  modelId: string;
  systemPrompt: string;
  /** The first user message: this home, and what was asked. Pushed by the
   *  agent ahead of the first real message rather than sent as a system turn —
   *  see `assistant-agent.ts` on why there are no mid-conversation system
   *  messages. */
  tools: readonly { name: string; description: string; schema: () => Record<string, unknown> }[];
  /** Named in the sentence a timeout produces, so it reads about this agent. */
  label: string;
  timeoutMs: number;
  /**
   * How hard the model works, for every round this conversation runs.
   *
   * `high` for a job cached against a device model for ever; `medium` for a
   * chat, which is many small rounds read the moment they arrive. No setting
   * configures it — each agent states its own. **One round may ask for
   * something else** — `ChatTurnContext.effort`, which is how a spoken round
   * gets answered at the speed a person standing in a room expects, and how a
   * typed message that asked for its own effort (`ChatTurnRequest.effort`,
   * from the hub's three words) gets that for its one round.
   */
  effort: ChatEffort;
  log: Logger;
}

/**
 * What a turn's signal is aborted with when the person asked for the stop —
 * the one thing that tells it from the watchdog, which aborts with nothing.
 */
export class StopRequested extends Error {
  constructor() {
    super('they stopped this answer');
    this.name = 'StopRequested';
  }
}

/** Whether a signal was aborted by the person's stop, never by the watchdog. */
export function haltedBy(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason instanceof StopRequested;
}

/**
 * Four characters to a token: the estimate a round stopped part-way is priced
 * at, for the share of it no vendor had counted yet.
 *
 * Neither vendor reports usage for a reply it never finished, while both bill
 * for what was generated before the connection closed — so what streamed is
 * measured, and the reasoning only as its summary, which is shorter than what
 * the model actually thought. An estimate on the low side, which is the side
 * to be wrong on in a ledger somebody reads as what they paid.
 */
export function tokensIn(characters: number): number {
  return Math.ceil(characters / 4);
}

/**
 * One turn's abort: the watchdog and the person's stop, behind one signal.
 *
 * **Per turn, never per conversation**, and the conversation-wide controller
 * this replaced was a bug of its own: an `AbortController` aborts once, so the
 * first turn to outlive its watchdog left the conversation's signal aborted for
 * good, and every round after it was refused the instant it was sent — a chat
 * that had timed out once answered "stopped answering after 120s" to every
 * later message, a millisecond after it was sent, until the session was
 * dropped two hours later.
 *
 * The person's stop is the turn's `ChatTurnContext.signal`, and it is listened
 * to rather than handed to the round directly, so that the round's own signal
 * says *which* of the two fired (`haltedBy`) — a stop ends the turn with what
 * it had, where the watchdog is a failure with a sentence.
 */
export class TurnAbort {
  private readonly controller = new AbortController();
  private readonly watchdog: ReturnType<typeof setTimeout>;
  private readonly stop: AbortSignal | undefined;
  private readonly onStop = (): void => this.controller.abort(new StopRequested());

  constructor(stop: AbortSignal | undefined, timeoutMs: number) {
    this.stop = stop;
    this.watchdog = setTimeout(() => this.controller.abort(), timeoutMs);
    this.watchdog.unref?.();
    if (stop?.aborted === true) this.onStop();
    else stop?.addEventListener('abort', this.onStop, { once: true });
  }

  /** What each round of this turn is sent with. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** The person asked for this turn to stop — as against the watchdog firing,
   *  or nothing at all. */
  get halted(): boolean {
    return haltedBy(this.controller.signal);
  }

  /** Disarm the watchdog and stop listening, however the turn ended. */
  dispose(): void {
    clearTimeout(this.watchdog);
    this.stop?.removeEventListener('abort', this.onStop);
  }
}

/**
 * The result a tool call gets when the person stopped the turn before it ran.
 *
 * Every call in a response still needs a result in the very next message, so
 * the ones a stop skipped are answered rather than abandoned — in words the
 * model reads on the next turn as what was not done.
 */
export function notDone(id: string): ChatToolResult {
  return { id, text: 'Not done: they stopped this answer before it ran.', isError: true };
}

/** What a question gets in its place when a stop arrives before it is asked. */
export const NOT_ASKED = 'Not asked: they stopped this answer before it reached them.';

/**
 * Why a round was declined, in the words the person who asked it can use.
 *
 * **Branch on the stop, never on this.** A category is informational, is
 * absent on plenty of real refusals, and only one vendor reports one at all —
 * so the caller decides *that* a round was refused from `ChatRound.stop` and
 * asks this only for the sentence.
 *
 * The category is worth the read because the two that a *home* can plausibly
 * trip are the two a generic "try asking differently" is least useful for.
 * `reasoning_extraction` is somebody asking the assistant to show its
 * thinking, which is a thing to say plainly rather than a failure; `cyber`
 * fires on benign security work, which for this hub means questions about its
 * own network. Everything else keeps the generic sentence, an absent category
 * included — that is a permanent valid state rather than a gap.
 */
export function refusalSentence(category: string | null | undefined): string {
  switch (category) {
    case 'reasoning_extraction':
      return 'I can’t show you my own reasoning, but ask me the question itself and I’ll answer it.';
    case 'cyber':
      return 'That one is close enough to security work that the model declined it. Asking about '
        + 'your own devices and what they do is fine — try it in those terms.';
    default:
      return 'The model declined to answer that. Try asking for it differently.';
  }
}

/**
 * The question a conversation is waiting on, and the results that have to
 * travel with its answer.
 *
 * **Two bugs live here and both were the same API rule read too narrowly.**
 * Every tool call in an assistant turn needs a result in the very next message
 * — per *response*, not per call. So handing a question back while abandoning
 * the other calls in that response left the next request carrying a
 * half-answered turn, and the whole conversation was refused outright and for
 * ever with `400 tool_use ids were found without tool_result blocks`, reaching
 * the chat as a wall of JSON where the answer belonged.
 *
 * It is the transport's history it writes into, which is why it holds one
 * rather than an array: both vendors enforce the same rule and neither would
 * let the gate hold a neutral copy and hope.
 */
export class QuestionGate {
  /** The `ask_user` call the conversation is waiting on, if any. */
  private pending: string | null = null;
  /**
   * Results for the **other** tool calls in the same response as that
   * question, waiting to go back with the answer.
   */
  private stashed: ChatToolResult[] = [];

  constructor(private readonly transport: ChatTransport) {}

  get isOpen(): boolean {
    return this.pending !== null;
  }

  open(callId: string): void {
    this.pending = callId;
  }

  /** Hold the rest of a response's results until the answer arrives. */
  stash(results: ChatToolResult[]): void {
    this.stashed = results;
  }

  /**
   * Retract an outstanding question because something else in the same
   * response ended the turn.
   *
   * The alternative orders are both worse: leaving it open orphans a call id
   * and refuses every later request, and returning the question instead means
   * the model was told its delivery was accepted and it never happened.
   */
  retract(results: ChatToolResult[], reason: string): void {
    if (this.pending === null) return;
    results.push({ id: this.pending, text: reason, isError: true });
    this.pending = null;
  }

  /**
   * Close the question with the person's answer and send the stash with it.
   *
   * An answer can be a photo and nothing else — "which one?" answered with a
   * picture of it — and a tool result has to *say* something, so a wordless
   * one says that a photo follows rather than going out empty.
   */
  answer(text: string, images?: readonly ChatImage[]): void {
    if (this.pending === null) return;
    const said =
      text.trim().length === 0 && images !== undefined && images.length > 0
        ? images.length === 1
          ? '(They answered with the photo below.)'
          : '(They answered with the photos below.)'
        : text;
    const results: ChatToolResult[] = [...this.stashed, { id: this.pending, text: said }];
    this.stashed = [];
    this.pending = null;
    if (images !== undefined && images.length > 0) {
      this.transport.pushToolResults(results, images);
    } else {
      this.transport.pushToolResults(results);
    }
  }

  /**
   * Answer anything the last assistant turn left open, so the next request is
   * a conversation the API will accept.
   *
   * It belongs **before the next user turn**, not beside the request, which is
   * where it can never fire: mid-loop the last message is always the results of
   * the round before. What it catches is every exit between the assistant turn
   * being pushed and its results being written — a refusal, a pause, and above
   * all anything that throws, which the caller swallows into a note while
   * leaving the conversation open. The damage is invisible until the next
   * message is refused along with every one after it.
   */
  settleDangling(): void {
    this.transport.settleDangling(this.pending);
  }
}
