# shellcheck shell=bash
# source-tree-selection.sh — THE one definition of which monorepo files form the
# public-safe source cut (plan dhh-source-preview-2026-09-28 D-002/D-003).
#
# Two producers ship this cut, and they must never disagree about it:
#   1. bin/stage-source-tree.sh      → sidecar/source.tar.zst inside every desktop
#                                      installer (WI-3308 / WI-4419).
#   2. bin/source-tree-select.sh     → the directory form, used by the private
#      (via scripts/source-preview.mjs)  source preview repo (Papercusp/papercusp-preview).
# Both SOURCE this file and call `source_tree_selection`. Before this file existed
# the allowlist and heavy excludes lived inline in stage-source-tree.sh; a second
# copy for the preview would have drifted exactly the way the pre-WI-4419 exclude
# list drifted from the gate. Edit the selection HERE, and only here.
#
# The privacy/secrets half is still not maintained here either: it is derived at
# run time from audit-release-bundle.py --tar-excludes, the same rule the gate
# enforces (WI-4419). This file adds only the size/irrelevance excludes and the
# top-level allowlist.
#
# PORTABILITY: runs under macOS /bin/bash 3.2 (the mac release leg). So: no
# mapfile/readarray, no `declare -g`, no associative arrays. The function assigns
# plain globals (a `declare` inside a function would make them local).
#
# Usage:
#   . "$HERE/lib/source-tree-selection.sh"
#   source_tree_selection "$HERE" "$MONO" installer   # or: preview
# Sets the globals:
#   SELECTION_EXCLUDES  — GNU tar --exclude=… arguments
#   SELECTION_INCLUDES  — ./<entry> members to pass to tar -C "$MONO"
#   SELECTION_MISSING   — allowlist entries absent from this tree (informational)
# Returns non-zero (after printing the reason) when the tree cannot be staged.
#
# Modes:
#   installer — the runnable dogfood tree: node_modules IS shipped (it is the
#               toolchain a packaged install has no npm to recreate) and required.
#   preview   — the review copy: identical selection minus node_modules. A
#               reader installs dependencies from the shipped package-lock.json.

# The top-level allowlist (WI-4419). Anything not named here does not ship,
# including things that do not exist yet — adding a top-level dir to the repo is
# a deliberate decision to ship it.
#
# NOT shipped, on purpose: .papercusp .agent-tmp .claude .harness .nx .tmp*
# .vitest-tmp .pcv-socktest scratch scratchpad test-results briefs _retired
# papercusp-desktop .git .github benchmarks infra deploy — plus every root dotfile
# (.env* .bashrc .gitconfig .npmrc .mcp.json*), which git happens to TRACK here,
# so "tracked" was never a safety signal either.
SOURCE_TREE_ALLOWLIST="package.json package-lock.json tsconfig.base.json .nvmrc
tsconfig.declarations.json vitest.config.ts
eslint.config.mjs knip.json bunfig.toml .gitignore
CLAUDE.md AGENTS.md BORROWABLE.md
node_modules apps libs packages
tools scripts templates patches design design-tokens rubrics docs bin"

