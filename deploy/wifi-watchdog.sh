#!/usr/bin/env bash
# GetHome Hub — put the hub back on the network when it is connected to Wi-Fi
# and nothing on the network answers it any more.
#
#   wifi-watchdog.sh [IFACE]
#
# Run as root by the Wi-Fi keep-alive (`keep_wifi_reachable` in install.sh) at
# the end of each of its 20-second rounds: with the interface carrying the
# default route, or with none when there is no default route. On a hub whose
# network works it reads one table and exits.
#
# ── Why ─────────────────────────────────────────────────────────────────────
#
# On 2026-10-15 a Zero 2 W (brcmfmac, BCM43430/1 firmware 7.45.96.s1,
# Raspberry Pi OS Trixie, NetworkManager 1.52.1) stopped passing any traffic
# over its Wi-Fi at about 00:28 and stayed that way for fifty minutes, until its
# owner switched it off and on. The machine itself was fine throughout — cron
# and logrotate ran, timesyncd asked a server and timed out — and as far as it
# could tell it was connected: NetworkManager's last line was an ordinary DHCP
# renewal at 00:28:38, and neither it, wpa_supplicant nor the kernel logged
# anything after that. From a Mac on the same network nothing answered — no
# ping, no SSH, nothing on 8420, no mDNS, one ping reply in fifty minutes —
# while the Mac's ARP entry for the hub went on being refreshed. The radio's
# firmware answers ARP for the hub by itself (`arpoe`, deploy/CLAUDE.md), so
# the firmware was associated and alive while nothing reached Linux or left it.
#
# **What broke is not known.** The power cycle that ended it reset every
# counter that could have said which side stopped, and nothing wrote them down
# while it lasted. So this does two things. It writes them down — what Linux
# counted, what the radio's firmware counted, the driver's bus counters, the
# transmit queue and the neighbour table — two minutes in, before each step and
# when an answer comes back, so the next time says which side it was. And it
# takes the two steps that cover what it could have been, cheapest first:
# **reloading the radio's driver**, which restarts the firmware and the bus to
# it and joins the network afresh, and then **restarting the machine**, which
# is the nearest thing to what ended it. Whether the first cures the fault that
# was seen is unmeasured — it has happened once — and the line logged when an
# answer comes back names the last step taken, which is what will say.
#
# ── How it decides ──────────────────────────────────────────────────────────
#
# **An answer is a neighbour in REACHABLE.** The kernel puts a neighbour there
# only when one of its own unicast questions was answered or a connection to it
# made progress, and the keep-alive asks every neighbour whose entry has gone
# stale every round — so on a working network something is always REACHABLE.
# Measured on the hub this came from, sampled every 5 s for almost three hours
# of a night: never more than 10 s without one, and never more than 30 s
# without the gateway. The
# firmware cannot stand in for the answer: it answers ARP *for* the hub, never
# the hub's own questions — measured there too, a probe at a link address
# nobody has went from PROBE to FAILED in three seconds, IPv4 and IPv6 alike.
#
# **Five minutes without one is the trigger**, thirty times the longest gap a
# working network showed, and four rules keep it from acting on a hub that is
# fine.
#   - **Only after an answer since the machine started** (the state is in /run).
#     A hub that boots onto a network that never answers is not one whose Wi-Fi
#     stopped, and restarting its radio would not change that — which is also
#     what keeps a restart from turning into a loop.
#   - **Only while NetworkManager says the device is connected.** When the link
#     has really gone, NetworkManager is already reconnecting — which is also
#     why a router that is switched off or restarting never sets this off: its
#     access point goes, the link times out in 15 s, NetworkManager says so.
#   - **Ask again before each step.** Every neighbour the keep-alive remembers,
#     at the link address it had, by unicast, and three seconds for the answers
#     — so a keep-alive that was starved of CPU and is only now asking again
#     does not read its own silence as the network's.
#   - **Bounded.** Reload the driver — brcmfmac only, the one driver this was
#     tried on; five minutes later, if still nothing, restart the machine, but
#     never one that has been up for less than an hour, so it happens at most
#     once an hour. A radio with another driver goes straight to the restart.
#
# **Not a re-join.** Re-joining the network (`nmcli connection up` on the
# connection already up) is cheaper — 2.5 s on that board — but an activation
# needs the very path that has stopped: the 4-way handshake runs in
# wpa_supplicant (this firmware has no supplicant of its own; FWSUP is not
# among its features) and DHCP after it, and both are frames between Linux and
# the radio. So in the failure this is for, an activation cannot finish and
# leaves NetworkManager not connected — where the rule above would stop every
# later step. That much is reasoned, not measured: the fault has not been seen
# again. So after the reload the restart does not wait for NetworkManager's
# word, and is reached from the keep-alive's rounds with no default route as
# well, which is why it can be called with no interface.
#
# **What the reload costs, measured on that Zero 2 W.** wlan0 was gone for
# under a second and NetworkManager connected 3.5 s after the reload began; a
# Mac pinging every 0.2 s lost 2.8 s of replies. Bluetooth, the same chip over
# another bus, stayed up, IPv6 stayed on, and power save came back off through
# its dispatcher. **One thing does not survive it: matter.js joins its mDNS
# groups once, when it starts**, on the interfaces there are then — after the
# reload only avahi was a member on the new wlan0 (`/proc/net/igmp` and
# `igmp6`: one user where there had been two), so the hub kept its Matter
# sessions and could no longer hear an accessory announce itself. Restarting
# the hub put matter.js back. So when the network answers again after a
# silence that took a reload, this restarts `gethome-hubd` — 35 s of the API on
# that board, after an outage of five minutes at least.
#
# One case it cannot tell apart, and does not try to: an access point that
# stays up with nothing behind it and no other device on it to answer looks
# exactly like a radio that stopped passing traffic. Either way nobody can
# reach the hub, so the steps cost nothing anybody could have used.
#
# Everything it did is under `journalctl -t gethome-wifi-watchdog`.
set -uo pipefail

