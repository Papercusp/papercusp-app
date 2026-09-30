/**
 * accounts:test-egress — the clean-IP gate probe (B-EGRESS / per-account IP routing),
 * restoring the tool referenced by name in inference-gateway/egress-probe.ts's own doc
 * comment and by EI-6841's issue text, but never actually registered (EI-7357).
 *
 * Thin MCP wrapper over the already-implemented, already-tested orchestration
 * (`testEgressForAccount`, egress-probe.ts) — loads the account pool, probes the target
 * account's egress exit IP + reputation, and (unless compareOthers:false) compares
 * against every other pooled account's exit IP for an ASN/subnet collision.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';

const wsArg = z.string().min(1).optional().describe('Workspace id (defaults to the active workspace)');

const ok = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, ...payload }) }],
});
const fail = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, ...payload }) }],
});

export default defineTool({
  name: 'accounts:test-egress',
  description:
    "Probe one pooled account's egress: the real exit IP through its dispatcher (or the default shared egress if unpinned), IP reputation (proxy/hosting/ASN), and — unless compareOthers:false — whether that exit IP collides (same ASN or /24 subnet) with any OTHER pooled account's egress. Returns { ok, result: { accountId, hasEgress, exitIp, reputation, asn, distinctFromOthers, comparedOthers, collisions, clean } } — `clean` is the pin-worthiness verdict (has an exit IP, not flagged as proxy/hosting, and distinct from every other account). Read-only, no live-gateway change.",
  guidance: {
    when: "Deciding whether an account's egress IP is safe to pin (accounts:register/accounts:pin egress) — before AND after applying a pin, to prove it actually routes through the new IP and doesn't collide with another pooled account's egress.",
    notWhen: 'Reading current rate-limit headroom (accounts:status) or the pool listing (accounts:list) — this is specifically the network-level egress/IP-reputation probe.',
    chaining: 'accounts:register { egress } → accounts:test-egress { accountId } to verify the pin routes correctly and stays distinct from the rest of the pool.',
    seeAlso: [
      'accounts:list (the pool + each account’s egress config)',
      'accounts:status (live rate-limit headroom, not egress)',
    ],
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    accountId: z.string().min(1).describe('The pooled account id to probe.'),
    compareOthers: z.boolean().optional().describe('Also probe every other pooled account for an ASN/subnet collision (default true).'),
    workspace: wsArg,
  }),
  async handler(args) {
    const { loadAccountPool } = await import('../../deployment/account-pool-store');
    const { testEgressForAccount } = await import('../../inference-gateway/egress-probe');
    const ws = args.workspace ?? activeWorkspaceId();
    const pool = await loadAccountPool(ws);
    const result = await testEgressForAccount(pool.accounts, args.accountId, {
      compareOthers: args.compareOthers,
    });
    if (!result) {
      return fail({ error: 'account_not_found', accountId: args.accountId });
    }
    return ok({ result });
  },
});
