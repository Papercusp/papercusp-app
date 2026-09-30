#!/usr/bin/env node
/**
 * check-no-proc-path-fixture.mjs — fail-loud guard against a MADE-UP `/proc/...`
 * path literal (EI-19369372064589484).
 *
 * Node's `fs.mkdirSync(path, { recursive: true })` HANGS FOREVER on a non-existent
 * path under `/proc`. procfs answers mkdir with ENOENT, which Node reads as "the
 * parent is missing"; it walks up to `/proc`, gets EEXIST, retries the child, and
 * ping-pongs forever (measured: 44,995 mkdirat syscalls in 3s, 22,488 EEXIST /
 * 22,489 ENOENT). The full mechanism + the safe replacement live in
 * `packages/operator-core/lib/testing/unwritable-path.ts`.
 *
 * The hang is invisible at the call site: coreutils `mkdir -p` on the same path
 * fails in 5ms, so whether a `/proc/...` literal is harmless or catastrophic
 * depends on which mkdir implementation eventually consumes it — something the
 * author of the literal cannot see. Hence a ban on the idiom rather than a rule
 * asking people to trace the consumer.
 *
 *   node scripts/check-no-proc-path-fixture.mjs
 *
 * WHAT IS FLAGGED: a string literal that STARTS with `/proc/` whose first path
 * segment cannot name a real procfs entry — i.e. not a pid, not an interpolation,
 * and not one of the well-known entries in KNOWN_PROCFS_ENTRIES. Real reads
 * (`/proc/${pid}/cmdline`, `/proc/self/environ`, `/proc/version`) are untouched;
 * a fixture path is by construction a made-up name (`/proc/definitely/not/...`).
 *
 * NOT FLAGGED: `/proc/` appearing mid-path (`'/no/such/proc/root'` — a legitimate
 * "this root does not exist" argument), or inside a comment (comments are stripped
 * first, so a comment WARNING about the trap does not itself red the build).
 *
 * The predicates (findProcFixtureOffenders / classifyProcSegment) are exported and
 * unit-tested (packages/operator-core/lib/no-proc-path-fixture-guard.test.ts) so
 * the "fails on a NEW /proc fixture" property is durably verified, not merely
 * green-on-a-clean-tree.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { describeUnscanned, listTrackedFiles } from './lib/tracked-files.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

/** Files that legitimately contain the banned literal (this guard + its tests). */
export const ALLOWLIST = new Set([
  // This guard: its documentation and detection examples contain the banned form.
  'scripts/check-no-proc-path-fixture.mjs',
  // The guard's unit test: its fixtures ARE the banned form, by construction.
  'packages/operator-core/lib/no-proc-path-fixture-guard.test.ts',
]);

/**
 * First path segments that name something real under /proc. A segment outside this
 * set (and not a pid / interpolation) cannot exist, which is precisely the
 * condition that makes recursive mkdir spin.
 */
export const KNOWN_PROCFS_ENTRIES = new Set([
  'self', 'thread-self', 'version', 'version_signature', 'sys', 'net', 'meminfo', 'stat',
  'loadavg', 'uptime', 'cpuinfo', 'mounts', 'mountinfo', 'mountstats', 'pressure', 'vmstat',
  'cmdline', 'diskstats', 'swaps', 'partitions', 'filesystems', 'modules', 'kallsyms',
  'devices', 'interrupts', 'softirqs', 'buddyinfo', 'zoneinfo', 'slabinfo', 'schedstat',
  'crypto', 'iomem', 'ioports', 'misc', 'locks', 'timer_list', 'config.gz', 'key-users',
  'keys', 'sysrq-trigger', 'kmsg', 'kcore', 'kpageflags', 'kpagecount', 'driver', 'fs',
  'irq', 'bus', 'scsi', 'tty', 'acpi', 'asound', 'mdstat', 'cgroups', 'consoles',
  'execdomains', 'dma', 'fb', 'sysvipc', 'sched_debug', 'softnet_stat', 'stat_all',
]);

/** Strip comments so a comment WARNING about the trap never reds the build. */
export function stripComments(text) {
  return (
    text
      // block comments (incl. JSDoc)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      // line comments — but not the `//` inside a `scheme://` URL
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  );
}

/**
 * Classify the first path segment after `/proc/`.
 * @returns 'ok' when it can name a real procfs entry, 'made-up' when it cannot.
 */
export function classifyProcSegment(segment) {
  if (segment === '') return 'ok'; // bare '/proc/' prefix, concatenated elsewhere
  if (segment.includes('$')) return 'ok'; // '${pid}' / '$pid' — resolved at runtime
  if (/^\d+$/.test(segment)) return 'ok'; // a literal pid
  if (KNOWN_PROCFS_ENTRIES.has(segment)) return 'ok';
  return 'made-up';
}

