import { z } from 'zod';
import {
  CAPABILITY_KINDS,
  DEVICE_KINDS,
  commandSchema,
  type CapabilityKind,
} from '../schema/index.js';

/**
 * The automation DSL — what a rule in this home *is*.
 *
 * Deliberately data-only, zod-validated and interpreted, never executed. That
 * is the same rule `src/ai/descriptor.ts` follows, and it is load-bearing for
 * five separate reasons rather than one:
 *
 *  - **The process this would run in holds the house.** The service account
 *    can read `<data>/hub-secret.json` (the key every AI credential is
 *    encrypted with), the token hashes in SQLite, and `<data>/update/`, where
 *    a write starts a root unit. A rule authored by a model — or by a guest
 *    who lives here — must never reach any of that, and `vm` is not a
 *    security boundary.
 *  - **There is no compiler on a Pi.** The bundle is `dist/` plus production
 *    `node_modules`; shipping a transpiler to interpret rules is the 276 MB
 *    Agent SDK mistake in a smaller size.
 *  - **A rule has to be shown to a person**, in their language, on a phone.
 *    Data renders; code does not.
 *  - **A rule has to be checked before it runs** — does that device exist,
 *    does it have that capability, will this fire two hundred times a day,
 *    does it form a cycle with another rule. None of those questions can be
 *    asked of a function body.
 *  - **A rule outlives the build that wrote it.** `install.sh` rolls back to
 *    the previous release on a failed health check, so a document saved by a
 *    newer hub meets an older one. `version` is defaulted rather than
 *    required for exactly that reason, and an unknown node is a rule that
 *    refuses to run and says so — never one that silently skips a step.
 *
 * A scene is an automation whose trigger is `manual`. There is no second
 * system for scenes, and there should not be one: "press this and the house
 * does that" is the same object with one trigger kind.
 */

// ── Bounds ───────────────────────────────────────────────────────────────────

/**
 * The shortest repeat an `interval` trigger may ask for.
 *
 * A minute is already often enough to be a mistake; below it, an automation
 * is a busy loop against an SD card and a Zigbee network. Anything genuinely
 * faster than this is reacting to the house, which is what `deviceState` is
 * for.
 */
export const MIN_INTERVAL_MS = 60_000;

/**
 * The longest `wait` an action list may contain, and it is short on purpose.
 *
 * A wait does **not** survive a hub restart — the hub updates itself, and a
 * continuation persisted across that would have to be re-validated against a
 * schema the new build may have moved. So a wait is only ever "hold this
 * thought for a moment", and anything longer is a `schedule` trigger, which
 * does survive because it is derived from the clock rather than from a
 * suspended run.
 */
export const MAX_WAIT_MS = 15 * 60_000;

/** Actions in one list, counting both `actions` and `offActions`. */
export const MAX_ACTIONS = 40;

/**
 * How many devices one selector may resolve to.
 *
 * "Turn off every light" in a large home is a real request, and forty
 * commands landing on one Zigbee network at once is a real queue. The cap is
 * generous enough for a house and small enough that a mis-typed selector
 * cannot address the whole home by accident; the per-device budgets in
 * `guards.ts` are what actually protect the hardware.
 */
export const MAX_FAN_OUT = 64;

/**
 * The shortest `for` that makes a threshold on a continuously-varying reading
 * safe — see `CONTINUOUS_PATHS` below.
 */
export const MIN_HOLD_MS = 30_000;

// ── What a rule may read ─────────────────────────────────────────────────────

/**
 * Canonical state paths a trigger or condition may read.
 *
 * The same shape as `STATE_PATHS` in `src/ai/descriptor.ts`, and for the same
 * reason: the whitelist *is* the vocabulary, so it reaches a model as a zod
 * enum inside the tool schema rather than as a reference document that can
 * drift from it.
 *
 * `continuous` is the half that has no counterpart there, and it exists
 * because of the one mistake this whole module is arranged to avoid. A power
 * meter reports every few seconds, for ever. A threshold trigger on one of
 * these paths without a hold or a hysteresis band is not a rule — it is a
 * device being switched every time a reading wobbles across a number, which
 * is the `STATE_FLUSH_MS` problem pointed at a relay instead of at an SD
 * card. `sanity.ts` refuses that shape.
 *
 * Actuator positions (`level.current`, covering, fan) are deliberately *not*
 * continuous: they move when somebody moves them, so a threshold on one is a
 * statement about an action rather than about noise.
 */
