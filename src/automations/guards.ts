import type { EndpointState, HubCommand } from '../schema/index.js';

/**
 * What stops an automation hurting something.
 *
 * Every other file in this module is about what a rule *means*. This one is
 * about what the hub will do regardless of what a rule means, and it is the
 * half that has to hold when the schema, the sanity checks and the agent have
 * all been satisfied and the rule is still wrong. A person writes "turn the
 * light on when the power goes above 5 W" and a meter reports every four
 * seconds; a model writes two rules that answer each other; somebody uploads
 * a document from another home. None of those are caught upstream, and all of
 * them end at a relay being switched until it fails.
 *
 * **Everything here applies to automation-driven commands only.** A person
 * tapping a card quickly is a person, and the app's own controls stay exactly
 * as responsive as they were; software tapping quickly is a bug. That
 * distinction is the whole reason these limits can be as tight as they are —
 * nothing a human does goes through this path.
 *
 * Five layers, cheapest first:
 *
 *  1. **Idempotence.** A command that would leave the device where it already
 *     is never leaves the hub. This alone absorbs most flapping, costs one
 *     comparison against the registry's cache, and is the reason the other
 *     four rarely have to say no.
 *  2. **A minimum gap per endpoint.** A relay rated for 100 000 operations
 *     switched once a second is dead within a day and a half.
 *  3. **A rolling budget per device**, by hour and by day, for the case a
 *     rule is switching something legitimately different every time and so
 *     slips past idempotence.
 *  4. **Causation and depth.** What a rule writes is remembered briefly, so a
 *     state change that follows one of our own commands is known to be our
 *     own doing and carries a depth. Past a few links the chain is cut.
 *  5. **A circuit breaker.** A rule that fires far too often is switched off
 *     and says why. This is the backstop that works even when attribution
 *     fails, and it is deliberately the only layer that changes stored state.
 */

export interface GuardLimits {
  /** Shortest gap between two automation commands to one endpoint. */
  minCommandIntervalMs: number;
  maxCommandsPerHour: number;
  maxCommandsPerDay: number;
  /**
   * How long after our own command a state change is still assumed to be its
   * consequence.
   *
   * Attribution by time rather than by correlation id, because no protocol
   * here offers one: Zigbee2MQTT publishes a report when it feels like it and
   * nothing ties it back to the write. Five seconds covers a mains device
   * reporting its new state and is short enough that an unrelated change a
   * minute later is correctly nobody's fault.
   */
  causationWindowMs: number;
  /** Links of "my command caused a report that triggered you" before the chain is cut. */
  maxCausationDepth: number;
  /** Runs inside `runawayWindowMs` before a rule is switched off. */
  runawayRuns: number;
  runawayWindowMs: number;
}

export const DEFAULT_GUARD_LIMITS: GuardLimits = {
  minCommandIntervalMs: 2_000,
  maxCommandsPerHour: 60,
  maxCommandsPerDay: 600,
  causationWindowMs: 5_000,
  maxCausationDepth: 3,
  runawayRuns: 20,
  runawayWindowMs: 10 * 60_000,
};

/** Why a command did not go out. `kind` is what a trace groups on; `detail`
 *  is what a person reads. */
export interface GuardRefusal {
  kind: 'unchanged' | 'too_soon' | 'hourly_budget' | 'daily_budget' | 'too_deep';
  detail: string;
}

export interface CommandOrigin {
  automationId: string;
  runId: string;
  /** 0 for a run a person or a schedule started. */
  depth: number;
}

function endpointKey(deviceId: string, endpointId: number): string {
  return `${deviceId}:${endpointId}`;
}

/**
 * Would this command change anything?
 *
 * Answered against the registry's cached state, which is the best knowledge
 * the hub has and is what every app is already drawing. `undefined` — a
 * device that has not reported the thing being written — always means "send
 * it": silence is not evidence.
 *
 * Three commands are never idempotent and must not be treated as such:
 * `toggle` is defined by what it does rather than where it lands,
 * `stopCovering` is an interrupt, and `irSend` is a transmission with no
 * state behind it at all.
 */
export function wouldChangeNothing(command: HubCommand, state: EndpointState | undefined): boolean {
  if (!state) return false;
  switch (command.type) {
    case 'power':
      return state.onOff === command.on;
    case 'setLevel':
      return state.level?.current === command.level;
    case 'setColorTemperature':
      return state.colorTemperature?.mireds === command.mireds;
    case 'setHueSaturation':
      return (
        state.colorHS?.hue === command.hue && state.colorHS?.saturation === command.saturation
      );
    case 'setHeatingSetpoint':
      return state.thermostat?.occupiedHeatingSetpointCenti === command.centi;
    case 'setCoolingSetpoint':
      return state.thermostat?.occupiedCoolingSetpointCenti === command.centi;
    case 'setSystemMode':
      return state.thermostat?.systemMode === command.mode;
    case 'lock':
      // 1 locked, 2 unlocked; 0 ("not fully locked") is never a resting place
      // to leave a command unsent over.
      return state.lock === (command.engage ? 1 : 2);
    case 'setCoveringPercent':
      return state.covering?.currentPositionLiftPercent100ths === command.percent100ths;
    case 'openCovering':
      return state.covering?.currentPositionLiftPercent100ths === 0;
    case 'closeCovering':
      return state.covering?.currentPositionLiftPercent100ths === 10_000;
    case 'setFanPercent':
      return state.fan?.percentCurrent === command.percent;
    case 'setFanMode':
      return state.fan?.mode === command.mode;
    case 'playPause':
      return state.playbackPlaying === command.play;
    case 'setMode':
      return state.currentMode === command.mode;
    case 'setCustomField':
      return state.custom?.values?.[command.fieldId] === command.value;
    default:
      return false;
  }
}

