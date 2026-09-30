#!/usr/bin/env node
/**
 * check-unreachable-tier-mock.mjs — mechanical detector for the UNREACHABLE-TIER
 * MOCK class (WI-38314, residue of WI-38289 / P-068 / D-098).
 *
 * ## THE CLASS
 *
 * A source predicate collapses to a CONSTANT — `export async function
 * mugKettleSystemEnabled() { return false; }` — because the flag it used to read
 * was deleted. No input can make it true. A test that installs a mock supplying
 * that same export as the OPPOSITE constant is therefore asserting a state
 * production cannot reach: the assertions pass, they read as ordinary live
 * coverage, and they keep dead branches alive through every future refactor.
 *
 * Nothing fails. That is the whole problem — this defect's only symptom is a
 * green suite, so it is found by reading, or not at all.
 *
 * ## WHY A DETECTOR, SPECIFICALLY
 *
 * WI-38314 was filed with a hand-enumerated list of seven sites and the sentence
 * "No detector exists for this class today; these seven were found by hand and
 * the next one will be too." Auditing that list against the tree found THREE of
 * the seven were misclassified — two documented calibration controls and a whole
 * family of deliberate gated-tool neutralisations. A hand census that is 57%
 * accurate on its own author's re-read is not a method; it is the argument for
 * this file.
 *
 * ## WHAT IS A VIOLATION, AND WHAT DELIBERATELY IS NOT
 *
 * ⚠ THE SCOPE IS THE FILE-WIDE DEFAULT, NOT THE IMPOSSIBLE VALUE ITSELF. Entering
 * a tier-impossible state is legitimate and often necessary; INHERITING it
 * silently is the defect. So:
 *
 *   VIOLATION — the mock's DECLARED DEFAULT is the impossible constant. The
 *       polarity is baked into the `vi.mock` factory (or the module-scope binding
 *       it delegates to), so every case in the file starts there and no case says
 *       so. Nothing at the call site distinguishes a test that MEANT to drive the
 *       retired branch from one that merely inherited it.
 *
 *   NOT A VIOLATION — a LOCAL re-open inside a `beforeEach`/`it`
 *       (`predicate.mockResolvedValue(true)`). That is the prescribed shape: the
 *       label travels with the coverage, and the surrounding file still defaults
 *       to production truth. `pot/placement-watchdog.test.ts` has done it this way
 *       all along — its two tier-open sites are CALIBRATION controls that make its
 *       absence assertions falsifiable, which is the opposite of dead coverage.
 *       Flagging those would be flagging the fix.
 *
 *   NOT A VIOLATION — a MUTABLE knob (`mugKettleSystemEnabled: async () => KNOB.on`).
 *       Not a constant, so not this class; a knob that drives nothing is the
 *       DIFFERENT class `check-vacuous-flag-guard.mjs` already detects.
 *
 *   node scripts/check-unreachable-tier-mock.mjs             # gate
 *   node scripts/check-unreachable-tier-mock.mjs --list      # the measured population
 *   node scripts/check-unreachable-tier-mock.mjs --self-test # the falsifiability controls
 *
 * ## FALSIFIABILITY
 *
 * `--self-test` carries permanently-wrong fixtures (a violating file, and the
 * compliant shapes it must stay silent on) as in-file controls. That is the tier-1
 * form from CLAUDE.md § "Proving a guard is falsifiable": no tree mutation, so no
 * git-sync sweep can commit a mutant and no trap is needed to restore anything.
 *
 * ## MATCH ON MASKED, READ ON RAW
 *
 * Same discipline as check-full-replacement-mocks.mjs: structure is found on the
 * comment/string-masked text (this file's own header would otherwise mint phantom
 * offenders out of its own prose), while the `vi.mock` SPECIFIER is read from the
 * raw text at the same offsets, because the mask is length-preserving.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripCommentsAndStrings } from './lib/strip-comments-and-strings.mjs';
import { runGuardWithIndexFaultGuard, withGitIndexFaultRetry } from './lib/git-index-fault.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Sites whose declared default is the impossible constant ON PURPOSE.
 *
 * Keyed `<test path>::<export name>`. An entry is a real claim — that the file
 * cannot express its subject any other way — and it re-arms the class for that
 * file, so prefer a labelled local re-open over adding one.
 */
