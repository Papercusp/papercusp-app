#!/usr/bin/env bash
# bundle-host.sh — esbuild-bundle a Hono-host entry into ONE plain-ESM file so
# it runs under plain `node`, with NO tsx register-loader (WI-3336).
#
# WHY: `npx tsx bin/hono-host.ts` installs tsx's module.register() worker
# loader — EVERY runtime import resolution becomes a synchronous Atomics.wait
# RPC to the hooks thread, blocking the main event loop. On bg-host boots the
# import storm wedged the loop for multi-second windows (worst measured single
# stall post-WI-3333: 6.1s; historic amplified case: 119s p95). tsx 4.21 has no
# sync-hooks (module.registerHooks) mode, and Node's native type-stripping
# can't resolve this repo's extensionless/path-alias imports — so precompiling
# the graph is the durable fix: plain `node dist-host/hono-host.mjs` pays zero
# loader RPCs.
#
# RECIPE PROVENANCE: this is the PROVEN sidecar recipe from
# papercusp-desktop/bin/build-desktop-sidecar.sh ("esbuild-bundling the serve
# entry") — same banner, same native/externals list, same define — pointed at
# an arbitrary entry. Shared inputs are sourced from bundle-host-common.sh;
# callers retain only their output- and platform-specific steps.
#
# Usage:
#   apps/operator/bin/bundle-host.sh [entry] [outfile]
#     entry    default bin/hono-host.ts   (relative to apps/operator)
#     outfile  default dist-host/hono-host.mjs
#
# Consumers:
#   - papercup-bg-host.service drop-in 95-bundled-entry.conf: ExecStartPre runs
#     this, ExecStart runs `node dist-host/hono-host.mjs`. It rebuilds on EVERY
#     restart so a restart still picks up shared-tree edits.
#   - papercusp-staging-api.service: staging-sync may prebuild against its clean,
#     isolated committed checkout and opt into proof-bound reuse. Reuse requires
#     the same clean HEAD plus an unchanged complete dist-host tree; every miss
#     falls back to the ordinary rebuild. Never add unproved caching here — a
#     stale bundle silently runs old code (see
#     internal-docs/agent-insights/bg-host-runs-stale-routine-code.md).
set -euo pipefail
# EI-18808640677734527: resolve THIS script's directory ONCE, to an absolute
# path, BEFORE the cd below. `${BASH_SOURCE[0]}` holds the path AS INVOKED, so
# re-running `dirname` on it after a `cd` re-resolves a RELATIVE invocation
# against the new cwd — which broke the `source` at the bottom of this header
# for exactly the invocation this script's own Usage line documents
# (`apps/operator/bin/bundle-host.sh` from the repo root):
#   line 44: apps/operator/bin/bundle-host-common.sh: No such file or directory
# systemd consumers invoke it by absolute path. Keep this map current because
# it is what an agent reads to decide the blast radius of an edit here:
#   :3170 staging → THIS tree's copy (absolute path into papercupai-workspace/papercusp)
#   :3070 dev     → the RELEASE checkout's copy (papercup-release/...), so an
#                  edit here reaches it only after the deploy pipeline promotes it
#   :3271 bg-host  → THIS tree's copy (the dedicated background host); its
#                  versioned papercup-bg-host.service.d/95-bundled-entry.conf
#                  installs this script as ExecStartPre and launches the bundle.
#
# Every consumer rebuilds from the working tree immediately before it starts.
# — but a human or agent
# following the docs did, and the failure is quiet in the way that matters:
# the script exits non-zero having left `dist-host/hono-host.mjs` UNTOUCHED, so
# a restart afterwards silently runs the STALE bundle
# (internal-docs/agent-insights/bg-host-runs-stale-routine-code.md again).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# EI-21252421327077269: install:safe serializes WRITERS, but a systemd restart
# could still run this dependency reader while npm was replacing node_modules.
# That produced a half-extracted @modelcontextprotocol/sdk package and made the
# host crash-loop on missing rocksdb-native. Re-enter the script through the
# existing repo-keyed install mutex before sourcing bundle inputs or invoking
# esbuild. The wrapper marks its child so this branch runs exactly once.
if [[ "${PAPERCUSP_INSTALL_MUTEX_HELD:-0}" != "1" ]]; then
  exec node "$REPO_ROOT/scripts/npm-install-safe.mjs" \
    --repo-root "$REPO_ROOT" --exec-under-lock -- "$SCRIPT_DIR/bundle-host.sh" "$@"
