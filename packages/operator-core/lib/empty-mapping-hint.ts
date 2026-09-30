/**
 * empty-mapping-hint — catch the `ok:true`-but-every-field-empty result.
 *
 * EI-10892. The dominant tool-waste mode in this system is NOT the hard failure.
 * A hard failure is loud, self-describing (invalid_args even renders the full arg
 * schema), and fixed on the next call. The expensive mode is the call that
 * SUCCEEDS and returns nothing usable — because the caller mapped the response
 * shape wrong.
 *
 * Measured on the 2026-07-13 agent-DX audit session: 178 tool calls, of which the
 * efficiency ledger recorded exactly ONE failure. The real waste was ~8-9 wasted
 * round-trips, every one of them `ok:true`:
 *
 *   tools.sessions.search(...)  → mapped x.session_id / x.text
 *                                 (really results[].provenance.session_id / .excerpt)
 *   tools.work_items.get(...)   → mapped w.state / w.checkpoint
 *                                 (really results[0].workItem.state; checkpoint is a SIBLING)
 *
 * Both produced arrays of perfectly-formed rows with every field an empty string.
 * The agent had to notice by eye, then spend an EXTRA call just to JSON.stringify a
 * raw result and learn the shape. None of that is visible to the health panel,
 * which grades only limit-failures / code:run adoption / orient dedup — so the
 * fleet reports "tool efficiency healthy" while the actual cost accrues unseen.
 *
 * This detector runs over a code:run script's RETURN VALUE — the one place where an
 * agent's own field mapping is applied — and says so out loud, at the moment it
 * happens, pointing at the fix (the tool's declared `returns`, EI-10882).
 *
 * Deliberately conservative. An empty result set is a legitimate, extremely common
 * answer ("no matches"), and a false accusation here is worse than silence: it
 * would train agents to distrust true negatives. So it fires ONLY on the signature
 * that cannot be a true negative — rows that EXIST (so the query matched) whose
 * fields are ALL blank (so the mapping missed). A row that is simply absent, or a
 * row with any populated field, never trips it.
 */

/**
 * The `tool_invocations.metadata_json` key code:run stamps when this detector fires,
 * and the key the empty-result-rate panel axis reads back (EI-10892).
 *
 * It is a shared constant rather than a string literal on each side ON PURPOSE: the
 * writer (agent-tools/code/run.ts) and the reader (empty-result-rate.ts's SQL) are in
 * different modules, and if either renamed its literal the axis would quietly read ZERO
 * forever — which is indistinguishable from "healthy". A metric that silently reports
 * perfection when its own plumbing is broken is worse than no metric. One constant, both
 * sides, no drift possible.
 */
export const EMPTY_MAPPING_METADATA_KEY = 'emptyMapping';

/** Rows must exist to be mis-mapped; a single row is too weak a signal to accuse. */
export const EMPTY_MAPPING_MIN_ROWS = 2;
/** Fraction of rows that must be fully-blank before we call it a mis-mapping. */
export const EMPTY_MAPPING_ROW_RATIO = 0.8;

/** Blank = the shape a missing field collapses to when you map a key that isn't there. */
function isBlank(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v as object).length === 0;
  return false; // numbers (incl. 0) and booleans (incl. false) are REAL values
}

/** A row is fully-blank when it has fields and every one of them is blank. */
function isFullyBlankRow(row: unknown): boolean {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
  const vals = Object.values(row as Record<string, unknown>);
  if (vals.length === 0) return false;
  return vals.every(isBlank);
}

/**
 * Collect every array worth judging — the payload itself, its array-valued fields,
 * AND the array-valued fields one level inside its rows.
 *
 * That last hop is the whole ballgame, and a top-level-only check misses the actual
 * bug. The real wasted result looked like:
 *
 *   [ { q: 'auto-loop reliable', n: 6, h: [ {sid:'',ts:'',own:'',t:''} × 6 ] }, … ]
 *
 * The OUTER rows are perfectly populated (`q`, `n` are real) — it is the nested `h`
 * rows that are uniformly blank, because that is where the per-hit field mapping was
 * applied. A detector that only looked at the outer array would have declared this
 * result healthy: precisely the false negative it exists to prevent. Depth is capped
 * at this one hop — deeper nesting is rare and the cost of scanning is not worth it.
 */
export function collectCandidateArrays(payload: unknown): unknown[][] {
  const out: unknown[][] = [];
  const pushArraysOf = (obj: unknown): void => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
    for (const v of Object.values(obj as Record<string, unknown>)) {
      if (Array.isArray(v)) out.push(v);
    }
  };

  if (Array.isArray(payload)) {
    out.push(payload);
    for (const row of payload) pushArraysOf(row); // one hop into each row
  } else if (payload && typeof payload === 'object') {
    pushArraysOf(payload);
    for (const v of Object.values(payload as Record<string, unknown>)) {
      if (Array.isArray(v)) for (const row of v) pushArraysOf(row);
    }
  }
  return out;
}

export interface EmptyMappingHint {
  rows: number;
  blankRows: number;
  text: string;
}

/** Judge ONE array: does it look like a mis-mapped row set? */
function judge(rows: unknown[]): { rows: number; blankRows: number } | null {
  if (rows.length < EMPTY_MAPPING_MIN_ROWS) return null;
  const objectRows = rows.filter((r) => r && typeof r === 'object' && !Array.isArray(r));
  // Non-object rows have no field mapping to get wrong.
  if (objectRows.length < EMPTY_MAPPING_MIN_ROWS) return null;
  const blankRows = objectRows.filter(isFullyBlankRow).length;
  if (blankRows < EMPTY_MAPPING_MIN_ROWS) return null;
  if (blankRows / objectRows.length < EMPTY_MAPPING_ROW_RATIO) return null;
  return { rows: objectRows.length, blankRows };
}

/**
 * Returns a hint when a code:run return value looks like a mis-mapped response
 * shape, else null. Pure; never throws.
 */
export function maybeEmptyMappingHint(payload: unknown, toolsUsed: readonly string[] = []): EmptyMappingHint | null {
  let worst: { rows: number; blankRows: number } | null = null;
  for (const candidate of collectCandidateArrays(payload)) {
    const verdict = judge(candidate);
    if (verdict && (!worst || verdict.blankRows > worst.blankRows)) worst = verdict;
  }
  if (!worst) return null;

  const suspects = toolsUsed.length > 0 ? ` (tools called: ${toolsUsed.slice(0, 4).join(', ')})` : '';
  return {
    rows: worst.rows,
    blankRows: worst.blankRows,
    text:
      `${worst.blankRows} of ${worst.rows} returned rows have EVERY field blank${suspects}. ` +
      'The rows exist, so the underlying call matched — this is almost always a MIS-MAPPED RESPONSE SHAPE ' +
      'in your script, not an empty result set. You are reading keys the payload does not have. ' +
      "Check the tool's declared response shape (tools:find { query:'<tool>' } → each hit's `returns`) " +
      'before re-running; if it declares none, return ONE raw result (e.g. `return JSON.stringify(r).slice(0,800)`) ' +
      'to learn the real keys in a single call rather than guessing again. ' +
      'Common shapes: sessions:search → results[].provenance.session_id / .excerpt; ' +
      'work_items:get → results[0].workItem.* (checkpoint is a SIBLING of workItem, not inside it).',
  };
}