export const READABLE_PATHS = {
  onOff: { type: 'boolean' },
  'level.current': { type: 'number' },
  'colorTemperature.mireds': { type: 'number' },
  'thermostat.localTemperatureCenti': { type: 'number', continuous: true },
  'thermostat.occupiedHeatingSetpointCenti': { type: 'number' },
  'thermostat.occupiedCoolingSetpointCenti': { type: 'number' },
  'thermostat.systemMode': { type: 'number' },
  lock: { type: 'number' },
  'covering.currentPositionLiftPercent100ths': { type: 'number' },
  'fan.mode': { type: 'number' },
  'fan.percentCurrent': { type: 'number' },
  'sensors.temperatureCenti': { type: 'number', continuous: true },
  'sensors.humidityCenti': { type: 'number', continuous: true },
  'sensors.illuminanceLux': { type: 'number', continuous: true },
  'sensors.pressureHPa': { type: 'number', continuous: true },
  'sensors.flowCubicMetersPerHour': { type: 'number', continuous: true },
  'sensors.occupied': { type: 'boolean' },
  'sensors.contactClosed': { type: 'boolean' },
  'sensors.airQuality': { type: 'number' },
  'sensors.pm25': { type: 'number', continuous: true },
  'sensors.co2ppm': { type: 'number', continuous: true },
  'sensors.smokeAlarm': { type: 'number' },
  'sensors.coAlarm': { type: 'number' },
  'battery.percent': { type: 'number' },
  'power.activeMilliwatts': { type: 'number', continuous: true },
  'power.importedEnergyMilliwattHours': { type: 'number', continuous: true },
  playbackPlaying: { type: 'boolean' },
  currentMode: { type: 'number' },
  rvcOperationalState: { type: 'number' },
  reachable: { type: 'boolean' },
} as const satisfies Record<string, { type: 'number' | 'boolean'; continuous?: true }>;

export type ReadablePath = keyof typeof READABLE_PATHS;

export const READABLE_PATH_KEYS = Object.keys(READABLE_PATHS) as [ReadablePath, ...ReadablePath[]];

const readablePathSchema = z.enum(READABLE_PATH_KEYS);

/** Whether a path carries telemetry that moves on its own, continuously. */
export function isContinuousPath(path: ReadablePath): boolean {
  return 'continuous' in READABLE_PATHS[path];
}

/** Whether a path holds a number (so a threshold and a hysteresis band mean
 *  something) or a boolean (where only `eq`/`ne`/`changed` do). */
export function pathType(path: ReadablePath): 'number' | 'boolean' {
  return READABLE_PATHS[path].type;
}

// ── Targets ──────────────────────────────────────────────────────────────────

/**
 * Which devices a trigger watches or an action writes to.
 *
 * Two shapes, and the second one is the reason this is not just an array of
 * ids. A selector says *what* rather than *which* — "every light in the
 * bedroom" — so a lamp paired next month joins "Night" without anybody
 * editing the rule, and the shipped templates (`templates.ts`) can be written
 * once and installed into a home whose devices nobody has seen. It is also
 * the shape of the request people actually make: "turn off all the lights" is
 * the commonest automation there is.
 *
 * `endpointId` is optional in both, and absent is the useful default: the
 * engine picks the endpoint that carries the capability the command needs,
 * which is how a two-gang switch does the obvious thing without the author
 * knowing it has two endpoints.
 */
export const targetSchema = z.union([
  z
    .object({
      deviceIds: z.array(z.uuid()).min(1).max(MAX_FAN_OUT),
      endpointId: z.number().int().min(0).optional(),
    })
    .strict(),
  z
    .object({
      select: z
        .object({
          capability: z.enum(CAPABILITY_KINDS).optional(),
          kind: z.enum(DEVICE_KINDS).optional(),
          roomId: z.uuid().optional(),
          zoneId: z.uuid().optional(),
        })
        .strict()
        .refine(
          (value) =>
            value.capability !== undefined ||
            value.kind !== undefined ||
            value.roomId !== undefined ||
            value.zoneId !== undefined,
          { message: 'a selector needs at least one of capability, kind, roomId or zoneId' },
        ),
      endpointId: z.number().int().min(0).optional(),
    })
    .strict(),
]);

