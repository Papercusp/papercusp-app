#!/usr/bin/env bash
# End-to-end smoke test for the Papercusp framework.
#
# Verifies:
#   1. All four services up (web :3001, papercusp :3055, marketplace :3057, papercup :3061)
#   2. Marketplace catalog is queryable
#   3. CLI doctor passes (excluding the "Anthropic API key" check, which is user-supplied)
#   4. Round-trip publish → install → init from a synthetic harness
#   5. Auth flow: login (gets dev magic URL) → verify → status returns user → logout
#   6. Plugin loader contract tests
#   7. apps/web vitest suite (the framework's regression net)

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
PAPERCUSP="$ROOT/node_modules/.bin/papercusp"

PASS=0
FAIL=0

ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; PASS=$((PASS+1)); }
fail() { printf "  \033[31m✗\033[0m %s\n" "$1"; FAIL=$((FAIL+1)); }
section() { printf "\n\033[1m%s\033[0m\n" "$1"; }

section "1. Services"
for port_label in '3001:web' '3055:papercusp' '3057:marketplace' '3061:papercup'; do
  port="${port_label%:*}"; label="${port_label#*:}"
  # Probe via TCP connect rather than ss -p (which needs CAP_NET_ADMIN to see pids).
  if (timeout 1 bash -c "</dev/tcp/localhost/$port") 2>/dev/null; then
    ok "$label on :$port"
  else
    fail "$label on :$port (not listening)"
  fi
done

section "2. Endpoints"
declare -A endpoints=(
  ["http://localhost:3055/"]="200"
  ["http://localhost:3055/marketplace"]="200"
  ["http://localhost:3055/login"]="200"
  ["http://localhost:3055/settings/api-keys"]="200"
  ["http://localhost:3055/settings/profile"]="200"
  ["http://localhost:3055/api/auth/status"]="200"
  ["http://localhost:3055/api/marketplace/catalog"]="200"
  ["http://localhost:3055/api/installed"]="200"
  ["http://localhost:3057/healthz"]="200"
  ["http://localhost:3057/catalog"]="200"
)
for url in "${!endpoints[@]}"; do
  expected="${endpoints[$url]}"
  actual=$(curl -s -o /dev/null -w "%{http_code}" "$url" 2>/dev/null || echo "000")
  if [[ "$actual" == "$expected" ]]; then
    ok "$url → $actual"
  else
    fail "$url → $actual (expected $expected)"
  fi
done

section "3. CLI doctor"
if [[ ! -x "$PAPERCUSP" ]]; then
  fail "papercusp CLI not found at $PAPERCUSP (run npm install)"
else
  doctor_out=$($PAPERCUSP doctor 2>&1 || true)
  for check in 'node' 'postgres @' 'marketplace' 'substrate'; do
    if echo "$doctor_out" | grep -q "✓.*$check"; then
      ok "doctor: $check"
    else
      fail "doctor: $check"
    fi
  done
  # Agent CLI: at least one of {claude, omp} must be installed. omp is the
  # default backend post-2026-05-06; production images may ship omp without
  # claude (or vice versa), so accept either.
  if echo "$doctor_out" | grep -qE "✓.*(claude|omp) CLI"; then
    ok "doctor: agent CLI (claude or omp)"
  else
    fail "doctor: agent CLI (need at least one of claude/omp on PATH)"
  fi
fi

section "4. Marketplace round-trip"
# The marketplace switches into 'oauth' AUTH_MODE when OAuth env is set.
# In that mode, anonymous publish returns 401. The smoketest can't fake
# OAuth, so we skip when no service token is configured. CI seed scripts
# and devs with explicit setup can still exercise this by exporting
# PAPERCUSP_SERVICE_TOKEN before running the smoketest.
SKIP_PUBLISH=0
if [[ -z "${PAPERCUSP_SERVICE_TOKEN:-}" ]]; then
  # Probe whether anonymous publish is allowed.
  PROBE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST -F manifest='{}' \
    "http://localhost:3057/publish/probe/0.0.0" 2>/dev/null || echo 000)
  if [[ "$PROBE" == "401" ]]; then
    SKIP_PUBLISH=1
  fi
