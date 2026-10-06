# vh.sh — verification-harness helper for SHELL harnesses. Source it; do not execute it.
#
#   source libs/generic/verification-harness/bin/vh.sh
#   vh_phase setup "" 1              # id, comma-separated deps, reusable (1/0) — declaration order
#   vh_phase leg-a setup
#   vh_phase leg-b setup
#   vh_scope hive-git physical-drill # optional: guard-rail scope tags (see vh_preflight)
#   vh_init my-drill "$EVIDENCE_ROOT" "$@"   # consumes --only/--from/--reuse; VH_ARGS = the rest
#   vh_preflight check_rig           # optional: a failure blocks every phase; with scope tags it
#                                    # also runs the matching guard-rail probes (VH_GUARD_RAIL_SOURCE)
#   vh_run setup  phase_setup        # each phase is a function
#   vh_run leg-a  phase_leg_a
#   vh_run leg-b  phase_leg_b
#   vh_finish                        # prints HARNESS_RESULT, returns 0 on pass
#
# Inside a phase function: `vh_step <label>` marks progress; `vh_fail <reasonCode> [detail]`
# records the failure (then `return`). A non-zero return without vh_fail is recorded as
# reasonCode exit-<rc>. vh_run calls the function in an `||` list, so errexit is suspended
# inside it: check each command explicitly. A later phase still runs after a failure unless
# it depends on the failed phase (never-abort). Each phase gets "$VH_PHASE_DIR" for evidence.
# Selection rules and the result schema live in src/cli.ts (TS), shared with the TS runner.
# Needs bash >= 4.2 (associative arrays, declare -g): run it on the Linux side, never under
# the macOS stock /bin/bash 3.2.
#
# BRACKET MODE — for a long LINEAR script whose phases are top-level sections, not functions.
# Wrapping a `set -e` section in vh_run would suspend errexit inside it (the `||` context), so
# such a script marks section boundaries instead and keeps its own abort semantics:
#
#   vh_phase preflight ""            # declare a dependency chain, one phase per section
#   vh_phase build preflight
#   vh_phase publish build
#   vh_init release "$ROOT"          # no selection flags forwarded: every phase runs
#   vh_bracket_trap                  # or call `vh_exit "$rc"` first thing in your own EXIT handler
#   vh_begin preflight               # closes the open phase as passed and opens this one
#   ...
#   vh_begin build
#   ...
#   [ "$PRECHECK_ONLY" = 1 ] && { vh_skip_rest precheck-only; exit 0; }
#   vh_begin publish
#   ...                              # the EXIT trap (or `vh_exit 0`) finalizes
#
# On exit with rc != 0 the open phase is failed (reasonCode from vh_fail, else exit-<rc>, with
# the last vh_step) and every phase not yet begun is blocked (reason aborted:<phase>:exit-<rc>).
# On rc 0 the open phase passes; a phase never begun stays failed/not-reported unless
# `vh_skip_rest <reason>` declared the early exit. vh_begin returns 1 when the phase must not
# run (not selected, reused, preflight or a dependency failed); a script that forwards
# selection flags guards the section with `if vh_begin x; then …; fi`.
#
# Knobs: VH_LOG_FD=2 sends the VH_* progress lines and the HARNESS_RESULT line to stderr (use it
# when stdout carries the harness's own payload). VH_DISABLE=1 turns every vh_* call into a no-op
# that lets the phase run. VH_FAIL_OPEN=1 does the same, loudly (a VH_DISABLED line), when the
# contract itself cannot start (no tsx, unwritable evidence root), so instrumentation can never
# block the harness it instruments. VH_KEEP_RUNS bounds the retained run dirs (default 30).

