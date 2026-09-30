#!/usr/bin/env bash
# gen-latest-manifest.selftest.sh — focused unit test for gen-latest-manifest.sh,
# the single-source-of-truth latest.json/latest-server.json generator shared by
# bin/release-local.sh (multi-leg) and bin/gen-latest-manifest.sh (single-leg CLI)
# (EI-18101626616739029). Proves, hermetically (synthetic files in a temp dir — NO
# real cut, NO cargo/tauri build, NO network, ~1s):
#   1. desktop_release_tag matches the operator's manifest classifier for all three
#      channels (alpha/beta/stable).
#   2. gen_latest_manifest writes a GUI latest.json with the right platform key +
#      signature + url for a Linux AppImage artifact.
#   3. a Server-role artifact (name-tokened "Server") produces latest-server.json,
#      and NEVER leaks into latest.json's platforms (WI-3696/WI-4404 separation).
#   4. no Server-role artifact in the set ⇒ latest-server.json is NOT written at all
#      (never an empty-platforms manifest that reads as false "up to date").
#   5. PAPERCUSP_UPDATE_BASE_URL unset ⇒ the emitted url carries the obviously-
#      invalid placeholder scheme, never a plausible-but-wrong url.
#   6. MERGE MODE across versions drops every non-overlaid stale platform key,
#      loudly, rather than emitting a new top-level version with old URLs.
#
#   bash bin/lib/gen-latest-manifest.selftest.sh      # exit 0 = PASS, 1 = FAIL
#
# Why a bash self-test and not Vitest: the unit under test is bash + an embedded
# python3 block. The desktop package tests its sourced bash helpers this way (see
# release-artifacts.selftest.sh); this submodule is not part of the operator's
# hoisted vitest workspace.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=gen-latest-manifest.sh
source "$DIR/gen-latest-manifest.sh"
set +e   # this self-test owns its own exit codes (some asserts intentionally fail a call)

command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 unavailable"; exit 0; }

FAILS=0
ok()  { echo "  ✓ $*"; }
bad() { echo "  ✗ $*"; FAILS=$((FAILS + 1)); }

WORK="$(mktemp -d /tmp/genlatest-selftest.XXXXXX)"
VER="9.9.9"
cleanup() {
  rm -rf "$WORK"
  for ch in alpha beta stable nightly; do
    local tag; tag="$(desktop_release_tag "$VER" "$ch" 2>/dev/null)"
    [[ -n "$tag" ]] || continue
    rm -f "$(gen_latest_manifest_json_path "$tag")" \
          "$(gen_latest_manifest_server_json_path "$tag")" \
          "$(gen_latest_manifest_notes_path "$tag")"
  done
}
trap cleanup EXIT

echo "gen-latest-manifest self-test (version=$VER)"

# 1) tag convention matches apps/operator/app/api/updates/manifest/route.ts.
[[ "$(desktop_release_tag "$VER" alpha)"  == "desktop-v${VER}-alpha" ]] && ok "alpha tag"  || bad "alpha tag mismatch"
[[ "$(desktop_release_tag "$VER" beta)"   == "desktop-v${VER}-beta"  ]] && ok "beta tag"   || bad "beta tag mismatch"
[[ "$(desktop_release_tag "$VER" stable)" == "desktop-v${VER}"       ]] && ok "stable tag" || bad "stable tag mismatch"
# `nightly` used to be this check's example of an unknown channel; it became a
# real (side-by-side) channel with the channel model, so the probe moved to a
# name that is genuinely not one. Section 6 below covers nightly properly.
if desktop_release_tag "$VER" insider >/dev/null 2>&1; then
  bad "an unknown channel should be rejected, but desktop_release_tag succeeded"
else
  ok "an unknown channel is rejected"
fi

# 2) GUI-only cut: one Linux AppImage + its .sig.
GUI_APPIMAGE="$WORK/papercusp-test_${VER}_amd64.AppImage"
GUI_SIG="$WORK/papercusp-test_${VER}_amd64.AppImage.sig"
: > "$GUI_APPIMAGE"; printf 'gui-signature' > "$GUI_SIG"

