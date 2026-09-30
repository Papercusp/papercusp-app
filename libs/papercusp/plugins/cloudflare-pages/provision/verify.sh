#!/usr/bin/env bash
# cloudflare-pages provision/verify.sh
#
# Confirms the configured Cloudflare account + Pages project are reachable
# with the user's token. No setup script is needed for cloudflare-pages —
# the project is created out-of-band via dash.cloudflare.com — so this
# plugin only ships verify, no setup/teardown.
set -euo pipefail
. "$PAPERCUSP_RUNTIME_LIB"

token=$(echo "$PAPERCUSP_CONFIG" | jq -r '.byoCloudflareToken // empty')
account=$(echo "$PAPERCUSP_CONFIG" | jq -r '.accountId // empty')
project=$(echo "$PAPERCUSP_CONFIG" | jq -r '.projectName // empty')

if [[ -z "$token" ]]; then
  papercusp_error "byoCloudflareToken missing"
  exit 2
fi
if [[ -z "$account" || -z "$project" ]]; then
  papercusp_error "accountId + projectName required"
  exit 3
fi

papercusp_progress "step:check" "verifying Cloudflare Pages project $project"

code=$(curl -sS -o /dev/null -w '%{http_code}' \
  -H "authorization: Bearer $token" \
  -H "accept: application/json" \
  "https://api.cloudflare.com/client/v4/accounts/$account/pages/projects/$project")

if [[ "$code" == "200" ]]; then
  papercusp_progress "step:done" "Cloudflare Pages project reachable"
  exit 0
fi
papercusp_error "Cloudflare Pages API returned HTTP $code"
exit 4
