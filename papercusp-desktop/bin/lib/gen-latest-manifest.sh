#!/usr/bin/env bash
# gen-latest-manifest.sh — the SINGLE source of truth for turning a built artifact
# set into latest.json / latest-server.json (+ brief release notes), shared by
# every release-cut path (EI-18101626616739029).
#
# THE GAP THIS FIXES: latest.json / latest-server.json were generated ONLY by
# release-local.sh's embedded Python (the multi-leg, all-platforms-join cut).
# The per-leg producers — bin/build-linux-local.sh, bin/build-windows-cross.sh,
# bin/build-mac-cross.sh — build artifacts + minisign .sig but emit NO manifest,
# so the tri-platform PARALLEL-FLEET release pattern (each agent cuts ONE
# platform via its own per-leg script, per the owner's 2026-07-15 parallel-
# build directive) left nobody generating latest.json unless someone manually
# re-ran release-local.sh's Python block standalone (a real, error-prone step
# that happened live during a fleet cut). Factoring it out here means a
# single-leg cut can produce its OWN manifest via bin/gen-latest-manifest.sh,
# and release-local.sh calls the exact same helper — one implementation, no
# drift between "the real multi-leg release" and "a manual single-platform
# publish".
#
# Public functions:
#   desktop_release_tag <version> <channel>
#     -> echoes the release tag ("desktop-vX.Y.Z[-alpha|-beta]"), matching the
#        operator's manifest classifier (apps/operator/app/api/updates/manifest/route.ts).
#   desktop_channel_identity <channel>
#     -> sets DESKTOP_CHANNEL_BUILD_CFG + DESKTOP_CHANNEL_BUILD_ENV, the tauri
#        `--config` identity overlay and the baked channel stamps that a
#        side-by-side channel needs TOGETHER (empty for an update lane).
#   desktop_channel_is_side_by_side <channel>
#     -> exit 0 when the channel installs alongside the main app.
#   gen_latest_manifest_json_path <tag>          -> latest.json path for the tag
#   gen_latest_manifest_server_json_path <tag>   -> latest-server.json path for the tag
#   gen_latest_manifest_notes_path <tag>         -> release-notes.md path for the tag
#   gen_latest_manifest <version> <channel> <tag> <artifact>...
#     -> writes latest.json (+ latest-server.json when Server-role artifacts are
#        present) + brief release notes to the paths above. Set
#        PAPERCUSP_UPDATE_BASE_URL to the base the artifacts will actually be
#        served from — unset, download URLs are an obviously-invalid placeholder
#        and the function prints a loud warning (never a plausible-but-wrong URL).
#
#        MERGE MODE (EI-18111560213741904): set GEN_LATEST_MANIFEST_MERGE_GUI_JSON
#        (and/or GEN_LATEST_MANIFEST_MERGE_SERVER_JSON) to an existing manifest's
#        path before calling — its `platforms` entries are loaded as the STARTING
#        point, and the freshly-classified entries from THIS call's artifacts are
#        overlaid on top (same platform key ⇒ overwritten with the fresh one,
#        every other key carried through untouched when it belongs to THIS tag).
#        A carried entry from another release tag is dropped loudly instead of
#        creating a manifest whose top-level version advertises bytes from an
#        older release. This is what lets
#        bin/publish-platform-incremental.sh ADD one platform onto an
#        already-published manifest without regenerating (and so re-uploading)
#        every other platform's entry. Unset (the default) ⇒ a fresh cut, exactly
#        today's behavior — release-local.sh and bin/gen-latest-manifest.sh are
#        unaffected.
#
# All three "*_path" helpers are pure string functions (no I/O) so a caller can
# resolve where the manifest WILL land before/after calling gen_latest_manifest.

# Must stay in lockstep with the kit's defaultTagFor()
# (libs/generic/tauri-release-kit/src/tag.ts) AND with the operator's
# classifyChannel(), which reads the channel back OFF this tag and whose
# fall-through is `stable`. A channel that can be cut here but is unknown there
# is not rejected — it is served to stable users.
desktop_release_tag() {
  local version="$1" channel="$2"
  case "$channel" in
    alpha)   printf 'desktop-v%s-alpha\n' "$version" ;;
    beta)    printf 'desktop-v%s-beta\n' "$version" ;;
    nightly) printf 'desktop-v%s-nightly\n' "$version" ;;
    stable)  printf 'desktop-v%s\n' "$version" ;;
    *) echo "gen-latest-manifest: channel must be alpha|beta|stable|nightly (got '$channel')" >&2; return 1 ;;
  esac
}