VH_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# vh_converge: wait for a cross-host observation to converge instead of reading it once.
# shellcheck source=converge.sh
source "$VH_LIB_DIR/bin/converge.sh"
declare -ga VH_PHASE_IDS=() VH_SCOPE_TAGS=()
declare -gA VH_DEPS=() VH_REUSABLE=() VH_ACTION=() VH_REUSE_FROM=() VH_STATUS=()
VH_PREFLIGHT_FAILED=0
VH_PREFLIGHT_DONE=0
VH_PREFLIGHT_FN=""
VH_DISABLED=0
[ "${VH_DISABLE:-0}" = 1 ] && VH_DISABLED=1
VH_OPEN_PHASE=""
VH_OPEN_T0=""
VH_OPEN_S0=""
VH_SKIP_REST=""
VH_FINALIZED=0
VH_MAIN_PID="${BASHPID:-$$}"
# Initialized so a `set -u` caller can never trip on them; evidence writes below are non-fatal
# so a `set -e` caller can never be aborted by its own instrumentation.
VH_CUR_PHASE="" VH_CUR_STEP="" VH_CUR_FAIL="" VH_CUR_DETAIL="" VH_DISABLED_FAILED=0

_vh_say() {
  if [ "${VH_LOG_FD:-1}" = 2 ]; then printf '%s\n' "$*" >&2; else printf '%s\n' "$*"; fi
}

_vh_disable() { # <reason>
  VH_DISABLED=1
  printf 'VH_DISABLED harness=%s reason=%s (the harness runs uninstrumented; no HARNESS_RESULT)\n' \
    "${VH_NAME:-?}" "$1" >&2
}

_vh_tsx() {
  if [ -n "${VH_TSX:-}" ]; then echo "$VH_TSX"; return; fi
  local d="$VH_LIB_DIR"
  while [ "$d" != "/" ]; do
    [ -x "$d/node_modules/.bin/tsx" ] && { echo "$d/node_modules/.bin/tsx"; return; }
    d="$(dirname "$d")"
  done
  echo tsx
}

_vh_json_str() {
  local s="${1//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/ }"; s="${s//$'\r'/ }"; s="${s//$'\t'/ }"
  printf '"%s"' "$s"
}

_vh_now() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ; }
_vh_ms() { date -u +%s%3N; }

# Run a shared-checkout reader under mutation-probe admission. The shared lock
# prevents a probe from publishing/removing its manifest during the read; when
# a live probe is already active, bwrap overlays the validated original bytes
# so the reader sees the source tree as it was before the temporary mutant.
# Usage: vh_probe_admitted_exec <repo-root> -- <command...>
vh_probe_admitted_exec() {
  local root="${1:-}"
  [ "$#" -ge 3 ] || { echo "vh_probe_admitted_exec: expected <repo-root> -- <command...>" >&2; return 2; }
  shift
  [ "$1" = "--" ] || { echo "vh_probe_admitted_exec: missing --" >&2; return 2; }
  shift
  root="$(realpath -e -- "$root")" || { echo "vh_probe_admitted_exec: missing checkout" >&2; return 2; }

  local key directory lock manifest admission_fd status helper
  key="$(printf '%s' "$root" | sha256sum | cut -d' ' -f1)" || return 2
  directory="/tmp/papercusp-mutation-probe-$(id -u)-$key"
  mkdir -p -m 700 -- "$directory" || { echo "vh_probe_admitted_exec: cannot create admission directory" >&2; return 2; }
  lock="$directory/admission.lock"
  manifest="$directory/original.manifest"
  exec {admission_fd}>"$lock" || { echo "vh_probe_admitted_exec: cannot open admission lock" >&2; return 2; }
  flock -s "$admission_fd" || {
    exec {admission_fd}>&-
    echo "vh_probe_admitted_exec: cannot acquire admission lock" >&2
    return 2
  }

  if [ ! -e "$manifest" ]; then
    if "$@"; then status=0; else status=$?; fi
    flock -u "$admission_fd" || true
    exec {admission_fd}>&-
    return "$status"
  fi

  helper="$(cd "$VH_LIB_DIR/../../../" 2>/dev/null && pwd -P)/scripts/mutation-probe-admission.sh"
  [ -f "$helper" ] || {
    flock -u "$admission_fd" || true
    exec {admission_fd}>&-
    echo "mutation-probe admission: shared manifest validator is missing" >&2
    return 2
  }
  # shellcheck source=/dev/null
  . "$helper" || {
    flock -u "$admission_fd" || true
    exec {admission_fd}>&-
    echo "mutation-probe admission: could not load shared manifest validator" >&2
    return 2
  }
  if ! probe_admission_read_manifest "$root" "$manifest"; then
    flock -u "$admission_fd" || true
    exec {admission_fd}>&-
    echo "mutation-probe admission: invalid original snapshot; refusing source read" >&2
    return 2
  fi
  if probe_admission_owner_alive; then
    local snapshot_fd
    if ! exec {snapshot_fd}<"${PROBE_ADMISSION_FIELDS[2]}"; then
      flock -u "$admission_fd" || true
      exec {admission_fd}>&-
      echo "mutation-probe admission: original snapshot unavailable; refusing source read" >&2
      return 2
    fi
    if bwrap --bind / / --proc /proc --dev /dev --bind-try /dev/shm /dev/shm \
      --ro-bind-data "$snapshot_fd" "${PROBE_ADMISSION_FIELDS[1]}" -- "$@"; then
      status=0
    else
      status=$?
    fi
    exec {snapshot_fd}<&-
    flock -u "$admission_fd" || true
    exec {admission_fd}>&-
    return "$status"
  fi

  # The probe owner died while the manifest remained. Recover only under the
  # exclusive counterpart of this lock, then re-enter admission in case a new
  # probe started immediately after recovery.
  flock -u "$admission_fd" || true
  if ! flock -x "$admission_fd"; then
    exec {admission_fd}>&-
    echo "mutation-probe admission: cannot acquire recovery lock" >&2
    return 2
  fi
  if [ -e "$manifest" ]; then
    if ! probe_admission_read_manifest "$root" "$manifest"; then
      flock -u "$admission_fd" || true
      exec {admission_fd}>&-
      echo "mutation-probe admission: invalid original snapshot; refusing recovery" >&2
      return 2
    fi
    if ! probe_admission_owner_alive && ! probe_admission_recover_orphan "$root" "$manifest"; then
      flock -u "$admission_fd" || true
      exec {admission_fd}>&-
      echo "mutation-probe admission: orphan recovery failed; refusing source read" >&2
      return 2
    fi
  fi
  flock -u "$admission_fd" || true
  exec {admission_fd}>&-
  vh_probe_admitted_exec "$root" -- "$@"
}

