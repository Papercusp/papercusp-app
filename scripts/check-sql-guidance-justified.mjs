#!/usr/bin/env node
/**
 * check-sql-guidance-justified.mjs — lint:sql-guidance-justified.
 *
 * The recurrence guard for
 * claimable-read-tool-and-sql-encapsulation-audit-2026-07-21 (P-006).
 *
 * The rule: a HOT read with a stable shape belongs behind a TOOL that wraps the
 * canonical SQL so it cannot drift. The audit's finding was that the drift kept
 * coming back through GUIDANCE, not through code — a doc or a tool's own
 * `guidance` told the next agent to hand-write the query, and the hand-written
 * version then disagreed with what the queue actually served (the 8-vs-2-vs-0
 * claimability incident). Fixing the tool without guarding the guidance just
 * re-arms the trap for whoever writes the next runbook.
 *
 * So: an agent-facing surface may not tell an agent to SELECT from a table that
 * a dedicated tool already covers, unless it says WHY that tool doesn't fit.
 *
 * COVERED TABLES (each has an authoritative tool):
 *   work_items / work_items_claimable → work_items:claimable (claim floors),
 *                                       work_items:list (filtered slice)
 *   harness_plans                     → plans:list (filters + groupBy aggregates),
 *                                       plans:items (pickable items)
 *   engineer_issues                   → work_items:list / improvements:capture
 *
 * WHERE it looks (agent-facing surfaces only):
 *   - a tool's own `description:` / `guidance:` text under **\/agent-tools\/**.ts
 *     (the SQL a tool RUNS is the point — only what it TELLS agents is linted);
 *   - agent-facing prose: docs MDX, the prompt sources, CLAUDE.md / AGENT-ENV.md.
 *
 * WHAT it deliberately does NOT flag:
 *   - implementation SQL anywhere outside those guidance regions (that IS the
 *     encapsulation working);
 *   - tests / fixtures;
 *   - a query over any other table — a genuinely one-off forensic read of
 *     tool_invocations, agent_sessions, dbos.*, … is exactly what dev:pg_query
 *     is FOR, and an insight doc showing one is not a violation.
 *
 * HOW to satisfy it: put the reason at the site, on the same line or within the
 * 3 lines above (any comment syntax — `//`, `--`, `#`, `<!-- -->`, or prose):
 *
 *     sql-snippet-justified: shown as the counter-example the doc is about
 *     sql-snippet-justified: no tool exposes this cross-table join
 *
 * A bare marker with no reason after the colon is rejected — "justify" is the
 * whole rule, so an empty marker is just a mute button.
 *
 *   node scripts/check-sql-guidance-justified.mjs           # report + exit 1
 *   node scripts/check-sql-guidance-justified.mjs --report  # report, exit 0
 *   node scripts/check-sql-guidance-justified.mjs --self-test
 *
 * MASKING (WI-37717). Detection runs over `stripCommentsOnly()` text for .ts —
 * COMMENTS ONLY, never stripCommentsAndStrings: what this guard reads IS a string
 * literal (`description: '…'`, the `guidance` object's values), so blanking strings
 * would take it silently 100% inert. Unmasked, `guidanceRegions()` walked comment
 * text as code and was wrong in BOTH directions (each measured on the real corpus):
 *
 *   - an apostrophe in a comment inside the object ("a peer's", "they haven't")
 *     opens a fake string the walker never closes, so `depth` never returns to 0
 *     and the region runs to EOF — work_items/claim_next.ts's region covered the
 *     WHOLE 22KB file, which would report that tool's own implementation SQL as
 *     agent-facing guidance: precisely what the "deliberately does NOT flag" list
 *     above promises. mode/set.ts over-ran by 5.5KB the same way;
 *   - the mirror image, and the costlier one: a comment BETWEEN `description:` and
 *     its literal makes the walker see `/` instead of a quote and skip the region
 *     entirely (3 live today — the prompt-weight annotations agents add sit exactly
 *     there), and a brace in a comment closed dev/pipeline_position.ts's region
 *     9KB early. Guidance past that point is never linted.
 *
 * ⚠ The MARKER window is deliberately read from the RAW text: a justification is
 * normally written AS a comment (`// sql-snippet-justified: …`), so masking it
 * would blank every justification and turn the guard into a false-positive machine.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripCommentsOnly } from './lib/strip-comments-and-strings.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_ONLY = process.argv.includes('--report');

/** Tables whose canonical read is already a tool. */
const COVERED_TABLES = [
  'work_items_claimable',
  'work_items',
  'harness_plans',
  'engineer_issues',
  // Landed 2026-08-12 with WI-38272, which rewrote the 7 pre-existing violations
  // in the same change — the hold-out these two sat behind was never about the
  // evidence (both earned an authoritative verb in tranche 2 of plan
  // `sql-escape-tool-routing-2026-08-12`, audited against frozen corpus evidence
  // in `bash-substitution/pairs/sql-reads.ts`) but about the ORDER: this lint is
  // a GATING CI step (.github/workflows/test.yml, no continue-on-error), so
  // widening it before the docs were rewritten would have red-pinned the fleet
  // gate. Those docs are .mdx PROJECTIONS of Postgres, so each rewrite is a
  // `docs:author` pass rather than a file edit.
  'schema_migrations',
  'test_runs',
];

