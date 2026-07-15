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
import { buttonInventory, parseAction, type ButtonDescriptor } from './actions.js';

/**
 * Static mapping from Zigbee2MQTT "exposes" definitions into the canonical
 * GetHome schema. This is the first line of device support — tuned so that
 * common devices (Aqara sensors, buttons and relays are the baseline) map
 * fully with no AI round-trip. Anything it can't place lands in `unmapped`
 * and becomes an AI-mapping trigger (see src/ai/mapper.ts).
 *
 * Multi-endpoint devices (`state_l1`/`state_l2` relays, `left`/`right`
 * rockers) map statically: every Z2M endpoint label becomes a canonical
 * endpoint, and unlabeled ("whole device") exposes — battery, power, actions —
 * attach to endpoint 1.
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
  value_step?: number;
  values?: string[];
  features?: Z2mExpose[];
}

/** One declared generic control — mirrors `EndpointState['custom']`. */
export interface CustomFieldSpec {
  id: string;
  label: string;
  control: 'toggle' | 'slider' | 'select' | 'value';
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: Array<{ value: string | number; label: string }>;
  settable: boolean;
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

export interface Z2mEndpointProfile {
  /** Canonical endpoint id, 1-based and stable across restarts. */
  endpointId: number;
  /** The Z2M endpoint label ("l1", "left") — absent for the whole device. */
  label?: string;
  kind: DeviceKind;
  capabilities: CapabilityKind[];
  primary: CapabilityKind;
  /** Command-translation metadata gathered from this endpoint's exposes. */
  features: Z2mCommandFeatures;
  /** Button inventory when the endpoint has the `event` capability. */
  buttons?: ButtonDescriptor[];
  /** Declared generic controls when the endpoint has the `custom` capability. */
  customFields?: CustomFieldSpec[];
}

export interface Z2mProfile {
  /** Always at least one endpoint; endpoint 1 carries whole-device exposes. */
  endpoints: Z2mEndpointProfile[];
  /**
   * Properties without a *typed* capability mapping — the AI-upgrade
   * candidates. Many of these still work today as generic custom fields.
   */
  unmapped: string[];
  /**
   * Properties with NO representation at all (no typed mapping, no custom
   * field) — the only thing that keeps a device in needs-review.
   */
  uncovered: string[];
  /** Every payload key the profile reads or deliberately ignores. */
  knownProperties: Set<string>;
  /** Convert one Z2M state payload into per-endpoint canonical patches. */
  extractState(payload: Record<string, unknown>): Map<number, Partial<EndpointState>>;
}

export interface Z2mCommandFeatures {
  /** value_on/value_off of the switch/lock state feature. */
  onValue: unknown;
  offValue: unknown;
  hasOnOff: boolean;
  /** Payload key of the on/off state ("state", "state_l1", "state_left"). */
  stateProperty?: string;
  hasBrightness: boolean;
  brightnessProperty?: string;
  colorTempRange?: { min: number; max: number };
  colorTempProperty?: string;
  hasColorHS: boolean;
  colorProperty?: string;
  hasPosition: boolean;
  positionProperty?: string;
  isCover: boolean;
  /** The OPEN/CLOSE/STOP command property for covers (usually "state"). */
  coverStateProperty?: string;
  isLock: boolean;
  /** The heating-setpoint property name (varies per TRV). */
  heatingSetpointProperty?: string;
  coolingSetpointProperty?: string;
  systemModes?: string[];
  systemModeProperty?: string;
  fanModes?: string[];
  fanModeProperty?: string;
  /** IR blaster / universal remote (learn + replay), when present. */
  irRemote?: {
    learnProperty: string;
    sendProperty: string;
    onValue: unknown;
    offValue: unknown;
  };
  /** Write metadata for declared custom fields, keyed by field id. */
  customWrites?: Record<
    string,
    { control: CustomFieldSpec['control']; settable: boolean; onValue?: unknown; offValue?: unknown }
  >;
}

/**
 * Payload keys that are pure telemetry/diagnostics — noise, never shown.
 * They are deliberately *known* (so they don't look like new parameters at
 * runtime) but produce no state and no controls.
 */
export const IGNORED_PROPERTIES = new Set([
  'linkquality',
  'voltage',
  'current',
  'action_group',
  'action_rate',
  'action_step_size',
  'action_transition_time',
  'action_side',
  'action_from_side',
  'action_to_side',
  'action_angle',
  'side',
  'angle',
  'angle_x',
  'angle_y',
  'angle_z',
  'strength',
  'transition',
  'identify',
  'update',
  'update_available',
  'device_temperature',
  'running_state',
  'position_left', // multi-motor covers: v1 maps the primary motor only
  'color_mode',
  'color_temp_startup',
  'gradient',
  'gradient_scene',
  'power_outage_count',
  'options',
  'tamper',
  'battery_low',
  'vibration', // the paired `action` enum carries vibration/tilt/drop events
  'trigger_count',
  'schedule',
  'schedule_settings',
  'calibrated',
]);

/**
 * Device settings — real, user-adjustable parameters (child locks, presets,
 * sensitivities, indicator LEDs…). They become generic custom fields
 * (toggle/slider/select per their expose metadata) so the apps can adjust
 * them, but they never trigger the AI: a field already represents them
 * perfectly, there is no typed capability to upgrade to.
 */
export const SETTINGS_PROPERTIES = new Set([
  'power_on_behavior',
  'effect',
  'indicator_mode',
  'backlight_mode',
  'child_lock',
  'sensitivity',
  'motor_speed',
  'motor_direction',
  'operation_mode',
  'click_mode',
  'switch_type',
  'flip_indicator_light',
  'led_disabled_night',
  'led_indication',
  'calibration',
  'calibrate',
  'reverse_direction',
  'hand_open',
  'detection_interval',
  'occupancy_timeout',
  'local_temperature_calibration',
  'auto_off',
  'interlock',
  'away_mode',
  'power_outage_memory',
  'keypad_lockout',
  'boost_time',
]);

const thermostatDefaults = {
  heatSetpointMinCenti: 700,
  heatSetpointMaxCenti: 3000,
  coolSetpointMinCenti: 1600,
  coolSetpointMaxCenti: 3200,
};

const SYSTEM_MODE_TO_CODE: Record<string, number> = { off: 0, auto: 1, cool: 3, heat: 4 };
const FAN_MODE_ORDER = ['off', 'low', 'medium', 'high', 'on', 'auto'];

/** The three standard IR-blaster properties (Zosung/Tuya universal remotes). */
const IR_PROPERTIES = new Set(['learn_ir_code', 'learned_ir_code', 'ir_code_to_send']);

type StateRule = (value: unknown, patch: PatchBuilder) => void;

/** Mutable draft the rules write into; finalized into a state patch. */
class PatchBuilder {
  onOff?: boolean;
  level?: { current: number; min: number; max: number };
  colorTemperature?: { mireds: number; minMireds: number; maxMireds: number };
  colorHS?: { hue: number; saturation: number; colorModeIsHueSaturation: boolean };
  thermostat?: NonNullable<EndpointState['thermostat']>;
  lock?: 0 | 1 | 2;
  coveringPosition?: number;
  coveringMoving?: boolean;
  fan?: { mode: number; percentCurrent: number };
  sensors: NonNullable<EndpointState['sensors']> = {};
  battery?: { percent: number };
  power?: { activeMilliwatts?: number; importedEnergyMilliwattHours?: number };
  event?: NonNullable<EndpointState['event']>;
  /** Partial IR patch — merged onto the seeded library base by mergeState. */
  irRemote?: { learning: boolean; pendingCode: string };
  customValues?: Record<string, string | number | boolean>;

