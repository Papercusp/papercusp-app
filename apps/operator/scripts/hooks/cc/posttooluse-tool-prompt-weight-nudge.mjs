#!/usr/bin/env node
// PostToolUse nudge: the P-011 prompt-weight budget, checked AT EDIT TIME.
//
// WHY THIS EXISTS (EI-19459260956682226)
//   A tool's description + guidance must fit the P-011 budget (1500 soft / 1600
//   hard). Three detectors already measure it and ALL THREE are post-hoc or
//   opt-in:
//     1. lib/__tests__/tool-guidance-budget.test.ts — catches it, but at GATE
//        time, i.e. after the breach is committed and the whole fleet is blocked.
//     2. tools-md-sync.test.ts — only fires if the editor REMEMBERS to run the
//        mandated `npm run lint:tool-prompts` quick-check.
//     3. agent-tools/tool-weight-selfcheck.ts — warns in the live operator's OWN
//        log at registration; nobody is reading that log at edit time.
//
//   So the dominant failure mode has no detector where it happens. CLAUDE.md
//   already names it: "nearly every prompt-weight gate red has come from GROWING
//   an existing tool's description/guidance, not from adding a new one — and an
//   editor never reads an 'Adding a tool' section, so the breach lands committed
//   and freezes the fleet gate hours later." Measured instances: loop:status
//   1568, loop:checkpoint 1552, plans:set-status 1693, autonomy:decide 1545 —
//   each locally green, each surfacing only at the gate. This hook runs
//   milliseconds after the write, while it is still the author's turn to fix it.
//
//   This is the TIMING gap, not an enforcement gap: the guard exists and is
//   enforced, it just fires far too late to prevent the damage. Deliberately NOT
//   an `npm run lint:*` script — gate-time enforcement already exists (1), a
//   second gate leg would duplicate it, and a `lint:*` entry that no blocking
//   path runs would (correctly) red the lint-guard reachability census.
//
// CONTRACT
//   - ADVISORY ONLY. PostToolUse cannot block and must not try to. Growing a
//     description is normal and usually fine; this fires only when the edited
//     file actually contains a tool that is OVER the budget right now.
//   - SINGLE SOURCE OF TRUTH for the limits: BUDGET / HARD_CAP are read from
//     packages/operator-core/lib/agent-tools/tool-guidance-budget.ts — the same
//     module the gate test and the live self-check share. No fourth copy. If
//     that file cannot be read or parsed, the hook FAILS OPEN rather than
//     guessing with hardcoded numbers that could silently drift.
//   - WEIGHT IS COMPUTED THE SAME WAY promptWeight() computes it: description +
//     guidance.when + notWhen + chaining + byRole.*.{when,notWhen,chaining}.
//     `returns` and `seeAlso` are deliberately NOT counted — which is precisely
//     the cheap fix, so the message says so.
//   - Parsed with the TypeScript compiler API (createSourceFile, no
//     type-checking) rather than regex: these values are multi-line string
//     literals with escaped quotes and adjacent-string concatenation, and a
//     regex gets their LENGTH wrong, which is the one number that matters here.
//     `typescript` is resolved from the edited file's OWN repo — the hook is
//     installed to ~/.papercusp/hooks/cc/, detached from any checkout, so a
//     static import is impossible (same constraint + solution as the
//     migration-fixture-drift and required-field-strand siblings).
//   - A value it cannot evaluate statically (a template literal with `${}`, an
//     imported constant) makes that tool UNMEASURABLE and it is SKIPPED, never
//     guessed at. Under-reporting is the safe direction for an advisory nudge;
//     a made-up number would be worse than silence.
//   - CAUSALITY IS COMPARED, NOT INFERRED: the current file is weighed against
//     its HEAD version. A newly over-budget or heavier tool is attributed to
//     this edit; an unchanged breach is explicitly labelled PRE-EXISTING rather
//     than blaming the author who happened to touch the file.
//   - MEASURED COVERAGE (2026-08-03, against the live catalog rather than
//     asserted): this weigher was cross-checked against the production
//     promptWeight() over all 953 tool files / 722 registered tools. 687 tools
//     were measured by BOTH and agreed EXACTLY — 0 mismatches. The ~35 the AST
//     does not measure are the unmeasurable shapes above (4 files carry a
//     template-literal description) plus tools registered outside the two
//     roots. So: ~95% of the catalog is covered AT EDIT TIME, only ever
//     under-reporting, and the gate-time check (1) still covers 100%. Re-run
//     that cross-check if you change the weighing logic — a synthetic
//     self-test cannot tell you whether this agrees with the module the gate
//     actually uses, which is the only property that matters.
//   - FAILS OPEN on every internal error — bad JSON, missing file, no
//     typescript, an unparseable budget module. A bug here must never disturb an
//     edit that already succeeded.
//   - COST (measured 2026-08-03, 5 runs each): ~0.10s for a NON-candidate path —
//     bare node startup, because isCandidateFile short-circuits before any file
//     read or parse, and that is the overwhelmingly common case — and ~0.35s on
//     an actual tool-definition edit (startup + loading typescript + one parse).
//     It also stays silent unless something is genuinely over budget, so in the
//     steady state (0 tools over budget today) it emits nothing at all.
//   - `--self-test` runs the embedded cases (no stdin) and exits non-zero on
//     failure; mirrors both sibling nudges.
//
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

