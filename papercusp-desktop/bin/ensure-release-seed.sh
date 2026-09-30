#!/usr/bin/env bash
# ensure-release-seed.sh — the SINGLE source of truth for cutting the installer
# hive seed (plan hive-seed-bundle-2026-07-04; WI-3346).
#
# WHY THIS EXISTS (WI-3346, owner directive 2026-07-07 "the seedings should also
# be part of the build step"): the seed cut used to be copy-pasted into THREE
# release scripts (release-local.sh, mac-vm-build.sh, build-windows-on-vm.sh /
# .b6-main.sh). They DRIFTED — mac + windows were updated to pass
# --emit-epoch-key (so a fresh offline install can decrypt the pot) but
# release-local.sh (the Linux path) never was, so a fresh Linux cut shipped a
# seed with NO epoch-keys.json and the offline pot silently failed to decrypt
# (the "57 of ~3,356 work-items restored" bug — epoch-0-sealed ops undecryptable).
# One helper, called by every path AND wired into the Tauri build lifecycle
# (tauri.conf.json `beforeBuildCommand`), makes the invocation impossible to
# drift again and makes a fresh, correct seed intrinsic to `tauri build`.
#
# It is FAIL-SAFE for the build hook: when it cannot cut (not the owner box / no
# hive keychain / an already-fresh seed) it leaves the committed seed in place
# and exits 0 — a `tauri build` never fails because of the seed cut, worst case
# it ships the existing committed seed (today's pre-fix behaviour).
#
# Env contract (shared with the callers; all optional):
#   PAPERCUSP_SKIP_SEED_CUT=1 / PAPERCUSP_FAST_ITER=1  skip the cut, reuse the
#                          committed src-tauri/seed as-is (VM legs + dev iteration).
#   PAPERCUSP_SEED_HIVE            (default papercusp)
#   PAPERCUSP_SEED_WORKSPACE_ID    (default papercusp-workspace) — epoch context.
#   PAPERCUSP_SEED_ORIGIN          (default https://github.com/Papercusp/papercup)
#   PAPERCUSP_SEED_REV             (default HEAD)
#   PAPERCUSP_SEED_DEPTH           (default 1; empty = full git history)
#   PAPERCUSP_SEED_CORESTORE       (default 1; 0 = --no-corestore, code-only seed)
#   PAPERCUSP_SEED_REUSE_CORESTORE (default auto: reuse the committed corestore
#                          when one exists — SAFE against a live operator's
#                          fd-lock, refreshes git+epoch-keys only; 0 forces a
#                          FRESH corestore snapshot, which needs a quiesced
#                          operator; 1 forces reuse).
#   PAPERCUSP_SEED_EMIT_EPOCH_KEY  (default 1 → --emit-epoch-key; 0 opts out)
#   PAPERCUSP_SEED_SPARSE          (default 1 → --sparse on a FRESH corestore cut:
#                          ship only the head-snapshot span [snapshotIdx,len), ~40MB
#                          vs ~2.1GB full history — P-004. Requires the shipped reader
#                          (SUBSTRATE_LOG_SNAPSHOT, default-ON) to seek the sparse
#                          start. Applies ONLY to a from-live-store snapshot: a
#                          --reuse-corestore graft is shipped as-cut (its manifest's
#                          coreSparseFrom is PRESERVED, so a committed SPARSE seed still
#                          ships sparse through reuse), and --no-corestore has no core.
#                          0 forces a FULL-history corestore cut.
#   PAPERCUSP_SEED_STORE_DIR       (optional explicit live-store dir override)
#   PAPERCUSP_SEED_REPO            (optional source checkout; default the monorepo)
#   PAPERCUSP_SEED_FORCE=1         force a (re-)cut even when the committed seed
#                          is already usable. The DELIBERATE, release-only "refresh
#                          the corestore to current hive state" switch — with the
#                          default reuse=auto it still reuses a committed corestore
#                          (non-mutating); combine with PAPERCUSP_SEED_REUSE_CORESTORE=0
#                          to force the FULL force-backfill+drain fresh snapshot.
#   PAPERCUSP_SEED_REQUIRED=1      make a missing seed a HARD failure (a real
#                          release refuses to ship seedless); default 0 (warn).
#
# DEFAULT (no FORCE) = a SAFE REPAIR-NET: when the committed seed is already usable
# (manifest + epoch-keys.json) it SKIPS — so wiring this into the Tauri build
# (`beforeBuildCommand`) is a no-op on a good seed (no churn, no live-hive mutation,
# no fd-lock) and only ACTS when the seed is missing/broken (e.g. epoch-keys.json
# absent — the exact 57-item regression), where it repairs via a NON-mutating
# --reuse-corestore refresh. The heavy, up-to-date FULL corestore refresh
# (force-backfill+drain, which cut-seed-cli runs ONLY on a fresh non-reuse cut and
# which MUTATES the live peer log) stays a deliberate PAPERCUSP_SEED_FORCE +
# reuse=0 release action — never automatic on an ordinary build.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"                 # papercusp-desktop/
MONOREPO="$(cd "$ROOT/.." && pwd)"             # papercup superproject
SEED_OUT="$ROOT/src-tauri/seed"
MANIFEST="$SEED_OUT/manifest.json"
EPOCH_KEYS="$SEED_OUT/epoch-keys.json"
OPERATOR_DIR="$MONOREPO/apps/operator"

