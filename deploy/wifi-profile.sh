#!/usr/bin/env bash
# GetHome Hub — keep a copy of the hub's own Wi-Fi profile, and put it back if
# NetworkManager has lost it.
#
#   wifi-profile.sh backup  [--conf /etc/gethome] [--quiet]
#   wifi-profile.sh restore [--conf /etc/gethome]
#
# `backup` runs at install time and from a NetworkManager dispatcher every time
# a connection comes up. `restore` runs once at boot, as a root oneshot ordered
# after NetworkManager (gethome-wifi-restore.service).
#
# ── Why ─────────────────────────────────────────────────────────────────────
#
# On 2026-10-12 a hub was unplugged within a minute of being switched on, and
# never came back on the network. Everything on it was healthy — the hub
# listening, Zigbee2MQTT up with its devices — but NetworkManager had been
# saving its Wi-Fi profile when the power went, the file was left at 0 bytes,
# and from then on every boot came up with no Wi-Fi profile at all: wlan0
# "disconnected" for ever, no address, no mDNS, no SSH. A hub has no screen and
# no keyboard, so the only way back was taking the SD card to another computer.
#
# The file was a netplan YAML, because Raspberry Pi OS Trixie's NetworkManager
# keeps its profiles in /etc/netplan. That writer opens the file with
# `fopen(…, "wb")` — truncate, then write — with no temporary file, no rename
# and no fsync, so a power cut between the two leaves a profile with nothing in
# it. An empty YAML is not an error to netplan: it simply defines nothing, so
# the profile disappears without a word. NetworkManager's own keyfile writer
# (the other storage, and Bookworm's) writes a temporary file, fsyncs it and
# renames it, which is the discipline this script uses for its own copy.
#
# So the hub keeps the last profile it actually connected with, root-only,
# under /etc/gethome — written atomically and fsynced, and only when it changed,
# so the copy is never the thing a power cut empties — and at boot it checks
# whether NetworkManager still has any Wi-Fi profile. Only when it has none at
# all, and the hub is not on the network some other way, does it put the copy
# back. It never edits or replaces a profile that exists, so a network or a
# password the owner has changed is theirs; the next time that profile connects
# it becomes the copy.
#
# ── What it copies ──────────────────────────────────────────────────────────
#
# The profile NetworkManager itself is using, asked of NetworkManager: the
# active wireless connection (the dispatcher's own, when a dispatcher runs
# this) and the file NetworkManager says it was loaded from. That is never a
# fixed path, because the same profile on the same hub has lived in two places:
# as netplan YAML rendered to /run/NetworkManager/system-connections/netplan-*
# and, after a hand repair, as a keyfile in /etc/NetworkManager/system-
# connections. Either way the file is a NetworkManager keyfile, so the copy
# carries everything the profile had — an open network, a 5 GHz one, a hidden
# one, a static address — rather than the SSID and password alone, which is
# also why it is not wifi.env (that file means "what to hand a Matter
# accessory", and deliberately holds nothing for an open or a 5 GHz-only
# network).
#
# One thing is added: a netplan rendering of a profile cloud-init created has no
# `uuid=` line, and NetworkManager derives the UUID from the file's path. Put
# back under another name it would come back as a different connection, so the
# copy is given the UUID NetworkManager reports.
#
# The restored profile is a keyfile in /etc/NetworkManager/system-connections,
# which NetworkManager reads with or without netplan — including when a damaged
# file in /etc/netplan makes `netplan generate` refuse the whole directory.
# /etc/netplan itself is left alone: a damaged file there is named in the log
# and not touched, because those files are the distribution's.
set -uo pipefail

MODE="${1:-}"
[[ $# -gt 0 ]] && shift
CONF_DIR="${GETHOME_CONF:-/etc/gethome}"
QUIET=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --conf) CONF_DIR="$2"; shift 2 ;;
    --quiet) QUIET=1; shift ;;
    *) shift ;;
  esac
done

# Overridable for the same reason `GETHOME_NET_DIR` is in install.sh: so the
# suite can run this against directories it owns.
NM_DIR="${GETHOME_NM_CONNECTIONS:-/etc/NetworkManager/system-connections}"
NETPLAN_DIR="${GETHOME_NETPLAN_DIR:-/etc/netplan}"
NM_WAIT="${GETHOME_NM_WAIT:-60}"

