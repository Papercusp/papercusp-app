#!/usr/bin/env bash
# remote-object-state.selftest.sh — recurrence guard for the stale-artifact bug
# in upload-release.sh's remote_state() (EI-23963309971611146).
#
# THE BUG THIS EXISTS TO CATCH. Above 8 MiB (`SMALL_ARTIFACT_BYTES`, the aws
# multipart threshold) an S3 ETag is "<md5-of-part-md5s>-<n>", which is not
# comparable to any local hash. remote_state() therefore fell back to SIZE for
# exactly the multi-GB artifacts that matter, and both call sites accepted that:
# the upload loop SKIPPED them and the verifier printed a green tick reading
# "✓ <name> (N GB, size only — multipart object)".
#
# A rebuilt artifact is routinely byte-different at an IDENTICAL size (same
# inputs, same compression settings), so on 0.0.21 the release host kept
# YESTERDAY's AppImage — 224,090,616 bytes both sides — while its few-hundred-byte
# .sig took the re-upload branch and was refreshed. The result was a fresh, valid
# signature over stale bytes: anyone doing the right thing (download the artifact,
# verify it against the published signature) sees a mismatch indistinguishable
# from tampering, and the upload script reported success throughout.
#
# The fix records the content hash as S3 user METADATA at upload time, which
# survives multipart chunking untouched, and adds a mtime rail for legacy objects
# that predate it.
#
#   bash bin/lib/remote-object-state.selftest.sh     # exit 0 = PASS, 1 = FAIL
#
# Hermetic: a mock `aws` on PATH backed by a fixture file, synthetic files in a
# temp dir. No network, no credentials, no real bucket. ~1s.
#
# Why a bash self-test and not Vitest: the unit under test is bash. This follows
# the sibling convention (release-artifacts.selftest.sh, federation-asserts.selftest.sh);
# the four canonical TS/Cargo/LLM frameworks don't host shell units and this
# submodule is not in the operator's hoisted vitest workspace.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Overridable so falsifiability can be proven against a MUTATED COPY outside the
# tree (scripts/mutation-probe.sh tier 2). Never mutate the real script in place:
# git-sync sweeps the whole working tree every few minutes and would commit the
# mutant even if nothing goes wrong and no handler fails.
UPLOAD_SH="${REMOTE_OBJECT_STATE_SUBJECT:-$DIR/../upload-release.sh}"

FAILED=0
pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n    expected: %s\n    actual:   %s\n' "$1" "$2" "$3" >&2; FAILED=1; }
check() { [[ "$2" == "$3" ]] && pass "$1" || fail "$1" "$2" "$3"; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ── Load the REAL implementation ─────────────────────────────────────────────
# upload-release.sh is an executable script with top-level side effects (env
# checks, credential loading), so it cannot simply be sourced. Extract the pure
# object-state block between two stable anchors and source THAT, so this test
# exercises the shipped code rather than a copy of it that can silently drift.
awk '/^s3api_head\(\) \{/,/^# ── What to upload/' "$UPLOAD_SH" > "$TMP/extracted.sh"

# POSITIVE CONTROL for the extraction itself. Without this, a refactor that moves
# or renames these functions would yield an empty extraction, every assertion
# below would run against nothing, and the suite would PASS VACUOUSLY — which is
# the failure mode that makes a guard worse than no guard.
# shellcheck source=/dev/null
ENDPOINT="https://mock.invalid" R2_BUCKET="mock-bucket" . "$TMP/extracted.sh" 2>/dev/null
for fn in s3api_head s3api_head_etag s3api_head_sha256 s3api_head_mtime_epoch local_sha256 remote_state; do
  if ! declare -F "$fn" >/dev/null; then
    echo "FAIL: extraction control — '$fn' was not defined by the block pulled from upload-release.sh." >&2
    echo "      The anchors in this test no longer match the script; fix the extraction rather than" >&2
    echo "      deleting this check, or every assertion below silently tests nothing." >&2
    exit 1
  fi
done
if [[ -z "${SMALL_ARTIFACT_BYTES:-}" ]]; then
  echo "FAIL: extraction control — SMALL_ARTIFACT_BYTES not set by the extracted block." >&2
  exit 1
fi

ENDPOINT="https://mock.invalid"
R2_BUCKET="mock-bucket"

# ── Mock aws ─────────────────────────────────────────────────────────────────
# Answers head-object --query {ContentLength,ETag,Metadata.sha256,LastModified}
# from $TMP/fixture: one "field=value" per line. An absent field exits non-zero,
# which is how the real CLI signals it, so the metadata-unavailable path is real.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/aws" <<'MOCK'
#!/usr/bin/env bash
q=""
while [[ $# -gt 0 ]]; do
  case "$1" in --query) q="$2"; shift 2 ;; *) shift ;; esac
done
key=""
case "$q" in
  ContentLength)    key=size ;;
  ETag)             key=etag ;;
  Metadata.sha256)  key=sha256 ;;
  LastModified)     key=lastmodified ;;
  *) exit 1 ;;
