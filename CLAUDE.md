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
deployment — launchd + `deploy/hubctl`).

**There is no Docker and no database server anywhere any more.** Linux runs
systemd units (`deploy/install.sh`, `deploy/gethome-hubctl`), macOS runs launchd
agents, and the store is a SQLite file. That was a memory decision: on a
Raspberry Pi Zero 2 W — 512 MB, the smallest supported board — the Docker daemon
took ~130 MB and a stock Postgres another ~130 MB before the hub had started,
and the OOM killer was taking the hub down between the end of the install and
the user claiming it.

## Build, test, run

```sh
npm install
npm run typecheck                         # tsc --noEmit (strict, exactOptionalPropertyTypes)
npm test                                  # vitest — the database is a temp file, so nothing to start
HUB_TEST_MQTT=1 npm test                  # + end-to-end broker round-trip (needs a local mosquitto)
npm run dev                               # tsx watch, reads .env
npm run build && node dist/index.js       # production build (copies SQL migrations into dist)
npm run db:generate                       # drizzle-kit: generate a migration after editing src/db/schema.ts
npm audit --omit=dev --audit-level=moderate  # what CI gates on; reads the lockfile, no install needed
```

`deploy/` has no type checker behind it, so CI runs `shellcheck -S warning` over
every script there. Keep it clean.

**Dependencies are gated, not just watched.** Every vulnerable package this repo
has shipped arrived transitively — `mqtt → socks → ip-address`,
`@anthropic-ai/claude-agent-sdk → @modelcontextprotocol/sdk → hono` — so
`package.json` is not where you would notice. CI's `audit` job fails a pull
request whose lockfile carries a known-vulnerable **production** dependency
(dev-only advisories don't gate: the bundle ships `dist/` + production
`node_modules`, so vitest never reaches a Pi). `.github/dependabot.yml` keeps
the tree moving so those bumps stay small; it deliberately holds matter.js at
its pinned minor. Fix a finding by updating the lockfile — `npm audit fix` is
usually enough, because the vulnerable version is normally pinned there while
the parent's own range already permits the patched one. Reach for `overrides`
only when a parent range genuinely blocks the fix, or when duplicate copies of
one package are themselves the problem — which is what the lone existing
override is now for.

**That override keeps exactly one `esbuild` in the tree, and the second reason
is the load-bearing one.** Four things want it at three different ranges
(`drizzle-kit@^0.25.4` takes the hoisted slot, `tsx@~0.28.0` and `vitest` nest
their own 0.28.x beside it, `@esbuild-kit/core-utils` pins `~0.18.20`), and
esbuild carries 26 per-platform optional packages, so each duplicate is a
27-entry subtree. Dependabot regenerates the whole lockfile on every bump and
**drops one of those subtrees when it does** — it wrote `tsx`'s and lost
`vitest`'s, and `npm ci` then failed every PR with `EUSAGE … Missing:
esbuild@0.28.1 from lock file`, whatever the PR was actually bumping. Pinning
one version collapses all of it: one copy, 26 entries, nothing left to drop.
Removing the override does not simplify this — it restores a *fourth* copy at
the vulnerable `0.18.20`. The cost is that `drizzle-kit` runs above its declared
range, which CI does not cover because nothing there runs `db:generate`; if you
touch these versions, run it by hand and check it still reads the schema.

Green `typecheck` + `test` is the bar for every change. The e2e suites
(`test/integration/mqtt-roundtrip.test.ts` for the whole pipeline,
`test/integration/zigbee-adapter.test.ts` for the Zigbee runtime AI
adaptation) are the proof it all works — run them for any
adapter/registry/API change.

## Architecture: the boundaries that matter

```
adapters (zigbee | mqtt | matter) ──AdapterBus──▶ DeviceRegistry ──▶ SQLite
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
  serialized write queue, write-through cache, JSON state persistence, event
  fan-out, command routing. Adapter start failures are isolated — the hub must
  keep running (and must boot with no devices/radios at all).
  **Endpoint state is written behind a debounce** (`STATE_FLUSH_MS`), because
  persisting on every report meant one whole-row JSON rewrite per sensor
  message, forever, onto an SD card — a power meter alone is a write every few
  seconds. The cache is authoritative while the process runs; the row only has
  to be right when it restarts, so `flush()`/`stop()` are what make that true
  and tests must call one of them before reading rows back.