function scanText(text) {
  const offenders = [];
  // Anchored on the opening quote: only a literal that BEGINS with /proc/ counts,
  // so '/no/such/proc/root' (a mid-path occurrence) is correctly ignored.
  const re = /(['"`])\/proc\/([^/'"`\n]*)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const segment = m[2];
    if (classifyProcSegment(segment) === 'made-up') {
      offenders.push({ segment, literal: `/proc/${segment}` });
    }
  }
  return offenders;
}

/**
 * Find every made-up `/proc/...` literal in a source text.
 * @returns array of { segment, literal } — empty when the file is clean.
 *
 * Two passes, because `stripComments` copies the whole file and is the dominant
 * cost on a big one: scan the RAW text first and bail when it is clean. That is
 * exact, not an approximation — stripping comments can only REMOVE matches, never
 * introduce one, so "no match in raw" implies "no match in stripped". Only a file
 * that already looks like an offender pays for the strip + rescan.
 */
export function findProcFixtureOffenders(text) {
  if (scanText(text).length === 0) return [];
  return scanText(stripComments(text));
}

const SCANNED_EXT = /\.(ts|tsx|mjs|cjs|js|jsx)$/;
// `env-sidecars/` holds checked-in esbuild BUNDLES (one is 44MB). Linting a generated
// artifact for a source-level idiom is meaningless — the source it was built from is
// scanned already — and reading/regexing it dominated the whole scan.
const SKIP_DIR = /(^|\/)(node_modules|dist|build|\.next|coverage|_retired|env-sidecars)\//;

/**
 * Candidate pre-filter: a file with no `/proc/` substring at all cannot contain an
 * offender, so `git grep -l` narrows ~6k tracked files to a few dozen. Semantically
 * exact (never widens or narrows the verdict), and takes the tree scan from ~6.7s to
 * well under a second — which matters because this scan runs inside a unit test, not
 * only as a CLI. Returns null when git grep is unusable, so the caller falls back to
 * the exhaustive read.
 */
function candidateSet(cwd) {
  try {
    const out = execFileSync('git', ['grep', '--recurse-submodules', '-l', '-F', '/proc/'], {
      cwd: cwd ?? ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return new Set(out.split('\n').filter(Boolean));
  } catch (err) {
    // exit 1 = "no matches" (a genuinely clean tree), which is a real answer.
    if (err && err.status === 1) return new Set();
    return null; // anything else: fall back to the exhaustive scan
  }
}

// `cwd` defaults to ROOT rather than being left bare: under checkJs a bare
// parameter with no default is REQUIRED, so the no-arg calls this module is
// designed around (main() below, and the guard's own test) became TS2554
// "Expected 1 arguments, but got 0" and red-pinned the fleet gate on lint:tsc.
// Behaviour is unchanged — listTrackedFiles already defaults to the same ROOT
// and candidateSet does `cwd ?? ROOT` — and it matches the idiom the sibling
// guards already use (check-no-ungated-infinite-animation.mjs: `root = ROOT`).
export function findOffenders(cwd = ROOT) {
  const { files, unscanned } = listTrackedFiles(cwd);
  const candidates = candidateSet(cwd);
  const offenders = [];
  for (const f of files) {
    if (candidates && !candidates.has(f)) continue;
    if (!SCANNED_EXT.test(f) || SKIP_DIR.test(f) || ALLOWLIST.has(f)) continue;
    let text;
    try {
      text = readFileSync(new URL('../' + f, import.meta.url).pathname, 'utf8');
    } catch {
      continue;
    }
    for (const hit of findProcFixtureOffenders(text)) offenders.push({ file: f, ...hit });
  }
  return { offenders, unscanned };
}

function main() {
  const { offenders, unscanned } = findOffenders();
  if (offenders.length === 0) {
    console.log(
      '✓ no made-up /proc/… path literals — every /proc reference names a real procfs entry.' +
        describeUnscanned(unscanned),
    );
    process.exit(0);
  }
  console.error('✗ made-up /proc/… path literal(s) — these HANG Node forever:\n');
  console.error("  fs.mkdirSync('/proc/<made-up>', { recursive: true }) never returns: procfs answers");
  console.error('  mkdir with ENOENT, Node reads that as "parent missing", creates /proc (EEXIST),');
  console.error('  retries the child, and ping-pongs forever. The hang happens during vitest');
  console.error('  COLLECTION, so the run emits ZERO output and looks like a queued heavy job.\n');
  console.error('  Use the shared fixture instead — it fails ENOTDIR in 0ms:');
  console.error("    import { UNWRITABLE_PATH_FIXTURE, unwritablePath } from '@papercusp/operator-core/lib/testing/unwritable-path';\n");
  for (const o of offenders) console.error(`    ${o.file}  →  ${o.literal}`);
  console.error(`\n  ${offenders.length} offender(s). See EI-19369372064589484.`);
  process.exit(1);
}

// Run the scan only when invoked as a CLI — importing the module (for the unit test)
// must NOT exec git / exit the process. Symlink-robust (WI-1443): node realpaths
// import.meta.url while argv[1] keeps the invoked path, so also compare realpaths.
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
if (isMain) {
  main();
}
