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
convention), `ai-adaptation.md`, `automations.md`, `portraits.md`,
`ecosystem.md`.

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
  (`src/ai/descriptor.ts`) is zod-validated and interpreted. Never execute
  model output. The mapping is produced by an autonomous agent with
  `submit_mapping` as its only answer channel and backoff on account failures
  (`docs/ai-adaptation.md` is canonical), authenticated with the home's own API
  key.
  **There are two agents and one run.** `src/ai/agent-core.ts` holds everything
  that is not a vendor's API — the guardrails, the `AgentStep` vocabulary, the
  `submit_mapping` schema, `evaluateSubmission`, the `MappingProvider` seam —
  and **imports no SDK**, which is the load-bearing half: a home configured with
  only an OpenAI key must never load the Anthropic SDK to satisfy an import
  chain, so `resolveProvider()` imports whichever half it needs. `agent.ts` is
  the Anthropic loop (Messages API, server-side `web_search`/`web_fetch`);
  `openai-agent.ts` is the same run on the Responses API over plain `fetch` —
  no second SDK for a Pi to download — with hosted search and a `fetch_page`
  the **hub itself** performs, because OpenAI has no hosted equivalent and
  reading the device's own zigbee2mqtt.io page rather than a search snippet is
  the difference between settling a unit and guessing one, on a mapping cached
  against a device model for ever.
  **That is the one place this repository opens a connection to a site that is
  not a provider's API, and an allowlist is the whole of why it is
  acceptable.** `src/ai/page-fetch.ts` reads `zigbee2mqtt.io` and
  `raw.githubusercontent.com` and nothing else: the URL comes from model output
  and the machine dialling is inside somebody's home network with an
  unauthenticated health route of its own, so a general fetch tool here is a
  request-forgery primitive aimed at the LAN dressed up as research. Five
  guards — https only; the host matched exactly or as a subdomain *with the
  dot*, since `endsWith` would accept `evil-zigbee2mqtt.io`; redirects
  followed by hand and re-checked every hop, because `fetch` follows them
  itself and an allowed host answering `302 http://10.0.0.1/` would walk
  straight past the list; the resolved address required to be public, because
  an allowlist on a *name* is only as good as the resolver behind it; and
  bounded bytes with one deadline. `test/ai-page-fetch.test.ts` asserts that a
  refused URL produces **no request at all**, which is what proves the guard
  runs before the fetch rather than after it. `docs/ai-adaptation.md`'s Privacy
  section is canonical and says what the promise narrowed to.
  Three rules for the pair. **The system prompt is built per provider**
  (`mappingSystemPrompt`), because its research paragraph names tools and the
  two loops do not carry the same ones: one shared prompt told an OpenAI run
  to `web_fetch` the device's zigbee2mqtt.io page first, called that page the
  source of truth, and then told it not to spend searches confirming what it
  had already read — three instructions about a tool it has not got, at the
  one point in the run where research is decided. Everything else in it is
  shared, so a rule added for one vendor cannot go missing for the other, and
  `test/ai-boundary.test.ts` asserts the wall for both.
  **Effort is `high` on both and is not exposed**: two
  settings for one decision is one too many. And **the hub owns the model
  list** — the apps render `providers.<name>.models` rather than shipping ids of
  their own, the `GET /permissions` rule applied to a vocabulary that moves.
  **That list is one model per provider now, so the apps *state* it rather than
  ask.** It was two, the thorough tier and the cheaper one, until the cheaper
  one was tried: Sonnet 5 kept submitting descriptors `submit_mapping` had to
  bounce, and the run that finished named `custom` as an outlet's primary — the
  one value that renders as no control at all, so a paid run produced a dead
  tile on a working plug. The trade is lopsided because a descriptor is cached
  per device *model* and shapes every unit of it the home ever meets until
  somebody remaps; a few cents on a job that runs a handful of times in a hub's
  life does not buy that risk. OpenAI's cheaper tier went on the same reasoning
  rather than its own evidence. The half that is easy to miss is
  **`effectiveModel`: a stored model counts only while it is still offered**,
  or retiring one leaves the homes that had chosen it as the only homes still
  running it — silently, since nothing on a screen would change. `GET
  /settings/ai` answers what will *run*, never the column, so a hub set to
  Sonnet moves to Opus by itself; a write naming a retired id is still accepted
  rather than 400-ing an older app, it simply is not what runs, and `PRICING`
  stays broad so a months-old `ai_runs.modelId` still prices correctly.
  **`resolveProvider()` has to use it too, and that is the half that was
  missed.** Every surface that *reports* which model answered went through
  `effectiveModel` — the settings route, `ai_runs.modelId`,
  `status.lastRun.model`, the backoff gate's credential id — while the one
  call that picks the model to actually run read the column, so a hub set to
  Sonnet went on running Sonnet with every screen and every recorded row
  saying Opus. It passed unnoticed because `isSupportedModel` is deliberately
  the broad `PRICING` allowlist and let it straight through, and because the
  homes it was wrong for are exactly the ones nobody was looking at.
  `test/ai-model-choice.test.ts` pins it.
  **It used to run on the Claude Agent SDK, and moving off it was a memory
  decision like dropping Docker.** That SDK ships a 276 MB native binary — 74%
  of the hub's whole download — and spawned a ~315 MB subprocess per run, of
  which ~224 MB is mapped binary pages. On a Zero 2 W that thrashes against
  the SD card instead of OOM-ing and outlives the 10-minute watchdog, so AI
  adaptation was installed-but-unusable on the smallest supported board. The
  bundle went 117 MB → 29 MB. The cost is that Claude subscription tokens no
  longer authenticate; only API keys do, and `src/ai/models.ts` is an
  allowlist because the `_20260209` research tools need Opus 4.6+/Sonnet 4.6+.
  **The Anthropic turn is streamed, and a mock that is laxer than the SDK is
  how that went unnoticed.** `messages.create` refuses a non-streaming request
  whose `max_tokens` could run past the API's ten-minute ceiling — the line is
  21,333 and `MAX_OUTPUT_TOKENS` is 32,000 — so every run threw before it
  reached the network, and because that refusal carries no HTTP status
  `classifyApiError` read it as a transport failure: a run that could never
  work armed the backoff gate and retried for ever, with the real cause behind
  a retry timer. `messages.stream(…)` + `finalMessage()` returns the same
  `Message`, so the loop is otherwise untouched. It survived 489 green tests
  because `test/ai-agent.test.ts` stubbed `create` with a bare `vi.fn()`, which
  accepts what the real client refuses — a mock more permissive than the thing
  it stands in for tests the mock. It reproduces the guard now. **And there are
  two cache breakpoints**: the explicit one on the system prompt (which covers
  the tools with it — they sort ahead of system in the prefix), plus the
  top-level `cache_control` field for the growing conversation tail, which
  carries the whole of the model's research over up to 40 turns and was being
  re-sent at full price every one of them.

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
  **Forgetting an entry is not applying one, and using the same call for both
  bought a replacement for the mapping you were deleting.** `applyStoredMapping`
  re-adopts with `consultMapping: true`, which is right after an upload or a
  repair — there is something in the library to consult, the cache hits, no run
  happens. `remove()` called it too, against a hash it had *just deleted*: the
  lookup missed and the mapper started a fresh paid run, awaited, minutes long,
  inside a request Studio abandons after ten seconds — surfacing as "Studio
  couldn't remove that schema. The request timed out." The timeout was the
  smaller half; pressing **Forget** spending money on a new mapping is the
  opposite of what the button says. `forgetStoredMapping` asks for nothing, and
  needs **two** suppressions rather than one, because either alone is a no-op:
  `adoptDevice` deliberately carries a previous mapping over (so a regeneration
  never leaves a device less usable mid-run), and `needsHelp` is true for any
  device with an uncovered property — which is most devices an AI mapping was
  ever made for. The device falls back to its static mapping, which is what the
  three layers are for, and the next *genuine* trigger asks.
