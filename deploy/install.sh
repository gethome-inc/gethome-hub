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
#                       (ids: docker, checkout, zigbee, start, autostart, health)
#   @@ERROR:<text>@@    a human-readable failure reason (last one wins)
#   @@WARN:<text>@@     something worth telling the user; the install continues
#   @@ZIGBEE_FOUND:<device>@@  the coordinator that will be used
#   @@ZIGBEE_MAYBE:<device>@@  a USB serial device that might be a coordinator
#                              but doesn't identify itself as one
#   @@PAIRING:<code>@@  the pairing code, when the hub is unclaimed
#   @@DONE@@            the install finished successfully
#
# The same vocabulary is reused by GetHome Studio's SD-card path, whose
# first-boot script logs its own two steps before handing over to this
# installer, and reads the whole log back over SSH:
#   network    waiting for the Pi to get online
#   installer  downloading this script
# They are separate on purpose — a Pi that never joined the Wi-Fi and one that
# joined and was refused the download are different failures with different
# fixes. Both are step ids in that stream, so don't reuse either here for
# something else.

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
# Something the user should know about, but not a reason to stop: the hub is
# useful without Zigbee, so a coordinator that won't start is a warning.
warn() { printf '@@WARN:%s@@\n' "$1"; say "WARNING: $1"; }
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
# ── Zigbee ─────────────────────────────────────────────────────────────────
# Zigbee is optional: Matter and Wi-Fi devices work without it. So nothing here
# is ever fatal unless the user named an adapter explicitly and got it wrong.
step zigbee "Looking for a Zigbee coordinator…"

# Whatever happens now, make plugging a stick in *later* just work: udev wakes
# a oneshot unit that re-runs the detector and brings Zigbee2MQTT up. Without
# this, a user who buys a stick next month would have to re-run the installer.
$SUDO install -m 0755 deploy/zigbee-detect.sh /usr/local/lib/gethome-zigbee-detect.sh
$SUDO tee /etc/systemd/system/gethome-zigbee.service >/dev/null <<UNIT
[Unit]
Description=Configure Zigbee for the GetHome Hub when a coordinator is attached
After=docker.service

[Service]
Type=oneshot
Environment=GETHOME_DIR=${INSTALL_DIR}/gethome-hub
ExecStart=/usr/local/lib/gethome-zigbee-detect.sh
UNIT
# Trigger on any USB serial device: the script is the authority on whether a
# given device is really a coordinator, udev only needs to wake it.
$SUDO tee /etc/udev/rules.d/99-gethome-zigbee.rules >/dev/null <<'RULE'
SUBSYSTEM=="tty", ACTION=="add", ENV{ID_BUS}=="usb", TAG+="systemd", ENV{SYSTEMD_WANTS}="gethome-zigbee.service"
RULE
if command -v systemctl >/dev/null 2>&1; then
  $SUDO systemctl daemon-reload >/dev/null 2>&1 || true
  $SUDO udevadm control --reload-rules >/dev/null 2>&1 || true
fi

if [[ -n "$ZIGBEE_ADAPTER" ]]; then
  # Explicitly named by the user (or by GetHome Studio, which detected it) —
  # a wrong path here is worth stopping for.
  say "Enabling Zigbee (adapter: ${ZIGBEE_ADAPTER})…"
  [[ -e "$ZIGBEE_ADAPTER" ]] || fail "Zigbee adapter $ZIGBEE_ADAPTER not found on this machine (check: ls /dev/serial/by-id/)."
  $SUDO sed -i '/^ZIGBEE_ADAPTER=/d;/^COMPOSE_PROFILES=/d' .env
  {
    echo "ZIGBEE_ADAPTER=${ZIGBEE_ADAPTER}"
    echo "COMPOSE_PROFILES=zigbee"
  } | $SUDO tee -a .env >/dev/null
else
  $SUDO env GETHOME_DIR="$INSTALL_DIR/gethome-hub" \
    bash deploy/zigbee-detect.sh --no-start || \
    say "Continuing without Zigbee. Plug a coordinator in whenever you like — the hub picks it up on its own."
