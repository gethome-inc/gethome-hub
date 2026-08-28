import type { HomeStructure } from '../core/bus.js';
import type { RegistryDevice, RegistryEndpoint } from '../core/registry.js';
import {
  celsiusFromCenti,
  kelvinFromMireds,
  degreesFromHue,
  percentFromLevel,
  percentFromSaturation,
} from '../schema/units.js';

/**
 * How a model names a device, and how a device describes itself back.
 *
 * Everything here converts *out* of the wire units into the ones a person and
 * a language model both use — percent, °C, kelvin, "open" — because the wire's
 * units are a compatibility contract with the apps and are actively misleading
 * read cold: a covering at 0 is fully open, a level of 254 is full brightness,
 * a temperature is in hundredths. Asking a model to hold those conventions in
 * its head is asking for a lamp set to 12% when somebody said "twelve".
 *
 * Conversion goes through `src/schema/units.ts` and nothing here reimplements
 * a constant.
 */

/** How many characters of a device's UUID make a `ref`. */
const REF_LENGTH = 8;

/** The most devices `list_devices` will ever return in one answer. */
export const DEVICE_PAGE_LIMIT = 200;

export interface DeviceRow {
  /** The hub's own id. Stable, and what every other tool accepts. */
  id: string;
  /** The first few characters of `id` — shorter to carry, same meaning. */
  ref: string;
  name: string;
  room: string | null;
  zone: string | null;
  kind: string;
  online: boolean;
  /** One line a person would read: "on · 60%", "22.4 °C · 48%", "locked". */
  state: string;
}

/** Everything the hub knows about one device, in units a reader can use. */
export interface DeviceDetail extends DeviceRow {
  vendor: string | null;
  model: string | null;
  transport: string;
  batteryPercent?: number;
  endpoints: Array<{
    endpointId: number;
    kind: string;
    capabilities: string[];
    readings: Record<string, unknown>;
    /** The `control_device` actions this endpoint will accept. */
    actions: string[];
  }>;
}

export function refFor(id: string): string {
  return id.slice(0, REF_LENGTH);
}

/** The endpoint a bare `control_device` call means: the first one, as the apps do. */
export function primaryEndpoint(device: RegistryDevice): RegistryEndpoint | undefined {
  return device.endpoints[0];
}

/**
 * Find the one device a model meant, or say why that is not possible.
 *
 * Three ways in, and they exist in this order for a reason. A UUID is what
 * every tool answers with, so a model that has just listed devices can quote
 * one back. A **prefix** is the same id short enough to retype without
 * fumbling. A **name** is what a person actually said — "the kitchen lamp" —
 * and is the only one of the three a model can invent from the conversation
 * rather than from a previous tool result.
 *
 * Ambiguity is refused rather than guessed. Two lamps called "Lamp" in two
 * rooms is an ordinary home, and switching the wrong one is a worse outcome
 * than one more round trip — so the failure names the candidates and their
 * rooms, which is exactly what the model needs to ask a better question.
 */
export type DeviceLookup =
  | { found: true; device: RegistryDevice }
  | { found: false; reason: string };

export function resolveDevice(
  devices: readonly RegistryDevice[],
  query: string,
  roomNameFor: (roomId: string | null) => string | null,
): DeviceLookup {
  const needle = query.trim();
  if (!needle) return { found: false, reason: 'No device was named.' };

  const exactId = devices.find((device) => device.id === needle);
  if (exactId) return { found: true, device: exactId };

  const lower = needle.toLowerCase();

  const byPrefix =
    needle.length >= 6 ? devices.filter((device) => device.id.startsWith(lower)) : [];
  if (byPrefix.length === 1) return { found: true, device: byPrefix[0]! };
  if (byPrefix.length > 1) return { found: false, reason: ambiguity(byPrefix, roomNameFor, needle) };

  const byName = devices.filter((device) => device.name.toLowerCase() === lower);
  if (byName.length === 1) return { found: true, device: byName[0]! };
  if (byName.length > 1) return { found: false, reason: ambiguity(byName, roomNameFor, needle) };

  const byPartialName = devices.filter((device) => device.name.toLowerCase().includes(lower));
  if (byPartialName.length === 1) return { found: true, device: byPartialName[0]! };
  if (byPartialName.length > 1) {
    return { found: false, reason: ambiguity(byPartialName, roomNameFor, needle) };
  }

  return {
    found: false,
    reason: `No device matches "${needle}". Call list_devices to see what this home has.`,
  };
}

