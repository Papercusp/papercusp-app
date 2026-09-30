#!/usr/bin/env bash
# Windows-VM smoke for the installed Papercusp desktop app — the per-release
# gate (P-017 @ windows-desktop-release-readiness-2026-06-11). Run from the
# HOST with the VM booted (~/windows-vm/boot-windows.sh) and the app
# installed + launched (schtasks /run /tn papercusp-e2e).
#
# Checks, in dependency order:
#   1. VM reachable over ssh
#   2. papercup-runtime distro registered
#   3. app process alive
#   4. serve discovery file present (distro-side operator.json) + port
#   5. operator /api/health 200 (probed from inside the VM)
#   6. /api/backups 200 AND kopia detection ok (regression guard: the
#      WSLENV PATH/l clobber broke every distro-binary spawn — insight
#      windows-vm-desktop-testing-workflow §10)
#   7. agent-tools HTTP surface answers from true loopback (superuser
#      bearer; Windows→WSL traffic is NOT loopback — §"sharp edges")
#   8. zero PG ERROR lines in the boot log (fresh-DB schema gaps etc.)
#   9. psu superuser CLI installed: the ~/.papercusp/bin/psu shim is present +
#      executable and points at a real bundled launcher (psu-in-desktop-builds
#      A1/A2). A live `psu --agent=claude` would block on the interactive CLI,
#      so this verifies the bundle+shim are in place, not a full agent launch.
#
# EI-18099988193062000: the release default is `PAPERCUSP_BUILD_ROLES="gui
# server"` (WI-5600) — a real per-release cut ships the Server app that owns
# the operator sidecar, so checks 4-9 (which all assume a healthy operator)
# are expected to pass on it. They can NEVER pass against a deliberate
# `PAPERCUSP_BUILD_ROLES=gui` fast-iteration cut (the GUI alone has no
# sidecar to attach to on Windows) — that is a misuse of this gate, not a
# gate bug. Pass VM_SMOKE_GUI_ONLY=1 to explicitly opt into skipping the
# operator-dependent checks when you know you installed a gui-only cut.
#
# Exit 0 = all green; first failure exits 1 with the failing check named.

set -uo pipefail

VM_SSH_KEY="${VM_SSH_KEY:-$HOME/.ssh/papercup-vm-win}"
VM_SSH_PORT="${VM_SSH_PORT:-2223}"
VM_SSH_HOST="${VM_SSH_HOST:-user@127.0.0.1}"
DISTRO="${DISTRO:-papercup-runtime}"
SSH=(ssh -i "$VM_SSH_KEY" -p "$VM_SSH_PORT" -o ConnectTimeout=10 "$VM_SSH_HOST")
VM_SMOKE_GUI_ONLY="${VM_SMOKE_GUI_ONLY:-0}"

pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1" >&2; exit 1; }
skip() { echo "  ⊘ $1 (VM_SMOKE_GUI_ONLY=1 — operator owned by the out-of-scope Server, WI-5028)"; }

wsl_exec() { timeout 60 "${SSH[@]}" "wsl -d $DISTRO --user papercup --exec $*" 2>/dev/null | tr -d '\r\0'; }

echo "==> 1. VM ssh"
"${SSH[@]}" 'cmd /c echo VM-OK' >/dev/null 2>&1 || fail "VM unreachable on :$VM_SSH_PORT"
pass "ssh ok"

echo "==> 2. distro registered"
"${SSH[@]}" 'wsl -l -v' 2>/dev/null | tr -d '\r\0' | grep -q "$DISTRO" || fail "distro $DISTRO not registered"
pass "$DISTRO registered"

echo "==> 3. app process"
"${SSH[@]}" 'tasklist /FI "IMAGENAME eq papercusp-desktop.exe" /FO csv /NH' 2>/dev/null \
  | grep -q papercusp-desktop || fail "papercusp-desktop.exe not running"
pass "app running"

if [[ "$VM_SMOKE_GUI_ONLY" == "1" ]]; then
  for n in 4 5 6 7 8 9; do skip "check $n"; done
  echo "GUI-ONLY SMOKE: checks 1-3 green, 4-9 skipped by explicit opt-in (not a release blocker)"
  exit 0
fi

echo "==> 4. serve discovery"
OPJSON="$(wsl_exec cat /home/papercup/.papercusp/operator.json)"
PORT="$(echo "$OPJSON" | grep -o '"port": *[0-9]*' | grep -o '[0-9]*' | head -1)"
[[ -n "$PORT" ]] || fail "no operator.json / port in the distro"
pass "operator.json names port $PORT"

echo "==> 5. operator health"
CODE="$("${SSH[@]}" "powershell -NoProfile -Command \"\$ProgressPreference = 'SilentlyContinue'; try { (Invoke-WebRequest -Uri http://127.0.0.1:$PORT/api/health -UseBasicParsing -TimeoutSec 15).StatusCode } catch { 0 }\"" 2>/dev/null | tr -d '\r[:space:]')"
[[ "$CODE" == "200" ]] || fail "/api/health returned '$CODE'"
pass "health 200"

