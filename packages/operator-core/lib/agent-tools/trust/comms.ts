/**
 * trust:comms — the owner's per-user COMMS-TRUST tier grants
 * (cross-machine-coord-parity-and-trust-2026-07-01 P-011/P-013, D-004).
 *
 * The coordination twin of trust:add's auto-RUN grant, kept as a SEPARATE tool
 * on purpose: "may their verified work auto-run" and "may their agents reach /
 * re-invoke / steer MY agents" are separable owner decisions. Tier lattice:
 * observe < message < wake < steer — below `message` a member's federated coord
 * is QUARANTINED (visible + grantable, never dropped); below `wake` it delivers
 * but never re-invokes (a wake is a billable turn); `steer` unlocks handoffs.
 * Resolution: this local override → the owner-signed hive-policy default
 * (`comms.defaultTier`) → the conservative fallback ('message').
 *
 * Owner-scoped, local-only, NEVER federated (a peer must not influence who may
 * spend your tokens). Audited.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { softText, clampText, LIMITS } from '../limits';

export default defineTool({
  name: 'trust:comms',
  profile: 'engineer',
  // Writes the workspace-scoped rows via the admin handle, scoping itself by the
  // resolved workspace id (D-004 — never relies on RLS).
  crossWorkspace: true,
  description:
    "Owner: per-user COMMS-TRUST tiers (observe<message<wake<steer) — what a hive member's agents may do to YOUR agents across machines. Below 'message': quarantined; below 'wake': delivered but never re-invoked; 'steer': unlocks handoffs. Actions: set{githubUserId,tier,note?,expiresAtMs?} | remove | list | gate{githubUserId,granted} (DG-4 gate-trust, separable) | requests{githubUserId?} (quarantined messages) | grant{githubUserId,tier?} (one-call: raise tier + clear backlog). Local-only, never federated, audited; overrides hive policy comms.defaultTier per user.",
  capability: 'audit:write',
  guidance: {
    when: "Granting/downgrading a member's reach: 'wake' lets their mug re-invoke your cups; 'steer' for handoffs; 'observe' mutes a noisy member below the policy default. expiresAtMs makes a grant probationary. action:'gate' (P-047) grants/revokes gate-trust (do their shard verdicts count toward green?) — separable from steer. action:'requests' surfaces a below-tier member's quarantined messages; action:'grant' is the one-call approve for that queue.",
    notWhen:
      "Auto-RUN of their verified work — trust:add. The hive-wide DEFAULT tier — author comms.defaultTier. A plain tier bump with no backlog to clear — action:'set' suffices; 'grant' only helps when there IS a quarantine backlog to drain.",
    chaining:
      "{action:'requests'} → {action:'grant', githubUserId, tier:'message'} (or {action:'set', tier:'wake'} to bump only) — picked up within ~30s. {action:'gate', granted:true} → DG-5 counts their verdicts next round.",
    seeAlso: ['trust:add (auto-run grant — separable)', 'trust:list (auto-run list)', 'pot:set-steering (policy authoring)'],
  },
  requirePrincipal: false,
  agentRoles: ['operator'],
  args: z
    .object({
      action: z
        .enum(['set', 'remove', 'list', 'gate', 'requests', 'grant'])
        .describe(
          "set | remove | list | gate (DG-4 gate-trust grant) | requests (list the quarantine queue) | grant (one-call requests-queue approve)",
        ),
      githubUserId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'The member (numeric GitHub id — matches hive_members.github_user_id). Required for set/remove/gate/grant; optional filter for requests (omit to see every quarantined author).',
        ),
      tier: z
        .enum(['observe', 'message', 'wake', 'steer'])
        .optional()
        .describe("Required for action:'set'. Optional for action:'grant' (default 'message', the fallback tier)."),
      note: softText(LIMITS.ANNOTATION).optional().describe('Optional human note (set/grant only).'),
      expiresAtMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Optional expiry (epoch ms) — an expired override decays to the policy default.'),
      granted: z
        .boolean()
        .optional()
        .describe("action:'gate' only: true = this member's gate verdicts count toward green(S); false = revoke."),
    })
    .refine((a) => a.action === 'list' || a.action === 'requests' || Boolean(a.githubUserId), {
      message: 'set/remove/gate/grant need `githubUserId`',
    })
    .refine((a) => a.action !== 'set' || Boolean(a.tier), {
      message: "action:'set' needs `tier`",
    })
    .refine((a) => a.action !== 'gate' || typeof a.granted === 'boolean', {
      message: "action:'gate' needs `granted`",
    }),
  async handler(args, ctx) {
    const { activeWorkspaceId } = await import('../../workspace-registry');
    const { listCommsTrust, setCommsTrust, removeCommsTrust, setGateTrust, FALLBACK_COMMS_TIER } = await import(
      '../../trust/comms-trust'
    );
    const { listCoordQuarantine, clearCoordQuarantineForAuthor } = await import(
      '../../sync/hyperbee/coord-quarantine-store'
    );
    const principalWs = ctx?.principal?.workspaceId;
    const ws = principalWs && principalWs !== '*' ? principalWs : activeWorkspaceId();
    const actor = ctx?.principal?.slug ?? 'agent';
    let payload: Record<string, unknown>;
    if (args.action === 'list') {
      payload = { ok: true, workspaceId: ws, entries: await listCommsTrust(ws) };
    } else if (args.action === 'requests') {
      const requests = await listCoordQuarantine({ workspaceId: ws, authorGithubUserId: args.githubUserId });
      payload = { ok: true, workspaceId: ws, requests, count: requests.length };
    } else if (args.action === 'set') {
      const entry = await setCommsTrust(ws, {
        githubUserId: args.githubUserId!,
        tier: args.tier!,
        note: clampText(args.note, LIMITS.ANNOTATION) ?? null,
        expiresAtMs: args.expiresAtMs ?? null,
        actor,
        nowMs: Date.now(),
      });
      payload = { ok: true, workspaceId: ws, entry };
    } else if (args.action === 'grant') {
      const tier = args.tier ?? FALLBACK_COMMS_TIER;
      const entry = await setCommsTrust(ws, {
        githubUserId: args.githubUserId!,
        tier,
        note: clampText(args.note, LIMITS.ANNOTATION) ?? null,
        expiresAtMs: args.expiresAtMs ?? null,
        actor,
        nowMs: Date.now(),
      });
      const { cleared } = await clearCoordQuarantineForAuthor({ workspaceId: ws, authorGithubUserId: args.githubUserId! });
      payload = { ok: true, workspaceId: ws, entry, clearedRequests: cleared };
    } else if (args.action === 'gate') {
      const entry = await setGateTrust(ws, {
        githubUserId: args.githubUserId!,
        granted: args.granted!,
        note: clampText(args.note, LIMITS.ANNOTATION) ?? null,
        expiresAtMs: args.expiresAtMs ?? null,
        actor,
        nowMs: Date.now(),
      });
      payload = { ok: true, workspaceId: ws, entry };
    } else {
      const r = await removeCommsTrust(ws, args.githubUserId!, actor);
      payload = { ok: true, workspaceId: ws, removed: r.removed };
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
  },
});
