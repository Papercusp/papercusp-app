#!/usr/bin/env bash
# cloudflare-stack provision/setup.sh
#
# Provisions a full Cloudflare backend in the forker's account:
#   1. D1 database
#   2. R2 bucket
#   3. KV namespace
#   4. Pages project
#   5. Worker script (with bindings to D1/R2/KV)
#
# Each step is idempotent (check-by-name → exists ? skip+record : create+record).
# After resources are created, walks $PAPERCUSP_PROJECT_DIR for *.tmpl files
# and renders them via envsubst with USER_VAR_* + OUTPUT_* + PAPERCUSP_*.
#
# Inputs (env):
#   PAPERCUSP_CONFIG          JSON-encoded plugin config
#   PAPERCUSP_RUNTIME_LIB     path to lib.sh
#   PAPERCUSP_HARNESS_SLUG    used as default name suffix
#   PAPERCUSP_PROJECT_DIR     forked harness's project dir (for template rendering)
#   USER_VAR_*                flattened scalars from PAPERCUSP_CONFIG (Day-1 substrate)
#
# Outputs (via papercusp_state_set, exposed to other phases as $OUTPUT_*):
#   pagesProjectName, pagesUrl
#   workerName, workerUrl
#   d1DatabaseId, d1DatabaseName
#   r2BucketName
#   kvNamespaceId, kvNamespaceTitle
#
# Resources recorded for teardown:
#   cloudflare.pages.project, cloudflare.worker, cloudflare.d1.database,
#   cloudflare.r2.bucket, cloudflare.kv.namespace

set -euo pipefail
. "$PAPERCUSP_RUNTIME_LIB"

# ── Read config ──────────────────────────────────────────────────────────────

token=$(echo "$PAPERCUSP_CONFIG" | jq -r '.byoCloudflareToken // empty')
account=$(echo "$PAPERCUSP_CONFIG" | jq -r '.accountId // empty')
project_name=$(echo "$PAPERCUSP_CONFIG" | jq -r '.projectName // empty')
worker_name=$(echo "$PAPERCUSP_CONFIG" | jq -r '.workerName // empty')
d1_name=$(echo "$PAPERCUSP_CONFIG" | jq -r '.d1DatabaseName // empty')
r2_bucket=$(echo "$PAPERCUSP_CONFIG" | jq -r '.r2BucketName // empty')
kv_title=$(echo "$PAPERCUSP_CONFIG" | jq -r '.kvNamespaceTitle // empty')
skip=$(echo "$PAPERCUSP_CONFIG" | jq -r '.skipResources // [] | join(",")')

# Defaults derived from the harness slug
slug="${PAPERCUSP_HARNESS_SLUG:-harness}"
: "${project_name:=$slug}"
: "${worker_name:=${slug}-api}"
: "${d1_name:=${slug}-db}"
: "${r2_bucket:=${slug}-assets}"
: "${kv_title:=${slug}-sessions}"

if [[ -z "$token" ]]; then
  papercusp_error "byoCloudflareToken missing — paste a token at fork time"
  exit 2
fi
if [[ -z "$account" ]]; then
  papercusp_error "accountId missing"
  exit 3
fi

skipped() { [[ ",$skip," == *",$1,"* ]]; }

# ── CF API helper ────────────────────────────────────────────────────────────

CF_API="https://api.cloudflare.com/client/v4"

cf() {
  # cf <method> <path> [body]  — returns the full JSON response on stdout,
  # the HTTP status on fd 4. Caller parses both.
  local method="$1" path="$2" body="${3:-}"
  local out
  if [[ -n "$body" ]]; then
    out=$(curl -sS -w '\n%{http_code}' \
      -X "$method" \
      -H "authorization: Bearer $token" \
      -H "content-type: application/json" \
      -H "accept: application/json" \
      -d "$body" \
      "$CF_API$path")
  else
    out=$(curl -sS -w '\n%{http_code}' \
      -X "$method" \
      -H "authorization: Bearer $token" \
      -H "accept: application/json" \
      "$CF_API$path")
  fi
  local http
  http=$(echo "$out" | tail -n1)
  echo "$out" | sed '$d'
  echo "$http" >&4
}

