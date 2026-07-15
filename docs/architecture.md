# Architecture

GetHome Hub is a single Node.js service (`hubd`) plus infrastructure
containers (Postgres, Mosquitto, optionally Zigbee2MQTT). One hub hosts
exactly **one home**; sharing a home means granting members access to the hub.

```
                       ┌────────────────────────────── hubd ─────────────────────────────┐
 Zigbee USB stick ──▶ Zigbee2MQTT ──MQTT──▶ ZigbeeAdapter ─┐                             │
 DIY / wired devices ────────────MQTT────▶ MqttAdapter ────┤        ┌─ REST /api/v1 ─────┼──▶ GetHome apps
 Matter devices ◀──UDP/mDNS──▶ MatterAdapter (matter.js) ──┤        │                    │    (iOS, Studio)
                       │                                   ▼        │                    │
                       │                            DeviceRegistry ─┤                    │
                       │                       (canonical schema)   │                    │
                       │                                   │        └─ WebSocket events ─┼──▶ live state
                       │                                Postgres                         │
                       └──────────── mDNS advertise _gethome._tcp ───────────────────────┘
```

## The pieces

| Module | Responsibility |
|---|---|
| `src/schema/` | The canonical device schema: 27 capability kinds (incl. a universal `custom` fallback), 16 device kinds, typed endpoint state, command intents (incl. IR learn/replay + `setCustomField`), unit conversions, Matter device-type catalog, zod wire schemas. Dependency-free (zod only) — everything else derives from it. |
| `src/adapters/` | Protocol drivers. Each implements `ProtocolAdapter` and talks to the rest of the hub only through the narrow `AdapterBus` (announce devices, report state, execute commands). Adapters never touch the database or the API. |
| `src/core/registry.ts` | `DeviceRegistry` — implements the `AdapterBus`: persists devices/endpoints, merges state patches (per-device write queue + write-through cache), fans events out, routes commands back to the owning adapter. An adapter that fails to start is isolated; the hub keeps running. |
| `src/core/pairing.ts` | Claim flow: boot pairing code → first claim = owner; owner-minted invite codes (15 min TTL) → members. Opaque bearer tokens, sha256-hashed at rest. |
| `src/core/crypto.ts` | Hub identity + AES-256-GCM key in `<data>/hub-secret.json` (survives database resets), token generation/hashing, secret encryption. |
| `src/ai/` | AI device adaptation — see [ai-adaptation.md](ai-adaptation.md). |
| `src/api/` | Fastify REST + WebSocket — see [api.md](api.md). |
| `src/mdns/` | `_gethome._tcp` advertisement (@homebridge/ciao) with `id`/`ver`/`api`/`claimed` TXT records. |
| `src/db/` | Drizzle ORM schema + committed SQL migrations, run automatically at boot. |

## Design rules

1. **One schema.** Every protocol is translated *into* the canonical schema at
   the adapter boundary. Nothing downstream (registry, API, apps) knows or
   cares which protocol a device speaks.
2. **Adapters are plugins.** They see only the `AdapterBus`. Adding a protocol
   (e.g. a future BLE or KNX adapter) means one new directory under
   `src/adapters/` and one registration line in `src/index.ts`.
3. **Units are load-bearing.** The unit conventions in
   [device-schema.md](device-schema.md) are a compatibility contract with the
   GetHome apps. Never change them; version the wire format instead.
4. **The hub must boot with nothing attached.** No Zigbee stick, no Matter
   device, no MQTT client — the API and claim flow still work.
5. **Fail soft.** Adapter crashes are logged + surfaced as activity, never
   fatal.
6. **Nothing is unsupported by default.** Devices are made usable in three
   layers, tried in order: (1) **typed capabilities** for anything that fits
   the canonical schema; (2) **generic custom fields** (the `custom`
   capability) for every other exposed parameter, generated statically from
   the protocol's own metadata; (3) **AI adaptation** for the genuine gaps
   layer 2 can't hold, and to upgrade generic fields to typed capabilities.
   Layers 1–2 are static (no key, no cost). A leftover parameter must never be
   silently dropped — settings and vendor knobs become fields, only pure
   telemetry is hidden. See [zigbee.md](zigbee.md) ("The three layers of
   device support") and [device-schema.md](device-schema.md) (the `custom`
   capability).

## Data flow

*Inbound (device → app):* device report → adapter translates to a canonical
state patch → `DeviceRegistry.stateChanged` merges it into the endpoint's
stored state (jsonb, survives restarts) → `stateChanged` event → WebSocket
frame to every connected app.

*Outbound (app → device):* `POST /devices/:id/endpoints/:eid/commands` with a
canonical command → registry routes to the owning adapter → adapter translates
(Z2M `/set` payload, Matter cluster command, MQTT convention topic). The app
applies the change optimistically; the device's real report reconciles it.

## Security model (v1, LAN-only)

- Transport is plain HTTP/WS on the LAN; the API is bound to the local
  network. Remote access will arrive as an authenticated relay through the
  GetHome server (future work) — the hub will never be port-forwarded.
- AuthN: opaque bearer tokens issued at claim time, sha256-hashed at rest.
- AuthZ: `owner` (structure: rename, rooms, members, commissioning, AI
  settings, removal) vs `member` (control devices, favorites, view activity).
- Secrets: AI provider keys AES-256-GCM-encrypted with the hub secret;
  the key file is 0600 and never leaves the machine.
