#!/usr/bin/env node
/**
 * check-docs-mirror.mjs — source-to-served docs completeness guard
 * (EI-20041752458165941).
 *
 * The docs site has two independently useful representations of every source
 * page: Astro's served HTML page and emit-md-twins.ts's per-page Markdown twin.
 * A source .mdx/.md file that is committed without rebuilding the docs leaves
 * both HTTP surfaces stale while looking complete in the source tree. Keep the
 * detector path-based and pure so its mapping rules can be tested without
 * building Astro or reading the real (large) mirror.
 *
 * The HTML mapping follows Astro's `build.format: 'file'` behavior: a nested
 * `section/index.mdx` page is served as `section.html`. Markdown twins retain
 * the source's nested path (`section/index.md`). Hidden path segments are
 * Starlight/content-tooling support files, not published pages, and are
 * deliberately excluded from both sides of the comparison.
 *
 * Usage:
 *   node scripts/check-docs-mirror.mjs
 *   node scripts/check-docs-mirror.mjs --source-root=/path/to/content/docs \
 *     --mirror-root=/path/to/operator/public/internal/docs
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_SOURCE_ROOT = join(REPO_ROOT, 'apps/operator-docs/src/content/docs');
export const DEFAULT_MIRROR_ROOT = join(REPO_ROOT, 'apps/operator/public/internal/docs');

const SOURCE_EXTENSIONS = new Set(['.md', '.mdx']);

/** Normalize a repository-relative path for deterministic, platform-neutral comparisons. */
export function normalizeRelativePath(value) {
  return String(value)
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

/** Hidden support files (including `.`, `..`, and dot-prefixed directories) are not pages. */
export function isVisibleDocPath(value) {
  const path = normalizeRelativePath(value);
  return path.length > 0 && !path.split('/').some((segment) => segment.startsWith('.'));
}

/**
 * Map one source page to the two generated mirror paths it must have.
 * Returns null for non-doc or hidden paths.
 */
export function sourceToMirrorPaths(sourcePath) {
  const normalized = normalizeRelativePath(sourcePath);
  if (!isVisibleDocPath(normalized)) return null;

  const extension = extname(normalized).toLowerCase();
  if (!SOURCE_EXTENSIONS.has(extension)) return null;

  const stem = normalized.slice(0, -extension.length);
  const htmlStem = stem === 'index'
    ? 'index'
    : stem.endsWith('/index')
      ? stem.slice(0, -'/index'.length)
      : stem;

  return {
    source: normalized,
    html: `${htmlStem || 'index'}.html`,
    markdown: `${stem}.md`,
  };
}

function visibleSet(paths) {
  return new Set(
    paths
      .map(normalizeRelativePath)
      .filter(isVisibleDocPath),
  );
}

/**
 * Pure detector: return every visible source page missing either generated twin.
 * `sourceFiles`, `htmlFiles`, and `markdownFiles` are relative paths.
 */
export function findMissingDocMirrors({ sourceFiles, htmlFiles, markdownFiles }) {
  const html = visibleSet(htmlFiles);
  const markdown = visibleSet(markdownFiles);
  const missing = [];

  for (const sourcePath of sourceFiles.map(normalizeRelativePath).sort()) {
    const expected = sourceToMirrorPaths(sourcePath);
    if (!expected) continue;

    const missingKinds = [];
    if (!html.has(expected.html)) missingKinds.push('html');
    if (!markdown.has(expected.markdown)) missingKinds.push('markdown');
    if (missingKinds.length > 0) {
      missing.push({
        source: expected.source,
        expected: { html: expected.html, markdown: expected.markdown },
        missing: missingKinds,
      });
    }
  }

  return missing;
}

/** Walk a docs root and return visible paths with one of the requested extensions. */
export function listVisibleFiles(root, extensions) {
  const wanted = new Set(extensions.map((extension) => extension.toLowerCase()));
  const out = [];

  function walk(directory, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, relativePath);
      } else if (entry.isFile() && wanted.has(extname(entry.name).toLowerCase())) {
        out.push(relativePath);
      }
    }
  }

  walk(root);
  return out.sort();
}

