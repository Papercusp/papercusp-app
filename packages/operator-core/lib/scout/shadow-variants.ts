/**
 * shadow-variants.ts — the counterfactual critique lab's write + read seam
 * (plan counterfactual-critique-lab-turn-blender-grader-feedback-int-2026-08-13,
 * P-002 / D-001).
 *
 * WHAT THIS IS FOR. The lab asks one causal question: when the Blender grades an
 * idea 2–4 and leaves substantive feedback, does a revision CONDITIONED on that
 * feedback actually grade better than its source — or does the critique buy
 * nothing measurable? Answering it needs source/variant PAIRS that a blinded
 * grader can score under identical conditions.
 *
 * WHAT IT DELIBERATELY IS NOT. This is not a revision pipeline, a prompt change,
 * or a recurrence. It creates rows and one lineage edge; nothing here schedules,
 * wakes, routes, or promotes anything, and D-001 reserves any of that for a
 * separate plan. The three invariants it DOES enforce mechanically:
 *
 *   1. SOURCES ARE IMMUTABLE. {@link recordShadowVariant} never issues an UPDATE
 *      against the source row — it reads it and writes a NEW row. The source's
 *      grade, feedback, and grader stay exactly as the Blender left them, which
 *      is the whole basis of the comparison.
 *   2. VARIANTS ARE SOURCE-LINKED. Every variant carries a `revises` edge back to
 *      its source, so a pair is recoverable from the substrate rather than from a
 *      spreadsheet somebody kept.
 *   3. VARIANTS CONSUME NO ORDINARY ROUTING QUOTA. They ride `origin =
 *      'shadow-variant'`, which every ordinary reader excludes — see
 *      `shadow-variant-origin.ts` for why that exclusion lives in one place.
 *
 * Pinned by shadow-variants.test.ts (seam logic over a stubbed PG) — the same
 * split routed-ledger.test.ts uses.
 */

import { getOrgPg } from '@papercusp/db-org';
import { PgLinkStore } from '@papercusp/coordination/capabilities';
import { activeWorkspaceId } from '../workspace-registry';
import { recordRoutedIdea } from './routed-ledger';
import type { RoutedRail } from './outcome-feedback';
import type { SuIdeationLens } from './types';
import {
  SHADOW_VARIANT_LINK_KIND,
  SHADOW_VARIANT_ORIGIN,
  SHADOW_VARIANT_REL,
} from './shadow-variant-origin';

/** A source row as the lab reads it — the immutable half of a pair. */
export interface ShadowVariantSource {
  ideaId: string;
  lens: string;
  rail: string;
  harnessSlug: string;
  title: string | null;
  humanGrade: number | null;
  humanFeedback: string | null;
  gradedBy: string | null;
}

/** Input to {@link recordShadowVariant}. */
export interface RecordShadowVariantInput {
  /** The frozen cohort source idea's ledger id (D-002 pins the 20). */
  sourceIdeaId: string;
  /**
   * The variant's own ledger id. Callers should derive it deterministically from
   * the source (see {@link shadowVariantIdeaId}) so a re-run UPSERTs the same row
   * instead of inflating the cohort with near-duplicates.
   */
  variantIdeaId: string;
  /** The revised idea text produced by conditioning on the source's feedback. */
  title: string;
  /** The agent that generated the variant — persisted as `created_by`. */
  createdBy?: string;
  /** Override the active workspace (tests). */
  workspaceId?: string;
  /** Epoch ms; defaults to now. */
  routedAt?: number;
}

/** Result of {@link recordShadowVariant}. */
export interface RecordShadowVariantResult {
  variantIdeaId: string;
  sourceIdeaId: string;
  /** The source as it stood when the variant was generated (never mutated). */
  source: ShadowVariantSource;
}

/**
 * Thrown when the source cannot carry a feedback-conditioned variant. A LOUD
 * refusal rather than a silent skip: a trial that quietly generated 17 of its 20
 * pairs would report an uplift ratio over a denominator nobody chose, and D-002's
 * ">=5/20" criterion is meaningless if the 20 is soft.
 */
export class ShadowVariantSourceError extends Error {
  constructor(
    message: string,
    readonly reason: 'source-not-found' | 'source-ungraded' | 'source-has-no-feedback',
  ) {
    super(message);
    this.name = 'ShadowVariantSourceError';
  }
}

/**
 * The deterministic variant id for a source within one trial.
 *
 * Deterministic because the ledger PK is `idea_id` and `recordRoutedIdea` upserts
 * on it: a re-run of the generation step then REPLACES its own prior variant
 * rather than appending a second one. A random id would make a partial re-run
 * silently double the cohort — the failure mode that corrupts the trial's
 * denominator without erroring.
 */
