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
  # WI-10004094: while this process holds an identity's in-flight build, mirror
  # each line to the lock so a joined waiter can relay the holder's progress.
  if [ -n "${DEPENDENCY_GENERATION_INFLIGHT_PROGRESS:-}" ]; then
    {
      printf '%s %s\n' "$(date +%s)" "$*" > "$DEPENDENCY_GENERATION_INFLIGHT_PROGRESS.tmp" \
        && mv -f "$DEPENDENCY_GENERATION_INFLIGHT_PROGRESS.tmp" "$DEPENDENCY_GENERATION_INFLIGHT_PROGRESS"
    } 2>/dev/null || true
  fi
}

# WI-10005159: ONE generation store per integration root. bg-host sets
# PAPERCUSP_DEPENDENCY_GENERATION_ROOT for the scheduled gate, but a manual
# `systemd-run --unit` gate run, install:safe and an agent's hand prewarm do not
# inherit that env, so each fell back to the tree-local store the gate never
# reads (exit 74 "no prewarmed dependency generation" while the generation sat in
# the other store). The env-named root is therefore recorded under the
# integration root, and every env-less caller on that root follows the record.
# Precedence: explicit CLI root > env > record > tree-local default.
dependency_generation_root_record() {
  printf '%s\n' "$1/.papercusp/dependency-generation-root"
}

dependency_generation_resolve_root() {
  local integration_root="$1" explicit="${2:-}" record recorded='' configured
  if [ -n "$explicit" ]; then
    printf '%s\n' "$explicit"
    return 0
  fi
  record="$(dependency_generation_root_record "$integration_root")"
  if [ -f "$record" ]; then
    IFS= read -r recorded < "$record" || true
  fi
  case "$recorded" in
    /*) ;;
    *) recorded='' ;;
  esac
  configured="${PAPERCUSP_DEPENDENCY_GENERATION_ROOT:-}"
  if [ -n "$configured" ]; then
    if [ "$recorded" != "$configured" ]; then
      [ -z "$recorded" ] || dependency_generation_log \
        "generation root record $record named $recorded; PAPERCUSP_DEPENDENCY_GENERATION_ROOT=$configured replaces it"
      { mkdir -p "$(dirname "$record")" \
          && printf '%s\n' "$configured" > "$record.tmp.$$" \
          && mv -f "$record.tmp.$$" "$record"; } 2>/dev/null \
        || dependency_generation_log "WARNING: could not record generation root $configured at $record"
    fi
    printf '%s\n' "$configured"
    return 0
  fi
  if [ -n "$recorded" ]; then
    printf '%s\n' "$recorded"
    return 0
  fi
  printf '%s\n' "$integration_root/.papercusp/dependency-generations"
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
    "SUMMARY schema=1 result=$result source=${source:-unresolved} identity=${identity:-unresolved} predecessor=${predecessor:-none} trees_total=$trees_total trees_reused=$trees_reused trees_copied=$trees_copied trees_removed=$trees_removed trees_incremental=${DEPENDENCY_GENERATION_TREES_INCREMENTAL:-0} total_ms=$duration_ms"
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
        \( -type d \( -name .papercusp -o -name .papercusp-smoke-snapshots -o -name .git -o -name node_modules \
          -o -name 'node_modules.deploy-tmp.*' -o -name 'node_modules.deploy-old.*' \
          -o -name '*.tmp.[0-9]*' -o -name '*.old.[0-9]*' \) -prune \) -o \
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
# Optional 4th argument: a directory to ALSO materialise each input blob into, at its
# repo-relative path. The exact-ref builder uses it so the files it stages are, by
# construction, exactly the set this function fingerprints (WI-10004151).
dependency_generation_input_manifest_ref() {
  local root="$1" ref="$2" prefix="${3:-}" extract_root="${4:-}"
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
      .papercusp/*|*/.papercusp/*|.papercusp-smoke-snapshots/*|*/.papercusp-smoke-snapshots/*|node_modules/*|*/node_modules/*) continue ;;
    esac
    if [ -n "$extract_root" ]; then
      mkdir -p "$extract_root/$(dirname "${prefix}${rel}")" || return 1
      git -C "$root" cat-file blob "$object" > "$extract_root/${prefix}${rel}" || return 1
      digest="$(dependency_generation_sha256 < "$extract_root/${prefix}${rel}")" || return 1
    else
      digest="$(git -C "$root" cat-file blob "$object" | dependency_generation_sha256)" || return 1
    fi
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
      "$root/$submodule_path" "$submodule_object" "${prefix}${submodule_path}/" \
      "$extract_root" || return $?
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

# WI-10004825: every swap-by-rename in this script and setup-release-checkout.sh
# names its scratch sibling with the creating shell's $$ (`<dest>.deploy-tmp.<pid>`,
# `<dest>.generation-tmp.<pid>`, `...-old.<pid>`) and only ever clears its OWN pid's
# leftovers. A run killed mid-copy (gate timeout, SIGTERM, operator restart) therefore
# strands a partial multi-GB copy that no later run removes: four such trees from dead
# pids were found in the admission-precheck checkout, the oldest a week old. Reap a
# sibling only when its creating pid is gone AND it has not been touched for the grace
# window; a live pid (including one we cannot signal) or a recent mtime is skipped, so
# a concurrent run's in-flight copy is never deleted.
dependency_generation_reap_dead_siblings() {
  local dest="$1" grace="${DEPENDENCY_GENERATION_REAP_GRACE_SEC:-1800}"
  local candidate base rest pid now mtime
  case "$grace" in ''|*[!0-9]*) grace=1800 ;; esac
  now="$(date +%s)"
  for candidate in "$dest".deploy-tmp.* "$dest".deploy-old.* \
    "$dest".generation-tmp.* "$dest".generation-old.*; do
    [ -e "$candidate" ] || [ -L "$candidate" ] || continue
    base="${candidate##*/}"
    rest="${base#"${dest##*/}".}"
    rest="${rest#*.}"
    pid="${rest%%.*}"
    case "$pid" in ''|*[!0-9]*) continue ;; esac
    [ "$pid" = "$$" ] && continue
    if kill -0 "$pid" 2>/dev/null || [ -d "/proc/$pid" ]; then
      continue
    fi
    mtime="$(stat -c '%Y' "$candidate" 2>/dev/null || stat -f '%m' "$candidate" 2>/dev/null || echo "$now")"
    [ $((now - mtime)) -ge "$grace" ] || continue
    dependency_generation_log "reaping orphaned scratch tree from dead pid $pid: $candidate"
    find "$candidate" -type d -exec chmod u+rwx {} + 2>/dev/null || true
    rm -rf -- "$candidate"
  done
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
# runtime infrastructure, never dependency-generation inputs. Neither are
# short-lived repositories under .papercusp-smoke-snapshots: their install trees
# and lockfiles can disappear while a product generation is being copied.
# swap-by-rename scratch siblings: node_modules.deploy-{tmp,old}.* (WI-2144371)
# and any whole DIRECTORY staged as <dir>.tmp.<pid> / <dir>.old.<pid>, e.g.
# build-desktop-sidecar.sh's sidecar.tmp.$$ (WI-10005953). Such a sibling carries
# its own node_modules and package-lock.json, so a concurrent build used to add a
# transient tree mid-snapshot and tear the gate's generation (exit 75).
dependency_generation_enumerate_node_modules() {
  local root="$1" dir
  if [ "${DEPENDENCY_GENERATION_SCOPE_MODE:-full}" = 'selected' ]; then
    [ -d "$root/node_modules" ] && printf '%s\n' "$root/node_modules"
    for dir in "${DEPENDENCY_GENERATION_WORKSPACE_DIRS[@]}"; do
      [ -d "$root/$dir/node_modules" ] && printf '%s\n' "$root/$dir/node_modules"
    done
    return 0
  fi
  # -mindepth 1: the name patterns below must never prune the starting root
  # itself, whatever its basename (a caller may pass a generated scratch root).
  find "$root" -mindepth 1 \
    \( -type d \( -name .papercusp -o -name .papercusp-smoke-snapshots -o -name .git \
      -o -name 'node_modules.deploy-tmp.*' -o -name 'node_modules.deploy-old.*' \
      -o -name '*.tmp.[0-9]*' -o -name '*.old.[0-9]*' \) -prune \) -o \
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

# Device-free variants for the DURABLE publication token (schema 3). st_dev is
# not a stable identity across reboots: block-extended nvme minors are assigned
# at boot, so a reboot that renumbers the device invalidated every schema-2
# token and wedged the gate with exit 74 (WI-10005569). The generation root path
# already pins the filesystem; inode + mtime + size + content digests remain.
# The in-run selector token (generation_token) keeps %d: it is compared within
# one boot.
dependency_generation_durable_stat_token() {
  local path="$1"
  if stat -c '%i:%Y:%s' "$path" 2>/dev/null; then
    return 0
  fi
  stat -f '%i:%m:%z' "$path"
}

dependency_generation_durable_inode_token() {
  local path="$1"
  if stat -c '%i' "$path" 2>/dev/null; then
    return 0
  fi
  stat -f '%i' "$path"
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
# Schema 3 (the default, written by every new publication) is device-free; the
# legacy schema 2 binds st_dev and is still verified for markers that carry it.
dependency_generation_publication_token() {
  local generation="$1" schema="${2:-3}" marker manifest tree
  local generation_inode tree_token marker_inode manifest_token
  local marker_digest manifest_digest recorded_manifest_digest digest
  local inode_fn stat_fn
  case "$schema" in
    3) inode_fn=dependency_generation_durable_inode_token
       stat_fn=dependency_generation_durable_stat_token ;;
    2) inode_fn=dependency_generation_inode_token
       stat_fn=dependency_generation_stat_token ;;
    *) return 1 ;;
  esac
  marker="$generation/.papercusp-dependency-generation"
  manifest="$generation/.tree-manifest"
  tree="$generation/tree"
  [ -d "$generation" ] && [ -d "$tree" ] && [ -f "$marker" ] && [ -f "$manifest" ] \
    || return 1
  generation_inode="$("$inode_fn" "$generation")" || return 1
  tree_token="$("$stat_fn" "$tree")" || return 1
  marker_inode="$("$inode_fn" "$marker")" || return 1
  manifest_token="$("$stat_fn" "$manifest")" || return 1
  marker_digest="$(dependency_generation_marker_payload_digest "$marker")" || return 1
  manifest_digest="$(dependency_generation_manifest_fingerprint "$manifest")" || return 1
  recorded_manifest_digest="$(dependency_generation_read_field "$marker" tree_manifest_sha256)"
  [ "$manifest_digest" = "$recorded_manifest_digest" ] || return 1
  digest="$({
    printf 'schema\t%s\n' "$schema"
    printf 'generation\t%s\n' "$generation_inode"
    printf 'tree\t%s\n' "$tree_token"
    printf 'marker\t%s\t%s\n' "$marker_inode" "$marker_digest"
    printf 'manifest\t%s\t%s\n' "$manifest_token" "$manifest_digest"
  } | dependency_generation_sha256)" || return 1
  printf 'v%s:%s\n' "$schema" "$digest"
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
  case "$schema" in 2|3) ;; *) return 1 ;; esac
  [ "$token_count" = '1' ] \
    && [[ "$recorded_token" =~ ^v${schema}:[0-9a-f]{64}$ ]] || return 1
  dependency_generation_reuse_manifest_is_valid "$generation" || return 1
  current_token="$(dependency_generation_publication_token "$generation" "$schema" 2>/dev/null || true)"
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
  local generation="$1" schema
  if dependency_generation_has_publication_contract "$generation"; then
    # Compute under the marker's OWN schema: a v2 marker hashed under the v3
    # default never matches its recorded token, so every lease reads
    # "replaced" and the gate exits 74 (WI-10005617).
    schema="$(dependency_generation_read_field \
      "$generation/.papercusp-dependency-generation" publication_schema)"
    dependency_generation_publication_token "$generation" "${schema:-3}"
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
    v2:*|v3:*)
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
      "FATAL: no prewarmed dependency generation for input fingerprint $input_fingerprint (generation_root=$generation_root)"
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

  for lock in "$generation_root"/.inflight-*; do
    [ -d "$lock" ] || continue
    if dependency_generation_inflight_is_abandoned "$lock" "$host"; then
      dependency_generation_reclaim_inflight "$generation_root" "$lock"
    fi
  done
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
    dependency_generation_log "FATAL: dependency generation $identity disappeared before it could be leased (generation_root=$generation_root)"
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

