#!/usr/bin/env bash
# build-appimage.sh — WI-2918.
#
# THE PROBLEM
# -----------
# `tauri build --bundles appimage` runs linuxdeploy across the WHOLE AppDir.
# linuxdeploy recursively "deploys dependencies" for every ELF it finds — which
# historically included our large, self-contained sidecar tree (bundled node,
# native addons, agent binaries, …). It hit
# `patchelf ... cannot find section .dynamic` on the static/foreign binaries and
# then hard-CRASHES: `terminate ... Failed to run ldd: exited with code 1` (exit
# 127). No .AppImage is produced. Because `appimage` is one of the tauri.conf
# bundle targets, that non-zero exit ALSO fails the whole `tauri build`, blocking
# the entire Linux release cut — not just the updater artifact.
#
# THE FIX
# -------
# By the time linuxdeploy crashes it has ALREADY done the useful part: the AppDir
# is complete (main binary + all gtk/webkit libs deployed into usr/lib + AppRun +
# desktop + icon). Its ONLY remaining (broken) work was the pointless ELF-scan of
# the self-contained sidecar — which must not be patchelf'd anyway. So we let tauri
# create the AppDir (ignore the linuxdeploy crash), then finish the job ourselves:
# supply the root icon appimagetool wants, and package the AppDir with appimagetool
# directly (appimagetool just squashfs-packs the tree). The GUI AppImage is now a
# thin shell: it carries only the shared SPA under sidecar/spa and attaches to the
# separately installed Papercusp Server.
#
# Env (inherited from release-local.sh; all optional here):
#   PAPERCUSP_BUILD_SHA / PAPERCUSP_BUILD_VERSION  — build provenance (baked in)
#   TAURI_SIGNING_PRIVATE_KEY / _PASSWORD          — sign the AppImage for the updater
set -uo pipefail   # deliberately NOT -e: the tauri appimage step is EXPECTED to fail
ORCHESTRATOR_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESK="${PAPERCUSP_DESKTOP_TARGET_ROOT:-$(cd "$ORCHESTRATOR_HERE/.." && pwd)}"
DESK="$(cd "$DESK" && pwd)"
cd "$DESK"

# ── IDENTITY-POLICY COMPATIBILITY PREFLIGHT. D-112 no longer requires owner
# name/email. Keep the shared audit entrypoint before expensive work so older
# cutters remain compatible and future early machine-policy checks have one home.
AUDIT_PY="$ORCHESTRATOR_HERE/audit-release-bundle.py"
python3 "$AUDIT_PY" --owner-preflight \
  || { echo "ERROR: identity-policy preflight failed — refusing to start AppImage build" >&2; exit 2; }

# Claim a target-dir slot before Cargo metadata or any release-tree cleanup. This
# direct entrypoint is also invoked outside release-local.sh, so it must establish
# the same per-instance isolation itself (EI-217146).
# shellcheck source=lib/claim-target-dir.sh
. "$ORCHESTRATOR_HERE/lib/claim-target-dir.sh" || {
  echo "FATAL: cannot source bin/lib/claim-target-dir.sh — refusing to build without target-dir isolation" >&2
  exit 1
}

CT="$(papercusp_cargo_target_root "$DESK/src-tauri")" || exit $?
# shellcheck source=lib/release-artifacts.sh
. "$ORCHESTRATOR_HERE/lib/release-artifacts.sh" || {
  echo "FATAL: cannot source bin/lib/release-artifacts.sh — refusing to build without release-retention guards" >&2
  exit 1
}
APPIMG_DIR="$CT/release/bundle/appimage"
VERSION="$(python3 -c 'import json;print(json.load(open("src-tauri/tauri.conf.json"))["version"])')"
OUT="$APPIMG_DIR/Papercusp_GUI_${VERSION}_amd64.AppImage"

# ── CHANNEL IDENTITY (WI-36794) ───────────────────────────────────────────────
# This is a SEPARATE bash process from release-local.sh, and arrays do not cross
# a process boundary — so this leg derives the channel identity itself, through
# the same chokepoint, rather than being handed half of it. release-local.sh
# passes the channel in PAPERCUSP_RELEASE_CHANNEL.
#
# Deliberately NOT named PAPERCUSP_CHANNEL: that is the BAKED STAMP, and an
# ambiently-exported one would be inherited by every build in the process tree,
# including ones that never receive the matching `--config` overlay. That
# combination is exactly what workspaces::verify_channel_identity() refuses to
# boot on. "Which channel is this cut" and "what identity is baked into THIS
# binary" are different questions and get different variable names.
#
# Unset ⇒ no overlay, no stamps: the base app, byte-for-byte what this script
# built before channels existed. That is the safe default — an un-stamped build
# resolves the existing ~/.papercusp.
DESKTOP_CHANNEL_BUILD_CFG=()
DESKTOP_CHANNEL_BUILD_ENV=()
if [ -n "${PAPERCUSP_RELEASE_CHANNEL:-}" ]; then
  # shellcheck source=lib/gen-latest-manifest.sh
  . "$ORCHESTRATOR_HERE/lib/gen-latest-manifest.sh" || {
    echo "FATAL: cannot source bin/lib/gen-latest-manifest.sh — refusing to build a channel bundle without its identity" >&2; exit 1; }
  desktop_channel_identity "$PAPERCUSP_RELEASE_CHANNEL" || {
    echo "FATAL: unknown channel '$PAPERCUSP_RELEASE_CHANNEL' — refusing to build" >&2; exit 1; }
  if [ "${#DESKTOP_CHANNEL_BUILD_CFG[@]}" -gt 0 ]; then
    echo "==> channel '$PAPERCUSP_RELEASE_CHANNEL': ${DESKTOP_CHANNEL_BUILD_CFG[*]} + ${DESKTOP_CHANNEL_BUILD_ENV[*]}"
  fi
fi

