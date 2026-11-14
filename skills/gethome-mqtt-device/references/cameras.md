# Cameras

A board or a computer that takes pictures — an ESP32-CAM, a Raspberry Pi with
a camera — becomes a camera in the home through the hub. The device serves the
pictures itself, over HTTP on the home's network; it tells the hub where, over
MQTT; and the hub fetches them for the gethome apps and for API software that
may see cameras. Neither ever learns the device's address, and the hub records
nothing.

It is an ordinary device first, so everything in [SKILL.md](../SKILL.md)
applies — the document, availability, the heartbeat, state and commands. A
camera adds three things:

1. its endpoint has the device kind `camera`, an ordinary capability, and
   **never the capability `camera`**;
2. it serves a still, a live stream or both, and a page that says which device
   it is;
3. it announces what it serves, retained, on its camera topic.

A hub from before cameras ignores the camera topic, and the same device is a
plain one there — a switch or a reading, without pictures. Nothing breaks.

## The document

```json
{
  "name": "Porch camera",
  "vendor": "DIY",
  "model": "ESP32-CAM",
  "endpoints": [
    { "endpointId": 1, "deviceKind": "camera",
      "capabilities": ["onOff"], "primary": "onOff" }
  ]
}
```

- **Never declare `camera` among the capabilities.** The hub adds it to the
  endpoint when it reads the announcement. A document that names it is
  refused whole — by this hub, and by every hub from before cameras.
- A document needs at least one capability, so declare what else the device
  does: `onOff` for its light or for a switch that stops it serving pictures,
  or `custom` for a reading
  ([capabilities.md](capabilities.md)).
- A `camera` key in the device's own state report is taken out by the hub.
  Only the announcement says what a camera serves.

## What the device serves

Plain HTTP, with no password: the hub sends none, and refuses an address that
carries one.

| What | The hub asks | The device answers | Bounds |
|---|---|---|---|
| a still — kind `snapshot` | `GET` on the announced address | `200`, `Content-Type: image/jpeg`, one JPEG | 2 MB, within 5 seconds |
| live — kind `mjpeg` | `GET` on the announced address | `200`, `Content-Type: multipart/x-mixed-replace; boundary=…`, then one JPEG a part for as long as the hub stays | 1 MB a part, 3 seconds to connect, and 10 seconds of silence closes it |
| the proof | `GET /gethome/id` | `200` and `{"id":"<deviceId>"}` | 4 KB |

- **Answer with the picture itself.** A redirect is not followed.
- **In a stream, give every part `Content-Type: image/jpeg` and a
  `Content-Length`.** A part of another type is passed over.
- **One viewer at a time is enough.** The hub opens one connection to a
  stream and shares it with everybody watching, and closes it when the last
  one leaves. A still is a request of its own, so a server that answers one
  request at a time puts the stream on a port of its own — or nobody gets a
  still, or the proof, while somebody watches.
- **Anything on the home's network can fetch these pages**, since they take
  no password. Say so to the person before the camera goes up: it belongs on
  a network they trust, pointed at something they are content for everybody
  on that network to see.

## Proving it is the device

Devices may all sign in to the broker with the same `gethome` account, so an
announcement alone could aim the hub at any address in the house. Before it
fetches a picture, the hub asks that address `GET /gethome/id` — **on the
stream's own port first, then on port 80** — and goes on only when the answer
is a JSON object whose `id` is this device's `deviceId`, exactly. Other keys
beside it are fine.

- Serve it on port 80, or on every port a stream is on.
- A port that doesn't answer, or has no such page, sends the hub on to the
  other one. **An `id` that is another device's ends it**: the hub refuses the
  camera rather than asking further.
- A proof holds for ten minutes, so the page is asked for again and again. Keep
  it up for as long as the device serves pictures.

## The announcement

Published **retained** on `gethome/device/<deviceId>/camera` for endpoint 1,
and on `gethome/device/<deviceId>/camera/<endpointId>` for another endpoint:

```json
{"streams": [
  {"id": "still", "kind": "snapshot", "label": "Still", "width": 640, "height": 480,
   "url": "http://192.168.1.31/snapshot"},
  {"id": "live", "kind": "mjpeg", "label": "Live", "width": 640, "height": 480,
   "url": "http://192.168.1.31:81/stream"}
]}
```

- **`id`** is 1 to 32 characters of `[A-Za-z0-9_-]`, and each stream of an
  endpoint has its own. The apps and the API ask for a stream by it, so keep
  it for the device's life.
