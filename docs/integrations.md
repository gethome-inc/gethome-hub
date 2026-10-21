# Building on a hub

Two ways to bring your own things into a gethome home, and they are for
different jobs:

- **A thing that *is* a device** — a board with a relay on it, a sensor you
  soldered, a bridge that presents other hardware as devices — joins over MQTT,
  with no code on the hub. → [The MQTT convention](mqtt-integrations.md)
- **Software that *uses* the home** — a dashboard, a script that switches the
  porch light at dusk, a bridge to Home Assistant or Node-RED, an exporter for
  Grafana, an AI agent — talks to the hub's REST and WebSocket API with an
  **API key**. That is this page.

The hub is on your own network and answers only there. Everything below runs on
a machine in the same house — a laptop, a server in a cupboard, the Pi itself.

## Get a key

**Check the hub has them.** `GET /api/v1/hub` needs no credential and carries
`apiKeys` on a hub that takes keys:

```sh
curl -s http://<hub>:8420/api/v1/hub
# … "apiKeys": {"grantable": ["device.edit", "device.add", …]} …
```

No `apiKeys` there means the hub is running a build from before keys — update it
(`sudo gethome-hubctl update` on the hub, or *Update* in an app) and look again.

**Make one** as yourself — a key acts as the member who made it, and it is
yours to revoke. An app that offers API keys makes one in a few taps. Without
one, `POST /api/v1/api-keys` with a member token of your own does the same:

```sh
curl -s -X POST http://<hub>:8420/api/v1/api-keys \
  -H "Authorization: Bearer $MEMBER_TOKEN" -H 'content-type: application/json' \
  -d '{"name": "Porch light script", "control": true, "expiresInDays": 365}'
```

and a member token of your own comes from a **sign-in code** — the code that puts
you on another device as yourself rather than as a new person (in gethome
studio, **Add device** on your own row in the People tab) — claimed with
`POST /api/v1/pair {"code": "…", "memberName": "…"}`. Making keys needs
`hub.apikeys`, which Owner and Member hold and Guest does not.

**Decide what it may do, and give it no more.**

| You ask for | It may |
|---|---|
| nothing | read everything you can read: devices and their state, rooms, rules, history |
| `control: true` | also work the home: commands (**locks included**), pressing scenes, switching modes, pinning favorites |
| `permissions: [...]` | also do those things, from the hub's `grantable` list: rename and move devices, add or remove them, look through the cameras (`camera.view`), change rooms, rename the home, read everybody's activity, write rules (`automation.manage`, which needs `control`), switch the radio, update the hub |

A key can never be given more than you have yourself, and never anything that
mints a credential, changes who is in the home, reads a conversation, or touches
the home's AI or broker keys. `expiresInDays` (1–3650) is optional; leave it out
for a key that does not expire. **Start read-only**: a dashboard needs nothing
more, and a key that can only read cannot be talked into anything.

