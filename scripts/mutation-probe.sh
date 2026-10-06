#!/usr/bin/env bash
#
# mutation-probe.sh — prove a guard test is FALSIFIABLE without leaving the
# shared tree mutated.
#
# WHY THIS EXISTS (EI-19450431506682666, measured 2026-08-03)
# ----------------------------------------------------------
# The obvious hand-rolled idiom is:
#
#     cp "$F" "$B"; <mutate>; <run the suite>; cp "$B" "$F"
#
# It fails on this repo in TWO independent ways, and the second one is not
# fixable by being careful:
#
#   1. DEATH RACE — the restore is the LAST statement, so anything that kills
#      the command partway (the 2-min foreground Bash deadline, a SIGTERM, an
#      agent compaction) skips it and strands the mutant in the tree.
#      A `trap` fixes this one.
#
#   2. SWEEP RACE — git-sync commits the WHOLE working tree every few minutes.
#      A probe legitimately holds the file mutated for as long as the suite
#      runs, so a sweep landing in that window commits the mutant even though
#      nothing went wrong and the trap never fired. A trap CANNOT fix this;
#      it is a mitigation, not a fix.
#
# Both fired for real: db6d7b02b1 committed a mutant of
# scripts/verify-tauri-headless.sh in which the fix's function was DEFINED but
# never CALLED — inert, `bash -n`-clean, and shaped exactly like a finished
# change. Had green-checkpoint cut a candidate from it, the recurrence guard
# written minutes earlier would have red-pinned the whole fleet on a mutation
# nobody meant to commit.
#
# THE FIX: don't mutate the tracked file at all. COPY-OUT mode (the default)
# mutates a copy under a scratch dir and points the test at that copy, so the
# tracked file is never dirty for even an instant — no window, no lock, no
# trap needed. The script then PROVES the tree was untouched before exiting.
#
# See CLAUDE.md § "Proving a guard is falsifiable" for when each tier applies.
#
# USAGE
#   scripts/mutation-probe.sh --file <tracked-path> \
#                             --mutate <perl -pe expression> \
#                             --test <command containing {}> \
#                             [--expect caught|survived] [--in-tree]
#                             [--sweep-lock-held | --accept-sweep-race]
#                             [--fake-destructive]
#                             [--i-know-this-deletes --sandbox-root <dir>]
#                             [--relocation auto|overlay|mirror]
#
# COPY-OUT RELOCATION (--relocation, default auto). How the mutant is shown to
# the guard without touching the tracked file:
#   overlay  each post-baseline guard run executes in a private mount namespace
#            (bwrap) with the mutant bind-mounted over the subject's OWN path, so
#            every route to it — direct, sibling module, alias, package
#            specifier — reaches the mutant. Nothing outside the namespace (the
#            tree, git-sync, peers) ever sees it. Needs bwrap + user namespaces.
#   mirror   the mutant is written into a symlink mirror of the worktree (flat
#            scratch copy outside a worktree). A test that reaches the subject
#            through a SIBLING module can load the ORIGINAL and false-SURVIVE
#            (EI-24799401310241778); kept for hosts where overlay is unavailable.
#   auto     overlay when bwrap can bind here, else mirror (logged).
# Every verdict line names the one used: relocation=overlay|mirror|flat.
#
# HISTORICAL MODE — prove a guard catches the version that actually preceded a
# fix, without guessing that HEAD is still pre-fix (git-sync commits the tree
# continuously):
#   scripts/mutation-probe.sh --file <tracked-path> \
#                             --against-commit <sha> \
#                             --must-be-absent <literal> \
#                             --positive-control <literal> \
#                             --calibration <command containing {}> \
#                             --test <command containing {}> \
#                             [--subject-must-behave <command containing {}>]
#   scripts/mutation-probe.sh --file <tracked-path> \
#                             --against-last-without <literal> \
#                             --positive-control <literal> \
#                             --calibration <command containing {}> \
#                             --test <command containing {}> \
#                             [--subject-must-behave <command containing {}>]
#
# Historical mode freezes both the current working-tree bytes and the selected
# commit's bytes before either command runs. `{}` is replaced with a fresh
# per-run copy of the appropriate frozen snapshot. Every positive control must
# be present in BOTH snapshots; calibration must pass against BOTH; the guard
# test must pass against current and then produce the requested historical
# verdict. `--against-commit` requires `--must-be-absent`; the content-selected
# form uses its selector as that absence control automatically.
#
# ⚠ LOCATION-DEPENDENT SUBJECTS (EI-21902332137059032, HIT LIVE 2026-08-30
#   probing apps/operator/scripts/hooks/cc/pretooluse-bash-resource-gate.sh,
#   EI-18139694363457325) — historical mode NEVER runs --test against the
#   literal in-tree --file path; every phase relocates a frozen snapshot to a
#   scratch directory first. A subject that resolves anything relative to its
#   OWN location ($0-relative sibling files, a sibling config/lib directory)
#   is a DIFFERENT PROGRAM once relocated there. That is dangerous specifically
#   when the subject fails OPEN rather than crashing (an admission/deny path
#   that silently no-ops when a sibling is missing): the relocated copy of the
#   CURRENT (fixed) source can then score identically to a genuinely-broken
#   historical source, turning a location artifact into a false `survived`
#   verdict — "your guard is weaker than you think" is exactly the wrong
#   conclusion to draw, and the natural next move is to weaken a guard that
#   was correct all along. --calibration does NOT protect you from this: it is
#   documented as validating the instrument/token's PRESENCE in the frozen
#   bytes, not that the subject BEHAVES once relocated, so the textbook
#   `grep -q <literal> {}` calibration this header itself models passes
#   happily on a snapshot whose runtime behaviour is entirely dead.
#
#   --subject-must-behave <command containing {}>
#       Optional smoke assertion, historical mode only. Runs the command once
#       with {} = the literal in-tree --file path, and once with {} = a
#       relocated copy of the frozen CURRENT snapshot; if the two exit codes
#       differ, refuses (harness-error) before running calibration or scoring
#       the historical source, naming the mismatch as evidence of relocation-
#       dependence rather than a real fixed-vs-broken distinction. Pass a
#       command that actually exercises the subject's behaviour (e.g. invoke
#       the hook against a known input and check its verdict) — not a bytes-
#       level `grep`, which cannot observe this class of failure by design.
#       Omitting this flag costs nothing (zero extra guard invocations, and it
#       is disabled by default so it can never change an existing caller's
#       verdict) — but for a subject you know or suspect resolves sibling
#       paths, pass it; it is the built-in version of the self-checking
#       oracle this incident's reporter had to hand-roll to avoid the false
#       verdict above.
#
# ⛔ DESTRUCTIVE SUBJECTS (EI-20566003853444873 — the 2026-08-15 incident)
#   This script's original blast-radius model protected THE FILE UNDER TEST and
#   nothing else. Executing a mutant of code that DELETES means running
#   deliberately-corrupted deletion logic against the real filesystem with your
#   full privileges: one probe of a reaper script did exactly that and destroyed
#   ~370GB (~/windows-vm, ~/Downloads, ~/backups, most of papercupai-workspace).
#   So COPY-OUT and IN-TREE MUTATION modes now REFUSE by default when the
#   subject file or the --test command contains destructive primitives
#   (rm/rmdir/unlink/shred/mkfs/dd of=/truncate/find -delete). Two ways
#   forward, in order of preference:
#
#   Historical mode is different: it executes an UNMUTATED source snapshot,
#   not a deliberately-corrupted mutant. The same scan is therefore a
#   warning there, so a real historical falsifiability comparison is not
#   made unusable merely because the subject cleans up its own scratch file.
#   If a historical guard actually executes deletion logic, callers can still
#   opt into --fake-destructive or --i-know-this-deletes --sandbox-root.
#
#   --fake-destructive       TIER-0, use this one. Prepends shim executables
#                            (rm, rmdir, unlink, shred, truncate, mkfs, dd) to
#                            PATH for both guard runs; each shim LOGS its argv to
#                            $SCRATCH/destructive-calls.log and deletes nothing.
#                            Assert on what the code WOULD delete instead of
#                            letting it delete. Limit: PATH-level interception
#                            only — a subject calling /bin/rm by absolute path
#                            bypasses the shims (use the sandbox for those).
#
#   --i-know-this-deletes    Explicit opt-in to REAL execution, and it ALSO
#     --sandbox-root <dir>   requires --sandbox-root: both guard runs are then
#                            wrapped in bwrap with / mounted READ-ONLY and only
#                            <dir> + the probe scratch dir writable, so a mutant
#                            that widens its delete target hits a wall instead
#                            of the filesystem. Refused if bwrap cannot sandbox
#                            on this host.
#
#   Either flag may also be passed proactively for a subject the heuristic does
#   not flag — they only ever ADD protection.
#
#   {} in --test is replaced by the path the guard must read: the subject's own
#   path under --in-tree and under the copy-out OVERLAY (where the mutant is
#   visible there), or the MUTATED COPY's scratch path under the mirror, so the
#   same --test string works in every mode.
#
#   {} is REQUIRED in copy-out mode (without it the test would run against the
#   untouched original and every mutant would falsely "survive") and OPTIONAL
#   under --in-tree, where the tracked file itself is the mutant and the
#   substitution is a no-op.
#
#   --in-tree REFUSES to run until the sweep is fenced:
#       --sweep-lock-held    you hold a file lock for each mutated path with
#                            intent 'mutation probe'; the script verifies that
#                            this session owns it and extends its lease
#       --accept-sweep-race  you consciously accept the race (an unswept
#                            checkout, or a run short enough that you judged it)
#   The file lock is the whole fence, in every repository: git-sync re-reads the
#   lock census AFTER staging and unstages late-locked or drifted paths before each
#   commit (EI-24712906810240170), so no fleet-wide git-sync lease is needed
#   (MUTATION_PROBE_REQUIRE_GIT_SYNC_LEASE=1 restores that old second fence). Evidence binders refuse paths carrying the
#   active 'mutation probe' file-lock intent. A bare acknowledgement never opens
#   the gate; the verified lock state is echoed into MUTATION_PROBE_RESULT.
#
#   --mutate is a PERL expression, so on the PATTERN side ( ) { } + ? . * are
#   REGEX METACHARACTERS. Escape them to match source code literally:
#       's|if \(x > 0\) \{|if (false) {|'   not   's|if (x > 0) {|if (false) {|'
#   The unescaped form matches NOTHING and is refused as a no-op mutation (see
#   EXIT CODE 2) — the refusal repeats this note, so you cannot silently probe
#   a guard with a mutation that never applied.
#
# EXAMPLE (the real probe this script was extracted from) — VERIFIED RUNNABLE, and
# pinned that way by doc-claims/mutation-probe-example-is-runnable.test.ts, because
# all three of the things that make it work are easy to get silently wrong (WI-39608):
#   • the --test target must READ PROBE_SCRIPT, or {} points nowhere and the probe
#     measures the UNMUTATED tracked file and reports a false "mutant SURVIVED";
#   • the --mutate pattern must still MATCH the subject — this example's original
#     pattern stopped matching when the call site became `if <fn>; then ...; fi`;
#   • the subject trips the destructive-primitive gate (it contains rm/unlink), so
#     --fake-destructive is required to run it at all.
#   scripts/mutation-probe.sh \
#     --file scripts/verify-tauri-headless.sh \
#     --fake-destructive \
#     --mutate 's/^\s*if port_lost_to_squatter; then PORT_LOST=1; break; fi$//' \
#     --test 'PROBE_SCRIPT={} npm run test:file -- apps/operator/lib/verify-tauri-headless-bind-retry.test.ts'
#
# EXIT CODES
#   0  the probe reached its expected verdict (default: the mutant was CAUGHT)
#   1  the probe reached the opposite verdict — your guard is weaker than you think
#   2  misuse / the probe could not be run soundly (e.g. a no-op or
#      whitespace-only mutation, a mutant that no longer PARSES, a guard run
#      whose own output shows a known runner-MISUSE marker — e.g. "no test
#      files found" — or a recognized test runner exits 1 without assertion-
#      failure evidence, a BASELINE that exits 0
#      having selected ZERO tests (a --test name filter that matches nothing:
#      it would otherwise make every mutant "survive"), a failing baseline, a
#      copy-out RELOCATION that breaks the subject before any mutation is
#      applied (the guard fails against an UNMUTATED relocated copy), or a
#      harness error while running the mutant)
#   3  IN-TREE RESTORE FAILED — the tree may still be dirty; act immediately
#
# READING THE VERDICT
#   MUTATION_PROBE_RESULT carries mutant_parse= alongside the verdict, because
#   that line is what gets quoted as evidence. 'ok' means the mutant was
#   confirmed to still be a loadable program, so a caught verdict is about the
#   ASSERTIONS. 'unchecked*' means no syntax checker applied to this subject
#   (unsupported extension, or the interpreter was absent), so a caught verdict
#   has not ruled out a mutant that merely fails to load. A mutant that is
#   confirmed unparseable never reaches a verdict at all — it exits 2 as misuse.
#
#   Two habits this cannot enforce for you: read WHICH tests failed rather than
#   the verdict line alone (a genuine semantic mutant fails a PROPER SUBSET of
#   the suite; a mutant that cannot load fails everything), and run BOTH
#   directions of a conditional guard — forcing a branch always-on and
#   always-off measure different halves of it, and either alone leaves the
#   other half unproven.
#
# The guard command runs twice: once against the original file with
# PAPERCUSP_MUTATION_PHASE=baseline, then against the mutant with
# PAPERCUSP_MUTATION_PHASE=mutant. PAPERCUSP_MUTATION_PROBE marks both child
# runs so the shared test-runs reporter can keep deliberate probe outcomes out
# of the health ledger. A baseline failure is a harness error, not a caught
# mutant. For a recognized test runner, exit 1 is caught only when its output
# includes assertion-level failure evidence; a setup-hook failure can exit 1
# while every assertion is skipped. Plain non-test guards (for example grep)
# retain the exit-1 convention. Cargo/libtest exit 101 is caught only with
# executed, named test failures and a matching failed summary. Compilation,
# setup and empty selection are never caught. Other exits are harness errors.
#
# Bash reads a script incrementally. A peer edit while a long baseline guard is
# running can shift the reader's offset and turn a later diagnostic string into
# a shell fragment (EI-24365912571955838). Execute a validated, private copy;
# the caller's file may then change without changing this run's program.
if [ "${MUTATION_PROBE_FROZEN_SOURCE:-}" != "$0" ]; then
  frozen_source="$(mktemp "${TMPDIR:-/tmp}/mutation-probe-source.XXXXXX")" || exit 2
  original_source="$(realpath -e "$0")" || exit 2
  trap 'rm -f -- "$frozen_source"' EXIT
  cp -- "$0" "$frozen_source" || exit 2
  bash -n "$frozen_source" || exit 2
  export MUTATION_PROBE_FROZEN_SOURCE="$frozen_source"
  export MUTATION_PROBE_SOURCE_PATH="$original_source"
  exec bash "$frozen_source" "$@"
fi
trap 'rm -f -- "$MUTATION_PROBE_FROZEN_SOURCE"' EXIT

set -uo pipefail

readonly PROG="mutation-probe"

die() { printf '%s: %s\n' "$PROG" "$*" >&2; exit 2; }
log() { printf '[%s] %s\n' "$PROG" "$*" >&2; }

FILE=""
MUTATE=""
TEST_CMD=""
EXPECT="caught"
IN_TREE=0
SWEEP_ACK=""
AGAINST_COMMIT=""
AGAINST_LAST_WITHOUT=""
MUST_BE_ABSENT=""
CALIBRATION_CMD=""
POSITIVE_CONTROLS=()
SUBJECT_MUST_BEHAVE=""
HISTORICAL_MODE=0
DELETES_ACK=0
FAKE_DESTRUCTIVE=0
SANDBOX_ROOT=""
# Copy-out relocation strategy (EI-24799401310241778): auto = overlay when bwrap
# can bind on this host, else the repo mirror; overlay/mirror force one.
RELOCATION="auto"
RELOCATION_USED=""
OVERLAY_DEST=""
FAKE_BIN=""
DESTRUCTIVE_LOG=""