fi

cd "$SCRIPT_DIR/.."

ENTRY="${1:-bin/hono-host.ts}"
OUTFILE="${2:-dist-host/hono-host.mjs}"
OUTDIR="$(dirname "$OUTFILE")"
STALE_MARKER="$OUTDIR/.bundle-stale.json"
FRESH_MARKER="$OUTDIR/.bundle-fresh.json"
FRESHNESS_HELPER="$SCRIPT_DIR/bundle-host-freshness.mjs"

# EI-22636310973765418: staging-sync builds the expensive host bundle while the
# old :3170 process is still serving. Its subsequent systemd ExecStartPre may
# reuse those bytes only when a server-independent proof says BOTH source and
# the complete dist-host runtime tree are unchanged. The opt-in is staging-only:
# shared-tree/bg-host restarts retain the original rebuild-on-every-start rule.
if [[ "${PAPERCUSP_BUNDLE_REUSE_FRESH:-0}" == "1" ]]; then
  if [[ ! -f "$STALE_MARKER" ]] && node "$FRESHNESS_HELPER" check \
      --repo-root "$REPO_ROOT" \
      --entry "$PWD/$ENTRY" \
      --outfile "$PWD/$OUTFILE" \
      --manifest "$PWD/$FRESH_MARKER" >/dev/null; then
    echo "✓ reusing proof-bound fresh host bundle for $(git -C "$REPO_ROOT" rev-parse --short HEAD) — ExecStartPre has no build work"
    exit 0
  fi
  # A failed or interrupted build must never leave an older proof reusable.
  rm -f "$FRESH_MARKER"
fi

# ESM output: the host graph contains `import.meta.url` (a CJS bundle rejects
# it). ESM has no `__dirname`/`__filename`/`require`, so the banner re-creates
# them. The dummy `module`/`exports` neutralise the CJS
# `if (require.main === module)` CLI-guard idiom inside bundled files (always
# false → guard body skipped, correct: they are not the entrypoint).
source "$SCRIPT_DIR/bundle-host-common.sh"

# Native (.node-addon) packages esbuild cannot inline — they resolve platform
# binaries relative to their real package dir. On the dev host they resolve
# from the tree's node_modules at runtime (bare-specifier imports stay
# external). Same list as build-desktop-sidecar.sh.
HOST_EXTERNALS=(
  "${HOST_COMMON_EXTERNALS[@]}"
  # embedded-postgres platform packages: only the host platform is installed,
  # the rest are unresolvable dynamic imports.
  --external:@embedded-postgres/darwin-arm64
  --external:@embedded-postgres/darwin-x64
  --external:@embedded-postgres/linux-arm
  --external:@embedded-postgres/linux-arm64
  --external:@embedded-postgres/linux-ia32
  --external:@embedded-postgres/linux-ppc64
  --external:@embedded-postgres/windows-x64
  --external:@papercusp/embedded-postgres-server
)
for np in "${NATIVE_PKGS[@]}"; do HOST_EXTERNALS+=( "--external:$np" ); done

