#!/usr/bin/env bash
# Multi-tenant embed-sidecar idle soak on ONE GCP capacity VM (plan agent-capacity-and-cost-gcp-2026-09-30;
# P-532c..f, WI-10005630 / WI-10005481 / WI-10005586 / WI-10006479 / WI-10006420). Moved from
# .papercusp/scratch/p532f/run.sh by WI-10006497.
#
# Installs a TEST-ARTIFACT .deb (build-test-deb.sh) as N tenants (default pct1..pct3), each with the
# measurement-only fetch trace preloaded (embed-trace-fetch.cjs), then watches, every OBS_INTERVAL_SEC:
#   1. each tenant's embed sidecar exits idle after the backfill drains and STAYS down: no respawn by the
#      health probe or by an empty periodic sweep (D-050 / D-051)            -> WI-10005630 / WI-10006479
#   2. each tenant's inference gateway + MCP proxy + voice WS listen under its OWN uid -> WI-10005481/5586
#   3. no tenant starts the desktop env-switcher operators (:3270/:3070/:3170/:3055) -> WI-10006420
# Early stop: every tenant idle-exited and has no sidecar process for STABLE_CENSUSES censuses in a row,
# or a STOP file appears in $OUT. Teardown is armed BEFORE the VM is created (a half-created VM bills).
#
#   DEB_LOCAL=<test-artifact .deb> RUN=c1006s bash scripts/agent-capacity/vm/sidecar-idle-soak.sh \
#     > ~/.cache/agent-capacity/c1006s/run.log 2>&1
#
# Env: DEB_LOCAL (required) · RUN (sidecaridle) · VM (cap-$RUN) · MACHINE (e2-highmem-4) · TENANTS
# ("pct1 pct2 pct3") · TENANT_ENV_<tenant> (extra env for one tenant) · OBSERVE_MIN (120) ·
# OBS_INTERVAL_SEC (300) · STABLE_CENSUSES (3) · MAX_HOURS (3, the gcp-rails self-delete) · SEED_TGZ
# (the doc-vector seed, ~/.cache/agent-capacity/p011/seed.tgz) · AGENT_CAPACITY_OUT
# (~/.cache/agent-capacity/$RUN) · SSH_RETRY_SLEEP (10).
# Exit: 0 observed · 2 missing input · 3 upload/create failed · 4 staging failed · 5 a tenant install failed.
set -uo pipefail
VMDIR=$(cd "$(dirname "$0")" && pwd) || exit 2
ROOT=$(cd "$VMDIR/../../.." && pwd) || exit 2
cd "$ROOT" || exit 2
P=pc-agent-capacity-0930; Z=us-central1-a
RUN=${RUN:-sidecaridle}; VM=${VM:-cap-$RUN}
MACHINE=${MACHINE:-e2-highmem-4}; OBSERVE_MIN=${OBSERVE_MIN:-120}; MAX_HOURS=${MAX_HOURS:-3}
OBS_INTERVAL_SEC=${OBS_INTERVAL_SEC:-300}; STABLE_CENSUSES=${STABLE_CENSUSES:-3}
TENANTS=${TENANTS:-"pct1 pct2 pct3"}
OUT=${AGENT_CAPACITY_OUT:-$HOME/.cache/agent-capacity/$RUN}
SEED_TGZ=${SEED_TGZ:-$HOME/.cache/agent-capacity/p011/seed.tgz}
DEB_LOCAL=${DEB_LOCAL:-}
ts() { date -u +%FT%TZ; }
[ -n "$DEB_LOCAL" ] || { echo "USAGE: DEB_LOCAL=<test-artifact .deb> [RUN=...] $0"; exit 2; }
[ -f "$DEB_LOCAL" ] || { echo "NO_DEB $DEB_LOCAL"; exit 2; }
[ -f "$SEED_TGZ" ] || { echo "NO_SEED $SEED_TGZ"; exit 2; }
mkdir -p "$OUT" || exit 2
ssh_vm() { timeout "${2:-900}" gcloud compute ssh "$VM" --zone="$Z" --project="$P" --command="$1"; }

