/**
 * P-019 (design-to-code-coverage-seam-2026-09-02): derive DRAFT spec clauses from the
 * activation audit's realizing mappings, so the design→code contract exists by DEFAULT
 * rather than by opt-in.
 *
 * ## What P-019 asked for, and what is actually true
 *
 * The item reads: "Auto-derive a draft spec clause per `covered` mapping ... the one
 * change that moves the spec triad off 0.6% adoption." The mechanism is right and the
 * metric is not, in two separate ways (D-047):
 *
 *   • 0.6% is CLAUSE adoption, not TRIAD adoption. Measured 2026-09-03 over the live
 *     corpus: 10 of 1,750 live non-legacy plans carry >= 1 `plan_spec_clauses` row
 *     (0.571%), while 169 of 1,750 carry both `## Requirements` and `## Design`
 *     (9.657%) — the triad is ~17x better adopted than the number the item quotes.
 *   • Clauses cannot move the triad AT ALL. `evaluateSpecTriad` (@papercusp/plan-parser)
 *     is a pure detector over the plan BODY: two headings with >= 40 characters of
 *     non-placeholder text, plus the plan's own `P-NNN` items as its "tasks" leg. It
 *     never reads `plan_spec_clauses`, so writing clause rows moves triad adoption by
 *     exactly zero, by construction.
 *
 * So this derives clauses — which is the valuable half, and the one whose baseline
 * really is 0.6% — and makes no claim about the triad.
 *
 * ## Why deriving DRAFTS is safe, and why that is a structural property
 *
 * `plan-spec-coverage-gate.ts` enforces only `ENFORCEABLE_LIFECYCLE = {accepted,
 * active}`. A `draft` clause is a candidate, never a gate — so bulk-deriving them
 * cannot refuse a single plan's ship. The database makes that stronger than a
 * convention: `plan_spec_clause_revisions_acceptance_exact` requires `accepted_by IS
 * NOT NULL` exactly when the status is accepted/active, so a derived draft CANNOT
 * become enforceable without someone accepting it by name. Automation proposes; only a
 * person or agent promotes.
 *
 * ## What is deliberately NOT fabricated
 *
 *   • `falsifier` is OMITTED, never invented. The store makes it optional, and its own
 *     doc says the point of a falsifier is that none can be written for a vacuous
 *     promise. Generating one from a requirement sentence would manufacture exactly the
 *     vacuity the field exists to filter — the fabricated-traceability failure D-035
 *     rejected. A human/agent adds it when refining the draft.
 *   • `behaviorClass` is defaulted to {@link DERIVED_DRAFT_BEHAVIOR_CLASS} and the
 *     choice is load-bearing: `non-automated` is NOT used, even though it reads like a
 *     natural "unclassified" bucket. In this codebase that value is an ASSERTION that
 *     the behaviour genuinely cannot be automatically tested (`spec-quality.ts` pairs it
 *     with `lifecycleStatus:'exempt'`; the coverage gate tells authors to declare it
 *     "if a clause is genuinely not automatable"). Defaulting to it would let every
 *     derived draft quietly claim un-automatability. `happy-path` is the neutral
 *     reading of "the system does what the requirement says" and is honest as a draft.
 *   • A mapping whose targets are all `D-NNN`/`section:` yields NOTHING. That is not a
 *     limitation to route around — it is the filter that keeps this honest. Those are
 *     the conversational requirements D-035 measured ("explain this more?", "write all
 *     these insights into a plan now"); no plan item implements them, and inventing a
 *     behavioural contract for one would be fabricated traceability. The `P-NNN` filter
 *     excludes them for free.
 *
 * ## Idempotency and the refusal to clobber
 *
 * `specId` is DERIVED deterministically from (mapping, target), so re-deriving the same
 * mapping produces the same identity and `setSpecClause` answers `unchanged` on
 * identical content. Every write is emitted with `expectedRevision: 0`, so if a clause
 * at that id has already been revised — someone refined the draft — the store returns
 * `conflict` and the derived version is DISCARDED rather than overwriting the refinement.
 * Losing a derived draft costs nothing; overwriting a human's clause costs the thing
 * this module exists to create.
 *
 * This module is PURE: it computes writes and never performs them, so the population it
 * would create is testable without a database.
 */
