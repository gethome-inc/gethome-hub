import {
  celsiusFromCenti,
  kelvinFromMireds,
  percentFromLevel,
  type HubCommand,
} from '../schema/index.js';
import { formatDuration, formatValue, scaled } from './phrasing.js';
import type { GuardRefusal } from './guards.js';
import type { Comparator, ReadablePath } from './schema.js';

/**
 * What happened, the way somebody in the house would say it.
 *
 * `summarize.ts` and `outline.ts` say what a rule *will* do; this says what one
 * *did* — the `cause` of a firing and the `summary` of each step in its trace.
 * Both apps print those two strings exactly as they arrive, in every build
 * that has ever shipped, which is the whole reason the words are made here: a
 * trace that read "Motion sensor T1 87BC sensors.occupied eq true" and
 * "Motion LED: power" was the hub's own vocabulary on a person's screen, and
 * making it a sentence here fixes the phones already out there.
 *
 * Three rules.
 *
 *  - **The home's names, never the schema's.** A device is what the home calls
 *    it and a reading is where it was taken ("Motion in the Hall"), because a
 *    capability path is something nobody in the house has ever said.
 *  - **The exact terms are kept, beside the sentence.** Every narration
 *    returns `detail` with the path, the comparator and the value as stored —
 *    what somebody debugging a rule is actually looking for, and what the
 *    sentence deliberately leaves out.
 *  - **Past tense, because it happened.** The storyboard's "goes above" is a
 *    rule waiting; a trace's "went above" is the moment it stopped waiting.
 *
 * Deliberately English and deliberately plain, as the sentence and the
 * storyboard are: the apps localise, the hub does not pretend to.
 */

export interface Narration {
  /** The sentence a person reads. */
  text: string;
  /** The same fact in the hub's exact terms. */
  detail: string;
}

/** A device as a trace names it. */
export interface NarratedDevice {
  name: string;
  /** The room it has been placed in, when it has been. */
  room?: string | undefined;
  online?: boolean | undefined;
}

/**
 * "in the Kitchen", and "in Anna’s room".
 *
 * A room's name is whatever somebody typed, and most of them want an article
 * the name does not carry ("Kitchen", "Living Room"). The ones that do not are
 * recognisable: a possessive, or a name that already starts with an article or
 * a determiner. Getting this wrong costs a slightly stiff sentence, never a
 * false one.
 */