function ambiguity(
  matches: readonly RegistryDevice[],
  roomNameFor: (roomId: string | null) => string | null,
  needle: string,
): string {
  const listed = matches
    .slice(0, 10)
    .map((device) => {
      const room = roomNameFor(device.roomId);
      return `${device.name}${room ? ` (${room})` : ''} — ${refFor(device.id)}`;
    })
    .join('; ');
  return `"${needle}" matches ${matches.length} devices: ${listed}. Ask which one, or call again with its ref.`;
}

/** A lookup table from room id to its name and zone, built once per tool call. */
export function structureIndex(structure: HomeStructure) {
  const zoneNames = new Map(structure.zones.map((zone) => [zone.id, zone.name]));
  const rooms = new Map(
    structure.rooms.map((room) => [
      room.id,
      { name: room.name, zone: room.zoneId ? (zoneNames.get(room.zoneId) ?? null) : null },
    ]),
  );
  return {
    roomName: (roomId: string | null) => (roomId ? (rooms.get(roomId)?.name ?? null) : null),
    zoneName: (roomId: string | null) => (roomId ? (rooms.get(roomId)?.zone ?? null) : null),
  };
}

export type StructureIndex = ReturnType<typeof structureIndex>;

export function deviceRow(device: RegistryDevice, index: StructureIndex): DeviceRow {
  const endpoint = primaryEndpoint(device);
  return {
    id: device.id,
    ref: refFor(device.id),
    name: device.name,
    room: index.roomName(device.roomId),
    zone: index.zoneName(device.roomId),
    kind: endpoint?.deviceKind ?? 'unknown',
    online: device.online,
    state: describeState(device, endpoint),
  };
}

/**
 * The one line that goes in a list.
 *
 * `list_devices` deliberately does not return `EndpointState`. Forty devices
 * of full typed state is 40–80 KB of JSON and twenty thousand tokens of a
 * model's context spent before it has decided which device it cares about —
 * so the list carries a sentence and `get_device` carries the picture.
 */
export function describeState(
  device: RegistryDevice,
  endpoint: RegistryEndpoint | undefined,
): string {
  if (!device.online) return 'offline';
  if (!endpoint) return 'no state reported';

  const state = endpoint.state;
  const parts: string[] = [];

  if (state.onOff !== undefined) parts.push(state.onOff ? 'on' : 'off');
  if (state.level) parts.push(`${percentFromLevel(state.level.current, state.level.min, state.level.max)}%`);
  if (state.lock !== undefined) {
    parts.push(state.lock === 1 ? 'locked' : state.lock === 2 ? 'unlocked' : 'not fully locked');
  }
  if (state.covering) {
    parts.push(`${openPercent(state.covering.currentPositionLiftPercent100ths)}% open`);
  }
  // **The thermostat's reading is labelled and the ambient one is not.** A TRV
  // reports both — Z2M maps `local_temperature` onto the thermostat and
  // `temperature` onto the sensors — so this line used to read
  // `21.5 °C · 19.8 °C` with nothing saying which was the room and which was
  // the valve's own idea of it. One of the two has to say what it is, and it
  // is this one, because "19.8 °C" unqualified is what every other device in
  // the house means by a temperature.
  if (state.thermostat?.localTemperatureCenti !== undefined) {
    parts.push(`thermostat ${round(celsiusFromCenti(state.thermostat.localTemperatureCenti), 1)} °C`);
  }
  if (state.sensors.temperatureCenti !== undefined) {
    parts.push(`${round(celsiusFromCenti(state.sensors.temperatureCenti), 1)} °C`);
  }
  if (state.sensors.humidityCenti !== undefined) {
    parts.push(`${Math.round(state.sensors.humidityCenti / 100)}% humidity`);
  }
  if (state.sensors.occupied !== undefined) {
    parts.push(state.sensors.occupied ? 'motion detected' : 'no motion');
  }
  if (state.sensors.contactClosed !== undefined) {
    parts.push(state.sensors.contactClosed ? 'closed' : 'open');
  }
  if (state.sensors.co2ppm !== undefined) parts.push(`${Math.round(state.sensors.co2ppm)} ppm CO₂`);
  if (state.power?.activeMilliwatts !== undefined) {
    parts.push(`${round(state.power.activeMilliwatts / 1000, 1)} W`);
  }
  if (state.playbackPlaying !== undefined) parts.push(state.playbackPlaying ? 'playing' : 'paused');
  if (state.battery && state.battery.percent <= 20) {
    parts.push(`battery ${state.battery.percent}%`);
  }

  return parts.length > 0 ? parts.join(' · ') : 'no state reported';
}

