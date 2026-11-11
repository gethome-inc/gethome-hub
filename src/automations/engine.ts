import { randomUUID } from 'node:crypto';
import type { EndpointState, HubCommand } from '../schema/index.js';
import type { AutomationRunEvent, CommandFailure, HubEventBus } from '../core/bus.js';
import { formatDuration } from './phrasing.js';
import {
  narrateCommand,
  narrateEventCause,
  narrateFailure,
  narrateRefusal,
  narrateSentWhileOffline,
  narrateStateCause,
  type NarratedDevice,
} from './narrate.js';
import { AutomationStatusBook, type AutomationStatus, type NotedRun } from './status.js';
import { isToggle } from './schema.js';
import type { ActivityService } from '../core/activity.js';
import type { Logger } from '../logging.js';
import {
  commandCapability,
  type AutomationAction,
  type AutomationDocument,
  type AutomationTrigger,
} from './schema.js';
import {
  compare,
  dayOfWeekIn,
  evaluateConditions,
  evaluateEdge,
  MIN_PLAUSIBLE_CLOCK,
  nextScheduleAt,
  readPath,
  timeOfDayIn,
  type ConditionContext,
  type EdgeState,
} from './evaluate.js';
import { AutomationGuards, type CommandOrigin, type GuardLimits } from './guards.js';
import { describeTarget, resolveTarget, type AutomationDeviceView, type AutomationHomeView } from './targets.js';
import {
  MAX_RUN_STEPS,
  type AutomationRecord,
  type AutomationRunStep,
  type AutomationStore,
  type UnreadableAutomation,
} from './store.js';

/**
 * The thing that actually runs the home.
 *
 * Hung off the bus rather than wired into `DeviceRegistry`, the shape
 * `HistoryService` established: nothing on the report path changes, the
 * registry does not learn that automations exist, and a home with no rules
 * pays one map lookup per state report and nothing else. That last part is
 * the `MqttObserver` stance and it is deliberate — the report path is the
 * hottest thing in the hub.
 *
 * Four rules that are easy to get wrong and expensive to get wrong:
 *
 *  - **Nothing here touches the disk on the report path.** Evaluation is
 *    field reads and comparisons. A trace is written after a rule has decided
 *    to run, which is rare by construction.
 *  - **The clock is injected.** Everything in a scheduler is a decision about
 *    time, and a module that reads `Date.now()` can only be tested by waiting.
 *  - **A missed schedule is not made up.** The tick fires only for the minute
 *    it is currently in. A heater told to come on at seven does not come on at
 *    nine because the power was out — see `runSchedules`.
 *  - **A `wait` does not survive a restart.** The run is abandoned and
 *    recorded as `interrupted`; the alternative is persisting continuations
 *    and re-validating them against a schema a new build may have moved, for
 *    a case a schedule trigger already covers.
 */

/** How often the scheduler looks at the clock. Three ticks inside any minute,
 *  so a `schedule` cannot be stepped over, and cheap enough to `unref`. */
const TICK_MS = 20_000;

/** Queued runs held for one rule in `queued` mode, before new ones are dropped. */
const MAX_QUEUED = 5;

/**
 * How often what the engine remembers about each rule is written down.
 * `STATE_FLUSH_MS`'s argument: a motion rule fires all day, and a count that
 * is a minute behind after a power cut costs nobody anything.
 */
const STATUS_FLUSH_MS = 60_000;

/**
 * The most often one rule's status is announced. A rule can fire every few
 * seconds; an app drawing "ran a moment ago" needs the first of those at once
 * and the rest as one catch-up, not a frame each.
 */
const STATUS_NOTIFY_MS = 10_000;

/**
 * How long after a command went out a radio's word that it never landed is
 * still about that command. Zigbee2MQTT gives a write about ten seconds
 * before it reports the device unreachable; a minute covers a busy network
 * without pinning yesterday's failure on this morning's run.
 */
const LATE_FAILURE_MS = 60_000;

/** The registry, as much of it as this module needs. Structural on purpose:
 *  the engine is testable against a fake, and `DeviceRegistry` stays unaware. */
export interface EngineRegistry {
  listDevices(): readonly {
    id: string;
    name: string;
    roomId: string | null;
    online: boolean;
    endpoints: readonly {
      endpointId: number;
      deviceKind: AutomationDeviceView['endpoints'][number]['deviceKind'];
      capabilities: readonly AutomationDeviceView['endpoints'][number]['capabilities'][number][];
      state: EndpointState;
    }[];
  }[];
  execute(deviceId: string, endpointId: number, command: HubCommand): Promise<void>;
}

export interface EngineStructure {
  rooms: readonly { id: string; name: string; zoneId: string | null }[];
  zones: readonly { id: string; name: string }[];
}

export interface AutomationEngineOptions {
  store: AutomationStore;
  registry: EngineRegistry;
  events: HubEventBus;
  activity: ActivityService;
  log: Logger;
  /** Rooms and zones, read when the home changes rather than per report. */
  readStructure: () => Promise<EngineStructure>;
  /** The home's timezone, for `schedule` and `timeRange`. */
  timezone: () => string;
  now?: () => number;
  guardLimits?: Partial<GuardLimits>;
  /** `STATUS_NOTIFY_MS`, for a test that cannot wait ten seconds. */
  statusNotifyMs?: number;
}

interface RunHandle {
  cancelled: boolean;
  promise: Promise<void>;
  queued: number;
}

/**
 * Who pressed a button or switched a mode, for the one activity row a manual
 * run writes.
 *
 * More than a name, because the row is somebody's. `memberId` is what lets a
 * member without `activity.read` still find their own press in the feed, and
 * `data` is how they did it — through an API key, `via: "api"` with the key's
 * id and name, the rule every other row a key causes already keeps. It used
 * to be the name alone, so a scene a script pressed was a sentence and nothing
 * an app could attribute.
 */
export interface AutomationPresser {
  /** The sentence's subject: "Anna", or "Anna’s “Node-RED”" through a key. */
  name: string;
  memberId?: string;
  data?: Record<string, unknown>;
}

interface FireOptions {
  manual?: boolean;
  useOffActions?: boolean;
  by?: AutomationPresser;
  /** The cause in the hub's exact terms — `narrate.ts`. */
  causeDetail?: string;
  /**
   * The whole sentence the activity log gets for a manual run: "Anna pressed
   * Leaving". The run's own `cause` answers a different question — what set
   * this rule off, read under the rule's name — and is "Pressed by Anna".
   */
  sentence?: string;
}

