#!/usr/bin/env node
/**
 * assert-workspace-links.mjs — recurrence guard for EI-12894 (mac release-leg
 * workspace-link drift; the detector that should have caught the 0.0.11 r8 kill).
 *
 * WHY THIS EXISTS: the mac release leg esbuilds @papercusp/operator-core ON a build
 * VM, and esbuild resolves @papercusp/* via the MONOREPO-ROOT node_modules
 * (createRequire walks up). The VM's root node_modules is refreshed by an
 * `npm install` at the root (release-local.sh) but the rsync that stages the tree
 * EXCLUDES node_modules — so it drifts: ANY workspace package added to the monorepo
 * since the VM's last root install has no `node_modules/<name>` link, and esbuild
 * then dies ~35 min deep with a cryptic `Could not resolve "@papercusp/x"` (the
 * 0.0.11 r8 mac-leg kill; @papercusp/kokoro-tts was simply the first to bite). The
 * source is shipped correctly by `git archive HEAD` — only the *link* is missing,
 * which is why it reads as a nonsense "the file is right there" error.
 *
 * This asserts — cheaply, BEFORE the build — that every `workspaces` entry in the
 * shipped root package.json has a corresponding `node_modules/<name>` link, turning
 * a confusing 35-min-late resolve error into an immediate, named, actionable failure.
 *
 *   node scripts/assert-workspace-links.mjs [--root <dir>]
 *
 * Exit 0 = every root workspace is linked. Exit 1 = drift (names each missing
 * package + the fix). Invoked on the VM from papercusp-desktop/bin/mac-vm-build.sh,
 * right after the root `npm install`, before the sidecar esbuild.
 *
 * The detector (`findMissingWorkspaceLinks`) is exported + unit-tested in
 * packages/operator-core/lib/__tests__/assert-workspace-links-guard.test.ts.
 */
import { readFileSync, existsSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Expand root `workspaces` globs to workspace dirs (only those that carry a package.json). */
export function expandWorkspaces(patterns, root) {
  const out = [];
  for (const p of patterns ?? []) {
    if (p.includes('*')) {
      const base = p.replace(/\/\*$/, '');
      if (!existsSync(join(root, base))) continue;
      for (const entry of readdirSync(join(root, base))) {
        const dir = `${base}/${entry}`;
        if (existsSync(join(root, dir, 'package.json'))) out.push(dir);
      }
    } else if (existsSync(join(root, p, 'package.json'))) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Every root-workspace package whose `node_modules/<name>` link is MISSING at `root`.
 * Returns `[{ name, dir }]` sorted by name — empty means no drift.
 *
 * A workspace whose package.json is unreadable, or which has no `name` (npm cannot
 * link a nameless package), is skipped rather than reported. The link check uses
 * `lstat` so a workspace symlink counts as present without following it.
 */
export function findMissingWorkspaceLinks(root) {
  const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const wsDirs = expandWorkspaces(rootPkg.workspaces, root);
  const missing = [];
  for (const dir of wsDirs) {
    let name;
    try {
      name = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')).name;
    } catch {
      continue; // unreadable workspace package.json — not our drift class
    }
    if (!name) continue; // a nameless workspace can't be linked into node_modules
    const linkPath = join(root, 'node_modules', ...name.split('/'));
    let linked = false;
    try {
      lstatSync(linkPath); // symlink (workspace) OR real dir both count as "linked"
      linked = true;
    } catch {
      linked = false;
    }
    if (!linked) missing.push({ name, dir });
  }
  return missing.sort((a, b) => a.name.localeCompare(b.name));
}

function main() {
  let root = DEFAULT_ROOT;
  const i = process.argv.indexOf('--root');
  if (i !== -1 && process.argv[i + 1]) root = resolve(process.argv[i + 1]);

  const missing = findMissingWorkspaceLinks(root);
  if (missing.length === 0) {
    console.log(`✓ workspace-link guard: every root workspace has a node_modules/<name> link (root: ${root}).`);
    process.exit(0);
  }

  console.error('');
  console.error('✗ workspace-link guard FAILED — the root node_modules is STALE (EI-12894 drift):');
  console.error(`    root: ${root}`);
  console.error('  These packages are listed in root `workspaces` but have NO node_modules/<name> link,');
  console.error('  so esbuild (createRequire walks up to the root node_modules) cannot resolve them:');
  console.error('');
  for (const m of missing) console.error(`    ${m.name}  (${m.dir})`);
  console.error('');
  console.error('  Fix: run `npm install --legacy-peer-deps` at the monorepo ROOT so the workspace');
  console.error('  symlinks track the shipped source, THEN re-run the build.');
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
if (isMain) main();
