# Capabilities: what to declare, report and accept

A capability is declared in the discovery document, reported in state patches
and — for the ones that take commands — driven by the commands listed beside
it. The hub's `docs/device-schema.md` is canonical.

## The table

| Capability | Report | Commands that arrive | Unit / range |
|---|---|---|---|
| `onOff` | `onOff` | `power {on}`, `toggle` | boolean |
| `level` | `level {current, min, max}` | `setLevel {level, transitionDs?}` | **1–254**, not percent; 0 is invalid |
| `colorTemperature` | `colorTemperature {mireds, minMireds, maxMireds}` | `setColorTemperature {mireds}` | mireds = 1 000 000 / kelvin |
| `color` | `colorHS {hue, saturation}` | `setHueSaturation {hue, saturation}` | 0–254 each (hue° × 254 / 360) |
| `thermostat` | `thermostat {localTemperatureCenti, occupiedHeatingSetpointCenti, occupiedCoolingSetpointCenti, systemMode, …MinCenti/…MaxCenti}` | `setHeatingSetpoint {centi}`, `setCoolingSetpoint {centi}`, `setSystemMode {mode}` | hundredths of a °C; mode 0 off, 1 auto, 3 cool, 4 heat |
| `fan` | `fan {mode, percentCurrent, percentSetting}` | `setFanPercent {percent}`, `setFanMode {mode}` | mode 0 off, 1 low, 2 medium, 3 high, 4 on, 5 auto; percent 0–100 |
| `doorLock` | `lock` | `lock {engage}` | 0 not fully locked, 1 locked, 2 unlocked |
| `windowCovering` | `covering {currentPositionLiftPercent100ths, targetPositionLiftPercent100ths, isMoving}` | `setCoveringPercent {percent100ths}`, `openCovering`, `closeCovering`, `stopCovering` | hundredths of a percent, **0 = fully open, 10000 = fully closed** |
| `temperature` | `sensors.temperatureCenti` | — | hundredths of a °C |
| `humidity` | `sensors.humidityCenti` | — | hundredths of a percent RH, 0–10000 |
| `occupancy` | `sensors.occupied` | — | boolean |
| `contact` | `sensors.contactClosed` | — | boolean; `true` = closed, or no leak |
| `illuminance` | `sensors.illuminanceLux` | — | lux |
| `pressure` | `sensors.pressureHPa` | — | hPa |
| `flow` | `sensors.flowCubicMetersPerHour` | — | m³/h |
| `airQuality` | `sensors.airQuality` | — | 0 unknown, 1 good, 2 fair, 3 moderate, 4 poor, 5 very poor, 6 extremely poor |
| `pm25` | `sensors.pm25` | — | µg/m³ |
| `co2` | `sensors.co2ppm` | — | ppm |
| `smokeCOAlarm` | `sensors.smokeAlarm`, `sensors.coAlarm` | — | 0 normal, 1 warning, 2 critical |
| `battery` | `battery.percent` | — | 0–100 |
| `electricalPower` | `power {activeMilliwatts, importedEnergyMilliwattHours}` | — | **milliwatts**; energy in mWh, a running total |
| `mode` | `currentMode` | `setMode {mode}` | a device-defined number 0–255 |
| `mediaPlayback` | `playbackPlaying` | `playPause {play}` | boolean |
| `rvcRun` | `rvcOperationalState` | — | 0 stopped, 1 running, 2 paused, 3 error, 64 seeking the dock, 65 charging, 66 docked |
| `event` | `event {buttons, action, button, gesture}` | — | see below |
| `custom` | `custom {fields, values}` | `setCustomField {fieldId, value}` | see below |

`irRemote` exists too, but its code library is kept by the hub and is not
covered by this skill.

Conversions to keep at hand:

```text
percent → level        level = round(1 + percent / 100 × 253)
kelvin → mireds        mireds = round(1 000 000 / kelvin)
°C → centi             centi = round(celsius × 100)
°F → centi             centi = round((fahrenheit − 32) × 5 / 9 × 100)
% RH → centi           centi = round(percent × 100)
watts → milliwatts     mW = round(watts × 1000);  kWh → mWh: × 1 000 000
hue° → hue             hue = round(degrees × 254 / 360)
saturation % → 0–254   sat = round(percent × 254 / 100)
"open %" → covering    percent100ths = round((100 − openPercent) × 100)
```

## Lights

- **Brightness, colour temperature and colour do not switch a light on.**
  In gethome that is `power` and `toggle`'s job alone. A `setLevel` that
  arrives while the light is off is best remembered for when it next comes
  on; report the new `level` without changing `onOff`.
- Report the bulb's real `minMireds`/`maxMireds` (153 and 500 are only the
  defaults), and clamp what arrives to them.
- `transitionDs` is in tenths of a second; honour it if you can fade, ignore it
  if you cannot.
- After `setHueSaturation`, report `colorHS`; after `setColorTemperature`,
  report `colorTemperature` — both whole objects.

## Covers, blinds and anything with a motor

- 0 is **fully open** and 10000 fully closed — the opposite of most motor
  libraries. `openCovering` means go to 0.
- While moving, report `{"covering":{"currentPositionLiftPercent100ths":…,"targetPositionLiftPercent100ths":…,"isMoving":true}}`
  every second or so; when stopped, report the final position with
  `"isMoving":false`.
- A motor without a position sensor can still estimate one from travel time.
  If it cannot, report 0 or 10000 at the ends and leave the target out.

## Thermostats

