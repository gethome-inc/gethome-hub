import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_KINDS,
  DEVICE_KINDS,
  DEVICE_TYPE_CATALOG,
  commandSchema,
  descriptorFor,
  emptyState,
  endpointStateSchema,
  hueFromDegrees,
  isInfrastructureOnly,
  kelvinFromMireds,
  levelFromPercent,
  luxFromMeasuredIlluminance,
  mergeState,
  miredsFromKelvin,
  percent100thsFromZ2mPosition,
  percentFromHalfPercent,
  percentFromLevel,
  presentCapabilities,
  saturationFromPercent,
  z2mPositionFromPercent100ths,
} from '../src/schema/index.js';

describe('canonical vocabulary', () => {
  it('has exactly the 26 capability kinds of the app schema, in order', () => {
    expect(CAPABILITY_KINDS).toEqual([
      'onOff', 'level', 'colorTemperature', 'color', 'thermostat', 'fan',
      'doorLock', 'windowCovering', 'temperature', 'humidity', 'occupancy',
      'contact', 'illuminance', 'pressure', 'flow', 'airQuality', 'pm25',
      'co2', 'smokeCOAlarm', 'battery', 'electricalPower', 'mode', 'rvcRun',
      'mediaPlayback', 'event', 'irRemote',
    ]);
  });

  it('has exactly the 16 device kinds of the app schema', () => {
    expect(DEVICE_KINDS).toHaveLength(16);
    expect(DEVICE_KINDS).toContain('wallSwitch');
    expect(DEVICE_KINDS).toContain('airPurifier');
    expect(DEVICE_KINDS).toContain('remote');
  });
});

describe('units', () => {
  it('converts mireds to kelvin like the app (rounded)', () => {
    expect(kelvinFromMireds(153)).toBe(6536);
    expect(kelvinFromMireds(370)).toBe(2703);
    expect(kelvinFromMireds(0)).toBe(0);
    expect(miredsFromKelvin(6500)).toBe(154);
    expect(miredsFromKelvin(2700)).toBe(370);
  });

  it('maps level 1–254 to percent and back like the app', () => {
    expect(percentFromLevel(1)).toBe(0);
    expect(percentFromLevel(254)).toBe(100);
    expect(percentFromLevel(128)).toBe(50);
    // The app truncates on the way back (UInt8 init).
    expect(levelFromPercent(0)).toBe(1);
    expect(levelFromPercent(100)).toBe(254);
    expect(levelFromPercent(50)).toBe(127);
  });

  it('computes lux from the log-encoded measurement', () => {
    expect(luxFromMeasuredIlluminance(1)).toBeCloseTo(1, 5);
    expect(luxFromMeasuredIlluminance(40_001)).toBeCloseTo(10_000, 0);
    expect(luxFromMeasuredIlluminance(0)).toBe(0);
  });

  it('normalizes half-percent battery readings by truncating like the app', () => {
    expect(percentFromHalfPercent(200)).toBe(100);
    // The app does `Int(raw) / 2` — 147 → 73, not 74.
    expect(percentFromHalfPercent(147)).toBe(73);
    expect(percentFromHalfPercent(199)).toBe(99);
    expect(percentFromHalfPercent(0)).toBe(0);
  });

  it('inverts Zigbee2MQTT cover position (100=open) into percent-100ths (0=open)', () => {
    expect(percent100thsFromZ2mPosition(100)).toBe(0);
    expect(percent100thsFromZ2mPosition(0)).toBe(10_000);
    expect(percent100thsFromZ2mPosition(75)).toBe(2_500);
    expect(z2mPositionFromPercent100ths(0)).toBe(100);
    expect(z2mPositionFromPercent100ths(10_000)).toBe(0);
    expect(z2mPositionFromPercent100ths(2_500)).toBe(75);
  });

  it('converts hue degrees and saturation percent into cluster units', () => {
    expect(hueFromDegrees(0)).toBe(0);
    expect(hueFromDegrees(360)).toBe(254);
    expect(hueFromDegrees(180)).toBe(127);
    expect(saturationFromPercent(100)).toBe(254);
    expect(saturationFromPercent(50)).toBe(127);
  });
});