export type AutomationTarget = z.infer<typeof targetSchema>;

// ── Comparison ───────────────────────────────────────────────────────────────

/**
 * `changed` carries no value and is the honest way to say "when this moves"
 * — a button, a mode, a lock somebody turned by hand.
 */
export const COMPARATORS = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'changed'] as const;
export type Comparator = (typeof COMPARATORS)[number];

const comparatorSchema = z.enum(COMPARATORS);
const comparableValue = z.union([z.number(), z.boolean()]);

const stateTestFields = {
  path: readablePathSchema,
  op: comparatorSchema,
  /** Absent only for `changed`; `sanity.ts` enforces the pairing. */
  value: comparableValue.optional(),
};

// ── Triggers ─────────────────────────────────────────────────────────────────

/** 0 = Sunday, matching `Date.prototype.getDay()`. */
const dayOfWeekSchema = z.number().int().min(0).max(6);

/** `HH:MM`, 24-hour, in the home's own timezone. */
export const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const timeOfDaySchema = z.string().regex(TIME_OF_DAY_PATTERN, 'expected HH:MM in 24-hour time');

export const triggerSchema = z.discriminatedUnion('kind', [
  /**
   * A reading crossed a line, or a value moved.
   *
   * **This is edge-triggered, and that is the single most important thing
   * about it.** The test is evaluated on every report, but the trigger fires
   * only when the answer goes from false to true — the moment of *crossing*,
   * not every report while it is still true. Level-triggering here would be a
   * quiet disaster: a battery at 12% reports every hour and would fire "low
   * battery" every hour for a month; a plug drawing 3 W would fire "the
   * washing machine finished" every few seconds, for ever. The engine keeps
   * the previous answer per rule, per trigger, per device to make this true,
   * and a device it has never evaluated starts from "false" so a hub restart
   * does not re-announce a condition that was already holding.
   *
   * `for` and `hysteresis` sit on top of that, and both are still worth
   * having because an edge on a noisy reading is still a lot of edges. `for`
   * is "and it stayed there", which suppresses a spike; `hysteresis` is a
   * band the value must come back through before the trigger re-arms, which
   * suppresses a reading sitting *on* the threshold and dithering across it —
   * the case an edge alone does nothing about, and the reason one of the two
   * is required on a continuous path rather than merely advised.
   */
  z
    .object({
      kind: z.literal('deviceState'),
      target: targetSchema,
      ...stateTestFields,
      for: z.number().int().min(0).max(24 * 60 * 60_000).optional(),
      hysteresis: z.number().min(0).optional(),
    })
    .strict(),

  /**
   * A button was pressed. Stateless — `event.at` is what makes a repeat of
   * the same action a fresh state change, so this fires every press.
   */
  z
    .object({
      kind: z.literal('deviceEvent'),
      target: targetSchema,
      /** Absent matches any button on the device. */
      button: z.string().min(1).max(60).optional(),
      /** single / double / hold / release … Absent matches any gesture. */
      gesture: z.string().min(1).max(60).optional(),
      /** The raw protocol action, when a device has no parsed button/gesture. */
      action: z.string().min(1).max(120).optional(),
    })
    .strict(),

  /**
   * A time of day, in the home's timezone, optionally narrowed to some days.
   *
   * Missed occurrences are **not** made up when the hub comes back — see
   * `engine.ts`. "Turn the heater on at seven" firing at nine because the
   * power was out is not what anybody meant.
   */
  z
    .object({
      kind: z.literal('schedule'),
      at: timeOfDaySchema,
      /** Absent means every day. */
      days: z.array(dayOfWeekSchema).min(1).max(7).optional(),
    })
    .strict(),

  z
    .object({
      kind: z.literal('interval'),
      everyMs: z.number().int().min(MIN_INTERVAL_MS),
    })
    .strict(),

  /**
   * Somebody pressed it.
   *
   * With `offActions` on the document this is a **toggle** — "Security" on
   * and off — and without them it is a **button** — "I'm leaving". That
   * distinction is the whole of what a scene is, and it is why scenes need no
   * separate storage, route or vocabulary.
   */
  z.object({ kind: z.literal('manual') }).strict(),
]);