# WI-10004094: single-flight per generation identity. The gate and bg-host
# prebuilds for several tips of the SAME lockfile all resolve the same identity,
# and each used to copy the ~16 GB tree into its own .build-pending-* in
# parallel; the three copies starved each other past the gate's no-output
# budget. Exactly one process now builds an identity. Every other caller joins
# it: it relays the holder's progress lines and then re-validates, which is a
# cache hit once the holder publishes.
DEPENDENCY_GENERATION_INFLIGHT_LOCK=''
DEPENDENCY_GENERATION_INFLIGHT_PROGRESS=''
DEPENDENCY_GENERATION_JOINED_RC=79

dependency_generation_inflight_is_abandoned() {
  local lock="$1" host="$2"
  { [ -f "$lock/writer" ] && ! dependency_generation_writer_is_live "$lock/writer" "$host"; } \
    || { [ ! -f "$lock/writer" ] && dependency_generation_path_is_old "$lock" 60; }
}

dependency_generation_reclaim_inflight() {
  local generation_root="$1" lock="$2" quarantine
  quarantine="$generation_root/.stale-inflight.$(date +%s).$$.${RANDOM:-0}"
  if mv "$lock" "$quarantine" 2>/dev/null; then
    dependency_generation_log "reclaimed abandoned in-flight build lock $(basename "$lock")"
    rm -rf -- "$quarantine"
  fi
}

# 0 = this process now holds the identity's build; 10 = a live peer holds it.
dependency_generation_try_inflight() {
  local generation_root="$1" identity="$2" lock host
  lock="$generation_root/.inflight-$identity"
  host="$(dependency_generation_host)"
  while :; do
    if mkdir "$lock" 2>/dev/null; then
      dependency_generation_write_owner "$lock/writer"
      DEPENDENCY_GENERATION_INFLIGHT_LOCK="$lock"
      DEPENDENCY_GENERATION_INFLIGHT_PROGRESS="$lock/progress"
      return 0
    fi
    if dependency_generation_inflight_is_abandoned "$lock" "$host"; then
      dependency_generation_reclaim_inflight "$generation_root" "$lock"
      continue
    fi
    [ -d "$lock" ] || continue
    return 10
  done
}

# Wait for a live peer's build of the same identity. Returns JOINED_RC when it
# ends (published, failed, or died: the caller re-validates either way) and 73
# when the holder has shown no progress for the stall budget, naming the holder
# before the caller's own no-output watchdog kills this process blind.
dependency_generation_wait_inflight() {
  local generation_root="$1" identity="$2" lock host stall_sec progress seen='' last_change now
  lock="$generation_root/.inflight-$identity"
  host="$(dependency_generation_host)"
  stall_sec="${DEPENDENCY_GENERATION_INFLIGHT_STALL_SEC:-1500}"
  case "$stall_sec" in ''|*[!0-9]*) stall_sec=1500 ;; esac
  dependency_generation_log \
    "joining in-flight build of $identity ($(dependency_generation_publish_lock_holder "$lock")) instead of copying the same trees in parallel"
  last_change="$(date +%s)"
  while [ -d "$lock" ]; do
    dependency_generation_inflight_is_abandoned "$lock" "$host" && break
    progress="$(cat "$lock/progress" 2>/dev/null || true)"
    now="$(date +%s)"
    if [ -n "$progress" ] && [ "$progress" != "$seen" ]; then
      seen="$progress"
      last_change="$now"
      dependency_generation_log "in-flight build of $identity: ${progress#* }"
    fi
    if [ $((now - last_change)) -ge "$stall_sec" ]; then
      dependency_generation_log \
        "FATAL: in-flight build of $identity showed no progress for ${stall_sec}s ($(dependency_generation_publish_lock_holder "$lock"))"
      return 73
    fi
    sleep 1
  done
  dependency_generation_log "in-flight build of $identity ended; re-validating"
  return "$DEPENDENCY_GENERATION_JOINED_RC"
}

