#!/usr/bin/env bash
# release-content-identity.selftest.sh — guards the release journal's INPUT.
#
# release-content-identity.js produces the object release-task-journal.mts hashes
# into a stage's inputHash. A receipt is reusable exactly while that hash still
# matches, so every property below is an invalidation rule in disguise:
#
#   1. a platform is REQUIRED and must be known        (no receipt keyed to nothing)
#   2. two platforms never share an identity           (the bug that made only the
#                                                       Linux leg journallable)
#   3. the same inputs always produce the same bytes   (or nothing would ever reuse)
#   4. the toolchain is captured                       (rustc/cargo/node/npm)
#   5. a policy-file change invalidates                (the gate rules changed)
#   6. the BUILDER's own digest is in the policy set   (the rules' definition changed)
#   7. a missing policy file fails CLOSED, by name     (never a silent partial identity)
#
#   bash bin/lib/release-content-identity.selftest.sh   # exit 0 = PASS, 1 = FAIL
#
# Hermetic: a synthetic workspace/desktop fixture under mktemp, no network, no
# real release inputs. It does shell out to rustc/cargo/node/npm for the real
# toolchain strings (that is what the builder captures), and SKIPs if absent.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# Overridable so a falsifiability probe can point this at a MUTATED COPY outside
# the tree, instead of mutating the shared checkout (where git-sync would commit
# the mutant mid-probe). scripts/mutation-probe.sh --file <builder> --test
# 'PAPERCUSP_CONTENT_IDENTITY_BUILDER={} bash …/release-content-identity.selftest.sh'
BUILDER="${PAPERCUSP_CONTENT_IDENTITY_BUILDER:-$HERE/release-content-identity.js}"

command -v node >/dev/null 2>&1 || { echo "SKIP: node unavailable"; exit 0; }
for tool in rustc cargo npm; do
  command -v "$tool" >/dev/null 2>&1 || { echo "SKIP: $tool unavailable (the builder captures it)"; exit 0; }
done
[[ -f "$BUILDER" ]] || { echo "✗ builder missing: $BUILDER"; exit 1; }

FAILS=0
bad() { echo "  ✗ $*"; FAILS=$((FAILS + 1)); }
good() { echo "  ✓ $*"; }

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf -- "$TMP_ROOT"' EXIT
W="$TMP_ROOT/workspace"
D="$W/papercusp-desktop"

# A synthetic tree carrying exactly the inputs the builder binds.
mkdir -p "$W/node_modules" "$W/content-bundles/workspace-host" "$D/src-tauri" "$D/bin/lib"
SRC_HEX="$(printf 'papercusp-selftest-source' | sha256sum | cut -d' ' -f1)"
printf 'identity=v1-%s\nsource=%s\n' "$SRC_HEX" "$SRC_HEX" \
  > "$W/node_modules/.papercusp-dependency-generation"
printf '{"lockfileVersion":3}\n' > "$W/package-lock.json"
# Deliberately NO node_modules/.package-lock.json: a release tree materialized
# from a dependency generation never has one (dependency-generation.sh prunes
# it), so the CONTROL below proves the builder accepts that real shape.
printf 'bundle: workspace-host\n' > "$W/content-bundles/workspace-host/bundle.yaml"
printf '{"contract":"v1"}\n' > "$D/src-tauri/distribution-contract.json"
printf '{"productName":"papercusp"}\n' > "$D/src-tauri/tauri.conf.json"
printf '# Cargo.lock\nversion = 4\n' > "$D/src-tauri/Cargo.lock"
printf '#!/usr/bin/env bash\n# models\n' > "$D/bin/lib/transformers-models.sh"
printf '#!/usr/bin/env python3\n# scanner\n' > "$D/bin/audit-release-bundle.py"
printf '#!/usr/bin/env bash\n# provenance\n' > "$D/bin/verify-provenance.sh"
printf '// freshness\n' > "$D/bin/check-sidecar-freshness.js"
# P-003 clause 4 (D-008): the compression producers are policy inputs, because
# their PRESETS are hardcoded (`zstd --long=27`, `xz -9`) and only a fingerprint
# of the producer can notice those change.
printf '#!/usr/bin/env bash\n# source packager: zstd --long=27\n' > "$D/bin/stage-source-tree.sh"
printf '#!/usr/bin/env bash\n# deb compressor: xz -9\n' > "$D/bin/repack-deb-xz.sh"