interface EndpointRecord {
  lastCommandAt: number;
  /** Timestamps of commands sent, oldest first, pruned to a day. */
  sent: number[];
  origin?: CommandOrigin;
  originAt?: number;
}

export class AutomationGuards {
  private readonly endpoints = new Map<string, EndpointRecord>();
  /** Firing times per automation, for the circuit breaker. */
  private readonly firings = new Map<string, number[]>();
  private readonly limits: GuardLimits;

  /**
   * The clock is injected rather than read, and that is a design constraint
   * rather than a testing convenience: everything here is a decision about
   * time, and a module that reads `Date.now()` directly can only be tested by
   * waiting.
   */
  constructor(
    private readonly now: () => number = () => Date.now(),
    limits: Partial<GuardLimits> = {},
  ) {
    this.limits = { ...DEFAULT_GUARD_LIMITS, ...limits };
  }

  /**
   * May this command go out, and if not, why not?
   *
   * Asked immediately before sending; `record` is what marks it as sent, so a
   * caller that asks and then decides not to send has not spent anything.
   */
  admit(
    deviceId: string,
    endpointId: number,
    command: HubCommand,
    state: EndpointState | undefined,
    origin: CommandOrigin,
  ): GuardRefusal | null {
    if (origin.depth > this.limits.maxCausationDepth) {
      return {
        kind: 'too_deep',
        detail:
          `this command is ${origin.depth} links down a chain of automations setting each ` +
          `other off, which is past the limit of ${this.limits.maxCausationDepth}`,
      };
    }

    if (wouldChangeNothing(command, state)) {
      return { kind: 'unchanged', detail: 'the device is already in that state' };
    }

    const key = endpointKey(deviceId, endpointId);
    const record = this.endpoints.get(key);
    const now = this.now();

    if (record !== undefined) {
      const since = now - record.lastCommandAt;
      if (since < this.limits.minCommandIntervalMs) {
        return {
          kind: 'too_soon',
          detail:
            `only ${since} ms since the last automation command to this device, and the ` +
            `minimum is ${this.limits.minCommandIntervalMs} ms`,
        };
      }
      const lastHour = record.sent.filter((at) => now - at < 60 * 60_000).length;
      if (lastHour >= this.limits.maxCommandsPerHour) {
        return {
          kind: 'hourly_budget',
          detail: `${lastHour} automation commands to this device in the last hour is the limit`,
        };
      }
      if (record.sent.length >= this.limits.maxCommandsPerDay) {
        return {
          kind: 'daily_budget',
          detail: `${record.sent.length} automation commands to this device today is the limit`,
        };
      }
    }

    return null;
  }

  /**
   * Note that a command really went out.
   *
   * This is also what makes causation work: the state report that follows is
   * looked up here, so the rule it triggers knows it is a consequence rather
   * than a cause.
   */
  record(deviceId: string, endpointId: number, origin: CommandOrigin): void {
    const key = endpointKey(deviceId, endpointId);
    const now = this.now();
    const record = this.endpoints.get(key) ?? { lastCommandAt: 0, sent: [] };
    record.lastCommandAt = now;
    record.sent.push(now);
    // Bounded by time rather than by count: the daily budget is the cap on
    // how long this can get, and a device nothing writes to keeps no array.
    const dayAgo = now - 24 * 60 * 60_000;
    if (record.sent.length > 0 && record.sent[0]! < dayAgo) {
      record.sent = record.sent.filter((at) => at >= dayAgo);
    }
    record.origin = origin;
    record.originAt = now;
    this.endpoints.set(key, record);
  }

  /**
   * Did we cause this device's current state, and how far down a chain are we?
   *
   * Returns null for a change nobody here made — a person tapping a card, a
   * wall switch, a sensor reporting — which is exactly the case that *should*
   * start a rule at depth 0.
   */
  causeOf(deviceId: string, endpointId: number): CommandOrigin | null {
    const record = this.endpoints.get(endpointKey(deviceId, endpointId));
    if (!record?.origin || record.originAt === undefined) return null;
    if (this.now() - record.originAt > this.limits.causationWindowMs) return null;
    return record.origin;
  }

  /**
   * Note that a rule ran, and say whether it has run away.
   *
   * The breaker is per automation rather than per device on purpose: a
   * runaway rule usually writes to several devices, so a per-device count
   * would let it stay under every limit while the house cycled. It is also
   * the one guard whose answer has to *persist* — a rule that keeps being
   * switched off and coming back on a restart is a rule nobody can diagnose —
   * so the engine writes `disabledReason` when this says yes.
   */
  noteRun(automationId: string): { runaway: boolean; detail: string } {
    const now = this.now();
    const window = now - this.limits.runawayWindowMs;
    const times = (this.firings.get(automationId) ?? []).filter((at) => at >= window);
    times.push(now);
    this.firings.set(automationId, times);

    if (times.length <= this.limits.runawayRuns) return { runaway: false, detail: '' };
    return {
      runaway: true,
      detail:
        `it ran ${times.length} times in ${Math.round(this.limits.runawayWindowMs / 60_000)} ` +
        `minutes, which is far more than anything in a home should, so it has been switched off`,
    };
  }

  /** Forget a rule's history — after it is deleted, or deliberately re-enabled. */
  forgetAutomation(automationId: string): void {
    this.firings.delete(automationId);
  }

  /** Forget a device's history, when it leaves the home. */
  forgetDevice(deviceId: string): void {
    for (const key of [...this.endpoints.keys()]) {
      if (key.startsWith(`${deviceId}:`)) this.endpoints.delete(key);
    }
  }

  /** For a trace and for tests. */
  limitsInUse(): GuardLimits {
    return { ...this.limits };
  }
}
