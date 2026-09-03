import type { ReadablePath } from './schema.js';

/**
 * Stored numbers, said out loud.
 *
 * The hub's canonical units are a compatibility contract with the apps — level
 * is 1–254, temperatures are centi-degrees, power is milliwatts, a covering's
 * 0 is *open* — and this is the one place a stored number turns back into what
 * a person means by it.
 *
 * **One place, because the alternative already cost something.** Without this
 * conversion an ordinary thermostat rule described itself as "the temperature
 * goes above 2500": wrong by two orders of magnitude and reading perfectly.
 * There are now two surfaces drawing a rule — the sentence
 * (`summarize.ts`) and the storyboard (`outline.ts`) — and a second copy of
 * this table is a second place for that mistake to come back, in one of the
 * two, where nobody would notice it disagreeing with the other.
 *
 * Deliberately English and deliberately plain, exactly as the sentence is: the
 * apps localise, the hub does not pretend to.
 */

const UNITS: Partial<Record<ReadablePath, { scale?: number; suffix: string }>> = {
  'sensors.temperatureCenti': { scale: 100, suffix: ' °C' },
  'sensors.humidityCenti': { scale: 100, suffix: '%' },
  'sensors.illuminanceLux': { suffix: ' lx' },
  'sensors.co2ppm': { suffix: ' ppm' },
  'sensors.pressureHPa': { suffix: ' hPa' },
  'sensors.pm25': { suffix: ' µg/m³' },
  'sensors.flowCubicMetersPerHour': { suffix: ' m³/h' },
  'battery.percent': { suffix: '%' },
  'power.activeMilliwatts': { scale: 1000, suffix: ' W' },
  'power.importedEnergyMilliwattHours': { scale: 1000, suffix: ' Wh' },
  'thermostat.localTemperatureCenti': { scale: 100, suffix: ' °C' },
  'thermostat.occupiedHeatingSetpointCenti': { scale: 100, suffix: ' °C' },
  'thermostat.occupiedCoolingSetpointCenti': { scale: 100, suffix: ' °C' },
  // **Closed, not open.** The stored value is Matter's own — 0 is fully open
  // and 10 000 fully closed — so 2500 is a blind a quarter of the way down.
  // Printed as "% open" it said the exact opposite of what the number means,
  // in the one sentence both apps put in front of a person.
  'covering.currentPositionLiftPercent100ths': { scale: 100, suffix: '% closed' },
  'fan.percentCurrent': { suffix: '%' },
};

/** One decimal at most, and none when the number is whole: 22.5 °C, not
 *  22.50 °C, and 25 °C rather than 25.0. */
export function scaled(raw: number, by: number): string {
  const converted = raw / by;
  return Number.isInteger(converted) ? String(converted) : converted.toFixed(1);
}

/** A stored reading in the units a person reads it in. */
export function formatValue(raw: number | boolean | undefined, path?: ReadablePath): string {
  if (raw === undefined) return '';
  if (typeof raw === 'boolean') return raw ? 'yes' : 'no';
  const unit = path !== undefined ? UNITS[path] : undefined;
  if (unit === undefined) return String(raw);
  return `${unit.scale ? scaled(raw, unit.scale) : String(raw)}${unit.suffix}`;
}

/** 0 = Sunday, matching the schema and `Date.prototype.getDay()`. */
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * The days themselves, because "on 5 chosen day(s)" is a placeholder rather
 * than a sentence — it tells somebody how many days their rule runs on and
 * not one of which they are, which is the whole question.
 */
export function formatDays(chosen: readonly number[]): string {
  const unique = [...new Set(chosen)].sort((a, b) => a - b);
  if (unique.length === 7) return 'every day';
  if (unique.length === 5 && unique.every((day) => day >= 1 && day <= 5)) return 'weekdays';
  if (unique.length === 2 && unique.includes(0) && unique.includes(6)) return 'weekends';
  const names = unique.map((day) => DAY_NAMES[day] ?? String(day));
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** A duration in the largest unit that stays whole, spelled out. Rules are
 *  written in minutes and hours far more often than in seconds. */
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60 || minutes % 60 !== 0) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = minutes / 60;
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}