# _vh_record <phase> <status> <step> <reasonCode> <detail> <startedAt> <endedAt> <elapsedMs> [reusedFromRunId]
_vh_record() {
  local row="{\"phase\":$(_vh_json_str "$1"),\"status\":$(_vh_json_str "$2")"
  [ -n "$3" ] && row+=",\"step\":$(_vh_json_str "$3")"
  [ -n "$4" ] && row+=",\"reasonCode\":$(_vh_json_str "$4")"
  [ -n "$5" ] && row+=",\"detail\":$(_vh_json_str "$5")"
  [ -n "$6" ] && row+=",\"startedAt\":$(_vh_json_str "$6")"
  [ -n "$7" ] && row+=",\"endedAt\":$(_vh_json_str "$7")"
  row+=",\"elapsedMs\":${8:-0}"
  [ -n "${9:-}" ] && row+=",\"reusedFromRunId\":$(_vh_json_str "$9")"
  printf '%s}\n' "$row" >> "$VH_RUN_DIR/phases.jsonl" || true
  VH_STATUS[$1]="$2"
  _vh_say "VH_PHASE phase=$1 status=$2${3:+ step=$3}${4:+ reason=$4}"
}

# vh_init / vh_preflight failed to start the contract: fatal (rc 2) unless VH_FAIL_OPEN=1.
_vh_init_failed() { # <reason>
  if [ "${VH_FAIL_OPEN:-0}" = 1 ]; then _vh_disable "$1"; return 0; fi
  echo "vh_init: $1" >&2
  return 2
}

vh_phase() {
  VH_PHASE_IDS+=("$1")
  VH_DEPS[$1]="${2:-}"
  VH_REUSABLE[$1]="${3:-0}"
}

# vh_default_root <harness> — the evidence root when the harness names none (same rule as the TS
# defaultEvidenceRoot): $VH_EVIDENCE_ROOT_BASE/<harness>, else $XDG_STATE_HOME (~/.local/state)
# /verification-harness/<harness>.
vh_default_root() {
  if [ -n "${VH_EVIDENCE_ROOT_BASE:-}" ]; then echo "$VH_EVIDENCE_ROOT_BASE/$1"; return; fi
  echo "${XDG_STATE_HOME:-${HOME:-/tmp}/.local/state}/verification-harness/$1"
}

