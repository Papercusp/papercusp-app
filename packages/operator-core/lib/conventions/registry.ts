/**
 * P-018 — CONVENTIONS AS A NAMED LAYER (plan `unified-agent-state-plane-2026-07-27`).
 *
 * Inter-agent conventions produced +128%, the largest measured gain in the whole
 * 2026 literature corpus — larger than any inference mechanism. The machinery
 * already existed in two places and was never named as one thing:
 *
 *   • `facts:assert { kind:'convention' }` — workspace/harness/role-scoped, folded
 *     verbatim into every orient (mig 690, P-008 (b));
 *   • `plans:add-decision` — plan-scoped rulings other lanes must follow.
 *
 * ⚠ THIS MODULE IS A READ MODEL. It creates NO storage (D-004, and P-018
 * explicitly: "do NOT build a third store"). Everything below is a projection of
 * rows that already exist, which is why a convention declared through either
 * mechanism is discoverable here the moment it is written, with no migration and
 * no adoption ceremony.
 *
 * THE ASYMMETRY BETWEEN THE TWO SOURCES IS DELIBERATE (D-075 R5):
 *
 *   a DECLARED CONVENTION (a fact with kind='convention') OPTED IN to governing,
 *   so it is returned WHOLE — every live one in scope, ranked but never filtered
 *   out for poor word overlap. Hiding a rule from the agent it binds is strictly
 *   worse than showing one that turns out not to apply.
 *
 *   a PLAN DECISION did NOT declare itself normative. It is surfaced only when it
 *   is RELEVANT to what the caller says they are about to do, it keeps
 *   `source:'plan-decision'`, and it carries `enforcement: null` — never
 *   relabelled a declared convention. Inventing a tier for it would repeat exactly
 *   the defect mig 690 refused when it declined to backfill `kind` to 'conclusion':
 *   a modality nobody declared is not one.
 */

import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import {
  type AgentFact,
  type ConventionEnforcement,
  factCitationRef,
  listConventionFacts,
} from '../agent-facts/store';

/** Same injection seam as `agent-facts/store.ts` — tests pass a client, callers don't. */
function sqlOf(inject?: Sql): Sql {
  return inject ?? getOrgPg().sql;
}

export type ConventionSource = 'fact' | 'plan-decision';

export interface Convention {
  /**
   * The CITABLE id — and D-075 R1's load-bearing guarantee: it is always a ref
   * `classifyPremiseRef` (message-fields.ts) already classifies as an
   * invalidatable kind. `fact:<scope>[:<ref>]:<key>@v<N>` or `<plan-slug>#D-NNN`.
   * Never a shape invented here.
   */
  id: string;
  source: ConventionSource;
  /** Short label — the fact key, or the decision title. */
  title: string;
  body: string;
  /**
   * D-016's tier. ALWAYS null for a plan decision (D-075 R5) — it has no
   * `agent_facts` row, therefore no declared tier, and absence is the honest
   * record rather than a gap to fill.
   */
  enforcement: ConventionEnforcement | null;
  /** Where to go back to. Set for `source:'fact'`. */
  scope?: string;
  /** Set for `source:'plan-decision'`. */
  planSlug?: string;
  /** Relevance to the caller's `about`, 0 when nothing was asked. */
  relevance: number;
  updatedAt: string;
}

/**
 * Words carrying no discriminating power in an intent sentence. Deliberately
 * SMALL — an aggressive stoplist silently drops the domain word that made the
 * query specific, and a discovery surface that quietly ignores your best term is
 * worse than one that ranks a little loosely.
 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'about', 'over',
  'when', 'what', 'which', 'while', 'have', 'has', 'was', 'are', 'not', 'but',
  'you', 'your', 'our', 'its', 'their', 'them', 'they', 'will', 'would', 'should',
  'can', 'could', 'may', 'might', 'must', 'am', 'is', 'be', 'been', 'being',
  'doing', 'does', 'did', 'done', 'going', 'want', 'need', 'just', 'now', 'then',
]);

/**
 * Tokenize an intent sentence into distinct lowercase terms.
 *
 * ⚠ The `[a-z0-9]+` filter is also the INJECTION BOUNDARY: these tokens are
 * interpolated into a `to_tsquery` string (see {@link relevantPlanDecisions}),
 * which — unlike `plainto_tsquery` — parses operators out of its input. Anything
 * that is not a bare alphanumeric term never reaches it. PURE.
 */
export function intentTokens(about: string | null | undefined): string[] {
  const raw = (about ?? '').toLowerCase().split(/[^a-z0-9]+/);
  const seen = new Set<string>();
  for (const t of raw) {
    if (t.length < 3 || STOPWORDS.has(t)) continue;
    if (/^[a-z0-9]+$/.test(t)) seen.add(t);
  }
  return [...seen];
}

/**
 * Deterministic overlap score: the fraction of the caller's distinct terms that
 * appear in the text. No similarity model, no embedding — the same reason
 * `foldFacts` is deterministic. Returns 0 when nothing was asked, which sorts
 * stably rather than pretending everything is equally relevant. PURE.
 */
export function relevanceScore(tokens: readonly string[], text: string): number {
  if (tokens.length === 0) return 0;
  const hay = text.toLowerCase();
  let hits = 0;
  for (const t of tokens) if (hay.includes(t)) hits += 1;
  return hits / tokens.length;
}

