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
import { APP_PRINCIPAL_SLUG_PREFIX } from './principal';
import { appScopeToolOf, evaluateAppScope, type AppScopeRow, type AppScopeTool } from './scope-policy';
import { loadAppScopeRow } from './store';

/** Denial codes are namespaced so a caller can tell an app-scope refusal from any other. */
export const APP_SCOPE_CODE_PREFIX = 'app_scope:';

export interface EnforceAppKeyScopeDeps {
  loadRow: (id: string) => Promise<AppScopeRow | null>;
  lookupTool: (name: string) => AppScopeTool | undefined;
  now?: () => Date;
}

const DEFAULT_DEPS: EnforceAppKeyScopeDeps = {
  loadRow: loadAppScopeRow,
  lookupTool: (name) => {
    const tool = lookupByMcpName(name);
    return tool ? appScopeToolOf(name, tool) : undefined;
  },
};

/** The app key id behind a principal slug, or null when the caller is not an app key. */
export function appKeyIdOfSlug(slug: string | null | undefined): string | null {
  if (typeof slug !== 'string' || !slug.startsWith(APP_PRINCIPAL_SLUG_PREFIX)) return null;
  const id = slug.slice(APP_PRINCIPAL_SLUG_PREFIX.length).trim();
  return id || null;
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
  const appId = appKeyIdOfSlug(principal?.slug);
  if (!appId) {
    return typeof principal?.slug === 'string' && principal.slug.startsWith(APP_PRINCIPAL_SLUG_PREFIX)
      ? () => false
      : null;
  }
  let row: AppScopeRow | null;
  try {
    row = await deps.loadRow(appId);
  } catch {
    return () => false;
  }
  if (!row) return () => false;
  const now = deps.now?.();
  const ws = workspaceId ?? principal?.workspaceId ?? null;
  return (toolName) => {
    const tool = deps.lookupTool(toolName);
    if (!tool) return false;
    const verdict = evaluateAppScope({ tool, args: undefined, workspaceId: ws, harnessSlug: null, now }, row);
    return verdict.allow || verdict.code === 'harness_required_by_scope';
  };
}

export async function enforceAppKeyScope(
  request: KernelEnforcementRequest,
  deps: EnforceAppKeyScopeDeps = DEFAULT_DEPS,
): Promise<KernelEnforcementResult | null> {
  const principal = request.ctx?.principal ?? null;
  const appId = appKeyIdOfSlug(principal?.slug);
  if (!appId) {
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
    const row = await deps.loadRow(appId);
    if (!row) return deny('key_unknown', 'app key no longer exists');

    const known = deps.lookupTool(request.toolName);
    const tool: AppScopeTool = known
      ? { ...known, capabilities: [...new Set([...known.capabilities, ...request.capabilities])] }
      : { name: request.toolName, capabilities: [...request.capabilities] };

    const verdict = evaluateAppScope(
      {
        tool,
        args: request.args,
        // The workspace the transport dispatched under; the key's own workspace only when the
        // transport named none (the principal's workspace IS the key's, so that half is inert).
        workspaceId: request.ctx.workspaceId ?? principal?.workspaceId ?? null,
        // The CONCRETE transport harness only: operator scope's '*' / 'all' sentinel names
        // no harness, so it must not be matched against the key's harness allowlist.
        harnessSlug: resolveConcreteHarnessSlug(null, request.ctx),
        now: deps.now?.(),
      },
      row,
    );
    return verdict.allow ? null : deny(verdict.code, verdict.reason);
  } catch (err) {
    return deny('unavailable', `scope check failed (${err instanceof Error ? err.message : String(err)}); no effect authorized`);
  }
}
