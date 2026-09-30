#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findIncompleteSubmoduleInstalls, formatProblems } from './lib/submodule-installs.mjs';
import { findShallowGitdirs, formatShallowProblems } from './lib/shallow-gitdirs.mjs';
import {
  DEFAULT_STALE_SWAP_MAX_AGE_MINUTES,
  findStaleSwapLeftovers,
  formatStaleSwapProblems,
} from './lib/stale-swap-leftovers.mjs';
import { findShadowedManagedShims, formatShadowedShimProblems } from './lib/shadowed-managed-shims.mjs';
import { missingPlaywrightBrowsers, browserCachePath } from './ensure-playwright-browsers.mjs';
import { assertCudaProviderAssets } from './install-onnxruntime-node.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let ok = true;
function check(label, fn) {
  try { fn(); console.log(`  ok  ${label}`); }
  catch (e) { ok = false; console.log(`  FAIL ${label} — ${e.message}`); }
}

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function submodulePaths() {
  if (!existsSync('.gitmodules')) return [];
  return sh("git config --file .gitmodules --get-regexp '^submodule\\..*\\.path$'")
    .split('\n')
    .filter(Boolean)
    .map((line) => line.trim().split(/\s+/).slice(1).join(' '))
    .filter(Boolean);
}

function assertSubmoduleWorktreesSane() {
  const paths = submodulePaths();
  if (paths.length === 0) return;

  const statusByPath = new Map(
    sh('git submodule status --recursive')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const status = line[0];
        const rest = line.slice(1).trim();
        const path = rest.split(/\s+/)[1];
        return [path, status];
      }),
  );

  const problems = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const entries = readdirSync(path).filter((entry) => entry !== '.git');
    const status = statusByPath.get(path);
    if ((status === '-' || status === undefined) && entries.length > 0) {
      const onlyNodeModules = entries.length === 1 && entries[0] === 'node_modules';
      problems.push(
        `${path}: uninitialized submodule path is non-empty` +
          (onlyNodeModules ? ' (only node_modules)' : ` (${entries.slice(0, 5).join(', ')})`),
      );
      continue;
    }
    if (status && status !== '-' && entries.length === 0) {
      problems.push(`${path}: initialized submodule has an empty worktree (only .git)`);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `submodule drift detected:\n    ${problems.join('\n    ')}\n` +
        'Run git submodule update --init --recursive; clear droppings-only uninitialized paths first.',
    );
  }
}

console.log('papercup test-doctor\n');
const submodulesOnly = process.argv.includes('--submodules-only');
if (!submodulesOnly) {
  check('docker CLI on PATH', () => execSync('docker --version', { stdio: 'pipe' }));
  check('docker daemon reachable', () => execSync('docker ps', { stdio: 'pipe' }));
  check('node >= 20', () => {
    const major = Number(process.versions.node.split('.')[0]);
    if (major < 20) throw new Error(`have ${process.versions.node}`);
  });
  check('ORT CUDA provider assets match the requested rerank device', () => {
    assertCudaProviderAssets({ repoRoot: REPO_ROOT });
  });
}
check('submodule worktrees sane', assertSubmoduleWorktreesSane);

// Atomic publishers move `<live>` to `<live>.old.<pid>` before replacing it.
// A killed producer can strand gigabytes, but blind reaping is unsafe: WI-6557
// found the only complete desktop sidecar in the backup while the live sibling
// was a tiny placeholder. Detect the shared failure class and show both sides;
// leave the authority/cleanup decision to the operator.
check('no stale atomic-publish swap directories (*.old.<pid>)', () => {
  const configured = process.env.PAPERCUSP_STALE_SWAP_MAX_AGE_MINUTES;
  const maxAgeMinutes = configured === undefined
    ? DEFAULT_STALE_SWAP_MAX_AGE_MINUTES
    : Number(configured);
  const problems = findStaleSwapLeftovers({ repoRoot: REPO_ROOT, maxAgeMinutes });
  if (problems.length > 0) {
    throw new Error(
      `swap backup director${problems.length === 1 ? 'y' : 'ies'} older than ` +
        `${maxAgeMinutes} minute${maxAgeMinutes === 1 ? '' : 's'} detected:\n    ` +
        formatStaleSwapProblems(problems),
    );
  }
});