/** Wire covering (0 = open) → the direction a person means (100 = open). */
export function openPercent(percent100ths: number): number {
  return Math.round((10_000 - percent100ths) / 100);
}

/** The direction a person means (100 = open) → the wire's (0 = open). */
export function coveringWireValue(openPercentage: number): number {
  return Math.round((100 - openPercentage) * 100);
}

const FAN_MODES = ['off', 'low', 'medium', 'high', 'on', 'auto'] as const;
export type FanModeName = (typeof FAN_MODES)[number];
export function fanModeName(mode: number): string {
  return FAN_MODES[mode] ?? `mode ${mode}`;
}
export function fanModeValue(name: FanModeName): number {
  return FAN_MODES.indexOf(name);
}

const THERMOSTAT_MODES: Record<number, string> = { 0: 'off', 1: 'auto', 3: 'cool', 4: 'heat' };
export type ThermostatModeName = 'off' | 'auto' | 'cool' | 'heat';
export function thermostatModeName(mode: number): string {
  return THERMOSTAT_MODES[mode] ?? `mode ${mode}`;
}
export function thermostatModeValue(name: ThermostatModeName): number {
  return name === 'off' ? 0 : name === 'auto' ? 1 : name === 'cool' ? 3 : 4;
}

const AIR_QUALITY = [
  'unknown',
  'good',
  'fair',
  'moderate',
  'poor',
  'very poor',
  'extremely poor',
] as const;

/**
 * Every reading on an endpoint, converted.
 *
 * Keys are chosen to say their own unit (`temperatureC`, `brightnessPercent`)
 * so a model never has to guess, and an absent reading is an absent key rather
 * than a null — "this device does not measure humidity" and "humidity is zero"
 * are different facts.
 */
