#!/usr/bin/env node
// apps/operator/scripts/hooks/cc/posttooluse-registry-census-drift-nudge.mjs
//
// PostToolUse (Edit|Write|MultiEdit) ADVISORY nudge for the registry-vs-census
// drift trap (EI-19401978567233485, sibling of
// posttooluse-migration-fixture-drift-nudge.mjs / EI-19359711978838614).
//
// THE TRAP
//   A registry is an exported array — `DEFAULT_CONTENT_DETECTORS`,
//   `BUILTIN_CELLS`, … — and a test somewhere asserts its EXACT ordered
//   membership: `expect(REG.map((d) => d.key)).toEqual([...])`. Append an entry
//   without updating that list and the census test goes red. Nothing the author
//   sees says so: the source edit typechecks, the module is fine, and they have
//   no reason to open a test file they did not touch. The red then surfaces at
//   the fleet green-checkpoint ~an hour later, where it holds `main` for EVERY
//   agent and costs a release-fixer dispatch plus a ~55min re-run. Measured
//   (WI-7318, candidate 2edd4735): BOTH genuine reds holding main that day were
//   this one class, from two unrelated registries.
//
// WHY A HOOK, WHEN THE DETECTOR ALREADY EXISTS
//   scripts/check-registry-census-drift.mjs answers this precisely and cheaply.
//   As with its migration sibling, finding the drift was never the hard part —
//   the hard part is KNOWING TO RUN IT, at the one moment the edit is fresh.
//   `test:affected` DOES select the census suite for these paths, so the
//   detector is not adding reach; it is collapsing the feedback loop from "an
//   hour later, on the whole fleet" to "now, on the author", while the fix is
//   still one line in a file they already have open.
//
// CONTRACT
//   - ADVISORY ONLY. PostToolUse cannot block and must not try to.
//   - REPORTS ONLY A CERTAINTY, never a suspicion. An exact-ordered `toEqual`
//     is a completeness assertion, so a registry whose arity disagrees with it
//     is not "possibly stale" — that test is red right now. The detector stays
//     silent on every softer census shape (toHaveLength/toContain/derived), so
//     there is no false-positive budget to spend.
//   - Only NEW drift fires: the before/after diff means a repeated edit to an
//     already-drifted file does not re-nudge for a gap already reported once.
//   - FAILS OPEN on every internal error — bad JSON, missing file, no git, an
//     unresolvable detector, a parse failure. A bug here must never disturb an
//     edit that already succeeded.
//   - `--self-test` runs the embedded cases (no stdin) and exits non-zero on
//     failure; mirrors the migration-fixture sibling.
//
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

/** Detector location, relative to the repo root — also how the root is identified. */
const DETECTOR_REL = join('scripts', 'check-registry-census-drift.mjs');

/** Parsing two versions of a very large file is not worth an edit-time nudge. */
const MAX_BYTES = 400_000;

/** Separator for the (registry, test) identity key — never a bare space. */
const KEY_SEP = '::';

/**
 * Bundle-safe entry check: compare the PROCESS ENTRY basename, never
 * `import.meta.url === pathToFileURL(process.argv[1]).href`. Once inlined into a
 * bundle every module inherits the bundle entry's `import.meta.url`, so the
 * familiar comparison runs every imported CLI's main() during host boot — the
 * class `isCliEntry(import.meta.url)` exists to close for TS CLIs. The migration
 * sibling still uses the old shape only as grandfathered, shrink-only debt; new
 * code must not imitate it (scripts/check-no-hand-rolled-cli-entry.mjs).
 */
function isDirectCliInvocation(entryPath = process.argv[1]) {
  return (
    typeof entryPath === 'string' &&
    /(?:^|[\\/])posttooluse-registry-census-drift-nudge\.mjs$/.test(entryPath)
  );
}

if (isDirectCliInvocation()) main();

async function main() {
  if (process.argv.includes('--self-test')) return selfTest();
  try {
    const hook = JSON.parse(await readStdin(250));
    const tool = hook.tool_name || '';
    if (tool !== 'Edit' && tool !== 'Write' && tool !== 'MultiEdit') return done();
    const filePath = (hook.tool_input || {}).file_path || '';
    if (!filePath) return done();

    const msg = await nudgeFor(filePath);
    if (msg) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: msg },
        }) + '\n',
      );
    }
  } catch {
    // fail open — see CONTRACT
  }
  return done();
}