/**
 * One run, for as long as something may still have to be said about it.
 *
 * **A command that reached the protocol is not a command that reached the
 * device.** `registry.execute` resolves when the radio has *taken* a write —
 * for Zigbee, when the broker has — and the word that it never landed comes
 * seconds later, as a `commandFailed`, often after the run has ended and been
 * written down as fine. This is what that word is matched back to: the trace
 * while the run is still going (corrected in place), and once it is written,
 * how it was counted and the write a correction has to land behind.
 */
interface RunLedger {
  automationId: string;
  runId: string;
  /** The trace while the run is going; gone once it has been handed over. */
  steps?: AutomationRunStep[] | undefined;
  /** A failure that arrived while the run was going, for its own report. */
  lateProblem?: string;
  /** How the run was written down, once it was. */
  reported?: NotedRun;
  /** The trace being written, so a correction is not lost to the race. */
  recorded?: Promise<void>;
}

/** The last command a rule sent one device, until its fate is known or stale. */
interface SentCommand {
  ledger: RunLedger;
  command: HubCommand;
  /** The step that says it went out — the one a failure replaces. */
  step: AutomationRunStep;
  at: number;
}

/** How one firing ended, as `report` is told it. */
interface RunReport {
  /** The run's ledger, when it got as far as its actions. */
  ledger?: RunLedger;
  steps?: AutomationRunStep[];
  commands?: number;
  refused?: number;
  /** The first refusal in the hub's own terms — the live frame's `detail`. */
  detail?: string | undefined;
  /** Why it was skipped, or the first thing that went wrong, as a sentence. */
  reason?: string | undefined;
  /** Whether anything asked for did not happen. */
  problem?: boolean;
  startedAt?: number;
}

export class AutomationEngine {
  private readonly guards: AutomationGuards;
  private readonly now: () => number;

  private records: AutomationRecord[] = [];
  private unreadable: UnreadableAutomation[] = [];
  private structure: EngineStructure = { rooms: [], zones: [] };

  /** `automationId:triggerIndex:deviceId` → what the test said last time. */
  private readonly edges = new Map<string, EdgeState>();
  /** Pending `for` holds, keyed the same way. */
  private readonly holds = new Map<string, ReturnType<typeof setTimeout>>();
  /** `automationId:triggerIndex` → when a schedule or interval last fired. */
  private readonly lastFired = new Map<string, number>();
  /** Which devices any enabled rule is watching — the report path's whole cost. */
  private watched = new Set<string>();
  private readonly running = new Map<string, RunHandle>();
  /** Runs nobody is awaiting — see `detach`. */
  private readonly detached = new Set<Promise<void>>();

  /** Per device: the last command a rule sent it — see `RunLedger`. */
  private readonly sentCommands = new Map<string, SentCommand>();
  /** Whether each rule is working — `status.ts`. */
  private readonly book: AutomationStatusBook;
  private lastStatusFlush = 0;
  /** Per rule: when its status was last announced, and a catch-up if one is owed. */
  private readonly announced = new Map<string, { at: number; timer?: ReturnType<typeof setTimeout> }>();

  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private warnedAboutClock = false;

  constructor(private readonly options: AutomationEngineOptions) {
    this.now = options.now ?? (() => Date.now());
    this.guards = new AutomationGuards(this.now, options.guardLimits ?? {});
    this.book = new AutomationStatusBook(this.now, options.timezone);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.book.restore(await this.options.store.loadStatus());
    await this.reload();
    this.options.events.on('stateChanged', this.onStateChanged);
    this.options.events.on('deviceUpserted', this.onHomeMoved);
    this.options.events.on('deviceRemoved', this.onDeviceRemoved);
    this.options.events.on('structureChanged', this.onHomeMoved);
    this.options.events.on('commandFailed', this.onCommandFailed);

    this.timer = setInterval(() => {
      void this.tick();
      if (Date.now() - this.lastStatusFlush >= STATUS_FLUSH_MS) void this.flushStatus();
    }, TICK_MS);
    // Never the reason a quiet hub stays awake — the same `unref` the
    // registry's flush timer and the history service's both carry.
    this.timer.unref?.();
    this.started = true;
    this.options.log.info(
      `Automations: ${this.records.filter((entry) => entry.enabled).length} enabled, ` +
        `${this.records.length} in total.`,
    );
    if (this.unreadable.length > 0) {
      this.options.log.warn(
        `${this.unreadable.length} automation(s) were written by a newer build and are not running.`,
      );
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const hold of this.holds.values()) clearTimeout(hold);
    this.holds.clear();
    for (const entry of this.announced.values()) clearTimeout(entry.timer);
    this.announced.clear();
    this.options.events.off('stateChanged', this.onStateChanged);
    this.options.events.off('deviceUpserted', this.onHomeMoved);
    this.options.events.off('deviceRemoved', this.onDeviceRemoved);
    this.options.events.off('structureChanged', this.onHomeMoved);
    this.options.events.off('commandFailed', this.onCommandFailed);
    this.sentCommands.clear();
    // Anything mid-`wait` is abandoned rather than resumed. Its trace already
    // says `interrupted`, which is the honest word for it.
    for (const handle of this.running.values()) handle.cancelled = true;
    await Promise.allSettled([...this.running.values()].map((handle) => handle.promise));
    this.running.clear();
    await this.settled();
    // After the runs have drained, so the last of them is in what is written.
    await this.flushStatus();
  }

  /** Re-read everything from the store. Called after any write. */
  async reload(): Promise<void> {
    const [{ records, unreadable }, structure] = await Promise.all([
      this.options.store.load(),
      this.options.readStructure(),
    ]);
    this.records = records;
    this.unreadable = unreadable;
    this.structure = structure;
    this.book.keepOnly(new Set([...records, ...unreadable].map((entry) => entry.id)));
    this.rebuildWatchers();
  }

  // ── Whether a rule is working ──────────────────────────────────────────────

  /**
   * What an app is told about one rule beside the rule itself: when it last
   * ran and how that went, today's count, the last problem, and — worked out
   * here rather than remembered — when a rule on a clock fires next.
   */
  statusOf(id: string): AutomationStatus {
    const record = this.get(id);
    const { activeSince, lastPressed, ...remembered } = this.book.read(id);
    const status: AutomationStatus = { ...remembered };
    if (!record) return status;

    // Only what the rule's shape can have. A rule that used to be a mode and
    // was edited into one that watches has no "since" to show.
    const manual = record.document.triggers.some((trigger) => trigger.kind === 'manual');
    if (manual && lastPressed !== undefined) status.lastPressed = lastPressed;
    if (isToggle(record.document) && record.active && activeSince !== undefined) {
      status.activeSince = activeSince;
    }

    if (record.enabled) {
      const next = this.nextRunAt(record);
      if (next !== null) status.nextRunAt = new Date(next).toISOString();
    }
    return status;
  }

