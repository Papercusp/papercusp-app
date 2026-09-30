/**
 * autonomy:record_disposition — the Queen's decision turn logs the disposition it
 * chose for an item (queen-autonomy-policy-2026-06-13 B-13 / P-111, the
 * decider-disposition layer of the D-012 decision ledger).
 *
 * Where `autonomy:decide` is the pure READ ("may I auto-handle this?"), this tool
 * is the WRITE: the Queen has considered an item and chosen what to do with it —
 * act / defer / reject / route-to-research / no-op — and records ONE disposition
 * row (layer='disposition') carrying the decider's full `AutonomyDecision` axes +
 * the chosen disposition + why + links. It re-resolves the decision from the same
 * inputs as `autonomy:decide` (one gate, no fork), so a single call both decides
 * and records.
 *
 * Behavior-neutral: a pure record. The decision itself is still `gated` until the
 * owner arms the policy (P-092); recording that she PROPOSED a gated item is the
 * shadow trail the settings recent-auto-decisions feed (P-031) + B-16's
 * graduation evidence read back.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { hardText, LIMITS } from '../limits';
import { COORD_ROLES } from '../coordination/roles';
import { RISK_TIERS, AUTHORITY_LEVELS } from '@papercusp/plan-parser';
import { DISPOSITIONS } from '../../decision-ledger/disposition';

export default defineTool({
  name: 'autonomy:record_disposition',
  profile: 'engineer',
  crossWorkspace: true,
  description:
    "Log your disposition of a considered item to the decision ledger (P-111): act | defer | reject | route-to-research | no-op. Resolves the autonomy gate from the action + risk/authority/reversibility (same as autonomy:decide), then records one disposition row with the decision axes, the chosen disposition, why, and links (the item, a realized action row, or a routed research task). Behavior-neutral record-keeping.",
  capability: 'coord:write',
  guidance: {
    when: "You have DECIDED what to do with a queue item — record the disposition so it lands in the decision ledger / the owner's recent-auto-decisions feed. Use disposition='act' (links the action row), 'defer' (+revisitAt), 'reject' (+why), 'route-to-research' (+researchTaskId), or 'no-op' (+why).",
    notWhen:
      "Just QUERYING whether you may auto-handle something (no commitment yet) → autonomy:decide. Changing a category ceiling → autonomy:policy_set.",
    chaining:
      'autonomy:decide (or the same inputs) → act on the item → autonomy:record_disposition to log what you did. The worked example: a plan that "needs more research" → record_disposition { action:"plans:add-item", disposition:"route-to-research", researchTaskId } → a plan-governance disposition linked to the spawned research task.',
    seeAlso: [
      'autonomy:decide (the decision this logs the outcome of)',
      'autonomy:tripwire_list (audit the auto-decisions recorded)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    action: z
      .string()
      .min(1)
      .describe('The MCP tool/verb the item would use (group:verb) — keys the category + the gate.'),
    disposition: z
      .enum([...DISPOSITIONS] as [string, ...string[]])
      .describe('What you chose: act | defer | reject | route-to-research | no-op.'),
    capability: z.string().optional().describe('Coarse RBAC capability — last-resort category fallback only.'),
    riskTier: z
      .enum([...RISK_TIERS] as [string, ...string[]])
      .optional()
      .describe("The item's graded risk. Omit ⇒ fail-safe critical."),
    authority: z
      .enum([...AUTHORITY_LEVELS] as [string, ...string[]])
      .optional()
      .describe('Decision authority. "owner" always gates. Default "system".'),
    reversibility: z
      .enum(['reversible', 'irreversible', 'unknown'])
      .optional()
      .describe('Reversibility of the action. Omit/"unknown" ⇒ fail-safe irreversible.'),
    why: hardText(LIMITS.SHORT_TITLE).optional().describe('Short reason (defaults to the decision reasons).'),
    itemRef: z.string().max(200).optional().describe('The item considered (work-item / feature / plan-item / idea id).'),
    actionLedgerId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("disposition='act': the decision_ledger id of the action row this realized."),
    researchTaskId: z
      .string()
      .max(120)
      .optional()
      .describe("disposition='route-to-research': the spawned research-task work-item id."),
    revisitAt: z
      .string()
      .datetime()
      .optional()
      .describe("disposition='defer': ISO timestamp to reconsider the item."),
  }),
  async handler(args, ctx) {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { activeWorkspaceId } = await import('../../workspace-registry');
    const { resolveAutonomyDecision, defaultDeciderDeps } = await import('../../autonomy/decider');
    const { recordDecisionDisposition } = await import('../../decision-ledger/disposition');

    const principalWs = ctx?.principal?.workspaceId;
    const ws = principalWs && principalWs !== '*' ? principalWs : activeWorkspaceId();
    const { sql } = getOrgPg();

    const decision = await resolveAutonomyDecision(
      {
        action: args.action,
        ...(args.capability !== undefined ? { capability: args.capability } : {}),
        ...(args.riskTier !== undefined ? { riskTier: args.riskTier as never } : {}),
        ...(args.authority !== undefined ? { authority: args.authority as never } : {}),
        ...(args.reversibility !== undefined ? { reversibility: args.reversibility as never } : {}),
      },
      defaultDeciderDeps(sql, ws),
    );

    const links: Record<string, unknown> = {};
    if (args.itemRef) links.itemRef = args.itemRef;
    if (args.actionLedgerId != null) links.actionLedgerId = args.actionLedgerId;
    if (args.researchTaskId) links.researchTaskId = args.researchTaskId;
    if (ctx?.runId) links.runId = ctx.runId;
    if (ctx?.spawnId) links.spawnId = ctx.spawnId;

    const ledgerId = await recordDecisionDisposition({
      workspaceId: ws,
      harnessSlug: ctx?.harnessSlug ?? null,
      decision,
      disposition: args.disposition as never,
      ...(args.why !== undefined ? { why: args.why } : {}),
      ...(Object.keys(links).length > 0 ? { links } : {}),
      ...(args.revisitAt !== undefined ? { revisitAt: args.revisitAt } : {}),
      actorRole: ctx?.role ?? null,
      actorSpawnId: ctx?.spawnId ?? null,
      actorPrincipal: ctx?.principal?.slug ?? null,
      transport: ctx?.transport ?? null,
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { ok: true, workspaceId: ws, ledgerId, disposition: args.disposition, decision },
            null,
            2,
          ),
        },
      ],
    };
  },
});