# The file lock that protects this probe's tracked subject. Resolved from the
# subject's repo root rather than hardcoded, so a submodule or scratch checkout
# gets the path git-sync will exclude in that repo's coordinate space.
sweep_lock_path() {
  local root
  root="$(sweep_lock_repo_root)"
  if [ -n "$root" ]; then
    case "$FILE" in
      "$root"/*) printf '%s' "${FILE#"$root"/}"; return 0 ;;
    esac
  fi
  printf '<repo-relative-mutated-file>'
}

sweep_lock_repo_root() {
  git -C "$(dirname "$FILE")" rev-parse --show-toplevel 2>/dev/null || true
}

mutation_probe_local_green_operator() {
  node - <<'NODE'
const { readFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');
const env = process.env;
function validPort(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d+$/.test(value)) return null;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? value : null;
}

let base = '';
let resolved = false;
const configuredBase = typeof env.PAPERCUSP_OPERATOR_BASE === 'string'
  ? env.PAPERCUSP_OPERATOR_BASE.trim()
  : '';
if (configuredBase) {
  base = configuredBase;
  resolved = true;
}
if (!resolved) {
  const selfPort = validPort(env.PAPERCUSP_HONO_PORT);
  if (selfPort) {
    const targetPort = validPort(env.PAPERCUSP_MCP_PROXY_TARGET_PORT ?? '3070') ?? '3070';
    const proxyBase = typeof env.PAPERCUSP_MCP_PROXY_BASE === 'string'
      ? env.PAPERCUSP_MCP_PROXY_BASE.trim()
      : '';
    base = proxyBase && selfPort === targetPort
      ? proxyBase
      : 'http://127.0.0.1:' + selfPort;
    resolved = true;
  } else if (Object.prototype.hasOwnProperty.call(env, 'PAPERCUSP_OPERATOR_URL')) {
    base = env.PAPERCUSP_OPERATOR_URL ?? '';
    resolved = true;
  }
}
if (!resolved) {
  try {
    const discovery = JSON.parse(readFileSync(join(homedir(), '.papercusp', 'operator.json'), 'utf8'));
    if (typeof discovery?.httpUrl === 'string' && discovery.httpUrl) base = discovery.httpUrl;
    else if (discovery?.port) base = 'http://127.0.0.1:' + discovery.port;
  } catch {
    // A missing operator.json is the ptool dev-box default.
  }
  if (!base) base = 'http://127.0.0.1:3070';
}

try {
  const endpoint = new URL(base);
  const local = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(endpoint.hostname);
  const port = endpoint.port || (endpoint.protocol === 'https:' ? '443' : '80');
  process.exit(local && ['3070', '9071'].includes(port) ? 0 : 1);
} catch {
  process.exit(1);
}
NODE
}

mutation_probe_ptool_timeout() {
  local detail
  detail="$(tr '\n' ' ' < "$1" 2>/dev/null)"
  printf '%s' "$detail" | grep -Eiq -- '(-32001.*timed out|timed out.*-32001|ETIMEDOUT)'
}

# ptool's -32001 formatter says a connected call may already have executed.
# Retry only these reads and the same-lock heartbeat extensions: each heartbeat
# extends the existing lock identified below, then the existing ownership check
# verifies the returned lock id. Do not add arbitrary writes to this allowlist.
mutation_probe_fallback_safe_tool() {
  case "$1" in
    coord:presence|locks:queue|locks:list|locks:heartbeat|locks:heartbeat_resource) return 0 ;;
    *) return 1 ;;
  esac
}

mutation_probe_ptool() {
  local token_file="${PAPERCUSP_MCP_TOKEN_FILE:-}"
  # A managed workspace may set PAPERCUSP_HOME to a workspace-local token
  # rejected by the selected operator. Match mcp-call's shared host credential
  # unless the caller supplied an explicit session token file.
  if [ -z "$token_file" ] && [ -n "${HOME:-}" ] && [ -r "$HOME/.papercusp/superuser-token" ]; then
    token_file="$HOME/.papercusp/superuser-token"
  fi
  if [ -n "$token_file" ]; then
    PAPERCUSP_MCP_TOKEN_FILE="$token_file" ptool "$@"
  else
    ptool "$@"
  fi
}

ptool_json() {
  # Surface the tool's own stderr on failure (WI-10002758). Discarding it
  # turned a crisp dispatch refusal (e.g. projection_invalid) into the opaque
  # "could not ..." the caller prints, which hid a probe that could never run.
  local tool="$1" args="$2" projection="$3" result err_file rc
  local fallback_err_file fallback_result fallback_rc temp_dir
  local workspace_scope="${PAPERCUSP_WORKSPACE_ID:-${PAPERCUSP_WORKSPACE:-}}"
  local harness_scope="${PAPERCUSP_TEST_RUN_HARNESS:-${HARNESS_SLUG:-${PAPERCUSP_HARNESS_SLUG:-}}}"
  local -a ptool_scope=()
  command -v ptool >/dev/null 2>&1 || { log "ptool $tool: ptool is not on PATH"; return 1; }
  [ -n "$workspace_scope" ] || { log "ptool $tool requires an explicit Papercusp workspace scope; set PAPERCUSP_WORKSPACE_ID or PAPERCUSP_WORKSPACE"; return 1; }
  [ -n "$harness_scope" ] || { log "ptool $tool requires an explicit Papercusp harness scope; set PAPERCUSP_TEST_RUN_HARNESS or HARNESS_SLUG"; return 1; }
  ptool_scope=(--workspace="$workspace_scope" --harness="$harness_scope")
  err_file="$(mktemp "${TMPDIR:-/tmp}/mutation-probe-ptool.XXXXXX")" || return 1
  result="$(printf '%s' "$args" | mutation_probe_ptool "${ptool_scope[@]}" "$tool" --json - --projection "$projection" 2>"$err_file")"
  rc=$?
  if [ "$rc" -ne 0 ] &&
    mutation_probe_fallback_safe_tool "$tool" &&
    mutation_probe_local_green_operator &&
    mutation_probe_ptool_timeout "$err_file"; then
    # WI-10004679: `set -u` is on, so a bare "$TMPDIR" aborts this fallback when
    # TMPDIR is unset and the probe dies at its identity check instead of retrying.
    temp_dir="${TMPDIR:-/tmp}"
    fallback_err_file="$(mktemp "$temp_dir/mutation-probe-ptool-fallback.XXXXXX")" || fallback_err_file=""
    if [ -n "$fallback_err_file" ]; then
      fallback_result="$(printf '%s' "$args" | mutation_probe_ptool "${ptool_scope[@]}" "$tool" --url=http://127.0.0.1:3170 --json - --projection "$projection" 2>"$fallback_err_file")"
      fallback_rc=$?
      if [ "$fallback_rc" -eq 0 ] && [ -n "$fallback_result" ]; then
        log "ptool $tool timed out on local :3070/:9071; recovered once through staging :3170"
        rm -f "$err_file" "$fallback_err_file"
        printf '%s' "$fallback_result"
        return 0
      fi
      log "ptool $tool staging :3170 fallback failed (exit $fallback_rc): $(tail -c 600 "$fallback_err_file" | tr '\n' ' '); primary timeout: $(tail -c 600 "$err_file" | tr '\n' ' ')"
      rm -f "$fallback_err_file"
    fi
  fi
  if [ "$rc" -ne 0 ] || [ -z "$result" ]; then
    log "ptool $tool failed (exit $rc): $(tail -c 600 "$err_file" | tr '\n' ' ')"
    rm -f "$err_file"
    return 1
  fi
  rm -f "$err_file"
  printf '%s' "$result"
}

verify_sweep_fence() {
  local lock_root lock_path queue_args presence_json owner_id queue_json file_lock_id heartbeat_args heartbeat_json heartbeat_excerpt
  local superproject_root harness_scope resource lock_list_args lock_list_json minimum_resource_ms
  [ -n "${PAPERCUSP_SID:-}" ] || die "--sweep-lock-held requires the active Papercusp session id (PAPERCUSP_SID); use copy-out mode instead."
  [ "$GUARD_MAX_SEC" -gt 0 ] && [ "$GUARD_MAX_SEC" -le 600 ] \
    || die "--sweep-lock-held requires MUTATION_PROBE_WINDOW_MAX_SEC between 1 and 600 so the verified 1200s file-lock lease outlives the dirty window."
  lock_root="$(sweep_lock_repo_root)"
  lock_path="$(sweep_lock_path)"
  [ -n "$lock_root" ] && [ "$lock_path" != '<repo-relative-mutated-file>' ] \
    || die "could not resolve the mutated file's repository-relative lock path; use copy-out mode."

  presence_json="$(ptool_json coord:presence '{"owner":"self"}' '{"pick":["self.ownerId"]}')" \
    || die "could not read this session's Papercusp owner identity; refusing an unverified in-tree mutation."
  owner_id="$(printf '%s' "$presence_json" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const id=JSON.parse(s).self?.ownerId;if(typeof id!=="string"||!id)process.exit(2);process.stdout.write(id)}catch{process.exit(2)}})')" \
    || die "could not resolve this session's Papercusp owner identity; refusing an unverified in-tree mutation."

  queue_args="$(node -e 'process.stdout.write(JSON.stringify({paths:[process.argv[1]],coordination_domain:process.argv[2]}))' "$lock_path" "$lock_root")" \
    || die "could not build the file-lock query; refusing an unverified in-tree mutation."
  queue_json="$(ptool_json locks:queue "$queue_args" '{"pick":["active_locks[].path","active_locks[].owner","active_locks[].intent","active_locks[].lock_id"]}')" \
    || die "could not read the live file-lock queue; refusing an unverified in-tree mutation."
  file_lock_id="$(printf '%s' "$queue_json" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const a=JSON.parse(s).active_locks||[];const r=a.find(x=>x.path===process.argv[1]&&x.owner===process.argv[2]&&String(x.intent||"").trim().toLowerCase()==="mutation probe");if(!r||typeof r.lock_id!=="string")process.exit(1);process.stdout.write(r.lock_id)}catch{process.exit(2)}})' "$lock_path" "$owner_id")" \
    || die "no live file lock for '$lock_path' is held by this session with intent 'mutation probe'; acquire that exact lock before retrying."
  heartbeat_args="$(node -e 'process.stdout.write(JSON.stringify({lock_id:process.argv[1],ttl_sec:1200,coordination_domain:process.argv[2]}))' "$file_lock_id" "$lock_root")" \
    || die "could not build the file-lock heartbeat; refusing an unverified in-tree mutation."
  # A real pick: dispatch refuses an empty projection ('{}') as projection_invalid.
  heartbeat_json="$(ptool_json locks:heartbeat "$heartbeat_args" '{"pick":["results[].lock_id","results[].extended"]}')" \
    || die "could not extend the verified file lock; refusing an unverified in-tree mutation."
  if ! printf '%s' "$heartbeat_json" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const id=process.argv[1];const walk=v=>{if(!v)return false;if(typeof v==="string"){try{return walk(JSON.parse(v))}catch{return false}}if(Array.isArray(v))return v.some(walk);if(typeof v==="object"){if(v.lock_id===id&&v.extended===true)return true;return Object.values(v).some(walk)}return false};if(!walk(JSON.parse(s)))process.exit(1)}catch{process.exit(2)}})' "$file_lock_id"; then
    heartbeat_excerpt="$(printf '%s' "$heartbeat_json" | node -e 'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(s.replace(/\s+/g," ").slice(0,400)))')"
    log "file-lock heartbeat response did not confirm ownership (first 400 chars): $heartbeat_excerpt"
    die "the file-lock heartbeat did not confirm ownership; refusing an unverified in-tree mutation."
  fi
  log "verified this session's live file lock for $lock_path"

  # EI-24712906810240170: the file lock IS the whole sweep fence, in every repository.
  # EI-24386061509279889 once let a mutant through a live file lock: git-sync read its
  # lock census before `git add`, so a lock taken (or a probe restored and released)
  # between that read and the commit was invisible. That was mitigated by also
  # requiring the fleet-wide exclusive git-sync:<harness> lease, which froze every
  # agent's commits for the whole probe. git-sync now re-reads the census AFTER staging
  # and unstages any late-locked or drifted path before each commit
  # (guardStagedIndexBeforeCommit in run-git-sync.ts, superproject and submodules), so
  # the lease is no longer required. The lock must be held BEFORE the mutation and
  # released only AFTER the restore, which is exactly the order this script enforces.
  # Opt back into the old double fence with MUTATION_PROBE_REQUIRE_GIT_SYNC_LEASE=1.
  [ "${MUTATION_PROBE_REQUIRE_GIT_SYNC_LEASE:-0}" = "1" ] || return 0
  {
    harness_scope="${PAPERCUSP_TEST_RUN_HARNESS:-${HARNESS_SLUG:-${PAPERCUSP_HARNESS_SLUG:-}}}"
    [ -n "$harness_scope" ] || die "an in-tree probe requires a harness slug to verify the git-sync resource lock; use copy-out mode or set PAPERCUSP_TEST_RUN_HARNESS."
    resource="git-sync:$harness_scope"
    lock_list_args="$(node -e 'process.stdout.write(JSON.stringify({resource:process.argv[1]}))' "$resource")" \
      || die "could not build the named-resource lock query; refusing an in-tree mutation."
    lock_list_json="$(ptool_json locks:list "$lock_list_args" '{"pick":["holders[].resource","holders[].owner","holders[].mode","holders[].status","holders[].expires_ts"]}')" \
      || die "could not read the named-resource lock list; refusing an in-tree mutation."
    minimum_resource_sec=$(( GUARD_MAX_SEC + 120 ))
    minimum_resource_ms=$(( minimum_resource_sec * 1000 ))
    # WI-10004155: separate "not held" (exit 1) from "held, but the lease ends
    # before the mutation window plus its 120s margin" (exit 3, prints the seconds
    # left). One refusal message for both read as operator error on a lease that
    # WAS held, just too short for the configured window.
    resource_left_sec="$(printf '%s' "$lock_list_json" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const owner=process.argv[1],resource=process.argv[2],minimum=Number(process.argv[3]);const held=(JSON.parse(s).holders||[]).filter(x=>x.resource===resource&&x.owner===owner&&x.mode==="exclusive"&&x.status==="held");if(!held.length)process.exit(1);const until=Math.max(...held.map(x=>Date.parse(x.expires_ts)));if(!Number.isFinite(until))process.exit(2);const left=until-Date.now();process.stdout.write(String(Math.max(0,Math.floor(left/1000))));if(left<minimum)process.exit(3)}catch{process.exit(2)}})' "$owner_id" "$resource" "$minimum_resource_ms")"
    case $? in
      0) ;;
      1) die "this session must hold an exclusive '$resource' lock through the mutation window before probing in-tree; none is held by $owner_id. Acquire it first: locks:acquire_resource { resource: '$resource', mode: 'exclusive', ttl_sec: 1200 }." ;;
      3) die "this session's exclusive '$resource' lock is held but expires in ${resource_left_sec}s, and the mutation window needs at least ${minimum_resource_sec}s (MUTATION_PROBE_WINDOW_MAX_SEC=$GUARD_MAX_SEC plus a 120s margin). Extend it with locks:heartbeat_resource { lock_id, ttl_sec: 1200 } (lock_id is returned by locks:acquire_resource), or lower MUTATION_PROBE_WINDOW_MAX_SEC, then retry." ;;
      *) die "could not read this session's '$resource' lease from the named-resource lock list; refusing an in-tree mutation." ;;
    esac
    log "verified this session's exclusive $resource lock through the mutation window (${resource_left_sec}s left; ${minimum_resource_sec}s required)"
  }
}

while [ $# -gt 0 ]; do
  case "$1" in
    --file)    FILE="${2:-}";     shift 2 || die "--file needs a value" ;;
    --mutate)  MUTATE="${2:-}";   shift 2 || die "--mutate needs a value" ;;
    --test)    TEST_CMD="${2:-}"; shift 2 || die "--test needs a value" ;;
    --expect)  EXPECT="${2:-}";   shift 2 || die "--expect needs a value" ;;
    --in-tree) IN_TREE=1; shift ;;
    --sweep-lock-held)   SWEEP_ACK="lock-held";      shift ;;
    --accept-sweep-race) SWEEP_ACK="race-accepted";  shift ;;
    --against-commit)     AGAINST_COMMIT="${2:-}"; shift 2 || die "--against-commit needs a value" ;;
    --against-last-without) AGAINST_LAST_WITHOUT="${2:-}"; shift 2 || die "--against-last-without needs a value" ;;
    --must-be-absent)     MUST_BE_ABSENT="${2:-}"; shift 2 || die "--must-be-absent needs a value" ;;
    --positive-control)   POSITIVE_CONTROLS+=("${2:-}"); shift 2 || die "--positive-control needs a value" ;;
    --calibration)        CALIBRATION_CMD="${2:-}"; shift 2 || die "--calibration needs a value" ;;
    --subject-must-behave) SUBJECT_MUST_BEHAVE="${2:-}"; shift 2 || die "--subject-must-behave needs a value" ;;
    --fake-destructive)    FAKE_DESTRUCTIVE=1; shift ;;
    --i-know-this-deletes) DELETES_ACK=1;      shift ;;
    --sandbox-root) SANDBOX_ROOT="${2:-}"; shift 2 || die "--sandbox-root needs a value" ;;
    --relocation)   RELOCATION="${2:-}";   shift 2 || die "--relocation needs a value" ;;
    # Print the whole header block, bounded by where it actually ends rather
    # than by a hardcoded line number — the previous '2,70p' silently truncated
    # mid-section every time the header grew, which is how --help ends up
    # describing a flag set the script no longer has.
    -h|--help) awk 'NR>1 { if (/^#/) print; else exit }' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$FILE" ]     || die "missing --file"
[ -n "$TEST_CMD" ] || die "missing --test"
[ -f "$FILE" ]     || die "no such file: $FILE"
# Resolve --file to an ABSOLUTE path before anything substitutes it. The two
# runs are not symmetric: the baseline substitutes {} with this original path
# VERBATIM, while the mutant gets an absolute scratch path. So a relative
# --file (the natural thing to type from the repo root) makes only the BASELINE
# cwd-dependent, and any --test that runs from a different directory — a vitest
# workspace, an npm script — fails there and nowhere else. The script then
# correctly refuses to score the mutant, but reports "BASELINE FAILED", which
# reads as "your guard is broken" rather than "your path was relative".
FILE="$(cd "$(dirname "$FILE")" 2>/dev/null && pwd)/$(basename "$FILE")"
[ -f "$FILE" ] || die "could not resolve --file to an absolute path: $FILE"
case "$EXPECT" in caught|survived) ;; *) die "--expect must be 'caught' or 'survived'" ;; esac
case "$RELOCATION" in auto|overlay|mirror) ;; *) die "--relocation must be 'auto', 'overlay' or 'mirror'" ;; esac
if [ "$RELOCATION" != "auto" ] && [ "$IN_TREE" -eq 1 ]; then
  die "--relocation only applies to copy-out mode; --in-tree mutates the tracked file in place and relocates nothing"
fi

if [ -n "$AGAINST_COMMIT" ] || [ -n "$AGAINST_LAST_WITHOUT" ] || [ -n "$MUST_BE_ABSENT" ] || [ -n "$CALIBRATION_CMD" ] || [ "${#POSITIVE_CONTROLS[@]}" -gt 0 ]; then
  HISTORICAL_MODE=1
fi

if [ "$HISTORICAL_MODE" -eq 1 ]; then
  [ -z "$MUTATE" ] || die "--mutate cannot be combined with historical mode; historical mode supplies the before-fix snapshot"
  [ "$IN_TREE" -eq 0 ] || die "historical mode is always copy-out; drop --in-tree"
  [ "$RELOCATION" = "auto" ] || die "--relocation applies to mutation copy-out only; historical mode relocates its frozen snapshots itself"
  [ -z "$SWEEP_ACK" ] || die "--sweep-lock-held / --accept-sweep-race only apply to --in-tree mutation mode"
  [ -n "$AGAINST_COMMIT" ] || [ -n "$AGAINST_LAST_WITHOUT" ] || die "historical mode needs exactly one of --against-commit or --against-last-without"
  [ -z "$AGAINST_COMMIT" ] || [ -z "$AGAINST_LAST_WITHOUT" ] || die "pick exactly one of --against-commit or --against-last-without"
  [ "${#POSITIVE_CONTROLS[@]}" -gt 0 ] || die "historical mode requires at least one --positive-control literal"
  [ -n "$CALIBRATION_CMD" ] || die "historical mode requires --calibration <command containing {}>"
  case "$TEST_CMD" in
    *"{}"*) ;;
    *) die "historical --test must contain {} (the frozen current/historical snapshot path)" ;;
  esac
  case "$CALIBRATION_CMD" in
    *"{}"*) ;;
    *) die "--calibration must contain {} (the frozen current/historical snapshot path)" ;;
  esac
  if [ -n "$SUBJECT_MUST_BEHAVE" ]; then
    case "$SUBJECT_MUST_BEHAVE" in
      *"{}"*) ;;
      *) die "--subject-must-behave must contain {} (the in-tree/relocated path is substituted there)" ;;
    esac
  fi
  if [ -n "$AGAINST_COMMIT" ]; then
    [ -n "$MUST_BE_ABSENT" ] || die "--against-commit requires --must-be-absent <literal> so the selected commit is proven to be the before-fix side"
  else
    [ -z "$MUST_BE_ABSENT" ] || [ "$MUST_BE_ABSENT" = "$AGAINST_LAST_WITHOUT" ] || die "--against-last-without already supplies the absence control; do not pass a different --must-be-absent literal"
    MUST_BE_ABSENT="$AGAINST_LAST_WITHOUT"
  fi
else
  [ -n "$MUTATE" ] || die "missing --mutate"
  [ -z "$AGAINST_COMMIT" ] && [ -z "$AGAINST_LAST_WITHOUT" ] || die "historical selector requires --calibration and --positive-control; use historical mode deliberately"
  [ -z "$SUBJECT_MUST_BEHAVE" ] || die "--subject-must-behave only applies to historical mode (needs --against-commit or --against-last-without); copy-out (mutation) mode already runs an equivalent relocation check automatically (the copy-baseline phase, EI-21884666893062196)."
fi
# The `{}` requirement is MODE-SPECIFIC, and the asymmetry is deliberate — do not "tidy" it
# back into an unconditional check (EI-19455888914364007).
#
# COPY-OUT: load-bearing. `{}` is the ONLY thing pointing the test at the mutated copy, so a
# command without it runs against the untouched original, the mutant always "survives", and the
# probe reports your guard as weak when it is fine. Refuse rather than emit that false verdict.
#
# COPY-OUT UNDER AN EXPLICIT `--relocation overlay`: NOT load-bearing, so not required
# (EI-24818519111680142). The overlay binds the mutant OVER the subject's own path inside a
# private mount namespace, so GUARD_SUBJECT resolves to "$FILE" rather than a scratch copy
# (see the relocation block below) and the substitution is the same no-op it is in-tree. The
# distinction that makes this safe is DOWNGRADE, not visibility: `--relocation auto` silently
# falls back to the repo mirror when bwrap cannot bind on this host, and under mirror/flat `{}`
# is the only thing naming the mutant — so auto KEEPS the requirement. An explicit
# `--relocation overlay` cannot downgrade; it dies instead, so reaching a guard run at all
# proves the mutant is at the subject's own path. Do not widen this to `auto`.
#
# IN-TREE: the tracked file itself IS the mutant, so the substitution is a no-op and a command
# that never names the path is perfectly sound. That is the NORMAL shape here — in-tree mode
# exists precisely for subjects whose path is not overridable (a suite importing it by a fixed
# path), which is the same reason the test cannot accept a `{}` to begin with. Demanding the
# marker anyway forced callers to thread a dummy `PROBE_FILE={}` env var that nothing reads.
if [ "$IN_TREE" -eq 0 ] && [ "$RELOCATION" != "overlay" ]; then
  case "$TEST_CMD" in
    *"{}"*) ;;
    *) die "--test must contain {} (where the mutated COPY's path is substituted) under --relocation ${RELOCATION} — auto can fall back to the repo mirror, where {} is the only thing naming the mutant. If your test cannot take a path — e.g. it imports its subject by a fixed path — pass --relocation overlay, which binds the mutant over the subject's own path so {} is not needed (requires bwrap), or use --in-tree, where {} is optional." ;;
  esac
fi

# capability:bash foreground calls terminate the WHOLE child process tree when
# their short wall-clock deadline expires. That kill can arrive after this
# script has applied the mutant but before Bash gets to run finish(), so the
# trap cannot guarantee restoration of a tracked file. Refuse before creating
# the scratch snapshot or applying any mutation; callers can safely use
# copy-out mode, or run the in-tree probe as a durable background job.
if [ "$IN_TREE" -eq 1 ] && [ "${PAPERCUSP_CAPABILITY_BASH_FOREGROUND:-}" = "1" ]; then
  foreground_timeout_ms="${PAPERCUSP_CAPABILITY_BASH_FOREGROUND_TIMEOUT_MS:-unknown}"
  die "REFUSING --in-tree from capability:bash foreground execution (captured timeout: ${foreground_timeout_ms}ms).
      capability:bash kills this command and its whole process tree at the foreground deadline, which can strand the
      tracked mutant before this script's restore trap runs. Use copy-out mode, or run the probe with
      capability:bash { run_in_background: true } and read progress with capability:bash_output instead."
fi

# An OUTER probe's --fake-destructive guard exports MUTATION_PROBE_DESTRUCTIVE_LOG
# and puts log-only rm/unlink shims first on PATH for everything its --test runs,
# this script included (WI-10004181). Under those shims our own finish() cannot
# delete the admission manifest, and neither can the next probe's orphan recovery
# (it deletes with rm too), so an in-tree run here leaves a manifest and scratch
# dirs that nothing inside the guard can remove. Refuse before any admission state
# or scratch dir exists. Scrubbing the shims instead is not a fix: under a
# self-probe this script IS the mutant, and the shims are what keep its rm calls inert.
if [ "$IN_TREE" -eq 1 ] && [ -n "${MUTATION_PROBE_DESTRUCTIVE_LOG:-}" ]; then
  die "REFUSING --in-tree inside another probe's --fake-destructive guard (MUTATION_PROBE_DESTRUCTIVE_LOG is set).
      That guard makes rm/unlink log-only for this process, so this probe could not remove its own admission
      manifest or scratch state, and would leave a snapshot behind on the checkout.
      Run in-tree probes outside any --fake-destructive guard. To probe this script itself, use the manual
      copy-out recipe in apps/operator/lib/mutation-probe-sweep-gate.test.ts's header."
fi

# --in-tree is the ONLY mode that leaves a deliberately-wrong state in the
# tracked tree, and the sweep race is the one hazard this script cannot close
# for you: git-sync commits the WHOLE working tree on a short cadence, so a
# probe whose test run outlives one tick gets its mutant committed even when
# nothing goes wrong and the trap never fires. Refuse until the caller has
# decided what to do about it. This deliberately REPLACES a warning that was
# logged while the mutation was already under way — a notice you can skim past
# is not a decision, and the whole point is that one has to be made.
if [ "$IN_TREE" -eq 1 ] && [ -z "$SWEEP_ACK" ]; then
  die "--in-tree needs you to say what you did about the git-sync SWEEP race.

      git-sync commits the whole working tree every few minutes. Your mutant is
      a deliberately-broken tracked file; if a tick lands during the test run it
      is committed to staging, and a committed RED test freezes every agent's
      deploys until someone notices. The trap in this script closes the DEATH
      race (a kill mid-run), not this one.

      PREFERRED — hold the mutated file off the sweep, then pass
      --sweep-lock-held:

          locks:acquire { paths: ['$(sweep_lock_path)'],
                          coordination_domain: '$(sweep_lock_repo_root)',
                          ttl_sec: 1200, intent: 'mutation probe' }

      git-sync excludes actively file-locked paths from its staging pathspecs,
      so unrelated files and probes on disjoint paths keep moving. The probe
      verifies the current-session lock and heartbeats it to 1200 seconds.
      git-sync also re-checks locks after staging, so a lock taken mid-tick
      still holds the mutant back (EI-24712906810240170); no git-sync resource
      lease is needed, in the superproject or a submodule. Release the lock
      only after the restored file is verified:

          locks:heartbeat { lock_id: '<returned lock_id>', ttl_sec: 1200 }
          locks:release  { lock_id: '<returned lock_id>' }

      OR --accept-sweep-race, if this checkout is not swept (a scratch repo, a
      fork) or you have judged the exposure yourself. Either choice is recorded
      in the MUTATION_PROBE_RESULT line.

      BEST — drop --in-tree entirely. Copy-out mode mutates a copy under a
      scratch dir, so the tracked file is never dirty for an instant and there
      is no window to protect. It needs only that your --test can be pointed at
      a path via {}."
fi
if [ "$IN_TREE" -eq 0 ] && [ -n "$SWEEP_ACK" ]; then
  die "--sweep-lock-held / --accept-sweep-race only mean something with --in-tree.
      Copy-out mode never touches the tracked file, so there is no sweep window
      to hold open or accept. Drop the flag (or add --in-tree if you meant it)."
fi

# --- destructive-subject flag plumbing (EI-20566003853444873) ----------------
if [ "$DELETES_ACK" -eq 1 ] && [ "$FAKE_DESTRUCTIVE" -eq 1 ]; then
  die "pick ONE: --fake-destructive (shimmed, nothing really deletes) or
      --i-know-this-deletes --sandbox-root <dir> (real execution, sandboxed).
      Combining them would run REAL deletion logic while telling you it was shimmed."
fi
if [ "$DELETES_ACK" -eq 1 ] && [ -z "$SANDBOX_ROOT" ]; then
  die "--i-know-this-deletes ALSO requires --sandbox-root <dir>.
      Acknowledging the danger does not remove it: the 2026-08-15 incident ran a
      mutant whose delete loop had been widened to 'for d in /*' — an
      acknowledgement flag alone would not have saved a single byte. With
      --sandbox-root, both guard runs execute under bwrap with / READ-ONLY and
      only <dir> + the probe scratch dir writable, so a widened mutant hits a
      wall. If your guard cannot run sandboxed, use --fake-destructive instead."
fi
if [ -z "$SANDBOX_ROOT" ] || [ "$DELETES_ACK" -eq 1 ]; then :; else
  die "--sandbox-root only means something with --i-know-this-deletes.
      (--fake-destructive needs no sandbox: nothing real executes deletion.)"
fi
if [ -n "$SANDBOX_ROOT" ]; then
  [ -d "$SANDBOX_ROOT" ] || die "no such --sandbox-root directory: $SANDBOX_ROOT"
  SANDBOX_ROOT="$(cd "$SANDBOX_ROOT" && pwd)" || die "could not resolve --sandbox-root"
fi

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/mutation-probe.XXXXXX")" || die "could not create scratch dir"
readonly SCRATCH
# Admission is serialized with testing:run's router wrapper. A complete
# original-byte manifest is published before any in-tree mutation, and removed
# only after restoration. The lock is not held during the guard itself.
PROBE_ADMISSION_FD=""
PROBE_MANIFEST=""
PROBE_MUTANT_FILE="$SCRATCH/in-tree-mutant"
PROBE_MUTANT_SUM=""
PROBE_MUTATION_APPLIED=0
if [ "$IN_TREE" -eq 1 ]; then
  command -v bwrap >/dev/null || die "--in-tree requires bwrap to isolate concurrent testing:run children"
  ADMISSION_ROOT="$(git -C "$(dirname "$FILE")" rev-parse --show-toplevel)" ||
    die "--in-tree requires a tracked checkout for mutation admission"
  ADMISSION_ROOT="$(realpath -e "$ADMISSION_ROOT")" || die "cannot resolve mutation checkout"
  ADMISSION_KEY="$(printf '%s' "$ADMISSION_ROOT" | sha256sum | cut -d' ' -f1)"
  ADMISSION_BASE="${PAPERCUSP_MUTATION_PROBE_ADMISSION_ROOT:-/tmp}"
  ADMISSION_DIR="$ADMISSION_BASE/papercusp-mutation-probe-$(id -u)-$ADMISSION_KEY"
  mkdir -p -m 700 "$ADMISSION_DIR" || die "cannot create probe admission directory"
  PROBE_MANIFEST="$ADMISSION_DIR/original.manifest"
  exec {PROBE_ADMISSION_FD}>"$ADMISSION_DIR/admission.lock"
  flock -x "$PROBE_ADMISSION_FD" || die "cannot acquire mutation admission lock"
  source "$(dirname -- "$MUTATION_PROBE_SOURCE_PATH")/mutation-probe-admission.sh"
  if [ -e "$PROBE_MANIFEST" ]; then
    probe_admission_read_manifest "$ADMISSION_ROOT" "$PROBE_MANIFEST" ||
      die "another mutation probe has an invalid snapshot manifest: $PROBE_MANIFEST"
    probe_admission_owner_alive &&
      die "another mutation probe has an active snapshot: $PROBE_MANIFEST"
    probe_admission_recover_orphan "$ADMISSION_ROOT" "$PROBE_MANIFEST" ||
      die "could not safely recover orphaned mutation-probe snapshot: $PROBE_MANIFEST"
  fi
fi
BASE="$SCRATCH/$(basename "$FILE").orig"
# -p keeps the subject's mtime on BASE so an in-tree restore puts it back with the bytes.
# plans:bind-spec-evidence refuses a run whose measured files changed after it started
# (EI-24826121815486916), and a restored subject is byte-identical to what the baseline ran.
cp -p "$FILE" "$BASE" || die "could not snapshot $FILE"

# Keep a whitespace-normalized snapshot as well. A mis-escaped expression can
# change bytes without changing any non-whitespace token (for example, by
# deleting one leading space from every shell line), which would otherwise
# produce a false "MUTANT SURVIVED" verdict about a mutation that did not test
# the intended guard behavior. Refuse that conservative case below.
BASE_NON_WHITESPACE="$SCRATCH/$(basename "$FILE").orig.non-whitespace"
tr -d '[:space:]' < "$BASE" > "$BASE_NON_WHITESPACE" || die "could not normalize the probe baseline"

# The ORIGINAL bytes, captured before anything is touched. Every integrity
# claim this script makes is decided against this, never against `git status`
# (on a swept tree a clean status means the sweep ran, not that the file is
# unmodified — CLAUDE.md documents this at length).
ORIG_SUM="$(git hash-object "$FILE")"
readonly BASE BASE_NON_WHITESPACE ORIG_SUM

# The subject's own extension, preserved onto every RELOCATED snapshot path.
# tsx/node decide whether to STRIP TYPES by EXTENSION, so a snapshot path that
# drops it is handed to Node's plain-JS loader and a TypeScript subject dies at
# PARSE (`const X = 1 as const;` -> SyntaxError: Unexpected identifier 'as').
# That kills the current AND historical legs for a reason that has nothing to do
# with the guard, so historical mode could only ever report verdict=harness-error
# -- i.e. it could not reach a verdict for ANY TypeScript subject, in a repo that
# is overwhelmingly TypeScript. Copy-out mode never had this defect: it relocates
# to the subject's own repo-relative path (or its basename), both of which carry
# the extension already. EI-23362664002917898.
case "$(basename "$FILE")" in
  ?*.*) SNAPSHOT_EXT=".${FILE##*.}" ;;
  *)    SNAPSHOT_EXT="" ;;
esac
readonly SNAPSHOT_EXT

# ---------------------------------------------------------------------------
# Restore + integrity verification. In copy-out mode this only has to PROVE
# the tracked file was never touched; in --in-tree mode it is also what puts
# the file back, and it runs from a trap so it survives SIGTERM/SIGINT and the
# foreground-deadline kill that stranded the original mutant.
# ---------------------------------------------------------------------------
RESTORE_STATUS="not-run"
CHILD=""

# Kill a process and every descendant, DEPTH-FIRST by pid — never by name or
# pattern. `eval "$CMD" &` runs the guard in a subshell, so the real work
# (npm -> node -> vitest) is a GRANDchild: signalling only $CHILD leaves the
# expensive part running orphaned on a shared, already-loaded box. Walking
# --ppid is exact; `pkill -f <pattern>` is banned here because it matches the
# caller's own argv and has twice killed unrelated processes on this host.
kill_tree() {
  local pid="$1" kid
  for kid in $(ps -o pid= --ppid "$pid" 2>/dev/null); do
    kill_tree "$kid"
  done
  kill -TERM "$pid" 2>/dev/null || true
}
finish() {
  local rc="${1:-$?}"
  # Disarm FIRST: without this the handler runs twice (once for TERM, once for
  # the EXIT that TERM causes) and prints its verdict twice.
  trap - EXIT INT TERM
  # COPY-OUT never writes FILE: a changed source is an external edit, not probe
  # damage. IN-TREE may restore only when the current bytes still equal the
  # exact mutant generated from BASE; otherwise a blind copy would erase a peer
  # edit. Hash into scratch and read it without command substitution so a
  # signal cannot interrupt nested hash parsing inside this trap.
  local now tree_conflict=0
  if git hash-object "$FILE" > "$SCRATCH/current.sha" 2>/dev/null; then
    IFS= read -r now < "$SCRATCH/current.sha" || now="MISSING"
  else
    now="MISSING"
  fi
  if [ "$now" = "$ORIG_SUM" ]; then
    RESTORE_STATUS="verified-identical"
    log "tree integrity: VERIFIED — $FILE is byte-identical to its pre-probe state"
  elif [ "$IN_TREE" = "1" ] && [ "$PROBE_MUTATION_APPLIED" = "1" ] &&
      [ -n "$PROBE_MUTANT_SUM" ] && [ "$now" = "$PROBE_MUTANT_SUM" ]; then
    # The only bytes on disk are the probe's own mutant, so restoring BASE is
    # safe. The caller's path lock remains the serialization boundary for this
    # in-tree write.
    if cp -p -- "$BASE" "$FILE" 2>/dev/null &&
        git hash-object "$FILE" > "$SCRATCH/restored.sha" 2>/dev/null &&
        IFS= read -r now < "$SCRATCH/restored.sha" && [ "$now" = "$ORIG_SUM" ]; then
      RESTORE_STATUS="verified-identical"
      log "tree integrity: VERIFIED — $FILE is byte-identical to its pre-probe state"
    else
      RESTORE_STATUS="restore-verification-failed"
      tree_conflict=1
      log "🚨 IN-TREE RESTORE VERIFICATION FAILED — preserving the current file and recovery snapshots."
      printf 'MUTATION_PROBE_TREE_RESULT status=restore-verification-failed target=in-tree source_sha=%s mutant_sha=%s current_sha=%s\n' \
        "$ORIG_SUM" "$PROBE_MUTANT_SUM" "$now"
    fi
  elif [ "$IN_TREE" = "1" ]; then
    RESTORE_STATUS="concurrent-change-preserved"
    tree_conflict=1
    log "🚨 IN-TREE SOURCE CHANGED — it matches neither the pre-probe nor exact mutant snapshot."
    log "🚨 Refusing to overwrite it; the baseline and mutant snapshots remain at $BASE and $PROBE_MUTANT_FILE."
    log "🚨 Review the diff before reconciling any probe mutation."
    printf 'MUTATION_PROBE_TREE_RESULT status=concurrent-change-preserved target=in-tree source_sha=%s mutant_sha=%s current_sha=%s\n' \
      "$ORIG_SUM" "${PROBE_MUTANT_SUM:-unknown}" "$now"
  else
    RESTORE_STATUS="external-change-preserved"
    log "copy-out source changed during the probe; copy-out did not write the tracked file."
    log "The probe measured source blob $ORIG_SUM; the current source blob is $now. No restore was attempted."
    printf 'MUTATION_PROBE_TREE_RESULT status=external-change-preserved target=copy-out source_sha=%s current_sha=%s\n' \
      "$ORIG_SUM" "$now"
  fi
  rm -f -- "$MUTATION_PROBE_FROZEN_SOURCE"
  # Reap the probe's own child and every descendant. For a known in-tree
  # conflict, preserve scratch recovery copies and stop before recording a
  # successful restore or deleting the admission manifest.
  if [ -n "$CHILD" ]; then
    kill_tree "$CHILD"
  fi
  if [ "$tree_conflict" -eq 1 ]; then
    trap - EXIT
    exit 3
  fi
  if [ -n "$PROBE_ADMISSION_FD" ]; then
    flock -x "$PROBE_ADMISSION_FD" || exit 3
    # Recorded BEFORE the manifest goes, so the subject is never uncovered while
    # the lock lingers (EI-24720263797874266).
    probe_admission_record_restored "$ADMISSION_ROOT" "$ADMISSION_DIR" "$FILE" "$BASE" ||
      log "note: could not record the verified restore of $FILE; the testing:run fence stays conservative while its lock lingers"
    rm -f -- "$PROBE_MANIFEST"
    flock -u "$PROBE_ADMISSION_FD"
  fi
  # Only discard the scratch dir once integrity is proven; if anything went
  # wrong the pristine copy is the operator's recovery path, so it stays.
  rm -rf "$SCRATCH"
  exit $rc
}
trap 'finish "$?"' EXIT
trap 'finish 130' INT
trap 'finish 143' TERM
if [ "$IN_TREE" -eq 1 ]; then
  printf '%s\0%s\0%s\0%s\0' "$ADMISSION_ROOT" "$FILE" "$BASE" "$$" >"$PROBE_MANIFEST" ||
    die "cannot publish original-byte mutation snapshot"
  flock -u "$PROBE_ADMISSION_FD" || die "cannot release mutation admission lock"
fi

CURRENT_SNAPSHOT=""
HISTORICAL_SNAPSHOT=""
HISTORICAL_SHA=""
GIT_ROOT=""
REL_FILE=""

if [ "$HISTORICAL_MODE" -eq 1 ]; then
  # Historical mode never reads the working file again after this point. The
  # current bytes are a frozen snapshot too: git-sync may advance the tree
  # while a long guard suite runs, and comparing a live current file to a
  # historical blob would make the two sides observe different revisions.
  CURRENT_SNAPSHOT="$SCRATCH/current.snapshot"
  cp -p "$BASE" "$CURRENT_SNAPSHOT" || die "could not freeze the current snapshot"

  GIT_ROOT="$(git -C "$(dirname "$FILE")" rev-parse --show-toplevel 2>"$SCRATCH/git-root.err")" \
    || die "--against-commit / --against-last-without requires --file to be inside a Git worktree: $(head -3 "$SCRATCH/git-root.err" 2>/dev/null)"
  case "$FILE" in
    "$GIT_ROOT"/*) REL_FILE="${FILE#"$GIT_ROOT"/}" ;;
    *) die "--file is not inside the Git worktree root: $GIT_ROOT" ;;
  esac
  # "Tracked" means the path is in HEAD's tree, read from the object store.
  # Never ask the index here (WI-10004910): git-sync rewrites .git/index on
  # every sweep, and a half-written index makes `ls-files --error-unmatch`
  # exit 1 with "did not match" for a tracked path, byte-for-byte the
  # signature of a genuinely untracked one (a zero-byte index exits 128), so
  # no exit-code or stderr filter can tell the two apart. Refs and objects are
  # written atomically, so this read cannot see a half-written state. It is
  # also the precondition historical mode really has: a staged-but-never-
  # committed file has no history to compare against.
  git -C "$GIT_ROOT" --literal-pathspecs ls-tree -z --full-tree --name-only HEAD -- "$REL_FILE" \
      >"$SCRATCH/head-tree.out" 2>"$SCRATCH/head-tree.err" \
    || die "git could not read HEAD's tree in $GIT_ROOT, so whether '$REL_FILE' is committed is UNKNOWN (a git read failure, not an untracked file): $(head -3 "$SCRATCH/head-tree.err" 2>/dev/null)"
  HEAD_ENTRY=""
  IFS= read -r -d '' HEAD_ENTRY <"$SCRATCH/head-tree.out" || true
  [ "$HEAD_ENTRY" = "$REL_FILE" ] \
    || die "historical mode requires a --file committed at HEAD; HEAD's tree has no path '$REL_FILE' in $GIT_ROOT (an untracked or staged-but-uncommitted file has no history to compare against)"

  if [ -n "$AGAINST_COMMIT" ]; then
    HISTORICAL_SHA="$(git -C "$GIT_ROOT" rev-parse --verify "${AGAINST_COMMIT}^{commit}" 2>/dev/null)" \
      || die "could not resolve --against-commit '$AGAINST_COMMIT' to a commit"
  else
    CANDIDATE="$SCRATCH/historical-candidate"
    CANDIDATE_ERR="$SCRATCH/historical-candidate.err"
    while IFS= read -r sha; do
      # Materialize each candidate instead of piping git show to grep: grep -q
      # can close the pipe early, and pipefail would turn that SIGPIPE into a
      # false "token absent" result.
      if git -C "$GIT_ROOT" show "$sha:$REL_FILE" >"$CANDIDATE" 2>"$CANDIDATE_ERR"; then
        if ! grep -Fq -- "$AGAINST_LAST_WITHOUT" "$CANDIDATE"; then
          HISTORICAL_SHA="$sha"
          break
        fi
      fi
    done < <(git -C "$GIT_ROOT" rev-list HEAD -- "$REL_FILE")
    [ -n "$HISTORICAL_SHA" ] || die "no reachable commit on HEAD has '$REL_FILE' without the required literal '$AGAINST_LAST_WITHOUT'"
  fi

  HISTORICAL_SNAPSHOT="$SCRATCH/historical.snapshot"
  git -C "$GIT_ROOT" show "$HISTORICAL_SHA:$REL_FILE" >"$HISTORICAL_SNAPSHOT" 2>"$SCRATCH/historical-show.err" \
    || die "commit '$HISTORICAL_SHA' does not contain '$REL_FILE': $(head -3 "$SCRATCH/historical-show.err" 2>/dev/null)"
  if cmp -s "$CURRENT_SNAPSHOT" "$HISTORICAL_SNAPSHOT"; then
    die "historical snapshot is byte-identical to the frozen current snapshot (selected commit is not a before-fix source)"
  fi

  # The absence control is the guard against selecting the fixed side by
  # mistake. --against-last-without proves it while selecting; explicit
  # --against-commit needs the caller to name the construct that must be
  # absent. Check both sides again after extraction so the evidence is local,
  # deterministic, and visible in the probe output.
  grep -Fq -- "$MUST_BE_ABSENT" "$CURRENT_SNAPSHOT" \
    || die "absence control '$MUST_BE_ABSENT' is not present in the frozen current snapshot"
  if grep -Fq -- "$MUST_BE_ABSENT" "$HISTORICAL_SNAPSHOT"; then
    die "absence control '$MUST_BE_ABSENT' is present in historical commit $HISTORICAL_SHA; this is not a before-fix snapshot"
  fi

  [ "${#POSITIVE_CONTROLS[@]}" -gt 0 ] || die "historical mode requires positive controls"
  for control in "${POSITIVE_CONTROLS[@]}"; do
    [ -n "$control" ] || die "--positive-control literals must not be empty"
    grep -Fq -- "$control" "$CURRENT_SNAPSHOT" \
      || die "positive control '$control' is absent from the frozen current snapshot"
    grep -Fq -- "$control" "$HISTORICAL_SNAPSHOT" \
      || die "positive control '$control' is absent from historical commit $HISTORICAL_SHA"
  done

  log "historical source: commit=$HISTORICAL_SHA path=$REL_FILE"
  log "frozen snapshots: current=$CURRENT_SNAPSHOT historical=$HISTORICAL_SNAPSHOT"
  log "absence control: $MUST_BE_ABSENT"
  for control in "${POSITIVE_CONTROLS[@]}"; do
    log "positive control: $control"
  done
fi

# ---------------------------------------------------------------------------
# Destructive-subject gate (EI-20566003853444873, the 2026-08-15 incident).
# Everything above only READS the subject; the first EXECUTION of anything is
# the baseline guard run below, so this gate must sit before it in mutation
# modes. Historical mode executes an unmutated source snapshot and keeps the
# same scan as a warning instead of refusing the comparison. The scan is
# deliberately conservative — a false positive costs one flag; a false negative
# already cost ~370GB.
# ---------------------------------------------------------------------------
DESTRUCTIVE_ERE='\b(rm|rmdir|unlink|shred|truncate)\b|\bmkfs(\.[[:alnum:]]+)?\b|\bdd\b[^|;&()]*\bof=|\bfind\b[^|;&()]*-delete'
SUBJ_HITS="$(grep -Eo "$DESTRUCTIVE_ERE" "$FILE" 2>/dev/null | sort -u | head -6 | tr '\n' ' ' || true)"
HIST_SUBJ_HITS=""
if [ "$HISTORICAL_MODE" -eq 1 ]; then
  HIST_SUBJ_HITS="$(grep -Eo "$DESTRUCTIVE_ERE" "$HISTORICAL_SNAPSHOT" 2>/dev/null | sort -u | head -6 | tr '\n' ' ' || true)"
fi
CMD_HITS="$(printf '%s\n%s' "$TEST_CMD" "$CALIBRATION_CMD" | grep -Eo "$DESTRUCTIVE_ERE" 2>/dev/null | sort -u | head -6 | tr '\n' ' ' || true)"
# EI-22197950741786296: show WHERE it matched, not just WHICH token. The scan is a
# deliberately blunt word match, so `truncate` in a comment refuses the file just as
# hard as a real `rm -rf` call — and a bare token list gives the operator no way to
# tell those apart, which is what makes a false positive feel arbitrary. The gate is
# NOT narrowed (it exists because of a ~370GB loss, EI-20566003853444873, and the item's
# own filer agreed narrowing it without a positive control would disarm it); instead the
# refusal now quotes the site so a comment-only match is recognisable on sight.
SUBJ_SITES="$(grep -nE "$DESTRUCTIVE_ERE" "$FILE" 2>/dev/null | head -4 | cut -c1-160 || true)"
HISTORICAL_DESTRUCTIVE_HITS="$SUBJ_HITS$HIST_SUBJ_HITS$CMD_HITS"
if [ -n "$HISTORICAL_DESTRUCTIVE_HITS" ] && [ "$HISTORICAL_MODE" -eq 1 ]; then
  log "historical mode: destructive primitives detected (current subject: ${SUBJ_HITS:-none}; historical subject: ${HIST_SUBJ_HITS:-none}; --test/--calibration: ${CMD_HITS:-none}); no mutant is produced, so allowing the unmutated historical source comparison. Use --fake-destructive or --i-know-this-deletes --sandbox-root if the guard itself executes deletion logic."
elif [ -n "$HISTORICAL_DESTRUCTIVE_HITS" ] && [ "$DELETES_ACK" -eq 0 ] && [ "$FAKE_DESTRUCTIVE" -eq 0 ]; then
  die "REFUSING: the probe would EXECUTE destructive code, and nothing sandboxes what a mutant DOES.
      Matched destructive primitives — current subject: ${SUBJ_HITS:-none}; historical subject: ${HIST_SUBJ_HITS:-none}; --test/--calibration: ${CMD_HITS:-none}

      Where it matched in $FILE (first 4, line-numbered — if every one of these is a
      comment or an identifier rather than a CALL, this is a false positive and
      --fake-destructive is the cheap correct answer, not a workaround):
${SUBJ_SITES:-        (no in-file match — the hit is in --test/--calibration)}

      This script's guarantees protect the FILE UNDER TEST, never the filesystem the
      mutant runs against. Executing a mutant of deletion code means running
      deliberately-corrupted deletion logic with your full privileges: on 2026-08-15
      exactly that turned a reaper's loop into 'for d in /*' and destroyed ~370GB
      (EI-20566003853444873). Pick one:

      PREFERRED — add --fake-destructive
          Shim executables (rm, rmdir, unlink, shred, truncate, mkfs, dd) are
          prepended to PATH for both guard runs; each logs its argv to the scratch
          dir's destructive-calls.log and deletes NOTHING. Assert on what the code
          WOULD delete. (PATH-level only: an absolute /bin/rm call bypasses it.)

      OR — add --i-know-this-deletes --sandbox-root <dir>
          Real execution, but both guard runs are wrapped in bwrap with / mounted
          READ-ONLY and only <dir> + the probe scratch dir writable.

      If the match is a false positive (e.g. 'rm' inside a comment or a path),
      either flag is safe — they only ever ADD protection."
fi

if [ "$FAKE_DESTRUCTIVE" -eq 1 ]; then
  FAKE_BIN="$SCRATCH/fake-bin"
  DESTRUCTIVE_LOG="$SCRATCH/destructive-calls.log"
  mkdir -p "$FAKE_BIN" || die "could not create the fake-destructive shim dir"
  : >"$DESTRUCTIVE_LOG"
  for shim_tool in rm rmdir unlink shred truncate mkfs dd; do
    cat >"$FAKE_BIN/$shim_tool" <<'SHIM'
#!/usr/bin/env bash
printf '%s %s\n' "${0##*/}" "$*" >> "${MUTATION_PROBE_DESTRUCTIVE_LOG:?}"
exit 0
SHIM
    chmod +x "$FAKE_BIN/$shim_tool" || die "could not install shim: $shim_tool"
  done
  log "fake-destructive: shims installed ($FAKE_BIN); intercepted calls -> $DESTRUCTIVE_LOG"
