import type { Z2mDevice, Z2mProfile } from '../adapters/zigbee/exposes-mapper.js';

/**
 * Prompt construction for AI device adaptation. The mapping agent sees the
 * device's published schema (Z2M exposes), recent state payloads, and what
 * the static mapper already produced — all of it in the task message — may
 * research the device on the web, and finishes by calling the
 * `submit_mapping` tool with a MappingDescriptor (validated in the tool;
 * errors come back for a retry).
 *
 * This message *is* the research material. The agent used to receive it as
 * files in a throwaway working directory it read with Read/Glob/Grep; with
 * the Messages API there are no file tools, so the same content is inlined
 * here. Nothing was dropped in the move except `schema-reference.md`, which
 * became redundant: the descriptor schema is now the `submit_mapping` tool's
 * own `input_schema`, and the whitelisted state paths are a zod enum inside
 * it, so the API hands the model both.
 *
 * The descriptor OVERLAYS the static exposes mapping: the hub keeps running
 * its built-in rules and applies the descriptor's rules on top, so the agent
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
device physically is; be conservative — an unmapped extra is better than a wrong mapping.

How you work:
- Everything the hub knows about this device is in your task message: vendor/model/description, the complete \
exposes tree, recent raw payloads, and exactly what the hub's static mapper already produced. Start there — most \
devices are fully mappable from the exposes tree alone.
- Research the device when, and only when, the exposes and payloads leave something genuinely ambiguous: an \
undocumented enum, a unit you cannot infer, a property whose direction or scale is unclear, vendor-specific \
behavior. Guessing a unit is the single most damaging thing you can do here, because the mapping is cached and \
silently shapes what the apps show for every device of this model.
- Start at the device's own Zigbee2MQTT page. Your task message carries its URL, so web_fetch that first. **That \
page is the source of truth for this job**, not a third-party opinion: it is generated from the same \
zigbee-herdsman-converters definition that produces the payloads this hub receives, so its exposes, units, value \
ranges and enum values are exactly what the device will publish and accept. If it loads, is the device you were \
given, and covers the properties you need — you are done researching. Write the descriptor and submit. Do not \
spend searches confirming what it has already told you.
- Search further only when that page genuinely fails you, which it does in three ways: the URL 404s (the hub \
derives it from the model string, and the real page may be named differently), it is a page for a different \
device, or it loads but says nothing about the property you are stuck on. Any of those, and you keep going — one \
guessed URL is not a reason to give up on the device. Escalate: web_search for "<vendor> <model> zigbee2mqtt", \
then the model on its own, then the specific property or enum value. Best references after that page are the \
zigbee-herdsman-converters definition for the device (it names the exact converters, units and ranges), the \
vendor's own datasheet or manual, and Home Assistant or ZHA discussions of the same model.
- Say so rather than guess. If nothing settles a property, leave it out of the descriptor or give it a \
customField, which stays controllable and honest, instead of inventing a unit or an enum.
- Keep every query about this device: its vendor, model and property names. Nothing else from this hub belongs in \
a search.
- Finish by calling submit_mapping with the complete MappingDescriptor. Prose is not an answer — a run that ends \
without a submission produced nothing. If submit_mapping returns errors, fix the descriptor and call it again; a \
successful submission ends your task.
- Map this device, and stop there. Don't propose changes to the hub, to the canonical schema, or to how other \
devices are handled.

What you are given is always one physical device's published schema: its exposes tree and its own recent reports. \
It is never the hub's own traffic — never a bridge message, a permit-join request, a broker log line, a status \
document or a command the hub sent. If what you were handed does not describe a physical device with parameters to \
map, do not invent a mapping for it: say so in your reply and submit nothing. A descriptor about something that is \
not a device would be cached against a model that does not exist.`;

/**
 * The device's page on zigbee2mqtt.io, if we can name it.
 *
 * Those pages are generated per device with the **model** string as the
 * filename (docgen writes `docs/devices/<model>.md`), so the hub can point
 * straight at the page instead of spending a search on finding it. Two
 * reasons that is worth doing: the server-side `web_fetch` tool will only
 * fetch URLs that already appear in the conversation, so an unmentioned page
 * is unreachable however well the agent guesses; and a fetch that hits is a
 * search request not spent.
 *
 * It is a *candidate*: model strings with slashes or spaces don't always
 * survive into the filename, so the prompt tells the agent to fall back to a
 * search when it 404s.
 */
export function zigbee2mqttDevicePage(model: string | null | undefined): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (trimmed.length === 0) return null;
  return `https://www.zigbee2mqtt.io/devices/${encodeURIComponent(trimmed)}.html`;
}

/** How many recent payloads to include. Enough to show a property changing
 *  and to catch values the exposes tree understates; bounded because every
 *  one of them is input tokens on every turn of the run. */
const MAX_SAMPLES = 5;

