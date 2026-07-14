import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mapExposes, type Z2mDevice } from '../src/adapters/zigbee/exposes-mapper.js';
import { buttonInventory, parseAction } from '../src/adapters/zigbee/actions.js';

const devices = JSON.parse(
  readFileSync(path.join(import.meta.dirname, 'fixtures/z2m/devices.json'), 'utf8'),
) as Z2mDevice[];

const byName = (name: string) => {
  const device = devices.find((candidate) => candidate.friendly_name === name);
  if (!device) throw new Error(`fixture ${name} missing`);
  return device;
};

/** Single-endpoint convenience accessors for the common case. */
const profileOf = (name: string) => mapExposes(byName(name));
const mainOf = (name: string) => {
  const profile = profileOf(name);
  const main = profile.endpoints.find((endpoint) => endpoint.endpointId === 1);
  if (!main) throw new Error(`${name} has no endpoint 1`);
  return main;
};
const extractMain = (name: string, payload: Record<string, unknown>) =>
  profileOf(name).extractState(payload).get(1) ?? {};

describe('Z2M exposes → canonical mapping', () => {
  it('maps an IKEA color-temperature bulb', () => {
    const profile = profileOf('Desk lamp');
    const main = mainOf('Desk lamp');
    expect(main.kind).toBe('light');
    expect(main.capabilities).toEqual(['onOff', 'level', 'colorTemperature']);
    expect(main.primary).toBe('onOff');
    expect(profile.unmapped).toEqual([]);
    expect(main.features.colorTempRange).toEqual({ min: 250, max: 454 });

    const patch = extractMain('Desk lamp', { state: 'ON', brightness: 203, color_temp: 370, linkquality: 90 });
    expect(patch.onOff).toBe(true);
    expect(patch.level).toEqual({ current: 203, min: 1, max: 254 });
    expect(patch.colorTemperature).toEqual({ mireds: 370, minMireds: 250, maxMireds: 454 });
  });

  it('maps a Hue color light with hue/saturation conversion', () => {
    expect(mainOf('Living room strip').capabilities).toEqual(['onOff', 'level', 'colorTemperature', 'color']);

    const patch = extractMain('Living room strip', { state: 'OFF', color: { hue: 180, saturation: 100 } });
    expect(patch.onOff).toBe(false);
    // hue 180° → 127 cluster units; saturation 100% → 254.
    expect(patch.colorHS).toEqual({ hue: 127, saturation: 254, colorModeIsHueSaturation: true });
  });

  it('maps a metering plug to an outlet with power in milliwatts', () => {
    const profile = profileOf('Washer plug');
    const main = mainOf('Washer plug');
    expect(main.kind).toBe('outlet');
    expect(main.capabilities).toContain('onOff');
    expect(main.capabilities).toContain('electricalPower');
    expect(profile.unmapped).toEqual([]);

    const patch = extractMain('Washer plug', { state: 'ON', power: 412.5, energy: 12.34, voltage: 230 });
    expect(patch.onOff).toBe(true);
    expect(patch.power?.activeMilliwatts).toBe(412_500);
    expect(patch.power?.importedEnergyMilliwattHours).toBe(12_340_000);
  });

  it('maps a climate sensor with centi-degree conversion', () => {
    const main = mainOf('Bedroom climate sensor');
    expect(main.kind).toBe('sensor');
    expect(main.capabilities).toEqual(['temperature', 'humidity', 'pressure', 'battery']);
    expect(main.primary).toBe('temperature');

    const patch = extractMain('Bedroom climate sensor', {
      temperature: 21.56,
      humidity: 48.2,
      pressure: 1013.2,
      battery: 91,
    });
    expect(patch.sensors?.temperatureCenti).toBe(2156);
    expect(patch.sensors?.humidityCenti).toBe(4820);
    expect(patch.sensors?.pressureHPa).toBe(1013.2);
    expect(patch.battery).toEqual({ percent: 91 });
  });

  it('maps a contact sensor with Z2M polarity (true = closed)', () => {
    expect(mainOf('Front door sensor').capabilities).toEqual(['contact', 'battery']);
    expect(extractMain('Front door sensor', { contact: true }).sensors?.contactClosed).toBe(true);
    expect(extractMain('Front door sensor', { contact: false }).sensors?.contactClosed).toBe(false);
  });

  it('maps a TRV with setpoint limits from the exposes and flags the preset as unmapped', () => {
    const profile = profileOf('Radiator valve');
    const main = mainOf('Radiator valve');
    expect(main.kind).toBe('climate');
    expect(main.primary).toBe('thermostat');
    expect(main.capabilities).toContain('thermostat');
    expect(main.capabilities).toContain('battery');
    // `preset` is a real capability-ish enum we don't map statically → AI food.
    expect(profile.unmapped).toContain('preset');
    // child_lock and running_state are deliberately ignored, not unmapped.
    expect(profile.unmapped).not.toContain('child_lock');
    expect(profile.unmapped).not.toContain('running_state');

    const patch = extractMain('Radiator valve', {
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
    const main = mainOf('Studio shade');
    expect(main.kind).toBe('shade');
    expect(main.primary).toBe('windowCovering');

    // Z2M position 100 = open → canonical 0 = open.
    expect(extractMain('Studio shade', { position: 100 }).covering?.currentPositionLiftPercent100ths).toBe(0);
    expect(extractMain('Studio shade', { position: 0 }).covering?.currentPositionLiftPercent100ths).toBe(10_000);
    expect(extractMain('Studio shade', { position: 25 }).covering?.currentPositionLiftPercent100ths).toBe(7_500);
  });

  it('maps a lock with tri-state lock_state', () => {
    const main = mainOf('Front door lock');
    expect(main.kind).toBe('lock');
    expect(main.primary).toBe('doorLock');
    expect(extractMain('Front door lock', { lock_state: 'locked' }).lock).toBe(1);
    expect(extractMain('Front door lock', { lock_state: 'unlocked' }).lock).toBe(2);
    expect(extractMain('Front door lock', { lock_state: 'not_fully_locked' }).lock).toBe(0);
  });

  it('leaves unknown exposes unmapped for the AI mapper', () => {
    const profile = profileOf('Mystery soil probe');
    const main = mainOf('Mystery soil probe');
    // temperature and battery still map statically…
    expect(main.capabilities).toContain('temperature');
    expect(main.capabilities).toContain('battery');
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
    expect(profile.endpoints).toHaveLength(1);
    expect(profile.endpoints[0]!.capabilities).toEqual([]);
    expect(profile.unmapped).toEqual([]);
  });
});

describe('Aqara buttons, remotes and gestures → event capability', () => {
  it('maps a wireless mini switch to a remote with a button inventory', () => {
    const profile = profileOf('Bedroom button');
    const main = mainOf('Bedroom button');
    expect(main.kind).toBe('remote');
    expect(main.capabilities).toEqual(['event', 'battery']);
    expect(main.primary).toBe('event');
    expect(profile.unmapped).toEqual([]);
    expect(main.buttons).toEqual([
      { id: 'main', label: 'Button', gestures: ['single', 'double', 'triple', 'quadruple', 'hold', 'release'] },
    ]);

    const patch = extractMain('Bedroom button', { action: 'double', battery: 100 });
    expect(patch.event?.action).toBe('double');
    expect(patch.event?.button).toBe('main');
    expect(patch.event?.gesture).toBe('double');
    expect(typeof patch.event?.at).toBe('number');
    expect(patch.battery).toEqual({ percent: 100 });
  });

  it('groups a double-rocker remote into left/right/both buttons', () => {
    const main = mainOf('Bedside remote');
    expect(main.kind).toBe('remote');
    expect(main.buttons).toEqual([
      { id: 'left', label: 'Left', gestures: ['single', 'double', 'hold'] },
      { id: 'right', label: 'Right', gestures: ['single', 'double', 'hold'] },
      { id: 'both', label: 'Both', gestures: ['single', 'double', 'hold'] },
    ]);
    // operation_mode is a setting → known but unmapped-free.
    expect(profileOf('Bedside remote').unmapped).toEqual([]);

    const patch = extractMain('Bedside remote', { action: 'double_left' });
    expect(patch.event?.button).toBe('left');
    expect(patch.event?.gesture).toBe('double');
  });

  it('keeps cube gestures whole and ignores side telemetry', () => {
    const profile = profileOf('Magic cube');
    const main = mainOf('Magic cube');
    expect(main.kind).toBe('remote');
    expect(profile.unmapped).toEqual([]);
    expect(main.buttons?.[0]?.gestures).toContain('flip90');
    expect(main.buttons?.[0]?.gestures).toContain('rotate_left');

    const patch = extractMain('Magic cube', { action: 'rotate_left', side: 3, action_angle: -12.5 });
    expect(patch.event?.button).toBe('main');
    expect(patch.event?.gesture).toBe('rotate_left');
  });

  it('skips empty action strings (Z2M clears them after publishing)', () => {
    expect(extractMain('Bedroom button', { action: '' })).toEqual({});
  });
});

describe('multi-endpoint devices map statically', () => {
  it('maps a two-channel relay to two endpoints with shared metering on endpoint 1', () => {
    const profile = profileOf('Hallway relay');
    expect(profile.unmapped).toEqual([]);
    expect(profile.endpoints).toHaveLength(2);

    const [first, second] = profile.endpoints;
    expect(first!.endpointId).toBe(1);
    expect(first!.label).toBe('l1');
    expect(first!.kind).toBe('wallSwitch');
    expect(first!.capabilities).toContain('onOff');
    expect(first!.capabilities).toContain('electricalPower');
    expect(first!.features.stateProperty).toBe('state_l1');

    expect(second!.endpointId).toBe(2);
    expect(second!.label).toBe('l2');
    expect(second!.capabilities).toEqual(['onOff']);
    expect(second!.features.stateProperty).toBe('state_l2');
  });

  it('routes multi-endpoint state payloads to their endpoints', () => {
    const patches = profileOf('Hallway relay').extractState({
      state_l1: 'ON',
      state_l2: 'OFF',
      power: 4.2,
      linkquality: 66,
    });
    expect(patches.get(1)?.onOff).toBe(true);
    expect(patches.get(1)?.power?.activeMilliwatts).toBe(4200);
    expect(patches.get(2)?.onOff).toBe(false);
  });
});

describe('presence and covers with movement', () => {
  it('maps Aqara FP1 presence to occupancy and leaves presence_event to the AI', () => {
    const profile = profileOf('Office presence');
    const main = mainOf('Office presence');
    expect(main.kind).toBe('sensor');
    expect(main.capabilities).toEqual(['occupancy']);
    expect(profile.unmapped).toEqual(['presence_event']);

    expect(extractMain('Office presence', { presence: true }).sensors?.occupied).toBe(true);
    expect(extractMain('Office presence', { presence: false }).sensors?.occupied).toBe(false);
  });

  it('folds the running flag into covering patches that carry a position', () => {
    const moving = extractMain('Bedroom curtain', { position: 40, running: true });
    expect(moving.covering).toEqual({ currentPositionLiftPercent100ths: 6000, isMoving: true });

    const idle = extractMain('Bedroom curtain', { position: 40, running: false });
    expect(idle.covering?.isMoving).toBe(false);

    // A moving flag alone can't ship a wire-valid covering — dropped.
    expect(extractMain('Bedroom curtain', { running: true }).covering).toBeUndefined();
  });

  it('treats every read or deliberately ignored payload key as known', () => {
    const profile = profileOf('Hallway relay');
    expect(profile.knownProperties.has('state_l1')).toBe(true);
    expect(profile.knownProperties.has('linkquality')).toBe(true);
    expect(profile.knownProperties.has('interlock')).toBe(true);
    expect(profile.knownProperties.has('mystery_field')).toBe(false);
  });
});

describe('action parsing', () => {
  it('parses the common vendor grammars', () => {
    expect(parseAction('single')).toEqual({ button: 'main', gesture: 'single' });
    expect(parseAction('single_left')).toEqual({ button: 'left', gesture: 'single' });
    expect(parseAction('left_single')).toEqual({ button: 'left', gesture: 'single' });
    expect(parseAction('button_3_hold')).toEqual({ button: '3', gesture: 'hold' });
    expect(parseAction('on_press')).toEqual({ button: 'on', gesture: 'press' });
    expect(parseAction('on_press_release')).toEqual({ button: 'on', gesture: 'press_release' });
    expect(parseAction('brightness_up_release')).toEqual({ button: 'brightness_up', gesture: 'release' });
    expect(parseAction('arrow_left_click')).toEqual({ button: 'arrow_left', gesture: 'click' });
    expect(parseAction('flip180')).toEqual({ button: 'main', gesture: 'flip180' });
    expect(parseAction('brightness_move_up')).toEqual({ button: 'main', gesture: 'brightness_move_up' });
  });

  it('builds ordered inventories with humanized labels', () => {
    expect(buttonInventory(['button_1_single', 'button_1_double', 'button_2_single'])).toEqual([
      { id: '1', label: 'Button 1', gestures: ['single', 'double'] },
      { id: '2', label: 'Button 2', gestures: ['single'] },
    ]);
    expect(buttonInventory(['arrow_left_click', ''])).toEqual([
      { id: 'arrow_left', label: 'Arrow left', gestures: ['click'] },
    ]);
  });
});
