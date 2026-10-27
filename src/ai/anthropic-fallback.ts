import type Anthropic from '@anthropic-ai/sdk';
import { readableFailure } from './errors.js';
import { estimateCostUsd, modelLabel } from './models.js';

/**
 * A request Claude declines is asked again of another Claude, inside the same
 * call — and everything a reply that was answered that way needs read
 * differently.
 *
 * **Why every Claude request here opts in.** The models a home runs on carry
 * safety classifiers that can decline a request outright (`stop_reason:
 * 'refusal'`), and benign work trips them: the `cyber` one fires on security
 * questions, and a home is full of locks, alarms, cameras and its own network.
 * Without a fallback that is a refusal somebody reads in their kitchen. With
 * `fallbacks: 'default'` the API runs the declined request again on the model
 * Anthropic recommends for that kind of refusal (Opus 4.8 for `cyber`), in the
 * same request, and returns that model's answer instead — nothing to retry
 * here, no second key, and the home's own Anthropic key paying the fallback
 * model's own rates.
 *
 * Four things change about a reply that was answered this way, and each is a
 * function below so the three callers — the chat transport, the recognition
 * agent and the room-picture locator — read them one way:
 *
 *  - **its history** (`echoed`): blocks the declined model wrote before the
 *    hand-over are not all valid to send back;
 *  - **its words** (`saidIn`): the model that took over *continues* the reply
 *    rather than starting a new one;
 *  - **its tool calls** (`callsIn`): only the answering model's are run;
 *  - **its price** (`replyCostUsd`): each attempt bills at its own model's
 *    rates, and the top-level `usage` covers only the one that answered.
 *
 * A reply nothing fell back on is read exactly as it always was by all four,
 * which is the case the tests pin hardest: opting in must not move a single
 * byte of an ordinary conversation.
 *
 * **And a hub that outlives the beta keeps working** (`withFallbacks`). The
 * parameter is a beta with a history of renames — `fallback`, then a list,
 * then `'default'`, across three headers — and a hub is a board in somebody's
 * house that updates when somebody asks it to. So a request the API refuses
 * *because of the field* is sent again without it, once, and the hub stops
 * sending it until it restarts: a retired beta costs a home its fallback, never
 * its assistant.
 *
 * It imports the SDK's types and nothing else, so a home on OpenAI never loads
 * the SDK to satisfy an import of this file — `agent-loop.ts`'s rule.
 */

/** The beta the `'default'` form is sent under — a different date from the
 *  array form's, and pairing either with the other is a 400. */
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/**
 * The two request fields that opt a request in, or nothing for a model that
 * has no fallback.
 *
 * **Haiku is sent nothing.** It has no server-side fallback: `'default'`
 * leaves its refusals standing and a list is a 400, and the vendor's own
 * guidance is not to send the field at all. Asked by name rather than kept as
 * a list of the models that do take it, so a Claude added to `MODELS` later
 * opts in without anybody remembering to.
 */
export function fallbackFields(modelId: string): { betas?: string[]; fallbacks?: 'default' } {
  if (refusedByApi || modelId.startsWith('claude-haiku-')) return {};
  return { betas: [FALLBACK_BETA], fallbacks: 'default' };
}

/** The API refused the field once; it is not sent again by this process. */
let refusedByApi = false;

/** For the suites, which each start from a hub that has not been refused. */
export function forgetRefusedFallbacks(): void {
  refusedByApi = false;
}

/**
 * A `400` about the fallback field itself — its beta header retired or
 * renamed, or the parameter no longer taken — as against any other refusal,
 * which is the request's own problem and must reach the caller unchanged.
 */
function refusesFallbacks(error: unknown): boolean {
  if ((error as { status?: unknown } | null)?.status !== 400) return false;
  return /fallback|anthropic-beta/i.test(readableFailure(error));
}

/**
 * Send a request opted into fallbacks, and once more without them if the API
 * refuses the field — see the note at the top of the file.
 *
 * `send` is handed the fields to spread into its request, and is called again
 * from scratch on the second try: a refusal arrives before anything has
 * streamed, so a caller that subscribes to a stream inside `send` subscribes
 * afresh rather than twice.
 */
export async function withFallbacks<T>(
  modelId: string,
  send: (fields: ReturnType<typeof fallbackFields>) => Promise<T>,
): Promise<T> {
  const fields = fallbackFields(modelId);
  if (fields.fallbacks === undefined) return send(fields);
  try {
    return await send(fields);
  } catch (error) {
    if (!refusesFallbacks(error)) throw error;
    refusedByApi = true;
    return send({});
  }
}

type Block = Anthropic.Beta.BetaContentBlock;

/** Where the last hand-over in a reply is, or -1 when nothing fell back. */
function lastBoundary(content: readonly Block[]): number {
  for (let index = content.length - 1; index >= 0; index -= 1) {
    if (content[index]?.type === 'fallback') return index;
  }
  return -1;
}

