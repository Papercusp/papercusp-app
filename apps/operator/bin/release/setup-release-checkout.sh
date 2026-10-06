#!/usr/bin/env bash
# Release-checkout setup / sync — plan release-gate-ready-branch-2026-06-04, Phase 0.
#
# Stands up + maintains the SEPARATE release checkout the operator runs from,
# pinned to a release ref (default the green `main` branch — staging→main model,
# staging-branch-pipeline-2026-06-06). This is the deploy system's own checkout
# — NOT an agent worktree (D-004), so it does not violate the "agents stay on
# the integration branch (`staging`)" rule. Idempotent: safe to re-run on every
# deploy.
#
# What it guarantees about the release checkout at $PAPERCUSP_RELEASE_ROOT:
#   1. a git worktree detached at the target commit (default: green `main`) —
#      the superproject's tracked files, as real isolated files,
#   2. submodule REPOS — REAL git repositories, cloned from the integration
#      tree's LOCAL object store and detached at each submodule's EXACT pinned
#      sha. Sourcing locally is what makes this work at all: many submodule pins
#      are never pushed to origin (the integration tree holds them locally), so a
#      fresh worktree/clone's `submodule update` fails "upload-pack: not our
#      ref". `git clone --local` reads exactly the same local objects `git
#      archive` did, HARDLINKS them (immutable → near-zero disk, and unaffected
#      by peer edits to the integration tree), and checks out a working tree of
#      REAL files at the pinned commit.
#
#      Why real repos rather than extracted files (EI-19299565558496583): a plain
#      file tree has no `.git`, so it is not a submodule to git at all, and
#      `git ls-files --recurse-submodules` silently returns superproject-only —
#      no error, just a smaller list. Measured in the gate checkout: 7,526
#      recursive == 7,526 plain (+0 from recursion), 35/35 submodules
#      uninitialized, hiding ~3,500 TS files (~32% of the tree) from every
#      tracked-files guard IN THE GATE. With real repos: +1,055 files, 0
#      uninitialized. `git archive` extraction is RETAINED as the fallback below.
#      (All submodules are top-level here — no recursion needed.)
#   3. node_modules copied from the integration tree. We must COPY, not symlink:
#      npm-workspace packages are relative symlinks (../../packages/X); a symlinked
#      node_modules dir would resolve those back to the INTEGRATION tree and defeat
#      the whole isolation. Hardlinks are the fast default for the live release
#      tree; `--node-modules-copy copy` gives checkpoint trees independent regular
#      files so a concurrent install cannot mutate the pinned test inputs. Once an
#      isolated checkpoint snapshot exists, unchanged dependency trees are refreshed
#      by hardlinking FROM THAT ISOLATED SNAPSHOT (never from integration) instead of
#      re-reading and re-writing the full dependency payload every gate run.
#
# Why a worktree (not a clone) for the superproject: shares the object store, so
# checking out the target commit is cheap and history isn't duplicated.
#
# Standalone by design (plan "Bootstrapping" risk): pure git + coreutils, no
# operator/Node runtime needed, so it can rebuild the release checkout even when
# the operator it deploys is wedged.
#
# Usage:
#   setup-release-checkout.sh [--ref <commit-ish>] [--node-modules auto|force|skip]
#                             [--node-modules-copy hardlink|copy]
#                             [--node-modules-generation required|off]
#                             [--node-modules-generation-id <v1-sha256>]
#                             [--node-modules-generation-token <stat-token>]
#                             [--node-modules-workspace-dir <repo-relative-dir>]...
#                             [--dependency-generation-root <dir>]
#                             [--integration <dir>] [--release <dir>]
#                             [--prepare-existing]
#                             [--source-only]
#                             [--source-integrity allow-live-tree|object-sourced]
#                             [--build-spa]
#   setup-release-checkout.sh -h|--help   print this usage and exit 0 (touches nothing)
#
# `--source-integrity object-sourced` (P-008) refuses the one materialization path
# that reads the integration tree's live working directory instead of git objects
# — `extract_submodule_source`'s rsync last resort — and exits 3 instead. Pass it
# from any caller whose output is a promotion VERDICT; the live deploy keeps the
# default `allow-live-tree`, where a drifted submodule beats no serving operator.
# Either way the run emits a `CANDIDATE_SOURCE_INTEGRITY ... live_tree=N` line.
#
# `--prepare-existing` is a dependency-only recovery mode for a clone that has
# already been pinned and had its submodules checked out by an earlier step. It
# validates the existing HEAD, then skips the destructive superproject checkout,
# clean, and submodule replacement stages while still running dependency setup.
#
# Env overrides: PAPERCUSP_INTEGRATION_ROOT, PAPERCUSP_RELEASE_ROOT.
set -euo pipefail

# EI-24760202132078287: usage discovery must be non-mutating, so it is handled
# before anything else runs (no helper sourcing, no trap, no git). The text is
# the header's own `# Usage:` … `# Env overrides:` block, so it cannot drift.
for _arg in "$@"; do
  case "$_arg" in
    -h|--help)
      sed -n '/^# Usage:/,/^# Env overrides:/s/^# \{0,1\}//p' "${BASH_SOURCE[0]}"
      exit 0 ;;
  esac
done

# Default to the checkout this script actually lives in — never one box's path
# (WI-4419: a hardcoded /home/<user>/… default is wrong on every other machine
# AND ships the owner's identity inside the release source drop).
_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_REPO_DEFAULT="$(git -C "$_HERE" rev-parse --show-toplevel 2>/dev/null || (cd "$_HERE/../../../.." && pwd))"
# P-006 extends this setup path rather than creating a parallel checkpoint
# materializer. The sourceable helper also serves install:safe's publisher.
source "$_HERE/dependency-generation.sh"
INTEGRATION_ROOT="${PAPERCUSP_INTEGRATION_ROOT:-$_REPO_DEFAULT}"
RELEASE_ROOT="${PAPERCUSP_RELEASE_ROOT:-$(dirname "$INTEGRATION_ROOT")/papercusp-release}"
REF="main"
NODE_MODULES_MODE="auto"   # auto = copy when missing/lockfile-changed; force = always; skip = never
# hardlink is the fast default for the live release tree. Checkpoint callers pass
# copy because their source tree can be npm-installed concurrently; sharing inodes
# would let that install mutate the supposedly pinned checkpoint tree.
NODE_MODULES_COPY_MODE="${NODE_MODULES_COPY_MODE:-hardlink}"
# Independent checkpoint copies pin an immutable dependency generation by
# default. The live deploy's `hardlink` mode keeps its existing fast path.
NODE_MODULES_GENERATION_MODE="${NODE_MODULES_GENERATION_MODE:-required}"
NODE_MODULES_GENERATION_ID="${NODE_MODULES_GENERATION_ID:-}"
NODE_MODULES_GENERATION_TOKEN="${NODE_MODULES_GENERATION_TOKEN:-}"
NODE_MODULES_WORKSPACE_DIRS=()
DEPENDENCY_GENERATION_ROOT="${PAPERCUSP_DEPENDENCY_GENERATION_ROOT:-}"
# P-008 (green-main-fast-2026-08-25) — SOURCE integrity, the peer of the
# dependency-generation pin above. Every other leg of candidate materialization is
# already sourced from immutable git OBJECTS: the superproject is a worktree
# detached at the frozen sha, submodules are `git clone --local` of the pinned
# gitlink, and node_modules is an independent copy pinned to a verified generation
# id. `extract_submodule_source`'s LAST RESORT is the one remaining path that reads
# the integration tree's live WORKING DIRECTORY (`rsync ... "$INTEGRATION_ROOT/..."`),
# which on this shared checkout holds every peer agent's uncommitted, possibly
# mid-write edits. A tree built that way corresponds to NO COMMIT, and the
# asymmetry is what matters: a RED from it is unreproducible (the tree is already
# gone), while a GREEN fast-forwards `main` to a sha whose tested content was never
# that sha — the gate certifying a commit it did not actually test.
#   allow-live-tree (DEFAULT) = historical behaviour, byte-for-byte. The live
#     DEPLOY wants it: a drifted submodule beats no serving operator at all, and
#     the deploy renders no promotion verdict.
#   object-sourced = refuse the live-tree rsync and fail closed. For any caller
#     whose output is a VERDICT (green-checkpoint), where an unmaterializable
#     candidate must surface as a typed infra fault, never as a silent judgement
#     on a tree that never existed.
SOURCE_INTEGRITY_MODE="${SOURCE_INTEGRITY_MODE:-allow-live-tree}"

# Any error after exact-ID selection must release this process-owned reader
# lease. A successful path promotes the checkout marker into a persistent pin
# before releasing it explicitly.
release_dependency_generation_lease_on_exit() {
  dependency_generation_release_selector_lease || true
}
trap release_dependency_generation_lease_on_exit EXIT

BUILD_SPA="0"
PREPARE_EXISTING="0"
SOURCE_ONLY="0"
REF_WAS_SET="0"

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="$2"; REF_WAS_SET="1"; shift 2 ;;
    --node-modules) NODE_MODULES_MODE="$2"; shift 2 ;;
    --node-modules-copy) NODE_MODULES_COPY_MODE="$2"; shift 2 ;;
    --node-modules-generation) NODE_MODULES_GENERATION_MODE="$2"; shift 2 ;;
    --node-modules-generation-id) NODE_MODULES_GENERATION_ID="$2"; shift 2 ;;
    --node-modules-generation-token) NODE_MODULES_GENERATION_TOKEN="$2"; shift 2 ;;
    --node-modules-workspace-dir) NODE_MODULES_WORKSPACE_DIRS+=("$2"); shift 2 ;;
    --dependency-generation-root) DEPENDENCY_GENERATION_ROOT="$2"; shift 2 ;;
    --source-integrity) SOURCE_INTEGRITY_MODE="$2"; shift 2 ;;
    --integration) INTEGRATION_ROOT="$2"; shift 2 ;;
    --release) RELEASE_ROOT="$2"; shift 2 ;;
    --build-spa) BUILD_SPA="1"; shift ;;
    --prepare-existing) PREPARE_EXISTING="1"; shift ;;
    --source-only) SOURCE_ONLY="1"; shift ;;
    *) echo "[setup-release] unknown arg: $1" >&2; exit 2 ;;
  esac
done

case "$NODE_MODULES_COPY_MODE" in
  hardlink|copy) ;;
  *) echo "[setup-release] bad --node-modules-copy mode: $NODE_MODULES_COPY_MODE" >&2; exit 2 ;;
esac
case "$NODE_MODULES_GENERATION_MODE" in
  required|off) ;;
  *) echo "[setup-release] bad --node-modules-generation mode: $NODE_MODULES_GENERATION_MODE" >&2; exit 2 ;;
esac
case "$SOURCE_INTEGRITY_MODE" in
  allow-live-tree|object-sourced) ;;
  *) echo "[setup-release] bad --source-integrity mode: $SOURCE_INTEGRITY_MODE" >&2; exit 2 ;;
esac
if [ -n "$NODE_MODULES_GENERATION_ID" ] \
  && { [ "$NODE_MODULES_GENERATION_MODE" != "required" ] || [ "$NODE_MODULES_COPY_MODE" != "copy" ]; }; then
  echo "[setup-release] --node-modules-generation-id requires --node-modules-generation required and --node-modules-copy copy" >&2
  exit 2
fi
if [ -n "$NODE_MODULES_GENERATION_TOKEN" ] && [ -z "$NODE_MODULES_GENERATION_ID" ]; then
  echo "[setup-release] --node-modules-generation-token requires --node-modules-generation-id" >&2
  exit 2
fi
if [ "$SOURCE_ONLY" = "1" ] && [ "$PREPARE_EXISTING" = "1" ]; then
  echo "[setup-release] --source-only and --prepare-existing are mutually exclusive" >&2
  exit 2
fi

log() { echo "[setup-release] $*"; }