/** A SELECT … FROM <covered table> — the "run this" shape. Matched over a
 *  WINDOW of lines, not the single grep line: a query whose column list wraps
 *  puts SELECT and FROM on different lines, and a line-local regex would let
 *  every multi-line query through (the easiest possible bypass of this guard). */
const SQL_RE = new RegExp(
  `\\bselect\\b[\\s\\S]{0,400}?\\bfrom\\s+(?:harness_shared\\.)?(${COVERED_TABLES.join('|')})\\b`,
  'i',
);
/** Lines above the FROM that may hold the opening SELECT. */
const SELECT_LOOKBACK = 6;

/** The justification marker; everything after the colon is the reason. The `m`
 *  flag matters: the marker is searched in a multi-LINE window, so `$` must mean
 *  end-of-line, not end-of-window (without it only a marker on the window's last
 *  line matched — every real justification read as unjustified). */
const MARKER_RE = /sql-snippet-justified:[ \t]*(\S.*)$/im;
/** How many lines above the hit may carry the marker. */
const MARKER_LOOKBACK = 3;

/**
 * GENERATED regions, exempt as a class.
 *
 * The `gen:tool-routing` block in CLAUDE.md is a table whose third column is
 * literally "the SQL to write INSTEAD of the tool" — a counter-example on every
 * row, which is the case this lint's own `sql-snippet-justified` escape exists
 * for. Two reasons it is exempted as a REGION rather than marker-by-marker:
 *
 *  1. A per-row marker cannot be written. The rows are single table lines and
 *     the marker would have to sit inside a rendered cell (visible to every
 *     agent) or on its own line (which breaks the markdown table). MARKER_LOOKBACK
 *     is 3, so one marker above the block cannot reach a 40-row table either.
 *  2. Nothing is being waved through. The block is machine-written from audited
 *     pairs and `npm run gen:tool-routing:check` fails the build if a byte of it
 *     drifts from `ALL_PAIRS` — a STRONGER guarantee than a hand-written
 *     justification, not a weaker one. The SQL in it cannot be edited by hand at
 *     all, which is precisely what this lint is defending.
 *
 * Deliberately keyed on explicit marker pairs, not on "looks generated": an
 * open-ended heuristic here would let a hand-written file silence itself by
 * imitating a banner.
 */
const GENERATED_REGIONS = [
  ['<!-- BEGIN GENERATED gen:tool-routing — do not edit by hand -->', '<!-- END GENERATED gen:tool-routing -->'],
];

