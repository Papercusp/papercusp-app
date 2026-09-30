#!/usr/bin/env node
/**
 * check-no-control-bytes.mjs — fail-loud guard for raw control bytes in source.
 *
 * EI-7432: a raw NUL byte in a TypeScript source file made ripgrep classify it
 * as binary and silently skip it, so repo-wide searches "proved" code absent
 * while the file still contained it. This guard scans tracked text-source files
 * as Buffers and rejects invisible control bytes before search tooling goes
 * blind.
 *
 *   node scripts/check-no-control-bytes.mjs
 *   node scripts/check-no-control-bytes.mjs --self-test
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describeUnscanned } from './lib/tracked-files.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.mjs',
  '.cjs',
  '.js',
  '.jsx',
  '.rs',
  '.md',
  '.mdx',
  '.json',
  '.yml',
  '.yaml',
  '.sql',
  '.sh',
  '.toml',
]);

// Prefixes for genuinely binary-ish fixtures that are intentionally tracked as
// source-like paths.
export const ALLOW_PREFIXES = [
  // WI-5450: minified, machine-generated pagefind search-index bundle, mirrored into
  // apps/operator/public by apps/operator-docs's postbuild-copy.sh on every docs build
  // (not hand-authored source — regenerated wholesale from the upstream `pagefind` npm
  // package's own output, which uses raw \x01/\x02 sentinel bytes internally for its
  // highlight-matching algorithm). Hand-editing it is pointless (the next docs build
  // overwrites it) and it isn't "our" source to rewrite.
  'apps/operator/public/internal/docs/pagefind/',
  // EI-18896048946123172: the packaged desktop sidecar — a wholesale build artifact
  // (a 42MB bundled `serve.mjs` plus hash-named Vite chunks under spa/assets/) that
  // only became visible once this guard started recursing into submodules. Bundlers
  // legitimately emit raw \x01-\x1f inside minified string tables (xterm's parser
  // tables are the bulk of it). It is regenerated wholesale by the desktop build, so
  // editing it is pointless and it is not hand-authored source.
  'papercusp-desktop/src-tauri/env-sidecars/',
  // WI-39392: the docs build also mirrors pagefind to `public/docs/pagefind/`, not only to
  // `public/internal/docs/pagefind/` above. Both copies are the SAME wholesale-regenerated
  // upstream artifact with the same raw \x01/\x02 highlight sentinels; only one path was
  // ever allowed, so the second copy red-pinned the fleet gate the moment a docs build
  // produced it. Keep the two prefixes adjacent — if the mirror target moves again, this
  // is the list that has to move with it.
  'apps/operator/public/docs/pagefind/',
  // WI-212675: `apps/operator/dist-sidecar/` is the esbuild-bundled embed-sidecar output
  // (a 50MB+ `embed-sidecar.mjs`, wholesale-regenerated and re-committed by git-sync on
  // every build) — the same class of build artifact as the two prefixes above, and already
  // excluded by name in at least 8 sibling content guards (check-no-raw-setinterval,
  // check-no-eager-execfile-promisify, check-no-module-scope-flag-subscribe,
  // check-no-deployed-liveness-read, check-no-hand-rolled-module-pin,
  // check-no-unthreaded-apply, check-no-unhosted-remote-core,
  // check-no-hand-rolled-cli-entry). This guard was the one omission: the bundler's
  // ascii-escape pass legitimately emits raw \x01-\x1f inside minified string tables, and
  // hand-editing a regenerated bundle is pointless — it is not hand-authored source.
  'apps/operator/dist-sidecar/',
];

/**
 * Vendored dependency trees are never hand-authored source.
 *
 * `git ls-files --recurse-submodules` walks INTO submodules, and several of them track
 * their own `node_modules/` (measured: 762 tracked files under a `node_modules/` segment).
 * Minified dependency bundles legitimately carry raw \x01-\x1f inside string tables — so
 * scanning them turns a guard about OUR source into a guard about our dependencies'
 * build output, which nobody can act on: the remedy this script prints ("write the
 * character as an escape") is impossible in a file that is reinstalled wholesale by npm.
 * Excluded as a SEGMENT rather than a prefix so it holds at any depth, in any submodule.
 */
function isVendoredDependencyPath(file) {
  return file === 'node_modules' || file.startsWith('node_modules/') || file.includes('/node_modules/');
}

export function isForbiddenControlByte(byte) {
  return byte === 0 || (byte >= 1 && byte <= 8) || byte === 0x0b || byte === 0x0c || (byte >= 0x0e && byte <= 0x1f);
}