  /**
   * When a rule on a clock fires next, or null when that cannot be said: no
   * clock in it, a clock that is not set yet, a timezone `Intl` cannot use, or
   * an `interval` that has not been armed by its first tick.
   */
  private nextRunAt(record: AutomationRecord): number | null {
    const now = this.now();
    if (now < MIN_PLAUSIBLE_CLOCK) return null;
    const schedules: Extract<AutomationTrigger, { kind: 'schedule' }>[] = [];
    let next: number | null = null;
    for (const [index, trigger] of record.document.triggers.entries()) {
      if (trigger.kind === 'schedule') schedules.push(trigger);
      if (trigger.kind === 'interval') {
        const last = this.lastFired.get(`${record.id}:${index}`);
        if (last === undefined) continue;
        const due = Math.max(last + trigger.everyMs, now);
        if (next === null || due < next) next = due;
      }
    }
    const scheduled = nextScheduleAt(schedules, this.options.timezone(), now);
    if (scheduled !== null && (next === null || scheduled < next)) next = scheduled;
    return next;
  }

  /**
   * Write down what has moved. Public for `HistoryService.flush()`'s reason —
   * a test cannot wait a minute — and called by `stop()`.
   */
  async flushStatus(): Promise<void> {
    this.lastStatusFlush = Date.now();
    const moved = this.book.takeDirty();
    if (moved.size > 0) await this.options.store.saveStatus(moved);
  }

  /**
   * Tell whoever is listening that a rule's status moved — at once the first
   * time, and then no more than once per `STATUS_NOTIFY_MS` however often the
   * rule fires. The catch-up is read when it is sent, so it carries the rule
   * as it then is rather than as it was when the timer was set.
   */
  private announceStatus(id: string): void {
    const every = this.options.statusNotifyMs ?? STATUS_NOTIFY_MS;
    const emit = (): void => {
      if (!this.get(id)) return;
      this.options.events.emit('automationStatus', { automationId: id, status: this.statusOf(id) });
    };
    const entry = this.announced.get(id);
    const now = Date.now();
    if (!entry || now - entry.at >= every) {
      clearTimeout(entry?.timer);
      this.announced.set(id, { at: now });
      emit();
      return;
    }
    if (entry.timer !== undefined) return;
    entry.timer = setTimeout(() => {
      this.announced.set(id, { at: Date.now() });
      emit();
    }, every - (now - entry.at));
    entry.timer.unref?.();
  }

  list(): readonly AutomationRecord[] {
    return this.records;
  }

  unreadableRules(): readonly UnreadableAutomation[] {
    return this.unreadable;
  }

  get(id: string): AutomationRecord | undefined {
    return this.records.find((record) => record.id === id);
  }

  /** The view sanity checks and the agent are given. Built on demand — this
   *  is not the report path. */
  homeView(): AutomationHomeView {
    return {
      devices: this.deviceViews(),
      rooms: this.structure.rooms,
      zones: this.structure.zones,
      automations: this.records.map((record) => ({
        id: record.id,
        name: record.name,
        enabled: record.enabled,
        document: record.document,
      })),
    };
  }

  // ── The report path ────────────────────────────────────────────────────────

  private readonly onStateChanged = (deviceId: string, endpointId: number, state: EndpointState): void => {
    // The whole cost for a home with no rules watching this device: one set
    // lookup against a string that was already in hand.
    if (!this.watched.has(deviceId)) return;
    this.evaluateDevice(deviceId, endpointId, state);
  };

  private readonly onHomeMoved = (): void => {
    void this.reload().catch((error) => {
      this.options.log.warn({ err: error }, 'Automations could not re-read the home.');
    });
  };

  /**
   * A radio saying a write never landed. If the last thing sent to that
   * device was a rule's, the rule's trace and its status are put right.
   *
   * **The step is corrected where it stands**, not followed by a second one:
   * "Hall lamp turned on" and then "Hall lamp didn’t answer" is a trace that
   * contradicts itself, and the first of those was never true. A run still
   * going is corrected in memory and counts the problem when it reports; one
   * already written is corrected in its row, behind the write that made it.
   *
   * Attributed by device and by time only, which is as much as the failure
   * carries. A command somebody sent the same device by hand inside the
   * minute would be read as the rule's — and either way the device is not
   * answering, which is what the rule's page needs to say.
   */
  private readonly onCommandFailed = (failure: CommandFailure): void => {
    const sent = this.sentCommands.get(failure.deviceId);
    if (sent === undefined) return;
    this.sentCommands.delete(failure.deviceId);
    if (this.now() - sent.at > LATE_FAILURE_MS) return;

    const said = narrateFailure(this.narrated(failure.deviceId), sent.command, failure.detail, failure.kind);
    const was = { at: sent.step.at, summary: sent.step.summary };
    const corrected: AutomationRunStep = {
      at: was.at,
      kind: 'refused',
      summary: said.text,
      detail: said.detail,
      problem: true,
    };
    const { ledger } = sent;

    if (ledger.steps !== undefined) {
      Object.assign(sent.step, corrected);
      ledger.lateProblem ??= said.text;
      return;
    }
    if (ledger.reported === undefined) return;
    this.book.lateProblem(ledger.automationId, ledger.reported, said.text);
    this.announceStatus(ledger.automationId);
    void (ledger.recorded ?? Promise.resolve()).then(() =>
      this.options.store.correctRunStep(ledger.runId, was, corrected),
    );
  };

  private readonly onDeviceRemoved = (deviceId: string): void => {
    this.guards.forgetDevice(deviceId);
    this.sentCommands.delete(deviceId);
    for (const key of [...this.edges.keys()]) {
      if (key.endsWith(`:${deviceId}`)) this.forgetEdge(key);
    }
    this.onHomeMoved();
  };

  /**
   * Forget one trigger's answer, and any `for` it was waiting out. The hold
   * would find no answer and fire nothing — but until it ran out it would go
   * on telling the hub's automatic updates that a rule is mid-way.
   */
  private forgetEdge(key: string): void {
    this.edges.delete(key);
    const hold = this.holds.get(key);
    if (hold !== undefined) {
      clearTimeout(hold);
      this.holds.delete(key);
    }
  }

