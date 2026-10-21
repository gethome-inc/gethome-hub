import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ActivityService } from './activity.js';
import type { HubEventBus } from './bus.js';
import { QuietHours } from './quiet-hours.js';
import type { SettingsService } from './settings.js';
import {
  canApplyUpdate,
  fetchHead as fetchHeadFromGitHub,
  parseBuild,
  readUpdateRun,
  requestUpdate,
  sameCommit,
  type HeadCommit,
} from './update.js';
import type { Logger } from '../logging.js';
import { MIN_PLAUSIBLE_CLOCK, timeOfDayIn } from '../automations/evaluate.js';

/**
 * A hub that updates itself, when its home has said it may — at an hour the
 * home is quiet, and only once nobody is about.
 *
 * **Off unless somebody turned it on.** Every hub, new or old, behaves as it
 * always has until a person with `hub.update` switches this on from an app:
 * a hub installed from a branch on a developer's desk, or one somebody
 * deliberately keeps on the build they know, must not move under them, and an
 * app built before this existed has no way to say no to it.
 *
 * **It asks for an update exactly the way a person does** — `requestUpdate`
 * writes the one line the root runner is waiting for — so the installer, the
 * health check and the automatic rollback are the same on every path, and no
 * privilege moves into this process. What is new is only *when*:
 *
 *  - **Inside the home's quiet window** (`QuietHours`): the two hours this
 *    home has asked the least of the hub over the last fortnight, or 03:00 to
 *    05:00 home time until there are three days to go on.
 *  - **Only once nothing is happening**: nobody has asked for anything for
 *    half an hour, no rule is mid-run, none is due in the next twenty minutes,
 *    and nobody is pairing a device. Any of those postpones to the next look,
 *    five minutes later, until the window closes — and then to the next night.
 *  - **Only a build that has been on `main` for a day.** Merging is releasing,
 *    and without a soak every hub that updates itself would carry a bad merge
 *    into its home the same night. A `main` that never sits still for a day
 *    stops being waited for after a week behind, and even then a build gets
 *    two hours, which is CI publishing its bundle.
 *  - **Never a build that put itself back here**, and no build more than
 *    three times: a nightly update that rolls back is a home that restarts
 *    every night for nothing.
 *  - **Never a branch build**, whatever the switch says. `--branch` is
 *    somebody testing something on purpose, and the runner only ever installs
 *    `main` — so an automatic update there would undo the test.
 *
 * **It says so before it does it.** The bookkeeping and the activity row are
 * written before the request, because the request is what restarts this
 * process — the order `radio-pressure.ts` keeps for the same reason. A
 * postponement is not written to the activity log: a feed with "the hub
 * waited" in it every night is noise, and `describe()` already answers "why
 * hasn't my hub updated" for anybody who looks.
 */

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** How often the hub looks at the clock. Outside the window a look is one comparison. */
const TICK_MS = 5 * MINUTE_MS;

/** How long nobody must have asked for anything before the hub goes away. */
export const QUIET_FOR_MS = 30 * MINUTE_MS;

/** How far ahead a scheduled rule keeps the hub waiting: an update's downtime, with room. */
export const RULE_DUE_MS = 20 * MINUTE_MS;

/** How long a build must have been on `main` before a hub installs it by itself. */
export const SOAK_MS = DAY_MS;

/** How long a hub stays behind a `main` that never sits still before it stops waiting for one that does. */
export const BEHIND_FOR_MS = 7 * DAY_MS;

/** What even a hub that stopped waiting gives a build: long enough for CI to publish its bundle. */
export const CI_MARGIN_MS = 2 * HOUR_MS;

/** How many times one build is tried by itself without landing. */
export const MAX_ATTEMPTS = 3;

/** How soon a check GitHub did not answer is asked again, inside one window. */
const RETRY_UNANSWERED_MS = 30 * MINUTE_MS;

/** One request a night: a window is two hours, so this is the next one. */
const ONE_A_NIGHT_MS = 20 * HOUR_MS;

