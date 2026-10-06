#!/usr/bin/env node
/**
 * Bundle the blind-relay daemon for the relay VM (plan public-blind-relay-2026-10-01, P-001).
 *
 * Output (default .papercusp/scratch/relay-build/):
 *   blind-relay-daemon.mjs  — the daemon + relay core, hyperdht and blind-relay left external
 *   package.json            — exactly those two deps, pinned to the versions this tree tests with
 *
 * usage: node scripts/relay/build-relay-daemon.mjs [--out <dir>]
 */
import { build } from 'esbuild';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RUNTIME_DEPS = ['hyperdht', 'blind-relay'];

export function pinnedRuntimeDeps(root = ROOT) {
  return Object.fromEntries(
    RUNTIME_DEPS.map((name) => {
      const pkg = JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8'));
      return [name, pkg.version];
    }),
  );
}

export async function buildRelayDaemon(outDir) {
  mkdirSync(outDir, { recursive: true });
  const outfile = join(outDir, 'blind-relay-daemon.mjs');
  await build({
    entryPoints: [join(ROOT, 'scripts', 'relay', 'blind-relay-daemon.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    external: RUNTIME_DEPS,
    outfile,
    logLevel: 'warning',
  });
  const pkg = { name: 'papercusp-blind-relay', private: true, type: 'module', dependencies: pinnedRuntimeDeps() };
  writeFileSync(join(outDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  return { outfile, packageJson: join(outDir, 'package.json'), dependencies: pkg.dependencies };
}

if (isCliEntry(import.meta.url)) {
  const i = process.argv.indexOf('--out');
  const outDir = resolve(i > 0 && process.argv[i + 1] ? process.argv[i + 1] : join(ROOT, '.papercusp', 'scratch', 'relay-build'));
  const r = await buildRelayDaemon(outDir);
  console.log(JSON.stringify(r));
}