# EI-21181583819839124: a crashed Git process can leave the linked checkout's
# index.lock behind. Every later checkpoint then fails before running a single
# test, even though the gate's own run-lock is healthy. Recover only the narrow,
# measurable stale case: Git resolves the exact per-worktree lock path, the file
# is at least five minutes old, and no live process holds it open. A fresh or
# owned lock remains a hard stop. The stale file is MOVED to a recoverable temp
# quarantine rather than deleted, so the incident evidence survives.
index_lock_has_live_holder() {
  local lock_path="$1" probe_status

  if command -v fuser >/dev/null 2>&1; then
    # `fuser` walks the whole process table. On a busy fleet host that walk can
    # wedge for minutes, pinning release setup before Git gets a chance to
    # recover. Bound the probe and preserve the safety contract: 0 = owned,
    # 1 = proven unowned, every other outcome = unknown/fail closed.
    command -v timeout >/dev/null 2>&1 || return 2
    if timeout --signal=TERM --kill-after=1s "${INDEX_LOCK_HOLDER_PROBE_TIMEOUT_SEC:-2}" \
      fuser "$lock_path" >/dev/null 2>&1; then
      return 0
    else
      probe_status=$?
    fi
    [ "$probe_status" -eq 1 ] && return 1
    return 2
  fi

  # The release host is Linux. Keep the standalone script fail-closed if the
  # normal owner probe is absent: /proc is an acceptable fallback, while an
  # environment with neither probe must never guess that a lock is abandoned.
  if [ -d /proc ]; then
    local fd target
    for fd in /proc/[0-9]*/fd/*; do
      target="$(readlink "$fd" 2>/dev/null || true)"
      [ "$target" = "$lock_path" ] && return 0
    done
    return 1
  fi

  return 0
}

quarantine_stale_worktree_index_lock() {
  local lock_path lock_mtime now age quarantine_dir quarantine_path holder_probe_status

  lock_path="$(git -C "$RELEASE_ROOT" rev-parse --git-path index.lock 2>/dev/null || true)"
  [ -n "$lock_path" ] || return 1
  case "$lock_path" in
    /*) ;;
    *) lock_path="$RELEASE_ROOT/$lock_path" ;;
  esac
  [ -f "$lock_path" ] || return 1

  lock_mtime="$(stat -c %Y "$lock_path" 2>/dev/null || true)"
  [ -n "$lock_mtime" ] || return 1
  now="$(date +%s)"
  age=$((now - lock_mtime))
  if [ "$age" -lt 300 ]; then
    log "refusing to reclaim fresh Git index lock ($age seconds old): $lock_path"
    return 1
  fi
  if index_lock_has_live_holder "$lock_path"; then
    log "refusing to reclaim Git index lock held by a live process: $lock_path"
    return 1
  else
    holder_probe_status=$?
    if [ "$holder_probe_status" -ne 1 ]; then
      log "refusing to reclaim Git index lock because its live-holder probe was unavailable: $lock_path"
      return 1
    fi
  fi

  quarantine_dir="${TMPDIR:-/tmp}/papercusp-stale-git-locks"
  mkdir -p "$quarantine_dir"
  quarantine_path="$(mktemp "$quarantine_dir/index.lock.$(date +%s).XXXXXX")"
  mv "$lock_path" "$quarantine_path"
  log "quarantined stale unowned Git index lock: $lock_path -> $quarantine_path"
  return 0
}

refresh_release_worktree() {
  if git -C "$RELEASE_ROOT" checkout --detach "$TARGET_SHA" >/dev/null 2>&1; then
    git -C "$RELEASE_ROOT" reset --hard "$TARGET_SHA"
    return 0
  fi

  if quarantine_stale_worktree_index_lock; then
    log "retrying checkout after stale Git index lock recovery"
    git -C "$RELEASE_ROOT" checkout --detach "$TARGET_SHA" >/dev/null 2>&1 || \
      git -C "$RELEASE_ROOT" reset --hard "$TARGET_SHA"
    git -C "$RELEASE_ROOT" reset --hard "$TARGET_SHA"
    return 0
  fi

  # Preserve the historical fallback for non-lock checkout failures. A live or
  # fresh index.lock makes this reset fail too, which is the intended fail-closed
  # result rather than stealing another process's lock.
  git -C "$RELEASE_ROOT" reset --hard "$TARGET_SHA"
}

# Symlink-safe roots: `find` (default -P) does NOT descend through a symlinked
# START path, so a symlinked INTEGRATION_ROOT (e.g. papercup -> papercusp, since
# 2026-06-25) makes the node_modules copy loop below (`find "$INTEGRATION_ROOT"
# -name node_modules -type d`) enumerate ZERO dirs and silently copy NOTHING —
# leaving release node_modules stale until the workspace-resolution gate aborts
# every deploy (the 2026-06-30 "@papercusp/scheduled-registry unresolved" stall
# that left :3070 166 commits behind). Normalize to real paths so find/cp operate
# on the real tree regardless of how the caller named the root.
INTEGRATION_ROOT="$(realpath "$INTEGRATION_ROOT")"
RELEASE_ROOT="$(realpath -m "$RELEASE_ROOT")"

# Worktree-safe repo check: ASK GIT, never stat `.git`. A git WORKTREE's `.git` is a
# FILE (`gitdir: <path>`), not a directory, so the old `[ -d "$INTEGRATION_ROOT/.git" ]`
# rejected a perfectly valid worktree as "not a git repo". That is not hypothetical: the
# operator processes that launch deploys RUN from worktrees — papercusp-staging (:3170,
# WorkingDirectory=.../papercusp-staging/apps/operator) and papercup-release (:3070) are
# both worktrees, and integrationRoot defaults to scriptRepoRoot() (release-config.ts),
# i.e. whichever tree the caller runs from. So every deploy launched via the release:deploy
# TOOL aborted here — and so did its rollback leg, since both call this script. It fails
# BEFORE touching the release root, so the tree stays consistent and :3070 keeps serving
# happily: the deploy is silently a no-op to anyone watching the service. That is how the
# pipeline sat 260 commits behind the green pin while every surface looked healthy
# (WI-10001774; fleet outage EI-23538941588991674 was unfixable for 7.5h behind it).
#
# Note this file ALREADY uses `-e` for "$RELEASE_ROOT/.git" (below), precisely because the
# release root is created by `git worktree add` — line 292 was simply the odd one out.
# `rev-parse --git-dir` is stricter than `-e`: it accepts main repos, worktrees and
# submodules, and still rejects a stray `.git` file that is not a real repo. It also tests
# exactly the capability every later line depends on — they are all `git -C "$INTEGRATION_ROOT" ...`.
git -C "$INTEGRATION_ROOT" rev-parse --git-dir >/dev/null 2>&1 || { echo "[setup-release] integration root is not a git repo: $INTEGRATION_ROOT" >&2; exit 1; }

# Resolve the target commit from the integration repo (refs are shared with the worktree).
# In dependency-only mode the existing checkout is the source of truth. An
# explicit --ref remains an assertion, rather than an instruction to move the
# checkout; without one, use the clone's current pinned HEAD.
if [ "$PREPARE_EXISTING" = "1" ]; then
  [ -e "$RELEASE_ROOT/.git" ] || {
    echo "[setup-release] --prepare-existing requires an existing git checkout: $RELEASE_ROOT" >&2
    exit 1
  }
  EXISTING_SHA="$(git -C "$RELEASE_ROOT" rev-parse --verify HEAD 2>/dev/null || true)"
  [ -n "$EXISTING_SHA" ] || {
    echo "[setup-release] --prepare-existing could not resolve HEAD in existing checkout: $RELEASE_ROOT" >&2
    exit 1
  }
  if [ "$REF_WAS_SET" = "1" ]; then
    TARGET_SHA="$(git -C "$INTEGRATION_ROOT" rev-parse --verify "${REF}^{commit}")"
    if [ "$EXISTING_SHA" != "$TARGET_SHA" ]; then
      echo "[setup-release] --prepare-existing checkout HEAD ($EXISTING_SHA) does not match requested ref $REF ($TARGET_SHA)" >&2
      exit 1
    fi
  else
    TARGET_SHA="$EXISTING_SHA"
    REF="$TARGET_SHA"
  fi
  # The dependency stages compare integration-tree package paths against the
  # pin. Fail closed if the integration object store cannot inspect that pin;
  # silently treating every package as post-pin would leave a partial clone.
  git -C "$INTEGRATION_ROOT" cat-file -e "$TARGET_SHA^{commit}" 2>/dev/null || {
    echo "[setup-release] --prepare-existing requires the pinned commit in the integration object store: $TARGET_SHA" >&2
    exit 1
  }
  log "preparing existing pinned checkout (dependency-only) ref=$REF sha=$TARGET_SHA"
else
  TARGET_SHA="$(git -C "$INTEGRATION_ROOT" rev-parse --verify "${REF}^{commit}")"
  log "target ref=$REF sha=$TARGET_SHA"
fi

# EI-25223821707990839: an explicit generation can expire while source checkout
# and submodule replacement run. Take its process-owned selector lease before
# those mutations, so a missing generation leaves the existing source untouched
# and retention cannot remove a live selection during preparation. Source-only
# and dependency-skip callers deliberately do not consume a generation.
if [ "$SOURCE_ONLY" = "0" ] && [ "$NODE_MODULES_MODE" != "skip" ] \
  && [ "$NODE_MODULES_COPY_MODE" = "copy" ] \
  && [ "$NODE_MODULES_GENERATION_MODE" = "required" ] \
  && [ -n "$NODE_MODULES_GENERATION_ID" ]; then
  DEPENDENCY_GENERATION_ROOT="$(dependency_generation_resolve_root "$INTEGRATION_ROOT" "$DEPENDENCY_GENERATION_ROOT")"
  dependency_generation_acquire_selector_lease \
    "$DEPENDENCY_GENERATION_ROOT" "$NODE_MODULES_GENERATION_ID" "$$" \
    "$NODE_MODULES_GENERATION_TOKEN"
  log "leased explicit dependency generation before source preparation: $NODE_MODULES_GENERATION_ID"
fi

# 1. Worktree --------------------------------------------------------------
if [ "$PREPARE_EXISTING" = "1" ]; then
  log "preserving existing checkout and submodules (prepare-existing)"
elif [ -e "$RELEASE_ROOT/.git" ]; then
  log "release worktree exists; checking out $TARGET_SHA"
  refresh_release_worktree
  # UNTRACKED debris survives reset --hard and poisons every later run from
  # this tree (2026-06-06: a stray test file made the green-checkpoint red
  # forever). Clean it — node_modules excluded (the hardlink copies from step
  # 3 are untracked by design). Keep the currently-running operator's
  # dist-host tree too: papercup-dev-api continues serving from that bundle
  # until the later restart, and lazy runtime readers (notably locks:* loading
  # dist-host/sql) must see a coherent old bundle+assets set throughout this
  # potentially long checkout/submodule/node_modules/SPA preparation window.
  # ExecStartPre rebuilds dist-host from the newly-swapped source immediately
  # before the process restart, so retaining it here cannot make the next
  # process serve stale code. Submodule SOURCE is re-extracted in step 2, so
  # losing it here is fine.
  #
  # WI-5366: `-x` too — a plain `clean -fdq` (no `-x`) leaves every GITIGNORED
  # artifact untouched, not just node_modules. Verified live in this exact
  # tree (2026-07-19): package-local `.vitest-tmp/` and `.papercusp-tmp/node-
  # compile-cache/` dirs dated 2026-07-02 — 17 days and untold checkouts
  # stale — survived every single `reset --hard` + clean since, because they
  # are ignored, not untracked-but-unignored. This tree's own header comment
  # calls it "a throwaway, correctness-critical tree [that] must always
  # re-copy from integration" (the reasoning that made `--node-modules force`
  # mandatory here over `auto`); a stale gitignored build/test cache left
  # over from a PRIOR checkout at a DIFFERENT commit is the exact same class
  # of correctness risk, just unaddressed for anything outside node_modules.
  # This is the leading suspect behind WI-5366 (green-checkpoint's stale-
  # candidate re-triage twice reporting a false "failures REPRODUCE at tip"
  # verdict for a tip provably clean at that sha) — a stale cache is a much
  # better fit than a checkout race (assert_checkout_landed, WI-5110, already
  # proves HEAD lands correctly; the reflog for the incident shows a single
  # clean transition with nothing interleaved). `-x` makes the clean total:
  # every ignored file/dir is removed too, `-e node_modules` still spares
  # the one directory this tree deliberately preserves + refreshes itself.
  # EI-20509311930433301: the old `-x` clean also deleted the live process's
  # entire ignored apps/operator/dist-host tree. The process kept serving from
  # its already-open bundle, but a first locks:* call then failed ENOENT while
  # lazily scanning dist-host/sql. Preserve the whole coherent runtime tree;
  # bundle-host.sh replaces its bundle/assets during ExecStartPre.
  # The staging checkout can also be the checkpoint's dependency donor. Its
  # generation store owns publication proofs, input selectors, pins and active
  # writer leases alongside node_modules. Keeping only node_modules destroys
  # those proofs on every staging refresh and forces a full generation rebuild.
  # Retention in dependency-generation.sh owns this store's cleanup.
  git -C "$RELEASE_ROOT" clean -fdqx -e node_modules -e /apps/operator/dist-host/ -e /.papercusp/dependency-generations/ || true
else
  log "creating release worktree at $RELEASE_ROOT"
  git -C "$INTEGRATION_ROOT" worktree add --detach "$RELEASE_ROOT" "$TARGET_SHA"
fi

# 1a. Verify the checkout actually landed (WI-5110) ------------------------
# A caller trusts a ZERO exit from this script as proof the tree is at
# $TARGET_SHA — the green-checkpoint stale-candidate re-triage in particular
# renders a "failures REPRODUCE at tip <sha>" verdict straight off that
# assumption (apps/operator/lib/release/green-checkpoint.ts runTestsAtRef).
# Twice on 2026-07-17 that verdict was FALSE for tests that demonstrably
# passed when re-run by hand at the same sha — i.e. something upstream of
# this assertion produced a green exit code without the working tree actually
# reflecting $TARGET_SHA (a worktree race, a swallowed git error, or similar;
# root cause not yet isolated). Rather than let ANY caller keep trusting a
# postcondition this script has not actually verified, assert it here, once,
# at the source: fail loudly (exit 1, no swap/no test run happens on a
# throwaway tree) if HEAD does not match. This makes a zero exit from this
# script an honest guarantee for every caller (candidate judgment, tip
# re-run, prefix salvage) instead of requiring each one to re-verify a value
# this script should have gotten right the first time.
# Named function (reads RELEASE_ROOT / TARGET_SHA / REF from the outer scope) for
# sed-extraction unit tests — same convention as need_node_modules /
# prune_post_pin_workspace_pkgs (setup-release-checkout-deps.test.ts). Exits the
# whole script non-zero on a mismatch: this check is fatal by design — a
# throwaway checkpoint/release tree that is not provably at TARGET_SHA must never
# be handed to a caller as if it were.
assert_checkout_landed() {
  local actual
  actual="$(git -C "$RELEASE_ROOT" rev-parse HEAD 2>/dev/null || true)"
  if [ "$actual" != "$TARGET_SHA" ]; then
    echo "[setup-release] FATAL: release tree HEAD (${actual:-unknown}) does not match target ref ${REF:-?} ($TARGET_SHA) after checkout — refusing to let a caller trust this tree" >&2
    exit 1
  fi
}
assert_checkout_landed

# 2. Submodule SOURCE — git archive at the exact pinned sha (local objects) ---
# EI-18749180047527506: a `tar -x` that EXITS ZERO is not proof the extraction is
# COMPLETE — a truncated/interrupted archive stream can still exit 0 having
# written fewer files than its own manifest promised, silently leaving a
# submodule tree PARTIAL. That is indistinguishable, downstream, from a real
# content regression: prompt-blueprint-verb-catalog.test.ts's >150-file
# scan-sanity floor (guarding this exact submodule tree) has no way to tell
# "the checkout is genuinely incomplete" from "a candidate deleted files", and
# a false alarm here holds the WHOLE fleet's green pin. Verify the on-disk file
# count against the archive's OWN manifest (`tar -tf`) before trusting the
# extraction; a shortfall is treated exactly like the pre-existing `tar -x`
# failure path — fall back to the full-tree rsync, which is complete by
# construction. Named + reads INTEGRATION_ROOT/RELEASE_ROOT from the outer
# scope so it can be sed-extracted + unit-tested (setup-release-checkout-deps.
# test.ts pattern) like need_node_modules / sync_one_node_modules /
# prune_post_pin_workspace_pkgs above.
extract_submodule_source() {  # <repo-relative path> <pinned sha>
  local rel_path="$1" sha="$2" tar_file expected actual
  rm -rf "${RELEASE_ROOT:?}/$rel_path"
  mkdir -p "$RELEASE_ROOT/$rel_path"
  tar_file="$(mktemp)"
  if git -C "$INTEGRATION_ROOT/$rel_path" archive "$sha" >"$tar_file" 2>/dev/null && [ -s "$tar_file" ]; then
    # tar -tf lists directory entries with a trailing '/'; count only file
    # entries (matches the on-disk `find -type f` count below). A parse
    # failure (corrupt/unreadable archive) yields -1 so it never satisfies
    # the `-ge 0` check and always falls through to the rsync fallback.
    expected="$(tar -tf "$tar_file" 2>/dev/null | grep -vc '/$' || true)"
    [ -n "$expected" ] || expected=-1
    if tar -x -C "$RELEASE_ROOT/$rel_path" -f "$tar_file" 2>/dev/null; then
      actual="$(find "$RELEASE_ROOT/$rel_path" -type f | wc -l | tr -d ' ')"
      if [ "$expected" -ge 0 ] && [ "$actual" -ge "$expected" ]; then
        rm -f "$tar_file"
        return 0
      fi
      log "WARN git archive $rel_path@$sha landed only $actual/$expected file(s) — treating as an incomplete extraction"
    fi
  fi
  rm -f "$tar_file"
  # P-008: this is the ONLY remaining path that sources candidate content from the
  # integration tree's live WORKING DIRECTORY rather than from immutable git
  # objects. Under `object-sourced` it is refused: a caller that renders a
  # promotion VERDICT must never judge a tree that corresponds to no commit, and
  # failing closed converts an invisible, unreproducible verdict into a loud,
  # diagnosable infra fault. Return 2 (not 1) so the caller can distinguish
  # "materialization is impossible here" from "materialized, but drifted".
  # `:-` keeps this function self-contained: setup-release-checkout-deps.test.ts
  # sed-extracts it and sources it under `set -u` with none of the script's globals
  # defined, so a bare $SOURCE_INTEGRITY_MODE would abort the extracted function
  # rather than exercise it. Defaulting here also makes allow-live-tree the
  # behaviour of any caller that never heard of this flag.
  if [ "${SOURCE_INTEGRITY_MODE:-allow-live-tree}" = "object-sourced" ]; then
    log "FATAL git archive $rel_path@$sha failed or incomplete and --source-integrity=object-sourced forbids the live-tree rsync fallback — the pinned objects for this submodule are unreadable, so this candidate cannot be materialized from git objects. Refusing to splice the integration tree's uncommitted working directory into a tree that will be judged."
    return 2
  fi
  log "WARN git archive $rel_path@$sha failed or incomplete; rsync'ing integration HEAD (pin may drift)"
  rsync -a --exclude='node_modules' --exclude='.git' "$INTEGRATION_ROOT/$rel_path/" "$RELEASE_ROOT/$rel_path/"
  # Drift is reported through a variable, NOT the return code: this function's
  # documented contract is "self-heals — never fails the caller" (pinned by two
  # tests in setup-release-checkout-deps.test.ts), and the rsync path really did
  # produce complete content. Only the REFUSAL above is a new non-zero status, and
  # it is unreachable in the default mode.
  _LAST_EXTRACT_USED_LIVE_TREE=1
  return 0
}

# Return the device id for a path or its nearest existing ancestor. Both the
# submodule clone and node_modules materializer use this: local Git clones
# hardlink objects by default and fail with EXDEV rather than falling back to a
# copy when the destination is on another filesystem.
filesystem_device() {
  local path="$1" parent
  while [ ! -e "$path" ]; do
    parent="$(dirname "$path")"
    [ "$parent" = "$path" ] && break
    path="$parent"
  done
  stat -c '%d' "$path"
}

# EI-19299565558496583: clone a REAL submodule repository at the pinned sha. This
# is the PRIMARY path; extract_submodule_source above is the FALLBACK and is
# deliberately retained rather than replaced — it carries its own incident
# hardening (EI-18749180047527506's completeness check + the rsync last resort)
# and still produces correct CONTENT when a clone cannot be made.
#
# Two properties here are load-bearing and must not be "simplified away":
#
#  (a) `git clone --local` produces a real `.git` DIRECTORY inside the submodule
#      path (git's legacy layout). That is REQUIRED, not incidental. The obvious
#      alternative — `git submodule update --init` with the URL rewritten to the
#      local path — places each gitdir under `git rev-parse --git-common-dir`/
#      modules/<name>, and because the release tree is a LINKED WORKTREE of the
#      integration repo, that common dir IS the integration repo's own `.git`.
#      It would collide with the integration tree's live submodule gitdirs, i.e.
#      corrupt the tree the whole fleet is working in. A self-contained `.git`
#      dir is isolated by construction.
#
#  (b) This function must NEVER write submodule config. `git config` run from a
#      linked worktree writes to the SHARED config — into the integration repo —
#      so registering `submodule.<name>.url` here would mutate that tree too.
#      It is also unnecessary: the release worktree already INHERITS
#      `submodule.<name>.active` from the shared config, which is why recursion
#      works with zero config writes.
#
# Named + reads INTEGRATION_ROOT/RELEASE_ROOT from the outer scope so it can be
# sed-extracted and unit-tested (setup-release-checkout-deps.test.ts pattern),
# like need_node_modules / sync_one_node_modules / extract_submodule_source.
clone_submodule_repo() {  # <repo-relative path> <pinned sha>
  local rel_path="$1" sha="$2"
  # Deliberately a SECOND `local`: bash expands every argument of a single
  # `local` before the builtin assigns any of them, so folding this into the
  # line above makes `$rel_path` unbound under `set -u` (caught in test).
  local dest="$RELEASE_ROOT/$rel_path"
  local source_device dest_device
  local clone_args=(--quiet --local --no-checkout)
  rm -rf "${dest:?}"
  source_device="$(filesystem_device "$INTEGRATION_ROOT/$rel_path")" || return 1
  dest_device="$(filesystem_device "$dest")" || return 1
  # `--local` tries to hardlink every object and aborts with EXDEV across mount
  # points. Preserve that near-zero-disk fast path on one filesystem; opt into
  # Git's real object copy only when the devices differ.
  [ "$source_device" = "$dest_device" ] || clone_args+=(--no-hardlinks)
  # --no-checkout: the clone's default HEAD may be a different commit, and the
  # ONLY working-tree files this may write are the pinned ones.
  git clone "${clone_args[@]}" "$INTEGRATION_ROOT/$rel_path" "$dest" 2>/dev/null || return 1
  git -C "$dest" checkout --quiet --detach "$sha" 2>/dev/null || return 1
  # Pin correctness: HEAD must be EXACTLY the gitlink sha, never merely "close".
  [ "$(git -C "$dest" rev-parse HEAD 2>/dev/null || true)" = "$sha" ] || return 1
  # Completeness — the same guarantee the archive path buys with its tar-manifest
  # count, but strictly stronger: a clean worktree proves every tracked file is
  # present AND carries the pinned content. `-uno` keeps it cheap.
  [ -z "$(git -C "$dest" status --porcelain -uno 2>/dev/null)" ] || return 1
  return 0
}

# EI-24341465306631575 fix (b): both materializers above start with `rm -rf` of the
# whole submodule path, which also deletes the gitignored node_modules trees a
# previous run materialized there from an immutable dependency generation. The
# checkpoint re-runs this step before every dependency pass, so every pass
# re-copied those trees (~3.7 GiB, most of it papercusp-desktop's sidecar). Move
# ONLY trees stamped `generation=v1-…` aside before the re-clone and put them back
# afterwards. Their source content is still a fresh clone; whether a kept tree is
# reusable is decided later by the same per-tree marker check as every other tree
# (pinned_generation_tree_current), and a stale one is re-materialized. Trees of
# the live deploy's hardlink mode carry no generation marker and are removed
# exactly as before. Best-effort: a failed move leaves the tree where `rm -rf`
# removes it, which is the old behaviour.
stash_pinned_submodule_node_modules() {  # <repo-relative submodule path> <stash dir>
  local rel_path="$1" stash="$2" nm rel marker
  [ -d "$RELEASE_ROOT/$rel_path" ] && [ ! -L "$RELEASE_ROOT/$rel_path" ] || return 0
  while IFS= read -r nm; do
    [ -n "$nm" ] || continue
    marker="$nm/.papercusp-isolated-snapshot"
    [ -f "$marker" ] && [ ! -L "$marker" ] || continue
    grep -q '^generation=v1-' "$marker" 2>/dev/null || continue
    rel="${nm#"$RELEASE_ROOT"/}"
    mkdir -p "$stash/$(dirname "$rel")" 2>/dev/null || continue
    mv "$nm" "$stash/$rel" 2>/dev/null || true
  done < <(dependency_generation_enumerate_node_modules "$RELEASE_ROOT/$rel_path" 2>/dev/null || true)
  return 0
}

restore_pinned_submodule_node_modules() {  # <repo-relative submodule path> <stash dir>
  local rel_path="$1" stash="$2" nm rel dest
  [ -d "$stash/$rel_path" ] || return 0
  while IFS= read -r nm; do
    [ -n "$nm" ] || continue
    rel="${nm#"$stash"/}"
    dest="$RELEASE_ROOT/$rel"
    # Only into a directory the new pin still has, and never over a tree the
    # clone itself produced (a tracked node_modules would be source content).
    if [ -d "$(dirname "$dest")" ] && [ ! -L "$(dirname "$dest")" ] && [ ! -e "$dest" ] \
      && mv "$nm" "$dest" 2>/dev/null; then
      SUBMODULE_NODE_MODULES_KEPT=$(( ${SUBMODULE_NODE_MODULES_KEPT:-0} + 1 ))
    fi
  done < <(find "$stash/$rel_path" -type d -name node_modules -prune -print 2>/dev/null)
  rm -rf "${stash:?}/$rel_path"
  return 0
}

if [ "$PREPARE_EXISTING" = "0" ]; then
log "cloning submodule repos at pinned shas (local objects; real .git so --recurse-submodules works)"
_sub_cloned=0
_sub_fallback=0
# P-008: submodules materialized by rsync'ing the integration tree's live working
# directory rather than from git objects. Counted separately from _sub_fallback,
# which only says "the clone did not work" — the archive fallback is still fully
# object-sourced and pin-exact. This counter is the one that means "this tree
# contains content that is in no commit".
_sub_live_tree=0
# Sibling of the release root, so moving a tree there is a rename on the same
# filesystem and the stash is never part of the judged tree. A leftover from a
# run that died mid-loop is discarded first.
SUBMODULE_NODE_MODULES_KEPT=0
_nm_stash="$(dirname "$RELEASE_ROOT")/.$(basename "$RELEASE_ROOT").submodule-node-modules"
rm -rf "$_nm_stash"
if [ "$(filesystem_device "$(dirname "$RELEASE_ROOT")")" = "$(filesystem_device "$RELEASE_ROOT")" ] \
  && mkdir -p "$_nm_stash" 2>/dev/null; then
  :
else
  _nm_stash=""
fi
while IFS= read -r P; do
  [ -n "$P" ] || continue
  [ -d "$INTEGRATION_ROOT/$P" ] || { log "WARN integration submodule missing: $P — skipping"; continue; }
  # The gitlink sha recorded at the release worktree's HEAD for this path.
  S="$(git -C "$RELEASE_ROOT" ls-tree HEAD "$P" 2>/dev/null | awk '{print $3}')"
  [ -n "$S" ] || { log "WARN no gitlink sha for $P — skipping"; continue; }
  [ -z "$_nm_stash" ] || stash_pinned_submodule_node_modules "$P" "$_nm_stash"
  if clone_submodule_repo "$P" "$S"; then
    _sub_cloned=$((_sub_cloned + 1))
  else
    _sub_fallback=$((_sub_fallback + 1))
    log "WARN clone failed for $P@${S:0:10} — falling back to git archive extraction (that submodule gets NO .git, so tracked-files guards will not see inside it)"
    # P-008: capture the status instead of letting `set -e` act on it. A non-zero
    # return is now reachable (the object-sourced REFUSAL); drift on the healed
    # path is reported out-of-band via _LAST_EXTRACT_USED_LIVE_TREE so the
    # function's "never fails the caller" contract stays intact.
    _LAST_EXTRACT_USED_LIVE_TREE=0
    _extract_rc=0
    extract_submodule_source "$P" "$S" || _extract_rc=$?
    if [ "$_extract_rc" -ne 0 ]; then
      log "FATAL candidate source for $P@${S:0:10} is not materializable from git objects; aborting rather than judging a tree that matches no commit"
      exit 3
    fi
    [ "$_LAST_EXTRACT_USED_LIVE_TREE" -eq 0 ] || _sub_live_tree=$((_sub_live_tree + 1))
  fi
  [ -z "$_nm_stash" ] || restore_pinned_submodule_node_modules "$P" "$_nm_stash"
# P-009: read the submodule list from the TARGET commit's .gitmodules blob, NOT the
# integration tree's current working copy — a submodule added/removed on staging while
# the target still pins the old set would otherwise be extracted from the wrong list
# during the transition window. `git config --blob <sha>:.gitmodules` reads the committed
# config; 2>/dev/null + an empty loop is the correct no-op when a sha has no .gitmodules.
done < <(git -C "$INTEGRATION_ROOT" config --blob "${TARGET_SHA}:.gitmodules" --get-regexp '\.path$' 2>/dev/null | awk '{print $2}')
[ -z "$_nm_stash" ] || rm -rf "$_nm_stash"
log "SUBMODULE_NODE_MODULES_KEPT trees=$SUBMODULE_NODE_MODULES_KEPT (pinned-generation trees carried across the submodule re-clone)"

# 2a. Recursion sanity (EI-19299565558496583) ---------------------------------
# The defect this replaced was SILENT — no error, just a smaller file list — and
# that is precisely why it survived long enough to hide ~32% of the tree from the
# gate. Log the real numbers on EVERY run so a regression shows up in the deploy
# log immediately, instead of surfacing months later as a guard that mysteriously
# stopped finding things.
#
# Deliberately NON-FATAL: a deploy must never be wedged by a reporting check, and
# the archive fallback above still yields correct CONTENT (only recursion is
# lost). Hard enforcement belongs to the gate's own scan-sanity floor
# (prompt-blueprint-verb-catalog.test.ts), which fails loudly by design.
_plain="$(git -C "$RELEASE_ROOT" ls-files 2>/dev/null | wc -l | tr -d ' ')"
_recursive="$(git -C "$RELEASE_ROOT" ls-files --recurse-submodules 2>/dev/null | wc -l | tr -d ' ')"
_uninit="$(git -C "$RELEASE_ROOT" submodule status 2>/dev/null | grep -c '^-' || true)"
log "submodule recursion: cloned=$_sub_cloned archive-fallback=$_sub_fallback tracked plain=$_plain recursive=$_recursive uninitialized=$_uninit"
# P-008: machine-readable SOURCE-integrity marker, the deliberate peer of the
# DEPENDENCY_GENERATION_PIN line the checkpoint already parses and asserts. Emitted
# on EVERY source materialization so the answer to "was this candidate built purely
# from git objects?" is a greppable fact in the run log rather than an inference
# from the absence of a WARN. `live_tree=` is the number that matters: non-zero
# means the tree carries content belonging to no commit.
log "CANDIDATE_SOURCE_INTEGRITY mode=$SOURCE_INTEGRITY_MODE object_sourced=$((_sub_cloned + _sub_fallback - _sub_live_tree)) cloned=$_sub_cloned archive=$((_sub_fallback - _sub_live_tree)) live_tree=$_sub_live_tree"
if [ "$_sub_cloned" -gt 0 ] && [ "$_recursive" -le "$_plain" ]; then
  log "WARN recursion added NO files despite $_sub_cloned cloned submodule repo(s) — tracked-files guards are probably scanning the superproject only"
fi
fi

# P-007 / WI-41251: the checkpoint can now prepare the exact candidate source
# and run its related-test selector before paying for an immutable dependency
# generation or the pc-heavy exclusive materialization barrier. A zero exit from
# this mode retains the same exact-HEAD and submodule guarantees as a full setup;
# it merely stops at the boundary immediately before dependency work begins.
if [ "$SOURCE_ONLY" = "1" ]; then
  log "SETUP_RELEASE_SOURCE_ONLY ref=$REF sha=$TARGET_SHA status=ready"
  exit 0
fi

# 3. node_modules ----------------------------------------------------------
# EI-2118: list workspace packages (@papercusp/@papercup) that RESOLVE in the
# integration tree but do NOT resolve in the release tree — i.e. a release
# node_modules symlink that is MISSING or DANGLING (its target absent from the
# release tree). `need_node_modules`'s name-set `diff` below only compares ENTRY
# NAMES, and `ls` lists a dangling symlink's name just the same as a live one — so
# a release symlink that exists by name but does not resolve slips through that
# check, yet fails at require() with "Cannot find module '@papercusp/<pkg>'",
# crash-looping the operator at the restart cutover (2026-06-20 @papercusp/plugin-loader;
# same class as the 2026-06-09 @dnd-kit/core outage). `-e` FOLLOWS symlinks, so a
# missing/dangling link (or a target dir without package.json) fails it. The
# integration tree is the source of truth: a package integration itself cannot
# resolve is a pre-existing break, not this copy's regression to chase. Pure shell
# (no Node) — keeps this script standalone by design.
unresolved_workspace_pkgs() {
  local scope pkg src rel pinned_lock
  # WI-212675: the pinned lockfile, read ONCE (it is large; the loop below runs
  # per package). Empty when TARGET_SHA is unset or the ref has no lockfile —
  # in that case the workspace-membership discriminator below is skipped
  # entirely and the original strict behavior stands (fail safe: an
  # undeterminable package is still REPORTED, never silently swallowed).
  pinned_lock=""
  if [ -n "${TARGET_SHA:-}" ]; then
    pinned_lock="$(git -C "$INTEGRATION_ROOT" show "$TARGET_SHA:package-lock.json" 2>/dev/null)" || pinned_lock=""
  fi
  for scope in @papercusp @papercup; do
    [ -d "$INTEGRATION_ROOT/node_modules/$scope" ] || continue
    while IFS= read -r pkg; do
      [ -n "$pkg" ] || continue
      [ -e "$INTEGRATION_ROOT/node_modules/$scope/$pkg/package.json" ] || continue
      [ -e "$RELEASE_ROOT/node_modules/$scope/$pkg/package.json" ] && continue
      # WI-212675: a package whose SOURCE DIRECTORY exists at the pin but which
      # the pinned lockfile never links is ALSO unresolvable by design at that
      # ref — the directory landed before the pin while its `workspaces` entry
      # landed after it, so npm at TARGET_SHA would create no
      # node_modules/<scope>/<pkg> link and no pinned code can import it. The
      # ls-tree discriminator below only asks "does the source exist?", so this
      # case fell between its two branches and was misreported as a genuine
      # extraction break — crashing green-checkpoint at setup-release before a
      # single test ran, on a FROZEN candidate that could therefore never go
      # green (measured 2026-08-31: @papercusp/agent-roster vs candidate
      # 6da5cd4d). The lockfile is authoritative for what the pinned install
      # actually contains, and checking it keeps this function pure shell.
      if [ -n "$pinned_lock" ] \
         && ! printf '%s\n' "$pinned_lock" | grep -q "\"node_modules/$scope/$pkg\""; then
        continue
      fi
      # EI-13127: a package whose SOURCE is absent from the pinned target tree
      # cannot be referenced by pinned code (it post-dates the pin — the
      # integration symlink set reflects staging tip, the release source tree
      # reflects TARGET_SHA). Reporting it froze EVERY deploy (target AND
      # rollback refs alike) from the moment a new workspace package landed on
      # staging until the next green pin included it. Skip it here — the same
      # discriminator prune_post_pin_workspace_pkgs uses to drop the dangling
      # symlink. Deliberately inline (not a shared helper): both functions are
      # sed-extracted standalone by setup-release-checkout-deps.test.ts.
      # No TARGET_SHA in scope (a caller predating the pin resolution) keeps
      # the original strict behavior.
      if [ -n "${TARGET_SHA:-}" ]; then
        src="$(readlink -f "$INTEGRATION_ROOT/node_modules/$scope/$pkg" 2>/dev/null)" || src=""
        case "$src" in
          "$INTEGRATION_ROOT"/*)
            rel="${src#"$INTEGRATION_ROOT"/}"
            if [ -z "$(git -C "$INTEGRATION_ROOT" ls-tree "$TARGET_SHA" -- "$rel" 2>/dev/null)" ]; then
              continue
            fi
            ;;
        esac
      fi
      printf '%s/%s ' "$scope" "$pkg"
    done < <(ls -1 "$INTEGRATION_ROOT/node_modules/$scope" 2>/dev/null)
  done
  return 0
}

need_node_modules() {
  local copied_lock
  case "$NODE_MODULES_MODE" in
    skip) return 1 ;;
    force) return 0 ;;
    auto)
      # Copy when the release tree has no root node_modules yet, the root
      # lockfile differs (deps changed), OR the package set changed (scoped or non-scoped).
      # Scoped case (2026-06-05): a newly-added @papercusp/@papercup workspace package
      # gets a node_modules symlink the ROOT package-lock does NOT always reflect,
      # so the lockfile-only heuristic skipped the copy → "Cannot find module" crash.
      # Non-scoped case (EI-935): a newly-added non-scoped dep (e.g. lodash) is
      # missed by the scoped-package check and may not be detected by lockfile
      # comparison if the release tree's package-lock.json is missing or stale.
      [ -d "$RELEASE_ROOT/node_modules" ] || return 0
      # EI-2118: force a re-copy when any release workspace symlink is missing or
      # DANGLES (exists by name but does not resolve) — the name-set diff below
      # cannot see a broken-but-named symlink. Step 3's rm -rf + selected copy mode
      # refreshes it.
      [ -n "$(unresolved_workspace_pkgs)" ] && return 0
      # Check scoped packages (@papercusp, @papercup).
      for scope in @papercusp @papercup; do
        if ! diff -q <(ls -1 "$INTEGRATION_ROOT/node_modules/$scope" 2>/dev/null | sort) \
                     <(ls -1 "$RELEASE_ROOT/node_modules/$scope" 2>/dev/null | sort) >/dev/null 2>&1; then
          return 0
        fi
      done
      # Check non-scoped root packages (anything in node_modules/ that is NOT a scope, .bin, etc).
      # Filter out scoped dirs (@*), special files/dirs (.bin, .package-lock.json, .modules.yaml, etc).
      if ! diff -q <(ls -1 "$INTEGRATION_ROOT/node_modules" 2>/dev/null | grep -v '^@' | grep -v '^\.' | sort) \
                   <(ls -1 "$RELEASE_ROOT/node_modules" 2>/dev/null | grep -v '^@' | grep -v '^\.' | sort) >/dev/null 2>&1; then
        return 0
      fi
      # Fall back to the dependency-copy stamp under node_modules. NEVER use the pinned
      # worktree's tracked package-lock.json as this stamp: copying staging's newer lock
      # over it dirties an exact-SHA release root and destroys provenance
      # (EI-21008606412183759). The dot-prefixed marker is gitignored with node_modules
      # and records exactly which integration dependency state was copied.
      copied_lock="$RELEASE_ROOT/node_modules/.papercusp-source-package-lock.json"
      if [ -f "$INTEGRATION_ROOT/package-lock.json" ] && [ -f "$copied_lock" ]; then
        ! cmp -s "$INTEGRATION_ROOT/package-lock.json" "$copied_lock"
        return $?
      fi
      # If the lockfile comparison can't run, assume they differ and copy (fail-safe).
      if [ -f "$INTEGRATION_ROOT/package-lock.json" ]; then
        return 0
      fi
      return 1 ;;
    *) echo "[setup-release] bad --node-modules mode: $NODE_MODULES_MODE" >&2; exit 2 ;;
  esac
}

# Hardlinks require source and destination to share a filesystem. Resolve the
# nearest existing destination ancestor because the release root may not exist
# yet on a first setup. Explicit copy mode is portable across mount points and
# deliberately bypasses this guard. `filesystem_device` is shared with the
# submodule-clone path above.
assert_hardlink_compatible_roots() {
  [ "${NODE_MODULES_COPY_MODE:-hardlink}" = "hardlink" ] || return 0
  local integration_device release_device
  integration_device="$(filesystem_device "$INTEGRATION_ROOT")" || {
    echo "[setup-release] FATAL: could not determine the integration root filesystem: $INTEGRATION_ROOT" >&2
    return 1
  }
  release_device="$(filesystem_device "$RELEASE_ROOT")" || {
    echo "[setup-release] FATAL: could not determine the release root filesystem: $RELEASE_ROOT" >&2
    return 1
  }
  if [ "$integration_device" != "$release_device" ]; then
    echo "[setup-release] FATAL: hardlink node_modules copy requires integration and release roots on the same filesystem (integration=$INTEGRATION_ROOT device=$integration_device; release=$RELEASE_ROOT device=$release_device). Re-run with --node-modules-copy copy or place both roots on one filesystem." >&2
    return 1
  fi
}

# Enumerate dependency trees that belong to the PRODUCT checkout only.
#
# `.papercusp` is coordination/runtime state, not candidate source. It can contain
# full repair worktrees, each with its own root + package-local node_modules. Letting
# `find` descend there made one checkpoint recursively snapshot another checkpoint's
# dependencies (186 matches on the 2026-08-23 incident host) and exhausted setup's
# 30-minute deadline before a single test ran. `.git` is likewise checkout metadata,
# never a dependency source. Prune both at the directory boundary so their contents
# cannot be mistaken for product package-local dependencies.
#
# Named so setup-release-checkout-deps.test.ts executes the shipped predicate rather
# than carrying a second hand-maintained `find` expression.
enumerate_node_modules() {
  dependency_generation_enumerate_node_modules "${1:-$INTEGRATION_ROOT}"
}

# ONE dependency tree is current for a pinned generation when it is a real
# directory inside the release root whose own snapshot marker names exactly that
# generation.  Shared by the whole-checkout predicate below and by the per-tree
# skip in sync_one_node_modules, so both trust the same markers the same way.
# Metadata-only and fail-closed, like its callers.
pinned_generation_tree_current() {
  local dest="$1" release_real="$2" expected_identity="$3"
  local dest_real tree_marker tree_generation
  [[ "$expected_identity" =~ ^v1-[0-9a-f]{64}$ ]] || return 1
  [ -n "$release_real" ] || return 1
  [ -d "$dest" ] && [ ! -L "$dest" ] || return 1
  # Reject a real directory reached through a symlinked ancestor.  Checking
  # only `-L "$dest"` would let `$release_root/packages` (or a workspace
  # parent) redirect the supposedly isolated dependency tree elsewhere.
  dest_real="$(realpath "$dest" 2>/dev/null || true)"
  case "$dest_real" in
    "$release_real"|"$release_real"/*) ;;
    *) return 1 ;;
  esac
  tree_marker="$dest/.papercusp-isolated-snapshot"
  [ -f "$tree_marker" ] && [ ! -L "$tree_marker" ] || return 1
  tree_generation="$(awk -F= '
    $1 == "generation" { count++; value=substr($0, index($0, "=") + 1) }
    END { if (count == 1) print value }
  ' "$tree_marker")" || return 1
  [ "$tree_generation" = "$expected_identity" ]
}

# A pinned generation can be consumed directly when this checkout already
# contains every required immutable dependency tree.  The normal setup path calls
# `sync_one_node_modules` once per enumerated tree; on a cache-ready checkpoint
# that is needlessly expensive because each destination is already a
# materialization of the selected generation.  Keep this predicate deliberately
# metadata-only: it reads the small checkout marker and one small marker per
# dependency tree, never the dependency payload itself.
#
# The check is fail-closed.  A missing/malformed marker, a missing destination,
# a symlink that escapes the release root, or a tree stamped with another
# generation returns false and leaves the caller on the existing atomic
# materialization path.  Positional arguments are accepted for the extracted
# regression tests; production callers use the script globals.
pinned_dependency_generation_reuse_safe() {
  local source_root="${1:-${NODE_MODULES_SOURCE_ROOT:-}}"
  local release_root="${2:-${RELEASE_ROOT:-}}"
  local expected_identity="${3:-${PINNED_DEPENDENCY_GENERATION_ID:-}}"
  local expected_source="${4:-${DEPENDENCY_GENERATION_SOURCE_FINGERPRINT:-}}"
  local checkout_root checkout_marker marker_identity marker_source
  local release_real tree_list nm rel dest tree_count=0

  PINNED_DEPENDENCY_REUSE_TREE_COUNT=0

  # Generation selectors only emit v1/<sha256> identities and sha256 source
  # fingerprints.  Rejecting anything else keeps a malformed caller argument
  # from turning a coincidental marker into an authorization to skip copying.
  [[ "$expected_identity" =~ ^v1-[0-9a-f]{64}$ ]] || return 1
  [[ "$expected_source" =~ ^[0-9a-f]{64}$ ]] || return 1
  [ "$expected_identity" = "v1-$expected_source" ] || return 1
  [ -n "$source_root" ] && [ -n "$release_root" ] || return 1
  [ -d "$source_root" ] && [ ! -L "$source_root" ] || return 1
  release_real="$(realpath -m "$release_root" 2>/dev/null || true)"
  [ -n "$release_real" ] || return 1

  # A selected generation must be the source, never the mutable integration
  # tree.  The optional equality check is skipped only by the standalone unit
  # tests, which do not have dependency-generation selection globals.
  if [ -n "${DEPENDENCY_GENERATION_TREE:-}" ] \
    && [ "$source_root" != "$DEPENDENCY_GENERATION_TREE" ]; then
    return 1
  fi

  checkout_root="$release_root/node_modules"
  [ -d "$checkout_root" ] && [ ! -L "$checkout_root" ] || return 1
  checkout_marker="$checkout_root/.papercusp-dependency-generation"
  [ -f "$checkout_marker" ] && [ ! -L "$checkout_marker" ] || return 1

  # Require exactly one identity and source field.  `sed | head -1` would let a
  # duplicate field hide a later tampered value; the awk count makes that state
  # fail closed while still allowing future marker fields to be added.
  marker_identity="$(awk -F= '
    $1 == "identity" { count++; value=substr($0, index($0, "=") + 1) }
    END { if (count == 1) print value }
  ' "$checkout_marker")" || return 1
  marker_source="$(awk -F= '
    $1 == "source" { count++; value=substr($0, index($0, "=") + 1) }
    END { if (count == 1) print value }
  ' "$checkout_marker")" || return 1
  [ "$marker_identity" = "$expected_identity" ] || return 1
  [ "$marker_source" = "$expected_source" ] || return 1

  # Capture the tiny path list first so a failed enumerator is observable.  A
  # process-substitution loop would otherwise hide its exit status and could
  # authorize reuse after a truncated enumeration.
  tree_list="$(enumerate_node_modules "$source_root")" || return 1
  while IFS= read -r nm; do
    [ -n "$nm" ] || continue
    case "$nm" in
      "$source_root"/*) ;;
      *) return 1 ;;
    esac
    rel="${nm#"$source_root"/}"
    case "$rel" in
      ''|.|..|/*|../*|*/../*|*/..|*//*|*$'\n'*|*$'\r'*|*$'\t'*) return 1 ;;
    esac
    dest="$release_root/$rel"
    pinned_generation_tree_current "$dest" "$release_real" "$expected_identity" || return 1
    tree_count=$((tree_count + 1))
  done <<< "$tree_list"

  PINNED_DEPENDENCY_REUSE_TREE_COUNT="$tree_count"
  return 0
}

