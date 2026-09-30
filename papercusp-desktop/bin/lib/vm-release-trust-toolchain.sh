#!/usr/bin/env bash
# P-046 / EI-21492557010868835 — build the exact runtime tools admitted into a
# Linux x64 vm-release sidecar.
#
# This file is sourced by build-desktop-sidecar.sh.  It is deliberately an
# internal build helper, not another release surface: the sidecar builder owns
# when it runs, where its verified outputs are copied, and the final SBOM/Grype
# verdict.  Every network input is both version-pinned and SHA-256 pinned.  The
# two upstream Go release binaries that were still Grype-red are rebuilt from
# their signed release commits with only the fixed dependency versions below.

# BUMP THIS whenever any pin below changes. The cache key is this revision alone
# (see _pc_vm_cache_valid), so a pin bump WITHOUT a revision bump silently reuses the
# previously built binary and the change never reaches a bundle. Measured 2026-08-29
# (D-172): the cached 2026-08-26-r2 kopia embeds golang.org/x/crypto v0.53.0.
# 2026-08-29-r1 — kopia's golang.org/x/crypto v0.53.0 -> v0.55.0 for GO-2026-6303
# (High, advisory 2026-08-28): the source-address critical option in the Permissions
# returned by an authentication callback was enforced only on the PublicKeyCallback
# and VerifiedPublicKeyCallback paths. gh in this same toolchain already resolves
# x/crypto v0.55.0, so the version is known to build here.
# 2026-08-29-r2 — r1 never produced a binary: it moved x/crypto to v0.55.0 without its
# co-pin, so the kopia leg died on the x/net constraint below and the sidecar build
# exited 1. Bumping the revision here is belt-and-braces only: _pc_vm_cache_valid() now
# compares EVERY pin against what manifest.json records (EI-21812346842496214), so the
# changed x/net alone already invalidates the cache. Both are kept deliberately — the
# revision is the human-legible marker, the pin comparison is the one that cannot be
# forgotten.
# 2026-09-02-r1 — google.golang.org/grpc -> v1.83.1 in BOTH Go binaries, for
# GHSA-vp52-pcj8-j9qc / CVE-2026-84304 (High, CVSS 4.0 8.7): gRPC-Go heap memory
# exhaustion via HTTP/2 DATA frame fragmentation. Affected range is `<= 1.83.0`, fixed
# in 1.83.1 — read from the grype DB's own record, which is the same DB the sidecar's
# fail-closed vulnerability gate consults, so the gate and this pin cannot disagree.
# The advisory was PUBLISHED 2026-09-01T21:32Z, i.e. AFTER the r18 bundle was built on
# 2026-08-31 — r18 passed this gate legitimately and was not negligent; it simply
# predates the disclosure. Measured on the r19 build, which went RED with exactly two
# High matches and nothing else:
#   [High] /bin/gh    — google.golang.org/grpc@v1.83.0 GHSA-vp52-pcj8-j9qc
#   [High] /bin/kopia — google.golang.org/grpc@v1.82.1 GHSA-vp52-pcj8-j9qc
# NOTE THE ASYMMETRY, because it is the part that bit: kopia already had an explicit
# grpc pin (so it sat at the pinned v1.82.1), while gh had NONE and floated to whatever
# MVS resolved — v1.83.0. Both are affected, so gh needed a NEW pin rather than a bump.
# An unpinned module is not "already current"; it is unmeasured, and it only became
# visible here because the SBOM names every module in the shipped binary.
# NO CO-PIN IS NEEDED, and this was resolved from the module proxy BEFORE rebuilding
# rather than discovered one 14-minute build at a time (the lesson the x/net co-pin
# below cost). grpc v1.83.1's go.mod requires x/net v0.55.0, x/text v0.37.0 (indirect)
# and x/crypto v0.51.0 (indirect) — every one BELOW the versions already pinned here
# (v0.58.0 / v0.41.0 / v0.56.0), so MVS takes ours and no existing pin moves.
# 2026-09-05-r1 — golang.org/x/crypto -> v0.56.0 in BOTH Go binaries for
# GO-2026-6354 / CVE-2026-78662 and GO-2026-6355 / CVE-2026-56855. Both are SSH
# connection-deadlock denial-of-service flaws, published 2026-09-02, and both affect
# versions before v0.56.0. The r22 release gate measured four High matches: gh and
# kopia each embedded v0.55.0. Kopia already declared that version, so its pin moves;
# gh inherited it transitively through x/net v0.58.0, so gh gains a NEW explicit pin
# and post-build assertion. An unpinned transitive module is not a safe/current module.
# v0.56.0's go.mod requires Go 1.26, x/net v0.57.0 and x/text v0.41.0. This recipe
# already builds with Go 1.26.6 and pins x/net v0.58.0 plus x/text v0.41.0, so no
# co-pin moves. Resolved from the canonical module proxy before the rebuild.
# 2026-09-19-r1 — both grpc pins move to v1.83.2 for
# GHSA-2v4p-qf9q-27wj / CVE-2026-84445 (xDS missing-authority panic).
# The official vm-release scan rejected both v1.83.1 binaries. The upstream
# advisory identifies v1.83.2 as patched; its Go 1.25 and x/net v0.58.0
# requirements fit this recipe. Keep the binary assertions and cache-pin check.
PAPERCUSP_VM_TRUST_REVISION="2026-09-19-r1"