BACKUP="$CONF_DIR/wifi-profile.nmconnection"
RESTORED="$NM_DIR/gethome-restored-wifi.nmconnection"
WIRELESS="802-11-wireless"

say() { [[ -n "$QUIET" ]] || printf '%s\n' "$*"; }

# fsync, so a power cut after this returns cannot undo it. GNU `sync FILE`
# fsyncs that file (and a directory, which is what makes a rename durable);
# where `sync` takes no operands it syncs everything, which is only slower.
flush() { sync "$@" 2>/dev/null || sync; }

# Write stdin to $1 the way nothing can leave half-written: a temporary file in
# the same directory, root-only before it has any content, fsynced, renamed
# over the old one, and the directory fsynced so the rename itself survives.
# The temporary name begins with a dot, which NetworkManager never loads.
write_atomically() {
  local target="$1" dir tmp
  dir="$(dirname "$target")"
  mkdir -p "$dir" 2>/dev/null || true
  tmp="$(umask 077 && mktemp "$dir/.gethome-wifi-profile.XXXXXX" 2>/dev/null)" || return 1
  if ! cat > "$tmp" 2>/dev/null; then rm -f "$tmp"; return 1; fi
  chmod 0600 "$tmp" 2>/dev/null || true
  chown root:root "$tmp" 2>/dev/null || true
  flush "$tmp"
  if ! mv -f "$tmp" "$target" 2>/dev/null; then rm -f "$tmp"; return 1; fi
  flush "$dir"
}

