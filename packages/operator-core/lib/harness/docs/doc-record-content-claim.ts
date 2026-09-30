/**
 * Pure judge for the claim migration 789 writes into the `harness_shared.harness_docs`
 * column comments: `upsertDocRecord` DOES populate `content`, `content_hash` and
 * `frontmatter`, and does NOT write `content_mode`.
 *
 * WHY THIS EXISTS, AND WHY IT INVERTED. Migration 787 (2026-08-10) pinned the OPPOSITE
 * claim — that no writer populated those columns — because none did: 0 of 952
 * `content_mode='authored'` rows held content, and the column DEFAULTS (`content=''`,
 * `content_mode='authored'`) made every row assert a contract the writer never evaluated.
 * P-008 then made PG canonical for authored doc prose (D-025, owner-directed), so the
 * writer now populates them and 787's comments would be stale in the opposite direction.
 * 787 anticipated exactly this and prescribed the path taken here: "If it is settled
 * toward PG-canonical prose, the migration that populates content updates these comments
 * with it." Hence migration 789, and hence this inversion — the guard tracks the
 * contract, it does not outlive it.
 *
 * THE JUDGE IS SYMMETRIC IN THREE DIRECTIONS, and each caught a real hazard:
 *
 *   1. A column that must be WRITTEN and is not — the regression back to metadata-only
 *      upserts, which would leave PG canonical in name while the prose silently stopped
 *      being saved. New rows would take the '' default and the projector would then have
 *      nothing to project.
 *   2. `content_mode` being WRITTEN — the composed-row hazard. For CLAUDE.md / AGENTS.md
 *      the parts are canonical and `content` is the projector's cache (D-010); a metadata
 *      upsert that flipped the mode, or wrote prose into a composed row, would corrupt the
 *      cache `project-doc-parts.mjs` trusts to recognise its own output.
 *   3. The writer not being found at all. A detector keyed to a symbol that silently
 *      reports "clean" once that symbol is renamed is a coverage loss dressed as a pass
 *      (the failure mode filed as EI-20059308594618912), so a missing writer is a
 *      violation here, never a quiet ok.
 *
 * ⚠ IT JUDGES ASSIGNMENT, NOT MENTION — and that distinction is load-bearing, not
 * pedantry. The inverted writer READS `content_mode` in its ON CONFLICT predicates
 * (`WHEN harness_shared.harness_docs.content_mode = 'composed'`) precisely IN ORDER to
 * protect it. A judge that matched a bare `\bcontent_mode\b` would therefore fire on the
 * very code implementing hazard #2's guard — flagging the protection as the violation.
 */

/** Columns the writer MUST populate for an authored doc (migration 789's comments). */
export const CLAIMED_WRITTEN_COLUMNS = ['content', 'content_hash', 'frontmatter'] as const;

/** Columns the writer MUST NOT assign. See hazard #2 above. */
export const CLAIMED_UNWRITTEN_COLUMNS = ['content_mode'] as const;

export type ClaimedWrittenColumn = (typeof CLAIMED_WRITTEN_COLUMNS)[number];
export type ClaimedUnwrittenColumn = (typeof CLAIMED_UNWRITTEN_COLUMNS)[number];

export type DocRecordContentClaimVerdict = {
  ok: boolean;
  /** True when the writer function was located in the source at all. */
  writerFound: boolean;
  /** Of the must-write columns, those the writer no longer appears to write. */
  missingColumns: ClaimedWrittenColumn[];
  /** Of the must-not-write columns, those the writer now appears to assign. */
  writtenColumns: ClaimedUnwrittenColumn[];
  violations: string[];
};

const WRITER = 'upsertDocRecord';

/**
 * Slice the source down to `upsertDocRecord`'s body, so an unrelated mention of these
 * column names elsewhere in the file cannot red the gate. Returns null when the writer is
 * absent (a rename, a move, a deletion) — the caller treats that as a violation.
 */
