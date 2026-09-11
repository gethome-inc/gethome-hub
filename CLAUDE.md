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
convention), `ai-adaptation.md`, `automations.md`, `assistant.md`,
`portraits.md`, `ecosystem.md`.

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

**And keep it portable in the parts a test executes, which shellcheck will not
tell you.** These scripts only ever *run* on Linux, so a GNU-only idiom is
harmless there and quietly fatal here: `test/deploy-radio.test.ts` and
`test/deploy-wifi.test.ts` run the real functions on whatever the contributor
has, which on macOS is BSD userland and **bash 3.2**. Both halves have bitten.
`sed -i "s/…/…/"` is GNU-only in that form — BSD sed reads the substitution as
the backup suffix, so `apply_matter` failed, its `|| return 0` swallowed it,
and 14 tests asserted on a write that had never happened. And in the test
harness, `sed -n "/^$fn() {/,/^}/p"` written inline puts braces inside a second
level of double quotes within a command substitution, which bash 3.2
brace-expands anyway: sed gets two arguments, every extraction fails, and 10 of
15 tests went red locally while CI stayed green. The rule is the one the
`buildServer` note further down states for `test/`: **a test that cannot reach
the thing it asserts on is a test of nothing**, and green CI does not tell you
which of the two you have. Prefer a temporary file over `sed -i`, build a sed
program into a variable before using it, and run `npm test` on the machine you
are writing on.

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
  **Reachability is one fact in two rows, and the guard has to ask about
  both.** It is written to `devices.online` *and* into every endpoint's
  `state.reachable`, and the apps do not read the same one — Studio draws
  `online`, the iOS app draws `(online ?? true) && state.reachable` — so the
  two disagreeing shows up as one device reading offline on a phone and online
  on a Mac, about the same hub, at the same moment. They drifted for two
  reasons that compounded. The endpoint mutation was **in-memory only**: it
  never marked the state dirty, so `reachable` reached the card solely by
  riding along with the next state report that happened to flush, while the
  device row was written immediately. And the guard read `cached.online`
  alone, so once the pair had diverged on disk — they are loaded back from two
  tables with nothing reconciling them — the radio coming up found `online`
  already `true`, returned early, and left the endpoint stuck at `false`
  **for ever**, because nothing else writes that field. Found on a hub whose
  Zigbee2MQTT had `availability.enabled: false`, which is Z2M's default: with
  no per-device availability message in existence, the early return was the
  last word. So the guard now asks whether *either* place is behind, every
  endpoint it corrects is marked dirty, and a repair emits `deviceUpserted`
  but writes **no** activity row — the device's reachability did not change,
  one of the two records of it was simply late. A new endpoint inherits
  `device.online` rather than being born reachable, which is the same split
  pointed the other way.
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
  (`src/ai/descriptor.ts`) is zod-validated and interpreted. **Never execute
  model output.** The mapping is produced by an autonomous agent with
  `submit_mapping` as its only answer channel, authenticated with the home's
  own API key. The two provider loops, the agent/SDK boundary, the model
  lists and `effectiveModel`, the streaming turn and the page-fetch allowlist
  are in `src/ai/CLAUDE.md`, which loads when you work under `src/ai/`.
  `docs/ai-adaptation.md` is canonical.

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
- **Readings are recorded in buckets, and that is the same line the activity log
  holds.** `src/core/history.ts` is what lets an app draw the last few days of a
  temperature — and the tempting shape, a row per report, is exactly the mistake
  `STATE_FLUSH_MS` and `device.command` each exist to avoid: a power meter
  reports every few seconds, forever, onto an SD card. So readings accumulate in
  memory and **at most one five-minute bucket lands as one row** (`min`, `max`,
  `sum`, `n`) — ~288 batched transactions a day against the tens of thousands of
  whole-row rewrites one chatty meter already costs, and a week of an ordinary
  home is one to two megabytes. **A one-minute bucket was tried and reverted**,
  and the reason is the band: a bucket already carries the low and the high of
  everything inside it, so a finer one buys the *timing* of a spike and nothing
  else — a kettle that ran for ninety seconds still shows as a tall band either
  way. Five times the rows on every chatty meter is the wrong trade for that on
  an SD card. An hour is therefore thirteen bucket indices, which the apps draw
  as a curve by **marking the points when a series is sparse** rather than by
  recording more of them. Seven things to keep. **Nothing touches the disk on
  the report path** — `observe` is field reads and a `Math.min`, hung off the
  bus's `stateChanged` so `DeviceRegistry` is untouched. **A bucket merges
  rather than replaces**: the upsert takes `min(…)`/`max(…)` and adds `sum`/`n`,
  which is what makes a restart *inside* a bucket safe and a backwards clock
  jump harmless on a board with no RTC — and it is why the mean is computed on
  read, since a stored average cannot be merged. **`flush()` closes due buckets
  itself**, because a flush that left a finished bucket in memory was one wrong
  call away from readings that never reached the disk. **A gap is an absence**:
  no report, no sample, no point at that offset — and `gapBuckets` (the series'
  own median spacing ×4, floored at three points, capped at two hours) is what
  tells an app how long a hole has to be before it stops drawing through it,
  because a fixed threshold draws a half-hourly sensor as permanently broken or
  an afternoon of silence as perfectly steady. **`leading` is that same honesty
  pointed the other way**: a window's first reading lands wherever the sensor
  happened to speak, so an hour of a twenty-minute sensor opens a third of the
  way across with empty axis to its left — which reads as "nothing recorded"
  while the hub knows exactly what it was. One index seek returns the reading
  *before* `from`, bounded by that series' own `gapBuckets` and absent past it,
  so an app can draw the line entering the window rather than beginning in
  mid-air. It has to be the hub's answer rather than the app widening its own
  `from`, because a wider request changes the span and the span picks the
  emitted `bucketMs` — asking for a little context either side would silently
  coarsen the whole chart. **A thinned point's width is
  rounded up to something a clock recognises** (5, 10, 15, 20, 30, 60
  minutes…): plain division lands on "every 25 minutes", which is honest and
  reads as a glitch in the app that prints it under the chart and labels a time
  axis with it — and `points` is *at most*, so an hour touches **thirteen**
  bucket indices rather than twelve, and a caller wanting every stored bucket of
  one asks for more than twelve. **Two bounds again** — seven days
  and 500 recorded quantities — where the age bound is also the per-series row
  cap, so the only unbounded axis is how many quantities a home has; the prune
  runs **per series** (`series_id = ? AND bucket < ?` is a prefix of the key,
  a bare `bucket < ?` is a full scan) and hangs off a write, so a quiet hub
  never wakes for it. And **the table is `WITHOUT ROWID`**, which drizzle cannot
  express — the migration is hand-finished and `db:generate` must never be
  allowed to write it back to a plain table. Reading is the **floor**, not a
  permission: a temperature chart is the home being read. Booleans are
  deliberately out — transitions, not buckets; a step chart, not a line.
  `docs/api.md` is canonical.
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
- **A command that reached the protocol is not a command that reached the
  device, and `bridge/logging` is the only thing that knows.** Publishing to
  `<name>/set` resolves when the *broker* takes the message and Z2M has no
  per-command reply topic, so `POST /devices/:id/commands` answers 200 for a
  write a sleeping battery sensor will not see for an hour — and both apps
  papered over that by drawing the optimistic value and then silently
  reverting it. `parseWriteFailure`
  (`src/adapters/zigbee/write-failures.ts`) reads the one line that says
  otherwise, `AdapterBus.commandFailed` carries it, and `api/ws.ts` fans it out
  as a `commandFailed` frame to **every** socket — like `structure`, because
  the value being written is the house's and the phone in the next room has the
  same wrong value on screen. Four rules. **`Request superseded` is not a
  failure**: it is a *newer* write to the same property taking this one's place
  in the queue, so somebody tapping − four times generates four of them for one
  correct outcome; dropped in the adapter and again in `DeviceRegistry`, which
  is the seam a second adapter arrives at. **Classification is
  most-specific-first** — the `diagnosis.ts` rule, and here it is load-bearing
  rather than tidy, because a supersede error carries the whole ZCL command
  including `"timeout":10000` and a generic "timed out" match placed first
  swallows the one outcome that must not be reported. **An unrecognised line
  yields nothing**, which is nearly every line. And **nothing is written to the
  activity log**: a write that failed at 17:11 is on screen now rather than
  history, and `device.command` already recorded the ask. `kind` is an open
  string on purpose — adapters classify in their own vocabulary and a client
  that meets a new word falls back to `detail`. The hub does not retry, wake
  the device, or hold the value to replay: waking an Aqara sensor is a person
  pressing its button, and a retry loop against a sleeping device is the queue
  we already have wrapped in a second one. `docs/zigbee.md` and `docs/api.md`
  are canonical.
