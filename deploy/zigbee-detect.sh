#!/usr/bin/env bash
# GetHome Hub — find the Zigbee coordinator and switch Zigbee2MQTT on or off.
#
#   zigbee-detect.sh [--conf /etc/gethome] [--quiet] [--no-start]
#
# Run at install time, at every boot, and by udev whenever a USB serial device
# appears *or* disappears (see gethome-zigbee-detect.service). That is what
# makes "plug the stick in later" work with nothing for the user to do: the
# coordinator shows up, this script records its path and starts
# gethome-zigbee2mqtt.service, and the hub — which stays subscribed to the
# broker whether Zigbee is running or not — picks the devices up. No reboot,
# and no restart of the hub itself.
#
# It is also what *stops* Zigbee2MQTT. Zigbee2MQTT is a second full Node.js
# process, around 150 MB; on a 512 MB board, keeping it running to wait for
# hardware that may never be bought is memory the hub needs. So the service is
# installed but not enabled, and this script owns whether it runs.
#
# It only ever acts on hardware it is *sure* about. Plenty of harmless things
# are USB serial devices — 3D printers, UPSes, GPS pucks, Arduinos — and
# handing one of those to Zigbee2MQTT would be worse than doing nothing. A
# device we can't place is reported (`maybe`), never enabled automatically;
# GetHome Studio offers those to the user to pick from instead.
#
# The coordinator path is written as an *override* (ZIGBEE2MQTT_CONFIG_*), not
# into Zigbee2MQTT's own configuration.yaml: that file holds the network key
# and the paired-device list, and rewriting it would lose the user's network.
#
# Exit status: 0 when Zigbee is configured (already or just now), 1 when no
# coordinator was found. Never fails the caller — the hub runs fine without it.
set -uo pipefail

CONF_DIR="${GETHOME_CONF:-/etc/gethome}"
QUIET=""
NO_START=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --conf) CONF_DIR="$2"; shift 2 ;;
    --quiet) QUIET=1; shift ;;
    # Record the adapter but leave starting the service to the caller —
    # install.sh is about to bring everything up anyway.
    --no-start) NO_START=1; shift ;;
    *) shift ;;
  esac
done

say() { [[ -n "$QUIET" ]] || printf '%s\n' "$*"; }

ENV_FILE="$CONF_DIR/zigbee.env"
UNIT="gethome-zigbee2mqtt.service"
HUB_ENV="$CONF_DIR/hub.env"
HUB_UNIT="gethome-hubd.service"

# ── Identification ─────────────────────────────────────────────────────────
# Two signals. The by-id name carries the USB manufacturer/product strings,
# which for real coordinators say so outright. Where the strings are generic
# (a bare USB-serial bridge chip), fall back to the USB ids.

# USB vendor:product pairs that are Zigbee coordinators and nothing else.
CERTAIN_IDS=(
  "1cf1:0030" # dresden elektronik ConBee II
  "1cf1:0032" # dresden elektronik ConBee III
  "0451:16a8" # Texas Instruments CC2531
  "0451:16c8" # Texas Instruments CC2538
  # Deliberately *not* the Home Assistant Connect ZBT-2's 303a:4001. That vendor
  # id is Espressif's and is on a great many ESP32 boards; zigbee-herdsman won't
  # act on the pair alone either — it also requires the manufacturer string and
  # a path regex. The name rule below matches `Nabu_Casa_ZBT-2` anyway, so the
  # id would add nothing but a chance to adopt somebody's dev board.
)

# Generic USB-serial bridges. Sonoff and friends use these, but so does half
# the maker world — never auto-enable on one of these alone.
MAYBE_IDS=(
  "10c4:ea60" # Silicon Labs CP210x
  "1a86:55d4" # QinHeng CH9102
  "1a86:7523" # QinHeng CH340
  "0403:6001" # FTDI FT232
  "0403:6015" # FTDI FT-X
  "0451:bef3" # TI XDS110 debug probe — a CC2652 LaunchPad, or any other
              # LaunchPad, so it is offered rather than assumed
)