  setCustomValue(id: string, value: string | number | boolean) {
    (this.customValues ??= {})[id] = value;
  }

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
    // A moving flag alone can't ship: the wire contract requires a position,
    // and the clients decode `covering` strictly. Z2M covers publish both in
    // motion reports, so this loses nothing in practice.
    if (this.coveringPosition !== undefined) {
      patch.covering = {
        currentPositionLiftPercent100ths: this.coveringPosition,
        isMoving: this.coveringMoving ?? false,
      };
    }
    if (this.fan) patch.fan = this.fan;
    if (Object.keys(this.sensors).length > 0) patch.sensors = this.sensors;
    if (this.battery) patch.battery = this.battery;
    if (this.power) patch.power = this.power;
    if (this.event) patch.event = this.event;
    // A partial IR patch (learning + pendingCode); mergeState folds it onto
    // the seeded base carrying the commands library.
    if (this.irRemote) (patch as Record<string, unknown>).irRemote = this.irRemote;
    // Partial custom values; mergeState folds them per key onto the seeded
    // inventory base.
    if (this.customValues) patch.custom = { values: this.customValues };
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

/** Working state for one endpoint while the exposes are walked. */
class EndpointDraft {
  capabilities = new Set<CapabilityKind>();
  features: Z2mCommandFeatures = {
    onValue: 'ON',
    offValue: 'OFF',
    hasOnOff: false,
    hasBrightness: false,
    hasColorHS: false,
    hasPosition: false,
    isCover: false,
    isLock: false,
    customWrites: {},
  };
  controlKind?: DeviceKind;
  sensorKind?: DeviceKind;
  sawClimate = false;
  buttons?: ButtonDescriptor[];
  customFields: CustomFieldSpec[] = [];

