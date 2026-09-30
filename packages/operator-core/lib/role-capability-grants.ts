/**
 * Runtime role→capability grants (live-configurability-audit-2026-06-20 P-008).
 *
 * The role→capability grant map is otherwise a code literal (BLUEPRINT_ROLE_CAPS) + the
 * provisioned system_principals rows — so unblocking a role that lacks a capability is a code
 * edit + redeploy (the recurring `owner-fix` trap in role-principal-caps.ts). This module is the
 * store for runtime grants: `loadRoleCapabilities` unions these in (flag-gated by
 * CAPABILITY_GRANT_TOOL), and capability:grant_role / capability:revoke_role write them.
 *
 * SHIPS DARK: the union is flag-gated and the grant tool refuses while the flag is off, so the
 * table stays empty + ignored until the owner ratifies (D-007 owner-authority).
 *
 * Registers as a runtime-config override concern so config:list-overrides surfaces grants and
 * config:reset-overrides can wipe them (the mid-incident "revoke all runtime grants" lever).
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from './workspace-registry';
import { registerOverrideConcern, type OverrideEntry } from './config-overrides/registry';

export interface RoleGrant {
  role: string;
  capabilities: string[];
}

/** The granted caps for one role in the active workspace (empty if none). */
export async function readGrants(role: string): Promise<string[]> {
  const { sql } = getOrgPg();
  const ws = activeWorkspaceId();
  const rows = await sql<Array<{ capabilities: unknown }>>`
    SELECT capabilities FROM harness_shared.role_capability_grants
     WHERE workspace_id = ${ws} AND role = ${role} LIMIT 1`;
  const raw = rows[0]?.capabilities;
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
}

/** Set the EXACT grant set for a role (dedup+sorted); empty clears the row. Returns the new set. */
export async function writeGrants(role: string, caps: string[]): Promise<string[]> {
  const { sql } = getOrgPg();
  const ws = activeWorkspaceId();
  const unique = [...new Set(caps)].sort();
  if (unique.length === 0) {
    await sql`DELETE FROM harness_shared.role_capability_grants WHERE workspace_id = ${ws} AND role = ${role}`;
  } else {
    await sql`
      INSERT INTO harness_shared.role_capability_grants (workspace_id, role, capabilities, updated_at)
      VALUES (${ws}, ${role}, ${JSON.stringify(unique)}::text::jsonb, ${Date.now()})
      ON CONFLICT (workspace_id, role)
        DO UPDATE SET capabilities = EXCLUDED.capabilities, updated_at = EXCLUDED.updated_at`;
  }
  return unique;
}

/** Add caps to a role's grant set (union). Returns the new set. */
export async function grantCaps(role: string, add: string[]): Promise<string[]> {
  const current = await readGrants(role);
  return writeGrants(role, [...current, ...add]);
}

/** Remove caps from a role's grant set. Returns the new set. */
export async function revokeCaps(role: string, remove: string[]): Promise<string[]> {
  const current = await readGrants(role);
  const rm = new Set(remove);
  return writeGrants(role, current.filter((c) => !rm.has(c)));
}

/** All role→caps grant rows in the active workspace. */
export async function listAllGrants(): Promise<RoleGrant[]> {
  const { sql } = getOrgPg();
  const ws = activeWorkspaceId();
  const rows = await sql<Array<{ role: string; capabilities: unknown }>>`
    SELECT role, capabilities FROM harness_shared.role_capability_grants
     WHERE workspace_id = ${ws} ORDER BY role`;
  return rows.map((r) => ({
    role: r.role,
    capabilities: Array.isArray(r.capabilities) ? r.capabilities.filter((x): x is string => typeof x === 'string') : [],
  }));
}

// Self-register as a runtime-config override concern (P-024 registry): grants show up in
// config:list-overrides, and config:reset-overrides can wipe them (revoke all runtime grants).
registerOverrideConcern({
  name: 'role-capability-grants',
  description: 'runtime role→capability grants (capability:grant_role; gated by papercusp-capability-grant-tool)',
  auditAction: 'capability:grant_role',
  diff: async () => {
    const all = await listAllGrants();
    return all
      .filter((g) => g.capabilities.length > 0)
      .map((g): OverrideEntry => ({ key: g.role, effective: g.capabilities, layer: 'pg-grants' }));
  },
  capture: () => listAllGrants(),
  reset: async () => {
    const { sql } = getOrgPg();
    const ws = activeWorkspaceId();
    await sql`DELETE FROM harness_shared.role_capability_grants WHERE workspace_id = ${ws}`;
    return [] as RoleGrant[];
  },
  restore: async (snap) => {
    for (const g of snap as RoleGrant[]) await writeGrants(g.role, g.capabilities);
  },
});
