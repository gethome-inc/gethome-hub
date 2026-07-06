/**
 * Unit conversions between raw protocol values and canonical units.
 * Ported 1:1 from the GetHome app's `MatterUnits` so both ends of the wire
 * round identically.
 */

export function kelvinFromMireds(mireds: number): number {
  if (mireds <= 0) return 0;
  return Math.round(1_000_000 / mireds);
}

export function miredsFromKelvin(kelvin: number): number {
  if (kelvin <= 0) return 0;
  return Math.round(1_000_000 / kelvin);
}

export function celsiusFromCenti(centi: number): number {
  return centi / 100;
}

export function centiFromCelsius(celsius: number): number {
  return Math.round(celsius * 100);
}

export function percentFromLevel(level: number, min = 1, max = 254): number {
  if (max <= min) return 0;
  return Math.round(((level - min) / (max - min)) * 100);
}

export function levelFromPercent(percent: number, min = 1, max = 254): number {
  const clamped = Math.max(0, Math.min(100, percent));
  return Math.floor(min + ((max - min) * clamped) / 100);
}

/** Illuminance Measurement cluster stores 10000 · log10(lux) + 1. */
export function luxFromMeasuredIlluminance(raw: number): number {
  if (raw <= 0) return 0;
  return Math.pow(10, (raw - 1) / 10_000);
}

export function measuredIlluminanceFromLux(lux: number): number {
  if (lux <= 0) return 0;
  return Math.round(10_000 * Math.log10(lux) + 1);
}

/** Power Source cluster reports battery in half-percents (0–200). */
export function percentFromHalfPercent(halfPercent: number): number {
  return Math.max(0, Math.min(100, Math.round(halfPercent / 2)));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Zigbee2MQTT cover position (0–100, 100 = open) ↔ canonical lift
 * percent-100ths (0 = open, 10000 = closed).
 */
export function percent100thsFromZ2mPosition(position: number): number {
  return Math.round((100 - clamp(position, 0, 100)) * 100);
}

export function z2mPositionFromPercent100ths(percent100ths: number): number {
  return Math.round(100 - clamp(percent100ths, 0, 10_000) / 100);
}

/** Cluster hue (0–254) ↔ degrees (0–360). */
export function hueFromDegrees(degrees: number): number {
  return clamp(Math.round((degrees * 254) / 360), 0, 254);
}

export function degreesFromHue(hue: number): number {
  return (clamp(hue, 0, 254) * 360) / 254;
}

/** Cluster saturation (0–254) ↔ percent (0–100). */
export function saturationFromPercent(percent: number): number {
  return clamp(Math.round((percent * 254) / 100), 0, 254);
}

export function percentFromSaturation(saturation: number): number {
  return (clamp(saturation, 0, 254) * 100) / 254;
}
