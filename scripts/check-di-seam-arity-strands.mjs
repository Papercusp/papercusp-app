#!/usr/bin/env node
/**
 * check-di-seam-arity-strands.mjs — flags an optional DI seam whose CALL ARITY is
 * narrower than the production default it replaces (EI-19448665215423873).
 *
 * THE CLASS THIS CATCHES (distinct from the sibling `lint:optional-seam-strands`,
 * which flags an optional seam member whose fallback touches REAL/live state — a
 * different failure mode of the same "optional DI seam" family):
 *
 *   ```ts
 *   governorFor?(model: string): RateLimitGovernor;                          // seam
 *   const g = deps.governorFor ? deps.governorFor(model)                     // called
 *                               : governorForBackend('claude-code', model, undefined, accountId); // default
 *   ```
 *
 * `accountId` is in scope at the call site and is passed to the DEFAULT branch but
 * silently dropped from the SEAM branch. Nothing fails: tsc is blind to it (the seam
 * type only promises `(model) => Governor`, and the call site satisfies that), and
 * every test that injects the seam gets a factory that structurally CANNOT vary by
 * the dropped argument — the property it exists to test (here: per-account state)
 * becomes untestable while the test keeps passing. See the source instance at
 * `packages/operator-core/lib/inference-gateway/gateway.ts` (`governorForAccount`,
 * fixed under EI-19448665215423873 by widening the seam to `(model, accountId)`).
 *
 * HEURISTIC (intentionally cheap, advisory only — a false positive costs a glance,
 * a false negative is no worse than not having this guard at all): a
 * ConditionalExpression `cond ? whenTrue : whenFalse` where
 *   - `cond` is a PropertyAccessExpression `X.seam` (optionally chained `X?.seam`),
 *   - `whenTrue` is a CallExpression on that SAME property access,
 *   - `whenFalse` is any other CallExpression,
 * is flagged when `whenFalse`'s call arguments include a bare Identifier that is
 * NOT among `whenTrue`'s call arguments (by name — position is deliberately not
 * compared, since the seam and the default rarely share a parameter order).
 * Literal / property-access / call-expression arguments are ignored on both sides —
 * only plain identifiers are compared, because those are what "in scope, dropped"
 * looks like syntactically; this keeps the false-positive rate low at the cost of
 * missing anything expressed less directly.
 *
 *   node scripts/check-di-seam-arity-strands.mjs                # advisory: name findings
 *   node scripts/check-di-seam-arity-strands.mjs --json
 *   node scripts/check-di-seam-arity-strands.mjs --fail          # exit 1 when findings exist
 *   node scripts/check-di-seam-arity-strands.mjs --files=a.ts,b.ts
 *
 * Exit codes: 0 no findings (or default/advisory mode) · 1 only with --fail and only
 * when findings exist · 2 nothing was examined (EXIT_NOT_CHECKED — zero candidate files).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { EXIT_NOT_CHECKED } from './lib/not-checked.mjs';
import { runGuardWithIndexFaultGuard, withGitIndexFaultRetry } from './lib/git-index-fault.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// EI-22703095921400106: a torn `.git/index` on the shared staging tree made this call throw
// `fatal: .git/index: index file smaller than expected`, which the affected runner read as a
// LINT VIOLATION rather than "the instrument could not read the repository". Retry the
// known-transient index fault (git-sync repairs it), then surrender as NOT CHECKED — never as a
// finding. Every other git error still propagates untouched.
function git(args) {
  return withGitIndexFaultRetry(() =>
    execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }),
  );
}

/** Tracked .ts/.tsx source files, excluding tests/dist/node_modules/generated output. */
function defaultCandidateFiles() {
  return git(['ls-files', '--', '*.ts', '*.tsx'])
    .split('\n')
    .filter(Boolean)
    .filter((f) => !/\.(test|spec|integration\.test)\.tsx?$/.test(f))
    .filter((f) => !/(^|\/)(dist|build|node_modules|\.papercusp)\//.test(f))
    .filter((f) => !f.startsWith('papercup-release/') && !f.startsWith('papercup-checkpoint/'));
}

function calleeText(expr) {
  return expr.getText();
}

/**
 * Bare-identifier argument names of a call expression; non-identifier args are ignored.
 * `undefined` parses as a plain Identifier in the TS AST (it is a global variable, not a
 * keyword) — filtered out so a literal `undefined` placeholder arg never counts as a
 * "dropped in-scope value" (it isn't in scope; it's a constant).
 */
function identifierArgNames(callExpr) {
  return callExpr.arguments.filter(ts.isIdentifier).map((a) => a.text).filter((name) => name !== 'undefined');
}

/** Strip an optional-chain `?.` / plain `.` down to the base `X.member` text for comparison. */
function propAccessKey(node) {
  if (ts.isPropertyAccessExpression(node) || ts.isPropertyAccessChain(node)) {
    return `${node.expression.getText()}.${node.name.text}`;
  }
  return null;
}

/**
 * Findings from ONE source file: [{ file, line, seam, missing: string[], whenTrueText, whenFalseText }]
 */
export function findArityStrandsInSource(sourceText, fileName = 'f.ts') {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const findings = [];

  function visit(node) {
    if (ts.isConditionalExpression(node)) {
      const condKey = propAccessKey(node.condition);
      if (condKey && ts.isCallExpression(node.whenTrue) && ts.isCallExpression(node.whenFalse)) {
        const whenTrueKey = propAccessKey(node.whenTrue.expression);
        // whenTrue must be a call on the SAME property the condition tested.
        if (whenTrueKey === condKey) {
          const trueArgs = new Set(identifierArgNames(node.whenTrue));
          const falseArgs = identifierArgNames(node.whenFalse);
          const missing = falseArgs.filter((a) => !trueArgs.has(a));
          if (missing.length > 0) {
            const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            findings.push({
              file: fileName,
              line: line + 1,
              seam: condKey,
              missing,
              whenTrueText: node.whenTrue.getText(sf),
              whenFalseText: node.whenFalse.getText(sf),
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return findings;
}

function parseArgs(argv) {
  const opts = { json: false, fail: false, files: null };
  for (const a of argv) {
    if (a === '--json') opts.json = true;
    else if (a === '--fail') opts.fail = true;
    else if (a.startsWith('--files=')) opts.files = a.slice('--files='.length).split(',').filter(Boolean);
  }
  return opts;
}

/**
 * SHRINK-ONLY baseline — the findings that already existed when this guard was
 * WIRED onto a blocking path (2026-08-16, WI-39420 gate-green work; the
 * check-lint-guard-reachability meta-guard demanded wire-or-retire, and wiring
 * `--fail` unbaselined would have red-pinned the fleet on defects that accrued
 * while the guard ran nowhere — its documented rot mode).
 *
 * Keyed by `file::seam::sorted-missing` — deliberately LINE-INDEPENDENT so
 * unrelated edits above a finding don't churn the baseline, while any CHANGE in
 * which identifiers the seam drops re-surfaces as a NEW finding.
 *
 * Rules: entries may only be REMOVED (fix the seam, or judge it fine and widen
 * the seam signature — then delete the row). Never append; a new arity-strand
 * fails the gate, which is the whole point of wiring. Each entry carries the
 * pending judgment it awaits.
 */
const FAIL_BASELINE = new Map([
  [
    'packages/operator-core/lib/agent-plane-measurement-sweep.ts::deps.lastMeasuredAtMs::harnessSlug,workspaceId',
    'pre-wiring finding (2026-08-16): seam cannot vary by workspace/harness — judge whether per-scope measurement is load-bearing',
  ],
  [
    'packages/operator-core/lib/scout/ideator-feedback-priming.ts::opts.readRows::opts',
    'pre-wiring finding (2026-08-16): seam drops the whole opts bag — likely deliberate (reader replaces the read), judge and remove',
  ],
  [
    'packages/operator-core/lib/search/self-session.ts::opts.codexHomeForSession::home',
    'pre-wiring finding (2026-08-16): seam cannot vary by home dir — judge whether a non-default HOME matters for injected resolvers',
  ],
]);

/** The line-independent identity a baseline row matches on (see FAIL_BASELINE). */
function findingKey(f) {
  return `${f.file}::${f.seam}::${[...f.missing].sort().join(',')}`;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const files = opts.files ?? defaultCandidateFiles();

  if (files.length === 0) {
    console.log('check-di-seam-arity-strands: ⚠ NOT CHECKED — zero candidate files (nothing examined, this proves nothing).');
    process.exit(EXIT_NOT_CHECKED);
  }

  const allFindings = [];
  for (const relPath of files) {
    const abs = resolve(ROOT, relPath);
    let text;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue; // deleted-but-still-tracked-in-index edge case
    }
    for (const f of findArityStrandsInSource(text, relPath)) {
      allFindings.push(f);
    }
  }

  // Split against the shrink-only baseline: only NEW findings block in --fail
  // mode; baselined ones stay visible as advisory debt. A baseline row whose
  // finding no longer exists is STALE — the seam was fixed (or the code moved):
  // prune the row. Stale rows are loud-advisory, never a failure, so a genuine
  // fix can land without a lockstep baseline edit.
  const newFindings = allFindings.filter((f) => !FAIL_BASELINE.has(findingKey(f)));
  const baselined = allFindings.filter((f) => FAIL_BASELINE.has(findingKey(f)));
  const liveKeys = new Set(allFindings.map(findingKey));
  const staleBaseline = [...FAIL_BASELINE.keys()].filter((k) => !liveKeys.has(k));

  if (opts.json) {
    console.log(
      JSON.stringify(
        { ok: true, examined: files.length, findings: allFindings, newFindings, baselinedCount: baselined.length, staleBaseline },
        null,
        2,
      ),
    );
  } else if (allFindings.length === 0) {
    console.log(`check-di-seam-arity-strands: ✓ examined ${files.length} files, no arity-narrower DI seams found.`);
  } else {
    console.log(
      `check-di-seam-arity-strands: found ${allFindings.length} DI seam(s) narrower than the default they replace ` +
        `(examined ${files.length} files):\n`,
    );
    for (const f of allFindings) {
      const mark = FAIL_BASELINE.has(findingKey(f)) ? '  [baselined — pre-wiring debt]' : '';
      console.log(`  ${f.file}:${f.line}  seam \`${f.seam}\`${mark}`);
      console.log(`    called:  ${f.whenTrueText}`);
      console.log(`    default: ${f.whenFalseText}`);
      console.log(`    dropped from the seam call: ${f.missing.join(', ')}\n`);
    }
    console.log(
      'A finding here does not prove a real bug, only that the seam cannot vary by the\n' +
        'dropped identifier — check whether that argument is load-bearing for what the\n' +
        'seam is meant to let a caller substitute (EI-19448665215423873).\n' +
        `--fail blocks on NEW findings only (${newFindings.length} new, ${baselined.length} baselined).`,
    );
  }
  if (staleBaseline.length > 0) {
    console.log(
      `\n⚠ ${staleBaseline.length} STALE baseline row(s) — the finding no longer exists; prune from FAIL_BASELINE:\n` +
        staleBaseline.map((k) => `    ${k}`).join('\n'),
    );
  }

  if (opts.fail && newFindings.length > 0) process.exit(1);
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runGuardWithIndexFaultGuard(main, { guard: 'di-seam-arity-strands' });
}
