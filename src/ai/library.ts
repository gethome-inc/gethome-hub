import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { aiMappings } from '../db/schema.js';
import type { SettingsService } from '../core/settings.js';
import type { DeviceRegistry } from '../core/registry.js';
import type { AiRunLog } from '../core/ai-runs.js';
import type { Logger } from '../logging.js';
import type { ZigbeeAdapter } from '../adapters/zigbee/adapter.js';
import { mapExposes } from '../adapters/zigbee/exposes-mapper.js';
import { mappingDescriptorSchema, sanityCheckDescriptor, type MappingDescriptor } from './descriptor.js';

/**
 * The mapping library: every device model this hub knows how to interpret,
 * where that knowledge came from, and the two ways to change it.
 *
 * The cache this reads has existed since AI adaptation shipped — a second
 * device of a known model has always been placed instantly and for nothing.
 * What was missing was any way to *see* it, to move it between hubs, or to
 * fix one. A hub that reinstalled asked the agent about every device again;
 * a descriptor that was nearly right could only be thrown away.
 *
 * Nothing here needs an API key except `repair`. Listing, downloading,
 * uploading and deleting are all local operations on a JSON document, and
 * making them depend on a credential would be the same mistake as making the
 * static mapper depend on one.
 *
 * This module deliberately does **not** import the mapper or the agent at the
 * top level — `repair` loads them on demand — so the API can offer the library
 * without the Anthropic SDK in its graph.
 */

/** The file a download produces and an upload accepts. */
export const MAPPING_ENVELOPE_VERSION = 1;

export const mappingEnvelopeSchema = z.object({
  gethomeDeviceMapping: z.literal(MAPPING_ENVELOPE_VERSION),
  adapter: z.string().optional(),
  vendor: z.string().nullish(),
  model: z.string().nullish(),
  exposesHash: z.string().optional(),
  descriptor: z.unknown(),
});

export type MappingEnvelope = z.infer<typeof mappingEnvelopeSchema>;

export interface LibraryEntry {
  adapter: string;
  exposesHash: string;
  vendor: string | null;
  model: string | null;
  status: string;
  source: string;
  problems: string[] | null;
  endpoints: number;
  /** Devices on this hub that this entry governs. */
  deviceIds: string[];
  createdAt: string;
  updatedAt: string | null;
}

export type ImportOutcome =
  | { ok: true; exposesHash: string; hashMismatch: boolean; appliedTo: string[] }
  | { ok: false; problems: string[]; issues?: z.core.$ZodIssue[] };

export type RepairOutcome =
  | { ok: true; exposesHash: string; appliedTo: string[] }
  | { ok: false; reason: 'no_device' | 'nothing_to_repair' | 'agent_failed'; message: string };

export interface MappingLibraryDeps {
  db: Db;
  settings: SettingsService;
  registry: DeviceRegistry;
  log: Logger;
  zigbee?: ZigbeeAdapter | undefined;
  runs?: AiRunLog | undefined;
}

export class MappingLibrary {
  constructor(private readonly deps: MappingLibraryDeps) {}

  async list(): Promise<LibraryEntry[]> {
    const rows = await this.deps.db.select().from(aiMappings).orderBy(desc(aiMappings.createdAt));
    const byHash = this.devicesByHash();
    return rows.map((row) => ({
      adapter: row.adapter,
      exposesHash: row.exposesHash,
      vendor: row.vendor,
      model: row.model,
      status: row.status,
      source: row.source,
      problems: (row.problems as string[] | null) ?? null,
      endpoints: countEndpoints(row.descriptor),
      deviceIds: byHash.get(row.exposesHash) ?? [],
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt?.toISOString() ?? null,
    }));
  }

  /** The download: the descriptor, plus enough to say what device it is for. */
  async get(exposesHash: string): Promise<MappingEnvelope | null> {
    const row = await this.row(exposesHash);
    if (!row) return null;
    return {
      gethomeDeviceMapping: MAPPING_ENVELOPE_VERSION,
      adapter: row.adapter,
      vendor: row.vendor,
      model: row.model,
      exposesHash: row.exposesHash,
      descriptor: row.descriptor,
    };
  }

  /**
   * The upload. Accepts either the envelope a download produces or a bare
   * descriptor, because both are things a person plausibly has in a file.
   *
   * A rejected document is **stored anyway**, with the complaints beside it.
   * That is the point: "invalid, try again" is a dead end for somebody who
   * cannot read a zod issue path, and keeping the draft is what lets
   * `repair()` hand it to the agent with the exact reasons.
   *
   * An envelope whose own hash disagrees with the target is accepted and
   * flagged rather than refused — a mapping written for a device one firmware
   * revision away is the case this feature exists for, and the sanity checks
   * still have to pass either way.
   */
  async import(exposesHash: string, body: unknown): Promise<ImportOutcome> {
    const envelope = mappingEnvelopeSchema.safeParse(body);
    const candidate = envelope.success ? envelope.data.descriptor : body;
    const hashMismatch =
      envelope.success &&
      typeof envelope.data.exposesHash === 'string' &&
      envelope.data.exposesHash !== exposesHash;

    const parsed = mappingDescriptorSchema.safeParse(candidate);
    if (!parsed.success) {
      const problems = parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
      );
      await this.store(exposesHash, candidate, 'rejected', problems, envelope);
      return { ok: false, problems, issues: parsed.error.issues };
    }
    const problems = sanityCheckDescriptor(parsed.data);
    if (problems.length > 0) {
      await this.store(exposesHash, parsed.data, 'rejected', problems, envelope);
      return { ok: false, problems };
    }

