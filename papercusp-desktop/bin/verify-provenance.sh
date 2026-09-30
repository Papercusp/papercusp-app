#!/usr/bin/env bash
# P-010 (desktop-build-hardening-tri-platform-2026-07-11): release:verify-provenance,
# as an executable check. Given a directory of built release artifacts + their
# build-provenance.json (emitted by bin/emit-build-provenance.sh), assert every
# dimension that must hold for the bytes to be safe to ship — encoding EI-8914
# (LABELED != PACKED) as a gate a bad build physically cannot pass:
#
#   1. gitDirty == false             — the source accepted at cut START was
#      clean. gitDirtyAtEmit is diagnostic only: the cutter legitimately dirties
#      tracked version/env-sidecar staging before provenance is emitted.
#   2. buildSha == live /api/health  — the running operator IS this artifact
#      sha (when a --health-sha/--health-url is supplied; the post-install proof).
#   3. each artifact's sha256 == the value recorded in build-provenance.json
#      (the core LABELED != PACKED check: the shipped bytes are the recorded bytes).
#   4. the SIGNATURE dimension (D-004) — the updater's REAL trust check:
#      (a) each artifact's minisign .sig verifies against the embedded pubkey
#          (via bin/verify-tauri-signature.mjs — no external minisign needed); and
#      (b) if a latest.json manifest is present, every per-platform url references
#          an artifact whose sha256 was verified AND its signature field equals
#          that artifact's on-disk .sig — so the manifest cannot point the updater
#          at a different/stale file than the one we just verified; the platform
#          key must also match the artifact family/architecture the updater can
#          consume (a signed artifact under the wrong canonical key is still dead).
#
# Verification standard (D-007, VMs unavailable): this script is `bash -n`-clean,
# functionally tested against synthetic fixtures covering every failure branch,
# and smoke-run against REAL 0.0.7 artifact bytes + their real signatures.
#
# Usage:
#   verify-provenance.sh ARTIFACT_DIR [options]
# Options:
#   --health-sha SHA     assert build-provenance.buildSha == SHA (the live health sha)
#   --health-url URL     curl URL and extract .sha, then assert equality (URL is the
#                        full /api/health endpoint, e.g. http://127.0.0.1:3070/api/health)
#   --latest-json PATH   cross-check this manifest (default: ARTIFACT_DIR/latest.json if present)
#   --pubkey VALUE|PATH  minisign pubkey for the sig check (default: plugins.updater.pubkey
#                        from src-tauri/tauri.conf.json)
#   --require-signed     require .sig for published artifacts in the D-019 signable suffix set
#                        (default: verify sigs that exist)
#   --allow-dirty        don't fail when build-start gitDirty==true
#   --json               emit a machine-readable verdict to stdout
# Exit: 0 = all checks pass · 1 = a check failed · 2 = usage/setup error.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
NODE_HELPER="$HERE/verify-tauri-signature.mjs"
source "$HERE/lib/release-artifacts.sh"

DIR=""
HEALTH_SHA=""
HEALTH_URL=""
LATEST_JSON=""
PUBKEY=""
REQUIRE_SIGNED=0
ALLOW_DIRTY=0
JSON=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --health-sha) HEALTH_SHA="${2:-}"; shift 2 ;;
    --health-url) HEALTH_URL="${2:-}"; shift 2 ;;
    --latest-json) LATEST_JSON="${2:-}"; shift 2 ;;
    --pubkey) PUBKEY="${2:-}"; shift 2 ;;
    --require-signed) REQUIRE_SIGNED=1; shift ;;
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    --json) JSON=1; shift ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) [[ -z "$DIR" ]] && DIR="$1" || { echo "unexpected extra arg: $1" >&2; exit 2; }; shift ;;
  esac
done

[[ -n "$DIR" ]] || { echo "usage: verify-provenance.sh ARTIFACT_DIR [options]" >&2; exit 2; }
[[ -d "$DIR" ]] || { echo "ARTIFACT_DIR '$DIR' is not a directory" >&2; exit 2; }
[[ -f "$NODE_HELPER" ]] || { echo "signature verifier missing at $NODE_HELPER" >&2; exit 2; }

