#!/usr/bin/env bash
# verify-appimage-pristine.sh — RUNTIME proof that the packaged .AppImage works on a
# host with NO system WebKitGTK.  (EI-20082207759701826)
#
# ── Why this exists ─────────────────────────────────────────────────────────────
# EI-20075266271803900 (AppImage hard-fails on any host without system
# libwebkit2gtk) survived a year of release verification.  The BUG is fixed; the
# DETECTOR gap is what this closes.  Nothing ever RAN the packaged artifact on a
# webkit-free box, and every existing check is structurally incapable of it:
#
#   * `vmctl updater-e2e` resets a pristine VM and then INSTALLS THE .deb
#     (cmd_updater_e2e -> cmd_install "$name" "$runtime_deb") to "provision the
#     runtime dependency set".  The .deb depends on libwebkit2gtk-4.1, so the very
#     host meant to prove self-containment is no longer pristine by launch time.
#     Its comment there ("The AppImage intentionally relies on system WebKit/GTK")
#     describes PRE-fix reality and is stale — the fix bundles WebKit.
#   * `bin/linux-fresh-install-e2e.sh` never runs dpkg -i, but launches the
#     AppImage on the SHARED DEV HOST, which carries system webkit
#     (measured on the build box: `dpkg -l | grep -c webkit2gtk` = 3).
#   * The build-time guards in build-appimage.sh (2c-iii self-containment, 3b-ii
#     `cd "$HERE"`) are real and load-bearing, but they run at BUILD time against
#     the AppDir.  They cannot observe execution.
#   * A hand-assembled AppDir tree does NOT behave like a packaged .AppImage.
#     Root cause 2 was a path-CHOICE bug: the helper binaries were present and
#     executable the whole time, and libwebkit simply asked for them at an
#     absolute /usr/lib path.  Presence checks cannot see that class; only
#     executing the packaged artifact can.
#
# ── Why Docker and not a VM ─────────────────────────────────────────────────────
# The item proposed a `vmctl appimage-e2e` verb.  A container is enough and is
# ~2 minutes instead of a VM reset: the property under test is "which libraries
# does the dynamic loader find", which is a mount-namespace property, not a
# kernel-boundary one.  We keep the VM lane for what genuinely needs a real OS.
#
# ── Anti-drift: the assertion scope is DERIVED, never hand-listed ───────────────
# build-appimage.sh already carries the failure mode this guard must not repeat:
# its GL-fallback copy loop iterates five sonames while its self-containment guard
# spot-checks exactly one.  A guard whose assertion list is a hand-maintained
# SUBSET of the payload it guards drifts silently while still PASSING.
# So this script derives its scope from the shipped artifact itself:
#   * the library search path comes from parsing the AppRun's own
#     `export LD_LIBRARY_PATH=` line — add a lib dir to the build and this guard
#     covers it on the next run with no edit here;
#   * the WebKit helper dirs come from parsing the AppRun's own `for _wk in` line;
#   * the exec'd binary comes from parsing the AppRun's own `exec "$HERE/…"` line
#     — rename the binary and this guard follows it instead of silently scanning
#     one object fewer;
#   * the ELF set is every ELF actually found in those dirs, not a soname list.
# The only hand-maintained list is HOST_STACK below, and it is a cry-wolf knob
# (which libs a stock desktop legitimately supplies), not a subset of our payload:
# getting it wrong makes the gate LOUDER, never quieter.
#
# ── Usage ──────────────────────────────────────────────────────────────────────
#   bash bin/verify-appimage-pristine.sh <path-to-GUI-AppImage>
#
# Env:
#   PC_PRISTINE_KEEP=1        keep the extracted tree + logs for inspection
#   PC_PRISTINE_OBSERVE=45    seconds to observe the launched app (default 45)
#   PC_PRISTINE_IMAGE=...     base image (default ubuntu:24.04 — see below)
#   PC_PRISTINE_SKIP_RUNTIME=1  run only the static leg (no docker run of the app)
#
# Base image is load-bearing: ubuntu:24.04 matches the build host's glibc 2.39.
# On 22.04 a glibc mismatch reads as a bundling failure — a false RED.
set -euo pipefail

fail() { echo "FATAL: $*" >&2; exit 2; }
note() { echo "    $*"; }
step() { echo "==> $*"; }

