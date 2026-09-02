import { randomUUID } from 'node:crypto';
import { asc, desc, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { aiRunExchanges, aiRuns } from '../db/schema.js';
// Type-only, so the Anthropic SDK is not pulled into the core graph.
import type { AgentExchange, AgentStep } from '../ai/agent.js';
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

/**
 * How long a recorded round is kept, and how many are kept at all — two
 * bounds, whichever bites first, the rule the activity log and the reading
 * history both follow.
 *
 * The age bound is the one that matters here: somebody switches recording on
 * because something is wrong *now*, and a week later the answer is either
 * found or no longer interesting. The row cap is the disk's bound behind it,
 * because "a week" says nothing about how many runs a home had in it.
 */
const RETAIN_EXCHANGE_DAYS = 7;
const RETAIN_EXCHANGES = 1000;

/**
 * `automate` is a *conversation* rather than a one-shot run, and it is in this
 * list on purpose: what a home spent on AI is one question, and splitting
 * device recognition from rule-writing into two tables would make it two
 * screens. Such a row leaves `exposesHash` empty and fills `automationId`.
 */
export type AiRunKind = 'map' | 'repair' | 'automate';

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

/** What one conversation has cost so far, and what was answering by the end
 *  of it. Summed across the rows a conversation wrote; see `spendBySession`. */
export interface SessionSpend {
  /** US dollars, estimated from token usage at the price of the day. */
  usd: number;
  /** anthropic | openai, as recorded. */
  provider: string;
  /** The model id as recorded — read back, never re-derived. */
  modelId: string;
}

export interface AiRunStart {
  kind: AiRunKind;
  adapter: string;
  exposesHash: string;
  vendor?: string | undefined;
  model?: string | undefined;
  /** anthropic | openai. Absent on rows written before the second provider. */
  provider?: string | undefined;
  modelId?: string | undefined;
  /**
   * The rule a conversation produced or edited, on an `automate` row.
   *
   * The column and the sentence above it both existed and nothing ever wrote
   * it, so the one link from a spend row back to what it bought was NULL on
   * every hub. Absent on a mapping run, which is about a device model rather
   * than a rule, and absent on a conversation that never submitted one.
   */
  automationId?: string | undefined;
  /**
   * The conversation an `automate` row belongs to.
   *
   * What makes a conversation's own spend answerable: `automationId` is null
   * for a chat that submitted nothing, and a revived one writes a row per
   * incarnation, so nothing else could total them.
   */
  sessionId?: string | undefined;
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
  /**
   * One request/response round, when the owner asked for them to be kept.
   *
   * Held in memory and written with the run in `finish()`, never per round:
   * a round lands every few seconds during a run, and one write per round is
   * the `STATE_FLUSH_MS` mistake with a different name.
   */
  exchange(exchange: AgentExchange): void;
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
    const exchanges: AgentExchange[] = [];
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
      exchange(exchange) {
        exchanges.push(exchange);
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
            provider: input.provider ?? null,
            modelId: input.modelId ?? null,
            automationId: input.automationId ?? null,
            sessionId: input.sessionId ?? null,
            ok: outcome.ok,
            costUsd: outcome.costUsd ?? null,
            turns: outcome.turns ?? null,
            durationMs: outcome.durationMs ?? Date.now() - startedAt,
            errorKind: outcome.errorKind ?? null,
            errorMessage: outcome.errorMessage?.slice(0, 500) ?? null,
            steps,
          });
          if (exchanges.length > 0) {
            // After the run row, because the rows point at it — and in one
            // insert, because a round is not worth a transaction of its own.
            await log.db.insert(aiRunExchanges).values(
              exchanges.map((entry) => ({
                runId: id,
                seq: entry.seq,
                at: new Date(entry.at),
                durationMs: entry.durationMs,
                provider: entry.provider,
                modelId: entry.modelId,
                status: entry.status ?? null,
                ok: entry.ok,
                inputTokens: entry.inputTokens ?? null,
                outputTokens: entry.outputTokens ?? null,
                sent: entry.sent,
                received: entry.received,
              })),
            );
            await log.pruneExchanges();
          }
        } catch {
          // A run that happened and could not be written down is still a run
          // that happened — never let bookkeeping fail the adoption it
          // describes.
        }
      },
    };
  }

  /** The rounds of one run, oldest first — a failed attempt and the one that
   *  followed it read in the order they happened. */
  async exchangesOf(runId: string) {
    return this.db
      .select()
      .from(aiRunExchanges)
      .where(eq(aiRunExchanges.runId, runId))
      .orderBy(asc(aiRunExchanges.seq));
  }

  /** How many rounds each of these runs has recorded, so a list can say
   *  whether there is anything to open without fetching any of it. */
  async exchangeCounts(runIds: string[]): Promise<Map<string, number>> {
    if (runIds.length === 0) return new Map();
    // Narrowed in the query rather than after it: the runs asked about are one
    // page of a list, and counting every row this table holds to answer for
    // thirty of them is work nobody asked for.
    const rows = await this.db
      .select({ runId: aiRunExchanges.runId, n: sql<number>`count(*)` })
      .from(aiRunExchanges)
      .where(inArray(aiRunExchanges.runId, runIds))
      .groupBy(aiRunExchanges.runId);
    return new Map(rows.map((row) => [row.runId, Number(row.n)]));
  }

  /**
   * What each conversation has cost, and what answered it.
   *
   * **The ledger is bounded and the transcript is not**, so this is a `Map`
   * with holes in it rather than a number per chat: `ai_runs` keeps the last
   * `RETAIN_RUNS` runs of every kind while `automation_chat_messages` keeps a
   * fortnight, and a home that has recognised a few devices since can easily
   * have a readable conversation whose spend row is gone. A caller reports
   * that as *absent* — the `GET /system/update` rule, where `available` is
   * missing rather than false when the hub cannot tell — never as $0.00,
   * which is a claim.
   *
   * **A conversation is several rows.** One is written when it submits a rule
   * and another when it ends, and a revived one writes a row per incarnation,
   * each carrying the delta rather than a running total — so the cost is a sum
   * and the model is the *newest* row's, since a home that switched providers
   * between two of them ran the later half somewhere else.
   *
   * Both names are read back exactly as they were stored and never
   * re-derived: `effectiveModel` answers "what will run" and moves with the
   * offered list, which is the opposite of what a record of a run that already
   * happened may do.
   */
  async spendBySession(): Promise<Map<string, SessionSpend>> {
    const rows = await this.db
      .select({
        sessionId: aiRuns.sessionId,
        costUsd: aiRuns.costUsd,
        provider: aiRuns.provider,
        modelId: aiRuns.modelId,
      })
      .from(aiRuns)
      .where(isNotNull(aiRuns.sessionId))
      .orderBy(asc(aiRuns.at));

    const spend = new Map<string, SessionSpend>();
    for (const row of rows) {
      if (row.sessionId === null) continue;
      // `session_id`, `provider` and `model_id` arrived in one change, so a
      // row carrying the first carries the other two. Skipping one that
      // somehow does not is deliberate: a figure with no model beside it
      // answers half the question it was asked.
      if (row.provider === null || row.modelId === null) continue;
      const running = spend.get(row.sessionId);
      spend.set(row.sessionId, {
        usd: (running?.usd ?? 0) + (row.costUsd ?? 0),
        provider: row.provider,
        modelId: row.modelId,
      });
    }
    return spend;
  }

  async list(limit = 30) {
    return this.db
      .select()
      .from(aiRuns)
      .orderBy(desc(aiRuns.at))
      .limit(Math.min(Math.max(limit, 1), 100));
  }

  /**
   * Two bounds, whichever bites first. Hung off a write like every other
   * prune here, so a hub nobody is debugging never wakes to run it — and a
   * failure is swallowed for the reason the run write's is: bookkeeping must
   * not be what ends a run.
   */
  private async pruneExchanges(): Promise<void> {
    try {
      const oldest = new Date(Date.now() - RETAIN_EXCHANGE_DAYS * 24 * 60 * 60 * 1000);
      await this.db.delete(aiRunExchanges).where(lt(aiRunExchanges.at, oldest));
      await this.db.delete(aiRunExchanges).where(
        lt(
          aiRunExchanges.at,
          sql`(select min(at) from (select at from ${aiRunExchanges} order by at desc limit ${RETAIN_EXCHANGES}))`,
        ),
      );
    } catch {
      // Same reason as `prune`.
    }
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