- **Two bridge topics are relayed for device lifecycle; the rest are still
  dropped** (`bridge/logging` is the third relay, above, and reads only failed
  writes). `bridge/devices` lists a device only once its interview *finishes*, so
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
- **An accessory that has never been on a network cannot be found on one, and
  where to look is the accessory's answer rather than a setting.** A
  factory-new — or factory-reset — Wi-Fi Matter accessory advertises over
  Bluetooth LE and nowhere else. `MatterAdapter` used to hardcode
  `discoveryCapabilities: { onIpNetwork: true }` for every setup code, so it
  searched the LAN for a device that was never going to be there; matter.js
  applies **no discovery timeout at all** when one is not passed (`Discovery`
  guards its `withTimeout` on `!== undefined`), so the job never settled and
  the app read "Pairing with your hub" until somebody force-quit it — thirty-five
  minutes, on the hub this was found on. `adapters/matter/setup-code.ts` reads
  the QR's own `discoveryCapabilities` instead, and a **manual code carries
  none**: `undefined` there means "the code did not say" and is answered by
  looking everywhere, never by guessing one place. BLE arrives through an
  **optional** dependency installed into the environment *before* the
  controller is built (afterwards it is a transport nothing is holding), with
  every failure resolving to a named reason rather than throwing — see
  `deploy/CLAUDE.md` for the rfkill and capability halves, and `docs/matter.md`,
  which is canonical.
  **Three refusals happen before anything is searched for**, because in each the
  answer cannot change while somebody waits: a code the hub cannot read, an
  accessory whose code says Bluetooth on a hub without it, and one with no
  network that the hub has no Wi-Fi password to give. Everything else is bounded
  (three minutes' discovery, four and a half for the job), cancellable — which
  stops the *discovery*, not just the screen, and is why the hub pairs **one
  accessory at a time** — and classified into words somebody can act on
  (`commission-failures.ts`, `write-failures.ts`'s shape and both its rules:
  open `kind`, most-specific-first). **A failed pairing is logged**, which it
  was not: the only record of one was a WebSocket frame that had already gone,
  so the journal of a hub whose owner could pair nothing showed a line saying
  discovery had started and nothing else, ever. And **the step is a real signal,
  never a timer**: a candidate reaching the controller's peer set is the moment
  the advice changes from "hold its button" to "leave it alone", and a
  five-second timeout would say the same thing about a hub that had found
  nothing.
  **Two things it deliberately cannot do yet are written down** under
  *Not built yet* in `docs/matter.md`: giving an accessory away to another
  ecosystem (the hub takes devices in and cannot share them, which is the fear
  somebody has *before* they pair anything), and pairing from the phone when
  the hub is out of Bluetooth range. Both carry the detail and the open
  questions; neither is started.
  **A device is not offline because the hub has only just started looking for
  it.** Zigbee2MQTT hands its whole list over in one retained message; a Matter
  controller opens a CASE session per node, which is twenty to thirty seconds
  on a Zero 2 W — and those devices are read back from the database with the
  `online: false` they were given when Matter was last switched *off*. So every
  switch to Matter reported "1 offline · needs attention" for half a minute
  about an accessory that was about to answer. `matter.settlingUntil` is the
  hub saying it has not finished looking, and an app draws those devices as
  *connecting*. It **clears when the last node connects, not when the clock
  runs out** — the controller knows what it owns and what it has reached, so
  there is nothing to guess — and the clock is a bound rather than a promise,
  because the node that never answers is the one genuinely offline device and
  must not hide behind "still looking" for ever.
  **It covers the controller coming up as well**, which is the same bug one
  step earlier and the half this first shipped without. The adapters start
  after the API is listening, so every `GET /hub` in the seconds matter.js
  spends loading and opening its storage was answered by an adapter that had
  not begun looking — reporting a settled home, while `radio.matter` already
  said `true` because the adapter had been *constructed*. That is the window
  every switch to Matter lands in, so the fix for the paragraph above did not
  reach the case it was written for. The two phases are bounded separately: a
  clock running while matter.js loads counts time in which no node could have
  reported in, so charging it to the nodes shortens the window they actually
  get on precisely the boards slow enough to need all of it. The arithmetic is
  `adapters/matter/settling.ts` rather than a getter in the adapter, for the
  reason `reducer.ts` and `setup-code.ts` are their own files: reading it
  through `adapter.ts` loads `@matter/main`, so a rule both apps draw every
  Matter device from would be a rule no test could reach.
  **And the hub can be asked what it can hear** (`GET /matter/discoverable`),
  because Bluetooth range is the one part of pairing nobody can see and
  `not-found` is the same word for "two rooms away" and "never went into
  pairing mode". It is refused while a pairing runs, and that is a measurement:
  a second scanner beside the hub's own took fifteen seconds of neighbourhood
  advertisements from 231 down to 2 on a Zero 2 W, and a starved scan reports
  an *empty list* — the wrong answer in the one direction somebody acts on.
- **A radio that is off and a radio that is missing need opposite words, and
  both were `connected: false`.** Switching a one-radio board to Matter made the
  app say *"Zigbee · no stick"* about a coordinator the owner could see from
  where they were standing — hardware the hub had detected and deliberately
  stood down. `zigbee.coordinator` (`present`/`absent`/`unknown`) is the fix,
  read from the detector's own `/etc/gethome/zigbee.env` rather than by scanning
  USB: `gethome-zigbee-detect` owns that decision with a device table and a
  `maybe` tier, and a second dumber copy in the hub would eventually disagree
  with the first. It reads the **by-id name**, never the `/dev/ttyACM0` beside
  it, or a 3D printer taking that number reports a coordinator present.
  **A mode names the whole arrangement, so `applying` asserts what must be
  *off* as well as what must be on.** Asking only whether the wanted radio was
  up was right for every switch that turns one on and wrong for every switch
  that turns one off: leaving `both` for `zigbee` left Zigbee already
  connected, so the hub reported the switch as landed the instant it was
  recorded — no progress bar, no planned downtime — and then went off the
  network for seventy seconds with nothing on any screen to say why.
  `both` → `matter` had the same defect and nobody had noticed.
  **And `radio.applying` is on disk rather than in memory**, because applying a
  radio *restarts the process that recorded it*: the only useful answer is one
  that survives the restart it describes, and without it every app drew "can't
  reach your hub" over a change somebody had just made on purpose. It is a
  **bound, not a wait for the radios to agree** — asking for Zigbee on a hub
  with no coordinator is reasonable, correctly changes nothing, and would spin
  for ever.
- **The radio budget is a measurement of a *full* home, so it is advice and not
  a ceiling — and what replaces the refusal is a watch.** `GETHOME_RADIO=one`
  is measured against the OS plus the hub with Matter plus a Zigbee2MQTT
  holding a hundred devices' state; a home with four devices is nowhere near
  it, and refusing `mode: both` there took Matter away from somebody to prevent
  a problem they did not have. So `both` is a fourth `RadioMode`, accepted on
  any board, and `core/radio-pressure.ts` is the half that makes that safe:
  while the mode is `both` **and both radios are genuinely up**, it samples the
  cgroup's `memory.events` (`high`, `oom_kill`) and `MemAvailable` every 30 s
  and writes `auto` back if the board is in trouble across six of ten checks.
  Five rules. **It watches throttling, not deaths** — `memory.high` holds a
  cgroup at its limit for a long time before anything is killed, so acting on
  it means nothing is lost; `oom_kill` is a backstop and acts at once, because
  by then something has gone. **The peak is the *start*** — a cold boot reached
  170 MB of a 200 MB ceiling loading `@matter/main` while a six-second BLE scan
  moved `memory.peak` by zero — so nothing is sampled for the first two
  minutes, or every boot would stand a radio down. **A counter read once votes
  on nothing**, since these are totals since boot, and **a kernel that cannot
  answer abstains**: every field is optional, so a board with the memory
  controller off and a developer's Mac both trip nothing. And **it says so
  before it does it** — the stand-down record, the `hub.radio-stood-down`
  activity row (the one entry with *no* member on it: nobody did this) and the
  `hubStatus` frame all go out before the mode is written, because the mode
  write is what wakes the path unit that kills this process. `auto` is what
  gets written rather than a named radio, because "follow the hardware" is a
  rule this hub already has and a second one for this case would be the policy
  nobody had read. `radio.standDown` carries it to the apps, where
  `acknowledged` ends the *notice* (any `PUT /settings/radio` answers it) and
  `count` outlives every acknowledgement — one stand-down is a board having a
  bad minute, a fourth is the board answering the question.
- **A radio is suspended, not taken away — and the hub cannot tell whether both
  would fit again, so a retry is a *trial*.** Writing `auto` is the only way a
  hub can change its own radios, so on its own it meant that protecting the
  board threw away the decision being protected; `wish` in the record is the
  hub knowing it owes somebody a second radio, and `standDown.suspended` is how
  an app draws a parked choice rather than an untouched switch. The reason
  there is no measurement is worth stating plainly: after a stand-down the
  board is no longer running the configuration that failed, so the pressure is
  gone **because** the second radio is gone, and any signal derived from that
  would say yes for ever. So `shouldRestoreBoth` asks about the *machine* — has
  it rebooted (`/proc/sys/kernel/random/boot_id`, which a service restart does
  **not** change, and the hub restarts itself several times during one
  stand-down), or has a week passed — with a budget of two, because each try
  costs a restart. A person choosing `both` hands the tries back, and so does a
  stand-down a week after the last one: neither is flapping. And **the watch
  runs on every board while two radios are live, but only a small one is acted
  on**: two live radios is the condition rather than `mode === 'both'` (a
  hand-edited `GETHOME_RADIO` reaches it on `auto`, and so does the gap between
  a stand-down writing the mode and the detector applying it), the report
  threshold is lower than the action threshold so a small board gets one
  warning first, and on a board measured for both the hub only ever reports —
  taking a radio off a Pi 5 would be making a working home smaller to fix
  something that is somewhere else. `radio.pressure` carries that, live, so it
  clears itself. **Only the retry waits for a quiet moment** (a Matter
  commissioning in flight, or an open Zigbee join window) — a hub that
  restarted itself mid-pairing would take the pairing with it, for a trial that
  had no reason to happen in that minute; the stand-down never waits, because
  it is the board being rescued and deferring it risks the kill it exists to
  prevent. The one thing this cannot see is **the hub being killed outright** —
  `memory.events` is in the service's own cgroup and systemd recreates it on
  every restart — which is bounded by `MemoryHigh` throttling long before
  anything is killed rather than by luck; `docs/zigbee.md` records the two
  alternatives that were considered and left out.
- **The AI subsystem's own conventions live in `src/ai/CLAUDE.md`**, which
  loads when you work under `src/ai/`: the mapping library and its five
  routes, the retry path and the backoff gate, `ai_run_exchanges`, the five
  faults behind "a device is routable before the agent is asked", the
  automation agent, the assistant and `ChatRuntime`. Three of its rules bind
  code outside that directory, so they stay here. **An AI overlay may add to
  what the static mapper found and may never subtract from it** — anything new
  that merges a descriptor into a static mapping has to say what happens to
  the fields that cannot be unioned. The merge that combines the two *reports*
  is `mergeStatePatch`, beside `mergeState` in `schema/state.ts`; there must
  only ever be one recursive merge, because `custom.values` is two levels deep
  and a private one-level copy silently dropped it. And
  `ZigbeeAdapter.adoptDevice` registers a device in `byIeee`/`byFriendlyName`
  **before** awaiting the mapper, or every report during a run is looked up,
  missed and dropped.
- **Automations are data the hub interprets, and the guards are not
  negotiable.** `src/automations/` is the rules a home runs by itself, and a
  **scene is an automation with a `manual` trigger** — one object, one store,
  one vocabulary. The document schema and its defaulted `version`, the
  selector-based targets, the crossing rule for `deviceState` triggers, the
  five command guards, the injected clock, the derived scope/outline surfaces
  and the generated catalog are in `src/automations/CLAUDE.md`, which loads
  when you work under `src/automations/`. Two rules reach further and stay
  here: a new rule is created **switched off** whatever the caller asks, and
  `enabled` (does the rule exist and listen) needs `automation.manage` while
  `active` (is a mode on right now) is **the floor**. `docs/automations.md` is
  canonical.
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
- Secrets: tokens are stored sha256-only; each AI credential (an Anthropic key,
  an OpenAI key, one slot per provider) AES-256-GCM-encrypted with the hub
  secret (`<data>/hub-secret.json`, 0600); the API never returns key material.
  Keep it that way — it is also the reason portraits are drawn *here* rather
  than by handing a phone the key.
- **A device's portrait is the house's, so the hub draws it and keeps it**
  (`src/portraits/`, `docs/portraits.md` is canonical). The app used to do this
  with a key in its own Keychain and the images in its own storage, which made a
  picture one phone's: a second person opened the same kettle and saw a grey
  sphere. Four rules. **The bytes are files, the record is a row** —
  `<data>/portraits/<device>/<id>.png` beside a `device_portraits` row, because
  a 1024² PNG through the WAL is the write amplification the rest of the store
  is arranged to avoid. **This is not the `STATE_FLUSH_MS` case**: every other
  bound here is about write *frequency*, and a portrait is one deliberate write
  per press — so it gets a bound on *bulk* instead (6 per device, 300 MB per
  hub, oldest-unselected first) plus the one thing only a large file needs, a
  refusal to draw below 500 MB free. **A selected portrait is never evicted**,
  and `selected: null` while portraits exist is a *state* — the procedural
  sphere, chosen — rather than an absence, which is what saves a column meaning
  the same thing twice. And **no thumbnails are made here**: that would mean a
  native image library on a 415 MB board for something each app already derives
  and caches. `gpt-image-2.5-flare` is pinned because it supports transparent
  backgrounds, which is the whole point of a cut-out the apps float over their
  own glow — and because it is the *fast* half of the 2.5 pair, on a surface
  where somebody watches an orb until the picture lands. Moving off `gpt-image-2`
  cost nothing at the wire: 2.5 kept the Image API's shape, so it was a model id
  and a re-read of the three facts hanging off it. `quality` stays `high` rather
  than reaching for the `xhigh`/`max` that 2.5 added — transparency is at its
  best at medium or high, and spending the saved time on detail nobody sees at
  card size would undo the reason for moving. **The prompt stopped naming a
  scene** with it (`src/portraits/prompts.ts`): a prompt's instructions take
  priority over `background: transparent`, so "empty space", "no ground plane"
  and "no scenery" were a backdrop described in front of the one capability the
  path exists for. The shadow ban stays — a shadow is something the object casts,
  not a place it is standing in.
  **And the finish and the light were rewritten for a model that obeys**, which is the
  shape to expect from every prompt here written against a looser one: the palette said
  `matte soft-touch`, `gpt-image-2` gave it a sheen anyway, and 2.5 rendered the sentence
  exactly — a dry, chalky body with no highlight and the cobalt down to a few pixels. Not
  a worse render, a *more faithful one to a prompt that asked for the wrong thing*. Matte
  is the highlight's **roll-off** rather than its absence; the cobalt is named as the
  device's **own indicator** rather than a light in the scene, since a lamp with a blue
  studio light on it is a photograph of a different object; and the light now has a
  **direction**, because "soft top light and gentle rim light" names two lights and no
  direction and resolves as flat frontal fill. The three-quarter **angle is on the
  generate path only** — with no photo the model invents the object anyway, while turning
  one on the edit path means inventing the sides the camera never saw.
  **What a drawing cost goes in `ai_runs`; who asked goes on the picture.** A
  portrait is the third thing that spends the home's money on AI, so every draw
  writes one row (`kind: 'portrait'`), failures included with the provider's own
  `errorKind` — that table's argument is that what a home spent is *one*
  question, and three tables would be three screens answering it; `portraitId`
  links the row to what it bought the way `automationId` does for a rule, and
  `finish` times the run so the duration is free. The price is read off the
  response's own `usage`, because 2.5 bills per token and estimating from the
  size we asked for is a guess dressed as a fact — with **no usage meaning no
  price rather than a free one** (`$0.00` is a claim where nothing is the truth)
  and an unsplit input priced at the dearer image rate, since an estimate that
  reads low is the one that surprises somebody. **`drawnBy` is on the portrait
  row** and is not a second copy of the activity log's `device.portrait` line:
  that log is bounded at 5 000 rows and 30 days while a portrait has no age
  bound, and `ai_runs` keeps 250 runs of every kind with a chat writing one per
  turn — so both records of who drew a picture expire while the picture does
  not. The member's *name* rides beside the id for the log's own reason: an
  `ALTER TABLE` column gets no `ON DELETE` action in SQLite, so the id may point
  at somebody long removed.
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
- **A person is a member row and a device is a token row, so coming back is a
  code that names somebody.** Every arrival used to insert a member, which is
  right for the first one and wrong for every one after it: a second phone, or
  the same phone after the app was deleted and installed again, walked in as a
  stranger with the same name and left the AI conversations
  (`automation_chat_messages.member_id`), the lines attributed to that person in
  the activity log and their own favorites behind on a member nobody could ever
  sign in as again. `invites.member_id` is the whole fix — null is the invite
  that has always existed, a value is a **sign-in code** and `claim` issues
  another token instead of inserting a row. `docs/api.md` is canonical. Six
  rules. **It is deliberately the same code**: one route, one table, fifteen
  minutes, single use, one per-address rate limit, one `claimId` replay window
  and one `/pair`, because a second kind of code is a second set of ways to be
  wrong; `memberId` is the only thing that tells them apart, on `POST` and in
  `GET /invites` alike, and there is no derived `kind` beside it. **An app must
  ask `GET /hub` for `pairing.signInCodes` before offering one**, and that is
  not the usual "no button that can only fail": a hub older than this parses the
  body with a schema that has never heard of `memberId`, zod *strips* what it
  does not know, and the request **succeeds** with an ordinary invite — which
  adds the duplicate person the whole thing exists to prevent, with nothing on
  the way back to say so. **The name on
  the claim is ignored** — the code says who this is, and a field somebody fills
  in on a reconnect screen must not rename them for the whole house; an app
  shows the name that comes back. **The token they already had keeps working**,
  because this is "another device" rather than "moved to a new phone"; ending
  access is still `DELETE /members/:id`, which takes every token with the row.
  **Who may ask is asked of the body**, which is why the route is `authed` with
  the check inside — `PATCH /devices/:id`'s shape, and for its reason. Your own
  is the **floor** (`memberId: "me"` is accepted, for the client that never
  learnt its id): it grants exactly the authority the caller already holds a
  token for, and anybody who could ask could copy that token to the other device
  instead. Somebody else's is `member.invite` — that permission's own sentence
  with the person already named, adding their *history* rather than authority,
  since whoever can invite could already mint a peer at any non-owner role. An
  **owner's** needs an owner, because there the identity *is* the authority and
  without the guard `member.invite` would quietly mean "become the owner". **The
  one for somebody else is logged** (`member.signin-code`) and your own is not:
  handing over an identity for fifteen minutes is what makes the permission safe
  to delegate, while a line every time somebody adds their tablet is noise in a
  feed read a week later. Claiming writes `member.signed-in`, not
  `member.joined` — picking up a tablet is not a person arriving — with the
  device named in the **sentence** and deliberately not in `data.deviceName`,
  which means a device *in the home* everywhere else in this log. And **removing
  a member takes their outstanding codes with them**, in both delete routes and
  before the row goes: `invites.member_id` is an `ALTER TABLE` column so SQLite
  gives it no `ON DELETE` action (the `invites.role_id` situation exactly), the
  raw foreign key would turn an ordinary removal into a 500, and a code left to
  expire is fifteen minutes in which somebody just removed could let themselves
  back in.
- **Access is a table the home edits, and three rules hold it up.** Roles are
  rows (`roles`), permissions are a named vocabulary owned by
  `src/core/access.ts`, and a member holds one role; `requirePermission` in
  `api/auth.ts` is the only guard left — `requireOwner` is gone rather than kept
  beside it, because two mechanisms are two places for a route to be wrong.
  `docs/api.md` is canonical.
  **First, the floor is not a permission.** Reading the home, **working a
  device**, renaming yourself, leaving, pinning your own favorites and putting
  yourself on another of your own devices are what
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
  put the kettle on their own dashboard. `POST /invites` is the second, for the
  same reason — see the bullet below.
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
  the first one to be wrong, and it was: a hub renamed to "Summer House" in
  the app still advertised itself as "GetHome Hub" over mDNS and still read
  "GetHome Hub" in GetHome Studio, where two hubs were two rows with the same
  name.
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

The full contract — the installer's marker vocabulary, the radio budget,
Zigbee detection, memory limits and cgroups, mosquitto's two accounts, Wi-Fi
power save and reachability, mDNS, bundles, versioning and rollback — is in
`deploy/CLAUDE.md`, which loads when you work under `deploy/`. Read it before
touching anything there. Four of its rules have a `src/` half and bind code
outside `deploy/`, so they stay here:

- **`install.sh`'s `@@…@@` markers are a wire protocol.** GetHome Studio
  drives its whole install UI off them, and the step ids are mirrored in
  Studio's `FirstBootMonitor.installSteps` and `PiInstallView.steps()` and in
  the iOS app's `HubUpdateStep`. Adding a marker is safe — unknown ones are
  ignored — but renaming or removing one, or changing a step id, breaks both
  apps silently. Change all three repos together.
- **The hub records the radio choice; it never applies it.** Applying is root
  work, so `src/core/radio.ts` writes one word into the hub's own data
  directory and a path unit picks it up. The consequence for callers is that
  `PUT /settings/radio` returns `applying: true` and a *stale* `matter` — what
  is live comes from `ADAPTER_MATTER` and the adapters, never from the file.
- **The hub records an update request the same way.** `POST /system/update`
  (`src/core/update.ts`) writes one line into `<data>/update/` and a root
  oneshot runs it; `<data>/update/enabled` is the capability. What is running
  afterwards is read back from `GET /hub`, never from the log, and a rollback
  is its own outcome that only the `@@ROLLBACK@@` marker can report.
- **A migration has to be readable by the build before it.** The hub migrates
  at boot (`src/index.ts`), which is *before* the health check that decides
  whether the new build is any good — so by the time `install.sh` rolls back,
  the database has already moved on. A migration that drops or renames turns a
  failed health check into a hub neither build can start.
  `test/migrations.test.ts` enforces that, and the journal's four invariants
  with it; `-- gethome:destructive: <why>` is the deliberate way past.

## Keep the docs in sync

After landing a change, update the docs it invalidates in the same change:
schema/units/wire → `docs/device-schema.md` (+ the iOS repo needs a matching
change — flag it); routes/auth → `docs/api.md`; adapter behavior/topics →
`docs/zigbee.md` / `docs/matter.md` / `docs/mqtt-integrations.md`; AI
trigger/DSL → `docs/ai-adaptation.md`; the assistant, the chat runtime or the
delegate registry → `docs/assistant.md`; portraits → `docs/portraits.md`;
module boundaries → this file and the subsystem file for the directory you
changed (`src/ai/CLAUDE.md`, `src/automations/CLAUDE.md`, `deploy/CLAUDE.md`) +
`docs/architecture.md`; installer markers, autostart or Zigbee detection →
`docs/zigbee.md` + the marker list in `deploy/install.sh` (and flag the Studio
repo); anything README restates → `README.md`.
