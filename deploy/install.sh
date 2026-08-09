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
#   @@CAPABILITIES:<list>@@  what this hub ended up able to talk to, e.g.
#                            "Zigbee, Wi-Fi and MQTT" — a 512 MB board runs one
#                            radio at a time, so this is not the same on every
#                            machine
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

# Which Raspberry Pis we actually test on. Everything 64-bit runs, and a board
# outside this list is far more likely to be fine than not — a Pi 3 has twice
# the memory of a Zero 2 W. So this is a note, not a gate: saying "supported"
# about hardware nobody has tried would be the misleading half of the choice.
# Deliberately silent for machines that aren't Raspberry Pis at all, where
# running a home hub is an informed decision rather than a purchase.
# ("Raspberry Pi 5" also covers the 500, and "Pi 4" the 400 — they are
# substrings. The Compute Modules need their own patterns, because their model
# strings read "Raspberry Pi Compute Module 4".)
case "$BOARD" in
  *"Raspberry Pi 5"*|*"Raspberry Pi 4"*|*"Raspberry Pi Zero 2"*|\
  *"Compute Module 4"*|*"Compute Module 5"*) ;;
  *"Raspberry Pi"*)
    warn "${BOARD} isn't one of the boards this hub is regularly tested on (Raspberry Pi 5, Pi 4, and Zero 2 W). It should work — anything 64-bit with 512 MB or more does — but if something behaves oddly, that is worth knowing."
    ;;
esac

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
HUB_V8_FLAGS=""
# How many radios this board can afford at once — measured, not chosen. The
# owner's preference between them, when only one fits, is a separate thing and
# lives in <DATA_DIR>/radio-mode; gethome-zigbee-detect is where the two meet.
RADIO_BUDGET=both
if [[ "$RAM_MB" -gt 0 && "$RAM_MB" -le 1024 ]]; then
  SMALL_BOARD=1
  HUB_HEAP_MB=160
  Z2M_HEAP_MB=200
  HUB_MEM_HIGH="MemoryHigh=200M"
  Z2M_MEM_HIGH="MemoryHigh=170M"
  Z2M_MEM_MAX="MemoryMax=230M"
  # One radio, not none. Matter and Zigbee do not both fit — 70 (OS) + 178
  # (hub with Matter) + 150 (Zigbee2MQTT) is more than a Zero 2 W has, while
  # 70 + 119 + 150 fits with room for zram. But this used to be written as
  # "small board, no Matter", which was wrong in the common case: Zigbee2MQTT
  # is only started when a coordinator is actually plugged in, so a Zero 2 W
  # without a stick was holding 150 MB for a process that never ran *and*
  # going without Matter. gethome-zigbee-detect now owns that call, because it
  # is the only thing that knows whether the stick is there — at boot, on
  # every plug and unplug, and at the end of this install.
  RADIO_BUDGET=one
  # Measured on this hub: with Matter loaded these two take its resident set
  # from 176 MB to 139 MB, for about half a second of extra startup and no
  # change in request latency. They have to be argv — NODE_OPTIONS refuses
  # --optimize-for-size outright ("not allowed in NODE_OPTIONS").
  HUB_V8_FLAGS="--optimize-for-size --max-semi-space-size=1"
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