TAG_GUI="$(desktop_release_tag "$VER" alpha)"
PAPERCUSP_UPDATE_BASE_URL="https://example.com/releases" \
  gen_latest_manifest "$VER" alpha "$TAG_GUI" "$GUI_APPIMAGE" "$GUI_SIG" >/dev/null 2>&1

GUI_JSON="$(gen_latest_manifest_json_path "$TAG_GUI")"
GUI_SERVER_JSON="$(gen_latest_manifest_server_json_path "$TAG_GUI")"
if [[ -f "$GUI_JSON" ]]; then
  ok "latest.json written for a GUI-only cut"
  python3 - "$GUI_JSON" <<'PY' && ok "linux-x86_64 entry has the right signature+url" || bad "linux-x86_64 entry shape wrong"
import json, sys
m = json.load(open(sys.argv[1]))
p = m["platforms"]["linux-x86_64"]
assert p["signature"] == "gui-signature", p["signature"]
assert p["url"] == "https://example.com/releases/desktop-v9.9.9-alpha/papercusp-test_9.9.9_amd64.AppImage", p["url"]
PY
else
  bad "latest.json was not written for a GUI-only cut"
fi
[[ -f "$GUI_SERVER_JSON" ]] && bad "latest-server.json written despite no Server artifact (should not exist)" \
  || ok "no Server artifact ⇒ latest-server.json NOT written (4)"

# 2b) ARM-only cut: an aarch64 AppImage must produce ONLY the ARM key. The old
#     producer first inserted this same artifact as linux-x86_64 and then added
#     linux-aarch64, so both keys pointed at identical ARM bytes.
ARM_APPIMAGE="$WORK/papercusp-test_${VER}_aarch64.AppImage"
ARM_SIG="$WORK/papercusp-test_${VER}_aarch64.AppImage.sig"
: > "$ARM_APPIMAGE"; printf 'arm-signature' > "$ARM_SIG"
TAG_ARM="$(desktop_release_tag "$VER" nightly)"
PAPERCUSP_UPDATE_BASE_URL="https://example.com/releases" \
  gen_latest_manifest "$VER" nightly "$TAG_ARM" "$ARM_APPIMAGE" "$ARM_SIG" >/dev/null 2>&1
ARM_JSON="$(gen_latest_manifest_json_path "$TAG_ARM")"
python3 - "$ARM_JSON" <<'PY' && ok "aarch64 AppImage emits only linux-aarch64" || bad "aarch64 AppImage was classified as multiple Linux architectures"
import json, sys
m = json.load(open(sys.argv[1]))
assert sorted(m["platforms"]) == ["linux-aarch64"], m["platforms"]
p = m["platforms"]["linux-aarch64"]
assert p["signature"] == "arm-signature", p
assert p["url"].endswith("papercusp-test_9.9.9_aarch64.AppImage"), p
PY

# 2c) Mixed x86+ARM cut: each artifact keeps its own key and URL.
TAG_ARCH_MIX="$(desktop_release_tag "$VER" beta)"
PAPERCUSP_UPDATE_BASE_URL="https://example.com/releases" \
  gen_latest_manifest "$VER" beta "$TAG_ARCH_MIX" "$GUI_APPIMAGE" "$GUI_SIG" "$ARM_APPIMAGE" "$ARM_SIG" >/dev/null 2>&1
ARCH_MIX_JSON="$(gen_latest_manifest_json_path "$TAG_ARCH_MIX")"
python3 - "$ARCH_MIX_JSON" <<'PY' && ok "mixed x86_64+aarch64 AppImages retain distinct platform entries" || bad "mixed Linux architectures were conflated"
import json, sys
m = json.load(open(sys.argv[1]))
p = m["platforms"]
assert sorted(p) == ["linux-aarch64", "linux-x86_64"], p
assert p["linux-x86_64"]["signature"] == "gui-signature", p
assert p["linux-x86_64"]["url"].endswith("papercusp-test_9.9.9_amd64.AppImage"), p
assert p["linux-aarch64"]["signature"] == "arm-signature", p
assert p["linux-aarch64"]["url"].endswith("papercusp-test_9.9.9_aarch64.AppImage"), p
PY

