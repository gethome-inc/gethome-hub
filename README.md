# GetHome Hub

A local smart-home hub that brings **Matter**, **Zigbee** (via Zigbee2MQTT), and
**MQTT** devices together behind one clean, typed device schema — and makes the
home shareable with family members. It runs on a Mac mini, a Raspberry Pi, or
any Linux box, entirely on your LAN: no cloud account, no data leaving your
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
  autonomous mapping agent built on the Claude Agent SDK: it reads the
  device's published schema, researches it on the web, and submits a
  validated mapping (bring your own Anthropic API key or Claude
  subscription token; stored encrypted on the hub, used only for this).
  No credential → devices still appear, flagged "needs review".
  ([docs/ai-adaptation.md](docs/ai-adaptation.md))
- **One schema for everything** — 27 capabilities (including button/remote
  events, learn-and-replay IR blasters, and a universal generic-control
  fallback so *any* device parameter is usable), 16 device kinds, exact unit
  conventions shared with the GetHome apps ([docs/device-schema.md](docs/device-schema.md)).
- **Sharing built in** — pairing-code claim makes you the owner; short-lived
  invite codes add family members. Only hub homes are shareable in GetHome.
- **Local REST + WebSocket API** ([docs/api.md](docs/api.md)) and mDNS
  discovery (`_gethome._tcp`).

Remote access (control away from home through a relay) is planned; v1 is
LAN-only by design.

## Quick start

**Raspberry Pi / Linux**:

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

**GetHome Studio claims the hub for you**, so the pairing code is for your
*other* devices — a phone, a second Mac — rather than something you have to
find. See [docs/api.md](docs/api.md#claiming).

**macOS** (also native; see [docs/macos.md](docs/macos.md)):

```sh
curl -fsSL https://raw.githubusercontent.com/gethome-inc/gethome-hub/main/deploy/install-macos.sh | bash
# with a Zigbee USB stick (auto-detects /dev/tty.usb*):
curl -fsSL https://raw.githubusercontent.com/gethome-inc/gethome-hub/main/deploy/install-macos.sh | bash -s -- --zigbee auto
```

Requires [Homebrew](https://brew.sh); everything installs per-user (no sudo)
and runs as launchd agents that start at login. One switch controls it all:
`deploy/hubctl start|stop|status` — `stop` frees every port and disables
autostart until the next `start`.

The **GetHome Studio** macOS app automates all of this with a guided setup
(finds machines on your network, installs locally or over SSH, checks health).

### One switch, on Linux

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

**Two kinds of release, and only one of them lasts.** A push to `main`
refreshes `bundle-main`, a *rolling* prerelease whose assets and tag move every
time. A `v*` tag publishes an immutable release under that tag, which nothing
ever deletes.

Everything defaults to `main` — `install.sh`, `gethome-hubctl update`, and
Studio's `StudioFeature.hubBranch` — so a hub installs `bundle-main` unless
someone says otherwise.

**To test a branch on real hardware**, run the *Publish bundle* workflow against
it from the Actions page. That writes `bundle-<branch>`, which
`install.sh --branch <branch>` (and Studio's `hubBranch`) will then fetch. It is
deliberately on demand: building for every branch automatically meant a release
per branch and a tags page that grew forever, for artifacts nobody downloaded.
`bundle-cleanup.yml` removes any branch build once its branch is gone.

### Supported hardware

**A 64-bit system is required.** Raspberry Pi **Zero 2 W, 3, 4, 5** (and 400,
500, CM4, CM5), plus any other 64-bit ARM or x86-64 Linux machine. The tested
and recommended system is **Raspberry Pi OS Lite (64-bit)**; Debian and Ubuntu
on arm64 also work.

Two cases are refused up front rather than halfway through an install:

- The original **Pi Zero / Zero W / Pi 1** are ARMv6, and Node.js has published
  no ARMv6 build since Node 12. Nothing can be installed on them.
- A **32-bit system on a 64-bit board** — the 32-bit image written to a
  perfectly good Zero 2 W or Pi 4. The Pi is fine; the card needs rewriting with
  the 64-bit image, and both the installer and Studio say exactly that. Studio
  checks the card before it writes anything, so this costs one sentence instead
  of twenty minutes.

### Updating

```sh
sudo gethome-hubctl version          # which build is running
sudo gethome-hubctl update           # install the latest build of main
sudo gethome-hubctl rollback         # go back to the previous one
```

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

Node.js ≥ 22 required. There is no cloud: everything runs from this repo.

## Architecture (short version)

```
Zigbee2MQTT ─┐                       ┌─ REST /api/v1 ── GetHome apps
MQTT devices ─┼─ protocol adapters ──┤
Matter fabric┘        │              └─ WebSocket events
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
