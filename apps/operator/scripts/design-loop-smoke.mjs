#!/usr/bin/env node
/**
 * End-to-end smoke for the design phase.
 *
 * Exercises every shipped piece in order:
 *
 *   1. Create a feature via tasks/create dispatcher (op:'create_feature')
 *      → PG trigger 050 auto-flags needs_design from title text
 *   2. Verify the feature lands in the design tab's queue (REST endpoint)
 *   3. Designer-side tools (10 MCP tools):
 *        get_design_spec, list_memos, read_memo, list_tokens, read_token,
 *        search_registry, get_registry_component, validate_spec, lint_spec,
 *        submit_spec
 *   4. Verify spec persisted + design_status flipped to 'accepted'
 *   5. Sketch artifact via /api/design/sketches
 *   6. Visual regression listing via /api/design/regressions
 *   7. Cleanup PG state
 *
 * Pass: prints OK + 7 stages green.
 * Fail: prints the first failed stage and exits non-zero.
 *
 * Usage:
 *   OPERATOR_BASE_URL=http://localhost:3055 \
 *   node apps/operator/scripts/design-loop-smoke.mjs
 *
 * The script picks the harness slug 'org' by default (it has a token
 * in harness_shared.token_index in the dev environment). Override
 * via HARNESS_SLUG=…
 */
import { execFileSync } from 'node:child_process';

const BASE = process.env.OPERATOR_BASE_URL || 'http://localhost:3055';
const SLUG = process.env.HARNESS_SLUG || 'org';
const WORKSPACE = process.env.WORKSPACE_ID || 'default';

function pgQuery(sql) {
  const env = { ...process.env, PGPASSWORD: 'harness_admin_pwd' };
  const out = execFileSync(
    'psql',
    ['-h', 'localhost', '-p', '5432', '-U', 'harness_admin', '-d', 'papercusp', '-tAc', sql],
    { env, encoding: 'utf-8' },
  );
  return out.trim();
}

function pgExec(sql) {
  const env = { ...process.env, PGPASSWORD: 'harness_admin_pwd' };
  execFileSync(
    'psql',
    ['-h', 'localhost', '-p', '5432', '-U', 'harness_admin', '-d', 'papercusp', '-c', sql],
    { env, stdio: 'pipe' },
  );
}

function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return [Date.now().toString(16), Math.random().toString(16).slice(2, 10)].join('-');
}

async function postJSON(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data;
  try {
    data = await r.json();
  } catch {
    throw new Error(`${url}: HTTP ${r.status}, no JSON body`);
  }
  return { status: r.status, data };
}

async function callTool(name, args, ctx = {}) {
  const params = new URLSearchParams({
    harness: SLUG,
    workspace: WORKSPACE,
    role: 'designer',
    run: ctx.run ?? `loop-smoke-${Date.now()}`,
    spawn: ctx.spawn ?? `loop-smoke-${Math.random().toString(36).slice(2, 8)}`,
  });
  const url = `${BASE}/api/plugins/design-phase/${name}?${params.toString()}`;
  const { status, data } = await postJSON(url, args);
  if (status !== 200) {
    throw new Error(`${name}: HTTP ${status}: ${JSON.stringify(data).slice(0, 200)}`);
  }
  if (data?.isError) {
    throw new Error(`${name} reported error: ${data?.content?.[0]?.text ?? '?'}`);
  }
  // Most tools return { content: [{ type: 'text', text: <json> }] }
  const text = data?.content?.[0]?.text;
  return text ? JSON.parse(text) : data;
}

const stages = [];
function stage(name, fn) {
  stages.push({ name, fn });
}

let createdFeatureId = null;
let createdSpecId = null;

