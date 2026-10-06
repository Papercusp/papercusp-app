#!/usr/bin/env node
/**
 * lint:refusal-contracts — a fail-closed refusal must say what would LIFT it.
 *
 * ## What it detects
 *
 * An object literal, in non-test operator code, that carries a `code` naming a
 * refusal (`…_refused`, `…_denied`, `capability_unsatisfied`, `…_violation`,
 * `…_blocked`, `forbidden`, `…_not_allowed`) and NO contract key (`refusal` or
 * `liftsWhen`). The contract is the `RefusalContract` shape from
 * capability-envelope/identity-refusal-contract.ts: what would lift the refusal,
 * who can make that true, and the values it compared.
 *
 * WHY: a refusal with no lift condition turns a recoverable state into tribal
 * knowledge (a fact + sudo + psql + knowing the item number). EI-23766133296678780
 * gave the identity gate its contract; this is the ratchet that stops the NEXT
 * refusal being written without one (WI-10005192).
 *
 * ## How it measures — AST, not grep (and why that matters)
 *
 * A grep over `code: '…'` reported ~190 hits; the AST census of the same tree finds
 * 51 construction sites. The difference is type-literal fields (`code:
 * 'capability_unsatisfied';` inside an interface), comparisons, and test files — none
 * of which construct a refusal. Counting them would bake a wrong number into the
 * baseline of the guard whose job is to make the count trustworthy. A TypeLiteral is
 * a different node kind from an ObjectLiteralExpression, so the parse separates them
 * for free, and comments/doc prose can never self-match.
 *
 * ## What it deliberately does NOT see — read this before trusting a clean run
 *
 * Refusals built by a SHARED BUILDER (one `fleetScopeViolation(...)` helper with many
 * callers) appear here once, at the builder's literal, not once per caller. That is
 * correct for the ratchet (fix the builder, fix every caller) but it means this is a
 * count of CONSTRUCTION SITES, never of refusals a user can hit. A refusal whose code
 * does not match REFUSAL_CODE is invisible to it too: the code-name regex is the
 * detector's one heuristic, and the baseline absorbs its false positives (e.g.
 * `unknown_blocked_by` is validation, not authority) rather than hiding them.
 *
 * ## The baseline
 *
 * scripts/refusal-contracts.baseline.json is the measured population that predates
 * this guard: `{ "<file>::<code>": <uncontracted sites> }`. It is SHRINK-ONLY — giving a
 * site its contract (or deleting it) lowers a count; a count may never rise and a new
 * key may never appear. Seed and re-measure it from `--list`, never from a hand grep.
 * `--write-baseline` rewrites it from the live scan and REFUSES to grow it.
 *
 * ## Exemptions — a reasoned, counted, shrink-only escape for DETECTOR false positives
 *
 * The detector keys on a code-name regex, so code that merely NAMES a refusal-shaped state
 * (a lint finding, an invariant-catalogue row, a classifier over free text, a shape-validation
 * error) matches it without constructing a fail-closed gate anyone must lift. Those cannot
 * be given a meaningful RefusalContract, and leaving them in the baseline would keep it
 * above zero forever — hiding the real remaining gaps. `EXEMPT` records each one as
 * `{ "<file>::<code>": { sites, reason } }`. It is deliberately NOT a bypass:
 *  - `reason` is mandatory and non-trivial (enforced by the guard's test);
 *  - `sites` is a COUNT, so a second uncontracted literal under an exempt key is a violation;
 *  - an exemption with more `sites` than the tree now has is STALE and fails the guard, so a
 *    deleted/contracted site cannot leave behind headroom;
 *  - a real refusal must be CONTRACTED, never exempted — exempting one is the failure.
 *
 * Exit 0 clean / 1 on a new uncontracted refusal site, a stale (now-smaller) baseline, or a
 * stale exemption.
 */
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const ROOTS = ['packages/operator-core/lib', 'apps/operator/lib'];
const BASELINE_PATH = join(ROOT, 'scripts/refusal-contracts.baseline.json');

const SKIP_DIR = new Set(['node_modules', 'dist', 'dist-sidecar', 'build', '.next', 'target', '_retired', 'coverage', '.git', 'out']);
const REFUSAL_CODE = /(refus|denied|unsatisfied|violation|blocked|forbidden|not_allowed)/;
/** A literal carrying either key states its lift condition (the RefusalContract). */
const CONTRACT_KEYS = new Set(['refusal', 'liftsWhen']);

/**
 * Detector false positives: `{ "<file>::<code>": { sites, reason } }`. See "Exemptions" above —
 * a REAL fail-closed refusal is contracted, never listed here.
 */
