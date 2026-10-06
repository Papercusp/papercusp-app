#!/usr/bin/env bash
# Relay drill network: TWO network namespaces (hpA, hpB) that both NAT-egress through this host
# (one public IP) but have NO route to each other, so two peers inside them can only meet through
# a relay. ufw's default 'deny (routed)' drops hpA<->hpB forwarding and only each veth -> WAN is
# allowed; explicit FORWARD drops also isolate ICMP. Additive only; `down` removes exactly what
# `up` added.
# usage: sudo bash scripts/relay/drill/netns.sh up|down
#   RELAY_DRILL_WAN  egress interface (default: the interface of the default route)
# Origin: WI-10004745 (hairpin probe), reused by WI-10004827 / WI-10004961 relay drills.
set -u
WAN="${RELAY_DRILL_WAN:-$(ip route show default | awk '{for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit }}')}"
[ -n "$WAN" ] || { echo "netns.sh: no default-route interface; set RELAY_DRILL_WAN" >&2; exit 2; }
TAG='papercusp relay drill (temporary)'
ns_up() { # name veth0 veth1 subnet
  local NS=$1 V0=$2 V1=$3 SUB=$4
  ip netns add "$NS"
  ip link add "$V0" type veth peer name "$V1"
  ip link set "$V1" netns "$NS"
  ip addr add "$SUB.1/24" dev "$V0"
  ip link set "$V0" up
  ip netns exec "$NS" ip addr add "$SUB.2/24" dev "$V1"
  ip netns exec "$NS" ip link set "$V1" up
  ip netns exec "$NS" ip link set lo up
  ip netns exec "$NS" ip route add default via "$SUB.1"
  iptables -t nat -A POSTROUTING -s "$SUB.0/24" -o "$WAN" -j MASQUERADE
  ufw allow in on "$V0" from "$SUB.0/24" to any port 53 comment "$TAG" >/dev/null
  ufw route allow in on "$V0" out on "$WAN" comment "$TAG" >/dev/null
  mkdir -p "/etc/netns/$NS"
  echo 'nameserver 1.1.1.1' >"/etc/netns/$NS/resolv.conf"
}
ns_down() {
  local NS=$1 V0=$2 SUB=$4
  ufw delete allow in on "$V0" from "$SUB.0/24" to any port 53 >/dev/null 2>&1 || true
  ufw route delete allow in on "$V0" out on "$WAN" >/dev/null 2>&1 || true
  iptables -t nat -D POSTROUTING -s "$SUB.0/24" -o "$WAN" -j MASQUERADE 2>/dev/null || true
  ip netns del "$NS" 2>/dev/null || true
  ip link del "$V0" 2>/dev/null || true
  rm -rf "/etc/netns/$NS"
}
case "${1:-}" in
up)
  set -e
  ns_up hpA hpaveth0 hpaveth1 10.96.0
  ns_up hpB hpbveth0 hpbveth1 10.95.0
  # ufw before.rules ACCEPTs forwarded ICMP echo, so isolate the two subnets explicitly.
  iptables -I FORWARD -s 10.96.0.0/24 -d 10.95.0.0/24 -j DROP
  iptables -I FORWARD -s 10.95.0.0/24 -d 10.96.0.0/24 -j DROP
  echo "UP ok wan=$WAN"
  ;;
down)
  iptables -D FORWARD -s 10.96.0.0/24 -d 10.95.0.0/24 -j DROP 2>/dev/null || true
  iptables -D FORWARD -s 10.95.0.0/24 -d 10.96.0.0/24 -j DROP 2>/dev/null || true
  ns_down hpA hpaveth0 hpaveth1 10.96.0
  ns_down hpB hpbveth0 hpbveth1 10.95.0
  echo "DOWN ok"
  ;;
*)
  echo "usage: $0 up|down" >&2
  exit 2
  ;;
esac
