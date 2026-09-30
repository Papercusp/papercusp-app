#!/usr/bin/env node
/**
 * Run a workspace's normal Vitest suite, or route explicit test-file requests
 * through the repository's owning-config guard.
 *
 * Workspace `test` scripts are also used for focused re-runs. Calling Vitest
 * directly lets it silently discard a path owned by another workspace when a
 * second path matches, so explicit file requests must use test-files.mjs. With
 * no file request, retain the workspace's ordinary full-suite command.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROUTER = resolve(REPO_ROOT, 'scripts/test-files.mjs');
const TEST_FILE_RE = /(?:^|[\\/])[^\\/]+\.(?:test|spec)\.[cm]?[jt]sx?$/;

export function isVitestTestFileArg(arg) {
  return typeof arg === 'string' && TEST_FILE_RE.test(arg);
}

/**
 * Build the child invocation without running it, keeping the routing decision
 * independently testable. The package script supplies --passWithNoTests as a
 * fixed argument; the router does not need that flag after it has verified the
 * requested file set, so it is removed from routed invocations.
 */
export function workspaceTestInvocation(argv = process.argv.slice(2), repoRoot = REPO_ROOT) {
  // The integration package script uses this same launcher. For explicit files,
  // test-files.mjs chooses each owner's config; a fixed --config would override it.
  const integration = argv.includes('--workspace-integration');
  const args = argv.filter((arg) => arg !== '--workspace-integration');
  const files = args.filter(isVitestTestFileArg);
  if (files.length === 0) {
    return {
      command: 'npx',
      args: ['vitest', 'run', ...(integration ? ['--config', 'vitest.integration.config.ts'] : []), ...args],
      cwd: process.cwd(),
      routed: false,
    };
  }

  const vitestArgs = args.filter((arg) => !isVitestTestFileArg(arg) && arg !== '--passWithNoTests' && arg !== '--');
  return {
    command: process.execPath,
    args: [resolve(repoRoot, 'scripts/test-files.mjs'), ...files, ...(vitestArgs.length ? ['--', ...vitestArgs] : [])],
    cwd: process.cwd(),
    routed: true,
  };
}

export function main(argv = process.argv.slice(2)) {
  const invocation = workspaceTestInvocation(argv);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(`workspace test launcher failed: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
