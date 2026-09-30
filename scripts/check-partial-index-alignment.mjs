#!/usr/bin/env node
/**
 * check-partial-index-alignment.mjs — WI-8806
 *
 * A query may use a PARTIAL index only if the planner can prove the index covers every
 * row the query needs, which means the query must STATE the index's WHERE predicate.
 * Filtering on the indexed EXPRESSION alone is not enough.
 *
 * This lint covers one tight, mechanically-decidable slice of that rule — the slice that
 * has actually bitten this repo three times:
 *
 *     CREATE INDEX ... ON t ((col ->> 'k'))  WHERE (col ? 'k')
 *
 * The indexed expression is the VALUE of a jsonb key, and the predicate is that key's
 * PRESENCE test. PostgreSQL's predicate-implication prover cannot derive `col ? 'k'`
 * from `col ->> 'k' = $1` (different operators over different expressions), so a query
 * that omits the presence test silently falls back to a full table scan.
 *
 * WHY A LINT AND NOT VIGILANCE. The failure is invisible from every direction a human
 * looks: the query is correct, returns the right rows, the index exists and looks used,
 * and nothing errors. The only symptom is cost. All three known instances were found by
 * hand, one at a time, months apart. Measured on the live DB with EXPLAIN (ANALYZE, BUFFERS):
 *
 *   reply-deadline-sweep      40,684 ->   721 buffers    (56x)     156.9ms ->  8.96ms
 *   allpot-broadcast-sweep  4,731,095 -> 3,341 buffers (1,416x)  13,312ms -> 25.9ms  (514x)
 *   task_ledger bash-job lookup   197 ->     1 buffer   (197x)      4.93ms ->  0.042ms
 *
 * The first two returned ZERO rows while reading all 86,722 rows of the table. The third
 * had an idx_scan of exactly 0 — the index had never been used once since it was created.
 *
 * ADDING THE CLAUSE IS SEMANTICALLY FREE, in the comparison positions this lint flags:
 * `col ->> 'k'` is NULL when the key is absent, and NULL satisfies no comparison, so the
 * rows `col ? 'k'` excludes could never have matched anyway. That is exactly why the clause
 * reads as redundant noise and keeps getting "simplified" away. It is load-bearing for the
 * PLAN, not for the RESULT.
 *
 * DESIGN NOTES (each earned from a real false positive while building this):
 *
 *  - STATEMENT SCOPE, NOT LINE SCOPE. The guard routinely sits on a neighbouring line of the
 *    same statement (sync-resolver's reply-chain CTE states it one line ABOVE the join it
 *    protects). A line-scoped check reported three false positives there. Scope is the
 *    tagged template literal.
 *  - COMMENTS ARE STRIPPED FIRST. Several of these queries carry long comments that quote
 *    the very expression they discuss; unanswered-directed.ts names `body->>'related_msg_id'`
 *    inside a comment paragraph about jsonb statistics.
 *  - COALESCE IS EXCLUDED. `COALESCE(body->>'k', msg_id) IN (...)` deliberately wants the
 *    rows WITHOUT the key; adding the presence test would change the result.
 *  - IS NULL IS EXCLUDED. `col ->> 'k' IS NULL` and `NOT (col ? 'k')` genuinely disagree when
 *    the key is present with a JSON null value, so the clause is NOT free there.
 *  - ALIAS-INSENSITIVE MATCHING is deliberate: the guard is required to name the same column
 *    and key, not the same alias. Matching aliases exactly would flag correct multi-CTE
 *    queries. This under-approximates (it can miss a guard stated for the wrong alias) —
 *    chosen on purpose, because a false positive on a hot shared file costs far more here
 *    than a missed one, and the measured instances are all single-alias.
 *
 * The index set is DERIVED, never hardcoded: it is read from the generated drizzle schema,
 * which `pull-schema.mjs` regenerates from the live database. A new index of this shape is
 * therefore covered the moment it lands, with no edit to this file — which is the whole
 * point, since every instance so far was one nobody knew to look for.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * SCOPE BOUNDARY — the narrowness below is MEASURED, not unfinished. Read before widening.
 * ─────────────────────────────────────────────────────────────────────────────────────
 *
 * `harness_shared` holds ~194 partial indexes; this lint covers the 3 of value-and-presence
 * shape. That looks like a 191-index gap and has been filed as one (EI-19452064467168046).
 * It is not. Both obvious ways to close it were measured on the live database and both
 * produce a WORSE outcome than leaving the lint narrow. Recorded as plan decisions on
 * `db-performance-remediation-2026-07-26`:
 *
 *  - D-031 — WIDENING THE SYNTACTIC RULE IS UNSOUND. The property that makes this slice safe
 *    is that stating the predicate is semantically FREE (see above); that is a fact about
 *    `col ? 'k'` in a comparison, NOT about partial predicates in general. `WHERE ended_at
 *    IS NULL` is not free — a query that wants ended rows must omit it. Measured on
 *    `tool_usage_rollup_verb_idx` (partial on `verb <> ''`): the alignment this lint's rule
 *    would have demanded ran 27% SLOWER (131.1ms -> 166.8ms) while silently DROPPING 26% of
 *    the result rows, because a better non-partial index already served the query. The rule
 *    D-031 sets: a lint may FLAG on syntax, but it must not PRESCRIBE an alignment without a
 *    measured plan read. Any extension past this slice owes that gate.
 *
 *  - D-035 — THE EMPIRICAL SHORTCUT IS ALSO UNSOUND, AND WORTHLESS. Ranking partial indexes
 *    by `idx_scan = 0` and triaging looks like a whole-class detector needing no implication
 *    model. Measured: of 54 zero-match partial indexes (936 KB total), only 15 are never
 *    scanned and most of those are healthy drained-queue markers that must not be dropped —
 *    ~40 KB of real upside. Meanwhile `arc_running_idx` matches ZERO rows and is the 8th
 *    most-scanned index in the database (45.2M scans). Zero-match is not weak evidence of
 *    deadness; it is no evidence at all.
 *
 * So the boundary is a conclusion, not a TODO. It lives in `parseGuardedIndexes` as the
 * `readsValue` gate, and `partial-index-alignment-guard.test.ts` pins it so a widening edit
 * fails a test that points back here rather than shipping quietly. Widening is allowed —
 * it is not free. Bring the D-031 plan gate with you, and update that test deliberately.
 *
 * Sibling: packages/operator-core/lib/agent-tools/coordination/partial-jsonb-index-alignment.test.ts
 * pins migration 691's predicate text and the two sweeps' clause ordering (the specific,
 * measurement-carrying guard). This lint is the general class detector. They are
 * complementary: the test asserts the index STAYS partial, the lint asserts queries stay
 * aligned with whatever partial indexes exist.
 *
 * Usage:  node scripts/check-partial-index-alignment.mjs [--json]
 * Exit 0 = aligned, 1 = at least one misaligned query site.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isLiveCodeAt, stripCommentsAndStrings, stripSqlComments } from './lib/strip-comments-and-strings.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

/**
 * Repo-relative path of the generated schema this lint reads. Exported because the
 * schema is an INPUT to the check: adding a partial index can retroactively misalign
 * an existing, untouched query, so `scripts/affected-tests.mjs` must attach this
 * guard when the schema changes as well as when scanned source changes.
 */
