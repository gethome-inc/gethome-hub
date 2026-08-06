#!/usr/bin/env bash
# GetHome Hub installer for Linux (Raspberry Pi OS, Debian, Ubuntu, …).
#
#   curl -fsSL https://raw.githubusercontent.com/gethome-inc/gethome-hub/main/deploy/install.sh | bash
#
# Options (pass after `bash -s --`):
#   --zigbee /dev/ttyACM0   use this adapter instead of detecting one
#   --dir /opt/gethome      install directory (default /opt/gethome)
#   --branch main           branch to install from (default main)
#   --build                 build from source even when a bundle exists
#
# The script is idempotent: re-running updates the install and restarts the
# services. It is also what the GetHome Studio app streams over SSH.
#
# ── There is no Docker here, on purpose ────────────────────────────────────
# The hub used to run as four containers with Postgres underneath. On a
# Raspberry Pi Zero 2 W that is ~130 MB of Docker daemon and ~130 MB of
# database before the hub itself has started, out of 512 MB total — the board
# ran out of memory and the OOM killer took the hub down somewhere between the
# install finishing and the user pressing Claim. Everything now runs as systemd
# units against an SQLite file. systemd also gives us what `restart:
# unless-stopped` gave us and more: MemoryMax, so a runaway Zigbee2MQTT cannot
# take the hub with it.
#
# Studio follows progress through structured markers on stdout (keep them
# stable — the install screen is driven by them):
#   @@STEP:<id>@@       a phase begins
#                       (ids: system, runtime, download, zigbee, start,
#                        autostart, health)
#   @@ERROR:<text>@@    a human-readable failure reason (last one wins)
#   @@WARN:<text>@@     something worth telling the user; the install continues
#   @@BOARD:<name>@@    the machine this is running on
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

REPO_SLUG="gethome-inc/gethome-hub"
REPO_URL="https://github.com/${REPO_SLUG}.git"
INSTALL_DIR="/opt/gethome"
BRANCH="main"
ZIGBEE_ADAPTER=""
FORCE_BUILD=""

NODE_VERSION="22.22.2"
Z2M_VERSION="2"

DATA_DIR="/var/lib/gethome/data"
Z2M_DATA_DIR="/var/lib/gethome/zigbee2mqtt"
CONF_DIR="/etc/gethome"
SERVICE_USER="gethome"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --zigbee) ZIGBEE_ADAPTER="$2"; shift 2 ;;
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --build) FORCE_BUILD=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

HUB_DIR="$INSTALL_DIR/hub"
NODE_DIR="$INSTALL_DIR/node"
Z2M_DIR="$INSTALL_DIR/zigbee2mqtt"

# ── Output helpers ─────────────────────────────────────────────────────────
say()  { if [[ -t 1 ]]; then printf '\n\033[1m==> %s\033[0m\n' "$*"; else printf '\n==> %s\n' "$*"; fi; }
step() { printf '@@STEP:%s@@\n' "$1"; say "$2"; }
fail() { printf '@@ERROR:%s@@\n' "$1"; echo "ERROR: $1" >&2; exit 1; }
# Something the user should know about, but not a reason to stop: the hub is
# useful without Zigbee, so a coordinator that won't start is a warning.
warn() { printf '@@WARN:%s@@\n' "$1"; say "WARNING: $1"; }
# shellcheck disable=SC2154  # `code` is assigned inside the trap body itself.
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

command -v systemctl >/dev/null 2>&1 \
  || fail "This installer needs systemd, which every current Raspberry Pi OS, Debian and Ubuntu has. Install the hub by hand on a system without it — see deploy/ in the repository."

# ── System ─────────────────────────────────────────────────────────────────
step system "Checking this machine…"

MACHINE=$(uname -m)
BOARD="$(tr -d '\0' < /proc/device-tree/model 2>/dev/null || true)"
[[ -n "$BOARD" ]] || BOARD="$(uname -s) $MACHINE"
printf '@@BOARD:%s@@\n' "$BOARD"
say "Board: ${BOARD} (${MACHINE})"

RAM_MB=$(awk '/^MemTotal:/ {printf "%d", $2 / 1024}' /proc/meminfo 2>/dev/null || echo 0)
say "Memory: ${RAM_MB} MB"

