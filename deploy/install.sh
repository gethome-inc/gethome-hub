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
# unless-stopped` gave us and more: a runaway Zigbee2MQTT cannot take the hub
# with it — through `MemoryMax` where the kernel's memory cgroup is available,
# and through `OOMScoreAdjust` everywhere. There are two mechanisms rather than
# one because Raspberry Pi OS ships that cgroup switched off in `cmdline.txt`,
# so for most of this project's life the caps were not in force at all.
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
#   @@ROLLBACK:<build>@@ the new build wouldn't answer, so the hub was put back
#                       on this one. It is followed by @@ERROR@@ and a non-zero
#                       exit like any other failure, which is exactly why it
#                       exists: without it "rolled back and healthy" and "the
#                       hub is down" are the same two signals.
#   @@PAIRING:<code>@@  the pairing code, when the hub is unclaimed
#   @@CAPABILITIES:<list>@@  what this hub ended up able to talk to, e.g.
#                            "Zigbee, Wi-Fi and MQTT" — a 512 MB board runs one
#                            radio at a time, so this is not the same on every
#                            machine
#   @@DONE@@            the install finished successfully
#
# The same vocabulary is reused by both of GetHome Studio's install paths. Each
# writes a small script that logs its own steps before handing over to this
# installer, and reads the whole log back over SSH:
#   network    waiting for the Pi to get online   (SD-card path only)
#   installer  downloading this script            (both paths)
# They are separate on purpose — a Pi that never joined the Wi-Fi and one that
# joined and was refused the download are different failures with different
# fixes. The SSH path skips `network` because its preflight has already watched
# the machine reach the internet. Both are step ids in that stream, so don't
# reuse either here for something else.

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

# ── The memory limits need a controller the Raspberry Pi turns off ─────────
# Every ceiling written below — `MemoryHigh` on the hub, `MemoryMax` on
# Zigbee2MQTT — is enforced by the kernel's memory cgroup, and a Raspberry Pi
# boots with `cgroup_disable=memory`. Observed on a Zero 2 W: the units carried
# the right numbers, `systemctl show` read them straight back, and
# `MemoryCurrent` was `[not set]` with no `memory.*` file anywhere in the unit's
# own cgroup. The caps were decoration — not on that board particularly, but on
# every Raspberry Pi this installer has ever run on.
#
# **That parameter is not in `cmdline.txt`.** The firmware prepends its own
# arguments to the file's, and `cgroup_disable=memory` is one of them — so
# there is usually nothing here to delete, and the deletion below is only for a
# machine where somebody added one by hand. What does the work is the
# **append**: the kernel takes the last setting it is given, and anything this
# script adds lands after the firmware's. Verified on the Zero 2 W this was
# found on — `/proc/cmdline` still shows `cgroup_disable=memory`, followed by
# our two, and `/sys/fs/cgroup/cgroup.controllers` lists `memory`.
#
# That is also why the check is `memory_cgroup_live` and not "did we edit the
# file": what matters is whether the controller is actually there, which is the
# only thing a caller can act on and the only thing that makes a re-run a no-op.
#
# Three things make this safe to do to the file that decides whether the board
# boots: the result must still carry `root=` before it is written, the original
# is kept beside it, and it is rewritten as the **single line** the firmware
# requires — only the first line is read, so a stray newline silently drops
# every parameter after it.
#
# It costs a reboot, and this script deliberately does not perform one: an
# installer that restarts the machine in the middle of the flow its user is
# watching would be worse than a limit that starts working a little later.
# Studio's SD path writes the same parameters onto the card before the first
# boot, so a hub installed that way never meets this at all.
#
# `GETHOME_CMDLINE` and `GETHOME_CGROUP_CONTROLLERS` exist so the tests can
# exercise this against files they own — the same reason the detector has
# `GETHOME_ZIGBEE_SCAN_DIR`. Nothing sets them in production.
memory_cgroup_live() {
  grep -qw memory "${GETHOME_CGROUP_CONTROLLERS:-/sys/fs/cgroup/cgroup.controllers}" 2>/dev/null
}

enable_memory_cgroup() {
  if memory_cgroup_live; then
    return 0
  fi

  local file="" candidate current updated param
  local -a candidates
  if [[ -n "${GETHOME_CMDLINE:-}" ]]; then
    candidates=("$GETHOME_CMDLINE")
  else
    candidates=(/boot/firmware/cmdline.txt /boot/cmdline.txt)
  fi
  for candidate in "${candidates[@]}"; do
    if [[ -f "$candidate" ]]; then file="$candidate"; break; fi
  done
  if [[ -z "$file" ]]; then
    warn "The kernel's memory accounting is switched off on this machine, and there is no cmdline.txt here to switch it back on — that file is a Raspberry Pi thing. The hub installs and runs normally. What it goes without is the ceiling that keeps Zigbee2MQTT from taking memory the hub needs."
    return 0
  fi

  current=$(tr -d '\r\n' < "$file")
  updated=$(printf '%s' "$current" | sed 's/cgroup_disable=memory//g' | tr -s '[:space:]' ' ')
  updated="${updated# }"
  updated="${updated% }"
  for param in cgroup_enable=memory cgroup_memory=1; do
    case " $updated " in
      *" $param "*) ;;
      *) updated="$updated $param" ;;
    esac
  done
  if [[ "$updated" == "$current" ]]; then
    return 0
  fi

  # A command line without `root=` is a machine that does not come back. If the
  # rewrite lost it, this file is not the file we think it is, and the right
  # move is to leave it exactly as it was and say so.
  if [[ -z "$updated" || "$updated" != *"root="* ]]; then
    warn "Left ${file} alone: the rewritten kernel command line didn't look like one this Pi could boot from, and a wrong one is a Pi that doesn't come back. Nothing changed; this board's memory limits stay off."
    return 0
  fi

  $SUDO cp "$file" "${file}.gethome-backup-cgroup" 2>/dev/null || true
  if ! printf '%s\n' "$updated" | $SUDO tee "${file}.gethome-new" >/dev/null \
     || ! $SUDO mv "${file}.gethome-new" "$file"; then
    $SUDO rm -f "${file}.gethome-new" 2>/dev/null || true
    warn "Could not update ${file}, so this board's memory limits stay off. The hub itself is unaffected."
    return 0
  fi
  warn "Raspberry Pi OS ships with the kernel's memory accounting switched off, so the limits that keep Zigbee2MQTT from crowding out the hub were not actually in force on this board. That is corrected in ${file} and takes effect the next time this Pi is restarted. There is nothing to do now, and nothing else about the boot changed."
}