identity() { # <platform> — prints the identity JSON, or nothing on failure
  node "$BUILDER" "$W" "$D" "$@" 2>/dev/null
}
field() { # <json> <node-expression over `i`>
  node -e 'const i=JSON.parse(process.argv[1]);process.stdout.write(String(eval(process.argv[2])))' "$1" "$2" 2>/dev/null
}

# 0-CONTROL: the fixture must actually BUILD. Every assertion below compares
# identities, and two empty strings compare equal — so without this control a
# broken fixture would make checks 2/3/5 all "pass" while measuring nothing.
LINUX="$(identity linux-x86_64)"
if [[ -z "$LINUX" ]]; then
  echo "  ✗ CONTROL: the fixture produced no identity at all — every comparison below would be vacuous"
  node "$BUILDER" "$W" "$D" linux-x86_64 2>&1 | head -3
  echo "release-content-identity self-test: 1 FAILED"
  exit 1
fi
good "CONTROL: fixture builds a linux-x86_64 identity ($(printf '%s' "$LINUX" | wc -c) bytes)"

# 1) a platform is REQUIRED, and must be one the repo actually ships.
node "$BUILDER" "$W" "$D" >/dev/null 2>&1 \
  && bad "an ABSENT platform was accepted — that receipt would be keyed to nothing" \
  || good "absent platform refused"
node "$BUILDER" "$W" "$D" solaris-sparc >/dev/null 2>&1 \
  && bad "an UNKNOWN platform was accepted" \
  || good "unknown platform refused"

# 2) two platforms must never share an identity. This is the regression that
#    kept receipts Linux-only: the builder used to hardcode platform.
ARM="$(identity linux-aarch64)"
WIN="$(identity windows-x86_64)"
if [[ -z "$ARM" || -z "$WIN" ]]; then
  bad "CONTROL: a non-Linux platform produced no identity — check 2 measured nothing"
elif [[ "$LINUX" == "$ARM" || "$LINUX" == "$WIN" || "$ARM" == "$WIN" ]]; then
  bad "two platforms produced the SAME identity — their receipts would collide"
else
  good "linux-x86_64 / linux-aarch64 / windows-x86_64 identities are all distinct"
fi

# 3) determinism — unchanged inputs must reuse, so the bytes must be stable.
AGAIN="$(identity linux-x86_64)"
[[ "$LINUX" == "$AGAIN" ]] \
  && good "identical inputs produce identical bytes (reuse is reachable)" \
  || bad "the identity is UNSTABLE across two calls — nothing would ever reuse"

# 4) the toolchain is captured, non-empty, per field.
for f in rustc cargo node npm; do
  v="$(field "$LINUX" "i.toolchain.$f")"
  [[ -n "$v" && "$v" != "undefined" ]] \
    && good "toolchain.$f captured ($v)" \
    || bad "toolchain.$f is missing — a toolchain change would not invalidate a receipt"
done

# 5) a policy-file change must invalidate. Same platform, one gate rewritten.
printf '{"contract":"v1","changed":true}\n' > "$D/src-tauri/distribution-contract.json"
CHANGED="$(identity linux-x86_64)"
if [[ -z "$CHANGED" ]]; then
  bad "CONTROL: the identity failed to build after a policy edit — check 5 measured nothing"
elif [[ "$CHANGED" == "$LINUX" ]]; then
  bad "a policy-file change did NOT change the identity — stale receipts would survive a rule change"