# Default the manifest to a co-located latest.json when the caller didn't name one.
if [[ -z "$LATEST_JSON" && -f "$DIR/latest.json" ]]; then LATEST_JSON="$DIR/latest.json"; fi

# Default the pubkey from the app's own updater config (single source of truth).
if [[ -z "$PUBKEY" ]]; then
  PUBKEY="$(python3 -c "import json;print(json.load(open('$ROOT/src-tauri/tauri.conf.json'))['plugins']['updater']['pubkey'])" 2>/dev/null || true)"
  [[ -n "$PUBKEY" ]] || { echo "could not read plugins.updater.pubkey from tauri.conf.json — pass --pubkey" >&2; exit 2; }
fi

# Resolve the live health sha from --health-url if given (and no explicit sha).
if [[ -z "$HEALTH_SHA" && -n "$HEALTH_URL" ]]; then
  HEALTH_RESPONSE_FILE="$(mktemp "${TMPDIR:-/tmp}/papercusp-health-response.XXXXXX")" || {
    echo "could not create temporary storage for --health-url response" >&2
    exit 2
  }
  HEALTH_HTTP_CODE=""
  if ! HEALTH_HTTP_CODE="$(curl --silent --show-error --max-time 8 \
      --output "$HEALTH_RESPONSE_FILE" --write-out '%{http_code}' "$HEALTH_URL")"; then
    rm -f -- "$HEALTH_RESPONSE_FILE"
    echo "could not fetch --health-url $HEALTH_URL" >&2
    exit 2
  fi
  if [[ ! "$HEALTH_HTTP_CODE" =~ ^2[0-9][0-9]$ ]]; then
    rm -f -- "$HEALTH_RESPONSE_FILE"
    echo "--health-url $HEALTH_URL returned HTTP $HEALTH_HTTP_CODE; refusing an error/redirect body as health evidence" >&2
    exit 2
  fi
  HEALTH_RESPONSE="$(<"$HEALTH_RESPONSE_FILE")"
  rm -f -- "$HEALTH_RESPONSE_FILE"
  HEALTH_SHA="$(printf '%s' "$HEALTH_RESPONSE" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("sha",""))' 2>/dev/null || true)"
  [[ -n "$HEALTH_SHA" ]] || { echo "could not fetch/parse a sha from --health-url $HEALTH_URL" >&2; exit 2; }
fi

PROV="$DIR/build-provenance.json"
[[ -f "$PROV" ]] || { echo "no build-provenance.json in $DIR — nothing to verify (unprovenanced artifacts)" >&2; exit 2; }

DIR="$DIR" PROV="$PROV" HEALTH_SHA="$HEALTH_SHA" LATEST_JSON="$LATEST_JSON" \
PUBKEY="$PUBKEY" NODE_HELPER="$NODE_HELPER" \
RELEASE_ARTIFACTS_SIGNABLE_SUFFIXES="$RELEASE_ARTIFACTS_SIGNABLE_SUFFIXES" \
REQUIRE_SIGNED="$REQUIRE_SIGNED" ALLOW_DIRTY="$ALLOW_DIRTY" JSON="$JSON" \
python3 <<'PY'
import os, sys, json, hashlib, subprocess, pathlib, re
from urllib.parse import unquote, urlsplit

DIR = pathlib.Path(os.environ["DIR"])
PROV = pathlib.Path(os.environ["PROV"])
ROOT_DIR = DIR.resolve()
HEALTH_SHA = os.environ.get("HEALTH_SHA", "")
LATEST_JSON = os.environ.get("LATEST_JSON", "")
PUBKEY = os.environ["PUBKEY"]
NODE_HELPER = os.environ["NODE_HELPER"]
REQUIRE_SIGNED = os.environ.get("REQUIRE_SIGNED") == "1"
ALLOW_DIRTY = os.environ.get("ALLOW_DIRTY") == "1"
AS_JSON = os.environ.get("JSON") == "1"
SIGNABLE_SUFFIXES = tuple(os.environ["RELEASE_ARTIFACTS_SIGNABLE_SUFFIXES"].split())

