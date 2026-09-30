/**
 * Exact-slug scope recovery for the plans:* read tools.
 *
 * EI-21194994217912029: a recovery call often has an exact plan slug but NO
 * resolvable harness — `plans:get`/`plans:items` answered `harness_required`,
 * and the documented `harness:'all'` escape is rejected as `harness_forbidden`
 * in a workspace-scoped session. Correct state (per the filing): exact-slug
 * recovery RESOLVES the scope itself from the PG-canonical plan index, and
 * when it cannot, the error reports what it searched and found instead of
 * demanding an undiscoverable input.
 *
 * Explicit-`harness` calls and harness-scoped sessions never enter this path
 * (the handlers consult it only when resolveHarnessScope returns 'none').
 */

import { PAPERCUSP_WORKSPACE_ID } from '../../harness/papercusp-workspace';
import { planHarnessesForSlugs } from './source';

/** Per-slug candidate harnesses, most-recently-updated first — index 0 is the
 *  same deterministic pick `resolvePlanHarnessSlug` makes. */
export type SlugCandidates = Record<string, string[]>;

export interface PlanHarnessMismatch {
  callerHarness: string;
  reportedHarness?: string;
  availableHarnesses: string[];
  /** Whether the caller NAMED the searched harness, or inherited it from the session. */
  harnessSource: 'explicit' | 'ambient';
  warning: string;
}

export type SlugScopeDecision =
  | {
      /** Every requested slug is store-backed and resolves to ONE harness. */
      status: 'resolved';
      harnessSlug: string;
      bySlug: Record<string, string>;
      /** Slugs whose mapping was ambiguous (store-backed rows in >1 harness). */
      ambiguous: SlugCandidates;
    }
  | {
      status: 'missing';
      missing: string[];
      /** Slugs that DID resolve, for context in the error. */
      found: Record<string, string>;
      workspaceId: string;
    }
  | { status: 'split'; mapping: Record<string, string>; workspaceId: string };

/** Write tools may reuse exact-slug recovery, but must never use the read
 * path's "most recently updated wins" rule when one slug exists in multiple
 * harnesses. A lifecycle mutation needs a single unambiguous owner. */
export type WritableSlugScopeDecision =
  | Exclude<SlugScopeDecision, { status: 'resolved' }>
  | Extract<SlugScopeDecision, { status: 'resolved' }>
  | { status: 'ambiguous'; candidates: SlugCandidates; workspaceId: string };

export function requireUnambiguousSlugScope(
  decision: SlugScopeDecision,
  workspaceId: string,
): WritableSlugScopeDecision {
  if (decision.status !== 'resolved' || Object.keys(decision.ambiguous).length === 0) return decision;
  return { status: 'ambiguous', candidates: decision.ambiguous, workspaceId };
}

/**
 * Pure decision over the candidate map. Ambiguity inside a single slug does
 * NOT block resolution: index 0 wins (the `resolvePlanHarnessSlug`
 * most-recently-updated precedent), but the ambiguity is carried on the
 * resolved decision so handlers can surface it in metadata.
 */
export function decideSlugScope(
  slugs: readonly string[],
  candidates: SlugCandidates,
  workspaceId = '',
): SlugScopeDecision {
  const bySlug: Record<string, string> = {};
  const ambiguous: SlugCandidates = {};
  const missing: string[] = [];
  for (const slug of slugs) {
    const list = candidates[slug] ?? [];
    if (list.length === 0) {
      missing.push(slug);
      continue;
    }
    bySlug[slug] = list[0];
    if (list.length > 1) ambiguous[slug] = list;
  }
  if (missing.length > 0) {
    return { status: 'missing', missing, found: bySlug, workspaceId };
  }
  const distinct = [...new Set(Object.values(bySlug))];
  if (distinct.length > 1) {
    return { status: 'split', mapping: bySlug, workspaceId };
  }
  return { status: 'resolved', harnessSlug: distinct[0], bySlug, ambiguous };
}

/** The workspace the recovery searches: a concrete session workspace passes
 *  through; an unscoped ('*') session searches the operator's own workspace —
 *  the same default resolvePlanScope applies for operator-home scope. */
function callerWorkspaceId(ctx: unknown): string {
  const raw = (ctx as { workspaceId?: string | null }).workspaceId?.trim();
  return raw && raw !== '*' ? raw : PAPERCUSP_WORKSPACE_ID;
}

/**
 * Run the recovery for a handler whose harness scope came back 'none'.
 * One indexed query; absent or invalid slugs are not an error here — they
 * come back as a 'missing' decision.
 */
export async function recoverHarnessFromSlugs(
  ctx: unknown,
  slugs: readonly string[],
): Promise<SlugScopeDecision> {
  const workspaceId = callerWorkspaceId(ctx);
  const rowsBySlug = await planHarnessesForSlugs(workspaceId, slugs);
  const candidates: SlugCandidates = {};
  for (const [slug, list] of rowsBySlug) candidates[slug] = list;
  return decideSlugScope(slugs, candidates, workspaceId);
}

/**
 * Explain a miss caused by a concrete harness that does not own the exact slug.
 *
 * Read tools use this only after their normal scoped read misses (or before an
 * ambient read where the index can prove the miss up front). The lookup is
 * best-effort: an unavailable index leaves the ordinary not_found result intact.
 */