- Report the whole `thermostat` object every time: a left-out `systemMode`
  becomes 0 (off) and left-out limits become the defaults (7–30 °C heating,
  16–32 °C cooling).
- Report your real setpoint limits and clamp `setHeatingSetpoint` /
  `setCoolingSetpoint` to them.
- The measured temperature belongs in `thermostat.localTemperatureCenti`; add
  the `temperature` capability and `sensors.temperatureCenti` only if the
  device is also a room sensor in its own right.

## Locks

- `{"type":"lock","engage":true}` locks; `engage: false` **unlocks**. Report
  1 or 2 once the bolt has actually moved, and 0 if it jammed or stopped
  between the two.

## Fans

- `setFanPercent` sets the speed asked for; report it in `percentSetting` and
  the speed reached in `percentCurrent`. `setFanMode` picks a named mode.
  Report all three fields together.

## Sensors

- Report on a meaningful change — 0.1 °C, 1 % RH, a door opening — and at
  least every minute or two even when nothing moves: the hub's history records
  the reports it gets, and a long silence is drawn as a gap rather than as a
  flat line.
- `occupied` and `contactClosed` are booleans that change; a motion sensor
  should hold `occupied: true` for its own timeout and then report `false`.
- A battery device reports `battery.percent` with its readings; there is no
  separate battery topic.

## Buttons and remotes (`event`)

Declare `event` (and kind `remote` for a pure sender), publish the inventory
once, retained:

```json
{"event":{"buttons":[
  {"id":"main","label":"Button","gestures":["single","double","hold"]}
]}}
```

Then one small patch per press, not retained:

```json
{"event":{"action":"double","button":"main","gesture":"double"}}
```

- `id` (≤60), `label` (≤60), up to 24 gestures per button and 32 buttons.
- `action` is the raw string (≤120), `button` and `gesture` the parsed ids.
  Gestures: `single, double, triple, quadruple, many, hold, release, press,
  click, tap, press_release, hold_release`, or your own words.
- The hub stamps `event.at` (epoch milliseconds) when you leave it out, so two
  identical presses are two state changes. Do not retain presses: a retained
  press is replayed to the hub after every restart.
- Remotes take no commands.

## Everything else (`custom`)

Any parameter or reading with no capability of its own — a schedule mode, a
sensitivity, a timeout, soil moisture, signal strength — is a **field**.
Declare the inventory and current values together:

```json
{"custom":{
  "fields":[
    {"id":"schedule","label":"Schedule","control":"select","settable":true,
     "options":[{"value":"eco","label":"Eco"},{"value":"turbo","label":"Turbo"}]},
    {"id":"run_minutes","label":"Run time","control":"slider","unit":"min",
     "min":5,"max":240,"step":5,"settable":true},
    {"id":"child_lock","label":"Child lock","control":"toggle","settable":true},
    {"id":"rssi","label":"Signal","control":"value","unit":"dBm","settable":false}
  ],
  "values":{"schedule":"eco","run_minutes":60,"child_lock":false,"rssi":-61}
}}
```

- `control` is `toggle` (a boolean), `slider` (a number, shaped by
  `min`/`max`/`step`/`unit`), `select` (one of `options`, each a `value` string
  or number with a `label`) or `value` (a read-only readout).
- `settable: false` means the apps only show it. Up to 32 fields; `id` and
  `label` up to 80 characters, `unit` up to 24, a string value up to 400.
- After the first report, send only `{"custom":{"values":{…}}}` — values merge
  key by key. Send `fields` again only when the inventory changes, and then
  whole: the array replaces the old one.
- A write arrives as `{"type":"setCustomField","fieldId":"schedule","value":"turbo"}`.
  Apply it and report the new value.

## Recipes

**Relay, plug or switched appliance**

```json
{"name":"Pool pump","endpoints":[{"endpointId":1,"deviceKind":"appliance",
  "capabilities":["onOff","electricalPower"],"primary":"onOff"}]}
```

State `{"onOff":false,"power":{"activeMilliwatts":0}}`; handle `power` and
`toggle`. Use kind `outlet` for a plug, `wallSwitch` for a wall switch,
`appliance` for a pump, heater or kettle.

**Two-channel relay board** — one device, endpoints 1 and 2, each `onOff`;
state on `…/state` and `…/state/2`, commands on `…/set` and `…/set/2`.

**Dimmable or tunable-white light**

```json
{"name":"Desk strip","endpoints":[{"endpointId":1,"deviceKind":"light",
  "capabilities":["onOff","level","colorTemperature"],"primary":"onOff"}]}
```

State `{"onOff":true,"level":{"current":254,"min":1,"max":254},"colorTemperature":{"mireds":370,"minMireds":153,"maxMireds":500}}`.
Add `color` and `colorHS` for an RGB strip.

**Temperature and humidity sensor**

```json
{"name":"Greenhouse","endpoints":[{"endpointId":1,"deviceKind":"sensor",
  "capabilities":["temperature","humidity","battery"],"primary":"temperature"}]}
```

State `{"sensors":{"temperatureCenti":2156,"humidityCenti":6480},"battery":{"percent":87}}`.

**Door, window or leak sensor** — kind `sensor`, capability `contact`,
`{"sensors":{"contactClosed":true}}` when shut (or dry).

**Blind or curtain motor** — kind `shade`, capability `windowCovering`; see
*Covers* above.

**A relay with a sensor on the same board** — one device, two endpoints: the
relay as endpoint 1 (`outlet` or `appliance`, `onOff`), the sensor as endpoint
2 (`sensor`, `temperature`, `humidity`).
