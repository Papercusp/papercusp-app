#!/usr/bin/env python3
"""Turn packaged env-sidecar clones into verified tar hardlinks.

stage-env-sidecars.sh deliberately hardlinks the staging payload to the primary
sidecar tree. Tauri's Debian archive step flattens those links back into regular
files. This streaming filter restores the source-tree relationship, but only
after proving each staged file is byte-identical to its primary counterpart.
"""

from __future__ import annotations

import copy
import hashlib
import sys
import tarfile


ENV_MARKER = "/sidecar/env-sidecars/staging/"
PRIMARY_MARKER = "/sidecar/"


class HashingReader:
    def __init__(self, source: object) -> None:
        self.source = source
        self.digest = hashlib.sha256()

    def read(self, size: int = -1) -> bytes:
        data = self.source.read(size)  # type: ignore[attr-defined]
        self.digest.update(data)
        return data


def normalized(name: str) -> str:
    return name[2:] if name.startswith("./") else name


def primary_for_staging(name: str) -> str | None:
    clean = normalized(name)
    if ENV_MARKER not in clean:
        return None
    return clean.replace(ENV_MARKER, PRIMARY_MARKER, 1)


def main() -> int:
    primaries: dict[str, tuple[str, int, str]] = {}
    pending_staging: list[tuple[tarfile.TarInfo, str, int, str]] = []
    converted = 0

    with tarfile.open(fileobj=sys.stdin.buffer, mode="r|*") as source:
        # WI-39357: MUST be GNU_FORMAT, not PAX_FORMAT. libdpkg's install/--unpack
        # walker rejects PAX 'x' extended headers with "corrupted filesystem tarfile
        # in package archive: unsupported PAX tar header type 'x'", refusing to
        # install the deb on Ubuntu 24.04 dpkg 1.22.6 (and every dpkg release that
        # ships the same PAX_TAR_HEADER_UNKNOWN reject). `dpkg -x` / `dpkg-deb -c`
        # / `dpkg-deb --fsys-tarfile | tar tv` all TOLERATE PAX 'x' — only the
        # install path refuses — so a test that only exercises those paths misses
        # this class of regression (see the dpkg --unpack --root regression test).
        # PAX 'x' is triggered by any file whose path exceeds the USTAR 100-char
        # limit, so the packaged Papercusp deb (whose sidecar contains paths well
        # past 100 chars) hits it on every entry. GNU_FORMAT encodes long paths
        # and long linknames via GNU 'L'/'K' extended headers which dpkg accepts,
        # and remains USTAR-compatible for short-path entries.
        with tarfile.open(fileobj=sys.stdout.buffer, mode="w|", format=tarfile.GNU_FORMAT) as output:
            for member in source:
                payload = source.extractfile(member) if member.isfile() else None
                primary_name = primary_for_staging(member.name)

                if member.isfile() and primary_name is not None:
                    assert payload is not None
                    digest = hashlib.sha256()
                    read_size = 0
                    while chunk := payload.read(1024 * 1024):
                        digest.update(chunk)
                        read_size += len(chunk)
                    # dpkg-deb commonly orders env-sidecars before the primary
                    # files. Hold only metadata + digest (not the ~196MB payload)
                    # and emit verified hardlink records after the stream has
                    # exposed every possible target.
                    pending_staging.append((copy.copy(member), primary_name, read_size, digest.hexdigest()))
                    continue

                if member.isfile():
                    assert payload is not None
                    reader = HashingReader(payload)
                    output.addfile(member, reader)
                    clean = normalized(member.name)
                    if PRIMARY_MARKER in clean and "/env-sidecars/" not in clean:
                        primaries[clean] = (member.name, member.size, reader.digest.hexdigest())
                else:
                    output.addfile(member)

            for member, primary_name, read_size, staging_digest in pending_staging:
                    expected = primaries.get(primary_name)
                    if expected is None:
                        raise RuntimeError(
                            f"staging entry {member.name!r} has no primary entry {primary_name!r}"
                        )
                    primary_tar_name, primary_size, primary_digest = expected
                    if read_size != primary_size or staging_digest != primary_digest:
                        raise RuntimeError(
                            f"staging entry {member.name!r} differs from primary "
                            f"{primary_tar_name!r}; refusing behavior-changing dedupe"
                        )
                    linked = copy.copy(member)
                    linked.type = tarfile.LNKTYPE
                    linked.linkname = primary_tar_name
                    linked.size = 0
                    output.addfile(linked)
                    converted += 1

    print(f"dedupe-env-sidecar-tar: converted {converted} verified duplicate file(s) to hardlinks", file=sys.stderr)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, tarfile.TarError) as error:
        print(f"FATAL: {error}", file=sys.stderr)
        raise SystemExit(1)
