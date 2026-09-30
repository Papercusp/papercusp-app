#!/usr/bin/env bash
# inno-uninstall-cleanup.selftest.sh — guards the Inno [Code] UNINSTALL cleanup
# in src-tauri/windows/inno/papercusp.iss (WI-39403).
#
# WHY THIS EXISTS
# A real 0.0.17 uninstall on a Windows 11 guest exited 0 and removed {app}
# entirely — and still left the login-autostart entry behind. The app registers
# auto-start at RUNTIME (tauri-plugin-autostart -> auto-launch writes an HKCU
# Run VALUE), so Inno has no record of it and cannot clean it up implicitly.
# Result: after a clean, successful uninstall every subsequent login tries to
# launch a deleted executable. Nothing tested the uninstall path at all.
#
# WHAT IT ASSERTS — and note that half the cases are the DANGEROUS direction:
#   1. the Run value for THIS role is deleted by the uninstall
#   2. the Run value for the OTHER role is SPARED               <- control
#   3. the StartupApproved\Run marker for THIS role is deleted
#   4. a Startup-folder shortcut named after the product is swept
#   5. SharedRuntimeStillNeeded = TRUE while the other product is installed
#   6. SharedRuntimeStillNeeded = FALSE once it is not
#   7. an empty role directory is removable, but a non-empty one is preserved
#   8. the real uninstall leaves neither the role root nor user config harmed
#
# Cases 2 and 5 are the falsifiability controls that matter most. Without (2) a
# cleanup that blanket-deleted by the shared binary name would pass while
# silently disabling the OTHER product's auto-start. Without (5) a cleanup that
# always offered to unregister the SHARED papercup-runtime distro would pass
# while proposing to delete multiple GB of the user's database out from under a
# still-installed sibling product.
#
# The WSL unregister prompt itself is deliberately NOT exercised end-to-end: it
# is gated on `not UninstallSilent`, and a silent uninstall is the only kind a
# headless test can drive — which is itself the property we want (a /VERYSILENT
# uninstall, the mode the auto-updater drives, must never destroy user data).
# Cases 5/6 test its GUARD, which is the part that can be wrong.
#
# HERMETIC-ish: no network, no docker, no ssh. It does need the Windows build
# toolchain (wine + Inno Setup's ISCC) that bin/build-windows-cross.sh already
# requires. Where that is not provisioned this SKIPS with exit 0 rather than
# failing, so it is safe in any gate; on a Windows-build box it runs for real.
#
#   bash bin/lib/inno-uninstall-cleanup.selftest.sh   # 0 = pass or skip, 1 = FAIL
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Overridable so scripts/mutation-probe.sh can point this at a MUTATED COPY
# outside the tree (its tier-2 copy-out mode) and prove the assertions below can
# actually fail. Mutating the real file in place is unsafe here: git-sync commits
# the whole working tree on a timer, so a probe that holds a mutation for the
# ~70s this suite runs can have that mutation swept into a commit.
ISS="${PAPERCUSP_ISS:-$DIR/../../src-tauri/windows/inno/papercusp.iss}"
WINEPREFIX_INNO="${PAPERCUSP_WINEPREFIX_INNO:-$HOME/.papercusp/wine-inno}"
ISCC_EXE="${PAPERCUSP_ISCC_EXE:-$WINEPREFIX_INNO/drive_c/InnoSetup6/ISCC.exe}"

# The role under test, and the sibling that must survive it untouched.
ROLE_NAME='Papercusp GUI'
ROLE_ID='com.papercusp.gui'
OTHER_NAME='Papercusp Server'
OTHER_ID='com.papercusp.server'

skip() { echo "SKIP inno-uninstall-cleanup: $1"; exit 0; }
KEEP_WORK=0
RC=0
fail() {
  echo "FAIL inno-uninstall-cleanup: $1" >&2
  if [[ -n "${WORK:-}" && -d "${WORK:-}" ]]; then
    KEEP_WORK=1
    echo "DIAGNOSTICS PRESERVED AT: $WORK" >&2
  fi
  exit 1
}
ok()  { echo "  ✓ $1"; }
bad() { echo "  ✗ $1"; RC=1; }

