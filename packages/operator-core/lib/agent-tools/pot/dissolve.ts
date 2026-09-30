/**
 * pot:dissolve — tear down a local pot (hive-tool-namespace-2026-06-08 P-005,
 * D-002/D-006). The durable inverse of pot:create.
 *
 * Steps (idempotent; each tolerant of already-done):
 *   1. clear the per-slug pot time-wake routine → the Mug won't re-wake (an
 *      in-flight Mug turn finishes naturally; event-wake subs are
 *      workspace-scoped, not per-pot, so they're left to avoid clobbering
 *      sibling hives — known limitation).
 *   2. cancel every live cup in the pot's home harness (+ its subtree).
 *   3. deregister the home harness from the workspace registry.
 *   3.5. tear down the pot's learning loop — the dark gym autoloop row, the
 *      inactive scout routine, and the gym:<pot>/scout:<pot> governor
 *      registrants provisionPotLearningLoop laid down at pot:create
 *      (per-hive-learning-loops-2026-06-14 P-021; D-003). Best-effort: a failure
 *      WARNS but never fails the dissolve. Without it per-pot routines leak past
 *      dissolve.
 *   3.6. release the pot's leased sandbox desktop (capability:computer) if any —
 *      kill the in-process Xvfb child + free the display (inverse of
 *      ensurePotDesktop). Idempotent + best-effort (WARNS, never fails dissolve).
 *   4. OPTIONALLY drop the harness PG schema (default keep — deregister only).
 *
 * ROOT-ONLY (D-002) + confirm-gated (destructive). Does NOT call
 * deploy:teardown_pot — destroying a deployed cloud frame is a separate step.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { COORD_ROLES } from '../coordination/roles';
import { resolveAgentIdentity } from '../coordination/identity';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { listFleetAssignments } from '../../fleet/assignments';
import { cancelSubtree } from '../../fleet/nursery';
import { clearPotTimeWake } from '../../pot/wake';
import { dropHarnessSchema } from '../../scaffold-harness-schema';
import { removeHarnessFromWorkspace } from '../../harness-membership';
import { removeAllHiveMembers } from '../../hive-membership-store';
import { resolveFederatedPotScope } from '../../federated-pot-scope';
import { requirePotTier } from '../../pot/member-tier-gate';
import { teardownPotLearningLoop } from '../../pot/provision-learning-loop';
import { releaseHiveDesktop } from '../computer/desktop-lease';
import { resolvePot } from './_resolve';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

export default defineTool({
  name: 'pot:dissolve',
  profile: 'engineer',
  description:
    "Tear down a local pot (root-only, destructive — pass confirm:true): clear the pot's pending wake so it won't re-wake, cancel every live cup + its subtree, and deregister the home harness. Optionally drop the harness PG schema (default keep). Idempotent. Does NOT destroy a deployed cloud frame — that is deploy:teardown_pot.",
  guidance: {
    when: 'Permanently tearing down a local pot — stop the pot operator, cancel its members, deregister it. Operator/user only.',
    notWhen:
      'Destroying a deployed cloud frame (the control/member execution planes) — deploy:teardown_pot. Pausing a pot without tearing down — pot:declare-wake { mode:none }. From a cup — not allowed.',
    chaining: 'pot:get { slug } to inspect before; deploy:teardown_pot first if the pot is deployed to a Swarm.',
    seeAlso: [
      'pot:pause (freeze instead of permanently tearing down)',
      'pot:get (inspect the pot before dissolving)',
      'deploy:teardown_pot (run first if the pot is deployed to a Swarm)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    slug: z.string().min(1).max(120).describe("The pot's home-harness slug."),
    confirm: z
      .boolean()
      .optional()
      .describe('Required true — pot:dissolve is destructive (stops the pot operator, cancels members, deregisters the harness).'),
    dropSchema: z
      .boolean()
      .optional()
      .describe('Also DROP the harness PG schema (harness_<slug> CASCADE). Default false — keep the data, just deregister.'),
    workspace: z.string().max(120).optional().describe('Workspace id (default: ctx / active workspace).'),
  }),
  async handler(args, ctx) {
    // Root-only enforcement (D-002).
    const actor = resolveAgentIdentity(ctx);
    if (actor.source === 'fleet-spawn') {
      return text({
        ok: false,
        error: 'hive_dissolve_root_only',
        message: 'pot:dissolve cannot be called from a cup (a spawned/parented agent). Only the operator/user dissolves a pot.',
      });
    }
    if (!args.confirm) {
      return text({
        ok: false,
        error: 'confirm_required',
        message:
          'pot:dissolve is destructive — pass confirm:true to proceed. It clears the pot wake, cancels all members, and deregisters the home harness (dropSchema:true also drops its PG schema).',
      });
    }

    const workspaceId = resolveConcreteWorkspaceId(args.workspace, ctx.workspaceId, ctx.principal?.workspaceId);
    const pot = await resolvePot(args.slug, workspaceId);
    if (!pot) {
      return text({
        ok: false,
        error: 'hive_not_found',
        message: `No kind:'hive' harness '${args.slug}' in this workspace (already dissolved?). Use pot:list to see the pots.`,
      });
    }

    // B11 / P-014 owner-action gate: only an owner-tier member (admin|maintain on
    // the pot's repo, re-derived LIVE from GitHub — never federated state) may
    // dissolve a SHARED pot. Composes with the root-only/confirm gates above; a
    // SOLO/unbound pot is a no-op (the local owner keeps owner tier).
    const gate = await requirePotTier({ workspaceId, potSlug: pot.slug, minTier: 'owner' });
    if (!gate.ok) {
      return text({
        ok: false,
        error: 'insufficient_tier',
        message: gate.message ?? 'You lack owner-tier access to this pot.',
        tier: gate.tier,
        reason: gate.reason,
      });
    }

    const { sql } = getOrgPg();
    const steps: Record<string, unknown> = {};

    // 1. Stop the Mug re-waking (per-slug time-wake routine).
    try {
      await clearPotTimeWake(sql, pot.slug);
      steps.wakeCleared = true;
    } catch (e) {
      steps.wakeCleared = false;
      steps.wakeError = (e instanceof Error ? e.message : String(e)).slice(0, 200);
    }

    // 2. Cancel every live cup in the pot's home harness (+ subtree).
    const rows = await listFleetAssignments({ workspaceId, harness: pot.slug });
    const cupIds = [
      ...new Set(rows.filter((r) => r.holderAlive && r.agentId).map((r) => r.agentId as string)),
    ];
    const cancelledSpawns: string[] = [];
    for (const cupId of cupIds) {
      try {
        const res = await cancelSubtree(sql, {
          workspaceId,
          rootSpawnId: cupId,
          reason: 'pot:dissolve',
          actor,
        });
        const { abortLocalSpawn } = await import('../../fleet/operator-spawn');
        for (const c of res.cancelled) {
          cancelledSpawns.push(c.spawnId);
          abortLocalSpawn(c.spawnId);
        }
      } catch (e) {
        console.warn(`[pot:dissolve] cancel cup ${cupId} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    steps.cancelledSpawns = cancelledSpawns;

    // 2.5. Delete the pot's membership records (G24 — shared-pot-public-release-
    // 2026-06-22). dissolve previously left harness_shared.pot_members rows behind,
    // so a dissolved pot's members lingered and kept federating. Delete them all
    // (done BEFORE deregister, while the substrate is still live): the mig-189
    // capture trigger enqueues a `del` per local-origin row → federates a membership
    // tombstone so peers' read-merge drops the departed members. Best-effort: a
    // failure WARNS but never fails the dissolve (same contract as 3.5/3.6).
    try {
      // ⚠ SCOPE (WI-6312): `pot.slug` is the LOCAL registry handle; pot_members rows are
      // written under the FEDERATED scope. Passing the local handle on a divergent joiner
      // deletes 0 rows and the members keep federating — i.e. silently reintroduces the
      // exact G24 bug this call was added to fix, and the `try` below would report success.
      // Fails open to the local handle, so the owner path is byte-identical.
      const potScope = await resolveFederatedPotScope(workspaceId, pot.slug);
      steps.membershipRowsDropped = await removeAllHiveMembers(workspaceId, potScope, sql);
    } catch (e) {
      steps.membershipRowsDropped = 0;
      steps.membershipError = (e instanceof Error ? e.message : String(e)).slice(0, 200);
      console.warn(
        `[pot:dissolve] hive_members teardown for ${pot.slug} failed (dissolve unaffected): ${e instanceof Error ? e.message : e}`,
      );
    }

    // 3. Deregister the home harness.
    const dereg = await removeHarnessFromWorkspace(workspaceId, pot.slug);
    steps.deregistered = dereg.changed;

    // 3.5. Tear down the pot's learning loop (the inverse of provisionPotLearning-
    // Loop at pot:create — dark gym autoloop row, inactive scout routine, and the
    // gym:<pot>/scout:<pot> governor registrants). Best-effort: a failure WARNS
    // but never fails the dissolve (P-021 / D-003). Without it per-pot routines
    // leak past dissolve and a stale scout routine could re-arm.
    try {
      const loop = await teardownPotLearningLoop({ sql, workspaceId, potSlug: pot.slug });
      steps.learningLoopTornDown = true;
      steps.learningLoop = loop;
    } catch (e) {
      steps.learningLoopTornDown = false;
      steps.learningLoopError = (e instanceof Error ? e.message : String(e)).slice(0, 200);
      console.warn(
        `[pot:dissolve] learning-loop teardown for ${pot.slug} failed (dissolve unaffected): ${e instanceof Error ? e.message : e}`,
      );
    }

    // 3.6. Release the pot's leased sandbox desktop, if any (capability:computer /
    // computer-tool-plan 2.4 — the inverse of ensurePotDesktop). The Xvfb child lives in
    // THIS operator loop; releaseHiveDesktop kills it + frees the display. Idempotent +
    // best-effort: a no-op when the pot never leased a desktop, and a failure WARNS but
    // never fails the dissolve (same contract as the learning-loop teardown above).
    try {
      await releaseHiveDesktop(pot.slug);
      steps.desktopReleased = true;
    } catch (e) {
      steps.desktopReleased = false;
      steps.desktopError = (e instanceof Error ? e.message : String(e)).slice(0, 200);
      console.warn(
        `[pot:dissolve] desktop release for ${pot.slug} failed (dissolve unaffected): ${e instanceof Error ? e.message : e}`,
      );
    }

    // 4. Optional schema drop (default keep).
    if (args.dropSchema) {
      try {
        await dropHarnessSchema(pot.slug);
        steps.schemaDropped = true;
      } catch (e) {
        steps.schemaDropped = false;
        steps.schemaError = (e instanceof Error ? e.message : String(e)).slice(0, 200);
      }
    } else {
      steps.schemaDropped = false;
    }

    return text({ ok: true, slug: pot.slug, ...steps });
  },
});
