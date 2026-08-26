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
convention), `ai-adaptation.md`, `ecosystem.md`.

**There is no Docker and no database server anywhere any more.** The hub runs as
systemd units (`deploy/install.sh`, `deploy/gethome-hubctl`) and the store is a
SQLite file. That was a memory decision: on a Raspberry Pi Zero 2 W — 512 MB,
the smallest supported board — the Docker daemon took ~130 MB and a stock
Postgres another ~130 MB before the hub had started, and the OOM killer was
taking the hub down between the end of the install and the user claiming it.

**Deployment is Linux only, and a Mac hub is gone rather than deferred.**
There was a native macOS path — `install-macos.sh`, launchd agents,
`deploy/hubctl` — and it was removed because it had quietly stopped being a hub.
It wrote a Zigbee2MQTT config with no `onboarding: false`, so Z2M 2.x sat in its
browser wizard and the radio never came up. It never passed `Z2M_DATA_DIR` to
hubd, so `zigbee.problem` read a Linux path that does not exist on a Mac and
diagnosed nothing. With no `/etc/avahi/services` the mDNS backend fell to
`ciao`, which then competes with the Mac's own mDNSResponder for `<host>.local`
— the exact conflict `mdns/advertiser.ts` exists to avoid. `PUT /settings/radio`
answered `applying: true` to a file no watcher read. And there was no
coordinator detection, no prebuilt bundle, no atomic release or rollback, and a
marker vocabulary Studio had moved on from. GetHome Studio has since deleted
its own half too — `LocalMacInstaller`, the This-Mac wizard path and the
service card — so the product is a Raspberry Pi hub, on both sides.

`src/` stays portable, and that is about *development*: nothing in it is
Linux-only and the suite runs on macOS, which is where most of it is written.
It is not a head start on a Mac hub. **If one is ever wanted, write it fresh
against the system as it is then, and restore nothing from history** — the
marker contract, the radio budget, the coordinator watcher, the bundle and
rollback layout and Studio's own flow have all moved since that code last ran,
so a resurrected copy would be a plausible-looking wrong map rather than a
starting point. Don't reintroduce half of it either: a second OS that
implements none of the rules below is the installed-but-unusable trap this file
names elsewhere.

## Build, test, run

