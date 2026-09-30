/**
 * _holder-lens.ts — P-030's WORK-ITEM LENS onto the shared `HolderContext`
 * projection: who holds this work-item, and what are they trying to DO.
 *
 * Plan: unified-agent-state-plane-2026-07-27, P-030 (leg (b) of D-060). Rulings:
 * D-060 (the owner ask), D-092 + D-093 (disclose `agreement`/`competing`), D-046
 * (a ref, never a bigint), D-051 (assumptions are a count, never inline prose),
 * D-056 (unreadable ⇒ holder ABSENT, row STAYS), P-026 rule (f) (total).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠ A LENS, NOT A DERIVATION. It resolves nothing itself: it calls
 * `resolveHolderContext`, which gates on `getCell(AGENT_GOAL_CELL_ID, reader)`
 * and reads P-016's one resolver. That is D-038 axis 5 — a surface adds a LENS,
 * never a second derivation — and it is why P-030 is a few dozen lines rather
 * than a re-implementation of the precedence rule.
 *
 * ⚠⚠ THE RULE P-030 STATES IN CAPITALS, AND WHY IT IS RIGHT.
 * ⛔ NEVER add an intent column to `work_items`. `harness_shared.work_items`
 * carries `taken_by`/`taken_at`/`expires_at` and NO claim-intent column, so
 * there is nothing on the row to project — and that is the point. A goal column
 * here would be a THIRD place a goal is written (`coord_presence`,
 * `plan_item_claims`, `work_items`), i.e. a transcribed copy that silently rots,
 * which is precisely the defect P-017 (c)'s detector exists to catch. Read the
 * cell; do not copy the value.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠ WHY THIS RUNS OUTSIDE THE TOOL'S CACHE, AND IT IS AN ACCESS BUG IF IT DOES NOT.
 *
 * `work_items:list` and `work_items:get` both wrap their row read in
 * `cachedRead`, whose key is explicitly NON-principal-scoped ("depends only on
 * workspace + the filter args"). Holder context is READER-RELATIVE by
 * construction — the goal passes a P-019 audience check and the assumption keys
 * pass `agent_facts`' own `audience_scope`. Resolving it INSIDE the cached
 * factory would store one reader's answer and serve it to every other reader:
 * a silent cross-reader disclosure that no test asserting on content could
 * catch, because more content still contains the expected content (the exact
 * failure mode `cell-access-parity.test.ts` was written for). So the lens is
 * applied to the rows the cache returns, never to the rows it stores.
 *
 * ⚠ LIVE CLAIMS ONLY. A holder still named on a TERMINAL row is not working
 * toward it, so decorating a `done`/`passed`/`resolved` row with its holder's
 * CURRENT goal would render an unrelated goal beside finished work and read as
 * "this is what they are doing about this item". Same rule the goal resolver
 * applies to its own work-item leg, applied to the display side.
 */
import type { HolderContext, HolderContextSources } from '../../coord/holder-context';
import {
  resolveHolderAdvisoryMap,
  HOLDER_ADVISORY_DISTINCT_CAP,
} from '../coordination/holder-advisory';
import { isTerminalStateInput } from '../../work-item-dispatch-states';
import type { CellReader } from '../../cell-registry';

/**
 * ⚠ THREE THINGS THAT USED TO LIVE HERE NOW LIVE IN
 * `../coordination/holder-advisory.ts` (P-027): `HOLDER_CONTEXT_SCHEMA` (the
 * wire shape), the guarded reader resolver (renamed `holderContextReader` — it
 * was never lens-specific), and the distinct-holder cap.
 *
 * They moved because P-027 renders this same projection at four MORE subjects —
 * a claim refusal, a release request, a lock-queue entry, a plan-item conflict —
 * and leaving them here would have forced `locks:queue` and `plan_items:claim`
 * to import a private, underscore-prefixed WORK-ITEM module to describe their
 * own results. Same reasoning that moved `forSubject` into `coord/holder-context.ts`
 * under D-094: state the rule once, beside the shape it constrains.
 *
 * What remains here is the genuinely work-item-specific part: which ROWS have a
 * live holder worth decorating, and the row-shaped fields that get attached.
 */

/** The row fields this lens needs. Structural, so it never drags a work-item row
 *  type (or its schema) into the shared projection. */
export interface HolderLensRow {
  /** The unified holder field — `taken_by` for the feature family, `assignee` for
   *  the issue family; `work-items.ts` already normalises both onto this key. */
  assignee?: string | null;
  state?: string | null;
  /** This row's own ref, so the projection can avoid naming the row as its own
   *  rival (see {@link forRow}). Optional: a caller that omits it simply gets the
   *  unfiltered holder-level list. */
  id?: string | null;
}