# A metadata identity for an already-materialized dependency tree. This deliberately
# avoids reading file CONTENT: the papercusp root node_modules is currently ~13 GiB /
# 323k files, and reading it merely to decide whether to avoid a copy recreates the
# page-cache/I/O surge this check exists to prevent. Path, type, mode, owner, size,
# mtime, inode, and symlink target catch every normal npm reify / patch / test mutation;
# the source is also measured before AND after materialization so a concurrent rewrite
# aborts before the atomic swap. The marker itself is excluded because it belongs to the
# snapshot, not the integration dependency tree.
node_modules_tree_fingerprint() {
  dependency_generation_tree_fingerprint "$1"
}

# ATOMIC refresh of ONE node_modules dir (infra-fail-fast — the 2026-06-25 all-pages
# connection-refused outage). The integration source is copied (hardlinks by default,
# independent files in `copy` mode) into a SIBLING temp dir FIRST, then swapped into
# place with two fast renames — so the LIVE operator always sees a COMPLETE node_modules
# and never the minute-long half-populated window an in-place `rm -rf "$dest"; cp -al
# "$src" "$dest"` opens.
#
# The window WAS the outage: a deploy `rm -rf`'d the live root node_modules and slowly
# re-`cp -al`'d it (~a minute, 100k+ files) while :3070 was still serving from it. The
# 32 cluster workers respawned mid-copy, hit MODULE_NOT_FOUND (@modelcontextprotocol/sdk,
# @papercusp/plugin-loader), exhausted the 160-respawn budget → 0 workers → connection
# refused on every page until the copy finished. Two renames shrink the exposure from
# ~a minute to the microseconds between two rename(2) syscalls — effectively zero, and a
# respawn would have to land in exactly that gap to see anything missing.
#
# Sibling temp ("$dest.deploy-tmp.$$") sits at the SAME depth as "$dest", so the workspace
# packages' RELATIVE symlinks (../../packages/X) resolve to the RELEASE tree identically
# in the temp and final locations (both cp modes preserve symlinks; the isolation
# invariant in the header note holds). `set -e` aborts on a failed cp BEFORE any swap,
# so a partial copy can never replace the live tree (fail-safe — same abort semantics as
# before).
sync_one_node_modules() {
  local src="$1" dest="$2"
  local tmp="${dest}.deploy-tmp.$$" old="${dest}.deploy-old.$$"
  local marker="$dest/.papercusp-isolated-snapshot"
  local src_before="" src_after="" dest_before="" marked_src="" marked_dest="" tmp_fingerprint=""
  # EI-202238*: package installers atomically rename transient trees such as
  # `sidecar.old.<pid>` while this script's `find` enumeration is in flight.
  # A node_modules path can therefore be real when `find` prints it and gone by
  # the time this function runs. It was never part of the stable dependency
  # tree, so skip that vanished source instead of crashing the whole release
  # gate before tests begin. A stable source disappearing is still caught by
  # the post-copy dependency gates below.
  if [ ! -d "$src" ]; then
    log "node_modules source vanished during enumeration; skipping transient path: $src"
    return 0
  fi
  rm -rf "$tmp" "$old"                 # defensive: clear this run's leftovers (crash-safety)
  mkdir -p "$(dirname "$dest")"
  dependency_generation_reap_dead_siblings "$dest"   # and dead runs' (WI-10004825)
  case "${NODE_MODULES_COPY_MODE:-hardlink}" in
    hardlink) cp -al "$src" "$tmp" ;;  # fast; source and destination share file data
    copy)
      if [ -n "${PINNED_DEPENDENCY_GENERATION_ID:-}" ]; then
        # EI-24341465306631575: a tree this checkout ALREADY materialized from the
        # same generation needs no second copy. The whole-checkout reuse predicate
        # is all-or-nothing, and the checkpoint's --source-only pass re-clones
        # every submodule (deleting the node_modules inside it), so it missed on
        # every gate run and re-copied all ~95 trees (18.5 GiB onto a root disk
        # with no reflink) to restore the ~38 that were actually gone. Skip each
        # tree that is still current; only the missing ones are materialized.
        # The source and destination must name the same tree relative to their
        # roots. That already holds for the main loop, but the runtime-workspace
        # toolchain restore resolves its two paths independently.
        if [ -n "${DEPENDENCY_GENERATION_TREE:-}" ] && [ -n "${RELEASE_ROOT:-}" ] \
          && [ "${src#"$DEPENDENCY_GENERATION_TREE"/}" != "$src" ] \
          && [ "${src#"$DEPENDENCY_GENERATION_TREE"/}" = "${dest#"$RELEASE_ROOT"/}" ] \
          && pinned_generation_tree_current "$dest" "$(realpath -m "$RELEASE_ROOT")" \
            "$PINNED_DEPENDENCY_GENERATION_ID"; then
          log "reusing pinned generation tree already current: $dest"
          PINNED_DEPENDENCY_TREES_REUSED=$(( ${PINNED_DEPENDENCY_TREES_REUSED:-0} + 1 ))
          return 0
        fi
        PINNED_DEPENDENCY_TREES_MATERIALIZED=$(( ${PINNED_DEPENDENCY_TREES_MATERIALIZED:-0} + 1 ))
        # Generation files are immutable and frozen read-only. Materialization
        # is an independent copy (a CoW clone where the filesystem supports
        # one); hardlinks are only the DEPENDENCY_GENERATION_ALLOW_HARDLINK opt-in.
        #
        # WI-474827: this branch deliberately does NOT fingerprint either tree.
        # It used to run two full `node_modules_tree_fingerprint` walks per tree
        # (source + materialized temp) — 188 walks across 94 trees, which
        # dominated checkpoint launch-to-first-test (11m29s against a <=2min
        # budget) — and NOTHING on this path consumed them: both values were
        # written into the marker below and read back only by the non-pinned
        # reuse test further down this function. A pinned tree's identity IS the
        # immutable generation id it was materialized from, which is strictly
        # stronger than re-walking content that was just materialized from that
        # same generation.
        #
        # Fail-safe for a LATER non-pinned run that reads this marker: with no
        # source=/snapshot= line, `marked_src` reads empty, the reuse test below
        # cannot match, and that run falls back to the original full independent
        # copy. The degradation is slower-but-correct — never a mixed snapshot.
        log "materializing pinned dependency generation ${PINNED_DEPENDENCY_GENERATION_ID}"
        dependency_generation_materialize_tree "$src" "$tmp"
        # Fail-closed equivalent of the fingerprint guard this replaced: that
        # guard fired precisely when the materialized tree was not a directory
        # (dependency_generation_tree_fingerprint returns 1 on a missing root,
        # which the `|| true` turned into the empty string). Assert the same
        # property directly, before any swap, without walking the tree.
        if [ ! -d "$tmp" ]; then
          rm -rf "$tmp"
          echo "[setup-release] FATAL: pinned dependency generation materialization produced no tree at $tmp" >&2
          return 1
        fi
        # Compatibility with generations published before WI-212675's marker
        # boundary: they may contain an old checkout-provenance marker frozen
        # read-only with the dependency payload. Truncating it in place fails on
        # its preserved 0444 mode, and under the hardlink opt-in would mutate the
        # immutable generation. Unlink only the TEMP tree's directory entry and
        # create this checkout's marker afresh; the generation's link remains
        # byte-for-byte untouched.
        rm -f -- "$tmp/.papercusp-isolated-snapshot"
        printf 'generation=%s\n' "$PINNED_DEPENDENCY_GENERATION_ID" \
          > "$tmp/.papercusp-isolated-snapshot"
      else
      # EI-21206772578500745 / WI-40774: `cp -a` of the unchanged 12.56 GiB root
      # tree charged ~14 GiB to the checkpoint scope and drove memory + I/O PSI
      # critical when it overlapped a broad test sweep. The prior checkpoint tree
      # is already an inode-independent snapshot. Reuse it as an immutable seed
      # only when BOTH sides still match the marker written by the prior successful
      # swap; hardlinks are then checkpoint->checkpoint, never checkpoint->integration.
      # Any source OR destination drift falls back to the original full independent
      # copy, preserving the correctness reason `copy` mode was introduced.
      src_before="$(node_modules_tree_fingerprint "$src" 2>/dev/null || true)"
      if [ -d "$dest" ] && [ -f "$marker" ]; then
        marked_src="$(sed -n 's/^source=//p' "$marker" | head -1)"
        marked_dest="$(sed -n 's/^snapshot=//p' "$marker" | head -1)"
        # WI-474827: a marker written by a PINNED run carries only generation=,
        # so both of these read empty and the reuse test below cannot match.
        # Skip the destination walk rather than compute a value nothing reads —
        # behaviour-identical, and it keeps the pinned change from adding a new
        # full walk to the run that follows it.
        if [ -n "$marked_src" ] && [ -n "$marked_dest" ]; then
          dest_before="$(node_modules_tree_fingerprint "$dest" 2>/dev/null || true)"
        fi
      fi
      if [ -n "$src_before" ] && [ "$src_before" = "$marked_src" ] \
        && [ -n "$dest_before" ] && [ "$dest_before" = "$marked_dest" ]; then
        log "reusing unchanged isolated node_modules snapshot (metadata-only hardlink seed)"
        cp -al "$dest" "$tmp"
      else
        log "isolated node_modules snapshot missing or drifted; performing full independent copy"
        cp -a "$src" "$tmp"
      fi

      # Do not publish a mixed snapshot if npm/test tooling rewrote the source
      # while we were materializing. The old complete destination is still live
      # here; removing tmp and failing is the safe, retryable outcome.
      src_after="$(node_modules_tree_fingerprint "$src" 2>/dev/null || true)"
      if [ -z "$src_before" ] || [ "$src_after" != "$src_before" ]; then
        rm -rf "$tmp"
        echo "[setup-release] FATAL: integration node_modules changed during isolated snapshot materialization — preserving the previous checkpoint tree and refusing a mixed dependency snapshot" >&2
        return 75
      fi
      tmp_fingerprint="$(node_modules_tree_fingerprint "$tmp" 2>/dev/null || true)"
      [ -n "$tmp_fingerprint" ] || {
        rm -rf "$tmp"
        echo "[setup-release] FATAL: could not fingerprint isolated node_modules snapshot before swap" >&2
        return 1
      }
      printf 'source=%s\nsnapshot=%s\n' "$src_after" "$tmp_fingerprint" \
        > "$tmp/.papercusp-isolated-snapshot"
      fi
      ;;
    *) echo "[setup-release] bad --node-modules-copy mode: ${NODE_MODULES_COPY_MODE}" >&2; return 2 ;;
  esac
  if [ -e "$dest" ]; then
    mv "$dest" "$old"                  # instant rename
    mv "$tmp" "$dest"                  # instant rename — ONLY these two bracket the swap
    rm -rf "$old"                      # cleanup; the new tree is already live
  else
    mv "$tmp" "$dest"                  # first-time create: a single rename
  fi
}

