#!/usr/bin/env bash
# Cold-join a fresh GCP VM running a Papercusp Server .deb to a pot over the PUBLIC DHT and observe
# both sides (plan agent-capacity-and-cost-gcp-2026-09-30: P-525 S6 soak, S7b joined footprint,
# D-055 conflict check). Moved from .papercusp/scratch/s6soak/s6-run.sh by WI-10006497, with the
# fixes the S6 run (2026-10-06) showed it needed:
#  - each side heartbeats into its OWN file. S6 appended both sides to one soak-heartbeat.txt, which
#    made the heartbeats themselves a same-file conflict: the tower integrator parked the joiner.
#  - apt waits for the dpkg lock (unattended-upgrades holds it on a fresh VM) instead of failing.
#  - joiner convergence is read from ~/.papercusp/logs/serve.log; the journal holds only the
#    launcher's two lines. Teardown pulls those logs BEFORE deleting the VM.
#  - CONFLICT_AT_OBS=<n>: at observation n both sides add the same new file with different content,
#    a guaranteed 3-way content conflict. Every later observation reads the joiner's
#    routines.metadata.worktree_divergence (read-routine-metadata.mjs, under the .deb's own node)
#    and counts its "worktree DIVERGED" log lines (D-055 step 1).
#  - touching $OUT/STOP ends the observation at the next tick with the normal teardown (rig handover).
#  - REVOKE=1 (S8, WI-10004393, D-015): after observing, revoke ONLY the joiner's device
#    (substrate:revoke_contributor devicePubkey, WI-10006415) and prove it can no longer push or
#    pull. A marker pair is exchanged BEFORE the revoke as the positive control: if it does not
#    cross, sync was not working and "the after-markers never crossed" proves nothing, so the
#    result is inconclusive. Do not combine with CONFLICT_AT_OBS: an unresolved D-055 conflict
#    parks the joiner, which looks exactly like a revoke.
# Required env: DEB (gs:// URL of a test-artifact .deb), SHA (its sha256), JOIN_BODY (local file
# with the join-link POST body; it carries a join token, so it stays out of the repo).
# Optional env: RUN (p2pjoin) · VM (cap-$RUN) · GCP_PROJECT · GCP_ZONE · POT (hello-world-3-pot) ·
# HIVE (the tower's worktree for POT) · OBSERVE_SEC (10800) · OBS_INTERVAL_SEC (300) · OBS_LIMIT
# (0 = no cap on observations) · MACHINE_TYPE (e2-standard-4; on-demand, D-036) · MAX_HOURS (5) ·
# CONFLICT_FILE (d055-conflict.txt) · RIG_LOCK (a held hive-git-physical-rig lock id: heartbeated
# every 6 observations, released at teardown) · SU (mcp-call client, default $PAPERCUSP_SID) ·
# REVOKE (0) · REVOKE_PORT (3170: an operator that carries WI-10006415) · REVOKE_WAIT_SEC (1200) ·
# S8_POLL_SEC (60) · WS (papercusp-workspace, the pot's workspace id) ·
# AGENT_CAPACITY_OUT (~/.cache/agent-capacity/$RUN). GitHub identity: the tower's gh login, sent
# over ssh STDIN (owner #1174). Always tears the VM down, including on failure and SIGTERM.
# Exit: 0 observed · 2 usage · 3 create failed · 4 ssh/scp failed · 5 install failed (server .deb or
# gh) · 6 gh login or join-link refused (nothing to observe) · 143 SIGTERM
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd) || exit 2
cd "$ROOT" || exit 2
RUN=${RUN:-p2pjoin}; VM=${VM:-cap-$RUN}
P=${GCP_PROJECT:-pc-agent-capacity-0930}; Z=${GCP_ZONE:-us-central1-a}
POT=${POT:-hello-world-3-pot}
HIVE=${HIVE:-$HOME/.papercusp/hives/$POT}
OUT=${AGENT_CAPACITY_OUT:-$HOME/.cache/agent-capacity/$RUN}
# The VM's service user (install-server.sh creates it); its home is composed, never a literal path.
JUSER=${JUSER:-pcsrv}; JHOME=${JHOME:-/home/$JUSER}
JCLONE=$JHOME/.papercusp-workspaces/clones/$POT; JLOG=$JHOME/.papercusp/logs/serve.log
VNODE='/usr/lib/Papercusp Server/sidecar/bin/node'
OBSERVE_SEC=${OBSERVE_SEC:-10800}; OBS_INTERVAL_SEC=${OBS_INTERVAL_SEC:-300}; OBS_LIMIT=${OBS_LIMIT:-0}
MACHINE_TYPE=${MACHINE_TYPE:-e2-standard-4}; MAX_HOURS=${MAX_HOURS:-5}
CONFLICT_AT_OBS=${CONFLICT_AT_OBS:-}; CONFLICT_FILE=${CONFLICT_FILE:-d055-conflict.txt}
RIG_LOCK=${RIG_LOCK:-}; SU=${SU:-${PAPERCUSP_SID:-}}
REVOKE=${REVOKE:-0}; REVOKE_PORT=${REVOKE_PORT:-3170}; REVOKE_WAIT_SEC=${REVOKE_WAIT_SEC:-1200}
S8_POLL_SEC=${S8_POLL_SEC:-60}; WS=${WS:-papercusp-workspace}
DEB=${DEB:-}; SHA=${SHA:-}; JOIN_BODY=${JOIN_BODY:-}
for v in DEB SHA JOIN_BODY; do
  [ -n "${!v}" ] || { echo "USAGE: $v is required (see the header of $0)" >&2; exit 2; }
