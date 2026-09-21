# `src/adapters/zigbee/` — the Zigbee2MQTT adapter

Loaded when Claude works with files under `src/adapters/zigbee/`. The root
`CLAUDE.md` carries the rules from here that bind code outside this directory,
and units and the three layers of device support stay there because every
adapter shares them. `docs/zigbee.md` is canonical — update it in the same
change.

- **A command that reached the protocol is not a command that reached the
  device, and `bridge/logging` is the only thing that knows.** Publishing to
  `<name>/set` resolves when the *broker* takes the message and Z2M has no
  per-command reply topic, so `POST /devices/:id/commands` answers 200 for a
  write a sleeping battery sensor will not see for an hour — and both apps
  papered over that by drawing the optimistic value and then silently
  reverting it. `parseWriteFailure`
  (`src/adapters/zigbee/write-failures.ts`) reads the one line that says
  otherwise, `AdapterBus.commandFailed` carries it, and `api/ws.ts` fans it out
  as a `commandFailed` frame to **every** socket — like `structure`, because
  the value being written is the house's and the phone in the next room has the
  same wrong value on screen. Four rules. **`Request superseded` is not a
  failure**: it is a *newer* write to the same property taking this one's place
  in the queue, so somebody tapping − four times generates four of them for one
  correct outcome; dropped in the adapter and again in `DeviceRegistry`, which
  is the seam a second adapter arrives at. **Classification is
  most-specific-first** — the `diagnosis.ts` rule, and here it is load-bearing
  rather than tidy, because a supersede error carries the whole ZCL command
  including `"timeout":10000` and a generic "timed out" match placed first
  swallows the one outcome that must not be reported. **An unrecognised line
  yields nothing**, which is nearly every line. And **nothing is written to the
  activity log**: a write that failed at 17:11 is on screen now rather than
  history, and `device.command` already recorded the ask. `kind` is an open
  string on purpose — adapters classify in their own vocabulary and a client
  that meets a new word falls back to `detail`. The hub does not retry, wake
  the device, or hold the value to replay: waking an Aqara sensor is a person
  pressing its button, and a retry loop against a sleeping device is the queue
  we already have wrapped in a second one. `docs/zigbee.md` and `docs/api.md`
  are canonical.
- **Two bridge topics are relayed for device lifecycle; the rest are still
  dropped** (`bridge/logging` is the third relay, above, and reads only failed
  writes). `bridge/devices` lists a device only once its interview *finishes*, so
  without `bridge/event` the whole of pairing produced no output at all, and
  `bridge/info` is the join window above. The translation into the hub's
  vocabulary lives in `core/zigbee-events.ts` with a **type-only** import of
  the adapter, so adapters still see nothing but `AdapterBus` and the module
  stays out of a Matter-only hub's graph. Only the *failure* and the
  *departure* are written to the activity log — the rest is transient and the
  registry already writes `device.added` on adoption, so recording every step
  would put several rows saying "joined" in a log meant to be read a week
  later. The adapter used to write a `zigbee.joined` row of its own and no
  longer does: it gated that on its **in-memory** `byIeee` map, which is empty
  on every process start, so each restart re-announced every paired device —
  "0x54ef44100047c1bf joined over Zigbee", dated now, beside a `device.added`
  from months ago. A join is the registry's to record because the registry is
  keyed on the database; anything keyed on adapter memory is a restart
  artifact, not history.
  Read **both** `interview_completed` and `interview_state`: Z2M 2.x replaced
  the first with the second, so `interview_completed === false` read
  `undefined === false` on current installs and adopted devices mid-interview.
- **A device's `friendly_name` is its address until somebody renames it, so it
  is not a name.** Zigbee2MQTT names a newly joined device after its own IEEE —
  `friendly_name: "0x54ef44100047c1bf"` — and passing that through as
  `suggestedName` put eighteen characters of hex on the tile in the GetHome app,
  which reads as a hub that failed to recognise the device. It hadn't: the same
  `bridge/devices` record carried a full `exposes` schema, a vendor, a model and
  upstream's own one-line description, all mapped correctly. `suggestedNameFor()`
  prefers that description ("Smart plug EU"), then vendor + model, and appends
  the last four hex digits because two units of one model would otherwise be two
  identical rows. Not the device *kind* ("Outlet") — the apps already show that
  on its own line, and repeating it says nothing about which plug this is. Two
  names always win over it: one somebody set in Z2M, and the owner's, since
  `insertDevice` writes this on the insert only and never over an existing row.
- Zigbee2MQTT conversions to watch: cover position is **inverted** (Z2M
  100 = open), temperatures ×100, power W → mW, energy kWh → mWh, hue/sat
  degrees/percent → 0–254 cluster units. `action` enums parse through
  `adapters/zigbee/actions.ts` into `event` state; multi-endpoint devices
  address channels via suffixed properties (`state_l1`); every other leftover
  expose (settings, vendor knobs) becomes a generic `custom` field from its
  own metadata, so no parameter is unsupported. Tests in `test/zigbee-*.test.ts`
  pin all of these.
