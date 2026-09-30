#!/usr/bin/env node
// PreToolUse GUARD: refuse an edit that pushes an MCP tool OVER the P-011
// prompt-weight budget. The blocking half of the advisory sibling nudge.
//
// WHY THIS EXISTS (EI-20204186116417704)
//   The sibling `posttooluse-tool-prompt-weight-nudge.mjs` already measures this
//   exactly, milliseconds after the write, and names the tool and the precise
//   number of characters to cut. It closed the TIMING gap. It did not close the
//   ENFORCEMENT gap, because PostToolUse cannot block: the edit lands, git-sync
//   sweeps the whole tree minutes later, and the breach is committed.
//
//   Measured instance, 2026-08-11: `rubrics:propose` grew to 1528 chars in
//   commit 21337b7874 at 20:04:55. NINE MINUTES later an unrelated agent ran
//   `lint:tool-prompts` as routine verification for a different slice and found
//   it RED — on a tool they had never touched. The gate then holds `main` for
//   the WHOLE FLEET until someone triages a file they did not write.
//
//   So the detector fired, correctly and instantly, and the breach landed
//   anyway. That is the defect. The fix is a TIER UPGRADE — detector → gate —
//   not new instrumentation: this hook reuses the sibling's exported weigher
//   verbatim and adds one predicate.
//
// THE PREDICATE: refuse only a WORSENING edit
//   A tool that is over budget and gets SMALLER must PASS. Getting this wrong
//   makes the guard worse than none: a grandfathered or already-over tool would
//   become uneditable, and the guard would block its own remedy — you could not
//   even trim the tool it is complaining about. So the test is not "is it over
//   after?" but "is it over after AND heavier than it was before?".
//
//   Concretely, an edit is refused when a tool is over its binding ceiling in
//   the RESULTING file and either (a) it was not over before, (b) it weighs
//   more than it did before, or (c) it did not exist before (a new tool born
//   over budget). Cases (a) and (b) are the growth this exists to stop; (c) is
//   rare but is unambiguously the author's to fix now.
//
// FAIL-OPEN, DELIBERATELY WIDER THAN THE SIBLING'S
//   The nudge and this guard have OPPOSITE expensive directions. A missed nudge
//   costs one agent one gate red; a false DENY wedges an author out of a file
//   they are entitled to edit. So this hook refuses to act on anything less
//   than an exact reading, and treats every one of these as "allow":
//     - the resulting file text could not be reconstructed EXACTLY (an Edit
//       whose `old_string` is not present — the tool itself will reject it, and
//       the sibling's degraded base+fragment append is fine for a detector but
//       would let this guard deny on text that will never exist);
//     - ALLOW_OVER_BUDGET could not be read (unknown ≠ empty — an unknown
//       exemption list could make a grandfathered tool look like a breach);
//     - the tool is unmeasurable before OR after (a template literal with
//       `${}`) — a weight we cannot compare is not a weight we may refuse on;
//     - any internal error at all: bad JSON, missing typescript, unreadable
//       budget module, stdin timeout.
//
// ESCAPE HATCHES (in preference order)
//   1. DON'T. Move response prose out of `description` into `guidance.returns`.
//      `returns` and `seeAlso` are NOT counted, so this is nearly always a
//      zero-information-loss move — which is exactly why refusing here costs
//      the author almost nothing.
//   2. Per-call: write via `capability:bash` (`node -e`, a heredoc, `sed -i`).
//      PreToolUse does not see those.
//   3. Session-wide: launch with PAPERCUSP_ALLOW_TOOL_PROMPT_WEIGHT=1, which
//      downgrades this guard to a warning. Env is read from the CLI process the
//      hook inherits, so it cannot be set per tool call.
//   4. If the weight is genuinely irreducible, add an ALLOW_OVER_BUDGET entry
//      in tool-guidance-budget.ts — this guard reads that list and will honour
//      it (still bounded by the HARD CAP).
//
// CONTRACT
//   - Scope: Edit / Write / MultiEdit, on the two tool-registry roots only.
//   - On a worsening breach: permissionDecision "deny" (JSON, exit 0) — the same
//     contract as the secrets-guard / nul-byte / generated-file siblings.
//   - SINGLE SOURCE OF TRUTH: the weigher, the budget reader and the violation
//     tiers are IMPORTED from posttooluse-tool-prompt-weight-nudge.mjs, which
//     reads BUDGET / HARD_CAP / ALLOW_OVER_BUDGET out of the production module.
//     No second copy of the numbers and no second copy of the formula — if they
//     drift, both hooks drift together and the gate still arbitrates.
//   - `--self-test` runs the embedded cases (no stdin) and exits non-zero on
//     failure; mirrors every sibling guard's own flag.
//
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import {
  findRepoRoot,
  isCandidateFile,
  readBudgets,
  violationsFor,
  weightIndex,
  worseningViolations,
  weighToolsInSource,
} from './posttooluse-tool-prompt-weight-nudge.mjs';

