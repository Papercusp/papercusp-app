#!/usr/bin/env node
/**
 * lint:no-hand-rolled-cli-entry — keep ESM CLI self-exec guards on the one
 * bundle-safe primitive, `isCliEntry(import.meta.url)`.
 *
 * The familiar `import.meta.url === pathToFileURL(process.argv[1]).href` check
 * is correct in an unbundled file and wrong in an esbuild single-file bundle:
 * every inlined module inherits the bundle entry's `import.meta.url`, so every
 * imported CLI can run its `main()` during host boot and call `process.exit()`.
 * The same applies to the template-literal and fileURLToPath spellings.
 *
 * Existing debt is measured once and kept in a SHRINK-ONLY count baseline. A
 * new occurrence in an already-baselined file still fails: counts are keyed by
 * path and spelling rather than allowing a whole file to hide future debt.
 * Migrate a site to `isCliEntry` and remove its count from the baseline.
 *
 * `--list` is the only supported way to seed or audit the measured population;
 * it scans source files with comments, strings, and regex bodies masked by the
 * shared parser-backed stripper, so quoted guidance cannot become a phantom.
 */
import { readFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stripCommentsAndStrings } from './lib/strip-comments-and-strings.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ROOTS = ['scripts', 'packages', 'libs', 'apps'];
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|mjs|cjs)$/i;
const SKIP_DIRS = new Set([
  '.git',
  '.next',
  '_retired',
  'build',
  'coverage',
  'dist',
  'dist-host',
  'dist-sidecar',
  'node_modules',
  'out',
  'public',
  'target',
]);

/**
 * Measured pre-existing population. This is deliberately empty until the
 * first `node scripts/check-no-hand-rolled-cli-entry.mjs --list` run seeds it.
 * Entries are `${repo-relative-path}|${guard-kind}` -> count.
 *
 * Exported so the edit-time nudge
 * (apps/operator/scripts/hooks/cc/posttooluse-cli-entry-nudge.mjs) reaches the
 * SAME table this gate judges by, rather than carrying a second copy that would
 * drift (derived-truth ladder: DERIVE, never hand-maintain a duplicate).
 */
