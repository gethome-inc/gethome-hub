/**
 * The Wi-Fi network a Matter accessory is itself joined to, as its own
 * `NetworkCommissioning` cluster says — read from matter.js's cache, so it is
 * known for an accessory that is switched off, or out of reach, right now.
 *
 * It is what lets the hub say *why* a Wi-Fi accessory is offline when the hub
 * has been carried to another network (`docs/api.md`, "On another Wi-Fi"):
 * the accessory stays joined to the network it was given at commissioning and
 * cannot follow, because a Matter accessory is moved to another network by its
 * administrator *while it is reachable*, and once the hub has left it never
 * is. Found on a hub moved onto its owner's iPhone hotspot: the plug's cache
 * still read `[{ networkId: "Keti", connected: true }]`, and the apps drew a
 * plain "Offline" over a device that was exactly where it had been left.
 *
 * Wi-Fi only. A Thread accessory's `networkId` is an extended PAN ID and an
 * Ethernet one's is an interface name — neither is a network a person knows
 * by that name, and neither is something the hub's own Wi-Fi can be compared
 * with.
 *
 * Never throws: it is called while a node is being announced, and nothing
 * about announcing a device may wait on why it might be offline.
 */
export function wifiNetworkOf(features: unknown, networks: unknown): string | undefined {
  if (typeof features !== 'object' || features === null) return undefined;
  if ((features as Record<string, unknown>).wiFiNetworkInterface !== true) return undefined;
  if (!Array.isArray(networks)) return undefined;

  const entries = networks.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { networkId, connected } = entry as Record<string, unknown>;
    const ssid = ssidOf(networkId);
    return ssid === undefined ? [] : [{ ssid, connected: connected === true }];
  });
  // The one it is on, and the cache keeps that flag from the last time the
  // hub could see it — which is the network it went away on. Failing that,
  // the only one it holds: most accessories hold one (`MaxNetworks` is 1 on
  // the plug this was found on). Several and none marked is a list this
  // cannot pick from honestly.
  const connected = entries.find((entry) => entry.connected);
  if (connected !== undefined) return connected.ssid;
  return entries.length === 1 ? entries[0]!.ssid : undefined;
}

/**
 * An SSID is up to 32 arbitrary bytes. Named only when they are UTF-8, since
 * a name the hub cannot render faithfully is one it cannot compare with the
 * network it is on either — and a wrong comparison is a wrong sentence.
 */
function ssidOf(value: unknown): string | undefined {
  const bytes = bytesOf(value);
  if (bytes === undefined || bytes.length === 0 || bytes.length > 32) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** matter.js decodes an octet string as a `Uint8Array`; a cache may hand back any view of one. */
function bytesOf(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return undefined;
}
