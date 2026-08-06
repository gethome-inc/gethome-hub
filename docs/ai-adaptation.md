# AI device adaptation

This is **layer 3** of the "nothing is unsupported by default" model
([zigbee.md](zigbee.md) → "The three layers of device support"; design rule #6
in [architecture.md](architecture.md)). Layers 1–2 are static: typed
capabilities, then a generic **custom field** for every leftover parameter (so
nothing is unusable without a key — see [device-schema.md](device-schema.md)).
Layer 3 fills what remains: for the genuine gaps a **mapping agent** —
a full autonomous agent built on the Claude Agent SDK — researches the device
and generates a mapping, turning "unsupported device" into a one-time,
self-healing event, and upgrading generic fields to typed capabilities.

## When it triggers

1. A property has **no representation at all** (`uncovered`) — a shape even a
   generic field can't hold (composites/lists), or a device Z2M barely
   supports — or the static mapping yields **no capabilities**.
2. **At runtime**, a device publishes a payload key that neither the static
   profile nor an existing AI mapping declares — a new, uninterpretable
   parameter. The adapter debounces (~5 s), then requests a fresh mapping
   grounded in the device's recent payloads. Each unknown key is asked about
   at most once per run.
3. The owner explicitly requests `POST /api/v1/devices/:id/remap` — including
   to **upgrade** working generic fields into richer typed capabilities.

Parameters that already became generic custom fields do **not** auto-trigger
the AI: they are controllable as-is, so a device with only fielded leftovers
uses no agent runs.

**Without a configured credential nothing is sent anywhere** — the device
simply appears with whatever mapped statically (typed capabilities + generic
fields), flagged `needsReview: true` only if something is still `uncovered`.

## The mapping agent

Adaptation runs as a real agent, not a single model call: the hub embeds the
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)
(`@anthropic-ai/claude-agent-sdk` — Claude Code packaged as a library), which
spawns a bundled, sandboxed Claude Code runtime as a subprocess per run. The
agent can read its research material, search the web for the device, and
iterate until its mapping passes validation.

**What one run looks like** (`src/ai/agent.ts`):

1. The hub writes a throwaway **research workspace** (`src/ai/context.ts`)
   under `<DATA_DIR>/ai-agent/ctx-…/` and makes it the agent's working
   directory:
   - `device.json` — vendor/model/description + the full Z2M exposes tree
   - `samples.json` — the device's recent raw payloads
   - `static-mapping.json` — what layers 1–2 already produced (capabilities
     per endpoint, generic fields, the `uncovered`/`unmapped` lists)
   - `schema-reference.md` — the exact MappingDescriptor JSON schema and the
     whitelisted state paths, generated from the live code so it can't drift
2. `query()` starts the agent with a **research-only tool set**: `Read`,
   `Glob`, `Grep` (scoped to that workspace — it is the process cwd and the
   only content the hub prepared), plus `WebSearch` and `WebFetch` for device
   research (Zigbee2MQTT device pages and the zigbee-herdsman-converters
   source are the usual references). `Bash`, `Write`, and `Edit` are
   disallowed; `permissionMode: 'dontAsk'` denies anything unlisted without
   ever prompting; `settingSources: []` keeps the host machine's Claude
   settings out of the run.
3. The agent's **only output channel** is `submit_mapping` — an in-process
   MCP tool the hub registers. Its handler validates the submission with the
   descriptor's zod schema plus sanity checks and returns any problems as a
   tool error, so the agent fixes its descriptor and resubmits within the
   same session. Prose answers are ignored; a run without a submission is a
   failed run.
4. **Guardrails**: at most 40 agentic turns, a hard cost cap per run
   (`maxBudgetUsd`), a 10-minute wall-clock watchdog, one agent subprocess at
   a time hub-wide, and concurrent requests for the same device model share a
   single run. Session persistence is disabled and the runtime's home is
   pinned to `<DATA_DIR>/claude-agent/` (`CLAUDE_CONFIG_DIR`), so nothing
   leaks into the service user's `$HOME`.