/** The budget module, relative to the repo root. Mirrors the sibling's constant. */
const BUDGET_REL = join('packages', 'operator-core', 'lib', 'agent-tools', 'tool-guidance-budget.ts');

/** Parsing a very large file is not worth an edit-time guard. */
const MAX_BYTES = 400_000;

const BYPASS_ENV = 'PAPERCUSP_ALLOW_TOOL_PROMPT_WEIGHT';

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();

async function main() {
  if (process.argv.includes('--self-test')) return selfTest();
  try {
    const hook = JSON.parse(await readStdin(250));
    const tool = hook.tool_name || '';
    if (tool !== 'Edit' && tool !== 'Write' && tool !== 'MultiEdit') return done();
    const input = hook.tool_input || {};
    const filePath = input.file_path || '';
    if (!filePath) return done();

    const verdict = assess(tool, input, filePath);
    if (verdict) return emit(verdict, filePath, tool);
  } catch {
    // fail open — see CONTRACT
  }
  return done();
}

function bypassed() {
  const v = process.env[BYPASS_ENV];
  return v === '1' || v === 'true';
}

/**
 * The text the FILE WILL HOLD once this edit lands, and whether that
 * reconstruction is EXACT.
 *
 * The sibling content-lint hook has the same reconstruction but degrades an
 * unfound `old_string` to `base + fragment`, because for a DETECTOR missing a
 * violation is the expensive direction. Here it is inverted: denying on text
 * that will never exist is the expensive direction, so an unfound `old_string`
 * sets `exact:false` and the caller allows. (The Edit tool rejects that call
 * anyway, so nothing is lost by declining to judge it.)
 *
 * `replace_all` is honoured because a guidance string can legitimately be
 * replaced at several sites in one call, and simulating only the first would
 * under-count the resulting weight.
 */
export function resultingFileText(tool, input, filePath, readFile = readFileSync) {
  if (tool === 'Write') return { text: input.content || '', exact: true, existed: existsSync(filePath) };
  let base;
  let existed = true;
  try {
    base = readFile(filePath, 'utf8');
  } catch {
    return { text: '', exact: false, existed: false };
  }
  let exact = true;
  const applyOne = (text, e) => {
    const oldS = e && typeof e.old_string === 'string' ? e.old_string : '';
    const newS = e && typeof e.new_string === 'string' ? e.new_string : '';
    if (!oldS) {
      exact = false;
      return text;
    }
    if (!text.includes(oldS)) {
      exact = false;
      return text;
    }
    if (e.replace_all) return text.split(oldS).join(newS);
    const at = text.indexOf(oldS);
    return text.slice(0, at) + newS + text.slice(at + oldS.length);
  };
  if (tool === 'Edit') return { text: applyOne(base, input), exact, existed };
  if (tool === 'MultiEdit' && Array.isArray(input.edits)) {
    return { text: input.edits.reduce(applyOne, base), exact, existed };
  }
  return { text: base, exact: false, existed };
}

/**
 * The deny verdict for this edit, or null to allow. Every uncertain path
 * returns null — see FAIL-OPEN in the header.
 */
export function assess(tool, input, filePath, deps = {}) {
  const exists = deps.existsSync || existsSync;
  const stat = deps.statSync || statSync;
  const readFile = deps.readFileSync || readFileSync;
  const loadTs = deps.loadTs || defaultLoadTs;
  try {
    if (!isCandidateFile(filePath)) return null;

    const { text, exact } = resultingFileText(tool, input, filePath, readFile);
    // Only an EXACT reconstruction may be refused on.
    if (!exact) return null;
    if (!text) return null;
    if (text.length > MAX_BYTES) return null;

    const root = findRepoRoot(filePath, exists);
    if (!root) return null;

    const ts = loadTs(root);
    if (!ts || typeof ts.createSourceFile !== 'function') return null;

    let budgets;
    try {
      budgets = readBudgets(ts, readFile(join(root, BUDGET_REL), 'utf8'));
    } catch {
      return null;
    }
    if (!budgets) return null;
    // Unknown exemption list ≠ empty one. A tool that IS grandfathered would
    // otherwise be denied for a breach the gate does not consider a breach.
    if (!Array.isArray(budgets.allowOverBudget)) return null;

    const afterViolations = violationsFor(weighToolsInSource(ts, text, filePath), budgets);
    if (!afterViolations.length) return null;

    let beforeIndex = new Map();
    if (exists(filePath)) {
      try {
        if (stat(filePath).size <= MAX_BYTES) {
          beforeIndex = weightIndex(weighToolsInSource(ts, readFile(filePath, 'utf8'), filePath));
        } else {
          return null; // no trustworthy baseline → no deny
        }
      } catch {
        return null; // cannot establish a baseline → no deny
      }
    }

    const worsening = worseningViolations(afterViolations, beforeIndex);
    if (!worsening.length) return null;
    return worsening;
  } catch {
    return null;
  }
}

