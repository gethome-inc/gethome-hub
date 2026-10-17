# The gethome MQTT convention, in full

This is the contract the hub's MQTT adapter implements. The hub's
`docs/mqtt-integrations.md` is canonical, and `src/adapters/mqtt/` is the
reference implementation.

## The broker

| | |
|---|---|
| Host | the hub's address — the one the gethome apps use |
| Port | `1883`, plain TCP (no TLS; a home LAN only) |
| Username | `gethome` |
| Password | from gethome studio → the hub → Zigbee & MQTT, or `sudo gethome-hubctl mqtt` on the hub |

The `gethome` account **reads and writes everything under `gethome/#`**, and may
also **read** `zigbee2mqtt/+` (each Zigbee device's state topic) and
`zigbee2mqtt/bridge/state`, `bridge/event` and `bridge/devices` — so a board
can react to a Zigbee motion sensor. It cannot write anything under
`zigbee2mqtt/`: it cannot switch a Zigbee device or open the network for
pairing. The hub's other, full-access account is not for devices.

`sudo gethome-hubctl mqtt --rotate` mints new passwords; every device then
needs the new one. A hub installed before passwords existed accepted anonymous
connections, and updating it closed the broker.

## Topics

`<deviceId>` matches `[A-Za-z0-9_-]{1,64}`. A topic with any other id is
ignored. `<endpointId>` is a non-negative integer; topics without one mean
endpoint `1`.

| Topic | Who publishes | Retain | Payload |
|---|---|---|---|
| `gethome/discovery/<deviceId>/config` | device | **yes** | discovery document, or empty to remove |
| `gethome/device/<deviceId>/availability` | device (and its last will) | **yes** | `online` or `offline` |
| `gethome/device/<deviceId>/state` | device | recommended | state patch for endpoint 1 |
| `gethome/device/<deviceId>/state/<endpointId>` | device | recommended | state patch for that endpoint |
| `gethome/device/<deviceId>/set` | hub | no | command for endpoint 1 |
| `gethome/device/<deviceId>/set/<endpointId>` | hub | no | command for that endpoint |
| `gethome/device/<deviceId>/camera` | device | **yes** | the streams a camera serves on the LAN (endpoint 1) — see the hub's `docs/mqtt-integrations.md`, *Cameras* |
| `gethome/device/<deviceId>/camera/<endpointId>` | device | **yes** | the same, for that endpoint |

The hub subscribes to `gethome/discovery/+/config`, `gethome/device/+/state`,
`gethome/device/+/state/+`, `gethome/device/+/availability`,
`gethome/device/+/camera` and `gethome/device/+/camera/+`. Anything else under
`gethome/` is ignored by the hub today. A hub from before cameras ignores the
two camera topics as well.

## What the hub does with each message

- **A discovery document** it has not seen: creates the device, named with the
  document's `name`, with one endpoint per entry. One it has seen: updates the
  kind, capabilities and primary capability of each endpoint, adds new
  endpoints, and leaves the name, the room and dropped endpoints alone.
- **An empty config payload**: deletes the device — with its name, room,
  favorites and recorded history.
- **A document the schema refuses**: rejected, with the reasons in the hub's
  log and an activity entry (`mqtt.invalid`): *Rejected invalid MQTT discovery
  config for "<deviceId>".* The device does not appear or change. A payload
  that is not JSON at all is dropped with a log line only.
- **State or availability from a device it has no document for**: dropped.
  This is why the document comes first on every connection.
- **A state patch**: validated, then deep-merged into the endpoint's state.
  Invalid JSON or an invalid patch is dropped whole, with a line in the hub's
  own log only (*Rejected invalid MQTT state payload*). A patch for an endpoint
  the document did not declare is dropped.
- **Availability**: `online` marks the device reachable; anything else marks
  it unreachable. The apps show an unreachable device as offline.

After the hub restarts, it learns the device again from the retained document,
availability and state. A device whose document is **not** retained is unknown
to the hub after a restart until it publishes again — its commands fail and
its reports are dropped in the meantime.

## The discovery document

```text
{
  name:     string, 1–120                      a suggested name, used once
  vendor?:  string, ≤120
  model?:   string, ≤120
  endpoints: [                                 at least one
    {
      endpointId:   integer ≥ 0
      deviceKind:   one of the device kinds
      capabilities: [capability, …]            at least one
      primary:      capability                 the card's main control; one of capabilities
    }
  ]
}
```

No other keys are accepted, at either level.

**Device kinds**: `light`, `camera`, `sensor`, `climate`, `lock`, `outlet`,
`airPurifier`, `shade`, `speaker`, `wallSwitch`, `fan`, `vacuum`, `appliance`,
`energy`, `tv`, `remote`. The kind decides the icon and how the apps group the
device; the capabilities decide the controls.

**Capabilities**: `onOff`, `level`, `colorTemperature`, `color`, `thermostat`,
`fan`, `doorLock`, `windowCovering`, `temperature`, `humidity`, `occupancy`,
`contact`, `illuminance`, `pressure`, `flow`, `airQuality`, `pm25`, `co2`,
`smokeCOAlarm`, `battery`, `electricalPower`, `mode`, `rvcRun`,
`mediaPlayback`, `event`, `irRemote`, `custom`. What each one means is in
[capabilities.md](capabilities.md). **Never declare `camera`**: the hub adds
that capability itself to an endpoint whose device announces streams on its
camera topic, and a document naming it is refused whole — by this hub and by
every hub from before cameras.

## State patches

A state patch is a JSON object whose keys are those of an endpoint's state:

```text
reachable?      boolean
onOff?          boolean
level?          { current: 1–254, min?: 0–255 (1), max?: 0–255 (254) }
colorTemperature? { mireds: 0–65535, minMireds? (153), maxMireds? (500) }
colorHS?        { hue: 0–254, saturation: 0–254, colorModeIsHueSaturation? (true) }
thermostat?     { localTemperatureCenti?, occupiedHeatingSetpointCenti?,
                  occupiedCoolingSetpointCenti?, heatSetpointMinCenti? (700),
                  heatSetpointMaxCenti? (3000), coolSetpointMinCenti? (1600),
                  coolSetpointMaxCenti? (3200), systemMode? 0–255 (0) }
lock?           0 | 1 | 2
covering?       { currentPositionLiftPercent100ths: 0–10000,
                  targetPositionLiftPercent100ths?: 0–10000, isMoving? (false) }
fan?            { mode: 0–5, percentCurrent? 0–100 (0), percentSetting? 0–100 }
sensors?        { temperatureCenti?, humidityCenti? 0–10000, illuminanceLux? ≥0,
                  pressureHPa?, flowCubicMetersPerHour? ≥0, occupied?, contactClosed?,
                  airQuality? 0–6, pm25? ≥0, co2ppm? ≥0, smokeAlarm? 0–2, coAlarm? 0–2 }
battery?        { percent: 0–100 }
power?          { activeMilliwatts?, importedEnergyMilliwattHours? ≥0 }
playbackPlaying? boolean
event?          { buttons?: [{ id, label, gestures: [string] }], action?, button?, gesture?, at? }
custom?         { fields?: [field], values?: { <fieldId>: string | number | boolean } }
currentMode?    0–255
rvcOperationalState? 0–255
```

`(n)` is the default a left-out field takes. **Integers**: everything ending
in `Centi`, the `level` and `…Mireds`/`mireds` fields, `hue`, `saturation`,
every `percent…`, `lock`, `systemMode`, `fan.mode`, `airQuality`,
`smokeAlarm`, `coAlarm`, `battery.percent`, `activeMilliwatts`,
`importedEnergyMilliwattHours`, `currentMode` and `rvcOperationalState`. The
others (`illuminanceLux`, `pressureHPa`, `flowCubicMetersPerHour`, `pm25`,
`co2ppm`) may carry decimals.

The rules that catch people out:

1. **Every key is checked, at every level.** An unknown key anywhere drops the
   whole message.
2. **A nested object is validated as a whole.** Its required fields must be
   present (`level.current`, `colorTemperature.mireds`, both `colorHS` fields,
   `covering.currentPositionLiftPercent100ths`, `fan.mode`,
   `battery.percent`), and fields with a default that you leave out are set to
   that default — overwriting what the hub held. So send each of these objects
   with every field you know, every time. `sensors` has neither required fields
   nor defaults, which is why a partial `sensors` merges cleanly.
3. **Objects merge; arrays and values replace.** `{"sensors":{"humidityCenti":4800}}`
   keeps the stored temperature. `event.buttons` and `custom.fields` are
   replaced whole when sent. `custom.values` merges key by key.
4. **Integers are integers.** `2156.0000000000005` is refused; round.
5. **`reachable` belongs to availability.** Report reachability on the
   availability topic rather than in a patch.

## Commands

The hub publishes a command as JSON on the `set` topic of the endpoint it is
for, without the retain flag:

```text
{"type":"power","on":true}                 {"type":"toggle"}
{"type":"setLevel","level":180,"transitionDs":10}      transitionDs (deciseconds) is optional
{"type":"setColorTemperature","mireds":370}
{"type":"setHueSaturation","hue":200,"saturation":254}
{"type":"setHeatingSetpoint","centi":2150} {"type":"setCoolingSetpoint","centi":2400}
{"type":"setSystemMode","mode":4}
{"type":"lock","engage":true}
{"type":"setCoveringPercent","percent100ths":2500}     0 = open
{"type":"openCovering"}  {"type":"closeCovering"}  {"type":"stopCovering"}
{"type":"setFanPercent","percent":60}      {"type":"setFanMode","mode":5}
{"type":"playPause","play":true}
{"type":"setMode","mode":2}
{"type":"setCustomField","fieldId":"schedule_mode","value":"turbo"}
```

The hub checks a command against the schema before sending it, so values are
inside their ranges — but it does not check that this endpoint declared the
capability, so ignore a command the device cannot carry out. New command types
may be added; ignore any `type` you do not know.

There is no reply topic. The hub learns the outcome from the state you report:
report the new state after a command that worked, and nothing after one that
did not.

The hub never publishes a command retained. A retained `set` message was
published by hand, and the broker hands it to the device again at every
reconnect — ignore it if your MQTT library says a message was retained, and
clear it with an empty retained message on that topic.

An endpoint with the `irRemote` capability is the exception: its library of
learned codes is kept by the hub, and the device receives `irLearn` and
`irSendRaw`. That protocol is not covered here — read the hub's
`docs/device-schema.md` before building an IR blaster.

## Removing a device

```text
gethome/discovery/<deviceId>/config        ""   retained   the hub deletes the device
gethome/device/<deviceId>/state            ""   retained   clears the broker's copy
gethome/device/<deviceId>/availability     ""   retained   clears the broker's copy
```

(With `mosquitto_pub`, an empty retained message is `-r -n`.)
