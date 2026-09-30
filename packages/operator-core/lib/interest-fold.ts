/* ══════════════════════════════════════════════════════════════════════════════
 * INTEREST FOLD — the `fold` tier of the interest profiles, resolved for one caller.
 *
 * P-011 of state-plane-interest-and-hardening-2026-08-21.
 *
 * P-010 declared WHAT an agent in a given context should be watching. This resolves
 * that declaration against ONE caller's live contexts and emits, per match, the cell's
 * headline path and a ready re-read handle — the shape coord:orient folds in.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ────────────────────────────────────────
 * It never reads a cell's VALUE, so it costs ZERO dispatches. That is not an
 * optimisation, it is D-001: "every automatic delivery surface this plan adds ships
 * the reread HANDLE, a staleness/change VERDICT, or an edge-triggered wake — never an
 * ambient copy of the value itself. Pull (state:read at the moment of acting) remains
 * the only path a value travels into an agent's reasoning."
 *
 * `answers` below is `spec.headline`, which is a FIELD PATH ("gate.consecutiveReds"),
 * not a reading. Naming the field a cell answers with is a handle; carrying what it
 * currently says would be the transcription D-001 forbids. Anyone extending this to
 * "just include the current value, it's cheap" is reintroducing exactly the artifact
 * the plane exists to kill — the cost was never the reason.
 *
 * Being value-free is also what keeps this inside the facts-fold dispatch budget the
 * plan item requires ("one dispatch per DISTINCT cell across the whole fold"): zero is
 * under any budget, unconditionally, for any number of profile rows.
 *
 * ── SCOPE: CELL ROWS ONLY ─────────────────────────────────────────────────────
 * The registry also carries `fold`-tier EVENT rows (fleet-claim-released,
 * fleet-item-completed). They are skipped here, for two independent reasons — either
 * alone would be sufficient:
 *   • an event family has no `state:read` handle to emit, which is the entire output
 *     shape of this fold; and
 *   • both are fleet burn-down/claim signals, and D-005 reserves metric content for
 *     fleet-spec-scoped-metrics-2026-08-21's leader fold. This fold lands ATOP their
 *     shape and carries no counts, populations, or metric fields.
 * Auto-arming those events is P-014's job, not this one.
 * ══════════════════════════════════════════════════════════════════════════════ */

import { getCell, type CellReader } from './cell-registry';
import { INTEREST_PROFILES, type InterestContext, type InterestProfileRow } from './interest-profiles';
import { cellRereadHandle, type CellHandle } from './state-plane-stamp';

/** One folded interest: which cell, why this caller, and how to re-read it. */
export type InterestFoldRow = {
  /** The context that matched — an agent can match several rows for several reasons. */
  readonly context: InterestContext;
  /** The cell id. */
  readonly cell: string;
  /**
   * FIELD PATH of the value this cell answers with (`spec.headline`) — deliberately
   * the path and not the reading. See the header.
   */
  readonly answers: string;
  /** Why this context should care. Verbatim from the profile row. */
  readonly why: string;
} & CellHandle;

export interface InterestFoldInput {
  /**
   * The caller's live contexts, as resolved by the surface doing the folding. Passed
   * in rather than derived here: the same reason `cellIdentity` is INJECTED into
   * composeOrient rather than computed inside it — a guessed context either fails
   * closed (useless) or fails open (advertises a cell for a role the caller does not
   * occupy). The caller knows; this module must not guess.
   */
  readonly contexts: readonly InterestContext[];
  /**
   * The audience the fold is resolved for. REQUIRED, never optional: an optional
   * reader is a defaulted audience, and a defaulted access check fails OPEN.
   */
  readonly reader: CellReader;
  /**
   * Values for the context fields a profile row names in `of`, keyed by that exact
   * field name (e.g. `{ 'workItem.primaryPath': 'packages/x/y.ts' }`). A name absent
   * here yields an `unreadable { needs }` handle rather than an unqualified one.
   */
  readonly subjects?: Readonly<Record<string, unknown>>;
  /** Defaults to the live registry; injectable so tests can drive control rows. */
  readonly rows?: readonly InterestProfileRow[];
}

