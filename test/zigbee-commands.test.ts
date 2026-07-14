import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mapExposes, type Z2mDevice } from '../src/adapters/zigbee/exposes-mapper.js';
import { buildSetPayload } from '../src/adapters/zigbee/commands.js';
import { UnsupportedCommandError } from '../src/schema/index.js';

const devices = JSON.parse(
  readFileSync(path.join(import.meta.dirname, 'fixtures/z2m/devices.json'), 'utf8'),
) as Z2mDevice[];

const featuresOf = (name: string, endpointId = 1) => {
  const device = devices.find((candidate) => candidate.friendly_name === name);
  if (!device) throw new Error(`fixture ${name} missing`);
  const endpoint = mapExposes(device).endpoints.find((candidate) => candidate.endpointId === endpointId);
  if (!endpoint) throw new Error(`fixture ${name} has no endpoint ${endpointId}`);
  return endpoint.features;
};

describe('canonical commands → Z2M /set payloads', () => {
  it('translates power and toggle', () => {
    const bulb = featuresOf('Desk lamp');
    expect(buildSetPayload({ type: 'power', on: true }, bulb)).toEqual({ state: 'ON' });
    expect(buildSetPayload({ type: 'power', on: false }, bulb)).toEqual({ state: 'OFF' });
    expect(buildSetPayload({ type: 'toggle' }, bulb)).toEqual({ state: 'TOGGLE' });
  });

  it('translates level with deciseconds → seconds transition', () => {
    const bulb = featuresOf('Desk lamp');
    expect(buildSetPayload({ type: 'setLevel', level: 180 }, bulb)).toEqual({ brightness: 180 });
    expect(buildSetPayload({ type: 'setLevel', level: 254, transitionDs: 15 }, bulb)).toEqual({
      brightness: 254,
      transition: 1.5,
    });
  });

  it('clamps color temperature to the device range', () => {
    const bulb = featuresOf('Desk lamp'); // 250–454 mireds
    expect(buildSetPayload({ type: 'setColorTemperature', mireds: 370 }, bulb)).toEqual({ color_temp: 370 });
    expect(buildSetPayload({ type: 'setColorTemperature', mireds: 153 }, bulb)).toEqual({ color_temp: 250 });
    expect(buildSetPayload({ type: 'setColorTemperature', mireds: 500 }, bulb)).toEqual({ color_temp: 454 });
  });

  it('translates hue/saturation from cluster units to degrees/percent', () => {
    const strip = featuresOf('Living room strip');
    expect(buildSetPayload({ type: 'setHueSaturation', hue: 127, saturation: 254 }, strip)).toEqual({
      color: { hue: 180, saturation: 100 },
    });
  });

  it('translates thermostat setpoints to whole degrees on the right property', () => {
    const trv = featuresOf('Radiator valve');
    expect(buildSetPayload({ type: 'setHeatingSetpoint', centi: 2150 }, trv)).toEqual({
      current_heating_setpoint: 21.5,
    });
    expect(buildSetPayload({ type: 'setSystemMode', mode: 4 }, trv)).toEqual({ system_mode: 'heat' });
    expect(buildSetPayload({ type: 'setSystemMode', mode: 0 }, trv)).toEqual({ system_mode: 'off' });
    // This TRV has no cool mode.
    expect(() => buildSetPayload({ type: 'setSystemMode', mode: 3 }, trv)).toThrow(UnsupportedCommandError);
    expect(() => buildSetPayload({ type: 'setCoolingSetpoint', centi: 2400 }, trv)).toThrow(
      UnsupportedCommandError,
    );
  });

  it('translates covering intents with the position inversion', () => {
    const shade = featuresOf('Studio shade');
    expect(buildSetPayload({ type: 'openCovering' }, shade)).toEqual({ state: 'OPEN' });
    expect(buildSetPayload({ type: 'closeCovering' }, shade)).toEqual({ state: 'CLOSE' });
    expect(buildSetPayload({ type: 'stopCovering' }, shade)).toEqual({ state: 'STOP' });
    // Canonical 2500 (¾ open) → Z2M position 75.
    expect(buildSetPayload({ type: 'setCoveringPercent', percent100ths: 2500 }, shade)).toEqual({
      position: 75,
    });
  });

  it('translates lock intents through the lock state values', () => {
    const lock = featuresOf('Front door lock');
    expect(buildSetPayload({ type: 'lock', engage: true }, lock)).toEqual({ state: 'LOCK' });
    expect(buildSetPayload({ type: 'lock', engage: false }, lock)).toEqual({ state: 'UNLOCK' });
  });

  it('addresses multi-endpoint relays through their suffixed properties', () => {
    const channel1 = featuresOf('Hallway relay', 1);
    const channel2 = featuresOf('Hallway relay', 2);
    expect(buildSetPayload({ type: 'power', on: true }, channel1)).toEqual({ state_l1: 'ON' });
    expect(buildSetPayload({ type: 'power', on: false }, channel2)).toEqual({ state_l2: 'OFF' });
    expect(buildSetPayload({ type: 'toggle' }, channel2)).toEqual({ state_l2: 'TOGGLE' });
  });

  it('rejects intents the device cannot honor', () => {
    const sensor = featuresOf('Bedroom climate sensor');
    expect(() => buildSetPayload({ type: 'power', on: true }, sensor)).toThrow(UnsupportedCommandError);
    expect(() => buildSetPayload({ type: 'playPause', play: true }, featuresOf('Desk lamp'))).toThrow(
      UnsupportedCommandError,
    );
    // Remotes send events; they take no commands.
    expect(() => buildSetPayload({ type: 'power', on: true }, featuresOf('Bedroom button'))).toThrow(
      UnsupportedCommandError,
    );
  });
});
