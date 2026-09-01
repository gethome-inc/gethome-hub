import { randomUUID } from 'node:crypto';
import type { EndpointState, HubCommand } from '../schema/index.js';
import type { AutomationRunEvent, HubEventBus } from '../core/bus.js';
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

/**
 * Before this, the clock is not to be trusted.
 *
 * A Raspberry Pi has no real-time clock: it boots at whatever the last shutdown
 * wrote, or at the epoch, and NTP corrects it seconds to minutes later. A
 * scheduler that ran during that window would fire every rule whose time
 * happened to match a fictional clock. Nothing is skipped by waiting — the
 * tick fires on the minute it *is* in, so the moment the clock is right the
 * right minute comes round.
 */
const MIN_PLAUSIBLE_CLOCK = Date.UTC(2025, 0, 1);

/** Queued runs held for one rule in `queued` mode, before new ones are dropped. */
const MAX_QUEUED = 5;

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
}

interface RunHandle {
  cancelled: boolean;
  promise: Promise<void>;
  queued: number;
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

  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private warnedAboutClock = false;

  constructor(private readonly options: AutomationEngineOptions) {
    this.now = options.now ?? (() => Date.now());
    this.guards = new AutomationGuards(this.now, options.guardLimits ?? {});
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    await this.reload();
    this.options.events.on('stateChanged', this.onStateChanged);
    this.options.events.on('deviceUpserted', this.onHomeMoved);
    this.options.events.on('deviceRemoved', this.onDeviceRemoved);
    this.options.events.on('structureChanged', this.onHomeMoved);

    this.timer = setInterval(() => {
      void this.tick();
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
    this.options.events.off('stateChanged', this.onStateChanged);
    this.options.events.off('deviceUpserted', this.onHomeMoved);
    this.options.events.off('deviceRemoved', this.onDeviceRemoved);
    this.options.events.off('structureChanged', this.onHomeMoved);
    // Anything mid-`wait` is abandoned rather than resumed. Its trace already
    // says `interrupted`, which is the honest word for it.
    for (const handle of this.running.values()) handle.cancelled = true;
    await Promise.allSettled([...this.running.values()].map((handle) => handle.promise));
    this.running.clear();
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
    this.rebuildWatchers();
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

  private readonly onDeviceRemoved = (deviceId: string): void => {
    this.guards.forgetDevice(deviceId);
    for (const key of [...this.edges.keys()]) {
      if (key.endsWith(`:${deviceId}`)) this.edges.delete(key);
    }
    this.onHomeMoved();
  };

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

    const cause =
      `${record.name}: ${this.deviceName(deviceId)} ${trigger.path} ` +
      `${trigger.op} ${String(trigger.value ?? '')}`;
    const origin = this.guards.causeOf(deviceId, endpointId);
    const depth = origin ? origin.depth + 1 : 0;

    if (trigger.for !== undefined && trigger.for > 0) {
      const hold = setTimeout(() => {
        this.holds.delete(key);
        // Still true? The latch is the answer — it is only released when the
        // test stops holding, and releasing it is what cancelled this timer.
        if (this.edges.get(key)?.latched !== true) return;
        void this.fire(record, 'deviceState', `${cause} (held for ${trigger.for! / 1000}s)`, depth);
      }, trigger.for);
      hold.unref?.();
      this.holds.set(key, hold);
      return;
    }

    void this.fire(record, 'deviceState', cause, depth);
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

    const pressed = [state.event?.button, state.event?.gesture].filter(Boolean).join(' ');
    const origin = this.guards.causeOf(deviceId, endpointId);
    void this.fire(
      record,
      'deviceEvent',
      `${this.deviceName(deviceId)}: ${pressed || state.event?.action || 'button'}`,
      origin ? origin.depth + 1 : 0,
    );
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
          void this.fire(record, 'schedule', `it is ${time}`, 0);
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
          void this.fire(record, 'interval', `every ${Math.round(trigger.everyMs / 1000)}s`, 0);
        }
      }
    }
  }

  // ── Running ────────────────────────────────────────────────────────────────

  /**
   * Somebody pressed a button automation.
   *
   * Separate from `setActive` below: this is the one-shot kind ("I'm
   * leaving"), and it is the floor rather than a permission — pressing it
   * switches lights, and working the home is what being a member means.
   */
  async runManually(id: string, memberName: string): Promise<boolean> {
    const record = this.get(id);
    if (!record) return false;
    await this.fire(record, 'manual', `${memberName} pressed ${record.name}`, 0, { manual: true });
    return true;
  }

  /**
   * Somebody switched a mode on or off.
   *
   * The stored `active` moves first and the actions follow, so a condition
   * asking `automationActive` during this run sees the new answer — which is
   * what somebody writing "only while Security is on" means.
   */
  async setActive(id: string, active: boolean, memberName: string): Promise<boolean> {
    const record = this.get(id);
    if (!record) return false;
    await this.options.store.setActive(id, active);
    await this.reload();
    const updated = this.get(id);
    if (!updated) return false;
    await this.fire(
      updated,
      'manual',
      `${memberName} switched ${record.name} ${active ? 'on' : 'off'}`,
      0,
      { manual: true, useOffActions: !active },
    );
    this.options.events.emit('automationChanged', id);
    return true;
  }

  private async fire(
    record: AutomationRecord,
    trigger: string,
    cause: string,
    depth: number,
    options: { manual?: boolean; useOffActions?: boolean } = {},
  ): Promise<void> {
    const mode = record.document.mode;
    const existing = this.running.get(record.id);

    if (existing) {
      if (mode === 'single') {
        this.report(record, trigger, cause, 'skipped', [], 0, 0, 'a run was already going');
        return;
      }
      if (mode === 'restart') {
        existing.cancelled = true;
      }
      if (mode === 'queued') {
        if (existing.queued >= MAX_QUEUED) {
          this.report(record, trigger, cause, 'skipped', [], 0, 0, `${MAX_QUEUED} runs already queued`);
          return;
        }
        existing.queued += 1;
        await existing.promise.catch(() => undefined);
        existing.queued -= 1;
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
      this.report(record, trigger, cause, 'refused', [], 0, 0, runaway.detail);
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
    options: { manual?: boolean; useOffActions?: boolean },
    handle: RunHandle,
  ): Promise<void> {
    const startedAt = this.now();
    const runId = randomUUID();
    const steps: AutomationRunStep[] = [];
    const note = (kind: string, summary: string, detail?: string): void => {
      if (steps.length >= MAX_RUN_STEPS) return;
      steps.push({
        at: new Date(this.now()).toISOString(),
        kind,
        summary,
        ...(detail !== undefined ? { detail } : {}),
      });
    };

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
      note('condition', 'A condition did not hold, so nothing ran.');
      this.report(record, trigger, cause, 'skipped', steps, 0, 0, 'a condition did not hold');
      return;
    }

    const actions = options.useOffActions
      ? (record.document.offActions ?? [])
      : record.document.actions;

    let sent = 0;
    let refused = 0;
    let firstRefusal: string | undefined;
    let outcome: 'ran' | 'failed' | 'interrupted' = 'ran';

    for (const action of actions) {
      if (handle.cancelled) {
        outcome = 'interrupted';
        note('note', 'The run was stopped before it finished.');
        break;
      }
      try {
        const result = await this.runAction(action, { record, runId, depth, home, note, handle });
        sent += result.sent;
        refused += result.refused;
        if (firstRefusal === undefined && result.refusal !== undefined) firstRefusal = result.refusal;
      } catch (error) {
        outcome = 'failed';
        note('note', 'An action failed.', (error as Error).message);
        break;
      }
    }

    this.report(record, trigger, cause, outcome, steps, sent, refused, firstRefusal, startedAt);

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
      await this.options.activity
        .record({
          kind: 'automation.ran',
          message: cause,
          data: { automationId: record.id, automationName: record.name, commands: sent },
        })
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
      note: (kind: string, summary: string, detail?: string) => void;
      handle: RunHandle;
    },
  ): Promise<{ sent: number; refused: number; refusal?: string }> {
    const { record, runId, depth, home, note, handle } = context;

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
            note('refused', `${entry.deviceName}: ${command.type} not sent`, verdict.detail);
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
            note('command', `${entry.deviceName}: ${command.type}`);
          } catch (error) {
            refused += 1;
            refusal ??= (error as Error).message;
            note('refused', `${entry.deviceName}: ${command.type} failed`, (error as Error).message);
          }
        }
        return { sent, refused, ...(refusal !== undefined ? { refusal } : {}) };
      }

      case 'wait': {
        note('wait', `Waited ${Math.round(action.ms / 1000)}s.`);
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
          note('refused', `Did not run ${other.name} — too deep a chain of automations.`);
          return { sent: 0, refused: 1, refusal: 'too deep a chain of automations' };
        }
        note('note', `Ran ${other.name}.`);
        await this.fire(other, 'action', `${record.name} ran it`, depth + 1);
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
    steps: AutomationRunStep[],
    commands: number,
    refused: number,
    detail?: string,
    startedAt?: number,
  ): void {
    const event: AutomationRunEvent = {
      automationId: record.id,
      name: record.name,
      at: new Date(this.now()).toISOString(),
      trigger,
      cause,
      outcome,
      commands,
      refused,
      ...(detail !== undefined ? { detail } : {}),
    };
    this.options.events.emit('automationRun', event);
    void this.options.store.recordRun({
      automationId: record.id,
      trigger,
      cause,
      outcome,
      durationMs: startedAt !== undefined ? this.now() - startedAt : 0,
      steps,
    });
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
      if (!live.has(key)) this.edges.delete(key);
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

  private deviceName(deviceId: string): string {
    return this.options.registry.listDevices().find((device) => device.id === deviceId)?.name ?? deviceId;
  }

  private nameOf(automationId: string): string {
    return this.get(automationId)?.name ?? 'an automation';
  }
}
