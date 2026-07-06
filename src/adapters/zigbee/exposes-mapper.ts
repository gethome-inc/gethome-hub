import {
  centiFromCelsius,
  hueFromDegrees,
  percent100thsFromZ2mPosition,
  saturationFromPercent,
  clamp,
  type CapabilityKind,
  type DeviceKind,
  type EndpointState,
} from '../../schema/index.js';

/**
 * Static mapping from Zigbee2MQTT "exposes" definitions into the canonical
 * GetHome schema. This is the first line of device support; anything it can't
 * place lands in `unmapped` and becomes an AI-mapping trigger
 * (see src/ai/mapper.ts).
 *
 * Z2M exposes reference: https://www.zigbee2mqtt.io/guide/usage/exposes.html
 */

/** A single entry of a device definition's `exposes` array (or a feature). */
export interface Z2mExpose {
  type: string;
  name?: string;
  property?: string;
  endpoint?: string;
  access?: number;
  unit?: string;
  value_on?: unknown;
  value_off?: unknown;
  value_min?: number;
  value_max?: number;
  values?: string[];
  features?: Z2mExpose[];
}

/** A device entry from `zigbee2mqtt/bridge/devices`. */
export interface Z2mDevice {
  ieee_address: string;
  friendly_name: string;
  type?: string;
  supported?: boolean;
  disabled?: boolean;
  interview_completed?: boolean;
  definition?: {
    vendor?: string;
    model?: string;
    description?: string;
    exposes?: Z2mExpose[];
  } | null;
}

export interface Z2mProfile {
  kind: DeviceKind;
  capabilities: CapabilityKind[];
  primary: CapabilityKind;
  /** Exposed properties the static mapper could not place (AI trigger). */
  unmapped: string[];
  /** Command-translation metadata gathered from the exposes. */
  features: Z2mCommandFeatures;
  /** Convert one Z2M state payload into a canonical state patch. */
  extractState(payload: Record<string, unknown>): Partial<EndpointState>;
}

export interface Z2mCommandFeatures {
  /** value_on/value_off of the main switch feature (usually "ON"/"OFF"). */
  onValue: unknown;
  offValue: unknown;
  hasOnOff: boolean;
  hasBrightness: boolean;
  colorTempRange?: { min: number; max: number };
  hasColorHS: boolean;
  hasPosition: boolean;
  isCover: boolean;
  isLock: boolean;
  /** The heating-setpoint property name (varies per TRV). */
  heatingSetpointProperty?: string;
  coolingSetpointProperty?: string;
  systemModes?: string[];
  fanModes?: string[];
  fanModeProperty?: string;
}

/** Payload keys that are telemetry/plumbing, never device capabilities. */
const IGNORED_PROPERTIES = new Set([
  'linkquality',
  'voltage',
  'current',
  'action',
  'action_group',
  'action_rate',
  'transition',
  'power_on_behavior',
  'effect',
  'identify',
  'update',
  'update_available',
  'device_temperature',
  'indicator_mode',
  'backlight_mode',
  'child_lock',
  'running_state',
  'position_left', // multi-motor covers: v1 maps the primary motor only
  'color_mode',
  'color_temp_startup',
  'gradient',
  'gradient_scene',
  'power_outage_count',
  'power_outage_memory',
  'auto_off',
  'sensitivity',
  'motor_speed',
  'options',
]);

const thermostatDefaults = {
  heatSetpointMinCenti: 700,
  heatSetpointMaxCenti: 3000,
  coolSetpointMinCenti: 1600,
  coolSetpointMaxCenti: 3200,
};

const SYSTEM_MODE_TO_CODE: Record<string, number> = { off: 0, auto: 1, cool: 3, heat: 4 };
const FAN_MODE_ORDER = ['off', 'low', 'medium', 'high', 'on', 'auto'];

type StateRule = (value: unknown, patch: PatchBuilder) => void;

