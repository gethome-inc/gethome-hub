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

function value(raw: number | boolean | undefined): string {
  if (raw === undefined) return '';
  if (typeof raw === 'boolean') return raw ? 'yes' : 'no';
  return String(raw);
}

function describeTrigger(trigger: AutomationTrigger, home: AutomationHomeView): string {
  switch (trigger.kind) {
    case 'manual':
      return 'somebody presses it';
    case 'schedule':
      return trigger.days
        ? `it is ${trigger.at} on ${trigger.days.length} chosen day(s)`
        : `it is ${trigger.at}`;
    case 'interval':
      return `every ${Math.round(trigger.everyMs / 60_000)} minute(s)`;
    case 'deviceEvent': {
      const what = [trigger.gesture, trigger.button].filter(Boolean).join(' ');
      return `${describeTarget(trigger.target, home)} is pressed${what ? ` (${what})` : ''}`;
    }
    case 'deviceState': {
      const subject = PATHS[trigger.path] ?? trigger.path;
      const held = trigger.for ? ` for ${Math.round(trigger.for / 1000)}s` : '';
      // The boolean paths read as whole clauses ("sees somebody"), so an
      // `eq true` on one wants no comparator at all — "the motion sensor sees
      // somebody" rather than "the motion sensor sees somebody is yes".
      if (typeof trigger.value === 'boolean' && subject !== trigger.path) {
        const negated = trigger.op === 'ne' ? !trigger.value : trigger.value;
        return `${describeTarget(trigger.target, home)} ${negated ? '' : 'no longer '}${subject}${held}`;
      }
      return `${describeTarget(trigger.target, home)} ${subject} ${COMPARATORS[trigger.op]} ${value(trigger.value)}${held}`.trim();
    }
  }
}

function describeCondition(condition: AutomationCondition, home: AutomationHomeView): string {
  switch (condition.kind) {
    case 'timeRange':
      return `it is between ${condition.from} and ${condition.to}`;
    case 'dayOfWeek':
      return `it is one of ${condition.days.length} chosen day(s)`;
    case 'automationActive':
      return `another automation is switched ${condition.is ? 'on' : 'off'}`;
    case 'deviceState': {
      const subject = PATHS[condition.path] ?? condition.path;
      return `${describeTarget(condition.target, home)} ${subject} ${COMPARATORS[condition.op]} ${value(condition.value)}`.trim();
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
      return `wait ${Math.round(action.ms / 1000)}s`;
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
