# Hub API

Base URL: `http://<hub>:8420/api/v1`. JSON everywhere. Discover hubs via mDNS
(`_gethome._tcp`, TXT: `id`, `ver`, `api`, `claimed`) or connect by address.

## Authentication

`GET /hub` is public (discovery/health). Everything else requires
`Authorization: Bearer <token>` (or `?token=` for the WebSocket).

Tokens come from the claim flow:

1. An unclaimed hub prints an 8-digit **pairing code** at boot (also in
   `<data>/pairing-code`).
2. `POST /pair {"code","memberName","deviceName"?}` — the first successful
   claim creates the **owner** and returns `{token, member}`. The boot code
   dies with the claim.
3. Owners mint **invite codes** (`POST /invites`, 15-minute TTL, single use);
   claiming one through the same `/pair` endpoint creates a **member**.

Roles: **owner** = structure (rename home/devices, rooms, members, invites,
commissioning, permit-join, AI settings, device removal). **member** = control
devices, favorites, view everything.

## REST routes

| Method & path | Role | Notes |
|---|---|---|
| `GET /hub` | — | `{hubId, name, version, apiVersion, claimed}` |
| `POST /pair` | — | claim / join, returns `{token, member}`; 401 on bad code |
| `GET /home` · `PATCH /home` | any · owner | home name |
| `GET /rooms` · `POST /rooms` · `PATCH /rooms/:id` · `DELETE /rooms/:id` | any · owner | |
| `GET /devices` | any | full device list (wire shape below) |
| `PATCH /devices/:id` | favorite: any; name/roomId: owner | `{name?, roomId?, favorite?}` |
| `DELETE /devices/:id` | owner | also unpairs at the protocol level |
| `POST /devices/:id/endpoints/:endpointId/commands` | any | body = canonical command; `202` |
| `POST /devices/:id/remap` | owner | re-run AI mapping (Zigbee devices) |
| `POST /matter/commission` | owner | `{pairingCode}` → `202 {jobId}` (async) |
| `GET /matter/commission/:jobId` | any | `{status: running\|done\|failed, nodeId?, error?}` |
| `POST /zigbee/permit-join` | owner | `{seconds}` (0 = close the network) |
| `GET /members` · `DELETE /members/:id` | any · owner | the owner cannot be removed |
| `GET /invites` · `POST /invites` | owner | `POST` → `201 {code, expiresAt}` |
| `GET /activity?limit=&before=` | any | reverse-chronological, cursor = `before` id |
| `GET /settings/ai` · `PUT /settings/ai` · `DELETE /settings/ai` | owner | `{provider, model, hasKey}` — the key is write-only |

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
