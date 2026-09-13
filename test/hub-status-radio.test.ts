import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RADIO_APPLY_WINDOW_MS,
  readRadioMode,
  readRadioRequest,
  writeRadioMode,
} from '../src/core/radio.js';
import { readCoordinatorPresence } from '../src/adapters/zigbee/coordinator.js';
import { readWifiCredentials } from '../src/core/wifi.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'gethome-radio-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A radio switch restarts the hub, which is what makes it hard to report.
 *
 * The process that recorded the request is killed by the thing it asked for,
 * so an app polling across the gap saw a refused connection, then the old
 * radios, then the new ones — and drew "can't reach your hub" over a change
 * the person had just made on purpose. One number on disk turns all of that
 * into one sentence.
 */
describe('a radio switch in flight', () => {
  it('is not in flight on a hub nobody has asked', () => {
    expect(readRadioRequest(dir)).toBeUndefined();
  });

  it('is recorded when the mode is', () => {
    writeRadioMode(dir, 'matter');
    expect(readRadioMode(dir)).toBe('matter');
    const request = readRadioRequest(dir);
    expect(request).toBeDefined();
    expect(Math.abs(Date.now() - request!.at)).toBeLessThan(5_000);
  });

  it('stops claiming to be applying once the window has passed', () => {
    // A bound rather than a wait for the radios to agree, because some
    // requests can never be satisfied: asking for Zigbee on a hub with no
    // coordinator is reasonable, correctly changes nothing, and would leave a
    // spinner running for ever.
    writeFileSync(
      path.join(dir, 'radio-requested'),
      `${Date.now() - RADIO_APPLY_WINDOW_MS - 1_000}\n`,
    );
    expect(readRadioRequest(dir)).toBeUndefined();
  });

  it('ignores a timestamp from the future', () => {
    // A board with no real-time clock catching up with NTP must not read as a
    // switch that will land in an hour.
    writeFileSync(path.join(dir, 'radio-requested'), `${Date.now() + 60 * 60 * 1000}\n`);
    expect(readRadioRequest(dir)).toBeUndefined();
  });

  it('ignores a file that is not a number', () => {
    writeFileSync(path.join(dir, 'radio-requested'), 'soon\n');
    expect(readRadioRequest(dir)).toBeUndefined();
  });
});

/**
 * "No stick" and "the stick is here and Matter has the board" are both
 * `connected: false`, they need opposite words in an app, and the detector's
 * own record is the only thing that can tell them apart.
 */
describe('whether a Zigbee coordinator is plugged in', () => {
  it('is unknown on a machine that has never seen one', () => {
    expect(readCoordinatorPresence(path.join(dir, 'zigbee.env'))).toBe('unknown');
  });

  it('is unknown when the file exists but records nothing', () => {
    const file = path.join(dir, 'zigbee.env');
    writeFileSync(file, '# Written by gethome-zigbee-detect.\nZIGBEE2MQTT_CONFIG_SERIAL_PORT=/dev/ttyACM0\n');
    expect(readCoordinatorPresence(file)).toBe('unknown');
  });

  it('is present when the recorded device is still there', () => {
    // The by-id name, not the node beside it: `ZIGBEE_ADAPTER` says *which
    // device this is* and survives a reboot, while `/dev/ttyACM0` moves the
    // moment a 3D printer is plugged in — and checking the node would report a
    // coordinator present because something else took its number.
    const stick = path.join(dir, 'usb-ITEAD_SONOFF_Zigbee_3.0-if00');
    writeFileSync(stick, '');
    const file = path.join(dir, 'zigbee.env');
    writeFileSync(file, `ZIGBEE_ADAPTER=${stick}\nZIGBEE2MQTT_CONFIG_SERIAL_PORT=/dev/ttyACM0\n`);
    expect(readCoordinatorPresence(file)).toBe('present');
  });

  it('is absent when it was recorded and has been unplugged', () => {
    const file = path.join(dir, 'zigbee.env');
    writeFileSync(file, `ZIGBEE_ADAPTER=${path.join(dir, 'gone-if00')}\n`);
    expect(readCoordinatorPresence(file)).toBe('absent');
  });
});

/**
 * A factory-new Wi-Fi accessory is commissioned over Bluetooth and the point
 * of the conversation is to give it a network. A hub that can do the first and
 * not the second starts a pairing it cannot finish.
 */
describe('the Wi-Fi the hub can hand an accessory', () => {
  it('is nothing at all when the file is missing', () => {
    expect(readWifiCredentials(path.join(dir, 'wifi.env'))).toBeUndefined();
  });

  it('reads what the dispatcher wrote', () => {
    const file = path.join(dir, 'wifi.env');
    writeFileSync(file, "WIFI_SSID='Flat 3'\nWIFI_PSK='hunter2hunter2'\n");
    expect(readWifiCredentials(file)).toEqual({ ssid: 'Flat 3', passphrase: 'hunter2hunter2' });
  });

  it('is nothing for an open network', () => {
    // An open network has no password to hand over, and an accessory given an
    // empty PSK for a network it cannot join is worse than being told the hub
    // has none.
    const file = path.join(dir, 'wifi.env');
    writeFileSync(file, 'WIFI_SSID=Cafe\nWIFI_PSK=\n');
    expect(readWifiCredentials(file)).toBeUndefined();
  });
});