# 0. PURGE any stale AppDir from a PRIOR build BEFORE tauri runs (WI-4736 / EI-11730).
#    A leftover *.AppDir from an OLDER sidecar can ship the mac-VM sudo/login passwords +
#    build-box identity inside its rendered docs, even though the .deb (packed straight
#    from the clean sidecar in the same cut) carries NONE of it.
#    NOTE (su-b0fbf 2026-07-14): wiping the AppDir is NECESSARY BUT NOT SUFFICIENT — see
#    step 0b. In 0.0.9 cut#3d a mtime-FRESH AppDir (built AFTER this purge) still carried
#    339 leaking files, because `tauri build --bundles appimage` REFILLS the AppDir from
#    the staged resource intermediate under $CT/release/ (step 0b), NOT from
#    src-tauri/sidecar/ directly. The fail-closed identity scan in step 3d is the backstop.
echo "==> purging any stale AppDir under $APPIMG_DIR (WI-4736: a reused stale AppDir ships an un-pruned/leaky sidecar)"
release_artifacts_guarded_delete "$APPIMG_DIR"/*.AppDir || exit 1

# 0b. Opportunistic DISK HYGIENE (NOT the leak fix — see step 2b). The tauri release
#     resource-staging dirs $CT/release/{sidecar,seed,resources} are copy-into-never-delete,
#     so they accumulate the union of past cuts (this box's $CT/release/sidecar was 11G,
#     holding a month-stale code-server + meridian-host). Wiping them reclaims ~15G on a
#     disk-pressured builder. NOTE (su-b0fbf 2026-07-14, EI-11730): wiping these does NOT by
#     itself stop the AppImage leak — proven, a fresh AppDir built AFTER this wipe still
#     carried 339 files. tauri sources the AppDir sidecar from an opaque path (two relocated
#     target trees are in play: $CT -> /mnt/data/.../cargo-target and the src-tauri/target
#     symlink -> /mnt/data/.../papercusp-desktop-src-tauri-target). The guaranteed fix is the
#     correct-by-construction force-sync in step 2b, below.
echo "==> purging tauri resource-staging intermediates under $CT/release (EI-11730: disk hygiene, reclaims ~15G — does NOT by itself fix the leak; see step 2b)"
rm -rf "$CT/release/sidecar" "$CT/release/seed" "$CT/release/resources" 2>/dev/null || true

# Strip build-box $HOME from the Rust binary's embedded source paths, BEFORE the
# `tauri build` below compiles it. This script used to own no copy of the flag and
# relied entirely on inheriting RUSTFLAGS from release-local.sh — true for a release
# cut, false for a DIRECT `bin/build-appimage.sh` run, which then failed its own
# identity gate ~10 min in with a message pointing at the sidecar rather than at the
# missing flag (measured 2026-08-10: 691 build-box-$HOME strings standalone vs 0 via
# the release cut). Sourcing it here makes the artifact identical from either entry
# point; the helper is a no-op when a parent already exported a remap, so the release
# path is unchanged and its cargo cache is not busted.
# shellcheck source=lib/rust-path-remap.sh
. "$ORCHESTRATOR_HERE/lib/rust-path-remap.sh" || {
  echo "FATAL: cannot source bin/lib/rust-path-remap.sh — refusing to build a bundle that would embed build-box paths" >&2; exit 1; }
papercusp_export_rust_path_remap
# Cargo drops target.*.rustflags when RUSTFLAGS is present; carry the release
# Linux linker choice in the same environment as the path remap.
papercusp_export_rust_lld linux

# 1. Let tauri build the AppDir + deploy the gtk/webkit libs. linuxdeploy crashes
#    at the sidecar ELF-scan (see header) — we IGNORE that and finish below.
#
#    Invoke the CLI through `npx -p @tauri-apps/cli@<pinned>`, exactly as every leg
#    in release-local.sh does — NOT `npm run tauri`. The npm-script form resolves
#    `tauri` from node_modules/.bin, which exists only where the desktop workspace's
#    devDependencies were installed; the RELEASE checkout (papercup-release) never
#    installs them, so the 0.0.13 cut died right here with `sh: 1: tauri: not found`
#    and then "FATAL: no AppDir" — a whole release lost to a build-host install
#    detail. npx fetches the pinned CLI on demand, so this step no longer depends
#    on which checkout it runs in.
TAURI_CLI_VERSION="${PAPERCUSP_TAURI_CLI_VERSION:-${TAURI_CLI_VERSION:-2.11.0}}"
echo "==> tauri build --bundles appimage (the linuxdeploy sidecar-scan crash is EXPECTED and ignored)"
PAPERCUSP_BUILD_SHA="${PAPERCUSP_BUILD_SHA:-}" PAPERCUSP_BUILD_VERSION="${PAPERCUSP_BUILD_VERSION:-$VERSION}" \
  env "${DESKTOP_CHANNEL_BUILD_ENV[@]}" \
  npx --yes -p @tauri-apps/cli@"$TAURI_CLI_VERSION" tauri build --bundles appimage \
  "${DESKTOP_CHANNEL_BUILD_CFG[@]}" \
  || echo "   (tauri appimage step exited non-zero as expected — finishing with appimagetool)"

# Tauri may now finish successfully instead of crashing after creating the AppDir.
# Its space-named AppImage is still only an INTERMEDIATE: it bypasses the AppDir
# normalization and fail-closed identity scan below. Leaving it beside OUT makes
# the broad release collectors see two same-version candidates and, worse, makes
# the leaky intermediate publishable by iteration order. Purge every same-version
# AppImage before the audited appimagetool packaging step; OUT does not exist yet.
echo "==> purging Tauri-produced same-version AppImage intermediates before audited packaging"
release_artifacts_guarded_delete \
  "$APPIMG_DIR"/*_"$VERSION"_*.AppImage \
  "$APPIMG_DIR"/*_"$VERSION"_*.AppImage.sig \
  || exit 1

# 2. Locate the AppDir tauri produced (GUI bundle).
APPDIR="$(ls -d "$APPIMG_DIR"/*.AppDir 2>/dev/null | grep -vi server | sed -n 1p)"
[ -n "$APPDIR" ] && [ -d "$APPDIR" ] || { echo "FATAL: no AppDir under $APPIMG_DIR — tauri didn't get far enough" >&2; exit 1; }
echo "==> finishing AppDir: $APPDIR"

# 2b. FAIL-CLOSED GUI RESOURCE SYNC (P-007 / D-004).
#     Tauri resource staging is copy-into-never-delete, so a reused target can retain
#     Server bytes even after the base config narrows. Make the shipped AppDir a pure
#     function of the GUI allowlist: mirror ONLY sidecar/spa, remove every sibling under
#     sidecar, and remove the Server-only resources/ and seed/ roots. This preserves the
#     bundled bootstrap SPA while making a stale staged serve.mjs, node runtime, model,
#     rootfs or seed impossible to ship. The finished-artifact audit remains the
#     fail-closed backstop.
APPDIR_SIDECAR="$(ls -d "$APPDIR"/usr/lib/*/sidecar 2>/dev/null | sed -n 1p)"
if [ -z "$APPDIR_SIDECAR" ] || [ ! -d "$APPDIR_SIDECAR" ]; then
  echo "FATAL: no bundled GUI resource root under $APPDIR/usr/lib/*/sidecar — tauri bundle incomplete" >&2; exit 1
fi
LIBDIR="$(dirname "$APPDIR_SIDECAR")"   # $APPDIR/usr/lib/<product>
GUI_SPA_SOURCE="$DESK/src-tauri/sidecar/spa"
APPDIR_SPA="$APPDIR_SIDECAR/spa"
[ -f "$GUI_SPA_SOURCE/index.html" ] || {
  echo "FATAL: GUI SPA source is missing $GUI_SPA_SOURCE/index.html" >&2; exit 1
}
mkdir -p "$APPDIR_SPA"
echo "==> force-syncing the allowlisted GUI SPA into the AppDir"
rsync -a --delete "$GUI_SPA_SOURCE"/ "$APPDIR_SPA"/
while IFS= read -r -d '' _stale_sidecar; do
  release_artifacts_guarded_delete "$_stale_sidecar" || exit 1
done < <(find "$APPDIR_SIDECAR" -mindepth 1 -maxdepth 1 ! -name spa -print0)
release_artifacts_guarded_delete "$LIBDIR/resources" "$LIBDIR/seed" || exit 1
if find "$APPDIR_SIDECAR" -mindepth 1 -maxdepth 1 ! -name spa -print -quit | grep -c . >/dev/null; then
  echo "FATAL: GUI AppDir contains a non-allowlisted sidecar member" >&2; exit 1
fi
echo "   GUI resources now contain only sidecar/spa ($(du -sh "$APPDIR_SPA" 2>/dev/null | cut -f1))"

# 2c. DEPLOY THE GTK/WEBKIT RUNTIME CLOSURE (EI-20075266271803900). ────────────
#     The header above claimed "by the time linuxdeploy crashes it has ALREADY
#     deployed all gtk/webkit libs into usr/lib". THAT PREMISE IS FALSE, measured
#     against the PUBLISHED 0.0.14 AppImage: its usr/lib held exactly ONE .so
#     (libayatana-appindicator3.so.1) and its usr/lib/x86_64-linux-gnu held only
#     webkit2gtk-4.1/{WebKitWebProcess,WebKitNetworkProcess,injected-bundle}. Both
#     of those are things TAURI's own bundler copies by hand — linuxdeploy
#     contributed ZERO libraries, because it crashes at the sidecar ELF-scan
#     BEFORE its deploy phase does anything useful. So the AppImage has NEVER been
#     self-contained: it hard-fails on a box without libwebkit2gtk-4.1-0 with
#       usr/bin/papercusp-desktop: error while loading shared libraries:
#       libwebkit2gtk-4.1.so.0: cannot open shared object file
#     Every clean-room verification missed it because each one installed the .deb
#     FIRST (vmctl updater-e2e literally "installs the existing desktop .deb to
#     provision WebKit/GTK runtime dependencies"), so the AppImage always ran on a
#     host that already had system WebKit.
#
#     THE FIX: run linuxdeploy ourselves against an ISOLATED staging AppDir that
#     contains ONLY the app binary — no sidecar, so the ELF-scan crash cannot
#     happen — then merge the libraries it deployed into the real AppDir. This
#     REUSES linuxdeploy (correct excludelist, $ORIGIN rpath patching) and its gtk
#     plugin (gdk-pixbuf loaders + loaders.cache, gio TLS modules, gschemas,
#     immodules, Adwaita) instead of hand-rolling a dependency walker.
DEPLOY_STAGE="$CT/release/bundle/appimage/.libdeploy-stage"
LD_APPIMG="$HOME/.cache/tauri/linuxdeploy-x86_64.AppImage"
if [ ! -x "$LD_APPIMG" ]; then
  echo "FATAL: $LD_APPIMG missing — cannot deploy the GTK/WebKit closure (step 2c)" >&2; exit 1
