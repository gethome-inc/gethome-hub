#!/usr/bin/env bash
# GetHome Hub — the Wi-Fi networks this hub knows, changed from an app.
#
#   wifi-networks.sh            apply what the hub asked for, then --list
#   wifi-networks.sh --list     write down the networks this machine knows
#
# Installed as /usr/local/lib/gethome-wifi-networks.sh. The first form is
# started by gethome-wifi.path when the hub writes <DATA_DIR>/wifi/request; the
# second runs at install time and from a NetworkManager dispatcher on every
# association, so "which one is it on now" stays true.
#
# ── Why this exists ────────────────────────────────────────────────────────
# A hub is set up on one Wi-Fi and then carried somewhere else — a flat it is
# being moved to, a house in the country — where it finds a network it has never
# heard of, joins nothing, and answers no app. The only ways back were an
# Ethernet cable or taking the card out and writing it again.
#
# NetworkManager already does the rest by itself: it joins any network it holds
# a profile for, preferring the one it used most recently. So telling it about
# the other network *before* the move is the whole of the fix — the hub stays on
# the network it is on today, and joins the new one the first time it powers up
# where that one is.
#
# Those profiles are root's, and the hub runs as an account whose point is that
# it cannot touch them. So the same trade the radio switch and the update make:
# the hub writes one small file into a directory it already owns, a .path unit
# notices, and this script — root, started by systemd, reachable from nothing
# else — does the work. No sudo rule, nothing new to lock down.
#
# ── What it refuses, and why each one is here as well as in the hub ────────
# The hub checks all of these against the list this script last wrote. That
# list can be a minute stale, so the checks that matter are made again here,
# against NetworkManager itself, at the moment of the change.
#
# * **The network the hub is on now cannot be removed.** Deleting an active
#   profile takes the connection down with it, and a hub that drops off its only
#   network is one no app can reach to put it back — the fix would be a cable or
#   the card. That is the one change here that is not bounded, so it is refused
#   rather than confirmed.
# * **One profile per name.** Two profiles for one network are tried in turn,
#   and a stale password in the first can hold the second up for minutes after
#   every reconnect. Changing a password is remove-then-add.
# * **Wi-Fi profiles only, and at most 16.** Nothing else NetworkManager holds is
#   this script's business, and a bound keeps a client stuck in a loop from
#   filling the card with profiles.
#
# ── The request is the hub user's, and this is root ────────────────────────
# Every field is validated before it reaches nmcli, and every value is passed as
# its own argument — never through a shell. The password arrives as the derived
# 64-hex WPA key, never as the passphrase (the hub derives it, as GetHome Studio
# and Raspberry Pi Imager do for a card), and it is in nmcli's argv for the
# moment the profile takes to write. Everybody on this machine who could read
# that already holds a way to the same key: root, the first user's NOPASSWD
# sudo, and the hub's own account, which is handed the active network's key in
# /etc/gethome/wifi.env so it can pair Matter accessories.
#
# **And the directory is the hub user's too, so this reads and writes there as
# that account, never as root** (`as_hub`). Root following a name in a
# directory somebody else controls follows whatever they put there: a request
# that is a link to a file only root may read, or a list written through a link
# into a file only root may write — and `chmod` and `chown`, which follow links,
# would then hand that file to the hub's group. Done as the hub's account, any
# such link reaches only what that account could reach already. Only nmcli runs
# as root, because only nmcli needs to.
set -uo pipefail

CONF_DIR="${GETHOME_CONF:-/etc/gethome}"
HUB_ENV="$CONF_DIR/hub.env"
# The account the hub runs as and the data directory belongs to. The group was
# the only name passed before this read and wrote as the account, and the two
# are the same word on every install, so it still stands in for an older unit.
HUB_USER="${GETHOME_USER:-${GETHOME_GROUP:-gethome}}"
MAX_NETWORKS=16

read_env() { sed -n "s/^$1=//p" "$2" 2>/dev/null | tail -n1; }

DATA_DIR=$(read_env DATA_DIR "$HUB_ENV")
[[ -n "$DATA_DIR" ]] || DATA_DIR=/var/lib/gethome/data

