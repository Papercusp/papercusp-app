#!/usr/bin/env node
/**
 * check-no-eager-execfile-promisify.mjs — fail-loud guard against a NEW eager
 * `const x = promisify(execFile)` (or `execFileCb`/aliased-import variants) at
 * MODULE SCOPE (EI-10161).
 *
 * The landmine: a test file that narrowly `vi.mock('node:child_process', () => ({
 * spawn }))` for its OWN subprocess assertions can be reached — via an arbitrarily
 * long transitive import chain — by a module that eagerly does `promisify(execFile)`
 * at the top level. Under that mock `execFile` resolves to `undefined`, and
 * `promisify(undefined)` THROWS at module-eval time, crashing the ENTIRE test file
 * (0 tests run) even though the test never calls anything that needs execFile.
 * Confirmed live in packages/operator-core/lib/harness/improvements/watchdog.ts
 * (EI-8718) — reached via release-actions.test.ts → blueprint-run-action →
 * blueprint-steps/index → ops/red-queen-drill → red-queen/run → red-queen/sandbox.
 *
 * FIX: defer the promisify call to first actual invocation, memoized — the exact
 * pattern watchdog.ts now uses (see its `execFileP` wrapper + the comment above it):
 *
 *   type ExecFileP = (file: string, args: string[], opts: Record<string, unknown>) =>
 *     Promise<{ stdout: string; stderr: string }>;
 *   let cached: ExecFileP | null = null;
 *   function execFileP(file: string, args: string[], opts: Record<string, unknown>) {
 *     if (!cached) cached = promisify(execFile) as unknown as ExecFileP;
 *     return cached(file, args, opts);
 *   }
 *
 * A transitive importer that never actually CALLS execFileP never pays the cost —
 * only a test that exercises the function needs to mock execFile too.
 *
 * Detection is deliberately narrow: a top-of-line (column 0 — i.e. MODULE scope,
 * not inside a function/block, which is always indented in this codebase's style)
 * `const`/`let` assignment whose RHS is `promisify(execFile...)`. A promisify call
 * already inside a function body (lazy — even if unmemoized) is NOT what crashes at
 * import time, so it is intentionally not flagged here.
 *
 *   node scripts/check-no-eager-execfile-promisify.mjs
 *
 * BASELINE (TEMPORARY — must shrink to EMPTY): the ~60 pre-existing files this guard
 * was seeded with (EI-10161) pending a follow-up remediation pass (per-file lazy-wrap,
 * or adopt a shared lazy helper). NEW files may NOT be added here — a fresh eager
 * promisify(execFile) is a hard guard failure, not a BASELINE addition.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { describeUnscanned, listTrackedFiles } from './lib/tracked-files.mjs';
import { stripCommentsAndStrings } from './lib/strip-comments-and-strings.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

export const isExcluded = (f) =>
  f.startsWith('_retired/') ||
  f.includes('/_retired/') ||
  f.includes('/node_modules/') ||
  f.includes('/dist/') ||
  f.includes('/dist-sidecar/') ||
  f.includes('/.next/') ||
  f.includes('/build/') ||
  f.includes('/spa/assets/') ||
  f.includes('/env-sidecars/') ||
  /\.(test|spec)\.[cm]?[tj]sx?$/.test(f) ||
  !/\.(ts|mjs|cjs)$/.test(f);

// Comment + string-literal stripping lives in ./lib/strip-comments-and-strings.mjs — ONE
// shared implementation (EI-19991116787260658). The local comments-only copy this replaced
// left string literals intact, so `promisify(execFile)` quoted in PROSE inside a string
// read as a real module-scope call and minted a phantom offender.

/** The tell: a column-0 (module-scope) `const`/`let` assigned from `promisify(execFile...)`. */
export function usesEagerExecFilePromisify(text, fileName) {
  // Raw-text pre-filter (WI-10005282). It is SOUND: the stripper only blanks characters in
  // place (offset-preserving), so it cannot create a `promisify(` the raw text lacks. A file
  // without one cannot match, and skipping it avoids the stripper's per-file parse, which
  // made a whole-tree scan cost ~5.7 s. That cost matters because affected-tests.mjs now
  // runs this guard on every gate pass that touches a scanned file.
  if (!text.includes('promisify(')) return false;
  return /^(export\s+)?(const|let)\s+\w+\s*=\s*promisify\(\s*execFile\w*\s*\)/m.test(
    stripCommentsAndStrings(text, fileName),
  );
}

