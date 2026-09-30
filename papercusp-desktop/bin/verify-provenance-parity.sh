#!/usr/bin/env bash
# P-016 (desktop-build-hardening-tri-platform-2026-07-11): parity REGRESSION GATE
# for build provenance. Locks the invariants the plan's Phase 1 established so a
# future edit to ANY leg cannot silently re-fork provenance emission or the
# centralized sha derivation:
#
#   • ONE emitter, ONE schema (P-001/P-002): linux, mac AND windows all emit via
#     bin/emit-build-provenance.sh — none re-inlines its own printf emitter.
#   • ONE honest sha (P-003): release-local.sh derives BUILD_SHA with the -dirty
#     marker in a single place; no leg bakes a bare rev-parse of its own.
#
# CI-style: prints its checks and exits 0 (pass) / 1 (fail). Fast + hermetic
# (runs the emitter against throwaway fixtures; no build, no VM). Wired as a
# fail-fast at the top of release-local.sh AND runnable standalone.
#
# NOTE on the byte-repro acceptance from D-006 ("a second cut from the same
# gitHead reproduces the same packedSrcFingerprint"): that needs a pinned
# toolchain to be truly deterministic and is tracked under P-014 (reproducible-
# build hygiene). This gate delivers the schema + no-re-fork half now.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
EMITTER="$HERE/emit-build-provenance.sh"
RELEASE_LOCAL="$HERE/release-local.sh"
WIN_BUILD="$HERE/build-windows-cross.sh"
ROOT="$(cd "$HERE/.." && pwd)"

fail() { echo "PROVENANCE-PARITY FAIL: $*" >&2; exit 1; }
pass() { echo "  ✓ $*"; }

[[ -f "$EMITTER" ]]       || fail "shared emitter missing at $EMITTER"
[[ -f "$RELEASE_LOCAL" ]] || fail "release-local.sh missing at $RELEASE_LOCAL"
[[ -f "$WIN_BUILD" ]]     || fail "build-windows-cross.sh missing at $WIN_BUILD"

# ── Check 1: schema conformance in BOTH modes ──────────────────────────────
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/lin/deb" "$TMP/win"
# WI-4243 fixtures: a subdir artifact WITH a .sig (names must come out relative
# to OUT_DIR, sig recorded true) + a windows payload slice with NO .sig.
printf 'fixture\n' > "$TMP/lin/deb/App_0.0.0_amd64.deb"
printf 'sigbytes\n' > "$TMP/lin/deb/App_0.0.0_amd64.deb.sig"
printf 'fixture\n' > "$TMP/win/App_0.0.0_x64-setup.exe"
printf 'fixture\n' > "$TMP/win/App_0.0.0_x64-setup-1.bin"

