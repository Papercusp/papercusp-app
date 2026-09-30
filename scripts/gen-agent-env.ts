/**
 * gen-agent-env.ts — regenerate AGENT-ENV.md from the REAL repo config.
 *
 * EI-10941 (corroborates EI-10904): a fresh agent cannot discover how to run
 * tests, where shared code lives, or which tree an alias points at. That
 * knowledge EXISTS — in someone's memory, a carry-note, an insights doc — but is
 * enforced by nothing and taught by no failure message, so it survives only by
 * being hand-carried across compactions. That is the definition of tribal
 * knowledge, and it is why every new agent re-pays the same tax (a package-local
 * `vitest` that is exit-127 DOA; a coin-flip between `libs/` and `packages/`; an
 * `@` alias that silently crosses into another app's tree).
 *
 * The fix is to make the operating contract a DERIVED ARTIFACT, generated from
 * the config it describes, so it cannot drift out of sync with reality the way a
 * hand-written README does. This script reads the actual root package.json, the
 * on-disk workspace layout, the operator-vite alias config, and the test tooling,
 * and emits AGENT-ENV.md. `scripts/test-doctor.mjs` then asserts the same
 * invariants as runnable checks (so a drift breaks `npm run doctor` instead of a
 * future agent), and `--check` here fails CI if the committed doc is stale.
 *
 *   Run:  npx tsx scripts/gen-agent-env.ts          (write AGENT-ENV.md)
 *         npx tsx scripts/gen-agent-env.ts --check   (CI/gate: fail if stale)
 *
 * Determinism: every derived list is sorted, so re-running on unchanged config
 * produces byte-identical output (the --check drift guard depends on this).
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO_ROOT, 'AGENT-ENV.md');
const GEN_CMD = 'npx tsx scripts/gen-agent-env.ts';

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(REPO_ROOT, rel), 'utf8'));
}

// `apps/` holds applications; the tribal-knowledge trap EI-10941 documents is the
// SHARED-LIBRARY split (`libs/` vs `packages/`), where an agent guesses the wrong
// root for a shared package. Keep apps out of the "guess between" set.
const APP_ROOT = 'apps';

/** The workspace roots that actually exist on disk, in a stable order. */
function workspaceRoots(workspaces: string[]): string[] {
  const roots = new Set<string>();
  for (const ws of workspaces) {
    // 'packages/*' → 'packages'; 'libs/generic/tooldef' → 'libs'. We want the
    // top-level directory an agent has to guess between.
    const top = ws.split('/')[0];
    if (top && existsSync(join(REPO_ROOT, top))) roots.add(top);
  }
  return [...roots].sort();
}

/** The SHARED-LIBRARY roots (workspace roots minus the app root) — the real libs-vs-packages ambiguity. */
function sharedCodeRoots(workspaces: string[]): string[] {
  return workspaceRoots(workspaces).filter((r) => r !== APP_ROOT);
}

/**
 * Every top-level entry under a root — the concrete set an agent picks from.
 *
 * WHY THIS ASKS GIT AND NOT THE FILESYSTEM (WI-7006): this list is baked into a
 * COMMITTED artifact that `--check` re-derives in CI, so anything it reads must
 * exist identically on every checkout. A bare `readdirSync` does not qualify —
 * it also returns build fossils and stray directories that git cannot represent,
 * and one of those took the entire remote gate down for a week.
 *
 * The fossil was `packages/locks/`: a package that moved to
 * `libs/papercusp/packages/locks` and left behind a directory containing ONLY an
 * empty `node_modules/`. No package.json, no tracked files, not in `.gitmodules`,
 * and INVISIBLE to `git status` because its sole content is ignored — so nothing
 * on any dev box ever flagged it. It made the committed doc say `packages/` — 11
 * entries; a clean CI clone counted 10, regenerated a different doc, and
 * `--check` failed. That failure is step 6 of ~65 in test.yml, and the ~55 later
 * steps carry no `if: always()`, so GitHub SKIPPED the whole affected-test suite
 * and every gating lint. 0 green CI runs in 100, while `--check` stayed green on
 * every developer machine.
 *
 * `git ls-tree` returns exactly the entries the repository actually contains
 * (trees AND submodule gitlinks, which a fresh `--recursive` checkout populates),
 * so the generated list is identical everywhere. The filesystem fallback below is
 * for a non-git export; it drops any directory whose only content is
 * ignored/build output, which is the fossil signature above.
 */
