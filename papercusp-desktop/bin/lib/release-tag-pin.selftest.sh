#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=release-tag-pin.sh
source "$HERE/release-tag-pin.sh"

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf -- "$TMP_ROOT"' EXIT
REMOTE="$TMP_ROOT/origin.git"
CANONICAL_REMOTE="$TMP_ROOT/github.git"
CANONICAL_REMOTE_URL="file://$CANONICAL_REMOTE"
WORK="$TMP_ROOT/work"
TAG="desktop-v9.9.9"

git init --bare -q "$REMOTE"
git init --bare -q "$CANONICAL_REMOTE"
git init -q "$WORK"
git -C "$WORK" config user.name release-tag-pin-selftest
git -C "$WORK" config user.email release-tag-pin-selftest@example.invalid
git -C "$WORK" remote add origin "$REMOTE"

printf 'canonical\n' > "$WORK/source.txt"
git -C "$WORK" add source.txt
git -C "$WORK" commit -qm canonical
CANONICAL="$(git -C "$WORK" rev-parse HEAD)"
git -C "$WORK" tag "$TAG" "$CANONICAL"
git -C "$WORK" push -q origin "refs/tags/$TAG"
git -C "$WORK" push -q "$CANONICAL_REMOTE_URL" "refs/tags/$TAG"

printf 'wrong\n' >> "$WORK/source.txt"
git -C "$WORK" commit -qam wrong
WRONG="$(git -C "$WORK" rev-parse HEAD)"
git -C "$WORK" tag -f "$TAG" "$WRONG" >/dev/null
git -C "$WORK" push -q --force origin "refs/tags/$TAG"

release_tag_repair_exact "$WORK" "$TAG" "$CANONICAL"
[[ "$(git -C "$WORK" rev-parse "refs/tags/$TAG")" == "$CANONICAL" ]]
[[ "$(release_tag_remote_sha "$WORK" "$TAG")" == "$CANONICAL" ]]

# A normal LOCAL-only cut may align its local ref, but MUST NOT write origin.
git -C "$WORK" tag -f "$TAG" "$WRONG" >/dev/null
release_tag_prepare_local_exact "$WORK" "$TAG" "$CANONICAL"
[[ "$(git -C "$WORK" rev-parse "refs/tags/$TAG")" == "$CANONICAL" ]]
[[ "$(release_tag_remote_sha "$WORK" "$TAG")" == "$CANONICAL" ]]

# A wrong remote tag is a hard refusal. The normal cut does not repair it.
git -C "$WORK" tag -f "$TAG" "$WRONG" >/dev/null
git -C "$WORK" push -q --force origin "refs/tags/$TAG"
git -C "$WORK" tag -f "$TAG" "$CANONICAL" >/dev/null
git -C "$WORK" tag -f "$TAG" "$WRONG" >/dev/null
EXPLICIT_REMOTE_OUTPUT="$(release_tag_prepare_local_exact "$WORK" "$TAG" "$CANONICAL" "$CANONICAL_REMOTE_URL")"
[[ "$EXPLICIT_REMOTE_OUTPUT" == *"local+$CANONICAL_REMOTE_URL refs/tags/$TAG"* ]]
[[ "$(git -C "$WORK" rev-parse "refs/tags/$TAG")" == "$CANONICAL" ]]
if release_tag_prepare_local_exact "$WORK" "$TAG" "$CANONICAL" >/dev/null 2>&1; then
  echo "FAIL: normal local-only pin accepted a wrong remote tag" >&2
  exit 1
fi
[[ "$(release_tag_remote_sha "$WORK" "$TAG")" == "$WRONG" ]]
[[ "$(git -C "$WORK" rev-parse "refs/tags/$TAG")" == "$CANONICAL" ]]

if release_tag_repair_exact "$WORK" "$TAG" deadbeef >/dev/null 2>&1; then
  echo "FAIL: short SHA was accepted" >&2
  exit 1
fi

# A new release gets an explicit create-only path. The empty force-with-lease
# expectation must make concurrent pre-existence a refusal, never an overwrite.
CREATE_TAG="desktop-v9.9.10-alpha"
release_tag_create_exact "$WORK" "$CREATE_TAG" "$CANONICAL"
[[ "$(git -C "$WORK" rev-parse "refs/tags/$CREATE_TAG")" == "$CANONICAL" ]]
[[ "$(release_tag_remote_sha "$WORK" "$CREATE_TAG")" == "$CANONICAL" ]]

# Exact re-entry is idempotent and re-aligns a stale local ref.
git -C "$WORK" tag -f "$CREATE_TAG" "$WRONG" >/dev/null
release_tag_create_exact "$WORK" "$CREATE_TAG" "$CANONICAL"
[[ "$(git -C "$WORK" rev-parse "refs/tags/$CREATE_TAG")" == "$CANONICAL" ]]
[[ "$(release_tag_remote_sha "$WORK" "$CREATE_TAG")" == "$CANONICAL" ]]

# A mismatched remote ref is not silently repaired by the create operation.
git -C "$WORK" tag -f "$CREATE_TAG" "$WRONG" >/dev/null
git -C "$WORK" push -q --force origin "refs/tags/$CREATE_TAG"
if release_tag_create_exact "$WORK" "$CREATE_TAG" "$CANONICAL" >/dev/null 2>&1; then
  echo "FAIL: create overwrote an existing mismatched release tag" >&2
  exit 1
fi
[[ "$(release_tag_remote_sha "$WORK" "$CREATE_TAG")" == "$WRONG" ]]

echo "release-tag-pin selftest: PASS (repair + create-only lease guards)"
