#!/usr/bin/env bash
# GetHome Hub — a broker account for each device, applied from the hub's list.
#
#   mqtt-accounts.sh              rebuild the broker's files from the list, have
#                                 the broker read them again, and say how it went
#   mqtt-accounts.sh --no-reload  the same without the reload — for install.sh,
#                                 which restarts the broker itself a line later
#
# Installed as /usr/local/lib/gethome-mqtt-accounts.sh. The first form is started
# by gethome-mqtt-accounts.path when the hub writes <DATA_DIR>/mqtt-accounts/request.
#
# ── Why this exists ────────────────────────────────────────────────────────
# Every board somebody set up used to be handed the same broker account, which
# may write anywhere under gethome/. So any of them could publish another
# device's state, discovery document or commands, and a board that was switched
# off while it was deleted came straight back when it was switched on, because
# its password still worked.
#
# Now each device has its own account: its id is its username, one static line
# in the ACL confines every such account to its own topics (`pattern … %u`),
# and deleting the device takes the account away. The hub keeps the list — a
# name and the broker's own hash of a password per device, never a password —
# and this script makes mosquitto's two files say the same.
#
# Those files are root's and the broker's, and the hub runs as an account whose
# point is that it cannot touch them. So the trade the radio switch, the update
# and the Wi-Fi networks make: the hub writes into a directory it already owns,
# a .path unit notices, and this script — root, started by systemd, reachable
# from nothing else — does the work. No sudo rule, nothing new to lock down.
#
# ── The whole list, every time ─────────────────────────────────────────────
# Not "add this one" or "remove that one": the password file is rebuilt as the
# broker's own two accounts plus every account on the list, and the ACL as the
# part install.sh wrote plus a section for each device that named a project.
# That makes a run repeatable and a missed one harmless — the next brings
# everything into line — and it is what lets install.sh, which writes the
# password file afresh on every update, put the devices back by running this.
#
# ── Never lock the hub out of its own broker ───────────────────────────────
# A broker that reads a password file without the hub's own account in it, or
# an ACL it cannot parse, is a hub with no Zigbee and no MQTT at all. So:
#
# * The broker's own two lines are copied from the file as it stands, untouched,
#   and nothing is written unless the hub's own is among them.
# * A device may not be called what either of them is called.
# * Every line of the list is checked before it is used — a name of letters,
#   digits, `_` and `-`, a hash of exactly the shape mosquitto writes — and one
#   that is not is left out, never passed through. The list is the hub user's
#   file and this is root: nothing from it reaches a file the broker parses
#   except as one of those two shapes.
# * Both files are written beside their final names, given the broker's group
#   and mode first, and renamed into place — the broker opens them after it has
#   dropped privileges, so a file it cannot read is a broker that will not
#   start, and a half-written one is accounts that vanished.
# * Only `user` and `topic readwrite` lines are ever added to the ACL, the
#   words the installer's own part uses.
#
# ── The directory is the hub user's, so it is read and written as that user ─
# (`as_hub`, the rule deploy/wifi-networks.sh states at length.) Root following
# a name in a directory somebody else controls follows whatever they put there.
# Only the two files under /etc/mosquitto and the reload are root's.
set -uo pipefail

CONF_DIR="${GETHOME_CONF:-/etc/gethome}"
HUB_ENV="$CONF_DIR/hub.env"
MQTT_ENV="$CONF_DIR/mqtt.env"
HUB_USER="${GETHOME_USER:-${GETHOME_GROUP:-gethome}}"
PASSWD_FILE="${GETHOME_MQTT_PASSWD:-/etc/mosquitto/gethome.passwd}"
ACL_FILE="${GETHOME_MQTT_ACL:-/etc/mosquitto/gethome.acl}"
BROKER_GROUP="${GETHOME_MQTT_GROUP:-mosquitto}"
# The hub refuses the same number (MAX_MQTT_DEVICE_ACCOUNTS).
MAX_ACCOUNTS=250
# Where install.sh's part of the ACL ends and this script's begins. Plain ASCII
# and matched whole, so it can only ever be the line install.sh wrote.
ACL_MARKER='# gethome:device-accounts'