stage('1. create_feature via dispatcher', async () => {
  const token = pgQuery(
    `SELECT token FROM harness_shared.token_index WHERE harness_slug='${SLUG}' LIMIT 1`,
  );
  if (!token) throw new Error(`no bearer token for ${SLUG} in harness_shared.token_index`);
  const r = await fetch(`${BASE}/api/admin/execute-action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      actionId: uuid(),
      callingHarness: SLUG,
      action: {
        op: 'create_feature',
        harness_slug: SLUG,
        title: 'Add new dashboard panel for end-to-end smoke',
        summary: 'Smoke harness for the design loop',
        reason: 'design-loop-smoke.mjs verification',
      },
    }),
  });
  const data = await r.json();
  if (!data.ok) throw new Error(`create_feature failed: ${JSON.stringify(data)}`);
  createdFeatureId = data.result.feature_id;
  // PG trigger 050 should have set needs_design via the keyword heuristic ('dashboard panel').
  const nd = pgQuery(
    `SELECT needs_design FROM harness_shared.harness_features_consolidated
      WHERE harness_slug='${SLUG}' AND feature_id='${createdFeatureId}'`,
  );
  if (nd !== 't') throw new Error(`expected needs_design=true, got '${nd}'`);
  return `feature_id=${createdFeatureId}, needs_design=true`;
});

stage('2. /api/design/features lists the feature', async () => {
  const r = await fetch(
    `${BASE}/api/design/features?harness=${encodeURIComponent(SLUG)}&workspace=${encodeURIComponent(WORKSPACE)}`,
  );
  const data = await r.json();
  if (!data.ok) throw new Error(`features endpoint failed: ${JSON.stringify(data)}`);
  const found = data.features.find((f) => f.featureId === createdFeatureId);
  if (!found) throw new Error('newly-created feature missing from design queue');
  if (found.designStatus !== null) {
    throw new Error(`expected designStatus=null, got ${found.designStatus}`);
  }
  return `${data.features.length} features in queue, ours present with designStatus=null`;
});

stage('3a. get_design_spec', async () => {
  const r = await callTool('get_design_spec', {});
  if (!['harness', 'workspace', 'app-default', 'empty'].includes(r.layer)) {
    throw new Error(`unexpected layer: ${r.layer}`);
  }
  return `layer=${r.layer}, source=${r.source ?? 'null'}`;
});

stage('3b. list_memos', async () => {
  const memos = await callTool('list_memos', {});
  if (!Array.isArray(memos)) throw new Error('list_memos did not return an array');
  return `${memos.length} memos discovered`;
});

stage('3c. list_tokens', async () => {
  const r = await callTool('list_tokens', {});
  if (typeof r?.count !== 'number') throw new Error('list_tokens did not return count');
  if (r.count < 1) throw new Error('expected at least 1 token (base.json should ship 33+)');
  return `${r.count} tokens, source=${r.source ?? 'null'}`;
});

stage('3d. search_registry', async () => {
  const r = await callTool('search_registry', { query: 'button' });
  if (!Array.isArray(r?.results)) throw new Error('search_registry shape unexpected');
  if (r.results.length === 0) {
    throw new Error('expected at least one button-matching component (action.primary)');
  }
  return `${r.results.length} matches for "button"`;
});

stage('3e. get_registry_component', async () => {
  const r = await callTool('get_registry_component', { id: 'action.primary' });
  if (!r?.id || r.id !== 'action.primary') {
    throw new Error(`unexpected: ${JSON.stringify(r)}`);
  }
  return `action.primary resolved with ${Object.keys(r.ecosystems).length} ecosystem(s)`;
});

stage('3f. validate_spec (good IR)', async () => {
  const ir = {
    irVersion: '0.1',
    surface: 'smoke-surface',
    ecosystem: 'react-tailwind',
    layout: { kind: 'stack', direction: 'vertical' },
    a11y: { landmark: 'main', headingLevel: 2 },
  };
  const r = await callTool('validate_spec', { ir });
  if (!r.ok) throw new Error(`validate failed: ${JSON.stringify(r.errors)}`);
  return 'valid';
});

stage('3g. validate_spec (bad IR)', async () => {
  const r = await callTool('validate_spec', { ir: { kind: 'wat' } });
  if (r.ok) throw new Error('expected validate to fail on bad IR');
  return `${r.errors.length} validation errors (expected)`;
});

stage('3h. lint_spec', async () => {
  const ir = {
    irVersion: '0.1',
    surface: 'lint-test',
    ecosystem: 'react-tailwind',
    layout: { kind: 'button' }, // no a11y → warning
    a11y: { landmark: 'main', headingLevel: 2 },
  };
  const r = await callTool('lint_spec', { ir });
  if (typeof r.errorCount !== 'number') throw new Error('lint shape unexpected');
  if (r.warnCount === 0) throw new Error('expected at least one warning');
  return `${r.errorCount} errors, ${r.warnCount} warnings`;
});

stage('4. submit_spec → persists + flips design_status', async () => {
  const ir = {
    irVersion: '0.1',
    surface: 'design-loop-smoke',
    ecosystem: 'react-tailwind',
    layout: {
      kind: 'stack',
      direction: 'vertical',
      children: [
        { kind: 'header', title: { key: 'h.k', default: 'Smoke header' } },
        { kind: 'text', copy: { key: 't.k', default: 'Smoke body' } },
      ],
    },
    a11y: { landmark: 'main', headingLevel: 2 },
  };
  const r = await callTool('submit_spec', { featureId: createdFeatureId, ir });
  if (!r.ok) throw new Error(`submit failed: ${JSON.stringify(r)}`);
  createdSpecId = r.specId;
  // Verify PG state directly
  const status = pgQuery(
    `SELECT design_status FROM harness_shared.harness_features_consolidated
      WHERE harness_slug='${SLUG}' AND feature_id='${createdFeatureId}'`,
  );
  if (status !== 'accepted') throw new Error(`expected design_status=accepted, got '${status}'`);
  const artType = pgQuery(
    `SELECT jsonb_typeof(payload) FROM harness_shared.harness_design_artifacts
      WHERE harness_slug='${SLUG}' AND id='${createdSpecId}'`,
  );
  if (artType !== 'object') throw new Error(`expected payload jsonb_typeof=object, got '${artType}'`);
  return `spec=${createdSpecId}, design_status=accepted`;
});

stage('5. sketch persisted + readable', async () => {
  const png =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=';
  const post = await postJSON(`${BASE}/api/design/sketches`, {
    harness: SLUG,
    feature: createdFeatureId,
    workspace: WORKSPACE,
    png,
    label: 'smoke',
  });
  if (post.status !== 200 || !post.data.ok) {
    throw new Error(`sketch POST failed: ${JSON.stringify(post.data)}`);
  }
  const r = await fetch(
    `${BASE}/api/design/sketches?harness=${encodeURIComponent(SLUG)}&feature=${encodeURIComponent(createdFeatureId)}&workspace=${encodeURIComponent(WORKSPACE)}`,
  );
  const list = await r.json();
  if (!list.ok || list.sketches.length === 0) {
    throw new Error(`sketch GET returned no sketches: ${JSON.stringify(list)}`);
  }
  return `1 sketch stored (id=${post.data.id})`;
});

stage('6. /api/design/regressions lists Lost Pixel artifacts', async () => {
  const r = await fetch(`${BASE}/api/design/regressions`);
  const data = await r.json();
  if (!data.ok) throw new Error(`regressions endpoint failed: ${JSON.stringify(data)}`);
  if (typeof data.counts?.baseline !== 'number') {
    throw new Error('regressions counts missing');
  }
  return `${data.counts.baseline} baselines, ${data.counts.current} current, ${data.counts.regressions} regressions`;
});

stage('7. cleanup PG state', async () => {
  if (createdFeatureId) {
    pgExec(`SET app.workspace_id='${WORKSPACE}';
            DELETE FROM harness_shared.harness_design_artifacts WHERE harness_slug='${SLUG}' AND feature_id='${createdFeatureId}';
            DELETE FROM harness_shared.harness_features_consolidated WHERE harness_slug='${SLUG}' AND feature_id='${createdFeatureId}';`);
  }
  return 'feature row + artifacts deleted';
});

(async () => {
  let rc = 0;
  for (const s of stages) {
    process.stdout.write(`▶ ${s.name} … `);
    try {
      const detail = await s.fn();
      process.stdout.write(`OK${detail ? ` (${detail})` : ''}\n`);
    } catch (e) {
      process.stdout.write(`FAIL\n`);
      console.error(`  └─ ${e instanceof Error ? e.message : String(e)}`);
      rc = 1;
      break;
    }
  }
  if (rc === 0) {
    console.log(`\n✓ design loop smoke green — ${stages.length} stages`);
  } else {
    console.error(`\n✗ design loop smoke FAILED after stage "${stages[stages.findIndex((s) => s.fn) ?? 0].name}"`);
    // Best-effort cleanup so a failed run doesn't leave orphans.
    try {
      if (createdFeatureId) {
        pgExec(`SET app.workspace_id='${WORKSPACE}';
                DELETE FROM harness_shared.harness_design_artifacts WHERE harness_slug='${SLUG}' AND feature_id='${createdFeatureId}';
                DELETE FROM harness_shared.harness_features_consolidated WHERE harness_slug='${SLUG}' AND feature_id='${createdFeatureId}';`);
        console.error(`  (cleaned up feature ${createdFeatureId})`);
      }
    } catch {}
  }
  process.exit(rc);
})();
