/**
 * build-amendment.ts — the pure core of work_items:amend (plan-implementation-
 * framework-2026-06-15 P-004, "write-it-down amend op"; flag papercusp-workitem-amend).
 *
 * The amend op is the near-zero-friction way to RECORD a non-re-derivable structural
 * decision about a plan-run node (split / drop / re-approach / expand / note) durably,
 * BEFORE any dependent dispatch (D-001 commit-before-dispatch; the record is the
 * replayable artifact, not the Queen's reasoning). This module is the decideable core
 * — pure, unit-tested — that classifies an amendment given the caller's authority +
 * the target's live state; the tool (./amend.ts) wraps it with the durable write
 * (commentWorkItem) + the flag gate.
 *
 * Two disciplines from the plan:
 *  • Single-writer / propose-dispose (D-005): the authoritative steerer (Queen/operator)
 *    DISPOSES; an executing bee PROPOSES.
 *  • Edit-constraint on in-flight nodes (D-007 / dynamism guard): a DISRUPTIVE amendment
 *    (drop / re-approach) on a node a worker is mid-execution on must not silently yank
 *    it — it requires compensation. Recorded as a flag so the caller + worker see it;
 *    never auto-yanked.
 */

export type AmendmentKind = 'split' | 'drop' | 'reapproach' | 'expand' | 'note';

export const AMENDMENT_KINDS: readonly AmendmentKind[] = ['split', 'drop', 'reapproach', 'expand', 'note'];

export interface AmendmentInput {
  kind: AmendmentKind;
  rationale: string;
  by: string;
}

export interface AmendmentContext {
  /** The target work_item's lifecycle state. */
  targetState: string;
  /** Is the caller the plan-run's authoritative amender (steerer)? Else a bee proposes. */
  authoritative: boolean;
  /** Is the target claimed/owned by a LIVE peer other than the caller (mid-execution)? */
  claimedByOther: boolean;
}

export interface AmendmentRecord {
  kind: AmendmentKind;
  rationale: string;
  by: string;
  /** Authoritative caller ⇒ disposed; a bee ⇒ proposed (awaits the steerer). */
  disposition: 'disposed' | 'proposed';
  /** The target was mid-execution (wip/building/failing, or claimed by a live peer). */
  inFlight: boolean;
  /** A disruptive amendment on an in-flight node — the caller must handle the running
   *  worker (compensation), NOT silently yank it. */
  requiresCompensation: boolean;
}

/** States that mean a worker is actively executing the node (≠ todo/open/terminal). */
const IN_EXECUTION_STATES: ReadonlySet<string> = new Set(['wip', 'building', 'failing']);
/** Kinds that disrupt work in progress (vs additive split/expand or a note). */
const DISRUPTIVE_KINDS: ReadonlySet<AmendmentKind> = new Set(['drop', 'reapproach']);

export function buildAmendment(input: AmendmentInput, ctx: AmendmentContext): AmendmentRecord {
  const inFlight = IN_EXECUTION_STATES.has(ctx.targetState) || ctx.claimedByOther;
  return {
    kind: input.kind,
    rationale: input.rationale,
    by: input.by,
    disposition: ctx.authoritative ? 'disposed' : 'proposed',
    inFlight,
    requiresCompensation: inFlight && DISRUPTIVE_KINDS.has(input.kind),
  };
}

/** Render an amendment as a structured, human + machine-readable record line for the
 *  work-item thread (prefix `⟐ amend` so readers + the bake-off can grep it). */
export function renderAmendment(rec: AmendmentRecord): string {
  const flags = [
    rec.disposition,
    rec.inFlight ? 'in-flight' : null,
    rec.requiresCompensation ? 'NEEDS-COMPENSATION' : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return `⟐ amend[${rec.kind}] (${flags}) by ${rec.by} — ${rec.rationale}`;
}