# 3) mixed cut: GUI Linux AppImage + Server Linux AppImage ⇒ both manifests, no
#    cross-leak (WI-3696/WI-4404).
SRV_APPIMAGE="$WORK/Papercusp_Server_${VER}_amd64.AppImage"
SRV_SIG="$WORK/Papercusp_Server_${VER}_amd64.AppImage.sig"
: > "$SRV_APPIMAGE"; printf 'server-signature' > "$SRV_SIG"

TAG_MIX="$(desktop_release_tag "$VER" beta)"
PAPERCUSP_UPDATE_BASE_URL="https://example.com/releases" \
  gen_latest_manifest "$VER" beta "$TAG_MIX" "$GUI_APPIMAGE" "$GUI_SIG" "$SRV_APPIMAGE" "$SRV_SIG" >/dev/null 2>&1

MIX_JSON="$(gen_latest_manifest_json_path "$TAG_MIX")"
MIX_SERVER_JSON="$(gen_latest_manifest_server_json_path "$TAG_MIX")"
if [[ -f "$MIX_JSON" && -f "$MIX_SERVER_JSON" ]]; then
  ok "mixed GUI+Server cut writes both latest.json and latest-server.json"
  python3 - "$MIX_JSON" "$MIX_SERVER_JSON" <<'PY' && ok "no cross-leak between GUI/Server manifests" || bad "GUI/Server manifests leaked into each other"
import json, sys
gui = json.load(open(sys.argv[1]))
srv = json.load(open(sys.argv[2]))
assert "Server" not in gui["platforms"]["linux-x86_64"]["url"], gui["platforms"]["linux-x86_64"]["url"]
assert "Server" in srv["platforms"]["linux-x86_64"]["url"], srv["platforms"]["linux-x86_64"]["url"]
assert srv["platforms"]["linux-x86_64"]["signature"] == "server-signature"
PY
else
  bad "mixed cut did not write both manifests (gui=$([[ -f "$MIX_JSON" ]] && echo y || echo n), server=$([[ -f "$MIX_SERVER_JSON" ]] && echo y || echo n))"
fi

# 4) A signed normalized Server DiskSpan zip is a Windows updater artifact.
# It must replace a same-version stale stub entry with its encoded ZIP URL and
# ZIP signature.
BASE_SERVER_ZIP="$WORK/base-server-zip.json"
cat > "$BASE_SERVER_ZIP" <<JSON
{ "version": "$VER", "channel": "stable", "notes": "x", "pub_date": "2026-01-01T00:00:00Z",
  "platforms": { "windows-x86_64": { "signature": "OLD-stub-sig", "url": "https://example.com/releases/desktop-v${VER}/Papercusp%20Server_${VER}_x64-setup.exe" } } }
JSON
SERVER_ZIP="$WORK/Papercusp Server_${VER}_x64-setup.zip"
SERVER_ZIP_SIG="$SERVER_ZIP.sig"
: > "$SERVER_ZIP"; printf 'server-zip-signature' > "$SERVER_ZIP_SIG"
TAG_SERVER_ZIP="$(desktop_release_tag "$VER" stable)"
SERVER_ZIP_JSON="$(gen_latest_manifest_server_json_path "$TAG_SERVER_ZIP")"
printf '%s\n' '{"stale":true}' > "$SERVER_ZIP_JSON"
GEN_LATEST_MANIFEST_MERGE_SERVER_JSON="$BASE_SERVER_ZIP" \
PAPERCUSP_UPDATE_BASE_URL="https://example.com/releases" \
  gen_latest_manifest "$VER" stable "$TAG_SERVER_ZIP" "$SERVER_ZIP" >/dev/null 2>&1
