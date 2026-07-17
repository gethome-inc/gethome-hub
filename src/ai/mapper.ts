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
import type { CustomFieldSpec } from '../adapters/zigbee/exposes-mapper.js';
import {
  applyStateRules,
  buildCommandPayload,
  mappingDescriptorSchema,
  sanityCheckDescriptor,
  type DescriptorCustomField,
  type MappingDescriptor,
} from './descriptor.js';
import {
  DEFAULT_MODEL,
  createMappingAgent,
  type AgentRunStats,
  type MappingProvider,
} from './agent.js';
import { AiUnavailableError } from './errors.js';
import { MAPPING_SYSTEM_PROMPT, buildMappingUserPrompt } from './prompts.js';

/**
 * AI device adaptation. When the static exposes mapper can't fully place a
 * device, this module runs the mapping agent (agent.ts — Claude Agent SDK,
 * with the owner's own API key or Claude subscription token) to research the
 * device and produce a MappingDescriptor, validates and sanity-checks it,
 * caches it per device model in Postgres, and hands the adapter an
 * interpreted mapping.
 *
 * Without a configured credential this module does nothing — devices simply
 * keep their partial static mapping and a needs-review flag. Nothing but the
 * device's published schema (exposes + sample payloads, plus web searches
 * derived from its vendor/model strings) ever leaves the machine. See
 * docs/ai-adaptation.md.
 *
 * Operational guarantees added around the agent:
 *  - one agent run at a time (each run is a subprocess and costs real money);
 *  - concurrent requests for the same device model share one run;
 *  - transient account failures (rate limit, exhausted subscription window,
 *    bad credentials…) trip a backoff gate — no run is even attempted until
 *    it expires — and are surfaced on GET /settings/ai as `status.lastError`.
 */
export class AiDeviceMapper implements ZigbeeAiAssist {
  /** Test seam: overrides the agent constructed from settings. */
  providerOverride: MappingProvider | null = null;