export function inRoom(room: string): string {
  const bare = /^(the|my|our|your|his|her|their)\s/i.test(room) || /['’]s?\s/.test(room);
  return bare ? `in ${room}` : `in the ${room}`;
}

// ── What set a rule off ──────────────────────────────────────────────────────

/** Readings that describe the room rather than the device taking them. */
const AMBIENT: Partial<Record<ReadablePath, string>> = {
  'sensors.temperatureCenti': 'Temperature',
  'sensors.humidityCenti': 'Humidity',
  'sensors.illuminanceLux': 'Light level',
  'sensors.co2ppm': 'CO₂',
  'sensors.pm25': 'Particulates',
  'sensors.pressureHPa': 'Pressure',
  'sensors.airQuality': 'Air quality',
};

/** Readings that belong to the device itself, said after its name. */
const OWN: Partial<Record<ReadablePath, string>> = {
  'level.current': 'brightness',
  'colorTemperature.mireds': 'warmth',
  'thermostat.localTemperatureCenti': 'temperature',
  'thermostat.occupiedHeatingSetpointCenti': 'heating setpoint',
  'thermostat.occupiedCoolingSetpointCenti': 'cooling setpoint',
  'thermostat.systemMode': 'mode',
  lock: 'lock',
  'covering.currentPositionLiftPercent100ths': 'position',
  'fan.mode': 'fan mode',
  'fan.percentCurrent': 'fan speed',
  'sensors.flowCubicMetersPerHour': 'water flow',
  'sensors.smokeAlarm': 'smoke alarm',
  'sensors.coAlarm': 'CO alarm',
  'battery.percent': 'battery',
  'power.activeMilliwatts': 'power draw',
  'power.importedEnergyMilliwattHours': 'energy use',
  currentMode: 'mode',
  rvcOperationalState: 'state',
};

const WENT: Record<Comparator, string> = {
  eq: 'reached',
  ne: 'moved off',
  lt: 'went below',
  lte: 'dropped to',
  gt: 'went above',
  gte: 'reached',
  changed: 'changed',
};

/**
 * The clauses a yes/no reading wants, as the moment it flipped and as a state
 * it then stayed in (`for`). Each is given the device and answers a whole
 * sentence, because where the subject goes differs: motion is somewhere, a
 * door did something.
 */
const FLIPPED: Partial<
  Record<
    ReadablePath,
    {
      on: (device: NarratedDevice) => string;
      off: (device: NarratedDevice) => string;
      /** While it stayed that way — what a held trigger reports. */
      stayedOn?: (device: NarratedDevice) => string;
      stayedOff?: (device: NarratedDevice) => string;
    }
  >
> = {
  'sensors.occupied': {
    on: (device) => (device.room ? `Motion ${inRoom(device.room)}` : `${device.name} saw motion`),
    off: (device) =>
      device.room ? `Motion stopped ${inRoom(device.room)}` : `${device.name} stopped seeing motion`,
    stayedOn: (device) =>
      device.room ? `Motion ${inRoom(device.room)}` : `${device.name} kept seeing motion`,
    stayedOff: (device) =>
      device.room ? `No motion ${inRoom(device.room)}` : `${device.name} saw no motion`,
  },
  'sensors.contactClosed': {
    on: (device) => `${device.name} closed`,
    off: (device) => `${device.name} opened`,
    stayedOn: (device) => `${device.name} stayed closed`,
    stayedOff: (device) => `${device.name} stayed open`,
  },
  onOff: {
    on: (device) => `${device.name} was switched on`,
    off: (device) => `${device.name} was switched off`,
    stayedOn: (device) => `${device.name} stayed on`,
    stayedOff: (device) => `${device.name} stayed off`,
  },
  reachable: {
    on: (device) => `${device.name} came back`,
    off: (device) => `${device.name} went offline`,
    stayedOn: (device) => `${device.name} stayed connected`,
    stayedOff: (device) => `${device.name} stayed offline`,
  },
  playbackPlaying: {
    on: (device) => `${device.name} started playing`,
    off: (device) => `${device.name} stopped playing`,
  },
};

/**
 * Readings that are a short scale of *states* rather than an amount — an
 * alarm, a lock — said by the state the device is now in.
 *
 * These are numbers on the wire (0 normal · 1 warning · 2 critical; 1 locked ·
 * 2 unlocked), so a rule tests them with a threshold, and reading the
 * threshold out loud gave "Hall detector sensors.smokeAlarm reached 1": the
 * path and a code, in the one sentence that matters most when it is true. The
 * device's own reading at the moment the rule fired says which state that is.
 * `null` is a value with no word, which falls back to the plain form below.
 */
const STATES: Partial<
  Record<ReadablePath, (value: number, device: NarratedDevice) => { now: string; stayed?: string } | null>
> = {
  'sensors.smokeAlarm': (value, device) =>
    value <= 0
      ? { now: `${device.name} stopped detecting smoke` }
      : {
          now:
            `${value === 1 ? 'Smoke warning' : 'Smoke'} ` +
            (device.room ? inRoom(device.room) : `at ${device.name}`),
        },
  'sensors.coAlarm': (value, device) =>
    value <= 0
      ? { now: `${device.name} stopped detecting carbon monoxide` }
      : {
          now:
            `${value === 1 ? 'Carbon monoxide warning' : 'Carbon monoxide'} ` +
            (device.room ? inRoom(device.room) : `at ${device.name}`),
        },
  lock: (value, device) =>
    value === 1
      ? { now: `${device.name} was locked`, stayed: `${device.name} stayed locked` }
      : value === 2
        ? { now: `${device.name} was unlocked`, stayed: `${device.name} stayed unlocked` }
        : value === 0
          ? { now: `${device.name} was left not fully locked`, stayed: `${device.name} stayed not fully locked` }
          : null,
  'sensors.airQuality': (value, device) => {
    // Matter's own scale; 0 is "unknown", which is not a state to announce.
    const word = [null, 'good', 'fair', 'moderate', 'poor', 'very poor', 'extremely poor'][value];
    if (word === null || word === undefined) return null;
    return {
      now: device.room
        ? `Air quality ${inRoom(device.room)} became ${word}`
        : `${device.name} air quality became ${word}`,
    };
  },
};

/**
 * Numbers that *name* a mode. The number says nothing out loud — "mode 4" is
 * a lookup nobody in the house can do — so the sentence says that it changed
 * and the detail says to what.
 */
const MODES: ReadonlySet<ReadablePath> = new Set<ReadablePath>([
  'thermostat.systemMode',
  'fan.mode',
  'currentMode',
  'rvcOperationalState',
]);

/**
 * A reading crossed the line a rule draws.
 *
 * `actual` is what the device read at the moment of crossing. A threshold
 * says where the line is; for a reading that is a state rather than an amount
 * it is the reading itself that says what happened.
 *
 * `heldMs` is the trigger's `for`, when it has one: the firing then reports a
 * state that lasted rather than a moment, so "No motion in the Hall for 20
 * minutes" rather than "Motion stopped in the Hall".
 */
export function narrateStateCause(
  trigger: {
    path: ReadablePath;
    op: Comparator;
    value?: number | boolean | undefined;
    for?: number | undefined;
  },
  device: NarratedDevice,
  actual?: number | boolean | undefined,
): Narration {
  const held = trigger.for !== undefined && trigger.for > 0 ? trigger.for : undefined;
  const lasting = held !== undefined ? ` for ${formatDuration(held)}` : '';
  const detail =
    `${device.name} · ${trigger.path} ${trigger.op}` +
    (trigger.value !== undefined ? ` ${String(trigger.value)}` : '') +
    // The reading itself, where it is not simply the value tested for.
    (typeof actual === 'number' && actual !== trigger.value ? ` · read ${actual}` : '') +
    (held !== undefined ? ` · held for ${held / 1000}s` : '');

  if (typeof actual === 'number') {
    const state = STATES[trigger.path]?.(actual, device);
    if (state) {
      return { text: `${held !== undefined ? (state.stayed ?? state.now) : state.now}${lasting}`, detail };
    }
  }
  if (MODES.has(trigger.path)) {
    return { text: `${device.name} changed ${OWN[trigger.path] ?? 'mode'}${lasting}`, detail };
  }

  const flipped = FLIPPED[trigger.path];
  if (flipped !== undefined && typeof trigger.value === 'boolean' && trigger.op !== 'changed') {
    const yes = trigger.op === 'ne' ? !trigger.value : trigger.value;
    const moment = yes ? flipped.on : flipped.off;
    const state = yes ? flipped.stayedOn : flipped.stayedOff;
    const say = held !== undefined && state !== undefined ? state : moment;
    return { text: `${say(device)}${lasting}`, detail };
  }

  const went =
    trigger.op === 'changed'
      ? 'changed'
      : `${WENT[trigger.op]} ${formatValue(trigger.value, trigger.path)}`.trim();
  const ambient = AMBIENT[trigger.path];
  const subject =
    ambient !== undefined && device.room !== undefined
      ? `${ambient} ${inRoom(device.room)}`
      : `${device.name} ${ambient?.toLowerCase() ?? OWN[trigger.path] ?? trigger.path}`;
  return { text: `${subject} ${went}${lasting}`, detail };
}

/** A button, a remote, a wall switch — pressed. */
export function narrateEventCause(
  device: NarratedDevice,
  event: { button?: string | undefined; gesture?: string | undefined; action?: string | undefined },
): Narration {
  const exact = [event.button, event.gesture, event.action].filter(Boolean).join(' ');
  const how = [event.gesture, event.button].filter(Boolean).join(', ');
  return {
    text: `${device.name} was pressed${how ? ` (${how})` : ''}`,
    detail: `${device.name} · event${exact ? ` ${exact}` : ''}`,
  };
}

// ── What a run did ───────────────────────────────────────────────────────────

/** A command exactly as it was sent: `power on=true`, `setLevel level=102`. */
export function commandTerms(command: HubCommand): string {
  const fields = Object.entries(command)
    .filter(([key]) => key !== 'type')
    .map(([key, value]) => `${key}=${String(value)}`);
  return [command.type, ...fields].join(' ');
}

/**
 * What a device was asked to do, once it has been asked: "turned on", "closed
 * to 40%". The verb phrase only — the caller puts the device in front of it.
 */
export function commandDid(command: HubCommand): string {
  switch (command.type) {
    case 'power':
      return command.on ? 'turned on' : 'turned off';
    case 'toggle':
      return 'was flipped';
    case 'setLevel':
      return `set to ${percentFromLevel(command.level)}%`;
    case 'setColorTemperature':
      return `set to ${Math.round(kelvinFromMireds(command.mireds))} K`;
    case 'setHueSaturation':
      return 'changed colour';
    case 'setHeatingSetpoint':
      return `heating set to ${celsiusFromCenti(command.centi)} °C`;
    case 'setCoolingSetpoint':
      return `cooling set to ${celsiusFromCenti(command.centi)} °C`;
    case 'setSystemMode':
      return 'changed mode';
    case 'lock':
      return command.engage ? 'locked' : 'unlocked';
    case 'setCoveringPercent':
      // Matter's own units, where 0 is fully open — see `phrasing.ts`.
      if (command.percent100ths <= 0) return 'opened';
      if (command.percent100ths >= 10_000) return 'closed';
      return `closed to ${scaled(command.percent100ths, 100)}%`;
    case 'openCovering':
      return 'opened';
    case 'closeCovering':
      return 'closed';
    case 'stopCovering':
      return 'stopped';
    case 'setFanPercent':
      return `fan set to ${command.percent}%`;
    case 'setFanMode':
      return 'changed fan mode';
    case 'playPause':
      return command.play ? 'started playing' : 'paused';
    case 'setMode':
      return 'changed mode';
    case 'irSend':
      return 'sent a remote command';
    case 'setCustomField':
      return `${command.fieldId} set to ${String(command.value)}`;
    default:
      // A command this build has no words for is still something that was
      // done, and its own type is the truest thing to say about it.
      return `was sent ${(command as { type: string }).type}`;
  }
}

/** A command that went out. */
export function narrateCommand(device: NarratedDevice, command: HubCommand): Narration {
  return { text: `${device.name} ${commandDid(command)}`, detail: commandTerms(command) };
}

/**
 * A command that went out to a device the hub could not reach at the time.
 *
 * It is still sent — a sleeping battery device takes it when it next wakes —
 * but "turned on" would be a claim about a lamp nobody can see, so the step
 * says what is actually known: it was offline, and this was sent anyway.
 */
export function narrateSentWhileOffline(device: NarratedDevice, command: HubCommand): Narration {
  return {
    text: `${device.name} was offline when this was sent`,
    detail: `${commandTerms(command)} · sent while the device was offline`,
  };
}

/** What a device already being the way it was asked to be reads as. */
function alreadyThere(command: HubCommand): string {
  switch (command.type) {
    case 'power':
      return command.on ? 'was already on' : 'was already off';
    case 'lock':
      return command.engage ? 'was already locked' : 'was already unlocked';
    case 'openCovering':
      return 'was already open';
    case 'closeCovering':
      return 'was already closed';
    case 'playPause':
      return command.play ? 'was already playing' : 'was already paused';
    default:
      return 'was already set that way';
  }
}

/**
 * A command a guard declined to send.
 *
 * `unchanged` is not a refusal anybody needs to hear as one — the lamp was
 * already on, which is the rule working — so it reads as a fact about the
 * device. The other four are the hub protecting a relay, and say so.
 */
export function narrateRefusal(
  device: NarratedDevice,
  command: HubCommand,
  refusal: GuardRefusal,
): Narration {
  const detail = `${commandTerms(command)} · ${refusal.detail}`;
  switch (refusal.kind) {
    case 'unchanged':
      return { text: `${device.name} ${alreadyThere(command)}`, detail };
    case 'too_soon':
      return { text: `${device.name} was left alone — it had just been changed`, detail };
    case 'hourly_budget':
      return {
        text: `${device.name} was left alone — rules have changed it too often this hour`,
        detail,
      };
    case 'daily_budget':
      return {
        text: `${device.name} was left alone — rules have changed it too often today`,
        detail,
      };
    case 'too_deep':
      return {
        text: `${device.name} was left alone — rules were setting each other off`,
        detail,
      };
    default:
      return { text: `${device.name} was left alone`, detail };
  }
}

/** A command that was sent and that the device, or the radio, did not take. */
export function narrateFailure(
  device: NarratedDevice,
  command: HubCommand,
  error: string,
  /**
   * How the radio classed it, when it did (`commandFailed.kind`, an open
   * string): `refused` is a device that answered and said no, which is not
   * the same thing to go and look at as one that never answered.
   */
  kind?: string,
): Narration {
  const text =
    kind === 'refused'
      ? `${device.name} refused the command`
      : device.online === false
        ? `${device.name} didn’t answer — it was offline`
        : `${device.name} didn’t answer`;
  return { text, detail: `${commandTerms(command)} · ${error}` };
}
