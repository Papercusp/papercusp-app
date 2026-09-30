/**
 * publish-plan-core — the ONE server-side path that publishes a plan TEMPLATE to the
 * Cupboard as a `kind='plan'` listing
 * (cupboard-plan-rubric-recipe-sharing-2026-08-21 P-009).
 *
 * Mirrors publish-rubric-core / publish-template-core: the listing is
 * MIRROR-REPO-BACKED — `github_url` is the public repo the template dir was pushed to
 * and `listing_ref` is the per-template subdir. What is different, and why this file
 * is not a copy of publish-rubric-core, is that a plan has NO DIRECTORY ON DISK to
 * push: it lives in Postgres as one markdown blob fused with its run log. So this
 * core does two things a rubric publish does not:
 *
 *   1. SANITIZES (plan-template-serialize) — strips item statuses, set-status notes,
 *      the `## Now` block, workspace-local work-item ids and the identity
 *      frontmatter, keeping the goal, the item DAG, the decisions and the prose.
 *   2. MATERIALIZES the result as a self-describing dir in the writable user layer,
 *      so the publisher has a real directory to push.
 *
 * Hence `exportOnly`. The honest ordering is export → push → publish (the listing must
 * point at a repo that already contains the dir), and a tool that could only do the
 * last step would force every publisher to hand-assemble the first. `exportOnly: true`
 * runs steps 1–2 and stops; the default runs all three, which is correct for a
 * re-publish of a dir already in the mirror.
 *
 * REVIEW POLICY: 'plan' is a REVIEW_POLICY_KIND (D-002) — a plan template is prose
 * that tells another workspace what to DO, so it lands PENDING until an operator
 * approves it. Enforced server-side by the worker; surfaced here.
 */
import { publishListingToCupboard } from './publish-listing';
import { parseGithubRemote, fetchGithubRepoMeta } from './resolve-repo-coords';
import { sanitizePlanForTemplate, type PlanTemplateExport } from './plan-template-serialize';
import { writePlanTemplateDir, type WrittenPlanTemplate } from './plan-template-store';
import type { RubricRequirement } from './types';

// A single safe path segment: the dir name under the user layer AND the within-repo
// subdir. Mirrors install-self-describing-core's SAFE_REF_RE. UNTRUSTED.
const SAFE_REF_RE = /^[A-Za-z0-9._-]+$/;

export interface PublishPlanInput {
  /** The SOURCE plan's slug in this workspace — what gets sanitized. */
  slug: string;
  /** Harness scope for the plan lookup (defaults to the caller's resolved scope). */
  harness?: string;
  /** The public mirror repo the exported dir lives in. Required unless `exportOnly`. */
  github_url?: string;
  /** Override the within-repo subdir / user-layer dir name (else the template slug). */
  listing_ref?: string;
  /** Override the slug the exported template declares (else the source plan's). */
  template_slug?: string;
  /** Papercupai project remote (D-008). */
  project_ref?: string;
  title?: string;
  description?: string;
  /** Template version recorded in listing.json (storefront only). */
  version?: string;
  /** Declare these rubric requirements instead of the derived set. `[]` ⇒ none. */
  requires_rubrics?: RubricRequirement[];
  /** Materialize the sanitized dir and STOP — do not create a listing. */
  exportOnly?: boolean;
}

export interface PublishPlanExportInfo {
  written: WrittenPlanTemplate;
  templateSlug: string;
  title: string;
  description: string;
  itemCount: number;
  decisionCount: number;
  requiresRubrics: RubricRequirement[];
  stripped: PlanTemplateExport['stripped'];
}

export type PublishPlanResult =
  | { ok: true; exportedOnly: true; export: PublishPlanExportInfo }
  | { ok: true; exportedOnly: false; export: PublishPlanExportInfo; listing: unknown }
  | { ok: false; status: number; error: string; detail?: unknown; upstream_status?: number };

/** Read the source plan's canonical markdown. Injected so the core is testable
 *  without a live Postgres — the real wiring is `getPlanRow`. */
export type PlanContentReader = (
  slug: string,
  harness: string | undefined,
) => Promise<{ content: string; title: string | null } | null>;

