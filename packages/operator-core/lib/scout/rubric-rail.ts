/**
 * rubric-rail.ts — the Scout `rubric` rail (plan-templates-and-rubric-v2-2026-06-20
 * P-009, Phase 4 "auto-crystallization").
 *
 * The 4th Scout routing rail (alongside plan / gym / improvement). Its INPUT is NOT
 * a creative {@link Proposal} (the other rails route those) but a RUBRIC GAP — a
 * recurring friction cluster the Hive keeps hitting with NO covering active rubric,
 * detected DETERMINISTICALLY by the corpus-digest's `rubricGaps` lane (P-008: ≥3
 * distinct authors AND ≥2 day-cycles AND no covering rubric). So the rail branches
 * off the DIGEST, not the proposal flow — it runs in the `readCorpus` seam where the
 * full {@link StateOfHiveDigest} (with `rubricGaps`) is in hand (cycle-deps.ts).
 *
 * ON A GAP, Scout AUTHORS a `template: rubric` DRAFT plan (the cluster's evidence is
 * the model/method/drift seed) and runs it through the EXISTING queen↔scout feedback
 * loop (D-003): the draft ships `status: draft` + `origin: scout` + the
 * {@link SCOUT_DRAFT_LOOP_NOTE}, so an independent reviewer reviews it and either PROMOTES it
 * (ratify → fills the rubric `templateData` + active) or sends feedback to revise /
 * deprecates it (a `learnings` observation re-feeds Scout). No new authoring/review
 * flow — it rides the SAME machinery the broad `plan` rail uses (scout-plan-draft.ts).
 *
 * The authored draft carries NO `templateData` yet (a content write derives the
 * `template` column but never touches `template_data` — with-plan-lock.ts) — the gap
 * gives a THEME + evidence, not a full criteria set; the Queen fleshes out the rubric
 * structure on ratification (plans:set-template-data → validated → promote → active).
 * Until promoted, the draft is invisible to rubrics:list (which requires active +
 * templateData), so a pending proposal never masquerades as a live standard.
 *
 * DESIGN — deterministic, LLM-free, idempotent, defensive (mirrors experiment-rail.ts):
 * one STABLE slug per gap theme, so a re-run each cycle no-ops on the existing draft
 * (createScoutPlanDraft is idempotent on slug collision) — no draft spam. Every author
 * is best-effort: one gap that fails to write never aborts the batch or the cycle.
 * Loose by design — over-propose; independent ratification is the real quality filter (D-003).
 */

import { createScoutPlanDraft, type CreateScoutPlanDraftInput } from './scout-plan-draft';
import { SCOUT_DRAFT_LOOP_NOTE } from './feedback-loop-prompt';
import { RUBRIC_TEMPLATE_NAME } from '../agent-tools/plans/rubric-template';
import type { MetaPattern } from './types';

/** A gap can author at most this many drafts per cycle — a burst guard so a noisy
 *  digest (many gaps at once) can't flood the plan store in one tick. The digest
 *  already ranks `rubricGaps` by salience, so the top-N are the strongest gaps. */
export const DEFAULT_MAX_RUBRIC_DRAFTS_PER_CYCLE = 5;

/** Flatten + cap a one-line string for a slug/title/frontmatter field. */
function flat(s: string): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

function truncate(s: string, n: number): string {
  const f = flat(s);
  return f.length > n ? `${f.slice(0, n - 1)}…` : f;
}

/**
 * Derive a STABLE, valid kebab slug stem from the gap's theme (its `summary` — the
 * cluster exemplar's title). Stable across cycles so the same gap maps to the same
 * draft (idempotent no-op on re-run). Always satisfies plans:new's
 * `^[a-z0-9][a-z0-9-]*[a-z0-9]$` (min-3) via the `scout-rubric-` prefix.
 */
export function deriveRubricSlugStem(summary: string): string {
  const core = flat(summary)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '');
  return core.length > 0 ? `scout-rubric-${core}` : 'scout-rubric-gap';
}

/** The draft title for a gap-derived rubric proposal. */
export function rubricDraftTitle(gap: MetaPattern): string {
  return `Rubric proposal: ${truncate(gap.summary, 80)}`;
}

/**
 * The `template: rubric` DRAFT body for a rubric-gap proposal. Same draft shape the
 * broad rail writes (frontmatter + Now + Background + Decisions), specialised with
 * `template: rubric`, the gap evidence as the rubric's model/method/drift seed, and a
 * "Proposed rubric" section guiding the Queen to fill `templateData` on ratification.
 */
