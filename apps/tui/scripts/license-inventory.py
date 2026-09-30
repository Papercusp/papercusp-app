#!/usr/bin/env python3
"""Write THIRD_PARTY_LICENSES.md for one PUI release unit (P-011 / D-016).

The inventory is DERIVED from `cargo metadata --locked` for the exact target the
unit was built for: every crate linked into `pui` and into the companion WASM
(normal dependencies only — build/dev dependencies are not distributed), with
its declared license, source, and the license/notice texts its crate package
ships. Extra components shipped alongside (the bundled zellij and Node) are
passed in with their pinned license text, and the npm packages psu ships come
from bundle-psu.mjs's summary (D-031). Run at package time on the build host
only; an install never needs python.
"""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path

LICENSE_FILE_PREFIXES = ("LICENSE", "LICENCE", "COPYING", "NOTICE", "UNLICENSE", "COPYRIGHT")


def fail(message: str) -> "None":
    raise SystemExit(f"license-inventory: ERROR: {message}")


def linked_packages(manifest: Path, triple: str) -> list[dict]:
    """Packages reachable from the root through normal dependencies on `triple`."""
    result = subprocess.run(
        [
            "cargo", "metadata", "--format-version", "1", "--locked",
            "--manifest-path", str(manifest), "--filter-platform", triple,
        ],
        check=False, capture_output=True, text=True,
    )
    if result.returncode != 0:
        fail(f"cargo metadata failed for {manifest}: {result.stderr.strip()}")
    metadata = json.loads(result.stdout)
    packages = {package["id"]: package for package in metadata["packages"]}
    nodes = {node["id"]: node for node in metadata["resolve"]["nodes"]}
    root = metadata["resolve"]["root"]
    if root is None:
        fail(f"{manifest} has no root package")
    seen: set[str] = set()
    stack = [root]
    while stack:
        package_id = stack.pop()
        if package_id in seen:
            continue
        seen.add(package_id)
        for dep in nodes[package_id]["deps"]:
            kinds = {kind["kind"] for kind in dep["dep_kinds"]}
            if None in kinds:  # a `normal` dependency is linked into the artifact
                stack.append(dep["pkg"])
    seen.discard(root)
    return [packages[package_id] for package_id in seen]


def license_texts(directory: Path) -> list[tuple[str, str]]:
    texts = []
    for path in sorted(directory.iterdir()):
        if path.is_file() and path.name.upper().startswith(LICENSE_FILE_PREFIXES):
            texts.append((path.name, path.read_text(encoding="utf-8", errors="replace").rstrip()))
    return texts


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument(
        "--crate", action="append", default=[], metavar="MANIFEST=TRIPLE",
        help="Cargo.toml of a shipped artifact and the target it was built for",
    )
    parser.add_argument(
        "--component", action="append", default=[], metavar="NAME=VERSION=LICENSE=SOURCE=TEXT_FILE",
        help="a non-Rust component shipped in the unit, with its license text file",
    )
    parser.add_argument(
        "--npm-packages", metavar="SUMMARY_JSON",
        help="bundle-psu.mjs summary: npm packages shipped in lib/psu (inlined or copied), "
             "each with name, version, license, source and the directory holding its license texts",
    )
    args = parser.parse_args()
    if not args.crate:
        fail("at least one --crate is required")
    npm_packages = []
    if args.npm_packages:
        npm_packages = json.loads(Path(args.npm_packages).read_text(encoding="utf-8"))["npmPackages"]
        unlicensed = sorted(f"{p['name']} {p['version']}" for p in npm_packages if not p.get("license"))
        if unlicensed:
            fail("npm packages without a declared license (review before shipping): " + ", ".join(unlicensed))

    local = []
    crates: dict[tuple[str, str], dict] = {}
    for spec in args.crate:
        manifest, _, triple = spec.partition("=")
        if not triple:
            fail(f"--crate needs MANIFEST=TRIPLE, got {spec!r}")
        for package in linked_packages(Path(manifest), triple):
            if package.get("source") is None:  # a path dependency built from this source
                local.append(package["name"])
                continue
            crates[(package["name"], package["version"])] = package

    missing = sorted(f"{name} {version}" for (name, version), package in crates.items()
                     if not package.get("license") and not package.get("license_file"))
    if missing:
        fail("crates without a declared license (review before shipping): " + ", ".join(missing))

    lines = [
        "# Third-party licenses",
        "",
        "Derived from `cargo metadata --locked` for the exact targets this release was",
        "built for (normal dependencies only), plus the components shipped beside it.",
        *([
            "npm packages are those psu (lib/psu) ships, inlined into its bundle or copied",
            "beside it, each at the version package-lock.json pins for this source.",
        ] if npm_packages else []),
        f"First-party crates built from this source and not listed: {', '.join(sorted(set(local))) or 'none'}.",
        "",
        "| Component | Version | License | Source |",
        "| --- | --- | --- | --- |",
    ]
    components = []
    for spec in args.component:
        parts = spec.split("=", 4)
        if len(parts) != 5:
            fail(f"--component needs NAME=VERSION=LICENSE=SOURCE=TEXT_FILE, got {spec!r}")
        name, version, license_id, source, text_file = parts
        components.append((name, version, license_id, source, Path(text_file).read_text(encoding="utf-8").rstrip()))
        lines.append(f"| {name} | {version} | {license_id} | {source} |")
    for (name, version), package in sorted(crates.items()):
        declared = package.get("license") or f"see {package.get('license_file')}"
        source = package.get("repository") or package.get("source") or ""
        lines.append(f"| {name} | {version} | {declared} | {source} |")
    for package in npm_packages:
        lines.append(f"| {package['name']} (npm) | {package['version']} | {package['license']} | {package['source']} |")
    lines.append("")

    for name, version, license_id, _source, text in components:
        lines += [f"## {name} {version} ({license_id})", "", "```text", text, "```", ""]
    for (name, version), package in sorted(crates.items()):
        texts = license_texts(Path(package["manifest_path"]).parent)
        lines += [f"## {name} {version}", ""]
        if not texts:
            lines += [f"Declared license: {package.get('license')}. The crate package ships no license file.", ""]
        for filename, text in texts:
            lines += [f"### {filename}", "", "```text", text, "```", ""]
    for package in npm_packages:
        texts = license_texts(Path(package["dir"]))
        lines += [f"## {package['name']} {package['version']} (npm)", ""]
        if not texts:
            lines += [f"Declared license: {package['license']}. The npm package ships no license file.", ""]
        for filename, text in texts:
            lines += [f"### {filename}", "", "```text", text, "```", ""]

    Path(args.out).write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"license inventory: {len(crates)} crates, {len(npm_packages)} npm packages, "
          f"{len(components)} components → {args.out}")


if __name__ == "__main__":
    main()
