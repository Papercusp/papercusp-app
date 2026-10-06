#!/usr/bin/env bash
# Shared validation and recovery for the in-tree mutation-probe admission
# manifest. Call probe_admission_recover_orphan only while holding the
# admission lock exclusively.

PROBE_ADMISSION_FIELDS=()

probe_admission_read_manifest() {
  local root="$1" manifest="$2"
  PROBE_ADMISSION_FIELDS=()
  [ -f "$manifest" ] && [ ! -L "$manifest" ] || return 1
  mapfile -d '' -t PROBE_ADMISSION_FIELDS < "$manifest" || return 1
  [ "${#PROBE_ADMISSION_FIELDS[@]}" -eq 4 ] || return 1

  local recorded_root="${PROBE_ADMISSION_FIELDS[0]}"
  local subject="${PROBE_ADMISSION_FIELDS[1]}"
  local snapshot="${PROBE_ADMISSION_FIELDS[2]}"
  local owner_pid="${PROBE_ADMISSION_FIELDS[3]}"
  local scratch_dir
  scratch_dir="$(dirname -- "$snapshot")"

  [ "$recorded_root" = "$root" ] || return 1
  case "$subject" in "$root"/*) ;; *) return 1 ;; esac
  [ -f "$subject" ] && [ ! -L "$subject" ] || return 1
  [ -f "$snapshot" ] && [ ! -L "$snapshot" ] || return 1
  [[ "$owner_pid" =~ ^[1-9][0-9]*$ ]] || return 1
  [ "$snapshot" = "$scratch_dir/$(basename -- "$subject").orig" ] || return 1
  [[ "$(basename -- "$scratch_dir")" == mutation-probe.* ]] || return 1
  [ -d "$scratch_dir" ] && [ ! -L "$scratch_dir" ] || return 1
  [ "$(stat -c '%u' -- "$scratch_dir" 2>/dev/null)" = "$(id -u)" ] || return 1
}

probe_admission_owner_alive() {
  kill -0 "${PROBE_ADMISSION_FIELDS[3]}" 2>/dev/null
}

probe_admission_cleanup_scratch() {
  local scratch_dir="$1"
  local temp_root scratch_real
  temp_root="$(realpath -e "${TMPDIR:-/tmp}" 2>/dev/null)" || return 1
  scratch_real="$(realpath -e "$scratch_dir" 2>/dev/null)" || return 1
  [[ "$scratch_real" == "$temp_root"/mutation-probe.* ]] || return 1
  [ "$(stat -c '%u' -- "$scratch_real" 2>/dev/null)" = "$(id -u)" ] || return 1
  find "$scratch_real" -mindepth 1 -depth -delete || return 1
  rmdir -- "$scratch_real"
}

# Record that <subject> was verified byte-identical to <original> after an
# in-tree probe (or orphan recovery) restored it (EI-24720263797874266). A
# 'mutation probe' file lock outlives the dirty window: its holder takes it
# before the probe starts and the probe heartbeats it to 1200s, while the
# mutant exists only between manifest publication and verified restore. The
# testing:run fence (mutation-probe-fence.ts) treats a locked subject whose
# CURRENT bytes still hash to this record as unmutated, so the lingering lock
# stops fencing unrelated tests. Any later change to the subject (a real edit
# or a hand mutation) breaks the hash and falls back to the closure fence.
# Write-then-rename so a reader never sees a partial record. Best effort: a
# missing record only keeps the fence conservative.
probe_admission_record_restored() {
  local root="$1" admission_dir="$2" subject="$3" original="$4"
  local records="$admission_dir/restored" key sum tmp
  mkdir -p -m 700 -- "$records" || return 1
  key="$(printf '%s' "$subject" | sha256sum | cut -d' ' -f1)" || return 1
  sum="$(sha256sum < "$original" | cut -d' ' -f1)" || return 1
  [[ "$sum" =~ ^[0-9a-f]{64}$ ]] || return 1
  tmp="$records/.$key.$$"
  printf '%s\0%s\0%s\0' "$root" "$subject" "$sum" >"$tmp" || return 1
  mv -f -- "$tmp" "$records/$key"
}

probe_admission_recover_orphan() {
  local root="$1" manifest="$2"
  if ! probe_admission_read_manifest "$root" "$manifest"; then
    printf 'mutation-probe admission: invalid original snapshot; refusing recovery\n' >&2
    return 1
  fi
  if probe_admission_owner_alive; then
    return 1
  fi

  local subject="${PROBE_ADMISSION_FIELDS[1]}"
  local snapshot="${PROBE_ADMISSION_FIELDS[2]}"
  local scratch_dir
  scratch_dir="$(dirname -- "$snapshot")"
  if cmp -s -- "$snapshot" "$subject"; then
    printf 'mutation-probe admission: cleared orphaned snapshot; subject already matches its original bytes\n' >&2
  else
    printf 'mutation-probe admission: restoring subject from orphaned original snapshot: %s\n' "$subject" >&2
    cp -- "$snapshot" "$subject" || {
      printf 'mutation-probe admission: snapshot restore failed; preserving recovery data\n' >&2
      return 1
    }
    cmp -s -- "$snapshot" "$subject" || {
      printf 'mutation-probe admission: restored subject does not match snapshot; preserving recovery data\n' >&2
      return 1
    }
  fi

  probe_admission_record_restored "$root" "$(dirname -- "$manifest")" "$subject" "$snapshot" ||
    printf 'mutation-probe admission: could not record the verified restore; the testing:run fence stays conservative\n' >&2
  rm -f -- "$manifest" || {
    printf 'mutation-probe admission: could not clear recovered manifest; refusing test\n' >&2
    return 1
  }
  if ! probe_admission_cleanup_scratch "$scratch_dir"; then
    printf 'mutation-probe admission: recovered subject; preserving scratch directory for inspection: %s\n' "$scratch_dir" >&2
  fi
}
