#!/usr/bin/env bash
# The installed-TUI release stage (pui-first-party-public-release P-012 / D-018).
#
# Installs one candidate archive from apps/tui/scripts/package-release.sh into a
# clean HOME, drives the production-operator PTY suites through that installed
# bin/pui, and writes <archive>.acceptance.json. An archive may be published
# (P-014/P-015) only with a passing acceptance file for the same digest.
#
# Isolation (EI-24692155752067316). The stage runs tsx, vitest, the suites and
# the operator fixture from the checkout it executes in. Run from the shared
# working tree, a peer's half-written edit lands in the run: rehearsal
# 37bc2d4c32 lost its claude leg to a transient scripts/next-migration.js and
# its omp leg to a mid-edit syntax error in gateway.ts, neither of them PUI code.
# So this script checks out the archive's own source commit (PROVENANCE.json
# source.commit) with the release checkout helper, object-sourced and with
# node_modules hardlinked, and runs the stage from there. Up to three reusable
# checkouts live under PUI_ACCEPTANCE_CHECKOUT_ROOT (default
# ~/.cache/pui-acceptance-checkouts) and are re-pinned on each use.
# PUI_ACCEPTANCE_ALLOW_LIVE_TREE=1 runs in place instead, for development only:
# the verdict then refuses (release-acceptance-run.ts runnerTreeRefusals).
#
# Exit 0 = accepted, 1 = refused (the file names every reason), 2 = could not run.
# --help prints the options. Setup output goes to stderr; stdout carries only
# the stage's own PUI_RELEASE_ACCEPTANCE line.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
run_in() {
  local root="$1"; shift
  exec "$root/node_modules/.bin/tsx" "$root/packages/operator-core/lib/pui-e2e/release-acceptance-cli.mts" "$@"
}
fail() { echo "release-acceptance: ERROR: $*" >&2; exit 2; }

archive=""
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  case "${args[i]}" in
    --archive) archive="${args[i + 1]:-}" ;;
    --archive=*) archive="${args[i]#--archive=}" ;;
    -h|--help) run_in "$ROOT" "$@" ;;
  esac
done
# No archive: the CLI prints its usage. Already re-executed, or opted out: run here.
if [ -z "$archive" ] || [ -n "${PUI_ACCEPTANCE_ISOLATED:-}" ] || [ "${PUI_ACCEPTANCE_ALLOW_LIVE_TREE:-}" = 1 ]; then
  run_in "$ROOT" "$@"
fi

[ -f "$archive" ] || fail "no archive at $archive"
provenance="$(tar -xzOf "$archive" --wildcards --no-wildcards-match-slash '*/PROVENANCE.json')" \
  || fail "$archive carries no top-level PROVENANCE.json"
sha="$(printf '%s' "$provenance" | node -e '
  let text = "";
  process.stdin.on("data", (chunk) => { text += chunk; }).on("end", () => {
    const commit = JSON.parse(text).source?.commit ?? "";
    if (!/^[0-9a-f]{40}$/.test(commit)) process.exit(1);
    process.stdout.write(commit);
  });')" || fail "$archive PROVENANCE.json has no 40-hex source.commit"

checkouts="${PUI_ACCEPTANCE_CHECKOUT_ROOT:-$HOME/.cache/pui-acceptance-checkouts}"
mkdir -p "$checkouts"
# A few reusable slots, each re-pinned per run: bounded disk, and a re-pin moves
# only what changed. One run per slot, since a second would re-pin the tree
# under the first. The lock is held by this process and everything it execs; a
# leftover child of an earlier run holds it too (`fuser -v <slot>.lock`).
checkout=""
for slot in 1 2 3; do
  exec 9>"$checkouts/slot-$slot.lock"
  if flock -n 9; then checkout="$checkouts/slot-$slot"; break; fi
  exec 9>&-
done
[ -n "$checkout" ] || fail "all three acceptance checkouts under $checkouts are held by other runs"

echo "release-acceptance: checking out candidate source $sha at $checkout" >&2
bash "$ROOT/apps/operator/bin/release/setup-release-checkout.sh" \
  --ref "$sha" --integration "$ROOT" --release "$checkout" \
  --node-modules force --node-modules-copy hardlink --node-modules-generation off \
  --source-integrity object-sourced >&2 \
  || fail "could not check out $sha at $checkout (setup-release-checkout.sh failed; output above)"
landed="$(git -C "$checkout" rev-parse HEAD)"
[ "$landed" = "$sha" ] || fail "checkout $checkout is at $landed, not the candidate source $sha"

export PUI_ACCEPTANCE_ISOLATED="$checkout"
run_in "$checkout" "$@"