const ALLOW = new Map([
  [
    'packages/operator-core/lib/agent-tools/pot/tools.test.ts::mugKettleSystemEnabled',
    'GATED-TOOL NEUTRALISATION, not dead coverage. These tools open with ' +
      '`refuseIfMugKettleRetired` (agent-tools/_mug-kettle-gate.ts), which returns its refusal ' +
      'envelope BEFORE the handler body runs — so with the real predicate the suite reaches no ' +
      'subject at all and every assertion fails as `Number of calls: 0`. The default IS the ' +
      'subject here. It is also the awareness marker `mug-kettle-gate-strands-suite.test.ts` ' +
      '(WI-37732) matches on, so removing it trips that guard too. This coverage retires when ' +
      'the retired TOOLS are deleted, per D-098 (per-file, with tests) — never before.',
  ],
  [
    'packages/operator-core/lib/agent-tools/pot/start-pause.test.ts::mugKettleSystemEnabled',
    'Gated-tool neutralisation — see the tools.test.ts entry above.',
  ],
  [
    'packages/operator-core/lib/agent-tools/pot/set_steering.test.ts::mugKettleSystemEnabled',
    'Gated-tool neutralisation — see the tools.test.ts entry above. This is the suite whose ' +
      'strand red-pinned the shared green gate on 2026-08-10 (WI-37732 §The incident).',
  ],
  [
    'packages/operator-core/lib/agent-tools/pot/wake-paused-gate.test.ts::mugKettleSystemEnabled',
    'Gated-tool neutralisation — see the tools.test.ts entry above.',
  ],
]);

// ---------------------------------------------------------------------------
// Pure analysis
// ---------------------------------------------------------------------------

/** Index of the ')' / '}' closing the opener at `open`, or -1. */
function matchDelim(text, open) {
  const closer = { '(': ')', '{': '}' }[text[open]];
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (c === '(' || c === '{' || c === '[') depth += 1;
    else if (c === ')' || c === '}' || c === ']') {
      depth -= 1;
      if (depth === 0) return text[i] === closer ? i : -1;
    }
  }
  return -1;
}

/** Index of the top-level ',' inside a call's argument list, or -1. */
function firstTopLevelComma(text, open, close) {
  let depth = 0;
  for (let i = open; i < close; i += 1) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (c === ',' && depth === 1) return i;
  }
  return -1;
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/**
 * Exported functions in ONE source file whose entire body is a constant return.
 * Returns [{ name, value: 'true'|'false', line }].
 *
 * Deliberately conservative: a body with ANY other statement is not a constant
 * predicate, and a false negative here only costs a missed detection, while a
 * false positive would flag a legitimately-toggled mock as dead coverage.
 */
export function findConstantPredicates(text, fileName) {
  const scan = stripCommentsAndStrings(text, fileName);
  const out = [];

  const FN = /\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = FN.exec(scan))) {
    const name = m[1];
    const paren = m.index + m[0].length - 1;
    const parenEnd = matchDelim(scan, paren);
    if (parenEnd === -1) continue;
    const brace = scan.indexOf('{', parenEnd);
    if (brace === -1) continue;
    const braceEnd = matchDelim(scan, brace);
    if (braceEnd === -1) continue;
    const body = scan.slice(brace + 1, braceEnd);
    const constant = /^\s*return\s+(true|false)\s*;?\s*$/.exec(body);
    if (constant) out.push({ name, value: constant[1], line: lineOf(text, m.index) });
    FN.lastIndex = braceEnd;
  }

  const ARROW = /\bexport\s+const\s+([A-Za-z_$][\w$]*)[^=\n]*=\s*(?:async\s*)?\([^)]*\)[^=]*=>\s*(true|false)\s*;/g;
  while ((m = ARROW.exec(scan))) out.push({ name: m[1], value: m[2], line: lineOf(text, m.index) });

  return out;
}

/**
 * The constant a mock-value expression resolves to, or null when it is not a
 * constant (a mutable knob, a plain `vi.fn()`, an identifier we cannot follow).
 */
export function constantOf(expr) {
  const arrow = /=>\s*(true|false)\b/.exec(expr);
  if (arrow) return arrow[1];
  const resolved = /mock(?:ResolvedValue|ReturnValue)(?:Once)?\s*\(\s*(true|false)\s*\)/.exec(expr);
  if (resolved) return resolved[1];
  return null;
}

/** Module-scope `const <name> = <init>` bindings, so a factory can delegate to one. */
function moduleScopeBindings(scan) {
  const out = new Map();
  // `const x = ...;`  and the object-literal properties of `vi.hoisted(() => ({ x: ... }))`.
  const CONST = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]+);/g;
  let m;
  while ((m = CONST.exec(scan))) out.set(m[1], m[2]);
  const PROP = /([A-Za-z_$][\w$]*)\s*:\s*(vi\.(?:fn|hoisted)[^,}]*)/g;
  while ((m = PROP.exec(scan))) if (!out.has(m[1])) out.set(m[1], m[2]);
  return out;
}

