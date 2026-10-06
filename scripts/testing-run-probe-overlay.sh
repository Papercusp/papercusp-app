#!/usr/bin/env bash
# Share the probe's admission lock across the entire router process tree. The
# manifest is read ONLY after acquiring the shared lock; publication and removal
# hold its exclusive counterpart. An unrecognized manifest fails closed.
set -euo pipefail
root="$1"
shift
[ "$1" = "--" ] || { echo "mutation-probe admission: missing --" >&2; exit 2; }
shift
root="$(realpath -e "$root")" || { echo "mutation-probe admission: missing checkout" >&2; exit 2; }
key="$(printf '%s' "$root" | sha256sum | cut -d' ' -f1)"
# Keep the overlay reader on the same admission base as mutation-probe.sh.
# Tests override it to isolate manifests; production defaults to /tmp.
ADMISSION_BASE="${PAPERCUSP_MUTATION_PROBE_ADMISSION_ROOT:-/tmp}"
directory="$ADMISSION_BASE/papercusp-mutation-probe-$(id -u)-$key"
mkdir -p -m 700 "$directory"
lock="$directory/admission.lock"
manifest="$directory/original.manifest"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/mutation-probe-admission.sh"

mode="${1:-}"
case "$mode" in
  --inside-admission)
    shift
    recovery_marker="${1:?missing recovery marker}"
    shift
    if [ ! -e "$manifest" ]; then
      exec "$@"
    fi
    if ! probe_admission_read_manifest "$root" "$manifest"; then
      echo "mutation-probe admission: invalid original snapshot; refusing test" >&2
      exit 2
    fi
    if probe_admission_owner_alive; then
      # Pin the validated bytes: reopening a pathname (including a bind-fd
      # mount) can fail after unlink even while compliant cleanup honors the
      # admission lock. A data mount copies from this still-readable descriptor.
      if ! exec {snapshot_fd}<"${PROBE_ADMISSION_FIELDS[2]}"; then
        echo "mutation-probe admission: original snapshot unavailable; refusing test" >&2
        exit 2
      fi
      # --dev /dev mounts an empty /dev/shm: re-bind the host's (TMPDIR may live there), then
      # overlay the subject LAST so no later mount shadows it.
      exec bwrap --bind / / --proc /proc --dev /dev --bind-try /dev/shm /dev/shm \
        --ro-bind-data "$snapshot_fd" "${PROBE_ADMISSION_FIELDS[1]}" -- "$@"
    fi
    : > "$recovery_marker"
    exit 0
    ;;
  --recover-orphan)
    if [ ! -e "$manifest" ]; then
      exit 0
    fi
    if ! probe_admission_read_manifest "$root" "$manifest"; then
      echo "mutation-probe admission: invalid original snapshot; refusing recovery" >&2
      exit 2
    fi
    if probe_admission_owner_alive; then
      exit 0
    fi
    probe_admission_recover_orphan "$root" "$manifest" || exit 2
    exit 0
    ;;
  *)
    recovery_marker="$directory/recovery-needed.$$.$RANDOM"
    [ ! -e "$recovery_marker" ] || {
      echo "mutation-probe admission: recovery marker collision" >&2
      exit 2
    }
    if flock -s "$lock" "$0" "$root" -- --inside-admission "$recovery_marker" "$@"; then
      command_status=0
    else
      command_status="$?"
    fi
    if [ -e "$recovery_marker" ]; then
      rm -f -- "$recovery_marker"
      flock -x "$lock" "$0" "$root" -- --recover-orphan || exit 2
      exec "$0" "$root" -- "$@"
    fi
    rm -f -- "$recovery_marker"
    exit "$command_status"
    ;;
esac
