#!/usr/bin/env bash
# github-repo provision/verify.sh
#
# Confirms the recorded repo still exists and the token still has access.
# Exits 0 on healthy, non-zero with a `papercusp_error` marker otherwise.
set -euo pipefail
. "$PAPERCUSP_RUNTIME_LIB"

token=$(echo "$PAPERCUSP_CONFIG" | jq -r '.github_token // empty')
state="${PAPERCUSP_PLUGIN_STATE:-$(cat 2>/dev/null || echo '{}')}"

if [[ -z "$token" ]]; then
  papercusp_error "github_token missing"
  exit 2
fi

repos=$(echo "$state" | jq -r '.createdResources[]? | select(.kind=="github.repo") | .externalId')
if [[ -z "$repos" ]]; then
  papercusp_warn "no github.repo recorded — nothing to verify"
  exit 0
fi

while IFS= read -r repo; do
  [[ -z "$repo" ]] && continue
  code=$(curl -sS -o /dev/null -w '%{http_code}' \
    -H "authorization: Bearer $token" \
    -H "accept: application/vnd.github+json" \
    "https://api.github.com/repos/$repo")
  if [[ "$code" != "200" ]]; then
    papercusp_error "verify failed for $repo (HTTP $code)"
    exit 3
  fi
  papercusp_progress "step:verified" "$repo OK"
done <<< "$repos"
