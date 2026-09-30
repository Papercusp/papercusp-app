/**
 * now-next-derivation.ts — reconcile a plan's STORED `## Now` next-pointer
 * against the one DERIVED from its item graph, at read time.
 *
 * P-002 of deterministic-plan-state-derivation-2026-08-31 (D-002).
 *
 * # The problem
 *
 * `next:` is a second copy of a fact the item graph already owns. Nothing
 * recomputes it when an item flips terminal, so it goes stale silently — and
 * it is believed, because it is specific and was correct when written.
 * Measured 2026-08-31 over `harness_shared.harness_plans` (papercusp): of 349
 * plans naming a `P-NNN` in `now_next`, **208 name ONLY items that are already
 * done/dropped**, and **89 of those are on a plan that is still live**. The
 * one existing guard (`now-item-contradictions`) runs at WRITE time only, so a
 * pointer written while `P-001` was `todo` is never re-examined when `P-001`
 * later flips `done`.
 *
 * # Why this shape, and not a blind replacement
 *
 * The naive fix — always return the derived pointer — destroys real
 * information. A stored line like *"P-001 first: it is the smallest change and
 * the highest-value"* carries RATIONALE that no derivation can invent, and a
 * line like *"run the acceptance grading"* is about something that is not a
 * plan item at all. So the derivation is given exactly the jurisdiction the
 * evidence supports:
 *
 *   **The stored pointer is superseded when, and only when, every plan item it
 *   names is already terminal** — i.e. it directs the reader at nothing live.
 *
 * That is precisely the measured class. Prose naming a live item is passed
 * through verbatim (the author may deliberately have chosen a lower-ranked
 * item, and the graph cannot call that wrong); prose naming no item of this
 * plan is passed through untouched (the graph has no jurisdiction over it);
 * and a blank pointer is simply filled in.
 *
 * The universal rule leaves one residual, found by running this module over
 * the live corpus rather than by reasoning about it: a pointer whose DIRECTIVE
 * is stale but which also mentions a live item survives as `ratified`
 * (measured on `silent-wrong-answers-2026-08-01` — *"Start P-015 …"* where
 * P-015 had shipped). Widening the supersede rule to "any named item is
 * terminal" would catch it and would also destroy every *"P-001 landed; pick
 * up P-002"* — far more good pointers than bad. So the residual is handled by
 * APPENDING a caution instead, using the write-time contradiction classifier
 * that already separates those two shapes.
 *
 * The derivation travels with EVERY disposition, including the ones where the
 * stored text wins — so a reader can always see the graph's own verdict and
 * how it was reached, rather than having to trust that a pass-through was
 * checked.
 *
 * Read-time only. Nothing here mutates a plan; the stored bytes stay exactly
 * as the author wrote them (and remain visible verbatim in `now.raw`), the
 * same spirit as plans:get's other overlays (liveness decoration,
 * linkedFeatures, planItemTests).
 */

import { deriveNextPointer, type DerivedNextPointer, type PlanItem } from '@papercusp/plan-parser';
import { detectNowItemContradictions, type NowItemContradiction } from './now-item-contradictions';

/**
 * What happened to the author's stored pointer on this read.
 *
 * Deliberately five distinct values rather than a boolean: "the graph agrees",
 * "the graph has nothing to say", and "the graph cannot see what this prose is
 * about" are three different reasons a stored line survives, and collapsing
 * them would let a pass-through that was never checked read as a ratified one.
 */
export type NowNextDisposition =
  /** The plan has no items; the graph is silent and the prose stands. */
  | 'abstained'
  /** The prose names no item of this plan — outside the graph's jurisdiction. */
  | 'unverifiable'
  /** The prose names at least one live item; it stands, verbatim. */
  | 'ratified'
  /** Every item the prose names is terminal — the derived pointer replaces it. */
  | 'superseded'
  /** There was no stored pointer; the derived one fills the gap. */
  | 'filled';

export interface NowNextReconciliation {
  /** The pointer the read surface should present. */
  next: string;
  disposition: NowNextDisposition;
  /** The author's stored pointer, verbatim, on every disposition. */
  storedNext: string;
  /** Plan items the stored prose names that are already terminal. */
  staleStoredRefs: Array<{ id: string; status: 'done' | 'dropped' }>;
  /**
   * Terminal items the stored prose still DIRECTS WORK AT, on a pointer that
   * was otherwise ratified — the residual class the universal supersede rule
   * cannot reach (see `reconcileNowNext`). Empty on every other disposition.
   */
  contradictions: NowItemContradiction[];
  /** The graph's own verdict, attached on every disposition. */
  derived: DerivedNextPointer;
}