IFACE="${1:-}"

# Overridable so the suite can run this against files and a clock it owns, the
# way install.sh's `GETHOME_NET_DIR` is. `GETHOME_NEIGH_STATE` is the keep-
# alive's own name for its memory, so the two agree without being told.
NET_DIR="${GETHOME_NET_DIR:-/sys/class/net}"
STATE="${GETHOME_WATCHDOG_STATE:-/run/gethome-wifi-watchdog}"
NEIGHBOURS="${GETHOME_NEIGH_STATE:-/run/gethome-wifi-neighbours}"
UPTIME="${GETHOME_UPTIME:-/proc/uptime}"
MODULES="${GETHOME_SYS_MODULE:-/sys/module}"
DEBUGFS="${GETHOME_DEBUGFS:-/sys/kernel/debug/ieee80211}"
PROC_IPV6="${GETHOME_PROC_IPV6:-/proc/sys/net/ipv6/conf}"
# How long the fresh question waits for answers, and how long a reloaded driver
# gets to bring its radio back, in seconds.
ASK_WAIT="${GETHOME_WATCHDOG_ASK_WAIT:-3}"
RADIO_WAIT="${GETHOME_WATCHDOG_RADIO_WAIT:-60}"

NOTE_AFTER=120     # say so, with the counters, once
ACT_AFTER=300      # reload the radio's driver
RESTART_AFTER=300  # after the reload, restart the machine
UP_AT_LEAST=3600   # but never one that has been up for less than an hour

# One line in the journal per thing it did or saw.
note() {
  logger -t gethome-wifi-watchdog -- "$*" 2>/dev/null || printf '%s\n' "$*"
}

# Seconds since boot. Never the wall clock: a Pi has no RTC, and the jump when
# timesyncd first corrects it would read as minutes of silence.
clock() {
  local up rest
  read -r up rest 2>/dev/null < "$UPTIME" || return 1
  up="${up%%.*}"
  [[ "$up" =~ ^[0-9]+$ ]] || return 1
  printf '%s' "$up"
}