if not SIGNABLE_SUFFIXES:
    print("D-019 signable artifact suffix policy is empty", file=sys.stderr)
    sys.exit(2)

failures = []
notes = []

try:
    prov = json.loads(PROV.read_text())
except Exception as e:
    print(f"build-provenance.json is not valid JSON: {e}", file=sys.stderr)
    sys.exit(2)

if not isinstance(prov, dict):
    print("build-provenance.json must contain a JSON object", file=sys.stderr)
    sys.exit(2)

version = prov.get("version")
build_sha = prov.get("buildSha")
git_dirty = prov.get("gitDirty")
git_dirty_at_emit = prov.get("gitDirtyAtEmit")
reused = prov.get("reused", False)  # absent on pre-P-002 provenance ⇒ treat as fresh

# Release identity is not optional metadata.  Without a non-empty version or
# buildSha this record cannot say WHICH bytes were verified, and the optional
# health dimension is skipped when no --health-url/--health-sha is supplied.
# The old verifier therefore returned PASS while reporting version/buildSha as
# null — a provenance-shaped file with no release identity at all.  Reject
# missing, null, non-string, and blank values before any other dimension can
# make that incomplete record look authoritative.
if not isinstance(version, str) or not version.strip():
    failures.append(
        "version must be a non-empty string identifying the release; "
        f"got {version!r}"
    )
if not isinstance(build_sha, str) or not build_sha.strip():
    failures.append(
        "buildSha must be a non-empty string identifying the built operator; "
        f"got {build_sha!r}"
    )

# ── 1. build-start source cleanliness ──────────────────────────────────────
# This is an attestation, not a truthiness hint: only the JSON boolean false
# proves a clean cut start. Missing/null/string/numeric values are malformed and
# must not collapse into the same result. --allow-dirty overrides only an exact
# boolean true; it never turns an absent or wrongly typed attestation into proof.
if git_dirty is False:
    git_dirty_ok = True
elif git_dirty is True:
    git_dirty_ok = ALLOW_DIRTY
    if ALLOW_DIRTY:
        notes.append("gitDirty is true — accepted only because --allow-dirty was set")
    else:
        failures.append("gitDirty is true — release INPUT was dirty at cut start (pass --allow-dirty to override)")
else:
    git_dirty_ok = False
    failures.append(
        "gitDirty must be the JSON boolean false "
        f"(or true only with --allow-dirty); got {git_dirty!r}"
    )
if git_dirty_at_emit is True and git_dirty is False:
    notes.append("gitDirtyAtEmit is true — cutter-authored post-preflight mutations were present; build-start source remained clean")

# ── 2. buildSha == live health sha ──────────────────────────────────────────
if HEALTH_SHA:
    health_ok = (build_sha == HEALTH_SHA)
    if not health_ok:
        failures.append(f"buildSha {build_sha!r} != live /api/health sha {HEALTH_SHA!r} — the running operator is not this artifact")
else:
    health_ok = None
    notes.append("health-match dimension skipped (no --health-sha/--health-url) — cannot prove the running operator is this artifact")