log() { echo "[ensure-seed] $*"; }

seed_present() { [[ -f "$MANIFEST" ]]; }

# ── payload integrity (WI-39447) ────────────────────────────────────────────
# Does the manifest actually DESCRIBE the bytes next to it? Presence of a file says
# nothing about that: the seed shipped on 2026-08-15 had both files present and a
# corestore 50,165,685 bytes SHORT of its declared sizeBytes, because the default
# --reuse-corestore path GRAFTS the prior manifest's store entry without re-measuring
# it. On a fresh install that store fails restoreSeed's verify, gets skipped, and the
# install reports SUCCESS with an EMPTY hive.
#
# Delegated to the installer's OWN check (verify-seed-payload-cli → the same
# defaultSeedRegistry providers boot uses) rather than a size/hash comparison written
# here, so the cut side and the install side cannot drift apart silently.
#
# That CLI now carries all THREE guards that used to run only when a cut ran — payload
# integrity, sparse-label honesty (assertSeedNotDegraded), and build-box identity
# (judgeSeedIdentity: does the seed carry the builder's username / home / hostname / git
# email into every installer?). Measured ~1.1s + ~1.8s on the real ~475MB seed, so the
# whole set runs unconditionally.
#
# THREE-WAY on purpose: 0 intact · 1 MISMATCH · 2 COULD NOT DETERMINE. A 2 must never
# read as "fine" (that false-absence is the bug) nor as "broken" (that would fail every
# VM leg and partial checkout, where the verifier simply cannot run) — it falls back to
# the presence-only predicate and SAYS SO.
SEED_PAYLOAD_VERDICT=""   # memoized: '' unset · 0 intact · 1 mismatch · 2 undetermined
seed_payload_verdict() {
  if [[ -z "$SEED_PAYLOAD_VERDICT" ]]; then
    if [[ ! -d "$OPERATOR_DIR" ]]; then
      SEED_PAYLOAD_VERDICT=2
    else
      local out
      out="$( cd "$OPERATOR_DIR" && npx tsx lib/release/verify-seed-payload-cli.ts \
                --seed "$SEED_OUT" 2>&1 )"
      SEED_PAYLOAD_VERDICT=$?
      [[ -n "$out" ]] && log "$out"
    fi
  fi
  return "$SEED_PAYLOAD_VERDICT"
}

# A committed seed is USABLE as-is when it has a manifest AND (if epoch emit is
# on) an epoch-keys.json AND its manifest describes the bytes actually on disk.
seed_usable() {
  seed_present || return 1
  if [[ "${PAPERCUSP_SEED_EMIT_EPOCH_KEY:-1}" == "1" ]]; then
    [[ -f "$EPOCH_KEYS" ]] || return 1
  fi
  seed_payload_verdict
  case "$SEED_PAYLOAD_VERDICT" in
    0) return 0 ;;
    1) log "committed seed FAILS one of the installer's own checks (payload integrity, sparse-label honesty, or build-box identity) — treating it as BROKEN, not usable"
       return 1 ;;
    *) log "WARN: could not verify the committed seed's payload integrity — falling back to the presence-only check. This seed is UNVERIFIED, not verified-good."
       return 0 ;;
  esac
}

