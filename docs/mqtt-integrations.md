# MQTT integrations — the GetHome convention

The hub ships an MQTT broker (Mosquitto on `1883`) and a small, stable topic
convention for wiring **anything** into a GetHome home: DIY boards (ESPHome,
ESP32/Arduino, Raspberry Pi Pico W), wired-bus controllers, relay boards,
custom bridges. If your thing can publish JSON over MQTT, it can be a GetHome
device — with no hub-side code and no per-device mapping, because both
directions speak the [canonical schema](device-schema.md) directly.

## Topics

`<deviceId>`: `[A-Za-z0-9_-]`, 1–64 chars.

| Topic | Direction | Payload |
|---|---|---|
| `gethome/discovery/<deviceId>/config` | device → hub, **retained** | discovery document (below) |
| `gethome/device/<deviceId>/state` | device → hub, retained recommended | canonical **state patch** for endpoint 1 |
| `gethome/device/<deviceId>/state/<endpointId>` | device → hub | per-endpoint state patch |
| `gethome/device/<deviceId>/availability` | device → hub, retained | `online` / `offline` — set as your MQTT **LWT** |
| `gethome/device/<deviceId>/set` | hub → device | canonical **command** for endpoint 1 |
| `gethome/device/<deviceId>/set/<endpointId>` | hub → device | per-endpoint command |

Publish an **empty retained payload** to the config topic to remove the
device.

## Discovery document

```json
{
  "name": "Pool pump",
  "vendor": "Acme",
  "model": "PP-1",
  "endpoints": [
    {
      "endpointId": 1,
      "deviceKind": "outlet",
      "capabilities": ["onOff", "electricalPower"],
      "primary": "onOff"
    }
  ]
}
```

`deviceKind` and `capabilities` must use the canonical vocabulary
([device-schema.md](device-schema.md)); invalid documents are rejected (the
hub logs why and records an activity entry).

## Worked example: a pump relay with power metering

On boot, the device publishes (retained):

```
topic:  gethome/discovery/pool-pump/config     → the document above
topic:  gethome/device/pool-pump/availability  → "online"   (LWT: "offline")
topic:  gethome/device/pool-pump/state         → {"onOff":false,"power":{"activeMilliwatts":0}}
```

State updates are partial — send only what changed, in canonical units
(watts × 1000):

```
gethome/device/pool-pump/state  →  {"onOff":true,"power":{"activeMilliwatts":740000}}
```

The hub sends commands as canonical intents; the device applies them and
reports the resulting state back on its state topic:

```
gethome/device/pool-pump/set  ←  {"type":"power","on":false}
```

That's the whole protocol. A sensor-only device just omits `commandRules`-ish
behavior: declare `capabilities: ["temperature","humidity"]` and publish
`{"sensors":{"temperatureCenti":2156,"humidityCenti":4820}}`.

## Buttons and remotes (the `event` capability)

Input devices — doorbell buttons, DIY remotes, anything that *emits* rather
than holds state — declare the `event` capability (device kind `remote` for
pure senders). Publish the button inventory once (retained), then one small
patch per press:

```
gethome/discovery/workshop-button/config →
  {"name":"Workshop button",
   "endpoints":[{"endpointId":1,"deviceKind":"remote","capabilities":["event","battery"],"primary":"event"}]}

gethome/device/workshop-button/state (retained) →
  {"event":{"buttons":[{"id":"main","label":"Button","gestures":["single","double","hold"]}]}}

gethome/device/workshop-button/state (per press) →
  {"event":{"action":"double","button":"main","gesture":"double"}}
```

The hub stamps `event.at` (epoch ms) on arrival when the press doesn't carry
one, so every press — including identical repeats — reaches the apps as a
state change. Gesture ids follow [device-schema.md](device-schema.md)
(`single`, `double`, `triple`, `hold`, `release`, …); free-form gestures are
allowed and shown as-is.

## Rules & tips

- **Units are canonical**, not native: centi-°C, mireds, percent-100ths with
  0 = open, milliwatts. The full table is in
  [device-schema.md](device-schema.md).
- Retain your config, availability, and state topics so the hub recovers your
  device after a restart without waiting for your next publish.
- One physical device with several functions = one deviceId with several
  endpoints, not several devices.
- The broker is LAN-internal; don't expose 1883 to the internet.
