# MCP server

The hub speaks the **Model Context Protocol**, so an assistant — Claude, or
anything else that speaks MCP — can look at the home and work it. This document
is canonical for `src/mcp/` and for the setup instructions both apps render.

Everything here is a face on capability the hub already had: there is no device,
room or command MCP can reach that [api.md](api.md) cannot. What MCP adds is a
vocabulary a language model can use without holding this repository's unit
conventions in its head, and an answer that says whether a device actually did
the thing.

**It is off until somebody turns it on**, and it is LAN-only like the rest of
v1 — which decides who can use it, so read
[Reaching the hub](#reaching-the-hub) before choosing a client.

## Switching it on

1. Turn the server on. Any of the three apps will do it — GetHome on iOS under
   **Home Settings → Hub → Assistants**, GetHome Studio's **Assistants** tab, or
   the route directly. It needs `hub.mcp`, which is owner-only by default.
2. Mint a connection. The response carries the token **once**; the hub stores
   only its hash and no route reads it back.
3. Point a client at it — see [Connecting a client](#connecting-a-client).

The wire format:

```
PUT /api/v1/settings/mcp
{ "enabled": true }
→ { "enabled": true, "tokens": [] }

POST /api/v1/settings/mcp/tokens
{ "label": "Claude Desktop on the MacBook", "canControl": true }
→ 201 { "id", "label", "canControl", "createdAt", "lastUsedAt": null,
        "token": "ghm_…" }        ← the only time this field is ever sent
```

One request proves the whole path — no client, no config file:

```sh
curl -sX POST http://<hub>:8420/api/v1/mcp \
  -H 'Authorization: Bearer ghm_…' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

A list of seven tools means it works. A `404` means MCP is off; a `401` means
the token is wrong — see [When it doesn't work](#when-it-doesnt-work).

## Reaching the hub

This is the part people get wrong, and the answer is not the same for every
assistant. The hub is a device on a home network with a private address and
plain HTTP. Some clients dial it themselves and some do not:

| Client | Reaches `http://<hub>:8420` | How |
|---|---|---|
| **Claude Code** | yes | native HTTP transport with a header |
| **Claude Desktop** | yes, through a bridge | its config takes stdio servers only, so `mcp-remote` proxies |
| **Codex CLI / Codex IDE** | yes | `~/.codex/config.toml`, `url` + `bearer_token_env_var` |
| **ChatGPT** (app and web) | **no** | connectors are stored account-side and **OpenAI's servers make the call** |
| **claude.ai** (web) | **no** | Anthropic's servers make the call; public HTTPS and OAuth only |

The last two rows are not a limitation of this hub. Those products connect to a
connector *from their own infrastructure*, so no amount of work here makes a
`192.168.x.x` address reachable from them — they need a public HTTPS URL, which
means a tunnel. The one worth naming is OpenAI's own
[Secure MCP Tunnel](https://github.com/openai/tunnel-client): an outbound-only
relay that long-polls OpenAI and forwards to a private address, so it opens no
inbound port. **Run it on the Mac, not on the Pi** — it only has to be
somewhere that can already reach the hub, and the hub has no memory to spare.

That is also why the token can travel in a URL: a tunnelled client is usually
one you can hand a URL and nothing else.

## Connecting a client

`<hub>` is the hub's address on the network and `ghm_…` is a token from
`POST /settings/mcp/tokens`.

**Claude Code** — native HTTP, no bridge:

```sh
claude mcp add --transport http gethome \
  http://<hub>:8420/api/v1/mcp \
  --header "Authorization: Bearer ghm_…"
```

**Claude Desktop** — its config takes stdio servers only, so it goes through
`mcp-remote`. This is the whole of `claude_desktop_config.json`; if yours
already has an `mcpServers` block, put the `gethome` entry inside it rather than
pasting a second one:

```json
{
  "mcpServers": {
    "gethome": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://<hub>:8420/api/v1/mcp",
               "--allow-http", "--header", "Authorization:${AUTH}"],
      "env": { "AUTH": "Bearer ghm_…" }
    }
  }
}
```

Two details are load-bearing and **both fail silently** if got wrong.
`--allow-http` is needed because the hub is plain HTTP on the LAN. And the
header must be written **with no space around the colon**, with the value coming
from `env`: `mcp-remote` mangles spaces inside arguments, so the obvious
`"Authorization: Bearer ghm_…"` form is passed through wrong and the hub sees no
credential at all.

**Codex CLI / Codex IDE** — `~/.codex/config.toml`:

```toml
[mcp_servers.gethome]
url = "http://<hub>:8420/api/v1/mcp"
bearer_token_env_var = "GETHOME_MCP_TOKEN"
```

**ChatGPT** — cannot reach a LAN address; see
[Reaching the hub](#reaching-the-hub). Run OpenAI's `tunnel-client` on a machine
that can, then add the tunnel in ChatGPT's developer mode. Note that
write-capable custom connectors are limited to Business, Enterprise and Edu
plans and are off until an admin enables them, so on a personal plan the read
tools work and `control_device` may not.

**Anything else** that speaks Streamable HTTP: `POST` to
`http://<hub>:8420/api/v1/mcp` with `Authorization: Bearer ghm_…`, or
`POST` to `http://<hub>:8420/api/v1/mcp/t/ghm_…` if the client only takes a URL.

## When it doesn't work

| Symptom | Cause | Fix |
|---|---|---|
| `404` from `/api/v1/mcp` | MCP is switched off, or the hub predates it | `PUT /settings/mcp {"enabled":true}`; if that 404s too, update the hub |
| `401` with a token that looks right | it is a *member's* token, or it has been revoked | mint an MCP token — the two are different tables and neither works on the other's routes |
| `403` on `/settings/mcp` | your role lacks `hub.mcp` | an owner grants it, or does it for you |
| Claude Desktop connects, every call 401s | the `mcp-remote` header was written with a space | use the `env` form above, exactly |
| Claude Desktop won't connect at all | no `--allow-http`, against a plain-HTTP hub | add it |
| `control_device` answers "this connection can only look" | the connection was minted read-only | mint a new one with control; the mode is fixed at mint time |
| A tool says a device name matches several | two devices share a name | call again with the `ref` from the list it gave you |
| ChatGPT can't see the hub at all | its connectors are called from OpenAI's servers | a tunnel; see [Reaching the hub](#reaching-the-hub) |
| A command says "sent … has not reported back yet" | not an error — a sleeping battery device | press the device's button, or wait for its next report |

## The tools

Seven. Small on purpose: a model choosing between seven well-named tools is
more reliable than one choosing between thirty, and each of these answers a
question somebody actually asks of a house.

| Ask | Runs |
|---|---|
| "What's in this home?" | `get_home` |
| "Is anything still on downstairs?" | `list_devices {room:"Living room", state:"on"}` |
| "Is the back door locked?" | `find_device` → `get_device` |
| "Turn the kitchen light down to 30%" | `control_device {action:{action:"brightness", percent:30}}` |
| "How cold did the nursery get last night?" | `get_device_history {quantity:"temperature", range:"day"}` |
| "Did anyone unlock the front door today?" | `get_activity` |

Shapes below use `?` for optional and `=` for a default. They are schematics;
the normative definition is the zod schema in `src/mcp/catalog.ts`.

### get_home

The home as a whole. The orientation call — start here when you do not yet know
what the home contains.

```
Input   { }
Returns { name, hubVersion, hubBuild?, deviceCount, onlineCount, runningCount,
          rooms: [{ name, zone, devices }], devicesWithNoRoom? }
```

### list_devices

Every device, one line each. Returns a summary per device rather than full
state — see [why it is shallow](#list_devices-is-deliberately-shallow).

```
Input   { room?, kind?, state?: "on" | "off" | "offline", search? }
Returns { devices: [{ id, ref, name, room, zone, kind, online, state }],
          total, truncated }
```

`state` is a readable line rather than a structure: `"on · 79%"`,
`"22.4 °C · 48% humidity"`, `"locked"`, `"offline"`. `room` and `zone` are null
when the device is in neither. Capped at **200** rows; `truncated` says when
that bit.

### get_device

One device in full: every reading in ordinary units, and which actions it will
accept.

```
Input   { device }
Returns { id, ref, name, room, zone, kind, online, state,
          vendor, model, transport, batteryPercent?,
          endpoints: [{ endpointId, kind, capabilities, readings, actions }] }
```

`readings` keys name their own unit, so nothing has to be inferred. An absent
reading is an absent key — "this device does not measure humidity" and
"humidity is zero" are different facts. The common ones:

| Key | Unit |
|---|---|
| `on`, `playing`, `motionDetected`, `contactClosed` | boolean |
| `brightnessPercent`, `saturationPercent`, `fanPercent`, `batteryPercent`, `humidityPercent` | 0–100 |
| `openPercent` | 0–100, **100 is fully open** |
| `colorTemperatureKelvin`, `hueDegrees` | kelvin, degrees |
| `temperatureC`, `thermostatTemperatureC`, `heatingSetpointC`, `coolingSetpointC` | °C |
| `powerWatts`, `energyKilowattHours`, `illuminanceLux`, `pressureHPa`, `co2Ppm` | as named |
| `lock`, `fanMode`, `thermostatMode`, `airQuality`, `smokeAlarm` | a word, not a number |
| `settings` | the device's generic fields: `{ id, label, unit, settable, value, options?, min?, max? }` |

**A thermostat's own reading has its own key.** A radiator valve reports two
temperatures — the room, and the valve head's idea of it — and both used to be
written to `temperatureC`, where the second overwrote the first and left no key
holding it. `thermostatTemperatureC` is the device's own; `temperatureC` is the
ambient sensor's, falling back to the thermostat's when a device has no separate
sensor, so a plain thermostat still answers under the name a model looks for and
one carrying both loses neither. The one-line `state` labels the thermostat's
half for the same reason: `thermostat 19.8 °C · 21.5 °C` rather than two bare
numbers.

`src/mcp/devices.ts` is the full list. `actions` is derived from the
capabilities the device actually reports, so a model is never invited to send a
command the hub would refuse.

### find_device

Search by name, room or kind. Use it before `control_device` when a name might
be ambiguous.

```
Input   { query }
Returns { devices: [ … same rows as list_devices … ] }
```

### control_device

Work a device. Needs a connection minted with `canControl`. The answer says
whether the device **confirmed** the change — see
[what a command result promises](#what-a-command-result-promises).

```
Input   { device, action }
Returns { ok, summary, state? }
```

Every action is in ordinary units:

| `action` | Fields | Notes |
|---|---|---|
| `on` · `off` · `toggle` | — | `toggle` is resolved against known state, so the answer says which it did |
| `brightness` | `percent` 0–100 | does **not** switch the light on |
| `color_temperature` | `kelvin` 1000–10000 | warm ≈ 2200, daylight ≈ 6500 |
| `color` | `hueDegrees` 0–360, `saturationPercent` 0–100 | |
| `thermostat` | `heatingC?`, `coolingC?`, `mode?`: `off`\|`auto`\|`cool`\|`heat` | **exactly one per call**; naming two is refused |
| `lock` · `unlock` | — | |
| `covering` | `openPercent` 0–100 | **100 is fully open** |
| `covering_open` · `covering_close` · `covering_stop` | — | |
| `fan` | `percent` 0–100 | |
| `fan_mode` | `mode`: `off`\|`low`\|`medium`\|`high`\|`on`\|`auto` | |
| `play` · `pause` | — | |
| `set_mode` | `mode` 0–255 | for mode-select and vacuum run modes |
| `ir_send` | `commandId` | an id from the device's `irCommands` |
| `setting` | `fieldId`, `value` | a generic field from `readings.settings` |

**A thermostat action takes exactly one field, and naming two is refused rather
than ranked.** A setpoint and a mode are separate commands on the device and
this tool sends one, so "set the thermostat to heat at 21" — one natural call
carrying `heatingC` *and* `mode` — used to send the setpoint and drop the mode
with nothing recorded, then answer "the valve is now …", which reports the whole
instruction as done. Silently doing half of what was asked is the one outcome a
model cannot recover from, because nothing tells it to. The refusal names the
three fields and says to send one call each.

### get_device_history

What one measurement did over a window. The hub records five-minute buckets and
keeps about a week, so anything older is gone.

```
Input   { device, quantity, range = "day", points = 60 }
Returns { unit, bucketMs, start, end, retentionDays,
          points: [{ at, min, max, avg }, …] }
```

`quantity` is one of `temperature`, `humidity`, `illuminance`, `pressure`,
`co2`, `pm25`, `flow`, `power`, `battery`, `thermostatTemperature`.
`range` is `hour`, `day` or `week`; `points` is 2–200.

A point is a stretch of time `bucketMs` wide starting at its own `at`, so it
carries a low and a high as well as a mean — drawing only the mean flattens a
lamp that went on and off inside one bucket. A bucket nothing was reported in is
simply absent, so a gap in the array is a real gap.

**Both axes are converted here, and the time one was the half that got missed.**
`src/core/history.ts` stores what the sensor reported in the hub's own scale — a
temperature is `centiCelsius` — because a stored average cannot be merged, so
every client converts on read and `unit` is `°C` with numbers to match.
`test/mcp-coverage.test.ts` checks that against what the hub actually records,
so a new quantity in a new unit fails the suite until something can show it.

The same rule governs `at`. On the REST wire a point's first element is an
*offset into the emitted grid* — an integer index, not a time — and handing that
to a model beside a `start` in epoch ms is `centiCelsius` wearing a different
unit: the obvious reading, `start + offset`, is wrong by a factor of `bucketMs`.
So the grid is resolved here and every point carries an ISO `at`, which is the
word `get_activity` uses for the same idea. `start` and `end` are ISO too.

The text summary names **when** the low and the high happened, because "when was
it coldest?" is the question a chart gets asked and a bare low/high/average
cannot answer it.

### get_activity

The home's recent history, newest first. Each line is the hub's own sentence,
including things done from a phone or by another assistant.

```
Input   { limit = 20 }        (max 50)
Returns { entries: [{ at, kind, message }] }
```

**Narrowed by the minting member's `activity.read`, exactly as the REST route
is.** That permission never refuses the feed — a member without it still reads
their own rows, which is what keeps a guest's Recent screen working — so an
assistant sees precisely what the person who connected it sees, and no more. It
is the only permission any tool consults, and the reason the whole
`AccessService` is on `McpContext` rather than a resolved boolean: the next one
should be a call, not another field threaded through the seam.

### Naming a device

Hub ids are UUIDs, which a model will mistype. The `device` parameter therefore
accepts **any** of:

- the full id — `9fdbdea9-71b6-4930-81da-aae7a6c347de`
- a **≥6-character unique prefix** of it, which every list returns as `ref`
- the device's **name**, case-insensitively, whole or as a substring

**Ambiguity is refused, never guessed.** Two lamps called "Lamp" in two rooms is
an ordinary home, and switching the wrong one is a worse outcome than one more
round trip — so the answer names the candidates with their rooms, which is
exactly what a model needs to ask a better question.

### `list_devices` is deliberately shallow

It returns a line per device, not the full endpoint state. Forty devices of
typed state is 40–80 KB of JSON and twenty thousand tokens of a model's context
spent before it has decided which device it cares about. The list carries a
sentence; `get_device` carries the picture.

### What a command result promises

`POST /devices/:id/commands` answers 202 because routing is all it does — the
Zigbee adapter publishes to MQTT and the broker takes the message long before
the device does. The truth arrives afterwards on the bus, as a `stateChanged`
or a `commandFailed` (see [zigbee.md](zigbee.md)).

So `control_device` sends, then waits up to **1.5 seconds** for one of those,
and answers with whichever happened:

- **the device reported new state** — it worked, and the summary says what the
  device now *is*. The report has to come from the endpoint that was commanded:
  a two-gang switch is one device with two endpoints, and its other gang
  reporting is not news about this one;
- **the hub reported a failure** — it did not, and the summary is the protocol's
  own words rather than a paraphrase, because only the adapter knows what
  "unreachable" meant here;
- **nothing came back in time** — *neither*, and the answer says so. On a
  battery device zigbee-herdsman queues the write until the sensor next wakes,
  which can be an hour, so the summary names that and says pressing the device's
  button wakes it. That advice is added only when the device actually reported a
  battery: a mains plug is always listening, and its button is its relay.

Reporting success from the 202 would be the exact lie both apps used to tell
before `commandFailed` existed.

### Annotations

Every tool publishes `readOnlyHint`, `destructiveHint`, `idempotentHint` and
`openWorldHint`, and the values are not decoration — hosts use them to decide
whether to interrupt the person and ask before running something. The spec's
defaults are `destructiveHint: true` and `openWorldHint: true`, so a tool that
says nothing is treated as though it might destroy something in an unbounded
world: left unset, asking "is the back door locked?" would prompt for
confirmation. `control_device` sets `destructiveHint: false` because switching a
lamp is reversible, and `openWorldHint: false` because the set of devices is
closed and known.

### Errors

Two kinds, and they are answered differently on purpose.

A **protocol** fault is a JSON-RPC error the model never sees: no such tool
(`-32601`), arguments that do not fit the schema (`-32602`), a malformed body
(`-32700`), a bad envelope or a batch (`-32600`).

A **tool** that ran and could not do the thing answers normally, with
`isError: true` and a sentence in `content` — because the model is meant to read
the reason and try something else. "There is no device called that" is the
second kind, which is why device lookup returns a sentence rather than throwing.

### Every control is written to the home's history

`control_device` records a `device.command` entry with `data.via = "mcp"` and
`data.client = <the token's label>`, attributed to the member who minted the
token. Both apps render it with no change, and "the kitchen light went off by
itself" is exactly the question the log exists to answer.

## Units

**Every tool speaks the units a person speaks** — percent, °C, kelvin, degrees
and named modes. The wire units in [device-schema.md](device-schema.md) never
appear in a tool schema or a tool answer; conversion happens in
`src/mcp/devices.ts` and `src/mcp/commands.ts` through `src/schema/units.ts`,
and nothing there restates a constant.

This is not politeness. The wire's conventions read as nonsense out of context
and a model given them will act on them: `setLevel` takes 1–254, so "set it to
twelve" becomes 12/254 ≈ 5%; **a covering puts 0 at fully open**, so "close the
blinds" sent as 0 throws them wide; a temperature is centi-°C, so `2150` is
reported as two thousand degrees. The MCP layer inverts the covering scale so
`openPercent: 100` is open, and that inversion exists in exactly one function.

## Tokens

A bearer token, and deliberately nothing more.

```
POST /api/v1/mcp                 Authorization: Bearer ghm_…
POST /api/v1/mcp/t/ghm_…         the same token, in the path
```

The path form exists for clients whose connector UI offers a URL field and no
header field. It is the same token checked the same way; what it costs is that
the secret is now in a URL, which some services log — so the apps offer the
header form first and name this as the fallback.

**There is no OAuth, and the absence of `WWW-Authenticate` on a 401 is
load-bearing.** Claude Code has a known bug where a server that advertises an
OAuth resource makes it *drop* the bearer header it was configured with and
begin a flow this hub cannot finish. So a 401 here is a bare JSON body, there is
no `/.well-known/oauth-protected-resource`, and nothing should add one.

**`mcp_tokens` is not `tokens`.** A member's token passes `requireMember` and
therefore every route that member's role allows; an MCP token is handed to a
program on somebody's laptop and left in a JSON file for months. Two tables
verified by two functions means an MCP token 401s on every REST route **by
construction** rather than by a check somebody has to remember to write — and
revoking an assistant does not sign a phone out.

| Field | Meaning |
|---|---|
| `label` | what a person calls this connection — "Claude Desktop on the MacBook" |
| `memberId` | who minted it. The activity log names them for whatever the assistant does, and ending that membership takes its assistants with it |
| `canControl` | whether this connection may work the home, or only look at it. **Chosen at mint time and never edited** — "let my read-only assistant unlock the door" is a new decision and deserves a new token, not a switch on one that some config file is still holding |
| `revokedAt` | set rather than deleted, so the list can still show what was turned off |

The plaintext is returned by `POST /settings/mcp/tokens` and never again; only
its sha256 is stored, exactly as for a member's token.

## Transport

**Streamable HTTP, stateless.** One `POST` carries one JSON-RPC 2.0 message and
the answer comes straight back as `application/json`. No `Mcp-Session-Id` — the
spec makes it optional, there is no per-session state worth keeping, and not
keeping any is what makes this cost nothing between calls on a Raspberry Pi.

Methods: `initialize`, `notifications/initialized`, `tools/list`, `tools/call`,
`ping`. Anything else is `-32601`. A notification (no `id`) is answered `202`
with an empty body.

A whole exchange:

```json
{ "jsonrpc": "2.0", "id": 2, "method": "tools/call",
  "params": { "name": "control_device",
              "arguments": { "device": "Kitchen lamp",
                             "action": { "action": "brightness", "percent": 30 } } } }
```

```json
{ "jsonrpc": "2.0", "id": 2,
  "result": {
    "content": [{ "type": "text", "text": "Kitchen lamp is now on · 30%." }],
    "structuredContent": { "ok": true, "summary": "Kitchen lamp is now on · 30%.",
                           "state": "on · 30%" }
  } }
```

`GET /api/v1/mcp` answers **405** while assistant access is on. The endpoint has
to exist for both verbs, and this server never opens a server-initiated stream,
so "method not allowed" is the honest answer rather than an empty SSE channel.

**With assistant access switched off, both verbs answer 404** — there is no MCP
endpoint on that hub, and 401 or 403 would say there is one and invite a client
to go and find a credential that cannot exist yet. The GET used to answer 405
either way, so a switched-off hub said "no such thing" to one verb and "wrong
verb for the thing" to the other; whatever one hides, the other has to hide too.
It hides less than it looks like it does, deliberately: the `mcp` block on the
public `GET /hub` already says this *build* can run a server. What neither says
is anything about who may reach it.

**Batches are refused** with `-32600`. JSON-RPC batching was removed from MCP in
the 2025-06-18 revision; accepting an array would mean a second path through
every handler, with fan-out and partial failure to get right, for a shape the
spec has dropped.

Version negotiation answers with the client's own version when it is one of
`2025-11-25`, `2025-06-18` or `2025-03-26`, and with our newest otherwise,
leaving the client to decide whether it can live with that.

**`2026-07-28` is deliberately not in that set**, and not because we are behind:
that revision is a different protocol under the same name. It removes the
`initialize` handshake, makes every request self-describing through `_meta`,
retires `Mcp-Session-Id`, and *requires* servers to implement `server/discover`.
This one implements the handshake and none of that. Naming it would be a lie
told at the worst moment — a client that sends no version, or one we do not
know, is answered with the newest entry, so it would be handed `2026-07-28` and
could proceed on a dispatch path this endpoint answers `-32601` to. Supporting
it is real work, not a line in a list.

**Nothing is broken by that today, and the deadline is July 2027.** A
2026-07-28 client falls back to the `initialize` handshake when it meets a
server on 2025-11-25 or earlier — that fallback is in the official SDKs, and it
is what the revision's twelve-month deprecation window is for. The cost of
staying here is one extra round trip while such a client probes with
`server/discover` and is refused, and a client *pinned* to 2026-07-28 (an
opt-in mode, not the default) refusing this hub outright. The headline of that
revision is a stateless core, which this endpoint already is — no
`Mcp-Session-Id`, no per-session state — so what is left to gain is the
discovery flow and the extensions framework, neither of which anything here
asks for. Revisit when a client we care about pins it, or by mid-2027.

## Managing it

All four routes need `hub.mcp`, which is **owner-only by default** — an update
is bounded and rolls itself back, while a connection lives in a config file on a
machine this home does not control until somebody revokes it. See
[api.md](api.md).

| Route | Does |
|---|---|
| `GET /api/v1/settings/mcp` | `{enabled, tokens: […]}` — never a secret |
| `PUT /api/v1/settings/mcp` | `{enabled}`; logs `mcp.enabled` / `mcp.disabled` |
| `POST /api/v1/settings/mcp/tokens` | `{label, canControl}` → `201` with the plaintext, exactly once |
| `DELETE /api/v1/settings/mcp/tokens/:id` | `204`; logs `mcp.token-revoked` |

`GET /hub` carries `mcp: { available: true }` and nothing else. That route is
public, so it says only that this build *can* run an MCP server — enough for an
app to decide whether to draw the section. Whether one is switched on, and which
assistants are connected, is behind the authenticated route above: a hub should
not announce to the network that there is an assistant door and whether it is
open. For the same reason a request to `/api/v1/mcp` on a hub that has not
switched it on is answered `404` rather than `403`.

## What is deliberately not exposed

An assistant gets the home and its devices. It does **not** get:

| Not exposed | Why |
|---|---|
| Members, invites, roles | Access to the home is a decision a person makes in an app, looking at a list of people. Nothing about it is improved by a model doing it. |
| `hub.update`, the radio switch | Both take the home offline for minutes. A model has no way to know whether now is a good time. |
| Rooms, zones, renames | Reorganising the house is not what "turn the light off" needs, and an assistant that quietly renames things makes the home harder for everyone else to use. |
| Removing or pairing devices | Pairing is a person standing next to hardware; removal is not undone by anything here. |
| The AI settings, the mapping library | The hub's own credential. Not an assistant's business. |
| IR learning (`irLearn` and friends) | Capturing a code is a person pointing a remote at a blaster. `ir_send` replays what is already stored. |

`test/mcp-coverage.test.ts` pins this: every command type, capability kind and
history kind must be either reachable through a tool or named in that file's
excluded map **with a reason**. Adding one to the schema fails the suite until
somebody decides which it is.

## What it costs

Two refusals make this affordable on the smallest supported board, and both
should stay.

**No SDK.** `@modelcontextprotocol/sdk` was in this dependency graph once,
underneath the Claude Agent SDK, and left with it in the change that took the
bundle from 117 MB to 29 MB. MCP's core is JSON-RPC over one POST, so `src/mcp/`
implements it by hand and adds **no dependency at all** — the JSON Schema in
`tools/list` comes from `z.toJSONSchema`, which zod has shipped since 4.3.

**No second process.** It runs in-process on the Fastify listener already there;
a separate Node process would have been 50–80 MB on a board with about 89 MB
free. The module is **dynamically imported on the first request to an enabled
hub** and cached, the argument `src/index.ts` already makes for `@matter/main`,
so a home that has never switched assistant access on never parses the tool
catalog at all.

Measured against the Zero 2 W baseline in [zigbee.md](zigbee.md) — 139 MB
resident with both radios, against a 200 MB `MemoryHigh` — the feature is one to
three megabytes when in use and nothing when it is not.

Answers are bounded so a model in a loop cannot ask for something enormous:
`list_devices` caps at 200 rows, history at 200 points, `get_activity` at 50
entries.
