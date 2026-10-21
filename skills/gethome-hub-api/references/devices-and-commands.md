# Devices, state, units and commands

The hub serves every device — Matter, Zigbee or MQTT — in one schema that
mirrors the Matter data model. The hub's `docs/device-schema.md` is canonical.

## A device

`GET /api/v1/devices` answers a list of these:

```json
{
  "id": "8b6c…uuid", "externalId": "0x54ef44100047fea7",
  "name": "Desk lamp", "roomId": "…uuid or null",
  "favorite": false, "online": true,
  "adapter": "zigbee", "vendor": "IKEA", "model": "LED2003G10",
  "needsReview": false,
  "endpoints": [{
    "endpointId": 1, "deviceKind": "light", "primaryCapability": "onOff",
    "capabilities": ["onOff", "level", "colorTemperature"],
    "state": {
      "reachable": true, "onOff": true,
      "level": { "current": 203, "min": 1, "max": 254 },
      "colorTemperature": { "mireds": 370, "minMireds": 250, "maxMireds": 454 },
      "sensors": {}
    }
  }]
}
```

- `id` is the hub's UUID — use it in URLs. `externalId` is the device's own
  address on its protocol.
- A device has one or more **endpoints** (a two-gang switch has two). Send a
  command to the endpoint whose `capabilities` include what it needs.
- `online` says whether the hub can reach it — read that for "is it online?".
  Each endpoint's `state.reachable` carries the same fact per endpoint.
- `offlineExpected` (present only when somebody said a device being offline is
  fine) and `offlineElsewhere` (it is on a Wi-Fi network the hub has left) mean
  an offline device is **not** a fault. Don't alarm about either.
- `favorite` is the key's member's own pin, not the home's.
- Absent sub-objects in `state` mean that capability has not reported yet —
  not zero. `sensors` is always present, possibly empty.

## Device kinds

`light, camera, sensor, climate, lock, outlet, airPurifier, shade, speaker,
wallSwitch, fan, vacuum, appliance, energy, tv, remote` — and treat the list as
open: show an unknown kind generically.

## Capabilities, where their state lives, and units

| Capability | State | Unit / range |
|---|---|---|
| `onOff` | `onOff` | boolean |
| `level` | `level.current/min/max` | **1–254** (not percent; 0 is invalid) |
| `colorTemperature` | `colorTemperature.mireds/minMireds/maxMireds` | **mireds = 1 000 000 / kelvin** (153 ≈ 6500 K cool, 500 ≈ 2000 K warm) |
| `color` | `colorHS.hue/saturation` | 0–254 (hue° × 254 / 360) |
| `thermostat` | `thermostat.localTemperatureCenti`, `occupiedHeatingSetpointCenti`, `occupiedCoolingSetpointCenti`, `systemMode` | **centi-°C** (2150 = 21.5 °C); mode 0 off / 1 auto / 3 cool / 4 heat |
| `fan` | `fan.mode/percentCurrent/percentSetting` | mode 0 off / 1 low / 2 medium / 3 high / 4 on / 5 auto; percent 0–100 |
| `doorLock` | `lock` | 0 not fully locked / 1 locked / 2 unlocked |
| `windowCovering` | `covering.currentPositionLiftPercent100ths`, `targetPositionLiftPercent100ths`, `isMoving` | **0 = fully OPEN, 10000 = fully CLOSED** |
| `temperature` | `sensors.temperatureCenti` | centi-°C |
| `humidity` | `sensors.humidityCenti` | centi-% RH, 0–10000 |
| `occupancy` | `sensors.occupied` | boolean |
| `contact` | `sensors.contactClosed` | boolean, true = closed (or no leak) |
| `illuminance` | `sensors.illuminanceLux` | lux |
| `pressure` | `sensors.pressureHPa` | hPa |
| `flow` | `sensors.flowCubicMetersPerHour` | m³/h |
| `airQuality` | `sensors.airQuality` | 0 unknown … 6 extremely poor |
| `pm25` | `sensors.pm25` | µg/m³ |
| `co2` | `sensors.co2ppm` | ppm |
| `smokeCOAlarm` | `sensors.smokeAlarm`, `sensors.coAlarm` | 0 normal / 1 warning / 2 critical |
| `battery` | `battery.percent` | 0–100 |
| `electricalPower` | `power.activeMilliwatts`, `power.importedEnergyMilliwattHours` | **milliwatts** / mWh |
| `mode` | `currentMode` | device-defined number |
| `rvcRun` | `rvcOperationalState` | 0 stopped, 1 running, 2 paused, 3 error, 64 seeking, 65 charging, 66 docked |
| `mediaPlayback` | `playbackPlaying` | boolean |
| `event` | `event.buttons`, `event.action/button/gesture/at` | buttons and remotes: stateless presses |
| `irRemote` | `irRemote.commands[]` | an IR blaster's learned codes, replayed by id |
| `custom` | `custom.fields[]`, `custom.values` | generic controls for any other parameter |

