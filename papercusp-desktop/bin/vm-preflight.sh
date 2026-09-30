#!/usr/bin/env bash
# P-011 (desktop-build-hardening-tri-platform-2026-07-11): release:vm-preflight.
# The ONE canonical "is the VM's packaged operator actually alive + healthy?"
# check, so no agent re-hand-rolls the triad and misreads a HEALTHY operator as
# dead — the exact WI-3270 failure (Windows→WSL localhost-forward flake made
# supervision kill a healthy serve+PG, exhaust respawn caps, and let the distro
# die; recovery needed a manual app restart).
#
# The triad, in dependency order (WI-3270):
#   1. HOST: the VM process is running on the host (pgrep) — nothing else can be
#      true if the VM isn't booted.
#   2. VM: ssh reachable, and the desktop app process is alive (tasklist).
#   3. DISTRO: /api/health is 200 probed FROM INSIDE the WSL distro
#      (wsl -d <distro> --exec curl 127.0.0.1:<port>) — the AUTHORITATIVE operator
#      liveness signal. The outer Windows→WSL HTTP forward flakes (WI-3270); an
#      outer-probe failure must NEVER be read as operator death. This primitive
#      probes the inner path, and reports an inner-healthy/outer-failing split as
#      a NON-FATAL `forward-degraded` diagnostic (mirrors the main.rs fix:
#      effective reachable = inner || outer; repair the forward, don't kill).
#
# Verification standard (D-007, VMs unavailable + the Windows VM must NOT be
# touched — EI-9022 is gated on another session clearing 0.0.7): this script is
# `bash -n`-clean and exercised against a MOCK ssh/wsl responder covering every
# branch. It performs NO live VM run here.
#
# Usage:
#   vm-preflight.sh [options]
# Options:
#   --ssh-key PATH        (default $HOME/.ssh/papercup-vm-win)
#   --ssh-port PORT       (default 2223)
#   --ssh-host USER@HOST  (default user@127.0.0.1)
#   --distro NAME         (default papercup-runtime)
#   --app-image NAME      Windows image name for tasklist (default papercusp-desktop.exe)
#   --host-vm-pattern PAT pgrep -f pattern for the VM process on the host
#                         (default 'qemu.*(windows|win-|papercup-vm-win)')
#   --monitor-socket PATH host-side QEMU HMP monitor socket used for a
#                         screendump when SSH is unavailable
#                         (default /mnt/data/offload/windows-vm/qemu-monitor.sock)
#   --screendump-dir DIR  directory for diagnostic PPM/PNG artifacts
#                         (default ${TMPDIR:-/tmp})
#   --disk-path PATH      host-side qcow2 image whose filesystem must retain
#                         headroom (default /mnt/data/offload/windows-vm/windows_hdd.qcow2)
#   --min-host-free-gb GB fail when the disk filesystem has less than this
#                         much free space (default 10)
#   --skip-host-pgrep     skip check 1 (e.g. VM launched outside this host's pgrep view)
#   --json                emit a machine-readable verdict to stdout
# Exit: 0 = operator genuinely healthy (forward-degraded still exits 0) ·
#       1 = a check failed (operator not verifiably healthy) · 2 = usage/setup.
set -uo pipefail

