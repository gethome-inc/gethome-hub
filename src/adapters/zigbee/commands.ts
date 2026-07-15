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
 * `zigbee2mqtt/<friendly_name>/set`, using the endpoint's own property names
 * (multi-endpoint devices address channels as `state_l1`, `state_l2`, …).
 */
export function buildSetPayload(
  command: HubCommand,
  features: Z2mCommandFeatures,
): Record<string, unknown> {
  switch (command.type) {
    case 'power': {
      if (features.isLock) {
        return { [features.stateProperty ?? 'state']: command.on ? features.onValue : features.offValue };
      }
      if (!features.hasOnOff) throw new UnsupportedCommandError(command.type, 'device has no switch');
      return { [features.stateProperty ?? 'state']: command.on ? features.onValue : features.offValue };
    }

    case 'toggle':
      if (!features.hasOnOff) throw new UnsupportedCommandError(command.type, 'device has no switch');
      return { [features.stateProperty ?? 'state']: 'TOGGLE' };

    case 'setLevel': {
      if (!features.hasBrightness) throw new UnsupportedCommandError(command.type, 'device has no brightness');
      const payload: Record<string, unknown> = {
        [features.brightnessProperty ?? 'brightness']: clamp(Math.round(command.level), 1, 254),
      };
      if (command.transitionDs !== undefined) payload.transition = command.transitionDs / 10;
      return payload;
    }

    case 'setColorTemperature': {
      const range = features.colorTempRange;
      if (!range) throw new UnsupportedCommandError(command.type, 'device has no color temperature');
      return { [features.colorTempProperty ?? 'color_temp']: clamp(Math.round(command.mireds), range.min, range.max) };
    }

    case 'setHueSaturation':
      if (!features.hasColorHS) throw new UnsupportedCommandError(command.type, 'device has no color');
      return {
        [features.colorProperty ?? 'color']: {
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
      return { [features.systemModeProperty ?? 'system_mode']: mode };
    }

    case 'lock':
      if (!features.isLock) throw new UnsupportedCommandError(command.type, 'not a lock');
      return { [features.stateProperty ?? 'state']: command.engage ? features.onValue : features.offValue };

    case 'setCoveringPercent':
      if (!features.hasPosition) throw new UnsupportedCommandError(command.type, 'cover has no position');
      return { [features.positionProperty ?? 'position']: z2mPositionFromPercent100ths(command.percent100ths) };

    case 'openCovering':
      if (!features.isCover) throw new UnsupportedCommandError(command.type, 'not a cover');
      return { [features.coverStateProperty ?? 'state']: 'OPEN' };

    case 'closeCovering':
      if (!features.isCover) throw new UnsupportedCommandError(command.type, 'not a cover');
      return { [features.coverStateProperty ?? 'state']: 'CLOSE' };

    case 'stopCovering':
      if (!features.isCover) throw new UnsupportedCommandError(command.type, 'not a cover');
      return { [features.coverStateProperty ?? 'state']: 'STOP' };

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

    case 'irLearn': {
      const ir = features.irRemote;
      if (!ir) throw new UnsupportedCommandError(command.type, 'not an IR remote');
      return { [ir.learnProperty]: command.on ? ir.onValue : ir.offValue };
    }

    case 'irSendRaw': {
      const ir = features.irRemote;
      if (!ir) throw new UnsupportedCommandError(command.type, 'not an IR remote');
      return { [ir.sendProperty]: command.code };
    }

    case 'setCustomField': {
      const spec = features.customWrites?.[command.fieldId];
      if (!spec) throw new UnsupportedCommandError(command.type, `no field "${command.fieldId}"`);
      if (!spec.settable) throw new UnsupportedCommandError(command.type, `"${command.fieldId}" is read-only`);
      if (spec.control === 'toggle') {
        if (typeof command.value !== 'boolean') {
          throw new UnsupportedCommandError(command.type, 'toggle fields take a boolean');
        }
        return { [command.fieldId]: command.value ? spec.onValue : spec.offValue };
      }
      return { [command.fieldId]: command.value };
    }

    case 'irSaveLearned':
    case 'irSend':
    case 'irDeleteCommand':
    case 'irRenameCommand':
      // Library management is resolved by the registry against endpoint state;
      // it never reaches the adapter (send arrives pre-resolved as irSendRaw).
      throw new UnsupportedCommandError(command.type, 'handled by the registry');

    case 'playPause':
    case 'setMode':
      throw new UnsupportedCommandError(command.type, 'not supported for Zigbee devices');
  }
}
