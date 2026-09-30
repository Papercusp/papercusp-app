import { readFileSync, writeFileSync } from 'node:fs';

/**
 * sanitize-baseline.ts — transform a raw `pg_dump --schema-only` into an
 * IDEMPOTENT `000-baseline.sql`.
 *
 * Plan: self-contained-migration-baseline-2026-06-02, Phase 0 (P-003).
 *
 * The reference build (libs/papercusp/libs/db/scripts/build-reference-schema.ts)
 * emits a plain pg_dump. The migration runner applies a file exactly once (tracked in schema_migrations),
 * BUT two requirements force strict statement-level idempotency anyway:
 *   1. P-003 acceptance — applying the output twice against an empty DB is a
 *      clean no-op on the second run.
 *   2. Deployed-DB safety (P-007) — the baseline must no-op on an ALREADY
 *      populated live/embedded DB (every table/constraint/policy already there)
 *      and simply get marked applied.
 *
 * Transform rules (by leading statement keyword):
 *   • SET … / SELECT pg_catalog.set_config(…)      → DROP (psql/session noise)
 *   • CREATE SCHEMA                                 → CREATE SCHEMA IF NOT EXISTS
 *   • CREATE TABLE                                  → CREATE TABLE IF NOT EXISTS
 *                                                     + ALTER TABLE … ADD COLUMN IF NOT EXISTS
 *                                                       (one per column — see COLUMN DRIFT below)
 *   • CREATE SEQUENCE                               → CREATE SEQUENCE IF NOT EXISTS
 *   • CREATE [UNIQUE] INDEX                         → … IF NOT EXISTS
 *   • CREATE FUNCTION                               → CREATE OR REPLACE FUNCTION
 *   • CREATE TRIGGER                                → CREATE OR REPLACE TRIGGER  (PG14+)
 *   • CREATE POLICY p ON t …                        → DROP POLICY IF EXISTS p ON t; CREATE POLICY …
 *   • ALTER TABLE [ONLY] … ADD CONSTRAINT …         → DO-block guard (catch duplicate_object/_table)
 *   • ALTER TABLE … ENABLE ROW LEVEL SECURITY       → keep (idempotent)
 *   • ALTER TABLE ONLY … ALTER COLUMN … SET DEFAULT → keep (idempotent)
 *   • ALTER SEQUENCE … OWNED BY                      → keep (idempotent)
 *   • COMMENT ON …                                  → keep (always replaces)
 *   • anything else                                 → keep + warn (so new shapes surface)
 *
 * NOTE: framework roles + the 3 extensions (pgcrypto/pg_trgm/vector) are NOT in
 * this file — they're created in the embedded-pg BOOT pre-migration step (Phase 1
 * P-004), cluster-level, before any schema-only baseline runs.
 *
 *   Run (standalone):  npx tsx packages/operator-core/lib/db-tools/sanitize-baseline.ts [rawIn] [out]
 *   Run (full pipeline, from repo root): npm run gen:baseline
 *     — chains build-reference-schema.ts (scratch DB, applies every migration,
 *       pg_dump --schema-only) into this file's CLI, writing to /tmp only.
 *   In:   default /tmp/papercusp-reference-schema.raw.sql
 *   Out:  default /tmp/000-baseline.sql  — this is NOT the committed
 *         libs/papercusp/libs/db/sql/000-baseline.sql: that file is FROZEN at
 *         its pre-107 squash by design (self-contained-migration-baseline-
 *         2026-06-02, D-004) and migrations 107+ layer on top forever, so a
 *         fresh regen (which includes every migration's schema) will legitimately
 *         differ from it — `npm run gen:baseline:diff` shows that diff, it is
 *         NOT a drift bug. The ongoing correctness guard for the frozen baseline
 *         + all later migrations together is
 *         apps/operator/test/fresh-migrate.integration.test.ts (applies
 *         000-baseline.sql then every migration against a real DB), not a
 *         regen-equality check against this file's output. (EI-13913)
 */