# Persist which dependency state was materialized. An empty immutable generation
# legitimately enumerates zero node_modules trees (for example, a non-Node Pot),
# so the copy loop above may create no destination at all. Metadata recording must
# establish its own parent instead of assuming a root dependency tree was copied.
record_node_modules_copy_metadata() {
  local metadata_root="$RELEASE_ROOT/node_modules"
  mkdir -p "$metadata_root"
  # WI-10004928 part 7: a REUSED immutable generation carries both markers
  # read-only (0444). A plain `cp` / `>` onto one fails EACCES and the verify
  # ends verdictless. Unlink first (needs only directory write), so each write
  # creates a fresh file. Never chmod the inherited file in place: it may be a
  # hard link into the immutable generation store.
  if [ -f "$INTEGRATION_ROOT/package-lock.json" ]; then
    rm -f "$metadata_root/.papercusp-source-package-lock.json"
    cp "$INTEGRATION_ROOT/package-lock.json" "$metadata_root/.papercusp-source-package-lock.json"
  fi
  if [ -n "${PINNED_DEPENDENCY_GENERATION_ID:-}" ]; then
    rm -f "$metadata_root/.papercusp-dependency-generation"
    printf 'identity=%s\nsource=%s\n' \
      "$PINNED_DEPENDENCY_GENERATION_ID" "$DEPENDENCY_GENERATION_SOURCE_FINGERPRINT" \
      > "$metadata_root/.papercusp-dependency-generation"
    log "DEPENDENCY_GENERATION_PIN identity=$PINNED_DEPENDENCY_GENERATION_ID"
  fi
}

