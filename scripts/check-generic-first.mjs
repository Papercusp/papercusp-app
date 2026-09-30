#!/usr/bin/env node
/**
 * check-generic-first.mjs — the going-forward guard for the generic-core convention
 * (plan generalize-libs-to-generic-2026-06-05, D-005).
 *
 * The repo convention (CLAUDE.md "Borrowable libraries"): a genuinely generic, domain-free
 * algorithm belongs in `libs/generic/<name>` behind a seam — NOT in the app. The 2026-06-05
 * audit found a large batch of textbook distributed-systems / concurrency / ECA cores had
 * been written inside `packages/operator-core/lib/` instead, and had to be migrated out.
 * This lint stops that debt re-accruing: it flags a *pure-algorithm* file living in the app
 * (operator-core/lib, apps/operator/lib) that (a) has ZERO papercusp coupling — imports no
 * sibling app code, no domain `@papercusp/*` package, and no DB/IO client — AND (b) *names* a
 * textbook CS concept (supervision tree, fencing token, topological sort, …). Both signals are
 * required: structural decoupling alone flags ~200 files (most app code imports little), so the
 * concept name is the precision filter that separates a real misfiled algorithm from ordinary
 * decoupled glue. It then suggests the file start life in `libs/generic` behind a port seam.
 *
 *   node scripts/check-generic-first.mjs            # report candidates (informational)
 *   node scripts/check-generic-first.mjs --strict   # exit 1 if any unallow-listed candidate
 *   node scripts/check-generic-first.mjs --self-test # verify the analyzer on inline fixtures
 *
 * Informational by default (like lint:knip) — a heuristic, so it advises rather than blocks.
 * Genuine app-local pure helpers that should stay put go in ALLOW (below).
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { presentOnDisk } from './lib/tracked-files.mjs';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Directories that ARE the app — a zero-coupling algorithm here is the smell.
const SCAN_ROOTS = ['packages/operator-core/lib/', 'apps/operator/lib/'];

// Bare packages that are themselves domain/IO coupling (importing one binds you to a
// substrate, so the file is NOT a free-floating algorithm). @papercusp/* is classified
// dynamically against the borrowable catalog; this list is for non-@papercusp couplers.
const IO_COUPLING_PKGS = new Set([
  'postgres', 'pg', 'drizzle-orm', 'ioredis', 'redis', '@electric-sql/pglite',
]);

// Known pure-but-app-local files that legitimately stay put (curated exceptions) — a file
// whose concept keyword is incidental (in a comment about a third-party API, browser audio
// buffering, …) rather than a generic algorithm it implements.
const ALLOW = new Set([
  'packages/operator-core/lib/voice-engines/elevenlabs-mse.ts', // "backpressure" = MSE audio buffering, app-specific
  // generalize-libs-to-generic (cont.) 2026-06-08 (su-3911d): heuristic false positives from
  // lint:generic-first:all — the concept keyword is incidental, not an algorithm the file implements.
  'packages/operator-core/lib/harness/waves.ts', // "topological" = a comment word; this is promote-policy wave control over the papercusp feature-status vocabulary (passed/failing/validating/…), not a generic sort
  'packages/operator-core/lib/operator-converse-tags.ts', // "nursery" = a comment ref to the spawn path; this is the operator-converse turn-tag parser (<say>/<spawn>/<report> + session hooks) — app protocol, imports @papercusp/chat-protocol
  'packages/operator-core/lib/sync/hyperbee/swarm-guard.ts', // "rate limiter" = it already delegates the generic part to @papercusp/rate-limit; the rest is Hyperswarm-specific Noise-key/IP firewall + ban-list logic
  // generalize-libs-to-generic (cont.) 2026-06-08 (su-9bac3): a TRUE positive consciously kept app-local.
  // detectDependencyCycle IS a real Kahn cycle detector, but it's ~40 lines, single-use (one caller:
  // harness/features.ts), and entangled with the domain resolveBlockedByRefs (FeatureRef id/title resolution)
  // in this one file — extracting it isn't worth minting a new libs/generic workspace (npm-install +
  // shared package-lock churn) for a tiny single-use core, and no existing generic graph lib fits it.
  // Revisit if a generic graph-algorithms lib emerges or a second caller appears. (authority-hardening,
  // the one clean-home extract this pass, DID move → @papercusp/locks-core.)
  'packages/operator-core/lib/feature-deps.ts',
]);

/**
 * Recognisable generic-CS-concept signature — the precision filter. App code rarely *names*
 * these; a zero-coupling file that does is very likely a textbook algorithm that belongs in
 * libs/generic. Structural decoupling alone is far too noisy (most app code imports little),
 * so a candidate must BOTH be decoupled AND name a concept. Word-boundary, case-insensitive.
 */