/**
 * Sites in ONE test file whose mock DEFAULT contradicts a constant predicate.
 * `predicates` maps a resolved module path (extension-stripped) to its
 * [{ name, value }] constant exports.
 */
export function checkFile({ path, text, predicates, allow = ALLOW, suppressed = new Set() }) {
  const scan = stripCommentsAndStrings(text, path);
  const bindings = moduleScopeBindings(scan);
  const violations = [];

  const MOCK_CALL = /\bvi\.(?:mock|doMock)\s*\(/g;
  let m;
  while ((m = MOCK_CALL.exec(scan))) {
    const open = m.index + m[0].length - 1;
    const close = matchDelim(scan, open);
    if (close === -1) continue;
    // The one read that must come from RAW text: the specifier lives inside the
    // quotes the mask emptied. Same offsets — the mask preserves length.
    const spec = /^\s*(['"])([^'"]+)\1/.exec(text.slice(open + 1, close));
    MOCK_CALL.lastIndex = close;
    if (!spec) continue;
    const resolved = resolveSpec(path, spec[2]);
    if (!resolved) continue;
    const exported = predicates.get(resolved);
    if (!exported) continue;

    const comma = firstTopLevelComma(scan, open, close);
    if (comma === -1) continue; // automock: vitest synthesises the surface, no polarity declared
    const factory = scan.slice(comma + 1, close);

    for (const { name, value } of exported) {
      const prop = new RegExp(`\\b${name}\\s*:\\s*([^,]*(?:\\([^)]*\\)[^,]*)*)`).exec(factory);
      // SHORTHAND property — `vi.mock('./started', () => ({ mugKettleSystemEnabled }))`.
      // There is no `name:` to read, so a key-value-only reader sees nothing and the
      // file reads as clean; the polarity lives entirely on the hoisted binding, which
      // is where the one-hop resolution below already looks. This is the shape the real
      // subject (pot/wake-coherence.test.ts) uses, so missing it made the guard blind to
      // its own headline case (WI-38314 follow-up, measured by mutation 2026-09-09).
      const expr = prop ? prop[1] : new RegExp(`[{,]\\s*${name}\\s*(?=[,}])`).test(factory) ? name : null;
      if (expr === null) continue;
      let declared = constantOf(expr);
      if (declared === null) {
        // One hop: the factory delegates to a module-scope binding (the common
        // `const p = vi.fn(async () => true)` + `p: (...a) => p(...a)` shape).
        for (const [ident, init] of bindings) {
          if (!new RegExp(`\\b${ident}\\b`).test(expr)) continue;
          declared = constantOf(init);
          if (declared !== null) break;
        }
      }
      if (declared === null) continue; // mutable knob — a different class entirely
      if (declared === value) continue; // agrees with production
      const key = `${path}::${name}`;
      if (allow.has(key)) {
        // Record that this entry SUPPRESSED something. An entry that never fires is
        // a vacuous suppression — the same defect this guard exists to detect, one
        // level up: it reads as a considered exception while protecting nothing, and
        // it silently survives the rename or the fix that made it obsolete.
        suppressed.add(key);
        continue;
      }
      violations.push({ path, name, line: lineOf(text, m.index), declared, actual: value, spec: spec[2] });
    }
  }
  return violations;
}

export function resolveSpec(filePath, spec) {
  if (!spec.startsWith('.')) return null;
  return normalize(join(dirname(filePath), spec)).replace(/\.(?:[cm]?[jt]sx?)$/, '');
}

// ---------------------------------------------------------------------------
// Falsifiability controls — permanently-wrong fixtures, never a tree mutation
// ---------------------------------------------------------------------------

const FIXTURE_PREDICATES = new Map([['pkg/lib/started', [{ name: 'tierEnabled', value: 'false' }]]]);

const SELF_TESTS = [
  {
    name: 'CONTROL: a factory default of the impossible constant is caught',
    path: 'pkg/lib/x.test.ts',
    text: `vi.mock('./started', () => ({ tierEnabled: async () => true }));`,
    expect: 1,
  },
  {
    name: 'CONTROL: caught through one identifier hop (the vi.fn delegate shape)',
    path: 'pkg/lib/x.test.ts',
    text:
      `const tierEnabled = vi.fn(async () => true);\n` +
      `vi.mock('./started', () => ({ tierEnabled: (...a) => tierEnabled(...a) }));`,
    expect: 1,
  },
  {
    name: 'CONTROL: caught when the default is declared via mockResolvedValue',
    path: 'pkg/lib/x.test.ts',
    text: `vi.mock('./started', () => ({ tierEnabled: vi.fn().mockResolvedValue(true) }));`,
    expect: 1,
  },
  {
    name: 'CONTROL: caught through a SHORTHAND factory property over a hoisted binding',
    path: 'pkg/lib/x.test.ts',
    text:
      `const { tierEnabled } = vi.hoisted(() => ({ tierEnabled: vi.fn().mockResolvedValue(true) }));\n` +
      `vi.mock('./started', () => ({ tierEnabled }));`,
    expect: 1,
  },
  {
    name: 'CALIBRATION: silent when the default AGREES with production',
    path: 'pkg/lib/x.test.ts',
    text: `vi.mock('./started', () => ({ tierEnabled: async () => false }));`,
    expect: 0,
  },
  {
    name: 'CALIBRATION: silent on the SHORTHAND shape when the hoisted default agrees',
    path: 'pkg/lib/x.test.ts',
    text:
      `const { tierEnabled } = vi.hoisted(() => ({ tierEnabled: vi.fn().mockResolvedValue(false) }));\n` +
      `vi.mock('./started', () => ({ tierEnabled }));`,
    expect: 0,
  },
  {
    name: 'CALIBRATION: silent on a LOCAL re-open — the prescribed shape',
    path: 'pkg/lib/x.test.ts',
    text:
      `vi.mock('./started', () => ({ tierEnabled: vi.fn().mockResolvedValue(false) }));\n` +
      `beforeEach(() => { tierEnabled.mockResolvedValue(true); });`,
    expect: 0,
  },
  {
    name: 'CALIBRATION: silent on a MUTABLE knob (a different class)',
    path: 'pkg/lib/x.test.ts',
    text: `vi.mock('./started', () => ({ tierEnabled: async () => KNOB.on }));`,
    expect: 0,
  },
  {
    name: 'CALIBRATION: silent on a mock of some OTHER module with the same export name',
    path: 'pkg/lib/x.test.ts',
    text: `vi.mock('./elsewhere', () => ({ tierEnabled: async () => true }));`,
    expect: 0,
  },
  {
    name: 'CALIBRATION: the violating shape inside a COMMENT is not an offender',
    path: 'pkg/lib/x.test.ts',
    text: `// vi.mock('./started', () => ({ tierEnabled: async () => true }));`,
    expect: 0,
  },
  {
    name: 'CALIBRATION: the violating shape inside a STRING fixture is not an offender',
    path: 'pkg/lib/x.test.ts',
    text: `const bad = \`vi.mock('./started', () => ({ tierEnabled: async () => true }));\`;`,
    expect: 0,
  },
];

const PREDICATE_SELF_TESTS = [
  { name: 'a constant `return false` predicate is found', text: `export async function p(): Promise<boolean> { return false; }`, expect: 1 },
  { name: 'a predicate with real logic is NOT constant', text: `export async function p() { return await getFlag('x'); }`, expect: 0 },
  { name: 'a constant arrow export is found', text: `export const p = async (): Promise<boolean> => false;`, expect: 1 },
  { name: 'a `return false` inside a comment is not a predicate', text: `// export function p() { return false; }`, expect: 0 },
];

function runSelfTest() {
  let failed = 0;
  for (const t of PREDICATE_SELF_TESTS) {
    const got = findConstantPredicates(t.text, 'x.ts').length;
    const ok = got === t.expect;
    if (!ok) failed += 1;
    console.log(`  ${ok ? '✓' : '✗'} ${t.name} (expected ${t.expect}, got ${got})`);
  }
  for (const t of SELF_TESTS) {
    const got = checkFile({ path: t.path, text: t.text, predicates: FIXTURE_PREDICATES }).length;
    const ok = got === t.expect;
    if (!ok) failed += 1;
    console.log(`  ${ok ? '✓' : '✗'} ${t.name} (expected ${t.expect}, got ${got})`);
  }
  const total = SELF_TESTS.length + PREDICATE_SELF_TESTS.length;
  console.log(`\n${total - failed}/${total} self-tests passed`);
  return failed === 0;
}

// ---------------------------------------------------------------------------
// Thin I/O shell
// ---------------------------------------------------------------------------

// EI-22703095921400106: a torn `.git/index` on the shared staging tree made this call throw
// `fatal: .git/index: index file smaller than expected`, which the affected runner read as a
// LINT VIOLATION rather than "the instrument could not read the repository". Retry the
// known-transient index fault (git-sync repairs it), then surrender as NOT CHECKED — never as a
// finding. Every other git error still propagates untouched.
function gitFiles(...globs) {
  return withGitIndexFaultRetry(() =>
    execFileSync('git', ['ls-files', ...globs], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }),
  )
    .split('\n')
    .filter(Boolean)
    // WI-10004176: drop index entries a peer's plain `rm` left behind until git-sync commits it.
    .filter((f) => existsSync(join(ROOT, f)));
}

const isTest = (f) => /\.(?:test|spec)\.tsx?$/.test(f);
const read = (f) => {
  try {
    return readFileSync(join(ROOT, f), 'utf8');
  } catch {
    return null;
  }
};

function collectPredicates() {
  const predicates = new Map();
  for (const f of gitFiles('packages/**/*.ts', 'libs/**/*.ts', 'apps/**/*.ts')) {
    if (isTest(f) || f.includes('/node_modules/')) continue;
    const text = read(f);
    // Cheap pre-filter: a constant predicate must contain a bare constant return.
    if (text === null || !/return\s+(?:true|false)\s*;/.test(text)) continue;
    const found = findConstantPredicates(text, f);
    if (found.length > 0) predicates.set(f.replace(/\.tsx?$/, ''), found);
  }
  return predicates;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) process.exit(runSelfTest() ? 0 : 1);

  const predicates = collectPredicates();
  const tests = gitFiles('**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx').filter(
    (f) => !f.includes('/node_modules/'),
  );

  const violations = [];
  const suppressed = new Set();
  let scanned = 0;
  for (const f of tests) {
    const text = read(f);
    if (text === null || !text.includes('vi.mock')) continue;
    scanned += 1;
    violations.push(...checkFile({ path: f, text, predicates, suppressed }));
  }
  // A suppression that suppresses NOTHING is the defect this guard detects, one
  // level up: it reads as a considered exception while protecting nothing, and it
  // outlives the rename or the fix that made it obsolete. Both causes are
  // actionable — repoint the entry, or delete it — so this fails rather than warns.
  const stale = [...ALLOW.keys()].filter((k) => !suppressed.has(k));

  if (argv.includes('--list')) {
    console.log(`constant predicates (${predicates.size} module(s)):\n`);
    for (const [mod, exps] of predicates) {
      console.log(`  ${mod}\n      ${exps.map((e) => `${e.name}() === ${e.value}  (:${e.line})`).join('\n      ')}`);
    }
    console.log(`\nallowlisted defaults (${ALLOW.size}, ${suppressed.size} of them BINDING):`);
    for (const [key, why] of ALLOW) console.log(`  ${suppressed.has(key) ? '●' : '○ STALE'} ${key}\n      ${why}\n`);
    console.log(`test files scanned: ${scanned}; violations: ${violations.length}`);
    process.exit(0);
  }

  if (stale.length > 0) {
    console.error(`✗ unreachable-tier-mock: ${stale.length} STALE allowlist entr(y/ies) — each suppressed nothing.\n`);
    console.error('  An exception that protects nothing is indistinguishable from a considered one, and it');
    console.error('  outlives the rename or the fix that made it obsolete. Repoint it, or delete it:\n');
    for (const k of stale) console.error(`    ${k}`);
    process.exit(1);
  }

  if (violations.length === 0) {
    console.log(
      `✓ unreachable-tier-mock: ${predicates.size} constant predicate module(s), ` +
        `${scanned} mocking test file(s) scanned, ${suppressed.size}/${ALLOW.size} allowlist entries binding ` +
        `— no impossible mock defaults.`,
    );
    process.exit(0);
  }

  console.error(`✗ unreachable-tier-mock: ${violations.length} mock default(s) contradict a CONSTANT predicate.\n`);
  console.error('  The predicate can only ever return the value shown as `production`, so every case in the');
  console.error('  file starts in a state production cannot reach — and nothing at the call site says so.');
  console.error('  FIX: default the mock to production truth, and re-open the impossible state LOCALLY');
  console.error('  (a beforeEach/it inside the describe that needs it) with the reason attached — see');
  console.error('  packages/operator-core/lib/pot/placement-watchdog.test.ts for the shape.\n');
  for (const v of violations) {
    console.error(`    ${v.path}:${v.line}  →  ${v.name}`);
    console.error(`        mocked default: ${v.declared}   production: ${v.actual}   (via '${v.spec}')`);
  }
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runGuardWithIndexFaultGuard(main, { guard: 'unreachable-tier-mock' });
}