/** How much of a rejected descriptor is worth handing back. Large enough for a
 *  real multi-endpoint document, small enough that a runaway one can't fill a
 *  turn with something that was invalid anyway. */
const MAX_BROKEN_DESCRIPTOR_CHARS = 20_000;

/**
 * Ask the agent to fix a descriptor the hub refused.
 *
 * The case this exists for is a person uploading a mapping they wrote, or
 * copied from a device one firmware revision away: nearly right, and rejected
 * on a detail they cannot read out of a zod issue path. Handing the document
 * *and the exact complaints* back is far cheaper than a fresh run — the
 * research is already in the file — and it is what turns "rejected" from a
 * dead end into a step.
 *
 * The same system prompt and the same `submit_mapping` tool: this differs from
 * a first mapping only in what the task message says, so a rule added to one
 * cannot go missing from the other.
 */
export function buildRepairUserPrompt(
  device: Z2mDevice,
  staticProfile: Z2mProfile,
  broken: unknown,
  problems: string[],
): string {
  const vendor = device.definition?.vendor ?? 'unknown';
  const model = device.definition?.model ?? 'unknown';
  const document = JSON.stringify(broken, null, 1).slice(0, MAX_BROKEN_DESCRIPTOR_CHARS);
  return [
    buildMappingUserPrompt(device, staticProfile, []),
    '',
    '# A MappingDescriptor for this device that the hub refused',
    'Somebody supplied this. Treat it as a draft worth saving, not as a starting point to discard: it may carry ' +
      'knowledge of the device that the exposes tree does not. Keep everything in it that is right.',
    document,
    '',
    '# Why the hub refused it',
    ...problems.map((problem) => `- ${problem}`),
    '',
    '# Your task',
    `Fix the descriptor above so it passes, and submit the corrected document for ${vendor} ${model} with the ` +
      'submit_mapping tool. Change what the complaints name and what is genuinely wrong beside it; do not rewrite ' +
      'the parts that were already correct. If a rule cannot be repaired because it maps a property that does not ' +
      'exist on this device, drop that rule rather than inventing a property to justify it.',
  ].join('\n');
}

export function buildMappingUserPrompt(
  device: Z2mDevice,
  staticProfile: Z2mProfile,
  samplePayloads: Record<string, unknown>[],
): string {
  const vendor = device.definition?.vendor ?? 'unknown';
  const model = device.definition?.model ?? 'unknown';
  const fielded = staticProfile.unmapped.filter((property) => !staticProfile.uncovered.includes(property));
  const devicePage = zigbee2mqttDevicePage(device.definition?.model);

  const lines = [
    '# Device',
    `vendor: ${vendor}`,
    `model: ${model}`,
    `description: ${device.definition?.description ?? 'n/a'}`,
    `supported by Zigbee2MQTT: ${device.supported !== false}`,
  ];
  if (devicePage) {
    lines.push(
      `Zigbee2MQTT page (likely — derived from the model string, may 404): ${devicePage}`,
      'zigbee-herdsman-converters source (the definitions those pages are generated from): ' +
        'https://github.com/Koenkk/zigbee-herdsman-converters',
    );
  }

  lines.push(
    '',
    '# Exposes definition (the device\'s full published schema)',
    JSON.stringify(device.definition?.exposes ?? [], null, 1),
    '',
    '# What the hub already mapped statically',
    'Your rules overlay this: the hub keeps running these and applies yours on top, so map only what is left.',
    JSON.stringify(
      {
        endpoints: staticProfile.endpoints.map((endpoint) => ({
          endpointId: endpoint.endpointId,
          ...(endpoint.label !== undefined ? { label: endpoint.label } : {}),
          kind: endpoint.kind,
          capabilities: endpoint.capabilities,
          primary: endpoint.primary,
          ...(endpoint.customFields !== undefined ? { customFields: endpoint.customFields } : {}),
        })),
        genericCustomFields: fielded,
        uncovered: staticProfile.uncovered,
        unmapped: staticProfile.unmapped,
      },
      null,
      1,
    ),
    '',
    '- `genericCustomFields` are already controllable as generic fields. Upgrade one to a typed capability only ' +
      'when a capability genuinely fits it; leaving it as a field is not a failure.',
    '- `uncovered` properties have no representation at all. These are the ones that need you: give each a typed ' +
      'capability, or a customField when none fits.',
  );

  if (samplePayloads.length > 0) {
    lines.push('', '# Recent state payloads (newest last)');
    for (const sample of samplePayloads.slice(-MAX_SAMPLES)) {
      lines.push(JSON.stringify(sample));
    }
  }

  lines.push(
    '',
    '# Your task',
    `Produce the MappingDescriptor for ${vendor} ${model}, covering the properties above that the hub does not ` +
      'already handle, and submit it with the submit_mapping tool. Where the exposes tree and the payloads do not ' +
      'settle a unit, an enum or a direction, look the device up before deciding.',
  );
  return lines.join('\n');
}