  private evaluateDevice(deviceId: string, endpointId: number, state: EndpointState): void {
    const home = this.homeView();
    for (const record of this.records) {
      if (!record.enabled) continue;
      for (const [index, trigger] of record.document.triggers.entries()) {
        if (trigger.kind !== 'deviceState' && trigger.kind !== 'deviceEvent') continue;
        const matches = resolveTarget(trigger.target, home).some(
          (entry) => entry.deviceId === deviceId && entry.endpointId === endpointId,
        );
        if (!matches) continue;
        const key = `${record.id}:${index}:${deviceId}`;
        if (trigger.kind === 'deviceState') {
          this.evaluateStateTrigger(record, trigger, index, key, deviceId, endpointId, state);
        } else {
          this.evaluateEventTrigger(record, trigger, key, deviceId, endpointId, state);
        }
      }
    }
  }

  private evaluateStateTrigger(
    record: AutomationRecord,
    trigger: Extract<AutomationTrigger, { kind: 'deviceState' }>,
    index: number,
    key: string,
    deviceId: string,
    endpointId: number,
    state: EndpointState,
  ): void {
    const value = readPath(state, trigger.path);
    const previous = this.edges.get(key);
    const outcome = evaluateEdge(previous, value, trigger.op, trigger.value, trigger.hysteresis);
    this.edges.set(key, outcome.next);

    // The test stopped holding: any pending "and it stayed there" is void.
    if (previous?.latched && !outcome.next.latched) {
      const hold = this.holds.get(key);
      if (hold) {
        clearTimeout(hold);
        this.holds.delete(key);
      }
    }

    if (!outcome.fires) return;

    const cause = narrateStateCause(trigger, this.narrated(deviceId), value);
    const origin = this.guards.causeOf(deviceId, endpointId);
    const depth = origin ? origin.depth + 1 : 0;

    if (trigger.for !== undefined && trigger.for > 0) {
      const hold = setTimeout(() => {
        this.holds.delete(key);
        // Still true? The latch is the answer — it is only released when the
        // test stops holding, and releasing it is what cancelled this timer.
        if (this.edges.get(key)?.latched !== true) return;
        void this.fire(record, 'deviceState', cause.text, depth, { causeDetail: cause.detail });
      }, trigger.for);
      hold.unref?.();
      this.holds.set(key, hold);
      return;
    }

    void this.fire(record, 'deviceState', cause.text, depth, { causeDetail: cause.detail });
  }

  private evaluateEventTrigger(
    record: AutomationRecord,
    trigger: Extract<AutomationTrigger, { kind: 'deviceEvent' }>,
    key: string,
    deviceId: string,
    endpointId: number,
    state: EndpointState,
  ): void {
    // `event.at` is stamped on every press, which is what makes a repeat of
    // the same action a fresh state change — see `schema/state.ts`.
    const at = state.event?.at;
    if (at === undefined) return;
    const previous = this.edges.get(key);
    this.edges.set(key, { seen: true, latched: false, previous: at });
    if (!previous?.seen || previous.previous === at) return;

    if (trigger.button !== undefined && state.event?.button !== trigger.button) return;
    if (trigger.gesture !== undefined && state.event?.gesture !== trigger.gesture) return;
    if (trigger.action !== undefined && state.event?.action !== trigger.action) return;

    const cause = narrateEventCause(this.narrated(deviceId), state.event ?? {});
    const origin = this.guards.causeOf(deviceId, endpointId);
    void this.fire(record, 'deviceEvent', cause.text, origin ? origin.depth + 1 : 0, {
      causeDetail: cause.detail,
    });
  }

  // ── The clock ──────────────────────────────────────────────────────────────

  /**
   * One look at the clock.
   *
   * Public for the same reason `HistoryService.flush()` is: everything it
   * decides is a function of the injected clock, and a test that had to wait
   * `TICK_MS` for each of them could not check a day of a home's behaviour at
   * all. The interval calls exactly this.
   */
  async tick(): Promise<void> {
    if (!this.started) return;
    const now = this.now();

    if (now < MIN_PLAUSIBLE_CLOCK) {
      if (!this.warnedAboutClock) {
        this.warnedAboutClock = true;
        this.options.log.warn(
          'The clock is implausible — scheduled automations are held until it is set.',
        );
      }
      return;
    }

    const timezone = this.options.timezone();
    let time: string;
    let day: number;
    try {
      time = timeOfDayIn(timezone, now);
      day = dayOfWeekIn(timezone, now);
    } catch (error) {
      // An unknown timezone would otherwise take every schedule in the home
      // down with it, silently, on every tick.
      this.options.log.warn({ err: error, timezone }, 'Unusable timezone — schedules are held.');
      return;
    }

    for (const record of this.records) {
      if (!record.enabled) continue;
      for (const [index, trigger] of record.document.triggers.entries()) {
        const key = `${record.id}:${index}`;
        const last = this.lastFired.get(key);

        if (trigger.kind === 'schedule') {
          if (trigger.at !== time) continue;
          if (trigger.days !== undefined && !trigger.days.includes(day)) continue;
          // The tick runs three times inside the matching minute; a minute's
          // worth of silence after a fire is what makes it once.
          if (last !== undefined && now - last < 60_000) continue;
          this.lastFired.set(key, now);
          // The time itself is the whole cause: under a rule's name, "19:30"
          // is what a person would say set it off.
          void this.fire(record, 'schedule', time, 0, {
            causeDetail: `schedule at ${trigger.at}${trigger.days ? ` on days ${trigger.days.join(',')}` : ''}`,
          });
          continue;
        }

        if (trigger.kind === 'interval') {
          if (last === undefined) {
            // First sight arms it rather than firing: a hub restart is not an
            // interval elapsing, and without this every interval rule in the
            // home would fire on every boot.
            this.lastFired.set(key, now);
            continue;
          }
          if (now - last < trigger.everyMs) continue;
          this.lastFired.set(key, now);
          void this.fire(record, 'interval', `Every ${formatDuration(trigger.everyMs)}`, 0, {
            causeDetail: `interval every ${Math.round(trigger.everyMs / 1000)}s`,
          });
        }
      }
    }
  }

  // ── What an update has to stay out of the way of ───────────────────────────

