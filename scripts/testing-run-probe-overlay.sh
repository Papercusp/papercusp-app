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
directory="/tmp/papercusp-mutation-probe-$(id -u)-$key"
mkdir -p -m 700 "$directory"
lock="$directory/admission.lock"
if [ "${1:-}" != "--inside-admission" ]; then
  exec flock -s "$lock" "$0" "$root" -- --inside-admission "$@"
fi
shift
manifest="$directory/original.manifest"
if [ ! -e "$manifest" ]; then
  exec "$@"
fi
fields=()
mapfile -d '' -t fields < "$manifest"
if [ "${#fields[@]}" -ne 4 ] || [ "${fields[0]}" != "$root" ] ||
   [ ! -f "${fields[2]}" ] || [ ! -f "${fields[1]}" ] ||
   ! kill -0 "${fields[3]}" 2>/dev/null; then
  echo "mutation-probe admission: invalid or orphaned original snapshot; refusing test" >&2
  exit 2
fi
case "${fields[1]}" in "$root"/*) ;; *) echo "mutation-probe admission: subject outside checkout" >&2; exit 2 ;; esac
exec bwrap --bind / / --ro-bind "${fields[2]}" "${fields[1]}" --proc /proc --dev /dev -- "$@"
