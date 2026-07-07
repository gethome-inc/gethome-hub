#!/usr/bin/env bash
# GetHome Hub — native macOS installer (no Docker).
#
#   curl -fsSL https://raw.githubusercontent.com/gethome-inc/gethome-hub/main/deploy/install-macos.sh | bash
#
# Options (pass after `bash -s --`):
#   --zigbee <port|auto>   enable Zigbee2MQTT with this serial adapter
#                          ("auto" picks the first /dev/tty.usb* device)
#   --dir <path>           hub checkout to install from (default: clone to
#                          ~/Library/Application Support/GetHome/gethome-hub)
#   --branch <name>        git branch to install (default main)
#
# What it does — all per-user, no sudo:
#   Homebrew packages: node@22, postgresql@17, mosquitto (+ pnpm for Zigbee)
#   Postgres:  brew service + a `gethome` database
#   Mosquitto: brew service with the GetHome LAN config
#   hubd:      npm ci + build, launchd agent com.gethome.hubd (starts at login)
#   Zigbee:    optional Zigbee2MQTT checkout + launchd agent
#
# Everything is controlled afterwards with deploy/hubctl (start/stop/status).
#
# The GetHome Studio app runs this same script and follows its progress
# through structured markers on stdout:
#   @@STEP:<id>@@     a phase begins (ids: packages, checkout, services,
#                     build, zigbee, start)
#   @@ERROR:<text>@@  a human-readable failure reason (last one wins)
#   @@DONE@@          the install finished successfully
# Keep these stable — Studio's install screen is driven by them.
#
# This is the macOS sibling of deploy/install.sh (Linux/Raspberry Pi, Docker).

set -euo pipefail

if [[ "$(uname)" != "Darwin" ]]; then
  echo "This installer is for macOS. On Linux/Raspberry Pi use deploy/install.sh." >&2
  exit 1
fi

REPO_URL="https://github.com/gethome-inc/gethome-hub.git"
BRANCH="main"
HUB_DIR=""
ZIGBEE_PORT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --zigbee) ZIGBEE_PORT="$2"; shift 2 ;;
    --dir) HUB_DIR="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# ── Output helpers ─────────────────────────────────────────────────────────
say() {
  if [[ -t 1 ]]; then printf '\n\033[1m==> %s\033[0m\n' "$*"; else printf '\n==> %s\n' "$*"; fi
}
step() { printf '@@STEP:%s@@\n' "$1"; say "$2"; }
fail() { printf '@@ERROR:%s@@\n' "$1"; echo "ERROR: $1" >&2; exit 1; }
# If any unguarded command dies under `set -e`, at least say which one.
trap 'code=$?; printf "@@ERROR:Command failed (exit %s) at line %s: %s@@\n" "$code" "$LINENO" "$BASH_COMMAND"; echo "ERROR (exit $code) at line $LINENO: $BASH_COMMAND" >&2' ERR

# Fewer moving parts, less noise, no surprise brew self-updates mid-install.
export HOMEBREW_NO_AUTO_UPDATE=1
export HOMEBREW_NO_INSTALL_CLEANUP=1
export HOMEBREW_NO_ENV_HINTS=1
export NONINTERACTIVE=1

APP_SUPPORT="$HOME/Library/Application Support/GetHome"
DATA_DIR="$APP_SUPPORT/hub-data"
LOG_DIR="$HOME/Library/Logs/GetHome"
AGENTS_DIR="$HOME/Library/LaunchAgents"
Z2M_APP_DIR="$APP_SUPPORT/zigbee2mqtt"
Z2M_DATA_DIR="$APP_SUPPORT/zigbee2mqtt-data"
HUBD_LABEL="com.gethome.hubd"
Z2M_LABEL="com.gethome.zigbee2mqtt"

mkdir -p "$APP_SUPPORT" "$DATA_DIR" "$LOG_DIR" "$AGENTS_DIR"

# ── Homebrew packages ──────────────────────────────────────────────────────
step packages "Checking Homebrew packages…"

# Studio launches this script with a minimal PATH, so find brew explicitly.
BREW=""
for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew; do
  [[ -x "$candidate" ]] && BREW="$candidate" && break
done
[[ -n "$BREW" ]] || fail "Homebrew is required — install it from https://brew.sh and try again."
BREW_PREFIX="$("$BREW" --prefix)"
export PATH="$BREW_PREFIX/bin:$BREW_PREFIX/sbin:$PATH"