done
[ -f "$JOIN_BODY" ] || { echo "USAGE: JOIN_BODY '$JOIN_BODY' not found" >&2; exit 2; }
git -C "$HIVE" rev-parse --git-dir >/dev/null 2>&1 || { echo "USAGE: HIVE '$HIVE' is not a git worktree" >&2; exit 2; }
case "$CONFLICT_AT_OBS" in '' | [1-9] | [1-9][0-9]) ;; *) echo "USAGE: CONFLICT_AT_OBS must be 1-99" >&2; exit 2 ;; esac
case "$REVOKE" in 0) ;; 1) [ -z "$CONFLICT_AT_OBS" ] || { echo "USAGE: REVOKE=1 cannot be combined with CONFLICT_AT_OBS (a parked joiner looks like a revoke)" >&2; exit 2; } ;;
  *) echo "USAGE: REVOKE must be 0 or 1" >&2; exit 2 ;; esac
mkdir -p "$OUT" || exit 2
JB=/tmp/$(basename "$JOIN_BODY")

ts() { date -u +%FT%TZ; }
log() { echo "$* $(ts)"; }
ssh_vm() { gcloud compute ssh "$VM" --project="$P" --zone="$Z" --quiet --command="$1" -- -o ConnectTimeout=15 -o ServerAliveInterval=20; }
mcp() { local tool=$1 args=$2; shift 2; env -u CLAUDE_CODE_SESSION_ID node scripts/mcp-call.mjs "$tool" "$args" --client "$SU" "$@"; }
rig() { # heartbeat | release
  [ -n "$RIG_LOCK" ] || return 0
  local rc
  if [ "$1" = release ]; then
    mcp locks:release_resource "{\"lock_id\":\"$RIG_LOCK\"}" > "$OUT/rig-release.out" 2>&1; rc=$?
    log "RIG_LOCK_RELEASE rc=$rc"
  else
    mcp locks:heartbeat_resource "{\"lock_id\":\"$RIG_LOCK\",\"ttl_sec\":3600}" > "$OUT/rig-heartbeat.out" 2>&1; rc=$?
    log "RIG_HEARTBEAT rc=$rc $(grep -oE '"status": *"[a-z]+"' "$OUT/rig-heartbeat.out" | head -1)"
  fi
}
# on_tower <file> / on_joiner <file>: 1 when a commit touching <file> is on that side's HEAD.
on_tower() { git -C "$HIVE" log --oneline -1 -- "$1" 2>/dev/null | grep -c .; }
on_joiner() { ssh_vm "sudo -u $JUSER git -C $JCLONE log --oneline -1 -- $1 2>/dev/null | grep -c ." 2>/dev/null | tail -1; }
# exchange <tag>: each side writes s8-<side>-<tag>.txt, then poll until both crossed or the wait ends.
# Sets PUSHED (joiner's file reached the tower) and PULLED (tower's file reached the joiner).
exchange() {
  local waited=0
  echo "$RUN tower $1 $(ts)" > "$HIVE/s8-tower-$1.txt"
  ssh_vm "echo '$RUN joiner $1 $(ts)' | sudo -u $JUSER tee $JCLONE/s8-joiner-$1.txt >/dev/null"
  PUSHED=0; PULLED=0
  while [ "$waited" -lt "$REVOKE_WAIT_SEC" ]; do
    sleep "$S8_POLL_SEC"; waited=$((waited + S8_POLL_SEC))
    [ "$(on_tower "s8-joiner-$1.txt")" = 1 ] && PUSHED=1
    [ "$(on_joiner "s8-tower-$1.txt")" = 1 ] && PULLED=1
    [ "$PUSHED$PULLED" = 11 ] && break
    [ "$S8_POLL_SEC" -gt 0 ] || break
  done
  log "S8_EXCHANGE tag=$1 waited=${waited}s joinerPushed=$PUSHED joinerPulled=$PULLED"
}
s8() {
  local dev ghid rc control
  dev=$(grep -oE '"pubkeyBase64":"[^"]+"' "$OUT/join.out" 2>/dev/null | head -1 | cut -d'"' -f4)
  [ -n "$dev" ] || { log "S8_RESULT verdict=not-run reason=no-joiner-device"; return; }
  exchange before-revoke
  control=$([ "$PUSHED$PULLED" = 11 ] && echo ok || echo failed)
  ghid=$(gh api user --jq .id 2>/dev/null)
  case "$ghid" in '' | *[!0-9]*) log "S8_RESULT verdict=revoke-failed control=$control reason=no-numeric-gh-id"; return ;; esac
  mcp substrate:revoke_contributor \
    "{\"workspaceId\":\"$WS\",\"potSlug\":\"$POT\",\"githubUserId\":$ghid,\"devicePubkey\":\"$dev\"}" \
    --port "$REVOKE_PORT" > "$OUT/revoke.out" 2>&1; rc=$?
  log "S8_REVOKE rc=$rc device=${dev:0:8} $(grep -oE '"(ok|code|live|reason)": *("[^"]*"|true|false)' "$OUT/revoke.out" | tr -d ' ' | tr '\n' ' ')"
  grep -qE '"ok": *true' "$OUT/revoke.out" || { log "S8_RESULT verdict=revoke-failed control=$control"; return; }
  exchange after-revoke
  if [ "$control" != ok ]; then
    log "S8_RESULT verdict=inconclusive control=failed pushBlocked=$((1 - PUSHED)) pullBlocked=$((1 - PULLED))"
  elif [ "$PUSHED$PULLED" = 00 ]; then
    log "S8_RESULT verdict=revoked control=ok pushBlocked=1 pullBlocked=1"
  else
    log "S8_RESULT verdict=NOT-REVOKED control=ok pushBlocked=$((1 - PUSHED)) pullBlocked=$((1 - PULLED))"
  fi
}
teardown() {
  trap - EXIT
  log "PULL_EVIDENCE"
  ssh_vm "sudo tar -C $JHOME/.papercusp -czf - logs parent-death.log gateway.log 2>/dev/null" > "$OUT/joiner-logs.tgz" 2>/dev/null
  log "JOINER_LOGS bytes=$(stat -c %s "$OUT/joiner-logs.tgz" 2>/dev/null || echo 0)"
  ssh_vm "sudo journalctl _SYSTEMD_USER_UNIT=papercusp-server.service -o short-iso --no-pager" > "$OUT/journal.log" 2>/dev/null
  ssh_vm "cat /tmp/fp-$RUN.jsonl" > "$OUT/fp-$RUN.jsonl" 2>/dev/null
  log "FOOTPRINT samples=$(wc -l < "$OUT/fp-$RUN.jsonl")"
  ssh_vm "sudo -u pcsrv git -C $JCLONE log --format='%cI %h %s' -20" > "$OUT/joiner-git-log.txt" 2>/dev/null
  git -C "$HIVE" log --format='%cI %h %s' -20 > "$OUT/tower-git-log.txt" 2>/dev/null
  npx tsx scripts/agent-capacity/gcp-rails.ts teardown --run="$RUN" > "$OUT/teardown.log" 2>&1
  log "TEARDOWN_RC=$? $(tail -1 "$OUT/teardown.log")"
  rig release
}

