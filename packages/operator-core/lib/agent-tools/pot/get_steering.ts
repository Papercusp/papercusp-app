/**
 * pot:get-steering — read the owner's steering controls for the Mug
 * (queen-steering-panel-2026-06-15, brief B-01; CONTRACT C-1).
 *
 * The agent-surface READ twin of `pot:set-steering`: returns the decoded
 * {@link OwnerSteering} (directive, eligible plans, pause state) the Mug reads on
 * every wake. The 👑 Mug tab reads via the `pot.steering` sync resolver; this is
 * the equivalent for an agent / a quick check.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { resolvePotHomeSlug } from '../../pot/wake';
import {
  getOwnerSteering,
  steeringLooksInconsistent,
  steeringModelSpecDrift,
  steeringUnpricedModelSpecs,
} from '../../owner-steering';
import { MUG_KETTLE_RETIRED_ERROR } from '../_mug-kettle-gate';
import { mugKettleSystemEnabled } from '../../pot/started';
import { DEFAULT_MODEL_TIERS, type ModelTier } from '../../agent-config-constants';

const json = (o: unknown) => ({ data: o });

export default defineTool({
  name: 'pot:get-steering',
  profile: 'engineer',
  description:
    'Read the current owner steering for the pot — the focus `directive`, `eligiblePlans` (plans the pot operator may pick up now), and pause state (`pauseNewWork` / `pausedUntil`) the pot operator reads on every wake. An un-steered pot returns the default (no directive, no plan restriction, not paused). Also returns `inconsistent: true` (EI-8277) when the directive text reads like the pause was lifted but `pauseNewWork` is still true — a drift nothing else catches; reconcile with pot:set-steering if the owner meant to resume. Also returns `modelSpecDrift: string[]` (EI-12807) — model specs this pot pins via `modelTiers`/`modelOverrides` that are NO LONGER in the committed tier menu (a global tier-menu fix removed them, but the per-pot override still wins, so spawns die on "model unavailable"); non-empty ⇒ reconcile via pot:set-steering { modelTiers:null, modelOverrides:null }. The READ twin of pot:set-steering.',
  guidance: {
    when: 'Checking what the pot operator is currently steered toward — before changing it, or to confirm a pot:set-steering write landed.',
    notWhen: 'Changing steering — pot:set-steering. Reading the whole pot status — pot:status.',
    seeAlso: [
      'pot:set-steering (change the steering directive)',
      'pot:status (the whole pot status, not just steering)',
    ],
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    pot: z
      .string()
      .max(120)
      .optional()
      .describe('Pot home-harness slug (default: ctx harness / PAPERCUSP_POT_HOME_SLUG).'),
    workspace: z.string().max(120).optional().describe('Workspace id (default: ctx / active workspace).'),
    // .strict() — see the twin note in set_steering.ts (EI-8285 pattern): an
    // unknown key (e.g. the pre-rename `hive`) must fail loudly, not be stripped
    // into a misleading no_home_harness error.
  }).strict(),
  async handler(args, ctx) {
    const workspaceId = resolveConcreteWorkspaceId(args.workspace, ctx.workspaceId, ctx.principal?.workspaceId);
    const installSlug = resolvePotHomeSlug(args.pot, ctx.harnessSlug ?? undefined);
    if (!installSlug) {
      return json({
        ok: false,
        error: 'no_home_harness',
        message: 'Pass `pot` (or set PAPERCUSP_POT_HOME_SLUG) — steering is per-pot.',
      });
    }
    const steering = await getOwnerSteering(workspaceId, installSlug);
    // EI-12807: revalidate any pinned model spec against the CURRENT committed
    // (workspace-default) tier menu. A pot's session modelTiers/modelOverrides
    // override wins over the workspace default, so a global tier-menu fix cannot
    // reach it — a stale pin silently keeps killing spawns on "model unavailable".
    // Fail-soft: an unreadable config falls back to DEFAULT_MODEL_TIERS.
    let committedTiers: readonly ModelTier[] = DEFAULT_MODEL_TIERS;
    try {
      const { readAgentConfig } = await import('../../agent-config');
      const cfg = await readAgentConfig();
      if (cfg.tiers && cfg.tiers.length > 0) committedTiers = cfg.tiers;
    } catch {
      /* unreadable agent-config — compare against the committed default menu */
    }
    // THE GETTER MUST CARRY THE SAME RETIREMENT FACT THE SETTER REFUSES WITH. pot:set-steering rejects every
    // write with `mug_kettle_retired`, but this read kept answering as though it described a live control —
    // so `pauseNewWork: true` read as "work is paused" when the only component that ever obeyed it (the Mug)
    // no longer exists, and the flag cannot even be cleared. An agent stopped work for hours on it
    // (2026-08-17) and carried it as an owner-gated wall across ~15 wakes.
    //
    // A read is NOT refused: the stored values are still worth seeing as residue, and refusing would break
    // callers that legitimately inspect them. What changes is that the payload can no longer be mistaken for
    // a live control surface. Same fail-CLOSED resolution as the setter's gate — an unreadable flag reports
    // retired, because that is the reading that cannot manufacture a phantom pause.
    let tierRetired = true;
    try {
      tierRetired = !(await mugKettleSystemEnabled());
    } catch {
      /* fail-closed: unreadable ⇒ report retired */
    }
    return json({
      ok: true,
      pot: installSlug,
      steering,
      ...(tierRetired
        ? {
            retired: true,
            retiredError: MUG_KETTLE_RETIRED_ERROR,
            governs: 'nothing',
            retiredMessage:
              'RESIDUE, NOT A CONTROL: the Mug/Kettle/Cup tier is RETIRED, so these values steer nothing. ' +
              'In particular `pauseNewWork` does NOT pause anything — it only ever gated the MUG\'s placement ' +
              'of new work, never an su session working items directly — and it CANNOT be cleared, because ' +
              'pot:set-steering refuses every write with `mug_kettle_retired`. Judge whether work is paused ' +
              'from fleet:status -> controlState, never from this flag.',
          }
        : {}),
      // EI-8277: flag when the directive text reads like "resumed" but pauseNewWork
      // is still the hard gate ON — advisory only, never auto-clears the pause.
      inconsistent: steeringLooksInconsistent(steering),
      // EI-12807: the specs this steering pins that are NO LONGER in the committed
      // tier menu — non-empty ⇒ reconcile via pot:set-steering { modelTiers:null,
      // modelOverrides:null } (inherit the fixed workspace default). Advisory only.
      modelSpecDrift: steeringModelSpecDrift(steering, committedTiers),
      // WI-10004526: pinned Codex specs with no @papercusp/model-pricing entry —
      // usage records unpriced and llmCall refuses them (the WI-10004502 Scout
      // outage). Non-empty ⇒ add the price or re-pin. Advisory only.
      modelSpecUnpriced: steeringUnpricedModelSpecs(steering),
    });
  },
});
