/**
 * P-014 (design-to-code-coverage-seam-2026-09-02): join the ACTIVATION audit to the
 * COMPLETION audit at ship time.
 *
 * Both datasets already existed and are keyed by `plan_slug`, but nothing had ever
 * compared them, so the two halves of traceability could disagree silently:
 *
 *   • The activation audit records what the source conversation REQUIRED, and where
 *     in the plan each requirement was placed (`planTargets`), with a `disposition`.
 *   • The completion audit records, per plan item, whether the CODE was verified —
 *     and D-008 is explicit that only `code`/`test` citations count as verification.
 *
 * A requirement dispositioned `covered` or `repaired` is a claim that the plan
 * ABSORBED it. That claim is only true if the item it was routed to actually got
 * built and verified. Until now a plan could mark every requirement `covered`,
 * carry an item audit whose only citation was `doc` or `none`, and ship — with the
 * activation audit asserting the requirement was handled and the completion audit
 * quietly recording that nothing was proven. Each audit is individually valid; only
 * the JOIN reveals the gap. (That is the same failure shape as P-007's coverage
 * config, one regime up: two correct artifacts whose disagreement nobody reads.)
 *
 * Deliberate scope limits, both of which are correctness requirements rather than
 * conveniences:
 *
 *   1. Only `P-NNN` targets are judgeable. `planTargets` also accepts `D-NNN` and
 *      `section:<heading>`, which have NO completion-audit counterpart by
 *      construction — the completion audit is per plan ITEM. Treating those as
 *      violations would refuse every plan whose requirements landed as decisions,
 *      which is a legitimate and common outcome. They are reported as `skipped`, so
 *      the exemption is visible rather than silent.
 *   2. Only `covered`/`repaired` are checked. `rejected` and `open` are honest
 *      dispositions that make no claim of absorption, and demanding evidence for
 *      them would punish the accurate answer.
 *
 * P-016 / D-040 closed the gap those limits left open. Resolving a `P-NNN` target
 * against the folded audit alone answers "was this item ever verified?", never "is this
 * item still in the plan?" — and the two diverge, because `getEffectiveItemAudits` folds
 * EVERY completion pass and is never filtered by the current item list. An item deleted
 * from the plan therefore keeps its verifying entry forever, and the drift loop that
 * would notice iterates the plan's CURRENT items (so it cannot see a deleted one) and
 * explicitly skips `dropped` ones. So the requirement stayed `covered` on the strength of
 * evidence for work the plan had abandoned, and nothing said so. The target is now
 * resolved against the plan first: a target the plan no longer contains is `unrealized`
 * (`target-not-in-plan`), and a `dropped` one is REPORTED rather than convicted, since a
 * mapping may name a live sibling that genuinely absorbed it.
 *
 * ⚠ P-016 asked for this via the stored `audited_plan_content_hash`; that instrument
 * cannot do it. It is a WHOLE-PLAN hash, so it changes when any decision, `## Now` line
 * or item status changes and can never name WHICH item moved — it is already reported,
 * correctly and non-blockingly, as `changedSinceAudit`/`revisionGap`. The item-level
 * question it was meant to answer already had an exact instrument in `itemTextHash`
 * (a rewritten item is caught today as `audit_coverage_stale`); what was missing was
 * item LIVENESS, which is what this does.
 */
import {
  isVerifyingCitation,
  type ActivationAuditMapping,
  type EffectiveItemAudit,
  type PlanItemStatus,
} from './plan-audits';
import type { AcceptanceBarContractSnapshot, AcceptanceBarTrace } from './acceptance-bar-contract-snapshot';
import { barRequiresAutomatedProof } from './acceptance-bar-contract-snapshot';
import { isEnforceableSpecLifecycle } from './agent-tools/plans/spec-clauses-store';

/** Derived from the canonical BAR evaluator, never from a doc citation or a completion claim. */
export interface NonCodeItemProof {
  planItemId: string;
  barKeys: string[];
  evidenceRefs: string[];
}

/**
 * D-008 keeps non-code outcomes out of verifiedAgainstCode. Their realization can
 * instead be established by current operational/check evidence for EVERY exact BAR
 * projection owned by the item. A passing sibling projection cannot vouch for it.
 * Grading is intentionally not required here: the same proof feeds the grader.
 */
