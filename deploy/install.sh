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

# One directory per installed build, and a symlink saying which one runs.
#
# This is how the hub gets versioning and rollback without a container runtime.
# An update unpacks beside the running build and flips `current`; the systemd
# unit points at the symlink, so the switch is one atomic rename. If the new
# build doesn't answer, the flip goes back — which a `docker pull` into the
# same tag cannot do, and which matters far more on a machine nobody is sitting
# in front of.
RELEASES_DIR="$INSTALL_DIR/releases"
HUB_DIR="$INSTALL_DIR/current"
NODE_DIR="$INSTALL_DIR/node"
Z2M_DIR="$INSTALL_DIR/zigbee2mqtt"
# How many old builds to keep. Two is enough for one rollback and costs ~200 MB
# on a card; more is hoarding.
KEEP_RELEASES=2

# ── Output helpers ─────────────────────────────────────────────────────────
say()  { if [[ -t 1 ]]; then printf '\n\033[1m==> %s\033[0m\n' "$*"; else printf '\n==> %s\n' "$*"; fi; }
step() { printf '@@STEP:%s@@\n' "$1"; say "$2"; }
fail() { printf '@@ERROR:%s@@\n' "$1"; echo "ERROR: $1" >&2; exit 1; }
# Something the user should know about, but not a reason to stop: the hub is
# useful without Zigbee, so a coordinator that won't start is a warning.
warn() { printf '@@WARN:%s@@\n' "$1"; say "WARNING: $1"; }

# Why a unit didn't start, in the install log, where the person watching it can
# see it.
#
# This exists because it was missing. A `systemctl restart … >/dev/null 2>&1 ||
# warn "it didn't restart"` threw away the one line that mattered — mosquitto
# was refusing a duplicate config key and saying so clearly — and left "check
# with systemctl status" as homework for someone who is watching a progress bar
# on another machine. Whatever systemd knows, put it in the log.
service_failure() {
  local unit="$1"
  say "--- why ${unit} failed ---"
  $SUDO systemctl status "$unit" --no-pager --lines=0 2>&1 | sed 's/^/  /' || true
  $SUDO journalctl -u "$unit" -n 20 --no-pager 2>&1 | sed 's/^/  /' || true
  say "--- end ---"
}
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

# **64-bit only.** Two architectures are refused here, by name, because both
# failures are otherwise discovered twenty minutes in:
#
#  - ARMv6 (original Pi Zero / Zero W / Pi 1 / CM1) genuinely cannot run this:
#    Node.js has published no ARMv6 build since Node 12.
#  - ARMv7 means a *32-bit operating system*. The board is almost always
#    64-bit-capable — a Zero 2 W or a Pi 3/4/5 with the 32-bit image written to
#    it — so this is a fixable mistake, not a dead end, and the message says
#    exactly how to fix it. It is refused rather than warned about because
#    32-bit is untested, has no prebuilt SQLite binding, and was a real part of
#    why the first hubs never worked.
case "$MACHINE" in
  aarch64|arm64) NODE_ARCH="linux-arm64" ;;
  x86_64|amd64)  NODE_ARCH="linux-x64" ;;
  armv7l|armv8l)
    if grep -q 'CPU architecture: 8' /proc/cpuinfo 2>/dev/null; then
      fail "${BOARD} has a 64-bit processor, but a 32-bit operating system is installed on it — that is what \"armv7l\" above means. The GetHome Hub needs the 64-bit system. Rewrite the card with Raspberry Pi Imager (raspberrypi.com/software): choose Raspberry Pi OS (other) → Raspberry Pi OS Lite (64-bit), then set the hub up again. Nothing else about this Pi needs to change."
    fi
    fail "${BOARD} has a 32-bit ARMv7 processor, which the GetHome Hub doesn't support. A Raspberry Pi Zero 2 W, 3, 4 or 5 with the 64-bit system works."
    ;;
  armv6l)
    fail "${BOARD} has an ARMv6 processor (an original Raspberry Pi Zero, Zero W, or Pi 1) and can't run the GetHome Hub: the software it needs has no build for it, so there is nothing to install. A Raspberry Pi Zero 2 W, or any Pi 3 or newer, works — write a card for one of those with Raspberry Pi Imager (raspberrypi.com/software)."
    ;;
  *)
    fail "Unsupported processor architecture: ${MACHINE}. The hub runs on 64-bit ARM (Raspberry Pi Zero 2 W, 3, 4, 5) and x86-64."
    ;;