const CONCEPT_RE = new RegExp(
  '\\b(' + [
    // concurrency / supervision / structured concurrency
    'supervision tree', 'nursery', 'structured concurrency', 'restart strategy', 'restart intensity',
    // backpressure / flow control
    'circuit breaker', 'token bucket', 'leaky bucket', 'backpressure', 'bulkhead',
    // sagas / transactions
    'saga', 'compensat(?:e|ing|ion)', 'two.phase commit', 'tombstone',
    // distributed coordination / consensus / membership
    'quorum', 'raft', 'paxos', 'gossip protocol', 'swim', 'phi.?accrual', 'failure detector',
    // logical time / replication
    'vector clock', 'lamport', 'hybrid logical clock', 'hlc', 'crdt', 'last.write.wins', 'fencing token',
    // mutual exclusion / classic problems
    'semaphore', 'deadlock', 'dining philosophers', 'readers.writers', 'producer.consumer',
    // data structures / graph algorithms
    'bloom filter', 'consistent hashing', 'rendezvous hash', 'merkle', 'union.find',
    'topological', 'levenshtein', 'rate limiter',
    // eca / rules
    'event.condition.action', 'rules engine',
  ].join('|') + ')\\b',
  'i',
);

/** The generic (borrowable) @papercusp package names — importing one is NOT coupling. */
function genericPackageNames() {
  const names = new Set();
  try {
    const cat = readFileSync(join(ROOT, 'scripts/gen-borrowable-catalog.mjs'), 'utf8');
    // Pull the repo-relative paths out of the BORROWABLE array literal.
    for (const m of cat.matchAll(/'(libs\/[^']+|packages\/[^']+)'\s*,/g)) {
      const p = m[1];
      try {
        const pkg = JSON.parse(readFileSync(join(ROOT, p, 'package.json'), 'utf8'));
        if (pkg.name) names.add(pkg.name);
      } catch { /* not a package dir — skip */ }
    }
  } catch { /* no catalog — treat all @papercusp/* as coupling */ }
  return names;
}

/** Every import/export-from/dynamic-import specifier in a TS source. */
function importSpecifiers(text) {
  const specs = [];
  const re = /(?:import|export)\s+(?:type\s+)?[^'"]*?\bfrom\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of text.matchAll(re)) specs.push(m[1] || m[2] || m[3]);
  return specs;
}

/** Bare package root of a specifier (`@scope/pkg/sub` → `@scope/pkg`; `pkg/sub` → `pkg`). */
function pkgRoot(spec) {
  if (spec.startsWith('@')) return spec.split('/').slice(0, 2).join('/');
  return spec.split('/')[0];
}

/** Does the file export runtime logic (a function/class), not just types? */
function hasAlgorithmExport(text) {
  return /export\s+(?:async\s+)?function\s/.test(text)
    || /export\s+class\s/.test(text)
    || /export\s+const\s+\w+\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|function|<)/.test(text)
    || /export\s+default\s+(?:async\s+)?function/.test(text);
}

/**
 * Analyze one file. Returns { candidate, reason }. A candidate is a zero-coupling
 * algorithm file sitting in the app. `generic` is the set of borrowable @papercusp names.
 */