dependency_generation_release_inflight() {
  local lock="${DEPENDENCY_GENERATION_INFLIGHT_LOCK:-}"
  DEPENDENCY_GENERATION_INFLIGHT_PROGRESS=''
  [ -n "$lock" ] || return 0
  DEPENDENCY_GENERATION_INFLIGHT_LOCK=''
  rm -rf -- "$lock"
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
#
# D-019 (WI-10004927): one generation root is shared by every repository whose
# gate runs this script, and the closure fingerprint of a full-scope build is
# the same for all of them. Ranking by created time alone therefore picked a
# 7-tree generation from another repository as papercusp's predecessor, so 0 of
# 207,877 files could be reused. When the caller passes its live manifest,
# candidates are ranked by how much of THIS layout they cover: identical trees
# first, then shared tree paths, then age. A candidate sharing no tree path with
# the live layout can contribute nothing and is never selected.
dependency_generation_manifest_overlap() {
  local current="$1" candidate="$2"
  if [ ! -s "$current" ] || [ ! -f "$candidate" ]; then
    printf '0 0\n'
    return 0
  fi
  LC_ALL=C awk -F'\t' '
    NR == FNR { fingerprint[$1] = $2; next }
    ($1 in fingerprint) { shared++; if (fingerprint[$1] == $2) exact++ }
    END { printf "%d %d\n", exact, shared }
  ' "$current" "$candidate"
}

dependency_generation_find_reusable_predecessor() {
  local generation_root="$1" target_identity="$2" current_manifest="${3:-}"
  local generation identity marker created record token_before token_after
  local exact shared
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
      exact=0
      shared=0
      if [ -n "$current_manifest" ]; then
        read -r exact shared < <(
          dependency_generation_manifest_overlap \
            "$current_manifest" "$generation/.tree-manifest"
        )
        [ "${shared:-0}" -gt 0 ] || continue
      fi
      printf '%010d %010d %020d %s\n' "${exact:-0}" "${shared:-0}" "$created" "$identity"
    done | sort -k1,1nr -k2,2nr -k3,3nr -k4,4r
  )

  for record in "${ranked[@]}"; do
    identity="${record##* }"
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
        read -r exact shared _ <<< "$record"
        dependency_generation_log \
          "selected reusable immutable predecessor $identity (identical_trees=$((10#$exact)) shared_trees=$((10#$shared)))"
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

# WI-10003695: a checkout on ANOTHER filesystem than the store cannot share the
# store's inodes, so its pin only spares a rebuild if that checkout is ever
# materialized again. The root-offload convention moves a retired checkout to
# /mnt/data and leaves a symlink, and its pin then kept a ~20 GB generation on the
# root disk forever (five of them, ~95 GiB, on 2026-10-01). A LIVE cross-filesystem
# checkout re-materializes, which rewrites its node_modules marker
# (setup-release-checkout.sh record_node_modules_copy_metadata), so only a marker
# older than DEPENDENCY_GENERATION_CROSS_FS_PIN_MAX_AGE_DAYS (default 3) counts as
# retired. Same-filesystem pins are never affected. Any measurement failure keeps
# the pin: an unreadable checkout is not proof that it is retired.
dependency_generation_path_dev() {
  # GNU `stat -f` means FILESYSTEM status (%d = free inodes), so the BSD form is
  # used only where stat is not GNU.
  if stat --version >/dev/null 2>&1; then
    stat -L -c '%d' "$1" 2>/dev/null
  else
    stat -L -f '%d' "$1" 2>/dev/null
  fi
}

dependency_generation_cross_fs_pin_is_retired() {
  local generation_root="$1" checkout="$2" marker="$3"
  local max_age_days="${DEPENDENCY_GENERATION_CROSS_FS_PIN_MAX_AGE_DAYS:-3}"
  local store_dev checkout_dev
  [[ "$max_age_days" =~ ^[0-9]+$ ]] || max_age_days=3
  store_dev="$(dependency_generation_path_dev "$generation_root")" || return 1
  checkout_dev="$(dependency_generation_path_dev "$checkout")" || return 1
  [ -n "$store_dev" ] && [ -n "$checkout_dev" ] || return 1
  [ "$store_dev" != "$checkout_dev" ] || return 1
  dependency_generation_path_is_old "$marker" $((max_age_days * 86400))
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
    elif dependency_generation_cross_fs_pin_is_retired "$generation_root" "$checkout" "$marker"; then
      dependency_generation_log \
        "removing retired cross-filesystem checkout pin $(basename "$pin") ($checkout, $identity)"
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
    # A symlinked sibling resolves to its offload target above; without this
    # check the pin removed in the loop before would be re-written every refresh.
    dependency_generation_cross_fs_pin_is_retired "$generation_root" "$sibling" "$marker" && continue
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
  # An explicit second argument may retain ZERO by recency (the legacy-store
  # sweep below: nothing reads that store, so only pins and leases protect).
  local generation_root="$1" retain_count="${2:-${DEPENDENCY_GENERATION_RETAIN_COUNT:-2}}"
  local min_retain=1
  [ -z "${2:-}" ] || min_retain=0
  local protected=' ' generation identity created pin lease kept=0 quarantine
  local ranked=()
  if [[ ! "$retain_count" =~ ^[0-9]+$ ]] || [ "$retain_count" -lt "$min_retain" ]; then
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
  for quarantine in "$generation_root"/.prune-* "$generation_root"/.invalid-* "$generation_root"/.stale-publish-lock.* "$generation_root"/.stale-inflight.*; do
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
  if [ "$rc" -eq 0 ]; then
    dependency_generation_sweep_legacy_store "$generation_root" "$integration_root"
  fi
  return "$rc"
}

# WI-10006081: the persistent generation root for an integration root (env, then
# the WI-10005159 record), WITHOUT writing the record. Empty when neither names
# an absolute root, i.e. the tree-local store is still the real one.
dependency_generation_persistent_root() {
  local integration_root="$1" record recorded=''
  if [ -n "${PAPERCUSP_DEPENDENCY_GENERATION_ROOT:-}" ]; then
    printf '%s\n' "$PAPERCUSP_DEPENDENCY_GENERATION_ROOT"
    return 0
  fi
  record="$(dependency_generation_root_record "$integration_root")"
  if [ -f "$record" ]; then
    IFS= read -r recorded < "$record" || true
  fi
  case "$recorded" in
    /*) printf '%s\n' "$recorded" ;;
  esac
  return 0
}

# WI-10006081: once the root moves (env or record), every caller follows it and
# NOTHING reads or retains the tree-local store again. Its generations were never
# swept: on 2026-10-05 six of them (~80 GB, single-link) sat on the root disk
# beside a store on /mnt/data, put / at 99% and stopped git-sync fleet-wide and
# cargo admission. So each retention pass also sweeps that legacy store, keeping
# only generations a live pin or lease still names (recency keeps nothing, since
# no reader selects from it). Best-effort: a busy or unreadable legacy store must
# never fail a publish, so every failure is logged and swallowed.
dependency_generation_sweep_legacy_store() {
  local generation_root="$1" integration_root="$2"
  local legacy persistent legacy_real persistent_real generation_real residue rc=0
  legacy="$integration_root/.papercusp/dependency-generations"
  [ -d "$legacy" ] || return 0
  persistent="$(dependency_generation_persistent_root "$integration_root")"
  [ -n "$persistent" ] || return 0
  legacy_real="$(cd "$legacy" 2>/dev/null && pwd -P)" || return 0
  # The persistent store must exist: a record naming a missing directory proves
  # nothing about where generations live, so the legacy store stays untouched.
  persistent_real="$(cd "$persistent" 2>/dev/null && pwd -P)" || return 0
  [ "$legacy_real" != "$persistent_real" ] || return 0
  # An explicit --generation-root may be pointed at the legacy store on purpose.
  generation_real="$(cd "$generation_root" 2>/dev/null && pwd -P)" || generation_real=''
  [ "$legacy_real" != "$generation_real" ] || return 0
  residue=''
  for residue in "$legacy_real"/v1-* "$legacy_real"/.prune-* "$legacy_real"/.invalid-*; do
    [ -d "$residue" ] && break
    residue=''
  done
  [ -n "$residue" ] || return 0
  dependency_generation_log \
    "sweeping legacy tree-local generation store $legacy_real (generation root is $persistent_real)"
  # A short lock budget: a live holder on a store nobody should be using is
  # reason to retry on the next pass, not to stall this publish for 15 minutes.
  DEPENDENCY_GENERATION_PUBLISH_LOCK_TIMEOUT_SEC="${DEPENDENCY_GENERATION_LEGACY_SWEEP_LOCK_TIMEOUT_SEC:-5}" \
    dependency_generation_acquire_publish_lock "$legacy_real" || {
      dependency_generation_log "WARNING: legacy generation store $legacy_real is locked; sweep deferred"
      return 0
    }
  dependency_generation_refresh_retention_state_locked "$legacy_real" "$integration_root" || rc=$?
  if [ "$rc" -eq 0 ]; then
    dependency_generation_quarantine_unretained_locked "$legacy_real" 0 || rc=$?
  fi
  dependency_generation_release_publish_lock
  dependency_generation_delete_prune_quarantines
  [ "$rc" -eq 0 ] \
    || dependency_generation_log "WARNING: legacy generation store sweep of $legacy_real failed (rc=$rc); retained"
  return 0
}

# WI-10004849: a changed root tree is one ~16-18 GB physical copy (ext4 has no
# reflink), and the old and new trees coexist until the swap. Several of these
# running at once (gate, deploy, repair precheck) drove root free space under
# git-sync's 2% fetch reserve. So every physical copy on this host runs under
# one host-wide flock, and refuses to start without headroom for the copy plus
# the reserve plus a margin. Both refusals are typed infra exits:
#   76 = DEPENDENCY_GENERATION_LOCK_TIMEOUT (another copy held the lock too long)
#   77 = DEPENDENCY_GENERATION_HEADROOM_INSUFFICIENT (not enough free space)
DEPENDENCY_GENERATION_COPY_LOCK_DEPTH=0
DEPENDENCY_GENERATION_COPY_LOCK_FD=''

dependency_generation_copy_lock_file() {
  printf '%s\n' \
    "${DEPENDENCY_GENERATION_COPY_LOCK_FILE:-${TMPDIR:-/tmp}/papercusp-dependency-generation-copy.lock}"
}

# WI-10004928 part 6: total I/O (rchar+wchar) of a pid and all its live
# descendants, or empty when it cannot be measured (pid gone, /proc unreadable,
# another pid namespace). The copy-lock waiter treats any CHANGE in this number
# as the holder making progress; a child exiting also changes it, which is
# still activity. Reads only /proc, so a sample costs milliseconds.
dependency_generation_subtree_io() {
  local root="$1" pids p total='' r w
  case "$root" in ''|*[!0-9]*) return 0 ;; esac
  kill -0 "$root" 2>/dev/null || return 0
  pids="$( { ps -e -o pid=,ppid= 2>/dev/null || true; } | awk -v root="$root" '
    { kids[$2] = kids[$2] " " $1 }
    END {
      queue[1] = root; n = 1; i = 1
      while (i <= n) {
        p = queue[i++]; print p
        m = split(kids[p], c, " ")
        for (j = 1; j <= m; j++) queue[++n] = c[j]
      }
    }')"
  for p in $pids; do
    [ -r "/proc/$p/io" ] || continue
    r="$(awk '$1 == "rchar:" { print $2 }' "/proc/$p/io" 2>/dev/null || true)"
    w="$(awk '$1 == "wchar:" { print $2 }' "/proc/$p/io" 2>/dev/null || true)"
    [ -n "$r$w" ] || continue
    total=$(( ${total:-0} + ${r:-0} + ${w:-0} ))
  done
  [ -n "$total" ] && printf '%s\n' "$total"
  return 0
}

# The copy lock's timeout is a STALL budget, not a wall-clock one (WI-10004928
# part 6). A full tree copy takes ~20 min, so a wall-clock 600s budget made every
# waiter behind a healthy copy fail with exit 76 and lose a whole gate round.
# The waiter keeps waiting while the holder's subtree I/O keeps changing, fails
# after DEPENDENCY_GENERATION_COPY_LOCK_TIMEOUT_SEC (default 600) without
# progress, and never waits past DEPENDENCY_GENERATION_COPY_LOCK_MAX_SEC
# (default 5400). An unmeasurable holder gets no credit for progress, which
# keeps the old wall-clock behaviour for that case.
dependency_generation_acquire_copy_lock() {
  local op="$1" lock fd timeout_sec max_sec started now waited next_notice holder
  local holder_pid io last_io last_progress next_sample idle reason
  if [ "$DEPENDENCY_GENERATION_COPY_LOCK_DEPTH" -gt 0 ]; then
    DEPENDENCY_GENERATION_COPY_LOCK_DEPTH=$((DEPENDENCY_GENERATION_COPY_LOCK_DEPTH + 1))
    return 0
  fi
  if ! command -v flock >/dev/null 2>&1; then
    dependency_generation_log 'flock unavailable; physical dependency copies are not serialized on this host'
    return 0
  fi
  timeout_sec="${DEPENDENCY_GENERATION_COPY_LOCK_TIMEOUT_SEC:-600}"
  case "$timeout_sec" in ''|*[!0-9]*) timeout_sec=600 ;; esac
  max_sec="${DEPENDENCY_GENERATION_COPY_LOCK_MAX_SEC:-5400}"
  case "$max_sec" in ''|*[!0-9]*) max_sec=5400 ;; esac
  [ "$max_sec" -ge "$timeout_sec" ] || max_sec="$timeout_sec"
  lock="$(dependency_generation_copy_lock_file)"
  mkdir -p "$(dirname "$lock")" 2>/dev/null || true
  exec {fd}>>"$lock" || {
    dependency_generation_log "DEPENDENCY_GENERATION_LOCK_TIMEOUT waited=0s timeout=${timeout_sec}s holder=unknown op=$op reason=cannot-open-lock lock=$lock"
    return 76
  }
  started="$(date +%s)"
  next_notice=30
  last_io=''
  last_progress="$started"
  next_sample="$started"
  while ! flock -n "$fd"; do
    now="$(date +%s)"
    waited=$((now - started))
    holder="$(tr '\n' ' ' < "$lock.holder" 2>/dev/null || true)"
    if [ "$now" -ge "$next_sample" ]; then
      holder_pid="$( { sed -n 's/^pid=\([0-9][0-9]*\).*/\1/p' "$lock.holder" 2>/dev/null || true; } | head -n 1)"
      io="$(dependency_generation_subtree_io "$holder_pid" || true)"
      if [ -n "$io" ] && [ -n "$last_io" ] && [ "$io" != "$last_io" ]; then
        last_progress="$now"
      fi
      last_io="$io"
      next_sample=$((now + ${DEPENDENCY_GENERATION_COPY_LOCK_SAMPLE_SEC:-5}))
    fi
    idle=$((now - last_progress))
    reason=''
    if [ "$waited" -ge "$max_sec" ]; then
      reason=cap
    elif [ "$idle" -ge "$timeout_sec" ]; then
      if [ -n "$last_io" ]; then reason=stalled; else reason=unmeasurable; fi
    fi
    if [ -n "$reason" ]; then
      # Sampling can span the holder's exit. Recheck the lock before rejecting
      # an unmeasurable/stalled sample or an elapsed cap: a free lock is ready
      # to acquire even when the last measurement describes its former holder.
      if flock -n "$fd"; then
        break
      fi
      dependency_generation_log "DEPENDENCY_GENERATION_LOCK_TIMEOUT waited=${waited}s idle=${idle}s timeout=${timeout_sec}s max=${max_sec}s reason=$reason holder=${holder:-unknown} op=$op lock=$lock"
      exec {fd}>&-
      return 76
    fi
    if [ "$waited" -ge "$next_notice" ]; then
      dependency_generation_log "still waiting for the host dependency-copy lock after ${waited}s (idle ${idle}s of ${timeout_sec}s, cap ${max_sec}s; holder ${holder:-unknown})"
      next_notice=$((waited + 30))
    fi
    sleep 0.2
  done
  printf 'pid=%s op=%s since=%s\n' "${BASHPID:-$$}" "$op" "$(date +%s)" > "$lock.holder" 2>/dev/null || true
  DEPENDENCY_GENERATION_COPY_LOCK_FD="$fd"
  DEPENDENCY_GENERATION_COPY_LOCK_DEPTH=1
}

dependency_generation_release_copy_lock() {
  local fd
  [ "$DEPENDENCY_GENERATION_COPY_LOCK_DEPTH" -gt 0 ] || return 0
  DEPENDENCY_GENERATION_COPY_LOCK_DEPTH=$((DEPENDENCY_GENERATION_COPY_LOCK_DEPTH - 1))
  [ "$DEPENDENCY_GENERATION_COPY_LOCK_DEPTH" -eq 0 ] || return 0
  fd="$DEPENDENCY_GENERATION_COPY_LOCK_FD"
  DEPENDENCY_GENERATION_COPY_LOCK_FD=''
  [ -n "$fd" ] || return 0
  flock -u "$fd" 2>/dev/null || true
  exec {fd}>&-
}

# Pure: the free bytes a copy needs before it may start.
dependency_generation_headroom_required() {
  printf '%s\n' "$(( $1 + $2 + $3 ))"
}

# Prints a statfs quantity in bytes: field %a = available, %b = total.
dependency_generation_fs_bytes() {
  local path="$1" field="$2" out blocks size
  case "$field" in
    %a) [ -n "${DEPENDENCY_GENERATION_HEADROOM_AVAIL_BYTES:-}" ] \
      && { printf '%s\n' "$DEPENDENCY_GENERATION_HEADROOM_AVAIL_BYTES"; return 0; } ;;
    %b) [ -n "${DEPENDENCY_GENERATION_HEADROOM_TOTAL_BYTES:-}" ] \
      && { printf '%s\n' "$DEPENDENCY_GENERATION_HEADROOM_TOTAL_BYTES"; return 0; } ;;
  esac
  out="$(stat -f -c "$field %S" "$path" 2>/dev/null)" || return 1
  blocks="${out%% *}"
  size="${out##* }"
  case "$blocks$size" in ''|*[!0-9]*) return 1 ;; esac
  printf '%s\n' "$((blocks * size))"
}