# ARMv6 is the one genuinely unsupported case, and it is worth naming rather
# than failing later with something cryptic: Node.js has not published an ARMv6
# build since Node 12, so an original Pi Zero / Zero W / Pi 1 cannot run this
# hub at all. Everything from the Zero 2 W and Pi 3 up is ARMv8.
case "$MACHINE" in
  aarch64|arm64) NODE_ARCH="linux-arm64" ;;
  armv7l|armv8l) NODE_ARCH="linux-armv7l" ;;
  x86_64|amd64)  NODE_ARCH="linux-x64" ;;
  armv6l)
    fail "This board's processor (ARMv6 — an original Raspberry Pi Zero, Zero W, or Pi 1) can't run the GetHome Hub: the software it needs has no build for it. A Raspberry Pi Zero 2 W, or any Pi 3 or newer, works. Write a card for one of those with Raspberry Pi Imager (raspberrypi.com/software) and set it up again."
    ;;
  *)
    fail "Unsupported processor architecture: ${MACHINE}. The hub runs on 64-bit ARM (Raspberry Pi Zero 2 W, 3, 4, 5), 32-bit ARMv7, and x86-64."
    ;;
esac

# A 64-bit-capable board running a 32-bit system works, but it is leaving
# performance on the table and is the less-tested of the two.
if [[ "$NODE_ARCH" == "linux-armv7l" ]] && grep -q 'CPU architecture: 8' /proc/cpuinfo 2>/dev/null; then
  warn "This Raspberry Pi can run the 64-bit system, but it has the 32-bit one installed. The hub works either way; the 64-bit version is faster and better tested. To switch: Raspberry Pi Imager → Raspberry Pi OS (other) → Raspberry Pi OS Lite (64-bit)."
fi

if [[ "$RAM_MB" -gt 0 && "$RAM_MB" -lt 400 ]]; then
  fail "This machine has ${RAM_MB} MB of memory, which is below what the hub needs. A Raspberry Pi Zero 2 W (512 MB) is the smallest board that works."
fi

# Everything sized from here, so a Pi 5 isn't held to a Pi Zero's budget.
SMALL_BOARD=""
HUB_HEAP_MB=512
Z2M_HEAP_MB=512
HUB_MEM_HIGH=""
HUB_MEM_MAX=""
Z2M_MEM_HIGH=""
Z2M_MEM_MAX=""
if [[ "$RAM_MB" -gt 0 && "$RAM_MB" -le 1024 ]]; then
  SMALL_BOARD=1
  HUB_HEAP_MB=192
  Z2M_HEAP_MB=224
  # A ceiling each, well short of the total, so one runaway process is a
  # restart rather than a hung machine. `MemoryHigh` throttles first and gives
  # the garbage collector a chance; `MemoryMax` is the wall.
  HUB_MEM_HIGH="MemoryHigh=200M"
  HUB_MEM_MAX="MemoryMax=260M"
  Z2M_MEM_HIGH="MemoryHigh=200M"
  Z2M_MEM_MAX="MemoryMax=280M"
fi

say "Installing system packages…"
export DEBIAN_FRONTEND=noninteractive
$SUDO apt-get update -qq >/dev/null 2>&1 || warn "Could not refresh the package lists; carrying on with what is already cached."
$SUDO apt-get install -y -qq --no-install-recommends \
  ca-certificates curl xz-utils avahi-daemon avahi-utils mosquitto \
  >/dev/null 2>&1 \
  || fail "Could not install the system packages the hub needs (curl, avahi-daemon, mosquitto). Check the network and run the install again."

# ── Memory headroom ────────────────────────────────────────────────────────
# zram before a swapfile: it compresses pages in RAM, so it buys roughly twice
# the usable memory at the cost of a little CPU, and — unlike a swapfile — it
# writes nothing to the SD card. The disk swap stays as a backstop for the rare
# genuine spike; `swappiness=100` is right for zram specifically, where swapping
# is cheap, and would be wrong if the disk were the only swap.
if [[ -n "$SMALL_BOARD" ]]; then
  say "Setting up zram (compressed memory) so a small board has room to breathe…"
  $SUDO tee /usr/local/lib/gethome-zram.sh >/dev/null <<'ZRAM'
