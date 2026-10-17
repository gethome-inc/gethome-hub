# MicroPython (Raspberry Pi Pico W, ESP32)

A Pico W with nothing attached: its on-board LED as a light and its on-chip
temperature sensor as a thermometer — enough to see a device appear, switch it
from a phone and watch a reading arrive. The chip's sensor reads the chip, not
the room, and is only accurate to a few degrees; swap in a real sensor for
real use.

`umqtt.simple` is MicroPython's own MQTT client. If `import umqtt.simple`
fails on your board, install it once with `import mip; mip.install("umqtt.simple")`.

## `secrets.py` — the person fills this in; never commit it

```python
WIFI_SSID = "…"
WIFI_PASSWORD = "…"
HUB_ADDRESS = "192.168.1.50"     # the hub's IP address
MQTT_PASSWORD = "…"              # gethome studio → the hub → Zigbee & MQTT
```

## `main.py`

```python
import json
import time

import machine
import network
from umqtt.simple import MQTTClient

import secrets

DEVICE_ID = "desk-pico"
BASE = "gethome/device/" + DEVICE_ID
DISCOVERY = {
    "name": "Desk Pico",
    "model": "Raspberry Pi Pico W",
    "endpoints": [
        {"endpointId": 1, "deviceKind": "light", "capabilities": ["onOff"], "primary": "onOff"},
        {"endpointId": 2, "deviceKind": "sensor", "capabilities": ["temperature"], "primary": "temperature"},
    ],
}

led = machine.Pin("LED", machine.Pin.OUT)
led.value(0)                                   # a known state at boot
chip_sensor = machine.ADC(4)
client = None


def chip_temperature_centi():
    volts = chip_sensor.read_u16() * 3.3 / 65535
    return round((27 - (volts - 0.706) / 0.001721) * 100)   # an integer, as the hub requires


def publish(suffix, payload):
    client.publish(BASE + suffix, json.dumps(payload), retain=True)


def set_led(on):
    led.value(1 if on else 0)
    publish("/state", {"onOff": bool(led.value())})     # report what the LED is now


def on_message(topic, msg):
    try:
        command = json.loads(msg.decode())
    except ValueError:
        return                                          # not JSON: ignore
    kind = command.get("type")
    if kind == "power":
        set_led(bool(command.get("on")))
    elif kind == "toggle":
        set_led(not led.value())
    # Any other type is not this device's to do: ignore it.


def connect_wifi():
    wlan = network.WLAN(network.STA_IF)
    wlan.active(True)
    if not wlan.isconnected():
        wlan.connect(secrets.WIFI_SSID, secrets.WIFI_PASSWORD)
        while not wlan.isconnected():
            time.sleep(1)


def connect_hub():
    global client
    client = MQTTClient(DEVICE_ID, secrets.HUB_ADDRESS, port=1883,
                        user="gethome", password=secrets.MQTT_PASSWORD, keepalive=60)
    client.set_callback(on_message)
    client.set_last_will(BASE + "/availability", "offline", retain=True)
    client.connect()
    client.publish("gethome/discovery/%s/config" % DEVICE_ID, json.dumps(DISCOVERY), retain=True)
    client.publish(BASE + "/availability", "online", retain=True)
    publish("/state", {"onOff": bool(led.value())})
    client.subscribe(BASE + "/set")


def run():
    connect_wifi()
    connect_hub()
    last_sent, last_value = time.ticks_ms(), None
    last_ping = time.ticks_ms()
    while True:
        client.check_msg()                              # delivers commands to on_message
        now = time.ticks_ms()
        value = chip_temperature_centi()
        if last_value is None or abs(value - last_value) >= 50 or time.ticks_diff(now, last_sent) > 120000:
            publish("/state/2", {"sensors": {"temperatureCenti": value}})
            last_sent, last_value = now, value
        if time.ticks_diff(now, last_ping) > 30000:     # umqtt.simple never pings by itself
            client.ping()
            last_ping = now
        time.sleep_ms(200)


while True:
    try:
        run()
    except OSError:                                     # Wi-Fi or the broker went away
        time.sleep(5)
        machine.reset()                                 # start again from a known state
```

## Why it is written this way

- **`keepalive=60` and a ping every 30 seconds.** The broker only notices a
  silent client — and publishes its last will — once a keepalive has been
  missed, and `umqtt.simple` sends no pings unless asked.
- **The last will is set before `connect()`**, retained, so the hub sees
  `offline` when the board loses power.
- **Document, availability, state, then subscribe** on every connection.
- **A change of half a degree, or two minutes**, whichever comes first: the
  history stays continuous without a report every 200 ms.
- **Resetting on a network error** is the simplest dependable recovery on a
  microcontroller: the board boots into a known state and announces itself
  again.

## On an ESP32

Use a GPIO for the output (`machine.Pin(26, machine.Pin.OUT)`) and a real
sensor — the ESP32 has no usable on-chip thermometer. The rest is the same.