esac

if [[ "$RAM_MB" -gt 0 && "$RAM_MB" -lt 400 ]]; then
  fail "This machine has ${RAM_MB} MB of memory, which is below what the hub needs. A Raspberry Pi Zero 2 W (512 MB) is the smallest board that works."
fi

# Everything sized from here, so a Pi 5 isn't held to a Pi Zero's budget.
#
# Measured, not guessed: hubd is ~119 MB resident with Matter off and ~178 MB
# with it on. So on a 512 MB board the ceilings are `MemoryHigh` — which
# *throttles* the cgroup and lets the garbage collector catch up — and not
# `MemoryMax`, which kills. A hard cap set anywhere near the working set turns
# a busy minute into a restart, and that is what a too-tight 260 MB was doing.
# Zigbee2MQTT keeps a hard cap: it is the optional process, and it should die
# on its own rather than take the hub with it.
SMALL_BOARD=""
HUB_HEAP_MB=512
Z2M_HEAP_MB=512
HUB_MEM_HIGH=""
Z2M_MEM_HIGH=""
Z2M_MEM_MAX=""
MATTER_DEFAULT=1
if [[ "$RAM_MB" -gt 0 && "$RAM_MB" -le 1024 ]]; then
  SMALL_BOARD=1
  HUB_HEAP_MB=160
  Z2M_HEAP_MB=200
  HUB_MEM_HIGH="MemoryHigh=200M"
  Z2M_MEM_HIGH="MemoryHigh=170M"
  Z2M_MEM_MAX="MemoryMax=230M"
  # Matter and Zigbee do not both fit here. Loading matter.js costs ~59 MB, and
  # Zigbee2MQTT is another ~150: 70 (OS) + 178 + 150 is more than a Zero 2 W
  # has, while 70 + 119 + 150 fits with room for zram. Zigbee is the one the
  # user has hardware for on day one, so Matter is the one that waits — and the
  # warning below says so, with the single line that turns it back on.
  MATTER_DEFAULT=0
fi

# ── System packages ────────────────────────────────────────────────────────
# Only what is actually missing. Raspberry Pi OS Lite already ships
# avahi-daemon, curl, ca-certificates and xz-utils, so on the machine this is
# built for the whole step is "install mosquitto" — seconds, not the several
# minutes an unconditional `apt-get update` plus five packages was taking with
# all its output sent to /dev/null and nothing on screen moving.
export DEBIAN_FRONTEND=noninteractive
MISSING=()
for pkg in ca-certificates curl xz-utils avahi-daemon mosquitto; do
  dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q '^install ok installed$' || MISSING+=("$pkg")