# Whether anything on this interface answered: a neighbour in REACHABLE. Read
# whole rather than piped into `grep -q`, which can end the pipe early and,
# with pipefail, turn a match into a failure.
answered() {
  local table
  table="$(ip neigh show dev "$IFACE" nud reachable 2>/dev/null)" || return 1
  [[ "$table" == *lladdr* ]]
}

nm_connected() {
  command -v nmcli >/dev/null 2>&1 || return 1
  # `connected` alone: `connected (externally)` is a device NetworkManager does
  # not manage, and one that somebody else runs is theirs to fix.
  [[ "$(LC_ALL=C nmcli -g GENERAL.STATE device show "$IFACE" 2>/dev/null)" == "100 (connected)" ]]
}

# Ask every neighbour the keep-alive remembers, at the link address it had, by
# unicast — the keep-alive's own question, asked now — and give the answers
# a moment. The file is root's (the keep-alive writes it), but every value is
# still checked before it reaches `ip`, and no more than 16 KiB of it is read.
ask_again() {
  local addr mac rest
  local addr_re='^[0-9a-f.:]+$' mac_re='^[0-9a-f]{2}(:[0-9a-f]{2}){5}$'
  if [[ -r "$NEIGHBOURS" ]]; then
    while read -r addr mac rest; do
      [[ "$addr" =~ $addr_re && ${#addr} -le 39 && "$mac" =~ $mac_re ]] || continue
      ip neigh replace "$addr" lladdr "$mac" nud probe dev "$IFACE" 2>/dev/null || true
    done < <(head -c 16384 "$NEIGHBOURS" 2>/dev/null)
  fi
  sleep "$ASK_WAIT"
  answered
}

# What each side counted, one line each, so two of them a few minutes apart say
# which side stopped: Linux's own counts, the radio's count from its firmware
# (`iw` asks the driver, which asks the firmware), the driver's SDIO bus
# counters where brcmfmac publishes them, the transmit queue, and the
# neighbour table by state.
evidence() {
  local when="$1" name value counts="" phy line
  for name in rx_packets tx_packets rx_dropped tx_dropped tx_errors; do
    value="$(cat "$NET_DIR/$IFACE/statistics/$name" 2>/dev/null)" || value="?"
    counts="$counts $name=${value:-?}"
  done
  value="$(cat "$PROC_IPV6/$IFACE/disable_ipv6" 2>/dev/null)" || value="?"
  note "$when — Linux:$counts disable_ipv6=${value:-?}"
  line="$(iw dev "$IFACE" station dump 2>/dev/null | awk -F '\t' '
    /^Station/ { printf " station=%s", $1 ~ / / ? substr($1, 9, 17) : ""; next }
    $2 ~ /^(inactive time|rx packets|tx packets|tx retries|tx failed|signal|connected time):/ {
      key = $2; sub(/:.*/, "", key); gsub(/ /, "_", key)
      value = $3; gsub(/ /, "", value)
      printf " %s=%s", key, value
    }')"
  note "$when — radio:${line:- no answer from the driver}"
  phy="$(readlink "$NET_DIR/$IFACE/phy80211" 2>/dev/null)"
  phy="${phy##*/}"
  if [[ -n "$phy" && -r "$DEBUGFS/$phy/counters" ]]; then
    line="$(awk -F ':[[:space:]]*' 'NF == 2 { printf " %s=%s", $1, $2 }' "$DEBUGFS/$phy/counters" 2>/dev/null)"
    note "$when — bus:$line"
  fi
  line="$(tc -s qdisc show dev "$IFACE" 2>/dev/null | awk '/Sent|backlog/ { $1 = $1; printf " %s;", $0 }')"
  [[ -z "$line" ]] || note "$when — queue:$line"
  line="$(ip neigh show dev "$IFACE" 2>/dev/null | awk '{ n[$NF]++ } END { for (s in n) printf " %s=%d", s, n[s] }')"
  note "$when — neighbours:${line:- none}"
}

# The kernel module driving the radio: `brcmfmac` on every Pi this was tried on.
driver() {
  local module
  module="$(readlink "$NET_DIR/$IFACE/device/driver/module" 2>/dev/null)"
  printf '%s' "${module##*/}"
}

# A wireless interface again, under whatever name the kernel gave it.
radio_back() {
  local dir
  for dir in "$NET_DIR"/*; do
    [[ -d "$dir/wireless" || -e "$dir/phy80211" ]] && return 0
  done
  return 1
}

wait_for_radio() {
  local waited=0
  while (( waited < RADIO_WAIT )); do
    radio_back && return 0
    sleep 1
    waited=$((waited + 1))
  done
  radio_back
}

reload_driver() {
  local holders=() holder
  evidence "Before reloading the driver"
  # The vendor half (brcmfmac_cyw, _wcc or _bca, whichever this chip loaded)
  # holds brcmfmac, so it goes first; `modprobe brcmfmac` brings it back.
  for holder in "$MODULES"/brcmfmac/holders/*; do
    [[ -e "$holder" ]] && holders+=("${holder##*/}")
  done
  note "Nothing on the network has answered this hub over $IFACE for $quiet s, though NetworkManager says it is connected. Reloading the Wi-Fi driver (brcmfmac), which restarts the radio's firmware and joins the network afresh."
  # The interface is about to be replaced, whatever comes of the rest.
  reloaded=1
  # The two calls stay next to each other: between them the hub has no Wi-Fi.
  # (The `+` form because bash before 4.4 calls an empty array unbound.)
  modprobe -r ${holders[@]+"${holders[@]}"} brcmfmac 2>/dev/null || note "The driver would not unload; loading it anyway."
  modprobe brcmfmac 2>/dev/null
  if wait_for_radio; then
    note "The Wi-Fi radio is back after reloading its driver."
    return 0
  fi
  modprobe brcmfmac 2>/dev/null
  if wait_for_radio; then
    note "The Wi-Fi radio is back after loading its driver a second time."
    return 0
  fi
  # Not held back by the hour below: this step took the radio away, and a hub
  # with no Wi-Fi at all is one nobody can reach to give it back.
  note "The Wi-Fi radio did not come back after its driver was reloaded. Restarting this machine, which is the only thing known to bring it back."
  systemctl reboot
}

# The last step. Held back on a machine that has been up for less than an
# hour, which is what keeps it to once an hour whatever happens after.
restart_machine() {
  if (( now < UP_AT_LEAST )); then
    if (( noted < 2 )); then
      note "Nothing on the network has answered this hub over $IFACE for $quiet s. This machine has been up for $now s and is not restarted in its first hour; it will be at $UP_AT_LEAST s if nothing has answered by then."
      noted=2
    fi
    return 0
  fi
  evidence "Before restarting"
  note "Nothing on the network has answered this hub over $IFACE for $quiet s${1:-}. Restarting this machine, the nearest it can come to the power cycle that brought the hub back the one time this was seen."
  # Asked again in five minutes if the restart is refused, never every round.
  rung=2 rung_at="$now"
  systemctl reboot || note "The restart was refused; asking again in five minutes."
}

# One line: the time something last answered, the last step taken (0 none, 1
# reloaded, 2 asked for a restart), when it was taken, what has been said about this
# silence (0 nothing, 1 the two-minute line, 2 that a restart is waiting for
# the hour), whether it has taken a reload, and the interface it is about.
save() {
  printf '%s %s %s %s %s %s\n' "$alive_at" "$rung" "$rung_at" "$noted" "$reloaded" "$IFACE" > "$STATE.new" 2>/dev/null \
    && mv -f "$STATE.new" "$STATE" 2>/dev/null
}

# The network answers again: say so, with the step that came before it, and
# restart the hub if the interface it listens on was replaced in the meantime.
back() {
  local how="$1" last
  case "$rung" in
    1) last="reloading the Wi-Fi driver, $((now - rung_at)) s before" ;;
    2) last="asking for a restart that did not happen, $((now - rung_at)) s before" ;;
    *) last="none" ;;
  esac
  note "The network answers this hub over $IFACE again, $((now - alive_at)) s after it last did${how}. Last step taken: $last."
  evidence "Back"
  if (( reloaded > 0 )); then
    note "Restarting the hub (gethome-hubd): Matter joined its mDNS groups on the interface the reload replaced, and joins them again only when it starts."
    systemctl --no-block try-restart gethome-hubd.service 2>/dev/null || true
  fi
  alive_at="$now" rung=0 rung_at=0 noted=0 reloaded=0
  save
}

