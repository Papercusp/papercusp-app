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
  apps/operator-vite/src/components/adv/DreamControl.tsx
  apps/operator-vite/src/components/adv/DreamPanel.tsx
  apps/operator-vite/src/components/adv/dream-view.fixture.json
  packages/operator-core/lib/dream/capability-catalog.ts
  packages/operator-core/lib/dream/capability-contracts.ts
  packages/operator-core/lib/dream/capability-packets.ts
  packages/operator-core/lib/dream/capability-pass.ts
  packages/operator-core/lib/dream/capability-review.ts
  packages/operator-core/lib/dream/dream-config.ts
  packages/operator-core/lib/dream/dream-control.ts
  packages/operator-core/lib/dream/dream-cycle-action.ts
  packages/operator-core/lib/dream/dream-cycle.ts
  packages/operator-core/lib/dream/dream-evaluation.ts
  packages/operator-core/lib/dream/dream-metrics.ts
  packages/operator-core/lib/dream/dream-read.ts
  packages/operator-core/lib/dream/dream-run-provenance.ts
  packages/operator-core/lib/dream/dream-sources.ts
  packages/operator-core/lib/agent-tools/learning/dream-control.ts
  packages/operator-core/lib/endpoint-route/routes/agent-mcp/run-tool.ts
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

# Independent database observation: a successful click/HTTP acknowledgement is
# not proof that the requested routine transition persisted.
runtime_state() {
  node --import tsx - "$POT" "$1" <<'NODE'
import { getOrgPg } from '@papercusp/db-org';
const [pot, expected] = process.argv.slice(2);
const { sql } = getOrgPg();
try {
  const rows = await sql`
    SELECT name, active FROM harness_shared.routines
     WHERE workspace_id=${process.env.PAPERCUSP_WORKSPACE_ID!} AND install_slug=${pot}
       AND name IN ('dream-cycle-manual', 'dream-cycle-auto') AND target_role='system:dream-cycle'`;
  const manual = rows.find((row) => row.name === 'dream-cycle-manual');
  const automatic = rows.find((row) => row.name === 'dream-cycle-auto');
  console.log(JSON.stringify({pot, expectedActive: expected === 'true', manual, automatic}));
  if (rows.length !== 2 || manual?.active !== (expected === 'true') || automatic?.active !== false) {
    throw new Error('persisted Dream runtime does not match the requested manual transition');
  }
} finally { await sql.end(); }
NODE
}
assert_manual_runtime() {
  local expected="$1" timeout="${2:-60}" state='paused'
  [ "$expected" = true ] && state='scheduled'
  VERIFY_TAURI_DOM_TIMEOUT="$timeout" "$VERIFY_TAURI_POLL" \
    --selector '[data-testid="dream-control"]' --text "Manual dreaming: $state" --no-errors \
    && runtime_state "$expected"
}

# This fault lives only in the verifier's disposable DB. It records that the
# actual control writer reached PostgreSQL but leaves the manual routine paused.
# RETURN OLD lets the real API acknowledge the write without its transition.
runtime_fault() {
  node --import tsx - "$POT" "$1" <<'NODE'
import { getOrgPg } from '@papercusp/db-org';
const [pot, action] = process.argv.slice(2);
const workspace = process.env.PAPERCUSP_WORKSPACE_ID!;
const { sql } = getOrgPg();
try {
  if (action === 'install') {
    await sql.begin(async (tx) => {
      // The isolated schema publishes updates too: give this fault counter a
      // stable replica identity so its update does not roll back the real Start.
      await tx.unsafe('CREATE TABLE harness_shared.dream_native_fault (workspace_id text, pot_slug text, suppressed integer NOT NULL DEFAULT 0, PRIMARY KEY (workspace_id, pot_slug))');
      await tx`INSERT INTO harness_shared.dream_native_fault (workspace_id, pot_slug) VALUES (${workspace}, ${pot})`;
      await tx.unsafe(`CREATE FUNCTION harness_shared.dream_native_suppress_start() RETURNS trigger AS $$
        BEGIN
          IF NOT OLD.active AND NEW.active AND NEW.name = 'dream-cycle-manual' AND NEW.target_role = 'system:dream-cycle' THEN
            UPDATE harness_shared.dream_native_fault SET suppressed = suppressed + 1
              WHERE workspace_id = NEW.workspace_id AND pot_slug = NEW.install_slug;
            IF FOUND THEN RETURN OLD; END IF;
          END IF;
          RETURN NEW;
        END;
      $$ LANGUAGE plpgsql`);
      await tx.unsafe('CREATE TRIGGER dream_native_suppress_start BEFORE UPDATE ON harness_shared.routines FOR EACH ROW EXECUTE FUNCTION harness_shared.dream_native_suppress_start()');
    });
  } else if (action === 'verify') {
    const rows = await sql`SELECT suppressed FROM harness_shared.dream_native_fault WHERE workspace_id=${workspace} AND pot_slug=${pot}`;
    console.log(JSON.stringify({pot, suppressed: rows[0]?.suppressed}));
    if (rows.length !== 1 || rows[0].suppressed !== 1) throw new Error('native Start did not reach the suppressed runtime writer exactly once');
  } else if (action === 'remove') {
    await sql.begin(async (tx) => {
      await tx.unsafe('DROP TRIGGER IF EXISTS dream_native_suppress_start ON harness_shared.routines');
      await tx.unsafe('DROP FUNCTION IF EXISTS harness_shared.dream_native_suppress_start()');
      await tx.unsafe('DROP TABLE IF EXISTS harness_shared.dream_native_fault');
    });
  } else { throw new Error('unknown native fault action'); }
} finally { await sql.end(); }
NODE
}