export const ALLOW_COUNTS = new Map([
  ['apps/operator/bin/serve.ts|path-to-file-url', 2],
  ['apps/operator/bin/spawner-sidecar.ts|path-to-file-url', 2],
  ['apps/operator/bin/substrate-sidecar.ts|path-to-file-url', 2],
  ['apps/operator/scripts/hooks/cc/pretooluse-schedule-wakeup-provenance.mjs|file-template', 1],
  ['apps/operator/scripts/onboard-launcher.mjs|file-url-to-path', 1],
  ['apps/operator/scripts/ptool.mjs|path-to-file-url', 2],
  ['apps/operator/scripts/tutorial-runner.mjs|file-url-to-path', 1],
  ['scripts/assert-workspace-links.mjs|path-to-file-url', 2],
  ['scripts/check-declared-consumed.mjs|file-template', 1],
  ['scripts/check-derived-signal-firings.mjs|file-template', 1],
  ['scripts/check-di-seam-arity-strands.mjs|file-template', 1],
  ['scripts/check-docs-mirror.mjs|file-template', 1],
  ['scripts/check-drop-database-force.mjs|path-to-file-url', 2],
  ['scripts/check-explicit-presence.mjs|file-url-to-path', 1],
  ['scripts/check-full-replacement-mocks.mjs|file-url-to-path', 1],
  ['scripts/check-generic-first.mjs|file-url-to-path', 1],
  ['scripts/check-generic-independence.mjs|file-template', 1],
  ['scripts/check-lint-guard-reachability.mjs|path-to-file-url', 1],
  ['scripts/check-mock-cast-escape.mjs|path-to-file-url', 1],
  ['scripts/check-no-bespoke-state-read.mjs|path-to-file-url', 2],
  ['scripts/check-no-control-bytes.mjs|path-to-file-url', 1],
  ['scripts/check-no-eager-execfile-promisify.mjs|path-to-file-url', 2],
  ['scripts/check-no-hand-rolled-module-pin.mjs|path-to-file-url', 2],
  ['scripts/check-no-module-scope-flag-subscribe.mjs|path-to-file-url', 2],
  ['scripts/check-no-proc-path-fixture.mjs|path-to-file-url', 2],
  ['scripts/check-no-raw-agent-spawn.mjs|path-to-file-url', 2],
  ['scripts/check-no-raw-block-edge.mjs|path-to-file-url', 1],
  ['scripts/check-no-raw-goal-holder-read.mjs|path-to-file-url', 1],
  ['scripts/check-no-raw-harness-sentinel.mjs|path-to-file-url', 2],
  ['scripts/check-no-raw-install-slug-filter.mjs|path-to-file-url', 2],
  ['scripts/check-no-raw-setinterval.mjs|path-to-file-url', 2],
  ['scripts/check-no-retired-style.mjs|path-to-file-url', 2],
  ['scripts/check-no-self-referential-export.mjs|path-to-file-url', 1],
  ['scripts/check-no-unenrolled-detached-spawn.mjs|path-to-file-url', 1],
  ['scripts/check-no-ungated-infinite-animation.mjs|path-to-file-url', 1],
  ['scripts/check-no-unthreaded-apply.mjs|file-template', 1],
  ['scripts/check-no-wire-compression.mjs|path-to-file-url', 2],
  ['scripts/check-partial-index-alignment.mjs|file-template', 1],
  ['scripts/check-plane-adoption.mjs|file-template', 1],
  ['scripts/check-plane-producers.mjs|file-template', 1],
  ['scripts/check-systemd-startlimit-placement.mjs|path-to-file-url', 2],
  ['scripts/check-timer-classification.mjs|path-to-file-url', 2],
  ['scripts/check-tracked-node-modules.mjs|path-to-file-url', 1],
  ['scripts/check-typeless-reexport-trap.mjs|file-url-to-path', 1],
  ['scripts/check-unbounded-inbox-read.mjs|path-to-file-url', 1],
  ['scripts/check-unenrolled-mjs-imports.mjs|path-to-file-url', 2],
  ['scripts/check-unreachable-tier-mock.mjs|file-url-to-path', 1],
  ['scripts/check-vacuous-flag-guard.mjs|path-to-file-url', 1],
  ['scripts/check-vite-externalized-warnings.mjs|path-to-file-url', 1],
  ['scripts/check-workspace-deps-complete.mjs|path-to-file-url', 2],
  ['scripts/gen-borrowable-catalog.mjs|file-template', 1],
  ['scripts/gen-claude-md-manifest.mjs|file-template', 1],
  ['scripts/gen-testing-domains-contract.ts|file-template', 1],
  ['scripts/lint-tsc-agent-mcp.mjs|path-to-file-url', 1],
  ['scripts/lint-tsc-operator-vite.mjs|path-to-file-url', 1],
  ['scripts/lint-tsc-operator.mjs|path-to-file-url', 1],
  ['scripts/lint-tsc-orchestrator.mjs|path-to-file-url', 1],
  ['scripts/lint-tsc-papercusp-libs.mjs|path-to-file-url', 1],
  ['scripts/lint-tsc-scripts.mjs|path-to-file-url', 1],
  ['scripts/lint-tsc-workspaces.mjs|path-to-file-url', 1],
  ['scripts/lint-tsc.mjs|path-to-file-url', 1],
  ['scripts/load-claude-md-doc-parts.mjs|file-template', 1],
  ['scripts/npm-install-safe.mjs|file-template', 1],
  ['scripts/proc-guard.mjs|file-template', 1],
  ['scripts/project-doc-parts.mjs|file-template', 1],
  ['scripts/refill-prose-vectors-727.mjs|path-to-file-url', 1],
  ['scripts/scan-retirement-surface.mjs|file-template', 1],
  ['scripts/split-claude-md-rule-evidence.mjs|file-template', 1],
  ['scripts/trace-vite-externalized.mjs|path-to-file-url', 1],

  // EI-21543544916409140 widened the fileURLToPath detector to see comparisons whose
  // operands are wrapped in resolve()/path.resolve(). These occurrences all predate that
  // measurement; seed them once as shrink-only debt. The host-bundle guard remains stricter:
  // any one of these entering the live esbuild graph fails the build before the atomic swap.
  ['apps/operator/scripts/hooks/cc/posttooluse-css-design-primitives-nudge.mjs|file-url-to-path', 1],
  ['apps/operator/scripts/hooks/cc/posttooluse-mdx-nudge.mjs|file-url-to-path', 1],
  ['apps/operator/scripts/hooks/cc/posttooluse-migration-fixture-drift-nudge.mjs|file-url-to-path', 1],
  ['apps/operator/scripts/hooks/cc/posttooluse-migration-forward-compat-nudge.mjs|file-url-to-path', 1],
  ['apps/operator/scripts/hooks/cc/posttooluse-mock-cast-escape-nudge.mjs|file-url-to-path', 1],
  ['apps/operator/scripts/hooks/cc/posttooluse-no-proc-path-fixture-nudge.mjs|file-url-to-path', 1],
  ['apps/operator/scripts/hooks/cc/posttooluse-required-field-strand-nudge.mjs|file-url-to-path', 1],
  ['apps/operator/scripts/hooks/cc/posttooluse-tool-prompt-weight-nudge.mjs|file-url-to-path', 1],
  ['apps/operator/scripts/hooks/cc/posttooluse-ts-parse-nudge.mjs|file-url-to-path', 1],
  ['apps/operator/scripts/hooks/cc/posttooluse-write-byte-integrity-guard.mjs|file-url-to-path', 1],
  ['apps/operator/scripts/hooks/cc/pretooluse-tool-prompt-weight-guard.mjs|file-url-to-path', 1],
  ['apps/operator/scripts/hooks/inject/index.mjs|file-url-to-path', 1],
  ['packages/operator-core/lib/harness/routines/seed-telemetry-retention-routine.ts|file-url-to-path', 1],
  ['scripts/check-fixed-but-open.mjs|file-url-to-path', 1],
  ['scripts/check-format.mjs|file-url-to-path', 1],
  ['scripts/check-github-identity-terms.mjs|file-url-to-path', 1],
  ['scripts/check-migration-fixture-drift.mjs|file-url-to-path', 1],
  ['scripts/check-no-retired-imports.mjs|file-url-to-path', 1],
  ['scripts/check-optional-seam-strands.mjs|file-url-to-path', 1],
  ['scripts/check-required-field-strands.mjs|file-url-to-path', 1],
  ['scripts/check-retired-resurrection.mjs|file-url-to-path', 1],
  ['scripts/check-sql-guidance-justified.mjs|file-url-to-path', 1],
  ['scripts/check-undrained-stdout-exit.mjs|file-url-to-path', 1],
  ['scripts/check-vimock-export-strands.mjs|file-url-to-path', 1],
  ['scripts/check-vitest-config-enrollment.mjs|file-url-to-path', 1],
  ['scripts/content-lint-runner.mjs|file-url-to-path', 1],
  ['scripts/gen-declarations.ts|file-url-to-path', 1],
  ['scripts/next-migration.mjs|file-url-to-path', 1],
  ['scripts/test-files.mjs|file-url-to-path', 1],
  ['scripts/workspace-test.mjs|file-url-to-path', 1],
]);

