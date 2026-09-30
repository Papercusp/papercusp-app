#!/usr/bin/env bash
# Immutable dependency generations for release/checkpoint setup (P-006 / WI-41117).
#
# `npm-install-safe.mjs` publishes a generation after a verified install, and
# `setup-release-checkout.sh` can also publish one on demand. A generation is a
# complete, versioned snapshot of every product-owned node_modules tree. It is
# built beside the final generation, checked against the live source before and
# after the copy, and made visible with one same-filesystem rename. Checkpoints
# then pin that identity instead of traversing a mutable live install.
#
# This file is both a sourceable library and a small standalone publisher:
#   dependency-generation.sh --integration <repo> [--generation-root <dir>]

# ── Self-read guard (WI-322485): this script can spend tens of minutes
# fingerprinting and copying dependency trees while peers keep editing the
# shared checkout. Parse the whole body as one compound command before running
# it, so a mid-run file rewrite cannot shift Bash's read offset into mixed old
# and new bytes. Matching } at EOF; this preserves sourced and executed modes.
{

dependency_generation_log() {
  printf '[dependency-generation] %s\n' "$*" >&2
}

# Writer-owned monotonic-enough wall clock for phase telemetry. GNU date gives
# millisecond resolution; BSD date prints the unsupported %N literally, so fall
# back to whole seconds expressed as milliseconds. Durations are diagnostic and
# never participate in generation identity or correctness decisions.
dependency_generation_now_ms() {
  local now
  now="$(date +%s%3N 2>/dev/null || true)"
  case "$now" in
    ''|*[!0-9]*) printf '%s000\n' "$(date +%s)" ;;
    *) printf '%s\n' "$now" ;;
  esac
}

dependency_generation_emit_phase() {
  local phase="$1" started_ms="$2" outcome="$3" now_ms duration_ms
  shift 3
  now_ms="$(dependency_generation_now_ms)"
  duration_ms=$((now_ms - started_ms))
  [ "$duration_ms" -ge 0 ] || duration_ms=0
  dependency_generation_log \
    "PHASE schema=1 phase=$phase outcome=$outcome duration_ms=$duration_ms${*:+ $*}"
}

dependency_generation_emit_summary() {
  local result="$1" started_ms="$2" source="$3" identity="$4" predecessor="$5"
  local trees_total="$6" trees_reused="$7" trees_copied="$8" trees_removed="$9"
  local now_ms duration_ms
  now_ms="$(dependency_generation_now_ms)"
  duration_ms=$((now_ms - started_ms))
  [ "$duration_ms" -ge 0 ] || duration_ms=0
  dependency_generation_log \
    "SUMMARY schema=1 result=$result source=${source:-unresolved} identity=${identity:-unresolved} predecessor=${predecessor:-none} trees_total=$trees_total trees_reused=$trees_reused trees_copied=$trees_copied trees_removed=$trees_removed total_ms=$duration_ms"
}

dependency_generation_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{ print $1 }'
  else
    dependency_generation_log 'FATAL: neither sha256sum nor shasum is available'
    return 1
  fi
}

dependency_generation_host() {
  hostname 2>/dev/null || uname -n 2>/dev/null || printf 'unknown-host\n'
}

# A small, source-controlled description of the install inputs. The immutable
# generation itself is keyed from the much larger node_modules metadata walk;
# this fingerprint is the cheap lookup key a later checkpoint can derive from
# its exact candidate without consulting mutable node_modules at all.
dependency_generation_input_manifest() {
  local root="$1" file rel digest
  (
    cd "$root" || exit 1
    while IFS= read -r file; do
      rel="${file#./}"
      digest="$(dependency_generation_sha256 < "$file")" || exit 1
      printf '%s\t%s\n' "$rel" "$digest"
    done < <(
      find . \
        \( -type d \( -name .papercusp -o -name .git -o -name node_modules \
          -o -name 'node_modules.deploy-tmp.*' -o -name 'node_modules.deploy-old.*' \) -prune \) -o \
        \( -type f \( -name package-lock.json -o -name npm-shrinkwrap.json \
          -o \( -name '*.patch' -a -path '*/patches/*' \) \) -print \) \
        | LC_ALL=C sort
    )
  )
}

dependency_generation_input_fingerprint() {
  local root="$1" manifest
  manifest="$(dependency_generation_input_manifest "$root")" || return 1
  {
    printf 'schema\t1\n'
    [ -z "$manifest" ] || printf '%s\n' "$manifest"
  } | dependency_generation_sha256
}