# WI-38221 memory trim (measured 2026-08-12). Packages whose SOURCE the host
# pays for in every process but which a request-serving worker never executes.
# esbuild wraps CJS deps in a lazy __commonJS thunk, so these already never RUN
# — but the bundle still carries their full source, and V8 still parses it, in
# all 17 host processes on this box. Dropping them takes the bundle 61.2 -> 36.4
# MB and a host process 206.2 -> 140.9 MB RSS (~1.08 GB box-wide); with the
# ascii-escape pass below, 113.4 MB (~1.54 GB).
#
# The codebase ALREADY tried to get this with source-level `await import()`
# (agent-mcp/src/delta-eval-harness.ts:37 "ships multi-MB BPE rank tables",
# tooldef/parse-check.ts:32) and got ZERO benefit: esbuild INLINES dynamic
# imports into the same bundle unless --splitting. `--external:` is the lever
# that actually works.
#
# ⚠ EXTERNAL ⇒ RESOLVED FROM node_modules AT RUNTIME. Every entry below is
# verified to resolve to real .js (not .ts) from the bundle's own directory in
# BOTH this tree and papercup-release. Re-run
# `node .papercusp/scratch/verify-externals.mjs <bundle> <dir>` before adding
# one. Do NOT reach for the blanket `--packages=external`: it externalizes the
# @papercusp/* workspace packages too, 80 of which resolve to .ts SOURCE that
# plain node cannot load — precompiling exactly that graph is why this bundle
# exists (WI-3336, no tsx loader). It measures well and cannot boot.
#
# The packaged desktop app is NOT affected: papercusp-desktop/bin/build-desktop-sidecar.sh
# is an independent script with its own esbuild call, and MUST keep bundling its
# deps (it has no node_modules at runtime).
HOST_EXTERNALS+=(
  # 9.61 MB — the whole TypeScript compiler, reached via content-lint/registry
  # from git-sync/run-git-sync.ts, which a request worker never runs.
  --external:typescript
  # 5.34 MB of BPE rank tables; only the delta-eval harness tokenizes.
  --external:js-tiktoken
  # ~7 MB voice stack — not on the request path.
  --external:phonemizer
  --external:opusscript
  --external:@jitsi/rnnoise-wasm
  # test infrastructure, in production.
  --external:testcontainers
  --external:dockerode
  --external:esbuild
)

# self-exec guards would all fire at boot. isCliEntry()
# (operator-core/lib/util/cli-entry.ts) returns false under this define — its
# ONLY consumer (verified 2026-07-07). Unlike the sidecar build we bake NO
# version/dogfood-ref defines: the dev host reads live process.env. The source
# SHA is different: it describes the bytes in THIS generated artifact, so it
# must be captured before esbuild runs rather than read from git by the running
# bundle (EI-21647996938145436).
SOURCE_SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || true)"
BUNDLED_SOURCE_SHA_DEFINE=()
if [[ -n "$SOURCE_SHA" ]]; then
  BUNDLED_SOURCE_SHA_DEFINE=(
    "--define:__PAPERCUSP_BUNDLED_SOURCE_SHA__=\"${SOURCE_SHA}\""
  )
fi
# EI-9413: bundle-host.sh reruns on EVERY service restart (ExecStartPre), and
# systemd's restart-always can fire another attempt while a prior esbuild
# invocation's write to $OUTFILE hasn't finished flushing (or, on a wedged
# host, an orphaned esbuild child from an earlier attempt is still running) —
# two writers racing a non-atomic `--outfile` produces a torn/interleaved
# bundle that boots with a random `ReferenceError: X is not defined` for
# whichever symbol's bytes got clobbered (seen twice tonight: two DIFFERENT
# symbols on two DIFFERENT boots, same tree, same script — the signature of a
# write race, not a source bug). Two independent closures:
#  (1) flock serializes concurrent bundle-host.sh runs against the SAME
#      outfile instead of letting them race each other;
#  (2) esbuild writes to a private tmp file, then `mv` atomically renames it
#      into place — a reader (ExecStart) either sees the fully-old file or
#      the fully-new one, never a torn hybrid, even if step (1) is ever
#      bypassed (e.g. a killed/orphaned process holding the lock).
mkdir -p "$(dirname "$OUTFILE")"
LOCKFILE="$OUTFILE.build.lock"
TMPFILE="$OUTFILE.tmp.$$"
METAFILE="$TMPFILE.meta.json"
# EI-18119538868734274: the blueprints/ and sql/ asset directories below are
# published with the SAME tmp-then-atomic-swap discipline as $TMPFILE here —
# see the two "publish" comments further down for why (a live process's
# ensureBootstrap()/blueprint loader can call fs.readdirSync on these paths at
# ANY time, including mid-rebuild).
NEW_BLUEPRINTS_DIR=""
NEW_SQL_DIR=""
SYSTEMD_ENV_RUNNER_TMP=""
trap 'rm -f "$TMPFILE" "$METAFILE"; [[ -n "$NEW_BLUEPRINTS_DIR" ]] && rm -rf "$NEW_BLUEPRINTS_DIR"; [[ -n "$NEW_SQL_DIR" ]] && rm -rf "$NEW_SQL_DIR"; [[ -n "$SYSTEMD_ENV_RUNNER_TMP" ]] && rm -f "$SYSTEMD_ENV_RUNNER_TMP"' EXIT

