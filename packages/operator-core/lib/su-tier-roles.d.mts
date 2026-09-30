/**
 * Types for the shared su-tier role list (EI-996).
 *
 * su-tier-roles.mjs must stay plain ESM so psu-launcher.mjs (bare `node`,
 * unbundled) can import the same definition the TypeScript server path uses.
 * This declaration keeps the TypeScript callers type-checked without forcing a
 * build step on the launcher. Same shape as `apps/operator/lib/mcp-proxy/budgets.d.mts`.
 */

/** Roles that launch as a full su agent (engineer playbook + SUPERUSER MCP tier). */
export const SU_TIER_ROLES: readonly string[];

/** Is this role name one that launches on the su tier? */
export function isSuTierRole(role: string | null | undefined): boolean;

/** The addendum prompt-source filename for a su-tier role. Pure. */
export function suRoleAddendumFileName(role: string): string;
