# `deploy/` is a contract, not just scripts

Loaded when Claude works with files under `deploy/`. The root `CLAUDE.md`
carries the four rules from here that have a `src/` half. `deploy/` has no
type checker behind it, so CI runs `shellcheck -S warning` over every script
here — and keep it portable to BSD userland and **bash 3.2**, because
`test/deploy-*.test.ts` run the real functions on whatever the contributor
has. `docs/zigbee.md` is canonical for detection and markers; the marker list
in `deploy/install.sh` must stay accurate.

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
  **And the journal is the other half, because drizzle gates on `when` and never
  on the hash.** `SQLiteSyncDialect.migrate` reads the newest `created_at` out
  of `__drizzle_migrations` once and runs every migration whose `when` is
  greater, so a migration that is **renamed is a migration it has never seen**,
  byte-identical or not. That matters because renaming is not optional: two
  branches each add an `0012`, one lands first, and the other has to be
  renumbered on the merge — and git says nothing about it, since the two `.sql`
  files have different names and merge without a conflict, leaving a repository
  with two migrations claiming one index. `test/migrations.test.ts` now asserts
  the journal's four invariants (indices 0…n−1 once each, `when` strictly
  increasing, a file per entry and an entry per file), which is what says so.
  **The cost lands on hubs that installed the branch under the old number** —
  every hub `--branch` was tested on, which is the whole point of branch
  bundles. They already have the change and meet it again as a new migration:
  `duplicate column name`, the hub exits 1, and the installer's rollback is the
  only thing that saves the evening. The repair is to **record it as applied
  rather than re-run it** — one row into `__drizzle_migrations` with the new
  migration's `when` (the `hash` column is written but never read, so use the
  real `sha256` of the file) — after checking the schema really does already
  carry the change. Two shortcuts are wrong and both look right: giving the
  renumbered migration its *old* `when` fixes the test hub and silently skips it
  on every hub already past that point, and teaching the boot path to drop an
  `ADD COLUMN` whose column exists puts cleverness in the one code path whose
  failure costs a rollback, while masking a migration that is genuinely wrong.
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
- **Zigbee and Wi-Fi are one band, and upstream's default channel is inside the
  commonest Wi-Fi channel there is.** 802.15.4 channels 11–26 are 2 MHz wide and
  5 MHz apart from 2405 MHz, a 20 MHz Wi-Fi channel is its centre ±11 MHz, so
  Zigbee2MQTT's default of 11 (2405 MHz) sits inside Wi-Fi channel 1 — with the
  coordinator on the Pi's USB socket and the Wi-Fi antenna printed on the board
  beside it. **What it costs is retries and throughput, in
  proportion to how busy the Zigbee side is**, and the size is the part worth
  writing down: a Zigbee frame is tens of bytes at 250 kbit/s, so a quiet home
  is a fraction of a percent of the air and the collision costs almost nothing,
  while a power meter reporting every few seconds costs progressively more. It
  is a standing handicap on the Wi-Fi, **never an explanation for a hub that
  disappears outright** — that is a link that is down or a path that is broken,
  and mistaking one for the other sends a whole evening after the wrong radio.
  Avoiding it is free before the network exists and expensive after, which is
  the whole reason it is decided at install time. `install.sh` picks the
  channel furthest from whatever Wi-Fi channel the hub is associated on, 26
  excluded (regions cap its power, some devices will not join it) and 25 as the
  answer when there is no Wi-Fi to measure. **Only when this hub has never
  formed a network**, though — no `configuration.yaml` and no
  `coordinator_backup.json` — because moving the channel of a home that already
  works is not an upgrade: routers follow, sleepy end devices do not, and the
  home wakes to a list of things to pair again. And a hub that already
  has a network is **told rather than moved**: the installer compares the two
  and emits a `@@WARN@@` naming both channels, the one to move to and what
  moving costs, because nothing else in the system will ever say it —
  `zigbee.connected` is `true`, the devices report, and the casualty is the
  other radio.
  **Once, though, not on every update.** `gethome-hubctl update` *is*
  `install.sh`, and `update-runner.sh` collects `@@WARN@@` into `status.json`,
  which the hub serves and the iOS app draws on its update checklist — so
  without a memory this is ninety words about radio physics in front of
  somebody every time they update a working hub, about the one thing they
  cannot act on without re-pairing their battery devices. That is
  `zigbee.problem`'s rule pointed at a message that is *true*: worth hearing,
  worthless heard eleven times. `zigbee_notice_file` remembers it, keyed on the
  **pair** — which Zigbee channel against which Wi-Fi frequency — so a router
  moved to another channel or a network re-formed is said again, since it may
  have become worse or gone away and the sentence names both. And a collision
  that clears **forgets**, so one appearing later is announced afresh rather
  than swallowed by a note about the last one. `zigbee.env`'s idiom, with the
  one difference that this memory is allowed to be deleted.
  `docs/zigbee.md` is canonical.
