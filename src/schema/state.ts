import type { CapabilityKind } from './capabilities.js';

/**
 * Typed endpoint state — the canonical shape every adapter reduces device
 * reports into, and the exact JSON the API serves. Field names and units are
 * a compatibility contract with the GetHome apps (their Codable models decode
 * this verbatim); every unit convention below is load-bearing:
 *
 * - level:        1–254 (Level Control cluster range; 0 is invalid)
 * - color temp:   mireds (1e6 / kelvin; 153 ≈ 6500 K, 500 ≈ 2000 K)
 * - hue/sat:      0–254 cluster units (hue × 360/254 = degrees)
 * - temperatures: centi-degrees Celsius (2150 = 21.5 °C)
 * - humidity:     centi-percent RH (0–10000)
 * - covering:     lift percent-100ths, 0 = fully OPEN, 10000 = fully CLOSED
 * - battery:      whole percent 0–100 (already normalized from half-percents)
 * - power:        milliwatts / milliwatt-hours
 * - lock:         0 not-fully-locked, 1 locked, 2 unlocked
 * - fan mode:     0 off, 1 low, 2 medium, 3 high, 4 on, 5 auto
 * - air quality:  0 unknown, 1 good … 6 extremely poor
 */
export interface EndpointState {
  reachable: boolean;

  onOff?: boolean;

  level?: {
    /** 1…254 per the Level Control cluster. */
    current: number;
    min: number;
    max: number;
  };

  colorTemperature?: {
    mireds: number;
    minMireds: number;
    maxMireds: number;
  };

  colorHS?: {
    /** Hue and saturation in cluster units, 0…254. */
    hue: number;
    saturation: number;
    /** ColorMode attribute: true when the device is in hue/saturation mode. */
    colorModeIsHueSaturation: boolean;
  };

  thermostat?: {
    /** All temperatures in centi-degrees Celsius. */
    localTemperatureCenti?: number;
    occupiedHeatingSetpointCenti?: number;
    occupiedCoolingSetpointCenti?: number;
    /**
     * Setpoint limits as four scalars (the apps fold them back into ranges).
     * Deliberate wire divergence from Swift's ClosedRange, which encodes as a
     * positional array — brittle across platforms.
     */
    heatSetpointMinCenti: number;
    heatSetpointMaxCenti: number;
    coolSetpointMinCenti: number;
    coolSetpointMaxCenti: number;
    /** SystemMode attribute: 0 off, 1 auto, 3 cool, 4 heat. */
    systemMode: number;
  };

  /** LockState: 0 not fully locked, 1 locked, 2 unlocked. */
  lock?: 0 | 1 | 2;

  covering?: {
    /** Lift position in percent-100ths: 0 = fully open, 10000 = fully closed. */
    currentPositionLiftPercent100ths: number;
    targetPositionLiftPercent100ths?: number;
    isMoving: boolean;
  };

  fan?: {
    /** FanMode attribute: 0 off, 1 low, 2 medium, 3 high, 4 on, 5 auto. */
    mode: number;
    percentCurrent: number;
    percentSetting?: number;
  };

  /** Always present (possibly empty) — mirrors the app model. */
  sensors: {
    temperatureCenti?: number;
    humidityCenti?: number;
    illuminanceLux?: number;
    /** hPa. */
    pressureHPa?: number;
    flowCubicMetersPerHour?: number;
    occupied?: boolean;
    /** true = closed/contact for contact sensors. */
    contactClosed?: boolean;
    /** AirQuality enum: 0 unknown, 1 good … 6 extremely poor. */
    airQuality?: number;
    /** µg/m³. */
    pm25?: number;
    co2ppm?: number;
    /** AlarmState: 0 normal, 1 warning, 2 critical. */
    smokeAlarm?: number;
    coAlarm?: number;
  };

  battery?: {
    /** 0…100 whole percent. */
    percent: number;
  };

  power?: {
    activeMilliwatts?: number;
    importedEnergyMilliwattHours?: number;
  };