# Does a cut on $channel enforce the strict preconditions (clean tree, verified
# submodule freshness) rather than warning and continuing?
#
# Mirrors ChannelSpec.strict in @papercusp/tauri-release-kit. This exists as a
# NAMED predicate because the callers used to spell it `[[ "$CHANNEL" != "alpha" ]]`
# — a test whose meaning silently inverts the moment a second non-strict channel
# exists. `nightly` is cut from trunk daily on a shared tree that is almost
# always dirty, so under the old spelling every nightly cut would have been
# blocked by a guard that was never aimed at it.
#
# Exit 0 = strict (block), 1 = lenient (warn and continue).
desktop_channel_is_strict() {
  case "$1" in
    beta|stable)   return 0 ;;
    alpha|nightly) return 1 ;;
    *) echo "gen-latest-manifest: unknown channel '$1'" >&2; return 0 ;;
  esac
}

# Which manifest object keys a cut on $channel publishes, relative to the
# release-host base — the per-channel feed always, plus the permanent root
# manifest for an update lane.
#
# Mirrors ChannelRegistry.feedPathsFor() in @papercusp/tauri-release-kit.
# ORDER IS DELIBERATE: per-channel feed first, root LAST, so a publish that dies
# partway leaves the permanently-polled manifest on the last known good release.
#
# `nightly` is SIDE-BY-SIDE — its own bundle id, name and data home — so it must
# NEVER write the root manifest: that address is polled by every installed copy
# of the main app, and a nightly build reaching it offers those users an update
# into a different application.
desktop_channel_feed_paths() {
  local channel="$1" manifest="${2:-latest.json}" writes_root
  # Validate BEFORE emitting anything. A caller reads this on a pipe
  # (`while read … < <(…)`), where a nonzero return does NOT abort the loop — so
  # emitting a path and then failing would still publish to it.
  case "$channel" in
    alpha|beta|stable) writes_root=1 ;;
    nightly)           writes_root=0 ;;
    *) echo "gen-latest-manifest: unknown channel '$channel'" >&2; return 1 ;;
  esac
  printf '%s/%s\n' "$channel" "$manifest"
  (( writes_root )) && printf '%s\n' "$manifest"
  return 0
}

# The base app's data-home directory NAME. Mirrors PAPERCUSP_BASE_IDENTITY
# .dataHomeDirName in bin/release.config.ts AND workspaces::BASE_DATA_HOME_DIR_NAME
# in Rust — three spellings of one directory, cross-checked by
# test/nightly-channel-identity.test.js and by this file's self-test.
DESKTOP_BASE_DATA_HOME_DIR_NAME='.papercusp'