export function buildScoutRubricDraftBody(args: {
  slug: string;
  title: string;
  date: string;
  gap: MetaPattern;
}): string {
  const { slug, title, date, gap } = args;
  const evidence = flat(gap.detail ?? '') || 'a recurring cross-author friction cluster';
  const ref = flat(gap.ref ?? '');
  return `---
title: ${title}
slug: ${slug}
status: draft
origin: scout
template: ${RUBRIC_TEMPLATE_NAME}
created: ${date}
updated: ${date}
---

# ${title}

## Now

**State:** Draft rubric proposal — the Blender loop's auto-crystallization rail detected a RUBRIC GAP: a recurring friction the Pot keeps hitting with NO covering active rubric (plan-templates-and-rubric-v2 P-009 / D-003). Awaiting independent review and ratification; NOT a live standard until promoted (active + templateData).

**Next:** ${SCOUT_DRAFT_LOOP_NOTE}

## Background — the gap evidence (the rubric's model/method/drift seed)

**Theme:** ${truncate(gap.summary, 200)}

**Signal:** ${evidence}${ref ? ` (drill-back: ${ref})` : ''}

The Pot repeatedly hit this cluster (≥3 distinct authors across ≥2 cycles) yet has no
shared standard to grade it by — that absence is the gap. The clustered observations
above are the raw material for the rubric's per-criterion model (how it should work),
method (how to investigate it), and drift markers (what degraded/broken looks like).

## Proposed rubric — reviewer/Blender fills the structured \`templateData\` on ratification

Define the rubric with \`plans:set-template-data\` (validated against the \`rubric\`
template schema), then an independent reviewer promotes this draft to \`active\` via
\`rubrics:ratify\` (the proposer must not self-ratify):

- **characteristic:** the umbrella domain this rubric measures (Blender's digest groups by this).
- **criteria:** one or more \`{ key, title, model, method, driftMarkers }\` — what a structured observation grades.
- **ratingScale:** the default rating vocabulary, e.g. \`["healthy","degraded","broken","unknown"]\`.

## Decisions

(Use plans:add-decision to append.)
`;
}

/** Per-cycle authoring options (the harness/workspace the drafts live in + the burst cap). */
export interface AuthorRubricGapPlansOptions {
  /** Harness the rubric-draft plans are created in (default: operator scope). */
  harnessSlug?: string;
  /** Workspace the drafts live in (default: the lock's resolution). */
  workspaceId?: string;
  /** ISO date (YYYY-MM-DD) for the draft frontmatter; defaults to today. */
  date?: string;
  /** Cap drafts authored this cycle (default {@link DEFAULT_MAX_RUBRIC_DRAFTS_PER_CYCLE}). */
  maxPerCycle?: number;
}

/** Injected deps — the draft creator (faked in tests; default = the real idempotent creator). */
export interface AuthorRubricGapPlansDeps {
  createDraft?: (input: CreateScoutPlanDraftInput) => Promise<{ slug: string; created: boolean }>;
}

/** The outcome of one rubric-rail pass. */
export interface RubricGapAuthorResult {
  /** Slugs of drafts NEWLY created this pass. */
  authored: string[];
  /** Slugs that already existed (idempotent no-op — the gap was seen a prior cycle). */
  existing: string[];
  /** Gaps whose author threw (best-effort: recorded, never aborts the batch). */
  failed: Array<{ ref: string; error: string }>;
}

/**
 * Author a `template: rubric` DRAFT plan for each detected rubric gap (P-009). Pure
 * orchestration over the injected creator: deterministic, idempotent (a stable per-gap
 * slug no-ops on re-run), and DEFENSIVE — one gap that fails to write is recorded in
 * `failed` and never aborts the rest (the ideators.ts "one failure never kills the
 * batch" discipline). The created drafts enter the existing queen↔scout loop.
 */
export async function authorRubricGapPlans(
  gaps: readonly MetaPattern[],
  opts: AuthorRubricGapPlansOptions = {},
  deps: AuthorRubricGapPlansDeps = {},
): Promise<RubricGapAuthorResult> {
  const createDraft = deps.createDraft ?? createScoutPlanDraft;
  const limit = opts.maxPerCycle ?? DEFAULT_MAX_RUBRIC_DRAFTS_PER_CYCLE;
  const result: RubricGapAuthorResult = { authored: [], existing: [], failed: [] };

  for (const gap of gaps.slice(0, Math.max(0, limit))) {
    try {
      const title = rubricDraftTitle(gap);
      const { slug, created } = await createDraft({
        slug: deriveRubricSlugStem(gap.summary),
        title,
        ...(opts.harnessSlug ? { harnessSlug: opts.harnessSlug } : {}),
        ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
        ...(opts.date ? { date: opts.date } : {}),
        buildBody: ({ slug, date }) => buildScoutRubricDraftBody({ slug, title, date, gap }),
      });
      (created ? result.authored : result.existing).push(slug);
    } catch (e) {
      result.failed.push({ ref: flat(gap.ref ?? '') || flat(gap.summary), error: errMsg(e) });
    }
  }
  return result;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