SSH_KEY="${VM_SSH_KEY:-$HOME/.ssh/papercup-vm-win}"
SSH_PORT="${VM_SSH_PORT:-2223}"
SSH_HOST="${VM_SSH_HOST:-user@127.0.0.1}"
DISTRO="${DISTRO:-papercup-runtime}"
APP_IMAGE="papercusp-desktop.exe"
# hv_synic: the win VM's qemu process carries NO -name — only its Hyper-V
# enlightenment flags (hv_*) identify it, so name-only patterns miss it and the
# recipe form (which can't pass --host-vm-pattern) failed WI-3270 preflight
# (live-diagnosed on the 0.0.8 windows verify, 2026-07-11).
HOST_VM_PATTERN='qemu.*(windows|win-|papercup-vm-win|hv_synic)'
MONITOR_SOCKET="${VM_MONITOR_SOCKET:-/mnt/data/offload/windows-vm/qemu-monitor.sock}"
SCREEN_DUMP_DIR="${VM_SCREENDUMP_DIR:-${TMPDIR:-/tmp}}"
DISK_PATH="${VM_DISK_PATH:-/mnt/data/offload/windows-vm/windows_hdd.qcow2}"
MIN_HOST_FREE_GB="${VM_MIN_HOST_FREE_GB:-10}"
SKIP_HOST_PGREP=0
JSON=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ssh-key) SSH_KEY="${2:-}"; shift 2 ;;
    --ssh-port) SSH_PORT="${2:-}"; shift 2 ;;
    --ssh-host) SSH_HOST="${2:-}"; shift 2 ;;
    --distro) DISTRO="${2:-}"; shift 2 ;;
    --app-image) APP_IMAGE="${2:-}"; shift 2 ;;
    --host-vm-pattern) HOST_VM_PATTERN="${2:-}"; shift 2 ;;
    --monitor-socket) MONITOR_SOCKET="${2:-}"; shift 2 ;;
    --screendump-dir) SCREEN_DUMP_DIR="${2:-}"; shift 2 ;;
    --disk-path) DISK_PATH="${2:-}"; shift 2 ;;
    --min-host-free-gb) MIN_HOST_FREE_GB="${2:-}"; shift 2 ;;
    --skip-host-pgrep) SKIP_HOST_PGREP=1; shift ;;
    --json) JSON=1; shift ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if ! [[ "$MIN_HOST_FREE_GB" =~ ^[0-9]+$ ]]; then
  echo "invalid --min-host-free-gb value: '$MIN_HOST_FREE_GB' (expected a non-negative integer)" >&2
  exit 2
fi

# The ssh binary is overridable (PC_SSH) so the check can be mock-driven without
# a live VM — the D-007 acceptance path while the Windows VM is untouchable.
SSH_BIN="${PC_SSH:-ssh}"
SSH=("$SSH_BIN" -i "$SSH_KEY" -p "$SSH_PORT" -o IdentitiesOnly=yes -o ConnectTimeout=10 -o BatchMode=yes "$SSH_HOST")
SOCAT_BIN="${PC_SOCAT:-socat}"
DF_BIN="${PC_DF:-df}"
CONVERT_BIN="${PC_CONVERT:-convert}"
PNMTOPNG_BIN="${PC_PNMTOPNG:-pnmtopng}"
wsl_exec() { timeout 60 "${SSH[@]}" "wsl -d $DISTRO --user papercup --exec $*" 2>/dev/null | tr -d '\r\0'; }

FAILURES=()
NOTES=()
fail_check() { FAILURES+=("$1"); }
note() { NOTES+=("$1"); }

# A hostfwd LISTEN socket is deliberately not a VM-health signal here. QEMU's
# user-mode network stack owns that bind and can accept TCP while the guest is
# bluescreened; SSH/banner or the inner /api/health probe must provide guest
# evidence instead.

guest_screen_status="not-attempted"
guest_screen_ppm=""
guest_screen_png=""
guest_screen_error=""

host_disk_exists=false
host_free_gb=""
qemu_status="not-attempted"
qemu_io_status="not-attempted"

query_hmp() {
  local command="$1"
  [[ -S "$MONITOR_SOCKET" ]] || return 2
  command -v timeout >/dev/null 2>&1 || return 3
  command -v "$SOCAT_BIN" >/dev/null 2>&1 || return 4
  printf '%s\n' "$command" |
    timeout 10 "$SOCAT_BIN" - "UNIX-CONNECT:$MONITOR_SOCKET" 2>/dev/null |
    tr -d '\r\0'
}