- **Trying again is the whole recovery path, and three things used to break
  it.** Recognition fails for reasons a person can fix — a key that is wrong, a
  key that names no workspace, a model too weak to submit a valid descriptor —
  and every one of those fixes ends the same way: come back and press *Work it
  out again*. **First, `POST /devices/:id/remap` answers as soon as the run is
  under way**, never when it ends. It used to await the whole run, against a
  ten-minute watchdog and a Studio client whose HTTP timeout is ten seconds, so
  the button reported a failure on every retry that actually did any work and
  appeared to succeed only on runs that failed instantly. `ZigbeeAdapter.remap`
  is fire-and-forget now, the shape `scheduleParameterRemap` beside it always
  had; `false` still means the radio has no published schema for that device
  *now*, which is the only answer available without waiting. **Second, the
  backoff gate names the credential it was armed against** and retires itself
  when the provider, the model or the key moves — otherwise the judgement "this
  account is unavailable" outlived the account, and a hub-wide gate armed by one
  provider silenced the other, which is exactly the switch an app tells somebody
  to reach for. Keying it on `provider:model:sha256(secret)` means no channel
  from the settings routes to keep in step. **Third, an explicit run ignores the
  gate entirely**, the stance `MappingLibrary.repair` already took by building
  its own mapper — and the flag travels to the check rather than being settled
  where the button is pressed, because runs are serialized hub-wide and a run
  already queued can arm the gate in between. `test/ai-retry.test.ts` pins all
  of it.
  **And a failed run is recorded in words, not in a response body.** This is
  `diagnosis.ts`'s rule one module over: an SDK error's `message` is the status
  with the whole JSON body glued to it, so a device row in Studio read
  `400 {"type":"error","error":{…}}` with the one useful sentence in the middle
  of it. `describeRunFailure` digs that sentence out and, for a refusal that is
  really a *setting*, adds the fix and records `config` — today the one entry is
  an identity-linked Anthropic key, which must name a workspace on every request
  and which the hub deliberately does not choose for anybody. Same three rules
  as the Zigbee diagnosis: most-specific-first, an unrecognised failure is still
  reported with nothing guessed about it, and nothing throws — it runs inside
  the catch of a run that has already failed.
- **What a run *said* can be kept, and the switch is the whole reason that is
  affordable.** `ai_runs` is a summary by design — model prose on an SD card is
  the write amplification the rest of the store is arranged to avoid — and
  `ai_run_exchanges` is the one deliberate exception, because a refusal is
  often about the *request*: a model that will not take a parameter, a key that
  names no workspace, and the run log's one sentence cannot answer "what did we
  actually send?". **A run is a loop, not a request** — up to `AGENT_MAX_TURNS`
  (40) rounds against the provider — so a failed round followed by a successful
  one is the ordinary shape of a working run, and anything recording what was
  said has to record it per round, with the provider and the model on each
  (a run can be retried against the other vendor entirely). Six rules.
  **Off costs nothing**: the switch *is* the presence of
  `AgentRunContext.onExchange`, not a flag a handler reads, so a run nobody
  asked about never walks a content block — the `MqttObserver` stance.
  **A round records what it added, never the conversation so far**: an agent
  loop resends everything every turn, and the system prompt and the
  `submit_mapping` schema alone are 9.9 KB and 6.7 KB *per round*, so recording
  each request whole would write them forty times and make the last round the
  size of the run; the configuration and the system prompt are carried once, on
  round 1. **It is main data, not bodies** — labelled, excerpted parts
  (`{kind, label, text?, bytes?}`), with `kind` an open string like
  `commandFailed.kind`, and a cut part carrying what it weighed whole so no app
  asserts a constant from here. **Nothing carries a credential**: request
  bodies only, never headers. **It can never end a run** — recognising the
  device is the job and this is a convenience, so the distillation, the
  excerpting and the callback all sit under one `catch` inside `record()`,
  which is why it takes a thunk rather than a value. And **two bounds**, seven
  days and a row cap, written once with the run rather than per round
  (`STATE_FLUSH_MS` again), with a pruned run taking its rounds with it.
  `docs/ai-adaptation.md` is canonical.