# ── skip paths ──────────────────────────────────────────────────────────────
if [[ "${PAPERCUSP_SKIP_SEED_CUT:-0}" == "1" || "${PAPERCUSP_FAST_ITER:-0}" == "1" ]]; then
  log "PAPERCUSP_SKIP_SEED_CUT/FAST_ITER set — leaving committed src-tauri/seed as-is"
  seed_present || log "WARN: no seed manifest at $MANIFEST — the bundle will ship WITHOUT an offline pot (cold-join path)"
  exit 0
fi

# Repair-net default: a usable committed seed (manifest + epoch-keys) is left
# alone unless a deliberate PAPERCUSP_SEED_FORCE=1 refresh is requested. This is
# what makes wiring the helper into `beforeBuildCommand` a safe no-op on a good
# seed — it only acts when the seed is missing/broken (e.g. no epoch-keys.json).
if [[ "${PAPERCUSP_SEED_FORCE:-0}" != "1" ]] && seed_usable; then
  log "committed seed is usable (manifest + epoch-keys.json present) — repair-net no-op; set PAPERCUSP_SEED_FORCE=1 to force a (re-)cut"
  exit 0
fi

# OPERATOR_DIR is resolved at the top — seed_payload_verdict() needs it before this point.
if [[ ! -d "$OPERATOR_DIR" ]]; then
  log "seed cutter not found at $OPERATOR_DIR — not a full checkout"
  seed_present && { log "keeping the committed seed"; exit 0; }
  [[ "${PAPERCUSP_SEED_REQUIRED:-0}" == "1" ]] && { log "ERROR: PAPERCUSP_SEED_REQUIRED=1 and no seed to fall back to"; exit 1; }
  log "WARN: no cutter and no committed seed — bundle ships seedless"; exit 0
fi

SEED_HIVE="${PAPERCUSP_SEED_HIVE:-papercusp}"
SEED_WORKSPACE="${PAPERCUSP_SEED_WORKSPACE_ID:-papercusp-workspace}"
SEED_ORIGIN="${PAPERCUSP_SEED_ORIGIN:-https://github.com/Papercusp/papercup}"
SEED_REV="${PAPERCUSP_SEED_REV:-HEAD}"
SEED_DEPTH="${PAPERCUSP_SEED_DEPTH-1}"
SEED_REPO="${PAPERCUSP_SEED_REPO:-$MONOREPO}"

# Resolve the live hive corestore dir (mirrors cut-seed-cli's default) so we can
# tell an owner box (store present) from a VM/CI/contributor box (absent).
STORE_DIR="${PAPERCUSP_SEED_STORE_DIR:-$HOME/.papercusp-workspaces/$SEED_WORKSPACE/.papercusp/$SEED_HIVE/hyperbee}"

# ── corestore mode ──────────────────────────────────────────────────────────
core_args=()
want_corestore=1
fresh_corestore_cut=0   # 1 ONLY on a from-live-store snapshot — the sole mode where --sparse applies
[[ "${PAPERCUSP_SEED_CORESTORE:-1}" != "1" ]] && { core_args+=(--no-corestore); want_corestore=0; }

