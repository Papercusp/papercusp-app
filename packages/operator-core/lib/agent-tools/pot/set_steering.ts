/**
 * pot:set-steering — the owner's steering write surface for the pot operator
 * (queen-steering-panel-2026-06-15, brief B-01; CONTRACT C-1).
 *
 * Writes the `owner-steering:*` hive_settings (via owner-steering.ts) — a focus
 * directive, the plans the pot operator may pick up NOW (eligibility, DISTINCT from
 * lifecycle status, D-002), and a new-work pause (immediate or until a timestamp).
 * Then it (1) refreshes the 👑 Mug tab (`notifySyncInvalidate('pot.steering')`)
 * and (2) WAKES the pot operator, so a steering change is honoured on its next survey
 * immediately rather than at the next cadence tick. The 👑 Mug tab (B-04) writes
 * through this; the pot operator wake-brief (B-02) reads the same keys via getOwnerSteering.
 *
 * Sibling of `pot:pause` (the other harness:write Pot-control verb). Read twin:
 * `pot:get-steering`.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { resolvePotHomeSlug } from '../../pot/wake';
import { requestUrgentPotWake } from '../../pot/urgent-wake';
import { setOwnerSteering, type OwnerSteeringPatch } from '../../owner-steering';
import { refuseIfMugKettleRetired } from '../_mug-kettle-gate';
import { LIMITS } from '../limits';
import { trackDetached } from '../../detached-imports';

const json = (o: unknown) => ({ data: o });

export default defineTool({
  name: 'pot:set-steering',
  profile: 'engineer',
  description:
    '⛔ RETIRED (D-048): this tool REFUSES while the autonomous pot-operator tier is retired — it wrote steering and then woke that tier, so it is gated as an actuator, not merely stale. Historically it set the owner steering the pot operator read on every wake: a focus `directive`, `eligiblePlans` / `eligiblePots` (what it may pick up + the placement scope NOW), `pauseNewWork`/`pausedUntil`, the P-006 THROTTLE knobs (`cadenceFloorSec`, `maxCups`, `idleActivities`, `autoScaleOut`, `modelTiers`/`tierCeilings`, `decomposition`), the federated Blender priming override `federatedPriming`, and `createWakeSuppressPlans` (EI-13608). Read current steering with pot:get-steering.',
  guidance: {
    when: 'Steering the pot operator from the owner surface — focus it on specific plans, give a directive, or pause new work (incident / cost / review). The 👑 steering tab is the UI for this.',
    notWhen:
      'Freezing the WHOLE pot (all autonomous wakes) — pot:pause. Per-plan lifecycle (draft/ready/shipped) — plans:*. Stopping ONE cup — fleet:drain / fleet:cancel.',
    chaining:
      'pot:set-steering { eligiblePlans:[...], directive:"only these plans" } → the pot operator wakes + honours it next placement. pot:set-steering { pauseNewWork:true } → it drives existing work to terminal then idles. pot:get-steering reads the current state; clear:true resets.',
    seeAlso: [
      'pot:get-steering (read the current steering before changing it)',
      'pot:pause (freeze the whole pot instead of steering the pot operator)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    pot: z
      .string()
      .max(120)
      .optional()
      .describe('Pot home-harness slug (default: ctx harness / PAPERCUSP_POT_HOME_SLUG) — steering is per-pot.'),
    workspace: z.string().max(120).optional().describe('Workspace id (default: ctx / active workspace).'),
    directive: z
      .string()
      .max(LIMITS.BRIEF)
      .nullable()
      .optional()
      .describe(`Free-text directive surfaced in the pot operator wake brief. null or "" clears it. Max ${LIMITS.BRIEF} chars.`),
    eligiblePlans: z
      .array(z.string().min(1).max(200))
      .max(200)
      .optional()
      .describe('Plan slugs the pot operator may pick up NOW (eligibility ≠ lifecycle status). [] = no restriction (default).'),
    eligiblePots: z
      .array(z.string().min(1).max(200))
      .max(500)
      .optional()
      .describe('The placement SCOPE — pot/harness slugs the home operator may place into (→ survey allowedHarnesses). [] = no restriction (default).'),
    includeUnplannedWork: z
      .boolean()
      .optional()
      .describe('Whether plan-LESS ("loose") work-items — those with no source plan — are placed. Default true; false ⇒ the pot operator works ONLY plan-tied items. Independent of eligiblePlans (the "Non-plan work items" toggle).'),
    modelTiers: z
      .array(
        z.object({
          name: z.string().min(1).max(60),
          spec: z.string().min(1).max(120),
          backend: z.string().max(60).optional(),
          when: z.string().max(500).optional(),
        }),
      )
      .nullable()
      .optional()
      .describe('SESSION override of the model-tier menu (weakest→strongest) for the running fleet (D-006). null / [] clears it (use the workspace default).'),
    tierCeilings: z
      .record(z.string(), z.string().max(60))
      .nullable()
      .optional()
      .describe('SESSION override of the per-role tier ceilings (role→tier-name). null / {} clears it. e.g. {"cup":"opus:xhigh"} pins every cup.'),
    cadenceFloorSec: z
      .number()
      .nonnegative()
      .nullable()
      .optional()
      .describe('THROTTLE (P-006): min seconds between operator wakes — effective floor = MAX(system 60s, this). Raises the interval to slow the loop. null / 0 clears it.'),
    maxCups: z
      .number()
      .int()
      .nullable()
      .optional()
      .describe('THROTTLE (P-006): concurrency ceiling — max concurrently-running agents/cups. Effective = MIN(system ceiling, this). null / <1 clears it.'),
    idleActivities: z
      .object({
        gym: z.boolean().optional(),
        scout: z.boolean().optional(),
        curation: z.boolean().optional(),
        'plan-review': z.boolean().optional(),
      })
      .nullable()
      .optional()
      .describe('THROTTLE (P-006): gate idle background activities. Each defaults ON; false suppresses that activity (gym cycles / Blender ideation / doc-curation / operator review-iteration of Blender drafts). null / {} clears it.'),
    autoScaleOut: z
      .boolean()
      .nullable()
      .optional()
      .describe('THROTTLE (P-006): false disables automatic account-pool scale-out on sustained rate-limit exhaustion (manual accounts:scale_out still works). null clears it (⇒ default enabled).'),
    decomposition: z
      .enum(['serial', 'balanced', 'parallel'])
      .nullable()
      .optional()
      .describe('P-009 (ADVISORY): decomposition-aggressiveness hint the pot operator reads in its wake brief — serial ↔ balanced ↔ max-parallel lanes. null clears it (the operator\'s own judgement).'),
    modelOverrides: z
      .record(z.string(), z.string().max(120))
      .nullable()
      .optional()
      .describe('SESSION per-role MODEL override (role→`model[:effort]`) for the FRONT-DOOR agents launched outside the cup:spawn tier path — keys "papercup" (dock TUI) and "kettle" (invoke loop). null / {} clears. e.g. {"papercup":"opus:high","kettle":"sonnet"}. (model-override-sidebar-2026-06-23.)'),
    federatedPriming: z
      .object({
        foreignElites: z.number().int().nonnegative().optional(),
        crowded: z.number().int().nonnegative().optional(),
        empty: z.number().int().nonnegative().optional(),
      })
      .nullable()
      .optional()
      .describe('SESSION Blender federated-priming override: nearby foreign-elites surfaced per ideation cycle plus crowded/empty niche counts for the repulsion map. 0 disables each subsection; null / {} clears it back to the blueprint default.'),
    createWakeSuppressPlans: z
      .array(z.string().min(1).max(200))
      .max(200)
      .optional()
      .describe('EI-13608: plan slugs whose UNASSIGNED work_items:create should NOT wake the pot operator — for a KNOWN cup-forbidden plan (e.g. gated on a live 2-machine rig or an owner decision) that re-homes items unassigned and would otherwise burn a no-op survey+decide cycle per create. Does not affect eligibility/placement. [] clears it (default: no suppression).'),
    pauseNewWork: z
      .boolean()
      .optional()
      .describe('Pause starting NEW work — the pot operator drives existing placements to terminal then idles.'),
    pausedUntil: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .optional()
      .describe('Epoch ms the pause auto-expires at. null = no time-bound pause.'),
    clear: z.boolean().optional().describe('Wipe ALL steering keys back to the default (no restriction).'),
    // .strict() (EI-8285 pattern, as plans:new / cup:spawn): a plain z.object()
    // SILENTLY STRIPS unknown keys, so a stale arg name resolves to `undefined`
    // and this tool then fails with the misleading "Pass `pot` …" no_home_harness
    // error instead of naming the bad key. That is exactly how the hive→pot
    // rename shipped broken: the SPA kept sending `hive:` (stripped) and every
    // Mug-tab steering write silently failed. Strict turns that into a loud
    // invalid_args at the point of the typo.
  }).strict(),
  async handler(args, ctx) {
    // D-048 ruled this TIER, from its own guidance: "Steering the pot operator from the
    // owner surface … The 👑 Mug tab is the UI for this". This is the ONE of the
    // four that is a true ACTUATOR under the D-017 scope rule — it WRITES
    // (setOwnerSteering) and then calls requestUrgentPotWake, i.e. it can arm a
    // wake on a tier the owner retired. So this gate is harm-prevention, not
    // merely refusing to advertise a dead surface.
    const retired = await refuseIfMugKettleRetired(
      'steer the pot operator',
      'Drive the app with an su session (GOAL mode) instead.',
    );
    if (retired) return retired;
    const workspaceId = resolveConcreteWorkspaceId(args.workspace, ctx.workspaceId, ctx.principal?.workspaceId);
    const installSlug = resolvePotHomeSlug(args.pot, ctx.harnessSlug ?? undefined);
    if (!installSlug) {
      return json({
        ok: false,
        error: 'no_home_harness',
        message: 'Pass `pot` (or set PAPERCUSP_POT_HOME_SLUG) — steering is per-pot.',
      });
    }
    const patch: OwnerSteeringPatch = {};
    if (args.directive !== undefined) patch.directive = args.directive;
    if (args.eligiblePlans !== undefined) patch.eligiblePlans = args.eligiblePlans;
    if (args.eligiblePots !== undefined) patch.eligibleHives = args.eligiblePots;
    if (args.includeUnplannedWork !== undefined) patch.includeUnplannedWork = args.includeUnplannedWork;
    if (args.modelTiers !== undefined) patch.modelTiers = args.modelTiers;
    if (args.tierCeilings !== undefined) patch.tierCeilings = args.tierCeilings;
    if (args.cadenceFloorSec !== undefined) patch.cadenceFloorSec = args.cadenceFloorSec;
    if (args.maxCups !== undefined) patch.maxBees = args.maxCups;
    if (args.idleActivities !== undefined) patch.idleActivities = args.idleActivities;
    if (args.autoScaleOut !== undefined) patch.autoScaleOut = args.autoScaleOut;
    if (args.decomposition !== undefined) patch.decomposition = args.decomposition;
    if (args.modelOverrides !== undefined) patch.modelOverrides = args.modelOverrides;
    if (args.federatedPriming !== undefined) patch.federatedPriming = args.federatedPriming;
    if (args.createWakeSuppressPlans !== undefined) patch.createWakeSuppressPlans = args.createWakeSuppressPlans;
    if (args.pauseNewWork !== undefined) patch.pauseNewWork = args.pauseNewWork;
    if (args.pausedUntil !== undefined) patch.pausedUntil = args.pausedUntil;
    if (args.clear !== undefined) patch.clear = args.clear;

    let steering;
    try {
      steering = await setOwnerSteering(workspaceId, installSlug, patch);
    } catch (e) {
      // setPotSetting rejects when the pot doesn't exist (logical scope, no FK).
      return json({ ok: false, error: e instanceof Error ? e.message : String(e), pot: installSlug });
    }

    // Materialize the Papercup's session model override to the file the dock's
    // psu-papercup wrapper reads at launch (~/.papercusp/papercup-model) — the
    // storage-policy "PG-canonical, file projected just-in-time" pattern (the bash
    // wrapper can't read hive_settings). The dock is volatile (relaunches on its
    // own), so the next relaunch picks up the new model. Best-effort.
    void trackDetached(import('../../sentinel-model-file'))
      .then(({ materializeSentinelModelFile }) =>
        materializeSentinelModelFile(steering.modelOverrides?.papercup ?? null),
      )
      .catch(() => {});

    // Refresh the 👑 Mug tab (pot.steering resolver) — best-effort.
    void trackDetached(import('../../sync-sse'))
      .then(({ notifySyncInvalidate }) => notifySyncInvalidate('pot.steering', {}))
      .catch(() => {});

    // Wake the pot operator so the new steering is honoured on its next survey now, not at
    // the next cadence tick. Fire-and-forget (the wake reports, never throws).
    const wake = await requestUrgentPotWake({
      reason: 'owner steering updated',
      harness: installSlug,
      workspaceId,
    }).catch(() => null);

    return json({ ok: true, pot: installSlug, steering, mugWoken: wake?.fired ?? false });
  },
});
