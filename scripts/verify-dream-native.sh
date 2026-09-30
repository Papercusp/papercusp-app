#!/usr/bin/env bash
# Maintained native acceptance for Dream controls + Analyze history.
# Run through verify-tauri-headless.sh with VERIFY_TAURI_ISOLATED_DB=1 and
# VERIFY_TAURI_ISOLATED_SEED=ready. Every write stays in its disposable DB.
set -uo pipefail

: "${VERIFY_TAURI_PID:?run via scripts/verify-tauri-headless.sh}"
: "${VERIFY_TAURI_POLL:?missing verifier poll helper}"
: "${VERIFY_TAURI_FRESHNESS_CHECK:?missing snapshot freshness helper}"
: "${PAPERCUSP_HOME:?isolated PAPERCUSP_HOME is required}"
: "${HARNESS_ADMIN_DATABASE_URL:?isolated database is required}"
[ "${PAPERCUSP_VERIFY_TAURI_ISOLATED:-0}" = "1" ] || {
  echo "DREAM_NATIVE_FAIL isolated verifier required" >&2; exit 1;
}

TOOL="${VERIFY_TAURI_AGENT_TOOLS_BIN:-tauri-agent-tools}"
ROOT="${VERIFY_TAURI_ORIGINAL_REPO_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
POT="dream-native"
POT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/dream-native-pot.XXXXXX")"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${DREAM_NATIVE_OUT:-/tmp/dream-native-$STAMP}"
mkdir -p "$OUT"
TARGET_SOURCES=(
  apps/operator-vite/src/components/adv/DreamPanel.tsx
  apps/operator-vite/src/components/adv/dream-view.fixture.json
  packages/operator-core/lib/dream/capability-catalog.ts
  packages/operator-core/lib/dream/capability-contracts.ts
  packages/operator-core/lib/dream/capability-packets.ts
  packages/operator-core/lib/dream/capability-pass.ts
  packages/operator-core/lib/dream/capability-review.ts
  packages/operator-core/lib/dream/dream-config.ts
  packages/operator-core/lib/dream/dream-cycle-action.ts
  packages/operator-core/lib/dream/dream-cycle.ts
  packages/operator-core/lib/dream/dream-evaluation.ts
  packages/operator-core/lib/dream/dream-metrics.ts
  packages/operator-core/lib/dream/dream-read.ts
  packages/operator-core/lib/dream/dream-run-provenance.ts
  packages/operator-core/lib/dream/dream-sources.ts
  scripts/verify-dream-native.sh
)
TARGET_HASHES="$OUT/target-sources.sha256"
(cd "$ROOT" && sha256sum "${TARGET_SOURCES[@]}") >"$TARGET_HASHES" \
  || { echo "DREAM_NATIVE_FAIL target source snapshot failed" >&2; exit 1; }
trap 'rm -rf -- "$POT_DIR"' EXIT
FAIL=0
fail() { echo "DREAM_NATIVE_FAIL $*" >&2; FAIL=1; }
check() { "$TOOL" check --pid "$VERIFY_TAURI_PID" "$@" --json; }
poll() { VERIFY_TAURI_DOM_TIMEOUT=60 "$VERIFY_TAURI_POLL" "$@"; }

echo "=== [1/8] register isolated pot and seed one immutable history row ==="
REGISTER="$(node - "$VERIFY_TAURI_DEV_URL" "$POT_DIR" "$POT" <<'NODE'
const [base, root, slug] = process.argv.slice(2);
const response = await fetch(base + '/api/harness/pots', {
  method: 'POST', headers: {'content-type':'application/json'},
  body: JSON.stringify({slug, path: root, knowledgePack: null}),
  signal: AbortSignal.timeout(120000),
});
const body = await response.text();
console.log(JSON.stringify({status: response.status, body: body.slice(0, 2000)}));
if (!response.ok) process.exitCode = 1;
NODE
)" || fail "pot registration failed: $REGISTER"
printf '%s\n' "$REGISTER" | tee "$OUT/register.json"

