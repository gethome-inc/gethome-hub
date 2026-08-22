# Zigbee support

Zigbee devices join through [Zigbee2MQTT](https://www.zigbee2mqtt.io) (Z2M)
and a USB coordinator stick. The hub never speaks Zigbee itself — it consumes
Z2M's MQTT interface, which keeps the enormous Z2M device library and tooling
available.

## Which coordinator

Known-good sticks, all of which `zigbee-detect.sh` recognises without help:

- **SONOFF ZBDongle-E** (EFR32MG21) or **ZBDongle-P** (CC2652P)
- **dresden elektronik ConBee II / ConBee III**
- **Home Assistant SkyConnect / Connect ZBT-1**

Others usually work — anything Zigbee2MQTT supports does — but a stick built on
a bare USB-serial bridge (CP210x, CH340, FTDI) cannot be told apart from a 3D
printer or a UPS, so it is offered to you rather than adopted automatically.
See [Finding the coordinator](#finding-the-coordinator).

**Without a coordinator the hub runs Matter, Wi-Fi and MQTT devices only.** On a
Raspberry Pi Zero 2 W there is a second consequence: 512 MB cannot hold Matter
and Zigbee2MQTT at once, so that board runs *one* of them — see
[Zigbee or Matter on a small board](#zigbee-or-matter-on-a-small-board). A Pi 4
or 5 runs both together and never makes the choice.

## Setup

1. Plug the coordinator into the hub machine. **Order doesn't matter** — before
   or after installing the hub, see
   [Finding the coordinator](#finding-the-coordinator).
2. Start Zigbee2MQTT:
   - **Linux/Pi:** nothing to do. `install.sh` installs Zigbee2MQTT and the
     detector; the detector starts the `gethome-zigbee2mqtt` service when a
     coordinator is there and stops it when there isn't — at every boot and on
     every plug or unplug. To pin a specific device (a generic USB-serial
     bridge the detector will never adopt on its own),
     `install.sh --zigbee /dev/serial/by-id/usb-...`. Prefer `by-id` paths:
     `/dev/ttyACM0` moves the moment another USB device appears.

   **The service is installed but not enabled**, and that is the point.
   Zigbee2MQTT is a second full Node.js process — around 150 MB — and on a
   512 MB board, holding that open to wait for hardware nobody has bought is
   memory the hub needs. The detector owns whether it runs.
3. Open the network from the GetHome app (or
   `POST /api/v1/zigbee/permit-join {"seconds":120}`) and put the device in
   pairing mode.

### Finding the coordinator

`deploy/zigbee-detect.sh` is the single authority on which USB device is a
Zigbee coordinator, **and on whether Zigbee2MQTT runs at all**. `install.sh`
installs it as `gethome-zigbee-detect.service`, which runs at every boot and
from a udev rule that fires on any USB serial device appearing *or*
disappearing — so a stick bought two months later starts working the moment it
is plugged in, with nothing for the user to re-run and no reboot.

It classifies a device three ways, and the middle one is the point:

| Verdict | Signal | What happens |
|---|---|---|
| `certain` | the USB product string names a coordinator (`zigbee`, `zbdongle`, `conbee`, `slzb`, `cc2652`, `efr32`, …), or the `vendor:product` id is a coordinator and nothing else (ConBee, CC2531) | `/etc/gethome/zigbee.env` gets the device path and `gethome-zigbee2mqtt.service` is started |
| `maybe` | a generic USB-serial bridge (CP210x, CH340/CH9102, FTDI) — what a Sonoff uses, and also a 3D printer, a UPS, a GPS puck, an Arduino | reported as `@@ZIGBEE_MAYBE:<device>@@`, **never** configured automatically; GetHome Studio offers it for the user to pick |
| `no` | not USB serial, or unknown ids | ignored |

Auto-enabling on `maybe` would hand someone's 3D printer to Zigbee2MQTT, so
it deliberately does nothing instead.

Nothing found means the service is **stopped**, not left waiting. Zigbee2MQTT
is a second full Node.js process; leaving it up against a device node that has
gone is a restart loop, and leaving it up on a board with 512 MB is memory the
hub needs.

The device path is written as a `ZIGBEE2MQTT_CONFIG_SERIAL_PORT` override, never
into Zigbee2MQTT's own `configuration.yaml` — that file holds the network key
and the paired-device list, and rewriting it on a replug would lose the user's
whole Zigbee network.

**Two paths for one stick, and each is used for what it is good at.**
`ZIGBEE_ADAPTER` in `/etc/gethome/zigbee.env` is the stable `by-id` name: it is
our record of *which* device this is, and it survives reboots and replugging.
`ZIGBEE2MQTT_CONFIG_SERIAL_PORT` is the node that name resolves to
(`/dev/ttyACM0`), because that is the only form Zigbee2MQTT's adapter discovery
can match.

Since 1.41 Zigbee2MQTT will not guess an adapter type. With no `serial.adapter`
set it discovers one by comparing the configured port against
`SerialPort.list()`, which reports real device nodes — so a `by-id` path equals
none of them, every port is skipped, and it exits with `USB adapter discovery
error (No valid USB adapter found)` while a correctly identified coordinator
sits right there. Reproduced against zigbee-herdsman 10.8.0 with a real
dongle's port data.

Setting `serial.adapter` would also work and would keep the `by-id` path, and it
is the worse fix twice over: it means keeping a copy of upstream's device table
here, and with a `by-id` path the *options* lookup still misses, so the `rtscts`
some adapters need is silently not applied. Handing over the resolved node lets
upstream identify the stick from its own table, correctly, options included.

The instability `by-id` exists to avoid is handled rather than ignored: the
detector re-runs at boot and on every plug and unplug, `gethome-zigbee2mqtt` is
never enabled on its own so it only ever starts after the detector has written
the current node, and the change check covers both paths — a renumbered node is
rewritten and the service restarted before it can matter.

**One setting is the exception: `onboarding: false`.** Zigbee2MQTT 2.x offers a
browser setup wizard and does not bring the Zigbee stack up until somebody
completes it. On this hub there is nothing for that wizard to ask — the serial
port and the broker both arrive as environment overrides — so what it produces
is a service that is `active (running)`, holds a correctly identified
coordinator, reports nothing wrong, and never pairs anything. The only trace is
one journal line offering a page on port 8080.

The environment override can't carry this on its own: upstream ignores
`ZIGBEE2MQTT_CONFIG_ONBOARDING` when no `configuration.yaml` exists yet
([Koenkk/zigbee2mqtt#32224](https://github.com/Koenkk/zigbee2mqtt/issues/32224)),
which is exactly the fresh install. So `install.sh` sets the variable *and*
puts the setting in the file — creating it if absent, or replacing the single
`onboarding:` line if present. Never a rewrite: the network key and the device
list have to survive. If that change is made while Z2M is running, `install.sh`
restarts it, because the detector only restarts on a changed device path.

**A started service is not a working radio, so the installer asks.** Presence of
a device node only proves something is plugged in, and the detector's success
means "I found a coordinator and started the unit" — neither says Zigbee2MQTT
ever reached the stick. The hub already answers that: `GET /api/v1/hub` carries
`zigbee: {enabled, connected}`, where `connected` is the Z2M bridge saying it is
online rather than the broker merely being up. So after starting the service
`install.sh` polls that for a minute and, if it stays false, emits `@@WARN@@`
naming the journal to read — and drops Zigbee from `@@CAPABILITIES@@`.

That check is not decoration. It is the difference between an install that ends
"this hub can talk to Zigbee" and a hub that pairs nothing: a missing
`ZIGBEE2MQTT_CONFIG_SERIAL_PORT` override, a coordinator on the GPIO header with
the UART still off (`enable_uart=1` plus the Bluetooth swap in `config.txt` —
the one case that genuinely needs a reboot), or a stick that needs its firmware
flashed all leave the unit running and the install "successful". A warning,
never a failure: the hub itself is fine and the coordinator stays configured.

**The identification tables are duplicated** in Studio's
`Models/ZigbeeModels.swift` (`ZigbeeCatalog`), which classifies devices during
the SSH preflight — before this script exists on the machine. Change both
together, or the two will disagree about the same hardware.

### The coordinator's own firmware

Identifying a stick and being able to talk to it are different things, and the
gap between them has one near-universal cause.

A **SONOFF ZBDongle-E ships running EmberZNet 6.10 (EZSP v8)**. Zigbee2MQTT's
`ember` driver needs **EZSP 13 or newer — NCP firmware 7.4.x**. So a brand-new
dongle gets all the way to a working serial link and then refuses:

```
zh:adapter:discovery: Matched adapter=ember path=/dev/ttyACM0, score=4
zh:ember:uart:ash: ======== ASH connected ========
zh:ember:ezsp: ======== EZSP started ========
error: Adapter EZSP protocol version (8) is not supported by Host [13-19]
```

Everything above that last line is the hub working correctly — the stick was
found, identified, opened and answered. Only the firmware is behind.

Flashing is a one-time job and needs no hardware. SONOFF's browser flasher —
<https://dongle.sonoff.tech/sonoff-dongle-flasher/>, the flasher itself and not
the site root — talks to the dongle over WebSerial in Chrome or Edge (Safari
cannot), identifies it, and proposes the current Stable build on its own. The
NCP images are at
<https://github.com/itead/Sonoff_Zigbee_Dongle_Firmware> for anyone who wants
them, but the browser flow never needs that page. Other EZSP coordinators
(SkyConnect, SLZB, Connect ZBT) have their maker's own equivalent; the steps are
the same.

**Never quote the log's numbers as the version to install.** `(8)` and `[13-19]`
are *EZSP protocol* versions. Every flasher shows *firmware* versions instead —
SONOFF's offers `6.10.3 → 8.0.2` for this very stick. Put "needs 13 or newer" in
front of somebody looking at an `8.0.2` and the download they should take looks
like the wrong one. So `install.sh`, the hub's `zigbee.problem` summary, and
Studio's card all say *what to do* and leave both numbers in the raw log line.

`install.sh` matches this case by name rather than pointing at the journal —
the person watching the install is usually on another machine, where "check
`journalctl`" is homework they cannot do.

**The repair path has a trap of its own, and the detector clears it.** A
coordinator with old firmware lets Zigbee2MQTT *start* and then refuses, so
`Restart=always` retries it every `RestartSec` until `StartLimitBurst` is spent —
five failures inside two minutes — and systemd parks the unit in `failed` with
`start-limit-hit`. After that `systemctl start` returns an error instead of
starting anything, until the failure is reset ([systemd.unit(5)][unit]). That is
exactly the state the owner is in when they unplug the stick, flash it, and plug
it back in: the fix worked, the device path is unchanged, and the start would
fail with *"start request repeated too quickly"* on a coordinator that is now
perfectly good. So `zigbee-detect.sh` runs `systemctl reset-failed` before
starting a unit that isn't active. It is not a way around the rate limit — that
exists to stop a *tight* loop, and this script only runs at boot and on USB
events, so reaching that line means the hardware situation just changed.

[unit]: https://www.freedesktop.org/software/systemd/man/systemd.unit.html#StartLimitIntervalSec=

**The hub is not flashing anything, and that is a decision.** Doing it from the
Pi would mean carrying a Python toolchain and a per-device firmware table onto a
415 MB board, writing images to radios nobody here can test, and doing it to
hardware the owner did not ask us to touch — and a bad write bricks the stick or
resets its NVM3, taking the paired network with it. The vendor's own browser
flasher is one cable and one click, it is the tool their firmware is published
for, and it is the user's decision to make. So the hub's job is to *say what is
wrong precisely enough that the fix is obvious*, which is the next section.

### The hub says why the radio is down (`zigbee.problem`)

`install.sh` only names this failure while the install is on screen. An owner
who plugs a coordinator in a month later gets `zigbee.connected: false` and
nothing else, and the reason is in a log on a machine they are not looking at.

The hub can answer this itself, and it needs no privileges to: Zigbee2MQTT
writes `<Z2M data>/log/<timestamp>/log.log` into a directory owned by the same
service account the hub runs as. So `src/adapters/zigbee/diagnosis.ts` reads the
newest run's log (tail only, seeked — these grow without bound), matches it
against the failures worth naming, and `GET /hub` carries the answer as
`zigbee.problem` — see [api.md](api.md#why-zigbee-is-down-zigbeeproblem) for the
wire shape and the `kind` list. Every app gets it, not just the one that
happened to be watching the install.

Four rules hold this together:

- **An unrecognised log yields nothing.** A wrong diagnosis is worse than
  `connected: false`, which the caller already has. Patterns are ordered
  most-specific-first because they co-occur — a stick with old firmware also
  logs the generic "Failed to start zigbee-herdsman" a line later, and only the
  specific one helps.
- **`summary` is a whole sentence written by the hub**, so an app that has never
  heard of a new `kind` still says something true. `kind` is what an app branches
  on to offer a fix.
- **Nothing here may throw.** No Zigbee2MQTT, never started, an unreadable
  directory — all expected, all mean "nothing to say", and none of them may turn
  `GET /hub` (public, the health check) into an error.
- **It is read behind a 30-second cache** and only while Zigbee is enabled and
  not connected. A healthy hub never touches the disk for this, and a broken one
  does not re-read a log for every poll.

### Zigbee or Matter on a small board

A 512 MB board fits the operating system (~70 MB), the hub (~119 MB), and
**one** of Zigbee2MQTT (~150 MB, its own process) or Matter (~60 MB inside the
hub). Not both. Two separate things decide which:

> **Those figures have been measured again, and they are conservative.** On a
> Zero 2 W with the desktop switched off, the memory cgroup finally enforcing,
> and one zram device rather than two, ten minutes after a restart, with no
> devices paired:
>
> | | assumed above | Zigbee only | both radios |
> |---|---|---|---|
> | hub | 119 MB | 56 MB (peak 59) | **139 MB** (peak 144) |
> | Zigbee2MQTT | 150 MB | 80 MB (peak 86) | 64 MB (peak 86) |
> | `MemAvailable` | — | 135 MB | **89 MB** |
>
> Both radios really did run together: `radio.matter: true` beside
> `zigbee.connected: true`, *Matter controller started with 0 commissioned
> node(s)* in the log, `memory.events` reporting `high 0` on both units against
> a 200 MB `MemoryHigh`, no OOM, and 34 MB of swap in use compressed to under
> 10 MB.
>
> **Fifteen hours later, still on both radios and still idle**, it had not
> degraded: `NRestarts` 0 on both units, `memory.events` still `high 0 max 0
> oom_kill 0`, `memory.peak` unchanged at 144 MB and 86 MB, not one warning or
> error in the hub's journal, both radios up. `MemAvailable` had *risen* to
> 172 MB.
>
> **Read why it rose, because it is the whole story.** The pair's own demand
> did not shrink — `rss + swap` was 133 MB for the hub and 90 MB for Z2M,
> within a couple of megabytes of the ten-minute figures. What changed is that
> 150 MB of it had been paged out to zram, where it compresses to 38 MB. So a
> Zero 2 W fits both radios by keeping two thirds of their memory compressed
> and cold, and that only works while it *is* cold: 133 + 90 resident at once,
> beside the OS and the page cache, does not fit in 415 MB.
>
> **So the rule does not move.** A hub with nothing paired is not a working
> home — a Matter fabric and Zigbee2MQTT's database both grow per device,
> Matter's peak is during commissioning rather than at rest, and, above all, a
> home with devices in it generates the steady traffic that keeps the working
> set hot. What is settled is that the budget's *inputs* are too high; what is
> not settled is its answer. Changing it needs this board with devices paired
> and days of real traffic, because being wrong here means hubs that run out of
> memory in people's homes a week after they were installed, which is the
> failure this whole architecture was chosen to avoid.

| | Who sets it | Where it lives | What it means |
|---|---|---|---|
| **Budget** | `install.sh`, from the board's RAM | `GETHOME_RADIO` in `/etc/gethome/hub.env` | `both` (> 1 GB) or `one` (≤ 1 GB). Measured, not a preference. |
| **Mode** | the owner, from the GetHome app | `<data>/radio-mode` | `auto` (default), `zigbee` or `matter`. |

`gethome-zigbee-detect` is where the two meet, because it is the only thing
that knows whether a coordinator is *actually plugged in* — it runs at boot, on
every USB plug and unplug, and at the end of the install:

"Coordinator" below has **three** states, not two, and the third is the one
that matters: *none has ever been set up here*, *one is plugged in*, and *this
hub's coordinator is unplugged right now*. `zigbee.env` tells the first from the
third — it is written the first time a coordinator is identified and is never
deleted.

| Budget | Mode | Coordinator | Result |
|---|---|---|---|
| `one` | `auto` | plugged in | Zigbee runs, `ADAPTER_MATTER=0` |
| `one` | `auto` | never any | Matter runs, Zigbee2MQTT stays down |
| `one` | `auto` | **unplugged** | **nothing changes** — Z2M stops, the board stays where it was |
| `one` | `zigbee` | plugged in | same as `auto` + coordinator |
| `one` | `zigbee` | never any | Matter runs — see below |
| `one` | `zigbee` | **unplugged** | **nothing changes** |
| `one` | `matter` | any | Matter runs; a plugged-in coordinator is recorded but Z2M stays down |
| `both` | `auto` | any | both run |
| `both` | `zigbee` | plugged in | Zigbee runs, Matter off (the owner asked for it) |
| `both` | `matter` | any | Matter runs, Z2M stays down |

**Matter only ever gives way to Zigbee that is genuinely going to run.** That
is the row worth reading twice: `mode=zigbee` with no stick ever plugged in
still leaves Matter on. Reserving the memory for a coordinator that isn't there
is how a hub ends up talking to nothing at all — no Zigbee because there is no
stick, no Matter because we saved the room for one.

**And the mirror of it: follow a coordinator *in*, never follow one *out*.**
Plugging a stick in is an unambiguous instruction, so the detector acts on it
within seconds. Pulling one out is not — it is equally "I've finished with
Zigbee" and "I'll be back in two minutes", and the second is *step one of the
firmware update this project tells people to perform*.

The two guesses do not cost the same. Guessing "finished" rewrites `hub.env` and
restarts the hub — around 70 seconds of a closed port on a Zero 2 W — landing
exactly when the owner is reading the flashing steps off that hub's own page,
which goes unreachable and badges itself Offline while they read it. Then it
restarts a second time when the stick comes back. Guessing "back in a minute"
costs a radio that was not going to work anyway, because the stick is in their
other hand.

So on removal the board stays where it is, Zigbee2MQTT stops (there is nothing
to talk to), and the owner decides in the app with `PUT /settings/radio` — one
button, reversible, already there. The whole flash-and-return trip now costs
**zero** hub restarts instead of two. The cost of the rule is that a hub whose
coordinator is gone for good keeps Matter off until somebody says so; the app
is what says so, and `test/deploy-radio.test.ts` pins every row above.

Applying a mode is root work — editing `hub.env`, starting or stopping a unit,
restarting the hub — and the hub deliberately cannot do any of it. It writes one
word to `<data>/radio-mode`, a file it already owns; `gethome-radio.path`
(`PathModified`) notices and runs the detector, which applies it. So `PUT
/api/v1/settings/radio` records a *request* and returns immediately, the hub
restarts a moment later, and what `GET /api/v1/hub` reports as live comes from
`ADAPTER_MATTER` and the adapters themselves — never from the file.

The hub restarts only when the value really changes. This script runs on every
USB event, and a hub that restarted each time somebody plugged in a phone
charger would be worse than the problem it solves.

Switching costs nothing but the switch: the coordinator's device path stays in
`/etc/gethome/zigbee.env` and Zigbee2MQTT keeps its `configuration.yaml`, so
paired devices come back when the board is handed back to Zigbee. They show as
offline in the app while another radio has the board.

**That last sentence is a thing the hub has to do, not something that follows.**
Reachability only ever arrives *from* a running radio, so a radio that has been
switched off reports nothing at all — and the devices behind it were read back
out of SQLite with the `online` they had when it last ran. They kept it: a home
whose Zigbee half read perfectly healthy and answered no command, which is the
opposite of what switching radios is supposed to look like. So
`DeviceRegistry.start()` marks every device of an adapter that is **not
registered, or failed to start**, offline, through
`AdapterBus.radioReachabilityChanged`. It is the same statement the Zigbee
adapter makes when `bridge/state` goes `offline` — Zigbee2MQTT leaving takes
the whole network with it whether or not the broker noticed — and it is made in
both directions, because Zigbee2MQTT ships with per-device availability
tracking **off**, so a hub that only ever marked devices down would never bring
them back.

On a `both` board none of this normally fires — `auto` runs everything, and the
mode exists there only for somebody who wants a radio off deliberately.

## How the hub uses Zigbee2MQTT

Subscribed topics (base topic `zigbee2mqtt`, configurable via
`Z2M_BASE_TOPIC`):

| Topic | Use |
|---|---|
| `zigbee2mqtt/bridge/devices` | retained device registry incl. `definition.exposes` — the schema source, and the **only** thing that adopts a device |
| `zigbee2mqtt/bridge/state` | Z2M health — and, on each change, the reachability of every device on the radio (see [above](#zigbee-or-matter-on-a-small-board)) |
| `zigbee2mqtt/bridge/event` | a device joining, being interviewed, or leaving — relayed, never acted on |
| `zigbee2mqtt/bridge/info` | the live permit-join window (`permit_join`, `permit_join_end`) |
| `zigbee2mqtt/<friendly_name>` | state payloads |
| `zigbee2mqtt/<friendly_name>/availability` | online/offline |

`bridge/devices` lists a device only once its **interview has finished**, so
without `bridge/event` the whole of pairing — the minute somebody is standing
next to a device holding a paperclip in a reset hole — produced no output at
all. The adapter normalizes those events into the hub's own vocabulary
(`joined`, `announced`, `interviewing`, `interviewed`, `interview-failed`,
`left`) in `src/core/zigbee-events.ts` and emits them on the `zigbee`
WebSocket stream; only the *failure* and the *departure* are also written to
the activity log, because the rest is transient and the adapter already writes
a `zigbee.joined` row once the device is adopted.

### What a new device is called

Zigbee2MQTT names a freshly joined device **after its own IEEE address**, so
`friendly_name` is `0x54ef44100047c1bf` until somebody opens Z2M's frontend and
renames it there — which is exactly the errand this project exists to remove.
Passing it through unchanged is what put eighteen characters of hex on the tile
in the app, reading as a hub that had failed to recognise the device when it had
in fact mapped every one of its exposes.

`suggestedNameFor()` therefore names it from the rest of the same record, in
order: `definition.description` (upstream writes a short human one for every
device it supports — "Smart plug EU"), then `vendor` + `model`, then the address
if the record says nothing else at all. The last four hex digits ride along,
because two units of one model would otherwise be two identical rows with no way
to tell them apart.

It is deliberately **not** the device kind. "Outlet" is already a line of its own
in the apps, and a name repeating it says nothing about *which* outlet this is.

Two names always outrank it: one somebody chose in Zigbee2MQTT, and the owner's
own — `suggestedName` is read on the registry's insert only, never over an
existing row.

Two fields say whether that interview finished, and both are read:
Zigbee2MQTT 2.x replaced the boolean `interview_completed` with the four-valued
`interview_state`, so a version publishing only the new one made
`interview_completed === false` read `undefined === false` and adopted devices
mid-interview with whatever partial definition the bridge had at that instant.

**Everything else on the broker is visible but inert.** `MqttObserver`
(`src/core/mqtt-observer.ts`) subscribes to `#` for the apps' traffic
inspector — including `bridge/logging`, which is where Zigbee2MQTT publishes
its own log — but it is reference-counted, connects only while a client is
watching, writes nothing to disk, and is **not an input to anything**: device
adoption reads `bridge/devices` and the AI mapper reads a device entry, and
neither can see this. See `docs/api.md` ("Opt-in streams") and
`docs/ai-adaptation.md` ("What can reach the agent, and what cannot").

Published topics:

| Topic | Use |
|---|---|
| `zigbee2mqtt/<friendly_name>/set` | commands (translated from canonical intents) |
| `zigbee2mqtt/<friendly_name>/get` | state refresh after join |
| `zigbee2mqtt/bridge/request/permit_join` | open/close the network, `{"time": <0–254>}` |
| `zigbee2mqtt/bridge/request/device/remove` | forget a device |

### The join window is several grants

A permit-join duration travels as a **uint8 of seconds**, so 254 is the most a
single grant can last — a fact about the Zigbee protocol, not about
Zigbee2MQTT. `PermitJoinService` (`src/core/permit-join.ts`) makes a longer
window out of repeated grants, sizing the last one to expire *on* the deadline
rather than past it: a window that stayed open for three minutes after the
countdown the owner was shown reached zero would be worse than not offering one.

Zigbee2MQTT is the authority, not that timer. `bridge/info` reports what the
coordinator is actually doing, so a window opened from Z2M's own UI is adopted
and a `permit_join: false` newer than our last grant closes ours whatever we
intended — it knows about restarts and radio failures and the hub does not. It
fails closed: a hub that restarts mid-window leaves at most one grant running
and nothing renews it.

Devices are keyed by IEEE address, so Z2M friendly-name changes don't
duplicate devices. The hub keeps its own device names — it never renames
devices inside Z2M. A device whose exposes definition changes (firmware or
Z2M update) is re-adopted automatically — the adapter fingerprints the
definition on every `bridge/devices` sync.

## The three layers of device support

**The guiding principle: nothing is unsupported by default.** A Zigbee device
is made usable by three layers, tried in order — the first two are static (no
API key, no cost, instant), the third fills genuine gaps. Preserve this
model when editing the mapper; it is *why* leftover parameters must never be
silently dropped.

1. **Typed capabilities** *(static)* — devices that fit the canonical schema
   map to their exact capability: lights, plugs, switches, sensors, locks,
   covers, climate, fans, buttons (`event`), IR blasters (`irRemote`). This is
   the richest, most first-class experience. (The mapping detail below.)
2. **Generic custom fields** *(static, the universal fallback)* — **every
   other exposed parameter** becomes a controllable generic field
   (`custom` capability), generated from the expose's own Z2M metadata:
   `binary` → toggle (translating the device's own on/off vocabulary, e.g.
   `LOCK`/`UNLOCK`), `enum` → select with options, ranged `numeric` → slider
   with unit/min/max/step, anything else → a read-only readout. Settings that
   used to be discarded — child locks, presets, sensitivities, indicator LEDs,
   power-on behaviour, vendor knobs — are now adjustable. Only pure telemetry
   (linkquality, radio voltage, `action_*` sidecars) stays hidden. So a device
   is **never "unsupported" just because one of its knobs has no dedicated
   capability.**
3. **AI adaptation** *(bring-your-own-key, [ai-adaptation.md](ai-adaptation.md))* —
   reserved for the genuine gaps layer 2 can't hold: a parameter with **no
   representation at all** (`uncovered` — composites/lists, or a device Z2M
   barely supports), or an explicit remap. The AI can **declare custom fields
   itself** (making even a schema-less device controllable) and can **upgrade**
   a generic field to a richer typed capability on demand. Without a key,
   layers 1–2 still make the device work.

A device only carries `needsReview: true` when something is still `uncovered`
after layers 1–2 — i.e. genuinely nothing but AI can represent it.

## Exposes → canonical schema (layer 1: typed capabilities)

`src/adapters/zigbee/exposes-mapper.ts` statically maps Z2M's
[exposes](https://www.zigbee2mqtt.io/guide/usage/exposes.html) into canonical
capabilities. Aqara devices are the tuning baseline — their sensors, buttons,
remotes, cubes, relays and curtain drivers map fully with no AI round-trip.
Highlights (full unit table in [device-schema.md](device-schema.md)):

- `light`: state → `onOff`; brightness (0–254) → `level` (clamped to 1);
  color_temp (already mireds, expose min/max honored) → `colorTemperature`;
  color_hs/xy → `color` (hue° → 0–254, sat% → 0–254)
- `switch` → `onOff` (kind `outlet` for metering/plug singles, `wallSwitch`
  for bare relays and every multi-gang module)
- `cover`: position **0–100 where 100 = open** → canonical percent-100ths
  where **0 = open**: `percent100ths = (100 − position) × 100`; a
  `running`/`moving` flag folds into `covering.isMoving` (only alongside a
  position — a moving flag alone isn't wire-valid)
- `lock`: `lock_state` locked/unlocked/not_fully_locked → 1/2/0
- `climate`: `local_temperature`/setpoints °C → centi-°C; expose min/max →
  setpoint limits; `system_mode` off/auto/cool/heat → 0/1/3/4
- sensors: temperature ×100, humidity ×100, pressure (hPa), battery (direct),
  power W → mW, energy kWh → mWh, occupancy, **presence → occupancy** (Aqara
  FP1/FP2), contact (true = closed), water_leak → contact (inverted),
  smoke/carbon_monoxide → alarm 0/2, pm25, co2
- **`action`/`click` enums → the `event` capability**: the flat action
  vocabulary ("single", "double_left", "button_3_hold", "flip90") is parsed
  by `src/adapters/zigbee/actions.ts` into a button inventory
  (`event.buttons`, seeded as state at adoption) plus per-press
  `event.{action,button,gesture,at}` patches. Pure senders get kind `remote`.
- **IR blasters → the `irRemote` capability**: the three standard Zosung/Tuya
  properties (`learn_ir_code`, `learned_ir_code`, `ir_code_to_send`) map to a
  learn-and-replay library. See below.

Everything a typed handler doesn't claim falls through to **layer 2** (generic
custom fields, below); pure diagnostics (linkquality, radio voltage,
`action_*` sidecars, cube side telemetry…) are *known but ignored* — noise,
never shown, and they never trigger the AI.

### Multi-endpoint devices

Every Z2M endpoint label (`l1`/`l2`, `left`/`right`) becomes a canonical
endpoint, numbered 1..N in exposes order; unlabeled ("whole device") exposes —
battery, power, actions — attach to endpoint 1. Commands address channels by
their suffixed property (`{"state_l2": "ON"}` to `<friendly_name>/set`).

### IR blasters (learn + replay)

Universal IR remotes (Aubess ZXZIR-02, Tuya ZS06 and the wider Zosung family)
expose exactly three properties: `learn_ir_code` (SET, enter learn mode),
`learned_ir_code` (STATE, the captured blob), and `ir_code_to_send` (SET,
transmit a blob). They map to the `irRemote` capability
([device-schema.md](device-schema.md)):

- The **static mapper** declares `irRemote` (kind `remote`) and turns an
  incoming `learned_ir_code` into `irRemote.pendingCode`. The two SET-only
  properties are recorded as command targets, never as unmapped parameters.
- The **learned-code library is owned by the registry**, not the adapter,
  because it lives in endpoint state (persisted): `irSaveLearned`,
  `irDeleteCommand`, `irRenameCommand` mutate it; `irSend {commandId}` resolves
  the opaque blob and hands it to the adapter as the internal `irSendRaw`,
  which the adapter publishes as `{"ir_code_to_send": "<blob>"}`; `irLearn`
  publishes `{"learn_ir_code": "ON"|"OFF"}`.
- Because the whole flow maps statically, IR blasters need **no AI key** and no
  `needsReview`.

## Layer 2: generic custom fields

`makeCustomField` / `handleLeftover` in the exposes-mapper turn **every**
exposed property a typed handler didn't claim into a declared generic control
(the `custom` capability), from the expose's own metadata:

| Z2M expose | Generic control | Notes |
|---|---|---|
| `binary` | `toggle` | on/off translate through the expose's `value_on`/`value_off` (e.g. `LOCK`/`UNLOCK`); `settable` gates interactivity |
| `enum`, settable | `select` | `values` → options |
| `numeric`, settable, with `value_min`/`max` | `slider` | carries `unit`, `min`, `max`, `value_step` |
| `numeric` (no range), read-only `enum`, `text` | `value` | read-only readout |
| `composite` / `list` | — | can't be a generic field → `uncovered`, layer 3's job |

(`settable` = the expose's access bit 2; the `value` control is always
read-only.)

The field `id` is the device's own payload property; values read straight from
it, and `setCustomField {fieldId, value}` writes back (see
[device-schema.md](device-schema.md)). Settings (`SETTINGS_PROPERTIES` — child
locks, presets, sensitivities, indicator LEDs, power-on behaviour, calibration,
timeouts…) map to fields but never trigger the AI; there is no typed capability
to upgrade them to. Only `IGNORED_PROPERTIES` (pure telemetry) produce nothing.

## Layer 3: AI adaptation (the genuine gaps)

Because layers 1–2 make almost everything usable, the mapping agent
([ai-adaptation.md](ai-adaptation.md) — an autonomous researcher running as a
tool-use loop on the Anthropic Messages API, with the owner's own API key) is
reserved for real gaps:

- a property with **no representation at all** (`uncovered` — composites/lists,
  or a device Z2M barely supports), or nothing mapped → auto-trigger;
- an explicit `POST /devices/:id/remap` to **upgrade** generic fields to typed
  capabilities (e.g. a value field → a real `humidity` sensor), or to have the
  AI declare fields for shapes the static mapper couldn't.

A device only carries `needsReview: true` while something is `uncovered`.
Properties already covered by a generic field never auto-trigger the AI.

The adapter also watches **runtime payloads**: it keeps the last 3 state
payloads per device, and a payload key that neither the exposes nor an
existing AI mapping declares triggers a one-time, debounced AI remap grounded
in those samples. Each unknown key is asked about at most once per run.

When the owner's account is temporarily unusable (rate limit, exhausted
account cap, bad credentials…) the mapper backs off instead of
retrying — devices keep their static mapping and the reason is surfaced on
`GET /settings/ai` as `status.lastError` (see
[ai-adaptation.md](ai-adaptation.md) → taxonomy & backoff).

## Runtime external converters

Z2M supports loading converters for unsupported devices at runtime via
`zigbee2mqtt/bridge/request/converter/save`. The AI pipeline may use this in a
future iteration to teach Z2M itself about brand-new devices; today the AI
mapping operates purely on the hub side.