// BASELINE seeded 2026-07-18 (EI-10161) — 61 files. Do NOT add new entries; each
// removal (lazy-wrap the site, per watchdog.ts's pattern) shrinks this set.
export const BASELINE = new Set([
  'apps/operator/lib/release/git-ops.ts',
  'libs/generic/resource-profile/src/index.ts',
  'packages/operator-core/lib/agent-bin-detect.ts',
  'packages/operator-core/lib/agent-tools/deploys/vintage.ts',
  'packages/operator-core/lib/agent-tools/dev/systemd-service-probe.ts',
  'packages/operator-core/lib/agent-tools/git_sync/run.ts',
  'packages/operator-core/lib/agent-tools/plans/git-history.ts',
  'packages/operator-core/lib/agent-tools/setup/set_git_identity.ts',
  'packages/operator-core/lib/blueprint/commit-reproject-real.ts',
  'packages/operator-core/lib/change-ledger/scan-loop.ts',
  'packages/operator-core/lib/dbos/orchestrator-runner.ts',
  'packages/operator-core/lib/deployment/runtime-pack.ts',
  'packages/operator-core/lib/desktop-install/omp-integration.ts',
  'packages/operator-core/lib/desktop-install/papercusp-files.ts',
  'packages/operator-core/lib/desktop-window-liveness.ts',
  'packages/operator-core/lib/dev-deploy-state.ts',
  'packages/operator-core/lib/endpoint-route/routes/desktop/git-identity.ts',
  'packages/operator-core/lib/endpoint-route/routes/desktop/preflight.ts',
  'packages/operator-core/lib/endpoint-route/routes/desktop/setup-status.ts',
  'packages/operator-core/lib/endpoint-route/routes/harness/feature-views.ts',
  'packages/operator-core/lib/endpoint-route/routes/harness/git.ts',
  'packages/operator-core/lib/endpoint-route/routes/harness/notes-diff.ts',
  'packages/operator-core/lib/endpoint-route/routes/harness/prs.ts',
  'packages/operator-core/lib/endpoint-route/routes/harness/sync.ts',
  'packages/operator-core/lib/execute-action.ts',
  'packages/operator-core/lib/external-bench/clone.ts',
  'packages/operator-core/lib/external-bench/gaia-backlog-support.ts',
  'packages/operator-core/lib/external-bench/native-harness-live.ts',
  'packages/operator-core/lib/external-bench/reproducibility/prereg.ts',
  'packages/operator-core/lib/external-bench/_xbench_bee_probe.ts',
  'packages/operator-core/lib/git-pipeline-position.ts',
  'packages/operator-core/lib/gym/ab-runner-real.ts',
  'packages/operator-core/lib/gym/gym-pg-orphan-sweep.ts',
  'packages/operator-core/lib/gym/runner-ports.ts',
  'packages/operator-core/lib/harness/auto-rebase.ts',
  'packages/operator-core/lib/harness/clone-github.ts',
  'packages/operator-core/lib/harness-fs-watcher.ts',
  'packages/operator-core/lib/harness/hive-repo-init.ts',
  'packages/operator-core/lib/harness/improvements/insight-staleness.ts',
  'packages/operator-core/lib/harness/improvements/ship-link.ts',
  'packages/operator-core/lib/harness/init-local-dir.ts',
  'packages/operator-core/lib/harness-insights/github-facts.ts',
  'packages/operator-core/lib/harness/join-steps.ts',
  'packages/operator-core/lib/harness/open-fork-pr.ts',
  'packages/operator-core/lib/harness/upstream-repo-context.ts',
  'packages/operator-core/lib/papercup/papercup-pane-input.ts',
  'packages/operator-core/lib/pot-eval/ground-truth.ts',
  'packages/operator-core/lib/pot-eval/live-ops.ts',
  'packages/operator-core/lib/pot-eval/outcome-metrics.ts',
  'packages/operator-core/lib/pot/soak-report.ts',
  'packages/operator-core/lib/preflight-binaries.ts',
  'packages/operator-core/lib/provisioner/hardware-detect.ts',
  'packages/operator-core/lib/provisioner/llama-binary.ts',
  'packages/operator-core/lib/provisioner/provision.ts',
  'packages/operator-core/lib/provisioner/vllm-container.ts',
  'packages/operator-core/lib/provisioner/weights.ts',
  'packages/operator-core/lib/provisioner/whisper-binary.ts',
  'packages/operator-core/lib/service-health.ts',
  'packages/operator-core/lib/sync/hyperbee/seed-provider-git.ts',
  'packages/operator-core/lib/system-health/compute.ts',
  'packages/operator-core/lib/windows-desktop-windows.ts',
]);

/**
 * Scan the tracked tree for offenders (excludes vendored/tests/non-source + BASELINE).
 *
 * WI-6666: enumerates via the shared `listTrackedFiles` helper, which recurses into
 * submodules. A bare `git ls-files` does NOT — it emits one gitlink entry per
 * submodule — so this guard previously never opened libs/generic/**, libs/papercusp/**,
 * or papercusp-desktop/**. Returns the coverage report so `main` can state what it
 * could not check.
 */
export function findOffenders() {
  const { files: tracked, unscanned } = listTrackedFiles(ROOT);

  const offenders = [];
  for (const f of tracked) {
    if (isExcluded(f)) continue;
    if (BASELINE.has(f)) continue;
    let text;
    try {
      text = readFileSync(new URL(f, `file://${ROOT}`), 'utf8');
    } catch {
      continue;
    }
    if (usesEagerExecFilePromisify(text, f)) offenders.push(f);
  }
  return { offenders, unscanned };
}

function main() {
  const { offenders, unscanned } = findOffenders();
  if (offenders.length === 0) {
    const note = BASELINE.size > 0 ? ` (${BASELINE.size} file(s) still in the shrink-to-empty BASELINE — EI-10161)` : '';
    console.log(`✓ no NEW eager module-scope promisify(execFile...)${note}.` + describeUnscanned(unscanned));
    process.exit(0);
  }
  console.error('✗ NEW eager module-scope promisify(execFile...) call(s):');
  console.error('  A narrow node:child_process mock reaching this module transitively at import time');
  console.error('  will crash the WHOLE test file. Defer the promisify to first call, memoized — see');
  console.error('  packages/operator-core/lib/harness/improvements/watchdog.ts\'s execFileP wrapper.\n');
  for (const o of offenders) console.error('    ' + o);
  console.error(`\n  ${offenders.length} offender(s). See EI-10161.`);
  process.exit(1);
}

const isMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  if (import.meta.url === pathToFileURL(argv1).href) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
})();
if (isMain) {
  main();
}