export function shadowVariantIdeaId(sourceIdeaId: string, trialSlug: string): string {
  return `shadow-variant:${trialSlug}:${sourceIdeaId}`;
}

/** Read one source row. Read-only by construction — this module issues no UPDATE. */
export async function readShadowVariantSource(
  sourceIdeaId: string,
  opts: { workspaceId?: string } = {},
): Promise<ShadowVariantSource | null> {
  const { sql } = getOrgPg();
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const rows = await sql<
    {
      idea_id: string;
      lens: string;
      rail: string;
      harness_slug: string;
      title: string | null;
      human_grade: number | null;
      human_feedback: string | null;
      graded_by: string | null;
    }[]
  >`
    SELECT idea_id, lens, rail, harness_slug, title, human_grade, human_feedback, graded_by
      FROM harness_shared.scout_routed_ideas
     WHERE idea_id = ${sourceIdeaId}
       AND workspace_id = ${ws}`;
  const r = rows[0];
  if (!r) return null;
  return {
    ideaId: r.idea_id,
    lens: r.lens,
    rail: r.rail,
    harnessSlug: r.harness_slug,
    title: r.title,
    humanGrade: r.human_grade == null ? null : Number(r.human_grade),
    humanFeedback: r.human_feedback,
    gradedBy: r.graded_by,
  };
}

/**
 * Record ONE feedback-conditioned shadow variant of an already-graded source.
 *
 * Order matters and is not incidental: the source is READ and validated first,
 * then the variant row is written, then the lineage edge. A variant row that
 * outlives a failure before its edge is written is recoverable (re-run upserts
 * both, and {@link readShadowVariantPairs} simply will not see it until the edge
 * lands); an edge pointing at a row that was never written would not be.
 *
 * The variant INHERITS the source's lens, rail, and harness. That is what makes
 * the pair comparable — a variant scored under a different lens would confound
 * the very thing the trial measures — and it is also why nothing here accepts a
 * lens argument.
 */
export async function recordShadowVariant(
  input: RecordShadowVariantInput,
): Promise<RecordShadowVariantResult> {
  const ws = input.workspaceId ?? activeWorkspaceId();
  const source = await readShadowVariantSource(input.sourceIdeaId, { workspaceId: ws });
  if (!source) {
    throw new ShadowVariantSourceError(
      `recordShadowVariant: source idea ${input.sourceIdeaId} not found in workspace ${ws}`,
      'source-not-found',
    );
  }
  // D-002's eligibility is grade 2–4 WITH substantive feedback. The grade band is
  // the cohort selector (P-001 froze it); what THIS path must enforce is the
  // narrower structural precondition — there is no such thing as a
  // feedback-conditioned variant of an idea carrying no feedback.
  if (source.humanGrade == null) {
    throw new ShadowVariantSourceError(
      `recordShadowVariant: source idea ${input.sourceIdeaId} is ungraded — nothing to condition on`,
      'source-ungraded',
    );
  }
  if (!source.humanFeedback?.trim()) {
    throw new ShadowVariantSourceError(
      `recordShadowVariant: source idea ${input.sourceIdeaId} carries no feedback — a variant of it would not be feedback-conditioned`,
      'source-has-no-feedback',
    );
  }

  await recordRoutedIdea({
    ideaId: input.variantIdeaId,
    lens: source.lens as SuIdeationLens | 'su-ideate',
    rail: source.rail as RoutedRail,
    // The variant is a ledger row, not a filed artifact: its routed_ref points at
    // ITSELF rather than at a work-item/plan, because filing 20 real work-items is
    // precisely the ordinary-quota consumption D-001 forbids.
    routedRef: `shadow-variant:${input.variantIdeaId}`,
    harnessSlug: source.harnessSlug,
    title: input.title,
    origin: SHADOW_VARIANT_ORIGIN,
    ...(input.createdBy ? { createdBy: input.createdBy } : {}),
    ...(input.routedAt != null ? { routedAt: input.routedAt } : {}),
    workspaceId: ws,
  });

  // The lineage edge: variant --revises--> source, over the SAME generic typed-edge
  // store (`PgLinkStore` → coord_links) and the SAME `revises` rel the grade→revise
  // loop uses. Its link() is ON CONFLICT DO NOTHING, so a re-run is idempotent.
  //
  // ⚠ The store is pinned to the LEDGER's workspace, not to issues-engineer's
  // `coordScopeWorkspace()`. Those two axes can differ, and the edge has to land
  // in the same workspace `readShadowVariantPairs` reads it back from — a
  // coord-scoped edge beside ledger-scoped rows would leave every pair silently
  // unreadable while both writes reported success.
  await new PgLinkStore({
    getSql: () => getOrgPg().sql,
    ensureSchema: async () => {},
    getWorkspaceId: () => ws,
  }).link(
    { kind: SHADOW_VARIANT_LINK_KIND, ref: input.variantIdeaId },
    { kind: SHADOW_VARIANT_LINK_KIND, ref: input.sourceIdeaId },
    SHADOW_VARIANT_REL,
    { ...(input.createdBy ? { created_by: input.createdBy } : {}), created_ts: new Date().toISOString() },
  );

  return { variantIdeaId: input.variantIdeaId, sourceIdeaId: input.sourceIdeaId, source };
}