- **The API listens before the adapters start** (`src/index.ts`). Starting them
  first meant a broker that wasn't up yet, or matter.js opening its storage on a
  slow card, held port 8420 closed — and with it the installer's health check
  and the claim. The three adapters and the AI mapper are also **dynamic
  imports**: `@matter/main` and `@anthropic-ai/claude-agent-sdk` are the two
  largest things in the graph, and a static import loaded them whether or not
  the adapter was enabled.
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
- **`<data>/pairing-code` is a contract, and it now *survives* restarts.** It
  used to be re-minted on every boot, and that was the bug: any code that had
  been read — `install.sh`'s `@@PAIRING@@` marker, or a value Studio fetched a
  minute earlier — was a different number by the time somebody pressed Claim, so
  a finished install ended at `invalid_code` with nothing the user could do.
  Rotation bought nothing: the code only ever proves physical access to the
  machine, and reading the file *is* that access. The file is the source of
  truth; it is deleted the moment the hub is claimed. Don't reintroduce
  rotation.
  **The startup line is part of that contract too.** The file is `0600` and
  owned by the service account, so Studio falls back to grepping
  `Pairing code: <digits>` out of the journal — the exact wording
  `PairingService.boot()` logs. Rephrasing it breaks the last way Studio has of
  handing a user the code it promised they'd never have to find.
- **The code is the *fallback*, not the route.** `gethome-hubctl claim` reads
  the code and claims in one step on the hub's own machine, printing
  `@@HUBID:@@`/`@@TOKEN:@@`; Studio drives it over SSH with the key the card
  planted, so the person who installs a hub never sees a code. Anyone who can
  run it already holds root on the machine the code exists to prove access to.
  `POST /pair` also takes a `claimId` — one UUID per attempt, replayed for five
  minutes — because a hub can commit a claim and lose the response, and without
  it the retry is told the code is wrong. Both halves are load-bearing; neither
  replaces the typed code for a hub Studio has no key on.
- matter.js is pinned to a minor (`~0.17.x`) because its API churns; keep all
  matter.js-specific code inside `src/adapters/matter/`.
- `tsconfig` uses `exactOptionalPropertyTypes` — build optional-field objects
  with conditional spreads (`...(x !== undefined ? { x } : {})`), not
  `x: maybeUndefined`.

## `deploy/` is a contract, not just scripts

- **`install.sh`'s `@@…@@` markers are a wire protocol.** GetHome Studio drives
  its whole install UI off them (`@@STEP@@`, `@@ERROR@@`, `@@WARN@@`,
  `@@BOARD@@`, `@@PAIRING@@`, `@@ZIGBEE_FOUND@@`, `@@ZIGBEE_MAYBE@@`). Adding a
  marker is safe — unknown ones are ignored — but renaming or removing one, or
  changing a **step id**, breaks the app silently: the step ids (`system`,
  `runtime`, `download`, `zigbee`, `start`, `autostart`, `health`) are mirrored
  in Studio's `FirstBootMonitor.installSteps` and `PiInstallView.steps()`.
  Change both repos together. The header comment lists them; keep it accurate.
- **Every install path must leave the hub starting on power-up.** Every unit is
  `systemctl enable`d with `Restart=always`. Don't add a path that needs a human
  to start the hub by hand.
- **The Pi downloads the hub; it does not compile it.** `install.sh` fetches a
  per-architecture tarball (`dist/` + production `node_modules`, native modules
  already built) published by `.github/workflows/bundle.yml` to a rolling
  per-branch release — which is also what makes `--branch` testable on real
  hardware. Building on a Pi is `npm ci` fetching a thousand packages onto an SD
  card plus `tsc`: twenty to forty minutes, several hundred megabytes of memory,
  and on a 512 MB board an OOM kill at the end regardless. So the fallback is
  **refused below 1 GB of RAM** and says why. Starting a build that cannot
  finish is worse than failing in ten seconds.