# Does this machine already have compressed swap of its own? Configuration
# counts, not just a running device — see the ordering note below, which is the
# whole reason this question is asked this way.
zram_provided_by_the_system() {
  local conf
  if [[ -e /etc/systemd/zram-generator.conf ]]; then return 0; fi
  for conf in /etc/systemd/zram-generator.conf.d/*.conf \
              /usr/lib/systemd/zram-generator.conf.d/*.conf; do
    if [[ -e "$conf" ]]; then return 0; fi
  done
  # zram-tools, the other common packaging of the same idea.
  if systemctl cat zramswap.service >/dev/null 2>&1; then return 0; fi
  if swapon --show=NAME --noheadings 2>/dev/null | grep -q '^/dev/zram'; then return 0; fi
  return 1
}

# ── Memory headroom ────────────────────────────────────────────────────────
# zram before a swapfile: it compresses pages in RAM, so it buys roughly twice
# the usable memory at the cost of a little CPU, and — unlike a swapfile — the
# device this script adds writes nothing to the SD card. The disk swap stays as
# a backstop for the rare genuine spike; `swappiness=100` is right for zram
# specifically, where swapping is cheap, and would be wrong if the disk were the
# only swap.
#
# **Unless the machine already has some, in which case leave it alone.**
# Raspberry Pi OS Trixie ships its own (`systemd-zram-setup@zram0`, from
# systemd's zram generator, presented as `rpi-swap`) — and this script added a
# second one anyway. The guard was "is a zram swap already on?", and the unit
# below is deliberately early (`DefaultDependencies=no`, `Before=swap.target`)
# so the hub never starts before its headroom exists. Being early is exactly
# what defeated the guard: the distribution's device was not up yet, the check
# saw nothing, and the script hot-added its own. Observed on a Zero 2 W — two
# 415 MB devices and a `SwapTotal` of 830 MB on a board with 415 MB of RAM.
# Compressed pages live in that same RAM, so twice the swap is twice the worst
# case, which is the opposite of the headroom this exists for. The question has
# to be "is one *configured* on this machine", which is answerable at any point
# in the boot, and not "is one running", which is not.
if [[ -n "$SMALL_BOARD" ]]; then
  enable_memory_cgroup

  # A desktop image is the largest single thing in the way on a board this
  # size. Measured on a Zero 2 W running the Desktop image with nothing plugged
  # into its HDMI: pcmanfm, wf-panel-pi, labwc, two xdg-desktop-portals,
  # wireplumber and the user session held about 75 MB between them — more than
  # the hub's whole Matter adapter. Switching somebody's desktop off is not this
  # installer's business. Saying what it costs, on the machine where it costs
  # the most, is.
  #
  # The measurement stays in this comment and out of the message. Studio shows
  # that message to someone who is not going to convert megabytes into anything
  # — what they can act on is "it takes memory the hub needs" plus the command.
  # And it must not promise a second radio: RADIO_BUDGET is computed from the
  # board's RAM above and a desktop makes no difference to it, so "turn it off
  # and get Matter too" would simply be untrue.
  if [[ "$(systemctl get-default 2>/dev/null || true)" == "graphical.target" ]]; then
    warn "This Pi is running the desktop version of Raspberry Pi OS. On a board this small the desktop uses up a good part of the memory the hub needs, for a screen that isn't attached. The hub works either way, it just has less room. If nobody uses a screen on this Pi, run \`sudo systemctl set-default multi-user.target\` and restart it to give that memory back; Raspberry Pi OS Lite is the version that never takes it in the first place."
  fi
fi

if [[ -n "$SMALL_BOARD" ]] && zram_provided_by_the_system; then
  say "Compressed memory is already set up by the operating system; leaving that to it."
  # An earlier install of ours may be the reason there are two.
  if [[ -e /etc/systemd/system/gethome-zram.service ]]; then
    $SUDO systemctl disable gethome-zram.service >/dev/null 2>&1 || true
    $SUDO rm -f /etc/systemd/system/gethome-zram.service /usr/local/lib/gethome-zram.sh
    $SUDO systemctl daemon-reload >/dev/null 2>&1 || true
    warn "An earlier install of the hub had added a second compressed-swap device beside the one this system provides — twice the swap this board should have, on a machine where the compressed pages sit in the memory they are saving. It is switched off now; the spare device itself goes away at the next restart."
  fi
elif [[ -n "$SMALL_BOARD" ]]; then
  say "Setting up zram (compressed memory) so a small board has room to breathe…"
  $SUDO tee /usr/local/lib/gethome-zram.sh >/dev/null <<'ZRAM'
#!/bin/sh
# Add one zstd-compressed swap device sized to total RAM. Real-world
# compression on this kind of workload is about 3:1, so it buys most of a
# second machine's worth of memory and writes nothing to the SD card.
set -e
[ -n "$GETHOME_ZRAM_SIZE" ] || exit 0
# Stand down if this machine has compressed swap of its own — the same check
# install.sh makes, repeated here because this unit runs on every boot and the
# operating system underneath it can gain one at any upgrade. Configuration,
# not a running device: this unit runs before swap.target, so at this moment
# the system's own zram is configured but not yet on, and asking whether one is
# *running* is what produced two of them.
if [ -e /etc/systemd/zram-generator.conf ] || \
   ls /etc/systemd/zram-generator.conf.d/*.conf \
      /usr/lib/systemd/zram-generator.conf.d/*.conf >/dev/null 2>&1; then
  exit 0
fi
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
fi

# Whichever of the two set it up, the swap this board ends up with is
# compressed and in RAM, so it wants the same tuning either way.
if [[ -n "$SMALL_BOARD" ]]; then
  $SUDO tee /etc/sysctl.d/60-gethome.conf >/dev/null <<'SYSCTL'
# Tuned for compressed swap in RAM, which is far cheaper to use than a disk —
# the kernel's defaults assume swapping means writing to one.
#
# Two things this is *not* saying. It is not saying the card is untouched:
# Raspberry Pi OS gives its zram a backing device and moves idle pages onto the
# card from a daily timer, so a page that goes out here can end up being read
# back 4 KB at a time off an SD card. And it is not saying the hub may be
# swapped — gethome-hubd.service sets MemorySwapMax=0 and is exempt from all of
# this, because a hub that has to be paged back in before it can answer is a
# hub that reads as unreachable. What is left for zram to spend is Zigbee2MQTT,
# the page cache, and whatever else the board is running, which is the right
# order to spend it in.
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
$SUDO mkdir -p "$INSTALL_DIR" "$DATA_DIR" "$DATA_DIR/update" "$Z2M_DATA_DIR" "$CONF_DIR"
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
#
# ── It asks for a password, and there are two accounts ─────────────────────
# It used to be `allow_anonymous true`, and that was a hole the size of the
# whole product: everything else a member may do is behind a token and a role,
# while anybody on the home Wi-Fi could open a broker connection and publish
# `zigbee2mqtt/<device>/set` to work every light and lock in the house, or
# `bridge/request/permit_join` to open the Zigbee network. The REST API's
# access table is not worth much with that sitting next to it.
#
# Two accounts, because "who may read the home" and "who may drive the radio"
# are different questions:
#
#   gethome-hub  full read/write. hubd and Zigbee2MQTT sign in as this, and it
#                is what an owner is shown only when they ask for it.
#   gethome      the one an owner is actually handed. It publishes under
#                `gethome/#` — the public integrator convention, see
#                docs/mqtt-integrations.md — and *reads* Zigbee device state,
#                so a board somebody builds can react to a motion sensor. It
#                cannot write to `zigbee2mqtt/#` at all, so a devboard that is
#                lost, resold or compromised cannot switch the house off or
#                open the network for pairing.
#
# Both are minted here, once, and reused on every later run: rotating them on
# each update would silently break every integration the owner had wired in.
# `GET /settings/mqtt` is how they reach an app.
MQTT_HUB_USER="gethome-hub"
MQTT_APP_USER="gethome"
MQTT_ENV="$CONF_DIR/mqtt.env"
MQTT_PASSWD_FILE="/etc/mosquitto/gethome.passwd"
MQTT_ACL_FILE="/etc/mosquitto/gethome.acl"
# Set once the broker really is asking for a password, which is what decides
# whether the units get credentials and what the closing summary says.
MQTT_SECURED=""

# 16 bytes of urandom as hex. Hex rather than base64 on purpose: this value is
# also handed to people to paste into ESP32 sketches and Home Assistant YAML,
# and it travels through a `mqtt://user:pass@host` URL in `mqtt.env`, where a
# `/` or a `+` would have to be percent-encoded by every reader.
#
# `od -N16` reads exactly sixteen bytes and exits; the obvious
# `tr -dc … </dev/urandom | head -c 32` cannot be used under `set -o pipefail`,
# where `tr` dying of SIGPIPE fails the whole pipeline.
gen_secret() { od -An -N16 -tx1 /dev/urandom | tr -d ' \n'; }

# One key out of mqtt.env, or empty. Read through $SUDO because the file is
# 0600 root — the passwords in it are the only thing on this machine that lets
# something drive the home without a hub token.
mqtt_env_value() {
  local existing=""
  existing=$($SUDO cat "$MQTT_ENV" 2>/dev/null || true)
  printf '%s\n' "$existing" | awk -F= -v key="$1" '$1 == key { sub(/^[^=]*=/, ""); print; exit }'
}

MQTT_HUB_PASS="$(mqtt_env_value MQTT_PASSWORD)"
MQTT_APP_PASS="$(mqtt_env_value MQTT_INTEGRATION_PASSWORD)"
# A hub that already exists and has no credentials is one whose broker has been
# open until now — so somebody may have wired a devboard straight into it, and
# that board is about to stop being able to publish. That is worth saying out
# loud once, at the end, where the user is looking; it is not worth leaving the
# hole open for.
MQTT_WAS_OPEN=""
[[ -z "$MQTT_HUB_PASS" && -f "$CONF_DIR/hub.env" ]] && MQTT_WAS_OPEN=1
[[ -n "$MQTT_HUB_PASS" ]] || MQTT_HUB_PASS="$(gen_secret)"
[[ -n "$MQTT_APP_PASS" ]] || MQTT_APP_PASS="$(gen_secret)"

$SUDO mkdir -p /etc/mosquitto/conf.d

# ── Never lock the hub out of its own broker ───────────────────────────────
# `mosquitto_passwd` ships with the broker, so this should always be present.
# If it somehow isn't, writing `allow_anonymous false` beside a password file
# that does not exist would take Zigbee and every MQTT device down for good, on
# a hub that installed perfectly — the installed-but-unusable trap. Stay open,
# and say so loudly enough that it gets fixed.
if command -v mosquitto_passwd >/dev/null 2>&1; then
  if $SUDO mosquitto_passwd -c -b "$MQTT_PASSWD_FILE" "$MQTT_HUB_USER" "$MQTT_HUB_PASS" >/dev/null 2>&1 \
    && $SUDO mosquitto_passwd -b "$MQTT_PASSWD_FILE" "$MQTT_APP_USER" "$MQTT_APP_PASS" >/dev/null 2>&1; then
    MQTT_SECURED=1
  else
    warn "Could not write the MQTT password file, so the broker is staying open to the local network."
  fi
else
  warn "mosquitto_passwd is missing, so the MQTT broker is staying open to the local network."
fi

if [[ -n "$MQTT_SECURED" ]]; then
  # ── What each account may touch ──────────────────────────────────────────
  # Only `read`, `write` and `readwrite` are used. mosquitto also understands
  # `deny`, which would express "everything under zigbee2mqtt/ except
  # bridge/info" in one line — and a config option an older broker does not
  # parse is a fatal error, which here means a hub with no Zigbee and no MQTT
  # at all. Listing what is allowed cannot fail that way.
  #
  # `zigbee2mqtt/+` is one level, so it is every device's state topic and none
  # of `bridge/#`. The three bridge topics that are named are the ones a DIY
  # integration actually wants; `bridge/info` is deliberately not among them,
  # because it carries Zigbee2MQTT's own configuration and we are not going to
  # depend on upstream redacting the network key from it.
  $SUDO tee "$MQTT_ACL_FILE" >/dev/null <<MOSQACL
# GetHome Hub — written by deploy/install.sh. Do not edit; it is rewritten on
# every install and update.
#
# Nothing appears above the first "user" line: those rules would apply to
# anonymous clients, and there are none.

# The hub itself and Zigbee2MQTT.
user ${MQTT_HUB_USER}
topic readwrite #

# Integrations the owner builds (docs/mqtt-integrations.md). They own the
# gethome/ tree outright, and may watch the home without being able to drive
# it: no write to zigbee2mqtt/ anywhere, so no device control and no
# permit_join, and no read of bridge/info.
user ${MQTT_APP_USER}
topic readwrite gethome/#
topic read zigbee2mqtt/+
topic read zigbee2mqtt/bridge/state
topic read zigbee2mqtt/bridge/event
topic read zigbee2mqtt/bridge/devices
MOSQACL

  # ── These two files are read by the broker, not by root ──────────────────
  # mosquitto opens password_file and acl_file *after* it has dropped
  # privileges to its own account, so a 0600 root-owned password file is one
  # it cannot read — and the broker then refuses to start outright:
  #
  #   Error: Unable to open pwfile "/etc/mosquitto/gethome.passwd".
  #
  # which is port 1883 closed, Zigbee dead and every MQTT device gone, on a hub
  # that installed perfectly. Reproduced against mosquitto 2.0.18.
  #
  # So this is not a tidy-up that may fail quietly: if the files cannot be made
  # readable by the broker and unreadable by everyone else, we do not turn
  # authentication on at all. An open broker is a hole; a broker that will not
  # start is a hub with no radios, and this script must never choose the second
  # while trying to fix the first.
  if ! { getent group mosquitto >/dev/null 2>&1 \
    && $SUDO chown root:mosquitto "$MQTT_PASSWD_FILE" "$MQTT_ACL_FILE" 2>/dev/null \
    && $SUDO chmod 0640 "$MQTT_PASSWD_FILE" "$MQTT_ACL_FILE" 2>/dev/null; }; then
    MQTT_SECURED=""
    $SUDO rm -f "$MQTT_PASSWD_FILE" "$MQTT_ACL_FILE" 2>/dev/null || true
    warn "The MQTT broker's own account can't read the password file this machine would need, so the broker is staying open to the local network."
  fi
fi

# ── Add nothing the distribution's own config already sets ─────────────────
# This file is included *after* /etc/mosquitto/mosquitto.conf, which on Debian
# and Raspberry Pi OS already contains `persistence` and
# `persistence_location`. Repeating a string option there is not an override —
# mosquitto's parser treats it as a fatal error and refuses to start:
#
#   Error: Duplicate persistence_location value in configuration.
#
# which is exactly how the broker ended up down, port 1883 closed, and Zigbee
# unable to work at all on a hub that otherwise installed perfectly. Keep this
# to the few lines we genuinely need — `password_file` and `acl_file` are not
# among what Debian sets, which is the only reason they can be here.
if [[ -n "$MQTT_SECURED" ]]; then
  $SUDO tee /etc/mosquitto/conf.d/gethome.conf >/dev/null <<MOSQ
# GetHome Hub. The broker is the plumbing between hubd, Zigbee2MQTT and any
# MQTT integrations on the home network. It listens on the LAN because those
# integrations run on other machines, and it asks for a password because
# everything reachable through it — every light, lock and socket in the home —
# is otherwise open to anyone who joins the Wi-Fi.
#
# The accounts and what each may touch are in ${MQTT_ACL_FILE}; the passwords
# are in ${MQTT_ENV}, and an app reads them from GET /settings/mqtt. It is
# still unencrypted, so do not forward port 1883 through your router.
listener 1883
allow_anonymous false
password_file ${MQTT_PASSWD_FILE}
acl_file ${MQTT_ACL_FILE}
MOSQ
else
  $SUDO tee /etc/mosquitto/conf.d/gethome.conf >/dev/null <<'MOSQ_OPEN'
# GetHome Hub — fallback. This broker takes anonymous connections because the
# installer could not set a password up (the warning above says why), which
# means anyone on this network can read the home and control every Zigbee
# device on it. Re-run the installer to close it.
listener 1883
allow_anonymous true
MOSQ_OPEN
fi

# ── The credentials, where systemd can hand them to both services ──────────
# Deliberately *not* hub.env: that file is written only when it is absent, so
# an upgraded hub would never see a new variable in it — the same trap that
# makes a `GETHOME_UPDATE=1` line there the wrong answer. This one is rewritten
# on every run and pulled in by both units.
#
# It carries `MQTT_URL` with the credentials in it as well as the two fields
# beside it, and that redundancy is the rollback story. `install.sh` puts the
# previous build back when a new one fails its health check, and that build may
# predate `MQTT_USERNAME` — but every build the hub has ever had reads
# `MQTT_URL`, and this file is listed *after* hub.env so its value is the one
# that survives. The current build is right either way: `loadConfig` lifts the
# credentials out of whichever URL it is given, and an explicit `MQTT_USERNAME`
# outranks them.
#
# 0600 root: systemd reads EnvironmentFile as PID 1, before it drops to the
# service account, so nothing here needs to be readable by the hub itself.
if [[ -n "$MQTT_SECURED" ]]; then
  $SUDO tee "$MQTT_ENV" >/dev/null <<MQTTENV
# GetHome Hub — MQTT broker credentials. Written by deploy/install.sh and
# rewritten on every install and update; the passwords themselves are minted
# once and kept. Read by gethome-hubd and gethome-zigbee2mqtt through
# EnvironmentFile=, and shown to an owner by GET /settings/mqtt.
#
# ${MQTT_HUB_USER} is full access. ${MQTT_APP_USER} is the one to give your own
# devices: it owns gethome/# and can only read Zigbee. See ${MQTT_ACL_FILE}.
MQTT_URL=mqtt://${MQTT_HUB_USER}:${MQTT_HUB_PASS}@127.0.0.1:1883
MQTT_USERNAME=${MQTT_HUB_USER}
MQTT_PASSWORD=${MQTT_HUB_PASS}
MQTT_INTEGRATION_USERNAME=${MQTT_APP_USER}
MQTT_INTEGRATION_PASSWORD=${MQTT_APP_PASS}
ZIGBEE2MQTT_CONFIG_MQTT_USER=${MQTT_HUB_USER}
ZIGBEE2MQTT_CONFIG_MQTT_PASSWORD=${MQTT_HUB_PASS}
MQTTENV
  $SUDO chown root:root "$MQTT_ENV" 2>/dev/null || true
  $SUDO chmod 0600 "$MQTT_ENV" 2>/dev/null || true
else
  # No credentials, so no file: a stale one would hand both services a password
  # the broker is no longer checking, and hubd would fail to connect to a
  # broker that would have taken it anonymously.
  $SUDO rm -f "$MQTT_ENV" 2>/dev/null || true
fi

$SUDO systemctl enable mosquitto >/dev/null 2>&1 || true
if ! $SUDO systemctl restart mosquitto >/dev/null 2>&1; then
  warn "The MQTT broker didn't start. Zigbee and MQTT devices need it — the reason is below."
  service_failure mosquitto
fi

# ── The log has to survive the reboot that hid the problem ─────────────────
# systemd's `Storage=auto` means "persist if /var/log/journal exists", and on
# the Pi this was found on that directory existed and was **empty** — journald
# had never been told to adopt it, so every log the machine had was in `/run`,
# thrown away on every boot. The cost lands exactly where it hurts: a hub that
# went unreachable on Tuesday and recovered by itself has no record of Tuesday
# left by Wednesday, and what the machine was doing at the time is the only
# question worth asking. `journalctl --list-boots` answering with one boot is
# what that looks like from the outside.
#
# `Storage=persistent` states it rather than inferring it from a directory, and
# the caps are for the SD card: journald sizes itself at 10% of the filesystem,
# which on a 64 GB card is six gigabytes of writes nobody asked for. 64 MB is
# weeks of a hub that is behaving itself, and the boots either side of one that
# is not.
$SUDO mkdir -p /etc/systemd/journald.conf.d
if $SUDO tee /etc/systemd/journald.conf.d/50-gethome.conf >/dev/null <<'JOURNALD'
# Written by GetHome. A hub is a machine nobody is sitting in front of, so what
# it logged before the last reboot is usually the only evidence there is.
[Journal]
Storage=persistent
# The bound is the SD card's, not the filesystem's: journald's own default
# would take 10% of the card.
SystemMaxUse=64M
SystemMaxFileSize=8M
RuntimeMaxUse=16M
JOURNALD
then
  $SUDO mkdir -p /var/log/journal
  $SUDO systemd-tmpfiles --create --prefix /var/log/journal >/dev/null 2>&1 || true
  $SUDO systemctl restart systemd-journald >/dev/null 2>&1 || true
  $SUDO journalctl --flush >/dev/null 2>&1 || true
else
  warn "The system log could not be made persistent, so a reboot will keep losing what the hub logged before it."
fi

# ── Wi-Fi must not doze ────────────────────────────────────────────────────
# A hub is a machine nobody talks to for hours and then everybody talks to at
# once — a phone opens the app, Studio browses for it, somebody SSHs in. That
# is the worst traffic pattern there is for 802.11 power save, and on the
# Raspberry Pi's brcmfmac it is the difference between a hub that answers and
# a hub that has to be woken up. The chip is asked to sleep by default
# (`brcmf_cfg80211_set_power_mgmt: power save enabled`, in every Pi's kernel
# log), and the failure that follows is the one nobody can diagnose from the
# app: the board is up, the coordinator is up, a motion rule is switching the
# hall light on — and both apps say the hub cannot be reached, because the
# radio is asleep and the access point's buffered frames went nowhere. It
# takes SSH down with it, which is exactly what makes it look like the hub's
# own fault. The one fact that says otherwise is that the automations kept
# running, and nobody is looking at that while the app says "can't reach".
#
# The saving is on the order of 20 mA, on a mains-powered board that is the
# home's front door. Not a trade worth making — so it goes off now, and off
# again on every association, because that is where it comes back.
#
# A wired hub needs none of this: the interface is whichever one carries the
# default route (which provably exists — the bundle was just downloaded over
# it), and a machine that reaches the LAN over Ethernet gets no unit, no
# dispatcher, and nothing said about it. `GETHOME_NET_DIR` and the two path
# overrides are there for the same reason `GETHOME_CMDLINE` is: so a test can
# run this against files it owns rather than against the machine it is on.
find_iw() {
  local found
  found="$(command -v iw 2>/dev/null || true)"
  if [[ -z "$found" && -x /usr/sbin/iw ]]; then found=/usr/sbin/iw; fi
  printf '%s' "$found"
}

# **Two different programs are called `arping`, and root gets the wrong one by
# default.** `iputils-arping` installs `/usr/bin/arping` and takes `-I` for the
# interface; Thomas Habets' `arping` package installs `/usr/sbin/arping` and
# takes `-i`. Root's PATH on Debian puts `/usr/sbin` *first*, so a hub with
# both would run the one whose flags we are not using — and it would fail
# silently, leaving the gateway ping alone, which is exactly what was measured
# not to work. Resolved by path here, and the caller sends one real
# announcement before trusting it.
find_arping() {
  local cand
  for cand in /usr/bin/arping "$(command -v arping 2>/dev/null || true)"; do
    if [[ -n "$cand" && -x "$cand" ]]; then printf '%s' "$cand"; return 0; fi
  done
}

# The interface the LAN is reached over, when that is a wireless one. Empty for
# a wired hub, and empty when there is no default route to judge by.
lan_wifi_iface() {
  local net_dir="${GETHOME_NET_DIR:-/sys/class/net}" iface
  iface="$(ip -o route show default 2>/dev/null \
    | awk '{ for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit } }' || true)"
  [[ -n "$iface" ]] || return 0
  # Two markers, because only one of them is guaranteed. `wireless/` is the old
  # wireless-extensions directory, and a driver built without them has none;
  # `phy80211` is cfg80211's own link to the radio and is there on everything
  # this hub runs on. Asking for the first alone is how the whole of the
  # section below turns into a no-op that says nothing — "no wireless
  # interface" is the case that is meant to be silent, so a radio we failed to
  # recognise would leave power saving on and never mention it.
  [[ -d "${net_dir}/${iface}/wireless" || -e "${net_dir}/${iface}/phy80211" ]] || return 0
  printf '%s' "$iface"
}

# What that interface is associated on, in MHz. Empty when it is not, or when
# the driver will not say — the caller must treat that as "no information",
# never as a frequency.
wifi_frequency_mhz() {
  local iface iw_bin
  iface="$(lan_wifi_iface)"
  [[ -n "$iface" ]] || return 0
  iw_bin="$(find_iw)"
  [[ -n "$iw_bin" ]] || return 0
  "$iw_bin" dev "$iface" link 2>/dev/null | awk '/freq:/ { printf "%d", $2; exit }'
}

keep_wifi_awake() {
  local net_dir="${GETHOME_NET_DIR:-/sys/class/net}"
  local dispatcher="${GETHOME_NM_DISPATCHER:-/etc/NetworkManager/dispatcher.d/50-gethome-wifi-awake}"
  local unit="${GETHOME_WIFI_UNIT:-/etc/systemd/system/gethome-wifi-awake.service}"
  local iface iw_bin persisted=""

  # Wired, or no default route to judge by: nothing to do and nothing to say.
  iface="$(lan_wifi_iface)"
  [[ -n "$iface" ]] || return 0

  iw_bin="$(find_iw)"
  if [[ -z "$iw_bin" ]]; then
    # With the lists refreshed first. The packages step above is the only one
    # that runs `apt-get update`, and it only reaches it when something it
    # needs is missing — so on a hub where everything else was already there,
    # an install here would be resolving against whatever the card happened to
    # have cached, which on an image that has sat in a drawer is nothing. That
    # failure is silent by construction: it ends in the warning below, on a
    # hub whose radio then goes on sleeping.
    $SUDO apt-get update -qq >/dev/null 2>&1 || true
    $SUDO apt-get install -y -qq --no-install-recommends iw >/dev/null 2>&1 || true
    iw_bin="$(find_iw)"
  fi
  if [[ -z "$iw_bin" ]]; then
    warn "This hub reaches the network over Wi-Fi (${iface}) and 'iw' could not be installed, so power saving is still on. The hub may stop answering for minutes at a time while the radio sleeps."
    return 0
  fi

  # The link that is up right now, so this install does not have to wait for a
  # reconnect to take effect.
  $SUDO "$iw_bin" dev "$iface" set power_save off >/dev/null 2>&1 || true

  if command -v nmcli >/dev/null 2>&1; then
    # NetworkManager turns power save back on as it associates, so a value
    # written into one profile is a value the next profile has not got — and a
    # home that re-enters its Wi-Fi password next month gets a fresh profile
    # with the fault back in it. The dispatcher covers every wireless
    # connection this machine ever grows, which is the one thing enumerating
    # today's profiles cannot do. NM ignores a dispatcher script that anyone
    # but root can write, so the ownership and the mode are part of the fix.
    $SUDO mkdir -p "$(dirname "$dispatcher")"
    if $SUDO tee "$dispatcher" >/dev/null <<DISPATCH
#!/bin/sh
# Installed by GetHome. NetworkManager turns 802.11 power save back on as it
# associates; this turns it off again once the connection is up, for whichever
# wireless interface came up. deploy/install.sh says why.
[ "\$2" = "up" ] || exit 0
[ -d "${net_dir}/\$1/wireless" ] || [ -e "${net_dir}/\$1/phy80211" ] || exit 0
exec ${iw_bin} dev "\$1" set power_save off
DISPATCH
    then
      $SUDO chown root:root "$dispatcher" 2>/dev/null || true
      if $SUDO chmod 0755 "$dispatcher"; then persisted="NetworkManager"; fi
    fi
  else
    # A wpa_supplicant/dhcpcd machine has no dispatcher, so the unit is bound
    # to the device and runs whenever it appears.
    if $SUDO tee "$unit" >/dev/null <<UNIT
[Unit]
Description=Keep the GetHome hub's Wi-Fi radio awake
Wants=sys-subsystem-net-devices-${iface}.device
After=sys-subsystem-net-devices-${iface}.device

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=${iw_bin} dev ${iface} set power_save off

[Install]
WantedBy=multi-user.target
UNIT
    then
      $SUDO systemctl daemon-reload >/dev/null 2>&1 || true
      $SUDO systemctl enable gethome-wifi-awake >/dev/null 2>&1 || true
      # Restarted rather than `--now`, for the reason `keep_wifi_reachable`
      # gives: this is a `RemainAfterExit` oneshot, so an update that changed
      # its ExecStart would otherwise not run until the board rebooted.
      if $SUDO systemctl restart gethome-wifi-awake >/dev/null 2>&1; then
        persisted="systemd"
      fi
    fi
  fi

  # Ask the radio rather than trusting the write: a driver with no support for
  # the call answers success and changes nothing.
  if ! $SUDO "$iw_bin" dev "$iface" get power_save 2>/dev/null | grep -qi 'power save: off'; then
    warn "Wi-Fi power saving could not be turned off on ${iface}. The hub works, but it may stop answering for minutes at a time while the radio sleeps — the apps and SSH both go quiet while the hub itself keeps running."
  elif [[ -z "$persisted" ]]; then
    warn "Wi-Fi power saving is off on ${iface} now, but it could not be made to stay off, so it comes back on the next reconnect."
  else
    say "Wi-Fi power saving is off on ${iface}, and stays off across reconnects (${persisted})."
  fi
}

# ── The hub has to announce itself, and it has to do it by broadcast ──────
# **The fault this fixes needs the path to be idle, and that is what named
# it.** A continuous one-per-second ping from a Mac on the same Wi-Fi held the
# hub reachable for fourteen minutes without a single loss, while twenty
# minutes earlier the same hub had been unreachable for four minutes at a
# stretch. Traffic prevented it; quiet caused it. That is the owner's whole
# experience too — open the app after a while and it cannot find the hub, keep
# using it and nothing ever goes wrong.
#
# What goes quiet is one *pair*. Measured on the hub this came from: the Mac
# is on 5 GHz and the hub's radio is on 2.4 GHz, so their traffic crosses the
# bridge between the two radios inside the router, and it is the entry for
# this hub on that bridge which ages out while it is silent. Everything else
# keeps working and says so — during one of these the hub answered its own
# health check in 3 ms, exchanged pings with the gateway throughout, and
# served another client 37 KB in a single 20-second window, while three pings
# from the Mac got nothing and its `rx_bytes` counter did not move by one of
# them. Nothing on the hub is wrong, which is why nothing on the hub ever
# reports it.
#
# **A unicast to the gateway does not fix this, and shipping one is how that
# was learned.** Those frames are addressed to the router itself and are
# consumed by it; they never cross the bridge they are meant to keep warm. A
# **gratuitous ARP is broadcast**, so it is flooded to every segment — it
# refreshes the access point's forwarding table on both radios and every
# client's ARP cache, in one frame of a few dozen bytes.
#
# Measured, with the path deliberately idled for 55 seconds between every
# probe, which is the condition the fault needs: **252 probes over four hours,
# 503 of 504 replies, one lost packet** — against a gateway control that lost
# none. Before it, the same probe found multi-minute blackouts.
#
# The gateway ping stays beside it: it costs nothing and it keeps the hub's own
# default route fresh. A wired hub gets none of this, for the reason it gets no
# dispatcher.
keep_wifi_reachable() {
  local iface self arping_bin unit="${GETHOME_KEEPALIVE_UNIT:-/etc/systemd/system/gethome-wifi-keepalive.service}"
  local script="${GETHOME_KEEPALIVE_SCRIPT:-/usr/local/lib/gethome-wifi-keepalive.sh}"

  iface="$(lan_wifi_iface)"
  [[ -n "$iface" ]] || return 0

  # `arping` sends the broadcast. It is only wanted on a wireless hub, so it is
  # installed here rather than with the base packages — and with the lists
  # refreshed first, for the reason `iw` is.
  arping_bin="$(find_arping)"
  if [[ -z "$arping_bin" ]]; then
    $SUDO apt-get update -qq >/dev/null 2>&1 || true
    $SUDO apt-get install -y -qq --no-install-recommends iputils-arping >/dev/null 2>&1 || true
    arping_bin="$(find_arping)"
  fi

  # Ask, never assume — `keep_wifi_awake`'s rule, and here it covers more than
  # a missing binary: an announcement that cannot be sent leaves the hub with
  # the gateway ping alone, which is the thing that was measured *not* to work.
  # One real broadcast during the install is what tells the two apart.
  self="$(ip -4 -o addr show "$iface" 2>/dev/null | awk '{ split($4, a, "/"); print a[1]; exit }')"
  if [[ -z "$arping_bin" ]] || ! $SUDO "$arping_bin" -U -c 1 -I "$iface" "${self:-0.0.0.0}" >/dev/null 2>&1; then
    warn "This hub reaches the network over Wi-Fi (${iface}) and could not announce itself to the router. It works, but it may become unreachable for minutes at a time after a quiet spell, while running perfectly."
    arping_bin=""
  fi

  $SUDO mkdir -p "$(dirname "$script")"
  if ! $SUDO tee "$script" >/dev/null <<KEEPALIVE
#!/bin/sh
# Installed by GetHome. deploy/install.sh says why in full; the short version
# is that the router ages this hub out of the table it uses to reach it from
# its other radio, a hub is silent for minutes at a time, and what comes of
# that is a hub nothing on the network can reach while it runs perfectly.
#
# **Broadcast is the whole point.** A gratuitous ARP is flooded to every
# segment, so it refreshes the access point's forwarding table on both radios
# and every client's ARP cache at once. A unicast to the router does not: it is
# addressed to the router itself and never crosses the bridge it is meant to
# keep warm. That was tried first and did not work.
#
# Everything is re-read each round rather than captured, so a lease or an
# interface that moves does not leave this announcing an address it no longer
# has. Nothing is checked for a reply: transmitting is what does the work.
while :; do
  iface=\$(ip route show default 2>/dev/null |
    awk '/^default/ { for (i = 1; i < NF; i++) if (\$i == "dev") { print \$(i + 1); exit } }')
  if [ -n "\$iface" ]; then
    self=\$(ip -4 -o addr show "\$iface" 2>/dev/null | awk '{ split(\$4, a, "/"); print a[1]; exit }')
    [ -n "\$self" ] && [ -x "${arping_bin:-/nonexistent}" ] &&
      "${arping_bin:-/nonexistent}" -U -c 1 -I "\$iface" "\$self" >/dev/null 2>&1
    gateway=\$(ip route show default 2>/dev/null | awk '/^default/ { print \$3; exit }')
    [ -n "\$gateway" ] && ping -c 1 -W 1 "\$gateway" >/dev/null 2>&1
  fi
  sleep 20
done
KEEPALIVE
  then
    warn "Could not install the Wi-Fi keep-alive. The hub works, but it may become unreachable for minutes at a time after a quiet spell, while running perfectly."
    return 0
  fi
  $SUDO chmod 0755 "$script"

  if $SUDO tee "$unit" >/dev/null <<UNIT
[Unit]
Description=Keep this hub reachable on Wi-Fi
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${script}
Restart=always
RestartSec=10
# Nothing here is urgent, and it must never be what wakes a loaded board.
Nice=10

[Install]
WantedBy=multi-user.target
UNIT
  then
    $SUDO systemctl daemon-reload >/dev/null 2>&1 || true
    $SUDO systemctl enable gethome-wifi-keepalive >/dev/null 2>&1 || true
    # `restart`, not `enable --now`. Every update re-runs this installer and
    # rewrites the script above, and `--now` on a unit that is already running
    # does nothing at all — so the fix would sit on disk until the next reboot
    # while the old one kept running. `restart` starts a stopped unit too.
    if $SUDO systemctl restart gethome-wifi-keepalive >/dev/null 2>&1; then
      say "The hub will announce itself on the network every 20 seconds, so it stays reachable after a quiet spell."
      return 0
    fi
  fi
  warn "Could not start the Wi-Fi keep-alive. The hub works, but it may become unreachable for minutes at a time after a quiet spell, while running perfectly."
}

keep_wifi_awake
keep_wifi_reachable

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
# ── Zigbee and Wi-Fi are the same band, and the default puts them on top ───
# 802.15.4 channels 11–26 sit 5 MHz apart from 2405 MHz and are 2 MHz wide; a
# 20 MHz Wi-Fi channel covers its centre ±11 MHz. So several Zigbee channels
# fall *inside* every Wi-Fi channel, and Zigbee2MQTT's default — 11, at
# 2405 MHz — is inside Wi-Fi channel 1, which is the commonest Wi-Fi channel
# there is. On this hardware the two radios are centimetres apart: the
# coordinator hangs off the Pi's USB socket and the Wi-Fi antenna is printed on
# the board beside it.
#
# What that costs is **retries and throughput, in proportion to how busy the
# Zigbee side is**, and it is worth being exact about the size of it: a Zigbee
# frame is tens of bytes at 250 kbit/s, so a quiet home is a fraction of a
# percent of the air and costs almost nothing. It is a standing handicap on the
# Wi-Fi rather than an outage — the thing to reach for when a hub is slow or
# lossy, not when it disappears completely, which is a link that is down or a
# path that is broken and wants looking for elsewhere. The reason to avoid it
# anyway is that it is free to avoid at install time and expensive afterwards.
#
# So the channel is picked at the only moment it can be picked: when this hub
# has never formed a network. Changing it afterwards is not an upgrade — it is
# a home whose sleepy devices all have to be paired again — so a hub that
# already has a network keeps the channel it formed on, whatever the Wi-Fi
# under it has done since.
# The other half of that decision, for a hub that already has a network. The
# channel is not ours to move there — but it is ours to *name*, because nothing
# else in the system ever will: Zigbee is connected, the devices report, and
# what suffers is the other radio. Said as a standing handicap, never as a
# diagnosis — see the sizing above.
zigbee_network_channel() {
  local backup="$Z2M_DATA_DIR/coordinator_backup.json" channel=""
  if [[ -f "$backup" ]]; then
    channel="$($SUDO grep -o '"logical_channel"[[:space:]]*:[[:space:]]*[0-9]*' "$backup" 2>/dev/null \
      | head -n1 | grep -o '[0-9]*$' || true)"
  fi
  if [[ -z "$channel" && -f "$Z2M_CONFIG" ]]; then
    channel="$($SUDO sed -n 's/^[[:space:]]*channel:[[:space:]]*\([0-9][0-9]*\).*/\1/p' \
      "$Z2M_CONFIG" 2>/dev/null | head -n1 || true)"
  fi
  printf '%s' "$channel"
}

