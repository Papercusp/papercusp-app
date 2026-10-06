#!/usr/bin/env bash
# P-005 ramp set for one VM (plan agent-capacity-and-cost-gcp-2026-09-30, WI-10004376).
# Runs ON the VM from ~/capacity, one ramp after another (they share the machine), each ramp's
# stdout in ~/capacity/ramp-<label>.log (what scripts/agent-capacity/capacity-table.ts reads).
# Order = most representative first, so a VM that hits its max-run-duration still has the key rows.
#
#   systemd-run --user --unit=p005-ramps --collect bash -c \
#     'bash ~/capacity/scripts/agent-capacity/vm/p005-ramps-all.sh 600 "16 32 64 128" > ~/capacity/rampset.log 2>&1'
#
# STEPS is per machine: a ramp only says something between "clearly fits" and "saturates", so a
# small VM starts low and a large one skips the steps it would pass trivially (each step costs
# ~10-20 min of the VM's fixed lifetime). The ramp stops at the first SATURATED or UNDERDRIVEN step.
#
# History: 2026-10-01 05:40Z codex-normal + claude-normal moved ahead of mixed-heavy, because a full
# set no longer fits before max-run-duration and the per-CLI split matters more than the heavy
# profile. 2026-10-01 08:00Z (WI-10004672) the ramps run with WORKDIR=overlay; every earlier P-005
# result held ~13 sessions in flight whatever N was, so it measured checkout setup, not the VM.
set -uo pipefail
cd "$HOME/capacity" || exit 1
DUR=${1:-600}
STEPS=${2:-1 2 4 8 16 32 64}
export WORKDIR=${WORKDIR:-overlay}
ts() { date -u +%FT%TZ; }
echo "RAMPSET_CONFIG dur=$DUR steps=\"$STEPS\" workdir=$WORKDIR $(ts)"
for spec in \
  "mixed-normal|profile=light,profile=typical" \
  "codex-normal|cli=codex,profile=light,profile=typical" \
  "claude-normal|cli=claude,profile=light,profile=typical" \
  "mixed-heavy|profile=heavy"; do
  label=${spec%%|*}
  sel=${spec#*|}
  echo "RAMPSET_START $label $(ts)"
  bash scripts/agent-capacity/vm/p005-ramp.sh "$label" "$sel" "$STEPS" "$DUR" >"$HOME/capacity/ramp-$label.log" 2>&1
  echo "RAMPSET_END $label rc=$? $(ts)"
done
echo "RAMPSET_DONE $(ts)"