import { PLAN_ITEM_TARGET, REALIZING_DISPOSITIONS } from './plan-requirement-realization';
import type { ActivationAuditMapping, PlanItemStatus } from './plan-audits';
import type { SpecBehaviorClass, SpecClauseWrite } from './agent-tools/plans/spec-clauses-store';

/**
 * The behaviour class every derived draft carries. See the header for why this is
 * `happy-path` and specifically NOT `non-automated`. Exported so the choice is pinned by
 * a test rather than restated in prose.
 */
export const DERIVED_DRAFT_BEHAVIOR_CLASS: SpecBehaviorClass = 'happy-path';

/** Identity prefix marking a clause as machine-derived rather than hand-authored. */
export const DERIVED_SPEC_ID_PREFIX = 'AUTO-REQ';

/** Why a realizing mapping produced no clause. Every skip is REPORTED, never silent. */
export type DerivationSkipReason =
  /** Disposition is `rejected`/`open` — it claims no absorption, so it owes no contract. */
  | 'not-realizing'
  /** Every target is a `D-NNN`/`section:` — no plan item to hang a contract on. */
  | 'no-plan-item-target'
  /** Named a `P-NNN` the plan no longer contains (cf. D-040's liveness rule). */
  | 'target-not-in-plan'
  /** The target item was consciously abandoned (D-002), so the contract is moot. */
  | 'target-dropped'
  /** The requirement text is blank — the DB requires a non-empty `behavior`. */
  | 'empty-requirement';

export interface DerivedDraftClause {
  mappingId: string;
  planTarget: string;
  specId: string;
  /** Ready to hand to `setSpecClause` unchanged. */
  write: SpecClauseWrite;
}

export interface SkippedDerivation {
  mappingId: string;
  /** Absent when the mapping named no plan-item target at all. */
  planTarget?: string;
  reason: DerivationSkipReason;
}

export interface DeriveDraftSpecClausesInput {
  planSlug: string;
  harnessSlug?: string;
  mappings: ReadonlyArray<ActivationAuditMapping>;
  /**
   * The plan's CURRENT items. Same contract as D-040's liveness rule: `getPlanItemStatuses`
   * fails toward `[]`, so an EMPTY list means "unknown", not "no items". Unknown disables
   * the liveness filters rather than skipping every mapping — but note the asymmetry with
   * the gate: here failing open produces writes that `setSpecClause` itself refuses with
   * `plan_item_not_found`, so the store is the backstop and nothing invalid can land.
   */
  planItems?: ReadonlyArray<PlanItemStatus>;
  /** Recorded as the clause author. */
  actorId: string;
}

export interface DeriveDraftSpecClausesResult {
  clauses: DerivedDraftClause[];
  skipped: SkippedDerivation[];
}

/**
 * Stable identity for a derived clause. Deterministic in (mapping, target) so a re-run
 * addresses the SAME row instead of creating a duplicate.
 *
 * Non-identifier characters collapse to `-` because `spec_id` is a path-like text key and
 * a mapping id is free-form. The mapping id is kept verbatim where it already conforms,
 * so a derived id stays legible back to its source mapping.
 */
