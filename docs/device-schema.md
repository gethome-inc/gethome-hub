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
- `capabilities` — what it can do (subset of the 25 below)
- `primaryCapability` — the headline capability
- `state` — the typed state object below

## The 25 capabilities and their units

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

## The 17 command intents

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

A device that cannot honor an intent answers `409` with an error message.

## Device-type catalog

`src/schema/catalog.ts` maps Matter device-type IDs (Descriptor cluster) to
`deviceKind` + expected capabilities — ~60 entries covering lighting, plugs,
switches, sensors, HVAC, closures, entertainment, appliances, and energy
devices, with infrastructure types (root node, bridge plumbing, OTA) filtered
out. Zigbee and MQTT devices use the same kinds/capabilities vocabulary, so
the catalog doubles as the reference for what each kind means.
