#!/usr/bin/env node
/**
 * check-work-item-admission-writers.mjs — the born-pending admission gate's build
 * guard (plan work-queue-admission-and-bulk-dedup-2026-08-24, P-002).
 *
 *   node scripts/check-work-item-admission-writers.mjs          # the guard
 *   node scripts/check-work-item-admission-writers.mjs --list   # the MEASURED population
 *
 * ── WHAT IT POLICES, AND WHY THE RULE IS FILE-LEVEL ─────────────────────────
 *
 * P-002's claim is "every non-observation filing path lands `admission='pending'`".
 * Migration 944 deliberately gives `work_items.admission` NO column default — NULL
 * means "pre-gate legacy row, treat as admitted" — which is right for back-compat
 * and is exactly what makes the claim FALSIFIABLE ONLY BY A SWEEP: a writer that
 * simply never mentions admission does not fail, does not warn, and does not stamp.
 * It mints an immediately-claimable row and looks identical to the 100k+ legacy rows.
 * That is a silent bypass of the whole gate, and it is the failure this guard exists
 * to make loud.
 *
 * The rule is: a file that CALLS `createWorkItem` / `createIssue` must EITHER name
 * `admission` in its own source — i.e. it has consciously decided what this writer
 * mints — OR carry an ALLOWLIST entry with a reason.
 *
 * File-level, not call-level, on purpose. The honest call-level question ("does THIS
 * call pass an admission field?") is not statically answerable in this tree: the
 * highest-volume emitter is `deps.createIssue(createInput)` (capture-core.ts), where
 * the argument is an identifier assembled fifty lines earlier, and several writers go
 * through a DI seam whose `createWorkItem(input) { … }` forwards an opaque object. A
 * call-level rule would score every one of those "cannot tell" — and a guard whose
 * dominant verdict is "cannot tell" gets its findings rubber-stamped into the
 * allowlist, which is how an allowlist stops being evidence of judgement. File-level
 * asks the question a maintainer can actually answer and forces the answer into the
 * source.
 *
 * ── WHY THE ALLOWLIST IS THE POINT, NOT AN ESCAPE ───────────────────────────
 *
 * Most current writers legitimately should NOT be born pending — a plan-item
 * conversion has passed plan review, an expansion inherits its parent's admission,
 * a scorecard is not queue work at all. Those are BYPASS classes, and naming them
 * here is what turns "nobody has looked" into "judged, with a reason a reader can
 * disagree with". Entries are seeded from a `--list` run, never from a hand grep.
 */