/** True for a TS/TSX source file that could declare a registry — never a test or a d.ts. */
export function isCandidateFile(filePath) {
  const norm = filePath.split(sep).join('/');
  if (!/\.(?:ts|tsx)$/.test(norm)) return false;
  if (/\.d\.ts$/.test(norm)) return false;
  // A census lives IN a test; editing the test is the other half of the fix and
  // must not nudge (the author is already looking at the list).
  if (/\.(?:test|spec)\.[cm]?tsx?$/.test(norm)) return false;
  if (/\.(?:integration|browser)\.test\.[cm]?tsx?$/.test(norm)) return false;
  // Match a leading segment too: a repo-relative path is `node_modules/…` with no
  // leading slash, so an `includes('/node_modules/')` test alone silently accepts it.
  if (/(?:^|\/)(?:node_modules|_retired)\//.test(norm)) return false;
  return true;
}

/**
 * Walk up from the edited file until a directory contains the detector.
 * Returns the repo root, or null. Finding it also PROVES the detector exists.
 */
export function findRepoRoot(filePath, exists = existsSync) {
  let dir = dirname(resolve(filePath));
  for (;;) {
    if (exists(join(dir, DETECTOR_REL))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The advisory text. Exported so the test asserts the real string. */
export function formatNudge(relPath, findings) {
  const lines = [
    '⚠ REGISTRY CENSUS DRIFT — an exact-list test asserts this registry and no longer matches it.',
    `  ${relPath}`,
  ];
  for (const f of findings) {
    lines.push(`    • ${f.identifier}.map(x => x.${f.accessor})  vs  ${f.testFile}`);
    if (f.registryCount !== f.censusCount) {
      lines.push(`        registry has ${f.registryCount} entries; the census lists ${f.censusCount}`);
    }
    for (const k of f.missing) lines.push(`        in the registry, MISSING from the census: '${k}'`);
    for (const k of f.stale) lines.push(`        in the census, GONE from the registry: '${k}'`);
  }
  lines.push(
    '',
    '  That assertion is an EXACT ordered list, so this is not a maybe — the named test',
    '  is red as of this edit. Updating the list now is one line, in a file you can open',
    '  from here. Left alone it reds the fleet green-checkpoint ~an hour from now, where',
    '  it holds main for every agent and costs a ~55min re-run (EI-19401978567233485).',
    '',
    '  Confirm with:',
    '    node scripts/check-registry-census-drift.mjs --check ' + relPath,
  );
  return lines.join('\n');
}

/**
 * The whole check for one edited source file. Returns the advisory string, or null.
 * `deps` is injected by the self-test; production passes nothing.
 */
export async function nudgeFor(filePath, deps = {}) {
  const {
    exists = existsSync,
    readFile = (p) => readFileSync(p, 'utf8'),
    sizeOf = (p) => statSync(p).size,
    showHead = defaultShowHead,
    loadDetector = defaultLoadDetector,
  } = deps;

  if (!isCandidateFile(filePath)) return null;
  const abs = resolve(filePath);
  if (!exists(abs)) return null;
  if (sizeOf(abs) > MAX_BYTES) return null;

  const root = findRepoRoot(abs, exists);
  if (!root) return null;

  const relPath = relative(root, abs).split(sep).join('/');
  const afterText = readFile(abs);
  // A brand-new source file has no HEAD version; treat that as an empty "before"
  // so a registry born already-drifted still fires.
  const beforeText = showHead(root, relPath) ?? '';
  if (beforeText === afterText) return null;

  const detector = await loadDetector(root);
  if (!detector || typeof detector.findCensusDrift !== 'function') return null;

  const after = detector.findCensusDrift(afterText, { root });
  if (!after.findings.length) return null;

  // Only drift this edit is responsible for. A gap already present in the HEAD
  // version was reported on the edit that introduced it; re-nudging for it now
  // trains the reader to ignore the hook — the one failure an advisory cannot
  // survive. Keyed by registry+test so a SECOND drifted registry still fires.
  let beforeKeys = new Set();
  try {
    beforeKeys = new Set(
      detector
        .findCensusDrift(beforeText, { root })
        .findings.map((f) => f.identifier + KEY_SEP + f.testFile),
    );
  } catch {
    beforeKeys = new Set(); // unparseable "before" => report everything, fail loud not silent
  }
  const fresh = after.findings.filter((f) => !beforeKeys.has(f.identifier + KEY_SEP + f.testFile));
  if (!fresh.length) return null;

  return formatNudge(relPath, fresh);
}

function defaultShowHead(root, relPath) {
  try {
    return execFileSync('git', ['show', `HEAD:${relPath}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: MAX_BYTES * 4,
    });
  } catch {
    return null; // new file, submodule path, detached/empty repo — all fail open to '' upstream
  }
}

async function defaultLoadDetector(root) {
  try {
    return await import(`file://${join(root, DETECTOR_REL)}`);
  } catch {
    return null;
  }
}

function done() {
  process.exit(0);
}

function readStdin(timeoutMs) {
  return new Promise((res) => {
    let buf = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      res(buf || '{}');
    };
    const t = setTimeout(finish, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => {
      buf += d;
    });
    process.stdin.on('end', () => {
      clearTimeout(t);
      finish();
    });
    process.stdin.on('error', () => {
      clearTimeout(t);
      finish();
    });
  });
}

async function selfTest() {
  const failures = [];
  const check = (name, cond) => {
    if (!cond) failures.push(name);
  };

  check('isCandidateFile accepts a normal source file', isCandidateFile('packages/x/lib/registry.ts'));
  check('isCandidateFile rejects the census test itself', !isCandidateFile('packages/x/lib/registry.test.ts'));
  check('isCandidateFile rejects an integration test', !isCandidateFile('packages/x/lib/a.integration.test.ts'));
  check('isCandidateFile rejects a .d.ts', !isCandidateFile('packages/x/lib/registry.d.ts'));
  check('isCandidateFile rejects node_modules', !isCandidateFile('node_modules/p/lib/registry.ts'));
  check('isCandidateFile rejects a non-TS file', !isCandidateFile('scripts/thing.mjs'));

  const finding = {
    identifier: 'DEFAULT_CONTENT_DETECTORS',
    accessor: 'key',
    testFile: 'packages/x/lib/registry.test.ts',
    registryCount: 12,
    censusCount: 11,
    missing: [],
    stale: [],
  };
  // Drift keyed on marker text so the fake detector needs no real parsing.
  const fakeDetector = {
    findCensusDrift(text) {
      return text.includes('DRIFT')
        ? { findings: [finding], registriesFound: 1, censusesCompared: 1 }
        : { findings: [], registriesFound: 1, censusesCompared: 1 };
    },
  };
  const base = { exists: () => true, sizeOf: () => 10, loadDetector: async () => fakeDetector };

  const fired = await nudgeFor('/repo/packages/x/lib/registry.ts', {
    ...base,
    showHead: () => 'clean',
    readFile: () => 'DRIFT',
  });
  check('fires when an edit introduces drift', !!fired && fired.includes('registry.test.ts'));
  check('states the arity mismatch', !!fired && fired.includes('12 entries') && fired.includes('lists 11'));
  check('names the confirm command', !!fired && fired.includes('check-registry-census-drift.mjs --check'));

  const clean = await nudgeFor('/repo/packages/x/lib/registry.ts', {
    ...base,
    showHead: () => 'clean',
    readFile: () => 'still clean',
  });
  check('silent when the edit introduces no drift', clean === null);

  const preExisting = await nudgeFor('/repo/packages/x/lib/registry.ts', {
    ...base,
    showHead: () => 'DRIFT',
    readFile: () => 'DRIFT plus an unrelated tweak',
  });
  check('silent when the SAME drift already existed at HEAD', preExisting === null);

  const unchanged = await nudgeFor('/repo/packages/x/lib/registry.ts', {
    ...base,
    showHead: () => 'DRIFT',
    readFile: () => 'DRIFT',
  });
  check('silent when content is unchanged', unchanged === null);

  const brandNew = await nudgeFor('/repo/packages/x/lib/registry.ts', {
    ...base,
    showHead: () => null,
    readFile: () => 'DRIFT',
  });
  check('fires on a brand-new file born drifted', !!brandNew);

  const notSource = await nudgeFor('/repo/packages/x/lib/registry.test.ts', {
    ...base,
    showHead: () => {
      throw new Error('must not be called');
    },
    readFile: () => 'DRIFT',
  });
  check('skips a test path without touching git', notSource === null);

  const noDetector = await nudgeFor('/repo/packages/x/lib/registry.ts', {
    ...base,
    showHead: () => 'clean',
    readFile: () => 'DRIFT',
    loadDetector: async () => null,
  });
  check('fails open when the detector cannot be loaded', noDetector === null);

  if (failures.length) {
    console.error(`posttooluse-registry-census-drift-nudge --self-test FAILED:\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  console.log('posttooluse-registry-census-drift-nudge --self-test: all cases passed');
  process.exit(0);
}
