import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { aiMappings } from '../db/schema.js';
import type { SettingsService } from '../core/settings.js';
import type { Logger } from '../logging.js';
import type {
  AppliedAiMapping,
  ZigbeeAiAssist,
} from '../adapters/zigbee/adapter.js';
import type { Z2mDevice, Z2mProfile } from '../adapters/zigbee/exposes-mapper.js';
import {
  applyStateRules,
  buildCommandPayload,
  mappingDescriptorSchema,
  sanityCheckDescriptor,
  type MappingDescriptor,
} from './descriptor.js';
import { createProvider, type MappingProvider } from './providers.js';
import { MAPPING_SYSTEM_PROMPT, buildMappingUserPrompt } from './prompts.js';

/**
 * AI device adaptation. When the static exposes mapper can't fully place a
 * device, this module asks the configured model (Anthropic or OpenAI, with
 * the owner's own key) for a MappingDescriptor, validates and sanity-checks
 * it, caches it per device model in Postgres, and hands the adapter an
 * interpreted mapping.
 *
 * Without a configured key this module does nothing — devices simply keep
 * their partial static mapping and a needs-review flag. Nothing but the
 * device's published schema (exposes + sample payloads) is ever sent to the
 * provider. See docs/ai-adaptation.md.
 */
export class AiDeviceMapper implements ZigbeeAiAssist {
  /** Test seam: overrides the provider constructed from settings. */
  providerOverride: MappingProvider | null = null;

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly log: Logger,
  ) {}

  async requestMapping(device: Z2mDevice, staticProfile: Z2mProfile): Promise<AppliedAiMapping | null> {
    const hash = exposesHash(device);

    const cached = await this.db.query.aiMappings.findFirst({
      where: and(eq(aiMappings.adapter, 'zigbee'), eq(aiMappings.exposesHash, hash)),
    });
    if (cached) {
      if (cached.status === 'rejected') return null;
      const parsed = mappingDescriptorSchema.safeParse(cached.descriptor);
      return parsed.success ? interpret(parsed.data) : null;
    }

    const provider = await this.resolveProvider();
    if (!provider) return null;

    this.log.info(`Asking the AI mapper about ${device.definition?.model ?? device.friendly_name}…`);
    let descriptor: MappingDescriptor;
    try {
      const candidate = await provider.generate(
        MAPPING_SYSTEM_PROMPT,
        buildMappingUserPrompt(device, staticProfile, []),
      );
      const parsed = mappingDescriptorSchema.safeParse(candidate);
      if (!parsed.success) {
        this.log.warn({ issues: parsed.error.issues }, 'AI mapping failed validation');
        await this.store(device, hash, candidate, 'rejected');
        return null;
      }
      const problems = sanityCheckDescriptor(parsed.data);
      if (problems.length > 0) {
        this.log.warn({ problems }, 'AI mapping failed sanity checks');
        await this.store(device, hash, parsed.data, 'rejected');
        return null;
      }
      descriptor = parsed.data;
    } catch (error) {
      this.log.warn({ err: error }, 'AI mapping request failed');
      return null;
    }

    await this.store(device, hash, descriptor, 'generated');
    this.log.info(
      `AI mapping stored for ${device.definition?.model ?? device.friendly_name} (${descriptor.endpoints.length} endpoint(s)).`,
    );
    return interpret(descriptor);
  }

  /** Drop a cached mapping so the next announcement regenerates it. */
  async invalidate(device: Z2mDevice): Promise<void> {
    await this.db
      .delete(aiMappings)
      .where(and(eq(aiMappings.adapter, 'zigbee'), eq(aiMappings.exposesHash, exposesHash(device))));
  }

  private async resolveProvider(): Promise<MappingProvider | null> {
    if (this.providerOverride) return this.providerOverride;
    const { provider, model } = await this.settings.getAiSettings();
    if (!provider) return null;
    const apiKey = await this.settings.aiKey();
    if (!apiKey) return null;
    return createProvider(provider, apiKey, model);
  }

  private async store(
    device: Z2mDevice,
    hash: string,
    descriptor: unknown,
    status: 'generated' | 'rejected',
  ): Promise<void> {
    const { provider } = await this.settings.getAiSettings();
    await this.db
      .insert(aiMappings)
      .values({
        adapter: 'zigbee',
        vendor: device.definition?.vendor ?? null,
        model: device.definition?.model ?? null,
        exposesHash: hash,
        descriptor: descriptor as Record<string, unknown>,
        status,
        provider,
      })
      .onConflictDoUpdate({
        target: [aiMappings.adapter, aiMappings.exposesHash],
        set: { descriptor: descriptor as Record<string, unknown>, status, provider },
      });
  }
}

/** Cache key: the device's published schema, canonicalized. */
export function exposesHash(device: Z2mDevice): string {
  const canonical = JSON.stringify({
    vendor: device.definition?.vendor ?? null,
    model: device.definition?.model ?? null,
    exposes: device.definition?.exposes ?? [],
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function interpret(descriptor: MappingDescriptor): AppliedAiMapping {
  return {
    endpoints: descriptor.endpoints.map((endpoint) => ({
      endpointId: endpoint.endpointId,
      deviceKind: endpoint.deviceKind,
      capabilities: endpoint.capabilities,
      primary: endpoint.primary,
    })),
    extractState: (payload) => applyStateRules(descriptor, payload),
    buildCommandPayload: (endpointId, command) => buildCommandPayload(descriptor, endpointId, command),
  };
}
