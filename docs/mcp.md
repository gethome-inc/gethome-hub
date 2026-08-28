# MCP server

The hub speaks the **Model Context Protocol**, so an assistant — Claude, or
anything else that speaks MCP — can look at the home and work it. This document
is canonical for `src/mcp/` and for the wire the apps render setup instructions
from.

Everything here is a face on capability the hub already had. There is no
device, room or command that MCP can reach and `docs/api.md` cannot; what MCP
adds is a vocabulary a language model can use without holding this repository's
unit conventions in its head.

---

## Where it can be reached from

This matters more than anything else in this document, because it is the part
people get wrong, and the answer is not the same for every assistant.

The hub is a device on a home network with a private address and plain HTTP.
Some clients dial it themselves and some do not:

| Client | Reaches `http://<hub>:8420` | How |
|---|---|---|
| **Claude Code** | yes | native HTTP transport with a header |
| **Claude Desktop** | yes, through a bridge | its config takes stdio servers only, so `mcp-remote` proxies |
| **Codex CLI / Codex IDE** | yes | `~/.codex/config.toml`, `url` + `bearer_token_env_var` |
| **ChatGPT** (app and web) | **no** | connectors are stored account-side and **OpenAI's servers make the call** |
| **claude.ai** (web) | **no** | Anthropic's servers make the call; public HTTPS and OAuth only |

