import { z } from 'zod';

import type { CommandFailure, HubEventBus } from '../core/bus.js';
import type { DeviceRegistry } from '../core/registry.js';
import type { RegistryDevice, RegistryEndpoint } from '../core/registry.js';
import type { HubCommand } from '../schema/index.js';
import {
  centiFromCelsius,
  hueFromDegrees,
  levelFromPercent,
  miredsFromKelvin,
  saturationFromPercent,
} from '../schema/units.js';
import {
  coveringWireValue,
  describeState,
  fanModeValue,
  primaryEndpoint,
  thermostatModeValue,
  type FanModeName,
  type ThermostatModeName,
} from './devices.js';

/**
 * How long to wait for the device to say something back.
 *
 * `POST /devices/:id/commands` answers 202 because routing is all it does —
 * the Zigbee adapter publishes to MQTT and the broker takes the message long
 * before the device does. The truth arrives afterwards, on the bus, as either
 * a `stateChanged` or a `commandFailed`. A tool that returned as soon as the
 * command was routed would tell a model the light is on when the bulb never
 * heard, which is exactly the lie both apps used to tell before `commandFailed`
 * existed.
 *
 * A second and a half is the compromise: long enough that a mains-powered
 * device on a healthy network always answers inside it, short enough that a
 * sleeping battery sensor does not hold a conversation open. Past it the tool
 * says what it actually knows — sent, not yet confirmed — which is a true
 * sentence a model can pass on.
 */
const CONFIRMATION_WINDOW_MS = 1_500;

/**
 * Actions in the units a person speaks.
 *
 * This union is deliberately *not* `HubCommand`. The wire's units are a
 * compatibility contract with the apps and read as nonsense out of context —
 * `setLevel` takes 1–254, `setColorTemperature` takes mireds, coverings put 0
 * at fully open — so handing them to a language model invites a lamp set to
 * 12% when somebody asked for twelve, and blinds thrown open when somebody
 * asked for them shut. Everything here is percent, °C, kelvin, degrees or a
 * named mode, and `toHubCommand` below is the only place the two vocabularies
 * meet.
 */
export const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('on') }),
  z.object({ action: z.literal('off') }),
  z.object({ action: z.literal('toggle') }),
  z.object({
    action: z.literal('brightness'),
    percent: z.number().min(0).max(100).describe('0–100. Does not switch the light on.'),
  }),
  z.object({
    action: z.literal('color_temperature'),
    kelvin: z.number().min(1000).max(10_000).describe('Warm ≈ 2200 K, daylight ≈ 6500 K.'),
  }),
  z.object({
    action: z.literal('color'),
    hueDegrees: z.number().min(0).max(360),
    saturationPercent: z.number().min(0).max(100),
  }),
  z.object({
    action: z.literal('thermostat'),
    heatingC: z.number().min(-50).max(100).optional(),
    coolingC: z.number().min(-50).max(100).optional(),
    mode: z.enum(['off', 'auto', 'cool', 'heat']).optional(),
  }),
  z.object({ action: z.literal('lock') }),
  z.object({ action: z.literal('unlock') }),
  z.object({
    action: z.literal('covering'),
    openPercent: z.number().min(0).max(100).describe('100 is fully open, 0 is fully closed.'),
  }),
  z.object({ action: z.literal('covering_open') }),
  z.object({ action: z.literal('covering_close') }),
  z.object({ action: z.literal('covering_stop') }),
  z.object({ action: z.literal('fan'), percent: z.number().min(0).max(100) }),
  z.object({
    action: z.literal('fan_mode'),
    mode: z.enum(['off', 'low', 'medium', 'high', 'on', 'auto']),
  }),
  z.object({ action: z.literal('play') }),
  z.object({ action: z.literal('pause') }),
  z.object({ action: z.literal('set_mode'), mode: z.number().int().min(0).max(255) }),
  z.object({
    action: z.literal('ir_send'),
    commandId: z.string().min(1).describe('An id from the device’s irCommands list.'),
  }),
  z.object({
    action: z.literal('setting'),
    fieldId: z.string().min(1),
    value: z.union([z.string(), z.number(), z.boolean()]),
  }),
]);

export type McpAction = z.infer<typeof actionSchema>;

