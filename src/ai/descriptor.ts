import { z } from 'zod';
import {
  CAPABILITY_KINDS,
  DEVICE_KINDS,
  clamp,
  type CapabilityKind,
  type EndpointState,
  type HubCommand,
} from '../schema/index.js';

/**
 * MappingDescriptor — the declarative DSL an AI model emits to adapt an
 * unknown device into the canonical schema. Deliberately data-only: rules and
 * transforms are interpreted, never executed as code, and everything is
 * validated with zod before use.
 *
 * State rules run device → canonical (payload property to state path);
 * command rules run canonical → device (intent value to payload key), with
 * the transform expressed in that direction.
 */

export const transformSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('identity') }).strict(),
  z
    .object({
      kind: z.literal('scale'),
      fromMin: z.number(),
      fromMax: z.number(),
      toMin: z.number(),
      toMax: z.number(),
    })
    .strict(),
  z.object({ kind: z.literal('multiply'), factor: z.number() }).strict(),
  z.object({ kind: z.literal('celsiusToCenti') }).strict(),
  z.object({ kind: z.literal('invertPercentTo100ths') }).strict(),
  // whenTrue/whenFalse and enumMap values may be strings for the command
  // direction (canonical boolean/number → device string like "ON"). String
  // outputs are ignored in the state direction, where paths are typed.
  z
    .object({
      kind: z.literal('boolMap'),
      whenTrue: z.union([z.number(), z.boolean(), z.string()]),
      whenFalse: z.union([z.number(), z.boolean(), z.string()]),
    })
    .strict(),
  z
    .object({
      kind: z.literal('enumMap'),
      map: z.record(z.string(), z.union([z.number(), z.boolean(), z.string()])),
    })
    .strict(),
]);

export type Transform = z.infer<typeof transformSchema>;

/** Canonical state paths a rule may write, with integer-rounding flags. */
export const STATE_PATHS = {
  onOff: { boolean: true },
  'level.current': { integer: true },
  'colorTemperature.mireds': { integer: true },
  'colorHS.hue': { integer: true },
  'colorHS.saturation': { integer: true },
  'thermostat.localTemperatureCenti': { integer: true },
  'thermostat.occupiedHeatingSetpointCenti': { integer: true },
  'thermostat.occupiedCoolingSetpointCenti': { integer: true },
  'thermostat.systemMode': { integer: true },
  lock: { integer: true },
  'covering.currentPositionLiftPercent100ths': { integer: true },
  'fan.mode': { integer: true },
  'sensors.temperatureCenti': { integer: true },
  'sensors.humidityCenti': { integer: true },
  'sensors.illuminanceLux': {},
  'sensors.pressureHPa': {},
  'sensors.flowCubicMetersPerHour': {},
  'sensors.occupied': { boolean: true },
  'sensors.contactClosed': { boolean: true },
  'sensors.airQuality': { integer: true },
  'sensors.pm25': {},
  'sensors.co2ppm': {},
  'sensors.smokeAlarm': { integer: true },
  'sensors.coAlarm': { integer: true },
  'battery.percent': { integer: true },
  'power.activeMilliwatts': { integer: true },
  'power.importedEnergyMilliwattHours': { integer: true },
  playbackPlaying: { boolean: true },
  currentMode: { integer: true },
  rvcOperationalState: { integer: true },
} as const;

export type StatePath = keyof typeof STATE_PATHS;

const statePathSchema = z.enum(Object.keys(STATE_PATHS) as [StatePath, ...StatePath[]]);

export const stateRuleSchema = z
  .object({
    /** Payload key; dotted for nested values (e.g. "color.hue"). */
    property: z.string().min(1),
    to: statePathSchema,
    transform: transformSchema.optional(),
  })
  .strict();

const commandIntentSchema = z.enum([
  'power',
  'toggle',
  'setLevel',
  'setColorTemperature',
  'setHeatingSetpoint',
  'setCoolingSetpoint',
  'setSystemMode',
  'lock',
  'setCoveringPercent',
  'openCovering',
  'closeCovering',
  'stopCovering',
  'setFanPercent',
  'setFanMode',
  'playPause',
  'setMode',
]);

