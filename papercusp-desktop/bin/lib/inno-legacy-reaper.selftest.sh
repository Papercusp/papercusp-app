#!/usr/bin/env bash
# inno-legacy-reaper.selftest.sh — guards the Inno [Code] legacy-uninstall
# reaper in src-tauri/windows/inno/papercusp.iss (WI-4490).
#
# WHY THIS EXISTS
# The reaper deletes stale Add/Remove Programs keys left by the NSIS-era
# installer scheme, whose uninstall.exe no longer exists. It is guarded by
# UninstallTargetExists() so a LIVE install's entry is never deleted. Nothing
# tested any of it: no test file anywhere referenced papercusp.iss, and a real
# false-positive (an unquoted UninstallString containing a space — which every
# Papercusp path has — judged a live uninstaller "missing" and deleted a real
# install's entry) sat undetected for three weeks until it was found by hand
# (EI-19481728463683227). This is the detector that was missing.
#
# WHAT IT ASSERTS — both directions, both quoting styles:
#   ghost key (UninstallString target absent)  -> MUST be reaped
#   live  key (UninstallString target present) -> MUST be spared
# The "live is spared" case is the falsifiability control: without it a reaper
# that blanket-deletes by display name would pass.
#
# HERMETIC-ish: no network, no docker, no ssh. It does need the Windows build
# toolchain (wine + Inno Setup's ISCC) that bin/build-windows-cross.sh already
# requires. Where that is not provisioned this SKIPS with exit 0 rather than
# failing, so it is safe in any gate; on a Windows-build box it runs for real.
#
#   bash bin/lib/inno-legacy-reaper.selftest.sh   # 0 = pass or skip, 1 = FAIL
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ISS="$DIR/../../src-tauri/windows/inno/papercusp.iss"
WINEPREFIX_INNO="${PAPERCUSP_WINEPREFIX_INNO:-$HOME/.papercusp/wine-inno}"
ISCC_EXE="${PAPERCUSP_ISCC_EXE:-$WINEPREFIX_INNO/drive_c/InnoSetup6/ISCC.exe}"

skip() { echo "SKIP inno-legacy-reaper: $1"; exit 0; }
fail() { echo "FAIL inno-legacy-reaper: $1"; exit 1; }

[[ -f "$ISS" ]] || fail "papercusp.iss not found at $ISS"
command -v wine     >/dev/null 2>&1 || skip "wine not installed"
command -v xvfb-run >/dev/null 2>&1 || skip "xvfb-run not installed"
[[ -f "$ISCC_EXE" ]] || skip "ISCC not provisioned at $ISCC_EXE"

# Scratch + a throwaway wine prefix. Both must live somewhere WE own: wine
# refuses to create a prefix under a directory it does not own (a shared /tmp).
WORK="$(mktemp -d "${TMPDIR:-/tmp}/inno-reaper-selftest.XXXXXX")" || fail "mktemp failed"
TESTPREFIX="$(mktemp -d "$HOME/.cache/inno-reaper-prefix.XXXXXX")" || fail "mktemp (prefix) failed"
# A wine prefix is ~200MB+, so leaking one per run is not a cosmetic wart. The
# wineserver for THIS prefix keeps writing during teardown, which is what makes
# a plain rm -rf fail with "Directory not empty" — so kill it first and retry.
# `wineserver -k` is WINEPREFIX-scoped: it cannot touch a peer's wine session
# (and is emphatically not a pkill).
cleanup() {
  WINEPREFIX="$TESTPREFIX" wineserver -k >/dev/null 2>&1 || true
  for _ in 1 2 3; do
    rm -rf "$WORK" "$TESTPREFIX" 2>/dev/null && break
    sleep 1
  done
}
trap cleanup EXIT

export WINEDEBUG=-all
# winemenubuilder: keep this throwaway TESTPREFIX from registering .desktop
# entries into the host's GNOME app grid (see build-windows-cross.sh run_iscc).
export WINEDLLOVERRIDES="mscoree,mshtml,winemenubuilder.exe="