# ── Zigbee2MQTT must not wait for a browser ────────────────────────────────
# Zigbee2MQTT 2.x runs an *onboarding* wizard on a web page and does not bring
# the Zigbee stack up at all until somebody finishes it. On a hub that is
# nobody's business to configure by hand — the serial port and the broker are
# both supplied as environment overrides — that is a service which starts,
# stays "active (running)", never touches the coordinator, and reports nothing
# wrong. Observed exactly that: a correctly identified SONOFF dongle, the right
# path in the config, `zigbee.connected: false` forever, and one line in the
# journal offering a setup page on port 8080.
#
# `ZIGBEE2MQTT_CONFIG_ONBOARDING=false` is set on the unit as well, but it
# cannot be the whole answer: upstream ignores that variable when there is no
# configuration.yaml yet, which is precisely the fresh-install case. So the
# file gets the setting too.
#
# **This is the one thing written into configuration.yaml, and it is surgical
# on purpose.** That file holds the network key and the paired-device list;
# rewriting it would lose somebody's whole Zigbee network. Creating it when it
# is absent, or replacing one `onboarding:` line when it is present, does
# neither.
Z2M_CONFIG="$Z2M_DATA_DIR/configuration.yaml"
Z2M_ONBOARDING_CHANGED=""
if [[ ! -f "$Z2M_CONFIG" ]]; then
  printf 'onboarding: false\n' | $SUDO tee "$Z2M_CONFIG" >/dev/null \
    && $SUDO chown "$SERVICE_USER:$SERVICE_USER" "$Z2M_CONFIG" \
    && Z2M_ONBOARDING_CHANGED=1
elif grep -qE '^onboarding:[[:space:]]*true' "$Z2M_CONFIG" 2>/dev/null; then
  $SUDO sed -i 's/^onboarding:[[:space:]]*true.*/onboarding: false/' "$Z2M_CONFIG" \
    && Z2M_ONBOARDING_CHANGED=1
elif ! grep -qE '^onboarding:' "$Z2M_CONFIG" 2>/dev/null; then
  printf 'onboarding: false\n' | $SUDO tee -a "$Z2M_CONFIG" >/dev/null \
    && Z2M_ONBOARDING_CHANGED=1
fi
# A running Z2M read the old file at startup, and the detector below only
# restarts it when the *device path* changed — so without this an existing hub
# would keep waiting for its browser until the next reboot.
if [[ -n "$Z2M_ONBOARDING_CHANGED" ]] && command -v systemctl >/dev/null 2>&1 \
   && $SUDO systemctl is-active --quiet gethome-zigbee2mqtt.service 2>/dev/null; then
  say "Zigbee2MQTT was waiting on its setup page; turning that off and restarting it."
  $SUDO systemctl restart gethome-zigbee2mqtt.service >/dev/null 2>&1 || true
fi

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
# Zigbee2MQTT's data directory. The hub reads its log from here for one
# purpose: when the radio is down, Z2M's own log says why, and that answer
# belongs in the API rather than in a journal only an SSH session can see.
Z2M_DATA_DIR=${Z2M_DATA_DIR}
HUB_NAME=GetHome Hub
LOG_LEVEL=info
# A bounded heap. Node sizes its default from total memory, which on a small
# board leaves the garbage collector waiting until the kernel is already in
# trouble. A cap makes it work sooner.
NODE_OPTIONS=--max-old-space-size=${HUB_HEAP_MB}
MDNS_BACKEND=auto
ADAPTER_ZIGBEE=1
ADAPTER_MQTT=1
# How many radios this board affords at once: 'both' where there is memory for
# Matter and Zigbee2MQTT together, 'one' on a 512 MB board. Not a preference —
# the owner's choice between them lives in <DATA_DIR>/radio-mode and is applied
# by gethome-zigbee-detect, which is the only thing that knows whether a
# coordinator is actually plugged in.
GETHOME_RADIO=${RADIO_BUDGET}
# Matter. Managed by gethome-zigbee-detect on a one-radio board — editing it by
# hand there will be overwritten the next time something is plugged in. Switch
# radios from the GetHome app instead.
ADAPTER_MATTER=1
ENV
fi

