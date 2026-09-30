#!/usr/bin/env node
/**
 * GATING guard: the operator-vite CLIENT bundle must not regress into
 * shipping dead server code (EI-13213).
 *
 * WHY: `apps/operator-vite` is a pure-browser SPA, but server-only backend
 * modules can leak into its build graph through a `typeof window` runtime
 * guard — Rolldown's static scan can't see that guard, so it still traces a
 * gated `await import('server-only-module')` and bundles the whole
 * downstream graph. That happened via `commands/defs/delegation.ts`'s
 * `await import('../../delegated-tasks')`: delegated-tasks.ts statically
 * imports `work-items.ts`, which fans out into `dbos/*`, `sync/hyperbee/*`,
 * and the entire ~550-tool `agent-tools/index.ts` catalog — none of it ever
 * reachable from real browser code, all of it shipped anyway (52 MB -> 26 MB
 * minified JS once fixed; see apps/operator-vite/src/shims/delegated-tasks-browser.ts
 * and the vite.config.ts alias next to it).
 *
 * This is the DIRECT detector, same philosophy as check-host-bundle-builds.mjs:
 * run the REAL `vite build` (into a throwaway outDir — the live dist/ is never
 * touched) and assert on what Rolldown itself reports, rather than pattern-
 * matching import specifiers (see operator-core-client-boundary.test.ts,
 * which is a good FIRST layer but only scans apps/operator-vite/src for
 * direct `@papercusp/operator-core/lib/...` specifiers — it can't see a leak
 * that enters through a *relative* import several hops deep inside
 * packages/operator-core, which is exactly how EI-13213 hid). Two checks:
 *
 *   1. Zero `INEFFECTIVE_DYNAMIC_IMPORT` warnings — Rollup names the exact
 *      module and its competing static/dynamic importers when a dynamic
 *      import's split gets defeated by a static edge elsewhere in the graph.
 *   2. The EAGER bundle (entry <script> + every `modulepreload` in the built
 *      index.html — the bytes that execute before first paint, per the
 *      `fcp-server-libs-leak-into-eager-client-bundle` insight doc's own
 *      diagnostic method) stays under a budget with headroom over the
 *      measured baseline, so a future leak is caught long before it repeats
 *      the ~2s FCP regression that motivated that fix.
 *
 * Deliberately does NOT budget total dist size / individual lazy-chunk size —
 * a legitimately huge LAZY feature chunk (the TypeScript compiler, Porcupine
 * wake-word detection) is fine; it costs nothing until that one feature is
 * used. Ineffective-dynamic-import + eager-bundle-size are the two signals
 * that actually distinguish "properly deferred" from "leaked".
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const viteDir = join(repoRoot, 'apps', 'operator-vite');

// Headroom over the measured baseline (2.67 MB as of the EI-13213 fix) — wide
// enough that ordinary feature growth doesn't flake the gate, tight enough
// that a re-leaked multi-MB server module trips it well before it reaches the
// ~14 MB eager bundle that caused the original ~2s FCP regression.
const EAGER_BUDGET_BYTES = 4.5 * 1024 * 1024;

const outDir = mkdtempSync(join(tmpdir(), 'papercusp-bundle-budget-'));
let failed = false;
const problems = [];

try {
  // spawnSync (not execFileSync) so BOTH streams are captured regardless of
  // exit code — Vite/Rolldown's reporter writes its warnings (including
  // INEFFECTIVE_DYNAMIC_IMPORT) to STDERR even on a successful (exit 0)
  // build; execFileSync only returns stdout on success, which silently missed
  // every warning here until caught by the revert-and-rerun sanity check this
  // script's fix was verified with (see EI-13213 completion notes).
  const result = spawnSync(
    'npx',
    ['vite', 'build', '--outDir', outDir, '--emptyOutDir'],
    { cwd: viteDir, encoding: 'utf8', env: process.env, maxBuffer: 64 * 1024 * 1024 },
  );
  const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.status !== 0) {
    failed = true;
    problems.push(
      `operator-vite build FAILED (exit ${result.status ?? result.signal ?? '?'}):\n` +
        combined.split('\n').slice(-40).join('\n'),
    );
  }

  const ineffective = [...combined.matchAll(/\[INEFFECTIVE_DYNAMIC_IMPORT\][^\n]*/g)].map((m) => m[0]);
  if (ineffective.length > 0) {
    failed = true;
    problems.push(
      `${ineffective.length} INEFFECTIVE_DYNAMIC_IMPORT warning(s) — a dynamic import's code-split ` +
        `is being defeated by a competing static import elsewhere in the graph (see this script's ` +
        `header comment + EI-13213):\n` +
        ineffective.map((l) => `  - ${l}`).join('\n'),
    );
  }

  const indexHtml = join(outDir, 'index.html');
  if (!existsSync(indexHtml)) {
    failed = true;
    problems.push(`build did not produce ${indexHtml} — cannot compute the eager bundle size.`);
  } else {
    const html = readFileSync(indexHtml, 'utf8');
    const eagerPaths = new Set(
      [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]),
    );
    let eagerBytes = 0;
    const missing = [];
    for (const p of eagerPaths) {
      const fp = join(outDir, p);
      if (existsSync(fp)) eagerBytes += statSync(fp).size;
      else missing.push(p);
    }
    const eagerMb = (eagerBytes / 1024 / 1024).toFixed(2);
    const budgetMb = (EAGER_BUDGET_BYTES / 1024 / 1024).toFixed(2);
    if (eagerBytes > EAGER_BUDGET_BYTES) {
      failed = true;
      problems.push(
        `eager bundle is ${eagerMb} MB (entry + modulepreload graph in index.html) — over the ` +
          `${budgetMb} MB budget. This is the FCP-critical set (executes before first paint); a ` +
          `budget breach usually means a heavy or server-only module became reachable EAGERLY ` +
          `(not just lazily) from the client entry. Diagnose with the sourcemap-attribution method ` +
          `in the fcp-server-libs-leak-into-eager-client-bundle insight doc.`,
      );
    } else {
      console.log(`✓ eager bundle ${eagerMb} MB (budget ${budgetMb} MB, ${eagerPaths.size} files)`);
    }
    if (missing.length > 0) {
      console.warn(`  (note: ${missing.length} referenced asset(s) not found on disk — index.html/dist mismatch?)`);
    }
  }

  if (!failed) {
    console.log('✓ zero INEFFECTIVE_DYNAMIC_IMPORT warnings');
    console.log('✓ operator-vite client bundle budget OK');
  }
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

if (failed) {
  console.error('\n✗ bundle budget check FAILED:\n');
  for (const p of problems) console.error(`${p}\n`);
  process.exit(1);
}