# Scope tags for guard-rail selection (before vh_init): the preflight runs every probe from
# VH_GUARD_RAIL_SOURCE that shares a tag.
vh_scope() { VH_SCOPE_TAGS+=("$@"); }

vh_init() {
  local name="$1" root="$2"; shift 2
  VH_NAME="$name"
  VH_EVIDENCE_ROOT="$root"
  VH_MAIN_PID="${BASHPID:-$$}"
  local sel=() VH_ARGS_TMP=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --only|--only-phase|--from|--from-phase|--reuse) sel+=("$1" "${2:-}"); shift 2 ;;
      --only=*|--only-phase=*|--from=*|--from-phase=*|--reuse=*) sel+=("$1"); shift ;;
      *) VH_ARGS_TMP+=("$1"); shift ;;
    esac
  done
  VH_ARGS=(${VH_ARGS_TMP[@]+"${VH_ARGS_TMP[@]}"})
  [ "$VH_DISABLED" = 1 ] && return 0
  mkdir -p "$root" 2>/dev/null || { _vh_init_failed "evidence-root-unwritable:$root"; return $?; }
  # Claim the run dir EXCLUSIVELY (R-5): a plain mkdir fails when the dir exists, so a second
  # run from the same process in the same second takes a .N suffix instead of writing into
  # another run's evidence (runner.ts claimRunDir is the TS twin).
  local vh_base vh_n=0
  vh_base="$(date -u +%Y%m%dT%H%M%SZ)-${BASHPID:-$$}"
  VH_RUN_ID="$vh_base"
  until mkdir "$root/$VH_RUN_ID" 2>/dev/null; do
    [ -d "$root/$VH_RUN_ID" ] || { _vh_init_failed "evidence-root-unwritable:$root"; return $?; }
    vh_n=$((vh_n + 1)); VH_RUN_ID="$vh_base.$vh_n"
  done
  VH_RUN_DIR="$root/$VH_RUN_ID"
  mkdir -p "$VH_RUN_DIR/phases" 2>/dev/null || { _vh_init_failed "evidence-root-unwritable:$root"; return $?; }
  # `--reuse latest` means the run <root>/latest points at.
  local i; for i in "${!sel[@]}"; do [ "${sel[$i]}" = "latest" ] && sel[$i]="$(readlink -f "$root/latest")"; done
  {
    printf '{"name":%s,"phases":[' "$(_vh_json_str "$name")"
    local first=1 id d deps
    for id in "${VH_PHASE_IDS[@]}"; do
      deps=""
      IFS=',' read -ra _d <<< "${VH_DEPS[$id]}"
      for d in "${_d[@]}"; do [ -n "$d" ] && deps+="${deps:+,}$(_vh_json_str "$d")"; done
      [ $first -eq 1 ] || printf ','
      first=0
      printf '{"id":%s,"dependsOn":[%s],"reusable":%s}' "$(_vh_json_str "$id")" "$deps" \
        "$([ "${VH_REUSABLE[$id]}" = 1 ] && echo true || echo false)"
    done
    local tags="" t
    for t in "${VH_SCOPE_TAGS[@]}"; do tags+="${tags:+,}$(_vh_json_str "$t")"; done
    printf '],"scopeTags":[%s]}\n' "$tags"
  } > "$VH_RUN_DIR/contract.json"
  local plan
  plan="$("$(_vh_tsx)" "$VH_LIB_DIR/src/cli.ts" plan --run-dir "$VH_RUN_DIR" ${sel[@]+"${sel[@]}"})" \
    || { _vh_init_failed "plan-command-failed"; return $?; }
  local p a r
  while IFS=$'\t' read -r p a r; do
    [ -n "$p" ] || continue
    VH_ACTION[$p]="$a"
    VH_REUSE_FROM[$p]="$r"
  done <<< "$plan"
  # Every declared phase must have come back with an action. A plan command that printed
  # nothing (e.g. an entry-point check that silently skipped main) would otherwise leave the
  # harness reporting nothing while looking like it ran (WI-10004050).
  local id
  for id in ${VH_PHASE_IDS[@]+"${VH_PHASE_IDS[@]}"}; do
    [ -n "${VH_ACTION[$id]:-}" ] || { _vh_init_failed "plan-incomplete:no-action-for-$id"; return $?; }
  done
  _vh_say "VH_RUN harness=$name run=$VH_RUN_ID evidence=$VH_RUN_DIR plan=$(echo "$plan" | awk -F'\t' '{printf "%s%s:%s", (NR>1 ? "," : ""), $1, $2}')"
}