/** How many builds that put themselves back are remembered. */
const ROLLED_BACK_KEPT = 10;

/** The step a window's edges are looked for in — fine enough for a timezone :30 or :45 off UTC. */
const WINDOW_STEP_MS = 15 * MINUTE_MS;

const ENABLED_KEY = 'update_automatic';
const STATE_KEY = 'update_automatic_state';

/** Why automatic updates cannot run on this hub, even switched on. */
export type AutoUpdateBlock = 'unsupported' | 'branch_build' | 'no_build_stamp';

/** What the hub decided the last time it looked inside its window. */
export type AutoUpdateOutcome = 'started' | 'up_to_date' | 'postponed' | 'waiting' | 'skipped';

/**
 * `automatic` on `GET /system/update`: the switch, why it cannot run, when it
 * next may, and what it last decided. Every field but `enabled` is optional,
 * and both apps read the words in it as open strings.
 */
export interface AutomaticUpdates {
  enabled: boolean;
  blocked?: AutoUpdateBlock;
  /** The window the hub is in, or will next be in. Absent while off or blocked. */
  window?: { from: string; to: string };
  /** Whether that window was learned from this home, or is the default night. */
  learned?: boolean;
  last?: { at: string; outcome: AutoUpdateOutcome; reason?: string; until?: string };
}

/**
 * The bookkeeping, stored as a setting. Read tolerantly: a field a later build
 * adds is dropped rather than refusing the whole record, and a record this
 * build cannot read at all starts again empty.
 */
const stateSchema = z.object({
  /** The run this hub last asked for by itself. */
  request: z.object({ id: z.string(), sha: z.string(), at: z.number() }).optional(),
  /** Builds that put themselves back here, and are never tried by itself again. */
  rolledBack: z.array(z.string()).optional(),
  /** How many times one build has been tried by itself. */
  attempts: z.object({ sha: z.string(), count: z.number().int().nonnegative() }).optional(),
  /** When this hub, switched on, first saw itself behind `main`. */
  behindSince: z.number().optional(),
  last: z
    .object({
      at: z.number(),
      outcome: z.string(),
      reason: z.string().optional(),
      until: z.number().optional(),
    })
    .optional(),
});

type AutoState = z.infer<typeof stateSchema>;
type Last = NonNullable<AutoState['last']>;

/** The rules, as much of them as an update has to stay out of the way of. */
export interface UpdateRuleView {
  hasRunInFlight(): boolean;
  scheduledWithin(now: number, horizonMs: number): boolean;
  scheduledHours(): readonly number[];
}

export interface AutoUpdateDeps {
  dataDir: string;
  /** The running build's stamp, from `VERSION`; undefined for a build from source. */
  build: string | undefined;
  settings: Pick<SettingsService, 'get' | 'set' | 'unset'>;
  /** The home's timezone, asked each time — it can be changed while the hub runs. */
  timezone: () => string;
  activity: Pick<ActivityService, 'record' | 'lastAskedAt'>;
  events: HubEventBus;
  rules: UpdateRuleView;
  /** Somebody standing in front of a device: a Matter pairing, an open join window. */
  busy?: () => boolean;
  log: Logger;
  now?: () => number;
  fetchHead?: () => Promise<HeadCommit>;
  intervalMs?: number;
  /** How often what `QuietHours` counted is written. */
  flushMs?: number;
}

export interface AutoUpdater {
  /** Read the switch and the bookkeeping. Awaited before the API listens. */
  load(): Promise<void>;
  /** Start counting and looking at the clock. After the rules have started. */
  start(): void;
  stop(): Promise<void>;
  /** One look at the clock. Public so a test can drive a night without one. */
  tick(): Promise<void>;
  readonly enabled: boolean;
  /** The run the hub last asked for by itself, so its outcome row says so. */
  automaticRunId(): string | undefined;
  /** What `GET /system/update` answers as `automatic`. Never throws. */
  describe(): AutomaticUpdates;
  /** Switch it. Returns the new answer. */
  setEnabled(on: boolean): Promise<AutomaticUpdates>;
}

