import {
  MAX_ACTIONS,
  MAX_CONDITION_DEPTH,
  MIN_HOLD_MS,
  commandCapability,
  isContinuousPath,
  isManual,
  pathType,
  type AutomationAction,
  type AutomationCondition,
  type AutomationDocument,
  type AutomationTarget,
  type Comparator,
  type ReadablePath,
} from './schema.js';
import { describeTarget, resolveTarget, type AutomationHomeView } from './targets.js';

/**
 * The checks the schema cannot express.
 *
 * `automationDocumentSchema` guarantees the *shape*; this guarantees the rule
 * makes sense in this home and will not misbehave. It is the same split
 * `sanityCheckDescriptor` makes in `src/ai/descriptor.ts`, and it is why
 * `submit_automation` is deliberately not a `strict` tool: a real sentence
 * explaining what is wrong is worth more to a model — and to a person — than
 * a narrowed schema that can only say "no".
 *
 * Two lists come back, and the distinction is load-bearing.
 *
 * **A problem is a refusal.** The rule cannot be saved, because it would not
 * work, would point at nothing, or would hurt something.
 *
 * **A warning is saved and reported.** The clearest case is a cycle: A turns
 * the light on, B watches the light and turns the heater off, and B's change
 * reaches A. Sometimes that is a bug and sometimes it is a thermostat, and
 * this module cannot tell which — so it says so, the agent gets the sentence
 * back to reconsider, and the person sees it in the preview before they
 * enable anything. Refusing outright would forbid a shape that is legitimate;
 * staying quiet would ship the commonest way a home automation goes wrong.
 */
export interface SanityReport {
  problems: string[];
  warnings: string[];
}

export interface SanityOptions {
  /** The id this document will be saved under, when it already has one. Lets
   *  self-reference be told from a reference to a different rule. */
  selfId?: string | undefined;
}

export function sanityCheckAutomation(
  document: AutomationDocument,
  home: AutomationHomeView,
  options: SanityOptions = {},
): SanityReport {
  const problems: string[] = [];
  const warnings: string[] = [];

  checkTriggers(document, home, problems, warnings);
  checkConditions(document, home, problems, options);
  checkActions(document, home, problems, warnings, options);
  checkShape(document, problems, warnings);
  checkCycles(document, home, warnings, options);

  return { problems, warnings };
}

// ── Triggers ─────────────────────────────────────────────────────────────────

function checkTriggers(
  document: AutomationDocument,
  home: AutomationHomeView,
  problems: string[],
  warnings: string[],
): void {
  for (const [index, trigger] of document.triggers.entries()) {
    const where = `triggers[${index}]`;

    if (trigger.kind === 'deviceState') {
      checkStateTest(where, trigger.path, trigger.op, trigger.value, problems);
      checkTargetResolves(where, trigger.target, home, problems, warnings);

      if (trigger.hysteresis !== undefined && pathType(trigger.path) !== 'number') {
        problems.push(
          `${where}: hysteresis is a band around a number, and ${trigger.path} is not one`,
        );
      }

      /**
       * The rule this whole module exists for.
       *
       * A power meter reports every few seconds, a thermometer every minute,
       * an illuminance sensor whenever a cloud moves. A bare threshold on one
       * of those is not a rule about the house — it is a relay being switched
       * every time a reading wobbles across a number, for ever. `for` says
       * "and it stayed there"; `hysteresis` says "and it has to come back
       * past this before I fire again". Either one makes the trigger mean
       * what the author thought it meant; neither is optional here.
       */
      if (
        isContinuousPath(trigger.path) &&
        isThreshold(trigger.op) &&
        (trigger.for ?? 0) < MIN_HOLD_MS &&
        (trigger.hysteresis ?? 0) <= 0
      ) {
        problems.push(
          `${where}: ${trigger.path} changes continuously, so a bare threshold would fire ` +
            `every time the reading wobbles across ${String(trigger.value)}. Give it a "for" of at ` +
            `least ${MIN_HOLD_MS / 1000}s, or a hysteresis band it has to leave before firing again.`,
        );
      }
    }

    if (trigger.kind === 'deviceEvent') {
      checkTargetResolves(where, trigger.target, home, problems, warnings);
      /**
       * A button trigger on something with no buttons can never fire, and it
       * is the kind of mistake that looks like a working rule until somebody
       * waits a week for it. Checked against `event`, which is the capability
       * every remote, cube and wall button arrives with.
       */
      const matched = resolveTarget(trigger.target, home);
      const anyWithEvents = matched.some((entry) =>
        home.devices
          .find((device) => device.id === entry.deviceId)
          ?.endpoints.some((endpoint) => endpoint.capabilities.includes('event')),
      );
      if (matched.length > 0 && !anyWithEvents) {
        problems.push(
          `${where}: ${describeTarget(trigger.target, home)} reports no button events, so this ` +
            `trigger can never fire`,
        );
      }
    }

    if (trigger.kind === 'schedule' && trigger.days) {
      if (new Set(trigger.days).size !== trigger.days.length) {
        problems.push(`${where}: the same weekday is listed twice`);
      }
    }
  }
}