/**
 * COLUMN DRIFT — why every CREATE TABLE also emits per-column ADD COLUMN.
 *
 * `CREATE TABLE IF NOT EXISTS` is idempotent only in the "table is absent, or
 * already has EXACTLY this shape" sense. Against a populated DB whose table
 * pre-exists with an OLDER shape it is a silent NO-OP: the missing column is
 * never added, and the first later statement that references it (an index, a
 * constraint) fails — taking the whole baseline transaction, and the boot, with
 * it. That breaks requirement 2 above, which the generated header states as a
 * promise ("safe to re-apply against an ALREADY populated DB").
 *
 * WI-5216 (2026-07-17) is that failure, live: a pre-squash embedded-pg data dir
 * (born 2026-06-01, one day before the baseline squash) carried the OLD
 * `harness_shared.adv_sessions` — no `coord_owner_id`. Its schema_migrations had
 * the old 0xx filenames but not `000-baseline.sql`, so the runner saw the
 * baseline as PENDING and applied it: `CREATE TABLE IF NOT EXISTS adv_sessions`
 * skipped (table present), then
 *   CREATE INDEX … adv_sessions_coord_owner_idx … (coord_owner_id)
 * raised `column "coord_owner_id" does not exist`. Embedded-pg's runner is
 * fail-loud, so serve.mjs exited 1 — five times, into the respawn cap, then
 * "giving up". The desktop Server sat operator-less for ~7h; the user-visible
 * symptom was the Quick Panel global shortcut appearing to do nothing (the
 * palette had no origin to load from).
 *
 * That DB could never self-heal: `adv_sessions.coord_owner_id` exists ONLY in
 * the baseline — NO migration in sql/ adds it — and the baseline sorts FIRST
 * (000), so its failure aborted the run before 107+ could do anything anyway.
 *
 * The repair: after each CREATE TABLE, emit `ALTER TABLE … ADD COLUMN IF NOT
 * EXISTS` for every column. On a fresh DB the CREATE made them all, so each is a
 * catalog-check no-op. On a drifted DB the missing column is ADDED, and the
 * index/constraint that follows now resolves — the table converges to the
 * baseline shape instead of wedging boot.
 *
 * NOT NULL is deliberately STRIPPED from the emitted ADD COLUMN (never from the
 * CREATE TABLE, which still carries it):
 *   • Fresh DB — CREATE TABLE already applied NOT NULL; the ADD COLUMN no-ops,
 *     so nothing is weakened. This is the overwhelmingly common path.
 *   • Drifted DB — `ADD COLUMN … NOT NULL` with no DEFAULT is a hard ERROR when
 *     the table has rows (PG cannot invent a value), which would re-wedge the
 *     boot this fix exists to prevent. Adding it NULLABLE converges the
 *     STRUCTURE (indexes/queries resolve) and leaves the nullability tightening
 *     — which needs a real backfill decision — to an explicit migration. A
 *     nullable column is a strictly better outcome than a dead operator.
 * A DEFAULT is preserved, so a defaulted column still lands fully-formed.
 */

/** A DO-block dollar tag chosen to never collide with dumped content. */
const GUARD_TAG = '$baseline_guard$';

/** Table-level constraint items in a CREATE TABLE body — not columns, so no ADD COLUMN. */
const TABLE_CONSTRAINT_RE = /^\s*(CONSTRAINT|PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY|EXCLUDE|LIKE)\b/i;

/**
 * Split a CREATE TABLE body on TOP-LEVEL commas — commas nested inside parens
 * belong to a type (`numeric(10,2)`) or an expression (`CHECK (x = ANY (ARRAY[…]))`),
 * not to the column list. String/dollar-quote aware for DEFAULT literals.
 */
export function splitTopLevelCommas(body: string): string[] {
  const out: string[] = [];
  let buf = '';
  let depth = 0;
  let inSingle = false;
  let dollarTag: string | null = null;
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (dollarTag !== null) {
      if (ch === '$' && body.startsWith(dollarTag, i)) {
        buf += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
        continue;
      }
      buf += ch;
      i += 1;
      continue;
    }
    if (inSingle) {
      buf += ch;
      i += 1;
      if (ch === "'") {
        if (body[i] === "'") {
          buf += "'";
          i += 1;
        } else inSingle = false;
      }
      continue;
    }
    if (ch === '$') {
      const m = /^\$[A-Za-z0-9_]*\$/.exec(body.slice(i));
      if (m) {
        dollarTag = m[0];
        buf += dollarTag;
        i += dollarTag.length;
        continue;
      }
    }
    if (ch === "'") {
      inSingle = true;
      buf += ch;
      i += 1;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      const t = buf.trim();
      if (t) out.push(t);
      buf = '';
      i += 1;
      continue;
    }
    buf += ch;
    i += 1;
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}

/**
 * Strip a top-level `NOT NULL` (paren-depth 0 only, so an inline
 * `CHECK (x IS NOT NULL)` keeps its own NOT NULL). See COLUMN DRIFT above.
 */
