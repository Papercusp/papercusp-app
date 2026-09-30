/**
 * owner-directive-status.ts — P-006 of plan
 * `directive-visibility-and-ownership-2026-09-22`.
 *
 * ── WHAT THIS IS ────────────────────────────────────────────────────────────
 *
 * ONE pure function that answers "what is the state of this owner directive",
 * DERIVED from the inputs that already exist, and stored nowhere.
 *
 * Per D-001 (derived-truth ladder): a `status` column on `owner_directives`
 * would be a second copy of a truth the ledger already owns, and it would
 * drift. Drift between two independently-maintained status fields is not a
 * hypothetical here — it is the measured defect this module was written to
 * remove (D-007: directives #86/#87 were dispositioned `done` while a separate
 * capture-triage field still read `pending`, so they kept rendering as
 * "[DUE] … promote or dismiss" after being finished). Plan
 * owner-directive-delivery-redesign-2026-09-22 (D-001) then removed that
 * capture triage altogether, so the disposition is the ONLY statement about a
 * directive's lifecycle and the two-field reconciliation no longer exists.
 *
 * ── WHY WORK-ITEM REFS ARE AN INPUT ─────────────────────────────────────────
 *
 * Work-item refs answer exactly one question: is someone ACTIVELY on it, and
 * who. They never answer "is it finished" — that is the disposition's job
 * alone. Every directive that legitimately never spawns work (a question
 * answered in chat, a standing rule absorbed as a fact) would otherwise sit
 * `unclaimed` forever if refs were the only input, and a completed work-item
 * therefore returns the directive to `unclaimed` rather than `done`.
 *
 * That is correct but easy to misread as a bug, so the verdict carries
 * `workedButUndispositioned` to distinguish it from a directive nobody has
 * ever touched. Rendering those two identically recreates the noise D-007
 * describes one layer up: the agent did the work, closed the item, and the
 * banner goes back to shouting as though nothing happened. The caller should
 * nudge for a disposition, NOT re-issue a carry-out imperative.
 */

import { TERMINAL_WORK_ITEM_STATES } from './work-items';
import type { OwnerDirectiveDisposition } from './owner-directives';

/**
 * The four states from D-001. Deliberately NOT the same type as
 * `OwnerDirectiveState` (open | done | declined): this one also answers WHO is
 * on an open directive, which the directive row alone cannot say.
 */
export type DirectiveStatusKind = 'unclaimed' | 'claimed' | 'done' | 'declined';

/** The minimum a caller must supply about the directive row itself. */
export interface DirectiveStatusDirectiveInput {
  /** Lifecycle. `null` until `orders:disposition` runs. */
  dispositionStatus: OwnerDirectiveDisposition | null;
  /** Present iff a disposition was recorded. */
  dispositionedAtMs?: number | null;
}

/** One work-item carrying `directive_ref = <this directive>`. */
export interface DirectiveLinkedWorkItem {
  id: string;
  /** Canonical work-item status; compared against TERMINAL_WORK_ITEM_STATES. */
  state: string;
  /** Who holds it. Absent/empty is a real case — an unassigned linked item. */
  assignee?: string | null;
}

export interface DirectiveStatus {
  kind: DirectiveStatusKind;
  /**
   * Set ONLY when `kind === 'claimed'`. The owner actively carrying it; when
   * several hold non-terminal items, this is the first in the supplied order
   * and `holders` carries the rest.
   */
  claimedBy?: string;
  /** Every owner on a NON-TERMINAL linked work-item, de-duplicated, in order. */
  holders: string[];
  /** Ids of the non-terminal linked work-items, in the supplied order. */
  activeWorkItemIds: string[];
  /**
   * TRUE when the directive has linked work-items but all of them are
   * terminal, and no disposition was ever recorded. Still `unclaimed` — but
   * the honest prompt is "disposition this", not "carry this out".
   */
  workedButUndispositioned: boolean;
}

function isTerminal(state: string): boolean {
  return TERMINAL_WORK_ITEM_STATES.includes(state);
}