# desktop_channel_identity <channel>
#
# THE SINGLE EXIT that joins the two halves of a side-by-side channel's identity,
# mirroring resolveChannelIdentity() in @papercusp/tauri-release-kit. It sets two
# arrays, and every build site must expand BOTH on the same invocation:
#
#   DESKTOP_CHANNEL_BUILD_CFG  the tauri `--config <overlay>` args (bundle id,
#                              product name, icons — what makes the OS treat this
#                              as a second application)
#   DESKTOP_CHANNEL_BUILD_ENV  the baked stamps PAPERCUSP_CHANNEL +
#                              PAPERCUSP_CHANNEL_DATA_HOME (what makes
#                              workspaces::shared_sidecar_home() open a distinct
#                              data home)
#
# WHY ONE FUNCTION RATHER THAN TWO. Either half applied without the other is a
# build that writes to the wrong app's state, and the two failure directions are
# not symmetric. A stamp with no overlay, or an overlay with no stamp, is caught
# at runtime by workspaces::verify_channel_identity() — it refuses to boot. But
# that refusal costs a whole release cut, and it can only fire AFTER someone has
# installed the thing. Deriving both from one call means a build path cannot
# express the broken combination in the first place; the scan in
# test/nightly-channel-identity.test.js enforces that no build path hand-rolls
# the overlay around this function.
#
# An UPDATE-LANE channel deliberately gets EMPTY arrays: same app, same identity,
# same data home, reached by a different feed. A stable build that started
# carrying a stamp would be a regression, not a nicety — every one of the 24
# builds ever cut is un-stamped, and workspaces::resolve_data_home_dir_name()
# treats an absent stamp as the existing ~/.papercusp precisely so they keep
# working.
#
# Exit 0 with both arrays set (possibly empty); nonzero on an unknown channel.
desktop_channel_identity() {
  local channel="$1" suffix
  DESKTOP_CHANNEL_BUILD_CFG=()
  DESKTOP_CHANNEL_BUILD_ENV=()
  case "$channel" in
    # update-lane: no overlay, no stamps. Nothing to set.
    alpha|beta|stable) return 0 ;;
    # side-by-side. `suffix` is the channel's identitySuffix from
    # release.config.ts — NOT necessarily its id. It is what the bundle
    # identifier carries as its extra dot segment, and
    # workspaces::verify_channel_identity() compares the baked PAPERCUSP_CHANNEL
    # against THAT segment, so the stamp must be the suffix.
    nightly) suffix='nightly' ;;
    *) echo "gen-latest-manifest: unknown channel '$channel'" >&2; return 1 ;;
  esac

  DESKTOP_CHANNEL_BUILD_CFG=(--config "src-tauri/tauri.${channel}.conf.json")
  DESKTOP_CHANNEL_BUILD_ENV=(
    "PAPERCUSP_CHANNEL=${suffix}"
    # resolveChannelIdentity()'s formula: `${base.dataHomeDirName}-${suffix}`.
    "PAPERCUSP_CHANNEL_DATA_HOME=${DESKTOP_BASE_DATA_HOME_DIR_NAME}-${suffix}"
  )
  return 0
}

# Does a cut on $channel install ALONGSIDE the main app (its own bundle id, name
# and data home) rather than updating it in place? Mirrors
# ChannelSpec.distribution === 'side-by-side'.
#
# Exit 0 = side-by-side, 1 = update-lane. Unknown channels are side-by-side (the
# fail-closed answer: callers use this to REFUSE cross-platform legs and role
# combinations that have no identity overlay yet, and a wrong "no" there ships a
# stable-identity artifact under a nightly tag).
desktop_channel_is_side_by_side() {
  case "$1" in
    alpha|beta|stable) return 1 ;;
    nightly)           return 0 ;;
    *) echo "gen-latest-manifest: unknown channel '$1'" >&2; return 0 ;;
  esac
}

gen_latest_manifest_json_path()        { printf '/tmp/papercusp-latest-%s.json\n' "$1"; }
gen_latest_manifest_server_json_path() { printf '/tmp/papercusp-latest-server-%s.json\n' "$1"; }
gen_latest_manifest_notes_path()       { printf '/tmp/papercusp-notes-%s.md\n' "$1"; }

