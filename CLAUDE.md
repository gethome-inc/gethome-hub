# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

GetHome Hub — a local smart-home hub (TypeScript / Node.js 22, ESM) that hosts
Matter, Zigbee (via Zigbee2MQTT), and MQTT devices behind one canonical device
schema and serves them to the GetHome apps over a local REST + WebSocket API.
One hub = one home; sharing = granting members access to the hub. This repo is
**public** (PolyForm Noncommercial + commercial licensing) — never commit
secrets, keys, or non-public ecosystem details.

The `docs/` files are canonical for their domains; read the relevant one before
touching that code: `architecture.md` (module boundaries, data flow),
`device-schema.md` (**the** capability/unit/wire contract), `api.md`,
`zigbee.md`, `matter.md`, `mqtt-integrations.md` (public integrator
convention), `ai-adaptation.md`, `ecosystem.md`, `macos.md` (native macOS
deployment — launchd + `deploy/hubctl`; Docker is Linux/Pi-only because
macOS Docker breaks mDNS/Matter and cannot pass through Zigbee USB).

## Build, test, run

```sh
docker compose up -d postgres mosquitto   # test/dev dependencies
npm install
npm run typecheck                         # tsc --noEmit (strict, exactOptionalPropertyTypes)
npm test                                  # vitest; Postgres-backed suites skip cleanly if the DB is down
HUB_TEST_MQTT=1 npm test                  # + end-to-end broker round-trip (needs mosquitto)
npm run dev                               # tsx watch, reads .env
npm run build && node dist/index.js       # production build (copies SQL migrations into dist)
npm run db:generate                       # drizzle-kit: generate a migration after editing src/db/schema.ts
```

Green `typecheck` + `test` is the bar for every change. The e2e suites
(`test/integration/mqtt-roundtrip.test.ts` for the whole pipeline,
`test/integration/zigbee-adapter.test.ts` for the Zigbee runtime AI
adaptation) are the proof it all works — run them for any
adapter/registry/API change.

## Architecture: the boundaries that matter

```
adapters (zigbee | mqtt | matter) ──AdapterBus──▶ DeviceRegistry ──▶ Postgres
        ▲ execute()                                   │ events
        └──────────── command routing ◀── REST/WS API ┘
```

- **`src/schema/` is dependency-free** (zod only) and is the single source of
  truth: 27 capability kinds (incl. `event` for buttons/remotes, `irRemote`
  for IR blasters, and `custom` — the universal generic-control fallback so
  any parameter is usable), 16 device kinds, typed `EndpointState`,
  `HubCommand` intents (incl. `ir*` learn/replay and `setCustomField`), unit
  converters, Matter device-type catalog, zod wire schemas. Everything else
  derives from it.
- **Adapters only see the `AdapterBus`** (`src/adapters/adapter.ts`). They
  never import `src/api` or `src/db`. Adding a protocol = new directory under
  `src/adapters/` + registration in `src/index.ts`.
- **`DeviceRegistry`** (`src/core/registry.ts`) implements the bus: per-device
  serialized write queue, write-through cache, jsonb state persistence, event
  fan-out, command routing. Adapter start failures are isolated — the hub must
  keep running (and must boot with no devices/radios at all).
- **AI mappings are data, not code**: `MappingDescriptor`
  (`src/ai/descriptor.ts`) is zod-validated and interpreted. Never execute
  model output.

## Conventions that bite if missed

- **Nothing is unsupported by default — three layers, in order.** Devices are
  made usable by (1) **typed capabilities** (canonical schema), then (2)
  **generic custom fields** (`custom`) for every leftover parameter, generated
  statically from the protocol's own metadata, then (3) **AI** for the genuine
  gaps and to upgrade fields to typed capabilities. Layers 1–2 are static (no
  key). A leftover expose must never be silently dropped: settings/vendor knobs
  become fields, only pure telemetry is hidden; `needsReview` means still
  `uncovered` after layers 1–2. This is design rule #6 — full model in
  `docs/zigbee.md` ("The three layers of device support") and
  `docs/architecture.md`. Keep it when editing the mapper.
- **Units are load-bearing** and mirror the GetHome app's Matter schema
  byte-for-byte: level 1–254, mireds, centi-°C, humidity centi-%, covering
  percent-100ths with **0 = open**, battery 0–100, milliwatts, lock 0/1/2,
  fan mode 0–5, airQuality 0–6. The wire format (field names included) is a
  compatibility contract with the iOS app — never change it without
  versioning the API (`apiVersion` in `GET /hub`).
- Zigbee2MQTT conversions to watch: cover position is **inverted** (Z2M
  100 = open), temperatures ×100, power W → mW, energy kWh → mWh, hue/sat
  degrees/percent → 0–254 cluster units. `action` enums parse through
  `adapters/zigbee/actions.ts` into `event` state; multi-endpoint devices
  address channels via suffixed properties (`state_l1`); every other leftover
  expose (settings, vendor knobs) becomes a generic `custom` field from its
  own metadata, so no parameter is unsupported. Tests in `test/zigbee-*.test.ts`
  pin all of these.
- The Matter reducer (`src/adapters/matter/reducer.ts`) is a 1:1 port of the
  iOS `MatterStateReducer` — keep them in lockstep if either changes.
- Secrets: tokens are stored sha256-only; AI keys AES-256-GCM-encrypted with
  the hub secret (`<data>/hub-secret.json`, 0600); the API never returns key
  material. Keep it that way.
- matter.js is pinned to a minor (`~0.17.x`) because its API churns; keep all
  matter.js-specific code inside `src/adapters/matter/`.
- `tsconfig` uses `exactOptionalPropertyTypes` — build optional-field objects
  with conditional spreads (`...(x !== undefined ? { x } : {})`), not
  `x: maybeUndefined`.

## Keep the docs in sync

After landing a change, update the docs it invalidates in the same change:
schema/units/wire → `docs/device-schema.md` (+ the iOS repo needs a matching
change — flag it); routes/auth → `docs/api.md`; adapter behavior/topics →
`docs/zigbee.md` / `docs/matter.md` / `docs/mqtt-integrations.md`; AI
trigger/DSL → `docs/ai-adaptation.md`; module boundaries → this file +
`docs/architecture.md`; anything README restates → `README.md`.
