import { describe, expect, it } from 'vitest';
import { commandTopic, parseTopic } from '../src/adapters/mqtt/convention.js';
import { mqttDiscoverySchema, statePatchSchema } from '../src/schema/index.js';

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
