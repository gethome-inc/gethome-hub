import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { aiMappings } from '../db/schema.js';
import type { SettingsService } from '../core/settings.js';
import type { Logger } from '../logging.js';
import type {
  AppliedAiMapping,
  ZigbeeAiAssist,
} from '../adapters/zigbee/adapter.js';
// `exposesHash` is the cache key here, but it is a property of the device's
// published schema, so it lives with the schema — the adapter records it as
// part of how a device was recognised and must not import the AI stack to do
// so. Re-exported because this module is where callers learned to find it.
import {
  exposesHash,
  type CustomFieldSpec,
  type Z2mDevice,
  type Z2mProfile,
} from '../adapters/zigbee/exposes-mapper.js';
import type { AiRunHandle, AiRunLog } from '../core/ai-runs.js';
import {
  applyStateRules,
  buildCommandPayload,
  mappingDescriptorSchema,
  sanityCheckDescriptor,
  type DescriptorCustomField,
  type MappingDescriptor,
} from './descriptor.js';
import {
  agentStep,
  createMappingAgent,
  type AgentRunStats,
  type MappingProvider,
} from './agent.js';
import { DEFAULT_MODEL } from './models.js';
import { AiUnavailableError } from './errors.js';
import { MAPPING_SYSTEM_PROMPT, buildMappingUserPrompt, buildRepairUserPrompt } from './prompts.js';

export { exposesHash };