# ── 3. each artifact's sha256 matches + 4a. its signature verifies ──────────
def sha256_file(p: pathlib.Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

def verify_sig(artifact: pathlib.Path, sig: pathlib.Path) -> bool:
    r = subprocess.run(["node", NODE_HELPER, PUBKEY, str(artifact), str(sig), "--json"],
                       capture_output=True, text=True)
    return r.returncode == 0

artifacts_report = []
prov_artifacts = prov.get("artifacts") or []
if not isinstance(prov_artifacts, list):
    failures.append("build-provenance.json artifacts must be an array of object rows")
    prov_artifacts = []
elif not prov_artifacts:
    failures.append("build-provenance.json lists no artifacts — nothing to verify")

verified_names = set()          # names whose sha256 matched (D-004b anchors on these)
sig_content_by_name = {}        # name → on-disk .sig text (D-004b compares to manifest)

def safe_artifact_path(name):
    """Resolve one provenance name without permitting checkout escape.

    Provenance is a relative manifest, not an arbitrary filesystem lookup.  The
    previous `DIR / name` expression allowed `../outside` and absolute names (and
    followed symlinks out of DIR), so a forged record could make the verifier
    certify bytes it was never given.  Validate both POSIX and Windows path
    semantics because the same record is consumed on all three release hosts,
    then resolve and enforce containment as a symlink-safe backstop.
    """
    if not isinstance(name, str) or not name or "\x00" in name:
        failures.append(f"artifact name must be a non-empty path-safe string; got {name!r}")
        return None
    posix = pathlib.PurePosixPath(name)
    windows = pathlib.PureWindowsPath(name)
    if (
        posix.is_absolute()
        or windows.is_absolute()
        or bool(windows.anchor)
        or "\\" in name
        or ".." in posix.parts
        or ".." in windows.parts
        or "." in posix.parts
        or "." in windows.parts
    ):
        failures.append(
            f"artifact {name!r} has an unsafe path; provenance names must be relative "
            "to ARTIFACT_DIR and cannot contain absolute roots, backslashes, or dot components"
        )
        return None
    candidate = (DIR / pathlib.Path(*posix.parts)).resolve()
    try:
        candidate.relative_to(ROOT_DIR)
    except ValueError:
        failures.append(f"artifact {name!r} resolves outside ARTIFACT_DIR")
        return None
    return candidate

artifact_names = set()
for a in prov_artifacts:
    if not isinstance(a, dict):
        failures.append("provenance artifacts must contain only object rows")
        artifacts_report.append({"name": None, "present": False, "sha256Ok": None, "sigOk": None})
        continue
    name = a.get("name")
    recorded = a.get("sha256")
    recorded_bytes = a.get("bytes")
    recorded_sig = a.get("sig")
    path = safe_artifact_path(name)
    if path is None:
        artifacts_report.append({"name": name, "present": False, "sha256Ok": None, "sigOk": None})
        continue
    if name in artifact_names:
        failures.append(f"provenance contains duplicate artifact row {name!r}")
    artifact_names.add(name)
    row_schema_ok = True
    if type(recorded_bytes) is not int or recorded_bytes < 0:
        failures.append(
            f"artifact {name!r} bytes must be a non-negative integer; got {recorded_bytes!r}"
        )
        row_schema_ok = False
    sha_schema_ok = (
        isinstance(recorded, str)
        and len(recorded) == 64
        and all(c in "0123456789abcdefABCDEF" for c in recorded)
    )
    if not sha_schema_ok:
        failures.append(
            f"artifact {name!r} sha256 must be a 64-character hex string; got {recorded!r}"
        )
        row_schema_ok = False
    if type(recorded_sig) is not bool:
        failures.append(
            f"artifact {name!r} sig must be a JSON boolean; got {recorded_sig!r}"
        )
        row_schema_ok = False
    entry = {
        "name": name,
        "present": path.is_file(),
        "bytesOk": None,
        "sha256Ok": None,
        "sigOk": None,
    }
    if not path.is_file():
        failures.append(f"artifact {name!r} recorded in provenance is missing from {DIR}")
        artifacts_report.append(entry)
        continue
    actual_bytes = path.stat().st_size
    entry["bytesOk"] = type(recorded_bytes) is int and actual_bytes == recorded_bytes
    if not entry["bytesOk"]:
        failures.append(
            f"artifact {name!r} bytes {actual_bytes} != recorded {recorded_bytes} (LABELED!=PACKED)"
        )
    actual = sha256_file(path)
    entry["sha256Ok"] = sha_schema_ok and actual.lower() == recorded.lower()
    if not entry["sha256Ok"]:
        failures.append(f"artifact {name!r} sha256 {actual} != recorded {recorded} (LABELED!=PACKED)")
    elif row_schema_ok and entry["bytesOk"]:
        verified_names.add(name)
    # 4a. signature
    sig = pathlib.Path(str(path) + ".sig")
    if sig.is_file():
        sig_content_by_name[name] = sig.read_text().strip()
        entry["sigOk"] = verify_sig(path, sig)
        if not entry["sigOk"]:
            failures.append(f"artifact {name!r} signature ({sig.name}) does not verify against the embedded pubkey")
    else:
        entry["sigOk"] = "absent"
        if a.get("sig") is True:
            # WI-4243: the emitter recorded a co-located .sig at build time —
            # its absence now means the signature was stripped/lost in transit.
            failures.append(f"artifact {name!r}: provenance records a .sig but none is co-located (signature stripped?)")
        elif REQUIRE_SIGNED and any(name.endswith(suffix) for suffix in SIGNABLE_SUFFIXES):
            failures.append(f"artifact {name!r} has no .sig and --require-signed was set")
        elif REQUIRE_SIGNED:
            notes.append(f"artifact {name!r} is outside the D-019 published signable set — signature not required")
        else:
            notes.append(f"artifact {name!r} has no co-located .sig — signature not checked")
    artifacts_report.append(entry)

# ── 4b. latest.json manifest cross-check ────────────────────────────────────
manifest_report = None
if LATEST_JSON:
    lp = pathlib.Path(LATEST_JSON)
    if not lp.is_file():
        failures.append(f"--latest-json {LATEST_JSON} does not exist")
    else:
        try:
            manifest = json.loads(lp.read_text())
        except Exception as e:
            failures.append(f"latest.json is not valid JSON: {e}")
            manifest = None
        if manifest is not None:
            manifest_report = {}
            if not isinstance(manifest, dict):
                failures.append("latest.json must be a JSON object")
                manifest = {}

            # A signed filename identifies bytes, but the updater consumes the
            # whole URL. Bind the URL's release-tag segment to the manifest's
            # version/channel before accepting a row; otherwise a byte-identical
            # artifact can be certified under a stale release path. The download
            # host/base is intentionally not checked here: release-host.sh keeps
            # the baked poll host and movable artifact CDN as separate knobs.
            manifest_version = manifest.get("version")
            manifest_channel = manifest.get("channel")
            expected_release_tag = None
            if manifest_version != version:
                failures.append(
                    f"latest.json version {manifest_version!r} does not match "
                    f"build-provenance version {version!r}"
                )
            if manifest_channel not in ("alpha", "beta", "stable", "nightly"):
                failures.append(
                    "latest.json channel must be alpha|beta|stable|nightly; "
                    f"got {manifest_channel!r}"
                )
            elif isinstance(version, str) and version.strip():
                suffix = "" if manifest_channel == "stable" else f"-{manifest_channel}"
                expected_release_tag = f"desktop-v{version}{suffix}"

            platforms = manifest.get("platforms")
            if not isinstance(platforms, dict) or not platforms:
                # An empty (or malformed) platform map is not a harmless
                # partial manifest: updater clients interpret it as "no update"
                # and report themselves up to date. The manifest generator
                # therefore omits an unready product instead of writing one.
                failures.append(
                    "latest.json must contain a non-empty platforms object — "
                    "an empty or malformed map makes updater clients falsely read up to date"
                )
                platforms = {}
            # The updater resolves a deliberately closed set of platform keys.
            # A manifest may contain a SUBSET while a multi-platform cut is
            # still being assembled, but an arbitrary key is not a harmless
            # extension: clients skip it and can report themselves up to date
            # while the verifier has certified a release with no usable target.
            # Keep this list in lockstep with gen-latest-manifest.sh and the
            # updater's platform resolver; reject aliases such as linux-x64.
            canonical_platform_keys = (
                "linux-x86_64",
                "linux-aarch64",
                "windows-x86_64",
                "darwin-x86_64",
                "darwin-aarch64",
            )
            canonical_platform_key_set = set(canonical_platform_keys)

            def artifact_matches_platform(platform_key, artifact_name):
                """Match a manifest key to the updater artifact shape it serves.

                The generator emits AppImages for Linux, setup/zip/MSI bundles
                for Windows, and one universal .app.tar.gz for both Darwin
                keys. Keep the architecture distinction for Linux because an
                arm bundle is not runnable by an x86 updater (and vice versa).
                """
                lower_name = artifact_name.lower()
                if platform_key == "linux-x86_64":
                    return (
                        lower_name.endswith(".appimage")
                        and "aarch64" not in lower_name
                        and "arm64" not in lower_name
                    )
                if platform_key == "linux-aarch64":
                    return (
                        lower_name.endswith(".appimage")
                        and ("aarch64" in lower_name or "arm64" in lower_name)
                    )
                if platform_key == "windows-x86_64":
                    return lower_name.endswith(("-setup.exe", "-setup.zip", ".msi"))
                if platform_key in ("darwin-x86_64", "darwin-aarch64"):
                    return lower_name.endswith(".app.tar.gz")
                return False

            # WI-4243: provenance names may carry a subdir (e.g. "deb/App.deb");
            # a manifest URL carries the basename. Refuse an ambiguous duplicate
            # instead of silently taking whichever provenance row appeared first.
            prov_names_by_base = {}
            for a in prov_artifacts:
                n = a.get("name") if isinstance(a, dict) else None
                if isinstance(n, str) and n:
                    prov_names_by_base.setdefault(n.rsplit("/", 1)[-1], set()).add(n)
            for platform_key, meta in platforms.items():
                ok = True
                base = ""
                if platform_key not in canonical_platform_key_set:
                    failures.append(
                        f"latest.json[{platform_key}] uses unsupported platform key; "
                        f"expected one of {', '.join(canonical_platform_keys)}"
                    )
                    manifest_report[platform_key] = {
                        "url_basename": base,
                        "ok": False,
                    }
                    continue
                if not isinstance(meta, dict):
                    failures.append(
                        f"latest.json[{platform_key}] must be an object with url + signature"
                    )
                    manifest_report[platform_key] = {"url_basename": base, "ok": False}
                    continue

                url = meta.get("url")
                signature = meta.get("signature")
                sig_field = signature.strip() if isinstance(signature, str) else ""
                if not isinstance(signature, str) or not signature.strip():
                    failures.append(
                        f"latest.json[{platform_key}] signature must be a non-empty string"
                    )
                    ok = False

                observed_tag = None
                if (
                    not isinstance(url, str)
                    or not url
                    or url != url.strip()
                    or any(character.isspace() for character in url)
                ):
                    failures.append(
                        f"latest.json[{platform_key}] url must be a non-empty URL string "
                        "without whitespace"
                    )
                    ok = False
                else:
                    try:
                        parts = urlsplit(url)
                        # Accessing hostname/port performs additional authority
                        # validation (e.g. malformed IPv6 or nonnumeric ports).
                        hostname = parts.hostname
                        _ = parts.port
                    except (TypeError, ValueError, UnicodeError) as e:
                        failures.append(
                            f"latest.json[{platform_key}] url is malformed: {e}"
                        )
                        parts = None
                        hostname = None
                        ok = False

                    if parts is not None:
                        if (
                            parts.scheme.lower() not in ("http", "https")
                            or not hostname
                            or parts.username is not None
                            or parts.password is not None
                            or parts.query
                            or parts.fragment
                            or not parts.path.startswith("/")
                        ):
                            failures.append(
                                f"latest.json[{platform_key}] url must be an absolute HTTP(S) "
                                "artifact URL without credentials, query, or fragment"
                            )
                            ok = False

                        raw_segments = parts.path[1:].split("/") if parts.path.startswith("/") else []
                        if len(raw_segments) < 2 or any(segment == "" for segment in raw_segments):
                            failures.append(
                                f"latest.json[{platform_key}] url path must end in "
                                "<release-tag>/<artifact-name> without empty segments"
                            )
                            ok = False
                        else:
                            if any(
                                not re.fullmatch(r"(?:[^%]|%[0-9A-Fa-f]{2})*", segment)
                                for segment in raw_segments
                            ):
                                failures.append(
                                    f"latest.json[{platform_key}] url path contains malformed "
                                    "percent-encoding"
                                )
                                decoded_segments = []
                                ok = False
                            else:
                                try:
                                    decoded_segments = [
                                        unquote(segment, errors="strict") for segment in raw_segments
                                    ]
                                except (UnicodeError, ValueError) as e:
                                    failures.append(
                                        f"latest.json[{platform_key}] url path encoding is malformed: {e}"
                                    )
                                    decoded_segments = []
                                    ok = False

                            if decoded_segments:
                                observed_tag = decoded_segments[-2]
                                base = decoded_segments[-1]
                                if any(
                                    segment in (".", "..")
                                    or "/" in segment
                                    or "\\" in segment
                                    or "\x00" in segment
                                    for segment in decoded_segments
                                ):
                                    failures.append(
                                        f"latest.json[{platform_key}] url path contains an "
                                        "unsafe dot or separator segment"
                                    )
                                    ok = False
                                if (
                                    not base
                                    or "/" in base
                                    or "\\" in base
                                    or base in (".", "..")
                                ):
                                    failures.append(
                                        f"latest.json[{platform_key}] url artifact name is not a safe basename"
                                    )
                                    ok = False
                                if (
                                    expected_release_tag is not None
                                    and observed_tag != expected_release_tag
                                ):
                                    failures.append(
                                        f"latest.json[{platform_key}] release tag {observed_tag!r} "
                                        f"does not match expected {expected_release_tag!r}"
                                    )
                                    ok = False

                names = prov_names_by_base.get(base, set())
                if len(names) > 1:
                    failures.append(
                        f"latest.json[{platform_key}] url basename {base!r} is ambiguous "
                        f"across {len(names)} provenance rows"
                    )
                name = next(iter(names)) if len(names) == 1 else None
                if name is None:
                    failures.append(f"latest.json[{platform_key}] url {base!r} is not an artifact in this provenance"); ok = False
                else:
                    if not artifact_matches_platform(platform_key, name):
                        failures.append(
                            f"latest.json[{platform_key}] artifact {name!r} is incompatible "
                            "with this platform key"
                        )
                        ok = False
                    if name not in verified_names:
                        failures.append(f"latest.json[{platform_key}] points at {base!r} whose sha256 did not verify"); ok = False
                    else:
                        disk_sig = sig_content_by_name.get(name)
                        if disk_sig is None:
                            failures.append(f"latest.json[{platform_key}] references {base!r} but it has no on-disk .sig to compare"); ok = False
                        elif sig_field != disk_sig:
                            failures.append(f"latest.json[{platform_key}] signature does not match {base}.sig (manifest points at different/stale bytes)"); ok = False
                manifest_report[platform_key] = {"url_basename": base, "ok": ok}

ok = len(failures) == 0
verdict = {
    "ok": ok,
    "dir": str(DIR),
    "version": version,
    "buildSha": build_sha,
    "gitDirty": git_dirty,
    "gitDirtyOk": git_dirty_ok,
    "gitDirtyAtEmit": git_dirty_at_emit,
    "reused": reused,
    "healthMatch": health_ok,
    "artifacts": artifacts_report,
    "manifest": manifest_report,
    "failures": failures,
    "notes": notes,
}

if AS_JSON:
    print(json.dumps(verdict, indent=2))
else:
    print(f"verify-provenance: {'PASS' if ok else 'FAIL'}  version={version} buildSha={build_sha} gitDirty={git_dirty} reused={reused}")
    for e in artifacts_report:
        print(f"  artifact {e['name']}: present={e['present']} sha256Ok={e['sha256Ok']} sigOk={e['sigOk']}")
    if health_ok is None:
        print("  health-match: SKIPPED")
    else:
        print(f"  health-match: {'OK' if health_ok else 'MISMATCH'}")
    if manifest_report is not None:
        for k, v in manifest_report.items():
            print(f"  manifest[{k}]: {v['url_basename']} ok={v['ok']}")
    for n in notes:
        print(f"  note: {n}")
    for f in failures:
        print(f"  FAIL: {f}")

sys.exit(0 if ok else 1)
PY