SHA=$(sha256sum "$DEB_LOCAL" | cut -d' ' -f1)
DEB=gs://pc-agent-capacity-0930-artifacts/$RUN/$(basename "$DEB_LOCAL" | tr ' ' '_')
echo "RUN_CONFIG vm=$VM machine=$MACHINE tenants='$TENANTS' observe<=${OBSERVE_MIN}m interval=${OBS_INTERVAL_SEC}s deb=$DEB sha=$SHA out=$OUT $(ts)"
gcloud storage ls "$DEB" >/dev/null 2>&1 || gcloud storage cp "$DEB_LOCAL" "$DEB" --no-user-output-enabled || { echo "UPLOAD_FAILED"; exit 3; }

teardown() {
  trap - EXIT
  echo "TEARDOWN_START $(ts)"
  npx tsx scripts/agent-capacity/gcp-rails.ts teardown --run="$RUN"
  echo "SOAK_DONE rc=$? $(ts)"
}
trap teardown EXIT
trap 'exit 143' TERM INT
echo "CREATE_START $(ts)"
npx tsx scripts/agent-capacity/gcp-rails.ts create --run="$RUN" --name="$VM" --machine-type="$MACHINE" --max-hours="$MAX_HOURS" \
  || { echo "CREATE_FAILED"; exit 3; }
for try in $(seq 1 30); do ssh_vm true 60 >/dev/null 2>&1 && { echo "SSH_READY try=$try $(ts)"; break; }; sleep "${SSH_RETRY_SLEEP:-10}"; done
gcloud compute scp "$VMDIR/install-server.sh" "$VMDIR/sample-footprint.py" "$VMDIR/host-sampler.sh" \
  "$VMDIR/embed-trace-fetch.cjs" "$VMDIR/sidecar-idle-probe.sh" "$SEED_TGZ" "$VM:/tmp/" --zone="$Z" --project="$P" \
  || { echo "SCP_FAILED"; exit 4; }
ssh_vm "set -e; sudo mkdir -p /opt/agent-capacity/seed; sudo tar xzf /tmp/$(basename "$SEED_TGZ") -C /opt/agent-capacity/seed;
  sudo cp /tmp/embed-trace-fetch.cjs /opt/agent-capacity/; sudo chmod -R a+rX /opt/agent-capacity; du -sh /opt/agent-capacity/seed" \
  || { echo "SEED_STAGE_FAILED"; exit 4; }
ssh_vm 'nohup bash /tmp/host-sampler.sh > /tmp/host.log 2>&1 & sleep 2; tail -n 1 /tmp/host.log' 60

BASE_ENV="PAPERCUSP_DISABLE_DOGFOOD_HIVE=1 PAPERCUSP_DOC_VECTOR_SEED_DIR=/opt/agent-capacity/seed NODE_OPTIONS=--require=/opt/agent-capacity/embed-trace-fetch.cjs"
for u in $TENANTS; do
  echo "TENANT_START $u $(ts)"
  tenv_var="TENANT_ENV_$u"; tenv=${!tenv_var:-}
  echo "TENANT_ENV $u '${tenv}'"
  ssh_vm "SVC_USER=$u bash /tmp/install-server.sh $DEB $SHA $BASE_ENV $tenv" > "$OUT/install-$u.out" 2>&1
  rc=$?
  cg=$(sed -n 's/^SERVER_CGROUP=//p' "$OUT/install-$u.out")
  port=$(sed -n 's/^SERVER_PORT=//p' "$OUT/install-$u.out")
  echo "TENANT_RESULT $u rc=$rc cg=${cg:-none} port=${port:-none} $(grep -E '^(T_BOOT_TO_HEALTH|SERVER_ENV_NOT_APPLIED)=' "$OUT/install-$u.out" | tr '\n' ' ') $(ts)"
  [ $rc -eq 0 ] || { tail -n 15 "$OUT/install-$u.out" | sed "s/^/  [$u] /"; exit 5; }
  ssh_vm "echo '$cg' > /tmp/cg-$u; echo '$port' > /tmp/port-$u; nohup python3 /tmp/sample-footprint.py --cgroup '$cg' --interval 30 --duration 20000 --out /tmp/fp-$u.jsonl --label $u >/tmp/sampler-$u.log 2>&1 &" 60
