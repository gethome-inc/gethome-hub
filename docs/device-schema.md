# The canonical device schema

This document is the contract between the hub and every GetHome client. The
implementation lives in `src/schema/` (dependency-free; zod schemas in
`src/schema/wire.ts` *are* the normative wire format). The schema deliberately
mirrors the Matter data model — Matter devices map 1:1, and Zigbee/MQTT
devices are translated into the same vocabulary.

**Do not change field names or units without versioning the API.**

## Devices, endpoints, capabilities

A **device** (one physical thing) has one or more **endpoints** (functional
units — a 2-relay module has two). Each endpoint has:

- `deviceKind` — what it is, for display: `light, camera, sensor, climate,
  lock, outlet, airPurifier, shade, speaker, wallSwitch, fan, vacuum,
  appliance, energy, tv, remote`
- `capabilities` — what it can do (subset of the 27 below)
- `primaryCapability` — the headline capability
- `state` — the typed state object below

## The 27 capabilities and their units

| Capability | State location | Unit / range |
|---|---|---|
| `onOff` | `onOff` | boolean |
| `level` | `level.current/min/max` | 1–254 (0 invalid) |
| `colorTemperature` | `colorTemperature.mireds/minMireds/maxMireds` | mireds = 1e6/K (153 ≈ 6500 K, 500 ≈ 2000 K) |
| `color` | `colorHS.hue/saturation` | 0–254 cluster units (hue° × 254/360) |
| `thermostat` | `thermostat.*Centi`, `systemMode` | centi-°C (2150 = 21.5 °C); mode 0 off / 1 auto / 3 cool / 4 heat; limits as 4 scalars `heatSetpointMinCenti`, `heatSetpointMaxCenti`, `coolSetpointMinCenti`, `coolSetpointMaxCenti` |
| `fan` | `fan.mode/percentCurrent/percentSetting` | mode 0 off / 1 low / 2 medium / 3 high / 4 on / 5 auto; percent 0–100 |
| `doorLock` | `lock` | 0 not fully locked / 1 locked / 2 unlocked |
| `windowCovering` | `covering.currentPositionLiftPercent100ths` (+ `target…`, `isMoving`) | **0 = fully OPEN, 10000 = fully CLOSED** |
| `temperature` | `sensors.temperatureCenti` | centi-°C |
| `humidity` | `sensors.humidityCenti` | centi-% RH (0–10000) |
| `occupancy` | `sensors.occupied` | boolean |
| `contact` | `sensors.contactClosed` | boolean (true = closed / no leak) |
| `illuminance` | `sensors.illuminanceLux` | lux |
| `pressure` | `sensors.pressureHPa` | hPa |
| `flow` | `sensors.flowCubicMetersPerHour` | m³/h |
| `airQuality` | `sensors.airQuality` | 0 unknown … 6 extremely poor |
| `pm25` | `sensors.pm25` | µg/m³ |
| `co2` | `sensors.co2ppm` | ppm |
| `smokeCOAlarm` | `sensors.smokeAlarm` / `sensors.coAlarm` | 0 normal / 1 warning / 2 critical |
| `battery` | `battery.percent` | 0–100 |
| `electricalPower` | `power.activeMilliwatts`, `power.importedEnergyMilliwattHours` | mW / mWh |
| `mode` | `currentMode` | device-defined uint8 |
| `rvcRun` | `rvcOperationalState` | 0 stopped, 1 running, 2 paused, 3 error, 0x40 seeking, 0x41 charging, 0x42 docked |
| `mediaPlayback` | `playbackPlaying` | boolean |
| `event` | `event.*` (below) | stateless input events — buttons, remotes, cubes |
| `irRemote` | `irRemote.*` (below) | IR blaster / universal remote — learn + replay a library of codes |
| `custom` | `custom.*` (below) | the universal fallback — declared generic controls for any parameter that fits no capability above |

Plus `reachable: boolean` on every state.

### The `event` capability

Input devices (Aqara buttons/remotes/cubes, Matter Generic Switches) don't
hold state — they *emit*. `event` carries two things:

```json
{
  "event": {
    "buttons": [{ "id": "left", "label": "Left", "gestures": ["single", "double", "hold"] }],
    "action": "double_left",
    "button": "left",
    "gesture": "double",
    "at": 1752000000000
  }
}
```

