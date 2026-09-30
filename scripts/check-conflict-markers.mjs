#!/usr/bin/env node
/**
 * check-conflict-markers.mjs — fail on COMMITTED git conflict markers (EI-1836).
 *
 * On 2026-06-20 `apps/operator/app/globals.css` carried three COMMITTED git
 * stash/merge conflict markers (a bad git-sync auto-merge — the live-merge resolver
 * does NOT catch markers that are ALREADY committed). `vite build` then died with a
 * cryptic `CssSyntaxError: Unknown word "Stashed"`, which froze the SPA build, the
 * desktop sidecar build, the WI-280 re-key witness rebuild, AND the green-checkpoint
 * SPA build — the whole fleet's deploy pipeline + a critical-path witness, all on a
 * stray "Stashed" word in CSS. Root-finding took a manual build + grep.
 *
 * This guard makes a committed conflict marker a loud, NAMED, language-agnostic
 * failure instead of a cryptic downstream build break.
 *
 *   node scripts/check-conflict-markers.mjs            # scan tracked files; exit 1 on any marker (gating)
 *   node scripts/check-conflict-markers.mjs --self-test # verify the detector on inline fixtures
 *
 * WHAT IT MATCHES (zero false positives by construction): the three conflict
 * BRACKETS git writes at the START of a line — 7 `<`, 7 `>`, or 7 `|` (diff3 base),
 * each followed by a space/tab or end-of-line. These bracket EVERY git-produced
 * conflict, and no valid source line begins with seven of them. We deliberately do
 * NOT flag the bare `=======` separator: a 7-wide markdown setext underline or an
 * ASCII divider is exactly seven `=`, so flagging it would add false positives — and
 * the brackets already catch every real conflict, so it adds no coverage.
 *
 * D-003 (git-sync-content-guard-2026-06-13, mirroring shell-syntax): this pure
 * detector is now ALSO reused by the git-sync content guard's PRE-commit
 * registry (packages/operator-core/lib/content-lint/conflict-markers.ts imports
 * it FROM here) so a conflict-marker file is quarantined before it ever reaches
 * `staging` (EI-18217568076594579), not just caught by this post-hoc CI gate
 * hours later. Kept plain-Node-runnable (no TS import) deliberately: this script
 * is invoked directly via bare `node` from papercusp-desktop/bin/build-desktop-sidecar.sh
 * (a non-tsx, non-npm build context) — it must never gain a TypeScript-only
 * dependency, so content-lint imports THIS file rather than the reverse.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// The conflict BRACKETS at line start (start `<`, base `|`, end `>`), each followed
// by a space/tab or EOL. Anchored to line start (multiline flag) — the precision
// that makes this zero-false-positive. A fresh RegExp per scan avoids lastIndex state.
export const CONFLICT_MARKER_ERE = '^(<{7}|>{7}|\\|{7})([ \\t]|$)';
// ONE pattern source of truth: the JS detector is built FROM the same ERE string
// git grep uses, so the fast candidate pre-filter and the precise detector can never
// diverge. This simple pattern (anchors, alternation, {7}, char class) is identical
// under POSIX ERE and JS. Fresh RegExp per call avoids any lastIndex state.
const markerRegExp = () => new RegExp(CONFLICT_MARKER_ERE);

/**
 * Pure detector: the FIRST conflict marker in `content`, or null. 1-based line.
 * Exported so the guard's logic is unit-tested directly (check-conflict-markers-guard.test.ts)
 * AND reused by the git-sync content-guard registry (content-lint/conflict-markers.ts).
 */
export function findConflictMarker(path, content) {
  const re = markerRegExp();
  const lines = String(content).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (m) return { path, line: i + 1, marker: m[1], text: lines[i] };
  }
  return null;
}

// Files that legitimately contain a line-start bracket run (e.g. a doc DEMONSTRATING
// a conflict). Empty today — the tree is clean and the regex form in this file is
// `<{7}`, not seven literal brackets, so this script never self-flags.
const ALLOW = new Set([]);