# ── derive_scope <appdir> ──────────────────────────────────────────────────────
# Sets LIBDIRS / WKDIRS / EXECTARGET from the AppRun that actually shipped.
# Defined as a function (rather than inline) so `--derive-only` — and therefore
# the unit guard in test/appimage-pristine-derivation.test.js — exercises THIS
# code rather than a JavaScript re-implementation of these regexes that could
# drift away from it silently.
derive_scope() {
  local appdir="$1"
  [[ -r "$appdir/AppRun" ]] || fail "no readable AppRun in $appdir"

  # --- library search path -----------------------------------------------------
  local ldline
  ldline="$(grep -m1 '^export LD_LIBRARY_PATH=' "$appdir/AppRun" || true)"
  [[ -n "$ldline" ]] \
    || fail "AppRun has no 'export LD_LIBRARY_PATH=' line — this guard derives its scope from it; the AppRun contract changed and this script must be updated deliberately"
  mapfile -t LIBDIRS < <(
    printf '%s\n' "$ldline" | grep -oE '\$HERE/[A-Za-z0-9_./+-]+' | sed 's|^\$HERE/||' | sort -u
  )
  [[ "${#LIBDIRS[@]}" -gt 0 ]] || fail "derived an EMPTY library search path from the AppRun — refusing to run a guard that would inspect nothing"
  note "library dirs derived from AppRun (${#LIBDIRS[@]}): ${LIBDIRS[*]}"

  # --- webkit helper dirs ------------------------------------------------------
  local wkline
  wkline="$(grep -m1 '^for _wk in' "$appdir/AppRun" || true)"
  mapfile -t WKDIRS < <(
    printf '%s\n' "$wkline" | grep -oE '\$HERE/[A-Za-z0-9_./+-]+' | sed 's|^\$HERE/||' | sort -u
  )
  note "webkit helper dirs derived from AppRun (${#WKDIRS[@]}): ${WKDIRS[*]:-<none>}"

  # --- the exec'd binary -------------------------------------------------------
  # Derived, not hardcoded: a hardcoded `usr/bin/papercusp-desktop` would keep
  # PASSING after a rename while silently scanning the main binary no longer —
  # the exact silent-subset failure this guard's header forbids.
  EXECTARGET="$(
    grep -m1 -E '^exec[[:space:]]+"\$HERE/' "$appdir/AppRun" \
      | grep -oE '\$HERE/[^"]+' | sed 's|^\$HERE/||' || true
  )"
  [[ -n "$EXECTARGET" ]] \
    || fail "AppRun has no 'exec \"\$HERE/…\"' line — cannot derive which binary ships as the entrypoint; refusing to guess"
  [[ -x "$appdir/$EXECTARGET" ]] \
    || fail "AppRun execs '$EXECTARGET' but the packaged payload has no executable there — the artifact cannot start at all"
  note "entrypoint derived from AppRun: $EXECTARGET"

  # --- the 3b-ii invariant, re-asserted on the PACKAGED artifact ---------------
  # build-appimage.sh asserts this on the AppDir at build time.  Re-assert it here
  # on what actually shipped: WebKitGTK resolves its helpers against the process
  # CWD, so this one line is what lets them spawn on a webkit-free host.
  grep -qE '^cd "\$HERE"' "$appdir/AppRun" \
    || fail "packaged AppRun does not 'cd \"\$HERE\"' — WebKit resolves its relativized PKGLIBEXECDIR against the process CWD, so helper spawn WILL fail on a host without system WebKitGTK. Reproduces EI-20075266271803900."
  note "AppRun 'cd \"\$HERE\"' present (3b-ii holds on the packaged artifact)"
}

# `--derive-only <appdir>` runs ONLY the derivation above against an already
# extracted AppDir and prints the machine-readable result.  No docker, no
# unsquashfs, no AppImage — that is what lets a fast unit guard exercise the real
# derivation with seeded AppRun mutations.
if [[ "${1:-}" = "--derive-only" ]]; then
  DERIVE_DIR="${2:-}"
  [[ -n "$DERIVE_DIR" && -d "$DERIVE_DIR" ]] || fail "usage: $0 --derive-only <appdir>"
  derive_scope "$DERIVE_DIR"
  echo "DERIVED_LIBDIRS=${LIBDIRS[*]}"
  echo "DERIVED_WKDIRS=${WKDIRS[*]:-}"
  echo "DERIVED_EXEC=$EXECTARGET"
  exit 0
fi

