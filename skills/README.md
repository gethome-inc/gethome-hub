# gethome agent skills

Two [Agent Skills](https://agentskills.io) that teach a coding agent — Claude
Code, Codex, Cursor and the others that read the format — how to build on a
[gethome hub](https://github.com/gethome-inc/gethome-hub).

| Skill | For |
|---|---|
| [`gethome-hub-api`](gethome-hub-api/SKILL.md) | software that **uses** a home: scripts, dashboards, bridges, exporters and agents, on the hub's REST and WebSocket API with an API key |
| [`gethome-mqtt-device`](gethome-mqtt-device/SKILL.md) | hardware that **is** a device: ESPHome, Arduino, MicroPython and Python firmware that joins the home over the hub's MQTT broker |

Each one stands on its own: the agent needs neither this repository nor the
hub's source, and the skill links the hub's documentation for anything it does
not cover. An agent loads a skill by itself when a task matches it, and reads
the long material in `references/` only when it needs it.

## Install

```sh
npx skills add gethome-inc/gethome-hub
```

[`skills`](https://github.com/vercel-labs/skills) asks which agents to install
for and copies the two skill folders in; nothing else from this repository
stays on your machine. `-s gethome-hub-api` installs one skill, `-g` installs
for every project rather than this one, and `npx skills update` fetches the
latest.

Or copy a skill's folder into your agent's skills directory — for Claude Code,
`~/.claude/skills/`. The Claude apps take a ZIP whose top level is the skill's
folder:

```sh
cd skills && zip -r gethome-hub-api.zip gethome-hub-api/
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

The skills describe the hub as it is on `main`. A hub that has not been updated
may not have everything they mention, so they tell the agent to check what the
hub advertises before relying on it.

## License

The same as the rest of this repository: source-available under the
[PolyForm Noncommercial License 1.0.0](https://github.com/gethome-inc/gethome-hub/blob/main/LICENSE.md).