- **A device is routable before the agent is asked, a new parameter is not a
  reason to pay again, and the overlay may not take a capability away.** Five
  faults met on one Aqara plug, and they read as one symptom — a plug that had
  worked until the AI mapped it, then sat dead while its model was recognised
  over and over. **First, `adoptDevice` put the device into `byIeee`/`byFriendlyName`
  *after* awaiting the mapper.** Those two maps are how `handleMessage` finds a
  device, so for the tens of seconds a run takes every state report and every
  `<name>/availability` message was looked up, missed and dropped — and on the
  first adoption after a restart there is no earlier entry at all, which is
  exactly when Z2M republishes its retained availability. The hub threw away
  the one message saying the device was back and kept the `offline` it had read
  out of SQLite. Registering first costs nothing and is what makes a run
  invisible to the rest of the adapter; the previous mapping is carried over
  too, so a regeneration never leaves a device less usable than it was.
  **Second, the runtime unknown-key remap forced a regeneration**, which drops
  the stored mapping and pays for a fresh run — so a model already recognised
  was recognised again every time one more property appeared, and `aiAskedKeys`
  is in-memory, so every restart began the sequence again. Four paid runs on
  one plug in an hour, each mapping covering whichever properties were in that
  run's samples. It consults the library now: a model this hub knows costs
  nothing to meet again, and *upgrading* one is what the owner's "Work it out
  again" is for — the only thing that should spend money unasked.
  **Third, `version` was `z.literal(1)` rather than defaulted**, so a run would
  submit a good descriptor, be told `version: Invalid input: expected 1`, and
  resubmit — five, six, seven paid rounds of one run, on every run. It is a
  constant; the parse fills it in.
  **Fourth, `mergedEndpoints` let the descriptor overwrite `primary`**, and
  that is the one that actually looked like a broken device. Capabilities merge
  as a union, so the overlay can only add — but `primary` is a single field,
  it is what every app draws the tile from, and `custom` is layer 2's generic
  catch-all, which renders as *no control at all*. A mapping that named
  `custom` as its primary therefore turned a working switch into a dead grey
  tile while the hub reported the device perfectly online and `onOff` sat in
  `capabilities` untouched: nothing but that one word had moved, which is why
  every reachability theory came back clean. The agent's `primary` is taken
  only when it neither demotes a typed capability to `custom` nor names a
  capability the merged endpoint does not have — a primary with no state behind
  it is a tile bound to nothing. Promotion is untouched, because a `custom`
  primary upgraded to `onOff` is the whole point of layer 3; it is only the
  demotion that is refused. The general rule is worth more than the case:
  **an AI overlay may add to what the static mapper found and may never
  subtract from it**, so anything new that merges a descriptor into a static
  mapping has to say what happens to the fields that cannot be unioned.
  **And the merge that combines the two *reports* was breaking that rule too,
  one recursion short.** `handleMessage` runs the static rules and the
  overlay's rules over the same payload and merges the patches, and the
  adapter had a private one-level-deep merge for it — right for every shape in
  `EndpointState` except the one that is two levels deep, `custom.values`. So
  the moment an overlay declared a generic field of its own, its `values`
  object replaced the static mapper's wholesale: the inventory went on
  advertising every static field and not one of them received another value.
  Seen on an Aqara plug whose six settings went blank behind an uploaded
  schema naming three fields, which reads as controls the plug had stopped
  answering. `schema/state.ts` already had the recursive version, with a
  comment naming `custom.values` as the case to get right — which is exactly
  why there should only ever have been one of them, and there is now:
  `mergeStatePatch`, beside `mergeState`.
  **The whole of this bullet is about a device layers 1–2 place completely,
  and the prompt had no way to say so.** `uncovered` is empty for that plug,
  so the agent has genuinely nothing to do — but `submit_mapping` is the only
  answer channel and the schema needs an endpoint, so a model with nothing to
  add invents something. Both vendors did, in the two ways available:
  restating the generic fields that already existed (a harmless no-op), and
  declaring fields for properties `IGNORED_PROPERTIES` hides plus one the
  device does not publish at all. Two additions to `prompts.ts` close it, and both are
  about the message being **true** rather than about steering the model. One
  sentence says that a property appearing in none of the three lists is
  telemetry the static mapper hides on purpose — without that, `uncovered: []`
  reads as "nothing here needs looking at" while the exposes tree plainly
  carries properties nothing has placed. And when `uncovered` is empty **and
  layers 1–2 placed something**, it asks for a genuine *upgrade* or for the
  hub's own mapping back unchanged. That second condition is load-bearing and was missed
  once: a device whose exposes are all on the hidden list places into
  *nothing* — one endpoint, no capabilities — with `uncovered` still empty
  because nothing was left over to be uncovered, which is the case with the
  **most** work in it and the one `needsHelp`'s `staticallyEmpty` arm exists
  for.
  **What that sentence must not become is a list**, and it took two goes to
  land. The first version named the hidden properties per device and said
  never to re-declare them — which would have refused the one genuinely useful
  thing either run did for that plug, since the list is applied without
  knowing the device and cannot tell mains voltage on a metered plug from
  battery voltage on a door sensor. The second kept the list and softened it
  to a judgement, which was right and still more than the hub has any business
  saying: the fact only the hub holds is that the absence is deliberate, and
  the decision belongs to the layer that can see the device. Neither addition
  is a filter in code —
  dropping a field for an unpublished property would break
  `detectUnknownParameters`, which exists precisely because devices publish
  keys their exposes tree never declared.
  **Fifth, the radio's word on a device can arrive before the device has a
  name** — found in the same hub's log, and the one that fails in the opposite
  direction. The broker replays every retained message the instant the adapter
  subscribes, so `bridge/devices` — the only thing that *names* a device — and
  the `<name>/availability` readings about those devices land in one burst, in
  whatever order the broker picks. `bridge/devices` is dispatched as
  `void syncDevices(...)` and `syncDevices` awaits `adoptDevice` per device, so
  only the **first** device is registered synchronously: every device behind it
  is still nameless when its own retained availability is handled, the
  `byFriendlyName` lookup misses, and Zigbee2MQTT's own account of what it can
  reach is dropped on the floor — on every start, for every device but one.
  What was left was `bridge/state`, which says only "the radio is up" and marks
  *everything* online, so a device that was genuinely away came back reading
  healthy and stayed that way; for a device that is simply gone there is no
  later change to publish, because the retained message was the whole
  statement. An unrecognised name is parked in `pendingAvailability` and
  replayed the moment `adoptDevice` registers it, bounded (one entry per name,
  oldest evicted past the cap) since it is fed by whatever sits on the broker's
  tree rather than by anything the hub knows. Note the direction before
  reaching for this to explain a device stuck offline: it made devices falsely
  **online**, never falsely offline.
