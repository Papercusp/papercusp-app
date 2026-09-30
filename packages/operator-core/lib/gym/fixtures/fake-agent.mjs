#!/usr/bin/env node
/**
 * Deterministic FAKE agent for the gym's hermetic-runner SMOKE (zero LLM spend).
 *
 * Slotted in as AGENT_CMD so the real orchestrator/DBOS pipeline runs end-to-end with
 * canned decisions — exercising the runner→capture→signals plumbing without a model.
 * Per the invoke contract: reads ROLE / EXTRAS_JSON / PROJECT_DIR from env, ignores the
 * prompt, writes a DECISION to stdout (the orchestrator strips timestamp/backtick noise
 * and takes the last verb), exits 0.
 *
 *   director  → turn 0: NEXT_WORKER <FEAT>, turn 1: NEXT_VALIDATOR <FEAT>, turn ≥2: DONE
 *   worker    → make a real change + git commit in PROJECT_DIR (so there's a diff), print done
 *   validator → [PASS]
 *
 * Turn is tracked by a counter file in PROJECT_DIR/.harness (robust to idempotency-key
 * format); falls back to the `:tN` suffix of IDEMPOTENCY_KEY when present.
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
  return process.env.FEATURE_ID || 'F-GYM-UNKNOWN';
})();

function directorTurn() {
  // Prefer the idempotency-key turn suffix; else a per-project counter file.
  const m = /t(\d+)\b/.exec(process.env.IDEMPOTENCY_KEY || '');
  if (m) return Number(m[1]);
  const dir = join(projectDir, '.papercusp');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const f = join(dir, '.gym-fake-director-turn');
  const n = existsSync(f) ? Number(readFileSync(f, 'utf8').trim()) || 0 : 0;
  writeFileSync(f, String(n + 1));
  return n;
}

function out(line) {
  process.stdout.write(line + '\n');
}

if (role === 'director' || role === 'orchestrator') {
  const t = directorTurn();
  if (t === 0) out(`NEXT_WORKER ${featureId}`);
  else if (t === 1) out(`NEXT_VALIDATOR ${featureId}`);
  else out('DONE');
} else if (role === 'worker') {
  try {
    // featureId is gym-generated, but use execFileSync (no shell) regardless — no injection surface.
    const safeName = featureId.replace(/[^A-Za-z0-9_.-]/g, '_');
    const marker = join(projectDir, `GYM_FAKE_WORK_${safeName}.md`);
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
  out(`[PASS] ${featureId}`);
} else {
  // Any other role (reviewer/documenter/curator/…): no-op terminal-ish output.
  out('DONE');
}
