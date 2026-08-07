# Matter support

> **Memory note.** Matter is installed and enabled everywhere, including on a
> Raspberry Pi Zero 2 W. What a 512 MB board cannot do is run it *and*
> Zigbee2MQTT at once — matter.js costs about 60 MB on top of the hub's
> ~120 MB, Zigbee2MQTT is another ~150 MB in its own process, and the operating
> system wants ~70 MB. So `install.sh` records that board as affording **one
> radio** (`GETHOME_RADIO=one`) and `gethome-zigbee-detect` hands it to
> whichever radio is actually in use: Zigbee when a coordinator is plugged in,
> Matter when one isn't. The owner can override that from the GetHome app.
> See [Zigbee or Matter on a small board](zigbee.md#zigbee-or-matter-on-a-small-board).
> A Pi 4 or 5 runs both together and never makes the choice.

`ADAPTER_MATTER` in `/etc/gethome/hub.env` is the live switch, but on a
one-radio board it is **managed** — the detector rewrites it on every plug and
unplug, so editing it by hand there does not survive. Use `PUT
/api/v1/settings/radio` (the app's radio switch) instead.

The hub is a **Matter controller** with its own fabric, built on
[matter.js](https://github.com/matter-js/matter.js) (pure TypeScript, no
native SDK). Devices commissioned onto the hub belong to the *hub*, not to a
phone — that's what makes hub homes shareable.

## Commissioning (v1: over IP)

`POST /api/v1/matter/commission {"pairingCode":"749701123365521327694"}`
accepts a **manual pairing code** or a **QR payload** (`MT:…`) and runs
commissioning as an async job (`202 {jobId}`; progress via the WebSocket
`commissioning` frames and `GET /matter/commission/:jobId`).

The device must already be reachable over IP:

- Ethernet or Wi-Fi devices already on your network (e.g. shared from another
  admin via Matter multi-admin, or Wi-Fi-provisioned during a phone-side
  setup),
- Thread devices behind a border router on the LAN.

**BLE-assisted commissioning** (taking a factory-new device through Wi-Fi
provisioning directly) needs host Bluetooth (`@matter/nodejs-ble` + BlueZ) and
is a planned follow-up — on a Raspberry Pi the built-in radio makes this a
natural fit. Until then, the simplest path for factory-new Wi-Fi devices is to
pair them into another Matter ecosystem first (Apple Home, Google Home, Alexa,
or `chip-tool`), then share to the hub via multi-admin (open a commissioning
window) — or use Ethernet/Thread devices.

## Runtime requirements

- **Host networking.** Matter uses site-local UDP (port 5540) and mDNS
  (5353); hubd runs directly on the host network for this
  reason. IPv6 link-local must be available (it is on standard Raspberry Pi
  OS / Debian; some containers/VMs disable IPv6 — the adapter will fail to
  start and the hub continues without Matter).
- Fabric storage lives in `<data>/matter/`; keep the `/data` volume to keep
  your fabric.

## How devices map

- Endpoint device types (Descriptor cluster `DeviceTypeList`) are looked up in
  the catalog (`src/schema/catalog.ts`) → `deviceKind` + capabilities;
  infrastructure endpoints (root node, bridge plumbing, OTA) are filtered.
- All attributes and events are subscribed; reports run through
  `src/adapters/matter/reducer.ts` — a 1:1 port of the GetHome app's own
  Matter state reducer (same cluster/attribute IDs, same unit transforms:
  illuminance log-scale, battery half-percents (truncated, like the app),
  thermostat 0x8000 null filtering, 0.1 W power quantization). Hub devices
  therefore produce exactly the typed state the GetHome app renders.
- On announce, the adapter **seeds initial state** from matter.js's cached
  attribute values (every cluster client's `getLocal()`), so devices show
  real state right after a hub restart instead of an empty card until their
  first report.
- **Generic Switches (0x000F) are buttons**: the Switch cluster's feature map
  becomes an `event.buttons` inventory, and Switch-cluster events
  (`MultiPressComplete` → single/double/triple…, `LongPress` → hold,
  `LongRelease` → release, `ShortRelease` → single on non-multi-press
  switches, `SwitchLatched` → single) are mapped into the canonical `event`
  capability — the same shape Zigbee remotes use.
- The 17 canonical intents translate to cluster commands / attribute writes
  in `src/adapters/matter/commands.ts` (OnOff, LevelControl
  `moveToLevelWithOnOff`, ColorControl, Thermostat setpoint/mode writes,
  DoorLock, WindowCovering `goToLiftPercentage`, FanControl writes,
  MediaPlayback, ModeSelect).

## Version pinning

matter.js's API is still evolving; the dependency is pinned to a minor
(`~0.17.x`) and everything matter.js-specific is confined to
`src/adapters/matter/`. If the adapter cannot start (missing IPv6, port
conflicts), the hub logs it, records an activity entry, and keeps serving
Zigbee/MQTT devices.