/** Mutable draft the rules write into; finalized into a state patch. */
class PatchBuilder {
  onOff?: boolean;
  level?: { current: number; min: number; max: number };
  colorTemperature?: { mireds: number; minMireds: number; maxMireds: number };
  colorHS?: { hue: number; saturation: number; colorModeIsHueSaturation: boolean };
  thermostat?: NonNullable<EndpointState['thermostat']>;
  lock?: 0 | 1 | 2;
  covering?: { currentPositionLiftPercent100ths: number; isMoving: boolean };
  fan?: { mode: number; percentCurrent: number };
  sensors: NonNullable<EndpointState['sensors']> = {};
  battery?: { percent: number };
  power?: { activeMilliwatts?: number; importedEnergyMilliwattHours?: number };

  ensureThermostat() {
    this.thermostat ??= { ...thermostatDefaults, systemMode: 0 };
    return this.thermostat;
  }

  ensurePower() {
    this.power ??= {};
    return this.power;
  }

  build(): Partial<EndpointState> {
    const patch: Partial<EndpointState> = {};
    if (this.onOff !== undefined) patch.onOff = this.onOff;
    if (this.level) patch.level = this.level;
    if (this.colorTemperature) patch.colorTemperature = this.colorTemperature;
    if (this.colorHS) patch.colorHS = this.colorHS;
    if (this.thermostat) patch.thermostat = this.thermostat;
    if (this.lock !== undefined) patch.lock = this.lock;
    if (this.covering) patch.covering = this.covering;
    if (this.fan) patch.fan = this.fan;
    if (Object.keys(this.sensors).length > 0) patch.sensors = this.sensors;
    if (this.battery) patch.battery = this.battery;
    if (this.power) patch.power = this.power;
    return patch;
  }
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function asBool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  return undefined;
}

/**
 * Build the profile for one Z2M device. Multi-endpoint exposes (those with an
 * `endpoint` label, e.g. `state_l1`/`state_l2` relays) are not mapped
 * statically in v1 — they land in `unmapped` so the AI mapper can produce a
 * multi-endpoint descriptor.
 */