read_env() { sed -n "s/^$1=//p" "$2" 2>/dev/null | tail -n1; }

DATA_DIR=$(read_env DATA_DIR "$HUB_ENV")
[[ -n "$DATA_DIR" ]] || DATA_DIR=/var/lib/gethome/data

# The broker's own two accounts, by the names install.sh gave them.
HUB_ACCOUNT=$(read_env MQTT_USERNAME "$MQTT_ENV")
[[ -n "$HUB_ACCOUNT" ]] || HUB_ACCOUNT=gethome-hub
APP_ACCOUNT=$(read_env MQTT_INTEGRATION_USERNAME "$MQTT_ENV")
[[ -n "$APP_ACCOUNT" ]] || APP_ACCOUNT=gethome

ACCOUNTS_DIR="$DATA_DIR/mqtt-accounts"
LIST_FILE="$ACCOUNTS_DIR/accounts"
REQUEST_FILE="$ACCOUNTS_DIR/request"
RESULT_FILE="$ACCOUNTS_DIR/result"

RELOAD=1
QUIET=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-reload) RELOAD=""; shift ;;
    --quiet) QUIET=1; shift ;;
    *) shift ;;
  esac
done

say() { [[ -n "$QUIET" ]] || printf '%s\n' "$*"; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Run a command as the hub's account. setpriv first, because it is a plain
# setresuid with no PAM session; runuser where it is missing. Both are
# util-linux, which Debian marks essential. Not running as root — the suite, or
# anybody running this by hand — there is nothing to drop.
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

# A file of the hub's, read as the hub's account: its contents when it is a
# regular file, nothing otherwise. Bounded, because root is about to hold it in
# a variable — 250 accounts are well under a tenth of this.
read_hub_file() {
  as_hub test -f "$1" 2>/dev/null || return 1
  as_hub head -c 524288 "$1" 2>/dev/null
}

# Written beside its final name and renamed into place, as the hub's account,
# so the hub never reads half an answer and nothing is changed through a path.
write_result() {
  # shellcheck disable=SC2016 # expanded by the inner shell, as the hub's account
  printf '%s' "$1" | as_hub sh -c '
    umask 077
    tmp="$1.tmp.$$"
    if cat > "$tmp" && mv -f "$tmp" "$1"; then exit 0; fi
    rm -f "$tmp"
    exit 1
  ' sh "$RESULT_FILE" 2>/dev/null
}

# The revision the hub stamped the list with: its first line, and a UUID.
list_revision() {
  printf '%s\n' "$1" | awk '
    NR == 1 {
      if (substr($0, 1, 9) == "revision=") {
        value = substr($0, 10)
        if (length(value) == 36 && value ~ "^[0-9a-f-]+$") print value
      }
      exit
    }'
}

# One "id key hash" line for every account on the list that is worth applying.
#
# No interval expressions: Raspberry Pi OS's awk is mawk, which has none, so a
# length is checked with length() and a shape with a plain character class.
# Regexes are strings, so a `/` in one needs no escaping in any awk.
valid_accounts() {
  printf '%s\n' "$1" | awk -v hub="$HUB_ACCOUNT" -v app="$APP_ACCOUNT" -v max="$MAX_ACCOUNTS" '
    function safe(word) {
      return length(word) >= 1 && length(word) <= 64 && word ~ "^[A-Za-z0-9_-]+$"
    }
    substr($0, 1, 8) == "account=" {
      if (split(substr($0, 9), part, " ") != 3) next
      id = part[1]; key = part[2]; hash = part[3]
      if (!safe(id) || id == hub || id == app || (id in seen)) next
      if (key != "-" && !safe(key)) next
      # $7$<rounds>$<salt>$<hash> — PBKDF2-SHA512 as mosquitto_passwd writes
      # it: a 12-byte salt and a 64-byte hash, both base64.
      if (split(hash, piece, "[$]") != 5 || piece[1] != "" || piece[2] != "7") next
      if (piece[3] !~ "^[0-9]+$" || length(piece[3]) > 6 || piece[3] + 0 < 1) next
      if (length(piece[4]) != 16 || piece[4] !~ "^[A-Za-z0-9+/]+$") next
      if (length(piece[5]) != 88 || piece[5] !~ "^[A-Za-z0-9+/]+==$") next
      if (count >= max) next
      seen[id] = 1
      count++
      print id, key, hash
    }'
}

# A file under /etc/mosquitto, replaced whole: written beside its name, handed
# to the broker's group and narrowed *before* it takes the name, so the broker
# never finds one it cannot read and nobody else ever finds one they can.
replace_broker_file() {
  local target="$1" content="$2" tmp
  tmp="$(mktemp "$target.XXXXXX" 2>/dev/null)" || return 1
  if ! printf '%s\n' "$content" > "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  if [[ "$(id -u)" == "0" ]] && ! chown "root:$BROKER_GROUP" "$tmp" 2>/dev/null; then
    rm -f "$tmp"
    return 1
  fi
  if ! chmod 0640 "$tmp" 2>/dev/null || ! mv -f "$tmp" "$target" 2>/dev/null; then
    rm -f "$tmp"
    return 1
  fi
  return 0
}

# Have the broker read both files again. mosquitto re-checks every connected
# client against the new password file as it does, and drops the ones that no
# longer sign in — which is what ends a deleted device's connection.
reload_broker() {
  if [[ -n "${GETHOME_MQTT_BROKER_PID:-}" ]]; then
    kill -HUP "$GETHOME_MQTT_BROKER_PID" 2>/dev/null
    return
  fi
  if command -v systemctl >/dev/null 2>&1; then
    systemctl reload mosquitto.service >/dev/null 2>&1 && return 0
    systemctl kill -s HUP mosquitto.service >/dev/null 2>&1 && return 0
  fi
  command -v pkill >/dev/null 2>&1 && pkill -HUP -x mosquitto >/dev/null 2>&1
}

STATE=""
ERROR=""
DETAIL=""
REVISION=""
APPLIED=0

fail_with() {
  STATE="failed"
  ERROR="$1"
  DETAIL="$2"
  say "Not applied: $2"
}

apply_list() {
  local list accounts base acl_head new_passwd new_acl old_passwd old_acl changed=""
  STATE=""
  ERROR=""
  DETAIL=""
  APPLIED=0

  # No list at all is a hub that has never given a device an account: the
  # broker's files are then exactly what install.sh wrote, and stay so.
  #
  # A list that is there and cannot be read is a different thing, and the one
  # mistake this must not make: read as "no accounts", it would take every
  # device's account away. So unless the list is plainly absent, it has to
  # read and it has to open with the hub's revision line, or nothing is touched.
  list=""
  REVISION=""
  if ! as_hub true 2>/dev/null; then
    fail_with unreadable "The hub's own account could not be used to read its list of device accounts."
    return
  fi
  if as_hub test -e "$LIST_FILE" 2>/dev/null || as_hub test -L "$LIST_FILE" 2>/dev/null; then
    if ! list="$(read_hub_file "$LIST_FILE")"; then
      fail_with unreadable "The hub's list of device accounts could not be read."
      return
    fi
    REVISION="$(list_revision "$list")"
    if [[ -z "$REVISION" ]]; then
      fail_with unreadable "The hub's list of device accounts is not in a form this script reads."
      return
    fi
  fi
  accounts="$(valid_accounts "$list")"

  if [[ ! -r "$PASSWD_FILE" ]]; then
    fail_with unreadable "The broker's password file is not there to add to."
    return
  fi
  base="$(awk -F: -v hub="$HUB_ACCOUNT" -v app="$APP_ACCOUNT" '$1 == hub || $1 == app' "$PASSWD_FILE" 2>/dev/null)"
  if ! printf '%s\n' "$base" | awk -F: -v hub="$HUB_ACCOUNT" '$1 == hub { found = 1 } END { exit found ? 0 : 1 }'; then
    fail_with no-hub-account "The broker's password file does not hold the hub's own account, so it was left alone."
    return
  fi
  # Everything install.sh wrote, down to the line that says where this
  # script's part begins. An ACL without that line is one this was not made
  # for, and is left alone.
  if ! acl_head="$(awk -v marker="$ACL_MARKER" '
      { print }
      $0 == marker { found = 1; exit }
      END { exit found ? 0 : 3 }' "$ACL_FILE" 2>/dev/null)"; then
    fail_with no-acl "The broker's ACL was not written by an installer that knows about device accounts."
    return
  fi

  new_passwd="$base"
  new_acl="$acl_head"
  if [[ -n "$accounts" ]]; then
    APPLIED="$(printf '%s\n' "$accounts" | awk 'END { print NR }')"
    new_passwd="$base
$(printf '%s\n' "$accounts" | awk '{ print $1 ":" $3 }')"
    new_acl="$acl_head
$(printf '%s\n' "$accounts" | awk '$2 != "-" { print ""; print "user " $1; print "topic readwrite gethome/project/" $2 "/#" }')"
  fi

  old_passwd="$(cat "$PASSWD_FILE" 2>/dev/null)"
  old_acl="$(cat "$ACL_FILE" 2>/dev/null)"
  # The ACL first: a project line for an account that is not in the password
  # file yet opens nothing, while the other order would leave a moment with a
  # new account and no line for its project.
  if [[ "$new_acl" != "$old_acl" ]]; then
    if ! replace_broker_file "$ACL_FILE" "$new_acl"; then
      fail_with write "The broker's ACL could not be rewritten."
      return
    fi
    changed=1
  fi
  if [[ "$new_passwd" != "$old_passwd" ]]; then
    if ! replace_broker_file "$PASSWD_FILE" "$new_passwd"; then
      fail_with write "The broker's password file could not be rewritten."
      return
    fi
    changed=1
  fi

  STATE="applied"
  # Nothing changed, nothing to re-read: a run that finds the files already
  # right does not have the broker re-check every client for no reason.
  if [[ -n "$changed" && -n "$RELOAD" ]]; then
    sync 2>/dev/null || true
    reload_broker || DETAIL="The broker was not running to be told; it reads the new files when it starts."
  fi
  say "Applied: $APPLIED device account(s)."
}

result_text() {
  printf 'id=%s\nstate=%s\n' "$REVISION" "$STATE"
  [[ -z "$ERROR" ]] || printf 'error=%s\n' "$ERROR"
  [[ -z "$DETAIL" ]] || printf 'detail=%s\n' "$DETAIL"
  printf 'accounts=%s\nat=%s\n' "$APPLIED" "$(now)"
}

# The path unit does not fire again while this is running, so a list written
# meanwhile would wait for the next change. Look once more before leaving: if
# the hub has asked for a revision other than the one just applied, go round
# again. Three times at most — a hub writing faster than that is asking again
# anyway, and each request starts a run of its own once this one has ended.
for _ in 1 2 3; do
  apply_list
  write_result "$(result_text)" || true
  wanted="$(read_hub_file "$REQUEST_FILE" | sed -n 's/^id=//p' | head -n1)" || wanted=""
  [[ -n "$wanted" && "$wanted" != "$REVISION" ]] || break
done

# Always 0: a list that could not be applied is not a failed unit, and enough
# failed starts park the service until somebody runs `reset-failed` on a
# machine nobody is sitting at. The hub reads what happened from the result.
exit 0
