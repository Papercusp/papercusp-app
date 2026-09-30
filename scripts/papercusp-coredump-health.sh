#!/usr/bin/env bash
#
# Fail-loud guard for systemd-coredump's free-space reserve.
#
# systemd-coredump silently skips external core storage when KeepFree exceeds
# the free space on the filesystem containing /var/lib/systemd/coredump. Keep
# this check independent of the host's unit file so it can be run manually,
# from a timer, or during host provisioning.
#
# Environment overrides make the probe testable without changing the host:
#   PAPERCUSP_COREDUMP_CONFIG=/path/to/drop-in
#   PAPERCUSP_COREDUMP_PATH=/path/to/coredump-dir

set -euo pipefail

CONFIG_PATH="${PAPERCUSP_COREDUMP_CONFIG:-/etc/systemd/coredump.conf.d/99-papercusp-disk-guard.conf}"
TARGET_PATH="${PAPERCUSP_COREDUMP_PATH:-/var/lib/systemd/coredump}"

fail() {
  printf 'papercusp-coredump-health: %s\n' "$*" >&2
  exit 1
}

[[ -r "$CONFIG_PATH" ]] || fail "missing coredump guard config: $CONFIG_PATH"
[[ -d "$TARGET_PATH" ]] || fail "missing coredump storage directory: $TARGET_PATH"

keep_free="$(awk -F= '
  /^[[:space:]]*KeepFree[[:space:]]*=/ {
    value = $2
    gsub(/[[:space:]]/, "", value)
    print value
    exit
  }
' "$CONFIG_PATH")"
[[ -n "$keep_free" ]] || fail "KeepFree is not configured in $CONFIG_PATH"

keep_free_bytes="$(numfmt --from=iec "$keep_free")" ||
  fail "cannot parse KeepFree=$keep_free"
free_bytes="$(df -B1 --output=avail "$TARGET_PATH" | awk 'NR == 2 { print $1 }')"
[[ "$free_bytes" =~ ^[0-9]+$ ]] || fail "cannot read free bytes for $TARGET_PATH"

target_source="$(findmnt -T "$TARGET_PATH" -no SOURCE 2>/dev/null || true)"
root_source="$(findmnt -T / -no SOURCE 2>/dev/null || true)"
[[ -n "$target_source" ]] || fail "cannot resolve the filesystem for $TARGET_PATH"

if [[ -n "$root_source" && "$target_source" == "$root_source" ]]; then
  fail "coredump storage is still on root ($target_source); KeepFree=$keep_free, free=${free_bytes}B"
fi

if (( free_bytes <= keep_free_bytes )); then
  fail "KeepFree=$keep_free (${keep_free_bytes}B) exceeds free space (${free_bytes}B) on $target_source"
fi

printf 'papercusp-coredump-health: ok target=%s source=%s free=%sB keepFree=%s (%sB)\n' \
  "$TARGET_PATH" "$target_source" "$free_bytes" "$keep_free" "$keep_free_bytes"