/** Project a declared-convention fact into the unified shape. PURE. */
export function conventionFromFact(f: AgentFact): Convention {
  return {
    id: factCitationRef(f),
    source: 'fact',
    title: f.key,
    body: f.body,
    enforcement: f.enforcement,
    scope: f.scopeRef ? `${f.scope}:${f.scopeRef}` : f.scope,
    relevance: 0,
    updatedAt: f.updatedAt,
  };
}

interface PlanDecisionRow {
  plan_slug: string;
  decision_id: string;
  title: string;
  body: string;
  updated_at: string;
}

/**
 * The workspace-scoped sentinel: "no ONE harness", not a harness literally named
 * `*`. A psu session that is not pinned to a harness carries this as its
 * `ctx.harnessSlug`, so it arrives here on the default path.
 */
export const ALL_HARNESSES = '*';

/**
 * The plan-decision half — decisions RELEVANT to `about`, across every live plan
 * in the harness, which is what makes "discovered without knowing which plan it
 * came from" true.
 *
 * Full-text ranked in PG rather than scored in TS: the decision corpus is large
 * (one plan alone carries 76) and pulling all of it into the process to score it
 * would be the spilled-projection anti-pattern the repo conventions call out.
 * Terms are OR-ed, not AND-ed — `plainto_tsquery`/`websearch_to_tsquery` AND
 * their terms, so a prose intent of eight words would match almost nothing.
 *
 * ⚠ `harness: '*'` DROPS the harness predicate rather than matching it (D-086
 * R1). No plan row has `harness_slug = '*'`, so comparing against the sentinel
 * returned exactly zero decisions with `ok:true` and no note — for a
 * workspace-scoped su, which is every psu session on this box. The
 * `workspace_id` predicate is NEVER dropped: this widens the harness axis only,
 * so it can never reach another tenant's plans.
 */
async function relevantPlanDecisions(
  args: { harness: string; tokens: readonly string[]; limit: number; workspaceId: string },
  inject?: Sql,
): Promise<PlanDecisionRow[]> {
  if (args.tokens.length === 0) return [];
  const sql = sqlOf(inject);
  // Safe: every token is `^[a-z0-9]+$` (see intentTokens).
  const tsquery = args.tokens.join(' | ');
  const allHarnesses = args.harness === ALL_HARNESSES;
  return sql<PlanDecisionRow[]>`
    SELECT p.plan_slug,
           d->>'id'    AS decision_id,
           d->>'title' AS title,
           d->>'body'  AS body,
           p.updated_at::text AS updated_at
      FROM harness_shared.harness_plans p,
           LATERAL jsonb_array_elements(p.decisions) d
     WHERE p.workspace_id = ${args.workspaceId}
       ${allHarnesses ? sql`` : sql`AND p.harness_slug = ${args.harness}`}
       AND NOT p.archived
       AND d->>'id' IS NOT NULL
       AND to_tsvector('english', coalesce(d->>'title','') || ' ' || coalesce(d->>'body',''))
           @@ to_tsquery('english', ${tsquery})
     ORDER BY ts_rank(
                to_tsvector('english', coalesce(d->>'title','') || ' ' || coalesce(d->>'body','')),
                to_tsquery('english', ${tsquery})
              ) DESC,
              p.updated_at DESC
     LIMIT ${args.limit}`;
}

export interface GoverningConventionsResult {
  conventions: Convention[];
  counts: { declared: number; planDecisions: number };
}

/**
 * "What conventions govern what I am about to do" — P-018's central read.
 *
 * DECLARED conventions first, always: they are normative and they opted in.
 * Relevant plan decisions follow, ranked. Both carry ids the citation seam
 * already parses, so the answer to "what governs this" and the ref you cite at
 * the point of action are the SAME STRING.
 */
export async function governingConventions(
  args: {
    harness: string;
    /** What the caller is about to do. Absent ⇒ declared conventions only —
     *  a complete answer to "what conventions exist", and an honest one: with
     *  nothing to rank against, surfacing arbitrary plan decisions would be noise
     *  dressed as governance. */
    about?: string | null;
    scopeRefs?: readonly string[];
    limit?: number;
    workspaceId?: string;
  },
  inject?: Sql,
): Promise<GoverningConventionsResult> {
  const ws = args.workspaceId ?? activeWorkspaceId();
  const limit = args.limit ?? 20;
  const tokens = intentTokens(args.about);

  const facts = await listConventionFacts(
    { workspaceId: ws, scopeRefs: args.scopeRefs, limit: Math.max(limit, 50) },
    inject,
  );
  const declared = facts
    .map((f) => {
      const c = conventionFromFact(f);
      c.relevance = relevanceScore(tokens, `${c.title} ${c.body}`);
      return c;
    })
    // Rank by relevance, but NEVER drop: a declared convention that does not
    // mention your words still binds you. Ties keep the newest-first order
    // listConventionFacts already established.
    .sort((a, b) => b.relevance - a.relevance);

  const rows = await relevantPlanDecisions(
    { harness: args.harness, tokens, limit, workspaceId: ws },
    inject,
  );
  const fromPlans: Convention[] = rows.map((r) => ({
    id: `${r.plan_slug}#${r.decision_id}`,
    source: 'plan-decision' as const,
    title: r.title ?? r.decision_id,
    body: r.body ?? '',
    // D-075 R5 — never invented.
    enforcement: null,
    planSlug: r.plan_slug,
    relevance: relevanceScore(tokens, `${r.title ?? ''} ${r.body ?? ''}`),
    updatedAt: r.updated_at,
  }));

  return {
    conventions: [...declared, ...fromPlans].slice(0, limit),
    counts: { declared: declared.length, planDecisions: fromPlans.length },
  };
}
