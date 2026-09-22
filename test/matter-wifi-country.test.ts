import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readWifiCountry } from '../src/core/wifi.js';
import { commissioningFor } from '../src/adapters/matter/commissioning-options.js';

/**
 * **An accessory is told which country it is in as it is commissioned**, so it
 * may use every channel that country allows. Told nothing, it is told `XX` and
 * may keep to 1–11 — and a router on 12 or 13, ordinary in Europe and much of
 * Asia, is then a network it cannot see.
 */
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function regdom(contents: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'gethome-regdom-'));
  dirs.push(dir);
  const file = path.join(dir, 'ieee80211_regdom');
  writeFileSync(file, contents);
  return file;
}

describe('the country this hub’s Wi-Fi is set for', () => {
  it('reads the code Raspberry Pi Imager puts on the kernel command line', () => {
    expect(readWifiCountry(regdom('GE\n'))).toBe('GE');
    expect(readWifiCountry(regdom('de'))).toBe('DE');
  });

  it('says nothing for the world domain, a missing file or anything else', () => {
    expect(readWifiCountry(regdom('00\n'))).toBeUndefined();
    expect(readWifiCountry(regdom('99'))).toBeUndefined();
    expect(readWifiCountry(regdom(''))).toBeUndefined();
    expect(readWifiCountry('/nonexistent/ieee80211_regdom')).toBeUndefined();
  });
});

describe('what an accessory is told as it is commissioned', () => {
  it('carries the country and the network together', () => {
    expect(commissioningFor({ ssid: 'Flat 3', passphrase: 'hunter2hunter2' }, 'GE')).toEqual({
      regulatoryCountryCode: 'GE',
      wifiNetwork: { wifiSsid: 'Flat 3', wifiCredentials: 'hunter2hunter2' },
    });
  });

  /** matter.js sends `XX` itself when given nothing, and retries with it when refused. */
  it('leaves out what it does not know rather than inventing it', () => {
    expect(commissioningFor(undefined, undefined)).toEqual({});
    expect(commissioningFor(undefined, 'GE')).toEqual({ regulatoryCountryCode: 'GE' });
  });
});
