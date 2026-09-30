#!/usr/bin/env bash
# cloudflare-stack provision/teardown.sh
#
# Receives recorded resources via $PAPERCUSP_PLUGIN_STATE and dispatches
# per `kind`. Per spec: teardown.sh is the dispatcher — substrate does
# NOT interpret resource kinds.
#
# Resources are torn down in reverse-creation order (LIFO). 404s are
# treated as already-gone and don't fail the teardown.

set -euo pipefail
. "$PAPERCUSP_RUNTIME_LIB"

token=$(echo "$PAPERCUSP_CONFIG" | jq -r '.byoCloudflareToken // empty')
account=$(echo "$PAPERCUSP_CONFIG" | jq -r '.accountId // empty')
state="${PAPERCUSP_PLUGIN_STATE:-$(cat)}"

if [[ -z "$token" ]]; then
  papercusp_error "byoCloudflareToken missing — cannot tear down"
  exit 2
fi
if [[ -z "$account" ]]; then
  papercusp_error "accountId missing"
  exit 3
fi

CF_API="https://api.cloudflare.com/client/v4"

cf_delete() {
  local path="$1"
  curl -sS -o /dev/null -w '%{http_code}' \
    -X DELETE \
    -H "authorization: Bearer $token" \
    "$CF_API$path"
}

# Walk in REVERSE so worker (depends on bindings) goes first, KV/R2/D1/Pages last.
mapfile -t resources < <(echo "$state" | jq -c '.createdResources[]?')
for ((i=${#resources[@]}-1; i>=0; i--)); do
  row="${resources[$i]}"
  kind=$(echo "$row" | jq -r '.kind')
  id=$(echo "$row" | jq -r '.externalId')

  case "$kind" in
    cloudflare.worker)
      papercusp_progress "step:delete-worker" "deleting Worker $id"
      code=$(cf_delete "/accounts/$account/workers/scripts/$id")
      if [[ "$code" != "200" && "$code" != "204" && "$code" != "404" ]]; then
        papercusp_warn "Worker delete returned HTTP $code for $id (continuing)"
      fi
      ;;
    cloudflare.pages.project)
      papercusp_progress "step:delete-pages" "deleting Pages project $id"
      code=$(cf_delete "/accounts/$account/pages/projects/$id")
      if [[ "$code" != "200" && "$code" != "204" && "$code" != "404" ]]; then
        papercusp_warn "Pages delete returned HTTP $code for $id (continuing)"
      fi
      ;;
    cloudflare.kv.namespace)
      papercusp_progress "step:delete-kv" "deleting KV namespace $id"
      code=$(cf_delete "/accounts/$account/storage/kv/namespaces/$id")
      if [[ "$code" != "200" && "$code" != "204" && "$code" != "404" ]]; then
        papercusp_warn "KV delete returned HTTP $code for $id (continuing)"
      fi
      ;;
    cloudflare.r2.bucket)
      papercusp_progress "step:delete-r2" "deleting R2 bucket $id (must be empty)"
      # R2 buckets must be empty before deletion. We surface a useful warning
      # rather than auto-emptying — accidental data loss is a worse failure
      # than a stuck teardown.
      code=$(cf_delete "/accounts/$account/r2/buckets/$id")
      if [[ "$code" == "409" ]]; then
        papercusp_warn "R2 bucket $id is non-empty; leaving in place. Run 'wrangler r2 object delete' or empty via dashboard, then retry teardown."
      elif [[ "$code" != "200" && "$code" != "204" && "$code" != "404" ]]; then
        papercusp_warn "R2 delete returned HTTP $code for $id (continuing)"
      fi
      ;;
    cloudflare.d1.database)
      papercusp_progress "step:delete-d1" "deleting D1 database $id"
      code=$(cf_delete "/accounts/$account/d1/database/$id")
      if [[ "$code" != "200" && "$code" != "204" && "$code" != "404" ]]; then
        papercusp_warn "D1 delete returned HTTP $code for $id (continuing)"
      fi
      ;;
    *)
      papercusp_warn "unknown kind '$kind' for id '$id'; skipping"
      ;;
  esac
done

papercusp_progress "step:done" "teardown complete"