# ── Build a standalone harness from the REAL [Code] section ──────────────────
# Extracted verbatim from papercusp.iss so this can never drift from shipping
# code; the [Setup] header is minimal because only the [Code] logic is under
# test.
CODE_LINE="$(grep -n '^\[Code\]' "$ISS" | head -1 | cut -d: -f1)"
[[ -n "$CODE_LINE" ]] || fail "no [Code] section in papercusp.iss"
{
  # The shipping [Code] reads the AppName/AppId PREPROCESSOR defines (its own
  # #ifndef/#error block at the top of papercusp.iss proves ISCC is never
  # invoked without them), so the harness must define them too — a [Setup]
  # AppName= directive is a different thing entirely and does not satisfy
  # {#AppName}. Without these the harness fails to compile the moment any
  # [Code] routine references a define, which is exactly what happened when the
  # uninstall-cleanup routines landed (WI-39403).
  printf '#define AppName "Papercusp GUI"\n#define AppId "com.papercusp.gui"\n'
  printf '[Setup]\nAppName=Inno Reaper Selftest\nAppVersion=0.0.0\n'
  printf 'DefaultDirName={autopf}\\InnoReaperSelftest\nOutputDir=out\n'
  printf 'OutputBaseFilename=reaper-harness\nUninstallable=no\nCreateAppDir=no\n'
  sed -n "${CODE_LINE},\$p" "$ISS"
} > "$WORK/harness.iss"

WORK_WIN="$(WINEPREFIX="$WINEPREFIX_INNO" winepath -w "$WORK/harness.iss" 2>/dev/null)"
[[ -n "$WORK_WIN" ]] || fail "winepath could not map $WORK/harness.iss"

if ! WINEPREFIX="$WINEPREFIX_INNO" timeout 300 xvfb-run -a wine "$ISCC_EXE" "$WORK_WIN" \
     > "$WORK/iscc.log" 2>&1; then
  echo "--- ISCC output ---"; tail -30 "$WORK/iscc.log"
  fail "the [Code] section did not compile (a syntax/identifier error in papercusp.iss)"
fi
HARNESS_EXE="$WORK/out/reaper-harness.exe"
[[ -f "$HARNESS_EXE" ]] || fail "ISCC reported success but produced no harness exe"

# ── Boot the throwaway prefix ────────────────────────────────────────────────
WINEPREFIX="$TESTPREFIX" timeout 300 xvfb-run -a wineboot -i >"$WORK/wineboot.log" 2>&1
[[ -d "$TESTPREFIX/drive_c" ]] || { tail -5 "$WORK/wineboot.log"; fail "could not boot a test wine prefix"; }

REG_ROOT='HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall'
wreg() { WINEPREFIX="$TESTPREFIX" xvfb-run -a wine reg "$@" >/dev/null 2>&1; }
key_exists() { WINEPREFIX="$TESTPREFIX" xvfb-run -a wine reg query "$1" >/dev/null 2>&1; }

RC=0
# The product's real directory names contain spaces — that is the whole point
# of the unquoted case, so keep them.
for MODE in quoted unquoted; do
  DRIVE_C="$TESTPREFIX/drive_c"
  mkdir -p "$DRIVE_C/Papercusp Server"
  printf 'not-a-real-exe' > "$DRIVE_C/Papercusp Server/unins-live.exe"
  rm -rf "$DRIVE_C/Papercusp GUI"            # ghost's target must NOT exist

  if [[ "$MODE" == "quoted" ]]; then
    LIVE_VAL='"C:\Papercusp Server\unins-live.exe"'
  else
    LIVE_VAL='C:\Papercusp Server\unins-live.exe'
  fi

  wreg add "$REG_ROOT\\Papercusp GUI"    /v UninstallString /d '"C:\Papercusp GUI\uninstall.exe"' /f
  wreg add "$REG_ROOT\\Papercusp Server" /v UninstallString /d "$LIVE_VAL" /f

  key_exists "$REG_ROOT\\Papercusp GUI"    || fail "[$MODE] seeding failed: ghost key absent before the run"
  key_exists "$REG_ROOT\\Papercusp Server" || fail "[$MODE] seeding failed: live key absent before the run"

  WINEPREFIX="$TESTPREFIX" timeout 300 xvfb-run -a wine "$HARNESS_EXE" \
    /VERYSILENT /NORESTART /SUPPRESSMSGBOXES >"$WORK/install-$MODE.log" 2>&1

  if key_exists "$REG_ROOT\\Papercusp GUI"; then
    echo "  [$MODE] GHOST NOT REAPED — a dead entry the user cannot remove survives (WI-4490)"
    RC=1
  else
    echo "  [$MODE] ghost reaped ✓"
  fi

  if key_exists "$REG_ROOT\\Papercusp Server"; then
    echo "  [$MODE] live entry spared ✓"
  else
    echo "  [$MODE] LIVE ENTRY DELETED — the guard destroyed a real install's uninstall entry (EI-19481728463683227)"
    RC=1
  fi
done

if [[ $RC -eq 0 ]]; then
  echo "PASS inno-legacy-reaper: ghosts reaped and live entries spared, quoted and unquoted"
else
  echo "FAIL inno-legacy-reaper: see the assertions above"
fi
exit $RC
