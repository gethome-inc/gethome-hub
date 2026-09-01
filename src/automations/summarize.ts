import {
  isManual,
  isToggle,
  type AutomationAction,
  type AutomationCondition,
  type AutomationDocument,
  type AutomationTrigger,
  type Comparator,
  type ReadablePath,
} from './schema.js';
import { describeTarget, type AutomationHomeView } from './targets.js';

/**
 * A rule, in a sentence.
 *
 * This is the activity log's `message`/`data` split applied to automations:
 * the structured document is what an app renders its own wording from, and
 * this is the **contract** — the thing that is always there, always true, and
 * good enough for a client that has met a node it has never heard of. An app a
 * version behind must be able to draw a rule it cannot fully parse rather than
 * a blank card.
 *
 * Deliberately English and deliberately plain. The apps localise; the hub does
 * not pretend to.
 */

const COMPARATORS: Record<Comparator, string> = {
  eq: 'is',
  ne: 'is not',
  lt: 'goes below',
  lte: 'is at most',
  gt: 'goes above',
  gte: 'is at least',
  changed: 'changes',
};

/** The words a path is worth saying out loud. Anything absent falls back to
 *  the path itself, which is ugly and true — the two properties that matter. */
const PATHS: Partial<Record<ReadablePath, string>> = {
  onOff: 'is switched on',
  'sensors.occupied': 'sees somebody',
  'sensors.contactClosed': 'is closed',
  'sensors.temperatureCenti': 'the temperature',
  'sensors.humidityCenti': 'the humidity',
  'sensors.illuminanceLux': 'the light level',
  'sensors.co2ppm': 'the CO₂',
  'sensors.smokeAlarm': 'the smoke alarm',
  'sensors.coAlarm': 'the CO alarm',
  'battery.percent': 'the battery',
  'power.activeMilliwatts': 'the power draw',
  lock: 'the lock',
  reachable: 'is reachable',
};

/**
 * **How a stored number is said, per path.** Stored units are the wire
 * contract — centi-°C, milliwatts, percent-100ths — and this is the one place
 * that turns one back into what a person means by it.
 *
 * Without it the sentence carried the raw number: an ordinary thermostat rule
 * described itself as "the temperature goes above 2500", wrong by two orders
 * of magnitude and reading perfectly. That is the mistake this repository
 * writes into the *catalog* the agent reads, in exactly these words — the same
 * conversion was simply missing on the way back out, and this string is the
 * only thing either app draws for a rule.
 */
const UNITS: Partial<Record<ReadablePath, { scale?: number; suffix: string }>> = {
  'sensors.temperatureCenti': { scale: 100, suffix: ' °C' },
  'sensors.humidityCenti': { scale: 100, suffix: '%' },
  'sensors.illuminanceLux': { suffix: ' lx' },
  'sensors.co2ppm': { suffix: ' ppm' },
  'sensors.pressureHPa': { suffix: ' hPa' },
  'sensors.pm25': { suffix: ' µg/m³' },
  'battery.percent': { suffix: '%' },
  'power.activeMilliwatts': { scale: 1000, suffix: ' W' },
  'power.importedEnergyMilliwattHours': { scale: 1000, suffix: ' Wh' },
  'thermostat.localTemperatureCenti': { scale: 100, suffix: ' °C' },
  'thermostat.occupiedHeatingSetpointCenti': { scale: 100, suffix: ' °C' },
  'thermostat.occupiedCoolingSetpointCenti': { scale: 100, suffix: ' °C' },
  'covering.currentPositionLiftPercent100ths': { scale: 100, suffix: '% open' },
};

/** One decimal at most, and none when the number is whole: 22.5 °C, not
 *  22.50 °C, and 25 °C rather than 25.0. */
function scaled(raw: number, by: number): string {
  const converted = raw / by;
  return Number.isInteger(converted) ? String(converted) : converted.toFixed(1);
}

function value(raw: number | boolean | undefined, path?: ReadablePath): string {
  if (raw === undefined) return '';
  if (typeof raw === 'boolean') return raw ? 'yes' : 'no';
  const unit = path !== undefined ? UNITS[path] : undefined;
  if (unit === undefined) return String(raw);
  return `${unit.scale ? scaled(raw, unit.scale) : String(raw)}${unit.suffix}`;
}

/** 0 = Sunday, matching the schema and `Date.prototype.getDay()`. */
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * The days themselves, because "on 5 chosen day(s)" is a placeholder rather
 * than a sentence — it tells somebody how many days their rule runs on and
 * not one of which they are, which is the whole question.
 */
function days(chosen: readonly number[]): string {
  const unique = [...new Set(chosen)].sort((a, b) => a - b);
  if (unique.length === 7) return 'every day';
  if (unique.length === 5 && unique.every((day) => day >= 1 && day <= 5)) return 'weekdays';
  if (unique.length === 2 && unique.includes(0) && unique.includes(6)) return 'weekends';
  const names = unique.map((day) => DAY_NAMES[day] ?? String(day));
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** A duration in the largest unit that stays whole, spelled out. Rules are
 *  written in minutes and hours far more often than in seconds. */
function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60 || minutes % 60 !== 0) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = minutes / 60;
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

