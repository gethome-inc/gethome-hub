import Anthropic from '@anthropic-ai/sdk';
import { AiUnavailableError, classifyApiError } from '../errors.js';
import { MAX_OUTPUT_TOKENS } from '../agent-core.js';
import { estimateCostUsd } from '../models.js';
import {
  refusalSentence,
  type ChatRound,
  type ChatStop,
  type ChatToolResult,
  type ChatTransport,
  type ChatTransportOptions,
} from './agent-loop.js';

/**
 * A conversation on Anthropic's Messages API.
 *
 * This is the loop both agents have always run, lifted behind `ChatTransport`
 * rather than rewritten — every rule in it was learned by breaking something
 * and none of them changed when a second vendor arrived.
 *
 * **Streamed rather than awaited**, and a mock laxer than the SDK is how that
 * went unnoticed once: `messages.create` refuses a non-streaming request whose
 * `max_tokens` could run past the API's ten-minute ceiling — the line is 21,333
 * and `MAX_OUTPUT_TOKENS` is 32,000 — so every run threw before it reached the
 * network, and because that refusal carries no HTTP status `classifyApiError`
 * read it as a transport failure: a run that could never work armed the backoff
 * gate and retried for ever. `messages.stream(…)` + `finalMessage()` returns the
 * same `Message`, so nothing else moves.
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

/** What one round of a conversation costs, added up as it goes. */
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

/** Anthropic's four stop reasons, in the four words a pump branches on. */
function stopOf(reason: string | null | undefined): ChatStop {
  switch (reason) {
    case 'refusal':
      return 'refusal';
    case 'pause_turn':
      return 'pause';
    case 'tool_use':
      return 'tools';
    default:
      return 'end';
  }
}

export function createAnthropicTransport(options: ChatTransportOptions): ChatTransport {
  const { secret, modelId, systemPrompt, tools, label, timeoutMs, effort, signal, log } = options;

  const client = new Anthropic({ apiKey: secret, maxRetries: 3 });
  const definitions: Anthropic.Tool[] = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.schema() as Anthropic.Tool['input_schema'],
  }));
  const usage = new RunUsage(modelId);
  const messages: Anthropic.MessageParam[] = [];

  return {
    provider: 'anthropic',
    modelId,

    pushUser(text) {
      messages.push({ role: 'user', content: text });
    },

    pushToolResults(results: ChatToolResult[]) {
      messages.push({
        role: 'user',
        content: results.map((result) => ({
          type: 'tool_result' as const,
          tool_use_id: result.id,
          content: result.text,
          ...(result.isError ? { is_error: true } : {}),
        })),
      });
    },

    settleDangling(exceptCallId) {
      const last = messages.at(-1);
      if (last === undefined || last.role !== 'assistant' || !Array.isArray(last.content)) return;

      const open = last.content
        .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
        .map((block) => block.id)
        // The question the person is being asked is outstanding on purpose, and
        // `QuestionGate.answer()` is what closes it.
        .filter((id) => id !== exceptCallId);
      if (open.length === 0) return;

      log.warn({ count: open.length }, `${label}: closing tool calls a failed round left open`);
      messages.push({
        role: 'user',
        content: open.map((id) => ({
          type: 'tool_result' as const,
          tool_use_id: id,
          content: 'That step did not finish. Try it again if you still need it.',
          is_error: true,
        })),
      });
    },

    async round(context): Promise<ChatRound> {
      let response: Anthropic.Message;
      try {
        const stream = client.messages.stream(
          {
            model: modelId,
            max_tokens: MAX_OUTPUT_TOKENS,
            system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
            cache_control: { type: 'ephemeral' },
            messages,
            tools: definitions,
            thinking: { type: 'adaptive', display: 'summarized' },
            output_config: { effort },
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
            `${label} stopped answering after ${timeoutMs / 1000}s`,
          );
        }
        throw classifyApiError(error) ?? error;
      }

      usage.add(response.usage);
      // Verbatim, thinking blocks included — the API requires it when a
      // thinking conversation continues.
      messages.push({ role: 'assistant', content: response.content });

      const said = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim();

      const calls = response.content
        .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
        .map((block) => ({ id: block.id, name: block.name, input: block.input }));

      /**
       * **Prose from a round that then calls a tool is not the answer, and it
       * was being thrown away.**
       *
       * A model narrates as it works — *"I'll set that up for you."* — and then
       * calls something. That sentence goes out over `onDelta` and is never
       * recorded: only the *last* round's text becomes the transcript row, so a
       * conversation read back next week shows the conclusion with nothing of
       * the commentary that led to it. Worse for the app drawing it live, which
       * accumulates deltas: two rounds of prose arrived run together with no
       * space between them, and were then replaced wholesale when the turn
       * landed.
       *
       * Reported by each transport rather than by a pump, because it is the
       * same fact on both vendors and this is where `said` and `calls` are in
       * hand at once. `calls.length > 0` is the whole of the test: prose with
       * nothing after it *is* the answer, and recording it would put the reply
       * in the transcript twice.
       */
      if (said.length > 0 && calls.length > 0) context?.onSaid?.(said);

      const stop = stopOf(response.stop_reason);
      return {
        said,
        calls,
        stop,
        ...(stop === 'refusal'
          ? { refusal: refusalSentence(response.stop_details?.category) }
          : {}),
      };
    },

    costUsd() {
      return usage.costUsd();
    },
  };
}