export function stripTopLevelNotNull(def: string): string {
  let out = '';
  let depth = 0;
  let i = 0;
  while (i < def.length) {
    const ch = def[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (depth === 0) {
      const m = /^NOT\s+NULL\b/i.exec(def.slice(i));
      if (m) {
        i += m[0].length;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Parse `CREATE TABLE [IF NOT EXISTS] <name> ( <body> ) [suffix]` → the table
 * name + the top-level body items. Returns null when the shape isn't a plain
 * column-list CREATE TABLE (e.g. `… PARTITION OF parent`, which has no list of
 * its own to backfill).
 */
export function parseCreateTable(code: string): { table: string; items: string[] } | null {
  const head = /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w."]+)\s*\(/i.exec(code);
  if (!head) return null;
  const open = code.indexOf('(', head.index + head[0].length - 1);
  if (open === -1) return null;
  // Walk to the matching close paren (quote-aware) to isolate the column list.
  let depth = 0;
  let inSingle = false;
  let dollarTag: string | null = null;
  let close = -1;
  for (let i = open; i < code.length; i += 1) {
    const ch = code[i];
    if (dollarTag !== null) {
      if (ch === '$' && code.startsWith(dollarTag, i)) {
        i += dollarTag.length - 1;
        dollarTag = null;
      }
      continue;
    }
    if (inSingle) {
      if (ch === "'") {
        if (code[i + 1] === "'") i += 1;
        else inSingle = false;
      }
      continue;
    }
    if (ch === '$') {
      const m = /^\$[A-Za-z0-9_]*\$/.exec(code.slice(i));
      if (m) {
        dollarTag = m[0];
        i += m[0].length - 1;
        continue;
      }
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return null;
  return { table: head[1], items: splitTopLevelCommas(code.slice(open + 1, close)) };
}

/**
 * The per-column `ALTER TABLE … ADD COLUMN IF NOT EXISTS` repair statements for
 * a CREATE TABLE. Empty when the statement has no plain column list. See the
 * COLUMN DRIFT note above for why NOT NULL is stripped and DEFAULT kept.
 */
export function columnBackfillStatements(code: string): string[] {
  const parsed = parseCreateTable(code);
  if (!parsed) return [];
  const out: string[] = [];
  for (const item of parsed.items) {
    if (TABLE_CONSTRAINT_RE.test(item)) continue; // table constraint, not a column
    const m = /^\s*("[^"]+"|[A-Za-z_][\w$]*)\s+([\s\S]+)$/.exec(item);
    if (!m) continue; // not a parseable column def — leave it to the CREATE TABLE
    const def = stripTopLevelNotNull(m[2]);
    if (!def) continue;
    out.push(`ALTER TABLE ${parsed.table} ADD COLUMN IF NOT EXISTS ${m[1]} ${def}`);
  }
  return out;
}

/**
 * Split SQL into top-level statements (trailing `;` stripped), respecting
 * dollar-quoted strings ($tag$…$tag$), single-quoted strings ('' escape), and
 * `--` line comments. Block comments are not emitted by pg_dump schema-only.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let i = 0;
  const n = sql.length;
  let dollarTag: string | null = null; // current open $tag$, or null
  let inSingle = false;

  while (i < n) {
    const ch = sql[i];

    // Inside a dollar-quoted body: look only for the closing tag.
    if (dollarTag !== null) {
      if (ch === '$' && sql.startsWith(dollarTag, i)) {
        buf += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
      } else {
        buf += ch;
        i += 1;
      }
      continue;
    }

    // Inside a single-quoted string.
    if (inSingle) {
      buf += ch;
      i += 1;
      if (ch === "'") {
        if (sql[i] === "'") {
          buf += "'"; // escaped quote ''
          i += 1;
        } else {
          inSingle = false;
        }
      }
      continue;
    }

    // Line comment → consume to end-of-line (kept verbatim).
    if (ch === '-' && sql[i + 1] === '-') {
      const eol = sql.indexOf('\n', i);
      const end = eol === -1 ? n : eol;
      buf += sql.slice(i, end);
      i = end;
      continue;
    }

    // Open a dollar-quote: $tag$ where tag is [A-Za-z0-9_]* .
    if (ch === '$') {
      const m = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (m) {
        dollarTag = m[0];
        buf += dollarTag;
        i += dollarTag.length;
        continue;
      }
    }

    if (ch === "'") {
      inSingle = true;
      buf += ch;
      i += 1;
      continue;
    }

    if (ch === ';') {
      const trimmed = buf.trim();
      if (trimmed) out.push(trimmed);
      buf = '';
      i += 1;
      continue;
    }

    buf += ch;
    i += 1;
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}

/** Strip leading `--` comment lines + blanks; return the code-bearing remainder. */
function stripLeadingComments(stmt: string): string {
  const lines = stmt.split('\n');
  let k = 0;
  while (k < lines.length && /^\s*(--.*)?$/.test(lines[k])) k += 1;
  return lines.slice(k).join('\n');
}

/**
 * Transform one statement (no trailing `;`) into its idempotent form.
 * Returns the rewritten statement, or `null` to drop it.
 * `onUnknown` is called with the leading token for statements left untouched
 * that aren't on the known-idempotent keep-list (surfaces new pg_dump shapes).
 */
export function transformStatement(stmt: string, onUnknown?: (token: string) => void): string | null {
  const code = stripLeadingComments(stmt);
  if (!code.trim()) return null; // comment-only chunk

  // --- DROP: psql backslash metacommands (PG18 \restrict/\unrestrict, \connect, …) ---
  if (/^\s*\\[a-z]/i.test(code)) return null;

  // --- DROP: session/psql noise ---
  if (/^\s*SET\s/i.test(code)) return null;
  if (/^\s*SELECT\s+pg_catalog\.set_config/i.test(code)) return null;
  if (/^\s*SELECT\s+pg_catalog\.setval/i.test(code)) return null; // data, not schema

  // --- CREATE … IF NOT EXISTS family ---
  if (/^\s*CREATE\s+SCHEMA\s+(?!IF\s+NOT\s+EXISTS)/i.test(code)) {
    return code.replace(/^(\s*CREATE\s+SCHEMA\s+)/i, '$1IF NOT EXISTS ');
  }
  // CREATE TABLE → IF NOT EXISTS, PLUS a per-column ADD COLUMN IF NOT EXISTS
  // repair pass. The IF NOT EXISTS alone silently no-ops against a pre-existing
  // OLDER table, leaving a missing column to blow up the next index/constraint
  // that references it (WI-5216). See the COLUMN DRIFT note at the top.
  if (/^\s*CREATE\s+TABLE\s/i.test(code)) {
    const created = /^\s*CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s/i.test(code)
      ? code
      : code.replace(/^(\s*CREATE\s+TABLE\s+)/i, '$1IF NOT EXISTS ');
    const backfill = columnBackfillStatements(created);
    return backfill.length ? `${created};\n${backfill.join(';\n')}` : created;
  }
  if (/^\s*CREATE\s+SEQUENCE\s+(?!IF\s+NOT\s+EXISTS)/i.test(code)) {
    return code.replace(/^(\s*CREATE\s+SEQUENCE\s+)/i, '$1IF NOT EXISTS ');
  }
  if (/^\s*CREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF\s+NOT\s+EXISTS)/i.test(code)) {
    return code.replace(/^(\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+)/i, '$1IF NOT EXISTS ');
  }

  // --- CREATE OR REPLACE family ---
  if (/^\s*CREATE\s+FUNCTION\s/i.test(code)) {
    return code.replace(/^(\s*CREATE\s+)FUNCTION\s/i, '$1OR REPLACE FUNCTION ');
  }
  if (/^\s*CREATE\s+TRIGGER\s/i.test(code)) {
    return code.replace(/^(\s*CREATE\s+)TRIGGER\s/i, '$1OR REPLACE TRIGGER ');
  }
  if (/^\s*CREATE\s+VIEW\s/i.test(code)) {
    return code.replace(/^(\s*CREATE\s+)VIEW\s/i, '$1OR REPLACE VIEW ');
  }

  // --- CREATE POLICY → DROP-then-CREATE ---
  const pol = /^\s*CREATE\s+POLICY\s+("?[\w]+"?)\s+ON\s+([\w.]+(?:\."?[\w]+"?)?)/i.exec(code);
  if (pol) {
    return `DROP POLICY IF EXISTS ${pol[1]} ON ${pol[2]};\n${code}`;
  }

  // --- ALTER TABLE … ADD CONSTRAINT → DO-block guard ---
  // Tolerate every "already exists" code an idempotent re-apply can raise:
  //   duplicate_object (42710)         — duplicate constraint name (FK/UNIQUE/CHECK)
  //   duplicate_table (42P07)          — duplicate relation
  //   invalid_table_definition (42P16) — "multiple primary keys not allowed" (PK re-add;
  //                                       PG checks for an existing PK before the name clash)
  //   wrong_object_type (42809)        — later migrations converted the relation to a view
  //                                       (baseline table DDL re-applies as a no-op)
  // Safe in this context: statements come from a pg_dump of a VALID schema, so the only
  // re-run failure mode is "already present", never a genuinely invalid definition.
  if (/^\s*ALTER\s+TABLE\s/i.test(code) && /\bADD\s+CONSTRAINT\b/i.test(code)) {
    return (
      `DO ${GUARD_TAG} BEGIN\n` +
      `  ${code.trim()};\n` +
      `EXCEPTION\n` +
      `  WHEN duplicate_object THEN NULL;\n` +
      `  WHEN duplicate_table THEN NULL;\n` +
      `  WHEN invalid_table_definition THEN NULL;\n` +
      `  WHEN wrong_object_type THEN NULL;\n` +
      `END ${GUARD_TAG}`
    );
  }

  // --- Known-idempotent keepers ---
  if (/^\s*ALTER\s+TABLE\s+.*ENABLE\s+ROW\s+LEVEL\s+SECURITY/is.test(code)) return code;
  if (/^\s*ALTER\s+TABLE\s+.*ALTER\s+COLUMN\s+.*SET\s+DEFAULT/is.test(code)) return code;
  if (/^\s*ALTER\s+TABLE\s+.*REPLICA\s+IDENTITY/is.test(code)) return code; // CDC; re-set = no-op
  if (/^\s*ALTER\s+SEQUENCE\s/i.test(code)) return code; // OWNED BY — idempotent
  if (/^\s*COMMENT\s+ON\s/i.test(code)) return code; // always replaces

  // Unknown shape: keep it (don't silently lose schema) but flag it.
  const token = (code.trim().split(/\s+/).slice(0, 2).join(' ') || code.trim()).slice(0, 40);
  onUnknown?.(token);
  return code;
}

export interface SanitizeResult {
  sql: string;
  /** Leading tokens of statements that hit the unknown-shape fallback. */
  unknown: string[];
}

export function sanitizeBaselineVerbose(raw: string): SanitizeResult {
  const unknown: string[] = [];
  const header = [
    '-- 000-baseline.sql — GENERATED by sanitize-baseline.ts from a reference build.',
    '-- Idempotent: safe to re-apply against an empty OR an already-populated DB.',
    '-- Do not hand-edit; regenerate via build-reference-schema.ts → sanitize-baseline.ts.',
    '-- Schema changes are NEW migrations (104+), never edits here. (Plan: self-contained-migration-baseline-2026-06-02)',
  ].join('\n');

  // Strip psql backslash metacommands line-first (PG18 emits \restrict/\unrestrict
  // with NO trailing ';', so they'd otherwise merge into the next statement).
  const deMeta = raw
    .split('\n')
    .filter((line) => !/^\s*\\[a-z]/i.test(line))
    .join('\n');

  const body: string[] = [];
  for (const stmt of splitStatements(deMeta)) {
    const t = transformStatement(stmt, (tok) => unknown.push(tok));
    if (t !== null) body.push(t + ';');
  }
  return { sql: `${header}\n\n${body.join('\n\n')}\n`, unknown };
}

export function sanitizeBaseline(raw: string): string {
  return sanitizeBaselineVerbose(raw).sql;
}

// --- CLI (only when run directly, not when imported by the test) ---
if (process.argv[1]?.endsWith('sanitize-baseline.ts')) {
  // EI-13913: this used to `require('node:fs')`, which throws "require is not
  // defined in ES module scope" when run via `tsx` / `node --experimental-strip-types`
  // (both treat this file as ESM) — the CLI half of the regen pipeline
  // (`npm run gen:baseline`) was silently unusable. A static top-level import
  // works in both the ESM-CLI case and the CJS-vitest-import case (the guard
  // above already keeps this block from running when the module is merely
  // imported by a test).
  const inPath = process.argv[2] ?? '/tmp/papercusp-reference-schema.raw.sql';
  const outPath = process.argv[3] ?? '/tmp/000-baseline.sql';
  const { sql, unknown } = sanitizeBaselineVerbose(readFileSync(inPath, 'utf8'));
  writeFileSync(outPath, sql);
  const tables = (sql.match(/CREATE TABLE IF NOT EXISTS/g) ?? []).length;
  console.log(`[sanitize] ${inPath} → ${outPath}`);
  console.log(`[sanitize] ${tables} tables; ${sql.split('\n').length} lines`);
  if (unknown.length) {
    console.warn(`[sanitize] ${unknown.length} statement(s) hit the unknown-shape fallback (kept verbatim):`);
    for (const u of [...new Set(unknown)]) console.warn(`  • ${u}`);
  } else {
    console.log('[sanitize] no unknown statement shapes — every statement matched a transform/keep rule');
  }
}
