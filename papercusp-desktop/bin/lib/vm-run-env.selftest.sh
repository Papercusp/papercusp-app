#!/usr/bin/env bash
# vm-run-env.selftest.sh — regression test for WI-6176: vm_run() must deliver
# guest environment passed as VAR=VALUE ARGUMENTS, and callers must never use
# the shell-PREFIX form.
#
# THE BUG THIS GUARDS (silent, and green-looking in both directions):
#   vm_run is `ssh … 'bash -s'` with the script on stdin. It forwards NO
#   environment — _ssh_opts sets no SendEnv/SetEnv. So the natural-looking
#
#       WIPE=0 vm_run "$name" <<'EOF'   …   if [ "${WIPE:-1}" = 1 ]; then rm -rf …
#
#   set WIPE only in the LOCAL ssh process; the guest saw it UNSET and took the
#   ${WIPE:-1} wipe branch EVERY time. That made vm-federation.sh's ensure_booted
#   "relaunch with wipe=0 to PRESERVE the initialised data dir" retry completely
#   inert — every attempt re-ran a fresh ~20-30s initdb, lost the same
#   embedded-PG-vs-sidecar boot race, and the driver exited BOOT_TIMEOUT. The
#   guest ALSO logged `launched (wipe=1)` while the local header said `wipe=0`,
#   so the log actively asserted the opposite of what happened.
#
# Sources the REAL scripts/linux-test-vm/lib/common.sh (the shipping code, not a
# copy) and stubs `ssh` to run `bash -s` LOCALLY, so the "guest" side is a real
# shell reading the real stream vm_run produces — no VM, no SSH, no network, <1s.
#
#   bash bin/lib/vm-run-env.selftest.sh   # exit 0 = PASS, 1 = FAIL
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Fixture seams — default to the SHIPPING code. They exist so this guard's own
# non-vacuity can be demonstrated against a deliberately-broken COPY in /tmp
# (point them at a fixture and every assertion below must go RED), without ever
# reintroducing the bug into the shared tree to "prove the test works".
LIB="${VM_RUN_SELFTEST_LIB:-$DIR/../../scripts/linux-test-vm/lib/common.sh}"
SCAN_ROOT="${VM_RUN_SELFTEST_ROOT:-}"
DRIVER="$DIR/../vm-federation.sh"
[ -f "$LIB" ] || { echo "SKIP: common.sh not found at $LIB"; exit 0; }

FAILS=0
ok()  { echo "  ✓ $*"; }
bad() { echo "  ✗ $*"; FAILS=$((FAILS + 1)); }

# shellcheck disable=SC1090
source "$LIB" >/dev/null 2>&1 || true
set +e   # common.sh sets -e; a failing assertion must not abort the run

# ── the "guest": a real local shell fed by the real vm_run stream ────────────
# vm_run pipes { env-prefix; script } into `ssh … 'bash -s'`. Stubbing ssh with
# `bash -s` makes that pipeline execute locally under a shell that, exactly like
# the guest, inherits NOTHING from vm_run's own process environment except what
# vm_run actually wrote into the stream. env -i enforces that: if the value ever
# arrived via process env rather than the stream, these tests would go green for
# the wrong reason and re-admit the bug.
ssh() { env -i /usr/bin/env bash -s; }

echo "=== vm_run env delivery (WI-6176) ==="

out="$(vm_run fed-a "WIPE=0" <<'EOF'
echo "WIPE=${WIPE:-UNSET}"
if [ "${WIPE:-1}" = 1 ]; then echo "BRANCH=wipe"; else echo "BRANCH=preserve"; fi
EOF
)"
grep -q '^WIPE=0$'        <<<"$out" && ok "VAR=VALUE argument reaches the guest" \
                                    || bad "guest did not see WIPE=0 (got: $out)"
grep -q '^BRANCH=preserve$' <<<"$out" && ok "guest takes the PRESERVE branch (the ensure_booted contract)" \
                                    || bad "guest took the wipe branch despite WIPE=0 (got: $out)"

out="$(vm_run fed-a "WIPE=1" <<'EOF'
if [ "${WIPE:-1}" = 1 ]; then echo "BRANCH=wipe"; else echo "BRANCH=preserve"; fi
EOF
)"
grep -q '^BRANCH=wipe$' <<<"$out" && ok "WIPE=1 still selects the wipe branch" \
                                  || bad "WIPE=1 did not select the wipe branch (got: $out)"

echo "=== back-compat: callers passing no env args ==="
out="$(vm_run fed-a <<'EOF'
echo "WIPE=${WIPE:-UNSET}"
echo "RAN=yes"
EOF
)"
grep -q '^RAN=yes$'    <<<"$out" && ok "a plain vm_run (no env args) still runs its script" \
                                 || bad "plain vm_run broke (got: $out)"
grep -q '^WIPE=UNSET$' <<<"$out" && ok "no env args ⇒ nothing injected" \
                                 || bad "unexpected variable leaked into the guest (got: $out)"

echo "=== values are delivered VERBATIM (no expansion, no injection) ==="
out="$(vm_run fed-a 'MSG=hello world'"'"'s $PATH `id`' <<'EOF'
echo "MSG=[${MSG:-UNSET}]"
EOF
)"
if grep -qF 'MSG=[hello world'"'"'s $PATH `id`]' <<<"$out"; then
  ok "spaces, quotes, \$PATH and backticks survive verbatim (%q-quoted, not evaluated)"
else
  bad "value was mangled or evaluated in the guest (got: $out)"
fi

echo "=== multiple env args ==="
out="$(vm_run fed-a "A=1" "B=two" <<'EOF'
echo "A=${A:-UNSET} B=${B:-UNSET}"
EOF
)"
grep -q '^A=1 B=two$' <<<"$out" && ok "multiple VAR=VALUE args all arrive" \
                                || bad "multiple env args not delivered (got: $out)"

echo "=== a malformed arg is reported, not silently swallowed ==="
err="$(vm_run fed-a "not-an-assignment" <<'EOF' 2>&1 >/dev/null
:
EOF
)"
grep -q 'expected VAR=VALUE' <<<"$err" && ok "non-assignment argument warns on stderr" \
                                       || bad "malformed arg was swallowed silently (stderr: $err)"

# ── the class guard: the broken PREFIX form must never come back ─────────────
# This is the assertion that actually prevents recurrence. The prefix form is
# syntactically valid, runs clean, and fails silently — only a static check can
# catch its reintroduction.
echo "=== static guard: no caller uses the silent \`VAR=… vm_run\` prefix form ==="
if [ -n "$SCAN_ROOT" ] || [ -f "$DRIVER" ]; then
  if [ -n "$SCAN_ROOT" ]; then
    scan_paths=("$SCAN_ROOT")
  else
    ROOT="$(cd "$DIR/../.." && pwd)"
    scan_paths=("$ROOT/bin" "$ROOT/scripts")
  fi
  hits="$(grep -rnE '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+vm_run\b' \
            --include='*.sh' "${scan_paths[@]}" 2>/dev/null \
          | grep -v 'selftest' || true)"
  if [ -z "$hits" ]; then
    ok "no VAR=… vm_run prefix callers (env must be passed as arguments)"
  else
    bad "prefix-form caller(s) found — the guest will NOT see these variables:"
    printf '      %s\n' "$hits"
  fi
else
  echo "  … driver not found; skipping static guard"
fi

echo
if [ "$FAILS" -gt 0 ]; then echo "FAIL — $FAILS assertion(s) failed"; exit 1; fi
echo "PASS — vm_run env delivery is correct and the prefix form is absent"