  /**
   * Whether any rule is in the middle of something a restart would lose: a
   * run — most likely sitting in a `wait` — or a `for` still waiting out its
   * time. Asked by the hub's automatic updates, which would otherwise end a run
   * half done, or drop "the hall has been empty for twenty minutes" ten
   * minutes in: after a restart that trigger adopts the hall as it finds it
   * and says nothing, so the light it was going to switch off stays on all
   * night.
   */
  hasRunInFlight(): boolean {
    return this.running.size > 0 || this.holds.size > 0;
  }

  /**
   * Whether an enabled rule's `schedule` falls in the next `horizonMs`.
   *
   * Asked minute by minute with the helpers `tick` itself uses, so "will this
   * fire" and "did this fire" cannot disagree — across midnight, a list of
   * days or a change of summer time. Twenty minutes is twenty formatter calls,
   * asked a few times a night. A timezone `Intl` cannot use holds every
   * schedule (see `tick`), so nothing is due in one.
   */
  scheduledWithin(now: number, horizonMs: number): boolean {
    const schedules = this.enabledSchedules();
    if (schedules.length === 0) return false;
    const timezone = this.options.timezone();
    try {
      for (let at = now; at < now + horizonMs; at += 60_000) {
        const time = timeOfDayIn(timezone, at);
        const day = dayOfWeekIn(timezone, at);
        if (schedules.some((trigger) => trigger.at === time && (trigger.days?.includes(day) ?? true))) {
          return true;
        }
      }
    } catch {
      return false;
    }
    return false;
  }

  /** The home-local hours enabled rules are set to fire in, one entry per trigger. */
  scheduledHours(): number[] {
    return this.enabledSchedules().map((trigger) => Number(trigger.at.slice(0, 2)));
  }

  private enabledSchedules(): Extract<AutomationTrigger, { kind: 'schedule' }>[] {
    const found: Extract<AutomationTrigger, { kind: 'schedule' }>[] = [];
    for (const record of this.records) {
      if (!record.enabled) continue;
      for (const trigger of record.document.triggers) {
        if (trigger.kind === 'schedule') found.push(trigger);
      }
    }
    return found;
  }

  // ── Running ────────────────────────────────────────────────────────────────

  /**
   * Somebody pressed a button automation.
   *
   * Separate from `setActive` below: this is the one-shot kind ("I'm
   * leaving"), and it is the floor rather than a permission — pressing it
   * switches lights, and working the home is what being a member means.
   */
  async runManually(id: string, by: AutomationPresser): Promise<boolean> {
    const record = this.get(id);
    if (!record) return false;
    // **Started, not finished** — the `POST /devices/:id/remap` lesson, and
    // this engine is exactly where it bites: an action list may hold a `wait`
    // of up to fifteen minutes, while the phone that pressed the button gives
    // the hub ten seconds. Awaiting the run reported a failure on every
    // press that actually did something slow, over a house doing precisely
    // what it was asked. `settled()` is how a test waits for the rest.
    this.detach(
      this.fire(record, 'manual', `Pressed by ${by.name}`, 0, {
        manual: true,
        by,
        sentence: `${by.name} pressed ${record.name}`,
      }),
    );
    return true;
  }

  /**
   * Somebody switched a mode on or off.
   *
   * The stored `active` moves first and the actions follow, so a condition
   * asking `automationActive` during this run sees the new answer — which is
   * what somebody writing "only while Security is on" means.
   */
  async setActive(id: string, active: boolean, by: AutomationPresser): Promise<boolean> {
    const record = this.get(id);
    if (!record) return false;
    await this.options.store.setActive(id, active);
    this.book.setActive(id, active);
    await this.reload();
    const updated = this.get(id);
    if (!updated) return false;
    // **The switch moves, then the actions follow.** The stored word is what
    // the caller asked for and what every other phone draws, so it is written
    // and announced before this returns; the actions are the part that can
    // hold a `wait` and are detached with `runManually`'s reasoning. Emitting
    // *after* the run meant a mode switched in the kitchen reached the phone
    // in the bedroom only once the last lamp had answered.
    this.options.events.emit('automationChanged', id);
    this.detach(
      this.fire(
        updated,
        'manual',
        `Switched ${active ? 'on' : 'off'} by ${by.name}`,
        0,
        {
          manual: true,
          useOffActions: !active,
          by,
          sentence: `${by.name} switched ${record.name} ${active ? 'on' : 'off'}`,
        },
      ),
    );
    return true;
  }

  /**
   * Start a run and stop waiting for it, without losing it.
   *
   * Two things this owes. A detached promise that rejects is an unhandled
   * rejection, which on Node ≥15 ends the process — so the failure is caught
   * and logged here rather than at four call sites. And it stays *findable*:
   * `settled()` is what a test waits on, and what `stop()` drains, because a
   * run nobody holds is a run that outlives the hub shutting down.
   */
  private detach(run: Promise<void>): void {
    const tracked = run.catch((error: unknown) => {
      this.options.log.error({ err: error }, 'automation run failed');
    });
    this.detached.add(tracked);
    void tracked.finally(() => {
      this.detached.delete(tracked);
    });
  }