- **Say what is tested, not just what runs.** README's *Required hardware* is
  the contract: Pi 5 / Pi 4 / Zero 2 W are tested; other 64-bit boards (Pi 3,
  400/500, CMs, x86-64) run but aren't routinely tried, and `install.sh` says so
  with a `@@WARN@@` for Raspberry Pis it doesn't recognise — silently for
  anything that isn't a Pi, where running a home hub is already a deliberate
  choice. Claiming support for hardware nobody has tried is the misleading half
  of that choice; refusing a Pi 3 that has twice a Zero 2 W's memory is the
  other.
- **The limit worth stating out loud is the *combination*.** No coordinator
  means no Zigbee; a 512 MB board means no Matter. Either alone is a footnote,
  and together they leave a hub that can only talk to MQTT integrations — which
  is not what somebody setting up a smart home expects. `install.sh` warns on
  exactly that pair after the Zigbee step, README's *Required hardware* says a
  Zero 2 W effectively requires a stick, and `docs/zigbee.md` lists the ones
  known to work.
- **64-bit only, and the two 32-bit cases are different problems.** Bundles are
  built for `linux-arm64` and `linux-x64` and nothing else. `armv6l` (Pi 1 /
  Zero / Zero W) is unfixable — no Node.js build exists — and the answer is
  different hardware. `armv7l` is almost always *good hardware with the 32-bit
  image on its card*, so it is refused with "rewrite the card", not "buy a
  different Pi"; telling someone to replace a Pi they already own would be both
  wrong and expensive. Studio blocks the same two cases earlier still —
  `SDCardInspector.is64Bit` reads the card before anything is written, and is
  three-valued so an image it can't place is never blocked.
- **Branch bundles are disposable; `v*` releases are not.** Every push publishes
  a rolling `bundle-<branch>` prerelease — assets and tag both move — which is
  what makes `--branch` testable on hardware. `bundle-cleanup.yml` removes each
  one when its branch is deleted (plus a weekly sweep as a backstop), because
  otherwise the tag list grows by one per branch forever. Its guardrails matter:
  only `bundle-` tags, only prereleases, never the default branch's, and an
  empty branch listing aborts rather than deleting everything. The sweep matches
  by building the set of tags the *existing* branches would produce, because
  flattening slashes into the tag name is lossy and cannot be inverted.
- **Versioning is a symlink, not a container.** Each build unpacks into
  `/opt/gethome/releases/<build-id>/` and `current` points at the one that
  runs; CI stamps `VERSION` into the bundle, which names the directory and
  becomes `build` in `GET /hub`. An update unpacks beside the running build and
  flips the link, so switching is atomic — **and if the new build doesn't answer
  the health check, `install.sh` flips it back and says so.** That is the part
  Docker could not have given us: a `docker pull` into the same tag has nothing
  to roll back to. `gethome-hubctl update` re-runs the installer rather than
  reimplementing any of this; `rollback` flips to the previous release.
- **Add nothing to a config file the distribution already writes.** The
  mosquitto drop-in is `listener 1883` + `allow_anonymous true` and must stay
  that way: `/etc/mosquitto/mosquitto.conf` already sets `persistence`,
  `persistence_location` and `log_dest`, and mosquitto treats a repeated string
  option as a **fatal** error rather than an override. Repeating
  `persistence_location` is what kept the broker down, port 1883 closed and
  Zigbee dead on a hub that installed perfectly otherwise.
  `test/deploy-config.test.ts` parses the drop-in against a copy of Debian's
  config to stop it coming back.
- **When a unit won't start, put the reason in the log.** `service_failure()`
  prints `systemctl status` and the last journal lines into the install output.
  The mosquitto bug above was invisible for a whole round because the installer
  did `systemctl restart … >/dev/null 2>&1 || warn "it didn't restart"` — the
  broker was saying exactly what was wrong and we threw it away. Studio's user
  is watching this log on another machine; "check systemctl status" is homework
  they cannot do.
