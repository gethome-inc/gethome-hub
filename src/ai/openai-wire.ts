/**
 * What every request this hub makes to OpenAI's Responses API sends the same
 * way. Three callers — the recognition agent (`openai-agent.ts`), the chat
 * transport (`chat/openai-transport.ts`) and the name a conversation gets
 * (`chat/chat-title.ts`) — and each speaks the wire over plain `fetch`, so the
 * rule they share lives here rather than in three copies of a comment.
 *
 * Imports nothing, for `agent-core.ts`'s reason: a home with only an Anthropic
 * key must never load this vendor's half to satisfy an import chain, and this
 * file has no half to load.
 */

/**
 * A request's standing instructions, as the first item of `input`.
 *
 * **Never top-level `instructions`.** From GPT-6.2 on, the Responses API puts
 * `instructions` *after* `input` and bills them at the uncached rate on every
 * request, even when they are identical to the last one (OpenAI's *Prompt
 * caching* guide). Every prompt this hub sends is the same for the life of a
 * conversation, and the mapper's is ten kilobytes resent for up to forty
 * rounds, so that field would turn the cheapest part of every request into
 * one paid for in full each time. A `developer` message at the head of
 * `input` is the place the guide gives for reusable instructions: it is the
 * start of the prefix the API caches, on GPT-6.2 and on every earlier model,
 * which reads it exactly as it read `instructions`.
 *
 * The plain-string form, so the bytes do not change from one round to the
 * next — a prefix is only cached while it is identical.
 */
export function developerMessage(text: string): { role: 'developer'; content: string } {
  return { role: 'developer', content: text };
}