/** What the lens attaches. Both keys are OPTIONAL on the row: an absent `holder`
 *  is the honest answer for "no goal" AND for "not readable by you", and those
 *  two must stay indistinguishable (D-056). */
export interface HolderLensFields {
  /** P-026's shared projection for this row's holder. */
  holder?: HolderContext;
  /**
   * Set when the lens did not even ATTEMPT this row's holder because the
   * distinct-holder cap bit.
   *
   * ⚠ THIS IS NOT AN ACCESS SIGNAL AND MUST NEVER BECOME ONE. It says "we did not
   * look", which is a fact about the READ. An absence caused by the audience gate
   * carries NO marker at all — marking it would make a refusal distinguishable
   * from an empty, i.e. a probe oracle for state the reader may not see (D-056).
   */
  holderOmitted?: 'cap';
}

/**
 * Should this row's holder be resolved at all?
 *
 * Exported for the suite: "only live claims" is the rule most likely to be
 * quietly relaxed by a later editor who wants the field on every row.
 */
export function rowHasLiveHolder(row: HolderLensRow): boolean {
  const holder = (row?.assignee ?? '').trim();
  if (!holder) return false;
  const state = (row?.state ?? '').trim();
  // An unrecognised/blank state is treated as NON-terminal: this decorates, and
  // failing toward "show the holder" for an unknown state is the harmless
  // direction, while failing toward "hide" would silently blank the field for a
  // whole family the moment its vocabulary widened.
  return state ? !isTerminalStateInput(state) : true;
}

/**
 * Attach each live holder's `HolderContext` to the rows that have one.
 *
 * TOTAL (P-026 rule f): never throws and never rejects — this decorates an
 * ordinary read, so a dead facts store, an unreachable PG or an unregistered
 * cell costs the `holder` field and NOTHING ELSE. Every row is returned either
 * way, in its original order (D-056: the row stays; cell visibility must never
 * leak through the SHAPE of the list).
 *
 * Returns NEW row objects — the inputs may be cache-owned and must not be
 * mutated, or one reader's holder context would be written into the shared
 * cached value and served to the next reader. That is the same disclosure bug
 * the module header describes, reached by a different route.
 */
export async function attachHolderContext<T extends HolderLensRow>(
  rows: readonly T[],
  reader: CellReader | null | undefined,
  opts: {
    nowMs?: number;
    distinctCap?: number;
    /** The IO legs, INJECTED — the same split P-026 uses (`coord/holder-context.ts`
     *  pure, `holder-context-sources.ts` the only part that touches a store). It is
     *  what lets this lens be unit-tested without a database, and it is why this
     *  suite needs no module mocking. */
    sources?: HolderContextSources;
  } = {},
): Promise<(T & HolderLensFields)[]> {
  const out = (rows ?? []).map((r) => ({ ...r })) as (T & HolderLensFields)[];
  // No identified reader ⇒ no reader-relative state, and the rows pass through
  // untouched. `resolveHolderContext` fails closed on this too; short-circuiting
  // here just avoids the fan-out.
  if (!reader?.ownerId?.trim() || out.length === 0) return out;

  // ONLY rows with a live holder contribute to the fan-out — a terminal row's
  // holder is never resolved, so it can neither be decorated nor consume cap
  // budget that a live row needs. First-seen order, so which holders survive the
  // cap is deterministic for a given row order rather than dependent on Map/Set
  // iteration incidentals (`resolveHolderAdvisoryMap` dedupes order-preservingly).
  const wanted = out.filter((r) => rowHasLiveHolder(r)).map((r) => r.assignee!.trim());
  if (wanted.length === 0) return out;

  // The SHARED fan-out (P-027) — one resolution per distinct holder, capped,
  // total. This lens deliberately owns no second copy of it: the four friction
  // points added by P-027 resolve holders exactly the same way, and two
  // implementations of "resolve once, project per subject" is the drift D-038
  // axis 5 forbids.
  const advisory = await resolveHolderAdvisoryMap(wanted, reader, {
    nowMs: opts.nowMs,
    sources: opts.sources,
    distinctCap: opts.distinctCap ?? HOLDER_ADVISORY_DISTINCT_CAP,
  });

  for (const row of out) {
    if (!rowHasLiveHolder(row)) continue;
    const owner = row.assignee!.trim();
    if (advisory.omitted.has(owner)) {
      row.holderOmitted = 'cap';
      continue;
    }
    // Null ⇒ nothing disclosable to THIS reader: no goal, or a goal they may not
    // read. The field is simply absent, identically in both cases (D-056).
    // `forRow` applies D-094's subtraction against THIS row's own ref.
    const ctx = advisory.forRow(owner, row.id);
    if (ctx) row.holder = ctx;
  }
  return out;
}
