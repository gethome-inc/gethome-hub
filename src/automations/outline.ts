import {
  celsiusFromCenti,
  kelvinFromMireds,
  percentFromLevel,
  degreesFromHue,
  percentFromSaturation,
} from '../schema/index.js';
import { formatDays, formatDuration, formatValue, scaled } from './phrasing.js';
import {
  type AutomationAction,
  type AutomationCondition,
  type AutomationDocument,
  type AutomationTrigger,
  type Comparator,
  type ReadablePath,
} from './schema.js';
import { describeTarget, type AutomationHomeView } from './targets.js';

/**
 * A rule, as a picture.
 *
 * `describeAutomation` says what a rule does in one sentence; this says the
 * same thing as a **storyboard** — when, only if, then — so an app can draw a
 * rule instead of printing it. It is the same split the sentence itself is
 * (`message`/`data` in the activity log, `summary`/`document` here) taken one
 * step further: the sentence is the floor, this is the picture, and the
 * document underneath both is still nobody's business but the hub's.
 *
 * **Why the hub draws it and not the app.** Both apps deliberately do not
 * decode the document — the DSL will keep growing, and a second copy of it in
 * Swift would go stale here without anybody noticing, which is exactly the
 * reason `summary` exists at all. But a sentence is the *only* thing an app
 * could show while that held, and a sentence is a poor way to answer "what
 * does this actually do" for somebody who does not write software. So the hub
 * — which already interprets the document to *run* it — interprets it once
 * more to *draw* it, and hands over something with no schema in it: a short
 * list of steps, each with a mark, a line, and the thing it acts on.
 *
 * **The vocabulary is display-only and every field is optional but `title`.**
 * `glyph` is an opaque token like a room's `icon` or a rule's — the hub knows
 * nothing about SF Symbols, and an app that meets a token it has never heard
 * of falls back to the section's own mark rather than drawing nothing. A node
 * kind this build gains later is one more `glyph` string, not a new shape for
 * an app to learn: an older app draws the new step with a generic mark and a
 * line that is still true, which is the whole property `summary` was built to
 * have.
 *
 * **It is derived on every read**, beside `summary` and `roomId`, and stored
 * nowhere — a rule's storyboard names devices and rooms, and both move under
 * it. Cheap for the same reason those are: a home is tens of devices.
 *
 * **And it is the seat an editor would grow out of.** Nothing here is
 * writable, deliberately — this release draws a rule and changes it in
 * conversation. But a builder is this same list with the steps addressable,
 * so the picture is the part worth getting right first.
 */

// ── The wire ─────────────────────────────────────────────────────────────────

/** One step in a rule, ready to draw. */
export interface AutomationOutlineNode {
  /**
   * The mark, as an opaque token — `motion`, `powerOn`, `wait`. Open
   * vocabulary: an app maps what it knows and falls back on the rest.
   */
  glyph: string;
  /** The act, short and first: "Motion detected", "Switch on", "At 22:00". */
  title: string;
  /** What it acts on: "all the lights in the Kitchen". Absent when the step
   *  is about the home or the clock rather than about devices. */
  subject?: string;
  /** The qualifier under it: "held for 30 seconds", "to 40%". */
  detail?: string;
  /**
   * `quiet` for a step that is not itself an act on the home — a wait, a line
   * written in the history. An app draws those back rather than tinted, so a
   * list of steps reads as the things that actually happen.
   */
  tone?: 'quiet';
  /** `all` / `any` / `not` — set only on a group, and `children` with it. */
  join?: 'all' | 'any' | 'not';
  /** The conditions inside a group. */
  children?: AutomationOutlineNode[];
}

/**
 * The whole rule as four lists, in the order they happen.
 *
 * `when` is joined by *or* (any trigger fires it), `onlyIf` by *and* (every
 * condition has to hold), `then` runs in order, and `otherwise` is what a
 * toggle does on the way back off. The words are the app's — it knows whether
 * the rule is a button, a mode or one that watches, and "When switched off"
 * against "Then" is a label rather than a fact about the document.
 */
export interface AutomationOutline {
  when: AutomationOutlineNode[];
  onlyIf: AutomationOutlineNode[];
  then: AutomationOutlineNode[];
  otherwise?: AutomationOutlineNode[];
}

// ── Words ────────────────────────────────────────────────────────────────────

/**
 * How a path is drawn and what it is called.
 *
 * `noun` is the subject of a numeric test ("Temperature goes above 25 °C").
 * `on`/`off` are the whole clauses a *boolean* path wants instead, because
 * "Occupancy is yes" is a field read out loud where "Motion detected" is the
 * thing that happened. A path with no entry falls back to the path itself,
 * which is ugly and true — the two properties `PATHS` next door is built on.
 */
const PATH_MARKS: Partial<
  Record<ReadablePath, { glyph: string; noun: string; on?: string; off?: string }>
