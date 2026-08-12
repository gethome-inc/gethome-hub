import { describe, expect, it } from 'vitest';
import { suggestedNameFor } from '../src/adapters/zigbee/adapter.js';

const plug = {
  ieee_address: '0x54ef44100047c1bf',
  friendly_name: '0x54ef44100047c1bf',
  definition: { vendor: 'SONOFF', model: 'S31ZB', description: 'Smart plug EU', exposes: [] },
};

describe('naming a Zigbee device the first time it is seen', () => {
  it("uses the description when Zigbee2MQTT's name is just the address", () => {
    expect(suggestedNameFor(plug)).toBe('Smart plug EU C1BF');
  });

  it('keeps a name somebody actually chose in Zigbee2MQTT', () => {
    expect(suggestedNameFor({ ...plug, friendly_name: 'Kitchen kettle' })).toBe('Kitchen kettle');
  });

  it('falls back to vendor and model when upstream wrote no description', () => {
    const bare = { ...plug, definition: { vendor: 'SONOFF', model: 'S31ZB', exposes: [] } };
    expect(suggestedNameFor(bare)).toBe('SONOFF S31ZB C1BF');
  });

  it('keeps the address when the record says nothing else at all', () => {
    const unknown = { ieee_address: '0x54ef44100047c1bf', friendly_name: '0x54ef44100047c1bf' };
    expect(suggestedNameFor(unknown)).toBe('0x54ef44100047c1bf');
  });

  it('distinguishes two units of one model', () => {
    const second = { ...plug, ieee_address: '0x54ef4410004aa201', friendly_name: '0x54ef4410004aa201' };
    expect(suggestedNameFor(plug)).not.toBe(suggestedNameFor(second));
  });
});