# Return 0 and print the value, 1 only for a confirmed missing value, and 2
# when the registry query itself failed or its successful output was unreadable.
# Callers must preserve that distinction; an empty command substitution is not
# evidence that a product guard returned false.
rvalue() {
  local key=$1 name=$2 output status parsed
  if output=$(WINEPREFIX="$TESTPREFIX" xvfb-run -a wine reg query "$key" /v "$name" 2>&1); then
    status=0
  else
    status=$?
  fi

  if [[ $status -ne 0 ]]; then
    case "${output,,}" in
      *"unable to find the specified registry key or value"*|\
      *"unable to find the specified registry value"*) return 1 ;;
    esac
  fi

  if [[ $status -eq 0 ]]; then
    parsed=$(printf '%s\n' "$output" | tr -d '\r' | awk -v name="$name" '
      {
        line = $0
        sub(/^[ \t]+/, "", line)
        if (index(line, name) == 1) {
          rest = substr(line, length(name) + 1)
          if (match(rest, /REG_[A-Z_]+[ \t]+/)) {
            print "__INNO_REG_VALUE_PRESENT__" substr(rest, RSTART + RLENGTH)
            exit
          }
        }
      }')
    if [[ $parsed == __INNO_REG_VALUE_PRESENT__* ]]; then
      printf '%s' "${parsed#__INNO_REG_VALUE_PRESENT__}"
      return 0
    fi
  fi

  if [[ $status -ne 0 ]]; then
    printf 'registry query failed for %s / %s (exit %s): %s\n' "$key" "$name" "$status" "$output" >&2
  else
    printf 'registry query succeeded but %s / %s could not be parsed: %s\n' "$key" "$name" "$output" >&2
  fi
  return 2
}

assert_rvalue_equals() {
  local key=$1 name=$2 expected=$3 pass_message=$4 fail_message=$5 actual status
  if actual=$(rvalue "$key" "$name"); then
    if [[ -z $actual ]]; then
      fail "registry probe returned an empty value for $key / $name; case measured no valid state"
    elif [[ $actual == "$expected" ]]; then
      ok "$pass_message"
    else
      bad "$fail_message (got '$actual')"
    fi
  else
    status=$?
    if [[ $status -eq 1 ]]; then
      fail "expected registry probe value $key / $name was absent; case measured nothing"
    else
      fail "registry query failed for $key / $name; case measured nothing (read status $status)"
    fi
  fi
}

assert_rvalue_absent() {
  local key=$1 name=$2 pass_message=$3 fail_message=$4 actual status
  if actual=$(rvalue "$key" "$name"); then
    bad "$fail_message (got '$actual')"
  else
    status=$?
    if [[ $status -eq 1 ]]; then
      ok "$pass_message"
    else
      fail "registry query failed for $key / $name; case measured nothing (read status $status)"
    fi
  fi
}

assert_rvalue_present() {
  local key=$1 name=$2 pass_message=$3 fail_message=$4 actual status
  if actual=$(rvalue "$key" "$name"); then
    if [[ -n $actual ]]; then
      ok "$pass_message"
    else
      bad "$fail_message (registry value was empty)"
      return 1
    fi
  else
    status=$?
    if [[ $status -eq 1 ]]; then
      bad "$fail_message (registry value absent)"
      return 1
    fi
    fail "registry query failed for $key / $name (status $status); case measured nothing"
  fi
}

require_rvalue_present() {
  local key=$1 name=$2 failure_message=$3 actual status
  if actual=$(rvalue "$key" "$name"); then
    [[ -n $actual ]] || fail "$failure_message (value was empty; fixture did not establish its precondition)"
  else
    status=$?
    if [[ $status -eq 1 ]]; then
      fail "$failure_message (confirmed absent; fixture did not establish its precondition)"
    fi
    fail "$failure_message (registry query failed with status $status; case measured nothing)"
  fi
}

run_install() {
  WINEPREFIX="$TESTPREFIX" timeout 300 xvfb-run -a wine "$HARNESS_EXE" \
    /VERYSILENT /NORESTART /SUPPRESSMSGBOXES >"$WORK/install-$1.log" 2>&1
}

