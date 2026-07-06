import {
  emptyState,
  luxFromMeasuredIlluminance,
  percentFromHalfPercent,
  type EndpointState,
} from '../../schema/index.js';

/**
 * Folds raw Matter attribute reports into canonical endpoint state — a 1:1
 * port of the GetHome app's `MatterStateReducer`, so hub-attached and
 * phone-attached Matter devices behave byte-identically. Operates on plain
 * (clusterId, attributeId, value) tuples, which keeps it testable without a
 * radio.
 */

export interface AttributeReport {
  endpointId: number;
  clusterId: number;
  attributeId: number;
  value: unknown;
}

export const Cluster = {
  onOff: 0x0006,
  levelControl: 0x0008,
  colorControl: 0x0300,
  thermostat: 0x0201,
  doorLock: 0x0101,
  windowCovering: 0x0102,
  fanControl: 0x0202,
  temperatureMeasurement: 0x0402,
  humidityMeasurement: 0x0405,
  illuminanceMeasurement: 0x0400,
  pressureMeasurement: 0x0403,
  flowMeasurement: 0x0404,
  occupancySensing: 0x0406,
  booleanState: 0x0045,
  airQuality: 0x005b,
  pm25Measurement: 0x042a,
  co2Measurement: 0x040d,
  smokeCOAlarm: 0x005c,
  powerSource: 0x002f,
  electricalPowerMeasurement: 0x0090,
  electricalEnergyMeasurement: 0x0091,
  mediaPlayback: 0x0506,
  modeSelect: 0x0050,
  rvcRunMode: 0x0054,
  rvcOperationalState: 0x0061,
  descriptor: 0x001d,
} as const;

const THERMOSTAT_NULL = -32_768; // 0x8000 as Int16

function asInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  return undefined;
}

function asDouble(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  return undefined;
}

function asBool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  const int = asInt(value);
  return int === undefined ? undefined : int !== 0;
}

const clampByte = (value: number) => Math.max(0, Math.min(255, value));

/**
 * Apply reports to a state, returning the next state and whether anything
 * changed. The input state is not mutated.
 */
export function reduceReports(
  state: EndpointState | undefined,
  reports: AttributeReport[],
): { next: EndpointState; changed: boolean } {
  const before = state ?? emptyState();
  const next = structuredClone(before);
  for (const report of reports) {
    route(report, next);
  }
  return { next, changed: JSON.stringify(next) !== JSON.stringify(before) };
}