$SUDO tee /etc/systemd/system/gethome-hubd.service >/dev/null <<UNIT
[Unit]
Description=GetHome Hub
Documentation=https://github.com/${REPO_SLUG}
After=network-online.target mosquitto.service
Wants=network-online.target
# The hub must come back from a crash, but must not spin: five failures inside
# a minute means something is genuinely wrong and hammering it makes the log
# unreadable. These live in [Unit], not [Service] — systemd moved them in v230
# and answers the old placement with "Unknown key 'StartLimitIntervalSec' in
# section [Service], ignoring", which is a warning per unit load and a rate
# limit that silently does not exist.
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
SupplementaryGroups=dialout
WorkingDirectory=${HUB_DIR}
EnvironmentFile=${CONF_DIR}/hub.env
ExecStart=${NODE_BIN} ${HUB_V8_FLAGS} ${HUB_DIR}/dist/index.js
Restart=always
RestartSec=5
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
# [Unit], not [Service] — see the hub unit above.
StartLimitIntervalSec=120
StartLimitBurst=5

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
# No setup wizard. Zigbee2MQTT 2.x otherwise starts a web page and leaves the
# radio alone until a human finishes it — see the note by the config above,
# which is where this is actually enforced, because upstream ignores this
# variable when configuration.yaml doesn't exist yet.
Environment=ZIGBEE2MQTT_CONFIG_ONBOARDING=false
# The coordinator's path comes from the detector, as an override rather than an
# edit: Zigbee2MQTT's own configuration.yaml holds the network key and the
# paired-device list, and nothing here may ever rewrite that file.
EnvironmentFile=-${CONF_DIR}/zigbee.env
ExecStart=${NODE_BIN} ${Z2M_DIR}/node_modules/zigbee2mqtt/index.js
Restart=always
RestartSec=10
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

# Switching radios from the app, without giving the hub root. The hub writes
# one word to a file in its own data directory — which it already owns — and
# this wakes the detector, which is where the decision lives anyway. No sudo
# rule, no systemctl from the service user, nothing new to lock down.
$SUDO tee /etc/systemd/system/gethome-radio.path >/dev/null <<UNIT
[Unit]
Description=Apply the radio the GetHome Hub owner picked

[Path]
PathModified=${DATA_DIR}/radio-mode
Unit=gethome-zigbee-detect.service

[Install]
WantedBy=multi-user.target
UNIT

$SUDO systemctl daemon-reload
$SUDO systemctl enable gethome-hubd.service >/dev/null 2>&1
$SUDO systemctl enable gethome-zigbee-detect.service >/dev/null 2>&1 || true
$SUDO systemctl enable --now gethome-radio.path >/dev/null 2>&1 || true
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
# Two different facts, and conflating them is what let a dead radio be
# announced as a working one: ZIGBEE_CONFIGURED means the detector found a
# coordinator and gave the board to it, ZIGBEE_READY means Zigbee2MQTT is
# actually talking to it. The first decides what to say about the *board*, the
# second decides what to claim the hub can talk to.
ZIGBEE_CONFIGURED=""
ZIGBEE_READY=""
if [[ -x /usr/local/lib/gethome-zigbee-detect.sh ]]; then
  if $SUDO env GETHOME_CONF="$CONF_DIR" /usr/local/lib/gethome-zigbee-detect.sh; then
    ZIGBEE_CONFIGURED=1
    ZIGBEE_READY=1
  fi
fi

