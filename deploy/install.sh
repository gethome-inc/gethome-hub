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
#
# Studio follows progress through structured markers on stdout (keep them
# stable — the install screen is driven by them):
#   @@STEP:<id>@@       a phase begins
#                       (ids: docker, checkout, start, autostart, health)
#   @@ERROR:<text>@@    a human-readable failure reason (last one wins)
#   @@PAIRING:<code>@@  the pairing code, when the hub is unclaimed
#   @@DONE@@            the install finished successfully

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

# ── Output helpers ─────────────────────────────────────────────────────────
say()  { if [[ -t 1 ]]; then printf '\n\033[1m==> %s\033[0m\n' "$*"; else printf '\n==> %s\n' "$*"; fi; }
step() { printf '@@STEP:%s@@\n' "$1"; say "$2"; }
fail() { printf '@@ERROR:%s@@\n' "$1"; echo "ERROR: $1" >&2; exit 1; }
trap 'code=$?; printf "@@ERROR:Command failed (exit %s) at line %s: %s@@\n" "$code" "$LINENO" "$BASH_COMMAND"; echo "ERROR (exit $code) at line $LINENO: $BASH_COMMAND" >&2' ERR

# ── Privilege check ────────────────────────────────────────────────────────
SUDO=""
if [[ $(id -u) -ne 0 ]]; then
  command -v sudo >/dev/null 2>&1 || fail "This installer needs root. Run it as root, or install sudo first."
  SUDO="sudo"
  # A non-interactive SSH session can't answer a sudo password prompt.
  if ! sudo -n true 2>/dev/null; then
    fail "This user needs passwordless sudo to install unattended. On Raspberry Pi OS the default user already has it; otherwise add a sudoers rule, or run the install as root."
  fi
fi

# ── Docker ─────────────────────────────────────────────────────────────────
step docker "Checking Docker…"
if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker (get.docker.com)…"
  curl -fsSL https://get.docker.com | $SUDO sh \
    || fail "Docker installation failed. See the output above, or install Docker manually and re-run."
fi
if ! docker compose version >/dev/null 2>&1 && ! $SUDO docker compose version >/dev/null 2>&1; then
  fail "Docker Compose v2 is required (it ships with current Docker). Please update Docker and re-run."
fi
DOCKER="docker"
if ! docker info >/dev/null 2>&1; then DOCKER="$SUDO docker"; fi
$DOCKER info >/dev/null 2>&1 || fail "Docker is installed but not running. Start the Docker service (sudo systemctl start docker) and re-run."

# ── Checkout ───────────────────────────────────────────────────────────────
step checkout "Fetching GetHome Hub into ${INSTALL_DIR}…"
$SUDO mkdir -p "$INSTALL_DIR"
if [[ -d "$INSTALL_DIR/gethome-hub/.git" ]]; then
  $SUDO git -C "$INSTALL_DIR/gethome-hub" fetch origin "$BRANCH" \
    || fail "Could not reach $REPO_URL — check the network and try again."
  $SUDO git -C "$INSTALL_DIR/gethome-hub" checkout "$BRANCH"
  $SUDO git -C "$INSTALL_DIR/gethome-hub" pull --ff-only origin "$BRANCH"
else
  $SUDO git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR/gethome-hub" \
    || fail "Could not clone $REPO_URL — check the network and try again."
fi
cd "$INSTALL_DIR/gethome-hub"

if [[ ! -f .env ]]; then
  say "Generating .env…"
  {
    echo "POSTGRES_PASSWORD=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    echo "HUB_NAME=GetHome Hub"
  } | $SUDO tee .env >/dev/null
fi
if [[ -n "$ZIGBEE_ADAPTER" ]]; then
  say "Enabling Zigbee (adapter: ${ZIGBEE_ADAPTER})…"
  [[ -e "$ZIGBEE_ADAPTER" ]] || fail "Zigbee adapter $ZIGBEE_ADAPTER not found on this machine (check: ls /dev/tty*)."
  $SUDO sed -i '/^ZIGBEE_ADAPTER=/d;/^COMPOSE_PROFILES=/d' .env
  {
    echo "ZIGBEE_ADAPTER=${ZIGBEE_ADAPTER}"
    echo "COMPOSE_PROFILES=zigbee"
  } | $SUDO tee -a .env >/dev/null
fi

# ── Build & start ──────────────────────────────────────────────────────────
step start "Building and starting the stack (the first build takes a few minutes)…"
$DOCKER compose up -d --build \
  || fail "docker compose failed to build or start the stack. See the output above, or run: $DOCKER compose logs"

# ── Autostart ──────────────────────────────────────────────────────────────
# Every compose service carries `restart: unless-stopped`, so the hub comes
# back by itself after a power cut — but only if the Docker daemon starts at
# boot. Distribution packages usually enable it; make it explicit so a Pi that
# is simply unplugged always comes back up on its own.
step autostart "Setting the hub to start automatically on power-up…"
if command -v systemctl >/dev/null 2>&1; then
  $SUDO systemctl enable docker.service >/dev/null 2>&1 || true
  $SUDO systemctl enable containerd.service >/dev/null 2>&1 || true
  if systemctl is-enabled docker.service >/dev/null 2>&1; then
    say "Docker starts at boot; the hub will restart with it."
  else
    say "WARNING: could not enable Docker at boot. After a reboot, start the hub with: cd $INSTALL_DIR/gethome-hub && $DOCKER compose up -d"
  fi
else
  say "No systemd here — make sure Docker starts at boot so the hub comes back after a power cut."
fi

# ── Health ─────────────────────────────────────────────────────────────────
step health "Waiting for the hub to answer on port 8420…"
HEALTHY=""
for _ in $(seq 1 60); do
  if curl -fsS http://localhost:8420/api/v1/hub >/dev/null 2>&1; then HEALTHY=1; break; fi
  sleep 2
done
[[ -n "$HEALTHY" ]] || fail "The hub started but did not become healthy. Check: $DOCKER compose logs hubd"

INFO=$(curl -fsS http://localhost:8420/api/v1/hub)
if echo "$INFO" | grep -q '"claimed":false'; then
  CODE=$($DOCKER compose exec -T hubd cat /data/pairing-code 2>/dev/null | tr -d '[:space:]' || true)
  if [[ -n "$CODE" ]]; then
    printf '@@PAIRING:%s@@\n' "$CODE"
    say "Pairing code: ${CODE}"
    echo "Enter this code in the GetHome app to become the owner of this hub."
  fi
fi

printf '@@DONE@@\n'
say "GetHome Hub is running: ${INFO}"
