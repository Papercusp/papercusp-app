#!/usr/bin/env bash
# release-artifacts.sh — the SINGLE source of truth for "which files make up this
# desktop cut", shared by the two halves of the release pipeline (EI-12913).
#
# THE BUG THIS FIXES: release-local.sh (the BUILD half) and upload-release.sh
# (the PUBLISH half) each decided INDEPENDENTLY which files were "this cut's
# artifacts", and the two decisions DRIFTED:
#   - release-local.sh globs
#     $ROOT/src-tauri/target/windows-vm/bundle/inno/*_<ver>_* — the real Inno
#     output tree — catching the -setup.exe, its .sig, AND the DiskSpanning .bin
#     slices. (A Server installer's ~4 GB payload lives ENTIRELY in those .bin
#     slices: src-tauri/windows/inno/papercusp.iss sets DiskSpanning=yes, so the
#     .exe is a ~3.6 MB stub that is useless without the .bin files next to it.)
#   - upload-release.sh re-derived its OWN set with a `find` over
#     ~/.cargo-target/release/bundle/{deb,appimage,dmg,macos,nsis,msi} — which has
#     no `inno` dir at all and still names `nsis`, the retired packager — plus an
#     extension allowlist that EXCLUDED `.bin`. So it could not see the windows
#     artifacts, and even where it could it would have dropped every Server .bin
#     slice — publishing a stub whose payload is missing (Inno then prompts for
#     the absent slices and the install fails).
# Two scripts, two globs, one drifts → the LABELED != PACKED failure class. The
# durable fix is to STOP re-deriving: release-local.sh (which already computes the
# correct set) WRITES it here, and upload-release.sh READS it — one list, no drift.
# Fixing only the `.bin` regex would leave the wrong-tree gap armed for the next
# packager change; sharing the list closes the whole class.
#
# The manifest lives next to latest.json in /tmp (same TAG-scoped, same ephemeral
# lifecycle: if one is gone the other is, and you re-cut anyway).

# release_artifacts_manifest_path <tag> — the manifest file path for a cut.
release_artifacts_manifest_path() {
  printf '/tmp/papercusp-artifacts-%s.txt\n' "$1"
}

# release_artifacts_cut_start_path <tag> — the cut-start freshness stamp shared
# by release-local.sh, direct platform producers, incremental publishing, and
# upload.  Keep it beside the artifact manifest in /tmp: both are tag-scoped
# hand-off state, and a missing stamp must fail closed rather than silently
# accepting a same-version artifact left by a failed earlier cut.
release_artifacts_cut_start_path() {
  printf '/tmp/papercusp-cut-start-%s.txt\n' "$1"
}

release_artifacts_cut_start_now_ns() {
  local now
  now="$(date -u +%s%N 2>/dev/null || true)"
  if [[ "$now" =~ ^[0-9]{19}$ ]]; then
    printf '%s\n' "$now"
    return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import time; print(time.time_ns())'
    return $?
  fi
  # Last-resort portability fallback for a host with neither GNU date nor
  # Python.  It intentionally has second precision and therefore fails closed
  # for artifacts whose mtime lands in the same second as the cut start.
  now="$(date -u +%s 2>/dev/null || true)"
  [[ "$now" =~ ^[0-9]+$ ]] || {
    echo "release-artifacts: cannot obtain a UTC cut-start timestamp." >&2
    return 1
  }
  printf '%s000000000\n' "$now"
}

# release_artifacts_cut_start_write <tag> [epoch-ns] — atomically replace the
# tag's start stamp and print the value exported to child producers.
release_artifacts_cut_start_write() {
  local tag="${1:-}" stamp="${2:-}" path tmp
  [[ -n "$tag" ]] || { echo "release-artifacts: cut-start stamp requires a tag." >&2; return 2; }
  [[ -n "$stamp" ]] || stamp="$(release_artifacts_cut_start_now_ns)" || return 1
  [[ "$stamp" =~ ^[0-9]+$ ]] || {
    echo "release-artifacts: malformed cut-start timestamp '$stamp'." >&2
    return 2
  }
  path="$(release_artifacts_cut_start_path "$tag")"
  tmp="$(mktemp "${path}.tmp.XXXXXX")" || {
    echo "release-artifacts: could not create temporary cut-start stamp for $tag." >&2
    return 1
  }
  if ! printf '%s\n' "$stamp" > "$tmp" || ! mv -f "$tmp" "$path"; then
    rm -f "$tmp"
    echo "release-artifacts: could not persist cut-start stamp at $path." >&2
    return 1
  fi
  printf '%s\n' "$stamp"
}

# release_artifacts_cut_start_read <tag> — read one valid epoch-ns stamp. A
# missing, multi-line, or malformed stamp is an error; callers must not mint a
# replacement while deciding whether an existing artifact is safe to publish.
release_artifacts_cut_start_read() {
  local tag="${1:-}" path stamp line
  local -a lines=()
  [[ -n "$tag" ]] || { echo "release-artifacts: cut-start stamp requires a tag." >&2; return 2; }
  path="$(release_artifacts_cut_start_path "$tag")"
  [[ -f "$path" ]] || {
    echo "release-artifacts: no cut-start stamp at $path — refusing to trust same-version artifacts." >&2
    return 1
  }
  while IFS= read -r line || [[ -n "$line" ]]; do
    lines+=("$line")
  done < "$path" || {
    echo "release-artifacts: could not read cut-start stamp at $path." >&2
    return 1
  }
  [[ ${#lines[@]} -eq 1 ]] || {
    echo "release-artifacts: malformed cut-start stamp at $path — expected one epoch-ns value." >&2
    return 1
  }
  stamp="${lines[0]}"
  [[ "$stamp" =~ ^[0-9]+$ ]] || {
    echo "release-artifacts: malformed cut-start stamp at $path — expected epoch nanoseconds." >&2
    return 1
  }
  printf '%s\n' "$stamp"
}

# release_artifacts_cut_start_ensure <tag> — preserve an existing valid cut
# start for incremental platform additions; create one only for a first-class
# direct producer/publish path that has no prior stamp. Never overwrite a
# malformed existing stamp: that would turn a fail-closed hand-off into a pass.
release_artifacts_cut_start_ensure() {
  local tag="${1:-}" path
  [[ -n "$tag" ]] || { echo "release-artifacts: cut-start stamp requires a tag." >&2; return 2; }
  path="$(release_artifacts_cut_start_path "$tag")"
  if [[ -e "$path" ]]; then
    release_artifacts_cut_start_read "$tag"
  else
    release_artifacts_cut_start_write "$tag"
  fi
}

# ── Content-bound platform smoke receipts ───────────────────────────────────
# A build result is not a smoke result.  Keep the live install/flip proof beside
# the artifact ledger, bound to the exact provenance-listed bytes, so neither a
# copied receipt nor a same-version rebuild can authorize different payloads.

release_artifacts_smoke_receipt_root() {
  printf '%s\n' "${PAPERCUSP_SMOKE_RECEIPT_ROOT:-/tmp}"
}

# release_artifacts_smoke_receipt_path <tag> <platform>
release_artifacts_smoke_receipt_path() {
  local tag="${1:-}" platform="${2:-}" root
  [[ "$tag" =~ ^[A-Za-z0-9._-]+$ ]] || {
    echo "release-artifacts: smoke receipt requires a safe non-empty tag (got '$tag')." >&2
    return 2
  }
  case "$platform" in
    linux|windows|mac) ;;
    *) echo "release-artifacts: smoke receipt platform must be linux|windows|mac (got '$platform')." >&2; return 2 ;;
  esac
  root="$(release_artifacts_smoke_receipt_root)"
  printf '%s/papercusp-smoke-%s-%s.json\n' "${root%/}" "$tag" "$platform"
}

