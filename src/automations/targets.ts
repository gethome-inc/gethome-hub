import type { CapabilityKind, DeviceKind } from '../schema/index.js';
import { MAX_FAN_OUT, type AutomationDocument, type AutomationTarget } from './schema.js';

/**
 * The read-only view of the home that automations are checked and run
 * against.
 *
 * Declared structurally rather than by importing `DeviceRegistry`, so this
 * module keeps the property that makes it testable and portable: it depends
 * on `src/schema/` and zod, and on nothing else in the hub. The API layer
 * builds one of these from `registry.listDevices()` and the rooms/zones read;
 * a test builds one from a literal.
 */
export interface AutomationHomeView {
  devices: readonly AutomationDeviceView[];
  rooms: readonly { id: string; name: string; zoneId: string | null }[];
  zones: readonly { id: string; name: string }[];
  /**
   * Every automation in the home. The whole document rather than a name,
   * because a reference is only half of what has to be checked: the other
   * half is whether this rule and that one form a cycle, and that question
   * can only be asked of both bodies — see `sanity.ts`.
   */
  automations: readonly AutomationSummaryView[];
}

export interface AutomationSummaryView {
  id: string;
  name: string;
  enabled: boolean;
  document: AutomationDocument;
}

export interface AutomationDeviceView {
  id: string;
  name: string;
  roomId: string | null;
  online: boolean;
  endpoints: readonly {
    endpointId: number;
    deviceKind: DeviceKind;
    capabilities: readonly CapabilityKind[];
  }[];
}

/** One resolved place a rule reads from or writes to. */
export interface ResolvedEndpoint {
  deviceId: string;
  deviceName: string;
  endpointId: number;
}

export interface ResolveOptions {
  /**
   * The capability the caller needs at the far end.
   *
   * This is what lets an author write "the hall light" without knowing the
   * device has three endpoints: with a capability in hand the resolver picks
   * the endpoint that actually carries it, and only falls back to endpoint 0
   * when nothing is asked for. Without it a two-gang switch would need the
   * author to know which gang is which — and a template, written before the
   * home existed, could never know.
   */
  capability?: CapabilityKind | undefined;
}

/**
 * Turn a target into the endpoints it means, right now.
 *
 * Order is stable (home order, then endpoint id) so a run trace reads the
 * same way twice, and the result is capped at `MAX_FAN_OUT` — a selector that
 * matched the whole house is a mistake with a blast radius, and the cap is
 * where that stops being the device guards' problem.
 *
 * **Reachability is deliberately not a filter here.** A command to a sleeping
 * battery device is queued by the protocol and lands when it next wakes, so
 * dropping unreachable devices would silently un-target half a home of
 * sensors — and would make a rule's meaning depend on when it happened to
 * run. What a radio can reach right now is reported in the run trace instead.
 */
export function resolveTarget(
  target: AutomationTarget,
  home: AutomationHomeView,
  options: ResolveOptions = {},
): ResolvedEndpoint[] {
  const wanted = options.capability;
  const resolved: ResolvedEndpoint[] = [];

  const pick = (device: AutomationDeviceView): void => {
    if (resolved.length >= MAX_FAN_OUT) return;
    const endpoint = pickEndpoint(device, target.endpointId, wanted);
    if (endpoint === null) return;
    resolved.push({ deviceId: device.id, deviceName: device.name, endpointId: endpoint });
  };

  if ('deviceIds' in target) {
    // Named devices are walked in the order the author named them, not in
    // home order: a rule that closes the blinds and then dims the lamp said
    // something about sequence.
    const byId = new Map(home.devices.map((device) => [device.id, device]));
    for (const id of target.deviceIds) {
      const device = byId.get(id);
      if (device) pick(device);
    }
    return resolved;
  }

  const roomsInZone =
    target.select.zoneId !== undefined
      ? new Set(
          home.rooms.filter((room) => room.zoneId === target.select.zoneId).map((room) => room.id),
        )
      : null;

  for (const device of home.devices) {
    if (target.select.roomId !== undefined && device.roomId !== target.select.roomId) continue;
    if (roomsInZone !== null && (device.roomId === null || !roomsInZone.has(device.roomId))) continue;
    if (
      target.select.kind !== undefined &&
      !device.endpoints.some((endpoint) => endpoint.deviceKind === target.select.kind)
    ) {
      continue;
    }
    if (
      target.select.capability !== undefined &&
      !device.endpoints.some((endpoint) =>
        endpoint.capabilities.includes(target.select.capability as CapabilityKind),
      )
    ) {
      continue;
    }
    pick(device);
  }
  return resolved;
}