- **A Pi's journal lies about its own first minute, and the hub says the one
  number that cannot.** There is no RTC on any board this runs on, so the
  machine boots into whatever `fake-hwclock` saved at the last shutdown and
  `systemd-timesyncd` corrects it seconds later — which means every wall-clock
  timestamp before `Initial clock synchronization` is off by however far behind
  that saved time was, and the correction reads as a gap where nothing happened.
  Measured on a Zero 2 W: `Started gethome-hubd` to the hub's first log line
  read as **4 minutes 39 seconds** in `journalctl`'s default output and was
  **17.3 seconds** in `-o short-monotonic`, with the API listening 64 s after
  power-on. The whole machine appears to stall and resume together, which is
  the tell — a hub that was genuinely slow would be slow alone. So read a boot
  with `-o short-monotonic`, and note that the hub itself now reports
  `(17.3s to load)` beside its version: everything before that line is the
  module graph, it is the longest single step in a start on a small board, and
  `process.uptime()` is the only clock in the building that does not jump.
- **`Storage=auto` is not persistence, and a hub that cannot remember
  yesterday cannot be diagnosed.** systemd reads it as "persist if
  `/var/log/journal` exists", and on the Pi this was found on that directory
  existed and was **empty** — journald had never adopted it, so everything the
  machine logged lived in `/run` and went with every reboot. What that costs is
  precise: a hub that went unreachable on Tuesday and recovered by itself has
  no record of Tuesday left by Wednesday, and `journalctl --list-boots`
  answering with one boot is the only sign. `install.sh` states
  `Storage=persistent` rather than inferring it, creates the directory and
  flushes — the drop-in alone leaves the logs where they were — and bounds it
  at 64 MB, because journald sizes itself at 10% of the filesystem and that is
  six gigabytes of SD-card writes on a 64 GB card. This is the one place the
  card's write budget is spent on something nobody reads until it matters:
  every other bound here (`STATE_FLUSH_MS`, the activity log's two, the history
  buckets) exists to *stop* writing, and this one exists because the alternative
  is a support question with no evidence behind it.