# release_artifacts_smoke_receipt_write
#   <tag> <version> <platform> <verifier> <build-sha> <build-provenance.json>
#   <artifact-that-was-actually-exercised>...
#
# The receipt includes EVERY artifact in the build provenance, while separately
# naming the installer(s) the verifier actually exercised.  That distinction is
# load-bearing: macOS/Linux publish updater containers alongside their installed
# DMG/deb, and a receipt may bind those sibling bytes without claiming each
# container was itself launched.  Every provenance row is re-hashed here; an
# absent/mutated sibling makes receipt creation fail rather than quietly reducing
# the attested set.  A durable copy is written beside build-provenance.json and a
# tag-scoped hand-off copy is written beside the /tmp artifact ledger.
release_artifacts_smoke_receipt_write() {
  local tag="${1:-}" version="${2:-}" platform="${3:-}" verifier="${4:-}"
  local build_sha="${5:-}" provenance="${6:-}" out root
  shift 6 2>/dev/null || {
    echo "release-artifacts: smoke receipt writer requires tag, version, platform, verifier, build sha, provenance, and exercised artifacts." >&2
    return 2
  }
  [[ -n "$version" && -n "$verifier" && -n "$build_sha" ]] || {
    echo "release-artifacts: smoke receipt writer requires non-empty version, verifier, and build sha." >&2
    return 2
  }
  [[ -f "$provenance" ]] || {
    echo "release-artifacts: smoke receipt requires build provenance (missing: $provenance)." >&2
    return 1
  }
  [[ $# -gt 0 ]] || {
    echo "release-artifacts: smoke receipt requires at least one actually-exercised artifact." >&2
    return 2
  }
  out="$(release_artifacts_smoke_receipt_path "$tag" "$platform")" || return $?
  root="$(dirname "$out")"
  mkdir -p "$root" || {
    echo "release-artifacts: cannot create smoke receipt root $root." >&2
    return 1
  }

  python3 - "$out" "$tag" "$version" "$platform" "$verifier" "$build_sha" "$provenance" "$@" <<'PY'
import datetime
import fcntl
import hashlib
import json
import os
import pathlib
import tempfile
import sys

out, tag, version, platform, verifier, build_sha, provenance, *exercised = sys.argv[1:]
prov_path = pathlib.Path(provenance).resolve()
try:
    data = json.loads(prov_path.read_text(encoding="utf-8"))
except Exception as exc:
    raise SystemExit(f"release-artifacts: unreadable build provenance {prov_path}: {exc}")

if data.get("version") != version:
    raise SystemExit(
        f"release-artifacts: smoke provenance version mismatch: "
        f"{data.get('version')!r} != {version!r}"
    )
if data.get("buildSha") != build_sha:
    raise SystemExit(
        f"release-artifacts: smoke provenance buildSha mismatch: "
        f"{data.get('buildSha')!r} != {build_sha!r}"
    )

def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

rows = []
for raw in data.get("artifacts") or []:
    if not isinstance(raw, dict):
        raise SystemExit("release-artifacts: smoke provenance contains a non-object artifact row")
    name = raw.get("name")
    declared_sha = raw.get("sha256")
    declared_bytes = raw.get("bytes")
    if not isinstance(name, str) or not name or not isinstance(declared_sha, str):
        raise SystemExit("release-artifacts: smoke provenance artifact requires name and sha256")
    if not isinstance(declared_bytes, int) or declared_bytes < 0:
        raise SystemExit(
            f"release-artifacts: smoke provenance artifact requires a non-negative bytes count: {name!r}"
        )
    relative = pathlib.PurePosixPath(name)
    if relative.is_absolute() or ".." in relative.parts or "\\" in name:
        raise SystemExit(f"release-artifacts: unsafe provenance artifact name: {name!r}")
    path = (prov_path.parent / pathlib.Path(*relative.parts)).resolve()
    try:
        path.relative_to(prov_path.parent)
    except ValueError:
        raise SystemExit(f"release-artifacts: provenance artifact escapes its root: {name!r}")
    if not path.is_file():
        raise SystemExit(f"release-artifacts: provenance-listed smoke artifact is missing: {path}")
    size = path.stat().st_size
    actual_sha = digest(path)
    if declared_bytes != size:
        raise SystemExit(
            f"release-artifacts: provenance byte count is stale for {name}: "
            f"{declared_bytes!r} != {size}"
        )
    if actual_sha != declared_sha:
        raise SystemExit(
            f"release-artifacts: provenance sha256 is stale for {name}: "
            f"{declared_sha} != {actual_sha}"
        )
    rows.append({"name": name, "bytes": size, "sha256": actual_sha})

if not rows:
    raise SystemExit("release-artifacts: smoke provenance names no artifacts")

exercised_rows = []
for raw_path in exercised:
    path = pathlib.Path(raw_path).resolve()
    if not path.is_file():
        raise SystemExit(f"release-artifacts: exercised smoke artifact is missing: {path}")
    actual_sha = digest(path)
    matches = [
        row for row in rows
        if pathlib.PurePosixPath(row["name"]).name == path.name
        and row["bytes"] == path.stat().st_size
        and row["sha256"] == actual_sha
    ]
    if not matches:
        raise SystemExit(
            f"release-artifacts: exercised artifact {path.name!r} is not bound by "
            f"the supplied provenance"
        )
    exercised_rows.append({
        "name": matches[0]["name"],
        "bytes": path.stat().st_size,
        "sha256": actual_sha,
    })

receipt = {
    "schemaVersion": "papercusp-platform-smoke/v1",
    "result": "pass",
    "tag": tag,
    "version": version,
    "platform": platform,
    "buildSha": build_sha,
    "verifier": verifier,
    "verifiedAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(
        timespec="seconds"
    ).replace("+00:00", "Z"),
    "provenance": prov_path.name,
    "exercisedArtifacts": sorted(exercised_rows, key=lambda row: row["name"]),
    "artifacts": sorted(rows, key=lambda row: row["name"]),
}
payload = json.dumps(receipt, indent=2, sort_keys=True) + "\n"

def atomic_write(destination, contents):
    destination = pathlib.Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(
        prefix=destination.name + ".tmp.", dir=str(destination.parent)
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(contents)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise

# The provenance-adjacent copy is the durable audit artifact.  Windows smoke
# also advances a monotonic, host-wide success watermark in the release
# retention root; per-build receipts alone cannot detect that all smoke runs
# have stopped.  Persist the watermark before authorizing this cut with receipts.
if platform == "windows":
    retention_root = pathlib.Path(
        os.environ.get(
            "PAPERCUSP_RELEASE_RETENTION_ROOT",
            str(pathlib.Path.home() / ".papercusp" / "release-retention"),
        )
    )
    watermark_path = retention_root / "latest-windows-smoke.json"
    lock_path = retention_root / "latest-windows-smoke.lock"
    watermark = {
        "schemaVersion": "papercusp-windows-smoke-success/v1",
        "result": "pass",
        "platform": "windows",
        "tag": tag,
        "version": version,
        "buildSha": build_sha,
        "verifiedAtUtc": receipt["verifiedAtUtc"],
    }
    watermark_payload = json.dumps(watermark, indent=2, sort_keys=True) + "\n"
    retention_root.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+") as lock_handle:
        fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX)
        current_verified = datetime.datetime.fromisoformat(
            receipt["verifiedAtUtc"].replace("Z", "+00:00")
        )
        try:
            previous = json.loads(watermark_path.read_text(encoding="utf-8"))
            previous_stamp = previous.get("verifiedAtUtc")
            previous_verified = datetime.datetime.fromisoformat(
                previous_stamp.replace("Z", "+00:00")
            ) if isinstance(previous_stamp, str) else None
            if previous_verified is not None and previous_verified.tzinfo is None:
                previous_verified = None
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            previous_verified = None
        if previous_verified is None or current_verified >= previous_verified:
            atomic_write(watermark_path, watermark_payload)

# The /tmp hand-off is written last so a failed durable write can never leave a
# newly-authorizing per-build receipt behind.
sibling = prov_path.parent / f"platform-smoke-{tag}-{platform}.json"
atomic_write(sibling, payload)
atomic_write(out, payload)
print(out)
PY
}

