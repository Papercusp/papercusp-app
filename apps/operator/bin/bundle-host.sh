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
# >>> operator-dir resolution (WI-10006398; executed verbatim by systemd-script-snapshot.test.ts)
# systemd runs this script through papercusp-script-snapshot.sh, which executes a COPY from a
# private temp directory so an edit landing mid-build cannot change the program bash is reading.
# From that copy SCRIPT_DIR is the temp directory, so the checkout comes from
# BUNDLE_HOST_OPERATOR_DIR, which the unit pins with Environment=.
# The override is honoured ONLY from a snapshot. bg-host's Environment= reaches every process it
# spawns, including deploy-cli, which runs papercup-release's copy of this script IN PLACE; an
# in-place run that honoured an inherited value would bundle the staging tree into a release.
# So an in-place run drops the value and locates itself, exactly as before the override existed.
if [[ -n "${PAPERCUSP_SCRIPT_SNAPSHOT_ROOT:-}" && "$SCRIPT_DIR/" == "$PAPERCUSP_SCRIPT_SNAPSHOT_ROOT"/* ]]; then
  if [[ -z "${BUNDLE_HOST_OPERATOR_DIR:-}" ]]; then
    echo "bundle-host.sh: running from a script snapshot ($SCRIPT_DIR) without BUNDLE_HOST_OPERATOR_DIR — pin it with Environment= in the unit" >&2
    exit 78
  fi
else
  unset BUNDLE_HOST_OPERATOR_DIR
fi
OPERATOR_DIR="$(cd "${BUNDLE_HOST_OPERATOR_DIR:-$SCRIPT_DIR/..}" && pwd)" || {
  echo "bundle-host.sh: operator directory does not exist: ${BUNDLE_HOST_OPERATOR_DIR:-$SCRIPT_DIR/..}" >&2
  exit 78
}
# <<< operator-dir resolution
REPO_ROOT="$(cd "$OPERATOR_DIR/../.." && pwd)"
# Node helpers run from the CHECKOUT, never from a snapshot: they import through node_modules and
# ../../../scripts, which do not resolve from a temp directory. That costs no protection — each
# runs under the committed-source loader, which reads its whole module before executing, unlike
# bash. The sourced bundle-host-common.sh stays beside this script, frozen with it.
HELPER_DIR="$OPERATOR_DIR/bin"

# WI-10005802 (D-012): every node helper this script runs BEFORE the restricted-hold gate judges
# the build (the install-mutex re-entry, the freshness proof, the probe-window gate, the bundle
# checks) and the gate itself start under the committed-source loader, so each runs its committed
# (HEAD) bytes: a held restricted write to a helper cannot run here with the network. A missing
# loader makes node fail, which refuses the build (fail closed), never an unjudged run.
COMMITTED_NODE=(node --import "$REPO_ROOT/scripts/lib/committed-source-loader.mjs")

# EI-21252421327077269: install:safe serializes WRITERS, but a systemd restart
# could still run this dependency reader while npm was replacing node_modules.
# That produced a half-extracted @modelcontextprotocol/sdk package and made the
# host crash-loop on missing rocksdb-native. Re-enter the script through the
# existing repo-keyed install mutex before sourcing bundle inputs or invoking
# esbuild. The wrapper marks its child so this branch runs exactly once.
if ! "${COMMITTED_NODE[@]}" --input-type=module -e \
  'const { installLockNameForRoot, installMutexIsHeld } = await import(process.argv[1]); process.exit(installMutexIsHeld(installLockNameForRoot(process.argv[2])) ? 0 : 1);' \
  "file://$REPO_ROOT/scripts/lib/install-lock-name.mjs" "$REPO_ROOT"; then
  exec "${COMMITTED_NODE[@]}" "$REPO_ROOT/scripts/npm-install-safe.mjs" \
    --repo-root "$REPO_ROOT" --exec-under-lock -- "$SCRIPT_DIR/bundle-host.sh" "$@"
fi

cd "$OPERATOR_DIR"

ENTRY="${1:-bin/hono-host.ts}"
OUTFILE="${2:-dist-host/hono-host.mjs}"
OUTDIR="$(dirname "$OUTFILE")"
STALE_MARKER="$OUTDIR/.bundle-stale.json"
FRESH_MARKER="$OUTDIR/.bundle-fresh.json"
FRESHNESS_HELPER="$HELPER_DIR/bundle-host-freshness.mjs"

# EI-22636310973765418: staging-sync builds the expensive host bundle while the
# old :3170 process is still serving. Its subsequent systemd ExecStartPre may
# reuse those bytes only when a server-independent proof says BOTH source and
# the complete dist-host runtime tree are unchanged. The opt-in is staging-only:
# shared-tree/bg-host restarts retain the original rebuild-on-every-start rule.
if [[ "${PAPERCUSP_BUNDLE_REUSE_FRESH:-0}" == "1" ]]; then
  if [[ ! -f "$STALE_MARKER" ]] && "${COMMITTED_NODE[@]}" "$FRESHNESS_HELPER" check \
      --repo-root "$REPO_ROOT" \
      --entry "$ENTRY" \
      --outfile "$OUTFILE" \
      --manifest "$FRESH_MARKER" >/dev/null; then
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
  # These runtime packages already resolve to JavaScript beside the host in
  # staging and release. Keep their SDK/parser source out of each host copy;
  # the desktop sidecar still bundles its own dependencies for distribution.
  --external:undici
  --external:@dbos-inc/dbos-sdk
  --external:mingo
  --external:acorn
  --external:fast-check
  --external:@mcp-ui/server
  # WI-10006409: EC2 contributes 2.31 MB and SSM 0.45 MB of generated SDK
  # source to each host. Both resolve compiled JS in staging and release;
  # retain their plain-Node runtime boundary instead of inlining the SDKs.
  --external:@aws-sdk/client-ec2
  --external:@aws-sdk/client-ssm
  --external:viem
  --external:iconv-lite
  --external:@smithy/core
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
PROBE_STAMP="$TMPFILE.probe-window.json"
# EI-18119538868734274: the blueprints/ and sql/ asset directories below are
# published with the SAME tmp-then-atomic-swap discipline as $TMPFILE here —
# see the two "publish" comments further down for why (a live process's
# ensureBootstrap()/blueprint loader can call fs.readdirSync on these paths at
# ANY time, including mid-rebuild).
NEW_BLUEPRINTS_DIR=""
NEW_SQL_DIR=""
SYSTEMD_ENV_RUNNER_TMP=""
# Restricted-hold gate (WI-10005745 — D-012 residue of WI-10005724). bg-host runs THIS tree's
# bundle with the network, so a write left by a session holding an active personal disclosure must
# never stand in it. Before the build the gate hardlink-snapshots every artifact the build may
# replace; after it, ONE census intersects the held restricted writes with the build's EXACT inputs
# (esbuild metafiles + verbatim-copied files/dirs) and restores the snapshot on anything but an
# admit. It runs on the normal path below AND from the EXIT trap, so every exit after a fresh
# publish (including the worker/spawner stale-start exits) is gated. bundle-restricted-hold-gate.mjs.
GATE_HELPER="$HELPER_DIR/bundle-restricted-hold-gate.mjs"
GATE_SNAPSHOT_DIR="$OUTDIR/.restricted-lkg.$$"
BUNDLE_HOST_GATE_META_DIR="$OUTDIR/.restricted-gate-meta.$$"
GATE_LOG="$OUTFILE.restricted-hold-gate.log"
GATE_PENDING=0
FALLBACK_RC=1
restricted_hold_gate() { # 0 = admitted · 1 = refused (the snapshot was restored)
  GATE_PENDING=0
  local -a args=(gate --root "$REPO_ROOT" --base-dir "$PWD" --outdir "$OUTDIR" --snapshot-dir "$GATE_SNAPSHOT_DIR"
    --metafile "$BUNDLE_HOST_GATE_META_DIR/${OUTFILE##*/}.meta.json" --metafile-dir "$BUNDLE_HOST_GATE_META_DIR"
    --path "${PAPERCUSP_HARNESS_BLUEPRINTS_DIR:-../../libs/papercusp/packages/harness/blueprints}"
    --path "${PAPERCUSP_LOCKS_SQL_DIR:-../../libs/papercusp/packages/locks/src/sql}")
  local src gate_rc=0
  for src in "${HOST_RUNTIME_SIBLING_SOURCES[@]}"; do args+=(--path "$REPO_ROOT/$src"); done
  if [[ -f "$BUNDLE_HOST_GATE_META_DIR/copied-sources.txt" ]]; then
    args+=(--list-file "$BUNDLE_HOST_GATE_META_DIR/copied-sources.txt")
  fi
  if [[ -f "$OUTDIR/spawner-sidecar.mjs.meta.json" ]]; then
    args+=(--metafile "$OUTDIR/spawner-sidecar.mjs.meta.json")
  fi
  "${COMMITTED_NODE[@]}" "$GATE_HELPER" "${args[@]}" >"$GATE_LOG" 2>&1 || gate_rc=$?
  cat "$GATE_LOG"
  [[ $gate_rc -eq 0 ]]
}
restricted_hold_fallback() { # <log> — sets FALLBACK_RC; the caller exits with it
  local log="$1"
  rm -f "$FRESH_MARKER"
  if [[ ! -s "$OUTFILE" ]]; then
    echo "🚨 ERROR: the restricted-hold gate refused this build and there is NO last-known-good $OUTFILE."
    echo "🚨   Refusing to start rather than exec a missing entrypoint."
    FALLBACK_RC=1
    return
  fi
  "${COMMITTED_NODE[@]}" "$HELPER_DIR/write-bundle-stale-marker.mjs" "$STALE_MARKER" "$ENTRY" "$OUTFILE" "$log" || true
  echo "🚨 dist-host/ is the LAST-KNOWN-GOOD bundle, NOT the current tree: the restricted-hold gate"
  echo "🚨   refused this build (D-012, WI-10005745). /api/health reports bundleStale."
  echo "🚨   Marker: $STALE_MARKER — restart the host after the disclosure is released."
  if [[ "${PAPERCUSP_BUNDLE_ALLOW_STALE_START:-0}" == "1" ]]; then
    echo "🚨 The service STARTS on that bundle, by request (PAPERCUSP_BUNDLE_ALLOW_STALE_START=1)."
    FALLBACK_RC=0
    return
  fi
  echo "🚨 The CALLER FAILS (exit 1): stale bytes must not be reported as a release."
  FALLBACK_RC=1
}
bundle_host_on_exit() {
  local rc=$?
  rm -f "$TMPFILE" "$METAFILE" "$PROBE_STAMP"
  [[ -n "$NEW_BLUEPRINTS_DIR" ]] && rm -rf "$NEW_BLUEPRINTS_DIR"
  [[ -n "$NEW_SQL_DIR" ]] && rm -rf "$NEW_SQL_DIR"
  [[ -n "$SYSTEMD_ENV_RUNNER_TMP" ]] && rm -f "$SYSTEMD_ENV_RUNNER_TMP"
  if [[ "$GATE_PENDING" == "1" ]] && ! restricted_hold_gate; then
    if [[ $rc -eq 0 ]]; then
      restricted_hold_fallback "$GATE_LOG"
      rc=$FALLBACK_RC
    else
      rm -f "$FRESH_MARKER"
      "${COMMITTED_NODE[@]}" "$HELPER_DIR/write-bundle-stale-marker.mjs" "$STALE_MARKER" "$ENTRY" "$OUTFILE" "$GATE_LOG" || true
    fi
  fi
  rm -rf "$GATE_SNAPSHOT_DIR" "$BUNDLE_HOST_GATE_META_DIR"
  exit "$rc"
}
trap bundle_host_on_exit EXIT

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