# EI-20093985382484201: A BUNDLE FAILURE MUST NOT TAKE THE SERVICE DOWN.
# ExecStartPre runs this on EVERY restart against the LIVE shared tree, which
# many agents edit continuously — so that tree is INVALID for the seconds
# between two keystrokes of any multi-part edit. Before this guard a transient
# syntax error made ExecStartPre exit non-zero, systemd refused to start the
# unit, and Restart=always + RestartSec=5 re-bundled the same broken tree every
# 5s (~14s CPU per attempt). Measured 2026-08-10: ONE unescaped apostrophe in a
# tool `description:` string took :3170 down fleet-wide for ~52s across 4
# attempts — the SECOND such outage that day, a different typo by a different
# agent. The typo is unremarkable and WILL recur; the outage is the defect.
#
# The fallback is cheap ONLY because of the atomic swap above (EI-9413):
# esbuild writes $TMPFILE and we rename it into place, so a FAILED build leaves
# the last-known-good $OUTFILE byte-intact on disk. We just boot it.
#
# SCOPE (EI-19457229906581679): "must not take the service down" binds the
# SUPERVISOR caller, which is the only caller that starts a service. A release
# caller (deploy-cli, check-host-bundle-builds.mjs) still FAILS on a bad build —
# see the two-callers block at the fallback exit below for how each declares
# which of the two questions it is asking. This paragraph described the only
# caller that existed when it was written; it is no longer the only one.
#
# Deliberately LOUD, never silent. Serving a stale bundle is its own hazard —
# an agent can verify against code that is not what is on disk — so we write
# $STALE_MARKER and /api/health surfaces it (see
# packages/operator-core/lib/bundle-staleness.ts). A VISIBLY-stale service is
# strictly better than a down one; an INVISIBLY-stale one is worse than both.
BUILD_LOG="$OUTFILE.build-error.log"

echo "→ esbuild-bundling $ENTRY → $OUTFILE (plain-node host entry, no tsx loader)"
bundle_rc=0
# `if ! ( … )` rather than a bare call: `set -e` would otherwise kill the script
# at precisely the failure this block exists to survive. Output is captured to a
# file so it can be BOTH echoed to the journal and parsed into the marker.
if ! (
  flock -w 120 9 || { echo "ERROR: timed out waiting for bundle lock $LOCKFILE (another build stuck?)"; exit 1; }
  # WI-55467: the SAME errexit hole the checker comment below describes applies to
  # esbuild itself, and it was left unplugged. A failed/killed esbuild wrote no
  # $METAFILE, execution fell through to the checker, and the checker died with a raw
  # `ENOENT ... hono-host.mjs.tmp.<pid>.meta.json` traceback that BURIED the real
  # esbuild error under a Node stack — while the fallback banner below still claimed
  # "the esbuild error is above". Abort here so the real error is the last thing in
  # $BUILD_LOG and the checker only ever runs on a metafile that exists.
  if ! npx --yes esbuild@0.25.0 "$ENTRY" \
    --bundle --platform=node --format=esm --target=node22 \
    --outfile="$TMPFILE" \
    --metafile="$METAFILE" \
    --banner:js="$HOST_BANNER" \
    --define:__PAPERCUSP_BUNDLED_SIDECAR__=true \
    "${BUNDLED_SOURCE_SHA_DEFINE[@]}" \
    --log-limit=20 \
    "${HOST_EXTERNALS[@]}"; then
    echo "ERROR: esbuild failed to bundle $ENTRY (see the esbuild diagnostics above)."
    exit 1
  fi
  # This subshell is the condition of `if ! (...)`; Bash disables errexit inside such a tested
  # compound command. An unwrapped checker failure therefore fell through to ascii-escape + mv,
  # publishing the rejected bundle and returning success. Fail explicitly before the atomic swap.
  if ! node "$REPO_ROOT/scripts/check-bundled-cli-entry-guards.mjs" \
    --metafile "$METAFILE" --base-dir "$SCRIPT_DIR/.."; then
    exit 1
  fi
  # WI-38221: widen-avoidance pass. Runs on $TMPFILE, BEFORE the atomic rename
  # below, so the swap stays atomic and a failure here leaves the last-known-good
  # $OUTFILE untouched. The helper never exits non-zero — a bundle that skipped
  # the escape is correct, just fatter, and is not worth failing a boot over.
  node "$SCRIPT_DIR/ascii-escape-bundle.mjs" "$TMPFILE"
  mv -f "$TMPFILE" "$OUTFILE"
) 9>"$LOCKFILE" >"$BUILD_LOG" 2>&1; then
  bundle_rc=1
