#!/usr/bin/env node
/**
 * Deterministic FAKE agent for the GYM-BLUEPRINT cycle assembly check (zero LLM spend).
 *
 * The gym-vocabulary sibling of fake-agent.mjs: slotted in as AGENT_CMD so the real
 * orchestrator/DBOS pipeline runs the `gym` blueprint's spine end-to-end with canned
 * decisions — exercising blueprint-from-disk resolution, the G- work-item binding
 * (EI-35 vocabulary), the gym verb→role dispatch, and the finalize recipe, without a
 * model. Per the invoke contract: reads ROLE / EXTRAS_JSON / PROJECT_DIR from env,
 * writes a DECISION to stdout, exits 0.
 *
 *   gym-director → walks the optimization spine one verb per turn:
 *                  GENERATE_TASKS → RUN_VARIANT → JUDGE → PROPOSE → ACCEPT → DONE
 *   task-generator / variant-runner / judge / proposer / committer → one-line summary
 *
 * Turn is tracked by the `:tN` suffix of IDEMPOTENCY_KEY when present, else a counter
 * file in PROJECT_DIR/.papercusp (same scheme as fake-agent.mjs).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  return process.env.FEATURE_ID || 'G-UNKNOWN';
})();

function directorTurn() {
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

const SPINE = ['GENERATE_TASKS', 'RUN_VARIANT', 'JUDGE', 'PROPOSE', 'ACCEPT'];

if (role === 'gym-director') {
  const t = directorTurn();
  if (t < SPINE.length) out(`${SPINE[t]} ${featureId}`);
  else out('DONE');
} else if (role === 'task-generator') {
  out(`generated 1 train task for ${featureId} (fake)`);
} else if (role === 'variant-runner') {
  out(`ran baseline + 1 candidate × 1 task × 1 repeat for ${featureId}; all cells terminal (fake)`);
} else if (role === 'judge') {
  out(`judged 2 runs for ${featureId}: baseline 7.5, candidate 8.0 (fake)`);
} else if (role === 'proposer') {
  out(`proposed prompts-only edit (researcher) for ${featureId}; rationale: tighten acceptance re-read (fake)`);
} else if (role === 'committer') {
  out(`committed researcher prompt for ${featureId} → fake-content-hash (fake)`);
} else {
  out('DONE');
}
