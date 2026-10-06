// The papercusp HOST PREFLIGHT for node:test (WI-10005765, residue of WI-10005724 / WI-10005763 —
// plan personal-data-reader-set-labels-2026-10-01, Decision D-012).
//
// `node --test` suites run live-tree code with network and pass neither the raw test router nor
// the vitest-root door. A package that runs them sets `--test-global-setup=<its shim>`, and the
// shim loads THIS module by convention (<monorepo root>/scripts/lib/node-test-host-preflight.mjs)
// when it exists. A standalone clone of the package has no such file and runs no preflight.
//
// node runs a global-setup module ONCE, in the runner process, before any test file starts
// (measured on node 25.9: an `--import` preload runs only in the test-file children). A throw here
// aborts the whole run with exit 7 and no test executed.
import { globSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatNodeTestRestrictedHoldRefusal, runNodeTestRunnerPreflight } from './restricted-hold-preflight.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));

/**
 * The node:test global-setup hook. The runner's own argv after the node options is the test
 * files it was given (relative to its cwd); a pattern the shell left unexpanded is expanded here
 * as node would. An empty list means node's default discovery: the census then judges the
 * checkout alone (runner-loaded holds), not a closure.
 */
export async function globalSetup() {
  await runNodeTestHostPreflight();
}

/**
 * Shared hook body for the live runner and an isolated integration fixture.
 * Production uses REPO_ROOT; the optional root lets the fixture exercise the same
 * node:test hook against a clean temporary checkout instead of the shared worktree.
 */
export async function runNodeTestHostPreflight({ repoRoot = REPO_ROOT } = {}) {
  const files = process.argv
    .slice(1)
    .filter((arg) => !arg.startsWith('-'))
    .flatMap((arg) => (/[*?[{]/.test(arg) ? globSync(arg, { cwd: process.cwd() }) : [arg]));
  const result = runNodeTestRunnerPreflight({ repoRoot, files, env: process.env });
  if (result.verdict === 'refuse') throw new Error(formatNodeTestRestrictedHoldRefusal(result));
  if (result.verdict === 'admit') Object.assign(process.env, result.setEnv);
}