export type AutomationTrigger = z.infer<typeof triggerSchema>;

// ── Conditions ───────────────────────────────────────────────────────────────

/**
 * Conditions are recursive, so the schema is declared by hand rather than
 * inferred: `all`/`any`/`not` hold conditions of their own.
 */
export type AutomationCondition =
  | {
      kind: 'deviceState';
      target: AutomationTarget;
      path: ReadablePath;
      op: Comparator;
      // `| undefined` spelled out on every optional field, because
      // `exactOptionalPropertyTypes` is on and this type has to be assignable
      // from what zod infers — which always includes it.
      value?: number | boolean | undefined;
      /** Whether every matched device must pass, or just one. */
      match?: 'any' | 'all' | undefined;
    }
  | { kind: 'timeRange'; from: string; to: string }
  | { kind: 'dayOfWeek'; days: number[] }
  | { kind: 'automationActive'; automationId: string; is: boolean }
  | { kind: 'all'; conditions: AutomationCondition[] }
  | { kind: 'any'; conditions: AutomationCondition[] }
  | { kind: 'not'; condition: AutomationCondition };

/** Nesting depth of `all`/`any`/`not`. Past this a condition is not a
 *  condition, it is a program, and nobody can read it on a phone. */
export const MAX_CONDITION_DEPTH = 4;

export const conditionSchema: z.ZodType<AutomationCondition> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('deviceState'),
        target: targetSchema,
        ...stateTestFields,
        match: z.enum(['any', 'all']).optional(),
      })
      .strict(),
    /**
     * `from` may be later than `to`, and that is the interesting case: 22:00
     * to 06:00 is one night, not an empty window.
     */
    z
      .object({
        kind: z.literal('timeRange'),
        from: timeOfDaySchema,
        to: timeOfDaySchema,
      })
      .strict(),
    z
      .object({ kind: z.literal('dayOfWeek'), days: z.array(dayOfWeekSchema).min(1).max(7) })
      .strict(),
    /**
     * Is another automation currently switched on?
     *
     * This is what makes a house of *modes* rather than a pile of rules:
     * "Security" is a manual toggle that does almost nothing itself, and
     * every rule that should behave differently while it is on asks this.
     */
    z
      .object({
        kind: z.literal('automationActive'),
        automationId: z.uuid(),
        is: z.boolean(),
      })
      .strict(),
    z.object({ kind: z.literal('all'), conditions: z.array(conditionSchema).min(1).max(16) }).strict(),
    z.object({ kind: z.literal('any'), conditions: z.array(conditionSchema).min(1).max(16) }).strict(),
    z.object({ kind: z.literal('not'), condition: conditionSchema }).strict(),
  ]),
);

// ── Actions ──────────────────────────────────────────────────────────────────

/**
 * IR *library management* is not an automation action.
 *
 * `irSend` replays a learned code and is exactly what a rule wants. The other
 * four — learn, save, rename, delete — edit the device's stored library, and
 * a rule that rewrites the remote it is using is a rule nobody can reason
 * about. They are refused here rather than in `sanity.ts` so the message
 * reaches a model at the moment it submits.
 */
const IR_LIBRARY_COMMANDS = new Set(['irLearn', 'irSaveLearned', 'irDeleteCommand', 'irRenameCommand']);

export const actionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('deviceCommand'),
      target: targetSchema,
      /**
       * The hub's own command vocabulary, unchanged. There is deliberately no
       * second set of verbs here: `commandSchema` is already the wire
       * contract every app and every adapter speaks, it is already
       * zod-bounded, and `registry.execute` already routes it. A parallel
       * vocabulary would be one more place for the two to drift.
       */
      command: commandSchema.refine((command) => !IR_LIBRARY_COMMANDS.has(command.type), {
        message:
          'learning, saving, renaming and deleting IR codes are not automation actions — use irSend to replay one',
      }),
    })
    .strict(),

  z.object({ kind: z.literal('wait'), ms: z.number().int().min(0).max(MAX_WAIT_MS) }).strict(),

  z
    .object({
      kind: z.literal('setAutomationEnabled'),
      automationId: z.uuid(),
      enabled: z.boolean(),
    })
    .strict(),

  z
    .object({
      kind: z.literal('setAutomationActive'),
      automationId: z.uuid(),
      active: z.boolean(),
    })
    .strict(),

  z.object({ kind: z.literal('runAutomation'), automationId: z.uuid() }).strict(),

  /**
   * One line in the home's history.
   *
   * The activity log records what was *asked*, and an automation asking for
   * something is exactly that — but only when it is worth reading a week
   * later. A rule that logs on every firing is the write amplification the
   * rest of the store is arranged to avoid, so this is an explicit action an
   * author opts into rather than something the engine does for every run.
   */
  z.object({ kind: z.literal('logActivity'), message: z.string().min(1).max(200) }).strict(),
]);

