#!/usr/bin/env bash
# vm-port-alloc.selftest.sh — regression guard for WI-10004354: a linux-test-vm port
# lookup must never resolve one instance's name to ANOTHER instance's VM.
#
# THE BUG THIS GUARDS (silent, and it lets a mutating driver hit the wrong machine):
#   scripts/linux-test-vm/lib/common.sh ports_for() gave every name outside
#   clean/fed-a/fed-b/updater the SAME slot (idx 9 → ssh 2233). So with agent B's
#   ad-hoc VM `osr18b` up on 2233, agent A's `vmctl endpoint oi` answered 2233 too,
#   and `vmctl ssh oi` logged into B's VM. A VM booted with VM_*_BASE overrides was
#   also mis-resolved by any later call made without the same env.
#
# WHAT THIS RUNS: the REAL common.sh and vmctl, against a throwaway PAPERCUSP_TESTVM_HOME.
# A "running VM" is a sleeping bash whose argv is shaped like boot-vm.sh's qemu argv,
# with its pid in the instance's qemu.pid. The allocator runs on high port bases
# (41000+), away from real listeners. There is no qemu, no KVM and no network.
#
#   bash bin/lib/vm-port-alloc.selftest.sh   # exit 0 = PASS, 1 = FAIL
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Fixture seams, defaulting to the SHIPPING code, so this guard's non-vacuity can be
# shown against a deliberately-broken COPY (scripts/mutation-probe.sh).
LIB="${VM_PORT_SELFTEST_LIB:-$DIR/../../scripts/linux-test-vm/lib/common.sh}"
VMCTL="${VM_PORT_SELFTEST_VMCTL:-$DIR/../../scripts/linux-test-vm/vmctl}"
[ -f "$LIB" ] || { echo "  ✗ common.sh not found at $LIB"; exit 1; }

FAILS=0
ok()  { echo "  ✓ $*"; }
bad() { echo "  ✗ $*"; FAILS=$((FAILS + 1)); }

echo "linux-test-vm per-instance ports (WI-10004354)"
T="$(mktemp -d "${TMPDIR:-/tmp}/vm-port-alloc-selftest.XXXXXX")" || { echo "  ✗ mktemp failed"; exit 1; }
PIDS=()
# Kill each fake's CHILD sleep too (by parent pid, never by name): an orphaned sleep
# would outlive the test for its full duration.
cleanup() { local p; for p in "${PIDS[@]}"; do pkill -P "$p" 2>/dev/null; kill "$p" 2>/dev/null; done; rm -rf "$T"; }
trap cleanup EXIT

export PAPERCUSP_TESTVM_HOME="$T/vmhome"
unset VM_SSH_BASE VM_SPICE_BASE VM_OP_BASE VM_ADHOC_SLOTS VM_PORT_CLAIM_TTL_SEC
# shellcheck disable=SC1090
source "$LIB"
set +e   # common.sh turns on errexit; this harness asserts on exit codes itself
mkdir -p "$RUN_DIR"

# fake_vm <name> <ssh> <spice> <op> — a live process whose argv is qemu-shaped.
fake_vm() {
  local name="$1" ssh="$2" spice="$3" op="$4"
  mkdir -p "$RUN_DIR/$name"
  bash -c 'sleep 120; :' fakeqemu -name "papercusp-testvm-$name" \
    -netdev "user,id=net0,net=10.0.2.0/24,hostfwd=tcp::${ssh}-:22,hostfwd=tcp::${op}-:3070" \
    -vga virtio -spice "port=${spice},addr=127.0.0.1,disable-ticketing=on" </dev/null >/dev/null 2>&1 &
  PIDS+=("$!")
  echo "$!" > "$RUN_DIR/$name/qemu.pid"
}

# ── 1. Two running ad-hoc VMs resolve to THEIR OWN ports ─────────────────────
fake_vm adhoc-a 2301 5901 3101
fake_vm adhoc-b 2302 5902 3102
sleep 0.3
a="$(ports_for adhoc-a)"; b="$(ports_for adhoc-b)"
[ "$a" = "2301 5901 3101" ] && ok "running ad-hoc 'adhoc-a' resolves from its own qemu argv ($a)" || bad "adhoc-a resolved to '$a', expected '2301 5901 3101'"
[ "$b" = "2302 5902 3102" ] && ok "running ad-hoc 'adhoc-b' resolves to different ports ($b)" || bad "adhoc-b resolved to '$b', expected '2302 5902 3102'"
a_env="$(VM_SSH_BASE=2290 ports_for adhoc-a)"
[ "$a_env" = "2301 5901 3101" ] && ok "a caller's VM_SSH_BASE cannot change a running VM's answer" || bad "with VM_SSH_BASE=2290 adhoc-a resolved to '$a_env'"

# ── 2. A STOPPED ad-hoc name has no ports, and says so ───────────────────────
out="$(ports_for adhoc-stopped 2>"$T/err")"; rc=$?
[ "$rc" -ne 0 ] && [ -z "$out" ] && ok "a stopped ad-hoc name fails (exit $rc) with nothing on stdout" \
  || bad "a stopped ad-hoc name returned exit $rc, stdout '$out' (the old shared slot was 2233)"
grep -q 'not running' "$T/err" && ok "…and stderr says why" || bad "no explanation on stderr: $(cat "$T/err")"