# WI-10005113: name HOW the bundle step failed. Every failure path INSIDE the
# subshell below prints its own error before exiting (the lock timeout, esbuild,
# the guard checks), so an EMPTY log plus a signal status means the subshell was
# killed from OUTSIDE (or its redirect failed), not that the build was wrong.
# Measured 2026-10-01 22:03:10-22:03:20Z: the first staging generation bundle
# died 10s in with an empty log and the old `bundle_rc=1`, so the cause was
# unrecoverable once the candidate checkout was pruned, and :3170 stayed down.
report_bundle_step_failure() {
  local rc="$1" log="$2"
  if (( rc > 128 )); then
    local sig=$((rc - 128))
    echo "🚨 the bundle step was KILLED by signal $sig (SIG$(kill -l "$sig" 2>/dev/null || echo '?'), exit status $rc): an external kill, not a build error."
  else
    echo "bundle step exit status: $rc"
  fi
  if [[ ! -s "$log" ]]; then
    echo "🚨 the build log is EMPTY: no step inside the bundle subshell reached its own error path."
    echo "🚨   Suspect an external kill of the subshell or a failed redirect of $log or $LOCKFILE,"
    echo "🚨   not esbuild or the guard checks (each prints its error before it exits)."
  fi
}

# WI-10005745: snapshot the last-known-good artifacts BEFORE anything is rebuilt over them.
gate_snapshot_args=()
for gate_artifact in "${OUTFILE##*/}" spawner-sidecar.mjs spawner-sidecar.mjs.meta.json \
    "${HOST_WORKER_OUTPUTS[@]}" "${HOST_RUNTIME_SIBLING_OUTPUTS[@]}" blueprints sql; do
  gate_snapshot_args+=(--artifact "$gate_artifact")