export function deriveNonCodeItemProofs(snapshot: AcceptanceBarContractSnapshot): NonCodeItemProof[] {
  if (!snapshot.applicable || !snapshot.plan?.barSetHash || !snapshot.rubric?.revision ||
      !snapshot.completeness.complete || snapshot.completeness.truncated) return [];

  const byItem = new Map<string, Array<{ bar: AcceptanceBarTrace; mapping: AcceptanceBarTrace['mappings'][number] }>>();
  for (const bar of snapshot.bars) {
    if (bar.role !== 'outcome') continue;
    for (const mapping of bar.mappings) {
      // WI-10003864: judge only the projections the snapshot itself proves. `bar.mappings`
      // lists every clause row keyed to the BAR — draft and retired ones included — while
      // `bar.proof`, its evidence history and its adequacy checks count ENFORCEABLE clauses
      // only. Demanding proof of a draft/retired mapping therefore demanded something no
      // evidence can satisfy, so any plan that ever atomized or retired a clause could never
      // realize its not-code items. A mapping without a recorded lifecycle (a snapshot built
      // before the field existed) stays judged: absence fails closed, never open.
      if (mapping.lifecycleStatus !== undefined && !isEnforceableSpecLifecycle(mapping.lifecycleStatus)) continue;
      const rows = byItem.get(mapping.planItemId) ?? [];
      rows.push({ bar, mapping });
      byItem.set(mapping.planItemId, rows);
    }
  }
  const proofs: NonCodeItemProof[] = [];
  for (const [planItemId, projections] of byItem) {
    const evidenceRefs = new Set<string>();
    const fulfilled = projections.every(({ bar, mapping }) => {
      // An EXPLICITLY manual BAR — a document/ledger census whose criterion declares no
      // instrument — CANNOT produce declared test layers or an adequacy verdict: the
      // projection forces `requiredTestLayers: []`, which in turn forces adequacy
      // `undeclared` and an EMPTY checks array. Demanding either here rejected such a BAR
      // on precisely the values its own escape hatch produces, so a manual outcome was
      // unshippable by construction: the contract gate accepted it and this gate then
      // refused it, leaving only false statements as escapes (WI-10002089).
      //
      // This relaxes NOTHING else. Every other clause below is still required of a manual
      // BAR: plane match, spec id/revision/fingerprint identity, a current work contract,
      // `matchesCurrentSpec`, a supplied currentness comparison, and at least one current
      // evidence row. A manual BAR with no current evidence still fails.
      const manual = !barRequiresAutomatedProof(bar);
      const adequacyState = bar.proof.adequacy?.state;
      if (mapping.planItemStatus !== 'done' || !bar.barHash ||
          (!manual && !bar.requiredTestLayers?.length) ||
          // P-001: key the clause to its own bar (hash + plane). An amendment keeps an
          // unchanged bar's clause at its revision, so its set-hash / rubric-revision pins
          // are legitimately older than the plan's; the set is pinned at plan + rubric.
          mapping.sourceBarHash !== bar.barHash || mapping.evidencePlane !== bar.evidencePlane ||
          bar.proof.state !== 'current' || bar.proof.uncertainEvidence > 0 ||
          (manual ? !(adequacyState === 'undeclared' || adequacyState === 'pass')
                  : adequacyState !== 'pass')) return false;
      const check = bar.proof.adequacy?.checks.find((entry) =>
        entry.specId === mapping.specId && entry.revision === mapping.specRevision);
      // Where a check EXISTS it must pass, manual or not — being manual never licenses
      // ignoring a RECORDED adequacy failure. Only a manual BAR may have no check at all.
      if (check ? (check.verdict !== 'pass' || check.wouldBlock.length > 0) : !manual) return false;
      if (!bar.workContracts.some((contract) =>
        contract.current && contract.specId === mapping.specId && contract.specRevision === mapping.specRevision &&
        contract.specFingerprint === mapping.specContentHash)) return false;
      const evidence = (bar.proof.history ?? []).filter((row) => {
        const plane = row.details.evidencePlane ?? row.details.evidence_plane ?? row.details.plane;
        return (row.evidenceKind === 'operational' || row.evidenceKind === 'check') &&
          row.matchesCurrentSpec && row.specId === mapping.specId && row.specRevision === mapping.specRevision &&
          row.specFingerprint === mapping.specContentHash && row.currentness.comparisonSupplied === true &&
          row.currentness.overall === 'current' &&
          // With no adequacy check to enumerate the admissible refs, a manual BAR binds
          // evidence to THIS mapping through the exact spec id + revision + fingerprint
          // identity already asserted above, rather than through the check's ref list.
          (check ? check.evidenceRefs.includes(row.evidenceRef) : manual) &&
          (bar.evidencePlane === 'tree' || plane === bar.evidencePlane);
      });
      for (const row of evidence) evidenceRefs.add(row.evidenceRef);
      return evidence.length > 0;
    });
    if (fulfilled) proofs.push({
      planItemId,
      barKeys: [...new Set(projections.map(({ bar }) => bar.barKey))].sort(),
      evidenceRefs: [...evidenceRefs].sort(),
    });
  }
  return proofs.sort((a, b) => a.planItemId.localeCompare(b.planItemId));
}