const PLAN_ITEM_REF_RE = /\bP-\d{3,}\b/g;

/**
 * Prefix that marks a superseded pointer. A literal no author writes by hand,
 * so a reader (or a later sweep) can recognise a derived line on sight and
 * never mistake it for stored prose.
 */
export const DERIVED_NEXT_MARK = '⟳ derived';

/**
 * Reconcile the stored next-pointer with the item graph.
 *
 * Pure — no I/O, no clock. `storedNext` is the parsed `now.next` (may be
 * empty); `items` are the plan's items, in document order.
 */
export function reconcileNowNext(
  storedNext: string | null | undefined,
  items: readonly PlanItem[],
  slug = '',
): NowNextReconciliation {
  const stored = (storedNext ?? '').trim();
  const derived = deriveNextPointer(items);

  const terminalById = new Map<string, 'done' | 'dropped'>();
  const knownIds = new Set<string>();
  for (const item of items) {
    knownIds.add(item.id);
    if (item.storedStatus === 'done' || item.storedStatus === 'dropped') {
      terminalById.set(item.id, item.storedStatus);
    }
  }

  // Only ids this plan actually defines count. A `P-003` naming ANOTHER plan's
  // item is not a claim about this graph, and treating it as one would
  // manufacture a contradiction out of a citation.
  const namedIds = [...new Set(stored.match(PLAN_ITEM_REF_RE) ?? [])].filter((id) =>
    knownIds.has(id),
  );
  const staleStoredRefs = namedIds
    .filter((id) => terminalById.has(id))
    .map((id) => ({ id, status: terminalById.get(id)! }));

  const base = { storedNext: stored, staleStoredRefs, contradictions: [], derived };

  if (derived.reason === 'no-items') {
    return { ...base, next: stored, disposition: 'abstained' };
  }
  if (!stored) {
    return { ...base, next: derived.text, disposition: 'filled' };
  }
  if (namedIds.length === 0) {
    return { ...base, next: stored, disposition: 'unverifiable' };
  }
  if (staleStoredRefs.length < namedIds.length) {
    // At least one named item is still live, so the prose is not wholly dead
    // and must not be replaced. But "wholly dead" is not the only way to be
    // wrong: measured on `silent-wrong-answers-2026-08-01`, a pointer reading
    // "Start P-015 …" survives this branch because it ALSO mentions live items,
    // while its actual directive names an item that shipped.
    //
    // Reuse the WRITE-time classifier rather than inventing a second heuristic:
    // `detectNowItemContradictions` already separates "P-001 landed; pick up
    // P-002" (a completion note, correct) from "Start P-015" (a direction to
    // redo finished work). It was only ever run on writes, which is why it
    // never caught a pointer that went stale AFTER it was written — this is the
    // same detector at the moment it can actually fire.
    //
    // Append-only: the caution is added, nothing is replaced, so a
    // false positive costs a line of prose and never a real instruction.
    const contradictions = detectNowItemContradictions({
      now: { state: '', next: stored, raw: stored, lineNumber: 0 },
      items: [...items],
      slug,
    });
    if (contradictions.length === 0) {
      return { ...base, next: stored, disposition: 'ratified' };
    }
    return {
      ...base,
      contradictions,
      disposition: 'ratified',
      next:
        `${stored}\n\n${DERIVED_NEXT_MARK} caution — this pointer still directs work at ` +
        `${contradictions.map((c) => `${c.id} [${c.status}]`).join(', ')}, already terminal. ` +
        `Per the item graph, ${derived.text}`,
    };
  }

  // Every item the prose names is terminal. Lead with the derived verdict and
  // keep the author's line beneath it, prepend-only: no content is destroyed,
  // and the reader is told which line is computed and which was typed.
  const superseded =
    `${DERIVED_NEXT_MARK} — ${derived.text}\n\n` +
    `(Stored next, superseded: it directs work at ${staleStoredRefs
      .map((r) => `${r.id} [${r.status}]`)
      .join(', ')}, already terminal. Kept verbatim: ${stored})`;
  return { ...base, next: superseded, disposition: 'superseded' };
}