export const commandRuleSchema = z
  .object({
    intent: commandIntentSchema,
    /** Payload key to write the (transformed) intent value to. */
    property: z.string().min(1).optional(),
    transform: transformSchema.optional(),
    /** Fixed payload fields merged in (e.g. {"state": "OPEN"}). */
    constPayload: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine((rule) => rule.property !== undefined || rule.constPayload !== undefined, {
    message: 'a command rule needs a property, a constPayload, or both',
  });

export const endpointMappingSchema = z
  .object({
    endpointId: z.number().int().min(0),
    deviceKind: z.enum(DEVICE_KINDS),
    capabilities: z.array(z.enum(CAPABILITY_KINDS)).min(1),
    primary: z.enum(CAPABILITY_KINDS),
    stateRules: z.array(stateRuleSchema),
    commandRules: z.array(commandRuleSchema).default([]),
  })
  .strict();

export const mappingDescriptorSchema = z
  .object({
    version: z.literal(1),
    endpoints: z.array(endpointMappingSchema).min(1),
  })
  .strict();

export type MappingDescriptor = z.infer<typeof mappingDescriptorSchema>;
export type EndpointMapping = z.infer<typeof endpointMappingSchema>;

// ── Sanity checks beyond structural validation ──────────────────────────────

const PATH_CAPABILITY: Record<StatePath, CapabilityKind> = {
  onOff: 'onOff',
  'level.current': 'level',
  'colorTemperature.mireds': 'colorTemperature',
  'colorHS.hue': 'color',
  'colorHS.saturation': 'color',
  'thermostat.localTemperatureCenti': 'thermostat',
  'thermostat.occupiedHeatingSetpointCenti': 'thermostat',
  'thermostat.occupiedCoolingSetpointCenti': 'thermostat',
  'thermostat.systemMode': 'thermostat',
  lock: 'doorLock',
  'covering.currentPositionLiftPercent100ths': 'windowCovering',
  'fan.mode': 'fan',
  'sensors.temperatureCenti': 'temperature',
  'sensors.humidityCenti': 'humidity',
  'sensors.illuminanceLux': 'illuminance',
  'sensors.pressureHPa': 'pressure',
  'sensors.flowCubicMetersPerHour': 'flow',
  'sensors.occupied': 'occupancy',
  'sensors.contactClosed': 'contact',
  'sensors.airQuality': 'airQuality',
  'sensors.pm25': 'pm25',
  'sensors.co2ppm': 'co2',
  'sensors.smokeAlarm': 'smokeCOAlarm',
  'sensors.coAlarm': 'smokeCOAlarm',
  'battery.percent': 'battery',
  'power.activeMilliwatts': 'electricalPower',
  'power.importedEnergyMilliwattHours': 'electricalPower',
  playbackPlaying: 'mediaPlayback',
  currentMode: 'mode',
  rvcOperationalState: 'rvcRun',
};

/** Returns problems (empty = sane). Run after zod validation. */
export function sanityCheckDescriptor(descriptor: MappingDescriptor): string[] {
  const problems: string[] = [];
  const ids = new Set<number>();
  for (const endpoint of descriptor.endpoints) {
    if (ids.has(endpoint.endpointId)) {
      problems.push(`duplicate endpointId ${endpoint.endpointId}`);
    }
    ids.add(endpoint.endpointId);
    if (!endpoint.capabilities.includes(endpoint.primary)) {
      problems.push(`endpoint ${endpoint.endpointId}: primary not in capabilities`);
    }
    for (const rule of endpoint.stateRules) {
      const capability = PATH_CAPABILITY[rule.to];
      if (!endpoint.capabilities.includes(capability)) {
        problems.push(
          `endpoint ${endpoint.endpointId}: state rule for "${rule.to}" but capability "${capability}" not declared`,
        );
      }
    }
  }
  return problems;
}

// ── Interpreter ─────────────────────────────────────────────────────────────

function applyTransform(transform: Transform | undefined, value: unknown): unknown {
  if (!transform || transform.kind === 'identity') return value;
  switch (transform.kind) {
    case 'scale': {
      const parsed = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(parsed) || transform.fromMax === transform.fromMin) return undefined;
      const fraction = (parsed - transform.fromMin) / (transform.fromMax - transform.fromMin);
      return transform.toMin + clamp(fraction, 0, 1) * (transform.toMax - transform.toMin);
    }
    case 'multiply': {
      const parsed = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(parsed) ? parsed * transform.factor : undefined;
    }
    case 'celsiusToCenti': {
      const parsed = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(parsed) ? Math.round(parsed * 100) : undefined;
    }
    case 'invertPercentTo100ths': {
      const parsed = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(parsed) ? Math.round((100 - clamp(parsed, 0, 100)) * 100) : undefined;
    }
    case 'boolMap':
      if (typeof value !== 'boolean') return undefined;
      return value ? transform.whenTrue : transform.whenFalse;
    case 'enumMap':
      return typeof value === 'string' ? transform.map[value] : undefined;
  }
}

function readPath(payload: Record<string, unknown>, property: string): unknown {
  let current: unknown = payload;
  for (const segment of property.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function writeStatePath(patch: Record<string, unknown>, path: StatePath, value: unknown): void {
  const spec = STATE_PATHS[path] as { integer?: boolean; boolean?: boolean };
  let coerced = value;
  if (spec.boolean) {
    if (typeof coerced === 'number') coerced = coerced !== 0;
    if (typeof coerced !== 'boolean') return;
  } else {
    if (typeof coerced === 'boolean') coerced = coerced ? 1 : 0;
    if (typeof coerced !== 'number' || !Number.isFinite(coerced)) return;
    if (spec.integer) coerced = Math.round(coerced);
  }

  const segments = path.split('.');
  if (segments.length === 1) {
    patch[path] = coerced;
    return;
  }
  const [head, tail] = segments as [string, string];
  const container = (patch[head] ??= defaultContainer(head)) as Record<string, unknown>;
  container[tail] = coerced;
}

/** Structural defaults so partially-written sub-objects stay wire-valid. */
function defaultContainer(head: string): Record<string, unknown> {
  switch (head) {
    case 'level':
      return { current: 1, min: 1, max: 254 };
    case 'colorTemperature':
      return { mireds: 300, minMireds: 153, maxMireds: 500 };
    case 'colorHS':
      return { hue: 0, saturation: 0, colorModeIsHueSaturation: true };
    case 'thermostat':
      return {
        heatSetpointMinCenti: 700,
        heatSetpointMaxCenti: 3000,
        coolSetpointMinCenti: 1600,
        coolSetpointMaxCenti: 3200,
        systemMode: 0,
      };
    case 'covering':
      return { currentPositionLiftPercent100ths: 0, isMoving: false };
    case 'fan':
      return { mode: 0, percentCurrent: 0 };
    case 'battery':
      return { percent: 0 };
    default:
      return {};
  }
}

/** Extract canonical state patches (per endpoint) from a device payload. */
export function applyStateRules(
  descriptor: MappingDescriptor,
  payload: Record<string, unknown>,
): Map<number, Partial<EndpointState>> {
  const result = new Map<number, Partial<EndpointState>>();
  for (const endpoint of descriptor.endpoints) {
    const patch: Record<string, unknown> = {};
    for (const rule of endpoint.stateRules) {
      const raw = readPath(payload, rule.property);
      if (raw === undefined || raw === null) continue;
      const transformed = applyTransform(rule.transform, raw);
      if (transformed === undefined) continue;
      writeStatePath(patch, rule.to, transformed);
    }
    result.set(endpoint.endpointId, patch as Partial<EndpointState>);
  }
  return result;
}

/** The scalar an intent carries, fed through the command rule's transform. */
function intentValue(command: HubCommand): unknown {
  switch (command.type) {
    case 'power':
      return command.on;
    case 'setLevel':
      return command.level;
    case 'setColorTemperature':
      return command.mireds;
    case 'setHeatingSetpoint':
    case 'setCoolingSetpoint':
      return command.centi;
    case 'setSystemMode':
    case 'setFanMode':
    case 'setMode':
      return command.mode;
    case 'lock':
      return command.engage;
    case 'setCoveringPercent':
      return command.percent100ths;
    case 'setFanPercent':
      return command.percent;
    case 'playPause':
      return command.play;
    default:
      return undefined; // toggle, open/close/stopCovering: constPayload-only
  }
}

/**
 * Build the device payload for an intent, or null when the descriptor has no
 * rule for it (callers fall back to static translation or reject).
 * `boolMap`/`enumMap` here run canonical → device: for boolMap the intent's
 * boolean picks whenTrue/whenFalse; for enumMap the intent's numeric value is
 * looked up by reverse mapping.
 */
export function buildCommandPayload(
  descriptor: MappingDescriptor,
  endpointId: number,
  command: HubCommand,
): Record<string, unknown> | null {
  const endpoint = descriptor.endpoints.find((candidate) => candidate.endpointId === endpointId);
  const rule = endpoint?.commandRules.find((candidate) => candidate.intent === command.type);
  if (!rule) return null;

  const payload: Record<string, unknown> = { ...(rule.constPayload ?? {}) };
  if (rule.property !== undefined) {
    const value = intentValue(command);
    if (value !== undefined) {
      let transformed: unknown;
      if (rule.transform?.kind === 'boolMap' && typeof value === 'boolean') {
        transformed = value ? rule.transform.whenTrue : rule.transform.whenFalse;
      } else if (rule.transform?.kind === 'enumMap' && typeof value === 'number') {
        transformed = Object.entries(rule.transform.map).find(([, code]) => code === value)?.[0];
      } else {
        transformed = applyTransform(rule.transform, value);
      }
      if (transformed !== undefined) payload[rule.property] = transformed;
    }
  }
  return Object.keys(payload).length > 0 ? payload : null;
}