# `--appdir <dir>` runs the pristine legs against a payload the CALLER already
# extracted (e.g. linux-fresh-install-e2e.sh, which self-extracts the artifact
# with its own runtime and asserts that step itself).  It skips steps 1-2 only;
# every assertion that matters — the derivation, the webkit-free precondition,
# the DT_NEEDED sweep, the launched-app marker — is unchanged.  Re-extracting a
# 6+ GB payload a caller already has on disk is minutes of pure waste.
MODE="appimage"
APPDIR_IN=""
if [[ "${1:-}" = "--appdir" ]]; then
  MODE="appdir"
  APPDIR_IN="${2:-}"
  [[ -n "$APPDIR_IN" && -d "$APPDIR_IN" ]] || fail "usage: $0 --appdir <extracted-appdir>"
  APPDIR_IN="$(cd "$APPDIR_IN" && pwd)"
  APPIMAGE=""
else
  APPIMAGE="${1:-}"
  [[ -n "$APPIMAGE" ]] || fail "usage: $0 <path-to-GUI-AppImage> | $0 --appdir <extracted-appdir>"
  [[ -f "$APPIMAGE" ]] || fail "no AppImage at $APPIMAGE"
  APPIMAGE="$(cd "$(dirname "$APPIMAGE")" && pwd)/$(basename "$APPIMAGE")"
fi

OBSERVE="${PC_PRISTINE_OBSERVE:-45}"
case "$OBSERVE" in ''|*[!0-9]*|0) fail "PC_PRISTINE_OBSERVE must be a positive integer" ;; esac
IMAGE="${PC_PRISTINE_IMAGE:-ubuntu:24.04}"

# The stock-desktop stack a real user's box supplies.  Deliberately WITHOUT
# libwebkit2gtk-4.1-0 — that absence IS the test.  A bare base image is HARSHER
# than the real bar and fails on ~45 libs (libX11, fontconfig, freetype, harfbuzz,
# fribidi, expat, drm, gbm, ...) that are on linuxdeploy's excludelist, i.e.
# legitimately host-supplied.  Installing this stack is what stops the gate crying
# wolf on every build.
HOST_STACK="libgtk-3-0t64 libgl1 libgbm1 libdrm2 libx11-xcb1 libasound2t64 xvfb procps file"

# unsquashfs/python3 are needed ONLY to open a packaged .AppImage (steps 1-2).
# Demanding them in --appdir mode would refuse on a host that has everything the
# run actually uses — a false RED, which is the cry-wolf failure this guard's
# HOST_STACK note warns about, one level up.
REQUIRED_TOOLS=(docker)
[[ "$MODE" = "appimage" ]] && REQUIRED_TOOLS+=(unsquashfs python3)
for tool in "${REQUIRED_TOOLS[@]}"; do
  command -v "$tool" >/dev/null 2>&1 || fail "required tool missing: $tool"
done
docker info >/dev/null 2>&1 || fail "docker daemon is not available"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/appimage-pristine.XXXXXX")" || fail "cannot create work dir"
cleanup() {
  if [[ "${PC_PRISTINE_KEEP:-0}" = "1" ]]; then
    echo "    (kept: $WORK)"
  else
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

if [[ "$MODE" = "appdir" ]]; then
  APPDIR="$APPDIR_IN"
  step "1-2. using the caller's already-extracted payload: $APPDIR"
  [[ -x "$APPDIR/AppRun" ]] || fail "supplied AppDir has no executable AppRun"
else
step "1. locating the squashfs payload (without executing the artifact)"
# An AppImage type-2 is an ELF runtime with the squashfs appended immediately
# after the section-header table.  Deriving the offset from the ELF header keeps
# us from executing an artifact we are about to test, and from hardcoding an
# offset that changes every build.
OFFSET="$(python3 - "$APPIMAGE" <<'PY'
import struct, sys
with open(sys.argv[1], 'rb') as fh:
    hdr = fh.read(64)
if hdr[:4] != b'\x7fELF':
    sys.exit('not an ELF: missing \\x7fELF magic')
if hdr[4] != 2:
    sys.exit('not a 64-bit ELF (EI_CLASS != 2)')
e_shoff    = struct.unpack_from('<Q', hdr, 0x28)[0]
e_shentsize= struct.unpack_from('<H', hdr, 0x3A)[0]
e_shnum    = struct.unpack_from('<H', hdr, 0x3C)[0]
print(e_shoff + e_shentsize * e_shnum)
PY
)" || fail "could not derive the squashfs offset from the ELF header"
[[ "$OFFSET" =~ ^[0-9]+$ ]] || fail "derived offset is not numeric: $OFFSET"