// Fallback-only (no-`.git` tree) directory/extension excludes — mirrors what a
// normal .gitignore would already keep `git grep` from ever seeing.
const FALLBACK_EXCLUDE_DIRS = new Set([
  '.git', 'node_modules', 'target', 'dist', 'dist-host', 'build', '.next',
  '.turbo', '.vite', '.astro', 'coverage', '.cargo', 'seed',
]);
const FALLBACK_SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.icns', '.dmg', '.zip', '.tar',
  '.gz', '.woff', '.woff2', '.ttf', '.eot', '.pdf', '.dylib', '.so', '.a',
  '.o', '.wasm', '.node', '.db', '.sqlite', '.sqlite3', '.lock', '.jpg',
]);

// Exported (not just used internally) so the no-`.git` path is directly unit-testable
// against a real temp directory (check-conflict-markers-guard.test.ts) without having
// to fake out `ROOT` or strip `.git` from the real repo tree.
export function walkFallback(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable dir (permissions / vanished mid-walk) — skip it
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue; // never follow — avoids cycles
    if (entry.isDirectory()) {
      if (FALLBACK_EXCLUDE_DIRS.has(entry.name)) continue;
      walkFallback(join(dir, entry.name), out);
      continue;
    }
    if (!entry.isFile()) continue;
    const dot = entry.name.lastIndexOf('.');
    const ext = dot >= 0 ? entry.name.slice(dot) : '';
    if (FALLBACK_SKIP_EXT.has(ext)) continue;
    out.push(join(dir, entry.name));
  }
}

/** No-`.git` fallback: a git-archive HEAD snapshot shipped to a remote build
 *  host (mac-vm-verify-build.sh / WI-1708) intentionally excludes `.git` so
 *  the build is immune to the concurrently-edited shared tree — so `git grep`
 *  always fails there with "not a git repository", NOT because of a real
 *  problem. Before this fix that fatal-ed the whole sidecar build with an
 *  unrelated stack trace on every such snapshot build (WI-5769). Falls back
 *  to a plain recursive filesystem walk with the same excludes `.gitignore`
 *  would normally apply — same detector, same guarantee, just no git needed. */
function candidateFilesFallback() {
  const abs = [];
  walkFallback(ROOT, abs);
  return abs.map((p) => p.slice(ROOT.length).replace(/^[/\\]+/, ''));
}

/** Tracked files git grep flags as candidates (binary-skipped, fast). [] when clean.
 *  execFileSync with an argument array — no shell, so the (constant) ERE pattern is
 *  passed verbatim to git with no quoting/injection surface. */