echo "==> 6. backups + kopia detection"
BK="$("${SSH[@]}" "powershell -NoProfile -Command \"\$ProgressPreference = 'SilentlyContinue'; (Invoke-WebRequest -Uri http://127.0.0.1:$PORT/api/backups -UseBasicParsing -TimeoutSec 20).Content\"" 2>/dev/null | tr -d '\r')"
echo "$BK" | grep -q '"settings"' || fail "/api/backups gave no settings"
echo "$BK" | grep -q '"kopia":{"ok":true' || fail "kopia detection not ok: $(echo "$BK" | grep -o '"kopia":{[^}]*}')"
pass "backups 200, kopia ok"

echo "==> 7. agent-tools surface (true loopback)"
# Quoting does NOT survive ssh→cmd→wsl; ship a probe file and run it via the
# distro's /mnt/c automount (the \\wsl.localhost UNC is flaky from a
# non-interactive ssh session — insight windows-vm-desktop-testing-workflow).
PROBE="$(mktemp /tmp/papercusp-vm-probe-XXXX.sh)"
cat > "$PROBE" <<PROBEEOF
#!/usr/bin/env bash
tok=\$(cat /home/papercup/.papercusp/superuser-token)
curl -s -m 20 -X POST -H "Authorization: Bearer \$tok" -H "Content-Type: application/json" \
  -d '{}' "http://127.0.0.1:$PORT/api/agent-tools/papercusp/list_workspaces"
PROBEEOF
scp -q -i "$VM_SSH_KEY" -P "$VM_SSH_PORT" "$PROBE" "$VM_SSH_HOST":'C:/Users/user/papercusp-smoke-probe.sh'
rm -f "$PROBE"
AT="$(wsl_exec bash /mnt/c/Users/user/papercusp-smoke-probe.sh)"
# The tool result arrives as an MCP content envelope with ESCAPED inner JSON.
echo "$AT" | grep -q 'workspaces' || fail "agent-tools list_workspaces failed: ${AT:0:160}"
pass "agent-tools dispatch ok"

echo "==> 8. PG errors in boot log"
# Match REAL error shapes only: PG's "ERROR:  msg" log prefix and the node-pg
# error object's severity field. A bare ERROR substring false-positives on
# DropErrorMsgNonExistent notices, *-error-code.sql migration names, errors=0.
NERR="$("${SSH[@]}" 'powershell -NoProfile -Command "((Get-Content C:\Users\user\papercusp-bk.log -ErrorAction SilentlyContinue) -match \"ERROR:  |severity: .ERROR.\" | Measure-Object).Count"' 2>/dev/null | tr -d '\r[:space:]')"
[[ "${NERR:-0}" == "0" ]] || fail "$NERR real ERROR line(s) in papercusp-bk.log — read them before shipping"
pass "0 real ERROR lines"

echo "==> 9. psu superuser CLI installed (psu-in-desktop-builds A1/A2)"
# Ship a probe file (same reason as check 7 — quoting does not survive
# ssh→cmd→wsl). Verifies installPapercuspFiles wrote the shim on boot (A2) AND
# that it points at a real, non-empty bundled launcher (A1). Non-interactive:
# does NOT exec the agent CLI (that would hang the smoke).
PSUPROBE="$(mktemp /tmp/papercusp-vm-psuprobe-XXXX.sh)"
cat > "$PSUPROBE" <<'PSUEOF'
#!/usr/bin/env bash
shim=/home/papercup/.papercusp/bin/psu
[[ -x "$shim" ]] || { echo "PSU_FAIL: shim missing or not executable at $shim"; exit 1; }
# The shim execs the bundled launcher: newer form `exec "<abs-node>" "<abs-psu.mjs>"`,
# older form `exec node "<launcher>"`. Extract the bundled launcher (.mjs/.js) and
# verify it is a real non-empty file — robust to both forms (2026-07-02 parity fix:
# the old `exec node "…"` regex false-failed on the abs-node shim while psu was fine).
launcher=$(grep -oE '"[^"]+\.(mjs|js)"' "$shim" | tail -1 | tr -d '"')
[[ -n "$launcher" && -s "$launcher" ]] || { echo "PSU_FAIL: bundled launcher missing/empty: '$launcher'"; exit 1; }
echo "PSU_OK $launcher"
PSUEOF
scp -q -i "$VM_SSH_KEY" -P "$VM_SSH_PORT" "$PSUPROBE" "$VM_SSH_HOST":'C:/Users/user/papercusp-psu-probe.sh'
rm -f "$PSUPROBE"
PSUOUT="$(wsl_exec bash /mnt/c/Users/user/papercusp-psu-probe.sh)"
echo "$PSUOUT" | grep -q '^PSU_OK' || fail "psu CLI not installed: ${PSUOUT:0:200}"
pass "psu shim + bundled launcher present (${PSUOUT#PSU_OK })"

echo "ALL SMOKE CHECKS GREEN"
