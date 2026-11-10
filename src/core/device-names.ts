import type { CapabilityKind, DeviceKind } from '../schema/index.js';

/**
 * What a device is called when nobody has called it anything.
 *
 * A device adopted from Zigbee used to be named after its model — "Smart
 * temperature and humidity sensor FEA7" — and that string then stood on every
 * card, in every answer the assistant gave and in every line of the activity
 * log. It was true and it was nobody's word for the thing on their shelf. A
 * new device is now given a short plain name for **what it is**: "Climate
 * sensor", "Motion sensor", "Plug".
 *
 * Three rules, and the second is the one that must never bend.
 *
 *  - **Worked out from what the device says it is**, with no key and no
 *    network: its kind, its capabilities, and — only where those leave it at a
 *    bare "Sensor" — the words in its own description. A home with no AI is
 *    named as well as one with it. Where recognition did ask a model, the name
 *    can come back in the same answer and is preferred.
 *  - **A name a person gave is never replaced**, by this or by anything else.
 *    Where a name came from is recorded (`DeviceNameSource`), and only a name
 *    the hub itself made up may be improved by the hub.
 *  - **A device that already has its model's name is not renamed**: it is
 *    offered one to three short names instead, on the device as the API sends
 *    it, until a person names it.
 *
 * English and plain, as every sentence the hub writes is: the apps localise.
 */

/**
 * Where a device's name came from.
 *
 *  - `person` — somebody set it through this hub. Never replaced.
 *  - `upstream` — somebody chose it in the protocol's own tool before the hub
 *    met the device: a Zigbee2MQTT friendly name, a Matter node label, the
 *    name an MQTT integrator gave it. A person's word too; never replaced.
 *  - `hub` — the hub's own short name, worked out from what the device is.
 *  - `recognition` — the hub's own short name, as recognition returned it.
 *  - `model` — the model's name, as devices were named before this: the raw
 *    string suggestions are offered over.
 *
 * `null` is a device named before this was recorded, about which the hub
 * cannot say — and so treats as a person's.
 */
export type DeviceNameSource = 'person' | 'upstream' | 'hub' | 'recognition' | 'model';

export const DEVICE_NAME_SOURCES: readonly DeviceNameSource[] = [
  'person',
  'upstream',
  'hub',
  'recognition',
  'model',
];

/** Read a stored source back; anything this build has not heard of is "cannot say". */
export function knownNameSource(value: unknown): DeviceNameSource | null {
  return DEVICE_NAME_SOURCES.includes(value as DeviceNameSource) ? (value as DeviceNameSource) : null;
}

/** Whether the hub may put a name of its own over this one. */
export function hubMayRename(source: DeviceNameSource | null): boolean {
  return source === 'hub';
}

/** As much of a device as naming needs. */
export interface NamedShape {
  endpoints: readonly { deviceKind: DeviceKind; capabilities: readonly CapabilityKind[] }[];
  /** What the device calls itself — a description, a model — as a last hint. */
  hint?: string | null | undefined;
}

const KIND_NAMES: Record<DeviceKind, string> = {
  light: 'Light',
  outlet: 'Plug',
  wallSwitch: 'Switch',
  remote: 'Button',
  sensor: 'Sensor',
  shade: 'Blind',
  lock: 'Lock',
  climate: 'Thermostat',
  fan: 'Fan',
  speaker: 'Speaker',
  tv: 'TV',
  vacuum: 'Vacuum',
  camera: 'Camera',
  airPurifier: 'Air purifier',
  appliance: 'Appliance',
  energy: 'Energy meter',
};

/**
 * What a sensor senses, most telling first. Smoke before motion before the
 * rest, because a device that does two of these is called after the one
 * somebody bought it for.
 */
function sensorName(capabilities: ReadonlySet<CapabilityKind>): string | null {
  if (capabilities.has('smokeCOAlarm')) return 'Smoke alarm';
  if (capabilities.has('occupancy')) return 'Motion sensor';
  if (capabilities.has('contact')) return 'Door sensor';
  if (capabilities.has('airQuality') || capabilities.has('co2')) return 'Air quality sensor';
  if (capabilities.has('temperature') && capabilities.has('humidity')) return 'Climate sensor';
  if (capabilities.has('temperature')) return 'Temperature sensor';
  if (capabilities.has('humidity')) return 'Humidity sensor';
  if (capabilities.has('illuminance')) return 'Light sensor';
  return null;
}

/**
 * The words a device's own description is read for, and only when its kind and
 * capabilities came to nothing better than "Sensor" — a leak or a vibration
 * sensor has no capability of its own in the schema, and says what it is in
 * the one line its maker wrote.
 */
