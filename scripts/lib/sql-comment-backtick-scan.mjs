/**
 * sql-comment-backtick-scan.mjs — the SQL-comment-backtick line scanner.
 *
 * ⚠ THIS FILE IS THE ONE IMPLEMENTATION. It is plain `.mjs` on purpose, so that
 * BOTH consumers can run the identical predicate:
 *
 *   1. TypeScript — `packages/operator-core/lib/content-lint/sql-comment-backtick.ts`
 *      wraps it as the registry `ContentDetector` (git-sync content guard,
 *      green-checkpoint, `scripts/check-sql-comment-backtick.mjs` tree sweep).
 *   2. PLAIN NODE — the PreToolUse edit-time hook
 *      `apps/operator/scripts/hooks/cc/pretooluse-content-lint.mjs`, which runs
 *      under bare `node` (no tsx) and therefore cannot import a `.ts` at all.
 *
 * That second consumer is why this extraction exists (EI-19457273276133433).
 * Every path that ran this detector previously fired at COMMIT time or later —
 * CI, the git-sync content guard, green-checkpoint. But `:3170` bundles the
 * WORKING TREE, so a merely-SAVED backtick crash-loops the whole fleet's staging
 * host before any commit-time guard can possibly fire. On 2026-08-03 that took
 * `papercup-staging-api` down 6× until systemd gave up. It was at least the 4th
 * recurrence of this class.
 *
 * Mirrors the established `scripts/lib/identity-leak-patterns.mjs` seam: a pure
 * predicate in `scripts/lib/`, enrolled in `tsconfig.declarations.json` so a
 * committed sibling `.d.mts` keeps the TS side fully typed (required — see
 * `scripts/check-unenrolled-mjs-imports.mjs`; operator-core is allowJs:false +
 * strict). Do NOT re-implement the heuristic in either consumer: two sources of
 * truth for "is this file broken" is what D-003 exists to prevent, and the
 * smart-quotes rule in that same hook is already a hand-port "kept in sync in
 * spirit" — the drift shape this seam avoids.
 *
 * ── What it detects ────────────────────────────────────────────────────────
 * A markdown-style backtick-quoted identifier inside a `--` SQL comment that
 * lives inside a template literal ENDS the template early. Two failure modes:
 *
 *  1. SILENT (the dangerous one) — inside a postgres-js tagged template the
 *     trailing text can still parse as valid TS, so the file compiles and RUNS
 *     with the query truncated mid-comment. On 2026-07-05 this amputated the
 *     entire WHERE clause from the mig-504 LWW upserts. A TS parse check CANNOT
 *     see this: the file parses fine.
 *  2. LOUD — in a plain (non-tagged) DDL-fixture template it is a hard TS1005
 *     cascade whose message lands tens of lines from the cause.
 *
 * ── Why a line scanner and not an AST walk ────────────────────────────────
 * Not because "the file does not parse" — measured, the SILENT case parses
 * cleanly and the LOUD case error-recovers into real template nodes. The actual
 * reason is worse: THE AST FAITHFULLY ENCODES THE MIS-PARSE. By the time you
 * have nodes, the stray backtick has already been consumed as the template's
 * TERMINATOR, so it is no longer *inside* any template. An AST walk asking "is
 * there a backtick inside a SQL comment inside this template?" correctly answers
 * NO on a file that is broken exactly that way. A line scanner reads the bytes
 * the AUTHOR wrote, before the parser reinterprets them.
 *
 * ── The >=2 backtick rule (measured, not guessed) ─────────────────────────
 * The authoring mistake is always a markdown-quoted PAIR, so a real offender
 * carries at least TWO unescaped backticks after the marker. Requiring two
 * removes the one systematic false positive: the backtick that legitimately
 * TERMINATES a single-line template. Measured over all 26,376 tracked files on
 * 2026-08-03 — the one-backtick rule produced 7 hits, ALL false positives; the
 * >=2 rule produces ZERO false positives while still catching all three real
 * incidents.
 */

/**
 * @typedef {Object} SqlCommentBacktickHit
 * @property {number} line 1-based line number of the offending line.
 * @property {number} col 1-based column of the FIRST backtick inside the comment — the one that ends the template.
 * @property {string} text The offending source line, trimmed and capped at 140 chars.
 * @property {number} backticks Unescaped backticks found inside the comment (always >= 2).
 * @property {'sql' | 'template'} host Which comment hosted it: a `--` comment in a SQL
 *   template, or a `//` comment inside any other (worker/script source) template. The
 *   repair differs — see the detector message and `autoFixSqlCommentBacktick`.
 */

