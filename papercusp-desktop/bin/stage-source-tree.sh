#!/usr/bin/env bash
# stage-source-tree.sh — WI-3308; plan env-switcher-packaged-all-platforms-2026-07-06.
#
# The "all-5-buttons" dogfood bundle: the dev(:3270) + local(:3055) env buttons
# run from SOURCE (dev = `tsx apps/operator/bin/hono-host.ts`; local = the Vite
# SPA dev server over apps/operator-vite). The launcher gates both on
# detectPapercupRoot() + defaultHasToolchain() (env-operator-launcher.ts). A
# packaged install has NO npm/npx/tsx, so we ship a PRE-`npm install`ed runnable
# monorepo tree + its node_modules; the bundled node (sidecar/bin/node,
# v24.15.0) runs the tree's OWN tsx/vite (proven WI-3308: tsx v4.21.0 + vite
# 7.3.5 both run under the bundled node with no npm/npx on PATH).
#
# ARCHITECTURE (pinned; Mac/Win mirror): ship the tree as ONE compressed
# resource `sidecar/source.tar.zst`, extracted on FIRST BOOT to a WRITABLE dir,
# with PAPERCUSP_INTEGRATION_ROOT pointed at it — NOT an uncompressed
# `sidecar/**` glob. Rationale: the install dir (/usr/lib/…) is read-only so an
# in-place tree can't be edited (editability is the whole point of a dogfood
# source drop); tauri copying ~9GB uncompressed through its resource pipeline is
# slow; and node_modules `.bin/*` symlinks survive `tar` but not tauri's copy.
#
# DEFAULT-ON since the all-5-buttons dogfood bundle is VM-verified end-to-end on
# Linux (WI-3308, 2026-07-07: dev:3270 + local:3055 spawn from the extracted tree;
# Windows WI-3306 / Mac WI-3307 mirror the same seams) — a finished feature never
# ships dark. Opt OUT with PAPERCUSP_STAGE_SOURCE=0 (e.g. a deliberately smaller
# build with only the 3 bundled-sidecar buttons).
#
# Runs AFTER bin/build-desktop-sidecar.sh (needs a fresh src-tauri/sidecar/) and
# BEFORE `tauri build` (so the existing `sidecar/**/*` resources glob in
# tauri.conf.json + tauri.server.conf.json sweeps source.tar.zst into the
# bundle — zero tauri.conf / Rust glob changes needed). src-tauri/sidecar/ is
# .gitignored, so the multi-GB artifact never reaches git-sync.
set -euo pipefail