/**
 * Dispositions that ASSERT the plan absorbed the requirement, and so owe evidence.
 *
 * Exported (P-019) so the draft-clause deriver selects the SAME population this judge
 * grades. A second copy of either predicate would be a second definition of "realizing",
 * free to drift from this one — and the drift would be silent, since each copy is
 * individually correct.
 */
export const REALIZING_DISPOSITIONS: ReadonlySet<ActivationAuditMapping['disposition']> = new Set([
  'covered',
  'repaired',
]);

/** A plan-item target. `D-NNN` and `section:<heading>` are deliberately not this. */
export const PLAN_ITEM_TARGET = /^P-\d{3,}$/;

export type UnrealizedReason = 'no-item-audit' | 'no-verifying-citation' | 'target-not-in-plan';

export interface UnrealizedRequirement {
  mappingId: string;
  requirement: string;
  disposition: ActivationAuditMapping['disposition'];
  /** The `P-NNN` target that failed to demonstrate the requirement. */
  planTarget: string;
  reason: UnrealizedReason;
}

/**
 * A realizing mapping that named NO `P-NNN` target at all — every destination it gave
 * is a `D-NNN` or `section:<heading>`, which has no completion-audit counterpart by
 * construction. So the mapping asserts the plan absorbed a requirement, and nothing
 * judged that claim.
 */
export interface ExemptMapping {
  mappingId: string;
  requirement: string;
  disposition: ActivationAuditMapping['disposition'];
  /** The non-item destinations it named instead. */
  planTargets: string[];
}

/**
 * P-016: a realizing mapping whose `P-NNN` target is still IN the plan but was
 * consciously abandoned (`status: 'dropped'`). Dropping is a legitimate recorded exit
 * (D-002), and the completion-audit drift loop deliberately skips dropped items — so a
 * requirement routed to one is judged by nobody, while the activation audit goes on
 * asserting the plan absorbed it.
 *
 * NOT a violation, for the same reason D-035 refused to make the non-item exemption one:
 * a mapping may name several targets, and a requirement genuinely absorbed by a live
 * sibling item is not made false by an abandoned one beside it. Reported instead, so the
 * abandoned destination is visible.
 */
export interface DroppedTarget {
  mappingId: string;
  requirement: string;
  disposition: ActivationAuditMapping['disposition'];
  planTarget: string;
  /**
   * The silent case, and the one P-016 was filed for: a folded audit entry STILL carries
   * a verifying citation for this item, gathered before it was dropped, so the coverage
   * claim passes on evidence for work the plan then abandoned. `getEffectiveItemAudits`
   * folds every completion pass and never filters by the plan's current items, so that
   * entry survives the drop indefinitely. Measured 2026-09-03: 28 of 83 dropped targets
   * fleet-wide are vouched this way.
   */
  vouchedByStaleAudit: boolean;
}