checked_command() {
  local label=$1 log=$2 status
  shift 2
  if "$@"; then
    return 0
  else
    status=$?
    fail "$label failed (exit $status); case measured nothing (diagnostics: $log)"
  fi
}

# Exercise the same reporting helpers with mocked instruments before checking
# for the optional Windows toolchain. This keeps failure-vs-product verdicts in
# the project's existing shell self-test, including on hosts that skip Wine.
failure_reporting_contract_selftest() {
  local root mockbin actual status output
  root=$(mktemp -d "${TMPDIR:-/tmp}/inno-instrument-selftest.XXXXXX") || fail "could not create instrument-test directory"
  mockbin="$root/bin"
  mkdir -p "$mockbin" "$root/work" "$root/prefix" || fail "could not prepare instrument-test directories"
  local PATH="$mockbin:$PATH"
  local TESTPREFIX="$root/prefix"
  local WORK="$root/work"
  local HARNESS_EXE="$root/fake-harness.exe"

  cat >"$mockbin/xvfb-run" <<'MOCK_XVFB'
#!/usr/bin/env bash
[[ "${1:-}" == "-a" ]] && shift
exec "$@"
MOCK_XVFB
  cat >"$mockbin/wine" <<'MOCK_WINE'
#!/usr/bin/env bash
if [[ "${1:-}" == "reg" && "${2:-}" == "query" ]]; then
  case "${MOCK_REG_MODE:-readable}" in
    readable)
      printf 'HKEY_CURRENT_USER\\Software\\PapercuspSelftest\r\n    SharedRuntimeStillNeeded    REG_SZ    yes\r\n'
      exit 0
      ;;
    absent)
      printf 'reg: Unable to find the specified registry value\n' >&2
      exit 1
      ;;
    unreadable)
      printf 'ERROR: Access is denied.\n' >&2
      exit 13
      ;;
  esac
fi
if [[ "${MOCK_INSTALL_MODE:-success}" == "failure" ]]; then
  printf 'simulated installer failure\n' >&2
  exit 37
fi
exit 0
MOCK_WINE
  chmod +x "$mockbin/xvfb-run" "$mockbin/wine"

  local MOCK_REG_MODE=readable MOCK_INSTALL_MODE=success
  export MOCK_REG_MODE MOCK_INSTALL_MODE
  if actual=$(rvalue 'HKCU\\Software\\PapercuspSelftest' SharedRuntimeStillNeeded); then
    [[ $actual == yes ]] || fail "readable registry fixture returned '$actual', expected yes"
  else
    status=$?
    fail "readable registry fixture failed with status $status"
  fi
  ok "registry query returns a readable value"

  MOCK_REG_MODE=absent
  if rvalue 'HKCU\\Software\\PapercuspSelftest' SharedRuntimeStillNeeded >/dev/null 2>"$root/absent.log"; then
    fail "missing registry fixture was reported as present"
  else
    status=$?
  fi
  [[ $status -eq 1 ]] || fail "missing registry fixture returned status $status, expected 1"
  if output=$(assert_rvalue_equals 'HKCU\\Software\\PapercuspSelftest' SharedRuntimeStillNeeded yes "shared runtime remains protected" "SHARED DISTRO WOULD BE OFFERED FOR DELETION" 2>&1); then
    fail "missing probe fixture was allowed to report product behavior"
  else
    status=$?
  fi
  [[ $status -eq 1 && $output == *"case measured nothing"* && $output != *"SHARED DISTRO WOULD BE OFFERED FOR DELETION"* ]] || fail "missing probe fixture was not reported as unmeasured"
  ok "missing probe values are not reported as product failures"
  RC=0
  if assert_rvalue_present 'HKCU\\Software\\PapercuspSelftest' SharedRuntimeStillNeeded \
      "shared runtime remains protected" "SHARED DISTRO WOULD BE OFFERED FOR DELETION" >"$root/present-violation.log" 2>&1; then
    fail "confirmed missing product state was not recorded as a product failure"
  fi
  [[ $RC -eq 1 ]] || fail "confirmed missing product state did not fail the assertion"
  grep -q 'SHARED DISTRO WOULD BE OFFERED FOR DELETION' "$root/present-violation.log" || fail "product failure message was lost for a measured absent guard"
  RC=0
  ok "measured absent product state remains a product failure"
  ok "confirmed missing registry values remain distinct"

  MOCK_REG_MODE=unreadable
  if actual=$(rvalue 'HKCU\\Software\\PapercuspSelftest' SharedRuntimeStillNeeded 2>"$root/unreadable.log"); then
    fail "unreadable registry fixture was reported as a value"
  else
    status=$?
  fi
  [[ $status -eq 2 ]] || fail "unreadable registry fixture returned status $status, expected 2"
  grep -q 'registry query failed' "$root/unreadable.log" || fail "unreadable registry fixture did not retain an instrument diagnostic"
  ok "registry read failures are not product-state values"

  MOCK_INSTALL_MODE=failure
  if output=$(checked_command "fault-injected install" "$WORK/install-fault.log" run_install fault 2>&1); then
    fail "failed install fixture was allowed to reach product assertions"
  else
    status=$?
  fi
  [[ $status -eq 1 && $output == *"case measured nothing"* ]] || fail "failed install fixture lacked an unmeasured-case diagnostic"
  [[ -s "$WORK/install-fault.log" ]] || fail "failed install fixture did not retain its log"
  ok "install failures stop guard assertions and retain their log"

  rm -rf "$root"
}

