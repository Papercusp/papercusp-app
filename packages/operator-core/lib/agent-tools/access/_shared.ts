/**
 * Shared seam for the access:* tools (plan external-app-access-to-workspaces-2026-09-29 P-012,
 * WI-10004025): let a user ask an agent to list, create, pause and revoke the keys outside apps
 * use to reach this workspace.
 *
 * LOCAL-ONLY, enforced three ways:
 *  1. `access` is a hard-denied group (connected-apps/scope-policy.ts), so no app key can ever be
 *     scoped to call these tools — an outside app cannot mint or manage keys.
 *  2. {@link localOnlyRefusal} refuses a call made BY an app-key principal, whatever its scopes
 *     say (defense in depth under rule 1).
 *  3. {@link localOnlyRefusal} refuses a call that arrived through the external-ingress listener
 *     (auth/forwarded-request-trust.ts), so a tunnelled or relayed request never manages access.
 *
 * The store (connected-apps/store.ts) is the only writer; these tools add nothing to it. A key
 * secret is returned exactly once, by access:create, and never stored or listed.
 */
import type { AppKeyRow } from '../../connected-apps/store';

/** The same creator the Connect-an-app screen records for a key made at this computer. */
export const ACCESS_TOOL_CREATOR_EMAIL = 'local@desktop';

export interface AccessToolCallContext {
  principal?: { slug?: string | null; workspaceId?: string | null } | null;
}

export interface AccessToolDeps {
  /** The external-ingress listener serving this call, or null (see forwarded-request-trust). */
  externalIngressListener: () => string | null;
  /** Prefix every app-key principal slug carries (connected-apps/principal.ts). */
  appPrincipalPrefix: string;
}

export async function defaultAccessToolDeps(): Promise<AccessToolDeps> {
  const [{ currentExternalIngressListener }, { APP_PRINCIPAL_SLUG_PREFIX }] = await Promise.all([
    import('../../auth/forwarded-request-trust'),
    import('../../connected-apps/principal'),
  ]);
  return { externalIngressListener: currentExternalIngressListener, appPrincipalPrefix: APP_PRINCIPAL_SLUG_PREFIX };
}

/** A refusal code when this call may not manage access, or null when it may. */
export function localOnlyRefusal(ctx: AccessToolCallContext | undefined, deps: AccessToolDeps): string | null {
  const slug = ctx?.principal?.slug;
  if (typeof slug === 'string' && slug.startsWith(deps.appPrincipalPrefix)) return 'app_key_caller';
  if (deps.externalIngressListener() !== null) return 'external_ingress';
  return null;
}

/** The workspace a call acts on: an explicit arg, else the caller's, else the active one. */
export async function accessWorkspaceId(argWorkspaceId: string | undefined, ctx: AccessToolCallContext | undefined): Promise<string> {
  if (argWorkspaceId) return argWorkspaceId;
  const principalWs = ctx?.principal?.workspaceId;
  if (principalWs && principalWs !== '*') return principalWs;
  const { activeWorkspaceId } = await import('../../workspace-registry');
  return activeWorkspaceId();
}

/** What a tool shows of a key: never its secret or either hash. */
export function accessKeyView(app: AppKeyRow) {
  return {
    id: app.id,
    kind: app.kind,
    label: app.label,
    workspaceId: app.workspace_id,
    createdBy: app.user_email,
    scopes: app.scopes,
    status: app.revoked_at ? 'revoked' : app.paused_at ? 'paused' : app.expires_at && app.expires_at.getTime() <= Date.now() ? 'expired' : 'active',
    createdAt: app.paired_at,
    expiresAt: app.expires_at,
    pausedAt: app.paused_at,
    revokedAt: app.revoked_at,
    lastUsedAt: app.last_seen,
    spendCap: app.spend_cap_cents === null ? null : { cents: app.spend_cap_cents, windowSec: app.spend_cap_window_sec },
    rotatedAt: app.rotated_at,
  };
}

export function jsonResult(value: unknown, isError = false) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], isError };
}

export function refusedResult(error: string, detail?: Record<string, unknown>) {
  return jsonResult({ ok: false, error, ...detail }, true);
}