python3 - "$SERVER_ZIP_JSON" "$VER" <<'PY' && ok "normalized Server zip replaces stale Windows stub with signed updater entry" || bad "normalized Server zip was not emitted as a signed Windows updater entry"
import json, sys
version = sys.argv[2]
entry = json.load(open(sys.argv[1]))["platforms"]["windows-x86_64"]
assert entry["url"].endswith(f"Papercusp%20Server_{version}_x64-setup.zip"), entry
assert entry["signature"] == "server-zip-signature", entry
PY

# 5) MERGE MODE (EI-18111560213741904): publishing a SECOND platform onto an
#    already-published manifest must overlay its own entry while carrying every
#    OTHER platform key through byte-for-byte untouched (never regenerated,
#    never re-signed) — this is what lets bin/publish-platform-incremental.sh
#    add mac onto an already-live linux release without touching linux's entry.
BASE_JSON="$WORK/base-latest.json"
cat > "$BASE_JSON" <<JSON
{ "version": "$VER", "channel": "alpha", "notes": "x", "pub_date": "2026-01-01T00:00:00Z",
  "platforms": { "linux-x86_64": { "signature": "ORIGINAL-linux-sig", "url": "https://example.com/releases/desktop-v${VER}-alpha/original-linux.AppImage" } } }
JSON
MAC_TARGZ="$WORK/Papercusp.app.tar.gz"
MAC_SIG="$WORK/Papercusp.app.tar.gz.sig"
: > "$MAC_TARGZ"; printf 'mac-signature' > "$MAC_SIG"

TAG_MERGE="$(desktop_release_tag "$VER" alpha)"   # SAME tag as test (2) — deliberately re-merges onto its own prior output too
GEN_LATEST_MANIFEST_MERGE_GUI_JSON="$BASE_JSON" \
PAPERCUSP_UPDATE_BASE_URL="https://example.com/releases" \
  gen_latest_manifest "$VER" alpha "$TAG_MERGE" "$MAC_TARGZ" "$MAC_SIG" >/dev/null 2>&1

MERGED_JSON="$(gen_latest_manifest_json_path "$TAG_MERGE")"
if [[ -f "$MERGED_JSON" ]]; then
  python3 - "$MERGED_JSON" <<'PY' && ok "merge mode: new platform added, base platform untouched" || bad "merge mode: base platform was NOT carried through byte-for-byte"
import json, sys
m = json.load(open(sys.argv[1]))
p = m["platforms"]
assert p["linux-x86_64"]["signature"] == "ORIGINAL-linux-sig", p["linux-x86_64"]
assert p["linux-x86_64"]["url"] == "https://example.com/releases/desktop-v9.9.9-alpha/original-linux.AppImage", p["linux-x86_64"]
assert "darwin-x86_64" in p and p["darwin-x86_64"]["signature"] == "mac-signature", p.get("darwin-x86_64")
assert "darwin-aarch64" in p, p
PY
else
  bad "merge mode: manifest was not written"
fi

# 6) CROSS-VERSION MERGE: starting a new release with only one ready platform
# must not carry the previous release's other platform URLs into the new
# top-level version. Those keys are absent until their own artifacts are ready.
CROSS_OLD_VER="9.9.8"
CROSS_GUI_BASE="$WORK/base-cross-version-gui.json"
CROSS_SERVER_BASE="$WORK/base-cross-version-server.json"
cat > "$CROSS_GUI_BASE" <<JSON
{ "version": "$CROSS_OLD_VER", "channel": "alpha",
  "platforms": { "linux-x86_64": { "signature": "OLD-linux-sig", "url": "https://example.com/releases/desktop-v${CROSS_OLD_VER}-alpha/old-linux.AppImage" } } }