query_qemu_state() {
  local status_output block_output parsed_io

  if [[ ! -S "$MONITOR_SOCKET" ]]; then
    qemu_status="unavailable"
    qemu_io_status="unavailable"
    note "QEMU status unavailable: monitor socket not found at $MONITOR_SOCKET"
    return 0
  fi

  status_output="$(query_hmp 'info status')"
  if [[ -z "$status_output" ]]; then
    qemu_status="unavailable"
    note "QEMU status unavailable: info status returned no evidence via $MONITOR_SOCKET"
  elif printf '%s\n' "$status_output" | grep -qiE 'VM status:[[:space:]]*paused[[:space:]]*\(io-error\)'; then
    qemu_status="paused-io-error"
    fail_check "qemu: VM is paused (io-error); inspect host free space and qcow2 I/O before attempting recovery"
  elif printf '%s\n' "$status_output" | grep -qiE 'VM status:[[:space:]]*paused'; then
    qemu_status="paused"
    fail_check "qemu: VM is paused; inspect QEMU status and host storage before attempting recovery"
  elif printf '%s\n' "$status_output" | grep -qiE 'VM status:[[:space:]]*running'; then
    qemu_status="running"
  else
    qemu_status="unknown"
    note "QEMU status unrecognized via $MONITOR_SOCKET: $(printf '%s' "$status_output" | tr '\n' ' ' | cut -c1-160)"
  fi

  block_output="$(query_hmp 'info block')"
  if [[ -z "$block_output" ]]; then
    qemu_io_status="unavailable"
    note "QEMU block I/O status unavailable: info block returned no evidence via $MONITOR_SOCKET"
    return 0
  fi

  parsed_io="$(printf '%s\n' "$block_output" |
    sed -nE 's/.*([Ii]\/([Oo])[[:space:]]+status|[Ii][Oo]-status):[[:space:]]*([^[:space:]]+).*/\3/p' |
    head -1 | tr '[:upper:]' '[:lower:]')"
  qemu_io_status="${parsed_io:-unknown}"
  if [[ "$qemu_io_status" =~ ^(nospace|failed|error|fault)$ ]]; then
    fail_check "qemu: disk I/O status is '$qemu_io_status' — host storage may be out of space or unavailable"
  elif [[ "$qemu_io_status" == "unknown" ]]; then
    note "QEMU block I/O status unrecognized via $MONITOR_SOCKET"
  fi
}

measure_host_storage() {
  if [[ ! -e "$DISK_PATH" ]]; then
    note "host disk image not found at $DISK_PATH; host filesystem free space not measured"
    return 0
  fi
  host_disk_exists=true
  host_free_gb="$("$DF_BIN" -Pk "$DISK_PATH" 2>/dev/null |
    awk 'NR==2 {print int($4/1024/1024)}')"
  if ! [[ "$host_free_gb" =~ ^[0-9]+$ ]]; then
    host_free_gb=""
    note "host filesystem free space could not be measured for $DISK_PATH"
    return 0
  fi
  if (( host_free_gb < MIN_HOST_FREE_GB )); then
    fail_check "host: filesystem for $DISK_PATH has only ${host_free_gb}GB free (minimum ${MIN_HOST_FREE_GB}GB); low space can pause QEMU with io-error"
  fi
}