# gen_latest_manifest <version> <channel> <tag> <artifact>...
gen_latest_manifest() {
  local version="$1" channel="$2" tag="$3"; shift 3
  local out_path out_server_path notes_path
  out_path="$(gen_latest_manifest_json_path "$tag")"
  out_server_path="$(gen_latest_manifest_server_json_path "$tag")"
  notes_path="$(gen_latest_manifest_notes_path "$tag")"
  # EI-18111560213741904 MERGE MODE — see the header comment above.
  local merge_gui="${GEN_LATEST_MANIFEST_MERGE_GUI_JSON:-}"
  local merge_srv="${GEN_LATEST_MANIFEST_MERGE_SERVER_JSON:-}"

  python3 - "$version" "$channel" "$tag" "$out_path" "$out_server_path" "$notes_path" "$merge_gui" "$merge_srv" "$@" <<'PY'
import json, os, sys, pathlib, hashlib
from urllib.parse import quote, unquote, urlsplit
version, channel, tag, out_path, out_server_path, notes_path, merge_gui, merge_srv = sys.argv[1:9]
artifacts = [pathlib.Path(p) for p in sys.argv[9:]]

def load_merge_base(path: str) -> dict:
    """MERGE MODE: load a previously-published manifest's `platforms` dict as the
    starting point for this call's — empty/missing/unreadable ⇒ {} (fresh cut,
    today's behavior)."""
    if not path:
        return {}
    p = pathlib.Path(path)
    if not p.is_file():
        return {}
    try:
        return (json.loads(p.read_text()) or {}).get("platforms") or {}
    except Exception:
        return {}

# Where an updating client DOWNLOADS the artifact from. This used to be
# hardcoded to github.com/Papercusp/papercusp-desktop/releases/download/... —
# which became a LIE the moment releases went LOCAL-only (2026-07-12): we never
# publish there, so every updater client would have chased a 404 against a
# manifest that looked perfectly valid. A manifest asserting a download URL that
# does not exist is the LABELED!=PACKED class of bug.
#
# The owner uploads the installers by hand and we cannot know the destination at
# cut time, so it is an INPUT, not a guess: set PAPERCUSP_UPDATE_BASE_URL to the
# base the artifacts will actually be served from. Unset, we emit an obviously
# invalid placeholder (never a plausible-but-wrong URL) and the cut warns loudly.
UPDATE_BASE = os.environ.get("PAPERCUSP_UPDATE_BASE_URL", "").rstrip("/")
PLACEHOLDER = "papercusp-update-base-unset://SET-PAPERCUSP_UPDATE_BASE_URL"

def repo_url(name: str) -> str:
    base = UPDATE_BASE or PLACEHOLDER
    # Percent-encode the FILENAME ONLY. The mac and windows GUI bundles are named
    # with SPACES ("Papercusp GUI.app.tar.gz", "Papercusp GUI_0.0.8_x64-setup.exe"),
    # and a url carrying a literal space is rejected by the client outright
    # (curl: "URL rejected: Malformed input to a URL function") — so the manifest
    # validates, the minisign signature verifies, and the download still fails.
    # The updater cannot tell a failed check from a 204, so it reports "up to date"
    # FOREVER: the LABELED!=PACKED class again. Linux only escaped it because the
    # AppImage is underscore-named.
    #
    # safe="" so the name is fully encoded; the BASE is never touched (it carries
    # the secret path segment and its slashes must stay slashes). The S3 object key
    # keeps the RAW name — only this url is encoded, and R2 serves it at the %20 path.
    return f"{base}/{tag}/{quote(name, safe='')}"

# EI-... (WI-4404): WI-3696 made latest.json GUI-only because the darwin
# (.app.tar.gz) and windows (-setup.exe/.msi) collection globs pull BOTH
# roles' bundles out of the SAME output dir (mac-vm-build.sh / build-
# windows-on-vm.sh each build "Papercusp GUI" + "Papercusp Server" side by
# side) — adding both unconditionally into ONE `platforms` dict let whichever
# role's file the shell glob happened to iterate LAST silently clobber the
# other's entry (a Server artifact — genuinely signed — served in place of
# GUI, or vice versa). The fix keeps that hard separation but stops discarding
# the Server half outright: build the SAME platform-selection logic once per
# product into its OWN dict/manifest/file (`latest.json` for gui,
# `latest-server.json` for server) so a `product=server` poll
# (updates-manifest.ts) finally has something to be served from, instead of
# always answering `no_candidate` — the "no update path exists for Server"
# gap WI-4404 identified.
def build_platforms(artifacts, want_token, reject_token):
    """want_token/reject_token: substrings that must/must-not appear in the
    artifact filename — e.g. want='Server', reject='GUI' selects only
    Server-role bundles for the server manifest (and vice versa for gui)."""
    platforms = {}
    def add(platform_key, bin_path, sig_path):
        sig = sig_path.read_text().strip() if sig_path.exists() else ""
        platforms[platform_key] = {
            "signature": sig,
            "url": repo_url(bin_path.name),
        }

    def appimage_platform_key(art):
        """Return exactly one Linux platform key for an AppImage.

        The arm64 release leg normally carries its architecture in the
        filename (``aarch64``/``arm64``) or in Cargo's target directory. Do
        not first classify every AppImage as x86_64 and then add an arm key:
        that publishes one set of ARM bytes under two platform keys, and the
        last artifact visited can silently overwrite the x86 entry.
        """
        name = art.name.lower()
        if "aarch64" in name or "arm64" in name:
            return "linux-aarch64"
        target_parts = {part.lower() for part in art.parts}
        if target_parts.intersection({"aarch64-unknown-linux-gnu", "aarch64", "arm64"}):
            return "linux-aarch64"
        return "linux-x86_64"

    for art in artifacts:
        if reject_token in art.name:
            continue
        # A pre-split bundle (neither role token in the name) is treated as
        # GUI-role only — never let an unlabeled artifact land in BOTH
        # manifests. want_token=='' (gui) accepts it; want_token=='Server'
        # (server) requires the explicit token.
        if want_token and want_token not in art.name:
            continue
        if art.suffix == ".AppImage":
            sig = art.with_suffix(art.suffix + ".sig")
            # One artifact produces one architecture entry. In particular,
            # an aarch64 AppImage must never also acquire the x86_64 key.
            add(appimage_platform_key(art), art, sig)
        # Windows — NSIS setup.exe is the v1 artifact (plan
        # windows-desktop-release-readiness-2026-06-11 D-003); MSI kept as
        # fallback for an opportunistic WiX build.
        if art.name.endswith(("-setup.exe", "-setup.zip")):
            sig = pathlib.Path(str(art) + ".sig")
            add("windows-x86_64", art, sig)
        elif art.name.endswith(".msi") and "windows-x86_64" not in platforms:
            sig = art.with_suffix(".msi.sig")
            add("windows-x86_64", art, sig)
        # macOS universal .app.tar.gz serves BOTH darwin arches (D-006)
        if art.name.endswith(".app.tar.gz"):
            sig = pathlib.Path(str(art) + ".sig")
            add("darwin-x86_64", art, sig)
            add("darwin-aarch64", art, sig)
    return platforms

# MERGE MODE: start from the previously-published dicts (if any), then overlay
# this call's freshly-classified entries on top — a re-published platform's key
# is overwritten with its fresh signature+url. A platform carried from a
# different release tag is NOT safe to retain: the manifest has one top-level
# version, so advertising an older URL creates an update loop. Drop those stale
# keys loudly; an absent platform is the safe representation of "not ready yet".
gui_platforms = load_merge_base(merge_gui)
gui_platforms.update(build_platforms(artifacts, want_token="", reject_token="Server"))
server_platforms = load_merge_base(merge_srv)
server_platforms.update(build_platforms(artifacts, want_token="Server", reject_token="GUI"))

def release_tag_from_url(url: str):
    """Return the generated desktop release tag embedded in an artifact URL."""
    try:
        segments = [unquote(segment) for segment in urlsplit(url).path.split("/") if segment]
    except Exception:
        return None
    tags = [segment for segment in segments if segment.startswith("desktop-v")]
    return tags[-1] if tags else None

def drop_stale_merge_entries(platforms, label):
    retained = {}
    for platform_key, entry in platforms.items():
        url = entry.get("url") if isinstance(entry, dict) else None
        actual_tag = release_tag_from_url(url) if isinstance(url, str) else None
        if actual_tag != tag:
            observed = actual_tag or "<missing>"
            print(
                f"WARNING: {label} merge dropped stale platform {platform_key}: "
                f"URL tag {observed!r} does not match release tag {tag!r} "
                f"(top-level version {version!r}); publish that platform separately "
                "when its artifact is ready.",
                file=sys.stderr,
            )
            continue
        retained[platform_key] = entry
    return retained

gui_platforms = drop_stale_merge_entries(gui_platforms, "latest.json")
server_platforms = drop_stale_merge_entries(server_platforms, "latest-server.json")

# WI-3696/WI-4404 cut-time assertion: every entry each manifest publishes must
# genuinely be that manifest's product (a fail-loud backstop against a FUTURE
# naming/glob regression re-introducing a silent wrong-product swap). The GUI
# manifest's own artifacts don't carry a "GUI" token pre-split, so the GUI
# check only forbids the OTHER product's token; the Server manifest requires
# its own token explicitly since Server-role bundles are always name-stamped.
for platform_key, entry in gui_platforms.items():
    if "Server" in entry["url"]:
        raise SystemExit(
            f"latest.json BUG: {platform_key} entry looks like the Server product "
            f"(url={entry['url']!r}) — refusing to publish a manifest that could ship the "
            f"wrong app on update (WI-3696)"
        )
for platform_key, entry in server_platforms.items():
    if "Server" not in entry["url"]:
        raise SystemExit(
            f"latest-server.json BUG: {platform_key} entry does not look like the Server "
            f"product (url={entry['url']!r}) — refusing to publish a manifest that could "
            f"ship the wrong app on update (WI-4404)"
        )

# Cut-time assertion: a url a client cannot even parse must never ship. Belt-and-
# braces behind repo_url()'s quoting, because the failure is SILENT downstream —
# the download 404s/rejects and the updater renders it as "up to date".
for label, platforms in (("latest.json", gui_platforms), ("latest-server.json", server_platforms)):
    for platform_key, entry in platforms.items():
        url = entry["url"]
        if " " in url or url != url.strip():
            raise SystemExit(
                f"{label} BUG: {platform_key} url contains whitespace ({url!r}) — a client "
                f"rejects it outright and the updater would silently read the failure as "
                f"'up to date' (WI-4364)"
            )
        parts = urlsplit(url)
        if not parts.scheme or not parts.path:
            raise SystemExit(
                f"{label} BUG: {platform_key} url does not round-trip urlsplit() ({url!r}) "
                f"— refusing to publish an unfetchable manifest (WI-4364)"
            )

pub_date = __import__("datetime").datetime.utcnow().isoformat(timespec="seconds") + "Z"

manifest = {
    "version": version,
    "channel": channel,
    "notes": f"Papercusp desktop {version} ({channel}). See release notes.",
    "pub_date": pub_date,
    "platforms": gui_platforms,
}
pathlib.Path(out_path).write_text(json.dumps(manifest, indent=2) + "\n")

# Only emit latest-server.json when this cut actually produced Server-role
# artifacts (PAPERCUSP_BUILD_ROLES="gui" builds skip Server entirely) — an
# empty-platforms manifest would make every Server poll read as "up to date"
# just as convincingly as no manifest at all, but writing NOTHING here instead
# leaves the PREVIOUS cut's latest-server.json live on the host (upload-
# release.sh only uploads what release-local.sh actually produced), so a
# Server-only build never regresses to a false up-to-date.
try:
    pathlib.Path(out_server_path).unlink()
except FileNotFoundError:
    pass
if server_platforms:
    server_manifest = {
        "version": version,
        "channel": channel,
        "notes": f"Papercusp Server {version} ({channel}). See release notes.",
        "pub_date": pub_date,
        "platforms": server_platforms,
    }
    pathlib.Path(out_server_path).write_text(json.dumps(server_manifest, indent=2) + "\n")
else:
    print("==> no Server-role artifacts in this cut — latest-server.json NOT written "
          "(the host keeps serving its previous one, if any)")

# Brief release notes
lines = [
    f"# Papercusp desktop {version} — {channel}",
    "",
    f"Channel: **{channel}**",
    "",
    "## Artifacts",
]
for a in artifacts:
    sha = hashlib.sha256(a.read_bytes()).hexdigest()[:12] if a.is_file() else ""
    lines.append(f"- `{a.name}`  ({a.stat().st_size // 1024} KB, sha256:{sha}…)")
pathlib.Path(notes_path).write_text("\n".join(lines) + "\n")
print(f"manifest: {out_path}")
print(f"notes:    {notes_path}")
if not UPDATE_BASE:
    print(
        "\n"
        "  ⚠ WARNING: PAPERCUSP_UPDATE_BASE_URL is unset, so latest.json's (and\n"
        "    latest-server.json's, if written) download URLs are the placeholder " + PLACEHOLDER + "/...\n"
        "    The INSTALLERS below are complete and shippable — this only affects the\n"
        "    auto-updater manifest. Before latest.json is SERVED to clients, re-run with\n"
        "    PAPERCUSP_UPDATE_BASE_URL=<base the artifacts are uploaded to>, or rewrite\n"
        "    the urls in place. Serving it as-is means every update check fails.\n",
        file=sys.stderr,
    )
PY
}
