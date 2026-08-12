# Hub API

Base URL: `http://<hub>:8420/api/v1`. JSON everywhere. Discover hubs via mDNS
(`_gethome._tcp`, TXT: `id`, `ver`, `api`, `claimed`) or connect by address.

## Authentication

`GET /hub` is public (discovery/health). Everything else requires
`Authorization: Bearer <token>` (or `?token=` for the WebSocket).

### Claiming

Tokens come from the claim flow, and **a token never expires** — a device
connects once and is never asked again. That is the point of the whole design:
the code is a one-time proof of physical access, not a password.

1. An unclaimed hub writes an 8-digit **pairing code** to `<data>/pairing-code`
   (0600) and logs it, and **keeps it** until somebody claims the hub. It used
   to be re-minted on every boot, which meant any code that had been read — the
   `@@PAIRING@@` marker from the install, or a value fetched a minute ago — was
   a different number by the time it was used. On a small board where the hub
   restarts (an update, a power cut, the OOM killer) that turned a finished
   install into `invalid_code` with nothing the user could do. Rotation bought
   nothing either: the code only ever proves access to the machine, and reading
   the file *is* that access. Moving the file, or the `Pairing code: <digits>`
   log line, breaks GetHome Studio's fallback path.
2. `POST /pair {"code","memberName","deviceName"?,"claimId"?}` — the first
   successful claim creates the **owner** and returns `{token, member}`. The
   code dies with the claim. `claimId` is the client's own UUID for *this
   attempt*, kept across retries: a hub can commit a claim and lose the
   response on the way back, and without an id the retry finds a code that is
   already spent and is told it is wrong. With one, the hub replays the
   original answer for five minutes. Failed attempts are rate-limited per
   address.
3. Owners mint **invite codes** (`POST /invites`, 15-minute TTL, single use);
   claiming one through the same `/pair` endpoint creates a **member**. This is
   how a phone or a second Mac joins.