- **`kind`** is `snapshot` or `mjpeg`. A stream of any other kind is passed
  over, not refused, so a newer device still works with an older hub.
- **`url`** is where the hub fetches it, at most 512 characters — see the next
  section.
- **`label`** (at most 60 characters), **`width`** and **`height`** (whole
  numbers, 1 to 10000) are optional, and are what the apps are told about the
  stream.
- At most **8 streams** an endpoint, and the endpoint has to be one the
  document declares.
- **It is read stream by stream.** One the hub will not serve is dropped on
  its own and the others stand; the hub's log names it and says why (*Dropped
  camera streams the hub will not serve*). A payload that is not JSON is
  ignored whole, and a key the hub does not know is passed over.

Publish it on every connection, after the document — though the hub keeps one
that arrives first.

### The address

The hub fetches only what could be a camera in the house, and drops a stream
whose address is anything else:

- plain `http://` — not `https`;
- the device's **IPv4 address, in numbers**, in a private range (`10.…`,
  `172.16.…` to `172.31.…`, `192.168.…`, or link-local `169.254.…`) — never a
  name (`porch-cam.local`), and never a public address;
- no user name or password in it.

The port and the path are yours to choose. **And never the hub's own
address**: that one is accepted in the announcement and refused each time a
picture is asked for, so a camera is not served from the hub's own machine.
Put it on another board or computer.

## When things change

- **The device gets another address.** Publish the announcement again with
  the new one, which a device that announces on every connection does by
  itself after its network comes back. A DHCP reservation on the router keeps
  the address from changing at all.
- **It stops serving pictures.** Publish an **empty retained payload** to the
  camera topic. The device stays in the home, as the plain device its
  document describes.
- **Somebody deletes it in an app.** The hub clears the retained document
  itself, and with it the camera topic (and the heartbeat and program
  topics), so the device does not come back when the hub next starts. A
  device subscribed to its own config topic hears that as a live, empty
  message — its cue to stop announcing itself until it is set up again. Its
  own retained document arriving on that subscription is not a deletion. A
  device that is switched off at that moment misses it, and announces itself
  again when it is switched on.
- **You remove it yourself.** Clear the camera topic along with the others
  ([convention.md](convention.md), *Removing a device*).

## A camera in Python

A computer with a camera on the home's network — not the hub's own machine.
Whatever takes the pictures keeps the newest one at `CAMERA_FRAME` as a JPEG,
written beside it and renamed over it, so a reader never gets half a file.
With ffmpeg and a USB camera that is
`ffmpeg -f v4l2 -i /dev/video0 -r 2 -update 1 -atomic_writing 1 /dev/shm/porch.jpg`.
The program serves that picture as a still and as a stream, proves which
device it is, and has one switch: off, it serves no pictures and withdraws
the announcement.

paho-mqtt 2.x, the environment file and the service are as in
[python.md](python.md).

