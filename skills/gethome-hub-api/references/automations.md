# Rules and scenes

A gethome home runs rules by itself, and a **scene is a rule with a `manual`
trigger** — one object, one store. A rule is a JSON document the hub
**interprets and never executes**, checks before it saves, and always saves
**switched off**. The hub's `docs/automations.md` is canonical, and
`GET /api/v1/automations/capabilities` is the full, generated vocabulary — read
it rather than guessing a field.

## Pressing what already exists (`control`)

`GET /api/v1/automations` answers `{automations: [...], unreadable: [...]}`;
each rule in `automations` has a `shape`:

- `button` — press it: `POST /api/v1/automations/{automationId}/run`
- `toggle` — a mode such as "Night": `PUT /api/v1/automations/{automationId}/active` with `{"active": true}`
- `watching` — runs by itself on a trigger; nothing to press

Each carries `summary`, a whole sentence saying what it does — show that to a
person rather than describing the document yourself. Pressing an existing scene
is better than sending its commands one by one.

## Writing a rule (`automation.manage`, which needs `control`)

The safe sequence, and do not skip a step:

1. **Check it**: `POST /api/v1/automations/dry-run` with the document. The
   answer is `{problems, warnings, shape, summary, outline}`. `problems` mean it
   will be refused; fix them. `warnings` are real and worth showing (a cycle
   with another rule, a target that matches nothing yet).
2. **Show the person the `summary` and the `warnings`**, and get a yes.
3. **Save it**: `POST /api/v1/automations` with the document → `201`, with
   `enabled: false` whatever you send.
4. **Switch it on only when the person says so**:
   `PATCH /api/v1/automations/{automationId}` with `{"enabled": true}`.

`422 {error:"invalid_automation", issues}` is a shape the schema refuses;
`422 {…, problems, warnings}` is a shape it accepts that this home cannot use.

## The document

```text
{
  version?: 1,                     // defaulted
  name: string (1–80),
  description?: string,
  mode?: "single" | "restart" | "queued",
  triggers: Trigger[],             // any one fires it
  conditions?: Condition[],        // all must hold
  actions: Action[],               // in order, at most 40
  offActions?: Action[],           // present ⇒ a toggle; needs a manual trigger
  guards?: { minIntervalMs?, maxRunsPerHour? }   // only ever stricter than the hub's own
}
```

A **target** names devices by id or describes them:

```json
{ "deviceIds": ["…uuid"], "endpointId": 1 }
{ "select": { "kind": "light", "roomId": "…uuid" } }
{ "select": { "capability": "onOff", "zoneId": "…uuid" } }
```

A selector picks up devices added later; `endpointId` is optional and best left
out, so the hub picks the endpoint that can do the command.

**Triggers**

```json
{ "kind": "manual" }
{ "kind": "schedule", "at": "22:30", "days": [1, 2, 3, 4, 5] }
{ "kind": "interval", "everyMs": 900000 }
{ "kind": "deviceState", "target": {…}, "path": "sensors.occupied", "op": "eq", "value": true }
{ "kind": "deviceState", "target": {…}, "path": "sensors.temperatureCenti", "op": "gt", "value": 2600, "for": 600000 }
{ "kind": "deviceEvent", "target": {…}, "button": "left", "gesture": "double" }
```

- Times are `HH:MM` in the home's timezone (`GET /api/v1/settings/timezone`);
  days are 0 = Sunday … 6 = Saturday, and leaving `days` out means every day.
  A schedule missed while the hub was down does not fire late. `everyMs` is at
  least 60 000.
- **A schedule has no date, so it repeats** on its days until it is switched
  off. "Tomorrow at ten" is a rule that fires every week unless the person
  switches it off afterwards — say so before saving one, or suggest they do
  the thing themselves at the time.
- `deviceState` fires on the **crossing**, not on every report while it holds.
- **A threshold on a reading that moves by itself** — temperature, humidity,
  illuminance, pressure, power, energy, flow, PM2.5, CO₂ — **must** carry `for`
  (milliseconds it has to stay there) or `hysteresis` (a band, in the path's
  own unit, it must come back through), or the rule is refused.
- `op` is `eq`, `ne`, `lt`, `lte`, `gt`, `gte` or `changed` (no `value`).
- Readable paths include `onOff`, `level.current`, `colorTemperature.mireds`,
  `thermostat.localTemperatureCenti`, `lock`,
  `covering.currentPositionLiftPercent100ths`, `sensors.temperatureCenti`,
  `sensors.humidityCenti`, `sensors.occupied`, `sensors.contactClosed`,
  `sensors.illuminanceLux`, `battery.percent`, `power.activeMilliwatts`,
  `reachable` — the capabilities catalog has the full list. Values are in the
  canonical units.

**Conditions**

```json
{ "kind": "timeRange", "from": "22:00", "to": "06:00" }
{ "kind": "dayOfWeek", "days": [0, 6] }
{ "kind": "deviceState", "target": {…}, "path": "sensors.contactClosed", "op": "eq", "value": false }
{ "kind": "automationActive", "automationId": "…uuid", "is": true }
{ "kind": "any", "conditions": [ … ] }
{ "kind": "not", "condition": { … } }
```

`from` later than `to` is one night, not an empty window.

**Actions**

```json
{ "kind": "deviceCommand", "target": {…}, "command": { "type": "power", "on": false } }
{ "kind": "wait", "ms": 120000 }
{ "kind": "runAutomation", "automationId": "…uuid" }
{ "kind": "setAutomationActive", "automationId": "…uuid", "active": true }
{ "kind": "setAutomationEnabled", "automationId": "…uuid", "enabled": false }
{ "kind": "logActivity", "message": "The porch light came on" }
```

`command` is exactly the device command vocabulary (see
[devices-and-commands.md](devices-and-commands.md)), except that learning,
saving, renaming and deleting IR codes are not actions. A `wait` is at most
fifteen minutes and does not survive a restart; anything longer is a schedule.

## An example

Porch light on at sunset is not expressible (there is no sun trigger); a fixed
time is:

```json
{
  "name": "Porch light in the evening",
  "triggers": [{ "kind": "schedule", "at": "19:30" }],
  "actions": [
    { "kind": "deviceCommand",
      "target": { "deviceIds": ["…porch light uuid"] },
      "command": { "type": "power", "on": true } }
  ]
}
```

A mode with an "off" side:

```json
{
  "name": "Movie night",
  "triggers": [{ "kind": "manual" }],
  "actions":    [{ "kind": "deviceCommand", "target": { "select": { "kind": "light", "roomId": "…" } },
                   "command": { "type": "setLevel", "level": 40 } }],
  "offActions": [{ "kind": "deviceCommand", "target": { "select": { "kind": "light", "roomId": "…" } },
                   "command": { "type": "setLevel", "level": 254 } }]
}
```

## Why it fired

`GET /api/v1/automations/{automationId}/runs` answers each firing with its
`trigger`, `cause` (a sentence), `outcome` (`ran`, `skipped`, `refused`,
`failed`, `interrupted`) and the commands sent **and refused** — the hub's own
guards decline to flap a relay, and the trace says so.

## Templates

`GET /api/v1/automations/templates` lists presets with the inputs each needs;
`POST /api/v1/automations/templates/{key}` with those inputs installs one — it
may install more than one rule, all switched off.