now="$(clock)" || exit 0

alive_at="" rung=0 rung_at=0 noted=0 reloaded=0 about=""
if [[ -r "$STATE" ]]; then
  read -r alive_at rung rung_at noted reloaded about < "$STATE" 2>/dev/null || true
fi
# Anything unreadable, or from the future, is no memory.
for value in "${alive_at:-x}" "${rung:-x}" "${rung_at:-x}" "${noted:-x}" "${reloaded:-x}"; do
  [[ "$value" =~ ^[0-9]+$ ]] || { alive_at="" rung=0 rung_at=0 noted=0 reloaded=0 about=""; break; }
done
if [[ -n "$alive_at" ]] && (( alive_at > now )); then
  alive_at="" rung=0 rung_at=0 noted=0 reloaded=0 about=""
fi

# No default route. Only a silence this has already taken a step over is still
# its business: a reload that left NetworkManager unable to finish connecting
# looks exactly like this.
if [[ -z "$IFACE" ]]; then
  (( rung > 0 )) || exit 0
  IFACE="$about"
fi
[[ -n "$IFACE" && "$IFACE" != */* && "$IFACE" != .* ]] || exit 0
# Wi-Fi only, by either of the markers install.sh's `lan_wifi_iface` accepts:
# a hub that moved to a cable keeps its keep-alive, and has no radio to restart.
[[ -d "$NET_DIR/$IFACE/wireless" || -e "$NET_DIR/$IFACE/phy80211" ]] || exit 0
# A memory about another interface is no memory of this one.
[[ "$about" == "$IFACE" ]] || { alive_at="" rung=0 rung_at=0 noted=0 reloaded=0; }

if answered; then
  if (( rung > 0 || noted > 0 )); then
    back ""
  else
    alive_at="$now"
    save
  fi
  exit 0
fi

[[ -n "$alive_at" ]] || exit 0
quiet=$((now - alive_at))
(( quiet >= NOTE_AFTER )) || exit 0

if (( rung == 0 )); then
  nm_connected || exit 0
  module="$(driver)"
  if (( quiet < ACT_AFTER )); then
    if (( noted == 0 )); then
      if [[ "$module" == brcmfmac ]]; then next="reloads the Wi-Fi driver"; else next="restarts this machine"; fi
      note "Nothing on the network has answered this hub over $IFACE for $quiet s, though NetworkManager says it is connected. At $ACT_AFTER s it $next."
      evidence "$quiet s in"
      noted=1
      save
    fi
    exit 0
  fi
  if ask_again; then
    now="$(clock)" || exit 0
    back ", when asked once more"
    exit 0
  fi
  if [[ "$module" == brcmfmac ]]; then
    reload_driver
    now="$(clock)" || exit 0
    rung=1 rung_at="$now"
  else
    restart_machine " — its driver is ${module:-not known}, and reloading one has only been tried with brcmfmac"
  fi
  save
  exit 0
fi

# A step was taken and nothing has answered since: whatever NetworkManager
# says now, since an activation over the path that stopped cannot finish.
(( now - rung_at >= RESTART_AFTER )) || exit 0
if ask_again; then
  now="$(clock)" || exit 0
  back ", when asked once more"
  exit 0
fi
if (( rung == 1 )); then
  restart_machine ", $((now - rung_at)) s of them since the driver was reloaded"
else
  restart_machine ", and a restart asked for $((now - rung_at)) s ago has not happened"
fi
save
exit 0
