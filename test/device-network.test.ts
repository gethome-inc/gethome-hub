import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { NetworkInterfaceInfo } from 'node:os';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hubWifiView, offlineElsewhere, type HubWifiView } from '../src/core/device-network.js';

/**
 * **A device offline because the hub left, said only when the hub can tell.**
 *
 * Found on a hub carried onto its owner's iPhone hotspot: the Wi-Fi plug at
 * home stayed on "Keti", both apps drew a plain "Offline" under *Needs
 * attention*, and nothing said the plug was exactly where it had been left.
 */

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const hex = (text: string): string => Buffer.from(text, 'utf8').toString('hex');

/** A data directory holding the networks file as the root script writes it. */
function dataDirWith(networks: Array<[ssid: string, connected: boolean]>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'gethome-device-network-'));
  dirs.push(dir);
  mkdirSync(path.join(dir, 'wifi'));
  const lines = networks.map(
    ([ssid, connected], index) =>
      `network=${String(index).padStart(8, '0')}-0000-4000-8000-000000000000 ${connected ? 1 : 0} ${hex(ssid)}`,
  );
  writeFileSync(
    path.join(dir, 'wifi', 'networks'),
    ['# Written by gethome-wifi-networks. Do not edit.', 'updated=2026-10-14T11:11:00Z', ...lines, ''].join('\n'),
  );
  return dir;
}

const address = (ip: string, internal = false): NetworkInterfaceInfo => ({
  address: ip,
  netmask: '255.255.255.240',
  family: 'IPv4',
  mac: '00:00:00:00:00:00',
  internal,
  cidr: `${ip}/28`,
});

/** A Pi on Wi-Fi alone: loopback and `wlan0`. */
const WIFI_ONLY = { lo: [address('127.0.0.1', true)], wlan0: [address('172.20.10.3')] };

describe('hubWifiView', () => {
  it('reads the network the hub is on and every one it knows', () => {
    const view = hubWifiView(dataDirWith([['iPhone (George)', true], ['Keti', false]]), WIFI_ONLY);
    expect(view?.current).toBe('iPhone (George)');
    expect([...(view?.known ?? [])].sort()).toEqual(['Keti', 'iPhone (George)']);
  });

  it('cannot answer on a cable as well, with nothing connected, or with no list', () => {
    const dir = dataDirWith([['iPhone (George)', true], ['Keti', false]]);
    // A cable reaches a Wi-Fi accessory through the router whatever the radio
    // is joined to, so a different name there says nothing.
    expect(hubWifiView(dir, { ...WIFI_ONLY, eth0: [address('192.168.0.200')] })).toBeUndefined();
    expect(hubWifiView(dir, { ...WIFI_ONLY, end0: [address('192.168.0.200')] })).toBeUndefined();
    // A link-local address on a cable that found no DHCP is no route at all.
    expect(hubWifiView(dir, { ...WIFI_ONLY, eth0: [address('169.254.10.2')] })).toBeDefined();
    expect(hubWifiView(dataDirWith([['Keti', false]]), WIFI_ONLY)).toBeUndefined();
    const empty = mkdtempSync(path.join(tmpdir(), 'gethome-device-network-'));
    dirs.push(empty);
    expect(hubWifiView(empty, WIFI_ONLY)).toBeUndefined();
  });
});

describe('offlineElsewhere', () => {
  const moved: HubWifiView = { current: 'iPhone (George)', known: new Set(['Keti', 'iPhone (George)']) };

  it('names the network a device waits on while the hub is on another it knows', () => {
    expect(offlineElsewhere({ online: false, wifiNetwork: 'Keti' }, moved)).toEqual({ network: 'Keti' });
  });

  it('claims nothing it cannot support', () => {
    // Answering: on a network the hub reaches, whatever it is called.
    expect(offlineElsewhere({ online: true, wifiNetwork: 'Keti' }, moved)).toBeUndefined();
    // Never said which Wi-Fi it is on — a Zigbee sensor, a Thread light.
    expect(offlineElsewhere({ online: false, wifiNetwork: null }, moved)).toBeUndefined();
    // The hub cannot say where it is.
    expect(offlineElsewhere({ online: false, wifiNetwork: 'Keti' }, undefined)).toBeUndefined();
    // Same network: offline is offline.
    expect(
      offlineElsewhere({ online: false, wifiNetwork: 'Keti' }, { current: 'Keti', known: new Set(['Keti']) }),
    ).toBeUndefined();
    // A router with a name per band: the hub on the 5 GHz one holds no profile
    // for the 2.4 GHz one its accessories use, so an unplugged accessory there
    // is reported as what it is.
    expect(
      offlineElsewhere(
        { online: false, wifiNetwork: 'Keti' },
        { current: 'Keti-5G', known: new Set(['Keti-5G']) },
      ),
    ).toBeUndefined();
  });
});
