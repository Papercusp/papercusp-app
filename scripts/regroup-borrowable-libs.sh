#!/usr/bin/env bash
#
# regroup-borrowable-libs.sh — relocate the borrowable submodules under
# libs/generic/ so the reusable libraries are physically grouped.
#
# Safe because consumers import by package name (@papercusp/<x>), never by
# path — so moving the directory only requires fixing .gitmodules, the root
# workspace globs, and the node_modules symlinks. This script does all of
# that atomically.
#
#   scripts/regroup-borrowable-libs.sh            # DRY RUN — print the plan
#   scripts/regroup-borrowable-libs.sh --execute  # perform the move
#   scripts/regroup-borrowable-libs.sh --execute --force   # skip safety gates
#
# Preconditions (enforced unless --force):
#   1. The operator must NOT be running (:3070) — a live process would
#      re-resolve a moved module mid-flight and 500. Stop the desktop first.
#   2. No target submodule may be dirty — moving it would drag another
#      agent's uncommitted work to a new path.
#
# After a successful --execute: commit the moved gitlinks + .gitmodules +
# package.json + the regenerated BORROWABLE.md, then restart the operator.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DEST="libs/generic"
# The borrowable submodules (papergrid carries grid-core/grid/bloom-grid).
TARGETS=(sse sync token-kit chat-protocol search-core rerank git-graph ui-primitives papergrid)

EXECUTE=0; FORCE=0
for a in "$@"; do
  case "$a" in
    --execute) EXECUTE=1 ;;
    --force)   FORCE=1 ;;
    *) echo "unknown arg: $a" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
run() { if [ "$EXECUTE" = 1 ]; then eval "$@"; else say "  would run: $*"; fi; }

# ── Safety gates ─────────────────────────────────────────────────────────
if [ "$FORCE" != 1 ]; then
  if curl -sf -m2 http://127.0.0.1:3070/ >/dev/null 2>&1; then
    say "ABORT: operator is running on :3070. Stop the desktop/operator first"
    say "       (a live process would re-resolve a moved module and break)."
    say "       Re-run with --force only if you know the operator is down."
    [ "$EXECUTE" = 1 ] && exit 1
    say "(dry-run continues for planning)"
  fi
  dirty=()
  for t in "${TARGETS[@]}"; do
    [ -d "libs/$t" ] || continue
    [ -n "$(git -C "libs/$t" status --porcelain 2>/dev/null)" ] && dirty+=("libs/$t")
  done
  if [ "${#dirty[@]}" -gt 0 ]; then
    say "ABORT: target submodules have uncommitted changes: ${dirty[*]}"
    say "       Commit/settle them first (their changes would move to the new path)."
    [ "$EXECUTE" = 1 ] && exit 1
    say "(dry-run continues for planning)"
  fi
fi

say ""
say "== Plan: move ${#TARGETS[@]} submodules into $DEST/ =="
run "mkdir -p '$DEST'"

# ── 1. git mv each submodule (updates .gitmodules + the gitlink) ──────────
for t in "${TARGETS[@]}"; do
  if [ ! -e "libs/$t" ]; then say "  skip libs/$t (missing)"; continue; fi
  run "git mv 'libs/$t' '$DEST/$t'"
done

# ── 2. repoint node_modules symlinks (root + per-app) ────────────────────
say "-- repoint @papercusp symlinks that target a moved lib --"
mapfile -t LINK_DIRS < <(find . -type d -path '*/node_modules/@papercusp' -not -path '*/.git/*' 2>/dev/null)
for d in "${LINK_DIRS[@]}"; do
  for link in "$d"/*; do
    [ -L "$link" ] || continue
    tgt="$(readlink "$link")"
    new="$tgt"
    for t in "${TARGETS[@]}"; do
      new="$(printf '%s' "$new" | sed -E "s#/libs/$t(/|$)#/libs/generic/$t\1#g")"
    done
    if [ "$new" != "$tgt" ]; then
      say "  $link: $tgt -> $new"
      run "rm -f '$link' && ln -s '$new' '$link'"
    fi
  done
done

# ── 3. root package.json workspace globs ─────────────────────────────────
say "-- rewrite libs/<x> workspace globs to libs/generic/<x> --"
for t in "${TARGETS[@]}"; do
  run "sed -i -E 's#\"libs/$t(/[^\"]*)?\"#\"libs/generic/$t\1\"#g' package.json"
done

# ── 4. catalog generator paths + regenerate ──────────────────────────────
say "-- update gen-borrowable-catalog.mjs paths + regenerate BORROWABLE.md --"
for t in "${TARGETS[@]}"; do
  run "sed -i -E \"s#'libs/$t(/[^']*)?'#'libs/generic/$t\1'#g\" scripts/gen-borrowable-catalog.mjs"
done
run "node scripts/gen-borrowable-catalog.mjs"

# ── 5. verify no dangling @papercusp symlinks ────────────────────────────
if [ "$EXECUTE" = 1 ]; then
  say "-- verify: no dangling @papercusp symlinks --"
  bad=0
  for d in $(find . -type d -path '*/node_modules/@papercusp' -not -path '*/.git/*' 2>/dev/null); do
    for link in "$d"/*; do
      [ -L "$link" ] || continue
      [ -e "$link" ] || { say "  DANGLING: $link -> $(readlink "$link")"; bad=1; }
    done
  done
  [ "$bad" = 0 ] && say "  ok — all resolve"
  say ""
  say "DONE. Next: review, then commit the move:"
  say "  git add -A package.json scripts/ BORROWABLE.md .gitmodules $DEST"
  say "  git commit -m 'refactor(libs): group borrowable submodules under libs/generic/'"
  say "  # then restart the operator (tsx host has no file-watch)"
else
  say ""
  say "DRY RUN complete. Re-run with --execute (operator stopped) to apply."
fi