PAPERCUSP_VM_NODE_VERSION="v24.18.1"
PAPERCUSP_VM_NODE_LINUX_X64_SHA256="d6c664df3f3f61458e8c277585571328522d705166723a7c7823a9253a4d15a0"

PAPERCUSP_VM_GO_VERSION="1.26.6"
PAPERCUSP_VM_GO_LINUX_X64_SHA256="708effb774be8237570d0add163225abbdfaf4fca28b2611df167beba4feef89"

PAPERCUSP_VM_GH_VERSION="2.98.0"
PAPERCUSP_VM_GH_COMMIT="a255baf71d13fe5947a4eb7ad521ffd412d64cee"
PAPERCUSP_VM_GH_SOURCE_SHA256="52e8e45fb5f5431dd269966c97bbf398fd5c8f1b6fafdc02af182ce4d7012c43"
PAPERCUSP_VM_GH_X_CRYPTO_VERSION="v0.56.0"
PAPERCUSP_VM_GH_X_MOD_VERSION="v0.40.0"
PAPERCUSP_VM_GH_X_NET_VERSION="v0.58.0"
PAPERCUSP_VM_GH_X_TOOLS_VERSION="v0.49.0"
# NEW in 2026-09-02-r1, and note it is a NEW PIN rather than a bump: gh had no grpc
# override at all, so the module floated on MVS and shipped v1.83.0 — inside the
# GHSA-vp52-pcj8-j9qc affected range `<= 1.83.0`. Pinning it makes the version a
# declared, asserted fact instead of a resolution artifact, which is the only reason
# the kopia leg's exposure was already visible while this one was not.
PAPERCUSP_VM_GH_GRPC_VERSION="v1.83.2"

PAPERCUSP_VM_KOPIA_VERSION="0.23.1"
PAPERCUSP_VM_KOPIA_COMMIT="72ec08fd8edb86c67ed27099bf1b955e1f308ffa"
PAPERCUSP_VM_KOPIA_SOURCE_SHA256="5c4267ff00cc09eded390e03b6ff33f59e7df1c8d9230ce001dc509e7cadf8f1"
PAPERCUSP_VM_KOPIA_X_CRYPTO_VERSION="v0.56.0"
PAPERCUSP_VM_KOPIA_X_MOD_VERSION="v0.40.0"
# CO-PIN, not an independent choice: x/crypto v0.56.0 REQUIRES x/net >= v0.57.0, so
# leaving this at v0.56.0 made the GO-2026-6303 fix unbuildable. Measured 2026-08-29,
# the kopia leg of the 2026-08-29-r1 build failed with, verbatim:
#   go: golang.org/x/crypto@v0.55.0 requires golang.org/x/net@v0.57.0, not golang.org/x/net@v0.56.0
# v0.58.0 rather than the minimum v0.57.0 because the gh leg above ALREADY builds with
# v0.58.0 under this same Go version on this same box, so it is the value proven here;
# it also puts both shipped Go binaries on ONE x/net instead of two to reason about.
# NOTE for whoever bumps x/crypto next: these two move TOGETHER. The failure mode is a
# hard build error, not a silent downgrade, so it cannot ship a vulnerable binary.
PAPERCUSP_VM_KOPIA_X_NET_VERSION="v0.58.0"
# SECOND co-pin of the x/crypto line: v0.56.0's go.mod still requires x/text v0.41.0
# (indirect), and x/net v0.58.0 requires it directly. These are applied by ONE joint
# `go get` below, where an explicitly-requested LOWER version is a hard conflict rather
# than an MVS upgrade — the same failure shape as the x/net pin above, which is why it
# was worth resolving all of them from the module proxy before rebuilding instead of
# discovering them one expensive build at a time. Checked at the same time and NOT
# needing a bump: x/mod v0.40.0 (wants x/tools, unpinned for kopia).
# (2026-09-02-r1 CORRECTION: this comment used to also say grpc v1.82.1 did not need a
# bump. That was true of its CO-PIN pressure and remains true — v1.83.1 still wants only
# x/net v0.55.0 / x/text v0.37.0, below ours — but it was never a statement about grpc's
# own vulnerability status, and it read like one. grpc moved to v1.83.1 for
# GHSA-vp52-pcj8-j9qc; see the trust-revision block at the top.)
PAPERCUSP_VM_KOPIA_X_TEXT_VERSION="v0.41.0"
PAPERCUSP_VM_KOPIA_GRPC_VERSION="v1.83.2"

PAPERCUSP_VM_POSTGRES_VERSION="18.6"
PAPERCUSP_VM_POSTGRES_SOURCE_SHA256="555610c24d53e4316da5b7d3fc25c279d96856d5e0e23ee308c328c5fa881d9f"
PAPERCUSP_VM_OPENSSL_VERSION="3.5.8"
PAPERCUSP_VM_OPENSSL_SOURCE_SHA256="a8f84a39918ec6415ce765d9b429d313ba97b8143169c172e734b9514464f5b2"

_pc_vm_sha256() {
  sha256sum "$1" | awk '{print $1}'
}

