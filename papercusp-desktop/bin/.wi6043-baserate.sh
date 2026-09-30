#!/usr/bin/env bash
# WI-6043 — post-guard BASE RATE for revocation_kcut.
# Repeats the SINGLE scenario on ONE deb (binary held constant; fresh frame boot
# per run, since boot-dependence is a live suspect for the intermittency).
# Stops launching new runs before the hourly live-federation-gate timer so we
# never make the fleet gate skip a cycle.
set -uo pipefail

DEB="${DEB:-/tmp/live-fed-gate-20260726-104022/Papercusp_gate.deb}"
# Do not START a new run after this epoch (hourly gate fires 11:43:02 EDT).
DEADLINE_EPOCH="${DEADLINE_EPOCH:-$(date -d 'today 11:38:00' +%s)}"
MAX_RUNS="${MAX_RUNS:-8}"
OUT="${OUT:-$HOME/.papercusp/live-fed-gate/wi6043-baserate}"
mkdir -p "$OUT"
LEDGER="$OUT/ledger.tsv"
[ -s "$LEDGER" ] || printf 'run\tstamp\tverdict\trevoke_live\tsecs\n' >"$LEDGER"

cd /home/builduser/papercupai-workspace/papercusp || exit 1

for i in $(seq 1 "$MAX_RUNS"); do
  now=$(date +%s)
  if [ "$now" -ge "$DEADLINE_EPOCH" ]; then
    echo "[driver] deadline reached ($(date -Is)) — not starting run $i; gate window is near." >>"$OUT/driver.log"
    break
  fi
  stamp="$(date +%H%M%S)"
  echo "[driver] === run $i stamp=$stamp start $(date -Is) ===" >>"$OUT/driver.log"
  t0=$(date +%s)
  # RIG_LOCK_WAIT_S=0 => fail fast rather than queue behind the gate.
  RIG_LOCK_WAIT_S=0 timeout 900 \
    bash papercusp-desktop/bin/local-matrix.sh --deb="$DEB" --only=revocation_kcut \
    >"$OUT/run-$i-$stamp.out" 2>&1
  rc=$?
  t1=$(date +%s); secs=$((t1-t0))

  if grep -qa 'PASS revocation_kcut' "$OUT/run-$i-$stamp.out"; then verdict=PASS
  elif grep -qa 'FAIL revocation_kcut' "$OUT/run-$i-$stamp.out"; then verdict=FAIL
  else verdict="INCONCLUSIVE(rc=$rc)"; fi

  # revoke.live from the banked scenario log for THIS run (newest wins).
  live="$(ls -t "$HOME/.papercusp/live-fed-gate/triage/scn.revocation_kcut-"*.log 2>/dev/null \
          | head -1 | xargs -r grep -ao 'revoke\.live[^ ]*' | head -1)"
  [ -n "$live" ] || live="ABSENT"

  printf '%s\t%s\t%s\t%s\t%s\n' "$i" "$stamp" "$verdict" "$live" "$secs" >>"$LEDGER"
  echo "[driver] run $i => $verdict $live (${secs}s)" >>"$OUT/driver.log"
done
echo "[driver] DONE $(date -Is)" >>"$OUT/driver.log"