export function readingsFor(endpoint: RegistryEndpoint): Record<string, unknown> {
  const state = endpoint.state;
  const out: Record<string, unknown> = {};

  if (state.onOff !== undefined) out['on'] = state.onOff;
  if (state.level) {
    out['brightnessPercent'] = percentFromLevel(state.level.current, state.level.min, state.level.max);
  }
  if (state.colorTemperature) {
    out['colorTemperatureKelvin'] = Math.round(kelvinFromMireds(state.colorTemperature.mireds));
    out['colorTemperatureRangeKelvin'] = {
      min: Math.round(kelvinFromMireds(state.colorTemperature.maxMireds)),
      max: Math.round(kelvinFromMireds(state.colorTemperature.minMireds)),
    };
  }
  if (state.colorHS) {
    out['hueDegrees'] = Math.round(degreesFromHue(state.colorHS.hue));
    out['saturationPercent'] = percentFromSaturation(state.colorHS.saturation);
  }
  if (state.thermostat) {
    const t = state.thermostat;
    // **Its own key, because `temperatureC` below belongs to the sensors.**
    // Both were written here under one name and the sensors block runs
    // second, so on any device carrying both — a TRV maps `local_temperature`
    // here and `temperature` there — the ambient reading silently overwrote
    // the thermostat's own and there was no key left holding it.
    if (t.localTemperatureCenti !== undefined) {
      out['thermostatTemperatureC'] = round(celsiusFromCenti(t.localTemperatureCenti), 1);
    }
    if (t.occupiedHeatingSetpointCenti !== undefined) {
      out['heatingSetpointC'] = round(celsiusFromCenti(t.occupiedHeatingSetpointCenti), 1);
    }
    if (t.occupiedCoolingSetpointCenti !== undefined) {
      out['coolingSetpointC'] = round(celsiusFromCenti(t.occupiedCoolingSetpointCenti), 1);
    }
    out['thermostatMode'] = thermostatModeName(t.systemMode);
    out['heatingSetpointRangeC'] = {
      min: round(celsiusFromCenti(t.heatSetpointMinCenti), 1),
      max: round(celsiusFromCenti(t.heatSetpointMaxCenti), 1),
    };
    out['coolingSetpointRangeC'] = {
      min: round(celsiusFromCenti(t.coolSetpointMinCenti), 1),
      max: round(celsiusFromCenti(t.coolSetpointMaxCenti), 1),
    };
  }
  if (state.lock !== undefined) {
    out['lock'] = state.lock === 1 ? 'locked' : state.lock === 2 ? 'unlocked' : 'not fully locked';
  }
  if (state.covering) {
    out['openPercent'] = openPercent(state.covering.currentPositionLiftPercent100ths);
    out['moving'] = state.covering.isMoving;
  }
  if (state.fan) {
    out['fanMode'] = fanModeName(state.fan.mode);
    out['fanPercent'] = state.fan.percentCurrent;
  }
  if (state.playbackPlaying !== undefined) out['playing'] = state.playbackPlaying;
  if (state.battery) out['batteryPercent'] = state.battery.percent;
  if (state.power?.activeMilliwatts !== undefined) {
    out['powerWatts'] = round(state.power.activeMilliwatts / 1000, 2);
  }
  if (state.power?.importedEnergyMilliwattHours !== undefined) {
    out['energyKilowattHours'] = round(state.power.importedEnergyMilliwattHours / 1_000_000, 3);
  }

  const s = state.sensors;
  // `temperatureC` is "the temperature this device reports": the ambient
  // sensor's when there is one, and otherwise the thermostat's own, so a plain
  // thermostat still answers under the name a model will look for. A device
  // with both answers under both, and neither reading is lost.
  if (s.temperatureCenti !== undefined) {
    out['temperatureC'] = round(celsiusFromCenti(s.temperatureCenti), 1);
  } else if (out['thermostatTemperatureC'] !== undefined) {
    out['temperatureC'] = out['thermostatTemperatureC'];
  }
  if (s.humidityCenti !== undefined) out['humidityPercent'] = round(s.humidityCenti / 100, 1);
  if (s.illuminanceLux !== undefined) out['illuminanceLux'] = Math.round(s.illuminanceLux);
  if (s.pressureHPa !== undefined) out['pressureHPa'] = round(s.pressureHPa, 1);
  if (s.flowCubicMetersPerHour !== undefined) out['flowCubicMetresPerHour'] = round(s.flowCubicMetersPerHour, 3);
  if (s.occupied !== undefined) out['motionDetected'] = s.occupied;
  if (s.contactClosed !== undefined) out['contactClosed'] = s.contactClosed;
  if (s.airQuality !== undefined) out['airQuality'] = AIR_QUALITY[s.airQuality] ?? 'unknown';
  if (s.pm25 !== undefined) out['pm25MicrogramsPerCubicMetre'] = round(s.pm25, 1);
  if (s.co2ppm !== undefined) out['co2Ppm'] = Math.round(s.co2ppm);
  if (s.smokeAlarm !== undefined) out['smokeAlarm'] = alarmWord(s.smokeAlarm);
  if (s.coAlarm !== undefined) out['carbonMonoxideAlarm'] = alarmWord(s.coAlarm);

  if (state.custom?.fields?.length) {
    out['settings'] = state.custom.fields.map((field) => ({
      id: field.id,
      label: field.label,
      unit: field.unit,
      settable: field.settable,
      value: state.custom?.values?.[field.id],
      ...(field.options ? { options: field.options.map((option) => option.value) } : {}),
      ...(field.min !== undefined ? { min: field.min } : {}),
      ...(field.max !== undefined ? { max: field.max } : {}),
    }));
  }

  if (state.irRemote?.commands.length) {
    out['irCommands'] = state.irRemote.commands.map((command) => ({
      id: command.id,
      name: command.name,
    }));
  }

  return out;
}