fi

if [ "$DELETES_ACK" -eq 1 ]; then
  command -v bwrap >/dev/null 2>&1 \
    || die "--i-know-this-deletes needs bwrap (bubblewrap) for its read-only sandbox and this host has none. Use --fake-destructive instead."
  if ! bwrap --ro-bind / / --dev /dev --ro-bind-try /dev/shm /dev/shm --proc /proc --die-with-parent -- true 2>"$SCRATCH/bwrap-preflight.err"; then
    die "bwrap cannot create its sandbox on this host (user namespaces may be disabled here):
      $(head -3 "$SCRATCH/bwrap-preflight.err" 2>/dev/null)
      REFUSING to run destructive code unsandboxed. Use --fake-destructive instead."
  fi
  log "sandbox: guard runs will execute under bwrap — / read-only; writable: $SANDBOX_ROOT + $SCRATCH"
fi

# EI-22133917471532652 (2026-09-02): pc-heavy allocates its after-ready
# marker with a fresh `mktemp "$dir/ready.XXXXXX"` on EVERY invocation
# (scripts/pc-heavy.sh), so a collision on it is never the live-owner case
# the reclaim rule in scripts/lib/preempt-markers.mjs exists to arbitrate —
# it is a rare harness-level clash on the shared /tmp marker directory
# under heavy fleet load (observed once wrapping `npm run test:file` as
# --test). It fails BEFORE a single test runs (TEST_FILE_ROUTE_ERROR exit
# 75, zero tests measured), so it can never be mistaken for a real
# assertion result, and a bare retry draws an entirely fresh random marker
# path. Bounded to ONE retry so a subject that fails this way every time
# still fails loudly. Do NOT "fix" this by weakening
# createPreemptMarkerExclusive's live-owner refusal instead — that refusal
# is deliberately conservative and protects a genuinely live peer's barrier.
PC_HEAVY_MARKER_COLLISION_ERE='could not publish the pc-heavy after-ready marker: EEXIST'
detect_pc_heavy_marker_collision() {
  grep -Eq "$PC_HEAVY_MARKER_COLLISION_ERE" "$1" 2>/dev/null
}

