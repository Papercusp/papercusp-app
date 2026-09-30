#!/usr/bin/env bash
# github-repo provision/setup.sh
#
# Creates the GitHub repo (idempotent: skips if it already exists) and
# records the resource so teardown can drop it. Runs at fork-completion
# / first-install. The substrate's runner sandboxes this script and
# captures its stdout into the audit log.
#
# Inputs:
#   $PAPERCUSP_CONFIG    JSON-encoded plugin config (github_token, owner, repo, ...)
#   $PAPERCUSP_RUNTIME_LIB  path to lib.sh
#   $PAPERCUSP_HARNESS_SLUG  the harness slug (default repo name fallback)
set -euo pipefail
. "$PAPERCUSP_RUNTIME_LIB"

token=$(echo "$PAPERCUSP_CONFIG" | jq -r '.github_token // empty')
owner=$(echo "$PAPERCUSP_CONFIG" | jq -r '.owner // empty')
repo=$(echo "$PAPERCUSP_CONFIG" | jq -r '.repo // empty')
visibility=$(echo "$PAPERCUSP_CONFIG" | jq -r '.visibility // "private"')
desc=$(echo "$PAPERCUSP_CONFIG" | jq -r '.description // ""')

if [[ -z "$token" ]]; then
  papercusp_error "github_token missing — connect via OAuth or paste a PAT"
  exit 2
fi
if [[ -z "$repo" ]]; then
  repo="$PAPERCUSP_HARNESS_SLUG"
fi

papercusp_progress "step:check" "checking if $owner/$repo already exists"

# Resolve owner: if blank, use authenticated user.
if [[ -z "$owner" ]]; then
  owner=$(curl -sS -H "authorization: Bearer $token" -H "accept: application/vnd.github+json" \
    https://api.github.com/user | jq -r '.login // empty')
  if [[ -z "$owner" ]]; then
    papercusp_error "could not resolve authenticated user from token"
    exit 3
  fi
fi

# Idempotency: if repo exists already, just record + exit.
existing=$(curl -sS -o /dev/null -w '%{http_code}' \
  -H "authorization: Bearer $token" \
  -H "accept: application/vnd.github+json" \
  "https://api.github.com/repos/$owner/$repo")
if [[ "$existing" == "200" ]]; then
  papercusp_progress "step:exists" "$owner/$repo already exists; skipping create"
  papercusp_record_resource "github.repo" "$owner/$repo"
  exit 0
fi

papercusp_progress "step:create" "creating $owner/$repo (visibility=$visibility)"

# POST /user/repos for personal, /orgs/<org>/repos for organizations.
# We pick personal-create unconditionally since GitHub forwards correctly
# when the authenticated user is the owner; org creation goes through a
# different endpoint that needs the user-input distinction.
body=$(jq -n \
  --arg name "$repo" \
  --arg desc "$desc" \
  --arg vis "$visibility" \
  '{name:$name, description:$desc, private:($vis=="private")}')

resp=$(curl -sS -w '\n%{http_code}' \
  -H "authorization: Bearer $token" \
  -H "accept: application/vnd.github+json" \
  -X POST -d "$body" \
  https://api.github.com/user/repos)
http=$(echo "$resp" | tail -n1)
json=$(echo "$resp" | sed '$d')
if [[ "$http" != "201" ]]; then
  papercusp_error "github API rejected create: HTTP $http"
  echo "$json" | head -c 1024
  exit 4
fi

papercusp_record_resource "github.repo" "$owner/$repo"
papercusp_state_set "fullName" "\"$owner/$repo\""
papercusp_progress "step:done" "$owner/$repo created"
