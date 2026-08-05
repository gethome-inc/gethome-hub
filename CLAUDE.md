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
  model output. The mapping is produced by an autonomous agent
  (`src/ai/agent.ts`, Claude Agent SDK — research-only tools, `submit_mapping`
  MCP tool, backoff on account failures; `docs/ai-adaptation.md` is
  canonical), authenticated with the owner's Anthropic API key or Claude
  subscription token.

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
- Secrets: tokens are stored sha256-only; the AI credential (API key or
  subscription token) AES-256-GCM-encrypted with the hub secret
  (`<data>/hub-secret.json`, 0600); the API never returns key material. Keep
  it that way.
- **`<data>/pairing-code` is a contract, and it is rewritten every boot.** An
  unclaimed hub mints a *new* code on each start, so anything that captured one
  earlier is holding a stale number — which is why Studio reads the file over
  SSH at the moment it claims rather than trusting `install.sh`'s `@@PAIRING@@`
  marker. That is also what keeps the code away from the user entirely: they
  installed the hub, so they have already proved the physical access the code
  exists to prove. Don't move the file or change when it's written without
  fixing Studio's claim path with it.
  **The startup line is part of that contract too.** The file is `0600` inside
  the container and the account driving Docker may not have passwordless sudo,
  so Studio falls back to the volume's path on the host and then to grepping
  `Pairing code: <digits>` out of the hub's own log — the exact wording
  `PairingService.boot()` logs. Rephrasing that message breaks the last way
  Studio has of handing a user the code it promised they'd never have to find.
- matter.js is pinned to a minor (`~0.17.x`) because its API churns; keep all
  matter.js-specific code inside `src/adapters/matter/`.
- `tsconfig` uses `exactOptionalPropertyTypes` — build optional-field objects
  with conditional spreads (`...(x !== undefined ? { x } : {})`), not
  `x: maybeUndefined`.

## `deploy/` is a contract, not just scripts

- **`install.sh`'s `@@…@@` markers are a wire protocol.** GetHome Studio drives
  its whole install UI off them (`@@STEP@@`, `@@ERROR@@`, `@@WARN@@`,
  `@@PAIRING@@`, `@@ZIGBEE_FOUND@@`, `@@ZIGBEE_MAYBE@@`). Adding a marker or a
  step id is safe — unknown ones are ignored — but renaming or removing one
  breaks the app silently. The header comment lists them; keep it accurate.
- **Every install path must leave the hub starting on power-up.** Compose
  services carry `restart: unless-stopped` and `install.sh` enables
  `docker.service` at boot. Don't add a path that needs a human to start the
  hub by hand.
- **The Pi downloads the hub; it does not compile it.** `hubd` runs from
  `ghcr.io/gethome-inc/gethome-hub:latest` (amd64 + arm64 + armhf, published by
  `.github/workflows/publish.yml`). Building on a Pi is `npm ci` fetching a
  thousand packages onto an SD card plus `tsc` — twenty to forty minutes, and
  every minute of it another chance for a dropped connection to lose the lot,
  which is a real failure people hit. Keep the fallback working too:
  `install.sh` pulls first and drops to `docker-compose.build.yml` with a
  `@@WARN@@` when it can't, so an architecture nobody anticipated still ends up
  with a hub. **A private GHCR package fails every pull with `denied`** and
  silently sends everyone down the slow path — after the first publish, make
  the package public and verify with a logged-out `docker pull`.
- **Name a build failure, don't just relay it.** Compose says "failed to build
  or start the stack" for a dropped download, a full card and an OOM kill
  alike, and on a Pi all three happen and want different fixes. `install.sh`
  keeps the output and matches those three, because by then the actual reason
  is a hundred lines up a build log — which, for someone driving this from
  Studio, may as well be nowhere.
- **`deploy/zigbee-detect.sh` decides what a Zigbee coordinator is**, for both
  the install and for hot-plug (it is installed as `gethome-zigbee.service`
  behind a udev rule). It only acts on hardware it is *sure* about: the same
  CP210x/CH340 bridges are used by 3D printers and UPSes, so an unidentifiable
  device is reported and never configured. **Its tables are duplicated in
  GetHome Studio** (`Models/ZigbeeModels.swift`), which classifies devices
  during its SSH preflight — before this script exists on the machine. Change
  both together; `docs/zigbee.md` documents the contract.

## Keep the docs in sync

After landing a change, update the docs it invalidates in the same change:
schema/units/wire → `docs/device-schema.md` (+ the iOS repo needs a matching
change — flag it); routes/auth → `docs/api.md`; adapter behavior/topics →
`docs/zigbee.md` / `docs/matter.md` / `docs/mqtt-integrations.md`; AI
trigger/DSL → `docs/ai-adaptation.md`; module boundaries → this file +
`docs/architecture.md`; installer markers, autostart or Zigbee detection →
`docs/zigbee.md` + the marker list in `deploy/install.sh` (and flag the Studio
repo); anything README restates → `README.md`.