The result is still **data, not code**: whatever the agent submits is
re-validated by the mapper and interpreted rule-by-rule exactly like any
other MappingDescriptor. Model output is never executed.

## Bring your own account

The owner connects their own Anthropic account in the app
(`PUT /api/v1/settings/ai`); two credential kinds are accepted:

- **API key** (`authType: "api_key"`) — an Anthropic API key
  (`sk-ant-api…`) from [platform.claude.com](https://platform.claude.com).
  Usage is billed per token to the owner's API account.
- **Claude subscription token** (`authType: "oauth_token"`) — a long-lived
  OAuth token minted from the owner's Claude Pro/Max subscription by running
  `claude setup-token` on their own computer (requires the Claude Code CLI
  and a browser) and pasting the resulting `sk-ant-oat…` value. Runs then
  draw on the subscription's usage windows instead of per-token billing.

> **Policy note.** Anthropic's terms do not allow third-party products to
> offer claude.ai subscription login without prior approval; API keys are the
> officially sanctioned path for programmatic use. GetHome Hub is self-hosted
> — the token is created by you, on your machine, for your own hub — but if
> you want the unambiguously supported route, use an API key.

The wire format:

```
PUT /api/v1/settings/ai
{ "authType": "api_key" | "oauth_token", "apiKey": "<key or token>", "model"?: "claude-…" }

GET /api/v1/settings/ai
{ "provider": "anthropic", "authType": "api_key", "model": null, "hasKey": true,
  "status": { "lastError"?: { "kind", "message", "at", "resetAt"? },
              "lastRun"?:   { "at", "ok", "costUsd"?, "model"? } } }
```

The secret is encrypted with the hub's local AES-256-GCM secret, stored in
the hub's database, never returned by any API, and used only to run the mapping agent.
Default model: **`claude-opus-4-8`**; override with `model`. A typical
adaptation run costs cents (bounded by the per-run budget cap).

## When the account fails: taxonomy & backoff

Agent runs can fail for reasons that have nothing to do with the device.
The hub classifies them (`src/ai/errors.ts`) and reacts accordingly:

| `status.lastError.kind` | Typical cause | Detected via |
|---|---|---|
| `rate_limited` | API 429 / too many requests | error text |
| `usage_limit` | subscription 5-hour/weekly window exhausted | structured `rate_limit_event` from the runtime, or error text (reset time parsed when present) |
| `auth_failed` | invalid/revoked key, expired OAuth token | error text |
| `billing` | API credit exhausted | error text |
| `overloaded` | API 529 / capacity | error text |
| `network` | transport/spawn failures, unclassified execution errors | thrown errors |
| `aborted` | the hub's own 10-minute watchdog fired | watchdog |

All of these are **transient**: nothing is cached, the device keeps its
static mapping (and `needsReview` if applicable), and a **backoff gate**
opens — no further runs are attempted until it expires. The gate uses the
provider's reset time when one was communicated (subscription limits usually
carry one), otherwise an escalating ladder (1 min → 5 min → 30 min → 2 h).
Any *completed* run — even one whose descriptor was rejected — proves the
account works and clears the gate.

The current state is always visible on `GET /api/v1/settings/ai` as
`status.lastError` / `status.lastRun`, so the apps can show "AI paused:
usage limit — resets 23:00" instead of failing silently.

Distinct from all of the above: a run that *completes* but produces an
**invalid descriptor** is cached as `rejected` (no re-ask for that device
model until an explicit remap), and a run where the agent gives up (out of
turns/budget, no submission) is simply logged and retried on the next
natural trigger. Only descriptors are ever cached — never account failures.

## Privacy

When a mapping is generated, the following leaves the machine:

- the device's *published schema* — its Zigbee2MQTT exposes definition and
  vendor/model/description strings — plus up to the last 3 raw state payloads
  of that device, sent to Anthropic as the agent's task;
- **web searches** the agent chooses to run, containing the device's
  vendor/model/property names (it is instructed to include nothing else),
  which reach the search backend like any web search.

No home names, member names, tokens, or any other hub data ever leave the
machine. Without a configured credential, nothing is sent at all.