- **Automations are data the hub interprets, and the guards are not
  negotiable.** `src/automations/` is the rules a home runs by itself, and a
  **scene is an automation with a `manual` trigger** — one object, one store,
  one vocabulary, because "press this and the house does that" is not a second
  system. `docs/automations.md` is canonical.
  **The document is `MappingDescriptor`'s rule again**, and for five reasons
  rather than one: the service account can read `hub-secret.json`, the token
  hashes and `<data>/update/` (a write there starts a root unit); there is no
  compiler in the bundle; a rule has to be rendered to a person in their own
  language; a rule has to be checkable before it runs; and a rule outlives the
  build that wrote it, so `version` is **defaulted** (the `z.literal(1)` bill
  came due once already) and a document this build cannot parse is kept,
  reported and **not run** rather than silently missing a step.
  **A target is a selector, not only a list of ids** — "every light in the
  Kitchen". It is the request people actually make, it survives a lamp being
  paired next month, and it is the only way a template authored before it meets
  a home can install into one. The resolver also picks the endpoint carrying
  the capability the command needs, so a two-gang switch does the obvious thing
  without the author knowing it has two endpoints. Reachability is deliberately
  **not** a filter: a command to a sleeping battery device is queued by the
  protocol, and dropping unreachable devices would un-target half a home of
  sensors and make a rule mean different things at different times.
  **A `deviceState` trigger fires on the crossing**, never on every report
  while the test still holds — a battery at 12% reports hourly and would
  announce itself hourly for a month. The first evaluation of a pair *adopts*
  the answer and says nothing, which is `REACHABILITY_QUIET_MS`'s judgement
  applied to rules; and because the engine only sees a device when it
  **changes**, triggers have to be **primed against the home as it is** on
  every load, or the first change ever observed is mistaken for first sight and
  swallowed. That one cost a motion rule the first person to walk past it, on
  every boot.
  **A threshold on a continuously-varying reading is refused without `for` or
  `hysteresis`.** This is `STATE_FLUSH_MS` pointed at a relay instead of an SD
  card, and it is the rule the schema cannot express, so `sanity.ts` holds it.
  The two are not interchangeable: `for` suppresses a spike, `hysteresis`
  suppresses a value resting *on* the threshold and dithering across it, which
  an edge does nothing about because every wobble is a real edge. Actuator
  positions are deliberately not continuous — `level.current` moves because
  somebody moved it.
  **Five guards, and they apply to automation-driven commands only.** A person
  tapping a card quickly is a person; software tapping quickly is a bug, and
  that distinction is the whole reason the limits can be this tight.
  Idempotence first (one comparison against the registry's cache, and it
  absorbs most flapping); a two-second floor per endpoint, because a relay
  rated for 100 000 operations switched once a second is dead in a day and a
  half; hourly and daily budgets per device; causation with a depth cap; and a
  circuit breaker that switches a runaway rule off, writes `disabled_reason`
  and puts one line in the activity log. **Attribution is recorded *before* the
  write**: Zigbee2MQTT publishes optimistically, so a mains device can report
  its new state before `execute` resolves, and with the record afterwards
  `causeOf` answered "nobody" for exactly the reports our own commands caused —
  every link of a loop restarted at depth 0 and no chain could be cut. Three
  commands are never idempotent (`toggle` is defined by what it does,
  `stopCovering` is an interrupt, `irSend` has no state behind it), and a value
  never reported always sends: silence is not evidence.
  **The clock is injected and nothing is made up.** The tick fires for the
  minute it is *in*, so a schedule missed while the hub was down does not fire
  late; everything is held while the clock is implausible, because a Pi has no
  RTC and boots into a fictional time NTP corrects seconds later; an `interval`
  arms on the first tick rather than firing, since a restart is not an interval
  elapsing. A `wait` does not survive a restart and is capped at fifteen
  minutes to say so. `tick()` is public for the reason `HistoryService.flush()`
  is — a scheduler that reads `Date.now()` can only be tested by waiting.
  **Only a manual run reaches the activity log**, which is the log's own rule
  (what was *asked*, never what was reported): a motion rule's forty daily
  firings would drown a feed bounded at 5 000 rows. Traces live in
  `automation_runs`, bounded **per rule** — a global cap lets one chatty rule
  evict every trace of a quiet one — and they record the commands a guard
  *refused*, since "nothing happened" and "the hub declined to switch that
  relay for the fortieth time this hour" look identical from outside. The one
  automatic firing that does get a row is the breaker switching a rule off,
  because somebody has to find that a week later.
  **`enabled` and `active` are two words with two permissions.** `enabled` is
  whether the rule exists and is listening → `automation.manage`; `active` is
  whether a mode is switched on right now → **the floor**, because pressing
  "Night" switches lights and working the home is what being a member means.
  And a new rule is created **switched off** whatever the caller asks, because
  the moment between "here is what I wrote for you" and "your house is now
  doing it" is the only one in which somebody can still look.
  **What a rule is *called* is not what it does**, so `name` and `icon` ride on
  `PATCH /automations/:id` beside `document` — the apps hold the `summary`
  rather than the structure, and making them send a whole rule back to fix a
  typo would mean every app carrying a second copy of the DSL. Three rules, and
  the first is the one that bites: **a rename writes `document.name` too**,
  because `AutomationStore.update` sets the column *from* the document, so a
  rename that touched only the column would be undone by the next edit made in
  conversation — and the agent reads the document, so it would go on using a
  name nobody in the home uses any more. It **spends no version** (ten are kept
  per rule to walk back out of a bad afternoon, and the behaviour is untouched),
  and a rename is **logged** where a restyle is not — the rooms rule, since the
  feed is read a week later and "somebody changed that rule's icon" is not what
  anybody is looking for in it. `icon` is an opaque app token, null meaning
  "the app derives one" from the name and the shape, unvalidated here for the
  reason a room's is: an allowlist would need a hub upgrade for every mark an
  app adds.
  **Where a rule happens is derived, never stored** (`scope.ts`): every rule on
  the wire carries `roomId`, the one room every device it touches sits in, or
  null for a rule about the whole house — which is what lets an app put a rule
  on the page of the room it belongs to. A rule's room is a function of the
  document *and of the home right now* (a selector picks up a lamp paired next
  month; a device moved between rooms changes the answer with the rule
  untouched), so a column would be a second copy going stale in the dark; it is
  computed per read beside `summary` and costs what that costs. Four rules.
  **A selector naming a room declares one** whether or not anything is in it
  yet — "every light in the Kitchen" is the Kitchen's rule the day it is
  written, and everything such a target resolves to is in that room by
  construction. **What a rule watches counts**, not only what it does: the walk
  covers triggers, conditions (nested, since `all`/`any`/`not` hold more of
  them), actions and a toggle's off-actions, because a rule watching the
  Kitchen and switching the Hall is not the Kitchen's. **Touching a device
  nobody has placed disqualifies it** — the "not in a room" bucket is somewhere
  nobody has said, and the rule becomes the room's the moment that device is
  placed. And **`runAutomation` is not followed**: that rule has its own room
  and its own page. The half a client has to know is that **`roomId` moves
  without an `automation` frame**, because nothing about the automation
  changed — so an app re-reads on structure, not only on rules.
  **A rule is also sent as a picture** (`outline.ts`): the same document as four
  lists of display-ready steps — when, only if, then, and a toggle's off-branch
  — so an app can *draw* a rule instead of printing the sentence. It is the
  `message`/`data` split one step further, and the reason it belongs here rather
  than in an app is the reason `summary` does: neither app decodes the DSL,
  because a second copy of it would go stale there in the dark, and a sentence
  was then the only thing either could show. The hub already interprets the
  document to run it; this interprets it once more to draw it. Six rules, all of
  them the ones `summary` already lives by. `title` is the only field that is
  always there and `glyph` is an **opaque token** — the room-icon vocabulary
  applied to a step — so a step kind added later reaches an older app as an
  unrecognised mark over a line that is still true, and adding one needs no app
  release. A step is **three fields** because it is three thoughts (the act,
  what it acts on, the qualifier), and only the hub knows which half is which.
  **Two tenses**: a trigger is the moment of crossing ("goes above"), a
  condition is asked while the rule runs ("is above") — one table for both said
  a rule waits for its condition to move. `tone: "quiet"` marks a step that is
  not an act on the home (a wait, a log line), which is what lets an app draw a
  wait as the *gap* between steps. Nesting is `children` + `join`, indented
  rather than recursed. And it is **derived per read and read-only**: nothing
  addresses a node in the document, because a builder would be this same list
  with its steps addressable and that is a decision to make on purpose.
  `phrasing.ts` is the one place a stored number becomes what a person means by
  it, shared by both surfaces — two copies of that table is two places for the
  centi-°C mistake to come back in only one of them.
  **The catalog is generated** from the live zod schema and is the one source
  the agent, the apps and the docs all read — the `GET /permissions` rule
  applied to a vocabulary that will keep growing. Units are written out in
  words at every path and command, because a model that writes 22 for 22 °C
  produces a rule wrong by two orders of magnitude that reads perfectly.
