# ESPHome

A pump relay and a DHT22 thermometer on an ESP32, as one gethome device with
two endpoints. ESPHome's own MQTT topics and Home Assistant discovery are
switched off, so the board speaks only the gethome convention.

## `secrets.yaml` — the person fills this in; never commit it

```yaml
wifi_ssid: "…"
wifi_password: "…"
gethome_hub: "192.168.1.50"          # the hub's IP address
gethome_mqtt_password: "…"           # gethome studio → the hub → Zigbee & MQTT
```

## `greenhouse.yaml`

```yaml
esphome:
  name: greenhouse

esp32:
  board: esp32dev

wifi:
  ssid: !secret wifi_ssid
  password: !secret wifi_password

logger:

# No `api:` block. The native API is Home Assistant's, and with nothing
# connected to it ESPHome reboots the board every 15 minutes. If you need both,
# keep `api:` and give it `reboot_timeout: 0s`.

mqtt:
  broker: !secret gethome_hub
  port: 1883
  username: gethome
  password: !secret gethome_mqtt_password
  discovery: false         # Home Assistant's discovery, not gethome's
  topic_prefix: null       # no ESPHome topics at all — only the ones below
  log_topic: null
  birth_message:
    topic: gethome/device/greenhouse/availability
    payload: online
    retain: true
  will_message:
    topic: gethome/device/greenhouse/availability
    payload: offline
    retain: true
  on_connect:
    - mqtt.publish:
        topic: gethome/discovery/greenhouse/config
        retain: true
        payload: >-
          {"name":"Greenhouse","vendor":"DIY","model":"ESP32 relay board",
          "endpoints":[
          {"endpointId":1,"deviceKind":"appliance","capabilities":["onOff"],"primary":"onOff"},
          {"endpointId":2,"deviceKind":"sensor","capabilities":["temperature","humidity"],"primary":"temperature"}]}
    - script.execute: publish_pump
    - script.execute: publish_climate
  on_disconnect:
    # Decide what your hardware does without the hub. A pump that runs on
    # unattended can flood something, so this one stops.
    - switch.turn_off: pump
  on_json_message:
    topic: gethome/device/greenhouse/set
    then:
      - lambda: |-
          std::string type = x["type"] | "";
          if (type == "power") {
            if (x["on"] | false) id(pump).turn_on(); else id(pump).turn_off();
          } else if (type == "toggle") {
            id(pump).toggle();
          }
          // Any other type is not this device's to do: ignore it.

switch:
  - platform: gpio
    id: pump
    pin: GPIO26
    restore_mode: ALWAYS_OFF   # a known, safe state at boot
    on_turn_on:
      - script.execute: publish_pump
    on_turn_off:
      - script.execute: publish_pump

sensor:
  - platform: dht
    pin: GPIO27
    model: DHT22
    update_interval: 60s
    temperature:
      id: air_temperature
    humidity:
      id: air_humidity
      on_value:
        - script.execute: publish_climate

script:
  - id: publish_pump
    then:
      - mqtt.publish:
          topic: gethome/device/greenhouse/state
          retain: true
          payload: !lambda 'return id(pump).state ? "{\"onOff\":true}" : "{\"onOff\":false}";'

  - id: publish_climate
    then:
      - if:
          condition:
            lambda: 'return !isnan(id(air_temperature).state) && !isnan(id(air_humidity).state);'
          then:
            - mqtt.publish:
                topic: gethome/device/greenhouse/state/2
                retain: true
                payload: !lambda |-
                  return str_sprintf("{\"sensors\":{\"temperatureCenti\":%d,\"humidityCenti\":%d}}",
                      (int) lroundf(id(air_temperature).state * 100),
                      (int) lroundf(id(air_humidity).state * 100));
```

## Why it is written this way

- **`topic_prefix: null`** stops ESPHome publishing its own state topics and
  subscribing to its own command topics; **`discovery: false`** stops Home
  Assistant discovery. Neither is harmful to the hub, but both are noise on the
  broker and confusing to anyone reading it.
- **Birth and will** are the availability topic, retained. ESPHome sends the
  birth message as it connects, before `on_connect` runs; on the very first
  connection the hub has not seen the document yet and drops it, which is
  harmless because a new device starts out online.
- **The relay reports through its own triggers**, so a command, a button on the
  board and an automation all produce the same report.
- **`lroundf(x * 100)`** — the hub wants hundredths of a degree as an integer;
  `21.56` sent as `2156.0000000000005` would be refused.
- The temperature and humidity go out in **one** message on endpoint 2's
  topic, because two retained messages on one topic keep only the last.
- A DHT22 that fails to read gives `NaN`; the script sends nothing rather than
  a value the hub would refuse.

## Variations

- **A light**: a `light` component, kind `light`, capabilities
  `["onOff","level"]`. Convert ESPHome's 0–1 brightness to 1–254 (`level =
  lroundf(1 + brightness * 253)`) when reporting, and back when a `setLevel`
  arrives (`x["level"] | 254`). A `setLevel` must not switch the light on.
- **A second relay**: endpoint 3 in the document, its state on
  `gethome/device/greenhouse/state/3`, and a second `on_json_message` entry
  for `gethome/device/greenhouse/set/3` (make `on_json_message` a list).
- **A button**: kind `remote`, capability `event`; publish
  `{"event":{"buttons":[{"id":"main","label":"Button","gestures":["single","double","hold"]}]}}`
  retained in `on_connect`, then from `binary_sensor` → `on_multi_click`
  publish `{"event":{"action":"double","button":"main","gesture":"double"}}`
  **without** retain.