export interface RequirementRealizationVerdict {
  ok: boolean;
  /** `P-NNN` targets actually judged. */
  checkedTargets: number;
  /**
   * Non-item targets (`D-NNN`, `section:…`) that carry no completion-audit
   * counterpart. Surfaced so a vacuous pass is never mistaken for a verified one.
   */
  skippedTargets: string[];
  /**
   * P-015 / D-035: the realizing mappings judged by NOTHING — those whose targets are
   * ALL non-item. This is the mapping-level view `skippedTargets` cannot give, and the
   * difference is not cosmetic: measured 2026-09-03, 4,090 of 9,912 realizing targets
   * (41.3%) are non-item, but only 366 of 2,493 realizing MAPPINGS (14.7%) carry no
   * `P-NNN` at all. The other ~3,724 non-item targets sit beside a `P-NNN` on the same
   * mapping and ARE judged through it, so the target-level number overstates the
   * unjudged population by ~11x.
   *
   * ⚠ NOT a violation, deliberately. P-015 proposed refusing these; D-035 rejected that
   * after measuring what they are — conversational requirements ("explain this more?",
   * "write all these insights into a plan now") whose honest home IS a decision or a
   * section. No plan item could implement them, and inventing one to satisfy a floor
   * would be fabricated traceability. They are REPORTED so the exemption is visible,
   * which is the guarantee this module already claimed and the gate was dropping.
   */
  exemptMappings: ExemptMapping[];
  /**
   * P-016: realizing targets pointing at a plan item that is still present but
   * `dropped`. Non-blocking — see {@link DroppedTarget}. Empty when `planItems` was not
   * supplied or could not be read.
   */
  droppedTargets: DroppedTarget[];
  /** Mappings dispositioned covered/repaired whose evidence is missing. */
  unrealized: UnrealizedRequirement[];
}

export interface RequirementRealizationInput {
  mappings: ReadonlyArray<ActivationAuditMapping>;
  itemAudits: ReadonlyArray<EffectiveItemAudit>;
  /**
   * P-016: the plan's CURRENT items, so a target can be resolved against the plan
   * before the folded audit is asked about it. Without it this judge resolves `P-NNN`
   * targets ONLY against `getEffectiveItemAudits`, which folds every completion pass
   * and never filters by the current item list — so an item deleted from the plan keeps
   * a verifying audit entry forever and silently vouches for the requirement routed to it.
   *
   * ⚠ OPTIONAL, AND AN EMPTY LIST IS TREATED AS "NOT SUPPLIED" — deliberately, because
   * `getPlanItemStatuses` fails toward `[]` and its own contract says a caller must never
   * read that as "the plan has no items". Validating targets against an empty list would
   * mark EVERY target `target-not-in-plan` and refuse every plan on a transient database
   * error. Absent this input the liveness rules are skipped entirely and the judge behaves
   * exactly as it did before P-016.
   */
  planItems?: ReadonlyArray<PlanItemStatus>;
  /** Current exact operational/check proof derived by deriveNonCodeItemProofs. */
  nonCodeItemProofs?: ReadonlyArray<NonCodeItemProof>;
}