failure_reporting_contract_selftest

[[ -f "$ISS" ]] || fail "papercusp.iss not found at $ISS"
command -v wine     >/dev/null 2>&1 || skip "wine not installed"
command -v xvfb-run >/dev/null 2>&1 || skip "xvfb-run not installed"
[[ -f "$ISCC_EXE" ]] || skip "ISCC not provisioned at $ISCC_EXE"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/inno-uninst-selftest.XXXXXX")" || fail "mktemp failed"
# A wine prefix must live somewhere WE own; wine refuses a prefix under a
# directory it does not own (a shared /tmp).
TESTPREFIX="$(mktemp -d "$HOME/.cache/inno-uninst-prefix.XXXXXX")" || fail "mktemp (prefix) failed"
cleanup() {
  WINEPREFIX="$TESTPREFIX" wineserver -k >/dev/null 2>&1 || true
  for _ in 1 2 3; do
    if [[ $KEEP_WORK -eq 1 ]]; then
      rm -rf "$TESTPREFIX" 2>/dev/null && break
    else
      rm -rf "$WORK" "$TESTPREFIX" 2>/dev/null && break
    fi
    sleep 1
  done
  if [[ $KEEP_WORK -eq 1 ]]; then
    echo "DIAGNOSTICS PRESERVED AT: $WORK"
  fi
}
trap cleanup EXIT

export WINEDEBUG=-all
# Keep this throwaway prefix from registering .desktop entries into the host's
# app grid (same reason build-windows-cross.sh run_iscc does it).
export WINEDLLOVERRIDES="mscoree,mshtml,winemenubuilder.exe="