# Prove the derivation before trusting it: squashfs magic must sit exactly there.
MAGIC="$(dd if="$APPIMAGE" bs=1 skip="$OFFSET" count=4 2>/dev/null | tr -d '\0')"
[[ "$MAGIC" = "hsqs" ]] \
  || fail "no squashfs magic at derived offset $OFFSET (read '$MAGIC') — the artifact is not a type-2 AppImage, or its layout changed"
note "squashfs at offset $OFFSET (magic verified)"

step "2. extracting the packaged payload"
APPDIR="$WORK/root"
unsquashfs -q -no-progress -o "$OFFSET" -d "$APPDIR" "$APPIMAGE" >/dev/null \
  || fail "unsquashfs failed at offset $OFFSET"
[[ -x "$APPDIR/AppRun" ]] || fail "extracted payload has no executable AppRun"
note "extracted $(du -sh "$APPDIR" 2>/dev/null | cut -f1) to $APPDIR"
fi

step "3. deriving the guard's scope from the shipped AppRun"
derive_scope "$APPDIR"

step "4. running the pristine-box checks in $IMAGE"
# The sidecar is deliberately NOT patchelf'd and ships its own self-contained
# runtime (build-appimage.sh header).  It is not on the AppRun's LD_LIBRARY_PATH,
# so the derived scope already excludes it; this is recorded so the exclusion is
# understood as derived rather than as a carve-out someone added to silence a red.
cat > "$WORK/incontainer.sh" <<'INNER'
#!/usr/bin/env bash
set -uo pipefail
A=/app
fail() { echo "PRISTINE_FAIL: $*"; exit 1; }

echo "--- precondition: this box must have NO system WebKitGTK ---"
WK="$(dpkg -l 2>/dev/null | grep -c webkit2gtk || true)"
[ "$WK" = "0" ] || fail "container is NOT pristine: $WK webkit2gtk package(s) installed. A non-pristine box is structurally incapable of detecting this class."
echo "    dpkg webkit2gtk packages = 0"
# Belt and braces: the loader must not find a system copy by any other route.
if ldconfig -p 2>/dev/null | grep -q 'libwebkit2gtk-4\.1\.so\.0'; then
  fail "ldconfig cache advertises libwebkit2gtk-4.1.so.0 — the host would satisfy what the bundle must supply"
fi
echo "    ldconfig advertises no libwebkit2gtk-4.1.so.0"

# Replicate the AppRun's environment exactly.  NOT strace: the AppRun is a shell
# script, so strace traces its readlink/dirname helpers and never reaches the
# binary, yielding a clean-looking false PASS with ~2 resolved libs.
LDP=""
for d in $PC_LIBDIRS; do LDP="${LDP:+$LDP:}$A/$d"; done
export LD_LIBRARY_PATH="$LDP"
cd "$A" || fail "cannot cd into the mounted payload"

echo "--- leg A: derived DT_NEEDED resolution over every bundled ELF ---"
# Scope is the AppRun's own search path + the exec'd binary + the webkit helpers.
SCAN=""
for d in $PC_LIBDIRS $PC_WKDIRS; do [ -d "$A/$d" ] && SCAN="$SCAN $A/$d"; done
[ -n "$SCAN" ] || fail "no derived scan dirs exist in the payload"

ELVES="$(mktemp)"
# shellcheck disable=SC2086
find $SCAN -type f \( -perm -u+x -o -name '*.so' -o -name '*.so.*' \) -print0 2>/dev/null \
  | xargs -0 -r file -h --mime-type 2>/dev/null \
  | awk -F': ' '$2 ~ /application\/x-(sharedlib|executable|pie-executable)/ {print $1}' \
  > "$ELVES"
[ -x "$A/$PC_EXEC" ] || fail "derived entrypoint '$PC_EXEC' is not executable inside the container"
echo "$A/$PC_EXEC" >> "$ELVES"
sort -u -o "$ELVES" "$ELVES"
COUNT="$(wc -l < "$ELVES" | tr -d ' ')"
[ "$COUNT" -gt 0 ] || fail "found ZERO ELF objects in the derived scope — the guard would pass vacuously"
echo "    scanning $COUNT ELF object(s) across the derived scope"

MISSING="$(mktemp)"
while IFS= read -r f; do
  ldd "$f" 2>/dev/null | awk -v F="$f" '/not found/ {print F": "$1}'