export type AutomationAction = z.infer<typeof actionSchema>;

// ── The document ─────────────────────────────────────────────────────────────

/**
 * What happens when a run is asked for while one is already going.
 *
 * Home Assistant's vocabulary, minus `parallel`. Three modes cover what a
 * home needs and the fourth is the one that turns a mistake into a storm:
 * unbounded parallel runs against one device is the failure this module
 * exists to prevent, and `queued` with a cap expresses the honest version of
 * the same wish.
 */
export const AUTOMATION_MODES = ['single', 'restart', 'queued'] as const;
export type AutomationMode = (typeof AUTOMATION_MODES)[number];

export const automationDocumentSchema = z
  .object({
    /**
     * A constant the parse fills in, **not** a required literal.
     *
     * `src/ai/descriptor.ts` learned this the expensive way: a bare
     * `z.literal(1)` meant a model submitted a perfectly good document, was
     * told `version: Invalid input: expected 1`, and resubmitted — five, six,
     * seven paid rounds of one run, on every run.
     */
    version: z.literal(1).default(1),
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(400).optional(),
    mode: z.enum(AUTOMATION_MODES).default('single'),
    triggers: z.array(triggerSchema).min(1).max(16),
    conditions: z.array(conditionSchema).max(16).optional(),
    actions: z.array(actionSchema).min(1).max(MAX_ACTIONS),
    /**
     * What running it *off* does. Present makes the automation a toggle, and
     * `sanity.ts` requires a `manual` trigger to go with it — a rule that
     * fires on a sensor has no "off" for anybody to press.
     */
    offActions: z.array(actionSchema).min(1).max(MAX_ACTIONS).optional(),
    /**
     * Author-declared limits, and they may only ever be *stricter* than the
     * engine's own. `guards.ts` holds the floor whatever is written here;
     * this is for the author who knows their boiler wants five minutes
     * between starts.
     */
    guards: z
      .object({
        minIntervalMs: z.number().int().min(0).max(24 * 60 * 60_000).optional(),
        maxRunsPerHour: z.number().int().min(1).max(600).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type AutomationDocument = z.infer<typeof automationDocumentSchema>;

/** Whether this document is one somebody presses rather than one that watches. */
export function isManual(document: AutomationDocument): boolean {
  return document.triggers.some((trigger) => trigger.kind === 'manual');
}

/** Whether it is a two-state toggle (a mode) rather than a one-shot button. */
export function isToggle(document: AutomationDocument): boolean {
  return isManual(document) && document.offActions !== undefined;
}

/** Every capability a document's actions need of their targets, for the
 *  static check that a rule is pointed at devices that can honour it. */
export function commandCapability(commandType: string): CapabilityKind | null {
  switch (commandType) {
    case 'power':
    case 'toggle':
      return 'onOff';
    case 'setLevel':
      return 'level';
    case 'setColorTemperature':
      return 'colorTemperature';
    case 'setHueSaturation':
      return 'color';
    case 'setHeatingSetpoint':
    case 'setCoolingSetpoint':
    case 'setSystemMode':
      return 'thermostat';
    case 'lock':
      return 'doorLock';
    case 'setCoveringPercent':
    case 'openCovering':
    case 'closeCovering':
    case 'stopCovering':
      return 'windowCovering';
    case 'setFanPercent':
    case 'setFanMode':
      return 'fan';
    case 'playPause':
      return 'mediaPlayback';
    case 'setMode':
      return 'mode';
    case 'irSend':
      return 'irRemote';
    case 'setCustomField':
      return 'custom';
    default:
      return null;
  }
}