export function analyzeForGenericFirst({ path, text, generic }) {
  if (/\.(test|integration\.test|spec)\.ts$/.test(path)) return { candidate: false, reason: 'test file' };
  if (path.endsWith('.d.ts')) return { candidate: false, reason: 'declaration file' };
  if (/(^|\/)index\.ts$/.test(path)) return { candidate: false, reason: 'barrel/index' };
  if (text.split('\n').length < 30) return { candidate: false, reason: 'too small to be an algorithm core' };
  if (!hasAlgorithmExport(text)) return { candidate: false, reason: 'no runtime export (types/config only)' };

  for (const spec of importSpecifiers(text)) {
    if (spec.startsWith('.')) return { candidate: false, reason: `couples via relative import '${spec}'` };
    const root = pkgRoot(spec);
    if (IO_COUPLING_PKGS.has(root)) return { candidate: false, reason: `binds a substrate via '${root}'` };
    if (root.startsWith('@papercusp/') && !generic.has(root)) {
      return { candidate: false, reason: `imports domain package '${root}'` };
    }
  }

  // Structural decoupling alone is far too noisy — most app code imports little, so a bare
  // zero-coupling scan flags ~200 files (measured). The precision signal is the CONCEPT: a
  // decoupled file that *names* a textbook CS concept (supervision tree, fencing token,
  // topological sort, …) is very likely a generic algorithm misfiled in the app. App code
  // rarely names these. Require BOTH. (Tradeoff: a generic algorithm with an unlisted name is
  // a false negative — acceptable for an advisory lint; a 200-candidate cry-wolf is not.)
  const concept = CONCEPT_RE.exec(text);
  if (!concept) {
    return { candidate: false, reason: 'decoupled but names no generic-CS concept (structural decoupling alone is too noisy)' };
  }
  return { candidate: true, reason: `zero papercusp coupling + names a generic concept ("${concept[1]}") — looks like a libs/generic algorithm` };
}

// ── self-test ─────────────────────────────────────────────────────────────────────────

function selfTest() {
  const generic = new Set(['@papercusp/structured-concurrency']);
  const big = (body) => `${body}\n` + '// pad\n'.repeat(40);
  const cases = [
    { name: 'pure algorithm naming a concept → candidate', expect: true, file: { path: 'packages/operator-core/lib/x/phi.ts', generic,
      text: big("import { mean } from 'node:assert';\n// a phi-accrual failure detector\nexport function phi(n){ return n*2; }") } },
    { name: 'decoupled but names no concept → not', expect: false, file: { path: 'packages/operator-core/lib/x/util.ts', generic,
      text: big("import { mean } from 'node:assert';\nexport function add(a, b){ return a + b; }") } },
    { name: 'relative import → not', expect: false, file: { path: 'packages/operator-core/lib/x/a.ts', generic,
      text: big("import { y } from './y';\nexport function a(){ return 1; }") } },
    { name: 'domain @papercusp import → not', expect: false, file: { path: 'packages/operator-core/lib/x/b.ts', generic,
      text: big("import { defineTool } from '@papercusp/agent-mcp';\nexport function b(){ return 1; }") } },
    { name: 'generic @papercusp import + concept → candidate', expect: true, file: { path: 'packages/operator-core/lib/x/c.ts', generic,
      text: big("import { createNursery } from '@papercusp/structured-concurrency';\n// builds a supervision tree\nexport function c(){ return 1; }") } },
    { name: 'postgres import → not', expect: false, file: { path: 'packages/operator-core/lib/x/d.ts', generic,
      text: big("import postgres from 'postgres';\n// quorum read\nexport function d(){ return 1; }") } },
    { name: 'types-only → not', expect: false, file: { path: 'packages/operator-core/lib/x/e.ts', generic,
      text: big("// a saga of types\nexport interface E { a: number }\nexport type F = string;") } },
    { name: 'tiny file → not', expect: false, file: { path: 'packages/operator-core/lib/x/f.ts', generic,
      text: "// circuit breaker\nexport function f(){ return 1; }" } },
    { name: 'test file → not', expect: false, file: { path: 'packages/operator-core/lib/x/g.test.ts', generic,
      text: big("// rate limiter\nexport function g(){ return 1; }") } },
  ];
  let failed = 0;
  for (const c of cases) {
    const got = analyzeForGenericFirst(c.file).candidate;
    const ok = got === c.expect;
    if (!ok) failed++;
    console.log(`  ${ok ? '✓' : '✗'} ${c.name}${ok ? '' : ` (expected ${c.expect}, got ${got})`}`);
  }
  if (failed) { console.error(`\n✗ self-test: ${failed} case(s) failed.`); process.exit(1); }
  console.log('\n✓ self-test: analyzer correct on all fixtures.');
  process.exit(0);
}