# ── Self-read guard (WI-3306, 2026-07-08): the body runs inside this { } group
# so bash reads the whole script before executing — a peer editing this
# shared-tree file during the multi-minute tar below can't corrupt the running
# shell's read offset. Matching } + exit at EOF. Same guard as the caller,
# bin/build-windows-on-vm.sh (and bin/mac-vm-build.sh, which also stages here).
{
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"                  # papercusp-desktop
# monorepo root (apps/, libs/, node_modules/) — override via
# PAPERCUSP_STAGE_SOURCE_ROOT (WI-3307: the mac cross-build leg points this at
# a darwin-arch cross-installed tree from cross-install-darwin-tree.sh instead
# of this box's own linux-native tree, so the shipped node_modules matches the
# bundled darwin node instead of breaking at runtime).
MONO="$(cd "${PAPERCUSP_STAGE_SOURCE_ROOT:-$ROOT/..}" && pwd)"
# An audited tooling revision can stage the frozen source into an isolated
# candidate sidecar without rebuilding or editing the frozen checkout (D-150).
# Reuse the existing source-root override and the same lock/publish/audit path.
SIDECAR="${PAPERCUSP_STAGE_SOURCE_SIDECAR:-$ROOT/src-tauri/sidecar}"
SOURCE_PACKAGE_LOCK_PIN="${PAPERCUSP_SOURCE_PACKAGE_LOCK_PIN:-}"
SOURCE_PACKAGE_LOCK_PIN_TMP=""
SOURCE_PACKAGE_LOCK_PIN_DIR=""
SOURCE_PACKAGE_LOCK_PIN_COPY=""
SOURCE_PACKAGE_LOCK_ARCHIVE_TMP=""

if [[ "${PAPERCUSP_STAGE_SOURCE:-1}" != "1" ]]; then
  echo "==> stage-source-tree: skipped (PAPERCUSP_STAGE_SOURCE=0 — building without the dev/local runnable source tree; only the 3 bundled-sidecar buttons will work — WI-3308)"
  exit 0
fi

if [[ ! -f "$SIDECAR/serve.mjs" ]]; then
  echo "ERROR: $SIDECAR/serve.mjs missing — run bin/build-desktop-sidecar.sh first" >&2
  exit 1
fi
# The mono root MUST carry the detectPapercupRoot() markers, or dev/local skip
# with 'no-source-tree' at runtime.
if [[ ! -f "$MONO/apps/operator/package.json" || ! -f "$MONO/libs/papercusp/package.json" ]]; then
  echo "ERROR: $MONO is not the monorepo root (missing apps/operator + libs/papercusp package.json markers)" >&2
  exit 1
fi
# The tree MUST ship PRE-installed — installs have no npm/npx to populate it.
if [[ ! -x "$MONO/node_modules/.bin/tsx" ]]; then
  echo "ERROR: $MONO/node_modules/.bin/tsx missing — run 'npm install' at the monorepo root first (defaultHasToolchain needs <root>/node_modules/.bin; installs have no npm)" >&2
  exit 1
fi

# The sidecar build may reify a workspace-scoped npm install in the shared
# source tree. npm is allowed to update package-lock.json while doing so, but
# source.tar.zst is a committed-source artifact: it must contain the lockfile
# from the pinned Git commit, never the mutable post-install copy. Mac's
# cross-install caller supplies this file because its scratch tree has no .git;
# direct Linux/Windows callers derive the same external pin here. The pin stays
# outside MONO and SIDECAR so neither the package nor the archive can discover it
# accidentally.
if [[ -z "$SOURCE_PACKAGE_LOCK_PIN" ]]; then
  SOURCE_PACKAGE_LOCK_PIN_TMP="$(mktemp "${TMPDIR:-/tmp}/papercusp-source-package-lock-pin.XXXXXX")"
  if ! git -C "$MONO" show HEAD:package-lock.json > "$SOURCE_PACKAGE_LOCK_PIN_TMP"; then
    rm -f "$SOURCE_PACKAGE_LOCK_PIN_TMP"
    SOURCE_PACKAGE_LOCK_PIN_TMP=""
    echo "ERROR: could not materialize committed HEAD:package-lock.json — refusing to stage mutable source" >&2
    exit 1
  fi
  SOURCE_PACKAGE_LOCK_PIN="$SOURCE_PACKAGE_LOCK_PIN_TMP"
fi
[[ -f "$SOURCE_PACKAGE_LOCK_PIN" && -s "$SOURCE_PACKAGE_LOCK_PIN" ]] \
  || { echo "ERROR: committed package-lock pin is missing or empty: $SOURCE_PACKAGE_LOCK_PIN" >&2; exit 1; }
[[ -f "$MONO/package-lock.json" ]] \
  || { echo "ERROR: $MONO/package-lock.json missing — refusing to stage without a committed lockfile member" >&2; exit 1; }

# ── IDENTITY-POLICY COMPATIBILITY PREFLIGHT. D-112 makes the release identity
# policy machine-only, so owner name/email are not required. Keep this audit-owned
# entrypoint in place for older cutters and future early policy checks.
python3 "$HERE/audit-release-bundle.py" --owner-preflight \
  || { echo "ERROR: identity-policy preflight failed — refusing to start source staging" >&2; exit 2; }

OUT="$SIDECAR/source.tar.zst"

# ── Serialize against build-desktop-sidecar.sh (2026-07-12) ─────────────────
# We write source.tar.zst INTO the sidecar dir, and build-desktop-sidecar.sh
# REBUILDS that whole dir (rm -rf + atomic rename of a temp sibling). It takes a
# lock (EI-160) to protect readers from a half-written bundle — but this script
# never did, so a `npm run dev` (which rebuilds the sidecar) racing a release
# stage silently swapped the directory out from under our multi-minute tar: tar
# and zstd both reported SUCCESS, and the finished bundle was simply gone one
# line later. Observed 2026-07-12: the stage died on `du: cannot access
# .../source.tar.zst`, having produced nothing, while three `tauri dev` shells
# ran. Take the SAME lock (same path, so the two scripts actually exclude each
# other) for the whole tar, and the rebuild waits its turn instead of eating the
# artifact.
#
# NOT -n: we WAIT. A release stage that aborts because someone opened the dev
# shell is a worse failure than one that takes a few minutes longer.
exec 9>"$SIDECAR.lock"
STAGE_LOCKDIR=""
if [[ "${PAPERCUSP_SIDECAR_LOCK_HELD:-0}" == "1" ]]; then
  # The caller already holds an flock on THIS sidecar.lock for our whole run and
  # invokes us from inside it (build-windows-on-vm.sh's pack subshell:
  # `( flock 9; … bash stage-source-tree.sh; tar … ) 9>>src-tauri/sidecar.lock`).
  # Re-acquiring here would SELF-DEADLOCK: the `exec 9>` above opened a NEW open
  # file description, so `flock 9` would block on the caller's still-held lock
  # while the caller blocks waiting for us to return. Observed live on the
  # 2026-07-13 0.0.9 win leg — this script printed "build-desktop-sidecar.sh holds
  # … waiting" (it was the CALLER holding it, not build-desktop-sidecar.sh) then
  # hung on `flock 9` until killed. The caller's lock already gives us the exact
  # SIDECAR-publish exclusion this acquire would — so skip it. (mac-vm-build.sh /
  # build-linux-local.sh / release-local.sh call us WITHOUT the flag and still
  # self-lock below.)
  echo "    → sidecar.lock already held by the caller (PAPERCUSP_SIDECAR_LOCK_HELD=1) — not re-acquiring"
elif command -v flock >/dev/null 2>&1; then
  if ! flock -n 9; then
    echo "    → build-desktop-sidecar.sh holds $SIDECAR.lock — waiting (it would delete this bundle mid-tar)"
    flock 9
  fi
else
  # macOS ships no flock(1) — the same mkdir spinlock + stale-PID reclaim
  # build-desktop-sidecar.sh falls back to, on the SAME lockdir path (mac-vm-build.sh
  # calls this stager, so the mac leg needs the protection too — WI-3307).
  STAGE_LOCKDIR="$SIDECAR.lockdir"
  while ! mkdir "$STAGE_LOCKDIR" 2>/dev/null; do
    holder="$(cat "$STAGE_LOCKDIR/pid" 2>/dev/null || true)"
    if [[ -n "$holder" ]] && ! kill -0 "$holder" 2>/dev/null; then
      rm -rf "$STAGE_LOCKDIR"
      continue
    fi
    echo "    → another sidecar build/stage holds $STAGE_LOCKDIR — waiting for it"
    sleep 5
  done
  echo "$$" > "$STAGE_LOCKDIR/pid"
fi
SCRUB_DIR=""
OUT_TMP=""
trap 'rm -f ${OUT_TMP:+"$OUT_TMP"} ${SOURCE_PACKAGE_LOCK_PIN_TMP:+"$SOURCE_PACKAGE_LOCK_PIN_TMP"} ${SOURCE_PACKAGE_LOCK_ARCHIVE_TMP:+"$SOURCE_PACKAGE_LOCK_ARCHIVE_TMP"}; rm -rf ${STAGE_LOCKDIR:+"$STAGE_LOCKDIR"} ${SCRUB_DIR:+"$SCRUB_DIR"} ${SOURCE_PACKAGE_LOCK_PIN_DIR:+"$SOURCE_PACKAGE_LOCK_PIN_DIR"}' EXIT

# Re-check AFTER taking the lock: a rebuild we just waited on may have replaced
# the sidecar (the serve.mjs check above ran unlocked, so its answer is stale).
if [[ ! -f "$SIDECAR/serve.mjs" ]]; then
  echo "ERROR: $SIDECAR/serve.mjs missing after acquiring the sidecar lock — run bin/build-desktop-sidecar.sh first" >&2
  exit 1
fi

# Never leave a stale or interrupted archive at the final path. The replacement
# is published only after tar, zstd, and the release-bundle audit all succeed.
rm -f "$OUT"
OUT_TMP="$(mktemp "${OUT}.tmp.XXXXXX")"
echo "==> stage-source-tree: taring runnable monorepo tree from $MONO"

# EXCLUDES. Two classes, and only ONE of them is maintained here:
#
# (1) SECRETS / PRIVACY — NOT maintained here. Derived at run time from
#     bin/audit-release-bundle.py --tar-excludes, which is also THE GATE that
#     fails this build if any of it slips through. These used to be two
#     hand-kept lists of the same knowledge — a denylist here, a regex set
#     there — and two copies drift by construction. Read the old list as a
#     postmortem log: cargo-target added after it blew up the 0.0.5 cut, .next
#     after it tripled 0.0.8, and NOBODY had ever heard of .papercusp/, so 0.0.8
#     shipped 121 agent session transcripts. Now the exclude and the check that
#     catches a missed exclude come from ONE rule (WI-4419).
#
#     Nested is the half the top-level allowlist below cannot do: the junk sits
#     INSIDE apps/ and packages/ (packages/operator-core/.papercusp,
#     apps/operator/test-results, **/.vitest-tmp), and some of it is git-TRACKED
#     via a .gitignore anchoring bug — so "tracked" was never a safety signal.
#
# (2) HEAVY / IRRELEVANT to running dev(:3270 tsx hono-host)/local(:3055 vite):
#     .git (7.2G history); papercusp-desktop/ (the Tauri/Rust shell — its own
#     src-tauri/sidecar 2G self-reference, seed 2.1G, Rust target; the operators
#     never import it and detectPapercupRoot's markers live at the mono root);
#     Rust build targets; editor dirs; logs; tsbuildinfo. Size, not secrecy —
#     so it stays local, and a miss here is a fat bundle, not a leak.
#
# node_modules IS KEPT — it is the shipped toolchain (tsx/vite + the whole
# @papercusp/* runtime closure). dist/ is DELIBERATELY kept: some internal
# packages resolve their "main" to a built dist/ at runtime, so pruning it
# would break module resolution. .next is NOT kept (2026-07-11, 0.0.8 cut):
# apps/operator/.next had grown to 21G (19.5G webpack cache) and bloated the
# 0.0.8 GUI deb to 9.4GB (0.0.6: 2.9GB) with a ~35G first-boot extract; the
# standalone Next operator path is RETIRED and nothing in hono-host /
# host-bootstrap / env-operator-launcher resolves into .next at runtime.
# The selection itself — privacy excludes (derived from the gate), heavy
# excludes, discovered cargo targets, and the top-level ALLOWLIST — lives in
# bin/lib/source-tree-selection.sh, shared with the private source preview
# (bin/source-tree-select.sh, plan dhh-source-preview-2026-09-28) so the two
# cuts cannot drift apart. The WHY of every entry is documented there.
# shellcheck source=lib/source-tree-selection.sh
. "$HERE/lib/source-tree-selection.sh"
source_tree_selection "$HERE" "$MONO" installer || exit 1
declare -a EXCLUDES=("${SELECTION_EXCLUDES[@]}")
declare -a INCLUDES=("${SELECTION_INCLUDES[@]}")
declare -a MISSING=()
(( ${#SELECTION_MISSING[@]} == 0 )) || MISSING=("${SELECTION_MISSING[@]}")
echo "    selection: ${#EXCLUDES[@]} exclude patterns (privacy half derived from the gate's rules)"
(( ${#MISSING[@]} == 0 )) \
  || echo "    note: allowlist entries absent from this tree (skipped): ${MISSING[*]}"
echo "    allowlist: ${#INCLUDES[@]} top-level entries"

# GNU tar REQUIRED (WI-3307 mac leg): both the final source archive and the
# scrub-candidate membership filter below must use the same exclude dialect.
# On macOS: brew install gnu-tar → gtar.
TAR_BIN=tar
if ! tar --version 2>/dev/null | grep -q 'GNU tar'; then
  if command -v gtar >/dev/null 2>&1; then
    TAR_BIN=gtar
  else
    echo "ERROR: GNU tar required (macOS: brew install gnu-tar) — bsdtar's --owner/exclude dialect differs" >&2
    exit 1
  fi
fi

# ── IDENTITY SCRUB (WI-4419; desktop-v0-0-12-release-tri-platform-2026-07-19 D-004)
# ─────────────────────────────────────────────────────────────────────────────
# The audit gate (below) forbids this build box's identity — git name ("Avi"),
# home path, unix user, email, hostname — plus the known cross-box creds, in the
# shipped bytes. Dev-infra and agent-authored SOURCE keeps re-introducing them into
# MUST-SHIP files: [owner:Avi] provenance comments in prod .ts/.sql, dev systemd
# ExecStart=/home/<user> units, test fixtures hardcoding the build username. Those
# files ship (or run), so they can't be pruned like a scratch dir, and hand-editing
# each one is a treadmill that reds the next cut the instant a new tag lands. So:
# redact every identity literal in a COPY of each leaking source file, and tar the
# copy IN PLACE OF the original via a --transform overlay (streams — never touches
# the shared working tree, never node_modules; a vendored leak is a delete-exclude
# class handled above). BOTH the literal→placeholder map AND the leaking-file set
# come from the gate's ONE rule (audit-release-bundle.py --identity-literals /
# --source-leakers), so the scrub cannot drift from what the gate later fails on.
# This REMOVES the leak from the shipped bytes — the gate still fails on anything
# left un-redacted, so it is not an exception. Opt out: PAPERCUSP_STAGE_SCRUB=0.
declare -a SCRUB_EXCLUDES=()
declare -a SCRUB_MEMBERS=()
declare -a SCRUB_TRANSFORM=()
if [[ "${PAPERCUSP_STAGE_SCRUB:-1}" == "1" ]]; then
  declare -a _leakers=()
  # NOTE: portable read loop instead of `mapfile -t` — mapfile/readarray is a
  # bash-4+ builtin and this script also runs on the mac release VM, whose
  # default /bin/bash is 3.2 (macOS ships no newer bash); mapfile there aborts
  # the build with `mapfile: command not found` (exit 127) — broke the mac
  # v0.0.12 leg. This loop is functionally identical to `mapfile -t` (strips the
  # trailing newline per line and drops the final empty line).
  while IFS= read -r _leak_line; do
    [[ -n "$_leak_line" ]] && _leakers+=("$_leak_line")
  done < <(python3 "$HERE/audit-release-bundle.py" --source-leakers "$MONO" "${INCLUDES[@]#./}")
  if (( ${#_leakers[@]} > 0 )); then
    # Selection owns which files ship. Filter the content-discovered candidates
    # through its exact GNU-tar exclusions before creating the redacted overlay;
    # otherwise that second pass can smuggle an excluded report back in.
    _leaker_count_before_selection=${#_leakers[@]}
    if ! _filtered_leakers="$(
      source_tree_filter_candidate_files "$TAR_BIN" "$MONO" "${_leakers[@]}"
    )"; then
      echo "ERROR: could not filter identity scrub candidates through source selection" >&2
      exit 1
    fi
    _leakers=()
    while IFS= read -r _leak_line; do
      [[ -n "$_leak_line" ]] && _leakers+=("$_leak_line")
    done <<< "$_filtered_leakers"
    _leaker_count_excluded=$((_leaker_count_before_selection - ${#_leakers[@]}))
    (( _leaker_count_excluded == 0 )) \
      || echo "    identity scrub: selection kept $_leaker_count_excluded excluded candidate file(s) out of the overlay"
  fi
  if (( ${#_leakers[@]} > 0 )); then
    # Keep the quarantine outside the packaged sidecar. Tauri/deb packaging can
    # read the sidecar after source.tar.zst appears but before this script's EXIT
    # trap runs; an in-sidecar quarantine then becomes public duplicate payload.
    # The trap still removes this external workspace, but cleanup timing can no
    # longer change the contents of any sidecar artifact (EI-20559353000427453).
    SCRUB_DIR="$(mktemp -d "${TMPDIR:-/tmp}/papercusp-stage-scrub-XXXXXX")"
    for _rel in "${_leakers[@]}"; do
      [[ -f "$MONO/$_rel" ]] || continue
      mkdir -p "$SCRUB_DIR/SCRUBBED/$(dirname "$_rel")"
      cp -p "$MONO/$_rel" "$SCRUB_DIR/SCRUBBED/$_rel"
      # The audit-owned scrubber applies the same case-folded occurrence rule as
      # the final scan. Unlike blanket sed it preserves proven AVI media tokens
      # and opaque Vite hashes even when a mixed file also carries real identity.
      python3 "$HERE/audit-release-bundle.py" --scrub-text \
        "$SCRUB_DIR/SCRUBBED/$_rel"
      SCRUB_EXCLUDES+=(--exclude="./$_rel")
      SCRUB_MEMBERS+=("./SCRUBBED/$_rel")
    done
    SCRUB_TRANSFORM+=(--transform='s|^\./SCRUBBED/|./|')
    echo "    identity scrub: redacted ${#SCRUB_MEMBERS[@]} must-ship source file(s) in the bundle (WI-4419 D-004)"
  fi
fi

# Keep the pin overlay external, like the identity-scrub quarantine. Exclude the
# mutable source member and add the committed copy under a temporary prefix;
# GNU tar transforms the prefix back to ./package-lock.json in the stream. The
# prefix matters: an exclude for ./package-lock.json must not also suppress the
# replacement member.
SOURCE_PACKAGE_LOCK_PIN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/papercusp-source-package-lock-overlay-XXXXXX")"
mkdir -p "$SOURCE_PACKAGE_LOCK_PIN_DIR/PINNED"
SOURCE_PACKAGE_LOCK_PIN_COPY="$SOURCE_PACKAGE_LOCK_PIN_DIR/PINNED/package-lock.json"
cp -p "$SOURCE_PACKAGE_LOCK_PIN" "$SOURCE_PACKAGE_LOCK_PIN_COPY"
declare -a PACKAGE_LOCK_EXCLUDES=(--exclude='./package-lock.json')
declare -a PACKAGE_LOCK_TRANSFORM=(--transform='s|^\./PINNED/|./|')
declare -a PACKAGE_LOCK_TAIL=(-C "$SOURCE_PACKAGE_LOCK_PIN_DIR" ./PINNED/package-lock.json)
echo "    committed package-lock pin: overlaying Git HEAD copy into source.tar.zst"

zstd_level="${PAPERCUSP_SOURCE_ZSTD_LEVEL:-6}"
command -v zstd >/dev/null 2>&1 || { echo "ERROR: zstd not on PATH (macOS: brew install zstd)" >&2; exit 1; }
# The shared tree is edited by the whole fleet WHILE this multi-minute tar
# runs; GNU tar exits 1 for "file changed as we read it" — a warning (the
# entry is still written), not corruption. Under set -e/pipefail that exit 1
# would kill a ~25-min VM build at the pack step, so tolerate exactly exit 1
# (the changed-file warnings stay visible on stderr); exit ≥2 and any zstd
# failure remain fatal.
set +e +o pipefail
# The scrub overlay (D-004): SCRUB_EXCLUDES drop the leaking originals from the
# MONO pass; a second `-C "$SCRUB_DIR"` adds the redacted copies, whose ./SCRUBBED/
# prefix the SCRUB_TRANSFORM rewrites back to the real path (and which the leaker
# excludes — anchored on ./<relpath> — do NOT match, so the redacted copy survives
# while the original is dropped). One archive, one EOF; empty arrays no-op when
# PAPERCUSP_STAGE_SCRUB=0 or nothing leaked.
declare -a _scrub_tail=()
[[ -n "$SCRUB_DIR" ]] && _scrub_tail=(-C "$SCRUB_DIR" "${SCRUB_MEMBERS[@]}")
declare -a UUID_SOURCE_TAR_ARGS=()
if [[ -n "${PAPERCUSP_SEED_UUID_CENSUS_PATH:-}${PAPERCUSP_SEED_UUID_CENSUS_SHA256:-}" ]]; then
  # Each selected regular-file plaintext must be independently visible to the
  # census; preserve symbolic links but materialize GNU tar hard-link payloads.
  UUID_SOURCE_TAR_ARGS=(--hard-dereference)
fi
"$TAR_BIN" --numeric-owner --owner=0 --group=0 \
  "${UUID_SOURCE_TAR_ARGS[@]}" \
  "${EXCLUDES[@]}" "${SCRUB_EXCLUDES[@]}" "${PACKAGE_LOCK_EXCLUDES[@]}" \
  "${SCRUB_TRANSFORM[@]}" "${PACKAGE_LOCK_TRANSFORM[@]}" \
  -C "$MONO" -cf - "${INCLUDES[@]}" \
  "${_scrub_tail[@]}" \
  "${PACKAGE_LOCK_TAIL[@]}" \
  | zstd -T0 "-${zstd_level}" --long=27 -q -f -o "$OUT_TMP"
rcs=("${PIPESTATUS[@]}")
set -e -o pipefail
(( rcs[0] <= 1 )) || { echo "ERROR: tar failed (exit ${rcs[0]})" >&2; exit 1; }
(( rcs[1] == 0 )) || { echo "ERROR: zstd failed (exit ${rcs[1]})" >&2; exit 1; }

sz="$(du -h "$OUT_TMP" | cut -f1)"
echo "    ✓ source.tar.zst staged (${sz} compressed, zstd -${zstd_level} --long=27)"
echo "      → first boot extracts it to a writable dir; PAPERCUSP_INTEGRATION_ROOT points at it (WI-3308)"

# ── COMMITTED-LOCK GUARD. Compare the archive member, not the source tree we
# intended to read. This catches a future tar/exclude/overlay regression and
# remains meaningful even when npm has legitimately rewritten MONO/package-lock.
# A missing member or a decompression/tar failure is also fatal: a source tree
# without its committed lockfile cannot be repaired on an installed machine.
SOURCE_PACKAGE_LOCK_ARCHIVE_TMP="$(mktemp "${TMPDIR:-/tmp}/papercusp-source-package-lock-archive.XXXXXX")"
set +e
zstd -dc "$OUT_TMP" | "$TAR_BIN" -xOf - ./package-lock.json > "$SOURCE_PACKAGE_LOCK_ARCHIVE_TMP"
_lock_rcs=("${PIPESTATUS[@]}")
set -e
(( _lock_rcs[0] == 0 && _lock_rcs[1] == 0 )) \
  || { echo "ERROR: could not extract ./package-lock.json from staged source.tar.zst — refusing to publish" >&2; exit 1; }
if ! cmp -s "$SOURCE_PACKAGE_LOCK_PIN_COPY" "$SOURCE_PACKAGE_LOCK_ARCHIVE_TMP"; then
  echo "ERROR: staged source.tar.zst ./package-lock.json differs from the committed Git pin — refusing to publish" >&2
  echo "  committed pin bytes: $(wc -c < "$SOURCE_PACKAGE_LOCK_PIN_COPY")" >&2
  echo "  archive member bytes: $(wc -c < "$SOURCE_PACKAGE_LOCK_ARCHIVE_TMP")" >&2
  exit 1
fi
echo "    ✓ source.tar.zst ./package-lock.json matches committed Git pin"

# D166 extends the audit-owned COPY path after exact selection, normal privacy
# and the committed lock pin. Freeze that produced archive outside every ship
# root, then replace it with a mechanically projected archive. Canonical and
# frozen source files are never rewritten or silently excluded.
. "$HERE/lib/seed-reuse-age.sh"
seed_uuid_project_source_archive "$HERE/lib/print-gitleaks-findings.py" "$OUT_TMP" "$SIDECAR" || exit 1
OUT_TMP="$SEED_UUID_SOURCE_ARCHIVE_PATH"

# ── THE GATE (WI-4419). Audit what we ACTUALLY produced, not what we meant to.
# Wired HERE, in the producer, rather than in each of the three callers
# (release-local.sh / mac-vm-build.sh / build-windows-on-vm.sh) — a gate that
# each platform has to remember to call is a gate that one platform forgets, and
# the leak's CONTENTS vary by build host (the mac Server bundle carried the same
# structural hole with zero transcripts, purely because that box had none). The
# allowlist decides what we MEAN to ship; this decides what we DID.
#
# Fatal by design. If this fires, fix the allowlist above — do not add an
# exception to make the build pass.
# Exit 2 (COULD NOT CHECK) is reported separately from exit 1 (FOUND LEAKS). Both are
# fatal — the difference is what you go and fix (EI-20583328178472869).
set +e
python3 "$HERE/audit-release-bundle.py" "$OUT_TMP"
_audit_rc=$?
set -e
if [[ $_audit_rc -eq 2 ]]; then
  echo "" >&2
  echo "ERROR: release bundle audit COULD NOT CHECK — it did NOT find a leak (WI-4419)." >&2
  echo "  Inspect the audit's preceding coverage error (missing tool, unreadable archive," >&2
  echo "  or empty/missing scan target), fix that condition, and re-run." >&2
  exit 2
elif [[ $_audit_rc -ne 0 ]]; then
  echo "" >&2
  echo "ERROR: release bundle audit FAILED — refusing to package (WI-4419)." >&2
  exit 1
fi
mv -f "$OUT_TMP" "$OUT"
OUT_TMP=""
exit 0

}  # ── end self-read guard (WI-3306) — opened after 'set -euo pipefail' above ──
