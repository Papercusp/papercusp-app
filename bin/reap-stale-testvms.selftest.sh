#!/usr/bin/env bash
# reap-stale-testvms.selftest.sh — focused unit test for bin/reap-stale-testvms.sh
# (EI-18792610532592319). Pure, hermetic, ~5s — no real qemu boot, no vmctl call.
#
#   bash bin/reap-stale-testvms.selftest.sh     # exit 0 = PASS, 1 = FAIL
#
# Why a bash self-test and not Vitest: the unit under test is bash (a host-level
# process-scanning reaper). Mirrors federation-asserts.selftest.sh's posture for
# the same reason.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=reap-stale-testvms.sh
source "$DIR/reap-stale-testvms.sh"
set +e   # this self-test owns its own exit codes

FAILS=0
ok()  { echo "  ✓ $*"; }
bad() { echo "  ✗ $*"; FAILS=$((FAILS + 1)); }

PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill -9 "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

# ── 1. vm_name_from_cmdline: positive cases ─────────────────────────────────
echo "1. vm_name_from_cmdline parsing"

name="$(vm_name_from_cmdline 'qemu-system-x86_64 -name papercusp-testvm-fed-a -enable-kvm -m 16384')"
[ "$name" = "fed-a" ] && ok "extracts 'fed-a' from a real-shaped fed-a cmdline" \
  || bad "expected 'fed-a', got '$name'"

name="$(vm_name_from_cmdline 'qemu-system-x86_64 -name papercusp-testvm-clean -smp 8')"
[ "$name" = "clean" ] && ok "extracts 'clean' from a real-shaped clean-instance cmdline" \
  || bad "expected 'clean', got '$name'"

# ── 2. vm_name_from_cmdline: the mac/Windows persistent-VM shape must NEVER match ──
# These VMs are launched with NO -name flag at all (confirmed live 2026-08-03
# against the real running mac VM's /proc/<pid>/cmdline) — reproduce that shape
# verbatim so a future edit that accidentally starts matching a bare qemu
# invocation (or one with an unrelated -name) is caught here, not on the
# owner's persistent infra.
mac_shaped='qemu-system-x86_64 -enable-kvm -m 32768 -cpu Skylake-Client,-hle,-rtm,kvm=on -smp 8,cores=4,sockets=1 -machine q35,accel=kvm -netdev user,id=net0,hostfwd=tcp::2222-:22 -device virtio-net-pci,netdev=net0,id=net0'
vm_name_from_cmdline "$mac_shaped" >/dev/null 2>&1
if [ $? -ne 0 ]; then ok "mac-VM-shaped cmdline (no -name) never yields a candidate name"
else bad "mac-VM-shaped cmdline incorrectly yielded a candidate name — WOULD TARGET THE OWNER'S PERSISTENT VM"; fi

win_shaped='qemu-system-x86_64 -enable-kvm -machine q35,accel=kvm -cpu host,kvm=on -m 32768 -smp cores=16,threads=1,sockets=1 -netdev user,id=net0,hostfwd=tcp::2223-:22 -device e1000,netdev=net0,id=net0'
vm_name_from_cmdline "$win_shaped" >/dev/null 2>&1
if [ $? -ne 0 ]; then ok "Windows-VM-shaped cmdline (no -name) never yields a candidate name"
else bad "Windows-VM-shaped cmdline incorrectly yielded a candidate name — WOULD TARGET THE OWNER'S PERSISTENT VM"; fi

# A -name that ISN'T the papercusp-testvm- marker (e.g. some unrelated future
# qemu caller) must also never match.
other_shaped='qemu-system-x86_64 -name some-other-vm -enable-kvm'
vm_name_from_cmdline "$other_shaped" >/dev/null 2>&1
[ $? -ne 0 ] && ok "an unrelated -name (not papercusp-testvm-*) never yields a candidate" \
  || bad "unrelated -name incorrectly matched"

# ── 3. any_orchestrator_alive ────────────────────────────────────────────────
echo "2. any_orchestrator_alive detection"

if any_orchestrator_alive; then
  bad "any_orchestrator_alive() reported true with no orchestrator running — false positive"
else
  ok "reports false when no orchestrator script is running"
fi

# Spawn a fake process whose cmdline names one of the watched orchestrator
# scripts, via `exec -a` (sets what appears as argv[0]/cmdline — no real script
# needs to exist on disk for this).
exec -a /fake/path/vm-federation.sh bash -c 'trap "exit 0" TERM; while true; do sleep 1; done' &
fake_orch_pid=$!
PIDS+=("$fake_orch_pid")
# give /proc a moment to reflect the new process
for _ in 1 2 3 4 5; do [ -r "/proc/$fake_orch_pid/cmdline" ] && break; sleep 0.2; done

if any_orchestrator_alive >/tmp/reap-selftest-orch.$$ 2>&1; then
  ok "detects a live fake vm-federation.sh as an orchestrator"
else
  bad "failed to detect a live fake orchestrator (checked pid=$fake_orch_pid)"