capture_guest_screen() {
  guest_screen_status="unavailable"

  if [[ ! -S "$MONITOR_SOCKET" ]]; then
    guest_screen_error="monitor socket not found at $MONITOR_SOCKET"
    note "guest-state diagnosis unavailable: $guest_screen_error"
    return 0
  fi
  if ! command -v timeout >/dev/null 2>&1; then
    guest_screen_error="timeout command is unavailable"
    note "guest-state diagnosis unavailable: $guest_screen_error"
    return 0
  fi
  if ! command -v "$SOCAT_BIN" >/dev/null 2>&1; then
    guest_screen_error="socat command is unavailable (needed for HMP monitor $MONITOR_SOCKET)"
    note "guest-state diagnosis unavailable: $guest_screen_error"
    return 0
  fi
  if [[ ! -d "$SCREEN_DUMP_DIR" || ! -w "$SCREEN_DUMP_DIR" ]]; then
    guest_screen_error="screendump directory is not writable: $SCREEN_DUMP_DIR"
    note "guest-state diagnosis unavailable: $guest_screen_error"
    return 0
  fi

  local ppm png monitor_rc
  ppm="$(mktemp "$SCREEN_DUMP_DIR/vm-preflight-screen-XXXXXX.ppm" 2>/dev/null)" || {
    guest_screen_error="could not allocate a screendump artifact in $SCREEN_DUMP_DIR"
    note "guest-state diagnosis unavailable: $guest_screen_error"
    return 0
  }
  png="${ppm%.ppm}.png"
  monitor_rc=0

  # The HMP monitor keeps its UNIX connection open on some QEMU builds. The
  # artifact, not socat's eventual EOF/timeout status, is therefore authoritative.
  printf 'screendump %s\n' "$ppm" |
    timeout 15 "$SOCAT_BIN" - "UNIX-CONNECT:$MONITOR_SOCKET" >/dev/null 2>&1 || monitor_rc=$?

  if [[ ! -s "$ppm" ]]; then
    rm -f "$ppm"
    guest_screen_error="monitor screendump failed (rc=$monitor_rc) via $MONITOR_SOCKET"
    note "guest-state diagnosis unavailable: $guest_screen_error"
    return 0
  fi

  if command -v "$CONVERT_BIN" >/dev/null 2>&1 &&
    "$CONVERT_BIN" "$ppm" "$png" >/dev/null 2>&1 && [[ -s "$png" ]]; then
    guest_screen_status="captured"
    guest_screen_ppm="$ppm"
    guest_screen_png="$png"
    note "guest-state screen captured at $png; inspect it for BSOD, boot, login, or a hung display"
    return 0
  fi
  if command -v "$PNMTOPNG_BIN" >/dev/null 2>&1 &&
    "$PNMTOPNG_BIN" "$ppm" >"$png" 2>/dev/null && [[ -s "$png" ]]; then
    guest_screen_status="captured"
    guest_screen_ppm="$ppm"
    guest_screen_png="$png"
    note "guest-state screen captured at $png; inspect it for BSOD, boot, login, or a hung display"
    return 0
  fi

  guest_screen_status="captured-ppm"
  guest_screen_ppm="$ppm"
  guest_screen_error="captured $ppm but no usable PNG converter is available"
  note "guest-state screen captured at $ppm, but PNG conversion failed; install ImageMagick convert or pnmtopng"
}

host_pgrep_ok=null
ssh_ok=null
app_ok=null
port=""
inner_code=""
outer_code=""
inner_ok=null
forward_degraded=false

# ── 0. HOST STORAGE + QEMU: detect the condition behind a paused qcow2 ───────
# These checks are read-only. In particular, do not send `cont`, `quit`, or any
# other mutating HMP command from a health preflight; recovery is a separate,
# explicitly supervised operation.
measure_host_storage
query_qemu_state

# ── 1. HOST: VM process running ─────────────────────────────────────────────
if [[ "$SKIP_HOST_PGREP" == "1" ]]; then
  host_pgrep_ok=skipped
  note "host VM-process pgrep skipped (--skip-host-pgrep)"
else
  # Exclude our own process tree so a pattern that happens to appear in this
  # script's argv (e.g. passed via --host-vm-pattern) cannot self-satisfy the check.
  if pgrep -f "$HOST_VM_PATTERN" 2>/dev/null | grep -vxF -e "$$" -e "$PPID" | grep -q .; then
    host_pgrep_ok=true
  else
    host_pgrep_ok=false
    fail_check "host: no VM process matches /$HOST_VM_PATTERN/ (VM not booted?) — override with --host-vm-pattern or --skip-host-pgrep"
  fi
fi

