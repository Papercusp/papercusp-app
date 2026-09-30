/**
 * install-goal-io — the REAL (network + git + rubric gate + goal-stub seed)
 * wiring for installing a Cupboard goal package
 * (work-on-everything-goal-2026-08-23 P-006, D-002).
 *
 * Three steps, in this order, and the order is the design (mirrors
 * install-plan-io exactly for steps 1–2):
 *
 *   1. GATE — `harness` first (a goal is filed against an install_slug, so a
 *      seed without one is doomed; refusing before the clone beats refusing
 *      after a dir landed), then `requires_rubrics` BEFORE anything is
 *      downloaded: a goal package whose acceptance class this workspace cannot
 *      grade against installs "successfully" and then fails much later, in a
 *      place that never mentions the install.
 *   2. PLACE the dir (install-goal-core → the generic self-describing installer).
 *   3. SEED an INACTIVE STUB, NO-CLOBBER — after validating the package's IO
 *      schemas compile and its launchSettings parse (refuse, don't degrade: a
 *      stub seeded with an uncompilable schema reads as configured while
 *      binding nothing).
 *
 * WHY THE SEEDED ROW IS `status: 'paused'` AND NEVER ACTIVE (D-002: install ≠
 * start). GOAL_STATUSES has no 'draft', and D-001 forbids minting one for this
 * — 'paused' IS the deliberate-hold status: `activity.ts` skips liveness for
 * it (no quiet-unexpectedly alarm for a stub nobody has started), the stop
 * fan-out semantics already fit, and the pause RECORD (stampGoalPause) says
 * exactly who parked it and why. NO agent identity is minted, NOTHING is
 * spawned, no spend can accrue. Starting it is a separate deliberate act
 * (P-017's door — not built here).
 *
 * NO-CLOBBER is on PACKAGE IDENTITY, not title: the stub is stamped
 * `metadata.goalPackageRef = <ref>`, and a re-install finding ANY goal (any
 * status) carrying that stamp reports `seeded: false, 'exists'` rather than
 * minting a duplicate pursuit of the same packaged duty (D-002 rule 2).
 */
import {
  installGoalFromCupboardCore,
  InstallGoalError,
  type InstallGoalCoreResult,
} from './install-goal-core';
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
import type { LocalGoalPackage } from './goal-package-store';
import { isCompilableSchema } from '../json-schema-validation';
import { goalLaunchSettingsSchema } from '../goal-launch-settings';
import type { GoalSqlTag } from '@papercusp/agent-mcp/goals';

export interface InstallGoalFromCupboardInput {
  /** Resolve the mirror repo URL + listing_ref (and requires_rubrics) from the listing. */
  listingId?: string;
  /** OR install a mirror repo directly (listingRef = the package subdir). */
  githubUrl?: string;
  listingRef?: string;
  /** Accept the co-install of required rubrics this workspace does not have yet. */
  installRequiredRubrics?: boolean;
  /** Skip the goal-stub seed — the dir is placed and nothing else. */
  skipSeed?: boolean;
  /** The install_slug the stub is filed against. REQUIRED unless skipSeed —
   *  goals are filed against an install_slug (goal-auto-start.ts's rule). */
  harness?: string;
}

export interface InstallGoalOutcome extends InstallGoalCoreResult {
  /** The resolved rubric-dependency verdict, always reported. */
  rubrics: RubricRequirementsVerdict;
  /** Rubric refs co-installed as part of this install. */
  coInstalled: string[];
  /** Whether an INACTIVE goal stub was created in this workspace. */
  seeded: boolean;
  /** The seeded stub's goal id, when seeded. */
  goalId?: string;
  /** Why the seed did not happen: 'exists' (no-clobber) | 'skipped' | an error string. */
  seedSkipped?: string;
}

export type InstallGoalFromCupboardResult =
  | { ok: true; result: InstallGoalOutcome }
  | {
      ok: false;
      status: number;
      error: string;
      detail?: string;
      /** Present on a rubric-gate refusal so the caller can render the offer. */
      rubrics?: RubricRequirementsVerdict;
    };

/** Seed one INACTIVE goal stub, no-clobber on package identity. Injected so
 *  the install path is testable without a live Postgres. */
export type GoalStubSeeder = (args: {
  pkg: LocalGoalPackage;
  ref: string;
  harness: string;
}) => Promise<{ seeded: boolean; reason?: string; goalId?: string }>;