_pc_vm_verify_sha256() {
  local file="$1" expected="$2" label="$3" actual
  actual="$(_pc_vm_sha256 "$file")"
  if [[ "$actual" != "$expected" ]]; then
    echo "ERROR: $label SHA-256 mismatch" >&2
    echo "       expected: $expected" >&2
    echo "       actual:   $actual" >&2
    echo "       file:     $file" >&2
    return 1
  fi
}

_pc_vm_download() {
  local url="$1" expected="$2" dest="$3" label="$4"
  local partial="${dest}.partial.$$"
  if ! curl -fsSL "$url" -o "$partial"; then
    echo "ERROR: failed to download $label from $url" >&2
    rm -f "$partial"
    return 1
  fi
  if ! _pc_vm_verify_sha256 "$partial" "$expected" "$label"; then
    rm -f "$partial"
    return 1
  fi
  mv "$partial" "$dest"
}

_pc_vm_require_commands() {
  local missing=0 command_name
  for command_name in curl sha256sum tar make gcc g++ perl bison flex file flock patchelf python3 node rg; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
      echo "ERROR: vm-release trust toolchain requires '$command_name' on PATH" >&2
      missing=1
    fi
  done
  [[ "$missing" -eq 0 ]]
}

_pc_vm_cache_valid() {
  local root="$1"
  [[ -f "$root/manifest.json" \
     && -x "$root/bin/node" \
     && -x "$root/bin/gh" \
     && -x "$root/bin/kopia" \
     && -x "$root/postgresql/bin/postgres" \
     && -x "$root/postgresql/bin/initdb" \
     && -x "$root/postgresql/bin/pg_ctl" \
     && -f "$root/postgresql/lib/pgcrypto.so" \
     && -f "$root/postgresql/lib/pg_trgm.so" \
     && -f "$root/postgresql/share/extension/pgcrypto.control" \
     && -f "$root/postgresql/share/extension/pg_trgm.control" \
     && -f "$root/postgresql/lib/libcrypto.so.3" \
     && -f "$root/postgresql/lib/libssl.so.3" ]] || return 1

  [[ "$("$root/bin/node" --version 2>/dev/null)" == "$PAPERCUSP_VM_NODE_VERSION" ]] || return 1
  "$root/bin/gh" --version 2>/dev/null | head -1 | grep -Fq "gh version ${PAPERCUSP_VM_GH_VERSION}-papercusp.1" || return 1
  "$root/bin/kopia" --version 2>/dev/null | head -1 | grep -Fq "${PAPERCUSP_VM_KOPIA_VERSION}-papercusp.1" || return 1
  [[ "$("$root/postgresql/bin/postgres" --version 2>/dev/null)" == "postgres (PostgreSQL) $PAPERCUSP_VM_POSTGRES_VERSION" ]] || return 1

  # The revision is the cache KEY, so it is necessary but not sufficient: a pin edited
  # without a revision bump would otherwise be silently answered from a stale binary and
  # never reach a bundle. Measured 2026-08-29 (D-172) on the real cache — the
  # 2026-08-26-r2 kopia embeds golang.org/x/crypto v0.53.0, carrying GO-2026-6303 (High)
  # into a signed release. Re-derive the pins here rather than trusting the key alone: the
  # manifest already RECORDS what was built, so comparing it to what is PINNED now costs
  # nothing and turns a silent stale hit into a rebuild. Bumping the revision remains the
  # documented practice; this makes forgetting it non-load-bearing.
  PC_VM_EXPECTED_PINS="$(cat <<JSON
{
  "revision": "$PAPERCUSP_VM_TRUST_REVISION",
  "compilerRuntimeProvenance": {
    "builderHost": "linux-x64",
    "platformOwnedRecipes": {
      "linuxX64": "papercusp-desktop/bin/lib/vm-release-trust-toolchain.sh",
      "macOS": "papercusp-desktop/bin/release-local.sh",
      "windowsX64": "papercusp-desktop/bin/build-windows-cross.sh"
    },
    "shippedTargetTriples": {
      "linuxX64": ["x86_64-unknown-linux-gnu"],
      "macOS": ["x86_64-apple-darwin", "aarch64-apple-darwin"],
      "windowsX64": ["x86_64-pc-windows-msvc"]
    }
  },
  "node": {
    "version": "$PAPERCUSP_VM_NODE_VERSION",
    "license": "MIT"
  },
  "go": {
    "version": "$PAPERCUSP_VM_GO_VERSION",
    "license": "BSD-3-Clause"
  },
  "githubCli": {
    "version": "$PAPERCUSP_VM_GH_VERSION-papercusp.1",
    "commit": "$PAPERCUSP_VM_GH_COMMIT",
    "license": "MIT",
    "moduleOverrides": {
      "golang.org/x/crypto": "$PAPERCUSP_VM_GH_X_CRYPTO_VERSION",
      "golang.org/x/mod": "$PAPERCUSP_VM_GH_X_MOD_VERSION",
      "golang.org/x/net": "$PAPERCUSP_VM_GH_X_NET_VERSION",
      "golang.org/x/tools": "$PAPERCUSP_VM_GH_X_TOOLS_VERSION",
      "google.golang.org/grpc": "$PAPERCUSP_VM_GH_GRPC_VERSION"
    }
  },
  "kopia": {
    "version": "$PAPERCUSP_VM_KOPIA_VERSION-papercusp.1",
    "commit": "$PAPERCUSP_VM_KOPIA_COMMIT",
    "license": "Apache-2.0",
    "moduleOverrides": {
      "golang.org/x/crypto": "$PAPERCUSP_VM_KOPIA_X_CRYPTO_VERSION",
      "golang.org/x/mod": "$PAPERCUSP_VM_KOPIA_X_MOD_VERSION",
      "golang.org/x/net": "$PAPERCUSP_VM_KOPIA_X_NET_VERSION",
      "golang.org/x/text": "$PAPERCUSP_VM_KOPIA_X_TEXT_VERSION",
      "google.golang.org/grpc": "$PAPERCUSP_VM_KOPIA_GRPC_VERSION"
    }
  },
  "postgresql": {
    "version": "$PAPERCUSP_VM_POSTGRES_VERSION",
    "license": "PostgreSQL",
    "opensslLicense": "Apache-2.0",
    "opensslVersion": "$PAPERCUSP_VM_OPENSSL_VERSION"
  }
}
JSON
)"
  export PC_VM_EXPECTED_PINS
  python3 - "$root/manifest.json" <<'PY'