// ── main ──────────────────────────────────────────────────────────────────────────────

/** Only files this substantial are worth nudging about — small pure helpers stay put. */
const MIN_SUBSTANTIAL_LINES = 120;

/** A bash-free git invocation (no shell, no interpolation surface). */
function git(args) {
  const r = execSync(`git ${args}`, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return r.split('\n').filter(Boolean);
}

/**
 * The added/modified `.ts` files in the current change — committed since the merge-base
 * with `base` (default origin/main) PLUS uncommitted working-tree edits. Mirrors
 * scripts/affected-tests.mjs. Returns null if no base ref resolves (fresh clone).
 */
function changedFiles(base) {
  let committed = [];
  try {
    git(`rev-parse --verify --quiet ${base}`);
    // --no-renames: treat a rename as add+delete (we want to flag a newly-introduced file) and
    // silence git's "rename detection skipped" warning on this repo's very large diffs.
    committed = git(`diff --no-renames --diff-filter=AM --name-only ${base}...HEAD`);
  } catch {
    committed = null; // base unknown — fall back to uncommitted-only
  }
  let uncommitted = [];
  try { uncommitted = git('diff --no-renames --diff-filter=AM --name-only HEAD'); } catch { /* no HEAD */ }
  if (committed === null && uncommitted.length === 0) return null;
  return [...new Set([...(committed ?? []), ...uncommitted])];
}

function main() {
  const strict = process.argv.includes('--strict');
  const all = process.argv.includes('--all');
  if (process.argv.includes('--self-test')) return selfTest();

  const generic = genericPackageNames();

  let files;
  if (all) {
    // WI-10004176: drop index entries a plain `rm` left behind until git-sync commits it.
    files = presentOnDisk(git('ls-files'), ROOT);
  } else {
    const baseArg = process.argv.indexOf('--base');
    const base = baseArg >= 0 ? process.argv[baseArg + 1] : (process.env.AFFECTED_BASE || 'origin/main');
    const changed = changedFiles(base);
    if (changed === null) {
      console.log('✓ generic-first: no diff base (origin/main) and no working-tree changes — nothing new to check.');
      process.exit(0);
    }
    files = changed;
  }
  files = files.filter((f) => SCAN_ROOTS.some((r) => f.startsWith(r)) && f.endsWith('.ts'));

  const candidates = [];
  for (const f of files) {
    if (ALLOW.has(f)) continue;
    let text;
    try { text = readFileSync(join(ROOT, f), 'utf8'); } catch { continue; }
    if (text.split('\n').length < MIN_SUBSTANTIAL_LINES) continue;
    const { candidate, reason } = analyzeForGenericFirst({ path: f, text, generic });
    if (candidate) candidates.push({ f, reason });
  }

  const scope = all ? 'the app tree' : 'this change';
  if (candidates.length === 0) {
    console.log(`✓ generic-first: no zero-coupling algorithm files in ${scope} — convention intact.`);
    process.exit(0);
  }

  const header = strict ? '✗ generic-first' : '⚠ generic-first (advisory)';
  console.error(`${header}: ${candidates.length} substantial app file(s) in ${scope} look domain-free.`);
  console.error('  A pure, zero-coupling algorithm should START in libs/generic/<name> behind a port seam');
  console.error('  (CLAUDE.md "Borrowable libraries"; plan generalize-libs-to-generic-2026-06-05) — not in the app.');
  console.error('  These are *candidates*, not certainties: move genuinely-generic ones to libs/generic; for an');
  console.error('  intentionally app-local file, add its path to ALLOW in scripts/check-generic-first.mjs.\n');
  for (const c of candidates) console.error(`    ${c.f}\n        ${c.reason}`);
  process.exit(strict ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
