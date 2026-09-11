import type { CapabilityKind } from './capabilities.js';
import type { DeviceKind } from './kinds.js';

/**
 * The Matter device-type catalog — device-type ID (from the Descriptor
 * cluster's DeviceTypeList) → display kind + expected capabilities.
 * Mirrors the GetHome app's `MatterDeviceTypeCatalog`; Zigbee and MQTT
 * devices reuse the same kinds/capabilities vocabulary, so this table is
 * also the reference for what a "light" or a "climate" device means.
 */
export interface DeviceTypeDescriptor {
  id: number;
  name: string;
  kind: DeviceKind;
  capabilities: CapabilityKind[];
  primary: CapabilityKind;
}

const d = (
  id: number,
  name: string,
  kind: DeviceKind,
  capabilities: CapabilityKind[],
  primary?: CapabilityKind,
): DeviceTypeDescriptor => ({
  id,
  name,
  kind,
  capabilities,
  primary: primary ?? capabilities[0] ?? 'onOff',
});

export const DEVICE_TYPE_CATALOG: readonly DeviceTypeDescriptor[] = [
  // Lighting
  d(0x0100, 'On/Off Light', 'light', ['onOff']),
  d(0x0101, 'Dimmable Light', 'light', ['onOff', 'level']),
  d(0x010c, 'Color Temperature Light', 'light', ['onOff', 'level', 'colorTemperature']),
  d(0x010d, 'Extended Color Light', 'light', ['onOff', 'level', 'colorTemperature', 'color']),

  // Plugs & loads
  d(0x010a, 'Smart Plug', 'outlet', ['onOff', 'electricalPower']),
  d(0x010b, 'Dimmable Plug-In Unit', 'outlet', ['onOff', 'level']),
  d(0x010f, 'Mounted On/Off Control', 'outlet', ['onOff']),
  d(0x0110, 'Mounted Dimmable Load Control', 'outlet', ['onOff', 'level']),
  d(0x0303, 'Pump', 'appliance', ['onOff']),

  // Switches & controls
  // Generic Switch endpoints emit Switch-cluster events (buttons), not On/Off.
  d(0x000f, 'Generic Switch', 'remote', ['event', 'battery'], 'event'),
  d(0x0103, 'On/Off Light Switch', 'wallSwitch', ['onOff']),
  d(0x0104, 'Dimmer Switch', 'wallSwitch', ['onOff', 'level']),
  d(0x0105, 'Color Dimmer Switch', 'wallSwitch', ['onOff', 'level', 'color']),
  d(0x0850, 'On/Off Sensor', 'sensor', ['onOff']),

  // Sensors
  d(0x0015, 'Contact Sensor', 'sensor', ['contact', 'battery']),
  d(0x0106, 'Light Sensor', 'sensor', ['illuminance', 'battery']),
  d(0x0107, 'Occupancy Sensor', 'sensor', ['occupancy', 'battery']),
  d(0x0302, 'Temperature Sensor', 'sensor', ['temperature', 'battery']),
  d(0x0305, 'Pressure Sensor', 'sensor', ['pressure', 'battery']),
  d(0x0306, 'Flow Sensor', 'sensor', ['flow', 'battery']),
  d(0x0307, 'Humidity Sensor', 'sensor', ['humidity', 'battery']),
  d(0x002c, 'Air Quality Sensor', 'sensor', ['airQuality', 'pm25', 'co2', 'temperature', 'humidity']),
  d(0x0076, 'Smoke & CO Alarm', 'sensor', ['smokeCOAlarm', 'battery']),
  d(0x0041, 'Water Freeze Detector', 'sensor', ['contact', 'battery']),
  d(0x0043, 'Water Leak Detector', 'sensor', ['contact', 'battery']),
  d(0x0044, 'Rain Sensor', 'sensor', ['contact', 'battery']),
  d(0x0510, 'Electrical Sensor', 'energy', ['electricalPower']),

  // HVAC
  d(0x0301, 'Thermostat', 'climate', ['thermostat', 'temperature', 'battery'], 'thermostat'),
  d(0x002b, 'Fan', 'fan', ['fan']),
  d(0x002d, 'Air Purifier', 'airPurifier', ['fan', 'airQuality', 'pm25'], 'fan'),
  d(0x0300, 'Heating/Cooling Unit', 'climate', ['onOff', 'level']),
  d(0x0072, 'Room Air Conditioner', 'climate', ['onOff', 'thermostat', 'fan', 'temperature', 'humidity'], 'thermostat'),

  // Closures
  d(0x000a, 'Door Lock', 'lock', ['doorLock', 'battery'], 'doorLock'),
  d(0x0202, 'Window Covering', 'shade', ['windowCovering', 'battery'], 'windowCovering'),

  // Entertainment
  d(0x0022, 'Speaker', 'speaker', ['onOff', 'level', 'mediaPlayback']),
  d(0x0028, 'Basic Video Player', 'tv', ['onOff', 'mediaPlayback']),
  d(0x0023, 'Casting Video Player', 'tv', ['onOff', 'level', 'mediaPlayback']),

  // Robotic & appliances
  d(0x0074, 'Robotic Vacuum Cleaner', 'vacuum', ['rvcRun', 'mode', 'battery'], 'rvcRun'),
  d(0x0070, 'Refrigerator', 'appliance', ['temperature', 'mode'], 'temperature'),
  d(0x0071, 'Temperature Controlled Cabinet', 'appliance', ['temperature', 'mode'], 'temperature'),
  d(0x0073, 'Laundry Washer', 'appliance', ['onOff', 'mode']),
  d(0x007c, 'Laundry Dryer', 'appliance', ['onOff', 'mode']),
  d(0x0075, 'Dishwasher', 'appliance', ['onOff', 'mode']),
  d(0x007b, 'Oven', 'appliance', ['temperature', 'mode'], 'temperature'),
  d(0x0078, 'Cooktop', 'appliance', ['onOff']),
  d(0x0077, 'Cook Surface', 'appliance', ['temperature'], 'temperature'),
  d(0x007a, 'Extractor Hood', 'appliance', ['fan'], 'fan'),
  d(0x0079, 'Microwave Oven', 'appliance', ['mode', 'fan'], 'mode'),
  d(0x0042, 'Water Valve', 'appliance', ['onOff']),
  d(0x0027, 'Mode Select', 'appliance', ['mode'], 'mode'),

  // Energy
  d(0x050c, 'EVSE (EV Charger)', 'energy', ['mode', 'electricalPower'], 'electricalPower'),
  d(0x050f, 'Water Heater', 'energy', ['thermostat', 'mode'], 'thermostat'),
  d(0x0017, 'Solar Power', 'energy', ['electricalPower'], 'electricalPower'),
  d(0x0018, 'Battery Storage', 'energy', ['battery', 'electricalPower'], 'electricalPower'),
  d(0x0309, 'Heat Pump', 'energy', ['thermostat', 'electricalPower'], 'thermostat'),
];