  /** Wait for every detached run to finish. For tests, and for `stop()` —
   *  the reason `HistoryService.flush()` and `AutomationChat.idle()` exist. */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.detached]);
  }

  private async fire(
    record: AutomationRecord,
    trigger: string,
    cause: string,
    depth: number,
    options: FireOptions = {},
  ): Promise<void> {
    const mode = record.document.mode;
    const existing = this.running.get(record.id);

    if (existing) {
      if (mode === 'single') {
        this.report(record, trigger, cause, 'skipped', options, {
          detail: 'a run was already going',
          reason: 'It was already running, so this one was skipped.',
        });
        return;
      }
      if (mode === 'restart') {
        existing.cancelled = true;
      }
      if (mode === 'queued') {
        if (existing.queued >= MAX_QUEUED) {
          this.report(record, trigger, cause, 'skipped', options, {
            detail: `${MAX_QUEUED} runs already queued`,
            reason: 'Too many runs were already waiting their turn, so this one was skipped.',
          });
          return;
        }
        existing.queued += 1;
        try {
          // **Re-checked after every wait, because one await does not
          // serialize two waiters.** Both would resume in the same microtask
          // drain, both build a handle, both call `execute` — running side by
          // side, which is the one thing `queued` promises not to do — and the
          // loser's handle then replaced the winner's in `this.running`, so a
          // third firing queued behind a run that had already been forgotten.
          // Looking the map up again is what puts each waiter behind whoever
          // actually took the slot.
          let ahead: RunHandle | undefined = existing;
          while (ahead !== undefined) {
            await ahead.promise.catch(() => undefined);
            ahead = this.running.get(record.id);
          }
        } finally {
          existing.queued -= 1;
        }
      }
    }

    /**
     * The author's own limits, before the engine's — and **automatic firings
     * only**, which is the five-guards rule applied one level up: a person
     * pressing a button is a person, and being silently ignored because the
     * rule ran twenty minutes ago is the one outcome nobody could explain.
     * The command-level floor still protects the relay either way.
     */
    const declared = record.document.guards;
    if (declared !== undefined && options.manual !== true) {
      const refusal = this.guards.declaredRefusal(record.id, declared);
      if (refusal !== null) {
        this.report(record, trigger, cause, 'skipped', options, {
          detail: refusal,
          reason: `Skipped — ${refusal}.`,
        });
        return;
      }
    }

    /**
     * The circuit breaker, and it is checked here rather than inside the run:
     * a rule that is running away is one whose *firings* are the problem, and
     * counting only the ones that got as far as sending a command would let
     * a loop that keeps failing its conditions spin for ever.
     */
    const runaway = this.guards.noteRun(record.id);
    if (runaway.runaway) {
      await this.disableRunaway(record, runaway.detail);
      this.report(record, trigger, cause, 'refused', options, {
        detail: runaway.detail,
        reason: `The hub switched this rule off — ${runaway.detail}.`,
      });
      return;
    }

    const handle: RunHandle = { cancelled: false, promise: Promise.resolve(), queued: 0 };
    handle.promise = this.execute(record, trigger, cause, depth, options, handle);
    this.running.set(record.id, handle);
    try {
      await handle.promise;
    } finally {
      if (this.running.get(record.id) === handle) this.running.delete(record.id);
    }
  }

  private async execute(
    record: AutomationRecord,
    trigger: string,
    cause: string,
    depth: number,
    options: FireOptions,
    handle: RunHandle,
  ): Promise<void> {
    const startedAt = this.now();
    const runId = randomUUID();
    const steps: AutomationRunStep[] = [];
    const note = (
      kind: string,
      summary: string,
      detail?: string,
      problem = false,
    ): AutomationRunStep | undefined => {
      if (steps.length >= MAX_RUN_STEPS) return undefined;
      const step: AutomationRunStep = {
        at: new Date(this.now()).toISOString(),
        kind,
        summary,
        ...(detail !== undefined ? { detail } : {}),
        ...(problem ? { problem: true as const } : {}),
      };
      steps.push(step);
      return step;
    };
    const ledger: RunLedger = { automationId: record.id, runId, steps };

    const home = this.homeView();
    const context: ConditionContext = {
      home,
      states: (deviceId, endpointId) => this.stateOf(deviceId, endpointId),
      now: this.now(),
      timezone: this.options.timezone(),
      isActive: (id) => this.get(id)?.active === true,
    };

    /**
     * `offActions` skip the conditions.
     *
     * Turning a mode off is a person saying "stop": making that conditional
     * on the same tests that guard turning it on would leave a house locked
     * in a mode because it is past midnight, which is exactly when somebody
     * wants out of it.
     */
    if (!options.useOffActions && !evaluateConditions(record.document.conditions, context)) {
      note('condition', 'A condition didn’t hold, so nothing ran.');
      this.report(record, trigger, cause, 'skipped', options, {
        steps,
        detail: 'a condition did not hold',
        reason: 'A condition didn’t hold, so nothing ran.',
      });
      return;
    }

    const actions = options.useOffActions
      ? (record.document.offActions ?? [])
      : record.document.actions;

    let sent = 0;
    let refused = 0;
    let firstRefusal: string | undefined;
    let problems = 0;
    let firstProblem: string | undefined;
    let outcome: 'ran' | 'failed' | 'interrupted' = 'ran';

    for (const action of actions) {
      if (handle.cancelled) {
        outcome = 'interrupted';
        note('note', 'The run was stopped before it finished.');
        break;
      }
      try {
        const result = await this.runAction(action, { record, runId, depth, home, note, handle, ledger });
        sent += result.sent;
        refused += result.refused;
        if (firstRefusal === undefined && result.refusal !== undefined) firstRefusal = result.refusal;
        problems += result.problems ?? 0;
        firstProblem ??= result.problem;
      } catch (error) {
        outcome = 'failed';
        firstProblem ??= 'A step failed, so the rest did not run.';
        note('note', 'A step failed, so the rest did not run.', (error as Error).message, true);
        break;
      }
    }

    this.report(record, trigger, cause, outcome, options, {
      steps,
      commands: sent,
      refused,
      detail: firstRefusal,
      // A radio may already have said one of this run's commands never landed.
      reason: firstProblem ?? ledger.lateProblem,
      problem: problems > 0 || ledger.lateProblem !== undefined,
      startedAt,
      ledger,
    });

    /**
     * Only a *manual* run writes to the activity log.
     *
     * This is the log's own rule — it records what was **asked**, never what
     * was reported — and a schedule or a sensor firing is not somebody
     * asking. Writing a row per automatic firing would put a motion rule's
     * forty daily runs into a feed bounded at 5 000 rows, drowning everything
     * a person actually did. The trace table is where automatic firings live,
     * and it is bounded per rule so it can afford them.
     */
    if (options.manual && sent > 0) {
      const by = options.by;
      const row = {
        kind: 'automation.ran',
        message: options.sentence ?? cause,
        data: { ...by?.data, automationId: record.id, automationName: record.name, commands: sent },
      };
      await this.options.activity
        .record(by?.memberId !== undefined ? { ...row, memberId: by.memberId } : row)
        // A run can outlive its presser's membership — a `wait` holds it for
        // up to fifteen minutes, and the row is written at the end — while
        // `activity.member_id` is a foreign key, so naming somebody removed in
        // the meantime is refused. The sentence still says who it was.
        .catch(() => this.options.activity.record(row))
        .catch(() => undefined);
    }
  }

  private async runAction(
    action: AutomationAction,
    context: {
      record: AutomationRecord;
      runId: string;
      depth: number;
      home: AutomationHomeView;
      note: (
        kind: string,
        summary: string,
        detail?: string,
        problem?: boolean,
      ) => AutomationRunStep | undefined;
      handle: RunHandle;
      ledger: RunLedger;
    },
  ): Promise<{
    sent: number;
    refused: number;
    refusal?: string;
    /** Commands that were asked for and did not happen — a device already
     *  the way the rule wanted it is not one of them. */
    problems?: number;
    /** The first of those, as the trace says it. */
    problem?: string;
  }> {
    const { record, runId, depth, home, note, handle, ledger } = context;

    switch (action.kind) {
      case 'deviceCommand': {
        // zod's optional-field inference vs `exactOptionalPropertyTypes`:
        // same shape, and the same cast `POST /devices/:id/commands` makes.
        const command = action.command as HubCommand;
        const capability = commandCapability(command.type);
        const resolved = resolveTarget(
          action.target,
          home,
          capability !== null ? { capability } : {},
        );
        if (resolved.length === 0) {
          note('command', `Nothing matched ${describeTarget(action.target, home)}.`);
          return { sent: 0, refused: 0 };
        }
        const origin: CommandOrigin = { automationId: record.id, runId, depth };
        let sent = 0;
        let refused = 0;
        let refusal: string | undefined;
        let problems = 0;
        let problem: string | undefined;

        for (const entry of resolved) {
          if (handle.cancelled) break;
          const state = this.stateOf(entry.deviceId, entry.endpointId);
          const verdict = this.guards.admit(
            entry.deviceId,
            entry.endpointId,
            command,
            state,
            origin,
          );
          if (verdict) {
            refused += 1;
            refusal ??= verdict.detail;
            const said = narrateRefusal(this.narrated(entry.deviceId), command, verdict);
            // Already the way the rule wanted it is the house being as asked,
            // not something that failed to happen.
            const wrong = verdict.kind !== 'unchanged';
            if (wrong) {
              problems += 1;
              problem ??= said.text;
            }
            // `kind` stays `refused` either way — every shipped build draws by
            // it — and `problem` is what tells the two apart.
            note('refused', said.text, said.detail, wrong);
            continue;
          }
          /**
           * Recorded **before** the write, not after, and the ordering is
           * load-bearing. A mains device can report its new state before
           * `execute` has even resolved — Zigbee2MQTT publishes optimistically
           * — and a rule watching that device is then evaluated while this
           * command is still in flight. With the attribution written
           * afterwards, `causeOf` answered "nobody" for exactly the reports
           * our own commands caused, so every link of a loop started again at
           * depth 0 and the chain could never be cut. It also means a command
           * the radio refuses still spends its slot, which is right: the
           * device was asked.
           */
          this.guards.record(entry.deviceId, entry.endpointId, origin);
          try {
            await this.options.registry.execute(entry.deviceId, entry.endpointId, command);
            sent += 1;
            /**
             * **Taken by the radio, which is not the same as done.** A device
             * the hub could not reach when this went out is said to have been
             * offline rather than to have "turned on", and counts as a
             * problem: it is the answer to "why didn't the light come on".
             * For the rest the step says what was asked, and is put right if
             * the radio reports within the minute that it never landed
             * (`onCommandFailed`).
             */
            const device = this.narrated(entry.deviceId);
            const offline = device.online === false;
            const said = offline ? narrateSentWhileOffline(device, command) : narrateCommand(device, command);
            if (offline) {
              problems += 1;
              problem ??= said.text;
            }
            const step = note('command', said.text, said.detail, offline);
            if (step !== undefined) {
              this.sentCommands.set(entry.deviceId, { ledger, command, step, at: this.now() });
            }
          } catch (error) {
            refused += 1;
            refusal ??= (error as Error).message;
            const said = narrateFailure(
              this.narrated(entry.deviceId),
              command,
              (error as Error).message,
            );
            problems += 1;
            problem ??= said.text;
            note('refused', said.text, said.detail, true);
          }
        }
        return {
          sent,
          refused,
          problems,
          ...(refusal !== undefined ? { refusal } : {}),
          ...(problem !== undefined ? { problem } : {}),
        };
      }

      case 'wait': {
        note('wait', `Waited ${formatDuration(action.ms)}.`);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, action.ms);
          timer.unref?.();
        });
        return { sent: 0, refused: 0 };
      }

      case 'setAutomationEnabled': {
        await this.options.store.setEnabled(action.automationId, action.enabled);
        await this.reload();
        this.options.events.emit('automationChanged', action.automationId);
        note('note', `Switched ${this.nameOf(action.automationId)} ${action.enabled ? 'on' : 'off'}.`);
        return { sent: 0, refused: 0 };
      }

      case 'setAutomationActive': {
        await this.options.store.setActive(action.automationId, action.active);
        this.book.setActive(action.automationId, action.active);
        await this.reload();
        this.options.events.emit('automationChanged', action.automationId);
        note('note', `${this.nameOf(action.automationId)} is now ${action.active ? 'on' : 'off'}.`);
        return { sent: 0, refused: 0 };
      }

      case 'runAutomation': {
        const other = this.get(action.automationId);
        if (!other) {
          note('note', 'That automation is gone.');
          return { sent: 0, refused: 0 };
        }
        /**
         * One deeper, and the depth cap is what makes this safe to offer at
         * all: `sanity.ts` refuses a rule that runs *itself*, but A → B → A is
         * only visible at run time, and this is where the chain is counted.
         */
        if (depth + 1 > this.guards.limitsInUse().maxCausationDepth) {
          const said = `“${other.name}” was not run — rules were setting each other off.`;
          note('refused', said, 'too deep a chain of automations', true);
          return {
            sent: 0,
            refused: 1,
            refusal: 'too deep a chain of automations',
            problems: 1,
            problem: said,
          };
        }
        note('note', `Ran ${other.name}.`);
        await this.fire(other, 'action', `Run by “${record.name}”`, depth + 1, {
          causeDetail: `runAutomation from ${record.id}`,
        });
        return { sent: 0, refused: 0 };
      }

      case 'logActivity': {
        await this.options.activity
          .record({
            kind: 'automation.note',
            message: action.message,
            data: { automationId: record.id, automationName: record.name },
          })
          .catch(() => undefined);
        note('note', action.message);
        return { sent: 0, refused: 0 };
      }
    }
  }

  private async disableRunaway(record: AutomationRecord, detail: string): Promise<void> {
    await this.options.store.setEnabled(record.id, false, detail);
    this.guards.forgetAutomation(record.id);
    await this.reload();
    this.options.events.emit('automationChanged', record.id);
    this.options.log.warn({ automation: record.name }, `Automation switched off: ${detail}`);
    /**
     * This one *does* reach the activity log even though no person asked for
     * it, and it is the exception that proves the rule: it is a discrete
     * transition somebody needs to find a week later, when they notice the
     * hall light has stopped working and nothing on any screen says why.
     */
    await this.options.activity
      .record({
        kind: 'automation.disabled',
        message: `“${record.name}” was switched off automatically — ${detail}`,
        data: { automationId: record.id, automationName: record.name, reason: detail },
      })
      .catch(() => undefined);
  }

  private report(
    record: AutomationRecord,
    trigger: string,
    cause: string,
    outcome: AutomationRunEvent['outcome'],
    fired: FireOptions,
    run: RunReport = {},
  ): void {
    const steps = run.steps ?? [];
    // A firing that was declined before it began has no steps of its own, and
    // a stored trace with none says nothing about why. One line does.
    if (steps.length === 0 && run.reason !== undefined) {
      steps.push({
        at: new Date(this.now()).toISOString(),
        kind: outcome === 'refused' ? 'refused' : 'note',
        summary: run.reason,
        ...(run.detail !== undefined ? { detail: run.detail } : {}),
        // The breaker switching the rule off is a problem; a skip is not.
        ...(outcome === 'refused' ? { problem: true as const } : {}),
      });
    }
    const event: AutomationRunEvent = {
      automationId: record.id,
      name: record.name,
      at: new Date(this.now()).toISOString(),
      trigger,
      cause,
      ...(fired.causeDetail !== undefined ? { causeDetail: fired.causeDetail } : {}),
      outcome,
      commands: run.commands ?? 0,
      refused: run.refused ?? 0,
      problems: steps.filter((step) => step.problem === true).length,
      ...(run.detail !== undefined ? { detail: run.detail } : {}),
    };
    this.options.events.emit('automationRun', event);

    const noted = this.book.note(record.id, {
      outcome,
      cause,
      reason: run.reason,
      problem: run.problem,
      ...(fired.manual === true && fired.by !== undefined ? { pressedBy: fired.by.name } : {}),
    });
    this.announceStatus(record.id);

    const recorded = this.options.store.recordRun({
      ...(run.ledger !== undefined ? { id: run.ledger.runId } : {}),
      automationId: record.id,
      trigger,
      cause,
      ...(fired.causeDetail !== undefined ? { causeDetail: fired.causeDetail } : {}),
      outcome,
      durationMs: run.startedAt !== undefined ? this.now() - run.startedAt : 0,
      steps,
    });
    // From here a late failure is a correction to a written trace and a
    // counted run, no longer to this array.
    if (run.ledger !== undefined) {
      run.ledger.steps = undefined;
      run.ledger.reported = noted;
      run.ledger.recorded = recorded;
    }
  }

  // ── Reading the home ───────────────────────────────────────────────────────

  /**
   * Work out which devices are worth listening to, and **prime every trigger
   * against what those devices are saying right now**.
   *
   * The priming is the half that is easy to miss and impossible to live
   * without. The engine only ever sees a device when it *changes*, so a
   * trigger with no remembered answer would treat the first change it ever
   * observes as its first sight — adopt it, and say nothing. The rule would
   * then miss its first genuine firing after every boot, every reload, and
   * every time a selector picked up a new device: a motion rule installed at
   * noon would ignore the first person to walk past it.
   *
   * Reading the current state here is what makes "first sight adopts" mean
   * what it was meant to mean — *this is how the home already is* — rather
   * than "throw the first transition away". A device that has never reported
   * primes as not-matching, so its first report still fires.
   *
   * An existing answer is never overwritten: a reload happens whenever a
   * device is upserted, and losing every latch on it would let a rule fire
   * again for a condition it had already reported.
   */
  private rebuildWatchers(): void {
    const home = this.homeView();
    const watched = new Set<string>();
    const live = new Set<string>();

    for (const record of this.records) {
      if (!record.enabled) continue;
      for (const [index, trigger] of record.document.triggers.entries()) {
        if (trigger.kind !== 'deviceState' && trigger.kind !== 'deviceEvent') continue;
        for (const entry of resolveTarget(trigger.target, home)) {
          watched.add(entry.deviceId);
          const key = `${record.id}:${index}:${entry.deviceId}`;
          live.add(key);
          if (this.edges.has(key)) continue;
          const state = this.stateOf(entry.deviceId, entry.endpointId);
          if (trigger.kind === 'deviceEvent') {
            this.edges.set(key, { seen: true, latched: false, previous: state?.event?.at });
            continue;
          }
          const value = readPath(state, trigger.path);
          this.edges.set(key, {
            seen: true,
            latched: trigger.op === 'changed' ? false : compare(value, trigger.op, trigger.value),
            previous: value,
          });
        }
      }
    }

    // Forget what belongs to a rule or a device that has gone, or the map
    // grows by one entry per rule the home has ever had.
    for (const key of [...this.edges.keys()]) {
      if (!live.has(key)) this.forgetEdge(key);
    }
    this.watched = watched;
  }

  private deviceViews(): AutomationDeviceView[] {
    return this.options.registry.listDevices().map((device) => ({
      id: device.id,
      name: device.name,
      roomId: device.roomId,
      online: device.online,
      endpoints: device.endpoints.map((endpoint) => ({
        endpointId: endpoint.endpointId,
        deviceKind: endpoint.deviceKind,
        capabilities: endpoint.capabilities,
      })),
    }));
  }

  /**
   * What a device is reporting right now.
   *
   * Public because the automation agent's `get_device` tool needs it and the
   * engine is the one place that knows how to read the registry's cache —
   * going through here keeps `src/ai/` out of the registry entirely, which is
   * the same boundary the adapters keep.
   */
  stateFor(deviceId: string, endpointId: number): EndpointState | undefined {
    return this.stateOf(deviceId, endpointId);
  }

  private stateOf(deviceId: string, endpointId: number): EndpointState | undefined {
    return this.options.registry
      .listDevices()
      .find((device) => device.id === deviceId)
      ?.endpoints.find((endpoint) => endpoint.endpointId === endpointId)?.state;
  }

  /** A device as a trace names it: what the home calls it, and where it is. */
  private narrated(deviceId: string): NarratedDevice {
    const device = this.options.registry.listDevices().find((entry) => entry.id === deviceId);
    if (!device) return { name: 'A device that is no longer here' };
    const room = this.structure.rooms.find((entry) => entry.id === device.roomId)?.name;
    return { name: device.name, online: device.online, ...(room !== undefined ? { room } : {}) };
  }

  private nameOf(automationId: string): string {
    return this.get(automationId)?.name ?? 'an automation';
  }
}