export function createAutoUpdater(deps: AutoUpdateDeps): AutoUpdater {
  const now = deps.now ?? (() => Date.now());
  const fetchHead = deps.fetchHead ?? (() => fetchHeadFromGitHub(now()));
  const quiet = new QuietHours({
    settings: deps.settings,
    events: deps.events,
    activity: deps.activity,
    log: deps.log,
    now,
    ...(deps.flushMs !== undefined ? { flushMs: deps.flushMs } : {}),
  });

  let enabled = false;
  let state: AutoState = {};
  let timer: ReturnType<typeof setInterval> | undefined;
  let looking = false;
  /** When GitHub last failed to answer, so a window asks again half-hourly rather than every look. */
  let unansweredAt: number | undefined;
  /** The window last worked out, kept until it has passed or the plan moves. */
  let planned: { key: string; from: number; to: number; learned: boolean } | undefined;

  async function save(next: AutoState): Promise<void> {
    state = next;
    await deps.settings.set(STATE_KEY, next);
  }

  /** Remember what was decided. Written only when the decision changes, never per look. */
  async function decide(last: Omit<Last, 'at'>, patch: Partial<AutoState> = {}): Promise<void> {
    const changed =
      state.last?.outcome !== last.outcome ||
      state.last?.reason !== last.reason ||
      state.last?.until !== last.until ||
      Object.entries(patch).some(([key, value]) => state[key as keyof AutoState] !== value);
    const next: AutoState = { ...state, ...patch, last: { at: now(), ...last } };
    if (!changed) {
      state = next;
      return;
    }
    try {
      await save(next);
    } catch (error) {
      state = next;
      deps.log.warn({ err: error }, 'Could not save what the automatic update decided');
    }
  }

  function blockedReason(): AutoUpdateBlock | undefined {
    if (!canApplyUpdate(deps.dataDir)) return 'unsupported';
    const current = parseBuild(deps.build);
    if (current === undefined) return 'no_build_stamp';
    if (current.channel !== 'main') return 'branch_build';
    return undefined;
  }

  /**
   * The window the hub is in, or the next one — as absolute times.
   *
   * Found by walking the clock in quarter hours through the home's timezone
   * rather than by arithmetic on an offset, so summer time and a zone half an
   * hour off UTC need no special case: the window opens where the home's own
   * clock first reads its hour.
   */
  function plan(at: number): { from: number; to: number; learned: boolean } | undefined {
    const timezone = deps.timezone();
    const window = quiet.window(timezone, deps.rules.scheduledHours());
    const key = `${timezone}|${window.startHour}|${window.hours}`;
    if (planned !== undefined && planned.key === key && at < planned.to) {
      return { ...planned, learned: window.learned };
    }
    const length = window.hours * HOUR_MS;
    const opens = `${String(window.startHour).padStart(2, '0')}:00`;
    const first = Math.floor((at - length) / WINDOW_STEP_MS) * WINDOW_STEP_MS;
    for (let step = first; step < at + 2 * DAY_MS; step += WINDOW_STEP_MS) {
      if (step + length <= at) continue;
      if (timeOfDayIn(timezone, step) !== opens) continue;
      planned = { key, from: step, to: step + length, learned: window.learned };
      return planned;
    }
    // An hour this zone skips for summer time, every day for two days, is not
    // a zone that exists; a window nobody can place is no window.
    return undefined;
  }

  async function look(): Promise<void> {
    const at = now();
    if (at < MIN_PLAUSIBLE_CLOCK) return;
    if (blockedReason() !== undefined) return;
    const window = plan(at);
    if (window === undefined || at < window.from || at >= window.to) return;
    if (state.request !== undefined && at - state.request.at < ONE_A_NIGHT_MS) return;
    if (unansweredAt !== undefined && at - unansweredAt < RETRY_UNANSWERED_MS) return;

    // Everything that can say "not now" without leaving the house is asked
    // before GitHub is: there is no point learning a build exists at an
    // hour the hub would not install it.
    if (readUpdateRun(deps.dataDir, at)?.state === 'running') {
      return decide({ outcome: 'postponed', reason: 'update_running' });
    }
    const lastUse = quiet.lastUseAt();
    if (lastUse !== undefined && at - lastUse < QUIET_FOR_MS) {
      return decide({ outcome: 'postponed', reason: 'in_use' });
    }
    if (deps.busy?.() === true) return decide({ outcome: 'postponed', reason: 'pairing' });
    if (deps.rules.hasRunInFlight()) return decide({ outcome: 'postponed', reason: 'rule_running' });
    if (deps.rules.scheduledWithin(at, RULE_DUE_MS)) {
      return decide({ outcome: 'postponed', reason: 'rule_due' });
    }

    const head = await fetchHead();
    if (head.sha === undefined || head.committedAt === undefined) {
      unansweredAt = at;
      return decide({ outcome: 'postponed', reason: head.error ?? 'offline' });
    }
    unansweredAt = undefined;

    const current = parseBuild(deps.build);
    if (current === undefined) return;
    if (sameCommit(current.sha, head.sha)) {
      return decide({ outcome: 'up_to_date' }, { behindSince: undefined });
    }

    const behindSince = state.behindSince ?? at;
    const age = at - head.committedAt;
    const stoppedWaiting = at - behindSince >= BEHIND_FOR_MS;
    const oldEnough = stoppedWaiting ? age >= CI_MARGIN_MS : age >= SOAK_MS;
    if (!oldEnough) {
      return decide(
        { outcome: 'waiting', until: head.committedAt + (stoppedWaiting ? CI_MARGIN_MS : SOAK_MS) },
        { behindSince },
      );
    }
    const headSha = head.sha;
    if (state.rolledBack?.some((sha) => sameCommit(sha, headSha)) === true) {
      return decide({ outcome: 'skipped', reason: 'rolled_back' }, { behindSince });
    }
    const tried =
      state.attempts !== undefined && sameCommit(state.attempts.sha, headSha) ? state.attempts.count : 0;
    if (tried >= MAX_ATTEMPTS) {
      return decide({ outcome: 'skipped', reason: 'too_many_attempts' }, { behindSince });
    }

    // ── Go ─────────────────────────────────────────────────────────────────
    // Written down first, all of it: the request restarts this process, and
    // an attempt counted afterwards is one a runner that never comes back
    // would never have counted.
    const id = randomUUID();
    await save({
      ...state,
      request: { id, sha: headSha, at },
      attempts: { sha: headSha, count: tried + 1 },
      behindSince,
      last: { at, outcome: 'started' },
    });
    try {
      await deps.activity.record({
        kind: 'hub.update',
        // No member: nobody pressed anything, and an app that knows nothing of
        // automatic updates shows this sentence as it is.
        message: window.learned
          ? 'The hub started updating itself, at an hour this home is usually quiet.'
          : 'The hub started updating itself overnight.',
        data: {
          outcome: 'auto-started',
          automatic: true,
          ...(deps.build !== undefined ? { fromBuild: deps.build } : {}),
          toSha: headSha,
        },
      });
    } catch (error) {
      // The update matters more than the announcement of it — the radio
      // watch's rule — and the outcome is written at the next boot either way.
      deps.log.warn({ err: error }, 'Could not write the automatic update into the activity log');
    }
    deps.log.info({ id, sha: headSha }, 'Starting an automatic update');
    try {
      requestUpdate(deps.dataDir, id);
    } catch (error) {
      // A full card, most likely. The attempt is already counted, so a hub
      // that cannot write its own request stops asking after three nights.
      deps.log.error({ err: error }, 'Could not ask for the automatic update');
      await decide({ outcome: 'postponed', reason: 'request_failed' });
    }
  }

  /**
   * What became of the run the hub asked for by itself, now that this process
   * is back to ask. Only a rollback needs writing down — attempts were counted
   * when the request was made.
   */
  async function reconcile(): Promise<void> {
    const request = state.request;
    if (request === undefined) return;
    const run = readUpdateRun(deps.dataDir, now());
    if (run === undefined || run.id !== request.id || run.state !== 'rolled-back') return;
    if (state.rolledBack?.some((sha) => sameCommit(sha, request.sha)) === true) return;
    await save({
      ...state,
      rolledBack: [...(state.rolledBack ?? []), request.sha].slice(-ROLLED_BACK_KEPT),
    });
    deps.log.warn(
      { sha: request.sha },
      'An automatic update put itself back; that build will not be tried by itself again',
    );
  }

  function iso(at: number): string {
    return new Date(at).toISOString();
  }

  async function tick(): Promise<void> {
    if (!enabled || looking) return;
    looking = true;
    try {
      await look();
    } catch (error) {
      deps.log.warn({ err: error }, 'The automatic update check failed');
    } finally {
      looking = false;
    }
  }

  function describe(): AutomaticUpdates {
    try {
      const blocked = blockedReason();
      const at = now();
      const window = enabled && blocked === undefined && at >= MIN_PLAUSIBLE_CLOCK ? plan(at) : undefined;
      const last = enabled ? state.last : undefined;
      return {
        enabled,
        ...(blocked !== undefined ? { blocked } : {}),
        ...(window !== undefined
          ? { window: { from: iso(window.from), to: iso(window.to) }, learned: window.learned }
          : {}),
        ...(last !== undefined
          ? {
              last: {
                at: iso(last.at),
                outcome: last.outcome as AutoUpdateOutcome,
                ...(last.reason !== undefined ? { reason: last.reason } : {}),
                ...(last.until !== undefined ? { until: iso(last.until) } : {}),
              },
            }
          : {}),
      };
    } catch {
      return { enabled };
    }
  }

  return {
    async load() {
      try {
        enabled = (await deps.settings.get<boolean>(ENABLED_KEY)) === true;
      } catch (error) {
        deps.log.warn({ err: error }, 'Could not read whether automatic updates are on');
      }
      try {
        const parsed = stateSchema.safeParse(await deps.settings.get<unknown>(STATE_KEY));
        state = parsed.success ? parsed.data : {};
      } catch {
        state = {};
      }
      await quiet.load();
      try {
        // The switch and the record of when the home is used are one decision
        // stored in two rows; a crash between the two writes is put right here.
        if (enabled && !quiet.recording) await quiet.begin();
        if (!enabled && quiet.recording) await quiet.end();
        await reconcile();
      } catch (error) {
        deps.log.warn({ err: error }, 'Could not settle the automatic update bookkeeping');
      }
    },

    start() {
      if (timer !== undefined) return;
      quiet.start();
      timer = setInterval(() => {
        void tick();
      }, deps.intervalMs ?? TICK_MS);
      // A look at the clock is never the reason the process stays up.
      timer.unref?.();
    },

    async stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      await quiet.stop();
    },

    tick,

    get enabled() {
      return enabled;
    },

    automaticRunId() {
      return state.request?.id;
    },

    describe,

    async setEnabled(on) {
      if (on !== enabled) {
        if (on) await deps.settings.set(ENABLED_KEY, true);
        else await deps.settings.unset(ENABLED_KEY);
        enabled = on;
        // Either way a fresh start: what the hub learned and what it last
        // decided belong to the stretch that just ended. What it knows about
        // *builds* — the ones that put themselves back — stays true.
        if (on) await quiet.begin();
        else await quiet.end();
        const kept: AutoState = { ...state };
        delete kept.behindSince;
        delete kept.last;
        await save(kept);
        planned = undefined;
        unansweredAt = undefined;
      }
      return describe();
    },
  };
}