# Derive the same cheap dependency-input key from an immutable Git commit without
# materialising a checkout. Only lockfiles and patch-package patch files
# participate in the key, so walk those blobs directly and recurse through the
# commit's recorded submodule gitlinks. Patches are load-bearing inputs because
# the root package.json postinstall runs `patch-package`, so a patch change
# alters the produced node_modules closure exactly as a lockfile change does;
# omitting them let the gate reuse a stale generation indefinitely (WI-10002299).
# This set MUST stay identical to dependency_generation_input_manifest() above.
# This is the producer-side seam used before the checkpoint run-lock: a moving
# integration worktree can publish only when its live lockfiles are compatible
# with the exact candidate fingerprint.
dependency_generation_input_manifest_ref() {
  local root="$1" ref="$2" prefix="${3:-}"
  local record metadata mode type object rel digest submodule_path submodule_object
  while IFS= read -r -d '' record; do
    metadata="${record%%$'\t'*}"
    rel="${record#*$'\t'}"
    read -r mode type object <<< "$metadata"
    [ "$type" = 'blob' ] || continue
    case "$rel" in
      package-lock.json|*/package-lock.json|npm-shrinkwrap.json|*/npm-shrinkwrap.json) ;;
      patches/*.patch|*/patches/*.patch) ;;
      *) continue ;;
    esac
    case "$rel" in
      .papercusp/*|*/.papercusp/*|node_modules/*|*/node_modules/*) continue ;;
    esac
    digest="$(git -C "$root" cat-file blob "$object" | dependency_generation_sha256)" || return 1
    printf '%s\t%s\n' "${prefix}${rel}" "$digest"
  done < <(git -C "$root" ls-tree -r -z "$ref")

  while IFS= read -r submodule_path; do
    [ -n "$submodule_path" ] || continue
    submodule_object="$(
      git -C "$root" ls-tree "$ref" -- "$submodule_path" \
        | awk '$1 == "160000" && $2 == "commit" { print $3; exit }'
    )"
    [ -n "$submodule_object" ] || {
      dependency_generation_log \
        "FATAL: exact dependency-input ref $ref has no gitlink for submodule $submodule_path"
      return 74
    }
    [ -d "$root/$submodule_path" ] \
      && git -C "$root/$submodule_path" cat-file -e "$submodule_object^{commit}" 2>/dev/null || {
        dependency_generation_log \
          "FATAL: exact dependency-input ref $ref requires unavailable submodule $submodule_path@$submodule_object"
        return 74
      }
    dependency_generation_input_manifest_ref \
      "$root/$submodule_path" "$submodule_object" "${prefix}${submodule_path}/" || return $?
  done < <(
    git -C "$root" config --blob "$ref:.gitmodules" --get-regexp '\.path$' 2>/dev/null \
      | awk '{ print $2 }'
  )
}

dependency_generation_input_fingerprint_ref() {
  local root="$1" ref="$2" manifest
  ref="$(git -C "$root" rev-parse --verify "$ref^{commit}" 2>/dev/null)" || {
    dependency_generation_log "FATAL: dependency-input ref is not a commit: $ref"
    return 74
  }
  manifest="$(dependency_generation_input_manifest_ref "$root" "$ref" | LC_ALL=C sort)" || return $?
  {
    printf 'schema\t1\n'
    [ -z "$manifest" ] || printf '%s\n' "$manifest"
  } | dependency_generation_sha256
}

dependency_generation_device() {
  local path="$1" parent
  while [ ! -e "$path" ]; do
    parent="$(dirname "$path")"
    [ "$parent" = "$path" ] && break
    path="$parent"
  done
  stat -c '%d' "$path" 2>/dev/null || stat -f '%d' "$path"
}

# Empty means the historical full-product generation. A selected generation is
# configured by repeated --workspace-dir arguments and always retains the root
# node_modules tree in addition to these package-local trees.
DEPENDENCY_GENERATION_WORKSPACE_DIRS=()
DEPENDENCY_GENERATION_SCOPE_MODE='full'
DEPENDENCY_GENERATION_SCOPE_RECORD=''
DEPENDENCY_GENERATION_CLOSURE_FINGERPRINT=''

dependency_generation_configure_workspace_dirs() {
  local root="$1" raw resolved
  shift
  DEPENDENCY_GENERATION_WORKSPACE_DIRS=()
  if [ "$#" -eq 0 ]; then
    DEPENDENCY_GENERATION_SCOPE_MODE='full'
    DEPENDENCY_GENERATION_SCOPE_RECORD='scope=full'
  else
    DEPENDENCY_GENERATION_SCOPE_MODE='selected'
    DEPENDENCY_GENERATION_SCOPE_RECORD='scope=selected'
    while IFS= read -r raw; do
      case "$raw" in
        ''|.|/*|./*|../*|*/../*|*/..|*//*|*/|*\\*|*$'\n'*|*$'\r'*|*$'\t'*)
          dependency_generation_log "FATAL: invalid repo-relative --workspace-dir: $raw"
          return 2
          ;;
      esac
      resolved="$(cd "$root/$raw" 2>/dev/null && pwd -P)" || {
        dependency_generation_log "FATAL: --workspace-dir does not exist: $raw"
        return 2
      }
      case "$resolved" in
        "$root"/*) ;;
        *)
          dependency_generation_log "FATAL: --workspace-dir escapes the integration root: $raw"
          return 2
          ;;
      esac
      [ -f "$resolved/package.json" ] || {
        dependency_generation_log "FATAL: --workspace-dir has no package.json: $raw"
        return 2
      }
      DEPENDENCY_GENERATION_WORKSPACE_DIRS+=("$raw")
      DEPENDENCY_GENERATION_SCOPE_RECORD+=$'\n'"workspace_dir=$raw"
    done < <(printf '%s\n' "$@" | LC_ALL=C sort -u)
  fi
  DEPENDENCY_GENERATION_CLOSURE_FINGERPRINT="$(
    printf '%s\n' "$DEPENDENCY_GENERATION_SCOPE_RECORD" | dependency_generation_sha256
  )" || return 1
}

# Product dependency trees only. Coordination worktrees and Git metadata are
# runtime infrastructure, never dependency-generation inputs.
dependency_generation_enumerate_node_modules() {
  local root="$1" dir
  if [ "${DEPENDENCY_GENERATION_SCOPE_MODE:-full}" = 'selected' ]; then
    [ -d "$root/node_modules" ] && printf '%s\n' "$root/node_modules"
    for dir in "${DEPENDENCY_GENERATION_WORKSPACE_DIRS[@]}"; do
      [ -d "$root/$dir/node_modules" ] && printf '%s\n' "$root/$dir/node_modules"
    done
    return 0
  fi
  find "$root" \
    \( -type d \( -name .papercusp -o -name .git \
      -o -name 'node_modules.deploy-tmp.*' -o -name 'node_modules.deploy-old.*' \) -prune \) -o \
    \( -type d -name node_modules -prune -print \)
}

# Metadata identity deliberately avoids reading ~13 GiB of file contents. The
# aggregate is sampled before and after publication, so a concurrent install or
# test mutation cannot authorize a mixed generation.
dependency_generation_tree_fingerprint() {
  local root="$1" local_path stat_record link_target
  [ -d "$root" ] || return 1
  (
    cd "$root" || exit 1
    if [ "${DEPENDENCY_GENERATION_FORCE_PORTABLE_STAT:-0}" != '1' ] \
      && find . -xdev -mindepth 1 -maxdepth 1 -printf '' >/dev/null 2>&1; then
      LC_ALL=C find . -xdev -mindepth 1 \
        \( -type d \( -path './.cache' -o -name .astro -o -name .vite -o -name .vite-temp -o -name .verdict-data \) -prune \) -o \
        \( ! -path './.papercusp-isolated-snapshot' \
        ! -path './.papercusp-dependency-generation' \
        ! -path './.package-lock.json' \
        -printf '%P\0%y\0%m\0%u\0%g\0%s\0%T@\0%i\0%l\0' \) \
        | dependency_generation_sha256
    else
      # BSD/macOS find has no -printf. Keep the same identity classes with a
      # portable stat record per path. It is slower, but correctness-preserving.
      LC_ALL=C find . -xdev -mindepth 1 \
        \( -type d \( -path './.cache' -o -name .astro -o -name .vite -o -name .vite-temp -o -name .verdict-data \) -prune \) -o \
        \( ! -path './.papercusp-isolated-snapshot' \
        ! -path './.papercusp-dependency-generation' \
        ! -path './.package-lock.json' -print0 \) \
        | while IFS= read -r -d '' path; do
            local_path="${path#./}"
            if stat_record="$(stat -c '%F|%a|%U|%G|%s|%Y|%i' "$path" 2>/dev/null)"; then
              :
            else
              stat_record="$(stat -f '%HT|%Lp|%Su|%Sg|%z|%m|%i' "$path")" || exit 1
            fi
            link_target=''
            [ -L "$path" ] && link_target="$(readlink "$path")"
            printf '%s\0%s\0%s\0' "$local_path" "$stat_record" "$link_target"
          done \
        | dependency_generation_sha256
    fi
  )
}

dependency_generation_emit_tree_record() {
  local root="$1" nm="$2" rel fingerprint
  rel="${nm#"$root"/}"
  fingerprint="$(dependency_generation_tree_fingerprint "$nm")" || return 1
  # One short record per tree. Kept to a single write so that parallel walkers
  # cannot interleave a partial line on the shared pipe (a record is far below
  # PIPE_BUF, for which POSIX guarantees an atomic write).
  printf '%s\t%s\n' "$rel" "$fingerprint"
}

# Degree of parallelism for the manifest walk. Override with
# DEPENDENCY_GENERATION_WALK_JOBS; 1 forces the serial walk.
dependency_generation_walk_jobs() {
  local jobs="${DEPENDENCY_GENERATION_WALK_JOBS:-}" cores
  if [ -z "$jobs" ]; then
    cores="$(nproc 2>/dev/null || printf '4')"
    case "$cores" in '' | *[!0-9]*) cores=4 ;; esac
    jobs="$cores"
    # The walk is dentry/metadata bound, not CPU bound, so more workers than
    # this buys nothing and only adds contention on a loaded box.
    [ "$jobs" -gt 16 ] && jobs=16
  fi
  case "$jobs" in '' | *[!0-9]*) jobs=1 ;; esac
  [ "$jobs" -lt 1 ] && jobs=1
  printf '%s\n' "$jobs"
}

# Fail open to the serial walk on any xargs that lacks -0/-P/-I (BSD/macOS).
dependency_generation_walk_supports_parallel() {
  printf '' | xargs -0 -r -P 2 -I '{}' true >/dev/null 2>&1
}

dependency_generation_set_manifest_serial() {
  local root="$1" nm
  (
    while IFS= read -r nm; do
      dependency_generation_emit_tree_record "$root" "$nm" || exit 1
    done < <(dependency_generation_enumerate_node_modules "$root")
  ) | LC_ALL=C sort
}

# Each tree's fingerprint is computed independently and the manifest is globally
# sorted below, so emission ORDER carries no meaning and this walk parallelises
# without changing a single output byte. Identity classes, prune rules and the
# metadata-only guarantee are untouched — only the scheduling changes.
#
# Why it matters: one serial walk over this repo's ~94 node_modules trees
# measured 287s under real fleet load, and dependency_generation_ensure performs
# three of them (~861s) against green-checkpoint's 900s materialisation budget,
# so the walk alone could consume the entire budget before a byte was copied
# (EI-21322804786723906).
dependency_generation_set_manifest() {
  local root="$1" jobs records status=0
  jobs="$(dependency_generation_walk_jobs)"
  if [ "$jobs" -le 1 ] || ! dependency_generation_walk_supports_parallel; then
    dependency_generation_set_manifest_serial "$root"
    return
  fi
  export -f dependency_generation_emit_tree_record \
    dependency_generation_tree_fingerprint \
    dependency_generation_sha256 \
    dependency_generation_log
  # Collected rather than streamed so that a failed walker fails the manifest
  # with the SAME status the serial walk uses (xargs reports 123), instead of
  # letting a truncated manifest reach the caller as a valid identity. The
  # manifest is one short line per node_modules tree, so this stays small.
  records="$(
    dependency_generation_enumerate_node_modules "$root" \
      | tr '\n' '\0' \
      | DEPENDENCY_GENERATION_WALK_ROOT="$root" xargs -0 -r -P "$jobs" -I '{}' \
        bash -c 'dependency_generation_emit_tree_record "$DEPENDENCY_GENERATION_WALK_ROOT" "$1"' _ '{}'
  )" || status=1
  [ "$status" -eq 0 ] || return 1
  [ -n "$records" ] || return 0
  printf '%s\n' "$records" | LC_ALL=C sort
}

dependency_generation_manifest_fingerprint() {
  local manifest="$1"
  dependency_generation_sha256 < "$manifest"
}

dependency_generation_source_fingerprint() {
  local manifest="$1"
  local closure="${2:-$DEPENDENCY_GENERATION_CLOSURE_FINGERPRINT}"
  {
    printf 'closure\t%s\n' "$closure"
    cat "$manifest"
  } | dependency_generation_sha256
}

dependency_generation_set_fingerprint() {
  local root="$1"
  dependency_generation_set_manifest "$root" | dependency_generation_sha256
}

dependency_generation_log_manifest_delta() {
  local before="$1" after="$2"
  awk -F '\t' '
    NR == FNR { old[$1] = $2; next }
    {
      seen[$1] = 1
      if (!($1 in old)) {
        if (shown++ < 20) print "[dependency-generation] changed input: " $1 " (added)" > "/dev/stderr"
      } else if (old[$1] != $2) {
        if (shown++ < 20) print "[dependency-generation] changed input: " $1 " (metadata fingerprint changed)" > "/dev/stderr"
      }
    }
    END {
      for (path in old) {
        if (!(path in seen) && shown++ < 20)
          print "[dependency-generation] changed input: " path " (removed)" > "/dev/stderr"
      }
    }
  ' "$before" "$after"
}

dependency_generation_read_field() {
  local file="$1" key="$2"
  sed -n "s/^${key}=//p" "$file" | head -1
}

# Wall clock in nanoseconds, used ONLY to ORDER generations (`created_ns=`).
# `created=` stays whole seconds for every existing reader. With seconds alone,
# two publications inside the same second tie and retention falls through to
# the identity tie-break — a content hash, i.e. a coin flip — so RETAIN_COUNT=1
# could keep the OLDER generation (WI-10003601). `date +%N` is GNU-only; where it
# is missing the value degrades to seconds*1e9, which only loses the sub-second
# tie-break and is never worse than the seconds-only ordering it replaces.
dependency_generation_now_ns() {
  local ns
  ns="$(date +%s%N 2>/dev/null || true)"
  case "$ns" in ''|*[!0-9]*) ns="$(date +%s)000000000" ;; esac
  printf '%s\n' "$ns"
}

# Retention/predecessor ORDER key for one generation marker, in nanoseconds:
# `created_ns` when the marker carries it, otherwise the legacy whole-second
# `created` scaled to the same unit, so legacy and new markers compare correctly.
dependency_generation_created_order_ns() {
  local marker="$1" ns created
  ns="$(dependency_generation_read_field "$marker" created_ns)"
  case "$ns" in ''|*[!0-9]*) ns='' ;; esac
  if [ -z "$ns" ]; then
    created="$(dependency_generation_read_field "$marker" created)"
    case "$created" in ''|*[!0-9]*) created=0 ;; esac
    ns="$((10#$created * 1000000000))"
  fi
  printf '%s\n' "$((10#$ns))"
}

# A reusable tree manifest is deliberately stricter than the historical source
# diagnostic. Every record names exactly one safe product-owned node_modules
# path, is globally sorted/unique, carries one sha256 fingerprint, and resolves
# beneath the supplied tree root. A legacy or exotic-path manifest that cannot
# satisfy this contract remains valid for a full rebuild but is never trusted as
# an incremental-copy map.
dependency_generation_manifest_records_are_reusable() {
  local manifest="$1" tree_root="$2"
  local rel fingerprint extra previous=''
  local LC_ALL=C
  [ -f "$manifest" ] || return 1
  while IFS=$'\t' read -r rel fingerprint extra; do
    [ -z "$extra" ] || return 1
    [ -n "$rel" ] && [[ "$fingerprint" =~ ^[0-9a-f]{64}$ ]] || return 1
    case "$rel" in
      /*|.|..|../*|*/../*|*/..|*//*|*$'\n'*|*$'\r'*) return 1 ;;
    esac
    case "$rel" in
      node_modules|*/node_modules) ;;
      *) return 1 ;;
    esac
    if [ -n "$previous" ] && [[ "$rel" == "$previous" || "$rel" < "$previous" ]]; then
      return 1
    fi
    [ -d "$tree_root/$rel" ] || return 1
    previous="$rel"
  done < "$manifest"
}

dependency_generation_reuse_manifest_is_valid() {
  local generation="$1" marker manifest schema expected_digest actual_digest
  local source closure actual_source
  marker="$generation/.papercusp-dependency-generation"
  manifest="$generation/.tree-manifest"
  [ -f "$marker" ] && [ -f "$manifest" ] || return 1
  schema="$(dependency_generation_read_field "$marker" tree_manifest_schema)"
  expected_digest="$(dependency_generation_read_field "$marker" tree_manifest_sha256)"
  [ "$schema" = '1' ] && [[ "$expected_digest" =~ ^[0-9a-f]{64}$ ]] || return 1
  actual_digest="$(dependency_generation_manifest_fingerprint "$manifest" 2>/dev/null || true)"
  [ "$actual_digest" = "$expected_digest" ] || return 1
  dependency_generation_manifest_records_are_reusable "$manifest" "$generation/tree" || return 1
  source="$(dependency_generation_read_field "$marker" source)"
  closure="$(dependency_generation_read_field "$marker" closure)"
  actual_source="$(dependency_generation_source_fingerprint "$manifest" "$closure" 2>/dev/null || true)"
  [ -n "$source" ] && [ "$actual_source" = "$source" ]
}

dependency_generation_manifest_lookup() {
  local manifest="$1" wanted="$2" rel fingerprint extra
  while IFS=$'\t' read -r rel fingerprint extra; do
    if [ "$rel" = "$wanted" ]; then
      printf '%s\n' "$fingerprint"
      return 0
    fi
  done < "$manifest"
  return 1
}

dependency_generation_is_valid() {
  local generation="$1" expected_identity="${2:-}" expected_closure="${3:-}"
  local validate_publication="${4:-true}"
  local marker="$generation/.papercusp-dependency-generation"
  local identity source closure scope expected_snapshot actual_snapshot
  local tree_manifest_schema tree_manifest_sha256 tree_manifest
  local publication_schema publication_token
  # Test-only tracing proves that the publish-lock fast path does not silently
  # reintroduce the full tree walk. It is deliberately fail-open and has no
  # effect unless a test supplies the opt-in path.
  if [ -n "${DEPENDENCY_GENERATION_VALIDATION_TRACE:-}" ]; then
    printf '%s\n' "$generation" >> "$DEPENDENCY_GENERATION_VALIDATION_TRACE" || true
  fi
  [ -d "$generation/tree" ] && [ -f "$marker" ] || return 1
  identity="$(dependency_generation_read_field "$marker" identity)"
  [ -n "$identity" ] || return 1
  [ -z "$expected_identity" ] || [ "$identity" = "$expected_identity" ] || return 1
  source="$(dependency_generation_read_field "$marker" source)"
  [ -n "$source" ] && [ "$identity" = "v1-$source" ] || return 1
  closure="$(dependency_generation_read_field "$marker" closure)"
  [ -n "$closure" ] || return 1
  [ -z "$expected_closure" ] || [ "$closure" = "$expected_closure" ] || return 1
  scope="$(dependency_generation_read_field "$marker" scope)"
  case "$scope" in full|selected) ;; *) return 1 ;; esac
  tree_manifest="$generation/.tree-manifest"
  tree_manifest_schema="$(dependency_generation_read_field "$marker" tree_manifest_schema)"
  tree_manifest_sha256="$(dependency_generation_read_field "$marker" tree_manifest_sha256)"
  if [ -e "$tree_manifest" ] || [ -n "$tree_manifest_schema" ] || [ -n "$tree_manifest_sha256" ]; then
    dependency_generation_reuse_manifest_is_valid "$generation" || return 1
  fi
  publication_schema="$(dependency_generation_read_field "$marker" publication_schema)"
  publication_token="$(dependency_generation_read_field "$marker" publication_token)"
  if [ "$validate_publication" = 'true' ] \
    && { [ -n "$publication_schema" ] || [ -n "$publication_token" ]; }; then
    dependency_generation_publication_is_valid \
      "$generation" "$expected_identity" "$expected_closure" || return 1
  fi
  expected_snapshot="$(dependency_generation_read_field "$marker" snapshot)"
  [ -n "$expected_snapshot" ] || return 1
  actual_snapshot="$(dependency_generation_set_fingerprint "$generation/tree" 2>/dev/null || true)"
  [ -n "$actual_snapshot" ] && [ "$actual_snapshot" = "$expected_snapshot" ]
}