fi
echo "==> deploying the GTK/WebKit runtime closure into the AppDir (EI-20075266271803900)"
rm -rf "$DEPLOY_STAGE"; mkdir -p "$DEPLOY_STAGE/usr/share/applications" "$DEPLOY_STAGE/usr/share/icons/hicolor/256x256/apps"
cat > "$DEPLOY_STAGE/usr/share/applications/papercusp-libdeploy.desktop" <<'DESK'
[Desktop Entry]
Type=Application
Name=Papercusp libdeploy
Exec=papercusp-desktop
Icon=papercusp-libdeploy
Categories=Development;
Terminal=false
DESK
# linuxdeploy validates icon resolution, so hand it a real 256x256 from the AppDir.
_ldicon="$(find "$APPDIR/usr/share/icons" -path '*256x256*' -name '*.png' 2>/dev/null | sed -n 1p)"
[ -n "$_ldicon" ] || _ldicon="$(find "$APPDIR/usr/share/icons" -name '*.png' 2>/dev/null | sort -V | tail -1)"
cp "$_ldicon" "$DEPLOY_STAGE/usr/share/icons/hicolor/256x256/apps/papercusp-libdeploy.png"
(
  export PATH="$HOME/.cache/tauri:$PATH" LINUXDEPLOY="$LD_APPIMG" DEPLOY_GTK_VERSION=3
  "$LD_APPIMG" --appdir "$DEPLOY_STAGE" \
    -e "$APPDIR/usr/bin/papercusp-desktop" \
    -d "$DEPLOY_STAGE/usr/share/applications/papercusp-libdeploy.desktop" \
    -i "$DEPLOY_STAGE/usr/share/icons/hicolor/256x256/apps/papercusp-libdeploy.png"
) || echo "   (linuxdeploy exited non-zero — icon/desktop deploy is cosmetic; the library payload is verified below)"
# Merge WITHOUT clobbering the real AppDir's own icons/desktop entries.
cp -an "$DEPLOY_STAGE/usr/lib/." "$APPDIR/usr/lib/" 2>/dev/null || true
[ -d "$DEPLOY_STAGE/usr/share/glib-2.0" ] && mkdir -p "$APPDIR/usr/share" && cp -an "$DEPLOY_STAGE/usr/share/glib-2.0" "$APPDIR/usr/share/" 2>/dev/null
[ -d "$DEPLOY_STAGE/apprun-hooks" ] && cp -an "$DEPLOY_STAGE/apprun-hooks" "$APPDIR/" 2>/dev/null

# linuxdeploy-plugin-gtk derives GIO_EXTRA_MODULES from every module directory it
# sees. We deliberately give linuxdeploy the REAL AppDir executable while asking
# it to assemble libraries in DEPLOY_STAGE, so its generated hook can contain a
# mixture of portable `$APPDIR/...` entries and the real build-host path to the
# final AppDir. Copying that hook verbatim leaked `/home/<builder>/.cargo-target…`
# into the finished AppImage and the release identity gate correctly stopped the
# 0.0.18 cut. Normalize only the exact AppDir prefix: unrelated absolute system
# paths remain visible to the later fail-closed identity scan instead of being
# papered over. Use Python's literal replacement so spaces and sed metacharacters
# in the product/AppDir name cannot corrupt the rewrite.
if [ -d "$APPDIR/apprun-hooks" ]; then
  python3 - "$APPDIR" <<'PY_NORMALIZE_APPIMAGE_HOOKS'
from pathlib import Path
import sys

appdir = Path(sys.argv[1]).resolve()
appdir_literal = str(appdir)
for hook in sorted((appdir / "apprun-hooks").glob("*.sh")):
    before = hook.read_text(encoding="utf-8")
    after = before.replace(appdir_literal, "$APPDIR")
    if after != before:
        hook.write_text(after, encoding="utf-8")
        print(f"   normalized build-root path in {hook.relative_to(appdir)}")
PY_NORMALIZE_APPIMAGE_HOOKS
fi
rm -rf "$DEPLOY_STAGE"

# 2c-ii. DROP GPL-ONLY NON-MEDIA LIBRARIES (open-source-release-2026-09-29 D-013).
#     The installer license leg over the 0.0.25 AppImage found two GPL-only chains
#     outside GStreamer, both deployed by linuxdeploy/Tauri for optional features:
#       - gdk-pixbuf's TIFF loader -> libtiff -> libjbig (GPL-2+). The webview
#         decodes images itself; the pixbuf TIFF loader only serves GTK widgets.
#       - the tray stack libayatana-appindicator3 -> libayatana-indicator3 (GPL-3)
#         + ido3 + dbusmenu. Only the Server role builds a tray, and the Server
#         ships as a .deb that depends on the system library; the GUI AppImage
#         never loads it (libappindicator-sys dlopens on first tray use).
#     Remove the files AND the TIFF loader's loaders.cache block, so gdk-pixbuf
#     does not try to open a loader that is not there.
APPIMAGE_GPL_NON_GST_DROP="${PAPERCUSP_APPIMAGE_GPL_NON_GST_DROP:-libpixbufloader-tiff.so libtiff.so* libjbig.so* libayatana-appindicator3.so* libayatana-indicator3.so* libayatana-ido3-0.4.so* libdbusmenu-glib.so* libdbusmenu-gtk3.so*}"
for _drop in $APPIMAGE_GPL_NON_GST_DROP; do
  find "$APPDIR" \( -type f -o -type l \) -name "$_drop" -delete
done
while IFS= read -r -d '' _pbcache_file; do
  python3 - "$_pbcache_file" <<'PY_DROP_TIFF_LOADER'
import sys
from pathlib import Path
path = Path(sys.argv[1])
blocks = path.read_text(encoding="utf-8").split("\n\n")
kept = [b for b in blocks if "libpixbufloader-tiff.so" not in b]
if len(kept) != len(blocks):
    path.write_text("\n\n".join(kept), encoding="utf-8")
PY_DROP_TIFF_LOADER
done < <(find "$APPDIR" -name loaders.cache -print0)
echo "   GPL non-media libraries dropped (TIFF pixbuf loader, jbig, tray indicator)"

# 2c-gst. BUNDLE THE GSTREAMER PLUGIN CLOSURE (EI-20082216700215037).
#     linuxdeploy deploys WebKitGTK's libgstreamer dependencies but does not copy
#     the element plugins that GStreamer discovers at runtime. On a pristine host
#     that leaves WebKit media with "element appsink not found": the library
#     libgstapp-1.0.so.0 is present, but the appsink element lives in the separate
#     libgstapp.so plugin under gstreamer-1.0/. Copy the build host's plugin set
#     beside the bundled libraries and fail closed if the appsink provider or the
#     scanner is absent. The source override makes the seam testable and supports
#     builders whose multiarch prefix differs from this x86_64 default.
GST_PLUGIN_SOURCE="${PAPERCUSP_GSTREAMER_PLUGIN_DIR:-/usr/lib/x86_64-linux-gnu/gstreamer-1.0}"
GST_PLUGIN_DEST="$APPDIR/usr/lib/gstreamer-1.0"
if [ ! -d "$GST_PLUGIN_SOURCE" ] || [ ! -f "$GST_PLUGIN_SOURCE/libgstapp.so" ]; then
  echo "FATAL: GStreamer plugin source is missing libgstapp.so: $GST_PLUGIN_SOURCE" >&2
  exit 1
