#!/usr/bin/env bash
# Postbuild fixups for the Next 16 standalone bundle.
#
# Two things Next's standalone emit doesn't do for us, both of which
# cause silent runtime breakage:
#
# 1. Static assets aren't copied into the standalone tree.
#    next build emits `.next/static/{chunks,media,...}` once at the
#    repo root but doesn't copy it into `.next/standalone/.../.next/`.
#    The standalone server.js looks for static under its own .next/
#    dir; without the copy every /_next/static/chunks/<hash>.js the
#    HTML loads 404s. Visible symptom: the page shell renders but
#    every lazy-loaded component (OracleDock, DeferredDocks, panel
#    code-split chunks) silently fails to mount.
#
# 2. node-pty's prebuilt native binary is missing.
#    next.config.js declares outputFileTracingIncludes for
#    `node_modules/@lydell/node-pty-*/prebuilds/**`, but Next 16's
#    Turbopack tracer drops the prebuilds/** glob — only `lib/` +
#    `package.json` end up in the standalone trace. At runtime
#    @lydell/node-pty-linux-x64/lib/utils.js dynamic-requires
#    `./prebuilds/<platform>/pty.node` and the standalone server 500s
#    on every route that loads node-pty (the Hono catch-all,
#    /api/harness/**, /api/harness/projects/lite).
#
# Run from `npm run build` after `next build` finishes.
set -euo pipefail

OPERATOR_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# next.config.js bifurcates distDir: dev=.next, prod=.next-prod. Honor
# the same env var here so a prod build's postbuild fixups land in the
# prod dist tree, not the running dev server's tree.
DIST_DIR="${PAPERCUSP_BUILD_TARGET:-dev}"
if [ "$DIST_DIR" = "prod" ]; then
  DIST="$OPERATOR_DIR/.next-prod"
else
  DIST="$OPERATOR_DIR/.next"
fi
STANDALONE_ROOT="$DIST/standalone"
STANDALONE_NEXT="$STANDALONE_ROOT/apps/operator/$(basename "$DIST")"

if [ ! -d "$STANDALONE_ROOT" ]; then
  # No standalone build present — `next build` either failed or
  # output:'standalone' is not set. Nothing to do.
  exit 0
fi

# ── 1. static assets ─────────────────────────────────────────────────
SRC_STATIC="$DIST/static"
DST_STATIC="$STANDALONE_NEXT/static"
if [ -d "$SRC_STATIC" ]; then
  rm -rf "$DST_STATIC"
  cp -r "$SRC_STATIC" "$DST_STATIC"
  size=$(du -sh "$DST_STATIC" | cut -f1)
  echo "[postbuild-standalone] copied .next/static → standalone ($size)"
else
  echo "[postbuild-standalone] WARN: $SRC_STATIC missing — page shell will load but every dynamic chunk will 404"
fi

# ── 1b. drizzle-kit .bin symlink ──────────────────────────────────────
# Next's standalone trace pulls in node_modules/drizzle-kit/bin.cjs but
# drops both the package.json (so `require.resolve('drizzle-kit/package.json')`
# fails) and the node_modules/.bin/ symlink farm. The /api/dev/drizzle-studio
# route's fallback walk looks for node_modules/.bin/drizzle-kit, so without
# this symlink the route returns "drizzle-kit binary not found" in any
# standalone build.
DK_BIN_DIR="$STANDALONE_ROOT/node_modules/.bin"
DK_BIN_SRC="$STANDALONE_ROOT/node_modules/drizzle-kit/bin.cjs"
if [ -f "$DK_BIN_SRC" ]; then
  mkdir -p "$DK_BIN_DIR"
  ln -sfn ../drizzle-kit/bin.cjs "$DK_BIN_DIR/drizzle-kit"
  echo "[postbuild-standalone] linked node_modules/.bin/drizzle-kit → drizzle-kit/bin.cjs"
else
  echo "[postbuild-standalone] WARN: $DK_BIN_SRC missing — /api/dev/drizzle-studio will return 'drizzle-kit binary not found'"
fi

# ── 2. node-pty prebuilds ─────────────────────────────────────────────
SRC_ROOT="$(cd "$OPERATOR_DIR/../.." && pwd)"
copied_prebuilds=0
for variant in node-pty-linux-x64 node-pty-linux-arm64 node-pty-darwin-x64 node-pty-darwin-arm64 node-pty-win32-x64 node-pty-win32-arm64; do
  src="$SRC_ROOT/node_modules/@lydell/$variant/prebuilds"
  dst="$STANDALONE_ROOT/node_modules/@lydell/$variant/prebuilds"
  if [ -d "$src" ] && [ -d "$STANDALONE_ROOT/node_modules/@lydell/$variant" ]; then
    rm -rf "$dst"
    cp -r "$src" "$dst"
    copied_prebuilds=$((copied_prebuilds + 1))
  fi
done
echo "[postbuild-standalone] copied $copied_prebuilds node-pty prebuild dirs"

# ── 3. stale-prod warning ─────────────────────────────────────────────
# `next build` (and the rm -rf above) deletes-and-rewrites
# .next/standalone in place. A prod next-server already running off the
# old standalone keeps its FDs open against the now-deleted inode but
# can't load any chunk hashes the new build emits — the page shell
# renders, then hydration hits "This page couldn't load" because lazy
# chunks 404 against the deleted directory and React can't reconcile.
#
# Detect: any process listening on PORT (default 3070) whose
# /proc/<pid>/cwd resolves into our standalone tree AND has the
# "(deleted)" suffix means the operator was rebuilt out from under it.
# Warn loudly so the dev knows to restart prod (`bin/prod` does this
# automatically; manual builds need a manual restart).
#
# Linux-only (uses /proc). On macOS this no-ops silently.
if [ -d /proc ]; then
  PROD_PORT="${PAPERCUSP_PROD_PORT:-3070}"
  STALE_PIDS=()
  # Find the pid listening on PROD_PORT, if any
  pid_line=$(ss -tlnp 2>/dev/null | awk -v p=":$PROD_PORT" '$0 ~ p {print}' | head -1)
  if [ -n "$pid_line" ]; then
    pid=$(echo "$pid_line" | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
    if [ -n "$pid" ] && [ -L "/proc/$pid/cwd" ]; then
      cwd_link=$(ls -l "/proc/$pid/cwd" 2>/dev/null | sed -n 's|.* -> \(.*\)$|\1|p')
      case "$cwd_link" in
        *"$STANDALONE_ROOT"*"(deleted)"*)
          echo "[postbuild-standalone] ⚠ WARN: prod on :$PROD_PORT (pid=$pid) is running off the now-deleted prior bundle:"
          echo "[postbuild-standalone]    $cwd_link"
          echo "[postbuild-standalone]    Lazy chunks will 404 and pages will render \"This page couldn't load\""
          echo "[postbuild-standalone]    Restart prod with: bin/prod   (or: fuser -k $PROD_PORT/tcp && cd .next/standalone/apps/operator && PORT=$PROD_PORT NODE_ENV=production node server.js &)"
          ;;
      esac
    fi
  fi
fi