#!/bin/sh
# Add one zstd-compressed swap device sized to total RAM. Real-world
# compression on this kind of workload is about 3:1, so it buys most of a
# second machine's worth of memory and writes nothing to the SD card.
set -e
[ -n "$GETHOME_ZRAM_SIZE" ] || exit 0
modprobe zram || exit 0
if swapon --show=NAME --noheadings 2>/dev/null | grep -q '^/dev/zram'; then
  exit 0
fi
if [ -e /sys/class/zram-control/hot_add ]; then
  N=$(cat /sys/class/zram-control/hot_add)
else
  N=0
fi
echo zstd > "/sys/block/zram${N}/comp_algorithm" 2>/dev/null || true
echo "$GETHOME_ZRAM_SIZE" > "/sys/block/zram${N}/disksize"
mkswap -q "/dev/zram${N}"
# A higher priority than the disk swap, so the kernel reaches for RAM first
# and only falls through to the card under real pressure.
swapon --priority 100 "/dev/zram${N}"
ZRAM
  $SUDO chmod 0755 /usr/local/lib/gethome-zram.sh
  $SUDO tee /etc/systemd/system/gethome-zram.service >/dev/null <<UNIT
[Unit]
Description=Compressed swap in RAM for the GetHome Hub
DefaultDependencies=no
Before=swap.target gethome-hubd.service
After=systemd-modules-load.service

[Service]
Type=oneshot
RemainAfterExit=yes
Environment=GETHOME_ZRAM_SIZE=${RAM_MB}M
ExecStart=/usr/local/lib/gethome-zram.sh

[Install]
WantedBy=multi-user.target
UNIT
  $SUDO systemctl daemon-reload >/dev/null 2>&1 || true
  $SUDO systemctl enable --now gethome-zram.service >/dev/null 2>&1 \
    || warn "Could not enable compressed swap. The hub still installs; a board with 512 MB has less headroom without it."
  $SUDO tee /etc/sysctl.d/60-gethome.conf >/dev/null <<'SYSCTL'
# Tuned for compressed swap in RAM, which is cheap to use and costs the SD card
# nothing — the defaults assume swapping means writing to a disk.
vm.swappiness=100
vm.vfs_cache_pressure=50
SYSCTL
  $SUDO sysctl -q -p /etc/sysctl.d/60-gethome.conf >/dev/null 2>&1 || true
fi

# ── Accounts and directories ───────────────────────────────────────────────
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  $SUDO useradd --system --home-dir /var/lib/gethome --shell /usr/sbin/nologin "$SERVICE_USER"
fi
# Serial access for a Zigbee coordinator, without running anything as root.
$SUDO usermod -aG dialout "$SERVICE_USER" >/dev/null 2>&1 || true
$SUDO mkdir -p "$INSTALL_DIR" "$DATA_DIR" "$Z2M_DATA_DIR" "$CONF_DIR"
$SUDO chown -R "$SERVICE_USER:$SERVICE_USER" /var/lib/gethome
$SUDO chmod 0750 /var/lib/gethome "$DATA_DIR"

# ── Node ───────────────────────────────────────────────────────────────────
step runtime "Making sure Node.js 22 is available…"

node_major() { "$1" --version 2>/dev/null | sed -n 's/^v\([0-9]*\).*/\1/p'; }

NODE_BIN=""
if [[ -x "$NODE_DIR/bin/node" ]] && [[ "$(node_major "$NODE_DIR/bin/node")" -ge 22 ]] 2>/dev/null; then
  NODE_BIN="$NODE_DIR/bin/node"
  say "Using the Node.js already installed at ${NODE_DIR}."
elif command -v node >/dev/null 2>&1 && [[ "$(node_major "$(command -v node)")" -ge 22 ]] 2>/dev/null; then
  NODE_BIN="$(command -v node)"
  say "Using the system Node.js ($("$NODE_BIN" --version))."