  playbackPlaying?: boolean;

  /**
   * Stateless input events — buttons, remotes, cubes. `buttons` is the
   * endpoint's input inventory (what the apps render); the remaining fields
   * describe the most recent event. `at` (epoch ms) makes every press a state
   * change even when the same action repeats, so clients always hear it.
   */
  event?: {
    buttons?: Array<{ id: string; label: string; gestures: string[] }>;
    /** Raw protocol action string (e.g. Z2M "single_left"), for debugging. */
    action?: string;
    /** Parsed button id ("main", "left", "1") — matches a `buttons[].id`. */
    button?: string;
    /** Parsed gesture: single, double, triple, hold, release, shake… */
    gesture?: string;
    at?: number;
  };

  /** Current mode for ModeSelect / RVC run-mode style capabilities. */
  currentMode?: number;
  /**
   * RVC OperationalState: 0x00 stopped, 0x01 running, 0x02 paused, 0x03 error,
   * 0x40 seeking charger, 0x41 charging, 0x42 docked.
   */
  rvcOperationalState?: number;
}

/** A state with nothing reported yet. */
export function emptyState(): EndpointState {
  return { reachable: true, sensors: {} };
}

/**
 * Deep-merge a state patch into an existing state. Sub-objects are merged
 * key-by-key so a report that only carries `level.current` doesn't clobber
 * the known min/max; scalars overwrite. Returns a new object.
 */
export function mergeState(base: EndpointState, patch: Partial<EndpointState>): EndpointState {
  const next: EndpointState = { ...base, sensors: { ...base.sensors } };
  const record = next as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const existing = record[key];
      record[key] =
        existing !== null && typeof existing === 'object'
          ? { ...(existing as object), ...(value as object) }
          : { ...(value as object) };
    } else {
      record[key] = value;
    }
  }
  return next;
}

/**
 * Capabilities this state has evidence for, in the same stable display order
 * the apps use.
 */
export function presentCapabilities(state: EndpointState): CapabilityKind[] {
  const kinds: CapabilityKind[] = [];
  if (state.onOff !== undefined) kinds.push('onOff');
  if (state.level !== undefined) kinds.push('level');
  if (state.colorTemperature !== undefined) kinds.push('colorTemperature');
  if (state.colorHS !== undefined) kinds.push('color');
  if (state.thermostat !== undefined) kinds.push('thermostat');
  if (state.fan !== undefined) kinds.push('fan');
  if (state.lock !== undefined) kinds.push('doorLock');
  if (state.covering !== undefined) kinds.push('windowCovering');
  if (state.sensors.temperatureCenti !== undefined) kinds.push('temperature');
  if (state.sensors.humidityCenti !== undefined) kinds.push('humidity');
  if (state.sensors.occupied !== undefined) kinds.push('occupancy');
  if (state.sensors.contactClosed !== undefined) kinds.push('contact');
  if (state.sensors.illuminanceLux !== undefined) kinds.push('illuminance');
  if (state.sensors.pressureHPa !== undefined) kinds.push('pressure');
  if (state.sensors.flowCubicMetersPerHour !== undefined) kinds.push('flow');
  if (state.sensors.airQuality !== undefined) kinds.push('airQuality');
  if (state.sensors.pm25 !== undefined) kinds.push('pm25');
  if (state.sensors.co2ppm !== undefined) kinds.push('co2');
  if (state.sensors.smokeAlarm !== undefined || state.sensors.coAlarm !== undefined) {
    kinds.push('smokeCOAlarm');
  }
  if (state.battery !== undefined) kinds.push('battery');
  if (state.power?.activeMilliwatts !== undefined) kinds.push('electricalPower');
  if (state.currentMode !== undefined) kinds.push('mode');
  if (state.rvcOperationalState !== undefined) kinds.push('rvcRun');
  if (state.playbackPlaying !== undefined) kinds.push('mediaPlayback');
  if (state.event !== undefined) kinds.push('event');
  return kinds;
}