echo "=== [1/9] register isolated pot and seed one immutable history row ==="
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

echo "=== [2/9] open native Dream control and verify initial paused state ==="
"$TOOL" navigate --pid "$VERIFY_TAURI_PID" "/adv?tab=learning&lpot=$POT" --json >/dev/null || fail "control navigation failed"
poll --selector '[data-testid="dream-control"]' --text 'Manual dreaming: paused' --no-errors || fail "paused control did not render"
runtime_state false || fail "initial runtime was not paused"

echo "=== [3/9] acknowledged Start without a runtime transition must fail acceptance ==="
runtime_fault install || { fail "runtime counterexample installation failed"; exit 1; }
# A selector click receipt only proves that the tool found a button. Wait for
# the actual control to be enabled, and retain dispatch/response evidence.
COUNTEREXAMPLE_READY='(() => { const control=document.querySelector("[data-testid=dream-control]"); const b=control && [...control.querySelectorAll("button")].find(x=>x.textContent?.trim()==="Start manual dreaming"); return !!b && !b.disabled && !control.querySelector("[role=alert]"); })()'
poll --require '[data-testid="dream-control"]' --eval "$COUNTEREXAMPLE_READY" --no-errors \
  || { fail "counterexample Start control was not ready"; exit 1; }
# Observe the REAL fetch and response; never substitute a mocked success.
COUNTEREXAMPLE_OBSERVER='(() => {
  const control=document.querySelector("[data-testid=dream-control]");
  const b=control && [...control.querySelectorAll("button")].find(x=>x.textContent?.trim()==="Start manual dreaming");
  if(!b || b.disabled)return false;
  const original=window.fetch;
  window.__dreamNativeFetch=original;
  window.__dreamNativeAck=null;
  const probe=window.__dreamNativeProbe={clicks:[],requests:[]};
  b.addEventListener("click",()=>probe.clicks.push({disabled:b.disabled}),{once:true,capture:true});
  window.fetch=async function(input,init){
    const requestUrl=typeof input==="string" ? input : input.url;
    let request;
    if(new URL(requestUrl,window.location.href).pathname==="/api/agent-mcp/run-tool" && init?.method==="POST"){
      try { request=JSON.parse(init.body); } catch {}
      probe.requests.push({name:request?.name,pot:request?.args?.pot,mode:request?.args?.mode,enabled:request?.args?.enabled});
    }
    const res=await original.call(this,input,init);
    if(request?.name==="dream:control" && request.args?.pot==="dream-native" && request.args.mode==="manual" && request.args.enabled===true){
      const ack={httpOk:res.ok,status:res.status,envelopeOk:false,refused:true};
      try {
        const body=await res.clone().json();
        ack.envelopeOk=body.ok===true;
        ack.error=body.message ?? body.error;
        const text=body.result?.content?.[0]?.text;
        ack.refused=body.result?.isError===true || (!!text && JSON.parse(text).ok===false);
      } catch(e){ ack.error=String(e); }
      window.__dreamNativeAck=ack;
    }
    return res;
  };
  b.id="dream-native-suppressed-start";
  return true;
})()'
check --eval "$COUNTEREXAMPLE_OBSERVER" \
  && "$TOOL" click --pid "$VERIFY_TAURI_PID" '#dream-native-suppressed-start' --wait 1500 --json \
  || fail "counterexample Start interaction failed"
COUNTEREXAMPLE_CAUSE_OK=1
VERIFY_TAURI_DOM_TIMEOUT=30 "$VERIFY_TAURI_POLL" --require '[data-testid="dream-control"]' \
  --eval '(() => { const ack=window.__dreamNativeAck; const control=document.querySelector("[data-testid=dream-control]"); const b=[...control.querySelectorAll("button")].find(x=>x.textContent?.trim()==="Start manual dreaming"); return ack?.httpOk===true && ack.envelopeOk===true && ack.refused===false && !!b && !b.disabled && !control.querySelector("[role=alert]"); })()' \
  --no-errors >"$OUT/counterexample-ack.json" \
  || { fail "counterexample did not receive a successful real API acknowledgement"; COUNTEREXAMPLE_CAUSE_OK=0; }
"$TOOL" eval --pid "$VERIFY_TAURI_PID" 'JSON.stringify({probe:window.__dreamNativeProbe,ack:window.__dreamNativeAck,control:document.querySelector("[data-testid=dream-control]")?.textContent})' \
  >"$OUT/counterexample-interaction.json" || fail "counterexample interaction evidence could not be retained"