dependency_generation_deep_audit() {
  dependency_generation_is_valid "$1" "${2:-}" "${3:-}" false
}

# Return a cheap identity for a published generation. The generation directory
# is swapped into place atomically and its files are immutable after publish,
# so the directory device/inode plus marker device/inode/mtime is enough to
# prove that the exact incumbent we already validated has not been replaced.
# This avoids a second full snapshot walk while the publish lock is held.
dependency_generation_stat_token() {
  local path="$1"
  if stat -c '%d:%i:%Y:%s' "$path" 2>/dev/null; then
    return 0
  fi
  stat -f '%d:%i:%m:%z' "$path"
}

dependency_generation_inode_token() {
  local path="$1"
  if stat -c '%d:%i' "$path" 2>/dev/null; then
    return 0
  fi
  stat -f '%d:%i' "$path"
}

# Digest the immutable marker payload without its own publication_token field,
# avoiding a self-referential hash while still binding every structural field,
# the snapshot claim, closure/scope, predecessor lineage, and tree counters.
dependency_generation_marker_payload_digest() {
  local marker="$1"
  sed '/^publication_token=/d' "$marker" | dependency_generation_sha256
}

# V2 is constant in the dependency-tree size: it reads the small marker and
# per-tree manifest, plus stat identities for the four immutable objects. The
# 13-GiB tree is never walked here. Deep content verification remains available
# through dependency_generation_deep_audit and is used for legacy/recovery.
dependency_generation_publication_token() {
  local generation="$1" marker manifest tree
  local generation_inode tree_token marker_inode manifest_token
  local marker_digest manifest_digest recorded_manifest_digest digest
  marker="$generation/.papercusp-dependency-generation"
  manifest="$generation/.tree-manifest"
  tree="$generation/tree"
  [ -d "$generation" ] && [ -d "$tree" ] && [ -f "$marker" ] && [ -f "$manifest" ] \
    || return 1
  generation_inode="$(dependency_generation_inode_token "$generation")" || return 1
  tree_token="$(dependency_generation_stat_token "$tree")" || return 1
  marker_inode="$(dependency_generation_inode_token "$marker")" || return 1
  manifest_token="$(dependency_generation_stat_token "$manifest")" || return 1
  marker_digest="$(dependency_generation_marker_payload_digest "$marker")" || return 1
  manifest_digest="$(dependency_generation_manifest_fingerprint "$manifest")" || return 1
  recorded_manifest_digest="$(dependency_generation_read_field "$marker" tree_manifest_sha256)"
  [ "$manifest_digest" = "$recorded_manifest_digest" ] || return 1
  digest="$({
    printf 'schema\t2\n'
    printf 'generation\t%s\n' "$generation_inode"
    printf 'tree\t%s\n' "$tree_token"
    printf 'marker\t%s\t%s\n' "$marker_inode" "$marker_digest"
    printf 'manifest\t%s\t%s\n' "$manifest_token" "$manifest_digest"
  } | dependency_generation_sha256)" || return 1
  printf 'v2:%s\n' "$digest"
}

dependency_generation_has_publication_contract() {
  local generation="$1" marker
  marker="$generation/.papercusp-dependency-generation"
  [ -f "$marker" ] || return 1
  [ -n "$(dependency_generation_read_field "$marker" publication_schema)" ] \
    || [ -n "$(dependency_generation_read_field "$marker" publication_token)" ]
}

dependency_generation_publication_is_valid() {
  local generation="$1" expected_identity="${2:-}" expected_closure="${3:-}"
  local expected_scope="${4:-}" marker identity source closure scope snapshot
  local schema recorded_token current_token token_count
  marker="$generation/.papercusp-dependency-generation"
  [ -d "$generation/tree" ] && [ -f "$marker" ] || return 1
  identity="$(dependency_generation_read_field "$marker" identity)"
  source="$(dependency_generation_read_field "$marker" source)"
  closure="$(dependency_generation_read_field "$marker" closure)"
  scope="$(dependency_generation_read_field "$marker" scope)"
  snapshot="$(dependency_generation_read_field "$marker" snapshot)"
  [ -n "$identity" ] && [ "$identity" = "v1-$source" ] && [ -n "$closure" ] \
    && [ -n "$snapshot" ] || return 1
  [ -z "$expected_identity" ] || [ "$identity" = "$expected_identity" ] || return 1
  [ -z "$expected_closure" ] || [ "$closure" = "$expected_closure" ] || return 1
  [ -z "$expected_scope" ] || [ "$scope" = "$expected_scope" ] || return 1
  case "$scope" in full|selected) ;; *) return 1 ;; esac
  schema="$(dependency_generation_read_field "$marker" publication_schema)"
  recorded_token="$(dependency_generation_read_field "$marker" publication_token)"
  token_count="$(grep -c '^publication_token=' "$marker" 2>/dev/null || true)"
  [ "$schema" = '2' ] && [ "$token_count" = '1' ] \
    && [[ "$recorded_token" =~ ^v2:[0-9a-f]{64}$ ]] || return 1
  dependency_generation_reuse_manifest_is_valid "$generation" || return 1
  current_token="$(dependency_generation_publication_token "$generation" 2>/dev/null || true)"
  [ -n "$current_token" ] && [ "$current_token" = "$recorded_token" ]
}

dependency_generation_generation_token() {
  local generation="$1" marker generation_token marker_token
  [ -d "$generation" ] || return 1
  generation_token="$(dependency_generation_stat_token "$generation")" || return 1
  marker="$generation/.papercusp-dependency-generation"
  if [ -e "$marker" ]; then
    marker_token="$(dependency_generation_stat_token "$marker")" || return 1
  else
    marker_token='missing'
  fi
  printf '%s|%s\n' "$generation_token" "$marker_token"
}

dependency_generation_selector_token() {
  local generation="$1"
  if dependency_generation_has_publication_contract "$generation"; then
    dependency_generation_publication_token "$generation"
  else
    dependency_generation_generation_token "$generation"
  fi
}

# Select a generation that was fully validated by its publisher. The selector
# stores the stat token observed after that validation; matching the generation
# directory + immutable marker is constant-time and detects replacement between
# prewarm and use. Exact-id callers without a token retain the full-validation
# dependency_generation_select path below.
dependency_generation_select_prevalidated() {
  local generation_root="$1" identity="$2" expected_token="$3"
  local generation marker source scope snapshot current_token
  if [[ ! "$identity" =~ ^v1-[0-9a-f]{64}$ ]]; then
    dependency_generation_log "FATAL: invalid dependency-generation identity: $identity"
    return 2
  fi
  [ -n "$expected_token" ] || {
    dependency_generation_log "FATAL: prewarmed dependency generation $identity has no immutable token"
    return 74
  }
  generation="$generation_root/$identity"
  case "$expected_token" in
    v2:*)
      if ! dependency_generation_publication_is_valid "$generation" "$identity" '' 'full'; then
        dependency_generation_log \
          "FATAL: prewarmed dependency generation $identity has an invalid publication token"
        return 74
      fi
      current_token="$(dependency_generation_read_field \
        "$generation/.papercusp-dependency-generation" publication_token)"
      ;;
    *)
      current_token="$(dependency_generation_generation_token "$generation" 2>/dev/null || true)"
      ;;
  esac
  if [ -z "$current_token" ] || [ "$current_token" != "$expected_token" ]; then
    dependency_generation_log "FATAL: prewarmed dependency generation $identity was replaced after validation"
    return 74
  fi
  marker="$generation/.papercusp-dependency-generation"
  source="$(dependency_generation_read_field "$marker" source)"
  scope="$(dependency_generation_read_field "$marker" scope)"
  snapshot="$(dependency_generation_read_field "$marker" snapshot)"
  if [ "$(dependency_generation_read_field "$marker" identity)" != "$identity" ] \
    || [ -z "$source" ] || [ "$identity" != "v1-$source" ] \
    || [ "$scope" != 'full' ] || [ -z "$snapshot" ]; then
    dependency_generation_log "FATAL: prewarmed dependency generation $identity has an invalid immutable marker"
    return 74
  fi
  DEPENDENCY_GENERATION_ID="$identity"
  DEPENDENCY_GENERATION_PATH="$generation"
  DEPENDENCY_GENERATION_TREE="$generation/tree"
  DEPENDENCY_GENERATION_SOURCE_FINGERPRINT="$source"
  DEPENDENCY_GENERATION_REUSED='true'
  DEPENDENCY_GENERATION_TOKEN="$current_token"
}

dependency_generation_publish_input_selector() {
  local generation_root="$1" input_fingerprint="$2"
  local selector_dir selector tmp token rc=0
  [ "${DEPENDENCY_GENERATION_SCOPE_MODE:-full}" = 'full' ] || return 0
  selector_dir="$generation_root/.inputs"
  selector="$selector_dir/$input_fingerprint"
  tmp="$selector_dir/.${input_fingerprint}.tmp.$$"
  mkdir -p "$selector_dir"
  dependency_generation_acquire_publish_lock "$generation_root" || return $?
  if dependency_generation_has_publication_contract "$DEPENDENCY_GENERATION_PATH"; then
    if ! dependency_generation_publication_is_valid \
      "$DEPENDENCY_GENERATION_PATH" "$DEPENDENCY_GENERATION_ID" \
      "$DEPENDENCY_GENERATION_CLOSURE_FINGERPRINT" 'full'; then
      dependency_generation_log \
        "FATAL: refusing to index invalid dependency publication $DEPENDENCY_GENERATION_ID"
      rc=74
    fi
  elif ! dependency_generation_marker_matches \
    "$DEPENDENCY_GENERATION_PATH" "$DEPENDENCY_GENERATION_ID"; then
    dependency_generation_log "FATAL: refusing to index invalid dependency generation $DEPENDENCY_GENERATION_ID"
    rc=74
  fi
  if [ "$rc" -eq 0 ]; then
    token="$(dependency_generation_selector_token "$DEPENDENCY_GENERATION_PATH")" || rc=$?
  fi
  if [ "$rc" -eq 0 ]; then
    printf 'schema=1\ninput=%s\nidentity=%s\ntoken=%s\ncreated=%s\n' \
      "$input_fingerprint" "$DEPENDENCY_GENERATION_ID" "$token" "$(date +%s)" > "$tmp" \
      && mv "$tmp" "$selector" || rc=$?
  fi
  rm -f -- "$tmp"
  dependency_generation_release_publish_lock
  [ "$rc" -eq 0 ] || return "$rc"
  DEPENDENCY_GENERATION_INPUT_FINGERPRINT="$input_fingerprint"
  DEPENDENCY_GENERATION_TOKEN="$token"
  dependency_generation_log \
    "indexed prewarmed dependency inputs $input_fingerprint as $DEPENDENCY_GENERATION_ID"
}

dependency_generation_select_input_fingerprint() {
  local input_fingerprint="$1" generation_root="$2"
  local selector schema recorded_input identity token
  selector="$generation_root/.inputs/$input_fingerprint"
  if [ ! -f "$selector" ]; then
    dependency_generation_log \
      "FATAL: no prewarmed dependency generation for input fingerprint $input_fingerprint"
    return 74
  fi
  schema="$(dependency_generation_read_field "$selector" schema)"
  recorded_input="$(dependency_generation_read_field "$selector" input)"
  identity="$(dependency_generation_read_field "$selector" identity)"
  token="$(dependency_generation_read_field "$selector" token)"
  if [ "$schema" != '1' ] || [ "$recorded_input" != "$input_fingerprint" ]; then
    dependency_generation_log "FATAL: invalid prewarmed dependency selector for $input_fingerprint"
    return 74
  fi
  dependency_generation_select_prevalidated "$generation_root" "$identity" "$token" || return $?
  DEPENDENCY_GENERATION_INPUT_FINGERPRINT="$input_fingerprint"
}

dependency_generation_select_inputs() {
  local input_root="$1" generation_root="$2" input_fingerprint
  input_fingerprint="$(dependency_generation_input_fingerprint "$input_root")" || return 1
  dependency_generation_select_input_fingerprint "$input_fingerprint" "$generation_root"
}

dependency_generation_marker_matches() {
  local generation="$1" expected_identity="$2"
  local marker="$generation/.papercusp-dependency-generation"
  [ -d "$generation/tree" ] && [ -f "$marker" ] || return 1
  [ "$(dependency_generation_read_field "$marker" identity)" = "$expected_identity" ] \
    && [ -n "$(dependency_generation_read_field "$marker" snapshot)" ]
}