log "SOAK_START run=$RUN vm=$VM pot=$POT observe=${OBSERVE_SEC}s conflictAtObs=${CONFLICT_AT_OBS:-none} deb=$DEB sha=$SHA"
# Armed BEFORE create: a create that half-succeeds still leaves a billable VM to delete.
trap teardown EXIT
trap 'exit 143' TERM INT
npx tsx scripts/agent-capacity/gcp-rails.ts create --run="$RUN" --name="$VM" --machine-type="$MACHINE_TYPE" --max-hours="$MAX_HOURS" > "$OUT/create.log" 2>&1
rc=$?; log "CREATE_RC=$rc"
[ $rc -eq 0 ] || { tail -5 "$OUT/create.log"; exit 3; }
for _ in $(seq 1 30); do ssh_vm true >/dev/null 2>&1 && break; sleep "${SSH_RETRY_SLEEP:-10}"; done
ssh_vm true >/dev/null 2>&1 || { log "SSH_NEVER_UP"; exit 4; }
log "SSH_UP"
gcloud compute scp scripts/agent-capacity/vm/install-server.sh scripts/agent-capacity/vm/sample-footprint.py \
  scripts/agent-capacity/vm/read-routine-metadata.mjs "$JOIN_BODY" "$VM":/tmp/ --project="$P" --zone="$Z" --quiet \
  || { log "SCP_FAILED"; exit 4; }