# WI-10005931: the reserve-protected filesystem. The percentage reserve exists
# so concurrent copies cannot push the filesystem git-sync fetches into under
# its 2% fetch reserve; that is the filesystem holding the integration root.
# main records it here. A sourced caller that never sets it keeps the full
# reserve everywhere (fail-closed).
DEPENDENCY_GENERATION_RESERVE_FS_PATH="${DEPENDENCY_GENERATION_RESERVE_FS_PATH:-}"

# Succeeds when `dir` is on the reserve-protected filesystem, or when that
# cannot be established (unset path, stat failure) — unknown means protected.
# DEPENDENCY_GENERATION_HEADROOM_SAME_FS=0|1 overrides the device comparison
# (test seam, like the AVAIL/TOTAL byte overrides above).
dependency_generation_on_reserve_fs() {
  local dir="$1" protected="${DEPENDENCY_GENERATION_RESERVE_FS_PATH:-}" a b
  case "${DEPENDENCY_GENERATION_HEADROOM_SAME_FS:-}" in
    0) return 1 ;;
    1) return 0 ;;
  esac
  [ -n "$protected" ] || return 0
  a="$(stat -c %d "$dir" 2>/dev/null)" || return 0
  b="$(stat -c %d "$protected" 2>/dev/null)" || return 0
  [ -n "$a" ] && [ -n "$b" ] || return 0
  [ "$a" = "$b" ]
}

# Looks up a published tree's recorded size from its generation's .tree-bytes
# sidecar (`rel<TAB>bytes`). The source path is `<generation>/tree/<rel>`.
# Never walks the tree (WI-474827: materialization must stay walk-free).
dependency_generation_tree_bytes_lookup() {
  local src="$1" generation rel
  case "$src" in */tree/*) ;; *) return 1 ;; esac
  generation="${src%%/tree/*}"
  rel="${src#*/tree/}"
  [ -f "$generation/.tree-bytes" ] || return 1
  awk -F '\t' -v rel="$rel" \
    '$1 == rel && $2 ~ /^[0-9]+$/ { print $2; found = 1; exit } END { exit !found }' \
    "$generation/.tree-bytes"
}

# Appends `rel<TAB>bytes` for a tree in a generation being built. A reused tree
# carries the size its predecessor recorded; anything else is measured once,
# at publish, while the just-copied tree is still in the page cache.
dependency_generation_record_tree_bytes() {
  local build="$1" rel="$2" known_src="${3:-}" bytes=''
  if [ -n "$known_src" ]; then
    bytes="$(dependency_generation_tree_bytes_lookup "$known_src" 2>/dev/null || true)"
  fi
  if [ -z "$bytes" ]; then
    bytes="$(du -s -B1 -- "$build/tree/$rel" 2>/dev/null | awk '{ print $1; exit }' || true)"
  fi
  case "$bytes" in ''|*[!0-9]*) return 0 ;; esac
  printf '%s\t%s\n' "$rel" "$bytes" >> "$build/.tree-bytes"
}

# Fail-closed headroom check, run under the copy lock. `size_ref` is the path
# whose recorded size to use; an unknown size checks only reserve + margin.
dependency_generation_check_headroom() {
  local size_ref="$1" dest="$2" dir pct margin need size_note total reserve required avail base
  local cap reserve_scope
  dir="$(dirname "$dest")"
  pct="${DEPENDENCY_GENERATION_HEADROOM_RESERVE_PCT:-2}"
  case "$pct" in ''|*[!0-9]*) pct=2 ;; esac
  margin="${DEPENDENCY_GENERATION_HEADROOM_MARGIN_BYTES:-10737418240}"
  case "$margin" in ''|*[!0-9]*) margin=10737418240 ;; esac
  cap="${DEPENDENCY_GENERATION_HEADROOM_OTHER_FS_RESERVE_CAP_BYTES:-21474836480}"
  case "$cap" in ''|*[!0-9]*) cap=21474836480 ;; esac
  if need="$(dependency_generation_tree_bytes_lookup "$size_ref" 2>/dev/null)"; then
    size_note="size=recorded"
  else
    need=0
    size_note="size=unknown"
  fi
  if ! total="$(dependency_generation_fs_bytes "$dir" %b)" \
    || ! avail="$(dependency_generation_fs_bytes "$dir" %a)"; then
    dependency_generation_log "headroom check skipped: cannot statfs $dir"
    return 0
  fi
  reserve=$((total * pct / 100))
  # WI-10005931: 2% of an 8 TB data disk is 160 GB, which refused a 9 GB copy
  # with 165 GB free. Off the protected filesystem the percentage only guards
  # against filling the disk, so it is capped; the margin still applies.
  if dependency_generation_on_reserve_fs "$dir"; then
    reserve_scope='protected-fs'
  else
    reserve_scope='other-fs'
    [ "$reserve" -le "$cap" ] || reserve="$cap"
  fi
  required="$(dependency_generation_headroom_required "$need" "$reserve" "$margin")"
  if [ "$avail" -lt "$required" ]; then
    base="${dest%.generation-tmp.*}"
    base="${base%.copy-up.*}"
    base="${base%.deploy-tmp.*}"
    dependency_generation_reap_dead_siblings "$base"
    avail="$(dependency_generation_fs_bytes "$dir" %a)" || avail=0
  fi
  if [ "$avail" -lt "$required" ]; then
    dependency_generation_log "DEPENDENCY_GENERATION_HEADROOM_INSUFFICIENT need=$need avail=$avail reserve=$reserve reserve_scope=$reserve_scope margin=$margin required=$required $size_note path=$dest"
    return 77
  fi
  return 0
}

# Publish callers return 1 for any copy failure, except the typed infra exits,
# which pass through so the gate can classify them.
dependency_generation_copy_failure_rc() {
  case "$1" in 76|77) printf '%s\n' "$1" ;; *) printf '1\n' ;; esac
}

dependency_generation_copy_independent() {
  local src="$1" dest="$2" size_ref="${3:-$1}" rc=0
  mkdir -p "$(dirname "$dest")"
  dependency_generation_acquire_copy_lock "copy ${dest##*/tree/}" || return $?
  dependency_generation_check_headroom "$size_ref" "$dest" || rc=$?
  if [ "$rc" -eq 0 ]; then
    # GNU cp uses a CoW clone where available and a regular independent copy
    # otherwise. BSD/BusyBox cp reject --reflink; retry with portable `cp -a`.
    if ! dependency_generation_copy_with_progress "$src" "$dest" --reflink=auto; then
      rm -rf -- "$dest"
      dependency_generation_copy_with_progress "$src" "$dest" || rc=$?
    fi
  fi
  dependency_generation_release_copy_lock
  return "$rc"
}

# WI-10004094: a changed root tree is one ~16 GB `cp -a` on ext4 (no reflink),
# and it prints nothing. Callers judge liveness by output (green-checkpoint's
# 30m no-output budget), so a copy starved to ~1 MB/s was killed as a hang.
# Report the bytes the copy has written, but only when they have grown since the
# last report: a copy that stops writing stays silent, so it still reads as wedged.
dependency_generation_copy_with_progress() {
  local src="$1" dest="$2" reflink="${3:-}" pid rc=0 interval started now next
  local written='' reported='' nap=0.05
  interval="${DEPENDENCY_GENERATION_COPY_PROGRESS_SEC:-60}"
  case "$interval" in ''|*[!0-9]*|0) interval=60 ;; esac
  if [ -n "$reflink" ]; then
    cp -a "$reflink" "$src" "$dest" 2>/dev/null &
  else
    cp -a "$src" "$dest" &
  fi
  pid=$!
  started="$(date +%s)"
  next=$((started + interval))
  while kill -0 "$pid" 2>/dev/null; do
    # Short first naps keep the many small copies fast; long copies poll at 1s.
    sleep "$nap"
    case "$nap" in 0.05) nap=0.2 ;; 0.2) nap=1 ;; esac
    now="$(date +%s)"
    [ "$now" -ge "$next" ] || continue
    next=$((now + interval))
    # write_bytes misses tmpfs and wchar misses copy_file_range; either grows
    # while the copy makes progress, so report the larger.
    written="$(awk '/^(wchar|write_bytes):/ { if ($2 > m) m = $2 } END { if (NR) print m + 0 }' \
      "/proc/$pid/io" 2>/dev/null || true)"
    case "$written" in ''|*[!0-9]*) continue ;; esac
    if [ "$written" -gt "${reported:-0}" ]; then
      reported="$written"
      dependency_generation_log \
        "copy progress: ${dest##*/tree/} written=$((written / 1048576))MiB elapsed=$((now - started))s"
    fi
  done
  wait "$pid" || rc=$?
  return "$rc"
}

# P-012 (WI-10004927): incremental copy of a CHANGED dependency tree.
#
# A changed tree used to be one full `cp -a` from the live checkout into the
# store. The live tree (ext4) and the store (XFS) are different filesystems, so
# no reflink is possible and a papercusp root change cost ~21 GiB of IO to carry
# a few MB of real change. Measured 2026-10-01: 555 of 301,040 files differed
# between the 06:39 and 12:19 papercusp generations.
#
# Instead, reflink-clone the predecessor's copy of the same tree (same store
# filesystem, metadata only), then replace only the paths whose live source
# record changed since the predecessor captured it.
#
# Soundness. Each generation stores, per tree, the source records it was built
# from: path, type, mode, uid, gid, size, mtime, inode, ctime and link target,
# captured BEFORE its copy started. A file is reused only when its live record
# is byte-identical to the stored one. ctime cannot be set from userspace and
# moves on every content or metadata change, so an equal (inode, ctime) proves
# the file is unchanged since that capture, so the predecessor holds its bytes.
# Size and mtime alone (rsync's quick check) would be unsound: npm extracts
# package files with a fixed 1985 mtime. Records whose ctime falls within
# DEPENDENCY_GENERATION_RACY_WINDOW_SEC of their capture are never trusted,
# because a rewrite in the same clock tick could keep the timestamp. The result
# is then verified path by path against the live records (type, mode, size,
# mtime, link target); any difference falls back to the full copy.
DEPENDENCY_GENERATION_RACY_WINDOW_SEC="${DEPENDENCY_GENERATION_RACY_WINDOW_SEC:-2}"
DEPENDENCY_GENERATION_TREES_INCREMENTAL=0

