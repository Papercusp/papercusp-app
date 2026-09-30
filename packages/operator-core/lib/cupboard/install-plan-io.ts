/**
 * install-plan-io — the REAL (network + git + rubric gate + plan seed) wiring for
 * installing a Cupboard plan template
 * (cupboard-plan-rubric-recipe-sharing-2026-08-21 P-010 + P-011).
 *
 * Three steps, in this order, and the order is the design:
 *
 *   1. GATE on `requires_rubrics` BEFORE anything is downloaded (P-011). A plan
 *      template whose acceptance class this workspace cannot grade against installs
 *      "successfully" and then fails at its ship gate — much later, in a place that
 *      never mentions the install. Resolving first turns that into a refusal at the
 *      moment of choice, naming the co-install that fixes it. Gating BEFORE the clone
 *      (not after) is deliberate: a refusal that has already written to the user layer
 *      leaves a template on disk the workspace was just told it cannot use.
 *   2. PLACE the dir (install-plan-core → the generic self-describing installer).
 *   3. SEED a plan TEMPLATE row, NO-CLOBBER. An existing plan of that slug always
 *      wins; the install reports `seeded: false, seedSkipped: 'exists'` rather than
 *      overwriting live work with a stranger's template. That asymmetry is the same
 *      one the rubric seed makes, for the same reason.
 *
 * WHY THE SEEDED ROW IS `status: draft` AND NEVER ACTIVE
 * ------------------------------------------------------
 * "An installed plan lands as a TEMPLATE, never a live plan." A draft plan carries no
 * claimable items into the scheduler, mints no work-items, and is excluded from the
 * lifecycle legs that treat `active` as work in flight — so installing cannot inject
 * another workspace's item DAG into this one's queue. Instantiating it is a separate,
 * explicit act through the existing plans machinery.
 */
import {
  installPlanFromCupboardCore,
  InstallPlanError,
  type InstallPlanCoreResult,
} from './install-plan-core';
import { cupboardGitDeps } from './install-io';
import type { ContentPinRef } from './install-self-describing-core';
import { resolveListingByKind } from './resolve-listing-by-kind';
import { parseRequiredRubrics, type RubricRequirement } from './types';
import {
  resolveRubricRequirements,
  rubricGateRefusal,
  defaultRubricRequirementDeps,
  type RubricRequirementDeps,
  type RubricRequirementsVerdict,
} from './rubric-requirements';

export interface InstallPlanFromCupboardInput {
  /** Resolve the mirror repo URL + listing_ref (and requires_rubrics) from the listing. */
  listingId?: string;
  /** OR install a mirror repo directly (listingRef = the template subdir). */
  githubUrl?: string;
  listingRef?: string;
  /** Accept the co-install of required rubrics this workspace does not have yet.
   *  Without it, a resolvable-but-missing requirement REFUSES rather than silently
   *  pulling extra units into the workspace. */
  installRequiredRubrics?: boolean;
  /** Skip the plan-row seed — the dir is placed and nothing else. For callers that
   *  will seed themselves, and for tests. */
  skipSeed?: boolean;
  /** Harness scope for the seeded plan row (defaults to the caller's resolved scope). */
  harness?: string;
}

export interface InstallPlanOutcome extends InstallPlanCoreResult {
  /** The resolved rubric-dependency verdict (P-011), always reported — a satisfied
   *  declaration is as worth showing as a blocking one, since it is the evidence the
   *  gate actually ran. */
  rubrics: RubricRequirementsVerdict;
  /** Rubric refs co-installed as part of this install. */
  coInstalled: string[];
  /** Whether the plan TEMPLATE row was created in this workspace. */
  seeded: boolean;
  /** Why the seed did not happen: 'exists' (no-clobber) | 'skipped' | an error string. */
  seedSkipped?: string;
}

export type InstallPlanFromCupboardResult =
  | { ok: true; result: InstallPlanOutcome }
  | {
      ok: false;
      status: number;
      error: string;
      detail?: string;
      /** Present on a rubric-gate refusal so the caller can render the offer. */
      rubrics?: RubricRequirementsVerdict;
    };

/** Seed one plan TEMPLATE row, no-clobber. Injected so the install path is testable
 *  without a live Postgres. */
export type PlanTemplateSeeder = (args: {
  slug: string;
  markdown: string;
  harness: string | undefined;
}) => Promise<{ seeded: boolean; reason?: string }>;

async function defaultPlanTemplateSeeder({
  slug,
  markdown,
  harness,
}: {
  slug: string;
  markdown: string;
  harness: string | undefined;
}): Promise<{ seeded: boolean; reason?: string }> {
  const { withPlanLock } = await import('../agent-tools/plans/with-plan-lock');
  const result = await withPlanLock<{ seeded: boolean; reason?: string }>(
    null,
    { slug, intent: `cupboard:install-plan ${slug}`, ...(harness ? { harnessSlug: harness } : {}) },
    async (current) => {
      // NO-CLOBBER: an existing plan of this slug is this workspace's own work (or an
      // earlier install someone has since edited). Never overwrite it — the whole
      // point of the two-step is that the dir on disk stays the re-seedable source.
      if (current !== null) return { newBody: null, value: { seeded: false, reason: 'exists' } };
      return { newBody: markdown, value: { seeded: true } };
    },
  );
  if (result.kind === 'busy') return { seeded: false, reason: 'busy' };
  return result.value;
}