import json
import os
import sys

with open(sys.argv[1], encoding="utf-8") as source:
    manifest = json.load(source)
expected = json.loads(os.environ["PC_VM_EXPECTED_PINS"])


def stale(path, want, got):
    print(
        f"  vm-release trust cache STALE: {path} is {got!r}, pinned {want!r} — rebuilding",
        file=sys.stderr,
    )
    raise SystemExit(1)


def compare(want, got, path=""):
    if isinstance(want, dict):
        if not isinstance(got, dict):
            stale(path or "<root>", want, got)
        for key, sub in want.items():
            compare(sub, got.get(key), f"{path}.{key}" if path else key)
        return
    if want != got:
        stale(path, want, got)


compare(expected, manifest)
PY
}

_pc_vm_assert_module() {
  local go_bin="$1" binary="$2" module="$3" version="$4"
  if ! "$go_bin" version -m "$binary" \
      | awk -F '\t' -v module="$module" -v version="$version" \
          '$2 == "dep" && $3 == module && $4 == version { found=1 } END { exit found ? 0 : 1 }'; then
    echo "ERROR: $(basename "$binary") does not embed $module@$version" >&2
    return 1
  fi
}

_pc_vm_build_go_tools() {
  local work="$1" output="$2" go_bin="$3"
  local gh_src="$work/gh-src" kopia_src="$work/kopia-src"
  mkdir -p "$gh_src" "$kopia_src" "$output/bin"

  _pc_vm_download \
    "https://codeload.github.com/cli/cli/tar.gz/$PAPERCUSP_VM_GH_COMMIT" \
    "$PAPERCUSP_VM_GH_SOURCE_SHA256" "$work/gh-source.tar.gz" "GitHub CLI source"
  tar -xzf "$work/gh-source.tar.gz" -C "$gh_src" --strip-components=1
  (
    cd "$gh_src"
    export GOTOOLCHAIN=local
    export GOWORK=off
    export GOPATH="$work/gopath-gh"
    export GOMODCACHE="$work/gomodcache-gh"
    "$go_bin" mod edit -toolchain=none
    "$go_bin" get \
      "golang.org/x/crypto@$PAPERCUSP_VM_GH_X_CRYPTO_VERSION" \
      "golang.org/x/mod@$PAPERCUSP_VM_GH_X_MOD_VERSION" \
      "golang.org/x/net@$PAPERCUSP_VM_GH_X_NET_VERSION" \
      "golang.org/x/tools@$PAPERCUSP_VM_GH_X_TOOLS_VERSION" \
      "google.golang.org/grpc@$PAPERCUSP_VM_GH_GRPC_VERSION"
    CGO_ENABLED=0 "$go_bin" build -trimpath -buildvcs=false \
      -ldflags "-buildid= -X github.com/cli/cli/v2/internal/build.Version=${PAPERCUSP_VM_GH_VERSION}-papercusp.1 -X github.com/cli/cli/v2/internal/build.Date=2026-08-20" \
      -o "$output/bin/gh" ./cmd/gh
  )
  "$output/bin/gh" --version | head -1 | grep -Fq "gh version ${PAPERCUSP_VM_GH_VERSION}-papercusp.1"
  _pc_vm_assert_module "$go_bin" "$output/bin/gh" golang.org/x/crypto "$PAPERCUSP_VM_GH_X_CRYPTO_VERSION"
  _pc_vm_assert_module "$go_bin" "$output/bin/gh" golang.org/x/mod "$PAPERCUSP_VM_GH_X_MOD_VERSION"
  # Asserted because this is the security-relevant pin: `go get` raising a version and the
  # BUILT BINARY actually embedding it are two different claims, and only the second one
  # ships. Without this, a pin that silently failed to take would read as applied right up
  # until the SBOM gate caught it 14 minutes later — or, worse, did not.
  _pc_vm_assert_module "$go_bin" "$output/bin/gh" google.golang.org/grpc "$PAPERCUSP_VM_GH_GRPC_VERSION"

  _pc_vm_download \
    "https://codeload.github.com/kopia/kopia/tar.gz/$PAPERCUSP_VM_KOPIA_COMMIT" \
    "$PAPERCUSP_VM_KOPIA_SOURCE_SHA256" "$work/kopia-source.tar.gz" "Kopia source"
  tar -xzf "$work/kopia-source.tar.gz" -C "$kopia_src" --strip-components=1
  (
    cd "$kopia_src"
    export GOTOOLCHAIN=local
    export GOWORK=off
    export GOPATH="$work/gopath-kopia"
    export GOMODCACHE="$work/gomodcache-kopia"
    "$go_bin" mod edit -toolchain=none
    "$go_bin" get \
      "golang.org/x/crypto@$PAPERCUSP_VM_KOPIA_X_CRYPTO_VERSION" \
      "golang.org/x/mod@$PAPERCUSP_VM_KOPIA_X_MOD_VERSION" \
      "golang.org/x/net@$PAPERCUSP_VM_KOPIA_X_NET_VERSION" \
      "golang.org/x/text@$PAPERCUSP_VM_KOPIA_X_TEXT_VERSION" \
      "google.golang.org/grpc@$PAPERCUSP_VM_KOPIA_GRPC_VERSION"
    CGO_ENABLED=0 "$go_bin" build -trimpath -buildvcs=false -tags nohtmlui \
      -ldflags "-buildid= -X github.com/kopia/kopia/repo.BuildVersion=${PAPERCUSP_VM_KOPIA_VERSION}-papercusp.1 -X github.com/kopia/kopia/repo.BuildInfo=$PAPERCUSP_VM_KOPIA_COMMIT -X github.com/kopia/kopia/repo.BuildGitHubRepo=kopia/kopia" \
      -o "$output/bin/kopia" github.com/kopia/kopia
  )
  "$output/bin/kopia" --version | head -1 | grep -Fq "${PAPERCUSP_VM_KOPIA_VERSION}-papercusp.1"
  "$output/bin/kopia" snapshot create --help >/dev/null
  _pc_vm_assert_module "$go_bin" "$output/bin/kopia" golang.org/x/crypto "$PAPERCUSP_VM_KOPIA_X_CRYPTO_VERSION"
  _pc_vm_assert_module "$go_bin" "$output/bin/kopia" golang.org/x/mod "$PAPERCUSP_VM_KOPIA_X_MOD_VERSION"
  _pc_vm_assert_module "$go_bin" "$output/bin/kopia" golang.org/x/net "$PAPERCUSP_VM_KOPIA_X_NET_VERSION"
  _pc_vm_assert_module "$go_bin" "$output/bin/kopia" golang.org/x/text "$PAPERCUSP_VM_KOPIA_X_TEXT_VERSION"
  _pc_vm_assert_module "$go_bin" "$output/bin/kopia" google.golang.org/grpc "$PAPERCUSP_VM_KOPIA_GRPC_VERSION"
}