dependency_generation_incremental_supported() {
  [ "${DEPENDENCY_GENERATION_INCREMENTAL_COPY:-1}" = '1' ] || return 1
  [ "${DEPENDENCY_GENERATION_FORCE_PORTABLE_STAT:-0}" != '1' ] || return 1
  find . -maxdepth 0 -printf '' >/dev/null 2>&1 || return 1
  case "$(tar --version 2>/dev/null)" in *'GNU tar'*) ;; *) return 1 ;; esac
  command -v gzip >/dev/null 2>&1 && command -v comm >/dev/null 2>&1 \
    && printf '' | sha256sum -z >/dev/null 2>&1
}

# Write the C-sorted source records of one dependency tree to $2, pruned exactly
# like dependency_generation_prune_ephemeral. Exit 2: a path or link target holds
# a control character, which the line-oriented records cannot carry.
dependency_generation_source_records() {
  local root="$1" out="$2" rc=0
  [ -d "$root" ] || return 1
  (
    cd "$root" || exit 1
    LC_ALL=C find . -xdev -mindepth 1 \
      \( \( -path ./.cache -o -path ./.package-lock.json \
        -o -path ./.papercusp-isolated-snapshot \
        -o \( -type d \( -name .astro -o -name .vite -o -name .vite-temp -o -name .verdict-data \) \) \) \
        -prune \) -o \
      \( \( -name '*[[:cntrl:]]*' -o -lname '*[[:cntrl:]]*' \) -printf '\001\n' \) -o \
      -printf '%P\t%y\t%m\t%U\t%G\t%s\t%T@\t%i\t%C@\t%l\n'
  ) > "$out.unsorted" || rc=1
  if [ "$rc" -eq 0 ] && LC_ALL=C grep -q $'^\001' "$out.unsorted"; then
    rc=2
  fi
  if [ "$rc" -eq 0 ]; then
    LC_ALL=C sort -o "$out" "$out.unsorted" || rc=1
  fi
  rm -f -- "$out.unsorted"
  return "$rc"
}

# The verified view of a record: what a full `cp -a` plus the freeze reproduces.
# Inode and ctime belong to each copy. Directory size and mtime depend on the
# filesystem and on pruning. The freeze strips file write bits.
dependency_generation_records_projection() {
  LC_ALL=C awk -F '\t' -v OFS='\t' '
    function frozen(mode,   n, i, d, out) {
      n = length(mode); out = ""
      for (i = 1; i <= n; i++) {
        d = substr(mode, i, 1) + 0
        if (i > n - 3 && int(d / 2) % 2 == 1) d -= 2
        out = out d
      }
      return out
    }
    NF != 10 { bad = 1; exit }
    $2 == "d" { print $1, $2, $3; next }
    $2 == "l" { print $1, $2, $10; next }
    $2 == "f" { print $1, $2, frozen($3), $6, $7; next }
    { print $1, $2, $3, $6, $7 }
    END { if (bad) exit 3 }
  ' "$1"
}

dependency_generation_records_key() {
  printf '%s' "$1" | dependency_generation_sha256
}

# Index line: rel, capture time (ns), key (sha256 of rel), sha256 of the gzip.
dependency_generation_records_index_line() {
  local rel="$1" captured_ns="$2" key="$3" gz="$4" digest
  digest="$(dependency_generation_sha256 < "$gz")" || return 1
  printf '%s\t%s\t%s\t%s\n' "$rel" "$captured_ns" "$key" "$digest"
}

dependency_generation_records_store() {
  local build="$1" rel="$2" records="$3" captured_ns="$4" dir key line
  dir="$build/.source-records"
  [[ "$captured_ns" =~ ^[0-9]+$ ]] || return 1
  mkdir -p "$dir" || return 1
  key="$(dependency_generation_records_key "$rel")" || return 1
  gzip -1 -n -c -- "$records" > "$dir/$key.gz" || return 1
  line="$(dependency_generation_records_index_line "$rel" "$captured_ns" "$key" "$dir/$key.gz")" \
    || return 1
  chmod a-w "$dir/$key.gz" 2>/dev/null || true
  printf '%s\n' "$line" >> "$dir/index"
}

# Print "<capture ns><TAB><gzip path>" for a tree's stored, intact source records.
dependency_generation_records_lookup() {
  local generation="$1" rel="$2" dir line ignored captured_ns key digest
  dir="$generation/.source-records"
  [ -f "$dir/index" ] || return 1
  line="$(awk -F '\t' -v rel="$rel" \
    '$1 == rel { line = $0 } END { if (line == "") exit 1; print line }' "$dir/index")" \
    || return 1
  IFS=$'\t' read -r ignored captured_ns key digest <<< "$line"
  [[ "$captured_ns" =~ ^[0-9]+$ ]] && [[ "$key" =~ ^[0-9a-f]{64}$ ]] \
    && [[ "$digest" =~ ^[0-9a-f]{64}$ ]] && [ -f "$dir/$key.gz" ] || return 1
  [ "$(dependency_generation_records_key "$rel")" = "$key" ] || return 1
  [ "$(dependency_generation_sha256 < "$dir/$key.gz")" = "$digest" ] || return 1
  printf '%s\t%s\n' "$captured_ns" "$dir/$key.gz"
}

# A reused tree is a clone of the predecessor's copy, so the predecessor's
# records describe it exactly. Carry them forward unchanged.
dependency_generation_records_carry() {
  local predecessor="$1" build="$2" rel="$3" found captured_ns gz dir key line
  found="$(dependency_generation_records_lookup "$predecessor" "$rel" 2>/dev/null)" || return 0
  captured_ns="${found%%$'\t'*}"
  gz="${found#*$'\t'}"
  dir="$build/.source-records"
  key="${gz##*/}"
  key="${key%.gz}"
  mkdir -p "$dir" && cp -- "$gz" "$dir/$key.gz" || return 0
  line="$(dependency_generation_records_index_line "$rel" "$captured_ns" "$key" "$dir/$key.gz")" \
    || return 0
  chmod a-w "$dir/$key.gz" 2>/dev/null || true
  printf '%s\n' "$line" >> "$dir/index"
}

# Write to $3/verified the unmatched regular files whose bytes equal the seed's.
# A candidate matches a predecessor record on path, type, mode, owner, size and
# mtime, and differs only in ctime or inode. Neither difference proves new bytes:
# a hard-linked sibling checkout changes the link count of every source inode on
# each refresh, which bumps every ctime, and a record inside the racy window is
# not trusted. An in-place rewrite that keeps size and mtime fails the byte
# comparison, so it is still copied (plan papercusp-log-performance-remediation
# D-018). Any hashing failure only shrinks the verified set: those files are
# copied, so a failure can never keep a wrong file.
dependency_generation_incremental_verify() {
  local src="$1" seed="$2" work="$3" live_pid live_rc=0 seed_rc=0
  : > "$work/verified" || return 1
  LC_ALL=C awk -F '\t' '
    FILENAME == ARGV[1] { if ($2 == "f") id[$1 FS $3 FS $4 FS $5 FS $6 FS $7] = 1; next }
    $2 == "f" && (($1 FS $3 FS $4 FS $5 FS $6 FS $7) in id) { print $1 }
  ' "$work/predecessor" "$work/unmatched" > "$work/candidates" || return 1
  [ -s "$work/candidates" ] || return 0
  tr '\n' '\0' < "$work/candidates" > "$work/candidates0" || return 1
  ( cd "$src" && xargs -0 -r sha256sum -z -- < "$work/candidates0" 2>/dev/null ) \
    > "$work/live.sums" &
  live_pid=$!
  ( cd "$seed" && xargs -0 -r sha256sum -z -- < "$work/candidates0" 2>/dev/null ) \
    > "$work/seed.sums" || seed_rc=$?
  wait "$live_pid" || live_rc=$?
  # 123: some file vanished or was unreadable, and sha256sum still printed a
  # complete line for every file it hashed. Higher: xargs or sha256sum itself
  # failed, so verify nothing and let every candidate be copied.
  [ "$live_rc" -le 123 ] && [ "$seed_rc" -le 123 ] || return 0
  tr '\0' '\n' < "$work/live.sums" | LC_ALL=C sort > "$work/live.sorted" || return 1
  tr '\0' '\n' < "$work/seed.sums" | LC_ALL=C sort > "$work/seed.sorted" || return 1
  # Each line is the 64-hex digest, two spaces, then the path.
  LC_ALL=C comm -12 "$work/live.sorted" "$work/seed.sorted" | cut -c67- > "$work/verified"
}

