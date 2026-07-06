import { z } from 'zod';
import { mappingDescriptorSchema } from './descriptor.js';
import type { AiProvider } from '../core/settings.js';

/**
 * Thin provider abstraction over the two supported model APIs. Keys are
 * user-supplied through the settings API and stored encrypted on the hub;
 * they are used in-process only, to call the configured provider.
 *
 * Both providers constrain the output structurally: Anthropic via a forced
 * tool whose input schema is the MappingDescriptor JSON schema; OpenAI via
 * response_format json_schema. Results are still zod-validated afterwards.
 */
export interface MappingProvider {
  /** Returns the raw (unvalidated) descriptor candidate. */
  generate(systemPrompt: string, userPrompt: string): Promise<unknown>;
}

export const DEFAULT_MODELS: Record<AiProvider, string> = {
  anthropic: 'claude-fable-5',
  openai: 'gpt-5.1',
};

const descriptorJsonSchema = z.toJSONSchema(mappingDescriptorSchema, { target: 'draft-7' });

export class AnthropicProvider implements MappingProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async generate(systemPrompt: string, userPrompt: string): Promise<unknown> {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: this.apiKey });
    const response = await client.messages.create({
      model: this.model,
      max_tokens: 8192,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      tools: [
        {
          name: 'submit_mapping',
          description: 'Submit the MappingDescriptor for the device.',
          input_schema: descriptorJsonSchema as never,
        },
      ],
      tool_choice: { type: 'tool', name: 'submit_mapping' },
    });
    const toolUse = response.content.find((block) => block.type === 'tool_use');
    if (!toolUse || toolUse.type !== 'tool_use') {
      throw new Error('Model returned no mapping');
    }
    return toolUse.input;
  }
}

export class OpenAIProvider implements MappingProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async generate(systemPrompt: string, userPrompt: string): Promise<unknown> {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: this.apiKey });
    const response = await client.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'mapping_descriptor', schema: descriptorJsonSchema as never },
      },
    });
    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error('Model returned no mapping');
    return JSON.parse(content);
  }
}

export function createProvider(provider: AiProvider, apiKey: string, model: string | null): MappingProvider {
  const resolvedModel = model ?? DEFAULT_MODELS[provider];
  return provider === 'anthropic'
    ? new AnthropicProvider(apiKey, resolvedModel)
    : new OpenAIProvider(apiKey, resolvedModel);
}
