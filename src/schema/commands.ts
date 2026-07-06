/**
 * The 17 command intents of the GetHome ecosystem — the complete write
 * vocabulary a client can send to any device, regardless of protocol.
 * Adapters translate these into cluster commands (Matter), /set payloads
 * (Zigbee2MQTT), or convention topics (MQTT).
 *
 * Wire format: JSON discriminated on `type`, e.g. `{"type":"setLevel","level":180}`.
 */
export type HubCommand =
  | { type: 'power'; on: boolean }
  | { type: 'toggle' }
  | { type: 'setLevel'; level: number; transitionDs?: number }
  | { type: 'setColorTemperature'; mireds: number }
  | { type: 'setHueSaturation'; hue: number; saturation: number }
  | { type: 'setHeatingSetpoint'; centi: number }
  | { type: 'setCoolingSetpoint'; centi: number }
  | { type: 'setSystemMode'; mode: number }
  | { type: 'lock'; engage: boolean }
  | { type: 'setCoveringPercent'; percent100ths: number }
  | { type: 'openCovering' }
  | { type: 'closeCovering' }
  | { type: 'stopCovering' }
  | { type: 'setFanPercent'; percent: number }
  | { type: 'setFanMode'; mode: number }
  | { type: 'playPause'; play: boolean }
  | { type: 'setMode'; mode: number };

export type HubCommandType = HubCommand['type'];

export const COMMAND_TYPES: readonly HubCommandType[] = [
  'power',
  'toggle',
  'setLevel',
  'setColorTemperature',
  'setHueSaturation',
  'setHeatingSetpoint',
  'setCoolingSetpoint',
  'setSystemMode',
  'lock',
  'setCoveringPercent',
  'openCovering',
  'closeCovering',
  'stopCovering',
  'setFanPercent',
  'setFanMode',
  'playPause',
  'setMode',
] as const;

/** Thrown by adapters when a device has no way to honor an intent. */
export class UnsupportedCommandError extends Error {
  constructor(
    public readonly commandType: HubCommandType,
    detail?: string,
  ) {
    super(`Unsupported command "${commandType}"${detail ? `: ${detail}` : ''}`);
    this.name = 'UnsupportedCommandError';
  }
}
