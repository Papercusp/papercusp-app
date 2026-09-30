#!/usr/bin/env node
/**
 * check-mdx.mjs — fail-loud guard for MDX that won't compile (EI-438).
 *
 * A bare angle-bracket token in prose — `<date>`, `<id>`, `<slug>`, `<n>` —
 * written OUTSIDE a code span is parsed by MDX as a JSX element open tag. With
 * no matching close it is a HARD `astro build` failure
 * (`@astrojs/mdx` vite-plugin parse error), which blocks the ENTIRE
 * apps/operator-docs build — and therefore every agent's doc regeneration —
 * not just the author's. git-sync auto-commits the broken file first, so the
 * only current signal arrives AFTER it ships to the shared tree (EI-438; the
 * 2026-06-13 break was `A "resets <date>" string` in a fleet-token insight).
 *
 *   npm run lint:mdx        # = tsx scripts/check-mdx.mjs
 *
 * Run it with tsx (via the npm script), NOT bare `node`: this file imports the
 * TypeScript ../packages/operator-core/lib/content-lint/mdx module, which the
 * plain node ESM loader can't resolve (ERR_MODULE_NOT_FOUND) without tsx.
 *
 * Detection is the REAL MDX compiler, not a regex: each tracked or
 * nonignored-untracked .mdx is
 * compiled with `@mdx-js/mdx` (the same MDX core astro runs). Undefined
 * components (`<Aside>`, `<Steps>` — provided by Starlight at render, never
 * imported in the source) compile cleanly; only genuine SYNTAX errors fail, so
 * there are zero false positives on the docs that currently build. Fix a hit
 * by backticking the placeholder (`` `<date>` ``) or escaping it.
 *
 * Scope: tracked or nonignored-untracked .mdx under
 * apps/operator-docs/src/content/docs/ (exactly the astro-built set).
 * remark-gfm is applied to match starlight's pipeline so
 * table cells with inline-code angle brackets (`` `<ArchitectChat>` ``) don't
 * false-positive. YAML frontmatter (--- … ---) is blanked before compile —
 * `@mdx-js/mdx` has no remark-frontmatter here — with line count preserved so
 * reported positions still point at source.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve, relative, dirname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// D-003 (git-sync-content-guard): the pure detector now lives in ONE importable
// module shared by this CI lint, the git-sync content guard, and the
// content-fixer's success-check — so "is this .mdx valid" has a single source of
// truth. Re-exported below so existing importers (check-mdx-guard.test.ts) keep
// working unchanged. This .mjs is run via `tsx` (package.json `lint:mdx`) so it
// can import the TypeScript module.
import { findMdxCompileError, blankFrontmatter, autoFixMdxAngles } from '../packages/operator-core/lib/content-lint/mdx';

export { findMdxCompileError, blankFrontmatter };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The astro-built docs set (apps/operator-docs runs starlight, whose MDX
// pipeline includes remark-gfm — matched below). Scope to exactly what
// `astro build` compiles, so the lint's pass/fail mirrors the real build and a
// stray .mdx that astro never touches can't false-positive.
const DOCS_PREFIX = 'apps/operator-docs/src/content/docs/';

const isExcluded = (f) =>
  f.startsWith('_retired/') ||
  f.includes('/_retired/') ||
  f.includes('/node_modules/') ||
  f.includes('/dist/');

/**
 * Return repo-relative MDX paths in the Astro content tree.
 *
 * `git ls-files` alone is a false-green for a newly-authored quarantined doc:
 * git-sync sees the dirty file before it is committed, while this lint used to
 * see nothing. The combined `--cached --others --exclude-standard` form is the
 * same tracked + untracked-not-ignored population that git would stage, and
 * `-z` keeps a filename with whitespace/newlines from corrupting the scan.
 */
