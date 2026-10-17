import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { MqttAdapter } from '../src/adapters/mqtt/adapter.js';
import type { AdapterBus, AdapterDeviceDescriptor } from '../src/adapters/adapter.js';

/**
 * The MQTT adapter's camera half and its `forget`, driven directly: a fake bus
 * records what the registry would hear, and a fake client records what the
 * broker would be sent. The broker round-trip is
 * `integration/mqtt-roundtrip.test.ts`'s (HUB_TEST_MQTT=1).
 */
function harness() {
  const upserted: AdapterDeviceDescriptor[] = [];
  const states: Array<{ deviceId: string; endpointId: number; patch: unknown }> = [];
  const removed: string[] = [];
  const bus: AdapterBus = {
    deviceUpserted: (descriptor) => upserted.push(descriptor),
    deviceRemoved: (_adapter, externalId) => removed.push(externalId),
    stateChanged: (_adapter, deviceId, endpointId, patch) => states.push({ deviceId, endpointId, patch }),
    reachabilityChanged: () => {},
    radioReachabilityChanged: () => {},
    commandFailed: () => {},
    activity: () => {},
  };
  const adapter = new MqttAdapter({ mqttUrl: 'mqtt://unused', log: pino({ level: 'silent' }) });
  const published: Array<{ topic: string; payload: string; options: unknown }> = [];
  Object.assign(adapter as unknown as { bus: AdapterBus; client: unknown }, {
    bus,
    client: {
      publishAsync: async (topic: string, payload: string, options: unknown) => {
        published.push({ topic, payload, options });
      },
    },
  });
  const message = (topic: string, payload: unknown) =>
    (adapter as unknown as { handleMessage(topic: string, payload: string): void }).handleMessage(
      topic,
      typeof payload === 'string' ? payload : JSON.stringify(payload),
    );
  return { adapter, upserted, states, removed, published, message };
}

const discovery = {
  name: 'Porch camera',
  vendor: 'Acme',
  model: 'ESP32',
  endpoints: [{ endpointId: 1, deviceKind: 'camera', capabilities: ['onOff'], primary: 'onOff' }],
};

const announcement = {
  streams: [
    { id: 'still', kind: 'snapshot', label: 'Still', width: 640, height: 480, url: 'http://192.168.1.31/snapshot' },
    { id: 'live', kind: 'mjpeg', label: 'Live', width: 640, height: 480, url: 'http://192.168.1.31:81/stream' },
  ],
};

describe('MQTT cameras', () => {
  it('adds the camera capability to the endpoint, and hands the apps everything but the addresses', () => {
    const h = harness();
    h.message('gethome/discovery/porch-cam/config', discovery);
    h.message('gethome/device/porch-cam/camera', announcement);

    const last = h.upserted.at(-1)!;
    expect(last.endpoints[0]!.capabilities).toEqual(['onOff', 'camera']);
    expect(last.endpoints[0]!.primary).toBe('onOff');
    const camera = h.states.at(-1)!;
    expect(camera).toEqual({
      deviceId: 'porch-cam',
      endpointId: 1,
      patch: {
        camera: {
          streams: [
            { id: 'still', kind: 'snapshot', label: 'Still', width: 640, height: 480 },
            { id: 'live', kind: 'mjpeg', label: 'Live', width: 640, height: 480 },
          ],
        },
      },
    });
    expect(JSON.stringify(h.states)).not.toContain('http://');
    expect(h.adapter.cameraSource('porch-cam', 1, 'live')).toEqual({ kind: 'mjpeg', url: 'http://192.168.1.31:81/stream' });
    expect(h.adapter.cameraSource('porch-cam', 1, 'nope')).toBeNull();
  });

  it('keeps an announcement that arrives before its discovery document', () => {
    const h = harness();
    h.message('gethome/device/porch-cam/camera', announcement);
    expect(h.upserted).toHaveLength(0);
    h.message('gethome/discovery/porch-cam/config', discovery);
    expect(h.upserted.at(-1)!.endpoints[0]!.capabilities).toContain('camera');
    expect(h.states.some((state) => (state.patch as { camera?: unknown }).camera !== undefined)).toBe(true);
  });

  it('keeps the capability when the device re-announces itself', () => {
    const h = harness();
    h.message('gethome/discovery/porch-cam/config', discovery);
    h.message('gethome/device/porch-cam/camera', announcement);
    h.message('gethome/discovery/porch-cam/config', discovery);
    expect(h.upserted.at(-1)!.endpoints[0]!.capabilities).toEqual(['onOff', 'camera']);
  });

  it('withdraws the camera on an empty announcement', () => {
    const h = harness();
    h.message('gethome/discovery/porch-cam/config', discovery);
    h.message('gethome/device/porch-cam/camera', announcement);
    h.message('gethome/device/porch-cam/camera', '');
    expect(h.upserted.at(-1)!.endpoints[0]!.capabilities).toEqual(['onOff']);
    expect(h.states.at(-1)!.patch).toEqual({ camera: { streams: [] } });
    expect(h.adapter.cameraSource('porch-cam', 1, 'live')).toBeNull();
  });

  it('never takes a camera list from a device’s own state', () => {
    const h = harness();
    h.message('gethome/discovery/porch-cam/config', discovery);
    h.message('gethome/device/porch-cam/state', {
      onOff: true,
      camera: { streams: [{ id: 'evil', kind: 'mjpeg' }] },
    });
    const patch = h.states.at(-1)!.patch as Record<string, unknown>;
    expect(patch.onOff).toBe(true);
    expect(patch).not.toHaveProperty('camera');
  });

  it('ignores an announcement for an endpoint the device does not have', () => {
    const h = harness();
    h.message('gethome/discovery/porch-cam/config', discovery);
    const before = h.upserted.length;
    h.message('gethome/device/porch-cam/camera/7', announcement);
    expect(h.upserted.length).toBe(before);
  });
});

describe('MQTT forget', () => {
  it('clears the retained config and camera topics, and its own echo is not a second removal', async () => {
    const h = harness();
    h.message('gethome/discovery/porch-cam/config', discovery);
    h.message('gethome/device/porch-cam/camera', announcement);
    await h.adapter.forget('porch-cam');

    expect(h.published).toEqual([
      { topic: 'gethome/discovery/porch-cam/config', payload: '', options: { qos: 1, retain: true } },
      { topic: 'gethome/device/porch-cam/camera', payload: '', options: { qos: 1, retain: true } },
    ]);
    // The broker hands our own empty config back on the subscription.
    h.message('gethome/discovery/porch-cam/config', '');
    expect(h.removed).toEqual([]);
    expect(h.adapter.cameraSource('porch-cam', 1, 'live')).toBeNull();
  });
});
