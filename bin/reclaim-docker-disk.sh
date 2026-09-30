#!/usr/bin/env bash
# bin/reclaim-docker-disk.sh
#
# Reclaim unbounded Docker disk growth on the dev box (WI-39305).
#
# WHY: this host's root filesystem (/dev/nvme0n1p2, ext4 1.9T) holds BOTH $HOME
# and PGDATA, and it filled to 99% (24 GiB free) over ~2 days while a monitor
# filed three successive CRITICAL work-items — WI-38595 (90%), WI-38973 (95%),
# WI-39305 (99%) — that nobody could durably close, because the only available
# response was a one-time manual prune. `packages/operator-core/lib/storage/
# disk-space-alarm.ts` DETECTS the condition but is read-only by construction
# (its own header records it firing 318 times over 8 days while the box sat
# under 1% free, with nothing consuming the toast — EI-20092729937622838). A
# detector with no actor on the other end is not a guard; this script is the
# missing actor.
#
# Measured 2026-08-15: /var/lib/docker had grown to 158 GiB, of which ~84 GiB
# was pure garbage — 34.85 GB of build cache with ZERO active references, 30
# unreferenced images, and 143 orphaned ANONYMOUS volumes. Reclaiming it took
# free space from 22.8 GiB to 102.7 GiB with all 103 running containers
# (sidestage stack, 10 bytebot agents, typesense, redis, testcontainer PGs)
# staying up and healthy. None of that garbage had any mechanism reclaiming it.
#
# Deliberately a systemd timer, NOT a DBOS scheduled workflow and NOT an
# in-process operator tick (dbos-scheduler-consolidation-2026-06-03 D-004 /
# EI-1622): this is dev-box host-level infra hygiene, not product behavior —
# the same reasoning as papercup-testvm-reaper.service,
# papercup-vitest-orphan-reaper.service and papercup-webkit-reaper.service.
#
# ─────────────────────────────────────────────────────────────────────────────
# SAFETY CONTRACT — the parts that matter more than the bytes reclaimed:
#
#   - NEVER `docker volume prune`. That verb deletes every dangling volume,
#     NAMED ONES INCLUDED. On this box 11 of the 154 dangling volumes were
#     named persistent application data — bytebot_postgres_data, the
#     bytebot-pool_bytebot-N-postgres-data set, automaker-*, sheets-clone*,
#     restart_* (odoo/plane/twenty/outline/chatwoot/vikunja/appflowy),
#     litellm_litellm_pgdata, sidestage_*, stalwart-agenticmail-data. Several
#     back services that were merely not running at that moment. A blanket
#     prune would have silently destroyed all of them.
#     => This script removes ONLY volumes whose name matches ^[0-9a-f]{64}$,
#        i.e. Docker's ANONYMOUS volume ids, which are ephemeral by definition
#        (testcontainers creates and abandons these constantly). Any volume a
#        human or a compose file NAMED is never a candidate, full stop.
#
#   - NEVER touch running containers or in-use images. Docker itself refuses,
#     but the age filters below mean we do not even try: an image or cache
#     layer that a live build/test is using is by definition recent.
#
#   - AGE FILTERS, so an in-flight build or test suite is never disturbed.
#     Another agent may be mid-`docker build` or mid-integration-test on this
#     shared box at any moment. Cache younger than BUILD_CACHE_MAX_AGE and
#     images younger than IMAGE_MAX_AGE are left alone; an anonymous volume
#     younger than VOLUME_MAX_AGE_SECS is left alone. Nothing here races a
#     concurrent run.
#
#   - REPORT THE `df` DELTA, NEVER DOCKER'S NUMBER. Docker's "Total reclaimed
#     space" is a logical figure that overstates the disk actually returned
#     (measured 2026-08-15: builder prune claimed 34.85GB, df showed 23.89 GiB;
#     image prune claimed 33.95GB, df showed 32.17 GiB). Sharing and sparse
#     allocation account for the gap. `df -B1` before/after is the authority —
#     and the SAME instrument is used for both readings, never two different
#     ones (comparing a `du -sh` to a `du -sb`, or docker's figure to df's,
#     manufactures progress out of nothing).
#
#   - NEVER fail the timer. Every step is best-effort; a docker daemon that is
#     down, wedged, or not installed makes this a logged no-op, exactly like
#     its sibling reapers.
#
# Knobs (all optional):
#   DRY_RUN=1                 preview every action, change nothing
#   BUILD_CACHE_MAX_AGE=24h   build cache older than this is evicted
#   IMAGE_MAX_AGE=168h        unreferenced images older than this are removed
#   VOLUME_MAX_AGE_SECS=86400 anonymous dangling volumes older than this go
#   SKIP_IMAGES=1             skip the image sweep (keep re-pull cost at zero)
#   RECLAIM_MIN_FREE_PCT=100  only sweep when free% is below this (default 100
#                             = always sweep; the age filters already make a
#                             healthy box a cheap no-op)
#
# Run hourly via the papercup-docker-reclaim.timer systemd user timer.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