**`camera.view` is the one to think twice about.** A key holding it sees every
camera in the home, at any hour, and the hub keeps no record of each look —
give it only to software you trust with every camera in the house. Stills are
the cheap way to watch: each is one request under the key's rate limit. A key
may hold only one live stream open at a time, and never the hub's last free
one, so a phone can always open the porch camera; joining a stream that is
already open is always allowed ([api.md](api.md#cameras)).

**The secret is shown once**, as `gethome_` and 43 letters and digits. The hub
keeps only its hash — lose it and make another.

**Keep it like a password.** Put it in an environment variable or your secret
store, never in code, a URL, a web page, a repository, a forum post or a
conversation with an AI:

```sh
export GETHOME_HUB_URL=http://192.168.1.50:8420
export GETHOME_API_KEY=gethome_…
```

Revoking it — from an app, or `DELETE /api/v1/api-keys/<id>` — stops it on the
next request and hangs up its open connections. The home can see each key's
last use, the address it came from and the last thing the hub refused it.

## First requests

Send the key as a bearer token, never in a query string (the hub refuses that
on everything but the WebSocket):

```sh
auth=(-H "Authorization: Bearer $GETHOME_API_KEY")

# Who am I, and what may this key do?
curl -s "${auth[@]}" "$GETHOME_HUB_URL/api/v1/me"

# Every device, with its typed state.
curl -s "${auth[@]}" "$GETHOME_HUB_URL/api/v1/devices"

# Switch a light on — endpoint 1 of a device, a canonical command.
curl -s -X POST "${auth[@]}" -H 'content-type: application/json' \
  -d '{"type":"power","on":true}' \
  "$GETHOME_HUB_URL/api/v1/devices/<deviceId>/endpoints/1/commands"
```

Things that will save you an evening:

- **Units are the schema's, not the ones on the box.** Brightness is a level
  1–254, colour temperature is in mireds, temperatures are hundredths of a
  degree (2150 is 21.5 °C), a covering at 0 is *open*. → [The device schema](device-schema.md)
- **`202` means the hub routed the command, not that the device did it.** A
  write that never lands arrives later as a `commandFailed` frame on the
  WebSocket; the device's new state arrives as a `state` frame.
- **Ask `GET /me`, don't guess.** Through a key it carries `apiKey: {control,
  permissions, state, expiresAt}` and `permissions` is what the key may do now —
  which narrows by itself if your own role does.
- **A refusal says what to fix.** `403 {error:"forbidden", permission}` — the key
  was not given that; `403 {error:"key_read_only"}` — it has no `control`;
  `403 {error:"key_not_allowed"}` — no key may do this, a person has to;
  `401 {error:"unauthorized", reason}` with `key_expired`, `key_suspended` (your
  role no longer lets you have keys) or `key_in_query`; `429 rate_limited` with
  `Retry-After`. → [Errors](api.md#errors)
- **A `404` from a route this page names means the hub is older**, not that you
  are wrong. Capabilities are read from what `GET /hub` carries, never inferred
  from a version number.

## Live updates

Polling a Raspberry Pi Zero every second is the slowest way to see a light come
on, and a key is rate-limited (50 at once, 10 a second) for exactly that reason.
Open the WebSocket instead:

```js
// Node 22, with the `ws` package: npm install ws
import WebSocket from 'ws';

const socket = new WebSocket(`${process.env.GETHOME_HUB_URL.replace('http', 'ws')}/api/v1/ws`, {
  headers: { authorization: `Bearer ${process.env.GETHOME_API_KEY}` },
});

socket.on('message', (data) => {
  const frame = JSON.parse(String(data));
  if (frame.type === 'hello') console.log('connected to', frame.name, 'as', frame.apiKey?.name);
  if (frame.type === 'state') console.log(frame.deviceId, frame.endpointId, frame.state);
  if (frame.type === 'commandFailed') console.warn('did not land:', frame.deviceId, frame.detail);
});

socket.on('close', (code) => {
  // 4001: the key is no good any more — revoked, expired or paused. Stop.
  // Anything else: reconnect with a backoff, then re-read GET /devices.
  console.log('closed', code);
});
```

Every frame and the rules for reconnecting are in [the API](api.md#websocket). A
key holds at most five streams at once; it hears device state, structure and the
activity it may read, and — if it subscribes to `automations` — rules firing,
but never a conversation.

The same thing in Python, with nothing but the standard library for the REST
half:

```python
import json, os, urllib.request

HUB = os.environ["GETHOME_HUB_URL"]
KEY = os.environ["GETHOME_API_KEY"]

def call(method, path, body=None):
    request = urllib.request.Request(
        f"{HUB}/api/v1{path}",
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request) as response:
        raw = response.read()
        return json.loads(raw) if raw else None

for device in call("GET", "/devices"):
    print(device["name"], device["online"])
```

## What a key's actions look like to the home

Everything a key does is written down as you, through it: the activity feed
reads *Anna’s “Porch light script” · Porch light: power* rather than as if your
phone had done it at sunset. That is also how to find a script that is
misbehaving — and the reason to give each integration a key of its own and a
name that says what it is.

## MQTT or the API?

| | MQTT convention | API key |
|---|---|---|
| For | something that **is** a device | software that **uses** the home |
| Reaches | what is on this hub's broker | every device, every protocol, rooms, rules, history |
| Credential | the broker's integration account, shared by every board that has it | one key per integration, narrowed to what you gave it |
| Taking it back | a new password, on every board | revoke the key — the next request fails |

A board can of course be both: a device over MQTT that also reads the home
through a key.

## With an AI coding agent

This repository publishes two [agent skills](../skills/README.md), so a coding
agent knows the API, the device schema and the MQTT convention without being
walked through them — and the rules that come with them: keep the key out of
the conversation, ask before unlocking a door or switching on a rule it wrote,
and read what a hub can do from what it advertises rather than from its
version.

- **`gethome-hub-api`** — software that uses a home, through an API key.
- **`gethome-mqtt-device`** — firmware that makes a board a device: ESPHome,
  Arduino, MicroPython or Python.

```sh
npx skills add gethome-inc/gethome-hub
```

installs them for Claude Code, Codex, Cursor and the other agents that read
[Agent Skills](https://agentskills.io), copying the two skill folders and
nothing else; `npx skills update` brings them up to date. Neither needs this
repository or a hub's source beside it.

Then give the agent the hub without giving it the secret: set `GETHOME_HUB_URL`
and `GETHOME_API_KEY` in the shell you start it from, with a key made for the
job — read-only for a dashboard, `control` and nothing else for a script that
switches lights. What the agent's code does appears in the activity feed under
the key's name, and revoking the key stops it on its next request.
