import { describe, expect, it } from 'vitest';
import { cameraTopic, commandTopic, configTopic, parseTopic, subscriptionPatterns } from '../src/adapters/mqtt/convention.js';
import { mqttDiscoverySchema, statePatchSchema } from '../src/schema/index.js';
import { cameraUrlProblem, isPrivateIPv4, readCameraAnnouncement } from '../src/cameras/policy.js';

describe('MQTT convention topics', () => {
  it('parses discovery, state, and availability topics', () => {
    expect(parseTopic('gethome/discovery/pool-pump/config')).toEqual({
      kind: 'discovery',
      deviceId: 'pool-pump',
    });
    expect(parseTopic('gethome/device/pool-pump/state')).toEqual({
      kind: 'state',
      deviceId: 'pool-pump',
      endpointId: 1,
    });
    expect(parseTopic('gethome/device/pool-pump/state/3')).toEqual({
      kind: 'state',
      deviceId: 'pool-pump',
      endpointId: 3,
    });
    expect(parseTopic('gethome/device/pool-pump/availability')).toEqual({
      kind: 'availability',
      deviceId: 'pool-pump',
    });
  });

  it('rejects foreign namespaces, bad ids, and malformed topics', () => {
    expect(parseTopic('zigbee2mqtt/device/x/state')).toBeNull();
    expect(parseTopic('gethome/device/has space/state')).toBeNull();
    expect(parseTopic('gethome/device/ok/state/notanumber')).toBeNull();
    expect(parseTopic('gethome/discovery/ok/notconfig')).toBeNull();
    expect(parseTopic('gethome/device/../state')).toBeNull();
  });

  it('addresses commands per endpoint', () => {
    expect(commandTopic('pool-pump', 1)).toBe('gethome/device/pool-pump/set');
    expect(commandTopic('pool-pump', 2)).toBe('gethome/device/pool-pump/set/2');
  });

  it('reads a camera topic per endpoint, and listens for it', () => {
    expect(parseTopic('gethome/device/porch-cam/camera')).toEqual({ kind: 'camera', deviceId: 'porch-cam', endpointId: 1 });
    expect(parseTopic('gethome/device/porch-cam/camera/2')).toEqual({ kind: 'camera', deviceId: 'porch-cam', endpointId: 2 });
    expect(parseTopic('gethome/device/porch-cam/camera/x')).toBeNull();
    expect(cameraTopic('porch-cam', 1)).toBe('gethome/device/porch-cam/camera');
    expect(cameraTopic('porch-cam', 3)).toBe('gethome/device/porch-cam/camera/3');
    expect(configTopic('porch-cam')).toBe('gethome/discovery/porch-cam/config');
    expect(subscriptionPatterns()).toEqual(expect.arrayContaining(['gethome/device/+/camera', 'gethome/device/+/camera/+']));
  });
});

describe('camera announcements', () => {
  it('fetches only plain http from a private IPv4 address, with no credentials', () => {
    for (const ok of ['http://192.168.1.31/snapshot', 'http://10.0.0.7:81/stream', 'http://172.20.1.2/x', 'http://169.254.10.1/']) {
      expect(cameraUrlProblem(ok), ok).toBeNull();
    }
    for (const refused of [
      'https://192.168.1.31/snapshot',
      'http://127.0.0.1/snapshot',
      'http://0.0.0.0/',
      'http://8.8.8.8/',
      'http://172.32.0.1/',
      'http://224.0.0.1/',
      'http://camera.local/snapshot',
      'http://user:secret@192.168.1.31/snapshot',
      'file:///etc/passwd',
      'not a url',
    ]) {
      expect(cameraUrlProblem(refused), refused).not.toBeNull();
    }
    expect(isPrivateIPv4('192.168.001.10')).toBe(true);
    expect(isPrivateIPv4('192.168.1')).toBe(false);
    expect(isPrivateIPv4('256.1.1.1')).toBe(false);
  });

  it('drops a stream it cannot serve without refusing the rest', () => {
    const { streams, dropped } = readCameraAnnouncement({
      futureField: true,
      streams: [
        { id: 'still', kind: 'snapshot', label: 'Still', width: 640, height: 480, url: 'http://192.168.1.31/snapshot', extra: 1 },
        { id: 'live', kind: 'mjpeg', url: 'http://192.168.1.31:81/stream' },
        { id: 'webrtc', kind: 'webrtc', url: 'http://192.168.1.31:8889/' },
        { id: 'router', kind: 'snapshot', url: 'http://192.168.1.1@evil/' },
        { id: 'bad id!', kind: 'snapshot', url: 'http://192.168.1.31/snapshot' },
        { id: 'still', kind: 'snapshot', url: 'http://192.168.1.31/again' },
      ],
    });
    expect(streams.map((stream) => stream.id)).toEqual(['still', 'live']);
    expect(streams[0]).toEqual({ id: 'still', kind: 'snapshot', label: 'Still', width: 640, height: 480, url: 'http://192.168.1.31/snapshot' });
    expect(dropped.length).toBe(3);
    expect(readCameraAnnouncement('nonsense').streams).toEqual([]);
  });
});

describe('MQTT convention payload validation', () => {
  it('accepts a well-formed discovery config', () => {
    const config = mqttDiscoverySchema.parse({
      name: 'Pool pump',
      vendor: 'Acme',
      model: 'PP-1',
      endpoints: [
        { endpointId: 1, deviceKind: 'outlet', capabilities: ['onOff', 'electricalPower'], primary: 'onOff' },
      ],
    });
    expect(config.endpoints[0]!.deviceKind).toBe('outlet');
  });

  it('refuses a device that declares camera — the hub derives it, and an older hub would refuse the whole document', () => {
    expect(() =>
      mqttDiscoverySchema.parse({
        name: 'Porch camera',
        endpoints: [{ endpointId: 1, deviceKind: 'camera', capabilities: ['onOff', 'camera'], primary: 'onOff' }],
      }),
    ).toThrow();
    expect(
      mqttDiscoverySchema.parse({
        name: 'Porch camera',
        endpoints: [{ endpointId: 1, deviceKind: 'camera', capabilities: ['onOff'], primary: 'onOff' }],
      }).endpoints[0]!.deviceKind,
    ).toBe('camera');
  });

  it('rejects non-canonical capability names', () => {
    expect(() =>
      mqttDiscoverySchema.parse({
        name: 'Weird device',
        endpoints: [{ endpointId: 1, deviceKind: 'outlet', capabilities: ['warp_drive'], primary: 'warp_drive' }],
      }),
    ).toThrow();
  });

  it('validates state patches in canonical units', () => {
    const patch = statePatchSchema.parse({ onOff: true, power: { activeMilliwatts: 120_000 } });
    expect(patch.power?.activeMilliwatts).toBe(120_000);
    expect(() => statePatchSchema.parse({ level: { current: 0 } })).toThrow(); // 0 is invalid
  });
});