done
if [[ ${#MISSING[@]} -eq 0 ]]; then
  say "System packages: everything the hub needs is already installed."
else
  say "Installing system packages: ${MISSING[*]}…"
  $SUDO apt-get update -qq || warn "Could not refresh the package lists; carrying on with what is already cached."
  $SUDO apt-get install -y -qq --no-install-recommends "${MISSING[@]}" \
    || fail "Could not install: ${MISSING[*]}. Check the network and run the install again."
fi

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
STAGING=""

# What `current` points at right now, so a failed install can go back to it.
PREVIOUS_RELEASE=""
if [[ -L "$HUB_DIR" ]]; then
  PREVIOUS_RELEASE="$(readlink -f "$HUB_DIR" 2>/dev/null || true)"
fi

$SUDO mkdir -p "$RELEASES_DIR"

if [[ -z "$FORCE_BUILD" ]]; then
  say "Fetching ${BUNDLE_URL}…"
  if curl -fsSL --retry 5 --retry-delay 5 --retry-connrefused "$BUNDLE_URL" -o "$BUNDLE_TGZ" && [[ -s "$BUNDLE_TGZ" ]]; then
    STAGING="$RELEASES_DIR/.incoming.$$"
    $SUDO rm -rf "$STAGING"
    $SUDO mkdir -p "$STAGING"
    if $SUDO tar -xzf "$BUNDLE_TGZ" -C "$STAGING"; then
      INSTALLED=1
    else
      say "The download arrived damaged; falling back."
      $SUDO rm -rf "$STAGING"
      STAGING=""
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
  STAGING="$RELEASES_DIR/.incoming.$$"
  $SUDO rm -rf "$STAGING"
  $SUDO git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$STAGING" \
    || fail "Could not clone ${REPO_URL} — check the network and try again."
  BUILD_LOG=$(mktemp)
  if ! ( cd "$STAGING" && $SUDO env PATH="$(dirname "$NODE_BIN"):$PATH" "$NPM_BIN" ci --no-audit --no-fund --maxsockets 5 --fetch-retries 5 \
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
    $SUDO rm -rf "$STAGING"
    fail "$REASON"
  fi
  rm -f "$BUILD_LOG"
fi

[[ -n "$STAGING" && -f "$STAGING/dist/index.js" ]] \
  || fail "The hub install is incomplete — dist/index.js is missing. Run the install again."

# ── Name the build, then make it current ───────────────────────────────────
# CI stamps VERSION into the bundle; a source build has no stamp, so it gets a
# timestamp. Either way "which build is this Pi running" has an answer that
# survives to the API and the app.
BUILD_ID="$($SUDO cat "$STAGING/VERSION" 2>/dev/null | head -n1 | tr -cd '[:alnum:]._-' || true)"
[[ -n "$BUILD_ID" ]] || BUILD_ID="src-$(date -u +%Y%m%d%H%M%S)"
RELEASE_DIR="$RELEASES_DIR/$BUILD_ID"

# Re-installing the same build id must not destroy the running one before the
# replacement is in place: move the old directory aside, put the new one in,
# and only then delete. `rm -rf` followed by a `mv` that fails would leave the
# hub with no install at all, on a machine nobody is sitting in front of.
if [[ -e "$RELEASE_DIR" ]]; then
  $SUDO rm -rf "${RELEASE_DIR}.replaced"
  $SUDO mv "$RELEASE_DIR" "${RELEASE_DIR}.replaced"
fi
if ! $SUDO mv "$STAGING" "$RELEASE_DIR"; then
  [[ -e "${RELEASE_DIR}.replaced" ]] && $SUDO mv "${RELEASE_DIR}.replaced" "$RELEASE_DIR"
  $SUDO rm -rf "$STAGING"
  fail "Could not put the new build in place at ${RELEASE_DIR}. The hub is unchanged."
fi
$SUDO rm -rf "${RELEASE_DIR}.replaced"
$SUDO chown -R root:root "$RELEASE_DIR"

# `ln -sfn` through a temporary name and `mv -T`: a plain `ln -sf` onto an
# existing symlink-to-a-directory creates a link *inside* it instead of
# replacing it. This way the switch is one atomic rename.
$SUDO ln -sfn "$RELEASE_DIR" "${HUB_DIR}.new"
$SUDO mv -T "${HUB_DIR}.new" "$HUB_DIR"
say "Installed build ${BUILD_ID}."

# Old builds, minus the one we came from (kept for rollback).
mapfile -t OLD_RELEASES < <(ls -1dt "$RELEASES_DIR"/*/ 2>/dev/null | sed 's:/$::' || true)
if [[ ${#OLD_RELEASES[@]} -gt $KEEP_RELEASES ]]; then
  for stale in "${OLD_RELEASES[@]:$KEEP_RELEASES}"; do
    [[ "$stale" == "$RELEASE_DIR" || "$stale" == "$PREVIOUS_RELEASE" ]] && continue
    $SUDO rm -rf "$stale"
  done
fi

# ── Mosquitto ──────────────────────────────────────────────────────────────
# The broker is the meeting point for hubd, Zigbee2MQTT, and any MQTT
# integration the user builds. It listens on the LAN, not just loopback: DIY
# boards and wired controllers live on other machines, and the firewall
# boundary for a home hub is the router.
$SUDO mkdir -p /etc/mosquitto/conf.d
# ── Add nothing the distribution's own config already sets ─────────────────
# This file is included *after* /etc/mosquitto/mosquitto.conf, which on Debian
# and Raspberry Pi OS already contains `persistence` and
# `persistence_location`. Repeating a string option there is not an override —
# mosquitto's parser treats it as a fatal error and refuses to start:
#
#   Error: Duplicate persistence_location value in configuration.
#
# which is exactly how the broker ended up down, port 1883 closed, and Zigbee
# unable to work at all on a hub that otherwise installed perfectly. Two lines
# is the whole of what we need; keep it that way.
$SUDO tee /etc/mosquitto/conf.d/gethome.conf >/dev/null <<'MOSQ'
# GetHome Hub. The broker is local plumbing between hubd, Zigbee2MQTT and any
# MQTT integrations on the home network — anonymous and unencrypted, which is
# fine inside a home LAN and is not fine exposed to the internet. Do not
# forward port 1883 through your router.
#
# Deliberately nothing else here: /etc/mosquitto/mosquitto.conf already sets
# persistence, its location and the log destination, and mosquitto refuses to
# start if a string option is given twice.
listener 1883
allow_anonymous true
MOSQ
$SUDO systemctl enable mosquitto >/dev/null 2>&1 || true
if ! $SUDO systemctl restart mosquitto >/dev/null 2>&1; then
  warn "The MQTT broker didn't start. Zigbee and MQTT devices need it — the reason is below."
  service_failure mosquitto
fi

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
$SUDO mkdir -p /etc/udev/rules.d
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
ADAPTER_ZIGBEE=1
ADAPTER_MQTT=1
# Matter. Loading it costs about 60 MB on top of the hub, which a board with
# 512 MB cannot pay at the same time as Zigbee2MQTT. Set this to 1 and
# \`systemctl restart gethome-hubd\` to turn it on.
ADAPTER_MATTER=${MATTER_DEFAULT}
ENV
fi

if [[ "$MATTER_DEFAULT" == "0" ]]; then
  warn "Matter is switched off on this board. It and Zigbee together need more memory than ${RAM_MB} MB: the hub is about 120 MB on its own, Matter adds about 60, and Zigbee2MQTT another 150. Zigbee, Wi-Fi and MQTT devices all work. To turn Matter on anyway, set ADAPTER_MATTER=1 in /etc/gethome/hub.env and run 'sudo gethome-hubctl restart' — a Raspberry Pi 4 or 5 runs both comfortably."
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
# Throttle, don't kill. See the sizing block near the top: a hard MemoryMax
# anywhere near the real working set turns a busy minute into a restart.
${HUB_MEM_HIGH}
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
DIED=""
for attempt in $(seq 1 120); do
  if curl -fsS http://localhost:8420/api/v1/hub >/dev/null 2>&1; then HEALTHY=1; break; fi
  if ! systemctl is-active --quiet gethome-hubd.service; then
    sleep 2
    if ! systemctl is-active --quiet gethome-hubd.service; then DIED=1; break; fi
  fi
  # Nothing else prints during this wait, and GetHome Studio shows the log as
  # it grows — so mark the time rather than let it look stalled.
  if [[ $((attempt % 15)) -eq 0 ]]; then say "Still waiting for the hub… ($((attempt * 2))s)"; fi
  sleep 2
done

# ── If the new build doesn't answer, go back to the one that did ───────────
# This is the whole point of installing beside the running version rather than
# over it. An update that breaks the hub on a machine nobody is sitting in
# front of has to undo itself; leaving a Pi with a hub that won't start,
# reachable only by SSH, is the failure that costs a person their evening.
if [[ -z "$HEALTHY" ]]; then
  service_failure gethome-hubd
  if [[ -n "$PREVIOUS_RELEASE" && -d "$PREVIOUS_RELEASE" && "$PREVIOUS_RELEASE" != "$RELEASE_DIR" ]]; then
    say "Rolling back to the build that was running before…"
    $SUDO ln -sfn "$PREVIOUS_RELEASE" "${HUB_DIR}.new"
    $SUDO mv -T "${HUB_DIR}.new" "$HUB_DIR"
    $SUDO systemctl restart gethome-hubd.service || true
    for _ in $(seq 1 30); do
      curl -fsS http://localhost:8420/api/v1/hub >/dev/null 2>&1 && { HEALTHY=1; break; }
      sleep 2
    done
    if [[ -n "$HEALTHY" ]]; then
      fail "Build ${BUILD_ID} wouldn't start, so the hub was put back on the previous build and is running again. Nothing was lost. The log above says why the new one failed."
    fi
  fi
  if [[ -n "$DIED" ]]; then
    fail "The hub started and then stopped. The log above says why; there is more in: journalctl -u gethome-hubd -n 50"
  fi
  fail "The hub is running but didn't answer on port 8420 within four minutes. The log above may say why; there is more in: journalctl -u gethome-hubd -n 50"
fi

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