async function defaultGoalStubSeeder({
  pkg,
  ref,
  harness,
}: {
  pkg: LocalGoalPackage;
  ref: string;
  harness: string;
}): Promise<{ seeded: boolean; reason?: string; goalId?: string }> {
  const [{ goalId, insertGoalRow }, { stampGoalPause }, { getOrgPg }, { activeWorkspaceId }] =
    await Promise.all([
      import('@papercusp/agent-mcp/goals'),
      import('@papercusp/agent-mcp/goal-pause'),
      import('@papercusp/db-org'),
      import('../workspace-registry'),
    ]);
  const workspaceId = activeWorkspaceId();
  if (!workspaceId) return { seeded: false, reason: 'no concrete workspace in scope' };
  const pg = getOrgPg().sql;
  const sql = pg as unknown as GoalSqlTag;

  // NO-CLOBBER on package identity (D-002 rule 2): ANY goal carrying this
  // package stamp — whatever its status — wins over a re-install.
  const existing = await sql<{ id: string }[]>`
    SELECT id FROM harness_shared.goals
     WHERE workspace_id = ${workspaceId}
       AND metadata->>'goalPackageRef' = ${ref}
     LIMIT 1
  `;
  if (existing.length > 0) return { seeded: false, reason: 'exists' };

  // Typed property declarations (P-025): ensure the first-party datatype(s)
  // exist (insert-if-absent — a fresh workspace has never declared any), then
  // validate the declaration. REFUSE the seed rather than landing a stub whose
  // declared properties could never be checked at write time (the same
  // refuse-don't-degrade rule the IO-schema gate holds).
  if (pkg.propertySchema && Object.keys(pkg.propertySchema).length > 0) {
    const [{ ensurePlanRefListDatatype }, { validatePropertySchemaDeclaration }] =
      await Promise.all([
        import('../goals/package-property-datatypes'),
        import('../typed-properties-db'),
      ]);
    await ensurePlanRefListDatatype(pg, workspaceId);
    const check = await validatePropertySchemaDeclaration(pg, workspaceId, pkg.propertySchema);
    if (!check.ok) {
      return { seeded: false, reason: `propertySchema invalid: ${check.issues.join('; ')}` };
    }
  }

  const criterion = pkg.killCriterion?.trim();
  if (criterion) {
    const { killCriterionProblem } = await import('../goals/kill-criterion');
    const problem = killCriterionProblem(criterion);
    if (problem) return { seeded: false, reason: `killCriterion invalid: ${problem}` };
  }

  // EVERY goal carries the canonical `worklist` declaration — including a
  // package that declares no properties of its own, which would otherwise land
  // with property_schema '{}' and hit the same dead end as an ad-hoc goal (the
  // gate above only runs when the package declared something). Non-destructive:
  // a package that declares `worklist` itself keeps its own declaration.
  const { withCanonicalWorklistDeclaration } = await import('../goals/package-property-datatypes');
  const seededPropertySchema = withCanonicalWorklistDeclaration(pkg.propertySchema ?? null);

  const id = goalId(pkg.title);
  await insertGoalRow(sql, {
    id,
    installSlug: harness,
    workspaceId,
    title: pkg.title,
    body: pkg.body,
    standing: pkg.standing,
    killCriterion: pkg.killCriterion,
    tripwires: pkg.tripwires ?? null,
    budgetCents: pkg.budgetCents,
    budgetWindowSec: pkg.budgetWindowSec,
    launchSettings: pkg.launchSettings,
    inputSchema: pkg.inputSchema,
    // `inputs` deliberately NOT written: per-instance provenance (P-021),
    // resolved at start time, never shipped in a package.
    outputSchema: pkg.outputSchema,
    propertySchema: seededPropertySchema,
    status: 'paused',
    metadata: stampGoalPause(
      { installedFrom: 'cupboard', goalPackageRef: ref, packageVersion: pkg.version },
      {
        reason: 'installed from Cupboard as an inactive stub — starting it is a separate deliberate act',
        pausedBy: 'cupboard:install-goal',
      },
    ),
  });
  return { seeded: true, goalId: id };
}

/** Refuse a stub whose declared contracts would read as configured while
 *  binding nothing (refuse, don't degrade). Exported for the update door
 *  (goals/package-update.ts, P-018), which must hold the SAME gate: an
 *  accepted update may not write a contract the installer would refuse. */
export function goalPackageContractProblem(pkg: LocalGoalPackage): string | null {
  if (pkg.inputSchema && !isCompilableSchema(pkg.inputSchema)) {
    return "the package's inputSchema does not compile as a JSON Schema";
  }
  if (pkg.outputSchema && !isCompilableSchema(pkg.outputSchema)) {
    return "the package's outputSchema does not compile as a JSON Schema";
  }
  if (pkg.launchSettings) {
    const parsed = goalLaunchSettingsSchema.safeParse(pkg.launchSettings);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return `the package's launchSettings are invalid${first ? `: ${first.path.join('.')} ${first.message}` : ''}`;
    }
  }
  return null;
}