function defaultLoadTs(root) {
  try {
    return createRequire(join(root, 'package.json'))('typescript');
  } catch {
    return null;
  }
}

export function formatDenial(worsening, filePath, tool) {
  const base = String(filePath).split(/[/\\]/).pop();
  const lines = worsening.map((v) => {
    const which = v.hardCapBinding ? `${v.limit}-char HARD CAP` : `${v.limit}-char budget`;
    const growth =
      v.before === null
        ? '(no prior measurable weight — this edit introduces it over budget)'
        : `(was ${v.before}, +${v.delta})`;
    return `  • ${v.name} — ${v.weight} chars, over the ${which} by ${v.cutAtLeast} ${growth}. Cut >=${v.cutAtLeast}.`;
  });
  return [
    `🛑 prompt-weight guard (P-011): this ${tool} to ${base} would push a tool OVER the budget,`,
    'which REDS the green-checkpoint gate and holds `main` for the whole fleet — usually hours',
    'later, for an agent who did not write it.',
    '',
    ...lines,
    '',
    'THE CHEAP FIX: the budget counts description + guidance.when/notWhen/chaining (and per-role',
    'variants). It does NOT count `returns` or `seeAlso`. So moving RESPONSE documentation out of',
    '`description` into `guidance.returns` clears this at zero cost to the reader — and is',
    'demand-loaded via tools:find instead of baked into every system prompt.',
    '',
    'This refuses only a WORSENING edit: trimming a tool that is already over budget always',
    'passes, so you can fix it right here. Verify with: npm run lint:tool-prompts',
    '',
    `If the weight is genuinely irreducible, add an ALLOW_OVER_BUDGET entry in`,
    `packages/operator-core/lib/agent-tools/tool-guidance-budget.ts (this guard honours it).`,
    `To bypass for the session, relaunch with ${BYPASS_ENV}=1.`,
  ].join('\n');
}