/**
 * Derive a directive's status from the directive row plus every work-item that
 * points back at it. PURE — no IO, no clock, no ambient state.
 *
 * Precedence, and each rung is load-bearing:
 *   1. DISPOSITION wins over everything. It is the only explicit statement
 *      about the WORK.
 *   2. A non-terminal linked work-item means someone is on it.
 *   3. Otherwise unclaimed — the DEFAULT at capture, and the most important
 *      bucket to render (D-005), never a degenerate case.
 */
export function deriveDirectiveStatus(
  directive: DirectiveStatusDirectiveInput,
  linkedWorkItems: readonly DirectiveLinkedWorkItem[] = [],
): DirectiveStatus {
  const active = linkedWorkItems.filter((item) => !isTerminal(item.state));
  const activeWorkItemIds = active.map((item) => item.id);
  const holders = [...new Set(active.map((item) => item.assignee).filter((a): a is string => !!a))];

  // (1) A recorded disposition is the authoritative statement about the work.
  // Guarded on the TIMESTAMP as well as the status so a row that somehow
  // carries a status with no recorded disposition is not read as terminal.
  if (directive.dispositionStatus !== null && directive.dispositionedAtMs != null) {
    return {
      kind: directive.dispositionStatus === 'declined' ? 'declined' : 'done',
      holders,
      activeWorkItemIds,
      workedButUndispositioned: false,
    };
  }

  // (2) Someone holds a live work-item pointing at this directive.
  if (active.length > 0) {
    const claimedBy = holders[0];
    return {
      kind: 'claimed',
      ...(claimedBy ? { claimedBy } : {}),
      holders,
      activeWorkItemIds,
      workedButUndispositioned: false,
    };
  }

  // (3) Unclaimed — the default, and the bucket the whole plan exists to show.
  return {
    kind: 'unclaimed',
    holders,
    activeWorkItemIds,
    workedButUndispositioned: linkedWorkItems.length > 0,
  };
}

/** The four distinctions the bare `kind` cannot make — the `owner.directive.status`
 *  cell's declared assessment codes (D-038: an assessment says what a measurement
 *  MEANS, so it is deliberately not a re-projection of the headline). */
export type DirectiveStatusAssessment =
  | 'open-unworked'
  | 'worked-awaiting-disposition'
  | 'in-flight'
  | 'settled';

/**
 * The `owner.directive.status` assessment, derived from a status this module already
 * produced. PURE — no IO, no clock, no ambient state.
 *
 * Exported rather than left inline in the `orders:get` handler for the same reason
 * `directiveNeedsAction` is: the cell's control table must drive the REAL assessor.
 * A second copy living in the test would let the declaration and the emitted code
 * drift apart while every guard still passed — which is precisely the vacuous-guard
 * failure the cell-assessment partition exists to make impossible.
 */
export function assessDirectiveStatus(status: DirectiveStatus): DirectiveStatusAssessment {
  return status.kind === 'claimed'
    ? 'in-flight'
    : status.kind === 'unclaimed'
      ? status.workedButUndispositioned
        ? 'worked-awaiting-disposition'
        : 'open-unworked'
      : 'settled';
}

/**
 * TRUE when the directive still needs SOMEBODY to act — the predicate a
 * renderer uses to decide whether a row belongs in an imperative bucket at all.
 *
 * Exported as its own function rather than left to each caller to re-derive:
 * the D-007 bug was precisely a caller re-deriving "is this live?" from one
 * field, and a second re-derivation elsewhere is how that returns.
 */
export function directiveNeedsAction(status: DirectiveStatus): boolean {
  return status.kind === 'unclaimed' || status.kind === 'claimed';
}

/**
 * The stable label form named in the plan (`claimed-by:<ownerId>`). Kept beside
 * the structured verdict so a line renderer never hand-concatenates its own
 * variant of it.
 */
export function directiveStatusLabel(status: DirectiveStatus): string {
  if (status.kind === 'claimed') return status.claimedBy ? `claimed-by:${status.claimedBy}` : 'claimed';
  return status.kind;
}
