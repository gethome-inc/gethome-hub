/**
 * The command intents of the GetHome ecosystem — the write vocabulary a
 * client can send to any device, regardless of protocol. Adapters translate
 * these into cluster commands (Matter), /set payloads (Zigbee2MQTT), or
 * convention topics (MQTT).
 *
 * The `ir*` intents drive IR blasters / universal remotes: a device holds a
 * library of learned commands (`irLearn` captures, `irSaveLearned` names it,
 * `irSend` replays by id, `irDeleteCommand`/`irRenameCommand` manage the
 * library). The library lives in endpoint state and is owned by the registry;
 * `irSendRaw` is an internal-only intent the registry uses to hand the
 * resolved opaque blob to the adapter (it is NOT part of the public wire).
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
  | { type: 'setMode'; mode: number }
  | { type: 'irLearn'; on: boolean }
  | { type: 'irSaveLearned'; name: string }
  | { type: 'irSend'; commandId: string }
  | { type: 'irDeleteCommand'; commandId: string }
  | { type: 'irRenameCommand'; commandId: string; name: string }
  /** Internal (registry → adapter): send an already-resolved opaque blob. */
  | { type: 'irSendRaw'; code: string };

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
  'irLearn',
  'irSaveLearned',
  'irSend',
  'irDeleteCommand',
  'irRenameCommand',
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