usb_ids() {
  local device="$1" vendor product
  vendor=$(udevadm info --query=property --name="$device" 2>/dev/null \
    | sed -n 's/^ID_VENDOR_ID=//p' | head -n1)
  product=$(udevadm info --query=property --name="$device" 2>/dev/null \
    | sed -n 's/^ID_MODEL_ID=//p' | head -n1)
  [[ -n "$vendor" && -n "$product" ]] && printf '%s:%s' "$vendor" "$product"
}

contains() {
  local needle="$1"; shift
  local item
  for item in "$@"; do [[ "$item" == "$needle" ]] && return 0; done
  return 1
}

# certain | maybe | no
classify() {
  local device="$1"
  local name ids
  name=$(basename "$device" | tr '[:upper:]' '[:lower:]')

  # Checked against zigbee-herdsman's own device table by running every example
  # by-id path it documents through this function: the five names on the second
  # line were the gap. Without `cc2538` a Texas Instruments CC2538 was invisible
  # here — neither its name nor its `0451:16c8` matched anything — so it could
  # not even be offered; the other four fell through to their generic bridge id
  # and were demoted to `maybe`, which asks the user about hardware we can in
  # fact identify by name.
  case "$name" in
    *zigbee*|*zbdongle*|*conbee*|*raspbee*|*slzb*|*smlight*|*deconz*|*zzh*|\
    *skyconnect*|*nabu_casa*|*sonoff*|*cc2531*|*cc2652*|*cc1352*|*efr32*|*ezsp*|\
    *cc2538*|*zigate*|*tubeszb*|*zigstar*|*electrolama*)
      printf 'certain'; return ;;
  esac

  ids=$(usb_ids "$device")
  [[ -z "$ids" ]] && { printf 'no'; return; }
  if contains "$ids" "${CERTAIN_IDS[@]}"; then printf 'certain'; return; fi
  if contains "$ids" "${MAYBE_IDS[@]}"; then printf 'maybe'; return; fi
  printf 'no'
}

# ── Scan ───────────────────────────────────────────────────────────────────
# Prefer stable /dev/serial/by-id paths: they survive reboots and replugging,
# unlike /dev/ttyACM0, which moves the moment a second device appears. Only
# fall back to the raw nodes when by-id isn't populated, so one physical stick
# can't be reported twice under two names.
#
# The scan root is overridable, and that is not a convenience. Staging a
# coordinator in a test used to be possible only by *pinning* one — and pinning
# is the single case the file-writing path below got right, so the bug that
# left `zigbee.env` unwritten on every ordinary install was invisible to a
# suite that otherwise drives this whole script. A directory of fake by-id
# names makes detection testable the way it actually happens.
SCAN_DIR="${GETHOME_ZIGBEE_SCAN_DIR:-/dev/serial/by-id}"