# brew occasionally exits non-zero on cleanup/caveat hiccups even though the
# formula installed fine — so trust `brew list`, not the exit code.
brew_ensure() {
  if "$BREW" list --formula "$1" >/dev/null 2>&1; then
    say "$1 is already installed."
    return 0
  fi
  say "Installing $1…"
  "$BREW" install "$1" || true
  "$BREW" list --formula "$1" >/dev/null 2>&1 \
    || fail "Homebrew could not install $1 — scroll the log above for brew's own error."
}

brew_ensure node@22
brew_ensure postgresql@17
brew_ensure mosquitto

NODE_BIN="$BREW_PREFIX/opt/node@22/bin"
[[ -x "$NODE_BIN/node" ]] || fail "node@22 installed but $NODE_BIN/node is missing — try 'brew reinstall node@22'."
export PATH="$NODE_BIN:$PATH"

# ── Hub checkout ───────────────────────────────────────────────────────────
if [[ -z "$HUB_DIR" ]]; then
  step checkout "Fetching gethome-hub…"
  HUB_DIR="$APP_SUPPORT/gethome-hub"
  if [[ -d "$HUB_DIR/.git" ]]; then
    git -C "$HUB_DIR" fetch origin "$BRANCH" || fail "Could not reach $REPO_URL — check your network."
    git -C "$HUB_DIR" checkout "$BRANCH"
    git -C "$HUB_DIR" pull --ff-only origin "$BRANCH"
  else
    git clone --branch "$BRANCH" "$REPO_URL" "$HUB_DIR" \
      || fail "Could not clone $REPO_URL — check your network."
  fi
elif [[ ! -f "$HUB_DIR/package.json" ]]; then
  fail "--dir $HUB_DIR does not look like a gethome-hub checkout."
fi
say "Installing from: $HUB_DIR"

# ── Postgres + Mosquitto ───────────────────────────────────────────────────
step services "Starting the database and the MQTT broker…"

"$BREW" services start postgresql@17 >/dev/null
PG_BIN="$BREW_PREFIX/opt/postgresql@17/bin"
for _ in $(seq 1 30); do
  "$PG_BIN/pg_isready" -q -h 127.0.0.1 && break
  sleep 1
done
"$PG_BIN/pg_isready" -q -h 127.0.0.1 \
  || fail "Postgres did not come up on 127.0.0.1:5432. If another Postgres owns that port, stop it first (docs/macos.md)."
if ! "$PG_BIN/psql" -h 127.0.0.1 -d gethome -c 'select 1' >/dev/null 2>&1; then
  say "Creating the gethome database…"
  "$PG_BIN/createdb" -h 127.0.0.1 gethome
fi
DATABASE_URL="postgres://$(whoami)@127.0.0.1:5432/gethome"

MOSQ_CONF="$BREW_PREFIX/etc/mosquitto/mosquitto.conf"
if ! grep -q "GetHome Hub" "$MOSQ_CONF" 2>/dev/null; then
  say "Writing the GetHome Mosquitto config…"
  [[ -f "$MOSQ_CONF" ]] && cp "$MOSQ_CONF" "$MOSQ_CONF.pre-gethome.bak"
  mkdir -p "$(dirname "$MOSQ_CONF")"
  cat > "$MOSQ_CONF" <<CONF
# GetHome Hub broker configuration (managed by install-macos.sh).
# LAN-internal plumbing between hubd, Zigbee2MQTT, and MQTT integrations.
# Do not expose port 1883 beyond your network.
listener 1883
allow_anonymous true
persistence true
persistence_location $BREW_PREFIX/var/mosquitto/
CONF
fi
"$BREW" services restart mosquitto >/dev/null

# ── Build hubd ─────────────────────────────────────────────────────────────
step build "Building the hub (npm ci + build)…"
cd "$HUB_DIR"
"$NODE_BIN/npm" ci --no-fund --no-audit || fail "npm ci failed — see npm's error above."
"$NODE_BIN/npm" run build || fail "The hub build failed — see the compiler output above."

