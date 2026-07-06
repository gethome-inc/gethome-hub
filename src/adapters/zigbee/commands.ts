import {
  UnsupportedCommandError,
  clamp,
  degreesFromHue,
  percentFromSaturation,
  z2mPositionFromPercent100ths,
  type HubCommand,
} from '../../schema/index.js';
import type { Z2mCommandFeatures } from './exposes-mapper.js';

const CODE_TO_SYSTEM_MODE: Record<number, string> = { 0: 'off', 1: 'auto', 3: 'cool', 4: 'heat' };
const FAN_MODE_ORDER = ['off', 'low', 'medium', 'high', 'on', 'auto'];

/**
 * Translate a canonical command intent into the JSON payload published to
 * `zigbee2mqtt/<friendly_name>/set`.
 */
export function buildSetPayload(
  command: HubCommand,
  features: Z2mCommandFeatures,
): Record<string, unknown> {
  switch (command.type) {
    case 'power':
      if (features.isLock) {
        return { state: command.on ? features.onValue : features.offValue };
      }
      if (!features.hasOnOff) throw new UnsupportedCommandError(command.type, 'device has no switch');
      return { state: command.on ? features.onValue : features.offValue };

    case 'toggle':
      if (!features.hasOnOff) throw new UnsupportedCommandError(command.type, 'device has no switch');
      return { state: 'TOGGLE' };

    case 'setLevel': {
      if (!features.hasBrightness) throw new UnsupportedCommandError(command.type, 'device has no brightness');
      const payload: Record<string, unknown> = { brightness: clamp(Math.round(command.level), 1, 254) };
      if (command.transitionDs !== undefined) payload.transition = command.transitionDs / 10;
      return payload;
    }

    case 'setColorTemperature': {
      const range = features.colorTempRange;
      if (!range) throw new UnsupportedCommandError(command.type, 'device has no color temperature');
      return { color_temp: clamp(Math.round(command.mireds), range.min, range.max) };
    }

    case 'setHueSaturation':
      if (!features.hasColorHS) throw new UnsupportedCommandError(command.type, 'device has no color');
      return {
        color: {
          hue: Math.round(degreesFromHue(command.hue)),
          saturation: Math.round(percentFromSaturation(command.saturation)),
        },
      };

    case 'setHeatingSetpoint': {
      const property = features.heatingSetpointProperty;
      if (!property) throw new UnsupportedCommandError(command.type, 'device has no heating setpoint');
      return { [property]: command.centi / 100 };
    }

    case 'setCoolingSetpoint': {
      const property = features.coolingSetpointProperty;
      if (!property) throw new UnsupportedCommandError(command.type, 'device has no cooling setpoint');
      return { [property]: command.centi / 100 };
    }

    case 'setSystemMode': {
      const mode = CODE_TO_SYSTEM_MODE[command.mode];
      if (!mode || !features.systemModes?.includes(mode)) {
        throw new UnsupportedCommandError(command.type, `mode ${command.mode} not supported`);
      }
      return { system_mode: mode };
    }

    case 'lock':
      if (!features.isLock) throw new UnsupportedCommandError(command.type, 'not a lock');
      return { state: command.engage ? features.onValue : features.offValue };

    case 'setCoveringPercent':
      if (!features.hasPosition) throw new UnsupportedCommandError(command.type, 'cover has no position');
      return { position: z2mPositionFromPercent100ths(command.percent100ths) };

    case 'openCovering':
      if (!features.isCover) throw new UnsupportedCommandError(command.type, 'not a cover');
      return { state: 'OPEN' };

    case 'closeCovering':
      if (!features.isCover) throw new UnsupportedCommandError(command.type, 'not a cover');
      return { state: 'CLOSE' };

    case 'stopCovering':
      if (!features.isCover) throw new UnsupportedCommandError(command.type, 'not a cover');
      return { state: 'STOP' };

    case 'setFanMode': {
      const property = features.fanModeProperty;
      if (!property) throw new UnsupportedCommandError(command.type, 'device has no fan mode');
      const mode = FAN_MODE_ORDER[command.mode];
      if (!mode || !(features.fanModes ?? []).includes(mode)) {
        throw new UnsupportedCommandError(command.type, `fan mode ${command.mode} not supported`);
      }
      return { [property]: mode };
    }

    case 'setFanPercent': {
      // Zigbee fans are mode-based: snap the percent to the nearest speed.
      const property = features.fanModeProperty;
      if (!property) throw new UnsupportedCommandError(command.type, 'device has no fan mode');
      const available = (features.fanModes ?? []).filter((mode) =>
        ['off', 'low', 'medium', 'high'].includes(mode),
      );
      if (available.length === 0) throw new UnsupportedCommandError(command.type, 'no discrete speeds');
      const ladder = ['off', 'low', 'medium', 'high'].filter((mode) => available.includes(mode));
      const index = Math.round((clamp(command.percent, 0, 100) / 100) * (ladder.length - 1));
      return { [property]: ladder[index] };
    }

    case 'playPause':
    case 'setMode':
      throw new UnsupportedCommandError(command.type, 'not supported for Zigbee devices');
  }
}
