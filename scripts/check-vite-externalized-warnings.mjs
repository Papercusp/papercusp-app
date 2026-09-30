#!/usr/bin/env node
/**
 * check-vite-externalized-warnings.mjs — fail-loud guard against NEW server-module
 * leaks into the operator-vite SPA bundle (EI-7275).
 *
 * A `vite build` warning "Module node:* has been externalized for browser
 * compatibility" means the browser bundle references a Node-only module. The
 * externalized stub THROWS on property ACCESS at module-eval time — so whichever
 * route first evaluates one blanks the ENTIRE app. That exact failure shipped on
 * 2026-07-04 (tooldef's `run-script.ts` statically imported `node:worker_threads`;
 * every SPA route rendered a white page). `browser-safe-barrel.test.ts` now pins
 * that one lib's own source, but nothing guarded the SPA's whole entry graph —
 * a new leak anywhere else in the ~600-file import graph went undetected.
 *
 * This is the SAME ratchet-only-down pattern as lint:tsc / KNOWN_DARK_FLAGS: a
 * committed baseline COUNT (apps/operator-vite/.externalized-warnings-baseline.json)
 * that gates NEW warnings above it, but a bare run below baseline is check-only
 * (never silently locks in — the count can be affected by which optional deps are
 * installed) and only `--update` lowers it deliberately.
 *
 * Not every warning is a live blank-page risk (many are third-party deps like
 * `pg`/`undici` reached only through server-only code paths that never actually
 * evaluate at runtime in the browser) — but the SPA entry graph reaching them at
 * all, growing without anyone noticing, is exactly the erosion this guards
 * against; shrinking the count is always a legitimate goal even when a given
 * warning isn't provably reachable today.
 *
 * Usage:
 *   npm run lint:vite-externalized              # Check against baseline
 *   npm run lint:vite-externalized -- --update   # Explicitly lower the baseline
 *
 * Exit codes:
 *   0 — OK (at or below baseline; below-baseline only locks in with --update)
 *   1 — new warnings above baseline, or the build itself failed
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = resolve(ROOT, 'apps/operator-vite');
const baselineFile = resolve(APP_DIR, '.externalized-warnings-baseline.json');

const EXTERNALIZED_RE = /Module ["'][^"']+["'] has been externalized for browser compatibility/g;

/** Count "externalized for browser compatibility" warnings in a vite build's combined output. */
export function countExternalizedWarnings(buildOutput) {
  return (String(buildOutput).match(EXTERNALIZED_RE) ?? []).length;
}

/**
 * Pure gate decision (mirrors lint-tsc.mjs decide() — EI-104's --update-only ratchet
 * policy, unit-testable in isolation).
 * @returns {{ verdict: 'fail-exceeds'|'ok-ratchet'|'ok-below'|'ok', newBaseline?: number, belowBy?: number }}
 */
export function decide({ warningCount, baselineCount, updateFlag = false }) {
  if (warningCount > baselineCount) return { verdict: 'fail-exceeds' };
  if (warningCount < baselineCount) {
    return updateFlag
      ? { verdict: 'ok-ratchet', newBaseline: warningCount }
      : { verdict: 'ok-below', belowBy: baselineCount - warningCount };
  }
  return { verdict: 'ok' };
}

function readBaseline() {
  const json = JSON.parse(readFileSync(baselineFile, 'utf-8'));
  return json.count;
}

function writeBaseline(count, note) {
  writeFileSync(
    baselineFile,
    JSON.stringify(
      {
        count,
        _comment:
          'RATCHET-ONLY-DOWN (see scripts/check-vite-externalized-warnings.mjs). ' +
          'Raising this is a deliberate hand-edit with a justification, never an automatic write.',
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`Baseline updated → ${count} (${note})`);
}

function main() {
  const updateFlag = process.argv.includes('--update');

  const baselineCount = readBaseline();

  const result = spawnSync('npx', ['vite', 'build'], {
    cwd: APP_DIR,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

  if (result.status !== 0) {
    // The build itself failed — never treat that as "0 warnings" (would auto-ratchet
    // the baseline to 0 and mask everything the next time the build recovers).
    console.error('❌ vite build failed — toolchain/build failure, not a clean run.');
    console.error(combined.slice(-4000));
    process.exit(1);
  }

  const warningCount = countExternalizedWarnings(combined);
  const decision = decide({ warningCount, baselineCount, updateFlag });

  switch (decision.verdict) {
    case 'fail-exceeds':
      console.error(`❌ Externalized-module warning count exceeded baseline by ${warningCount - baselineCount}.`);
      console.error(`   Current: ${warningCount}, Baseline: ${baselineCount}`);
      console.error(
        '   A new server-only import (node:*, pg, hyperbee/corestore/…) reached the SPA entry graph. ' +
          'Load it lazily (`await import(...)` inside the function that needs it), mark the import ' +
          '`import type`, or add a browser shim (see apps/operator-vite/vite.config.ts resolve.alias) ' +
          'instead of raising this baseline — raising it is a hand-edit of ' +
          `${baselineFile} with a justification.`,
      );
      console.error(
        '   To ATTRIBUTE the reach — which client src module and import chain is responsible, and ' +
          'whether it is an EAGER eval-time white-page risk vs a benign lazy chunk — run ' +
          '`npm run trace:vite-externalized` (scripts/trace-vite-externalized.mjs, WI-4518).',
      );
      process.exit(1);
      break;
    case 'ok-ratchet':
      writeBaseline(decision.newBaseline, 'ratcheted down (--update)');
      process.exit(0);
      break;
    case 'ok-below':
      console.log(
        `✓ ${decision.belowBy} under baseline (${warningCount} < ${baselineCount}) — NOT locked in. ` +
          'A bare run never rewrites the baseline; run `npm run lint:vite-externalized -- --update` ' +
          'on a quiet tree to lower it deliberately.',
      );
      process.exit(0);
      break;
    default:
      if (updateFlag) console.log('✓ --update: count equals baseline — nothing to lower.');
      console.log(`✓ Externalized-module warning count is at baseline (${warningCount})`);
      process.exit(0);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