# ── 2. VM: ssh reachable + app process alive ────────────────────────────────
if [[ "$host_pgrep_ok" == "false" ]]; then
  note "skipping VM/distro checks — host VM process not found"
else
  if "${SSH[@]}" 'cmd /c echo VM-OK' 2>/dev/null | tr -d '\r' | grep -q 'VM-OK'; then
    ssh_ok=true
    # app process (tasklist)
    if "${SSH[@]}" "tasklist /FI \"IMAGENAME eq $APP_IMAGE\" /FO csv /NH" 2>/dev/null | grep -q "$APP_IMAGE"; then
      app_ok=true
    else
      app_ok=false
      fail_check "vm: app process $APP_IMAGE not running (tasklist)"
    fi
    # ── serve discovery: operator.json + port (distro-side) ──
    opjson="$(wsl_exec cat /home/papercup/.papercusp/operator.json)"
    port="$(printf '%s' "$opjson" | grep -o '"port"[[:space:]]*:[[:space:]]*[0-9]*' | grep -o '[0-9]*' | head -1)"
    if [[ -z "$port" ]]; then
      fail_check "distro: no operator.json / port inside $DISTRO (operator not started?)"
    fi
  else
    ssh_ok=false
    capture_guest_screen
    if [[ "$guest_screen_status" == "captured" ]]; then
      fail_check "vm: ssh unreachable on :$SSH_PORT ($SSH_HOST); guest screen captured at $guest_screen_png (inspect for BSOD/boot/hang)"
    elif [[ "$guest_screen_status" == "captured-ppm" ]]; then
      fail_check "vm: ssh unreachable on :$SSH_PORT ($SSH_HOST); guest screen captured at $guest_screen_ppm but PNG conversion failed"
    else
      fail_check "vm: ssh unreachable on :$SSH_PORT ($SSH_HOST); guest-state monitor diagnosis unavailable: $guest_screen_error"
    fi
  fi
fi

# ── 3. DISTRO: /api/health probed INSIDE the distro (WI-3270 authoritative) ──
if [[ -n "$port" ]]; then
  # Probe curl DIRECTLY (space-free args survive wsl_exec's $* flattening; a
  # `bash -c "quoted script"` would NOT). Mirrors the main.rs WI-3270 fix, which
  # runs `wsl --exec curl` in the distro. Output-based (not exit-code, which is
  # unreliable through ssh→cmd→wsl): a healthy 200 returns the /api/health JSON
  # body ({"sha":..,"version":..}); anything else is unhealthy/down.
  inner_out="$(wsl_exec curl -sS -m 5 http://127.0.0.1:$port/api/health)"
  if printf '%s' "$inner_out" | grep -qE '"sha"|"version"'; then
    inner_ok=true
    inner_code=200
  else
    inner_ok=false
    inner_code="err"
    fail_check "distro: /api/health did not return a healthy body probed INSIDE $DISTRO — operator genuinely unhealthy/down (NOT a forward flake)"
  fi

  # Outer Windows→WSL forward probe — DIAGNOSTIC ONLY. A failure here with a
  # healthy inner probe is `forward-degraded`, never operator death (WI-3270).
  outer_code="$("${SSH[@]}" "powershell -NoProfile -Command \"\$ProgressPreference = 'SilentlyContinue'; try { (Invoke-WebRequest -Uri http://127.0.0.1:$port/api/health -UseBasicParsing -TimeoutSec 10).StatusCode } catch { 0 }\"" 2>/dev/null | tr -d '\r[:space:]')"
  if [[ "$inner_ok" == "true" && "$outer_code" != "200" ]]; then
    forward_degraded=true
    note "forward-degraded: inner /api/health is 200 but the outer Windows→WSL probe returned '$outer_code' — REPAIR THE FORWARD, do NOT kill the operator (WI-3270)"
  fi
fi

