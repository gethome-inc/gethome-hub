import type { Z2mDevice, Z2mProfile } from '../adapters/zigbee/exposes-mapper.js';

/**
 * Prompt construction for AI device adaptation. The model sees the device's
 * published schema (Z2M exposes) plus recent state payloads and must emit a
 * MappingDescriptor (structured output constrained by its JSON schema).
 *
 * The descriptor OVERLAYS the static exposes mapping: the hub keeps running
 * its built-in rules and applies the descriptor's rules on top, so the model
 * is asked to map only what the static mapper left over.
 */

export const MAPPING_SYSTEM_PROMPT = `You adapt smart-home devices into the GetHome canonical device schema by \
emitting a MappingDescriptor JSON document. You receive a Zigbee2MQTT device definition ("exposes"), the properties \
the hub already handles, and sample MQTT payloads. Map the genuine device capabilities the hub does NOT already \
handle; ignore diagnostics (linkquality, voltage of the radio, firmware fields) and device settings (sensitivities, \
calibrations, indicator LEDs).

The canonical schema's capabilities and their state paths (with exact units):

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
- event → "event.action" (raw string), "event.button" (button id), "event.gesture" (single/double/hold/…) — \
stateless input events from buttons, remotes and gesture devices; use enumMap or identity on string enums
- irRemote → "irRemote.pendingCode" (string) for a non-standard IR blaster: map the "learned code" property here \
and declare commandRules {intent:"irLearn", property:<learn prop>, transform:{boolMap ON/OFF}} and \
{intent:"irSendRaw", property:<send prop>} (the send code passes through as the value)

For ANY genuine parameter that fits none of the typed capabilities above — device settings, vendor-specific \
knobs, unusual sensors — declare a **customField** instead of forcing a wrong mapping. Add "custom" to \
capabilities and one entry per parameter in "customFields": {id (the exact payload property), label, control \
("toggle"|"slider"|"select"|"value"), settable, and — per control — unit/min/max/step (slider), \
options:[{value,label}] (select), onValue/offValue (toggle, if the device uses non-boolean on/off). The hub reads \
the value straight from the payload property and writes it back via the property; you do NOT write stateRules for \
custom fields. Prefer a typed capability when one truly fits; use customField for everything else so the parameter \
is still controllable.

Transforms (stateRules run device→canonical; commandRules run canonical→device):
- {"kind":"identity"} — value passes through
- {"kind":"multiply","factor":N}
- {"kind":"scale","fromMin":A,"fromMax":B,"toMin":C,"toMax":D} — linear rescale, clamped
- {"kind":"celsiusToCenti"} — °C float → centi-degrees
- {"kind":"invertPercentTo100ths"} — 0-100 where 100=open → percent-100ths where 0=open (covers)
- {"kind":"boolMap","whenTrue":X,"whenFalse":Y} — boolean payload → values (state); boolean intent → values (command)
- {"kind":"enumMap","map":{"string":value}} — string payload → value (state); reversed automatically for commands

Command intents carry one scalar: power(on:boolean), setLevel(level), setColorTemperature(mireds), \
setHeatingSetpoint/setCoolingSetpoint(centi), setSystemMode/setFanMode/setMode(mode), lock(engage:boolean), \
setCoveringPercent(percent100ths), setFanPercent(percent), playPause(play:boolean). \
toggle/openCovering/closeCovering/stopCovering take constPayload only. Only include commandRules for properties the \
device documents as settable.

Example 1 — a dimmable device exposing "state" ("ON"/"OFF") and "dim_level" (0-1000, settable), neither handled yet:
{"version":1,"endpoints":[{"endpointId":1,"deviceKind":"light","capabilities":["onOff","level"],"primary":"onOff",
"stateRules":[
 {"property":"state","to":"onOff","transform":{"kind":"enumMap","map":{"ON":1,"OFF":0}}},
 {"property":"dim_level","to":"level.current","transform":{"kind":"scale","fromMin":0,"fromMax":1000,"toMin":1,"toMax":254}}],
"commandRules":[
 {"intent":"power","property":"state","transform":{"kind":"boolMap","whenTrue":"ON","whenFalse":"OFF"}},
 {"intent":"setLevel","property":"dim_level","transform":{"kind":"scale","fromMin":1,"fromMax":254,"toMin":0,"toMax":1000}}]}]}

Example 2 — a two-relay module exposing "state_l1"/"state_l2" becomes two endpoints (1 and 2), each with an onOff \
capability, its own stateRules on the suffixed property, and power commandRules.

Example 2b — a plug exposing a settable "power_mode" enum ("green"/"performance") and a read-only "temperature_probe" \
number (°C, unmapped by the hub) → declare "custom" and:
"customFields":[
 {"id":"power_mode","label":"Power mode","control":"select","settable":true,"options":[{"value":"green","label":"Green"},{"value":"performance","label":"Performance"}]},
 {"id":"temperature_probe","label":"Probe","control":"value","unit":"°C","settable":false}]

Example 3 — a presence sensor publishing an unhandled "presence_event" enum ("enter"/"leave"/"approach"):
{"version":1,"endpoints":[{"endpointId":1,"deviceKind":"sensor","capabilities":["event"],"primary":"event",
"stateRules":[
 {"property":"presence_event","to":"event.gesture","transform":{"kind":"identity"}},
 {"property":"presence_event","to":"event.action","transform":{"kind":"identity"}}]}]}

Rules of thumb: declare a capability only if you map at least one state rule for it; keep endpoint ids consistent \
with the hub's static endpoints when extending them (the whole device is endpoint 1); pick deviceKind from what the \
device physically is; be conservative — an unmapped extra is better than a wrong mapping.`;

export function buildMappingUserPrompt(
  device: Z2mDevice,
  staticProfile: Z2mProfile,
  samplePayloads: Record<string, unknown>[],
): string {
  const staticSummary = staticProfile.endpoints
    .filter((endpoint) => endpoint.capabilities.length > 0)
    .map(
      (endpoint) =>
        `endpoint ${endpoint.endpointId}${endpoint.label ? ` (${endpoint.label})` : ''}: ${endpoint.capabilities.join(', ')}`,
    );
  const fielded = staticProfile.unmapped.filter((property) => !staticProfile.uncovered.includes(property));
  const lines = [
    `Device: vendor=${device.definition?.vendor ?? 'unknown'} model=${device.definition?.model ?? 'unknown'}`,
    `description: ${device.definition?.description ?? 'n/a'}`,
    `Zigbee2MQTT supported: ${device.supported !== false}`,
    '',
    'Exposes definition:',
    JSON.stringify(device.definition?.exposes ?? [], null, 1),
    '',
    `Already handled statically (do NOT re-map, the hub keeps these): ${
      staticSummary.length > 0 ? staticSummary.join(', ') : 'nothing'
    }`,
    `Already generic custom fields (controllable; upgrade to a typed capability ONLY if one truly fits): ${
      fielded.length > 0 ? fielded.join(', ') : 'none'
    }`,
    `Uncovered — no representation yet, please handle these (typed capability or customField): ${
      staticProfile.uncovered.length > 0 ? staticProfile.uncovered.join(', ') : 'none'
    }`,
  ];
  if (samplePayloads.length > 0) {
    lines.push('', 'Recent state payloads (newest last):');
    for (const sample of samplePayloads.slice(-3)) {
      lines.push(JSON.stringify(sample));
    }
  }
  lines.push(
    '',
    'Emit the MappingDescriptor covering the unmapped properties (your rules run on top of the static mapping ' +
      'and win on conflicts).',
  );
  return lines.join('\n');
}
