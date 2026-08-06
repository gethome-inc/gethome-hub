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

# ── Identification ─────────────────────────────────────────────────────────
# Two signals. The by-id name carries the USB manufacturer/product strings,
# which for real coordinators say so outright. Where the strings are generic
# (a bare USB-serial bridge chip), fall back to the USB ids.

# USB vendor:product pairs that are Zigbee coordinators and nothing else.
CERTAIN_IDS=(
  "1cf1:0030" # dresden elektronik ConBee II
  "1cf1:0032" # dresden elektronik ConBee III
  "0451:16a8" # Texas Instruments CC2531
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

  case "$name" in
    *zigbee*|*zbdongle*|*conbee*|*raspbee*|*slzb*|*smlight*|*deconz*|*zzh*|\
    *skyconnect*|*nabu_casa*|*sonoff*|*cc2531*|*cc2652*|*cc1352*|*efr32*|*ezsp*)
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
CANDIDATES=()
for candidate in /dev/serial/by-id/*; do
  [[ -e "$candidate" ]] && CANDIDATES+=("$candidate")
done
if [[ ${#CANDIDATES[@]} -eq 0 ]]; then
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

# ── Apply ──────────────────────────────────────────────────────────────────
has_systemd() { command -v systemctl >/dev/null 2>&1; }

if [[ -z "$FOUND" ]]; then
  say "No Zigbee coordinator found."
  if [[ ${#MAYBES[@]} -gt 0 ]]; then
    say "There is a USB serial device attached, but it doesn't identify itself as a Zigbee coordinator: ${MAYBES[0]}"
    say "If that is your Zigbee stick, re-run the installer with: --zigbee ${MAYBES[0]}"
  fi
  # Nothing plugged in means nothing to run. Leaving Zigbee2MQTT up would be
  # a restart loop against a device node that no longer exists, and ~150 MB
  # held for no reason.
  if has_systemd && systemctl is-active --quiet "$UNIT" 2>/dev/null; then
    say "Stopping Zigbee2MQTT: the coordinator is gone."
    systemctl stop "$UNIT" >/dev/null 2>&1 || true
  fi
  exit 1
fi

say "@@ZIGBEE_FOUND:${FOUND}@@"
say "Zigbee coordinator: ${FOUND}"

mkdir -p "$CONF_DIR"
CURRENT=$(sed -n 's/^ZIGBEE_ADAPTER=//p' "$ENV_FILE" 2>/dev/null | head -n1)
if [[ "$CURRENT" != "$FOUND" ]]; then
  {
    echo "# Written by gethome-zigbee-detect. Editing GETHOME_ZIGBEE_PINNED here"
    echo "# forces a particular device; everything else is detected."
    echo "ZIGBEE_ADAPTER=${FOUND}"
    echo "ZIGBEE2MQTT_CONFIG_SERIAL_PORT=${FOUND}"
    [[ -n "$PINNED" ]] && echo "GETHOME_ZIGBEE_PINNED=${PINNED}"
  } > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
  chmod 0644 "$ENV_FILE"
fi

if [[ -n "$NO_START" ]]; then
  say "Zigbee is configured; the installer will start it."
  exit 0
fi

if ! has_systemd; then
  say "No systemd here — start Zigbee2MQTT yourself."
  exit 0
fi

# A changed device path needs a restart, not a start: the running process is
# holding the old one.
if [[ "$CURRENT" != "$FOUND" ]] && systemctl is-active --quiet "$UNIT" 2>/dev/null; then
  say "The coordinator moved to ${FOUND}; restarting Zigbee2MQTT."
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
