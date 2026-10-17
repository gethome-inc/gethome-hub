import { describe, expect, it } from 'vitest';
import { wifiNetworkOf } from '../src/adapters/matter/wifi-network.js';

/**
 * **Which Wi-Fi a Matter accessory is on, from its own cached answer.**
 *
 * The shapes below are the ones matter.js had cached on the hub this was found
 * on: a Wi-Fi plug with `MaxNetworks` 1, read while the hub was on its owner's
 * iPhone hotspot and the plug was at home on "Keti".
 */

const WIFI = { wiFiNetworkInterface: true, threadNetworkInterface: false, ethernetNetworkInterface: false };
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('wifiNetworkOf', () => {
  it('names the network the plug went away on, from the cache', () => {
    expect(wifiNetworkOf(WIFI, [{ networkId: Uint8Array.from([0x4b, 0x65, 0x74, 0x69]), connected: true }])).toBe(
      'Keti',
    );
  });

  it('takes the connected one of several, and the only one when none is marked', () => {
    expect(
      wifiNetworkOf(WIFI, [
        { networkId: bytes('Dacha'), connected: false },
        { networkId: bytes('Keti'), connected: true },
      ]),
    ).toBe('Keti');
    expect(wifiNetworkOf(WIFI, [{ networkId: bytes('Keti'), connected: false }])).toBe('Keti');
    // Two, neither marked: no honest way to pick.
    expect(
      wifiNetworkOf(WIFI, [
        { networkId: bytes('Dacha'), connected: false },
        { networkId: bytes('Keti'), connected: false },
      ]),
    ).toBeUndefined();
  });

  it('keeps a name in any script, and any view of the bytes', () => {
    const name = 'Дача ’25';
    const encoded = bytes(name);
    expect(wifiNetworkOf(WIFI, [{ networkId: encoded, connected: true }])).toBe(name);
    expect(wifiNetworkOf(WIFI, [{ networkId: encoded.buffer, connected: true }])).toBe(name);
  });

  it('says nothing about a Thread or Ethernet accessory', () => {
    // An extended PAN ID and an interface name: not a network a person knows
    // by that name, and nothing the hub's own Wi-Fi could be compared with.
    const thread = { wiFiNetworkInterface: false, threadNetworkInterface: true, ethernetNetworkInterface: false };
    expect(wifiNetworkOf(thread, [{ networkId: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]), connected: true }])).toBe(
      undefined,
    );
    const ethernet = { wiFiNetworkInterface: false, threadNetworkInterface: false, ethernetNetworkInterface: true };
    expect(wifiNetworkOf(ethernet, [{ networkId: bytes('eth0'), connected: true }])).toBeUndefined();
  });

  it('refuses what it cannot name faithfully, and never throws', () => {
    // Not UTF-8: a name the hub cannot render is one it cannot compare either.
    expect(wifiNetworkOf(WIFI, [{ networkId: Uint8Array.from([0xff, 0xfe, 0x41]), connected: true }])).toBe(
      undefined,
    );
    expect(wifiNetworkOf(WIFI, [{ networkId: new Uint8Array(0), connected: true }])).toBeUndefined();
    expect(wifiNetworkOf(WIFI, [{ networkId: new Uint8Array(33).fill(0x41), connected: true }])).toBeUndefined();
    for (const [features, networks] of [
      [undefined, undefined],
      [null, []],
      [WIFI, undefined],
      [WIFI, 'Keti'],
      [WIFI, [null, 7, { networkId: 'Keti', connected: true }]],
      [42, [{ networkId: bytes('Keti'), connected: true }]],
    ] as const) {
      expect(wifiNetworkOf(features, networks)).toBeUndefined();
    }
  });
});
