# The GetHome ecosystem

GetHome Hub is one of three pieces:

| Repository | What it is |
|---|---|
| [`gethome-hub`](https://github.com/gethome-inc/gethome-hub) (this repo, public) | The local hub server: Matter + Zigbee + MQTT devices behind one canonical schema, local REST/WS API, member sharing. Runs on a Mac mini, Raspberry Pi, or any Linux machine. |
| `gethome-ios` | The GetHome iOS app — the daily driver for controlling homes. Supports two home types: an Apple Home mirror (Matter accessories come in this way) and **hub homes** served by this project. |
| `gethome-studio-macos` | GetHome Studio for macOS — the guided way to create a hub: it finds machines on your network, installs the hub on this Mac or onto a Raspberry Pi over SSH, walks through claiming, and manages hubs afterwards. |

## Why a hub?

Smart-home devices are usually owned by one account or ecosystem — an Apple
Home mirror rides on one person's HomeKit permission, and a device paired into
one ecosystem answers to that ecosystem. That ownership is personal: it can't
be handed to a housemate. A hub owns its devices instead, so any phone with
access to the hub can control the home. **Hub homes are the only shareable kind
of GetHome home** — plus they add Zigbee (via a USB stick) and MQTT
integrations, which phones can't do at all.

## How the apps talk to the hub

- **Discovery:** the hub advertises `_gethome._tcp` on the LAN (TXT records:
  `id`, `ver`, `api`, `claimed`); apps can also connect by address.
- **Claim & sharing:** pairing-code claim makes the first user the owner;
  owners mint short-lived invite codes for family members
  ([api.md](api.md)).
- **One schema:** the hub serves devices in the same capability schema the
  apps use natively ([device-schema.md](device-schema.md)), so every device —
  Matter, Zigbee, or MQTT — renders with the apps' existing device controls.
- **Remote access** (controlling the home away from Wi-Fi) is future work: a
  relay through the GetHome service, end-to-end authenticated — the hub will
  never require port forwarding.

## Installing without the Studio app

Everything the Studio app does is scriptable — this repo is self-sufficient:
`deploy/install.sh` (or plain `docker compose up -d`) brings up a hub, and the
pairing code lands in `<data>/pairing-code`. See the [README](../README.md).