export function judgeRequirementRealization(
  input: RequirementRealizationInput,
): RequirementRealizationVerdict {
  // Index the completion audit by item id. `foldEffectiveItemAudits` has already
  // reduced to one effective entry per item, so a plain Map is faithful here.
  const auditByItem = new Map<string, EffectiveItemAudit>();
  for (const audit of input.itemAudits) auditByItem.set(audit.entry.itemId, audit);

  const unrealized: UnrealizedRequirement[] = [];
  const skippedTargets: string[] = [];
  const exemptMappings: ExemptMapping[] = [];
  const droppedTargets: DroppedTarget[] = [];
  let checkedTargets = 0;

  // P-016: null when the caller supplied no items, or supplied an empty list — which
  // `getPlanItemStatuses` also returns on a read failure. Both collapse to "the plan's
  // item list is unknown", and an unknown list must disable the liveness rules rather
  // than convict every target of not existing.
  const statusByItem =
    input.planItems && input.planItems.length > 0
      ? new Map(input.planItems.map((item) => [item.itemId, item.status]))
      : null;

  for (const mapping of input.mappings) {
    if (!REALIZING_DISPOSITIONS.has(mapping.disposition)) continue;

    // Per-mapping accounting (D-035): a mapping is EXEMPT only when it named no
    // judgeable target at all. Counted here rather than derived from `skippedTargets`
    // afterwards, because that list is flat across mappings and cannot answer it.
    let judgeableTargets = 0;
    const nonItemTargets: string[] = [];

    for (const target of mapping.planTargets) {
      const trimmed = target.trim();
      if (!PLAN_ITEM_TARGET.test(trimmed)) {
        skippedTargets.push(trimmed);
        nonItemTargets.push(trimmed);
        continue;
      }
      judgeableTargets += 1;
      checkedTargets += 1;

      // P-016: resolve the target against the plan BEFORE asking the folded audit about
      // it. A target the plan no longer contains cannot be realized by anything, however
      // confidently a surviving audit entry vouches for it — and that entry does survive,
      // because the fold spans every completion pass and is never filtered by the current
      // item list. Checked ahead of the audit lookup so a stale entry cannot pre-empt it.
      const currentStatus = statusByItem?.get(trimmed);
      if (statusByItem && currentStatus === undefined) {
        unrealized.push({
          mappingId: mapping.id,
          requirement: mapping.requirement,
          disposition: mapping.disposition,
          planTarget: trimmed,
          reason: 'target-not-in-plan',
        });
        continue;
      }

      const audit = auditByItem.get(trimmed);

      // A dropped target keeps the ordinary evidence rule below — loosening it here would
      // let the 55 dropped targets that fail today start passing. This only ADDS the
      // report, so the abandoned destination stops being invisible either way.
      if (currentStatus === 'dropped') {
        droppedTargets.push({
          mappingId: mapping.id,
          requirement: mapping.requirement,
          disposition: mapping.disposition,
          planTarget: trimmed,
          vouchedByStaleAudit: audit?.entry.citations.some(isVerifyingCitation) ?? false,
        });
      }

      if (!audit) {
        unrealized.push({
          mappingId: mapping.id,
          requirement: mapping.requirement,
          disposition: mapping.disposition,
          planTarget: trimmed,
          reason: 'no-item-audit',
        });
        continue;
      }

      // D-008 still governs CODE verification. A reasoned, completed not-code item
      // can realize an operational outcome through separately evaluated BAR proof;
      // its doc/none citations remain non-verifying and cannot satisfy this alone.
      const nonCodeProven = currentStatus === 'done' && audit.entry.verdict === 'not-code' &&
        Boolean(audit.entry.note?.trim()) && input.nonCodeItemProofs?.some((proof) =>
          proof.planItemId === trimmed && proof.barKeys.length > 0 && proof.evidenceRefs.length > 0);
      if (!audit.entry.citations.some(isVerifyingCitation) && !nonCodeProven) {
        unrealized.push({
          mappingId: mapping.id,
          requirement: mapping.requirement,
          disposition: mapping.disposition,
          planTarget: trimmed,
          reason: 'no-verifying-citation',
        });
      }
    }

    if (judgeableTargets === 0) {
      exemptMappings.push({
        mappingId: mapping.id,
        requirement: mapping.requirement,
        disposition: mapping.disposition,
        planTargets: nonItemTargets,
      });
    }
  }

  return {
    ok: unrealized.length === 0,
    checkedTargets,
    skippedTargets,
    exemptMappings,
    droppedTargets,
    unrealized,
  };
}

/** One-line-per-entry rendering for the gate's (non-blocking) dropped-target report. */
export function describeDroppedTarget(entry: DroppedTarget): string {
  const requirement =
    entry.requirement.length > 80 ? `${entry.requirement.slice(0, 77)}...` : entry.requirement;
  const vouched = entry.vouchedByStaleAudit
    ? 'still vouched by a pre-drop verifying citation'
    : 'no verifying citation';
  return `${entry.mappingId} (${entry.disposition}) → ${entry.planTarget} [dropped, ${vouched}]: "${requirement}"`;
}

/** One-line-per-entry rendering for the gate's (non-blocking) exemption report. */
export function describeExemptMapping(entry: ExemptMapping): string {
  const requirement =
    entry.requirement.length > 80 ? `${entry.requirement.slice(0, 77)}...` : entry.requirement;
  const targets = entry.planTargets.length > 0 ? entry.planTargets.join(', ') : '(no targets)';
  return `${entry.mappingId} (${entry.disposition}) → ${targets}: "${requirement}"`;
}

/** One-line-per-entry rendering for the gate's refusal message. */
export function describeUnrealized(entry: UnrealizedRequirement): string {
  const why =
    entry.reason === 'no-item-audit'
      ? 'no item audit'
      : entry.reason === 'target-not-in-plan'
        ? 'the plan no longer contains this item'
        : 'audited with no verifying (code/test) citation or current operational proof for a non-code outcome';
  const requirement =
    entry.requirement.length > 80 ? `${entry.requirement.slice(0, 77)}...` : entry.requirement;
  return `${entry.mappingId} (${entry.disposition}) → ${entry.planTarget}: ${why} — "${requirement}"`;
}