- **The automation agent is authoring, never runtime, and it lives on the
  hub.** `src/ai/automation-*.ts` writes rules in conversation;
  `src/automations/` runs them, with no key, no network and no idea the agent
  exists. So `ai_enabled: false` stops rules being *written* and touches
  nothing already running — "stop spending my money on this for now" must not
  put the lights out on a schedule. `docs/automations.md` is canonical.
  On the hub for the same reason the mapper is (the Agent SDK's 276 MB binary
  and per-run subprocess), and **not in the cloud** for a reason of its own:
  this agent's tools *are* the home, the home is on a local network, and a
  provider's container cannot reach it — every tool call would need a tunnel
  that does not exist.
  **A conversation suspends, which is what makes it different from a mapping
  run.** That run is one call that either submits a descriptor or does not;
  this one hands control back on `ask_user` **and** on a prose ending, both of
  which outlive the request. So the provider owns the message history (it is
  the vendor's own shape) and the conversation is an object with a lifetime.
  Answering closes the tool call `ask_user` opened — a plain user message after
  a pending call is a conversation the API refuses — which is why `answer()`
  sits beside `send()` and why a *typed* reply is routed to `answer` anyway.
  **Two stores, and the split is what makes keeping a chat affordable.** The
  message history is in memory, tens of kilobytes a round, and dies with the
  process; the transcript an app draws is on disk, a few hundred bytes a
  message.
  **The memory is rebuilt from the record, and it has to be, because the two
  lifetimes are two hours and a fortnight.** A restart or the idle sweep used
  to cost the *continuation* — `410 conversation_ended`, the chat readable and
  nothing more — which sounded like an edge and was the ordinary case: for
  thirteen of every fourteen days everything in the conversations list answered
  410, both apps drew a closed composer over it, and "ask it to try again" was
  not a thing anybody could do about a conversation that had worked perfectly.
  `revive()` builds a fresh provider conversation under the same session id and
  primes it with a recap of the stored rows. Three rules. The recap reaches the
  **model and never the transcript** — it is a read-back of rows that are
  already there, and writing it down would put the chat inside itself as a
  message — so it rides on `ChatSession.priming`, consumed by the first
  exchange. It is worded as *history rather than memory*, because a model told
  it remembers a decision it is only reading will defend it. And **ownership is
  read back out of the rows** (`automation_chat_messages.member_id`): a live
  session carries its member and `reply` compares against it, while a revived
  one is built from the caller's own id, so without that any member could
  reopen anybody's conversation by its id. The only `410` left is a session
  with no rows at all — one that never existed, or whose fortnight is up. **`ask_user` carries two to four options** because somebody who does
  not write software taps one and will not compose an answer, and that is the
  single thing that makes this usable by the people it is for.
  **Prose *is* an answer, and saying otherwise cost a rule.** The prompt read
  "a run that ends without submitting has produced nothing" and
  `submit_automation`'s description said the same, so asked "how does this
  work?" the model reasoned — visibly, in the trail — that "the framework seems
  to require submitting something to produce output" and resubmitted the rule
  unchanged: it rewrote what the home was running to answer a question about it,
  and handed back a card with nothing said. Both now say the true thing —
  submitting is the only way to *deliver a rule*, prose reaches the person
  exactly as written, and a rule is never resubmitted unchanged.
  **A step says what it did, not only what it was**: `AutomationToolResult`
  carries an optional `detail` beside the `text` the model reads (the device
  looked at, how many matched, the sentence a draft would carry, the first
  reason it would be refused), and it rides the same `step` frame `ask_user`'s
  question does — `dry_run`'s is the most useful line in the trail, the rule read
  out while the agent is still deciding rather than only on the card afterwards.
  **One conversation, any number of rules — and one reply can carry more than
  one card.** Two faults, and they read as one: the loop kept a single
  `handedBack`, so a second `submit_automation` in one response overwrote the
  first (both told "Accepted", one ever saved); and the save was positional —
  first submission creates, every one after it *replaces* — which was right
  about a model fixing the rule it had just written and silently wrong about
  "and also switch everything off at midnight", which overwrote what had been
  written a minute earlier. So a turn hands back a **list**, and each
  submission says which rule it is: `replaces` is an id or `null`, **required
  and nullable** rather than optional, because an omitted id is exactly the
  ambiguity that caused the bug and only the model can resolve it. The ids
  reach it on `ChatSession.priming` — the `revive()` channel, model-only,
  never a transcript row — since a rule written a minute ago has an id the
  model has never seen; a revived conversation's recap carries a preview row's
  id for the same reason. One row per rule (so an app draws a card each, with
  `edited` per rule), and the prompt asks for **one line for the lot** rather
  than a paragraph per card. Bounded at four rules a response
  (`AUTOMATION_MAX_RULES_PER_TURN`): two is the case this exists for, and past
  four it is a model that has misread the room writing a page of rules into
  somebody's home — the accepted ones are saved and the rest refused inside the
  turn, to be offered once the person has replied.
  **A submission writes the model's line and then the card, and asking for
  that line one round too late is why it was blank.** The card carries
  `describeAutomation`'s sentence — the *rule*, the same words for everybody —
  while the line above it answers what was actually asked: what changed, in
  their language. On an edit the card alone never says whether it was done.
  The instruction to write it sat in `submit_automation`'s own result ("tell
  them what it will do, briefly, and stop"), which the model can never act on,
  since accepting a submission *ends the turn* and that result is read only on
  the next one — where it is stale advice about last time's rule; and the
  prompt paragraph above it read "prose is not an answer", true about
  delivering a rule and read as "do not write any". The prompt asks for it in
  the **same message as the call** now. Neither the hub nor an app writes that
  line: a canned "All done" is words in the model's mouth. **And when the model
  forgets anyway the loop sends the submission back for it — once**: an accepted
  rule with no prose is held rather than returned, the results go back, and one
  more round runs purely for the sentence (its own step, since the person is
  watching it). Exactly one, because the rule is already saved and a third round
  spent on a sentence the model will not write is worse than handing the card
  over without one.
  **The prompt says what the prose is written *into*.** A model writes Markdown,
  and both halves of that were missing: the apps drew it as characters and the
  prompt never described the surface, so an answer listing four rules arrived
  with `**a bolded heading:**` over a column of literal hyphens. The app renders
  it now (`AgentProse`), and the prompt names the column — three inches wide,
  short paragraphs, a list where something is genuinely listed, bold for a name
  worth picking out — with headings, tables, nested lists and code fences called
  out as not what it is for. Either half alone is worth little: rendering
  Markdown nobody was told to keep simple gives a typeset document in a chat
  bubble, and asking for restraint without rendering still shows the asterisks.
  **Seven tools and no web.** An agent writing a rule for a house has nothing
  to look up, and leaving search out is a plainer promise than a paragraph
  telling it not to search — the one AI surface here that reaches the
  provider's API and nothing else. `submit_automation` is the only answer
  channel and a refusal is a `tool_result` rather than the end of the
  conversation, so the model fixes its document and resubmits without the
  person seeing it got it wrong; `dry_run` is the agent checking its own work
  against the same rules, and it hands back the sentence the apps will show.
  The prompt is built from `catalogAsPrompt()`, names the refusals rather than
  begging for care (the guards are enforced, and a prompt implying otherwise
  reads as the only thing between somebody and a burnt-out relay), and says
  plainly that **there are no notifications** — a model that does not know
  that invents a notify action and spends a round finding out while somebody
  watches. `ai_runs` rows with `kind: 'automate'`, because what a home spent on
  AI is one question and two tables would make it two screens.
  **What a conversation cost is answerable, and three rules make it so.**
  `ai_runs.session_id` is the link: `automation_id` is null for a chat that
  submitted nothing and a revived one writes a row per incarnation, so nothing
  else could total them. **Each row is a delta, never a running total** — one
  is written at every submission (a conversation that has done its job should
  not wait on an abandoned tab) and another when the session closes, so a
  two-rule chat writes several and summing totals would report half as much
  again as it cost; `record` was once-only for a while, which simply dropped
  everything after the first rule. **A live conversation's unwritten
  remainder is added** where `GET /automations/chats` answers, because the
  chat somebody is watching is exactly the one with no row yet, and drawing it
  as free until minutes after they stop looking is the worst possible moment
  to be right. And **the model is read back, never re-derived**:
  `effectiveModel` answers "what will *run*" and is meant to move with the
  offered list, which is precisely wrong for a record of a run that already
  happened — so `provider`/`modelId` are the columns verbatim and only the
  label goes through `modelLabel`, which falls back to the raw id once a model
  is retired. Absent rather than zero when the ledger no longer has it: sixty
  runs against a fortnight of transcript means a readable chat can outlive its
  own spend row, and `$0.00` is a claim where nothing is the truth.
  **The agent picks its own provider, and it is deliberately not the
  mapper's.** `ai.provider` answers "which model reads a device's exposes
  tree" — a real choice, because both halves of *that* are written. Only one
  half of this one is, so reading the same field turned an unrelated preference
  into a refusal: a home with both keys that recognised devices with OpenAI
  could not write a rule at all, with a perfectly good Anthropic key sitting
  beside it. It runs on Anthropic whenever the home has a key that can, and a
  legacy subscription token is not one, since the loop authenticates with
  `x-api-key`.
  **Every way this can be refused is an `AutomationNotConfiguredError` with a
  code *and* a sentence**, and that is the whole of a real bug: the OpenAI case
  threw an `AiUnavailableError` past the route's refusal handler, Fastify
  answered `{"statusCode":500,…}`, and the app drew "The hub answered 500."
  over a hub that was working perfectly and had just said what was wrong.
  Three codes, because they lead to three different screens — no key, AI
  switched off, a key of the wrong kind — with `detail` riding along so an app
  that has never met a code a later build adds still shows something true.
  **A spinner is not an answer to "what is happening", so the socket carries
  four phases.** `step` is one line per thing the agent did, `thinking` is its
  own summarized reasoning as it arrives, `delta` is the reply, `turn` says the
  transcript is ready. Steps used to be reported only once something had
  *happened* — and the first thing that happens in a round is none of it, so the
  longest wait in every round was three animated dots. A step now goes up
  **before** the request, and the reasoning is streamed, which only works
  because the loop asks for `display: 'summarized'` (this model's default
  streams thinking blocks empty). `kind` is what an app draws a mark from and is
  about the *shape of the act* rather than the tool — three tools all mean
  "reading your home" — so a new tool needs no app release; it is an open
  string, the `commandFailed.kind` rule.
  **And the working outlives the wait**: the round's steps are written into the
  **first row that round records** (`data.steps`, the frame's own three fields
  so the live trail and the stored one cannot drift), whichever kind of row it
  is — prose, a question, a card, or the note saying the model could not be
  reached, which is the ending with the most to explain. They were a stream and
  nothing else, gone the moment the turn landed, which is right about a dozen
  open rows above every answer and wrong about the *fact* that there were a
  dozen: a rule arrives out of a handful of tool calls and the page whose job
  is explaining a house to somebody who does not write software was left with
  the conclusion alone. Five bounds hold it to the size of a transcript row —
  the round's first row rather than each of them, the buffer cleared when a
  round **begins** so a throw cannot hand its working to the next answer, the
  person's own row never taking them, and **the last twelve** steps with text
  and detail **cut rather than dropped** (twelve covers every round this agent
  runs; the *last* twelve is the direction an app's live trail drops from, so
  what was watched is a suffix of what is read back). The sentences live in
  `automation-tools.ts` beside the tools: `Looked up list_rooms_zones.` is a
  function signature read out loud, on the one screen whose whole job is telling
  somebody who does not write software what their house is doing.
  **Nothing is ever sent with a `tool_use` left unanswered, and the repair
  belongs before the next *user* turn.** Every call in an assistant turn needs
  a result in the very next message, and a conversation that breaks that rule
  is refused outright and for ever — `messages.N: tool_use ids were found
  without tool_result blocks`. The assistant turn is pushed the moment it
  arrives, so any exit between that push and the results leaves a dangling
  call: a `refusal`, a `pause_turn` carrying calls (now answered rather than
  skipped past), and above all *anything that throws* — `evaluateSubmission`
  reads the home outside `runAutomationTool`'s own catch, and `exchange`
  swallows the throw, writes a note and leaves the conversation open, so the
  damage is invisible until the next message is refused along with every one
  after it. `settleDanglingCalls()` closes them with `is_error` results, and it
  sits in `send()` before the user turn is pushed rather than beside the
  request, which is where it was first put and where it can never fire: mid-loop
  the last message is always the results of the round before.
  **`ask_user` hands back mid-response, and every *other* call in that response
  still has to be closed.** The API's rule is per response — each `tool_use` in
  an assistant turn needs a `tool_result` in the very next message — and handing
  the question back used to abandon the rest (calls before it collected and
  dropped, calls after it never run), so the next request carried a
  half-answered turn and the conversation was refused outright with `400
  tool_use ids were found without tool_result blocks`, reaching the chat as a
  wall of JSON where the answer belonged. They are stashed and sent with the
  answer; a second question in one response is refused inside the turn rather
  than left open, since only one call id can be closed by an answer.
  **A transcript nothing can find again is a transcript thrown away**, which is
  what `GET /automations/chats` exists for: the fourteen-day record was
  unreachable the moment a page closed, because the only way back was a session
  id nobody writes down. Its `title` is the first thing the *person* said (the
  agent's opening line is about the home, not about the ask) and `live` says
  whether it can be *continued* as against merely read — two different states,
  and an app has to offer the right one rather than find out on the next
  message.
  **A message is acknowledged, never awaited.** `POST /automations/chat` and
  `…/messages` answer the moment the hub takes the message — the person's own
  row and nothing else — because a turn is a provider loop with a three-minute
  watchdog and the iOS client gives a hub ten seconds. This is the
  `POST /devices/:id/remap` lesson, and this route shipped with the very bug
  that one was written to avoid: a conversation working perfectly reported
  "the request timed out" every time, while the reply it went on to produce
  arrived on a socket nobody was waiting on. Turns are **chained per
  conversation** (two exchanges against one provider history would interleave
  the messages array, and chaining is also what makes `awaitingAnswer()` get
  asked when a turn *begins* rather than when it was queued), and **every turn
  emits a `turn` frame, the failed ones included** — that frame is what says
  the transcript is ready to re-read and what takes an app's "thinking"
  indicator down, so the provider-failure path returning without one left a
  failed round spinning for ever over a note nothing had gone back for.
  **The test seam (`createConversation`) therefore sits *after* every
  configuration check.** It stands in for the network, not for the rules: above
  them it was a bypass, letting the suite reach a conversation the real hub
  would have refused — the "a mock laxer than the thing it stands in for tests
  the mock" trap, and exactly why the refusal shipped untested.
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
  and caches. `gpt-image-2` is pinned because it supports transparent
  backgrounds in preview, which is the whole point of a cut-out the apps float
  over their own glow.
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
  mosquitto drop-in is four lines — `listener`, `allow_anonymous false`,
  `password_file`, `acl_file` — and adding a fifth needs checking first:
  `/etc/mosquitto/mosquitto.conf` already sets `persistence`,
  `persistence_location` and `log_dest`, and mosquitto treats a repeated string
  option as a **fatal** error rather than an override. Repeating
  `persistence_location` is what kept the broker down, port 1883 closed and
  Zigbee dead on a hub that installed perfectly otherwise.
  `test/deploy-config.test.ts` parses the drop-in against a copy of Debian's
  config to stop it coming back.
- **The broker asks for a password, and there are two accounts.** It was
  `allow_anonymous true`, and that was a hole the size of the product:
  everything a member may do goes through a token and a role on 8420, while
  anybody on the home Wi-Fi could open a broker connection on 1883 and publish
  `zigbee2mqtt/<device>/set` to work every light and lock in the house, or
  `bridge/request/permit_join` to open the Zigbee network, with no credential
  at all. `gethome-hub` is full access and is what hubd and Z2M sign in as;
  `gethome` is the one an owner is handed, and the ACL confines it to
  publishing under `gethome/#` while reading only device state and three
  `bridge/` topics — so a devboard cannot drive the home, and
  `zigbee2mqtt/bridge/info` stays out of reach because we do not depend on
  upstream redacting the network key from it. **The apps needed no change to
  keep working**: Studio reads MQTT over the hub's own authenticated
  WebSocket, never over 1883.
  Six things to keep. **The ACL uses only `read`/`write`/`readwrite`** — the
  one `deny` line that would express it more neatly is a config option an
  older broker fails to parse, and a fatal parse error here is a hub with no
  radios. **The passwords are minted once and reused**, because rotating on
  every run breaks every integration the owner wired in, and
  `gethome-hubctl update` is `install.sh` again. **Nothing turns authentication
  on unless every part of it landed**: mosquitto opens `password_file` and
  `acl_file` *after* dropping privileges, so a 0600 root file is
  `Error: Unable to open pwfile` and a broker that will not start — an open
  broker is a hole, but a dead broker is a hub with no Zigbee and no MQTT, and
  the installer must never pick the second while fixing the first, so every
  step that can fail clears `MQTT_SECURED` and falls back to the open drop-in
  with a `@@WARN@@`. **The credentials live in `/etc/gethome/mqtt.env`, never
  in `hub.env`**, which is written only when absent and so never reaches an
  upgraded hub — the same trap as a `GETHOME_UPDATE=1` line there; both units
  pull it in with `EnvironmentFile=-`, and it is listed **after** `hub.env`
  so the `MQTT_URL` in it wins, which is the rollback story: a build older
  than `MQTT_USERNAME` can only authenticate through the URL.
  `loadConfig` lifts credentials out of whichever URL it is given, so the
  current build is right either way and no password reaches a log line.
  **`GET /settings/mqtt` writes to the activity log**, alone among the GETs
  here, and that is what makes `hub.mqtt` safe to delegate: a token is revoked
  by removing a member, a password is not, so the home has to be able to see
  who was handed one. Which is also why both keys are owner-only by default —
  the one place the "bounded cost" test comes out the other way from
  `hub.update` and `hub.ai`, which both moved into **member**'s set on the
  argument that the person standing in the house is the one who needs them.
  That argument does not reach a broker password: it is a front-door key
  rather than a spending decision, and it is the one thing here that outlives
  the token it was read with. And **`test/deploy-mqtt-acl.test.ts` runs a real broker on the
  config `install.sh` writes** and tries the attacks, because four `topic read`
  lines prove nothing about what mosquitto does with them; it also adopts a
  device published with the limited account, since an ACL tight enough to stop
  an attack and too tight for the feature it protects would pass every static
  check and ship a broken integrator story. `docs/mqtt-integrations.md` is
  canonical for integrators, `docs/api.md` for the route.
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
  is the router — which is why it is also the reason the broker now has a
  password, see the two-accounts bullet above.
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
trigger/DSL → `docs/ai-adaptation.md`; portraits → `docs/portraits.md`;
module boundaries → this file +
`docs/architecture.md`; installer markers, autostart or Zigbee detection →
`docs/zigbee.md` + the marker list in `deploy/install.sh` (and flag the Studio
repo); anything README restates → `README.md`.
