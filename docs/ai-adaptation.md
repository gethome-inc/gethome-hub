# AI device adaptation

This is **layer 3** of the "nothing is unsupported by default" model
([zigbee.md](zigbee.md) → "The three layers of device support"; design rule #6
in [architecture.md](architecture.md)). Layers 1–2 are static: typed
capabilities, then a generic **custom field** for every leftover parameter (so
nothing is unusable without a key — see [device-schema.md](device-schema.md)).
Layer 3 fills what remains: for the genuine gaps a **mapping agent** — a
tool-use loop on the Anthropic Messages API that can search and read the web —
researches the device and generates a mapping, turning "unsupported device"
into a one-time, self-healing event, and upgrading generic fields to typed
capabilities.

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

## What can reach the agent, and what cannot

**The only input is a device.** The hub's broker carries a great deal that is
not one — permit-join requests, Zigbee2MQTT's own log, bridge status, the hub's
own commands — and an app can now watch all of it (`docs/api.md`, "Opt-in
streams"). None of that is ever researched at somebody's expense, and the rule
is enforced rather than merely observed:

- the agent's only caller is device adoption, driven by the retained
  `bridge/devices` registry;
- `notDeviceShaped()` (`src/ai/mapper.ts`) refuses anything without an IEEE
  address and a published schema, refuses the coordinator — which is the radio,
  not a device — and refuses a `bridge/…` name. `test/ai-boundary.test.ts` pins
  it;
- the system prompt says the same thing, so a run that somehow received
  something else refuses instead of inventing a mapping for a model that does
  not exist.

**And there is a switch.** `ai_enabled` is the owner's, deliberately separate
from whether a credential is stored: "stop spending my money on this for now"
and "forget my API key" have very different costs to undo, and deleting the key
used to be the only way to ask for the first. It defaults to on, so a hub
configured before it existed behaves exactly as it did. It is checked in
`src/ai/lazy.ts` beside `hasKey` — so the module is not even imported — and
again in `resolveProvider()` for a mapper somebody constructed directly. An
explicitly requested run (`POST /devices/:id/remap`, `POST …/repair`) answers
`409 ai_disabled`, which is a different refusal from `409 ai_not_configured`
because an app has to be able to say which of the two a person needs to change.

## The mapping agent

Adaptation runs as a real agent, not a single model call: the hub drives a
tool-use loop against the [Messages
API](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview)
(`@anthropic-ai/sdk`), giving the model tools to research the device and
iterate until its mapping passes validation. Everything runs inside the hub
process — no subprocess, no second runtime.

**What one run looks like** (`src/ai/agent.ts`):

1. The hub builds the whole **research brief** into the task message
   (`src/ai/prompts.ts`):
   - vendor/model/description and the full Z2M exposes tree
   - the device's recent raw payloads (the last 5)
   - what layers 1–2 already produced — capabilities per endpoint, generic
     fields, and the `uncovered`/`unmapped` lists
   - the device's likely **zigbee2mqtt.io page URL**, derived from the model
     string. This is load-bearing rather than a convenience: the server-side
     `web_fetch` tool will only fetch URLs that already appear in the
     conversation, so a page the hub does not name is unreachable however
     well the model guesses it.
2. The model researches with the **server-side** `web_search_20260209` and
   `web_fetch_20260209` tools. They execute on Anthropic's infrastructure, so
   the hub itself needs no egress beyond `api.anthropic.com`. The prompt sends
   it to the device's Zigbee2MQTT page first and treats that page as **the
   source of truth when it works**: those pages are generated from the same
   zigbee-herdsman-converters definition that produces the payloads this hub
   receives, so a page that loads, is the right device, and covers the
   properties in question settles them — the agent is told to stop there and
   submit rather than spend searches corroborating it. Searching further is
   for the three ways that page can fail: a 404 (the URL is derived from a
   model string, and the real page may be named differently), the wrong
   device, or a page that says nothing about the property in hand. Then it
   searches the vendor and model, then the property or enum itself, falling
   back to the converters source, the vendor's documentation, and Home
   Assistant / ZHA discussions. Either way it is told to leave a property out
   (or give it a `customField`) rather than invent a unit.
3. The **only client-side tool, and the only way to answer**, is
   `submit_mapping`. Its `input_schema` is generated from the live descriptor
   zod schema, so it cannot drift from what the mapper accepts — and because
   the whitelisted canonical state paths are a zod enum inside that schema,
   the model receives them without a separate reference file. The handler
   re-validates with the schema plus sanity checks and returns any problems
   as a tool error, so the model fixes its descriptor and resubmits within
   the same run. It is deliberately **not** a `strict` tool: strict tool use
   constrains the shape but cannot express the semantic rules (a declared
   capability needs a rule that feeds it, `primary` has to be one of the
   capabilities), so a real error message is worth more than a narrowed
   schema. Prose is not an answer — a run gets two reminders, then ends
   without a mapping.
4. **Guardrails**: at most 40 turns, a per-run cost cap computed from token
   usage (`src/ai/models.ts`), a 10-minute wall-clock watchdog, one run at a
   time hub-wide, and concurrent requests for the same device model share a
   single run. The system prompt carries a cache breakpoint, so every turn
   after the first reads the large static prefix at cache rates.

The result is still **data, not code**: whatever the model submits is
re-validated by the mapper and interpreted rule-by-rule exactly like any
other MappingDescriptor. Model output is never executed.

### Why not the Claude Agent SDK

This ran on the Claude Agent SDK until [the move described
below](#the-move-off-the-claude-agent-sdk), and on paper that was the better
fit — it brought its own agent loop, file tools and permission model. What it
also brought was a 276 MB native `claude` executable, which was **74% of
everything a hub downloads** and a ~315 MB subprocess per run. Only ~91 MB of
that is anonymous memory; the other ~224 MB is the binary's own pages mapped
in from disk, which the kernel evicts under pressure and re-reads. On a
Raspberry Pi Zero 2 W that does not end in an OOM kill — it ends in
thrashing, re-reading a 276 MB executable off an SD card inside a cgroup
already at its `MemoryHigh` mark. Measured under a 200 MB cap on an NVMe
machine, a trivial invocation took 1.9× as long with 1.1M reclaim events; at
100 MB it stopped making progress entirely. AI adaptation was therefore
installed-but-unusable on the smallest board the hub supports.

## Bring your own account

The owner connects their own Anthropic account in the app
(`PUT /api/v1/settings/ai`) with an **API key** (`sk-ant-api…`) from
[platform.claude.com](https://platform.claude.com). Usage is billed per token
to the owner's API account.

> **Claude subscription tokens are no longer accepted.** The Agent SDK could
> authenticate with an `sk-ant-oat…` token minted by `claude setup-token`;
> the Messages API cannot, and that is the one thing this move cost. The hub
> refuses such a token at `PUT /settings/ai` with a message naming what to
> paste instead, and a hub that still has one stored reports
> `legacySubscriptionToken: true` and skips runs with an `auth_failed` status
> rather than failing with an unreadable 401.

The wire format:

```
PUT /api/v1/settings/ai
{ "apiKey": "sk-ant-api…", "model"?: "claude-…" }

GET /api/v1/settings/ai
{ "provider": "anthropic", "model": null, "hasKey": true,
  "legacySubscriptionToken": false,
  "status": { "lastError"?: { "kind", "message", "at", "resetAt"? },
              "lastRun"?:   { "at", "ok", "costUsd"?, "model"? } } }
```

An `authType` field from an older app is accepted and ignored rather than
rejected, so a Studio build mid-rollout keeps working.

The secret is encrypted with the hub's local AES-256-GCM secret, stored in
the hub's database, never returned by any API, and used only to run the
mapping agent.

**Model.** Default **`claude-opus-5`**; override with `model`. The choice is
an allowlist, not a free string (`src/ai/models.ts`), because the
`_20260209` research tools only exist on Opus 4.6+ and Sonnet 4.6+ — pointing
the hub at Haiku or a 4.5-era model would not degrade the run, it would 400
it. `PUT /settings/ai` refuses an unsupported model and names the ones that
work: `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`,
`claude-opus-4-6`, `claude-sonnet-5`, `claude-sonnet-4-6`. Opus-tier is the
default deliberately — a wrong mapping is cached per device model and quietly
shapes what the apps show until somebody remaps it, which is worth more than
the difference in per-run cost.

**Cost.** A typical adaptation run costs cents, bounded by the per-run cap.
The Agent SDK used to report `total_cost_usd`; the hub now adds up its own
token usage against list prices (input, output, cache reads at 0.1×, cache
writes at 1.25×, web searches at $10/1000), so `status.lastRun.costUsd` is an
**estimate**. An unknown model falls back to the most expensive supported
tier, so the cap can only ever trip early.

## When the account fails: taxonomy & backoff

Agent runs can fail for reasons that have nothing to do with the device.
The hub classifies them (`src/ai/errors.ts`) and reacts accordingly.

The **HTTP status is now the primary signal** (`classifyApiError`). Under the
Agent SDK it could not be: failures arrived as subprocess output with the
status code lost somewhere in the middle, so everything was regex-matched
against error text. That fallback still exists for the two cases a status
cannot separate, but it is no longer the main path.

| `status.lastError.kind` | Typical cause | Detected via |
|---|---|---|
| `rate_limited` | API 429 / too many requests | HTTP 429 (+ `retry-after` when present) |
| `usage_limit` | an account usage or spend cap is exhausted | HTTP 429 whose body names a cap, reset time parsed when present |
| `auth_failed` | invalid/revoked key, or a stored subscription token | HTTP 401/403; also raised before any request when the saved credential is a legacy subscription token |
| `billing` | API credit exhausted | HTTP 402, or a 400 whose body is really a credit problem |
| `overloaded` | API 529 / capacity | HTTP 529 or any 5xx |
| `network` | transport failures, unclassified errors | a throw that never reached HTTP |
| `aborted` | the hub's own 10-minute watchdog fired | watchdog |

A **400 is deliberately not in this table**: a malformed request is the hub's
own bug, and arming a backoff gate over it would hide it behind a retry
timer. It surfaces as a failed run instead.

All of the kinds above are **transient**: nothing is cached, the device keeps
its static mapping (and `needsReview` if applicable), and a **backoff gate**
opens — no further runs are attempted until it expires. The gate uses the
provider's reset time when one was communicated (a `retry-after` header
usually carries one), otherwise an escalating ladder
(1 min → 5 min → 30 min → 2 h). Any *completed* run — even one whose
descriptor was rejected — proves the account works and clears the gate.

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
  vendor/model/description strings — plus up to the last 5 raw state payloads
  of that device, sent to Anthropic as the agent's task;
- **web searches and page fetches** the model chooses to run, containing the
  device's vendor/model/property names (it is instructed to include nothing
  else), which reach the search backend like any web search.

Those searches and fetches execute **server-side, on Anthropic's
infrastructure** — the hub opens no connection to zigbee2mqtt.io or anywhere
else, and needs no outbound access beyond `api.anthropic.com`. A hub behind a
restrictive firewall therefore still gets full device research.

No home names, member names, tokens, or any other hub data ever leave the
machine — and, since the hub gained a traffic inspector, it is worth saying
explicitly that **none of that traffic is an input either**: see "What can
reach the agent, and what cannot" above. Without a configured credential, or
with the switch off, nothing is sent at all.

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

## The library: caching, carrying and repairing

Accepted descriptors are cached in the `ai_mappings` table keyed by a sha256 of
the device's canonical schema (vendor + model + exposes; `exposesHash()` lives
with the exposes mapper, because it is a property of the device's published
schema rather than of AI). Every further device of the same model maps
instantly and for free, across renames and re-pairings.
`POST /devices/:id/remap` invalidates and regenerates.

