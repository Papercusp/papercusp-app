#!/usr/bin/env bash
# smoke-target-preflight.sh — is a NATIVE installed-upgrade smoke target usable
# RIGHT NOW? Run it BEFORE a long release build, so a missing console login,
# unreachable SSH, or absent installed baseline is named up front instead of
# surfacing as an exit 2 from install-and-relaunch-verify.sh an hour later
# (WI-10004346: 0.0.26 burned a full cut, then both native smokes refused).
#
# Needs NO artifact. It reuses the verifier's own endpoint defaults
# (lib/smoke-endpoints.sh) and its exact remote macOS predicate
# (lib/mac-native-preflight.sh), so a PASS here means the verifier's preflight
# will pass too.
#
# Usage:  bin/smoke-target-preflight.sh --platform windows|mac
#           [--ssh-port N] [--ssh-key PATH] [--ssh-host USER@HOST]
# Exit:   0 READY      reachable, console usable (mac), installed baseline found
#         2 NOT-READY  each reason printed as `SMOKE_TARGET_BLOCKER <platform> <code>: <detail>`
#         3 STOPPED    windows only: SSH down but the host VM unit exists — boot
#                      it (systemctl --user start <unit>, about 100 s to SSH). Not
#                      a rig fault.
#         4 misuse
# Stdout always ends with one `SMOKE_TARGET_RESULT platform=… status=… baseline=…` line.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/smoke-endpoints.sh
source "$HERE/lib/smoke-endpoints.sh"

PLATFORM="" SSH_PORT="${SSH_PORT:-}" SSH_KEY="${SSH_KEY:-}" SSH_HOST="${SSH_HOST:-}"
while (($#)); do
  case "$1" in
    --platform) PLATFORM="${2:-}"; shift 2 ;;
    --ssh-port) SSH_PORT="${2:-}"; shift 2 ;;
    --ssh-key) SSH_KEY="${2:-}"; shift 2 ;;
    --ssh-host) SSH_HOST="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 4 ;;
  esac
done
smoke_endpoint_defaults "$PLATFORM" 2>/dev/null || { echo "need --platform windows|mac" >&2; exit 4; }

# ── Verification-harness contract (expensive-verification-loops P-006) ───────
# Bracket mode, one phase over the whole probe. release:cut reads stdout+stderr concatenated
# and takes the LAST line as its exit-3 hint, so the VH_* lines stay on stdout and finish()
# finalizes the run BEFORE the SMOKE_TARGET_RESULT line. VH_FAIL_OPEN: a contract that cannot
# start never changes the verdict.
VH_SH="$HERE/../../libs/generic/verification-harness/bin/vh.sh"
if [[ -f "$VH_SH" ]]; then
  # shellcheck source=../../libs/generic/verification-harness/bin/vh.sh
  source "$VH_SH"
  VH_FAIL_OPEN="${VH_FAIL_OPEN:-1}"
  vh_phase probe ""
  vh_init smoke-target-preflight "${SMOKE_TARGET_PREFLIGHT_EVIDENCE_ROOT:-$(vh_default_root smoke-target-preflight)}"
  vh_bracket_trap
  vh_begin probe || true
else
  echo "VH_DISABLED harness=smoke-target-preflight reason=vh.sh-missing:$VH_SH"
  vh_fail() { :; }; vh_exit() { :; }
fi

SSH=("${PC_SSH:-ssh}" -i "$SSH_KEY" -p "$SSH_PORT" -o IdentitiesOnly=yes -o ConnectTimeout=10 -o BatchMode=yes "$SSH_HOST")
SYSTEMCTL="${PC_SYSTEMCTL:-systemctl}"
BLOCKERS=()
blocker() { BLOCKERS+=("$1"); echo "SMOKE_TARGET_BLOCKER $PLATFORM $1"; }
result() { # $1=status $2=baseline
  echo "SMOKE_TARGET_RESULT platform=$PLATFORM status=$1 baseline=${2:-unknown} endpoint=$SSH_HOST:$SSH_PORT"
}
finish() { # $1=exit $2=status $3=baseline — close the vh run, then print the result line LAST
  if (($1)); then vh_fail "$2" "${BLOCKERS[*]:-}"; fi
  vh_exit "$1"
  result "$2" "${3:-}"
  exit "$1"
}

[[ -r "$SSH_KEY" ]] || blocker "ssh-key-missing: $SSH_KEY is not readable"

# ── 1. reachability ─────────────────────────────────────────────────────────
if [[ "$PLATFORM" == windows ]]; then REACH='cmd /c echo VM-OK'; else REACH='echo VM-OK'; fi
reach_out="$(timeout 20 "${SSH[@]}" "$REACH" 2>&1 | tr -d '\r\0')"
if [[ "$reach_out" != *VM-OK* ]]; then
  if [[ "$PLATFORM" == windows ]] && "$SYSTEMCTL" --user cat "$SMOKE_WINDOWS_VM_UNIT" >/dev/null 2>&1 \
     && ! "$SYSTEMCTL" --user is-active --quiet "$SMOKE_WINDOWS_VM_UNIT"; then
    echo "SMOKE_TARGET_STOPPED windows: $SMOKE_WINDOWS_VM_UNIT is inactive — boot it with: $SYSTEMCTL --user start $SMOKE_WINDOWS_VM_UNIT (about 100 s to SSH), then re-run"
    finish 3 stopped
  fi
  blocker "ssh-unreachable: ${reach_out:0:300}"
  finish 2 not-ready
fi

# ── 2. console ownership (mac) — the verifier's exact remote predicate ───────
if [[ "$PLATFORM" == mac ]]; then
  pre_out="$(timeout 30 "${SSH[@]}" "$(cat "$HERE/lib/mac-native-preflight.sh")" 2>&1 | tr -d '\r\0')"
  [[ "$pre_out" == *PAPERCUSP_NATIVE_MAC_PREFLIGHT_OK* ]] || blocker "console-not-ready: ${pre_out:0:400}"
fi

# ── 3. installed baseline — an installed-UPGRADE needs an older install ──────
if [[ "$PLATFORM" == mac ]]; then
  BASE_CMD='for a in "Papercusp GUI" "Papercusp Server"; do p="/Applications/$a.app/Contents/Info.plist"; [ -f "$p" ] && printf "%s=%s\n" "$a" "$(defaults read "${p%.plist}" CFBundleShortVersionString 2>/dev/null)"; done; true'
else
  BASE_CMD="powershell -NoProfile -Command \"Get-ItemProperty HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* | Where-Object { \$_.DisplayName -like 'Papercusp*' } | ForEach-Object { \$_.DisplayName + '=' + \$_.DisplayVersion }\""
fi
base_out="$(timeout 30 "${SSH[@]}" "$BASE_CMD" 2>/dev/null | tr -d '\r\0' | grep -E '^Papercusp (GUI|Server)[^=]*=' || true)"
baseline="$(printf '%s' "$base_out" | sed -E 's/^Papercusp ([A-Za-z]+)[^=]*=/\1=/' | paste -sd, -)"
grep -q '^Papercusp GUI[^=]*=.' <<<"$base_out" || blocker "baseline-missing: no installed Papercusp GUI to upgrade from"
grep -q '^Papercusp Server[^=]*=.' <<<"$base_out" || blocker "baseline-missing: no installed Papercusp Server to upgrade from"

if ((${#BLOCKERS[@]})); then finish 2 not-ready "$baseline"; fi
finish 0 ready "$baseline"