/** Read both trees and run the pure detector over their relative path sets. */
export function scanDocsMirror({ sourceRoot = DEFAULT_SOURCE_ROOT, mirrorRoot = DEFAULT_MIRROR_ROOT } = {}) {
  if (!existsSync(sourceRoot)) throw new Error(`docs source root does not exist: ${sourceRoot}`);
  if (!existsSync(mirrorRoot)) throw new Error(`docs mirror root does not exist: ${mirrorRoot}`);

  const sourceFiles = listVisibleFiles(sourceRoot, [...SOURCE_EXTENSIONS]);
  const htmlFiles = listVisibleFiles(mirrorRoot, ['.html']);
  const markdownFiles = listVisibleFiles(mirrorRoot, ['.md']);
  return {
    sourceFiles,
    htmlFiles,
    markdownFiles,
    missing: findMissingDocMirrors({ sourceFiles, htmlFiles, markdownFiles }),
  };
}

function parseArgs(argv) {
  const options = {};
  for (const arg of argv) {
    if (arg.startsWith('--source-root=')) options.sourceRoot = resolve(arg.slice('--source-root='.length));
    else if (arg.startsWith('--mirror-root=')) options.mirrorRoot = resolve(arg.slice('--mirror-root='.length));
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

export function formatMissingDocMirrors(missing) {
  const lines = [`DOCS_MIRROR_MISSING: ${missing.length} source page(s) lack a served twin.`];
  for (const hit of missing) {
    lines.push(`  - ${hit.source}: missing ${hit.missing.join(' + ')}`);
    if (hit.missing.includes('html')) lines.push(`      expected HTML: ${hit.expected.html}`);
    if (hit.missing.includes('markdown')) lines.push(`      expected Markdown: ${hit.expected.markdown}`);
  }
  lines.push('', 'FIX: run `npm run docs:rebuild` after changing a docs source page.');
  return lines.join('\n');
}

/**
 * ── FRESHNESS: the half that was missing (EI-21929043331389136) ──────────────
 *
 * Everything above answers "does every source page HAVE a twin". Existence was
 * never the failure mode. Measured 2026-08-31: the vetting runbook's source was
 * fixed on 2026-08-30 to stop telling agents to pass a hand-typed responder
 * count, and for the next ten days the served twin — the page agents actually
 * read at /internal/docs — still said `pass max_agents:3`. Both twins existed
 * the entire time, so this script reported DOCS_MIRROR_OK on every run.
 *
 * A completeness check cannot see stale content, so this adds the orthogonal
 * question: is the mirror BUILT FROM the source as it stands now?
 *
 * Kept pure and injectable for the same reason as the mapping rules above: the
 * verdict must be testable without a git repository or an Astro build.
 */

/** @typedef {{ stale: boolean, reason: string, detail: string }} FreshnessVerdict */

/**
 * Judge mirror freshness from already-gathered git facts.
 *
 * @param {{
 *   sourceDirty: readonly string[],
 *   mirrorDirty: readonly string[],
 *   sourceCommitTs: number | null,
 *   mirrorCommitTs: number | null,
 * }} facts
 * @returns {FreshnessVerdict}
 */
export function judgeMirrorFreshness(facts) {
  const { sourceDirty, mirrorDirty, sourceCommitTs, mirrorCommitTs } = facts;

  // A dirty mirror means a rebuild is staged in this working tree. The rebuild
  // regenerates every page wholesale, so the tree in hand IS current — judging
  // it against the older COMMITTED watermark would red a checkout that already
  // holds the fix, which is the fastest way to teach people to ignore a guard.
  if (mirrorDirty.length > 0) {
    return {
      stale: false,
      reason: 'rebuild-staged',
      detail: `${mirrorDirty.length} mirror file(s) modified in the working tree — a rebuild is staged here`,
    };
  }

  if (sourceDirty.length > 0) {
    return {
      stale: true,
      reason: 'source-edited-without-rebuild',
      detail:
        `${sourceDirty.length} docs source page(s) are modified while the served mirror is untouched:\n` +
        sourceDirty.slice(0, 10).map((p) => `  - ${p}`).join('\n') +
        (sourceDirty.length > 10 ? `\n  … and ${sourceDirty.length - 10} more` : ''),
    };
  }

  // Both sides clean: the only remaining evidence is which was committed last.
  // A source page committed AFTER the newest mirror commit is a page whose fix
  // may never have reached the surface agents read.
  //
  // ADVISORY, not a failure, and the reason is a real false-positive path, not
  // caution: a source edit that does not change rendered output (frontmatter
  // the renderer drops, a reflow) advances the source watermark while a rebuild
  // produces a byte-identical mirror and therefore no commit. Failing here would
  // leave that checkout permanently red with `docs:rebuild` — the prescribed fix
  // — unable to clear it, which is worse than the drift.
  //
  // Making it hard needs a BUILD STAMP: postbuild-copy recording the source
  // commit the mirror was generated from, so freshness becomes "was this mirror
  // built from a source state at or after HEAD" instead of a date comparison.
  // That is a build-pipeline change, deliberately not made under this item.
  if (sourceCommitTs !== null && mirrorCommitTs !== null && sourceCommitTs > mirrorCommitTs) {
    const behindSec = sourceCommitTs - mirrorCommitTs;
    return {
      stale: false,
      reason: 'source-newer-than-mirror-advisory',
      detail:
        `the newest docs SOURCE commit is ${Math.round(behindSec / 3600)}h newer than the newest ` +
        `MIRROR commit (source ${new Date(sourceCommitTs * 1000).toISOString()} > ` +
        `mirror ${new Date(mirrorCommitTs * 1000).toISOString()}) — the served pages predate the source`,
    };
  }

  return { stale: false, reason: 'current', detail: 'the served mirror is at or ahead of the docs source' };
}

/**
 * Gather the git facts `judgeMirrorFreshness` needs.
 *
 * @param {{ repoRoot?: string, sourceRel?: string, mirrorRel?: string, runGit?: (args: string[]) => string }} [options]
 */
export function readMirrorFreshnessFacts(options = {}) {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const sourceRel = options.sourceRel ?? 'apps/operator-docs/src/content/docs';
  const mirrorRel = options.mirrorRel ?? 'apps/operator/public/internal/docs';
  const runGit =
    options.runGit ??
    ((args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));

  const dirtyIn = (rel) =>
    runGit(['status', '--porcelain', '--', rel])
      .split('\n')
      .filter(Boolean)
      .map((line) => line.slice(3).trim())
      .filter(Boolean);

  const commitTsOf = (rel) => {
    const out = runGit(['log', '-1', '--format=%ct', '--', rel]).trim();
    return out ? Number.parseInt(out, 10) : null;
  };

  return {
    sourceDirty: dirtyIn(sourceRel),
    mirrorDirty: dirtyIn(mirrorRel),
    sourceCommitTs: commitTsOf(sourceRel),
    mirrorCommitTs: commitTsOf(mirrorRel),
  };
}

/** @param {FreshnessVerdict} verdict */
export function formatStaleMirror(verdict) {
  return [
    `DOCS_MIRROR_STALE (${verdict.reason}): the served docs no longer match their source.`,
    verdict.detail,
    '',
    'Agents read the SERVED twin at /internal/docs, so a stale mirror keeps handing them the',
    'instruction the source edit was written to delete — silently, with every twin present.',
    '',
    'FIX: run `npm run docs:rebuild`.',
  ].join('\n');
}

export function printUsage() {
  console.log('Usage: node scripts/check-docs-mirror.mjs [--source-root=DIR] [--mirror-root=DIR]');
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printUsage();
    return 0;
  }

  const result = scanDocsMirror(options);
  if (result.missing.length > 0) {
    console.error(formatMissingDocMirrors(result.missing));
    return 1;
  }

  // Only meaningful against the real repo layout; a --source-root/--mirror-root
  // run is a mapping-rules exercise over a fixture tree and has no git history.
  if (!options.sourceRoot && !options.mirrorRoot) {
    const freshness = judgeMirrorFreshness(readMirrorFreshnessFacts());
    if (freshness.stale) {
      console.error(formatStaleMirror(freshness));
      return 1;
    }
    if (freshness.reason === 'source-newer-than-mirror-advisory') {
      console.warn(`DOCS_MIRROR_ADVISORY: ${freshness.detail}\nIf a docs source page changed rendered output, run \`npm run docs:rebuild\`.`);
    }
  }

  console.log(
    `DOCS_MIRROR_OK: ${result.sourceFiles.length} source page(s) have HTML + Markdown twins ` +
      `(${result.htmlFiles.length} HTML, ${result.markdownFiles.length} Markdown mirror files scanned).`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`DOCS_MIRROR_ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