`camera` is a capability the hub adds itself, to a device that announces
pictures over MQTT: its state carries `camera.streams[]` — ids, kinds and sizes,
never an address — and the pictures come through the hub's own camera routes,
`GET /api/v1/cameras/{deviceId}/{endpointId}/{streamId}/snapshot` for a stream
whose `kind` is `snapshot` and `…/mjpeg` for one whose `kind` is `mjpeg`. They
need `camera.view`, which a key holds only when the person gave it on purpose
(see [rest-api.md](rest-api.md) for what it allows and the limits on streams).
A stream that isn't announced, or is the other kind, is `404 camera_not_found`;
a camera the hub could not or would not reach is a `502` naming why. Always go
through the hub rather than to a camera's own address: the hub checks the
board is the device it says it is, and the address is not in the state.

Conversions to keep at hand:

```text
percent → level      level = round(1 + percent / 100 × 253)      (100 % → 254)
level → percent      percent = round((level − 1) / 253 × 100)
kelvin → mireds      mireds = round(1 000 000 / kelvin)
°C → centi           centi = round(celsius × 100)
watts → mW           mW = watts × 1000
covering "open %"    percent100ths = (100 − openPercent) × 100
```

## Commands

`POST /api/v1/devices/{deviceId}/endpoints/{endpointId}/commands` with one of
these as the body. The key needs `control`.

```json
{"type":"power","on":true}
{"type":"toggle"}
{"type":"setLevel","level":180,"transitionDs":10}
{"type":"setColorTemperature","mireds":370}
{"type":"setHueSaturation","hue":200,"saturation":254}
{"type":"setHeatingSetpoint","centi":2150}
{"type":"setCoolingSetpoint","centi":2400}
{"type":"setSystemMode","mode":4}
{"type":"lock","engage":true}
{"type":"setCoveringPercent","percent100ths":2500}
{"type":"openCovering"}
{"type":"closeCovering"}
{"type":"stopCovering"}
{"type":"setFanPercent","percent":60}
{"type":"setFanMode","mode":5}
{"type":"playPause","play":true}
{"type":"setMode","mode":2}
{"type":"irSend","commandId":"…uuid"}
{"type":"setCustomField","fieldId":"sensitivity","value":"high"}
```

- `transitionDs` is in **deciseconds** and optional.
- **`setLevel` is brightness, not power.** Whether it switches an off light on
  depends on the device: many do, while one built to the hub's MQTT convention
  keeps the level for the next time it is switched on. To turn a light on at a
  brightness, send `setLevel` and then `{"type":"power","on":true}` — in that
  order, so it doesn't flash at its old level.
- `{"type":"lock","engage":false}` **unlocks a door**; ask the person first.
- `setCustomField` writes one of the device's `custom.fields` — only where that
  field's `settable` is true; `value` is a boolean for a toggle, a number for a
  slider (within `min`/`max`), an option's `value` for a select.
- The answer is `202 {accepted: true}` when the hub routed it, and `409` with a
  sentence when the device cannot do it. `202` is **not** the device having
  done it: wait for its `state` frame, or a `commandFailed` frame saying the
  write never landed.

## Buttons and remotes (`event`)

A press arrives as a state change on the WebSocket:

```json
{"type":"state","deviceId":"…","endpointId":1,
 "state":{"reachable":true,"sensors":{},
          "event":{"buttons":[{"id":"left","label":"Left","gestures":["single","double","hold"]}],
                   "action":"double_left","button":"left","gesture":"double","at":1752000000000}}}
```

`event.at` changes on every press, so identical presses are still new frames.
Gestures are an open list (`single`, `double`, `triple`, `hold`, `release`, …).
Remotes take no commands.

## History

`GET /api/v1/devices/{deviceId}/history?from=<ms>&to=<ms>&points=<n>&series=temperature,humidity`
answers what readings did, already thinned to at most `points`, in the same
units as state:

```json
{ "start": 1756108800000, "bucketMs": 300000, "end": 1756195200000, "retentionDays": 7,
  "series": [{ "kind": "temperature", "unit": "centiCelsius", "gapBuckets": 6,
               "leading": { "at": 1756108200000, "min": 2130, "max": 2150, "avg": 2140 },
               "points": [[0, 2140, 2180, 2160], [1, 2150, 2190, 2170], [7, 2050, 2060, 2055]] }] }
```

A point is `[offset, min, max, mean]`, with `offset` counted in `bucketMs` from
`start`. **A missing offset is a gap** — nothing was recorded — so don't draw a
line across a hole longer than `gapBuckets`. `bucketMs` is what the hub chose
for the span asked, so read it rather than assuming five minutes. Kinds
recorded: `temperature`, `humidity`, `illuminance`, `pressure`, `co2`, `pm25`,
`flow`, `power`, `battery`, `thermostatTemperature`; about a week is kept. A hub
without history has no `history` block on `GET /api/v1/hub`.