```python
#!/usr/bin/env python3
"""A camera for a gethome home: a still, a live stream and the proof, announced over MQTT."""
import json
import os
import signal
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import paho.mqtt.client as mqtt          # paho-mqtt 2.x

HUB = os.environ["GETHOME_HUB_ADDRESS"]
PASSWORD = os.environ.get("GETHOME_MQTT_PASSWORD", "")
FRAME_FILE = os.environ.get("CAMERA_FRAME", "/dev/shm/porch.jpg")   # the newest picture, a JPEG
DEVICE_ID = "porch-cam"
BASE = f"gethome/device/{DEVICE_ID}"
PORT = 8080                                         # the still, the stream and the proof share it
BEAT_S = 60
LIVE_EVERY_S = 0.5                                  # two pictures a second
DISCOVERY = {
    "name": "Porch camera",
    "vendor": "DIY",
    "model": "Raspberry Pi camera",
    "endpoints": [
        # Never "camera" among the capabilities: the hub adds it from the announcement.
        {"endpointId": 1, "deviceKind": "camera", "capabilities": ["onOff"], "primary": "onOff"},
    ],
}

serving = threading.Event()                         # the switch: off serves no pictures
serving.set()
stop = threading.Event()
announced = None                                    # the address last announced


def frame():
    """The newest picture, or None while there is no whole JPEG to give."""
    try:
        with open(FRAME_FILE, "rb") as picture:
            data = picture.read()
    except OSError:
        return None
    whole = data[:2] == b"\xff\xd8" and data[-2:] == b"\xff\xd9"
    return data if whole and len(data) <= 1_000_000 else None   # the hub takes 1 MB a part


class Camera(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/gethome/id":              # the hub asks this before it fetches anything
            self.answer(200, "application/json", json.dumps({"id": DEVICE_ID}).encode())
        elif not serving.is_set():
            self.answer(503, "text/plain", b"switched off")
        elif self.path == "/still":
            picture = frame()
            if picture is None:
                self.answer(503, "text/plain", b"no picture yet")
            else:
                self.answer(200, "image/jpeg", picture)
        elif self.path == "/live":
            self.live()
        else:
            self.answer(404, "text/plain", b"not found")

    def answer(self, status, kind, body):
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def live(self):
        self.send_response(200)
        self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
        self.end_headers()
        try:
            while serving.is_set() and not stop.is_set():
                picture = frame()
                if picture is not None:
                    head = f"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: {len(picture)}\r\n\r\n"
                    self.wfile.write(head.encode() + picture + b"\r\n")
                time.sleep(LIVE_EVERY_S)
        except OSError:
            pass                                    # the hub hung up: nobody is watching

    def log_message(self, *_):
        pass                                        # one line a request is too many for a stream


def address():
    """The address the hub reaches this computer at — the one its route to the hub leaves from — or None."""
    override = os.environ.get("CAMERA_ADDRESS")     # for a computer with several
    if override:
        return override
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect((HUB, 1883))              # sends nothing: it only picks the route
            return probe.getsockname()[0]
    except OSError:
        return None                                 # no network just now


def announce(client):
    global announced
    if not serving.is_set():
        announced = None
        client.publish(f"{BASE}/camera", "", qos=1, retain=True)   # withdrawn: the device stays
        return
    here = address()
    if here is None:
        return                                      # the next heartbeat tries again
    announced = here
    streams = [
        {"id": "still", "kind": "snapshot", "label": "Still", "url": f"http://{announced}:{PORT}/still"},
        {"id": "live", "kind": "mjpeg", "label": "Live", "url": f"http://{announced}:{PORT}/live"},
    ]
    client.publish(f"{BASE}/camera", json.dumps({"streams": streams}), qos=1, retain=True)


def report(client):
    client.publish(f"{BASE}/state", json.dumps({"onOff": serving.is_set()}), qos=1, retain=True)
    announce(client)


def on_connect(client, userdata, flags, reason_code, properties):
    if reason_code.is_failure:
        print(f"The broker refused the connection: {reason_code}")   # e.g. not authorised
        return
    client.publish(f"gethome/discovery/{DEVICE_ID}/config", json.dumps(DISCOVERY), qos=1, retain=True)
    client.publish(f"{BASE}/availability", "online", qos=1, retain=True)
    client.publish(f"{BASE}/heartbeat", str(BEAT_S), qos=1, retain=True)
    report(client)
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
        on = bool(command.get("on"))
    elif kind == "toggle":
        on = not serving.is_set()
    else:
        return                                        # not this device's to do
    if on:
        serving.set()
    else:
        serving.clear()
    report(client)                                    # the new state, and the pictures with it


server = ThreadingHTTPServer(("", PORT), Camera)
server.daemon_threads = True
threading.Thread(target=server.serve_forever, daemon=True).start()

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

while not stop.wait(BEAT_S):
    if not client.is_connected():
        continue                                      # on_connect announces afresh when it is back
    client.publish(f"{BASE}/heartbeat", str(BEAT_S), qos=1, retain=True)   # still here
    if serving.is_set() and address() != announced:
        announce(client)                              # the router gave this computer another address

try:
    # A clean disconnect does not fire the last will, so say goodbye ourselves.
    client.publish(f"{BASE}/availability", "offline", qos=1, retain=True).wait_for_publish(5)
except (RuntimeError, ValueError):
    pass                                              # not connected: the broker sends the will
client.disconnect()
client.loop_stop()
server.shutdown()
```

- **One port for all three.** The proof is asked for on the stream's own
  port first, so serving it there needs no port 80, and no root. A threaded
  server answers a still while somebody watches the stream.
- **The address is found, never typed.** The route to the hub says which of
  the computer's addresses the hub can reach, and it is looked at again at
  every heartbeat, so a new address is announced within a minute.
- **Off withdraws the pictures and keeps the device.** The pages answer `503`
  and the camera topic is cleared; on announces them again.
- **A half-written picture is never sent**: a JPEG starts `FF D8` and ends
  `FF D9`, and anything else waits for the next pass.

## On an ESP32-CAM