warn_if_zigbee_jams_wifi() {
  local wifi_mhz zigbee_channel zigbee_mhz gap clear
  wifi_mhz="$(wifi_frequency_mhz)"
  zigbee_channel="$(zigbee_network_channel)"
  # No Wi-Fi to collide with, or no network yet: nothing to say either way.
  [[ -n "$wifi_mhz" && -n "$zigbee_channel" ]] || return 0
  (( zigbee_channel >= 11 && zigbee_channel <= 26 )) || return 0
  zigbee_mhz=$((2405 + 5 * (zigbee_channel - 11)))
  if (( zigbee_mhz > wifi_mhz )); then gap=$((zigbee_mhz - wifi_mhz)); else gap=$((wifi_mhz - zigbee_mhz)); fi
  # A 20 MHz Wi-Fi channel is its centre ±11 MHz. Inside that, the coordinator
  # is transmitting into this hub's own uplink from a few centimetres away.
  (( gap <= 11 )) || return 0
  clear="$(zigbee_channel_clear_of_wifi "$wifi_mhz")"
  warn "This hub's Wi-Fi (${wifi_mhz} MHz) and its Zigbee network (channel ${zigbee_channel}, ${zigbee_mhz} MHz) are on the same frequency, and the two radios are a few centimetres apart. They share the air rather than take turns, so the Wi-Fi carries more retries and less throughput than it should — how much depends on how busy the Zigbee network is, and a quiet one costs little. Channel ${clear} is clear of this hub's Wi-Fi. It is not changed for you, and is worth changing only if something is actually wrong: the network re-forms, so mains-powered devices usually follow and battery ones usually have to be paired again."
}