fi
mkdir -p "$GST_PLUGIN_DEST"
cp -a "$GST_PLUGIN_SOURCE"/. "$GST_PLUGIN_DEST"/ || {
  echo "FATAL: failed to copy GStreamer plugins into the AppDir" >&2
  exit 1
}

# 2c-gst-0. DROP GPL-LINKED PLUGINS (open-source-release-2026-09-29 P-020, D-003).
#     Papercusp ships under the Elastic License 2.0, which is incompatible with
#     redistributing GPL code. On Ubuntu these plugins link GPL libraries
#     (libavcodec-extra, x264, x265, liba52, libmpeg2, libdvdread/dvdnav,
#     mjpegtools, libsidplay, libcdio, faad2). Removing them before the ELF
#     closure below means their GPL dependencies are never copied either.
#     Cost: the webview cannot decode H.264/H.265/AAC and similar patented
#     codecs from these plugins; the LGPL/BSD plugins (vorbis, opus, vpx, …) stay.
GST_GPL_PLUGINS="${PAPERCUSP_GSTREAMER_GPL_PLUGINS:-libgstlibav.so libgstx264.so libgstx265.so libgsta52dec.so libgstmpeg2dec.so libgstdvdread.so libgstresindvd.so libgstmpeg2enc.so libgstmplex.so libgstsid.so libgstcdio.so libgstfaad.so libgstaasink.so libgstcacasink.so libgstfluidsynthmidi.so libgstdtsdec.so libgstladspa.so libgstteletext.so libgstneonhttpsrc.so libgstspandsp.so libgstcdparanoia.so}"
for _gpl_plugin in $GST_GPL_PLUGINS; do
  rm -f "$GST_PLUGIN_DEST/$_gpl_plugin"
done

GST_SCANNER_SOURCE="${PAPERCUSP_GSTREAMER_SCANNER:-}"
if [ -z "$GST_SCANNER_SOURCE" ]; then
  for _scanner in \
    /usr/lib/x86_64-linux-gnu/gstreamer1.0/gstreamer-1.0/gst-plugin-scanner \
    /usr/libexec/gstreamer-1.0/gst-plugin-scanner; do
    if [ -x "$_scanner" ]; then GST_SCANNER_SOURCE="$_scanner"; break; fi
  done
fi
GST_SCANNER_DEST="$APPDIR/usr/lib/gstreamer1.0/gstreamer-1.0/gst-plugin-scanner"
if [ -z "$GST_SCANNER_SOURCE" ] || [ ! -x "$GST_SCANNER_SOURCE" ]; then
  echo "FATAL: GStreamer plugin scanner is missing" >&2
  exit 1
fi
mkdir -p "$(dirname "$GST_SCANNER_DEST")"
cp -a "$GST_SCANNER_SOURCE" "$GST_SCANNER_DEST" || {
  echo "FATAL: failed to copy the GStreamer plugin scanner into the AppDir" >&2
  exit 1
}

# 2c-gst-i. COPY THE TRANSITIVE PLUGIN ELF CLOSURE.
#     A plugin directory is not self-contained just because its .so files were
#     copied. Each plugin is a separately loaded ELF, and its DT_NEEDED chain is
#     resolved by the dynamic linker at the moment GStreamer discovers it. The
#     old guard checked only that libgstapp.so existed, so libgstopenal.so could
#     ship while libopenal.so.1 was absent and every build still passed.
#
#     Walk the real DT_NEEDED graph rather than using ldd output as a flat list:
#     every library copied here is itself inspected, and each soname is either
#     already in the AppDir, copied from the build host, or rejected. Libraries
#     are placed in usr/lib because AppRun puts that directory first in
#     LD_LIBRARY_PATH. The host-directory override is colon-separated so tests
#     can exercise the exact production walker with a throwaway ELF fixture.
copy_gstreamer_plugin_closure() {
  local _gst_objdump
  _gst_objdump="$(command -v objdump 2>/dev/null || true)"
  if [ -z "$_gst_objdump" ] || [ ! -x "$_gst_objdump" ]; then
    echo "FATAL: objdump is required to resolve the GStreamer plugin ELF closure" >&2
    return 1
  fi

  local _gst_host_dirs="${PAPERCUSP_GSTREAMER_LIBRARY_DIRS:-/usr/lib/x86_64-linux-gnu:/lib/x86_64-linux-gnu:/usr/lib:/lib}"
  local _gst_ldconfig="${PAPERCUSP_GSTREAMER_LDCONFIG:-}"
  local _gst_ldconfig_candidate
  if [ -z "$_gst_ldconfig" ]; then
    for _gst_ldconfig_candidate in \
      "$(command -v ldconfig 2>/dev/null || true)" \
      /usr/sbin/ldconfig \
      /sbin/ldconfig; do
      if [ -n "$_gst_ldconfig_candidate" ] && [ -x "$_gst_ldconfig_candidate" ]; then
        _gst_ldconfig="$_gst_ldconfig_candidate"
        break
      fi
    done
  fi

  # These are the loader/libc components supplied by the Ubuntu baseline. All
  # other dependencies, including libstdc++, libz, and libopenal, must be
  # present in the AppDir or copied into it; allowing those to remain host-only
  # recreates the clean-room failure this closure guard is meant to prevent.
  local _gst_base_libs="ld-linux-x86-64.so.2 libc.so.6 libm.so.6 libpthread.so.0 libdl.so.2 librt.so.1 libutil.so.1 libresolv.so.2 libnsl.so.2 libcrypt.so.1"
  local -a _gst_host_dir_list=()
  local -a _gst_queue=()
  local _gst_current _gst_real _gst_needed _gst_need _gst_candidate _gst_candidate_real
  local _gst_local _gst_host _gst_source_real _gst_filename _gst_target _gst_link
  local _gst_origin _gst_runpaths _gst_runpath
  local -a _gst_runpath_list=()
  local _gst_processed=0
  local _gst_count=0
  IFS=: read -r -a _gst_host_dir_list <<< "$_gst_host_dirs"

  while IFS= read -r -d '' _gst_current; do
    _gst_queue+=("$_gst_current")
  done < <(find "$GST_PLUGIN_DEST" -maxdepth 1 -type f -name 'libgst*.so*' -print0 2>/dev/null)
  [ "${#_gst_queue[@]}" -gt 0 ] || {
    echo "FATAL: no ELF GStreamer plugins were copied into $GST_PLUGIN_DEST" >&2
    return 1
  }

  # Associative keys are canonical real paths, so a library reached through
  # several plugins is inspected once while every edge is still validated.
  declare -A _gst_seen=()
  while [ "${#_gst_queue[@]}" -gt 0 ]; do
    _gst_current="${_gst_queue[0]}"
    _gst_queue=("${_gst_queue[@]:1}")
    _gst_real="$(readlink -f "$_gst_current" 2>/dev/null || true)"
    [ -f "$_gst_real" ] || {
      echo "FATAL: GStreamer closure entry is not a readable file: $_gst_current" >&2
      return 1
    }
    if [ -n "${_gst_seen[$_gst_real]:-}" ]; then
      continue
    fi
    _gst_seen["$_gst_real"]=1
    _gst_processed=$((_gst_processed + 1))
    if ! "$_gst_objdump" -p "$_gst_real" >/dev/null 2>&1; then
      echo "FATAL: GStreamer closure entry is not a readable ELF: $_gst_real" >&2
      return 1
    fi

    _gst_needed="$("$_gst_objdump" -p "$_gst_real" 2>/dev/null | awk '$1 == "NEEDED" { print $2 }')"
    while IFS= read -r _gst_need; do
      [ -n "$_gst_need" ] || continue
      case " $_gst_base_libs " in
        *" $_gst_need "*) continue ;;
      esac

      _gst_local=""
      while IFS= read -r -d '' _gst_candidate; do
        _gst_candidate_real="$(readlink -f "$_gst_candidate" 2>/dev/null || true)"
        if [ -f "$_gst_candidate_real" ]; then
          _gst_local="$_gst_candidate"
          break
        fi
      done < <(find "$APPDIR/usr/lib" -name "$_gst_need" \( -type f -o -type l \) -print0 2>/dev/null)
      if [ -n "$_gst_local" ]; then
        _gst_queue+=("$_gst_local")
        continue
      fi

      # Honor the current ELF's own DT_RUNPATH/DT_RPATH before falling back to
      # the generic host directories. Some distro libraries keep private
      # dependencies outside ldconfig's cache (Ubuntu's libpulse.so uses
      # /usr/lib/x86_64-linux-gnu/pulseaudio for libpulsecommon), and the
      # dynamic loader resolves those paths even though a flat host-dir lookup
      # cannot. Resolve $ORIGIN without eval so an ELF cannot inject shell.
      _gst_host=""
      _gst_origin="$(dirname "$_gst_real")"
      _gst_runpaths="$("$_gst_objdump" -p "$_gst_real" 2>/dev/null \
        | awk '$1 == "RUNPATH" || $1 == "RPATH" { print $2 }')"
      while IFS= read -r _gst_runpath; do
        [ -n "$_gst_runpath" ] || continue
        IFS=: read -r -a _gst_runpath_list <<< "$_gst_runpath"
        for _gst_candidate in "${_gst_runpath_list[@]}"; do
          [ -n "$_gst_candidate" ] || continue
          _gst_candidate="${_gst_candidate//\$\{ORIGIN\}/$_gst_origin}"
          _gst_candidate="${_gst_candidate//\$ORIGIN/$_gst_origin}"
          if [ -e "$_gst_candidate/$_gst_need" ]; then
            _gst_host="$_gst_candidate/$_gst_need"
            break
          fi
        done
        [ -n "$_gst_host" ] && break
      done <<< "$_gst_runpaths"

      for _gst_candidate in "${_gst_host_dir_list[@]}"; do
        [ -z "$_gst_host" ] || break
        [ -n "$_gst_candidate" ] || continue
        if [ -e "$_gst_candidate/$_gst_need" ]; then
          _gst_host="$_gst_candidate/$_gst_need"
          break
        fi
      done
      if [ -z "$_gst_host" ] && [ -n "$_gst_ldconfig" ]; then
        _gst_host="$("$_gst_ldconfig" -p 2>/dev/null | awk -v need="$_gst_need" '$1 == need && !f { print $NF; f = 1 }' || true)"
      fi
      if [ -z "$_gst_host" ] || [ ! -e "$_gst_host" ]; then
        echo "FATAL: GStreamer plugin $(basename "$_gst_real") needs $_gst_need, but no host or AppDir copy resolves it" >&2
        return 1
      fi

      _gst_source_real="$(readlink -f "$_gst_host" 2>/dev/null || true)"
      if [ ! -f "$_gst_source_real" ]; then
        echo "FATAL: GStreamer dependency $_gst_need resolves to no regular file: $_gst_host" >&2
        return 1
      fi
      _gst_filename="$(basename "$_gst_source_real")"
      _gst_target="$APPDIR/usr/lib/$_gst_filename"
      if [ -L "$_gst_target" ] && [ ! -e "$_gst_target" ]; then
        rm -f "$_gst_target"
      fi
      if [ ! -e "$_gst_target" ]; then
        cp -a "$_gst_source_real" "$_gst_target" || {
          echo "FATAL: failed to copy GStreamer dependency $_gst_need from $_gst_source_real" >&2
          return 1
        }
        _gst_count=$((_gst_count + 1))
      fi
      _gst_link="$APPDIR/usr/lib/$_gst_need"
      if [ "$_gst_filename" != "$_gst_need" ] && [ ! -e "$_gst_link" ]; then
        ln -s "$_gst_filename" "$_gst_link" || {
          echo "FATAL: failed to create GStreamer dependency soname link $_gst_link" >&2
          return 1
        }
      fi
      [ -e "$_gst_link" ] || [ -L "$_gst_link" ] || {
        echo "FATAL: GStreamer dependency $_gst_need was not materialized in the AppDir" >&2
        return 1
      }
      _gst_queue+=("$_gst_link")
    done <<< "$_gst_needed"
  done

  echo "   GStreamer plugin ELF closure verified: $_gst_processed ELF(s), $_gst_count library/libraries copied"
}