# The reporter accepts several legacy scope names, but the probe's child command
# should receive the canonical names explicitly. This matters when a caller has
# only the interactive/session aliases set: downstream runners and reporters
# launched by npm must see the same scope without each caller repeating a long
# environment prefix. Preserve genuinely unscoped probes as unscoped; never
# invent a harness or workspace default here.
propagate_test_run_scope() {
  local harness_scope="${PAPERCUSP_TEST_RUN_HARNESS:-${HARNESS_SLUG:-${PAPERCUSP_HARNESS_SLUG:-}}}"
  local workspace_scope="${PAPERCUSP_WORKSPACE_ID:-${PAPERCUSP_WORKSPACE:-}}"
  if [ -n "$harness_scope" ]; then
    export PAPERCUSP_TEST_RUN_HARNESS="$harness_scope"
  fi
  if [ -n "$workspace_scope" ]; then
    export PAPERCUSP_WORKSPACE_ID="$workspace_scope"
  fi
}

# ── the in-tree DIRTY-WINDOW ceiling (EI-23809205858633494) ──────────────────
# --in-tree holds the TRACKED file mutated for exactly as long as the guard
# child runs, so every second inside that child that is NOT measurement is pure
# sweep-race risk. Two things extend it while measuring nothing:
#
#   1. QUEUEING. The documented --test command is `npm run test:file`, which is
#      pc-heavy-wrapped (scripts/pc-heavy.sh — a host-wide counting semaphore
#      that WAITS for other agents' heavy runs to drain). MEASURED 2026-09-20:
#      it sat in that admission queue 6+ MINUTES without starting a single test
#      while a mutated packages/operator-core file sat in the shared tree; the
#      same file through the direct router took ~25s. The queue is unbounded by
#      design, so the mutation window inherited an unbounded wait — and the
#      probe's whole reason to exist is keeping that window SHORT.
#   2. A genuinely slow, or hung, guard command.
#
# (1) is removed by exporting PC_HEAVY_BYPASS=1 into the in-tree guard child.
# That is pc-heavy's own sanctioned "this command is never made to QUEUE" door,
# and it has an exact precedent: the RELEASE GATE takes the same exemption
# (PC_HEAVY_RELEASE_GATE, pc-heavy.sh) for the same reason — waiting there
# converts into a different, worse failure. It exempts from ADMISSION only.
#
# (2) is bounded by running the in-tree guard under `timeout`. The default
# matches the 600s file-lock TTL the CLAUDE.md recipe prescribes: past it the
# lock the caller was told to hold has lapsed anyway, so the sweep exclusion the
# window depends on is already gone. MUTATION_PROBE_WINDOW_MAX_SEC overrides it;
# 0 disables it.
#
# COPY-OUT MODE IS DELIBERATELY UNTOUCHED — it has no dirty window at all, so it
# stays a well-behaved queued citizen and keeps whatever runtime it needs.
GUARD_MAX_SEC=0
if [ "$IN_TREE" -eq 1 ]; then
  GUARD_MAX_SEC="${MUTATION_PROBE_WINDOW_MAX_SEC:-600}"
  case "$GUARD_MAX_SEC" in
    ''|*[!0-9]*)
      die "MUTATION_PROBE_WINDOW_MAX_SEC must be a whole number of seconds (got: '${MUTATION_PROBE_WINDOW_MAX_SEC}'). Use 0 to disable the ceiling." ;;
  esac
  if [ "$GUARD_MAX_SEC" -gt 0 ] && ! command -v timeout >/dev/null 2>&1; then
    log "⚠️  coreutils \`timeout\` is not on PATH — the in-tree dirty window will run UNBOUNDED. Prefer copy-out mode."
    GUARD_MAX_SEC=0
  fi