    await this.store(exposesHash, parsed.data, 'generated', null, envelope);
    const appliedTo = (await this.deps.zigbee?.applyStoredMapping(exposesHash)) ?? [];
    this.deps.log.info(
      { exposesHash, appliedTo: appliedTo.length },
      'Imported a device mapping.',
    );
    return { ok: true, exposesHash, hashMismatch, appliedTo };
  }

  /**
   * Forget an entry. Devices of that model fall back to their static mapping
   * and the next natural trigger asks the agent again — which is why this is
   * also the way to undo a bad import without an API key.
   */
  async remove(exposesHash: string): Promise<boolean> {
    const row = await this.row(exposesHash);
    if (!row) return false;
    await this.deps.db
      .delete(aiMappings)
      .where(and(eq(aiMappings.adapter, 'zigbee'), eq(aiMappings.exposesHash, exposesHash)));
    await this.deps.zigbee?.forgetStoredMapping(exposesHash);
    return true;
  }

  /**
   * Hand a rejected descriptor to the agent with the complaints attached.
   *
   * Loaded on demand so the API layer never carries the Anthropic SDK, and
   * gated by the caller — `POST …/repair` answers 409 before reaching here
   * when there is no key or the owner has switched adaptation off.
   */
  async repair(exposesHash: string): Promise<RepairOutcome> {
    const row = await this.row(exposesHash);
    if (!row) return { ok: false, reason: 'nothing_to_repair', message: 'No mapping is stored for that device.' };
    if (row.status !== 'rejected') {
      return {
        ok: false,
        reason: 'nothing_to_repair',
        message: 'That mapping is already accepted — there is nothing to fix.',
      };
    }
    const device = this.deps.zigbee?.devicesOfModel(exposesHash)[0];
    if (!device) {
      return {
        ok: false,
        reason: 'no_device',
        message:
          'No device of that model is on the network right now, and the agent needs the live device to check ' +
          'a mapping against.',
      };
    }

    const { AiDeviceMapper } = await import('./mapper.js');
    const mapper = new AiDeviceMapper(this.deps.db, this.deps.settings, this.deps.log, this.deps.runs);
    const problems = ((row.problems as string[] | null) ?? []).slice(0, 40);
    const repaired = await mapper.repairMapping(device, mapExposes(device), row.descriptor, problems);
    if (!repaired) {
      return {
        ok: false,
        reason: 'agent_failed',
        message: 'The agent could not produce a mapping the hub accepts. The run log says what it tried.',
      };
    }
    const appliedTo = (await this.deps.zigbee?.applyStoredMapping(exposesHash)) ?? [];
    return { ok: true, exposesHash, appliedTo };
  }

  private async row(exposesHash: string) {
    return this.deps.db.query.aiMappings.findFirst({
      where: and(eq(aiMappings.adapter, 'zigbee'), eq(aiMappings.exposesHash, exposesHash)),
    });
  }

  private async store(
    exposesHash: string,
    descriptor: unknown,
    status: 'generated' | 'rejected',
    problems: string[] | null,
    envelope: z.ZodSafeParseResult<MappingEnvelope>,
  ): Promise<void> {
    // Name the entry from the envelope when it carries names, and otherwise
    // from a device of that model already on this hub — an entry with no
    // vendor and no model is a row nobody can identify in a list.
    const known = this.deps.zigbee?.devicesOfModel(exposesHash)[0];
    const vendor = (envelope.success ? envelope.data.vendor : null) ?? known?.definition?.vendor ?? null;
    const model = (envelope.success ? envelope.data.model : null) ?? known?.definition?.model ?? null;
    const values = {
      descriptor: descriptor as Record<string, unknown>,
      status,
      source: 'imported' as const,
      problems,
      updatedAt: new Date(),
    };
    await this.deps.db
      .insert(aiMappings)
      .values({ adapter: 'zigbee', exposesHash, vendor, model, ...values })
      .onConflictDoUpdate({
        target: [aiMappings.adapter, aiMappings.exposesHash],
        set: { ...values, vendor, model },
      });
  }

  /** Which devices each library entry governs, from what the adapter recorded. */
  private devicesByHash(): Map<string, string[]> {
    const byHash = new Map<string, string[]>();
    for (const device of this.deps.registry.listDevices()) {
      const hash = device.recognition?.exposesHash;
      if (!hash) continue;
      byHash.set(hash, [...(byHash.get(hash) ?? []), device.id]);
    }
    return byHash;
  }
}

function countEndpoints(descriptor: unknown): number {
  const parsed = mappingDescriptorSchema.safeParse(descriptor);
  return parsed.success ? (parsed.data as MappingDescriptor).endpoints.length : 0;
}
