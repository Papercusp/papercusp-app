#!/usr/bin/env bash
# Spot reclaim drill, tower side (plan agent-capacity-and-cost-gcp-2026-09-30 P-007; result D-026).
#
#   reclaim-drill.sh tunnel  <vm> <project> <zone>   hold the reverse tunnel to the tower gateway (background it)
#   reclaim-drill.sh prep    <vm> <project> <zone>   install the VM hooks, start a real claude session (needs
#                                                     the tunnel) plus replay load n4
#   reclaim-drill.sh reclaim <vm> <project> <zone>   force a spot preemption, time RUNNING->TERMINATED, restart,
#                                                     time to RUNNING and to ssh, then collect what survived
#                                                     (hooks timeline, previous-boot journal, transcript, load)
#   reclaim-drill.sh resume  <vm> <project> <zone>   (needs the tunnel again) claude --resume the interrupted
#                                                     session, timed
#
# The VM must be a spot VM created with instanceTerminationAction=STOP (gcp-rails.ts --on-reclaim=stop)
# and bootstrapped by bootstrap-agent-vm.sh + stage-driver.sh (prep uses ~/capacity on the VM). With
# DELETE the reclaim takes the disk and there is nothing to resume.
# Each phase writes its own timestamped log under RECLAIM_OUT (default ~/.cache/agent-capacity/reclaim),
# so a re-run never overwrites earlier evidence. The VM holds no credentials: its CLIs reach the tower
# gateway on 127.0.0.1:8788 through `gcloud compute ssh -R`.
# Lines to grep: TUNNEL_*, PREP_*, RECLAIM_*, STATUS, START_*, SSH_READY, RESUME_*.
# Timing knobs (tests set them to 0): RECLAIM_POLL_MAX (600) x RECLAIM_POLL_SEC (1) per status wait,
# RECLAIM_SSH_TRIES (120) x RECLAIM_SSH_SEC (2), RECLAIM_SETTLE_SEC (30) after prep starts the load.
set -uo pipefail
USAGE='usage: reclaim-drill.sh prep|reclaim|resume|tunnel <vm> <project> <zone>'
PHASE=${1:?$USAGE}
VM=${2:?$USAGE}
PROJECT=${3:?$USAGE}
ZONE=${4:?$USAGE}
case "$PHASE" in tunnel|prep|reclaim|resume) ;; *) echo "unknown phase $PHASE; $USAGE" >&2; exit 2 ;; esac
OUT=${RECLAIM_OUT:-$HOME/.cache/agent-capacity/reclaim}
mkdir -p "$OUT" || exit 1
POLL_MAX=${RECLAIM_POLL_MAX:-600}
POLL_SEC=${RECLAIM_POLL_SEC:-1}
SSH_TRIES=${RECLAIM_SSH_TRIES:-120}
SSH_SEC=${RECLAIM_SSH_SEC:-2}
SETTLE_SEC=${RECLAIM_SETTLE_SEC:-30}
LOG=$OUT/$PHASE-$(date -u +%Y%m%dT%H%M%SZ).log
SCR=$(cd "$(dirname "$0")" && pwd)
ts() { date -u +%FT%T.%3NZ; }
say() { echo "$* $(ts)" | tee -a "$LOG"; }
ssh_vm() { gcloud compute ssh "$VM" --project="$PROJECT" --zone="$ZONE" --quiet --command "$1"; }
status() { gcloud compute instances describe "$VM" --project="$PROJECT" --zone="$ZONE" --format='value(status)' 2>/dev/null; }
# wait_status <want>: poll the GCP status, logging each change; returns 0 once it reads <want>.
wait_status() {
  local want=$1 last="" st i
  for ((i = 0; i < POLL_MAX; i++)); do
    st=$(status)
    [ "$st" != "$last" ] && { say "STATUS $st"; last=$st; }
    [ "$st" = "$want" ] && return 0
    sleep "$POLL_SEC"
  done
  say "STATUS_TIMEOUT want=$want last=$last"
  return 1
}
gw_ok() { ssh_vm 'curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://127.0.0.1:8788/healthz' 2>>"$LOG" | grep -q 200; }