if [[ "$want_corestore" == "1" ]]; then
  reuse="${PAPERCUSP_SEED_REUSE_CORESTORE:-auto}"
  committed_corestore=0
  [[ -d "$SEED_OUT/corestore" && -f "$MANIFEST" ]] && committed_corestore=1
  case "$reuse" in
    1) core_args+=(--reuse-corestore "$SEED_OUT") ;;
    0)
      # FRESH corestore snapshot — requires the live store dir (owner box) AND a
      # quiesced operator (a live fd-lock aborts the snapshot AFTER wiping the
      # out dir). The caller is responsible for the quiesce when forcing this.
      if [[ ! -d "$STORE_DIR" ]]; then
        log "PAPERCUSP_SEED_REUSE_CORESTORE=0 but live store $STORE_DIR is absent — not the owner box"
        seed_usable && { log "keeping the committed seed"; exit 0; }
        seed_present && { log "WARN: committed seed lacks epoch-keys.json but cannot re-cut here — keeping it"; exit 0; }
        [[ "${PAPERCUSP_SEED_REQUIRED:-0}" == "1" ]] && exit 1; exit 0
      fi
      [[ -n "${PAPERCUSP_SEED_STORE_DIR:-}" ]] && core_args+=(--store-dir "$PAPERCUSP_SEED_STORE_DIR")
      fresh_corestore_cut=1
      ;;
    auto|*)
      # Default: reuse the committed corestore when present (never fd-locks, never
      # wipes it) and only refresh git+epoch-keys; fall back to a fresh snapshot
      # (owner box only) when there is no committed corestore to reuse.
      if [[ "$committed_corestore" == "1" ]]; then
        core_args+=(--reuse-corestore "$SEED_OUT")
        log "corestore: reusing the committed snapshot (auto) — refreshing git + epoch-keys only"
      elif [[ -d "$STORE_DIR" ]]; then
        [[ -n "${PAPERCUSP_SEED_STORE_DIR:-}" ]] && core_args+=(--store-dir "$PAPERCUSP_SEED_STORE_DIR")
        fresh_corestore_cut=1
        log "corestore: no committed snapshot to reuse — cutting FRESH from $STORE_DIR"
      else
        log "corestore: no committed snapshot and no live store $STORE_DIR — not the owner box"
        seed_usable && { log "keeping the committed seed"; exit 0; }
        [[ "${PAPERCUSP_SEED_REQUIRED:-0}" == "1" ]] && { log "ERROR: no seed and cannot cut here"; exit 1; }
        log "WARN: no seed and cannot cut here — bundle ships seedless"; exit 0
      fi
      ;;
  esac
fi

emit_args=()
[[ "${PAPERCUSP_SEED_EMIT_EPOCH_KEY:-1}" == "1" ]] && emit_args+=(--emit-epoch-key)
depth_args=()
[[ -n "$SEED_DEPTH" ]] && depth_args+=(--depth "$SEED_DEPTH")

# P-004 trim: --sparse ships only the head-snapshot span of a FRESH corestore cut
# (~40MB vs ~2.1GB). Gated to a from-live-store snapshot only — cut-seed-cli THROWS if
# --sparse is combined with --no-corestore/--reuse-corestore, and a reused corestore
# already carries its source's coreSparseFrom.
sparse_args=()
[[ "$fresh_corestore_cut" == "1" && "${PAPERCUSP_SEED_SPARSE:-1}" == "1" ]] && sparse_args+=(--sparse)

log "cutting installer seed (hive=$SEED_HIVE rev=$SEED_REV depth=${SEED_DEPTH:-full} corestore=${PAPERCUSP_SEED_CORESTORE:-1} reuse=${PAPERCUSP_SEED_REUSE_CORESTORE:-auto} sparse=$([[ ${#sparse_args[@]} -gt 0 ]] && echo 1 || echo 0) emit-epoch-key=${PAPERCUSP_SEED_EMIT_EPOCH_KEY:-1})"

# The cut is a function so the P-014 sparse fallback below can re-run it verbatim with a
# different flag set. Output is TEE'd (not swallowed) so it stays visible in the build log
# AND is greppable for the specific refusal we know how to recover from. `pipefail` is on,
# so `$?` after the pipeline is the CLI's exit code, not tee's.
CUT_LOG="$(mktemp -t papercusp-seed-cut-XXXXXX.log)"
run_cut() {
  set +e
  (
    cd "$OPERATOR_DIR"
    OPATH="$PATH"
    set -a
    [[ -f ./.env.local ]] && . ./.env.local
    set +a
    export PATH="$OPATH:$PATH"
    PAPERCUSP_ALLOW_DEV_RESTART=1 PAPERCUSP_WORKSPACE_ROOT="$MONOREPO" \
      npx tsx lib/release/cut-seed-cli.ts \
        --out "$SEED_OUT" \
        --repo "$SEED_REPO" \
        --origin "$SEED_ORIGIN" \
        --workspace-id "$SEED_WORKSPACE" \
        --hive "$SEED_HIVE" \
        --rev "$SEED_REV" \
        "${depth_args[@]}" \
        "${core_args[@]}" \
        "${emit_args[@]}" \
        "$@"
  ) 2>&1 | tee -a "$CUT_LOG"
  local rc=$?
  # Keep errexit disabled: callers intentionally inspect a failed sparse attempt and
  # may recover it with the full-cut fallback below.
  return "$rc"
}

