// The import is type-only and therefore erased: this module does not pull the
// Zigbee adapter — or matter.js's neighbour in the dependency graph — into a
// hub whose radio is switched off. Adapters keep seeing only `AdapterBus`.
import type { Z2mBridgeEvent } from '../adapters/zigbee/adapter.js';
import type { ZigbeeLifecycleEvent } from './bus.js';

/**
 * Zigbee2MQTT's `bridge/event` in the hub's own vocabulary, or `null` for an
 * event this version has never heard of.
 *
 * Translating in one place means the apps learn one set of names and an
 * upstream rename is a change in one function rather than in every client.
 * Returning `null` for the unrecognised is deliberate: a pairing timeline that
 * shows a step it cannot name is worse than one that shows the steps it can.
 */
export function normalizeBridgeEvent(event: Z2mBridgeEvent): ZigbeeLifecycleEvent | null {
  const ieee = event.data?.ieee_address;
  if (!ieee) return null;
  const name = event.data?.friendly_name;
  const base = {
    at: new Date().toISOString(),
    ieee,
    ...(name !== undefined ? { name } : {}),
  };
  switch (event.type) {
    case 'device_joined':
      return { ...base, type: 'joined' };
    case 'device_announce':
      return { ...base, type: 'announced' };
    case 'device_leave':
      return { ...base, type: 'left' };
    case 'device_interview':
      switch (event.data?.status) {
        case 'started':
          return { ...base, type: 'interviewing' };
        case 'successful':
          return { ...base, type: 'interviewed' };
        case 'failed':
          return { ...base, type: 'interview-failed' };
        default:
          return null;
      }
    default:
      return null;
  }
}

/**
 * The durable sentence for a lifecycle event, or `null` when it should only
 * live on the stream.
 *
 * Most of pairing is transient: "interviewing" matters intensely for the
 * fifteen seconds it is happening and not at all afterwards, and the adapter
 * already writes a `zigbee.joined` row once the device is adopted — so
 * recording every step would put two rows saying "joined" in a log that is
 * meant to be read a week later. What has to outlive the moment is the
 * *failure*: a device that joined and could not be interviewed is present on
 * the network, absent from the app, and gives no other sign of why.
 */
export function activityForLifecycleEvent(
  event: ZigbeeLifecycleEvent,
): { kind: string; message: string } | null {
  const who = event.name ?? event.ieee;
  switch (event.type) {
    case 'interview-failed':
      return {
        kind: 'zigbee.interview-failed',
        message: `${who} joined the Zigbee network but couldn't be interviewed, so the hub doesn't know what it is. Reset it and pair it again.`,
      };
    case 'left':
      return { kind: 'zigbee.left', message: `${who} left the Zigbee network.` };
    default:
      return null;
  }
}