# release_artifacts_assert_platform_smoke_receipt
#   <tag> <version> <platform> <artifact...>
# Re-hash every publishable artifact.  A Windows spanned-Server zip is accepted
# only when every contained file is individually bound by the receipt; zip
# container metadata may differ, but the exact stub+slices exercised on the VM
# may not. Signature companions are enforced by the separate signature guard.
release_artifacts_assert_platform_smoke_receipt() {
  local tag="${1:-}" version="${2:-}" platform="${3:-}" receipt provenance durable_receipt
  shift 3 2>/dev/null || return 2
  [[ $# -gt 0 ]] || {
    echo "release-artifacts: $platform smoke check received no artifacts." >&2
    return 1
  }
  receipt="$(release_artifacts_smoke_receipt_path "$tag" "$platform")" || return $?
  [[ -f "$receipt" ]] || {
    echo "release-artifacts: no $platform smoke receipt at $receipt — run the canonical install verifier for this tag before publishing." >&2
    return 1
  }

  # Resolve the current provenance independently of the receipt. A copied
  # hand-off file must not survive a metadata relabel or a provenance rewrite
  # that happens to leave the payload bytes unchanged.
  provenance="$(release_artifacts_find_provenance "$@" 2>/dev/null || true)"
  [[ -n "$provenance" ]] || {
    echo "release-artifacts: cannot verify $platform smoke receipt without current build-provenance.json." >&2
    return 1
  }
  durable_receipt="$(dirname "$provenance")/platform-smoke-${tag}-${platform}.json"
  [[ -f "$durable_receipt" ]] || {
    echo "release-artifacts: durable $platform smoke receipt is missing beside $provenance." >&2
    return 1
  }
  cmp -s "$receipt" "$durable_receipt" || {
    echo "release-artifacts: canonical and durable $platform smoke receipts disagree — refusing ambiguous evidence." >&2
    return 1
  }

  python3 - "$receipt" "$provenance" "$tag" "$version" "$platform" "$@" <<'PY'
import hashlib
import json
import pathlib
import sys
import zipfile

receipt_path, provenance_path, tag, version, platform, *artifacts = sys.argv[1:]
try:
    receipt = json.loads(pathlib.Path(receipt_path).read_text(encoding="utf-8"))
except Exception as exc:
    raise SystemExit(f"release-artifacts: unreadable {platform} smoke receipt: {exc}")
try:
    provenance = json.loads(pathlib.Path(provenance_path).read_text(encoding="utf-8"))
except Exception as exc:
    raise SystemExit(f"release-artifacts: unreadable current build provenance: {exc}")

expected = {
    "schemaVersion": "papercusp-platform-smoke/v1",
    "result": "pass",
    "tag": tag,
    "version": version,
    "platform": platform,
}
for key, value in expected.items():
    if receipt.get(key) != value:
        raise SystemExit(
            f"release-artifacts: stale/wrong {platform} smoke receipt: "
            f"{key}={receipt.get(key)!r}, expected {value!r}"
        )
if not receipt.get("buildSha") or not receipt.get("verifier"):
    raise SystemExit(
        f"release-artifacts: malformed {platform} smoke receipt lacks buildSha/verifier"
    )
if not receipt.get("exercisedArtifacts"):
    raise SystemExit(
        f"release-artifacts: malformed {platform} smoke receipt names no exercised artifact"
    )
if receipt.get("buildSha") != provenance.get("buildSha"):
    raise SystemExit(
        f"release-artifacts: stale/wrong {platform} smoke receipt buildSha does not match current provenance"
    )
if receipt.get("version") != provenance.get("version"):
    raise SystemExit(
        f"release-artifacts: stale/wrong {platform} smoke receipt version does not match current provenance"
    )

exercised_names = [
    pathlib.PurePosixPath(row.get("name", "")).name
    for row in receipt.get("exercisedArtifacts")
    if isinstance(row, dict)
]

rows = receipt.get("artifacts")
if not isinstance(rows, list) or not rows:
    raise SystemExit(f"release-artifacts: malformed {platform} smoke receipt has no artifacts")

provenance_rows = provenance.get("artifacts")
if not isinstance(provenance_rows, list) or not provenance_rows:
    raise SystemExit("release-artifacts: current build provenance has no artifacts")
for row in provenance_rows:
    if not isinstance(row, dict) or not isinstance(row.get("name"), str) \
       or not isinstance(row.get("sha256"), str) or not isinstance(row.get("bytes"), int):
        raise SystemExit("release-artifacts: current build provenance has a malformed artifact row")

def hash_file(path):
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

by_basename = {}
for row in rows:
    if not isinstance(row, dict):
        continue
    name = row.get("name")
    if isinstance(name, str):
        by_basename.setdefault(pathlib.PurePosixPath(name).name, []).append(row)

def row_matches(name, size, sha):
    return any(
        row.get("bytes") == size and row.get("sha256") == sha
        for row in by_basename.get(name, [])
    )

def provenance_matches(name, size, sha):
    return any(
        pathlib.PurePosixPath(row.get("name", "")).name == name
        and row.get("bytes") == size
        and row.get("sha256") == sha
        for row in provenance_rows
    )

failures = []
checked = 0
required_products = set()
for raw in artifacts:
    path = pathlib.Path(raw)
    if path.name.endswith(".sig"):
        continue
    required_products.add("server" if "server" in path.name.lower() else "gui")
    if not path.is_file():
        failures.append(f"missing publish artifact: {path}")
        continue
    size = path.stat().st_size
    sha = hash_file(path)
    direct_provenance = provenance_matches(path.name, size, sha)
    if direct_provenance and row_matches(path.name, size, sha):
        checked += 1
        continue
    if platform == "windows" and path.name.endswith("-setup.zip"):
        try:
            with zipfile.ZipFile(path) as archive:
                members = [member for member in archive.infolist() if not member.is_dir()]
                if not members:
                    failures.append(f"empty Windows smoke payload archive: {path.name}")
                    continue
                bad_members = []
                for member in members:
                    member_digest = hashlib.sha256()
                    with archive.open(member) as member_handle:
                        for chunk in iter(lambda: member_handle.read(1024 * 1024), b""):
                            member_digest.update(chunk)
                    member_hash = member_digest.hexdigest()
                    member_name = pathlib.PurePosixPath(member.filename).name
                    if not row_matches(member_name, member.file_size, member_hash) \
                       or not provenance_matches(member_name, member.file_size, member_hash):
                        bad_members.append(member_name)
                if bad_members:
                    failures.append(
                        f"{path.name} contains unverified/stale payload member(s): "
                        + ", ".join(sorted(bad_members))
                    )
                else:
                    checked += 1
                continue
        except Exception as exc:
            failures.append(f"cannot inspect Windows smoke payload {path.name}: {exc}")
            continue
    if not direct_provenance:
        failures.append(f"{path.name} bytes are absent/stale in current build provenance")
        continue
    failures.append(f"{path.name} bytes are absent/stale in the {platform} smoke receipt")

exercised_rows = receipt.get("exercisedArtifacts")
if not isinstance(exercised_rows, list):
    failures.append("exercisedArtifacts is not a list")
    exercised_rows = []
for row in exercised_rows:
    if not isinstance(row, dict):
        failures.append("exercisedArtifacts contains a non-object row")
        continue
    name = pathlib.PurePosixPath(str(row.get("name", ""))).name
    size = row.get("bytes")
    sha = row.get("sha256")
    if not isinstance(name, str) or not isinstance(size, int) or not isinstance(sha, str):
        failures.append("exercisedArtifacts contains a malformed row")
    elif not row_matches(name, size, sha) or not provenance_matches(name, size, sha):
        failures.append(f"exercised artifact {name!r} is not content-bound to current provenance")

exercised_products = {
    "server" if "server" in str(name).lower() else "gui" for name in exercised_names if name
}
for product in sorted(required_products - exercised_products):
    failures.append(
        f"{product} payload is present in the publish set but no {product} installer "
        "was actually exercised by the smoke verifier"
    )

if failures:
    print(
        f"release-artifacts: {platform} smoke receipt FAILED content binding:",
        file=sys.stderr,
    )
    for failure in failures:
        print(f"  {failure}", file=sys.stderr)
    raise SystemExit(1)
if checked == 0:
    raise SystemExit(
        f"release-artifacts: {platform} smoke receipt checked no publishable artifacts"
    )
print(
    f"release-artifacts: {platform} smoke receipt verified "
    f"({checked} content-bound artifact(s), verifier={receipt['verifier']})"
)
PY
}

# release_artifacts_assert_smoke_receipts <tag> <version> <artifact...>
# Group the shared artifact ledger by physical platform and require a receipt for
# every group.  Hardware unavailability is an operator decision, never an
# accidental fallback: the bypass requires both an exact flag and a non-empty
# reason, and logs that reason on every guarded publish path.
release_artifacts_assert_smoke_receipts() {
  local tag="${1:-}" version="${2:-}" f name classified=0
  shift 2 2>/dev/null || return 2
  if [[ "${PAPERCUSP_SKIP_PLATFORM_SMOKE:-0}" == "1" ]]; then
    [[ -n "${PAPERCUSP_SKIP_PLATFORM_SMOKE_REASON:-}" \
       && "${PAPERCUSP_SKIP_PLATFORM_SMOKE_REASON//[[:space:]]/}" != "" ]] || {
      echo "release-artifacts: PAPERCUSP_SKIP_PLATFORM_SMOKE=1 requires PAPERCUSP_SKIP_PLATFORM_SMOKE_REASON (hardware/decision audit)." >&2
      return 1
    }
    echo "release-artifacts: WARNING — platform smoke gate OVERRIDDEN: ${PAPERCUSP_SKIP_PLATFORM_SMOKE_REASON}" >&2
    return 0
  fi
  if [[ -n "${PAPERCUSP_SKIP_PLATFORM_SMOKE:-}" && "${PAPERCUSP_SKIP_PLATFORM_SMOKE}" != "0" ]]; then
    echo "release-artifacts: PAPERCUSP_SKIP_PLATFORM_SMOKE must be exactly 0 or 1." >&2
    return 2
  fi

  local -a linux_artifacts=() windows_artifacts=() mac_artifacts=()
  for f in "$@"; do
    name="$(basename "$f")"
    [[ "$name" == *.sig ]] && continue
    case "$name" in
      *.AppImage|*.deb) linux_artifacts+=("$f"); classified=1 ;;
      *.dmg|*.app.tar.gz) mac_artifacts+=("$f"); classified=1 ;;
      *.exe|*.msi|*-setup.zip|*-setup-*.bin) windows_artifacts+=("$f"); classified=1 ;;
    esac
  done
  [[ "$classified" == "1" ]] || {
    echo "release-artifacts: artifact ledger contains no platform payloads to smoke-check." >&2
    return 1
  }
  [[ ${#linux_artifacts[@]} -eq 0 ]] \
    || release_artifacts_assert_platform_smoke_receipt "$tag" "$version" linux "${linux_artifacts[@]}" \
    || return $?
  [[ ${#windows_artifacts[@]} -eq 0 ]] \
    || release_artifacts_assert_platform_smoke_receipt "$tag" "$version" windows "${windows_artifacts[@]}" \
    || return $?
  [[ ${#mac_artifacts[@]} -eq 0 ]] \
    || release_artifacts_assert_platform_smoke_receipt "$tag" "$version" mac "${mac_artifacts[@]}" \
    || return $?
}

# Find the provenance record that belongs to one or more artifact paths. Release
# legs normally place it at the bundle root; the bounded parent walk also covers
# collected role directories without turning an absent record into a broad tree
# search (which could bind a receipt to an unrelated cut).
release_artifacts_find_provenance() {
  local f dir candidate depth
  for f in "$@"; do
    [[ -n "$f" ]] || continue
    dir="$(cd "$(dirname "$f")" 2>/dev/null && pwd -P)" || continue
    for depth in 0 1 2 3; do
      candidate="$dir/build-provenance.json"
      [[ -f "$candidate" ]] && { printf '%s\n' "$candidate"; return 0; }
      [[ "$dir" != "/" ]] || break
      dir="$(dirname "$dir")"
    done
  done
  return 1
}

# Select the GUI and Server installers that the canonical installed-artifact
# verifier can exercise.  Updater containers (.AppImage/.app.tar.gz) remain in
# the publish set and are bound by the receipt, but they are not silently
# substituted for an installer.  A Windows normalized Server zip is similarly
# resolved back to its raw setup.exe sibling, which is what the VM actually
# installs; the zip's member bytes are checked by the receipt assertion.
release_artifacts_smoke_inputs() {
  local platform="${1:-}" f name dir gui="" server=""
  shift 2>/dev/null || return 2
  case "$platform" in
    linux)
      for f in "$@"; do
        name="$(basename "$f")"
        [[ "$name" == *.sig || "$name" == *.AppImage ]] && continue
        if [[ "$name" == *.deb ]]; then
          if [[ "$name" == *[Ss]erver* ]]; then server="$f"; elif [[ -z "$gui" ]]; then gui="$f"; fi
        fi
      done
      ;;
    mac)
      for f in "$@"; do
        name="$(basename "$f")"
        [[ "$name" == *.sig || "$name" == *.app.tar.gz ]] && continue
        if [[ "$name" == *.dmg ]]; then
          if [[ "$name" == *[Ss]erver* ]]; then server="$f"; elif [[ -z "$gui" ]]; then gui="$f"; fi
        fi
      done
      ;;
    windows)
      for f in "$@"; do
        name="$(basename "$f")"
        [[ "$name" == *.sig || "$name" == *.bin || "$name" == *-setup.zip ]] && continue
        if [[ "$name" == *[Ss]erver* && "$name" == *-setup.exe ]]; then
          server="$f"
        elif [[ "$name" == *-setup.exe || "$name" == *.msi ]]; then
          [[ -z "$gui" ]] && gui="$f"
        fi
      done
      # The normalized zip is the published Server object, but the raw setup
      # stub remains beside it for the install proof.  Require exactly one
      # candidate so a stale same-version stub cannot be selected by order.
      if [[ -z "$server" && -n "$gui" ]]; then
        dir="$(dirname "$gui")"
        shopt -s nullglob
        local -a candidates=( "$dir"/*Server*-setup.exe "$dir"/*server*-setup.exe )
        shopt -u nullglob
        if (( ${#candidates[@]} == 1 )); then server="${candidates[0]}"; fi
      fi
      ;;
    *) return 2 ;;
  esac
  [[ -n "$gui" && -n "$server" ]] || {
    echo "release-artifacts: $platform smoke needs one GUI installer and one matching Server installer (GUI='${gui:-<missing>}' Server='${server:-<missing>}')." >&2
    return 1
  }
  printf '%s\n%s\n' "$gui" "$server"
}

# ── Linux clean-room VM lifecycle for the canonical Linux leg (WI-10004052) ──
# The Linux installed-update proof needs a real, disposable Ubuntu machine: the
# vmctl "clean" instance (scripts/linux-test-vm). The leg used to dial the
# Windows VM's endpoint and so could never produce a receipt. It now owns the
# whole lifecycle: reset to a pristine overlay, boot, wait for SSH, install the
# PREVIOUS release as the running baseline (the verifier proves an in-place
# UPDATE, so a pristine VM alone has nothing to flip), run the verifier against
# the vmctl-derived endpoint, and ALWAYS power the VM down. Every step is
# bounded by timeout(1).
#
#   PAPERCUSP_LINUX_SMOKE_BASELINE_GUI / _SERVER  previous release's GUI + Server
#                                    .deb (required when the overlay is reset)
#   PAPERCUSP_LINUX_SMOKE_BASELINE_DIR  alternative: a directory holding exactly
#                                    one GUI and one Server .deb
#   PAPERCUSP_LINUX_SMOKE_VM         vmctl instance (default: clean)
#   PAPERCUSP_LINUX_SMOKE_VM_MANAGED=0  skip the lifecycle (VM already prepared)
#   PAPERCUSP_LINUX_SMOKE_RESET=0    boot the existing overlay; no reset, no
#                                    baseline install (it must already hold one)
#   PAPERCUSP_LINUX_SMOKE_{RESET,UP,SSH,BASELINE,BASELINE_START,VERIFY,DOWN}_TIMEOUT
#                                    per-step budgets in seconds
#   PAPERCUSP_LINUX_VMCTL            vmctl path (tests substitute a fake)
release_artifacts_linux_vmctl() {
  printf '%s\n' "${PAPERCUSP_LINUX_VMCTL:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/scripts/linux-test-vm/vmctl}"
}

# release_artifacts_linux_smoke_baseline <target-version> -> "<gui>\n<server>"
release_artifacts_linux_smoke_baseline() {
  local target_version="${1:-}" gui="${PAPERCUSP_LINUX_SMOKE_BASELINE_GUI:-}"
  local server="${PAPERCUSP_LINUX_SMOKE_BASELINE_SERVER:-}" dir="${PAPERCUSP_LINUX_SMOKE_BASELINE_DIR:-}"
  local f name version role
  if [[ -z "$gui" && -z "$server" && -n "$dir" ]]; then
    [[ -d "$dir" ]] || { echo "release-artifacts: PAPERCUSP_LINUX_SMOKE_BASELINE_DIR is not a directory: $dir" >&2; return 1; }
    local -a guis=() servers=()
    shopt -s nullglob
    for f in "$dir"/*.deb; do
      name="$(basename "$f")"
      if [[ "$name" == *[Ss]erver* ]]; then servers+=("$f"); else guis+=("$f"); fi
    done
    shopt -u nullglob
    (( ${#guis[@]} == 1 && ${#servers[@]} == 1 )) || {
      echo "release-artifacts: $dir must hold exactly one GUI and one Server .deb (found ${#guis[@]} GUI, ${#servers[@]} Server)." >&2
      return 1
    }
    gui="${guis[0]}"; server="${servers[0]}"
  fi
  [[ -n "$gui" && -n "$server" ]] || {
    echo "release-artifacts: the Linux smoke resets the clean-room VM, so it needs the PREVIOUS release installed as the running baseline to update FROM." >&2
    echo "       Set PAPERCUSP_LINUX_SMOKE_BASELINE_GUI + PAPERCUSP_LINUX_SMOKE_BASELINE_SERVER (or PAPERCUSP_LINUX_SMOKE_BASELINE_DIR) to that release's .debs." >&2
    return 1
  }
  for f in "$gui" "$server"; do
    [[ -f "$f" ]] || { echo "release-artifacts: Linux smoke baseline not found: $f" >&2; return 1; }
    [[ "$f" == *.deb ]] || { echo "release-artifacts: Linux smoke baseline must be a .deb: $f" >&2; return 1; }
  done
  # A baseline of the SAME version can never flip; fail before booting a VM.
  for role in gui server; do
    [[ "$role" == gui ]] && f="$gui" || f="$server"
    version=""
    if command -v dpkg-deb >/dev/null 2>&1; then
      version="$(dpkg-deb -f "$f" Version 2>/dev/null || true)"
    fi
    [[ -n "$version" ]] || version="$(basename "$f" | sed -n 's/.*_\([0-9][0-9.]*\)_[^_]*\.deb$/\1/p')"
    if [[ -n "$target_version" && "$version" == "$target_version" ]]; then
      echo "release-artifacts: Linux smoke $role baseline is already version $target_version ($f) — there would be nothing to update from." >&2
      return 1
    fi
  done
  printf '%s\n%s\n' "$gui" "$server"
}

# Bring the baseline's Server-owned operator up and wait until it answers
# /api/health, then wait for the guest package manager to go idle (a Server
# install leaves a detached apt worker that would fail the verifier's install).
release_artifacts_linux_smoke_baseline_start_script() {
  cat <<'START'
set -euo pipefail
rm -f /tmp/Papercusp.deb
systemctl --user daemon-reload
systemctl --user enable --now papercusp-server.service
deadline=$(( $(date +%s) + BASELINE_BUDGET ))
while :; do
  port="$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.papercusp/operator.json")))["port"])' 2>/dev/null || true)"
  if [ -n "$port" ] && curl -fsS -m 5 "http://127.0.0.1:$port/api/health" >/tmp/papercusp-baseline-health.json 2>/dev/null; then
    printf 'PAPERCUSP_LINUX_BASELINE_OPERATOR_OK port=%s health=%s\n' "$port" "$(head -c 300 /tmp/papercusp-baseline-health.json)"
    break
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "baseline operator did not answer /api/health within ${BASELINE_BUDGET}s" >&2
    systemctl --user --no-pager status papercusp-server.service >&2 || true
    exit 1
  fi
  sleep 5
done
idle=0
apt_deadline=$(( $(date +%s) + 300 ))
while [ "$idle" -lt 2 ]; do
  if sudo fuser /var/lib/apt/lists/lock /var/cache/apt/archives/lock /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock >/dev/null 2>&1 \
     || pgrep -x apt-get >/dev/null 2>&1 || pgrep -x apt >/dev/null 2>&1 || pgrep -x dpkg >/dev/null 2>&1; then
    idle=0
  else
    idle=$((idle + 1))
  fi
  if [ "$(date +%s)" -ge "$apt_deadline" ]; then
    echo "guest apt/dpkg did not go idle within 300s after the baseline install" >&2
    exit 1
  fi
  sleep 1
done
START
}

# release_artifacts_linux_vm_smoke <version> <verifier> <verifier-args...>
release_artifacts_linux_vm_smoke() {
  local version="${1:-}" verifier="${2:-}"
  shift 2 2>/dev/null || return 2
  local vmctl vm reset endpoint port key host baseline="" base_gui="" base_server=""
  local rc=0 booted=0 lock_fd lock_file start_out
  vmctl="$(release_artifacts_linux_vmctl)"
  vm="${PAPERCUSP_LINUX_SMOKE_VM:-clean}"
  reset="${PAPERCUSP_LINUX_SMOKE_RESET:-1}"
  [[ "$vm" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "release-artifacts: unsafe PAPERCUSP_LINUX_SMOKE_VM '$vm'." >&2; return 2; }
  [[ -f "$vmctl" ]] || { echo "release-artifacts: Linux test VM controller missing: $vmctl" >&2; return 1; }

  if [[ "$reset" == 1 ]]; then
    baseline="$(release_artifacts_linux_smoke_baseline "$version")" || return 1
    base_gui="$(printf '%s\n' "$baseline" | sed -n '1p')"
    base_server="$(printf '%s\n' "$baseline" | sed -n '2p')"
  fi

  endpoint="$(bash "$vmctl" endpoint "$vm" 2>&1)" || {
    echo "release-artifacts: cannot read the Linux test VM endpoint: $endpoint" >&2
    return 1
  }
  port="$(printf '%s\n' "$endpoint" | sed -n 's/^ssh_port=//p' | head -1)"
  key="$(printf '%s\n' "$endpoint" | sed -n 's/^ssh_key=//p' | head -1)"
  host="$(printf '%s\n' "$endpoint" | sed -n 's/^ssh_host=//p' | head -1)"
  [[ "$port" =~ ^[0-9]+$ && -n "$key" && -n "$host" ]] || {
    echo "release-artifacts: malformed Linux test VM endpoint from $vmctl: $endpoint" >&2
    return 1
  }

  # One release smoke per VM at a time; a VM that is ALREADY running belongs to
  # someone else (fresh-install / federation work) and is never reset here.
  lock_file="${TMPDIR:-/tmp}/papercusp-linux-smoke-$vm.lock"
  exec {lock_fd}>"$lock_file" || { echo "release-artifacts: cannot open $lock_file" >&2; return 1; }
  if ! flock -n "$lock_fd"; then
    exec {lock_fd}>&-
    echo "release-artifacts: another Linux platform smoke holds $lock_file — refusing to share the $vm VM." >&2
    return 1
  fi
  if bash "$vmctl" is-running "$vm" >/dev/null 2>&1; then
    exec {lock_fd}>&-
    echo "release-artifacts: the Linux test VM '$vm' is already running — another lane may be using it, so it is NOT reset. Free it (scripts/linux-test-vm/vmctl down $vm) and re-run." >&2
    return 1
  fi

  echo "release-artifacts: Linux smoke VM '$vm' → $host:$port (reset=$reset)"
  booted=1
  {
    if [[ "$reset" == 1 ]]; then
      timeout --kill-after=30 "${PAPERCUSP_LINUX_SMOKE_RESET_TIMEOUT:-180}" bash "$vmctl" reset "$vm" \
        || { echo "release-artifacts: vmctl reset $vm failed or timed out" >&2; false; }
    fi
  } && {
    timeout --kill-after=30 "${PAPERCUSP_LINUX_SMOKE_UP_TIMEOUT:-300}" bash "$vmctl" up "$vm" \
      || { echo "release-artifacts: vmctl up $vm failed or timed out" >&2; false; }
  } && {
    timeout --kill-after=30 "$(( ${PAPERCUSP_LINUX_SMOKE_SSH_TIMEOUT:-300} + 30 ))" \
      bash "$vmctl" wait-ssh "$vm" "${PAPERCUSP_LINUX_SMOKE_SSH_TIMEOUT:-300}" \
      || { echo "release-artifacts: SSH on the $vm VM never answered" >&2; false; }
  } && {
    [[ "$reset" != 1 ]] || {
      echo "release-artifacts: installing baseline $(basename "$base_server") + $(basename "$base_gui") on $vm"
      timeout --kill-after=30 "${PAPERCUSP_LINUX_SMOKE_BASELINE_TIMEOUT:-2400}" bash "$vmctl" install "$vm" "$base_server" \
        && timeout --kill-after=30 "${PAPERCUSP_LINUX_SMOKE_BASELINE_TIMEOUT:-2400}" bash "$vmctl" install "$vm" "$base_gui"
    } || { echo "release-artifacts: baseline install on $vm failed or timed out" >&2; false; }
  } && {
    [[ "$reset" != 1 ]] || {
      start_out="$(release_artifacts_linux_smoke_baseline_start_script \
        | sed "s/BASELINE_BUDGET/${PAPERCUSP_LINUX_SMOKE_BASELINE_START_TIMEOUT:-900}/g" \
        | timeout --kill-after=30 "$(( ${PAPERCUSP_LINUX_SMOKE_BASELINE_START_TIMEOUT:-900} + 360 ))" \
            bash "$vmctl" ssh "$vm" 'bash -s' 2>&1)"
      local start_rc=$?
      printf '%s\n' "$start_out" | tail -n 20
      [[ "$start_rc" -eq 0 && "$start_out" == *PAPERCUSP_LINUX_BASELINE_OPERATOR_OK* ]]
    } || { echo "release-artifacts: the baseline operator on $vm never became healthy" >&2; false; }
  } && {
    timeout --kill-after=60 "${PAPERCUSP_LINUX_SMOKE_VERIFY_TIMEOUT:-5400}" "$verifier" "$@" \
      --ssh-port "$port" --ssh-key "$key" --ssh-host "$host" \
      --ssh-option StrictHostKeyChecking=no --ssh-option UserKnownHostsFile=/dev/null --ssh-option LogLevel=ERROR \
      --scp-option StrictHostKeyChecking=no --scp-option UserKnownHostsFile=/dev/null --scp-option LogLevel=ERROR
  }
  rc=$?
  if [[ "$booted" == 1 ]]; then
    timeout --kill-after=30 "${PAPERCUSP_LINUX_SMOKE_DOWN_TIMEOUT:-180}" bash "$vmctl" down "$vm" \
      || echo "release-artifacts: WARNING — could not power down the $vm VM; run scripts/linux-test-vm/vmctl down $vm" >&2
  fi
  exec {lock_fd}>&-
  return "$rc"
}

# Run a real platform verifier when a receipt is absent/stale, then require the
# receipt it produced.  This keeps hardware orchestration out of the manifest
# generator while making the publish hand-off self-driving: a normal publish
# invokes the existing install-and-relaunch verifier; remote rigs can provide
# PAPERCUSP_PLATFORM_SMOKE_CMD, which receives positional args
# platform/version/tag/gui/server/provenance and must still write the shared
# receipt.  A pre-existing valid receipt is reused, so re-publishing a cut does
# not reinstall an already-verified build.
release_artifacts_run_platform_smoke() {
  local tag="${1:-}" version="${2:-}" platform="${3:-}" f provenance inputs gui server
  shift 3 2>/dev/null || return 2
  [[ $# -gt 0 ]] || return 1

  if [[ "${PAPERCUSP_SKIP_PLATFORM_SMOKE:-0}" == "1" ]]; then
    [[ -n "${PAPERCUSP_SKIP_PLATFORM_SMOKE_REASON:-}" \
       && "${PAPERCUSP_SKIP_PLATFORM_SMOKE_REASON//[[:space:]]/}" != "" ]] || {
      echo "release-artifacts: PAPERCUSP_SKIP_PLATFORM_SMOKE=1 requires PAPERCUSP_SKIP_PLATFORM_SMOKE_REASON (hardware/decision audit)." >&2
      return 1
    }
    echo "release-artifacts: WARNING — platform smoke gate OVERRIDDEN: ${PAPERCUSP_SKIP_PLATFORM_SMOKE_REASON}" >&2
    return 0
  fi
  if [[ -n "${PAPERCUSP_SKIP_PLATFORM_SMOKE:-}" && "${PAPERCUSP_SKIP_PLATFORM_SMOKE}" != "0" ]]; then
    echo "release-artifacts: PAPERCUSP_SKIP_PLATFORM_SMOKE must be exactly 0 or 1." >&2
    return 2
  fi

  # A valid receipt is already the verifier's durable result; do not repeat a
  # potentially destructive install on a re-publish.
  if release_artifacts_assert_smoke_receipts "$tag" "$version" "$@" >/dev/null 2>&1; then
    echo "release-artifacts: existing platform smoke receipt is current; verifier run reused"
    return 0
  fi

  provenance="$(release_artifacts_find_provenance "$@" 2>/dev/null || true)"
  [[ -n "$provenance" ]] || {
    echo "release-artifacts: cannot run $platform smoke without build-provenance.json." >&2
    return 1
  }
  inputs="$(release_artifacts_smoke_inputs "$platform" "$@" 2>&1)" || {
    echo "$inputs" >&2
    echo "       The automatic verifier requires one GUI installer and one Server installer for the platform." >&2
    echo "       Use the explicit reasoned hardware override only when that installed-artifact proof cannot run." >&2
    return 1
  }
  gui="$(printf '%s\n' "$inputs" | sed -n '1p')"
  server="$(printf '%s\n' "$inputs" | sed -n '2p')"
  if [[ -n "${PAPERCUSP_PLATFORM_SMOKE_CMD:-}" ]]; then
    echo "release-artifacts: running custom $platform platform smoke verifier"
    PAPERCUSP_PLATFORM_SMOKE_PLATFORM="$platform" \
    PAPERCUSP_PLATFORM_SMOKE_VERSION="$version" \
    PAPERCUSP_PLATFORM_SMOKE_TAG="$tag" \
    PAPERCUSP_PLATFORM_SMOKE_PROVENANCE="$provenance" \
      bash -c "$PAPERCUSP_PLATFORM_SMOKE_CMD" -- "$platform" "$version" "$tag" "$gui" "$server" "$provenance"
    local custom_rc=$?
    [[ "$custom_rc" -eq 0 ]] || {
      echo "ERROR: custom $platform platform smoke verifier failed (exit $custom_rc)." >&2
      return 1
    }
  else
    local verifier="${PAPERCUSP_PLATFORM_SMOKE_VERIFIER:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/install-and-relaunch-verify.sh}"
    [[ -x "$verifier" ]] || {
      echo "release-artifacts: canonical platform smoke verifier is missing or not executable: $verifier" >&2
      return 1
    }
    echo "release-artifacts: running $platform platform smoke verifier: $(basename "$verifier")"
    local -a verifier_args=(
      --platform "$platform"
      --artifact "$gui"
      --server-artifact "$server"
      --expected-version "$version"
      --smoke-receipt-tag "$tag"
      --smoke-provenance "$provenance"
      --json
    )
    local verifier_rc
    if [[ "$platform" == linux && "${PAPERCUSP_LINUX_SMOKE_VM_MANAGED:-1}" != 0 ]]; then
      # WI-10004052: the Linux leg owns its clean-room VM lifecycle and dials
      # the vmctl-derived endpoint explicitly — never an ambient VM_SSH_* value.
      release_artifacts_linux_vm_smoke "$version" "$verifier" "${verifier_args[@]}"
      verifier_rc=$?
    else
      "$verifier" "${verifier_args[@]}"
      verifier_rc=$?
    fi
    [[ "$verifier_rc" -eq 0 ]] || {
      echo "ERROR: $platform platform smoke verifier failed (exit $verifier_rc) — refusing publication." >&2
      return 1
    }
  fi
  release_artifacts_assert_platform_smoke_receipt "$tag" "$version" "$platform" "$@"
}

# Group the artifact set by physical platform and run the above gate once per
# group. This is the invocation counterpart to release_artifacts_assert_smoke_receipts;
# keeping both classifiers in one helper prevents a new extension from being
# accepted by one path and skipped by the other.
release_artifacts_run_smoke_receipts() {
  local tag="${1:-}" version="${2:-}" f name classified=0
  shift 2 2>/dev/null || return 2
  if [[ "${PAPERCUSP_SKIP_PLATFORM_SMOKE:-0}" == "1" ]]; then
    release_artifacts_assert_smoke_receipts "$tag" "$version" "$@"
    return $?
  fi
  local -a linux_artifacts=() windows_artifacts=() mac_artifacts=()
  for f in "$@"; do
    name="$(basename "$f")"
    [[ "$name" == *.sig ]] && continue
    case "$name" in
      *.AppImage|*.deb) linux_artifacts+=("$f"); classified=1 ;;
      *.dmg|*.app.tar.gz) mac_artifacts+=("$f"); classified=1 ;;
      *.exe|*.msi|*-setup.zip|*-setup-*.bin) windows_artifacts+=("$f"); classified=1 ;;
    esac
  done
  [[ "$classified" == "1" ]] || {
    echo "release-artifacts: artifact ledger contains no platform payloads to smoke-check." >&2
    return 1
  }
  [[ ${#linux_artifacts[@]} -eq 0 ]] || release_artifacts_run_platform_smoke "$tag" "$version" linux "${linux_artifacts[@]}" || return $?
  [[ ${#windows_artifacts[@]} -eq 0 ]] || release_artifacts_run_platform_smoke "$tag" "$version" windows "${windows_artifacts[@]}" || return $?
  [[ ${#mac_artifacts[@]} -eq 0 ]] || release_artifacts_run_platform_smoke "$tag" "$version" mac "${mac_artifacts[@]}" || return $?
}

# ── Durable release retention ────────────────────────────────────────────────
# A target-dir slot's flock only protects a live launcher.  Once that launcher
# exits, a later cleanup can mistake a completed cut for an abandoned cache and
# remove the very .deb/AppImage (and the isolated Cargo root that contains it)
# the owner still needs to upload.  Keep the retention record outside the target
# tree so deleting a target can never delete the evidence that deletion was
# forbidden.

release_artifacts_retention_root() {
  printf '%s\n' "${PAPERCUSP_RELEASE_RETENTION_ROOT:-${HOME}/.papercusp/release-retention}"
}

release_artifacts_retention_validate_tag() {
  local tag="${1:-}"
  [[ "$tag" =~ ^[A-Za-z0-9._-]+$ ]] || {
    echo "release-artifacts: retention lease requires a safe non-empty tag (got '$tag')." >&2
    return 2
  }
}

release_artifacts_retention_lease_path() {
  local tag="${1:-}"
  release_artifacts_retention_validate_tag "$tag" || return $?
  printf '%s/lease-%s.tsv\n' "$(release_artifacts_retention_root)" "$tag"
}

release_artifacts_deletion_audit_path() {
  printf '%s\n' "${PAPERCUSP_RELEASE_DELETION_AUDIT_PATH:-$(release_artifacts_retention_root)/deletion-audit.tsv}"
}

release_artifacts_normalize_path() {
  local path="${1:-}"
  [[ -n "$path" ]] || return 2
  if command -v realpath >/dev/null 2>&1; then
    realpath -m -- "$path"
    return $?
  fi
  if [[ "$path" = /* ]]; then
    printf '%s\n' "$path"
  else
    printf '%s/%s\n' "$(pwd -P)" "$path"
  fi
}

# release_artifacts_retention_lease_acquire <tag> <path...> — atomically create
# or extend a durable lease. Paths may be files or directories that do not yet
# exist; all are normalized before persistence. A zero TTL (the default) means
# explicit release is required. Set PAPERCUSP_RELEASE_RETENTION_TTL_SEC for a
# bounded lease when the release workflow has a known retention window.
release_artifacts_retention_lease_acquire() {
  local tag="${1:-}" lease root tmp line existing_expires now ttl expires
  shift || true
  release_artifacts_retention_validate_tag "$tag" || return $?
  [[ $# -gt 0 ]] || {
    echo "release-artifacts: retention lease for $tag requires at least one path." >&2
    return 2
  }
  root="$(release_artifacts_retention_root)"
  mkdir -p "$root" || {
    echo "release-artifacts: cannot create retention root $root." >&2
    return 1
  }
  lease="$(release_artifacts_retention_lease_path "$tag")"

  local -a paths=()
  existing_expires=""
  if [[ -f "$lease" ]]; then
    while IFS= read -r line; do
      case "$line" in
        schema=papercusp-release-retention/v1) ;;
        tag="$tag" ) ;;
        created_ns=*) ;;
        expires_ns=*) existing_expires="${line#expires_ns=}" ;;
        path=*) paths+=("${line#path=}") ;;
        "") ;;
        *)
          echo "release-artifacts: malformed retention lease $lease — refusing to overwrite it." >&2
          return 1
          ;;
      esac
    done < "$lease"
    [[ "$existing_expires" =~ ^[0-9]+$ ]] || {
      echo "release-artifacts: malformed retention lease $lease — invalid expiry." >&2
      return 1
    }
    now="$(release_artifacts_cut_start_now_ns)" || return 1
    if (( existing_expires > 0 && existing_expires <= now )); then
      paths=()
    fi
  fi

  for line in "$@"; do
    [[ -n "$line" ]] || continue
    line="$(release_artifacts_normalize_path "$line")" || {
      echo "release-artifacts: could not normalize retention path '$line'." >&2
      return 1
    }
    paths+=("$line")
  done
  [[ ${#paths[@]} -gt 0 ]] || {
    echo "release-artifacts: retention lease for $tag has no paths." >&2
    return 2
  }

  now="$(release_artifacts_cut_start_now_ns)" || return 1
  ttl="${PAPERCUSP_RELEASE_RETENTION_TTL_SEC:-0}"
  [[ "$ttl" =~ ^[0-9]+$ ]] || {
    echo "release-artifacts: PAPERCUSP_RELEASE_RETENTION_TTL_SEC must be a non-negative integer." >&2
    return 2
  }
  tmp="$(mktemp "${lease}.tmp.XXXXXX")" || return 1
  expires=0
  (( ttl > 0 )) && expires=$((now + ttl * 1000000000))
  {
    printf 'schema=papercusp-release-retention/v1\n'
    printf 'tag=%s\n' "$tag"
    printf 'created_ns=%s\n' "$now"
    printf 'expires_ns=%s\n' "$expires"
    printf '%s\n' "${paths[@]}" | LC_ALL=C sort -u | sed 's/^/path=/'
  } > "$tmp" || { rm -f "$tmp"; return 1; }
  if ! mv -f -- "$tmp" "$lease"; then
    rm -f "$tmp"
    echo "release-artifacts: could not persist retention lease at $lease." >&2
    return 1
  fi
  printf '%s\n' "$lease"
}

# papercusp_retain_release_paths <path...> — extend the current cut's durable
# lease with target/artifact roots after its final outputs exist. Direct dev
# builds without a release tag remain unleased by design.
papercusp_retain_release_paths() {
  [[ -n "${PAPERCUSP_RELEASE_TAG:-}" ]] || return 0
  [[ $# -gt 0 ]] || {
    echo "release-artifacts: release retention requires at least one target/artifact path." >&2
    return 2
  }
  release_artifacts_retention_lease_acquire "$PAPERCUSP_RELEASE_TAG" "$@" >/dev/null || {
    echo "release-artifacts: could not retain release paths for ${PAPERCUSP_RELEASE_TAG}." >&2
    return 1
  }
}

# Print the paths in one lease. Return 1 for an expired lease and 2 for a
# malformed lease; callers that make a destructive decision must fail closed on
# the latter rather than treating an unreadable marker as no marker.
release_artifacts_retention_lease_read_paths() {
  local lease="${1:-}" line schema="" tag="" expires="" now
  [[ -f "$lease" ]] || return 1
  while IFS= read -r line; do
    case "$line" in
      schema=*) schema="${line#schema=}" ;;
      tag=*) tag="${line#tag=}" ;;
      expires_ns=*) expires="${line#expires_ns=}" ;;
      path=*) printf '%s\n' "${line#path=}" ;;
      created_ns=*) ;;
      "") ;;
      *) return 2 ;;
    esac
  done < "$lease"
  [[ "$schema" == "papercusp-release-retention/v1" && -n "$tag" && "$expires" =~ ^[0-9]+$ ]] || return 2
  now="$(release_artifacts_cut_start_now_ns)" || return 2
  (( expires == 0 || expires > now )) || return 1
}

# Return 0 and print matching lease tags when a path is protected. Return 1
# when no active lease covers it. Malformed markers are reported as a match so
# every deletion caller fails closed.
release_artifacts_retention_path_is_leased() {
  local candidate="${1:-}" root lease paths status path normalized
  [[ -n "$candidate" ]] || return 2
  # Preserve the invalid-candidate status even when the retention root is absent,
  # but do not retain the normalized reading across the root-existence return.
  if ! release_artifacts_normalize_path "$candidate" >/dev/null; then
    return 2
  fi
  root="$(release_artifacts_retention_root)"
  [[ -d "$root" ]] || return 1
  normalized="$(release_artifacts_normalize_path "$candidate")" || return 2
  local found=1
  for lease in "$root"/lease-*.tsv; do
    [[ -f "$lease" ]] || continue
    if paths="$(release_artifacts_retention_lease_read_paths "$lease")"; then
      while IFS= read -r path; do
        [[ -n "$path" ]] || continue
        path="$(release_artifacts_normalize_path "$path")" || {
          printf 'invalid:%s\n' "$lease"
          found=0
          break
        }
        if [[ "$normalized" == "$path" || "$normalized" == "$path/"* || "$path" == "$normalized/"* ]]; then
          printf '%s\n' "${lease##*/lease-}" | sed 's/\.tsv$//'
          found=0
          break
        fi
      done <<< "$paths"
    else
      status=$?
      if [[ "$status" -eq 1 ]]; then
        continue
      fi
      printf 'invalid:%s\n' "$lease"
      found=0
    fi
  done
  return "$found"
}

# release_artifacts_retention_matches_are_own_cut <matches> — 0 when every lease
# tag in <matches> belongs to THIS cut, 1 otherwise.
#
# <matches> is the stdout of release_artifacts_retention_path_is_leased: one lease
# tag per line, or an `invalid:<lease>` marker for a malformed one. That predicate
# answers "is this path leased?" and ALREADY reports WHICH tag(s) hold it, but a
# caller that discards the tags can only refuse on any match at all — which locks a
# cut out of the very paths it leased for itself (EI-23946118243608426). This is the
# single place that rule is expressed, so the slot picker and the deletion guard
# cannot drift apart on it.
#
# Fails CLOSED on purpose: an unset PAPERCUSP_RELEASE_TAG, any foreign tag, an
# `invalid:` marker, or a match that names no tag at all all answer 1 (not ours), so
# the caller keeps its protective behaviour. The guard's whole purpose is to stop one
# cut destroying or stealing ANOTHER cut's artifacts, and that is left fully intact.
release_artifacts_retention_matches_are_own_cut() {
  local matches="${1:-}" matched_tag
  [[ -n "${PAPERCUSP_RELEASE_TAG:-}" ]] || return 1
  [[ -n "$matches" ]] || return 1
  while IFS= read -r matched_tag; do
    [[ -n "$matched_tag" ]] || continue
    [[ "$matched_tag" == "$PAPERCUSP_RELEASE_TAG" ]] || return 1
  done <<< "$matches"
  return 0
}

release_artifacts_deletion_audit() {
  local decision="${1:-}" path="${2:-}" leases="${3:-}" reason="${4:-}"
  local audit actor timestamp
  audit="$(release_artifacts_deletion_audit_path)"
  actor="${PAPERCUSP_RELEASE_DELETER:-${BASH_SOURCE[1]##*/}}"
  [[ -n "$actor" ]] || actor="${0##*/}"
  decision="${decision//$'\t'/ }"; path="${path//$'\t'/ }"
  leases="${leases//$'\t'/ }"; reason="${reason//$'\t'/ }"
  mkdir -p "$(dirname "$audit")" || return 1
  timestamp="$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)"
  printf '%s\tpid=%s\tdeleter=%s\tdecision=%s\tpath=%s\tlease=%s\treason=%s\n' \
    "$timestamp" "$$" "$actor" "$decision" "$path" "${leases:-none}" "${reason:-none}" >> "$audit"
}

# release_artifacts_guarded_delete <path...> — delete only paths not covered
# by an active retention lease. Every attempted deletion is audited, including
# denied and missing paths. A denied path returns non-zero and is never handed
# to rm; callers should propagate that failure rather than routing around it.
release_artifacts_guarded_delete() {
  local candidate matches status rc=0 own_lease matched_tag allow_reason
  for candidate in "$@"; do
    [[ -n "$candidate" ]] || continue
    matches=""
    allow_reason="guard passed"
    if [[ ! -e "$candidate" && ! -L "$candidate" ]]; then
      release_artifacts_deletion_audit skip-missing "$candidate" "" "path absent" || rc=1
      continue
    fi
    if matches="$(release_artifacts_retention_path_is_leased "$candidate" 2>/dev/null)"; then
      # A cut must never be refused its OWN lease. release_artifacts_retention_path_is_leased
      # answers "is this path leased?" and ALREADY reports which tag(s) hold it — refusing on
      # any match at all locks a cut out of the very paths it leased for itself.
      #
      # Measured twice in the 0.0.21-alpha cut (EI-23946118243608426). Second, worse face:
      # the three legs run CONCURRENTLY against one shared target slot; the windows leg
      # finished first, took a lease covering that slot, and the still-running linux sibling
      # was then refused the stale-AppDir purge it is REQUIRED to perform (WI-4736) — so the
      # leg died ~90min in. The first face was cross-cut (the slot picker skipping a leased
      # dir); this one is intra-cut, between parallel legs of a single run.
      #
      # Allow ONLY when every matching lease is this cut's own tag. An unset tag, any foreign
      # tag, or an `invalid:` marker still fails closed — the guard's whole purpose is to stop
      # one cut destroying ANOTHER cut's artifacts, and that is left fully intact.
      # The rule itself lives in release_artifacts_retention_matches_are_own_cut so the slot
      # picker (bin/lib/claim-target-dir.sh) enforces the identical test.
      own_lease=0
      if release_artifacts_retention_matches_are_own_cut "$matches"; then
        own_lease=1
      fi
      if [[ "$own_lease" -ne 1 ]]; then
        release_artifacts_deletion_audit deny "$candidate" "$matches" "active retention lease" || rc=1
        echo "release-artifacts: refusing to delete leased path $candidate ($matches)." >&2
        rc=1
        continue
      fi
      allow_reason="own-cut lease ${PAPERCUSP_RELEASE_TAG}"
    else
      status=$?
      if [[ "$status" -eq 2 ]]; then
        matches="unreadable-retention-marker"
        release_artifacts_deletion_audit deny "$candidate" "$matches" "retention marker unreadable" || rc=1
        echo "release-artifacts: refusing to delete $candidate — retention marker unreadable." >&2
        rc=1
        continue
      fi
    fi
    release_artifacts_deletion_audit allow "$candidate" "$matches" "$allow_reason" || rc=1
    if [[ -d "$candidate" && ! -L "$candidate" ]]; then
      rm -rf -- "$candidate" || rc=1
    else
      rm -f -- "$candidate" || rc=1
    fi
  done
  return "$rc"
}

release_artifacts_retention_lease_release() {
  local tag="${1:-}" lease
  lease="$(release_artifacts_retention_lease_path "$tag")" || return $?
  [[ -f "$lease" ]] || return 1
  release_artifacts_deletion_audit lease-release "$lease" "$tag" "explicit retention release" || return 1
  rm -f -- "$lease"
}

# release_artifacts_assert_fresh <tag> [artifact...] — fail closed unless each
# supplied artifact was written STRICTLY AFTER this cut's start. With no
# explicit artifact list, inspect every path recorded in the tag manifest,
# including missing paths (release_artifacts_read intentionally filters those
# for its legacy caller contract). Incremental publishing passes only its NEW
# artifacts so already-live platforms remain valid against their original cut.
release_artifacts_assert_fresh() {
  local tag="${1:-}" stamp manifest line
  shift || true
  [[ -n "$tag" ]] || { echo "release-artifacts: freshness check requires a tag." >&2; return 2; }
  stamp="$(release_artifacts_cut_start_read "$tag")" || return 1

  local -a artifacts=("$@")
  if [[ ${#artifacts[@]} -eq 0 ]]; then
    manifest="$(release_artifacts_manifest_path "$tag")"
    [[ -f "$manifest" ]] || {
      echo "release-artifacts: no artifact manifest at $manifest to freshness-check." >&2
      return 1
    }
    while IFS= read -r line; do
      [[ -n "$line" ]] && artifacts+=("$line")
    done < "$manifest"
  fi
  [[ ${#artifacts[@]} -gt 0 ]] || {
    echo "release-artifacts: no artifacts to freshness-check for $tag." >&2
    return 1
  }

  python3 - "$stamp" "${artifacts[@]}" <<'PY'
import datetime
import os
import sys

start = int(sys.argv[1])
missing = []
stale = []
for path in sys.argv[2:]:
    try:
        mtime = os.stat(path).st_mtime_ns
    except FileNotFoundError:
        missing.append(path)
        continue
    except OSError as exc:
        missing.append(f"{path} ({exc})")
        continue
    if mtime <= start:
        stale.append((path, mtime))

def utc(ns):
    return datetime.datetime.fromtimestamp(ns / 1_000_000_000, datetime.timezone.utc).isoformat()

if missing or stale:
    print(f"release-artifacts: freshness check FAILED for cut start {utc(start)}", file=sys.stderr)
    for path in missing:
        print(f"  missing/unreadable: {path}", file=sys.stderr)
    for path, mtime in stale:
        print(f"  stale (mtime {utc(mtime)} is not after cut start): {path}", file=sys.stderr)
    raise SystemExit(1)

print(f"release-artifacts: freshness check passed ({len(sys.argv) - 2} artifact(s) after {utc(start)})")
PY
}

# release_artifacts_assert_baked_host_from_bytes <base> <artifact...> — derive
# the baked update prefix from the bytes being published. This is the proof leg
# that keeps a repack/re-publish honest: it does not need a fresh build and it
# never accepts a hand-written build-provenance record as evidence.
release_artifacts_assert_baked_host_from_bytes() {
  local base="${1:-}"; shift || true
  [[ -n "$base" && $# -gt 0 ]] || {
    echo "release-artifacts: byte host proof requires a publish base and artifacts." >&2
    return 2
  }

  base="${base%/}"
  local expected_fp expected_authority
  expected_fp="$(printf '%s' "$base" | sha256sum | cut -d' ' -f1)"
  expected_authority="$(printf '%s' "$base" | sed -En 's#^https?://([^/]+).*$#\1#p')"
  local expected_path
  expected_path="$(printf '%s' "$base" | sed -E 's#^https?://[^/]+##; s#/$##')"
  [[ "$base" =~ ^https?://[^/]+/.+ && -n "$expected_authority" && -n "$expected_path" ]] || {
    echo "release-artifacts: byte host proof requires an https/http publish base." >&2
    return 2
  }

  RELEASE_HOST_PROOF_EXPECTED_FP="$expected_fp" \
  RELEASE_HOST_PROOF_EXPECTED_BASE="$base" \
  RELEASE_HOST_PROOF_EXPECTED_AUTHORITY="$expected_authority" \
  RELEASE_HOST_PROOF_EXPECTED_PATH="$expected_path" \
    python3 - "$@" <<'PY'
import hashlib
import os
import re
import shutil
import subprocess
import sys
import zipfile
from urllib.parse import urlsplit

EXPECTED_FP = os.environ["RELEASE_HOST_PROOF_EXPECTED_FP"]
EXPECTED_BASE = os.environ["RELEASE_HOST_PROOF_EXPECTED_BASE"]
EXPECTED_AUTHORITY = os.environ["RELEASE_HOST_PROOF_EXPECTED_AUTHORITY"].lower()
EXPECTED_PATH = os.environ["RELEASE_HOST_PROOF_EXPECTED_PATH"].rstrip("/")
EXPECTED_HOST = (urlsplit(f"https://{EXPECTED_AUTHORITY}").hostname or "").lower()

URL_RE = re.compile(
    rb"https?://[A-Za-z0-9][A-Za-z0-9.-]*(?::[0-9]{1,5})?"
    rb"(?:/[A-Za-z0-9._~!$&'()*+,;=:@%\-]+)+"
)
CHUNK = 1024 * 1024
CARRY = 4096


def release_host_prefix(raw):
    try:
        value = raw.decode("ascii")
    except UnicodeDecodeError:
        return None
    value = value.rstrip(".,;:)]}\"'")

    # Rust may place unrelated printable string constants immediately after an
    # option_env! value in .rodata without a NUL delimiter. URL_RE necessarily
    # consumes that suffix (for example, RELEASE_HOST + "USERPROFILEcould") and
    # would otherwise hash a synthetic URL that never existed at compile time.
    # The exact expected base is still byte-proven in that sequence, so
    # canonicalize it before parsing the remainder as a possible foreign host.
    if value.startswith(EXPECTED_BASE):
        return EXPECTED_BASE

    parsed = urlsplit(value)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return None
    path = parsed.path.rstrip("/")
    if path.endswith("/latest.json"):
        path = path[: -len("/latest.json")].rstrip("/")
    if not path:
        return None
    return f"{parsed.scheme.lower()}://{parsed.netloc}{path}"


def is_release_like(prefix):
    parsed = urlsplit(prefix)
    authority = parsed.netloc.lower()
    host = (parsed.hostname or "").lower()
    path = parsed.path.rstrip("/")
    return (
        authority == EXPECTED_AUTHORITY
        or host == EXPECTED_HOST
        or host.endswith(".r2.dev")
        or host.endswith(".r2.cloudflarestorage.com")
        or path == EXPECTED_PATH
        or path.startswith(f"{EXPECTED_PATH}/")
    )


def scan_stream(stream, found):
    carry = b""
    while True:
        chunk = stream.read(CHUNK)
        if not chunk:
            return
        data = carry + chunk
        for match in URL_RE.finditer(data):
            prefix = release_host_prefix(match.group(0))
            if prefix and is_release_like(prefix):
                found.add(prefix)
        carry = data[-CARRY:]


def scan_process(command, found):
    try:
        proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    except OSError:
        return False
    try:
        scan_stream(proc.stdout, found)
    finally:
        proc.stdout.close()
    return proc.wait() == 0


def scan_artifact(path):
    found = set()
    errors = []
    try:
        with open(path, "rb") as stream:
            scan_stream(stream, found)
    except OSError as exc:
        return found, [str(exc)]

    lower = path.lower()
    if lower.endswith(".deb"):
        if not shutil.which("dpkg-deb") or not shutil.which("tar"):
            errors.append("deb payload scanner unavailable")
        else:
            try:
                deb = subprocess.Popen(
                    ["dpkg-deb", "--fsys-tarfile", path],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,
                )
                tar = subprocess.Popen(
                    ["tar", "-xOf", "-", "--wildcards", "*"],
                    stdin=deb.stdout,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,
                )
                deb.stdout.close()
                scan_stream(tar.stdout, found)
                tar.stdout.close()
                tar_rc = tar.wait()
                deb_rc = deb.wait()
                if deb_rc != 0 or tar_rc != 0:
                    errors.append("deb payload stream failed")
            except OSError as exc:
                errors.append(str(exc))
    elif lower.endswith((
        ".tar", ".tar.gz", ".tgz", ".tar.xz", ".tar.bz2", ".tbz", ".tbz2", ".tar.zst",
    )):
        if not shutil.which("tar"):
            errors.append("tar payload scanner unavailable")
        elif not scan_process(["tar", "-xOf", path, "--wildcards", "*"], found):
            errors.append("tar payload stream failed")
    elif lower.endswith(".zip"):
        try:
            with zipfile.ZipFile(path) as archive:
                for entry in archive.infolist():
                    if entry.is_dir():
                        continue
                    with archive.open(entry) as stream:
                        scan_stream(stream, found)
        except OSError as exc:
            errors.append(str(exc))
        except (RuntimeError, zipfile.BadZipFile) as exc:
            errors.append(str(exc))
    elif lower.endswith(".appimage"):
        if not shutil.which("unsquashfs"):
            errors.append("AppImage payload scanner unavailable")
        elif not scan_process(["unsquashfs", "-cat", path, ".*"], found):
            errors.append("AppImage payload stream failed")
    elif lower.endswith(".dmg"):
        errors.append("dmg payload scanner unavailable")

    return found, errors


payloads = []
skipped_signatures = 0
for path in sys.argv[1:]:
    if path.lower().endswith(".sig"):
        skipped_signatures += 1
    else:
        payloads.append(path)

verified = []
mismatched = []
unverified = []
for path in payloads:
    found, errors = scan_artifact(path)
    fingerprints = {
        hashlib.sha256(prefix.encode("ascii")).hexdigest(): prefix
        for prefix in found
    }
    expected = EXPECTED_FP in fingerprints
    foreign = [fp for fp in fingerprints if fp != EXPECTED_FP]
    name = os.path.basename(path)
    if expected and not foreign and not errors:
        verified.append(path)
        print(f"release-host-bytes: ✓ {name} agrees (fp {EXPECTED_FP[:12]}…)")
    elif foreign:
        mismatched.append(path)
        print(f"release-host-bytes: ✗ {name} has {len(foreign)} foreign/mixed host fingerprint(s)")
    else:
        unverified.append(path)
        reason = "container scan unavailable" if errors else "no release-host bytes found"
        print(f"release-host-bytes: ? {name} unverified ({reason})")

print(
    "release-host-bytes: "
    f"checked={len(verified)} mismatched={len(mismatched)} "
    f"unverified={len(unverified)} skipped-signatures={skipped_signatures}"
)

raise SystemExit(1 if mismatched or unverified else (2 if not payloads else 0))
PY
}

# release_artifacts_resolve_root <path> — print the existing directory's
# physical path.  The dev box relocates cargo output and keeps
# src-tauri/target as a symlink; `find` does not descend a symlink supplied as
# its starting path unless `-L` is used.  A zero-row, zero-exit scan of the
# unresolved path is therefore not evidence that an artifact is absent.
release_artifacts_resolve_root() {
  local root="${1:-}"
  if [[ -z "$root" ]]; then
    echo "release-artifacts: missing directory root to resolve." >&2
    return 2
  fi
  if [[ ! -e "$root" && ! -L "$root" ]]; then
    echo "release-artifacts: directory root does not exist: $root" >&2
    return 1
  fi

  local resolved
  resolved="$(cd "$root" 2>/dev/null && pwd -P)" || {
    echo "release-artifacts: directory root is not accessible: $root" >&2
    return 1
  }
  [[ -d "$resolved" ]] || {
    echo "release-artifacts: resolved root is not a directory: $resolved" >&2
    return 1
  }
  printf '%s\n' "$resolved"
}

# release_artifacts_linux_bundle_root <desktop-root> <cargo-target-root> <version>
# — select the Linux artifact tree the incremental publisher must consume.
# build-linux-local.sh COLLECTS finished bundles into the source-tree target so
# every platform has one canonical location.  On hosts with Cargo's target-dir
# redirected elsewhere, the pre-collection Cargo tree is empty after that move;
# looking only there falsely reports a successful Linux build as absent.  Prefer
# the collection destination whenever it contains this version, retaining the
# Cargo target only as compatibility for older/direct builders that did not
# collect their output.
release_artifacts_linux_bundle_root() {
  local desktop_root="${1:-}" cargo_target_root="${2:-}" version="${3:-}"
  [[ -n "$desktop_root" && -n "$cargo_target_root" && -n "$version" ]] || {
    echo "release-artifacts: linux bundle selection requires desktop root, cargo target root, and version." >&2
    return 2
  }

  local collected="$desktop_root/src-tauri/target/release/bundle"
  local f
  for f in "$collected"/deb/*_"$version"_*.deb \
           "$collected"/deb/*_"$version"_*.deb.sig \
           "$collected"/appimage/*_"$version"_*.AppImage \
           "$collected"/appimage/*_"$version"_*.AppImage.sig; do
    if [[ -f "$f" ]]; then
      printf '%s\n' "$collected"
      return 0
    fi
  done

  printf '%s\n' "$cargo_target_root/release/bundle"
}

# release_artifacts_write <tag> <artifact>... — record the cut's artifact set.
# One ABSOLUTE path per line, sorted + de-duplicated, EXISTING files only (an
# unmatched glob expands to a literal pattern, and a vanished file is dropped —
# so a caller can pass raw globs/optional paths and only real files are recorded).
# Overwrites any prior manifest for the tag. Prints the manifest path.
release_artifacts_write() {
  local tag="$1"; shift
  local out; out="$(release_artifacts_manifest_path "$tag")"
  local manifest_path
  local -a manifest_paths=()
  {
    local f
    for f in "$@"; do
      [[ -f "$f" ]] || continue
      # Absolute-ize so the reader (a different CWD) resolves it.
      [[ "$f" = /* ]] || f="$(cd "$(dirname "$f")" && pwd)/$(basename "$f")"
      printf '%s\n' "$f"
    done
  } | sort -u > "$out"
  while IFS= read -r manifest_path || [[ -n "$manifest_path" ]]; do
    manifest_paths+=("$manifest_path")
  done < "$out" || {
    echo "release-artifacts: could not read the manifest for $tag." >&2
    return 1
  }
  # The manifest is the release pipeline's final byte inventory. Acquire the
  # file-level lease here so every full or incremental writer gets retention by
  # construction; callers add their target roots separately once resolved.
  release_artifacts_retention_lease_acquire "$tag" "${manifest_paths[@]}" >/dev/null || {
    echo "release-artifacts: could not retain the artifact manifest for $tag." >&2
    return 1
  }
  printf '%s\n' "$out"
}

# release_artifacts_read <tag> — print the cut's artifact paths (one per line),
# EXISTING files only. Returns non-zero (with a message on stderr) if the manifest
# is absent or resolves to zero present files. The caller MUST treat that as a
# hard error and NEVER fall back to a second, drifting glob — the divergence is
# the bug.
release_artifacts_read() {
  local tag="$1"
  local manifest; manifest="$(release_artifacts_manifest_path "$tag")"
  if [[ ! -f "$manifest" ]]; then
    echo "release-artifacts: no manifest at $manifest — run bin/release-local.sh <version> <channel> first (it writes this)." >&2
    return 1
  fi
  local -a present=()
  local line
  while IFS= read -r line; do
    [[ -n "$line" && -f "$line" ]] && present+=("$line")
  done < "$manifest"
  if [[ ${#present[@]} -eq 0 ]]; then
    echo "release-artifacts: manifest $manifest names no existing files — the cut's artifacts are gone; re-run bin/release-local.sh." >&2
    return 1
  fi
  printf '%s\n' "${present[@]}"
}

# release_artifacts_assert_urls_covered <tag> <latest_json>... — RECURRENCE GUARD.
# The property being defended: a manifest must never advertise a URL that would
# 404 for an updater client — the LABELED != PACKED failure the post-upload
# fetch-check catches only AFTER the lie is already live.
#
# An advertised URL is COVERED if EITHER
#   (a) its (url-decoded) basename is in this cut's artifact set — it is about to
#       be uploaded; or
#   (b) it is ALREADY LIVE on the release host — it was uploaded by an earlier
#       publish and is reachable right now.
#
# (b) exists because "present in the local upload set" is only a PROXY for the
# real property, and that proxy is correct for a WHOLE cut but wrong for an
# INCREMENTAL platform publish. bin/publish-platform-incremental.sh deliberately
# merges the LIVE latest.json so it can add one platform without disturbing the
# others; those other platforms are already uploaded and are legitimately absent
# from this upload set. Judging them by (a) alone made the guard structurally
# unpassable on the incremental path whenever any other platform was already
# published — it rejected manifests that were, in fact, entirely serviceable.
#
# Fails CLOSED: a non-2xx, a timeout, a missing curl, or any probe error leaves
# the artifact uncovered, so an unreachable URL is still caught. Reachability is
# probed ONLY for artifacts that already failed (a), so a whole cut makes no
# network calls at all.
#
# Probing uses curl, not urllib: Cloudflare r2.dev hard-403s the default
# Python-urllib User-Agent as a bot while serving curl/* normally, so a urllib
# probe would report every live artifact as missing.
#
# Env:
#   RELEASE_ARTIFACTS_NO_REACHABILITY=1   skip (b) entirely — strict local-set
#                                         checking, for offline/hermetic runs.
#   RELEASE_ARTIFACTS_REACHABILITY_CMD=P  use P <url> instead of curl; exit 0
#                                         means reachable (test seam).
#
# Returns 0 if every advertised url is covered, 1 (and prints the offenders on
# stderr) otherwise. Missing / empty latest_json arguments are skipped
# (latest-server.json is optional — only Server-role cuts produce it).
release_artifacts_assert_urls_covered() {
  local tag="$1"; shift
  local manifest; manifest="$(release_artifacts_manifest_path "$tag")"
  [[ -f "$manifest" ]] || { echo "release-artifacts: no manifest at $manifest to check against." >&2; return 1; }
  python3 - "$manifest" "$@" <<'PY'
import json, os, shutil, subprocess, sys
from urllib.parse import unquote, urlsplit
manifest = sys.argv[1]
have = set()
with open(manifest) as fh:
    for line in fh:
        line = line.strip()
        if line:
            have.add(os.path.basename(line))


def reachable(url):
    """True only on a positive 2xx read. Every failure path returns False."""
    if not url or os.environ.get("RELEASE_ARTIFACTS_NO_REACHABILITY"):
        return False
    probe = os.environ.get("RELEASE_ARTIFACTS_REACHABILITY_CMD")
    try:
        if probe:
            return subprocess.run([probe, url], capture_output=True,
                                  timeout=30).returncode == 0
        if not shutil.which("curl"):
            return False
        # Range-GET a single byte: cheaper than a full GET and, unlike HEAD,
        # not answered by an interstitial on large objects.
        out = subprocess.run(
            ["curl", "-s", "-o", os.devnull, "-w", "%{http_code}",
             "-r", "0-0", "-L", "--max-time", "15", url],
            capture_output=True, text=True, timeout=30).stdout.strip()
        return out in ("200", "206")
    except Exception:
        return False


advertised = []
for mpath in sys.argv[2:]:
    if not mpath or not os.path.isfile(mpath):
        continue
    m = json.load(open(mpath))
    for plat, entry in (m.get("platforms") or {}).items():
        url = (entry or {}).get("url") or ""
        name = os.path.basename(unquote(urlsplit(url).path))
        if not name:
            continue
        if name not in have:
            advertised.append((os.path.basename(mpath), plat, name, url))

missing, already_live = [], []
for mf, plat, name, url in advertised:
    (already_live if reachable(url) else missing).append((mf, plat, name))

if already_live:
    print("release-artifacts: advertised artifact(s) absent from this upload set "
          "but ALREADY LIVE on the release host (incremental publish — allowed):",
          file=sys.stderr)
    for mf, plat, name in already_live:
        print(f"  {mf} [{plat}] -> {name}", file=sys.stderr)
if missing:
    print("release-artifacts: manifest advertises artifact(s) NOT in the upload set "
          "and NOT reachable on the release host:", file=sys.stderr)
    for mf, plat, name in missing:
        print(f"  {mf} [{plat}] -> {name}", file=sys.stderr)
    sys.exit(1)
PY
}

# The published, user-facing artifact suffixes that MUST carry a minisign sibling.
# Longest suffix first so ".app.tar.gz" is never read as a bare archive.
# DiskSpanning ".bin" slices are absent on purpose (D-019): they are normalized into
# the zip and never published on their own.
#
# SINGLE SOURCE for both signature guards below. It is one list precisely because the
# two guards defend the same property at different moments — collection and publish —
# and an extension added to one but not the other reopens a blind spot at whichever
# moment was missed.
RELEASE_ARTIFACTS_SIGNABLE_SUFFIXES=".app.tar.gz .AppImage .deb .dmg .msi .exe .zip"

# release_artifacts_assert_collected_sigs_complete <label> <artifact path...> — RECURRENCE GUARD.
# The property being defended: a COLLECTOR that gathers artifacts off disk must not
# DROP a signature that is sitting right next to an artifact it did collect.
#
# THE BUG THIS FIXES (EI-23962107353168459): the mac collector in
# publish-platform-incremental.sh globbed `dmg/*.dmg` but never `dmg/*.dmg.sig`, so an
# incremental mac publish recorded the DMGs and silently left their signatures out of
# the set. Both .sig files were on disk and independently verified the whole time.
#
# WHY THIS IS A SEPARATE GUARD FROM THE ONE BELOW, AND NOT A DUPLICATE OF IT:
# release_artifacts_assert_signatures_present reads the RECORDED SET, so a signature
# that was never COLLECTED is indistinguishable there from one that was never SIGNED.
# It therefore reports the true symptom in the most misleading available words —
# "would publish an unsigned download" — about an artifact that is, in fact, signed.
# That misdirection is the danger: it points the reader at the signing pipeline, or at
# the guard itself, and whoever hits it mid-release is one step from adding a bypass
# flag to a signature check. This guard fires FIRST and names the actual fault:
# the signature exists at <path>.sig and your glob did not pick it up.
#
# Only a .sig that EXISTS ON DISK but was not collected is an offence. A genuinely
# unsigned artifact is the other guard's business, so a keyless cut never trips this.
#
# Returns 0 when the collected set dropped nothing, 1 (offenders on stderr) otherwise.
release_artifacts_assert_collected_sigs_complete() {
  local label="$1"; shift
  [[ $# -gt 0 ]] || return 0
  if [[ -n "${RELEASE_ARTIFACTS_NO_SIGNATURE_CHECK:-}" ]]; then
    echo "release-artifacts: collected-signature check SKIPPED (RELEASE_ARTIFACTS_NO_SIGNATURE_CHECK)." >&2
    return 0
  fi
  RELEASE_ARTIFACTS_SIGNABLE="$RELEASE_ARTIFACTS_SIGNABLE_SUFFIXES" \
  RELEASE_ARTIFACTS_LABEL="$label" \
  python3 - "$@" <<'PY'
import os, sys

paths = sys.argv[1:]
signable = tuple(s for s in os.environ["RELEASE_ARTIFACTS_SIGNABLE"].split() if s)
label = os.environ.get("RELEASE_ARTIFACTS_LABEL") or "collected"

collected = {os.path.abspath(p) for p in paths}

dropped = []
for path in sorted(collected):
    name = os.path.basename(path)
    if name.endswith(".sig"):
        continue
    if not any(name.endswith(s) for s in signable):
        continue
    sig = path + ".sig"
    if sig in collected:
        continue
    # The distinction that makes this guard precise: only a signature that is
    # demonstrably ON DISK and absent from the set is a collector fault.
    if os.path.isfile(sig):
        dropped.append((name, sig))

if dropped:
    print(f"release-artifacts: the {label} collector DROPPED {len(dropped)} signature(s) that "
          "EXIST ON DISK (EI-23962107353168459). These artifacts ARE signed — the glob that "
          "gathered them simply did not pick up the .sig sibling:", file=sys.stderr)
    for name, sig in dropped:
        print(f"  {name} -> uncollected signature at {sig}", file=sys.stderr)
    print("Fix the collector's glob list. Do NOT relax the publish-time signature check: "
          "it is reporting this fault correctly, just in the wrong words.", file=sys.stderr)
    sys.exit(1)
PY
}

# release_artifacts_assert_signatures_present <tag> — RECURRENCE GUARD.
# The property being defended: every user-facing artifact this cut publishes ships
# with its minisign (.sig) sibling, so a download can be verified against the
# embedded/published updater pubkey — by bin/verify-provenance.sh and by a human.
#
# THE BUG THIS FIXES (EI-20595279927716716): signing followed the UPDATER pipeline
# rather than the PUBLISHED-ARTIFACT set. `tauri build` signs what it bundles, so
# every updater input got a .sig for free — and every download assembled AFTER the
# bundler, or built for humans only, silently got none. Measured across the two
# recorded cuts: `Papercusp Server_<ver>_x64-setup.zip` had no .sig in 0.0.16 OR
# 0.0.17, while every .deb/.AppImage/-setup.exe/.app.tar.gz in the same manifests
# did. One cause, and it is invisible until someone tries to verify a download.
#
# DECISION D-019 (plan release-build-vm-dev-parity-audit-2026-08-13): human-only
# downloads ARE signed too — the alternative (rule that only updater inputs are
# minisigned) leaves the largest download we ship unverifiable. So this guard's
# subject is the PUBLISHED set, not the updater set.
#
# DMGs are part of the published set and must carry the same minisign sibling as
# every other user-facing download. WI-39600 closes the producer-side gap, so no
# artifact extension is exempted here.
#
# Env:
#   RELEASE_ARTIFACTS_NO_SIGNATURE_CHECK=1  skip entirely — for keyless local cuts,
#                                           which legitimately produce no .sig at all.
#
# Returns 0 when every signable artifact has its sibling .sig, 1 (offenders on
# stderr) otherwise.
release_artifacts_assert_signatures_present() {
  local tag="$1"
  if [[ -n "${RELEASE_ARTIFACTS_NO_SIGNATURE_CHECK:-}" ]]; then
    echo "release-artifacts: signature check SKIPPED (RELEASE_ARTIFACTS_NO_SIGNATURE_CHECK)." >&2
    return 0
  fi
  local manifest; manifest="$(release_artifacts_manifest_path "$tag")"
  [[ -f "$manifest" ]] || { echo "release-artifacts: no manifest at $manifest to check signatures against." >&2; return 1; }
  RELEASE_ARTIFACTS_SIGNABLE="$RELEASE_ARTIFACTS_SIGNABLE_SUFFIXES" \
  python3 - "$manifest" <<'PY'
import os, sys
manifest = sys.argv[1]
names = set()
with open(manifest) as fh:
    for line in fh:
        line = line.strip()
        if line:
            names.add(os.path.basename(line))

# The published, user-facing artifact suffixes — read from the single shell-level
# source (RELEASE_ARTIFACTS_SIGNABLE_SUFFIXES) shared with the collector-side guard,
# so a newly published extension cannot be taught to one guard and not the other.
SIGNABLE = tuple(s for s in os.environ["RELEASE_ARTIFACTS_SIGNABLE"].split() if s)

missing = []
for name in sorted(names):
    if name.endswith(".sig"):
        continue
    ext = next((s for s in SIGNABLE if name.endswith(s)), None)
    if not ext:
        continue
    if name + ".sig" not in names:
        missing.append(name)

if missing:
    print("release-artifacts: artifact(s) in this cut have NO sibling .sig — a download "
          "nobody can verify (EI-20595279927716716):", file=sys.stderr)
    for name in missing:
        print(f"  {name} (expected {name}.sig in the same cut)", file=sys.stderr)
    sys.exit(1)
PY
}