/**
 * Resolve the fold-tier interests for one caller.
 *
 * ⚠ A row whose cell this reader may not see is dropped SILENTLY — no row, no count,
 * no "withheld" marker. That asymmetry with the rest of this codebase (where a
 * truncation or omission must always be disclosed) is deliberate and load-bearing:
 * `getCell` returns undefined for "outside your audience" and "does not exist"
 * alike, precisely so a refusal cannot be used to probe for narrow cells. A
 * `withheld: 2` counter here would rebuild that enumeration oracle in one line and
 * hand it to every caller — the P-019 property is only worth anything if EVERY
 * surface honours it. Two of the three fold-tier cell rows today point at
 * OPERATOR_PIPELINE_VISIBILITY cells, so this path is the common case, not an edge.
 */
export function foldInterests(input: InterestFoldInput): InterestFoldRow[] {
  const { contexts, reader, subjects, rows = INTEREST_PROFILES } = input;
  if (!reader || !contexts?.length) return [];

  const active = new Set(contexts);
  const out: InterestFoldRow[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (row.tier !== 'fold') continue;
    if (row.watch.kind !== 'cell') continue;
    if (!active.has(row.context)) continue;

    // THE audience check. Fails closed, and omits rather than marks — see the note above.
    const spec = getCell(row.watch.cell, reader);
    if (!spec) continue;

    // One handle per (context, cell). The same cell legitimately appears under two
    // contexts with different rationales; the same pair twice would be a registry
    // defect to fix there rather than something to render twice.
    const dedupe = `${row.context}\x00${spec.cell}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);

    // A cell row's `of` names the caller-relative subject (the `as` argument). Only the
    // first is meaningful for a cell — `as` takes one subject — whereas an EVENT row's
    // `of` fills N key params. Resolving `of[0]` and letting cellRereadHandle refuse on
    // a miss is what keeps a per-path cell from answering about someone else's path.
    const subjectKey = row.of?.[0];
    const subject = subjectKey ? subjects?.[subjectKey] : undefined;

    out.push({
      context: row.context,
      cell: spec.cell,
      answers: spec.headline,
      why: row.why,
      ...cellRereadHandle(spec, subject),
    });
  }

  // Deterministic: registration order is an implementation detail, and a fold that
  // reorders between two otherwise identical orients invites a spurious diff.
  out.sort((a, b) => (a.cell < b.cell ? -1 : a.cell > b.cell ? 1 : a.context < b.context ? -1 : 1));
  return out;
}

/** The orient leg's shape. `null` when nothing folded — never an empty shell. */
export interface InterestFoldBlock {
  readonly note: string;
  readonly watches: InterestFoldRow[];
}

const NOTE =
  'Cells your current role/lane says are worth watching. These are HANDLES, not readings: ' +
  'nothing here carries a value, so re-read with the handle at the moment you act. ' +
  'A `unreadable.needs` entry means the cell is caller-relative and this call could not ' +
  'resolve its subject — supply it yourself rather than re-reading unqualified.';

/**
 * Build the leg, or `null` when there is nothing to say.
 *
 * Returns null rather than `{ watches: [] }` for the same reason `stampStatePlane`
 * does: an empty block reads as "your contexts have no interests", which is a claim,
 * and it would be a false one for the very common caller whose matches were all
 * dropped by the audience check.
 */
export function interestFold(input: InterestFoldInput): InterestFoldBlock | null {
  let watches: InterestFoldRow[];
  try {
    watches = foldInterests(input);
  } catch {
    // An enrichment must never fail the orientation it decorates.
    return null;
  }
  if (watches.length === 0) return null;
  return { note: NOTE, watches };
}
