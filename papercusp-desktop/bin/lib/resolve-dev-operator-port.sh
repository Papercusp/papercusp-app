#!/usr/bin/env bash
# Shared by the Tauri launcher and its beforeDevCommand.
#
# The desktop shell and the working-tree Hono operator MUST agree on the
# selected port. When papercup-bg-host owns the default :3270, both callers
# use the next free port; keeping this decision in one sourced helper prevents
# the shell from opening one port while the webview points at another.

dev_operator_port_in_use() {
  local port="${1:?port is required}"
  if command -v ss >/dev/null 2>&1; then
    ss -tlnH "sport = :$port" 2>/dev/null | grep -q .
  elif command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
  else
    # No tooling — try to bind via Bash's /dev/tcp; success means we'd collide.
    (exec 3<>/dev/tcp/127.0.0.1/"$port") 2>/dev/null && exec 3<&- && return 0
    return 1
  fi
}

dev_operator_bg_host_enabled() {
  local unit="${OPERATOR_DEV_BG_HOST_UNIT:-papercup-bg-host.service}"
  command -v systemctl >/dev/null 2>&1 && systemctl --user is-enabled "$unit" >/dev/null 2>&1
}

dev_operator_bg_host_reserved_port() {
  local unit="${OPERATOR_DEV_BG_HOST_UNIT:-papercup-bg-host.service}"
  local port
  port="$(systemctl --user cat "$unit" 2>/dev/null \
    | grep -oP 'PAPERCUSP_HONO_PORT=\K[0-9]+' | tail -1 || true)"
  printf '%s\n' "${port:-3270}"
}

resolve_dev_operator_port() {
  local port="${1:-3270}"
  if ! dev_operator_bg_host_enabled; then
    printf '%s\n' "$port"
    return 0
  fi

  local reserved_port
  reserved_port="$(dev_operator_bg_host_reserved_port)"
  if [[ "$port" != "$reserved_port" ]]; then
    printf '%s\n' "$port"
    return 0
  fi

  local candidate=$((port + 1))
  while [[ "$candidate" == "$reserved_port" ]] || dev_operator_port_in_use "$candidate"; do
    candidate=$((candidate + 1))
  done
  printf "[tauri] :%s is papercup-bg-host's reserved port (enabled) — using :%s instead to avoid racing its EADDRINUSE recovery (EI-13139)\n" \
    "$port" "$candidate" >&2
  printf '%s\n' "$candidate"
}