done < "$ELVES" > "$MISSING"

if [ -s "$MISSING" ]; then
  echo "    UNRESOLVED (first 40):"
  sort -u "$MISSING" | head -40 | sed 's/^/      /'
  fail "$(sort -u "$MISSING" | wc -l | tr -d ' ') unresolved DT_NEEDED entr(ies) on a webkit-free host"
fi
echo "    leg A PASS: 0 unresolved libraries across $COUNT ELF objects"

if [ "${PC_SKIP_RUNTIME:-0}" = "1" ]; then
  echo "PRISTINE_OK (static leg only; runtime leg skipped by request)"
  exit 0
fi

echo "--- leg B: launching the packaged app under Xvfb ---"
export HOME=/tmp/pristine-home
mkdir -p "$HOME"
export XDG_RUNTIME_DIR=/tmp/xdg && mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
Xvfb :99 -screen 0 1280x900x24 >/tmp/xvfb.log 2>&1 &
XVFB_PID=$!
sleep 2
kill -0 "$XVFB_PID" 2>/dev/null || fail "Xvfb did not start"
export DISPLAY=:99

LOG=/tmp/app.log
# Launch through the artifact's OWN AppRun, exactly as a user's desktop would.
setsid "$A/AppRun" >"$LOG" 2>&1 &
APP_PID=$!
echo "    launched AppRun (pid $APP_PID); observing ${PC_OBSERVE}s"
for _ in $(seq 1 "$PC_OBSERVE"); do
  sleep 1
  grep -qE 'cannot open shared object file|error while loading shared libraries|Failed to spawn child process' "$LOG" && break
  grep -q '\[webkit-render\] applied' "$LOG" && break
done
kill -0 "$APP_PID" 2>/dev/null && ALIVE=1 || ALIVE=0
kill -TERM -"$APP_PID" 2>/dev/null || true
kill "$XVFB_PID" 2>/dev/null || true

echo "--- captured output (tail) ---"
tail -40 "$LOG" | sed 's/^/      /'
echo "------------------------------"

BAD=0
for pat in 'cannot open shared object file' 'error while loading shared libraries' 'Failed to spawn child process'; do
  N="$(grep -c "$pat" "$LOG" || true)"
  if [ "$N" != "0" ]; then echo "    FAIL marker x$N: $pat"; BAD=1; fi
done
[ "$BAD" = "0" ] || fail "the packaged app hit a loader/helper-spawn failure on a webkit-free host"

# Positive proof the WebKit layer actually came up, not merely that nothing
# printed an error.  This is the assertion that makes a silent no-op a RED.
if grep -q '\[webkit-render\] applied' "$LOG"; then
  echo "    $(grep -m1 '\[webkit-render\] applied' "$LOG")"
else
  [ "$ALIVE" = "1" ] || fail "app exited without ever reaching the WebKit renderer (no '[webkit-render] applied' marker)"
  fail "no '[webkit-render] applied' marker within ${PC_OBSERVE}s — WebKit never initialised on a webkit-free host"
fi

echo "PRISTINE_OK"
INNER
chmod +x "$WORK/incontainer.sh"

DOCKER_ARGS=(
  --rm
  -v "$APPDIR:/app:ro"
  -v "$WORK/incontainer.sh:/incontainer.sh:ro"
  -e "PC_LIBDIRS=${LIBDIRS[*]}"
  -e "PC_WKDIRS=${WKDIRS[*]:-}"
  -e "PC_EXEC=$EXECTARGET"
  -e "PC_OBSERVE=$OBSERVE"
  -e "PC_SKIP_RUNTIME=${PC_PRISTINE_SKIP_RUNTIME:-0}"
  -e "HOST_STACK=$HOST_STACK"
)

set +e
docker run "${DOCKER_ARGS[@]}" "$IMAGE" bash -c '
  set -e
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq >/dev/null 2>&1
  # shellcheck disable=SC2086
  apt-get install -y -qq $HOST_STACK >/dev/null 2>&1
  exec /incontainer.sh
'
RC=$?
set -e

echo
if [[ "$RC" -eq 0 ]]; then
  step "PASS — the packaged AppImage runs on a host with no system WebKitGTK"
else
  step "FAIL — the packaged AppImage does NOT survive a pristine (webkit-free) host"
  echo "    This is the EI-20075266271803900 class. Do not ship this artifact." >&2
fi
exit "$RC"
