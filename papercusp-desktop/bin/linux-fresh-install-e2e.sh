#!/usr/bin/env bash
# Linux GUI artifact verification of the shipped build. Bounded, single-shot,
# re-runnable, and deliberately honest about its scope.
#
# THIS SCRIPT EMITS A VERDICT: exit 0 = PASS, 1 = FAIL, 2 = VOID.
#
# Papercusp now ships two co-installable products. Papercusp GUI is a thin
# webview containing only sidecar/spa; Papercusp Server owns serve.mjs, Node,
# Postgres, migrations, and /api/health. This Linux leg is intentionally
# GUI-ONLY because it never performs dpkg -i on the shared host. It proves:
#
#   1. the downloaded GUI .deb and AppImage satisfy the canonical,
#      archive-aware thin-GUI distribution census;
#   2. the .deb metadata identifies the expected version and architecture;
#   3. the AppImage starts on an isolated HOME/Xvfb display without an
#      installed/discoverable Server and remains alive through a bounded
#      missing-Server observation; and
#   4. the GUI never opens an artifact-owned /api/health endpoint. A health
#      endpoint here is a failure: it means the GUI started self-hosting again;
#      and
#   5. the packaged payload runs on a host with NO system WebKitGTK — the one
#      thing legs 1-4 structurally cannot see, because they run on a host that
#      supplies it (EI-20082207759701826 / EI-20075266271803900). Needs docker;
#      when docker is absent the leg is SKIPPED and says so rather than letting
#      a PASS imply it was checked.
#
# It does NOT prove dpkg installation, Papercusp Server boot, GUI-to-Server
# attachment, or the rendered guidance text. Those require the two-product
# install rig. The verdict repeats that boundary so a GUI-only PASS cannot be
# quoted as end-to-end evidence for the product pair.
#
# Non-destructive by construction: no package install, an isolated HOME, Xvfb
# instead of the owner's display, a per-run extraction directory, and cleanup
# bounded to recorded PIDs/paths.
#
# ENV:
#   PC_L_VERSION=0.0.18            version under test
#   PC_L_BASE=<url>                published artifact base (default: release-host.env)
#   PC_L_WORK=/tmp/pc-linux-e2e    retained artifact cache + per-run scratch
#   PC_L_SOURCE=published|local    default published
#   PC_L_LOCAL_DIR=<dir>           artifact source when PC_L_SOURCE=local
#   PC_L_OBSERVE_SECONDS=15        bounded GUI-only cold-start observation
#   PC_L_KEEP=1                    retain the unique run directory for diagnosis
#   PC_L_PRISTINE=auto|0           leg 5 (pristine-box runtime proof). auto = run
#                                  it when docker is usable; 0 = skip it LOUDLY
#   PC_L_PRISTINE_OBSERVE=120      seconds leg 5 observes the containerised app
#
# Deliberately not `set -e`: assertions accumulate into one explicit verdict.

PC_L_VERSION="${PC_L_VERSION:-0.0.18}"
PC_L_WORK="${PC_L_WORK:-/tmp/pc-linux-e2e}"
PC_L_SOURCE="${PC_L_SOURCE:-published}"
PC_L_OBSERVE_SECONDS="${PC_L_OBSERVE_SECONDS:-15}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUDIT="$HERE/audit-release-bundle.py"
FAILURES=0
VOIDS=0
NOTREACHED=0
APP_PID=""
XVFB_PID=""
RUN_DIR=""

