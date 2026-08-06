# Running the hub natively on macOS

On macOS the hub runs **natively — no Docker**. This is deliberate:

- **mDNS discovery** (`_gethome._tcp`) and the **Matter controller** need the
  host's real network stack; Docker Desktop's Linux VM breaks both.
- **Zigbee USB sticks** cannot be passed into Docker Desktop/OrbStack
  containers at all — natively, `/dev/tty.usb*` just works.
- A hub should idle quietly 24/7 on a Mac mini; a permanent Linux VM is the
  opposite of that.

Linux and Raspberry Pi run natively too (`deploy/install.sh`, systemd units) —
for the same reasons plus one more: on a 512 MB board the Docker daemon is a
third of the machine.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/gethome-inc/gethome-hub/main/deploy/install-macos.sh | bash
```

With a Zigbee USB stick ( `auto` picks the first `/dev/tty.usb*` adapter):

```sh
curl -fsSL .../deploy/install-macos.sh | bash -s -- --zigbee auto
```

Requires [Homebrew](https://brew.sh). Everything is **per-user, no sudo**:

| Piece | How it runs |
|---|---|
| Node 22, Mosquitto | Homebrew packages; Mosquitto as a `brew service` |
| hubd | `npm ci && npm run build`, launchd agent `com.gethome.hubd` |
| Zigbee2MQTT (optional) | checkout in `~/Library/Application Support/GetHome/zigbee2mqtt`, launchd agent `com.gethome.zigbee2mqtt` |
| Hub data (SQLite database, identity, Matter fabric, pairing code) | `~/Library/Application Support/GetHome/hub-data` |
| Logs | `~/Library/Logs/GetHome/hubd.log`, `zigbee2mqtt.log` |

The GetHome Studio app runs this same script with a guided UI and shows every
line it executes.

## One switch: hubctl

```sh
"~/Library/Application Support/GetHome/gethome-hub/deploy/hubctl" start|stop|status|restart|logs|uninstall
```

`start` and `stop` flip the **whole stack at once** — hubd, Zigbee2MQTT,
Mosquitto — in both dimensions:

- `stop`: everything shuts down **now**, ports 8420/1883 are freed, and
  nothing comes back at login until you start it again.
- `start`: everything comes up **now** and re-enters login autostart
  (launchd agents + `brew services` share the same now-and-at-login
  semantics).

`status` prints each component plus a live API health check; `uninstall`
removes the launch agents but keeps data and Homebrew packages (it prints the
commands to purge those too).

## Autostart details

Components run as **launchd LaunchAgents** (`~/Library/LaunchAgents/`), which
start at **login**, with `KeepAlive` so a crashed hub restarts itself. For a
headless Mac mini, enable automatic login (System Settings → Users & Groups)
so the hub comes back after a power cut without a keyboard attached.

## Zigbee on macOS

Plug in the coordinator stick and check `ls /dev/tty.usb*` — CP210x/CH34x
sticks may need the vendor driver on macOS. The installer writes
`~/Library/Application Support/GetHome/zigbee2mqtt-data/configuration.yaml`;
edit `serial.port` there and `hubctl restart` if the adapter path changes.

## Port conflicts

The installer expects to own 1883 (Mosquitto) and 8420 (hubd). There is no
database port to fight over — the store is a SQLite file inside the hub's data
directory. If something else already owns 1883, stop it, or point `MQTT_URL` at
your own broker inside `~/Library/LaunchAgents/com.gethome.hubd.plist` and
`hubctl restart`.

## Updating

Re-run the installer (or update through Studio): it pulls the checkout,
rebuilds, rewrites the agents, and restarts.