# ── Build a harness from the REAL [Code] section ─────────────────────────────
# Extracted verbatim from papercusp.iss so this can never drift from shipping
# code. Unlike the legacy-reaper harness this one must be INSTALLABLE and
# UNINSTALLABLE, because the logic under test lives in CurUninstallStepChanged.
# The two #defines are the ones ISCC is normally invoked with.
CODE_LINE="$(grep -n '^\[Code\]' "$ISS" | head -1 | cut -d: -f1)"
[[ -n "$CODE_LINE" ]] || fail "no [Code] section in papercusp.iss"
{
  printf '#define AppName "%s"\n#define AppId "%s"\n' "$ROLE_NAME" "$ROLE_ID"
  printf '[Setup]\nAppId={#AppId}\nAppName={#AppName}\nAppVersion=0.0.0\n'
  printf 'DefaultDirName={localappdata}\\PapercuspUninstallSelftest\n'
  printf 'PrivilegesRequired=lowest\nDisableDirPage=yes\nDisableProgramGroupPage=yes\n'
  printf 'OutputDir=out\nOutputBaseFilename=uninst-harness\nUninstallable=yes\nCreateAppDir=yes\n'
  sed -n "${CODE_LINE},\$p" "$ISS"
  # Thin harness-only probe: publish the two pure helpers' verdicts so the
  # sharing guard can be asserted directly. The FUNCTIONS are the shipping
  # ones above; only this caller is test scaffolding.
  cat <<'PROBE'

function InitializeSetup(): Boolean;
var
  FixtureRoot: String;
  EmptyFixture: String;
  NonEmptyFixture: String;
  KeepFile: String;
begin
  { Publish the Startup folder as INNO resolves it. Guessing this path in bash
    means the test can seed a shortcut somewhere the uninstaller was never going
    to look and then report a false failure — or, if the guess drifted the other
    way, a false pass. Ask the thing under test. }
  RegWriteStringValue(HKCU, 'Software\PapercuspSelftest', 'UserStartup', ExpandConstant('{userstartup}'));
  RegWriteStringValue(HKCU, 'Software\PapercuspSelftest', 'OtherRoleAppId', OtherRoleAppId);
  if SharedRuntimeStillNeeded then
    RegWriteStringValue(HKCU, 'Software\PapercuspSelftest', 'SharedRuntimeStillNeeded', 'yes')
  else
    RegWriteStringValue(HKCU, 'Software\PapercuspSelftest', 'SharedRuntimeStillNeeded', 'no');

  { Recurrence fixture for the empty-role-directory fix. RemoveDir is the
    shipping helper's narrow contract: empty directories are removable, while
    a directory containing even one file is left alone. }
  FixtureRoot := ExpandConstant('{tmp}\papercusp-uninstall-cleanup-fixture');
  EmptyFixture := FixtureRoot + '\empty-role';
  NonEmptyFixture := FixtureRoot + '\non-empty-role';
  KeepFile := NonEmptyFixture + '\keep.txt';
  DeleteFile(KeepFile);
  RemoveDir(NonEmptyFixture);
  RemoveDir(EmptyFixture);
  RemoveDir(FixtureRoot);
  ForceDirectories(EmptyFixture);
  if RemoveEmptyDirectory(EmptyFixture) and (not DirExists(EmptyFixture)) then
    RegWriteStringValue(HKCU, 'Software\PapercuspSelftest', 'EmptyFixtureRemoved', 'yes')
  else
    RegWriteStringValue(HKCU, 'Software\PapercuspSelftest', 'EmptyFixtureRemoved', 'no');
  ForceDirectories(NonEmptyFixture);
  SaveStringToFile(KeepFile, 'fixture', False);
  if (not RemoveEmptyDirectory(NonEmptyFixture)) and FileExists(KeepFile) then
    RegWriteStringValue(HKCU, 'Software\PapercuspSelftest', 'NonEmptyFixturePreserved', 'yes')
  else
    RegWriteStringValue(HKCU, 'Software\PapercuspSelftest', 'NonEmptyFixturePreserved', 'no');
  Result := True;
end;
PROBE
} > "$WORK/harness.iss"

HARNESS_WIN="$(WINEPREFIX="$WINEPREFIX_INNO" winepath -w "$WORK/harness.iss" 2>/dev/null)"
[[ -n "$HARNESS_WIN" ]] || fail "winepath could not map $WORK/harness.iss"

if ! WINEPREFIX="$WINEPREFIX_INNO" timeout 300 xvfb-run -a wine "$ISCC_EXE" "$HARNESS_WIN" \
     > "$WORK/iscc.log" 2>&1; then
  echo "--- ISCC output ---"; tail -30 "$WORK/iscc.log"
  fail "the [Code] section did not compile (a syntax/identifier error in papercusp.iss)"
fi
HARNESS_EXE="$WORK/out/uninst-harness.exe"
[[ -f "$HARNESS_EXE" ]] || fail "ISCC reported success but produced no harness exe"
echo "  [Code] section compiles ✓"

# ── Boot the throwaway prefix ────────────────────────────────────────────────
WINEPREFIX="$TESTPREFIX" timeout 300 xvfb-run -a wineboot -i >"$WORK/wineboot.log" 2>&1
[[ -d "$TESTPREFIX/drive_c" ]] || { tail -5 "$WORK/wineboot.log"; fail "could not boot a test wine prefix"; }

RUN_KEY='HKCU\Software\Microsoft\Windows\CurrentVersion\Run'
APPROVED_KEY='HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run'
UNINST_ROOT='HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall'
PROBE_KEY='HKCU\Software\PapercuspSelftest'