DRY_RUN="${DRY_RUN:-0}"
BUILD_CACHE_MAX_AGE="${BUILD_CACHE_MAX_AGE:-24h}"
IMAGE_MAX_AGE="${IMAGE_MAX_AGE:-168h}"
VOLUME_MAX_AGE_SECS="${VOLUME_MAX_AGE_SECS:-86400}"
SKIP_IMAGES="${SKIP_IMAGES:-0}"
RECLAIM_MIN_FREE_PCT="${RECLAIM_MIN_FREE_PCT:-100}"
TARGET_FS="${TARGET_FS:-/}"

log() { printf '[docker-reclaim] %s\n' "$*"; }

# `docker` needs root on this box; prefer non-interactive sudo, fall back to a
# bare call so the script still works where the user is in the docker group.
DOCKER=(docker)
if ! docker info >/dev/null 2>&1; then
  if sudo -n docker info >/dev/null 2>&1; then
    DOCKER=(sudo -n docker)
  else
    log "docker unreachable (daemon down, absent, or no non-interactive sudo) — no-op"
    exit 0
  fi
fi

avail_bytes() { df -B1 --output=avail "$TARGET_FS" 2>/dev/null | tail -1 | tr -d ' '; }
total_bytes() { df -B1 --output=size  "$TARGET_FS" 2>/dev/null | tail -1 | tr -d ' '; }

BEFORE="$(avail_bytes)"
TOTAL="$(total_bytes)"
if [[ -z "$BEFORE" || -z "$TOTAL" || "$TOTAL" -eq 0 ]]; then
  log "could not read df for $TARGET_FS — no-op"
  exit 0
fi

FREE_PCT=$(( BEFORE * 100 / TOTAL ))
log "start: $((BEFORE / 1073741824)) GiB free on $TARGET_FS (${FREE_PCT}% of $((TOTAL / 1073741824)) GiB)"

if (( FREE_PCT >= RECLAIM_MIN_FREE_PCT )); then
  log "free% ${FREE_PCT} >= RECLAIM_MIN_FREE_PCT ${RECLAIM_MIN_FREE_PCT} — nothing to do"
  exit 0
fi

run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    log "DRY_RUN would run: $*"
    return 0
  fi
  "$@" >/dev/null 2>&1 || log "step failed (non-fatal): $*"
}

# ── 1. Build cache ───────────────────────────────────────────────────────────
# The single safest reclaim: pure derived data, regenerated on demand. On the
# measured run this was 34.85 GB with zero active references.
log "pruning build cache older than ${BUILD_CACHE_MAX_AGE}"
run "${DOCKER[@]}" builder prune -af --filter "until=${BUILD_CACHE_MAX_AGE}"

# ── 2. Unreferenced images ───────────────────────────────────────────────────
# Images backing a running container are protected by Docker itself; the age
# filter additionally spares anything pulled recently for an in-flight run.
if [[ "$SKIP_IMAGES" == "1" ]]; then
  log "SKIP_IMAGES=1 — skipping image sweep"
else
  log "pruning unreferenced images older than ${IMAGE_MAX_AGE}"
  run "${DOCKER[@]}" image prune -af --filter "until=${IMAGE_MAX_AGE}"
fi

# ── 3. Orphaned ANONYMOUS volumes only ───────────────────────────────────────
# See the safety contract: named volumes are persistent application data and
# are never candidates. We resolve each anonymous dangling volume's CreatedAt
# and skip anything younger than VOLUME_MAX_AGE_SECS so a just-started
# testcontainer is never pulled out from under a running suite.
NOW_EPOCH="$(date +%s)"
anon_removed=0
anon_skipped_young=0

while IFS= read -r vol; do
  [[ -z "$vol" ]] && continue
  created="$("${DOCKER[@]}" volume inspect -f '{{.CreatedAt}}' "$vol" 2>/dev/null)"
  if [[ -n "$created" ]]; then
    created_epoch="$(date -d "$created" +%s 2>/dev/null || echo 0)"
    if (( created_epoch > 0 )) && (( NOW_EPOCH - created_epoch < VOLUME_MAX_AGE_SECS )); then
      anon_skipped_young=$(( anon_skipped_young + 1 ))
      continue
    fi
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    log "DRY_RUN would remove anonymous volume $vol"
  else
    "${DOCKER[@]}" volume rm "$vol" >/dev/null 2>&1 && anon_removed=$(( anon_removed + 1 ))
  fi
done < <("${DOCKER[@]}" volume ls -qf dangling=true 2>/dev/null | grep -E '^[0-9a-f]{64}$')

log "anonymous volumes removed=${anon_removed} skipped_too_young=${anon_skipped_young} (named volumes never touched)"

# ── Report the df delta, never docker's figure ───────────────────────────────
AFTER="$(avail_bytes)"
if [[ -n "$AFTER" ]]; then
  FREED=$(( AFTER - BEFORE ))
  log "done: $((AFTER / 1073741824)) GiB free (df delta: $((FREED / 1048576)) MiB reclaimed)"
else
  log "done: could not re-read df"
fi
exit 0