# Open one already-published immutable generation by its exact identity without
# consulting the mutable live node_modules tree. Checkpoint setup selects the
# identity before it waits for exclusive materialization capacity, then calls
# this helper after the wait; re-deriving an identity at that later point would
# silently move the input if an install landed in between (P-006 / WI-41199).
# Sets the same DEPENDENCY_GENERATION_* outputs as dependency_generation_ensure.
dependency_generation_select() {
  local generation_root="$1" identity="$2"
  local generation marker source
  if [[ ! "$identity" =~ ^v1-[0-9a-f]{64}$ ]]; then
    dependency_generation_log "FATAL: invalid dependency-generation identity: $identity"
    return 2
  fi
  generation="$generation_root/$identity"
  if ! dependency_generation_is_valid "$generation" "$identity"; then
    dependency_generation_log "FATAL: dependency generation $identity is missing or invalid"
    return 74
  fi
  marker="$generation/.papercusp-dependency-generation"
  source="$(dependency_generation_read_field "$marker" source)"
  if [ -z "$source" ]; then
    dependency_generation_log "FATAL: dependency generation $identity has no source fingerprint"
    return 74
  fi
  DEPENDENCY_GENERATION_ID="$identity"
  DEPENDENCY_GENERATION_PATH="$generation"
  DEPENDENCY_GENERATION_TREE="$generation/tree"
  DEPENDENCY_GENERATION_SOURCE_FINGERPRINT="$source"
  DEPENDENCY_GENERATION_REUSED='true'
}

dependency_generation_writer_is_live() {
  local marker="$1" expected_host="$2" owner_host owner_pid
  [ -f "$marker" ] || return 1
  owner_host="$(dependency_generation_read_field "$marker" host)"
  owner_pid="$(dependency_generation_read_field "$marker" pid)"
  [ "$owner_host" = "$expected_host" ] || return 0
  case "$owner_pid" in
    ''|*[!0-9]*) return 1 ;;
  esac
  kill -0 "$owner_pid" 2>/dev/null
}

dependency_generation_path_is_old() {
  local path="$1" min_age="${2:-300}" mtime now
  mtime="$(stat -c '%Y' "$path" 2>/dev/null || stat -f '%m' "$path" 2>/dev/null || true)"
  case "$mtime" in
    ''|*[!0-9]*) return 1 ;;
  esac
  now="$(date +%s)"
  [ $((now - mtime)) -ge "$min_age" ]
}

# A killed publisher may leave a large writable build tree or the tiny publish
# lock behind. Reclaim only same-host state whose recorded PID is no longer
# alive; foreign-host state remains fail-closed. Quarantine a stale lock so its
# ownership record survives inspection.
dependency_generation_cleanup_abandoned() {
  local generation_root="$1" host build marker lock quarantine
  host="$(dependency_generation_host)"
  for build in "$generation_root"/.build-*; do
    [ -d "$build" ] || continue
    marker="$build/.papercusp-generation-writer"
    if { [ -f "$marker" ] && ! dependency_generation_writer_is_live "$marker" "$host"; } \
      || { [ ! -f "$marker" ] && dependency_generation_path_is_old "$build"; }; then
      dependency_generation_log "removing abandoned build $(basename "$build")"
      chmod -R u+w "$build" 2>/dev/null || true
      rm -rf -- "$build"
    fi
  done

  lock="$generation_root/.publish-lock"
  if [ -d "$lock" ] \
    && { { [ -f "$lock/writer" ] && ! dependency_generation_writer_is_live "$lock/writer" "$host"; } \
      || { [ ! -f "$lock/writer" ] && dependency_generation_path_is_old "$lock"; }; }; then
    quarantine="$generation_root/.stale-publish-lock.$(date +%s).$$"
    if mv "$lock" "$quarantine" 2>/dev/null; then
      dependency_generation_log "quarantined abandoned publish lock as $(basename "$quarantine")"
    fi
  fi
}

dependency_generation_write_owner() {
  local marker="$1" owner_pid="${2:-$$}" process_start="${3:-}"
  [ -n "$process_start" ] || process_start="$(dependency_generation_process_start "$owner_pid" || true)"
  printf 'host=%s\npid=%s\nstarted=%s\nprocess_start=%s\n' \
    "$(dependency_generation_host)" "$owner_pid" "$(date +%s)" "$process_start" > "$marker"
}

# A PID alone is not an identity: the kernel can recycle it while a selector
# lease survives. Linux start ticks are stable for that process's lifetime;
# ps lstart supplies the same discriminator on hosts without procfs.
dependency_generation_process_start() {
  local pid="$1" value
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  if [ -r "/proc/$pid/stat" ]; then
    value="$(sed -E 's/^.*\) //' "/proc/$pid/stat" | awk '{ print $20 }')"
    case "$value" in ''|*[!0-9]*) return 1 ;; esac
    printf 'proc:%s\n' "$value"
    return 0
  fi
  value="$(ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^ *//; s/ *$//')"
  [ -n "$value" ] || return 1
  printf 'ps:%s\n' "$value"
}

# Name the current holder, so a timeout distinguishes ordinary contention from
# a wedged writer instead of leaving the reader to guess from a bare "timed out".
dependency_generation_publish_lock_holder() {
  local lock="$1" marker="$1/writer" host pid started now
  if [ ! -f "$marker" ]; then
    [ -d "$lock" ] || { printf 'released-during-wait'; return 0; }
    printf 'unknown-writer'
    return 0
  fi
  host="$(dependency_generation_read_field "$marker" host)"
  pid="$(dependency_generation_read_field "$marker" pid)"
  started="$(dependency_generation_read_field "$marker" started)"
  case "$started" in
    ''|*[!0-9]*) printf 'host=%s pid=%s' "${host:-?}" "${pid:-?}" ; return 0 ;;
  esac
  now="$(date +%s)"
  printf 'host=%s pid=%s held=%ss' "${host:-?}" "${pid:-?}" "$((now - started))"
}

# The retry loop below calls cleanup_abandoned on EVERY failed mkdir, and that
# reclaims a same-host lock whose writer PID is dead within one 0.1s tick. So
# this budget is never spent waiting on an abandoned lock: it is only ever
# reached while the holder is genuinely ALIVE (or is a foreign-host writer,
# which writer_is_live preserves fail-closed on purpose). A live holder may
# legitimately be inside the full-tree validation walk taken on the
# replacement/removal race, or a retention prune — both of which run for
# minutes on a multi-GB generation. The old 300-attempt (30s) budget was
# therefore a BOUNDED waiter against an UNBOUNDED holder, and turned ordinary
# contention into a hard exit 73 that crashed the caller outright:
# green-checkpoint recorded `inconclusive: error` and never ran a suite at all.
# Wait long enough to outlast a legitimate hold, log progress so a long wait is
# not mistaken for a hang, and name the holder if it really does time out.
# The budget is WALL-CLOCK, not an attempt count: each iteration also runs
# cleanup_abandoned (a directory scan), so attempts*0.1s understates real elapsed
# time by an amount that grows with the size of the generation store. Counting
# attempts made both the budget and every message it printed a lie.
dependency_generation_acquire_publish_lock() {
  local generation_root="$1" lock timeout_sec started now waited next_notice
  timeout_sec="${DEPENDENCY_GENERATION_PUBLISH_LOCK_TIMEOUT_SEC:-900}"
  case "$timeout_sec" in
    ''|*[!0-9]*) timeout_sec=900 ;;
  esac
  lock="$generation_root/.publish-lock"
  started="$(date +%s)"
  next_notice=30
  while ! mkdir "$lock" 2>/dev/null; do
    dependency_generation_cleanup_abandoned "$generation_root"
    # Cleanup may have just quarantined a dead writer's lock. Retry acquisition
    # before enforcing the deadline; otherwise a short budget can return 73
    # while the lock is already free (the dead-writer test uses a zero budget).
    if mkdir "$lock" 2>/dev/null; then
      break
    fi
    now="$(date +%s)"
    waited=$((now - started))
    if [ "$waited" -ge "$timeout_sec" ]; then
      dependency_generation_log "FATAL: timed out waiting for the short dependency-generation publish lock after ${waited}s of ${timeout_sec}s (holder $(dependency_generation_publish_lock_holder "$lock"))"
      return 73
    fi
    if [ "$waited" -ge "$next_notice" ]; then
      dependency_generation_log "still waiting for the dependency-generation publish lock after ${waited}s of ${timeout_sec}s (holder $(dependency_generation_publish_lock_holder "$lock"))"
      next_notice=$((waited + 30))
    fi
    sleep 0.1
  done
  dependency_generation_write_owner "$lock/writer"
  DEPENDENCY_GENERATION_PUBLISH_LOCK="$lock"
}

dependency_generation_release_publish_lock() {
  local lock="${DEPENDENCY_GENERATION_PUBLISH_LOCK:-}"
  [ -n "$lock" ] || return 0
  rm -f -- "$lock/writer"
  rmdir "$lock" 2>/dev/null || true
  DEPENDENCY_GENERATION_PUBLISH_LOCK=''
}

# Exact-ID consumers need protection before the expensive validation walk and
# until their checkout marker has been published. A lease is deliberately
# process-owned: same-host dead readers are reclaimable; a foreign-host reader
# is preserved fail-closed because kill(2) cannot prove its liveness.
dependency_generation_acquire_selector_lease() {
  local generation_root="$1" identity="$2" owner_pid="${3:-$$}" expected_token="${4:-}"
  local lease current_token owner_start
  if [[ ! "$identity" =~ ^v1-[0-9a-f]{64}$ ]]; then
    dependency_generation_log "FATAL: invalid dependency-generation lease identity: $identity"
    return 2
  fi
  case "$owner_pid" in
    ''|*[!0-9]*)
      dependency_generation_log "FATAL: invalid dependency-generation lease owner pid: $owner_pid"
      return 2
      ;;
  esac
  owner_start="$(dependency_generation_process_start "$owner_pid" || true)"
  if [ -z "$owner_start" ]; then
    dependency_generation_log "FATAL: dependency-generation lease owner pid is not live: $owner_pid"
    return 74
  fi
  dependency_generation_acquire_publish_lock "$generation_root" || return $?
  if ! dependency_generation_marker_matches "$generation_root/$identity" "$identity"; then
    dependency_generation_release_publish_lock
    dependency_generation_log "FATAL: dependency generation $identity disappeared before it could be leased"
    return 74
  fi
  if [ -n "$expected_token" ]; then
    current_token="$(
      dependency_generation_selector_token "$generation_root/$identity" 2>/dev/null || true
    )"
    if [ "$current_token" != "$expected_token" ]; then
      dependency_generation_release_publish_lock
      dependency_generation_log \
        "FATAL: dependency generation $identity was replaced before its selection lease could be acquired"
      return 74
    fi
  fi
  dependency_generation_ensure_store_root "$generation_root" "$generation_root/.leases"
  lease="$generation_root/.leases/selector-$$-$(date +%s)-${RANDOM:-0}"
  if [ "$(dependency_generation_process_start "$owner_pid" || true)" != "$owner_start" ]; then
    dependency_generation_release_publish_lock
    dependency_generation_log "FATAL: dependency-generation lease owner process changed: $owner_pid"
    return 74
  fi
  dependency_generation_write_owner "$lease" "$owner_pid" "$owner_start"
  printf 'identity=%s\n' "$identity" >> "$lease"
  if [ "$(dependency_generation_process_start "$owner_pid" || true)" != "$owner_start" ]; then
    rm -f -- "$lease"
    dependency_generation_release_publish_lock
    dependency_generation_log "FATAL: dependency-generation lease owner process changed during acquisition: $owner_pid"
    return 74
  fi
  DEPENDENCY_GENERATION_SELECTOR_LEASE="$lease"
  dependency_generation_release_publish_lock
}

dependency_generation_release_selector_lease() {
  local lease="${DEPENDENCY_GENERATION_SELECTOR_LEASE:-}"
  [ -n "$lease" ] || return 0
  rm -f -- "$lease"
  rmdir "$(dirname "$lease")" 2>/dev/null || true
  DEPENDENCY_GENERATION_SELECTOR_LEASE=''
}

DEPENDENCY_GENERATION_PREDECESSOR_ID=''
DEPENDENCY_GENERATION_PREDECESSOR_PATH=''
DEPENDENCY_GENERATION_PREDECESSOR_TREE=''
DEPENDENCY_GENERATION_PREDECESSOR_MANIFEST=''