export function listMdxFiles() {
  const files = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', DOCS_PREFIX],
    { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 },
  )
    .toString()
    .split('\0')
    .filter(Boolean);

  return [...new Set(files)]
    .filter((f) => !isExcluded(f))
    .filter((f) => f.endsWith('.mdx') && f.startsWith(DOCS_PREFIX))
    .sort();
}

function normalizeRepoPath(file) {
  const absolute = resolve(ROOT, file);
  const repoPath = relative(ROOT, absolute).split(sep).join('/');
  if (!repoPath || repoPath === '..' || repoPath.startsWith('../')) return null;
  return repoPath;
}

function requestedMdxFiles(args) {
  const requested = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--files') {
      const value = args[++i];
      if (!value) throw new Error('--files requires at least one path');
      requested.push(value);
    } else if (arg.startsWith('--files=')) {
      const value = arg.slice('--files='.length);
      if (!value) throw new Error('--files requires at least one path');
      requested.push(value);
    }
  }
  if (requested.length === 0) return null;

  const normalized = requested.map(normalizeRepoPath);
  const invalid = normalized.findIndex((f) =>
    !f || !f.startsWith(DOCS_PREFIX) || !f.endsWith('.mdx') || isExcluded(f),
  );
  if (invalid !== -1) {
    throw new Error(
      `--files only accepts .mdx paths under ${DOCS_PREFIX}: ${requested[invalid]}`,
    );
  }
  return [...new Set(normalized)];
}

/** Select the default corpus or the exact file(s) named by a content-fixer. */
export function selectMdxFiles(args = []) {
  return requestedMdxFiles(args) ?? listMdxFiles();
}

/** Scan selected paths and return the same offender records the CLI reports. */
export async function scanMdxFiles(files, { doFix = false } = {}) {
  const offenders = [];
  const autofixed = [];
  for (const f of files) {
    let text;
    try {
      text = readFileSync(resolve(ROOT, f), 'utf8');
    } catch {
      continue;
    }
    let hit = await findMdxCompileError(f, text);
    if (hit && doFix) {
      const res = autoFixMdxAngles(text);
      if (res.changed) {
        writeFileSync(resolve(ROOT, f), res.fixed); // <+digit escape is always valid
        autofixed.push(f);
        text = res.fixed;
        hit = await findMdxCompileError(f, text); // re-check; may still have a `<word>` offender
      }
    }
    if (hit) {
      const at = hit.line != null ? `:${hit.line}${hit.col != null ? `:${hit.col}` : ''}` : '';
      offenders.push(`${f}${at}  ${hit.reason}`);
    }
  }
  return { offenders, autofixed };
}

async function main() {
  // --fix: deterministically repair the safe `<`+digit offender in place (WI-276)
  // before reporting; anything still broken (e.g. `<word>` components) is reported
  // for a human/LLM fixer as before.
  const doFix = process.argv.includes('--fix');
  const files = selectMdxFiles(process.argv.slice(2));
  const { offenders, autofixed } = await scanMdxFiles(files, { doFix });

  if (autofixed.length > 0) {
    console.log(`✓ auto-fixed (escaped \`<\`+digit) in ${autofixed.length} file(s):`);
    for (const f of autofixed) console.log('    ' + f);
  }

  if (offenders.length === 0) {
    console.log('✓ every selected tracked/untracked-not-ignored .mdx compiles (MDX core).');
    process.exit(0);
  }

  console.error('✗ MDX that will NOT compile — `astro build` fails hard on these and blocks');
  console.error('  the entire apps/operator-docs build (every agent\'s doc regen), not just yours.');
  console.error('  Most common cause: a bare `<word>` placeholder in prose (e.g. `<date>`, `<id>`)');
  console.error('  parsed as an unclosed JSX tag. Backtick it (`` `<date>` ``) or escape it.\n');
  for (const o of offenders) console.error('    ' + o);
  console.error(`\n  ${offenders.length} offender(s). See EI-438.`);
  process.exit(1);
}

// Run only as the entry point — importing the detector for reuse has no side effects.
const invokedPath = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '';
if (import.meta.url === invokedPath) main();
