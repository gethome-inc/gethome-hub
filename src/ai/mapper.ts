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
import { agentStep, type AgentRunStats, type MappingProvider } from './agent-core.js';
import { effectiveModel } from './models.js';
import { AiUnavailableError, describeRunFailure, readableFailure } from './errors.js';
import { mappingSystemPrompt, buildMappingUserPrompt, buildRepairUserPrompt } from './prompts.js';

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
  /**
   * Backoff gate: no *automatic* run until `until`, because the account this
   * was armed against was not working.
   *
   * **It names the credential it is about, and that is what makes it
   * survivable.** The gate used to be a bare timestamp, so the judgement
   * "this account is unavailable" outlived the account: an owner who met
   * `auth_failed`, went and fixed their key, and came back found a hub that
   * refused to run for up to two hours while every route still answered
   * cheerfully — the one moment where a gate meant to protect somebody is
   * only in their way. Worse, the gate is hub-wide, so a failure on one
   * provider silenced the other, which is precisely the switch an owner is
   * told to reach for. Keyed on provider, model and a digest of the secret,
   * it retires itself the moment any of the three moves, with no channel from
   * the settings routes to keep in step.
   */
  private gate: { until: number; failures: number; credential: string } | null = null;

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
      // An explicit ask is a person saying "try it now", and it is the whole
      // of how somebody recovers from a failure: change the key or the model,
      // press the button. So it clears the gate rather than being refused by
      // it — the same stance `MappingLibrary.repair` has always taken by
      // building its own mapper — and it drops a `rejected` row, which is the
      // other thing a weaker model can leave behind.
      this.gate = null;
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
      this.generateMapping(device, staticProfile, hash, {
        samples: options?.samples ?? [],
        // Carried all the way to the gate check rather than settled above,
        // because `serialize` puts this run behind every run already queued —
        // one of which can arm the gate after the button was pressed.
        explicit: options?.force === true,
      }),
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
    options: { samples: Record<string, unknown>[]; explicit: boolean },
  ): Promise<AppliedAiMapping | null> {
    if (!options.explicit && (await this.backoffActive())) return null;

    const provider = await this.resolveProvider();
    if (!provider) return null;

    this.log.info(`Asking the mapping agent about ${device.definition?.model ?? device.friendly_name}…`);
    return this.runAgent({
      kind: 'map',
      device,
      hash,
      prompt: buildMappingUserPrompt(device, staticProfile, options.samples),
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
    // Which vendor and model this run is about to spend money on. Read from
    // the resolved provider rather than from the flat `model` field, or every
    // OpenAI run would be recorded under whatever Claude model is configured.
    const ai = await this.settings.getAiSettings();
    const ranOn = ai.provider ?? 'anthropic';

    const run: AiRunHandle | undefined = this.runs?.begin({
      kind: input.kind,
      adapter: 'zigbee',
      exposesHash: input.hash,
      vendor: input.device.definition?.vendor,
      model: input.device.definition?.model ?? input.device.friendly_name,
      provider: ranOn,
      modelId: effectiveModel(ranOn, ai[ranOn].model),
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
      // The system prompt is the provider's, because the two runs do not have
      // the same research tools — see `mappingSystemPrompt`. `ranOn` is
      // already the resolved provider, so this cannot disagree with the
      // agent that was built above.
      const candidate = await provider.generate(mappingSystemPrompt(ranOn), input.prompt, {
        onStats: (s) => {
          stats = s;
        },
        onStep: (step) => run?.step(step),
        // Present only while the owner has asked for it — the callback's
        // absence is what makes recording free, so this is a conditional
        // spread rather than a handler that checks a flag. See
        // `AgentRunContext.onExchange`.
        ...(ai.recordExchanges ? { onExchange: (exchange) => run?.exchange(exchange) } : {}),
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
        await run?.finish(this.outcome(false, stats, error.kind, readableFailure(error)));
        return null;
      }
      // The run failed on its own merits (gave up, never submitted…). The
      // account works, so nothing is cached and no backoff is armed — the
      // next natural trigger simply tries again. What is *recorded* is the
      // provider's own sentence rather than its whole response body, plus the
      // fix where the refusal is really a setting — see `describeRunFailure`.
      this.log.warn({ err: error }, 'AI mapping request failed');
      await this.recordRun(false, stats);
      const failure = describeRunFailure(error);
      await run?.finish(this.outcome(false, stats, failure.kind, failure.message));
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
    const ai = await this.settings.getAiSettings();
    // The owner's switch. `lazy.ts` checks it too — that check saves loading
    // this module at all, and this one is what makes the rule true for a
    // mapper somebody constructed directly.
    if (!ai.enabled) return null;
    // Which provider recognises devices: the home's stored choice when it has
    // both keys, and otherwise whichever key there is. `settings.ts` resolves
    // that, so there is one answer rather than one per caller.
    const provider = ai.provider;
    if (!provider) return null;
    if (provider === 'anthropic' && ai.legacySubscriptionToken) {
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
    const secret = await this.settings.aiKey(provider);
    if (!secret) return null;
    // Imported here rather than at the top, so a home running on one provider
    // never loads the other's client — which for Anthropic means not loading
    // its SDK at all. The provider-neutral half both share is `agent-core.ts`,
    // which is what makes that possible.
    // **`effectiveModel`, not the stored string — this is the one place the
    // model is chosen to *run*, and it was the one place still reading the
    // column.** Everything that reports which model answered already went
    // through `effectiveModel`: `GET /settings/ai`, `ai_runs.modelId`,
    // `status.lastRun.model`, the backoff gate's credential id. Only this
    // call did not, so a home that had picked a model since retired went on
    // running it for ever while every screen and every recorded row said
    // otherwise — silently, because `isSupportedModel` is deliberately the
    // broad allowlist (a stored setting must not start 400-ing) and happily
    // let it through. Those homes are exactly the ones a retirement is for.
    const modelId = effectiveModel(provider, ai[provider].model);
    if (provider === 'openai') {
      const { createOpenAiMappingAgent } = await import('./openai-agent.js');
      return createOpenAiMappingAgent({ secret }, modelId, this.log);
    }
    const { createMappingAgent } = await import('./agent.js');
    return createMappingAgent({ secret }, modelId, this.log);
  }

  /**
   * Which credential the gate is about: the provider, the model it would run,
   * and a digest of the secret. Never the secret itself — this is compared and
   * logged nowhere, but a key held in a field is a key that can be printed.
   */
  private async credentialId(): Promise<string> {
    const ai = await this.settings.getAiSettings();
    const provider = ai.provider;
    if (!provider) return 'none';
    const secret = (await this.settings.aiKey(provider)) ?? '';
    const digest = createHash('sha256').update(secret).digest('hex').slice(0, 16);
    return `${provider}:${effectiveModel(provider, ai[provider].model)}:${digest}`;
  }

  /**
   * Is an *automatic* run gated? Answers false — and forgets the gate — once
   * it has expired or once it is about a credential this hub no longer uses.
   */
  private async backoffActive(): Promise<boolean> {
    const gate = this.gate;
    if (!gate) return false;
    // A credential this hub no longer uses: the judgement is stale, and so is
    // the count behind it — a new key starts the ladder again from the bottom.
    if ((await this.credentialId()) !== gate.credential) {
      this.log.info('AI settings changed since the backoff was armed — trying again.');
      this.gate = null;
      return false;
    }
    // Expired, so this run may go ahead — but the gate is **kept**, because
    // `failures` is what makes the next step of the ladder longer than the
    // last. Clearing it here restarted the count on every expiry and pinned
    // the backoff at its first step, so a hub whose account was dead retried
    // every sixty seconds for ever instead of easing off to two hours. Only a
    // completed run (`recordRun`) or a changed credential forgets it.
    if (Date.now() >= gate.until) return false;
    this.log.debug(
      `AI backoff active until ${new Date(gate.until).toISOString()} — skipping mapping request.`,
    );
    return true;
  }

  /** Transient account/service failure: arm the backoff gate and surface it. */
  private async recordUnavailable(error: AiUnavailableError): Promise<void> {
    const failures = (this.gate?.failures ?? 0) + 1;
    const ladder = [60_000, 300_000, 1_800_000, 7_200_000] as const;
    const backoffMs = ladder[Math.min(failures, ladder.length) - 1]!;
    const until = error.resetAt
      ? Math.max(error.resetAt.getTime(), Date.now() + 30_000)
      : Date.now() + backoffMs;
    this.gate = { until, failures, credential: await this.credentialId() };
    // The provider's own sentence, not its whole response body: this string
    // is what both apps put on screen under "AI paused until…".
    const said = readableFailure(error).slice(0, 200);
    this.log.warn(
      { kind: error.kind, retryAt: new Date(until).toISOString() },
      `AI unavailable (${error.kind}): ${said}`,
    );
    const current = await this.settings.getAiStatus();
    await this.settings.setAiStatus({
      ...(current.lastRun !== undefined ? { lastRun: current.lastRun } : {}),
      lastError: {
        kind: error.kind,
        message: said,
        at: new Date().toISOString(),
        ...(error.resetAt !== undefined ? { resetAt: error.resetAt.toISOString() } : {}),
      },
    });
  }

  /** A run completed (well or badly) — the account works, so clear the gate. */
  private async recordRun(ok: boolean, stats: AgentRunStats | null): Promise<void> {
    this.gate = null;
    const ai = await this.settings.getAiSettings();
    const ranOn = ai.provider ?? 'anthropic';
    await this.settings.setAiStatus({
      lastRun: {
        at: new Date().toISOString(),
        ok,
        ...(stats !== null ? { costUsd: stats.costUsd } : {}),
        model: effectiveModel(ranOn, ai[ranOn].model),
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