/**
 * Architecturally-safe standalone entrypoints are not bundle debt. Each entry
 * must be executed by bare node as its own file and copied verbatim (rather
 * than inlined into the desktop sidecar), which keeps import.meta.url scoped to
 * that file. Keep these separate from the shrink-only debt baseline so the
 * exception carries its reason and cannot silently bless additional guards in
 * the same file.
 *
 * Exported alongside ALLOW_COUNTS for the edit-time nudge, for the same reason.
 */
export const STANDALONE_ENTRY_EXEMPTIONS = new Map();

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      yield* walk(full);
    } else if (
      SOURCE_EXT.test(name) &&
      !/(?:\.test|\.spec)\.[cm]?[jt]sx?$/i.test(name) &&
      !name.endsWith('.d.ts')
    ) {
      yield full;
    }
  }
}

/** Return a stable line number for a source offset. */
function lineAt(source, offset) {
  return source.slice(0, offset).split('\n').length;
}

/**
 * Find the three equivalent ESM self-exec idioms that collapse inside a bundle.
 * The input is masked first, so the expressions below only see executable code.
 */
export function findGuards(source, fileName = 'cli-entry.mjs') {
  // Every supported spelling contains this exact token. Avoid running the
  // parser-backed masker over the vast majority of source files that cannot
  // possibly match; the repository ratchet calls this once per source file
  // and otherwise sits on Vitest's 60s default timeout under fleet load.
  if (!source.includes('import.meta.url')) return [];
  const masked = stripCommentsAndStrings(source, fileName);
  const patterns = [
    {
      kind: 'path-to-file-url',
      // Allow argv aliases, resolve(), realpathSync(), and multiline calls.
      re: /import\.meta\.url\s*===\s*pathToFileURL[\s\S]{0,320}?\.href\b/g,
    },
    {
      kind: 'file-template',
      re: /import\.meta\.url\s*===\s*`[^`]*\$\{\s*process\.argv\s*\[\s*1\s*\]\s*\}[^`]*`/g,
    },
    {
      kind: 'file-url-to-path',
      // Allow optional resolve()/realpathSync()-style wrappers around either operand. The
      // pre-EI-21543544916409140 form used resolve(argv[1]) === resolve(fileURLToPath(import.meta.url));
      // the narrower detector missed it, so a known-dangerous guard entered a host bundle.
      re: /(?:(?:\w+\s*\(\s*)?fileURLToPath\w*\s*\(\s*import\.meta\.url\s*\)\s*\)?\s*===\s*(?:\w+\s*\(\s*)?process\.argv\s*\[\s*1\s*\]\s*\)?|(?:\w+\s*\(\s*)?process\.argv\s*\[\s*1\s*\]\s*\)?\s*===\s*(?:\w+\s*\(\s*)?fileURLToPath\w*\s*\(\s*import\.meta\.url\s*\)\s*\)?)/g,
    },
  ];
  const hits = [];
  for (const { kind, re } of patterns) {
    for (const match of masked.matchAll(re)) {
      hits.push({ kind, offset: match.index, line: lineAt(source, match.index), text: source.slice(match.index, match.index + match[0].length) });
    }
  }
  // A future spelling may satisfy two broad patterns. Report one occurrence,
  // while retaining the first (most specific) classification for the baseline.
  const unique = new Map();
  for (const hit of hits) unique.set(`${hit.offset}:${hit.kind}`, hit);
  return [...unique.values()].sort((a, b) => a.offset - b.offset || a.kind.localeCompare(b.kind));
}