/**
 * A `toggle` is not a command the hub takes — it is "the other one".
 *
 * The schema has a `toggle` intent, but resolving it here against state we
 * already hold means the answer can say *what* it did ("turned the lamp off")
 * rather than "toggled it", which is the difference between a model being able
 * to report back and having to guess.
 */
export function toHubCommand(
  action: McpAction,
  endpoint: RegistryEndpoint | undefined,
): HubCommand {
  switch (action.action) {
    case 'on':
      return { type: 'power', on: true };
    case 'off':
      return { type: 'power', on: false };
    case 'toggle':
      return { type: 'power', on: !(endpoint?.state.onOff ?? false) };
    case 'brightness': {
      const level = endpoint?.state.level;
      return {
        type: 'setLevel',
        level: levelFromPercent(action.percent, level?.min ?? 1, level?.max ?? 254),
      };
    }
    case 'color_temperature':
      return { type: 'setColorTemperature', mireds: Math.round(miredsFromKelvin(action.kelvin)) };
    case 'color':
      return {
        type: 'setHueSaturation',
        hue: Math.round(hueFromDegrees(action.hueDegrees)),
        saturation: saturationFromPercent(action.saturationPercent),
      };
    case 'thermostat': {
      // **Exactly one, and more than one is refused rather than ranked.**
      // A setpoint and a mode are two different commands on the wire and this
      // returns one, so a precedence rule ("the setpoint wins") means
      // "set the thermostat to heat at 21" — one natural call carrying
      // `heatingC` *and* `mode` — sends the setpoint, drops the mode with
      // nothing recorded, and then answers "X is now …", so the assistant
      // reports the whole instruction as done while the device stays in
      // whatever mode it was in. Silently doing half of what was asked is the
      // one outcome a model cannot recover from, because nothing tells it to.
      // Refusing costs a second call and says exactly which one to make.
      const named = [
        action.heatingC !== undefined ? 'heatingC' : null,
        action.coolingC !== undefined ? 'coolingC' : null,
        action.mode !== undefined ? 'mode' : null,
      ].filter((name): name is string => name !== null);

      if (named.length === 0) {
        throw new Error('A thermostat action needs one of heatingC, coolingC or mode.');
      }
      if (named.length > 1) {
        throw new Error(
          `A thermostat action takes one of heatingC, coolingC or mode — this named ${named.join(' and ')}. ` +
            'They are separate commands on the device, so send one call each.',
        );
      }

      if (action.heatingC !== undefined) {
        return { type: 'setHeatingSetpoint', centi: centiFromCelsius(action.heatingC) };
      }
      if (action.coolingC !== undefined) {
        return { type: 'setCoolingSetpoint', centi: centiFromCelsius(action.coolingC) };
      }
      return { type: 'setSystemMode', mode: thermostatModeValue(action.mode as ThermostatModeName) };
    }
    case 'lock':
      return { type: 'lock', engage: true };
    case 'unlock':
      return { type: 'lock', engage: false };
    case 'covering':
      return { type: 'setCoveringPercent', percent100ths: coveringWireValue(action.openPercent) };
    case 'covering_open':
      return { type: 'openCovering' };
    case 'covering_close':
      return { type: 'closeCovering' };
    case 'covering_stop':
      return { type: 'stopCovering' };
    case 'fan':
      return { type: 'setFanPercent', percent: Math.round(action.percent) };
    case 'fan_mode':
      return { type: 'setFanMode', mode: fanModeValue(action.mode as FanModeName) };
    case 'play':
      return { type: 'playPause', play: true };
    case 'pause':
      return { type: 'playPause', play: false };
    case 'set_mode':
      return { type: 'setMode', mode: action.mode };
    case 'ir_send':
      return { type: 'irSend', commandId: action.commandId };
    case 'setting':
      return { type: 'setCustomField', fieldId: action.fieldId, value: action.value };
  }
}

export interface CommandOutcome {
  ok: boolean;
  /** A sentence for the model to read and, usually, to repeat to a person. */
  summary: string;
  /** The device's state after it answered, when it answered in time. */
  state?: string;
}