if need_node_modules; then
  NODE_MODULES_SOURCE_ROOT="$INTEGRATION_ROOT"
  if [ "$NODE_MODULES_COPY_MODE" = "copy" ] && [ "$NODE_MODULES_GENERATION_MODE" = "required" ]; then
    DEPENDENCY_GENERATION_ROOT="$(dependency_generation_resolve_root "$INTEGRATION_ROOT" "$DEPENDENCY_GENERATION_ROOT")"
    dependency_generation_configure_workspace_dirs \
      "$INTEGRATION_ROOT" "${NODE_MODULES_WORKSPACE_DIRS[@]}"
    if [ -n "$NODE_MODULES_GENERATION_ID" ]; then
      # Lease BEFORE the full validation walk. Otherwise a retention pass can
      # remove this exact identity between selection and materialization.
      if [ -z "${DEPENDENCY_GENERATION_SELECTOR_LEASE:-}" ]; then
        dependency_generation_acquire_selector_lease "$DEPENDENCY_GENERATION_ROOT" "$NODE_MODULES_GENERATION_ID"
      fi
      if [ -n "$NODE_MODULES_GENERATION_TOKEN" ]; then
        dependency_generation_select_prevalidated \
          "$DEPENDENCY_GENERATION_ROOT" "$NODE_MODULES_GENERATION_ID" \
          "$NODE_MODULES_GENERATION_TOKEN"
      else
        dependency_generation_select "$DEPENDENCY_GENERATION_ROOT" "$NODE_MODULES_GENERATION_ID"
      fi
    else
      dependency_generation_ensure "$INTEGRATION_ROOT" "$DEPENDENCY_GENERATION_ROOT"
      dependency_generation_acquire_selector_lease "$DEPENDENCY_GENERATION_ROOT" "$DEPENDENCY_GENERATION_ID"
    fi
    PINNED_DEPENDENCY_GENERATION_ID="$DEPENDENCY_GENERATION_ID"
    NODE_MODULES_SOURCE_ROOT="$DEPENDENCY_GENERATION_TREE"
    dependency_generation_apply_retention "$DEPENDENCY_GENERATION_ROOT" "$INTEGRATION_ROOT"
    log "pinned immutable dependency generation $PINNED_DEPENDENCY_GENERATION_ID (reused=$DEPENDENCY_GENERATION_REUSED)"
  fi
  if pinned_dependency_generation_reuse_safe; then
    log "DEPENDENCY_GENERATION_CHECKOUT_REUSE status=hit identity=$PINNED_DEPENDENCY_GENERATION_ID trees=$PINNED_DEPENDENCY_REUSE_TREE_COUNT (all structural markers match; skipping materialization)"
  else
    # Any incomplete or contradictory marker state takes the historical path.
    # That path materializes each source into a sibling temp and atomically swaps
    # it into place, so a reuse miss never weakens the existing isolation/swap
    # guarantees.
    if [ -n "${PINNED_DEPENDENCY_GENERATION_ID:-}" ]; then
      log "DEPENDENCY_GENERATION_CHECKOUT_REUSE status=miss identity=$PINNED_DEPENDENCY_GENERATION_ID (materializing dependency trees)"
    fi
    assert_hardlink_compatible_roots
    log "${NODE_MODULES_COPY_MODE}-copying node_modules from dependency source (atomic swap; this can take a minute)"
    # Enumerate every package-local node_modules in the integration tree (prune so
    # we get the dir itself, not the ones nested inside it — those ride along in the
    # parent's selected cp mode). Each is refreshed via an atomic sibling-temp swap (above).
    PINNED_DEPENDENCY_TREES_REUSED=0
    PINNED_DEPENDENCY_TREES_MATERIALIZED=0
    while IFS= read -r nm; do
      rel="${nm#"$NODE_MODULES_SOURCE_ROOT"/}"
      sync_one_node_modules "$nm" "$RELEASE_ROOT/$rel"
    done < <(enumerate_node_modules "$NODE_MODULES_SOURCE_ROOT")
    if [ -n "${PINNED_DEPENDENCY_GENERATION_ID:-}" ]; then
      log "DEPENDENCY_GENERATION_TREE_REUSE identity=$PINNED_DEPENDENCY_GENERATION_ID reused=$PINNED_DEPENDENCY_TREES_REUSED materialized=$PINNED_DEPENDENCY_TREES_MATERIALIZED"
    fi
  fi
  # Record WHICH dep state was just copied without touching pinned tracked source.
  # The marker is inside gitignored node_modules and is consumed by
  # need_node_modules() above on the next auto pass.
  record_node_modules_copy_metadata
  if [ -n "${PINNED_DEPENDENCY_GENERATION_ID:-}" ]; then
    # Publish the durable checkout pin before releasing the live selector lease;
    # retention therefore sees at least one protector at every instant.
    dependency_generation_register_pin \
      "$DEPENDENCY_GENERATION_ROOT" "$RELEASE_ROOT" "$PINNED_DEPENDENCY_GENERATION_ID"
    dependency_generation_release_selector_lease
  fi
  log "node_modules sync complete"
