#!/usr/bin/env bash
# Integration smoke for multi-harness-spawning v1.
#
# Smoke A — papercup-org happy path: directive → director → spawn child → completion
# Smoke B — generic non-papercup-org harness can also spawn children
# Smoke C — tiered visibility + cross-harness messaging (no LLM; substrate only)
# Smoke D — auth model holds against forgery attempts
#
# Designed to run end-to-end on a clean machine. Parallel state mutations
# (other agents, paperclip) may cause flake; re-run from a fresh prune.

set -uo pipefail

# Paths derive from THIS checkout / the invoking user — never one box (WI-4419).
REPO_ROOT="${PAPERCUSP_REPO_ROOT:-$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)}"

OPERATOR_BASE="${PAPERCUSP_OPERATOR_BASE:-http://localhost:3055}"
PASS=0; FAIL=0
results=()

note() { echo; echo "════ $* ════"; }
ok()   { PASS=$((PASS+1)); results+=("PASS  $*"); echo "  ✓ $*"; }
bad()  { FAIL=$((FAIL+1)); results+=("FAIL  $*"); echo "  ✗ $*"; }

token_for() {
  local slug="$1"
  local cfg
  for cfg in \
    "$HOME/.papercusp-workspaces/default/.papercusp/projects/$slug/.papercusp/config.json" \
    "$HOME/.papercusp/projects/$slug/.papercusp/config.json" \
    "$HOME/$slug/.papercusp/config.json" \
    "$HOME/.restart-org/.papercusp/config.json" \
    "$HOME/sheets-clone/.papercusp/config.json"; do
    if [ -f "$cfg" ]; then
      jq -r '.harness_token // empty' "$cfg" 2>/dev/null && return 0
    fi
  done
  echo ""
}

uuid() { uuidgen 2>/dev/null || python3 -c 'import uuid; print(uuid.uuid4())'; }

# ── Pre-clean: stale smoke-* state from prior runs ──
note "Pre-cleanup"
for stale in $(curl -sS "$OPERATOR_BASE/api/harness/projects" 2>/dev/null | jq -r '.projects[] | select(.slug | test("^smoke-")) | .slug'); do
  curl -sS -X DELETE "$OPERATOR_BASE/api/harness/projects/$stale" >/dev/null 2>&1
done
PGUSER=${PGUSER:-postgres_app} PGPASSWORD=${PGPASSWORD:-postgres} PGHOST=${PGHOST:-localhost} PGDATABASE=${PGDATABASE:-papercusp} \
  psql -At -c "
    DELETE FROM harness_shared.token_index WHERE harness_slug LIKE 'smoke-%';
    DELETE FROM harness_shared.projects WHERE slug LIKE 'smoke-%';
  " 2>/dev/null | tail -2 >/dev/null
rm -rf $HOME/.papercusp/projects/smoke-* $HOME/.papercusp-workspaces/default/.papercusp/projects/smoke-* 2>/dev/null
echo "  done"

# ── Smoke D — auth model (cheap, no LLM, run first to fail-fast on infra) ──
note "Smoke D — auth model holds"

S=$(curl -sS -o /dev/null -w "%{http_code}" -X POST "$OPERATOR_BASE/api/admin/execute-action" -H 'content-type: application/json' -d '{}')
[ "$S" = "401" ] && ok "D1 no-auth → 401" || bad "D1 expected 401, got $S"

S=$(curl -sS -o /dev/null -w "%{http_code}" -X POST "$OPERATOR_BASE/api/admin/execute-action" \
  -H 'Authorization: Bearer not-a-token' -H 'content-type: application/json' -d '{}')
[ "$S" = "401" ] && ok "D2 bogus-token → 401" || bad "D2 expected 401, got $S"

