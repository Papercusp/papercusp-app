import type { Sql } from 'postgres';
import type { PersonalPrincipal, PersonalToolContext } from './types';
import { isPersonalVaultEnabled, personalScope } from './store';

import { isCodingAgentRole } from './coding-roles';

// Re-exported so existing importers keep their entry point; the predicate itself
// lives in the browser-safe leaf so the settings UI can share it (WI-10001809).
export { isCodingAgentRole };

export function contextualPersonalPrincipals(ctx: PersonalToolContext): PersonalPrincipal[] {
  const out: PersonalPrincipal[] = [];
  if (ctx.featureId?.trim()) out.push({ type: 'binding', id: ctx.featureId.trim() });
  if (ctx.role?.trim()) out.push({ type: 'agent-role', id: ctx.role.trim() });
  return out;
}

async function planTemplatePrincipal(
  sql: Sql,
  workspaceId: string,
  planRunSessionId: string | null | undefined,
): Promise<PersonalPrincipal | null> {
  if (!planRunSessionId?.trim()) return null;
  const rows = await sql<Array<{ principal_id: string }>>`
    SELECT COALESCE(NULLIF(p.template_slug, ''), r.plan_slug) AS principal_id
      FROM harness_shared.plan_runs r
      LEFT JOIN harness_shared.harness_plans p
        ON p.workspace_id = r.workspace_id
       AND p.harness_slug = r.harness_slug
       AND p.plan_slug = COALESCE(r.instance_plan_slug, r.plan_slug)
     WHERE r.workspace_id = ${workspaceId} AND r.session_id = ${planRunSessionId}
     ORDER BY r.id DESC LIMIT 1`;
  return rows[0]?.principal_id
    ? { type: 'plan-template', id: rows[0].principal_id }
    : null;
}

export interface PersonalAuthorization {
  allowed: boolean;
  reason?: 'coding_agent_denied' | 'vault_disabled' | 'no_bound_principal' | 'no_live_grant' | 'scope_not_granted';
  scopes: string[];
  principal: PersonalPrincipal | null;
}

export async function authorizePersonalAccess(
  sql: Sql,
  ctx: PersonalToolContext,
  workspaceId: string,
  userId: string,
  requestedScopes: string[] = [],
): Promise<PersonalAuthorization> {
  // D-001's absolute fence: a grant never turns a coding/review role into a
  // personal-data principal. Meeting-prep runs enter through a plan-template
  // session and do not carry one of these engineering roles.
  if (isCodingAgentRole(ctx.role)) {
    return { allowed: false, reason: 'coding_agent_denied', scopes: [], principal: null };
  }
  if (!(await isPersonalVaultEnabled(sql, workspaceId, userId))) {
    return { allowed: false, reason: 'vault_disabled', scopes: [], principal: null };
  }
  const plan = await planTemplatePrincipal(sql, workspaceId, ctx.planRunSessionId);
  const principals = [...(plan ? [plan] : []), ...contextualPersonalPrincipals(ctx)];
  if (!principals.length) {
    return { allowed: false, reason: 'no_bound_principal', scopes: [], principal: null };
  }
  const rows = await sql<Array<{
    principal_type: PersonalPrincipal['type']; principal_id: string; scopes: string[];
  }>>`
    SELECT principal_type, principal_id, scopes
      FROM harness_shared.personal_grants
     WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
       AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`;
  const matches = rows.filter((g) => principals.some((p) => p.type === g.principal_type && p.id === g.principal_id));
  if (!matches.length) {
    return { allowed: false, reason: 'no_live_grant', scopes: [], principal: principals[0] ?? null };
  }
  const granted = [...new Set(matches.flatMap((g) => g.scopes.map(personalScope)))].sort();
  const requested = [...new Set(requestedScopes.map(personalScope))];
  if (requested.some((scope) => !granted.includes(scope))) {
    return { allowed: false, reason: 'scope_not_granted', scopes: granted, principal: principals[0] ?? null };
  }
  const winner = principals.find((p) => matches.some((g) => g.principal_type === p.type && g.principal_id === p.id)) ?? null;
  return { allowed: true, scopes: requested.length ? requested : granted, principal: winner };
}