/** The budget module, relative to the repo root — also how the root is identified. */
const BUDGET_REL = join('packages', 'operator-core', 'lib', 'agent-tools', 'tool-guidance-budget.ts');

/** Parsing a very large file is not worth an edit-time nudge. */
const MAX_BYTES = 400_000;

// Run the hook ONLY when executed as a binary — never on import, so the test
// suite can import the exported helpers without tripping the stdin read.
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();

async function main() {
  if (process.argv.includes('--self-test')) return selfTest();
  try {
    const hook = JSON.parse(await readStdin(250));
    const tool = hook.tool_name || '';
    if (tool !== 'Edit' && tool !== 'Write' && tool !== 'MultiEdit') return done();
    const filePath = (hook.tool_input || {}).file_path || '';
    if (!filePath) return done();

    const msg = nudgeFor(filePath);
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

/**
 * True for a file that can define an MCP tool. Deliberately narrow: the two
 * registry roots, `.ts` only, never a test/spec sibling (a fixture in a test
 * legitimately carries an oversized description to exercise the gate).
 */
export function isCandidateFile(filePath) {
  if (!filePath || !filePath.endsWith('.ts')) return false;
  if (/\.(test|spec)\.tsx?$/.test(filePath)) return false;
  if (filePath.endsWith('.d.ts')) return false;
  const norm = filePath.split(sep).join('/');
  // Segment-based, NOT a '/node_modules/' substring: a RELATIVE path has no
  // leading slash, so the substring form silently lets `node_modules/x/
  // agent-tools/y.ts` through (caught by this hook's own test suite).
  const segs = norm.split('/');
  if (segs.includes('node_modules')) return false;
  if (segs.includes('_retired')) return false;
  // The desktop sidecar carries a full mirror of the tree; nudging on a build
  // artifact would point the author at a file they must not edit.
  if (norm.includes('src-tauri/sidecar/')) return false;
  return norm.includes('/agent-tools/') || norm.includes('/agent-mcp/src/tools/');
}

/** Walk up from the edited file to the repo root that owns the budget module. */
export function findRepoRoot(filePath, exists = existsSync) {
  let dir = dirname(resolve(filePath));
  for (let i = 0; i < 40; i += 1) {
    if (exists(join(dir, BUDGET_REL))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * The `new Set<string>([...])` members of ALLOW_OVER_BUDGET, or null when the
 * declaration is absent or cannot be read statically.
 *
 * null means UNKNOWN, never "empty". The distinction is load-bearing for the
 * blocking sibling: an unknown exemption list must fail open (deny nothing)
 * rather than deny an edit to a tool that may be grandfathered.
 */
function readAllowOverBudget(ts, decl) {
  const init = decl.initializer;
  if (!init || !ts.isNewExpression(init)) return null;
  if (!ts.isIdentifier(init.expression) || init.expression.text !== 'Set') return null;
  const args = init.arguments;
  if (!args || args.length === 0) return []; // `new Set<string>()` — empty, and known to be
  const arr = args[0];
  if (!ts.isArrayLiteralExpression(arr)) return null;
  const out = [];
  for (const el of arr.elements) {
    const v = staticStringValue(ts, el);
    if (v === null) return null; // one unmeasurable member poisons the whole list
    out.push(v);
  }
  return out;
}

/**
 * BUDGET / HARD_CAP / ALLOW_OVER_BUDGET straight out of the production module,
 * by AST — never hardcoded here. Returns null when either number is absent or
 * non-numeric, which the caller treats as "fail open" rather than substituting
 * a default. `allowOverBudget` is `string[]` when it could be read and `null`
 * when it could not (see readAllowOverBudget).
 */
export function readBudgets(ts, sourceText) {
  const sf = ts.createSourceFile('tool-guidance-budget.ts', sourceText, ts.ScriptTarget.Latest, true);
  const found = {};
  let allowOverBudget = null;
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
      const name = decl.name.text;
      if (name === 'ALLOW_OVER_BUDGET') {
        allowOverBudget = readAllowOverBudget(ts, decl);
        continue;
      }
      if (name !== 'BUDGET' && name !== 'HARD_CAP') continue;
      if (!ts.isNumericLiteral(decl.initializer)) continue;
      found[name] = Number(decl.initializer.text);
    }
  }
  if (typeof found.BUDGET !== 'number' || typeof found.HARD_CAP !== 'number') return null;
  if (!Number.isFinite(found.BUDGET) || !Number.isFinite(found.HARD_CAP)) return null;
  return { BUDGET: found.BUDGET, HARD_CAP: found.HARD_CAP, allowOverBudget };
}

/**
 * The static string value of a node, or null when it cannot be known without
 * evaluating code. Handles the shapes these files actually use: quoted literals
 * (with escapes — `.text` is the DECODED value, which is what the assembled
 * prompt carries), no-substitution templates, and adjacent `+` concatenation.
 */
export function staticStringValue(ts, node) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticStringValue(ts, node.left);
    if (left === null) return null;
    const right = staticStringValue(ts, node.right);
    if (right === null) return null;
    return left + right;
  }
  if (ts.isParenthesizedExpression(node)) return staticStringValue(ts, node.expression);
  return null;
}

function propNamed(ts, obj, want) {
  if (!obj || !ts.isObjectLiteralExpression(obj)) return null;
  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p) || !p.name) continue;
    const key = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : null;
    if (key === want) return p.initializer;
  }
  return null;
}