case "$PHASE" in
tunnel)
  # Re-dials on drop (the reclaim kills it); stops when the VM is gone for good.
  while true; do
    st=$(status)
    case "$st" in
      RUNNING) say "TUNNEL_OPEN"
        gcloud compute ssh "$VM" --project="$PROJECT" --zone="$ZONE" --quiet -- -N \
          -o ServerAliveInterval=10 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes \
          -R 8788:127.0.0.1:8788 >>"$LOG" 2>&1
        say "TUNNEL_CLOSED rc=$?" ;;
      "") say "TUNNEL_VM_GONE"; exit 0 ;;
      *) sleep 5 ;;
    esac
    sleep 3
  done ;;

prep)
  ssh_vm 'mkdir -p ~/reclaim-drill' >>"$LOG" 2>&1
  gcloud compute scp --project="$PROJECT" --zone="$ZONE" --quiet "$SCR/reclaim-vm-hooks.sh" "$SCR/reclaim-claude-run.sh" "$VM":reclaim-drill/ >>"$LOG" 2>&1 || { say PREP_FAILED scp; exit 2; }
  ssh_vm 'sudo bash ~/reclaim-drill/reclaim-vm-hooks.sh' 2>&1 | tee -a "$LOG" | grep -q HOOKS_OK || { say PREP_FAILED hooks; exit 3; }
  say HOOKS_INSTALLED
  gw_ok || { say "PREP_FAILED gateway not reachable on the VM (start: reclaim-drill.sh tunnel $VM $PROJECT $ZONE)"; exit 4; }
  say GATEWAY_REACHABLE
  # Workspace: the capacity scripts (the task reads each of them, several minutes of tool turns).
  ssh_vm "rm -rf ~/reclaim-drill/work ~/reclaim-drill/claude-config && mkdir -p ~/reclaim-drill/work ~/reclaim-drill/claude-config && cp ~/capacity/scripts/agent-capacity/*.ts ~/capacity/scripts/agent-capacity/vm/*.sh ~/capacity/scripts/agent-capacity/vm/*.py ~/reclaim-drill/work/ && echo task_files=\$(ls ~/reclaim-drill/work | wc -l)" | tee -a "$LOG"
  ssh_vm 'systemd-run --user --unit=reclaim-claude bash "$HOME/reclaim-drill/reclaim-claude-run.sh" task' >>"$LOG" 2>&1 || { say PREP_FAILED claude; exit 5; }
  say CLAUDE_STARTED
  # Replay load: 4 agents for 30 min, so replayed sessions are in flight when the reclaim lands.
  ssh_vm 'systemd-run --user --unit=reclaim-load --working-directory="$HOME/capacity" bash -c "bash \"\$HOME/capacity/scripts/agent-capacity/vm/p005-ramp.sh\" reclaim profile=light,profile=typical 4 1800 > \"\$HOME/capacity/ramp-reclaim.log\" 2>&1"' >>"$LOG" 2>&1 || { say PREP_FAILED load; exit 6; }
  say LOAD_STARTED
  sleep "$SETTLE_SEC"
  ssh_vm 'grep -o "\"session_id\":\"[^\"]*\"" ~/reclaim-drill/claude-task.tsv | head -1; echo notes_lines=$(wc -l < ~/reclaim-drill/work/notes.md 2>/dev/null || echo 0); echo events=$(wc -l < ~/reclaim-drill/claude-task.tsv); systemctl --user is-active reclaim-claude reclaim-load; tail -2 ~/capacity/ramp-reclaim.log' 2>&1 | tee -a "$LOG"
  say PREP_DONE ;;