fi

# ── Download & start ───────────────────────────────────────────────────────
step start "Downloading and starting the stack…"

# Pull the published image rather than compile the hub here. On a Raspberry Pi
# that is the difference between two minutes and forty: building meant `npm ci`
# fetching a thousand packages onto an SD card and `tsc` compiling them, with
# every minute another chance for the connection to drop and lose the lot.
#
# The fallback matters as much as the fast path, though. A pull can fail for
# reasons that have nothing to do with this machine — an architecture we don't
# publish, a registry that's down, a package that isn't public — and none of
# them should be the end of the install, because the source is right here and
# still builds. So: try the image, and if it won't come, build it and say so.
COMPOSE_FILES=(-f docker-compose.yml)
COMPOSE_UP_FLAGS=()
PULL_LOG=$(mktemp)
if ! $DOCKER compose pull hubd 2>&1 | tee "$PULL_LOG"; then
  PULL_REASON="the image couldn't be downloaded"
  if grep -qiE 'no matching manifest|not found|manifest unknown' "$PULL_LOG"; then
    PULL_REASON="there's no prebuilt image for this machine's processor ($(uname -m))"
  elif grep -qiE 'denied|unauthorized|authentication required' "$PULL_LOG"; then
    PULL_REASON="the image registry refused the download"
  fi
  warn "Building the hub from source because ${PULL_REASON}. Everything still works — it just takes about twenty minutes on a Raspberry Pi instead of two, and the log below goes quiet for most of it."
  COMPOSE_FILES+=(-f docker-compose.build.yml)
  COMPOSE_UP_FLAGS=(--build)
fi
rm -f "$PULL_LOG"

# The output is kept as well as shown, so a failure can be *named*. Compose
# reports "failed to build or start the stack" for everything from a dropped
# download to a full disk, and on a Pi those are the failures that actually
# happen — each with a different thing for the user to do about it. The
# reason is buried a hundred lines up in a build log by then, which for
# anyone driving this from GetHome Studio may as well be nowhere.
BUILD_LOG=$(mktemp)
if $DOCKER compose "${COMPOSE_FILES[@]}" up -d "${COMPOSE_UP_FLAGS[@]}" 2>&1 | tee "$BUILD_LOG"; then
  rm -f "$BUILD_LOG"
else
  REASON="docker compose failed to build or start the stack. See the output above, or run: $DOCKER compose logs"
  if grep -qE 'ECONNRESET|ETIMEDOUT|EAI_AGAIN|npm error network|Client\.Timeout|TLS handshake timeout' "$BUILD_LOG"; then
    REASON="The download of the hub's dependencies was cut off partway (the network dropped, or timed out). Nothing is wrong with the Pi or the card — this is a slow or flaky connection, and it is worth simply running the install again: Docker keeps what it already downloaded, so the retry starts where this one got to. A network cable instead of Wi-Fi makes it much more likely to finish first time."
  elif grep -qE 'no space left on device|ENOSPC' "$BUILD_LOG"; then
    REASON="The Pi ran out of disk space while building the hub. Building needs a few gigabytes free on the card. Free some space (or use a larger card) and run the install again."
  elif grep -qE 'signal: killed|Killed|out of memory|Cannot allocate memory' "$BUILD_LOG"; then
    REASON="The Pi ran out of memory while building the hub. That happens on boards with 1 GB of RAM or less. Adding swap usually gets it through: sudo dphys-swapfile swapoff && sudo sed -i 's/^CONF_SWAPSIZE=.*/CONF_SWAPSIZE=2048/' /etc/dphys-swapfile && sudo dphys-swapfile setup && sudo dphys-swapfile swapon — then run the install again."
  fi
  rm -f "$BUILD_LOG"
  fail "$REASON"