function keyFor(rel, kind) {
  return `${rel}|${kind}`;
}

function currentSourceFiles() {
  const files = [];
  for (const root of SOURCE_ROOTS) {
    for (const file of walk(join(ROOT, root))) files.push(file);
  }
  return files.sort();
}

/** Scan the complete source population, ignoring the shrink-only baseline. */
export function scanTree() {
  const everyGuard = [];
  for (const file of currentSourceFiles()) {
    let source;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const rel = relative(ROOT, file).replaceAll('\\', '/');
    for (const hit of findGuards(source, rel)) everyGuard.push({ rel, ...hit });
  }

  const counts = new Map();
  for (const hit of everyGuard) {
    const key = keyFor(hit.rel, hit.kind);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const violations = [];
  const exemptions = [];
  for (const hit of everyGuard) {
    const key = keyFor(hit.rel, hit.kind);
    const allowed = ALLOW_COUNTS.get(key) ?? 0;
    const exemption = STANDALONE_ENTRY_EXEMPTIONS.get(key);
    const prior = everyGuard
      .filter((candidate) => keyFor(candidate.rel, candidate.kind) === key && candidate.offset < hit.offset)
      .length;
    if (prior < allowed) continue;
    if (exemption && prior - allowed < exemption.count) {
      exemptions.push({ ...hit, reason: exemption.reason });
      continue;
    }
    violations.push(hit);
  }

  const stale = [...ALLOW_COUNTS.entries()]
    .filter(([key, allowed]) => (counts.get(key) ?? 0) < allowed)
    .map(([key, allowed]) => ({ key, allowed, current: counts.get(key) ?? 0 }))
    .sort((a, b) => a.key.localeCompare(b.key));

  const staleExemptions = [...STANDALONE_ENTRY_EXEMPTIONS.entries()]
    .filter(([key, exemption]) => (counts.get(key) ?? 0) < (ALLOW_COUNTS.get(key) ?? 0) + exemption.count)
    .map(([key, exemption]) => ({ key, exempted: exemption.count, current: counts.get(key) ?? 0, reason: exemption.reason }))
    .sort((a, b) => a.key.localeCompare(b.key));

  return { everyGuard, counts, violations, exemptions, stale, staleExemptions };
}

const LIST_ONLY = process.argv.includes('--list');

export const isDirectCliInvocation = (entryPath = process.argv[1]) =>
  typeof entryPath === 'string' && /(?:^|[\\/])check-no-hand-rolled-cli-entry\.mjs$/.test(entryPath);

function printSeed(everyGuard, counts) {
  console.log(`${everyGuard.length} hand-rolled ESM CLI-entry guard(s) across ${new Set(everyGuard.map((x) => x.rel)).size} file(s):\n`);
  for (const hit of everyGuard) console.log(`  ${hit.rel}:${hit.line}  ${hit.kind}`);
  console.log('\nALLOW_COUNTS seed (paste into this script):\n');
  for (const [key, count] of [...counts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ['${key.replaceAll("'", "\\'")}', ${count}],`);
  }
}

function main() {
  const { everyGuard, counts, violations, exemptions, stale, staleExemptions } = scanTree();
  if (LIST_ONLY) {
    printSeed(everyGuard, counts);
    return;
  }
  if (violations.length > 0) {
    console.error(`\n✖ lint:no-hand-rolled-cli-entry — ${violations.length} new hand-rolled ESM CLI-entry guard(s):\n`);
    for (const hit of violations) console.error(`  ${hit.rel}:${hit.line}  ${hit.kind}`);
    console.error(
      '\nUse the bundle-safe helper instead:\n' +
        "  import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';\n" +
        '  if (isCliEntry(import.meta.url)) main();\n\n' +
        'For a deliberately bare-node, verbatim-copied standalone entrypoint that cannot import the helper, add a count-bounded, reason-carrying STANDALONE_ENTRY_EXEMPTIONS entry; never grow ALLOW_COUNTS for new code.\n',
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `✔ lint:no-hand-rolled-cli-entry — no new hand-rolled guards (${everyGuard.length} measured occurrence(s), ${exemptions.length} reasoned standalone exemption(s)).`,
  );
  if (stale.length > 0) {
    console.log('\nStale baseline entries (migrated or removed; delete them from ALLOW_COUNTS):');
    for (const item of stale) console.log(`  ${item.key}: allowed ${item.allowed}, current ${item.current}`);
  }
  if (staleExemptions.length > 0) {
    console.log('\nStale standalone exemptions (guard migrated or removed; delete the exemption):');
    for (const item of staleExemptions) {
      console.log(`  ${item.key}: exempted ${item.exempted}, current ${item.current} — ${item.reason}`);
    }
  }
}

if (isDirectCliInvocation()) main();
