import type { Endpoint } from '@project-chip/matter.js/device';
import {
  ColorControl,
  DoorLock,
  FanControl,
  LevelControl,
  MediaPlayback,
  ModeSelect,
  OnOff,
  Thermostat,
  WindowCovering,
} from '@matter/main/clusters';
import { UnsupportedCommandError, type HubCommand } from '../../schema/index.js';

/**
 * Translate the 17 canonical intents into Matter cluster commands and
 * attribute writes — the same cluster/command mapping the GetHome app uses
 * for phone-attached devices (docs/matter.md).
 */
export async function executeMatterCommand(endpoint: Endpoint, command: HubCommand): Promise<void> {
  switch (command.type) {
    case 'power': {
      const client = endpoint.getClusterClient(OnOff.Complete);
      if (!client) throw new UnsupportedCommandError(command.type, 'no On/Off cluster');
      await (command.on ? client.on() : client.off());
      return;
    }

    case 'toggle': {
      const client = endpoint.getClusterClient(OnOff.Complete);
      if (!client) throw new UnsupportedCommandError(command.type, 'no On/Off cluster');
      await client.toggle();
      return;
    }

    case 'setLevel': {
      const client = endpoint.getClusterClient(LevelControl.Complete);
      if (!client) throw new UnsupportedCommandError(command.type, 'no Level Control cluster');
      await client.moveToLevelWithOnOff({
        level: command.level,
        transitionTime: command.transitionDs ?? 0,
        optionsMask: {},
        optionsOverride: {},
      });
      return;
    }

    case 'setColorTemperature': {
      const client = endpoint.getClusterClient(ColorControl.Complete);
      if (!client) throw new UnsupportedCommandError(command.type, 'no Color Control cluster');
      await client.moveToColorTemperature({
        colorTemperatureMireds: command.mireds,
        transitionTime: 0,
        optionsMask: {},
        optionsOverride: {},
      });
      return;
    }

    case 'setHueSaturation': {
      const client = endpoint.getClusterClient(ColorControl.Complete);
      if (!client) throw new UnsupportedCommandError(command.type, 'no Color Control cluster');
      await client.moveToHueAndSaturation({
        hue: command.hue,
        saturation: command.saturation,
        transitionTime: 0,
        optionsMask: {},
        optionsOverride: {},
      });
      return;
    }

    case 'setHeatingSetpoint': {
      const client = endpoint.getClusterClient(Thermostat.Complete);
      if (!client) throw new UnsupportedCommandError(command.type, 'no Thermostat cluster');
      await client.setOccupiedHeatingSetpointAttribute(command.centi);
      return;
    }

    case 'setCoolingSetpoint': {
      const client = endpoint.getClusterClient(Thermostat.Complete);
      if (!client) throw new UnsupportedCommandError(command.type, 'no Thermostat cluster');
      await client.setOccupiedCoolingSetpointAttribute(command.centi);
      return;
    }

    case 'setSystemMode': {
      const client = endpoint.getClusterClient(Thermostat.Complete);
      if (!client) throw new UnsupportedCommandError(command.type, 'no Thermostat cluster');
      await client.setSystemModeAttribute(command.mode);
      return;
    }

    case 'lock': {
      const client = endpoint.getClusterClient(DoorLock.Complete);
      if (!client) throw new UnsupportedCommandError(command.type, 'no Door Lock cluster');
      await (command.engage ? client.lockDoor({}) : client.unlockDoor({}));
      return;
    }

    case 'setCoveringPercent': {
      const client = endpoint.getClusterClient(WindowCovering.Complete);
      if (!client) throw new UnsupportedCommandError(command.type, 'no Window Covering cluster');
      await client.goToLiftPercentage({ liftPercent100thsValue: command.percent100ths });
      return;
    }

    case 'openCovering': {
      const client = endpoint.getClusterClient(WindowCovering.Complete);
      if (!client) throw new UnsupportedCommandError(command.type, 'no Window Covering cluster');
      await client.upOrOpen();
      return;
    }

    case 'closeCovering': {
      const client = endpoint.getClusterClient(WindowCovering.Complete);
      if (!client) throw new UnsupportedCommandError(command.type, 'no Window Covering cluster');
      await client.downOrClose();
      return;
    }

    case 'stopCovering': {
      const client = endpoint.getClusterClient(WindowCovering.Complete);
      if (!client) throw new UnsupportedCommandError(command.type, 'no Window Covering cluster');
      await client.stopMotion();
      return;
    }

    case 'setFanPercent': {
      const client = endpoint.getClusterClient(FanControl.Complete);
      if (!client) throw new UnsupportedCommandError(command.type, 'no Fan Control cluster');
      await client.setPercentSettingAttribute(command.percent);
      return;
    }

    case 'setFanMode': {
      const client = endpoint.getClusterClient(FanControl.Complete);
      if (!client) throw new UnsupportedCommandError(command.type, 'no Fan Control cluster');
      await client.setFanModeAttribute(command.mode);
      return;
    }

    case 'playPause': {
      const client = endpoint.getClusterClient(MediaPlayback.Complete);
      if (!client) throw new UnsupportedCommandError(command.type, 'no Media Playback cluster');
      await (command.play ? client.play() : client.pause());
      return;
    }

    case 'setMode': {
      const client = endpoint.getClusterClient(ModeSelect.Complete);
      if (!client) throw new UnsupportedCommandError(command.type, 'no Mode Select cluster');
      await client.changeToMode({ newMode: command.mode });
      return;
    }
  }
}