export function mapExposes(device: Z2mDevice): Z2mProfile {
  const exposes = device.definition?.exposes ?? [];
  const capabilities = new Set<CapabilityKind>();
  const rules = new Map<string, StateRule>();
  const unmapped: string[] = [];
  const features: Z2mCommandFeatures = {
    onValue: 'ON',
    offValue: 'OFF',
    hasOnOff: false,
    hasBrightness: false,
    hasColorHS: false,
    hasPosition: false,
    isCover: false,
    isLock: false,
  };
  let kind: DeviceKind | undefined;
  let sawClimate = false;

  const setKind = (candidate: DeviceKind) => {
    kind ??= candidate;
  };

  const mapSensorNumeric = (
    property: string,
    apply: (value: number, patch: PatchBuilder) => void,
    capability: CapabilityKind,
  ) => {
    capabilities.add(capability);
    rules.set(property, (value, patch) => {
      const parsed = asNumber(value);
      if (parsed !== undefined) apply(parsed, patch);
    });
  };

  const handleSimple = (expose: Z2mExpose): boolean => {
    const property = expose.property ?? expose.name;
    if (!property) return true;
    switch (property) {
      case 'temperature':
        mapSensorNumeric(property, (v, p) => (p.sensors.temperatureCenti = centiFromCelsius(v)), 'temperature');
        return true;
      case 'humidity':
        mapSensorNumeric(property, (v, p) => (p.sensors.humidityCenti = Math.round(v * 100)), 'humidity');
        return true;
      case 'illuminance':
      case 'illuminance_lux':
        mapSensorNumeric(property, (v, p) => (p.sensors.illuminanceLux = v), 'illuminance');
        return true;
      case 'pressure':
        mapSensorNumeric(property, (v, p) => (p.sensors.pressureHPa = v), 'pressure');
        return true;
      case 'battery':
        mapSensorNumeric(property, (v, p) => (p.battery = { percent: clamp(Math.round(v), 0, 100) }), 'battery');
        return true;
      case 'power':
        mapSensorNumeric(
          property,
          (v, p) => (p.ensurePower().activeMilliwatts = Math.round(v * 1000)),
          'electricalPower',
        );
        return true;
      case 'energy':
        mapSensorNumeric(
          property,
          (v, p) => (p.ensurePower().importedEnergyMilliwattHours = Math.round(v * 1_000_000)),
          'electricalPower',
        );
        return true;
      case 'pm25':
        mapSensorNumeric(property, (v, p) => (p.sensors.pm25 = v), 'pm25');
        return true;
      case 'co2':
        mapSensorNumeric(property, (v, p) => (p.sensors.co2ppm = v), 'co2');
        return true;
      case 'occupancy':
        capabilities.add('occupancy');
        rules.set(property, (value, patch) => {
          const parsed = asBool(value);
          if (parsed !== undefined) patch.sensors.occupied = parsed;
        });
        setKind('sensor');
        return true;
      case 'contact':
        capabilities.add('contact');
        rules.set(property, (value, patch) => {
          const parsed = asBool(value);
          if (parsed !== undefined) patch.sensors.contactClosed = parsed;
        });
        setKind('sensor');
        return true;
      case 'water_leak':
        capabilities.add('contact');
        rules.set(property, (value, patch) => {
          const parsed = asBool(value);
          if (parsed !== undefined) patch.sensors.contactClosed = !parsed;
        });
        setKind('sensor');
        return true;
      case 'smoke':
        capabilities.add('smokeCOAlarm');
        rules.set(property, (value, patch) => {
          const parsed = asBool(value);
          if (parsed !== undefined) patch.sensors.smokeAlarm = parsed ? 2 : 0;
        });
        setKind('sensor');
        return true;
      case 'carbon_monoxide':
        capabilities.add('smokeCOAlarm');
        rules.set(property, (value, patch) => {
          const parsed = asBool(value);
          if (parsed !== undefined) patch.sensors.coAlarm = parsed ? 2 : 0;
        });
        setKind('sensor');
        return true;
      default:
        return false;
    }
  };

  const handleLightOrSwitch = (expose: Z2mExpose, asLight: boolean) => {
    setKind(asLight ? 'light' : 'outlet');
    for (const feature of expose.features ?? []) {
      const property = feature.property ?? feature.name;
      if (!property) continue;
      if (feature.endpoint) {
        unmapped.push(property);
        continue;
      }
      switch (feature.name ?? property) {
        case 'state': {
          capabilities.add('onOff');
          features.hasOnOff = true;
          features.onValue = feature.value_on ?? 'ON';
          features.offValue = feature.value_off ?? 'OFF';
          const onValue = features.onValue;
          rules.set(property, (value, patch) => {
            patch.onOff = value === onValue;
          });
          break;
        }
        case 'brightness': {
          capabilities.add('level');
          features.hasBrightness = true;
          rules.set(property, (value, patch) => {
            const parsed = asNumber(value);
            if (parsed !== undefined) {
              patch.level = { current: clamp(Math.round(parsed), 1, 254), min: 1, max: 254 };
            }
          });
          break;
        }
        case 'color_temp': {
          capabilities.add('colorTemperature');
          const min = feature.value_min ?? 153;
          const max = feature.value_max ?? 500;
          features.colorTempRange = { min, max };
          rules.set(property, (value, patch) => {
            const parsed = asNumber(value);
            if (parsed !== undefined) {
              patch.colorTemperature = { mireds: Math.round(parsed), minMireds: min, maxMireds: max };
            }
          });
          break;
        }
        case 'color_hs':
        case 'color_xy': {
          capabilities.add('color');
          features.hasColorHS = true;
          rules.set(property, (value, patch) => {
            if (value === null || typeof value !== 'object') return;
            const color = value as { hue?: unknown; saturation?: unknown };
            const hue = asNumber(color.hue);
            const saturation = asNumber(color.saturation);
            if (hue !== undefined && saturation !== undefined) {
              patch.colorHS = {
                hue: hueFromDegrees(hue),
                saturation: saturationFromPercent(saturation),
                colorModeIsHueSaturation: true,
              };
            }
          });
          break;
        }
        default:
          if (!IGNORED_PROPERTIES.has(property)) unmapped.push(property);
      }
    }
  };

  const handleCover = (expose: Z2mExpose) => {
    setKind('shade');
    features.isCover = true;
    capabilities.add('windowCovering');
    for (const feature of expose.features ?? []) {
      const property = feature.property ?? feature.name;
      if (!property) continue;
      switch (feature.name ?? property) {
        case 'state':
          // OPEN/CLOSE/STOP — command-only; position carries the state.
          break;
        case 'position':
          features.hasPosition = true;
          rules.set(property, (value, patch) => {
            const parsed = asNumber(value);
            if (parsed !== undefined) {
              patch.covering = {
                currentPositionLiftPercent100ths: percent100thsFromZ2mPosition(parsed),
                isMoving: false,
              };
            }
          });
          break;
        case 'tilt':
          break; // v1: lift only
        default:
          if (!IGNORED_PROPERTIES.has(property)) unmapped.push(property);
      }
    }
  };

  const handleLock = (expose: Z2mExpose) => {
    setKind('lock');
    features.isLock = true;
    capabilities.add('doorLock');
    for (const feature of expose.features ?? []) {
      const property = feature.property ?? feature.name;
      if (!property) continue;
      if ((feature.name ?? property) === 'state') {
        features.onValue = feature.value_on ?? 'LOCK';
        features.offValue = feature.value_off ?? 'UNLOCK';
      } else if ((feature.name ?? property) === 'lock_state') {
        rules.set(property, (value, patch) => {
          if (value === 'locked') patch.lock = 1;
          else if (value === 'unlocked') patch.lock = 2;
          else if (typeof value === 'string') patch.lock = 0;
        });
      } else if (!IGNORED_PROPERTIES.has(property)) {
        unmapped.push(property);
      }
    }
  };

  const handleClimate = (expose: Z2mExpose) => {
    setKind('climate');
    sawClimate = true;
    capabilities.add('thermostat');
    for (const feature of expose.features ?? []) {
      const property = feature.property ?? feature.name;
      if (!property) continue;
      switch (feature.name ?? property) {
        case 'local_temperature':
          rules.set(property, (value, patch) => {
            const parsed = asNumber(value);
            if (parsed !== undefined) patch.ensureThermostat().localTemperatureCenti = centiFromCelsius(parsed);
          });
          break;
        case 'current_heating_setpoint':
        case 'occupied_heating_setpoint': {
          features.heatingSetpointProperty = property;
          const minCenti = feature.value_min !== undefined ? centiFromCelsius(feature.value_min) : 700;
          const maxCenti = feature.value_max !== undefined ? centiFromCelsius(feature.value_max) : 3000;
          rules.set(property, (value, patch) => {
            const parsed = asNumber(value);
            if (parsed !== undefined) {
              const thermostat = patch.ensureThermostat();
              thermostat.occupiedHeatingSetpointCenti = centiFromCelsius(parsed);
              thermostat.heatSetpointMinCenti = minCenti;
              thermostat.heatSetpointMaxCenti = maxCenti;
            }
          });
          break;
        }
        case 'occupied_cooling_setpoint': {
          features.coolingSetpointProperty = property;
          rules.set(property, (value, patch) => {
            const parsed = asNumber(value);
            if (parsed !== undefined) {
              patch.ensureThermostat().occupiedCoolingSetpointCenti = centiFromCelsius(parsed);
            }
          });
          break;
        }
        case 'system_mode': {
          features.systemModes = feature.values ?? [];
          rules.set(property, (value, patch) => {
            if (typeof value === 'string' && value in SYSTEM_MODE_TO_CODE) {
              patch.ensureThermostat().systemMode = SYSTEM_MODE_TO_CODE[value]!;
            }
          });
          break;
        }
        case 'running_state':
          break;
        default:
          if (!IGNORED_PROPERTIES.has(property)) unmapped.push(property);
      }
    }
  };

  const handleFan = (expose: Z2mExpose) => {
    setKind('fan');
    capabilities.add('fan');
    for (const feature of expose.features ?? []) {
      const property = feature.property ?? feature.name;
      if (!property) continue;
      if ((feature.name ?? property) === 'mode' || property === 'fan_mode') {
        features.fanModes = feature.values ?? FAN_MODE_ORDER;
        features.fanModeProperty = property;
        rules.set(property, (value, patch) => {
          if (typeof value === 'string') {
            const index = FAN_MODE_ORDER.indexOf(value);
            if (index >= 0) patch.fan = { mode: index, percentCurrent: 0 };
          }
        });
      } else if ((feature.name ?? property) === 'state' || property === 'fan_state') {
        capabilities.add('onOff');
        features.hasOnOff = true;
        const onValue = feature.value_on ?? 'ON';
        features.onValue = onValue;
        features.offValue = feature.value_off ?? 'OFF';
        rules.set(property, (value, patch) => {
          patch.onOff = value === onValue;
        });
      } else if (!IGNORED_PROPERTIES.has(property)) {
        unmapped.push(property);
      }
    }
  };

  for (const expose of exposes) {
    if (expose.endpoint) {
      // Multi-endpoint devices (state_l1/l2 relays…) are an AI-mapper job.
      const property = expose.property ?? expose.name;
      if (property) unmapped.push(property);
      continue;
    }
    switch (expose.type) {
      case 'light':
        handleLightOrSwitch(expose, true);
        break;
      case 'switch':
        handleLightOrSwitch(expose, false);
        break;
      case 'cover':
        handleCover(expose);
        break;
      case 'lock':
        handleLock(expose);
        break;
      case 'climate':
        handleClimate(expose);
        break;
      case 'fan':
        handleFan(expose);
        break;
      case 'binary':
      case 'numeric':
      case 'enum':
      case 'composite':
      case 'text':
      case 'list': {
        const property = expose.property ?? expose.name;
        if (!property) break;
        if (handleSimple(expose)) break;
        if (!IGNORED_PROPERTIES.has(property)) unmapped.push(property);
        break;
      }
      default:
        break;
    }
  }

  // A "switch" that also meters power is an outlet either way; a bare relay
  // controlling something unknown is closer to a wall switch.
  if (kind === 'outlet' && !capabilities.has('electricalPower') && !device.definition?.description?.toLowerCase().includes('plug')) {
    kind = 'wallSwitch';
  }
  if (!kind) kind = 'sensor';
  if (sawClimate) kind = 'climate';

  const capabilityList = [...capabilities];
  const primary = pickPrimary(capabilityList, kind);

  return {
    kind,
    capabilities: capabilityList,
    primary,
    unmapped,
    features,
    extractState(payload) {
      const patch = new PatchBuilder();
      for (const [property, value] of Object.entries(payload)) {
        rules.get(property)?.(value, patch);
      }
      return patch.build();
    },
  };
}

const PRIMARY_PRIORITY: CapabilityKind[] = [
  'thermostat',
  'doorLock',
  'windowCovering',
  'onOff',
  'fan',
  'temperature',
  'humidity',
  'occupancy',
  'contact',
  'illuminance',
  'airQuality',
  'pm25',
  'co2',
  'smokeCOAlarm',
  'electricalPower',
  'pressure',
  'flow',
  'battery',
];

function pickPrimary(capabilities: CapabilityKind[], kind: DeviceKind): CapabilityKind {
  if (kind === 'climate' && capabilities.includes('thermostat')) return 'thermostat';
  for (const candidate of PRIMARY_PRIORITY) {
    if (capabilities.includes(candidate)) return candidate;
  }
  return capabilities[0] ?? 'onOff';
}