# What a keyfile is, read the way NetworkManager reads one. Prints
# `ok<TAB><has-uuid|no-uuid><TAB><id>` for a Wi-Fi profile this hub can join a
# network with, or one word saying why not: `not-wifi`, `no-ssid`, `not-client`
# (a hotspot or ad-hoc network the hub runs itself, which would not put it back
# on anybody's LAN) or `other-uuid` (the file is not the connection it was
# named for). Both section names count, since keyfiles written before
# NetworkManager 1.0 say `802-11-wireless` where newer ones say `wifi`.
describe_profile() {
  local file="$1" uuid="${2:-}"
  WANT="$uuid" awk '
    function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t\r]+$/, "", s); return s }
    /^[ \t]*[#;]/ { next }
    /^[ \t]*\[/ { section = trim($0); sub(/^\[/, "", section); sub(/\].*$/, "", section); next }
    {
      i = index($0, "=")
      if (i == 0) next
      key = trim(substr($0, 1, i - 1)); value = trim(substr($0, i + 1))
      if (section == "connection") {
        if (key == "type") type = value
        else if (key == "uuid") uuid = value
        else if (key == "id") id = value
      } else if (section == "wifi" || section == "802-11-wireless") {
        if (key == "ssid" && value != "") ssid = 1
        else if (key == "mode") mode = value
      }
    }
    END {
      if (type != "wifi" && type != "802-11-wireless") { print "not-wifi"; exit }
      if (!ssid) { print "no-ssid"; exit }
      if (mode != "" && mode != "infrastructure") { print "not-client"; exit }
      if (uuid != "" && ENVIRON["WANT"] != "" && uuid != ENVIRON["WANT"]) { print "other-uuid"; exit }
      printf "ok\t%s\t%s\n", (uuid == "" ? "no-uuid" : "has-uuid"), id
    }' "$file" 2>/dev/null
}

# ── backup ──────────────────────────────────────────────────────────────────
backup() {
  local listing candidates uuid file size verdict state id add body chosen="" refused=""

  command -v nmcli >/dev/null 2>&1 || {
    say "No NetworkManager here, so there is no Wi-Fi profile to keep."
    return 0
  }

  # The active wireless connections, and the file NetworkManager loaded each
  # from. `CONNECTION_UUID` is set when a dispatcher runs this and names the
  # connection that just came up — which may be Ethernet, and then there is
  # nothing to keep. `nmcli -t` escapes `\` and `:` inside a value, so the file
  # name is decoded; the type and the UUID can contain neither.
  if ! listing="$(nmcli -t -f TYPE,UUID,FILENAME connection show --active 2>/dev/null)"; then
    say "NetworkManager did not answer, so the copy of this hub's Wi-Fi profile was left as it was."
    return 0
  fi
  candidates="$(printf '%s\n' "$listing" | WANT="${CONNECTION_UUID:-}" TYPE="$WIRELESS" awk '
    function unescape(s,    out, i, c) {
      out = ""
      for (i = 1; i <= length(s); i++) {
        c = substr(s, i, 1)
        if (c == "\\" && i < length(s)) { i++; c = substr(s, i, 1) }
        out = out c
      }
      return out
    }
    {
      i = index($0, ":"); if (i == 0) next
      type = substr($0, 1, i - 1); rest = substr($0, i + 1)
      j = index(rest, ":"); if (j == 0) next
      uuid = substr(rest, 1, j - 1)
      if (type != ENVIRON["TYPE"]) next
      if (ENVIRON["WANT"] != "" && uuid != ENVIRON["WANT"]) next
      printf "%s\t%s\n", uuid, unescape(substr(rest, j + 1))
    }')"
  if [[ -z "$candidates" ]]; then
    say "This hub is not on Wi-Fi, so there is no Wi-Fi profile to keep."
    return 0
  fi

  # The first one that could put this hub back on a network. A profile that
  # lives only in memory has no file, a file far larger than a keyfile is not
  # one, and a hotspot this machine runs would not reconnect it to anybody's
  # LAN — and none of them may replace a good copy.
  while IFS=$'\t' read -r uuid file; do
    [[ -n "$uuid" ]] || continue
    if [[ -z "$file" || ! -r "$file" ]]; then refused="no file NetworkManager could name"; continue; fi
    size="$(wc -c < "$file" 2>/dev/null || echo 0)"
    if (( size == 0 || size > 65536 )); then refused="${file} could not be read"; continue; fi
    verdict="$(describe_profile "$file" "$uuid")"
    case "$verdict" in
      ok*) chosen="$file"; break ;;
      not-client) refused="it is a hotspot this machine runs, not a network it joins" ;;
      *) refused="${file} is not one the hub could reconnect with (${verdict:-unreadable})" ;;
    esac
  done <<< "$candidates"
  if [[ -z "$chosen" ]]; then
    say "The copy of this hub's Wi-Fi profile was left as it was: ${refused}."
    return 0
  fi
  file="$chosen"
  IFS=$'\t' read -r _ state id <<< "$verdict"

  # The body, with the UUID NetworkManager reports written into a profile that
  # carried none. Built into a variable first so the comparison below sees
  # exactly what would be written.
  add=""
  [[ "$state" == "no-uuid" ]] && add=1
  body="$(UUID="$uuid" ADD="$add" awk '
    { print }
    ENVIRON["ADD"] != "" && !done && /^[ \t]*\[connection\][ \t]*$/ { print "uuid=" ENVIRON["UUID"]; done = 1 }
  ' "$file")"

  # Only when it changed. The dispatcher runs on every association, and a
  # rewrite each time would be a card write for nothing and, worse, a window.
  if [[ -f "$BACKUP" ]] && [[ "$(cat "$BACKUP" 2>/dev/null)" == "$body" ]]; then
    say "The hub's copy of its Wi-Fi profile (${id}) is up to date."
    return 0
  fi
  if ! printf '%s\n' "$body" | write_atomically "$BACKUP"; then
    say "Could not write ${BACKUP}, so this hub's Wi-Fi profile has no copy to come back from."
    return 0
  fi
  say "The hub keeps a copy of its Wi-Fi profile (${id}), and puts it back by itself if a power cut ever leaves NetworkManager without one."
}

# ── restore ─────────────────────────────────────────────────────────────────

# The type of every profile NetworkManager has, one per line. Fails when
# NetworkManager does not answer — which must never read as "no profiles".
profile_types() { nmcli -t -f TYPE connection show 2>/dev/null; }

has_wifi_profile() { printf '%s\n' "$1" | grep -qx "$WIRELESS"; }