```sh
npm install
npm run typecheck                         # strict, exactOptionalPropertyTypes — src *and* test/
npm run typecheck:test                    # just the test-suite pass, while iterating on a suite
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
has shipped arrived transitively — `mqtt → socks → ip-address`, and
`@anthropic-ai/claude-agent-sdk → @modelcontextprotocol/sdk → hono` before that
whole subtree left with the Agent SDK — so `package.json` is not where you would
notice. CI's `audit` job fails a pull
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
  **A radio that isn't running is not a home that is fine.** Per-device
  reachability only ever arrives *from* a running radio, so nothing could say
  that a radio which is off, failed, or lost its bridge took every device with
  it — they were read back out of SQLite with the `online` they last had and
  kept it, so switching a one-radio board to Matter left the Zigbee half
  reading healthy and answering nothing. `AdapterBus.radioReachabilityChanged`
  is the statement; `start()` makes it for every adapter that is not registered
  or failed to start, and the Zigbee adapter makes it on `bridge/state`. **Both
  directions**, because Z2M ships with availability tracking off, so a hub that
  only ever marked devices down would never bring them back. It also emits
  `radioChanged`, which `api/ws.ts` fans out as a `hubStatus` frame carrying
  the same `zigbee`/`radio` blocks `GET /hub` answers with — from the same
  snapshot (`core/hub-status.ts`), because two shapes for one fact drift.
  **`PUT /settings/radio` emits the same frame** through `hubStatusChanged`,
  a separate event because `radioChanged` is the registry's statement about
  reachability and has arguments a mode change would have to invent. Both
  matter for the same reason: a mode change that doesn't move Matter restarts
  nothing, so a client cannot wait for its socket to bounce, and not every app
  polls `GET /hub` — the iOS app doesn't.
  **Before** the device frames: those say which devices went, this says why,
  and a client told in the other order draws a home half offline with nothing
  to explain it. That is the moment somebody pulls a stick out of a Pi. It routes through
  the per-device path on purpose: already serialized, already quiet for a
  device in that state, already emitting `deviceUpserted`.
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
  imports**: `@matter/main` is by far the largest thing in the graph, and a
  static import loaded it whether or not the adapter was enabled. The AI
  mapper keeps the seam for a second reason — the credential check runs on
  every call, so a key added later works without a restart.
- **AI mappings are data, not code**: `MappingDescriptor`
  (`src/ai/descriptor.ts`) is zod-validated and interpreted. Never execute
  model output. The mapping is produced by an autonomous agent
  (`src/ai/agent.ts` — a tool-use loop on the Anthropic Messages API with the
  server-side `web_search`/`web_fetch` research tools, `submit_mapping` as its
  only answer channel, backoff on account failures; `docs/ai-adaptation.md` is
  canonical), authenticated with the owner's Anthropic API key.
  **It used to run on the Claude Agent SDK, and moving off it was a memory
  decision like dropping Docker.** That SDK ships a 276 MB native binary — 74%
  of the hub's whole download — and spawned a ~315 MB subprocess per run, of
  which ~224 MB is mapped binary pages. On a Zero 2 W that thrashes against
  the SD card instead of OOM-ing and outlives the 10-minute watchdog, so AI
  adaptation was installed-but-unusable on the smallest supported board. The
  bundle went 117 MB → 29 MB. The cost is that Claude subscription tokens no
  longer authenticate; only API keys do, and `src/ai/models.ts` is an
  allowlist because the `_20260209` research tools need Opus 4.6+/Sonnet 4.6+.

## Conventions that bite if missed

- **Observing is not an input, and the wall is in the code.** The hub can show
  an app everything on its broker (`core/mqtt-observer.ts`, behind the opt-in
  `mqtt` WebSocket stream), and none of it reaches device adoption or the AI
  mapper. Adoption reads the retained `bridge/devices` registry; the agent's
  only input is one device's entry from it plus that device's own recent
  payloads. Permit-join requests, `bridge/logging`, bridge status and the hub's
  own commands are not devices — `notDeviceShaped()` in `src/ai/mapper.ts`
  refuses anything without an IEEE address and a published schema, refuses the
  coordinator, and refuses a `bridge/…` name, and the system prompt says the
  same thing so a run that somehow received one refuses rather than inventing a
  mapping for a model that does not exist. `test/ai-boundary.test.ts` pins it.
  **`ai_enabled` is the owner's switch and is deliberately not the credential**:
  "stop spending my money on this for now" and "forget my API key" have very
  different costs to undo, and deleting the key used to be the only way to ask
  for the first. It defaults to on (a hub configured before it existed is
  unchanged), is checked in `lazy.ts` beside `hasKey` so the module is not even
  imported, and again in `resolveProvider()` for a mapper somebody constructed
  directly. An explicit run answers `409 ai_disabled`, which is a *different*
  refusal from `409 ai_not_configured` because an app has to say which of the
  two a person needs to change.
- **Watching costs nothing when nobody is watching.** `MqttObserver` is
  reference-counted: it opens no broker connection, holds no buffer and makes
  no wildcard subscription until a client subscribes, and lets go a minute
  after the last one leaves — long enough that switching screens and back does
  not clear the log. Nothing it sees is written down, because traffic is a
  stream a person watches rather than a record, and one row per sensor report
  onto an SD card is what the registry's `STATE_FLUSH_MS` debounce exists to
  avoid. Its buffer is bounded in **bytes as well as rows**: 300 sensor reports
  are a few kilobytes while one `bridge/devices` on a large network is
  hundreds — counted with `Buffer.byteLength`, not `String.length`, which is
  UTF-16 units and under-reports a Cyrillic-named network by up to three times.
  **A cut payload says how much was cut.** The per-message limit was 2 KB and
  landed in the middle of the useful range: a device report is a few hundred
  bytes and `bridge/info`, `bridge/event` and `bridge/health` are one to three
  kilobytes, so the cap fell on messages that had only just become interesting.
  It is 8 KB, which clears all of those whole and still cuts the two retained
  registries — `bridge/devices` and `bridge/definitions` are reference data
  rather than traffic, and holding one costs a Zero 2 W real memory on a
  subscription that exists to be looked at. Frames therefore carry
  `payloadBytes` (the whole message's size) beside `truncated`, so an app says
  "8 KB of 341 KB" instead of asserting a constant from this repository — and
  the cut lands on a **character**, via `StringDecoder`, because
  `subarray().toString('utf8')` splits a multi-byte sequence and puts `U+FFFD`
  on the end of every Cyrillic or CJK name. Nothing but the inspector ever sees
  a cut payload: the adapters hold their own broker connections.
  The same rule governs `src/api/ws.ts` — the `mqtt`, `zigbee` and
  `ai` streams are opt-in, so a socket that never subscribes never has a
  listener attached and the iOS app is untouched; `hello` advertises what the
  hub can offer so a client never infers it from a version number; and frames
  are rate-limited per socket with the losses *reported*, since a gap nobody is
  told about is worse than a gap.
- **The activity log records what was *asked*, never what was reported.** It is
  the home's history and the iOS app's "Recent" feed reads it, so the
  temptation is to write a row whenever anything changes — which is the
  `STATE_FLUSH_MS` mistake with a different name: a power meter reports every
  few seconds, forever, onto an SD card. The line is commands and discrete
  transitions. `device.command` is written per API call, `device.online` /
  `device.offline` only when reachability actually flips, and a state report
  writes nothing at all. The cost of holding that line is that a wall switch
  somebody flips by hand is invisible; the cost of crossing it is the card.
  **Start-up is not history**: reachability entries are suppressed for
  `REACHABILITY_QUIET_MS` after `registry.start()`, because on boot every
  adapter re-establishes what it can reach and each device whose stored row
  disagrees produces a transition nobody made — without it, every hub restart
  filled the feed with "X went offline · X came back" for a home where nothing
  moved. **Retention is two bounds** (`core/activity.ts`): 5 000 rows for the
  disk, 30 days for relevance, whichever bites first, pruned at most hourly and
  hung off the next write so a quiet hub never wakes to do it. And **`message`
  is the contract, `data` is the convenience**: every entry carries a whole
  sentence, because Studio renders that and an unknown `kind` must still say
  something true; `data` repeats it structured (`command`, `deviceName`,
  `memberName`) so an app can write its own wording, pick an icon and fold a
  burst — and it copies the *names* because both ids are `ON DELETE SET NULL`
  and a row read next week may be all that is left of the device. Everything in
  it is optional; nothing may require it. Adding a kind is safe, and the log is
  shared by design — any member reads all of it, by name.
- **A join window is several grants, and Zigbee2MQTT is the authority.** A
  permit-join duration travels as a uint8 of seconds, so **254 is the most one
  grant can last** — a protocol fact, not a Z2M one. `core/permit-join.ts`
  re-issues, and sizes the last grant to expire *on* the deadline rather than
  past it: a network left open for three minutes after the countdown the owner
  was shown reached zero is worse than not offering a countdown. `bridge/info`
  (`permit_join`, `permit_join_end`) overrules our own timer, because it knows
  about restarts and radio failures and we don't, and a window opened from
  Z2M's own UI is adopted rather than reported as closed. It fails closed. The
  route's old ceiling of 254 was a protocol fact masquerading as a policy; the
  limit is 900 now, and `GET /hub` carries `zigbee.permitJoin` because a client
  that has just connected has no other way to learn the state — which is how
  GetHome Studio came to draw "Close Network" over a network that had shut two
  minutes earlier.
- **Two bridge topics are relayed; the rest are still dropped.**
  `bridge/devices` lists a device only once its interview *finishes*, so
  without `bridge/event` the whole of pairing produced no output at all, and
  `bridge/info` is the join window above. The translation into the hub's
  vocabulary lives in `core/zigbee-events.ts` with a **type-only** import of
  the adapter, so adapters still see nothing but `AdapterBus` and the module
  stays out of a Matter-only hub's graph. Only the *failure* and the
  *departure* are written to the activity log — the rest is transient and the
  registry already writes `device.added` on adoption, so recording every step
  would put several rows saying "joined" in a log meant to be read a week
  later. The adapter used to write a `zigbee.joined` row of its own and no
  longer does: it gated that on its **in-memory** `byIeee` map, which is empty
  on every process start, so each restart re-announced every paired device —
  "0x54ef44100047c1bf joined over Zigbee", dated now, beside a `device.added`
  from months ago. A join is the registry's to record because the registry is
  keyed on the database; anything keyed on adapter memory is a restart
  artifact, not history.
  Read **both** `interview_completed` and `interview_state`: Z2M 2.x replaced
  the first with the second, so `interview_completed === false` read
  `undefined === false` on current installs and adopted devices mid-interview.
- **The AI cache is a library now, and a rejection is a step.** `ai_mappings`
  has always made the second device of a model free; what was missing was any
  way to see it, carry it to another hub, or fix an entry that was nearly
  right. `src/ai/library.ts` adds five routes, and only `repair` needs a
  credential — listing, downloading, uploading and deleting are local
  operations on stored JSON, and gating them on a key would be the same mistake
  as gating the static mapper on one. Three rules: the download is an
  **envelope**, because a bare descriptor does not say which device it is for,
  and the upload accepts either; a mismatched `exposesHash` is **accepted and
  flagged**, since a mapping from a neighbouring firmware revision is the case
  this exists for; and a refused document is a **422 with the reasons and is
  kept**, because "invalid, try again" is a dead end for somebody who cannot
  read a zod issue path — `repair` hands the draft and the complaints back to
  the agent, bypassing the cache, since a `rejected` row is exactly what it is
  fixing. `exposesHash` lives with the exposes mapper, not with the AI: it is a
  property of the device's published schema, and the adapter records it in
  `DeviceRecognition` without importing the AI stack.
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
- **A name is the house's, a favorite is one person's, and that split decides
  where each is stored.** Device names, rooms and zones sit on shared rows and
  everybody sees the same ones; a favorite is `device_favorites` keyed by member
  (`src/core/favorites.ts`), so pinning the kettle reaches one dashboard. The
  wire is unchanged — `GET /devices` still answers a boolean called `favorite`,
  rendered *per caller*, which is why `deviceWire` takes it as an argument and
  `ws.ts` renders `deviceUpserted` per socket rather than once for the bus.
  Three rules. **The old `devices.favorite` column stays**, maintained as the
  union of everybody's pins: `install.sh` rolls back to the previous release
  when a build fails its health check, by which time the migration has run, and
  a dropped column would meet an older build that selects it on every device
  query. **Any member may reshape the home** — rename a device, move it, add or
  delete a room or a zone. That was owner-only, which sounds careful and locked
  the feature away from everybody who lives there: Studio claims a hub as *the
  Mac*, so the owner is usually a laptop in a drawer and the phones are plain
  members, and a device called `0x54ef44100047c1bf` has to be fixable by whoever
  is standing in front of it. Owner-only still guards taking things *away*
  (`DELETE /devices/:id`, members) and every edit is logged with a name.
  And **the favorites map is not a second source of truth**: it is loaded once
  at boot, `forgetDevice` is wired to the `deviceRemoved` event and
  `forgetMember` to `endMembership`, because both deletes are done by the
  cascade and the map would otherwise hold pins on things that are gone.
- **Zones are the layer above rooms, and are deliberately not floors.** A room
  belongs to one zone or to none, and none is the ordinary case — which is the
  whole argument: a flat has no floors and a garage is not one, so a *floor*
  field asks every home that isn't a house to leave it blank or lie in it, while
  a zone called "Second floor" covers the house perfectly. It is also Apple
  Home's own word (`HMZone`), and the iOS app shows Apple Homes beside hub homes.
  Two things to keep. `rooms.zone_id` carries **no `ON DELETE` action and the
  route does that work** (`DELETE /zones/:id` clears the column first): SQLite
  cannot attach one to a column added by `ALTER TABLE`, and the usual rebuild is
  unsafe here — drizzle migrates inside a transaction, where
  `PRAGMA foreign_keys=OFF` is a no-op, so dropping `rooms` would fire
  `devices.room_id`'s own set-null and quietly empty every room in the home on
  upgrade. And **every room/zone write broadcasts the `structure` frame** with
  both lists in full, because rooms are shared and a change on one phone used to
  reach the others only when they happened to reconnect.
  **A room's `icon` and `accent` sit beside its name for the same reason it
  does** — everybody in the home should see the same kitchen in the same colour
  — and both are **null by default, meaning "the app decides"**: the apps derive
  a glyph from the name and hand out colours in turn, so a room nobody has
  styled stores nothing and looks exactly as it always did. The hub deliberately
  does not validate the vocabulary (an allowlist here would need a hub upgrade
  for every colour an app adds, and an unknown token costs only a fallback to
  the derived look), and a restyle is deliberately *not* written to the activity
  log, which is read a week later and is not where "the kitchen is blue now"
  belongs.
- **Units are load-bearing** and mirror the GetHome app's Matter schema
  byte-for-byte: level 1–254, mireds, centi-°C, humidity centi-%, covering
  percent-100ths with **0 = open**, battery 0–100, milliwatts, lock 0/1/2,
  fan mode 0–5, airQuality 0–6. The wire format (field names included) is a
  compatibility contract with the iOS app — never change it without
  versioning the API (`apiVersion` in `GET /hub`).
- **A device's `friendly_name` is its address until somebody renames it, so it
  is not a name.** Zigbee2MQTT names a newly joined device after its own IEEE —
  `friendly_name: "0x54ef44100047c1bf"` — and passing that through as
  `suggestedName` put eighteen characters of hex on the tile in the GetHome app,
  which reads as a hub that failed to recognise the device. It hadn't: the same
  `bridge/devices` record carried a full `exposes` schema, a vendor, a model and
  upstream's own one-line description, all mapped correctly. `suggestedNameFor()`
  prefers that description ("Smart plug EU"), then vendor + model, and appends
  the last four hex digits because two units of one model would otherwise be two
  identical rows. Not the device *kind* ("Outlet") — the apps already show that
  on its own line, and repeating it says nothing about which plug this is. Two
  names always win over it: one somebody set in Z2M, and the owner's, since
  `insertDevice` writes this on the insert only and never over an existing row.
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
- Secrets: tokens are stored sha256-only; the AI credential (an Anthropic API
  key) AES-256-GCM-encrypted with the hub secret (`<data>/hub-secret.json`,
  0600); the API never returns key material. Keep it that way.
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
- **The token is the identity, so `me` is a member id.** A client that claimed
  over SSH never learns its member id — `gethome-hubctl claim` prints the hub id
  and the token and nothing else — so it held a working token and could not pick
  its own row out of `GET /members`. Two answers, both additive: every row
  carries `isSelf`, and renaming goes through `PATCH /members/me`, which asks
  for no id at all. Any member may rename *itself* (the owner-only rule guards
  the shape of the home, not what somebody calls themselves) and no route
  renames anybody else. Names are trimmed before they are measured, in one
  schema shared with `POST /pair`: a name that is only spaces is a 400, not a
  member row with nothing to click on. This is what lets GetHome Studio — which
  has no accounts and no user name of its own — claim as *the Mac* and offer
  the rename afterwards.
- **Access is a table the home edits, and three rules hold it up.** Roles are
  rows (`roles`), permissions are a named vocabulary owned by
  `src/core/access.ts`, and a member holds one role; `requirePermission` in
  `api/auth.ts` is the only guard left — `requireOwner` is gone rather than kept
  beside it, because two mechanisms are two places for a route to be wrong.
  `docs/api.md` is canonical.
  **First, the floor is not a permission.** Reading the home, **working a
  device**, renaming yourself, leaving, and pinning your own favorites are what
  *being a member* means and no role can take them away — a member with nothing
  at all is a token that can only 401 behind an app with nothing to draw.
  Switching things on was a `device.control` key for a day, and it is the
  clearest case the floor has: an app whose whole job is working the home cannot
  have a member who may not work the home, and a permission every role must hold
  is a matrix row that can only ever be wrong — somebody turns it off and finds
  out. Gone, rather than shipped switched on for everybody; the commands route
  takes any token. That is also why
  `PATCH /devices/:id` is the one route whose check reads the *body*:
  `name`/`roomId` are the house's and need `device.edit`, while the caller's own
  `favorite` needs nothing, and a guest who can work the lights must be able to
  put the kettle on their own dashboard.
  **Second, the owner is never evaluated.** `can()` answers `true` for the owner
  without reading a stored set, so a permission a later build adds is theirs
  automatically and no edit to the matrix can lock a home out of itself. One
  refusal follows: the owner's *role* row cannot be edited or deleted
  (`role_is_owner`), because nothing reads it.
  **Owner is otherwise an ordinary role** — invitable, assignable, revocable,
  and holdable by several people at once — held up by two rules instead of the
  flat refusal it used to be. **Only an owner grants or revokes it**
  (`403 not_owner`, deliberately not `owner_only`, which both apps read as "this
  hub is too old"), and that check is what keeps `role.manage` safe to delegate
  to a role a home invented: without it the permission would quietly mean "can
  make myself owner" and every other key would be a formality. **A home always
  keeps one owner** (`cannot_change_owner` / `cannot_remove_owner`, narrowed
  from "any owner" to "the last"), because granting the role is owner-only, so a
  home with none has nobody left who could give it one.
  **Third, the defaults are the old behaviour written down.** `member` is, key
  for key, what `authed` used to allow; the keys missing from it are what
  `ownerOnly` used to refuse. Updating a hub changes nothing until somebody
  edits the matrix, and `test/roles-migration.test.ts` proves that against rows
  written by the old schema rather than asserting it. The old three-part test
  for *giving something away* survives as the guidance for **choosing a
  default**: bounded cost, destroys nothing, and named in the activity log.
  **Updating the hub is the worked example, and the plainest case of the trap
  the old rule kept falling into.** It was owner-only on the reasoning that an
  update is not merely "bringing something new in" — it replaces the code every
  member depends on and runs migrations a symlink flip does not undo. What that
  missed is who the owner *is*: Studio claims a hub as *the Mac*, so the owner is
  a laptop in a drawer and every phone joins by invite, with Owner something an
  owner hands over and nobody had — so owner-only did not mean "this needs care", it meant
  the phone in the owner's own hand could never update their own hub, ever. It
  passes all three tests (the installer's own rollback is what bounds it, which
  is why `test/migrations.test.ts` turns "migrations stay readable by the build
  before them" from a hope into a rule), so `hub.update` is in **member**'s
  default set as well as the owner's. It is a permission rather than the floor
  because a guest staying the weekend has no business restarting the house.
  **An access change reaches every open socket, not only the members it is
  about.** The `access` frame has two halves with two audiences: `role` and
  `permissions` are personal, while `roles` — the whole table, each row with its
  `memberCount` — is the home's. `announce` named the holders of the edited
  role, which was right about the first half and left the second stale
  everywhere else: creating a role reached nobody (it has no holders), deleting
  one the same (it is refused while held), an owner editing Guest heard nothing
  about their own edit, and moving one person between roles left two
  `memberCount`s wrong on every other screen — so both apps drew a matrix that
  only moved when the page was closed and reopened. It is a broadcast now, and
  that is not a leak: `accessFrame()` is per socket, so everybody still gets
  their own answer, and the role table is the floor to read anyway.
  Two consequences worth knowing. `activity.read` **narrows rather than
  refuses** — a member without it still reads their own rows, on the route and
  on the socket, because a Recent feed that 403s is a broken screen; the socket
  asks at *send* time, so a grant lands with no reconnect. And `members.role` /
  `invites.role` stay, maintained as owner-or-member, for the same reason
  `devices.favorite` does: `install.sh` rolls back on a failed health check by
  which time the migration has run, and the older build reads that column on
  every authenticated request.
  **Deleting a role takes its outstanding invites with it**, and the reasoning
  is the same shape as the refusal above. `invites.role_id` is a column added
  by `ALTER TABLE` too, so it carries no `ON DELETE` action and the raw foreign
  key was what refused — a 500 for an ordinary thing to do. Clearing it would
  let that code admit its holder as a plain **Member**, which is precisely the
  silent reassignment `role_in_use` exists to refuse; refusing the delete would
  be a dead end, since no route revokes an invite. So the codes go: an invite's
  whole content is "join as this", it lives fifteen minutes, and minting
  another is one tap.
- **Anything that touches a permission, a role, a guard or a default is not
  done until the four suites are.** This is the "Keep the docs in sync" rule
  applied to the part of the system where the *cost* of drifting is somebody
  getting access nobody granted them, and it is a standing requirement rather
  than a nicety — the audit that produced these files found refusals tested for
  the guest table and almost nowhere else, which is exactly the shape of hole
  that hides an escalation. `test/access.test.ts` is `AccessService` with no
  server in front of it: the owner answered without a table, a key a newer
  build stored, a row an older build wrote, `forgetMember`. `test/roles.test.ts`
  is the guards and the socket, over a real listening server, and its
  `[method, url, permission, payload]` tables are where a new route belongs —
  **both** halves, since a permission with only a refusal test can be broken by
  denying everybody. `test/roles-migration.test.ts` runs the migration against
  rows written by the old schema and is what proves "the defaults change
  nothing" rather than asserting it. `test/pairing.test.ts` owns the invite →
  role path, which is the only place a role is chosen for somebody who has no
  member row yet. A new permission key needs a line in the defaults assertion,
  a guard test both ways, and a row in `docs/api.md`'s two tables; a new guarded
  route needs its row in the refusal table and an allowed case somewhere.
  **`npm run typecheck` covers `test/` as well as `src/`, and that is what
  `tsconfig.test.json` is for.** It did not, for a while, and this is the rule
  that paid for it: `tsconfig.json` is the *build*, so it is `src`-only with
  `rootDir: "src"`, and a suite that built a server with one of `ApiDeps`'
  required fields missing compiled clean locally and failed in CI — where
  mosquitto exists and `HUB_TEST_MQTT=1` actually runs the e2e suites. It
  happened twice over the same field: `access` was added to the deps and two
  `buildServer` call sites in `test/` never got it, which read as
  `TypeError: list.map is not a function` on a route answering 500, a hundred
  lines from anything naming the real cause. The second config is that same
  strictness with `rootDir` widened to the repository root — the only thing
  that was ever in the way — over `src`, `test` and the two root configs;
  `typecheck` runs it *after* the build's own pass, so the command CI runs and
  the command a contributor runs cannot mean different things, and
  `typecheck:test` is the second half alone for iterating on a suite. Keep both
  passes: only the `src`-only one enforces `rootDir`, which is what keeps
  `dist/` flat, and `test/typecheck-config.test.ts` pins all of it — the file
  list `tsc --showConfig` resolves, the strictness flags, and that
  `typecheck` really does call `typecheck:test`, because a second config
  nobody runs is the same gap with a config file in it. Copy a `buildServer`
  call from `test/api.test.ts` or `test/roles.test.ts` rather than extending
  an older one from memory — the checker names a missing field now, but it
  cannot tell you which service the suite actually wanted.
  **Two shapes of fixture came out of turning it on, and both are worth
  recognising.** A literal typed as `MappingDescriptor` or `AppliedAiMapping`
  is a *parsed* one, so it carries what zod's `.default([])` filled in
  (`customFields`) and what the mapper computed (`typedProperties`) — write a
  fixture as what the parse would have produced, not as the input a model
  emits. And a table of request cases must type its payload column as
  `object | undefined`, never `unknown`: narrowing `unknown` leaves `{} | null`,
  which is not an inject payload, so Fastify quietly resolves `app.inject` to
  its *chainable* overload and every `response.statusCode` in the loop stops
  being checked along with it.
- **Ending a membership has two halves, and only one of them is the database.**
  Deleting a member takes their tokens with the row (`tokens.member_id`
  cascades, `foreign_keys = ON`), which ends every REST call they can make. It
  does nothing to the WebSocket they are *already* holding: a socket authorizes
  once, when it opens, so the stream carried on until the connection happened
  to drop — a hub restart, a Wi-Fi blip, possibly days. `MemberSessions`
  (`src/api/ws.ts`) is the registry that closes it, and `endMembership` in
  `server.ts` is the one path both removal routes go through. Three rules.
  **Sockets before the log write**, or the departing member's last frame is the
  announcement of their own departure. **`UNAUTHORIZED_CLOSE_CODE` (4001) is
  reused rather than joined by a sibling** — it already means "this token is no
  good", clients already stop reconnecting on it, and a second code would have
  every existing client retry a token that will never work again; it is a
  cross-repo contract with Studio's `HubSocket` and the iOS `HubClient`.
  And **registration is scoped to the socket's life** — `authorize` adds,
  the close handler removes — so the map holds one entry per open connection
  and none per closed one. `test/api.test.ts` opens a real socket, removes its
  member, and asserts both the close code and the silence. **Revoking is the
  only thing this registry does**, and it briefly carried a `notifyAccess`
  channel beside it on the reasoning that a role edit and a removal are one
  question asked with different force. They are not: a removal is about one
  member, and an access change is about the home — see the `announce` note in
  the access bullet above. Nothing ever called it, and a per-member access
  channel sitting there unused is an invitation to wire the narrow rule back
  in, so it is gone.
- **One hub, one home, one name — and `HUB_NAME` only seeds it.** There used to
  be two names: `GET /hub` answered `HUB_NAME` from `/etc/gethome/hub.env`,
  which the installer writes once and nobody ever edits, while `GET /home`
  answered a database row the apps could rename. A home cannot move between
  hubs, so the second name was never a second fact — only a second place for
  the first one to be wrong, and it was: a hub renamed to "Дача" in the app
  still advertised itself as "GetHome Hub" over mDNS and still read "GetHome
  Hub" in GetHome Studio, where two hubs were two rows with the same name.
  `src/core/home.ts` holds the one name; `GET /hub`, `GET /home` and the
  WebSocket hello all read it from there, and `PATCH /home` is the only writer.
  Three rules: **the environment seeds and the database owns** — `HUB_NAME`
  names a hub booting for the first time and is inert afterwards, which is why
  it is documented as a seed in `config.ts`, `.env.example` *and* the `hub.env`
  the installer writes (a variable that silently stops working is the trap this
  replaced); **the name is held in memory**, because `GET /hub` is the health
  check every app and installer polls and must not become a database read per
  request; and **a rename re-publishes mDNS** (`MdnsAdvertiser.updateName`),
  because a hub answering to its new name over HTTP while advertising the old
  one is the same split this change removed. Renaming deliberately needs no
  root and no restart — the same reason the radio mode lives in the data
  directory rather than in `hub.env`.
- matter.js is pinned to a minor (`~0.17.x`) because its API churns; keep all
  matter.js-specific code inside `src/adapters/matter/`.
- `tsconfig` uses `exactOptionalPropertyTypes` — build optional-field objects
  with conditional spreads (`...(x !== undefined ? { x } : {})`), not
  `x: maybeUndefined`.

## `deploy/` is a contract, not just scripts

- **`install.sh`'s `@@…@@` markers are a wire protocol.** GetHome Studio drives
  its whole install UI off them (`@@STEP@@`, `@@ERROR@@`, `@@WARN@@`,
  `@@BOARD@@`, `@@PAIRING@@`, `@@ZIGBEE_FOUND@@`, `@@ZIGBEE_MAYBE@@`,
  `@@CAPABILITIES@@`, `@@ROLLBACK@@`). Adding a
  marker is safe — unknown ones are ignored — but renaming or removing one, or
  changing a **step id**, breaks the app silently: the step ids (`system`,
  `runtime`, `download`, `zigbee`, `start`, `autostart`, `health`) are mirrored
  in Studio's `FirstBootMonitor.installSteps` and `PiInstallView.steps()`, and
  now in the iOS app's `HubUpdateStep` as well, since a phone shows the same
  checklist while the hub updates itself. Change all three repos together. The header comment lists them; keep it accurate.
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
- **A small board runs one radio; which one is decided by what is plugged in,
  not at install time.** 512 MB fits the OS, the hub, and *either* Matter
  (~60 MB in-process) *or* Zigbee2MQTT (~150 MB, its own process). `install.sh`
  writes that as a **budget** (`GETHOME_RADIO=one|both`, measured from RAM);
  the home's **mode** (`auto|zigbee|matter`) lives in `<data>/radio-mode` and
  reaches it through `PUT /settings/radio`. `gethome-zigbee-detect` is where the
  two meet, because it is the only thing that knows whether a coordinator is
  actually there. **Matter gives way only to Zigbee that is genuinely going to
  run** — the installer used to switch it off on every small board, so a
  stickless Zero 2 W held 150 MB for a process that never started *and* went
  without Matter, leaving a hub that could talk to almost nothing. That trap is
  the reason for the rule, so don't reintroduce it by simplifying the matrix.
  `docs/zigbee.md` ("Zigbee or Matter on a small board") is canonical; the
  install ends with an additive `@@CAPABILITIES:<list>@@` marker naming what the
  hub actually ended up able to talk to, and Studio shows the same list on the
  hub page.
  **Follow a coordinator *in*; never follow one *out*.** Plugging a stick in is
  an unambiguous instruction and the detector acts on it in seconds. Pulling one
  out is not — it is equally "done with Zigbee" and "two minutes into flashing
  it", which is *step one of the firmware update we tell people to do*. The
  guesses cost differently: guessing "done" rewrites `hub.env` and restarts the
  hub (~70 s of closed port on a Zero 2 W) right as the owner reads the flashing
  steps off that hub's own page, then restarts again when the stick returns;
  guessing "back soon" costs a radio that wasn't going to work anyway. So
  removal changes nothing — Z2M stops, the board stays put, and the owner
  switches in the app. `zigbee.env` is the memory that tells "never had one"
  (→ Matter) from "unplugged" (→ leave it alone); it is written on first sight
  and never deleted. Don't re-add symmetry here.
- **The hub records the radio choice; it never applies it.** Applying means
  rewriting `/etc/gethome/hub.env`, stopping or starting a unit and restarting
  the hub — all root, none of it something the service user should be able to
  do. So `src/core/radio.ts` writes one word into the hub's own data directory,
  `gethome-radio.path` (`PathModified`) notices, and the detector applies it. No
  sudo rule, nothing new to lock down. The consequence for callers is that
  `PUT /settings/radio` returns `applying: true` and a *stale* `matter` — what
  is live comes from `ADAPTER_MATTER` and the adapters, never from the file.
  `apply_matter()` restarts the hub only when the value really changed, because
  this script runs on every USB event and a hub that restarted whenever somebody
  plugged in a phone charger would be worse than the problem being solved.
- **The hub can update itself, and it records the request exactly the way it
  records a radio.** `POST /system/update` writes one line into `<data>/update/`,
  `gethome-update.path` notices, and `deploy/update-runner.sh` (installed as
  `/usr/local/lib/gethome-update.sh`, root, `Type=oneshot`) runs
  `gethome-hubctl update`. That is what lets a phone update a hub at all —
  Studio does it over SSH with a key it planted, and an iPhone has none.
  Any member may ask; see the owner-only bullet above for why that moved.
  Six things to keep. **The unit is never enabled and never ordered after the
  hub**: an enabled update service updates on every boot, and a unit ordered
  after `gethome-hubd` is one systemd may take down with the hub *this very run
  is restarting*. **`TimeoutStartSec=infinity`**, because a `Type=oneshot`
  otherwise gets ninety seconds and the likeliest place that lands is after the
  symlink has moved to the new build and before the health check that would have
  rolled it back — killing the only thing that could undo it. **The runner always
  exits 0**, including on failure: a rolled-back update is not a failed unit, and
  enough failed starts park the service until somebody runs `reset-failed` on a
  machine the owner is not sitting at. **A rollback is its own outcome, and only
  the marker can say so** — `install.sh` ends in `fail()` whether it rolled back
  or not, and `current` points at the same build either way, so `@@ROLLBACK@@`
  was added to the marker vocabulary rather than matching its prose. **What is
  running afterwards is read back from `GET /hub`**, never from the log, the same
  rule the radio card follows. And **`<data>/update/enabled` is the capability**:
  `install.sh` touches it in the same breath as it writes the units, because
  `hub.env` is written *only when absent* and so would never reach an upgraded
  hub — the trap that makes a `GETHOME_UPDATE=1` variable there the wrong answer.
  `src/core/update.ts` is the hub's half, and asks GitHub for `main`'s head only
  when an app asks it to, cached six hours: a hub nobody looks at never calls
  out. `docs/api.md` is canonical, including why `available` is *absent* rather
  than false when the hub cannot tell.
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
  a rolling `bundle-<branch>` prerelease — assets, tag **and notes** all move —
  which is what makes `--branch` testable on hardware. The "and notes" is a
  repair, not decoration: `bundle.yml` used to create the release only when it
  was missing and then upload with `--clobber`, so the notes and the tag kept
  naming whatever commit the branch *first* built while the tarballs beside them
  moved on. Observed live: `bundle-main` said `47b48bf` in both while its assets
  were two days newer and `main` was at `a86c1dc`. No download was ever wrong —
  `install.sh` fetches `releases/download/<tag>/<asset>` and `bundle-cleanup.yml`
  matches tag *names*, so nothing resolves a bundle through the tag's commit —
  but the release page is where a human goes to ask which build is on their Pi,
  and it was answering with a commit that wasn't in it. A rolling release has to
  roll in the parts nobody downloads too. `v*` releases are re-pointed by
  nothing, deliberately: rewriting a version tag would move history somebody may
  already have installed. `bundle-cleanup.yml` removes each
  one when its branch is deleted (plus a weekly sweep as a backstop), because
  otherwise the tag list grows by one per branch forever. Its guardrails matter:
  only `bundle-` tags, only prereleases, never the default branch's, and an
  empty branch listing aborts rather than deleting everything. The sweep matches
  by building the set of tags the *existing* branches would produce, because
  flattening slashes into the tag name is lossy and cannot be inverted.
- **A migration has to be readable by the build before it, and that is now a
  test.** The hub migrates at boot (`src/index.ts`), which is *before* the health
  check that decides whether the new build is any good — so by the time
  `install.sh` rolls back, the database has already moved on and the symlink
  flips into an old build meeting a schema it did not write. While migrations
  only add, that is fine. The first one that drops or renames turns a failed
  health check from "recovered by itself" into "neither build starts, SSH to the
  Pi" — the exact evening the rollback exists to save. `test/migrations.test.ts`
  reads every SQL file and fails on `DROP TABLE`/`DROP COLUMN`/`RENAME`; the way
  past it is a `-- gethome:destructive: <why>` line, so taking something away is
  a decision somebody made rather than one drizzle made for them. `DROP INDEX` is
  deliberately allowed — an old build without an index is slower, not broken.
  This is the rule the `devices.favorite` column has always been kept for; it was
  written down and enforced by nothing.
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
  because it is the optional process and should die before the hub does. The
  same arithmetic is what makes a small board a one-radio board: 70 (OS) + 178
  (hub with Matter) + 150 (Z2M) does not fit in 512 MB, while either 70 + 178 or
  70 + 119 + 150 does — see the radio note above for who chooses between them.
  A small board also gets `--optimize-for-size --max-semi-space-size=1` in
  `ExecStart`, measured at 176 → 139 MB resident with Matter loaded for about
  half a second of startup. They have to be **argv**: `NODE_OPTIONS` refuses
  `--optimize-for-size` outright.
  **None of those cgroup limits were ever in force on a Raspberry Pi.** A Pi
  boots with `cgroup_disable=memory`, so the kernel has no memory controller to
  enforce them with: the units carried the right numbers, `systemctl show` read
  them straight back, and the unit's own cgroup had no `memory.*` file at all
  (`MemoryCurrent=[not set]`, observed on a Zero 2 W). **The parameter is not in
  `cmdline.txt`** — the firmware prepends it — so `enable_memory_cgroup()` works
  by *appending* `cgroup_enable=memory cgroup_memory=1`, which wins because the
  kernel takes the last setting; stripping a `cgroup_disable=memory` from the
  file is only for one somebody added by hand. Verified on hardware:
  `/proc/cmdline` still shows the disable, followed by our two, and
  `cgroup.controllers` lists `memory`. The gate is therefore
  `memory_cgroup_live` — whether the controller is *there* — never "did we edit
  the file". Three things keep the edit safe on the file that decides whether
  the board boots: the result must still carry `root=`, the original is kept
  beside it, and it is written as the **single line** the firmware reads — only
  the first is parsed, so a stray newline drops every parameter after it.
  It needs a reboot, which the installer deliberately does not perform; Studio's
  SD path writes the same parameters before first boot, so a card install never
  meets it. **`OOMScoreAdjust` (-500 hub / +500 Z2M) is the half that works
  without any of that**, and it is what actually delivers "Z2M dies first" —
  deliberately not -1000, which would exempt a leaking hub from the OOM killer
  and cost the whole machine instead of one restart. `GETHOME_CMDLINE` and
  `GETHOME_CGROUP_CONTROLLERS` exist so the test can run the real function
  against files it owns, the same way `GETHOME_ZIGBEE_SCAN_DIR` stages a
  coordinator.
  **The numbers above have been re-measured and are conservative.** On a
  Zero 2 W with the desktop off, the memory cgroup enforcing and one zram
  device, ten minutes after a restart with nothing paired: the hub is 56 MB
  with Matter off and **139 MB with both radios up** (peak 144 against a 200 MB
  `MemoryHigh`, `high 0`), Z2M is 64 MB, and `MemAvailable` is 89 MB. Both
  radios genuinely ran — `radio.matter: true` beside `zigbee.connected: true`.
  So 178 and 150 are both too high. Fifteen idle hours later it had not
  degraded either: no restarts, `high 0`, `memory.peak` unchanged, both radios
  still up. **But read how it fits** — the pair's demand stayed at 133 + 90 MB
  while 150 MB of it went into zram (38 MB compressed), so the board affords
  both radios by keeping two thirds of them cold, which holds only while they
  *are* cold. **The one-radio rule is unchanged**: a hub with no devices is not
  a working home, both sides grow per device, Matter's peak is at commissioning
  rather than at rest, and devices are exactly what keeps a working set hot.
  Changing it needs the same board with devices paired and days of real
  traffic — `docs/zigbee.md` carries the tables and the reasoning.
- **Don't add compressed swap a system already has.** Raspberry Pi OS Trixie
  ships its own (`systemd-zram-setup@zram0`, presented as `rpi-swap`, with
  writeback to the card), and `gethome-zram.service` added a second one beside
  it — two 415 MB devices and `SwapTotal` 830 MB on a board with 415 MB of RAM,
  where the compressed pages live in the very memory they are saving. The guard
  was the right idea asked the wrong way: our unit is deliberately early
  (`DefaultDependencies=no`, `Before=swap.target`) so the hub never starts
  before its headroom exists, and being early is precisely what made "is a zram
  swap running?" answer no. The question has to be **"is one configured on this
  machine"** — `zram_provided_by_the_system()` in `install.sh` and the same
  check inside the boot-time script, both before anything is created. An
  install that finds the duplicate disables our unit and says so; the spare
  device goes at the next reboot.
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
  **Two paths, one stick.** `ZIGBEE_ADAPTER` keeps the stable `by-id` name —
  which device this is — while `ZIGBEE2MQTT_CONFIG_SERIAL_PORT` gets the node it
  resolves to, because since 1.41 Z2M won't guess an adapter type and its
  discovery matches the configured port against `SerialPort.list()`, which
  reports real device nodes. A `by-id` path matches none of them and it exits
  with `No valid USB adapter found` beside a correctly identified coordinator.
  Setting `serial.adapter` instead would mean copying upstream's device table in
  here *and* would still miss the options lookup, so `rtscts` would silently go
  unapplied. The instability `by-id` avoids is covered because the detector owns
  Z2M's lifecycle and the change check compares both paths.
  **The single exception is `onboarding`, and it is surgical.** Zigbee2MQTT 2.x
  runs a browser wizard and leaves the radio alone until somebody finishes it,
  so a hub nobody configures by hand sits "active (running)" with a correctly
  identified stick, `zigbee.connected: false` forever, and a setup page on
  :8080 — observed on a Zero 2 W. The env override alone can't fix it: upstream
  ignores `ZIGBEE2MQTT_CONFIG_ONBOARDING` when there is no `configuration.yaml`
  yet ([#32224](https://github.com/Koenkk/zigbee2mqtt/issues/32224)), which is
  the fresh-install case. So `install.sh` sets the variable *and* creates the
  file when absent or replaces the one `onboarding:` line when present — never
  a rewrite, because the key and the device list must survive. It restarts Z2M
  itself when it changes that, since the detector only restarts on a changed
  *device path*.
  **Writing that override is load-bearing and used to fail silently.** The
  write was `{ … [[ -n "$PINNED" ]] && echo … } > tmp && mv tmp real`; a
  group's exit status is its last command's, so with nothing pinned — every
  install that doesn't pass `--zigbee` — the group returned 1, the `mv` never
  ran, and the only evidence was `chmod: cannot access …`. Z2M's
  `EnvironmentFile=-` is optional by design, so it started, found no serial
  port, and a hub whose coordinator was correctly identified sat at
  `zigbee.connected: false` forever. Two rules came out of it: a failed write
  says so and exits non-zero, and `GETHOME_ZIGBEE_SCAN_DIR` exists so a test
  can stage a coordinator the way one actually arrives — pinning was the only
  stage available, and pinning is the one path that worked.
- **A started service is not a working radio.** `install.sh` polls the hub's
  own `zigbee.connected` for a minute after starting Z2M and warns if it stays
  false, dropping Zigbee from `@@CAPABILITIES@@`. Without it the install ends
  claiming Zigbee works on a hub that pairs nothing — which is exactly what the
  override bug produced. The installer keeps the two facts apart:
  `ZIGBEE_CONFIGURED` (the board went to the coordinator) drives what it says
  about the *board*, `ZIGBEE_READY` (Z2M is actually talking) drives what it
  claims the hub can talk to.
- **A radio that is down says why, and the hub reads that itself.** The
  installer's warning only exists while the install is on screen; an owner who
  plugs a stick in a month later gets `connected: false` and a reason that lives
  in a log on a machine they aren't looking at. Zigbee2MQTT writes
  `<Z2M data>/log/<timestamp>/log.log` under the *same service account the hub
  runs as*, so `src/adapters/zigbee/diagnosis.ts` reads the newest run's tail —
  no root, no journal, no SSH — and `GET /hub` carries `zigbee.problem
  {kind, summary, detail}` for every app. Four rules: an unrecognised log yields
  **no** problem (a wrong diagnosis is worse than `connected: false`, which the
  caller already has); patterns go most-specific-first, because old firmware also
  logs the generic herdsman failure a line later; nothing may throw, since
  `GET /hub` is public and is the health check; and it is cached 30 s and only
  consulted while Zigbee is enabled-but-not-connected, so a healthy hub never
  touches the disk. **The hub does not flash firmware and shouldn't start** —
  a Python toolchain and a per-device image table on a 415 MB board, written to
  radios nobody here can test, where a bad write bricks the stick or resets NVM3
  and takes the paired network with it. Naming the cause precisely is the whole
  fix; `docs/zigbee.md` is canonical.
- **systemd's restart limits live in `[Unit]`, not `[Service]`.** They moved in
  v230; the old placement earns "Unknown key 'StartLimitIntervalSec' in section
  [Service], ignoring" on every unit load and a rate limit that silently is not
  in force. `test/deploy-config.test.ts` pins the section.
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
- **Mosquitto listens on the LAN, not loopback.** That is what the broker
  config always claimed — now the drop-in `install.sh` writes, which
  `test/deploy-config.test.ts` parses — and what the compose port mapping
  quietly contradicted, the reason port 1883 was invisible from the user's Mac.
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