run_cut "${sparse_args[@]}"
cut_rc=$?

# P-014 (D-012) — the sparse fallback. cut-seed-cli now REFUSES --sparse when it cannot
# append a fresh head __snapshot__ (only a writable/quiesced open can; the WI-4487
# live-operator read-only path holds no write lock). Before that refusal existed the cut
# "succeeded" and silently shipped the FULL core: the 2026-07-21 release carried 461,475
# blocks / 1.9 GB labelled sparse and nobody noticed for three weeks.
#
# A hard failure here would be worse than the bug — the build would fall back to the STALE
# committed seed. So retry ONCE as a full cut: the release still gets a CURRENT, honestly
# labelled seed (no coreSparseFrom key at all), and the size cost is stated out loud with
# the remedy rather than hidden behind a console.warn.
if [[ "$cut_rc" -ne 0 && ${#sparse_args[@]} -gt 0 ]] \
  && grep -q -- '--sparse requires a fresh head snapshot' "$CUT_LOG"; then
  log "WARN: SPARSE CUT REFUSED — the live operator holds the store, so no fresh head snapshot"
  log "WARN: could be appended, and a sparse cut without one silently ships the FULL core."
  log "WARN: retrying as a FULL cut: the bundle will carry the ENTIRE own-log history (~2GB)."
  log "WARN: to ship a genuinely sparse seed, quiesce the operator on this box and re-run."
  sparse_args=()
  # The first attempt may already have completed the expensive refresh/drain before
  # the sparse-only head-snapshot step refused. Re-enqueueing the whole corpus for the
  # full fallback would recreate the concurrent-cut incident this recovery handles.
  # Resume without force-backfill ONLY when that first attempt proves refresh completed;
  # if it failed earlier, retain the safe force-backfill default.
  fallback_args=()
  if grep -Eq '\[cut-seed\] refreshed (corestore source|via the live operator)' "$CUT_LOG"; then
    fallback_args+=(--no-force-backfill)
    log "WARN: first sparse attempt completed refresh; full fallback will use --no-force-backfill and drain the existing backlog."
  else
    log "WARN: first sparse attempt did not log refresh completion; full fallback will force-backfill for a complete refresh."
  fi
  run_cut "${fallback_args[@]}"
  cut_rc=$?
fi

if [[ "$cut_rc" -ne 0 ]]; then
  log "WARN: seed cut FAILED (rc=$cut_rc)"
  if seed_usable; then
    log "a usable committed seed is still present — continuing the build with it"
    exit 0
  fi
  if [[ "${PAPERCUSP_SEED_REQUIRED:-0}" == "1" ]]; then
    log "ERROR: PAPERCUSP_SEED_REQUIRED=1 and no usable seed after a failed cut"
    exit 1
  fi
  log "WARN: no usable seed after a failed cut — bundle ships seedless (cold-join)"
  exit 0
fi

# Post-cut assertion: the whole point is a decryptable offline pot.
if [[ "${PAPERCUSP_SEED_EMIT_EPOCH_KEY:-1}" == "1" && ! -f "$EPOCH_KEYS" ]]; then
  log "ERROR: cut succeeded but epoch-keys.json is missing — the offline pot would not decrypt (WI-3346 regression)"
  exit 1
fi
log "seed ready at $SEED_OUT$( [[ -f "$EPOCH_KEYS" ]] && echo ' (+ epoch-keys.json)' )"
exit 0