export const SCHEMA_FILE_REL = 'libs/papercusp/libs/db/src/schema/generated.ts';

const SCHEMA_FILE = join(REPO_ROOT, SCHEMA_FILE_REL);

/** Own filename, used to skip this lint's own test fixtures by self-reference. */
const SELF_BASENAME = 'check-partial-index-alignment.mjs';

/**
 * Roots scanned for SQL. Kept explicit so a new tree is an opt-in decision, not a surprise.
 *
 * EXPORTED because this list is also the correct `appliesTo` domain for the repo-wide
 * invariant-guard attachment in `scripts/affected-tests.mjs` (WI-9434). That router
 * deliberately fails OPEN and must not hard-fail if this module ever fails to load, so
 * it MIRRORS this list rather than importing it — and
 * `affected-tests-repo-wide-invariant-guards.test.ts` asserts the two agree, so a root
 * added here cannot silently stop being enforced outside operator-core.
 */
export const SOURCE_ROOTS = [
  'packages/operator-core/lib',
  'packages/agent-mcp/src',
  'apps/operator/lib',
  'libs/papercusp/packages',
];

const SKIP_DIR = new Set(['node_modules', 'dist', 'dist-host', 'build', '.next', 'coverage', '_retired', '__snapshots__']);

/**
 * Deliberate exceptions: 'repo/relative/path.ts' -> why it is allowed to omit the guard.
 * Empty by design — an entry here is a claim that the seq scan is CORRECT for that site,
 * and it must say why. Prefer fixing the query.
 */