function entriesUnder(root: string): string[] {
  const dir = join(REPO_ROOT, root);
  if (!existsSync(dir)) return [];
  try {
    const out = execFileSync('git', ['ls-tree', '--name-only', 'HEAD', `${root}/`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const tracked = out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((p) => p.slice(root.length + 1))
      .filter((name) => name && !name.includes('/') && name !== 'node_modules' && !name.startsWith('.'))
      // ls-tree lists blobs too (a root's own README); keep only directories.
      .filter((name) => existsSync(join(dir, name)) && statSync(join(dir, name)).isDirectory());
    if (tracked.length > 0) return [...new Set(tracked)].sort();
  } catch {
    // Not a git checkout (or git unavailable) — fall through to the filesystem.
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.'))
    // A directory holding nothing but ignored/build output is a fossil, not a
    // package — it cannot exist on a fresh clone, so it must not enter the doc.
    .filter((e) => hasRepoContent(join(dir, e.name)))
    .map((e) => e.name)
    .sort();
}

/** True iff `dir` holds anything other than `node_modules` / dotfiles — i.e. real repo content. */
function hasRepoContent(dir: string): boolean {
  try {
    return readdirSync(dir).some((n) => n !== 'node_modules' && !n.startsWith('.'));
  } catch {
    return false;
  }
}

/**
 * The operator-vite `@` alias target, read from the config itself. Returns the
 * resolve() argument (e.g. '../operator') so the doc names the REAL cross-tree
 * target, and the drift guard re-derives it if the config moves.
 */
function operatorViteAliasTarget(): { target: string | null; aliasPresent: boolean } {
  const rel = 'apps/operator-vite/vite.config.ts';
  if (!existsSync(join(REPO_ROOT, rel))) return { target: null, aliasPresent: false };
  const src = readFileSync(join(REPO_ROOT, rel), 'utf8');
  const decl = src.match(/const\s+operatorRoot\s*=\s*resolve\(\s*import\.meta\.dirname\s*,\s*['"]([^'"]+)['"]/);
  const aliasPresent = /\{\s*find:\s*['"]@['"]\s*,\s*replacement:\s*operatorRoot\s*\}/.test(src);
  return { target: decl ? decl[1] : null, aliasPresent };
}

const rootPkg = readJson('package.json');
const workspaces = Array.isArray(rootPkg.workspaces) ? (rootPkg.workspaces as string[]) : [];
const scripts = (rootPkg.scripts ?? {}) as Record<string, string>;
const roots = sharedCodeRoots(workspaces);
const vite = operatorViteAliasTarget();
const pcHeavy = existsSync(join(REPO_ROOT, 'scripts', 'pc-heavy.sh'));

// A sample package that GENUINELY has no package-local vitest, to demonstrate the
// "use the hoisted root binary" fact with a concrete, TRUE example. A few packages
// (e.g. those pinning a different vitest major) do ship their own — the doc must not
// point at one of those, or its example would be a lie. Derived, so it stays true.
//
// WI-7006: this used to probe `<pkg>/node_modules/.bin/vitest` — INSTALLED state,
// which is the same unreproducible-input bug as `entriesUnder` above and would have
// broken CI the same way the moment npm's hoisting differed between a dev tree and
// `npm ci --legacy-peer-deps`. Ask the committed manifest instead: a package gets a
// local vitest precisely because it DECLARES one, and that declaration is in git.
function declaresVitest(wsRel: string): boolean {
  const manifest = join(REPO_ROOT, wsRel, 'package.json');
  if (!existsSync(manifest)) return false;
  try {
    const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return Boolean(pkg.dependencies?.vitest ?? pkg.devDependencies?.vitest);
  } catch {
    return false;
  }
}
const concretePkgWorkspaces = workspaces
  .filter((ws) => ws.startsWith('packages/') && ws !== 'packages/*')
  .map((ws) => ws)
  .sort();
const sampleWs =
  concretePkgWorkspaces.find((ws) => !declaresVitest(ws)) ??
  // Fall back to the packages/* listing if the workspaces entry is a glob.
  entriesUnder('packages')
    .map((name) => `packages/${name}`)
    .find((rel) => existsSync(join(REPO_ROOT, rel, 'package.json')) && !declaresVitest(rel)) ??
  null;

const lines: string[] = [];
const w = (s = '') => lines.push(s);

w(`<!-- GENERATED by ${GEN_CMD} — do NOT edit by hand. Regenerate after changing`);
w(`     workspaces, the operator-vite alias, or the test tooling. \`npm run doctor\``);
w(`     asserts these same invariants as runnable checks. -->`);
w('# AGENT-ENV — the machine-checked repo operating contract');
w();
w('You are working in a large monorepo. The facts below are the ones that cost a');
w('fresh agent a failed command or a wrong edit when undiscovered. They are');
w('GENERATED from the real config (package.json, the vite config, the on-disk');
w('layout), so they cannot drift out of sync the way a hand-written note does.');
w();
w(`- **Repo root:** \`${(rootPkg.name as string) ?? '(unnamed)'}\``);
w(`- **Package manager:** \`${(rootPkg.packageManager as string) ?? 'npm'}\``);
w();

w('## Where shared code lives');
w();
if (roots.length > 1) {
  const quantifier = roots.length === 2 ? 'both' : 'all';
  w(`There is **no single shared-code directory** — ${roots.map((r) => `\`${r}/\``).join(' and ')} ${quantifier}`);
  w(`exist and are ${quantifier} npm workspaces, with shared packages split across them under no`);
  w('stated rule (e.g. `test-config` lives in `libs/`, not `packages/`). Guessing the');
  w('wrong root is a `No such file or directory`. Search across them before assuming:');
  w();
  w('```');
  w(`ls -d ${roots.map((r) => `${r}/*<name>*`).join(' ')} 2>/dev/null   # find which root actually holds it`);
  w('```');
} else if (roots.length === 1) {
  w(`Shared code lives under \`${roots[0]}/\`.`);
}
w();
w(`Applications live separately under \`${APP_ROOT}/\` (each is its own workspace).`);
w();
for (const r of roots) {
  const entries = entriesUnder(r);
  w(`<details><summary><code>${r}/</code> — ${entries.length} entries</summary>`);
  w();
  w('```');
  w(entries.join('  '));
  w('```');
  w('</details>');
  w();
}

w('## Running tests');
w();
w('`vitest` is **hoisted to the repo root**, and MOST packages have no local copy —');
w('so a package-local invocation is exit-127 DOA. (A few packages that pin a different');
w('vitest major do ship their own; the root binary is the safe default everywhere else.)');
w();
w('```');
w(`node_modules/.bin/vitest            # EXISTS (the hoisted binary — the safe default)`);
if (sampleWs) w(`${sampleWs}/node_modules/.bin/vitest   # does NOT exist → a package-local call there is exit-127 DOA`);
w('```');
w();
w('Run a suite one of these ways (both resolve the hoisted binary):');
w();
w('```');
if (scripts['test:file']) w(`npm run test:file -- <path>                       # the supported wrapper`);
w(`node_modules/.bin/vitest run <path>               # the hoisted binary directly`);
if (pcHeavy) {
  w(`scripts/pc-heavy.sh node_modules/.bin/vitest run <path>   # REQUIRED for heavy runs on the shared box`);
}
w('```');
w();
if (pcHeavy) {
  w('On the shared 128-core box, heavy commands (a full suite, a build) must go');
  w('through `scripts/pc-heavy.sh` (nice + a flock concurrency semaphore) or the');
  w('admission guard rejects them under load.');
  w();
}
w('Some apps need their own vitest config, e.g. `apps/operator`:');
w();
w('```');
w('node_modules/.bin/vitest run <path> --config apps/operator/vitest.config.ts');
w('```');
w();

w('## Cross-tree alias trap (operator-vite)');
w();
if (vite.aliasPresent && vite.target) {
  w(`In \`apps/operator-vite/vite.config.ts\`, the \`@\` alias resolves to \`${vite.target}\``);
  w('relative to that config — i.e. it points at a **DIFFERENT app** (`apps/operator`,');
  w('the Next tree), not into operator-vite itself. So inside `apps/operator-vite`, an');
  w('intuitive `@/…` import silently crosses into another app\'s source tree.');
  w('**Intra-app imports here must be relative.** Nothing at the import site warns you.');
} else {
  w('_(No `@`→operator alias detected in apps/operator-vite/vite.config.ts.)_');
}
w();

w('## Desktop (Tauri)');
w();
w('The Tauri webview serves a **prebuilt, hashed bundle**, not the dev server — so');
w('source edits appear to do nothing until you rebuild the bundle. If a UI change');
w('is not showing up, rebuild before assuming the edit was wrong.');
w();

w('---');
w(`_Regenerate: \`${GEN_CMD}\`. Verify (and assert the invariants as checks): \`npm run doctor\`._`);

const out = lines.join('\n') + '\n';

if (process.argv.includes('--check')) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (current !== out) {
    // PRINT THE DIFF (WI-7006). This check previously emitted only "is stale",
    // and that silence is most of why a dead CI gate went unnoticed for a week:
    // the drift was environment-dependent, so it reproduced on NO developer
    // machine — the only place the difference was ever visible was this exact
    // line of CI output, and it said nothing. A guard that can fail somewhere
    // you cannot reproduce MUST show its evidence where it fails.
    process.stderr.write(`✗ AGENT-ENV.md is stale. Run: ${GEN_CMD}\n`);
    const a = current.split('\n');
    const b = out.split('\n');
    const shown: string[] = [];
    for (let i = 0; i < Math.max(a.length, b.length) && shown.length < 40; i++) {
      if (a[i] !== b[i]) {
        if (a[i] !== undefined) shown.push(`  -${i + 1}: ${a[i]}`);
        if (b[i] !== undefined) shown.push(`  +${i + 1}: ${b[i]}`);
      }
    }
    process.stderr.write(`\n  committed (-) vs regenerated (+):\n${shown.join('\n')}\n`);
    process.stderr.write(
      '\n  If the + side names a directory that is not in git (a build fossil, an\n' +
        '  empty leftover), the DOC is right and the working tree is dirty — delete\n' +
        '  the stray directory rather than committing it into the contract.\n',
    );
    process.exit(1);
  }
  process.stdout.write('✓ AGENT-ENV.md is up to date\n');
} else {
  writeFileSync(OUT, out);
  process.stdout.write(`✓ wrote AGENT-ENV.md (${roots.length} shared-code roots, alias target ${vite.target ?? 'n/a'})\n`);
}

// Note: test-doctor.mjs re-derives these same invariants inline rather than
// importing them from here — this module runs its generation side effects at
// module scope (it WRITES AGENT-ENV.md), so importing it would trigger a write.
// The "AGENT-ENV.md is not stale" doctor check + the gen:agent-env:check CI gate
// are what keep the doc and the runnable checks in agreement.