runtime_fault verify >"$OUT/counterexample-writer.json" \
  || { fail "counterexample did not suppress the real runtime writer"; COUNTEREXAMPLE_CAUSE_OK=0; }
if [ "$COUNTEREXAMPLE_CAUSE_OK" -ne 1 ]; then
  echo "runtime-transition counterexample unmeasured: real acknowledged write was not established"
elif assert_manual_runtime true 5 >"$OUT/counterexample-rejected.log" 2>&1; then
  fail "acceptance passed an acknowledged Start with no runtime transition"
else
  echo "runtime-transition counterexample rejected"
fi
runtime_state false >"$OUT/counterexample-runtime.json" || fail "counterexample did not preserve paused runtime"
check --eval '(() => { if(!window.__dreamNativeFetch)return false; window.fetch=window.__dreamNativeFetch; delete window.__dreamNativeFetch; delete window.__dreamNativeAck; delete window.__dreamNativeProbe; return true; })()' \
  || fail "counterexample fetch observer cleanup failed"
runtime_fault remove || { fail "runtime counterexample cleanup failed"; exit 1; }

echo "=== [4/9] Start manual Dream and observe the requested runtime transition ==="
check --eval '(() => { const b=[...document.querySelectorAll("button")].find(x=>x.textContent?.trim()==="Start manual dreaming"); if(!b)return false;b.id="dream-native-start";return true; })()' \
  && "$TOOL" click --pid "$VERIFY_TAURI_PID" '#dream-native-start' --wait 1500 --json \
  || fail "Start manual dreaming interaction failed"
assert_manual_runtime true >"$OUT/start-runtime.log" 2>&1 || fail "Start transition was not observed in UI and runtime"

echo "=== [5/9] Pause manual Dream and observe the requested runtime transition ==="
check --eval '(() => { const b=[...document.querySelectorAll("button")].find(x=>x.textContent?.trim()==="Pause manual dreaming"); if(!b)return false;b.id="dream-native-pause";return true; })()' \
  && "$TOOL" click --pid "$VERIFY_TAURI_PID" '#dream-native-pause' --wait 1500 --json \
  || fail "Pause manual dreaming interaction failed"
assert_manual_runtime false >"$OUT/pause-runtime.log" 2>&1 || fail "Pause transition was not observed in UI and runtime"

echo "=== [6/9] Resume manual Dream, then pause to leave the disposable state inert ==="
check --eval '(() => { const b=[...document.querySelectorAll("button")].find(x=>x.textContent?.trim()==="Start manual dreaming"); if(!b)return false;b.id="dream-native-resume";return true; })()' \
  && "$TOOL" click --pid "$VERIFY_TAURI_PID" '#dream-native-resume' --wait 1500 --json \
  || fail "Resume interaction failed"
assert_manual_runtime true >"$OUT/resume-runtime.log" 2>&1 || fail "Resume transition was not observed in UI and runtime"
check --eval '(() => { const b=[...document.querySelectorAll("button")].find(x=>x.textContent?.trim()==="Pause manual dreaming"); if(!b)return false;b.id="dream-native-final-pause";return true; })()' \
  && "$TOOL" click --pid "$VERIFY_TAURI_PID" '#dream-native-final-pause' --wait 1500 --json \
  || fail "Final pause interaction failed"
assert_manual_runtime false >"$OUT/final-pause-runtime.log" 2>&1 || fail "Final pause was not observed in UI and runtime"

echo "=== [7/9] Analyze renders history and the seeded run ==="
"$TOOL" navigate --pid "$VERIFY_TAURI_PID" "/adv?tab=learning&lview=pipeline&dreamPot=$POT" --json >/dev/null || fail "Analyze navigation failed"
poll --selector '.pc-dreams' --text 'Dreams' --no-errors || fail "Dream Analyze panel did not render"
poll --selector '.pc-dreams__runs' --text 'Combine the A output with the B check.' --no-errors || fail "seeded history did not render"

echo "=== [8/9] open history and verify source links + scientific fields ==="
check --eval '(() => { const b=document.querySelector(".pc-dreams__runs .pc-learning-visual__disclosure-trigger"); if(!b)return false;b.click();return true; })()' \
  || fail "history row could not be opened"
poll --selector 'article[aria-label="Dream native-fixture-run"]' --text 'Catalogue coverage: partial' --no-errors || fail "Dream detail did not render"
check --eval '(() => { const a=document.querySelector("article[aria-label=\"Dream native-fixture-run\"] a[href^=\"#dream-source-\"]"); return !!a && !!document.querySelector(a.getAttribute("href")); })()' \
  || fail "source link did not resolve to captured evidence"
poll --selector 'article[aria-label="Dream native-fixture-run"]' --text 'Falsifiable experiment' --no-errors || fail "experiment evidence missing"

echo "=== [9/9] freshness, screenshot and instrument negative control ==="
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
echo "DREAM_NATIVE_OK pot=$POT output=$OUT start=pause=resume=history=source-links=runtime-counterexample=passed"