/**
 * A device test, in the order English wants it.
 *
 * The path phrases come in two shapes and they take opposite word orders. A
 * *clause* ("sees somebody", "is closed") reads after its subject — "any of
 * the motion sensors sees somebody". A *noun* ("the temperature", "the
 * battery") does not: putting it there gave "all the temperature sensors the
 * temperature goes above 25 °C", which names the subject twice and reads as a
 * typo. It goes first instead, with the devices behind an `on`.
 */
function describeTest(
  phrase: string,
  target: Parameters<typeof describeTarget>[0],
  home: AutomationHomeView,
  rest: string,
): string {
  const who = describeTarget(target, home, 'any');
  const clause = phrase.startsWith('the ') ? `${phrase} on ${who}` : `${who} ${phrase}`;
  return `${clause} ${rest}`.trim();
}

function describeTrigger(trigger: AutomationTrigger, home: AutomationHomeView): string {
  switch (trigger.kind) {
    case 'manual':
      return 'somebody presses it';
    case 'schedule':
      return trigger.days ? `it is ${trigger.at} on ${days(trigger.days)}` : `it is ${trigger.at}`;
    case 'interval':
      return `every ${duration(trigger.everyMs)}`;
    case 'deviceEvent': {
      const what = [trigger.gesture, trigger.button].filter(Boolean).join(' ');
      return `${describeTarget(trigger.target, home)} is pressed${what ? ` (${what})` : ''}`;
    }
    case 'deviceState': {
      const subject = PATHS[trigger.path] ?? trigger.path;
      const held = trigger.for ? ` for ${duration(trigger.for)}` : '';
      // The boolean paths read as whole clauses ("sees somebody"), so an
      // `eq true` on one wants no comparator at all — "the motion sensor sees
      // somebody" rather than "the motion sensor sees somebody is yes".
      if (typeof trigger.value === 'boolean' && subject !== trigger.path) {
        const negated = trigger.op === 'ne' ? !trigger.value : trigger.value;
        return `${describeTarget(trigger.target, home, 'any')} ${negated ? '' : 'no longer '}${subject}${held}`;
      }
      return describeTest(
        subject,
        trigger.target,
        home,
        `${COMPARATORS[trigger.op]} ${value(trigger.value, trigger.path)}${held}`,
      );
    }
  }
}

function describeCondition(condition: AutomationCondition, home: AutomationHomeView): string {
  switch (condition.kind) {
    case 'timeRange':
      return `it is between ${condition.from} and ${condition.to}`;
    case 'dayOfWeek':
      return `it is ${days(condition.days)}`;
    case 'automationActive':
      return `another automation is switched ${condition.is ? 'on' : 'off'}`;
    case 'deviceState': {
      const subject = PATHS[condition.path] ?? condition.path;
      return describeTest(
        subject,
        condition.target,
        home,
        `${COMPARATORS[condition.op]} ${value(condition.value, condition.path)}`,
      );
    }
    case 'all':
      return condition.conditions.map((nested) => describeCondition(nested, home)).join(' and ');
    case 'any':
      return condition.conditions.map((nested) => describeCondition(nested, home)).join(' or ');
    case 'not':
      return `not (${describeCondition(condition.condition, home)})`;
  }
}

function describeAction(action: AutomationAction, home: AutomationHomeView): string {
  switch (action.kind) {
    case 'wait':
      return `wait ${duration(action.ms)}`;
    case 'logActivity':
      return 'write a line in the history';
    case 'runAutomation':
      return 'run another automation';
    case 'setAutomationEnabled':
      return `switch another automation ${action.enabled ? 'on' : 'off'}`;
    case 'setAutomationActive':
      return `turn another mode ${action.active ? 'on' : 'off'}`;
    case 'deviceCommand': {
      const target = describeTarget(action.target, home);
      switch (action.command.type) {
        case 'power':
          return `switch ${target} ${action.command.on ? 'on' : 'off'}`;
        case 'toggle':
          return `flip ${target}`;
        case 'lock':
          return `${action.command.engage ? 'lock' : 'unlock'} ${target}`;
        case 'openCovering':
          return `open ${target}`;
        case 'closeCovering':
          return `close ${target}`;
        case 'setLevel':
          return `set ${target} to level ${action.command.level}`;
        default:
          return `${action.command.type} on ${target}`;
      }
    }
  }
}

/** What kind of thing this is, as far as an app drawing it is concerned. */
export type AutomationShape = 'button' | 'toggle' | 'watching';

export function automationShape(document: AutomationDocument): AutomationShape {
  if (isToggle(document)) return 'toggle';
  if (isManual(document)) return 'button';
  return 'watching';
}

export function describeAutomation(document: AutomationDocument, home: AutomationHomeView): string {
  const when = document.triggers.map((trigger) => describeTrigger(trigger, home)).join(', or ');
  const then = document.actions.map((action) => describeAction(action, home)).join(', then ');
  const conditions = (document.conditions ?? [])
    .map((condition) => describeCondition(condition, home))
    .join(' and ');
  const guard = conditions ? `, but only if ${conditions}` : '';
  return `When ${when}${guard}: ${then}.`;
}
