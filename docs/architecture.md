# Architecture

GetHome Hub is a single Node.js service (`hubd`) with an MQTT broker beside
it (Mosquitto) and, when a coordinator is plugged in, Zigbee2MQTT. Its store is
a SQLite file. One hub hosts exactly **one home**; sharing a home means granting
members access to the hub. They therefore share **one name** — `HUB_NAME` seeds
it on a hub's first boot, `core/home.ts` owns it after that, and `PATCH /home`
is the only thing that changes it (see [api.md](api.md)).

Everything runs as systemd units on Linux and launchd agents on macOS — no
Docker, and no database server. That is a memory decision as much as a
simplicity one: the smallest board this is meant to run on, a Raspberry Pi Zero
2 W, has 512 MB, and the Docker daemon plus a stock Postgres wanted half of it
before the hub had started.

```
                       ┌────────────────────────────── hubd ─────────────────────────────┐
 Zigbee USB stick ──▶ Zigbee2MQTT ──MQTT──▶ ZigbeeAdapter ─┐                             │
 DIY / wired devices ────────────MQTT────▶ MqttAdapter ────┤        ┌─ REST /api/v1 ─────┼──▶ GetHome apps
 Matter devices ◀──UDP/mDNS──▶ MatterAdapter (matter.js) ──┤        │                    │    (iOS, Studio)
                       │                                   ▼        │                    │
                       │                            DeviceRegistry ─┤                    │
                       │                       (canonical schema)   │                    │
                       │                                   │        └─ WebSocket events ─┼──▶ live state
                       │                               SQLite file                       │
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
| `src/core/radio.ts` | The owner's Matter-or-Zigbee choice on a board that affords one radio, as a word in `<data>/radio-mode`. Records only — applying it is root work, so a `.path` unit hands it to `gethome-zigbee-detect`. See [zigbee.md](zigbee.md#zigbee-or-matter-on-a-small-board). |
| `src/core/permit-join.ts` | The Zigbee join window and its countdown. A window longer than one 254-second grant is several, with the last sized to land on the deadline; `bridge/info` is the authority over our own timer. See [api.md](api.md#the-zigbee-join-window). |
| `src/core/mqtt-observer.ts` | A read-only tap on the broker for the apps' traffic inspector. Reference-counted (connected only while somebody is watching), byte-bounded ring buffer, **nothing persisted**, and not an input to anything — see the design rule below. |
| `src/core/ai-runs.ts` | One row per mapping-agent run: what it searched for, what it read, what it submitted, what it cost. A summary, never a transcript; bounded at 40 steps and 60 runs. |
| `src/ai/library.ts` | The device-mapping library over the `ai_mappings` cache: list, download, upload, forget, and hand a rejected descriptor back to the agent to repair. Only `repair` needs a credential, and it loads the agent on demand so the API never carries the Anthropic SDK. |
| `src/core/favorites.ts` | Who has pinned what. A favorite is one **member's**, so it is a row per (device, member) and `GET /devices` renders the boolean per caller — see [api.md](api.md#favorites-are-per-member). Loaded once at boot and kept in memory; it forgets a device when the device is removed and a member when their membership ends, because both deletes are done by the cascade. |
| `src/core/home.ts` | The one name a hub and its home share. `HUB_NAME` seeds it on a first boot and is inert afterwards; `PATCH /home` is the only writer, and a rename re-publishes mDNS. |
| `src/db/` | drizzle over `better-sqlite3`, one file at `<data>/hub.db` (WAL, `synchronous = NORMAL`, foreign keys on). No pool, no socket, no second process. Schema + committed SQL migrations, run automatically at boot. |
| `src/ai/` | AI device adaptation — the mapping agent (a tool-use loop on the Anthropic Messages API) plus descriptor DSL, model allowlist, failure taxonomy, and backoff — see [ai-adaptation.md](ai-adaptation.md). |
| `src/api/` | Fastify REST + WebSocket — see [api.md](api.md). |
| `src/mdns/` | `_gethome._tcp` advertisement (@homebridge/ciao) with `id`/`ver`/`api`/`claimed` TXT records. |

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
7. **Observing is not an input.** The hub can show an app everything on its
   broker (`core/mqtt-observer.ts`), and none of it feeds device adoption or
   the AI mapper: adoption reads the retained `bridge/devices` registry, and
   the agent's only input is one device's entry from it. Permit-join requests,
   bridge logs and hub status are not devices, and `notDeviceShaped()` refuses
   them rather than leaving that to convention — see
   [ai-adaptation.md](ai-adaptation.md) ("What can reach the agent, and what
   cannot").
8. **Watching costs nothing when nobody watches.** The traffic tap and the
   optional WebSocket streams are reference-counted and opt-in: no listener is
   attached and no broker connection is opened until a client asks, and none of
   what they carry is written to disk. A phone showing a room of lights must
   not pay for a developer tool it never opens, and a hub must not write one
   row per sensor report onto an SD card — the same arithmetic behind the
   registry's `STATE_FLUSH_MS` debounce.

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
- AuthZ: `owner` (renaming the home, members, invites, commissioning, AI
  settings, *removing* devices) vs `member` (everything else, including
  controlling devices, renaming them, and adding or editing rooms and zones —
  Studio claims a hub as the Mac, so the owner is usually not a person in the
  house; see `docs/api.md`). Favorites are per member, not per home.
- Secrets: the AI credential (an Anthropic API key) AES-256-GCM-encrypted
  with the hub secret; the key file is 0600 and never leaves the machine.
