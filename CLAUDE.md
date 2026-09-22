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
convention), `ai-adaptation.md`, `automations.md`, `assistant.md`, `jev.md`,
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
npm run typecheck                         # strict, exactOptionalPropertyTypes — src *and* test/
npm run typecheck:test                    # just the test-suite pass, while iterating on a suite
npm test                                  # vitest — the database is a temp file, so nothing to start
HUB_TEST_MQTT=1 npm test                  # + end-to-end broker round-trip (needs a local mosquitto)
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

`ws` is the one direct dependency added for the voice, and it was already in
the tree via `@fastify/websocket` — declared rather than used transitively,
because the audit rule below is about the lockfile being *ours* to pin. Node's
own global `WebSocket` cannot carry an `Authorization` header, which is what
attaching a sideband needs.

Green `typecheck` + `test` is the bar for every change. The e2e suites
(`test/integration/mqtt-roundtrip.test.ts` for the whole pipeline,
`test/integration/zigbee-adapter.test.ts` for the Zigbee runtime AI
adaptation) are the proof it all works — run them for any
adapter/registry/API change.

## Architecture: the boundaries that matter

- **`src/schema/` is dependency-free** (zod only) and is the single source of
  truth. Everything else derives from it.
- **Adapters only see the `AdapterBus`** (`src/adapters/adapter.ts`). They
  never import `src/api` or `src/db`. Adding a protocol = new directory under
  `src/adapters/` + registration in `src/index.ts`.