function alarmWord(value: number): string {
  return value === 0 ? 'normal' : value === 1 ? 'warning' : 'critical';
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

export function deviceDetail(device: RegistryDevice, index: StructureIndex): DeviceDetail {
  const row = deviceRow(device, index);
  const battery = primaryEndpoint(device)?.state.battery?.percent;
  return {
    ...row,
    vendor: device.vendor ?? null,
    model: device.model ?? null,
    transport: device.adapter,
    ...(battery !== undefined ? { batteryPercent: battery } : {}),
    endpoints: device.endpoints.map((endpoint) => ({
      endpointId: endpoint.endpointId,
      kind: endpoint.deviceKind,
      capabilities: [...endpoint.capabilities],
      readings: readingsFor(endpoint),
      actions: actionsFor(endpoint),
    })),
  };
}

/**
 * Which `control_device` actions this endpoint will take.
 *
 * Derived from the capabilities the device actually reports rather than from
 * its kind, so a model is never invited to send a command the hub would refuse
 * — and so a device the AI mapper taught the hub about last week is described
 * correctly today with no change here.
 */
export function actionsFor(endpoint: RegistryEndpoint): string[] {
  const actions: string[] = [];
  const has = (kind: string) => endpoint.capabilities.includes(kind as never);

  if (has('onOff')) actions.push('on', 'off', 'toggle');
  if (has('level')) actions.push('brightness');
  if (has('colorTemperature')) actions.push('color_temperature');
  if (has('color')) actions.push('color');
  if (has('thermostat')) actions.push('thermostat');
  if (has('doorLock')) actions.push('lock', 'unlock');
  if (has('windowCovering')) {
    actions.push('covering', 'covering_open', 'covering_close', 'covering_stop');
  }
  if (has('fan')) actions.push('fan', 'fan_mode');
  if (has('mediaPlayback')) actions.push('play', 'pause');
  if (has('mode') || has('rvcRun')) actions.push('set_mode');
  if (has('irRemote')) actions.push('ir_send');
  if (endpoint.state.custom?.fields?.some((field) => field.settable)) actions.push('setting');

  return actions;
}

/**
 * Recorded readings arrive in the hub's storage units; charts convert.
 *
 * `src/core/history.ts` stores what the sensor reported, in the wire's own
 * scale — `centiCelsius`, `deciHectopascal`, `milliwatt` — because a stored
 * average cannot be merged and a stored *converted* average cannot be merged
 * either. Every client converts on read: the iOS app has
 * `DeviceHistoryKind.display(fromStored:)` and this is that function.
 *
 * It exists because the MCP layer's whole promise is that nothing on the wire
 * reaches a model in the wire's units, and history was the one route that
 * broke it: a temperature came back as `2150` beside a unit string reading
 * `centiCelsius`, which a model reports as two thousand degrees.
 */
const HISTORY_DISPLAY: Record<string, { unit: string; scale: number; places: number }> = {
  centiCelsius: { unit: '°C', scale: 0.01, places: 1 },
  centiPercent: { unit: '%', scale: 0.01, places: 1 },
  lux: { unit: 'lx', scale: 1, places: 0 },
  deciHectopascal: { unit: 'hPa', scale: 0.1, places: 1 },
  ppm: { unit: 'ppm', scale: 1, places: 0 },
  deciMicrogramsPerCubicMetre: { unit: 'µg/m³', scale: 0.1, places: 1 },
  milliCubicMetresPerHour: { unit: 'm³/h', scale: 0.001, places: 3 },
  milliwatt: { unit: 'W', scale: 0.001, places: 2 },
  percent: { unit: '%', scale: 1, places: 0 },
};

/** Whether this layer knows how to show a unit the hub records. */
export function knowsHistoryUnit(storedUnit: string): boolean {
  return storedUnit in HISTORY_DISPLAY;
}

/** The unit a reader sees, for a unit the hub stores. */
export function displayUnit(storedUnit: string): string {
  return HISTORY_DISPLAY[storedUnit]?.unit ?? storedUnit;
}

/** One stored reading in the units the rest of the MCP surface speaks. */
export function displayValue(storedUnit: string, value: number): number {
  const spec = HISTORY_DISPLAY[storedUnit];
  // An unknown unit is passed through rather than guessed at — a wrong scale
  // is worse than an unfamiliar name, and the name travels with the number.
  if (!spec) return value;
  return round(value * spec.scale, spec.places);
}