## What the agent produces: MappingDescriptor

The agent must submit a **declarative** document through the `submit_mapping`
tool (schema-constrained at the tool boundary, zod-validated again by the
mapper — it is interpreted, never executed):

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
- **customFields** are the universal fallback: for a parameter that fits no
  typed capability, the agent declares a generic control
  (`{id, label, control: toggle|slider|select|value, settable, …}`) instead of
  forcing a wrong mapping. The `id` is the payload property; the hub reads the
  value straight from it and writes it back through `setCustomField` — no
  stateRules needed. This is what lets the AI make *any* device controllable,
  not only devices that happen to fit the typed schema.
- Multi-endpoint devices declare several endpoints (`state_l1` → endpoint 1,
  `state_l2` → endpoint 2, …).

The descriptor **overlays** the static exposes mapping: the hub keeps running
its built-in rules and applies the descriptor's rules on top (the descriptor
wins on conflicts, endpoint structures are merged, and a typed mapping
supersedes the static generic field for that property). The agent is asked to
map what the static mapper left generic — upgrading fields to typed
capabilities where one fits, and covering anything still `uncovered`.

Validation is layered: the `submit_mapping` tool schema constrains generation
→ the tool handler zod-parses and sanity-checks (unique endpoints, primary ∈
capabilities, every rule's target path belongs to a declared capability) and
bounces failures back to the agent for an in-session retry → the mapper
re-validates the final submission. A descriptor that still fails is cached as
`rejected` and the device stays in needs-review.

## Caching

Accepted descriptors are cached in the `ai_mappings` table keyed by a sha256
of the device's canonical schema (vendor + model + exposes) — every further
device of the same model maps instantly and for free, across renames and
re-pairings. `POST /devices/:id/remap` invalidates and regenerates.

## Implementation map

Everything lives in `src/ai/`; the module never imports the API or adapters
(it implements the `ZigbeeAiAssist` interface the Zigbee adapter defines):

| File | Role |
|---|---|
| `descriptor.ts` | The MappingDescriptor DSL: zod schema, sanity checks, and the interpreter (`applyStateRules` / `buildCommandPayload`). Dependency-free; unchanged by the agent — output is data, not code. |
| `agent.ts` | The Agent SDK runner: builds the tool set + guardrails, registers the `submit_mapping` MCP tool, runs `query()`, classifies failures, reports run stats. Exports the `MappingProvider` seam the mapper (and tests) use. |
| `context.ts` | The per-run research workspace (device/samples/static-mapping/schema-reference files) and the `CLAUDE_CONFIG_DIR` home under `DATA_DIR`. |
| `errors.ts` | The failure taxonomy: `AiUnavailableError` kinds, error-text classification, reset-time parsing. |
| `prompts.ts` | The system prompt (canonical capabilities/paths/units/transforms + worked examples + agent working rules) and the per-device task prompt. |
| `mapper.ts` | Orchestration: cache lookups, one-run-at-a-time serialization, per-model in-flight dedupe, the backoff gate, validation, storage, and interpretation into an `AppliedAiMapping` for the adapter. |

Related pieces elsewhere: credential + status storage in
`src/core/settings.ts` (AES-256-GCM via `src/core/crypto.ts`), the owner-only
REST endpoints in `src/api/server.ts`, and the trigger points in
`src/adapters/zigbee/adapter.ts` (adoption, runtime unknown-key watch,
explicit remap).

Tests: `test/ai-agent.test.ts` (failure classification, submit-tool
validation loop, research workspace), `test/ai-descriptor.test.ts` (DSL +
mapper behavior incl. backoff and dedupe, against a temporary SQLite file), and
`test/integration/zigbee-adapter.test.ts` (runtime adaptation end-to-end over
a real broker).

## Future work

- Generating Zigbee2MQTT **external converters** for devices Z2M itself
  doesn't support and loading them at runtime
  (`zigbee2mqtt/bridge/request/converter/save`).
- A community mapping exchange so one person's AI mapping helps everyone
  (opt-in).