source_tree_selection() {
  local here="$1" mono="$2" mode="${3:-installer}"
  local pat tdir entry required required_set

  case "$mode" in
    installer) required_set="node_modules apps libs packages" ;;
    preview) required_set="apps libs packages" ;;
    *)
      echo "ERROR: source_tree_selection: unknown mode '$mode' (installer|preview)" >&2
      return 1
      ;;
  esac

  SELECTION_EXCLUDES=()
  SELECTION_INCLUDES=()
  SELECTION_MISSING=()

  # (1) secrets / privacy — from the gate, never re-typed here (WI-4419).
  while IFS= read -r pat; do
    [[ -n "$pat" ]] && SELECTION_EXCLUDES+=(--exclude="$pat")
  done < <(python3 "$here/audit-release-bundle.py" --tar-excludes)
  if (( ${#SELECTION_EXCLUDES[@]} == 0 )); then
    echo "ERROR: audit-release-bundle.py --tar-excludes returned nothing — refusing to stage an UNFILTERED tree (WI-4419)" >&2
    return 1
  fi

  # (2) heavy / irrelevant — size, not secrecy. Read these as a postmortem log:
  # cargo-target blew up the 0.0.5 cut, .next tripled 0.0.8 (WI-4229), and the
  # operator-docs dist is a static site nothing consumes that re-bakes the build
  # box identity on every docs rebuild (WI-4419).
  SELECTION_EXCLUDES+=(
    --exclude='./papercusp-desktop'
    --exclude='./target' --exclude='./.cargo-target'
    --exclude='./.wi*-cargo-target' --exclude='./*cargo-target*'
    --exclude='./.next' --exclude='*/.next'
    --exclude='*/.turbo'
    --exclude='./apps/operator-docs/dist' --exclude='*/operator-docs/dist'
    --exclude='./.idea' --exclude='*/.idea'
    --exclude='./.vscode' --exclude='*/.vscode'
    --exclude='*.log'
    --exclude='*.tsbuildinfo'
    --exclude='./.DS_Store' --exclude='*/.DS_Store'
  )

  # (3) license — not ours to ship. The gitnexus-bridge plugin launches
  # `npx gitnexus`, and GitNexus is PolyForm-Noncommercial-1.0.0, which a
  # commercial ELv2 build must not install on a user's machine
  # (plan open-source-release-2026-09-29 P-020). npm tolerates the now-missing
  # workspace directory under both `npm install` and `npm ci`; the installer's
  # node_modules symlink to it goes too so nothing dangles.
  # Its patch-package patch goes with it: gitnexus-vendor is installed only as
  # that workspace's dependency, and `patch-package` FAILS the root postinstall
  # (so a stranger's `npm ci`) on a patch for a package that is not installed
  # (open-source-release P-008/P-009, measured on the public export).
  SELECTION_EXCLUDES+=(
    --exclude='./libs/papercusp/plugins/gitnexus-bridge'
    --exclude='./node_modules/@papercupai/gitnexus-bridge'
    --exclude='./patches/gitnexus-vendor+*'
  )

  # (4) closed / internal content — not part of the open-source product (plan
  # open-source-release-2026-09-29 P-005, D-008). Closed-layer workspaces with no
  # importer in the shipped tree (publish worker, swarm marketing site, marketplace
  # UI, prospect contract), internal evidence/briefs/reports, and a built
  # storybook. Like (3), npm tolerates the missing workspace directories.
  SELECTION_EXCLUDES+=(
    --exclude='./apps/papercusp-publish'
    --exclude='./apps/the-swarm-site'
    --exclude='./libs/marketplace-public-ui'
    --exclude='./libs/generic/prospect-contract'
    --exclude='./node_modules/@papercusp/publish-worker'
    --exclude='./node_modules/@papercusp/the-swarm-site'
    --exclude='./node_modules/@papercup/marketplace-public-ui'
    --exclude='./node_modules/@oddsmith/prospect-contract'
    --exclude='./docs/evidence'
    --exclude='./docs/briefs'
    --exclude='./docs/reports'
    --exclude='*/storybook-static'
    # Real session/doc/plan text sampled for the memory benchmark; the guards
    # that read them skip when absent (prose-gold-set.test.ts).
    --exclude='./packages/operator-core/lib/memory/bench/fixtures/prose-corpus.v1.json'
    --exclude='./packages/operator-core/lib/memory/bench/fixtures/prose-gold-set.v1.json'
  )
  # The preview never ships dependencies, at any depth: a nested node_modules
  # inside apps/ or libs/ is installed output, not source.
  if [[ "$mode" == "preview" ]]; then
    SELECTION_EXCLUDES+=(--exclude='./node_modules' --exclude='*/node_modules')
  fi

  # Rust/Cargo build targets at ANY depth, discovered rather than listed (a
  # blanket `*/target` would drop node_modules/weapon-regex's shipped runtime
  # under core/target/). A cargo target bakes the build box's home path into
  # .rustc_info.json / *.d / binaries — the 0.0.9 mac leg leaked it ×8075.
  while IFS= read -r tdir; do
    [[ -n "$tdir" ]] && SELECTION_EXCLUDES+=(--exclude="$tdir")
  done < <(cd "$mono" && find . -type d -name node_modules -prune -o -type d -name target -print 2>/dev/null)

  for entry in $SOURCE_TREE_ALLOWLIST; do
    if [[ "$mode" == "preview" && "$entry" == "node_modules" ]]; then
      continue
    fi
    if [[ -e "$mono/$entry" ]]; then
      SELECTION_INCLUDES+=("./$entry")
    else
      SELECTION_MISSING+=("$entry")
    fi
  done

  # The load-bearing entries — a packaged install has no npm to repair a gap, so
  # a missing one is a silently-broken dev/local button, not a warning.
  for required in $required_set; do
    if [[ ! -e "$mono/$required" ]]; then
      echo "ERROR: allowlist requires $mono/$required — refusing to stage a tree the dev/local buttons cannot run" >&2
      return 1
    fi
  done
  return 0
}
