import type { CapabilityKind } from '../schema/index.js';
import {
  commandCapability,
  type AutomationAction,
  type AutomationCondition,
  type AutomationDocument,
  type AutomationTarget,
  type AutomationTrigger,
} from './schema.js';
import { resolveTarget, type AutomationHomeView } from './targets.js';

/**
 * Where a rule happens.
 *
 * Most rules in a home are about one room — the hall light and the hall motion
 * sensor, the bedroom blinds on a schedule — and knowing that is what lets an
 * app put a rule on the page of the room it belongs to instead of only in one
 * long list. This module is the one place that question is answered.
 *
 * **It is derived, never stored.** A rule's rooms are a function of the
 * document *and of the home as it is right now*: a selector picks up a lamp
 * paired next month, and a device moved from the Kitchen to the Hall changes
 * which room a rule belongs to without the rule being touched. A column would
 * be a second copy of that going stale in the dark, so this is computed on
 * every read — the same stance `describeAutomation` takes beside it, and cheap
 * for the same reason (a home is tens of devices, not thousands).
 */

/** One target, with the capability the engine will look for at the far end. */
interface ScopedTarget {
  target: AutomationTarget;
  /** `null` for a read: a trigger or a condition watches whatever is there. */
  capability: CapabilityKind | null;
}

/**
 * The one room every device this rule touches sits in, or `null`.
 *
 * `null` is the ordinary answer for a rule about the whole house, and it means
 * exactly one thing: *this rule is not one room's*. Four ways to get it — the
 * rule touches devices in two rooms, it touches a device nobody has placed
 * yet, it touches no devices at all (a button that runs another rule), or the
 * only room it named has since been deleted.
 *
 * **A selector that names a room declares one**, whether or not anything is in
 * it yet: "every light in the Kitchen" is the Kitchen's rule on the day it is
 * written, and would otherwise become the Kitchen's only once somebody paired
 * a lamp. Everything a room selector resolves to is in that room by
 * construction, so naming it is also the whole of that target's answer.
 *
 * **Touching an unplaced device disqualifies the rule.** A device in the "not
 * in a room" bucket is somewhere — nobody has said where — so a rule reaching
 * into it is not confined to a room, and becomes confined the moment that
 * device is placed. That is the same live derivation as everything else here,
 * pointed at the case that looks like an edge and is really just an unfinished
 * home.
 *
 * **A `runAutomation` action is deliberately not followed.** The rule it names
 * is its own rule with its own room and its own page; chasing it would need
 * cycle protection for an answer that belongs to somebody else.
 */
export function automationRoom(
  document: AutomationDocument,
  home: AutomationHomeView,
): string | null {
  const roomOf = new Map(home.devices.map((device) => [device.id, device.roomId]));
  const rooms = new Set<string>();

  for (const { target, capability } of automationTargets(document)) {
    if ('select' in target && target.select.roomId !== undefined) {
      // A room the home no longer has is not a room this rule is in: the
      // document outlived the room, `sanity.ts` reports that as a problem, and
      // an id nothing can be looked up under is worse than no answer.
      if (home.rooms.some((room) => room.id === target.select.roomId)) {
        rooms.add(target.select.roomId);
      }
      continue;
    }

    for (const entry of resolveTarget(
      target,
      home,
      capability !== null ? { capability } : {},
    )) {
      const room = roomOf.get(entry.deviceId) ?? null;
      if (room === null) return null;
      rooms.add(room);
    }

    if (rooms.size > 1) return null;
  }

  return rooms.size === 1 ? [...rooms][0]! : null;
}

/**
 * Every place a rule reads from or writes to.
 *
 * Triggers, conditions — nested ones included, since `all`/`any`/`not` hold
 * more of them — actions, and a toggle's off-actions. Deliberately all four:
 * a rule that watches the Kitchen and switches something in the Hall is not
 * the Kitchen's, and a walk that looked only at what a rule *does* would say
 * it was.
 *
 * A command carries the capability the engine will need, exactly as the engine
 * and `sanity.ts` resolve it, so the devices counted here are the devices the
 * run would actually reach. A read carries none: a trigger watches whatever
 * endpoint is there.
 */
function* automationTargets(document: AutomationDocument): Generator<ScopedTarget> {
  for (const trigger of document.triggers) yield* triggerTargets(trigger);
  for (const condition of document.conditions ?? []) yield* conditionTargets(condition);
  for (const action of [...document.actions, ...(document.offActions ?? [])]) {
    yield* actionTargets(action);
  }
}

function* triggerTargets(trigger: AutomationTrigger): Generator<ScopedTarget> {
  if (trigger.kind === 'deviceState' || trigger.kind === 'deviceEvent') {
    yield { target: trigger.target, capability: null };
  }
}

function* conditionTargets(condition: AutomationCondition): Generator<ScopedTarget> {
  switch (condition.kind) {
    case 'deviceState':
      yield { target: condition.target, capability: null };
      return;
    case 'all':
    case 'any':
      for (const nested of condition.conditions) yield* conditionTargets(nested);
      return;
    case 'not':
      yield* conditionTargets(condition.condition);
      return;
    default:
      return;
  }
}

function* actionTargets(action: AutomationAction): Generator<ScopedTarget> {
  if (action.kind === 'deviceCommand') {
    yield { target: action.target, capability: commandCapability(action.command.type) };
  }
}