> = {
  onOff: { glyph: 'power', noun: 'Power', on: 'Switched on', off: 'Switched off' },
  'level.current': { glyph: 'brightness', noun: 'Brightness' },
  'colorTemperature.mireds': { glyph: 'warmth', noun: 'Warmth' },
  'thermostat.localTemperatureCenti': { glyph: 'temperature', noun: 'Temperature' },
  'thermostat.occupiedHeatingSetpointCenti': { glyph: 'thermostat', noun: 'Heating setpoint' },
  'thermostat.occupiedCoolingSetpointCenti': { glyph: 'thermostat', noun: 'Cooling setpoint' },
  'thermostat.systemMode': { glyph: 'thermostat', noun: 'Thermostat mode' },
  lock: { glyph: 'lock', noun: 'Lock' },
  'covering.currentPositionLiftPercent100ths': { glyph: 'covering', noun: 'Position' },
  'fan.mode': { glyph: 'fan', noun: 'Fan mode' },
  'fan.percentCurrent': { glyph: 'fan', noun: 'Fan speed' },
  'sensors.temperatureCenti': { glyph: 'temperature', noun: 'Temperature' },
  'sensors.humidityCenti': { glyph: 'humidity', noun: 'Humidity' },
  'sensors.illuminanceLux': { glyph: 'lightLevel', noun: 'Light level' },
  'sensors.pressureHPa': { glyph: 'gauge', noun: 'Pressure' },
  'sensors.flowCubicMetersPerHour': { glyph: 'water', noun: 'Water flow' },
  'sensors.occupied': {
    glyph: 'motion',
    noun: 'Occupancy',
    on: 'Motion detected',
    off: 'Motion stops',
  },
  'sensors.contactClosed': {
    glyph: 'contact',
    noun: 'Contact',
    on: 'Closes',
    off: 'Opens',
  },
  'sensors.airQuality': { glyph: 'air', noun: 'Air quality' },
  'sensors.pm25': { glyph: 'air', noun: 'Particulates' },
  'sensors.co2ppm': { glyph: 'air', noun: 'CO₂' },
  'sensors.smokeAlarm': { glyph: 'smoke', noun: 'Smoke alarm' },
  'sensors.coAlarm': { glyph: 'smoke', noun: 'CO alarm' },
  'battery.percent': { glyph: 'battery', noun: 'Battery' },
  'power.activeMilliwatts': { glyph: 'powerMeter', noun: 'Power draw' },
  'power.importedEnergyMilliwattHours': { glyph: 'powerMeter', noun: 'Energy used' },
  playbackPlaying: {
    glyph: 'media',
    noun: 'Playback',
    on: 'Starts playing',
    off: 'Stops playing',
  },
  currentMode: { glyph: 'mode', noun: 'Mode' },
  rvcOperationalState: { glyph: 'vacuum', noun: 'Vacuum state' },
  reachable: {
    glyph: 'signal',
    noun: 'Reachability',
    on: 'Comes back',
    off: 'Goes offline',
  },
};

/**
 * Two tenses, because a trigger and a condition ask different questions.
 *
 * A trigger is the **moment of crossing** — the whole of what edge-triggering
 * means — so it reads "goes above". A condition is asked while the rule is
 * already running and reads "is above". One table for both said a rule waits
 * for its condition to move, which is exactly what a condition does not do.
 */
const EDGE: Record<Comparator, string> = {
  eq: 'reaches',
  ne: 'leaves',
  lt: 'goes below',
  lte: 'drops to',
  gt: 'goes above',
  gte: 'reaches',
  changed: 'changes',
};

const STATE: Record<Comparator, string> = {
  eq: 'is',
  ne: 'is not',
  lt: 'is below',
  lte: 'is at most',
  gt: 'is above',
  gte: 'is at least',
  changed: 'has changed',
};

/** What a rule is called, when this home still has it. A reference that has
 *  outlived its rule says so rather than printing a UUID. */
function ruleName(id: string, home: AutomationHomeView): string {
  const found = home.automations.find((entry) => entry.id === id);
  return found ? `“${found.name}”` : 'a rule that is no longer here';
}

/** A step, built without the fields nobody set — `exactOptionalPropertyTypes`
 *  wants the key absent rather than present and undefined. */
function node(
  glyph: string,
  title: string,
  extra: { subject?: string | undefined; detail?: string | undefined; tone?: 'quiet' } = {},
): AutomationOutlineNode {
  return {
    glyph,
    title,
    ...(extra.subject !== undefined ? { subject: extra.subject } : {}),
    ...(extra.detail !== undefined ? { detail: extra.detail } : {}),
    ...(extra.tone !== undefined ? { tone: extra.tone } : {}),
  };
}

// ── Triggers ─────────────────────────────────────────────────────────────────

