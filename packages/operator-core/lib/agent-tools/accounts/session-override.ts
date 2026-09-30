/**
 * accounts:set-session-override / accounts:get-session-override — the owner's session-now
 * steer over WHICH pool accounts the fleet may spawn/deploy on (accounts-pool-tab-2026-06-15
 * P-004; owner greenlit "allow-list + exclude"). The agent-surface twin of the
 * /api/admin/deploy-accounts/session-override route. Thin wrappers over
 * deployment/account-session-override; WORKSPACE-LEVEL (D-015 — no home hive required),
 * operator-state-backed (no migration), fail-soft, applied BEFORE the headroom/drain selectors.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import {
  getAccountOverride,
  setAccountOverride,
  type AccountSessionOverridePatch,
} from '../../deployment/account-session-override';
import { trackDetached } from '../../detached-imports';

const json = (o: unknown) => ({ data: o });

export const accountsSetSessionOverrideTool = defineTool({
  name: 'accounts:set-session-override',
  profile: 'engineer',
  description:
    "Set the owner's account steer the fleet honours when picking a pool account to spawn/deploy on: `forcedAccounts` (allow-list — use ONLY these), `excludeAccounts` (skip these, e.g. a flaky/rate-limited account), `defaultAccountId` (the Claude account standing in for this machine's ~/.claude login; null clears it). The two lists RESTRICT selection and are applied fail-soft BEFORE the headroom/drain selectors; the default only replaces the implicit local-login fallback, so it never narrows the pool or defeats failover. `clear:true` wipes all three. Writes reject unknown pool ids, contradictory forced+excluded ids, and accidental zero-account collapse; pass `confirmCollapse:true` only when that narrowing is intentional. Returns {ok, override}.",
  guidance: {
    when: 'Steering account selection for the current session — focus the fleet on one account, or route around a flaky/limited one — without removing it from the pool.',
    notWhen: "Permanently removing an account — accounts:remove. Clearing a rate-limit penalty — accounts:reset-rate. Pausing the pot — pot:pause.",
    chaining: 'accounts:set-session-override { excludeAccounts:["acct-b"] } → cups stop spawning on acct-b this session. clear:true resets.',
    seeAlso: [
      'accounts:get-session-override (read the current steering before changing it)',
      'accounts:remove (permanently drop an account instead of session-excluding)',
      'accounts:reset-rate (clear a rate-limit penalty instead of routing around it)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    workspace: z.string().max(120).optional().describe('Workspace id (default: ctx / active workspace).'),
    forcedAccounts: z.array(z.string().min(1).max(200)).max(200).optional().describe('Allow-list — the fleet may use ONLY these account ids. [] = no restriction.'),
    excludeAccounts: z.array(z.string().min(1).max(200)).max(200).optional().describe('Account ids to skip this session (e.g. a flaky/limited account). [] = skip none.'),
    defaultAccountId: z.string().max(200).nullable().optional().describe("The Claude pool account that stands in for this machine's own ~/.claude login. null = clear (back to the local login). Validated against the pool; a Codex account is rejected."),
    clear: z.boolean().optional().describe('Wipe every axis — both lists AND the default — back to no steer.'),
    confirmCollapse: z.boolean().optional().describe('Acknowledge intentionally narrowing a non-empty account pool to zero routable accounts.'),
  }),
  async handler(args, ctx) {
    const ws = resolveConcreteWorkspaceId(args.workspace, ctx.workspaceId, ctx.principal?.workspaceId);
    const patch: AccountSessionOverridePatch = {};
    if (args.forcedAccounts !== undefined) patch.forcedAccounts = args.forcedAccounts;
    if (args.excludeAccounts !== undefined) patch.excludeAccounts = args.excludeAccounts;
    if (args.clear !== undefined) patch.clear = args.clear;
    if (args.confirmCollapse !== undefined) patch.confirmCollapse = args.confirmCollapse;
    try {
      // The default goes through the pool-validating setter (account-pool-store), NOT the raw
      // patch — naming a nonexistent/Codex account must fail HERE, not degrade silently to the
      // local login at resolution time (D-003). Ordering matters: apply the list axes first so
      // a rejected default cannot half-apply on top of a successful allow/exclude change.
      if (args.defaultAccountId !== undefined) {
        const { setDefaultAccount } = await import('../../deployment/account-pool-store');
        if (Object.keys(patch).length > 0) await setAccountOverride(ws, patch);
        const override = await setDefaultAccount(args.defaultAccountId, ws);
        void trackDetached(import('../../sync-sse')).then(({ notifySyncInvalidate }) => notifySyncInvalidate('accounts.pool', {})).catch(() => {});
        return json({ ok: true, override });
      }
      const override = await setAccountOverride(ws, patch);
      // Live UI reflection — the Accounts tab re-reads on a steer.
      void trackDetached(import('../../sync-sse')).then(({ notifySyncInvalidate }) => notifySyncInvalidate('accounts.pool', {})).catch(() => {});
      return json({ ok: true, override });
    } catch (e) {
      return json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  },
});

export const accountsGetSessionOverrideTool = defineTool({
  name: 'accounts:get-session-override',
  profile: 'engineer',
  description:
    'Read the current owner account steer (forcedAccounts allow-list + excludeAccounts + defaultAccountId) the fleet honours when picking a pool account. An un-steered workspace returns both lists empty and no default — i.e. no restriction, and the box\'s own ~/.claude login as the fallback. The READ twin of accounts:set-session-override. Returns {ok, override}.',
  guidance: {
    when: 'Checking how account selection is currently steered, before changing it.',
    notWhen: 'Per-account rate/status — accounts:status. The whole pool — accounts:list.',
    seeAlso: [
      'accounts:set-session-override (change the steering)',
      'accounts:status (per-account health the override steers around)',
    ],
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    workspace: z.string().max(120).optional().describe('Workspace id (default: ctx / active workspace).'),
  }),
  async handler(args, ctx) {
    const ws = resolveConcreteWorkspaceId(args.workspace, ctx.workspaceId, ctx.principal?.workspaceId);
    return json({ ok: true, override: await getAccountOverride(ws) });
  },
});