ORG_TOKEN="$(token_for papercup-org)"
if [ -z "$ORG_TOKEN" ]; then bad "D-prep papercup-org token not found"; else
  S=$(curl -sS -X POST "$OPERATOR_BASE/api/admin/execute-action" \
    -H "Authorization: Bearer $ORG_TOKEN" -H 'content-type: application/json' \
    -d '{"actionId":"d3-test-id","callingHarness":"sheets","action":{"op":"send_message","to":["sheets"],"kind":"X","subject":"x","reason":"D3 mismatch test should be rejected by middleware"}}')
  echo "$S" | jq -er '.error == "identity_mismatch"' >/dev/null 2>&1 && ok "D3 callingHarness mismatch → identity_mismatch" || bad "D3 unexpected: $S"

  S=$(curl -sS -X POST "$OPERATOR_BASE/api/admin/execute-action" \
    -H "Authorization: Bearer $ORG_TOKEN" -H 'content-type: application/json' \
    -d '{"actionId":"d4-test-id","action":{"op":"send_message","to":["sheets"],"kind":"X","subject":"x","reason":"D4 from-mismatch test","from":"sheets"}}')
  echo "$S" | jq -er '.error == "identity_mismatch"' >/dev/null 2>&1 && ok "D4 from mismatch → identity_mismatch" || bad "D4 unexpected: $S"

  S=$(curl -sS -X POST "$OPERATOR_BASE/api/admin/execute-action" \
    -H "Authorization: Bearer $ORG_TOKEN" -H 'content-type: application/json' \
    -d '{"actionId":"d5-test-id","action":{"op":"scaffold_harness","projectSlug":"d5-attempt","template":"papercup-coding","spec":"x","goal":"y","parent_slug":"attacker"}}')
  echo "$S" | jq -er '.error == "parent_slug_not_caller_controlled"' >/dev/null 2>&1 && ok "D5 body parent_slug → 400" || bad "D5 unexpected: $S"

  D6_ID=$(uuid)
  S=$(curl -sS -X POST "$OPERATOR_BASE/api/admin/execute-action" \
    -H "Authorization: Bearer $ORG_TOKEN" -H 'content-type: application/json' \
    -d "{\"actionId\":\"$D6_ID\",\"action\":{\"op\":\"send_message\",\"to\":[\"sheets\"],\"kind\":\"X\",\"subject\":\"x\",\"reason\":\"asdf\"}}")
  echo "$S" | jq -er '.error == "validation_error"' >/dev/null 2>&1 && ok "D6 short reason → validation_error" || bad "D6 unexpected: $S"
fi

# ── Smoke C — tiered visibility + cross-harness messaging (substrate only) ──
note "Smoke C — tiered visibility + cross-harness messaging"

ORG_TOKEN="$(token_for papercup-org)"
BUS_TOKEN="$(token_for papercup-org-business)"
if [ -z "$ORG_TOKEN" ] || [ -z "$BUS_TOKEN" ]; then
  bad "C-prep tokens missing — papercup-org install may not be complete"
else
  # Send Priority message from parent → child
  ACT=$(uuid)
  R=$(curl -sS -X POST "$OPERATOR_BASE/api/admin/execute-action" \
    -H "Authorization: Bearer $ORG_TOKEN" -H 'content-type: application/json' \
    -d "{\"actionId\":\"$ACT\",\"action\":{\"op\":\"send_message\",\"to\":[\"papercup-org-business\"],\"kind\":\"Priority\",\"subject\":\"smoke C: focus on auth\",\"reason\":\"smoke C: testing supervisor-channel from parent to child\"}}")
  echo "$R" | jq -er '.ok == true' >/dev/null && ok "C1 parent → child send_message accepted" || bad "C1 unexpected: $R"

  # Verify message landed in business inbox
  sleep 1
  MSG=$(curl -sS "$OPERATOR_BASE/api/harness/papercup-org-business/inbox?status=pending&limit=10" | jq -e '.messages[] | select(.from_slug=="papercup-org" and .subject == "smoke C: focus on auth")' 2>&1 | head -10 || true)
  # `|| true`: head -10 can exit before curl finishes writing, SIGPIPEing it, and
  # pipefail would report that as a failed fetch. Only $MSG's emptiness is tested here,
  # so the status is deliberately discarded — stated rather than left implicit, because
  # adding `set -e` to this script would otherwise make it fatal.
  [ -n "$MSG" ] && ok "C2 message landed in child inbox" || bad "C2 missing: $MSG"

  # Tier 2 substrate context for parent
  if [ -f $REPO_ROOT/libs/papercusp/packages/orchestrator/src/tiered-context.ts ]; then
    cat > /tmp/smoke-tiered-parent.mjs <<EOFJ
