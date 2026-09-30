/**
 * pot:add-member — wire an existing harness in as a MEMBER of a local Pot
 * (EI-1582 — the missing agent-facing PRODUCER for `hive_slug`).
 *
 * The producer `addHarnessToPot` (./_add-member.ts) has existed since
 * shared-pot-federation P-004, but was never exposed as a tool — so a Pot
 * created member-less (e.g. the papercup→papercusp rebrand: ensurePapercuspPot
 * only CREATES the home, never wires `papercup` in) was UNREMEDIABLE by any
 * agent. With no member, `pot:survey` falls back to a WORKSPACE-WIDE scope
 * (survey.ts: "membership not wired ⇒ a workspace-wide survey"), which sweeps
 * benchmark/instance-harness debris as "ready" → Mug-unresolvable escalations
 * → the curse-storm (EI-1525/1578/1581). Wiring the real member scopes the
 * survey to it and closes that exposure. This tool ships the producer so an su
 * OR the Mug can self-remediate.
 *
 * Membership is a REGISTRY edit only (sets `ProjectEntry.hive_slug`); it never
 * moves the harness folder or its run data, and it best-effort seeds the
 * member's `system:git-sync` routine. Idempotent (re-adding to the same Pot is
 * a no-op success) and reversible (re-point by removing first, or via the
 * registry). NOT destructive, so — unlike pot:dissolve / pot:leave — it is
 * neither root-only nor confirm-gated; the Mug needs it to self-heal an
 * empty-frontier pot (EI-1581).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { addHarnessToPot } from './_add-member';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

export default defineTool({
  name: 'pot:add-member',
  profile: 'engineer',
  description:
    "Wire an existing harness in as a MEMBER of a local pot (sets its hive_slug so its work federates within the pot). Registry edit only — never moves the harness folder or run data; best-effort seeds the member's git-sync routine. Idempotent (re-adding is a no-op success). Use this to remediate a member-less pot, whose pot-scoped reads fall back to a workspace-wide scope that sweeps in out-of-scope debris.",
  guidance: {
    when: "A pot has no members, so pot-scoped reads fall back to workspace-wide scope and sweep in other harnesses' debris — wire the real harness in. Also the producer for shared-pot federation membership.",
    notWhen:
      'Adding a person/device to a pot (that is admission, a separate concern). Removing a member (re-point via the registry / pot:leave for a joined remote pot). Nesting a pot home as a member (rejected — pots compose as peers).',
    chaining:
      'pot:list / pot:get to find the pot home + the member slug → pot:add-member → pot:get to confirm members[] is non-empty.',
    seeAlso: [
      'pot:ban_member (remove a member)',
      'pot:membership_pending (approve a self-requested join instead of adding directly)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    pot: z
      .string()
      .min(1)
      .max(120)
      .describe("The pot's home harness slug (a kind:'hive' harness) to add the member to."),
    member: z
      .string()
      .min(1)
      .max(120)
      .describe('The existing harness slug to wire in as a member (sets its hive_slug to the pot home).'),
    workspace: z.string().max(120).optional().describe('Workspace id (default: ctx / active workspace).'),
  }),
  async handler(args, ctx) {
    const workspaceId = resolveConcreteWorkspaceId(
      args.workspace,
      ctx.workspaceId,
      ctx.principal?.workspaceId,
    );
    const result = await addHarnessToPot({
      workspaceId,
      potHomeSlug: args.pot,
      memberHarnessSlug: args.member,
    });
    return text({ ...result });
  },
});
