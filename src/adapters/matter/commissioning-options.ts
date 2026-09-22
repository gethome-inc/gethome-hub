import type { WifiCredentials } from '../../core/wifi.js';

/**
 * What the commissioning conversation is told about the network the accessory
 * will live on, and about the country it is in.
 *
 * Its own module, and pure, so a test can read what an accessory would be told
 * without starting a Matter controller: `adapter.ts` pulls in `@matter/main`,
 * which is by far the largest thing in the graph.
 *
 * A country that is not known is left out rather than sent as `XX`. matter.js
 * sends `XX` itself when it is given nothing, and retries with `XX` when an
 * accessory refuses a real country, so leaving it out and sending `XX` mean the
 * same thing, and only one of them needs a test.
 */
export function commissioningFor(
  wifi: WifiCredentials | undefined,
  country: string | undefined,
): {
  regulatoryCountryCode?: string;
  wifiNetwork?: { wifiSsid: string; wifiCredentials: string };
} {
  return {
    ...(country !== undefined ? { regulatoryCountryCode: country } : {}),
    ...(wifi !== undefined ? { wifiNetwork: { wifiSsid: wifi.ssid, wifiCredentials: wifi.passphrase } } : {}),
  };
}
