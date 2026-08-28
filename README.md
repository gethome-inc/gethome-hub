# GetHome Hub

A local smart-home hub that brings **Matter**, **Zigbee** (via Zigbee2MQTT), and
**MQTT** devices together behind one clean, typed device schema — and makes the
home shareable with family members. It runs on a Raspberry Pi or any 64-bit
Linux machine, entirely on your LAN: no cloud account, no data leaving your
network.

GetHome Hub is the heart of a *hub home* in the [GetHome iOS app](https://github.com/gethome-inc/gethome-ios):
devices attach to the hub instead of a phone, so everyone with access to the
hub can control them.

## What it does

- **Matter controller** — commissions Matter devices onto the hub's own fabric
  (matter.js) and controls them over IP.
- **Zigbee** — pairs any Zigbee device through [Zigbee2MQTT](https://www.zigbee2mqtt.io)
  and a USB coordinator stick; device definitions ("exposes") are translated
  into the canonical schema automatically — including buttons/remotes/cubes
  (as structured button events) and multi-channel relays (as separate
  endpoints). ([docs/zigbee.md](docs/zigbee.md))
- **MQTT integrations** — a simple public convention for wiring DIY hardware,
  wired controllers, and third-party bridges into the hub
  ([docs/mqtt-integrations.md](docs/mqtt-integrations.md)).
- **AI device adaptation** — unknown devices, and unknown parameters a
  device starts publishing later, are mapped into the schema by an
  autonomous mapping agent: it reads the device's published schema,
  researches it on the web (starting from the device's own Zigbee2MQTT
  page), and submits a validated mapping (bring your own Anthropic API key;
  stored encrypted on the hub, used only for this). No credential → devices
  still appear, flagged "needs review". It can be switched off without
  deleting the key, every run is recorded (what it searched for, what it read,
  what it cost), and the answers are a **library** you can download from one
  hub, upload to another, or write yourself — a schema the hub can't use comes
  back with the reasons and can be handed to the agent to repair.
  Only a device's own published description is ever sent; the hub's traffic is
  structurally incapable of reaching the agent.
  ([docs/ai-adaptation.md](docs/ai-adaptation.md))
- **One schema for everything** — 27 capabilities (including button/remote
  events, learn-and-replay IR blasters, and a universal generic-control
  fallback so *any* device parameter is usable), 16 device kinds, exact unit
  conventions shared with the GetHome apps ([docs/device-schema.md](docs/device-schema.md)).
- **Recorded readings** — temperature, humidity, air quality, power and the
  rest are kept in five-minute buckets for a week, so an app can show what the
  last hour or the last few days actually looked like. At most one row per
  bucket rather than one per report, and a bucket nothing reported in writes
  nothing at all — which is what keeps a week of an ordinary home to a megabyte
  or two on an SD card. A device that goes quiet leaves a real hole rather than
  a flat line.
  ([docs/api.md](docs/api.md#recorded-readings-get-devicesidhistory))
- **Sharing built in** — pairing-code claim makes you the owner; short-lived
  invite codes add family members. Only hub homes are shareable in GetHome.
- **Roles and permissions** — Owner, Member and Guest ship built in, a home can
  add its own, and what each one may do is a table edited from either app. A
  Guest works the lights and keeps their own favorites without touching the
  home's names, its network or anybody else's activity. The defaults reproduce
  exactly what the hub did before roles existed, so updating changes nothing
  until somebody edits the matrix. See [docs/api.md](docs/api.md#roles-and-permissions-in-full).
- **Control it from an AI assistant (MCP)** — the hub speaks the
  [Model Context Protocol](https://modelcontextprotocol.io), so Claude Code,
  Claude Desktop or Codex can see the home and work it: "is the back door
  locked?", "turn the kitchen light down to 30%". Off until you switch it on,
  and every connection is a token you mint and can revoke, each one either
  read-only or allowed to control. Tools speak ordinary units — percentages,
  °C, kelvin — never the wire's, and a command reports whether the device
  actually confirmed it rather than merely that it was sent. Everything an
  assistant does appears in the home's activity by name. It is LAN-only like
  the rest of v1, which matters when choosing a client: assistants that run on
  your own machine reach it directly, while ChatGPT and claude.ai in a browser
  call connectors from *their* servers and need a tunnel.
  ([docs/mcp.md](docs/mcp.md))
- **Local REST + WebSocket API** ([docs/api.md](docs/api.md)) and mDNS
  discovery (`_gethome._tcp`). Apps can watch the hub's own MQTT broker live —
  every Zigbee signal passes through it — plus the Zigbee pairing timeline and
  the mapping agent's work. Those streams are opt-in and reference-counted, so
  a hub nobody is inspecting opens no broker tap, and none of that traffic is
  ever written to the SD card.

Remote access (control away from home through a relay) is planned; v1 is
LAN-only by design.

## Required hardware

### The computer

A **64-bit** system is required, and the board's memory decides what the hub can
run on it.

| | Board | What you get |
|---|---|---|
| **Recommended** | Raspberry Pi 5, Pi 4 (2 GB or more) | Everything: Matter, Zigbee, MQTT, room to spare |
| **Tested, with one limit** | Raspberry Pi Zero 2 W (512 MB) | Matter, Wi-Fi and MQTT, **or** Zigbee — one radio at a time, see below |
| **Should work, not routinely tested** | Pi 3 / 3B+, 400, 500, CM4, CM5, and any other 64-bit ARM or x86-64 Linux machine | Everything above 1 GB; one radio at a time at 1 GB or below |
| **Cannot work** | Pi 1, Pi Zero, Pi Zero W | Nothing — these are ARMv6, and Node.js has published no ARMv6 build since Node 12 |

The tested operating system is **Raspberry Pi OS Lite (64-bit)**. Debian and
Ubuntu on arm64 work too; they are simply not what we test against.

The desktop version of Raspberry Pi OS works as well, and on a 512 MB board it
is worth knowing what it costs: measured at about 75 MB on a Zero 2 W with
nothing plugged into its HDMI — more than the hub's whole Matter support, on the
one board that already has to choose between radios.

**Lite is easy to miss, and missing it is the ordinary mistake.** Raspberry Pi
Imager opens on an entry called *Raspberry Pi OS (64-bit)*, marks it
**Recommended**, and keeps Lite one level down under *Raspberry Pi OS (other)*,
where it is called *Raspberry Pi OS Lite (64-bit)* — the two names are one word
apart, and only the second one is without a desktop. The installer says so when
it finds a desktop on a small board, and names the single command that turns it
off; GetHome Studio says so before the card is written.

**A 32-bit system is refused, even on a 64-bit board.** Writing the 32-bit image
to a perfectly good Zero 2 W or Pi 4 is an easy mistake and an expensive one —
the Pi boots, the install runs for minutes, and only then finds there is nothing
published for it. Both the installer and GetHome Studio stop first and say that
the *card* needs rewriting, not that the Pi is wrong. Studio checks the card
before it writes anything at all.

### The Zigbee coordinator

A USB Zigbee coordinator is what lets the hub pair Zigbee devices — bulbs,
sensors, buttons, the great majority of affordable smart-home hardware.

**If you want one recommendation: the SONOFF ZBDongle-E.** It is the coordinator
this hub is developed against — the stick in the Zero 2 W that the installer,
the detector and the one-radio switch are exercised on — so it is the hardware
that has had the most chances to go wrong here and be fixed.

> **A new ZBDongle-E needs its firmware updated once, and that is not our
> quirk.** It ships running a build older than Zigbee2MQTT supports, so out of
> the box it is found, identified and opened — and then refuses at the last
> step. It takes about a minute and no extra hardware: unplug it, put it in a
> Mac or PC, open SONOFF's flasher at
> <https://dongle.sonoff.tech/sonoff-dongle-flasher/> in Chrome or Edge (Safari
> cannot talk to USB devices), and flash the **Zigbee Coordinator** firmware it
> offers you — it identifies the dongle and picks the current build itself.
> Plug it back in and the hub picks it up on its own.
>
> You do not have to know any of this in advance: the hub recognises this exact
> failure, says so in the install log *and* in `GET /hub`, and GetHome Studio
> puts the steps and the link on the hub's page. Once updated, it is done for
> good.

Beyond that, what the hub can tell you is how *certainly* it will recognise a
stick, and that has three honest levels:

| | Coordinator | Why it's placed here |
|---|---|---|
| **Developed against** | **SONOFF ZBDongle-E** (V2, the CH9102 variant, `1a86:55d4`) | The one we own and install with. |
| **Recognised by a dedicated USB id** | **dresden elektronik ConBee II / III**, **Texas Instruments CC2531 / CC2538** | Their `vendor:product` belongs to a Zigbee coordinator and nothing else, so identifying them never depends on a product string a vendor might reword. |
| **Recognised by name** | **SONOFF** ZBDongle-P, Dongle Plus MG24, Dongle Lite MG21, Dongle Max, Dongle-PP10 · **Home Assistant** SkyConnect, Connect ZBT-1, Connect ZBT-2 · **SMLIGHT** SLZB-06 / 06p7 / 06p10 / 06m, SLZB-07 / 07p7 / 07mg24 · **ZiGate**, **TubesZB**, **ZigStar**, **Electrolama zzh**, **Nordic Zigbee NCP** | They say what they are in their USB product string, and the hub reads it. |

Any of those: plug it in at any time, before or after installing. The hub
identifies it, sets it up and starts Zigbee within seconds, with no reboot and
nothing to re-run ([docs/zigbee.md](docs/zigbee.md#finding-the-coordinator)).

**That table is about recognition, not about what works.** Anything Zigbee2MQTT
supports works. The difference is that a stick built on a bare USB-serial bridge
(CP210x, CH340, FTDI) with no name of its own cannot be told apart from a 3D
printer or a UPS — so the hub offers it to you instead of adopting it, and
GetHome Studio lets you pick it. Nothing is lost by declining: you can point the
installer at it later with `--zigbee /dev/serial/by-id/...`.

Both recognised tiers are pinned by `test/deploy-radio.test.ts`, which runs real
device names from `zigbee-herdsman`'s own table — the library Zigbee2MQTT uses to
talk to a coordinator — through the actual detector. That is what stops this list
quietly falling behind as upstream's grows, and it is how the gaps it currently
closes were found.

**Without a coordinator you get Matter, Wi-Fi and MQTT devices only** — no
Zigbee. That is a real limitation rather than a temporary one, so it is worth
deciding before you buy a board:

> **A Raspberry Pi Zero 2 W runs one radio at a time.** 512 MB is not enough for
> Matter *and* Zigbee at once — measured, the hub is ~120 MB, Matter adds
> ~60 MB, and Zigbee2MQTT another ~150 MB on top of the operating system's
> ~70 MB. So that board gets whichever one you are actually using: plug a
> coordinator in and it runs Zigbee, leave it out and it runs Matter. Nothing to
> configure either way, and the installer says which one you ended up with. You
> can switch it in the GetHome app at any time — the coordinator stays
> configured, and Zigbee devices come back when you switch back (they show as
> offline meanwhile). A Pi 4 or Pi 5 runs both together and never asks.

## Quick start

```sh
curl -fsSL https://raw.githubusercontent.com/gethome-inc/gethome-hub/main/deploy/install.sh | bash
# to pin a specific Zigbee coordinator instead of letting it be detected:
curl -fsSL https://raw.githubusercontent.com/gethome-inc/gethome-hub/main/deploy/install.sh | bash -s -- --zigbee /dev/serial/by-id/usb-...
```

**Zigbee needs no flags.** The installer identifies an attached coordinator by
itself, and installs a udev rule so one plugged in *later* starts working
automatically too — see
[docs/zigbee.md](docs/zigbee.md#finding-the-coordinator).

The installer downloads a prebuilt hub for this machine's processor, installs
Node.js 22 and Mosquitto, registers everything as systemd units, and prints the
**pairing code**. Every unit is enabled at boot with `Restart=always`, so the
hub comes back on its own after a power cut — plug the Pi in and it runs, with
nothing to start by hand.

The **GetHome Studio** macOS app automates all of this with a guided setup: it
writes the SD card or finds a Pi already on your network, gets this installer
running on it, and watches it step by step over SSH.

**Studio claims the hub for you** at the end of that, so the pairing code is for
your *other* devices — a phone, a second Mac — rather than something you have to
find. See [docs/api.md](docs/api.md#claiming).

### Getting a shell on the hub

Everything in this section runs *on* the hub, so:

```sh
ssh <user>@<address>
```

`<user>` is the account you set in Raspberry Pi Imager (`pi` unless you changed
it). `<address>` is the Pi's IP or its `<hostname>.local` — the same host the
apps show for the hub, **without** the `:8420`, which is the API and not SSH.

**If GetHome Studio set the hub up, it never asked you for that password** —
it authorizes its own key on the Pi instead — so the key is usually the
shortest way in, and on a card install it may be the only one you still know:

```sh
ssh -i "$HOME/Library/Application Support/gethome-studio/id_ed25519_gethome" pi@192.168.0.200
```

The quotes are load-bearing: the path contains a space. Use `"$HOME/…"` rather
than `'~/…'` — a tilde inside quotes is not expanded, and ssh will report a key
that isn't there.

### One switch

```sh
sudo gethome-hubctl status          # every service, and what the API says
sudo gethome-hubctl logs 100
sudo gethome-hubctl zigbee          # the coordinator, and re-check what's attached
sudo gethome-hubctl pairing-code    # for another device
```

The API answers at `http://<hub>:8420/api/v1/hub`, and the MQTT broker at
`mqtt://<hub>:1883` for devices on the same network. The broker is anonymous
and unencrypted, which is right for a home LAN and wrong for the internet —
don't forward 1883 through your router.

### There is no Docker, and no database server

Both were removed, and the reason is one machine: a Raspberry Pi Zero 2 W has
512 MB of memory. The Docker daemon wanted ~130 MB of it and Postgres at stock
settings another ~130 MB — before the hub had started — for a workload that is
one writer, small local reads, and not a single transaction. The board ran out
of memory, and the hub was being killed somewhere between the install finishing
and its owner claiming it.

So: systemd units against a SQLite file at `<data>/hub.db`. systemd also gives
what compose could not — per-service memory limits, so a runaway Zigbee2MQTT
costs itself a restart instead of taking the hub down with it. The hub itself is
*throttled* rather than capped (`MemoryHigh`, no `MemoryMax`): a hard ceiling
near the real working set turns a busy minute into a kill.

Those limits need a kernel feature a Raspberry Pi boots **switched off**. The
firmware puts `cgroup_disable=memory` on the kernel command line, so on a stock
Pi the units carried the right numbers, `systemctl show` read them straight
back, and the kernel enforced none of them — found on a Zero 2 W, where the
unit's cgroup had no `memory.*` file at all. The installer asks for the
controller by name after it, which is what wins, and takes effect at the next
restart; it also
sets `OOMScoreAdjust` on both units, and that is the half that needs no kernel
feature, no reboot and no cgroup. It is what actually keeps the kernel's choice
of victim off the hub, from the moment the units start.

### The prebuilt bundle

The Pi downloads the hub; it does not compile it. `.github/workflows/bundle.yml`
publishes one tarball per architecture (`linux-arm64`, `linux-x64`) — `dist/`
plus production `node_modules` with native modules already built for that
platform — and stamps each with a build id. Compiling *on* a Pi means `npm ci`
pulling a thousand packages onto an SD card and then `tsc`: twenty to forty
minutes, several hundred megabytes of memory, and on a 512 MB board an
out-of-memory kill at the end of it regardless.

`install.sh` falls back to building from source when there is no bundle — but
only on a machine with more than 1 GB of memory. Below that it stops and says
why, because starting a build that cannot finish is worse than an error.

**Two kinds of release, and only one of them lasts.** Pushing any branch
publishes a *rolling prerelease* named `bundle-<branch>`; its assets, its tag
and its description all move on every push, so the release page always names the
commit that is actually inside it. `bundle-cleanup.yml` deletes the whole thing
once the branch is gone, so they don't accumulate. Pushing a `v*` tag publishes
an immutable release under that tag, which nothing re-points and nothing ever
deletes.

That is what makes a branch testable on real hardware: `install.sh --branch X`
looks for `bundle-X`, and GetHome Studio passes `StudioFeature.hubBranch`
through to it. Everything defaults to `main`, so a hub installs `bundle-main`
unless someone says otherwise.

### Updating

```sh
sudo gethome-hubctl version          # which build is running
sudo gethome-hubctl update           # install the latest build of main
sudo gethome-hubctl rollback         # go back to the previous one
```

**Or from an app.** The GetHome iOS app updates a hub from its Hub page, and
GetHome Studio does it over SSH — both run exactly this, so the atomic flip,
the health check and the automatic rollback are the same on every path. Updating
from an app is the home owner's; every member can watch it happen. A hub
installed before that existed has to be updated once from Studio or from here,
after which it can do it itself.

**Installing a branch.** `update` takes `--branch`, which is how an unmerged
change gets onto real hardware — and how you go back afterwards:

```sh
sudo gethome-hubctl update --branch my-feature
sudo gethome-hubctl update --branch main       # back to the released line
```

It installs the rolling `bundle-<branch>` release described above, with any `/`
in the name flattened to `-`: branch `alice/new-thing` installs
`bundle-alice-new-thing`. If CI has not published that branch for this
processor yet, the installer says which release it looked for; on a board with
more than 1 GB of memory it then builds from source instead, which takes a
while, and on a smaller one it stops and tells you to check the workflow rather
than starting a build that cannot finish.

On a hub too old to have `gethome-hubctl`, the installer does the same job
directly. The options go **after** `bash -s --`, or they reach bash instead of
the script:

```sh
curl -fsSL https://raw.githubusercontent.com/gethome-inc/gethome-hub/my-feature/deploy/install.sh \
  | bash -s -- --branch my-feature
```

Either way the hub keeps the build it was running until the new one answers its
health check, so a branch that doesn't start leaves you where you were.

Each build lives in its own directory under `/opt/gethome/releases/` and
`current` is a symlink to the one that runs, so an update is an atomic flip —
**and if the new build doesn't answer, the installer flips it back by itself**
and tells you why. That is deliberately not a container: on a 512 MB board the
Docker daemon alone is a third of the machine, and a `docker pull` into the same
tag has nothing to roll back to.

### Development

```sh
cp .env.example .env
npm install
npm run dev                               # tsx watch
npm test                                  # vitest — no services needed
HUB_TEST_MQTT=1 npm test                  # + end-to-end broker round-trip (needs mosquitto)
```

Node.js ≥ 22 required. There is no cloud: everything runs from this repo. The
hub is *deployed* on Linux only, but it develops and tests fine on macOS — the
suite needs no radios and keeps its database in a temp file.

## Architecture (short version)

```
Zigbee2MQTT ─┐                       ┌─ REST /api/v1 ── GetHome apps
MQTT devices ─┼─ protocol adapters ──┼─ WebSocket events
Matter fabric┘        │              └─ MCP ─────────── AI assistants
                DeviceRegistry
            (canonical schema, SQLite)
```

Adapters translate protocols into one canonical schema; the registry persists
devices and fans out events; the API serves them. Full picture in
[docs/architecture.md](docs/architecture.md), ecosystem context in
[docs/ecosystem.md](docs/ecosystem.md).

## License

Free for **personal and noncommercial use** under the
[PolyForm Noncommercial License 1.0.0](LICENSE.md) — homes, hobby projects,
evaluation, research. This is source-available, not OSI open source.

**Commercial deployments** (hotels, property management, paid installations)
require a separate license — see [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md).