JSON
cat > "$CROSS_SERVER_BASE" <<JSON
{ "version": "$CROSS_OLD_VER", "channel": "alpha",
  "platforms": { "windows-x86_64": { "signature": "OLD-server-sig", "url": "https://example.com/releases/desktop-v${CROSS_OLD_VER}-alpha/old-server-setup.exe" } } }
JSON
rm -f "$MERGED_JSON" "$(gen_latest_manifest_server_json_path "$TAG_MERGE")"
CROSS_OUTPUT="$(
  GEN_LATEST_MANIFEST_MERGE_GUI_JSON="$CROSS_GUI_BASE" \
  GEN_LATEST_MANIFEST_MERGE_SERVER_JSON="$CROSS_SERVER_BASE" \
  PAPERCUSP_UPDATE_BASE_URL="https://example.com/releases" \
    gen_latest_manifest "$VER" alpha "$TAG_MERGE" "$MAC_TARGZ" "$MAC_SIG" "$SRV_APPIMAGE" "$SRV_SIG" 2>&1
)"
CROSS_RC=$?
CROSS_SERVER_JSON="$(gen_latest_manifest_server_json_path "$TAG_MERGE")"
if [[ "$CROSS_RC" -eq 0 && -f "$MERGED_JSON" && -f "$CROSS_SERVER_JSON" ]] && \
  python3 - "$MERGED_JSON" "$CROSS_SERVER_JSON" <<'PY'
import json, sys
gui = json.load(open(sys.argv[1]))
srv = json.load(open(sys.argv[2]))
assert gui["version"] == "9.9.9", gui["version"]
assert "linux-x86_64" not in gui["platforms"], gui["platforms"]
assert "darwin-x86_64" in gui["platforms"], gui["platforms"]
assert srv["version"] == "9.9.9", srv["version"]
assert "windows-x86_64" not in srv["platforms"], srv["platforms"]
assert "linux-x86_64" in srv["platforms"], srv["platforms"]
PY
then
  if grep -q "WARNING: latest.json merge dropped stale platform linux-x86_64" <<<"$CROSS_OUTPUT" && \
    grep -q "WARNING: latest-server.json merge dropped stale platform windows-x86_64" <<<"$CROSS_OUTPUT"; then
    ok "cross-version merge drops stale GUI/Server platform keys and warns loudly"
  else
    bad "cross-version merge dropped stale keys without the expected warnings"
  fi
else
  bad "cross-version merge did not produce version-consistent manifests (rc=$CROSS_RC)"
fi

# 7) PAPERCUSP_UPDATE_BASE_URL unset ⇒ obviously-invalid placeholder, never a
#    plausible-but-wrong url.
TAG_NOBASE="$(desktop_release_tag "$VER" stable)"
( unset PAPERCUSP_UPDATE_BASE_URL; gen_latest_manifest "$VER" stable "$TAG_NOBASE" "$GUI_APPIMAGE" "$GUI_SIG" >/dev/null 2>/dev/null )
NOBASE_JSON="$(gen_latest_manifest_json_path "$TAG_NOBASE")"
if [[ -f "$NOBASE_JSON" ]] && grep -q "papercusp-update-base-unset://SET-PAPERCUSP_UPDATE_BASE_URL" "$NOBASE_JSON"; then
  ok "unset PAPERCUSP_UPDATE_BASE_URL emits the obviously-invalid placeholder url"
else
  bad "unset PAPERCUSP_UPDATE_BASE_URL did not emit the expected placeholder"
fi


# ── 6. CHANNEL MODEL: tags, feed paths, strictness ──────────────────────────
# Mirrors @papercusp/tauri-release-kit's ChannelRegistry. The load-bearing
# property is that `nightly` — a SIDE-BY-SIDE build with its own bundle id and
# data home — never writes the permanent root manifest, which every installed
# copy of the MAIN app polls forever.
echo
echo "channel model"