That cache is now a **library** with five routes over it
(`src/ai/library.ts`, `docs/api.md`). Three things it makes possible that the
cache alone did not:

- **Carrying knowledge between hubs.** A hub that was reinstalled used to ask
  the agent about every device again. Download the entry, upload it to the
  other hub.
- **Bringing your own.** A hand-written descriptor, or one copied from a device
  a firmware revision away, is uploaded the same way. A mismatched
  `exposesHash` is accepted and flagged rather than refused — that case is the
  point.
- **Repairing instead of discarding.** A descriptor the hub refuses is stored
  *with its problems*, and `POST …/repair` hands both to the agent with a
  prompt that says fix what is named and leave the rest alone. "Invalid, try
  again" is a dead end for somebody who cannot read a validation path, and the
  research is already in the file.

`source` (`ai` | `imported`) and `status` (`generated` | `rejected`) are
separate columns on purpose: an imported descriptor can be broken and a
generated one can be perfect, and the offer to repair depends on both.

A cached `rejected` entry is never re-asked automatically — that is what stops
the hub re-running the agent against a model it cannot get right — but `repair`
bypasses the cache by construction, because a rejection is exactly what it is
there to fix.

## The run log

One row per run in `ai_runs`, served by `GET /api/v1/ai/runs` and streamed live
on the `ai` WebSocket channel: what was sent, every `web_search` query, every
`web_fetch` URL, what was submitted and why it was refused, plus cost, turns
and duration.