- **Memory limits throttle; they don't kill.** Measured: hubd is ~119 MB
  resident with Matter off, ~178 MB with it on. So `hubd` gets `MemoryHigh`
  only — a hard `MemoryMax` near the working set turns a busy minute into a
  restart, which is what a 260 MB cap was doing. Zigbee2MQTT keeps a hard cap
  because it is the optional process and should die before the hub does. On
  boards ≤ 512 MB `install.sh` also writes `ADAPTER_MATTER=0` and says why:
  70 (OS) + 178 + 150 (Z2M) does not fit in 512 MB, while 70 + 119 + 150 does.
- **Name a failure, don't just relay it.** A dropped download, a full card and
  an OOM kill all happen on a Pi and all want different fixes; `install.sh`
  keeps the output and matches them, because by then the actual reason is a
  hundred lines up a log — which, for someone driving this from Studio, may as
  well be nowhere. The same applies to hardware and to services — see the
  64-bit and `service_failure()` notes above.
- **`deploy/zigbee-detect.sh` decides what a Zigbee coordinator is *and whether
  Zigbee2MQTT runs at all*.** It is installed as `gethome-zigbee-detect.service`
  and fires at boot and from a udev rule on `add` **and** `remove` — so a stick
  bought next month starts Zigbee within seconds, with no reboot and no restart
  of the hub, and unplugging one stops the service instead of leaving it
  restart-looping against a device node that is gone. `gethome-zigbee2mqtt`
  is installed but deliberately **not enabled**: it is a second ~150 MB Node
  process, and holding that open for hardware nobody has bought is memory the
  hub needs. It only acts on hardware it is *sure* about: the same CP210x/CH340
  bridges are used by 3D printers and UPSes, so an unidentifiable device is
  reported and never configured. The device path is written as a
  `ZIGBEE2MQTT_CONFIG_*` override and **never** into Zigbee2MQTT's own
  `configuration.yaml`, which holds the network key and the paired-device list.
  **Its tables are duplicated in GetHome Studio** (`Models/ZigbeeModels.swift`),
  which classifies devices during its SSH preflight — before this script exists
  on the machine. Change both together; `docs/zigbee.md` documents the contract.
- **One mDNS responder per host.** `MdnsAdvertiser` publishes `_gethome._tcp`
  through **avahi** (a static file in `/etc/avahi/services`) wherever avahi
  exists, and only falls back to in-process `ciao` where it doesn't. Running
  both is not redundancy: ciao publishes an A record for `os.hostname()` — the
  same `<host>.local` avahi owns — mDNS calls that a conflict, and the loser
  renames itself. That is why a Pi answered to `raspberrypi.local` right after
  an install and stopped answering after a power cut while keeping its IP.
  `install.sh` also denies `docker0` in `avahi-daemon.conf`, so a Docker
  installed later for something else can't get an unreachable `172.17.0.1`
  published for the Pi's name.
- **Mosquitto listens on the LAN, not loopback.** That is what
  `deploy/mosquitto`'s config always claimed and what the compose port mapping
  quietly contradicted — the reason port 1883 was invisible from the user's Mac.
  MQTT integrations run on other machines; the firewall boundary for a home hub
  is the router.
- **Only install what is missing.** `install.sh` checks each apt package with
  `dpkg-query` first: Raspberry Pi OS Lite already ships avahi-daemon, curl,
  ca-certificates and xz-utils, so the step is "install mosquitto" and takes
  seconds. An unconditional `apt-get update` plus five packages with output sent
  to `/dev/null` was several minutes of a progress screen that looked hung.

## Keep the docs in sync

After landing a change, update the docs it invalidates in the same change:
schema/units/wire → `docs/device-schema.md` (+ the iOS repo needs a matching
change — flag it); routes/auth → `docs/api.md`; adapter behavior/topics →
`docs/zigbee.md` / `docs/matter.md` / `docs/mqtt-integrations.md`; AI
trigger/DSL → `docs/ai-adaptation.md`; module boundaries → this file +
`docs/architecture.md`; installer markers, autostart or Zigbee detection →
`docs/zigbee.md` + the marker list in `deploy/install.sh` (and flag the Studio
repo); anything README restates → `README.md`.