The last two rows are not a limitation of this hub. Those products connect to a
connector *from their own infrastructure*, so no amount of work here makes a
`192.168.x.x` address reachable from them — they need a public HTTPS URL, which
means a tunnel. The one worth naming is OpenAI's own
[Secure MCP Tunnel](https://github.com/openai/tunnel-client): an outbound-only
relay that long-polls OpenAI and forwards to a private address, so it opens no
inbound port. **Run it on the Mac, not on the Pi** — it only has to be
somewhere that can reach the hub, and the hub has no memory to spare.

That is also why the token can travel in a URL (below): a tunnelled client is
usually one you can hand a URL and nothing else.

## Authentication

A bearer token, and deliberately nothing more.

```
POST /api/v1/mcp                 Authorization: Bearer ghm_…
POST /api/v1/mcp/t/ghm_…         (the same token, in the path)
```

The path form exists for clients whose connector UI offers a URL field and no
header field. It is the same token checked the same way; what it costs is that
the secret is now in a URL, which some services log — so the apps offer the
header form first and name this as the fallback.

**There is no OAuth, and the absence of `WWW-Authenticate` on a 401 is
load-bearing.** Claude Code has a known bug where a server that advertises an
OAuth resource makes it *drop* the bearer header it was configured with and
begin a flow this hub cannot finish. So a 401 here is a bare JSON body, there is
no `/.well-known/oauth-protected-resource`, and nothing should add one.

### Tokens are a different table, on purpose

`mcp_tokens` is not `tokens`. A member's token passes `requireMember` and
therefore every route that member's role allows; an MCP token is handed to a
program on somebody's laptop and left in a JSON file for months. Two tables
verified by two functions means an MCP token 401s on every REST route **by
construction**, rather than by a check somebody has to remember to write — and
revoking an assistant does not sign a phone out.

Each token carries:

| Field | Meaning |
|---|---|
| `label` | what a person calls this connection — "Claude Desktop on the MacBook" |
| `memberId` | who minted it. The activity log names them for whatever the assistant does, and ending that membership takes its assistants with it |
| `canControl` | whether this connection may work the home, or only look at it. **Chosen at mint time and never edited** — "let my read-only assistant unlock the door" is a new decision and deserves a new token, not a switch on one that some config file is still holding |
| `revokedAt` | set rather than deleted, so the list can still show what was turned off |

The plaintext is returned by `POST /settings/mcp/tokens` and never again; only
its sha256 is stored, exactly as for a member's token.

## Transport

**Streamable HTTP, stateless.** One `POST` carries one JSON-RPC 2.0 message and
the answer comes straight back as `application/json`. No `Mcp-Session-Id` —
the spec makes it optional, there is no per-session state worth keeping, and not
keeping any is what makes this cost nothing between calls on a Raspberry Pi.

`GET /api/v1/mcp` answers **405**. The endpoint has to exist for both verbs, and
this server never opens a server-initiated stream, so "method not allowed" is
the honest answer rather than an empty SSE channel.

Methods: `initialize`, `notifications/initialized`, `tools/list`, `tools/call`,
`ping`. Anything else is `-32601`.

**Batches are refused** with `-32600`. JSON-RPC batching was removed from MCP in
the 2025-06-18 revision; accepting an array would mean a second path through
every handler, with fan-out and partial failure to get right, for a shape the
spec has dropped.

Version negotiation answers with the client's own version when it is one of
`2026-07-28`, `2025-11-25`, `2025-06-18`, `2025-03-26`, and with our newest
otherwise, leaving the client to decide whether it can live with that.

## Units

**Every tool speaks the units a person speaks** — percent, °C, kelvin, degrees,
and named modes. The wire units in `docs/device-schema.md` never appear in a
tool schema, and the conversion happens in `src/mcp/devices.ts` and
`src/mcp/commands.ts` using `src/schema/units.ts`; nothing there restates a
constant.

This is not politeness. The wire's conventions read as nonsense out of context
and a model given them will act on them: `setLevel` takes 1–254, so "set it to
twelve" becomes 12/254 ≈ 5%; **a covering puts 0 at fully open**, so "close the
blinds" sent as 0 throws them wide. The MCP layer inverts the covering scale so
`openPercent: 100` is fully open, and that inversion exists in exactly one
function.

## Tools

Seven. Small on purpose: a model choosing between seven well-named tools is
more reliable than one choosing between thirty, and every one of these answers
a question somebody actually asks of a house.

| Tool | Does |
|---|---|
| `get_home` | The home's name, its rooms and zones, how many devices there are and how many are on or offline. The orientation call. |
| `list_devices` | Every device, one line each; filter by `room`, `kind`, `state` or `search`. |
| `get_device` | One device in full: every reading in ordinary units, and which actions it accepts. |
| `find_device` | Search by name, room or kind, when a name might be ambiguous. |
| `control_device` | Work a device. Needs `canControl`. |
| `get_device_history` | What one measurement did over the last hour, day or week. |
| `get_activity` | The home's recent history, in the hub's own sentences. |

### Naming a device

Hub ids are UUIDs, which a model will mistype. The `device` parameter therefore
accepts **any** of: the full id, a **≥6-character unique prefix** of it (which
`list_devices` returns as `ref`), or the device's **name**, case-insensitively
and by substring.

**Ambiguity is refused, never guessed.** Two lamps called "Lamp" in two rooms is
an ordinary home, and switching the wrong one is a worse outcome than one more
round trip — so the answer names the candidates with their rooms, which is
exactly what a model needs to ask a better question.

### `list_devices` is deliberately shallow

It returns a line per device, not `EndpointState`. Forty devices of full typed
state is 40–80 KB of JSON and twenty thousand tokens of a model's context spent
before it has decided which device it cares about. The list carries a sentence;
`get_device` carries the picture. The list is capped at 200 rows and says so
when it truncates.

### What a command result promises

`POST /devices/:id/commands` answers 202 because routing is all it does — the
Zigbee adapter publishes to MQTT and the broker takes the message long before
the device does. The truth arrives afterwards on the bus, as a `stateChanged`
or a `commandFailed` (see `docs/zigbee.md`).

So `control_device` sends, then waits up to **1.5 seconds** for one of those,
and answers with whichever happened:

- the device reported new state → it worked, and the summary says what the
  device now *is*;
- the hub reported a failure → it did not work, and the summary is the
  protocol's own words rather than a paraphrase, because only the adapter knows
  what "unreachable" meant here;
- nothing came back in time → **neither**, and the answer says so. On a battery
  device zigbee-herdsman queues the write until the sensor next wakes, which can
  be an hour, so the summary names that and mentions that pressing the device's
  button wakes it. That advice is only added when the device actually reported a
  battery: a mains plug is always listening, and its button is its relay.

Reporting success from the 202 would be the exact lie both apps used to tell
before `commandFailed` existed.

### Annotations

Every tool publishes `readOnlyHint`, `destructiveHint`, `idempotentHint` and
`openWorldHint`, and the values are not decoration — hosts use them to decide
whether to interrupt the person and ask before running something. The spec's
defaults are `destructiveHint: true` and `openWorldHint: true`, so a tool that
says nothing is treated as though it might destroy something in an unbounded
world: left unset, asking "is the back door locked?" would prompt for
confirmation. `control_device` sets `destructiveHint: false` because switching a
lamp is reversible, and `openWorldHint: false` because the set of devices is
closed and known.

### Errors, and the two kinds of failure

A **protocol** fault is a JSON-RPC error the model never sees: no such tool
(`-32601`), arguments that do not fit the schema (`-32602`).

A **tool** that ran and could not do the thing answers normally, with
`isError: true` and a sentence in `content` — because the model is meant to read
the reason and try something else. "There is no device called that" is the
second kind, which is why device lookup returns a sentence rather than throwing.

### Every control is written to the home's history

`control_device` records a `device.command` entry with `data.via = "mcp"` and
`data.client = <the token's label>`, attributed to the member who minted the
token. Both apps render it with no change, and "the kitchen light went off by
itself" is exactly the question the log exists to answer.

## What is deliberately not exposed

An assistant gets the home and its devices. It does **not** get:

| Not exposed | Why |
|---|---|
| Members, invites, roles | Access to the home is a decision a person makes in an app, looking at a list of people. Nothing about it is improved by a model doing it. |
| `hub.update`, the radio switch | Both take the home offline for minutes. A model has no way to know whether now is a good time. |
| Rooms, zones, renames | Reorganising the house is not what "turn the light off" needs, and an assistant that quietly renames things makes the home harder for everyone else to use. |
| Removing or pairing devices | Pairing is a person standing next to hardware; removal is not undone by anything here. |
| The AI settings, the mapping library | The hub's own credential. Not an assistant's business. |

`test/mcp-coverage.test.ts` pins this: every command type, capability kind and
history kind must be either reachable through a tool or named in that file's
excluded map **with a reason**. Adding one to the schema fails the suite until
somebody decides which it is.

## Management routes

All four need `hub.mcp`, which is **owner-only by default**. See `docs/api.md`.

| Route | Does |
|---|---|
| `GET /api/v1/settings/mcp` | `{enabled, tokens: […]}` — never a secret |
| `PUT /api/v1/settings/mcp` | `{enabled}`; logs `mcp.enabled` / `mcp.disabled` |
| `POST /api/v1/settings/mcp/tokens` | `{label, canControl}` → `201` with the plaintext, exactly once |
| `DELETE /api/v1/settings/mcp/tokens/:id` | `204`; logs `mcp.token-revoked` |

`GET /hub` carries `mcp: { available: true }` and nothing else. That route is
public, so it says only that this build *can* run an MCP server — enough for an
app to decide whether to draw the section. Whether one is switched on, and which
assistants are connected, is behind the authenticated route above: a hub should
not announce to the network that there is an assistant door and whether it is
open.

**MCP is off until somebody turns it on.** A request to `/api/v1/mcp` on a hub
that has not is answered `404`, not `403` — a disabled hub should not confirm to
an unauthenticated caller that the feature is even here.

## Setting up a client

`<hub>` is the hub's address on the network and `ghm_…` is a token from
`POST /settings/mcp/tokens`.

**Claude Code** — native HTTP, no bridge:

```sh
claude mcp add --transport http gethome \
  http://<hub>:8420/api/v1/mcp \
  --header "Authorization: Bearer ghm_…"
```

**Claude Desktop** — its config takes stdio servers only, so it goes through
`mcp-remote`. In `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gethome": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://<hub>:8420/api/v1/mcp",
               "--allow-http", "--header", "Authorization:${AUTH}"],
      "env": { "AUTH": "Bearer ghm_…" }
    }
  }
}
```

Two details are load-bearing and both fail *silently* if got wrong.
`--allow-http` is needed because the hub is plain HTTP on the LAN. And the
header must be written **with no space around the colon**, with the value coming
from `env`: `mcp-remote` mangles spaces inside arguments, so the obvious
`"Authorization: Bearer ghm_…"` form is passed through wrong and the hub sees no
credential.

**Codex CLI / Codex IDE** — `~/.codex/config.toml`:

```toml
[mcp_servers.gethome]
url = "http://<hub>:8420/api/v1/mcp"
bearer_token_env_var = "GETHOME_MCP_TOKEN"
```

**ChatGPT** — cannot reach a LAN address; see *Where it can be reached from*.
Run OpenAI's `tunnel-client` on a machine that can reach the hub, then add the
tunnel in ChatGPT's developer mode. Note that write-capable custom connectors
are limited to Business, Enterprise and Edu plans, and are off until an admin
enables them — so on a personal plan the read tools work and `control_device`
may not.

## What it costs

The two decisions that make this affordable on the smallest supported board are
both refusals, and both should stay.

**No SDK.** `@modelcontextprotocol/sdk` was in this dependency graph once,
underneath the Claude Agent SDK, and left with it in the change that took the
bundle from 117 MB to 29 MB. MCP's core is JSON-RPC over one POST; `src/mcp/`
implements it in a few hundred lines and adds **no dependency at all** — the
JSON Schema in `tools/list` comes from `z.toJSONSchema`, which zod has shipped
since 4.3.

**No second process.** It runs in-process on the Fastify listener already there.
A separate Node process would have been 50–80 MB on a board with about 89 MB
free.

The module is **dynamically imported on the first request to an enabled hub**
and cached, the argument `src/index.ts` already makes for `@matter/main`: a home
that has never switched assistant access on never parses the tool catalog at
all. Measured against the Zero 2 W baseline in `docs/zigbee.md` (139 MB resident
with both radios, against a 200 MB `MemoryHigh`), the feature is one to three
megabytes when in use and nothing when it is not.

Responses are bounded so a model in a loop cannot ask for something enormous:
`list_devices` caps at 200 rows, history at 200 points per series.