zigbee_channel_clear_of_wifi() {
  local wifi_mhz="$1" best=25 best_gap=-1 channel gap mhz
  # Nothing to measure — a wired hub, or a radio that would not say. 25 is
  # still the better guess than 11: it is clear of Wi-Fi 1 and 6, which is most
  # homes, and 11 sits inside the first of them.
  if [[ -z "$wifi_mhz" ]]; then printf '25'; return 0; fi
  # 26 is left out on purpose: several regions cap its transmit power and some
  # devices will not join on it at all.
  for channel in $(seq 11 25); do
    mhz=$((2405 + 5 * (channel - 11)))
    if (( mhz > wifi_mhz )); then gap=$((mhz - wifi_mhz)); else gap=$((wifi_mhz - mhz)); fi
    if (( gap > best_gap )); then best_gap=$gap; best=$channel; fi
  done
  printf '%s' "$best"
}

Z2M_CONFIG="$Z2M_DATA_DIR/configuration.yaml"
Z2M_ONBOARDING_CHANGED=""
if [[ ! -f "$Z2M_CONFIG" ]]; then
  # A backup means a network exists even with the config gone, and its channel
  # is not ours to move.
  if [[ -f "$Z2M_DATA_DIR/coordinator_backup.json" ]]; then
    Z2M_NEW_CONFIG=$'onboarding: false\n'
  else
    ZIGBEE_CHANNEL="$(zigbee_channel_clear_of_wifi "$(wifi_frequency_mhz)")"
    Z2M_NEW_CONFIG=$'onboarding: false\nadvanced:\n  channel: '"${ZIGBEE_CHANNEL}"$'\n'
    say "Zigbee will form its network on channel ${ZIGBEE_CHANNEL}, clear of this hub's Wi-Fi."
  fi
  printf '%s' "$Z2M_NEW_CONFIG" | $SUDO tee "$Z2M_CONFIG" >/dev/null \
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
# The hub's name, which is also the home's name — one hub hosts one home. This
# only seeds it: the first boot copies it into the database, and from then on
# the apps own it (PATCH /home). Editing this line later does nothing.
HUB_NAME=My Home
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
# The broker credentials, kept out of hub.env because that file is written only
# when it is absent and so never reaches a hub being upgraded. Optional with
# a leading dash: a hub whose installer could not set a password up has no such
# file and must still start, connecting to its broker anonymously as it always
# did. (No backticks in this heredoc — it is unquoted, so bash would run them.)
#
# **After** hub.env, which is what makes the MQTT_URL in it win. That matters
# only after a rollback, when the build being started again may be older than
# MQTT_USERNAME and the URL is the only way it can authenticate.
EnvironmentFile=-${CONF_DIR}/mqtt.env
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
# **The hub is not where headroom comes from.** Compressed swap is what lets a
# 512 MB board hold two radios, and the kernel spends it on whatever has been
# idle longest — which on a hub is the hub. Nobody talks to it for hours, so
# its heap and its JIT code go into zram, and Raspberry Pi OS's own
# rpi-zram-writeback then moves the idle part of that onto the SD card. Then a
# phone opens the app.
#
# Measured on a Zero 2 W that had been up 38 hours: hubd resident 35 MB with
# 55 MB of itself in swap, Zigbee2MQTT resident 24 MB with 83 MB in swap, 25 MB
# of the two written back to the card — with 110 MB of RAM free and the board
# at 0% CPU. Nothing needed that memory. Waking it is 14 000 single-page faults
# (vm.page-cluster is 0, so there is no readahead to amortise them), zstd
# decompression on a 1 GHz A53, and for the written-back part 4 KB random reads
# off an SD card. The app gives its health check four seconds.
#
# (No backticks below this line: the unit is written from an unquoted heredoc,
# so bash would run whatever they enclose. There is a test for that.)
#
# That is the whole shape of the fault this hub is unreachable with: the board
# is up, the automations keep firing — their working set is tiny and stays hot,
# which is why nothing points at memory — and the app and SSH both go quiet
# together while the machine faults a hundred megabytes back in. It clears by
# itself, and a second or third pull-to-refresh "fixing" it is the pages
# arriving, not the network recovering.
#
# So the hub's own memory is pinned and everything else keeps the swap: Z2M is
# the optional process (that is what its hard MemoryMax and +500 OOM score
# already say), and the page cache — 243 MB of node_modules read once at
# startup — is what the kernel should be reclaiming instead. This costs the
# board the hub's real working set in RAM, ~139 MB with both radios up against
# a 200 MB MemoryHigh, which is the number the sizing block was written around
# in the first place.
#
# cgroup v2 only, and silently ignored where the memory controller is off —
# which is every Raspberry Pi that has not rebooted since the section above
# turned it back on. That is the same caveat MemoryHigh carries, and the same
# reason OOMScoreAdjust exists beside it.
MemorySwapMax=0
# A memory spike should cost the hub a restart, not the machine a reboot.
OOMPolicy=continue
# And when the board genuinely runs out, the kernel should reach for
# Zigbee2MQTT rather than for the hub. This is the half of that promise which
# works everywhere: MemoryMax needs the memory cgroup, which Raspberry Pi OS
# turns off — see the section that turns it back on, and note that it only
# takes effect after a reboot — while oom_score_adj needs nothing at all and is
# in force the moment this unit starts.
#
# No backticks in this heredoc. It is unquoted, so bash runs whatever they
# enclose: three of them here put "MemoryMax: command not found" into a real
# install log and silently emptied the words out of the file.
# Deliberately not -1000, which would exempt the hub from the OOM killer
# outright: a hub that is itself leaking would then take the whole machine down
# instead of being restarted into a working one.
OOMScoreAdjust=-500

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
# ZIGBEE2MQTT_CONFIG_MQTT_USER / _PASSWORD, from the same file the hub reads.
# An override rather than an edit, for the reason above it: configuration.yaml
# holds the network key and the paired-device list and nothing here may rewrite
# it. Optional, so a hub with an open broker still starts.
EnvironmentFile=-${CONF_DIR}/mqtt.env
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
# The optional process, and so the one that should be picked first when the
# board runs out — the other side of the hub unit's -500, and the only side of
# it that works before the memory cgroup has been switched back on.
OOMScoreAdjust=500

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