# A started service is not a working radio. The detector's success means "a
# device node is there and I started the unit"; whether Zigbee2MQTT actually
# reached the stick is a different question, and the hub already answers it —
# `zigbee.connected` is Z2M's own bridge reporting itself online.
#
# Asking is what turns a silent failure into a sentence. A missing serial-port
# override, a coordinator on the GPIO header with the UART still off, a stick
# that needs its firmware flashed: all of them leave the unit running, the
# install "successful", and the owner with a hub that pairs nothing. Z2M takes
# a while to come up on this class of board, so give it a real minute before
# concluding anything.
if [[ -n "$ZIGBEE_READY" ]]; then
  say "Checking that Zigbee2MQTT reached the coordinator…"

  # Wait for the *hub* first, and don't count that time against Zigbee.
  #
  # The answer comes from the hub's API, and the detector a few lines up may
  # have just restarted the hub — that is what happens on a fresh install where
  # a coordinator takes the board from Matter, and on a Zero 2 W coming back is
  # over a minute. Polling straight away would spend the whole window on a
  # closed port and then blame the radio for a restart this script performed.
  HUB_NOW=""
  for _ in $(seq 1 40); do
    HUB_NOW=$(curl -fsS --max-time 5 http://localhost:8420/api/v1/hub 2>/dev/null || true)
    [[ -n "$HUB_NOW" ]] && break
    sleep 3
  done

  ZIGBEE_LIVE=""
  if [[ -z "$HUB_NOW" ]]; then
    # Nothing to say about the radio: the thing that would answer the question
    # is itself not answering, and the health step above already covers a hub
    # that won't start. Saying "Zigbee isn't working" here would be a guess.
    warn "The hub isn't answering, so whether Zigbee reached its coordinator couldn't be checked. See: journalctl -u gethome-hubd -n 50"
    ZIGBEE_READY=""
  else
    # Now a full window of a *live* hub, however long the restart took. Z2M is
    # a second Node process starting on an SD card; a minute and a half is
    # patient without being an install that looks hung.
    for _ in $(seq 1 30); do
      case "$HUB_NOW" in *'"connected":true'*) ZIGBEE_LIVE=1; break ;; esac
      sleep 3
      HUB_NOW=$(curl -fsS --max-time 5 http://localhost:8420/api/v1/hub 2>/dev/null || printf '%s' "$HUB_NOW")
    done
    if [[ -z "$ZIGBEE_LIVE" ]]; then
      # A warning, never a failure: the hub itself is fine, and the coordinator
      # stays configured, so this is something to fix rather than something that
      # undoes the install.
      #
      # And a *named* warning where we can manage it. "Check the journal" is
      # homework for somebody watching this from another machine, and the one
      # cause that is near-universal deserves better: a SONOFF ZBDongle-E ships
      # from the factory running EmberZNet 6.10 (EZSP v8), while Zigbee2MQTT's
      # ember driver needs EZSP 13 or newer — NCP firmware 7.4.x. So the very
      # first thing a new owner of the coordinator this project recommends sees
      # is a radio that answers and then refuses, once, until it is flashed.
      #
      # The message says what to do rather than quoting those numbers, and that
      # is deliberate: they are *protocol* versions, while the flasher shows
      # *firmware* versions and offers "6.10.3 → 8.0.2" for this very stick.
      # "Needs 13 or newer" beside an 8.0.2 makes the fix look wrong. The hub's
      # own `zigbee.problem` keeps the raw line for anyone who wants it.
      Z2M_TAIL=$($SUDO journalctl -u gethome-zigbee2mqtt -n 80 --no-pager 2>/dev/null || true)
      case "$Z2M_TAIL" in
        *"EZSP protocol version"*"is not supported by Host"*)
          warn "The Zigbee coordinator answered, but its firmware is too old for Zigbee2MQTT. SONOFF ZBDongle-E sticks ship this way, and updating one is a one-time job that needs no cable and no tools: unplug it, put it in a Mac or PC, open https://dongle.sonoff.tech/sonoff-dongle-flasher/ in Chrome or Edge (Safari cannot talk to USB devices), and flash the coordinator firmware it offers. Put it back and this hub picks it up on its own. Everything else here is unaffected."
          ;;
        *"No valid USB adapter found"*)
          warn "Zigbee2MQTT could not identify the coordinator on ${ZIGBEE_ADAPTER:-the configured port}. If this is a generic USB-serial stick, Zigbee2MQTT needs to be told what it is. See: journalctl -u gethome-zigbee2mqtt -n 50"
          ;;
        *)
          warn "Zigbee2MQTT started but hasn't reached the coordinator. The hub works; Zigbee devices won't pair until it does. Check: journalctl -u gethome-zigbee2mqtt -n 50"
          ;;
      esac
      ZIGBEE_READY=""
    fi
  fi
fi