esac
line="$(grep "^${key}=" "$FIXTURE" 2>/dev/null | head -1)"
[[ -n "$line" ]] || exit 1
printf '%s\n' "${line#*=}"
MOCK
chmod +x "$TMP/bin/aws"
export PATH="$TMP/bin:$PATH"
export FIXTURE="$TMP/fixture"

BIG=$((SMALL_ARTIFACT_BYTES + 4096))
ART="$TMP/Papercusp_GUI_0.0.22_amd64.AppImage"
head -c "$BIG" /dev/urandom > "$ART"
ART_SHA="$(sha256sum "$ART" | cut -d' ' -f1)"
ART_SIZE="$(stat -c%s "$ART")"
MULTIPART_ETAG="d41d8cd98f00b204e9800998ecf8427e-7"

echo "remote-object-state self-test"

# 1. absent
printf 'x=1\n' > "$FIXTURE"
check "absent when nothing is published" "absent" "$(remote_state some/key "$ART")"

# 2. size differs -> proven different
printf 'size=%s\n' "$((ART_SIZE - 1))" > "$FIXTURE"
check "differs when the published size differs" "differs" "$(remote_state some/key "$ART")"

# 3. recorded sha256 MATCHES -> identical, even though the ETag is multipart
{ printf 'size=%s\n' "$ART_SIZE"; printf 'etag=%s\n' "$MULTIPART_ETAG"; printf 'sha256=%s\n' "$ART_SHA"; } > "$FIXTURE"
check "identical when the recorded sha256 matches (multipart ETag ignored)" \
  "identical" "$(remote_state some/key "$ART")"

# 4. ★ THE REGRESSION CASE ★ — same size, multipart ETag, recorded sha256 DIFFERS.
#    This is precisely the 0.0.21 AppImage: identical byte count, different bytes.
#    Before the fix this returned size-only-match and the artifact was SKIPPED.
{ printf 'size=%s\n' "$ART_SIZE"; printf 'etag=%s\n' "$MULTIPART_ETAG"
  printf 'sha256=%s\n' "0000000000000000000000000000000000000000000000000000000000000000"; } > "$FIXTURE"
check "differs when a large same-size object's recorded sha256 mismatches (the stale-artifact bug)" \
  "differs" "$(remote_state some/key "$ART")"

# 5. legacy object, no recorded sha256, LOCAL IS NEWER -> local-newer (re-upload)
touch -d '2020-01-01 00:00:00 UTC' "$TMP/oldref"
{ printf 'size=%s\n' "$ART_SIZE"; printf 'etag=%s\n' "$MULTIPART_ETAG"
  printf 'lastmodified=%s\n' "2020-01-01T00:00:00+00:00"; } > "$FIXTURE"
check "local-newer when a legacy same-size object predates the local file" \
  "local-newer" "$(remote_state some/key "$ART")"

# 6. legacy object, no recorded sha256, remote is NEWER -> size-only-match
{ printf 'size=%s\n' "$ART_SIZE"; printf 'etag=%s\n' "$MULTIPART_ETAG"
  printf 'lastmodified=%s\n' "2099-01-01T00:00:00+00:00"; } > "$FIXTURE"
check "size-only-match when a legacy same-size object is newer than the local file" \
  "size-only-match" "$(remote_state some/key "$ART")"

# 7. a real MD5 ETag still settles identity outright (small-file path preserved)
SMALL="$TMP/small.sig"
printf 'signature-bytes' > "$SMALL"
{ printf 'size=%s\n' "$(stat -c%s "$SMALL")"; printf 'etag=%s\n' "$(md5sum "$SMALL" | cut -d' ' -f1)"; } > "$FIXTURE"
check "identical when a real MD5 ETag matches" "identical" "$(remote_state some/key "$SMALL")"

# 8. ETag unreadable -> metadata-unavailable, NEVER a silent pass
printf 'size=%s\n' "$ART_SIZE" > "$FIXTURE"
check "metadata-unavailable when the ETag cannot be read" \
  "metadata-unavailable" "$(remote_state some/key "$ART")"

# 9. the VERIFIER must not print a green tick for an unverifiable large object.
#    "I could not check" and "I checked and it was fine" must not share a symbol.
if grep -qE '✓.*size only' "$UPLOAD_SH"; then
  fail "verifier emits no ✓ for a size-only (unverifiable) artifact" \
       "no '✓ ... size only' in upload-release.sh" "found one"
else
  pass "verifier emits no ✓ for a size-only (unverifiable) artifact"
fi

# 10. uploads must record the content hash, or every future comparison degrades
#     back to the size guess this whole fix removes.
if grep -q -- '--metadata "sha256=' "$UPLOAD_SH"; then
  pass "uploads record sha256 as object metadata"
else
  fail "uploads record sha256 as object metadata" "--metadata \"sha256=...\" present" "absent"
fi

if [[ "$FAILED" == "0" ]]; then
  echo "remote-object-state self-test: ALL PASS"
  exit 0
fi
echo "remote-object-state self-test: FAILURES" >&2
exit 1