# Updating from an app, on the same terms. The hub writes a run id into the
# same directory and this pair picks it up — so "update my hub" is a button on
# a phone rather than an SSH session on a laptop, and the hub still holds no
# privilege it didn't have before.
#
# The service is deliberately *not* enabled and carries no [Install] section:
# it is started by the path unit and must never run at boot, where it would
# update a hub nobody asked to update. It is also not ordered after the hub,
# because the installer it runs restarts the hub half way through and this must
# outlive that.
$SUDO install -m 0755 "$HUB_DIR/deploy/update-runner.sh" /usr/local/lib/gethome-update.sh 2>/dev/null \
  || warn "Could not install the update runner; this hub won't be able to update itself from an app."

$SUDO tee /etc/systemd/system/gethome-update.path >/dev/null <<UNIT
[Unit]
Description=Notice that a GetHome Hub update was asked for

[Path]
PathModified=${DATA_DIR}/update/request
Unit=gethome-update.service

[Install]
WantedBy=multi-user.target
UNIT

$SUDO tee /etc/systemd/system/gethome-update.service >/dev/null <<UNIT
[Unit]
Description=Update the GetHome Hub

[Service]
Type=oneshot
RemainAfterExit=no
Environment=GETHOME_CONF=${CONF_DIR}
Environment=GETHOME_DIR=${INSTALL_DIR}
ExecStart=/usr/local/lib/gethome-update.sh
# Not a number, and not the 90-second default a Type=oneshot otherwise gets.
# A real run is apt, a bundle over a domestic line, migrations onto an SD card,
# up to four minutes of health check and up to another minute waiting on Zigbee
# — and a source build, which a board over 1 GB is still allowed to do, is
# twenty minutes on its own. What makes a timeout here dangerous rather than
# merely annoying is *where* it would land: most likely after the symlink has
# been flipped to the new build and before the health check that would have
# rolled it back, killing the only thing that could undo it.
TimeoutStartSec=infinity
UNIT