else
  log "node_modules up to date (mode=$NODE_MODULES_MODE) — skipping copy"
fi

# A generation is immutable and frozen read-only, and materialization preserves
# those modes (an independent copy by default; shared inodes under the hardlink
# opt-in). Copy up only the dependency packages a later setup phase must mutate
# (patch-package or a native-addon rebuild) into writable independent files,
# leaving the generation and the rest of the ~13 GiB tree untouched.
copy_up_generation_dependency_path() {
  local path="$1"
  [ -n "${PINNED_DEPENDENCY_GENERATION_ID:-}" ] || return 0
  [ -d "$path" ] || return 0
  local tmp old
  tmp="${path}.copy-up.$$"
  old="${path}.copy-up-old.$$"
  rm -rf "$tmp" "$old"
  dependency_generation_copy_independent "$path" "$tmp"
  chmod -R u+w "$tmp"
  mv "$path" "$old"
  mv "$tmp" "$path"
  chmod -R u+w "$old" 2>/dev/null || true
  rm -rf "$old"
}

copy_up_generation_patch_targets() {
  [ -n "${PINNED_DEPENDENCY_GENERATION_ID:-}" ] || return 0
  [ -d "$RELEASE_ROOT/patches" ] || return 0
  local package_path
  while IFS= read -r package_path; do
    [ -n "$package_path" ] || continue
    log "copying up generation-backed patch target $package_path"
    copy_up_generation_dependency_path "$RELEASE_ROOT/node_modules/$package_path"
  done < <(
    find "$RELEASE_ROOT/patches" -type f -name '*.patch' -exec \
      awk '/^diff --git a\/node_modules\// { path=$3; sub(/^a\/node_modules\//, "", path); n=split(path, p, "/"); if (p[1] ~ /^@/ && n > 1) print p[1] "/" p[2]; else print p[1] }' {} + \
      | LC_ALL=C sort -u
  )
}
copy_up_generation_patch_targets

# 3a½. pnpm-debris self-heal ---------------------------------------------------
# A release/checkpoint tree never runs installs, so a .pnpm virtual store that is
# absent from the integration source is stale debris and must not linger forever.
# But co-hosted app harnesses may legitimately use pnpm: their top-level package
# symlinks resolve THROUGH node_modules/.pnpm. Removing a store that was copied from
# such an integration tree leaves every symlink present-by-name but dangling (the
# SideStage TypeScript pre-test red, WI-39301). Preserve source-backed stores; prune
# only release-only debris. Papercusp's no-pnpm-hijack test remains the policy guard
# for its own npm-only integration tree.
prune_stale_pnpm_store() {
  if [ -d "$RELEASE_ROOT/node_modules/.pnpm" ] && [ ! -d "$INTEGRATION_ROOT/node_modules/.pnpm" ]; then
    log "removing release-only node_modules/.pnpm (stale pnpm debris absent from integration source)"
    rm -rf "$RELEASE_ROOT/node_modules/.pnpm"
  elif [ -d "$RELEASE_ROOT/node_modules/.pnpm" ]; then
    log "preserving source-backed node_modules/.pnpm virtual store"
  fi
}
prune_stale_pnpm_store

# 3a¾. Pinned-lockfile reconcile (WI-10003918) --------------------------------
# The live-tree copy above installs STAGING's dependency set, not the target's.
# A dependency removed or re-versioned on staging after the pin is therefore
# missing from the release tree, and with freeze-and-converge main trails staging
# by hours: @mdxeditor/editor's removal failed the SPA build of green pin 9a9473af
# AND of the rollback to the serving sha (2026-09-29). pinned-lock-deps.mjs checks
# only the paths where the pinned lock and the integration lock disagree, and
# backfills each one at its pinned version from an immutable dependency
# generation. Runs BEFORE patch-package so a backfilled package is patched too.
# Skipped for a pinned generation (already exact) and for --node-modules skip.
# Unresolved drift WARNS rather than aborts: a drifted package nothing imports
# must not freeze a deploy that works today; one that is imported fails the SPA
# build or boot below, now with its name already in this log. Named function
# for sed-extraction unit tests (setup-release-checkout-deps.test.ts pattern).
reconcile_pinned_lock_deps() {
  local pinned_lock out rc=0
  local helper="${PINNED_LOCK_DEPS_HELPER:-$_HERE/pinned-lock-deps.mjs}"
  [ -z "${PINNED_DEPENDENCY_GENERATION_ID:-}" ] || return 0
  [ "${NODE_MODULES_MODE:-auto}" != "skip" ] || return 0
  [ -n "${TARGET_SHA:-}" ] || return 0
  [ -f "$INTEGRATION_ROOT/package-lock.json" ] || return 0
  pinned_lock="${TMPDIR:-/tmp}/setup-release-pinned-lock.$$.json"
  if ! git -C "$INTEGRATION_ROOT" show "$TARGET_SHA:package-lock.json" >"$pinned_lock" 2>/dev/null; then
    rm -f "$pinned_lock"
    return 0
  fi
  # `&& rc=0 || rc=$?` keeps a non-zero helper exit from tripping set -e.
  out="$(node "$helper" \
    --pinned-lock "$pinned_lock" \
    --integration-lock "$INTEGRATION_ROOT/package-lock.json" \
    --release "$RELEASE_ROOT" \
    --generations "$(dependency_generation_resolve_root "$INTEGRATION_ROOT" "$DEPENDENCY_GENERATION_ROOT")" \
    --backfill 2>&1)" && rc=0 || rc=$?
  rm -f "$pinned_lock"
  [ -z "$out" ] || while IFS= read -r line; do log "$line"; done <<<"$out"
  if [ "$rc" = "3" ]; then
    log "WARN pinned-lock drift unresolved: the release tree lacks dependencies the target ${TARGET_SHA:0:10} lockfile pins (named above) and no dependency generation holds them"
  elif [ "$rc" != "0" ]; then
    log "WARN pinned-lock reconcile did not run cleanly (exit $rc); continuing with the copied tree"
  fi
  return 0
}
reconcile_pinned_lock_deps