function route(report: AttributeReport, state: EndpointState): void {
  const { clusterId, attributeId, value } = report;

  switch (clusterId) {
    case Cluster.onOff: {
      if (attributeId === 0x0000) {
        const flag = asBool(value);
        if (flag !== undefined) state.onOff = flag;
      }
      return;
    }

    case Cluster.levelControl: {
      const raw = asInt(value);
      if (raw === undefined || raw < 0 || raw > 254) return;
      const level = state.level ?? { current: 1, min: 1, max: 254 };
      if (attributeId === 0x0000) level.current = Math.max(1, raw);
      else if (attributeId === 0x0002) level.min = Math.max(1, raw);
      else if (attributeId === 0x0003) level.max = raw;
      else return;
      state.level = level;
      return;
    }

    case Cluster.colorControl: {
      switch (attributeId) {
        case 0x0007: {
          const raw = asInt(value);
          if (raw === undefined || raw <= 0 || raw > 0xfeff) return;
          const temp = state.colorTemperature ?? { mireds: raw, minMireds: 153, maxMireds: 500 };
          temp.mireds = raw;
          state.colorTemperature = temp;
          return;
        }
        case 0x400b: {
          const raw = asInt(value);
          if (raw === undefined || raw <= 0) return;
          const temp = state.colorTemperature ?? { mireds: raw, minMireds: 153, maxMireds: 500 };
          temp.minMireds = raw;
          state.colorTemperature = temp;
          return;
        }
        case 0x400c: {
          const raw = asInt(value);
          if (raw === undefined || raw <= 0) return;
          const temp = state.colorTemperature ?? { mireds: raw, minMireds: 153, maxMireds: 500 };
          temp.maxMireds = raw;
          state.colorTemperature = temp;
          return;
        }
        case 0x0000: {
          const raw = asInt(value);
          if (raw === undefined || raw < 0 || raw > 254) return;
          const color = state.colorHS ?? { hue: 0, saturation: 0, colorModeIsHueSaturation: true };
          color.hue = raw;
          state.colorHS = color;
          return;
        }
        case 0x0001: {
          const raw = asInt(value);
          if (raw === undefined || raw < 0 || raw > 254) return;
          const color = state.colorHS ?? { hue: 0, saturation: 0, colorModeIsHueSaturation: true };
          color.saturation = raw;
          state.colorHS = color;
          return;
        }
        case 0x0008: {
          const raw = asInt(value);
          if (raw === undefined || !state.colorHS) return;
          state.colorHS.colorModeIsHueSaturation = raw === 0;
          return;
        }
        default:
          return;
      }
    }

    case Cluster.thermostat: {
      const thermostat = state.thermostat ?? {
        heatSetpointMinCenti: 700,
        heatSetpointMaxCenti: 3000,
        coolSetpointMinCenti: 1600,
        coolSetpointMaxCenti: 3200,
        systemMode: 0,
      };
      const raw = asInt(value);
      if (raw === undefined) return;
      switch (attributeId) {
        case 0x0000:
          if (raw === THERMOSTAT_NULL) return;
          thermostat.localTemperatureCenti = raw;
          break;
        case 0x0012:
          thermostat.occupiedHeatingSetpointCenti = raw;
          break;
        case 0x0011:
          thermostat.occupiedCoolingSetpointCenti = raw;
          break;
        case 0x0015:
          if (raw <= thermostat.heatSetpointMaxCenti) thermostat.heatSetpointMinCenti = raw;
          break;
        case 0x0016:
          if (raw >= thermostat.heatSetpointMinCenti) thermostat.heatSetpointMaxCenti = raw;
          break;
        case 0x0017:
          if (raw <= thermostat.coolSetpointMaxCenti) thermostat.coolSetpointMinCenti = raw;
          break;
        case 0x0018:
          if (raw >= thermostat.coolSetpointMinCenti) thermostat.coolSetpointMaxCenti = raw;
          break;
        case 0x001c:
          thermostat.systemMode = clampByte(raw);
          break;
        default:
          return;
      }
      state.thermostat = thermostat;
      return;
    }

    case Cluster.doorLock: {
      if (attributeId !== 0x0000) return;
      const raw = asInt(value);
      if (raw === 0 || raw === 1 || raw === 2) state.lock = raw;
      return;
    }

    case Cluster.windowCovering: {
      const covering = state.covering ?? { currentPositionLiftPercent100ths: 0, isMoving: false };
      const raw = asInt(value);
      if (raw === undefined) return;
      if (attributeId === 0x000e) {
        if (raw < 0 || raw > 10_000) return;
        covering.currentPositionLiftPercent100ths = raw;
      } else if (attributeId === 0x000b) {
        if (raw < 0 || raw > 10_000) return;
        covering.targetPositionLiftPercent100ths = raw;
      } else if (attributeId === 0x000a) {
        covering.isMoving = (raw & 0b11) !== 0;
      } else {
        return;
      }
      state.covering = covering;
      return;
    }

    case Cluster.fanControl: {
      const fan = state.fan ?? { mode: 0, percentCurrent: 0 };
      const raw = asInt(value);
      if (raw === undefined) return;
      if (attributeId === 0x0000) fan.mode = clampByte(raw);
      else if (attributeId === 0x0003) {
        if (raw < 0 || raw > 100) return;
        fan.percentCurrent = raw;
      } else if (attributeId === 0x0002) {
        if (raw < 0 || raw > 100) return;
        fan.percentSetting = raw;
      } else return;
      state.fan = fan;
      return;
    }

    case Cluster.temperatureMeasurement: {
      const raw = asInt(value);
      if (attributeId === 0x0000 && raw !== undefined && raw !== THERMOSTAT_NULL) {
        state.sensors.temperatureCenti = raw;
      }
      return;
    }

    case Cluster.humidityMeasurement: {
      const raw = asInt(value);
      if (attributeId === 0x0000 && raw !== undefined && raw >= 0 && raw <= 10_000) {
        state.sensors.humidityCenti = raw;
      }
      return;
    }

    case Cluster.illuminanceMeasurement: {
      const raw = asInt(value);
      if (attributeId === 0x0000 && raw !== undefined) {
        state.sensors.illuminanceLux = luxFromMeasuredIlluminance(raw);
      }
      return;
    }

    case Cluster.pressureMeasurement: {
      const raw = asInt(value);
      if (attributeId === 0x0000 && raw !== undefined) state.sensors.pressureHPa = raw;
      return;
    }

    case Cluster.flowMeasurement: {
      const raw = asInt(value);
      if (attributeId === 0x0000 && raw !== undefined) {
        state.sensors.flowCubicMetersPerHour = raw / 10;
      }
      return;
    }

    case Cluster.occupancySensing: {
      const raw = asInt(value);
      if (attributeId === 0x0000 && raw !== undefined) state.sensors.occupied = (raw & 0b1) !== 0;
      return;
    }

    case Cluster.booleanState: {
      if (attributeId === 0x0000) {
        const flag = asBool(value);
        if (flag !== undefined) state.sensors.contactClosed = flag;
      }
      return;
    }

    case Cluster.airQuality: {
      const raw = asInt(value);
      if (attributeId === 0x0000 && raw !== undefined) {
        state.sensors.airQuality = Math.max(0, Math.min(6, raw));
      }
      return;
    }

    case Cluster.pm25Measurement: {
      const raw = asDouble(value);
      if (attributeId === 0x0000 && raw !== undefined) state.sensors.pm25 = raw;
      return;
    }

    case Cluster.co2Measurement: {
      const raw = asDouble(value);
      if (attributeId === 0x0000 && raw !== undefined) state.sensors.co2ppm = raw;
      return;
    }

    case Cluster.smokeCOAlarm: {
      const raw = asInt(value);
      if (raw === undefined) return;
      if (attributeId === 0x0001) state.sensors.smokeAlarm = clampByte(raw);
      else if (attributeId === 0x0002) state.sensors.coAlarm = clampByte(raw);
      return;
    }

    case Cluster.powerSource: {
      const raw = asInt(value);
      if (attributeId === 0x000c && raw !== undefined && raw >= 0 && raw <= 200) {
        state.battery = { percent: percentFromHalfPercent(raw) };
      }
      return;
    }

    case Cluster.electricalPowerMeasurement: {
      const raw = asInt(value);
      if (attributeId === 0x0008 && raw !== undefined) {
        const power = state.power ?? {};
        // Quantize to 0.1 W so chatty meters don't spam clients.
        power.activeMilliwatts = Math.trunc(raw / 100) * 100;
        state.power = power;
      }
      return;
    }

    case Cluster.electricalEnergyMeasurement: {
      const raw = asInt(value);
      if (attributeId === 0x0001 && raw !== undefined) {
        const power = state.power ?? {};
        power.importedEnergyMilliwattHours = raw;
        state.power = power;
      }
      return;
    }

    case Cluster.mediaPlayback: {
      const raw = asInt(value);
      if (attributeId === 0x0000 && raw !== undefined) {
        state.playbackPlaying = raw === 0; // PlaybackState 0 = playing
      }
      return;
    }

    case Cluster.modeSelect:
    case Cluster.rvcRunMode: {
      const modeAttribute = clusterId === Cluster.modeSelect ? 0x0003 : 0x0001;
      const raw = asInt(value);
      if (attributeId === modeAttribute && raw !== undefined) state.currentMode = clampByte(raw);
      return;
    }

    case Cluster.rvcOperationalState: {
      const raw = asInt(value);
      if (attributeId === 0x0004 && raw !== undefined) state.rvcOperationalState = clampByte(raw);
      return;
    }

    default:
      return;
  }
}