fi

# Run a guard in an interruptible child and preserve its output for the
# machine-readable verdict below. The phase marker lets a guard's own test
# fixture skip an intentionally slow baseline setup without weakening the
# production command shape; it is also useful to test that the baseline and
# mutant really went through the same invocation path.
run_guard() {
  local phase="$1" label="$2" cmd="$3" output="$4" rc attempt guard_started guard_elapsed
  for attempt in 1 2; do
    log "running $label: $cmd"
    (
      export PAPERCUSP_MUTATION_PHASE="$phase"
      # A deliberate baseline/mutant result is falsifiability evidence, not a
      # measurement of the repository's health. Keep the marker scoped to the
      # supervised child so it reaches every test process without leaking into
      # the caller's environment.
      export PAPERCUSP_MUTATION_PROBE=1
      export PAPERCUSP_MUTATION_MODE="$HISTORICAL_MODE"
      # WI-10004898: a copy-out guard records from the .git-less mirror, so the
      # test_runs reporter could never prove the run clean (every row landed
      # commit=NULL, worktree_dirty=true, which spec freshness rates unknown).
      # Name the ORIGIN checkout so the reporter snapshots that instead: the
      # mirror is the origin's files plus this probe's own scratch subject. A
      # shared-tree origin is still dirty; a clean clone of one commit (for
      # example a `lint:as-committed --keep` tree) now records that commit, clean.
      if [ "${TARGET_MODE:-}" = "copy-out" ] && [ -n "${COPY_OUT_ROOT:-}" ] && [ -n "${COPY_OUT_REL:-}" ]; then
        export PAPERCUSP_MUTATION_PROBE_ORIGIN_ROOT="$COPY_OUT_ROOT"
      fi
      # WI-10004952: an in-tree guard mutates the subject IN the checkout, so the
      # reporter's porcelain snapshot always saw it and every in-tree row landed
      # worktree_dirty=true, even from a pristine as-committed clone. Name the
      # subject (absolute) so the reporter exempts exactly that one path; any other
      # dirt, and a shared-tree origin, still record dirty.
      if [ "$IN_TREE" -eq 1 ]; then
        export PAPERCUSP_MUTATION_PROBE_SUBJECT="$FILE"
      fi
      # EI-24799401310241778: every post-baseline run of an OVERLAY probe executes
      # in a private mount namespace where the scratch copy is bound over the
      # subject's own path. Inside it the checkout reads exactly like an in-tree
      # probe's (only the subject differs), so the reporter gets the same
      # one-path exemption. The baseline stays OUTSIDE: it is the unmutated
      # reference the whole verdict is measured against.
      overlay_args=()
      if [ "${RELOCATION_USED:-}" = "overlay" ] && [ "$phase" != "baseline" ]; then
        overlay_args=(--bind "$TARGET" "$OVERLAY_DEST")
        export PAPERCUSP_MUTATION_PROBE_SUBJECT="$FILE"
      fi
      # See the DIRTY-WINDOW ceiling above. Exported for BOTH phases in in-tree
      # mode and never for the mutant alone: the baseline and the mutant have to
      # go through the same invocation path, or the comparison the whole verdict
      # rests on is between two different things.
      if [ "$IN_TREE" -eq 1 ]; then
        export PC_HEAVY_BYPASS=1
      fi
      # Plain assignment, not `local`: this is already a subshell, so it cannot
      # leak, and an empty array must stay empty-safe under `set -u`.
      guard_prefix=()
      if [ "$GUARD_MAX_SEC" -gt 0 ]; then
        # No --foreground: that omission is what lets `timeout` put the command
        # in its OWN process group and signal the GROUP, so a runner's
        # grandchildren (npm -> node -> vitest workers) are reaped with it
        # rather than orphaned against a file this script is about to restore.
        guard_prefix=(timeout --signal=TERM --kill-after=20 "$GUARD_MAX_SEC")
      fi
      propagate_test_run_scope
      if [ "$FAKE_DESTRUCTIVE" -eq 1 ]; then
        # PATH-level interception, scoped to the supervised child only.
        export PATH="$FAKE_BIN:$PATH"
        export MUTATION_PROBE_DESTRUCTIVE_LOG="$DESTRUCTIVE_LOG"
      fi
      if [ "$DELETES_ACK" -eq 1 ]; then
        # Real execution, walled in: / read-only, only the caller's declared
        # sandbox root and the probe scratch dir writable. TMPDIR is pointed
        # into scratch so well-behaved tools land their temp files inside the
        # writable zone. Parent-held fds (the >"$output" redirect) pass through.
        export TMPDIR="$SCRATCH"
        printf '%s\n' "$cmd" >"$SCRATCH/guard-cmd.sh"
        # --dev replaces /dev, hiding subjects stored in a tmpfs TMPDIR under /dev/shm.
        # Preserve that source tree read-only before granting the two writable binds.
        exec ${guard_prefix[@]+"${guard_prefix[@]}"} \
          bwrap --ro-bind / / --dev /dev --ro-bind-try /dev/shm /dev/shm --proc /proc \
          --bind "$SANDBOX_ROOT" "$SANDBOX_ROOT" --bind "$SCRATCH" "$SCRATCH" \
          ${overlay_args[@]+"${overlay_args[@]}"} \
          --die-with-parent -- bash "$SCRATCH/guard-cmd.sh"
      fi
      if [ "${#overlay_args[@]}" -gt 0 ]; then
        exec ${guard_prefix[@]+"${guard_prefix[@]}"} \
          bwrap --dev-bind / / "${overlay_args[@]}" --die-with-parent -- bash -c "$cmd"
      fi
      if [ "${#guard_prefix[@]}" -gt 0 ]; then
        exec "${guard_prefix[@]}" bash -c "$cmd"
      fi
      eval "$cmd"
    ) >"$output" 2>&1 &
    CHILD=$!
    guard_started="$SECONDS"
    wait "$CHILD"
    rc=$?
    CHILD=""
    guard_elapsed=$(( SECONDS - guard_started ))
    # 124 is `timeout`'s own "I killed it" status; 137 is what it returns when
    # --kill-after had to escalate to SIGKILL (MEASURED 2026-09-20 — NOT 124, as
    # the coreutils docs read at a glance). 137 is AMBIGUOUS on its own: the
    # OOM-killer lands there too. So the ceiling is credited only when the run
    # ALSO actually reached it. A 5-second SIGKILL under a 600s ceiling stays an
    # ordinary nonzero result and flows into the normal verdict logic, instead
    # of being reported as a window overrun that never happened.
    if [ "$GUARD_MAX_SEC" -gt 0 ] && { [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; } \
       && [ "$guard_elapsed" -ge "$GUARD_MAX_SEC" ]; then
      cat "$output"
      # `set -u` is on and TARGET_MODE is assigned AFTER two of run_guard's five
      # call sites, so default it rather than risk an "unbound variable" abort
      # inside the one path whose entire job is reporting cleanly.
      printf 'MUTATION_PROBE_RESULT verdict=harness-error expected=%s target=%s baseline_exit=-1 guard_exit=%d window_exceeded_sec=%d phase=%s\n' \
        "$EXPECT" "${TARGET_MODE:-in-tree:pre-mutation}" "$rc" "$guard_elapsed" "$phase"
      die "the $label run hit the in-tree DIRTY-WINDOW ceiling (${GUARD_MAX_SEC}s) and was killed, so this probe has NO verdict — not 'caught', not 'survived'.

      The tracked file is restored (the trap proves it below), but NOTHING was
      measured. Do not read this as a weak guard.

      WHY THE CEILING EXISTS: --in-tree holds the TRACKED file mutated for
      exactly as long as this command runs, and git-sync sweeps the whole tree
      on a short cadence. An unbounded command is an unbounded window.

      WHAT TO DO:
        * If it was QUEUED rather than working, read the log above — in-tree
          guard children now carry PC_HEAVY_BYPASS=1, so a pc-heavy admission
          wait should no longer be what ate the time.
        * If it is genuinely slow, use the DIRECT test router instead of the
          pc-heavy-wrapped npm script:
              node scripts/test-files.mjs <path>     (not: npm run test:file)
        * If it genuinely needs longer, say so explicitly:
              MUTATION_PROBE_WINDOW_MAX_SEC=<seconds> scripts/mutation-probe.sh ...
          (0 disables the ceiling.) Then hold the file lock at least that long:
          the 600s default IS the CLAUDE.md lock TTL, so past it the sweep
          exclusion you were told to take has already lapsed.
        * BEST: drop --in-tree. Copy-out mode has no window, so it has no
          ceiling and no race to accept."
    fi
    if [ "$attempt" -eq 1 ] && [ "$rc" -ne 0 ] && detect_pc_heavy_marker_collision "$output"; then
      log "$label hit a transient pc-heavy after-ready marker EEXIST (harness noise on the shared /tmp marker dir, zero tests measured) — retrying once with a fresh marker path"
      continue
    fi
    break
  done
  cat "$output"
  return "$rc"
}

# EI-21882388979504012 (2026-08-30): a test runner that cannot COLLECT its
# subject exits nonzero for MISUSE (e.g. vitest's "No test files found,
# exiting with code 1"), and that nonzero is indistinguishable by exit code
# alone from a genuine assertion failure. The reproduced case is copy-out
# mode: the mutated copy lives under a scratch dir a project's test-file
# include globs usually cannot reach, so the runner never ran a single
# assertion yet the script scored guard_exit=1 as "MUTANT CAUGHT". Historical
# mode's frozen-snapshot paths are exposed to the identical failure shape, so
# both verdict computations below consult this one detector. Extend the
# pattern set if a new runner's misuse message surfaces the same way; keep
# additions narrow (a literal runner diagnostic, not a word that could appear
# in genuine test output) so this cannot false-flag a real catch.
RUNNER_MISUSE_ERE='No test files found|Unknown option|: command not found'
detect_runner_misuse() {
  grep -Eo "$RUNNER_MISUSE_ERE" "$1" 2>/dev/null | sort -u | head -3 | tr '\n' ' '
}

# A known test runner can exit 1 before any assertion runs. Its process status
# alone cannot distinguish a failed assertion from a setup-hook timeout that
# leaves the suite skipped. The Papercusp test:file reporter emits one
# TEST_FILE_ASSERTION_FAILURE line per measured assertion failure. Direct
# Vitest output has a `Tests N failed` count. Require one of those for a
# recognized test run; keep ordinary shell guards (grep, node scripts, etc.)
# on their established exit-code contract.
#
# Return 0 and print the evidence kind when an assertion failure is measured;
# return 1 and print why the known test run is inconclusive when it is not;
# return 2 when the output is not a recognized test-run format.
detect_assertion_failure_evidence() {
  local result_line summary cargo_rc
  if grep -Fq 'TEST_FILE_ASSERTION_FAILURE file=' "$1" 2>/dev/null; then
    printf '%s' 'test-file-assertion-failure'
    return 0
  fi

  result_line="$(grep -E '^[[:space:]]*TEST_FILE_RESULT[[:space:]]' "$1" 2>/dev/null | tail -1)"
  if [ -n "$result_line" ]; then
    printf '%s' 'no-assertion-failure-evidence'
    return 1
  fi

  # Cargo uses 101 for BOTH a failed test and a compilation/setup failure.
  # Pair named failures with their own libtest run/summary, rather than crediting
  # a stale failed line from a different binary or an arbitrary exit 101.
  cargo_rc=0
  sed -r 's/\x1B\[[0-9;]*[a-zA-Z]//g' "$1" 2>/dev/null | awk '
    /^running [0-9]+ tests?$/ { running=$2; named=0 }
    /^test .+ \.\.\. FAILED$/ { if (running > 0) named++ }
    /^test result: (ok|FAILED)\./ {
      recognized=1
      if ($3 == "FAILED." && running > 0 && named > 0 && $6 > 0 && named == $6) caught=1
      running=0; named=0
    }
    /^error: (could not compile|failed to |could not execute|process didn.t exit successfully)/ { broken=1 }
    END { if (caught && !broken) exit 0; if (recognized) exit 1; exit 2 }
  ' || cargo_rc=$?
  if [ "$cargo_rc" -eq 0 ]; then
    printf '%s' 'cargo-libtest-failed-tests'
    return 0
  elif [ "$cargo_rc" -eq 1 ]; then
    printf '%s' 'no-cargo-executed-test-failures'
    return 1
  fi

  summary="$(sed -r 's/\x1B\[[0-9;]*[a-zA-Z]//g' "$1" 2>/dev/null \
            | grep -E '^[[:space:]]*Tests[[:space:]]+[0-9]+[[:space:]]+(passed|failed|skipped|todo|pending)([[:space:]]|$)' \
            | tail -1)"
  if [ -n "$summary" ]; then
    if printf '%s' "$summary" | grep -Eq '(^|[[:space:]|])[1-9][0-9]*[[:space:]]+failed([[:space:]|]|$)'; then
      printf '%s' 'vitest-failed-tests'
      return 0
    fi
    printf '%s' 'no-vitest-test-failures'
    return 1
  fi

  # A suite that fails at collection/import (Failed Suites block) prints
  # `Tests  no tests`: a recognized Vitest run that executed ZERO assertions,
  # so it is inconclusive, never caught (WI-10004584).
  if sed -r 's/\x1B\[[0-9;]*[a-zA-Z]//g' "$1" 2>/dev/null \
       | grep -Eq '^[[:space:]]*Tests[[:space:]]+no tests([[:space:]]|$)'; then
    printf '%s' 'vitest-no-tests-collected'
    return 1
  fi

  return 2
}

# Exit 101 never inherits the plain guard exit-1 convention or evidence from
# another runner. Both current-mutant and historical modes use the same rule.
is_assertion_failure_exit() {
  [ "$1" -eq 1 ] || { [ "$1" -eq 101 ] && [ "$2" = cargo-libtest-failed-tests ]; }
}

# EI-20451290782193791 (measured 2026-08-14, reproduced 2026-09-05): the
# sibling hole in the detector above. That one only ever runs where the guard
# exited NONZERO, because a runner that cannot COLLECT fails. A runner that
# collects fine but SELECTS NOTHING does the opposite — it exits ZERO, because
# a zero-selection run is a PASS. Nothing about the exit code distinguishes
# "ran 1 test, it passed" from "ran 0 tests", so the baseline looks healthy,
# the mutant run also exits 0, and the probe reports MUTANT SURVIVED about a
# mutation no assertion ever examined. That verdict is wrong in the expensive
# direction: it says a guard you just wrote is worthless, inviting you to
# rewrite a guard that was fine.
#
# Reproduced on vitest 4.1.8 (`-t` selecting nothing, including the natural
# 'describe > test' path form vitest does not accept):
#     Tests  2 skipped (2)      exit 0     <- zero-selection
#     Tests  1 passed | 1 skipped (2)      <- a real run
# So the discriminator is the runner's own count summary, NOT the exit code:
# a healthy baseline must report at least one PASSED test.
#
# Scoped to the BASELINE phase on purpose — do not reuse this on a mutant log.
# A fully-caught mutant prints `Tests  2 failed (2)`, which also has no
# "passed" (measured), so scoring a mutant with it would false-flag every
# successful catch as a harness error. The baseline is the one phase where a
# passing test is already required, which is what makes the check sound.
#
# Emits nothing when the guard prints no count summary at all (a `grep -q` or
# plain-node guard), so a non-test guard can never trip it.
detect_zero_selection() {
  local line cargo_empty
  cargo_empty="$(sed -r 's/\x1B\[[0-9;]*[a-zA-Z]//g' "$1" 2>/dev/null | awk '
    /^test result: ok\./ { seen=1; if ($4 > 0) passed=1 }
    END { if (seen && !passed) print "cargo-libtest-zero-passed" }
  ')"
  if [ -n "$cargo_empty" ]; then
    printf '%s' "$cargo_empty"
    return 0
  fi
  # Vitest may print "Tests closed successfully ..." AFTER its count summary.
  # Diagnostic prose is not a zero-test result and must not replace that summary.
  line="$(sed -r 's/\x1B\[[0-9;]*[a-zA-Z]//g' "$1" 2>/dev/null \
          | grep -E '^[[:space:]]*Tests[[:space:]]+[0-9]+[[:space:]]+(passed|failed|skipped|todo|pending)([[:space:]]|$)' | tail -1)"
  [ -n "$line" ] || return 0
  # Require a positive count: "0 passed" is still zero selection.
  if printf '%s' "$line" | grep -Eq '(^|[[:space:]|])[1-9][0-9]*[[:space:]]+passed([[:space:]|]|$)'; then
    return 0
  fi
  printf '%s' "$(printf '%s' "$line" | sed -r 's/^[[:space:]]+//; s/[[:space:]]+$//')"
}

if [ "$HISTORICAL_MODE" -eq 1 ]; then
  # Hand each child a fresh copy of a frozen snapshot. A guard/calibration
  # suite that writes its subject must not rewrite the reference used by the
  # next phase, and the current working file must never be the `{}` target.
  SNAPSHOT_RUN=0
  run_snapshot_command() {
    local phase="$1" label="$2" snapshot="$3" template="$4" output="$5" target cmd rc
    SNAPSHOT_RUN=$((SNAPSHOT_RUN + 1))
    target="$SCRATCH/snapshot-run-$SNAPSHOT_RUN$SNAPSHOT_EXT"
    cp -p "$snapshot" "$target" || die "could not stage $phase snapshot copy"
    cmd="${template//\{\}/$target}"
    run_guard "$phase" "$label" "$cmd" "$output"
    rc=$?
    if ! cmp -s "$snapshot" "$target"; then
      die "$phase command modified its snapshot copy; calibration/verdict evidence is unsound"
    fi
    return "$rc"
  }

  TARGET_MODE="historical:$HISTORICAL_SHA"
  readonly TARGET_MODE
  CURRENT_GUARD_LOG="$SCRATCH/current-guard.log"
  CALIBRATION_CURRENT_LOG="$SCRATCH/calibration-current.log"
  CALIBRATION_HISTORICAL_LOG="$SCRATCH/calibration-historical.log"
  HISTORICAL_GUARD_LOG="$SCRATCH/historical-guard.log"

  # --- subject-must-behave: prove RELOCATION alone does not change behaviour -
  # (EI-21902332137059032, 2026-08-30 -- the location-dependent-subject class
  # documented in this script's own header.) Opt-in and skipped entirely when
  # the caller does not pass --subject-must-behave, so this can never change
  # an existing caller's verdict. When passed, run the smoke command once
  # in-tree (against the literal --file path) and once relocated (against a
  # fresh copy of the frozen CURRENT snapshot, the same relocation every later
  # phase uses); a mismatched exit code means relocation itself -- not the
  # fixed-vs-broken content historical mode is trying to distinguish -- is
  # what changed the subject's behaviour, so refuse before spending the rest
  # of the run on a verdict that would not be trustworthy.
  if [ -n "$SUBJECT_MUST_BEHAVE" ]; then
    SMB_IN_TREE_CMD="${SUBJECT_MUST_BEHAVE//\{\}/$FILE}"
    SMB_IN_TREE_LOG="$SCRATCH/subject-must-behave-in-tree.log"
    SMB_IN_TREE_RC=0
    if run_guard subject-must-behave-in-tree "subject-must-behave (in-tree)" "$SMB_IN_TREE_CMD" "$SMB_IN_TREE_LOG"; then
      :
    else
      SMB_IN_TREE_RC=$?
    fi

    SMB_RELOCATED_LOG="$SCRATCH/subject-must-behave-relocated.log"
    SMB_RELOCATED_RC=0
    if run_snapshot_command subject-must-behave-relocated "subject-must-behave (relocated)" "$CURRENT_SNAPSHOT" "$SUBJECT_MUST_BEHAVE" "$SMB_RELOCATED_LOG"; then
      :
    else
      SMB_RELOCATED_RC=$?
    fi

    if [ "$SMB_IN_TREE_RC" != "$SMB_RELOCATED_RC" ]; then
      log "SUBJECT-MUST-BEHAVE MISMATCH: in-tree exit=$SMB_IN_TREE_RC, relocated exit=$SMB_RELOCATED_RC"
      printf 'MUTATION_PROBE_RESULT mode=historical verdict=harness-error expected=%s target=%s current_exit=-1 historical_exit=-1 calibration_current=-1 calibration_historical=-1 against_commit=%s subject_must_behave=mismatch in_tree_exit=%d relocated_exit=%d\n' \
        "$EXPECT" "$TARGET_MODE" "$HISTORICAL_SHA" "$SMB_IN_TREE_RC" "$SMB_RELOCATED_RC"
      die "the --subject-must-behave command behaves DIFFERENTLY against the exact same bytes depending on WHERE they sit -- in-tree exit=$SMB_IN_TREE_RC, relocated-to-scratch exit=$SMB_RELOCATED_RC.

      This is almost always a subject that resolves something relative to its
      OWN location (a \$0-relative sibling file, a sibling config/lib
      directory) rather than to the fixed-vs-broken CONTENT historical mode is
      trying to distinguish. Historical mode relocates every snapshot to a
      scratch directory before running --test, so a location-dependent subject
      is silently a DIFFERENT PROGRAM at that path -- most dangerously when it
      fails OPEN (no crash, just stops enforcing) instead of crashing outright,
      because that shape can make the current AND historical snapshots score
      identically and report a false 'survived' verdict that says nothing
      about the subject's actual fixed-vs-broken content (EI-21902332137059032).

      FIX: make the subject's location-relative resolution portable (copy or
      symlink its sibling directory alongside the frozen snapshot, or resolve
      siblings via an overridable env var or --file's own directory rather
      than \$0), then re-run. There is no --in-tree escape hatch for historical
      mode -- it is always copy-out (see --file's own header)."
    fi
    log "subject-must-behave: relocation-consistent (in-tree exit=$SMB_IN_TREE_RC, relocated exit=$SMB_RELOCATED_RC)"
  fi

  CURRENT_RC=0
  if run_snapshot_command baseline "current snapshot guard" "$CURRENT_SNAPSHOT" "$TEST_CMD" "$CURRENT_GUARD_LOG"; then
    :
  else
    CURRENT_RC=$?
    log "CURRENT FAILED (guard exited $CURRENT_RC) — refusing to score the historical source"
    printf 'MUTATION_PROBE_RESULT mode=historical verdict=harness-error expected=%s target=%s current_exit=%d historical_exit=-1 calibration_current=-1 calibration_historical=-1 against_commit=%s\n' \
      "$EXPECT" "$TARGET_MODE" "$CURRENT_RC" "$HISTORICAL_SHA"
    exit 2
  fi

  CURRENT_ZERO_SELECTION="$(detect_zero_selection "$CURRENT_GUARD_LOG")"
  if [ -n "$CURRENT_ZERO_SELECTION" ]; then
    printf 'MUTATION_PROBE_RESULT mode=historical verdict=harness-error expected=%s target=%s current_exit=%d historical_exit=-1 zero_selection=%s\n' \
      "$EXPECT" "$TARGET_MODE" "$CURRENT_RC" "$CURRENT_ZERO_SELECTION"
    die "the current snapshot guard selected no passing tests; refusing to score the historical source"
  fi

  CALIBRATION_CURRENT_RC=0
  if run_snapshot_command calibration-current "current snapshot calibration" "$CURRENT_SNAPSHOT" "$CALIBRATION_CMD" "$CALIBRATION_CURRENT_LOG"; then
    :
  else
    CALIBRATION_CURRENT_RC=$?
    log "CALIBRATION FAILED on current snapshot (exit $CALIBRATION_CURRENT_RC)"
    printf 'MUTATION_PROBE_RESULT mode=historical verdict=harness-error expected=%s target=%s current_exit=%d historical_exit=-1 calibration_current=%d calibration_historical=-1 against_commit=%s\n' \
      "$EXPECT" "$TARGET_MODE" "$CURRENT_RC" "$CALIBRATION_CURRENT_RC" "$HISTORICAL_SHA"
    exit 2
  fi

  CALIBRATION_HISTORICAL_RC=0
  if run_snapshot_command calibration-historical "historical snapshot calibration" "$HISTORICAL_SNAPSHOT" "$CALIBRATION_CMD" "$CALIBRATION_HISTORICAL_LOG"; then
    :
  else
    CALIBRATION_HISTORICAL_RC=$?
    log "CALIBRATION FAILED on historical snapshot (exit $CALIBRATION_HISTORICAL_RC) — the calibration must pass on the old source"
    printf 'MUTATION_PROBE_RESULT mode=historical verdict=harness-error expected=%s target=%s current_exit=%d historical_exit=-1 calibration_current=%d calibration_historical=%d against_commit=%s\n' \
      "$EXPECT" "$TARGET_MODE" "$CURRENT_RC" "$CALIBRATION_HISTORICAL_RC" "$CALIBRATION_CURRENT_RC" "$HISTORICAL_SHA"
    exit 2
  fi

  HISTORICAL_RC=0
  if run_snapshot_command historical "historical snapshot guard" "$HISTORICAL_SNAPSHOT" "$TEST_CMD" "$HISTORICAL_GUARD_LOG"; then
    :
  else
    HISTORICAL_RC=$?
  fi

  HISTORICAL_MISUSE_HITS="$(detect_runner_misuse "$HISTORICAL_GUARD_LOG")"
  if { [ "$HISTORICAL_RC" -eq 1 ] || [ "$HISTORICAL_RC" -eq 101 ]; } && [ -n "$HISTORICAL_MISUSE_HITS" ]; then
    log "the historical guard's own output shows a runner-MISUSE marker, not an assertion failure: ${HISTORICAL_MISUSE_HITS}"
    printf 'MUTATION_PROBE_RESULT mode=historical verdict=harness-error expected=%s target=%s current_exit=%d historical_exit=%d calibration_current=%d calibration_historical=%d against_commit=%s runner_misuse=%s\n' \
      "$EXPECT" "$TARGET_MODE" "$CURRENT_RC" "$HISTORICAL_RC" "$CALIBRATION_CURRENT_RC" "$CALIBRATION_HISTORICAL_RC" "$HISTORICAL_SHA" "${HISTORICAL_MISUSE_HITS// /,}"
    die "the historical guard run never reached its assertions — it failed for a RUNNER-MISUSE reason, not because the historical source was caught.

      Matched misuse marker(s): ${HISTORICAL_MISUSE_HITS}

      MOST COMMON CAUSE: the frozen historical snapshot lives under a scratch
      directory, and your --test command's runner cannot COLLECT a file there
      (a project's test-file include globs are usually relative to the repo
      root). Make --test able to run against an arbitrary path directly (e.g.
      \`npx vitest run {}\`) rather than relying on the runner's own
      project-relative file-discovery globs.

      Inspect the captured guard output above for the exact runner message."
  fi
  HISTORICAL_ASSERTION_EVIDENCE='exit-code-only'
  if [ "$HISTORICAL_RC" -eq 1 ] || [ "$HISTORICAL_RC" -eq 101 ]; then
    if HISTORICAL_ASSERTION_EVIDENCE="$(detect_assertion_failure_evidence "$HISTORICAL_GUARD_LOG")"; then
      :
    else
      HISTORICAL_ASSERTION_EVIDENCE_RC=$?
      if [ "$HISTORICAL_ASSERTION_EVIDENCE_RC" -eq 1 ]; then
        log "the historical test run exited $HISTORICAL_RC without assertion-level failure evidence: ${HISTORICAL_ASSERTION_EVIDENCE}"
        printf 'MUTATION_PROBE_RESULT mode=historical verdict=inconclusive expected=%s target=%s current_exit=%d historical_exit=%d calibration_current=%d calibration_historical=%d against_commit=%s assertion_evidence=%s\n' \
          "$EXPECT" "$TARGET_MODE" "$CURRENT_RC" "$HISTORICAL_RC" "$CALIBRATION_CURRENT_RC" "$CALIBRATION_HISTORICAL_RC" "$HISTORICAL_SHA" "$HISTORICAL_ASSERTION_EVIDENCE"
        die "the historical guard exited $HISTORICAL_RC, but a recognized test runner supplied no assertion-level failure evidence. A hook/setup error or skipped suite is not proof that the historical mutation was caught. Inspect the captured historical guard output and rerun only after the assertions execute."
      fi
      HISTORICAL_ASSERTION_EVIDENCE='exit-code-only'
    fi
  fi
  if is_assertion_failure_exit "$HISTORICAL_RC" "$HISTORICAL_ASSERTION_EVIDENCE"; then
    VERDICT="caught"
    log "VERDICT: HISTORICAL SOURCE CAUGHT (guard exited $HISTORICAL_RC) — the guard is falsifiable against the selected before-fix source ✓"
  elif [ "$HISTORICAL_RC" -eq 0 ]; then
    VERDICT="survived"
    log "VERDICT: HISTORICAL SOURCE SURVIVED (guard exited 0) — the guard does NOT constrain this historical source ✗"
  else
    VERDICT="harness-error"
    log "VERDICT: HARNESS ERROR (historical guard exited $HISTORICAL_RC) — no falsifiability verdict is sound"
  fi

  printf 'MUTATION_PROBE_RESULT mode=historical verdict=%s expected=%s target=%s current_exit=%d historical_exit=%d calibration_current=%d calibration_historical=%d against_commit=%s absence_control=%s positive_controls=%d destructive_primitives=%s assertion_evidence=%s\n' \
    "$VERDICT" "$EXPECT" "$TARGET_MODE" "$CURRENT_RC" "$HISTORICAL_RC" "$CALIBRATION_CURRENT_RC" "$CALIBRATION_HISTORICAL_RC" "$HISTORICAL_SHA" "$MUST_BE_ABSENT" "${#POSITIVE_CONTROLS[@]}" "${HISTORICAL_DESTRUCTIVE_HITS// /,}" "$HISTORICAL_ASSERTION_EVIDENCE"

  [ "$VERDICT" = "harness-error" ] && exit 2
  [ "$VERDICT" = "$EXPECT" ] || exit 1
  exit 0
fi

# --- copy-out relocation: mirror the REPO, not just the file -----------------
# (EI-21986396214443568, measured 2026-08-31) Copy-out used to drop the mutant
# into a FLAT scratch dir. That breaks two different couplings a subject can
# have to its own location, and only the first was ever named:
#
#   1. SIBLINGS — a relative `./lib/foo.mjs` import, the house pattern under
#      scripts/*.mjs.
#   2. LOCATIONAL IDENTITY — a subject that derives the repo root from its OWN
#      path (`resolve(dirname(fileURLToPath(import.meta.url)), '..')`, the
#      shape scripts/affected-tests.mjs uses). Relocated flat, it believes the
#      repo root IS the scratch dir, so behaviour tests fail for reasons that
#      have nothing to do with any mutation — a large, satisfying failure count
#      that reads as a spectacularly falsifiable guard. That is the same
#      false-verdict class this script exists to refuse, one layer out.
#
# Carrying the sibling DIRECTORY alongside the copy — the repair the
# copy-baseline refusal used to prescribe — fixes 1 and NOT 2, and 2 fails in
# the false-verdict direction. Mirroring the repo fixes both at once: every
# entry of the worktree, at every level of the subject's own path, is symlinked
# into a scratch tree, and the mutant is written at its TRUE repo-relative path
# inside it. Siblings resolve, and so does any number of `..` hops up to the
# root.
#
# .git is deliberately NOT mirrored. A symlinked .git would make the mirror
# read to Git as a catastrophically dirty worktree (every tracked path appears
# as a symlink where a blob belongs) — a SILENT wrong answer for any
# git-consulting subject. Its absence fails LOUDLY instead, and the
# copy-baseline gate below is what catches that.
mirror_link_siblings() {
  local real="$1" dir="$2" except="$3"
  local entry name
  for entry in "$real"/* "$real"/.[!.]* "$real"/..?*; do
    # An unmatched glob is left literal by bash; skip those.
    if [ ! -e "$entry" ] && [ ! -L "$entry" ]; then
      continue
    fi
    name="${entry##*/}"
    if [ "$name" = "$except" ] || [ "$name" = ".git" ]; then
      continue
    fi
    ln -s "$entry" "$dir/$name" || return 1
  done
  return 0
}

# Mirror worktree $1 into $3, materialising as REAL directories only the chain
# leading to $2 (a repo-relative file path); everything else at every level is
# a symlink. Leaves $3/$2 ABSENT — the caller writes the mutant copy there.
build_repo_mirror() {
  local root="$1" rel="$2" dest="$3"
  local dir="$dest" real="$root" remainder="$rel" component
  # An empty root would make mirror_link_siblings glob ""/* == /* and symlink
  # the whole filesystem into the scratch dir; an empty rel would leave the
  # mutant with nowhere to land. Neither is reachable from the caller's
  # guards, which is exactly why it is asserted here rather than assumed —
  # measured 2026-08-31 while mutating this function, where dropping the
  # caller-side guard produced precisely that filesystem-wide glob.
  case "$root" in /*) ;; *) return 1 ;; esac
  [ -d "$root" ] || return 1
  [ -n "$rel" ] || return 1
  case "$rel" in /*|*/) return 1 ;; esac
  mkdir -p "$dest" || return 1
  while [ "${remainder%%/*}" != "$remainder" ]; do
    component="${remainder%%/*}"
    remainder="${remainder#*/}"
    mirror_link_siblings "$real" "$dir" "$component" || return 1
    mkdir -p "$dir/$component" || return 1
    dir="$dir/$component"
    real="$real/$component"
  done
  # $remainder is now the file's own basename; everything beside it is a sibling.
  mirror_link_siblings "$real" "$dir" "$remainder" || return 1
  return 0
}

if [ "$IN_TREE" = "1" ]; then
  TARGET_MODE="in-tree:$SWEEP_ACK"
  log ""
  log "⚠️  --in-tree: the TRACKED file will be mutated in place."
  if [ "$SWEEP_ACK" = "lock-held" ]; then
    log "⚠️  Sweep: you declared a file lock on $(sweep_lock_path) HELD — git-sync will exclude that path."
    log "⚠️  The lock owner and path will be verified immediately before mutation."
    log "⚠️  git-sync re-checks locks after staging, so the file lock alone fences the sweep."
  else
    log "⚠️  Sweep: race ACCEPTED — nothing is holding git-sync off. If a tick lands"
    log "⚠️  during this run, the mutant is committed to the shared tree."
  fi
  log "⚠️  The trap closes the DEATH race (a kill mid-run); it cannot undo a commit."
  log "⚠️  Prefer copy-out mode (drop --in-tree) — it has no window at all."
  log ""
  TARGET="$FILE"
else
  TARGET_MODE="copy-out"
  # --- copy-out relocation, preferred form: a private mount OVERLAY -----------
  # (EI-24799401310241778, measured 2026-10-01) The repo mirror below symlinks
  # every non-subject entry back to the origin. Node and Vite REALPATH a module
  # before resolving its relative imports, so a SIBLING that is a symlink in the
  # mirror resolves to the origin tree and its `./subject` import loads the
  # ORIGINAL file. A test whose assertion path runs through such a sibling then
  # passes against the mutant: a false SURVIVED. Measured on
  # inference-gateway/credential-store.ts (reached via request-kernel.ts):
  # copy-out SURVIVED, the same mutation in-tree CAUGHT. The module-load control
  # cannot see it, because the test ALSO imports {} directly, so the mirrored
  # mutant does load; it is just not the copy the assertions exercise.
  #
  # Materialising the importers instead does not scale: credential-store.ts
  # alone has ~8,500 transitive relative importers, and no file set can redirect
  # a bare package specifier, a path alias or an absolute path.
  #
  # The overlay removes the relocation instead of repairing it. Each post-
  # baseline guard run executes in a private MOUNT NAMESPACE (bwrap) in which the
  # mutant copy is bind-mounted over the subject's own path. Every route to the
  # subject — direct, sibling, alias, package specifier, symlinked directory —
  # reaches the mutant, and siblings, `__dirname` roots and `.git` stay real. The
  # bind is invisible outside the namespace, so git-sync, peers and the tracked
  # file never see it: copy-out's no-dirty-window property is unchanged.
  #
  # Falls back to the repo mirror when bwrap cannot bind on this host (no user
  # namespaces), saying so, and every verdict line names the relocation used.
  if [ "$RELOCATION" != "mirror" ]; then
    OVERLAY_DEST="$(realpath -e -- "$FILE" 2>/dev/null || true)"
    mkdir -p "$SCRATCH/overlay" || die "could not create the overlay scratch dir"
    TARGET="$SCRATCH/overlay/$(basename "$FILE")"
    cp "$FILE" "$TARGET" || die "could not stage the probe copy"
    # Positive control, not just "bwrap ran": inside the namespace the subject's
    # own path must be the SAME inode as the scratch copy, or the bind did not
    # take and every verdict would be scored against the original.
    if [ -n "$OVERLAY_DEST" ] && command -v bwrap >/dev/null 2>&1 \
       && bwrap --dev-bind / / --bind "$TARGET" "$OVERLAY_DEST" --die-with-parent -- \
            bash -c '[ "$(stat -Lc %d:%i -- "$1")" = "$(stat -Lc %d:%i -- "$2")" ]' _ "$TARGET" "$OVERLAY_DEST" \
            2>"$SCRATCH/overlay-preflight.err"; then
      RELOCATION_USED="overlay"
      log "copy-out: overlay relocation — post-baseline guard runs see the mutant AT $FILE inside a private mount namespace (bwrap); the tracked file and every peer still see the original"
    else
      if [ "$RELOCATION" = "overlay" ]; then
        die "--relocation overlay was requested, but bwrap could not bind the scratch copy over $FILE on this host (user namespaces may be disabled):
      $(head -3 "$SCRATCH/overlay-preflight.err" 2>/dev/null)
      Drop --relocation to fall back to the repo mirror, or use the fenced --in-tree tier."
      fi
      log "⚠️  overlay relocation unavailable on this host ($(head -1 "$SCRATCH/overlay-preflight.err" 2>/dev/null || echo 'bwrap missing')) — falling back to the repo mirror."
      log "⚠️  The mirror can report a false SURVIVED when the test reaches the subject through a sibling module (EI-24799401310241778)."
      rm -f -- "$TARGET"
      OVERLAY_DEST=""
    fi
  fi
fi
if [ "$TARGET_MODE" = "copy-out" ] && [ "$RELOCATION_USED" != "overlay" ]; then
  COPY_OUT_ROOT="$(git -C "$(dirname "$FILE")" rev-parse --show-toplevel 2>/dev/null || true)"
  # A submodule can import hoisted dependencies from its superproject. Preserve
  # that enclosing path hierarchy too; mirroring only the inner Git root makes
  # the unchanged copy fail module resolution before the mutation is exercised.
  while [ -n "$COPY_OUT_ROOT" ]; do
    COPY_OUT_PARENT="$(git -C "$COPY_OUT_ROOT" rev-parse --show-superproject-working-tree 2>/dev/null || true)"
    [ -n "$COPY_OUT_PARENT" ] || break
    case "$COPY_OUT_ROOT" in
      "$COPY_OUT_PARENT"/*) COPY_OUT_ROOT="$COPY_OUT_PARENT" ;;
      *) break ;;
    esac
  done
  COPY_OUT_REL=""
  if [ -n "$COPY_OUT_ROOT" ]; then
    case "$FILE" in
      "$COPY_OUT_ROOT"/*) COPY_OUT_REL="${FILE#"$COPY_OUT_ROOT"/}" ;;
    esac
  fi
  if [ -n "$COPY_OUT_REL" ]; then
    COPY_OUT_MIRROR="$SCRATCH/mirror"
    build_repo_mirror "$COPY_OUT_ROOT" "$COPY_OUT_REL" "$COPY_OUT_MIRROR" \
      || die "could not build the copy-out repo mirror under $COPY_OUT_MIRROR"
    TARGET="$COPY_OUT_MIRROR/$COPY_OUT_REL"
    RELOCATION_USED="mirror"
    log "copy-out: relocating into a repo mirror — $COPY_OUT_ROOT symlinked into $COPY_OUT_MIRROR (.git excluded), mutant at its own repo-relative path $COPY_OUT_REL"
  else
    # Not inside a worktree, so there is no repo shape to mirror. Flat
    # relocation, exactly as before — the copy-baseline gate below still
    # refuses a relocation that breaks the subject.
    TARGET="$SCRATCH/$(basename "$FILE")"
    RELOCATION_USED="flat"
  fi
  cp "$FILE" "$TARGET" || die "could not stage the probe copy"
fi
[ -n "$RELOCATION_USED" ] || RELOCATION_USED="none"
readonly TARGET_MODE RELOCATION_USED OVERLAY_DEST
# What {} names in every post-baseline guard run. Under the overlay the mutant is
# visible AT the subject's own path, so {} stays the real path; a relocated copy
# is named by its scratch path.
if [ "$RELOCATION_USED" = "overlay" ]; then
  GUARD_SUBJECT="$FILE"
else
  GUARD_SUBJECT="$TARGET"
fi
readonly GUARD_SUBJECT

# Validate the expression and its exact output before either baseline guard.
# Recheck the applied mutant below: stateful Perl expressions must not turn a
# valid preflight into an ineffective mutation after the baseline has run.
verify_mutation_bytes() {
  local candidate="$1"
  if cmp -s "$candidate" "$BASE"; then
    die "the --mutate expression changed NOTHING (mutant is byte-identical to the original).
      A no-op mutation makes any guard look weak. Fix the expression and re-run.

      MOST COMMON CAUSE: --mutate is a PERL expression (applied as perl -pi -e), so
      ( ) { } + ? . * are REGEX METACHARACTERS on the PATTERN side, not literal text.
      This bites hardest on the normal use of this script — mutating source code —
      because a natural-looking mutation of a conditional or a call matches nothing:

          WRONG:  's|if (x > 0) {|if (false) {|'
                        ^      ^ ^   ( ) capture a group, { starts a quantifier,
                                     so this searches for 'if x > 0 ' and misses.
          RIGHT:  's|if \(x > 0\) \{|if (false) {|'

      Only the PATTERN (left) side needs escaping — the replacement is literal."
  fi
  tr -d '[:space:]' < "$candidate" > "$SCRATCH/mutant.non-whitespace" || die "could not normalize the mutant"
  if cmp -s "$SCRATCH/mutant.non-whitespace" "$BASE_NON_WHITESPACE"; then
    die "the --mutate expression changed ONLY WHITESPACE (non-whitespace content is unchanged).
      A whitespace-only mutation can leave behavior unchanged and make any guard
      look weak. Inspect the mutation expression, then fix it so it
      changes the intended non-whitespace token and re-run."
  fi
}

if ! perl -Mstrict -pe "$MUTATE" "$BASE" > "$SCRATCH/preflight-mutant" 2>"$SCRATCH/strict-err"; then
  die "the --mutate expression does not compile under 'use strict' — refusing before mutating anything.
      perl said: $(head -3 "$SCRATCH/strict-err" 2>/dev/null)

      MOST COMMON CAUSE: a bare \$name in the REPLACEMENT half. perl INTERPOLATES
      the replacement, so \$name there is a PERL VARIABLE — and if it is undefined
      it becomes silently EMPTY (that exact silent-empty widened a delete loop to
      'for d in /*' on 2026-08-15). If you meant the literal text \$name — e.g. the
      subject is a SHELL script and \$name is one of ITS variables — escape it on
      the replacement side too: s/match/\\\$name/. Special vars (\$1, \$&) are fine."
fi
verify_mutation_bytes "$SCRATCH/preflight-mutant"

# A nonzero baseline means the command did not establish a runnable, healthy
# guard before the mutation. Scoring the mutant's later nonzero exit as
# "caught" would turn a broken harness into falsifiability evidence.
BASE_CMD="${TEST_CMD//\{\}/$FILE}"
BASELINE_LOG="$SCRATCH/baseline.log"
MUTANT_LOG="$SCRATCH/mutant.log"
BASELINE_RC=0
# Check the in-tree session/lock fence before an expensive baseline can run.
# Keep the second check immediately before mutation to refresh the lease and
# catch a lock that changed while the baseline was running.
if [ "$IN_TREE" -eq 1 ] && [ "$SWEEP_ACK" = "lock-held" ]; then
  verify_sweep_fence
fi
if run_guard baseline "baseline guard" "$BASE_CMD" "$BASELINE_LOG"; then
  :
else
  BASELINE_RC=$?
  log "BASELINE FAILED (guard exited $BASELINE_RC) — refusing to score the mutant"
  printf 'MUTATION_PROBE_RESULT verdict=harness-error expected=%s target=%s baseline_exit=%d guard_exit=-1\n' \
    "$EXPECT" "$TARGET_MODE" "$BASELINE_RC"
  exit 2
fi

# A baseline that exits 0 having run NO tests is not a healthy guard — it is a
# command that selects nothing, and every verdict downstream of it is void.
# See detect_zero_selection above for the measured discriminator and for why
# this is checked here (baseline) and nowhere else.
BASELINE_ZERO_SELECTION="$(detect_zero_selection "$BASELINE_LOG")"
if [ -n "$BASELINE_ZERO_SELECTION" ]; then
  log "BASELINE RAN ZERO TESTS ($BASELINE_ZERO_SELECTION) — refusing to score the mutant"
  printf 'MUTATION_PROBE_RESULT verdict=harness-error expected=%s target=%s baseline_exit=%d guard_exit=-1 zero_selection=%s\n' \
    "$EXPECT" "$TARGET_MODE" "$BASELINE_RC" "${BASELINE_ZERO_SELECTION// /_}"
  die "the baseline guard exited 0 without running a single test — its own summary says: $BASELINE_ZERO_SELECTION

      The guard COMMAND selects nothing, so no falsifiability verdict is
      possible. This is a MISUSE of the probe, not a weak guard: had it been
      scored, every mutant would have \"survived\" and the probe would have
      told you a guard you just wrote is worthless.

      The usual cause is a --test command whose NAME filter matches no test.
      With vitest, \`-t\` matches against the test name only and does NOT
      accept the 'describe > test' path form — the very form that looks
      natural when two describe blocks hold identically-named tests, which is
      exactly when you reach for a qualified filter. Check the filter by
      running your --test command by hand first: it must report at least one
      PASSED test against the unmutated file.

      Note this is NOT the same as \"No test files found\" (that exits 1 and
      is caught by the runner-misuse leg); here the file was found and the
      tests inside it were all deselected."
fi

# --- copy-baseline: prove the RELOCATION survives before scoring anything --
# (EI-21884666893062196, measured 2026-08-30) Copy-out mode moves the subject
# to a scratch dir before mutating it. A subject with a relative SIBLING
# import (the `./lib/...` house pattern under scripts/*.mjs) is broken by that
# relocation alone — it dies on ERR_MODULE_NOT_FOUND before the guard runs a
# single assertion. That failure is exit 1, the SAME code the mutant phase
# reads as "caught", so a broken relocation silently reports "the guard is
# falsifiable" without the guard ever having run.
#
# Prove the guard survives relocation BEFORE mutating anything: run it again
# against the UNMUTATED copy sitting at the exact path the mutant will occupy.
# It already passed in-tree (the baseline check above required that), so it
# must also pass here — anything else means the relocation broke the subject,
# not that a mutation was caught (there isn't one yet). In-tree mode never
# relocates the subject at all, so this check applies to copy-out only.
if [ "$TARGET_MODE" = "copy-out" ]; then
  COPY_BASELINE_CMD="${TEST_CMD//\{\}/$GUARD_SUBJECT}"
  COPY_BASELINE_LOG="$SCRATCH/copy-baseline.log"
  COPY_BASELINE_RC=0
  if run_guard copy-baseline "unmutated-copy baseline guard" "$COPY_BASELINE_CMD" "$COPY_BASELINE_LOG"; then
    :
  else
    COPY_BASELINE_RC=$?
    log "COPY-BASELINE FAILED (guard exited $COPY_BASELINE_RC against the UNMUTATED relocated copy) — refusing to score the mutant"
    printf 'MUTATION_PROBE_RESULT verdict=harness-error expected=%s target=%s baseline_exit=%d guard_exit=-1 copy_baseline_exit=%d relocation=%s\n' \
      "$EXPECT" "$TARGET_MODE" "$BASELINE_RC" "$COPY_BASELINE_RC" "$RELOCATION_USED"
    if [ "$RELOCATION_USED" = "overlay" ]; then
      die "the guard failed inside the overlay namespace against an UNMUTATED copy bound over $FILE, even though the SAME guard passed outside it (baseline_exit=$BASELINE_RC, this run's exit=$COPY_BASELINE_RC).

      There is no mutation applied yet, so this is the NAMESPACE, not a caught
      mutant. The overlay keeps every path, sibling and .git real, so the usual
      causes are things a private mount namespace changes:

        - the guard needs privilege (sudo / setuid) — no_new_privs blocks it;
        - the guard writes to the subject path itself (the bound copy is a
          scratch file, so writes land there, not in the tree);
        - the guard depends on a process started OUTSIDE the namespace that
          reads the subject (a long-running server, a systemd service unit).

      Inspect the captured guard output above (copy-baseline phase). FIX:
      --relocation mirror relocates the copy instead of overlaying it, or run
      the probe with --in-tree."
    fi
    die "the guard failed against an UNMUTATED copy relocated to $TARGET, even though the SAME guard passed in-tree (baseline_exit=$BASELINE_RC, this run's exit=$COPY_BASELINE_RC).

      This is almost always the RELOCATION breaking the subject, not a caught
      mutant — there is no mutation applied yet. Scoring it as a caught mutant
      would report falsifiability this probe never demonstrated.

      A subject INSIDE a Git worktree is already relocated into a MIRROR of
      that worktree, at its own repo-relative path (see 'copy-out: relocating
      into a repo mirror' above), so relative SIBLING imports and a
      \`__dirname\`-derived repo root both still resolve. If you still landed
      here, the remaining causes are:

        - the subject is NOT inside a worktree, so there was no repo shape to
          mirror and the copy is flat (no 'repo mirror' line above). Give it a
          worktree, or point --test at the subject's real in-tree directory;
        - the subject consults \`.git\`, which is deliberately NOT mirrored (a
          symlinked .git makes the mirror read as a wholly dirty worktree —
          a silent wrong answer, which is why this fails loudly instead);
        - the subject reads an absolute path, or state outside the worktree.

      Inspect the captured guard output above (copy-baseline phase) for the
      exact failure — a module-resolution or file-not-found error confirms
      relocation, not mutation.

      FIX: make the subject's out-of-worktree dependency overridable (an env
      var or an argument the guard can point at the real in-tree location),
      or run the probe with --in-tree."
  fi
fi

# Keep an exact in-tree mutant snapshot outside the dirty window. Cleanup may
# restore the tracked file only if it still matches this byte-for-byte result.
if [ "$IN_TREE" -eq 1 ]; then
  perl -pe "$MUTATE" "$BASE" > "$PROBE_MUTANT_FILE" ||
    die "could not stage the expected in-tree mutant snapshot"
  PROBE_MUTANT_SUM="$(git hash-object "$PROBE_MUTANT_FILE")" ||
    die "could not hash the expected in-tree mutant snapshot"
fi

# --- apply the mutation -----------------------------------------------------
if [ "$IN_TREE" -eq 1 ] && [ "$SWEEP_ACK" = "lock-held" ]; then
  verify_sweep_fence
fi
if [ "$IN_TREE" -eq 1 ]; then
  current_before_mutation="$(git hash-object "$FILE" 2>/dev/null)" ||
    die "could not verify the tracked file before mutation; refusing to edit it"
  if [ "$current_before_mutation" != "$ORIG_SUM" ]; then
    log "tracked file changed after the probe snapshot; refusing to apply the in-tree mutation."
    printf 'MUTATION_PROBE_RESULT verdict=harness-error expected=%s target=%s baseline_exit=%d source_sha=%s current_sha=%s\n' \
      "$EXPECT" "$TARGET_MODE" "$BASELINE_RC" "$ORIG_SUM" "$current_before_mutation"
    die "the tracked file no longer matches the pre-probe snapshot; no in-tree mutation was applied."
  fi
fi
perl -pi -e "$MUTATE" "$TARGET" || die "mutation command failed"
if [ "$IN_TREE" -eq 1 ]; then
  PROBE_MUTATION_APPLIED=1
fi

# Show the exact mutation before running the guard. This makes an accidental
# match in indentation/comments visible immediately instead of being inferred
# from a misleading falsifiability verdict. diff returns 1 for a real diff,
# so its nonzero status is intentionally ignored.
log "mutation diff (first 40 lines):"
diff -u -- "$BASE" "$TARGET" | sed -n '1,40p' || true

# A mutation that matched NOTHING is the quiet killer of this whole technique:
# the "mutant" is identical to the original, so the guard passes, and the
# probe reports "the guard did not catch it" — a FALSE weakness verdict from a
# probe that never actually mutated anything. Refuse rather than report it.
verify_mutation_bytes "$TARGET"
# A mutant that no longer PARSES is the same false-verdict class as the two
# checks above, wearing a far more convincing costume. The guard does fail --
# but it fails because the subject stopped being a loadable program, not
# because the assertions detect the behaviour change. The probe then prints
# "MUTANT CAUGHT ... the guard is falsifiable" about assertions it never
# exercised, and that verdict line is exactly what gets quoted as evidence.
#
# Observed (EI-21430792829614962): mutating a .mjs hook with
#   s/isTunnelForward\(addrs, port\)/false/
# also matched the FUNCTION DECLARATION, yielding 'function false {'. Every
# spawn of the subject died at ESM load, the suite went red, and the probe
# reported a clean catch. The only tell was a loader trace buried in the
# captured output; MUTATION_PROBE_RESULT itself read as a genuine catch.
#
# This is the inverse of the no-op refusal above and belongs beside it: a
# mutation that changed NOTHING makes a guard look weak, a mutation that
# changed the file into a NON-PROGRAM makes a guard look strong. Both are
# false verdicts from a probe that never tested what it claims to have tested.
#
# Only the MUTANT is checked, for two independent reasons:
#   1. The baseline gate above already ran the guard against the unmutated
#      $FILE and refused to continue unless it passed, so the original is
#      established as a valid program. A second check would be redundant.
#   2. $BASE carries a '.orig' suffix, and extension-dispatched checkers judge
#      the SAME BYTES differently because of it -- node reads .mjs as a module
#      and .mjs.orig as a script, so every ESM subject's imports would fail
#      spuriously. $TARGET always keeps the real basename, so it is the only
#      sound thing to check.
#
# A checker that is absent must NEVER manufacture a refusal, so a missing
# interpreter degrades to unchecked rather than to broken. Unknown extensions
# degrade the same way and are stamped mutant_parse=unchecked on
# MUTATION_PROBE_RESULT, so the evidence line carries its own caveat instead
# of reading clean.
MUTANT_PARSE="unchecked"
MUTANT_PARSE_ERR="$SCRATCH/mutant-parse.err"
case "$FILE" in
  *.mjs|*.cjs|*.js)
    if ! command -v node >/dev/null 2>&1; then
      MUTANT_PARSE="unchecked-no-node"
    elif node --check "$TARGET" >/dev/null 2>"$MUTANT_PARSE_ERR"; then
      MUTANT_PARSE="ok"
    else
      MUTANT_PARSE="broken"
    fi
    ;;
  *.sh|*.bash)
    if bash -n "$TARGET" 2>"$MUTANT_PARSE_ERR"; then
      MUTANT_PARSE="ok"
    else
      MUTANT_PARSE="broken"
    fi
    ;;
esac
if [ "$MUTANT_PARSE" = "broken" ]; then
  log "the mutant no longer PARSES as a program. Parser said:"
  sed -n '1,5p' "$MUTANT_PARSE_ERR" >&2 || true
  printf 'MUTATION_PROBE_RESULT verdict=harness-error expected=%s target=%s baseline_exit=%d guard_exit=-1 mutant_parse=broken\n' \
    "$EXPECT" "$TARGET_MODE" "$BASELINE_RC"
  die "the --mutate expression produced a mutant that is not a valid program — refusing to score it.

      Your guard would have failed on this mutant no matter what it asserts,
      so scoring it would report falsifiability the probe never demonstrated.
      This is a MISUSE of the probe, not a weak guard and not a caught mutant.

      MOST COMMON CAUSE: the pattern matched MORE THAN THE INTENDED SITE —
      typically a function's DECLARATION as well as its CALL SITE, which turns
      'function name(...)' into something like 'function false {'. Anchor the
      pattern on text the declaration cannot match:

          WRONG:  's/isTunnelForward\(addrs, port\)/false/'
          RIGHT:  's/if \(isTunnelForward/if (false \&\& isTunnelForward/'

      Inspect the mutation diff printed above — it shows every line that
      changed, which is where an over-broad match becomes obvious.

      RELATED HABIT: read WHICH tests failed, not just the verdict line. A
      genuine semantic mutant fails a PROPER SUBSET of the suite; a mutant that
      cannot load fails everything indiscriminately."
fi

# Keep the DIRTY window free of command substitutions. A SIGTERM that landed
# inside the old nested hash-object substitutions could make Bash abort trap
# parsing with an unmatched closing parenthesis; finish() then never ran and
# the tracked mutant stayed behind. ORIG_SUM is already available, and the
# exact mutant hash is diagnostic convenience rather than integrity evidence.
log "mutant applied: ${ORIG_SUM:0:8} -> changed ($TARGET_MODE)"

# --- run the guard against the mutant --------------------------------------
CMD="${TEST_CMD//\{\}/$GUARD_SUBJECT}"
run_guard mutant "mutant guard" "$CMD" "$MUTANT_LOG"
TEST_RC=$?

# A guard is falsifiable when it FAILS on the mutant. Report the verdict in
# those terms rather than leaking the raw exit code, because "the probe
# succeeded" and "the test passed" mean OPPOSITE things here and conflating
# them is its own error class. Exit 1 is the test/guard failure convention;
# Cargo/libtest exit 101 requires executed-test evidence; other nonzero
# statuses mean the harness did not produce a trustworthy verdict.
MUTANT_MISUSE_HITS="$(detect_runner_misuse "$MUTANT_LOG")"
if { [ "$TEST_RC" -eq 1 ] || [ "$TEST_RC" -eq 101 ]; } && [ -n "$MUTANT_MISUSE_HITS" ]; then
  log "the mutant guard's own output shows a runner-MISUSE marker, not an assertion failure: ${MUTANT_MISUSE_HITS}"
  printf 'MUTATION_PROBE_RESULT verdict=harness-error expected=%s target=%s baseline_exit=%d guard_exit=%d mutant_parse=%s runner_misuse=%s\n' \
    "$EXPECT" "$TARGET_MODE" "$BASELINE_RC" "$TEST_RC" "$MUTANT_PARSE" "${MUTANT_MISUSE_HITS// /,}"
  die "the mutant guard run never reached its assertions — it failed for a RUNNER-MISUSE reason, not because the mutation was detected.

      Matched misuse marker(s): ${MUTANT_MISUSE_HITS}

      MOST COMMON CAUSE (copy-out mode): the mutated COPY lives under a
      scratch directory (e.g. /tmp/mutation-probe.XXXXXX), and your --test
      command's runner cannot COLLECT a file there — a project's test-file
      include globs are usually relative to the repo root, so a path outside
      it silently matches nothing. A command exiting 1 for 'no tests ran' is
      INDISTINGUISHABLE by exit code alone from a genuine assertion failure,
      so this script refuses to credit it as a caught mutant.

      FIX: make --test able to run against an ARBITRARY path directly (e.g.
      \`npx vitest run {}\` rather than a bare \`npm test\` that globs from the
      project root), or point the runner's config/root at the scratch
      directory for this one invocation.

      Inspect the captured guard output above for the exact runner message."
fi

MUTANT_ASSERTION_EVIDENCE='exit-code-only'
if [ "$TEST_RC" -eq 1 ] || [ "$TEST_RC" -eq 101 ]; then
  if MUTANT_ASSERTION_EVIDENCE="$(detect_assertion_failure_evidence "$MUTANT_LOG")"; then
    :
  else
    MUTANT_ASSERTION_EVIDENCE_RC=$?
    if [ "$MUTANT_ASSERTION_EVIDENCE_RC" -eq 1 ]; then
      log "the mutant test run exited $TEST_RC without assertion-level failure evidence: ${MUTANT_ASSERTION_EVIDENCE}"
      printf 'MUTATION_PROBE_RESULT verdict=inconclusive expected=%s target=%s baseline_exit=%d guard_exit=%d mutant_parse=%s assertion_evidence=%s\n' \
        "$EXPECT" "$TARGET_MODE" "$BASELINE_RC" "$TEST_RC" "$MUTANT_PARSE" "$MUTANT_ASSERTION_EVIDENCE"
      die "the mutant guard exited $TEST_RC, but a recognized test runner supplied no assertion-level failure evidence. A hook/setup error or skipped suite is not proof that the mutation was caught. Inspect the captured guard output and rerun only after the assertions execute."
    fi
    MUTANT_ASSERTION_EVIDENCE='exit-code-only'
  fi
fi

# A passing copy-out test does not prove it ever imported the mutant. The repo
# mirror symlinks test files/configs; Node/Vite can realpath a symlinked test
# before resolving its relative imports, sending them back to the real tree.
# An unmutated-copy baseline cannot detect this (both paths behave identically).
# On a JS/TS module that "survived", replace only the SCRATCH copy with a
# distinctive top-level throw and rerun the SAME command. Credit survival only
# if this run fails AND prints the thrown marker: a generic runner error is not
# evidence that the module was loaded. Never touch the tracked source.
if [ "$TARGET_MODE" = "copy-out" ] && [ "$TEST_RC" -eq 0 ]; then
  case "$FILE" in
    *.js|*.jsx|*.mjs|*.cjs|*.ts|*.tsx|*.mts|*.cts)
      LOAD_MARKER="PAPERCUSP_MUTATION_TARGET_LOADED_CHECK"
      LOAD_LOG="$SCRATCH/load-check.log"
      cp -- "$TARGET" "$SCRATCH/mutant-before-load-check" \
        || die "cannot preserve scratch mutant for the module-load control"
      printf 'throw new Error("%s");\n' "$LOAD_MARKER" > "$TARGET" \
        || die "cannot install module-load control in scratch copy"
      run_guard load-check "module-load control" "$CMD" "$LOAD_LOG"
      LOAD_RC=$?
      cp -- "$SCRATCH/mutant-before-load-check" "$TARGET" \
        || die "cannot restore scratch mutant after module-load control"
      if [ "$LOAD_RC" -eq 0 ] || ! grep -Fq "$LOAD_MARKER" "$LOAD_LOG"; then
        printf 'MUTATION_PROBE_RESULT verdict=harness-error expected=%s target=%s baseline_exit=%d guard_exit=%d module_loaded=no relocation=%s\n' \
          "$EXPECT" "$TARGET_MODE" "$BASELINE_RC" "$TEST_RC" "$RELOCATION_USED"
        if [ "$RELOCATION_USED" = "overlay" ]; then
          die "the mutated module was not loaded by --test: the copy bound over $FILE threw a distinctive marker, but the same guard did not fail with that marker.

      Under the overlay EVERY route to $FILE inside the namespace reaches the
      copy, so the guard either never loads this module at all, or loads it in
      a process started OUTSIDE the namespace (a daemon, a systemd service
      unit, a server the test talks to). A survived verdict would be false.
      Point --test at a command that loads the subject itself, or use the
      fenced --in-tree tier."
        fi
        die "the mutated module was not loaded by --test: the scratch copy threw a distinctive marker, but the same guard did not fail with that marker.

      A symlinked test/config in the copy-out mirror may resolve imports against
      the REAL tree (not the mutant). A survived verdict would be false. Make
      the guard import {} directly from the mirror, or use the fenced --in-tree
      tier when that test runner cannot load mirrored modules."
      fi
      ;;
  esac
fi

if is_assertion_failure_exit "$TEST_RC" "$MUTANT_ASSERTION_EVIDENCE"; then
  VERDICT="caught"
  log "VERDICT: MUTANT CAUGHT (guard exited $TEST_RC) — the guard is falsifiable ✓"
elif [ "$TEST_RC" -eq 0 ]; then
  VERDICT="survived"
  log "VERDICT: MUTANT SURVIVED (guard exited 0) — the guard does NOT constrain this mutation ✗"
  if [ "$RELOCATION_USED" = "mirror" ] || [ "$RELOCATION_USED" = "flat" ]; then
    # EI-24799401310241778: a relocated copy can survive for a reason that is
    # not the guard's — a sibling that realpaths back to the origin loads the
    # ORIGINAL subject. The overlay has no such route; say which one ran.
    log "⚠️  relocation=$RELOCATION_USED: a test that reaches the subject through a SIBLING module (or an alias/package specifier) loads the ORIGINAL file here, so this survival may be the relocation's, not the guard's. Re-run where bwrap can bind (--relocation overlay) or with the fenced --in-tree tier before calling the guard weak."
  fi
else
  VERDICT="harness-error"
  log "VERDICT: HARNESS ERROR (guard exited $TEST_RC) — no falsifiability verdict is sound"
fi

# mutant_parse travels WITH the verdict, because this line is what gets quoted
# as evidence. 'ok' means the mutant was confirmed to still be a loadable
# program, so a caught verdict is about the assertions; 'unchecked*' means no
# checker applied to this subject and the caught verdict carries that caveat.
printf 'MUTATION_PROBE_RESULT verdict=%s expected=%s target=%s baseline_exit=%d guard_exit=%d mutant_parse=%s assertion_evidence=%s relocation=%s\n' \
  "$VERDICT" "$EXPECT" "$TARGET_MODE" "$BASELINE_RC" "$TEST_RC" "$MUTANT_PARSE" "$MUTANT_ASSERTION_EVIDENCE" "$RELOCATION_USED"

[ "$VERDICT" = "harness-error" ] && exit 2
[ "$VERDICT" = "$EXPECT" ] || exit 1
exit 0
