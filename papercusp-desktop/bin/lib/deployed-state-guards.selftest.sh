#!/usr/bin/env bash
# deployed-state-guards.selftest.sh — focused unit test for the WI-6212
# DEPLOYED-STATE preconditions in scripts/linux-test-vm/lib/common.sh:
# vm_assert_uniform_sidecar / vm_assert_build_provenance / vm_assert_dht_isolated.
#
#   bash bin/lib/deployed-state-guards.selftest.sh    # exit 0 = PASS, 1 = FAIL
#
# WHY THIS EXISTS. Every one of these guards was written after the rig produced a
# confident, reproducible, WRONG answer that nothing anywhere contradicted:
#   - heterogeneous builds  → WI-6209 was misdiagnosed as a product transport bug
#     for hours; the failing direction was simply the one dialed by the stale VM.
#   - unprovenanced build   → both VMs uniformly stale looks IDENTICAL to both
#     being current, so the uniformity guard alone cannot see it.
#   - public DHT            → a relaunch omitting ~/fed.env silently joins the
#     PUBLIC DHT; nothing fails, the rig just quietly measures outside peers.
# A guard against a silent-wrong-answer class is worthless if it is itself
# silently broken, so each assertion below has a CONTROL proving it REJECTS.
#
# Hermetic: the VM-touching primitives (vm_deployed_sidecar_id, vm_build_provenance,
# vm_ssh) are stubbed. No VM, no ssh, no network, ~0s.
#
# Why a bash self-test and not Vitest: the unit under test is bash. Same rationale
# as federation-asserts.selftest.sh.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMMON="$DIR/../../scripts/linux-test-vm/lib/common.sh"
[ -f "$COMMON" ] || { echo "SKIP: $COMMON not found"; exit 0; }

FAILS=0
ok()  { echo "  ✓ $*"; }
bad() { echo "  ✗ $*"; FAILS=$((FAILS + 1)); }

# run_guard <stub-body> <guard-invocation> [env assignments...] → exit code
# Each case runs in its own bash so a `die` (which exits) cannot kill this runner.
run_guard() {
  local stub="$1" call="$2"; shift 2
  env "$@" bash -c "
    source '$COMMON' >/dev/null 2>&1
    $stub
    $call
  " >/dev/null 2>&1
}

# vm_assert_build_provenance also consults the hotpatch marker, which is a second
# VM-touching primitive. Stub it OUT by default (no hotpatch in force) so the
# non-hotpatch cases below stay hermetic — an unstubbed one would attempt a real
# ssh to a VM that does not exist and hang on the connect timeout.
NOHP='vm_hotpatch_provenance() { echo ""; }; '

# run_guard_out — same, but returns the guard's combined output instead of only its
# exit code. Needed wherever several DIFFERENT refusals all exit non-zero: asserting
# on the code alone would pass whichever one fired, which is a vacuous test.
run_guard_out() {
  local stub="$1" call="$2"; shift 2
  env "$@" bash -c "
    source '$COMMON' >/dev/null 2>&1
    $stub
    $call
  " 2>&1
}

echo "=== vm_assert_uniform_sidecar ==="
run_guard 'vm_deployed_sidecar_id() { echo "abc123def456 43001503"; }' \
  'vm_assert_uniform_sidecar vm1 vm2' \
  && ok "identical sidecar bundles on both VMs → accepted" \
  || bad "uniform sidecars were REJECTED — the guard now blocks a valid rig"

run_guard 'vm_deployed_sidecar_id() { [ "$1" = vm1 ] && echo "aaaaaaaaaaaa 100" || echo "bbbbbbbbbbbb 200"; }' \
  'vm_assert_uniform_sidecar vm1 vm2' \
  && bad "CONTROL: a HETEROGENEOUS rig was ACCEPTED — the WI-6209 misdiagnosis is back" \
  || ok "CONTROL: heterogeneous sidecar bundles → refused"

run_guard 'vm_deployed_sidecar_id() { echo ""; }' \
  'vm_assert_uniform_sidecar vm1' \
  && bad "CONTROL: an UNREADABLE sidecar was accepted — an unidentifiable build must stop the run" \
  || ok "CONTROL: unreadable sidecar bundle → refused"

echo "=== vm_assert_build_provenance ==="
run_guard "$NOHP"'vm_build_provenance() { echo "a1b2c3d|0.0.13"; }' \
  'vm_assert_build_provenance vm1' \
  && ok "a provenanced build (real sha + real version) → accepted" \
  || bad "a properly-provenanced build was REJECTED"

# The live WI-6209 rig state: /api/health {"sha":null,"version":"0.0.0"}.
run_guard "$NOHP"'vm_build_provenance() { echo "|0.0.0"; }' \
  'vm_assert_build_provenance vm1' \
  && bad "CONTROL: an UNPROVENANCED build (version 0.0.0) was ACCEPTED — uniform-but-stale stays invisible" \
  || ok "CONTROL: unprovenanced build (version 0.0.0, sha null) → refused"