- `buttons` — the endpoint's input inventory, seeded by the adapter at
  adoption (parsed from Z2M's `action` enum values, or the Matter Switch
  cluster's feature map) so clients can render the remote's layout before any
  press.
- `action` (raw protocol string) + parsed `button`/`gesture` ids — the most
  recent event. Gesture vocabulary: `single, double, triple, quadruple, many,
  hold, release, press, click, tap, press_release, hold_release` plus
  free-form gestures (`shake, flip90, flip180, rotate_left, …`).
- `at` — epoch milliseconds, stamped on every event so identical consecutive
  presses still produce a state change (and a WebSocket frame).

Remotes take no commands; a `deviceKind` of `remote` marks pure senders.

### The `irRemote` capability

IR blasters / universal remotes (Zosung/Tuya `learn_ir_code` family, e.g.
Aubess ZXZIR-02) *learn* codes off a physical remote and *replay* them. They
don't fit the state+intent model, so they carry a small library:

```json
{
  "irRemote": {
    "learning": false,
    "commands": [{ "id": "…uuid", "name": "TV Power", "code": "<opaque blob>" }],
    "pendingCode": "<opaque blob>"
  }
}
```

- `commands` — the saved library. Each `code` is an **opaque protocol blob**
  the apps never interpret; clients render `{id, name}` and replay by id.
- `pendingCode` — present when a fresh code was just captured and is awaiting a
  name (the apps prompt "Save this button?").
- `learning` — the device is in learn mode.

The library is **hub-authoritative**: it lives in endpoint state (persisted),
and the hub — not the adapter — owns its mutations. Driven by five intents
(below). A `deviceKind` of `remote` covers these too.

### The `custom` capability — the universal fallback

No fixed table can name every device parameter. The `custom` capability is the
escape hatch: **any** parameter with no dedicated capability becomes a declared
generic control the apps render with a universal component set, so a device is
never "unsupported" just because we lack a specific type for one of its knobs.

```json
{
  "custom": {
    "fields": [
      { "id": "sensitivity", "label": "Sensitivity", "control": "select",
        "options": [{ "value": "low", "label": "Low" }, { "value": "high", "label": "High" }], "settable": true },
      { "id": "occupancy_timeout", "label": "Occupancy timeout", "control": "slider",
        "unit": "s", "min": 0, "max": 3600, "step": 10, "settable": true },
      { "id": "child_lock", "label": "Child lock", "control": "toggle", "settable": true },
      { "id": "soil_moisture", "label": "Soil moisture", "control": "value", "unit": "%", "settable": false }
    ],
    "values": { "sensitivity": "high", "occupancy_timeout": 60, "child_lock": true, "soil_moisture": 42 }
  }
}
```

- `fields` — the declared inventory. `control` is one of `toggle` / `slider` /
  `select` / `value` (read-only readout); `settable` says whether the app may
  write it; `unit`/`min`/`max`/`step` shape a slider; `options` list a select.
  The **field `id` is the device's own payload property.**
- `values` — current values keyed by field id (booleans for toggles, the
  option value for selects, numbers/strings otherwise).

Writes use one intent — `setCustomField {fieldId, value}` — so the apps drive
every generic control the same way. Where do fields come from? For Zigbee, the
adapter generates them from Z2M's own `exposes` metadata (every leftover
setting/sensor). For anything the metadata can't describe, the **AI mapper**
declares them ([ai-adaptation.md](ai-adaptation.md)). A device only stays in
`needsReview` when a property has *no* representation at all — not even a
generic field.

### Example endpoint state

```json
{
  "reachable": true,
  "onOff": true,
  "level": { "current": 203, "min": 1, "max": 254 },
  "colorTemperature": { "mireds": 370, "minMireds": 250, "maxMireds": 454 },
  "sensors": {}
}
```

`sensors` is always present (possibly empty). Absent sub-objects mean the
capability has not reported yet.

## The command intents

Commands are JSON objects discriminated on `type`
(`POST /api/v1/devices/:id/endpoints/:endpointId/commands`):

```
{"type":"power","on":true}                {"type":"toggle"}
{"type":"setLevel","level":180,"transitionDs":10}     // transition in deciseconds, optional
{"type":"setColorTemperature","mireds":370}
{"type":"setHueSaturation","hue":200,"saturation":254}
{"type":"setHeatingSetpoint","centi":2150}            {"type":"setCoolingSetpoint","centi":2400}
{"type":"setSystemMode","mode":4}
{"type":"lock","engage":true}
{"type":"setCoveringPercent","percent100ths":2500}    // 0 = open
{"type":"openCovering"}  {"type":"closeCovering"}  {"type":"stopCovering"}
{"type":"setFanPercent","percent":60}                 {"type":"setFanMode","mode":5}
{"type":"playPause","play":true}
{"type":"setMode","mode":2}
```

IR blaster / universal remote (the `irRemote` capability):

```
{"type":"irLearn","on":true}                          // enter/exit learn mode
{"type":"irSaveLearned","name":"TV Power"}            // name + save the pending captured code
{"type":"irSend","commandId":"…uuid"}                 // replay a saved code
{"type":"irDeleteCommand","commandId":"…uuid"}
{"type":"irRenameCommand","commandId":"…uuid","name":"Telly"}
```

Generic controls (the `custom` capability) — one intent for every field:

```
{"type":"setCustomField","fieldId":"sensitivity","value":"high"}   // select
{"type":"setCustomField","fieldId":"child_lock","value":true}      // toggle
{"type":"setCustomField","fieldId":"occupancy_timeout","value":90} // slider
```

A device that cannot honor an intent answers `409` with an error message.

## Recorded readings

The state above is what a reading *is*. What it *was* is recorded separately, in
five-minute buckets, and served by `GET /devices/:id/history` —
[api.md](api.md#recorded-readings-get-devicesidhistory) is canonical for the wire
shape and the retention.

The part that belongs here is the **units**, because they are the same contract
as everything above: stored values are integers in the canonical wire unit, so
nothing is converted between a device report and a chart. Ten quantities are
recorded — `temperature`, `humidity`, `illuminance`, `pressure`, `co2`, `pm25`,
`flow`, `power`, `battery`, `thermostatTemperature` — and the three the wire
carries as floats get an explicit scale (`illuminance` rounds to whole lux,
`pressure` is ×10, `pm25` is ×10, `flow` is ×1000), since a `REAL` column costs
eight bytes a value on an SD card and a tenth of a hPa is far below anything a
chart can show.

**A quantity added to `EndpointState` is not recorded until it is added to
`KINDS` in `src/core/history.ts`** — deliberately a list rather than a sweep over
whatever happens to be numeric, because that is what keeps a bounded table
bounded and stops a vendor's diagnostic counter becoming a line on somebody's
chart.

## Device-type catalog

`src/schema/catalog.ts` maps Matter device-type IDs (Descriptor cluster) to
`deviceKind` + expected capabilities — ~60 entries covering lighting, plugs,
switches, sensors, HVAC, closures, entertainment, appliances, and energy
devices, with infrastructure types (root node, bridge plumbing, OTA) filtered
out. Zigbee and MQTT devices use the same kinds/capabilities vocabulary, so
the catalog doubles as the reference for what each kind means.