fi
rm -f "/tmp/reap-selftest-orch.$$"

kill -TERM "$fake_orch_pid" 2>/dev/null; wait "$fake_orch_pid" 2>/dev/null
sleep 0.3
if any_orchestrator_alive; then
  bad "still reports an orchestrator alive after it was killed"
else
  ok "no longer detects the orchestrator once it's dead"
fi

# ── 3. self/inspection exclusion and end-to-end age gating ──────────────────
echo "3. end-to-end candidate/age gating (DRY_RUN, no real vmctl call)"

# A wrapper whose argv mentions an orchestrator is not evidence of an active
# run when it is an ancestor of this inspection.  This reproduces the
# `bash -c '<command containing vm-federation.sh>'` self-match shape.
ancestor_out="$(
  bash -c 'bash -c '\''source "$1"; any_orchestrator_alive'\'' inner "$1"' \
    outer "$DIR/reap-stale-testvms.sh" "vm-federation.sh" 2>&1
)"
if [ -z "$ancestor_out" ]; then
  ok "ancestor wrapper text is excluded from orchestrator detection"
else
  bad "ancestor wrapper text was treated as a live orchestrator: $ancestor_out"
fi

# The real boot path's argv[0] is qemu-system-x86_64.  A shell/census command
# may carry the VM marker and even a -name-looking argument, but it is not a VM.
is_qemu_testvm_cmdline 'qemu-system-x86_64 -name papercusp-testvm-fed-a -m 16384' \
  && ok "accepts a real QEMU test-VM command line" \
  || bad "rejected a real QEMU test-VM command line"
is_qemu_testvm_cmdline 'bash -c inspect census -name papercusp-testvm-inspection-shell' \
  && bad "accepted an inspection shell as a QEMU test VM" \
  || ok "rejects an inspection shell carrying the VM marker"

exec -a qemu-system-x86_64 bash -c 'trap "exit 0" TERM; while true; do sleep 1; done' selftest-arg0 -name papercusp-testvm-selftest-marker &
fake_vm_pid=$!
PIDS+=("$fake_vm_pid")
for _ in 1 2 3 4 5; do [ -r "/proc/$fake_vm_pid/cmdline" ] && break; sleep 0.2; done

# This is the process shape that used to be admitted by raw marker matching:
# it is a live shell with `-name papercusp-testvm-*` in argv, not QEMU.
exec -a bash bash -c 'trap "exit 0" TERM; while true; do sleep 1; done' census-arg0 -name papercusp-testvm-inspection-shell &
fake_inspection_pid=$!
PIDS+=("$fake_inspection_pid")
for _ in 1 2 3 4 5; do [ -r "/proc/$fake_inspection_pid/cmdline" ] && break; sleep 0.2; done

DRY_RUN=1
MAX_AGE_SECS=100000   # a freshly-spawned fake process is always younger than this
out="$(main 2>&1)"
# NOTE: real papercusp-testvm-* processes may legitimately be running on this
# box at the same time (e.g. an active fed-a/fed-b session) and will also be
# swept — that's fine and expected, they'll be young too. The property under
# test is narrower and box-state-independent: NOTHING is ever named as a REAP
# candidate under a threshold this large, and our fake one specifically is
# accounted for in skipped_young.
if echo "$out" | grep -q "REAP candidate"; then
  bad "something was treated as a reap candidate under a huge age threshold (age gating broken): $out"
else
  ok "no candidate is reaped under a huge age threshold (age gating holds)"
fi
skipped_n="$(echo "$out" | grep -oE 'skipped_young=[0-9]+' | grep -oE '[0-9]+')"
[ -n "$skipped_n" ] && [ "$skipped_n" -ge 1 ] && ok "our fake VM is counted in skipped_young ($skipped_n total)" \
  || bad "expected skipped_young>=1 in summary, got: $out"

MAX_AGE_SECS=0        # everything is "old enough" instantly
out="$(main 2>&1)"
if echo "$out" | grep -q "REAP candidate: selftest-marker"; then
  ok "with MAX_AGE_SECS=0 the fake VM is correctly identified as a reap candidate"
else
  bad "expected a REAP candidate line for selftest-marker, got: $out"
fi
if echo "$out" | grep -q "inspection-shell"; then
  bad "the census shell was reported as a VM candidate: $out"
else
  ok "a shell carrying -name papercusp-testvm-* is excluded from VM candidates"
fi
if echo "$out" | grep -q "DRY-RUN: would reap selftest-marker"; then
  ok "DRY_RUN mode logs the intended action without calling vmctl/kill"
else
  bad "expected a DRY-RUN reap line, got: $out"
fi

kill -TERM "$fake_vm_pid" 2>/dev/null; wait "$fake_vm_pid" 2>/dev/null

# ── result ───────────────────────────────────────────────────────────────
echo
if [ "$FAILS" -eq 0 ]; then
  echo "PASS — reap-stale-testvms self-test"
  exit 0
else
  echo "FAIL — $FAILS assertion(s) failed"
  exit 1
fi