import { fetchSubstrateContext } from '$REPO_ROOT/libs/papercusp/packages/orchestrator/src/tiered-context.ts';
const ctx = await fetchSubstrateContext({ selfSlug: 'papercup-org', parentSlug: null });
process.stdout.write(ctx);
EOFJ
    P=$(node --experimental-strip-types /tmp/smoke-tiered-parent.mjs 2>/dev/null)
    echo "$P" | grep -q "## About Papercusp" && ok "C3 parent prompt has Tier 1 preamble" || bad "C3 missing preamble"
    echo "$P" | grep -q "Children (6)" && ok "C4 parent prompt has Children (6)" || bad "C4 missing 6 children: $(echo "$P" | grep Children | head -1)"
    echo "$P" | grep -q "Available read capabilities" && ok "C5 parent prompt has Tier 3 capabilities" || bad "C5 missing capabilities"
    LEN=$(echo -n "$P" | wc -c)
    [ "$LEN" -lt 4000 ] && ok "C6 parent substrate framing < 4000 chars (got $LEN)" || bad "C6 too large ($LEN)"
  fi

  # Tier 2 substrate context for child should show parent + 5 siblings
  cat > /tmp/smoke-tiered-child.mjs <<EOFJ
import { fetchSubstrateContext } from '$REPO_ROOT/libs/papercusp/packages/orchestrator/src/tiered-context.ts';
const ctx = await fetchSubstrateContext({ selfSlug: 'papercup-org-business', parentSlug: 'papercup-org' });
process.stdout.write(ctx);
EOFJ
  C=$(node --experimental-strip-types /tmp/smoke-tiered-child.mjs 2>/dev/null)
  echo "$C" | grep -q "Parent: papercup-org" && ok "C7 child prompt has parent" || bad "C7 missing parent"
  echo "$C" | grep -q "Siblings (5" && ok "C8 child prompt has 5 siblings" || bad "C8 missing siblings: $(echo "$C" | grep Siblings | head -1)"

  # Bounded supervisor inbox should contain the Priority message
  echo "$C" | grep -q "smoke C: focus on auth" && ok "C9 child prompt has supervisor message in inbox" || bad "C9 missing supervisor msg"
fi

# ── Smoke A — papercup-org happy path (substrate-only; no full LLM run) ──
note "Smoke A — papercup-org happy path (no LLM, executes the verbs directly)"

ORG_TOKEN="$(token_for papercup-org)"
if [ -z "$ORG_TOKEN" ]; then
  bad "A-prep papercup-org token not found"
