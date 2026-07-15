/**
 * The canonical capability vocabulary of the GetHome ecosystem.
 *
 * These 27 identifiers (and their exact string values) are a compatibility
 * contract with the GetHome apps: every protocol adapter — Matter, Zigbee,
 * MQTT — translates its devices into these capabilities. Do not rename or
 * reorder without versioning the wire format. Adding a kind is additive-safe:
 * older apps drop capability strings they don't recognize.
 */
export const CAPABILITY_KINDS = [
  'onOff',
  'level',
  'colorTemperature',
  'color',
  'thermostat',
  'fan',
  'doorLock',
  'windowCovering',
  'temperature',
  'humidity',
  'occupancy',
  'contact',
  'illuminance',
  'pressure',
  'flow',
  'airQuality',
  'pm25',
  'co2',
  'smokeCOAlarm',
  'battery',
  'electricalPower',
  'mode',
  'rvcRun',
  'mediaPlayback',
  'event',
  'irRemote',
  'custom',
] as const;

export type CapabilityKind = (typeof CAPABILITY_KINDS)[number];

export function isCapabilityKind(value: unknown): value is CapabilityKind {
  return typeof value === 'string' && (CAPABILITY_KINDS as readonly string[]).includes(value);
}