const ALLOWLIST = new Map();

/* ------------------------------------------------------------------ index catalog */

/**
 * Extract the alignment-required index set from the generated drizzle schema.
 * Shape matched (one per line, as generated):
 *   index("name").using("btree", sql`((col ->> 'k'::text))`).where(sql`(... col ? 'k'::text ...)`)
 *
 * Only indexes whose indexed EXPRESSION reads the same key the predicate guards are
 * returned — a partial index over plain columns is a different (and provable) case.
 *
 * THE `readsValue` GATE BELOW IS THE SCOPE BOUNDARY described in this file's header. It is
 * what keeps the ~191 other partial indexes in `harness_shared` out of this lint's class.
 * Deleting it does not "finish" the lint; it makes the lint prescribe changes that were
 * measured to regress (D-031: 27% slower, 26% of rows silently dropped). Read the header.
 *
 * @param {string} schemaSrc - Contents of the generated drizzle schema file
 * @returns {Array<{ index: string, col: string, key: string }>} the alignment-required set
 */
export function parseGuardedIndexes(schemaSrc) {
  const out = [];
  for (const line of schemaSrc.split('\n')) {
    if (!line.includes('.where(')) continue;
    const nameM = /(?:unique)?[Ii]ndex\("([^"]+)"\)/.exec(line);
    if (!nameM) continue;

    // The indexed expression(s) and the partial predicate are each inside sql`...`.
    const sqlSpans = [...line.matchAll(/sql`([^`]*)`/g)].map((m) => m[1]);
    if (sqlSpans.length < 2) continue;
    const predicate = sqlSpans[sqlSpans.length - 1];
    const expression = sqlSpans.slice(0, -1).join(' ');

    // Presence tests in the predicate: `col ? 'key'`
    const guards = [...predicate.matchAll(/(\w+)\s*\?\s*'([^']+)'/g)].map((m) => ({ col: m[1], key: m[2] }));
    if (guards.length === 0) continue;

    for (const g of guards) {
      // Only the aligned shape: the indexed EXPRESSION must read the guarded key's value.
      const readsValue = new RegExp(`\\b${g.col}\\s*->>\\s*'${escapeRe(g.key)}'`).test(expression);
      if (!readsValue) continue;
      out.push({ index: nameM[1], col: g.col, key: g.key });
    }
  }
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ------------------------------------------------------------------ SQL extraction */

/**
 * Find tagged-template SQL literals: sql`...`, sql<T[]>`...`, coordSql()`...` is NOT matched
 * (the call form assigns to `sql` first in this codebase, which the bare `sql` tag covers).
 *
 * Returns [{ text, srcIndex }] where `text` is the statement with each `${...}` interpolation
 * collapsed to a bound-parameter token, and `srcIndex[i]` is the offset IN THE ORIGINAL FILE
 * of `text[i]`. The map exists because collapsing interpolations changes lengths, so a naive
 * offset arithmetic reports the wrong line — which is worse than no line at all, since it
 * sends the reader to an innocent neighbouring statement.
 *
 * THE TAG IS MATCHED AGAINST MASKED SOURCE. Measured 2026-08-10: the bare regex fires on the
 * word `sql` in PROSE whenever a doc comment mentions it in a markdown code span, because the
 * span's CLOSING backtick supplies the backtick the pattern wants. `gc-plan-runs.ts` says
 * "`sql` is a seam." in its header, and that one comment minted a 427-char "SQL statement"
 * consisting of the file's imports and an interface declaration. Across the corpus that was
 * 61 phantom statements in 33 files (950 -> 889), several of which were 100% phantom.
 *
 * The harm is a FALSE POSITIVE the moment swallowed TypeScript happens to contain a comparison
 * on a guarded key — the phantom body is arbitrary source, not SQL — plus nonsense line
 * attribution, since offsets inside a phantom point wherever the swallow ended up. It also
 * inflates the reassuring "N SQL statements scanned" line this lint prints on success.
 *
 * The code mask is used ONLY to decide whether a tag anchor is live code. The SQL body is always
 * read from the raw source, because the corpus IS template literals and blanking their content
 * would blank the SQL this lint exists to read. Using the strings-aware mask for anchors also
 * prevents a `sql\`` mention inside an ordinary JavaScript string from becoming a phantom tag.
 *
 * @param {string} src - TypeScript/JavaScript source text
 * @param {string} [fileName] - real path, used only to pick a ScriptKind for the mask parse
 * @returns {Array<{ text: string, srcIndex: number[] }>} one entry per sql template literal
 */
export function extractSqlTemplates(src, fileName) {
  const out = [];
  const masked = stripCommentsAndStrings(src, fileName);
  const tag = /\bsql\s*(?:<[^`>]*>)?\s*`/g;
  const tagAt = /^\bsql\s*(?:<[^`>]*>)?\s*`/;
  const matchTagAt = (index) => {
    // The sliced regex cannot see the character immediately before `index`, so restore the
    // word-boundary check that the full-source regex gets for free (`not_sql` is not `sql`).
    if (index > 0 && /\w/.test(src[index - 1])) return null;
    return tagAt.exec(src.slice(index));
  };

  /**
   * Parse one SQL template, folding SQL-tagged templates found inside `${...}` into the same
   * logical statement. A parent query commonly supplies the presence guard while a conditional
   * fragment supplies the comparison; scanning the child alone would therefore report a false
   * positive, while dropping it (the old behavior) misses a real query entirely.
   *
   * @param {number} tagStart - offset of the `sql` token in the original source
   * @param {number} tagLength - length through the opening backtick
   * @returns {{ text: string, srcIndex: number[], endIndex: number } | null}
   */
  function parseTemplate(tagStart, tagLength) {
    const start = tagStart + tagLength;
    let i = start;
    let depth = 0;
    let text = '';
    const srcIndex = [];
    const push = (ch, at) => {
      text += ch;
      srcIndex.push(at);
    };
    const appendNested = (nested) => {
      // Keep a token boundary between the parent SQL and the nested fragment. The exact SQL
      // syntax is not needed by findMisalignedUses, but adjacency could otherwise join tokens
      // across the interpolation and change which side of a comparison an accessor appears on.
      push(' ', nested.tagStart);
      for (let n = 0; n < nested.text.length; n++) {
        push(nested.text[n], nested.srcIndex[n] ?? nested.tagStart);
      }
      push(' ', nested.endIndex - 1);
    };

    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '\\') {
        push(src[i], i);
        if (src[i + 1] !== undefined) push(src[i + 1], i + 1);
        i++;
        continue;
      }
      if (c === '$' && src[i + 1] === '{') {
        depth++;
        i++;
        // interpolation reads as a bound parameter; every token char maps to the `${` anchor
        for (const ch of ' ? ') push(ch, i - 1);
        continue;
      }
      if (depth > 0) {
        // A nested sql tag is code inside the interpolation. Parse and consume its complete
        // template so its backtick and `${...}` braces cannot terminate the parent scan.
        const nestedMatch = matchTagAt(i);
        if (nestedMatch && isLiveCodeAt(src, masked, i)) {
          const nested = parseTemplate(i, nestedMatch[0].length);
          if (nested) {
            appendNested({ ...nested, tagStart: i });
            i = nested.endIndex - 1;
            continue;
          }
        }
        if (c === '{') depth++;
        else if (c === '}') depth--;
        continue;
      }
      if (c === '`') {
        return { text, srcIndex, endIndex: i + 1, tagStart };
      }
      push(c, i);
    }
    return null;
  }

  let m;
  while ((m = tag.exec(src))) {
    // A tag inside a comment is prose, not code. Scan the RAW source for the body so every
    // srcIndex still addresses the real file; the mask decides only whether to start at all.
    if (!isLiveCodeAt(src, masked, m.index)) continue;
    const parsed = parseTemplate(m.index, m[0].length);
    if (parsed) {
      out.push({ text: parsed.text, srcIndex: parsed.srcIndex });
      tag.lastIndex = parsed.endIndex;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ the check */

/**
 * A `col ->> 'key'` occurrence is a COMPARISON use (and so requires the guard) when it is
 * an operand of a comparison. Projections (`... AS x`), ORDER BY and COALESCE wrappers are not.
 *
 * @param {string} sqlText - One SQL statement (a single tagged template's text)
 * @param {{ col: string, key: string }} index - The column and jsonb key the index guards
 * @returns {number[]} offsets into `sqlText` of each comparison lacking the presence guard
 */
export function findMisalignedUses(sqlText, { col, key }) {
  // Shared SQL mask (EI-20073035509369492). The private one this replaced handled `--` only;
  // the shared one also closes block comments, nestable block comments, $tag$ bodies, and —
  // the direction that actually bit here — a `--` INSIDE a quoted identifier, which the old
  // regex blanked as a comment. Blanking live code can erase the presence guard itself and
  // report a correctly-aligned query as a violation.
  //
  // Comments only, strings INTACT: the key this lint matches on (`->> 'reviewBy'`) IS a string
  // literal, so stripSqlCommentsAndStrings would take this detector silently 100% inert.
  const text = stripSqlComments(sqlText);
  const accessor = `(?:\\w+\\.)?${escapeRe(col)}\\s*->>\\s*'${escapeRe(key)}'`;

  // Guard present anywhere in the same statement (alias-insensitive, see header note).
  const guarded = new RegExp(`(?:\\w+\\.)?${escapeRe(col)}\\s*\\?\\s*'${escapeRe(key)}'`).test(text);
  if (guarded) return [];

  const hits = [];
  const occ = new RegExp(accessor, 'g');
  let m;
  while ((m = occ.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 60), m.index);
    const rawAfter = text.slice(m.index + m[0].length, m.index + m[0].length + 40);

    // Normalize the CAST-WRAPPED form `(col ->> 'k')::bigint <= $1` — the reply-deadline
    // shape — by dropping the closing paren of the wrap plus the cast, so the comparison
    // operator becomes the first thing we see. Only a paren IMMEDIATELY followed by a cast
    // is dropped: a bare `)` is left alone so an unrelated enclosing expression (or a
    // function wrapper like lower(...), which could not use this index anyway) is not
    // mistaken for a comparison on the indexed expression itself.
    const after = rawAfter.replace(/^\s*(?:\)\s*)?(?:::\s*"?\w+"?\s*)+/, '');
    // Same normalization on the left for the reversed operand order.
    const beforeTrimmed = before.replace(/\s*\(\s*$/, '');

    // COALESCE(...) deliberately admits key-absent rows — adding the guard changes results.
    if (/coalesce\s*\([^()]*$/i.test(before)) continue;
    // IS NULL / IS NOT NULL are NOT equivalent to the presence test (JSON null case).
    if (/^\s*is\s+(?:not\s+)?null/i.test(after)) continue;

    const followsComparison = /(?:=|<>|!=|<=|>=|<|>|\bin|\blike|\bilike|~\*?)\s*$/i.test(beforeTrimmed);
    const precedesComparison = /^\s*(?:=|<>|!=|<=|>=|<|>|\bin\b|\bany\b|\blike\b|\bilike\b|~)/i.test(after);
    if (!followsComparison && !precedesComparison) continue;

    hits.push(m.index);
  }
  return hits;
}

/* ------------------------------------------------------------------ driver */

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP_DIR.has(e)) continue;
    const p = join(dir, e);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walk(p);
    else if (/\.ts$/.test(e) && !/\.d\.ts$/.test(e) && !/^(generated|schema)\.ts$/.test(e)) yield p;
  }
}

const lineOf = (src, offset) => src.slice(0, offset).split('\n').length;

function main() {
  const asJson = process.argv.includes('--json');

  let schemaSrc;
  try {
    schemaSrc = readFileSync(SCHEMA_FILE, 'utf8');
  } catch (err) {
    console.error(`[partial-index-alignment] cannot read generated schema at ${SCHEMA_FILE}: ${err.message}`);
    console.error('This lint derives its index set from that file. Run: node libs/papercusp/libs/db/scripts/pull-schema.mjs');
    process.exit(1);
  }

  const indexes = parseGuardedIndexes(schemaSrc);
  if (indexes.length === 0) {
    console.log('[partial-index-alignment] no partial jsonb value-and-presence indexes in the schema — nothing to align.');
    process.exit(0);
  }

  const violations = [];
  let filesScanned = 0;
  let statementsScanned = 0;

  for (const root of SOURCE_ROOTS) {
    for (const file of walk(join(REPO_ROOT, root))) {
      const rel = relative(REPO_ROOT, file);
      if (ALLOWLIST.has(rel)) continue;
      let src;
      try {
        src = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      filesScanned++;
      // Cheap pre-filter: no '->>' at all means nothing to check.
      if (!src.includes('->>')) continue;
      // A file that IMPORTS this lint is testing it, so its SQL-shaped strings are
      // deliberately-vulnerable FIXTURES rather than live queries. Skipping by
      // self-reference rather than by an allowlist entry keeps this self-maintaining:
      // a second test of this lint is excluded automatically, and no real query file can
      // accidentally qualify. Note we do NOT skip test files in general -- a test whose
      // raw SQL has drifted from the production shape it claims to pin is a real find
      // (store.integration.test.ts was exactly that).
      if (src.includes(SELF_BASENAME)) continue;

      for (const tpl of extractSqlTemplates(src, file)) {
        statementsScanned++;
        for (const idx of indexes) {
          for (const off of findMisalignedUses(tpl.text, idx)) {
            violations.push({
              file: rel,
              line: lineOf(src, tpl.srcIndex[off] ?? 0),
              index: idx.index,
              col: idx.col,
              key: idx.key,
            });
          }
        }
      }
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ indexes, violations, filesScanned, statementsScanned }, null, 2));
    // NOT process.exit(): it does not drain an async pipe write, so a piped run would
    // report FEWER violations than were found. See scripts/check-undrained-stdout-exit.mjs.
    process.exitCode = violations.length === 0 ? 0 : 1;
    return;
  }

  const idxList = indexes.map((i) => `${i.index} (${i.col} ->> '${i.key}')`).join('\n    ');
  if (violations.length === 0) {
    console.log(
      `[partial-index-alignment] OK — ${statementsScanned} SQL statements in ${filesScanned} files are aligned with ${indexes.length} partial index(es):\n    ${idxList}`,
    );
    process.exit(0);
  }

  console.error(`\n[partial-index-alignment] ${violations.length} misaligned query site(s)\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`      compares ${v.col} ->> '${v.key}' without stating  ${v.col} ? '${v.key}'`);
    console.error(`      -> cannot use PARTIAL index ${v.index}; this statement falls back to a full table scan.\n`);
  }
  console.error(
    'WHY THIS MATTERS: the missing clause is semantically redundant in a comparison — ' +
      "`col ->> 'k'` is NULL when the key is absent and NULL matches no comparison — so adding it\n" +
      'cannot change your results. It is required for the PLANNER to use the partial index.\n' +
      'Measured instances of this exact omission: 56x, 1,416x and 197x fewer buffers once fixed.\n\n' +
      "FIX: add `AND <alias>.col ? 'key'` beside the existing comparison, in the same statement.\n" +
      'If the seq scan is genuinely correct here (e.g. you WANT key-absent rows), add the file to\n' +
      `ALLOWLIST in ${relative(REPO_ROOT, fileURLToPath(import.meta.url))} with the reason.\n`,
  );
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