  /** In-flight run per exposes hash — concurrent same-model requests join it. */
  private readonly inFlight = new Map<string, Promise<AppliedAiMapping | null>>();
  /** Serializes agent runs hub-wide. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Backoff gate: no runs until this timestamp. */
  private unavailableUntil = 0;
  private failureCount = 0;

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly log: Logger,
    private readonly options: { dataDir: string },
  ) {}

  async requestMapping(
    device: Z2mDevice,
    staticProfile: Z2mProfile,
    options?: { samples?: Record<string, unknown>[]; force?: boolean },
  ): Promise<AppliedAiMapping | null> {
    const hash = exposesHash(device);

    if (options?.force) {
      await this.invalidate(device);
    } else {
      const cached = await this.db.query.aiMappings.findFirst({
        where: and(eq(aiMappings.adapter, 'zigbee'), eq(aiMappings.exposesHash, hash)),
      });
      if (cached) {
        if (cached.status === 'rejected') return null;
        const parsed = mappingDescriptorSchema.safeParse(cached.descriptor);
        return parsed.success ? interpret(parsed.data) : null;
      }
    }

    const existing = this.inFlight.get(hash);
    if (existing) return existing;

    const run = this.serialize(() =>
      this.generateMapping(device, staticProfile, hash, options?.samples ?? []),
    );
    this.inFlight.set(hash, run);
    try {
      return await run;
    } finally {
      this.inFlight.delete(hash);
    }
  }

  /** Drop a cached mapping so the next announcement regenerates it. */
  async invalidate(device: Z2mDevice): Promise<void> {
    await this.db
      .delete(aiMappings)
      .where(and(eq(aiMappings.adapter, 'zigbee'), eq(aiMappings.exposesHash, exposesHash(device))));
  }

  /** Chain onto the run queue: at most one agent subprocess at a time. */
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async generateMapping(
    device: Z2mDevice,
    staticProfile: Z2mProfile,
    hash: string,
    samples: Record<string, unknown>[],
  ): Promise<AppliedAiMapping | null> {
    if (Date.now() < this.unavailableUntil) {
      this.log.debug(
        `AI backoff active until ${new Date(this.unavailableUntil).toISOString()} — skipping mapping request.`,
      );
      return null;
    }

    const provider = await this.resolveProvider();
    if (!provider) return null;

    this.log.info(`Asking the mapping agent about ${device.definition?.model ?? device.friendly_name}…`);
    let stats: AgentRunStats | null = null;
    let descriptor: MappingDescriptor;
    try {
      const candidate = await provider.generate(
        MAPPING_SYSTEM_PROMPT,
        buildMappingUserPrompt(device, staticProfile, samples),
        {
          device,
          staticProfile,
          samples,
          exposesHash: hash,
          onStats: (s) => {
            stats = s;
          },
        },
      );
      const parsed = mappingDescriptorSchema.safeParse(candidate);
      if (!parsed.success) {
        this.log.warn({ issues: parsed.error.issues }, 'AI mapping failed validation');
        await this.store(device, hash, candidate, 'rejected');
        await this.recordRun(false, stats);
        return null;
      }
      const problems = sanityCheckDescriptor(parsed.data);
      if (problems.length > 0) {
        this.log.warn({ problems }, 'AI mapping failed sanity checks');
        await this.store(device, hash, parsed.data, 'rejected');
        await this.recordRun(false, stats);
        return null;
      }
      descriptor = parsed.data;
    } catch (error) {
      if (error instanceof AiUnavailableError) {
        await this.recordUnavailable(error);
        return null;
      }
      // The run failed on its own merits (gave up, never submitted…). The
      // account works, so nothing is cached and no backoff is armed — the
      // next natural trigger simply tries again.
      this.log.warn({ err: error }, 'AI mapping request failed');
      await this.recordRun(false, stats);
      return null;
    }

    await this.store(device, hash, descriptor, 'generated');
    await this.recordRun(true, stats);
    this.log.info(
      `AI mapping stored for ${device.definition?.model ?? device.friendly_name} (${descriptor.endpoints.length} endpoint(s)).`,
    );
    return interpret(descriptor);
  }

  private async resolveProvider(): Promise<MappingProvider | null> {
    if (this.providerOverride) return this.providerOverride;
    const { provider, authType, model } = await this.settings.getAiSettings();
    if (!provider) return null;
    const secret = await this.settings.aiKey();
    if (!secret) return null;
    return createMappingAgent({ authType, secret }, model, this.options.dataDir, this.log);
  }

  /** Transient account/service failure: arm the backoff gate and surface it. */
  private async recordUnavailable(error: AiUnavailableError): Promise<void> {
    this.failureCount += 1;
    const ladder = [60_000, 300_000, 1_800_000, 7_200_000] as const;
    const backoffMs = ladder[Math.min(this.failureCount, ladder.length) - 1]!;
    this.unavailableUntil = error.resetAt
      ? Math.max(error.resetAt.getTime(), Date.now() + 30_000)
      : Date.now() + backoffMs;
    this.log.warn(
      { kind: error.kind, retryAt: new Date(this.unavailableUntil).toISOString() },
      `AI unavailable (${error.kind}): ${error.message.slice(0, 200)}`,
    );
    const current = await this.settings.getAiStatus();
    await this.settings.setAiStatus({
      ...(current.lastRun !== undefined ? { lastRun: current.lastRun } : {}),
      lastError: {
        kind: error.kind,
        message: error.message.slice(0, 200),
        at: new Date().toISOString(),
        ...(error.resetAt !== undefined ? { resetAt: error.resetAt.toISOString() } : {}),
      },
    });
  }

  /** A run completed (well or badly) — the account works, so clear the gate. */
  private async recordRun(ok: boolean, stats: AgentRunStats | null): Promise<void> {
    this.failureCount = 0;
    this.unavailableUntil = 0;
    const { model } = await this.settings.getAiSettings();
    await this.settings.setAiStatus({
      lastRun: {
        at: new Date().toISOString(),
        ok,
        ...(stats !== null ? { costUsd: stats.costUsd } : {}),
        model: model ?? DEFAULT_MODEL,
      },
    });
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
  // Typed properties = keys mapped onto real capabilities (they supersede any
  // static custom field); `properties` also includes generic field ids.
  const typedProperties = new Set<string>();
  const properties = new Set<string>();
  for (const endpoint of descriptor.endpoints) {
    for (const rule of endpoint.stateRules) {
      const key = rule.property.split('.')[0]!;
      typedProperties.add(key);
      properties.add(key);
    }
    for (const field of endpoint.customFields) properties.add(field.id);
  }
  return {
    endpoints: descriptor.endpoints.map((endpoint) => ({
      endpointId: endpoint.endpointId,
      deviceKind: endpoint.deviceKind,
      capabilities: endpoint.capabilities,
      primary: endpoint.primary,
      ...(endpoint.customFields.length > 0
        ? { customFields: endpoint.customFields.map(toCustomFieldSpec) }
        : {}),
    })),
    properties,
    typedProperties,
    extractState: (payload) => applyStateRules(descriptor, payload),
    buildCommandPayload: (endpointId, command) => buildCommandPayload(descriptor, endpointId, command),
  };
}

/** Drop the hub-side write metadata (onValue/offValue) — the apps see only
 *  the display inventory. Conditional spreads satisfy exactOptionalPropertyTypes. */
function toCustomFieldSpec(field: DescriptorCustomField): CustomFieldSpec {
  return {
    id: field.id,
    label: field.label,
    control: field.control,
    ...(field.unit !== undefined ? { unit: field.unit } : {}),
    ...(field.min !== undefined ? { min: field.min } : {}),
    ...(field.max !== undefined ? { max: field.max } : {}),
    ...(field.step !== undefined ? { step: field.step } : {}),
    ...(field.options !== undefined ? { options: field.options } : {}),
    settable: field.settable,
  };
}
