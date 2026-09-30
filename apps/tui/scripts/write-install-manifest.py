#!/usr/bin/env python3
"""Write or verify the one pui binary/companion generation manifest.

The user-facing installer and the vm-release producer both call this helper so
there is one schema, one hashing implementation, and one atomic-write path.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys


def fail(message: str) -> "None":
    raise SystemExit(f"write-install-manifest: ERROR: {message}")


def sha256_file(path: Path) -> str:
    if not path.is_file():
        fail(f"artifact is missing or not a file: {path}")
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def manifest_artifact_path(manifest: Path, raw: object, label: str) -> Path:
    if not isinstance(raw, str) or not raw:
        fail(f"{label} must be a non-empty string")
    path = Path(raw)
    if path.is_absolute():
        return path
    if ".." in path.parts:
        fail(f"{label} must not escape the manifest directory: {raw}")
    return manifest.parent / path


def represented_path(path: Path, manifest: Path, relative: bool) -> str:
    resolved = path.resolve(strict=True)
    if not relative:
        return str(resolved)
    try:
        return str(resolved.relative_to(manifest.parent.resolve()))
    except ValueError:
        fail(f"relative artifact path escapes manifest directory: {resolved}")


def write_manifest(args: argparse.Namespace) -> None:
    manifest = Path(args.manifest).resolve()
    binary = Path(args.binary)
    companion = Path(args.companion)
    if args.source_dirty not in ("0", "1"):
        fail("--source-dirty must be 0 or 1")
    try:
        built_at_epoch = int(args.built_at_epoch)
    except ValueError:
        fail("--built-at-epoch must be an integer")
    if built_at_epoch <= 0:
        fail("--built-at-epoch must be positive")
    if not args.source_sha.strip():
        fail("--source-sha must be non-empty")

    manifest.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schemaVersion": 1,
        "sourceSha": args.source_sha.strip(),
        "sourceDirty": args.source_dirty == "1",
        "builtAtEpoch": built_at_epoch,
        "binaryPath": represented_path(binary, manifest, args.relative_paths),
        "binarySha256": sha256_file(binary.resolve(strict=True)),
        "companionPath": represented_path(companion, manifest, args.relative_paths),
        "companionSha256": sha256_file(companion.resolve(strict=True)),
    }
    # Optional: the git worktree `--source-sha` was resolved from. `pui doctor`
    # uses it (best-effort) to ask git whether a differing operator build sha is
    # an ANCESTOR of this install's source sha — i.e. this generation already
    # covers it — instead of only ever comparing for exact equality. Omitted
    # (not just null) when the caller doesn't know a root, so an older/other
    # writer's manifest round-trips unchanged.
    if args.source_root and args.source_root.strip():
        payload["sourceRoot"] = args.source_root.strip()
    # Optional: release version and `<os>-<arch>` target. The release packager
    # (package-release.sh) always passes both; `pui self install` refuses a unit
    # without a version and refuses one built for another target by name.
    for key, value in (("version", args.version), ("target", args.target)):
        if value is not None:
            if not value.strip():
                fail(f"--{key} must be non-empty when given")
            payload[key] = value.strip()
    temporary = manifest.with_name(f"{manifest.name}.tmp.{os.getpid()}")
    try:
        temporary.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        temporary.chmod(0o644)
        os.replace(temporary, manifest)
    finally:
        temporary.unlink(missing_ok=True)


def verify_manifest(args: argparse.Namespace) -> None:
    manifest = Path(args.manifest).resolve(strict=True)
    try:
        payload = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"cannot read {manifest}: {error}")
    if payload.get("schemaVersion") != 1:
        fail(f"unsupported schemaVersion {payload.get('schemaVersion')!r}")
    binary = manifest_artifact_path(manifest, payload.get("binaryPath"), "binaryPath").resolve()
    companion = manifest_artifact_path(
        manifest, payload.get("companionPath"), "companionPath"
    ).resolve()
    if args.binary and binary != Path(args.binary).resolve():
        fail(f"binaryPath resolves to {binary}, expected {Path(args.binary).resolve()}")
    if args.companion and companion != Path(args.companion).resolve():
        fail(
            f"companionPath resolves to {companion}, expected {Path(args.companion).resolve()}"
        )
    for path, field in ((binary, "binarySha256"), (companion, "companionSha256")):
        expected = payload.get(field)
        actual = sha256_file(path)
        if expected != actual:
            fail(f"{field} is {expected!r}, but {path} hashes to {actual}")
    print(f"pui install manifest OK: {manifest}")


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser()
    commands = root.add_subparsers(dest="command", required=True)
    write = commands.add_parser("write")
    write.add_argument("--manifest", required=True)
    write.add_argument("--source-sha", required=True)
    write.add_argument("--source-dirty", required=True)
    write.add_argument("--built-at-epoch", required=True)
    write.add_argument("--binary", required=True)
    write.add_argument("--companion", required=True)
    write.add_argument("--relative-paths", action="store_true")
    write.add_argument("--source-root")
    write.add_argument("--version")
    write.add_argument("--target")
    write.set_defaults(run=write_manifest)

    verify = commands.add_parser("verify")
    verify.add_argument("--manifest", required=True)
    verify.add_argument("--binary")
    verify.add_argument("--companion")
    verify.set_defaults(run=verify_manifest)
    return root


def main() -> None:
    args = parser().parse_args()
    args.run(args)


if __name__ == "__main__":
    main()
