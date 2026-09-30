/**
 * egress:* — programmatic egress-IP provisioning (B-PROV, deferred residue of B-GW-ACCT /
 * `gateway-live-control-and-egress-plan-2026-06-20` Phase 3, WI-288). Thin MCP surface over
 * `inference-gateway/egress-providers/` (the pluggable `EgressProvider` backends).
 *
 * `accounts:register{egress}` (manual — you already have a proxyUrl/localAddress in hand) remains the
 * everyday path; these tools are for drawing a FRESH IP from a provider (a static owner-supplied
 * inventory, or a REST proxy-provider API) instead. `egress:provision` does allocate → register →
 * verify in one call (D-005's dryRun/verify discipline); `egress:list` / `egress:release` /
 * `egress:health` round out the surface.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';

const ok = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, ...payload }) }],
});
const fail = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, ...payload }) }],
});

const wsArg = z.string().min(1).optional().describe('Workspace id (defaults to the active workspace)');

const providerArg = z
  .enum(['static', 'rayobyte', 'brightdata'])
  .describe(
    "Which EgressProvider backend: 'static' (a fixed owner-supplied IP inventory — pass config.entries), 'rayobyte' (REST-provisioned dedicated ISP IPs — config.apiKeyRef/baseUrl optional, defaults to env:RAYOBYTE_API_KEY), 'brightdata' (the D-001 fallback — STUB, not yet implemented).",
  );

const configArg = z
  .object({
    entries: z
      .array(
        z.object({
          id: z.string().min(1).describe('Stable id for this inventory entry (the allocation id).'),
          proxyUrl: z.string().min(1).optional().describe('http(s)/socks proxy URL for this entry'),
          localAddress: z.string().min(1).optional().describe('local source IP to bind for this entry'),
          meta: z.record(z.string(), z.unknown()).optional(),
        }),
      )
      .optional()
      .describe("provider:'static' ONLY — REQUIRED: the fixed IP inventory to allocate from."),
    baseUrl: z
      .string()
      .min(1)
      .optional()
      .describe("provider:'rayobyte' only: REST API base URL override (default https://api.rayobyte.com/v1 — unverified against a live account; confirm before relying on it in production)."),
    apiKeyRef: z
      .string()
      .min(1)
      .optional()
      .describe("provider:'rayobyte' only: env:NAME | file:<path> reference to the Rayobyte API key (default env:RAYOBYTE_API_KEY). A reference, never the literal key."),
  })
  .optional()
  .describe('Provider-specific configuration. Required (entries) for static; optional for rayobyte (env-var defaults apply); ignored for brightdata.');

export default defineTool({
  name: 'egress:provision',
  description:
    "Allocate an egress IP from an EgressProvider (static/rayobyte/brightdata) for accountId, register it onto the account pool (the accounts:register{egress} equivalent, tagged with providerId/providerAllocationId for later egress:release/health), and verify it actually routes (the same testEgressForAccount probe accounts:test-egress uses) — allocate+register+verify in one call. Returns {ok, allocation, account, verify}. dryRun:true allocates + verifies without writing the account pool.",
  guidance: {
    when: 'Programmatically provisioning a NEW egress IP for a pooled account instead of hand-registering one you already have — rotating in a fresh Rayobyte IP, or drawing the next entry from a pre-provisioned static list.',
    notWhen: "You already hold the proxyUrl/localAddress — just accounts:register{egress} directly, no provider needed. Also not for making the LIVE inference gateway pick this up — that still needs a restart (the gateway resolves its account pool once at boot); this tool only writes the pool row + proves the dispatcher itself works pre-restart.",
    chaining: 'egress:provision {provider, accountId} → accounts:list (confirm the pool row) → restart the gateway (dev:restart{target:"staging"} / the prod deploy) → egress:health or accounts:test-egress to re-verify post-restart.',
    seeAlso: [
      'accounts:register (hand-register an egress you already have)',
      'accounts:test-egress (the same post-apply verify probe, callable standalone)',
      'egress:list / egress:release / egress:health (the rest of the provisioning surface)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    provider: providerArg,
    accountId: z.string().min(1).describe('The pooled account id (accounts:register id) to provision egress for.'),
    config: configArg,
    dryRun: z.boolean().optional().describe('Allocate from the provider + run the verify probe, but do NOT write the account pool (default false).'),
    compareOthers: z.boolean().optional().describe('Also check the new egress for an ASN/subnet collision against every other pooled account (default true; passed through to the verify probe).'),
    workspace: wsArg,
  }),
  async handler(args) {
    const { createEgressProvider } = await import('../../inference-gateway/egress-providers');
    const { loadAccountPool, updateAccountPool } = await import('../../deployment/account-pool-store');
    const { registerAccount, getAccount } = await import('../../deployment/account-pool');
    const { testEgressForAccount } = await import('../../inference-gateway/egress-probe');
    const ws = args.workspace ?? activeWorkspaceId();
    try {
      const pool = await loadAccountPool(ws);
      const target = getAccount(pool, args.accountId);
      if (!target) return fail({ error: 'account_not_found', accountId: args.accountId });

      const provider = createEgressProvider(args.provider, args.config ?? {});
      const allocation = await provider.allocate(args.accountId);
      if (!allocation.proxyUrl && !allocation.localAddress) {
        return fail({ error: 'provider_returned_no_binding', allocation });
      }

      if (args.dryRun) {
        const probeAccounts = pool.accounts.map((a) =>
          a.id === args.accountId
            ? { ...a, egress: { proxyUrl: allocation.proxyUrl, localAddress: allocation.localAddress } }
            : a,
        );
        const verify = await testEgressForAccount(probeAccounts, args.accountId, { compareOthers: args.compareOthers });
        return ok({ dryRun: true, allocation, verify });
      }

      // Atomic RMW against CURRENT state (WI-38164). `pool` above was read BEFORE
      // `provider.allocate()` — a real network round-trip to the IP provider — so writing
      // that snapshot back discarded every pool change made while the allocation was in
      // flight. Re-resolve the target inside the transaction and touch only its egress.
      const next = await updateAccountPool((p) => {
        const cur = getAccount(p, args.accountId) ?? target;
        return registerAccount(
          p,
          {
            id: cur.id,
            provider: cur.provider,
            credentialRef: cur.credentialRef,
            label: cur.label,
            egress: {
              proxyUrl: allocation.proxyUrl,
              localAddress: allocation.localAddress,
              providerId: args.provider,
              providerAllocationId: allocation.id,
            },
          },
          Date.now(),
        );
      }, ws);
      const verify = await testEgressForAccount(next.accounts, args.accountId, { compareOthers: args.compareOthers });
      return ok({
        allocation,
        account: getAccount(next, args.accountId),
        verify,
        note: 'Written to the account pool. The LIVE inference gateway still needs a restart to route through this egress (see inference-gateway-per-account-egress-ips.mdx).',
      });
    } catch (e) {
      return fail({ error: (e instanceof Error ? e.message : String(e)).slice(0, 400) });
    }
  },
});

export const egressListTool = defineTool({
  name: 'egress:list',
  description:
    "List every allocation an EgressProvider currently knows about — id, proxyUrl/localAddress, and which accountId (if any) currently holds it. Returns {ok, allocations}. Read-only, no account-pool change.",
  guidance: {
    when: 'Seeing what IPs a provider has available/assigned before provisioning or releasing one.',
    notWhen: 'Listing the pooled accounts themselves — accounts:list.',
    seeAlso: ['egress:provision', 'egress:release', 'accounts:list'],
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({ provider: providerArg, config: configArg }),
  async handler(args) {
    const { createEgressProvider } = await import('../../inference-gateway/egress-providers');
    try {
      const provider = createEgressProvider(args.provider, args.config ?? {});
      const allocations = await provider.list();
      return ok({ allocations });
    } catch (e) {
      return fail({ error: (e instanceof Error ? e.message : String(e)).slice(0, 400) });
    }
  },
});

export const egressReleaseTool = defineTool({
  name: 'egress:release',
  description:
    "Release an egress allocation back to its provider (frees the IP for reuse). When accountId is given AND that account's current egress was provisioned by this exact allocation (providerId + providerAllocationId match), also clears the account pool's egress binding (reverts to default shared egress) — omit accountId to release provider-side only and leave the account pool untouched. Returns {ok, released:true, accountCleared}.",
  guidance: {
    when: 'Decommissioning a provisioned egress IP — a flagged/dead proxy, or freeing capacity before re-provisioning.',
    notWhen: "You just want to clear an account's egress without touching the provider — accounts:register{id, credentialRef, egress:{}}.",
    seeAlso: ['egress:provision', 'accounts:register'],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    provider: providerArg,
    id: z.string().min(1).describe('The provider-native allocation id to release (from egress:list / egress:provision).'),
    config: configArg,
    accountId: z.string().min(1).optional().describe("When set, also clear this account's pool egress IF it currently points at this exact allocation."),
    workspace: wsArg,
  }),
  async handler(args) {
    const { createEgressProvider } = await import('../../inference-gateway/egress-providers');
    try {
      const provider = createEgressProvider(args.provider, args.config ?? {});
      await provider.release(args.id);

      let accountCleared = false;
      if (args.accountId) {
        const { updateAccountPool } = await import('../../deployment/account-pool-store');
        const { registerAccount, getAccount } = await import('../../deployment/account-pool');
        const ws = args.workspace ?? activeWorkspaceId();
        // Atomic RMW (WI-38164): `provider.release()` above is a network call, so the
        // pool must be re-read under the row lock rather than snapshotted before it.
        await updateAccountPool((pool) => {
          const acct = getAccount(pool, args.accountId!);
          if (!acct || acct.egress?.providerId !== args.provider || acct.egress?.providerAllocationId !== args.id) {
            return pool;
          }
          accountCleared = true;
          return registerAccount(
            pool,
            { id: acct.id, provider: acct.provider, credentialRef: acct.credentialRef, label: acct.label, egress: {} },
            Date.now(),
          );
        }, ws);
      }
      return ok({ released: true, accountCleared });
    } catch (e) {
      return fail({ error: (e instanceof Error ? e.message : String(e)).slice(0, 400) });
    }
  },
});

export const egressHealthTool = defineTool({
  name: 'egress:health',
  description:
    "Reachability check for one provider allocation: builds the same undici dispatcher the gateway would use and echoes the exit IP through it. Returns {ok, health: {reachable, exitIp?, error?}}. Read-only.",
  guidance: {
    when: 'Confirming a provisioned egress IP is actually reachable — before/after egress:provision, or investigating a suspected dead proxy.',
    notWhen: "You also want the reputation/ASN/distinctness gate — accounts:test-egress probes a POOLED account's registered egress with the fuller clean-IP gate.",
    seeAlso: ['egress:provision', 'accounts:test-egress'],
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    provider: providerArg,
    id: z.string().min(1).describe('The provider-native allocation id to health-check.'),
    config: configArg,
  }),
  async handler(args) {
    const { createEgressProvider } = await import('../../inference-gateway/egress-providers');
    try {
      const provider = createEgressProvider(args.provider, args.config ?? {});
      const health = await provider.healthcheck(args.id);
      return ok({ health });
    } catch (e) {
      return fail({ error: (e instanceof Error ? e.message : String(e)).slice(0, 400) });
    }
  },
});
