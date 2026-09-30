#!/usr/bin/env bash
# scripts/reclaim-tmp-scratch-residue.sh
#
# Reclaim dead scratch residue from the shared /tmp leak (WI-38830, plan
# tmpdir-scratch-leak-nest-and-sweep-2026-08-27, item P-003 / WI-519485).
#
# Targets four already-audited dead shapes under one top-level root — default
# /tmp, DELIBERATELY not ${TMPDIR:-/tmp}: the leak lives in the shared
# system-wide /tmp, which can differ from one caller's own $TMPDIR override:
#   - papercusp-affected-tests-*   (flat *.log files; pure residue, 24h+ dead)
#   - prov-sidecar-*               (dirs; sidecar tooling retired, dead)
#   - sidecar-fresh-*              (dirs; sidecar tooling retired, dead)
#   - pc-heavy-self.*.sh           (flat pre-fix self-copies minted by
#                                    scripts/pc-heavy.sh before commit
#                                    f369131625d4 nested them under
#                                    /tmp/pc-heavy/; new creation collapsed
#                                    ~100x at that commit — D-002 — but the
#                                    ~39k pre-commit flat entries are still
#                                    sitting in /tmp and are what this reclaims)
#
# SAFETY CONTRACT (binding — do not weaken without a plan Decision on
# tmpdir-scratch-leak-nest-and-sweep-2026-08-27):
#   - Age floor ONLY. None of these four shapes embeds a creator pid in a
#     form this script can parse, so a pid-liveness check (the OTHER guard
#     scripts/pc-heavy.sh's own sweep-on-mint uses for the NESTED shape) is
#     not available here. The age floor is therefore the SOLE guard and must
#     stay conservative: default 240 minutes (4h), i.e. >4x the longest
#     observed pc-heavy run (D-001/D-002 on the plan above).
#   - Dry-run by default. Nothing is deleted unless --execute is passed.
#   - Never touches /tmp/pc-heavy/* (the nested parent the fix mints into —
#     its OWN sweep-on-mint already reaps dead siblings there; none of the
#     four SHAPES globbed below can match a path under that directory) or
#     exthost-*.cpuprofile (VS Code's, not ours — also not matched by any
#     shape below).
#   - Best-effort: a racing peer (another agent, a live process) removing or
#     recreating an entry between our glob and our rm is the expected case on
#     this shared host, not an error — rm failures are reported, not fatal.
#
# Usage:
#   scripts/reclaim-tmp-scratch-residue.sh [--execute] [--root DIR] [--max-age-min N]
#
# Always prints a before/after TOP-LEVEL entry count for --root (R-8
# verification per the plan: the count must be shown trending down by direct
# measurement, never inferred from a delete tally alone).

set -uo pipefail # deliberately no -e: best-effort fs ops must not abort the script

ROOT="/tmp"
MAX_AGE_MIN=240
EXECUTE=0

usage() {
  cat <<'EOF'
Usage: reclaim-tmp-scratch-residue.sh [--execute] [--root DIR] [--max-age-min N]

Reclaims residue from four already-audited dead scratch shapes under a shared
TMPDIR (default /tmp): papercusp-affected-tests-*, prov-sidecar-*,
sidecar-fresh-*, pc-heavy-self.*. See the header comment in this file for the
full safety contract (age-floor-only, dry-run default; plan
tmpdir-scratch-leak-nest-and-sweep-2026-08-27, D-001/D-002, item P-003).

  --execute           Actually delete. Default is dry-run (report only).
  --root DIR          Root to sweep (default /tmp).
  --max-age-min N     Age floor in minutes (default 240 = 4h; this is the
                       SOLE guard for these shapes — do not lower without a
                       plan Decision).
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --execute) EXECUTE=1; shift ;;
    --root) ROOT="${2:?--root needs a value}"; shift 2 ;;
    --max-age-min) MAX_AGE_MIN="${2:?--max-age-min needs a value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$MAX_AGE_MIN" in ''|*[!0-9]*) echo "invalid --max-age-min: $MAX_AGE_MIN" >&2; exit 2 ;; esac
[ -d "$ROOT" ] || { echo "root does not exist: $ROOT" >&2; exit 2; }

# The exact four already-audited dead shapes. Deliberately NOT a broader
# glob: reclaim only shapes this plan explicitly measured as safe residue.
SHAPES=(
  'papercusp-affected-tests-*'
  'prov-sidecar-*'
  'sidecar-fresh-*'
  'pc-heavy-self.*'
)

count_root_entries() {
  find "$ROOT" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l | tr -d ' '
}

before_total="$(count_root_entries)"
echo "[reclaim] root=$ROOT max_age_min=$MAX_AGE_MIN execute=$EXECUTE top-level-entries-before=$before_total"

grand_reclaimable=0

for shape in "${SHAPES[@]}"; do
  reclaimable="$(find "$ROOT" -mindepth 1 -maxdepth 1 -name "$shape" -mmin "+${MAX_AGE_MIN}" -print 2>/dev/null | wc -l | tr -d ' ')"
  grand_reclaimable=$((grand_reclaimable + reclaimable))
  if [ "$EXECUTE" -eq 1 ] && [ "$reclaimable" -gt 0 ]; then
    find "$ROOT" -mindepth 1 -maxdepth 1 -name "$shape" -mmin "+${MAX_AGE_MIN}" -print0 2>/dev/null \
      | xargs -0 -r rm -rf --
  fi
  current_total="$(find "$ROOT" -mindepth 1 -maxdepth 1 -name "$shape" 2>/dev/null | wc -l | tr -d ' ')"
  if [ "$EXECUTE" -eq 1 ]; then
    echo "[reclaim] $shape : reclaimable=$reclaimable remaining-after=$current_total"
  else
    echo "[reclaim:dry-run] $shape : current-total=$current_total reclaimable=$reclaimable (pass --execute to delete)"
  fi
done

after_total="$(count_root_entries)"
echo "[reclaim] top-level-entries-after=$after_total delta=$((before_total - after_total))"
echo "[reclaim] grand-reclaimable=$grand_reclaimable"

exit 0