copy_gstreamer_plugin_closure || exit 1

# 2c-gst-ii. GPL LIBRARY GUARD (P-020). Whatever route a library took into the
#     AppDir (linuxdeploy, the plugin closure, a future copy step), none of the
#     GPL codec/media libraries dropped in 2c-gst-0 may ship under ELv2.
GST_GPL_LIB_ERE="${PAPERCUSP_APPIMAGE_GPL_LIB_ERE:-^lib(avcodec|avformat|avfilter|avdevice|avutil|swresample|swscale|postproc|x264|x265|a52|mpeg2|dvdread|dvdnav|mjpegutils|mpeg2encpp|mplex2|sidplay|cdio|faad|slang|gpm|readline|dca|lrdf|zvbi|neon|fftw3|rubberband|xvidcore|vidstab|jbig|tiff|ayatana-indicator3)[.-]}"
_gpl_hits="$(find "$APPDIR" \( -type f -o -type l \) -name 'lib*.so*' -printf '%f\n' 2>/dev/null | grep -E "$GST_GPL_LIB_ERE" | sort -u || true)"
if [ -n "$_gpl_hits" ]; then
  echo "FATAL: GPL-licensed libraries are in the AppDir (incompatible with the Elastic License 2.0):" >&2
  printf '  %s\n' $_gpl_hits >&2
  exit 1
fi
echo "   GPL library guard: no GPL codec/media libraries in the AppDir"
[ -f "$GST_PLUGIN_DEST/libgstapp.so" ] || {
  echo "FATAL: AppDir is missing the GStreamer appsink provider (libgstapp.so)" >&2
  exit 1
}
[ -x "$GST_SCANNER_DEST" ] || {
  echo "FATAL: AppDir is missing an executable GStreamer plugin scanner" >&2
  exit 1
}
echo "   bundled GStreamer plugins: $(find "$GST_PLUGIN_DEST" -maxdepth 1 -type f -name 'libgst*.so*' | wc -l) + plugin scanner"

# 2c-i. GL/EGL FALLBACK (last on LD_LIBRARY_PATH, never overriding the host).
#     linuxdeploy's excludelist deliberately drops the libglvnd dispatch libs
#     because they are driver-coupled — correct on a box that HAS them, fatal on
#     one that does not: WebKitGTK dlopen()s libGLESv2.so.2 and aborts with
#     "Couldn't open libGLESv2.so.2" (measured on the pristine VM). Shipping them
#     in a directory appended LAST to LD_LIBRARY_PATH gives the host's own copy
#     priority whenever it exists, and a working fallback when it does not.
#
#     SINGLE-SOURCED (EI-20122241900682950): the copy loop below and the fail-closed
#     assertion in 2c-iii both iterate THIS one list. It used to be two hand-maintained
#     literals — a 5-soname copy loop and a 1-soname spot-check — which is exactly HOW
#     libGL.so.1 shipped missing with the guard green the whole time. Add a soname here
#     and it is bundled AND asserted; there is no longer a way to do one without the other.
#
#     libGL.so.1 is NOT here for WebKitGTK's dlopen (that is libGLESv2.so.2). It is a
#     load-time DT_NEEDED resolved by the dynamic linker BEFORE main() runs, so its
#     absence is a hard exec failure — "error while loading shared libraries:
#     libGL.so.1", exit 127, measured on a box with the X11/font stack but no system
#     OpenGL — and not the graceful dlopen degradation the rest of this list guards.
#     libglvnd ships it as a thin wrapper over the libGLdispatch.so.0 + libGLX.so.0
#     pair already copied here, so it adds a wrapper, not a driver.
GLFALLBACK_SONAMES="libGL.so.1 libGLESv2.so.2 libGLdispatch.so.0 libEGL.so.1 libGLX.so.0 libOpenGL.so.0"
mkdir -p "$APPDIR/usr/lib/glfallback"
for _gl in $GLFALLBACK_SONAMES; do
  _src="$(readlink -f "/usr/lib/x86_64-linux-gnu/$_gl" 2>/dev/null)"
  [ -f "$_src" ] || continue
  cp -n "$_src" "$APPDIR/usr/lib/glfallback/" 2>/dev/null || true
  ln -sfn "$(basename "$_src")" "$APPDIR/usr/lib/glfallback/$_gl"