function isThreshold(op: Comparator): boolean {
  return op === 'lt' || op === 'lte' || op === 'gt' || op === 'gte' || op === 'eq' || op === 'ne';
}

/**
 * `changed` carries no value; everything else needs one, and it has to be of
 * the path's own type. A boolean compared with `>` is not a rule anybody
 * meant to write.
 */
function checkStateTest(
  where: string,
  path: ReadablePath,
  op: Comparator,
  value: number | boolean | undefined,
  problems: string[],
): void {
  if (op === 'changed') {
    if (value !== undefined) problems.push(`${where}: "changed" compares against nothing — drop the value`);
    return;
  }
  if (value === undefined) {
    problems.push(`${where}: "${op}" needs a value to compare ${path} against`);
    return;
  }
  const expected = pathType(path);
  if (expected === 'boolean') {
    if (typeof value !== 'boolean') {
      problems.push(`${where}: ${path} is true or false, not ${JSON.stringify(value)}`);
    }
    if (op !== 'eq' && op !== 'ne') {
      problems.push(`${where}: ${path} is true or false, so "${op}" says nothing about it`);
    }
    return;
  }
  if (typeof value !== 'number') {
    problems.push(`${where}: ${path} is a number, not ${JSON.stringify(value)}`);
  }
}

// ── Conditions ───────────────────────────────────────────────────────────────

function checkConditions(
  document: AutomationDocument,
  home: AutomationHomeView,
  problems: string[],
  options: SanityOptions,
): void {
  for (const [index, condition] of (document.conditions ?? []).entries()) {
    walkCondition(condition, `conditions[${index}]`, 1, home, problems, options);
  }
}

function walkCondition(
  condition: AutomationCondition,
  where: string,
  depth: number,
  home: AutomationHomeView,
  problems: string[],
  options: SanityOptions,
): void {
  if (depth > MAX_CONDITION_DEPTH) {
    problems.push(
      `${where}: nested more than ${MAX_CONDITION_DEPTH} deep. Past that a condition is a ` +
        `program rather than a sentence, and nobody can read it on a phone.`,
    );
    return;
  }

  switch (condition.kind) {
    case 'deviceState': {
      checkStateTest(where, condition.path, condition.op, condition.value, problems);
      // A condition on a device that has gone is worth refusing for the same
      // reason a trigger is: it silently decides every run.
      const matched = resolveTarget(condition.target, home);
      if (matched.length === 0) {
        problems.push(`${where}: ${describeTarget(condition.target, home)} matches no device`);
      }
      /**
       * `changed` is a statement about a moment, and a condition is asked
       * about a state. Allowing it would read as "if it recently changed",
       * which is not what it would do — it would never be true.
       */
      if (condition.op === 'changed') {
        problems.push(`${where}: "changed" is a trigger, not a condition — it has no lasting answer`);
      }
      return;
    }
    case 'automationActive': {
      if (condition.automationId === options.selfId) {
        problems.push(`${where}: an automation asking whether it is itself active always says yes`);
        return;
      }
      if (!home.automations.some((entry) => entry.id === condition.automationId)) {
        problems.push(`${where}: no automation with id ${condition.automationId} in this home`);
      }
      return;
    }
    case 'dayOfWeek': {
      if (new Set(condition.days).size !== condition.days.length) {
        problems.push(`${where}: the same weekday is listed twice`);
      }
      return;
    }
    case 'timeRange': {
      if (condition.from === condition.to) {
        problems.push(`${where}: a range that starts and ends at ${condition.from} is empty`);
      }
      return;
    }
    case 'all':
    case 'any': {
      for (const [index, nested] of condition.conditions.entries()) {
        walkCondition(nested, `${where}.${condition.kind}[${index}]`, depth + 1, home, problems, options);
      }
      return;
    }
    case 'not': {
      walkCondition(condition.condition, `${where}.not`, depth + 1, home, problems, options);
      return;
    }
  }
}

// ── Actions ──────────────────────────────────────────────────────────────────