/**
 * A reading test, as a headline and a subject.
 *
 * The boolean paths carry whole clauses and take no comparator at all: an
 * `eq true` on occupancy is "Motion detected", and `ne true` is the same
 * sentence with the answer flipped, which is why the negation is folded into
 * the lookup rather than printed.
 */
function stateNode(
  path: ReadablePath,
  op: Comparator,
  value: number | boolean | undefined,
  subject: string,
  tense: Record<Comparator, string>,
  detail?: string,
): AutomationOutlineNode {
  const mark = PATH_MARKS[path];
  const glyph = mark?.glyph ?? 'unknown';

  if (typeof value === 'boolean' && mark?.on !== undefined && mark.off !== undefined) {
    const yes = op === 'ne' ? !value : value;
    return node(glyph, yes ? mark.on : mark.off, { subject, ...(detail !== undefined ? { detail } : {}) });
  }

  const noun = mark?.noun ?? path;
  const written = formatValue(value, path);
  const title = op === 'changed' ? `${noun} ${tense.changed}` : `${noun} ${tense[op]} ${written}`.trim();
  return node(glyph, title, { subject, ...(detail !== undefined ? { detail } : {}) });
}

function triggerNode(trigger: AutomationTrigger, home: AutomationHomeView): AutomationOutlineNode {
  switch (trigger.kind) {
    case 'manual':
      return node('press', 'Somebody presses it');

    case 'schedule':
      return node('clock', `At ${trigger.at}`, {
        detail: trigger.days ? formatDays(trigger.days) : 'every day',
      });

    case 'interval':
      return node('repeat', `Every ${formatDuration(trigger.everyMs)}`);

    case 'deviceEvent': {
      const what = [trigger.gesture, trigger.button, trigger.action].filter(Boolean).join(' · ');
      return node('button', 'A button is pressed', {
        subject: describeTarget(trigger.target, home, 'any'),
        detail: what || undefined,
      });
    }

    case 'deviceState': {
      // Two qualifiers, and they are not the same thing: `for` suppresses a
      // spike, `hysteresis` suppresses a value resting on the threshold and
      // dithering across it. A rule that carries both said both.
      const held = trigger.for ? `held for ${formatDuration(trigger.for)}` : undefined;
      const band =
        trigger.hysteresis !== undefined && trigger.hysteresis > 0
          ? `re-arms after ${formatValue(trigger.hysteresis, trigger.path)}`
          : undefined;
      const detail = [held, band].filter(Boolean).join(' · ') || undefined;
      return stateNode(
        trigger.path,
        trigger.op,
        trigger.value,
        // **`any`, because that is what the engine does.** A `deviceState`
        // trigger is evaluated per device and fires the moment any one of
        // them crosses; "all the temperature sensors" would say a rule waits
        // for the whole house.
        describeTarget(trigger.target, home, 'any'),
        EDGE,
        detail,
      );
    }
  }
}

// ── Conditions ───────────────────────────────────────────────────────────────

function conditionNode(
  condition: AutomationCondition,
  home: AutomationHomeView,
): AutomationOutlineNode {
  switch (condition.kind) {
    case 'timeRange':
      return node('clock', `Between ${condition.from} and ${condition.to}`, {
        // 22:00 to 06:00 is one night rather than an empty window, and that
        // is the case somebody double-takes at.
        detail: condition.from > condition.to ? 'overnight' : undefined,
      });

    case 'dayOfWeek':
      return node('calendar', `It is ${formatDays(condition.days)}`);

    case 'automationActive':
      return node(
        'rule',
        `${ruleName(condition.automationId, home)} is ${condition.is ? 'on' : 'off'}`,
      );

    case 'deviceState':
      return stateNode(
        condition.path,
        condition.op,
        condition.value,
        // `match` is the engine's own default: any one of them passes unless
        // the author asked for all.
        describeTarget(condition.target, home, condition.match === 'all' ? 'all' : 'any'),
        STATE,
      );

    case 'all':
    case 'any':
      return {
        glyph: 'group',
        title: condition.kind === 'all' ? 'All of these' : 'Any of these',
        join: condition.kind,
        children: condition.conditions.map((nested) => conditionNode(nested, home)),
      };

    case 'not':
      return {
        glyph: 'group',
        title: 'None of this',
        join: 'not',
        children: [conditionNode(condition.condition, home)],
      };
  }
}

// ── Actions ──────────────────────────────────────────────────────────────────

/** What a command does, in the words the app draws — the mark, the act, and
 *  the value it is setting. The target is added by the caller, since every
 *  branch here shares it. */
