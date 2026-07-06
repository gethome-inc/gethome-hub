import type { Z2mDevice, Z2mProfile } from '../adapters/zigbee/exposes-mapper.js';

/**
 * Prompt construction for AI device adaptation. The model sees the device's
 * published schema (Z2M exposes) plus sample payloads and must emit a
 * MappingDescriptor (structured output constrained by its JSON schema).
 */

export const MAPPING_SYSTEM_PROMPT = `You adapt smart-home devices into the GetHome canonical device schema by \
emitting a MappingDescriptor JSON document. You receive a Zigbee2MQTT device definition ("exposes") and sample MQTT \
payloads. Map every genuine device capability; ignore diagnostics (linkquality, voltage of the radio, firmware fields).

The canonical schema's 24 capabilities and their state paths (with exact units):

- onOff → "onOff" (boolean)
- level → "level.current" (1-254; 0 is invalid)
- colorTemperature → "colorTemperature.mireds" (mireds = 1e6/kelvin)
- color → "colorHS.hue" / "colorHS.saturation" (0-254 cluster units; hue° × 254/360, sat% × 254/100)
- thermostat → "thermostat.localTemperatureCenti", "thermostat.occupiedHeatingSetpointCenti",
  "thermostat.occupiedCoolingSetpointCenti" (centi-°C: 21.5°C = 2150), "thermostat.systemMode" (0 off, 1 auto, 3 cool, 4 heat)
- doorLock → "lock" (0 not fully locked, 1 locked, 2 unlocked)
- windowCovering → "covering.currentPositionLiftPercent100ths" (0 = fully OPEN, 10000 = fully CLOSED)
- fan → "fan.mode" (0 off, 1 low, 2 medium, 3 high, 4 on, 5 auto)
- temperature → "sensors.temperatureCenti" (centi-°C)
- humidity → "sensors.humidityCenti" (centi-%: 48.2% = 4820)
- occupancy → "sensors.occupied" (boolean) · contact → "sensors.contactClosed" (boolean, true = closed/no leak)
- illuminance → "sensors.illuminanceLux" (lux) · pressure → "sensors.pressureHPa" (hPa)
- flow → "sensors.flowCubicMetersPerHour" · airQuality → "sensors.airQuality" (0-6)
- pm25 → "sensors.pm25" (µg/m³) · co2 → "sensors.co2ppm" (ppm)
- smokeCOAlarm → "sensors.smokeAlarm" / "sensors.coAlarm" (0 normal, 1 warning, 2 critical)
- battery → "battery.percent" (0-100)
- electricalPower → "power.activeMilliwatts" (W × 1000), "power.importedEnergyMilliwattHours" (kWh × 1e6)
- mode → "currentMode" · rvcRun → "rvcOperationalState" · mediaPlayback → "playbackPlaying" (boolean)

Transforms (stateRules run device→canonical; commandRules run canonical→device):
- {"kind":"identity"} — value passes through
- {"kind":"multiply","factor":N}
- {"kind":"scale","fromMin":A,"fromMax":B,"toMin":C,"toMax":D} — linear rescale, clamped
- {"kind":"celsiusToCenti"} — °C float → centi-degrees
- {"kind":"invertPercentTo100ths"} — 0-100 where 100=open → percent-100ths where 0=open (covers)
- {"kind":"boolMap","whenTrue":X,"whenFalse":Y} — boolean payload → values (state); boolean intent → values (command)
- {"kind":"enumMap","map":{"string":number}} — string payload → number (state); reversed automatically for commands

Command intents carry one scalar: power(on:boolean), setLevel(level), setColorTemperature(mireds), \
setHeatingSetpoint/setCoolingSetpoint(centi), setSystemMode/setFanMode/setMode(mode), lock(engage:boolean), \
setCoveringPercent(percent100ths), setFanPercent(percent), playPause(play:boolean). \
toggle/openCovering/closeCovering/stopCovering take constPayload only. Only include commandRules for properties the \
device documents as settable.

Example 1 — a dimmable device exposing "state" ("ON"/"OFF") and "dim_level" (0-1000, settable):
{"version":1,"endpoints":[{"endpointId":1,"deviceKind":"light","capabilities":["onOff","level"],"primary":"onOff",
"stateRules":[
 {"property":"state","to":"onOff","transform":{"kind":"enumMap","map":{"ON":1,"OFF":0}}},
 {"property":"dim_level","to":"level.current","transform":{"kind":"scale","fromMin":0,"fromMax":1000,"toMin":1,"toMax":254}}],
"commandRules":[
 {"intent":"power","property":"state","transform":{"kind":"boolMap","whenTrue":"ON","whenFalse":"OFF"}},
 {"intent":"setLevel","property":"dim_level","transform":{"kind":"scale","fromMin":1,"fromMax":254,"toMin":0,"toMax":1000}}]}]}

Example 2 — a two-relay module exposing "state_l1"/"state_l2" becomes two endpoints (1 and 2), each with an onOff \
capability, its own stateRules on the suffixed property, and power commandRules.

Rules of thumb: declare a capability only if you map at least one state rule for it; pick deviceKind from what the \
device physically is; endpointId 1 for single-function devices; be conservative — an unmapped extra is better than a \
wrong mapping.`;

export function buildMappingUserPrompt(
  device: Z2mDevice,
  staticProfile: Z2mProfile,
  samplePayloads: Record<string, unknown>[],
): string {
  const lines = [
    `Device: vendor=${device.definition?.vendor ?? 'unknown'} model=${device.definition?.model ?? 'unknown'}`,
    `description: ${device.definition?.description ?? 'n/a'}`,
    `Zigbee2MQTT supported: ${device.supported !== false}`,
    '',
    'Exposes definition:',
    JSON.stringify(device.definition?.exposes ?? [], null, 1),
    '',
    `Properties the static mapper already handles (do NOT duplicate them): ${
      staticProfile.capabilities.length > 0 ? staticProfile.capabilities.join(', ') : 'none'
    }`,
    `Properties needing mapping: ${staticProfile.unmapped.length > 0 ? staticProfile.unmapped.join(', ') : 'all of them'}`,
  ];
  if (samplePayloads.length > 0) {
    lines.push('', 'Sample state payloads:');
    for (const sample of samplePayloads.slice(0, 3)) {
      lines.push(JSON.stringify(sample));
    }
  }
  lines.push(
    '',
    'Emit the complete MappingDescriptor for this device, covering BOTH the statically-handled and unmapped ' +
      'properties (the descriptor replaces the static mapping entirely).',
  );
  return lines.join('\n');
}
