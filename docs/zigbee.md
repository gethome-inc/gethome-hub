# Zigbee support

Zigbee devices join through [Zigbee2MQTT](https://www.zigbee2mqtt.io) (Z2M)
and a USB coordinator stick. The hub never speaks Zigbee itself — it consumes
Z2M's MQTT interface, which keeps the enormous Z2M device library and tooling
available.

## Setup

1. Plug a supported coordinator (SONOFF ZBDongle-E/P, ConBee, SkyConnect, …)
   into the hub machine.
2. Start Zigbee2MQTT:
   - **Linux/Pi (Docker):** `COMPOSE_PROFILES=zigbee ZIGBEE_ADAPTER=/dev/ttyACM0
     docker compose up -d` (or `install.sh --zigbee /dev/ttyACM0`). Tip:
     `/dev/serial/by-id/...` paths survive reboots.
   - **macOS (native):** `install-macos.sh --zigbee auto` (or an explicit
     `/dev/tty.usb*` path) — Docker on macOS cannot pass USB through, which
     is one reason the macOS install is native (see [macos.md](macos.md)).
3. Open the network from the GetHome app (or
   `POST /api/v1/zigbee/permit-join {"seconds":120}`) and put the device in
   pairing mode.

## How the hub uses Zigbee2MQTT

Subscribed topics (base topic `zigbee2mqtt`, configurable via
`Z2M_BASE_TOPIC`):

| Topic | Use |
|---|---|
| `zigbee2mqtt/bridge/devices` | retained device registry incl. `definition.exposes` — the schema source |
| `zigbee2mqtt/bridge/state` | Z2M health |
| `zigbee2mqtt/<friendly_name>` | state payloads |
| `zigbee2mqtt/<friendly_name>/availability` | online/offline |

Published topics:

| Topic | Use |
|---|---|
| `zigbee2mqtt/<friendly_name>/set` | commands (translated from canonical intents) |
| `zigbee2mqtt/<friendly_name>/get` | state refresh after join |
| `zigbee2mqtt/bridge/request/permit_join` | open/close the network |
| `zigbee2mqtt/bridge/request/device/remove` | forget a device |

Devices are keyed by IEEE address, so Z2M friendly-name changes don't
duplicate devices. The hub keeps its own device names — it never renames
devices inside Z2M.

## Exposes → canonical schema

`src/adapters/zigbee/exposes-mapper.ts` statically maps Z2M's
[exposes](https://www.zigbee2mqtt.io/guide/usage/exposes.html) into canonical
capabilities. Highlights (full unit table in
[device-schema.md](device-schema.md)):

- `light`: state → `onOff`; brightness (0–254) → `level` (clamped to 1);
  color_temp (already mireds, expose min/max honored) → `colorTemperature`;
  color_hs/xy → `color` (hue° → 0–254, sat% → 0–254)
- `switch` → `onOff` (kind `outlet`, or `wallSwitch` for bare relays)
- `cover`: position **0–100 where 100 = open** → canonical percent-100ths
  where **0 = open**: `percent100ths = (100 − position) × 100`
- `lock`: `lock_state` locked/unlocked/not_fully_locked → 1/2/0
- `climate`: `local_temperature`/setpoints °C → centi-°C; expose min/max →
  setpoint limits; `system_mode` off/auto/cool/heat → 0/1/3/4
- sensors: temperature ×100, humidity ×100, pressure (hPa), battery (direct),
  power W → mW, energy kWh → mWh, occupancy, contact (true = closed),
  water_leak → contact (inverted), smoke/carbon_monoxide → alarm 0/2, pm25, co2
- diagnostics (linkquality, radio voltage, actions, child locks…) are ignored

Anything left over — and any device Z2M itself doesn't support — goes to the
**AI mapper** ([ai-adaptation.md](ai-adaptation.md)); until a mapping exists
the device is stored with whatever mapped statically and `needsReview: true`.

Multi-endpoint devices (`state_l1`/`state_l2` relays) are not mapped
statically in v1; the AI mapper produces multi-endpoint descriptors for them.

## Runtime external converters

Z2M supports loading converters for unsupported devices at runtime via
`zigbee2mqtt/bridge/request/converter/save`. The AI pipeline may use this in a
future iteration to teach Z2M itself about brand-new devices; today the AI
mapping operates purely on the hub side.
