/**
 * `plans.provenance` read model (plan-item-provenance-2026-09-29 P-004, R-5).
 *
 * Both directions of a plan's activation audit, for the owner:
 *   - ITEMS → where each current item came from (owner / derived / agent-added /
 *     unresolved / not-audited), with the quoted source turns, their speaker and
 *     their origin verdict.
 *   - REQUESTS → every forward mapping (what the owner asked for), rejected and open
 *     requests FIRST (plan D-006) — a request the plan quietly does not do is the most
 *     valuable thing to see.
 * plus the audited-vs-current plan revision and the items the audit never saw.
 *
 * Labels come from what the audit PERSISTED (D-005: the stored per-ref verdicts), so the
 * owner sees what the gate judged. Quote text is display data and is read live. An audit
 * recorded before item provenance existed has no stored verdicts; its labels are computed
 * live and the view says so (`grandfathered`).
 */
import { z } from 'zod';
import { parsePlan } from '@papercusp/plan-parser';
import {
  fetchSourceTurns,
  isOwnerTurnVerdict,
  resolveItemProvenance,
  type ItemProvenanceLabel,
  type ItemProvenanceUnresolvedReason,
  type SourceTurn,
  type TurnSql,
} from './activation-item-provenance';
import type { HitTurnOriginVerdict } from './agent-tools/sessions/turn-origin';
import type { ActivationAuditMapping, AuditedPlanRevision, PlanAudit } from './plan-audits';

/** Excerpt budget per quoted turn — enough to read the request, bounded for the panel. */
export const PROVENANCE_QUOTE_CHARS = 600;

export const planProvenanceArgsSchema = z.object({
  workspaceId: z.string().default('default'),
  harnessSlug: z.string().min(1).optional(),
  planSlug: z.string().min(1),
});
export type PlanProvenanceArgs = z.infer<typeof planProvenanceArgsSchema>;

export type PlanItemProvenanceLabel = ItemProvenanceLabel | 'not-audited';

export interface ProvenanceQuote {
  ref: string;
  speaker: string | null;
  verdict: HitTurnOriginVerdict;
  /** True only for an affirmative owner verdict (never assistant / injected / unknown). */
  owner: boolean;
  /** Live turn text (bounded); null when the turn could not be read. */
  excerpt: string | null;
}

export interface PlanItemProvenanceRow {
  itemId: string;
  text: string;
  label: PlanItemProvenanceLabel;
  reason?: ItemProvenanceUnresolvedReason;
  derivedFrom?: string[];
  agentReason?: string;
  mappingIds: string[];
  sources: ProvenanceQuote[];
}

export interface PlanRequestRow {
  mappingId: string;
  requirement: string;
  disposition: ActivationAuditMapping['disposition'];
  planTargets: string[];
  sources: ProvenanceQuote[];
}

export interface PlanProvenanceView {
  planSlug: string;
  harnessSlug: string;
  status: 'no-audit' | 'audited';
  audit: {
    auditSeq: number;
    createdAt: string;
    createdBy: string;
    /** true/false = held/not held to the rule; null = recorded before item provenance. */
    enforced: boolean | null;
  } | null;
  /** The audit predates stored item provenance; labels were computed live. */
  grandfathered: boolean;
  auditedRevision: AuditedPlanRevision | null;
  currentRevision: { seq: number; contentHash: string } | null;
  /** The plan changed after its audit. */
  stale: boolean;
  /** Current items the audit never saw (added after it). */
  unauditedItems: string[];
  counts: Record<PlanItemProvenanceLabel, number>;
  items: PlanItemProvenanceRow[];
  /** Forward mappings: rejected, then open, then repaired, then covered. */
  requests: PlanRequestRow[];
  repairedOmissions: string[];
  rejectedOrSuperseded: string[];
  unresolvedBlockers: string[];
}

const DISPOSITION_ORDER: Record<ActivationAuditMapping['disposition'], number> = {
  rejected: 0,
  open: 1,
  repaired: 2,
  covered: 3,
};

/** Every source ref the view will quote (for one batched turn read). */
export function provenanceSourceRefs(audit: PlanAudit | null): string[] {
  return [...new Set((audit?.activation?.mappings ?? []).flatMap((mapping) => mapping.sourceRefs))];
}

