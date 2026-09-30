/**
 * The runtime lib.sh content inlined as a TS string export.
 *
 * Why: when the runner runs inside Next.js (server route), `__dirname` is
 * remapped by webpack/turbopack bundling to a virtual `/ROOT/...` path
 * that has no relationship to disk. Resolving runtime/lib.sh via
 * `path.resolve(__dirname, 'lib.sh')` therefore points at a file that
 * doesn't exist. Reading the source file at module-init via fs APIs is
 * also fragile (paths shift across dev/standalone/desktop builds).
 *
 * The cleanest fix is to inline the helper text in a TS module that
 * webpack DOES bundle correctly. The runner writes this string to
 * `<scratch>/papercusp-lib.sh` per phase and points `PAPERCUSP_RUNTIME_LIB`
 * there.
 *
 * The string is constructed via array.join so we never need to escape
 * `${...}` (TS template literals would evaluate them as JS interpolations,
 * even inside String.raw).
 *
 * Keep this file in lockstep with `lib.sh`.
 */

export const RUNTIME_LIB_SH = [
  '#!/usr/bin/env bash',
  '# papercusp provision/lib.sh',
  '#',
  '# Plugin scripts source this via:',
  '#   . "$PAPERCUSP_RUNTIME_LIB"',
  '#',
  '# Substrate-side env vars:',
  '#   PAPERCUSP_PLUGIN_DIR     read-only path to plugin root',
  '#   PAPERCUSP_SCRATCH_DIR    read-write per-(harness, plugin) scratch',
  '#   PAPERCUSP_RECORD_FIFO    named pipe the substrate reads from for record_resource',
  '#   PAPERCUSP_PROGRESS_FD    fd to write structured progress markers (default 2)',
  '#',
  '# Spec: /docs/snapshots/build-scripts#helper-library',
  '',
  ': "${PAPERCUSP_PROGRESS_FD:=2}"',
  '',
  'papercusp_progress() {',
  '  local step="$1"; shift',
  '  local msg="$*"',
  "  printf '::papercusp::progress\\t%s\\t%s\\n' \"$step\" \"$msg\" >&\"$PAPERCUSP_PROGRESS_FD\"",
  '}',
  '',
  'papercusp_warn() {',
  '  local msg="$*"',
  "  printf '::papercusp::warn\\t%s\\n' \"$msg\" >&\"$PAPERCUSP_PROGRESS_FD\"",
  '}',
  '',
  'papercusp_error() {',
  '  local msg="$*"',
  "  printf '::papercusp::error\\t%s\\n' \"$msg\" >&\"$PAPERCUSP_PROGRESS_FD\"",
  '}',
  '',
  'papercusp_record_resource() {',
  '  local kind="$1"',
  '  local id="$2"',
  '  local meta="${3:-}"',
  '  local now',
  '  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"',
  '  if [[ -n "$meta" ]]; then',
  '    printf \'{"kind":"%s","externalId":"%s","recordedAt":"%s","metadata":%s}\\n\' \\',
  '      "$kind" "$id" "$now" "$meta" >> "${PAPERCUSP_RECORD_FIFO:-/dev/null}"',
  '  else',
  '    printf \'{"kind":"%s","externalId":"%s","recordedAt":"%s"}\\n\' \\',
  '      "$kind" "$id" "$now" >> "${PAPERCUSP_RECORD_FIFO:-/dev/null}"',
  '  fi',
  '}',
  '',
  'papercusp_state_set() {',
  '  local key="$1"',
  '  local val="$2"',
  '  printf \'{"$op":"state_set","key":"%s","value":%s}\\n\' \\',
  '    "$key" "$val" >> "${PAPERCUSP_RECORD_FIFO:-/dev/null}"',
  '}',
  '',
  'papercusp_render_templates() {',
  '  local root="${PAPERCUSP_PROJECT_DIR:-}"',
  '  if [[ -z "$root" ]]; then',
  '    papercusp_warn "PAPERCUSP_PROJECT_DIR not set; skipping template render"',
  '    return 0',
  '  fi',
  '  if [[ ! -d "$root" ]]; then',
  '    papercusp_warn "PAPERCUSP_PROJECT_DIR=$root does not exist; skipping"',
  '    return 0',
  '  fi',
  '',
  '  local count=0',
  '  local rc=0',
  '  while IFS= read -r -d \'\' tmpl; do',
  '    local out="${tmpl%.tmpl}"',
  '    papercusp_progress "render" "$(basename "$tmpl") -> $(basename "$out")"',
  '    if envsubst < "$tmpl" > "$out"; then',
  '      rm -f "$tmpl"',
  '      count=$((count + 1))',
  '    else',
  '      papercusp_error "envsubst failed on $tmpl"',
  '      rc=1',
  '    fi',
  '  done < <(find "$root" \\',
  '    \\( -path \'*/.git\' -o -path \'*/node_modules\' -o -path \'*/dist\' \\',
  '       -o -path \'*/.next\' -o -path \'*/.papercusp\' -o -path \'*/target\' \\',
  '       -o -path \'*/build\' -o -path \'*/.turbo\' \\) -prune \\',
  '    -o -type f -name \'*.tmpl\' -print0)',
  '',
  '  papercusp_progress "render-done" "rendered $count template(s)"',
  '  return $rc',
  '}',
  '',
].join('\n');