function sliceWriterBody(source: string): string | null {
  const start = source.indexOf(`export async function ${WRITER}`);
  if (start === -1) return null;
  // The writer ends where the next top-level export begins (the file declares each
  // export at column 0), or at EOF for the last one.
  const rest = source.slice(start + 1);
  const nextExport = rest.indexOf('\nexport ');
  return nextExport === -1 ? rest : rest.slice(0, nextExport);
}

/** Drop `--` line comments so prose inside the SQL cannot be read as a column write. */
function stripSqlLineComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('--');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

/**
 * The column list of the INSERT, i.e. `INSERT INTO ... ( <these> ) VALUES`.
 *
 * Returns [] when there is no INSERT rather than throwing: a writer refactored into a
 * plain UPDATE is a legitimate shape, and the SET-assignment check below still judges it.
 */
export function insertColumnList(sql: string): string[] {
  const m = /INSERT\s+INTO\s+[\w.]+\s*\(([\s\S]*?)\)\s*VALUES/i.exec(sql);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
}

/**
 * Does the writer ASSIGN this column?
 *
 * Two shapes count, and only these two:
 *   • the column appears in the INSERT column list;
 *   • the column begins an assignment at the start of a line — the SET / ON CONFLICT DO
 *     UPDATE form used throughout this file.
 *
 * A qualified, mid-line occurrence (`harness_shared.harness_docs.content_mode = 'composed'`
 * inside a CASE predicate, or `COALESCE(..., harness_shared.harness_docs.content)`) is a
 * READ and deliberately does not count. Anchoring to line-start is what separates the two,
 * and it is why the fixture controls in the sibling test pin a predicate read as a NON-match.
 */
export function assignsColumn(sql: string, col: string): boolean {
  if (insertColumnList(sql).includes(col)) return true;
  return new RegExp(`^\\s*${col}\\s*=(?!=)`, 'm').test(sql);
}

/** Judge a `doc-record.ts` source text against the schema-comment claim. */
export function judgeDocRecordContentClaim(source: string): DocRecordContentClaimVerdict {
  const body = sliceWriterBody(source);
  if (body === null) {
    return {
      ok: false,
      writerFound: false,
      missingColumns: [],
      writtenColumns: [],
      violations: [
        `${WRITER} was not found in doc-record.ts. This guard pins migration 789's column comments ` +
          `("the writer populates content / content_hash / frontmatter, and never writes content_mode") ` +
          `to that writer, so it cannot confirm the claim and must not report clean. If the writer was ` +
          `renamed or moved, update WRITER in doc-record-content-claim.ts; if it was deleted, re-check ` +
          `whether the comments still describe reality.`,
      ],
    };
  }

  const sqlOnly = stripSqlLineComments(body);
  const missingColumns = CLAIMED_WRITTEN_COLUMNS.filter((col) => !assignsColumn(sqlOnly, col));
  const writtenColumns = CLAIMED_UNWRITTEN_COLUMNS.filter((col) => assignsColumn(sqlOnly, col));

  const violations = [
    ...missingColumns.map(
      (col) =>
        `${WRITER} no longer assigns the column ${col}, but migration 789's comment on ` +
        `harness_shared.harness_docs.${col} states that this writer populates it — PG is canonical for ` +
        `authored doc prose (D-025), so a row this writer creates without ${col} takes the column default ` +
        `and the doc's prose is silently not saved. Either restore the write, or write a new migration ` +
        `correcting the comment and update this guard with it. Do not silence the guard alone.`,
    ),
    ...writtenColumns.map(
      (col) =>
        `${WRITER} now assigns the column ${col}, which it must never write. For a content_mode='composed' ` +
        `doc (CLAUDE.md / AGENTS.md) harness_doc_parts is canonical and content is the projector's cached ` +
        `output (D-010); a metadata upsert that changed the mode would corrupt the cache that ` +
        `scripts/project-doc-parts.mjs relies on to recognise its own output, and would misroute the doc ` +
        `between the two projectors. Note this guard judges ASSIGNMENT, not mention — reading ${col} in a ` +
        `CASE predicate to PROTECT a composed row is expected and does not trip it.`,
    ),
  ];

  return {
    ok: violations.length === 0,
    writerFound: true,
    missingColumns,
    writtenColumns,
    violations,
  };
}