ssh_vm "bash /tmp/install-server.sh '$DEB' $SHA PAPERCUSP_DISABLE_DOGFOOD_HIVE=1" > "$OUT/install.out" 2>&1
rc=$?; log "INSTALL_RC=$rc $(grep -E '^(T_APT|T_BOOT_TO_HEALTH|SERVER_HEALTH)=' "$OUT/install.out" | tr '\n' ' ')"
[ $rc -eq 0 ] || exit 5
# gh AFTER install-server.sh: by then it has run apt-get update and waited for apt/dpkg to go idle.
# c1006j (2026-10-06) installed gh first, the install failed with its output in /dev/null, and the
# join answered HTTP 401 gh_auth_required; the soak then observed a VM with no clone for 2.5 h.
# So retry, refresh the lists between attempts, and refuse to continue without a working gh.
GHV=$(ssh_vm "for i in \$(seq 1 ${GH_INSTALL_TRIES:-12}); do sudo DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 install -y -q gh git >/tmp/gh-install.log 2>&1 && break; sleep ${GH_INSTALL_SLEEP:-10}; sudo apt-get update -qq >/dev/null 2>&1; done; if command -v gh >/dev/null; then gh --version | head -1; else echo GH_ABSENT; tail -3 /tmp/gh-install.log; fi" 2>&1)
log "GH $(printf '%s' "$GHV" | head -1)"
case "$GHV" in "gh version"*) ;; *) log "GH_INSTALL_FAILED [$(printf '%s' "$GHV" | tr '\n' ' ' | head -c 400)]"; exit 5 ;; esac
PORT=$(sed -n 's/^SERVER_PORT=//p' "$OUT/install.out" | tail -1)
[ -n "$PORT" ] || { log "NO_PORT"; exit 5; }
CG=$(sed -n 's/^SERVER_CGROUP=//p' "$OUT/install.out" | tail -1)
ssh_vm "nohup python3 /tmp/sample-footprint.py --cgroup '$CG' --interval 30 --duration $((OBSERVE_SEC + 1200)) --out /tmp/fp-$RUN.jsonl --label $RUN >/tmp/sampler-$RUN.log 2>&1 &"
log "SAMPLER_STARTED cg=$CG"
GHL=$(gh auth token 2>/dev/null | ssh_vm "sudo -u pcsrv -H gh auth login --with-token && sudo -u pcsrv -H gh api user --jq .login" 2>&1 | tail -1)
log "GH_LOGIN $GHL"
case "$GHL" in '' | *[!A-Za-z0-9-]*) log "GH_LOGIN_FAILED [$(printf '%s' "$GHL" | head -c 300)]"; exit 6 ;; esac
log "JOIN_START port=$PORT"
J0=$(date +%s.%N)
ssh_vm "curl -s -m 600 -w '\nHTTP=%{http_code}\n' -X POST http://127.0.0.1:$PORT/api/harness/join-link -H 'content-type: application/json' --data @$JB" > "$OUT/join.out" 2>&1
J1=$(date +%s.%N)
JHTTP=$(grep -oE 'HTTP=[0-9]+' "$OUT/join.out" | tail -1)
log "JOIN_END T_JOIN=$(awk -v a="$J0" -v b="$J1" 'BEGIN { printf "%.1f", b - a }') $JHTTP admission=$(grep -oE '"await_admission_merge":\{[^}]*\}' "$OUT/join.out" | head -1)"
# A refused join leaves nothing to observe: stop now (teardown runs) instead of soaking an empty VM.
[ "$JHTTP" = HTTP=200 ] || { log "JOIN_FAILED ${JHTTP:-HTTP=none} body=[$(grep -v '^HTTP=' "$OUT/join.out" | tr '\n' ' ' | head -c 300)]"; exit 6; }
DEV=$(grep -oE '"pubkeyBase64":"[^"]+"' "$OUT/join.out" | cut -d'"' -f4 | cut -c1-8)
log "JOINER_DEVICE prefix=${DEV:-unknown}"

