import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mapExposes, type Z2mDevice } from '../src/adapters/zigbee/exposes-mapper.js';

const devices = JSON.parse(
  readFileSync(path.join(import.meta.dirname, 'fixtures/z2m/devices.json'), 'utf8'),
) as Z2mDevice[];

const byName = (name: string) => {
  const device = devices.find((candidate) => candidate.friendly_name === name);
  if (!device) throw new Error(`fixture ${name} missing`);
  return device;
};

describe('Z2M exposes → canonical mapping', () => {
  it('maps an IKEA color-temperature bulb', () => {
    const profile = mapExposes(byName('Desk lamp'));
    expect(profile.kind).toBe('light');
    expect(profile.capabilities).toEqual(['onOff', 'level', 'colorTemperature']);
    expect(profile.primary).toBe('onOff');
    expect(profile.unmapped).toEqual([]);
    expect(profile.features.colorTempRange).toEqual({ min: 250, max: 454 });

    const patch = profile.extractState({ state: 'ON', brightness: 203, color_temp: 370, linkquality: 90 });
    expect(patch.onOff).toBe(true);
    expect(patch.level).toEqual({ current: 203, min: 1, max: 254 });
    expect(patch.colorTemperature).toEqual({ mireds: 370, minMireds: 250, maxMireds: 454 });
  });

  it('maps a Hue color light with hue/saturation conversion', () => {
    const profile = mapExposes(byName('Living room strip'));
    expect(profile.capabilities).toEqual(['onOff', 'level', 'colorTemperature', 'color']);

    const patch = profile.extractState({ state: 'OFF', color: { hue: 180, saturation: 100 } });
    expect(patch.onOff).toBe(false);
    // hue 180° → 127 cluster units; saturation 100% → 254.
    expect(patch.colorHS).toEqual({ hue: 127, saturation: 254, colorModeIsHueSaturation: true });
  });

  it('maps a metering plug to an outlet with power in milliwatts', () => {
    const profile = mapExposes(byName('Washer plug'));
    expect(profile.kind).toBe('outlet');
    expect(profile.capabilities).toContain('onOff');
    expect(profile.capabilities).toContain('electricalPower');
    expect(profile.unmapped).toEqual([]);

    const patch = profile.extractState({ state: 'ON', power: 412.5, energy: 12.34, voltage: 230 });
    expect(patch.onOff).toBe(true);
    expect(patch.power?.activeMilliwatts).toBe(412_500);
    expect(patch.power?.importedEnergyMilliwattHours).toBe(12_340_000);
  });

  it('maps a climate sensor with centi-degree conversion', () => {
    const profile = mapExposes(byName('Bedroom climate sensor'));
    expect(profile.kind).toBe('sensor');
    expect(profile.capabilities).toEqual(['temperature', 'humidity', 'pressure', 'battery']);
    expect(profile.primary).toBe('temperature');

    const patch = profile.extractState({ temperature: 21.56, humidity: 48.2, pressure: 1013.2, battery: 91 });
    expect(patch.sensors?.temperatureCenti).toBe(2156);
    expect(patch.sensors?.humidityCenti).toBe(4820);
    expect(patch.sensors?.pressureHPa).toBe(1013.2);
    expect(patch.battery).toEqual({ percent: 91 });
  });

  it('maps a contact sensor with Z2M polarity (true = closed)', () => {
    const profile = mapExposes(byName('Front door sensor'));
    expect(profile.capabilities).toEqual(['contact', 'battery']);
    expect(profile.extractState({ contact: true }).sensors?.contactClosed).toBe(true);
    expect(profile.extractState({ contact: false }).sensors?.contactClosed).toBe(false);
  });

  it('maps a TRV with setpoint limits from the exposes and flags the preset as unmapped', () => {
    const profile = mapExposes(byName('Radiator valve'));
    expect(profile.kind).toBe('climate');
    expect(profile.primary).toBe('thermostat');
    expect(profile.capabilities).toContain('thermostat');
    expect(profile.capabilities).toContain('battery');
    // `preset` is a real capability-ish enum we don't map statically → AI food.
    expect(profile.unmapped).toContain('preset');
    // child_lock and running_state are deliberately ignored, not unmapped.
    expect(profile.unmapped).not.toContain('child_lock');
    expect(profile.unmapped).not.toContain('running_state');

    const patch = profile.extractState({
      local_temperature: 20.5,
      current_heating_setpoint: 22,
      system_mode: 'heat',
    });
    expect(patch.thermostat?.localTemperatureCenti).toBe(2050);
    expect(patch.thermostat?.occupiedHeatingSetpointCenti).toBe(2200);
    expect(patch.thermostat?.systemMode).toBe(4);
    expect(patch.thermostat?.heatSetpointMinCenti).toBe(500);
    expect(patch.thermostat?.heatSetpointMaxCenti).toBe(3000);
  });

  it('maps a roller shade with inverted position semantics', () => {
    const profile = mapExposes(byName('Studio shade'));
    expect(profile.kind).toBe('shade');
    expect(profile.primary).toBe('windowCovering');

    // Z2M position 100 = open → canonical 0 = open.
    expect(profile.extractState({ position: 100 }).covering?.currentPositionLiftPercent100ths).toBe(0);
    expect(profile.extractState({ position: 0 }).covering?.currentPositionLiftPercent100ths).toBe(10_000);
    expect(profile.extractState({ position: 25 }).covering?.currentPositionLiftPercent100ths).toBe(7_500);
  });

  it('maps a lock with tri-state lock_state', () => {
    const profile = mapExposes(byName('Front door lock'));
    expect(profile.kind).toBe('lock');
    expect(profile.primary).toBe('doorLock');
    expect(profile.extractState({ lock_state: 'locked' }).lock).toBe(1);
    expect(profile.extractState({ lock_state: 'unlocked' }).lock).toBe(2);
    expect(profile.extractState({ lock_state: 'not_fully_locked' }).lock).toBe(0);
  });

  it('leaves unknown exposes unmapped for the AI mapper', () => {
    const profile = mapExposes(byName('Mystery soil probe'));
    // temperature and battery still map statically…
    expect(profile.capabilities).toContain('temperature');
    expect(profile.capabilities).toContain('battery');
    // …but soil_moisture is not in the canonical schema.
    expect(profile.unmapped).toEqual(['soil_moisture']);
  });

  it('produces an empty profile for definition-less devices', () => {
    const profile = mapExposes({
      ieee_address: '0xdead',
      friendly_name: 'Unknown thing',
      supported: false,
      definition: null,
    });
    expect(profile.capabilities).toEqual([]);
    expect(profile.unmapped).toEqual([]);
  });
});