node --import tsx - "$POT" <<'NODE' || fail "history fixture seed failed"
import { readFile } from 'node:fs/promises';
import { getOrgPg } from '@papercusp/db-org';
const pot = process.argv[2];
const workspace = process.env.PAPERCUSP_WORKSPACE_ID!;
const fixture = JSON.parse(await readFile('apps/operator-vite/src/components/adv/dream-view.fixture.json', 'utf8'));
const run = fixture.detail.run;
const { sql } = getOrgPg();
try {
  await sql`
    INSERT INTO harness_shared.dream_runs
      (workspace_id, run_id, cycle_id, pot_slug, mode, status, fragment_refs, fragment_kinds,
       pairing, similarity, dreamer_model, reviewer_model, dream_usage, review_usage, outcome,
       review, routed_ref, input_tokens, output_tokens, cost_usd, error, started_at, completed_at, updated_at)
    VALUES (${workspace}, 'native-fixture-run', 'native-fixture-cycle', ${pot}, ${run.mode}, ${run.status},
      ${JSON.stringify(run.fragmentRefs)}::jsonb, ${JSON.stringify(run.fragmentKinds)}::jsonb,
      ${run.pairing}, ${run.similarity}, ${run.dreamerModel}, ${run.reviewerModel},
      ${JSON.stringify(run.dreamUsage)}::jsonb, ${JSON.stringify(run.reviewUsage)}::jsonb,
      ${JSON.stringify(run.outcome)}::jsonb, ${JSON.stringify(run.review)}::jsonb,
      ${run.routedRef}, ${run.inputTokens}, ${run.outputTokens}, ${run.costUsd}, ${run.error},
      now() - interval '2 minutes', now() - interval '1 minute', now() - interval '1 minute')
    ON CONFLICT (workspace_id, run_id) DO NOTHING`;
  const rows = await sql`SELECT run_id FROM harness_shared.dream_runs WHERE workspace_id=${workspace} AND run_id='native-fixture-run'`;
  if (rows.length !== 1) throw new Error('native history seed missing');
} finally { await sql.end(); }
NODE

echo "=== [2/8] open native Dream control and verify initial paused state ==="
"$TOOL" navigate --pid "$VERIFY_TAURI_PID" "/adv?tab=learning&lpot=$POT" --json >/dev/null || fail "control navigation failed"
poll --selector '[data-testid="dream-control"]' --text 'Manual dreaming: paused' --no-errors || fail "paused control did not render"

echo "=== [3/8] Start manual Dream and observe the requested runtime transition ==="
check --eval '(() => { const b=[...document.querySelectorAll("button")].find(x=>x.textContent?.trim()==="Start manual dreaming"); if(!b)return false;b.id="dream-native-start";return true; })()' \
  && "$TOOL" click --pid "$VERIFY_TAURI_PID" '#dream-native-start' --wait 1500 --json \
  || fail "Start manual dreaming interaction failed"
poll --selector '[data-testid="dream-control"]' --text 'Manual dreaming: scheduled' --no-errors || fail "Start transition was not observed"

echo "=== [4/8] Pause manual Dream and observe the requested runtime transition ==="
check --eval '(() => { const b=[...document.querySelectorAll("button")].find(x=>x.textContent?.trim()==="Pause manual dreaming"); if(!b)return false;b.id="dream-native-pause";return true; })()' \
  && "$TOOL" click --pid "$VERIFY_TAURI_PID" '#dream-native-pause' --wait 1500 --json \
  || fail "Pause manual dreaming interaction failed"
poll --selector '[data-testid="dream-control"]' --text 'Manual dreaming: paused' --no-errors || fail "Pause transition was not observed"

echo "=== [5/8] Resume manual Dream, then pause to leave the disposable state inert ==="
check --eval '(() => { const b=[...document.querySelectorAll("button")].find(x=>x.textContent?.trim()==="Start manual dreaming"); if(!b)return false;b.id="dream-native-resume";return true; })()' \
  && "$TOOL" click --pid "$VERIFY_TAURI_PID" '#dream-native-resume' --wait 1500 --json \
  || fail "Resume interaction failed"
