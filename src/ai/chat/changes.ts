import type { EndpointState, HubCommand } from '../../schema/index.js';

/**
 * What a reply changed in the home, kept with the reply.
 *
 * An assistant that switches four lamps off answers in a sentence, and until
 * this the sentence was all there was: nothing an app could draw as the four
 * lamps, and nothing to put back if "everything in the Kitchen" turned out to
 * mean more than was meant. So each device a round works is written down **at
 * the moment its command is sent** — what was set, and what it was before —
 * and the list rides on the row the round writes (`data.changes`) and on the
 * socket as it grows (`chatChanges`).
 *
 * **Both halves are commands.** `set` is the command that went out and
 * `before` is the command that would put the device back, which is the one
 * shape every client already knows how to read and to send: there is no
 * second vocabulary of "values" beside the schema's own. A `toggle` is
 * written down as the `power` it turned out to be, since "flipped" says
 * nothing about where the lamp ended up.
 *
 * **`before` is absent when nothing could be read** — a device that has never
 * reported the value, or a command with no state behind it (an IR code, a
 * blind told to stop). Absent means *cannot be put back*, never "was off".
 */
export interface ChatChangeWire {
  deviceId: string;
  endpointId: number;
  /** What the home called the device when it was worked. */
  name: string;
  /** When the (first) command to it went out. */
  at: string;
  /** What was set, as the command that set it. */
  set: HubCommand;
  /** What it was before, as the command that would put it back. */
  before?: HubCommand;
}

/** How many devices one round's list holds. A whole-home request is tens. */
export const MAX_ROUND_CHANGES = 60;

/** How far a reading may sit from what was asked and still be "as asked" —
 *  devices round, clamp and report in their own steps. */
const NEAR = {
  level: 3,
  mireds: 15,
  hue: 4,
  saturation: 4,
  centi: 50,
  covering: 300,
  fanPercent: 3,
} as const;

const near = (a: number, b: number, by: number): boolean => Math.abs(a - b) <= by;

/**
 * The command that would put a device back the way it is now, given the
 * command about to be sent — or `undefined` when that cannot be said.
 */
export function commandBefore(command: HubCommand, state: EndpointState | undefined): HubCommand | undefined {
  if (state === undefined) return undefined;
  switch (command.type) {
    case 'power':
    case 'toggle':
      return state.onOff !== undefined ? { type: 'power', on: state.onOff } : undefined;
    case 'setLevel':
      return state.level !== undefined ? { type: 'setLevel', level: state.level.current } : undefined;
    case 'setColorTemperature':
      return state.colorTemperature !== undefined
        ? { type: 'setColorTemperature', mireds: state.colorTemperature.mireds }
        : undefined;
    case 'setHueSaturation':
      return state.colorHS !== undefined
        ? { type: 'setHueSaturation', hue: state.colorHS.hue, saturation: state.colorHS.saturation }
        : undefined;
    case 'setHeatingSetpoint':
      return state.thermostat?.occupiedHeatingSetpointCenti !== undefined
        ? { type: 'setHeatingSetpoint', centi: state.thermostat.occupiedHeatingSetpointCenti }
        : undefined;
    case 'setCoolingSetpoint':
      return state.thermostat?.occupiedCoolingSetpointCenti !== undefined
        ? { type: 'setCoolingSetpoint', centi: state.thermostat.occupiedCoolingSetpointCenti }
        : undefined;
    case 'setSystemMode':
      return state.thermostat !== undefined
        ? { type: 'setSystemMode', mode: state.thermostat.systemMode }
        : undefined;
    case 'lock':
      // 0 is "not fully locked": neither state, so not something to go back to.
      if (state.lock === 1) return { type: 'lock', engage: true };
      if (state.lock === 2) return { type: 'lock', engage: false };
      return undefined;
    case 'setCoveringPercent':
    case 'openCovering':
    case 'closeCovering':
      return state.covering !== undefined
        ? { type: 'setCoveringPercent', percent100ths: state.covering.currentPositionLiftPercent100ths }
        : undefined;
    case 'setFanPercent':
      return state.fan !== undefined
        ? { type: 'setFanPercent', percent: state.fan.percentSetting ?? state.fan.percentCurrent }
        : undefined;
    case 'setFanMode':
      return state.fan !== undefined ? { type: 'setFanMode', mode: state.fan.mode } : undefined;
    case 'playPause':
      return state.playbackPlaying !== undefined
        ? { type: 'playPause', play: state.playbackPlaying }
        : undefined;
    case 'setMode':
      return state.currentMode !== undefined ? { type: 'setMode', mode: state.currentMode } : undefined;
    case 'setCustomField': {
      const value = state.custom?.values?.[command.fieldId];
      return value !== undefined ? { type: 'setCustomField', fieldId: command.fieldId, value } : undefined;
    }
    default:
      // Stopping a blind, an IR code, the IR library: nothing to go back to.
      return undefined;
  }
}

/** A command as the change it made — a `toggle` as the `power` it came to. */
export function commandAsSet(command: HubCommand, before: HubCommand | undefined): HubCommand {
  if (command.type === 'toggle' && before?.type === 'power') return { type: 'power', on: !before.on };
  return command;
}

/**
 * Whether a device is, right now, the way a command would leave it.
 * `undefined` when the device says nothing about it either way.
 */