  constructor(
    readonly endpointId: number,
    readonly label?: string,
  ) {}

  setControlKind(kind: DeviceKind) {
    this.controlKind ??= kind;
  }

  setSensorKind(kind: DeviceKind) {
    this.sensorKind ??= kind;
  }
}

/**
 * Build the profile for one Z2M device: walk the exposes, route each to its
 * endpoint draft (labeled exposes to their own endpoints, unlabeled to
 * endpoint 1), and compile the per-property extraction rules.
 */
export function mapExposes(device: Z2mDevice): Z2mProfile {
  const exposes = device.definition?.exposes ?? [];
  const unmapped: string[] = [];
  const uncovered: string[] = [];
  const rules = new Map<string, { endpointId: number; rule: StateRule }>();

  const drafts = new Map<number, EndpointDraft>();
  const endpointIdByLabel = new Map<string, number>();
  const globalDraft = () => draftFor(undefined);

  function draftFor(label: string | undefined): EndpointDraft {
    if (label === undefined) {
      const existing = drafts.get(1);
      if (existing) return existing;
      const draft = new EndpointDraft(1);
      drafts.set(1, draft);
      return draft;
    }
    let id = endpointIdByLabel.get(label);
    if (id === undefined) {
      // First label claims endpoint 1 (shared with whole-device exposes),
      // later labels get the next free ids — stable, exposes-order based.
      id = endpointIdByLabel.size + 1;
      endpointIdByLabel.set(label, id);
    }
    const existing = drafts.get(id);
    if (existing) {
      return existing;
    }
    const draft = new EndpointDraft(id, label);
    drafts.set(id, draft);
    return draft;
  }

  const addRule = (draft: EndpointDraft, property: string, rule: StateRule) => {
    rules.set(property, { endpointId: draft.endpointId, rule });
  };

  const mapSensorNumeric = (
    draft: EndpointDraft,
    property: string,
    apply: (value: number, patch: PatchBuilder) => void,
    capability: CapabilityKind,
  ) => {
    draft.capabilities.add(capability);
    addRule(draft, property, (value, patch) => {
      const parsed = asNumber(value);
      if (parsed !== undefined) apply(parsed, patch);
    });
  };

  /**
   * The universal fallback: turn a simple leftover expose into a declared
   * custom field, using the expose's own metadata — type → control, access
   * bit 2 → settable, value_min/max/step/unit → slider shape, values → select
   * options. Returns false for shapes a generic field can't represent
   * (composite/list), which are the AI's job.
   */
  const makeCustomField = (draft: EndpointDraft, expose: Z2mExpose): boolean => {
    const property = expose.property ?? expose.name;
    if (!property || draft.customFields.length >= 32) return false;
    if (draft.customFields.some((field) => field.id === property)) return true;
    const settable = ((expose.access ?? 0) & 0b010) !== 0;
    const label = fieldLabel(expose.name ?? property);

    let spec: CustomFieldSpec;
    switch (expose.type) {
      case 'binary': {
        const onValue = expose.value_on ?? true;
        const offValue = expose.value_off ?? false;
        spec = { id: property, label, control: 'toggle', settable };
        draft.features.customWrites![property] = { control: 'toggle', settable, onValue, offValue };
        addRule(draft, property, (value, patch) => {
          const flag = value === onValue ? true : value === offValue ? false : asBool(value);
          if (flag !== undefined) patch.setCustomValue(property, flag);
        });
        break;
      }
      case 'numeric': {
        const hasRange = expose.value_min !== undefined && expose.value_max !== undefined;
        const asSlider = settable && hasRange;
        spec = {
          id: property,
          label,
          control: asSlider ? 'slider' : 'value',
          ...(expose.unit ? { unit: expose.unit } : {}),
          ...(expose.value_min !== undefined ? { min: expose.value_min } : {}),
          ...(expose.value_max !== undefined ? { max: expose.value_max } : {}),
          ...(expose.value_step !== undefined ? { step: expose.value_step } : {}),
          settable: asSlider,
        };
        draft.features.customWrites![property] = { control: spec.control, settable: spec.settable };
        addRule(draft, property, (value, patch) => {
          const parsed = asNumber(value);
          if (parsed !== undefined) patch.setCustomValue(property, parsed);
        });
        break;
      }
      case 'enum': {
        const values = (expose.values ?? []).filter((value) => typeof value === 'string' && value !== '');
        if (values.length === 0) return false;
        spec = {
          id: property,
          label,
          control: settable ? 'select' : 'value',
          options: values.slice(0, 32).map((value) => ({ value, label: fieldLabel(value) })),
          settable,
        };
        draft.features.customWrites![property] = { control: spec.control, settable };
        addRule(draft, property, (value, patch) => {
          if (typeof value === 'string' || typeof value === 'number') {
            patch.setCustomValue(property, value);
          }
        });
        break;
      }
      case 'text': {
        spec = { id: property, label, control: 'value', settable: false };
        draft.features.customWrites![property] = { control: 'value', settable: false };
        addRule(draft, property, (value, patch) => {
          if (typeof value === 'string') patch.setCustomValue(property, value);
        });
        break;
      }
      default:
        return false;
    }
    draft.customFields.push(spec);
    draft.capabilities.add('custom');
    return true;
  };

  /**
   * Route one leftover expose (nothing typed matched): diagnostics vanish,
   * everything else becomes a custom field where representable. Settings are
   * served perfectly by their field and stay silent; genuine unknowns remain
   * AI-upgrade candidates, and shapes with no field at all are `uncovered`
   * (the only thing that flags needs-review).
   */
  const handleLeftover = (draft: EndpointDraft, expose: Z2mExpose) => {
    const property = expose.property ?? expose.name;
    if (!property || IGNORED_PROPERTIES.has(property)) return;
    const fielded = makeCustomField(draft, expose);
    if (SETTINGS_PROPERTIES.has(property)) return;
    unmapped.push(property);
    if (!fielded) uncovered.push(property);
  };

  const handleIrRemote = (draft: EndpointDraft, expose: Z2mExpose) => {
    // IR blaster / universal remote: three standard Zosung/Tuya properties —
    // learn_ir_code (SET, enter learn mode), learned_ir_code (STATE, the
    // captured blob), ir_code_to_send (SET, transmit a blob). The learned-code
    // library is owned by the registry; here we only declare the capability,
    // capture the command property names, and reflect a fresh capture into
    // pendingCode.
    const property = expose.property ?? expose.name;
    draft.capabilities.add('irRemote');
    draft.features.irRemote ??= {
      learnProperty: 'learn_ir_code',
      sendProperty: 'ir_code_to_send',
      onValue: 'ON',
      offValue: 'OFF',
    };
    if (property === 'learn_ir_code') {
      draft.features.irRemote.learnProperty = property;
      if (expose.value_on !== undefined) draft.features.irRemote.onValue = expose.value_on;
      if (expose.value_off !== undefined) draft.features.irRemote.offValue = expose.value_off;
    } else if (property === 'ir_code_to_send') {
      draft.features.irRemote.sendProperty = property;
    } else if (property === 'learned_ir_code') {
      addRule(draft, property, (value, patch) => {
        if (typeof value === 'string' && value.trim() !== '') {
          patch.irRemote = { learning: false, pendingCode: value };
        }
      });
    }
  };

  const handleAction = (expose: Z2mExpose, property: string) => {
    // Buttons/remotes/cubes: the flat `action` enum becomes the canonical
    // event capability, always on the whole-device endpoint.
    const draft = globalDraft();
    draft.capabilities.add('event');
    const inventory = buttonInventory(expose.values ?? []);
    if (inventory.length > 0) draft.buttons = inventory;
    addRule(draft, property, (value, patch) => {
      if (typeof value !== 'string' || value.trim() === '') return;
      const { button, gesture } = parseAction(value);
      patch.event = { action: value, button, gesture, at: Date.now() };
    });
  };

  const handleSimple = (draft: EndpointDraft, expose: Z2mExpose): boolean => {
    const property = expose.property ?? expose.name;
    if (!property) return true;
    switch (property) {
      case 'temperature':
        mapSensorNumeric(draft, property, (v, p) => (p.sensors.temperatureCenti = centiFromCelsius(v)), 'temperature');
        return true;
      case 'humidity':
        mapSensorNumeric(draft, property, (v, p) => (p.sensors.humidityCenti = Math.round(v * 100)), 'humidity');
        return true;
      case 'illuminance':
      case 'illuminance_lux':
        mapSensorNumeric(draft, property, (v, p) => (p.sensors.illuminanceLux = v), 'illuminance');
        return true;
      case 'pressure':
        mapSensorNumeric(draft, property, (v, p) => (p.sensors.pressureHPa = v), 'pressure');
        return true;
      case 'battery':
        mapSensorNumeric(draft, property, (v, p) => (p.battery = { percent: clamp(Math.round(v), 0, 100) }), 'battery');
        return true;
      case 'power':
        mapSensorNumeric(
          draft,
          property,
          (v, p) => (p.ensurePower().activeMilliwatts = Math.round(v * 1000)),
          'electricalPower',
        );
        return true;
      case 'energy':
        mapSensorNumeric(
          draft,
          property,
          (v, p) => (p.ensurePower().importedEnergyMilliwattHours = Math.round(v * 1_000_000)),
          'electricalPower',
        );
        return true;
      case 'pm25':
        mapSensorNumeric(draft, property, (v, p) => (p.sensors.pm25 = v), 'pm25');
        return true;
      case 'co2':
        mapSensorNumeric(draft, property, (v, p) => (p.sensors.co2ppm = v), 'co2');
        return true;
      case 'occupancy':
      case 'presence': // Aqara FP1/FP2 mmWave presence
        draft.capabilities.add('occupancy');
        addRule(draft, property, (value, patch) => {
          const parsed = asBool(value);
          if (parsed !== undefined) patch.sensors.occupied = parsed;
        });
        draft.setSensorKind('sensor');
        return true;
      case 'contact':
        draft.capabilities.add('contact');
        addRule(draft, property, (value, patch) => {
          const parsed = asBool(value);
          if (parsed !== undefined) patch.sensors.contactClosed = parsed;
        });
        draft.setSensorKind('sensor');
        return true;
      case 'water_leak':
        draft.capabilities.add('contact');
        addRule(draft, property, (value, patch) => {
          const parsed = asBool(value);
          if (parsed !== undefined) patch.sensors.contactClosed = !parsed;
        });
        draft.setSensorKind('sensor');
        return true;
      case 'smoke':
        draft.capabilities.add('smokeCOAlarm');
        addRule(draft, property, (value, patch) => {
          const parsed = asBool(value);
          if (parsed !== undefined) patch.sensors.smokeAlarm = parsed ? 2 : 0;
        });
        draft.setSensorKind('sensor');
        return true;
      case 'carbon_monoxide':
        draft.capabilities.add('smokeCOAlarm');
        addRule(draft, property, (value, patch) => {
          const parsed = asBool(value);
          if (parsed !== undefined) patch.sensors.coAlarm = parsed ? 2 : 0;
        });
        draft.setSensorKind('sensor');
        return true;
      case 'running':
      case 'moving':
        // Movement flag published next to a cover (Aqara curtain drivers).
        // It only ships inside a covering patch that also carries a position,
        // so it is harmless on devices where it means something else.
        addRule(draft, property, (value, patch) => {
          const parsed = asBool(value);
          if (parsed !== undefined) patch.coveringMoving = parsed;
        });
        return true;
      default:
        return false;
    }
  };

  const handleLightOrSwitch = (expose: Z2mExpose, asLight: boolean) => {
    const draft = draftFor(expose.endpoint);
    draft.setControlKind(asLight ? 'light' : 'outlet');
    for (const feature of expose.features ?? []) {
      const property = feature.property ?? feature.name;
      if (!property) continue;
      switch (feature.name ?? property) {
        case 'state': {
          draft.capabilities.add('onOff');
          draft.features.hasOnOff = true;
          draft.features.stateProperty = property;
          draft.features.onValue = feature.value_on ?? 'ON';
          draft.features.offValue = feature.value_off ?? 'OFF';
          const onValue = draft.features.onValue;
          addRule(draft, property, (value, patch) => {
            patch.onOff = value === onValue;
          });
          break;
        }
        case 'brightness': {
          draft.capabilities.add('level');
          draft.features.hasBrightness = true;
          draft.features.brightnessProperty = property;
          addRule(draft, property, (value, patch) => {
            const parsed = asNumber(value);
            if (parsed !== undefined) {
              patch.level = { current: clamp(Math.round(parsed), 1, 254), min: 1, max: 254 };
            }
          });
          break;
        }
        case 'color_temp': {
          draft.capabilities.add('colorTemperature');
          const min = feature.value_min ?? 153;
          const max = feature.value_max ?? 500;
          draft.features.colorTempRange = { min, max };
          draft.features.colorTempProperty = property;
          addRule(draft, property, (value, patch) => {
            const parsed = asNumber(value);
            if (parsed !== undefined) {
              patch.colorTemperature = { mireds: Math.round(parsed), minMireds: min, maxMireds: max };
            }
          });
          break;
        }
        case 'color_hs':
        case 'color_xy': {
          draft.capabilities.add('color');
          draft.features.hasColorHS = true;
          draft.features.colorProperty = property;
          addRule(draft, property, (value, patch) => {
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
          handleLeftover(draft, feature);
      }
    }
  };

  const handleCover = (expose: Z2mExpose) => {
    const draft = draftFor(expose.endpoint);
    draft.setControlKind('shade');
    draft.features.isCover = true;
    draft.capabilities.add('windowCovering');
    for (const feature of expose.features ?? []) {
      const property = feature.property ?? feature.name;
      if (!property) continue;
      switch (feature.name ?? property) {
        case 'state':
          // OPEN/CLOSE/STOP — command-only; position carries the state.
          draft.features.coverStateProperty = property;
          break;
        case 'position':
          draft.features.hasPosition = true;
          draft.features.positionProperty = property;
          addRule(draft, property, (value, patch) => {
            const parsed = asNumber(value);
            if (parsed !== undefined) {
              patch.coveringPosition = percent100thsFromZ2mPosition(parsed);
            }
          });
          break;
        case 'running':
        case 'moving':
          addRule(draft, property, (value, patch) => {
            const parsed = asBool(value);
            if (parsed !== undefined) patch.coveringMoving = parsed;
            else if (typeof value === 'string') {
              patch.coveringMoving = value !== 'stopped' && value !== 'STOP';
            }
          });
          break;
        case 'tilt':
          break; // v1: lift only
        default:
          handleLeftover(draft, feature);
      }
    }
  };

  const handleLock = (expose: Z2mExpose) => {
    const draft = draftFor(expose.endpoint);
    draft.setControlKind('lock');
    draft.features.isLock = true;
    draft.capabilities.add('doorLock');
    for (const feature of expose.features ?? []) {
      const property = feature.property ?? feature.name;
      if (!property) continue;
      if ((feature.name ?? property) === 'state') {
        draft.features.stateProperty = property;
        draft.features.onValue = feature.value_on ?? 'LOCK';
        draft.features.offValue = feature.value_off ?? 'UNLOCK';
      } else if ((feature.name ?? property) === 'lock_state') {
        addRule(draft, property, (value, patch) => {
          if (value === 'locked') patch.lock = 1;
          else if (value === 'unlocked') patch.lock = 2;
          else if (typeof value === 'string') patch.lock = 0;
        });
      } else {
        handleLeftover(draft, feature);
      }
    }
  };

  const handleClimate = (expose: Z2mExpose) => {
    const draft = draftFor(expose.endpoint);
    draft.setControlKind('climate');
    draft.sawClimate = true;
    draft.capabilities.add('thermostat');
    for (const feature of expose.features ?? []) {
      const property = feature.property ?? feature.name;
      if (!property) continue;
      switch (feature.name ?? property) {
        case 'local_temperature':
          addRule(draft, property, (value, patch) => {
            const parsed = asNumber(value);
            if (parsed !== undefined) patch.ensureThermostat().localTemperatureCenti = centiFromCelsius(parsed);
          });
          break;
        case 'current_heating_setpoint':
        case 'occupied_heating_setpoint': {
          draft.features.heatingSetpointProperty = property;
          const minCenti = feature.value_min !== undefined ? centiFromCelsius(feature.value_min) : 700;
          const maxCenti = feature.value_max !== undefined ? centiFromCelsius(feature.value_max) : 3000;
          addRule(draft, property, (value, patch) => {
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
          draft.features.coolingSetpointProperty = property;
          addRule(draft, property, (value, patch) => {
            const parsed = asNumber(value);
            if (parsed !== undefined) {
              patch.ensureThermostat().occupiedCoolingSetpointCenti = centiFromCelsius(parsed);
            }
          });
          break;
        }
        case 'system_mode': {
          draft.features.systemModes = feature.values ?? [];
          draft.features.systemModeProperty = property;
          addRule(draft, property, (value, patch) => {
            if (typeof value === 'string' && value in SYSTEM_MODE_TO_CODE) {
              patch.ensureThermostat().systemMode = SYSTEM_MODE_TO_CODE[value]!;
            }
          });
          break;
        }
        case 'running_state':
          break;
        default:
          handleLeftover(draft, feature);
      }
    }
  };

  const handleFan = (expose: Z2mExpose) => {
    const draft = draftFor(expose.endpoint);
    draft.setControlKind('fan');
    draft.capabilities.add('fan');
    for (const feature of expose.features ?? []) {
      const property = feature.property ?? feature.name;
      if (!property) continue;
      if ((feature.name ?? property) === 'mode' || property === 'fan_mode') {
        draft.features.fanModes = feature.values ?? FAN_MODE_ORDER;
        draft.features.fanModeProperty = property;
        addRule(draft, property, (value, patch) => {
          if (typeof value === 'string') {
            const index = FAN_MODE_ORDER.indexOf(value);
            if (index >= 0) patch.fan = { mode: index, percentCurrent: 0 };
          }
        });
      } else if ((feature.name ?? property) === 'state' || property === 'fan_state') {
        draft.capabilities.add('onOff');
        draft.features.hasOnOff = true;
        draft.features.stateProperty = property;
        const onValue = feature.value_on ?? 'ON';
        draft.features.onValue = onValue;
        draft.features.offValue = feature.value_off ?? 'OFF';
        addRule(draft, property, (value, patch) => {
          patch.onOff = value === onValue;
        });
      } else {
        handleLeftover(draft, feature);
      }
    }
  };

  for (const expose of exposes) {
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
        if ((property === 'action' || property === 'click') && expose.type === 'enum') {
          handleAction(expose, property);
          break;
        }
        if (IR_PROPERTIES.has(property)) {
          handleIrRemote(draftFor(expose.endpoint), expose);
          break;
        }
        if (handleSimple(draftFor(expose.endpoint), expose)) break;
        handleLeftover(draftFor(expose.endpoint), expose);
        break;
      }
      default:
        break;
    }
  }

  // Ensure endpoint 1 exists even for definition-less devices.
  globalDraft();

  const multiEndpoint = endpointIdByLabel.size > 0;
  const description = device.definition?.description?.toLowerCase() ?? '';

  const endpoints: Z2mEndpointProfile[] = [...drafts.values()]
    .sort((a, b) => a.endpointId - b.endpointId)
    .map((draft) => {
      let kind = draft.controlKind ?? draft.sensorKind;
      // A metering single switch is an outlet; a bare relay is closer to a
      // wall switch, and multi-gang modules are wall switches outright.
      if (kind === 'outlet') {
        const metered = draft.capabilities.has('electricalPower');
        if (multiEndpoint) kind = 'wallSwitch';
        else if (!metered && !description.includes('plug')) kind = 'wallSwitch';
      }
      if (draft.sawClimate) kind = 'climate';
      if (!kind) {
        kind = draft.capabilities.has('event') || draft.capabilities.has('irRemote') ? 'remote' : 'sensor';
      }

      const capabilities = [...draft.capabilities];
      return {
        endpointId: draft.endpointId,
        ...(draft.label !== undefined ? { label: draft.label } : {}),
        kind,
        capabilities,
        primary: pickPrimary(capabilities, kind),
        features: draft.features,
        ...(draft.buttons ? { buttons: draft.buttons } : {}),
        ...(draft.customFields.length > 0 ? { customFields: draft.customFields } : {}),
      };
    });

  const knownProperties = new Set<string>([...rules.keys(), ...IGNORED_PROPERTIES]);
  // IR command properties are SET-only (never published), but list them as
  // known so they never look like a new runtime parameter.
  for (const endpoint of endpoints) {
    if (endpoint.features.irRemote) {
      knownProperties.add(endpoint.features.irRemote.learnProperty);
      knownProperties.add(endpoint.features.irRemote.sendProperty);
    }
  }
  const uniqueUnmapped = [...new Set(unmapped)];
  const uniqueUncovered = [...new Set(uncovered)];

  return {
    endpoints,
    unmapped: uniqueUnmapped,
    uncovered: uniqueUncovered,
    knownProperties,
    extractState(payload) {
      const builders = new Map<number, PatchBuilder>();
      for (const [property, value] of Object.entries(payload)) {
        const entry = rules.get(property);
        if (!entry) continue;
        let builder = builders.get(entry.endpointId);
        if (!builder) {
          builder = new PatchBuilder();
          builders.set(entry.endpointId, builder);
        }
        entry.rule(value, builder);
      }
      const patches = new Map<number, Partial<EndpointState>>();
      for (const [endpointId, builder] of builders) {
        const patch = builder.build();
        if (Object.keys(patch).length > 0) patches.set(endpointId, patch);
      }
      return patches;
    },
  };
}

const PRIMARY_PRIORITY: CapabilityKind[] = [
  'thermostat',
  'doorLock',
  'windowCovering',
  'onOff',
  'fan',
  'irRemote',
  'event',
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
  'custom',
];

function pickPrimary(capabilities: CapabilityKind[], kind: DeviceKind): CapabilityKind {
  if (kind === 'climate' && capabilities.includes('thermostat')) return 'thermostat';
  for (const candidate of PRIMARY_PRIORITY) {
    if (capabilities.includes(candidate)) return candidate;
  }
  return capabilities[0] ?? 'onOff';
}

/** "child_lock" → "Child lock", "eco" → "Eco". */
function fieldLabel(id: string): string {
  const words = id.split('_').join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