# 3b. Dependency patches (patch-package) -------------------------------------
# patch-package patches apply at INSTALL time, but this tree never `npm install`s
# — it copies node_modules from the integration tree (step 3). That copy
# carries the integration tree's already-patched files WHEN it runs, but the
# `auto` heuristic skips the copy on a patches-only change (a new patch alters no
# lockfile / workspace-package set), and in the live release's default hardlink mode
# an integration file edited in place gets a NEW inode the pre-existing hardlink never
# tracked — so that tree's node_modules can be left UNPATCHED. Re-apply committed patches
# here (idempotent; the same
# patch-package the repo's postinstall uses). Without it a committed dependency
# patch (e.g. the EI-127 mcp-handler per-request-server leak fix) silently reaches
# NEITHER the deployed operator NOR the green-checkpoint tree — which then reds on
# the patch's own regression test, blocking every deploy. Non-fatal by design: a
# patch hiccup must never wedge the deploy.
if [ -d "$RELEASE_ROOT/patches" ] && [ -x "$RELEASE_ROOT/node_modules/.bin/patch-package" ]; then
  log "applying committed dependency patches (patch-package)"
  # Keep patch-package's own report instead of discarding it. This WARN exists
  # precisely to flag a patch that did NOT apply, and `1>/dev/null 2>&1` threw away
  # the only output naming WHICH one — so the warning could never be acted on without
  # re-deriving applied-ness by hand against the release tree, patch by patch
  # (measured 2026-09-17 during the 0.0.21-alpha cut: the sole failure turned out to
  # be an orphaned patch for a package installed in no tree, but establishing that
  # took several probes the suppressed output would have answered outright).
  # Still non-fatal by design: a patch hiccup must never wedge the deploy.
  _pp_log="${TMPDIR:-/tmp}/setup-release-patch-package.$$.log"
  if (cd "$RELEASE_ROOT" && ./node_modules/.bin/patch-package) >"$_pp_log" 2>&1; then
    rm -f "$_pp_log"
  else
    log "WARN patch-package reported issues (continuing) — full output: $_pp_log"
    _pp_shown=0
    while IFS= read -r _pp_line; do
      if [ -n "$_pp_line" ]; then
        if [ "$_pp_shown" -lt 40 ]; then
          log "WARN   $_pp_line"
          _pp_shown=$((_pp_shown + 1))
        fi
      fi
    done < "$_pp_log"
  fi
fi