const USES_SQL_TAG = /(?<![`\w])sql\s*(?:<[^`]{0,200}>)?\s*`/;

const HAS_RAW_DDL = /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|(?:UNIQUE\s+)?INDEX)\b/;

const SQL_COMMENT_MARKER = /(?:^|\s)--\s/;

// Bundled Node entrypoints retain a shebang before esbuild's generated marker.
// Keep this in sync with the TypeScript detector so generated output is routed
// back to its generator instead of quarantined for an uneditable prose hit.
const GENERATED_FILE_HEADER = /^(?:#![^\n]*\n)?(?:\/\/|\/\*)[^\n]*(?:\bgenerated (?:by|from)\b|\bdo not edit\b|@generated\b)/i;

/**
 * Does this path fall in scope for the detector?
 * @param {string} f repo-relative (or absolute) file path
 * @returns {boolean}
 */
export const sqlCommentBacktickScopeMatches = (f) =>
  /\.(ts|tsx|mjs)$/.test(f) &&
  !/\.(test|spec)\.(ts|tsx|mjs)$/.test(f) &&
  !f.endsWith('.d.ts') &&
  // Minified sidecar BUILD OUTPUT: a single 42MB line-wrapped bundle where a
  // backtick lands next to a marker by coincidence and there is no authored
  // comment to rephrase. Same exclusion, same reason, as check-no-raw-setinterval.mjs.
  !f.includes('/env-sidecars/') &&
  !f.includes('/node_modules/') &&
  !f.includes('/dist/') &&
  !f.startsWith('_retired/') &&
  !f.includes('/_retired/');

/**
 * @param {string} line
 * @param {number} fromIndex
 * @returns {number}
 */
function countUnescapedBackticks(line, fromIndex) {
  let n = 0;
  for (let i = fromIndex; i < line.length; i++) {
    if (line[i] === '`' && line[i - 1] !== '\\') n++;
  }
  return n;
}

/**
 * @param {string} line
 * @param {number} fromIndex
 * @returns {number}
 */
function firstUnescapedBacktick(line, fromIndex) {
  for (let i = fromIndex; i < line.length; i++) {
    if (line[i] === '`' && line[i - 1] !== '\\') return i;
  }
  return -1;
}

/**
 * A `//` line-comment INSIDE a template literal — the non-SQL host of the same
 * defect (EI-21219437374882016). `--` is handled by the SQL path above; here the
 * host is a worker/script SOURCE template (`const WORKER_SRC = \`(() => {`), whose
 * body is generated JS and therefore carries `//` comments.
 *
 * Only `//` is accepted, never a `*`/`/*` continuation: inside a template literal
 * there is no JSDoc block, so a `*`-leading line is markdown prose. Measured — it
 * was the single remaining false positive over the tracked tree, and it was
 * exactly that shape (`**Signal:** ${evidence}` in scout/rubric-rail.ts).
 */
const TEMPLATE_COMMENT_MARKER = /^\s*\/\//;

/** Memoized `typescript`, or null when unavailable. @type {unknown | null | undefined} */
let cachedTs;

/**
 * Load `typescript` LAZILY and SYNCHRONOUSLY.
 *
 * Lazily, because the template path is gated behind a cheap line prescan and most
 * files never reach it — the edit-time PreToolUse hook runs on every save and must
 * not pay a ~250ms module load to learn a file has no candidate line.
 *
 * Synchronously (`createRequire`, not `await import`), because making this
 * predicate async would ripple through `autoFix`, which the ContentDetector
 * contract defines as sync. The cost of that ripple buys nothing.
 *
 * @returns {any | null} null when unavailable — see the caller's NOT-MEASURED note.
 */
function loadTypeScript() {
  if (cachedTs !== undefined) return cachedTs;
  try {
    // `process.getBuiltinModule` is a plain PROPERTY READ, invisible to a bundler's
    // static analysis. A `import { createRequire } from 'node:module'` here would be
    // neutered when this module is bundled into dist-host / dist-sidecar (both of
    // which do embed this file), and the failure is silent — see EI-22123762178661822.
    cachedTs = process.getBuiltinModule('node:module').createRequire(import.meta.url)('typescript');
  } catch {
    cachedTs = null;
  }
  return cachedTs;
}

/**
 * 1-based line numbers that begin inside the TEXT of a template literal.
 *
 * ── Why a tokenizer here, when the SQL path is deliberately a line scanner ──
 * The header above explains that an AST walk cannot answer "is this backtick
 * inside a template?", because by the time you have nodes the stray backtick has
 * been consumed as the template's TERMINATOR. That objection stands, and this is
 * NOT a violation of it — it is a DIFFERENT question with a different answer.
 *
 * We never ask whether the backtick is inside a template. We ask whether the LINE
 * BEGINS inside one, and that survives the mis-parse: the stray backtick closes
 * the template PART-WAY THROUGH the offending line, so the line is still the last
 * line of the (truncated) template token. The evidence is reinterpreted, but not
 * before the line starts. That asymmetry is the whole trick.
 *
 * A hand-rolled lexer was tried first and rejected on measurement, not taste: it
 * desynchronised on regex literals and JSX and produced 723 hits over the tracked
 * tree, against 0 for this. Use the compiler's tokenizer; it already knows.
 *
 * @param {string} fileName
 * @param {string} text
 * @returns {Set<number> | null} null = NOT MEASURED (no typescript available),
 *   which is deliberately distinct from an empty set (measured, nothing inside).
 */