fi
cat "$BUILD_LOG"

if [[ $bundle_rc -ne 0 ]]; then
  if [[ -f "$OUTFILE" ]]; then
    node "$SCRIPT_DIR/write-bundle-stale-marker.mjs" \
      "$STALE_MARKER" "$ENTRY" "$OUTFILE" "$BUILD_LOG" || true
    # WI-55467: this used to assert "the esbuild error is above" unconditionally. The
    # bundle step is esbuild + the CLI-entry guard check + ascii-escape + the atomic
    # swap, and ANY of them can set bundle_rc — so naming esbuild sent readers hunting
    # an esbuild error that did not exist. Point at the log instead of guessing.
    echo "🚨 ERROR: bundling $ENTRY FAILED — the failing step's output is above (esbuild, the"
    echo "🚨   bundled CLI-entry guard check, ascii-escape, or the atomic swap); full log: $BUILD_LOG"
    echo "🚨 FALLING BACK to the last-known-good bundle already on disk:"
    echo "🚨   $OUTFILE (built $(date -r "$OUTFILE" -Iseconds 2>/dev/null || echo unknown))"
    # UNCONDITIONAL, and deliberately stated before the caller branch below.
    # Staleness is a fact about what is on disk, not about what this particular
    # caller does with the exit code: dist-host/ now holds the last-known-good
    # bundle rather than the current tree either way, and anything already
    # serving it keeps serving stale code. Gating this warning on the branch
    # (as the first cut of EI-19457229906581679 did) silently dropped it from
    # the release path — an agent verifies a fix against pre-fix code and
    # believes it. A SILENTLY stale service is worse than a down one.
    echo "🚨 dist-host/ is STALE CODE: the bundle on disk is last-known-good, NOT the"
    echo "🚨   current tree. /api/health reports bundleStale."
    echo "🚨 Marker: $STALE_MARKER — fix the source error and restart to clear it."
    # NOTHING else on disk is touched. The blueprints/, sql/ and worker-script
    # publishes below are SKIPPED so dist-host/ stays exactly as the last
    # SUCCESSFUL build left it — a coherent bundle+assets set, rather than a
    # stale bundle sitting beside assets freshly published from a newer tree.
    #
    # ── TWO CALLERS, OPPOSITE CORRECT ANSWERS ────────────────────────────────
    # EI-19457229906581679. This one script is invoked by callers that want
    # contradictory things on a failed build, and until this block existed it
    # could only satisfy one of them:
    #
    #   RELEASE callers (deploy-cli, scripts/check-host-bundle-builds.mjs) ask
    #   "did the requested code build?" — the honest answer is NO, and WI-41242
    #   is right that returning 0 let deploy-cli report a green deploy while the
    #   operator kept serving the previous bundle. They must FAIL. Default.
    #
    #   SUPERVISOR callers (systemd ExecStartPre) ask "may the unit start?" —
    #   a non-zero exit there does NOT mean "don't report a release", it means
    #   the unit never starts AT ALL. With Restart=always + RestartSec=5 the
    #   same broken tree is then re-bundled every 5s until a human fixes it.
    #
    # WI-41242 hardened the release answer and, without noticing, reverted the
    # supervisor guarantee this file's own header states at the top of this
    # block ("A BUNDLE FAILURE MUST NOT TAKE THE SERVICE DOWN",
    # EI-20093985382484201). The tell it was unnoticed rather than intended:
    # the banner above kept promising "The service STARTS", which had become
    # false for the only caller that starts anything. Measured 2026-08-27: a
    # syntax error in the shared tree failed the bundle at 10:47:11Z with a
    # good $OUTFILE on disk and the marker written, and :3170 still died into
    # its start-limit — down fleet-wide, exactly the outage the header forbids.
    #
    # So the caller declares which question it is asking. Opt-IN, defaulting to
    # the strict release answer, so no existing caller changes behavior and a
    # caller that forgets fails CLOSED (a down unit is loud) rather than open
    # (a green deploy on stale code is invisible — the WI-41242 regression).
    if [[ "${PAPERCUSP_BUNDLE_ALLOW_STALE_START:-0}" == "1" ]]; then
      echo "🚨 The service STARTS on that stale bundle, by request"
      echo "🚨   (PAPERCUSP_BUNDLE_ALLOW_STALE_START=1 — availability over freshness)."
      exit 0
    fi
    echo "🚨 The CALLER FAILS (exit 1): stale bytes must not be reported as a release."
    echo "🚨   A systemd ExecStartPre reaching this line will NOT start the unit. If this"
    echo "🚨   is a supervisor that should boot on last-known-good, set"
    echo "🚨   PAPERCUSP_BUNDLE_ALLOW_STALE_START=1 in its drop-in."
    exit 1
  fi
  echo "ERROR: bundling $ENTRY failed and there is NO previous bundle at $OUTFILE"
  echo "       to fall back to. Refusing to start rather than exec a missing entrypoint."
  exit 1