fi

if [[ "$SKIP_PUBLISH" == "1" ]]; then
  printf "  \033[33m–\033[0m publish skipped: marketplace requires auth (set PAPERCUSP_SERVICE_TOKEN)\n"
  printf "  \033[33m–\033[0m install skipped: depends on publish\n"
  printf "  \033[33m–\033[0m tarball-extract skipped: depends on install\n"
  printf "  \033[33m–\033[0m init-from-template skipped: depends on install\n"
else
  TMPSTAGE=$(mktemp -d /tmp/papercusp-smoke-XXXXXX)
  cd "$TMPSTAGE"
  SLUG="smoketest-$$"
  cat > papercusp.json <<EOF
{"name":"$SLUG","version":"0.0.1","papercusp":"^0.1.0","description":"Smoke test."}
EOF
  echo "# $SLUG" > README.md
  echo "fake content" > content.txt
  if $PAPERCUSP publish > /tmp/papercusp-smoke-publish.log 2>&1; then
    ok "publish succeeded"
  else
    fail "publish failed: $(tail -2 /tmp/papercusp-smoke-publish.log)"
  fi

  cd "$ROOT"
  if $PAPERCUSP install "$SLUG" > /tmp/papercusp-smoke-install.log 2>&1; then
    ok "install succeeded"
  else
    fail "install failed: $(tail -2 /tmp/papercusp-smoke-install.log)"
  fi

  if [[ -f ~/.papercusp/harnesses/$SLUG/papercusp.json ]]; then
    ok "tarball extracted to ~/.papercusp/harnesses/$SLUG/"
  else
    fail "tarball not extracted"
  fi

  PROJECT_SLUG="smokeproj-$$"
  if $PAPERCUSP init "$PROJECT_SLUG" --from "$SLUG" > /tmp/papercusp-smoke-init.log 2>&1; then
    ok "init from template succeeded"
  else
    fail "init failed: $(tail -2 /tmp/papercusp-smoke-init.log)"
  fi

  # Cleanup test artifacts
  rm -rf "$TMPSTAGE" ~/.papercusp/harnesses/$SLUG ~/.papercusp/projects/$PROJECT_SLUG
  curl -s -X DELETE "http://localhost:3057/catalog/$SLUG/0.0.1" > /dev/null
fi
# Remove project from registry (no-op if SKIP_PUBLISH=1, since SLUG is unset)
PROJECT_SLUG="${PROJECT_SLUG:-__skipped__}"
python3 - <<PY
import json, os
for p in (os.path.expanduser("~/.papercusp/registry.json"), os.path.expanduser("~/.restart-harness-projects.json")):
    if not os.path.exists(p): continue
    d = json.load(open(p))
    d["projects"] = [x for x in d["projects"] if x["slug"] != "$PROJECT_SLUG"]
    open(p, "w").write(json.dumps(d, indent=2))
PY

