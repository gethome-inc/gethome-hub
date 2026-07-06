/**
 * Display kinds — what a device *is*, as far as the UI is concerned.
 * Mirrors the GetHome app's `DeviceKind`. String values are part of the wire.
 */
export const DEVICE_KINDS = [
  'light',
  'camera',
  'sensor',
  'climate',
  'lock',
  'outlet',
  'airPurifier',
  'shade',
  'speaker',
  'wallSwitch',
  'fan',
  'vacuum',
  'appliance',
  'energy',
  'tv',
] as const;

export type DeviceKind = (typeof DEVICE_KINDS)[number];

export function isDeviceKind(value: unknown): value is DeviceKind {
  return typeof value === 'string' && (DEVICE_KINDS as readonly string[]).includes(value);
}