# Wrap cf so callers can write `body=$(cf_call GET /path)` and get HTTP via $LAST_HTTP.
cf_call() {
  exec 4>/tmp/.cf_http_$$
  cf "$@" 4>&-
  LAST_HTTP=$(cat /tmp/.cf_http_$$ 2>/dev/null || echo 000)
  rm -f /tmp/.cf_http_$$
}

# Use a simpler shape: capture http via subshell
cf_status_only() {
  curl -sS -o /dev/null -w '%{http_code}' \
    -X "$1" \
    -H "authorization: Bearer $token" \
    -H "accept: application/json" \
    "$CF_API$2"
}

# ── Pre-flight: verify token + account ───────────────────────────────────────

papercusp_progress "step:preflight" "verifying token + account"
verify_status=$(cf_status_only GET "/accounts/$account")
case "$verify_status" in
  200) ;;
  401|403) papercusp_error "token rejected by Cloudflare ($verify_status) — check scopes"; exit 4 ;;
  404)     papercusp_error "account $account not found (404) — check account ID"; exit 5 ;;
  *)       papercusp_error "preflight failed: HTTP $verify_status"; exit 6 ;;
esac

# ── 1. D1 database ───────────────────────────────────────────────────────────

if skipped d1; then
  papercusp_progress "step:d1-skip" "d1 in skipResources; skipping"
  d1_id=""
else
  papercusp_progress "step:d1" "ensuring D1 database $d1_name"
  # List + match by name (idempotency)
  d1_list=$(curl -sS -H "authorization: Bearer $token" \
    "$CF_API/accounts/$account/d1/database?name=$d1_name&per_page=50")
  d1_id=$(echo "$d1_list" | jq -r --arg n "$d1_name" '.result[]? | select(.name==$n) | .uuid' | head -n1)
  if [[ -n "$d1_id" ]]; then
    papercusp_progress "step:d1-exists" "D1 $d1_name exists ($d1_id)"
  else
    body=$(jq -nc --arg n "$d1_name" '{name:$n}')
    create=$(curl -sS \
      -X POST \
      -H "authorization: Bearer $token" \
      -H "content-type: application/json" \
      -d "$body" \
      "$CF_API/accounts/$account/d1/database")
    d1_id=$(echo "$create" | jq -r '.result.uuid // empty')
    if [[ -z "$d1_id" ]]; then
      papercusp_error "D1 create failed: $(echo "$create" | jq -c '.errors // .')"
      exit 10
    fi
    papercusp_progress "step:d1-created" "D1 $d1_name created ($d1_id)"
  fi
  papercusp_record_resource "cloudflare.d1.database" "$d1_id" "$(jq -nc --arg n "$d1_name" --arg a "$account" '{name:$n,accountId:$a}')"
  papercusp_state_set "d1DatabaseId" "\"$d1_id\""
  papercusp_state_set "d1DatabaseName" "\"$d1_name\""
fi

# ── 2. R2 bucket ─────────────────────────────────────────────────────────────

if skipped r2; then
  papercusp_progress "step:r2-skip" "r2 in skipResources; skipping"