/**
 * Is this 1-based line inside a generated region of the RAW source?
 * Exported so the self-test can pin it, and so a caller can see the rule rather
 * than infer it from a silent null.
 */
export function inGeneratedRegion(rawSrc, lineno) {
  const lines = rawSrc.split('\n');
  for (const [begin, end] of GENERATED_REGIONS) {
    let open = -1;
    for (let i = 0; i < lines.length; i += 1) {
      if (open < 0 && lines[i].includes(begin)) open = i + 1;
      else if (open >= 0 && lines[i].includes(end)) {
        if (lineno >= open && lineno <= i + 1) return true;
        open = -1;
      }
    }
  }
  return false;
}

/** Which tool to point the author at, per covered table. */
const TOOL_FOR = {
  work_items: 'work_items:claimable (claim floors) / work_items:list (filtered slice)',
  work_items_claimable: 'work_items:claimable — the view is NOT the claim verdict',
  harness_plans: 'plans:list (filters, groupBy/aggregateOnly) / plans:items',
  // issues:list has NO id filter (D-006), so a by-id read is work_items:get —
  // naming only the list verb here would send an author to a verb that cannot
  // express the read they are documenting.
  engineer_issues: 'issues:list (text/state slices) / work_items:get (a single item by id)',
  schema_migrations: 'db:migrations — and it returns a verdict where an empty result is ambiguous',
  test_runs: "testing:runs — typed status enum, so a doc cannot teach status='failed' (which never matches)",
};

const PATHSPECS = [
  'packages/*/lib/agent-tools/**/*.ts',
  'packages/agent-mcp/src/**/*.ts',
  'apps/operator-docs/src/content/docs/**/*.mdx',
  'apps/operator/prompts/**/*.md',
  'libs/papercusp/packages/harness/prompts/**/*.md',
  'CLAUDE.md',
  'AGENT-ENV.md',
];

export function isTestFile(file) {
  return (
    /\.test\.(ts|tsx|mjs)$/.test(file) ||
    file.includes('/__tests__/') ||
    file.includes('/test/') ||
    /fixture|-rig\.ts$/.test(file)
  );
}

/**
 * Char ranges of a TS file that are agent-FACING text: the `description:`
 * string literal and the whole `guidance: { … }` object. SQL outside these is
 * the tool's own implementation — the thing we WANT.
 */