/** One source/variant pair, with both sides' grades — the unit P-003/P-004 analyze. */
export interface ShadowVariantPair {
  sourceIdeaId: string;
  variantIdeaId: string;
  lens: string;
  sourceTitle: string | null;
  variantTitle: string | null;
  sourceGrade: number | null;
  variantGrade: number | null;
  sourceFeedback: string | null;
  variantFeedback: string | null;
  sourceGradedBy: string | null;
  variantGradedBy: string | null;
}

/**
 * Read the trial's source/variant pairs by walking the `revises` edges.
 *
 * Returns BOTH sides' grades as they currently stand — including `null` for a
 * variant nobody has graded yet. Reporting an ungraded variant as a null rather
 * than dropping the row is deliberate: P-004 must be able to tell "graded, no
 * uplift" from "never graded", and a reader that silently omitted the second
 * would make an incomplete trial look like a completed one with a worse result.
 */
export async function readShadowVariantPairs(
  opts: { workspaceId?: string; sourceIdeaIds?: readonly string[]; limit?: number } = {},
): Promise<ShadowVariantPair[]> {
  const { sql } = getOrgPg();
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const limit = opts.limit ?? 200;
  const ids = opts.sourceIdeaIds && opts.sourceIdeaIds.length > 0 ? [...opts.sourceIdeaIds] : null;
  const rows = await sql<
    {
      source_idea_id: string;
      variant_idea_id: string;
      lens: string;
      source_title: string | null;
      variant_title: string | null;
      source_grade: number | null;
      variant_grade: number | null;
      source_feedback: string | null;
      variant_feedback: string | null;
      source_graded_by: string | null;
      variant_graded_by: string | null;
    }[]
  >`
    SELECT src.idea_id      AS source_idea_id,
           var.idea_id      AS variant_idea_id,
           src.lens         AS lens,
           src.title        AS source_title,
           var.title        AS variant_title,
           src.human_grade  AS source_grade,
           var.human_grade  AS variant_grade,
           src.human_feedback AS source_feedback,
           var.human_feedback AS variant_feedback,
           src.graded_by    AS source_graded_by,
           var.graded_by    AS variant_graded_by
      FROM harness_shared.coord_links l
      JOIN harness_shared.scout_routed_ideas var
        ON var.idea_id = l.src_ref AND var.workspace_id = ${ws}
      JOIN harness_shared.scout_routed_ideas src
        ON src.idea_id = l.dst_ref AND src.workspace_id = ${ws}
     WHERE l.workspace_id = ${ws}
       AND l.src_kind = ${SHADOW_VARIANT_LINK_KIND}
       AND l.dst_kind = ${SHADOW_VARIANT_LINK_KIND}
       AND l.rel = ${SHADOW_VARIANT_REL}
       AND var.origin = ${SHADOW_VARIANT_ORIGIN}
       ${ids ? sql`AND src.idea_id = ANY(${ids})` : sql``}
     ORDER BY src.routed_at ASC, src.idea_id ASC
     LIMIT ${limit}`;
  return rows.map((r) => ({
    sourceIdeaId: r.source_idea_id,
    variantIdeaId: r.variant_idea_id,
    lens: r.lens,
    sourceTitle: r.source_title,
    variantTitle: r.variant_title,
    sourceGrade: r.source_grade == null ? null : Number(r.source_grade),
    variantGrade: r.variant_grade == null ? null : Number(r.variant_grade),
    sourceFeedback: r.source_feedback,
    variantFeedback: r.variant_feedback,
    sourceGradedBy: r.source_graded_by,
    variantGradedBy: r.variant_graded_by,
  }));
}
