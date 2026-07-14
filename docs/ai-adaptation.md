# AI device adaptation

Zigbee is an open ecosystem with tens of thousands of device models; no static
mapping table covers them all. When the hub meets a device it can't fully
place, it can ask an LLM to generate the mapping — turning "unsupported
device" into a one-time, self-healing event.

## When it triggers

1. A Zigbee device's static exposes mapping yields **no capabilities**, or
   leaves meaningful exposed properties unmapped (vendor-specific enums,
   unusual units), or Zigbee2MQTT itself doesn't know the device.
2. **At runtime**, a device publishes a payload key that neither the static
   profile nor an existing AI mapping declares — a new, uninterpretable
   parameter. The adapter debounces (~5 s), then requests a fresh mapping
   grounded in the device's recent payloads. Each unknown key is asked about
   at most once per run.
3. The owner explicitly requests `POST /api/v1/devices/:id/remap`.

**Without a configured API key nothing is sent anywhere** — the device simply
appears with whatever mapped statically, flagged `needsReview: true`.

## Bring your own key

The owner configures a provider in the app
(`PUT /api/v1/settings/ai {"provider":"anthropic"|"openai","model"?,"apiKey"}`).
The key is encrypted with the hub's local AES-256-GCM secret, stored in
Postgres, never returned by any API, and used only to call the configured
provider. Defaults: `claude-fable-5` (Anthropic) / `gpt-5.1` (OpenAI);
override with `model`.

**Privacy note:** when a mapping is generated, the device's *published
schema* — its Zigbee2MQTT exposes definition, vendor/model strings, and up to
the last 3 raw state payloads of that device — is sent to your chosen
provider. No home names, member names, tokens, or other hub data ever leave
the machine.

## What the model produces: MappingDescriptor

The model must emit a **declarative** document (structurally constrained:
Anthropic via a forced tool with the descriptor's JSON schema; OpenAI via
`response_format: json_schema`; zod-validated again on receipt — it is
interpreted, never executed):

```json
{
  "version": 1,
  "endpoints": [{
    "endpointId": 1,
    "deviceKind": "light",
    "capabilities": ["onOff", "level"],
    "primary": "onOff",
    "stateRules": [
      { "property": "state", "to": "onOff",
        "transform": {"kind": "enumMap", "map": {"ON": 1, "OFF": 0}} },
      { "property": "dim_level", "to": "level.current",
        "transform": {"kind": "scale", "fromMin": 0, "fromMax": 1000, "toMin": 1, "toMax": 254} }
    ],
    "commandRules": [
      { "intent": "power", "property": "state",
        "transform": {"kind": "boolMap", "whenTrue": "ON", "whenFalse": "OFF"} },
      { "intent": "setLevel", "property": "dim_level",
        "transform": {"kind": "scale", "fromMin": 1, "fromMax": 254, "toMin": 0, "toMax": 1000} }
    ]
  }]
}
```

- **stateRules** run device → canonical: payload property (dotted paths
  supported) → one of the whitelisted canonical state paths, through a
  transform (`identity`, `multiply`, `scale`, `celsiusToCenti`,
  `invertPercentTo100ths`, `boolMap`, `enumMap`). The string-typed
  `event.action`/`event.button`/`event.gesture` paths adapt vendor event
  enums into the event capability; writing any of them auto-stamps
  `event.at`.
- **commandRules** run canonical → device: intent value → payload key
  (+ optional `constPayload`), with `enumMap` reversed automatically.
- Multi-endpoint devices declare several endpoints (`state_l1` → endpoint 1,
  `state_l2` → endpoint 2, …).

The descriptor **overlays** the static exposes mapping: the hub keeps running
its built-in rules and applies the descriptor's rules on top (the descriptor
wins on conflicts, endpoint structures are merged). The model is therefore
asked to map only what the static mapper left over.

Validation is layered: JSON-schema-constrained generation → zod parse →
sanity checks (unique endpoints, primary ∈ capabilities, every rule's target
path belongs to a declared capability). Anything failing is cached as
`rejected` and the device stays in needs-review.

## Caching

Accepted descriptors are cached in the `ai_mappings` table keyed by a sha256
of the device's canonical schema (vendor + model + exposes) — every further
device of the same model maps instantly and for free, across renames and
re-pairings. `POST /devices/:id/remap` invalidates and regenerates.

## Future work

- Generating Zigbee2MQTT **external converters** for devices Z2M itself
  doesn't support and loading them at runtime
  (`zigbee2mqtt/bridge/request/converter/save`).
- A community mapping exchange so one person's AI mapping helps everyone
  (opt-in).
