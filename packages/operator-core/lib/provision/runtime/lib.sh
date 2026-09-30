#!/usr/bin/env bash
# papercusp provision/lib.sh
#
# Plugin scripts source this via:
#   . "$PAPERCUSP_RUNTIME_LIB"
#
# Substrate-side env vars:
#   PAPERCUSP_PLUGIN_DIR     read-only path to plugin root
#   PAPERCUSP_SCRATCH_DIR    read-write per-(harness, plugin) scratch
#   PAPERCUSP_RECORD_FIFO    named pipe the substrate reads from for record_resource
#   PAPERCUSP_PROGRESS_FD    fd to write structured progress markers (default 3)
#
# Spec: /docs/snapshots/build-scripts#helper-library

# Choose a fallback fd if the substrate didn't open one.
: "${PAPERCUSP_PROGRESS_FD:=2}"

papercusp_progress() {
  local step="$1"; shift
  local msg="$*"
  printf '::papercusp::progress\t%s\t%s\n' "$step" "$msg" >&"$PAPERCUSP_PROGRESS_FD"
}

papercusp_warn() {
  local msg="$*"
  printf '::papercusp::warn\t%s\n' "$msg" >&"$PAPERCUSP_PROGRESS_FD"
}

papercusp_error() {
  local msg="$*"
  printf '::papercusp::error\t%s\n' "$msg" >&"$PAPERCUSP_PROGRESS_FD"
}

# Append a resource record to the WAL via the named-pipe bridge. Each
# call is atomic (newline-delimited JSON), so a SIGKILL between calls
# never partial-writes.
papercusp_record_resource() {
  local kind="$1"
  local id="$2"
  local meta="${3:-}"
  local now
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if [[ -n "$meta" ]]; then
    printf '{"kind":"%s","externalId":"%s","recordedAt":"%s","metadata":%s}\n' \
      "$kind" "$id" "$now" "$meta" >> "${PAPERCUSP_RECORD_FIFO:-/dev/null}"
  else
    printf '{"kind":"%s","externalId":"%s","recordedAt":"%s"}\n' \
      "$kind" "$id" "$now" >> "${PAPERCUSP_RECORD_FIFO:-/dev/null}"
  fi
}

# Set a key in state.json's `outputs` object — same FIFO, different verb.
papercusp_state_set() {
  local key="$1"
  local val="$2"
  printf '{"$op":"state_set","key":"%s","value":%s}\n' \
    "$key" "$val" >> "${PAPERCUSP_RECORD_FIFO:-/dev/null}"
}

# Walk $PAPERCUSP_PROJECT_DIR for *.tmpl files, render each via envsubst
# with the current env (USER_VAR_*, OUTPUT_*, PAPERCUSP_*, anything else
# the script has exported), write the rendered result to the same path
# without the .tmpl suffix, and remove the .tmpl source.
#
# Skips standard build-output / VCS dirs: .git, node_modules, dist, .next,
# .papercusp, target, build, .turbo. Plugin authors who need to render
# inside one of those should call envsubst manually.
#
# Counts and emits progress markers per file so the operator UI can show
# render progress alongside resource creation.
#
# Caller must have already called `papercusp_state_set` for any keys they
# want exposed as `$OUTPUT_<key>` — this helper does NOT auto-source
# state.json; instead the script's own exported env is what envsubst sees.
# (Substrate-injected USER_VAR_* + caller-exported OUTPUT_* + ambient env.)
#
# Returns 0 even if zero templates are found (no-op is success). Returns
# non-zero only if envsubst fails on a specific file.
papercusp_render_templates() {
  local root="${PAPERCUSP_PROJECT_DIR:-}"
  if [[ -z "$root" ]]; then
    papercusp_warn "PAPERCUSP_PROJECT_DIR not set; skipping template render"
    return 0
  fi
  if [[ ! -d "$root" ]]; then
    papercusp_warn "PAPERCUSP_PROJECT_DIR=$root does not exist; skipping"
    return 0
  fi

  local count=0
  local rc=0
  while IFS= read -r -d '' tmpl; do
    local out="${tmpl%.tmpl}"
    papercusp_progress "render" "$(basename "$tmpl") -> $(basename "$out")"
    if envsubst < "$tmpl" > "$out"; then
      rm -f "$tmpl"
      count=$((count + 1))
    else
      papercusp_error "envsubst failed on $tmpl"
      rc=1
    fi
  done < <(find "$root" \
    \( -path '*/.git' -o -path '*/node_modules' -o -path '*/dist' \
       -o -path '*/.next' -o -path '*/.papercusp' -o -path '*/target' \
       -o -path '*/build' -o -path '*/.turbo' \) -prune \
    -o -type f -name '*.tmpl' -print0)

  papercusp_progress "render-done" "rendered $count template(s)"
  return $rc
}