ok=$([[ ${#FAILURES[@]} -eq 0 ]] && echo true || echo false)

if [[ "$JSON" == "1" ]]; then
  # Emit a compact JSON verdict (hand-built to avoid a python dep on the VM host path).
  printf '{\n'
  printf '  "ok": %s,\n' "$ok"
  printf '  "hostPgrep": "%s",\n' "$host_pgrep_ok"
  printf '  "ssh": "%s",\n' "$ssh_ok"
  printf '  "appProcess": "%s",\n' "$app_ok"
  printf '  "operatorPort": "%s",\n' "$port"
  printf '  "diskPath": %s,\n' "$(printf '%s' "$DISK_PATH" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))' 2>/dev/null || printf '"%s"' "${DISK_PATH//\"/\\\"}")"
  printf '  "hostDiskExists": %s,\n' "$host_disk_exists"
  if [[ -n "$host_free_gb" ]]; then printf '  "hostFreeGb": %s,\n' "$host_free_gb"; else printf '  "hostFreeGb": null,\n'; fi
  printf '  "minHostFreeGb": %s,\n' "$MIN_HOST_FREE_GB"
  printf '  "qemuStatus": "%s",\n' "$qemu_status"
  printf '  "qemuIoStatus": "%s",\n' "$qemu_io_status"
  printf '  "innerHealthCode": "%s",\n' "$inner_code"
  printf '  "innerHealthy": "%s",\n' "$inner_ok"
  printf '  "outerHealthCode": "%s",\n' "$outer_code"
  printf '  "monitorSocket": %s,\n' "$(printf '%s' "$MONITOR_SOCKET" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))' 2>/dev/null || printf '"%s"' "${MONITOR_SOCKET//\"/\\\"}")"
  printf '  "guestScreenStatus": "%s",\n' "$guest_screen_status"
  printf '  "guestScreenPpm": %s,\n' "$(printf '%s' "$guest_screen_ppm" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))' 2>/dev/null || printf '"%s"' "${guest_screen_ppm//\"/\\\"}")"
  printf '  "guestScreenPng": %s,\n' "$(printf '%s' "$guest_screen_png" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))' 2>/dev/null || printf '"%s"' "${guest_screen_png//\"/\\\"}")"
  printf '  "forwardDegraded": %s,\n' "$forward_degraded"
  printf '  "failures": ['
  for i in "${!FAILURES[@]}"; do [[ $i -gt 0 ]] && printf ', '; printf '%s' "$(printf '%s' "${FAILURES[$i]}" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))' 2>/dev/null || printf '"%s"' "${FAILURES[$i]}")"; done
  printf '],\n'
  printf '  "notes": ['
  for i in "${!NOTES[@]}"; do [[ $i -gt 0 ]] && printf ', '; printf '%s' "$(printf '%s' "${NOTES[$i]}" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))' 2>/dev/null || printf '"%s"' "${NOTES[$i]}")"; done
  printf ']\n}\n'
else
  echo "vm-preflight: $([[ "$ok" == "true" ]] && echo PASS || echo FAIL)  distro=$DISTRO port=${port:-<none>}"
  echo "  host VM process: $host_pgrep_ok"
  echo "  vm ssh: $ssh_ok   app process ($APP_IMAGE): $app_ok"
  echo "  host disk: $DISK_PATH free=${host_free_gb:-<unmeasured>}GB (minimum ${MIN_HOST_FREE_GB}GB)"
  echo "  QEMU: status=$qemu_status io-status=$qemu_io_status"
  echo "  operator /api/health INSIDE distro: code=${inner_code:-<none>} healthy=$inner_ok"
  echo "  operator /api/health OUTER forward: code=${outer_code:-<none>} forwardDegraded=$forward_degraded"
  for n in "${NOTES[@]:-}"; do [[ -n "$n" ]] && echo "  note: $n"; done
  for f in "${FAILURES[@]:-}"; do [[ -n "$f" ]] && echo "  FAIL: $f"; done
fi

[[ "$ok" == "true" ]] && exit 0 || exit 1