else
  # Pre-clean stale Smoke A/B children from prior runs so neighbor-view counts stay deterministic.
  for stale in $(curl -sS "$OPERATOR_BASE/api/harness/projects" 2>/dev/null | jq -r '.projects[] | select(.slug | test("^smoke-(a|b)-child-")) | .slug'); do
    curl -sS -X DELETE "$OPERATOR_BASE/api/harness/projects/$stale" >/dev/null 2>&1
  done
  PGUSER=postgres_app PGPASSWORD=postgres PGHOST=localhost PGDATABASE=papercusp psql -At -c "
    DELETE FROM harness_shared.token_index WHERE harness_slug LIKE 'smoke-%';
    DELETE FROM harness_shared.projects WHERE slug LIKE 'smoke-%';
  " 2>/dev/null | tail -2 >/dev/null

  # 1. Drop directive into parent inbox
  ACT=$(uuid)
  R=$(curl -sS -X POST "$OPERATOR_BASE/api/harness/papercup-org/messages" \
    -H 'content-type: application/json' \
    -d "{\"to\":[\"papercup-org\"],\"kind\":\"Directive\",\"subject\":\"smoke A: ship a hello-world page\",\"body\":\"single static index.html\",\"reason\":\"smoke A directive submission via user-curl wrapper\",\"actionId\":\"$ACT\"}")
  echo "$R" | jq -er '.ok == true' >/dev/null && ok "A1 directive landed via user-curl wrapper" || bad "A1 unexpected: $R"

  # 2. Director (simulated): emit spinup_project + scaffold_harness via direct executeAction
  ACT_SP=$(uuid)
  PROJ_NAME="smoke A hello world $(date +%s)"
  SPINUP=$(curl -sS -X POST "$OPERATOR_BASE/api/admin/execute-action" \
    -H "Authorization: Bearer $ORG_TOKEN" -H 'content-type: application/json' \
    -d "{\"actionId\":\"$ACT_SP\",\"action\":{\"op\":\"spinup_project\",\"directiveId\":\"D-SMOKE-A\",\"projectName\":\"$PROJ_NAME\",\"projectVertical\":\"apps\",\"projectBudgetCents\":10000,\"departments\":[\"papercup-org-technology\"]}}")
  echo "$SPINUP" | jq -er '.ok == true' >/dev/null && ok "A2 spinup_project ok" || bad "A2 unexpected: $SPINUP"
  PROJ_ID=$(echo "$SPINUP" | jq -r '.result.projectId // empty')
  [ -n "$PROJ_ID" ] && ok "A2b projectId returned: $PROJ_ID" || bad "A2b no projectId"

  # 3. scaffold_harness for a child
  CHILD_SLUG="smoke-a-child-$(date +%s)"
  ACT_SC=$(uuid)
  SCAFFOLD=$(curl -sS -X POST "$OPERATOR_BASE/api/admin/execute-action" \
    -H "Authorization: Bearer $ORG_TOKEN" -H 'content-type: application/json' \
    --max-time 300 \
    -d "{\"actionId\":\"$ACT_SC\",\"action\":{\"op\":\"scaffold_harness\",\"projectSlug\":\"$CHILD_SLUG\",\"template\":\"papercup-coding\",\"spec\":\"# Hello World\\n\\nWrite a single static index.html file containing the text 'hello world'.\",\"goal\":\"Create one static HTML page.\"}}")
  echo "$SCAFFOLD" | jq -er '.ok == true' >/dev/null && ok "A3 scaffold_harness ok" || bad "A3 unexpected: $SCAFFOLD"

  # 4. Verify child appears in registry with parent_slug
  sleep 1
  CHILD_ROW=$(curl -sS "$OPERATOR_BASE/api/harness/projects?parent_slug=papercup-org" | jq -e ".projects[] | select(.slug == \"$CHILD_SLUG\")" 2>&1)
  [ -n "$CHILD_ROW" ] && ok "A4 child registered with parent_slug=papercup-org" || bad "A4 missing: $CHILD_ROW"

  # 5. Verify child PG schema
  CHILD_SCHEMA="harness_$(echo "$CHILD_SLUG" | tr '-' '_')"
  HAVE=$(PGUSER=postgres_app PGPASSWORD=postgres PGHOST=localhost PGDATABASE=papercusp psql -At -c \
    "SELECT 1 FROM information_schema.tables WHERE table_schema='$CHILD_SCHEMA' AND table_name='messages'" 2>&1)
  [ "$HAVE" = "1" ] && ok "A5 child PG schema $CHILD_SCHEMA has messages table" || bad "A5 schema missing: $HAVE"

  # 6. Verify child has token
  CHILD_TOKEN="$(token_for "$CHILD_SLUG")"
  [ -n "$CHILD_TOKEN" ] && ok "A6 child has harness_token" || bad "A6 no token"

  # 7. Fire afterDone hook directly to simulate child completion (no LLM run needed)
  if [ -n "$CHILD_TOKEN" ]; then
    CHILD_PATH=$(curl -sS "$OPERATOR_BASE/api/harness/projects" | jq -r ".projects[] | select(.slug == \"$CHILD_SLUG\") | .path")
    if [ -d "$CHILD_PATH" ]; then
      cd "$CHILD_PATH"
      PROJECT_DIR="$CHILD_PATH" STATE_DIR="$CHILD_PATH/.papercusp" PAPERCUSP_OPERATOR_BASE="$OPERATOR_BASE" \
        bash $REPO_ROOT/libs/papercusp/packages/harness/hooks/builtins/afterDone.sh
      sleep 1
      DONE=$(curl -sS "$OPERATOR_BASE/api/harness/papercup-org/inbox?status=all" | jq -e ".messages[] | select(.from_slug == \"$CHILD_SLUG\" and .kind == \"Completion\")" 2>&1)
      [ -n "$DONE" ] && ok "A7 afterDone fired; Completion in parent inbox" || bad "A7 missing: $DONE"
    else
      bad "A7 child path doesn't exist on disk: $CHILD_PATH"
    fi
  fi