vh_step() {
  VH_CUR_STEP="$1"
  [ "$VH_DISABLED" = 1 ] || _vh_say "VH_STEP phase=${VH_CUR_PHASE:-?} step=$1"
}

vh_fail() { VH_CUR_FAIL="$1"; VH_CUR_DETAIL="${2:-}"; }

_vh_exec() {
  local id="$1" fn="$2"
  VH_CUR_PHASE="$id"; VH_CUR_STEP=""; VH_CUR_FAIL=""; VH_CUR_DETAIL=""
  VH_PHASE_DIR="$VH_RUN_DIR/phases/$id"
  mkdir -p "$VH_PHASE_DIR"
  local t0 s0 rc=0
  t0="$(_vh_ms)"; s0="$(_vh_now)"
  "$fn" || rc=$?
  local status=passed reason=""
  if [ -n "$VH_CUR_FAIL" ]; then status=failed; reason="$VH_CUR_FAIL"
  elif [ "$rc" -ne 0 ]; then status=failed; reason="exit-$rc"; fi
  _vh_record "$id" "$status" "$VH_CUR_STEP" "$reason" "$VH_CUR_DETAIL" "$s0" "$(_vh_now)" "$(( $(_vh_ms) - t0 ))"
  VH_CUR_PHASE=""
  [ "$status" = passed ]
}

# The harness's own check (if any) and then the guard rails; both run, so one run reports
# every broken precondition, and the harness's own failure names the reason when both fail.
_vh_preflight_body() {
  local rc=0
  if [ -n "$VH_PREFLIGHT_FN" ]; then "$VH_PREFLIGHT_FN" || rc=$?; fi
  local own_fail="$VH_CUR_FAIL" own_detail="$VH_CUR_DETAIL" own_step="$VH_CUR_STEP"
  [ -z "$own_fail" ] && [ "$rc" -ne 0 ] && own_fail="exit-$rc"
  local out="" line grc=0 greason="" gdetail=""
  if [ "${#VH_SCOPE_TAGS[@]}" -gt 0 ]; then
    vh_step guard-rails
    out="$("$(_vh_tsx)" "$VH_LIB_DIR/src/cli.ts" guard-rails --run-dir "$VH_RUN_DIR")" || grc=$?
    while IFS= read -r line; do
      case "$line" in
        "VH_GUARD_RAILS_FAILED "*)
          greason="${line#*reason=}"; greason="${greason%% detail=*}"; gdetail="${line#* detail=}" ;;
        ?*) echo "$line" ;;
      esac
    done <<< "$out"
    [ "$grc" -ne 0 ] && [ -z "$greason" ] && greason="guard-rail-check-error:$grc"
  fi
  if [ -n "$own_fail" ]; then
    VH_CUR_STEP="$own_step"
    vh_fail "$own_fail" "$own_detail${gdetail:+; $gdetail}"
    return 1
  fi
  if [ -n "$greason" ]; then vh_fail "$greason" "$gdetail"; return 1; fi
  return 0
}

# vh_preflight [fn] — fn is the harness's own fast check. With scope tags declared, the
# first vh_run calls this itself if the harness did not, so the rails always run.
vh_preflight() {
  VH_PREFLIGHT_FN="${1:-}"
  VH_PREFLIGHT_DONE=1
  if [ "$VH_DISABLED" = 1 ]; then
    VH_CUR_FAIL=""
    local rc=0
    if [ -n "$VH_PREFLIGHT_FN" ]; then "$VH_PREFLIGHT_FN" || rc=$?; fi
    if [ "$rc" -ne 0 ] || [ -n "$VH_CUR_FAIL" ]; then VH_PREFLIGHT_FAILED=1; VH_DISABLED_FAILED=1; fi
    return 0
  fi
  _vh_exec preflight _vh_preflight_body || VH_PREFLIGHT_FAILED=1
}

