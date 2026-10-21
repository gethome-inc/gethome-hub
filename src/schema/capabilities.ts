/**
 * The capabilities a device can be *declared* with — by an adapter's mapper,
 * an MQTT integration's discovery document, an AI mapping — and the ones a
 * stored document (a mapping, an automation) may name.
 *
 * These 27 identifiers (and their exact string values) are a compatibility
 * contract with the GetHome apps: every protocol adapter — Matter, Zigbee,
 * MQTT — translates its devices into these capabilities. Do not rename or
 * reorder without versioning the wire format. Adding a kind is additive-safe:
 * older apps drop capability strings they don't recognize.
 */
export const DECLARABLE_CAPABILITY_KINDS = [
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

/**
 * The whole canonical vocabulary: the 27 declarable kinds, then the kinds only
 * the hub itself assigns.
 *
 * **`camera` is derived, never declared.** An MQTT camera announces its streams
 * on `gethome/device/<id>/camera` and the hub adds the capability to that
 * endpoint (`src/adapters/mqtt/`). Kept out of the declarable list for two
 * reasons that are both the "older build" rule: a hub from before cameras
 * refuses a discovery document naming a capability it doesn't know — the
 * whole document — so a device that declared one would vanish from every hub
 * that hasn't updated; and a mapping or an automation that named it would be
 * unreadable by the build an update rolls back to.
 */
export const CAPABILITY_KINDS = [...DECLARABLE_CAPABILITY_KINDS, 'camera'] as const;

export type CapabilityKind = (typeof CAPABILITY_KINDS)[number];
export type DeclarableCapabilityKind = (typeof DECLARABLE_CAPABILITY_KINDS)[number];

export function isCapabilityKind(value: unknown): value is CapabilityKind {
  return typeof value === 'string' && (CAPABILITY_KINDS as readonly string[]).includes(value);
}