# 3b-2. Post-pin package prune (EI-13127) — a dangling release symlink has TWO
# causes with OPPOSITE correct handling, and the fatal gate below cannot tell
# them apart on its own:
#   (a) the package's source IS in the target ref but extraction/copy failed →
#       pinned code may require() it → crash-loop risk → FATAL is correct;
#   (b) the package was added to staging AFTER the target ref was pinned (the
#       integration node_modules symlink set always reflects staging tip, the
#       release source tree reflects the PIN) → pinned code cannot possibly
#       import a package that did not exist when it was committed → the dangling
#       name is inert, and fataling on it froze EVERY deploy (target AND
#       rollback refs both predate the package) until the next green pin — a
#       multi-hour deploy freeze re-opened by every new workspace package
#       (2026-07-16 @papercusp/release-profile: :3070 stuck 13 commits behind
#       a green pin). Discriminate with the pin itself: the integration
#       symlink's repo-relative source path present in TARGET_SHA ⇒ case (a),
#       leave for the gate; absent ⇒ case (b), prune the dangling symlink and
#       log. Named function for sed-extraction unit tests
#       (setup-release-checkout-deps.test.ts pattern).
prune_post_pin_workspace_pkgs() {
  local scope pkg src rel pinned_lock
  # WI-212675: same hoisted pinned lockfile + fail-safe semantics as
  # unresolved_workspace_pkgs (kept inline, not shared: both functions are
  # sed-extracted standalone by setup-release-checkout-deps.test.ts).
  pinned_lock=""
  if [ -n "${TARGET_SHA:-}" ]; then
    pinned_lock="$(git -C "$INTEGRATION_ROOT" show "$TARGET_SHA:package-lock.json" 2>/dev/null)" || pinned_lock=""
  fi
  for scope in @papercusp @papercup; do
    [ -d "$INTEGRATION_ROOT/node_modules/$scope" ] || continue
    while IFS= read -r pkg; do
      [ -n "$pkg" ] || continue
      # Same predicate as unresolved_workspace_pkgs: resolves in integration…
      [ -e "$INTEGRATION_ROOT/node_modules/$scope/$pkg/package.json" ] || continue
      # …but not in the release tree.
      [ -e "$RELEASE_ROOT/node_modules/$scope/$pkg/package.json" ] && continue
      # WI-212675: source present at the pin but never linked by the pinned
      # lockfile ⇒ not a workspace at TARGET_SHA ⇒ post-pin in every sense that
      # matters. Drop any dangling release-tree entry and skip the fatal gate,
      # exactly as for a source that post-dates the pin.
      if [ -n "$pinned_lock" ] \
         && ! printf '%s\n' "$pinned_lock" | grep -q "\"node_modules/$scope/$pkg\""; then
        rm -rf "$RELEASE_ROOT/node_modules/$scope/$pkg"
        log "pruned post-pin workspace package $scope/$pkg (not linked by the target ref ${TARGET_SHA:0:10} lockfile — its workspaces entry post-dates the pin; pinned code cannot import it)"
        continue
      fi
      # Repo-relative source path via the integration symlink target.
      src="$(readlink -f "$INTEGRATION_ROOT/node_modules/$scope/$pkg" 2>/dev/null)" || continue
      [ -n "$src" ] || continue
      case "$src" in
        "$INTEGRATION_ROOT"/*) rel="${src#"$INTEGRATION_ROOT"/}" ;;
        *) continue ;;
      esac
      # Present in the pinned tree (plain dir OR submodule gitlink)? Then this
      # is case (a) — a genuine extraction break; leave it for the fatal gate.
      if [ -n "$(git -C "$INTEGRATION_ROOT" ls-tree "$TARGET_SHA" -- "$rel" 2>/dev/null)" ]; then
        continue
      fi
      rm -rf "$RELEASE_ROOT/node_modules/$scope/$pkg"
      log "pruned post-pin workspace package $scope/$pkg (source $rel absent from target ref ${TARGET_SHA:0:10} — added to staging after the pin; pinned code cannot import it)"
    done < <(ls -1 "$INTEGRATION_ROOT/node_modules/$scope" 2>/dev/null)
  done
  return 0
}
prune_post_pin_workspace_pkgs

# 3c. Workspace-resolution gate (EI-2118) — fail the swap BEFORE any restart ---
# A workspace package the release tree cannot resolve is invisible until the
# operator boots and crash-loops on "Cannot find module", which then health-fails
# into a rollback FLAP (fbd1c134<->0a5d3074, 2026-06-20). The deploy's verify-paths
# step runs only AFTER the restart cutover, so it cannot prevent that. Catch it
# HERE, loudly, while the live operator is still untouched: if step 3 left (or, in
# mode=skip, never synced) any package that resolves in the integration tree but
# not in the release tree, abort non-zero so the deploy's `swap` step fails cleanly
# (no migrate, no restart) instead of cutting over to a tree that cannot boot. In
# `auto` mode step 3's copy already re-links any break, so this should only ever
# fire when the copy genuinely could not produce a resolvable tree. Post-pin
# packages (case (b) above) were pruned by prune_post_pin_workspace_pkgs, so a
# hit here is a REAL in-pin resolution break.
unresolved="$(unresolved_workspace_pkgs)"
if [ -n "$unresolved" ]; then
  echo "[setup-release] FATAL: release tree cannot resolve workspace package(s): $unresolved" >&2
  echo "[setup-release] aborting BEFORE restart — the swapped tree would crash-loop the operator" >&2
  echo "[setup-release] (re-run with --node-modules force to rebuild node_modules from the integration tree)" >&2
  exit 1
fi

# 3c-2. Pinned workspace RUNTIME BUILDS --------------------------------------
# EI-20453835015280838: workspace symlinks resolve into the RELEASE tree, not
# the integration tree (the isolation guarantee in this script's header). That
# matters for submodule packages whose runtime entry points are generated and
# gitignored. `libs/generic/sse`, for example, commits `src/` but intentionally
# exposes CommonJS `require`/`default` entries from `dist/`. Step 2 clones the
# exact pinned submodule SHA and step 1 correctly removes ignored output from a
# prior pin, so a release checkout has NO `dist/` until it is rebuilt. Staging
# masks the defect because its developer tree already has a locally-built dist;
# tests/typechecks use the package's `import: ./src/index.ts` condition, while
# the real operator boot reaches `require: ./dist/index.js` and fails only in
# the pre-cutover preflight.
#
# Build from the PINNED release source. Never copy these outputs from the
# integration tree: a submodule may already have moved past TARGET_SHA, and
# copying its ignored dist would mix two source revisions in one deployment.
# The registry is deliberately explicit and is policed repository-wide by
# setup-release-checkout-workspace-builds.test.ts: any new workspace package
# that exposes a gitignored `main`/`require`/`default` target must be registered
# here or that detector fails before the same class can reach deploy again.
RUNTIME_BUILD_WORKSPACES=(
  "@papercusp/omp"
  "@papercusp/sse"
)

build_pinned_workspace_runtime_outputs() {
  local workspace scope package manifest integration_workspace_root release_workspace_root
  local dependency_workspace_node_modules
  for workspace in "${RUNTIME_BUILD_WORKSPACES[@]}"; do
    scope="${workspace%%/*}"
    package="${workspace#*/}"
    manifest="$RELEASE_ROOT/node_modules/$scope/$package/package.json"

    # Rollback refs may predate a registered workspace. The post-pin prune
    # above already removes its dangling symlink; absence here is therefore an
    # expected no-op, not a reason an old known-good pin should become
    # undeployable.
    if [ ! -e "$manifest" ]; then
      log "pinned runtime workspace $workspace absent at ${TARGET_SHA:0:10} — skipping build"
      continue
    fi

    # A submodule can exist at an older rollback pin before the root manifest
    # registered it as an npm workspace. `npm --workspace ... run build` is not
    # valid there even though node_modules still exposes the package symlink.
    # Treat root workspace membership—not source-directory presence—as the
    # compatibility boundary, so a forward-only registry never makes a known-
    # good older release impossible to restore.
    if ! (cd "$RELEASE_ROOT" && npm --workspace "$workspace" pkg get name >/dev/null 2>&1); then
      log "pinned runtime workspace $workspace is not registered at ${TARGET_SHA:0:10} — skipping build"
      continue
    fi

    # Step 2 replaces submodule source wholesale, including its gitignored
    # package-local node_modules. If the root dependency snapshot was otherwise
    # unchanged, step 3 legitimately skips its global refresh and the package
    # build silently falls back to the root toolchain (TypeScript 6 instead of
    # @papercusp/sse's pinned 5.9 in the incident that earned this guard).
    # Restore the workspace-local dependency tree explicitly, using the same
    # atomic copier and selected mode as the root refresh. This remains source-consistent:
    # all release node_modules are sourced from the integration dependency
    # snapshot; only package SOURCE is pinned independently.
    integration_workspace_root="$(readlink -f "$INTEGRATION_ROOT/node_modules/$scope/$package" 2>/dev/null || true)"
    release_workspace_root="$(readlink -f "$RELEASE_ROOT/node_modules/$scope/$package" 2>/dev/null || true)"
    if [ -n "$integration_workspace_root" ] && [ -d "$integration_workspace_root/node_modules" ]; then
      case "$integration_workspace_root:$release_workspace_root" in
        "$INTEGRATION_ROOT"/*:"$RELEASE_ROOT"/*)
          log "restoring package-local toolchain for $workspace"
          dependency_workspace_node_modules="$integration_workspace_root/node_modules"
          if [ -n "${PINNED_DEPENDENCY_GENERATION_ID:-}" ]; then
            dependency_workspace_node_modules="$DEPENDENCY_GENERATION_TREE/${integration_workspace_root#"$INTEGRATION_ROOT"/}/node_modules"
            [ -d "$dependency_workspace_node_modules" ] || {
              echo "[setup-release] FATAL: pinned dependency generation $PINNED_DEPENDENCY_GENERATION_ID is missing the package-local toolchain for $workspace" >&2
              return 1
            }
          fi
          sync_one_node_modules "$dependency_workspace_node_modules" "$release_workspace_root/node_modules"
          ;;
        *)
          echo "[setup-release] FATAL: runtime workspace $workspace resolves outside the integration/release roots — refusing a cross-tree toolchain copy" >&2
          return 1
          ;;
      esac
    fi

    log "building pinned runtime output for $workspace"
    # Keep build stdout visible on failure. TypeScript reports diagnostics on
    # stdout, and discarding it reduced the original deploy failure to an opaque
    # lifecycle exit code with no actionable file/line evidence.
    if ! (cd "$RELEASE_ROOT" && npm --workspace "$workspace" run build); then
      echo "[setup-release] FATAL: pinned runtime build failed for $workspace at ${TARGET_SHA:0:10} — refusing a release tree whose declared runtime entry points may be absent" >&2
      return 1
    fi
  done
}
build_pinned_workspace_runtime_outputs

# 3d. Native-addon ABI guard (infra-fail-fast-build-integrity-2026-06-19 P-003) -
# The copied node_modules (step 3) carry whatever Node ABI the
# INTEGRATION tree was built under. If that differs from the RUNTIME Node, the
# broken binary ships to green: the 2026-06-19 outage was better-sqlite3 built
# for Node 22 (ABI 127) while the service runs Node 25 (ABI 141) → "Module did
# not self-register", mem0 never came up, every memory-touching handler hung
# behind a green health check. The pin (.nvmrc / package.json engines = Node 25)
# + dropping nvm22 from the unit PATH make a mismatch unlikely; THIS makes the
# refresh SELF-HEAL it: verify each runtime-critical native addon LOADS under the
# same `node` the operator boots with, and `npm rebuild` it in place on a
# mismatch so the release checkout's binary always matches the runtime ABI.
# Cheap when already correct (load-check only — no rebuild). Non-fatal: the
# deploy-gate native-addon preflight (lib/native-addon-preflight.ts) is the hard
# block; this turns that block into auto-recovery. Addon set mirrors the
# preflight's DEFAULT_REQUIRED_ADDONS (env override PAPERCUSP_PREFLIGHT_ADDONS).
# Named function so it can be extracted + unit-tested in setup-release-checkout-deps.test.ts
# (same sed-extraction pattern as need_node_modules / sync_one_node_modules).
# Reads RELEASE_ROOT + PAPERCUSP_PREFLIGHT_ADDONS from the outer scope.
rebuild_stale_native_addons() {
  command -v node >/dev/null 2>&1 || { log "skip native-addon ABI guard (node not on PATH — pre-build phase)"; return 0; }
  local node_abi
  node_abi="$(node -p 'process.versions.modules' 2>/dev/null || echo '?')"
  local -a _addons
  IFS=',' read -ra _addons <<< "${PAPERCUSP_PREFLIGHT_ADDONS:-better-sqlite3}"
  local addon _result=0
  for addon in "${_addons[@]}"; do
    addon="${addon//[[:space:]]/}"   # trim whitespace
    [ -n "$addon" ] || continue
    [ -d "$RELEASE_ROOT/node_modules/$addon" ] || continue   # not installed on this path
    if (cd "$RELEASE_ROOT" && node -e "require('$addon')") >/dev/null 2>&1; then
      continue   # loads cleanly under the runtime Node — ABI matches, nothing to do
    fi
    log "WARN native addon '$addon' will not load under Node ABI $node_abi — rebuilding in the release checkout"
    copy_up_generation_dependency_path "$RELEASE_ROOT/node_modules/$addon"
    if (cd "$RELEASE_ROOT" && npm rebuild "$addon") >/dev/null 2>&1 \
       && (cd "$RELEASE_ROOT" && node -e "require('$addon')") >/dev/null 2>&1; then
      log "native addon '$addon' rebuilt OK for Node ABI $node_abi"
    else
      log "ERROR native addon '$addon' STILL will not load after rebuild — the deploy-gate addon preflight will block this promotion"
      _result=1
    fi
  done
  return $_result
}
rebuild_stale_native_addons

# 3b. Gitignored RUNTIME ASSETS under apps/operator/public --------------------
# EI-19373176486666620. Step 1's `clean -fdqx -e node_modules` is deliberately
# total (WI-5366: a stale gitignored cache from a PRIOR checkout at a DIFFERENT
# sha is a correctness risk), but it cannot tell a stale CACHE from a required
# RUNTIME ASSET — and `apps/operator/public/` is full of the latter: vditor,
# porcupine, excalidraw, monaco and the ort-wasm-* blobs are ALL gitignored,
# provisioned by apps/operator/scripts/setup-*-runtime.sh via postinstall.
#
# So the gate's tree never had them, and a test that asserts one can NEVER pass
# here however many times it is re-fired. Observed live 2026-08-02: candidate
# 38ae7faf went red on `vditor mirror missing at .../public/vditor/dist/js/lute/
# lute.min.js` (vditor-cdn.test.ts, WI-7088) — a permanent red-pin on main for
# the whole fleet, not a flake. porcupine-cdn.test.ts asserts the same shape.
#
# Same treatment node_modules already gets in step 3, and for the same stated
# reason ("untracked by design"): provision from the integration tree rather
# than re-download. Copy locally (a real copy, not a hard link: WI-10004321,
# below) — lute.min.js alone is ~3.9MB and the gate host is not reliably networked, so re-running the setup scripts here would
# trade a deterministic red for a flaky one.
#
# ONLY fills entries MISSING from the release tree, so anything tracked at
# TARGET_SHA always wins; every failure is non-fatal (a missing asset must
# surface as the owning test's red, never as an aborted tree setup).
#
# WI-10004073: every path must produce the SAME tree. The old
# `cp -al SRC DST || cp -a SRC DST` did not: across filesystems `cp -al` fails
# with EXDEV only AFTER creating DST, so the `cp -a` fallback copied INTO it and
# shipped public/wake-runtime/wake-runtime/… (spa/wake-runtime had no top-level
# ORT files; wake-word + VAD broken) on any release root not on the integration
# tree's filesystem, e.g. /mnt/data. provision_runtime_asset stages each attempt
# at a path that does not exist yet, discards a partial hard-link tree before
# copying, and renames into place, so the fallback can never nest. Staging
# lives in PROVISION_STAGE_DIR (outside public/, same filesystem as DST) so a
# crash mid-copy cannot leave a half tree that vite would ship.
#
# WI-10004321: a REAL copy (`cp -a`), never a hard link (`cp -al`). A hard link
# shares one inode between the integration tree and this release tree, and the
# setup-*-runtime.sh postinstall scripts used to rewrite these files IN PLACE
# (`cp`/`cp -f` open an existing destination with O_TRUNC). So a canonical
# `npm install` or vite rebuild silently rewrote the published and in-flight
# release trees' assets (measured 2026-09-30: silero_vad_v5.onnx was one inode
# with 11 links across canonical, relcut-0024/0025/0026). The writers now unlink
# first, and this copy removes the sharing at the source, so neither side alone
# has to be right. The cost is disk (~320 MB of real runtime assets per tree).
provision_runtime_asset() {
  _pra_src="$1"
  _pra_dst="$2"
  _pra_stage="${PROVISION_STAGE_DIR:-$(dirname "$_pra_dst")}"
  _pra_tmp="$_pra_stage/.provision.$$.$(basename "$_pra_dst")"
  mkdir -p "$(dirname "$_pra_dst")" "$_pra_stage" 2>/dev/null || return 1
  rm -rf -- "$_pra_tmp"
  if ! cp -a "$_pra_src" "$_pra_tmp" 2>/dev/null; then
    rm -rf -- "$_pra_tmp"
    return 1
  fi
  if ! mv -- "$_pra_tmp" "$_pra_dst"; then
    rm -rf -- "$_pra_tmp"
    return 1
  fi
  return 0
}
PUBLIC_ASSET_REL="apps/operator/public"
if [ -d "$INTEGRATION_ROOT/$PUBLIC_ASSET_REL" ]; then
  _provisioned_assets=0
  PROVISION_STAGE_DIR="$RELEASE_ROOT/.provision-stage.$$"
  while IFS= read -r _ignored_entry; do
    [ -n "$_ignored_entry" ] || continue
    # internal/docs.old.<pid> is the docs publisher's swap-out of the PREVIOUS
    # mirror (apps/operator-docs/scripts/postbuild-copy.sh), never a runtime
    # asset. One left behind in the integration tree (350 MB, measured
    # 2026-09-30) was copied into every release tree and its SPA dist.
    case "$_ignored_entry" in
      "$PUBLIC_ASSET_REL"/internal/docs.old.*) continue ;;
    esac
    _asset_src="$INTEGRATION_ROOT/$_ignored_entry"
    _asset_dst="$RELEASE_ROOT/$_ignored_entry"
    [ -e "$_asset_src" ] || continue
    [ -e "$_asset_dst" ] && continue
    if provision_runtime_asset "$_asset_src" "$_asset_dst"; then
      _provisioned_assets=$((_provisioned_assets + 1))
    else
      log "WARN could not provision gitignored runtime asset $_ignored_entry"
    fi
  done <<EOF
$(git -C "$INTEGRATION_ROOT" status --porcelain --ignored -- "$PUBLIC_ASSET_REL" 2>/dev/null |
    sed -n 's|^!! ||p' | sed 's|/$||')
EOF
  rm -rf -- "$PROVISION_STAGE_DIR"
  unset PROVISION_STAGE_DIR
  log "provisioned $_provisioned_assets gitignored runtime asset(s) under $PUBLIC_ASSET_REL"
fi

# 3b (cont). No file under apps/operator/public may share an inode (WI-10004321).
# The loop above skips entries that already exist, so a tree provisioned before
# the fix still holds `cp -al` hard links to the integration tree. Unshare them:
# copy each multiply-linked file to a sibling temp and rename it over the
# original. The rename gives THIS tree a fresh inode and never writes through the
# shared one, so the other trees' bytes are untouched. Then assert none remain.
# Unlike a missing asset (non-fatal above: the owning test reports it), a shared
# inode is silent: the tree's assets can change after it was built and tested,
# and nothing would ever go red. So this one is fatal.
if [ -d "$RELEASE_ROOT/apps/operator/public" ]; then
  _unshared_assets=0
  while IFS= read -r -d '' _linked_asset; do
    _unshare_tmp="$(dirname "$_linked_asset")/.unshare.$$.$(basename "$_linked_asset")"
    if cp -a -- "$_linked_asset" "$_unshare_tmp" && mv -f -- "$_unshare_tmp" "$_linked_asset"; then
      _unshared_assets=$((_unshared_assets + 1))
    else
      rm -f -- "$_unshare_tmp"
    fi
  done < <(find "$RELEASE_ROOT/apps/operator/public" -type f -links +1 -print0 2>/dev/null)
  [ "$_unshared_assets" -eq 0 ] || log "unshared $_unshared_assets hard-linked file(s) under apps/operator/public"
  _still_linked="$(find "$RELEASE_ROOT/apps/operator/public" -type f -links +1 2>/dev/null | head -5)"
  if [ -n "$_still_linked" ]; then
    log "FATAL files under apps/operator/public still share an inode with another tree (WI-10004321); a rewrite in either tree would change the other:"
    log "$_still_linked"
    exit 1
  fi
fi

# 3c. Checksum-pinned desktop rootfs -----------------------------------------
# A nested .papercusp/worktrees/<cut> cannot discover the integration tree via
# the cutter's sibling scan. Copy only a donor matching the RELEASE's stamp.
ROOTFS_REL="papercusp-desktop/src-tauri/resources/papercup-runtime.tar.gz"
ROOTFS_TARGET="$RELEASE_ROOT/$ROOTFS_REL"
ROOTFS_STAMP="$(dirname "$ROOTFS_TARGET")/.rootfs-build-stamp"
ROOTFS_DONOR="$INTEGRATION_ROOT/$ROOTFS_REL"
if [ -f "$ROOTFS_STAMP" ] && [ -f "$ROOTFS_DONOR" ] && [ ! -f "$ROOTFS_TARGET" ]; then
  ROOTFS_EXPECTED="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("rootfsSha256", ""))' "$ROOTFS_STAMP")"
  ROOTFS_ACTUAL="$(sha256sum "$ROOTFS_DONOR" | cut -d ' ' -f 1)"
  if [[ "$ROOTFS_EXPECTED" =~ ^[a-f0-9]{64}$ ]] && [ "$ROOTFS_ACTUAL" = "$ROOTFS_EXPECTED" ]; then
    mkdir -p "$(dirname "$ROOTFS_TARGET")"
    cp "$ROOTFS_DONOR" "$ROOTFS_TARGET.tmp.$$"
    ROOTFS_COPIED="$(sha256sum "$ROOTFS_TARGET.tmp.$$" | cut -d ' ' -f 1)"
    if [ "$ROOTFS_COPIED" != "$ROOTFS_EXPECTED" ]; then
      rm -f "$ROOTFS_TARGET.tmp.$$"
      log "ERROR rootfs donor changed during copy; refusing unverified input"
      exit 1
    fi
    mv "$ROOTFS_TARGET.tmp.$$" "$ROOTFS_TARGET"
    log "provisioned WSL rootfs from integration (release stamp SHA-256 verified)"
  else
    # Web-only checkouts do not require this desktop artifact. Windows cuts
    # still fail closed at their preflight when no matching donor is present.
    log "WARN integration WSL rootfs does not match release stamp; not copied"
  fi
fi

# 4. SPA dist (deploys only) -------------------------------------------------
# operator-vite/dist is UNTRACKED, so a fresh swap serves whatever dist was
# last built in this tree — found 25h STALE on 2026-06-06 (the /admin/git tab
# was missing from the deployed SPA while the server code was current). The
# DEPLOY passes --build-spa so what :3070 serves is always built from the
# deployed sha; the green-checkpoint tree skips it (nothing serves its SPA).
# Deliberately does NOT set PAPERCUSP_RETAIN_DIST_CHUNKS=0: this build lands in
# the RELEASE checkout, which is REUSED across deploys and is what SERVES :3070
# to live desktop windows. A wiping build here yanks the hashed chunks those
# windows are pinned to — the same stale-chunk 404 the retain default exists to
# prevent — so the deploy build WANTS retention (growth is bounded by the TTL
# prune, and index.html always points at the new chunks). The opt-out belongs
# only to builds whose dist/ is PACKAGED into a shipped artifact; see
# papercusp-desktop/bin/build-desktop-sidecar.sh and shouldRetainDistChunks()
# in apps/operator-vite/dev-dist-prune.ts. Plan
# `dist-chunk-retention-default-2026-07-26` P-002 — do not "fix" this by adding =0.
if [ "$BUILD_SPA" = "1" ]; then
  log "building operator-vite SPA dist at the deployed sha (this can take a minute)"
  # WI-10003918: vite-build-singleflight writes vite's own error to STDOUT, and a
  # retain-mode build leaves no failure record, so discarding stdout left only
  # `npm error code 1` in the deploy log and the next build overwrote the cause.
  _spa_log="${TMPDIR:-/tmp}/setup-release-spa-build.$$.log"
  if (cd "$RELEASE_ROOT" && npm --workspace @papercusp/operator-vite run build) >"$_spa_log" 2>&1; then
    rm -f "$_spa_log"
  else
    tail -n 60 "$_spa_log" >&2
    echo "[setup-release] SPA build FAILED — the swap would serve a stale SPA; aborting (full build output: $_spa_log)" >&2
    exit 1
  fi
fi

log "release checkout ready at $RELEASE_ROOT (detached $TARGET_SHA)"