export const EXEMPT = {
  'packages/operator-core/lib/acceptance-grader.ts::grading_audit_refused': {
    sites: 1,
    reason: 'classifier over auditor free text: names an audit-refusal state it detected; it constructs no refusal a caller must lift',
  },
  'packages/operator-core/lib/agent-obligation-providers.ts::unsupported-goal-launch-refusal': {
    sites: 1,
    reason: 'measurement-failure diagnostic (status:unknown) for an UNRECOGNISED upstream launch refusal; it already carries its own `retry` lift hint, and the upstream GoalLaunchRefusal is the gate that states the contract',
  },
  'packages/operator-core/lib/agent-tools/plans/lint.ts::stored_blocked_with_blocked_by': {
    sites: 1,
    reason: 'plan-lint warning finding about an authoring state; a report row, not a refusal of any request',
  },
  'packages/operator-core/lib/agent-tools/plans/lint.ts::unknown_blocked_by': {
    sites: 1,
    reason: 'plan-lint error finding (a dangling blocked-by reference); input validation reported in a lint report, not an authority refusal',
  },
  'packages/operator-core/lib/p2p/receipts.ts::refusal_on_success_receipt': {
    sites: 1,
    reason: 'receipt-constructor shape validation: the detail names the exact field to fix; not an authority gate',
  },
  'packages/operator-core/lib/p2p/receipts.ts::refusal_required': {
    sites: 1,
    reason: 'receipt-constructor shape validation: the detail names the exact field to supply; not an authority gate',
  },
  'packages/operator-core/lib/scheduler/dependency-graph-analysis.ts::blocked-without-resolver': {
    sites: 1,
    reason: 'dependency-graph analysis finding naming a stored-blocked state with no resolver; a diagnostic row, not a refusal',
  },
  'packages/operator-core/lib/scheduler/dependency-invariants.ts::legacy-blocked-without-resolver': {
    sites: 1,
    reason: 'invariant-catalogue row (classification/action/suppression policy) naming a stored-blocked state; policy data, not a constructed refusal',
  },
  'packages/operator-core/lib/scheduler/dependency-invariants.ts::typed-blocked-without-resolver': {
    sites: 1,
    reason: 'invariant-catalogue row (classification/action/suppression policy) naming a stored-blocked state; policy data, not a constructed refusal',
  },
};

function* walk(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (SKIP_DIR.has(name)) continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx|mts|cts)$/.test(name) && !/\.(test|spec|d)\.[cm]?tsx?$/.test(name)) yield full;
  }
}

/**
 * Refusal construction sites in one file's source: every ObjectLiteralExpression
 * whose `code` property is a string literal matching REFUSAL_CODE.
 * @returns {{ line: number, code: string, hasContract: boolean }[]}
 */