fi

# Success: the running code matches the tree again, so retract any stale claim.
rm -f "$STALE_MARKER"
echo "✓ bundled: $(du -h "$OUTFILE" | cut -f1) $OUTFILE"

# @papercusp/locks is bundled into the host graph, so its su-lock-store resolves
# package-owned migrations relative to the bundle's import.meta.url:
#   dirname(dist-host/hono-host.mjs)/sql
# esbuild only emits JS, never sibling src/sql/*.sql assets. Keep this in sync
# with papercusp-desktop/bin/build-desktop-sidecar.sh's sidecar/sql copy.
# systemd-scope.ts resolves this plain-Node helper beside the bundled host
# entry. esbuild cannot emit a source .mjs sibling, so publish it explicitly
# with the same temp-then-rename discipline as the host bundle. A missing
# runner is a hard build error: starting without it turns every out-of-cgroup
# capability into a preflight MODULE_NOT_FOUND failure.
SYSTEMD_ENV_RUNNER_SRC="../../packages/operator-core/lib/systemd-scope-env-runner.mjs"
if [[ ! -f "$SYSTEMD_ENV_RUNNER_SRC" ]]; then
  echo "ERROR: systemd scope environment runner not found at $SYSTEMD_ENV_RUNNER_SRC"
  exit 1
fi
SYSTEMD_ENV_RUNNER_TMP="$OUTDIR/systemd-scope-env-runner.mjs.new.$$"
cp "$SYSTEMD_ENV_RUNNER_SRC" "$SYSTEMD_ENV_RUNNER_TMP"
mv -f "$SYSTEMD_ENV_RUNNER_TMP" "$OUTDIR/systemd-scope-env-runner.mjs"
SYSTEMD_ENV_RUNNER_TMP=""
echo "✓ bundled systemd scope environment runner beside the host entry"

# pot-git's fetch transport (operator-core/lib/sync/pot-git/fetch-transport.ts)
# resolves git's `ext::` connection helper as
#   join(dirname(import.meta.url), 'git-ext-bridge.mjs')
# — beside the BUNDLED entry once bundled, and git execs it as an external
# `node <path> <sock>` command, so it must exist on disk as a runnable script.
# Same publish discipline as the runner above. Measured 2026-09-02 (endgame
# P-203): bg-host logged `Cannot find module …/dist-host/git-ext-bridge.mjs`
# ×22 per 3 min and every ref-announce fetch from the VM peer died with
# "git died without an exit status", so pot-git never converged with the pot.
GIT_EXT_BRIDGE_SRC="../../packages/operator-core/lib/sync/pot-git/git-ext-bridge.mjs"
if [[ ! -f "$GIT_EXT_BRIDGE_SRC" ]]; then
  echo "ERROR: pot-git ext bridge not found at $GIT_EXT_BRIDGE_SRC"
  exit 1