The Arduino core's own **CameraWebServer** example (File → Examples → ESP32 →
Camera) already serves a still at `/capture` on port 80 and a stream at
`/stream` on port 81, in the shapes above. Two things make it a gethome
camera: the proof, and the MQTT side from [arduino.md](arduino.md).

The proof, in the example's `app_httpd.cpp` — the handler beside the others,
and its registration in `startCameraServer()` after the one for `/capture`:

```cpp
static esp_err_t gethome_id_handler(httpd_req_t *req) {
  httpd_resp_set_type(req, "application/json");
  return httpd_resp_sendstr(req, "{\"id\":\"porch-cam\"}");   // this device's deviceId
}
```

```cpp
    httpd_uri_t gethome_id_uri = {};
    gethome_id_uri.uri = "/gethome/id";
    gethome_id_uri.method = HTTP_GET;
    gethome_id_uri.handler = gethome_id_handler;
    httpd_register_uri_handler(camera_httpd, &gethome_id_uri);
```

The announcement, published in `connectToHub()` after the document, with
`DEVICE_ID` and `topic()` as [arduino.md](arduino.md) has them:

```cpp
void announceCamera() {
  String here = WiFi.localIP().toString();    // numbers, never a name
  String streams = String("{\"streams\":[")
    + "{\"id\":\"still\",\"kind\":\"snapshot\",\"label\":\"Still\",\"url\":\"http://" + here + "/capture\"},"
    + "{\"id\":\"live\",\"kind\":\"mjpeg\",\"label\":\"Live\",\"url\":\"http://" + here + ":81/stream\"}]}";
  mqtt.publish(topic("/camera").c_str(), streams.c_str(), true);
}
```

- **`mqtt.setBufferSize(1024)`** matters twice over here: the announcement is
  longer than PubSubClient's default 256 bytes, and a publish that does not
  fit fails without a word.
- **Announcing in `connectToHub()` covers a new address**, since a board that
  loses its network reconnects and announces again.
- **The stream is on port 81 for a reason**: each of the example's two
  servers answers one request at a time, so the still and the proof stay
  reachable on port 80 while somebody watches.
- The example's other pages (`/control` and the rest) change the camera's
  settings for anybody on the network. Take out the ones the device does not
  need.
- Keep the endpoint's document an ordinary one — `onOff` for the board's
  flash LED is the usual choice.

## Trying it

From a computer on the same network, before involving the hub:

```sh
curl -s http://192.168.1.31/gethome/id                          # {"id":"porch-cam"}
curl -s -o still.jpg -D - http://192.168.1.31/snapshot          # 200, Content-Type: image/jpeg
curl -s -m 3 -o /dev/null -D - http://192.168.1.31:81/stream    # 200, multipart/x-mixed-replace
```

Then what the broker holds ([testing.md](testing.md) has the set-up):

```sh
mosquitto_sub -h "$GETHOME_HUB" -u gethome -P "$GETHOME_MQTT_PASSWORD" \
  -t 'gethome/device/porch-cam/camera' -v --retained-only
```

And the hub's own view. With an API key that has been given `camera.view`
(the `gethome-hub-api` skill), find the device's id on the hub in
`GET /api/v1/devices` — it is the hub's id, not the `deviceId` — and ask for
a still through the hub, as an app does:
`GET /api/v1/cameras/{deviceId}/{endpointId}/{streamId}/snapshot`.

| What happens | Usual cause |
|---|---|
| The device appears, and is not a camera | the announcement was not retained, went to another endpoint's topic, or every stream in it was dropped — the hub's log says why (`gethome-hubctl logs 300 \| grep -i camera`) |
| A stream is dropped: *only plain http on the home network is allowed* | an `https://` address |
| A stream is dropped: *the address must be a private IPv4 address on the home network* | a name such as `porch-cam.local` in the address, or a public one |
| `502 camera_address_refused` | the address is the hub's own |
| `502 camera_unverified` | `/gethome/id` is missing on both ports, or answers another id — after re-flashing a board under a new `deviceId`, both have to change |
| `502 camera_unreachable` | the address is stale (announce again), the device is off, or it is on a network the hub cannot reach |
| `502 camera_bad_response` | a redirect, a status other than `200`, a `Content-Type` that is not `image/jpeg` for a still or `multipart/x-mixed-replace` with a boundary for a stream, a picture past its size, or a slow answer |
| `409 camera_busy` | four cameras are streaming already, or the API key asking has a stream open; a still still works |
| The stream stops after ten seconds | the device stopped sending parts; send them steadily for as long as the connection is open |
