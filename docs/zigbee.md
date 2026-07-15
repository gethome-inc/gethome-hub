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

Because layers 1–2 make almost everything usable, the AI mapper
([ai-adaptation.md](ai-adaptation.md)) is reserved for real gaps:

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

## Runtime external converters

Z2M supports loading converters for unsupported devices at runtime via
`zigbee2mqtt/bridge/request/converter/save`. The AI pipeline may use this in a
future iteration to teach Z2M itself about brand-new devices; today the AI
mapping operates purely on the hub side.