fi
GIT_EXT_BRIDGE_TMP="$OUTDIR/git-ext-bridge.mjs.new.$$"
cp "$GIT_EXT_BRIDGE_SRC" "$GIT_EXT_BRIDGE_TMP"
mv -f "$GIT_EXT_BRIDGE_TMP" "$OUTDIR/git-ext-bridge.mjs"
GIT_EXT_BRIDGE_TMP=""
echo "✓ bundled pot-git ext bridge beside the host entry"

# @papercusp/harness is bundled into the host graph too. Its built-in blueprint
# resolver derives the package root from import.meta.url, so a plain-node bundle
# must carry the blueprint YAML/prompts beside the entry or an installed child
# blueprint such as oddsmith-prospector can resolve itself but fail its
# `extends: base` parent.
HARNESS_BLUEPRINTS_SRC="${PAPERCUSP_HARNESS_BLUEPRINTS_DIR:-../../libs/papercusp/packages/harness/blueprints}"
if [[ ! -d "$HARNESS_BLUEPRINTS_SRC" ]]; then
  echo "ERROR: harness blueprints dir not found at $HARNESS_BLUEPRINTS_SRC"
  exit 1
fi

echo "→ bundling @papercusp/harness blueprints → $OUTDIR/blueprints"
# EI-18119538868734274: publish via build-in-tmp-sibling + atomic `mv -T`
# rename, exactly like $TMPFILE above. The old rm-rf/mkdir/cp-in-place left a
# window (between the rm -rf and the cp finishing) where $OUTDIR/blueprints
# does not exist or is only partially populated — @papercusp/harness's
# blueprint resolver derives its root from import.meta.url and does a live
# fs.readdirSync/readFileSync against this exact path from an ALREADY-RUNNING
# process (a long-lived dev-api/bg-host process that hasn't loaded a blueprint
# yet), completely independent of this build's own process. `mv -T` performs a
# single same-filesystem rename() syscall, so any concurrent reader sees only
# the complete old tree or the complete new tree, never a torn one.
NEW_BLUEPRINTS_DIR="$OUTDIR/blueprints.new.$$"
rm -rf "$NEW_BLUEPRINTS_DIR"
mkdir -p "$NEW_BLUEPRINTS_DIR"
cp -R "$HARNESS_BLUEPRINTS_SRC"/. "$NEW_BLUEPRINTS_DIR/"
if [[ ! -f "$NEW_BLUEPRINTS_DIR/base/blueprint.yaml" ]]; then
  echo "ERROR: bundled $NEW_BLUEPRINTS_DIR is missing base/blueprint.yaml"
  exit 1
fi
# `mv -T` only performs a single-syscall atomic rename when the destination is
# ABSENT or an EMPTY directory — POSIX rename(2) itself refuses to replace a
# NON-empty directory (confirmed live: `mv -T new existing-nonempty-dir` fails
# "cannot overwrite: File exists"), and $OUTDIR/blueprints is non-empty on
# every rebuild after the first. So: rename the OLD tree out of the way first
# (freeing the name), then rename the NEW tree in — the same two-step swap
# already proven for this exact class of problem in
# papercusp-desktop/bin/build-desktop-sidecar.sh (EI-160/EI-200). This leaves
# a residual window of two back-to-back rename() syscalls (microseconds)
# instead of the original rm-rf+mkdir+`cp -R` window (however long the copy
# takes) — a many-orders-of-magnitude reduction, not a mathematical
# guarantee (POSIX cannot do better for a non-empty-directory swap).
if [[ -d "$OUTDIR/blueprints" ]]; then
  mv "$OUTDIR/blueprints" "$OUTDIR/blueprints.old.$$"
fi
mv "$NEW_BLUEPRINTS_DIR" "$OUTDIR/blueprints"
NEW_BLUEPRINTS_DIR=""
rm -rf "$OUTDIR/blueprints.old.$$" 2>/dev/null || true
echo "    ✓ bundled @papercusp/harness blueprints include base/blueprint.yaml"

LOCKS_SQL_SRC="${PAPERCUSP_LOCKS_SQL_DIR:-../../libs/papercusp/packages/locks/src/sql}"
if [[ ! -d "$LOCKS_SQL_SRC" ]]; then
  echo "ERROR: @papercusp/locks SQL dir not found at $LOCKS_SQL_SRC"
  exit 1
fi