export function findControlBytes(path, buffer) {
  const hits = [];
  for (let offset = 0; offset < buffer.length; offset++) {
    const byte = buffer[offset];
    if (!isForbiddenControlByte(byte)) continue;
    const start = Math.max(0, offset - 16);
    const end = Math.min(buffer.length, offset + 17);
    hits.push({
      path,
      offset,
      byte,
      contextHex: buffer.subarray(start, end).toString('hex').match(/.{1,2}/g)?.join(' ') ?? '',
    });
  }
  return hits;
}

function extensionOf(file) {
  const slash = file.lastIndexOf('/');
  const dot = file.lastIndexOf('.');
  if (dot <= slash) return '';
  return file.slice(dot);
}

// Exported so the edit-time PreToolUse guard (pretooluse-control-bytes-content-guard.mjs,
// EI-19478121013052934) scopes itself to EXACTLY the set this gate scans, rather than
// re-deriving it. A re-derived copy drifts, and both drift directions cost: too wide and
// the guard blocks an edit the gate would have accepted; too narrow and it waves through
// the very byte that red-pins the fleet gate an hour later.
export function isScannedPath(file) {
  if (isVendoredDependencyPath(file)) return false;
  return SOURCE_EXTENSIONS.has(extensionOf(file)) && !ALLOW_PREFIXES.some((prefix) => file.startsWith(prefix));
}