fi

# ── Smoke B — generic non-papercup-org harness spawns children ──
note "Smoke B — generic harness spawning"

# Pick a non-papercup-org harness with scaffold_harness allowedActions.
# `org` (the legacy ~/.restart-org) IS a generic harness with role configs.
# Verify it has the allowedAction; if not, we'd need to add it.
ORG_LEGACY_TOKEN="$(token_for org)"
if [ -z "$ORG_LEGACY_TOKEN" ]; then
  bad "B-prep no legacy 'org' token; can't run Smoke B"
else
  # Test that scaffold_harness from the legacy org token works.
  CHILD_B="smoke-b-child-$(date +%s)"
  ACT_B=$(uuid)
  SCAFFOLD_B=$(curl -sS -X POST "$OPERATOR_BASE/api/admin/execute-action" \
    -H "Authorization: Bearer $ORG_LEGACY_TOKEN" -H 'content-type: application/json' \
    --max-time 300 \
    -d "{\"actionId\":\"$ACT_B\",\"action\":{\"op\":\"scaffold_harness\",\"projectSlug\":\"$CHILD_B\",\"template\":\"coding-project\",\"spec\":\"# smoke b\\n\\nGeneric spawn test.\",\"goal\":\"Verify substrate is generic.\"}}")
  echo "$SCAFFOLD_B" | jq -er '.ok == true' >/dev/null && ok "B1 generic harness 'org' can spawn (scaffold_harness ok)" || bad "B1 unexpected: $SCAFFOLD_B"

  if echo "$SCAFFOLD_B" | jq -er '.ok == true' >/dev/null; then
    sleep 1
    PARENT=$(curl -sS "$OPERATOR_BASE/api/harness/projects?parent_slug=org" | jq -e ".projects[] | select(.slug == \"$CHILD_B\") | .parent_slug" 2>&1)
    [ "$PARENT" = "\"org\"" ] && ok "B2 child parent_slug=org" || bad "B2 unexpected parent_slug: $PARENT"
  fi
fi

# ── Smoke E — additional v2 verbs (pause/resume/mark_campaign_published, dryRun, prune) ──
note "Smoke E — v2 verbs + dryRun + prune"

ORG_TOKEN="$(token_for papercup-org)"
[ -z "$ORG_TOKEN" ] && ORG_TOKEN="$(token_for org)"

if [ -z "$ORG_TOKEN" ]; then
  bad "E-prep no token"