else
  # Raspberry Pi OS Bookworm ships Node 18. Take the official build rather than
  # adding a package repository: one tarball, no apt keyring to go stale, and
  # the same version on every board.
  say "Downloading Node.js ${NODE_VERSION} (${NODE_ARCH})…"
  NODE_TGZ="/tmp/node-${NODE_VERSION}-${NODE_ARCH}.tar.xz"
  curl -fsSL --retry 5 --retry-delay 5 --retry-connrefused \
    "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${NODE_ARCH}.tar.xz" \
    -o "$NODE_TGZ" \
    || fail "Couldn't download Node.js from nodejs.org. Check the network and run the install again."
  $SUDO rm -rf "$NODE_DIR"
  $SUDO mkdir -p "$NODE_DIR"
  $SUDO tar -xJf "$NODE_TGZ" -C "$NODE_DIR" --strip-components=1 \
    || fail "The Node.js download arrived damaged. Run the install again."
  rm -f "$NODE_TGZ"
  NODE_BIN="$NODE_DIR/bin/node"
fi
NPM_BIN="$(dirname "$NODE_BIN")/npm"
[[ -x "$NPM_BIN" ]] || NPM_BIN="$(command -v npm || true)"

# ── The hub itself ─────────────────────────────────────────────────────────
step download "Downloading the hub…"

# The Pi downloads the hub; it does not compile it. Building here means `npm
# ci` fetching a thousand packages onto an SD card and then `tsc` compiling
# them — twenty to forty minutes, several hundred megabytes of memory, and
# every minute another chance for a dropped connection to lose the lot. CI
# builds one tarball per architecture instead, native modules included.
BUNDLE_TAG="bundle-$(printf '%s' "$BRANCH" | tr '/' '-')"
BUNDLE_URL="https://github.com/${REPO_SLUG}/releases/download/${BUNDLE_TAG}/gethome-hub-${NODE_ARCH}.tar.gz"
BUNDLE_TGZ="/tmp/gethome-hub-bundle.tar.gz"
INSTALLED=""

if [[ -z "$FORCE_BUILD" ]]; then
  say "Fetching ${BUNDLE_URL}…"
  if curl -fsSL --retry 5 --retry-delay 5 --retry-connrefused "$BUNDLE_URL" -o "$BUNDLE_TGZ" && [[ -s "$BUNDLE_TGZ" ]]; then
    $SUDO rm -rf "$HUB_DIR"
    $SUDO mkdir -p "$HUB_DIR"
    if $SUDO tar -xzf "$BUNDLE_TGZ" -C "$HUB_DIR"; then
      INSTALLED=1
      say "Installed the prebuilt hub."
    else
      say "The download arrived damaged; falling back."
      $SUDO rm -rf "$HUB_DIR"
    fi
    rm -f "$BUNDLE_TGZ"
  else
    rm -f "$BUNDLE_TGZ"
    say "No prebuilt hub for ${NODE_ARCH} on branch ${BRANCH}."
  fi
fi

if [[ -z "$INSTALLED" ]]; then
  # Building needs roughly a gigabyte of memory for `tsc` alone. On a board that
  # doesn't have it, starting the build means forty minutes of thrashing an SD
  # card and then an OOM kill — so say what is wrong now instead.
  if [[ -n "$SMALL_BOARD" && -z "$FORCE_BUILD" ]]; then
    fail "There is no prebuilt hub for this machine (${NODE_ARCH}) on branch ${BRANCH}, and this board has ${RAM_MB} MB of memory — not enough to build one here. The build that publishes it is the 'Publish bundle' workflow, and it puts the result in the '${BUNDLE_TAG}' release. If you have just pushed, it may still be running: check https://github.com/${REPO_SLUG}/actions and try again when it is green. To install what is on main instead, re-run with --branch main."
  fi
  say "Building the hub from source (this takes a while)…"
  command -v git >/dev/null 2>&1 || $SUDO apt-get install -y -qq git >/dev/null 2>&1
  $SUDO rm -rf "$HUB_DIR"
  $SUDO git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$HUB_DIR" \
    || fail "Could not clone ${REPO_URL} — check the network and try again."
  BUILD_LOG=$(mktemp)
  if ! ( cd "$HUB_DIR" && $SUDO env PATH="$(dirname "$NODE_BIN"):$PATH" "$NPM_BIN" ci --no-audit --no-fund --maxsockets 5 --fetch-retries 5 \
        && $SUDO env PATH="$(dirname "$NODE_BIN"):$PATH" "$NPM_BIN" run build \
        && $SUDO env PATH="$(dirname "$NODE_BIN"):$PATH" "$NPM_BIN" prune --omit=dev ) 2>&1 | tee "$BUILD_LOG"; then
    REASON="The hub could not be built here. See the output above."
    if grep -qE 'ECONNRESET|ETIMEDOUT|EAI_AGAIN|npm error network' "$BUILD_LOG"; then
      REASON="The download of the hub's dependencies was cut off partway. This is a slow or flaky connection rather than a problem with the Pi — running the install again picks up where it left off, and a network cable instead of Wi-Fi makes it much more likely to finish first time."
    elif grep -qE 'no space left on device|ENOSPC' "$BUILD_LOG"; then
      REASON="The Pi ran out of disk space while building the hub. Free some space (or use a larger card) and run the install again."
    elif grep -qiE 'killed|out of memory|Cannot allocate memory' "$BUILD_LOG"; then
      REASON="The Pi ran out of memory while building the hub. This board is too small to build on; install from a branch that has a published build instead."
    fi
    rm -f "$BUILD_LOG"
    fail "$REASON"
  fi
  rm -f "$BUILD_LOG"