# ── 3. A pid that isn't this instance's qemu is not trusted ──────────────────
mkdir -p "$RUN_DIR/adhoc-recycled"; cat "$RUN_DIR/adhoc-a/qemu.pid" > "$RUN_DIR/adhoc-recycled/qemu.pid"
out="$(ports_for adhoc-recycled 2>/dev/null)"; rc=$?
[ "$rc" -ne 0 ] && ok "a pidfile pointing at another VM's qemu is rejected by name" || bad "adhoc-recycled borrowed another VM's ports: '$out'"

# ── 4. Fixed names keep their slot (and honour the base env) ─────────────────
[ "$(ports_for clean)" = "2224 5932 3090" ] && ok "stopped 'clean' keeps slot 0 (2224 5932 3090)" || bad "clean resolved to '$(ports_for clean)'"
[ "$(VM_SSH_BASE=3000 ports_for fed-b | cut -d' ' -f1)" = "3002" ] && ok "fixed slots still honour VM_SSH_BASE" || bad "fed-b with VM_SSH_BASE=3000 → '$(VM_SSH_BASE=3000 ports_for fed-b)'"
[ "$(vm_ports_allocate updater)" = "2227 5935 3093" ] && [ ! -f "$RUN_DIR/updater/ports" ] \
  && ok "allocating a fixed name returns its slot and writes no claim" || bad "vm_ports_allocate updater → '$(vm_ports_allocate updater)'"

# ── 5. Allocation: a listening port is never handed out ──────────────────────
# The KERNEL picks the listener's port (bind to 0): a fixed port is flaky here because
# it may sit in the ephemeral range, held by some outgoing connection (EADDRINUSE while
# not LISTENing). The slot base is then derived so that slot 10's ssh port IS that port.
python3 -c 'import socket,sys,time;s=socket.socket();s.bind(("127.0.0.1",0));s.listen(1);open(sys.argv[1],"w").write(str(s.getsockname()[1]));time.sleep(120)' "$T/lport" </dev/null >/dev/null 2>&1 &
PIDS+=("$!")
LP=""
for _ in $(seq 1 50); do LP="$(cat "$T/lport" 2>/dev/null)"; [ -n "$LP" ] && break; sleep 0.1; done
listening="$(ss -Hltn 2>/dev/null | awk '{print $4}')"
case "$LP:$listening" in
  [0-9]*:*":$LP"*)
    export VM_SSH_BASE=$(( LP - 10 )) VM_SPICE_BASE=42000 VM_OP_BASE=43000
    out="$(VM_ADHOC_SLOTS=1 vm_ports_allocate alloc-x 2>/dev/null)"; rc=$?
    [ "$rc" -ne 0 ] && [ -z "$out" ] && ok "the only slot's ssh port ($LP) is listening → allocation refuses" || bad "allocation handed out listening port $LP: '$out'"
    out="$(VM_ADHOC_SLOTS=2 vm_ports_allocate alloc-x 2>/dev/null)"
    case "$out" in
      "$LP "*) bad "with two slots, allocation still handed out listening port $LP: '$out'" ;;
      *) ok "with two slots it never takes the listening one (got '${out:-none free}')" ;;
    esac
    ;;
  *) bad "could not bring up a test listener (port '$LP'; python3/ss missing?)" ;;
esac

# ── 6. Allocation: a fresh claim by an in-flight boot is respected ───────────
export VM_SSH_BASE=44000 VM_SPICE_BASE=45000 VM_OP_BASE=46000
first="$(VM_ADHOC_SLOTS=1 vm_ports_allocate claim-e)"
[ "$first" = "44010 45010 46010" ] && [ "$(cat "$RUN_DIR/claim-e/ports" 2>/dev/null)" = "44010 45010 46010" ] \
  && ok "allocation records its claim in the instance's ports file" || bad "claim-e got '$first', ports file '$(cat "$RUN_DIR/claim-e/ports" 2>/dev/null)'"
out="$(VM_ADHOC_SLOTS=1 vm_ports_allocate claim-f 2>/dev/null)"; rc=$?
[ "$rc" -ne 0 ] && ok "a second boot cannot take a slot another boot just claimed" || bad "claim-f got the SAME slot as claim-e: '$out'"
out="$(VM_ADHOC_SLOTS=1 VM_PORT_CLAIM_TTL_SEC=0 vm_ports_allocate claim-f 2>/dev/null)"
[ "$out" = "44010 45010 46010" ] && ok "an expired claim (TTL passed, VM never bound) is reclaimed" || bad "expired claim not reclaimed: '$out'"
unset VM_SSH_BASE VM_SPICE_BASE VM_OP_BASE

# ── 7. vmctl endpoint: the release gates' lookup fails loudly, never guesses ─
if [ -f "$VMCTL" ]; then
  out="$(bash "$VMCTL" endpoint adhoc-stopped 2>/dev/null)"; rc=$?
  case "$out" in
    *ssh_port=*) bad "vmctl endpoint printed a port for a stopped ad-hoc VM: $(echo "$out" | head -1)" ;;
    *) [ "$rc" -ne 0 ] && ok "vmctl endpoint <stopped ad-hoc> exits $rc and prints no port" || bad "vmctl endpoint exited 0 with no port" ;;
  esac
  out="$(bash "$VMCTL" endpoint adhoc-b 2>/dev/null | sed -n 's/^ssh_port=//p')"
  [ "$out" = "2302" ] && ok "vmctl endpoint <running ad-hoc> returns that VM's own ssh port" || bad "vmctl endpoint adhoc-b → '$out'"
else
  bad "vmctl not found at $VMCTL"
fi

if [ "$FAILS" -eq 0 ]; then echo "PASS"; exit 0; fi
echo "FAIL ($FAILS)"; exit 1