/** Length of a guidance string field, or null if present-but-unmeasurable. */
function fieldLen(ts, obj, key) {
  const node = propNamed(ts, obj, key);
  if (!node) return 0;
  const v = staticStringValue(ts, node);
  return v === null ? null : v.length;
}

/**
 * Mirrors promptWeight() in tool-guidance-budget.ts exactly: description + when
 * + notWhen + chaining + every byRole variant. `returns`/`seeAlso` excluded.
 * Returns null when any counted field is unmeasurable.
 */
export function weighToolObject(ts, obj) {
  const descNode = propNamed(ts, obj, 'description');
  const desc = staticStringValue(ts, descNode);
  if (desc === null) return null;

  let total = desc.length;
  const guidance = propNamed(ts, obj, 'guidance');
  if (guidance && ts.isObjectLiteralExpression(guidance)) {
    for (const key of ['when', 'notWhen', 'chaining']) {
      const len = fieldLen(ts, guidance, key);
      if (len === null) return null;
      total += len;
    }
    const byRole = propNamed(ts, guidance, 'byRole');
    if (byRole && ts.isObjectLiteralExpression(byRole)) {
      for (const p of byRole.properties) {
        if (!ts.isPropertyAssignment(p)) continue;
        const roleObj = p.initializer;
        if (!ts.isObjectLiteralExpression(roleObj)) continue;
        for (const key of ['when', 'notWhen', 'chaining']) {
          const len = fieldLen(ts, roleObj, key);
          if (len === null) return null;
          total += len;
        }
      }
    }
  }
  return total;
}

