import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readSavedNetworks,
  readWifiChangeResult,
  requestWifiChange,
  wpaPsk,
} from '../src/core/wifi-networks.js';
import {
  callsOf,
  machine as stagedMachine,
  profilesOf,
  runWifiScript as run,
  type Machine,
  type Profile,
} from './helpers/fake-nmcli.js';

/**
 * `deploy/wifi-networks.sh` — the root half of "add another Wi-Fi network for
 * my hub".
 *
 * The hub writes a request into its own data directory, a `.path` unit
 * notices, and this script changes NetworkManager's profiles. `deploy/` has no
 * type checker behind it, so this drives the real script against a staged data
 * directory and a fake `nmcli` that keeps its profiles in a file — and the
 * request is written by the hub's own `requestWifiChange`, and the outcome read
 * back by the hub's own readers, because the two halves agreeing about a file
 * format is the thing no other test would notice breaking.
 */

const dirs: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'gethome-wifinets-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function machine(profiles: Profile[], options: { nmcli?: boolean } = {}): Machine {
  return stagedMachine(tmp, profiles, options);
}

const HOME_ID = '11111111-2222-3333-4444-555555555555';
const SPARE_ID = '66666666-7777-8888-9999-000000000000';
const WIRED_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const HOME: Profile = { uuid: HOME_ID, type: '802-11-wireless', active: true, name: 'preconfigured', ssid: 'Flat 3' };
const SPARE: Profile = { uuid: SPARE_ID, type: '802-11-wireless', active: false, name: 'gethome', ssid: 'Dacha' };
const WIRED: Profile = { uuid: WIRED_ID, type: '802-3-ethernet', active: true, name: 'Wired', ssid: '' };