for pair in "alpha:desktop-v${VER}-alpha" "beta:desktop-v${VER}-beta" \
            "nightly:desktop-v${VER}-nightly" "stable:desktop-v${VER}"; do
  ch="${pair%%:*}"; want="${pair#*:}"
  got="$(desktop_release_tag "$VER" "$ch" 2>/dev/null)"
  if [[ "$got" == "$want" ]]; then ok "tag $ch -> $got"
  else bad "tag $ch: expected '$want', got '$got'"; fi
done

if desktop_release_tag "$VER" bogus >/dev/null 2>&1; then
  bad "desktop_release_tag accepted an unknown channel"
else
  ok "desktop_release_tag rejects an unknown channel"
fi

for ch in alpha beta stable; do
  got="$(desktop_channel_feed_paths "$ch" | tr '\n' ' ')"
  if [[ "$got" == "$ch/latest.json latest.json " ]]; then
    ok "$ch publishes its own feed AND the root manifest, root LAST"
  else
    bad "$ch feed paths: got '$got'"
  fi
done

# THE ONE THAT MATTERS: a side-by-side channel must never touch the root.
got="$(desktop_channel_feed_paths nightly | tr '\n' ' ')"
if [[ "$got" == "nightly/latest.json " ]]; then
  ok "nightly publishes ONLY its own feed — never the permanent root address"
else
  bad "nightly feed paths: expected 'nightly/latest.json ', got '$got'"
fi
nightly_paths="$(desktop_channel_feed_paths nightly || true)"
if grep -qx 'latest.json' <<<"$nightly_paths"; then
  bad "nightly would publish to the root manifest — every installed app polls it"
else
  ok "nightly emits no bare 'latest.json' key"
fi

got="$(desktop_channel_feed_paths stable latest-server.json | tr '\n' ' ')"
if [[ "$got" == "stable/latest-server.json latest-server.json " ]]; then
  ok "a custom manifest name flows through both legs"
else
  bad "custom manifest name: got '$got'"
fi

# An unknown channel must emit NOTHING before failing: the caller reads this on a
# process substitution, where a nonzero return does not abort its read loop.
got="$(desktop_channel_feed_paths bogus 2>/dev/null)"
rc=$?
if [[ "$rc" -ne 0 && -z "$got" ]]; then
  ok "an unknown channel fails closed — nonzero AND no path emitted"
else
  bad "unknown channel: rc=$rc output='$got' (must be nonzero with empty output)"
fi

for ch in beta stable; do
  if desktop_channel_is_strict "$ch"; then ok "$ch is strict"; else bad "$ch should be strict"; fi
done
for ch in alpha nightly; do
  if desktop_channel_is_strict "$ch"; then bad "$ch should be lenient"; else ok "$ch is lenient"; fi
done
if desktop_channel_is_strict bogus; then
  ok "an unknown channel defaults to STRICT (fails closed)"
else
  bad "an unknown channel must default to strict"
fi

# ── desktop_channel_identity / desktop_channel_is_side_by_side (WI-36794) ─────
#
# The shell table is a MIRROR of bin/release.config.ts. A mirror nobody compares
# is just a second source of truth, so every value below is cross-checked against
# the declaration it mirrors rather than retyped here.
RELEASE_CONFIG="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/release.config.ts"
declared_base_home="$(sed -n "s/.*dataHomeDirName:[[:space:]]*'\([^']*\)'.*/\1/p" "$RELEASE_CONFIG" | head -1)"
declared_suffix="$(sed -n "s/.*identitySuffix:[[:space:]]*'\([^']*\)'.*/\1/p" "$RELEASE_CONFIG" | head -1)"

if [[ -n "$declared_base_home" && -n "$declared_suffix" ]]; then
  ok "release.config.ts declares dataHomeDirName='$declared_base_home' identitySuffix='$declared_suffix'"
else
  bad "could not read dataHomeDirName/identitySuffix out of $RELEASE_CONFIG (the cross-check below would be vacuous)"
fi

if [[ "$DESKTOP_BASE_DATA_HOME_DIR_NAME" == "$declared_base_home" ]]; then
  ok "DESKTOP_BASE_DATA_HOME_DIR_NAME matches release.config.ts"