# What the hub reads to know this machine can apply an update at all. A file in
# the hub's own directory rather than a systemd path it would have to know
# about: the hub stays portable, and this is written in the same breath as the
# units, so it cannot promise plumbing that was never installed.
$SUDO touch "${DATA_DIR}/update/enabled" 2>/dev/null || true
$SUDO chown -R "$SERVICE_USER:$SERVICE_USER" "${DATA_DIR}/update" 2>/dev/null || true

$SUDO systemctl daemon-reload
$SUDO systemctl enable gethome-hubd.service >/dev/null 2>&1
$SUDO systemctl enable gethome-zigbee-detect.service >/dev/null 2>&1 || true
$SUDO systemctl enable --now gethome-radio.path >/dev/null 2>&1 || true
$SUDO systemctl enable --now gethome-update.path >/dev/null 2>&1 || true
# Zigbee2MQTT, when it is already running, is holding a broker connection that
# was opened before any of this and may have been anonymous. Its unit has just
# gained the credentials, so it needs restarting to pick them up — but only if
# it is actually up: starting it here would hold ~150 MB open for a coordinator
# that may not exist, which is exactly why `gethome-zigbee-detect` owns its
# lifecycle and this unit is never enabled.
if systemctl is-active --quiet gethome-zigbee2mqtt.service 2>/dev/null; then
  $SUDO systemctl restart gethome-zigbee2mqtt.service >/dev/null 2>&1 \
    || warn "Zigbee2MQTT didn't restart after the broker credentials changed; Zigbee may be down."