wreg()  { WINEPREFIX="$TESTPREFIX" xvfb-run -a wine reg "$@" >/dev/null 2>&1; }
# Registry assertion helpers above keep instrument errors and missing probe
# values out of product verdicts.
# Two things make the naive `awk '$1 == name { print $3 }'` wrong here, and both
# fail in the direction that reads as "value absent" — i.e. as a PASS for a
# cleanup that did nothing:
#   - `wine reg query` emits CRLF, so the last field carries a trailing \r and
#     every string comparison against it fails;
#   - the value names under test are the product names, which CONTAIN SPACES
#     ("Papercusp GUI"), so they span $1..$2 and never equal $1.
# Match on the name as a prefix of the trimmed line and take everything after
# the REG_* type column instead.
# ── Cases 5/6: the SHARED-DISTRO guard, measured at install time ─────────────
# 5) sibling product present => the runtime is still needed => never offered.
wreg add "$UNINST_ROOT\\${OTHER_ID}_is1" /v UninstallString /d 'C:\whatever\unins000.exe' /f
wreg delete "$PROBE_KEY" /f
checked_command "install with sibling" "$WORK/install-with-sibling.log" run_install with-sibling
assert_rvalue_equals "$PROBE_KEY" OtherRoleAppId "$OTHER_ID" \
  "resolves the sibling role id ($OTHER_ID)" \
  "OtherRoleAppId did not resolve to $OTHER_ID"
assert_rvalue_equals "$PROBE_KEY" SharedRuntimeStillNeeded yes \
  "shared papercup-runtime is kept while the sibling product is installed (data-safety control)" \
  "SHARED DISTRO WOULD BE OFFERED FOR DELETION while $OTHER_NAME is still installed"

# 6) sibling gone => this is the last Papercusp product => the offer is allowed.
wreg delete "$UNINST_ROOT\\${OTHER_ID}_is1" /f
wreg delete "$PROBE_KEY" /f
checked_command "install without sibling" "$WORK/install-no-sibling.log" run_install no-sibling
assert_rvalue_equals "$PROBE_KEY" SharedRuntimeStillNeeded no \
  "shared papercup-runtime becomes removable once no sibling product remains" \
  "the runtime is never offered for removal even as the last product — DEFECT 2 unfixed"
assert_rvalue_equals "$PROBE_KEY" EmptyFixtureRemoved yes \
  "empty role directory is removed by the narrow helper (recurrence fixture)" \
  "empty role directory helper did not remove the empty fixture"
assert_rvalue_equals "$PROBE_KEY" NonEmptyFixturePreserved yes \
  "non-empty role directory is preserved by the narrow helper" \
  "directory helper would remove a non-empty payload/config directory"

# ── Seed the state a real uninstall must clean (and must NOT) ────────────────
# The role under test AND its sibling both have autostart registered.
wreg add "$RUN_KEY"      /v "$ROLE_NAME"  /d 'C:\gone\papercusp-desktop.exe' /f
wreg add "$RUN_KEY"      /v "$OTHER_NAME" /d 'C:\still-here\papercusp-desktop.exe' /f
wreg add "$APPROVED_KEY" /v "$ROLE_NAME"  /d 'marker' /f

if STARTUP_WIN=$(rvalue "$PROBE_KEY" UserStartup); then
  [[ -n "$STARTUP_WIN" ]] || fail "the harness published an empty {userstartup} path"
else
  status=$?
  if [[ $status -eq 1 ]]; then
    fail "the harness did not publish {userstartup} — cannot locate the Startup folder Inno uses"
  fi
  fail "registry query for {userstartup} failed (status $status); case measured nothing"
fi
STARTUP_DIR="$(WINEPREFIX="$TESTPREFIX" winepath -u "$STARTUP_WIN" 2>/dev/null)"
[[ -n "$STARTUP_DIR" ]] || fail "winepath could not map $STARTUP_WIN to a unix path"
mkdir -p "$STARTUP_DIR" 2>/dev/null
printf 'stub' > "$STARTUP_DIR/$ROLE_NAME.lnk"

