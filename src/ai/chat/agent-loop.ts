import Anthropic from '@anthropic-ai/sdk';
import type { RefusalStopDetails } from '@anthropic-ai/sdk/resources/messages';
import type { Logger } from '../../logging.js';
import { AiUnavailableError, classifyApiError } from '../errors.js';
import { EFFORT, MAX_OUTPUT_TOKENS } from '../agent-core.js';
import { estimateCostUsd } from '../models.js';
import type { ChatTurnContext } from './chat-runtime.js';

/**
 * The parts of a conversational agent loop that are the *API's* shape rather
 * than any one agent's.
 *
 * Two agents run this loop now and they differ in what ends a turn — a rule
 * for one, a handoff for the other — which is a real difference and is why
 * each keeps its own `pump`. What they cannot be allowed to differ in is
 * everything here: the cache breakpoints, the thinking display, the abort that
 * has to become a sentence rather than a stack trace, and above all the rule
 * that no request may ever carry a `tool_use` with no `tool_result` after it.
 * Every one of those was learned by breaking something, and a second copy is a
 * second place to unlearn it.
 */

/** What one round of a conversation costs, added up as it goes. */
export class RunUsage {
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

export interface TurnRequest {
  client: Anthropic;
  modelId: string;
  systemPrompt: string;
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
  signal: AbortSignal;
  usage: RunUsage;
  /**
   * Only the halves of the stream this function actually drives.
   *
   * Narrowed rather than taking the whole context, because `onStep`'s `kind`
   * is each agent's own vocabulary — a callback taking `AutomationStepKind`
   * cannot stand in for one taking `string`, which is contravariance rather
   * than a nuisance: it would accept a word the caller cannot handle.
   * `onSaid` takes a plain string and so travels with the other two.
   */
  context: Pick<ChatTurnContext, 'onDelta' | 'onThinking' | 'onSaid'> | undefined;
  /** Named in the sentence a timeout produces, so it reads about this agent. */
  label: string;
  timeoutMs: number;
  /**
   * How hard the model works. `high` for a job cached against a device model
   * for ever; `medium` for a chat, which is many small rounds read the moment
   * they arrive. Not exposed to anybody: two settings for one decision is one
   * too many, so each agent states its own and nothing configures it.
   */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

/**
 * One request, streamed, with the assistant's reply pushed onto the history.
 *
 * **Streamed rather than awaited**, and a mock laxer than the SDK is how that
 * went unnoticed once: `messages.create` refuses a non-streaming request whose
 * `max_tokens` could run past the API's ten-minute ceiling, so every run threw
 * before it reached the network — and because that refusal carries no HTTP
 * status it was read as a transport failure and retried behind a backoff timer.
 *
 * **Two cache breakpoints**: the explicit one covers the tools and the system
 * prompt (tools sort ahead of system in the prefix), and the top-level field
 * puts a second on the growing conversation tail, which is the whole of the
 * round-by-round context and was being re-sent at full price every turn.
 *
 * `display: 'summarized'` on purpose: the default on these models is
 * `omitted`, which streams empty thinking blocks — right for a job nobody
 * watches, and a silent minute in a chat.
 *
 * `budget_tokens` is deliberately absent: it is a 400 on every model either
 * agent may run, and adaptive thinking is the only correct form.
 */
export async function streamTurn(request: TurnRequest): Promise<{
  response: Anthropic.Message;
  said: string;
  calls: Anthropic.ToolUseBlock[];
}> {
  const { client, modelId, systemPrompt, messages, tools, signal, usage, context } = request;
  let response: Anthropic.Message;
  try {
    const stream = client.messages.stream(
      {
        model: modelId,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        cache_control: { type: 'ephemeral' },
        messages,
        tools,
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: request.effort ?? EFFORT },
      },
      { signal },
    );
    if (context?.onDelta) stream.on('text', (delta) => context.onDelta?.(delta));
    // The reasoning, as it arrives. Only ever non-empty because the request
    // asks for `display: 'summarized'` — which is exactly the silence it
    // exists to fill.
    if (context?.onThinking) stream.on('thinking', (delta) => context.onThinking?.(delta));
    response = await stream.finalMessage();
  } catch (error) {
    if (signal.aborted) {
      throw new AiUnavailableError(
        'aborted',
        `${request.label} stopped answering after ${request.timeoutMs / 1000}s`,
      );
    }
    throw classifyApiError(error) ?? error;
  }

  usage.add(response.usage);
  // Verbatim, thinking blocks included — the API requires it when a thinking
  // conversation continues.
  messages.push({ role: 'assistant', content: response.content });

  const said = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();

  const calls = response.content.filter(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
  );

