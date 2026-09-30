#!/usr/bin/env bash
set -euo pipefail

# Keep papercusp.com on normal direct routing with authenticated DNS.  This is
# deliberately not a VPN, proxy, SSH forward, or any other tunnel.

mode="${1:---check}"
case "$mode" in
  --apply|--check) ;;
  *) printf 'usage: %s [--apply|--check]\n' "$0" >&2; exit 64 ;;
esac

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
hosts_file=${PAPERCUSP_DNS_HOSTS_FILE:-/etc/hosts}
resolved_dropin=${PAPERCUSP_DNS_RESOLVED_DROPIN:-/etc/systemd/resolved.conf.d/99-papercusp-dns-over-tls.conf}
expected_dropin=${PAPERCUSP_DNS_EXPECTED_DROPIN:-$script_dir/systemd/papercusp-dns-over-tls.conf}
chrome_policy=${PAPERCUSP_CHROME_POLICY:-/etc/opt/chrome/policies/managed/papercusp-direct-dns.json}
chrome_policy_source=${PAPERCUSP_CHROME_POLICY_SOURCE:-$script_dir/systemd/papercusp-chrome-dns-policy.json}
connection=${PAPERCUSP_DNS_CONNECTION:-GateWayFiber58}
bypass_unit=${PAPERCUSP_DNS_BYPASS_UNIT:-papercusp-sni-bypass.service}
bypass_unit_file=${PAPERCUSP_DNS_BYPASS_UNIT_FILE:-/etc/systemd/system/$bypass_unit}
test_mode=${PAPERCUSP_DNS_TEST_MODE:-0}
changed=0

target_host_re='^(sidestage\.papercusp\.com|papercusp\.com|www\.papercusp\.com|papercuspai\.com|flags\.papercuspai\.com|api\.papercuspai\.com|media\.sidestage\.papercusp\.com|turn\.sidestage\.papercusp\.com)$'

scrub_hosts() {
  local output
  output=$(mktemp "${hosts_file}.papercusp.XXXXXX")
  awk -v target_re="$target_host_re" '
    /BEGIN papercusp-sni-bypass/ { in_bypass = 1; next }
    /END papercusp-sni-bypass/   { in_bypass = 0; next }
    in_bypass { next }
    /^[[:space:]]*($|#)/ { print; next }
    {
      comment = ""
      hash = index($0, "#")
      data = $0
      if (hash > 0) {
        comment = substr($0, hash)
        data = substr($0, 1, hash - 1)
      }
      count = split(data, fields, /[[:space:]]+/)
      out = ""
      address = ""
      for (i = 1; i <= count; i++) {
        if (fields[i] == "") continue
        if (address == "") { address = fields[i]; continue }
        if (fields[i] !~ target_re) out = out " " fields[i]
      }
      if (out != "") {
        printf "%s%s", address, out
        if (comment != "") printf "  %s", comment
        printf "\n"
      } else if (comment != "") {
        print comment
      }
    }
  ' "$hosts_file" >"$output"

  if cmp -s "$output" "$hosts_file"; then
    rm -f "$output"
  else
    chmod --reference="$hosts_file" "$output"
    chown --reference="$hosts_file" "$output"
    mv -f "$output" "$hosts_file"
    changed=1
  fi
}

hosts_are_direct() {
  awk -v target_re="$target_host_re" '
    /^[[:space:]]*#/ { next }
    {
      for (i = 2; i <= NF; i++) {
        if ($i ~ /^#/) break
        if ($i ~ target_re) exit 1
      }
    }
  ' "$hosts_file"
}

install_dropin() {
  if ! cmp -s "$expected_dropin" "$resolved_dropin"; then
    install -D -m 0644 "$expected_dropin" "$resolved_dropin"
    changed=1
  fi
  if [[ "$test_mode" != 1 ]]; then
    # These older, lower-precedence drop-ins either left DHCP DNS eligible or
    # reintroduced unauthenticated fallbacks after this file had enabled DoT.
    for legacy_dropin in \
      /etc/systemd/resolved.conf.d/papercusp-dns-over-tls.conf \
      /etc/systemd/resolved.conf.d/papercusp-fallback-dns.conf; do
      if [[ -e "$legacy_dropin" || -L "$legacy_dropin" ]]; then
        rm -f "$legacy_dropin"
        changed=1
      fi
    done
  fi
}

install_browser_policy() {
  if ! cmp -s "$chrome_policy_source" "$chrome_policy"; then
    install -D -m 0644 "$chrome_policy_source" "$chrome_policy"
    changed=1
  fi
}

mask_bypass() {
  local enabled
  enabled=$(systemctl is-enabled "$bypass_unit" 2>/dev/null || true)
  if [[ "$enabled" != masked || ! -L "$bypass_unit_file" || $(readlink "$bypass_unit_file" 2>/dev/null || true) != /dev/null ]]; then
    systemctl disable --now "$bypass_unit" >/dev/null 2>&1 || true
    rm -f "$bypass_unit_file"
    ln -s /dev/null "$bypass_unit_file"
    changed=1
  fi
}

configure_connection() {
  local connection_status
  connection_status=$(nmcli -g ipv4.ignore-auto-dns,ipv6.ignore-auto-dns,connection.dns-over-tls connection show "$connection")
  if [[ "$connection_status" != $'yes\nyes\n2' ]]; then
    nmcli connection modify "$connection" \
      ipv4.ignore-auto-dns yes ipv4.dns "" \
      ipv6.ignore-auto-dns yes ipv6.dns "" \
      connection.dns-over-tls yes
    changed=1
  fi
}

activate_resolver() {
  systemctl daemon-reload
  systemctl restart systemd-resolved.service
  nmcli connection reload
  nmcli device reapply wlp183s0 >/dev/null
  resolvectl flush-caches
}

check_live_contract() {
  local resolved_status connection_status addresses
  resolved_status=$(resolvectl status)
  grep -q 'Protocols:.*+DNSOverTLS' <<<"$resolved_status"
  ! grep -q 'DNS Servers: 192\.168\.40\.1' <<<"$resolved_status"

  connection_status=$(nmcli -g ipv4.ignore-auto-dns,ipv6.ignore-auto-dns,connection.dns-over-tls connection show "$connection")
  [[ "$connection_status" == $'yes\nyes\n2' ]]

  [[ $(systemctl is-enabled "$bypass_unit" 2>/dev/null || true) == masked ]]
  addresses=$(getent ahostsv4 papercusp.com | awk '{print $1}' | sort -u)
  [[ -n "$addresses" ]]
  ! grep -Eq '(^|[[:space:]])127\.' <<<"$addresses"
}

if [[ "$mode" == --apply ]]; then
  [[ $EUID -eq 0 || "$test_mode" == 1 ]] || {
    echo 'papercusp-dns-reconcile --apply must run as root' >&2
    exit 77
  }
  scrub_hosts
  install_dropin
  install_browser_policy
  if [[ "$test_mode" != 1 ]]; then
    mask_bypass
    configure_connection
    if (( changed )); then
      activate_resolver
    fi
  fi
fi

hosts_are_direct
cmp -s "$expected_dropin" "$resolved_dropin"
cmp -s "$chrome_policy_source" "$chrome_policy"
if [[ "$test_mode" != 1 ]]; then
  check_live_contract
fi
