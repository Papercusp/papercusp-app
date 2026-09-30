#!/usr/bin/env bash
# github-repo provision/teardown.sh
#
# Receives the recorded resources via state.json on stdin / via
# $PAPERCUSP_PLUGIN_STATE and dispatches by kind. V1 only handles
# `github.repo` (the only kind setup.sh records).
#
# Per spec: teardown.sh is the dispatcher — substrate does NOT interpret
# resource kinds.
set -euo pipefail
. "$PAPERCUSP_RUNTIME_LIB"

token=$(echo "$PAPERCUSP_CONFIG" | jq -r '.github_token // empty')
state="${PAPERCUSP_PLUGIN_STATE:-$(cat)}"

if [[ -z "$token" ]]; then
  papercusp_error "github_token missing — cannot tear down"
  exit 2
fi

# Iterate createdResources from state.json.
echo "$state" | jq -c '.createdResources[]' | while IFS= read -r row; do
  kind=$(echo "$row" | jq -r '.kind')
  id=$(echo "$row" | jq -r '.externalId')
  case "$kind" in
    github.repo)
      papercusp_progress "step:delete" "deleting $id"
      code=$(curl -sS -o /dev/null -w '%{http_code}' \
        -X DELETE \
        -H "authorization: Bearer $token" \
        -H "accept: application/vnd.github+json" \
        "https://api.github.com/repos/$id")
      if [[ "$code" != "204" && "$code" != "404" ]]; then
        papercusp_warn "delete returned HTTP $code for $id (continuing)"
      fi
      ;;
    *)
      papercusp_warn "unknown kind '$kind' for id '$id'; skipping"
      ;;
  esac
done