done

# 2c-ii. WEBKIT HELPER-PROCESS PATH — the non-obvious half.
#     Bundling the libraries is necessary but NOT sufficient. With the whole WebKit
#     chain deployed, the app still dies on a box without system WebKitGTK:
#       ERROR: Unable to spawn a new child process: Failed to spawn child process
#       "/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/WebKitNetworkProcess"  [exit 133]
#     That is PKGLIBEXECDIR — an ABSOLUTE path baked into libwebkit2gtk at compile
#     time. Nothing in the environment can redirect it: $WEBKIT_EXEC_PATH is
#     DEVELOPER_MODE-only in WebKitGTK 2.52 and Ubuntu ships DEVELOPER_MODE off, so
#     the variable the AppRun exports is read by nothing. The helper binaries are
#     present and executable inside the mount — this is a path-CHOICE bug, not a
#     missing-file bug, which is why it survives every "did we bundle everything?"
#     check and only shows up on a host that lacks system WebKit.
#
#     ⚠ AN EARLIER VERSION OF THIS COMMENT CLAIMED the resolution was CWD-relative
#     ("././/lib/x86_64-linux-gnu/...", allegedly proven by elimination) and that the
#     symlink below plus the AppRun's `cd "$HERE"` were the fix. That was WRONG and is
#     retracted: measured against the real PACKAGED artifact on a verified-pristine VM
#     (0 webkit2gtk packages), the spawn attempt is the ABSOLUTE path above. The
#     earlier finding came from a hand-assembled tree, not from a packaged AppImage.
#     Do not restore that reasoning; re-measure with a packaged .AppImage.
#
#     THE FIX: rewrite the baked-in string to a RELATIVE one, IN PLACE. g_spawn
#     resolves a relative executable path against the process CWD, and the AppRun
#     already does `cd "$HERE"` — so "lib/x86_64-linux-gnu/webkit2gtk-4.1/…" lands
#     inside the mount on any host. The edit never SHIFTS bytes: the replacement is
#     shorter than the original and is NUL-padded to the original length, so every
#     ELF offset, relocation and section size is untouched (the .so's size is
#     byte-identical afterwards, which the guard below asserts).
_WK_LIB="$APPDIR/usr/lib/libwebkit2gtk-4.1.so.0"
if [ -f "$_WK_LIB" ]; then
  command -v python3 >/dev/null || { echo "FATAL: python3 is required to relativize WebKit's PKGLIBEXECDIR" >&2; exit 1; }
  _WK_SIZE_BEFORE="$(stat -c%s "$_WK_LIB")"
  python3 - "$_WK_LIB" <<'PYEOF' || { echo "FATAL: WebKit PKGLIBEXECDIR patch failed" >&2; exit 1; }
import sys
p = sys.argv[1]
d = bytearray(open(p, 'rb').read())
old = b'/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1'
new = b'lib/x86_64-linux-gnu/webkit2gtk-4.1'
assert len(new) < len(old), 'replacement must be shorter so no bytes shift'
i = n = 0
while True:
    i = d.find(old, i)
    if i < 0:
        break
    end = d.find(b'\x00', i)            # this C string's own terminator
    orig = bytes(d[i:end])
    repl = new + orig[len(old):]        # preserve any suffix, e.g. /injected-bundle/
    assert len(repl) <= len(orig)
    d[i:end] = repl + b'\x00' * (len(orig) - len(repl))
    n += 1
    i = end
open(p, 'wb').write(d)
print(f'   relativized WebKit PKGLIBEXECDIR in {n} string(s)')
PYEOF
  [ "$(stat -c%s "$_WK_LIB")" = "$_WK_SIZE_BEFORE" ] || { echo "FATAL: libwebkit2gtk size changed during patch — ELF offsets would be corrupt" >&2; exit 1; }
fi

#     The relative tree the patched string now points at. Kept as a symlink so the
#     helper binaries are stored once.
mkdir -p "$APPDIR/lib/x86_64-linux-gnu"
ln -sfn ../../usr/lib/x86_64-linux-gnu/webkit2gtk-4.1 "$APPDIR/lib/x86_64-linux-gnu/webkit2gtk-4.1"

# 2c-iii. FAIL CLOSED. This is the recurrence guard: the whole class of bug here is
#     "the AppImage silently ships without its WebKit runtime and only a host that
#     already has system WebKit can launch it". Never package that again.
_missing=""
for _need in libwebkit2gtk-4.1.so.0 libjavascriptcoregtk-4.1.so.0 libgtk-3.so.0 libsoup-3.0.so.0 libgio-2.0.so.0 libglib-2.0.so.0; do
  find "$APPDIR/usr/lib" -maxdepth 2 -name "$_need" | grep -c . >/dev/null || _missing="$_missing $_need"
done
[ -x "$APPDIR/lib/x86_64-linux-gnu/webkit2gtk-4.1/WebKitNetworkProcess" ] || _missing="$_missing <cwd-relative WebKitNetworkProcess>"
# Assert EVERY soname the 2c-i copy loop was asked to bundle actually landed, not one
# representative. That loop `continue`s when the build host has no source for a soname,
# so a spot-check renders a silently-INCOMPLETE fallback dir as a green build — which is
# how libGL.so.1 shipped missing (EI-20122241900682950). Iterating the shared
# GLFALLBACK_SONAMES makes bundled-set and asserted-set the same set by construction.
#
# This FAILS CLOSED on a build host that lacks a GL soname, where the old spot-check
# would have shipped. That is the intended trade for this whole 2c-iii block ("never
# package that again"): a build host missing a libglvnd soname is a broken build host,
# not a shippable bundle. Verified all six resolve on the current builder before making
# the assertion total, so this tightens the gate without red-pinning today's build.
for _gl in $GLFALLBACK_SONAMES; do
  [ -f "$APPDIR/usr/lib/glfallback/$_gl" ] || _missing="$_missing $_gl(glfallback)"
done
# The helper-path half of the same class (2c-ii). A bundle can pass EVERY check above
# — all libraries present, helpers present and executable — and still hard-fail on a
# pristine host, because libwebkit2gtk asks for its helpers at the ABSOLUTE
# /usr/lib/... path that only exists on a box which already has system WebKitGTK.
# That is exactly the failure this whole guard exists to prevent, so assert the
# absolute path is GONE from the shipped library rather than trusting the patch ran.
if [ -f "$APPDIR/usr/lib/libwebkit2gtk-4.1.so.0" ]; then
  if strings -a "$APPDIR/usr/lib/libwebkit2gtk-4.1.so.0" | grep -c '^/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1' >/dev/null; then
    _missing="$_missing <libwebkit2gtk still carries an ABSOLUTE PKGLIBEXECDIR — helper spawn will fail on a host without system WebKitGTK>"
  fi
fi
if [ -n "$_missing" ]; then
  echo "FATAL: AppDir is NOT self-contained — missing:$_missing" >&2
  echo "       Packaging it would reproduce EI-20075266271803900 (hard linker failure on a box without system WebKitGTK)." >&2
  exit 1