fi

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
# Four minutes, not two. What happens in this window is Postgres initialising
# its data directory and the hub running its migrations — on a Raspberry Pi
# writing to an SD card, both of which are slow enough that the old budget
# could expire on a hub that was about to come up perfectly. Costs nothing
# when it is healthy: the loop breaks on the first success.
HEALTHY=""
for attempt in $(seq 1 120); do
  if curl -fsS http://localhost:8420/api/v1/hub >/dev/null 2>&1; then HEALTHY=1; break; fi
  # Nothing else prints during this wait, and GetHome Studio shows the log as
  # it grows — so mark the time rather than let it look stalled.
  if [[ $((attempt % 15)) -eq 0 ]]; then say "Still waiting for the hub… ($((attempt * 2))s)"; fi
  sleep 2
done
[[ -n "$HEALTHY" ]] || fail "The hub built and started, but didn't answer on port 8420 within four minutes. Check: $DOCKER compose logs hubd"

INFO=$(curl -fsS http://localhost:8420/api/v1/hub)
if echo "$INFO" | grep -q '"claimed":false'; then
  CODE=$($DOCKER compose exec -T hubd cat /data/pairing-code 2>/dev/null | tr -d '[:space:]' || true)
  if [[ -n "$CODE" ]]; then
    printf '@@PAIRING:%s@@\n' "$CODE"
    say "Pairing code: ${CODE}"
    echo "Enter this code in the GetHome app to become the owner of this hub."
  fi
fi

# Did the coordinator actually answer? A device node only proves something is
# plugged in — Zigbee2MQTT talking to the radio is the real test, and it is the
# difference between "Zigbee works" and "Zigbee looks configured but is dead".
#
# It runs *here*, after the hub is healthy and the pairing code is out, because
# it is a confirmation rather than a dependency. It used to sit between
# starting the stack and the health check, which meant a working hub — already
# up, already answering — was held back from its owner by a question about an
# accessory it doesn't need.
if grep -q '^COMPOSE_PROFILES=.*zigbee' .env 2>/dev/null; then
  say "Checking that Zigbee2MQTT reached the coordinator (up to 90 seconds)…"
  ZIGBEE_OK=""
  # A wall-clock deadline, not a count of attempts. Each poll shells out to
  # Docker, and on a busy Pi that can take tens of seconds — so "45 tries, two
  # seconds apart" was ninety seconds in theory and a quarter of an hour in
  # practice. This bound holds however slow the polling gets.
  ZIGBEE_DEADLINE=$((SECONDS + 90))
  ZIGBEE_SPOKE=0
  while [[ $SECONDS -lt $ZIGBEE_DEADLINE ]]; do
    # `--tail` matters for the same reason: without it every poll re-reads the
    # entire Zigbee2MQTT log, which is growing while we watch it.
    if $DOCKER compose logs --tail 500 zigbee2mqtt 2>/dev/null | grep -q "Zigbee2MQTT started successfully"; then
      ZIGBEE_OK=1; break
    fi
    case "$($DOCKER compose ps --format '{{.State}}' zigbee2mqtt 2>/dev/null | head -n1)" in
      exited|restarting|dead) break ;;
    esac
    if [[ $((SECONDS - ZIGBEE_DEADLINE + 90)) -ge $((ZIGBEE_SPOKE + 30)) ]]; then
      ZIGBEE_SPOKE=$((ZIGBEE_SPOKE + 30))
      say "Still checking the Zigbee coordinator… (${ZIGBEE_SPOKE}s of 90)"
    fi
    sleep 2
  done
  if [[ -n "$ZIGBEE_OK" ]]; then
    say "Zigbee2MQTT is running and talking to the coordinator."
  else
    ZIGBEE_REASON=$($DOCKER compose logs --tail 30 zigbee2mqtt 2>/dev/null \
      | grep -iE 'error|failed|denied|cannot|no such' | tail -n1 | cut -c1-200)
    warn "The hub is running, but the Zigbee coordinator didn't come up. Everything else works — Matter and Wi-Fi devices are unaffected. Try reseating the USB stick (a powered extension cable helps; the Pi's own ports are noisy), then restart Zigbee with: cd $INSTALL_DIR/gethome-hub && $DOCKER compose restart zigbee2mqtt${ZIGBEE_REASON:+ — last error: $ZIGBEE_REASON}"
  fi
fi

printf '@@DONE@@\n'
say "GetHome Hub is running: ${INFO}"