/** The server-tool call ids whose result is also in `blocks` — a pair. */
function pairedServerCalls(blocks: readonly Block[]): Set<string> {
  const called = new Set<string>();
  const answered = new Set<string>();
  for (const block of blocks) {
    if (block.type === 'server_tool_use') called.add(block.id);
    if (block.type === 'web_search_tool_result' || block.type === 'web_fetch_tool_result') {
      answered.add(block.tool_use_id);
    }
  }
  return new Set([...called].filter((id) => answered.has(id)));
}

/**
 * A reply's content as it goes back onto the history.
 *
 * **Verbatim when nothing fell back**, thinking blocks included, which the
 * API requires of a thinking conversation — and which is every reply but the
 * rare one this function exists for.
 *
 * After a hand-over, **what the declined model wrote before the last
 * `fallback` block is only partly valid to send back**: its text stays (the
 * model that took over continued from it, and it is what reached the page),
 * and so does a server-side search or fetch that has its result beside it;
 * its thinking, a client tool call it began, a server call left without its
 * result, and anything else of its own the API has no use for are left out.
 * The `fallback` blocks stay where they were — the server reads the boundary
 * to validate the turn — and everything after the last one goes back exactly
 * as it came, being the answering model's own.
 */
export function echoed(content: readonly Block[]): Anthropic.Beta.BetaContentBlockParam[] {
  const boundary = lastBoundary(content);
  if (boundary < 0) return [...content];
  const paired = pairedServerCalls(content.slice(0, boundary));
  return content.filter((block, index) => {
    if (index >= boundary) return true;
    switch (block.type) {
      case 'text':
      case 'fallback':
        return true;
      case 'server_tool_use':
        return paired.has(block.id);
      case 'web_search_tool_result':
      case 'web_fetch_tool_result':
        return paired.has(block.tool_use_id);
      default:
        return false;
    }
  });
}

/**
 * Everything the reply said, joined.
 *
 * Blocks are joined with a line break, as they always were — prose either
 * side of a tool call is two things said. **Across a hand-over they are joined
 * with nothing**: the model that took over was given the declined one's words
 * to carry on from, so its first block continues a sentence rather than
 * starting one, and that is how it streamed onto the page.
 */
export function saidIn(content: readonly Block[]): string {
  let said = '';
  let joiner = '';
  for (const block of content) {
    if (block.type === 'fallback') {
      joiner = '';
      continue;
    }
    if (block.type !== 'text') continue;
    said += said.length > 0 ? joiner + block.text : block.text;
    joiner = '\n';
  }
  return said.trim();
}

/**
 * The client tool calls to run: the answering model's, and never one a model
 * began and then declined part way through — that call has no place in the
 * history (`echoed`) and nobody asked for it to be made.
 */
export function callsIn(content: readonly Block[]): Anthropic.Beta.BetaToolUseBlock[] {
  const boundary = lastBoundary(content);
  return content.filter(
    (block, index): block is Anthropic.Beta.BetaToolUseBlock => index > boundary && block.type === 'tool_use',
  );
}

/** Each hand-over in a reply, in the words a log line or a step can use. */
export function handOvers(content: readonly Block[]): { from: string; to: string }[] {
  return content.flatMap((block) =>
    block.type === 'fallback'
      ? [{ from: modelLabel('anthropic', block.from.model), to: modelLabel('anthropic', block.to.model) }]
      : [],
  );
}

/**
 * Whether another model answered this reply — the API's own signal, which is
 * a `fallback_message` entry in `usage.iterations` rather than a `fallback`
 * block: a conversation that fell back once is answered by the fallback model
 * directly for a while afterwards, and those replies carry no block at all.
 */
export function fellBack(usage: Anthropic.Beta.BetaUsage | undefined): boolean {
  return (usage?.iterations ?? []).some((entry) => entry.type === 'fallback_message');
}

/**
 * What one reply cost.
 *
 * **Its own model's rates when nothing fell back** — `usage` priced as it
 * always was, so every ordinary reply costs exactly what it did.
 *
 * **Per attempt when something did**, because the top-level `usage` then
 * covers only the attempt that answered, while a model that declined part way
 * through billed for what it had written and the one that took over bills at
 * its own price. `usage.iterations` is the list of attempts, each with its
 * model; an attempt that does not say which model ran it is priced as the one
 * asked for. Web searches are billed per request, counted once.
 */
export function replyCostUsd(requested: string, usage: Anthropic.Beta.BetaUsage | undefined): number {
  if (usage === undefined) return 0;
  const webSearchRequests = usage.server_tool_use?.web_search_requests ?? 0;
  if (!fellBack(usage)) {
    return estimateCostUsd(requested, {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read_input_tokens: usage.cache_read_input_tokens,
      cache_creation_input_tokens: usage.cache_creation_input_tokens,
      webSearchRequests,
    });
  }
  let spent = estimateCostUsd(requested, { webSearchRequests });
  for (const entry of usage.iterations ?? []) {
    if (entry.type !== 'message' && entry.type !== 'fallback_message') continue;
    spent += estimateCostUsd(entry.model ?? requested, {
      input_tokens: entry.input_tokens,
      output_tokens: entry.output_tokens,
      cache_read_input_tokens: entry.cache_read_input_tokens,
      cache_creation_input_tokens: entry.cache_creation_input_tokens,
    });
  }
  return spent;
}
