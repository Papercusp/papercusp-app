#!/usr/bin/env bash
# PC_HEAVY_SHIM_V1 — heavy-job admission shim (P-529, plan agent-capacity-and-cost-gcp-2026-09-30).
#
# Installed by install-heavy-shim.sh IN PLACE OF <repo>/node_modules/.bin/{vitest,tsc,tsgo}, with the
# original bin renamed to .<name>.heavy-real beside it. Agents run `npx vitest run …` / `npx tsc
# --noEmit …` directly (measured in the P-019 recordings), which never passes through the repo's
# pc-heavy admission; npx resolves node_modules/.bin first, so this shim is where those calls are
# caught. It routes the call through <repo>/scripts/pc-heavy.sh, so the same counting semaphore
# that `npm run test:file` already uses admits it. Pool config comes from the caller's env
# (PC_HEAVY_SLOTS=K, PC_HEAVY_DIR, …): the capacity driver exports it once for every agent.
#
# Re-entry: pc-heavy exports PC_HEAVY_BYPASS=1 into its child, so an admitted job (this shim
# re-invoked by pc-heavy, or `npm run test:file`'s own `npx vitest`) runs the real bin directly and
# never asks for a second slot (with K slots that would deadlock).
#
# PC_HEAVY_SHIM_LOG=<file> appends one JSON line per request and per admission
# ({"ev":"request"|"admit","bin","id","t"[,"waitSec"]}), the added-wait measurement.
# PC_HEAVY_SHIM_SCRIPT overrides the pc-heavy path (tests).
set -u
_name="$(basename "$0")"
_bindir="$(cd "$(dirname "$0")" && pwd)"
_real="$_bindir/.$_name.heavy-real"
_log="${PC_HEAVY_SHIM_LOG:-}"
_now() { date +%s.%N; }
_rec() { if [ -n "$_log" ]; then printf '%s\n' "$1" >>"$_log" 2>/dev/null || true; fi; }

if [ ! -e "$_real" ]; then
  echo "heavy-shim: $_real is missing (re-run install-heavy-shim.sh)" >&2
  exit 127
fi

if [ "${PC_HEAVY_BYPASS:-}" = "1" ]; then
  if [ -n "${PC_HEAVY_SHIM_T0:-}" ]; then
    _t="$(_now)"
    _w="$(awk -v a="$_t" -v b="$PC_HEAVY_SHIM_T0" 'BEGIN { printf "%.3f", a - b }')"
    _rec "{\"ev\":\"admit\",\"bin\":\"$_name\",\"id\":\"${PC_HEAVY_SHIM_ID:-}\",\"t\":$_t,\"waitSec\":$_w}"
    unset PC_HEAVY_SHIM_T0 PC_HEAVY_SHIM_ID
  fi
  exec "$_real" "$@"
fi

_pch="${PC_HEAVY_SHIM_SCRIPT:-$_bindir/../../scripts/pc-heavy.sh}"
if [ ! -f "$_pch" ]; then
  echo "heavy-shim: no pc-heavy at $_pch; running $_name unadmitted" >&2
  exec "$_real" "$@"
fi

PC_HEAVY_SHIM_T0="$(_now)"
PC_HEAVY_SHIM_ID="$$-${PC_HEAVY_SHIM_T0}"
export PC_HEAVY_SHIM_T0 PC_HEAVY_SHIM_ID
_rec "{\"ev\":\"request\",\"bin\":\"$_name\",\"id\":\"$PC_HEAVY_SHIM_ID\",\"t\":$PC_HEAVY_SHIM_T0}"
exec bash "$_pch" -- "$0" "$@"
