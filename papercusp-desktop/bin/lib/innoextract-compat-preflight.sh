#!/usr/bin/env bash
# Select an extractor that can read the Inno Setup format this build emits before
# cargo spends time compiling it. A version string is not enough: compile a tiny
# fixture with the exact ISCC binary used by the release, then require the exact
# extractor selected for the audit to list AND extract its payload intact, then
# reject corrupted payloads, invalid headers, and truncated slices. Also exercise
# both legacy 32-bit header branches using copies of the following slices.
# The fixture spans disks:
# a single-file fixture never exercises the next-slice header reader.
# An explicit override is
# authoritative. Without one, Papercusp-managed pinned toolchains are tried before
# PATH so an older distro/user binary cannot shadow a compatible maintained build.

_innoextract_absolute_executable() {
  local requested="${1:-}"
  local resolved=""

  [[ -n "$requested" ]] || return 1
  if [[ "$requested" == */* ]]; then
    [[ -x "$requested" ]] || return 1
    resolved="$(cd "$(dirname "$requested")" 2>/dev/null && pwd -P)/$(basename "$requested")"
  else
    resolved="$(command -v "$requested" 2>/dev/null || true)"
    [[ -x "$resolved" ]] || return 1
    if [[ "$resolved" != /* ]]; then
      resolved="$(cd "$(dirname "$resolved")" 2>/dev/null && pwd -P)/$(basename "$resolved")"
    fi
  fi
  printf '%s\n' "$resolved"
}

_innoextract_candidate_paths() {
  local configured="${1:-}"
  local candidate resolved path_candidate
  local -a managed_candidates=()

  if [[ -n "$configured" ]]; then
    # assert-integrity-ok: $resolved is functional stdout after the configured path is validated; the failure branch already reports $configured.
    resolved="$(_innoextract_absolute_executable "$configured")" || {
      echo "ERROR: configured Inno extractor is missing or not executable: $configured" >&2
      return 1
    }
    printf '%s\n' "$resolved"
    return 0
  fi

  shopt -s nullglob
  managed_candidates=("$HOME"/.papercusp/toolchains/innoextract-*/bin/innoextract)
  shopt -u nullglob
  for candidate in "${managed_candidates[@]}"; do
    resolved="$(_innoextract_absolute_executable "$candidate")" || continue
    printf '%s\n' "$resolved"
  done

  path_candidate="$(command -v innoextract 2>/dev/null || true)"
  if [[ -n "$path_candidate" ]]; then
    resolved="$(_innoextract_absolute_executable "$path_candidate")" || true
    [[ -n "$resolved" ]] && printf '%s\n' "$resolved"
  fi
}

innoextract_compat_preflight() (
  set -euo pipefail

  local configured="${1:-${PAPERCUSP_INNOEXTRACT:-}}"
  local wine_prefix="${2:-${PAPERCUSP_WINE_INNO_PREFIX:-$HOME/.papercusp/wine-inno}}"
  local iscc_exe="${3:-${PAPERCUSP_ISCC_EXE:-$wine_prefix/drive_c/InnoSetup6/ISCC.exe}}"
  local candidate_output extractor work probe_iss probe_win probe_exe list_log
  local audit_script
  local -a candidates=()
  local -A seen=()

  candidate_output="$(_innoextract_candidate_paths "$configured")" || return 1
  [[ -n "$candidate_output" ]] || {
    echo "ERROR: no Inno extractor candidate found in ~/.papercusp/toolchains or PATH" >&2
    return 1
  }
  mapfile -t candidates <<< "$candidate_output"
  for command_name in wine winepath xvfb-run timeout python3; do
    command -v "$command_name" >/dev/null 2>&1 || {
      echo "ERROR: $command_name is required for the Inno extractor compatibility preflight" >&2
      return 1
    }
  done
  [[ -f "$iscc_exe" ]] || {
    echo "ERROR: ISCC is missing for the Inno extractor compatibility preflight: $iscc_exe" >&2
    return 1
  }
  audit_script="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)/audit-release-bundle.py"
  [[ -f "$audit_script" ]] || {
    echo "ERROR: finished-installer auditor is missing: $audit_script" >&2
    return 1
  }

  work="$(mktemp -d "${TMPDIR:-/tmp}/papercusp-innoextract-preflight.XXXXXX")"
  trap 'rm -rf "$work"' EXIT
  probe_iss="$work/innoextract-compat-probe.iss"
  # The payload name is asserted below, so an extractor that exits 0 without
  # actually listing the fixture cannot satisfy this preflight.
  printf '%s\n' \
    '[Setup]' \
    'AppName=Papercusp Inno Compatibility Probe' \
    'AppVersion=6.7.3' \
    'DefaultDirName={localappdata}\\PapercuspInnoCompatibilityProbe' \
    'DisableProgramGroupPage=yes' \
    'PrivilegesRequired=lowest' \
    'Uninstallable=no' \
    'CreateAppDir=no' \
    'Compression=none' \
    'DiskSpanning=yes' \
    'DiskSliceSize=8388608' \
    'OutputDir=out' \
    'OutputBaseFilename=innoextract-compat-probe' \
    '' \
    '[Files]' \
    'Source: "probe-payload.txt"; DestDir: "{app}"' \
    > "$probe_iss"
  python3 - "$work/probe-payload.txt" <<'PY'
import pathlib
import sys

size = 12 * 1024 * 1024
prefix = b"Papercusp Inno spanned integrity control v2\n"
payload = (prefix + bytes(range(256)) * (size // 256 + 1))[:size]
pathlib.Path(sys.argv[1]).write_bytes(payload)
PY

  probe_win="$(WINEPREFIX="$wine_prefix" winepath -w "$probe_iss" 2>"$work/winepath.log")" || {
    echo "ERROR: winepath could not map the Inno compatibility fixture" >&2
    cat "$work/winepath.log" >&2 || true
    return 1
  }
  if ! WINEPREFIX="$wine_prefix" WINEDEBUG=-all \
      WINEDLLOVERRIDES="mscoree=d;mshtml=d;winemenubuilder.exe=d" \
      timeout 120 xvfb-run -a wine "$iscc_exe" "$probe_win" \
      >"$work/iscc.log" 2>&1; then
    echo "ERROR: ISCC could not compile the Inno 6.7 compatibility fixture" >&2
    tail -40 "$work/iscc.log" >&2 || true
    return 1
  fi
  probe_exe="$work/out/innoextract-compat-probe.exe"
  [[ -s "$probe_exe" ]] || {
    echo "ERROR: ISCC reported success but produced no compatibility fixture: $probe_exe" >&2
    return 1
  }

  for extractor in "${candidates[@]}"; do
    [[ -n "$extractor" && -z "${seen[$extractor]:-}" ]] || continue
    seen["$extractor"]=1
    list_log="$work/innoextract-list-${#seen[@]}.log"
    if ! "$extractor" -l "$probe_exe" >"$list_log" 2>&1; then
      echo "WARN: rejecting Inno extractor that cannot list the Inno 6.7 fixture: $extractor" >&2
      tail -40 "$list_log" >&2 || true
      continue
    fi
    if ! grep -qi 'probe-payload\.txt' "$list_log"; then
      echo "WARN: rejecting Inno extractor that listed no probe payload: $extractor" >&2
      tail -40 "$list_log" >&2 || true
      continue
    fi
    # Exercise the exact final-audit consumer, not a parallel success predicate.
    # Every candidate gets an empty output directory; a failed predecessor may
    # have left plausible-looking bytes that must never satisfy its successor.
    if ! PAPERCUSP_INNOEXTRACT="$extractor" python3 - \
        "$audit_script" "$probe_exe" "$work" "${#seen[@]}" \
        >"$work/extract-${#seen[@]}.log" 2>&1 <<'PY'
import importlib.util
import pathlib
import shutil
import struct
import subprocess
import sys

spec = importlib.util.spec_from_file_location("audit", sys.argv[1])
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)
fixture = pathlib.Path(sys.argv[2])
work = pathlib.Path(sys.argv[3])
dest = work / ("extract-" + sys.argv[4])
ok, method = audit._expand_installer(str(fixture), str(dest))
if not ok:
    raise SystemExit("fixture extraction refused: " + method)
expected = (work / "probe-payload.txt").read_bytes()
actual = dest / "app/probe-payload.txt"
if not actual.is_file() or actual.read_bytes() != expected:
    raise SystemExit("fixture extraction did not preserve the exact payload bytes")

# Prove a next-slice transition actually occurred. A success from a single-file
# fixture cannot attest this reader, even if it tests checksum failure correctly.
slices = sorted(fixture.parent.glob(fixture.stem + "-*.bin"))
if len(slices) < 2:
    raise SystemExit("ISCC fixture did not produce multiple payload slices")

# Only following-slice headers are converted, so the first chunk's metadata
# offset remains untouched. These are explicit reader-branch controls, NOT a
# claim that an old ISCC producer was run. Payload bytes/checksums stay identical.
pieces = [fixture, *slices]
for magic in (b"idska16\x1a", b"idska32\x1a"):
    legacy_dir = work / ("legacy-" + magic[:7].decode() + "-" + sys.argv[4])
    legacy_dir.mkdir()
    for piece in pieces:
        shutil.copyfile(piece, legacy_dir / piece.name)
    for piece in slices[1:]:
        packed = piece.read_bytes()
        header_size = {b"idskb32\x1a": 16, b"idska32\x1a": 12,
                       b"idska16\x1a": 12}.get(packed[:8])
        if header_size is None:
            raise SystemExit("unknown producer slice format in legacy control")
        payload = packed[header_size:]
        (legacy_dir / piece.name).write_bytes(
            magic + struct.pack("<I", len(payload) + 12) + payload
        )
    legacy_dest = work / ("extract-" + legacy_dir.name)
    ok, method = audit._expand_installer(str(legacy_dir / fixture.name), str(legacy_dest))
    actual = legacy_dest / "app/probe-payload.txt"
    if not ok or not actual.is_file() or actual.read_bytes() != expected:
        raise SystemExit("extractor failed the legacy-slice-header control")

# Keep the declared size and remove either part of the header or payload.
# A truncated NEXT slice must fail, not silently contribute partial bytes.
for suffix, length in (("header", 10), ("payload", slices[1].stat().st_size - 1)):
    truncated_dir = work / ("truncated-" + suffix + "-" + sys.argv[4])
    truncated_dir.mkdir()
    for piece in pieces:
        shutil.copyfile(piece, truncated_dir / piece.name)
    with (truncated_dir / slices[1].name).open("r+b") as stream:
        stream.truncate(length)
    result = subprocess.run(
        [audit._innoextract_command(), "-t", "-s", str(truncated_dir / fixture.name)],
        capture_output=True, text=True, check=False, timeout=15,
    )
    if result.returncode == 0 or "slice size" not in (result.stdout + result.stderr).lower():
        raise SystemExit("extractor failed the truncated-slice control")

# Compression=none exposes the unique prefix even though the complete payload
# crosses slices. Corrupt a COPY of the whole set; never change another
# candidate's control inputs or an actual release artifact.
marker = expected[:64]
matches = []
for piece in pieces:
    packed = piece.read_bytes()
    for _ in range(packed.count(marker)):
        matches.append((piece, packed.index(marker)))
if len(matches) != 1:
    raise SystemExit("cannot establish the corruption control's unique payload")
corrupt_dir = work / ("corrupt-" + sys.argv[4])
corrupt_dir.mkdir()
for piece in pieces:
    shutil.copyfile(piece, corrupt_dir / piece.name)
piece, at = matches[0]
corrupt_piece = corrupt_dir / piece.name
packed = corrupt_piece.read_bytes()
corrupt_piece.write_bytes(packed[:at] + bytes([packed[at] ^ 1]) + packed[at + 1:])
corrupt = corrupt_dir / fixture.name
result = subprocess.run(
    [audit._innoextract_command(), "-t", "-s", str(corrupt)],
    capture_output=True, text=True, check=False, timeout=15,
)
if result.returncode == 0 or not audit._innoextract_integrity_warning(result):
    raise SystemExit("extractor failed the corrupted-payload integrity control")

# A bounded lookup must reject unknown magic, not compare past the magic table.
shutil.copyfile(piece, corrupt_piece)
first_slice = corrupt_dir / slices[0].name
packed = first_slice.read_bytes()
first_slice.write_bytes(b"notinno!" + packed[8:])
result = subprocess.run(
    [audit._innoextract_command(), "-t", "-s", str(corrupt)],
    capture_output=True, text=True, check=False, timeout=15,
)
if result.returncode == 0 or "bad slice magic" not in (result.stdout + result.stderr).lower():
    raise SystemExit("extractor failed the invalid-slice-header control")
PY
    then
      echo "WARN: rejecting Inno extractor that failed extraction/integrity controls: $extractor" >&2
      tail -40 "$work/extract-${#seen[@]}.log" >&2 || true
      continue
    fi
    echo "  Inno extractor compatibility preflight passed (Inno 6.7 spanned fixture; extraction + legacy headers + truncation + corruption + bad-header controls): $extractor" >&2
    printf '%s\n' "$extractor"
    return 0
  done

  echo "ERROR: no candidate Inno extractor can list, extract and verify the Inno 6.7 fixture" >&2
  echo "       ISCC: $iscc_exe" >&2
  return 1
)

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  innoextract_compat_preflight "$@"
fi
