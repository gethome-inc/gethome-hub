import { randomUUID } from 'node:crypto';
import { desc, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { aiRuns } from '../db/schema.js';
// Type-only, so the Anthropic SDK is not pulled into the core graph.
import type { AgentStep } from '../ai/agent.js';
import type { HubEventBus } from './bus.js';

/**
 * How many runs are kept. Each is a row plus at most `MAX_STEPS` short strings,
 * so sixty of them are tens of kilobytes — a log an owner can scroll without
 * being a thing that grows on an SD card for the life of the hub.
 */
const RETAIN_RUNS = 60;

/** Steps recorded per run. A run that searches more than this has gone wrong
 *  in a way the first forty lines will already show. */
const MAX_STEPS = 40;

export type AiRunKind = 'map' | 'repair';

export interface AiRunEvent {
  phase: 'started' | 'step' | 'finished';
  id: string;
  at: string;
  kind: AiRunKind;
  exposesHash: string;
  vendor?: string;
  model?: string;
  step?: AgentStep;
  ok?: boolean;
  costUsd?: number;
  error?: string;
}

export interface AiRunStart {
  kind: AiRunKind;
  adapter: string;
  exposesHash: string;
  vendor?: string | undefined;
  model?: string | undefined;
  modelId?: string | undefined;
}

export interface AiRunOutcome {
  ok: boolean;
  costUsd?: number | undefined;
  turns?: number | undefined;
  durationMs?: number | undefined;
  errorKind?: string | undefined;
  errorMessage?: string | undefined;
}

/**
 * One run in progress: collects its steps, streams them, and writes one row.
 */
export interface AiRunHandle {
  readonly id: string;
  step(step: AgentStep): void;
  finish(outcome: AiRunOutcome): Promise<void>;
}

/**
 * What the mapping agent did, kept so somebody can find out afterwards.
 *
 * The hub used to record two summary blobs under one settings key — the last
 * run and the last error — so "why did this device end up needing review?" and
 * "what am I being charged for?" had no answer at all once a second device had
 * been adopted. Everything the agent did lived in a pino line on a machine
 * nobody is looking at.
 *
 * Three rules:
 *
 *  - **A summary, never a transcript.** Searches, pages read, submissions and
 *    the reasons a submission was refused. Model prose is not stored: it is
 *    the largest thing a run produces and the least useful to read later.
 *  - **It streams while it runs.** Adopting an unknown device can take
 *    minutes, and until now it produced no output until it was over. The
 *    `aiRun` events are what let an app show the work happening.
 *  - **It is bounded at both ends** — `MAX_STEPS` per run, `RETAIN_RUNS` runs,
 *    pruned on write like the activity log.
 */
export class AiRunLog {
  constructor(
    private readonly db: Db,
    private readonly events: HubEventBus,
  ) {}

  begin(input: AiRunStart): AiRunHandle {
    const id = randomUUID();
    const startedAt = Date.now();
    const steps: AgentStep[] = [];
    const identity = {
      id,
      kind: input.kind,
      exposesHash: input.exposesHash,
      ...(input.vendor !== undefined ? { vendor: input.vendor } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
    };

    this.events.emit('aiRun', { ...identity, phase: 'started', at: new Date().toISOString() });

    const log = this;
    return {
      id,
      step(step) {
        if (steps.length < MAX_STEPS) steps.push(step);
        log.events.emit('aiRun', {
          ...identity,
          phase: 'step',
          at: step.at,
          step,
        });
      },
      async finish(outcome) {
        const at = new Date();
        log.events.emit('aiRun', {
          ...identity,
          phase: 'finished',
          at: at.toISOString(),
          ok: outcome.ok,
          ...(outcome.costUsd !== undefined ? { costUsd: outcome.costUsd } : {}),
          ...(outcome.errorMessage !== undefined ? { error: outcome.errorMessage } : {}),
        });
        try {
          await log.prune();
          await log.db.insert(aiRuns).values({
            id,
            at,
            kind: input.kind,
            adapter: input.adapter,
            vendor: input.vendor ?? null,
            model: input.model ?? null,
            exposesHash: input.exposesHash,
            modelId: input.modelId ?? null,
            ok: outcome.ok,
            costUsd: outcome.costUsd ?? null,
            turns: outcome.turns ?? null,
            durationMs: outcome.durationMs ?? Date.now() - startedAt,
            errorKind: outcome.errorKind ?? null,
            errorMessage: outcome.errorMessage?.slice(0, 500) ?? null,
            steps,
          });
        } catch {
          // A run that happened and could not be written down is still a run
          // that happened — never let bookkeeping fail the adoption it
          // describes.
        }
      },
    };
  }

  async list(limit = 30) {
    return this.db
      .select()
      .from(aiRuns)
      .orderBy(desc(aiRuns.at))
      .limit(Math.min(Math.max(limit, 1), 100));
  }

  private async prune(): Promise<void> {
    try {
      await this.db.delete(aiRuns).where(
        lt(
          aiRuns.at,
          sql`(select min(at) from (select at from ${aiRuns} order by at desc limit ${RETAIN_RUNS}))`,
        ),
      );
    } catch {
      // Same reason as above.
    }
  }
}