function candidateFiles() {
  try {
    const out = execFileSync('git', ['grep', '-l', '-I', '-E', CONFLICT_MARKER_ERE, '--', '.'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return out.split('\n').filter(Boolean);
  } catch (e) {
    // git grep exits 1 with NO output when there are no matches — that is success.
    if (e && e.status === 1 && !String(e.stdout || '').trim()) return [];
    // No .git at ROOT (a shipped snapshot, not a checkout) — scan the filesystem
    // directly instead of hard-failing on an unrelated "not a git repository" error.
    if (String((e && e.stderr) || '').includes('not a git repository')) {
      return candidateFilesFallback();
    }
    throw e;
  }
}

function scanTree() {
  const offenders = [];
  for (const file of candidateFiles()) {
    if (ALLOW.has(file)) continue;
    let content;
    try {
      content = readFileSync(join(ROOT, file), 'utf8');
    } catch {
      continue; // unreadable / vanished between grep and read — skip
    }
    const hit = findConflictMarker(file, content);
    if (hit) offenders.push(hit);
  }
  return offenders;
}

function runSelfTest() {
  const B = (c) => c.repeat(7); // build a bracket run WITHOUT a literal marker in this source
  const cases = [
    { name: 'flags <<< start marker', text: `a\n${B('<')} HEAD\nb`, expectLine: 2 },
    { name: 'flags >>> end marker', text: `${B('>')} feature/x`, expectLine: 1 },
    { name: 'flags ||| diff3 base', text: `x\ny\n${B('|')} base`, expectLine: 3 },
    { name: 'flags a bare bracket run at EOL (no label)', text: `${B('<')}`, expectLine: 1 },
    { name: 'does NOT flag a lone ======= separator (FP-prone, excluded)', text: `${B('=')}`, expectNull: true },
    { name: 'does NOT flag 6 brackets (too few)', text: `${'<'.repeat(6)} HEAD`, expectNull: true },
    { name: 'does NOT flag a mid-line bracket run', text: `see ${B('<')} HEAD inline`, expectNull: true },
    { name: 'does NOT flag a markdown --- rule or normal code', text: '---\nconst x = a >> b;\n## Heading', expectNull: true },
  ];
  let failed = 0;
  for (const c of cases) {
    const hit = findConflictMarker('fixture', c.text);
    const ok = c.expectNull ? hit === null : hit && hit.line === c.expectLine;
    if (!ok) {
      failed++;
      console.error(`  ✗ ${c.name} — got ${JSON.stringify(hit)}`);
    }
  }
  if (failed) {
    console.error(`\ncheck-conflict-markers --self-test: ${failed} case(s) FAILED`);
    process.exit(1);
  }
  console.log(`check-conflict-markers --self-test: all ${cases.length} cases passed`);
}

function main() {
  if (process.argv.includes('--self-test')) {
    runSelfTest();
    return;
  }
  const offenders = scanTree();
  if (offenders.length === 0) {
    console.log('check-conflict-markers: clean — no committed git conflict markers');
    return;
  }
  console.error(
    `\ncheck-conflict-markers: ${offenders.length} COMMITTED git conflict marker(s) found.\n` +
      `A committed marker breaks builds with a cryptic error (EI-1836: a CSS marker froze the\n` +
      `whole fleet deploy + the WI-280 witness). Resolve the merge/stash before committing.\n`,
  );
  for (const o of offenders) {
    console.error(`  ${o.path}:${o.line}: ${o.text.slice(0, 80)}`);
  }
  process.exit(1);
}

/**
 * Only run the CLI when invoked directly via `node .../check-conflict-markers.mjs`
 * — importing the detector (content-lint/conflict-markers.ts, and the guard test)
 * must never trigger a tree scan.
 *
 * Deliberately does NOT compare `import.meta.url` to `process.argv[1]` (the old
 * check): this module is also imported — for its pure `findConflictMarker` export
 * only — by `packages/operator-core/lib/content-lint/conflict-markers.ts`, which the
 * desktop sidecar's esbuild single-file bundle inlines into `serve.mjs` (WI-5702).
 * Once inlined, `import.meta.url` for EVERY module in the bundle resolves to the
 * OUTPUT file's own URL (there is only one real ESM module at runtime) — so when the
 * packaged sidecar boots via `node serve.mjs`, `import.meta.url` equals
 * `pathToFileURL(process.argv[1]).href` for THIS code too, and the old check
 * false-fired `main()` at server boot: `scanTree()` ran `git grep` over the
 * installed (non-git) package directory, threw "fatal: not a git repository", and
 * crashed the sidecar before Postgres could finish starting (EMBEDDED_PG_FAILED).
 *
 * This is the SAME landmine class `packages/operator-core/lib/util/cli-entry.ts`
 * (`isCliEntry`) already exists to close for TS CLIs (EI-650: a bundled library's
 * `main()` silently `process.exit(0)`'d the sidecar at boot the same way). This
 * script can't import that helper — it must stay plain-Node-runnable with zero
 * TS/bundler dependency (`build-desktop-sidecar.sh` runs it via bare `node`, and
 * `content-lint/conflict-markers.ts` imports it, not the reverse) — so it
 * re-derives the equivalent guard inline: check the bundle-build marker `--define`
 * FIRST (same signal `isCliEntry` trusts), and independently check the process
 * entry path's basename, which is immune to import.meta.url rewriting on its own
 * (a bundled runtime's entry is always the bundle's own filename — `serve.mjs`,
 * never this file's — so it can never accidentally match).
 */
// Injected by esbuild (`--define`) only in the desktop-sidecar bundle (see
// build-desktop-sidecar.sh). Absent (a genuine `undefined` global) under a plain
// `node scripts/check-conflict-markers.mjs` CLI run or any test import — read via
// `typeof` so the bare reference never throws a ReferenceError.
// eslint-disable-next-line no-undef
const isBundledSidecar = typeof __PAPERCUSP_BUNDLED_SIDECAR__ !== 'undefined' && __PAPERCUSP_BUNDLED_SIDECAR__;

export const isDirectCliInvocation = (entryPath = process.argv[1]) =>
  !isBundledSidecar && typeof entryPath === 'string' && /(?:^|[\\/])check-conflict-markers\.mjs$/.test(entryPath);

if (isDirectCliInvocation()) {
  main();
}