fi
echo "   self-containment OK: $(find "$APPDIR/usr/lib" -maxdepth 2 -name '*.so*' -type f | wc -l) libraries deployed"

# 3. appimagetool requires the desktop file's Icon=<name> to exist as <name>.png at
#    the AppDir ROOT. linuxdeploy names the root icon after the productName, but the
#    .desktop uses the binary/icon name — so copy the largest bundled icon into place.
ICON_NAME="$(grep -h -oP '^Icon=\K.*' "$APPDIR"/*.desktop 2>/dev/null | sed -n 1p)"
if [ -n "$ICON_NAME" ] && [ ! -f "$APPDIR/$ICON_NAME.png" ]; then
  ICON_SRC="$(find "$APPDIR/usr/share/icons" -name "$ICON_NAME.png" 2>/dev/null | sort -V | tail -1)"
  if [ -n "$ICON_SRC" ]; then cp "$ICON_SRC" "$APPDIR/$ICON_NAME.png"; echo "   root icon: $ICON_NAME.png (from $ICON_SRC)"; fi
fi

# 3b. Replace linuxdeploy's compiled AppRun with a robust shell AppRun (WI-2902).
#     linuxdeploy's ELF AppRun NULL-derefs in libc on some hosts (`segfault at 0,
#     error 4, in libc.so.6`) — it crashes the launch before the app ever starts,
#     even though the app BINARY runs fine given LD_LIBRARY_PATH + the WebKitGTK env.
#     Verified on the clean-room VM 2026-07-06: with this shell AppRun the AppImage
#     launches, the operator + embedded-PG come up, and the SPA renders. The script
#     sets the full GTK/WebKit env off $APPDIR (pixbuf loaders, gio TLS modules,
#     gstreamer, the webkit helper-process path) and execs the binary — the standard
#     AppImage AppRun pattern. Overwrite in place (the AppDir is a fresh build
#     artifact; no need to keep the crashing compiled one).
echo "==> replacing compiled AppRun with shell AppRun (linuxdeploy AppRun segfaults in libc; WI-2902)"
cat > "$APPDIR/AppRun" <<'APPRUN'
#!/bin/bash
# Robust shell AppRun (replaces linuxdeploy's crashing compiled AppRun) — WI-2902.
HERE="$(dirname "$(readlink -f "${0}")")"
export APPDIR="${APPDIR:-$HERE}"
# glfallback is LAST on purpose: the host's own libglvnd/GL wins whenever it exists;
# our copy only rescues a box that has none (EI-20075266271803900).
export LD_LIBRARY_PATH="$HERE/usr/lib:$HERE/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}:$HERE/usr/lib/glfallback"
export PATH="$HERE/usr/bin:$PATH"
export XDG_DATA_DIRS="$HERE/usr/share:${XDG_DATA_DIRS:-/usr/local/share:/usr/share}"
# linuxdeploy plugin hooks (gtk plugin: GSETTINGS_SCHEMA_DIR, GTK_PATH, immodules, …)
for _hook in "$HERE"/apprun-hooks/*.sh; do [ -r "$_hook" ] && . "$_hook"; done
# gdk-pixbuf image loaders
_pbcache="$(ls "$HERE"/usr/lib/*/gdk-pixbuf-*/*/loaders.cache "$HERE"/usr/lib/gdk-pixbuf-*/*/loaders.cache 2>/dev/null | sed -n 1p)"
[ -n "$_pbcache" ] && export GDK_PIXBUF_MODULE_FILE="$_pbcache"
# gio modules (tls etc.)
for _gio in "$HERE/usr/lib/x86_64-linux-gnu/gio/modules" "$HERE/usr/lib/gio/modules"; do
  [ -d "$_gio" ] && export GIO_MODULE_DIR="$_gio" && break
done
# gstreamer (webkit media)
[ -d "$HERE/usr/lib/gstreamer-1.0" ] && export GST_PLUGIN_SYSTEM_PATH_1_0="$HERE/usr/lib/gstreamer-1.0"
for _gst_scanner in \
  "$HERE/usr/lib/gstreamer1.0/gstreamer-1.0/gst-plugin-scanner" \
  "$HERE/usr/libexec/gstreamer-1.0/gst-plugin-scanner"; do
  [ -x "$_gst_scanner" ] && export GST_PLUGIN_SCANNER="$_gst_scanner" && break
done
# WebKitGTK helper-process exec path (network/web process live beside the lib)
for _wk in "$HERE/usr/libexec/webkit2gtk-4.1" "$HERE/usr/lib/webkit2gtk-4.1" "$HERE/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1"; do
  [ -d "$_wk" ] && export WEBKIT_EXEC_PATH="$_wk" && break
done
# single-process webkit sandbox off (AppImage helper processes can't sandbox)
export WEBKIT_DISABLE_COMPOSITING_MODE="${WEBKIT_DISABLE_COMPOSITING_MODE:-1}"
# REQUIRED, not cosmetic (EI-20075266271803900): Ubuntu's WebKitGTK 2.52 resolves its
# helper processes against the PROCESS CWD (./lib/x86_64-linux-gnu/webkit2gtk-4.1/…)
# and ignores WEBKIT_EXEC_PATH. $HERE carries that exact relative tree as a symlink,
# so cd'ing here is what lets the network/web processes spawn from the bundle.
cd "$HERE" || true
exec "$HERE/usr/bin/papercusp-desktop" "$@"
APPRUN
chmod +x "$APPDIR/AppRun"

# 3b-ii. FAIL CLOSED on the AppRun's `cd "$HERE"` (EI-20075266271803900).
#     2c-ii rewrote libwebkit2gtk's PKGLIBEXECDIR to the RELATIVE
#     "lib/x86_64-linux-gnu/webkit2gtk-4.1", and WebKitGTK resolves that against the
#     PROCESS CWD — measured on a pristine VM: the running WebKitWebProcess's argv[0]
#     is that literal relative path and its /proc/<pid>/cwd is the AppImage mount root,
#     which it only is because the AppRun chdir'd there. So that one line is now
#     LOad-BEARING for helper spawn, and deleting it breaks the bundle ONLY on a host
#     without system WebKitGTK — invisible on every dev box, i.e. exactly the silent
#     regression this whole guard exists to prevent. Assert it survives.
if ! grep -qE '^cd "\$HERE"' "$APPDIR/AppRun"; then
  echo "FATAL: AppRun does not 'cd \"\$HERE\"' — the relativized WebKit PKGLIBEXECDIR (2c-ii)" >&2
  echo "       resolves against the process CWD, so helper spawn would fail on any host" >&2
  echo "       without system WebKitGTK. Reproduces EI-20075266271803900." >&2
  exit 1
fi