// A `git fetch --depth=N` against this tree silently converts the target into a SHALLOW
// repository — no error, clean `git status`, nothing for the sweep to show — after which its
// history reads answer WRONG without erroring and it cannot push at all. Measured 2026-08-18:
// four submodules were shallowed by a probe (papercusp-desktop 1595->71 commits) and the
// damage read as an unrelated push blocker. Nothing else in the tree notices this.
check('no shallow gitdirs (superproject or any submodule)', () => {
  const problems = findShallowGitdirs({
    gitCommonDir: resolve(REPO_ROOT, sh('git rev-parse --git-common-dir')),
  });
  if (problems.length > 0) {
    throw new Error(`shallow repositor${problems.length === 1 ? 'y' : 'ies'} detected:\n    ${formatShallowProblems(problems)}`);
  }
});

// A submodule that carries its own package-lock.json is NOT covered by the root
// `npm install` unless it is also a root workspace — and papercusp-desktop is not one.
// That gap is invisible until someone runs a tool from inside the submodule and gets a
// bare "command not found" (WI-39358: `exec: tauri: not found` after the tree was
// re-cloned and only the ROOT install was re-run). Assert the install here so the failure
// names its own cause and fix instead of surfacing as a broken toolchain.
check('submodule installs complete (submodules with their own lockfile)', () => {
  const problems = findIncompleteSubmoduleInstalls({
    repoRoot: REPO_ROOT,
    submodulePaths: submodulePaths(),
  });
  if (problems.length > 0) {
    throw new Error(`submodule dependencies not installed:\n    ${formatProblems(problems)}`);
  }
});

check('Playwright browser cache matches the installed registry', () => {
  const missing = missingPlaywrightBrowsers();
  if (missing.length > 0) {
    throw new Error(`missing browser installation(s): ${missing.join(', ')} (cache: ${browserCachePath()}); run npm run ensure:playwright-browsers`);
  }
});

// ── AGENT-ENV operating-contract invariants (EI-10941) ───────────────────────
// The same facts AGENT-ENV.md documents, asserted as runnable checks so a drift
// (a package-local vitest appearing, the shared-code roots changing, the vite
// alias moving, or the doc going stale) breaks `npm run doctor` instead of a
// future agent's command. The doc is the human-readable projection; these are
// the machine-checked source of the invariants.
const R = (rel) => join(REPO_ROOT, rel);

check('vitest is hoisted to the repo root (node_modules/.bin/vitest exists)', () => {
  if (!existsSync(R('node_modules/.bin/vitest')))
    throw new Error('no hoisted vitest at node_modules/.bin/vitest — run npm install at the repo root');
});

check('the two shared-code roots (libs/ and packages/) both exist', () => {
  const missing = ['libs', 'packages'].filter((r) => !existsSync(R(r)));
  if (missing.length) throw new Error(`missing shared-code root(s): ${missing.join(', ')}`);
});

check('operator-vite @ alias still points at apps/operator (cross-tree import trap)', () => {
  const rel = 'apps/operator-vite/vite.config.ts';
  if (!existsSync(R(rel))) return; // config removed — nothing to assert
  const src = readFileSync(R(rel), 'utf8');
  const decl = src.match(/const\s+operatorRoot\s*=\s*resolve\(\s*import\.meta\.dirname\s*,\s*['"]([^'"]+)['"]/);
  const aliasPresent = /\{\s*find:\s*['"]@['"]\s*,\s*replacement:\s*operatorRoot\s*\}/.test(src);
  if (aliasPresent && decl && decl[1] !== '../operator')
    throw new Error(
      `the @ alias resolves to '${decl[1]}', not '../operator' — update AGENT-ENV.md's cross-tree note (npm run gen:agent-env)`,
    );
});

check('AGENT-ENV.md is not stale (regenerates identically)', () => {
  execSync('npx tsx scripts/gen-agent-env.ts --check', { cwd: REPO_ROOT, stdio: 'pipe' });
});

// WI-10001537: the managed shims in ~/.papercusp/bin are rewritten on every
// boot, which is worth nothing if PATH resolves the NAME somewhere else. A stale
// ~/.local/bin/psu did exactly that for three weeks; because it advertised no
// re-exec loop, psu-launcher wired `onReexec: null` by design and a host
// hand-off became a hard death that killed a live session mid-dialog. Nothing
// detected it, so this is the detector.
check('no unmanaged wrapper shadows a managed ~/.papercusp/bin shim on PATH', () => {
  const problems = findShadowedManagedShims();
  if (problems.length)
    throw new Error(
      `${formatShadowedShimProblems(problems)} — repoint the shadower at the managed shim ` +
        '(a desktop boot heals this automatically via healShadowedManagedShims)',
    );
});

console.log(ok ? '\nAll checks passed.' : '\nSome checks failed — see above.');
process.exit(ok ? 0 : 1);
