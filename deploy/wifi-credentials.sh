#!/usr/bin/env bash
# GetHome Hub — tell the hub which Wi-Fi it is on, so it can pass it on.
#
#   wifi-credentials.sh [--conf /etc/gethome] [--quiet]
#
# Run at install time and again from a NetworkManager dispatcher on every
# association, so a home that retypes its Wi-Fi password next month does not
# quietly lose the ability to pair accessories.
#
# ── Why the hub is *given* this rather than reading it ─────────────────────
#
# A factory-new Matter accessory has no network. It advertises over Bluetooth,
# and the whole point of the conversation that follows is step 11 of the
# commissioning flow — `AddOrUpdateWiFiNetwork(ssid, credentials)` — where the
# commissioner hands the accessory the network it will live on. A hub that can
# do the Bluetooth half and not that one starts a pairing it cannot finish.
#
# The PSK lives in a root-owned NetworkManager profile. The hub runs as an
# unprivileged service account and the *point* of that account is that it
# cannot read files like that, so the answer is the same shape as every other
# privileged fact here: root writes one small file, group `gethome`, mode 0640,
# and the hub reads the one file it is deliberately allowed to read. That is a
# real widening — the account that can already send the PSK over the air can
# now also read it — and it is bounded to exactly that account and that file.
#
# An open network writes an empty PSK, which the hub reads as "no credentials":
# there is nothing to hand over, and an accessory given an empty password for a
# network it cannot join is worse than being told the hub has none.
set -uo pipefail

CONF_DIR="${GETHOME_CONF:-/etc/gethome}"
QUIET=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --conf) CONF_DIR="$2"; shift 2 ;;
    --quiet) QUIET=1; shift ;;
    *) shift ;;
  esac
done

say() { [[ -n "$QUIET" ]] || printf '%s\n' "$*"; }

OUT="$CONF_DIR/wifi.env"
GROUP="${GETHOME_GROUP:-gethome}"

command -v nmcli >/dev/null 2>&1 || {
  # A wpa_supplicant machine, or a wired hub. Nothing to do and nothing to say:
  # the hub reports that it has no credentials and the app asks for them.
  say "No NetworkManager here, so the hub has no Wi-Fi password to pass on."
  exit 0
}

# The connection carrying the default route, which is the network an accessory
# should be put on. `CONNECTION_UUID` is set when a dispatcher calls this, and
# is the authoritative answer for the association that just happened.
UUID="${CONNECTION_UUID:-}"
if [[ -z "$UUID" ]]; then
  UUID=$(nmcli -t -f UUID,TYPE connection show --active 2>/dev/null \
    | awk -F: '$2 == "802-11-wireless" { print $1; exit }')
fi
if [[ -z "$UUID" ]]; then
  say "This hub is not on Wi-Fi, so there is no password to pass on."
  exit 0
fi

# `-s` is what includes secrets, and is why this needs root. Two fields in one
# call so the SSID and the password can never come from different profiles.
SSID=$(nmcli -s -g 802-11-wireless.ssid connection show uuid "$UUID" 2>/dev/null | head -n1)
PSK=$(nmcli -s -g 802-11-wireless-security.psk connection show uuid "$UUID" 2>/dev/null | head -n1)

if [[ -z "$SSID" ]]; then
  say "Could not read this hub's Wi-Fi name; leaving the last known one in place."
  exit 0
fi

# Escaped into variables *first*, and that is not style. Used inline inside the
# `printf` below, the replacement's backslashes go through a second round of
# quote removal and `Dave's` comes out as `Dave\'\\'\''s` — the same shape of
# bug the sed program in `test/deploy-wifi.test.ts` records, and just as
# invisible until somebody's network is named after them.
SSID_Q=${SSID//\'/\'\\\'\'}
PSK_Q=${PSK//\'/\'\\\'\'}

mkdir -p "$CONF_DIR" 2>/dev/null || true
TMP="$OUT.tmp.$$"
# Written through a temporary file and renamed, unlike the radio mode: this one
# is read by another process at an arbitrary moment, and a torn read here is a
# hub handing an accessory half a password.
{
  printf '# Written by gethome-wifi-credentials. Do not edit.\n'
  printf '# The Wi-Fi this hub is on, so it can hand it to a Matter accessory\n'
  printf '# being paired over Bluetooth. See deploy/wifi-credentials.sh.\n'
  printf "WIFI_SSID='%s'\n" "$SSID_Q"
  printf "WIFI_PSK='%s'\n" "$PSK_Q"
} > "$TMP" 2>/dev/null || { say "Could not write ${OUT}."; exit 0; }

# Mode before the rename, so the file is never briefly world-readable under its
# final name.
chmod 0640 "$TMP" 2>/dev/null || true
chown "root:$GROUP" "$TMP" 2>/dev/null || chgrp "$GROUP" "$TMP" 2>/dev/null || true
mv -f "$TMP" "$OUT" 2>/dev/null || { rm -f "$TMP"; say "Could not write ${OUT}."; exit 0; }

if [[ -n "$PSK" ]]; then
  say "The hub can pass on this Wi-Fi (${SSID}) when it pairs a Matter accessory."
else
  say "This Wi-Fi (${SSID}) has no password, so there is nothing for the hub to pass on."
fi
exit 0