done
mkdir -p "$BUNDLE_HOST_GATE_META_DIR"
if ! "${COMMITTED_NODE[@]}" "$GATE_HELPER" snapshot --outdir "$OUTDIR" --snapshot-dir "$GATE_SNAPSHOT_DIR" \
    "${gate_snapshot_args[@]}" >"$GATE_LOG" 2>&1; then
  cat "$GATE_LOG"
  echo "🚨 ERROR: could not snapshot the last-known-good bundle for the restricted-hold gate; not building over it." | tee -a "$GATE_LOG"
  restricted_hold_fallback "$GATE_LOG"
  exit "$FALLBACK_RC"
fi
cat "$GATE_LOG"

echo "→ esbuild-bundling $ENTRY → $OUTFILE (plain-node host entry, no tsx loader)"
bundle_rc=0
# `( … ) || bundle_rc=$?` rather than a bare call: `set -e` would otherwise kill
# the script at precisely the failure this block exists to survive. Output is
# captured to a file so it can be BOTH echoed to the journal and parsed into the
# marker. WI-10005113: `|| bundle_rc=$?`, not `if ! ( … ); then bundle_rc=1`, so
# the subshell's REAL status survives and a signal death (128+N) is reported as one.
(
  flock -w 120 9 || { echo "ERROR: timed out waiting for bundle lock $LOCKFILE (another build stuck?)"; exit 1; }
  # WI-55467: the SAME errexit hole the checker comment below describes applies to
  # esbuild itself, and it was left unplugged. A failed/killed esbuild wrote no
  # $METAFILE, execution fell through to the checker, and the checker died with a raw
  # `ENOENT ... hono-host.mjs.tmp.<pid>.meta.json` traceback that BURIED the real
  # esbuild error under a Node stack — while the fallback banner below still claimed
  # "the esbuild error is above". Abort here so the real error is the last thing in
  # $BUILD_LOG and the checker only ever runs on a metafile that exists.
  #
  # WI-10005321: never bundle a tree an in-tree mutation probe has deliberately broken.
  # This bundler reads the LIVE shared tree, and a probe holds a file mutated for the
  # length of a guard run; the probe's verified restore cannot reach a bundle that
  # already captured the mutant (2026-10-02: bg-host ran with its tool-ceiling denial
  # disabled for ~8 min). `wait` blocks (bounded) while a window is open in this
  # checkout or any submodule; `verify` re-checks after esbuild, and a window that
  # opened mid-build costs one rebuild. Still blocked → exit 1, so the fallback below
  # boots the last-known-good bundle, marked stale, instead of a mutant. No --timeout-sec:
  # the gate resolves PAPERCUSP_BUNDLE_PROBE_WAIT_SEC, then the PAPERCUSP_UNATTENDED_LOCK_WAIT_SEC
  # umbrella, then 90 s (WI-10006268).
  probe_attempt=1
  while :; do
    "${COMMITTED_NODE[@]}" "$REPO_ROOT/scripts/mutation-probe-window-gate.mjs" wait --root "$REPO_ROOT" \
      --stamp-file "$PROBE_STAMP" || exit 1
    if ! npx --yes esbuild@0.25.0 "$ENTRY" \
      --bundle --platform=node --format=esm --target=node22 \
      --outfile="$TMPFILE" \
      --metafile="$METAFILE" \
      --banner:js="$HOST_BANNER" \
      "${HOST_BANNER_DEFINES[@]}" \
      --define:__PAPERCUSP_BUNDLED_SIDECAR__=true \
      "${BUNDLED_SOURCE_SHA_DEFINE[@]}" \
      --log-limit=20 \
      "${HOST_EXTERNALS[@]}"; then
      echo "ERROR: esbuild failed to bundle $ENTRY (see the esbuild diagnostics above)."
      exit 1
    fi
    if "${COMMITTED_NODE[@]}" "$REPO_ROOT/scripts/mutation-probe-window-gate.mjs" verify --root "$REPO_ROOT" \
      --stamp-file "$PROBE_STAMP"; then
      break
    fi
    if (( probe_attempt >= 2 )); then
      echo "ERROR: a mutation probe opened a window during both bundle attempts; refusing to publish a bundle that may hold a mutant (WI-10005321)."
      exit 1
    fi
    probe_attempt=$((probe_attempt + 1))
    echo "→ a mutation-probe window opened during the bundle; rebuilding once (WI-10005321)"
  done
  # This subshell is the left side of `|| bundle_rc=$?`; Bash disables errexit inside such a
  # tested compound command. An unwrapped checker failure therefore fell through to ascii-escape + mv,
  # publishing the rejected bundle and returning success. Fail explicitly before the atomic swap.
  if ! "${COMMITTED_NODE[@]}" "$REPO_ROOT/scripts/check-bundled-cli-entry-guards.mjs" \
    --metafile "$METAFILE" --base-dir "$OPERATOR_DIR"; then
    exit 1
  fi
  # WI-10005745: the restricted-hold gate reads these exact inputs after every step has published.
  cp -f "$METAFILE" "$BUNDLE_HOST_GATE_META_DIR/${OUTFILE##*/}.meta.json" || exit 1
  # WI-38221: widen-avoidance pass. Runs on $TMPFILE, BEFORE the atomic rename
  # below, so the swap stays atomic and a failure here leaves the last-known-good
  # $OUTFILE untouched. The helper never exits non-zero — a bundle that skipped
  # the escape is correct, just fatter, and is not worth failing a boot over.
  "${COMMITTED_NODE[@]}" "$HELPER_DIR/ascii-escape-bundle.mjs" "$TMPFILE"
  # WI-10005299: syntax-gate the FINAL bytes before the swap. ascii-escape's own check only
  # judges its rewrite, and on failure it keeps the input on the assumption that escaping
  # broke it. When the INPUT was already invalid (a banner/module `__dirname` redeclaration),
  # that shipped a bundle that died with a SyntaxError on every start. stdin + input-type keeps
  # the ESM grammar for a temp path that has no .mjs extension. Failing here keeps the
  # last-known-good $OUTFILE.
  if ! node --input-type=module --check < "$TMPFILE"; then
    echo "ERROR: the bundled $OUTFILE fails \`node --check\` (it would throw a SyntaxError at load); keeping the last-known-good bundle."
    exit 1
  fi
  mv -f "$TMPFILE" "$OUTFILE"
) 9>"$LOCKFILE" >"$BUILD_LOG" 2>&1 || bundle_rc=$?
cat "$BUILD_LOG"
if [[ $bundle_rc -ne 0 ]]; then
  report_bundle_step_failure "$bundle_rc" "$BUILD_LOG"