export function commandHolds(command: HubCommand, state: EndpointState | undefined): boolean | undefined {
  if (state === undefined) return undefined;
  switch (command.type) {
    case 'power':
      return state.onOff === undefined ? undefined : state.onOff === command.on;
    case 'setLevel':
      return state.level === undefined ? undefined : near(state.level.current, command.level, NEAR.level);
    case 'setColorTemperature':
      return state.colorTemperature === undefined
        ? undefined
        : near(state.colorTemperature.mireds, command.mireds, NEAR.mireds);
    case 'setHueSaturation':
      return state.colorHS === undefined
        ? undefined
        : near(state.colorHS.hue, command.hue, NEAR.hue) &&
            near(state.colorHS.saturation, command.saturation, NEAR.saturation);
    case 'setHeatingSetpoint': {
      const now = state.thermostat?.occupiedHeatingSetpointCenti;
      return now === undefined ? undefined : near(now, command.centi, NEAR.centi);
    }
    case 'setCoolingSetpoint': {
      const now = state.thermostat?.occupiedCoolingSetpointCenti;
      return now === undefined ? undefined : near(now, command.centi, NEAR.centi);
    }
    case 'setSystemMode':
      return state.thermostat === undefined ? undefined : state.thermostat.systemMode === command.mode;
    case 'lock':
      return state.lock === undefined ? undefined : state.lock === (command.engage ? 1 : 2);
    case 'setCoveringPercent':
    case 'openCovering':
    case 'closeCovering': {
      if (state.covering === undefined) return undefined;
      const wanted =
        command.type === 'openCovering' ? 0 : command.type === 'closeCovering' ? 10_000 : command.percent100ths;
      // Where it is going counts as where it is: a blind half way down on its
      // way to what was asked has not been changed by anybody since.
      const at = state.covering.targetPositionLiftPercent100ths ?? state.covering.currentPositionLiftPercent100ths;
      return (
        near(at, wanted, NEAR.covering) ||
        near(state.covering.currentPositionLiftPercent100ths, wanted, NEAR.covering)
      );
    }
    case 'setFanPercent':
      return state.fan === undefined
        ? undefined
        : near(state.fan.percentSetting ?? state.fan.percentCurrent, command.percent, NEAR.fanPercent);
    case 'setFanMode':
      return state.fan === undefined ? undefined : state.fan.mode === command.mode;
    case 'playPause':
      return state.playbackPlaying === undefined ? undefined : state.playbackPlaying === command.play;
    case 'setMode':
      return state.currentMode === undefined ? undefined : state.currentMode === command.mode;
    case 'setCustomField': {
      const value = state.custom?.values?.[command.fieldId];
      return value === undefined ? undefined : value === command.value;
    }
    default:
      return undefined;
  }
}

/**
 * Why one change is not put back. An **open** vocabulary on the wire.
 *
 *  - `lock` — putting it back would unlock a door. Never, whoever asks.
 *  - `changed_since` — the device is no longer the way the reply left it:
 *    somebody, or a rule, has changed it again, and undoing an old answer
 *    over a newer decision is not undoing.
 *  - `already_as_before` — it is already the way it was.
 *  - `no_before` — what it was before was never known.
 *  - `gone` — the device is no longer in the home.
 *  - `failed` — it was asked and did not take the command.
 */
export type UndoSkip = 'lock' | 'changed_since' | 'already_as_before' | 'no_before' | 'gone' | 'failed';

/**
 * Whether one change may be put back, against the device as it is now.
 *
 * **The lock rule is first and has no exception**: an undo is one tap on a
 * card, and a door must never open because somebody tapped a card under an
 * old message. Re-locking is still an undo anybody may make.
 *
 * **"Changed since" is asked of the device, not of a log.** A wall switch
 * leaves no row anywhere; the device's own state is the one witness to
 * everything that has happened to it. A device that no longer says what the
 * reply set — or says nothing at all — is left alone.
 */
export function undoVerdict(change: ChatChangeWire, state: EndpointState | undefined): UndoSkip | null {
  if (change.before === undefined) return 'no_before';
  if (change.before.type === 'lock' && !change.before.engage) return 'lock';
  if (commandHolds(change.before, state) === true && commandHolds(change.set, state) !== true) {
    return 'already_as_before';
  }
  if (commandHolds(change.set, state) !== true) return 'changed_since';
  return null;
}

/**
 * Add one command to a round's list.
 *
 * A device worked twice in one round — switched on, then dimmed — is two
 * entries, because they are two things to put back. The same *kind* of command
 * to it twice is one: the first `before` is the one that was true before the
 * reply, and the last `set` is where the reply left it.
 */
export function mergeChange(changes: ChatChangeWire[], change: ChatChangeWire): ChatChangeWire[] {
  const index = changes.findIndex(
    (entry) =>
      entry.deviceId === change.deviceId &&
      entry.endpointId === change.endpointId &&
      entry.set.type === change.set.type &&
      (entry.set.type !== 'setCustomField' ||
        (change.set.type === 'setCustomField' && entry.set.fieldId === change.set.fieldId)),
  );
  if (index === -1) {
    return changes.length >= MAX_ROUND_CHANGES ? changes : [...changes, change];
  }
  const merged = [...changes];
  const first = merged[index]!;
  merged[index] = { ...first, name: change.name, set: change.set };
  return merged;
}

/** Read a stored row's list back, dropping anything that is not one. */
export function changesOf(data: unknown): ChatChangeWire[] {
  const raw = (data as { changes?: unknown } | null | undefined)?.changes;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is ChatChangeWire =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as ChatChangeWire).deviceId === 'string' &&
      typeof (entry as ChatChangeWire).endpointId === 'number' &&
      typeof (entry as ChatChangeWire).set === 'object' &&
      (entry as ChatChangeWire).set !== null,
  );
}