**On the hub's own machine there is a shorter route.** `gethome-hubctl claim
--name "…" --device "…"` reads the code and claims in one step, printing
`@@HUBID:…@@` and `@@TOKEN:…@@`. Anyone who can run that already holds root on
the machine the code exists to prove access to, so requiring them to recite the
number adds a step that can only fail. GetHome Studio uses it over SSH, which
is why the person who installs a hub is never shown a code at all.

Roles: **owner** = structure (rename home/devices, rooms, members, invites,
commissioning, permit-join, AI settings, device removal). **member** = control
devices, favorites, view everything.

## REST routes

| Method & path | Role | Notes |
|---|---|---|
| `GET /hub` | — | `{hubId, name, version, build?, apiVersion, claimed, zigbee: {enabled, connected}, radio: {budget, mode, matter, canRunBoth}}`. `name` is the home's name — see [below](#the-hubs-name-is-the-homes-name). `build` is CI's stamp (`<version>-<sha>-<branch>`) and names the release directory on the machine — `version` alone reads the same before and after an update, so it can't answer "did my update land?". Absent on a hub built from source. `zigbee.connected` is Zigbee2MQTT's bridge reporting itself online, not merely that the broker is up, so an app can say "plug a coordinator in" instead of showing an empty section; `zigbee.problem` is [below](#why-zigbee-is-down-zigbeeproblem); `zigbee.permitJoin: {active, remainingSeconds}` is the live join window and is [below](#the-zigbee-join-window). `radio` is [further below](#radio-get-hub-and-put-settingsradio) |
| `POST /pair` | — | claim / join, returns `{token, member}`; 401 on bad code, 429 after repeated failures; reuse `claimId` when retrying |
| `GET /home` · `PATCH /home` | any · owner | `{id, name}`. `PATCH {name}` (trimmed, 1–80 chars) renames the hub *and* the home — they are one name, see [below](#the-hubs-name-is-the-homes-name) |
| `GET /rooms` · `POST /rooms` · `PATCH /rooms/:id` · `DELETE /rooms/:id` | any · owner | |
| `GET /devices` | any | full device list (wire shape below) |
| `PATCH /devices/:id` | favorite: any; name/roomId: owner | `{name?, roomId?, favorite?}` |
| `DELETE /devices/:id` | owner | also unpairs at the protocol level |
| `POST /devices/:id/endpoints/:endpointId/commands` | any | body = canonical command; `202`. IR-remote intents (`irLearn`/`irSaveLearned`/`irSend`/`irDeleteCommand`/`irRenameCommand`) are resolved against the endpoint's stored code library (see [device-schema.md](device-schema.md)) |
| `POST /devices/:id/remap` | owner | force-regenerate the AI mapping (Zigbee devices); the hub also remaps automatically when a device publishes unknown parameters — see [ai-adaptation.md](ai-adaptation.md). `409 ai_not_configured` with no credential, `409 ai_disabled` when the owner has switched adaptation off |
| `POST /matter/commission` | owner | `{pairingCode}` → `202 {jobId}` (async) |
| `GET /matter/commission/:jobId` | any | `{status: running\|done\|failed, nodeId?, error?}` |
| `POST /zigbee/permit-join` | owner | `{seconds}`, 0–900 (0 = close the network) → `{permitJoin, seconds}` describing the **live** window, which is not always what was asked for. See [below](#the-zigbee-join-window) |
| `GET /members` · `PATCH /members/me` · `DELETE /members/me` · `DELETE /members/:id` | any · any (itself) · any (itself) · owner | rows carry `isSelf`; `PATCH` takes `{name}` and renames **the caller**; `DELETE` on either route answers `204` and revokes that member's tokens; the owner cannot be removed, by anyone or by itself. See [below](#which-member-you-are-isself-and-patch-membersme) |
| `GET /invites` · `POST /invites` | owner | `POST` → `201 {code, expiresAt}` |
| `GET /activity?limit=&before=` | any | reverse-chronological, cursor = `before` id |
| `GET /settings/ai` · `PUT /settings/ai` · `PATCH /settings/ai` · `DELETE /settings/ai` | owner | PUT `{apiKey, model?}` (an Anthropic API key, write-only; a `sk-ant-oat…` subscription token and a model outside the supported list are both refused with 400, an `authType` from an older app is ignored). **PATCH `{enabled?, model?}`** changes those without re-entering the key — the switch is deliberately not the credential. All three respond `{provider: "anthropic", model, hasKey, enabled, legacySubscriptionToken, status}`; `enabled` defaults to true and `status` carries `lastError`/`lastRun` health — see [ai-adaptation.md](ai-adaptation.md) |
| `GET /ai/runs?limit=` | owner | what the mapping agent did, newest first: `{id, at, kind, vendor, model, exposesHash, modelId, ok, costUsd, turns, durationMs, errorKind, errorMessage, steps}`. A summary, never a transcript — see [ai-adaptation.md](ai-adaptation.md) |
| `GET /device-mappings` | owner | the mapping library: one entry per device model, `{adapter, exposesHash, vendor, model, status, source, problems, endpoints, deviceIds, createdAt, updatedAt}` |
| `GET /device-mappings/:exposesHash` | owner | the download — an envelope naming the device, see [below](#the-device-mapping-library) |
| `PUT /device-mappings/:exposesHash` | owner | the upload. Accepts the envelope or a bare descriptor. `422 {error:"invalid_mapping", problems, issues?}` when the hub can't use it — and it is **kept**, so `…/repair` can work from it |
| `DELETE /device-mappings/:exposesHash` | owner | forget it; devices of that model fall back to their static mapping |
| `POST /device-mappings/:exposesHash/repair` | owner | hand a rejected descriptor to the agent with the complaints. `409 ai_not_configured` / `409 ai_disabled` / `409 nothing_to_repair`, `422 no_device` |
| `PUT /settings/radio` | owner | `{mode: "auto"\|"zigbee"\|"matter"}` → `{budget, mode, matter, canRunBoth, applying: true}`. Records a *request*; see below |

### The hub's name is the home's name

One hub hosts exactly one home and a home cannot move between hubs, so there is
**one name**, stored once, and `GET /hub`, `GET /home` and the WebSocket
`hello` frame all answer the same string.

There used to be two. `GET /hub` answered `HUB_NAME` from
`/etc/gethome/hub.env` — written once by the installer and never edited by
anyone — while `GET /home` answered a database row the apps could rename. So a
hub whose owner had called it "Дача" in the app still advertised itself as
"GetHome Hub" over mDNS, still said "GetHome Hub" in GetHome Studio, and two
hubs on one Mac were two rows with the same name. The second name was never a
second fact, only a second place for the first one to be wrong.

- **`HUB_NAME` seeds; the database owns.** The environment variable names a hub
  that has no name yet — a first boot. After that it is inert: editing
  `hub.env` and restarting changes nothing, and `PATCH /home` is the only way
  to rename a hub.
- **A rename needs no restart and no root.** It reaches `GET /hub` (public, so
  an app that has not been claimed still sees it), the WebSocket hello, and the
  mDNS advertisement — which is re-published under the new name, by rewriting
  avahi's service file or by re-creating the `ciao` service.
- **The name is public.** `GET /hub` is unauthenticated and the name is the
  mDNS service instance name, so it is visible to anything on the LAN. That is
  the point — it is how a person with two hubs tells them apart before they can
  sign in to either — but it is worth knowing when choosing one.
- **The id is not the name.** `hubId` comes from `<data>/hub-secret.json` on
  the machine's own disk; devices, tokens and saved hubs are keyed by it, and
  renaming touches none of them.

### Why Zigbee is down (`zigbee.problem`)

`connected: false` is a fact with several very different causes, and the cause
used to live only in a log on the hub's own machine — where the person who needs
it, looking at an app somewhere else, cannot reach it. So the hub reads
Zigbee2MQTT's log itself (same service account, no privileges, no SSH) and puts
the answer in the API.

Present only while Zigbee is enabled, not connected, **and** the hub recognised
the failure. Absent otherwise — including for a hub older than the field — so
treat its presence as the signal and never its absence.

```json
"problem": {
  "kind": "firmware-too-old",
  "summary": "The Zigbee coordinator is working, but its firmware is too old for Zigbee2MQTT. …",
  "detail": "error: z2m: Error: Adapter EZSP protocol version (8) is not supported by Host [13-19]."
}
```

| `kind` | Means |
|---|---|
| `firmware-too-old` | The radio answered and refused: its EZSP version predates what Zigbee2MQTT supports. A **new SONOFF ZBDongle-E ships this way**, so this is the common one — flashing it once fixes it. |
| `adapter-unidentified` | Zigbee2MQTT could not work out what kind of coordinator it is. Usually a stick on a plain USB-serial chip with no name of its own. |
| `port-missing` | Zigbee2MQTT could not inspect the USB port (`udevadm` unavailable to the service). |
| `onboarding-pending` | Zigbee2MQTT is waiting on its own browser setup page. `install.sh` turns that off, so this means something reset it. |
| `radio-unreachable` | It reached for the radio and got nothing, with no more specific cause found. |

Branch on `kind` to offer a fix; show `summary` when the kind is unfamiliar — it
is a complete sentence written by the hub, so an app that has never heard of a
new kind still says something true. `detail` is the deciding line from the log,
for a disclosure.

An unrecognised log yields **no** `problem` at all. A wrong diagnosis is worse
than `connected: false`, which the caller already has.

### Radio (`GET /hub` and `PUT /settings/radio`)

A 512 MB board has memory for one radio at a time, so what a hub can talk to is
not the same on every machine and an app that assumes otherwise shows sections
that can never fill. The `radio` block on `GET /hub` says which situation this
hub is in:

| Field | Meaning |
|---|---|
| `budget` | `"both"` or `"one"` — the *board's*, measured at install time. Not a preference and not settable |
| `mode` | `"auto"` (default), `"zigbee"` or `"matter"` — the owner's choice, when one has been made |
| `matter` | whether the Matter adapter is **live right now** |
| `canRunBoth` | `budget === "both"`, restated so an app can hide the switch without parsing the enum |

`auto` follows the hardware **in one direction**: a coordinator takes the board
within seconds of being plugged in, and Matter takes it on a board where no
coordinator has ever been set up. Unplugging a coordinator changes *nothing* —
Zigbee2MQTT stops, the board stays where it was, and switching to Matter is left
to the owner. Pulling a stick out is ambiguous (finished with Zigbee, or two
minutes into flashing it?) and the wrong guess restarts the hub under somebody
who is mid-repair. The full matrix, and why Matter never gives way to a
coordinator that isn't there, is in
[zigbee.md](zigbee.md#zigbee-or-matter-on-a-small-board).

So an app looking at `zigbee.connected: false` on a `budget: "one"` hub with
`matter: false` is looking at a board waiting for its coordinator to come back —
offer the Matter switch, don't assume it.

**`PUT` records a request and returns immediately — its response is not state.**
Applying a mode is root work (rewriting `/etc/gethome/hub.env`, stopping or
starting Zigbee2MQTT, restarting the hub), and the hub deliberately cannot do
any of it: it writes one word to a file it owns, a `.path` unit wakes
`gethome-zigbee-detect`, and that applies it. So `matter` in the PUT response is
still the *old* live value, `applying: true` says the switch is in flight, and
the hub will be briefly unreachable while it restarts. Re-read `GET /hub` a few
seconds later rather than trusting the response; a `mode` that is already in
force restarts nothing at all.

The switch is cheap to change your mind about: the coordinator's device path and
Zigbee2MQTT's paired-device list both survive, so devices on the radio that lost
the board come back when it is handed back. They read as offline meanwhile.

### Which member you are (`isSelf` and `PATCH /members/me`)

`GET /members` marks the caller's own row:

```json
[{ "id": "…", "name": "Georgy’s MacBook Pro", "role": "owner", "createdAt": "…", "isSelf": true }]
```

It is there because nothing else answers the question. The member id is returned
exactly once, by `POST /pair`, and the shorter route on the hub's own machine —
`gethome-hubctl claim` — prints the hub id and the token and no member at all,
so a client that claimed over SSH holds a working token and no idea which of
these names is its own. Additive: a client that ignores it loses nothing.

`PATCH /members/me {"name": "…"}` → `{id, name, role}` renames whoever the
bearer token belongs to. Addressed as `me` for the same reason: the token
already says who this is, and asking for an id as well only adds a way to get it
wrong. **Any member may rename itself** — the owner-only rule guards the shape
of the home, not what somebody calls themselves — and renaming *another* member
is not offered. Names are trimmed and must be 1–80 characters after trimming;
`POST /pair` applies the same rule. A rename posts `member.renamed` to the
activity feed, and a name that is already in force writes nothing.

An app that lets a device claim a hub should say what that name will be and let
it be changed later: GetHome Studio, which has no accounts and no user name of
its own, offers the Mac's own name and renames through this route from the hub
page.

### Leaving and removing (`DELETE /members/me`, `DELETE /members/:id`)

Both answer `204` and both really do end that member's access, on both
channels. The row's tokens are deleted with it (`tokens.member_id` cascades,
and this hub runs with `foreign_keys = ON`), so every later request is a `401`
— and **any WebSocket that member is already holding is closed**, with code
`4001`, before the departure is written to the activity log.

That second half is not implied by the first. A socket authorizes once, when
it opens, so the token cascade alone would have left the connection they
already had streaming device state until it happened to drop — a hub restart,
a Wi-Fi blip, possibly days. `4001` is the same code an unauthorized socket
gets on connect, deliberately: it means the same thing, and a client that
already stops reconnecting on it needs no change. Closing before the log write
is what stops a removed member receiving, as their last frame, the
announcement of their own removal.

`DELETE /members/me` is **leaving**, addressed as `me` for the same reason
`PATCH` is, and open to any member: whether to stay in somebody's home is the
one decision about a member that is entirely their own. `DELETE /members/:id`
is **removal**, and is the owner's.

**The owner can do neither**, to itself or through anyone else — `409
cannot_remove_owner` from both routes. There is no ownership transfer, so a
home whose owner left is one nobody can ever invite to, remove from, or
configure again; an owner finished with a hub is finished with the hub, which
is `gethome-hubctl` on the machine rather than a route.

Each writes one activity entry — `member.left` or `member.removed` — naming the
member in the message and carrying **no `memberId`**. That is deliberate twice
over: `activity.member_id` is a foreign key, so naming a row that has just been
deleted fails the insert and naming one about to be deleted would be nulled by
the cascade; and a departure is the one entry whose subject can never be looked
up afterwards, so the name has to live in the sentence. Clients watching the
`activity` WebSocket stream get both, which is how a member list stays right
without polling.

### Device wire shape (`GET /devices` item)

```json
{
  "id": "8b6c…uuid", "name": "Desk lamp", "roomId": null,
  "favorite": false, "online": true,
  "adapter": "zigbee", "vendor": "IKEA", "model": "LED2003G10",
  "needsReview": false,
  "endpoints": [{
    "endpointId": 1, "deviceKind": "light", "primaryCapability": "onOff",
    "capabilities": ["onOff", "level", "colorTemperature"],
    "state": { "reachable": true, "onOff": true,
               "level": {"current": 203, "min": 1, "max": 254},
               "colorTemperature": {"mireds": 370, "minMireds": 250, "maxMireds": 454},
               "sensors": {} }
  }]
}
```

`needsReview: true` marks devices whose automatic mapping was incomplete
(see [ai-adaptation.md](ai-adaptation.md)).

`recognition` is additive and says **how** the device came to be understood:

```json
"recognition": {
  "source": "static",
  "uncovered": [],
  "unmapped": ["power_on_behavior"],
  "exposesHash": "3f2a…64 hex"
}
```

`source` names the *highest layer that was needed* — `static` (typed
capabilities, no key and no cost), `custom-fields` (some parameters are
reachable only as generic controls), `ai`, `imported`, or `none`. `uncovered`
is what `needsReview` is about: properties with no representation at all.
`exposesHash` identifies the device *model*, and so its entry in the mapping
library. Absent on a device adopted before the hub recorded it, which an app
must read as "not known" rather than "recognised by nothing".

### The Zigbee join window

`POST /zigbee/permit-join` opens the network for `seconds` and the hub owns
what happens next. Three things follow from that, and a client should not
reimplement any of them.

**A window is made of grants.** The Zigbee protocol carries a permit-join
duration as a uint8 of seconds, so **254 is the most a single grant can last**.
A longer window is several grants, re-issued by the hub, with the last one
*sized to land exactly on the deadline* rather than overshooting it. Asking for
900 is therefore fine; asking a hub older than this field for anything past 254
is a 400, so treat `zigbee.permitJoin` being present as the capability check.

**Zigbee2MQTT is the authority.** The hub reconciles against `bridge/info`, so
a window somebody opened from Z2M's own UI is adopted and reported, and a
`permit_join: false` closes ours whatever we intended. It fails closed: a hub
that restarts mid-window leaves at most one grant running and nothing renews it.

**The state is on `GET /hub`, not only on the event stream.** An app that has
just been opened, or has just reconnected, has no other way to learn it — which
is how GetHome Studio came to draw "Close Network" over a network that had shut
two minutes earlier. `permitJoin` frames repeat every five seconds while the
window is open, which is the right rate for a network message and the wrong one
for a countdown; drive the seconds from a local clock and re-sync on each frame.

### The device-mapping library

`GET /device-mappings/:exposesHash` returns an **envelope**, not a bare
descriptor, because a descriptor does not say which device it is for:

```json
{
  "gethomeDeviceMapping": 1,
  "adapter": "zigbee",
  "vendor": "TuYa",
  "model": "TS0601_thermostat",
  "exposesHash": "3f2a…",
  "descriptor": { "version": 1, "endpoints": [ … ] }
}
```

`PUT` accepts either that or a bare descriptor — both are things a person
plausibly has in a file. An envelope whose own `exposesHash` disagrees with the
one in the URL is **accepted and flagged** (`hashMismatch: true`), not refused:
a mapping written for a device one firmware revision away is the case this
exists for, and the sanity checks still have to pass either way.

A document the hub cannot use is a **422 with the reasons, and it is stored**.
That is the difference between a dead end and a step: `POST …/repair` hands the
draft and the exact complaints to the agent. Only `repair` needs a credential —
listing, downloading, uploading and deleting are local operations on JSON.

## WebSocket

`GET /api/v1/ws?token=<token>` upgrades to a WebSocket. One JSON frame per
message. These go to every authorized socket:

```
{"type":"hello","hubId","name","apiVersion":1,"streams":["mqtt","zigbee","ai"]}
{"type":"state","deviceId","endpointId","state":{…}}    full canonical state after each change
{"type":"deviceUpserted","device":{…}}                  new device or structure/name change
{"type":"deviceRemoved","deviceId"}
{"type":"activity","entry":{id,at,kind,message,deviceId?,memberId?}}
{"type":"permitJoin","active":true,"remainingSeconds":60}
{"type":"commissioning","jobId","status","detail"?}     Matter commissioning progress
```

### Opt-in streams

`hello` advertises which of the three optional streams this hub can serve, so a
client never has to infer it from a version number — a hub with the MQTT
adapter off simply lists fewer. Ask for the ones you need:

```
→ {"type":"subscribe","streams":["mqtt","zigbee","ai"]}
→ {"type":"unsubscribe","streams":["mqtt"]}
← {"type":"subscribed","streams":["zigbee","ai"],"unavailable":["mqtt"]}
```

and then:

```
{"type":"mqttBacklog","frames":[…]}                     once, on subscribing to "mqtt"
{"type":"mqtt","frame":{seq,at,topic,channel,direction,payload,truncated,payloadBytes,retained}}
{"type":"mqtt","dropped":N}                             rate limit hit; N frames skipped
{"type":"zigbeeEvent","event":{at,type,ieee,name?}}     joined|announced|interviewing|interviewed|interview-failed|left
{"type":"aiRun","event":{phase,id,at,kind,exposesHash,vendor?,model?,step?,ok?,costUsd?,error?}}
```

**They are opt-in because they are not free.** The MQTT tap is a wildcard
subscription on the broker and can be thousands of messages a minute; attaching
it to every socket would make a phone showing a room of lights pay for a
developer tool it never opens. A socket that never subscribes never has a
listener attached, and the hub connects to the broker only while at least one
client is watching — with a minute of linger, so switching screens and back
does not clear the log. Nothing about that traffic is written to disk: it is a
stream a person watches, not a record, and one row per sensor report onto an SD
card is what the registry's state debounce exists to avoid.

Frames are rate-limited per socket and the losses are **reported rather than
hidden** — a gap nobody is told about is worse than a gap. `mqttBacklog` is the
few hundred frames the hub had buffered when you subscribed; there is no
history before that, and an app should say so rather than implying otherwise.

A payload over **8 KB** arrives cut, with `truncated: true` and `payloadBytes`
giving the size of the whole message. In practice that is the two retained
Zigbee2MQTT registries — `bridge/devices` and `bridge/definitions`, hundreds of
kilobytes to megabytes of reference data — and nothing else: a device report is
a few hundred bytes and the bridge's own status topics are one to three
kilobytes. **Show the reader how much is missing rather than naming the limit**,
which is a number in this repository that an app cannot keep in step, and don't
offer a "copy the payload" that quietly hands over the cut copy. Nothing else in
the hub sees a cut payload: the adapters hold their own broker connections and
the observer is a separate, read-only tap.

Unauthorized sockets are closed with code `4001`. Clients should reconnect with
exponential backoff and re-`GET /devices` after reconnecting (frames may have
been missed) — but **not on `4001`**, which is the hub saying this token is no
good. It carries two cases and neither is fixed by trying again: a token that
never authenticated, and one belonging to a member who has since been removed
or left, whose live socket is closed with the same code the moment their row
goes. Treat it as a stop, and say so; every other close is worth retrying.

## Errors

`400 {error:"invalid_body", issues:[…]}` (zod), `401 unauthorized`,
`403 owner_only`, `404 not_found`, `409` for protocol-level refusals
(unsupported command, adapter disabled, cannot remove owner).
