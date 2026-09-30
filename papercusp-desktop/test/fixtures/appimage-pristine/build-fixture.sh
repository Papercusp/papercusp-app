#!/usr/bin/env bash
# build-fixture.sh — build REAL type-2 AppImages that exercise
# bin/verify-appimage-pristine.sh's three independent assertions.
#
# WHY A REAL PACKED ARTIFACT, NOT AN AppDir TREE
# ----------------------------------------------
# EI-20082207759701826 records that a hand-assembled AppDir does NOT behave like
# a packaged .AppImage, and that reasoning from a tree once produced a confident
# WRONG proof.  So the fixture is genuinely mksquashfs-packed and prefixed with a
# genuine ELF, and the builder REFUSES to emit an artifact whose squashfs is not
# where the ELF header says the file ends — i.e. it fails rather than hand you a
# fixture the guard could only pass by accident.
#
# THE MATRIX — one variant per assertion the guard makes
# -----------------------------------------------------
#   good    self-contained: bundled libfixture is found, AppRun cds, app prints
#           the '[webkit-render] applied' marker.            -> guard must PASS
#   broken  identical, but the bundled libfixture.so.1 is REMOVED from the
#           payload.  Reproduces the EI-20075266271803900 class: an ELF whose
#           DT_NEEDED cannot resolve on a host that does not supply it.
#                                                             -> guard must FAIL (leg A)
#   nocd    identical to good, but AppRun does not `cd "$HERE"`.  Reproduces
#           EI-20075266271803900 root cause 2, where every file was present and
#           executable and only the resolution CWD was wrong.
#                                                             -> guard must FAIL (step 3)
#
# The three failures are raised by three DIFFERENT code paths in the guard, so a
# single over-broad check cannot satisfy the matrix by catching everything.
#
# Usage:  bash build-fixture.sh <absolute-output-dir>
# Output: <dir>/{good,broken,nocd}.AppImage
set -euo pipefail

fail() { echo "FIXTURE-FATAL: $*" >&2; exit 2; }

OUT="${1:-}"
[[ -n "$OUT" ]] || fail "usage: $0 <absolute-output-dir>"
[[ "$OUT" = /* ]] || fail "output dir must be ABSOLUTE (relative writes are unfollowable across subshells): got '$OUT'"
for tool in gcc mksquashfs python3; do
  command -v "$tool" >/dev/null 2>&1 || fail "required tool missing: $tool"
done

mkdir -p "$OUT"
SRC="$OUT/.src"
mkdir -p "$SRC"

# ── the bundled library and the app that NEEDS it ──────────────────────────────
cat > "$SRC/lib.c" <<'EOF'
int fixture_answer(void){ return 42; }
EOF
cat > "$SRC/app.c" <<'EOF'
#include <stdio.h>
#include <unistd.h>
int fixture_answer(void);
int main(void){
  fprintf(stderr, "[fixture] answer=%d\n", fixture_answer());
  /* The guard's positive proof: a silent no-op must not read as a PASS. */
  fprintf(stderr, "[webkit-render] applied 3/3 feature(s) of 3 available\n");
  fflush(stderr);
  sleep(120);
  return 0;
}
EOF

gcc -shared -fPIC -Wl,-soname,libfixture.so.1 -o "$SRC/libfixture.so.1" "$SRC/lib.c"
# No RPATH/RUNPATH on purpose: resolution must come from the AppRun's
# LD_LIBRARY_PATH, exactly as the real artifact's does.
gcc -o "$SRC/fixture-app" "$SRC/app.c" -L"$SRC" -l:libfixture.so.1 -Wl,--disable-new-dtags

# ── the ELF runtime stub that a type-2 AppImage carries in front of the fs ─────
cat > "$SRC/runtime.c" <<'EOF'
#include <stdio.h>
int main(void){ fprintf(stderr, "fixture runtime stub\n"); return 0; }
EOF
gcc -o "$SRC/runtime.elf" "$SRC/runtime.c"

# ── AppDirs ───────────────────────────────────────────────────────────────────
apprun() { # $1 = dir, $2 = "cd" | "nocd"
  local d="$1" mode="$2"
  {
    echo '#!/bin/bash'
    echo 'HERE="$(dirname "$(readlink -f "${0}")")"'
    echo 'export LD_LIBRARY_PATH="$HERE/usr/lib:$HERE/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"'
    echo 'for _wk in "$HERE/usr/libexec/webkit2gtk-4.1" "$HERE/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1"; do :; done'
    [[ "$mode" = "cd" ]] && echo 'cd "$HERE" || true'
    echo 'exec "$HERE/usr/bin/fixture-app" "$@"'
  } > "$d/AppRun"
  chmod +x "$d/AppRun"
}

for variant in good broken nocd; do
  d="$OUT/$variant"
  rm -rf "$d"
  mkdir -p "$d/usr/bin" "$d/usr/lib"
  cp "$SRC/fixture-app" "$d/usr/bin/fixture-app"
  chmod +x "$d/usr/bin/fixture-app"
  # 'broken' deliberately omits the bundled library.
  if [[ "$variant" != "broken" ]]; then
    cp "$SRC/libfixture.so.1" "$d/usr/lib/libfixture.so.1"
  fi
  if [[ "$variant" = "nocd" ]]; then apprun "$d" nocd; else apprun "$d" cd; fi

  # Positive control on the fixture itself: the binary must really NEED the lib,
  # otherwise 'broken' would pass and the whole matrix would be vacuous.
  if ! objdump -p "$d/usr/bin/fixture-app" | grep -q 'NEEDED.*libfixture\.so\.1'; then
    fail "$variant/usr/bin/fixture-app has no DT_NEEDED on libfixture.so.1 — the fixture cannot discriminate"
  fi

  mksquashfs "$d" "$OUT/$variant.sqfs" -noappend -no-progress -quiet
  # A type-2 AppImage appends the squashfs immediately after the ELF's section
  # header table.  Prove that is exactly where concatenation puts it BEFORE
  # emitting the artifact; otherwise the guard's offset derivation would be
  # satisfied by luck rather than by layout.
  DERIVED="$(python3 - "$SRC/runtime.elf" <<'PY'
import struct, sys
with open(sys.argv[1], 'rb') as fh:
    hdr = fh.read(64)
print(struct.unpack_from('<Q', hdr, 0x28)[0]
      + struct.unpack_from('<H', hdr, 0x3A)[0] * struct.unpack_from('<H', hdr, 0x3C)[0])
PY
)"
  RUNTIME_SIZE="$(stat -c %s "$SRC/runtime.elf")"
  [[ "$DERIVED" = "$RUNTIME_SIZE" ]] \
    || fail "runtime stub's section headers do not end at EOF (derived $DERIVED, size $RUNTIME_SIZE) — concatenation would not produce a type-2 layout"
  cat "$SRC/runtime.elf" "$OUT/$variant.sqfs" > "$OUT/$variant.AppImage"
  chmod +x "$OUT/$variant.AppImage"
  echo "built $OUT/$variant.AppImage ($(stat -c %s "$OUT/$variant.AppImage") bytes, squashfs at $DERIVED)"
done
