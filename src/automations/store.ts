import { and, asc, desc, eq, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { automationRuns, automationStatus, automationVersions, automations } from '../db/schema.js';
import { automationDocumentSchema, type AutomationDocument } from './schema.js';
import { readStoredOrigin, type NewOrigin, type StoredOrigin } from './origin.js';

/**
 * Where automations live, and the bounds that keep them from becoming the SD
 * card problem.
 *
 * Three tables and three different kinds of bound, because they answer to
 * three different pressures:
 *
 *  - **the rules themselves** are unbounded and that is correct: a home has a
 *    dozen, a person made every one of them on purpose, and nothing writes
 *    one by itself;
 *  - **versions** are bounded per rule, on *bulk* — the `device_portraits`
 *    shape rather than the `STATE_FLUSH_MS` one, since an edit is a deliberate
 *    act and a document is two kilobytes;
 *  - **runs** are bounded per rule and by age. Per rule rather than globally
 *    is the `history.ts` prune argument: a global cap lets one chatty rule
 *    evict every trace of a quiet one, and "why did this fire" has to be
 *    answerable for the rule somebody is actually asking about.
 */

/** Edits kept per rule. Enough to walk back out of a bad afternoon. */
const RETAIN_VERSIONS = 10;
/** Firings kept per rule, and how long any of them survive. */
const RETAIN_RUNS = 20;
const RETAIN_RUN_DAYS = 14;
/** Steps kept in one trace — a run with more than this has gone wrong in a
 *  way the first forty lines already show (`AiRunLog`'s `MAX_STEPS` rule). */
export const MAX_RUN_STEPS = 40;

export interface AutomationRecord {
  id: string;
  name: string;
  /** The app's own mark token, or null for "the app decides" — see the column. */
  icon: string | null;
  enabled: boolean;
  active: boolean;
  disabledReason: string | null;
  document: AutomationDocument;
  createdBy: string | null;
  /** How it reached the hub — null on a rule from before that was kept. */
  origin: StoredOrigin | null;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A stored row this build cannot read.
 *
 * `install.sh` rolls back to the previous release when a build fails its
 * health check, and the database has already migrated by then — so a document
 * saved by a newer hub can meet an older one that has never heard of one of
 * its nodes. The honest answer is neither to crash nor to run a rule with a
 * step quietly missing: the row is kept, reported, and **not executed**, and
 * it starts working again the moment the newer build is back.
 */
export interface UnreadableAutomation {
  id: string;
  name: string;
  problem: string;
}

export interface AutomationRunStep {
  at: string;
  /** trigger | condition | command | refused | wait | note */
  kind: string;
  summary: string;
  detail?: string;
  /**
   * Set on a step that is **something asked for that did not happen** — a
   * device that did not answer or was offline, a relay the hub protected, a
   * chain cut, the breaker. It is exactly what the rule's status counts as a
   * problem, said per step.
   *
   * It exists because `kind` cannot say it. A `refused` step is also what the
   * idempotence guard writes for "was already on", which is the house being
   * as asked — and every shipped build draws a step by its `kind`, so that
   * word's meaning has to stay where it is. Absent, never `false`.
   */
  problem?: true;
}

export interface AutomationRunRecord {
  /** The row's own id, when the engine needs to find this trace again. */
  id?: string;
  automationId: string;
  trigger: string;
  cause: string;
  /** The cause in the hub's exact terms — see the column. */
  causeDetail?: string;
  outcome: 'ran' | 'skipped' | 'refused' | 'failed' | 'interrupted';
  durationMs: number;
  steps: AutomationRunStep[];
}

export class AutomationStore {
  private lastRunPruneAt = 0;

  constructor(private readonly db: Db) {}

  /**
   * Everything in the home, and everything this build could not read.
   *
   * Returned as two lists rather than one with a flag, because the callers
   * want different things: the engine runs the first and never sees the
   * second, while the API has to show both or a rule would vanish from an
   * app with no explanation.
   */
  async load(): Promise<{ records: AutomationRecord[]; unreadable: UnreadableAutomation[] }> {
    const rows = await this.db.select().from(automations).orderBy(asc(automations.sortOrder));
    const records: AutomationRecord[] = [];
    const unreadable: UnreadableAutomation[] = [];
    for (const row of rows) {
      const parsed = automationDocumentSchema.safeParse(row.document);
      if (!parsed.success) {
        unreadable.push({
          id: row.id,
          name: row.name,
          problem: parsed.error.issues
            .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('; '),
        });
        continue;
      }
      records.push({
        id: row.id,
        name: row.name,
        icon: row.icon,
        enabled: row.enabled,
        active: row.active,
        disabledReason: row.disabledReason,
        document: parsed.data,
        createdBy: row.createdBy,
        origin: readStoredOrigin(row.origin),
        sortOrder: row.sortOrder,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      });
    }
    return { records, unreadable };
  }

  /**
   * `origin` is how the rule reached the hub, and this is the only place it
   * is ever written: `update`, `setLook` and a revert leave it alone, because
   * a rule edited in a chat is still the rule a template installed.
   *
   * It says the same thing `note` says and both are kept on purpose. The note
   * goes on a *version*, where it reads beside the notes of the edits that
   * followed, and ten versions are kept; the origin goes on the rule, where it
   * is still there after the eleventh edit.
   */
  async create(
    document: AutomationDocument,
    memberId: string | null,
    note = 'created',
    origin: NewOrigin | null = null,
  ): Promise<AutomationRecord> {
    const [row] = await this.db
      .insert(automations)
      .values({
        name: document.name,
        document,
        createdBy: memberId,
        origin,
        /**
         * **Created switched off.** A rule the agent has just written is the
         * one moment somebody can still look at what is about to start
         * happening in their house, and an automation that begins acting the
         * instant it is saved takes that moment away. Enabling is one tap and
         * is a decision.
         */
        enabled: false,
        sortOrder: await this.nextSortOrder(),
      })
      .returning();
    if (!row) throw new Error('automation was not written');
    await this.writeVersion(row.id, document, memberId, note);
    return this.toRecord(row.id, document, row);
  }

  async update(
    id: string,
    document: AutomationDocument,
    memberId: string | null,
    note = 'edited',
  ): Promise<AutomationRecord | null> {
    const existing = await this.row(id);
    if (!existing) return null;
    // The version records what the rule *used to say*: written before the
    // update, so reverting has something to go back to even for the first edit.
    await this.writeVersion(id, existing.document as AutomationDocument, memberId, note);
    const [row] = await this.db
      .update(automations)
      .set({ name: document.name, document, updatedAt: new Date() })
      .where(eq(automations.id, id))
      .returning();
    if (!row) return null;
    return this.toRecord(id, document, row);
  }

  /**
   * Rename a rule, or restyle it — the two halves of what a rule is *called*.
   *
   * **A rename writes the document as well as the column**, because they are
   * one fact stored twice: `update()` sets `name` from `document.name`, so a
   * rename that touched only the column would be silently undone by the next
   * edit made in conversation — and the agent reads the document, so it would
   * go on calling the rule by a name nobody in the home uses any more.
   *
   * **No version row.** A version records what the rule used to *say*, and ten
   * are kept per rule to walk back out of a bad afternoon; spending one on a
   * rename would evict an edit that actually changed what the house does. The
   * behaviour is untouched here.
   *
   * `icon` is three-valued in the same way the route's body is: leaving it
   * `undefined` keeps whatever the rule wears, and `null` puts it back to the
   * mark the app derives.
   */
  async setLook(
    id: string,
    look: { name?: string; icon?: string | null },
  ): Promise<AutomationRecord | null> {
    const existing = await this.row(id);
    if (!existing) return null;
    const document = existing.document as AutomationDocument;
    const renamed =
      look.name !== undefined && look.name !== document.name
        ? { ...document, name: look.name }
        : document;
    const [row] = await this.db
      .update(automations)
      .set({
        ...(look.name !== undefined ? { name: look.name, document: renamed } : {}),
        ...(look.icon !== undefined ? { icon: look.icon } : {}),
        updatedAt: new Date(),
      })
      .where(eq(automations.id, id))
      .returning();
    if (!row) return null;
    return this.toRecord(id, renamed, row);
  }

  /**
   * Switch a rule on or off.
   *
   * `reason` is the hub's own sentence when the circuit breaker did it, and
   * is cleared whenever a person switches the rule back on — a stale
   * explanation on a working rule is worse than none.
   */
  async setEnabled(id: string, enabled: boolean, reason: string | null = null): Promise<boolean> {
    const result = await this.db
      .update(automations)
      .set({ enabled, disabledReason: enabled ? null : reason, updatedAt: new Date() })
      .where(eq(automations.id, id))
      .returning();
    return result.length > 0;
  }

  /** Turn a manual toggle (a mode) on or off. */
  async setActive(id: string, active: boolean): Promise<boolean> {
    const result = await this.db
      .update(automations)
      .set({ active, updatedAt: new Date() })
      .where(eq(automations.id, id))
      .returning();
    return result.length > 0;
  }

  async remove(id: string): Promise<boolean> {
    const result = await this.db.delete(automations).where(eq(automations.id, id)).returning();
    return result.length > 0;
  }

  async versions(id: string) {
    return this.db
      .select()
      .from(automationVersions)
      .where(eq(automationVersions.automationId, id))
      .orderBy(desc(automationVersions.at))
      .limit(RETAIN_VERSIONS);
  }

  async runs(id: string, limit = RETAIN_RUNS) {
    return this.db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.automationId, id))
      .orderBy(desc(automationRuns.at))
      .limit(Math.min(Math.max(limit, 1), 100));
  }

  /**
   * Write one firing down.
   *
   * Never throws: a trace is how somebody finds out what happened, and losing
   * one must not be able to fail the run it describes — the rule `AiRunLog`
   * follows for the same reason.
   */
  async recordRun(run: AutomationRunRecord): Promise<void> {
    try {
      await this.db.insert(automationRuns).values({
        ...(run.id !== undefined ? { id: run.id } : {}),
        automationId: run.automationId,
        trigger: run.trigger,
        cause: run.cause.slice(0, 400),
        ...(run.causeDetail !== undefined ? { causeDetail: run.causeDetail.slice(0, 400) } : {}),
        outcome: run.outcome,
        durationMs: run.durationMs,
        steps: run.steps.slice(0, MAX_RUN_STEPS),
      });
      await this.pruneRuns(run.automationId);
    } catch {
      // See above.
    }
  }

  /**
   * Put one step of a stored trace right: the step that said a command went
   * out, once the radio has said it never landed.
   *
   * Found by when it was written and what it said, and replaced where it
   * stands, so the trace reads in the order things happened; a step that can
   * no longer be found is added at the end rather than lost. Never throws,
   * for `recordRun`'s reason, and a trace already pruned is simply gone.
   */
  async correctRunStep(
    runId: string,
    was: { at: string; summary: string },
    now: AutomationRunStep,
  ): Promise<void> {
    try {
      const [row] = await this.db
        .select({ steps: automationRuns.steps })
        .from(automationRuns)
        .where(eq(automationRuns.id, runId))
        .limit(1);
      if (!row) return;
      const steps = Array.isArray(row.steps) ? ([...row.steps] as AutomationRunStep[]) : [];
      const index = steps.findIndex((step) => step.at === was.at && step.summary === was.summary);
      if (index >= 0) steps[index] = now;
      else if (steps.length < MAX_RUN_STEPS) steps.push(now);
      await this.db.update(automationRuns).set({ steps }).where(eq(automationRuns.id, runId));
    } catch {
      // See above.
    }
  }

  /**
   * What the engine remembered about each rule before it last stopped —
   * opaque here, because the shape is the engine's (`status.ts`) and a row an
   * older or newer build wrote has to be read by whoever knows what to make
   * of it. Never throws: a hub that cannot read this starts with every rule
   * saying it has not run yet, which is true of this boot.
   */
  async loadStatus(): Promise<Map<string, unknown>> {
    try {
      const rows = await this.db.select().from(automationStatus);
      return new Map(rows.map((row) => [row.automationId, row.data]));
    } catch {
      return new Map();
    }
  }

  /**
   * Write down what the engine remembers, for the rules it says have moved.
   *
   * Called on a timer, never per firing — see the table. A rule deleted in the
   * meantime is a foreign key refusing its row, which is the right outcome and
   * must not take the other rows with it, so each is written on its own.
   */
  async saveStatus(entries: ReadonlyMap<string, unknown>): Promise<void> {
    for (const [automationId, data] of entries) {
      try {
        await this.db
          .insert(automationStatus)
          .values({ automationId, data, updatedAt: new Date() })
          .onConflictDoUpdate({
            target: automationStatus.automationId,
            set: { data, updatedAt: new Date() },
          });
      } catch {
        // See above.
      }
    }
  }

  private async writeVersion(
    id: string,
    document: AutomationDocument,
    memberId: string | null,
    note: string,
  ): Promise<void> {
    try {
      await this.db.insert(automationVersions).values({
        automationId: id,
        document,
        memberId,
        note: note.slice(0, 200),
      });
      const keep = await this.db
        .select({ at: automationVersions.at })
        .from(automationVersions)
        .where(eq(automationVersions.automationId, id))
        .orderBy(desc(automationVersions.at))
        .limit(RETAIN_VERSIONS);
      const oldest = keep.at(-1)?.at;
      if (oldest && keep.length >= RETAIN_VERSIONS) {
        await this.db
          .delete(automationVersions)
          .where(
            and(eq(automationVersions.automationId, id), lt(automationVersions.at, oldest)),
          );
      }
    } catch {
      // A missing version is a missing undo, not a failed edit.
    }
  }

  /**
   * Two bounds, per rule.
   *
   * Narrowed by `automation_id` first, which is the leading column of the
   * index — the `history.ts` rule that a bare age predicate is a full scan.
   * Hung off a write, so a home whose rules are not firing never wakes to do
   * this.
   */
  private async pruneRuns(automationId: string): Promise<void> {
    try {
      const now = Date.now();
      if (now - this.lastRunPruneAt > 60 * 60_000) {
        this.lastRunPruneAt = now;
        await this.db
          .delete(automationRuns)
          .where(lt(automationRuns.at, new Date(now - RETAIN_RUN_DAYS * 24 * 60 * 60_000)));
      }
      await this.db.delete(automationRuns).where(
        and(
          eq(automationRuns.automationId, automationId),
          lt(
            automationRuns.at,
            sql`(select min(at) from (select at from ${automationRuns} where automation_id = ${automationId} order by at desc limit ${RETAIN_RUNS}))`,
          ),
        ),
      );
    } catch {
      // Same reason as `recordRun`.
    }
  }

  private async nextSortOrder(): Promise<number> {
    const [row] = await this.db
      .select({ value: sql<number>`coalesce(max(sort_order), -1)` })
      .from(automations);
    return Number(row?.value ?? -1) + 1;
  }

  private async row(id: string) {
    const [row] = await this.db.select().from(automations).where(eq(automations.id, id)).limit(1);
    return row ?? null;
  }

  private toRecord(
    id: string,
    document: AutomationDocument,
    row: typeof automations.$inferSelect,
  ): AutomationRecord {
    return {
      id,
      name: row.name,
      icon: row.icon,
      enabled: row.enabled,
      active: row.active,
      disabledReason: row.disabledReason,
      document,
      createdBy: row.createdBy,
      origin: readStoredOrigin(row.origin),
      sortOrder: row.sortOrder,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