end=$(( $(date +%s) + OBSERVE_SEC )); n=0
while [ "$(date +%s)" -lt "$end" ]; do
  n=$((n + 1))
  if [ "$OBS_LIMIT" -gt 0 ] && [ "$n" -gt "$OBS_LIMIT" ]; then n=$((n - 1)); break; fi
  if [ -e "$OUT/STOP" ]; then log "EARLY_STOP n=$n reason=[$(head -c 200 "$OUT/STOP")]"; n=$((n - 1)); break; fi
  if [ $((n % 2)) -eq 0 ]; then  # tower heartbeat every 2nd observation (10 min at the default)
    echo "$RUN tower heartbeat $n $(ts)" >> "$HIVE/soak-heartbeat-tower.txt"; log "TOWER_HEARTBEAT n=$n"
  fi
  [ $((n % 6)) -eq 1 ] && rig heartbeat
  if [ $((n % 6)) -eq 0 ]; then  # joiner heartbeat every 6th observation (30 min)
    ssh_vm "echo '$RUN joiner heartbeat $n $(ts)' | sudo -u pcsrv tee -a $JCLONE/soak-heartbeat-joiner.txt >/dev/null" && log "JOINER_HEARTBEAT n=$n"
  fi
  if [ "$n" = "$CONFLICT_AT_OBS" ]; then
    echo "$RUN tower side of the D-055 conflict $(ts)" > "$HIVE/$CONFLICT_FILE"
    ssh_vm "echo '$RUN joiner side of the D-055 conflict $(ts)' | sudo -u pcsrv tee $JCLONE/$CONFLICT_FILE >/dev/null" \
      && log "CONFLICT_INJECTED file=$CONFLICT_FILE n=$n"
  fi
  SINCE="$(date -u -d "-$(( OBS_INTERVAL_SEC > 60 ? OBS_INTERVAL_SEC : 60 )) sec" '+%F %T') UTC"
  TJ=$(journalctl --user -u papercusp-bg-host --since "$SINCE" -o cat --no-pager 2>/dev/null)
  REJ=$(printf '%s\n' "$TJ" | grep -F "presence frame" | grep -cF "signer ${DEV:-zzzz}")
  TCONV=$(printf '%s\n' "$TJ" | grep -F "$POT: pot-git NOT CONVERGED" | tail -1 | grep -oE 'NOT CONVERGED: [^.]*' | head -c 300)
  TCEN=$(printf '%s\n' "$TJ" | grep -F "$POT: ref-announce receive census" | tail -1 | grep -oE 'batch=.*' | head -c 200)
  JCONV=$(ssh_vm "sudo tail -n 20000 $JLOG 2>/dev/null | grep -E '$POT.*(CONVERGED|census|fetch FAILED)' | tail -2 | cut -c1-300" 2>/dev/null | tr '\n' '|')
  JHEAD=$(ssh_vm "sudo -u pcsrv git -C $JCLONE log -1 --format='%h %cI' 2>/dev/null" 2>/dev/null)
  THEAD=$(git -C "$HIVE" log -1 --format='%h %cI' 2>/dev/null)
  DIV=
  if [ -n "$CONFLICT_AT_OBS" ] && [ "$n" -ge "$CONFLICT_AT_OBS" ]; then
    DIV=$(ssh_vm "pgp=\$(sudo ss -ltnp | grep -m1 postgres | grep -oE '127\.0\.0\.1:[0-9]+' | cut -d: -f2); sudo '$VNODE' /tmp/read-routine-metadata.mjs \"\$pgp\" $POT; echo JDIVLOG=\$(sudo grep -c 'worktree DIVERGED' $JLOG 2>/dev/null)" 2>/dev/null | tr '\n' ' ' | head -c 900)
  fi
  log "OBS n=$n towerRejectsJoiner=$REJ towerHead=[$THEAD] joinerHead=[$JHEAD] towerConv=[$TCONV] towerCensus=[$TCEN] joinerConv=[$JCONV] joinerDivergence=[$DIV]"
  sleep "$OBS_INTERVAL_SEC"
done
log "OBSERVE_DONE observations=$n"
[ "$REVOKE" = 1 ] && s8
exit 0