require_rvalue_present "$RUN_KEY" "$ROLE_NAME" "seeding failed: this role's Run value absent before the uninstall"
[[ -f "$STARTUP_DIR/$ROLE_NAME.lnk" ]]       || fail "seeding failed: startup shortcut absent before the uninstall"

# ── Run the real uninstaller ─────────────────────────────────────────────────
APPDIR="$(printf '%s' "$TESTPREFIX"/drive_c/users/*/AppData/Local/PapercuspUninstallSelftest)"
UNINST="$APPDIR/unins000.exe"
[[ -f "$UNINST" ]] || fail "the harness produced no unins000.exe at $UNINST (install did not complete)"
# A sibling user-config directory is intentionally outside {app}; it must
# survive uninstall even when the role root cleanup is exercised.
CONFIG_SENTINEL="$(dirname "$APPDIR")/Papercusp/uninstall-preserve-sentinel.txt"
mkdir -p "$(dirname "$CONFIG_SENTINEL")" 2>/dev/null
printf 'keep-user-config' > "$CONFIG_SENTINEL"
UNINST_LOG_WIN="$(WINEPREFIX="$TESTPREFIX" winepath -w "$WORK" 2>/dev/null)\\inno-uninstall.log"
run_uninstall() {
  WINEPREFIX="$TESTPREFIX" timeout 300 xvfb-run -a wine "$UNINST" \
    /VERYSILENT /NORESTART /SUPPRESSMSGBOXES "/LOG=$UNINST_LOG_WIN" >"$WORK/uninstall-launch.log" 2>&1
}
checked_command "uninstall invocation" "$WORK/uninstall-launch.log" run_uninstall

# AN INNO UNINSTALLER RETURNS BEFORE IT HAS FINISHED. unins000.exe copies itself
# to %TEMP% and relaunches from there (so it can delete its own directory), and
# the process we launched exits immediately. Asserting here without waiting reads
# every not-yet-run cleanup as "the cleanup did not happen" — which is a FALSE
# FAILURE, and, worse, the same shape would be a false PASS for any assertion
# phrased as "the value is still present". Wait for the real completion signal:
# the install directory being gone.
for _ in $(seq 1 60); do
  [[ -d "$APPDIR" ]] || break
  sleep 1
done
[[ ! -d "$APPDIR" ]] || fail "the uninstaller left the empty role install directory at $APPDIR"
# The registry writes happen in usPostUninstall, i.e. after the directory goes.
sleep 2

# ── Cases 1-4 ────────────────────────────────────────────────────────────────
assert_rvalue_absent "$RUN_KEY" "$ROLE_NAME" \
  "login-autostart Run value removed (WI-39403 DEFECT 1)" \
  "RUN VALUE SURVIVED — every login still launches a deleted exe (WI-39403 regression)"

assert_rvalue_present "$RUN_KEY" "$OTHER_NAME" \
  "the sibling product's Run value is spared (falsifiability control)" \
  "CROSS-ROLE DELETE — uninstalling $ROLE_NAME disabled $OTHER_NAME's auto-start"

assert_rvalue_absent "$APPROVED_KEY" "$ROLE_NAME" \
  "StartupApproved\\Run marker removed (no orphan Task Manager row)" \
  "StartupApproved marker survived — Task Manager still lists a program that is gone"

[[ ! -f "$STARTUP_DIR/$ROLE_NAME.lnk" ]] \
  && ok "dangling Startup shortcut swept" \
  || bad "Startup shortcut survived the uninstall"

[[ -f "$CONFIG_SENTINEL" ]] \
  && ok "user config outside the role directory survived uninstall" \
  || bad "uninstall removed user config outside the role directory"

if [[ $RC -ne 0 && -f "$WORK/inno-uninstall.log" ]]; then
  echo "--- Inno uninstall log (tail) ---"
  tr -d '\r' < "$WORK/inno-uninstall.log" | tail -25
  echo "---------------------------------"
fi

echo
if [[ $RC -eq 0 ]]; then
  echo "PASS inno-uninstall-cleanup: autostart cleaned, sibling role and shared runtime protected"
else
  KEEP_WORK=1
  echo "FAIL inno-uninstall-cleanup: see the assertions above"
  echo "DIAGNOSTICS PRESERVED AT: $WORK"
fi
exit $RC