- **The hub's Wi-Fi must not doze, and the failure it causes is why this is in
  the installer rather than in a troubleshooting page.** 802.11 power save is on
  by default on the Pi's brcmfmac (`brcmf_cfg80211_set_power_mgmt: power save
  enabled`, in every Pi's kernel log), and a hub is the worst possible traffic
  pattern for it: nobody talks to the machine for hours, and then a phone opens
  the app. What comes out the other side is a hub that is *up* and unreachable —
  the board running, the coordinator running, a motion rule switching the hall
  light on, and both apps saying the hub cannot be reached. **It takes SSH with
  it**, which is the half that misleads: an owner who cannot reach port 8420
  *or* port 22 concludes the hub has crashed, and every measurement taken
  afterwards (memory, restarts, `MemoryHigh`, disk) comes back clean, because
  nothing was ever wrong with the hub. The one fact pointing the right way is
  that the automations kept running, and nobody looks at that while the app says
  "can't reach". `keep_wifi_awake()` turns it off on the interface carrying the
  default route, and a wired hub gets no unit, no dispatcher and nothing said
  about it. Four rules. **Off now *and* off later**: NetworkManager re-enables
  it on every association, so the live `iw` call is only half the fix — the
  other half is a dispatcher script, which covers every wireless profile the
  machine ever grows where writing `802-11-wireless.powersave` into today's
  profiles would miss the one a home creates when it retypes its Wi-Fi password
  next month; a machine with no NetworkManager gets a unit bound to the device
  instead. **Ask the radio, never the write** — a driver with no support for the
  call answers success and changes nothing, so the outcome is read back with
  `get power_save` and an unverified one is a `@@WARN@@`, the `service_failure`
  rule one layer down. **A radio is recognised by either sysfs marker** —
  `wireless/` is the wireless-extensions directory and `phy80211` is cfg80211's
  own link, and a driver built without the extensions has only the second;
  asking for the first alone reads as "this hub is wired", which is the one
  answer that is deliberately silent, so such a board would keep dozing behind
  a clean install log. **The interface is the one carrying the default route**,
  which provably exists at that point in the install (the bundle was just
  downloaded over it), so nothing has to guess between a LAN interface and one
  in AP mode. And the paths are overridable (`GETHOME_NET_DIR`,
  `GETHOME_NM_DISPATCHER`, `GETHOME_WIFI_UNIT`) for the reason `GETHOME_CMDLINE`
  is — `test/deploy-wifi.test.ts` runs the real function against files it owns,
  including running the dispatcher the way NetworkManager runs it.
- **The hub has to announce itself, by broadcast, or it goes unreachable after
  a quiet spell.** This is the fault the outage reports were, and what named it
  was the shape rather than any counter: a continuous one-per-second ping from
  a Mac on the same Wi-Fi held the hub reachable for **fourteen minutes with no
  loss at all**, twenty minutes after that same hub had been unreachable for
  four minutes at a stretch. Traffic prevented it; quiet caused it — which is
  the owner's whole experience, since an app opened after a while *is* a path
  that has been silent.
  **What goes quiet is one pair.** The Mac is on 5 GHz and the hub's radio on
  2.4 GHz, so their traffic crosses the bridge between the two radios inside
  the router, and it is this hub's entry on that bridge which ages out. Nothing
  on the hub is wrong and everything on it says so: during one of these it
  answered its own health check in 3 ms, exchanged pings with the gateway
  throughout, and served *another* client 37 KB inside one 20-second window,
  while three pings from the Mac got nothing and `rx_bytes` did not move by one
  of them. **A hub that is unreachable from one client and serving another at
  the same second is not a hub with a problem** — which is why every
  measurement taken on it came back clean, twice, before this was found.
  **A unicast to the gateway does not fix it, and shipping one is how that was
  learned.** Those frames are addressed to the router itself and are consumed
  by it; they never cross the bridge they were meant to keep warm. A
  **gratuitous ARP is broadcast** (`arping -U`), so it is flooded to every
  segment and refreshes the access point's forwarding table on both radios and
  every client's ARP cache in one frame of a few dozen bytes.
  `keep_wifi_reachable()` sends one every 20 seconds, re-reading the interface
  and address each round so a moved lease does not leave it announcing an
  address it no longer has, with the gateway ping kept beside it because it
  costs nothing and keeps the hub's own default route fresh. A wired hub gets
  none of it. Measured with the path deliberately idled for 55 seconds between
  every probe, which is the condition the fault needs: **252 probes over four
  hours, 503 of 504 replies, one lost packet**, against a gateway control that
  lost none — where the same probe before it found multi-minute blackouts.
  **Note what this rules out, because two earlier fixes were argued from it.**
  ICMP is answered by the kernel, so a hub that will not answer a ping is not a
  hub with a paged-out or busy userspace and no amount of `MemorySwapMax`
  reaches it; and the hub exchanging traffic with the gateway throughout rules
  out its own radio, its power save and anything the *hub* buffers. Those two
  fixes are real and stand on their own measurements. Neither was this.
- **A Matter accessory out of its box needs Bluetooth, and a Raspberry Pi ships
  with it off.** A factory-new — or factory-reset — Wi-Fi Matter accessory
  advertises over BLE and nowhere else: it has no network to be found on yet.
  Without this the hub could only take in accessories already on the LAN, which
  is a minority of what people buy, and the app searched the network for a
  device that was never going to be there. Two things stand between a Pi and
  working Bluetooth and **both are invisible from every surface the product
  has**. Raspberry Pi OS's headless image leaves the radio **soft-blocked in
  rfkill**, where `hciconfig` lists the adapter perfectly happily and bringing
  it up fails with an errno nothing logs — found on a Zero 2 W, where `soft=1`
  was the whole of it. And noble reaches the controller over a **raw HCI
  socket**, so the unit carries `AmbientCapabilities=CAP_NET_RAW CAP_NET_ADMIN`
  with a matching `CapabilityBoundingSet` (without the second line systemd
  drops them before the ambient set is applied and the radio silently finds
  nothing, exactly as with no capabilities at all). Ambient rather than `setcap`
  on `node`, which would hand raw sockets to every script anybody ever runs with
  that binary. `matter_bluetooth()` writes the sysfs byte rather than shelling
  out to `rfkill`, which is not on a minimal image, and enables `systemd-rfkill`
  because an unblock does not survive a reboot on its own. **A machine with no
  adapter is silent** — a Pi with the radio off in `config.txt`, a VM, an x86
  box are ordinary machines, the hub reports it on `GET /hub` and the app
  explains it; a warning there would fire on every such install.
- **The other half of Bluetooth is the network the accessory is then given, and
  the hub is *given* it rather than reading it.** Commissioning a Wi-Fi
  accessory over BLE ends in `AddOrUpdateWiFiNetwork(ssid, credentials)`, so a
  hub that can do the first half and not the second starts a pairing it cannot
  finish. The PSK is in a root-owned NetworkManager profile and the *point* of
  the service account is that it cannot read one — so `deploy/wifi-credentials.sh`
  writes `/etc/gethome/wifi.env`, mode 0640, group `gethome`, and the hub reads
  the one file it is deliberately allowed to read. That is a real widening
  bounded to exactly that account and that file, and the app may send a password
  instead for a hub that has none. **The dispatcher is what keeps it true**:
  `keep_wifi_awake`'s reasoning exactly — a home that retypes its Wi-Fi password
  next month gets a fresh profile, and enumerating today's profiles is the one
  thing that cannot cover that. **An open network writes an empty PSK**, which
  the hub reads as "no credentials": an accessory handed an empty password for a
  network it cannot join is worse than being told the hub has none. And the
  shell-quoting is built into a variable before it is used, because inline
  inside the `printf` the replacement's backslashes go through a second round of
  quote removal and `Dave's Wi-Fi` comes out mangled — the sed-program rule from
  `test/deploy-wifi.test.ts`, in a second place.