/**
 * Infrastructure device types that never surface as user-facing devices
 * (root node, power source, OTA, bridge plumbing, …).
 */
export const INFRASTRUCTURE_TYPES: ReadonlySet<number> = new Set([
  0x0016, // Root Node
  0x0011, // Power Source
  0x0012, // OTA Requestor
  0x0014, // OTA Provider
  0x000e, // Aggregator (bridge)
  0x0013, // Bridged Node
  0x0019, // Secondary Network Interface
  0x050d, // Device Energy Management
]);

const byId = new Map(DEVICE_TYPE_CATALOG.map((entry) => [entry.id, entry]));

export function deviceType(id: number): DeviceTypeDescriptor | undefined {
  return byId.get(id);
}

/** Fallback for unknown device types — a generic on/off accessory. */
export const GENERIC_DESCRIPTOR: DeviceTypeDescriptor = d(0x0000, 'Matter Accessory', 'sensor', ['onOff']);

/**
 * Pick the best descriptor for an endpoint's DeviceTypeList: the known,
 * non-infrastructure type with the most capabilities. Mirrors the app's
 * lookup so both sides classify identically.
 */
export function descriptorFor(deviceTypeIds: number[]): DeviceTypeDescriptor {
  let best: DeviceTypeDescriptor | undefined;
  for (const id of deviceTypeIds) {
    if (INFRASTRUCTURE_TYPES.has(id)) continue;
    const candidate = byId.get(id);
    if (!candidate) continue;
    if (!best || candidate.capabilities.length > best.capabilities.length) {
      best = candidate;
    }
  }
  return best ?? GENERIC_DESCRIPTOR;
}