/**
 * AI device adaptation. When the static exposes mapper can't fully place a
 * device, this module runs the mapping agent (agent.ts — a tool-use loop on
 * the Anthropic Messages API, with the owner's own API key) to research the
 * device and produce a MappingDescriptor, validates and sanity-checks it,
 * caches it per device model, and hands the adapter an interpreted mapping.
 *
 * Without a configured credential this module does nothing — devices simply
 * keep their partial static mapping and a needs-review flag. Nothing but the
 * device's published schema (exposes + sample payloads, plus web searches
 * derived from its vendor/model strings) ever leaves the machine. See
 * docs/ai-adaptation.md.
 *
 * Operational guarantees added around the agent:
 *  - one agent run at a time (each run costs real money);
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
    private readonly runs?: AiRunLog,
  ) {}

  async requestMapping(
    device: Z2mDevice,
    staticProfile: Z2mProfile,
    options?: { samples?: Record<string, unknown>[]; force?: boolean },
  ): Promise<AppliedAiMapping | null> {
    const notADevice = notDeviceShaped(device);
    if (notADevice) {
      this.log.warn({ reason: notADevice }, 'Refused to ask the mapping agent about a non-device.');
      return null;
    }
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
        return parsed.success ? interpret(parsed.data, sourceOf(cached.source)) : null;
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

  /** Chain onto the run queue: at most one agent run at a time. */
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
    return this.runAgent({
      kind: 'map',
      device,
      hash,
      prompt: buildMappingUserPrompt(device, staticProfile, samples),
      brief: `${staticProfile.uncovered.length + staticProfile.unmapped.length} property/ies the hub could not place`,
    });
  }

  /**
   * Hand a descriptor that failed validation back to the agent with the exact
   * complaints, and store whatever it returns.
   *
   * This is the other half of letting somebody upload their own mapping: a
   * file that is nearly right is the common case — hand-written, or copied
   * from a device one firmware revision away — and "rejected, start again" is
   * a dead end for a person who cannot read a zod issue path. It deliberately
   * bypasses the cache: a `rejected` row is exactly what it is here to fix.
   */
  async repairMapping(
    device: Z2mDevice,
    staticProfile: Z2mProfile,
    broken: unknown,
    problems: string[],
  ): Promise<MappingDescriptor | null> {
    const notADevice = notDeviceShaped(device);
    if (notADevice) {
      this.log.warn({ reason: notADevice }, 'Refused to ask the mapping agent about a non-device.');
      return null;
    }
    const hash = exposesHash(device);
    const applied = await this.serialize(() =>
      this.runAgent({
        kind: 'repair',
        device,
        hash,
        prompt: buildRepairUserPrompt(device, staticProfile, broken, problems),
        brief: `${problems.length} problem(s) with a supplied descriptor`,
      }),
    );
    if (!applied) return null;
    const stored = await this.db.query.aiMappings.findFirst({
      where: and(eq(aiMappings.adapter, 'zigbee'), eq(aiMappings.exposesHash, hash)),
    });
    const parsed = mappingDescriptorSchema.safeParse(stored?.descriptor);
    return parsed.success ? parsed.data : null;
  }

  /**
   * One agent run, from the prompt to the stored descriptor.
   *
   * Both entry points funnel through here so that the run log, the backoff
   * ladder and the caching rules cannot drift apart between "map this device"
   * and "fix this descriptor" — the two differ only in the prompt.
   */
  private async runAgent(input: {
    kind: 'map' | 'repair';
    device: Z2mDevice;
    hash: string;
    prompt: string;
    brief: string;
  }): Promise<AppliedAiMapping | null> {
    const provider = await this.resolveProvider();
    if (!provider) return null;
    const { model: configuredModel } = await this.settings.getAiSettings();

    const run: AiRunHandle | undefined = this.runs?.begin({
      kind: input.kind,
      adapter: 'zigbee',
      exposesHash: input.hash,
      vendor: input.device.definition?.vendor,
      model: input.device.definition?.model ?? input.device.friendly_name,
      modelId: configuredModel ?? DEFAULT_MODEL,
    });
    run?.step(
      agentStep(
        'prompt',
        input.kind === 'repair'
          ? 'Sent the device schema and what was wrong with the supplied mapping.'
          : 'Sent the device schema and its recent reports.',
        input.brief,
      ),
    );

    let stats: AgentRunStats | null = null;
    let descriptor: MappingDescriptor;
    try {
      const candidate = await provider.generate(MAPPING_SYSTEM_PROMPT, input.prompt, {
        onStats: (s) => {
          stats = s;
        },
        onStep: (step) => run?.step(step),
      });
      const parsed = mappingDescriptorSchema.safeParse(candidate);
      if (!parsed.success) {
        const problems = parsed.error.issues.map(
          (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
        );
        this.log.warn({ issues: parsed.error.issues }, 'AI mapping failed validation');
        await this.store(input.device, input.hash, candidate, 'rejected', 'ai', problems);
        await this.recordRun(false, stats);
        await run?.finish(this.outcome(false, stats, 'invalid_descriptor', problems.join('; ')));
        return null;
      }
      const problems = sanityCheckDescriptor(parsed.data);
      if (problems.length > 0) {
        this.log.warn({ problems }, 'AI mapping failed sanity checks');
        await this.store(input.device, input.hash, parsed.data, 'rejected', 'ai', problems);
        await this.recordRun(false, stats);
        await run?.finish(this.outcome(false, stats, 'failed_sanity_checks', problems.join('; ')));
        return null;
      }
      descriptor = parsed.data;
    } catch (error) {
      if (error instanceof AiUnavailableError) {
        await this.recordUnavailable(error);
        await run?.finish(this.outcome(false, stats, error.kind, error.message));
        return null;
      }
      // The run failed on its own merits (gave up, never submitted…). The
      // account works, so nothing is cached and no backoff is armed — the
      // next natural trigger simply tries again.
      this.log.warn({ err: error }, 'AI mapping request failed');
      await this.recordRun(false, stats);
      await run?.finish(this.outcome(false, stats, 'run_failed', (error as Error).message));
      return null;
    }

    await this.store(input.device, input.hash, descriptor, 'generated', 'ai', null);
    await this.recordRun(true, stats);
    await run?.finish(this.outcome(true, stats));
    this.log.info(
      `AI mapping stored for ${input.device.definition?.model ?? input.device.friendly_name} (${descriptor.endpoints.length} endpoint(s)).`,
    );
    return interpret(descriptor, 'ai');
  }

  private outcome(
    ok: boolean,
    stats: AgentRunStats | null,
    errorKind?: string,
    errorMessage?: string,
  ) {
    return {
      ok,
      ...(stats !== null ? { costUsd: stats.costUsd, turns: stats.numTurns, durationMs: stats.durationMs } : {}),
      ...(errorKind !== undefined ? { errorKind } : {}),
      ...(errorMessage !== undefined ? { errorMessage } : {}),
    };
  }

  private async resolveProvider(): Promise<MappingProvider | null> {
    if (this.providerOverride) return this.providerOverride;
    const { provider, model, enabled, legacySubscriptionToken } = await this.settings.getAiSettings();
    // The owner's switch. `lazy.ts` checks it too — that check saves loading
    // this module at all, and this one is what makes the rule true for a
    // mapper somebody constructed directly.
    if (!enabled) return null;
    if (!provider) return null;
    if (legacySubscriptionToken) {
      // A credential saved before the agent moved to the Messages API. It
      // cannot authenticate, and a bare 401 on the next device announcement
      // would tell the owner nothing — surface the actual fix instead.
      await this.recordUnavailable(
        new AiUnavailableError(
          'auth_failed',
          'The saved credential is a Claude subscription token, which the hub no longer supports. ' +
            'Save an Anthropic API key in the hub settings to turn AI adaptation back on.',
        ),
      );
      return null;
    }
    const secret = await this.settings.aiKey();
    if (!secret) return null;
    return createMappingAgent({ secret }, model, this.log);
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
    source: 'ai' | 'imported',
    problems: string[] | null,
  ): Promise<void> {
    const { provider } = await this.settings.getAiSettings();
    const row = {
      descriptor: descriptor as Record<string, unknown>,
      status,
      source,
      problems,
      provider,
      updatedAt: new Date(),
    };
    await this.db
      .insert(aiMappings)
      .values({
        adapter: 'zigbee',
        vendor: device.definition?.vendor ?? null,
        model: device.definition?.model ?? null,
        exposesHash: hash,
        ...row,
      })
      .onConflictDoUpdate({
        target: [aiMappings.adapter, aiMappings.exposesHash],
        set: row,
      });
  }
}