else
  # Pick any project slug from harness_shared.projects (not the harness registry).
  # spinup_project from Smoke A creates one we can target.
  PROJ_SLUG=$(PGUSER=postgres_app PGPASSWORD=postgres PGHOST=localhost PGDATABASE=papercusp psql -At -c \
    "SELECT slug FROM harness_shared.projects WHERE slug IS NOT NULL ORDER BY updated_ts DESC LIMIT 1" 2>/dev/null)
  [ -z "$PROJ_SLUG" ] && PROJ_SLUG="sheets"

  E1=$(curl -sS -X POST "$OPERATOR_BASE/api/admin/execute-action" \
    -H "Authorization: Bearer $ORG_TOKEN" -H 'content-type: application/json' \
    -d "{\"actionId\":\"$(uuid)\",\"action\":{\"op\":\"pause_project\",\"projectSlug\":\"$PROJ_SLUG\",\"reason\":\"E1 smoke pause test\"}}")
  echo "$E1" | jq -er '.ok == true' >/dev/null && ok "E1 pause_project ok ($PROJ_SLUG)" || bad "E1 unexpected: $E1"

  E2=$(curl -sS -X POST "$OPERATOR_BASE/api/admin/execute-action" \
    -H "Authorization: Bearer $ORG_TOKEN" -H 'content-type: application/json' \
    -d "{\"actionId\":\"$(uuid)\",\"action\":{\"op\":\"resume_project\",\"projectSlug\":\"$PROJ_SLUG\"}}")
  echo "$E2" | jq -er '.ok == true' >/dev/null && ok "E2 resume_project ok" || bad "E2 unexpected: $E2"

  E3=$(curl -sS -X POST "$OPERATOR_BASE/api/admin/execute-action" \
    -H "Authorization: Bearer $ORG_TOKEN" -H 'content-type: application/json' \
    -d "{\"actionId\":\"$(uuid)\",\"action\":{\"op\":\"pause_project\",\"projectSlug\":\"nonexistent-$(date +%s)\"}}")
  echo "$E3" | jq -er '.error == "not_found"' >/dev/null && ok "E3 pause non-existent → not_found" || bad "E3 unexpected: $E3"

  # dryRun
  E4=$(curl -sS -X POST "$OPERATOR_BASE/api/admin/execute-action" \
    -H "Authorization: Bearer $ORG_TOKEN" -H 'content-type: application/json' \
    -d "{\"actionId\":\"$(uuid)\",\"action\":{\"op\":\"scaffold_harness\",\"projectSlug\":\"would-spawn-$(date +%s)\",\"template\":\"papercup-coding\",\"spec\":\"x\",\"goal\":\"y\",\"dryRun\":true}}")
  echo "$E4" | jq -er '.result.dryRun == true' >/dev/null && ok "E4 scaffold_harness dryRun returns binding without scaffolding" || bad "E4 unexpected: $E4"

  # Prune endpoint (dryRun)
  E5=$(curl -sS -X POST "$OPERATOR_BASE/api/admin/prune-executed-actions?dryRun=1" \
    -H "Authorization: Bearer $ORG_TOKEN")
  echo "$E5" | jq -er '.ok == true' >/dev/null && ok "E5 prune endpoint dryRun ok ($(echo "$E5" | jq -r '.totalDeleted // "?"') would-delete)" || bad "E5 unexpected: $E5"

  # Cycle: caller tries to spawn itself
  E6=$(curl -sS -X POST "$OPERATOR_BASE/api/admin/execute-action" \
    -H "Authorization: Bearer $ORG_TOKEN" -H 'content-type: application/json' \
    -d "{\"actionId\":\"$(uuid)\",\"action\":{\"op\":\"scaffold_harness\",\"projectSlug\":\"papercup-org\",\"template\":\"papercup-coding\",\"spec\":\"x\",\"goal\":\"y\",\"dryRun\":true}}")
  echo "$E6" | jq -er '.error == "validation_error" and (.detail | tostring | contains("itself") or contains("cycle") or contains("ancestor"))' >/dev/null \
    && ok "E6 self-spawn rejected as cycle/validation" || bad "E6 unexpected: $E6"

  # Token rotation: rotate a department's token; old → 401, new → 200
  ROTATE_TARGET=papercup-org-coordination
  ROTATE_OLD="$(token_for $ROTATE_TARGET)"
  if [ -n "$ROTATE_OLD" ]; then
    E7=$(curl -sS -X POST "$OPERATOR_BASE/api/admin/rotate-token" \
      -H "Authorization: Bearer $ROTATE_OLD")
    echo "$E7" | jq -er '.ok == true' >/dev/null && ok "E7 rotate-token returned new bearer" || bad "E7 unexpected: $E7"

    NEW_T=$(echo "$E7" | jq -r '.newToken // ""')
    if [ -n "$NEW_T" ]; then
      OLD_S=$(curl -sS -o /dev/null -w "%{http_code}" -X POST "$OPERATOR_BASE/api/admin/execute-action" \
        -H "Authorization: Bearer $ROTATE_OLD" -H 'content-type: application/json' \
        -d "{\"actionId\":\"$(uuid)\",\"action\":{\"op\":\"send_message\",\"to\":[\"papercup-org\"],\"kind\":\"X\",\"subject\":\"y\",\"reason\":\"E7 old-token rejection check after rotate\"}}")
      [ "$OLD_S" = "401" ] && ok "E7b old token now 401" || bad "E7b old token still works: $OLD_S"

      NEW_S=$(curl -sS -X POST "$OPERATOR_BASE/api/admin/execute-action" \
        -H "Authorization: Bearer $NEW_T" -H 'content-type: application/json' \
        -d "{\"actionId\":\"$(uuid)\",\"action\":{\"op\":\"send_message\",\"to\":[\"papercup-org\"],\"kind\":\"Test\",\"subject\":\"y\",\"reason\":\"E7 new-token usability check after rotate\"}}")
      echo "$NEW_S" | jq -er '.ok == true' >/dev/null && ok "E7c new token works for executeAction" || bad "E7c unexpected: $NEW_S"
    fi
  fi

  # add_directive_summary
  E8=$(curl -sS -X POST "$OPERATOR_BASE/api/admin/execute-action" \
    -H "Authorization: Bearer $ORG_TOKEN" -H 'content-type: application/json' \
    -d "{\"actionId\":\"$(uuid)\",\"action\":{\"op\":\"add_directive_summary\",\"directiveId\":\"D-SMOKE-E8\",\"summary\":\"Smoke E8 directive memory: spawned 1 child smoke-a-child, all in_progress, no blockers reported.\",\"source\":\"ceo\"}}")
  echo "$E8" | jq -er '.ok == true' >/dev/null && ok "E8 add_directive_summary persisted" || bad "E8 unexpected: $E8"

  # Per-role addressing — send to specific role; verify inbox filter works
  E9_TAG="E9-$(uuid)"
  E9_ID=$(uuid)
  E9_SEND=$(curl -sS -X POST "$OPERATOR_BASE/api/admin/execute-action" \
    -H "Authorization: Bearer $ORG_TOKEN" -H 'content-type: application/json' \
    -d "{\"actionId\":\"$E9_ID\",\"action\":{\"op\":\"send_message\",\"to\":[\"papercup-org-coordination\"],\"toRole\":\"director\",\"kind\":\"Priority\",\"subject\":\"$E9_TAG\",\"reason\":\"verify to_role addressing routes only to specified role in receiver inbox filter\"}}")
  echo "$E9_SEND" | jq -er '.ok == true' >/dev/null && ok "E9 send_message with toRole accepted" || bad "E9 unexpected: $E9_SEND"

  sleep 1
  E9_DIR=$(curl -sS "$OPERATOR_BASE/api/harness/papercup-org-coordination/inbox?status=all&role=director&limit=10" | jq -r --arg t "$E9_TAG" '[.messages[] | select(.subject == $t)] | length')
  E9_WORK=$(curl -sS "$OPERATOR_BASE/api/harness/papercup-org-coordination/inbox?status=all&role=worker&limit=10" | jq -r --arg t "$E9_TAG" '[.messages[] | select(.subject == $t)] | length')
  [ "$E9_DIR" = "1" ] && ok "E9b inbox?role=director sees the message" || bad "E9b unexpected director-count: $E9_DIR"
  [ "$E9_WORK" = "0" ] && ok "E9c inbox?role=worker excludes the message" || bad "E9c unexpected worker-count: $E9_WORK"

  # E10 (cross-harness search over the just-sent message) is GONE, not migrated.
  # It asserted on `/api/harness/search?kind=messages`, and BOTH halves of that
  # are retired: the work-item mail corpus was removed 2026-07-26 (WI-6097), so
  # P-018 made `kind=messages` answer 410; and the route itself was deleted
  # 2026-09-05 as uncalled (EI-19909503716698677 — zero requests across the full
  # 7d `route_invocations` window, never mounted on the hosted control plane, no
  # consumer in any sibling checkout). The check had therefore been dead since
  # P-018: `.messageHits` was absent from the 410 body, `jq length` of null is 0,
  # and `[ 0 -ge 1 ]` reported `bad` — it could not pass. There is nothing to
  # re-point it at, because the corpus it searched no longer exists.

  # KPIs endpoint
  E11=$(curl -sS "$OPERATOR_BASE/api/harness/all/kpis")
  echo "$E11" | jq -er '.totals.harnesses != null and (.audit.actions_24h_by_op | length) > 0' >/dev/null \
    && ok "E11 KPIs endpoint returns totals + audit op-counts" || bad "E11 unexpected: $E11"
fi

# ── Summary ──
echo
echo "════ SUMMARY ════"
echo "PASS: $PASS"
echo "FAIL: $FAIL"
printf '%s\n' "${results[@]}"
exit $FAIL