function checkActions(
  document: AutomationDocument,
  home: AutomationHomeView,
  problems: string[],
  warnings: string[],
  options: SanityOptions,
): void {
  const lists: Array<[string, readonly AutomationAction[]]> = [['actions', document.actions]];
  if (document.offActions) lists.push(['offActions', document.offActions]);

  for (const [listName, actions] of lists) {
    for (const [index, action] of actions.entries()) {
      const where = `${listName}[${index}]`;

      if (action.kind === 'deviceCommand') {
        const capability = commandCapability(action.command.type);
        checkTargetResolves(where, action.target, home, problems, warnings);
        /**
         * A command aimed at devices that cannot honour it.
         *
         * Checked against the *resolved* endpoints rather than against the
         * selector, because "every device in the kitchen" is a fair way to
         * say "the lights" in a kitchen that only has lights — and becomes
         * wrong the day somebody pairs a kettle. Refused when nothing
         * matched can take the command at all; warned when only some can,
         * since a mixed selector is usually deliberate ("turn everything
         * off") and the resolver already skips the ones without it.
         */
        if (capability !== null) {
          const matched = resolveTarget(action.target, home);
          const able = resolveTarget(action.target, home, { capability });
          if (matched.length > 0 && able.length === 0) {
            problems.push(
              `${where}: ${describeTarget(action.target, home)} has no ${capability}, so ` +
                `"${action.command.type}" cannot land`,
            );
          } else if (able.length > 0 && able.length < matched.length) {
            warnings.push(
              `${where}: only ${able.length} of ${matched.length} matched devices have ` +
                `${capability} — the rest will be skipped`,
            );
          }
        }
      }

      if (
        action.kind === 'runAutomation' ||
        action.kind === 'setAutomationEnabled' ||
        action.kind === 'setAutomationActive'
      ) {
        const known = home.automations.some((entry) => entry.id === action.automationId);
        if (!known && action.automationId !== options.selfId) {
          problems.push(`${where}: no automation with id ${action.automationId} in this home`);
        }
        /**
         * Running yourself is an unbounded loop with no reading in it that
         * could ever stop, which is different from *disabling* yourself —
         * "do this once and never again" is a legitimate rule, and it is the
         * one self-reference that terminates.
         */
        if (action.kind === 'runAutomation' && action.automationId === options.selfId) {
          problems.push(`${where}: an automation that runs itself never stops`);
        }
      }
    }
  }
}

/**
 * Does this target point at anything?
 *
 * A named device that has been removed is a problem: the author meant that
 * device and it is gone. A *selector* that matches nothing today is only a
 * warning — "every light in the garage" is exactly the shape a shipped
 * template has before anybody pairs a light in the garage, and refusing it
 * would make templates uninstallable in a new home.
 */
function checkTargetResolves(
  where: string,
  target: AutomationTarget,
  home: AutomationHomeView,
  problems: string[],
  warnings: string[],
): void {
  if ('select' in target) {
    if (target.select.roomId !== undefined && !home.rooms.some((room) => room.id === target.select.roomId)) {
      problems.push(`${where}: no room with id ${target.select.roomId}`);
      return;
    }
    if (target.select.zoneId !== undefined && !home.zones.some((zone) => zone.id === target.select.zoneId)) {
      problems.push(`${where}: no zone with id ${target.select.zoneId}`);
      return;
    }
    if (resolveTarget(target, home).length === 0) {
      warnings.push(
        `${where}: ${describeTarget(target, home)} matches nothing in this home yet — the rule ` +
          `will start working when one is added`,
      );
    }
    return;
  }

  const missing = target.deviceIds.filter((id) => !home.devices.some((device) => device.id === id));
  if (missing.length === target.deviceIds.length) {
    problems.push(`${where}: none of the named devices are in this home`);
  } else if (missing.length > 0) {
    problems.push(`${where}: ${missing.length} of the named devices are not in this home`);
  }
}

// ── Shape ────────────────────────────────────────────────────────────────────

function checkShape(document: AutomationDocument, problems: string[], warnings: string[]): void {
  /**
   * `offActions` is what makes a rule a *toggle*, and a toggle is something
   * somebody presses. A rule that fires on a sensor has no "off" for anybody
   * to press, so the pair would be dead weight nothing could ever reach.
   */
  if (document.offActions !== undefined && !isManual(document)) {
    problems.push(
      'offActions describe what turning this off does, which only means something with a ' +
        'manual trigger — add one, or drop them',
    );
  }

  const total = document.actions.length + (document.offActions?.length ?? 0);
  if (total > MAX_ACTIONS) {
    problems.push(`${total} actions in total is past the limit of ${MAX_ACTIONS}`);
  }

  if (document.actions.every((action) => action.kind === 'wait')) {
    problems.push('every action is a wait, so this rule does nothing');
  }

  /**
   * A wait at the end of a list finishes nothing. Harmless, so it is said
   * rather than refused — but it is almost always half of an intention
   * somebody did not finish typing.
   */
  if (document.actions.at(-1)?.kind === 'wait') {
    warnings.push('the last action is a wait, which delays the end of the run and nothing else');
  }
}