# Select and lease the newest compatible generation that carries the durable
# per-tree reuse contract. The lease prevents retention from pruning it while
# the build seeds hardlinks/reflinks. Deep validation plus an unchanged O(1)
# object token proves that the exact immutable predecessor we inspected is still
# the one we copy. Legacy generations deliberately miss this path and retain the
# historical full-copy fallback.
dependency_generation_find_reusable_predecessor() {
  local generation_root="$1" target_identity="$2"
  local generation identity marker created record token_before token_after
  local ranked=()
  DEPENDENCY_GENERATION_PREDECESSOR_ID=''
  DEPENDENCY_GENERATION_PREDECESSOR_PATH=''
  DEPENDENCY_GENERATION_PREDECESSOR_TREE=''
  DEPENDENCY_GENERATION_PREDECESSOR_MANIFEST=''

  mapfile -t ranked < <(
    for generation in "$generation_root"/v1-*; do
      [ -d "$generation" ] || continue
      identity="$(basename "$generation")"
      [[ "$identity" =~ ^v1-[0-9a-f]{64}$ ]] || continue
      [ "$identity" != "$target_identity" ] || continue
      marker="$generation/.papercusp-dependency-generation"
      [ "$(dependency_generation_read_field "$marker" closure)" \
          = "$DEPENDENCY_GENERATION_CLOSURE_FINGERPRINT" ] || continue
      [ "$(dependency_generation_read_field "$marker" scope)" \
          = "$DEPENDENCY_GENERATION_SCOPE_MODE" ] || continue
      created="$(dependency_generation_created_order_ns "$marker")"
      printf '%020d %s\n' "$created" "$identity"
    done | sort -k1,1nr -k2,2r
  )

  for record in "${ranked[@]}"; do
    identity="${record#* }"
    generation="$generation_root/$identity"
    [ -f "$generation/.tree-manifest" ] || continue
    if ! dependency_generation_acquire_selector_lease "$generation_root" "$identity"; then
      continue
    fi
    token_before="$(dependency_generation_generation_token "$generation" 2>/dev/null || true)"
    if [ -n "$token_before" ] \
      && dependency_generation_is_valid \
        "$generation" "$identity" "$DEPENDENCY_GENERATION_CLOSURE_FINGERPRINT"; then
      token_after="$(dependency_generation_generation_token "$generation" 2>/dev/null || true)"
      if [ "$token_after" = "$token_before" ]; then
        DEPENDENCY_GENERATION_PREDECESSOR_ID="$identity"
        DEPENDENCY_GENERATION_PREDECESSOR_PATH="$generation"
        DEPENDENCY_GENERATION_PREDECESSOR_TREE="$generation/tree"
        DEPENDENCY_GENERATION_PREDECESSOR_MANIFEST="$generation/.tree-manifest"
        dependency_generation_log "selected reusable immutable predecessor $identity"
        return 0
      fi
    fi
    dependency_generation_log "skipping invalid or replaced predecessor $identity"
    dependency_generation_release_selector_lease
  done
  return 1
}

dependency_generation_write_pin_locked() {
  local generation_root="$1" checkout="$2" identity="$3"
  local marker pin_key pin tmp
  if [[ ! "$identity" =~ ^v1-[0-9a-f]{64}$ ]]; then
    return 2
  fi
  checkout="$(cd "$checkout" 2>/dev/null && pwd -P)" || return 1
  case "$checkout" in *$'\n'*) return 2 ;; esac
  marker="$checkout/node_modules/.papercusp-dependency-generation"
  [ -f "$marker" ] || return 1
  [ "$(dependency_generation_read_field "$marker" identity)" = "$identity" ] || return 1
  dependency_generation_marker_matches "$generation_root/$identity" "$identity" || return 1
  dependency_generation_ensure_store_root "$generation_root" "$generation_root/.pins"
  pin_key="$(printf '%s' "$checkout" | dependency_generation_sha256)" || return 1
  pin="$generation_root/.pins/checkout-$pin_key"
  tmp="$pin.tmp.$$"
  printf 'schema=1\nhost=%s\nidentity=%s\ncheckout=%s\nupdated=%s\n' \
    "$(dependency_generation_host)" "$identity" "$checkout" "$(date +%s)" > "$tmp"
  mv "$tmp" "$pin"
}

dependency_generation_register_pin() {
  local generation_root="$1" checkout="$2" identity="$3" rc=0
  dependency_generation_acquire_publish_lock "$generation_root" || return $?
  dependency_generation_write_pin_locked "$generation_root" "$checkout" "$identity" || rc=$?
  dependency_generation_release_publish_lock
  if [ "$rc" -ne 0 ]; then
    dependency_generation_log "FATAL: could not register checkout pin for $identity at $checkout"
  fi
  return "$rc"
}

# Refresh same-host pin/lease truth and import direct sibling checkout markers.
# This runs only while .publish-lock is held, so pruning cannot race a pin that
# is being registered or a selector that is being leased.
# WI-42354 CLASS GUARD: create the generation store ROOT (plus any subdirs asked
# for) and make it self-ignoring, so a store is born un-committable wherever it is
# created — including in a pot that does not exist yet.
#
# WHY: this store is HOST-LOCAL RUNTIME STATE — selector leases, materialized trees,
# and pin files whose only mutating field is `updated=<epoch>`. Nothing reads it out
# of git history (its sole consumer reads the live filesystem). But it lives INSIDE
# git working trees, so every run rewrote a pin heartbeat, git-sync committed the
# churn, the pot's tip moved, and the NEXT run saw "changes" and re-materialized from
# scratch: perpetual motion that kept ~20 hourly gates redoing full setup and starved
# the box of materialization slots. Untracking it in the 7 repos that exist today was
# the data fix; this is the guard that stops the class from coming back.
#
# A '*' pattern ignores every path under this directory INCLUDING the .gitignore
# itself. That is deliberate on both counts: nothing here should ever reach git, and
# a self-ignoring marker needs no cooperation from the enclosing repo's .gitignore —
# which is precisely what a newly-created pot will not yet have.
#
# Best-effort by design: a read-only store, or a peer racing the same create, must
# never fail a materialization over a hygiene file, so the write is guarded and the
# helper still returns success. mkdir failure DOES propagate — that one is fatal.
dependency_generation_ensure_store_root() {
  local root="$1"
  shift
  mkdir -p "$root" "$@" || return $?
  [ -e "$root/.gitignore" ] || printf '*\n' > "$root/.gitignore" 2>/dev/null || true
  return 0
}