/**
 * Send a command and wait, briefly, to find out whether it landed.
 *
 * Three outcomes, and each is a different sentence because each is a different
 * fact. The device reported new state — it worked, and the summary says what
 * the device now is. The hub reported a failure — it did not work, and the
 * summary is the protocol's own words rather than a paraphrase, because only
 * the adapter knows what "unreachable" meant here. Or nothing came back inside
 * the window, which is neither: on a battery device zigbee-herdsman queues the
 * write until the sensor next wakes, which can be an hour, so the honest
 * answer names that rather than claiming either success or failure.
 */
export async function sendAndConfirm(
  registry: DeviceRegistry,
  events: HubEventBus,
  device: RegistryDevice,
  endpoint: RegistryEndpoint,
  command: HubCommand,
): Promise<CommandOutcome> {
  const settled = waitForAnswer(events, device.id, endpoint.endpointId);

  try {
    await registry.execute(device.id, endpoint.endpointId, command);
  } catch (error) {
    settled.cancel();
    return {
      ok: false,
      summary: `The hub refused that: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const answer = await settled.promise;

  if (answer.kind === 'failed') {
    return {
      ok: false,
      summary: `${device.name} did not take that command — ${answer.failure.detail}`,
    };
  }

  if (answer.kind === 'changed') {
    const fresh = registry.getDevice(device.id) ?? device;
    // The endpoint that was commanded, not the device's first one. On a
    // two-gang switch those are different endpoints, and reporting the state
    // of the one nobody touched is the same class of wrong as settling on its
    // report — a confident sentence about the other gang.
    const answered =
      fresh.endpoints.find((candidate) => candidate.endpointId === endpoint.endpointId) ??
      primaryEndpoint(fresh);
    const state = describeState(fresh, answered);
    return { ok: true, summary: `${device.name} is now ${state}.`, state };
  }

  const sleeps = endpoint.state.battery !== undefined;
  return {
    ok: true,
    summary: sleeps
      ? `Sent to ${device.name}. It runs on a battery and sleeps between reports, so it may not apply this until it next wakes — pressing its button wakes it.`
      : `Sent to ${device.name}, which has not reported back yet.`,
  };
}

type Answer =
  | { kind: 'changed' }
  | { kind: 'failed'; failure: CommandFailure }
  | { kind: 'timeout' };

/**
 * Listen for whichever of the two frames arrives first, then always detach.
 *
 * **A device is not an endpoint, and confirmation has to match the endpoint
 * that was commanded.** A two-gang switch is one device with two endpoints,
 * and its second gang reports on its own — so a `stateChanged` for the device
 * was enough to settle this waiter as a *success* even when the report came
 * from an endpoint nobody had touched and the commanded one had not answered
 * yet. That turned "the light is now on" into a sentence about a different
 * switch entirely.
 *
 * `commandFailed` is matched on the device alone because that is all the bus
 * carries — `CommandFailure` has no `endpointId` (see `core/bus.ts`). The
 * asymmetry is deliberate rather than overlooked: a stray failure makes this
 * report a refusal it cannot fully attribute, which is the safe direction, and
 * narrowing it would mean widening a wire contract two apps already read.
 *
 * The bus is capped at 100 listeners because the WebSocket fan-out attaches
 * one per client, so a listener left behind by a tool call is a leak that
 * eventually silences the whole hub with a MaxListeners warning. Both
 * listeners come off on every path out of here, including the throw above.
 */
function waitForAnswer(events: HubEventBus, deviceId: string, endpointId: number) {
  let done: ((answer: Answer) => void) | undefined;
  let timer: NodeJS.Timeout | undefined;

  const onChanged = (changedId: string, changedEndpointId: number) => {
    if (changedId === deviceId && changedEndpointId === endpointId) {
      finish({ kind: 'changed' });
    }
  };
  const onFailed = (failure: CommandFailure) => {
    if (failure.deviceId === deviceId) finish({ kind: 'failed', failure });
  };

  const detach = () => {
    events.off('stateChanged', onChanged);
    events.off('commandFailed', onFailed);
    if (timer) clearTimeout(timer);
  };

  const finish = (answer: Answer) => {
    detach();
    done?.(answer);
    done = undefined;
  };

  const promise = new Promise<Answer>((resolve) => {
    done = resolve;
    events.on('stateChanged', onChanged);
    events.on('commandFailed', onFailed);
    timer = setTimeout(() => finish({ kind: 'timeout' }), CONFIRMATION_WINDOW_MS);
    timer.unref?.();
  });

  return { promise, cancel: detach };
}
