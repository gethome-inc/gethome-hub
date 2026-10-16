# gethome agent skills

Two [Agent Skills](https://agentskills.io) that teach a coding agent — Claude
Code, Codex, Cursor and the others that read the format — how to build on a
[gethome hub](https://github.com/gethome-inc/gethome-hub), the local
smart-home hub this repository is.

| Skill | For |
|---|---|
| [`gethome-hub-api`](skills/gethome-hub-api/SKILL.md) | software that **uses** a home: scripts, dashboards, bridges, exporters and agents, on the hub's REST and WebSocket API with an API key |
| [`gethome-mqtt-device`](skills/gethome-mqtt-device/SKILL.md) | hardware that **is** a device: ESPHome, Arduino, MicroPython and Python firmware that joins the home over the hub's MQTT broker |

An agent loads a skill by itself when a task matches it. Each one keeps its
long material — every route, every capability, worked firmware — in
`references/`, read only when needed.

## Install

**Claude Code**

```text
/plugin marketplace add gethome-inc/gethome-hub
/plugin install gethome@gethome
```

and choose where to install it — or both steps at once on Claude Code 2.1.275
or later: `/plugin install gethome --marketplace gethome-inc/gethome-hub`. From
a shell, the same commands follow `claude plugin`. The skills appear as
`gethome:gethome-hub-api` and `gethome:gethome-mqtt-device`.

**Codex**

```sh
codex plugin marketplace add gethome-inc/gethome-hub
codex plugin add gethome@gethome
```

or add the marketplace and install from `/plugins` inside Codex. Start a new
session afterwards.

**Any agent that reads Agent Skills** (Cursor, OpenCode and many more),
through the [`skills`](https://github.com/vercel-labs/skills) installer:

```sh
npx skills add gethome-inc/gethome-hub
```

**The Claude apps** take a skill as a ZIP file whose top level is the skill's
own folder:

```sh
cd plugins/gethome/skills && zip -r gethome-hub-api.zip gethome-hub-api/
```

then upload it where the app lists your skills. An app in the cloud cannot
reach a hub on your home network, so there it helps you write the code rather
than run it.

## Before you start the agent

Put the hub's address and your key in the environment the agent runs in, so
the agent can use them without ever seeing the secret:

```sh
export GETHOME_HUB_URL=http://192.168.1.50:8420
export GETHOME_API_KEY=…   # see Building on a hub for how to make one
```

Never paste a key into a conversation. The skills tell the agent not to ask for
one, not to print one, and to stop and ask you before unlocking a door, opening
a garage, removing a device or switching on a rule it wrote.
[Building on a hub](https://github.com/gethome-inc/gethome-hub/blob/main/docs/integrations.md)
says how to make a key and what it may be given.

## Updating

Claude Code: `claude plugin marketplace update gethome`, then
`claude plugin update gethome@gethome`. Codex:
`codex plugin marketplace upgrade gethome`. The `skills` installer:
`npx skills update`.

The skills describe the hub as it is on `main`. A hub that has not been updated
may not have everything they mention; the skills tell the agent to check what
the hub advertises before relying on it.

## License

The same as the rest of this repository: source-available under the
[PolyForm Noncommercial License 1.0.0](https://github.com/gethome-inc/gethome-hub/blob/main/LICENSE.md).