export function guidanceRegions(src) {
  const regions = [];
  // description: '<literal>' — walk the literal so escapes/newlines are handled.
  for (const m of src.matchAll(/\bdescription\s*:\s*/g)) {
    let i = m.index + m[0].length;
    const q = src[i];
    if (q !== "'" && q !== '"' && q !== '`') continue;
    let k = i + 1;
    while (k < src.length) {
      if (src[k] === '\\') { k += 2; continue; }
      if (src[k] === q) break;
      k++;
    }
    regions.push([i, k]);
  }
  // guidance: { … } — brace-matched (string-aware enough for our literals).
  for (const m of src.matchAll(/\bguidance\s*:\s*\{/g)) {
    let depth = 0;
    let k = m.index + m[0].length - 1;
    const start = k;
    let quote = null;
    for (; k < src.length; k++) {
      const c = src[k];
      if (quote) {
        if (c === '\\') { k++; continue; }
        if (c === quote) quote = null;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    regions.push([start, k]);
  }
  return regions;
}

/**
 * Detection text for a file. `.ts` is masked COMMENTS-ONLY (length-preserving, so
 * every offset below addresses raw and masked identically); prose surfaces are
 * returned untouched — an .md/.mdx corpus IS the agent-facing text this guard
 * exists to read, and running it through a TypeScript parser would blank whatever
 * followed a `//` in a URL. See the masking note in the header.
 */
export function detectionText(relPath, src) {
  if (!relPath.endsWith('.ts')) return src;
  const masked = stripCommentsOnly(src, relPath);
  // Length-preservation is what makes the offsets interchangeable. If a future
  // stripper stops preserving it, fail loudly rather than address the wrong bytes.
  if (masked.length !== src.length) {
    throw new Error(`stripCommentsOnly changed length for ${relPath} (${src.length} -> ${masked.length})`);
  }
  return masked;
}

/** Byte offset of the START of 1-indexed `lineno` in `src`. */
function lineOffset(src, lineno) {
  let off = 0;
  for (let i = 1; i < lineno; i++) {
    const nl = src.indexOf('\n', off);
    if (nl < 0) return off;
    off = nl + 1;
  }
  return off;
}

/**
 * The whole per-site decision, PURE — given a candidate line (what `git grep`
 * found) and the file's RAW text, is this an unjustified agent-facing snippet?
 *
 * Both the real run and `--self-test` call THIS, so a positive control cannot
 * drift away from the code it is meant to pin.
 *
 * @returns {{ table: string } | null}  null = not a violation
 */
export function classifyHit({ file, lineno, content, rawSrc }) {
  if (isTestFile(file) || !rawSrc) return null;
  // Read from RAW: the markers are HTML comments, and a masked read could blank
  // them exactly as it would blank a justification marker.
  if (inGeneratedRegion(rawSrc, lineno)) return null;
  const src = detectionText(file, rawSrc);
  const lines = src.split('\n');

  // The SELECT may sit on an earlier line than the FROM git grep matched — look
  // back a few lines so a wrapped column list can't slip past.
  const windowStart = Math.max(0, lineno - 1 - SELECT_LOOKBACK);
  const sqlMatch = lines.slice(windowStart, lineno).join('\n').match(SQL_RE);
  if (!sqlMatch) return null;

  // TS: only the agent-facing description/guidance text counts.
  if (file.endsWith('.ts')) {
    // Anchor on the FROM (this line) — it is inside the same literal as the SELECT.
    const off = lineOffset(src, lineno) + Math.max(0, content.toLowerCase().indexOf('from'));
    if (!guidanceRegions(src).some(([a, b]) => off >= a && off <= b)) return null;
  }

  // A justified site: the marker (WITH a reason) on this line, just above it, or
  // just above the SELECT that opened the query (which may be further up).
  // ⚠ RAW, not masked: a justification is normally written AS a comment, so
  // reading this window from masked text would blank every marker in the repo.
  const markerFrom = Math.max(0, windowStart - MARKER_LOOKBACK);
  if (MARKER_RE.test(rawSrc.split('\n').slice(markerFrom, lineno).join('\n'))) return null;

  return { table: sqlMatch[1].toLowerCase() };
}

// Import-safe: everything below the pure exports runs only when this file is the
// entrypoint, so a test can import classifyHit/guidanceRegions without the scan
// firing (and calling process.exit) at import time.
const RUN_AS_MAIN = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (RUN_AS_MAIN && process.argv.includes('--self-test')) {
  // POSITIVE CONTROLS + NON-REGRESSION ANCHORS. Two kinds, both required — do not
  // "tidy" the second kind away for looking redundant:
  //   [FALSIFIES]  cases 1, 2, 5 — measured to give the WRONG answer against the
  //                pre-fix unmasked walker (proven 2026-08-10). These pin the fix.
  //   [ANCHOR]     cases 3, 4, 6 — pass before AND after on purpose: they pin that
  //                the mask did not make the guard inert (3), did not blank the
  //                comment-borne justification markers (4), and did not start
  //                running a TypeScript parser over prose surfaces (6). Those are
  //                exactly the three ways this fix could have gone wrong.
  // A no-diff run over the tree proves nothing; these do.
  const SQL = `SELECT id FROM harness_shared.work_items WHERE state = 'open'`;
  const cases = [
    [
      'over-extended region: an apostrophe in a comment inside guidance ran the region to EOF, ' +
        "so the tool's OWN implementation SQL read as agent-facing (work_items/claim_next.ts, 18.5KB over)",
      'packages/operator-core/lib/agent-tools/x/tool.ts',
      `export const tool = {\n  guidance: {\n    // a peer's takeover — this apostrophe opened a fake string\n    when: 'claim the next item',\n  },\n  handler: async () => {\n    const rows = await sql(\`${SQL}\`);\n    return rows;\n  },\n};\n`,
      7,
      null, // implementation SQL is NOT a violation — that is the encapsulation working
    ],
    [
      'skipped region: a comment BETWEEN `description:` and its literal made the walker see `/` ' +
        'and drop the whole region (3 live in the corpus today)',
      'packages/operator-core/lib/agent-tools/x/tool.ts',
      `export const tool = {\n  description:\n    // PROMPT-WEIGHT: trimmed from 1180 chars\n    'To find open items run ${SQL}',\n};\n`,
      4,
      'work_items',
    ],
    [
      'a genuine violation in a plain description still reports (the guard is not inert)',
      'packages/operator-core/lib/agent-tools/x/tool.ts',
      `export const tool = {\n  description: 'To find open items run ${SQL}',\n};\n`,
      2,
      'work_items',
    ],
    [
      'a justification written AS a comment still silences the site (marker read from RAW)',
      'packages/operator-core/lib/agent-tools/x/tool.ts',
      `export const tool = {\n  // sql-snippet-justified: the counter-example the description is about\n  description: 'never run ${SQL}',\n};\n`,
      3,
      null,
    ],
    [
      'SQL inside a plain comment is not agent-facing and must not report',
      'packages/operator-core/lib/agent-tools/x/tool.ts',
      `export const tool = {\n  guidance: {\n    // historically we told agents to ${SQL}\n    when: 'x',\n  },\n};\n`,
      3,
      null,
    ],
    [
      'PROSE surfaces are never masked — an .mdx snippet still reports',
      'apps/operator-docs/src/content/docs/agent-insights/x.mdx',
      `Run this to see the queue:\n\n\`\`\`sql\n${SQL}\n\`\`\`\n`,
      4,
      'work_items',
    ],
    // [FALSIFIES + ANCHOR] the generated-region exemption, as a PAIR. The same
    // snippet is fed twice and must be classified DIFFERENTLY, so neither case
    // can pass by accident: exempting everything would break case 8, and
    // exempting nothing would break case 7.
    [
      'a gen:tool-routing row is exempt — its whole third column is counter-example SQL, and the block is machine-written',
      'CLAUDE.md',
      `# guide\n\n<!-- BEGIN GENERATED gen:tool-routing — do not edit by hand -->\n| want | use | not |\n|---|---|---|\n| open items | \`work_items:list\` | ${SQL} |\n<!-- END GENERATED gen:tool-routing -->\n`,
      6,
      null,
    ],
    [
      'the SAME snippet OUTSIDE the generated block still reports (the exemption is a region, not a file)',
      'CLAUDE.md',
      `# guide\n\n<!-- BEGIN GENERATED gen:tool-routing — do not edit by hand -->\n| want | use | not |\n<!-- END GENERATED gen:tool-routing -->\n\nHand-written advice: run ${SQL}\n`,
      7,
      'work_items',
    ],
    // [ANCHOR] COVERED_TABLES MEMBERSHIP for the two tables added by WI-38272.
    // A whole-corpus run is clean today, and a clean run is ALSO what an inert
    // widening looks like — dropping either name from COVERED_TABLES silences
    // every doc that teaches its SQL and reds nothing. These two cases fail
    // instead. Kept as prose surfaces because that is where both live.
    [
      'schema_migrations is a covered table — its SQL in a doc reports (db:migrations is the verb)',
      'apps/operator-docs/src/content/docs/agent-insights/x.mdx',
      "Check it applied:\n\n```sql\nSELECT filename, applied_at FROM harness_shared.schema_migrations\n WHERE filename LIKE '%795%';\n```\n",
      4,
      'schema_migrations',
    ],
    [
      'test_runs is a covered table — its SQL in a doc reports (testing:runs is the verb)',
      'apps/operator-docs/src/content/docs/agent-insights/x.mdx',
      "Find the reds:\n\n```sql\nSELECT file_path, status FROM harness_shared.test_runs WHERE status = 'failed';\n```\n",
      4,
      'test_runs',
    ],
  ];
  let failed = 0;
  for (const [name, file, rawSrc, lineno, expectTable] of cases) {
    const content = rawSrc.split('\n')[lineno - 1] ?? '';
    let got;
    try {
      got = classifyHit({ file, lineno, content, rawSrc });
    } catch (e) {
      got = `THREW ${e.message}`;
    }
    const ok = expectTable === null ? got === null : got && got.table === expectTable;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}\n       expected=${expectTable ?? 'no-violation'} got=${JSON.stringify(got)}`);
  }
  console.log(`\n--self-test: ${cases.length - failed}/${cases.length} passed`);
  process.exit(failed ? 1 : 0);
}

if (!RUN_AS_MAIN) {
  // Imported (a test, another script): expose the pure API only.
} else {

let raw = '';
try {
  raw = execFileSync(
    'git',
    ['grep', '-nIEi', `from[[:space:]]+(harness_shared\\.)?(${COVERED_TABLES.join('|')})`, '--', ...PATHSPECS],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
} catch (e) {
  if (e.status === 1) raw = ''; // git grep exits 1 on no matches
  else throw e;
}

const fileCache = new Map();
function fileText(file) {
  if (!fileCache.has(file)) {
    try {
      fileCache.set(file, readFileSync(join(ROOT, file), 'utf8'));
    } catch {
      fileCache.set(file, '');
    }
  }
  return fileCache.get(file);
}

const hits = [];
for (const line of raw.split('\n')) {
  const m = line.match(/^([^:]+):(\d+):(.*)$/);
  if (!m) continue;
  const [, file, linenoStr, content] = m;
  const lineno = Number(linenoStr);

  const verdict = classifyHit({ file, lineno, content, rawSrc: fileText(file) });
  if (!verdict) continue;

  hits.push({ file, lineno, table: verdict.table, content: content.trim() });
}

if (hits.length === 0) {
  console.log(
    'check-sql-guidance-justified: clean — no agent-facing "run this SQL" snippet over a ' +
      'tool-covered table without a justification.',
  );
  process.exit(0);
}

const byFile = new Map();
for (const h of hits) {
  if (!byFile.has(h.file)) byFile.set(h.file, []);
  byFile.get(h.file).push(h);
}

console.log(
  `\ncheck-sql-guidance-justified: ${hits.length} unjustified SQL snippet(s) over a tool-covered ` +
    `table in ${byFile.size} agent-facing file(s):\n`,
);
for (const [file, fhits] of [...byFile].sort((a, b) => a[0].localeCompare(b[0]))) {
  console.log(`  ${file}`);
  for (const h of fhits) {
    console.log(`    ${h.lineno}: ${h.content.slice(0, 110)}`);
    console.log(`        → ${h.table} is covered by ${TOOL_FOR[h.table]}`);
  }
}
console.log(
  `\nEach: point at the tool instead of the query — a hot read behind a tool cannot drift from\n` +
    `what the system actually does (that drift IS the claimability incident this guards).\n` +
    `If the snippet genuinely belongs (a counter-example the doc is about, a shape no tool\n` +
    `exposes), state WHY at the site, on the line or within ${MARKER_LOOKBACK} lines above:\n` +
    `    sql-snippet-justified: <reason>\n` +
    `A marker with no reason after the colon does not count.\n` +
    `Rule: claimable-read-tool-and-sql-encapsulation-audit-2026-07-21 P-006.\n`,
);
process.exit(REPORT_ONLY ? 0 : 1);

} // end RUN_AS_MAIN
