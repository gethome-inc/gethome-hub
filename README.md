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

**Raspberry Pi / Linux** (Docker-based):

```sh
curl -fsSL https://raw.githubusercontent.com/gethome-inc/gethome-hub/main/deploy/install.sh | bash
# with a Zigbee USB stick:
curl -fsSL https://raw.githubusercontent.com/gethome-inc/gethome-hub/main/deploy/install.sh | bash -s -- --zigbee /dev/ttyACM0
```

The installer sets up Docker if needed, starts the stack
(hub + Postgres + Mosquitto, optionally Zigbee2MQTT), and prints the
**pairing code** — enter it in the GetHome app to become the owner.

**macOS** (native — no Docker, so mDNS discovery, the Matter controller, and
Zigbee USB sticks actually work; see [docs/macos.md](docs/macos.md)):

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

### Manual (docker compose)

```sh
git clone https://github.com/gethome-inc/gethome-hub.git && cd gethome-hub
docker compose up -d                              # hub + Postgres + MQTT
COMPOSE_PROFILES=zigbee docker compose up -d      # …plus Zigbee2MQTT
docker compose exec hubd cat /data/pairing-code   # your pairing code
```

The API answers at `http://<hub>:8420/api/v1/hub`.

Docker on macOS is not recommended for running the hub (no USB passthrough,
unreliable mDNS from the VM) — use the native install above instead.

### Development

```sh
docker compose up -d postgres mosquitto   # just the dependencies
cp .env.example .env
npm install
npm run dev                               # tsx watch
npm test                                  # vitest (some suites need Postgres)
HUB_TEST_MQTT=1 npm test                  # + end-to-end broker round-trip
```

Node.js ≥ 22 required. There is no cloud: everything runs from this repo.

## Architecture (short version)

```
Zigbee2MQTT ─┐                       ┌─ REST /api/v1 ── GetHome apps
MQTT devices ─┼─ protocol adapters ──┤
Matter fabric┘        │              └─ WebSocket events
                DeviceRegistry
             (canonical schema, Postgres)
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