# Build $dest as $src from $seed, the predecessor's copy of the same tree.
# Exit 0: $dest is verified against $live_records. 76/77: the typed copy-lock
# and headroom exits, which a full copy would hit too. Anything else: $dest is
# removed and the caller copies the tree in full.
dependency_generation_copy_incremental() {
  local src="$1" dest="$2" seed="$3" pred_records="$4" pred_captured_ns="$5"
  local live_records="$6" work="$7" rc=0 floor kept copied removed copied_bytes verified
  rm -rf -- "$work"
  mkdir -p "$work" || return 1
  gzip -dc -- "$pred_records" > "$work/predecessor" || return 1
  floor="$(awk -v ns="$pred_captured_ns" -v w="$DEPENDENCY_GENERATION_RACY_WINDOW_SEC" \
    'BEGIN { printf "%.6f", ns / 1e9 - w }')" || return 1
  LC_ALL=C awk -F '\t' -v floor="$floor" '
    NF != 10 { bad = 1; exit }
    ($9 + 0) < (floor + 0) { print }
    END { if (bad) exit 3 }
  ' "$work/predecessor" > "$work/trusted" || return 1
  LC_ALL=C comm -12 "$live_records" "$work/trusted" > "$work/exact" || return 1
  LC_ALL=C comm -23 "$live_records" "$work/trusted" > "$work/unmatched" || return 1
  dependency_generation_incremental_verify "$src" "$seed" "$work" || return 1
  LC_ALL=C awk -F '\t' -v verified="$work/kept-verified" -v changed="$work/changed" '
    FILENAME == ARGV[1] { same[$0] = 1; next }
    ($1 in same) { print > verified; next }
    { print > changed }
  ' "$work/verified" "$work/unmatched" || return 1
  touch "$work/kept-verified" "$work/changed" || return 1
  # Both are subsequences of the C-sorted live records, so a merge keeps the order.
  LC_ALL=C sort -m -o "$work/kept" "$work/exact" "$work/kept-verified" || return 1
  cut -f1 "$work/changed" | tr '\n' '\0' > "$work/copy0" || return 1
  # A seed path survives only as a reused file, or as a directory that still
  # exists live; tar then resets the metadata of every changed directory.
  LC_ALL=C awk -F '\t' -v live="$live_records" -v kept="$work/kept" '
    FILENAME == live { if ($2 == "d") dir[$1] = 1; next }
    FILENAME == kept { keep[$1] = 1; next }
    $2 == "d" { if (!($1 in dir)) print $1; next }
    !($1 in keep) { print $1 }
  ' "$live_records" "$work/kept" "$work/predecessor" > "$work/remove" || return 1
  tr '\n' '\0' < "$work/remove" > "$work/remove0" || return 1
  kept="$(awk -F '\t' '$2 != "d" { n++ } END { print n + 0 }' "$work/kept")"
  copied="$(awk -F '\t' '$2 != "d" { n++ } END { print n + 0 }' "$work/changed")"
  copied_bytes="$(awk -F '\t' '$2 == "f" { s += $6 } END { printf "%.0f\n", s }' "$work/changed")"
  removed="$(awk 'END { print NR + 0 }' "$work/remove")"
  verified="$(awk 'END { print NR + 0 }' "$work/kept-verified")"

  dependency_generation_acquire_copy_lock "incremental ${dest##*/tree/}" || return $?
  dependency_generation_check_headroom "$seed" "$dest" || rc=$?
  if [ "$rc" -eq 0 ]; then
    rm -rf -- "$dest"
    mkdir -p "$(dirname "$dest")"
    dependency_generation_copy_with_progress "$seed" "$dest" \
      "--reflink=${DEPENDENCY_GENERATION_INCREMENTAL_SEED_REFLINK:-always}" || rc=1
  fi
  if [ "$rc" -eq 0 ]; then
    ( cd "$dest" && xargs -0 -r rm -rf -- < "$work/remove0" ) || rc=1
  fi
  if [ "$rc" -eq 0 ] && [ -s "$work/copy0" ]; then
    (
      set -o pipefail
      tar -C "$src" --format=posix --no-recursion --null --verbatim-files-from \
        -T "$work/copy0" -cf - | tar -C "$dest" -xpf -
    ) || rc=1
  fi
  dependency_generation_release_copy_lock
  if [ "$rc" -eq 0 ]; then
    if ! dependency_generation_source_records "$dest" "$work/result" \
      || ! dependency_generation_records_projection "$live_records" > "$work/expected" \
      || ! dependency_generation_records_projection "$work/result" > "$work/actual" \
      || ! cmp -s "$work/expected" "$work/actual"; then
      dependency_generation_log \
        "incremental copy of ${dest##*/tree/} did not reproduce the live tree"
      rc=1
    fi
  fi
  if [ "$rc" -ne 0 ]; then
    [ ! -e "$dest" ] || chmod -R u+w "$dest" 2>/dev/null || true
    rm -rf -- "$dest"
    case "$rc" in 76|77) return "$rc" ;; *) return 1 ;; esac
  fi
  dependency_generation_log \
    "INCREMENTAL schema=1 tree=${dest##*/tree/} kept=$kept copied=$copied removed=$removed copied_bytes=$copied_bytes verified=$verified"
}

# Copy one changed or new tree into the build and store its source records.
# With a predecessor that recorded the same tree, try the incremental copy
# first. Otherwise, or after any non-typed incremental failure, copy in full.
dependency_generation_copy_changed_tree() {
  local src="$1" dest="$2" build="$3" rel="$4" predecessor="${5:-}"
  local work="$build/.incremental-work" live="$build/.incremental-live"
  local captured_ns='' records_rc=1 found='' rc=1 size_ref=''
  if dependency_generation_incremental_supported; then
    captured_ns="$(dependency_generation_now_ns)"
    records_rc=0
    dependency_generation_source_records "$src" "$live" || records_rc=$?
  fi
  if [ -n "$predecessor" ] && [ -d "$predecessor/tree/$rel" ]; then
    size_ref="$predecessor/tree/$rel"
    if [ "$records_rc" -eq 0 ]; then
      found="$(dependency_generation_records_lookup "$predecessor" "$rel" 2>/dev/null || true)"
    fi
  fi
  if [ -n "$found" ]; then
    rc=0
    dependency_generation_copy_incremental "$src" "$dest" "$predecessor/tree/$rel" \
      "${found#*$'\t'}" "${found%%$'\t'*}" "$live" "$work" || rc=$?
    rm -rf -- "$work"
    case "$rc" in
      0) DEPENDENCY_GENERATION_TREES_INCREMENTAL=$((DEPENDENCY_GENERATION_TREES_INCREMENTAL + 1)) ;;
      76|77) rm -f -- "$live"; return "$rc" ;;
      *)
        dependency_generation_log "incremental copy unavailable for $rel; copying it in full"
        rc=1
        ;;
    esac
  fi
  if [ "$rc" -ne 0 ]; then
    rc=0
    # `cp -a src dest` nests into an existing dest; the full copy needs none.
    if [ -e "$dest" ]; then
      chmod -R u+w "$dest" 2>/dev/null || true
      rm -rf -- "$dest"
    fi
    if [ -n "$size_ref" ]; then
      dependency_generation_copy_independent "$src" "$dest" "$size_ref" || rc=$?
    else
      dependency_generation_copy_independent "$src" "$dest" || rc=$?
    fi
  fi
  if [ "$rc" -eq 0 ] && [ "$records_rc" -eq 0 ]; then
    dependency_generation_records_store "$build" "$rel" "$live" "$captured_ns" \
      || dependency_generation_log "could not store source records for $rel"
  fi
  rm -f -- "$live"
  return "$rc"
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
  dependency_generation_reap_dead_siblings "$dest"
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
    # Propagate the typed lock/headroom exits (76/77) instead of letting the
    # missing tmp tree fail later as a generic mv error.
    dependency_generation_copy_independent "$src" "$tmp" || return $?
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
# One attempt either builds (holding the identity's in-flight lock) or joins a
# live peer's build of the same identity; a join is followed by a fresh attempt,
# which is a cache hit when the peer published (WI-10004094).
dependency_generation_ensure() {
  local rc joins=0 max_joins
  max_joins="${DEPENDENCY_GENERATION_MAX_JOINS:-4}"
  case "$max_joins" in ''|*[!0-9]*) max_joins=4 ;; esac
  while :; do
    rc=0
    dependency_generation_ensure_once "$@" || rc=$?
    dependency_generation_release_inflight
    [ "$rc" -eq "$DEPENDENCY_GENERATION_JOINED_RC" ] || return "$rc"
    joins=$((joins + 1))
    if [ "$joins" -gt "$max_joins" ]; then
      dependency_generation_log \
        "FATAL: joined $joins in-flight builds of this dependency set without one publishing a valid generation"
      return 73
    fi
  done
}

