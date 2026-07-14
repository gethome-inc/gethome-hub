import { z } from 'zod';
import { CAPABILITY_KINDS } from './capabilities.js';
import { DEVICE_KINDS } from './kinds.js';

/**
 * Zod schemas for the JSON wire format — the single validation layer for
 * everything that crosses a process boundary: API request bodies, MQTT
 * integration payloads, and AI-generated mappings. These schemas *are* the
 * documented contract (docs/device-schema.md).
 */

export const capabilityKindSchema = z.enum(CAPABILITY_KINDS);
export const deviceKindSchema = z.enum(DEVICE_KINDS);

const uint8 = z.number().int().min(0).max(255);
const uint16 = z.number().int().min(0).max(65_535);

export const endpointStateSchema = z
  .object({
    reachable: z.boolean(),
    onOff: z.boolean().optional(),
    level: z
      .object({
        current: z.number().int().min(1).max(254),
        min: uint8.default(1),
        max: uint8.default(254),
      })
      .optional(),
    colorTemperature: z
      .object({
        mireds: uint16,
        minMireds: uint16.default(153),
        maxMireds: uint16.default(500),
      })
      .optional(),
    colorHS: z
      .object({
        hue: z.number().int().min(0).max(254),
        saturation: z.number().int().min(0).max(254),
        colorModeIsHueSaturation: z.boolean().default(true),
      })
      .optional(),
    thermostat: z
      .object({
        localTemperatureCenti: z.number().int().optional(),
        occupiedHeatingSetpointCenti: z.number().int().optional(),
        occupiedCoolingSetpointCenti: z.number().int().optional(),
        heatSetpointMinCenti: z.number().int().default(700),
        heatSetpointMaxCenti: z.number().int().default(3000),
        coolSetpointMinCenti: z.number().int().default(1600),
        coolSetpointMaxCenti: z.number().int().default(3200),
        systemMode: uint8.default(0),
      })
      .optional(),
    lock: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
    covering: z
      .object({
        currentPositionLiftPercent100ths: z.number().int().min(0).max(10_000),
        targetPositionLiftPercent100ths: z.number().int().min(0).max(10_000).optional(),
        isMoving: z.boolean().default(false),
      })
      .optional(),
    fan: z
      .object({
        mode: z.number().int().min(0).max(5),
        percentCurrent: z.number().int().min(0).max(100).default(0),
        percentSetting: z.number().int().min(0).max(100).optional(),
      })
      .optional(),
    sensors: z
      .object({
        temperatureCenti: z.number().int().optional(),
        humidityCenti: z.number().int().min(0).max(10_000).optional(),
        illuminanceLux: z.number().min(0).optional(),
        pressureHPa: z.number().optional(),
        flowCubicMetersPerHour: z.number().min(0).optional(),
        occupied: z.boolean().optional(),
        contactClosed: z.boolean().optional(),
        airQuality: z.number().int().min(0).max(6).optional(),
        pm25: z.number().min(0).optional(),
        co2ppm: z.number().min(0).optional(),
        smokeAlarm: z.number().int().min(0).max(2).optional(),
        coAlarm: z.number().int().min(0).max(2).optional(),
      })
      .default({}),
    battery: z.object({ percent: z.number().int().min(0).max(100) }).optional(),
    power: z
      .object({
        activeMilliwatts: z.number().int().optional(),
        importedEnergyMilliwattHours: z.number().int().min(0).optional(),
      })
      .optional(),
    playbackPlaying: z.boolean().optional(),
    event: z
      .object({
        buttons: z
          .array(
            z
              .object({
                id: z.string().min(1).max(60),
                label: z.string().min(1).max(60),
                gestures: z.array(z.string().min(1).max(60)).max(24),
              })
              .strict(),
          )
          .max(32)
          .optional(),
        action: z.string().max(120).optional(),
        button: z.string().max(60).optional(),
        gesture: z.string().max(60).optional(),
        /** Epoch milliseconds. */
        at: z.number().optional(),
      })
      .strict()
      .optional(),
    currentMode: uint8.optional(),
    rvcOperationalState: uint8.optional(),
  })
  .strict();

/** A partial state patch, as adapters emit and MQTT integrations publish. */
export const statePatchSchema = endpointStateSchema.partial();

export const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('power'), on: z.boolean() }).strict(),
  z.object({ type: z.literal('toggle') }).strict(),
  z
    .object({
      type: z.literal('setLevel'),
      level: z.number().int().min(1).max(254),
      transitionDs: uint16.optional(),
    })
    .strict(),
  z.object({ type: z.literal('setColorTemperature'), mireds: uint16 }).strict(),
  z
    .object({
      type: z.literal('setHueSaturation'),
      hue: z.number().int().min(0).max(254),
      saturation: z.number().int().min(0).max(254),
    })
    .strict(),
  z.object({ type: z.literal('setHeatingSetpoint'), centi: z.number().int() }).strict(),
  z.object({ type: z.literal('setCoolingSetpoint'), centi: z.number().int() }).strict(),
  z.object({ type: z.literal('setSystemMode'), mode: uint8 }).strict(),
  z.object({ type: z.literal('lock'), engage: z.boolean() }).strict(),
  z
    .object({
      type: z.literal('setCoveringPercent'),
      percent100ths: z.number().int().min(0).max(10_000),
    })
    .strict(),
  z.object({ type: z.literal('openCovering') }).strict(),
  z.object({ type: z.literal('closeCovering') }).strict(),
  z.object({ type: z.literal('stopCovering') }).strict(),
  z
    .object({ type: z.literal('setFanPercent'), percent: z.number().int().min(0).max(100) })
    .strict(),
  z.object({ type: z.literal('setFanMode'), mode: z.number().int().min(0).max(5) }).strict(),
  z.object({ type: z.literal('playPause'), play: z.boolean() }).strict(),
  z.object({ type: z.literal('setMode'), mode: uint8 }).strict(),
]);

/** Endpoint descriptor as declared by MQTT integrations and served by the API. */
export const endpointDescriptorSchema = z
  .object({
    endpointId: z.number().int().min(0),
    deviceKind: deviceKindSchema,
    capabilities: z.array(capabilityKindSchema).min(1),
    primary: capabilityKindSchema,
  })
  .strict();

/** MQTT integration discovery document (gethome/discovery/<deviceId>/config). */
export const mqttDiscoverySchema = z
  .object({
    name: z.string().min(1).max(120),
    vendor: z.string().max(120).optional(),
    model: z.string().max(120).optional(),
    endpoints: z.array(endpointDescriptorSchema).min(1),
  })
  .strict();

export type WireEndpointState = z.infer<typeof endpointStateSchema>;
export type WireStatePatch = z.infer<typeof statePatchSchema>;
export type WireCommand = z.infer<typeof commandSchema>;
export type MqttDiscoveryConfig = z.infer<typeof mqttDiscoverySchema>;
