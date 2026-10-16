# Python (a Raspberry Pi, or a bridge)

Python suits a device on a Linux board — a relay on a Raspberry Pi's GPIO, a
serial or RS-485 controller — and **bridges**, which present hardware the hub
cannot reach by itself as gethome devices. This example is a relay on GPIO 17
and a DS18B20 thermometer on the 1-Wire bus of a Raspberry Pi, with
`paho-mqtt` 2.x and `gpiozero` (preinstalled on Raspberry Pi OS).

It can run on the hub's own Pi — use `127.0.0.1` as the address then — or on
any machine on the home's network.

## The credential, from the environment

```sh
# /etc/gethome-boiler.env — mode 600, never committed
GETHOME_HUB_ADDRESS=192.168.1.50
GETHOME_MQTT_PASSWORD=…        # gethome studio → the hub → Zigbee & MQTT
```

## `boiler_room.py`

```python
#!/usr/bin/env python3
"""A relay and a DS18B20 thermometer on a Raspberry Pi, as one gethome device."""
import glob
import json
import os
import signal
import threading

import paho.mqtt.client as mqtt          # pip install "paho-mqtt>=2"
from gpiozero import OutputDevice

HUB = os.environ["GETHOME_HUB_ADDRESS"]
PASSWORD = os.environ["GETHOME_MQTT_PASSWORD"]
DEVICE_ID = "boiler-room"
BASE = f"gethome/device/{DEVICE_ID}"
DISCOVERY = {
    "name": "Boiler room",
    "vendor": "DIY",
    "model": "Raspberry Pi relay",
    "endpoints": [
        {"endpointId": 1, "deviceKind": "appliance", "capabilities": ["onOff"], "primary": "onOff"},
        {"endpointId": 2, "deviceKind": "sensor", "capabilities": ["temperature"], "primary": "temperature"},
    ],
}

relay = OutputDevice(17, initial_value=False)       # a known, safe state at start
stop = threading.Event()


def read_temperature_centi():
    sensors = glob.glob("/sys/bus/w1/devices/28-*/temperature")
    if not sensors:
        return None
    with open(sensors[0]) as reading:
        return round(int(reading.read()) / 10)       # the kernel gives thousandths of a °C


def publish(client, suffix, payload):
    client.publish(BASE + suffix, json.dumps(payload), qos=1, retain=True)


def report_relay(client):
    publish(client, "/state", {"onOff": relay.is_active})


def on_connect(client, userdata, flags, reason_code, properties):
    if reason_code.is_failure:
        print(f"The broker refused the connection: {reason_code}")   # e.g. not authorised
        return
    client.publish(f"gethome/discovery/{DEVICE_ID}/config", json.dumps(DISCOVERY), qos=1, retain=True)
    client.publish(f"{BASE}/availability", "online", qos=1, retain=True)
    report_relay(client)
    centi = read_temperature_centi()
    if centi is not None:
        publish(client, "/state/2", {"sensors": {"temperatureCenti": centi}})
    client.subscribe(f"{BASE}/set")


def on_message(client, userdata, message):
    try:
        command = json.loads(message.payload)
    except ValueError:
        return                                        # not JSON: ignore
    kind = command.get("type")
    if kind == "power":
        relay.on() if command.get("on") else relay.off()
    elif kind == "toggle":
        relay.toggle()
    else:
        return                                        # not this device's to do
    report_relay(client)                              # report what the relay is now


client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"gethome-{DEVICE_ID}")
client.username_pw_set("gethome", PASSWORD)
client.will_set(f"{BASE}/availability", "offline", qos=1, retain=True)
client.on_connect = on_connect                        # runs again on every reconnect
client.on_message = on_message
client.connect_async(HUB, 1883, keepalive=60)
client.loop_start()                                   # reconnects by itself


def shut_down(*_):
    stop.set()


signal.signal(signal.SIGTERM, shut_down)
signal.signal(signal.SIGINT, shut_down)

last = None
while not stop.wait(30):
    centi = read_temperature_centi()
    if centi is not None and (last is None or abs(centi - last) >= 10):
        publish(client, "/state/2", {"sensors": {"temperatureCenti": centi}})
        last = centi

# A clean disconnect does not fire the last will, so say goodbye ourselves.
client.publish(f"{BASE}/availability", "offline", qos=1, retain=True).wait_for_publish(5)
client.disconnect()
client.loop_stop()
relay.off()
```

## Running it as a service

```ini
# /etc/systemd/system/gethome-boiler.service
[Unit]
Description=Boiler room relay for gethome
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=/etc/gethome-boiler.env
ExecStart=/usr/bin/python3 /opt/gethome-boiler/boiler_room.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## Why it is written this way

- **`on_connect` does the whole announcement**, so a reconnect after the hub
  or the network restarts announces the device again, document first.
- **`CallbackAPIVersion.VERSION2`** is paho-mqtt 2.x's callback signature;
  1.x is no longer current.
- **The thermometer reports a 0.1 °C change** (10 hundredths) — and the
  reading is rounded to an integer, which the hub requires.
- **A bridge** that presents several pieces of hardware gives each its own
  `deviceId` and document, all on one connection — one MQTT client, many
  devices. Each device needs its own availability; the connection's single
  last will can only cover one, so publish the others `offline` yourself when
  the bridge loses the hardware behind them.