/** Pure: assemble the view from the plan body, its latest activation audit and the read turns. */
export function buildPlanProvenance(input: {
  planSlug: string;
  harnessSlug: string;
  planContent: string;
  currentRevision: { seq: number; contentHash: string } | null;
  audit: PlanAudit | null;
  turns: ReadonlyMap<string, Pick<SourceTurn, 'speaker' | 'text' | 'verdict'>>;
}): PlanProvenanceView {
  const currentItems = parsePlan(input.planContent, { filePath: `${input.planSlug}.md` }).items
    .filter((item) => item.storedStatus !== 'dropped')
    .map((item) => ({ id: item.id, text: item.text }));
  const activation = input.audit?.activation ?? null;
  const check = activation?.itemProvenanceCheck ?? null;

  // D-005: judge with the verdicts the audit stored; fall back to live only for audits
  // that predate stored provenance. A stored-absent ref is `unknown`, never re-guessed.
  const verdictOf = (ref: string): HitTurnOriginVerdict | undefined =>
    check ? check.refOrigins?.[ref] : input.turns.get(ref)?.verdict;
  const quote = (ref: string): ProvenanceQuote => {
    const verdict = verdictOf(ref) ?? 'unknown';
    const turn = input.turns.get(ref);
    return { ref, speaker: turn?.speaker ?? null, verdict, owner: isOwnerTurnVerdict(verdict), excerpt: turn?.text ?? null };
  };

  const auditedIds = activation
    ? currentItems.map((item) => item.id).filter((id) => !check || id in check.items)
    : [];
  const summary = activation
    ? resolveItemProvenance({
        itemIds: auditedIds,
        mappings: activation.mappings,
        originOf: verdictOf,
        declarations: activation.itemProvenance ?? [],
      })
    : null;
  const resolved = new Map((summary?.items ?? []).map((item) => [item.itemId, item]));

  const counts: Record<PlanItemProvenanceLabel, number> = {
    owner: 0,
    derived: 0,
    'agent-added': 0,
    unresolved: 0,
    'not-audited': 0,
  };
  const items: PlanItemProvenanceRow[] = currentItems.map((item) => {
    const result = resolved.get(item.id);
    const row: PlanItemProvenanceRow = result
      ? {
          itemId: item.id,
          text: item.text,
          label: result.label,
          ...(result.reason ? { reason: result.reason } : {}),
          ...(result.derivedFrom ? { derivedFrom: result.derivedFrom } : {}),
          ...(result.agentReason ? { agentReason: result.agentReason } : {}),
          mappingIds: result.mappingIds,
          sources: result.refs.map((entry) => quote(entry.ref)),
        }
      : { itemId: item.id, text: item.text, label: 'not-audited', mappingIds: [], sources: [] };
    counts[row.label] += 1;
    return row;
  });

  const requests: PlanRequestRow[] = (activation?.mappings ?? [])
    .map((mapping, index) => ({ mapping, index }))
    .sort((a, b) => DISPOSITION_ORDER[a.mapping.disposition] - DISPOSITION_ORDER[b.mapping.disposition] || a.index - b.index)
    .map(({ mapping }) => ({
      mappingId: mapping.id,
      requirement: mapping.requirement,
      disposition: mapping.disposition,
      planTargets: mapping.planTargets,
      sources: mapping.sourceRefs.map(quote),
    }));

  const auditedRevision = input.audit?.auditedPlanRevision ?? null;
  const unauditedItems = items.filter((item) => item.label === 'not-audited').map((item) => item.itemId);
  return {
    planSlug: input.planSlug,
    harnessSlug: input.harnessSlug,
    status: input.audit ? 'audited' : 'no-audit',
    audit: input.audit
      ? {
          auditSeq: input.audit.auditSeq,
          createdAt: input.audit.createdAt,
          createdBy: input.audit.createdBy,
          enforced: check ? check.enforced : null,
        }
      : null,
    grandfathered: input.audit != null && check == null,
    auditedRevision,
    currentRevision: input.currentRevision,
    stale:
      unauditedItems.length > 0 ||
      (auditedRevision != null && input.currentRevision != null && auditedRevision.contentHash !== input.currentRevision.contentHash),
    unauditedItems,
    counts,
    items,
    requests,
    repairedOmissions: activation?.repairedOmissions ?? [],
    rejectedOrSuperseded: activation?.rejectedOrSuperseded ?? [],
    unresolvedBlockers: activation?.unresolvedBlockers ?? [],
  };
}

/** Sync resolver: one row, or none when the plan does not exist in scope. */
export async function resolvePlanProvenance(args: PlanProvenanceArgs): Promise<PlanProvenanceView[]> {
  const [{ resolvePlanScope, getPlanRow }, { getLatestActivationAudit }, { getOrgPg }] = await Promise.all([
    import('./agent-tools/plans/source'),
    import('./plan-audits'),
    import('@papercusp/db-org'),
  ]);
  const scope = await resolvePlanScope({ harnessSlug: args.harnessSlug });
  const plan = await getPlanRow(args.planSlug, scope);
  if (!plan?.content) return [];
  const audit = await getLatestActivationAudit(args.planSlug, scope);
  const { sql } = getOrgPg();
  const revisionRows = await sql<Array<{ seq: number; content_hash: string }>>`
    SELECT seq, content_hash
      FROM harness_shared.plan_revisions
     WHERE workspace_id = ${scope.workspaceId}
       AND harness_slug = ${scope.harnessSlug}
       AND plan_slug = ${args.planSlug}
     ORDER BY seq DESC
     LIMIT 1`;
  const turns = await fetchSourceTurns(sql as unknown as TurnSql, scope.workspaceId, provenanceSourceRefs(audit), PROVENANCE_QUOTE_CHARS);
  return [
    buildPlanProvenance({
      planSlug: args.planSlug,
      harnessSlug: scope.harnessSlug,
      planContent: plan.content,
      currentRevision: revisionRows[0]
        ? { seq: Number(revisionRows[0].seq), contentHash: revisionRows[0].content_hash }
        : null,
      audit,
      turns,
    }),
  ];
}