/**
 * The ONE orchestrated path that installs a plan template from the Cupboard by
 * listing id OR direct github url, gates its rubric dependencies, and seeds it.
 */
export async function installPlanFromCupboard(
  input: InstallPlanFromCupboardInput,
  deps: {
    rubricDeps?: RubricRequirementDeps;
    seedPlanTemplate?: PlanTemplateSeeder;
    installRubric?: (listing: { listingId?: string; githubUrl: string; ref: string }) => Promise<boolean>;
  } = {},
): Promise<InstallPlanFromCupboardResult> {
  let githubUrl = typeof input.githubUrl === 'string' ? input.githubUrl.trim() : '';
  let listingRef = typeof input.listingRef === 'string' ? input.listingRef.trim() : '';
  let declared: RubricRequirement[] = [];
  // The Worker's publish-time content pin (P-002): present ⇒ the install fetches
  // exactly that commit and refuses content-address-mismatch. Only a listing carries
  // one; a direct githubUrl install is an unverified tip clone by construction.
  let pin: ContentPinRef | undefined;

  if (input.listingId) {
    const resolved = await resolveListingByKind(String(input.listingId), 'plan');
    if ('error' in resolved) return { ok: false, status: resolved.status, error: resolved.error };
    if (!githubUrl) githubUrl = resolved.githubUrl;
    if (!listingRef) listingRef = resolved.ref;
    pin = resolved.pin;
    declared = parseRequiredRubrics(resolved.requiresRubrics);
  }
  if (!githubUrl) return { ok: false, status: 400, error: 'githubUrl or listingId required' };
  if (!listingRef) {
    return { ok: false, status: 400, error: 'listingRef required (the plan template subdir)' };
  }

  // ── 1. The rubric gate (P-011), before anything touches the disk. ──────────────
  const rubricDeps = deps.rubricDeps ?? defaultRubricRequirementDeps();
  let verdict = await resolveRubricRequirements(declared, rubricDeps);
  const refusal = rubricGateRefusal(verdict, {
    acceptCoInstall: input.installRequiredRubrics === true,
  });
  if (refusal) {
    return { ok: false, status: refusal.status, error: refusal.error, detail: refusal.detail, rubrics: verdict };
  }

  const coInstalled: string[] = [];
  if (input.installRequiredRubrics === true && verdict.coInstall.length > 0) {
    const installRubric = deps.installRubric ?? defaultRubricCoInstaller;
    for (const entry of verdict.requirements) {
      if (entry.state !== 'installable' || entry.optional || !entry.listing) continue;
      if (await installRubric(entry.listing)) coInstalled.push(entry.rubricRef);
    }
    // Re-resolve so the reported verdict describes the workspace as it now IS, not as
    // it was before the co-installs. A stale verdict here would claim a requirement is
    // still missing right after satisfying it.
    verdict = await resolveRubricRequirements(declared, rubricDeps);
    const after = rubricGateRefusal(verdict, { acceptCoInstall: true });
    if (after) {
      return { ok: false, status: after.status, error: after.error, detail: after.detail, rubrics: verdict };
    }
  }

  // ── 2. Place the dir. ─────────────────────────────────────────────────────────
  let result: InstallPlanCoreResult;
  try {
    result = await installPlanFromCupboardCore(
      { githubUrl, listingRef, pin },
      cupboardGitDeps(),
    );
  } catch (e) {
    if (e instanceof InstallPlanError) return { ok: false, status: e.status, error: e.message };
    return {
      ok: false,
      status: 500,
      error: 'install failed',
      detail: e instanceof Error ? e.message.slice(0, 300) : String(e),
    };
  }

  // ── 3. Seed the plan TEMPLATE row (no-clobber). ───────────────────────────────
  if (input.skipSeed === true) {
    return {
      ok: true,
      result: { ...result, rubrics: verdict, coInstalled, seeded: false, seedSkipped: 'skipped' },
    };
  }
  const seeder = deps.seedPlanTemplate ?? defaultPlanTemplateSeeder;
  try {
    const seed = await seeder({
      slug: result.templateSlug,
      markdown: result.markdown,
      harness: input.harness,
    });
    return {
      ok: true,
      result: {
        ...result,
        rubrics: verdict,
        coInstalled,
        seeded: seed.seeded,
        ...(seed.reason ? { seedSkipped: seed.reason } : {}),
      },
    };
  } catch (e) {
    // A seed failure does NOT fail the install: the dir is correctly placed and is the
    // re-seedable source of truth. But it MUST be reported — until it succeeds the
    // template is on disk and invisible to plans:list.
    return {
      ok: true,
      result: {
        ...result,
        rubrics: verdict,
        coInstalled,
        seeded: false,
        seedSkipped: e instanceof Error ? e.message.slice(0, 300) : String(e),
      },
    };
  }
}

/** Real co-install of one required rubric — the same path `cupboard:install-rubric`
 *  runs, so no-clobber and the post-install seed apply unchanged. */
async function defaultRubricCoInstaller(listing: {
  listingId?: string;
  githubUrl: string;
  ref: string;
}): Promise<boolean> {
  try {
    const { installRubricFromCupboard } = await import('./install-rubric-io');
    const r = await installRubricFromCupboard({
      githubUrl: listing.githubUrl,
      listingRef: listing.ref,
    });
    return r.ok;
  } catch {
    return false;
  }
}
