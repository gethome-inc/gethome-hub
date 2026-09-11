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

## Commissioning

`POST /api/v1/matter/commission {"pairingCode":"749701123365521327694"}`
accepts a **manual pairing code** or a **QR payload** (`MT:…`) and runs
commissioning as an async job (`202 {jobId, deadline}`; progress via the
WebSocket `commissioning` frames and `GET /matter/commission/:jobId`).
[api.md](api.md#pairing-a-matter-accessory) is canonical for the wire.

### Where the hub looks, and why it is not a setting

**An accessory that has never been on a network cannot be found on one.** A
factory-new — or factory-reset — Wi-Fi accessory advertises over Bluetooth LE
and nowhere else; it has no network to advertise on yet, and the point of the
Bluetooth conversation is that it is handed one. So there are two paths, and
which is used is the **accessory's own answer**, not a preference:

- **Over Bluetooth** — anything out of its box. The QR payload's
  `discoveryCapabilities` bitmap (core spec § 5.1.3.1, Table 60) says BLE and
  not `onIpNetwork`, and the hub follows it.
- **Over IP** — anything already on the LAN: Ethernet, Thread behind a border
  router, or a device shared from another ecosystem under multi-admin.

A **manual** pairing code carries no capability bits at all, and the hub treats
that as *"the code did not say"* — searching everywhere it can. `undefined` and
"neither" are different answers and only one of them is safe to act on:
guessing IP for a manual code is how a perfectly good accessory becomes a
screen that spins.

This was the bug. The adapter hardcoded `{ onIpNetwork: true }` for every code,
so it searched the LAN for a device that was never going to be there — and
matter.js applies **no discovery timeout at all** unless one is passed
(`Discovery` guards its `withTimeout` on `!== undefined`), so the job never
settled. On the hub this was found on, one had been running for thirty-five
minutes with "Pairing with your hub" still on the phone.

### Bluetooth

`@matter/nodejs-ble` (with `@stoprocent/noble` underneath) is an **optional**
dependency: it is a native module with prebuilt binaries for the two
architectures the hub ships on and none for whatever somebody is developing on,
so a hub whose BLE stack did not install must still start, run Matter over IP,
and say so. `installBle()` resolves every failure to a named reason —
`unsupported-platform`, `not-installed`, `no-adapter` — which reaches
`GET /hub` as `matter.bluetoothReason`, because "Bluetooth is off", "this hub
has none" and "it is blocked" send a person to three different places.

It is installed into the matter.js `Environment` **before** the controller is
constructed. Afterwards it is a transport nothing is holding, and the hub logs
`BLE is not enabled on this platform` while having perfectly good Bluetooth.

Two things a Raspberry Pi needs, both handled by `install.sh`:

- **rfkill.** A headless Raspberry Pi OS image ships Bluetooth *soft-blocked*,
  which is invisible from everywhere the product can see: `hciconfig` lists the
  adapter happily and bringing it up fails with an errno nothing logs.
- **Capabilities.** noble talks to the controller over a raw HCI socket, so the
  unit carries `AmbientCapabilities=CAP_NET_RAW CAP_NET_ADMIN` (and a matching
  `CapabilityBoundingSet`) — scoped to the service, rather than `setcap` on a
  node binary every script on the machine shares.

### The network the accessory is given

Commissioning a Wi-Fi accessory over Bluetooth ends in
`AddOrUpdateWiFiNetwork(ssid, credentials)`, so a hub that can do the Bluetooth
half and not that one starts a pairing it cannot finish. The hub cannot read
the system's own credentials — the PSK is in a root-owned NetworkManager
profile and the point of the service account is that it cannot read one — so
`deploy/wifi-credentials.sh` writes `/etc/gethome/wifi.env` (0640, group
`gethome`) at install time and again from a dispatcher on every association.
`GET /hub` reports whether the hub has any as `matter.wifi`, and an app may
send `wifi: {ssid, passphrase}` with the request for a hub that has none.

**Thread accessories are not yet provisioned this way.** Taking one on over
Bluetooth needs a Thread operational dataset, which means a border router the
hub is part of; a Thread device already on a LAN border router is commissioned
over IP as normal.

### Asking what the hub can hear

`GET /matter/discoverable` listens for a few seconds and reports every
commissionable accessory the hub can reach, over Bluetooth and over IP.

It exists because **Bluetooth range is the one part of this flow nobody can
see**. "Not found" is the same sentence for an accessory two rooms away and one
that never went into pairing mode, and those have opposite fixes — so an app can
ask *before* committing somebody to a three-minute wait, and can match a scanned
code's discriminator against what is actually in earshot.

It is refused while a pairing is running, and that is a measurement rather than
a preference: a second scanner beside the hub's own took fifteen seconds of
neighbourhood BLE advertisements from 231 down to 2 on a Zero 2 W. A starved
scan reports an empty list, which is the wrong answer in the direction somebody
acts on.

**The range only has to hold while the accessory is being paired.** A Wi-Fi
accessory joins the network during commissioning and lives on it afterwards, so
setting one up beside the hub and then moving it where it is wanted is a real
answer — and it is the one the apps give.

### Bounds

Discovery is bounded at three minutes — the Matter spec's own minimum
commissioning window (§ 5.4.2.3), so the longest a correctly-behaved accessory
can be waiting — and the whole job at four and a half, because PASE,
attestation, the fabric write and the first CASE session all follow discovery
and each can stall. A pairing can be cancelled, which stops the discovery
rather than only closing the screen; the hub runs **one at a time**, which is
what makes a single cancel unambiguous.

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

## Not built yet

Two things the hub cannot do, written down with the detail somebody picking
them up would otherwise have to rediscover. Neither is started.

### Sharing a device with another ecosystem

**The hub takes devices in and cannot give them away.** A Matter accessory can
belong to several fabrics at once — the Yandex plug this was tested against
reports `supportedFabrics: 5` — and every other ecosystem offers this
("Turn On Pairing Mode" in Apple Home; "add to another app" in a vendor's).
We don't, so adopting an accessory into a GetHome home currently means giving
up the app it came with, and there is no way back short of a factory reset.

That is a bigger deal than a missing feature: it is the fear somebody has
*before* they pair anything.

- **The API exists.** `PairedNode.openEnhancedCommissioningWindow(timeout)`
  answers `{ manualPairingCode, qrPairingCode }`. `MatterAdapter` already holds
  the `PairedNode` in `this.nodes`, keyed by external id.
- **Enhanced, not basic.** `openBasicCommissioningWindow()` re-uses the
  passcode printed on the device, is optional in the spec, and devices may
  simply refuse it. Enhanced generates a one-time passcode. matter.js says the
  same thing in its own doc comment.
- **Closing it again matters.** `AdministratorCommissioning.revokeCommissioning`
  is the command; the window is otherwise open for its whole timeout with a
  code somebody has seen. Cap the timeout at the spec's 900 s.
- **Check `commissionedFabrics` against `supportedFabrics` first**
  (OperationalCredentials cluster, already read at attach). A device at its
  limit refuses, and "this accessory has no room for another home" said
  *before* the window opens is the `needs-bluetooth` rule again: refuse where
  the answer cannot change while somebody waits for it.
- **Permission is a decision, not an obvious call.** Whoever holds the code
  becomes an admin of that device and could remove *our* fabric. It passes the
  three-part test for a default (bounded — one device, one timed window;
  destroys nothing; nameable in the activity log), which argues for
  `device.add` beside pairing. Make the call deliberately and write it in
  `docs/api.md`'s two tables.
- **Log it.** Handing an accessory to another ecosystem is exactly the kind of
  thing a home should be able to see afterwards.
- App side: a sheet with the QR, the manual code, and a countdown.

### Pairing from the phone when the hub is out of Bluetooth range

**The one case nothing else covers**: an accessory that is factory-new, cannot
be carried to the hub (a wall switch, a boiler controller, an outdoor camera),
and is in no other ecosystem to be shared from. Bluetooth is the only way to
reach it, the link cannot be relayed over the network, and the phone is the
thing that is standing next to it.

Apple's `MatterSupport` (iOS 16.1+) is built for exactly this shape:

1. The app raises `MatterAddDeviceRequest`.
2. **Apple's own system UI** does BLE discovery, PASE and Wi-Fi/Thread
   provisioning — on the phone, next to the accessory.
3. It then calls our `MatterAddDeviceExtension` →
   `commissionDevice(in:onboardingPayload:commissioningID:)`.
4. We hand the payload to the hub, which commissions **over IP** — the path
   that already works.

- **Verify this first, before anything is committed to it:** *whose fabric does
  the accessory land in?* If iOS commissions into Apple's fabric and leaves us
  a second one, the user needs an Apple home hub (Apple TV / HomePod) and the
  whole value proposition changes. Apple's documentation is thin here and
  developers get stuck in precisely this callback
  ([connectedhomeip#29537](https://github.com/project-chip/connectedhomeip/issues/29537)).
- `com.apple.developer.matter.allow-setup-payload` needs **no Apple approval**;
  it is added like any unmanaged entitlement. A separate extension target is
  required.
- **Known to be broken for Thread devices**
  ([connectedhomeip#34974](https://github.com/project-chip/connectedhomeip/issues/34974),
  [Apple forum 793998](https://developer.apple.com/forums/thread/793998)). Wi-Fi
  works.
- **iOS only.** There is no Android equivalent, so this is a fork in the
  product rather than a feature — worth saying out loud when it is planned.
- Hub side is small: a route taking an onboarding payload for a device already
  on the network. `commission()` handles it today; what may be needed is
  forcing `onIpNetwork` when the caller knows the accessory is already there.
- **Decide on evidence.** `GET /matter/discoverable` now reports when the hub
  cannot hear an accessory, which is the measurement that says how often this
  case actually arises. One plug paired at −48 dBm is not it.