CANDIDATES=()
for candidate in "$SCAN_DIR"/*; do
  [[ -e "$candidate" ]] && CANDIDATES+=("$candidate")
done
# Raw device nodes are the fallback for systems where by-id isn't populated —
# but only for the real one. An overridden scan root means "look here", and
# reaching past it to the machine's own /dev would make a test depend on
# whatever is plugged into the machine running it.
if [[ ${#CANDIDATES[@]} -eq 0 && "$SCAN_DIR" == "/dev/serial/by-id" ]]; then
  for candidate in /dev/ttyUSB* /dev/ttyACM*; do
    [[ -e "$candidate" ]] && CANDIDATES+=("$candidate")
  done
fi

FOUND=""
MAYBES=()
for candidate in ${CANDIDATES[@]+"${CANDIDATES[@]}"}; do
  case "$(classify "$candidate")" in
    certain) FOUND="$candidate"; break ;;
    maybe) MAYBES+=("$candidate") ;;
  esac
done

# An adapter the user named explicitly wins over anything found here: they
# know what they plugged in, and this script deliberately refuses to guess
# about generic bridges.
PINNED=$(sed -n 's/^GETHOME_ZIGBEE_PINNED=//p' "$ENV_FILE" 2>/dev/null | head -n1)
if [[ -n "$PINNED" && -e "$PINNED" ]]; then
  FOUND="$PINNED"
fi

for candidate in ${MAYBES[@]+"${MAYBES[@]}"}; do
  say "@@ZIGBEE_MAYBE:${candidate}@@"
done

# ── Which radio this board runs ────────────────────────────────────────────
# Two separate things, easy to confuse:
#
#   the *budget*     — how many radios the board can afford at once. Measured,
#                      not chosen: a 512 MB board fits the OS, the hub and one
#                      of {Zigbee2MQTT ~150 MB, Matter ~60-90 MB inside the
#                      hub}, not both. install.sh writes GETHOME_RADIO=one
#                      there and GETHOME_RADIO=both on anything larger.
#   the *preference* — which one the owner wants when only one fits. Written
#                      by the hub to <DATA_DIR>/radio-mode when the owner
#                      switches in the app, so the hub never needs sudo; a
#                      .path unit wakes this script to apply it.
#
# This script is where they meet, because it already runs at boot, on every
# plug and unplug, and at the end of the install — it is the only thing that
# knows whether a coordinator is actually there.
read_env() { sed -n "s/^$1=//p" "$2" 2>/dev/null | tail -n1; }

BUDGET=$(read_env GETHOME_RADIO "$HUB_ENV")
[[ -n "$BUDGET" ]] || BUDGET=both
DATA_DIR=$(read_env DATA_DIR "$HUB_ENV")
[[ -n "$DATA_DIR" ]] || DATA_DIR=/var/lib/gethome/data

MODE=auto
if [[ -r "$DATA_DIR/radio-mode" ]]; then
  MODE=$(tr -d '[:space:]' < "$DATA_DIR/radio-mode" 2>/dev/null)
  case "$MODE" in auto|zigbee|matter|both) ;; *) MODE=auto ;; esac
fi

# Only `matter` stops Zigbee outright; it is the one choice that means "do not
# use the stick even though it is here".
ZIGBEE_ALLOWED=1
[[ "$MODE" == "matter" ]] && ZIGBEE_ALLOWED=0

# Matter gives way only when Zigbee is *genuinely going to run*. Turning it off
# for a coordinator that isn't plugged in is how a hub ends up talking to
# nothing at all — no Zigbee because there is no stick, no Matter because we
# reserved the memory for one. That is the trap install.sh warns about, and it
# would be a poor way to reintroduce it.
MATTER_WANTED=1
if [[ "$ZIGBEE_ALLOWED" == "1" && -n "$FOUND" ]]; then
  case "$BUDGET:$MODE" in
    one:*)       MATTER_WANTED=0 ;;  # one radio's memory, and Zigbee has it
    both:zigbee) MATTER_WANTED=0 ;;  # room for both, owner asked for Zigbee alone
  esac
fi

has_systemd() { command -v systemctl >/dev/null 2>&1; }

# Turn Matter on or off to match, and restart the hub only when the value
# really changed — this script runs on every USB event, and a hub that
# restarted each time somebody plugged in a phone charger would be worse than
# the problem being solved.
apply_matter() {
  [[ -w "$HUB_ENV" || -w "$CONF_DIR" ]] || return 0
  local current
  current=$(read_env ADAPTER_MATTER "$HUB_ENV")
  [[ "$current" == "$MATTER_WANTED" ]] && return 0
  if grep -q '^ADAPTER_MATTER=' "$HUB_ENV" 2>/dev/null; then
    sed -i "s/^ADAPTER_MATTER=.*/ADAPTER_MATTER=${MATTER_WANTED}/" "$HUB_ENV" || return 0
  else
    printf 'ADAPTER_MATTER=%s\n' "$MATTER_WANTED" >> "$HUB_ENV" || return 0
  fi
  if [[ "$MATTER_WANTED" == "1" ]]; then
    say "Turning Matter on: this board has room for it."
  else
    say "Turning Matter off: this board affords one radio and Zigbee has it."
  fi
  if has_systemd && systemctl is-active --quiet "$HUB_UNIT" 2>/dev/null; then
    systemctl restart "$HUB_UNIT" >/dev/null 2>&1 \
      || say "The hub wouldn't restart. See: journalctl -u ${HUB_UNIT} -n 50"
  fi
}

