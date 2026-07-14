import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import mqtt from 'mqtt';
import { ZigbeeAdapter, type AppliedAiMapping } from '../../src/adapters/zigbee/adapter.js';
import type { AdapterBus, AdapterDeviceDescriptor } from '../../src/adapters/adapter.js';
import type { EndpointState } from '../../src/schema/index.js';

/**
 * Zigbee adapter behavior over a real broker, with a scripted AI assist:
 * the runtime unknown-parameter trigger and the AI-over-static overlay.
 * Gated on HUB_TEST_MQTT=1 like the round-trip e2e (no database needed).
 */
const enabled = process.env.HUB_TEST_MQTT === '1';
const MQTT_URL = process.env.HUB_TEST_MQTT_URL ?? 'mqtt://127.0.0.1:1883';
const BASE = `z2m-test-${Math.random().toString(16).slice(2, 8)}`;

const waitFor = async (predicate: () => boolean, timeoutMs = 8000): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const probe = {
  ieee_address: '0xfeed000000000001',
  friendly_name: 'Weird probe',
  type: 'EndDevice',
  supported: true,
  interview_completed: true,
  definition: {
    vendor: 'Acme',
    model: 'PROBE-1',
    description: 'Mystery probe',
    exposes: [
      { type: 'numeric', name: 'temperature', property: 'temperature', access: 1, unit: '°C' },
      { type: 'numeric', name: 'linkquality', property: 'linkquality', access: 1 },
    ],
  },
};

describe.skipIf(!enabled)('ZigbeeAdapter runtime AI adaptation', () => {
  let fake: mqtt.MqttClient;
  let adapter: ZigbeeAdapter;

  const upserts: AdapterDeviceDescriptor[] = [];
  const patches: Array<{ endpointId: number; patch: Partial<EndpointState> }> = [];
  const bus: AdapterBus = {
    deviceUpserted: (descriptor) => upserts.push(descriptor),
    deviceRemoved: () => {},
    stateChanged: (_adapter, _externalId, endpointId, patch) => patches.push({ endpointId, patch }),
    reachabilityChanged: () => {},
    activity: () => {},
  };

  const humidityMapping: AppliedAiMapping = {
    endpoints: [{ endpointId: 1, deviceKind: 'sensor', capabilities: ['temperature', 'humidity'], primary: 'humidity' }],
    properties: new Set(['soil_moisture']),
    extractState: (payload) => {
      const moisture = payload.soil_moisture;
      const map = new Map<number, Partial<EndpointState>>();
      if (typeof moisture === 'number') {
        map.set(1, { sensors: { humidityCenti: Math.round(moisture * 100) } });
      }
      return map;
    },
    buildCommandPayload: () => null,
  };

  const requestMapping = vi.fn(async () => null as AppliedAiMapping | null);

  beforeAll(async () => {
    fake = await mqtt.connectAsync(MQTT_URL);
    await fake.publishAsync(`${BASE}/bridge/devices`, JSON.stringify([probe]), { retain: true });

    adapter = new ZigbeeAdapter({
      mqttUrl: MQTT_URL,
      baseTopic: BASE,
      log: pino({ level: 'silent' }),
      aiAssist: { requestMapping },
      parameterRemapDelayMs: 50,
    });
    await adapter.start(bus);
    await waitFor(() => upserts.length >= 1);
  }, 30_000);

  afterAll(async () => {
    await fake?.publishAsync(`${BASE}/bridge/devices`, '', { retain: true }).catch(() => {});
    await fake?.endAsync().catch(() => {});
    await adapter?.stop();
  });

  it('adopts fully-mapped devices without asking the AI', () => {
    expect(upserts[0]).toMatchObject({
      adapter: 'zigbee',
      externalId: probe.ieee_address,
      needsReview: false,
    });
    expect(requestMapping).not.toHaveBeenCalled();
  });

  it('asks the AI once when an undeclared parameter appears, with samples', async () => {
    requestMapping.mockResolvedValueOnce(humidityMapping);

    await fake.publishAsync(`${BASE}/Weird probe`, JSON.stringify({ temperature: 20.1, soil_moisture: 41 }));
    await waitFor(() => requestMapping.mock.calls.length === 1);
    const [, staticProfile, options] = requestMapping.mock.calls[0]! as unknown as [
      unknown,
      { unmapped: string[] },
      { samples?: Record<string, unknown>[]; force?: boolean },
    ];
    expect(staticProfile.unmapped).toEqual([]);
    expect(options.force).toBe(true);
    expect(options.samples?.at(-1)).toMatchObject({ soil_moisture: 41 });

    // The remap re-announces with the AI capabilities merged in.
    await waitFor(() => upserts.some((descriptor) => descriptor.endpoints[0]?.capabilities.includes('humidity')));

    // Later payloads run static + AI overlay together.
    patches.length = 0;
    await fake.publishAsync(`${BASE}/Weird probe`, JSON.stringify({ temperature: 21.5, soil_moisture: 44 }));
    await waitFor(() =>
      patches.some(
        (entry) =>
          entry.patch.sensors?.temperatureCenti === 2150 && entry.patch.sensors?.humidityCenti === 4400,
      ),
    );
  });

  it('does not re-ask for a parameter it already asked about', async () => {
    await fake.publishAsync(`${BASE}/Weird probe`, JSON.stringify({ temperature: 22, soil_moisture: 45 }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(requestMapping).toHaveBeenCalledTimes(1);
  });
});