else
  papercusp_progress "step:r2" "ensuring R2 bucket $r2_bucket"
  r2_status=$(cf_status_only GET "/accounts/$account/r2/buckets/$r2_bucket")
  if [[ "$r2_status" == "200" ]]; then
    papercusp_progress "step:r2-exists" "R2 bucket $r2_bucket exists"
  elif [[ "$r2_status" == "404" ]]; then
    body=$(jq -nc --arg n "$r2_bucket" '{name:$n}')
    create=$(curl -sS \
      -X POST \
      -H "authorization: Bearer $token" \
      -H "content-type: application/json" \
      -d "$body" \
      "$CF_API/accounts/$account/r2/buckets")
    if ! echo "$create" | jq -e '.success == true' >/dev/null; then
      papercusp_error "R2 create failed: $(echo "$create" | jq -c '.errors // .')"
      exit 11
    fi
    papercusp_progress "step:r2-created" "R2 bucket $r2_bucket created"
  else
    papercusp_error "R2 probe failed: HTTP $r2_status"
    exit 12
  fi
  papercusp_record_resource "cloudflare.r2.bucket" "$r2_bucket" "$(jq -nc --arg a "$account" '{accountId:$a}')"
  papercusp_state_set "r2BucketName" "\"$r2_bucket\""
fi

# ── 3. KV namespace ──────────────────────────────────────────────────────────

if skipped kv; then
  papercusp_progress "step:kv-skip" "kv in skipResources; skipping"
  kv_id=""
else
  papercusp_progress "step:kv" "ensuring KV namespace $kv_title"
  kv_list=$(curl -sS -H "authorization: Bearer $token" \
    "$CF_API/accounts/$account/storage/kv/namespaces?per_page=100")
  kv_id=$(echo "$kv_list" | jq -r --arg t "$kv_title" '.result[]? | select(.title==$t) | .id' | head -n1)
  if [[ -n "$kv_id" ]]; then
    papercusp_progress "step:kv-exists" "KV $kv_title exists ($kv_id)"
  else
    body=$(jq -nc --arg t "$kv_title" '{title:$t}')
    create=$(curl -sS \
      -X POST \
      -H "authorization: Bearer $token" \
      -H "content-type: application/json" \
      -d "$body" \
      "$CF_API/accounts/$account/storage/kv/namespaces")
    kv_id=$(echo "$create" | jq -r '.result.id // empty')
    if [[ -z "$kv_id" ]]; then
      papercusp_error "KV create failed: $(echo "$create" | jq -c '.errors // .')"
      exit 13
    fi
    papercusp_progress "step:kv-created" "KV $kv_title created ($kv_id)"
  fi
  papercusp_record_resource "cloudflare.kv.namespace" "$kv_id" "$(jq -nc --arg t "$kv_title" --arg a "$account" '{title:$t,accountId:$a}')"
  papercusp_state_set "kvNamespaceId" "\"$kv_id\""
  papercusp_state_set "kvNamespaceTitle" "\"$kv_title\""
fi

# ── 4. Pages project ─────────────────────────────────────────────────────────

if skipped pages; then
  papercusp_progress "step:pages-skip" "pages in skipResources; skipping"
else
  papercusp_progress "step:pages" "ensuring Pages project $project_name"
  pg_status=$(cf_status_only GET "/accounts/$account/pages/projects/$project_name")
  if [[ "$pg_status" == "200" ]]; then
    papercusp_progress "step:pages-exists" "Pages project $project_name exists"
  elif [[ "$pg_status" == "404" ]]; then
    body=$(jq -nc --arg n "$project_name" '{name:$n, production_branch:"main"}')
    create=$(curl -sS \
      -X POST \
      -H "authorization: Bearer $token" \
      -H "content-type: application/json" \
      -d "$body" \
      "$CF_API/accounts/$account/pages/projects")
    if ! echo "$create" | jq -e '.success == true' >/dev/null; then
      papercusp_error "Pages create failed: $(echo "$create" | jq -c '.errors // .')"
      exit 14
    fi
    papercusp_progress "step:pages-created" "Pages project $project_name created"
  else
    papercusp_error "Pages probe failed: HTTP $pg_status"
    exit 15
  fi
  papercusp_record_resource "cloudflare.pages.project" "$project_name" "$(jq -nc --arg a "$account" '{accountId:$a}')"
  papercusp_state_set "pagesProjectName" "\"$project_name\""
  papercusp_state_set "pagesUrl" "\"https://${project_name}.pages.dev\""