# Files in /etc/netplan that a power cut has emptied or filled with zeros. An
# empty one defines nothing; one with a NUL in it makes `netplan generate`
# refuse every file in the directory.
damaged_netplan() {
  local f size kept out=""
  for f in "$NETPLAN_DIR"/*.yaml; do
    [[ -f "$f" ]] || continue
    size="$(wc -c < "$f" 2>/dev/null || echo 0)"
    if (( size == 0 )); then
      out="${out:+$out, }${f} (empty)"
      continue
    fi
    kept="$(tr -d '\000' < "$f" 2>/dev/null | wc -c)"
    if (( kept != size )); then out="${out:+$out, }${f} (zeros where the data should be)"; fi
  done
  printf '%s' "$out"
}

restore() {
  local verdict id types devices route damaged result

  if [[ ! -s "$BACKUP" ]]; then
    say "There is no copy of a Wi-Fi profile on this hub, so there is nothing to put back."
    return 0
  fi
  command -v nmcli >/dev/null 2>&1 || {
    say "NetworkManager is not installed, so the copy of the Wi-Fi profile was not put back."
    return 0
  }
  verdict="$(describe_profile "$BACKUP")"
  case "$verdict" in
    ok*) ;;
    *) say "The copy of the Wi-Fi profile in ${BACKUP} is not one the hub could reconnect with (${verdict:-unreadable}), so nothing was put back."; return 0 ;;
  esac
  IFS=$'\t' read -r _ _ id <<< "$verdict"

  # The ordinary boot answers at once: there is a Wi-Fi profile and nothing to
  # do. Only when there is none is it worth waiting for NetworkManager to
  # finish starting — every profile loaded, every device that is going to come
  # up having come up — before deciding the hub is stranded, so a slow start or
  # an Ethernet link still getting its address is not mistaken for one.
  if types="$(profile_types)" && has_wifi_profile "$types"; then
    say "NetworkManager has a Wi-Fi profile, so there is nothing to put back."
    return 0
  fi
  if command -v nm-online >/dev/null 2>&1; then
    nm-online -s -q -t "$NM_WAIT" >/dev/null 2>&1 || true
  fi
  if ! types="$(profile_types)"; then
    say "NetworkManager did not answer, so the copy of the Wi-Fi profile (${id}) was not put back."
    return 0
  fi
  if has_wifi_profile "$types"; then
    say "NetworkManager has a Wi-Fi profile, so there is nothing to put back."
    return 0
  fi

  # A machine whose radio is gone (switched off in config.txt, a different
  # board) has nothing to put a profile on.
  devices="$(nmcli -t -f TYPE,STATE device 2>/dev/null || true)"
  if ! printf '%s\n' "$devices" | grep -q '^wifi:'; then
    say "NetworkManager has no Wi-Fi profile, but this machine has no Wi-Fi radio for one either, so the copy (${id}) was not put back."
    return 0
  fi
  # And a hub that is on the network some other way is not stranded: somebody
  # who moved it to Ethernet and deleted its Wi-Fi meant both.
  route="$(ip -4 route show default 2>/dev/null || true)"
  if [[ -n "$route" ]] || printf '%s\n' "$devices" | grep -Eq '^ethernet:connect(ed|ing)'; then
    say "NetworkManager has no Wi-Fi profile, but this hub is on the network another way, so the copy (${id}) was not put back."
    return 0
  fi

  damaged="$(damaged_netplan)"

  # The name is ours, so whatever is there already is ours too — an earlier
  # restore that something has since emptied, since NetworkManager has no Wi-Fi
  # profile loaded from it. The note goes on once: after a restore the next copy
  # is taken from this very file, note and all.
  if ! {
    if ! head -n 1 "$BACKUP" | grep -q '^# Put back by GetHome'; then
      printf '# Put back by GetHome at boot: NetworkManager had no Wi-Fi profile left, and\n'
      printf '# this is the one the hub last connected with. deploy/wifi-profile.sh says why.\n'
    fi
    cat "$BACKUP"
  } | write_atomically "$RESTORED"; then
    say "NetworkManager has no Wi-Fi profile, and the copy (${id}) could not be written to ${RESTORED}."
    return 0
  fi
  if ! result="$(nmcli connection load "$RESTORED" 2>&1)"; then
    say "NetworkManager has no Wi-Fi profile, and would not load the copy put back at ${RESTORED}: ${result:-no reason given}"
    return 0
  fi
  if ! types="$(profile_types)" || ! has_wifi_profile "$types"; then
    say "NetworkManager has no Wi-Fi profile. The copy (${id}) was put back at ${RESTORED}, but NetworkManager still lists none."
    return 0
  fi
  say "NetworkManager had no Wi-Fi profile, so the hub put back the one it last connected with (${id}) at ${RESTORED}."
  if [[ -n "$damaged" ]]; then
    say "Left as they are in ${NETPLAN_DIR}: ${damaged}. A power cut while NetworkManager was saving is the usual cause."
  fi
}

case "$MODE" in
  backup) backup ;;
  restore) restore ;;
  *)
    echo "usage: $(basename "$0") backup|restore [--conf DIR] [--quiet]" >&2
    exit 2
    ;;
esac
exit 0
