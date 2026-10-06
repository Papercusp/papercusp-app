set -eu
# PAPERCUSP_NATIVE_MAC_PREFLIGHT
# REMOTE script (runs on the macOS VM under /bin/sh / bash 3.2 — keep it POSIX).
# Sent verbatim over ssh by bin/install-and-relaunch-verify.sh (before any
# artifact push) and by bin/smoke-target-preflight.sh (before a long release
# build). ONE source so the two can never disagree about what "a usable native
# macOS upgrade target" means (WI-10004346).
console_user="$(stat -f %Su /dev/console)"
login_user="$(id -un)"
login_uid="$(id -u)"
if [ "$console_user" = root ] || [ "$console_user" = loginwindow ] || [ "$console_user" != "$login_user" ]; then
  echo "macOS native preflight: SSH user must own the logged-in GUI console" >&2
  exit 2
fi
if ! launchctl print "gui/$login_uid" >/dev/null 2>&1; then
  echo "macOS native preflight: logged-in GUI launch domain is unavailable" >&2
  exit 2
fi
if launchctl print system/com.papercusp.server >/dev/null 2>&1; then
  echo "macOS native preflight: competing system/com.papercusp.server is loaded; repair test supervision and establish a genuine native pre-update baseline before retrying" >&2
  exit 2
fi
# `open -n` bypasses LaunchServices reuse, NOT Tauri's per-role singleton.
# A live old shell rejects the candidate before its --ensure can run. Do not
# quit that Server here: normal quit tears down its owned operator, fabricating
# the stale-operator replacement this test is meant to prove. Prepare a genuine
# older bundled runtime via the supported detached/headless launch first.
native_shells="$(ps -axo pid=,comm=)" || {
  echo "macOS native preflight: cannot inspect native single-instance shells" >&2
  exit 2
}
while read -r native_pid executable; do
  case "$executable" in
    */Papercusp\ Server.app*/Contents/MacOS/papercusp-desktop|*/Papercusp\ GUI.app*/Contents/MacOS/papercusp-desktop)
      native_args="$(ps -p "$native_pid" -o args=)" || {
        echo "macOS native preflight: native process changed during inspection; retry the baseline check" >&2
        exit 2
      }
      if [ "$native_args" = "$executable --headless-service" ]; then
        # This supported service branch runs BEFORE Tauri's singleton plugin.
        continue
      fi
      echo "macOS native preflight: a native Papercusp shell holds the single-instance lock; prepare a headless older bundled-runtime baseline before retrying (no operator termination inside acceptance)" >&2
      exit 2
      ;;
  esac
done <<EOF
$native_shells
EOF
printf 'PAPERCUSP_NATIVE_MAC_PREFLIGHT_OK\n'