else
  good "a policy-file change invalidates the identity"
fi
printf '{"contract":"v1"}\n' > "$D/src-tauri/distribution-contract.json"

# 6) the builder's OWN digest is in the policy set. Without it, changing what an
#    identity MEANS leaves every receipt minted under the old meaning reusable.
BUILDER_SHA="$(sha256sum "$BUILDER" | cut -d' ' -f1)"
RECORDED="$(field "$LINUX" 'i.policy.files.identityBuilder')"
[[ "$RECORDED" == "$BUILDER_SHA" ]] \
  && good "policy.files.identityBuilder is the builder's real sha256" \
  || bad "policy.files.identityBuilder is '$RECORDED', expected $BUILDER_SHA"

# 7) a missing policy input fails CLOSED and NAMES what is missing — a partial
#    identity would hash cleanly and silently widen what counts as reusable.
mv "$D/bin/verify-provenance.sh" "$D/bin/verify-provenance.sh.hidden"
ERR="$(node "$BUILDER" "$W" "$D" linux-x86_64 2>&1 >/dev/null)"
RC=$?
mv "$D/bin/verify-provenance.sh.hidden" "$D/bin/verify-provenance.sh"
if [[ "$RC" -eq 0 ]]; then
  bad "a MISSING policy file still produced an identity — the gate set is not actually bound"
elif [[ "$ERR" != *provenanceVerifier* ]]; then
  bad "the failure did not name the missing input (got: $ERR)"
else
  good "a missing policy file fails closed and names provenanceVerifier"
fi

# 8) the schema version must be the one the journal's receipts were minted under.
SCHEMA="$(field "$LINUX" 'i.schemaVersion')"
[[ "$SCHEMA" == "5" ]] \
  && good "schemaVersion is 5" \
  || bad "schemaVersion is '$SCHEMA', expected 5 — bump it deliberately when the shape changes"

# 8b) npm's install bookkeeping must never key reuse. It is pruned at the
#     generation boundary, so requiring it failed every journalled managed cut,
#     and hashing it would split identical installs on npm's own rewrites.
printf '{"lockfileVersion":3,"installed":true}\n' > "$W/node_modules/.package-lock.json"
BOOKKEPT="$(identity linux-x86_64)"
rm -f -- "$W/node_modules/.package-lock.json"
if [[ -z "$BOOKKEPT" ]]; then
  bad "CONTROL: the identity failed to build with node_modules/.package-lock.json present — check 8b measured nothing"
elif [[ "$BOOKKEPT" != "$LINUX" ]]; then
  bad "node_modules/.package-lock.json changed the identity — npm bookkeeping is keying reuse"
else
  good "node_modules/.package-lock.json is neither required nor hashed"
fi

# ── P-003 clause 4 (D-008): compression policy is part of the reuse key ───────
# R-3 requires package/compression outputs to be keyed by content AND policy.
# The policy arrives in two forms and each needs its own mechanism, so each is
# checked separately — one passing does not imply the other.

# 9) the env-TUNABLE half. Tuning a knob changes the produced BYTES while every
#    other input stays identical, so if this does not move the identity, a
#    package compressed under one policy satisfies a request for another.
for knob in PAPERCUSP_REUSE_SOURCE_ZSTD_LEVEL:19 \
            PAPERCUSP_REUSE_DEB_XZ_THREADS:8 \
            PAPERCUSP_REUSE_DEB_XZ_MEMLIMIT:8GiB; do
  var="${knob%%:*}"; val="${knob#*:}"
  TUNED="$(env "$var=$val" node "$BUILDER" "$W" "$D" linux-x86_64 2>/dev/null)"
  if [[ -z "$TUNED" ]]; then
    bad "CONTROL: the identity failed to build with $var=$val — this check measured nothing"
  elif [[ "$TUNED" == "$LINUX" ]]; then
    bad "$var did NOT change the identity — differently-compressed bytes would be reused"
  else
    good "$var=$val invalidates the identity"
  fi