stop_zigbee_if_running() {
  if has_systemd && systemctl is-active --quiet "$UNIT" 2>/dev/null; then
    systemctl stop "$UNIT" >/dev/null 2>&1 || true
    return 0
  fi
  return 1
}

# ── Apply ──────────────────────────────────────────────────────────────────

if [[ -z "$FOUND" ]]; then
  say "No Zigbee coordinator found."
  if [[ ${#MAYBES[@]} -gt 0 ]]; then
    say "There is a USB serial device attached, but it doesn't identify itself as a Zigbee coordinator: ${MAYBES[0]}"
    say "If that is your Zigbee stick, re-run the installer with: --zigbee ${MAYBES[0]}"
  fi
  # Nothing plugged in means nothing to run. Leaving Zigbee2MQTT up would be
  # a restart loop against a device node that no longer exists, and ~150 MB
  # held for no reason.
  if stop_zigbee_if_running; then
    say "Stopping Zigbee2MQTT: the coordinator is gone."
  fi
  # …and those 150 MB are exactly what Matter needs, so hand them over. This
  # is the case the installer used to get wrong: it switched Matter off on
  # every small board at install time, whether or not a stick was ever there.
  apply_matter
  exit 1
fi

say "@@ZIGBEE_FOUND:${FOUND}@@"
say "Zigbee coordinator: ${FOUND}"

mkdir -p "$CONF_DIR"

# ── Two paths for the same stick, and each is used for what it is good at ──
# `FOUND` is the stable `/dev/serial/by-id/…` name. It survives reboots and
# replugging, so it stays our record of *which* device this is.
#
# Zigbee2MQTT gets the resolved node (`/dev/ttyACM0`) instead, and that is not a
# preference — it is the difference between working and not. Since 1.41 it will
# not guess an adapter type, and its discovery matches the configured port
# against `SerialPort.list()`, which reports real device nodes. A by-id path
# equals none of them, every port is skipped, and it exits with
# `USB adapter discovery error (No valid USB adapter found)` — with a
# coordinator sitting right there, correctly identified by this script.
# Reproduced against zigbee-herdsman 10.8.0 with a real dongle's port data.
#
# Setting `serial.adapter` would also work and would keep the by-id path, but it
# is the worse fix twice over: it means keeping a copy of upstream's device
# table here, and with a by-id path the *options* lookup still misses, so the
# `rtscts` some adapters need is silently not applied. Handing over the resolved
# node lets upstream identify the stick from its own table, correctly, including
# those options.
#
# The instability of `/dev/ttyACM*` is what by-id exists to avoid, and it is
# handled rather than ignored: this script re-runs at boot and on every USB plug
# and unplug, `gethome-zigbee2mqtt` is never enabled on its own, and the compare
# below covers the resolved path too — so a renumbered node is rewritten and the
# service restarted before it can matter.
FOUND_NODE=$(readlink -f "$FOUND" 2>/dev/null || true)
[[ -n "$FOUND_NODE" && -e "$FOUND_NODE" ]] || FOUND_NODE="$FOUND"

CURRENT=$(sed -n 's/^ZIGBEE_ADAPTER=//p' "$ENV_FILE" 2>/dev/null | head -n1)
CURRENT_NODE=$(sed -n 's/^ZIGBEE2MQTT_CONFIG_SERIAL_PORT=//p' "$ENV_FILE" 2>/dev/null | head -n1)
if [[ "$CURRENT" != "$FOUND" || "$CURRENT_NODE" != "$FOUND_NODE" ]]; then
  # The pinned line is written with `if`, not `[[ … ]] && echo`, and that is
  # not style. A group's exit status is its *last* command's, so the `&&`
  # form made the whole `{ … }` return 1 whenever nothing was pinned — which
  # is every install that doesn't pass --zigbee, i.e. the normal one. The
  # `mv` then never ran: the temp file held a perfect config, `zigbee.env`
  # was never created, and the only trace was `chmod: cannot access …`.
  # Zigbee2MQTT starts anyway (its EnvironmentFile is optional by design),
  # finds no serial port, and never reaches the stick — so a hub with a
  # correctly identified coordinator sat at `zigbee.connected: false`.
  if {
    echo "# Written by gethome-zigbee-detect. Editing GETHOME_ZIGBEE_PINNED here"
    echo "# forces a particular device; everything else is detected."
    echo "# ZIGBEE_ADAPTER is the stable by-id name — which device this is."
    echo "# SERIAL_PORT is the node it resolves to, which is what Zigbee2MQTT's"
    echo "# adapter discovery can actually match. See the note in the script."
    echo "ZIGBEE_ADAPTER=${FOUND}"
    echo "ZIGBEE2MQTT_CONFIG_SERIAL_PORT=${FOUND_NODE}"
    if [[ -n "$PINNED" ]]; then echo "GETHOME_ZIGBEE_PINNED=${PINNED}"; fi
  } > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"; then
    chmod 0644 "$ENV_FILE"
  else
    # Say it rather than leaving it to be inferred from a chmod error. Without
    # this file Zigbee2MQTT has no coordinator, so claiming Zigbee works would
    # be the same silent lie as before.
    rm -f "$ENV_FILE.tmp"
    say "Could not write ${ENV_FILE} — Zigbee2MQTT will not know where the coordinator is."
    exit 1
  fi
fi

# A coordinator is plugged in, but the owner asked this board to run Matter
# instead. Record the device — so switching back needs no replug — and leave
# Zigbee2MQTT down. Exit 1 because Zigbee is genuinely not running, which is
# what the installer reads to decide what to tell the user.
if [[ "$ZIGBEE_ALLOWED" == "0" ]]; then
  say "A Zigbee coordinator is plugged in, but this hub is set to run Matter instead."
  say "Switch it in the GetHome app to use Zigbee; the coordinator stays configured either way."
  if stop_zigbee_if_running; then
    say "Stopping Zigbee2MQTT: Matter has this board's radio budget."
  fi
  apply_matter
  exit 1
fi

# Zigbee is the radio for this board, so on a one-radio board Matter gives way
# before Zigbee2MQTT is started — starting both and letting the kernel decide
# is how a hub ends up thrashing.
apply_matter

if [[ -n "$NO_START" ]]; then
  say "Zigbee is configured; the installer will start it."
  exit 0
fi

if ! has_systemd; then
  say "No systemd here — start Zigbee2MQTT yourself."
  exit 0
fi

# A changed device path needs a restart, not a start: the running process is
# holding the old one. Either path changing counts — the by-id name means a
# different stick, the node means the same stick renumbered, and Zigbee2MQTT is
# configured with the node.
if [[ "$CURRENT" != "$FOUND" || "$CURRENT_NODE" != "$FOUND_NODE" ]] \
   && systemctl is-active --quiet "$UNIT" 2>/dev/null; then
  say "The coordinator moved to ${FOUND_NODE}; restarting Zigbee2MQTT."
  systemctl restart "$UNIT" >/dev/null 2>&1 || true
elif ! systemctl is-active --quiet "$UNIT" 2>/dev/null; then
  say "Starting Zigbee2MQTT…"
  systemctl start "$UNIT" >/dev/null 2>&1 \
    || say "Zigbee2MQTT wouldn't start. See: journalctl -u ${UNIT} -n 50"
fi

# The Pi 3 and Zero 2 W hand their good UART to Bluetooth and leave the
# console on the pins, so a coordinator wired to the GPIO header needs a
# config.txt change that only takes effect on reboot. Saying so is the whole
# point: a user who plugs a USB stick in is done in seconds, and a user who
# wired one to the header should not be left wondering.
case "$FOUND" in
  /dev/ttyAMA*|/dev/serial0|/dev/serial1|/dev/ttyS0)
    say "@@WARN:This Zigbee coordinator is connected to the Pi's GPIO serial port. That port is shared with the console and Bluetooth, so it needs 'enable_uart=1' and 'dtoverlay=disable-bt' in /boot/firmware/config.txt — and those only take effect after the Pi restarts. A USB coordinator needs none of this.@@"
    ;;
esac

exit 0