async function defaultPlanContentReader(
  slug: string,
  harness: string | undefined,
): Promise<{ content: string; title: string | null } | null> {
  const { getPlanRow } = await import('../agent-tools/plans/source');
  const row = await getPlanRow(slug, harness ? { harnessSlug: harness } : {});
  if (!row) return null;
  return { content: row.content ?? '', title: row.title };
}

/**
 * Publish (or just export) a plan template. Returns a structured result — never
 * throws for an expected failure; the caller maps status+error to its response.
 */
export async function publishPlanToCupboard(
  input: PublishPlanInput,
  readPlan: PlanContentReader = defaultPlanContentReader,
): Promise<PublishPlanResult> {
  const slug = String(input.slug ?? '').trim();
  if (!slug) return { ok: false, status: 400, error: 'slug required (the plan to publish)' };

  const row = await readPlan(slug, input.harness);
  if (!row) return { ok: false, status: 404, error: `plan "${slug}" not found` };

  const sanitized = sanitizePlanForTemplate(row.content, {
    ...(input.template_slug ? { templateSlug: input.template_slug } : {}),
    ...(input.title ? { title: input.title } : {}),
    ...(input.description ? { description: input.description } : {}),
    ...(input.requires_rubrics ? { requiresRubrics: input.requires_rubrics } : {}),
  });
  if ('error' in sanitized) {
    return { ok: false, status: sanitized.status, error: sanitized.error };
  }

  const ref = (input.listing_ref ?? sanitized.templateSlug).trim();
  if (!SAFE_REF_RE.test(ref)) {
    return { ok: false, status: 400, error: `invalid plan template ref "${ref}"` };
  }

  let written: WrittenPlanTemplate;
  try {
    written = writePlanTemplateDir(sanitized, {
      ref,
      ...(input.version ? { version: input.version } : {}),
    });
  } catch (e) {
    return {
      ok: false,
      status: 500,
      error: 'could not materialize the plan template dir',
      detail: e instanceof Error ? e.message.slice(0, 300) : String(e),
    };
  }

  const info: PublishPlanExportInfo = {
    written,
    templateSlug: sanitized.templateSlug,
    title: sanitized.title,
    description: sanitized.description,
    itemCount: sanitized.itemCount,
    decisionCount: sanitized.decisionCount,
    requiresRubrics: sanitized.requiresRubrics,
    stripped: sanitized.stripped,
  };

  if (input.exportOnly === true) return { ok: true, exportedOnly: true, export: info };

  const githubUrl = typeof input.github_url === 'string' ? input.github_url.trim() : '';
  if (!githubUrl) {
    return {
      ok: false,
      status: 400,
      error:
        'github_url required (the public mirror repo the exported dir lives in) — or pass exportOnly to materialize the dir first',
    };
  }
  const parsed = parseGithubRemote(githubUrl);
  if (!parsed) return { ok: false, status: 400, error: `invalid github_url "${githubUrl}"` };
  const meta = await fetchGithubRepoMeta(parsed.owner, parsed.repo);
  if (!meta) {
    return { ok: false, status: 422, error: `could not resolve GitHub repo ${parsed.owner}/${parsed.repo}` };
  }

  const result = await publishListingToCupboard({
    listing_kind: 'plan',
    listing_ref: ref,
    ...(typeof input.project_ref === 'string' ? { project_ref: input.project_ref } : {}),
    github_repository_id: meta.id,
    github_owner: parsed.owner,
    github_name: parsed.repo,
    github_url: meta.html_url || `https://github.com/${parsed.owner}/${parsed.repo}`,
    title: sanitized.title || row.title || ref,
    description: sanitized.description,
    // Omitted entirely when empty: the worker's validator rejects a zero-length
    // array (`array_1_to_200`), so sending `[]` for "declares nothing" would 400.
    ...(sanitized.requiresRubrics.length > 0 ? { requires_rubrics: sanitized.requiresRubrics } : {}),
  });

  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      error: result.error,
      detail: result.detail,
      upstream_status: result.upstream_status,
    };
  }
  return { ok: true, exportedOnly: false, export: info, listing: result.data };
}