done

# 10) the HARDCODED half. The presets live in the producers' own text, so only a
#     fingerprint of those files can catch an edit to them.
printf '#!/usr/bin/env bash\n# deb compressor: xz -6\n' > "$D/bin/repack-deb-xz.sh"
PRESET="$(identity linux-x86_64)"
if [[ -z "$PRESET" ]]; then
  bad "CONTROL: the identity failed to build after a compressor edit — check 10 measured nothing"
elif [[ "$PRESET" == "$LINUX" ]]; then
  bad "editing the deb compressor did NOT change the identity — a preset change would survive in stale receipts"
else
  good "a compression-producer edit invalidates the identity"
fi
printf '#!/usr/bin/env bash\n# deb compressor: xz -9\n' > "$D/bin/repack-deb-xz.sh"

# 11) the recorded defaults must be the ones that would actually RUN. A default
#     that drifts from its producer records a policy no build ever used, which is
#     worse than recording none — it reads as evidence while being fiction.
#     These mirror repack-deb-xz.sh:23-24 and stage-source-tree.sh:385.
for pair in compression.sourceZstdLevel:6 compression.debXzThreads:4 compression.debXzMemoryLimit:4GiB; do
  node_path="${pair%:*}"; want="${pair##*:}"
  got="$(field "$LINUX" "i.$node_path")"
  [[ "$got" == "$want" ]] \
    && good "$node_path defaults to $want (mirrors its producer)" \
    || bad "$node_path is '$got', expected '$want' — the recorded policy is not the one that runs"
done

# 12) DRIFT PIN. Check 11 asserts LITERALS; on its own "mirrors its producer" is
#     a COMMENT, not a fact. This proves those literals are what the producers
#     actually default to AND that release-local.sh relays the same ones — so a
#     producer retuned to `xz -T8` fails here instead of leaving every receipt
#     quietly claiming 4. (Derived-truth ladder: the duplicate is unavoidable
#     across three languages, so it is PINNED rather than hand-maintained.)
#     An empty extraction is a BROKEN INSTRUMENT, never a pass — it would compare
#     "" against "" on both sides and report agreement.
producer_default() { # <file> <VAR> — prints VAR's ${VAR:-default} value
  awk -v v="$2" 'match($0, v ":-[^}\"]*") {
    print substr($0, RSTART + length(v) + 2, RLENGTH - length(v) - 2); exit
  }' "$1" 2>/dev/null
}
for spec in "stage-source-tree.sh:PAPERCUSP_SOURCE_ZSTD_LEVEL:6" \
            "repack-deb-xz.sh:PAPERCUSP_XZ_THREADS:4" \
            "repack-deb-xz.sh:PAPERCUSP_XZ_MEMORY_LIMIT:4GiB"; do
  file="${spec%%:*}"; rest="${spec#*:}"; var="${rest%%:*}"; want="${rest##*:}"
  got="$(producer_default "$HERE/../$file" "$var")"
  relay="$(producer_default "$HERE/../release-local.sh" "$var")"
  if [[ -z "$got" ]]; then
    bad "PIN CONTROL: could not read $var's default out of $file — this check measured nothing"
  elif [[ -z "$relay" ]]; then
    bad "PIN CONTROL: release-local.sh does not relay $var at all — the identity cannot see this policy"
  elif [[ "$got" != "$want" ]]; then
    bad "$file defaults $var to '$got' but the identity records '$want' — the recorded policy is fiction"
  elif [[ "$relay" != "$want" ]]; then
    bad "release-local.sh relays $var as '$relay', not the producer's '$want'"
  else
    good "$var default '$want' agrees across $file, release-local.sh and the identity"
  fi
done

echo
if [[ "$FAILS" -eq 0 ]]; then
  echo "release-content-identity self-test: ALL PASS"
  exit 0
else
  echo "release-content-identity self-test: $FAILS FAILED"
  exit 1
fi
