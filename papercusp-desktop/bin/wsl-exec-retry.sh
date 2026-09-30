#!/usr/bin/env bash
# Auto-recovering wrapper for `wsl -d papercup-runtime --exec <cmd>` over ssh
# into the Windows-VM testing rig (EI-8163).
#
# WHY THIS EXISTS
# During live VM verification (WI-3080, and again 2026-07-06), the
# papercup-runtime WSL distro periodically WEDGES: even a trivial probe like
# `wsl -d papercup-runtime --user papercup --exec whoami` comes back with
# ZERO stdout, empty stderr, and a nonzero exit — no error message to act on.
# Reproduced + verified live 2026-07-06: `wsl --terminate papercup-runtime`
# (exits 0, loses nothing persistent inside the distro) followed by an
# IMMEDIATE retry of the exact same --exec call succeeds on the very next
# attempt, no boot delay observed. Root cause not pinned down (stale
# wslhost.exe session / hung distro init / a WSL2 utility-VM hiccup are all
# plausible) — this wraps the empirically-verified recovery so an agent
# doesn't have to rediscover it, or burn time debugging a command that was
# never the problem.
#
# See: /internal/docs/agent-insights/windows-vm-desktop-testing-workflow
# (sharp edge #21).
#
# USAGE
#   bin/wsl-exec-retry.sh <cmd> [args...]
#
#   # e.g.
#   bin/wsl-exec-retry.sh whoami
#   bin/wsl-exec-retry.sh cat /etc/os-release
#
# ENV (all have the doc's documented defaults; override for a different rig)
#   VM_SSH_KEY     default: ~/.ssh/papercup-vm-win
#   VM_SSH_PORT    default: 2223
#   VM_SSH_HOST    default: user@127.0.0.1
#   WSL_DISTRO     default: papercup-runtime
#   WSL_USER       default: papercup
#
# BEHAVIOR
# Runs the --exec call once. If (and only if) it comes back with EMPTY
# stdout, EMPTY stderr, AND a non-zero exit — the wedge signature — it runs
# `wsl --terminate "$WSL_DISTRO"` and retries the SAME --exec call exactly
# once more. Prints the winning attempt's stdout (already stripped of the
# UTF-16 \r\0 noise per the doc) and exits with that attempt's real exit
# code. A genuine command failure with ANY stderr or stdout is never
# masked — it surfaces normally on whichever attempt produced it.
#
# KNOWN AMBIGUITY (verified live 2026-07-06): because `--exec` bypasses any
# shell, exec'ing a command that does not EXIST inside the distro produces
# the exact same signature (empty stdout, empty stderr, exit 1) as the real
# wedge — there is no "command not found" message to tell them apart from
# the outside. In that case this script harmlessly costs one extra
# terminate+retry round trip and then surfaces the SAME final result
# (exit 1, no output) you'd get without it — it never masks the error or
# reports false success. It does mean a plain typo pays for a `wsl
# --terminate` it didn't need; low-cost, and no different from re-running
# the typo'd command yourself.

set -uo pipefail

VM_SSH_KEY="${VM_SSH_KEY:-$HOME/.ssh/papercup-vm-win}"
VM_SSH_PORT="${VM_SSH_PORT:-2223}"
VM_SSH_HOST="${VM_SSH_HOST:-user@127.0.0.1}"
WSL_DISTRO="${WSL_DISTRO:-papercup-runtime}"
WSL_USER="${WSL_USER:-papercup}"

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <cmd> [args...]" >&2
  exit 2
fi

ssh_exec() {
  ssh -i "$VM_SSH_KEY" -p "$VM_SSH_PORT" -o ConnectTimeout=10 -o BatchMode=yes \
    "$VM_SSH_HOST" -- wsl -d "$WSL_DISTRO" --user "$WSL_USER" --exec "$@"
}

attempt() {
  local out err rc
  out="$(ssh_exec "$@" 2>/tmp/wsl-exec-retry.err)"
  rc=$?
  err="$(tr -d '\r\0' </tmp/wsl-exec-retry.err)"
  rm -f /tmp/wsl-exec-retry.err
  # wsl.exe emits UTF-16 on some paths; strip the null/CR noise before any
  # emptiness check or the wedge signature can look non-empty when it isn't.
  out="$(printf '%s' "$out" | tr -d '\r\0')"
  printf '%s\x1e%s\x1e%s' "$out" "$err" "$rc"
}

result="$(attempt "$@")"
out1="${result%%$'\x1e'*}"
rest1="${result#*$'\x1e'}"
err1="${rest1%%$'\x1e'*}"
rc1="${rest1#*$'\x1e'}"

if [[ -z "$out1" && -z "$err1" && "$rc1" -ne 0 ]]; then
  echo "[wsl-exec-retry] wedge signature detected (empty stdout+stderr, exit $rc1) — terminating and retrying: $WSL_DISTRO" >&2
  if ! ssh -i "$VM_SSH_KEY" -p "$VM_SSH_PORT" -o ConnectTimeout=10 -o BatchMode=yes \
      "$VM_SSH_HOST" -- wsl --terminate "$WSL_DISTRO" >&2; then
    echo "[wsl-exec-retry] 'wsl --terminate $WSL_DISTRO' itself failed — giving up, surfacing the original wedge exit" >&2
    exit "$rc1"
  fi
  result="$(attempt "$@")"
  out2="${result%%$'\x1e'*}"
  rest2="${result#*$'\x1e'}"
  err2="${rest2%%$'\x1e'*}"
  rc2="${rest2#*$'\x1e'}"
  printf '%s' "$out2"
  [[ -n "$err2" ]] && printf '%s' "$err2" >&2
  exit "$rc2"
fi

printf '%s' "$out1"
[[ -n "$err1" ]] && printf '%s' "$err1" >&2
exit "$rc1"