- **`DeviceRegistry`** (`src/core/registry.ts`) implements the bus: per-device
  serialized write queue, write-through cache, JSON state persistence, event
  fan-out, command routing. Adapter start failures are isolated — the hub must
  keep running (and must boot with no devices/radios at all).
  Its reachability and persistence rules — the radio statements, the two
  rows reachability lives in, the `STATE_FLUSH_MS` debounce — are in
  `src/core/CLAUDE.md`.
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
  **A decision model is not an `AiProvider`.** Jev (`src/ai/decide/`) holds a
  credential slot and nothing else — it returns typed values and cannot write a
  sentence, so it is never in `PROVIDER_MODELS`/`AGENT_MODELS`, never answers a
  chat, never decides a permission and never produces a number. Widening
  `AiProvider` would fail the typecheck on exactly the three
  `Record<AiProvider, …>` tables it must never be in, and **that break is the
  guard** — `AiVendor` (whose model answers) is the second vocabulary and
  `AiCredentialSlot` (a row holding a key, the gateway's included) the third,
  each used only where it is meant. Every call is confidence-gated with
  today's path as the fallback and `decide` answers `null` rather than
  throwing, so an outage
  costs nothing; the write still goes through `AssistantChat.control`, past the
  guards that were always there. `docs/jev.md` is canonical.

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
- **Watching costs nothing when nobody is watching, and that includes the
  socket.** The `MqttObserver` half is in `src/core/CLAUDE.md`; the same rule
  governs `src/api/ws.ts` — the `mqtt`, `zigbee` and `ai` streams are opt-in,
  so a socket that never subscribes never has a listener attached and the iOS
  app is untouched; `hello` advertises what the hub can offer so a client never
  infers it from a version number; and frames are rate-limited per socket with
  the losses *reported*, since a gap nobody is told about is worse than a gap.
- **The radio budget is a memory reading, and a board name is never the claim.**
  `install.sh` divides `MemTotal` by **1024 MB** and writes `GETHOME_RADIO`;
  nothing looks at the model. So a **1 GB Pi 4** and a **Pi 3** answer
  `budget: one` exactly as a Zero 2 W does, which reads in practice as *2 GB or
  more runs both*. Copy that says "a Pi 4 runs both radios" is wrong for every
  1 GB Pi 4 in circulation — it was written that way in five user-facing places
  across the three repos at once, including this repo's own README two
  paragraphs from a table that said the opposite. Write the memory, not the
  model, everywhere a person reads it. Two things follow that are **unmeasured
  rather than decided**: every figure in `docs/zigbee.md` came off a 512 MB
  board, so the 1 GB tier is grouped with the small ones out of honesty rather
  than measurement. **The ceilings are not shared, and that split is the fix to
  a real fault**: `SMALL_BOARD` used to hand a 1 GB board the 512 MB board's
  `MemoryHigh=200M`, which throttles the hub against ~920 MB of `MemTotal` —
  and throttling is what `radio-pressure.ts` acts on, so such a board could have
  a radio taken back with hundreds of megabytes free. `install.sh` now splits at
  `TIGHT_BOARD_MAX_MB` and gives 1 GB its own (400M/320M/400M, heaps 320, no
  `--max-semi-space-size` pin), reasoned from the same full-home arithmetic the
  512 MB numbers came from rather than measured; `test/deploy-config.test.ts`
  pins that the roomier tier really is roomier, since the older test slices the
  whole `-le 1024` block and passes on either branch alone. **The budget is the
  separate decision**: `radio-pressure.ts` gates *acting* on `budget === 'one'`,
  so promoting 1 GB to `both` would remove its safety net as well as its
  warning, and that one wants hardware.
  **And a budget is a measurement of the machine, so a machine that changes
  under it has to be re-measured.** `hub.env` is written only when absent —
  right for the settings in it, wrong for this — and the commonest way a home
  grows is an SD card moved into a bigger Pi, which carries `/etc/gethome/` and
  `<data>/` along with it. A card that started in a Zero 2 W therefore told a
  Pi 5 it had memory for one radio for ever, since re-running the installer does
  not rewrite an existing file either: the upgrade path this repo's own README
  recommends ended on a board that still recommended one radio and could still
  stand one down with gigabytes free. `install.sh` reconciles `GETHOME_RADIO`
  and the heap now, and **only ever widens** — a stored `both` is the documented
  hand-edit and the owner's override, so narrowing must never happen. The other
  half of the same transplant is `<data>/radio-stand-down`, which is a **small
  board's fact**: on a board measured for both it is history rather than a debt,
  so `hub-status.ts` gates `suspended`/`willRetry` on the budget and
  `radio-pressure.ts` gates the restore on it — without both, the apps drew
  "Your hub went back to one radio" over a hub plainly running two, permanently,
  because the watch only restores while *one* radio is live and nothing else
  could clear the record.
  **And every surface that offers `both` on a `one` board owes one sentence
  that is easy to edit away** — *what changes this is your Zigbee network
  growing* — because the failure worth designing against is not a hub falling
  over. It is somebody turning both radios on with four devices, being
  perfectly happy, buying for a year on the strength of it, and meeting the
  trade when a different board is no longer the cheap answer. Say it works now,
  say what changes that, say what the hub does when it stops fitting, and name
  the board that never has the question as *2 GB or more*.
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
- **The core services' own conventions live in `src/core/CLAUDE.md`**, which
  loads when you work under `src/core/`: device reachability and the
  `STATE_FLUSH_MS` debounce, the MQTT observer, the activity log, reading
  history, the permit-join window, a radio that is off versus missing, the
  memory-pressure watch and a suspended radio, per-member favorites,
  `offlineExpected`, the pairing-code and `gethome-hubctl claim` contracts, and
  the home's one name. One of its rules binds code outside that directory, so
  it stays here: the history table **is `WITHOUT ROWID`**, which drizzle cannot
  express — the migration is hand-finished and `db:generate` must never be
  allowed to write it back to a plain table.
- **The Zigbee adapter's conventions live in `src/adapters/zigbee/CLAUDE.md`**:
  failed writes read from `bridge/logging`, the two relayed bridge topics,
  `friendly_name` versus the suggested name, and the Z2M unit conversions. One
  of its rules binds `DeviceRegistry` too: **`Request superseded` is not a
  failure** — it is a newer write to the same property taking this one's
  place, so it is dropped in the adapter *and* in the registry, which is the
  seam a second adapter arrives at.
- **Matter's conventions live in `src/adapters/matter/CLAUDE.md`**: discovery
  from the setup code's own capabilities, Bluetooth, the three refusals before
  anything is searched for, one bounded pairing at a time,
  `matter.settlingUntil`, `GET /matter/discoverable`, and the reducer's
  lockstep with the iOS `MatterStateReducer`. One of its rules binds every
  read behind `GET /hub`: **nothing that route reads may throw**, because it is
  the health check `install.sh` gates on — each read is `try`/`catch` with a
  documented fallback, and a new one has to be.
- **Portraits' conventions live in `src/portraits/CLAUDE.md`** — files beside
  rows, bounds on bulk, the pinned image model and its prompt, and what a
  drawing cost in `ai_runs` — and **the traps in the suites themselves live in
  `test/CLAUDE.md`**: a mock's history is per test, and a wait has to be for
  the thing an assertion is about, never for a count something else can reach.
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
- Secrets: tokens are stored sha256-only; each AI credential (an Anthropic key,
  an OpenAI key, a TypeSafe key and a Vercel AI Gateway key — one slot each;
  the third is **not** a provider and the fourth is not even a vendor, it buys
  the other three's models) AES-256-GCM-encrypted with the hub
  secret (`<data>/hub-secret.json`, 0600); the API never returns key material.
  Keep it that way — it is also the reason portraits are drawn *here* rather
  than by handing a phone the key.
- **A route is whose key buys a vendor, never what answers.** Each vendor —
  Anthropic, OpenAI, TypeSafe — is `direct` (its own key, its own API) or
  `vercel` (the gateway's key, at the gateway's copy of the same API),
  stored per vendor and absent meaning direct, so saving the gateway's key
  moves nothing until somebody moves a vendor onto it. Anything that asks a
  vendor for a model reads `SettingsService.aiConnection(vendor)`, which
  answers the key and the route from one read — **never `aiKey()`**, or a home
  routed through the gateway is answered on a key it chose not to spend. The
  one exception is the voice: GPT-Live's WebRTC offer and sideband are
  OpenAI's own, so it always uses the home's own OpenAI key.
  `src/ai/gateway.ts` holds the addresses and `wireModelId` — the canonical id
  is what every price, `ai_runs` row and API field reads, and only a request
  carries the gateway's spelling. `docs/api.md` (*The gateway*) is canonical.
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
- **The hub is a LAN service, and the one attack that reaches past a bearer
  token is rebinding.** Every route but `GET /hub` and `POST /pair` is behind a
  token, and no browser can attach one cross-origin: there are no cookies here,
  so a hostile page has no ambient authority to borrow, and asking for an
  `Authorization` header triggers a preflight this API answers with a 404.
  **That is why no CORS plugin is registered — the absence is the policy**, and
  adding one would be handing back exactly what it withholds. DNS rebinding
  walks past all of it by changing what the browser *thinks* the origin is: a
  page on `evil.com` whose record flips to `192.168.1.50`, re-resolved, read
  back as same-origin. No token is involved, so nothing about tokens helps.
  `api/host-guard.ts` is the answer and the rule is about **names, not
  addresses**: an attacker needs one they control, which means a registrable
  public domain, while everything a hub is legitimately reached by — an
  address, `localhost`, a bare machine name, `.local` and the other local
  suffixes — cannot be pointed at somebody else's LAN. So no client had to
  change to keep working, and that was **checked against the app rather than
  assumed**: `HubDiscovery` resolves a hub to its IP and deliberately never to
  a name (it forces IPv4 precisely because the hub binds `0.0.0.0`), and both
  `HubClient` and the widget build `http://<host>:<port>` from that address, so
  `URLSession` puts an address in `Host`. The iOS repo carries one line for
  this and no more: `host_not_allowed` is named in `HubClient`'s error mapping,
  because a bare 403 there reads as *"this home doesn't let your role do that"*
  and would send somebody to the role matrix over a name their router resolved.
  The refusal is a **403 that echoes the name**,
  because whoever meets it is almost always somebody who reached their own hub
  by a name nobody anticipated. It hangs off `onRequest` rather than a
  per-route `preHandler`, which is the placement doing the work: before the
  body, before the two unauthenticated routes — `GET /hub` is exactly what a
  rebound page reads, so exempting the public route would be exempting the
  target — and before the WebSocket upgrade, where a socket authorizes once and
  then streams the home. `EXTRA_ALLOWED_HOSTS` **adds** rather than replaces,
  for the one arrangement that cannot be recognised (a real domain resolved to
  a LAN address inside the house): a list that replaced the local rule is one
  somebody sets to their own domain and thereby stops their own phone, which
  reaches the hub by address, from connecting at all. There is deliberately
  **no wildcard** beside it — a hub is a board on a home network and that is
  the only deployment there is, so a mode that switched the check off would be
  a second thing to get wrong for a topology nobody runs, and `*` is exactly
  what somebody reaches for when a name is refused. And refusals are logged
  **once per name, up to a bound**, because a refusal is the only thing that
  tells an operator their hub has gone quiet and why — while the names are the
  attacker's to invent, and one line per request is an SD card.
  `BIND_ADDRESS` is the same question one layer down and defaults to
  `0.0.0.0`, which is not going to change: a hub is found from a phone on the
  same Wi-Fi, so loopback would be a hub nothing in the house can reach. It is
  a *narrowing* for a board on a network it should not serve, never a security
  boundary — the boundary is still the router, which is what the README says
  and what the broker's own note repeats.
- **The hub answers on IPv4, so it must not advertise itself on IPv6.**
  `0.0.0.0` is an IPv4 socket and the dual-stack `::` is refused deliberately:
  a home's IPv4 is behind NAT and a global IPv6 address is not, so binding both
  would put a plain-HTTP, bearer-token API on a routable address behind a
  firewall default this hub cannot see. The board keeps its IPv6 — Matter needs
  the link-local one and will not start without it — the API just does not
  answer there. What that obliges is the other half: **never publish an address
  the caller cannot reach.** It is the rule `install.sh` already applied to
  `docker0`'s `172.17.0.1`, and an AAAA record is the same fault one level up,
  because a client takes whichever answer arrives *first* and on a Pi that is
  usually the IPv6 link-local. It cost both apps a workaround before anyone
  noticed the hub was the one lying: the iOS browse sat on "Finding its
  address…" over a hub two metres away, and Studio spent a four-second timeout
  and fell back to a `.local` guess. **What the hub can do about that is
  bounded, and measuring it corrected this paragraph.**
  `mdns/advertiser.ts` writes `<service protocol="ipv4">`, which settles what
  *our service* is announced on and is the part that is ours. The A and AAAA
  for the machine's own name are avahi's, and `install.sh` sets
  `publish-aaaa-on-ipv4=no`, which stops the AAAA going out in reply to a
  lookup that arrived **over IPv4** — that and no more. A client that also asks
  over the IPv6 transport, which macOS and iOS both do, still gets the board's
  link-local AAAA, because that is governed by `use-ipv6` and answering it is
  the machine's business rather than this service's. Verified on a Zero 2 W: a
  Mac resolving `pi.local` gets both records after a clean `avahi-daemon`
  restart with both settings in force.
  **Finishing the job would mean `use-ipv6=no`, and that is the hammer to
  refuse.** It switches a whole protocol family off in the system responder on
  somebody's own machine, to tidy an advertisement neither app reads any more,
  and anything else on that Pi wanting IPv6 mDNS breaks silently. So the rule
  above keeps its first half — never publish an address *we* cannot be reached
  at — and stops at what the service owns.
  **Which makes the apps' IPv4 preference load-bearing rather than
  transitional**: it is what actually decides the address, permanently, and
  neither `HubDiscovery.probeParameters()` nor Studio's `resolveParameters` may
  be relaxed on the strength of this. ciao needs only `disabledIpv6`, and there
  the claim does hold, because ciao publishes its own address records.
  `test/mdns-advertiser.test.ts` pins the file, including across a rename,
  since three call sites rewrite it whole.
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
  `test/migrations.test.ts` enforces that, and the journal's invariants with
  it; `-- gethome:destructive: <why>` is the deliberate way past.
  **A migration's drizzle *snapshot* has to be committed with it**, and that is
  now one of those invariants rather than a habit. The snapshots are not read at
  boot, so a missing one breaks nothing until the next person runs
  `db:generate` — and then it breaks badly: `0014_snapshot.json` was never
  committed, so drizzle diffed the schema against `0013` and generated a
  migration that re-emitted `0014`'s three `ALTER TABLE … ADD`s on top of its
  own. On any hub that had already run `0014` that is `duplicate column name`
  at boot, which is a hub that does not start and a rollback that lands on one
  that doesn't either. The SQL was well formed, the journal was complete and
  the file was additive, so nothing else here would have said a word.

## Keep the docs in sync

After landing a change, update the docs it invalidates in the same change:
schema/units/wire → `docs/device-schema.md` (+ the iOS repo needs a matching
change — flag it); routes/auth → `docs/api.md`; adapter behavior/topics →
`docs/zigbee.md` / `docs/matter.md` / `docs/mqtt-integrations.md`; AI
trigger/DSL → `docs/ai-adaptation.md`; a decision question, a threshold or a
consumer of one → `docs/jev.md`; the assistant, the chat runtime or the
delegate registry → `docs/assistant.md`; portraits → `docs/portraits.md`;
module boundaries → this file and the subsystem file for the directory you
changed (`src/ai/CLAUDE.md`, `src/automations/CLAUDE.md`, `src/core/CLAUDE.md`,
`src/adapters/zigbee/CLAUDE.md`, `src/adapters/matter/CLAUDE.md`,
`src/portraits/CLAUDE.md`, `test/CLAUDE.md`, `deploy/CLAUDE.md`) +
`docs/architecture.md`; installer markers, autostart or Zigbee detection →
`docs/zigbee.md` + the marker list in `deploy/install.sh` (and flag the Studio
repo); anything README restates → `README.md`.