dependency_generation_refresh_retention_state_locked() {
  local generation_root="$1" integration_root="$2"
  local host pin pin_host identity checkout marker lease lease_host lease_pid lease_start current_start parent sibling
  host="$(dependency_generation_host)"
  dependency_generation_ensure_store_root "$generation_root" "$generation_root/.pins" "$generation_root/.leases"

  for pin in "$generation_root"/.pins/*; do
    [ -f "$pin" ] || continue
    pin_host="$(dependency_generation_read_field "$pin" host)"
    identity="$(dependency_generation_read_field "$pin" identity)"
    checkout="$(dependency_generation_read_field "$pin" checkout)"
    # A foreign-host pin is intentionally retained: this host cannot prove the
    # other checkout disappeared. Same-host state must still match the checkout
    # marker and an extant published generation.
    if [ -n "$pin_host" ] && [ "$pin_host" != "$host" ]; then
      if [[ "$identity" =~ ^v1-[0-9a-f]{64}$ ]] \
        && dependency_generation_marker_matches "$generation_root/$identity" "$identity"; then
        continue
      fi
      dependency_generation_log "removing malformed foreign checkout pin $(basename "$pin")"
      rm -f -- "$pin"
      continue
    fi
    marker="$checkout/node_modules/.papercusp-dependency-generation"
    if [[ ! "$identity" =~ ^v1-[0-9a-f]{64}$ ]] \
      || [ ! -f "$marker" ] \
      || [ "$(dependency_generation_read_field "$marker" identity)" != "$identity" ] \
      || ! dependency_generation_marker_matches "$generation_root/$identity" "$identity"; then
      dependency_generation_log "removing stale checkout pin $(basename "$pin")"
      rm -f -- "$pin"
    fi
  done

  for lease in "$generation_root"/.leases/*; do
    [ -f "$lease" ] || continue
    lease_host="$(dependency_generation_read_field "$lease" host)"
    lease_pid="$(dependency_generation_read_field "$lease" pid)"
    lease_start="$(dependency_generation_read_field "$lease" process_start)"
    identity="$(dependency_generation_read_field "$lease" identity)"
    if [ -n "$lease_host" ] && [ "$lease_host" != "$host" ] \
      && [[ "$identity" =~ ^v1-[0-9a-f]{64}$ ]]; then
      continue
    fi
    current_start=''
    if [[ "$lease_pid" =~ ^[0-9]+$ ]]; then
      current_start="$(dependency_generation_process_start "$lease_pid" || true)"
    fi
    if [[ ! "$identity" =~ ^v1-[0-9a-f]{64}$ ]] \
      || [[ ! "$lease_pid" =~ ^[0-9]+$ ]] \
      || [ -z "$current_start" ] \
      || { [ -n "$lease_start" ] && [ "$lease_start" != "$current_start" ]; } \
      || { [ -z "$lease_start" ] && dependency_generation_path_is_old "$lease" 86400; }; then
      dependency_generation_log "removing stale selector lease $(basename "$lease")"
      rm -f -- "$lease"
    fi
  done

  integration_root="$(cd "$integration_root" && pwd -P)" || return 1
  parent="$(dirname "$integration_root")"
  for sibling in "$parent"/*; do
    [ -d "$sibling" ] || continue
    sibling="$(cd "$sibling" 2>/dev/null && pwd -P)" || continue
    [ "$sibling" != "$integration_root" ] || continue
    marker="$sibling/node_modules/.papercusp-dependency-generation"
    [ -f "$marker" ] || continue
    identity="$(dependency_generation_read_field "$marker" identity)"
    [[ "$identity" =~ ^v1-[0-9a-f]{64}$ ]] || continue
    dependency_generation_marker_matches "$generation_root/$identity" "$identity" || continue
    dependency_generation_write_pin_locked "$generation_root" "$sibling" "$identity" || true
  done
}

DEPENDENCY_GENERATION_PRUNE_QUARANTINES=()

# Input selectors are durable lookup records, not retention roots. When a
# generation ages out, remove every selector that names it while the same
# publish lock is still held. Leaving the selector behind creates a permanent
# fail-closed trap: an exact-candidate consumer keeps resolving the deleted
# identity and reports an invalid publication token instead of the ordinary
# "no prewarmed generation" miss that lets the producer rebuild the key.
dependency_generation_remove_input_selectors_for_identity_locked() {
  local generation_root="$1" identity="$2" selector selected_identity
  for selector in "$generation_root"/.inputs/*; do
    [ -f "$selector" ] || continue
    selected_identity="$(dependency_generation_read_field "$selector" identity)"
    [ "$selected_identity" = "$identity" ] || continue
    if ! rm -f -- "$selector"; then
      dependency_generation_log \
        "FATAL: could not remove input selector $(basename "$selector") for pruned generation $identity"
      return 1
    fi
    dependency_generation_log \
      "removed input selector $(basename "$selector") for pruned generation $identity"
  done
}

dependency_generation_quarantine_unretained_locked() {
  local generation_root="$1" retain_count="${DEPENDENCY_GENERATION_RETAIN_COUNT:-2}"
  local protected=' ' generation identity created pin lease kept=0 quarantine
  local ranked=()
  if [[ ! "$retain_count" =~ ^[0-9]+$ ]] || [ "$retain_count" -lt 1 ]; then
    dependency_generation_log "FATAL: DEPENDENCY_GENERATION_RETAIN_COUNT must be an integer >= 1"
    return 2
  fi

  mapfile -t ranked < <(
    for generation in "$generation_root"/v1-*; do
      [ -d "$generation" ] || continue
      identity="$(basename "$generation")"
      [[ "$identity" =~ ^v1-[0-9a-f]{64}$ ]] || continue
      created="$(dependency_generation_created_order_ns "$generation/.papercusp-dependency-generation")"
      printf '%020d %s\n' "$created" "$identity"
    done | sort -k1,1nr -k2,2r
  )
  for generation in "${ranked[@]}"; do
    identity="${generation#* }"
    if [ "$kept" -lt "$retain_count" ]; then
      protected="$protected$identity "
      kept=$((kept + 1))
    fi
  done
  for pin in "$generation_root"/.pins/*; do
    [ -f "$pin" ] || continue
    identity="$(dependency_generation_read_field "$pin" identity)"
    [[ "$identity" =~ ^v1-[0-9a-f]{64}$ ]] && protected="$protected$identity "
  done
  for lease in "$generation_root"/.leases/*; do
    [ -f "$lease" ] || continue
    identity="$(dependency_generation_read_field "$lease" identity)"
    [[ "$identity" =~ ^v1-[0-9a-f]{64}$ ]] && protected="$protected$identity "
  done

  DEPENDENCY_GENERATION_PRUNE_QUARANTINES=()
  # A prior process can die after the atomic rename but before deletion. These
  # paths are already outside the exact-ID namespace, so finish that deferred
  # deletion after this lock is released instead of letting crash residue grow.
  #
  # WI-888766: `.invalid-*` is swept on exactly the same terms as `.prune-*`, and
  # needs no age floor. Both are created by an atomic `mv` while the publish lock
  # is held — `.invalid-*` by the publish path in dependency_generation_ensure,
  # which quarantines a losing incumbent and republishes as "one serialized
  # operation" under that lock — so reaching this loop already proves no peer is
  # mid-quarantine and nothing can be yanked out from under a live validator.
  #
  # Until this line, NOTHING collected `.invalid-*`: it was created and never
  # enumerated again anywhere in the repo. Being a dotfile, it was invisible even
  # to the `v1-*` census glob above, so it did not register as a generation at
  # all. Each one is a full node_modules materialization (~13 GiB here), so three
  # dead quarantines had stranded 39 GiB for 2-4 days and put the root filesystem
  # at 95%, which in turn made the cargo lane's disk-headroom admission REFUSE to
  # run and red-pinned @papercusp/desktop in the gate.
  for quarantine in "$generation_root"/.prune-* "$generation_root"/.invalid-* "$generation_root"/.stale-publish-lock.*; do
    [ -d "$quarantine" ] || continue
    # A stale publish lock holds only its writer record, which is useful for
    # post-mortem inspection. Keep it for a day after the atomic quarantine
    # rename; directory mtime may predate that rename, so use its name's epoch.
    case "$quarantine" in
      "$generation_root"/.stale-publish-lock.*)
        local quarantine_epoch="${quarantine##*.stale-publish-lock.}"
        quarantine_epoch="${quarantine_epoch%%.*}"
        case "$quarantine_epoch" in ''|*[!0-9]*) continue ;; esac
        [ $(( $(date +%s) - quarantine_epoch )) -ge 86400 ] || continue
        ;;
    esac
    DEPENDENCY_GENERATION_PRUNE_QUARANTINES+=("$quarantine")
  done
  for generation in "$generation_root"/v1-*; do
    [ -d "$generation" ] || continue
    identity="$(basename "$generation")"
    case "$protected" in *" $identity "*) continue ;; esac
    dependency_generation_remove_input_selectors_for_identity_locked \
      "$generation_root" "$identity" || return $?
    quarantine="$generation_root/.prune-$identity-$(date +%s)-$$"
    if mv "$generation" "$quarantine"; then
      dependency_generation_log "quarantined unretained generation $identity"
      DEPENDENCY_GENERATION_PRUNE_QUARANTINES+=("$quarantine")
    fi
  done
}

dependency_generation_delete_prune_quarantines() {
  local quarantine
  for quarantine in "${DEPENDENCY_GENERATION_PRUNE_QUARANTINES[@]:-}"; do
    [ -d "$quarantine" ] || continue
    # Checkouts may hardlink generation FILES. Changing their modes here would
    # mutate the retained checkout inode too; directory write permission alone
    # is sufficient for unlinking.
    find "$quarantine" -type d -exec chmod u+rwx {} + 2>/dev/null || true
    rm -rf -- "$quarantine"
  done
  DEPENDENCY_GENERATION_PRUNE_QUARANTINES=()
}

dependency_generation_apply_retention() {
  local generation_root="$1" integration_root="$2" rc=0
  dependency_generation_acquire_publish_lock "$generation_root" || return $?
  dependency_generation_refresh_retention_state_locked "$generation_root" "$integration_root" || rc=$?
  if [ "$rc" -eq 0 ]; then
    dependency_generation_quarantine_unretained_locked "$generation_root" || rc=$?
  fi
  dependency_generation_release_publish_lock
  dependency_generation_delete_prune_quarantines
  return "$rc"
}

dependency_generation_copy_independent() {
  local src="$1" dest="$2"
  mkdir -p "$(dirname "$dest")"
  # GNU cp uses a CoW clone where available and a regular independent copy
  # otherwise. BSD/BusyBox cp reject --reflink; retry with portable `cp -a`.
  if cp -a --reflink=auto "$src" "$dest" 2>/dev/null; then
    return 0
  fi
  rm -rf -- "$dest"
  cp -a "$src" "$dest"
}

dependency_generation_prune_ephemeral() {
  local root="$1"
  [ -d "$root" ] || return 0
  # npm rewrites node_modules/.package-lock.json during install bookkeeping. It
  # is internal metadata, not a runtime dependency, and older hardlink-based
  # release trees can share its inode with the integration tree. Astro, Vitest,
  # and Storybook likewise mutate .astro/.vite/.vite-temp or the conventional
  # node_modules/.cache root while a dependency generation is being copied.
  # None belong in an immutable generation: retaining or fingerprinting them can
  # false-fail rc75 on unrelated churn.
  #
  # `.verdict-data` is the same class found the expensive way (WI-871887, 2026-08-30):
  # verdict-cli persists PER-AGENT SESSION STATE inside its own installed package directory
  # (node_modules/verdict-cli/.verdict-data/sessions/<agent-id>). One peer running a browser
  # check during the ~22min copy changed the source fingerprint and cost the whole gate run —
  # green:null, no verdict. With ~100 agents using that skill the window was close to
  # unwinnable, which is why the gate went days without rendering a verdict while merely
  # LOOKING red. The general defect is mutable runtime state living inside node_modules; this
  # prune list is the gate's defence against whichever package does it next.
  # `.papercusp-isolated-snapshot` is provenance for a MATERIALIZED release
  # checkout, not dependency content. A checkpoint tree can legitimately be a
  # later publisher input; copying that marker into an immutable generation and
  # freezing it read-only makes the next pinned materialization fail when
  # setup-release-checkout replaces the marker with the NEW generation id.
  # Strip it at the generation boundary just like npm's local bookkeeping.
  rm -f -- "$root/.package-lock.json" "$root/.papercusp-isolated-snapshot"
  rm -rf -- "$root/.cache"
  find "$root" -type d \
    \( -name .astro -o -name .vite -o -name .vite-temp -o -name .verdict-data \) \
    -exec rm -rf -- {} +
}

# Materialize from an immutable generation. Independent copy/reflink materialization
# is the default: a release leg may run patchers or package tooling that changes files
# in its checkout, and a hardlink would turn that write into a mutation of the
# supposedly immutable generation (or of a predecessor that was itself hardlinked
# to a live checkout). Hardlinks remain an explicit opt-in for callers that have
# independently proved the source tree is immutable and never patched.
dependency_generation_materialize_tree() {
  local src="$1" dest="$2" tmp old
  local source_device dest_device mode='copy'
  tmp="${dest}.generation-tmp.$$"
  old="${dest}.generation-old.$$"
  rm -rf -- "$tmp" "$old"
  mkdir -p "$(dirname "$dest")"
  source_device="$(dependency_generation_device "$src")" || return 1
  dest_device="$(dependency_generation_device "$(dirname "$dest")")" || return 1
  if [ "${DEPENDENCY_GENERATION_ALLOW_HARDLINK:-0}" = '1' ] \
    && [ "${DEPENDENCY_GENERATION_FORCE_COPY:-0}" != '1' ] \
    && [ "$source_device" = "$dest_device" ]; then
    if cp -al "$src" "$tmp" 2>/dev/null; then
      mode='hardlink'
    else
      rm -rf -- "$tmp"
    fi
  fi
  if [ ! -d "$tmp" ]; then
    dependency_generation_copy_independent "$src" "$tmp"
  fi
  if [ -e "$dest" ]; then
    mv "$dest" "$old"
    mv "$tmp" "$dest"
    # A hardlink opt-in shares file inodes with the immutable generation, while
    # directories remain distinct. Make only retired directories writable so
    # rm -rf can remove their entries; recursively chmodding files would
    # mutate the published generation before deleting the retired checkout.
    find "$old" -type d -exec chmod u+rwx {} + 2>/dev/null || true
    rm -rf -- "$old"
  else
    mv "$tmp" "$dest"
  fi
  DEPENDENCY_GENERATION_MATERIALIZE_MODE="$mode"
}

dependency_generation_remove_build() {
  local build="$1"
  [ -e "$build" ] || return 0
  chmod -R u+w "$build" 2>/dev/null || true
  rm -rf -- "$build"
}

# Sets DEPENDENCY_GENERATION_{ID,PATH,TREE,SOURCE_FINGERPRINT,REUSED}.
dependency_generation_ensure() {
  local integration_root="$1"
  local generation_root="${2:-$integration_root/.papercusp/dependency-generations}"
  local source_before='' source_after='' identity generation build tree nm rel snapshot marker
  local quarantine before_manifest='' after_manifest='' tree_manifest='' tree_manifest_digest=''
  local publication_token='' created_ns=''
  local incumbent_token_before incumbent_token_after incumbent_token
  local current_incumbent_token publish_replacement publish_rc
  local total_started_ms phase_started_ms tree_total=0 tree_reused=0 tree_copied=0 tree_removed=0
  local predecessor_identity='none'
  local predecessor_fingerprint record_fingerprint extra reuse_manifest_eligible='false'
  local existing_generation_valid='false' cache_validation_outcome='miss'
  total_started_ms="$(dependency_generation_now_ms)"
  if [ -z "${DEPENDENCY_GENERATION_CLOSURE_FINGERPRINT:-}" ]; then
    dependency_generation_configure_workspace_dirs "$integration_root" || return $?
  fi
  dependency_generation_ensure_store_root "$generation_root"
  dependency_generation_cleanup_abandoned "$generation_root"

  build="$generation_root/.build-pending-$(dependency_generation_host)-$$-$(date +%s)"
  tree="$build/tree"
  before_manifest="$build/.source-before"
  after_manifest="$build/.source-after"
  mkdir -p "$tree"
  dependency_generation_write_owner "$build/.papercusp-generation-writer"
  dependency_generation_log 'capturing live dependency manifest (before copy)'
  phase_started_ms="$(dependency_generation_now_ms)"
  dependency_generation_set_manifest "$integration_root" > "$before_manifest" || {
    dependency_generation_emit_phase source-manifest-before "$phase_started_ms" failed
    dependency_generation_remove_build "$build"
    return 1
  }
  dependency_generation_emit_phase source-manifest-before "$phase_started_ms" ok
  source_before="$(dependency_generation_source_fingerprint "$before_manifest")" || {
    dependency_generation_remove_build "$build"
    return 1
  }
  tree_total="$(awk 'END { print NR + 0 }' "$before_manifest")"
  if dependency_generation_manifest_records_are_reusable "$before_manifest" "$integration_root"; then
    reuse_manifest_eligible='true'
  else
    dependency_generation_log \
      'live dependency manifest is not safe for incremental reuse; retaining full-copy compatibility'
  fi
  dependency_generation_log \
    "captured live dependency manifest (before copy): trees=$tree_total source=$source_before"
  identity="v1-$source_before"
  generation="$generation_root/$identity"
  incumbent_token_before="$(dependency_generation_generation_token "$generation" 2>/dev/null || true)"
  dependency_generation_log "validating existing generation $identity"
  phase_started_ms="$(dependency_generation_now_ms)"
  if dependency_generation_has_publication_contract "$generation"; then
    if dependency_generation_publication_is_valid \
      "$generation" "$identity" "$DEPENDENCY_GENERATION_CLOSURE_FINGERPRINT" \
      "$DEPENDENCY_GENERATION_SCOPE_MODE"; then
      existing_generation_valid='true'
      cache_validation_outcome='hot-hit'
    elif dependency_generation_deep_audit \
      "$generation" "$identity" "$DEPENDENCY_GENERATION_CLOSURE_FINGERPRINT"; then
      cache_validation_outcome='token-invalid-deep-valid'
      dependency_generation_log \
        "publication token invalid for content-valid generation $identity; rebuilding immutable metadata"
    else
      cache_validation_outcome='token-invalid-deep-invalid'
      dependency_generation_log \
        "publication token and deep audit invalid for generation $identity"
    fi
  elif dependency_generation_deep_audit \
    "$generation" "$identity" "$DEPENDENCY_GENERATION_CLOSURE_FINGERPRINT"; then
    existing_generation_valid='true'
    cache_validation_outcome='legacy-deep-hit'
  fi
  dependency_generation_emit_phase \
    cache-validation "$phase_started_ms" "$cache_validation_outcome"
  if [ "$existing_generation_valid" = 'true' ]; then
    dependency_generation_log "validated existing generation $identity; confirming live source stability"
    dependency_generation_log 'capturing live dependency manifest (after existing-generation validation)'
    phase_started_ms="$(dependency_generation_now_ms)"
    dependency_generation_set_manifest "$integration_root" > "$after_manifest" || {
      dependency_generation_emit_phase source-manifest-after-cache "$phase_started_ms" failed
      dependency_generation_remove_build "$build"
      return 1
    }
    dependency_generation_emit_phase source-manifest-after-cache "$phase_started_ms" ok
    source_after="$(dependency_generation_source_fingerprint "$after_manifest")" || {
      dependency_generation_remove_build "$build"
      return 1
    }
    dependency_generation_log \
      "captured live dependency manifest (after existing-generation validation): trees=$(wc -l < "$after_manifest") source=$source_after"
    if [ "$source_after" != "$source_before" ]; then
      dependency_generation_log_manifest_delta "$before_manifest" "$after_manifest"
      dependency_generation_emit_summary \
        torn-cache-hit "$total_started_ms" "$source_before" "$identity" \
        "$predecessor_identity" "$tree_total" 0 0 0
      dependency_generation_remove_build "$build"
      dependency_generation_log 'FATAL: live node_modules changed while pinning an existing generation'
      return 75
    fi
    dependency_generation_remove_build "$build"
    DEPENDENCY_GENERATION_ID="$identity"
    DEPENDENCY_GENERATION_PATH="$generation"
    DEPENDENCY_GENERATION_TREE="$generation/tree"
    DEPENDENCY_GENERATION_SOURCE_FINGERPRINT="$source_before"
    DEPENDENCY_GENERATION_REUSED='true'
    tree_reused="$tree_total"
    dependency_generation_emit_summary \
      cache-hit "$total_started_ms" "$source_before" "$identity" \
      "$predecessor_identity" "$tree_total" "$tree_reused" 0 0
    return 0
  fi
  # Keep the token only when the same directory was the object that failed the
  # initial validation. If a concurrent publisher replaced it during that walk,
  # force the serialized path below to perform its full validation instead.
  incumbent_token_after="$(dependency_generation_generation_token "$generation" 2>/dev/null || true)"
  if [ -n "$incumbent_token_before" ] \
    && [ "$incumbent_token_before" = "$incumbent_token_after" ]; then
    incumbent_token="$incumbent_token_after"
  else
    incumbent_token=''
  fi

  if [ "$reuse_manifest_eligible" = 'true' ] \
    && dependency_generation_find_reusable_predecessor "$generation_root" "$identity"; then
    predecessor_identity="$DEPENDENCY_GENERATION_PREDECESSOR_ID"
  fi

  dependency_generation_log "building $identity from a stable live dependency snapshot"
  phase_started_ms="$(dependency_generation_now_ms)"
  if [ "$predecessor_identity" != 'none' ]; then
    while IFS=$'\t' read -r rel record_fingerprint extra; do
      nm="$integration_root/$rel"
      predecessor_fingerprint="$(
        dependency_generation_manifest_lookup \
          "$DEPENDENCY_GENERATION_PREDECESSOR_MANIFEST" "$rel" 2>/dev/null || true
      )"
      if [ -n "$predecessor_fingerprint" ] \
        && [ "$predecessor_fingerprint" = "$record_fingerprint" ]; then
        dependency_generation_log "reusing dependency tree from $predecessor_identity: $rel"
        if ! dependency_generation_materialize_tree \
          "$DEPENDENCY_GENERATION_PREDECESSOR_TREE/$rel" "$tree/$rel"; then
          dependency_generation_release_selector_lease
          dependency_generation_emit_phase tree-copy "$phase_started_ms" failed \
            "trees_reused=$tree_reused trees_copied=$tree_copied trees_removed=$tree_removed predecessor=$predecessor_identity"
          dependency_generation_remove_build "$build"
          return 1
        fi
        dependency_generation_prune_ephemeral "$tree/$rel"
        tree_reused=$((tree_reused + 1))
        dependency_generation_log \
          "reused dependency tree from $predecessor_identity: $rel mode=$DEPENDENCY_GENERATION_MATERIALIZE_MODE"
      else
        dependency_generation_log "copying changed dependency tree: $rel"
        if ! dependency_generation_copy_independent "$nm" "$tree/$rel"; then
          dependency_generation_release_selector_lease
          dependency_generation_emit_phase tree-copy "$phase_started_ms" failed \
            "trees_reused=$tree_reused trees_copied=$tree_copied trees_removed=$tree_removed predecessor=$predecessor_identity"
          dependency_generation_remove_build "$build"
          return 1
        fi
        dependency_generation_prune_ephemeral "$tree/$rel"
        tree_copied=$((tree_copied + 1))
        dependency_generation_log "copied changed dependency tree: $rel"
      fi
    done < "$before_manifest"
    while IFS=$'\t' read -r rel record_fingerprint extra; do
      if ! dependency_generation_manifest_lookup "$before_manifest" "$rel" >/dev/null; then
        tree_removed=$((tree_removed + 1))
      fi
    done < "$DEPENDENCY_GENERATION_PREDECESSOR_MANIFEST"
    dependency_generation_release_selector_lease
  else
    while IFS= read -r nm; do
      rel="${nm#"$integration_root"/}"
      dependency_generation_log "copying dependency tree: $rel"
      if ! dependency_generation_copy_independent "$nm" "$tree/$rel"; then
        dependency_generation_emit_phase tree-copy "$phase_started_ms" failed \
          "trees_reused=$tree_reused trees_copied=$tree_copied trees_removed=$tree_removed predecessor=$predecessor_identity"
        dependency_generation_remove_build "$build"
        return 1
      fi
      dependency_generation_prune_ephemeral "$tree/$rel"
      tree_copied=$((tree_copied + 1))
      dependency_generation_log "copied dependency tree: $rel"
    done < <(dependency_generation_enumerate_node_modules "$integration_root")
  fi
  dependency_generation_emit_phase tree-copy "$phase_started_ms" ok \
    "trees_reused=$tree_reused trees_copied=$tree_copied trees_removed=$tree_removed predecessor=$predecessor_identity"

  if [ -n "${DEPENDENCY_GENERATION_AFTER_COPY_HOOK:-}" ]; then
    bash -c "$DEPENDENCY_GENERATION_AFTER_COPY_HOOK"
  fi
  dependency_generation_log 'capturing live dependency manifest (after copy)'
  phase_started_ms="$(dependency_generation_now_ms)"
  dependency_generation_set_manifest "$integration_root" > "$after_manifest" 2>/dev/null || true
  source_after="$(dependency_generation_source_fingerprint "$after_manifest" 2>/dev/null || true)"
  if [ -n "$source_after" ]; then
    dependency_generation_emit_phase source-manifest-after-copy "$phase_started_ms" ok
  else
    dependency_generation_emit_phase source-manifest-after-copy "$phase_started_ms" failed
  fi
  dependency_generation_log \
    "captured live dependency manifest (after copy): trees=$(wc -l < "$after_manifest") source=${source_after:-unresolved}"
  if [ -z "$source_after" ] || [ "$source_after" != "$source_before" ]; then
    dependency_generation_log_manifest_delta "$before_manifest" "$after_manifest"
    dependency_generation_emit_summary \
      torn-source "$total_started_ms" "$source_before" "$identity" \
      "$predecessor_identity" "$tree_total" "$tree_reused" "$tree_copied" "$tree_removed"
    dependency_generation_log 'FATAL: live node_modules changed during generation build; refusing a torn snapshot'
    dependency_generation_remove_build "$build"
    return 75
  fi
  if [ "$reuse_manifest_eligible" = 'true' ]; then
    # Same live-input-drift family as the torn-source refusal above, not a distinct
    # failure class: source_before/source_after can match (no torn-source) while this
    # check still fails, because it is the only one of the two that re-verifies live
    # `$integration_root/$rel` existence rather than comparing manifest content. The
    # after-copy manifest scan above can take tens of seconds on this shared tree
    # (duration_ms=92770 measured 2026-09-03), and a concurrent writer can remove a
    # node_modules tree in that window after it was already recorded with a stable
    # fingerprint. Reserve exit 75 here too so green-checkpoint's writer-owned
    # exit-code contract (see buildTerminalFailureCheckpointResult in
    # green-checkpoint.ts) classifies this as infra-inconclusive/no-verdict instead of
    # an anonymous crash — it was previously exit 1, which fabricated a hard crash for
    # what is really the fourth live-input-drift refusal, not a code defect.
    dependency_generation_manifest_records_are_reusable "$after_manifest" "$integration_root" || {
      dependency_generation_log 'FATAL: verified source manifest lost the incremental-reuse contract'
      dependency_generation_remove_build "$build"
      return 75
    }
    tree_manifest="$build/.tree-manifest"
    cp -- "$after_manifest" "$tree_manifest" || {
      dependency_generation_remove_build "$build"
      return 1
    }
    tree_manifest_digest="$(dependency_generation_manifest_fingerprint "$tree_manifest")" || {
      dependency_generation_remove_build "$build"
      return 1
    }
  fi
  # Freeze file contents before recording the snapshot identity because mode is
  # part of the metadata fingerprint. Recording first would make every freshly
  # published generation invalidate itself on its next read.
  dependency_generation_log 'freezing copied dependency file modes'
  phase_started_ms="$(dependency_generation_now_ms)"
  find "$tree" -type f -exec chmod a-w {} +
  dependency_generation_emit_phase freeze "$phase_started_ms" ok
  dependency_generation_log 'fingerprinting immutable copied dependency snapshot'
  phase_started_ms="$(dependency_generation_now_ms)"
  snapshot="$(dependency_generation_set_fingerprint "$tree")" || {
    dependency_generation_emit_phase snapshot-fingerprint "$phase_started_ms" failed
    dependency_generation_remove_build "$build"
    return 1
  }
  dependency_generation_emit_phase snapshot-fingerprint "$phase_started_ms" ok
  dependency_generation_log "fingerprinted immutable copied dependency snapshot: snapshot=$snapshot"
  marker="$build/.papercusp-dependency-generation"
  {
    created_ns="$(dependency_generation_now_ns)"
    printf 'schema=1\nidentity=%s\nsource=%s\nclosure=%s\nsnapshot=%s\ncreated=%s\ncreated_ns=%s\n' \
      "$identity" "$source_after" "$DEPENDENCY_GENERATION_CLOSURE_FINGERPRINT" \
      "$snapshot" "${created_ns%?????????}" "$created_ns"
    if [ -n "$tree_manifest_digest" ]; then
      printf 'tree_manifest_schema=1\ntree_manifest_sha256=%s\npublication_schema=2\npredecessor=%s\ntrees_reused=%s\ntrees_copied=%s\ntrees_removed=%s\n' \
        "$tree_manifest_digest" "$predecessor_identity" \
        "$tree_reused" "$tree_copied" "$tree_removed"
    fi
    printf '%s\n' "$DEPENDENCY_GENERATION_SCOPE_RECORD"
  } > "$marker"
  if [ -n "$tree_manifest_digest" ]; then
    publication_token="$(dependency_generation_publication_token "$build")" || {
      dependency_generation_remove_build "$build"
      return 1
    }
    printf 'publication_token=%s\n' "$publication_token" >> "$marker"
    chmod a-w "$marker" "$tree_manifest"
    [ "$(dependency_generation_publication_token "$build")" = "$publication_token" ] || {
      dependency_generation_log 'FATAL: dependency publication token was not self-stable'
      dependency_generation_remove_build "$build"
      return 1
    }
  fi

  phase_started_ms="$(dependency_generation_now_ms)"
  dependency_generation_acquire_publish_lock "$generation_root" || {
    publish_rc=$?
    dependency_generation_emit_phase publish "$phase_started_ms" failed
    dependency_generation_remove_build "$build"
    return "$publish_rc"
  }
  dependency_generation_log "acquired dependency-generation publish lock for $identity"
  # Keep the build-owner marker until the short publish lock is held; otherwise
  # a concurrent cleanup can mistake this complete-but-not-yet-published tree
  # for an abandoned build. A generation may have appeared since our initial
  # validation, but its marker alone is not proof that the published tree is
  # still valid. A stale/corrupt tree can retain the expected identity and
  # snapshot fields; accepting that marker would discard this fully-validated
  # replacement and leave exact-id consumers pinned to the corrupt tree.
  # Re-validate the competing generation under the publish lock so that the
  # decision and any quarantine/replacement remain one serialized operation.
  # An unchanged incumbent is already known-invalid from the pre-build check;
  # compare its O(1) token and quarantine it directly. The expensive branch is
  # retained for any replacement/removal race, where a valid concurrent winner
  # must be recognized before publishing this build.
  current_incumbent_token="$(dependency_generation_generation_token "$generation" 2>/dev/null || true)"
  publish_replacement='1'
  if [ -n "$incumbent_token" ] && [ "$incumbent_token" = "$current_incumbent_token" ]; then
    dependency_generation_log "unchanged invalid generation $identity; skipping repeat validation under publish lock"
  else
    dependency_generation_log "validating concurrent generation winner for $identity"
    if dependency_generation_is_valid \
      "$generation" "$identity" "$DEPENDENCY_GENERATION_CLOSURE_FINGERPRINT"; then
      dependency_generation_log "reusing valid concurrent generation winner for $identity"
      dependency_generation_remove_build "$build"
      DEPENDENCY_GENERATION_REUSED='true'
      publish_replacement='0'
    else
      dependency_generation_log "no valid concurrent generation winner for $identity"
    fi
  fi
  if [ "$publish_replacement" = '1' ]; then
    if [ -e "$generation" ]; then
      quarantine="$generation_root/.invalid-$identity-$(date +%s).$$"
      mv "$generation" "$quarantine"
      dependency_generation_log "quarantined invalid generation as $(basename "$quarantine")"
    fi
    # Move the live-owner marker with the completed build, then remove it at the
    # published path. Waiters call cleanup_abandoned on every failed lock
    # acquisition; removing the marker before this rename lets one of them
    # classify an old-but-live build as abandoned and delete it underneath the
    # lock holder. Keeping the marker through the atomic rename leaves cleanup
    # only two observable states: a live owned build, or no pending build.
    mv "$build" "$generation"
    rm -f -- "$generation/.papercusp-generation-writer"
    DEPENDENCY_GENERATION_REUSED='false'
    dependency_generation_log "published immutable dependency generation $identity"
  fi
  dependency_generation_release_publish_lock
  dependency_generation_emit_phase publish "$phase_started_ms" ok \
    "generation_reused=${DEPENDENCY_GENERATION_REUSED:-false}"

  DEPENDENCY_GENERATION_ID="$identity"
  DEPENDENCY_GENERATION_PATH="$generation"
  DEPENDENCY_GENERATION_TREE="$generation/tree"
  DEPENDENCY_GENERATION_SOURCE_FINGERPRINT="$source_after"
  if [ "${DEPENDENCY_GENERATION_REUSED:-false}" = 'true' ]; then
    dependency_generation_emit_summary \
      concurrent-winner "$total_started_ms" "$source_after" "$identity" \
      "$predecessor_identity" "$tree_total" "$tree_reused" "$tree_copied" "$tree_removed"
  else
    dependency_generation_emit_summary \
      published "$total_started_ms" "$source_after" "$identity" \
      "$predecessor_identity" "$tree_total" "$tree_reused" "$tree_copied" "$tree_removed"
  fi
}

dependency_generation_main() {
  local integration_root='' generation_root='' select_inputs_from='' ensure_ref='' fingerprint_ref='' retention_rc=0 prune_only=''
  local input_before='' input_after='' exact_input='' selector='' lease_owner_pid=''
  local workspace_dirs=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --integration) integration_root="$2"; shift 2 ;;
      --generation-root) generation_root="$2"; shift 2 ;;
      --workspace-dir) workspace_dirs+=("$2"); shift 2 ;;
      --select-inputs-from) select_inputs_from="$2"; shift 2 ;;
      --lease-owner-pid) lease_owner_pid="$2"; shift 2 ;;
      --ensure-ref) ensure_ref="$2"; shift 2 ;;
      --fingerprint-ref) fingerprint_ref="$2"; shift 2 ;;
      --prune-only) prune_only='1'; shift ;;
      *) dependency_generation_log "unknown arg: $1"; return 2 ;;
    esac
  done
  [ -n "$integration_root" ] || {
    dependency_generation_log '--integration is required'
    return 2
  }
  integration_root="$(cd "$integration_root" && pwd -P)"
  generation_root="${generation_root:-$integration_root/.papercusp/dependency-generations}"
  if [ -n "$prune_only" ]; then
    [ -z "$select_inputs_from$ensure_ref$fingerprint_ref$lease_owner_pid" ] \
      && [ "${#workspace_dirs[@]}" -eq 0 ] || {
      dependency_generation_log '--prune-only cannot select or publish a generation'
      return 2
    }
    # A quiescent hive still needs retention. Never create a store merely to
    # sweep it; the same publish lock protects live selectors and generation
    # publication when a checkout happens concurrently.
    [ -d "$generation_root" ] || return 0
    dependency_generation_apply_retention "$generation_root" "$integration_root"
    return $?
  fi
  if [ -n "$select_inputs_from" ] && { [ -n "$ensure_ref" ] || [ -n "$fingerprint_ref" ]; }; then
    dependency_generation_log '--select-inputs-from, --ensure-ref, and --fingerprint-ref are mutually exclusive'
    return 2
  fi
  if [ -n "$ensure_ref" ] && [ -n "$fingerprint_ref" ]; then
    dependency_generation_log '--select-inputs-from, --ensure-ref, and --fingerprint-ref are mutually exclusive'
    return 2
  fi
  if [ -n "$lease_owner_pid" ] && [ -z "$select_inputs_from" ]; then
    dependency_generation_log '--lease-owner-pid requires --select-inputs-from'
    return 2
  fi
  if [ -n "$fingerprint_ref" ]; then
    [ "${#workspace_dirs[@]}" -eq 0 ] || {
      dependency_generation_log '--fingerprint-ref cannot select a workspace-scoped generation'
      return 2
    }
    fingerprint_ref="$(git -C "$integration_root" rev-parse --verify "$fingerprint_ref^{commit}" 2>/dev/null)" || {
      dependency_generation_log "FATAL: --fingerprint-ref is not a commit: $fingerprint_ref"
      return 74
    }
    exact_input="$(
      dependency_generation_input_fingerprint_ref "$integration_root" "$fingerprint_ref"
    )" || return $?
    printf 'DEPENDENCY_INPUT_FINGERPRINT schema=1 candidate=%s input=%s\n' \
      "$fingerprint_ref" "$exact_input"
    return 0
  fi
  if [ -n "$select_inputs_from" ]; then
    [ "${#workspace_dirs[@]}" -eq 0 ] || {
      dependency_generation_log '--select-inputs-from cannot publish a workspace-scoped generation'
      return 2
    }
    select_inputs_from="$(cd "$select_inputs_from" && pwd -P)"
    dependency_generation_select_inputs "$select_inputs_from" "$generation_root" || return $?
    if [ -n "$lease_owner_pid" ]; then
      # Bridge the controller's selection-to-materialization interval. The
      # selector subprocess exits before pc-heavy admission and setup begin, so
      # a lease owned by $$ would immediately become reclaimable. Attribute it
      # to the long-lived controller instead, and re-check the immutable token
      # under the publish lock before returning the handoff.
      dependency_generation_acquire_selector_lease \
        "$generation_root" "$DEPENDENCY_GENERATION_ID" \
        "$lease_owner_pid" "$DEPENDENCY_GENERATION_TOKEN" || return $?
    fi
    printf 'DEPENDENCY_GENERATION_RESULT schema=1 identity=%s source=%s input=%s scope=full reused=true token=%s path=%s\n' \
      "$DEPENDENCY_GENERATION_ID" "$DEPENDENCY_GENERATION_SOURCE_FINGERPRINT" \
      "$DEPENDENCY_GENERATION_INPUT_FINGERPRINT" "$DEPENDENCY_GENERATION_TOKEN" \
      "$DEPENDENCY_GENERATION_PATH"
    return 0
  fi
  if [ -n "$ensure_ref" ]; then
    [ "${#workspace_dirs[@]}" -eq 0 ] || {
      dependency_generation_log '--ensure-ref cannot publish a workspace-scoped generation'
      return 2
    }
    ensure_ref="$(git -C "$integration_root" rev-parse --verify "$ensure_ref^{commit}" 2>/dev/null)" || {
      dependency_generation_log "FATAL: --ensure-ref is not a commit: $ensure_ref"
      return 74
    }
    exact_input="$(
      dependency_generation_input_fingerprint_ref "$integration_root" "$ensure_ref"
    )" || return $?
    selector="$generation_root/.inputs/$exact_input"
    if [ -f "$selector" ]; then
      # An existing selector must validate as-is. Token/marker drift is corruption,
      # not a cache miss to hide by republishing a replacement.
      dependency_generation_select_input_fingerprint \
        "$exact_input" "$generation_root" || return $?
      printf 'DEPENDENCY_GENERATION_RESULT schema=1 identity=%s source=%s input=%s scope=full reused=true token=%s path=%s\n' \
        "$DEPENDENCY_GENERATION_ID" "$DEPENDENCY_GENERATION_SOURCE_FINGERPRINT" \
        "$DEPENDENCY_GENERATION_INPUT_FINGERPRINT" "$DEPENDENCY_GENERATION_TOKEN" \
        "$DEPENDENCY_GENERATION_PATH"
      return 0
    fi
    dependency_generation_log \
      "exact ref $ensure_ref has unseen dependency inputs $exact_input; prewarming before checkpoint serialization"
  fi
  dependency_generation_configure_workspace_dirs \
    "$integration_root" "${workspace_dirs[@]}" || return $?
  if [ "$DEPENDENCY_GENERATION_SCOPE_MODE" = 'full' ]; then
    input_before="$(dependency_generation_input_fingerprint "$integration_root")" || return 1
  fi
  dependency_generation_ensure "$integration_root" "$generation_root" || return $?
  if [ "$DEPENDENCY_GENERATION_SCOPE_MODE" = 'full' ]; then
    # Index under the PRE-build inputs, and never abort on live lockfile drift.
    #
    # The copied trees reflect the dependency state that was installed when this
    # run took the install mutex, so `input_before` is the key that actually
    # describes them; `input_after` names a lockfile state that was never
    # reified into them, which is why publishing under it would be the stale
    # selector this branch set out to refuse.
    #
    # node_modules cannot move under us: every build caller enters through
    # npm-install-safe's `--exec-under-lock` reader mutex, and
    # dependency_generation_ensure independently proves the trees never changed
    # via its own source-manifest bracket (which fails `torn-source`). Lockfiles
    # get NO such protection — they are ordinary tracked files that any of ~100
    # concurrent agents may edit and that a git-sync sweep rewrites on its own
    # schedule. Re-reading them after a ~24-minute copy and aborting on any
    # difference therefore discarded builds that had already published
    # successfully, purely because an unrelated lockfile moved; that is what
    # made a prewarm on this shared tree effectively uncompletable.
    #
    # The drift is still worth recording, and for --ensure-ref the re-open by
    # the exact candidate key below remains the arbiter of whether this
    # generation actually fits the candidate — a typed miss, not a fatal.
    input_after="$(dependency_generation_input_fingerprint "$integration_root")" || return 1
    if [ "$input_after" != "$input_before" ]; then
      dependency_generation_log \
        "live dependency inputs changed during generation prewarm (before=$input_before after=$input_after); indexing under the pre-build inputs the copied trees reflect"
    fi
    dependency_generation_publish_input_selector \
      "$generation_root" "$input_before" || return $?
  else
    DEPENDENCY_GENERATION_TOKEN="$(
      dependency_generation_selector_token "$DEPENDENCY_GENERATION_PATH"
    )" || return 1
    DEPENDENCY_GENERATION_INPUT_FINGERPRINT='unindexed'
  fi
  # Protect the just-published/reused identity even when several generations
  # share the same second-level `created` timestamp and retention ordering ties.
  dependency_generation_acquire_selector_lease "$generation_root" "$DEPENDENCY_GENERATION_ID" || return $?
  dependency_generation_apply_retention "$generation_root" "$integration_root" || {
    retention_rc=$?
    dependency_generation_release_selector_lease
    return "$retention_rc"
  }
  dependency_generation_release_selector_lease
  if [ -n "$ensure_ref" ]; then
    # Publication indexed the LIVE integration inputs. Re-open by the exact
    # candidate key so incompatible live/candidate inputs remain a typed miss.
    dependency_generation_select_input_fingerprint \
      "$exact_input" "$generation_root" || return $?
  fi
  printf 'DEPENDENCY_GENERATION_RESULT schema=1 identity=%s source=%s input=%s closure=%s scope=%s reused=%s token=%s path=%s\n' \
    "$DEPENDENCY_GENERATION_ID" "$DEPENDENCY_GENERATION_SOURCE_FINGERPRINT" \
    "$DEPENDENCY_GENERATION_INPUT_FINGERPRINT" \
    "$DEPENDENCY_GENERATION_CLOSURE_FINGERPRINT" "$DEPENDENCY_GENERATION_SCOPE_MODE" \
    "$DEPENDENCY_GENERATION_REUSED" "$DEPENDENCY_GENERATION_TOKEN" \
    "$DEPENDENCY_GENERATION_PATH"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -euo pipefail
  dependency_generation_main "$@"
fi

}  # ── end self-read guard (WI-322485) ──
