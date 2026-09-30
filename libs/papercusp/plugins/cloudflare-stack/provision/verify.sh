#!/usr/bin/env bash
# cloudflare-stack provision/verify.sh
#
# Health-checks each resource recorded in state.json. Exit codes:
#   0 — all resources reachable
#   1 — degraded (some missing) — substrate may show "needs re-provision"
#   2 — broken (token/account unusable)

set -euo pipefail
. "$PAPERCUSP_RUNTIME_LIB"

token=$(echo "$PAPERCUSP_CONFIG" | jq -r '.byoCloudflareToken // empty')
account=$(echo "$PAPERCUSP_CONFIG" | jq -r '.accountId // empty')
state="${PAPERCUSP_PLUGIN_STATE:-$(cat 2>/dev/null || echo '{}')}"

if [[ -z "$token" || -z "$account" ]]; then
  papercusp_error "credentials missing"
  exit 2
fi

CF_API="https://api.cloudflare.com/client/v4"

probe() {
  curl -sS -o /dev/null -w '%{http_code}' \
    -H "authorization: Bearer $token" \
    "$CF_API$1"
}

# Token + account preflight
acct=$(probe "/accounts/$account")
case "$acct" in
  200) ;;
  401|403) papercusp_error "token rejected"; exit 2 ;;
  *) papercusp_error "account preflight HTTP $acct"; exit 2 ;;
esac

degraded=0
mapfile -t resources < <(echo "$state" | jq -c '.createdResources[]?' 2>/dev/null || true)
if [[ ${#resources[@]} -eq 0 ]]; then
  papercusp_progress "step:nothing" "no recorded resources to verify"
  exit 0
fi

for row in "${resources[@]}"; do
  kind=$(echo "$row" | jq -r '.kind')
  id=$(echo "$row" | jq -r '.externalId')
  case "$kind" in
    cloudflare.worker)        path="/accounts/$account/workers/scripts/$id" ;;
    cloudflare.pages.project) path="/accounts/$account/pages/projects/$id" ;;
    cloudflare.kv.namespace)  path="/accounts/$account/storage/kv/namespaces/$id" ;;
    cloudflare.r2.bucket)     path="/accounts/$account/r2/buckets/$id" ;;
    cloudflare.d1.database)   path="/accounts/$account/d1/database/$id" ;;
    *) papercusp_warn "unknown kind '$kind'; skipping verify"; continue ;;
  esac
  code=$(probe "$path")
  if [[ "$code" == "200" ]]; then
    papercusp_progress "step:ok" "$kind $id reachable"
  elif [[ "$code" == "404" ]]; then
    papercusp_warn "$kind $id missing (HTTP 404) — drift detected"
    degraded=1
  else
    papercusp_warn "$kind $id probe returned HTTP $code"
    degraded=1
  fi
done

if [[ "$degraded" -eq 1 ]]; then
  papercusp_progress "step:degraded" "some resources missing or unreachable"
  exit 1
fi
papercusp_progress "step:done" "all resources healthy"
