/**
 * pot_git:integration_requests — the owner surface for the multi-owner
 * integration-requests queue (WI-1555, cross-machine-coord-parity-and-trust-
 * 2026-07-01 / P-035; D-010/D-011).
 *
 * QUEUE, DON'T INTEGRATE: a namespace work head published by a member device
 * whose verified author sits BELOW the 'steer' comms tier is not auto-merged
 * by the integrator — it lands in `harness_shared.pot_integration_requests`
 * instead (see `lib/sync/pot-git/integration-requests.ts`). Until this tool,
 * `ratifyIntegrationRequest` / `listIntegrationRequests` had NO exposed verb
 * (grep showed only the module + its tests calling them), so a queued head
 * had no promotion path — safe (nothing auto-integrates) but incomplete (the
 * quarantine-twin's ratify half was unwired; heads queued forever).
 *
 * Mirrors the `trust:comms` pattern: a single action-dispatched tool,
 * owner-scoped (capability:'audit:write', same as trust:comms — ratification
 * is a TRUST decision), local-only (the underlying store never federates —
 * ratification is the receiving integrator/owner's own judgment about the
 * sender, never a peer's).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  name: 'pot_git:integration_requests',
  profile: 'engineer',
  // Writes/reads via the admin handle (listIntegrationRequests/ratifyIntegrationRequest
  // default to getOrgPg().sql when no tx is passed), scoping itself by the resolved
  // workspace id — same rationale as trust:comms.
  crossWorkspace: true,
  description:
    'Owner: the multi-owner integration-requests queue — below-steer-tier member heads the integrator queued instead of auto-merging (the code-plane twin of the coord quarantine). Actions: list {potSlug?, repoKey?, devicePubkey?, state?, limit?} (default state omitted = all) | ratify {potSlug, repoKey, devicePubkey, headSha} — the ONE call that marks a queued head ratified so the NEXT integrator pass merges it. Ratification is PER-SHA (a newer head from the same below-tier device queues again — you ratify the code you saw, not the author\'s future pushes). Local-only, never federated: this is the receiving owner\'s own trust judgment about the sender, not a peer-influenced decision.',
  capability: 'audit:write',
  guidance: {
    when:
      "A member's below-steer-tier head is stuck in the integration-requests queue (visible via {action:'list'}) and you've reviewed its content and want it merged on the next integrator pass — {action:'ratify', potSlug, repoKey, devicePubkey, headSha}. Check {action:'list', state:'pending'} first to see what's actually queued before ratifying.",
    notWhen:
      "Granting a member's comms REACH into your agents (trust:comms) or auto-run of their verified work (trust:add) — those are separate trust axes. Raising the member's comms tier to 'steer' permanently (pot:set-steering / the pot policy) instead of a one-off per-SHA ratify.",
    chaining:
      "{action:'list', state:'pending'} → review the head → {action:'ratify', potSlug, repoKey, devicePubkey, headSha} → the next integrator pass (git-sync tick) merges it.",
    seeAlso: ['trust:comms (comms-reach tiers — separable)', 'pot:set-steering (policy authoring)'],
  },
  requirePrincipal: false,
  agentRoles: ['operator'],
  args: z
    .object({
      action: z.enum(['list', 'ratify']).describe('list the queue, or ratify one queued (device, sha) head.'),
      workspaceId: z
        .string()
        .optional()
        .describe('Workspace id. Defaults to the active workspace when omitted.'),
      potSlug: z.string().optional().describe("The Pot's home slug. Required for action:'ratify'."),
      repoKey: z
        .string()
        .optional()
        .describe("The managed member repo key (G-1b scope). Required for action:'ratify'."),
      devicePubkey: z
        .string()
        .optional()
        .describe("The publishing member device's identity pubkey (base64). Required for action:'ratify'."),
      headSha: z.string().optional().describe("The queued commit sha to ratify. Required for action:'ratify'."),
      state: z
        .enum(['pending', 'ratified'])
        .optional()
        .describe('list only: filter by queue state. Omit for both.'),
      limit: z
        .number()
        .int()
        .positive()
        .max(500)
        .optional()
        .describe('list only: max rows, newest first (default 100, max 500).'),
    })
    .refine(
      (a) =>
        a.action !== 'ratify' ||
        (Boolean(a.potSlug) && Boolean(a.repoKey) && Boolean(a.devicePubkey) && Boolean(a.headSha)),
      { message: "action:'ratify' needs potSlug, repoKey, devicePubkey, and headSha" },
    ),
  async handler(args, ctx) {
    const { activeWorkspaceId } = await import('../../workspace-registry');
    const { listIntegrationRequests, ratifyIntegrationRequest } = await import(
      '../../sync/pot-git/integration-requests'
    );
    const principalWs = ctx?.principal?.workspaceId;
    const ws = args.workspaceId ?? (principalWs && principalWs !== '*' ? principalWs : activeWorkspaceId());
    let payload: Record<string, unknown>;
    if (args.action === 'list') {
      const requests = await listIntegrationRequests({
        workspaceId: ws,
        potSlug: args.potSlug,
        repoKey: args.repoKey,
        devicePubkey: args.devicePubkey,
        state: args.state,
        limit: args.limit,
      });
      payload = { ok: true, workspaceId: ws, count: requests.length, requests };
    } else {
      const ratified = await ratifyIntegrationRequest({
        workspaceId: ws,
        potSlug: args.potSlug!,
        repoKey: args.repoKey!,
        devicePubkey: args.devicePubkey!,
        headSha: args.headSha!,
      });
      payload = ratified
        ? { ok: true, workspaceId: ws, ratified: true }
        : {
            ok: false,
            workspaceId: ws,
            ratified: false,
            error: 'no such queued (device, sha) row — nothing to ratify (already ratified rows stay ratified; check {action:\'list\'} for the current state)',
          };
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
  },
});
