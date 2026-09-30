/**
 * Advisory validation for plan-decision references carried in continuity notes.
 *
 * A bare `D-NNN` is not a reference: decision numbers are allocated per plan.
 * Only `<plan-slug>#D-NNN` gives the resolver enough identity to ask whether the
 * plan and decision are present. This module deliberately reuses the parser and
 * production probe used by premise resolution rather than growing a second
 * decision lookup contract.
 *
 * The result is decoration on a checkpoint write, never a gate. A clean probe
 * result for a missing plan/decision earns a warning; a missing/throwing probe
 * means the store could not judge and stays silent.
 */
import { parsePlanDecisionRef } from './premise-resolve';
import { premiseProbes } from './premise-probes';

/** Bound continuity-note decision probes so a pathological note cannot fan out. */
export const MAX_PLAN_DECISION_REFS = 12;

export type PlanDecisionRefProbe = (
  slug: string,
  decisionId: string,
) => Promise<{ planExists: boolean; decisionExists: boolean } | null>;

export interface DecisionRefAdvisoryOptions {
  /** Injectable probe for unit tests and consumers with an existing resolver. */
  probe?: PlanDecisionRefProbe;
  /** Explicit workspace forwarded to the production workspace-scoped probe. */
  workspaceId?: string | null;
  /** Caller harness forwarded for attribution/context, without narrowing the lookup. */
  harnessSlug?: string | null;
  /** Maximum distinct qualified refs to probe. */
  max?: number;
}

export interface UnresolvedPlanDecisionRef {
  ref: string;
  slug: string;
  decisionId: string;
  reason: 'missing-plan' | 'missing-decision';
}

export interface DecisionRefAdvisory {
  flagged: true;
  refs: UnresolvedPlanDecisionRef[];
  note: string;
}

/** Remove markdown/prose punctuation around a token while preserving its ref bytes. */
function trimReferenceToken(token: string): string {
  return token
    .replace(/^[`"'([{<]+/, '')
    .replace(/[.`"',;:!?)}\]>]+$/, '');
}

/**
 * Find qualified decision refs in prose. `parsePlanDecisionRef` remains the
 * authority for validity; the regex only locates candidates. In particular,
 * this cannot match a bare `D-NNN`, which is intentionally left unknown.
 */
export function extractPlanDecisionRefs(text: string | null | undefined, max = MAX_PLAN_DECISION_REFS): string[] {
  const body = (text ?? '').trim();
  if (!body || max <= 0) return [];

  const refs: string[] = [];
  const seen = new Set<string>();
  // Match the qualified portion of slash-separated prose such as `plan#D-001/D-002`.
  const candidates = /[^\s#"'`()[\]{}<>]+#D-\d+/gi;
  for (const match of body.matchAll(candidates)) {
    const ref = trimReferenceToken(match[0] ?? '');
    if (!parsePlanDecisionRef(ref)) continue;
    const key = ref.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
    if (refs.length >= max) break;
  }
  return refs;
}

/**
 * Return unresolved qualified plan-decision refs, or `undefined` when there is
 * no actionable advisory. Every probe is independent and fail-soft.
 */
export async function unresolvedPlanDecisionRefs(
  text: string | null | undefined,
  opts: DecisionRefAdvisoryOptions = {},
): Promise<DecisionRefAdvisory | undefined> {
  const requestedMax = opts.max ?? MAX_PLAN_DECISION_REFS;
  const max = Number.isFinite(requestedMax) ? Math.max(0, Math.floor(requestedMax)) : MAX_PLAN_DECISION_REFS;
  const refs = extractPlanDecisionRefs(text, max);
  if (refs.length === 0) return undefined;

  const probe = opts.probe ?? premiseProbes({ workspaceId: opts.workspaceId, harnessSlug: opts.harnessSlug }).planDecision;
  if (!probe) return undefined;

  const unresolved = (
    await Promise.all(
      refs.map(async (ref): Promise<UnresolvedPlanDecisionRef | null> => {
        const parsed = parsePlanDecisionRef(ref);
        if (!parsed) return null;
        try {
          const result = await probe(parsed.slug, parsed.decisionId);
          // null means the resolver could not judge. Only a clean boolean result
          // is evidence that a qualified ref is dangling.
          if (!result) return null;
          if (!result.planExists) {
            return { ref, slug: parsed.slug, decisionId: parsed.decisionId, reason: 'missing-plan' };
          }
          if (!result.decisionExists) {
            return { ref, slug: parsed.slug, decisionId: parsed.decisionId, reason: 'missing-decision' };
          }
          return null;
        } catch {
          return null;
        }
      }),
    )
  ).filter((row): row is UnresolvedPlanDecisionRef => row !== null);

  if (unresolved.length === 0) return undefined;
  const details = unresolved
    .map((row) => `${row.ref} (${row.reason === 'missing-plan' ? 'plan not found' : 'decision not found'})`)
    .join(', ');
  const plural = unresolved.length === 1 ? 'reference does' : 'references do';
  return {
    flagged: true,
    refs: unresolved,
    note:
      `decision_ref_lint: ${unresolved.length} qualified plan-decision ${plural} not resolve in this workspace: ` +
      `${details}. Bare D-NNN remains intentionally unknown because decision ids are plan-local. ` +
      'This is advisory only and did not block the checkpoint write; re-read the exact plan/decision ref before ' +
      'treating the carried citation as authority.',
  };
}
