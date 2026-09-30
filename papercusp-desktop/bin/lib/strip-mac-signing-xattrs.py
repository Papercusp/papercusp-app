#!/usr/bin/env python3
"""Remove only xattrs that make an Apple bundle fail strict codesign.

Do not use ``xattr -cr`` here: the bundled seed carries required ``user.*``
attributes (for example ``user.device-file``).  macOS exposes the signing
metadata without a namespace; Linux filesystems that preserve it expose the
same names under the ``user.`` namespace.
"""

from __future__ import annotations

import argparse
import errno
import os
import sys
from collections.abc import Iterator


SIGNING_INVALID_XATTRS = frozenset(
    {
        "com.apple.FinderInfo",
        "com.apple.ResourceFork",
        "user.com.apple.FinderInfo",
        "user.com.apple.ResourceFork",
    }
)
NO_XATTR_ERRNOS = frozenset(
    value
    for value in (
        getattr(errno, "ENOTSUP", None),
        getattr(errno, "EOPNOTSUPP", None),
    )
    if value is not None
)
MISSING_XATTR_ERRNOS = frozenset(
    value
    for value in (
        getattr(errno, "ENODATA", None),
        getattr(errno, "ENOATTR", None),
    )
    if value is not None
)


def paths_under(root: str) -> Iterator[str]:
    yield root
    if os.path.islink(root) or not os.path.isdir(root):
        return
    for directory, directories, files in os.walk(root, followlinks=False):
        for name in (*directories, *files):
            path = os.path.join(directory, name)
            if not os.path.islink(path):
                yield path


def list_xattrs(path: str) -> list[str]:
    try:
        return os.listxattr(path, follow_symlinks=False)
    except OSError as exc:
        if exc.errno in NO_XATTR_ERRNOS:
            return []
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="report signing-invalid attributes without changing any files",
    )
    parser.add_argument("root", help="bundle or resource tree to inspect")
    args = parser.parse_args()

    if not os.path.exists(args.root):
        print(f"ERROR: path does not exist: {args.root}", file=sys.stderr)
        return 2

    found: list[tuple[str, str]] = []
    failures: list[str] = []
    for path in paths_under(args.root):
        try:
            xattrs = list_xattrs(path)
        except OSError as exc:
            failures.append(f"{path}: cannot list xattrs: {exc}")
            continue
        for name in xattrs:
            if name not in SIGNING_INVALID_XATTRS:
                continue
            found.append((path, name))
            if args.check:
                continue
            try:
                os.removexattr(path, name, follow_symlinks=False)
            except OSError as exc:
                if exc.errno not in MISSING_XATTR_ERRNOS:
                    failures.append(f"{path}: cannot remove {name}: {exc}")

    if failures:
        for failure in failures:
            print(f"ERROR: {failure}", file=sys.stderr)
        return 2

    if args.check and found:
        for path, name in found:
            print(f"ERROR: signing-invalid xattr {name} on {path}", file=sys.stderr)
        return 1

    if found and not args.check:
        print(f"    ✓ removed {len(found)} Apple signing-invalid xattr(s) under {args.root}")
    else:
        print(f"    ✓ no Apple signing-invalid xattrs under {args.root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
