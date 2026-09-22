import type { Logger } from '../../logging.js';
import { AiUnavailableError, classifyApiError } from '../errors.js';
import { MAX_OUTPUT_TOKENS } from '../agent-core.js';
import { openAiUrl, routeName, wireModelId, type AiRoute } from '../gateway.js';
import { estimateCostUsd } from '../models.js';
import {
  refusalSentence,
  type ChatRound,
  type ChatToolCall,
  type ChatToolResult,
  type ChatTransport,
  type ChatTransportOptions,
} from './agent-loop.js';

/**
 * A conversation on OpenAI's Responses API.
 *
 * **Plain `fetch` and no SDK**, for the reason `openai-agent.ts` gives about
 * the mapper: the hub ships `dist/` plus its production `node_modules` to a
 * Raspberry Pi, everything this needs is one POST and a stream of events back,
 * and every vulnerable package this repository has shipped arrived
 * transitively. One vendor SDK is a cost already paid; a second is a second
 * dependency subtree on a board with 415 MB of RAM.
 *
 * **Streamed, where the mapper's own OpenAI loop is not**, and that is the one
 * real difference between the two. A mapping run is a job nobody watches, so it
 * can afford to await a whole response; a chat is somebody sitting in front of
 * a page, and the four socket phases exist precisely so they are not looking at
 * three animated dots. `response.output_text.delta` is the reply and
 * `response.reasoning_summary_text.delta` is the thinking — the latter only
 * arrives because the request asks for `summary: 'auto'`, which is this
 * vendor's spelling of the `display: 'summarized'` lesson: the default streams
 * nothing and reads as a silent minute.
 *
 * **Stateless.** `store: false`, so OpenAI keeps no copy of the conversation;
 * reasoning items then come back carrying `encrypted_content` and are echoed
 * verbatim on the next round, which is what keeps the model's own chain of
 * thought across a tool call without anything being retained server-side.
 */

interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
}

/**
 * Items are echoed back verbatim, so this understands as little of them as it
 * can: enough to spot a tool call, prose and a refusal, and nothing more. An
 * item type this build has never heard of travels through untouched rather than
 * being dropped, which is what stops a new kind of reasoning block breaking the
 * conversation.
 */
interface ResponseItem {
  type: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: Array<{ type: string; refusal?: string; text?: string }>;
  [key: string]: unknown;
}

interface ResponseBody {
  status?: string;
  error?: { code?: string; message?: string };
  incomplete_details?: { reason?: string };
  output?: ResponseItem[];
  usage?: ResponsesUsage;
}

/** Running total across every round of one conversation. */
class RunUsage {
  private input = 0;
  private output = 0;
  private cacheRead = 0;
  private cacheWrite = 0;

  constructor(private readonly model: string) {}