# What this hub can actually talk to, said in as many words. The radio decision
# was made by the detector a few lines up, so read back what it settled on
# rather than repeating what we guessed before the hardware was known.
MATTER_ON=$(sed -n 's/^ADAPTER_MATTER=//p' "$CONF_DIR/hub.env" 2>/dev/null | tail -n1)
CAPS=""
[[ -n "$ZIGBEE_READY" ]] && CAPS="Zigbee"
if [[ "$MATTER_ON" == "1" ]]; then
  [[ -n "$CAPS" ]] && CAPS="$CAPS, Matter" || CAPS="Matter"
fi
[[ -n "$CAPS" ]] && CAPS="$CAPS, Wi-Fi and MQTT" || CAPS="Wi-Fi and MQTT"
# Additive marker: GetHome Studio shows this on the hub page. Unknown markers
# are ignored by older builds, so adding one is safe.
printf '@@CAPABILITIES:%s@@\n' "$CAPS"
say "This hub can talk to: ${CAPS}."

if [[ "$RADIO_BUDGET" == "one" ]]; then
  # One radio at a time, so say which one has it and how to change that — and
  # keep `ZIGBEE_CONFIGURED` (the board went to the coordinator) apart from
  # `ZIGBEE_READY` (Zigbee2MQTT actually reached it), because on a small board
  # the gap between them is a hub running *neither* radio.
  #
  # This is the last line before the install ends, and it used to be the
  # reassuring one in that case: "the coordinator you plugged in has it, so
  # Matter is off" is true, but printed under a firmware warning and beside
  # `@@CAPABILITIES:Wi-Fi and MQTT@@` it reads as "all set" on a hub that can
  # talk to no radio at all. Naming it is the whole point of the check that
  # produced the warning in the first place.
  if [[ -n "$ZIGBEE_READY" ]]; then
    say "This board has memory for one radio at a time, and the Zigbee coordinator you plugged in has it, so Matter is off. You can switch to Matter in the GetHome app — the coordinator stays configured, and Zigbee devices come back when you switch back."
  elif [[ -n "$ZIGBEE_CONFIGURED" ]]; then
    say "This board has memory for one radio at a time and the coordinator has it, so Matter is off — and until the coordinator is talking, this hub is running neither radio. Sort out the warning above and Zigbee starts on its own. If you would rather use Matter meanwhile, switch this board in the GetHome app; the coordinator stays configured and Zigbee devices come back when you switch back."
  elif [[ "$MATTER_ON" == "1" ]]; then
    say "This board has memory for one radio at a time, and with no Zigbee coordinator plugged in that radio is Matter. Plug a stick in whenever you like (SONOFF ZBDongle-E/P, ConBee, SkyConnect) and Zigbee takes over by itself, with no reboot."
  else
    # The third case, and it only exists because the detector deliberately
    # doesn't follow a coordinator *out*: a stick was set up on this machine
    # once and isn't here now, so the board is still held for it and Matter is
    # off. Saying "that radio is Matter" here — which this branch used to — is
    # simply false, and it is the kind of false that sends somebody looking for
    # a Matter device that will never appear.
    warn "This board has memory for one radio at a time, and it is still held for the Zigbee coordinator that was set up here — which isn't plugged in now, so neither radio is running. Plug the coordinator back in and Zigbee starts by itself, or switch this board to Matter in the GetHome app."
  fi
elif [[ -z "$ZIGBEE_CONFIGURED" ]]; then
  say "No Zigbee coordinator is plugged in, so this hub starts with Matter, Wi-Fi and MQTT devices. Plug one in whenever you like — Zigbee starts by itself, with no reboot."
fi

printf '@@DONE@@\n'
# Re-read rather than reprinting the copy taken at the health check. That one
# predates the detector, so on a board that just handed its radio to Zigbee it
# ended the install claiming `"matter":true` directly under a line saying
# Matter is off — and `"claimed":false` on a hub the owner had since claimed.
say "GetHome Hub is running: $(curl -fsS --max-time 5 http://localhost:8420/api/v1/hub 2>/dev/null || printf '%s' "$INFO")"