vh_run() {
  local id="$1" fn="$2" d
  if [ "$VH_DISABLED" = 1 ]; then
    # Uninstrumented, but never a false pass: remember any failure for vh_finish.
    [ "$VH_PREFLIGHT_FAILED" = 1 ] && return 0
    VH_CUR_PHASE="$id"; VH_CUR_STEP=""; VH_CUR_FAIL=""; VH_CUR_DETAIL=""
    local rc=0
    "$fn" || rc=$?
    if [ "$rc" -ne 0 ] || [ -n "$VH_CUR_FAIL" ]; then VH_DISABLED_FAILED=1; fi
    VH_CUR_PHASE=""
    return 0
  fi
  if [ "$VH_PREFLIGHT_DONE" = 0 ] && [ "${#VH_SCOPE_TAGS[@]}" -gt 0 ]; then vh_preflight; fi
  case "${VH_ACTION[$id]:-}" in
    "") echo "vh_run: phase $id was not declared with vh_phase" >&2; return 2 ;;
    skip) _vh_record "$id" skipped "" not-selected "" "" "" 0; return 0 ;;
    reuse) _vh_record "$id" reused "" "" "" "" "" 0 "${VH_REUSE_FROM[$id]}"; return 0 ;;
  esac
  if [ "$VH_PREFLIGHT_FAILED" = 1 ]; then _vh_record "$id" blocked "" preflight-failed "" "" "" 0; return 0; fi
  IFS=',' read -ra _deps <<< "${VH_DEPS[$id]}"
  for d in "${_deps[@]}"; do
    [ -n "$d" ] || continue
    case "${VH_STATUS[$d]:-}" in
      passed|reused) ;;
      *) _vh_record "$id" blocked "" "dependency:$d:${VH_STATUS[$d]:-unknown}" "" "" "" 0; return 0 ;;
    esac
  done
  _vh_exec "$id" "$fn"
  return 0
}

# Prints HARNESS_RESULT and returns 0 on pass. Idempotent: a second call returns the first verdict.
vh_finish() {
  if [ "$VH_DISABLED" = 1 ]; then return "${VH_DISABLED_FAILED:-0}"; fi
  if [ "$VH_FINALIZED" = 1 ]; then return "${VH_FINISH_RC:-1}"; fi
  _vh_close_open 0
  VH_FINALIZED=1
  local rc=0
  if [ "${VH_LOG_FD:-1}" = 2 ]; then
    "$(_vh_tsx)" "$VH_LIB_DIR/src/cli.ts" finalize --run-dir "$VH_RUN_DIR" --evidence-root "$VH_EVIDENCE_ROOT" >&2 || rc=$?
  else
    "$(_vh_tsx)" "$VH_LIB_DIR/src/cli.ts" finalize --run-dir "$VH_RUN_DIR" --evidence-root "$VH_EVIDENCE_ROOT" || rc=$?
  fi
  VH_FINISH_RC="$rc"
  return "$rc"
}

# ── Bracket mode (see the header) ────────────────────────────────────────────

# Record the open bracketed phase: failed when vh_fail was called or rc != 0, else passed.
_vh_close_open() { # <rc>
  local id="$VH_OPEN_PHASE" rc="${1:-0}"
  [ -n "$id" ] || return 0
  local status=passed reason=""
  if [ -n "$VH_CUR_FAIL" ]; then status=failed; reason="$VH_CUR_FAIL"
  elif [ "$rc" -ne 0 ]; then status=failed; reason="exit-$rc"; fi
  VH_OPEN_PHASE=""
  _vh_record "$id" "$status" "$VH_CUR_STEP" "$reason" "$VH_CUR_DETAIL" "$VH_OPEN_S0" "$(_vh_now)" \
    "$(( $(_vh_ms) - VH_OPEN_T0 ))"
  VH_CUR_PHASE=""
}

