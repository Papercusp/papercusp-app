/**
 * pot-scope.ts — the ONE way a learning writer resolves the pot its row belongs to.
 *
 * ⚠ ATTRIBUTION, not permission. "May learning RUN for this pot at all" is a
 * different question with a different store — see ./pot-gate/ (the per-pot
 * learning gate over harness_shared.learning_pot_scope, plan
 * learning-pot-scope-gate-2026-08-30 D-001). A lane typically uses both:
 * resolve the pot here, then ask the gate whether that pot is switched on.
 *
 * Plan `pot-scope-all-learnings-2026-07-26`, P-002.
 * [owner 2026-07-25 interactive, verbatim] "THERE SHOULD BE NO WORKSPACE
 * SCOPED LEARNINGS. FIX THAT. ALL LEARNINGS SHOULD BE SCOPED TO A POT."
 *
 * ## Why this exists as a shared seam rather than inline in each store
 *
 * The learning stores were pot-less in three different ways, and each had its own
 * ad-hoc idea of scope: some carried `workspace_id` only, `code_recipes` carried
 * NOTHING, and the governor keyed its budgets by workspace (`blender:<workspace>`).
 * Measured 2026-07-25: `calibration_predictions` had 601 rows and 0 with a pot,
 * `scout_ticks` 208/2271, `code_recipe_runs` 2176/7371 — i.e. even where the column
 * already existed the writers mostly did not populate it. Eight call sites each
 * re-deriving "which pot is this?" is exactly how that drift happened, so the
 * derivation lives here once and the stores call it.
 *
 * ## The resolution order (deliberate)
 *
 *   1. An EXPLICIT `potSlug` from the caller — it knows best; never second-guessed.
 *   2. The pot that OWNS the given harness (`potHomeSlugForHarness`) — the harness
 *      is the member sub-grain, the pot/hive is the tenancy unit (owner's model).
 *      A hive HOME resolves to itself HERE (the registry/identity read recognizes
 *      it) — there is deliberately NO "the harness is its own scope" fallback
 *      below this step: live scout_ticks data (2026-07-26) showed that fallback
 *      minting fake pots out of the '@singleton' workspace-brain sentinel and
 *      ephemeral 'capacity-storm-*' drill installs. A slug the registry does not
 *      recognize as pot-owned is NOT a pot.
 *   3. A WORKSPACE-GLOBAL label ('@singleton', 'operator', the workspace id — the
 *      workspace-brain grain) homes to the workspace PLATFORM pot, mirroring
 *      resolveWorkItemPot (pot-membership.ts): the owner's ratified model is that
 *      operator-level provenance and the platform pot are the same product, so a
 *      workspace-brain learning is a platform-pot learning, not a pot-less one.
 *      Guarded by an existence check through the same registry step — a workspace
 *      with no platform pot falls through (fail-open), never invents one.
 *   4. The process's home pot env (`PAPERCUSP_POT_HOME_SLUG`) — set for pot-scoped
 *      hosts and agent subprocesses.
 *   5. `null` — and null is a REAL answer, not a failure to paper over.
 *
 * ## Why null is returned rather than a fallback slug
 *
 * The tempting fourth step is "…else the home pot". That is precisely the bug class
 * this plan exists to remove: a wrong-but-plausible default is indistinguishable
 * from a correct attribution once written, and it silently re-creates cross-tenant
 * data (WI-5809: a read-side version of the same instinct showed one pot's gym
 * experiments under another pot's lens). A genuinely context-less system writer
 * should record `null` and be EXCLUDED from every pot lens (D-002, owner-ratified),
 * not be misfiled into someone's pot.
 */
import { potHomeSlugForHarness } from '../hive-federation';
import { isWorkspaceGlobalLabel, PLATFORM_POT_SLUG } from '../pot-membership';

export interface LearningPotScopeInput {
  workspaceId: string;
  /** An explicit pot/hive slug from the caller — wins outright when present. */
  potSlug?: string | null;
  /** The harness the work ran under; resolved to its owning pot when no explicit slug. */
  harnessSlug?: string | null;
  /** Forwarded to the registry read for a correctness-critical cross-process resolve. */
  fresh?: boolean;
  /**
   * Test/composition seam for step 2's registry read (defaults to
   * potHomeSlugForHarness). Injecting here keeps the RESOLUTION ORDER in one
   * place while a hermetic unit test still controls the only IO step.
   */
  resolveHive?: (workspaceId: string, harnessSlug: string) => Promise<string | null>;
}

/** Trim to a non-empty slug, or undefined. */
function clean(v: string | null | undefined): string | undefined {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s : undefined;
}

/**
 * Resolve the pot a learning row belongs to. Returns `null` when the caller has no
 * resolvable pot — see the module doc for why that is a real answer and not a bug.
 * Never throws: a registry read failure degrades to the env/home step, because a
 * learning write must not be lost to a scope lookup.
 */
export async function resolveLearningPotSlug(input: LearningPotScopeInput): Promise<string | null> {
  const explicit = clean(input.potSlug);
  if (explicit) return explicit;

  const resolveHive = async (workspaceId: string, slug: string): Promise<string | undefined> => {
    try {
      return clean(
        input.resolveHive
          ? await input.resolveHive(workspaceId, slug)
          : await potHomeSlugForHarness(workspaceId, slug, input.fresh ? { fresh: true } : undefined),
      );
    } catch {
      // Registry unavailable (sidecar/test process with no org-PG) — fall through
      // to the later steps. A hive home passed here still resolves to itself in
      // any process where the registry answers (potHomeSlugForHarness returns the
      // home for its own slug); degrading to env/null beats minting a fake pot
      // out of a sentinel or drill install (see the module doc's step 2).
      return undefined;
    }
  };

  const harness = clean(input.harnessSlug);
  if (harness && !isWorkspaceGlobalLabel(harness, input.workspaceId)) {
    const owner = await resolveHive(input.workspaceId, harness);
    if (owner) return owner;
  }

  // Step 3: workspace-global provenance (the workspace-brain grain, or a harness
  // the registry does not place in any pot) homes to the PLATFORM pot when that
  // pot exists in this workspace — the resolveWorkItemPot model. The existence
  // check rides the same (injectable) registry step: a platform pot's home slug
  // resolves to itself.
  const platform = await resolveHive(input.workspaceId, PLATFORM_POT_SLUG);
  if (platform) return platform;

  return clean(process.env.PAPERCUSP_POT_HOME_SLUG) ?? null;
}

/**
 * P-006's runtime companion: the tables that MUST carry a pot once P-002 is live.
 * The guard test asserts every one of these has the column AND that new rows carry
 * it, so a future writer cannot quietly reintroduce a workspace-scoped learning.
 */
export const POT_SCOPED_LEARNING_TABLES = [
  'harness_shared.transfer_lessons',
  'harness_shared.prompt_ablation_runs',
  'harness_shared.code_recipes',
  'harness_shared.code_recipe_runs',
  'harness_shared.calibration_predictions',
  'harness_shared.scout_ticks',
  'harness_shared.learning_governor_loops',
  'harness_shared.learning_spend_events',
] as const;