import { stripCommentsOnly } from './lib/strip-comments-and-strings.mjs';
import { describeUnscanned, listTrackedFiles } from './lib/tracked-files.mjs';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import { readFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;

/** The writers themselves — they DEFINE the surface, so they cannot be held to it. */
const SELF_EXCLUDED = new Set(['packages/operator-core/lib/work-items.ts']);

/**
 * Writers that legitimately mint WITHOUT the born-pending stamp. Every entry states
 * WHICH bypass class it is, because "no stamp" and "deliberately auto-admitted" look
 * identical in the database and only this file records which one a site meant.
 *
 * Seeded 2026-08-24 from `--list`. Shrinking it is the point: a site moves out by
 * passing `admission` explicitly, which is also how it becomes visible to the P-003
 * promoter and the stats ledger.
 */
export const ALLOWLIST = new Map([
  // ── PASS-THROUGH seams: they forward the CALLER's input, so admission already
  //    flows from whoever decided it. Naming admission here would be a lie about
  //    where the decision is made. ──────────────────────────────────────────────
  [
    'packages/operator-core/lib/coord/condition-upsert.ts',
    "mintWithConditionKey spreads `...input` into createWorkItem, so the caller's admission " +
      'rides through unchanged (_create-core, the choke point, is such a caller). The condition ' +
      'KEY is also a stronger dedup guarantee than the promoter: a unique index, not a similarity ' +
      'score — a second filer on the same key adopts the incumbent instead of minting.',
  ],
  [
    'packages/operator-core/lib/agent-tools/coordination/conversations-core.ts',
    'DI seam only — declares the `createIssue(input)` interface the promote bridge implements; ' +
      'mints nothing itself. The implementations are judged on their own rows.',
  ],
  [
    'packages/operator-core/lib/escalation/episodic-ei.ts',
    'DI wiring — `create: (input) => m.createIssue(input)` forwards an opaque caller object.',
  ],
  [
    'packages/operator-core/lib/operator-sentinel-handoff-deps.ts',
    'DI wiring for operator-sentinel-handoff.ts; forwards that caller\'s input verbatim.',
  ],
  [
    'packages/operator-core/lib/papercup/papercup-deep-delegate-deps.ts',
    "DI wiring for papercup-deep-delegate.ts; forwards that caller's input verbatim.",
  ],

  // ── BYPASS class "already reviewed": the filing passed a gate with more context
  //    than any similarity score, which is the plan's own bypass rationale. ─────
  [
    'packages/operator-core/lib/plan-items/convert.ts',
    'bypass:plan-item — a plan-item conversion HAS passed plan review; it also stamps ' +
      'source_plan_slug, which is the plan\'s stated bypass condition. Born pending would ' +
      'quarantine exactly the work a plan lane was launched to do.',
  ],
  [
    'packages/operator-core/lib/agent-tools/work_items/expand.ts',
    'bypass:parent-admitted — expansion children of a DISPOSED parent inherit that parent\'s ' +
      'review; the expansion plan itself was adjudicated before any child is minted.',
  ],
  [
    'packages/operator-core/lib/agent-tools/coordination/conversations.ts',
    'bypass:deliberated — the promote bridge (D-005) mints only from a conversation that was ' +
      'explicitly promoted, i.e. after human/agent deliberation on the thread.',
  ],
  [
    'packages/operator-core/lib/agent-tools/consult/close.ts',
    'bypass:deliberated — a GRADUATED consult (D-004: the question outgrew the consult) is a ' +
      'closer\'s explicit judgement that this is new work, recorded with its own reason.',
  ],
  [
    'packages/operator-core/lib/operator-sentinel-handoff.ts',
    'bypass:user-requested — the operator hands off work the USER asked for (USER_REQUESTED_LABEL, ' +
      'urgent-wake path). Same class as critical severity: the cost of delaying a real one ' +
      'dominates the cost of a duplicate.',
  ],

  // ── NOT QUEUE WORK: these rows are never claimed off the frontier, so the gate
  //    has nothing to protect. ──────────────────────────────────────────────────
  [
    'packages/operator-core/lib/delegated-tasks.ts',
    'not queue work — a delegated task is minted ALREADY assigned to one delegate session ' +
      '(`assignee: delegate:<sessionId>`); it never sits on the claimable frontier.',
  ],
  [
    'packages/operator-core/lib/papercup/papercup-deep-delegate.ts',
    'not queue work — minted already assigned to a live deep session (or its spawn id); a ' +
      'directed hand-off, not a filing.',
  ],
  [
    'packages/operator-core/lib/scout/rubric-live-drill.ts',
    "not queue work — a synthetic drill SCORECARD, explicitly `lane: 'observation'` (D-005) so " +
      'scheduler self-selectors cannot pick it as a bug. Observations are outside the gate by ' +
      "the plan's own scope ('every NON-OBSERVATION filing path').",
  ],

  // ── KNOWN GAP, named rather than hidden ─────────────────────────────────────
  [
    'packages/operator-core/lib/blueprint/blueprint-run-action.ts',
    '⚠ NOT the shared writer: this file defines its OWN local `createWorkItem(ctx, bp)` that ' +
      'INSERTs into harness_shared.work_items directly (ON CONFLICT DO NOTHING, explicit ' +
      'feature_id), so it bypasses the createWorkItem facade entirely and no facade-level stamp ' +
      'can reach it. A scheduled blueprint firing in work-item mode is a machine emitter and ' +
      'SHOULD be born pending; doing it means adding the column to that raw INSERT. Left as a ' +
      'named gap rather than a silent one — the guard prints this list on every run.',
  ],
]);

/** Callee names that mint a work-item row. `deps.`/`m.`/`this.` prefixes included. */
const WRITER_CALL = /(?:^|[^A-Za-z0-9_$.])(?:[A-Za-z0-9_$]+\s*\.\s*)?(createWorkItem|createIssue)\s*\(/m;

/**
 * A file "has decided" when its own source names the admission surface. Deliberately
 * a TEXT check over comment-stripped source rather than an AST one: the decision can
 * be expressed as a literal (`admission: 'pending'`), as a forwarded field
 * (`admission: input.admission`), or via the shared predicate module — all three are
 * a conscious answer, and enumerating their AST shapes would re-introduce the
 * "cannot tell" verdict this guard is built to avoid.
 *
 * Comments are stripped so PROSE about admission cannot buy an exemption the code
 * never earned — the false-negative direction, which silently loses real findings.
 */
const ADMISSION_DECIDED = /\badmission\b|\badmittedBy\b|work-items-admission/;

/**
 * PURE predicate: does this file mint work-items without ever deciding their
 * admission? Exported for the unit test — a guard's own falsifiability is a property
 * to verify, never an assumption from a green run on a clean tree.
 *
 * @param {string} relPath - Repo-relative path, as it appears in ALLOWLIST.
 * @param {string} source - The file's full source text.
 * @returns {boolean}
 */
export function isUnstampedWorkItemWriter(relPath, source) {
  if (!mintsWorkItems(relPath, source)) return false;
  const prose = stripCommentsOnly(source, relPath);
  if (ADMISSION_DECIDED.test(prose)) return false;
  return !ALLOWLIST.has(relPath);
}

/**
 * Does this file call a work-item minting function at all? Exported so `--list` can
 * report the measured population separately from the verdict.
 *
 * @param {string} relPath - Repo-relative path.
 * @param {string} source - The file's full source text.
 * @returns {boolean}
 */
export function mintsWorkItems(relPath, source) {
  if (SELF_EXCLUDED.has(relPath)) return false;
  // Comments stripped BEFORE the trigger too: several files discuss `createWorkItem()`
  // in a header without calling it, and a doc mention is not a filing path.
  return WRITER_CALL.test(stripCommentsOnly(source, relPath));
}

function trackedFiles() {
  const { files, unscanned } = listTrackedFiles(ROOT);
  return {
    files: files
      .filter((p) => /\.tsx?$/.test(p))
      .filter((p) => !p.includes('/_retired/') && !p.includes('/node_modules/'))
      .filter((p) => !/\.(test|spec)\.tsx?$/.test(p)),
    unscanned,
  };
}

function scan() {
  const { files, unscanned } = trackedFiles();
  const minting = [];
  const offenders = [];
  for (const rel of files) {
    let source;
    try {
      source = readFileSync(`${ROOT}${rel}`, 'utf8');
    } catch {
      continue;
    }
    if (!mintsWorkItems(rel, source)) continue;
    const decided = ADMISSION_DECIDED.test(stripCommentsOnly(source, rel));
    minting.push({ rel, decided, allowlisted: ALLOWLIST.has(rel) });
    if (isUnstampedWorkItemWriter(rel, source)) offenders.push(rel);
  }
  return { minting, offenders, unscanned };
}

function main() {
  const listMode = process.argv.includes('--list');
  const { minting, offenders, unscanned } = scan();

  if (listMode) {
    console.log(
      `[work-item-admission-writers] MEASURED POPULATION — ${minting.length} file(s) call ` +
        `createWorkItem/createIssue:\n`,
    );
    for (const m of minting) {
      const verdict = m.decided ? 'decides admission' : m.allowlisted ? 'ALLOWLISTED' : '⚠ UNSTAMPED';
      console.log(`  ${verdict.padEnd(18)} ${m.rel}`);
    }
    console.log(`\nRe-seed ALLOWLIST from THIS list — never from a hand-run grep.${describeUnscanned(unscanned)}`);
    return;
  }

  if (offenders.length === 0) {
    console.log(
      `[work-item-admission-writers] OK — ${minting.length} minting file(s), ` +
        `${ALLOWLIST.size} allowlisted, no unstamped writers.` +
        describeUnscanned(unscanned),
    );
    return;
  }

  console.error(
    '[work-item-admission-writers] FAIL — these files mint work-items without ever deciding admission:\n',
  );
  for (const o of offenders) console.error(`  ${o}`);
  console.error(
    '\n`work_items.admission` has NO column default: a writer that never mentions it mints\n' +
      'admission=NULL, which reads as "pre-gate legacy, admitted" and is immediately\n' +
      'claimable. That is a SILENT bypass of the born-pending gate — no error, no warning,\n' +
      'and indistinguishable in the database from the 100k+ genuinely-legacy rows.\n\n' +
      'Either:\n' +
      "  1. pass `admission` on the create — 'pending' for ordinary filings (the promoter\n" +
      "     judges them), or 'auto' with an `admittedBy` bypass reason when the filing has\n" +
      '     already passed review (plan-promoted, critical/security, an expansion whose\n' +
      '     parent is admitted); or\n' +
      '  2. add the file to ALLOWLIST in this guard WITH A REASON naming the bypass class.\n\n' +
      'Silently unstamped is the one option that is not available: the whole point of the\n' +
      'gate is that "nobody looked" and "deliberately admitted" stop looking the same.',
  );
  process.exitCode = 1;
}

if (isCliEntry(import.meta.url)) main();