PROVENANCE_GIT_ROOT="$ROOT" \
  bash "$EMITTER" "$TMP/lin" 0.0.0 testsha false "$TMP/lin"/deb/*.deb >/dev/null \
  || fail "emitter (mac/linux mode) exited non-zero"
PROVENANCE_GIT_ROOT="$ROOT" PROVENANCE_PACKED_SRC_FINGERPRINT=testfp PROVENANCE_SIGNED=false \
  bash "$EMITTER" "$TMP/win" 0.0.0 testsha false "$TMP/win"/*-setup.exe "$TMP/win"/*-setup-*.bin >/dev/null \
  || fail "emitter (windows mode) exited non-zero"

python3 - "$TMP/lin/build-provenance.json" "$TMP/win/build-provenance.json" <<'PY' || fail "schema conformance check failed (see above)"
import json, sys
lin = json.load(open(sys.argv[1])); win = json.load(open(sys.argv[2]))
BASE = {"version":str,"buildSha":str,"reused":bool,"gitHead":str,"gitDirty":bool,"dirtySource":dict,"builtAtUtc":str,"artifacts":list}
def check(name, d, extra_expected):
    for k,t in BASE.items():
        if k not in d: raise SystemExit(f"  {name}: missing shared-schema key {k!r}")
        if not isinstance(d[k], t): raise SystemExit(f"  {name}: key {k!r} has wrong type ({type(d[k]).__name__})")
    for a in d["artifacts"]:
        if not (isinstance(a.get("sha256"), str) and len(a["sha256"]) == 64):
            raise SystemExit(f"  {name}: artifact sha256 malformed")
        if not isinstance(a.get("bytes"), int):
            raise SystemExit(f"  {name}: artifact bytes not an int")
        if not isinstance(a.get("name"), str):
            raise SystemExit(f"  {name}: artifact name not a string")
        if not isinstance(a.get("sig"), bool):
            raise SystemExit(f"  {name}: artifact sig not a bool (WI-4243 per-artifact sig recording)")
        if not isinstance(a.get("mtimeEpochSec"), int) or not isinstance(a.get("mtimeUtc"), str) or not isinstance(a.get("completedAtUtc"), str):
            raise SystemExit(f"  {name}: artifact lacks its own mtime provenance")
    dirty = d["dirtySource"]
    if dirty.get("schemaVersion") != 1 or not isinstance(dirty.get("repositories"), list):
        raise SystemExit(f"  {name}: malformed content-addressed dirtySource manifest")
    for repo in dirty["repositories"]:
        if not isinstance(repo, dict) or not isinstance(repo.get("label"), str) or not isinstance(repo.get("files"), list):
            raise SystemExit(f"  {name}: malformed dirtySource repository row")
        for row in repo["files"]:
            if not isinstance(row, dict) or not isinstance(row.get("status"), str) or not isinstance(row.get("path"), str):
                raise SystemExit(f"  {name}: malformed dirtySource file row")
            if row.get("sha256") is not None and (not isinstance(row["sha256"], str) or len(row["sha256"]) != 64):
                raise SystemExit(f"  {name}: malformed dirtySource file hash")
    got_extra = {k for k in ("packedSrcFingerprint","signed") if k in d}
    if got_extra != extra_expected:
        raise SystemExit(f"  {name}: leg-specific fields {got_extra} != expected {extra_expected}")
check("mac/linux", lin, set())
check("windows", win, {"packedSrcFingerprint","signed"})
# EI-20086238555902880: `sidecar` is ALWAYS emitted (null when the leg named none), so a
# MISSING key means "a pre-EI-20086238555902880 emitter wrote this" and not "nothing was
# packed". Neither fixture sets PROVENANCE_SIDECAR_DIR, so both must be present-and-null:
# that is the case that would silently regress if the field were emitted only when set.
for _n, _d in (("mac/linux", lin), ("windows", win)):
    if "sidecar" not in _d:
        raise SystemExit(f"  {_n}: missing `sidecar` key — the packed-sidecar record must "
                         "always be emitted, so present-vs-missing stays meaningful")
    if _d["sidecar"] is not None:
        raise SystemExit(f"  {_n}: `sidecar` must be null when no PROVENANCE_SIDECAR_DIR "
                         f"was given, got {_d['sidecar']!r} — a fabricated record is worse "
                         "than an absent one (LABELED != PACKED)")
print("  ✓ EI-20086238555902880: `sidecar` always emitted; null when no sidecar dir named")
# WI-4243 invariants: subdir artifacts keep their OUT_DIR-relative subpath name
# (no more symlink stages for verify), sig reflects the co-located .sig, and
# the windows *-setup-*.bin payload slices are enumerated.
lin_by_name = {a["name"]: a for a in lin["artifacts"]}
if "deb/App_0.0.0_amd64.deb" not in lin_by_name:
    raise SystemExit(f"  mac/linux: subdir artifact name not OUT_DIR-relative (got {sorted(lin_by_name)})")
if lin_by_name["deb/App_0.0.0_amd64.deb"]["sig"] is not True:
    raise SystemExit("  mac/linux: co-located .sig not recorded as sig:true")
win_names = {a["name"] for a in win["artifacts"]}
if "App_0.0.0_x64-setup-1.bin" not in win_names:
    raise SystemExit(f"  windows: *-setup-*.bin slice not enumerated (got {sorted(win_names)})")
if next(a for a in win["artifacts"] if a["name"].endswith(".bin"))["sig"] is not False:
    raise SystemExit("  windows: sig-less .bin not recorded as sig:false")
print("  ✓ schema: base keys+types OK; windows adds exactly packedSrcFingerprint+signed; mac/linux adds none")
print("  ✓ WI-4243: subpath names, per-artifact sig recording, .bin slices enumerated")
PY

VERIFY_WIN="$TMP/win-require-signed.out"
if bash "$HERE/verify-provenance.sh" "$TMP/win" --require-signed --allow-dirty >"$VERIFY_WIN" 2>&1; then
  fail "--require-signed accepted an unsigned published Windows installer"
fi
grep -Fq "artifact 'App_0.0.0_x64-setup.exe' has no .sig and --require-signed was set" "$VERIFY_WIN" \
  || fail "--require-signed stopped requiring signatures for published Windows installers"
if grep -Fq "artifact 'App_0.0.0_x64-setup-1.bin' has no .sig and --require-signed was set" "$VERIFY_WIN"; then
  fail "--require-signed incorrectly required a signature on a DiskSpanning .bin slice"
fi

BIN_ONLY="$TMP/win-bin-only"
mkdir -p "$BIN_ONLY"
printf 'fixture\n' > "$BIN_ONLY/App_0.0.0_x64-setup-1.bin"
PROVENANCE_GIT_ROOT="$ROOT" PROVENANCE_PACKED_SRC_FINGERPRINT=testfp PROVENANCE_SIGNED=false \
  bash "$EMITTER" "$BIN_ONLY" 0.0.0 testsha false "$BIN_ONLY/App_0.0.0_x64-setup-1.bin" >/dev/null \
  || fail "emitter (windows .bin-only mode) exited non-zero"
bash "$HERE/verify-provenance.sh" "$BIN_ONLY" --require-signed --allow-dirty >"$TMP/win-bin-only.verify.out" 2>&1 \
  || fail "--require-signed rejected a Windows DiskSpanning .bin-only fixture"
grep -Fq "outside the D-019 published signable set" "$TMP/win-bin-only.verify.out" \
  || fail "--require-signed did not disclose why the .bin signature is not required"
pass "--require-signed follows the D-019 signable suffix set and excludes Windows .bin slices"

# ── Check 2: no leg re-forks the shared emitter ────────────────────────────
grep -q 'bin/emit-build-provenance.sh' "$RELEASE_LOCAL" \
  || fail "release-local.sh no longer calls bin/emit-build-provenance.sh (linux/mac leg re-forked?)"
grep -q 'emit-build-provenance.sh' "$WIN_BUILD" \
  || fail "build-windows-cross.sh no longer calls emit-build-provenance.sh (windows leg re-inlined its emitter?)"
pass "all three legs invoke bin/emit-build-provenance.sh"

# The old inline windows emitter was the ONLY place a raw packedSrcFingerprint
# JSON line was printf'd; its reappearance means a leg re-inlined an emitter.
if grep -Eq "printf[^\n]*packedSrcFingerprint" "$WIN_BUILD"; then
  fail "build-windows-cross.sh re-inlined a packedSrcFingerprint printf emitter — P-002 consolidation reverted"
fi
if grep -Eq 'printf[^\n]*"sha256"' "$RELEASE_LOCAL" "$WIN_BUILD"; then
  fail "a release leg re-inlined an artifact-sha256 printf emitter — provenance must delegate to emit-build-provenance.sh"
fi
pass "no leg re-inlines a provenance emitter"

# ── Check 3: centralized honest sha (P-003 single source of truth) ─────────
grep -q -- '-dirty"' "$RELEASE_LOCAL" \
  || fail "release-local.sh no longer carries the honest -dirty BUILD_SHA marker (P-003 single-source-of-truth reverted to a bare rev-parse?)"
pass "centralized honest BUILD_SHA (-dirty) derivation present (P-003)"

# ── Check 4: baked release host RECORDED, as a fingerprint, never the URL ──
# WI-37746 (closes the WI-37738 stranding class). upload-release.sh's DECISIVE
# host guard reads `releaseHostSha256`; if the emitter ever stops recording it,
# that guard silently degrades back to the strings heuristic whose blind spot —
# an artifact baked to a DIFFERENT HOST matches nothing and is skipped — ships a
# warning instead of blocking. Measured on fixtures 2026-08-11: same-host/wrong-
# prefix BLOCKS, wholly-different-host WARNS AND SHIPS. This check keeps the
# non-heuristic evidence source alive.
#
# It locks the no-leak half too: the host URL's path segment is the unguessable
# secret that keeps the bucket unlisted (D-002/D-003), and build-provenance.json
# ships NEXT TO the artifacts — so the URL must only ever be fingerprinted.
HOSTFIX="$TMP/hostfp"; mkdir -p "$HOSTFIX"
printf 'fixture\n' > "$HOSTFIX/App_0.0.0_amd64.deb"
FAKE_HOST='https://pub-parityfixture.r2.dev/NOTAREALSECRETPREFIX'
PROVENANCE_GIT_ROOT="$ROOT" PAPERCUSP_RELEASE_HOST="$FAKE_HOST" \
  bash "$EMITTER" "$HOSTFIX" 0.0.0 testsha false "$HOSTFIX"/*.deb >/dev/null \
  || fail "emitter exited non-zero with PAPERCUSP_RELEASE_HOST set"

EXPECT_FP="$(printf '%s' "$FAKE_HOST" | sha256sum | cut -d' ' -f1)"
python3 - "$HOSTFIX/build-provenance.json" "$EXPECT_FP" "$FAKE_HOST" <<'PY' || fail "release-host fingerprint check failed (see above)"
import json, sys
path, expect, host = sys.argv[1], sys.argv[2], sys.argv[3]
raw = open(path).read()
d = json.loads(raw)
if "releaseHostSha256" not in d:
    raise SystemExit("  emitter no longer records releaseHostSha256 — upload-release.sh's decisive host guard (WI-37746) has nothing to read and degrades to the strings heuristic that ships a warning on a different baked host")
if d["releaseHostSha256"] != expect:
    raise SystemExit(f"  releaseHostSha256 is not sha256(PAPERCUSP_RELEASE_HOST): got {d['releaseHostSha256']!r}")
secret = host.rsplit("/", 1)[-1]
if host in raw or secret in raw:
    raise SystemExit("  the release host URL (or its secret path segment) LEAKED into build-provenance.json — it must only ever be fingerprinted, because this file ships next to the artifacts")
print("  ✓ releaseHostSha256 == sha256(baked host); raw URL + secret path segment absent from the file")
PY

# The null encoding is load-bearing, so it is asserted rather than assumed: with
# NO host baked the key must be PRESENT-and-null. A MISSING key means "emitted by
# a pre-WI-37746 build", which upload-release.sh reports differently from
# "nothing was baked" — collapsing the two re-hides the gap this closed.
NOHOST="$TMP/nohost"; mkdir -p "$NOHOST"
printf 'fixture\n' > "$NOHOST/App_0.0.0_amd64.deb"
PROVENANCE_GIT_ROOT="$ROOT" PAPERCUSP_RELEASE_HOST= \
  bash "$EMITTER" "$NOHOST" 0.0.0 testsha false "$NOHOST"/*.deb >/dev/null \
  || fail "emitter exited non-zero with PAPERCUSP_RELEASE_HOST empty"
python3 - "$NOHOST/build-provenance.json" <<'PY' || fail "null-host encoding check failed (see above)"
import json, sys
d = json.load(open(sys.argv[1]))
if "releaseHostSha256" not in d:
    raise SystemExit("  releaseHostSha256 must be PRESENT-and-null when no host is baked, not omitted (upload-release.sh distinguishes missing from null)")
if d["releaseHostSha256"] is not None:
    raise SystemExit(f"  expected null with no baked host, got {d['releaseHostSha256']!r}")
print("  ✓ no baked host encodes as present-and-null (distinct from a missing key)")
PY
pass "baked release host recorded as a fingerprint, never the URL (WI-37746)"

echo "PROVENANCE-PARITY OK — one emitter, one schema, no leg re-forked."