function emit(worsening, filePath, tool) {
  const reason = formatDenial(worsening, filePath, tool);
  if (bypassed()) {
    try {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            additionalContext: `⚠ ${BYPASS_ENV}=1 — the guard below is DOWNGRADED to a warning and this edit is proceeding.\n\n${reason}`,
          },
        }) + '\n',
      );
    } catch {
      /* fail open */
    }
    return done();
  }
  try {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      }) + '\n',
    );
    process.stderr.write(reason + '\n');
  } catch {
    /* fail open */
  }
  return done();
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
    let ok = false;
    try {
      ok = typeof cond === 'function' ? cond() : cond;
    } catch {
      ok = false;
    }
    if (!ok) failures.push(label);
  };

  let ts;
  try {
    ts = createRequire(join(process.cwd(), 'package.json'))('typescript');
  } catch {
    console.log('pretooluse-tool-prompt-weight-guard --self-test: SKIPPED (no typescript resolvable)');
    process.exit(0);
  }

  const TOOL_PATH = `${sep}r${sep}packages${sep}operator-core${sep}lib${sep}agent-tools${sep}x${sep}t.ts`;
  const BUDGET_SRC =
    'export const BUDGET = 1500;\nexport const HARD_CAP = 1600;\nexport const ALLOW_OVER_BUDGET = new Set<string>([]);\n';
  const toolSrc = (n) => `export default defineTool({ name: 't:x', description: ${JSON.stringify('d'.repeat(n))} });`;

  /** deps that pretend TOOL_PATH holds a tool of `beforeChars` and the repo root is reachable. */
  const depsFor = (beforeChars, budgetSrc = BUDGET_SRC) => ({
    existsSync: (p) => String(p).endsWith('t.ts') || String(p).endsWith('tool-guidance-budget.ts') || String(p).endsWith(`${sep}r`),
    statSync: () => ({ size: 1000 }),
    readFileSync: (p) => (String(p).includes('tool-guidance-budget') ? budgetSrc : toolSrc(beforeChars)),
    loadTs: () => ts,
  });
  const writeOf = (n) => ['Write', { file_path: TOOL_PATH, content: toolSrc(n) }, TOOL_PATH];

  check('resultingFileText: Write is exact and is the whole file', () => {
    const r = resultingFileText('Write', { content: 'abc' }, TOOL_PATH);
    return r.exact === true && r.text === 'abc';
  });
  check('resultingFileText: Edit applies the replacement', () => {
    const r = resultingFileText('Edit', { old_string: 'b', new_string: 'ZZ' }, TOOL_PATH, () => 'abc');
    return r.exact === true && r.text === 'aZZc';
  });
  check('resultingFileText: replace_all replaces EVERY site, not just the first', () => {
    const r = resultingFileText('Edit', { old_string: 'a', new_string: 'X', replace_all: true }, TOOL_PATH, () => 'aba');
    return r.exact === true && r.text === 'XbX';
  });
  check('resultingFileText: unfound old_string is INEXACT (never denied on)', () => {
    const r = resultingFileText('Edit', { old_string: 'zzz', new_string: 'q' }, TOOL_PATH, () => 'abc');
    return r.exact === false;
  });
  check('resultingFileText: MultiEdit applies edits in order', () => {
    const r = resultingFileText('MultiEdit', { edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'b', new_string: 'c' }] }, TOOL_PATH, () => 'a');
    return r.exact === true && r.text === 'c';
  });

  check('weightIndex keeps the heaviest duplicate name', () =>
    weightIndex([{ name: 'a', weight: 5 }, { name: 'a', weight: 9 }]).get('a') === 9);

  // ── the predicate ──
  const V = (weight) => ({ name: 't:x', weight, cutAtLeast: weight - 1500, limit: 1500, hardCapBinding: false });
  check('growth past the budget → deny', () => worseningViolations([V(1520)], new Map([['t:x', 1490]])).length === 1);
  check('already over AND still growing → deny', () => worseningViolations([V(1600)], new Map([['t:x', 1550]])).length === 1);
  check('over budget but SHRINKING → allow (the guard must not block its own remedy)', () =>
    worseningViolations([V(1550)], new Map([['t:x', 1600]])).length === 0);
  check('over budget and UNCHANGED → allow (an unrelated edit to the same file)', () =>
    worseningViolations([V(1550)], new Map([['t:x', 1550]])).length === 0);
  check('no baseline → deny, and says so', () => {
    const [w] = worseningViolations([V(1520)], new Map());
    return w && w.before === null && w.delta === null;
  });

  // ── end-to-end through assess() ──
  check('assess: non-candidate path → allow', () =>
    assess('Write', { file_path: '/r/apps/operator/lib/x.ts', content: toolSrc(9000) }, '/r/apps/operator/lib/x.ts', depsFor(10)) === null);
  check('assess: growth over budget → DENY', () => {
    const v = assess(...writeOf(1520), depsFor(1400));
    return Array.isArray(v) && v.length === 1 && v[0].weight === 1520;
  });
  check('assess: under budget → allow', () => assess(...writeOf(1400), depsFor(1300)) === null);
  check('assess: shrinking while over budget → allow', () => assess(...writeOf(1550), depsFor(1580)) === null);
  check('assess: grandfathered tool over budget → allow (the gate exempts it)', () =>
    assess(
      ...writeOf(1550),
      depsFor(1400, 'export const BUDGET = 1500;\nexport const HARD_CAP = 1600;\nexport const ALLOW_OVER_BUDGET = new Set<string>([\'t:x\']);\n'),
    ) === null);
  check('assess: UNKNOWN allow-list → allow (unknown is not empty)', () =>
    assess(...writeOf(1520), depsFor(1400, 'export const BUDGET = 1500;\nexport const HARD_CAP = 1600;\n')) === null);
  check('assess: unparseable budget module → allow (fail open, never a default)', () =>
    assess(...writeOf(1520), depsFor(1400, 'export const NOPE = 1;\n')) === null);
  check('assess: no typescript → allow', () =>
    assess(...writeOf(1520), { ...depsFor(1400), loadTs: () => null }) === null);
  check('assess: inexact reconstruction → allow', () =>
    assess('Edit', { file_path: TOOL_PATH, old_string: 'not-present-anywhere', new_string: 'x' }, TOOL_PATH, depsFor(1400)) === null);
  check('assess: unmeasurable template literal after → allow (never guessed at)', () =>
    assess(
      'Write',
      { file_path: TOOL_PATH, content: 'export default defineTool({ name: "t:x", description: `a${x}b` });' },
      TOOL_PATH,
      depsFor(1400),
    ) === null);

  check('denial names the tool, the cut, the growth and the zero-loss remedy', () => {
    const msg = formatDenial(assess(...writeOf(1520), depsFor(1400)), TOOL_PATH, 'Write');
    return (
      msg.includes('t:x') &&
      msg.includes('1520') &&
      msg.includes('Cut >=20') &&
      msg.includes('was 1400, +120') &&
      msg.includes('guidance.returns') &&
      msg.includes(BYPASS_ENV)
    );
  });

  if (failures.length) {
    console.error(`pretooluse-tool-prompt-weight-guard --self-test FAILED:\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  console.log('pretooluse-tool-prompt-weight-guard --self-test: all cases passed');
  process.exit(0);
}