It is a **summary, never a transcript.** Model prose is the largest thing a run
produces and the least useful to read later, so it is not stored. Bounded at
both ends — 40 steps per run, 60 runs retained, `detail` truncated at 2 KB —
which is tens of kilobytes on a machine whose disk is an SD card.

Before it, the hub recorded exactly two facts under one settings key (the last
run and the last error), so once a second device had been adopted there was no
answer at all to "why does this one need review?" or "what am I being charged
for?". Everything the agent did lived in a log line on a machine nobody is
looking at. The live stream matters for the same reason: adopting an unknown
device takes minutes and used to produce no output until it was over.

## Implementation map

Everything lives in `src/ai/`; the module never imports the API or adapters
(it implements the `ZigbeeAiAssist` interface the Zigbee adapter defines):

| File | Role |
|---|---|
| `descriptor.ts` | The MappingDescriptor DSL: zod schema, sanity checks, and the interpreter (`applyStateRules` / `buildCommandPayload`). Dependency-free; unchanged by the agent — output is data, not code. |
| `agent.ts` | The Messages API tool-use loop: builds the tool set + guardrails, validates `submit_mapping` submissions, resumes `pause_turn`, classifies failures, reports run stats. Exports the `MappingProvider` seam the mapper (and tests) use. |
| `models.ts` | The model allowlist (what can drive the server-side research tools) and the list-price table the per-run cost cap and `costUsd` estimate are computed from. Dependency-free, so the API layer can validate `model` without pulling in the AI stack. |
| `errors.ts` | The failure taxonomy: `AiUnavailableError` kinds, HTTP-status classification (`classifyApiError`), error-text fallback, reset-time parsing. |
| `prompts.ts` | The system prompt (canonical capabilities/paths/units/transforms + worked examples + research rules), the per-device task prompt carrying the whole research brief, and the zigbee2mqtt.io page URL. |
| `mapper.ts` | Orchestration: cache lookups, one-run-at-a-time serialization, per-model in-flight dedupe, the backoff gate, validation, storage, and interpretation into an `AppliedAiMapping` for the adapter. |

