/**
 * The dispatch-seat half of app-key scope enforcement
 * (external-app-access-to-workspaces-2026-09-29 P-003).
 *
 * `operatorKernelEnforcement` (projected-tool-deps.ts) calls `enforceAppKeyScope` first, on
 * every boundary and at both phases (preflight and again before invoke). That port is the one
 * seat every transport shares — HTTP `/api/agent-tools/*`, MCP, IPC, reactions — so a limit
 * enforced here cannot be skipped by choosing a different door.
 *
 * FAIL CLOSED: the generic kernel wrapper treats a THROW from an optional port as "unavailable,
 * allow". This function therefore never throws for an app principal — a failed row read or
 * lookup is returned as an explicit denial.
 *
 * Returns `null` when the caller is not an app key, or when the app key's call is in scope; the
 * kernel then continues with its ordinary checks. Returns a denial otherwise.
 */

import {
  lookupByMcpName,
  type KernelEnforcementRequest,
  type KernelEnforcementResult,
} from '@papercusp/agent-mcp';
import { resolveConcreteHarnessSlug } from '../agent-tools/_harness-scope';
import { ACCESS_TOKEN_SLUG_SEPARATOR, APP_PRINCIPAL_SLUG_PREFIX } from './principal';
import { appScopeToolOf, evaluateAppScope, type AppScopeRow, type AppScopeTool } from './scope-policy';
import { raiseConnectedAppAlert, type AlertedApp, type ConnectedAppAlert } from './alerts';
import { LLM_RUNNING_TOOLS, loadAppSpendStatus, spendCapVerdict, type AppSpendStatus } from './spend';
import { loadAccessTokenScopeRow, loadAlertedAppRow, loadAppScopeRow } from './store';

/** Denial codes are namespaced so a caller can tell an app-scope refusal from any other. */
export const APP_SCOPE_CODE_PREFIX = 'app_scope:';

export interface EnforceAppKeyScopeDeps {
  loadRow: (id: string) => Promise<AppScopeRow | null>;
  /**
   * The row for a client-credentials access token (P-016): the parent's state with the token's
   * own scopes and expiry. Absent = a token principal is refused (fail closed).
   */
  loadAccessTokenRow?: (tokenId: string, appId: string) => Promise<AppScopeRow | null>;
  lookupTool: (name: string) => AppScopeTool | undefined;
  now?: () => Date;
  /**
   * The key's cap and recorded spend (P-011, R-27), read only for an LLM-running tool. Absent, or a
   * read that fails or finds no key, refuses the LLM-running call (fail closed).
   */
  loadSpendStatus?: (appId: string, now: Date) => Promise<AppSpendStatus | null>;
  /** Raises the cap-near / cap-reached alert. Best-effort, never awaited on the request path. */
  raiseAlert?: (alert: ConnectedAppAlert) => Promise<void>;
  /** The alerted key's display fields (label, kind, workspace). */
  loadAlertedApp?: (appId: string) => Promise<AlertedApp | null>;
}

const DEFAULT_DEPS: EnforceAppKeyScopeDeps = {
  loadRow: loadAppScopeRow,
  loadAccessTokenRow: loadAccessTokenScopeRow,
  lookupTool: (name) => {
    const tool = lookupByMcpName(name);
    return tool ? appScopeToolOf(name, tool) : undefined;
  },
  loadSpendStatus: loadAppSpendStatus,
  raiseAlert: (alert) => raiseConnectedAppAlert(alert),
  loadAlertedApp: loadAlertedAppRow,
};

/**
 * The spending-cap half of the seat (P-011, R-27): an LLM-running call from a key whose recorded
 * spend has reached its cap is refused. Null = allowed. Fails closed on a missing or failed read.
 */
