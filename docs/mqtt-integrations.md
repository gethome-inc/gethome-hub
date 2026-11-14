# MQTT integrations — the gethome convention

The hub ships an MQTT broker (Mosquitto on `1883`) and a small, stable topic
convention for wiring **anything** into a gethome home: DIY boards (ESPHome,
ESP32/Arduino, Raspberry Pi Pico W), wired-bus controllers, relay boards,
custom bridges. If your thing can publish JSON over MQTT, it can be a gethome
device — with no hub-side code and no per-device mapping, because both
directions speak the [canonical schema](device-schema.md) directly.

## Connecting

The broker asks for a username and password, and there are two accounts. **Use
the one named for your own devices** — it is what this whole convention is for:

```
host:     your hub's address        (the same one the apps use)
port:     1883
username: gethome
password: ...
```

Get them from **gethome studio → your hub → Zigbee & MQTT**, or on the hub
itself with `sudo gethome-hubctl mqtt`. They are minted once when the hub is
installed and kept across updates, so you set them in your device one time.

That account can publish anything under `gethome/#` — the whole of what is
described below — and can *watch* the home: your Zigbee devices' state topics,
plus `zigbee2mqtt/bridge/state`, `bridge/event` and `bridge/devices`. So a
board you build can react to a motion sensor.

What it cannot do is write to `zigbee2mqtt/` at all. It cannot switch a Zigbee
device on, and it cannot open the network for pairing. That is deliberate and
it is in your favour: a devboard on your bench is the least protected thing in
the house, and this one cannot be used to take the house over. If you genuinely
need to drive Zigbee directly, the hub's own full-access account is on the same
screen — but the supported way to switch a device is `POST /devices/:id/…` on
the [REST API](api.md), which works for every protocol rather than just Zigbee.

The connection is unencrypted. That is right for a home LAN and wrong for the
internet: don't forward 1883 through your router.

### A device's own account

