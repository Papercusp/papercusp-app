#!/usr/bin/env bash
# assert-release-host-baked.sh — WI-4389 / WI-3875 / WI-4419 class gate.
#
# WHY THIS EXISTS. main.rs resolves the update source as:
#
#     std::env::var("PAPERCUSP_RELEASE_HOST")                       // runtime override
#         .unwrap_or_else(|| option_env!("PAPERCUSP_RELEASE_HOST")  // BAKED AT COMPILE TIME
#         .unwrap_or("").to_string())
#
# A packaged install has no runtime env, so the BAKED value is the only one that
# will ever exist in the field. `option_env!` reads the env of the CARGO PROCESS —
# and for mac that process runs on a BUILD VM, reached over ssh (WI-5651 retired
# the Windows VM leg; bin/build-windows-cross.sh cross-compiles in-process on the
# release host, no ssh hop). Env does not cross ssh. If the var is not explicitly
# exported into the remote build, cargo bakes an EMPTY STRING and the compile
# SUCCEEDS.
#
# The result is the worst shape of bug this repo keeps re-learning: the installer
# works, the bundle is signed, latest.json is valid, the signature verifies — and
# the shipped app polls nothing. The Tauri updater CANNOT distinguish "no update"
# from "the check failed", so it reports UP TO DATE, FOREVER. That is the 0.0.8
# defect: it cost a full rebuild and a manual reinstall for every install, and it
# was found only by grepping the shipped binary AFTER the fact.
#
# So: grep the binary AT CUT TIME. This is that probe, promoted to a gate.
#
# LABELED != PACKED. An env var that is "set in the script" is a LABEL. The only
# evidence that it was PACKED is finding the bytes inside the artifact.
#
# Usage:  assert-release-host-baked.sh <binary> [<binary> ...]
# Exit :  0 = host found in every binary (or no host configured — nothing to assert)
#         1 = a host IS configured but is ABSENT from a binary  <-- the silent killer
#         2 = usage / unreadable input

set -uo pipefail

# LC_ALL=C — match the baked host as RAW BYTES, not decoded UTF-8. This gate
# greps a compiled binary (Mach-O/ELF) whose .rodata contains invalid-UTF-8
# byte sequences; under a UTF-8 locale (the build VMs run en_US.UTF-8) both
# BSD and GNU `grep -aF` can FAIL to find an ASCII substring in such a file —
# a FALSE NEGATIVE that fails this gate on a CORRECTLY-baked binary. This cost
# an ENTIRE 0.0.11 release cycle chasing a phantom "host not baked": the host
# WAS baked (`strings|grep` and `LC_ALL=C grep` both found it; plain `grep`
# did not, exit 1). Forcing the C locale makes every match below byte-exact.
export LC_ALL=C

if [[ $# -lt 1 ]]; then
  echo "usage: assert-release-host-baked.sh <binary> [<binary> ...]" >&2
  exit 2
fi

HOST="${PAPERCUSP_RELEASE_HOST:-}"

if [[ -z "$HOST" ]]; then
  # Not a failure: release-local.sh already warns loudly that a hostless build
  # ships without an update source. There is simply nothing to assert.
  echo "==> assert-release-host-baked: PAPERCUSP_RELEASE_HOST is unset — nothing to assert."
  echo "    (This build ships WITHOUT an update source. Installers work; auto-update does NOT.)"
  exit 0
fi

# Match on the host's authority, not the full URL: the baked string is the value
# of the env var, but a trailing slash / path segment can differ harmlessly, and
# the point is to prove the SECRET-BEARING host actually made it into the bytes.
needle="${HOST#*://}"   # strip scheme
needle="${needle%%/*}"  # authority only (host[:port]) — never log the secret PATH
[[ -n "$needle" ]] || needle="$HOST"

rc=0
for target in "$@"; do
  # Accept a macOS .app BUNDLE and resolve its executable ourselves, rather than
  # making every caller hard-code Contents/MacOS/<productName> — a wrong guess there
  # would exit 2 and spuriously red a 35-minute VM build, which is a worse failure
  # than the one this gate exists to catch.
  bin="$target"
  if [[ -d "$target" ]]; then
    macos_dir="$target/Contents/MacOS"
    # Prefer the executable named after the bundle ("Papercusp GUI.app" ->
    # "Papercusp GUI"), which is what Tauri emits from productName; fall back to
    # the first regular file in MacOS/ (that directory holds only executables).
    # NOTE: this runs on the mac VM, i.e. BSD find — so NO `-perm -u+x` (the
    # symbolic form is not portable, and a find that errors here would exit 2 and
    # spuriously red a 35-minute build, which is worse than the bug being gated).
    candidate="$macos_dir/$(basename "$target" .app)"
    if [[ -f "$candidate" ]]; then
      bin="$candidate"
    else
      bin="$(find "$macos_dir" -maxdepth 1 -type f 2>/dev/null | head -1)"
    fi
    if [[ -z "$bin" || ! -f "$bin" ]]; then
      echo "ASSERT ERROR: no executable found in $macos_dir" >&2
      exit 2
    fi
  fi
  if [[ ! -r "$bin" ]]; then
    echo "ASSERT ERROR: not readable: $bin" >&2
    exit 2
  fi
  # -a: treat the binary as text so grep does not bail with "binary file matches"
  if grep -aqF -- "$needle" "$bin"; then
    echo "    ✓ release host is BAKED into $(basename "$bin")"
  else
    echo "" >&2
    echo "✗ RELEASE HOST NOT BAKED: $bin" >&2
    echo "    expected to find the configured host ('$needle') in the binary's bytes; it is ABSENT." >&2
    echo "" >&2
    echo "    This build would ship an app that can NEVER reach the update manifest." >&2
    echo "    It would NOT look broken: the installer works, the bundle verifies, and the" >&2
    echo "    Tauri updater renders the failed check as 'up to date' — permanently." >&2
    echo "" >&2
    echo "    CAUSE (almost always): PAPERCUSP_RELEASE_HOST was not in the env reaching the" >&2
    echo "    cargo build. option_env! then baked an empty string and the compile SUCCEEDED." >&2
    echo "      · mac     → the export block in release-local.sh's detached ssh command" >&2
    echo "        (the mac leg still builds on a VM over ssh — env does not cross ssh)" >&2
    echo "      · windows → build-windows-cross.sh cross-compiles in-process (no ssh since" >&2
    echo "        WI-5651), so check the shell/CI env this script itself ran under —" >&2
    echo "        it also self-checks this same bake at its own build-windows-cross.sh:274" >&2
    echo "" >&2
    rc=1
  fi
done

exit "$rc"