async function spendCapDenial(
  ref: { appId: string },
  toolName: string,
  deps: EnforceAppKeyScopeDeps,
  now: Date,
): Promise<KernelEnforcementResult | null> {
  if (!LLM_RUNNING_TOOLS.has(toolName)) return null;
  if (!deps.loadSpendStatus) return deny('spend_unavailable', 'the recorded spend cannot be read; no LLM work authorized');
  let status: AppSpendStatus | null;
  try {
    status = await deps.loadSpendStatus(ref.appId, now);
  } catch (err) {
    return deny('spend_unavailable', `the recorded spend cannot be read (${err instanceof Error ? err.message : String(err)}); no LLM work authorized`);
  }
  if (!status) return deny('key_unknown', 'app key no longer exists');
  const verdict = spendCapVerdict(status);
  if (verdict.state === 'near' || verdict.state === 'reached') {
    const windowStartMs = status.windowSec === null
      ? null
      : Math.floor(now.getTime() / (status.windowSec * 1000)) * status.windowSec * 1000;
    const kind = verdict.state === 'near' ? 'spend-cap-near' : 'spend-cap-reached';
    const { raiseAlert, loadAlertedApp } = deps;
    if (raiseAlert && loadAlertedApp) {
      void loadAlertedApp(ref.appId)
        .then((app) => app && raiseAlert({ kind, app, spentCents: verdict.spentCents, capCents: verdict.capCents, windowStartMs }))
        .catch(() => undefined);
    }
  }
  if (verdict.state === 'reached') {
    return deny(
      'spend_cap_reached',
      `this key has spent ${verdict.spentCents.toFixed(0)} of its ${verdict.capCents.toFixed(0)} cent cap; new LLM work is refused until the cap is raised or its window resets`,
    );
  }
  return null;
}

/** The key (and, for an access token, the token) behind an app principal slug. */
export function appPrincipalRefOfSlug(slug: string | null | undefined): { appId: string; tokenId: string | null } | null {
  if (typeof slug !== 'string' || !slug.startsWith(APP_PRINCIPAL_SLUG_PREFIX)) return null;
  const rest = slug.slice(APP_PRINCIPAL_SLUG_PREFIX.length).trim();
  const cut = rest.indexOf(ACCESS_TOKEN_SLUG_SEPARATOR);
  const appId = (cut === -1 ? rest : rest.slice(0, cut)).trim();
  const tokenId = cut === -1 ? null : rest.slice(cut + 1).trim();
  if (!appId || tokenId === '') return null;
  return { appId, tokenId };
}

/**
 * The app key id behind a principal slug, or null when the caller is not an app key. For an
 * access-token principal this is the PARENT key, so spend and activity roll up to the client.
 */
export function appKeyIdOfSlug(slug: string | null | undefined): string | null {
  return appPrincipalRefOfSlug(slug)?.appId ?? null;
}

/**
 * The rows one call is evaluated against: the key's own row, plus the token's row when the
 * principal is an access token. Every row must allow. Null when a row is missing.
 */
async function scopeRowsFor(
  ref: { appId: string; tokenId: string | null },
  deps: EnforceAppKeyScopeDeps,
): Promise<AppScopeRow[] | null> {
  const row = await deps.loadRow(ref.appId);
  if (!row) return null;
  if (!ref.tokenId) return [row];
  const tokenRow = deps.loadAccessTokenRow ? await deps.loadAccessTokenRow(ref.tokenId, ref.appId) : null;
  return tokenRow ? [row, tokenRow] : null;
}

function deny(code: string, reason: string): KernelEnforcementResult {
  const namespaced = `${APP_SCOPE_CODE_PREFIX}${code}`;
  return {
    decision: 'deny',
    availability: 'available',
    applied: true,
    code: namespaced,
    // The code rides in the reason too: some transports (MCP) surface only the reason text,
    // and an app needs the machine-readable code whichever door it used.
    reason: `${namespaced} — ${reason}`,
  };
}

/** Boundaries that execute host binaries directly. No app key may reach one. */
const NATIVE_BOUNDARIES: ReadonlySet<string> = new Set(['native', 'shell']);