section "5. Auth flow"
JAR=/tmp/papercusp-smoke-jar.txt
rm -f "$JAR"
EMAIL="smoke-$$@papercusp.test"
LOGIN_RESP=$(curl -s -X POST http://localhost:3055/api/auth/login \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\"}")
TOKEN=$(echo "$LOGIN_RESP" | python3 -c 'import json,sys; url=json.load(sys.stdin).get("devMagicUrl",""); print(url.split("=")[-1] if url else "")' 2>/dev/null)
if [[ -n "$TOKEN" ]]; then
  ok "login generated dev magic link"
else
  fail "login did not return devMagicUrl: $LOGIN_RESP"
fi

if [[ -n "$TOKEN" ]]; then
  curl -s -c "$JAR" "http://localhost:3055/api/auth/verify?token=$TOKEN" > /dev/null
  if grep -q papercusp_session "$JAR" 2>/dev/null; then
    ok "verify set session cookie"
  else
    fail "verify did not set session cookie"
  fi

  STATUS=$(curl -s -b "$JAR" http://localhost:3055/api/auth/status)
  if echo "$STATUS" | grep -q '"signedIn":true'; then
    ok "status reports signedIn=true after verify"
  else
    fail "status not signed in: $STATUS"
  fi

  curl -s -X POST -b "$JAR" http://localhost:3055/api/auth/logout > /dev/null
  STATUS_AFTER=$(curl -s -b "$JAR" http://localhost:3055/api/auth/status)
  if echo "$STATUS_AFTER" | grep -q '"signedIn":false'; then
    ok "logout clears session"
  else
    fail "logout did not clear session: $STATUS_AFTER"
  fi
fi

# Cleanup test user
PGPASSWORD=postgres psql -U postgres_app -h localhost -d papercusp -tAc "DELETE FROM papercusp_auth.users WHERE email = '$EMAIL'" > /dev/null 2>&1
rm -f "$JAR"

section "6. Plugin loader tests + fire-hook CLI"
if (cd "$ROOT/packages/papercusp-plugin-loader" && npx tsx --test src/loader.test.ts > /tmp/papercusp-smoke-loader.log 2>&1); then
  count=$(grep -E '^ℹ pass [0-9]+' /tmp/papercusp-smoke-loader.log | head -1 | grep -oE '[0-9]+')
  ok "loader tests: $count/$count passing"
else
  fail "loader tests failed"
fi

# Verify the fire-hook CLI can invoke an afterDone hook end-to-end.
HOOK_TMP=$(mktemp -d /tmp/papercusp-smoke-fire-XXXXXX)
mkdir -p "$HOOK_TMP/plugins/probe" "$HOOK_TMP/.papercusp"
cat > "$HOOK_TMP/plugins/probe/papercusp.json" <<EOF
{"name":"probe","version":"0.0.1","papercusp":"^0.1.0","capabilities":[]}
EOF
cat > "$HOOK_TMP/plugins/probe/index.mjs" <<EOF
export default { name:'probe', version:'0.0.1', papercusp:'^0.1.0',
  capabilities:[],
  hooks:{ afterDone: async (ctx) => { ctx.log('SMOKE_OK'); } } };
EOF
HOOK_OUT=$("$ROOT/node_modules/.bin/papercusp-fire-hook" afterDone "$HOOK_TMP/plugins/probe" \
  --project-slug=smoke --project-dir="$HOOK_TMP" --state-dir="$HOOK_TMP/.papercusp" 2>&1)
if echo "$HOOK_OUT" | grep -q "SMOKE_OK"; then
  ok "fire-hook CLI invokes plugin afterDone"
else
  fail "fire-hook CLI: expected SMOKE_OK in output, got: $HOOK_OUT"
fi
rm -rf "$HOOK_TMP"

section "7. Web vitest"
if (cd "$ROOT/apps/web" && timeout 180 npx vitest run > /tmp/papercusp-smoke-vitest.log 2>&1); then
  pass_count=$(sed -r 's/\x1B\[[0-9;]*[mK]//g' /tmp/papercusp-smoke-vitest.log \
    | grep -oE 'Tests[[:space:]]+[0-9]+[[:space:]]+passed' | tail -1 | grep -oE '[0-9]+' | head -1)
  if [[ -n "$pass_count" ]]; then
    ok "vitest: $pass_count tests passed"
  else
    ok "vitest: passed (count not parsed)"
  fi
else
  fail "vitest failed"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [[ $FAIL -eq 0 ]]; then
  printf "\033[32m✓ all %d checks passed\033[0m\n" "$PASS"
  exit 0
else
  printf "\033[31m✗ %d/%d failed\033[0m\n" "$FAIL" "$((PASS + FAIL))"
  exit 1
fi
