#!/usr/bin/env python3
"""Remove only xattrs that make an Apple bundle fail strict codesign.

Do not use ``xattr -cr`` here: the bundled seed carries required ``user.*``
attributes (for example ``user.device-file``).  macOS exposes the signing
metadata without a namespace; Linux filesystems that preserve it expose the
same names under the ``user.`` namespace.
"""

from __future__ import annotations

import argparse
import ctypes
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

# CPython on macOS 3.9 does not expose os.listxattr/os.removexattr. Use the
# system calls directly there: launching xattr(1) for every bundled file would
# make the pre-signing walk prohibitively slow on a multi-GB sidecar.
if sys.platform == "darwin":
    _libc = ctypes.CDLL(None, use_errno=True)
    _listxattr = _libc.listxattr
    _listxattr.argtypes = (ctypes.c_char_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int)
    _listxattr.restype = ctypes.c_ssize_t
    _removexattr = _libc.removexattr
    _removexattr.argtypes = (ctypes.c_char_p, ctypes.c_char_p, ctypes.c_int)
    _removexattr.restype = ctypes.c_int
    _XATTR_NOFOLLOW = 0x0001


def _darwin_error(path: str) -> OSError:
    code = ctypes.get_errno()
    return OSError(code, os.strerror(code), path)


def _darwin_listxattr(path: str) -> list[str]:
    encoded = os.fsencode(path)
    for _ in range(2):
        size = _listxattr(encoded, None, 0, _XATTR_NOFOLLOW)
        if size < 0:
            raise _darwin_error(path)
        if size == 0:
            return []
        names = ctypes.create_string_buffer(size)
        actual = _listxattr(encoded, names, size, _XATTR_NOFOLLOW)
        if actual >= 0:
            return [os.fsdecode(name) for name in names.raw[:actual].split(b"\0") if name]
        if ctypes.get_errno() != errno.ERANGE:
            raise _darwin_error(path)
    raise _darwin_error(path)


def _darwin_removexattr(path: str, name: str) -> None:
    if _removexattr(os.fsencode(path), os.fsencode(name), _XATTR_NOFOLLOW) != 0:
        raise _darwin_error(path)


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
        if sys.platform == "darwin":
            return _darwin_listxattr(path)
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
                if sys.platform == "darwin":
                    _darwin_removexattr(path, name)
                else:
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