/**
 * The tools/list half: which tool names an app key may SEE. Mirrors `enforceAppKeyScope` so a
 * key is never shown a tool it cannot call. One row read per listing. Null when the principal is
 * not an app key (no filter). A failed read hides everything — the listing fails closed too.
 *
 * A tool refused only for `harness_required_by_scope` stays listed: the key CAN call it once it
 * names one of its harnesses, which a listing (with no arguments) cannot know yet.
 */
export async function appKeyToolListFilter(
  principal: { slug?: string | null; workspaceId?: string | null } | null | undefined,
  workspaceId: string | null | undefined,
  deps: EnforceAppKeyScopeDeps = DEFAULT_DEPS,
): Promise<((toolName: string) => boolean) | null> {
  const ref = appPrincipalRefOfSlug(principal?.slug);
  if (!ref) {
    return typeof principal?.slug === 'string' && principal.slug.startsWith(APP_PRINCIPAL_SLUG_PREFIX)
      ? () => false
      : null;
  }
  let rows: AppScopeRow[] | null;
  try {
    rows = await scopeRowsFor(ref, deps);
  } catch {
    return () => false;
  }
  if (!rows) return () => false;
  const now = deps.now?.();
  const ws = workspaceId ?? principal?.workspaceId ?? null;
  return (toolName) => {
    const tool = deps.lookupTool(toolName);
    if (!tool) return false;
    return rows.every((row) => {
      const verdict = evaluateAppScope({ tool, args: undefined, workspaceId: ws, harnessSlug: null, now }, row);
      return verdict.allow || verdict.code === 'harness_required_by_scope';
    });
  };
}

export async function enforceAppKeyScope(
  request: KernelEnforcementRequest,
  deps: EnforceAppKeyScopeDeps = DEFAULT_DEPS,
): Promise<KernelEnforcementResult | null> {
  const principal = request.ctx?.principal ?? null;
  const ref = appPrincipalRefOfSlug(principal?.slug);
  if (!ref) {
    // A slug that CLAIMS the app namespace but names no key is refused, not waved through.
    if (typeof principal?.slug === 'string' && principal.slug.startsWith(APP_PRINCIPAL_SLUG_PREFIX)) {
      return deny('key_unknown', 'the principal names no app key');
    }
    return null;
  }
  try {
    if (NATIVE_BOUNDARIES.has(request.boundary)) {
      return deny('hard_denied', `the ${request.boundary} boundary is never reachable by an app key`);
    }
    const rows = await scopeRowsFor(ref, deps);
    if (!rows) return deny('key_unknown', ref.tokenId ? 'access token no longer exists' : 'app key no longer exists');

    const known = deps.lookupTool(request.toolName);
    const tool: AppScopeTool = known
      ? { ...known, capabilities: [...new Set([...known.capabilities, ...request.capabilities])] }
      : { name: request.toolName, capabilities: [...request.capabilities] };

    const input = {
      tool,
      args: request.args,
      // The workspace the transport dispatched under; the key's own workspace only when the
      // transport named none (the principal's workspace IS the key's, so that half is inert).
      workspaceId: request.ctx.workspaceId ?? principal?.workspaceId ?? null,
      // The CONCRETE transport harness only: operator scope's '*' / 'all' sentinel names
      // no harness, so it must not be matched against the key's harness allowlist.
      harnessSlug: resolveConcreteHarnessSlug(null, request.ctx),
      now: deps.now?.(),
    };
    // The parent key first, then (for an access token) the token's own scope: both must allow.
    for (const row of rows) {
      const verdict = evaluateAppScope(input, row);
      if (!verdict.allow) return deny(verdict.code, verdict.reason);
    }
    // In scope. An LLM-running call must also be under the key's spending cap (R-27).
    return await spendCapDenial(ref, request.toolName, deps, input.now ?? new Date());
  } catch (err) {
    return deny('unavailable', `scope check failed (${err instanceof Error ? err.message : String(err)}); no effect authorized`);
  }
}