# 3c. RELATIVIZE any absolute symlink whose target points INSIDE the AppDir.
#     linuxdeploy creates the AppDir-root `.DirIcon` and `<productName>.desktop`
#     symlinks with ABSOLUTE targets (/home/<builder>/.cargo-target/.../*.AppDir/…),
#     which appimagetool packs into the squashfs VERBATIM — leaking the build-box
#     home path + username into every shipped AppImage (WI-4736). The identity
#     scan in 3d CANNOT catch these: grep -rIlE never reads a symlink's target.
#     Rewrite each as a path RELATIVE to the symlink's own directory so the packed
#     AppImage carries no absolute build path AND the link still resolves at the
#     user's mount point.
# 3d-pre. Evict FOREIGN project binaries from usr/bin (WI-37553).
#     ~/.cargo/config.toml pins ONE shared target dir for the whole box
#     (build.target-dir=~/.cargo-target), so every sibling Tauri project's release
#     binary lands in the SAME release/ dir, and the bundler sweeps them all into
#     usr/bin. Measured on the 0.0.14 cut: the AppDir carried oddsmith-desktop AND
#     quartermaster-desktop beside ours — 21 MB of two unrelated apps, and
#     oddsmith-desktop alone embedded the build-box home path 31 times, which is
#     what red'd the identity gate below.
#     The AppRun execs usr/bin/papercusp-desktop and nothing else, so a foreign
#     desktop binary is pure contamination: wrong to ship, and a real leak.
#     Deliberately NARROW (only `*-desktop` siblings, never a blanket wipe): the
#     identity scan below stays the backstop for anything this misses, and a
#     whitelist would silently delete a helper a future build legitimately needs.
echo "==> evicting foreign project binaries from AppDir/usr/bin (shared cargo target dir; WI-37553)"
_evicted=0
for _b in "$APPDIR"/usr/bin/*-desktop; do
  [ -e "$_b" ] || continue
  case "$(basename "$_b")" in
    papercusp-desktop) continue ;;
  esac
  release_artifacts_guarded_delete "$_b" || exit 1
  echo "   evicted: usr/bin/$(basename "$_b") (belongs to another project)"
  _evicted=$((_evicted+1))
done
[ "$_evicted" -gt 0 ] && echo "   $_evicted foreign binary/binaries removed"
if [ ! -x "$APPDIR/usr/bin/papercusp-desktop" ]; then
  echo "FATAL: usr/bin/papercusp-desktop missing after the foreign-binary eviction — refusing to package (WI-37553)." >&2
  exit 1
fi

echo "==> relativizing absolute in-AppDir symlinks (strip build-box path from .DirIcon/.desktop; WI-4736)"
_appdir_abs="$(cd "$APPDIR" && pwd)"
while IFS= read -r -d '' _lnk; do
  _tgt="$(readlink "$_lnk")"
  case "$_tgt" in
    "$_appdir_abs"/*)
      _rel="$(realpath -ms --relative-to="$(dirname "$_lnk")" "$_tgt")"
      ln -sfn "$_rel" "$_lnk"
      echo "   relativized: ${_lnk#"$_appdir_abs"/} -> $_rel"
      ;;
  esac
done < <(find "$APPDIR" -type l -print0)

# 3d. RELEASE-PRIVACY GATE (WI-4736 / EI-11730) — FAIL CLOSED. Never package an
#     AppImage whose AppDir carries a known-sensitive or build-box identity. This
#     is the backstop to the stale-AppDir purge (step 0): even if a fresh AppDir
#     somehow still picks up a contaminated sidecar (a concurrent sidecar rebuild,
#     a future tauri regression), this HARD-STOPS the ship instead of leaking
#     silently — the 0.0.8/0.0.9 failure mode. Uses audit-release-bundle.py's
#     --scan-dir, the SAME identity rule build-desktop-sidecar.sh enforces on the
#     source sidecar (single source of truth; honors NO path-exclude). Default-ON
#     because an AppImage is ALWAYS a release artifact; PAPERCUSP_RELEASE_AUDIT=0
#     opts a throwaway local dev appimage out (matches bin/mac-vm-build.sh).
if [ "${PAPERCUSP_RELEASE_AUDIT:-1}" = "1" ]; then
  if [ ! -f "$AUDIT_PY" ]; then
    echo "FATAL: $AUDIT_PY not found — cannot enforce AppImage release-privacy; refusing to ship blind (WI-4736)." >&2
    exit 1
  fi
  echo "==> identity-scanning AppDir before packaging (release gate, honors NO path-exclude; WI-4736)"
  if ! python3 "$AUDIT_PY" --scan-dir "$APPDIR"; then
    echo "FATAL: AppDir carries a sensitive/build-box identity — refusing to package a leaky AppImage (WI-4736/EI-11730)." >&2
    exit 1
  fi
fi

# 4. Locate appimagetool (tauri downloads the linuxdeploy appimage plugin, which
#    embeds it) and package the AppDir. No ELF scan → no crash.
PLUGIN="$(ls "$HOME/.cache/tauri/"*plugin-appimage*.AppImage 2>/dev/null | sed -n 1p)"
[ -n "$PLUGIN" ] || { echo "FATAL: linuxdeploy-plugin-appimage not found in ~/.cache/tauri (did the tauri step run?)" >&2; exit 1; }

# APPIMAGE_EXTRACT_AND_RUN makes the type-2 runtime unpack the plugin under
# "$TMPDIR/appimage_extracted_<hash>". TMPDIR is normally shared by every build
# on the host, so two concurrent package steps otherwise select the same runtime
# directory and one process can observe the other's half-extracted tree (the
# asymmetric 127/0 failure in EI-21829997763481272). Give this invocation an
# owned parent directory; the subshell trap removes only that directory after
# appimagetool exits, including failure paths.
run_appimage_tool_isolated() (
  set -u
  local plugin="${1:?appimagetool plugin path required}"
  local output="${2:?AppImage output path required}"
  local appdir="${3:?AppDir path required}"
  local runtime_tmp

  runtime_tmp="$(mktemp -d "${TMPDIR:-/tmp}/papercusp-appimage-runtime.XXXXXX")" || {
    echo "FATAL: cannot create the private AppImage runtime directory under ${TMPDIR:-/tmp}" >&2
    exit 1
  }
  trap '_status=$?; rm -rf -- "$runtime_tmp"; if [ "$_status" -ne 0 ]; then rm -f -- "$output"; fi; exit "$_status"' EXIT
  echo "   AppImage runtime extraction dir: $runtime_tmp"
  ARCH=x86_64 APPIMAGE_EXTRACT_AND_RUN=1 TMPDIR="$runtime_tmp" LDAI_OUTPUT="$output" \
    "$plugin" --appdir "$appdir"
)

echo "==> packaging with appimagetool → $OUT"
run_appimage_tool_isolated "$PLUGIN" "$OUT" "$APPDIR" || {
  echo "FATAL: appimagetool failed to package $APPDIR" >&2
  exit 1
}
[ -f "$OUT" ] || { echo "FATAL: appimagetool did not produce $OUT" >&2; exit 1; }

# 5. Sign for the Tauri updater (minisign .sig). Best-effort — the AppImage itself
#    runs unsigned; the .sig only gates auto-update verification.
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  echo "==> signing $OUT (updater)"
  # WI-3823: `tauri signer sign -k/--private-key` wants the key CONTENT (base64), not
  # a path — unlike the TAURI_SIGNING_PRIVATE_KEY env that `tauri build` reads (which
  # accepts either). Resolve a path to its contents, but hand the resolved secret to
  # the CLI via its OWN env-var reading (`tauri signer sign --help` confirms -k/-p both
  # have `[env: TAURI_SIGNING_PRIVATE_KEY=]` / `[env: TAURI_SIGNING_PRIVATE_KEY_PASSWORD=]`
  # fallbacks) instead of --private-key/--password on argv. `npm run` ECHOES the fully
  # resolved script command line before executing it, so a secret on argv here printed
  # the ENTIRE encrypted private key (+ password) straight into the build log AND was
  # visible in `ps` for the life of the process. Passing nothing secret on argv removes
  # the leak at the root; `--silent` (belt-and-suspenders) also suppresses npm's own
  # `> pkg@version tauri` / `> tauri signer sign …` echo lines entirely (verified: with
  # --silent, npm prints only the wrapped command's own stdout).
  _key="$TAURI_SIGNING_PRIVATE_KEY"; [ -f "$_key" ] && _key="$(cat "$_key")"
  if TAURI_SIGNING_PRIVATE_KEY="$_key" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" \
        npx --yes -p @tauri-apps/cli@"$TAURI_CLI_VERSION" tauri signer sign "$OUT"; then
    echo "   signed → $OUT.sig"
  else
    echo "   WARN: signing failed — AppImage is usable but the updater .sig is missing" >&2
  fi
fi

# build-linux-local.sh moves this output into its source-tree collection root;
# defer retention to that parent so the child does not protect the path from
# its own final collection move.
if [ "${PAPERCUSP_BUILD_LINUX_COLLECTING:-0}" != "1" ]; then
  papercusp_retain_release_paths "$CT" "$APPIMG_DIR" "$OUT" "$OUT.sig" || exit 1
fi

echo "==> AppImage done:"
ls -la "$OUT"*
