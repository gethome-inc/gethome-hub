import { readFileSync } from 'node:fs';

/**
 * The Wi-Fi the hub is on, so it can hand it to an accessory that has none.
 *
 * A factory-new Wi-Fi Matter accessory is commissioned over Bluetooth, and the
 * point of that conversation is to give it a network: step 11 of the
 * commissioning flow is `AddOrUpdateWiFiNetwork(ssid, credentials)`. So a hub
 * that can do BLE and cannot answer that question can start a pairing it
 * cannot finish.
 *
 * **The hub does not read the system's own network configuration.** The PSK
 * lives in a root-owned NetworkManager profile, the hub runs as an unprivileged
 * service account, and the *point* of that account is that it cannot read files
 * like that. So the same shape as every other privileged fact here: a root
 * dispatcher writes `/etc/gethome/wifi.env` (mode 0640, group `gethome`) on
 * every association, and the hub reads one small file it is deliberately
 * allowed to read. A home that retypes its Wi-Fi password next month gets a
 * fresh profile and a fresh write; nothing here caches.
 *
 * Absent is an ordinary answer — an Ethernet hub, a machine where the
 * dispatcher never ran, a hub installed before this existed, or a dual-band
 * hub on a network only 5 GHz can see, which almost no Wi-Fi accessory can join
 * and the dispatcher therefore declines to hand over — and it means the app is
 * asked for the network instead, which is why `GET /hub` reports whether the
 * hub has one.
 */
export interface WifiCredentials {
  ssid: string;
  passphrase: string;
}

/** Where the deploy layer writes it. Overridable so tests own their own file. */
export const WIFI_ENV_FILE = '/etc/gethome/wifi.env';

/**
 * Read the file, or nothing.
 *
 * Every failure here is expected — no file, no permission, a half-written line
 * — and all of them mean the same thing to a caller, so none of them may become
 * an error on a route. An entry with an empty passphrase is *not* credentials:
 * an open network has nothing to hand over and a Matter accessory would be
 * given an empty PSK for a network it cannot join.
 */
export function readWifiCredentials(file: string = WIFI_ENV_FILE): WifiCredentials | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const values = new Map<string, string>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    // Shell-quoted on the way in, because an SSID may contain a space and the
    // file is sourced by the dispatcher that writes it.
    const value = trimmed.slice(eq + 1).replace(/^(['"])(.*)\1$/, '$2');
    values.set(trimmed.slice(0, eq), value);
  }
  const ssid = values.get('WIFI_SSID') ?? '';
  const passphrase = values.get('WIFI_PSK') ?? '';
  if (ssid.length === 0 || passphrase.length === 0) return undefined;
  return { ssid, passphrase };
}

/**
 * Where the kernel says which country's Wi-Fi rules this board follows:
 * `cfg80211.ieee80211_regdom=GE` on the kernel command line, which Raspberry Pi
 * Imager writes from the country somebody picked. Readable by any user, so the
 * hub reads it directly, with no root helper in between.
 */
export const WIFI_COUNTRY_FILE = '/sys/module/cfg80211/parameters/ieee80211_regdom';

/**
 * The country this hub's Wi-Fi is set for, or nothing.
 *
 * **Handed to a Matter accessory as it is commissioned.** `SetRegulatoryConfig`
 * carries a country code, and an accessory told nothing is told `XX`
 * (unknown), which lets it keep to the channels every country allows. In Europe
 * and much of Asia a router on channel 12 or 13 is ordinary, and an accessory
 * keeping to 1–11 cannot see it: the pairing fails at the network step, and
 * nothing says why. `00` is the world domain and says nothing either. An
 * accessory that cannot take a country is handled by matter.js itself, which
 * retries with `XX`.
 */
export function readWifiCountry(file: string = WIFI_COUNTRY_FILE): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8').trim().toUpperCase();
  } catch {
    return undefined;
  }
  return /^[A-Z]{2}$/.test(raw) ? raw : undefined;
}