else
  bad "DESKTOP_BASE_DATA_HOME_DIR_NAME='$DESKTOP_BASE_DATA_HOME_DIR_NAME' != release.config.ts '$declared_base_home'"
fi

# An UPDATE LANE must stay un-stamped and un-overlaid. A stable build that
# started carrying a channel stamp is a regression, not a nicety: every build
# ever cut is un-stamped, and workspaces::resolve_data_home_dir_name() treats an
# absent stamp as the existing ~/.papercusp precisely so they keep working.
for ch in alpha beta stable; do
  desktop_channel_identity "$ch"
  if [[ "${#DESKTOP_CHANNEL_BUILD_CFG[@]}" -eq 0 && "${#DESKTOP_CHANNEL_BUILD_ENV[@]}" -eq 0 ]]; then
    ok "$ch (update-lane) gets no overlay and no stamps"
  else
    bad "$ch emitted cfg='${DESKTOP_CHANNEL_BUILD_CFG[*]}' env='${DESKTOP_CHANNEL_BUILD_ENV[*]}' — an update lane must stay un-stamped"
  fi
  if desktop_channel_is_side_by_side "$ch"; then bad "$ch must not be side-by-side"; else ok "$ch is an update lane"; fi
done

desktop_channel_identity nightly
if [[ "${DESKTOP_CHANNEL_BUILD_CFG[*]}" == "--config src-tauri/tauri.nightly.conf.json" ]]; then
  ok "nightly applies its identity overlay"
else
  bad "nightly overlay: got '${DESKTOP_CHANNEL_BUILD_CFG[*]}'"
fi
want_env="PAPERCUSP_CHANNEL=${declared_suffix} PAPERCUSP_CHANNEL_DATA_HOME=${declared_base_home}-${declared_suffix}"
if [[ "${DESKTOP_CHANNEL_BUILD_ENV[*]}" == "$want_env" ]]; then
  ok "nightly bakes both stamps, derived from release.config.ts"
else
  bad "nightly stamps: got '${DESKTOP_CHANNEL_BUILD_ENV[*]}' want '$want_env'"
fi
# The invariant resolveChannelIdentity() throws on, restated where the shell can
# break it: a side-by-side data home identical to the base is the whole bug.
if [[ "${declared_base_home}-${declared_suffix}" != "$declared_base_home" ]]; then
  ok "the nightly data home is distinct from the base app's"
else
  bad "nightly resolves the BASE data home — it would write to the state of the app in daily use"
fi
if desktop_channel_is_side_by_side nightly; then ok "nightly is side-by-side"; else bad "nightly must be side-by-side"; fi

# Fail-closed on an unknown channel, in BOTH functions. desktop_channel_identity
# must also leave no half-populated arrays behind for a caller that ignores rc.
if desktop_channel_identity bogus 2>/dev/null; then
  bad "desktop_channel_identity accepted an unknown channel"
else
  if [[ "${#DESKTOP_CHANNEL_BUILD_CFG[@]}" -eq 0 && "${#DESKTOP_CHANNEL_BUILD_ENV[@]}" -eq 0 ]]; then
    ok "an unknown channel fails closed — nonzero AND both arrays empty"
  else
    bad "unknown channel left cfg='${DESKTOP_CHANNEL_BUILD_CFG[*]}' env='${DESKTOP_CHANNEL_BUILD_ENV[*]}'"
  fi
fi
if desktop_channel_is_side_by_side bogus 2>/dev/null; then
  ok "an unknown channel defaults to SIDE-BY-SIDE (fails closed — callers refuse legs on it)"
else
  bad "an unknown channel must default to side-by-side"
fi

echo
if [[ "$FAILS" -eq 0 ]]; then
  echo "gen-latest-manifest self-test: ALL PASS"
  exit 0
else
  echo "gen-latest-manifest self-test: $FAILS FAILED"
  exit 1
fi