reclaim)
  ssh_vm 'echo "notes_lines=$(wc -l < ~/reclaim-drill/work/notes.md 2>/dev/null || echo 0)"; systemctl --user is-active reclaim-claude reclaim-load; tail -2 ~/capacity/ramp-reclaim.log 2>/dev/null' 2>&1 | sed 's/^/PRE /' | tee -a "$LOG"
  say RECLAIM_FIRE
  gcloud compute instances simulate-maintenance-event "$VM" --project="$PROJECT" --zone="$ZONE" --async >>"$LOG" 2>&1 || say "SIMULATE_RC=$?"
  say RECLAIM_FIRED
  # D-026: the GCP status lags the guest's death by 2-3.5 min; the guest-side timeline is in the hooks.
  wait_status TERMINATED || { say RECLAIM_NOT_TERMINATED; exit 7; }
  gcloud compute instances describe "$VM" --project="$PROJECT" --zone="$ZONE" --format='value(lastStopTimestamp,scheduling.instanceTerminationAction)' | sed 's/^/DESCRIBE /' | tee -a "$LOG"
  gcloud compute operations list --project="$PROJECT" --zones="$ZONE" --filter="targetLink~$VM" --sort-by=~insertTime --limit=4 --format='value(insertTime,endTime,operationType,status)' | sed 's/^/OP /' | tee -a "$LOG"
  say START_FIRE
  gcloud compute instances start "$VM" --project="$PROJECT" --zone="$ZONE" --async >>"$LOG" 2>&1 || { say "START_FAILED rc=$?"; exit 8; }
  wait_status RUNNING || { say RECLAIM_NOT_RUNNING; exit 8; }
  ready=0
  for ((i = 1; i <= SSH_TRIES; i++)); do
    if ssh_vm true >/dev/null 2>&1; then say "SSH_READY try=$i"; ready=1; break; fi
    sleep "$SSH_SEC"
  done
  [ "$ready" = 1 ] || { say "SSH_NOT_READY tries=$SSH_TRIES"; exit 10; }
  ssh_vm 'echo "--- events"; cat /var/lib/reclaim-drill/events.log; echo "--- hb last"; tail -2 /var/lib/reclaim-drill/hb.log; echo "--- journal -b -1 tail"; journalctl -b -1 --no-pager -o short-iso-precise 2>/dev/null | grep -iE "power key|powering off|power-off|shutdown|reboot: |reclaim|preempt" | tail -25; echo "--- journal -b -1 last"; journalctl -b -1 --no-pager -o short-iso-precise -n 3 2>/dev/null; echo "--- disk"; ls -la ~/reclaim-drill; echo "notes_lines=$(wc -l < ~/reclaim-drill/work/notes.md 2>/dev/null || echo 0)"; tail -3 ~/reclaim-drill/work/notes.md; echo "--- transcripts"; find ~/reclaim-drill/claude-config/projects -name "*.jsonl" -printf "%s %TY-%Tm-%TdT%TH:%TM:%TS %p\n" 2>/dev/null; echo "--- claude-task tail"; wc -l < ~/reclaim-drill/claude-task.tsv; tail -2 ~/reclaim-drill/claude-task.tsv | cut -c1-300; tail -3 ~/reclaim-drill/claude-task.err; echo "--- load"; tail -4 ~/capacity/ramp-reclaim.log 2>/dev/null; ls ~/.cache/agent-capacity/runs/ 2>/dev/null | tail -3' 2>&1 | tee -a "$LOG"
  say RECLAIM_DONE ;;

resume)
  gw_ok || { say "RESUME_FAILED gateway not reachable (start: reclaim-drill.sh tunnel $VM $PROJECT $ZONE)"; exit 4; }
  SID=$(ssh_vm 'grep -o "\"session_id\":\"[^\"]*\"" ~/reclaim-drill/claude-task.tsv | head -1 | cut -d\" -f4')
  [ -n "$SID" ] || { say RESUME_FAILED no session id; exit 9; }
  say "RESUME_SID $SID"
  ssh_vm "echo notes_before=\$(wc -l < ~/reclaim-drill/work/notes.md 2>/dev/null || echo 0); bash ~/reclaim-drill/reclaim-claude-run.sh resume $SID; echo RESUME_RC=\$?; echo notes_after=\$(wc -l < ~/reclaim-drill/work/notes.md); tail -2 ~/reclaim-drill/work/notes.md; head -1 ~/reclaim-drill/claude-resume.tsv; sed -n 2p ~/reclaim-drill/claude-resume.tsv | cut -c1-200; tail -1 ~/reclaim-drill/claude-resume.tsv" 2>&1 | tee -a "$LOG"
  gcloud compute scp --project="$PROJECT" --zone="$ZONE" --quiet "$VM":reclaim-drill/claude-task.tsv "$VM":reclaim-drill/claude-resume.tsv "$OUT/" >>"$LOG" 2>&1
  say RESUME_DONE ;;
esac