  add(usage: ResponsesUsage | undefined): void {
    if (!usage) return;
    // OpenAI reports cached input and cache writes inside the input count, so
    // each share is subtracted before it is billed at its own rate. Otherwise a
    // prompt cache write would be charged once as normal input and again at its
    // documented 1.25x cache-write rate.
    const cached = usage.input_tokens_details?.cached_tokens ?? 0;
    const cacheWrite = usage.input_tokens_details?.cache_write_tokens ?? 0;
    this.input += Math.max((usage.input_tokens ?? 0) - cached - cacheWrite, 0);
    this.cacheRead += cached;
    this.cacheWrite += cacheWrite;
    this.output += usage.output_tokens ?? 0;
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

export function createOpenAiTransport(options: ChatTransportOptions): ChatTransport {
  const { secret, modelId, systemPrompt, tools, label, timeoutMs, effort, signal, log } = options;
  const route = options.route ?? 'direct';

  const definitions = tools.map((tool) => ({
    type: 'function' as const,
    name: tool.name,
    description: tool.description,
    parameters: tool.schema(),
    // The agents' schemas carry numeric and string constraints strict mode
    // rejects, and a call the model got slightly wrong is a `tool_result` it
    // can read rather than a refused request — which is the recovery path every
    // one of these tools already has.
    strict: false,
  }));
  const usage = new RunUsage(modelId);
  /** The conversation, in the vendor's own shape. */
  const input: unknown[] = [];

  return {
    provider: 'openai',
    modelId,

    pushUser(text) {
      input.push({ role: 'user', content: text });
    },

    pushToolResults(results: ChatToolResult[]) {
      for (const result of results) {
        input.push({
          type: 'function_call_output',
          call_id: result.id,
          // There is no `is_error` here, so the sentence has to carry it. Every
          // one of these is already written as a sentence the model reads, so
          // marking a failure in words costs nothing and loses nothing.
          output: result.isError ? `That failed. ${result.text}` : result.text,
        });
      }
    },

    settleDangling(exceptCallId) {
      // A flat item array rather than Anthropic's last-message content, so the
      // question is asked of the whole conversation: which calls have no output
      // after them. That is the same rule and a simpler read of it.
      const answered = new Set(
        input
          .filter(
            (item): item is { type: string; call_id?: string } =>
              typeof item === 'object' && item !== null && 'type' in item,
          )
          .filter((item) => item.type === 'function_call_output')
          .map((item) => item.call_id)
          .filter((id): id is string => typeof id === 'string'),
      );
      const open = input
        .filter(
          (item): item is { type: string; call_id?: string } =>
            typeof item === 'object' && item !== null && 'type' in item,
        )
        .filter((item) => item.type === 'function_call')
        .map((item) => item.call_id)
        .filter((id): id is string => typeof id === 'string')
        // The question the person is being asked is outstanding on purpose.
        .filter((id) => id !== exceptCallId && !answered.has(id));
      if (open.length === 0) return;

      log.warn({ count: open.length }, `${label}: closing tool calls a failed round left open`);
      for (const id of open) {
        input.push({
          type: 'function_call_output',
          call_id: id,
          output: 'That step did not finish. Try it again if you still need it.',
        });
      }
    },

    async round(context): Promise<ChatRound> {
      let body: ResponseBody;
      try {
        body = await streamResponse({
          secret,
          route,
          modelId,
          systemPrompt,
          input,
          tools: definitions,
          // The round's own effort where it asked for one — a spoken turn
          // does — and the conversation's otherwise.
          effort: context?.effort ?? effort,
          signal,
          label,
          log,
          onDelta: context?.onDelta,
          onThinking: context?.onThinking,
        });
      } catch (error) {
        if (signal.aborted) {
          throw new AiUnavailableError(
            'aborted',
            `${label} stopped answering after ${timeoutMs / 1000}s`,
          );
        }
        throw error;
      }

      usage.add(body.usage);
      const output = body.output ?? [];
      // Verbatim, reasoning items included: without them the model loses its
      // own chain of thought across the tool call it just made.
      input.push(...output);

      const refusal = refusalIn(output);
      const said = output
        .filter((item) => item.type === 'message')
        .flatMap((item) => item.content ?? [])
        .filter((part) => part.type === 'output_text')
        .map((part) => part.text)
        .filter((text): text is string => typeof text === 'string')
        .join('\n')
        .trim();

      const calls: ChatToolCall[] = output
        .filter((item) => item.type === 'function_call')
        .map((item) => ({
          id: item.call_id ?? '',
          name: item.name ?? '',
          input: parseArguments(item.arguments),
        }))
        .filter((call) => call.id.length > 0 && call.name.length > 0);

      // See the same note in `anthropic-transport.ts`: prose from a round that
      // then calls a tool is not the answer, and only the transport has `said`
      // and `calls` in hand at once.
      if (said.length > 0 && calls.length > 0) context?.onSaid?.(said);

      if (refusal !== null) {
        // OpenAI reports no category, so this always takes the generic
        // sentence — which is the honest outcome rather than a gap, and is
        // exactly why `refusalSentence` treats an absent category as valid.
        return { said, calls, stop: 'refusal', refusal: refusal || refusalSentence(null) };
      }
      return { said, calls, stop: calls.length > 0 ? 'tools' : 'end' };
    },

    costUsd() {
      return usage.costUsd();
    },
  };
}

/**
 * One streamed round, reassembled into the response body the caller reads.
 *
 * The deltas are the live experience and `response.completed` is the record:
 * both are needed, which is why this streams *and* returns a whole body. A
 * stream that ends on `response.failed` is not a normal answer to continue
 * from, so it throws rather than being read as prose — and so is an
 * `response.incomplete` for any reason **but** the output ceiling, which is
 * read as an answer that was cut short. See the case below for why that one is
 * not a failure.
 */
async function streamResponse(request: {
  secret: string;
  /** Which address the round goes to; the stream answers alike on both. */
  route: AiRoute;
  /** The canonical id — the route's spelling of it is made here, on the wire. */
  modelId: string;
  systemPrompt: string;
  input: unknown[];
  tools: unknown[];
  effort: string;
  signal: AbortSignal;
  /** Named in the one line a cut-short reply writes, so it reads about this
   *  agent rather than about "the transport". */
  label: string;
  log: Logger;
  onDelta: ((delta: string) => void) | undefined;
  onThinking: ((delta: string) => void) | undefined;
}): Promise<ResponseBody> {
  /** Who a refusal or a dead line is about, in the sentence that says so. */
  const answering = routeName(request.route, 'OpenAI');
  let response: Response;
  try {
    response = await fetch(openAiUrl(request.route, '/responses'), {
      method: 'POST',
      headers: { authorization: `Bearer ${request.secret}`, 'content-type': 'application/json' },
      signal: request.signal,
      body: JSON.stringify({
        model: wireModelId('openai', request.route, request.modelId),
        instructions: request.systemPrompt,
        input: request.input,
        tools: request.tools,
        stream: true,
        // Required for a stateless multi-turn reasoning run: without this the
        // API may omit the opaque reasoning content that must be replayed with
        // the next round.
        include: ['reasoning.encrypted_content'],
        // `summary: 'auto'` is what makes the thinking stream at all — this
        // vendor's spelling of `display: 'summarized'`, and the same reason:
        // the silence it fills is the longest part of every round.
        reasoning: { effort: request.effort, summary: 'auto' },
        max_output_tokens: MAX_OUTPUT_TOKENS,
        store: false,
      }),
    });
  } catch (error) {
    throw new AiUnavailableError(
      'network',
      `could not reach ${answering}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!response.ok) {
    const text = await response.text();
    const message = messageIn(text) ?? `${answering} answered ${response.status}.`;
    // The classifier branches on HTTP status rather than on any vendor's error
    // vocabulary, which is exactly why it is structural.
    throw (
      classifyApiError({ status: response.status, headers: response.headers, message }) ??
      new Error(message)
    );
  }
  if (!response.body) throw new Error(`${answering} answered with no body to stream`);

  let completed: ResponseBody | null = null;
  let failure: string | null = null;

  for await (const event of serverSentEvents(response.body)) {
    switch (event.type) {
      case 'response.output_text.delta': {
        const delta = event.data['delta'];
        if (typeof delta === 'string') request.onDelta?.(delta);
        break;
      }
      case 'response.reasoning_summary_text.delta': {
        const delta = event.data['delta'];
        if (typeof delta === 'string') request.onThinking?.(delta);
        break;
      }
      case 'response.completed': {
        const body = event.data['response'];
        if (typeof body === 'object' && body !== null) completed = body as ResponseBody;
        break;
      }
      case 'response.incomplete': {
        const body = event.data['response'] as ResponseBody | undefined;
        const reason = body?.incomplete_details?.reason;
        /**
         * **Running out of room is an answer, not a failure**, and the other
         * vendor has always said so: Anthropic's `max_tokens` stop reason
         * falls through `stopOf` to `end`, so a long reply arrives truncated
         * and the person reads what there was. Throwing here made the same
         * conversation behave differently on one provider — and worse than
         * merely differently, since the deltas have *already* been streamed to
         * the page: the answer was on screen and then replaced by an error
         * about it.
         *
         * So a response cut short by the output ceiling is read exactly as a
         * completed one — the body carries the output and the usage either way
         * — and every other incomplete reason (a content filter, say) is still
         * a failure, because there the output is not an answer at all.
         */
        if (reason === 'max_output_tokens' && body !== undefined) {
          request.log.warn(`${request.label}: the model ran out of room, so its reply is cut short`);
          completed = body;
          break;
        }
        failure = body?.error?.message ?? reason ?? 'incomplete';
        break;
      }
      case 'response.failed': {
        const body = event.data['response'] as ResponseBody | undefined;
        failure = body?.error?.message ?? body?.incomplete_details?.reason ?? 'failed';
        break;
      }
      case 'error': {
        const message = event.data['message'];
        failure = typeof message === 'string' ? message : 'the stream reported an error';
        break;
      }
      default:
        break;
    }
  }

  if (failure !== null) throw new Error(`${answering} response ${failure}`);
  if (completed === null) throw new Error(`${answering} stream ended without completing the response`);
  return completed;
}

/**
 * Server-sent events, as the Responses stream sends them.
 *
 * Deliberately small: the `event:` line names the type and the `data:` line is
 * one JSON object, so nothing here needs to understand multi-line data or
 * retry hints. A frame whose data will not parse is skipped rather than
 * thrown — the completion event is what the caller needs, and one malformed
 * delta must not lose the answer behind it.
 */
async function* serverSentEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ type: string; data: Record<string, unknown> }> {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let split = buffer.indexOf('\n\n');
    while (split !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const parsed = parseFrame(frame);
      if (parsed) yield parsed;
      split = buffer.indexOf('\n\n');
    }
  }
  const last = parseFrame(buffer);
  if (last) yield last;
}

function parseFrame(frame: string): { type: string; data: Record<string, unknown> } | null {
  let type = '';
  const data: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) type = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trim());
  }
  if (type.length === 0 || data.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(data.join('\n'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    return { type, data: parsed as Record<string, unknown> };
  } catch {
    return null;
  }
}

function refusalIn(output: ResponseItem[]): string | null {
  for (const item of output) {
    for (const part of item.content ?? []) {
      if (part.type === 'refusal' && typeof part.refusal === 'string') return part.refusal;
    }
  }
  return null;
}

/**
 * Tool arguments arrive as a JSON *string*. Unparseable is not a crash — it is
 * a call each agent's own schema refuses and the model is asked to fix, which
 * is the same path a structurally wrong input takes.
 */
function parseArguments(raw: string | undefined): unknown {
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** OpenAI's own sentence, which is always better than one written here. */
function messageIn(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    const message = parsed.error?.message;
    return typeof message === 'string' && message.length > 0 ? message.slice(0, 400) : null;
  } catch {
    return null;
  }
}