dependency_generation_ensure_once() {
  local integration_root="$1"
  local generation_root="${2:-$(dependency_generation_resolve_root "$integration_root")}"
  local source_before='' source_after='' identity generation build tree nm rel snapshot marker
  local quarantine before_manifest='' after_manifest='' tree_manifest='' tree_manifest_digest=''
  local publication_token='' created_ns=''
  local incumbent_token_before incumbent_token_after incumbent_token
  local current_incumbent_token publish_replacement publish_rc
  local total_started_ms phase_started_ms tree_total=0 tree_reused=0 tree_copied=0 tree_removed=0
  local predecessor_identity='none'
  local predecessor_fingerprint record_fingerprint extra reuse_manifest_eligible='false'
  local existing_generation_valid='false' cache_validation_outcome='miss' inflight_rc
  total_started_ms="$(dependency_generation_now_ms)"
  DEPENDENCY_GENERATION_TREES_INCREMENTAL=0
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

  # WI-10004094: build this identity at most once at a time. A live peer's build
  # is joined, not duplicated; a peer that published between our validation and
  # our acquisition is re-validated rather than rebuilt.
  inflight_rc=0
  dependency_generation_try_inflight "$generation_root" "$identity" || inflight_rc=$?
  if [ "$inflight_rc" -ne 0 ]; then
    dependency_generation_remove_build "$build"
    dependency_generation_wait_inflight "$generation_root" "$identity"
    return $?
  fi
  if dependency_generation_has_publication_contract "$generation" \
    && [ "$(dependency_generation_generation_token "$generation" 2>/dev/null || true)" != "$incumbent_token_after" ] \
    && dependency_generation_publication_is_valid \
      "$generation" "$identity" "$DEPENDENCY_GENERATION_CLOSURE_FINGERPRINT" \
      "$DEPENDENCY_GENERATION_SCOPE_MODE"; then
    dependency_generation_log "a concurrent build published $identity; re-validating it instead of rebuilding"
    dependency_generation_remove_build "$build"
    return "$DEPENDENCY_GENERATION_JOINED_RC"
  fi

  if [ "$reuse_manifest_eligible" = 'true' ] \
    && dependency_generation_find_reusable_predecessor \
      "$generation_root" "$identity" "$before_manifest"; then
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
        copy_rc=0
        dependency_generation_materialize_tree \
          "$DEPENDENCY_GENERATION_PREDECESSOR_TREE/$rel" "$tree/$rel" || copy_rc=$?
        if [ "$copy_rc" -ne 0 ]; then
          dependency_generation_release_selector_lease
          dependency_generation_emit_phase tree-copy "$phase_started_ms" failed \
            "trees_reused=$tree_reused trees_copied=$tree_copied trees_removed=$tree_removed predecessor=$predecessor_identity"
          dependency_generation_remove_build "$build"
          return "$(dependency_generation_copy_failure_rc "$copy_rc")"
        fi
        dependency_generation_prune_ephemeral "$tree/$rel"
        dependency_generation_record_tree_bytes "$build" "$rel" \
          "$DEPENDENCY_GENERATION_PREDECESSOR_TREE/$rel"
        dependency_generation_records_carry \
          "$DEPENDENCY_GENERATION_PREDECESSOR_PATH" "$build" "$rel"
        tree_reused=$((tree_reused + 1))
        dependency_generation_log \
          "reused dependency tree from $predecessor_identity: $rel mode=$DEPENDENCY_GENERATION_MATERIALIZE_MODE"
      else
        dependency_generation_log "copying changed dependency tree: $rel"
        copy_rc=0
        dependency_generation_copy_changed_tree "$nm" "$tree/$rel" "$build" "$rel" \
          "$DEPENDENCY_GENERATION_PREDECESSOR_PATH" || copy_rc=$?
        if [ "$copy_rc" -ne 0 ]; then
          dependency_generation_release_selector_lease
          dependency_generation_emit_phase tree-copy "$phase_started_ms" failed \
            "trees_reused=$tree_reused trees_copied=$tree_copied trees_removed=$tree_removed predecessor=$predecessor_identity"
          dependency_generation_remove_build "$build"
          return "$(dependency_generation_copy_failure_rc "$copy_rc")"
        fi
        dependency_generation_prune_ephemeral "$tree/$rel"
        dependency_generation_record_tree_bytes "$build" "$rel"
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
      copy_rc=0
      dependency_generation_copy_changed_tree "$nm" "$tree/$rel" "$build" "$rel" || copy_rc=$?
      if [ "$copy_rc" -ne 0 ]; then
        dependency_generation_emit_phase tree-copy "$phase_started_ms" failed \
          "trees_reused=$tree_reused trees_copied=$tree_copied trees_removed=$tree_removed predecessor=$predecessor_identity"
        dependency_generation_remove_build "$build"
        return "$(dependency_generation_copy_failure_rc "$copy_rc")"
      fi
      dependency_generation_prune_ephemeral "$tree/$rel"
      dependency_generation_record_tree_bytes "$build" "$rel"
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
      printf 'tree_manifest_schema=1\ntree_manifest_sha256=%s\npublication_schema=3\npredecessor=%s\ntrees_reused=%s\ntrees_copied=%s\ntrees_removed=%s\n' \
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

# ── Exact-ref builder (WI-10004151) ──────────────────────────────────────────────
# `--ensure-ref <ref>` publishes from the LIVE integration tree and then re-opens by the
# ref's own input key, so a ref whose dependency inputs differ from the live tree's was a
# PERMANENT typed miss (exit 74): no installed tree ever had those inputs. The frozen
# repair queue produces exactly that — a hunk-exact package-lock.json admission yields a
# lock no checkout has installed — and green-checkpoint verification then stalled with no
# way forward (repairHead 5955f82b, 2026-09-30).
#
# When the ref's lockfiles describe the same installed packages as the live ones, modulo
# live-only workspace LINKS (dependency-lock-equivalence.mjs decides and names them), the
# exact generation is the live trees minus those links. So: stage the ref's inputs in a
# private scratch root beside the live trees (same filesystem), prove the scratch input
# fingerprint equals the ref's, hardlink the live node_modules trees in, drop the links,
# and let the ordinary ensure path publish it under the ref's key. Anything that would
# need a real install is refused with the reasons, never published under a false key.
DEPENDENCY_GENERATION_EXACT_SCRATCH=''

dependency_generation_exact_scratch_parent() {
  printf '%s/.papercusp/dependency-exact-ref\n' "$1"
}

# Directories in the scratch root are fresh inodes; FILES are hardlinks shared with the
# live trees. Only ever widen directory modes: a file chmod would rewrite the live inode.
dependency_generation_remove_exact_scratch() {
  local scratch="$1"
  [ -n "$scratch" ] && [ -d "$scratch" ] || return 0
  find "$scratch" -type d ! -perm -u+w -exec chmod u+w {} + 2>/dev/null || true
  rm -rf -- "$scratch"
}

dependency_generation_cleanup_exact_scratch() {
  local scratch="${DEPENDENCY_GENERATION_EXACT_SCRATCH:-}"
  DEPENDENCY_GENERATION_EXACT_SCRATCH=''
  dependency_generation_remove_exact_scratch "$scratch"
}

# A killed builder leaves its scratch root behind. Reclaim same-host roots whose recorded
# writer is gone (and ownerless roots once old), exactly as abandoned .build-* dirs are.
dependency_generation_sweep_exact_scratch() {
  local parent="$1" host dir marker
  [ -d "$parent" ] || return 0
  host="$(dependency_generation_host)"
  for dir in "$parent"/*; do
    [ -d "$dir" ] || continue
    marker="$dir/.papercusp-exact-ref-writer"
    if { [ -f "$marker" ] && ! dependency_generation_writer_is_live "$marker" "$host"; } \
      || { [ ! -f "$marker" ] && dependency_generation_path_is_old "$dir"; }; then
      dependency_generation_log "removing abandoned exact-ref scratch $(basename "$dir")"
      dependency_generation_remove_exact_scratch "$dir"
    fi
  done
}

# Stages the ref's dependency inputs in a fresh scratch root and judges them against the
# live inputs. Leaves the scratch root in DEPENDENCY_GENERATION_EXACT_SCRATCH (the caller
# cleans up) and the helper's verdict lines in DEPENDENCY_GENERATION_EQUIVALENCE_VERDICT.
# Exit 0 = install-equivalent; 74 = NOT equivalent (reasons in the verdict, NOT logged here,
# because a prediction is not a failure); any other non-zero = the staging itself failed.
# Shared by the exact-ref builder and `--predict-ref`, so the admit-time prediction and
# the gate's build can never disagree about what is buildable.
DEPENDENCY_GENERATION_EQUIVALENCE_VERDICT=''
DEPENDENCY_GENERATION_EXACT_SOURCE_ROOT=''
DEPENDENCY_GENERATION_EXACT_SOURCE_INPUT=''

# A frozen repair can retain an older installed graph after staging moves on.
# Compare against published ancestors as well as live inputs, using the same
# equivalence proof and immutable selector validation. Never infer a donor from
# directory names or publish a selector merely because a generation exists.
dependency_generation_find_equivalent_prewarm() {
  local integration_root="$1" ref="$2" scratch="$3" generation_root="$4" helper="$5"
  local revision source_ref source_input source_manifest verdict rc basis
  local -a history_paths=(':(glob)**/package-lock.json' ':(glob)**/npm-shrinkwrap.json' ':(glob)**/patches/*.patch' '.gitmodules')
  while IFS= read -r revision; do
    [ -n "$revision" ] && history_paths+=("$revision")
  done < <(git -C "$integration_root" config --blob "$ref:.gitmodules" --get-regexp '\.path$' 2>/dev/null | awk '{ print $2 }' || true)
  basis="$scratch/.papercusp/prewarm-inputs"
  while IFS= read -r revision; do
    source_ref="$(git -C "$integration_root" rev-parse --verify "$revision^" 2>/dev/null)" || continue
    mkdir -p "$basis" || return 1
    source_manifest="$(dependency_generation_input_manifest_ref "$integration_root" "$source_ref" '' "$basis" 2>/dev/null | LC_ALL=C sort)" || { rm -rf -- "$basis"; continue; }
    source_input="$(dependency_generation_input_fingerprint "$basis")" || return 1
    if [ ! -f "$generation_root/.inputs/$source_input" ]; then
      rm -rf -- "$basis"
      continue
    fi
    printf '%s\n' "$source_manifest" > "$scratch/.basis-inputs" || return 1
    rc=0
    verdict="$("${DEPENDENCY_GENERATION_NODE:-node}" "$helper" \
      --ref-root "$scratch" --ref-manifest "$scratch/.ref-inputs" \
      --live-root "$basis" --live-manifest "$scratch/.basis-inputs")" || rc=$?
    rm -rf -- "$basis"
    rm -f -- "$scratch/.basis-inputs"
    [ "$rc" -eq 3 ] && continue
    [ "$rc" -eq 0 ] || return 1
    dependency_generation_select_input_fingerprint "$source_input" "$generation_root" || return $?
    DEPENDENCY_GENERATION_EXACT_SOURCE_ROOT="$DEPENDENCY_GENERATION_TREE"
    DEPENDENCY_GENERATION_EXACT_SOURCE_INPUT="$source_input"
    DEPENDENCY_GENERATION_EQUIVALENCE_VERDICT="$verdict"
    dependency_generation_log "exact-ref build: install-equivalent prewarmed generation $DEPENDENCY_GENERATION_ID from ancestor $source_ref"
    return 0
  done < <(git -C "$integration_root" log --first-parent --format=%H --max-count=32 "$ref" -- "${history_paths[@]}")
  return 74
}

dependency_generation_stage_exact_ref_inputs() {
  local integration_root="$1" ref="$2" exact_input="$3"
  local generation_root="${4:-$(dependency_generation_resolve_root "$integration_root")}"
  local parent scratch have ref_manifest live_manifest verdict rc
  local helper="${DEPENDENCY_GENERATION_LOCK_EQUIVALENCE:-$(dirname "${BASH_SOURCE[0]}")/dependency-lock-equivalence.mjs}"
  DEPENDENCY_GENERATION_EQUIVALENCE_VERDICT=''
  DEPENDENCY_GENERATION_EXACT_SOURCE_ROOT="$integration_root"
  DEPENDENCY_GENERATION_EXACT_SOURCE_INPUT=''
  parent="$(dependency_generation_exact_scratch_parent "$integration_root")"
  mkdir -p "$parent" || return 1
  dependency_generation_sweep_exact_scratch "$parent"
  scratch="$(mktemp -d "$parent/${exact_input:0:16}.XXXXXX")" || return 1
  DEPENDENCY_GENERATION_EXACT_SCRATCH="$scratch"
  dependency_generation_write_owner "$scratch/.papercusp-exact-ref-writer" || return 1

  # 1. The ref's dependency inputs, materialised by the same walk that keys them.
  ref_manifest="$(
    dependency_generation_input_manifest_ref "$integration_root" "$ref" '' "$scratch" \
      | LC_ALL=C sort
  )" || return $?

  # 2. Proof the staging reproduces the ref's key before anything is built on it.
  have="$(dependency_generation_input_fingerprint "$scratch")" || return 1
  [ "$have" = "$exact_input" ] || {
    dependency_generation_log \
      "FATAL: exact-ref scratch inputs $have do not reproduce ref $ref inputs $exact_input"
    return 1
  }

  # 3. Install-equivalence against the live inputs.
  live_manifest="$(dependency_generation_input_manifest "$integration_root")" || return 1
  printf '%s\n' "$ref_manifest" > "$scratch/.ref-inputs" || return 1
  printf '%s\n' "$live_manifest" > "$scratch/.live-inputs" || return 1
  rc=0
  verdict="$(
    "${DEPENDENCY_GENERATION_NODE:-node}" "$helper" \
      --ref-root "$scratch" --ref-manifest "$scratch/.ref-inputs" \
      --live-root "$integration_root" --live-manifest "$scratch/.live-inputs"
  )" || rc=$?
  DEPENDENCY_GENERATION_EQUIVALENCE_VERDICT="$verdict"
  if [ "$rc" -eq 3 ]; then
    local cached_rc=0
    dependency_generation_find_equivalent_prewarm "$integration_root" "$ref" "$scratch" "$generation_root" "$helper" || cached_rc=$?
    rm -f -- "$scratch/.ref-inputs" "$scratch/.live-inputs"
    [ "$cached_rc" -eq 0 ] && return 0
    [ "$cached_rc" -eq 74 ] || return "$cached_rc"
  else
    rm -f -- "$scratch/.ref-inputs" "$scratch/.live-inputs"
  fi
  [ "$rc" -eq 3 ] && return 74
  [ "$rc" -eq 0 ] || {
    dependency_generation_log "FATAL: dependency-lock-equivalence failed rc=$rc for ref $ref"
    return 1
  }
  return 0
}

# Prints the scratch root on success. Exit 74 = the ref is not buildable from the live
# trees (a typed miss that names why); any other non-zero = the build itself failed.
dependency_generation_prepare_exact_ref_root() {
  local integration_root="$1" ref="$2" exact_input="$3"
  local generation_root="${4:-$(dependency_generation_resolve_root "$integration_root")}"
  local scratch verdict rc line drop trees=0
  rc=0
  dependency_generation_stage_exact_ref_inputs \
    "$integration_root" "$ref" "$exact_input" "$generation_root" || rc=$?
  scratch="$DEPENDENCY_GENERATION_EXACT_SCRATCH"
  verdict="$DEPENDENCY_GENERATION_EQUIVALENCE_VERDICT"
  if [ "$rc" -eq 74 ]; then
    dependency_generation_log \
      "FATAL: no prewarmed dependency generation for input fingerprint $exact_input; exact-ref build refused: ref $ref dependency inputs are not install-equivalent to the live tree's:"
    while IFS= read -r line; do
      [ -n "$line" ] && dependency_generation_log "  ${line#NOT_EQUIVALENT$'\t'}"
    done <<< "$verdict"
    return 74
  fi
  [ "$rc" -eq 0 ] || return "$rc"

  # Identical installed content needs only another exact-input selector. Keep
  # the existing immutable generation rather than copying its trees again.
  if [ -n "$DEPENDENCY_GENERATION_EXACT_SOURCE_INPUT" ] && [ -z "$verdict" ]; then
    printf '%s\n' "$scratch"
    return 0
  fi

  # Retention may remove a cached donor while we walk it. Revalidate its
  # selected token under the publication lock and lease it until every file
  # has its own scratch hardlink; the scratch then owns those bytes itself.
  if [ -n "$DEPENDENCY_GENERATION_EXACT_SOURCE_INPUT" ]; then
    dependency_generation_acquire_selector_lease \
      "$generation_root" "$DEPENDENCY_GENERATION_ID" "$$" "$DEPENDENCY_GENERATION_TOKEN" || return $?
  fi

  # 4. Hardlink the installed trees (metadata only; ensure copies from here).
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    drop="${line#"$DEPENDENCY_GENERATION_EXACT_SOURCE_ROOT"/}"
    mkdir -p "$scratch/$(dirname "$drop")" || {
      dependency_generation_release_selector_lease
      return 1
    }
    cp -al -- "$line" "$scratch/$drop" || {
      dependency_generation_release_selector_lease
      dependency_generation_log "FATAL: cannot hardlink $drop into the exact-ref scratch root (same filesystem required)"
      return 1
    }
    trees=$((trees + 1))
  done < <(dependency_generation_enumerate_node_modules "$DEPENDENCY_GENERATION_EXACT_SOURCE_ROOT")
  dependency_generation_release_selector_lease

  # 5. Drop the live-only workspace links the ref's lock does not have.
  while IFS=$'\t' read -r line drop; do
    [ "$line" = 'DROP_LINK' ] || continue
    if [ -L "$scratch/$drop" ]; then
      rm -f -- "$scratch/$drop" || return 1
      dependency_generation_log "exact-ref build: dropped live-only workspace link $drop"
    elif [ -e "$scratch/$drop" ]; then
      dependency_generation_log \
        "FATAL: no prewarmed dependency generation for input fingerprint $exact_input; exact-ref build refused: $drop is a live-only lock link but not a symlink on disk"
      return 74
    fi
  done <<< "$verdict"
  dependency_generation_log \
    "exact-ref build: staged ref $ref inputs $exact_input with $trees hardlinked live trees"
  printf '%s\n' "$scratch"
}

dependency_generation_main() {
  local integration_root='' generation_root='' select_inputs_from='' ensure_ref='' fingerprint_ref='' retention_rc=0 prune_only=''
  local input_before='' input_after='' exact_input='' selector='' lease_owner_pid='' live_input='' build_root=''
  local predict_ref='' predict_verdict='' predict_rc=0 line
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
      --predict-ref) predict_ref="$2"; shift 2 ;;
      --prune-only) prune_only='1'; shift ;;
      *) dependency_generation_log "unknown arg: $1"; return 2 ;;
    esac
  done
  [ -z "$predict_ref" ] || {
    [ -z "$select_inputs_from$ensure_ref$fingerprint_ref$lease_owner_pid$prune_only" ] \
      && [ "${#workspace_dirs[@]}" -eq 0 ] || {
      dependency_generation_log '--predict-ref cannot be combined with another mode or --workspace-dir'
      return 2
    }
  }
  [ -n "$integration_root" ] || {
    dependency_generation_log '--integration is required'
    return 2
  }
  integration_root="$(cd "$integration_root" && pwd -P)"
  build_root="$integration_root"
  # WI-10005931: git-sync fetches into the integration checkout, so its
  # filesystem is the one the percentage headroom reserve protects.
  DEPENDENCY_GENERATION_RESERVE_FS_PATH="${DEPENDENCY_GENERATION_RESERVE_FS_PATH:-$integration_root}"
  # Preserve an explicit CLI root, then honor the service-level override, then
  # the root that override recorded for this integration root (WI-10005159),
  # before falling back to the integration checkout's local generation store.
  generation_root="$(dependency_generation_resolve_root "$integration_root" "$generation_root")"
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
  if [ -n "$predict_ref" ]; then
    # Admit-time prediction (WI-10004151 part 2): would `--ensure-ref <ref>` succeed right
    # now? Read-only against the store and the live trees; stages only the ref's lockfiles.
    #   prewarmed  — a selector for the ref's inputs already exists
    #   live-match — the ref's inputs equal the live tree's; ensure publishes from live
    #   buildable  — install-equivalent modulo live-only links; the exact-ref builder builds it
    #   refused    — needs a real install; each reason is a _REASON line
    # Exit 0 for every verdict; non-zero only when the prediction itself failed.
    predict_ref="$(git -C "$integration_root" rev-parse --verify "$predict_ref^{commit}" 2>/dev/null)" || {
      dependency_generation_log "FATAL: --predict-ref is not a commit: $predict_ref"
      return 74
    }
    exact_input="$(
      dependency_generation_input_fingerprint_ref "$integration_root" "$predict_ref"
    )" || return $?
    live_input="$(dependency_generation_input_fingerprint "$integration_root")" || return 1
    if [ -f "$generation_root/.inputs/$exact_input" ]; then
      predict_verdict='prewarmed'
    elif [ "$live_input" = "$exact_input" ]; then
      predict_verdict='live-match'
    else
      dependency_generation_stage_exact_ref_inputs \
        "$integration_root" "$predict_ref" "$exact_input" "$generation_root" || predict_rc=$?
      dependency_generation_cleanup_exact_scratch
      case "$predict_rc" in
        0) predict_verdict='buildable' ;;
        74) predict_verdict='refused' ;;
        *) return "$predict_rc" ;;
      esac
    fi
    printf 'DEPENDENCY_GENERATION_PREDICTION schema=1 ref=%s input=%s live=%s verdict=%s links=%s\n' \
      "$predict_ref" "$exact_input" "$live_input" "$predict_verdict" \
      "$(printf '%s\n' "$DEPENDENCY_GENERATION_EQUIVALENCE_VERDICT" | grep -c '^DROP_LINK' || true)"
    if [ "$predict_verdict" = 'refused' ]; then
      while IFS= read -r line; do
        [ -n "$line" ] || continue
        printf 'DEPENDENCY_GENERATION_PREDICTION_REASON %s\n' "${line#NOT_EQUIVALENT$'\t'}"
      done < <(printf '%s\n' "$DEPENDENCY_GENERATION_EQUIVALENCE_VERDICT" | grep '^NOT_EQUIVALENT' || true)
    fi
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
    live_input="$(dependency_generation_input_fingerprint "$integration_root")" || return 1
    if [ "$live_input" != "$exact_input" ]; then
      # WI-10004151: publishing from the live tree could only ever miss this key.
      dependency_generation_log \
        "exact ref $ensure_ref inputs $exact_input differ from the live tree's $live_input; building from the ref's own lockfiles"
      dependency_generation_prepare_exact_ref_root \
        "$integration_root" "$ensure_ref" "$exact_input" "$generation_root" || return $?
      build_root="$DEPENDENCY_GENERATION_EXACT_SCRATCH"
      if [ -n "$DEPENDENCY_GENERATION_EXACT_SOURCE_INPUT" ] && [ -z "$DEPENDENCY_GENERATION_EQUIVALENCE_VERDICT" ]; then
        dependency_generation_select_input_fingerprint "$DEPENDENCY_GENERATION_EXACT_SOURCE_INPUT" "$generation_root" || return $?
        DEPENDENCY_GENERATION_CLOSURE_FINGERPRINT="$(dependency_generation_read_field "$DEPENDENCY_GENERATION_PATH/.papercusp-dependency-generation" closure)"
        dependency_generation_acquire_selector_lease \
          "$generation_root" "$DEPENDENCY_GENERATION_ID" "$$" "$DEPENDENCY_GENERATION_TOKEN" || return $?
        dependency_generation_publish_input_selector "$generation_root" "$exact_input" || {
          rc=$?
          dependency_generation_release_selector_lease
          return "$rc"
        }
        dependency_generation_release_selector_lease
        dependency_generation_cleanup_exact_scratch
        printf 'DEPENDENCY_GENERATION_RESULT schema=1 identity=%s source=%s input=%s scope=full reused=true token=%s path=%s\n' \
          "$DEPENDENCY_GENERATION_ID" "$DEPENDENCY_GENERATION_SOURCE_FINGERPRINT" \
          "$DEPENDENCY_GENERATION_INPUT_FINGERPRINT" "$DEPENDENCY_GENERATION_TOKEN" "$DEPENDENCY_GENERATION_PATH"
        return 0
      fi
    fi
  fi
  dependency_generation_configure_workspace_dirs \
    "$build_root" "${workspace_dirs[@]}" || return $?
  if [ "$DEPENDENCY_GENERATION_SCOPE_MODE" = 'full' ]; then
    input_before="$(dependency_generation_input_fingerprint "$build_root")" || return 1
  fi
  dependency_generation_ensure "$build_root" "$generation_root" || return $?
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
    input_after="$(dependency_generation_input_fingerprint "$build_root")" || return 1
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
  dependency_generation_cleanup_exact_scratch
  printf 'DEPENDENCY_GENERATION_RESULT schema=1 identity=%s source=%s input=%s closure=%s scope=%s reused=%s token=%s path=%s\n' \
    "$DEPENDENCY_GENERATION_ID" "$DEPENDENCY_GENERATION_SOURCE_FINGERPRINT" \
    "$DEPENDENCY_GENERATION_INPUT_FINGERPRINT" \
    "$DEPENDENCY_GENERATION_CLOSURE_FINGERPRINT" "$DEPENDENCY_GENERATION_SCOPE_MODE" \
    "$DEPENDENCY_GENERATION_REUSED" "$DEPENDENCY_GENERATION_TOKEN" \
    "$DEPENDENCY_GENERATION_PATH"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -euo pipefail
  # An exact-ref build's scratch root must not outlive a failed or killed run.
  trap 'dependency_generation_cleanup_exact_scratch' EXIT
  dependency_generation_main "$@"
fi

}  # ── end self-read guard (WI-322485) ──
