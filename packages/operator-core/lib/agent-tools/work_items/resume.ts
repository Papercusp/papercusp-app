/** Bounded continuation over the existing checkpoint and spec-evidence stores. */
import { parseCarryNote, shortCarryHash } from '../../carry-note';
import { getWorkItemCheckpointWithMeta, getWorkItemCheckpointFreshness, type WorkItemCheckpointWithMeta } from '../../work-item-checkpoint';
import { ADHOC_WORK_ITEM_SPEC_SCOPE, listSpecEvidence } from '../plans/spec-evidence-store';

export const RESUME_PACKET_BUDGET = 5_000;
const EVIDENCE_READ_LIMIT = 9;
type ResumeItem = { id: string; harness?: string | null; state?: string | null; assignee?: string | null; payload?: unknown };
type Checkpoint = WorkItemCheckpointWithMeta;
type Evidence = Awaited<ReturnType<typeof listSpecEvidence>>;
type ResumeDeps = {
  checkpoint: typeof getWorkItemCheckpointWithMeta;
  freshness: typeof getWorkItemCheckpointFreshness;
  evidence: typeof listSpecEvidence;
};

function planOf(item: ResumeItem): { slug: string; item: string | null } | null {
  const payload = item.payload as { plan_item?: { plan_slug?: unknown; item_id?: unknown } } | null;
  const plan = payload?.plan_item;
  return typeof plan?.plan_slug === 'string'
    ? { slug: plan.plan_slug, item: typeof plan.item_id === 'string' ? plan.item_id : null }
    : null;
}

/** Omit whole records to fit; never turn a partial next action into an instruction. */
export function buildWorkItemResume(input: {
  item: ResumeItem; checkpoint: Checkpoint; freshness: unknown; evidence: Evidence | null;
}) {
  const { item, checkpoint } = input;
  const plan = planOf(item);
  const fields = checkpoint.readFailed || checkpoint.checkpoint === null ? {} : parseCarryNote(checkpoint.checkpoint);
  const latest = checkpoint.latestUpdate;
  const ambiguous = latest?.status === 'unknown'
    || (!latest && /^---\s*$/m.test(checkpoint.checkpoint ?? ''));
  const latestFields = latest?.text ? parseCarryNote(latest.text) : fields;
  const next = ambiguous ? null : latestFields.next?.trim() || latest?.text?.trim() || null;
  const resume = {
    schemaVersion: 'work-item-resume-v1',
    claim: { id: item.id, assignee: item.assignee ?? null, state: item.state ?? null },
    plan,
    nextAction: {
      status: checkpoint.readFailed || ambiguous ? 'unknown' : next === null ? 'missing' : 'available',
      text: next,
      ...(latest?.status === 'available' ? { source: latestFields.next ? 'next-action' : 'latest-update' } : {}),
    },
    checkpoint: {
      status: checkpoint.readFailed ? 'unknown' : checkpoint.checkpoint === null ? 'absent' : 'available',
      updatedAtMs: checkpoint.updatedAtMs,
      contentHash: checkpoint.readFailed || checkpoint.checkpoint === null ? null : shortCarryHash(checkpoint.checkpoint),
      freshness: input.freshness ?? { verdict: 'unknown', reason: 'no measured dependency verdict' },
      readRef: { tool: 'work_items:get', args: { id: item.id, harness: item.harness ?? undefined, payloadTier: 'full' } },
    },
    checks: { rows: [] as unknown[], omitted: fields.checks?.length ?? 0 },
    walls: { rows: [] as unknown[], omitted: fields.walls?.length ?? 0 },
    evidence: {
      status: input.evidence === null ? 'unknown' : 'available', rows: [] as unknown[],
      omittedFromWindow: input.evidence?.length ?? null,
      hasMore: input.evidence === null ? null : input.evidence.length >= EVIDENCE_READ_LIMIT,
      readRef: { tool: 'plans:get-spec-evidence', args: {
        slug: plan?.slug ?? ADHOC_WORK_ITEM_SPEC_SCOPE, harness: item.harness ?? undefined,
        workItemIds: [item.id], limit: 100,
      } },
    },
  };
  if (JSON.stringify(resume.checkpoint.freshness).length > 400) {
    const freshness = input.freshness as { verdict?: string } | null;
    resume.checkpoint.freshness = { verdict: freshness?.verdict ?? 'unknown', detailsOmitted: true };
  }
  if (JSON.stringify(resume).length > RESUME_PACKET_BUDGET) {
    resume.nextAction.status = 'oversized';
    resume.nextAction.text = null;
  }
  const append = (target: unknown[], row: unknown): boolean => {
    target.push(row);
    if (JSON.stringify(resume).length <= RESUME_PACKET_BUDGET) return true;
    target.pop();
    return false;
  };
  // Execution constraints precede proof; omitted counts always retain a recovery path.
  for (const wall of fields.walls ?? []) {
    if (append(resume.walls.rows, wall)) resume.walls.omitted -= 1;
  }
  for (const row of (input.evidence ?? []).slice(0, EVIDENCE_READ_LIMIT - 1)) {
    const details = row.details as { adequacy?: { outcome?: unknown; causalPairIds?: unknown } };
    const proof = {
      id: row.id, specId: row.specId, specRevision: row.specRevision,
      evidenceKind: row.evidenceKind, evidenceRef: row.evidenceRef,
      testRunId: row.testRunId, coverageEvidenceRef: row.coverageEvidenceRef,
      currentness: row.currentness.overall, outcome: details.adequacy?.outcome ?? 'unknown',
      ...(details.adequacy?.causalPairIds ? { causalPairIds: details.adequacy.causalPairIds } : {}),
    };
    if (append(resume.evidence.rows, proof)) resume.evidence.omittedFromWindow! -= 1;
  }
  for (const check of fields.checks ?? []) {
    if (append(resume.checks.rows, check)) resume.checks.omitted -= 1;
  }
  return resume;
}

export async function readWorkItemResume(item: ResumeItem, deps: ResumeDeps = {
  checkpoint: getWorkItemCheckpointWithMeta,
  freshness: getWorkItemCheckpointFreshness,
  evidence: listSpecEvidence,
}) {
  const ref = { harness: item.harness ?? null, workItemId: item.id };
  const [checkpoint, freshness, evidence] = await Promise.all([
    deps.checkpoint(ref).catch(() => ({ checkpoint: null, updatedAtMs: null, readFailed: true })),
    deps.freshness(ref).catch(() => ({ verdict: 'unknown', reason: 'dependency read failed' })),
    deps.evidence({ harnessSlug: item.harness ?? undefined,
      planSlugs: [planOf(item)?.slug ?? ADHOC_WORK_ITEM_SPEC_SCOPE],
      workItemIds: [item.id], limit: EVIDENCE_READ_LIMIT,
    }).catch(() => null),
  ]);
  return buildWorkItemResume({ item, checkpoint, freshness, evidence });
}