export function findRefusalSites(src, fileName = 'site.ts') {
  // Cheap prefilter: a file with no `code:` or no refusal-ish word cannot hold a site.
  // `['"]?` — a quoted key (`'code': …`, JSON-shaped literals) must pass it too; the
  // prefilter is only allowed to be LOOSER than the AST rule, never narrower.
  if (!/\bcode['"]?\s*:/.test(src) || !REFUSAL_CODE.test(src)) return [];
  const kind = /\.tsx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, kind);
  const sites = [];
  const visit = (node) => {
    if (ts.isObjectLiteralExpression(node)) {
      let code = null;
      const keys = new Set();
      for (const p of node.properties) {
        if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p) && !ts.isMethodDeclaration(p)) continue;
        const name = p.name.getText(sf).replace(/['"]/g, '');
        keys.add(name);
        if (name === 'code' && ts.isPropertyAssignment(p) && ts.isStringLiteralLike(p.initializer)) code = p.initializer.text;
      }
      if (code !== null && REFUSAL_CODE.test(code)) {
        sites.push({
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          code,
          hasContract: [...keys].some((k) => CONTRACT_KEYS.has(k)),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

function readBaseline() {
  if (!existsSync(BASELINE_PATH)) return null;
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).sites ?? {};
}

/**
 * Scan the tree. Exported so the guard's unit test can run it over the REAL tree
 * (that run is what makes this guard reachable from a blocking path).
 */
export function scanTree({ baseline = readBaseline(), exempt = EXEMPT } = {}) {
  const sites = [];
  for (const root of ROOTS) {
    for (const file of walk(join(ROOT, root))) {
      const rel = relative(ROOT, file);
      let src;
      try { src = readFileSync(file, 'utf8'); } catch { continue; }
      for (const s of findRefusalSites(src, rel)) sites.push({ rel, ...s });
    }
  }
  const raw = new Map();
  for (const s of sites) {
    if (s.hasContract) continue;
    const key = `${s.rel}::${s.code}`;
    raw.set(key, (raw.get(key) ?? 0) + 1);
  }
  // Exemptions are subtracted COUNT-WISE before the baseline comparison, so an exempt
  // key never occupies baseline headroom and a surplus site under it is still counted.
  const uncontracted = new Map();
  const exempted = [];
  for (const [key, n] of raw) {
    const e = exempt[key]?.sites ?? 0;
    const used = Math.min(n, e);
    if (used > 0) exempted.push({ key, sites: used, reason: exempt[key].reason });
    if (n - used > 0) uncontracted.set(key, n - used);
  }
  const staleExemptions = Object.entries(exempt)
    .filter(([key, e]) => (raw.get(key) ?? 0) < e.sites)
    .map(([key, e]) => ({ key, exempt: e.sites, actual: raw.get(key) ?? 0 }))
    .sort((a, b) => a.key.localeCompare(b.key));
  const base = baseline ?? {};
  const violations = [];
  for (const [key, n] of uncontracted) {
    const allowed = base[key] ?? 0;
    if (n > allowed) violations.push({ key, actual: n, baseline: allowed });
  }
  const stale = Object.entries(base)
    .filter(([key, n]) => (uncontracted.get(key) ?? 0) < n)
    .map(([key, n]) => ({ key, baseline: n, actual: uncontracted.get(key) ?? 0 }))
    .sort((a, b) => a.key.localeCompare(b.key));
  return { sites, uncontracted, exempted, staleExemptions, violations, stale, baselineLoaded: baseline !== null };
}

if (isCliEntry(import.meta.url)) {
  const argv = process.argv.slice(2);
  const scan = scanTree();
  const contracted = scan.sites.filter((s) => s.hasContract).length;
  if (argv.includes('--list')) {
    console.log(`SITES total=${scan.sites.length} withContract=${contracted} uncontracted=${scan.sites.length - contracted} exempt=${scan.exempted.reduce((n, e) => n + e.sites, 0)} baselinedKeys=${scan.uncontracted.size}`);
    for (const s of scan.sites) console.log(`${s.hasContract ? 'CONTRACT ' : 'NO-CONTRACT'} ${s.rel}:${s.line} ${s.code}`);
    process.exit(0);
  }
  if (argv.includes('--write-baseline')) {
    const grew = scan.violations.length > 0 && scan.baselineLoaded;
    if (grew) {
      console.error('refusal-contracts: refusing to GROW the baseline. New/raised uncontracted refusal sites:');
      for (const v of scan.violations) console.error(`  ${v.key}  ${v.baseline} -> ${v.actual}`);
      process.exit(1);
    }
    const sites = Object.fromEntries([...scan.uncontracted].sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(BASELINE_PATH, `${JSON.stringify({ version: 1, sites }, null, 2)}\n`);
    console.log(`refusal-contracts: wrote baseline (${Object.keys(sites).length} keys, ${Object.values(sites).reduce((n, c) => n + c, 0)} uncontracted non-exempt sites)`);
    process.exit(0);
  }
  if (!scan.baselineLoaded) {
    console.error('refusal-contracts: no baseline at scripts/refusal-contracts.baseline.json — seed it with --write-baseline after reading --list');
    process.exit(1);
  }
  let failed = false;
  if (scan.violations.length) {
    failed = true;
    console.error('refusal-contracts: refusal site(s) with no lift condition (code names a refusal, literal carries neither `refusal` nor `liftsWhen`):');
    for (const v of scan.violations) console.error(`  ${v.key}  baseline ${v.baseline}, now ${v.actual}`);
    console.error('Fix: attach a RefusalContract ({ observed, liftsWhen, whoCanMakeItTrue }, see capability-envelope/identity-refusal-contract.ts) as `refusal`. Do NOT raise the baseline.');
  }
  if (scan.stale.length) {
    failed = true;
    console.error('refusal-contracts: baseline is STALE (a site gained a contract or was removed) — shrink it: npm run lint:refusal-contracts -- --write-baseline');
    for (const s of scan.stale) console.error(`  ${s.key}  baseline ${s.baseline}, now ${s.actual}`);
  }
  if (scan.staleExemptions.length) {
    failed = true;
    console.error('refusal-contracts: EXEMPT entry is STALE (the site it excuses no longer exists in that count) — delete or shrink it in scripts/check-refusal-contracts.mjs:');
    for (const s of scan.staleExemptions) console.error(`  ${s.key}  exempt ${s.exempt}, now ${s.actual}`);
  }
  if (!failed) {
    const exemptedSites = scan.exempted.reduce((n, e) => n + e.sites, 0);
    const baselined = [...scan.uncontracted.values()].reduce((n, c) => n + c, 0);
    console.log(`✔ refusal-contracts: ${scan.sites.length} sites, ${contracted} with a contract, ${exemptedSites} exempt (detector false positives), ${baselined} baselined`);
  }
  process.exit(failed ? 1 : 0);
}
