/**
 * GET/POST /api/admin/deploy-accounts/session-override — the owner's account steer
 * (accounts-pool-tab-2026-06-15 P-004; default account added by
 * default-deploy-account-2026-08-08 P-002). GET reads
 * { forcedAccounts, excludeAccounts, defaultAccountId? }; POST writes
 * { forcedAccounts?, excludeAccounts?, defaultAccountId?, clear? }. Backed by the
 * operator_account_override row, fail-soft. Serves both the Accounts tab and
 * Settings → Deploy accounts.
 *
 * The two lists RESTRICT which accounts may be selected and are applied before the
 * headroom/drain selectors. `defaultAccountId` is a different axis: it replaces the
 * implicit `~/.claude` local-login fallback, so it never narrows the pool. It is written
 * through the pool-VALIDATING setter, so a bad id 400s here rather than degrading silently
 * to the local login at resolution time.
 */
import {
  getAccountOverride,
  setAccountOverride,
  type AccountSessionOverridePatch,
} from '../../../deployment/account-session-override';
import { AccountPoolError } from '../../../deployment/account-pool';
import { activeWorkspaceId } from '../../../workspace-registry';
import { notifySyncInvalidate } from '../../../sync-sse';
import { requireAllowedOriginOr403 } from '../../cors';
import { defineTool } from '@papercusp/agent-mcp';

const VTL = { trust: ['verified', 'trusted', 'unverified-loopback'] } as const;

const getRoute = defineTool({
  method: 'GET',
  path: '/admin/deploy-accounts/session-override',
  // unverified-loopback: cookie-less desktop webview (EI-338) — mirrors /register, /reset-rate.
  auth: VTL,
  async handler() {
    // Workspace-level — no home hive required (D-015).
    return Response.json({ ok: true, override: await getAccountOverride(activeWorkspaceId()) });
  },
});

const postRoute = defineTool({
  method: 'POST',
  path: '/admin/deploy-accounts/session-override',
  auth: VTL,
  async handler(req) {
    const csrf = requireAllowedOriginOr403(req);
    if (csrf) return csrf;
    let body: { forcedAccounts?: unknown; excludeAccounts?: unknown; defaultAccountId?: unknown; clear?: unknown; confirmCollapse?: unknown };
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
    }
    const patch: AccountSessionOverridePatch = {};
    if (Array.isArray(body?.forcedAccounts)) patch.forcedAccounts = body.forcedAccounts.filter((x): x is string => typeof x === 'string');
    if (Array.isArray(body?.excludeAccounts)) patch.excludeAccounts = body.excludeAccounts.filter((x): x is string => typeof x === 'string');
    if (typeof body?.clear === 'boolean') patch.clear = body.clear;
    if (typeof body?.confirmCollapse === 'boolean') patch.confirmCollapse = body.confirmCollapse;
    // `null` clears the default and is meaningful — only an ABSENT key means "leave it alone",
    // so this cannot collapse to a truthiness check.
    const wantsDefault = body?.defaultAccountId !== undefined;
    const nextDefault =
      typeof body?.defaultAccountId === 'string' ? body.defaultAccountId : null;
    try {
      // Workspace-level — no home hive required (D-015).
      const ws = activeWorkspaceId();
      if (wantsDefault) {
        const { setDefaultAccount } = await import('../../../deployment/account-pool-store');
        if (Object.keys(patch).length > 0) await setAccountOverride(ws, patch);
        const override = await setDefaultAccount(nextDefault, ws);
        void notifySyncInvalidate('accounts.pool', {}).catch(() => {});
        return Response.json({ ok: true, override });
      }
      const override = await setAccountOverride(ws, patch);
      void notifySyncInvalidate('accounts.pool', {}).catch(() => {});
      return Response.json({ ok: true, override });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // A rejected default is a CALLER mistake (an unknown id — a Codex account is accepted
      // since inference-rename-and-provider-agnostic-default-2026-08-09 P-003), not a server
      // fault — 400 so the UI shows the reason instead of a generic failure toast.
      const status = e instanceof AccountPoolError ? 400 : 500;
      return Response.json({ ok: false, error: msg }, { status });
    }
  },
});

export default [getRoute, postRoute];