/**
 * Why this input must never reach the agent, or `null` when it may.
 *
 * The traffic inspector shows the whole broker — permit-join requests, bridge
 * logs, hub status, whatever else is on the network — and none of that is a
 * device. Today nothing routes it here: the agent's only caller is device
 * adoption, driven by `bridge/devices`. This is the wall that keeps it that
 * way, so a future caller with a plausible-looking object cannot quietly turn
 * hub chatter into billed research about a device that does not exist.
 *
 * The test for "a device" is the same one the mapping itself rests on: an IEEE
 * address, and a published schema to map. Anything without both would produce
 * a descriptor about nothing.
 */
export function notDeviceShaped(device: Z2mDevice | null | undefined): string | null {
  if (!device || typeof device !== 'object') return 'not an object';
  if (typeof device.ieee_address !== 'string' || device.ieee_address.length === 0) {
    return 'no IEEE address — this is not a device on the network';
  }
  if (!Array.isArray(device.definition?.exposes) || device.definition.exposes.length === 0) {
    return 'no published schema to map';
  }
  if (device.type === 'Coordinator') return 'the coordinator is the radio, not a device';
  if (typeof device.friendly_name === 'string' && device.friendly_name.startsWith('bridge/')) {
    return 'a bridge topic is hub traffic, not a device';
  }
  return null;
}

/** A stored row's `source`, defaulting the way an old row should read. */
function sourceOf(value: string | null | undefined): 'ai' | 'imported' {
  return value === 'imported' ? 'imported' : 'ai';
}

export function interpret(
  descriptor: MappingDescriptor,
  source: 'ai' | 'imported',
): AppliedAiMapping {
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
    source,
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
