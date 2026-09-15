import type { AiProvider } from '../../core/settings.js';
import type { ChatTransport, ChatTransportOptions } from './agent-loop.js';

/**
 * Build the conversation for whichever vendor is answering.
 *
 * **The import is dynamic, and that is the whole point of this file.** It is
 * `resolveProvider()`'s rule one subsystem over: a home configured with only an
 * OpenAI key must never load `@anthropic-ai/sdk` — the largest thing in this
 * graph after matter.js — to satisfy an import chain on a board with 415 MB of
 * RAM. Static imports of both transports in the agents would have loaded both
 * whatever the setting said, which is exactly the shape `agent-core.ts` exists
 * to prevent for the mapper.
 *
 * Nothing branches on the provider anywhere else: a pump reads `ChatRound`, and
 * `ChatTransport` is the only place either vendor's shape is known.
 */
export async function createChatTransport(
  provider: AiProvider,
  options: ChatTransportOptions,
): Promise<ChatTransport> {
  if (provider === 'openai') {
    const { createOpenAiTransport } = await import('./openai-transport.js');
    return createOpenAiTransport(options);
  }
  const { createAnthropicTransport } = await import('./anthropic-transport.js');
  return createAnthropicTransport(options);
}