fi

if [[ $bundle_rc -ne 0 ]]; then
  if [[ -f "$OUTFILE" ]]; then
    "${COMMITTED_NODE[@]}" "$HELPER_DIR/write-bundle-stale-marker.mjs" \
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

# A fresh bundle is now published: from here every exit runs the restricted-hold gate
# (normally below, before the freshness stamp; otherwise from the EXIT trap).
GATE_PENDING=1

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
#
# WI-10005087: a worker failure gets the SAME two-caller contract as the entry
# above. Measured 2026-10-01 21:01-21:10Z: the entry built, then esbuild could
# not bundle snapshot-fold.worker.ts, and this line's bare `|| exit 1` failed
# ExecStartPre with a good previous snapshot-fold.worker.mjs on disk — bg-host
# crash-looped for ~9 min (routines, git-sync and DBOS down fleet-wide) even
# though its drop-in sets PAPERCUSP_BUNDLE_ALLOW_STALE_START=1. The entry's
# fallback did not cover the workers, so one bad worker edit was an outage.
#
# Same rules as the entry: every worker publish is tmp-then-rename, so a failed
# worker leaves its previous output intact; the marker is written whenever we
# fall back (staleness is a fact about disk, not about the caller); a supervisor
# that opted in starts, every other caller fails; and nothing starts when a
# worker has no previous output to fall back to.
#
# ⚠ The fallback leaves a MIXED dist-host: a fresh entry beside an older worker.
# That is deliberately reported, not refused. The worker message protocols
# (snapshot-fold-protocol.ts, the sentinel's) carry no version handshake, so a
# protocol change plus a stale worker is a real skew — but refusing here would
# not prevent it (the entry's own fallback already yields the opposite mix:
# measured live at 21:12Z, a 21:08Z entry beside a 20:25Z snapshot-fold worker)
# and would restore the outage. The marker names the worker, so /api/health
# reports bundleStale and the skew is one read away rather than invisible.
WORKER_BUILD_LOG="$OUTDIR/runtime-workers.build-error.log"
worker_rc=0
bundle_host_workers "$REPO_ROOT" "$OUTDIR" "${PAPERCUSP_EMBED_WORKER_SCRIPT:-}" >"$WORKER_BUILD_LOG" 2>&1 || worker_rc=$?
cat "$WORKER_BUILD_LOG"
if [[ $worker_rc -ne 0 ]]; then
  failed_worker="${BUNDLE_HOST_WORKER_FAILED_SOURCE:-(runtime workers)}"
  missing_workers=()
  for worker_output in "${HOST_WORKER_OUTPUTS[@]}"; do
    [[ -s "$OUTDIR/$worker_output" ]] || missing_workers+=("$worker_output")
  done
  if [[ ${#missing_workers[@]} -ne 0 ]]; then
    echo "ERROR: bundling runtime worker $failed_worker failed and there is NO previous"
    echo "       output to fall back to (missing: ${missing_workers[*]})."
    echo "       Refusing to start rather than spawn a missing worker."
    exit 1
  fi
  worker_outfile="$OUTDIR/${BUNDLE_HOST_WORKER_FAILED_OUTPUT:-${HOST_WORKER_OUTPUTS[0]}}"
  "${COMMITTED_NODE[@]}" "$HELPER_DIR/write-bundle-stale-marker.mjs" \
    "$STALE_MARKER" "$failed_worker" "$worker_outfile" "$WORKER_BUILD_LOG" || true
  echo "🚨 ERROR: bundling runtime worker $failed_worker FAILED — output above; full log: $WORKER_BUILD_LOG"
  echo "🚨 FALLING BACK to the last-known-good worker already on disk:"
  echo "🚨   $worker_outfile (built $(date -r "$worker_outfile" -Iseconds 2>/dev/null || echo unknown))"
  echo "🚨 dist-host/ is STALE CODE: a fresh $ENTRY beside an OLDER worker, NOT the"
  echo "🚨   current tree. /api/health reports bundleStale. Marker: $STALE_MARKER"
  if [[ "${PAPERCUSP_BUNDLE_ALLOW_STALE_START:-0}" == "1" ]]; then
    echo "🚨 The service STARTS on that stale worker, by request"
    echo "🚨   (PAPERCUSP_BUNDLE_ALLOW_STALE_START=1 — availability over freshness)."
    exit 0
  fi
  echo "🚨 The CALLER FAILS (exit 1): stale bytes must not be reported as a release."
  exit 1
fi

# Build the maintained spawner beside real host entries. Custom fixture/worker
# builds retain their own output set. Older installations lack this sibling and
# the spawn resolver falls back to the full host divert.
case "${ENTRY##*/}" in
  hono-host.ts|serve.ts)
    SPAWNER_BUILD_LOG="$OUTDIR/spawner-sidecar.mjs.build-error.log"
    if ! bundle_host_spawner "$REPO_ROOT" "$OUTDIR" "${BUNDLED_SOURCE_SHA_DEFINE[@]}" "${HOST_EXTERNALS[@]}" >"$SPAWNER_BUILD_LOG" 2>&1; then
      cat "$SPAWNER_BUILD_LOG"
      "${COMMITTED_NODE[@]}" "$HELPER_DIR/write-bundle-stale-marker.mjs" \
        "$STALE_MARKER" "bin/spawner-sidecar.ts" "$OUTDIR/spawner-sidecar.mjs" "$SPAWNER_BUILD_LOG" || true
      echo "ERROR: standalone spawner build failed; prior sibling remains unchanged, or the resolver uses the full host when absent."
      if [[ "${PAPERCUSP_BUNDLE_ALLOW_STALE_START:-0}" == "1" && -s "$OUTFILE" ]]; then
        echo "WARNING: supervisor starts with the existing spawner route; this is not a fresh release."
        exit 0
      fi
      exit 1
    fi
    cat "$SPAWNER_BUILD_LOG"
    ;;
esac

# WI-10005745: every artifact has published — gate them all before anything stamps them fresh.
if [[ "$GATE_PENDING" == "1" ]] && ! restricted_hold_gate; then
  restricted_hold_fallback "$GATE_LOG"
  exit "$FALLBACK_RC"
fi

# Stamp only after the bundle AND every runtime sibling/asset has published.
# The helper refuses a dirty tree, a changed HEAD, a missing output, or an
# incoherent dist-host tree. A stamp failure never makes an otherwise-good
# build fail; it merely forces ExecStartPre to rebuild normally.
if [[ "${PAPERCUSP_BUNDLE_REUSE_FRESH:-0}" == "1" ]]; then
  if fresh_head="$("${COMMITTED_NODE[@]}" "$FRESHNESS_HELPER" stamp \
      --repo-root "$REPO_ROOT" \
      --entry "$ENTRY" \
      --outfile "$OUTFILE" \
      --manifest "$FRESH_MARKER")"; then
    echo "✓ stamped proof-bound host bundle freshness at ${fresh_head:0:10}"
  else
    rm -f "$FRESH_MARKER"
    echo "WARNING: host bundle built successfully but could not be freshness-stamped — next start will rebuild"
  fi
fi
