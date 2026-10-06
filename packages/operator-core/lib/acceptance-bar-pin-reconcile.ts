/**
 * Catch a stranded acceptance-BAR subject-revision pin up to the plan's current
 * revision (EI-22752422043395332).
 *
 * Lives in its own module on purpose: `acceptance-bar-amendment.ts` is the measured
 * SOURCE of live proof clauses on unshipped plans, and any edit to its bytes stales
 * every one of them. This file only COMPOSES that module's exported synchronizer.
 */
import { withWorkspace } from '@papercusp/db-org';
import { synchronizeAcceptanceBarSubjectRevision } from './acceptance-bar-amendment';
import { acquirePlanAdvisoryLock, planAdvisoryLockKey } from './agent-tools/plans/plan-lock-key';
import { hashPlanContent } from './agent-tools/plans/content-hash';

export type StaleAcceptanceBarSubjectPinResult =
  | { reconciled: true; fromRevision: number; toRevision: number }
  | {
      reconciled: false;
      reason:
        | 'plan_absent'
        | 'not_bar_subject'
        | 'rubric_pin_absent'
        | 'pin_current'
        | 'no_activation_witness'
        | 'not_neutral';
    };

/** `synchronizeAcceptanceBarSubjectRevision` only runs on the write that changes the
 * body, and only when the OLD body is at hand. A neutral write that landed while the
 * serving build predated the synchronizer (a `← WI-… released` item-note reflection)
 * leaves the rubric pin behind with nothing to re-trigger it, and every start door
 * then refuses `bar_snapshot_rubric_revision_mismatch` forever.
 *
 * This supplies the missing old body from the plan's latest ACTIVATION audit snapshot
 * (the same witness `plans:audit` uses for its own catch-up) and defers to the
 * synchronizer, so every safety rule stays in ONE place: source fingerprints must be
 * identical (a Requirements / Bar-to-work-map change stays stale and must go through
 * `rubrics:amend`), the rubric must still be at the pinned revision, and its barSetHash
 * must still match. No activation audit, an unverifiable snapshot, or a semantic change
 * is a refusal to repair, never a guess. Takes the subject's advisory lock itself.
 */
export async function reconcileStaleAcceptanceBarSubjectPin(args: {
  workspaceId: string; harnessSlug: string; planSlug: string; ttlSec?: number;
}): Promise<StaleAcceptanceBarSubjectPinResult> {
  const budgetMs = (args.ttlSec ?? 5) * 1000;
  try {
    return await withWorkspace(args.workspaceId, async (tx) => {
      await acquirePlanAdvisoryLock(
        tx,
        planAdvisoryLockKey(args.workspaceId, args.harnessSlug, args.planSlug),
        budgetMs,
      );
      const [subject] = await tx<Array<{
        version: number | string; content: string; acceptance_bar_rubric_slug: string | null;
      }>>`
        SELECT version, content, acceptance_bar_rubric_slug
          FROM harness_shared.harness_plans
         WHERE workspace_id = ${args.workspaceId} AND harness_slug = ${args.harnessSlug}
           AND plan_slug = ${args.planSlug}`;
      if (!subject) return { reconciled: false as const, reason: 'plan_absent' as const };
      if (!subject.acceptance_bar_rubric_slug) {
        return { reconciled: false as const, reason: 'not_bar_subject' as const };
      }
      const [witness] = await tx<Array<{
        content_snapshot: string; content_hash: string; subject_version: string | null;
      }>>`
        SELECT r.content_snapshot, r.content_hash,
               rubric.template_data->'barContract'->>'subjectPlanRevision' AS subject_version
          FROM (
            SELECT audited_plan_revision_id, audited_plan_revision_seq, audited_plan_content_hash
              FROM harness_shared.plan_audits
             WHERE workspace_id = ${args.workspaceId} AND harness_slug = ${args.harnessSlug}
               AND plan_slug = ${args.planSlug} AND audit_kind = 'activation'
             ORDER BY audit_seq DESC LIMIT 1
          ) a
          JOIN harness_shared.plan_revisions r
            ON r.id = a.audited_plan_revision_id AND r.seq = a.audited_plan_revision_seq
           AND r.content_hash = a.audited_plan_content_hash
           AND r.workspace_id = ${args.workspaceId} AND r.harness_slug = ${args.harnessSlug}
           AND r.plan_slug = ${args.planSlug}
          JOIN harness_shared.harness_plans rubric
            ON rubric.workspace_id = ${args.workspaceId} AND rubric.harness_slug = ${args.harnessSlug}
           AND rubric.plan_slug = ${subject.acceptance_bar_rubric_slug}`;
      if (!witness) return { reconciled: false as const, reason: 'no_activation_witness' as const };
      const pin = Number(witness.subject_version);
      const version = Number(subject.version);
      if (witness.subject_version == null || !Number.isSafeInteger(pin)) {
        return { reconciled: false as const, reason: 'rubric_pin_absent' as const };
      }
      if (pin === version) return { reconciled: false as const, reason: 'pin_current' as const };
      // The snapshot must be the bytes the audit actually judged; a corrupted or
      // rewritten revision row is not a witness.
      if (hashPlanContent(witness.content_snapshot) !== witness.content_hash) {
        return { reconciled: false as const, reason: 'no_activation_witness' as const };
      }
      const moved = await synchronizeAcceptanceBarSubjectRevision(tx, {
        workspaceId: args.workspaceId, harnessSlug: args.harnessSlug, planSlug: args.planSlug,
        previousBody: witness.content_snapshot, nextBody: subject.content,
        previousVersion: pin, nextVersion: version,
      });
      return moved
        ? { reconciled: true as const, fromRevision: pin, toRevision: version }
        : { reconciled: false as const, reason: 'not_neutral' as const };
    });
  } catch (error) {
    // A busy lock must never turn a refusal into a crash at a start door: the caller
    // re-reads the lifecycle and refuses exactly as before.
    const code = (error as { code?: unknown } | null)?.code;
    if (code === '55P03' || (error as Error | null)?.message === 'acceptance_bar_subject_revision_rubric_busy') {
      return { reconciled: false, reason: 'not_neutral' };
    }
    throw error;
  }
}