`gethome` is one password for everything you wire in, which is what you want
on a bench. A hub can also give **one device an account of its own**, which an
app that sets a device up for you can ask it for where the hub offers it
(`mqtt.deviceAccounts` on `GET /hub`,
[`api.md`](api.md#a-broker-account-for-each-device-mqttdevice-accounts)):

```
username: <deviceId>                (the id in the device's own topics)
password: ...                       (shown once, when the account is made)
```

Nothing about the convention below changes for a device that holds one. What
changes is its reach:

- **It reads and writes its own topics and nothing else** —
  `gethome/device/<deviceId>/…` and `gethome/discovery/<deviceId>/…`. Not
  another device's state, discovery document or commands; not the rest of
  `gethome/`; nothing under `zigbee2mqtt/`, reading included.
- **A project's topics only if it was given the project's key** when the
  account was made, and then only that project's
  ([below](#a-projects-own-topics-gethomeprojectkey)).
- **It ends with the device.** Deleting the device in an app takes the account
  away and the broker drops the connection, so the device cannot come back —
  not even one that was switched off when it was deleted. It gets a new
  account by being set up again.
- **Sign in under a client id made of letters, digits, `-`, `_` and `.`** —
  your device id is the obvious one. A client whose id has `+` or `#` in it
  is refused everything such an account is allowed.

A device that holds its own account and one that holds `gethome` are the same
device to the hub and to the apps; nothing you publish says which it is. The
shared account goes on working, with its password unchanged, for everything
that already has it.

> **MQTT or the API?** This convention is for a thing that **is** a device — a
> board with a relay on it, a sensor, a bridge that presents other hardware as
> devices. Software that **uses** the home — a dashboard, a script that switches
> the porch light at dusk, a bridge to another system, an AI agent — wants an
> [API key](api.md#api-keys) and the REST API instead: it works for every
> protocol rather than only for what is on this broker, it is narrowed to what
> you give it, and revoking it takes effect on the next request rather than
> after a trip round every board that knows a password. See
> [integrations.md](integrations.md).

> **A hub installed before this** takes anonymous connections and needs no
> credentials. Updating it closes the broker and prints a warning saying so —
> at which point anything you had wired in needs the username and password
> above. Nothing else about the convention changed.

## Topics

`<deviceId>`: `[A-Za-z0-9_-]`, 1–64 chars.

| Topic | Direction | Payload |
|---|---|---|
| `gethome/discovery/<deviceId>/config` | device → hub, **retained** | discovery document (below) |
| `gethome/device/<deviceId>/state` | device → hub, retained recommended | canonical **state patch** for endpoint 1 |
| `gethome/device/<deviceId>/state/<endpointId>` | device → hub | per-endpoint state patch |
| `gethome/device/<deviceId>/availability` | device → hub, retained | `online` / `offline` — set as your MQTT **LWT** |
| `gethome/device/<deviceId>/heartbeat` | device → hub, **retained** | how often you speak, in whole seconds (`60`), published that often — optional ([Staying online](#staying-online)) |
| `gethome/device/<deviceId>/set` | hub → device | canonical **command** for endpoint 1 |
| `gethome/device/<deviceId>/set/<endpointId>` | hub → device | per-endpoint command |
| `gethome/device/<deviceId>/camera[/<endpointId>]` | device → hub, **retained** | the streams a camera serves ([Cameras](#cameras)) |
| `gethome/device/<deviceId>/program` | device → hub, **retained** | a JSON object saying the device is a program, and on which computer (`{"host":"nuc.local"}`) — optional ([A device that is a program](#a-device-that-is-a-program)) |

Publish an **empty retained payload** to the config topic to remove the
device.

**The hub does the same when somebody deletes the device in an app**: it clears
the retained config (and any heartbeat, camera and program topics), so the
device doesn't come back on the hub's next boot. A device that subscribes to
its own config topic hears that as a live empty message — its cue to stop
announcing itself until it is set up again, rather than putting itself straight
back. Its own retained config arriving on that subscription is not a deletion.
(A device that is switched off at that moment misses it, and an empty retained
message leaves nothing behind for it to hear later. One that holds the shared
`gethome` account therefore comes back when it is switched on. One that holds
[an account of its own](#a-devices-own-account) does not: the account went
with the device, and the broker refuses it.)

### A project's own topics (`gethome/project/<key>/…`)

The hub reads only the topics above, and anything else under `gethome/` is
ignored. One branch of that is set aside for you: **`gethome/project/<key>/…`
belongs to a project**. A thing you build is often more than one part — a board
with a camera and a program on a computer that looks at its pictures, say, or
two boards that work as a pair — and the parts need somewhere to talk to each
other that is not the home's device topics. The hub never acts on anything
under `gethome/project/` and does not claim it, so what a project's parts agree
to say there is theirs: any levels below the key, any payload.

`<key>` is the project's own, chosen by whoever builds it: one topic level of
letters, digits, `_` and `-`, like a device id. Keep it **stable** — the same
when the project is renamed or copied elsewhere — because a board flashed today
has to find a program deployed next month, and a key derived from a name stops
matching the first time the name changes.

**It is a place, not a lock.** The `gethome` account can read and write
everything under `gethome/`, so every board in the house and anything else
holding that password can read and write every project's topics too, and
anybody in the home allowed to watch the broker sees them go by. It keeps
projects out of each other's way; it does not keep anybody out. So **never put
a secret there** — a password, an API key, a token — and never retain one: a
retained message is handed to every client that subscribes later, for as long
as the broker keeps it. Retain only what a part that connects later needs at
once, and clear it with an empty retained message when the project goes.

A part that holds [an account of its own](#a-devices-own-account) is narrower:
it reaches the topics of the one project whose key it was given, and no other
project's — and none at all if it was given no key. That keeps the parts of one
project from reading or driving another's. It still is not a lock, for the
reason above: whatever holds the shared `gethome` password reaches every
project's topics as it always did.

## Staying online

Your last will is how the hub hears that you have gone: the broker publishes
your `offline` once your keepalive has run out, one and a half keepalives
with nothing from you. A keepalive of 15–60 s is right; the shorter it is,
the sooner an unplugged device reads offline.

**Only a broker that is running can send a will.** When the hub itself loses
power, its broker comes back from the copy it last saved, still holding your
retained `online`. A device switched off in the meantime has no connection
left for the broker to time out, so nothing would ever say `offline`, and it
would read online until it is switched on again.

So say how often you speak. Publish a whole number of seconds (10–3600; `60`
suits most devices), retained, to `gethome/device/<deviceId>/heartbeat` when
you connect and that often afterwards. A device that has said so and then
stays silent for two and a half of those intervals, never less than 30 s, is
marked offline as its will would have marked it. Anything it publishes on its
own topics brings it back. What the broker hands over from what it already
holds doesn't count as you speaking, since after a restart it can be hours
old. An empty retained payload withdraws the heartbeat. A hub from before
heartbeats doesn't subscribe to the topic, and a device that never publishes
one is judged by its will alone.

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
topic:  gethome/device/pool-pump/heartbeat     → "60"       (and again every 60 s)
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
patch per press — **not retained**: a retained press is handed back to the hub
every time it reconnects, and fires automations again each time:

```
gethome/discovery/workshop-button/config →
  {"name":"Workshop button",
   "endpoints":[{"endpointId":1,"deviceKind":"remote","capabilities":["event","battery"],"primary":"event"}]}

gethome/device/workshop-button/state (retained) →
  {"event":{"buttons":[{"id":"main","label":"Button","gestures":["single","double","hold"]}]}}

gethome/device/workshop-button/state (per press, not retained) →
  {"event":{"action":"double","button":"main","gesture":"double"}}
```

The hub stamps `event.at` (epoch ms) on arrival when the press doesn't carry
one, so every press — including identical repeats — reaches the apps as a
state change. Gesture ids follow [device-schema.md](device-schema.md)
(`single`, `double`, `triple`, `hold`, `release`, …); free-form gestures are
allowed and shown as-is.

## Generic controls for anything else (the `custom` capability)

For a parameter that fits no dedicated capability, declare the `custom`
capability and publish its field inventory + values — the apps render
universal toggle/slider/select/value controls, and writes arrive as
`{"type":"setCustomField","fieldId":…,"value":…}`:

```
gethome/discovery/pump/config →
  {"name":"Pool pump","endpoints":[{"endpointId":1,"deviceKind":"appliance",
    "capabilities":["onOff","custom"],"primary":"onOff"}]}

gethome/device/pump/state →
  {"onOff":true,
   "custom":{
     "fields":[{"id":"schedule_mode","label":"Schedule","control":"select",
                "options":[{"value":"eco","label":"Eco"},{"value":"turbo","label":"Turbo"}],"settable":true}],
     "values":{"schedule_mode":"eco"}}}

gethome/device/pump/set ← {"type":"setCustomField","fieldId":"schedule_mode","value":"turbo"}
```

Your device receives the intent and applies it. This lets a DIY device expose
*any* knob without a new capability.

## Cameras

A camera on the home network — an ESP32-CAM, say — shows up in the apps through
the hub. Declare the endpoint as an ordinary device (device kind `camera`) with
an ordinary capability — `onOff` for its light, or a `custom` value — and
**never declare `camera`**: the hub adds that capability itself, and a hub from
before cameras refuses a discovery document naming it. Then announce what it
serves, retained, on its camera topic:

```
gethome/device/porch-cam/camera →
  {"streams":[
    {"id":"still","kind":"snapshot","label":"Still","width":640,"height":480,"url":"http://192.168.1.31/snapshot"},
    {"id":"live","kind":"mjpeg","label":"Live","width":640,"height":480,"url":"http://192.168.1.31:81/stream"}]}
```

Publish it again whenever the device's address changes, and an empty retained
payload to withdraw it.

- **`kind`** is `snapshot` (a GET that answers one `image/jpeg`) or `mjpeg` (a
  `multipart/x-mixed-replace` stream of JPEGs). A stream of another kind is
  ignored, not refused, so a newer device still works with an older hub.
- **`url`** must be plain `http://` to the camera's **private IPv4 address** —
  not a name, not `https`, no user name or password in it. Anything else is
  dropped. One of the hub's own addresses is refused when the picture is asked
  for, so a camera is not served from the hub's own machine.
- **An announcement is read stream by stream**: at most 8 an endpoint, each
  with an `id` of its own (1–32 characters of `[A-Za-z0-9_-]`), a `url` of at
  most 512 characters and, optionally, a `label` (at most 60) and a `width`
  and `height` (whole numbers, 1–10000). One the hub will not serve is dropped
  by itself, with a line in the hub's log, and the others stand.
- **Prove it is you**: the hub fetches nothing until
  `GET http://<camera>/gethome/id` (asked on the stream's own port, then on
  port 80) answers `{"id":"<deviceId>"}` with this device's id.
- **One viewer at a time is fine**: the hub opens one connection per stream and
  shares it with everybody watching, so a board that serves a single client
  serves the whole house.

The apps never see the address: the endpoint's state carries the streams' ids,
kinds and sizes, and a phone fetches them from the hub
(`GET /api/v1/cameras/…`, [api.md](api.md)), which needs the `camera.view`
permission. Nothing is recorded.

## A device that is a program

Not every device is a board. A script that publishes a reading it worked out,
a bridge that presents other hardware, a service running on a computer in the
house: each can be a device on this convention, and to the hub it is one like
any other. A program that wants to be shown for what it is says so, retained,
on its program topic:

```
gethome/device/tide-table/program  →  {"host":"nuc.local"}
```

Publish it on every connection, with the rest. It may go out before or after
the discovery document: the hub keeps one that arrives first.

- **`host`** is the name of the computer the program runs on, **for people to
  read** — 1–120 characters once the spaces around it are trimmed, and a longer
  one is cut to 120. It is never an address the hub connects to, and never the
  place for a secret. It is optional: `{}` says "a program", on a computer it
  didn't name, and so does a `host` that is empty.
- **Keys the hub doesn't know are ignored**, never an error, so a program that
  says more than this hub reads still works with it.
- **An empty retained payload withdraws it**, and the device is hardware again.
- A payload that isn't a JSON object, or a `host` that isn't a string, is
  ignored with a line in the hub's log. It never rejects or removes the device.

The hub hands it to the apps with the device — `program` on the device's wire
([api.md](api.md#device-wire-shape-get-devices-item)) — which is what lets an
app say that this one is a program, and where it runs, rather than drawing it
as a board. Nothing else about the device changes: its state, its commands,
its availability and its heartbeat are any device's. The hub keeps it in
memory only and learns it again from the retained message after a restart.

A board says nothing here, and nothing changes for it. A hub from before this
doesn't subscribe to the topic and shows the device as it shows any other —
which is why this is a topic of its own rather than a key in the discovery
document, where a hub that had never heard of the key would refuse the whole
device.

This is for a program that **is** a device. One that only **uses** the home —
reads it, switches what is already there — is not a device at all, and wants
an API key instead ([MQTT or the API?](#connecting)).

## Rules & tips

- **Units are canonical**, not native: centi-°C, mireds, percent-100ths with
  0 = open, milliwatts. The full table is in
  [device-schema.md](device-schema.md).
- Retain your config, availability, and state topics so the hub recovers your
  device after a restart without waiting for your next publish. **A retained
  state message is the endpoint's whole current state**, every sub-object
  complete — `level`, `colorTemperature`, `thermostat`, `fan` and `covering`
  are filled in with defaults where you leave a field out, and the defaults are
  stored over what the hub had. `sensors` is the one partial that merges
  safely.
- **Discovery first**: the hub drops state for a device it hasn't met yet.
- Never publish `reachable` — availability is the hub's to work out from your
  availability topic.
- One physical device with several functions = one deviceId with several
  endpoints, not several devices.
- The broker is LAN-internal; don't expose 1883 to the internet. It asks for
  the credentials in [Connecting](#connecting) — set your MQTT client's
  username and password, not just its host.
- A device that holds [an account of its own](#a-devices-own-account) can
  publish and subscribe under its own id only. If it must watch another device
  or a Zigbee sensor, it is not a device on this convention any more but
  software using the home, and wants an [API key](api.md#api-keys).
