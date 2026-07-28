#!/usr/bin/env bash
# GetHome Hub — find the Zigbee coordinator and switch Zigbee2MQTT on.
#
#   zigbee-detect.sh [--dir /opt/gethome/gethome-hub] [--quiet]
#
# Run at install time, and again by udev whenever a USB serial device appears
# (see gethome-zigbee.service). That is what makes "plug the stick in later"
# work with nothing for the user to do: the coordinator shows up, this script
# writes ZIGBEE_ADAPTER into .env and brings the zigbee profile up.
#
# It only ever acts on hardware it is *sure* about. Plenty of harmless things
# are USB serial devices — 3D printers, UPSes, GPS pucks, Arduinos — and
# handing one of those to Zigbee2MQTT would be worse than doing nothing. A
# device we can't place is reported (`maybe`), never enabled automatically;
# GetHome Studio offers those to the user to pick from instead.
#
# Exit status: 0 when Zigbee is configured (already or just now), 1 when no
# coordinator was found. Never fails the caller — the hub runs fine without it.
set -uo pipefail

INSTALL_DIR="${GETHOME_DIR:-/opt/gethome/gethome-hub}"
QUIET=""
NO_START=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --quiet) QUIET=1; shift ;;
    # Write .env but leave starting the stack to the caller — install.sh is
    # about to bring everything up anyway.
    --no-start) NO_START=1; shift ;;
    *) shift ;;
  esac
done

say() { [[ -n "$QUIET" ]] || printf '%s\n' "$*"; }

# ── Identification ─────────────────────────────────────────────────────────
# Two signals. The by-id name carries the USB manufacturer/product strings,
# which for real coordinators say so outright. Where the strings are generic
# (a bare USB-serial bridge chip), fall back to the USB ids.

# USB vendor:product pairs that are Zigbee coordinators and nothing else.
CERTAIN_IDS=(
  "1cf1:0030" # dresden elektronik ConBee II
  "1cf1:0032" # dresden elektronik ConBee III
  "0451:16a8" # Texas Instruments CC2531
  "0451:bef3" # Texas Instruments CC2652 / LAUNCHXL
)

# Generic USB-serial bridges. Sonoff and friends use these, but so does half
# the maker world — never auto-enable on one of these alone.
MAYBE_IDS=(
  "10c4:ea60" # Silicon Labs CP210x
  "1a86:55d4" # QinHeng CH9102
  "1a86:7523" # QinHeng CH340
  "0403:6001" # FTDI FT232
  "0403:6015" # FTDI FT-X
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

for candidate in ${MAYBES[@]+"${MAYBES[@]}"}; do
  say "@@ZIGBEE_MAYBE:${candidate}@@"
done

if [[ -z "$FOUND" ]]; then
  say "No Zigbee coordinator found."
  if [[ ${#MAYBES[@]} -gt 0 ]]; then
    say "There is a USB serial device attached, but it doesn't identify itself as a Zigbee coordinator: ${MAYBES[0]}"
    say "If that is your Zigbee stick, re-run the installer with: --zigbee ${MAYBES[0]}"
  fi
  exit 1
fi

say "@@ZIGBEE_FOUND:${FOUND}@@"
say "Zigbee coordinator: ${FOUND}"

# ── Apply ──────────────────────────────────────────────────────────────────
cd "$INSTALL_DIR" 2>/dev/null || { say "No hub install at ${INSTALL_DIR}."; exit 1; }
[[ -f .env ]] || touch .env

CURRENT=$(sed -n 's/^ZIGBEE_ADAPTER=//p' .env | head -n1)
if [[ "$CURRENT" == "$FOUND" ]] && grep -q '^COMPOSE_PROFILES=.*zigbee' .env; then
  say "Zigbee is already set up for this coordinator; nothing to do."
  exit 0
fi

sed -i '/^ZIGBEE_ADAPTER=/d;/^COMPOSE_PROFILES=/d' .env
{
  echo "ZIGBEE_ADAPTER=${FOUND}"
  echo "COMPOSE_PROFILES=zigbee"
} >> .env

if [[ -n "$NO_START" ]]; then
  say "Zigbee is configured; the installer will start it."
  exit 0
fi

DOCKER="docker"
docker info >/dev/null 2>&1 || DOCKER="sudo docker"
say "Starting Zigbee2MQTT…"
$DOCKER compose up -d 2>&1 | sed 's/^/  /'
exit 0