/**
 * Which endpoint of this device the caller means.
 *
 * An explicit `endpointId` wins and is checked rather than trusted — a
 * document can outlive the endpoint it names. Otherwise the first endpoint
 * carrying the wanted capability, and failing that the first endpoint at all,
 * which is right for a read (`reachable` lives on every endpoint) and is
 * refused later for a write that needs a capability nothing has.
 */
function pickEndpoint(
  device: AutomationDeviceView,
  explicit: number | undefined,
  capability: CapabilityKind | undefined,
): number | null {
  if (explicit !== undefined) {
    return device.endpoints.some((endpoint) => endpoint.endpointId === explicit) ? explicit : null;
  }
  if (capability !== undefined) {
    const carrying = device.endpoints.find((endpoint) => endpoint.capabilities.includes(capability));
    if (carrying) return carrying.endpointId;
    return null;
  }
  return device.endpoints[0]?.endpointId ?? null;
}

/**
 * A short human sentence naming what a target resolves to.
 *
 * Used by run traces and by the summary a document carries, so a person
 * reading "turned off 4 lights in the Kitchen" never has to hold a list of
 * UUIDs in their head. Deliberately English and deliberately the *fallback* —
 * the apps render their own from the structured document, exactly as they do
 * with the activity log's `message`.
 */
/**
 * What a set of devices chosen by capability is *called*.
 *
 * A capability is a schema token and this is a sentence somebody reads, so the
 * two need a table between them. Anything absent falls back to "devices",
 * which is ugly and true — the same two properties `PATHS` is built on.
 */
const CAPABILITY_NOUNS: Record<string, string> = {
  onOff: 'devices that switch on and off',
  level: 'dimmable devices',
  colorTemperature: 'lights',
  color: 'colour lights',
  thermostat: 'thermostats',
  fan: 'fans',
  doorLock: 'locks',
  windowCovering: 'blinds and curtains',
  temperature: 'temperature sensors',
  humidity: 'humidity sensors',
  occupancy: 'motion sensors',
  contact: 'door and window sensors',
  illuminance: 'light sensors',
  airQuality: 'air quality sensors',
  co2: 'CO₂ sensors',
  smokeCOAlarm: 'smoke and CO alarms',
  battery: 'devices with a battery',
  electricalPower: 'devices that measure power',
  mediaPlayback: 'players',
  event: 'buttons and remotes',
  irRemote: 'IR blasters',
};

/** Device kinds are single words; none of them is irregular. */
function plural(kind: string): string {
  return kind.endsWith('s') ? kind : `${kind}s`;
}

/**
 * How many of a selected set the sentence is about.
 *
 * Not decoration: it is the difference between what the engine does and what
 * the sentence claims. A `deviceState` trigger is evaluated **per device**, so
 * it fires the moment *any* matching device crosses — while an action is sent
 * to every one of them. Describing both as "all the temperature sensors" said
 * that a rule waits for the whole house to reach 25 °C.
 */
export type TargetQuantifier = 'all' | 'any';

export function describeTarget(
  target: AutomationTarget,
  home: AutomationHomeView,
  quantifier: TargetQuantifier = 'all',
): string {
  if ('deviceIds' in target) {
    const names = target.deviceIds
      .map((id) => home.devices.find((device) => device.id === id)?.name)
      .filter((name): name is string => name !== undefined);
    if (names.length === 0) return 'no device';
    if (names.length <= 2) return names.join(' and ');
    return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
  }
  const parts: string[] = [];
  // **A kind or a capability, never both, and never the raw token.** This read
  // `every ${kind}s with ${capability}` — so a rule about the lights described
  // itself as "every lights with onOff", which is a schema field read out loud
  // in the one sentence both apps put in front of a person. A `kind` already
  // says what a `capability` beside it would: the capability is what names the
  // set when there is no kind, and it is named in words.
  parts.push(
    target.select.kind !== undefined
      ? plural(target.select.kind)
      : (CAPABILITY_NOUNS[target.select.capability ?? ''] ?? 'devices'),
  );
  const room = home.rooms.find((entry) => entry.id === target.select.roomId);
  if (room) parts.push(`in ${room.name}`);
  const zone = home.zones.find((entry) => entry.id === target.select.zoneId);
  if (zone) parts.push(`in ${zone.name}`);
  // "all the", not "every": what follows is plural in every case — a kind is
  // pluralised and a capability names a group ("smoke and CO alarms") — and
  // "every lights" was the reading that came out.
  return `${quantifier === 'any' ? 'any of the' : 'all the'} ${parts.join(' ')}`;
}
