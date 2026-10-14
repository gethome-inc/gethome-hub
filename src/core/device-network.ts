import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import type { RegistryDevice } from './registry.js';
import { readSavedNetworks } from './wifi-networks.js';

/**
 * **A device can be offline because the hub left, and the hub can say so.**
 *
 * A hub can be told about another Wi-Fi network before it is carried there
 * (`wifi-networks.ts`), and when it arrives it joins that one. Its Wi-Fi
 * accessories cannot follow: a Matter accessory is moved to another network
 * by its administrator *while it is reachable*, and once the hub has gone it
 * never is. So every one of them went offline the moment the hub moved, both
 * apps drew a plain "Offline" with *Needs attention* over the home, and
 * nothing said that the plug was exactly where it had been left — on the home
 * network, waiting for the hub to come back to it. Found on a hub carried onto
 * its owner's iPhone hotspot.
 *
 * The claim is deliberately narrow, because a device it covers is one the apps
 * stop raising an alarm about, and an unplugged device described as "on
 * another network" is the reassurance nobody should be given. All of:
 *
 * - **The device is offline.** A device that answers is on a network the hub
 *   can reach, whatever it is called — a router with a separate name for each
 *   band is one network with two names.
 * - **It said which Wi-Fi it is on** (`wifiNetwork`, from its own report).
 * - **The hub is on Wi-Fi, and only Wi-Fi.** A hub on a cable reaches a Wi-Fi
 *   accessory through the router, so a different name on its own radio says
 *   nothing about where the accessory is.
 * - **The device's network is one the hub knows, and not the one it is on.**
 *   That is what makes it the hub having moved rather than the accessory being
 *   somewhere the hub never was: an accessory paired by this hub was given the
 *   network the hub was on at the time. And it is what keeps a home with two
 *   names on one router out of it — a hub joined to the 5 GHz name holds no
 *   profile for the 2.4 GHz one its accessories use, so an accessory there
 *   that goes offline is offline, and says so.
 */
export interface HubWifiView {
  /** The network the hub is connected through now. */
  current: string;
  /** Every network it holds a profile for, the current one included. */
  known: ReadonlySet<string>;
}

/**
 * What the hub knows about its own Wi-Fi, for this question — undefined when
 * it cannot answer it: no list (a hub installed before the root script wrote
 * one, or with no NetworkManager), no network connected, or a cable as well.
 *
 * Read per call rather than held, because the list is rewritten on every
 * association and a hub that has just moved is exactly the one being asked
 * about. It is one small file. Never throws: the device list must render
 * whether or not this can be answered.
 */
export function hubWifiView(
  dataDir: string,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = safeInterfaces(),
): HubWifiView | undefined {
  try {
    if (hasWiredAddress(interfaces)) return undefined;
    const networks = readSavedNetworks(dataDir)?.networks;
    const current = networks?.find((network) => network.connected)?.ssid;
    if (networks === undefined || current === undefined) return undefined;
    return { current, known: new Set(networks.map((network) => network.ssid)) };
  } catch {
    return undefined;
  }
}

/**
 * The network a device is on while the hub is on another, when every rule
 * above holds — and undefined otherwise, which is the ordinary answer.
 */
export function offlineElsewhere(
  device: Pick<RegistryDevice, 'online' | 'wifiNetwork'>,
  hub: HubWifiView | undefined,
): { network: string } | undefined {
  if (device.online || device.wifiNetwork === null || hub === undefined) return undefined;
  if (device.wifiNetwork === hub.current || !hub.known.has(device.wifiNetwork)) return undefined;
  return { network: device.wifiNetwork };
}

/**
 * Whether the machine has an address anywhere but its Wi-Fi radio — a cable,
 * or a USB link. Wireless interfaces are `wlan0` on Raspberry Pi OS and `wl…`
 * under predictable names; loopback and link-local-only interfaces carry no
 * route to an accessory and are not counted.
 */
function hasWiredAddress(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): boolean {
  return Object.entries(interfaces).some(
    ([name, entries]) =>
      !name.startsWith('wl') &&
      (entries ?? []).some((entry) => entry.family === 'IPv4' && !entry.internal && !entry.address.startsWith('169.254.')),
  );
}

function safeInterfaces(): NodeJS.Dict<NetworkInterfaceInfo[]> {
  try {
    return networkInterfaces();
  } catch {
    return {};
  }
}