Related pieces elsewhere: credential + status storage in
`src/core/settings.ts` (AES-256-GCM via `src/core/crypto.ts`), the owner-only
REST endpoints in `src/api/server.ts`, and the trigger points in
`src/adapters/zigbee/adapter.ts` (adoption, runtime unknown-key watch,
explicit remap).

Tests: `test/ai-agent.test.ts` (failure classification, the model allowlist
and cost estimate, the submit-tool validation loop, the research brief, and
the agent loop itself against a mocked Messages API — tool set, prompt
caching, `pause_turn` resumption, resubmission after validation errors, and
the turn and cost caps), `test/ai-descriptor.test.ts` (DSL + mapper behavior
incl. backoff and dedupe, against a temporary SQLite file), and
`test/integration/zigbee-adapter.test.ts` (runtime adaptation end-to-end over
a real broker).

## The move off the Claude Agent SDK

The mapping agent originally ran on `@anthropic-ai/claude-agent-sdk` (Claude
Code packaged as a library), which spawned a bundled runtime as a subprocess
per run. It was replaced with a tool-use loop on the Messages API. What that
changed, measured rather than estimated:

| | Agent SDK | Messages API |
|---|---|---|
| Production `node_modules`, unpacked | 534 MB | 238 MB |
| **Bundle a Pi downloads** (`.tar.gz`) | **117 MB** | **29 MB** |
| The AI dependency itself | 290 MB (276 MB of it one native binary) | 11 MB |
| Per-run footprint | a ~315 MB subprocess | HTTP requests from the hub process |
| Runs on a Zero 2 W | no — thrashes, outlives the watchdog | yes |
| Claude subscription tokens | supported | **not supported** |

Three consequences beyond the numbers:

- **AI adaptation works on every board the hub supports.** That was the
  point. The subprocess needed ~91 MB of anonymous memory plus ~224 MB of
  mapped binary on a board with roughly 76 MB of headroom once the OS, the
  hub and Zigbee2MQTT have their share.
- **The `@modelcontextprotocol/sdk → hono` chain left the tree.** CLAUDE.md
  names it as one of the transitive paths this repo has shipped
  vulnerabilities through; removing the Agent SDK removed 1266 lines of
  lockfile and that whole subtree with it.
- **Failure handling got better, not just smaller.** Availability failures
  are classified from HTTP status codes instead of regexes over subprocess
  output, and `retry-after` now feeds the backoff gate directly.

The cost is the subscription-token credential, which the Messages API cannot
authenticate. Hubs that stored one are detected and told what to do rather
than left to fail on the next device announcement.

Two leftovers a hub upgraded from an older build may still have on disk, both
now unused and safe to delete by hand: `<DATA_DIR>/claude-agent/` (the old
runtime's `CLAUDE_CONFIG_DIR`) and `<DATA_DIR>/ai-agent/` (per-run research
workspaces). The hub no longer writes to either — one incidental benefit is
that a mapping run now touches the SD card only to store its result.

## Future work

- Generating Zigbee2MQTT **external converters** for devices Z2M itself
  doesn't support and loading them at runtime
  (`zigbee2mqtt/bridge/request/converter/save`).
- A community mapping exchange so one person's AI mapping helps everyone
  (opt-in).