const HINTS: readonly [RegExp, string][] = [
  [/\b(leak|water|flood)/i, 'Leak sensor'],
  [/\bvibration/i, 'Vibration sensor'],
  [/\b(smoke|fire)\b/i, 'Smoke alarm'],
  [/\b(motion|presence|occupancy|pir)\b/i, 'Motion sensor'],
  [/\b(door|window|contact|magnet)/i, 'Door sensor'],
  [/\b(temperature|humidity|climate|thermo)/i, 'Climate sensor'],
  [/\b(button|remote|knob|dimmer switch)/i, 'Button'],
  [/\b(plug|socket|outlet)\b/i, 'Plug'],
  [/\b(bulb|lamp|light|led)\b/i, 'Light'],
];

/** A short plain name for what a device is: "Climate sensor", "Plug". */
export function plainNameFor(shape: NamedShape): string {
  const kinds = shape.endpoints.map((endpoint) => endpoint.deviceKind);
  const capabilities = new Set(shape.endpoints.flatMap((endpoint) => [...endpoint.capabilities]));
  // The first endpoint that is not a bare sensor is what the device is: a plug
  // that also measures temperature is a plug.
  const kind = kinds.find((entry) => entry !== 'sensor') ?? kinds[0];

  if (kind === undefined || kind === 'sensor') {
    const sensed = sensorName(capabilities);
    if (sensed !== null) return sensed;
    const hinted = HINTS.find(([pattern]) => pattern.test(shape.hint ?? ''));
    if (hinted) return hinted[1];
    return kind === undefined ? 'Device' : KIND_NAMES.sensor;
  }
  if (kind === 'remote' && shape.endpoints.filter((endpoint) => endpoint.deviceKind === 'remote').length > 1) {
    return 'Remote';
  }
  return KIND_NAMES[kind] ?? 'Device';
}

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The name, or the name with the first number that makes it the only one in
 * the home: "Plug", then "Plug 2". Compared without regard to case, since
 * "plug" and "Plug" are one name to anybody saying it out loud.
 */
export function uniqueName(base: string, taken: readonly string[]): string {
  if (!taken.some((name) => same(name, base))) return base;
  for (let number = 2; number < 1000; number += 1) {
    const candidate = `${base} ${number}`;
    if (!taken.some((name) => same(name, candidate))) return candidate;
  }
  return base;
}

/** The longest a name the hub makes up, or takes from recognition, may be. */
export const PLAIN_NAME_MAX = 32;

/**
 * A name recognition returned, if it is one worth using: a couple of words,
 * no address, no model number. A model asked for "Climate sensor" that answers
 * with the product sheet is answered with the hub's own name instead.
 */
export function acceptablePlainName(name: string | null | undefined): string | null {
  const trimmed = name?.replace(/\s+/g, ' ').trim();
  if (!trimmed || trimmed.length > PLAIN_NAME_MAX) return null;
  if (trimmed.split(' ').length > 4) return null;
  if (/0x[0-9a-f]{4,}/i.test(trimmed) || /\d{3,}/.test(trimmed)) return null;
  return trimmed;
}

/**
 * "Kitchen plug": a room's name in front of a plain one. The plain name is
 * lowered unless it is an initialism ("TV"), and a room name is left exactly
 * as the home wrote it.
 */
function inRoomName(room: string, plain: string): string {
  const lowered = /^[A-Z]{2,}\b/.test(plain) ? plain : plain.charAt(0).toLowerCase() + plain.slice(1);
  return `${room} ${lowered}`;
}

/**
 * One to three short names to offer for a device that still carries its
 * model's name — never applied, only offered.
 *
 * In the order most likely to be right: the device's room in front of what it
 * is ("Bedroom climate sensor") when it has been placed, since that is what
 * people actually call things; then recognition's own name when it has one;
 * then what it is, with a number if the home already has one called that.
 * Each is unique in the home, and none repeats another.
 */
export function suggestNames(input: {
  shape: NamedShape;
  /** What recognition called it, when it said. */
  recognised?: string | null | undefined;
  /** The name of the room the device is in, when it is in one. */
  room?: string | null | undefined;
  /** Every other device's name in the home. */
  taken: readonly string[];
}): string[] {
  const plain = plainNameFor(input.shape);
  const recognised = acceptablePlainName(input.recognised);
  const offered: string[] = [];
  const offer = (name: string): void => {
    const unique = uniqueName(name, [...input.taken, ...offered]);
    if (unique.length <= PLAIN_NAME_MAX + 24 && !offered.some((entry) => same(entry, unique))) {
      offered.push(unique);
    }
  };
  if (input.room) offer(inRoomName(input.room, recognised ?? plain));
  if (recognised !== null) offer(recognised);
  if (recognised === null || !same(recognised, plain)) offer(plain);
  if (offered.length === 0) offer(plain);
  return offered.slice(0, 3);
}