fi

# ── 5. Worker script ─────────────────────────────────────────────────────────
# Worker creation is intentionally a stub here (an empty `addEventListener`
# script). The harness's actual deploy step (e.g. `wrangler deploy`) replaces
# the stub with real code. We create an empty Worker now only to reserve the
# *.workers.dev subdomain and record the resource for teardown.

if skipped worker; then
  papercusp_progress "step:worker-skip" "worker in skipResources; skipping"
else
  papercusp_progress "step:worker" "ensuring Worker $worker_name"
  wk_status=$(cf_status_only GET "/accounts/$account/workers/scripts/$worker_name")
  if [[ "$wk_status" == "200" ]]; then
    papercusp_progress "step:worker-exists" "Worker $worker_name exists"
  elif [[ "$wk_status" == "404" ]]; then
    # Minimal placeholder script. Multipart upload required by Workers API.
    stub='addEventListener("fetch",e=>e.respondWith(new Response("provisioned by papercusp; deploy your code via wrangler.",{status:200})));'
    metadata='{"main_module":"worker.js","compatibility_date":"2026-04-01"}'
    upload=$(curl -sS \
      -X PUT \
      -H "authorization: Bearer $token" \
      -F "metadata=${metadata};type=application/json" \
      -F "worker.js=$stub;type=application/javascript+module" \
      "$CF_API/accounts/$account/workers/scripts/$worker_name")
    if ! echo "$upload" | jq -e '.success == true' >/dev/null; then
      papercusp_error "Worker create failed: $(echo "$upload" | jq -c '.errors // .')"
      exit 16
    fi
    # Enable workers.dev subdomain so the URL is reachable.
    curl -sS -X POST \
      -H "authorization: Bearer $token" \
      -H "content-type: application/json" \
      -d '{"enabled":true}' \
      "$CF_API/accounts/$account/workers/scripts/$worker_name/subdomain" >/dev/null || true
    papercusp_progress "step:worker-created" "Worker $worker_name created"
  else
    papercusp_error "Worker probe failed: HTTP $wk_status"
    exit 17
  fi

  # Resolve the workers.dev subdomain prefix for this account
  sub_resp=$(curl -sS -H "authorization: Bearer $token" "$CF_API/accounts/$account/workers/subdomain")
  subdomain=$(echo "$sub_resp" | jq -r '.result.subdomain // empty')

  papercusp_record_resource "cloudflare.worker" "$worker_name" "$(jq -nc --arg a "$account" '{accountId:$a}')"
  papercusp_state_set "workerName" "\"$worker_name\""
  if [[ -n "$subdomain" ]]; then
    papercusp_state_set "workerUrl" "\"https://${worker_name}.${subdomain}.workers.dev\""
  else
    papercusp_state_set "workerUrl" "\"https://${worker_name}.workers.dev\""
  fi
fi

# ── 6. Render project-file templates ────────────────────────────────────────
# Substrate populates USER_VAR_* from the config; we export OUTPUT_*
# locally so envsubst sees the resource IDs we just produced. Then the
# substrate's `papercusp_render_templates` walks $PAPERCUSP_PROJECT_DIR.

export OUTPUT_d1DatabaseId="${d1_id:-}"
export OUTPUT_d1DatabaseName="${d1_name:-}"
export OUTPUT_r2BucketName="${r2_bucket:-}"
export OUTPUT_kvNamespaceId="${kv_id:-}"
export OUTPUT_kvNamespaceTitle="${kv_title:-}"
export OUTPUT_pagesProjectName="${project_name:-}"
export OUTPUT_pagesUrl="https://${project_name}.pages.dev"
export OUTPUT_workerName="${worker_name:-}"
export OUTPUT_workerUrl="https://${worker_name}.${subdomain:-${worker_name}}.workers.dev"

papercusp_render_templates

papercusp_progress "step:done" "Cloudflare backend provisioned"