pass() { printf '  PASS  %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; FAILURES=$((FAILURES+1)); }
void() { printf '  VOID  %s\n' "$1"; VOIDS=$((VOIDS+1)); }
skip() { printf '  ----  %s (not reached)\n' "$1"; NOTREACHED=$((NOTREACHED+1)); }
note() { printf '        %s\n' "$1"; }

cleanup() {
  # Never kill by name. Only the process group and Xvfb PID created here are
  # eligible, so peers and the owner's desktop remain outside the blast radius.
  if [ -n "$APP_PID" ]; then
    kill -TERM "-$APP_PID" 2>/dev/null
    kill -TERM "$APP_PID" 2>/dev/null
    sleep 1
    kill -KILL "-$APP_PID" 2>/dev/null
    wait "$APP_PID" 2>/dev/null
  fi
  if [ -n "$XVFB_PID" ]; then
    kill -TERM "$XVFB_PID" 2>/dev/null
    wait "$XVFB_PID" 2>/dev/null
  fi
  if [ -n "$RUN_DIR" ] && [ -d "$RUN_DIR" ] && [ "${PC_L_KEEP:-0}" != "1" ]; then
    rm -rf -- "$RUN_DIR"
  fi
}
trap cleanup EXIT INT TERM

emit_verdict() {
  echo
  echo "=============================================================="
  if [ "$VOIDS" -gt 0 ]; then
    echo " VERDICT: VOID ($VOIDS control(s) violated, $FAILURES failure(s))"
    echo " This run could not have failed honestly; do not quote it as evidence."
    echo " scope: GUI archive census + isolated cold start only; Server/install/attachment NOT tested"
    echo "=============================================================="
    exit 2
  fi
  if [ "$FAILURES" -gt 0 ]; then
    echo " VERDICT: FAIL ($FAILURES failed assertion(s), $NOTREACHED not reached)"
    echo " scope: GUI archive census + isolated cold start only; Server/install/attachment NOT tested"
    echo "=============================================================="
    exit 1
  fi
  echo " VERDICT: PASS (0 failures, $NOTREACHED not reached)"
  echo " scope: GUI archive census + isolated cold start only; Server/install/attachment NOT tested"
  echo " source=$PC_L_SOURCE version=$PC_L_VERSION deb=metadata+extract-only (no dpkg -i)"
  echo "=============================================================="
  exit 0
}

# Return "PORT PID EXE" only for a health-200 listener whose immutable
# executable image is inside this run's extracted AppImage.
probe_artifact_health() {
  local root="$1" port code pid exe
  for port in $(ss -ltnH 2>/dev/null | awk '{print $4}' | sed 's/.*://' | sort -u); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$port/api/health" 2>/dev/null)
    [ "$code" = "200" ] || continue
    pid=$(ss -ltnpH "sport = :$port" 2>/dev/null | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | head -1)
    [ -n "$pid" ] || continue
    exe=$(readlink -f "/proc/$pid/exe" 2>/dev/null)
    case "$exe" in
      "$root"/*) echo "$port $pid $exe"; return 0 ;;
    esac
  done
  return 1
}

fetch_one() {
  local name="$1" target="$ARTIFACT_DIR/$1" encoded want got rc
  if [ "$PC_L_SOURCE" = "local" ]; then
    if [ -z "${PC_L_LOCAL_DIR:-}" ] || [ ! -f "$PC_L_LOCAL_DIR/$name" ]; then
      fail "local artifact missing: ${PC_L_LOCAL_DIR:-<unset>}/$name"
      return 1
    fi
    cp -f "$PC_L_LOCAL_DIR/$name" "$target" || { fail "copy failed: $name"; return 1; }
    return 0
  fi

  encoded=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$name")
  want=$(curl -sS -I --max-time 60 "$PC_L_BASE/$encoded" 2>/dev/null | tr -d '\r' | awk 'tolower($1)=="content-length:"{print $2}' | tail -1)
  if [ -z "$want" ]; then
    fail "published artifact not reachable (no content-length): $name"
    return 1
  fi
  if [ -f "$target" ] && [ "$(stat -c %s "$target")" = "$want" ]; then
    note "cached $name ($want bytes)"
    return 0
  fi
  note "downloading $name ($want bytes)"
  curl -sS --fail --max-time 3600 -o "$target" "$PC_L_BASE/$encoded"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    fail "download failed rc=$rc: $name"
    return 1
  fi
  got=$(stat -c %s "$target")
  if [ "$got" != "$want" ]; then
    fail "size mismatch $name: got $got want $want"
    return 1
  fi
  pass "downloaded $name — $got bytes, matching content-length"
  return 0
}

run_gui_census() {
  local label="$1" artifact="$2" out="$RUN_DIR/$1-census.json" err="$RUN_DIR/$1-census.err" rc
  python3 "$AUDIT" --distribution-census gui linux "$artifact" >"$out" 2>"$err"
  rc=$?
  if [ "$rc" -eq 0 ]; then
    pass "$label satisfies the canonical thin-GUI distribution census"
    tail -1 "$out" | sed 's/^/        census: /'
    return 0
  fi
  if [ "$rc" -eq 1 ]; then
    fail "$label violates the canonical thin-GUI distribution census"
  else
    void "$label could not be inspected by the canonical distribution census (rc=$rc)"
  fi
  tail -20 "$err" 2>/dev/null | sed 's/^/        | /'
  return "$rc"
}

echo "=============================================================="
echo " Linux GUI-only artifact verification — version $PC_L_VERSION, source=$PC_L_SOURCE"
echo " work: $PC_L_WORK"
echo "=============================================================="

case "$PC_L_SOURCE" in
  published|local) ;;
  *) void "PC_L_SOURCE must be published or local, got '$PC_L_SOURCE'" ;;
esac
case "$PC_L_OBSERVE_SECONDS" in
  ''|*[!0-9]*|0) void "PC_L_OBSERVE_SECONDS must be a positive integer"; PC_L_OBSERVE_SECONDS=15 ;;
esac

for tool in python3 dpkg-deb curl ss Xvfb setsid readlink; do
  command -v "$tool" >/dev/null 2>&1 || void "required tool missing: $tool"
done
[ -f "$AUDIT" ] || void "canonical distribution auditor missing: $AUDIT"

if [ "$PC_L_SOURCE" = "published" ] && [ -z "${PC_L_BASE:-}" ]; then
  # shellcheck disable=SC1090
  [ -f "$HOME/.papercusp/release-host.env" ] && . "$HOME/.papercusp/release-host.env"
  if [ -n "${PAPERCUSP_RELEASE_HOST:-}" ]; then
    PC_L_BASE="${PAPERCUSP_RELEASE_HOST}/desktop-v${PC_L_VERSION}-alpha"
  else
    void "PC_L_BASE is unset and release-host.env supplied no PAPERCUSP_RELEASE_HOST"
    PC_L_BASE=""
  fi
fi

mkdir -p "$PC_L_WORK" || { echo "cannot create work dir: $PC_L_WORK" >&2; exit 2; }
ARTIFACT_DIR="$PC_L_WORK/artifacts"
mkdir -p "$ARTIFACT_DIR" || { echo "cannot create artifact cache: $ARTIFACT_DIR" >&2; exit 2; }
RUN_DIR=$(mktemp -d "$PC_L_WORK/run.XXXXXX") || { echo "cannot create unique run dir under $PC_L_WORK" >&2; exit 2; }
[ -n "$RUN_DIR" ] && [ -d "$RUN_DIR" ] || { echo "mktemp did not produce a run dir" >&2; exit 2; }

APPIMAGE_NAME="Papercusp_GUI_${PC_L_VERSION}_amd64.AppImage"
DEB_NAME="Papercusp GUI_${PC_L_VERSION}_amd64.deb"
APPIMAGE="$ARTIFACT_DIR/$APPIMAGE_NAME"
DEB="$ARTIFACT_DIR/$DEB_NAME"

echo
echo "=== 1. acquire GUI artifacts ==="
HAVE_APPIMAGE=0
HAVE_DEB=0
fetch_one "$APPIMAGE_NAME" && HAVE_APPIMAGE=1
fetch_one "$DEB_NAME" && HAVE_DEB=1

echo
echo "=== 2. canonical archive-aware thin-GUI census ==="
APPIMAGE_CENSUS_OK=0
if [ "$HAVE_APPIMAGE" = "1" ]; then
  chmod +x "$APPIMAGE" 2>/dev/null || void "AppImage could not be made executable: $APPIMAGE"
  run_gui_census "AppImage" "$APPIMAGE" && APPIMAGE_CENSUS_OK=1
else
  skip "AppImage distribution census"
fi
if [ "$HAVE_DEB" = "1" ]; then
  run_gui_census "Debian package" "$DEB"
else
  skip "Debian distribution census"
fi

echo
echo "=== 3. Debian metadata (no install) ==="
if [ "$HAVE_DEB" = "1" ]; then
  DEB_VERSION=$(dpkg-deb -f "$DEB" Version 2>/dev/null)
  DEB_ARCH=$(dpkg-deb -f "$DEB" Architecture 2>/dev/null)
  [ "$DEB_VERSION" = "$PC_L_VERSION" ] \
    && pass ".deb Version = $DEB_VERSION" \
    || fail ".deb Version = '${DEB_VERSION:-<unreadable>}', expected $PC_L_VERSION"
  [ "$DEB_ARCH" = "amd64" ] \
    && pass ".deb Architecture = amd64" \
    || fail ".deb Architecture = '${DEB_ARCH:-<unreadable>}'"
else
  skip "Debian metadata"
fi

echo
echo "=== 4. AppImage GUI-only cold start (Server deliberately unavailable) ==="
if [ "$APPIMAGE_CENSUS_OK" != "1" ]; then
  skip "thin-GUI cold start"
  emit_verdict
fi

cd "$RUN_DIR" || { void "cannot enter run directory: $RUN_DIR"; emit_verdict; }
if "$APPIMAGE" --appimage-extract >/dev/null 2>&1 && [ -d "$RUN_DIR/squashfs-root" ]; then
  pass "AppImage self-extracts outside the repository (no FUSE required)"
else
  fail "AppImage failed to self-extract"
  emit_verdict
fi

EXTRACT_ROOT="$(cd "$RUN_DIR/squashfs-root" && pwd)"
APPRUN="$EXTRACT_ROOT/AppRun"
if [ ! -x "$APPRUN" ]; then
  fail "AppRun missing or not executable"
  emit_verdict
fi

if find "$EXTRACT_ROOT" -type f \( -name node -o -name serve.mjs \) -print -quit | grep -q .; then
  fail "thin GUI contains a Server runtime despite the distribution census"
else
  pass "thin GUI contains no bundled node or serve.mjs"
fi

# Prevent this GUI-only run from launching a host-installed sibling Server. The
# missing launcher is the deliberate condition that exercises the explicit
# install/start guidance path while HOME keeps discovery empty.
SCRUBBED_PATH=""
IFS=':' read -ra PATH_DIRS <<< "$PATH"
for dir in "${PATH_DIRS[@]}"; do
  [ -n "$dir" ] || continue
  if [ -x "$dir/node" ] || [ -x "$dir/npm" ] || [ -x "$dir/gtk-launch" ] || [ -x "$dir/papercusp-server" ]; then
    continue
  fi
  SCRUBBED_PATH="${SCRUBBED_PATH:+$SCRUBBED_PATH:}$dir"
done
PATH_ISOLATED=1
for forbidden_command in node npm gtk-launch papercusp-server; do
  if PATH="$SCRUBBED_PATH" command -v "$forbidden_command" >/dev/null 2>&1; then
    void "$forbidden_command remains resolvable under the isolated launch PATH"
    PATH_ISOLATED=0
  fi
done
[ "$PATH_ISOLATED" = "1" ] \
  && pass "launch PATH cannot supply Node or start an installed Papercusp Server"

SCRATCH_HOME="$RUN_DIR/home"
mkdir -p "$SCRATCH_HOME/xdg"
chmod 700 "$SCRATCH_HOME/xdg"
DISPLAY_NUM=$((90 + (RANDOM % 100)))
Xvfb ":$DISPLAY_NUM" -screen 0 1280x800x24 >/dev/null 2>&1 &
XVFB_PID=$!
sleep 2
if ! kill -0 "$XVFB_PID" 2>/dev/null; then
  void "Xvfb failed to start; the GUI cannot be launched without focus steal"
  emit_verdict
fi
pass "Xvfb is isolated on :$DISPLAY_NUM (pid $XVFB_PID)"

APP_LOG="$RUN_DIR/app-launch.log"
setsid env -i \
  HOME="$SCRATCH_HOME" \
  DISPLAY=":$DISPLAY_NUM" \
  PATH="$SCRUBBED_PATH" \
  USER="${USER:-runner}" \
  LANG="${LANG:-C.UTF-8}" \
  XDG_RUNTIME_DIR="$SCRATCH_HOME/xdg" \
  WEBKIT_DISABLE_COMPOSITING_MODE=1 \
  WEBKIT_DISABLE_DMABUF_RENDERER=1 \
  "$APPRUN" >"$APP_LOG" 2>&1 &
APP_PID=$!
sleep 5
if ! kill -0 "$APP_PID" 2>/dev/null; then
  fail "GUI process died within 5s; see $APP_LOG"
  tail -25 "$APP_LOG" 2>/dev/null | sed 's/^/        | /'
  emit_verdict
fi

APP_EXE=$(readlink -f "/proc/$APP_PID/exe" 2>/dev/null)
case "$APP_EXE" in
  "$EXTRACT_ROOT"/*) pass "GUI provenance bound to extracted artifact: ${APP_EXE#$EXTRACT_ROOT}" ;;
  *) void "launched pid $APP_PID executable is not inside the extracted artifact: ${APP_EXE:-<unresolved>}" ;;
esac

SELF_HOSTED=""
EXITED=""
WAITED=0
while [ "$WAITED" -lt "$PC_L_OBSERVE_SECONDS" ]; do
  SELF_HOSTED=$(probe_artifact_health "$EXTRACT_ROOT")
  [ -z "$SELF_HOSTED" ] || break
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    EXITED=1
    break
  fi
  sleep 2
  WAITED=$((WAITED+2))
done

if [ -n "$SELF_HOSTED" ]; then
  fail "thin GUI opened an artifact-owned /api/health endpoint: $SELF_HOSTED"
elif [ -n "$EXITED" ]; then
  fail "GUI exited after ${WAITED}s while no Server was available"
  tail -25 "$APP_LOG" 2>/dev/null | sed 's/^/        | /'
else
  pass "GUI remained alive for ${WAITED}s with no Server available"
  pass "GUI opened no artifact-owned /api/health endpoint (never self-hosted)"
  note "rendered missing-Server guidance is outside this shell-only verdict and needs the two-product/UI rig"
fi

echo
echo "=== 5. pristine-box runtime proof (host with NO system WebKitGTK) ==="
# EI-20082207759701826. Every leg above runs on THIS host — which carries system
# WebKitGTK (measured on the build box: dpkg -l | grep -c webkit2gtk = 3). A host
# that supplies the library cannot observe an artifact that only works BECAUSE the
# host supplies it, which is exactly how EI-20075266271803900 survived a year of
# release verification: the AppImage hard-failed on every user's box and passed
# here. So this leg re-runs the payload section 4 already extracted inside a
# container that has no WebKitGTK at all, and asserts the app reaches its renderer.
PRISTINE_SCRIPT="$HERE/verify-appimage-pristine.sh"
PRISTINE_LOG="$RUN_DIR/pristine.log"
if [ "${PC_L_PRISTINE:-auto}" = "0" ]; then
  skip "pristine-box runtime proof (disabled by PC_L_PRISTINE=0)"
  note "NOT PROVEN: that the artifact runs without system WebKitGTK (EI-20075266271803900 class)"
elif [ ! -x "$PRISTINE_SCRIPT" ]; then
  # A missing detector is the gap itself, not a skippable extra: VOID, because a
  # PASS here would again mean "nobody checked".
  void "verify-appimage-pristine.sh is missing or not executable at $PRISTINE_SCRIPT"
elif [ -z "${EXTRACT_ROOT:-}" ] || [ ! -d "${EXTRACT_ROOT:-}" ]; then
  skip "pristine-box runtime proof (section 4 produced no extracted payload)"
elif ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  skip "pristine-box runtime proof (no usable docker on this host)"
  note "NOT PROVEN: that the artifact runs without system WebKitGTK (EI-20075266271803900 class)"
else
  note "this leg pulls a base image and boots the app in a container; expect a few minutes"
  if PC_PRISTINE_OBSERVE="${PC_L_PRISTINE_OBSERVE:-120}" \
     bash "$PRISTINE_SCRIPT" --appdir "$EXTRACT_ROOT" >"$PRISTINE_LOG" 2>&1; then
    pass "AppImage runs on a host with NO system WebKitGTK"
    grep -m1 -E 'leg A PASS:' "$PRISTINE_LOG" | sed 's/^ *//' | while read -r l; do note "$l"; done
    grep -m1 -E '\[webkit-render\] applied' "$PRISTINE_LOG" | sed 's/^ *//' | while read -r l; do note "$l"; done
  else
    fail "AppImage does NOT survive a pristine (webkit-free) host — EI-20075266271803900 class"
    tail -25 "$PRISTINE_LOG" 2>/dev/null | sed 's/^/        | /'
  fi
fi

emit_verdict
