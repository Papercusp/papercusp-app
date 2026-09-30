/**
 * autonomy:decide — the autonomy decider gate, as a tool
 * (queen-autonomy-policy-2026-06-13 B-12 / P-070; closes queen-autonomous-execution
 * P-013, the shared decider seam).
 *
 * Given an action (the MCP tool/verb it uses) + its risk/authority/reversibility,
 * returns the D-004 verdict: `auto` → the caller may decide it WITHOUT asking, or
 * `gated` → it routes to the owner Queue. The verdict resolves the action's
 * category (B-04), reads that category's effective ceiling from the policy store
 * (B-03), and checks the arming flag (P-092) — then runs the pure gate
 * (lib/autonomy/decider.ts). BEHAVIOR-NEUTRAL until armed: every call returns
 * `gated` while `papercusp-queen-autonomy-armed` is OFF (D-007).
 *
 * This is the gate the dark Queen-decider persona consults per ranked queue item
 * (frontier P-045 / FB-19) and the seam B-13's ledger + B-16's tripwire/graduation
 * + B-17's question-ladder consume — they do not fork the gate.
 *
 * ── The overwatch envelope (overwatch-role-2026-06-15 B-06 / D-002) ──────────
 * Overwatch is a DIFFERENT autonomy model: a fixed allowlist (nudge / observe /
 * escalate / its own wake-scheduling lifecycle bookkeeping are auto; any
 * structural change is escalate-only — EI-3588), not risk × ceiling. When the
 * caller is Overwatch (the `role` arg, or `ctx.role`), this tool DISPATCHES to
 * the overwatch gate (`lib/overwatch/autonomy.ts`) instead of the 13-category
 * autonomy gate — one decision tool, two envelopes, no fork.
 *
 * ⚠ The role string that selects that branch is the literal `"kettle"`, because
 * that IS Overwatch's wire identifier: `OVERWATCH_ROLE = "kettle"`
 * (`lib/overwatch/liveness.ts:42`), the same value its `autoloop_state` rows are
 * keyed by. It is NOT a leftover from the retired mug/kettle/cup tier, and
 * "correcting" it to `"overwatch"` would silently route Overwatch into the
 * 13-category gate — whose ceilings are all ARMED at `critical`, so structural
 * changes that must be escalate-only could come back `auto`. Verify against
 * OVERWATCH_ROLE before touching this comparison (WI-1756049).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { RISK_TIERS, AUTHORITY_LEVELS } from '@papercusp/plan-parser';

export default defineTool({
  name: 'autonomy:decide',
  profile: 'engineer',
  // Resolves the workspace-scoped policy via the admin handle, scoping by the
  // resolved workspace id — so an unscoped operator/SU/Queen session can call it.
  crossWorkspace: true,
  description:
    'The autonomy gate (D-004): given an action + its risk/authority/reversibility, returns auto (decide it without asking) or gated (routes to the owner Queue), with the category, effective ceiling, and the reasons. The policy is ARMED (all 13 categories at ceiling `critical`): `auto` when within ceiling + reversible + system-authority; `gated` only for protected surfaces, authority=owner, or above-ceiling / graduation asks. With the owner full-autonomy grant ON, even that residue is `auto`. Overwatch callers get the overwatch envelope (B-06) instead: nudge/observe/escalate/wake bookkeeping auto, structural escalate-only — selected by `role:"kettle"` (OVERWATCH_ROLE, a LIVE id).',
  capability: 'intel:read',
  guidance: {
    when: "You are deciding whether to auto-handle a queue item / answer a card without the owner — or you are Overwatch (`role:\"kettle\"`, OVERWATCH_ROLE) deciding whether to nudge/observe/escalate (auto) vs escalate a structural change (gated). Pass the action's tool name (group:verb) + the item's risk_tier / reversibility; the gate tells you auto vs the owner Queue and why.",
    notWhen:
      'To READ or render the whole policy use autonomy:policy_get. To CHANGE a ceiling use autonomy:policy_set (owner-authority). This tool DECIDES one action; it never mutates.',
    chaining:
      'improvements:digest → autonomy:decide per item → place/auto-handle the `auto` ones, route the `gated` ones to the owner Queue. Overwatch (OVERWATCH_ROLE): per anomaly suggestedAction → autonomy:decide → perform the `auto` ones, coord:escalate the `gated` ones.',
    seeAlso: [
      'autonomy:record_disposition (log what you did after deciding)',
      'autonomy:policy_get (the ceilings that gate auto-handling)',
      'coord:escalate (route a `gated` item to the owner)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    action: z
      .string()
      .min(1)
      .describe('The MCP tool/verb the action would use (group:verb, e.g. "blender:grade-idea") — keys the category.'),
    capability: z
      .string()
      .optional()
      .describe("The action's coarse RBAC capability string — last-resort category fallback only."),
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
    role: z
      .string()
      .optional()
      .describe(
        'The deciding role. Defaults to the caller\'s role (ctx.role). "kettle" — the wire value of OVERWATCH_ROLE, i.e. LIVE Overwatch, not the retired tier — applies the overwatch envelope (B-06): nudge/observe/escalate auto, structural escalate-only. Any other value uses the 13-category autonomy gate.',
      ),
  }),
  async handler(args, ctx) {
    const { activeWorkspaceId } = await import('../../workspace-registry');
    const principalWs = ctx?.principal?.workspaceId;
    const ws = principalWs && principalWs !== '*' ? principalWs : activeWorkspaceId();

    // Overwatch is a distinct autonomy envelope (B-06 / D-002): a fixed allowlist,
    // not risk × ceiling. Dispatch to its pure gate (no PG, no policy store).
    const role = args.role ?? (ctx?.role as string | undefined);
    if (role === 'kettle') {
      const { decideOverwatchAutonomy } = await import('../../overwatch/autonomy');
      const decision = decideOverwatchAutonomy({ action: args.action });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: true, workspaceId: ws, role: 'kettle', decision }, null, 2),
          },
        ],
      };
    }

    const { getOrgPg } = await import('@papercusp/db-org');
    const { resolveAutonomyDecision, defaultDeciderDeps } = await import('../../autonomy/decider');
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

    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, workspaceId: ws, decision }, null, 2) }],
    };
  },
});