export function derivedSpecId(mappingId: string, planTarget: string): string {
  const safeMapping = mappingId.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${DERIVED_SPEC_ID_PREFIX}-${safeMapping || 'UNKNOWN'}-${planTarget}`;
}

/**
 * Compute the draft clauses a plan's activation audit implies. Pure — performs no writes.
 */
export function deriveDraftSpecClauses(
  input: DeriveDraftSpecClausesInput,
): DeriveDraftSpecClausesResult {
  const clauses: DerivedDraftClause[] = [];
  const skipped: SkippedDerivation[] = [];

  // Null when the item list is unknown (absent or empty) — see `planItems` above.
  const statusByItem =
    input.planItems && input.planItems.length > 0
      ? new Map(input.planItems.map((item) => [item.itemId, item.status]))
      : null;

  for (const mapping of input.mappings) {
    if (!REALIZING_DISPOSITIONS.has(mapping.disposition)) {
      skipped.push({ mappingId: mapping.id, reason: 'not-realizing' });
      continue;
    }

    const itemTargets = mapping.planTargets
      .map((target) => target.trim())
      .filter((target) => PLAN_ITEM_TARGET.test(target));

    if (itemTargets.length === 0) {
      // The conversational requirements. Reported, never invented — see the header.
      skipped.push({ mappingId: mapping.id, reason: 'no-plan-item-target' });
      continue;
    }

    const behavior = mapping.requirement.trim();

    for (const planTarget of itemTargets) {
      if (statusByItem) {
        const status = statusByItem.get(planTarget);
        if (status === undefined) {
          skipped.push({ mappingId: mapping.id, planTarget, reason: 'target-not-in-plan' });
          continue;
        }
        if (status === 'dropped') {
          skipped.push({ mappingId: mapping.id, planTarget, reason: 'target-dropped' });
          continue;
        }
      }

      // Checked per-target rather than once above so the skip carries the target it
      // would have been written for, and so a blank requirement is never silently
      // dropped by the database's own non-empty `behavior` check instead.
      if (behavior.length === 0) {
        skipped.push({ mappingId: mapping.id, planTarget, reason: 'empty-requirement' });
        continue;
      }

      const specId = derivedSpecId(mapping.id, planTarget);
      clauses.push({
        mappingId: mapping.id,
        planTarget,
        specId,
        write: {
          ...(input.harnessSlug ? { harnessSlug: input.harnessSlug } : {}),
          planSlug: input.planSlug,
          specId,
          // Always 0: a derived draft only ever CREATES. If the id already carries a
          // revision, `setSpecClause` returns `conflict` and this write is discarded,
          // which is how a refined clause is protected from re-derivation.
          expectedRevision: 0,
          planItemId: planTarget,
          behavior,
          behaviorClass: DERIVED_DRAFT_BEHAVIOR_CLASS,
          lifecycleStatus: 'draft',
          actorId: input.actorId,
        },
      });
    }
  }

  return { clauses, skipped };
}

/**
 * The outcome of a derivation pass that actually WROTE. Every disposition is counted
 * rather than thrown, because this runs alongside an activation audit that has already
 * succeeded: a clause that cannot be written is a report, never a reason to fail the
 * audit that produced it.
 */
export interface DerivedDraftPersistOutcome {
  /** Clauses the derivation proposed (`skipped` explains everything it did not). */
  attempted: number;
  created: number;
  /** Re-derived identically — the idempotency path, and the steady state on re-audit. */
  unchanged: number;
  /**
   * Someone had already revised the clause at this id, so `expectedRevision: 0` refused
   * and the derived draft was DISCARDED. This is the design working, not an error: it is
   * the case the whole `expectedRevision: 0` choice exists to produce.
   */
  conflicted: number;
  /** Any other store refusal, carried with its status so a caller can see WHY. */
  refused: Array<{ specId: string; status: string }>;
  skipped: SkippedDerivation[];
}

/**
 * Derive and persist. The writer is INJECTED rather than imported so this is testable
 * without a database — and so the pure derivation above stays genuinely pure.
 *
 * Writes are sequential on purpose: `setSpecClause` takes a per-identity advisory lock,
 * and a derivation pass over one plan is a handful of rows, so there is nothing to win by
 * racing them and a contended lock to lose.
 */
export async function persistDerivedDraftClauses(
  input: DeriveDraftSpecClausesInput,
  write: (clause: SpecClauseWrite) => Promise<{ status: string }>,
): Promise<DerivedDraftPersistOutcome> {
  const { clauses, skipped } = deriveDraftSpecClauses(input);
  const outcome: DerivedDraftPersistOutcome = {
    attempted: clauses.length,
    created: 0,
    unchanged: 0,
    conflicted: 0,
    refused: [],
    skipped,
  };

  for (const clause of clauses) {
    const result = await write(clause.write);
    switch (result.status) {
      case 'created':
      case 'revised':
        outcome.created += 1;
        break;
      case 'unchanged':
        outcome.unchanged += 1;
        break;
      case 'conflict':
        outcome.conflicted += 1;
        break;
      default:
        outcome.refused.push({ specId: clause.specId, status: result.status });
        break;
    }
  }

  return outcome;
}

/** One-line-per-entry rendering for reporting what a derivation pass would do. */
export function describeDerivedDraftClause(entry: DerivedDraftClause): string {
  const behavior =
    entry.write.behavior.length > 80
      ? `${entry.write.behavior.slice(0, 77)}...`
      : entry.write.behavior;
  return `${entry.specId} → ${entry.planTarget} (draft, from ${entry.mappingId}): "${behavior}"`;
}