export async function harnessMismatchForMiss(
  ctx: unknown,
  callerHarness: string,
  slug: string,
  harnessSource: 'explicit' | 'ambient',
): Promise<PlanHarnessMismatch | null> {
  try {
    const decision = await recoverHarnessFromSlugs(ctx, [slug]);
    if (decision.status !== 'resolved') return null;
    const availableHarnesses = decision.ambiguous[slug] ?? [decision.harnessSlug];
    if (availableHarnesses.includes(callerHarness)) return null;
    const reportedHarness = availableHarnesses.length === 1 ? availableHarnesses[0] : undefined;
    const target = reportedHarness
      ? `harness '${reportedHarness}'`
      : `harnesses ${availableHarnesses.map((h) => `'${h}'`).join(', ')}`;
    const suggested = reportedHarness ?? availableHarnesses[0];
    const searched =
      harnessSource === 'explicit'
        ? `plans read searched harness '${callerHarness}' because you passed harness:'${callerHarness}' for '${slug}', `
        : `plans read searched ambient harness '${callerHarness}' for '${slug}', `;
    const remedy =
      harnessSource === 'explicit'
        ? `Pass harness:'${suggested}' instead, or omit harness to auto-resolve the owning harness from the slug.`
        : `Pass harness:'${suggested}' to read that plan explicitly.`;
    return {
      callerHarness,
      ...(reportedHarness ? { reportedHarness } : {}),
      availableHarnesses,
      harnessSource,
      warning: `${searched}but the exact slug is stored under ${target}. ${remedy}`,
    };
  } catch {
    return null;
  }
}

/**
 * Return the exact plan slugs carried by a plan-targeting argument object.
 *
 * This is deliberately limited to explicit plan-identity fields accepted by
 * the transport's allow-listed recovery surfaces. `slug` / `slugs` cover the
 * plans:* tools; `current_plan_slug` covers coord:declare-intent's structured
 * plan lane. Transport scope recovery must never infer a plan from free text or
 * from a result-shaped argument: the caller has to name the row it is asking
 * to read or claim. Values use stable de-duplication so the index lookup remains
 * one bounded query.
 */
export function exactPlanSlugsFromArgs(args: unknown): string[] {
  if (!args || typeof args !== 'object') return [];
  const value = args as { slug?: unknown; slugs?: unknown; current_plan_slug?: unknown };
  const requested = [
    ...(typeof value.slug === 'string' ? [value.slug] : []),
    ...(Array.isArray(value.slugs) ? value.slugs.filter((slug): slug is string => typeof slug === 'string') : []),
    ...(typeof value.current_plan_slug === 'string' ? [value.current_plan_slug] : []),
  ];
  return [...new Set(requested.map((slug) => slug.trim()).filter(Boolean))];
}

/**
 * Verify a cross-hive plans:get rebind against the PG-canonical exact-slug
 * index. A failed lookup is unverified (and therefore not a bypass), while a
 * missing slug or an owner mismatch is simply false. The explicit harness is
 * checked against every requested slug so a multi-slug read cannot widen its
 * scope through one matching row.
 */
export async function verifyExplicitPlanHarness(
  ctx: unknown,
  explicitHarness: string,
  args: unknown,
): Promise<boolean> {
  const slugs = exactPlanSlugsFromArgs(args);
  if (slugs.length === 0 || !explicitHarness.trim()) return false;
  try {
    const rowsBySlug = await planHarnessesForSlugs(callerWorkspaceId(ctx), slugs);
    return slugs.every((slug) => rowsBySlug.get(slug)?.includes(explicitHarness) === true);
  } catch {
    // The transport clamp must never turn an index outage into a cross-hive
    // read. The caller can retry once the workspace-scoped lookup recovers.
    return false;
  }
}

/**
 * The fail-loud error result for the non-resolved outcomes — same envelope
 * convention as `_harness-scope.ts`'s harnessRequiredResult. Each names what
 * was searched and what was found, so the caller never has to guess the next
 * input (the exact complaint EI-21194994217912029 recorded).
 */
export function slugScopeErrorResult(
  toolName: string,
  decision:
    | Extract<SlugScopeDecision, { status: 'missing' | 'split' }>
    | Extract<WritableSlugScopeDecision, { status: 'ambiguous' }>,
): { isError: true; content: Array<{ type: 'text'; text: string }> } {
  const hint =
    "Pass an explicit `harness` on this call (for example 'papercusp' for " +
    "Papercusp's own plans), or find the slug via cross_harness:plans_search.";
  const body =
    decision.status === 'missing'
      ? {
          error: 'plan_not_found_in_workspace',
          missing: decision.missing,
          ...(Object.keys(decision.found).length > 0 ? { foundIn: decision.found } : {}),
          detail:
            `No store-backed plan named ${decision.missing.map((s) => `'${s}'`).join(', ')} ` +
            `in workspace '${decision.workspaceId}' — exact-slug auto-resolution found no owning ` +
            `harness there. ${hint}`,
        }
      : decision.status === 'split'
        ? {
          error: 'harness_split_across_plans',
          mapping: decision.mapping,
          detail:
            `The requested slugs live in different harnesses (${JSON.stringify(decision.mapping)}); ` +
            'one call reads a single harness — pass an explicit `harness`, or split the slugs across calls.',
          }
        : {
            error: 'plan_slug_ambiguous_across_harnesses',
            candidates: decision.candidates,
            detail:
              `At least one requested slug exists in multiple harnesses (${JSON.stringify(decision.candidates)}). ` +
              'A write cannot safely pick the most recently updated copy — pass an explicit `harness`.',
          };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ tool: toolName, ...body }) }],
  };
}
