#!/usr/bin/env bash
# GetHome Hub installer for Linux (Raspberry Pi OS, Debian, Ubuntu, …).
#
#   curl -fsSL https://raw.githubusercontent.com/gethome-inc/gethome-hub/main/deploy/install.sh | bash
#
# Options (pass after `bash -s --`):
#   --zigbee /dev/ttyACM0   enable the Zigbee2MQTT container with this adapter
#   --dir /opt/gethome      install directory (default /opt/gethome)
#   --branch main           git branch to install (default main)
#
# The script is idempotent: re-running updates the checkout and restarts the
# stack. It is also what the GetHome Studio app streams over SSH.

set -euo pipefail

REPO_URL="https://github.com/gethome-inc/gethome-hub.git"
INSTALL_DIR="/opt/gethome"
BRANCH="main"
ZIGBEE_ADAPTER=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --zigbee) ZIGBEE_ADAPTER="$2"; shift 2 ;;
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

SUDO=""
if [[ $(id -u) -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then SUDO="sudo"; else
    echo "Please run as root or install sudo." >&2; exit 1
  fi
fi

# ── Docker ────────────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker (get.docker.com)…"
  curl -fsSL https://get.docker.com | $SUDO sh
fi
if ! docker compose version >/dev/null 2>&1 && ! $SUDO docker compose version >/dev/null 2>&1; then
  echo "Docker Compose v2 is required (comes with current Docker). Please update Docker." >&2
  exit 1
fi

DOCKER="docker"
if ! docker info >/dev/null 2>&1; then DOCKER="$SUDO docker"; fi

# ── Checkout ─────────────────────────────────────────────────────────────
say "Installing GetHome Hub into ${INSTALL_DIR}…"
$SUDO mkdir -p "$INSTALL_DIR"
if [[ -d "$INSTALL_DIR/gethome-hub/.git" ]]; then
  $SUDO git -C "$INSTALL_DIR/gethome-hub" fetch origin "$BRANCH"
  $SUDO git -C "$INSTALL_DIR/gethome-hub" checkout "$BRANCH"
  $SUDO git -C "$INSTALL_DIR/gethome-hub" pull --ff-only origin "$BRANCH"
else
  $SUDO git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR/gethome-hub"
fi
cd "$INSTALL_DIR/gethome-hub"

# ── Environment ──────────────────────────────────────────────────────────
if [[ ! -f .env ]]; then
  say "Generating .env…"
  {
    echo "POSTGRES_PASSWORD=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    echo "HUB_NAME=GetHome Hub"
  } | $SUDO tee .env >/dev/null
fi
if [[ -n "$ZIGBEE_ADAPTER" ]]; then
  say "Enabling Zigbee (adapter: ${ZIGBEE_ADAPTER})…"
  $SUDO sed -i '/^ZIGBEE_ADAPTER=/d;/^COMPOSE_PROFILES=/d' .env
  {
    echo "ZIGBEE_ADAPTER=${ZIGBEE_ADAPTER}"
    echo "COMPOSE_PROFILES=zigbee"
  } | $SUDO tee -a .env >/dev/null
fi

# ── Build & start ────────────────────────────────────────────────────────
say "Building and starting the stack (first build takes a few minutes)…"
$DOCKER compose up -d --build

say "Waiting for the hub to come up…"
for _ in $(seq 1 60); do
  if curl -fsS http://localhost:8420/api/v1/hub >/dev/null 2>&1; then break; fi
  sleep 2
done
if ! curl -fsS http://localhost:8420/api/v1/hub >/dev/null 2>&1; then
  echo "The hub did not become healthy — check: $DOCKER compose logs hubd" >&2
  exit 1
fi

INFO=$(curl -fsS http://localhost:8420/api/v1/hub)
say "GetHome Hub is running: ${INFO}"

if echo "$INFO" | grep -q '"claimed":false'; then
  CODE=$($DOCKER compose exec -T hubd cat /data/pairing-code 2>/dev/null | tr -d '[:space:]' || true)
  if [[ -n "$CODE" ]]; then
    say "Pairing code: ${CODE}"
    echo "Enter this code in the GetHome app to become the owner of this hub."
  fi
fi