  /**
   * **Prose from a round that then calls a tool is not the answer, and it was
   * being thrown away.**
   *
   * A model narrates as it works — *"I'll set that up for you."* — and then
   * calls something. That sentence goes out over `onDelta` and is never
   * recorded: only the *last* round's text becomes the transcript row, so a
   * conversation read back next week shows the conclusion with nothing of the
   * commentary that led to it. Worse for the app drawing it live, which
   * accumulates deltas: two rounds of prose arrived run together with no space
   * between them, and were then replaced wholesale when the turn landed.
   *
   * Reported here rather than in either pump, because it is the same fact in
   * both and this is the one place they share. `calls.length > 0` is the whole
   * of the test: prose with nothing after it *is* the answer, and recording it
   * would put the reply in the transcript twice.
   */
  if (said.length > 0 && calls.length > 0) context?.onSaid?.(said);

  return { response, said, calls };
}

/**
 * Why a round was declined, in the words the person who asked it can use.
 *
 * **Branch on `stop_reason`, never on this.** `stop_details` is informational
 * and is `null` on plenty of real refusals, and its `explanation` is not
 * guaranteed present — so the caller decides *that* a round was refused from
 * the stop reason and asks this only for the sentence.
 *
 * The category is worth the read because the two that a *home* can plausibly
 * trip are the two a generic "try asking differently" is least useful for.
 * `reasoning_extraction` is somebody asking the assistant to show its
 * thinking, which is a thing to say plainly rather than a failure; `cyber`
 * fires on benign security work, which for this hub means questions about its
 * own network. Everything else keeps the generic sentence, including a `null`
 * category, which is a permanent valid state rather than a gap.
 */
export function refusalSentence(response: { stop_details?: RefusalStopDetails | null }): string {
  switch (response.stop_details?.category) {
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
 * Every `tool_use` in an assistant turn needs a `tool_result` in the very next
 * message — per *response*, not per call. So handing a question back while
 * abandoning the other calls in that response left the next request carrying a
 * half-answered turn, and the whole conversation was refused outright and for
 * ever with `400 tool_use ids were found without tool_result blocks`, reaching
 * the chat as a wall of JSON where the answer belonged.
 */
export class QuestionGate {
  /** The `ask_user` call the conversation is waiting on, if any. */
  private pending: string | null = null;
  /**
   * Results for the **other** tool calls in the same response as that
   * question, waiting to go back with the answer.
   */
  private stashed: Anthropic.ToolResultBlockParam[] = [];

  constructor(
    private readonly messages: Anthropic.MessageParam[],
    private readonly log: Logger,
    private readonly label: string,
  ) {}

  get isOpen(): boolean {
    return this.pending !== null;
  }

  open(callId: string): void {
    this.pending = callId;
  }

  /** Hold the rest of a response's results until the answer arrives. */
  stash(results: Anthropic.ToolResultBlockParam[]): void {
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
  retract(results: Anthropic.ToolResultBlockParam[], reason: string): void {
    if (this.pending === null) return;
    results.push({
      type: 'tool_result',
      tool_use_id: this.pending,
      content: reason,
      is_error: true,
    });
    this.pending = null;
  }

  /** Close the question with the person's answer and send the stash with it. */
  answer(text: string): void {
    if (this.pending === null) return;
    const results: Anthropic.ToolResultBlockParam[] = [
      ...this.stashed,
      { type: 'tool_result', tool_use_id: this.pending, content: text },
    ];
    this.stashed = [];
    this.pending = null;
    this.messages.push({ role: 'user', content: results });
  }

  /**
   * Answer anything the last assistant turn left open, so the next request is
   * a conversation the API will accept.
   *
   * It belongs **before the next user turn**, not beside the request: mid-loop
   * the last message is always the results of the round before, so a check
   * placed there can never fire. What it catches is every exit between the
   * assistant turn being pushed and its results being written — a refusal, a
   * `pause_turn`, and above all anything that throws, which the caller
   * swallows into a note while leaving the conversation open. The damage is
   * invisible until the next message is refused along with every one after it.
   *
   * The results say the step did not finish, which is true and is the only
   * thing that can be said. `is_error` so the model treats it as a step to
   * retry rather than as an outcome.
   */
  settleDangling(): void {
    const last = this.messages.at(-1);
    if (last === undefined || last.role !== 'assistant' || !Array.isArray(last.content)) return;

    const open = last.content
      .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
      .map((block) => block.id)
      // The question the person is being asked is outstanding on purpose, and
      // `answer()` is what closes it.
      .filter((id) => id !== this.pending);
    if (open.length === 0) return;

    this.log.warn({ count: open.length }, `${this.label}: closing tool calls a failed round left open`);
    this.messages.push({
      role: 'user',
      content: open.map((id) => ({
        type: 'tool_result' as const,
        tool_use_id: id,
        content: 'That step did not finish. Try it again if you still need it.',
        is_error: true,
      })),
    });
  }
}