# vh_begin <phase> — close the open phase (passed) and open this one. Returns 1 when the phase
# must not run: not selected, reused, the preflight failed, or a dependency did not pass.
vh_begin() {
  local id="$1" d
  [ "$VH_DISABLED" = 1 ] && { VH_CUR_PHASE="$id"; VH_CUR_STEP=""; return 0; }
  _vh_close_open 0
  if [ "$VH_PREFLIGHT_DONE" = 0 ] && [ "${#VH_SCOPE_TAGS[@]}" -gt 0 ]; then vh_preflight; fi
  case "${VH_ACTION[$id]:-}" in
    "") echo "vh_begin: phase $id was not declared with vh_phase" >&2; return 2 ;;
    skip) _vh_record "$id" skipped "" not-selected "" "" "" 0; return 1 ;;
    reuse) _vh_record "$id" reused "" "" "" "" "" 0 "${VH_REUSE_FROM[$id]}"; return 1 ;;
  esac
  if [ "$VH_PREFLIGHT_FAILED" = 1 ]; then _vh_record "$id" blocked "" preflight-failed "" "" "" 0; return 1; fi
  IFS=',' read -ra _deps <<< "${VH_DEPS[$id]}"
  for d in ${_deps[@]+"${_deps[@]}"}; do
    [ -n "$d" ] || continue
    case "${VH_STATUS[$d]:-}" in
      passed|reused) ;;
      *) _vh_record "$id" blocked "" "dependency:$d:${VH_STATUS[$d]:-unknown}" "" "" "" 0; return 1 ;;
    esac
  done
  VH_OPEN_PHASE="$id"; VH_CUR_PHASE="$id"; VH_CUR_STEP=""; VH_CUR_FAIL=""; VH_CUR_DETAIL=""
  VH_PHASE_DIR="$VH_RUN_DIR/phases/$id"
  mkdir -p "$VH_PHASE_DIR" 2>/dev/null || true
  VH_OPEN_T0="$(_vh_ms)"; VH_OPEN_S0="$(_vh_now)"
  _vh_say "VH_BEGIN phase=$id"
  return 0
}

# vh_end — close the open phase explicitly (vh_begin and vh_exit also close it).
vh_end() { [ "$VH_DISABLED" = 1 ] && return 0; _vh_close_open 0; }

# vh_skip_rest <reason> — the script is about to exit 0 on purpose before its last phase (a
# precheck-only mode): record the phases it never began as skipped instead of not-reported.
vh_skip_rest() { VH_SKIP_REST="${1:-skipped}"; }

# vh_exit [rc] — finalize a bracketed run. Call it first thing in the script's own EXIT handler
# with the exit status, or let vh_bracket_trap install it. Never changes the caller's exit code
# and runs once, only in the main shell (a subshell that inherits the handler is ignored).
vh_exit() {
  local rc="${1:-0}" open id
  [ "$VH_DISABLED" = 1 ] && return 0
  [ "$VH_FINALIZED" = 0 ] || return 0
  [ -n "${VH_RUN_DIR:-}" ] || return 0
  [ "${BASHPID:-$$}" = "$VH_MAIN_PID" ] || return 0
  open="$VH_OPEN_PHASE"
  _vh_close_open "$rc"
  for id in "${VH_PHASE_IDS[@]}"; do
    [ -z "${VH_STATUS[$id]:-}" ] || continue
    if [ "$rc" -ne 0 ]; then _vh_record "$id" blocked "" "aborted:${open:-between-phases}:exit-$rc" "" "" "" 0
    elif [ -n "$VH_SKIP_REST" ]; then _vh_record "$id" skipped "" "$VH_SKIP_REST" "" "" "" 0
    fi
  done
  vh_finish || true
  return 0
}

# vh_bracket_trap — chain vh_exit in front of whatever EXIT trap is already installed. A script
# that REPLACES its EXIT trap later must call `vh_exit "$rc"` from that handler instead.
vh_bracket_trap() {
  [ "$VH_DISABLED" = 1 ] && return 0
  local prev="" spec
  spec="$(trap -p EXIT)"
  if [ -n "$spec" ]; then
    eval "set -- $spec"   # trap -- '<cmd>' EXIT
    prev="$3"
  fi
  # shellcheck disable=SC2064 # expand $prev now, the rest at exit
  trap "_vh__rc=\$?; vh_exit \"\$_vh__rc\"; (exit \"\$_vh__rc\")${prev:+; $prev}" EXIT
}
