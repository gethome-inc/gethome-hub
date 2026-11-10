import { describe, expect, it } from 'vitest';
import {
  commandDid,
  inRoom,
  narrateCommand,
  narrateEventCause,
  narrateRefusal,
  narrateStateCause,
} from '../src/automations/narrate.js';

/**
 * What a run says about itself. Both apps print `cause` and a step's `summary`
 * exactly as they arrive, so these strings are what a person reads — and the
 * exact terms have to survive beside them, in `detail`.
 */

const sensor = { name: 'Motion sensor T1 87BC', room: 'Living Room' };

describe('what set a rule off', () => {
  it('names motion by the room, and keeps the terms in the detail', () => {
    expect(narrateStateCause({ path: 'sensors.occupied', op: 'eq', value: true }, sensor)).toEqual({
      text: 'Motion in the Living Room',
      detail: 'Motion sensor T1 87BC · sensors.occupied eq true',
    });
  });

  it('falls back to the device when nobody has placed it', () => {
    expect(
      narrateStateCause({ path: 'sensors.occupied', op: 'eq', value: true }, { name: 'Hall sensor' }).text,
    ).toBe('Hall sensor saw motion');
  });

  it('reports a state that lasted as one, not as the moment it began', () => {
    expect(
      narrateStateCause({ path: 'sensors.occupied', op: 'eq', value: false, for: 20 * 60_000 }, sensor),
    ).toEqual({
      text: 'No motion in the Living Room for 20 minutes',
      detail: 'Motion sensor T1 87BC · sensors.occupied eq false · held for 1200s',
    });
  });

  it('says a door opened, whichever way the test was written', () => {
    const door = { name: 'Front door', room: 'Hall' };
    expect(narrateStateCause({ path: 'sensors.contactClosed', op: 'eq', value: false }, door).text).toBe(
      'Front door opened',
    );
    expect(narrateStateCause({ path: 'sensors.contactClosed', op: 'ne', value: true }, door).text).toBe(
      'Front door opened',
    );
  });

  it('gives a room’s reading to the room and a device’s own to the device, in real units', () => {
    expect(
      narrateStateCause({ path: 'sensors.temperatureCenti', op: 'gt', value: 2500 }, { name: 'FEA7', room: 'Bedroom' })
        .text,
    ).toBe('Temperature in the Bedroom went above 25 °C');
    expect(
      narrateStateCause(
        { path: 'power.activeMilliwatts', op: 'lt', value: 5000 },
        { name: 'Washing machine', room: 'Kitchen' },
      ).text,
    ).toBe('Washing machine power draw went below 5 W');
  });

  it('does not put an article in front of a room that has one, or is somebody’s', () => {
    expect(inRoom('Kitchen')).toBe('in the Kitchen');
    expect(inRoom('Anna’s room')).toBe('in Anna’s room');
    expect(inRoom('The den')).toBe('in The den');
  });

  it('says a button was pressed, and how', () => {
    expect(narrateEventCause({ name: 'Bedside button' }, { gesture: 'double', button: '1', action: 'x' })).toEqual({
      text: 'Bedside button was pressed (double, 1)',
      detail: 'Bedside button · event 1 double x',
    });
  });
});

describe('what a run did', () => {
  it('says what happened to the device', () => {
    expect(narrateCommand({ name: 'Motion LED' }, { type: 'power', on: true })).toEqual({
      text: 'Motion LED turned on',
      detail: 'power on=true',
    });
    // A covering's stored 0 is *open*: 4000 is 40% of the way down.
    expect(narrateCommand({ name: 'Bedroom blind' }, { type: 'setCoveringPercent', percent100ths: 4000 }).text).toBe(
      'Bedroom blind closed to 40%',
    );
    expect(commandDid({ type: 'setCoveringPercent', percent100ths: 0 })).toBe('opened');
    expect(commandDid({ type: 'setHeatingSetpoint', centi: 2150 })).toBe('heating set to 21.5 °C');
    expect(commandDid({ type: 'lock', engage: true })).toBe('locked');
  });

  it('has words for every guard, and the guard’s own sentence in the detail', () => {
    const lamp = { name: 'Hall lamp' };
    const command = { type: 'power', on: false } as const;
    expect(narrateRefusal(lamp, command, { kind: 'unchanged', detail: 'd' }).text).toBe('Hall lamp was already off');
    for (const kind of ['too_soon', 'hourly_budget', 'daily_budget', 'too_deep'] as const) {
      const said = narrateRefusal(lamp, command, { kind, detail: 'the limit' });
      expect(said.text).toMatch(/^Hall lamp was left alone — /);
      expect(said.detail).toBe('power on=false · the limit');
    }
  });
});
