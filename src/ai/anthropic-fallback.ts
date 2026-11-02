import type Anthropic from '@anthropic-ai/sdk';
import type { Logger } from '../logging.js';
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
 * *because of the field* is sent again without it, once, and — only if that
 * one is answered — the hub stops sending it until it restarts, and says so in
 * its log: a retired beta costs a home its fallback, never its assistant.
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
 *
 * **Narrow on purpose**, because what it answers is process-wide. A complaint
 * about the `anthropic-beta` header is about this beta — it is the only one the
 * hub sends — and a complaint about the `fallbacks` parameter names it in the
 * plural. A complaint about a `fallback` *block* a conversation's history
 * carries (singular, under `messages.N.content`) is neither: it is that
 * conversation's problem, its note offers the round again on a conversation
 * opened fresh, and switching the fallback off for every request the hub makes
 * would be the wrong answer to it.
 */
function refusesFallbacks(error: unknown): boolean {
  if ((error as { status?: unknown } | null)?.status !== 400) return false;
  const said = readableFailure(error);
  if (said.includes(FALLBACK_BETA) || /\banthropic-beta\b/i.test(said)) return true;
  return /\bfallbacks\b[^.]*\b(extra inputs|not permitted|unexpected|unknown|unsupported|not supported)/i.test(said);
}

/**
 * Send a request opted into fallbacks, and once more without them if the API
 * refuses the field — see the note at the top of the file.
 *
 * `send` is handed the fields to spread into its request, and is called again
 * from scratch on the second try: a refusal arrives before anything has
 * streamed, so a caller that subscribes to a stream inside `send` subscribes
 * afresh rather than twice.
 *
 * **The fallback is switched off only once the request without it has been
 * answered.** A refusal that names the field but was really about something
 * else would fail the second time too, and then it reaches the caller and
 * nothing is switched off. When it is, the log says so, once, with the API's
 * own sentence — a hub that has quietly stopped asking another Claude is a
 * hub somebody should hear about.
 */
export async function withFallbacks<T>(
  modelId: string,
  send: (fields: ReturnType<typeof fallbackFields>) => Promise<T>,
  log?: Pick<Logger, 'warn'>,
): Promise<T> {
  const fields = fallbackFields(modelId);
  if (fields.fallbacks === undefined) return send(fields);
  try {
    return await send(fields);
  } catch (error) {
    if (!refusesFallbacks(error)) throw error;
    const answered = await send({});
    if (!refusedByApi) {
      refusedByApi = true;
      log?.warn(
        { reason: readableFailure(error) },
        'Claude refused the server-side fallback, so this hub stops asking for it until it restarts',
      );
    }
    return answered;
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

/**
 * The server-tool calls in `blocks` that may go back: each has its result
 * beside it — **any** result, since a search, a fetch and the code execution
 * the `_20260209` tools filter their results with all answer by
 * `tool_use_id` — and, for a call made from inside another (a search code
 * execution ran), the call that made it goes back too. In order, so a caller
 * is decided before the calls it makes.
 */
function keptServerCalls(blocks: readonly Block[]): Set<string> {
  const answered = new Set<string>();
  for (const block of blocks) {
    if ('tool_use_id' in block && typeof block.tool_use_id === 'string') answered.add(block.tool_use_id);
  }
  const kept = new Set<string>();
  for (const block of blocks) {
    if (block.type !== 'server_tool_use' || !answered.has(block.id)) continue;
    const caller = block.caller;
    if (caller !== undefined && caller.type !== 'direct' && !kept.has(caller.tool_id)) continue;
    kept.add(block.id);
  }
  return kept;
}

/**
 * A reply's content as it goes back onto the history.
 *
 * **Verbatim when nothing fell back**, thinking blocks included, which the
 * API requires of a thinking conversation — and which is every reply but the
 * rare one this function exists for.
 *
 * After a hand-over, **what the declined model wrote before the last
 * `fallback` block is only partly valid to send back**: its words stay (the
 * model that took over continued from them, and they are what reached the
 * page), and so does a server-side call — a search, a fetch, the code
 * execution that filters them — that has its result beside it; its thinking,
 * a client tool call it began, a server call left without its result (and any
 * made from inside one), a text block with nothing in it (which the API
 * refuses), and anything else of its own the API has no use for are left out.
 * The `fallback` blocks stay where they were — the server reads the boundary
 * to validate the turn — and everything after the last one goes back exactly
 * as it came, being the answering model's own.
 */
export function echoed(content: readonly Block[]): Anthropic.Beta.BetaContentBlockParam[] {
  const boundary = lastBoundary(content);
  if (boundary < 0) return [...content];
  const kept = keptServerCalls(content.slice(0, boundary));
  return content.filter((block, index) => {
    if (index >= boundary) return true;
    if (block.type === 'text') return block.text.trim().length > 0;
    if (block.type === 'fallback') return true;
    if (block.type === 'server_tool_use') return kept.has(block.id);
    if ('tool_use_id' in block && typeof block.tool_use_id === 'string') return kept.has(block.tool_use_id);
    return false;
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
