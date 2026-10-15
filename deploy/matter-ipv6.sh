#!/usr/bin/env bash
# GetHome Hub — keep the kernel's IPv6 on an interface NetworkManager was told
# to leave to it, so Matter keeps the link-local address it runs on.
#
#   matter-ipv6.sh IFACE [--quiet]
#
# Run as root by the `51-gethome-matter-ipv6` NetworkManager dispatcher every
# time a connection comes up, with that connection's interface, and once by
# install.sh (`matter_ipv6`) with the interface carrying the default route.
#
# ── Why ─────────────────────────────────────────────────────────────────────
#
# Matter is IPv6, and on one Wi-Fi the link-local address is all it needs. The
# Wi-Fi profile Raspberry Pi Imager sets up says `ipv6.method=ignore`, which
# tells NetworkManager to leave IPv6 on that interface to the kernel, where it
# is on by default. NetworkManager does not always manage to leave it on.
# Activating an `ignore` connection, it switches `disable_ipv6` on so that the
# kernel starts its link-local address afresh, and then puts back the value it
# saved when it first took the device over. It forgets that saved value whenever
# the access point under an active connection changes
# (`nm_device_update_dynamic_ip_setup`, "roamed to a different AP"), and on the
# hub this was found on that happened every time the network it was on went
# away. So the next connection switched IPv6 off and had nothing to put back,
# and the interface stayed without IPv6 until NetworkManager next restarted,
# which in practice means a reboot. A router that goes away for longer than the
# 15-second link timeout is enough. What that costs Matter is everything it
# reaches over IPv6: an accessory that also answers on IPv4 is still reached
# that way (the hub this was found on kept its Wi-Fi plug, at the plug's IPv4
# address, for the five hours it lasted), but one that is only on IPv6, which
# every Thread accessory is, cannot be reached at all. Read in NetworkManager
# 1.52.1, which Trixie ships, and still the same on its main branch on
# 2026-10-15. Reproduced on a Zero 2 W: made to drop and rejoin its access point
# under an active connection (`ip:dhcp4: restarting` in the journal) and then
# reactivated, wlan0 came back with `disable_ipv6=1` and no link-local address;
# the same reactivation without the drop brought it back with IPv6 on.
#
# So when a connection comes up this puts the kernel's IPv6 back on its
# interface, which is only what `ignore` asked for, and nothing more: no
# address of its own, no listener, no change to the profile. It acts only when
# NetworkManager was told `ignore` (`disabled` is somebody's choice, and with
# every other method NetworkManager runs IPv6 itself), only on a physical
# interface, and never when this machine asks for IPv6 off: `all` or `default`
# already off, or a sysctl file turning it off for this interface by name.
set -uo pipefail

IFACE=""
QUIET=""
for arg in "$@"; do
  case "$arg" in
    --quiet) QUIET=1 ;;
    -*) ;;
    *) [[ -n "$IFACE" ]] || IFACE="$arg" ;;
  esac
done

# Overridable for the same reason `GETHOME_PROC_IPV6` is in install.sh: so the
# suite can run this against files it owns.
PROC="${GETHOME_PROC_IPV6:-/proc/sys/net/ipv6/conf}"
NET_DIR="${GETHOME_NET_DIR:-/sys/class/net}"
SYSCTL_FILES="${GETHOME_SYSCTL_FILES:-/etc/sysctl.conf /etc/sysctl.d/*.conf /run/sysctl.d/*.conf /usr/local/lib/sysctl.d/*.conf /usr/lib/sysctl.d/*.conf /lib/sysctl.d/*.conf}"

# A line in the journal (`journalctl -t gethome-matter-ipv6`) when it changes
# something, and on the installer's output as well unless it is quiet.
note() {
  logger -t gethome-matter-ipv6 -- "$*" 2>/dev/null || true
  [[ -n "$QUIET" ]] || printf '%s\n' "$*"
}

# Whether a sysctl file on this machine turns IPv6 off for this interface, for
# every interface (`all`, `default`, or a `*` key), in either spelling of a key.
configured_off() {
  local pattern
  pattern="^[[:space:]]*-?net[./]ipv6[./]conf[./](all|default|\\*|$1)[./]disable_ipv6[[:space:]]*=[[:space:]]*1[[:space:]]*$"
  # shellcheck disable=SC2086  # the list is globs, expanded here on purpose
  grep -qsE "$pattern" $SYSCTL_FILES
}

# What the connection on this interface says about IPv6: the dispatcher's own
# connection when one runs this, otherwise the one active on the device.
ipv6_method() {
  local uuid="${CONNECTION_UUID:-}"
  command -v nmcli >/dev/null 2>&1 || return 0
  [[ -n "$uuid" ]] || uuid="$(nmcli -g GENERAL.CON-UUID device show "$1" 2>/dev/null)"
  [[ -n "$uuid" ]] || return 0
  nmcli -g ipv6.method connection show uuid "$uuid" 2>/dev/null
}

[[ -n "$IFACE" && "$IFACE" != */* && "$IFACE" != .* ]] || exit 0
[[ -e "$PROC/$IFACE/disable_ipv6" ]] || exit 0
[[ "$(cat "$PROC/$IFACE/disable_ipv6" 2>/dev/null)" == "1" ]] || exit 0
[[ -e "$NET_DIR/$IFACE/device" ]] || exit 0
[[ "$(cat "$PROC/all/disable_ipv6" 2>/dev/null || echo 0)" == "0" ]] || exit 0
[[ "$(cat "$PROC/default/disable_ipv6" 2>/dev/null || echo 0)" == "0" ]] || exit 0
configured_off "$IFACE" && exit 0
method="$(ipv6_method "$IFACE")"
[[ "$method" == "ignore" ]] || exit 0

if printf '0' > "$PROC/$IFACE/disable_ipv6" 2>/dev/null \
  && [[ "$(cat "$PROC/$IFACE/disable_ipv6" 2>/dev/null)" == "0" ]]; then
  note "NetworkManager left IPv6 off on ${IFACE}, whose connection leaves IPv6 to the kernel (ipv6.method=ignore); turned it back on, so Matter has its link-local address again."
else
  note "IPv6 is off on ${IFACE}, whose connection leaves IPv6 to the kernel (ipv6.method=ignore), and it could not be turned back on; a Matter accessory that is only on IPv6 cannot be reached until it is."
fi
exit 0