describe('the list of networks the hub reads', () => {
  it('names every Wi-Fi profile and which one the hub is on, and nothing else', () => {
    const m = machine([HOME, SPARE, WIRED]);
    expect(run(m, ['--list'])).toBe(0);
    const list = readSavedNetworks(m.data);
    expect(list?.networks).toEqual([
      { id: HOME_ID, ssid: 'Flat 3', connected: true },
      { id: SPARE_ID, ssid: 'Dacha', connected: false },
    ]);
    expect(list?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('is readable by the hub and nobody else, because it says where the hub has been', () => {
    const m = machine([HOME]);
    run(m, ['--list']);
    expect((statSync(path.join(m.data, 'wifi', 'networks')).mode & 0o777).toString(8)).toBe('640');
  });

  it('carries a name with quotes, colons and Cyrillic in it unchanged', () => {
    // The list is hex on the way through for exactly this: `nmcli -t` escapes
    // colons, a quote ends a shell string, and a line break would end a record.
    const name = `Дача: "Dave's" \\ 5G`;
    const m = machine([{ ...SPARE, ssid: name }]);
    run(m, ['--list']);
    expect(readSavedNetworks(m.data)?.networks[0]?.ssid).toBe(name);
  });

  it('removes the list on a machine with no NetworkManager rather than leaving a stale one', () => {
    const m = machine([HOME]);
    run(m, ['--list']);
    rmSync(path.join(m.bin, 'nmcli'));
    run(m, ['--list']);
    expect(readSavedNetworks(m.data)).toBeUndefined();
  });
});

describe('adding a network', () => {
  it('writes a NetworkManager profile with the exact name and the derived key', () => {
    const m = machine([HOME]);
    const ssid = "Dave's Dacha";
    const psk = wpaPsk(ssid, 'correct horse battery');
    const id = requestWifiChange(m.data, { action: 'add', ssid, psk, hidden: false });

    expect(run(m)).toBe(0);

    const added = profilesOf(m).find((p) => p.ssid === ssid);
    expect(added, 'the profile was never written').toBeDefined();
    expect(added?.name).toBe(`gethome-${id.slice(0, 8)}`);
    const add = callsOf(m).find((call) => call[0] === 'connection' && call[1] === 'add')!;
    // One argument each, never a shell string: the apostrophe arrives intact
    // and the key is the derived one, not the passphrase.
    expect(add).toEqual([
      'connection', 'add', 'type', 'wifi', 'ifname', 'wlan0',
      'con-name', `gethome-${id.slice(0, 8)}`,
      'ssid', ssid,
      'connection.autoconnect', 'yes',
      '802-11-wireless.hidden', 'no',
      'wifi-sec.key-mgmt', 'wpa-psk',
      'wifi-sec.psk', psk,
    ]);
    expect(add.join(' ')).not.toContain('correct horse battery');

    const result = readWifiChangeResult(m.data);
    expect(result).toMatchObject({ id, action: 'add', state: 'applied', ssid, networkId: added!.uuid });
    expect(readSavedNetworks(m.data)?.networks.map((n) => n.ssid)).toEqual(['Flat 3', ssid]);
  });

  it('consumes the request, so the path unit is not re-armed by a change already made', () => {
    const m = machine([HOME]);
    requestWifiChange(m.data, { action: 'add', ssid: 'Dacha', psk: wpaPsk('Dacha', 'password1'), hidden: false });
    run(m);
    expect(existsSync(path.join(m.data, 'wifi', 'request'))).toBe(false);
  });

  it('asks NetworkManager to look for a network that does not announce itself', () => {
    const m = machine([HOME]);
    requestWifiChange(m.data, { action: 'add', ssid: 'Quiet', psk: wpaPsk('Quiet', 'password1'), hidden: true });
    run(m);
    const add = callsOf(m).find((call) => call[1] === 'add')!;
    expect(add[add.indexOf('802-11-wireless.hidden') + 1]).toBe('yes');
  });

  it('leaves the profile unbound on a board with no Wi-Fi device to name', () => {
    const m = machine([WIRED]);
    requestWifiChange(m.data, { action: 'add', ssid: 'Dacha', psk: wpaPsk('Dacha', 'password1'), hidden: false });
    run(m, [], { FAKE_NO_WIFI_DEVICE: '1' });
    const add = callsOf(m).find((call) => call[1] === 'add')!;
    expect(add).not.toContain('ifname');
    expect(readWifiChangeResult(m.data)?.state).toBe('applied');
  });

  it('refuses a second profile for a name the hub already knows', () => {
    const m = machine([HOME]);
    requestWifiChange(m.data, { action: 'add', ssid: 'Flat 3', psk: wpaPsk('Flat 3', 'password1'), hidden: false });
    run(m);
    expect(readWifiChangeResult(m.data)).toMatchObject({ state: 'failed', error: 'exists' });
    expect(profilesOf(m)).toHaveLength(1);
  });

  it('stops at sixteen', () => {
    const many = Array.from({ length: 16 }, (_, i) => ({
      ...SPARE,
      uuid: `66666666-7777-8888-9999-${String(i).padStart(12, '0')}`,
      ssid: `Net ${i}`,
    }));
    const m = machine(many);
    requestWifiChange(m.data, { action: 'add', ssid: 'One more', psk: wpaPsk('One more', 'password1'), hidden: false });
    run(m);
    expect(readWifiChangeResult(m.data)).toMatchObject({ state: 'failed', error: 'limit' });
    expect(profilesOf(m)).toHaveLength(16);
  });

  it('refuses a key that is not one, without asking nmcli to add anything', () => {
    // The request is the hub user's file and this script is root, so it is
    // validated here whatever the hub checked.
    const m = machine([HOME]);
    writeFileSync(
      path.join(m.data, 'wifi', 'request'),
      'id=0123456789abcdef\naction=add\nssid=Dacha\npsk=$(reboot)\nhidden=0\n',
    );
    run(m);
    expect(readWifiChangeResult(m.data)).toMatchObject({ state: 'failed', error: 'invalid' });
    expect(callsOf(m).some((call) => call[1] === 'add')).toBe(false);
  });

  it('passes on what NetworkManager said when it refuses', () => {
    const m = machine([HOME]);
    requestWifiChange(m.data, { action: 'add', ssid: 'Dacha', psk: wpaPsk('Dacha', 'password1'), hidden: false });
    run(m, [], { FAKE_ADD_FAILS: '1' });
    const result = readWifiChangeResult(m.data);
    expect(result).toMatchObject({ state: 'failed', error: 'nmcli' });
    expect(result?.detail).toContain('property is invalid');
  });
});

describe('removing a network', () => {
  it('deletes a network the hub is not on', () => {
    const m = machine([HOME, SPARE]);
    const id = requestWifiChange(m.data, { action: 'remove', networkId: SPARE_ID });
    run(m);
    expect(profilesOf(m).map((p) => p.uuid)).toEqual([HOME_ID]);
    expect(readWifiChangeResult(m.data)).toMatchObject({
      id,
      action: 'remove',
      state: 'applied',
      ssid: 'Dacha',
      networkId: SPARE_ID,
    });
  });

  it('never deletes the network the hub is connected through', () => {
    // Deleting an active profile takes the connection down with it, and a hub
    // with no network is one no app can reach to put it back.
    const m = machine([HOME, SPARE]);
    requestWifiChange(m.data, { action: 'remove', networkId: HOME_ID });
    run(m);
    expect(readWifiChangeResult(m.data)).toMatchObject({ state: 'failed', error: 'connected', ssid: 'Flat 3' });
    expect(profilesOf(m)).toHaveLength(2);
    expect(callsOf(m).some((call) => call[1] === 'delete')).toBe(false);
  });

  it('touches nothing that is not a Wi-Fi profile', () => {
    const m = machine([HOME, { ...WIRED, active: false }]);
    requestWifiChange(m.data, { action: 'remove', networkId: WIRED_ID });
    run(m);
    expect(readWifiChangeResult(m.data)).toMatchObject({ state: 'failed', error: 'not_found' });
    expect(profilesOf(m)).toHaveLength(2);
  });
});

describe('a machine that cannot', () => {
  it('says so when there is no NetworkManager', () => {
    const m = machine([], { nmcli: false });
    requestWifiChange(m.data, { action: 'remove', networkId: SPARE_ID });
    expect(run(m)).toBe(0);
    expect(readWifiChangeResult(m.data)).toMatchObject({ state: 'failed', error: 'unsupported' });
  });

  it('drops a request that is not one, and still exits 0', () => {
    // A non-zero exit would park the unit in `failed`, and enough of those stop
    // it starting at all until somebody runs `reset-failed` on the Pi.
    const m = machine([HOME]);
    writeFileSync(path.join(m.data, 'wifi', 'request'), 'id=x\naction=add\n');
    expect(run(m)).toBe(0);
    expect(existsSync(path.join(m.data, 'wifi', 'request'))).toBe(false);
    expect(readWifiChangeResult(m.data)).toBeUndefined();
  });
});