function commandNode(
  command: Extract<AutomationAction, { kind: 'deviceCommand' }>['command'],
): { glyph: string; title: string; detail?: string } {
  switch (command.type) {
    case 'power':
      return command.on
        ? { glyph: 'powerOn', title: 'Switch on' }
        : { glyph: 'powerOff', title: 'Switch off' };
    case 'toggle':
      return { glyph: 'toggle', title: 'Flip' };
    case 'setLevel':
      return {
        glyph: 'brightness',
        title: 'Set brightness',
        detail: `to ${percentFromLevel(command.level)}%`,
      };
    case 'setColorTemperature':
      return {
        glyph: 'warmth',
        title: 'Set warmth',
        detail: `to ${Math.round(kelvinFromMireds(command.mireds))} K`,
      };
    case 'setHueSaturation':
      return {
        glyph: 'colour',
        title: 'Set colour',
        detail: `hue ${Math.round(degreesFromHue(command.hue))}°, saturation ${percentFromSaturation(command.saturation)}%`,
      };
    case 'setHeatingSetpoint':
      return {
        glyph: 'thermostat',
        title: 'Set heating',
        detail: `to ${celsiusFromCenti(command.centi)} °C`,
      };
    case 'setCoolingSetpoint':
      return {
        glyph: 'thermostat',
        title: 'Set cooling',
        detail: `to ${celsiusFromCenti(command.centi)} °C`,
      };
    case 'setSystemMode':
      return { glyph: 'thermostat', title: 'Set the thermostat mode', detail: `mode ${command.mode}` };
    case 'lock':
      return command.engage
        ? { glyph: 'lock', title: 'Lock' }
        : { glyph: 'unlock', title: 'Unlock' };
    case 'setCoveringPercent':
      return {
        glyph: 'covering',
        title: 'Set the position',
        // Matter's own units, where 0 is fully open — see `phrasing.ts`.
        detail: `to ${scaled(command.percent100ths, 100)}% closed`,
      };
    case 'openCovering':
      return { glyph: 'open', title: 'Open' };
    case 'closeCovering':
      return { glyph: 'close', title: 'Close' };
    case 'stopCovering':
      return { glyph: 'stop', title: 'Stop' };
    case 'setFanPercent':
      return { glyph: 'fan', title: 'Set the fan speed', detail: `to ${command.percent}%` };
    case 'setFanMode':
      return { glyph: 'fan', title: 'Set the fan mode', detail: `mode ${command.mode}` };
    case 'playPause':
      return command.play
        ? { glyph: 'media', title: 'Play' }
        : { glyph: 'media', title: 'Pause' };
    case 'setMode':
      return { glyph: 'mode', title: 'Set the mode', detail: `mode ${command.mode}` };
    case 'irSend':
      return { glyph: 'remote', title: 'Send a remote command' };
    case 'setCustomField':
      return {
        glyph: 'setting',
        title: `Set ${command.fieldId}`,
        detail: `to ${String(command.value)}`,
      };
    default:
      // A command this build has never met is still a step that happens, and
      // its own type is the truest thing that can be said about it — the
      // `commandFailed.kind` stance, one module over.
      return { glyph: 'unknown', title: (command as { type: string }).type };
  }
}

function actionNode(action: AutomationAction, home: AutomationHomeView): AutomationOutlineNode {
  switch (action.kind) {
    case 'wait':
      // Quiet, because nothing happens in it — an app draws a wait as the gap
      // between two steps rather than as a third step beside them.
      return node('wait', `Wait ${formatDuration(action.ms)}`, { tone: 'quiet' });

    case 'logActivity':
      return node('note', 'Write a line in the history', {
        detail: action.message,
        tone: 'quiet',
      });

    case 'runAutomation':
      return node('rule', `Run ${ruleName(action.automationId, home)}`);

    case 'setAutomationEnabled':
      return node(
        'rule',
        `Switch ${ruleName(action.automationId, home)} ${action.enabled ? 'on' : 'off'}`,
        { detail: action.enabled ? 'the rule starts listening' : 'the rule stops listening' },
      );

    case 'setAutomationActive':
      return node(
        'rule',
        `Turn ${ruleName(action.automationId, home)} ${action.active ? 'on' : 'off'}`,
        { detail: 'the mode' },
      );

    case 'deviceCommand': {
      const { glyph, title, detail } = commandNode(action.command);
      return node(glyph, title, {
        subject: describeTarget(action.target, home),
        detail,
      });
    }
  }
}

// ── The whole rule ───────────────────────────────────────────────────────────

export function automationOutline(
  document: AutomationDocument,
  home: AutomationHomeView,
): AutomationOutline {
  const otherwise = document.offActions?.map((action) => actionNode(action, home));
  return {
    when: document.triggers.map((trigger) => triggerNode(trigger, home)),
    onlyIf: (document.conditions ?? []).map((condition) => conditionNode(condition, home)),
    then: document.actions.map((action) => actionNode(action, home)),
    ...(otherwise !== undefined ? { otherwise } : {}),
  };
}