describe('endpoint state', () => {
  it('merges patches without clobbering sibling fields', () => {
    let state = emptyState();
    state = mergeState(state, { onOff: true, level: { current: 200, min: 1, max: 254 } });
    state = mergeState(state, { sensors: { temperatureCenti: 2150 } });
    state = mergeState(state, { level: { current: 100 } as never });
    expect(state.onOff).toBe(true);
    expect(state.level).toEqual({ current: 100, min: 1, max: 254 });
    expect(state.sensors.temperatureCenti).toBe(2150);
  });

  it('derives present capabilities in the app display order', () => {
    let state = emptyState();
    state = mergeState(state, {
      onOff: true,
      level: { current: 128, min: 1, max: 254 },
      sensors: { temperatureCenti: 2000, humidityCenti: 4500 },
      battery: { percent: 80 },
    });
    expect(presentCapabilities(state)).toEqual(['onOff', 'level', 'temperature', 'humidity', 'battery']);
  });

  it('round-trips through the wire schema', () => {
    const state = mergeState(emptyState(), {
      onOff: false,
      covering: { currentPositionLiftPercent100ths: 2500, isMoving: false },
      thermostat: {
        localTemperatureCenti: 2150,
        occupiedHeatingSetpointCenti: 2100,
        heatSetpointMinCenti: 700,
        heatSetpointMaxCenti: 3000,
        coolSetpointMinCenti: 1600,
        coolSetpointMaxCenti: 3200,
        systemMode: 4,
      },
    });
    const parsed = endpointStateSchema.parse(JSON.parse(JSON.stringify(state)));
    expect(parsed.covering?.currentPositionLiftPercent100ths).toBe(2500);
    expect(parsed.thermostat?.systemMode).toBe(4);
  });

  it('round-trips events (buttons inventory + last event) and derives the capability', () => {
    const state = mergeState(emptyState(), {
      event: { buttons: [{ id: 'left', label: 'Left', gestures: ['single', 'double'] }] },
    });
    const pressed = mergeState(state, {
      event: { action: 'single_left', button: 'left', gesture: 'single', at: 1_752_000_000_000 },
    });
    // The inventory survives event merges.
    expect(pressed.event?.buttons).toHaveLength(1);
    expect(pressed.event?.gesture).toBe('single');
    const parsed = endpointStateSchema.parse(JSON.parse(JSON.stringify(pressed)));
    expect(parsed.event?.button).toBe('left');
    expect(presentCapabilities(pressed)).toContain('event');
  });

  it('rejects out-of-range values', () => {
    expect(() => endpointStateSchema.parse({ reachable: true, sensors: {}, level: { current: 0 } })).toThrow();
    expect(() =>
      endpointStateSchema.parse({ reachable: true, sensors: {}, covering: { currentPositionLiftPercent100ths: 10_001 } }),
    ).toThrow();
  });
});

describe('commands wire', () => {
  it('accepts all 17 intents', () => {
    const samples = [
      { type: 'power', on: true },
      { type: 'toggle' },
      { type: 'setLevel', level: 180, transitionDs: 5 },
      { type: 'setColorTemperature', mireds: 370 },
      { type: 'setHueSaturation', hue: 200, saturation: 254 },
      { type: 'setHeatingSetpoint', centi: 2100 },
      { type: 'setCoolingSetpoint', centi: 2400 },
      { type: 'setSystemMode', mode: 4 },
      { type: 'lock', engage: true },
      { type: 'setCoveringPercent', percent100ths: 5000 },
      { type: 'openCovering' },
      { type: 'closeCovering' },
      { type: 'stopCovering' },
      { type: 'setFanPercent', percent: 60 },
      { type: 'setFanMode', mode: 5 },
      { type: 'playPause', play: false },
      { type: 'setMode', mode: 2 },
    ];
    for (const sample of samples) {
      expect(commandSchema.parse(sample)).toEqual(sample);
    }
  });

  it('rejects unknown types and extra keys', () => {
    expect(() => commandSchema.parse({ type: 'selfDestruct' })).toThrow();
    expect(() => commandSchema.parse({ type: 'toggle', extra: 1 })).toThrow();
    expect(() => commandSchema.parse({ type: 'setLevel', level: 300 })).toThrow();
  });
});

describe('device-type catalog', () => {
  it('classifies the core device types like the app', () => {
    expect(descriptorFor([0x010d]).kind).toBe('light');
    expect(descriptorFor([0x010d]).capabilities).toEqual(['onOff', 'level', 'colorTemperature', 'color']);
    expect(descriptorFor([0x000a]).kind).toBe('lock');
    expect(descriptorFor([0x0301]).primary).toBe('thermostat');
    expect(descriptorFor([0x0074]).kind).toBe('vacuum');
    // Generic Switch = buttons (Switch-cluster events), not a relay.
    expect(descriptorFor([0x000f]).kind).toBe('remote');
    expect(descriptorFor([0x000f]).primary).toBe('event');
  });

  it('prefers the richest non-infrastructure descriptor', () => {
    // Root node + extended color light → the light wins.
    expect(descriptorFor([0x0016, 0x0100, 0x010d]).name).toBe('Extended Color Light');
  });

  it('falls back to a generic accessory for unknown types', () => {
    const generic = descriptorFor([0xdead]);
    expect(generic.name).toBe('Matter Accessory');
    expect(generic.capabilities).toEqual(['onOff']);
  });

  it('flags infrastructure-only endpoints', () => {
    expect(isInfrastructureOnly([0x0016])).toBe(true);
    expect(isInfrastructureOnly([0x0016, 0x0100])).toBe(false);
  });

  it('has unique ids', () => {
    const ids = DEVICE_TYPE_CATALOG.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