fi
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
    printf '@@ROLLBACK:%s@@\n' "$(basename "$PREVIOUS_RELEASE")"
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

# A Zigbee network that works perfectly can still be sitting on top of this
# hub's own Wi-Fi, and nothing above would notice: the coordinator is reached,
# the devices report, and the only casualty is the other radio.
if [[ -n "$ZIGBEE_READY" ]]; then
  warn_if_zigbee_jams_wifi
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

# ── The broker asks for a password now ─────────────────────────────────────
# Only on a hub that already existed and had an open broker: a fresh install
# has nothing wired into it yet, and telling somebody their integrations broke
# before they have written one is noise on the last screen of a setup.
#
# It is a warning rather than a failure because the hub itself is fine — this
# is about the boards *around* it, and the fix is two fields in whatever wrote
# them, with the credentials one tap away in the app.
if [[ -n "$MQTT_WAS_OPEN" && -n "$MQTT_SECURED" ]]; then
  warn "The MQTT broker now asks for a username and password, so anything you wired into it yourself has stopped being able to publish. Open your hub in the GetHome app to copy the credentials — use the account named for your own devices — and put them into your board or integration. Zigbee, Matter and the apps are unaffected."
fi
if [[ -z "$MQTT_SECURED" ]]; then
  warn "This hub's MQTT broker takes connections with no password, so anyone on this network can read the home and control its Zigbee devices. Re-run the installer to close it."
fi

printf '@@DONE@@\n'
# Re-read rather than reprinting the copy taken at the health check. That one
# predates the detector, so on a board that just handed its radio to Zigbee it
# ended the install claiming `"matter":true` directly under a line saying
# Matter is off — and `"claimed":false` on a hub the owner had since claimed.
say "GetHome Hub is running: $(curl -fsS --max-time 5 http://localhost:8420/api/v1/hub 2>/dev/null || printf '%s' "$INFO")"