/**
 * The ONE orchestrated path that installs a goal package from the Cupboard by
 * listing id OR direct github url, gates its rubric dependencies, and seeds an
 * inactive stub.
 */
export async function installGoalFromCupboard(
  input: InstallGoalFromCupboardInput,
  deps: {
    rubricDeps?: RubricRequirementDeps;
    seedGoalStub?: GoalStubSeeder;
    installRubric?: (listing: { listingId?: string; githubUrl: string; ref: string }) => Promise<boolean>;
  } = {},
): Promise<InstallGoalFromCupboardResult> {
  let githubUrl = typeof input.githubUrl === 'string' ? input.githubUrl.trim() : '';
  let listingRef = typeof input.listingRef === 'string' ? input.listingRef.trim() : '';
  let declared: RubricRequirement[] = [];
  // The Worker's publish-time content pin (P-002): present ⇒ the install fetches
  // exactly that commit and refuses content-address-mismatch. Only a listing carries
  // one; a direct githubUrl install is an unverified tip clone by construction.
  let pin: ContentPinRef | undefined;

  // ── 1a. The harness gate — before ANY network or disk work. ────────────────
  const harness = typeof input.harness === 'string' ? input.harness.trim() : '';
  if (input.skipSeed !== true && !harness) {
    return {
      ok: false,
      status: 400,
      error:
        'harness required (the install_slug the goal stub is filed against) — or pass skipSeed to place the dir only',
    };
  }

  if (input.listingId) {
    const resolved = await resolveListingByKind(String(input.listingId), 'goal');
    if ('error' in resolved) return { ok: false, status: resolved.status, error: resolved.error };
    if (!githubUrl) githubUrl = resolved.githubUrl;
    if (!listingRef) listingRef = resolved.ref;
    pin = resolved.pin;
    declared = parseRequiredRubrics(resolved.requiresRubrics);
  }
  if (!githubUrl) return { ok: false, status: 400, error: 'githubUrl or listingId required' };
  if (!listingRef) {
    return { ok: false, status: 400, error: 'listingRef required (the goal package subdir)' };
  }

  // ── 1b. The rubric gate, before anything touches the disk. ─────────────────
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
    // Re-resolve so the reported verdict describes the workspace as it now IS.
    verdict = await resolveRubricRequirements(declared, rubricDeps);
    const after = rubricGateRefusal(verdict, { acceptCoInstall: true });
    if (after) {
      return { ok: false, status: after.status, error: after.error, detail: after.detail, rubrics: verdict };
    }
  }

  // ── 2. Place the dir. ───────────────────────────────────────────────────────
  let result: InstallGoalCoreResult;
  try {
    result = await installGoalFromCupboardCore(
      { githubUrl, listingRef, pin },
      cupboardGitDeps(),
    );
  } catch (e) {
    if (e instanceof InstallGoalError) return { ok: false, status: e.status, error: e.message };
    return {
      ok: false,
      status: 500,
      error: 'install failed',
      detail: e instanceof Error ? e.message.slice(0, 300) : String(e),
    };
  }

  // ── 3. Seed the INACTIVE stub (no-clobber), after validating contracts. ────
  if (input.skipSeed === true) {
    return {
      ok: true,
      result: { ...result, rubrics: verdict, coInstalled, seeded: false, seedSkipped: 'skipped' },
    };
  }

  const problem = goalPackageContractProblem(result.pkg);
  if (problem) {
    // The dir is placed (it is the re-seedable source and harmless on its own),
    // but the install REFUSES rather than seeding a stub whose declared
    // contracts cannot bind.
    return { ok: false, status: 422, error: problem, rubrics: verdict };
  }

  const seeder = deps.seedGoalStub ?? defaultGoalStubSeeder;
  try {
    const seed = await seeder({ pkg: result.pkg, ref: result.ref, harness });
    return {
      ok: true,
      result: {
        ...result,
        rubrics: verdict,
        coInstalled,
        seeded: seed.seeded,
        ...(seed.goalId ? { goalId: seed.goalId } : {}),
        ...(seed.reason ? { seedSkipped: seed.reason } : {}),
      },
    };
  } catch (e) {
    // A seed failure does NOT fail the install: the dir is correctly placed and
    // is the re-seedable source of truth. But it MUST be reported — until it
    // succeeds the package is on disk and no stub exists.
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