echo "→ bundling @papercusp/locks DDL → $OUTDIR/sql"
# EI-18119538868734274: publish via build-in-tmp-sibling + atomic `mv -T`
# rename — same discipline as the blueprints/ publish above, and for the same
# reason. su-lock-store.ts's ensureBootstrap() is called LAZILY, on the first
# locks:* call of an already-running process's lifetime — that can happen at
# ANY wall-clock moment, including the split second an unrelated ExecStartPre
# rebuild is mid-way through `rm -rf $OUTDIR/sql; mkdir; cp`. Landed live:
# EI-18119538868734274 caught `ENOENT: no such file or directory, scandir
# '.../dist-host/sql'` from exactly that window (2 of 2259 calls — a narrow
# race, not a persistent misconfig). The old in-place rm-rf/mkdir/cp is the
# textbook non-atomic-publish bug (already fixed once for the sibling
# desktop-sidecar build under EI-160/EI-200 — see build-desktop-sidecar.sh);
# this closes the same class here instead of re-patching just this instance.
NEW_SQL_DIR="$OUTDIR/sql.new.$$"
rm -rf "$NEW_SQL_DIR"
mkdir -p "$NEW_SQL_DIR"
cp "$LOCKS_SQL_SRC/"*.sql "$NEW_SQL_DIR/"

_locks_sql_max="$(ls "$LOCKS_SQL_SRC/"*.sql 2>/dev/null | xargs -n1 basename | grep -oE '^[0-9]+' | sort -n | tail -1)"
_locks_sql_count="$(ls "$LOCKS_SQL_SRC/"*.sql 2>/dev/null | wc -l | tr -d ' ')"
_bundled_locks_sql_max="$(ls "$NEW_SQL_DIR/"*.sql 2>/dev/null | xargs -n1 basename | grep -oE '^[0-9]+' | sort -n | tail -1)"
_bundled_locks_sql_count="$(ls "$NEW_SQL_DIR/"*.sql 2>/dev/null | wc -l | tr -d ' ')"
if [[ -z "$_locks_sql_max" || "$_locks_sql_max" != "$_bundled_locks_sql_max" || "$_locks_sql_count" != "$_bundled_locks_sql_count" ]]; then
  echo "ERROR: bundled $NEW_SQL_DIR/ (highest=$_bundled_locks_sql_max, count=$_bundled_locks_sql_count) does not match"
  echo "       source $LOCKS_SQL_SRC (highest=$_locks_sql_max, count=$_locks_sql_count)"
  exit 1
fi
# Two-step rename-swap, not `mv -T` — see the blueprints publish above for
# why (mv -T cannot replace a non-empty existing directory; $OUTDIR/sql is
# non-empty on every rebuild after the first).
if [[ -d "$OUTDIR/sql" ]]; then
  mv "$OUTDIR/sql" "$OUTDIR/sql.old.$$"
fi
mv "$NEW_SQL_DIR" "$OUTDIR/sql"
NEW_SQL_DIR=""
rm -rf "$OUTDIR/sql.old.$$" 2>/dev/null || true
echo "    ✓ bundled @papercusp/locks DDL matches the tree (highest migration $_locks_sql_max, $_locks_sql_count files)"

# Required workers are shared with packaged desktop and current-build rig.
bundle_host_workers "$REPO_ROOT" "$OUTDIR" "${PAPERCUSP_EMBED_WORKER_SCRIPT:-}" || exit 1

# Stamp only after the bundle AND every runtime sibling/asset has published.
# The helper refuses a dirty tree, a changed HEAD, a missing output, or an
# incoherent dist-host tree. A stamp failure never makes an otherwise-good
# build fail; it merely forces ExecStartPre to rebuild normally.
if [[ "${PAPERCUSP_BUNDLE_REUSE_FRESH:-0}" == "1" ]]; then
  if fresh_head="$(node "$FRESHNESS_HELPER" stamp \
      --repo-root "$REPO_ROOT" \
      --entry "$PWD/$ENTRY" \
      --outfile "$PWD/$OUTFILE" \
      --manifest "$PWD/$FRESH_MARKER")"; then
    echo "✓ stamped proof-bound host bundle freshness at ${fresh_head:0:10}"
  else
    rm -f "$FRESH_MARKER"
    echo "WARNING: host bundle built successfully but could not be freshness-stamped — next start will rebuild"
  fi
fi
