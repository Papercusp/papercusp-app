#!/usr/bin/env node
// Build any @papercusp/* workspace whose RUNTIME entry point (main / bin /
// exports "require" or "default") names a gitignored dist/ file that does not
// exist yet, before the dev operator starts.
//
// Why: a fresh clone runs `npm ci` and then `npm run dev`. @papercusp/sse sends
// `require`/`default` to ./dist/index.js, which is gitignored and produced only
// by its own build script. tsx's CJS resolution takes that condition, so the
// operator crash-looped with "Cannot find module .../sse/dist/index.js" on a
// clean machine (open-source-release-2026-09-29 R-18 fresh-VM build). The
// release pipeline already builds these explicitly (RUNTIME_BUILD_WORKSPACES in
// build-desktop-sidecar.sh); this derives the same set from package.json
// instead of keeping a second hand-written list, so a new such workspace is
// covered on its own.
//
// Idempotent: a workspace whose runtime targets all exist is left untouched, so
// on a warm tree this is a no-op and never rewrites a dist/ a live process uses.
//
// Usage: node ensure-runtime-workspace-builds.mjs <repo-root> [--check]
//   --check  report what would be built and exit 1 if anything is missing.

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RUNTIME_CONDITIONS = new Set(['require', 'default', 'node']);

/** Collect runtime entry targets (never "types"/"import") from a package.json. */
export function runtimeTargets(pkg) {
  const out = new Set();
  const add = (v) => {
    if (typeof v === 'string') out.add(v.replace(/^\.\//, ''));
  };
  add(pkg.main);
  if (typeof pkg.bin === 'string') add(pkg.bin);
  else if (pkg.bin && typeof pkg.bin === 'object') Object.values(pkg.bin).forEach(add);
  const walk = (node) => {
    if (typeof node === 'string') return add(node);
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith('.')) walk(value); // subpath
      else if (RUNTIME_CONDITIONS.has(key)) walk(value);
    }
  };
  if (typeof pkg.exports === 'string') add(pkg.exports);
  else walk(pkg.exports);
  return [...out].filter((t) => !t.includes('*'));
}

/** Workspaces under node_modules/@papercusp whose dist/ runtime targets are missing. */
export function findMissingRuntimeBuilds(root) {
  const scope = join(root, 'node_modules', '@papercusp');
  if (!existsSync(scope)) return [];
  const missing = [];
  for (const entry of readdirSync(scope).sort()) {
    let dir;
    try {
      dir = realpathSync(join(scope, entry));
    } catch {
      continue;
    }
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    const absent = runtimeTargets(pkg)
      .filter((t) => t.startsWith('dist/'))
      .filter((t) => !existsSync(join(dir, t)));
    if (absent.length === 0) continue;
    missing.push({
      name: pkg.name ?? `@papercusp/${entry}`,
      dir: relative(root, dir) || '.',
      absent,
      buildable: Boolean(pkg.scripts?.build),
    });
  }
  return missing;
}

function main(argv) {
  const root = argv[0];
  const checkOnly = argv.includes('--check');
  if (!root || !existsSync(root)) {
    console.error(`[runtime-builds] FATAL: pass the repository root (got ${root ?? '<none>'})`);
    return 2;
  }
  // A root without installed workspaces (e.g. a frozen verifier snapshot that
  // runs a pre-bundled host) has nothing to build: findMissing returns [].
  const missing = findMissingRuntimeBuilds(root);
  if (missing.length === 0) return 0;
  for (const m of missing) {
    console.error(`[runtime-builds] ${m.name} (${m.dir}) is missing ${m.absent.join(', ')}`);
  }
  if (checkOnly) return 1;
  for (const m of missing) {
    if (!m.buildable) {
      console.error(`[runtime-builds] FATAL: ${m.name} has no build script to produce ${m.absent[0]}`);
      return 1;
    }
    console.error(`[runtime-builds] building ${m.name} (npm --workspace ${m.name} run build)`);
    const r = spawnSync('npm', ['--workspace', m.name, 'run', 'build'], { cwd: root, stdio: 'inherit' });
    if (r.status !== 0) {
      console.error(`[runtime-builds] FATAL: build of ${m.name} exited ${r.status ?? r.signal}`);
      return 1;
    }
  }
  const still = findMissingRuntimeBuilds(root).filter((m) => missing.some((x) => x.name === m.name));
  if (still.length) {
    console.error(`[runtime-builds] FATAL: still missing after build: ${still.map((m) => m.name).join(', ')}`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