// ── Cycles ───────────────────────────────────────────────────────────────────

/**
 * Would this rule and another one keep each other going?
 *
 * The check is deliberately coarse: build the set of devices each automation
 * *writes* to and the set it *watches*, then look for a path from this
 * document back to itself. It over-reports — a condition may break the loop
 * on the second pass, and a thermostat is a cycle by design — which is
 * exactly why the answer is a warning rather than a refusal.
 *
 * Coarse and honest beats precise and wrong here. The engine's causation
 * depth and its circuit breaker (`guards.ts`) are what actually stop a
 * runaway; this is what stops somebody *shipping* one, by putting the sentence
 * in front of the agent that wrote it and the person about to enable it.
 */
function checkCycles(
  document: AutomationDocument,
  home: AutomationHomeView,
  warnings: string[],
  options: SanityOptions,
): void {
  const selfId = options.selfId ?? '__draft__';
  const others = home.automations.filter((entry) => entry.id !== selfId && entry.enabled);

  const writes = new Map<string, Set<string>>();
  const watches = new Map<string, Set<string>>();
  writes.set(selfId, writtenDevices(document, home));
  watches.set(selfId, watchedDevices(document, home));
  for (const entry of others) {
    writes.set(entry.id, writtenDevices(entry.document, home));
    watches.set(entry.id, watchedDevices(entry.document, home));
  }

  // Breadth-first from this rule's writes, following "somebody watches what I
  // write, and writes something of their own".
  const seen = new Set<string>([selfId]);
  let frontier = [selfId];
  const chain: string[] = [];

  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      const written = writes.get(id) ?? new Set();
      if (written.size === 0) continue;
      for (const [candidateId, watched] of watches) {
        if (candidateId === id) continue;
        const overlaps = [...written].some((deviceId) => watched.has(deviceId));
        if (!overlaps) continue;
        if (candidateId === selfId) {
          const name =
            id === selfId ? document.name : (home.automations.find((entry) => entry.id === id)?.name ?? id);
          chain.push(name);
          warnings.push(
            `this rule writes to a device "${name}" watches, and "${name}" writes back to one ` +
              `this rule watches. That is a loop unless a condition breaks it — check it before ` +
              `enabling. The hub will cut the chain and switch the rule off if it runs away.`,
          );
          return;
        }
        if (!seen.has(candidateId)) {
          seen.add(candidateId);
          next.push(candidateId);
        }
      }
    }
    frontier = next;
  }

  /**
   * The tightest loop of all, and the one a model writes by accident: a rule
   * that watches a device and then writes to that same device. "When the lamp
   * goes on, set it to 40%" is a legitimate version of this, so it is a
   * warning — but it is the shape worth naming on its own, because the
   * general search above cannot see it (a rule is never its own neighbour).
   */
  const own = writes.get(selfId) ?? new Set();
  const seenByItself = [...own].filter((deviceId) => (watches.get(selfId) ?? new Set()).has(deviceId));
  if (seenByItself.length > 0 && chain.length === 0) {
    const names = seenByItself
      .map((id) => home.devices.find((device) => device.id === id)?.name ?? id)
      .slice(0, 3);
    warnings.push(
      `this rule writes to ${names.join(', ')}, which it also watches — each run can trigger ` +
        `the next one`,
    );
  }
}

function writtenDevices(document: AutomationDocument, home: AutomationHomeView): Set<string> {
  const ids = new Set<string>();
  for (const action of [...document.actions, ...(document.offActions ?? [])]) {
    if (action.kind !== 'deviceCommand') continue;
    const capability = commandCapability(action.command.type);
    const resolved = resolveTarget(
      action.target,
      home,
      capability !== null ? { capability } : {},
    );
    for (const entry of resolved) ids.add(entry.deviceId);
  }
  return ids;
}

function watchedDevices(document: AutomationDocument, home: AutomationHomeView): Set<string> {
  const ids = new Set<string>();
  for (const trigger of document.triggers) {
    if (trigger.kind !== 'deviceState' && trigger.kind !== 'deviceEvent') continue;
    for (const entry of resolveTarget(trigger.target, home)) ids.add(entry.deviceId);
  }
  return ids;
}
