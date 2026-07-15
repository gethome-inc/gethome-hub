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

/** True when every listed device type is infrastructure plumbing. */
export function isInfrastructureOnly(deviceTypeIds: number[]): boolean {
  return deviceTypeIds.length > 0 && deviceTypeIds.every((id) => INFRASTRUCTURE_TYPES.has(id));
}
