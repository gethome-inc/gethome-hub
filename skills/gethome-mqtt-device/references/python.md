# Python (a Raspberry Pi, or a bridge)

Python suits a device on a Linux board — a relay on a Raspberry Pi's GPIO, a
serial or RS-485 controller — and **bridges**, which present hardware the hub
cannot reach by itself as gethome devices. This example is a relay on GPIO 17
and a DS18B20 thermometer on the 1-Wire bus of a Raspberry Pi, with
`paho-mqtt` 2.x and `gpiozero` (preinstalled on Raspberry Pi OS). The 1-Wire
bus is off until it is enabled in `sudo raspi-config` (Interface Options) and
the Pi has restarted.

It can run on the hub's own Pi — use `127.0.0.1` as the address then — or on
any machine on the home's network.

## Installing paho-mqtt

Raspberry Pi OS refuses `pip install` into the system's Python, and its own
package may be the older 1.x. A virtual environment that can still see the
system's packages keeps `gpiozero` and adds paho:

```sh
sudo mkdir -p /opt/gethome-boiler
sudo python3 -m venv --system-site-packages /opt/gethome-boiler/venv
sudo /opt/gethome-boiler/venv/bin/pip install "paho-mqtt>=2"
```

## The credential, from the environment

```sh
# /etc/gethome-boiler.env — mode 600, never committed
GETHOME_HUB_ADDRESS=192.168.1.50
GETHOME_MQTT_PASSWORD=…        # gethome studio → the hub → Zigbee & MQTT
```

Leave the password empty only for a hub installed before the broker had
passwords, which takes anonymous connections. A current hub refuses those,
and the script prints the refusal.

## `boiler_room.py`

```python
#!/usr/bin/env python3
"""A relay and a DS18B20 thermometer on a Raspberry Pi, as one gethome device."""
import glob
import json
import os
import signal
import threading
import time

import paho.mqtt.client as mqtt          # paho-mqtt 2.x
from gpiozero import OutputDevice

HUB = os.environ["GETHOME_HUB_ADDRESS"]
PASSWORD = os.environ.get("GETHOME_MQTT_PASSWORD", "")
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
RESEND_S = 60                                       # report a steady reading this often
BEAT_S = 30                                         # how often we speak: the loop below wakes this often

relay = OutputDevice(17, initial_value=False)       # a known, safe state at start
stop = threading.Event()


def read_temperature_centi():
    sensors = glob.glob("/sys/bus/w1/devices/28-*/temperature")
    if not sensors:
        return None
    try:
        with open(sensors[0]) as reading:
            return round(int(reading.read()) / 10)   # the kernel gives thousandths of a °C
    except (OSError, ValueError):
        return None                                  # a failed read: try again next time


def publish(client, suffix, payload):
    client.publish(BASE + suffix, json.dumps(payload), qos=1, retain=True)


def report_relay(client):
    publish(client, "/state", {"onOff": relay.is_active})


def report_temperature(client, centi):
    publish(client, "/state/2", {"sensors": {"temperatureCenti": centi}})


def on_connect(client, userdata, flags, reason_code, properties):
    if reason_code.is_failure:
        print(f"The broker refused the connection: {reason_code}")   # e.g. not authorised
        return
    client.publish(f"gethome/discovery/{DEVICE_ID}/config", json.dumps(DISCOVERY), qos=1, retain=True)
    client.publish(f"{BASE}/availability", "online", qos=1, retain=True)
    client.publish(f"{BASE}/heartbeat", str(BEAT_S), qos=1, retain=True)
    report_relay(client)
    centi = read_temperature_centi()
    if centi is not None:
        report_temperature(client, centi)
    client.subscribe(f"{BASE}/set")


def on_message(client, userdata, message):
    if message.retain:
        return                                        # the hub never retains a command
    try:
        command = json.loads(message.payload)
    except ValueError:
        return                                        # not JSON: ignore
    if not isinstance(command, dict):
        return
    kind = command.get("type")
    if kind == "power":
        if command.get("on"):
            relay.on()
        else:
            relay.off()
    elif kind == "toggle":
        relay.toggle()
    else:
        return                                        # not this device's to do
    report_relay(client)                              # report what the relay is now


client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"gethome-{DEVICE_ID}")
if PASSWORD:
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

last, last_sent = None, 0.0
while not stop.wait(BEAT_S):
    if not client.is_connected():
        continue                                      # on_connect reports afresh when it is back
    client.publish(f"{BASE}/heartbeat", str(BEAT_S), qos=1, retain=True)   # still here
    centi = read_temperature_centi()
    if centi is None:
        continue
    now = time.monotonic()
    if last is None or abs(centi - last) >= 10 or now - last_sent >= RESEND_S:
        report_temperature(client, centi)             # a 0.1 °C move, or the steady re-send
        last, last_sent = centi, now

relay.off()                                           # the safe state first, whatever follows
try:
    # A clean disconnect does not fire the last will, so say goodbye ourselves.
    report_relay(client)
    client.publish(f"{BASE}/availability", "offline", qos=1, retain=True).wait_for_publish(5)
except (RuntimeError, ValueError):
    pass                                              # not connected: the broker sends the will
client.disconnect()
client.loop_stop()
```

## Running it as a service

```sh
sudo cp boiler_room.py /opt/gethome-boiler/
sudo useradd --system --groups gpio gethome-boiler   # may switch GPIO, nothing more
```

```ini
# /etc/systemd/system/gethome-boiler.service
[Unit]
Description=Boiler room relay for gethome
After=network-online.target
Wants=network-online.target

[Service]
User=gethome-boiler
StateDirectory=gethome-boiler
WorkingDirectory=/var/lib/gethome-boiler      # writable: gpiozero's lgpio keeps small files here
EnvironmentFile=/etc/gethome-boiler.env
ExecStart=/opt/gethome-boiler/venv/bin/python /opt/gethome-boiler/boiler_room.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

systemd reads the environment file itself before the script starts, so it
stays readable by root alone. `sudo systemctl enable --now gethome-boiler`
starts it now and at every boot.

## Why it is written this way

- **`on_connect` does the whole announcement**, so a reconnect after the hub
  or the network restarts announces the device again, document first.
- **`CallbackAPIVersion.VERSION2`** is paho-mqtt 2.x's callback signature;
  1.x is no longer current.
- **Each report is the endpoint's whole state**, which for each endpoint here
  is one value.
- **The thermometer reports a 0.1 °C change** (10 hundredths) **and every
  minute regardless**, so the hub's history has no holes in a steady room —
  and only while connected, since `on_connect` reports afresh and anything
  sent meanwhile would queue up and arrive late. The reading is rounded to an
  integer, which the hub requires.
- **A heartbeat on every pass of the loop**, every 30 s and retained: only a
  running broker sends a will, and a hub that lost power comes back holding
  the device's `online`. With the heartbeat, a device that stays quiet for 75 s
  reads offline all the same.
- **A retained command is ignored.** The hub never sends one, so it was
  published by hand, and the broker would replay it at every reconnect.
- **Shutting down switches the relay off before anything else.** The goodbye
  is best effort: when the connection is already gone, waiting for the publish
  raises, and the broker has sent the last will by itself.
- **A bridge** that presents several pieces of hardware gives each its own
  `deviceId`, document and **connection** — one `mqtt.Client` per device, each
  with its own client id (`gethome-<deviceId>`) and last will, so the broker
  marks each one offline by itself if the bridge dies. A connection carrying
  several devices has only one last will, and a crash leaves the others
  reading online. When the bridge loses the hardware behind a device but stays
  connected, publish that device's availability `offline` itself.
