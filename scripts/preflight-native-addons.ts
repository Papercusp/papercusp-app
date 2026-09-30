#!/usr/bin/env tsx
/**
 * A1 (infra-fail-fast-build-integrity-2026-06-19) — native-addon deploy gate.
 *
 * Run AFTER a green-release install, under the SERVICE's pinned Node, to catch
 * the 2026-06-19 outage class: a native addon (e.g. better-sqlite3) built for a
 * different Node ABI loads at install but FAILS at load on the runtime Node —
 * shipping to green undetected and hanging every memory-touching handler behind
 * a green health check. Exits non-zero on any REQUIRED addon load failure so the
 * promotion fails loud instead of deploying a wedged host.
 *
 * Failing this gate blocks a promotion only; it never touches a live host (that
 * is A2's job, and is deliberately separate + flag-gated).
 *
 * Usage:
 *   tsx scripts/preflight-native-addons.ts [--root <install-dir>] [--quiet]
 *
 *   --root   Install whose binaries to test-load (default: cwd). The loader is
 *            rooted here so the gate checks the TARGET install's addons, not the
 *            repo's.
 *   --quiet  Print only on failure.
 *
 * Required set: better-sqlite3 (override/extend via PAPERCUSP_PREFLIGHT_ADDONS,
 * comma-separated). Everything else that ships a native addon is reported as
 * advisory (loaded via its real entry so alternate-platform prebuilds never
 * false-alarm).
 */
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import {
  checkNativeAddons,
  discoverAddonPackages,
  formatReport,
  requiredAddonsFromEnv,
  shouldSkipAddon,
} from '@papercusp/operator-core/lib/native-addon-preflight';

function parseArgs(argv: string[]): { root: string; quiet: boolean } {
  let root = process.cwd();
  let quiet = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') root = resolve(argv[++i] ?? root);
    else if (argv[i] === '--quiet') quiet = true;
  }
  return { root, quiet };
}

function main(): void {
  const { root, quiet } = parseArgs(process.argv.slice(2));

  // Root the loader at the target install so we test ITS binaries. createRequire
  // anchors resolution at the given path's dir; package.json need not be read.
  const requireFn = createRequire(join(root, 'package.json'));

  const required = requiredAddonsFromEnv();
  const advisory = discoverAddonPackages(join(root, 'node_modules'));

  const report = checkNativeAddons({
    requireFn,
    required,
    advisory,
    skipAdvisory: (name) => shouldSkipAddon(name),
  });

  if (!report.ok || !quiet) {
    console.log(`[preflight-native-addons] root=${root}`);
    console.log(formatReport(report));
  }
  process.exit(report.ok ? 0 : 1);
}

main();
