import Anthropic from '@anthropic-ai/sdk';
import { AiUnavailableError, classifyApiError } from '../errors.js';
import { MAX_OUTPUT_TOKENS } from '../agent-core.js';
import { estimateCostUsd } from '../models.js';
import {
  haltedBy,
  refusalSentence,
  tokensIn,
  type ChatRound,
  type ChatStop,
  type ChatToolResult,
  type ChatTransport,
  type ChatTransportOptions,
} from './agent-loop.js';
import type { ChatImage } from './chat-runtime.js';

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

/**
 * What a conversation costs, added up as it goes — round by round, because a
 * long prompt is billed at dearer rates for the whole of that one request
 * (`ModelPricing.longPrompt`), and the sum of ten rounds is not a prompt
 * anybody sent.
 */
class RunUsage {
  private spent = 0;

  constructor(private readonly model: string) {}

  add(usage: Anthropic.Usage | undefined): void {
    if (!usage) return;
    this.spent += estimateCostUsd(this.model, {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read_input_tokens: usage.cache_read_input_tokens,
      cache_creation_input_tokens: usage.cache_creation_input_tokens,
    });
  }

  /**
   * A round the person stopped part-way, which no usage block will ever arrive
   * for.
   *
   * The prompt is exact — the API counts it, cache reads and writes included,
   * in the `message_start` that opens the stream, and the SDK keeps that
   * snapshot through the abort — and the reply is `tokensIn` of what streamed.
   * Stopped before the stream opened, there is no snapshot and nothing is
   * added: whether a request cancelled before the model began was billed at
   * all is not something this side can know.
   */
  addHalted(started: Anthropic.Usage | undefined, streamedTokens: number): void {
    if (!started) return;
    this.spent += estimateCostUsd(this.model, {
      input_tokens: started.input_tokens,
      output_tokens: Math.max(started.output_tokens, streamedTokens),
      cache_read_input_tokens: started.cache_read_input_tokens,
      cache_creation_input_tokens: started.cache_creation_input_tokens,
    });
  }

  costUsd(): number {
    return this.spent;
  }
}

/**
 * One photo as this vendor takes it: base64 inline, with its media type.
 *
 * The media type is the route's own short list (`CHAT_IMAGE_MEDIA_TYPES`), all
 * of which this API accepts, so the cast is a statement of that rather than a
 * hope.
 */
function imageBlock(image: ChatImage): Anthropic.ImageBlockParam {
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: image.mediaType as Anthropic.Base64ImageSource['media_type'],
      data: image.data,
    },
  };
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
  const { secret, modelId, systemPrompt, tools, label, timeoutMs, effort, log } = options;

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

    pushUser(text, images) {
      // A plain string when there is nothing but words, so every conversation
      // that never sends a photo sends exactly the bytes it always did.
      if (images === undefined || images.length === 0) {
        messages.push({ role: 'user', content: text });
        return;
      }
      // The pictures first and the words after them, which is the order the
      // vendor's own guidance gives — and no text block at all for a message
      // that is only a photo, since an empty one is refused.
      messages.push({
        role: 'user',
        content: [
          ...images.map(imageBlock),
          ...(text.trim().length > 0 ? [{ type: 'text' as const, text }] : []),
        ],
      });
    },

    pushToolResults(results: ChatToolResult[], images) {
      messages.push({
        role: 'user',
        content: [
          ...results.map((result) => ({
            type: 'tool_result' as const,
            tool_use_id: result.id,
            content: result.text,
            ...(result.isError ? { is_error: true } : {}),
          })),
          // After every result, never before: a user turn that answers tool
          // calls has to open with their results, and anything else it
          // carries — here, the photos an answer came with — follows them.
          ...(images ?? []).map(imageBlock),
        ],
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

    async round(context, signal): Promise<ChatRound> {
      let response: Anthropic.Message;
      /** The reply as it stood when a stop landed — the SDK keeps the snapshot
       *  `message_start` opened, usage and all, through the abort. */
      let current: () => Anthropic.Message | undefined = () => undefined;
      /** What reached the page, for the answer a stop leaves behind. */
      let streamed = '';
      /** How much reasoning was shown, for what a stopped round is priced at. */
      let thought = 0;
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
            // The round's own effort where it asked for one — a spoken turn
            // does — and the conversation's otherwise.
            output_config: { effort: context?.effort ?? effort },
          },
          { signal },
        );
        current = () => stream.currentMessage;
        // Kept as well as passed on, whoever is listening: the words are what
        // a stop leaves behind as the answer.
        stream.on('text', (delta) => {
          streamed += delta;
          context?.onDelta?.(delta);
        });
        // The reasoning, as it arrives. Only ever non-empty because the request
        // asks for `display: 'summarized'` — which is exactly the silence it
        // exists to fill.
        stream.on('thinking', (delta) => {
          thought += delta.length;
          context?.onThinking?.(delta);
        });
        response = await stream.finalMessage();
      } catch (error) {
        if (haltedBy(signal)) {
          usage.addHalted(current()?.usage, tokensIn(streamed.length + thought));
          const said = streamed.trim();
          // **Only the words go onto the history.** A thinking block cut off
          // has no signature and a tool call cut off has half its input, and
          // either is a conversation the API refuses; prose is what they read,
          // so it is what the model is shown it said. Nothing at all, when the
          // stop came before a word — the next user turn follows the last one,
          // which the API reads as one turn, as `settleDangling`'s does.
          if (said.length > 0) {
            messages.push({ role: 'assistant', content: [{ type: 'text', text: said }] });
          }
          return { said, calls: [], stop: 'halted' };
        }
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