run_guard "$NOHP"'vm_build_provenance() { echo "|0.0.13"; }' \
  'vm_assert_build_provenance vm1' \
  && bad "CONTROL: a build with a real version but NO sha was accepted" \
  || ok "CONTROL: version present but sha null → refused"

run_guard "$NOHP"'vm_build_provenance() { echo ""; }' \
  'vm_assert_build_provenance vm1' \
  && bad "CONTROL: no operator answering /api/health was accepted" \
  || ok "CONTROL: no operator answered /api/health → refused"

run_guard "$NOHP"'vm_build_provenance() { echo "|0.0.0"; }' \
  'vm_assert_build_provenance vm1' RIG_ALLOW_UNPROVENANCED=1 \
  && ok "RIG_ALLOW_UNPROVENANCED=1 downgrades an unprovenanced build to a warning" \
  || bad "the documented RIG_ALLOW_UNPROVENANCED escape hatch does not work"

run_guard "$NOHP"'vm_build_provenance() { echo "a1b2c3d|0.0.13"; }' \
  'vm_assert_build_provenance vm1' RIG_EXPECT_SHA=a1b2c3d \
  && ok "RIG_EXPECT_SHA matching the running build → accepted" \
  || bad "RIG_EXPECT_SHA rejected a build whose sha MATCHES the commit under test"

run_guard "$NOHP"'vm_build_provenance() { echo "a1b2c3d|0.0.13"; }' \
  'vm_assert_build_provenance vm1' RIG_EXPECT_SHA=deadbee \
  && bad "CONTROL: a rig STALE relative to RIG_EXPECT_SHA was accepted" \
  || ok "CONTROL: build sha != RIG_EXPECT_SHA → refused as stale"

echo "=== hotpatched sidecar (WI-6212 piece 2) ==="
# A hotpatch replaces the JS but CANNOT change /api/health's sha (that comes from
# the Rust binary's option_env! bake, forwarded by main.rs). So the .deb reads as
# unprovenanced exactly as before, and only the marker can rescue the run.
HP='vm_hotpatch_provenance() { echo "beefcafe1234|d35c70p|0u73r5|clean"; }; '

run_guard "$HP"'vm_build_provenance() { echo "|0.0.0"; }' \
  'vm_assert_build_provenance vm1' \
  && ok "a VERIFIED hotpatch marker provenances an otherwise-unidentifiable .deb" \
  || bad "a hotpatched VM was REJECTED — the fast JS loop is unusable, forcing a 3.5GB rebuild"

run_guard "$HP"'vm_build_provenance() { echo "|0.0.0"; }' \
  'vm_assert_build_provenance vm1' RIG_EXPECT_SHA=d35c70p \
  && ok "RIG_EXPECT_SHA matching the hotpatch's DESKTOP sha → accepted" \
  || bad "RIG_EXPECT_SHA rejected a hotpatch built from the very commit under test"

run_guard "$HP"'vm_build_provenance() { echo "|0.0.0"; }' \
  'vm_assert_build_provenance vm1' RIG_EXPECT_SHA=0u73r5 \
  && ok "RIG_EXPECT_SHA matching the hotpatch's OUTER-monorepo sha → accepted" \
  || bad "RIG_EXPECT_SHA rejected a hotpatch whose outer-repo sha IS the commit under test"

run_guard "$HP"'vm_build_provenance() { echo "|0.0.0"; }' \
  'vm_assert_build_provenance vm1' RIG_EXPECT_SHA=deadbee \
  && bad "CONTROL: a hotpatch from an UNRELATED commit satisfied RIG_EXPECT_SHA" \
  || ok "CONTROL: hotpatch sha matches neither desktop nor outer expectation → refused"

# The marker is only worth anything if it cannot outlive the bytes it describes.
# This case runs the REAL vm_hotpatch_provenance against a real fixture directory
# (VM_SIDE_ROOT + a vm_ssh stub that executes the emitted script locally), so what
# is under test is the actual hash comparison, not a restatement of it.
FIXTURE="$(mktemp -d)"
trap 'rm -rf "$FIXTURE"' EXIT
mkdir -p "$FIXTURE/Papercusp GUI/sidecar"
printf 'the bundle actually on disk\n' > "$FIXTURE/Papercusp GUI/sidecar/serve.mjs"
REAL_SHA="$(sha256sum "$FIXTURE/Papercusp GUI/sidecar/serve.mjs" | cut -c1-12)"
LOCAL_SSH='vm_ssh() { shift; bash -c "$1"; }; '

marker() { printf 'hotpatch %s d35c70p 0u73r5 clean 2026-07-26T00:00:00Z serve.mjs\n' "$1" \
  > "$FIXTURE/Papercusp GUI/sidecar/.hotpatch-provenance"; }