fi

[[ -f "$HUB_DIR/dist/index.js" ]] || fail "The hub install is incomplete — dist/index.js is missing. Run the install again."
$SUDO chown -R root:root "$HUB_DIR"

# ── Mosquitto ──────────────────────────────────────────────────────────────
# The broker is the meeting point for hubd, Zigbee2MQTT, and any MQTT
# integration the user builds. It listens on the LAN, not just loopback: DIY
# boards and wired controllers live on other machines, and the firewall
# boundary for a home hub is the router.
$SUDO mkdir -p /etc/mosquitto/conf.d
$SUDO tee /etc/mosquitto/conf.d/gethome.conf >/dev/null <<'MOSQ'
# GetHome Hub. The broker is local plumbing between hubd, Zigbee2MQTT and any
# MQTT integrations on the home network — anonymous and unencrypted, which is
# fine inside a home LAN and is not fine exposed to the internet. Do not
# forward port 1883 through your router.
listener 1883
allow_anonymous true
persistence true
persistence_location /var/lib/mosquitto/
MOSQ
$SUDO systemctl enable mosquitto >/dev/null 2>&1 || true
$SUDO systemctl restart mosquitto >/dev/null 2>&1 \
  || warn "The MQTT broker didn't restart. Zigbee and MQTT devices need it: check with 'systemctl status mosquitto'."