function gitLines(args, cwd = ROOT) {
  return execFileSync('git', args, { cwd, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

function trackedSourceFiles() {
  // EI-18896048946123172: `git ls-files` STOPS AT THE SUPERPROJECT BOUNDARY. A submodule
  // is listed as a single gitlink entry with no file extension, so `isScannedPath` dropped
  // it and everything inside it was never opened. That silently exempted 4,531 tracked
  // source files (~24% of the tree) — all of libs/generic/**, libs/papercusp/** and
  // papercusp-desktop/** — which is why this guard printed "clean" for three days while a
  // raw NUL byte sat in libs/generic/sync/src/persisted-cache.ts and turned that file
  // binary to git diff and to ugrep.
  return gitLines(['ls-files', '-z', '--recurse-submodules']).filter(isScannedPath);
}

/**
 * Submodule prefixes, from gitlink index entries (mode 160000).
 *
 * Deliberately read from an oracle INDEPENDENT of the recursing listing above: if
 * `--recurse-submodules` ever stops recursing, this still enumerates the submodules, so
 * the coverage check below can falsify the scan instead of trusting it.
 */
export function submodulePrefixes() {
  return gitLines(['ls-files', '-s', '-z'])
    .filter((line) => line.startsWith('160000 '))
    .map((line) => `${line.slice(line.indexOf('\t') + 1)}/`);
}

/**
 * Submodules that hold scannable source but contributed ZERO files to the scan — i.e. the
 * selection silently skipped them. Returns [] when coverage is sound.
 */
export function uncoveredSubmodules(scanned, prefixes = submodulePrefixes()) {
  const missing = [];
  for (const prefix of prefixes) {
    if (scanned.some((file) => file.startsWith(prefix))) continue;
    if (!existsSync(join(ROOT, prefix))) continue; // submodule not checked out here
    let own;
    try {
      own = gitLines(['ls-files', '-z'], join(ROOT, prefix));
    } catch {
      continue; // not a usable git dir — nothing to assert
    }
    // Only a submodule that genuinely holds files this guard WOULD scan is a coverage gap.
    if (own.some((file) => isScannedPath(prefix + file))) missing.push(prefix);
  }
  return missing;
}

function scanTree() {
  const scanned = trackedSourceFiles();
  const offenders = [];
  for (const file of scanned) {
    let buf;
    try {
      buf = readFileSync(join(ROOT, file));
    } catch {
      continue; // File vanished between git ls-files and read.
    }
    offenders.push(...findControlBytes(file, buf));
  }
  return { offenders, scanned };
}

function runSelfTest() {
  const cases = [
    { name: 'clean source', buffer: Buffer.from('const x = "ok";\n'), count: 0 },
    { name: 'allows tab newline carriage return', buffer: Buffer.from('a\tb\nc\rd'), count: 0 },
    { name: 'flags NUL', buffer: Buffer.from([0x63, 0x00, 0x64]), count: 1, byte: 0x00 },
    { name: 'flags vertical tab', buffer: Buffer.from([0x61, 0x0b, 0x62]), count: 1, byte: 0x0b },
    { name: 'flags unit separator', buffer: Buffer.from([0x61, 0x1f, 0x62]), count: 1, byte: 0x1f },
  ];
  let failed = 0;
  for (const c of cases) {
    const hits = findControlBytes('fixture.ts', c.buffer);
    const ok = hits.length === c.count && (c.byte === undefined || hits[0]?.byte === c.byte);
    if (!ok) {
      failed++;
      console.error(`  x ${c.name} — got ${JSON.stringify(hits)}`);
    }
  }
  // Coverage logic (EI-18896048946123172). Both branches are exercised without touching a
  // real submodule: a prefix the scan reached, and a prefix that is not checked out here
  // (which must NOT raise — an absent submodule is not a coverage gap).
  const coverageCases = [
    {
      name: 'submodule reached by the scan is covered',
      scanned: ['libs/fake-sub/a.ts'],
      prefixes: ['libs/fake-sub/'],
      expect: 0,
    },
    {
      name: 'submodule not checked out is not a gap',
      scanned: [],
      prefixes: ['libs/definitely-not-checked-out-here/'],
      expect: 0,
    },
  ];
  for (const c of coverageCases) {
    const got = uncoveredSubmodules(c.scanned, c.prefixes);
    if (got.length !== c.expect) {
      failed++;
      console.error(`  x ${c.name} — got ${JSON.stringify(got)}`);
    }
  }

  const total = cases.length + coverageCases.length;
  if (failed) {
    console.error(`\ncheck-no-control-bytes --self-test: ${failed} case(s) FAILED`);
    process.exit(1);
  }
  console.log(`check-no-control-bytes --self-test: all ${total} cases passed`);
}

function main() {
  if (process.argv.includes('--self-test')) {
    runSelfTest();
    return;
  }
  const { offenders, scanned } = scanTree();

  // A "clean" verdict is worth exactly as much as the set it looked at. EI-18896048946123172:
  // this guard printed "clean" for three days while scanning NONE of the submodules, so the
  // scan must now prove its own coverage before it is allowed to pass. This is the guard
  // against the failure the guard itself exists to prevent — a confident zero from an
  // instrument nobody proved was pointed at the thing being measured.
  const uncovered = uncoveredSubmodules(scanned);
  if (uncovered.length > 0) {
    console.error(
      `\ncheck-no-control-bytes: COVERAGE GAP — ${uncovered.length} submodule(s) hold files this guard ` +
        'would scan but contributed ZERO to the scan.\n' +
        'A pass here would be evidence of nothing. Check that `git ls-files --recurse-submodules` still recurses.\n',
    );
    for (const prefix of uncovered) console.error(`  unscanned submodule: ${prefix}`);
    process.exit(1);
  }

  if (offenders.length === 0) {
    // WI-6776: this line used to report `submodulePrefixes().length` — the count of
    // gitlink entries in the INDEX, which is 38 whether or not a single submodule file
    // was opened. Measured 2026-08-02 in papercusp-checkpoint (this gate's own tree):
    // the scan covered ZERO submodules and still printed "and 38 submodule(s)", i.e.
    // the success line asserted the exact opposite of what happened.
    //
    // That tree's shape VARIES (it read 38/39 sixteen minutes later, after a rebuild
    // registered its submodules — see scripts/lib/tracked-files.mjs for the full shape
    // table), which is precisely why this must be measured per-run and not assumed.
    // Report what was actually reached, as a RATIO, so an empty scan cannot read clean.
    const prefixes = submodulePrefixes();
    const covered = prefixes.filter((p) => scanned.some((f) => f.startsWith(p)));
    const unscanned = prefixes.filter((p) => !covered.includes(p));
    console.log(
      `check-no-control-bytes: clean — ${scanned.length} tracked source files scanned ` +
        `across the superproject and ${covered.length}/${prefixes.length} submodule(s), ` +
        `no forbidden raw control bytes` +
        describeUnscanned({ declared: prefixes, scanned: covered, unscanned }, ROOT),
    );
    return;
  }
  const files = new Set(offenders.map((o) => o.path));
  console.error(
    `\ncheck-no-control-bytes: ${offenders.length} forbidden raw control byte(s) in ${files.size} file(s), of ${scanned.length} scanned.\n` +
      'These bytes make tools like ripgrep treat source as binary and silently skip it (EI-7432),\n' +
      'and a NUL additionally makes git diff render the file as binary — so review goes blind too.\n' +
      "FIX: write the character as an ESCAPE ('\\x1b', '\\u001f') rather than a raw byte — the runtime\n" +
      'string is byte-identical, but the source stays greppable and diffable. For a generated/vendored\n' +
      'artifact that is not hand-authored source, add a narrow prefix to ALLOW_PREFIXES with a reason.\n',
  );
  for (const o of offenders) {
    console.error(
      `  ${o.path}:${o.offset} byte=0x${o.byte.toString(16).padStart(2, '0')} context=${o.contextHex}`,
    );
  }
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main();
}