marker "$REAL_SHA"
out="$(env VM_SIDE_ROOT="$FIXTURE" bash -c "
  source '$COMMON' >/dev/null 2>&1
  $LOCAL_SSH
  vm_hotpatch_provenance vm1" 2>/dev/null)"
[ "$out" = "$REAL_SHA|d35c70p|0u73r5|clean" ] \
  && ok "marker matching the on-disk bundle → reported ($out)" \
  || bad "a VALID hotpatch marker was not reported (got '$out')"

marker "0000deadbeef"   # e.g. a later `vmctl install` re-laid the .deb underneath it
out="$(env VM_SIDE_ROOT="$FIXTURE" bash -c "
  source '$COMMON' >/dev/null 2>&1
  $LOCAL_SSH
  vm_hotpatch_provenance vm1" 2>/dev/null)"
[ -z "$out" ] \
  && ok "CONTROL: marker whose hash != the bundle on disk → NOT believed (stale marker)" \
  || bad "CONTROL: a STALE marker was believed ('$out') — provenance would describe bytes that are gone"

# The mistake this fast loop invites is pushing a bundle you forgot to rebuild.
# That is checked EXACTLY (hash equality against what the VM already runs), not by
# an mtime heuristic — see the rationale in vm_hotpatch_sidecar.
SRCB="$FIXTURE/tree-serve.mjs"; printf 'the bundle actually on disk\n' > "$SRCB"
NOOP_STUB='vm_deployed_sidecar_id() { echo "'"$REAL_SHA"' 27"; }; vm_ssh() { return 1; }; '

# These three cases all END in a non-zero exit (there is no VM in this sandbox),
# so exit code alone would pass them VACUOUSLY. Assert on WHICH refusal fired.
noop_msg='ALREADY runs this exact bundle'

out="$(run_guard_out "$NOOP_STUB" "vm_hotpatch_sidecar vm1 '$SRCB'")"
case "$out" in
  *"$noop_msg"*) ok "CONTROL: bundle identical to what the VM already runs → refused (forgotten rebuild)" ;;
  *) bad "CONTROL: an identical bundle did NOT trip the no-op refusal — a forgotten rebuild would read as a successful test (got: ${out:-<silence>})" ;;
esac

out="$(run_guard_out "$NOOP_STUB" "vm_hotpatch_sidecar vm1 '$SRCB'" RIG_HOTPATCH_ALLOW_NOOP=1)"
case "$out" in
  *"$noop_msg"*) bad "RIG_HOTPATCH_ALLOW_NOOP=1 did not bypass the no-op check" ;;
  *) ok "RIG_HOTPATCH_ALLOW_NOOP=1 bypasses the no-op check (stops later, at the absent VM)" ;;
esac

printf 'a DIFFERENT bundle\n' > "$SRCB"
out="$(run_guard_out "$NOOP_STUB" "vm_hotpatch_sidecar vm1 '$SRCB'")"
case "$out" in
  *"$noop_msg"*) bad "a CHANGED bundle was refused as a no-op — the hash comparison is inverted" ;;
  *) ok "a CHANGED bundle clears the no-op check and proceeds to the VM" ;;
esac

rm -f "$FIXTURE/Papercusp GUI/sidecar/.hotpatch-provenance"
out="$(env VM_SIDE_ROOT="$FIXTURE" bash -c "
  source '$COMMON' >/dev/null 2>&1
  $LOCAL_SSH
  vm_hotpatch_provenance vm1" 2>/dev/null)"
[ -z "$out" ] \
  && ok "CONTROL: no marker → no hotpatch claimed (a plain .deb install stays plain)" \
  || bad "CONTROL: a hotpatch was reported with no marker present ('$out')"

echo "=== vm_assert_dht_isolated ==="
run_guard 'vm_ssh() { echo "[swarm] DHT bootstrap = ISOLATED 10.77.0.1:41286"; }' \
  'vm_assert_dht_isolated vm1' \
  && ok "an ISOLATED testnet bootstrap → accepted" \
  || bad "an isolated DHT bootstrap was REJECTED"

run_guard 'vm_ssh() { echo "[swarm] DHT bootstrap = PUBLIC DHT"; }' \
  'vm_assert_dht_isolated vm1' \
  && bad "CONTROL: a PUBLIC DHT bootstrap was ACCEPTED — outside peers can silently join the rig" \
  || ok "CONTROL: PUBLIC DHT bootstrap → refused"

run_guard 'vm_ssh() { echo ""; }' \
  'vm_assert_dht_isolated vm1' \
  && bad "CONTROL: a MISSING bootstrap line was accepted — which DHT it joined is unknown" \
  || ok "CONTROL: no 'DHT bootstrap' line in the app log → refused"

echo
if [ "$FAILS" -eq 0 ]; then echo "PASS — deployed-state guards self-test green"; exit 0; fi
echo "FAIL — $FAILS assertion(s) failed"; exit 1