- **The detector exits 1 for an ordinary state, so the unit says
  `SuccessExitStatus=1`.** "Zigbee is not the radio here" — no coordinator, or
  one plugged into a board the owner has set to Matter — is correct and
  expected, and `install.sh` reads the exit code to decide what to tell the
  user, so the code stays. But systemd parks a non-zero oneshot in `failed`, and
  `gethome-zigbee-detect.service: failed` is exactly what somebody finds when
  they go looking for why their Zigbee is quiet: it points at the detector
  instead of at the radio switch they used. The installer's own closing line had
  the same bug in words — "with no Zigbee coordinator plugged in" printed four
  lines under the detector's "A Zigbee coordinator is plugged in", on one
  screen, about hardware the owner could see. `ZIGBEE_STANDING_BY` is the third
  state neither `ZIGBEE_CONFIGURED` nor `ZIGBEE_READY` covers.
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
  **And the hub is not where that headroom comes from** (`MemorySwapMax=0`).
  The sentence above — the board affords both radios by keeping two thirds of
  them cold — is true and is also the whole of a fault that reads as a dead
  hub. The kernel spends swap on whatever has been idle longest, and on a hub
  that is the hub: nobody asks it anything for hours, so its heap and its JIT
  code go into zram, and Raspberry Pi OS's own `rpi-zram-writeback` then moves
  the idle part of that onto the SD card. Then a phone opens the app. Measured
  on a Zero 2 W up 38 hours: hubd resident 35 MB with **55 MB of itself in
  swap**, Z2M resident 24 MB with 83 MB in swap, 25 MB of the pair written back
  to the card — with **110 MB of RAM free** and the board at 0% CPU. Nothing
  needed that memory. Waking it is ~14 000 single-page faults (`vm.page-cluster`
  is 0, so no readahead amortises them), zstd on a 1 GHz A53, and 4 KB random
  card reads for the written-back part; the iOS app gives `GET /hub` four
  seconds. What that costs is the *first request* after a quiet spell — seconds,
  against an app that waits four — and it is worth fixing on its own terms.
  **It is not what makes a hub unreachable, and reading it that way cost two
  rounds of this branch.** ICMP is answered by the kernel, so a hub that will
  not answer a ping is not one whose userspace has been paged out; during a
  real outage this hub answered nothing at all, ping included. That is the
  quiet-path fault above (`keep_wifi_reachable`), and it is a different thing
  that looks identical from an app — which is the whole trap. So the hub's
  memory is pinned and **everything else keeps the swap**: Z2M is the optional
  process (its hard `MemoryMax` and +500 OOM score already say so) and the page
  cache — 243 MB of `node_modules` read once at startup — is what should be
  reclaimed instead. It costs the board the hub's real working set resident,
  ~139 MB against a 200 MB `MemoryHigh`, which is the number the budget above
  was written around anyway. cgroup v2 only, and inert wherever the memory
  controller is still off — the `MemoryHigh` caveat exactly, and the same
  reason `OOMScoreAdjust` sits beside it. **`vm.swappiness` stays at 100**:
  with the hub exempt, the aggressive setting now applies only to the things
  that should be paying, so lowering it would take headroom from Z2M to buy
  nothing.
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