WIFI_DIR="$DATA_DIR/wifi"
REQUEST="$WIFI_DIR/request"
NETWORKS_FILE="$WIFI_DIR/networks"
RESULT_FILE="$WIFI_DIR/result"

MODE="apply"
QUIET=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --list) MODE="list"; shift ;;
    --quiet) QUIET=1; shift ;;
    *) shift ;;
  esac
done

say() { [[ -n "$QUIET" ]] || printf '%s\n' "$*"; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# An SSID is up to 32 arbitrary bytes, so it travels between this script and the
# hub as hex: nothing a network can be called can then break a line, a quote or
# a parser on either side.
to_hex() { printf '%s' "$1" | od -An -tx1 -v | tr -d ' \n'; }

# Run a command as the hub's account — see "the directory is the hub user's
# too" above. setpriv first, because it is a plain setresuid with no PAM session
# to write two journal lines on every association; runuser where it is missing.
# Both are util-linux, which Debian marks essential. Not running as root — the
# suite, or anybody running this by hand — there is nothing to drop.
as_hub() {
  local uid gid
  if [[ "$(id -u)" != "0" ]]; then
    "$@"
    return
  fi
  uid="$(id -u "$HUB_USER" 2>/dev/null)" || return 1
  gid="$(id -g "$HUB_USER" 2>/dev/null)" || return 1
  if command -v setpriv >/dev/null 2>&1; then
    setpriv --reuid="$uid" --regid="$gid" --clear-groups -- "$@"
  elif command -v runuser >/dev/null 2>&1; then
    runuser -u "$HUB_USER" -- "$@"
  else
    return 1
  fi
}

# Written beside its final name and renamed into place, because the hub reads
# these at any moment and a half-written list is a list with networks missing.
# Created 0640 rather than changed to it afterwards, so the file is never
# briefly readable by the rest of the machine — it names the places this hub
# has been — and nothing is ever changed through a path after it is written.
write_file() {
  # shellcheck disable=SC2016 # expanded by the inner shell, as the hub's account
  printf '%s' "$2" | as_hub sh -c '
    umask 027
    tmp="$1.tmp.$$"
    if cat > "$tmp" && mv -f "$tmp" "$1"; then exit 0; fi
    rm -f "$tmp"
    exit 1
  ' sh "$1" 2>/dev/null
}

# `uuid active` for every Wi-Fi profile NetworkManager holds, one per line.
# UUIDs and types never contain a colon, so `-t` needs no unescaping here.
wifi_profiles() {
  nmcli -t -f UUID,TYPE,ACTIVE connection show 2>/dev/null \
    | awk -F: '$2 == "802-11-wireless" { print $1, ($3 == "yes" ? 1 : 0) }'
}

# The network name a profile joins, exactly. `-e no` because the value is the
# whole of the output: escaping exists to keep `:`-separated columns apart, and
# with one field there are none, so an SSID with a colon in it comes back as it is.
profile_ssid() {
  nmcli -e no -g 802-11-wireless.ssid connection show uuid "$1" 2>/dev/null | head -n1
}

# ── The list ───────────────────────────────────────────────────────────────
# One `network=` line per Wi-Fi profile: its UUID, whether the hub is connected
# through it now, and the name as hex. The hub reads nothing else of
# NetworkManager's, and never the passwords.
write_list() {
  local content uuid active ssid count=0
  if ! command -v nmcli >/dev/null 2>&1; then
    as_hub rm -f "$NETWORKS_FILE" 2>/dev/null || true
    return 0
  fi
  content="# Written by gethome-wifi-networks. Do not edit.
# The Wi-Fi networks this hub knows. See deploy/wifi-networks.sh.
updated=$(now)
"
  while read -r uuid active; do
    [[ -n "$uuid" ]] || continue
    ssid="$(profile_ssid "$uuid")"
    # A profile with no SSID is one NetworkManager could not use either.
    [[ -n "$ssid" ]] || continue
    content+="network=${uuid} ${active} $(to_hex "$ssid")
"
    count=$((count + 1))
  done < <(wifi_profiles)
  as_hub mkdir -p "$WIFI_DIR" 2>/dev/null || true
  write_file "$NETWORKS_FILE" "$content" || { say "Could not write ${NETWORKS_FILE}."; return 0; }
  say "This hub knows ${count} Wi-Fi network(s)."
}

if [[ "$MODE" == "list" ]]; then
  write_list
  exit 0
fi

# ── A change ───────────────────────────────────────────────────────────────

RESULT_ID=""
RESULT_ACTION=""
RESULT_SSID=""
RESULT_UUID=""

finish() {
  local state="$1" error="${2:-}" detail="${3:-}" content
  # One line, always: the hub reads `key=value` lines, and nmcli's own words —
  # which are what `detail` usually is — can run to several.
  detail="$(printf '%s' "$detail" | tr '\r\n\t' '   ' | cut -c1-300)"
  content="id=${RESULT_ID}
action=${RESULT_ACTION}
state=${state}
"
  [[ -n "$error" ]] && content+="error=${error}
"
  [[ -n "$detail" ]] && content+="detail=${detail}
"
  [[ -n "$RESULT_SSID" ]] && content+="ssid=$(to_hex "$RESULT_SSID")
"
  [[ -n "$RESULT_UUID" ]] && content+="uuid=${RESULT_UUID}
"
  content+="at=$(now)
"
  # The list first, so that by the time the hub sees the outcome the list it
  # reads beside it already says so.
  write_list
  write_file "$RESULT_FILE" "$content" || say "Could not write ${RESULT_FILE}."
  say "${RESULT_ACTION} ${state}${error:+ (${error})}${detail:+: ${detail}}"
}

field() { printf '%s\n' "$2" | sed -n "s/^$1=//p" | head -n1; }

# The request, written in place by the hub — the shape `radio-mode` and the
# update request use, and for the same reason: one small write is what
# PathModified is guaranteed to notice. A torn read costs a second look.
read_request() {
  local raw id
  raw="$(as_hub cat "$REQUEST" 2>/dev/null)" || return 1
  id="$(field id "$raw")"
  [[ "$id" =~ ^[A-Za-z0-9._-]{8,64}$ ]] || return 1
  printf '%s' "$raw"
}

wifi_device() {
  nmcli -t -f DEVICE,TYPE device 2>/dev/null | awk -F: '$2 == "wifi" { print $1; exit }'
}

apply_add() {
  local ssid="$1" psk="$2" hidden="$3" bytes uuid active count=0 out name device existing
  RESULT_SSID="$ssid"

  bytes="$(printf '%s' "$ssid" | wc -c | tr -d ' ')"
  if [[ -z "$ssid" ]] || (( bytes > 32 )) || [[ "$ssid" == *[[:cntrl:]]* ]]; then
    finish failed invalid "The network name was not one Wi-Fi allows."
    return
  fi
  if ! [[ "$psk" =~ ^[0-9A-Fa-f]{64}$ ]]; then
    finish failed invalid "The network key was not 64 hexadecimal characters."
    return
  fi
  if [[ "$hidden" == "1" ]]; then hidden="yes"; else hidden="no"; fi

  while read -r uuid active; do
    [[ -n "$uuid" ]] || continue
    count=$((count + 1))
    existing="$(profile_ssid "$uuid")"
    if [[ "$existing" == "$ssid" ]]; then
      finish failed exists "This hub already knows a network with that name."
      return
    fi
  done < <(wifi_profiles)
  if (( count >= MAX_NETWORKS )); then
    finish failed limit "This hub already knows ${count} Wi-Fi networks."
    return
  fi

  # Bound to the board's own radio when there is one to name, as GetHome
  # Studio's card binds `wlan0`: every nmcli this runs on accepts that, where
  # leaving it out was not always allowed. A board with no Wi-Fi device still
  # gets the profile, unbound, for the dongle it may be given before the move.
  # The spellings are nmcli's own documented one-liner — `ssid` and `con-name`
  # are what it checks a Wi-Fi profile for — and priority is left at its
  # default on purpose: NetworkManager breaks a tie by the network used most
  # recently, so at home the home network still wins, and somewhere else the
  # only one in range does.
  name="gethome-${RESULT_ID:0:8}"
  device="$(wifi_device)"
  local args=(connection add type wifi)
  if [[ -n "$device" ]]; then args+=(ifname "$device"); fi
  args+=(
    con-name "$name"
    ssid "$ssid"
    connection.autoconnect yes
    802-11-wireless.hidden "$hidden"
    wifi-sec.key-mgmt wpa-psk
    wifi-sec.psk "$psk"
  )
  if ! out="$(nmcli "${args[@]}" 2>&1)"; then
    finish failed nmcli "$out"
    return
  fi
  RESULT_UUID="$(nmcli -t -f UUID,NAME connection show 2>/dev/null \
    | awk -F: -v name="$name" '$2 == name { print $1; exit }')"
  finish applied
}

apply_remove() {
  local target="$1" uuid active found="" was_active=""
  RESULT_UUID="$target"
  if ! [[ "$target" =~ ^[0-9A-Fa-f-]{36}$ ]]; then
    finish failed invalid "That is not a network this hub knows."
    return
  fi
  while read -r uuid active; do
    if [[ "$uuid" == "$target" ]]; then
      found=1
      [[ "$active" == "1" ]] && was_active=1
    fi
  done < <(wifi_profiles)
  if [[ -z "$found" ]]; then
    finish failed not_found "This hub does not know that network any more."
    return
  fi
  RESULT_SSID="$(profile_ssid "$target")"
  # Asked a second way before the one step that cannot be taken back: the
  # profiles NetworkManager has up right now, which reads no yes or no column.
  # A hub off its only network is the outcome that costs a trip to the Pi, so it
  # takes two answers rather than one parse of one table to allow it.
  if [[ -z "$was_active" ]] \
    && nmcli -t -f UUID connection show --active 2>/dev/null | grep -qixF -- "$target"; then
    was_active=1
  fi
  if [[ -n "$was_active" ]]; then
    finish failed connected "The hub is connected through this network right now."
    return
  fi
  local out
  if ! out="$(nmcli connection delete uuid "$target" 2>&1)"; then
    finish failed nmcli "$out"
    return
  fi
  finish applied
}

apply_one() {
  local raw action
  raw="$(read_request)"
  if [[ -z "$raw" ]]; then
    sleep 1
    raw="$(read_request)"
  fi
  # Consumed before any work: this file is what re-arms the path unit, and a
  # run that dies must not leave one to be picked up again for ever. As root
  # only when the account cannot be switched to: `rm` unlinks a name and
  # follows nothing, so that fallback cannot be pointed anywhere.
  as_hub rm -f "$REQUEST" 2>/dev/null || rm -f "$REQUEST"
  [[ -n "$raw" ]] || return 0

  RESULT_ID="$(field id "$raw")"
  action="$(field action "$raw")"
  RESULT_ACTION="$action"
  RESULT_SSID=""
  RESULT_UUID=""

  if ! command -v nmcli >/dev/null 2>&1; then
    finish failed unsupported "This machine does not use NetworkManager."
    return
  fi

  case "$action" in
    add) apply_add "$(field ssid "$raw")" "$(field psk "$raw")" "$(field hidden "$raw")" ;;
    remove) apply_remove "$(field uuid "$raw")" ;;
    *) RESULT_ACTION="unknown"; finish failed invalid "The hub asked for something this script does not do." ;;
  esac
}

# A request written while the last one was being applied does not re-trigger a
# PathModified unit that is still running, so look again before leaving. The
# hub refuses a second change while the first is unconsumed, which keeps this to
# one pass in practice; the bound is for a hub that somehow does not.
for _ in 1 2 3 4 5; do
  [[ -e "$REQUEST" ]] || break
  apply_one
done

# Always zero, for the reason update-runner.sh gives: a refused change is not a
# failed unit, and enough failed starts park the service until somebody runs
# `reset-failed` on a machine nobody is sitting at. The outcome is in the result
# file, which is what the hub reads.
exit 0