/**
 * Every measurable tool defined in the source, as { name, weight }. A tool
 * object is one carrying BOTH `name` and `description` — the defineTool({...})
 * argument, and equally a plain exported object literal.
 */
export function weighToolsInSource(ts, sourceText, fileName = 'edited.ts') {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const out = [];
  const visit = (node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const nameNode = propNamed(ts, node, 'name');
      const name = staticStringValue(ts, nameNode);
      const hasDescription = propNamed(ts, node, 'description') !== null;
      if (name !== null && hasDescription) {
        const weight = weighToolObject(ts, node);
        if (weight !== null) out.push({ name, weight });
        // A tool object never nests another tool object; don't double-count.
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return out;
}

/**
 * The ceiling a fixer must actually reach — mirrors bindingCeiling() in
 * tool-guidance-budget.ts.
 *
 * ⚠ This is NOT `hardCap ? HARD_CAP : BUDGET`, which is what this file computed
 * until 2026-08-12. For a NON-grandfathered tool the binding ceiling is the
 * BUDGET even when the tool is also over the HARD CAP, because it must clear
 * both. The old form told the author of a 1650-char tool to "cut >=50" — they
 * cut 50, landed at 1600, and were still over the 1500 budget and still red.
 * Under-stating the cut is harmless-looking in an advisory nudge and actively
 * hostile in the blocking sibling, which would refuse the edit a second time
 * after the author did exactly what it asked.
 */
function bindingCeiling(budgets, grandfathered) {
  return grandfathered ? budgets.HARD_CAP : Math.min(budgets.BUDGET, budgets.HARD_CAP);
}

/**
 * Tools that would RED the gate, mirroring budgetViolations()'s two tiers —
 * INCLUDING the ALLOW_OVER_BUDGET exemption, which the gate honours and this
 * file used to ignore. `budgets.allowOverBudget` may be omitted or null
 * (unknown), in which case nothing is treated as grandfathered; that direction
 * only ever OVER-reports, which is the safe way for an advisory nudge to be
 * wrong. The blocking sibling refuses to run at all on an unknown list.
 */
export function violationsFor(tools, budgets) {
  const allow = new Set(Array.isArray(budgets.allowOverBudget) ? budgets.allowOverBudget : []);
  const out = [];
  for (const t of tools) {
    const hardCap = t.weight > budgets.HARD_CAP;
    const grandfathered = allow.has(t.name);
    const overBudget = t.weight > budgets.BUDGET && !grandfathered;
    if (!hardCap && !overBudget) continue;
    const ceiling = bindingCeiling(budgets, grandfathered);
    out.push({
      name: t.name,
      weight: t.weight,
      hardCap,
      grandfathered,
      limit: ceiling,
      hardCapBinding: ceiling === budgets.HARD_CAP,
      cutAtLeast: t.weight - ceiling,
    });
  }
  return out;
}

/** name → weight, keeping the HEAVIEST when a name somehow appears twice. */
export function weightIndex(tools) {
  const out = new Map();
  for (const t of tools) {
    const prev = out.get(t.name);
    if (prev === undefined || t.weight > prev) out.set(t.name, t.weight);
  }
  return out;
}

/**
 * Split resulting violations into ones this edit worsened and ones that were
 * already present at the comparison base. The pre-tool guard uses the same
 * predicate, so the advisory and blocking halves cannot drift on causality.
 *
 * `beforeIndex` is a name → weight map for the file before this edit. A missing
 * name means a new tool or a previously unmeasurable tool; either way, an
 * over-budget result has no measurable safe baseline and is treated as new.
 */
export function classifyViolations(afterViolations, beforeIndex) {
  const worsening = [];
  const preExisting = [];
  for (const v of afterViolations) {
    const before = beforeIndex.get(v.name);
    if (before === undefined) {
      worsening.push({ ...v, before: null, delta: null });
    } else if (v.weight > before) {
      worsening.push({ ...v, before, delta: v.weight - before });
    } else {
      preExisting.push({ ...v, before, delta: v.weight - before });
    }
  }
  return { worsening, preExisting };
}

/** The worsening subset used by the blocking sibling. */
export function worseningViolations(afterViolations, beforeIndex) {
  return classifyViolations(afterViolations, beforeIndex).worsening;
}

function formatViolation(v, context) {
  const which = v.hardCapBinding ? `${v.limit}-char HARD CAP` : `${v.limit}-char budget`;
  const provenance =
    context === 'pre-existing'
      ? `(already ${v.before ?? v.weight} chars before this edit)`
      : v.before === null
        ? '(no prior measurable weight — this edit introduces it over budget)'
        : `(was ${v.before}, +${v.delta})`;
  return `  • ${v.name} — ${v.weight} chars, over the ${which} by ${v.cutAtLeast} ${provenance}. Cut >=${v.cutAtLeast}.`;
}

export function formatNudge(violations, { preExisting = [] } = {}) {
  const lines = [];
  if (violations.length) {
    lines.push(
      '⚠ P-011 prompt-weight budget increased by this edit — it will RED the fleet gate later:',
      ...violations.map((v) => formatViolation(v, 'worsening')),
    );
  }
  if (preExisting.length) {
    if (lines.length) lines.push('');
    lines.push(
      '⚠ PRE-EXISTING P-011 prompt-weight breach — not caused by this edit:',
      ...preExisting.map((v) => formatViolation(v, 'pre-existing')),
    );
  }
  if (!lines.length) return '';
  lines.push(
    '',
    'The budget counts description + guidance.when/notWhen/chaining (and per-role variants).',
    'It does NOT count `returns` or `seeAlso` — so moving RESPONSE documentation from',
    '`description` into `guidance.returns` fixes this at zero cost to the reader, and is',
    'demand-loaded via tools:find instead of baked into every system prompt (WI-9334 did',
    'exactly this). Verify with: npm run lint:tool-prompts',
  );
  return lines.join('\n');
}

/** The nudge text for an edited path, or '' when there is nothing to say. */
export function nudgeFor(filePath, deps = {}) {
  const {
    exists = existsSync,
    readFile = (p) => readFileSync(p, 'utf8'),
    sizeOf = (p) => statSync(p).size,
    showHead = defaultShowHead,
    loadTs = defaultLoadTs,
  } = deps;
  try {
    if (!isCandidateFile(filePath)) return '';
    const abs = resolve(filePath);
    if (!exists(abs)) return '';
    if (sizeOf(abs) > MAX_BYTES) return '';

    const root = findRepoRoot(abs, exists);
    if (!root) return '';

    // Resolve `typescript` from the edited file's OWN repo — see CONTRACT.
    const ts = loadTs(root);
    if (!ts || typeof ts.createSourceFile !== 'function') return '';

    const budgets = readBudgets(ts, readFile(join(root, BUDGET_REL)));
    if (!budgets) return '';

    const relPath = relative(root, abs).split(sep).join('/');
    const afterText = readFile(abs);
    const beforeText = showHead(root, relPath) ?? '';
    const afterTools = weighToolsInSource(ts, afterText, relPath);
    const beforeTools = weighToolsInSource(ts, beforeText, relPath);
    const afterViolations = violationsFor(afterTools, budgets);
    if (!afterViolations.length) return '';

    const { worsening, preExisting } = classifyViolations(afterViolations, weightIndex(beforeTools));
    return formatNudge(worsening, { preExisting });
  } catch {
    return '';
  }
}

function defaultLoadTs(root) {
  try {
    return createRequire(join(root, 'package.json'))('typescript');
  } catch {
    return null;
  }
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
    // New file, submodule path, detached/empty repo: no measurable baseline.
    return null;
  }
}

function readStdin(timeoutMs) {
  return new Promise((res) => {
    let buf = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      res(buf);
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => {
      buf += d;
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      finish();
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      finish();
    });
  });
}

