#!/usr/bin/env node
/**
 * Deterministic FAKE agent for the WAKE-MODE E2E (hive-loop-e2e-testing-2026-06-10
 * P-006) — zero LLM spend, autoloop-convergent.
 *
 * Differs from `fake-agent.mjs` in exactly one load-bearing way: the VALIDATOR
 * records its verdict in PG (`harness_features_consolidated.status = 'passed'`),
 * the way the real validator does through its tools. The orchestrator's dispatch
 * frontier reads feature status from PG, not agent stdout — with the autoloop ON,
 * a validator that only prints `[PASS]` leaves the feature in the needs-work set
 * and the orchestrator re-dispatches it forever (the fixture artifact the gym
 * README documents). This is the README's suggested refinement, applied where it
 * is REQUIRED for convergence rather than merely nice.
 *
 * Same invoke contract as fake-agent.mjs: reads ROLE / EXTRAS_JSON / PROJECT_DIR /
 * IDEMPOTENCY_KEY from env, writes a decision to stdout, exits 0. The PG DSN comes
 * from PAPERCUSP_DATABASE_URL (pinned to the gym PG by the boot-spec and mirrored
 * into the agent env by harness-invoke-once).
 *
 *   director  → turn 0: NEXT_WORKER <FEAT>, turn 1: NEXT_VALIDATOR <FEAT>, turn ≥2: DONE
 *   worker    → make a real change + git commit in PROJECT_DIR, print done
 *   validator → UPDATE feature status → 'passed' in PG, then print [PASS]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const role = process.env.ROLE || '';
const projectDir = process.env.PROJECT_DIR || process.cwd();
const featureId = (() => {
  try {
    const extras = JSON.parse(process.env.EXTRAS_JSON || '[]');
    for (const kv of extras) {
      const m = /^FEATURE_ID=(.+)$/.exec(kv);
      if (m) return m[1];
    }
  } catch {
    /* ignore */
  }
  return process.env.FEATURE_ID || '';
})();

function directorTurn() {
  // Prefer the idempotency-key turn suffix (`…:t<N>` — present on pipeline
  // invokes); else a per-project counter file (standalone blueprint-run fires).
  const m = /:t(\d+)$/.exec(process.env.IDEMPOTENCY_KEY || '');
  if (m) return Number(m[1]);
  const dir = join(projectDir, '.papercusp');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const f = join(dir, '.wake-fake-director-turn');
  const n = existsSync(f) ? Number(readFileSync(f, 'utf8').trim()) || 0 : 0;
  writeFileSync(f, String(n + 1));
  return n;
}

function out(line) {
  process.stdout.write(line + '\n');
}

if (role === 'director' || role === 'orchestrator') {
  const t = directorTurn();
  const fid = featureId || 'F-1';
  if (t === 0) out(`NEXT_WORKER ${fid}`);
  else if (t === 1) out(`NEXT_VALIDATOR ${fid}`);
  else out('DONE');
} else if (role === 'worker') {
  try {
    const safeName = (featureId || 'F-1').replace(/[^A-Za-z0-9_.-]/g, '_');
    const marker = join(projectDir, `WAKE_FAKE_WORK_${safeName}.md`);
    appendFileSync(marker, `fake worker change for ${featureId}\n`);
    execFileSync('git', ['add', '-A'], { cwd: projectDir, stdio: 'ignore' });
    execFileSync(
      'git',
      ['-c', 'user.email=gym@local', '-c', 'user.name=gym', 'commit', '-m', `feat(${featureId}): fake worker change`, '--no-verify'],
      { cwd: projectDir, stdio: 'ignore' },
    );
    out(`WORKER committed ${featureId}`);
  } catch (e) {
    out(`WORKER error ${String(e)}`);
  }
} else if (role === 'validator') {
  // The real validator records its verdict in PG; mirror that so the autoloop's
  // frontier sees the feature leave the needs-work set and the loop CONVERGES.
  const dsn = process.env.PAPERCUSP_DATABASE_URL || process.env.DATABASE_URL || '';
  if (dsn && featureId) {
    const { default: postgres } = await import('postgres');
    const sql = postgres(dsn, { max: 1, prepare: false, onnotice: () => {} });
    try {
      await sql`
        UPDATE harness_shared.harness_features_consolidated
           SET status = 'passed', updated_ts = ${Date.now()}
         WHERE feature_id = ${featureId} AND status <> 'passed'`;
    } finally {
      await sql.end({ timeout: 5 }).catch(() => {});
    }
  }
  out(`[PASS] ${featureId}`);
} else {
  // Any other role (curator/documenter/…): no-op terminal-ish output.
  out('DONE');
}
