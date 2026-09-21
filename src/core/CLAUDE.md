# `src/core/` — the registry and the services around it

Loaded when Claude works with files under `src/core/`. The root `CLAUDE.md`
carries the rules from here that bind code outside this directory, and every
access and identity rule — roles, sign-in codes, ending a membership — stays
there, because those reach the routes as well. `docs/api.md` and
`docs/architecture.md` are canonical — update them in the same change.

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
- **A device being offline is sometimes the plan, and only a person knows.**
  Somebody unplugs a heater for the summer: the device is unreachable, the home
  is fine, and nothing could say so — so the dashboard counted it, put *Needs
  attention* over the home and went on doing it for four months.
  `PATCH /devices/:id { offlineExpected }` is them saying it, and the device
  carries `offlineExpected: { at, by? }` back. Four rules. **It is the house's**
  — a column on the device row, not a dismissal each phone remembers — because
  one person unplugs the heater and nobody else should go on being told the
  home needs looking at; that is the same split `name` and `roomId` are on, and
  it is why the field sits under `device.edit` while `favorite`, in the same
  body, needs nothing. **It excuses *this* absence, not the device**: the
  registry clears it the moment the device is reachable again, so a socket
  excused in May, plugged back in and pulled out again in September is a new
  thing to be told about. **A radio is not a device**, so
  `radioReachabilityChanged` deliberately does *not* clear it — it speaks for
  everything behind it and is an assumption rather than a report, and Z2M's
  bridge says `online` on every hub restart, which would have wiped every
  excuse in the home overnight on a hub nobody touched; nothing is hidden by
  holding them, since a down radio's devices are already explained by the
  resting-radio rule in both apps and the first real per-device report ends it
  properly. That is what `applyReachability`'s `fromRadio` exists for, and it
  is the only thing it decides. And **one activity row per decision, none for
  the clear** — the device coming back already writes `device.online`.
  `docs/api.md` is canonical.
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