# ── mDNS ───────────────────────────────────────────────────────────────────
# avahi answers for this machine's own name; the hub hands it the
# `_gethome._tcp` service rather than running a second responder of its own.
# Two responders on one host is a name conflict, and the loser renames itself —
# which is why a Pi would answer to raspberrypi.local right after an install
# and stop answering after a power cut.
#
# avahi reads exactly one config file — there is no conf.d — so these are
# edited in place, idempotently, with the original kept alongside.
AVAHI_CONF=/etc/avahi/avahi-daemon.conf
if [[ -f "$AVAHI_CONF" ]]; then
  [[ -f "${AVAHI_CONF}.pre-gethome" ]] || $SUDO cp "$AVAHI_CONF" "${AVAHI_CONF}.pre-gethome"
  # Set `key=value` inside `[section]`: replace the line if it is there in any
  # form (including commented out, which is how Debian ships most of them),
  # otherwise append it to the section.
  avahi_set() {
    $SUDO awk -v section="[$1]" -v key="$2" -v value="$3" '
      BEGIN { in_section = 0; done = 0 }
      /^\[/ {
        if (in_section && !done) { print key "=" value; done = 1 }
        in_section = ($0 == section)
      }
      {
        if (in_section && $0 ~ "^[#;[:space:]]*" key "[[:space:]]*=") {
          if (!done) { print key "=" value; done = 1 }
          next
        }
        print
      }
      END { if (in_section && !done) print key "=" value }
    ' "$AVAHI_CONF" > /tmp/avahi-daemon.conf.gethome && $SUDO cp /tmp/avahi-daemon.conf.gethome "$AVAHI_CONF"
    rm -f /tmp/avahi-daemon.conf.gethome
  }
  # `raspberrypi.local` has to resolve to an address a phone can actually
  # reach. If Docker is ever installed here for something else, avahi would
  # otherwise also publish docker0's 172.17.0.1 and clients take whichever
  # answer arrives first.
  avahi_set server deny-interfaces docker0
  # GetHome Studio finds Raspberry Pis by browsing _workstation._tcp: Debian
  # publishes no _ssh._tcp record, so on a stock Pi this is the announcement
  # that makes the machine findable at all.
  avahi_set publish publish-workstation yes
fi

# The hub publishes `_gethome._tcp` by dropping a service file here rather than
# running a second mDNS responder of its own. avahi watches the directory, so
# there is nothing to reload.
$SUDO mkdir -p /etc/avahi/services
$SUDO chgrp "$SERVICE_USER" /etc/avahi/services 2>/dev/null || true
$SUDO chmod 0775 /etc/avahi/services
$SUDO systemctl enable avahi-daemon >/dev/null 2>&1 || true
$SUDO systemctl restart avahi-daemon >/dev/null 2>&1 || true

# ── Zigbee ─────────────────────────────────────────────────────────────────
# Zigbee is optional: Matter and Wi-Fi devices work without it. So nothing here
# is ever fatal unless the user named an adapter explicitly and got it wrong.
step zigbee "Setting up Zigbee…"

if [[ ! -x "$Z2M_DIR/node_modules/.bin/zigbee2mqtt" ]]; then
  say "Installing Zigbee2MQTT…"
  $SUDO mkdir -p "$Z2M_DIR"
  # From npm, where it ships already built. The alternative — cloning the
  # repository and compiling its TypeScript — is the same twenty-minute,
  # several-hundred-megabyte problem we just took out of the hub's own install.
  ( cd "$Z2M_DIR" && $SUDO env PATH="$(dirname "$NODE_BIN"):$PATH" "$NPM_BIN" install --omit=dev --no-audit --no-fund --silent \
      --prefix "$Z2M_DIR" "zigbee2mqtt@${Z2M_VERSION}" ) >/dev/null 2>&1 \
    || warn "Zigbee2MQTT didn't install. Everything else works — Matter and Wi-Fi devices are unaffected. Run the install again to retry."
fi
$SUDO chown -R "$SERVICE_USER:$SERVICE_USER" "$Z2M_DATA_DIR"

# The detector is the authority on what counts as a coordinator, and it is what
# starts and stops Zigbee2MQTT — at boot and whenever something is plugged in
# or unplugged. Installing it unconditionally is what makes buying a stick next
# month just work, with no second visit to the installer.
$SUDO install -m 0755 "$HUB_DIR/deploy/zigbee-detect.sh" /usr/local/lib/gethome-zigbee-detect.sh 2>/dev/null \
  || warn "Could not install the Zigbee detector; plugging a coordinator in later won't configure itself."

$SUDO tee /etc/systemd/system/gethome-zigbee-detect.service >/dev/null <<UNIT
[Unit]
Description=Start or stop Zigbee2MQTT for the GetHome Hub depending on what is plugged in
After=gethome-hubd.service

[Service]
Type=oneshot
RemainAfterExit=no
Environment=GETHOME_CONF=${CONF_DIR}
ExecStart=/usr/local/lib/gethome-zigbee-detect.sh

[Install]
WantedBy=multi-user.target
UNIT

# Trigger on any USB serial device appearing *or* disappearing: the script is
# the authority on whether a given device is really a coordinator, udev only
# needs to wake it. Removal matters as much as arrival — without it, unplugging
# a stick leaves a service restart-looping against a device node that is gone.
$SUDO tee /etc/udev/rules.d/99-gethome-zigbee.rules >/dev/null <<'RULE'
SUBSYSTEM=="tty", ACTION=="add", ENV{ID_BUS}=="usb", TAG+="systemd", ENV{SYSTEMD_WANTS}="gethome-zigbee-detect.service"
SUBSYSTEM=="tty", ACTION=="remove", ENV{ID_BUS}=="usb", TAG+="systemd", ENV{SYSTEMD_WANTS}="gethome-zigbee-detect.service"
RULE
$SUDO udevadm control --reload-rules >/dev/null 2>&1 || true

if [[ -n "$ZIGBEE_ADAPTER" ]]; then
  # Explicitly named by the user (or by GetHome Studio, which detected it) —
  # a wrong path here is worth stopping for.
  [[ -e "$ZIGBEE_ADAPTER" ]] || fail "Zigbee adapter $ZIGBEE_ADAPTER not found on this machine (check: ls /dev/serial/by-id/)."
  # Pinned, so the detector stops guessing on this machine and keeps using it.
  # This is how a generic CP210x bridge — which the detector will never adopt
  # on its own — gets used once a human has said it is a Zigbee stick.
  printf 'GETHOME_ZIGBEE_PINNED=%s\n' "$ZIGBEE_ADAPTER" | $SUDO tee "$CONF_DIR/zigbee.env" >/dev/null
  printf '@@ZIGBEE_FOUND:%s@@\n' "$ZIGBEE_ADAPTER"
fi

# ── Configuration and services ─────────────────────────────────────────────
step start "Starting the hub…"

if [[ ! -f "$CONF_DIR/hub.env" ]]; then
  $SUDO tee "$CONF_DIR/hub.env" >/dev/null <<ENV
# GetHome Hub configuration. Edit and \`systemctl restart gethome-hubd\`.
PORT=8420
DATA_DIR=${DATA_DIR}
MQTT_URL=mqtt://127.0.0.1:1883
Z2M_BASE_TOPIC=zigbee2mqtt
HUB_NAME=GetHome Hub
LOG_LEVEL=info
# A bounded heap. Node sizes its default from total memory, which on a small
# board leaves the garbage collector waiting until the kernel is already in
# trouble. A cap makes it work sooner.
NODE_OPTIONS=--max-old-space-size=${HUB_HEAP_MB}
MDNS_BACKEND=auto
ENV
fi

$SUDO tee /etc/systemd/system/gethome-hubd.service >/dev/null <<UNIT
[Unit]
Description=GetHome Hub
Documentation=https://github.com/${REPO_SLUG}
After=network-online.target mosquitto.service
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
SupplementaryGroups=dialout
WorkingDirectory=${HUB_DIR}
EnvironmentFile=${CONF_DIR}/hub.env
ExecStart=${NODE_BIN} ${HUB_DIR}/dist/index.js
Restart=always
RestartSec=5
# The hub must come back from a crash, but must not spin: five failures inside
# a minute means something is genuinely wrong and hammering it makes the log
# unreadable.
StartLimitIntervalSec=60
StartLimitBurst=5
# avahi's service directory, so the hub can publish _gethome._tcp through the
# system responder instead of running one of its own.
ReadWritePaths=${DATA_DIR} /etc/avahi/services
StateDirectory=gethome
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
${HUB_MEM_HIGH}
${HUB_MEM_MAX}
# A memory spike should cost the hub a restart, not the machine a reboot.
OOMPolicy=continue

[Install]
WantedBy=multi-user.target
UNIT

$SUDO tee /etc/systemd/system/gethome-zigbee2mqtt.service >/dev/null <<UNIT
[Unit]
Description=Zigbee2MQTT for the GetHome Hub
After=mosquitto.service
Wants=mosquitto.service
# Deliberately not WantedBy=multi-user.target: this service is started and
# stopped by gethome-zigbee-detect, which knows whether a coordinator is
# actually plugged in. Enabling it unconditionally would mean ~150 MB held by a
# process waiting for hardware that may never arrive.

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
SupplementaryGroups=dialout
WorkingDirectory=${Z2M_DIR}
Environment=ZIGBEE2MQTT_DATA=${Z2M_DATA_DIR}
Environment=NODE_OPTIONS=--max-old-space-size=${Z2M_HEAP_MB}
Environment=ZIGBEE2MQTT_CONFIG_MQTT_SERVER=mqtt://127.0.0.1:1883
Environment=ZIGBEE2MQTT_CONFIG_MQTT_BASE_TOPIC=zigbee2mqtt
Environment=ZIGBEE2MQTT_CONFIG_FRONTEND_ENABLED=false
# The coordinator's path comes from the detector, as an override rather than an
# edit: Zigbee2MQTT's own configuration.yaml holds the network key and the
# paired-device list, and nothing here may ever rewrite that file.
EnvironmentFile=-${CONF_DIR}/zigbee.env
ExecStart=${NODE_BIN} ${Z2M_DIR}/node_modules/zigbee2mqtt/index.js
Restart=always
RestartSec=10
StartLimitIntervalSec=120
StartLimitBurst=5
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ReadWritePaths=${Z2M_DATA_DIR}
${Z2M_MEM_HIGH}
${Z2M_MEM_MAX}
OOMPolicy=continue

[Install]
WantedBy=multi-user.target
UNIT

$SUDO install -m 0755 "$HUB_DIR/deploy/gethome-hubctl" /usr/local/bin/gethome-hubctl 2>/dev/null || true

$SUDO systemctl daemon-reload
$SUDO systemctl enable gethome-hubd.service >/dev/null 2>&1
$SUDO systemctl enable gethome-zigbee-detect.service >/dev/null 2>&1 || true
$SUDO systemctl restart gethome-hubd.service \
  || fail "The hub is installed but wouldn't start. See: journalctl -u gethome-hubd -n 50"

# ── Autostart ──────────────────────────────────────────────────────────────
step autostart "Setting the hub to start automatically on power-up…"
AUTOSTART_OK=1
for unit in gethome-hubd.service mosquitto.service avahi-daemon.service; do
  if ! systemctl is-enabled "$unit" >/dev/null 2>&1; then
    AUTOSTART_OK=""
    warn "${unit} is not set to start at boot. Enable it with: sudo systemctl enable ${unit}"
  fi
done
[[ -n "$AUTOSTART_OK" ]] && say "The hub, the MQTT broker and mDNS all start with the Pi."

# ── Health ─────────────────────────────────────────────────────────────────
step health "Waiting for the hub to answer on port 8420…"
# Generous, because the first start also runs the database migrations onto an
# SD card. Costs nothing when it is healthy: the loop breaks on the first
# success.
HEALTHY=""
for attempt in $(seq 1 120); do
  if curl -fsS http://localhost:8420/api/v1/hub >/dev/null 2>&1; then HEALTHY=1; break; fi
  if ! systemctl is-active --quiet gethome-hubd.service; then
    sleep 2
    if ! systemctl is-active --quiet gethome-hubd.service; then
      fail "The hub started and then stopped. The last lines of its log usually say why: journalctl -u gethome-hubd -n 50"
    fi
  fi
  # Nothing else prints during this wait, and GetHome Studio shows the log as
  # it grows — so mark the time rather than let it look stalled.
  if [[ $((attempt % 15)) -eq 0 ]]; then say "Still waiting for the hub… ($((attempt * 2))s)"; fi
  sleep 2
done
[[ -n "$HEALTHY" ]] || fail "The hub is running but didn't answer on port 8420 within four minutes. Check: journalctl -u gethome-hubd -n 50"

INFO=$(curl -fsS http://localhost:8420/api/v1/hub)
if echo "$INFO" | grep -q '"claimed":false'; then
  CODE=$($SUDO cat "$DATA_DIR/pairing-code" 2>/dev/null | tr -d '[:space:]' || true)
  if [[ -n "$CODE" ]]; then
    printf '@@PAIRING:%s@@\n' "$CODE"
    say "Pairing code: ${CODE}"
    echo "GetHome Studio claims the hub for you; this code is for other devices."
  fi
fi

# Now that the hub is up and the code is out, see whether there is a Zigbee
# coordinator to bring up. It runs *here* because it is a confirmation rather
# than a dependency: a working hub should not be held back from its owner by a
# question about an accessory it doesn't need.
if [[ -x /usr/local/lib/gethome-zigbee-detect.sh ]]; then
  $SUDO env GETHOME_CONF="$CONF_DIR" /usr/local/lib/gethome-zigbee-detect.sh || true
fi

printf '@@DONE@@\n'
say "GetHome Hub is running: ${INFO}"