poll --selector '[data-testid="dream-control"]' --text 'Manual dreaming: scheduled' --no-errors || fail "Resume transition was not observed"
check --eval '(() => { const b=[...document.querySelectorAll("button")].find(x=>x.textContent?.trim()==="Pause manual dreaming"); if(!b)return false;b.id="dream-native-final-pause";return true; })()' \
  && "$TOOL" click --pid "$VERIFY_TAURI_PID" '#dream-native-final-pause' --wait 1500 --json \
  || fail "Final pause interaction failed"
poll --selector '[data-testid="dream-control"]' --text 'Manual dreaming: paused' --no-errors || fail "Final pause was not observed"

echo "=== [6/8] Analyze renders history and the seeded run ==="
"$TOOL" navigate --pid "$VERIFY_TAURI_PID" "/adv?tab=learning&lview=pipeline&dreamPot=$POT" --json >/dev/null || fail "Analyze navigation failed"
poll --selector '.pc-dreams' --text 'Dreams' --no-errors || fail "Dream Analyze panel did not render"
poll --selector '.pc-dreams__runs' --text 'Combine the A output with the B check.' --no-errors || fail "seeded history did not render"

echo "=== [7/8] open history and verify source links + scientific fields ==="
check --eval '(() => { const b=document.querySelector(".pc-dreams__runs .pc-learning-visual__disclosure-trigger"); if(!b)return false;b.click();return true; })()' \
  || fail "history row could not be opened"
poll --selector 'article[aria-label="Dream native-fixture-run"]' --text 'Catalogue coverage: partial' --no-errors || fail "Dream detail did not render"
check --eval '(() => { const a=document.querySelector("article[aria-label=\"Dream native-fixture-run\"] a[href^=\"#dream-source-\"]"); return !!a && !!document.querySelector(a.getAttribute("href")); })()' \
  || fail "source link did not resolve to captured evidence"
poll --selector 'article[aria-label="Dream native-fixture-run"]' --text 'Falsifiable experiment' --no-errors || fail "experiment evidence missing"

echo "=== [8/8] freshness, screenshot and falsifiability controls ==="
if ! bash "$VERIFY_TAURI_FRESHNESS_CHECK"; then
  if (cd "$ROOT" && sha256sum --check --status "$TARGET_HASHES"); then
    echo "DREAM_NATIVE_NOTE shared SPA rebuilt after freeze, but every Dream target source stayed byte-identical"
  else
    fail "Dream target source changed after the current-build snapshot froze"
  fi
fi
if check --selector '.dream-native-impossible-sentinel'; then fail "missing-selector negative control passed"; else echo "negative control confirmed"; fi
WINDOW_ID="$(DISPLAY="$VERIFY_TAURI_DISPLAY" xdotool search --pid "$VERIFY_TAURI_PID" | head -n 1)"
SCREENSHOT="$OUT/dream-native.png"
if [ -n "$WINDOW_ID" ]; then
  for attempt in 1 2 3; do
    rm -f -- "$SCREENSHOT"
    DISPLAY="$VERIFY_TAURI_DISPLAY" import -window "$WINDOW_ID" "$SCREENSHOT" && break
    sleep 1
  done
fi
if [ ! -s "$SCREENSHOT" ]; then
  for attempt in 1 2 3; do
    rm -f -- "$SCREENSHOT"
    DISPLAY="$VERIFY_TAURI_DISPLAY" import -window root "$SCREENSHOT" && break
    sleep 1
  done
fi
[ -s "$SCREENSHOT" ] && identify "$SCREENSHOT" >/dev/null 2>&1 || fail "screenshot failed or is not a readable image"

if [ "$FAIL" -ne 0 ]; then exit 1; fi
echo "DREAM_NATIVE_OK pot=$POT output=$OUT start=pause=resume=history=source-links=passed"