done

ports() { echo "#### PORTS $1 $(ts)"; ssh_vm "bash /tmp/sidecar-idle-probe.sh ports $1 '$TENANTS'" 120; }
# WI-10006420 verdict: none = no tenant started an env-switcher operator.
envops() {
  echo "#### ENVOPS $1 $(ts)"
  ssh_vm "bash /tmp/sidecar-idle-probe.sh envops '$TENANTS'" 120 | tee "$OUT/envops-$1.txt"
  local total
  total=$(sed -n 's/^ENV_OPERATORS_TOTAL listeners=\([0-9]*\).*/\1/p' "$OUT/envops-$1.txt")
  if [ -z "$total" ]; then echo "ENV_OPERATORS_VERDICT label=$1 verdict=unreadable"
  elif [ "$total" -eq 0 ]; then echo "ENV_OPERATORS_VERDICT label=$1 total=0 verdict=none"
  else echo "ENV_OPERATORS_VERDICT label=$1 total=$total verdict=present"; fi
}
census() {
  echo "#### CENSUS $1 $(ts)"
  ssh_vm "bash /tmp/sidecar-idle-probe.sh census '$TENANTS'" 240 | tee "$OUT/census-last.txt"
}
pull() {
  ssh_vm "cd /tmp && for u in $TENANTS; do sudo cp /home/\$u/.papercusp/logs/serve.log /tmp/serve-\$u.log; done; sudo chmod a+r /tmp/serve-*.log /tmp/embtrace-*.log /tmp/ports-*.txt 2>/dev/null;
    tar czf /tmp/$RUN-ev.tgz host.log fp-*.jsonl sampler-*.log serve-*.log embtrace-*.log ports-*.txt 2>/dev/null; echo PACKED" 300 >/dev/null 2>&1
  gcloud compute scp "$VM:/tmp/$RUN-ev.tgz" "$OUT/ev.tgz.part" --zone="$Z" --project="$P" >/dev/null 2>&1 \
    && mv "$OUT/ev.tgz.part" "$OUT/ev.tgz" && echo "PULLED $(ts)"
}
# Every tenant idle-exited at least once and has no sidecar process right now.
all_idle() {
  local n=0 ok=0 line
  while read -r line; do
    case "$line" in TENANT\ *) n=$((n+1));
      if [[ "$line" =~ sidecarProcs=0\  ]] && ! [[ "$line" =~ idleExits=0\  ]]; then ok=$((ok+1)); fi;; esac
  done < "$OUT/census-last.txt"
  [ "$n" -gt 0 ] && [ "$ok" -eq "$n" ]
}

echo "OBSERVE_START $(ts)"
ports P-0
envops P-0
census P-0
stable=0
OBS_N=$(( OBSERVE_MIN * 60 / (OBS_INTERVAL_SEC > 0 ? OBS_INTERVAL_SEC : 1) ))
for m in $(seq 1 "$OBS_N"); do
  if [ -e "$OUT/STOP" ]; then echo "EARLY_STOP stop-file reason=[$(head -c 200 "$OUT/STOP")] $(ts)"; break; fi
  sleep "$OBS_INTERVAL_SEC"; census "P-$((m * OBS_INTERVAL_SEC / 60))m"; pull
  if all_idle; then stable=$((stable+1)); else stable=0; fi
  echo "STABLE_IDLE $stable/$STABLE_CENSUSES $(ts)"
  if [ "$stable" -ge "$STABLE_CENSUSES" ]; then echo "EARLY_STOP all tenants idle-exited and down for $stable censuses $(ts)"; break; fi
done
ports END
envops END
pull
echo "OBSERVE_END $(ts)"
