import { afterAll, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import mqtt from 'mqtt';
import { MqttAdapter } from '../../src/adapters/mqtt/adapter.js';
import type { AdapterBus } from '../../src/adapters/adapter.js';

/**
 * A heartbeat over a real broker: what the broker hands over from what it
 * holds arrives as retained, and is not taken for the device speaking — the
 * case of a broker that came back from its saved copy holding a retained
 * `online` for a device that has since been switched off. The rules
 * themselves are `mqtt-heartbeat.test.ts`'s. Gated on HUB_TEST_MQTT=1 like the
 * round-trip e2e (no database needed).
 */
const enabled = process.env.HUB_TEST_MQTT === '1';
const MQTT_URL = process.env.HUB_TEST_MQTT_URL ?? 'mqtt://127.0.0.1:1883';
const ID = `heartbeat-test-${Math.random().toString(16).slice(2, 8)}`;
const TOPICS = [`gethome/discovery/${ID}/config`, `gethome/device/${ID}/availability`, `gethome/device/${ID}/heartbeat`];

const waitFor = async (predicate: () => boolean, timeoutMs = 8000): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

describe.skipIf(!enabled)('MQTT heartbeat over a real broker', () => {
  let device: mqtt.MqttClient | null = null;
  let adapter: MqttAdapter | null = null;

  afterAll(async () => {
    // Leave the broker as it was: nothing retained for the test's device.
    if (device) {
      for (const topic of TOPICS) await device.publishAsync(topic, '', { qos: 1, retain: true });
      await device.endAsync();
    }
    await adapter?.stop();
  });

  it('takes what the broker held for retained, and only a live beat as the device speaking', async () => {
    device = await mqtt.connectAsync(MQTT_URL);
    const discovery = {
      name: 'Heartbeat test',
      vendor: 'Test',
      model: 'T-1',
      endpoints: [{ endpointId: 1, deviceKind: 'light', capabilities: ['onOff'], primary: 'onOff' }],
    };
    await device.publishAsync(TOPICS[0]!, JSON.stringify(discovery), { qos: 1, retain: true });
    await device.publishAsync(TOPICS[1]!, 'online', { qos: 1, retain: true });
    await device.publishAsync(TOPICS[2]!, '60', { qos: 1, retain: true });

    let now = Date.now();
    const reachability: boolean[] = [];
    const bus: AdapterBus = {
      deviceUpserted: () => {},
      deviceRemoved: () => {},
      stateChanged: () => {},
      reachabilityChanged: (_adapter, externalId, reachable) => {
        if (externalId === ID) reachability.push(reachable);
      },
      radioReachabilityChanged: () => {},
      commandFailed: () => {},
      activity: () => {},
    };
    adapter = new MqttAdapter({ mqttUrl: MQTT_URL, log: pino({ level: 'silent' }), now: () => now });
    await adapter.start(bus);
    await waitFor(() => reachability.includes(true));

    const sweep = () => (adapter as unknown as { sweepQuiet(): void }).sweepQuiet();
    now += 151_000;
    sweep();
    expect(reachability.at(-1)).toBe(false);

    // The device publishing now is a live message, and brings it back.
    await device.publishAsync(TOPICS[2]!, '60', { qos: 1, retain: true });
    await waitFor(() => reachability.at(-1) === true);
  });
});