_pc_vm_patch_elf_rpaths() {
  local prefix="$1" elf
  while IFS= read -r elf; do
    file -b "$elf" | grep -q '^ELF' || continue
    case "$elf" in
      "$prefix"/bin/*) patchelf --set-rpath '$ORIGIN/../lib' "$elf" ;;
      "$prefix"/lib/*) patchelf --set-rpath '$ORIGIN' "$elf" ;;
    esac
  done < <(find "$prefix/bin" "$prefix/lib" -type f)
}

_pc_vm_prune_postgres_build_residue() {
  local prefix="$1" binary base
  for binary in "$prefix/bin/"*; do
    [[ -e "$binary" ]] || continue
    base="$(basename "$binary")"
    case "$base" in
      postgres|initdb|pg_ctl|psql|pg_dump|pg_dumpall|pg_restore) ;;
      *) rm -f "$binary" ;;
    esac
  done
  rm -rf \
    "$prefix/include" \
    "$prefix/lib/cmake" \
    "$prefix/lib/pgxs" \
    "$prefix/lib/pkgconfig" \
    "$prefix/lib/postgresql/pgxs" \
    "$prefix/share/doc" \
    "$prefix/share/man"
  find "$prefix/lib" -maxdepth 1 -type f \( -name '*.a' -o -name '*.la' \) -delete
}

_pc_vm_probe_postgres() {
  local prefix="$1" work="$2" probe_port data_dir socket_dir started=0 output
  if [[ "$(id -u)" -eq 0 ]]; then
    echo "ERROR: vm-release PostgreSQL source probe refuses to run as root" >&2
    echo "       Run the release builder as its ordinary non-root build identity." >&2
    return 1
  fi
  probe_port="$(python3 - <<'PY'
import socket
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
)"
  data_dir="$work/postgres-probe-data"
  socket_dir="$work/postgres-probe-socket"
  mkdir -p "$socket_dir"
  "$prefix/bin/initdb" -D "$data_dir" --username=postgres --auth=trust \
    --locale=C --lc-messages=C --encoding=UTF8 >"$work/postgres-initdb.log"
  _pc_vm_stop_probe() {
    if [[ "$started" -eq 1 ]]; then
      "$prefix/bin/pg_ctl" -D "$data_dir" -m fast -w stop >/dev/null 2>&1 || true
    fi
  }
  trap _pc_vm_stop_probe RETURN
  "$prefix/bin/pg_ctl" -D "$data_dir" \
    -o "-k $socket_dir -p $probe_port -c listen_addresses=''" -w start \
    >"$work/postgres-start.log"
  started=1
  output="$("$prefix/bin/psql" -h "$socket_dir" -p "$probe_port" -U postgres \
    -d postgres -v ON_ERROR_STOP=1 -Atc \
    "CREATE EXTENSION pgcrypto; CREATE EXTENSION pg_trgm; SELECT extname || ':' || extversion FROM pg_extension WHERE extname IN ('pgcrypto', 'pg_trgm') ORDER BY extname; SELECT length(gen_random_bytes(16)); SELECT CASE WHEN similarity('papercusp', 'papercup') > 0 THEN 'pg_trgm-ok' ELSE 'pg_trgm-bad' END;")"
  grep -Fq 'pgcrypto:' <<<"$output"
  grep -Fq 'pg_trgm:' <<<"$output"
  grep -Fq '16' <<<"$output"
  grep -Fq 'pg_trgm-ok' <<<"$output"
  "$prefix/bin/pg_ctl" -D "$data_dir" -m fast -w stop >/dev/null
  started=0
  trap - RETURN
}

_pc_vm_sanitize_postgres_config_info() {
  local source_root="$1"
  python3 - "$source_root/src/common/config_info.c" \
    "$PAPERCUSP_VM_POSTGRES_VERSION" "$PAPERCUSP_VM_OPENSSL_VERSION" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
postgres_version = sys.argv[2]
openssl_version = sys.argv[3]
source = path.read_text(encoding="utf-8")
replacements = {
    "pstrdup(CONFIGURE_ARGS)": (
        f'pstrdup("--prefix=/opt/papercusp-postgresql-{postgres_version} '
        f'--with-ssl=openssl (Papercusp vm-release pinned source build)")'
    ),
    "pstrdup(VAL_CPPFLAGS)": (
        f'pstrdup("OpenSSL {openssl_version} headers (checksum-pinned source)")'
    ),
    "pstrdup(VAL_CFLAGS)": (
        'pstrdup("-O2 -ffile-prefix-map=<build>=/usr/src/papercusp-vm-release")'
    ),
    "pstrdup(VAL_CFLAGS_SL)": 'pstrdup("-fPIC")',
    "pstrdup(VAL_LDFLAGS)": (
        'pstrdup("-Wl,-rpath,$ORIGIN/../lib (relocatable vendored OpenSSL)")'
    ),
    "pstrdup(VAL_LDFLAGS_EX)": 'pstrdup("relocatable executable")',
    "pstrdup(VAL_LDFLAGS_SL)": 'pstrdup("relocatable shared library")',
}
for old, new in replacements.items():
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"expected one {old!r} in {path}, found {count}")
    source = source.replace(old, new)
path.write_text(source, encoding="utf-8")
PY
}

_pc_vm_build_postgres() {
  local work="$1" output="$2"
  local openssl_src="$work/openssl-src" postgres_src="$work/postgresql-src"
  local stage="$work/postgresql-stage"
  local install_prefix="/opt/papercusp-postgresql-$PAPERCUSP_VM_POSTGRES_VERSION"
  local prefix="$stage$install_prefix"
  mkdir -p "$openssl_src" "$postgres_src" "$stage"

  _pc_vm_download \
    "https://www.openssl.org/source/openssl-${PAPERCUSP_VM_OPENSSL_VERSION}.tar.gz" \
    "$PAPERCUSP_VM_OPENSSL_SOURCE_SHA256" "$work/openssl-source.tar.gz" "OpenSSL source"
  tar -xzf "$work/openssl-source.tar.gz" -C "$openssl_src" --strip-components=1
  (
    cd "$openssl_src"
    ./Configure linux-x86_64 --prefix="$install_prefix" \
      --openssldir="$install_prefix/ssl" --libdir=lib shared no-docs no-tests \
      >"$work/openssl-configure.log" 2>&1
    make -j"${PAPERCUSP_VM_BUILD_JOBS:-4}" >"$work/openssl-make.log" 2>&1
    make DESTDIR="$stage" install_sw >"$work/openssl-install.log" 2>&1
  )

  _pc_vm_download \
    "https://ftp.postgresql.org/pub/source/v${PAPERCUSP_VM_POSTGRES_VERSION}/postgresql-${PAPERCUSP_VM_POSTGRES_VERSION}.tar.bz2" \
    "$PAPERCUSP_VM_POSTGRES_SOURCE_SHA256" "$work/postgresql-source.tar.bz2" "PostgreSQL source"
  tar -xjf "$work/postgresql-source.tar.bz2" -C "$postgres_src" --strip-components=1
  (
    cd "$postgres_src"
    CPPFLAGS="-I$prefix/include" \
    LDFLAGS="-L$prefix/lib" \
    CFLAGS="-O2 -ffile-prefix-map=$work=/usr/src/papercusp-vm-release" \
      ./configure --prefix="$install_prefix" --with-ssl=openssl \
        --without-readline --without-zlib --without-icu --without-ldap \
        --without-libxml --without-libxslt --without-lz4 --without-zstd \
        >"$work/postgresql-configure.log" 2>&1
    # PostgreSQL exposes its build flags through pg_config()/config_info.c and
    # otherwise compiles our random temporary SDK paths into the postmaster.
    # Keep the useful configuration facts while replacing only those diagnostic
    # strings with stable, non-identifying equivalents before compilation.
    _pc_vm_sanitize_postgres_config_info "$postgres_src"
    make -j"${PAPERCUSP_VM_BUILD_JOBS:-4}" >"$work/postgresql-make.log" 2>&1
    make DESTDIR="$stage" install >"$work/postgresql-install.log" 2>&1
    # The operator's first-boot and pre-migrated-seed paths both create these
    # extensions before applying schema migrations. Building only pgcrypto can
    # pass the trust probe yet leave every release unable to create the
    # pg_trgm-backed lexical indexes. Compile, install, and probe both required
    # contrib modules as one admitted PostgreSQL runtime closure.
    for extension in pgcrypto pg_trgm; do
      make -C "contrib/$extension" -j"${PAPERCUSP_VM_BUILD_JOBS:-4}" \
        >"$work/${extension}-make.log" 2>&1
      make -C "contrib/$extension" DESTDIR="$stage" install \
        >"$work/${extension}-install.log" 2>&1
    done
  )

  _pc_vm_patch_elf_rpaths "$prefix"
  _pc_vm_prune_postgres_build_residue "$prefix"
  [[ "$("$prefix/bin/postgres" --version)" == "postgres (PostgreSQL) $PAPERCUSP_VM_POSTGRES_VERSION" ]]
  [[ -f "$prefix/lib/pgcrypto.so" \
     && -f "$prefix/share/extension/pgcrypto.control" \
     && -f "$prefix/lib/pg_trgm.so" \
     && -f "$prefix/share/extension/pg_trgm.control" ]]
  ldd "$prefix/bin/postgres" | grep -F 'libssl.so.3 =>' | grep -Fq "$prefix"
  ldd "$prefix/lib/pgcrypto.so" | grep -F 'libcrypto.so.3 =>' | grep -Fq "$prefix"
  _pc_vm_probe_postgres "$prefix" "$work"

  mkdir -p "$output"
  cp -a "$prefix/." "$output/"
}

_pc_vm_write_manifest() {
  local root="$1"
  python3 - "$root" <<PY
import hashlib
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])

def digest(relative):
    value = hashlib.sha256()
    with (root / relative).open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()

manifest = {
    "schemaVersion": 1,
    "revision": "$PAPERCUSP_VM_TRUST_REVISION",
    "platform": "linux-x64",
    "compilerRuntimeProvenance": {
        "builderHost": "linux-x64",
        "platformOwnedRecipes": {
            "linuxX64": "papercusp-desktop/bin/lib/vm-release-trust-toolchain.sh",
            "macOS": "papercusp-desktop/bin/release-local.sh",
            "windowsX64": "papercusp-desktop/bin/build-windows-cross.sh",
        },
        "shippedTargetTriples": {
            "linuxX64": ["x86_64-unknown-linux-gnu"],
            "macOS": ["x86_64-apple-darwin", "aarch64-apple-darwin"],
            "windowsX64": ["x86_64-pc-windows-msvc"],
        },
    },
    "node": {
        "version": "$PAPERCUSP_VM_NODE_VERSION",
        "license": "MIT",
        "archiveSha256": "$PAPERCUSP_VM_NODE_LINUX_X64_SHA256",
        "binarySha256": digest("bin/node"),
    },
    "go": {
        "version": "$PAPERCUSP_VM_GO_VERSION",
        "license": "BSD-3-Clause",
        "archiveSha256": "$PAPERCUSP_VM_GO_LINUX_X64_SHA256",
    },
    "githubCli": {
        "version": "$PAPERCUSP_VM_GH_VERSION-papercusp.1",
        "commit": "$PAPERCUSP_VM_GH_COMMIT",
        "license": "MIT",
        "sourceSha256": "$PAPERCUSP_VM_GH_SOURCE_SHA256",
        "binarySha256": digest("bin/gh"),
        "moduleOverrides": {
            "golang.org/x/crypto": "$PAPERCUSP_VM_GH_X_CRYPTO_VERSION",
            "golang.org/x/mod": "$PAPERCUSP_VM_GH_X_MOD_VERSION",
            "golang.org/x/net": "$PAPERCUSP_VM_GH_X_NET_VERSION",
            "golang.org/x/tools": "$PAPERCUSP_VM_GH_X_TOOLS_VERSION",
            "google.golang.org/grpc": "$PAPERCUSP_VM_GH_GRPC_VERSION",
        },
    },
    "kopia": {
        "version": "$PAPERCUSP_VM_KOPIA_VERSION-papercusp.1",
        "commit": "$PAPERCUSP_VM_KOPIA_COMMIT",
        "license": "Apache-2.0",
        "sourceSha256": "$PAPERCUSP_VM_KOPIA_SOURCE_SHA256",
        "binarySha256": digest("bin/kopia"),
        "moduleOverrides": {
            "golang.org/x/crypto": "$PAPERCUSP_VM_KOPIA_X_CRYPTO_VERSION",
            "golang.org/x/mod": "$PAPERCUSP_VM_KOPIA_X_MOD_VERSION",
            "golang.org/x/net": "$PAPERCUSP_VM_KOPIA_X_NET_VERSION",
            "golang.org/x/text": "$PAPERCUSP_VM_KOPIA_X_TEXT_VERSION",
            "google.golang.org/grpc": "$PAPERCUSP_VM_KOPIA_GRPC_VERSION",
        },
    },
    "postgresql": {
        "version": "$PAPERCUSP_VM_POSTGRES_VERSION",
        "license": "PostgreSQL",
        "sourceSha256": "$PAPERCUSP_VM_POSTGRES_SOURCE_SHA256",
        "opensslVersion": "$PAPERCUSP_VM_OPENSSL_VERSION",
        "opensslLicense": "Apache-2.0",
        "opensslSourceSha256": "$PAPERCUSP_VM_OPENSSL_SOURCE_SHA256",
        "postgresBinarySha256": digest("postgresql/bin/postgres"),
        "extensions": {
            "pgcrypto": {
                "binarySha256": digest("postgresql/lib/pgcrypto.so"),
                "controlSha256": digest("postgresql/share/extension/pgcrypto.control"),
            },
            "pg_trgm": {
                "binarySha256": digest("postgresql/lib/pg_trgm.so"),
                "controlSha256": digest("postgresql/share/extension/pg_trgm.control"),
            },
        },
    },
}
tmp = root / "manifest.json.tmp"
tmp.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
tmp.replace(root / "manifest.json")
PY
}

papercusp_prepare_vm_release_trust_toolchain() {
  local cache_base="$1" target_os="$2" target_arch="$3"
  local final_root="$cache_base/$PAPERCUSP_VM_TRUST_REVISION-linux-x64"
  local work output go_archive go_bin leak

  if [[ "$target_os" != "linux" || "$target_arch" != "x64" ]]; then
    echo "ERROR: vm-release's pinned trust toolchain currently supports only linux-x64" >&2
    echo "       requested: ${target_os}-${target_arch}; refusing to fall back to stale ambient binaries" >&2
    return 1
  fi
  _pc_vm_require_commands
  mkdir -p "$cache_base"

  # A second sidecar output path may build concurrently.  Serialize only this
  # shared cache; the main builder's own lock protects its assembled tree.
  exec 7>"$cache_base/.build.lock"
  flock -w 3600 7
  if _pc_vm_cache_valid "$final_root"; then
    export PAPERCUSP_VM_RELEASE_TRUST_ROOT="$final_root"
    echo "  ✓ vm-release trust toolchain cached at $final_root"
    flock -u 7
    exec 7>&-
    return 0
  fi
  if [[ -e "$final_root" ]]; then
    mv "$final_root" "$final_root.invalid.$(date -u +%Y%m%dT%H%M%SZ).$$"
  fi

  work="$(mktemp -d /tmp/papercusp-vm-release-trust.XXXXXX)"
  output="$work/output"
  mkdir -p "$output/bin"

  _pc_vm_download \
    "https://go.dev/dl/go${PAPERCUSP_VM_GO_VERSION}.linux-amd64.tar.gz" \
    "$PAPERCUSP_VM_GO_LINUX_X64_SHA256" "$work/go.tar.gz" "Go toolchain"
  tar -xzf "$work/go.tar.gz" -C "$work"
  go_bin="$work/go/bin/go"
  [[ "$("$go_bin" version)" == "go version go${PAPERCUSP_VM_GO_VERSION} linux/amd64" ]]

  _pc_vm_download \
    "https://nodejs.org/dist/${PAPERCUSP_VM_NODE_VERSION}/node-${PAPERCUSP_VM_NODE_VERSION}-linux-x64.tar.xz" \
    "$PAPERCUSP_VM_NODE_LINUX_X64_SHA256" "$work/node.tar.xz" "Node.js runtime"
  tar -xJf "$work/node.tar.xz" -C "$output/bin" --strip-components=2 \
    "node-${PAPERCUSP_VM_NODE_VERSION}-linux-x64/bin/node"
  chmod 755 "$output/bin/node"
  [[ "$("$output/bin/node" --version)" == "$PAPERCUSP_VM_NODE_VERSION" ]]

  _pc_vm_build_go_tools "$work" "$output" "$go_bin"
  _pc_vm_build_postgres "$work" "$output/postgresql"
  _pc_vm_write_manifest "$output"

  # A random build path in shipped bytes defeats deterministic rebuilds and can
  # leak a caller identity.  Fail before caching if any such path survived.
  leak="$(rg -a -l -F "$work" "$output" 2>/dev/null | head -1 || true)"
  if [[ -n "$leak" ]]; then
    echo "ERROR: vm-release trust output embeds its temporary build path: $leak" >&2
    return 1
  fi

  mv "$output" "$final_root"
  export PAPERCUSP_VM_RELEASE_TRUST_ROOT="$final_root"
  echo "  ✓ built pinned vm-release trust toolchain at $final_root"
  flock -u 7
  exec 7>&-
}
