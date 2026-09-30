/**
 * gen-doc-projections.ts — the umbrella runner for every Starlight projection
 * generator (starlight-projection-generators-2026-06-05 P-006).
 *
 * Runs each `gen-doc-<name>.ts` as its own child process (they side-effect on
 * import + some `process.exit`, so they can't share one process). Honors the
 * gating tier (D-002): a DETERMINISTIC projector that fails (or, under --check,
 * drifts) fails this runner; an ADVISORY one (heavy import / PG-dependent) only
 * warns. This is the local one-shot "regenerate / verify everything".
 *
 *   npm run gen:doc-projections                      # regenerate all five pages
 *   npx tsx scripts/gen-doc-projections.ts --check   # local pre-push sweep
 *
 * ⚠ THE `--check` SWEEP IS A CONVENIENCE, NOT THE GATE, and has no npm alias on
 * purpose (retired 2026-08-12, WI-38239). CI runs each of the five children
 * INDIVIDUALLY at its own tier — the gating TWO fail the build, the advisory
 * three run under `continue-on-error` (.github/workflows/test.yml:194-211) — so
 * an umbrella declaration was a guard-shaped npm script that nothing ran and
 * that could add no coverage, while costing a five-child spawn (including the
 * fleet-fragile full-registry tool-catalog import) on every hop that ran it.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { REPO_ROOT } from './lib/doc-projection';

const CHECK = process.argv.includes('--check');

const PROJECTORS: Array<{ name: string; gating: boolean }> = [
  { name: 'blueprint-catalog', gating: true },
  { name: 'role-registry', gating: true },
  // insights-index is deterministic but its SOURCE churns (the fleet adds
  // insights continuously — it went stale within ~25 min of first generation),
  // so it sits in the advisory tier with the other fleet-churned sources.
  { name: 'insights-index', gating: false },
  { name: 'tool-catalog', gating: false },
  { name: 'plans-index', gating: false },
];

let gatingFailure = false;
for (const p of PROJECTORS) {
  const script = join(REPO_ROOT, 'scripts', `gen-doc-${p.name}.ts`);
  // Per-child hard timeout: a projector that wedges (e.g. a keep-alive handle
  // from a heavy registry import) must never hang the whole umbrella.
  const res = spawnSync('npx', ['tsx', script, ...(CHECK ? ['--check'] : [])], {
    stdio: 'inherit',
    cwd: REPO_ROOT,
    timeout: 240_000,
    killSignal: 'SIGKILL',
  });
  if (res.signal) {
    const msg = `${p.name} timed out / was killed (${res.signal})`;
    if (p.gating) {
      gatingFailure = true;
      process.stderr.write(`✗ ${msg} (gating)\n`);
    } else {
      process.stdout.write(`⚠ ${msg} (advisory — not gating)\n`);
    }
    continue;
  }
  if (res.status !== 0) {
    if (p.gating) {
      gatingFailure = true;
      process.stderr.write(`✗ ${p.name} failed (gating)\n`);
    } else {
      process.stdout.write(`⚠ ${p.name} exited ${res.status ?? '?'} (advisory — not gating)\n`);
    }
  }
}
process.exit(gatingFailure ? 1 : 0);