/**
 * Which Matter cluster has to be there for a capability to be more than a
 * claim.
 *
 * **A device type says what an endpoint *may* implement; the Descriptor
 * cluster's `ServerList` says what it *does*.** Matter is strict and
 * machine-readable about exactly this, and the catalog above is the looser of
 * the two — a Smart Plug's Electrical Power Measurement is optional, a contact
 * sensor may be mains-powered and carry no Power Source, a light may implement
 * only half of what its type allows. Taking the catalog as the answer meant
 * announcing capabilities the accessory had already told us it did not have,
 * and the apps drew a reading slot that could never fill: the Yandex plug this
 * was found on reports `electricalPower` and implements neither 0x0090 nor
 * 0x0091 (it carries Zigbee's own 0x0B04, which is not a Matter cluster at all
 * — matter.js's spec-generated model has no entry for it).
 *
 * Only the capabilities that *can* be wrong are listed. **A capability with no
 * entry here is kept**, because the destructive direction is dropping one: a
 * capability added to the catalog and forgotten here would silently vanish
 * from every device, which is a far worse failure than an over-claim.
 */
const CAPABILITY_CLUSTERS: Partial<Record<CapabilityKind, readonly number[]>> = {
  onOff: [0x0006],
  level: [0x0008],
  // One cluster for both, and that is right: a colour-temperature light and a
  // full-colour one are told apart by their *device type*, which the catalog
  // already does. This only asks whether ColorControl is there at all.
  color: [0x0300],
  colorTemperature: [0x0300],
  // Either generation counts. 0x0090/0x0091 are Matter 1.3's; a device with
  // neither reports no power, whatever its type suggests. (0x0091 also carries
  // cumulative energy, which the reducer folds into the same capability.)
  electricalPower: [0x0090, 0x0091],
  battery: [0x002f],
  temperature: [0x0402],
  humidity: [0x0405],
  illuminance: [0x0400],
  pressure: [0x0403],
  flow: [0x0404],
  occupancy: [0x0406],
  contact: [0x0045],
  // Generic Switch's whole purpose; an endpoint without it is not a button.
  event: [0x003b],
  doorLock: [0x0101],
  windowCovering: [0x0102],
  thermostat: [0x0201],
  fan: [0x0202],
  airQuality: [0x005b],
  pm25: [0x042a],
  co2: [0x040d],
  smokeCOAlarm: [0x005c],
  mediaPlayback: [0x0506],
  mode: [0x0050],
  rvcRun: [0x0061],
};

/**
 * Narrow a device type's capabilities to the ones this endpoint can actually
 * report.
 *
 * `clusterIds` is what the endpoint implements — in practice the clusters
 * matter.js built a client for, which is the honest test: a capability whose
 * cluster has no client is one nothing could ever populate.
 *
 * **`primary` is kept whatever happens.** It is the capability the apps lead
 * with and a device card has to have one; an endpoint whose primary cluster is
 * missing is a malformed endpoint, and inventing a different primary here
 * would hide that behind a card that looks fine and does nothing.
 */
export function restrictToClusters(
  descriptor: DeviceTypeDescriptor,
  clusterIds: Iterable<number>,
): DeviceTypeDescriptor {
  const present = new Set(clusterIds);
  const capabilities = descriptor.capabilities.filter((capability) => {
    if (capability === descriptor.primary) return true;
    const required = CAPABILITY_CLUSTERS[capability];
    if (required === undefined) return true;
    return required.some((cluster) => present.has(cluster));
  });
  return capabilities.length === descriptor.capabilities.length
    ? descriptor
    : { ...descriptor, capabilities };
}

/** True when every listed device type is infrastructure plumbing. */
export function isInfrastructureOnly(deviceTypeIds: number[]): boolean {
  return deviceTypeIds.length > 0 && deviceTypeIds.every((id) => INFRASTRUCTURE_TYPES.has(id));
}