# ── Zigbee2MQTT (optional) ────────────────────────────────────────────────
if [[ -n "$ZIGBEE_PORT" ]]; then
  step zigbee "Setting up Zigbee2MQTT…"
  if [[ "$ZIGBEE_PORT" == "auto" ]]; then
    ZIGBEE_PORT="$(ls /dev/tty.usbserial-* /dev/tty.usbmodem* 2>/dev/null | head -1 || true)"
    [[ -n "$ZIGBEE_PORT" ]] \
      || fail "No /dev/tty.usb* serial adapter found — plug in the Zigbee stick or pass --zigbee /dev/tty.<adapter>."
    say "Zigbee adapter detected: $ZIGBEE_PORT"
  elif [[ ! -e "$ZIGBEE_PORT" ]]; then
    fail "Zigbee adapter $ZIGBEE_PORT does not exist (check: ls /dev/tty.usb*)."
  fi

  brew_ensure pnpm
  if [[ -d "$Z2M_APP_DIR/.git" ]]; then
    say "Updating Zigbee2MQTT…"
    git -C "$Z2M_APP_DIR" pull --ff-only
  else
    say "Cloning Zigbee2MQTT…"
    git clone --depth 1 https://github.com/Koenkk/zigbee2mqtt.git "$Z2M_APP_DIR" \
      || fail "Could not clone Zigbee2MQTT — check your network."
  fi
  say "Installing Zigbee2MQTT dependencies (this can take a few minutes)…"
  (cd "$Z2M_APP_DIR" && "$BREW_PREFIX/bin/pnpm" install --frozen-lockfile) \
    || fail "Zigbee2MQTT dependency install failed — see pnpm's error above."

  mkdir -p "$Z2M_DATA_DIR"
  if [[ ! -f "$Z2M_DATA_DIR/configuration.yaml" ]]; then
    cat > "$Z2M_DATA_DIR/configuration.yaml" <<CONF
mqtt:
  server: mqtt://127.0.0.1:1883
  base_topic: zigbee2mqtt
serial:
  port: $ZIGBEE_PORT
frontend:
  enabled: false
availability:
  enabled: true
CONF
  fi

  cat > "$AGENTS_DIR/$Z2M_LABEL.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>$Z2M_LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>$BREW_PREFIX/bin/pnpm</string>
		<string>start</string>
	</array>
	<key>WorkingDirectory</key><string>$Z2M_APP_DIR</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key><string>$NODE_BIN:$BREW_PREFIX/bin:/usr/bin:/bin</string>
		<key>ZIGBEE2MQTT_DATA</key><string>$Z2M_DATA_DIR</string>
	</dict>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>StandardOutPath</key><string>$LOG_DIR/zigbee2mqtt.log</string>
	<key>StandardErrorPath</key><string>$LOG_DIR/zigbee2mqtt.log</string>
</dict>
</plist>
PLIST
fi

# ── Launch agent + start ───────────────────────────────────────────────────
step start "Registering the launch agent and starting the hub…"
cat > "$AGENTS_DIR/$HUBD_LABEL.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>$HUBD_LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>$NODE_BIN/node</string>
		<string>$HUB_DIR/dist/index.js</string>
	</array>
	<key>WorkingDirectory</key><string>$HUB_DIR</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>NODE_ENV</key><string>production</string>
		<key>PORT</key><string>8420</string>
		<key>DATA_DIR</key><string>$DATA_DIR</string>
		<key>DATABASE_URL</key><string>$DATABASE_URL</string>
		<key>MQTT_URL</key><string>mqtt://127.0.0.1:1883</string>
		<key>Z2M_BASE_TOPIC</key><string>zigbee2mqtt</string>
	</dict>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>StandardOutPath</key><string>$LOG_DIR/hubd.log</string>
	<key>StandardErrorPath</key><string>$LOG_DIR/hubd.log</string>
</dict>
</plist>
PLIST

chmod +x "$HUB_DIR/deploy/hubctl"
"$HUB_DIR/deploy/hubctl" start

say "Waiting for the hub to come up…"
HEALTHY=""
for _ in $(seq 1 60); do
  if curl -fsS http://localhost:8420/api/v1/hub >/dev/null 2>&1; then HEALTHY=1; break; fi
  sleep 2
done
[[ -n "$HEALTHY" ]] || fail "The hub did not become healthy — check $LOG_DIR/hubd.log"

INFO="$(curl -fsS http://localhost:8420/api/v1/hub)"
printf '@@DONE@@\n'
say "GetHome Hub is running: $INFO"
echo "Control it with: \"$HUB_DIR/deploy/hubctl\" start|stop|status|logs"
echo "It starts automatically when you log in. For a headless Mac mini,"
echo "enable automatic login: System Settings → Users & Groups."

if echo "$INFO" | grep -q '"claimed":false'; then
  CODE="$(cat "$DATA_DIR/pairing-code" 2>/dev/null | tr -d '[:space:]' || true)"
  if [[ -n "$CODE" ]]; then
    say "Pairing code: $CODE"
    echo "Enter this code in the GetHome app to become the owner of this hub."
  fi
fi