function done() {
  process.exit(0);
}

// ── self-test ────────────────────────────────────────────────────────────────
function selfTest() {
  const failures = [];
  const check = (label, cond) => {
    if (!cond) failures.push(label);
  };

  let ts;
  try {
    ts = createRequire(join(process.cwd(), 'package.json'))('typescript');
  } catch {
    console.log('posttooluse-tool-prompt-weight-nudge --self-test: SKIPPED (no typescript resolvable)');
    process.exit(0);
  }

  check('candidate: agent-tools .ts', isCandidateFile('/r/packages/operator-core/lib/agent-tools/loop/status.ts'));
  check('candidate: agent-mcp tools', isCandidateFile('/r/packages/agent-mcp/src/tools/foo.ts'));
  check('non-candidate: test sibling', !isCandidateFile('/r/packages/operator-core/lib/agent-tools/loop/status.test.ts'));
  check('non-candidate: unrelated path', !isCandidateFile('/r/apps/operator/lib/release/green-checkpoint.ts'));
  check('non-candidate: sidecar mirror', !isCandidateFile('/r/papercusp-desktop/src-tauri/sidecar/apps/x/agent-tools/a.ts'));
  // RELATIVE path — no leading slash, so a '/node_modules/' substring test
  // misses it. Regression case for a real bug this file shipped with.
  check('non-candidate: relative node_modules path', !isCandidateFile('node_modules/x/agent-tools/y.ts'));
  check('non-candidate: retired', !isCandidateFile('/r/packages/operator-core/lib/agent-tools/_retired/old.ts'));

  check('budgets parsed', (() => {
    const b = readBudgets(ts, 'export const BUDGET = 1500;\nexport const HARD_CAP = 1600;\n');
    return b && b.BUDGET === 1500 && b.HARD_CAP === 1600;
  })());
  check('budgets absent → null (fail open, never a default)', readBudgets(ts, 'export const X = 1;') === null);
  const withAllow = (allow) => `export const BUDGET = 1500;\nexport const HARD_CAP = 1600;\n${allow}`;
  check('ALLOW_OVER_BUDGET absent → null (unknown, NOT empty)', (() => {
    const b = readBudgets(ts, withAllow(''));
    return b && b.allowOverBudget === null;
  })());
  check('ALLOW_OVER_BUDGET empty set → [] (known-empty)', (() => {
    const b = readBudgets(ts, withAllow('export const ALLOW_OVER_BUDGET = new Set<string>([]);'));
    return b && Array.isArray(b.allowOverBudget) && b.allowOverBudget.length === 0;
  })());
  check('ALLOW_OVER_BUDGET members parsed', (() => {
    const b = readBudgets(ts, withAllow("export const ALLOW_OVER_BUDGET = new Set<string>(['a:b', 'c:d']);"));
    return b && Array.isArray(b.allowOverBudget) && b.allowOverBudget.join(',') === 'a:b,c:d';
  })());
  check('ALLOW_OVER_BUDGET with an unmeasurable member → null, never a partial list', (() => {
    const b = readBudgets(ts, withAllow('export const ALLOW_OVER_BUDGET = new Set<string>([`a${x}`]);'));
    return b && b.allowOverBudget === null;
  })());

  const src = (desc, guidance = '') =>
    `export default defineTool({ name: 't:x', description: ${desc},${guidance} });`;
  check('weighs a simple description', (() => {
    const [t] = weighToolsInSource(ts, src(JSON.stringify('abcde')));
    return t && t.name === 't:x' && t.weight === 5;
  })());
  check('counts when/notWhen/chaining, NOT returns', (() => {
    const [t] = weighToolsInSource(
      ts,
      src(JSON.stringify('abcde'), ` guidance: { when: 'xx', notWhen: 'yyy', chaining: 'z', returns: '${'r'.repeat(50)}' },`),
    );
    return t && t.weight === 5 + 2 + 3 + 1;
  })());
  check('counts byRole variants', (() => {
    const [t] = weighToolsInSource(ts, src(JSON.stringify('abcde'), " guidance: { byRole: { su: { when: 'ab' } } },"));
    return t && t.weight === 7;
  })());
  check('adjacent concatenation is summed, not dropped', (() => {
    const [t] = weighToolsInSource(ts, "export default defineTool({ name: 't:x', description: 'abc' + 'de' });");
    return t && t.weight === 5;
  })());
  check('escaped quote counts as ONE char (regex would miscount)', (() => {
    const [t] = weighToolsInSource(ts, "export default defineTool({ name: 't:x', description: 'a\\'b' });");
    return t && t.weight === 3;
  })());
  check('unmeasurable template → skipped, never guessed', (() => {
    const tools = weighToolsInSource(ts, 'export default defineTool({ name: "t:x", description: `a${x}b` });');
    return tools.length === 0;
  })());
  check('object without a name is not a tool', (() => {
    const tools = weighToolsInSource(ts, 'export const x = { description: "abc" };');
    return tools.length === 0;
  })());

  const budgets = { BUDGET: 1500, HARD_CAP: 1600, allowOverBudget: [] };
  check('under budget → no violation', violationsFor([{ name: 'a', weight: 1500 }], budgets).length === 0);
  check('over budget → violation with exact cut', (() => {
    const [v] = violationsFor([{ name: 'a', weight: 1568 }], budgets);
    return v && v.cutAtLeast === 68 && v.hardCap === false && v.limit === 1500;
  })());
  // REGRESSION (2026-08-12): the old form computed `hardCap ? HARD_CAP : BUDGET`
  // and told this author to cut 93 — which lands at 1600, still over the 1500
  // budget and still red. A non-grandfathered tool must clear the BUDGET.
  check('over hard cap but NOT grandfathered → cut to the BUDGET, not the cap', (() => {
    const [v] = violationsFor([{ name: 'a', weight: 1693 }], budgets);
    return v && v.hardCap === true && v.grandfathered === false && v.limit === 1500 && v.cutAtLeast === 193;
  })());
  check('grandfathered over budget → NOT a violation (the gate exempts it)', () =>
    violationsFor([{ name: 'a', weight: 1550 }], { ...budgets, allowOverBudget: ['a'] }).length === 0);
  check('grandfathered over HARD CAP → still a violation, cut to the cap', (() => {
    const [v] = violationsFor([{ name: 'a', weight: 1693 }], { ...budgets, allowOverBudget: ['a'] });
    return v && v.grandfathered === true && v.hardCapBinding === true && v.limit === 1600 && v.cutAtLeast === 93;
  })());
  check('unknown allow-list → nothing grandfathered (over-reports, never under)', (() => {
    const [v] = violationsFor([{ name: 'a', weight: 1550 }], { BUDGET: 1500, HARD_CAP: 1600, allowOverBudget: null });
    return v && v.grandfathered === false;
  })());
  check('message names the tool and the cut', (() => {
    const msg = formatNudge(violationsFor([{ name: 'loop:status', weight: 1568 }], budgets));
    return msg.includes('loop:status') && msg.includes('1568') && msg.includes('Cut >=68') && msg.includes('guidance.returns');
  })());
  check('hard-cap wording follows the BINDING ceiling, not the tier flag', (() => {
    const msg = formatNudge(violationsFor([{ name: 'a', weight: 1693 }], budgets));
    return msg.includes('1500-char budget') && !msg.includes('HARD CAP');
  })());

  if (failures.length) {
    console.error(`posttooluse-tool-prompt-weight-nudge --self-test FAILED:\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  console.log('posttooluse-tool-prompt-weight-nudge --self-test: all cases passed');
  process.exit(0);
}
