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
| `GET /hub` | — | `{hubId, name, version, build?, apiVersion, claimed, zigbee: {enabled, connected}, radio: {budget, mode, matter, canRunBoth}}`. `build` is CI's stamp (`<version>-<sha>-<branch>`) and names the release directory on the machine — `version` alone reads the same before and after an update, so it can't answer "did my update land?". Absent on a hub built from source. `zigbee.connected` is Zigbee2MQTT's bridge reporting itself online, not merely that the broker is up, so an app can say "plug a coordinator in" instead of showing an empty section. `radio` is [below](#radio-get-hub-and-put-settingsradio) |
| `POST /pair` | — | claim / join, returns `{token, member}`; 401 on bad code, 429 after repeated failures; reuse `claimId` when retrying |
| `GET /home` · `PATCH /home` | any · owner | home name |
| `GET /rooms` · `POST /rooms` · `PATCH /rooms/:id` · `DELETE /rooms/:id` | any · owner | |
| `GET /devices` | any | full device list (wire shape below) |
| `PATCH /devices/:id` | favorite: any; name/roomId: owner | `{name?, roomId?, favorite?}` |
| `DELETE /devices/:id` | owner | also unpairs at the protocol level |
| `POST /devices/:id/endpoints/:endpointId/commands` | any | body = canonical command; `202`. IR-remote intents (`irLearn`/`irSaveLearned`/`irSend`/`irDeleteCommand`/`irRenameCommand`) are resolved against the endpoint's stored code library (see [device-schema.md](device-schema.md)) |
| `POST /devices/:id/remap` | owner | force-regenerate the AI mapping (Zigbee devices); the hub also remaps automatically when a device publishes unknown parameters — see [ai-adaptation.md](ai-adaptation.md) |
| `POST /matter/commission` | owner | `{pairingCode}` → `202 {jobId}` (async) |
| `GET /matter/commission/:jobId` | any | `{status: running\|done\|failed, nodeId?, error?}` |
| `POST /zigbee/permit-join` | owner | `{seconds}` (0 = close the network) |
| `GET /members` · `DELETE /members/:id` | any · owner | the owner cannot be removed |
| `GET /invites` · `POST /invites` | owner | `POST` → `201 {code, expiresAt}` |
| `GET /activity?limit=&before=` | any | reverse-chronological, cursor = `before` id |
| `GET /settings/ai` · `PUT /settings/ai` · `DELETE /settings/ai` | owner | PUT `{apiKey, model?}` (an Anthropic API key, write-only; a `sk-ant-oat…` subscription token and a model outside the supported list are both refused with 400, an `authType` from an older app is ignored); GET/PUT respond `{provider: "anthropic", model, hasKey, legacySubscriptionToken, status}` where `status` carries `lastError`/`lastRun` health — see [ai-adaptation.md](ai-adaptation.md) |
| `PUT /settings/radio` | owner | `{mode: "auto"\|"zigbee"\|"matter"}` → `{budget, mode, matter, canRunBoth, applying: true}`. Records a *request*; see below |

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

`auto` follows the hardware: a coordinator takes the board when one is plugged
in, Matter takes it when one isn't. The full matrix, and why Matter never gives
way to a coordinator that isn't there, is in
[zigbee.md](zigbee.md#zigbee-or-matter-on-a-small-board).

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

## WebSocket

`GET /api/v1/ws?token=<token>` upgrades to a WebSocket. One JSON frame per
message:

```
{"type":"hello","hubId","name","apiVersion":1}          on connect
{"type":"state","deviceId","endpointId","state":{…}}    full canonical state after each change
{"type":"deviceUpserted","device":{…}}                  new device or structure/name change
{"type":"deviceRemoved","deviceId"}
{"type":"activity","entry":{id,at,kind,message,deviceId?,memberId?}}
{"type":"permitJoin","active":true,"remainingSeconds":60}
{"type":"commissioning","jobId","status","detail"?}     Matter commissioning progress
```

Unauthorized sockets are closed with code `4001`. Clients should reconnect
with exponential backoff and re-`GET /devices` after reconnecting (frames may
have been missed).

## Errors

`400 {error:"invalid_body", issues:[…]}` (zod), `401 unauthorized`,
`403 owner_only`, `404 not_found`, `409` for protocol-level refusals
(unsupported command, adapter disabled, cannot remove owner).
