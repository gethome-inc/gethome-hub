# REST routes for an API key

Base URL: `http://<hub>:8420`. Every route below takes
`Authorization: Bearer <key>`. "Needs" is what the **key** needs on top of
reading; the key's member must also hold any permission named. The hub's
`docs/api.md` is canonical for every field.

## What a key can be given

| Grant | Lets the key |
|---|---|
| *(nothing)* | read everything its member may read |
| `control` | work the home: device commands (locks included), press a scene, switch a mode, pin a favorite |
| `device.edit` | rename devices, move them between rooms, mark one as expected to be offline, choose a portrait |
| `device.add` | open the Zigbee network, pair a Matter accessory, look for accessories to pair |
| `device.remove` | take a device out of the home and unpair it |
| `home.structure` | add, rename, restyle and delete rooms and zones |
| `home.rename` | rename the home (and the hub) |
| `activity.read` | read everybody's activity, not only its member's |
| `automation.manage` | create, change, delete and revert rules (needs `control`) |
| `hub.radio` | switch which radio the hub runs |
| `hub.update` | start a hub update, or let the hub update itself |

`GET /api/v1/hub` lists the grantable permissions in `apiKeys.grantable`; a key
can never be given anything else. These are **never** a key's, whatever it is
given: inviting or removing people, roles, the home's AI provider keys and AI
settings, MQTT broker credentials, the hub's Wi-Fi networks, making or changing
API keys, and every conversation with the hub's assistant or automations agent.

## Reading (any key)

| Route | Answer |
|---|---|
| `GET /api/v1/hub` | no credential needed; name, version, capabilities (`apiKeys`, `history`, `portraits`, `zigbee`, `radio`, …) |
| `GET /api/v1/me` | who the key acts as and what it may do: `{id, name, role, permissions, isOwner, apiKey: {id, name, control, permissions, state, expiresAt}}` |
| `GET /api/v1/home` | `{id, name}` |
| `GET /api/v1/rooms` | `[{id, name, zoneId, icon, accent, sortOrder}]` |
| `GET /api/v1/zones` | `[{id, name, sortOrder}]` |
| `GET /api/v1/devices` | every device — see [devices-and-commands.md](devices-and-commands.md) |
| `GET /api/v1/devices/{deviceId}/history?from=&to=&points=&series=` | recorded readings in five-minute buckets for about a week; `from`/`to` epoch ms |
| `GET /api/v1/devices/{deviceId}/portraits` · `GET /api/v1/portraits/{portraitId}` | the pictures drawn of a device, and one picture itself as `image/png` (it never changes; a new one gets a new id) |
| `GET /api/v1/members` | who is in the home |
| `GET /api/v1/roles` · `GET /api/v1/permissions` | the role table and the permission catalog, with the hub's own wording |
| `GET /api/v1/activity?limit=&before=` | newest first; only the member's own rows unless the key has `activity.read` |
| `GET /api/v1/automations` | `{automations, unreadable}` — an object, not a list. `automations` is every rule, each with `summary` (a sentence), `outline`, `shape` (`button`/`toggle`/`watching`), `enabled`, `active`, `roomId`; `unreadable` is rules a newer build wrote that this hub cannot run, kept rather than lost |
| `GET /api/v1/automations/{automationId}` · `GET /api/v1/automations/{automationId}/runs` | one rule, and why it fired |
| `GET /api/v1/automations/capabilities` | the rule vocabulary, generated from the hub's own schema |
| `GET /api/v1/automations/templates` | the shipped presets |
| `GET /api/v1/settings/timezone` | the home's timezone, which schedules use |
| `GET /api/v1/system/update` · `GET /api/v1/system/update/log` | what is installed, how an update is going, and `automatic`: whether the hub updates itself and when it next may |
| `GET /api/v1/matter/commission/{jobId}` | a Matter pairing in progress |

## Working the home (`control`)

| Route | Body | Answer |
|---|---|---|
| `POST /api/v1/devices/{deviceId}/endpoints/{endpointId}/commands` | a command, e.g. `{"type":"setLevel","level":180}` | `202 {accepted: true}`; `409` if the device cannot do it |
| `POST /api/v1/automations/{automationId}/run` | — | press a button scene: `202`; `409 automation_disabled`, `409 not_pressable` |
| `PUT /api/v1/automations/{automationId}/active` | `{"active": true}` | switch a mode (a toggle rule) on or off; `409 not_a_toggle` |
| `PATCH /api/v1/devices/{deviceId}` | `{"favorite": true}` | pin a device to the member's own dashboard |

## With a permission

| Route | Needs |
|---|---|
| `PATCH /api/v1/devices/{deviceId}` with `name`, `roomId` or `offlineExpected` | `device.edit` |
| `PATCH /api/v1/devices/{deviceId}/portraits` · `DELETE /api/v1/portraits/{portraitId}` | `device.edit` |
| `DELETE /api/v1/devices/{deviceId}` | `device.remove` — **ask the person first** |
| `POST /api/v1/zigbee/permit-join` `{"seconds": 120}` | `device.add` |
| `POST /api/v1/matter/commission` `{"pairingCode": "…"}` · `POST /api/v1/matter/commission/{jobId}/cancel` · `GET /api/v1/matter/discoverable` | `device.add` |
| `POST /api/v1/rooms` · `PATCH /api/v1/rooms/{roomId}` · `DELETE /api/v1/rooms/{roomId}` | `home.structure` |
| `POST /api/v1/zones` · `PATCH /api/v1/zones/{zoneId}` · `DELETE /api/v1/zones/{zoneId}` | `home.structure` |
| `PATCH /api/v1/home` `{"name": "…"}` | `home.rename` |
| `POST /api/v1/automations/dry-run` · `POST /api/v1/automations` · `PATCH /api/v1/automations/{automationId}` · `DELETE /api/v1/automations/{automationId}` | `automation.manage` |
| `GET /api/v1/automations/{automationId}/versions` · `POST /api/v1/automations/{automationId}/revert` · `POST /api/v1/automations/templates/{key}` | `automation.manage` |
| `PUT /api/v1/settings/timezone` | `automation.manage` |
| `PUT /api/v1/settings/radio` `{"mode": "auto"}` | `hub.radio` — restarts the hub's radios; ask first |
| `POST /api/v1/system/update` | `hub.update` — the home goes offline for minutes; ask first |
| `PUT /api/v1/system/update/automatic` `{"enabled": true}` | `hub.update` — from then on the hub updates itself at an hour its home is usually quiet; ask first. `409 update_unsupported` on a hub that cannot update itself |

## Patterns worth knowing

- **Write, then confirm from state.** A command is `202` when routed; watch for
  the `state` frame (or re-read the device) before saying it happened.
- **Renames and room changes are the house's**: everybody in the home sees
  them, and each is a line in the activity log under the member's name and
  the key's.
- **Favorites are the member's own**, not the home's.
- **A device being offline can be expected**: `offlineExpected` on a device
  means somebody said so; don't alarm about it.
- **Use ids, not names, to act**, and re-read after a `structure` or
  `deviceUpserted` frame: names change.