export function templateInteriorLines(fileName, text) {
  const ts = loadTypeScript();
  if (!ts) return null;

  // `.tsx` lexes differently from `.ts` (JSX vs type assertions), so the name is
  // load-bearing, not decoration — it is what selects the script kind.
  const sf = ts.createSourceFile(fileName || 'file.ts', text, ts.ScriptTarget.Latest, false, undefined);
  const inside = new Set();

  /** @param {number} rawPos @param {number} end */
  const mark = (rawPos, end) => {
    // `node.pos` includes LEADING TRIVIA, so a comment block sitting immediately
    // BEFORE a template would otherwise be marked as its interior. Measured: that
    // single mistake accounted for most of an earlier 123-hit false-positive run.
    const pos = ts.skipTrivia(text, rawPos);
    const from = sf.getLineAndCharacterOfPosition(Math.min(pos, text.length)).line;
    const to = sf.getLineAndCharacterOfPosition(Math.min(end, text.length)).line;
    // INTERIOR only: the opening line is code, not template text.
    for (let l = from + 1; l <= to; l++) inside.add(l + 1);
  };

  /** @param {any} node */
  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) mark(node.pos, node.end);
    else if (ts.isTemplateExpression(node)) {
      mark(node.head.pos, node.head.end);
      for (const span of node.templateSpans) mark(span.literal.pos, span.literal.end);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return inside;
}

/**
 * The template-literal host: a `//` comment inside a template, carrying >= 2
 * unescaped backticks after the marker.
 *
 * @param {string} fileName
 * @param {string} text
 * @param {string[]} lines
 * @returns {SqlCommentBacktickHit | null}
 */
function findTemplateCommentBacktick(fileName, text, lines) {
  // CHEAP PRESCAN FIRST — no tokenizer unless a candidate line actually exists.
  // Backticks are counted only from the `//`, never from column 0: a backtick
  // before the marker is a template delimiter or code, and counting it flagged
  // every `` `npm run x -- --flag` `` string in the tree.
  /** @type {number[]} */
  const candidates = [];
  for (let i = 0; i < lines.length; i++) {
    if (!TEMPLATE_COMMENT_MARKER.test(lines[i])) continue;
    const from = lines[i].indexOf('//');
    if (countUnescapedBackticks(lines[i], from) < 2) continue;
    candidates.push(i);
  }
  if (candidates.length === 0) return null;

  const interior = templateInteriorLines(fileName, text);
  // NOT MEASURED: report clean rather than guess. The SQL path is unaffected, and
  // ts-parse still catches the parse break one entry later.
  if (!interior) return null;

  for (const i of candidates) {
    if (!interior.has(i + 1)) continue;
    const from = lines[i].indexOf('//');
    const col = firstUnescapedBacktick(lines[i], from);
    return {
      line: i + 1,
      col: col + 1,
      text: lines[i].trim().slice(0, 140),
      backticks: countUnescapedBackticks(lines[i], from),
      host: 'template',
    };
  }
  return null;
}

/**
 * Find the first backtick-quoted identifier inside a comment that sits inside a
 * template literal — in a SQL `--` comment, or in a `//` comment inside any other
 * template (a worker/script source body).
 *
 * The SQL host is checked first and wins ties: it is the only one of the two that
 * can fail SILENTLY (a truncated query that still parses and RUNS), so when a file
 * trips both, that is the message worth recording.
 *
 * @param {string} fileName
 * @param {string} text
 * @returns {SqlCommentBacktickHit | null}
 */
export function findSqlCommentBacktick(fileName, text) {
  if (GENERATED_FILE_HEADER.test(text)) return null;

  const lines = text.split('\n');
  const sqlHit = findSqlHostBacktick(text, lines);
  if (sqlHit) return sqlHit;
  return findTemplateCommentBacktick(fileName, text, lines);
}

/**
 * The original SQL host, unchanged: a `--` comment inside a SQL template.
 * @param {string} text
 * @param {string[]} lines
 * @returns {SqlCommentBacktickHit | null}
 */
function findSqlHostBacktick(text, lines) {
  if (!USES_SQL_TAG.test(text) && !HAS_RAW_DDL.test(text)) return null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = SQL_COMMENT_MARKER.exec(line);
    if (!m) continue;

    // A `//`-style JS comment line is prose, not SQL — its marker and backticks
    // are just discussion (this file itself is full of them).
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

    const dashIdx = m.index + m[0].indexOf('--');
    const slash = line.indexOf('//');
    if (slash !== -1 && slash < dashIdx) continue;

    const backticks = countUnescapedBackticks(line, dashIdx);
    if (backticks < 2) continue;

    const col = firstUnescapedBacktick(line, dashIdx);
    return {
      line: i + 1,
      col: col + 1,
      text: line.trim().slice(0, 140),
      backticks,
      host: 'sql',
    };
  }
  return null;
}
