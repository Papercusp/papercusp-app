/**
 * The ONE definition of the SU-TIER ROLES — EI-996.
 *
 * WHY THIS FILE IS PLAIN .mjs
 *
 * Both sides of the su-tier launch path need this list:
 *   • `apps/operator/scripts/psu-launcher.mjs` — bare `node`, unbundled, cannot
 *     import TypeScript. It decides whether a `--role=<x>` launch is routed to
 *     the role bootstrap or falls through to the SU flow.
 *   • `packages/operator-core/lib/su-role-addendum.ts` (→ bootstrap-su) — the
 *     server-side allow-list that 400s an unknown `su_role`.
 *
 * A copy on each side would be two lists that drift silently, and the failure is
 * quiet in the worst direction: a role added to the launcher but not the server
 * 400s at boot, and one added to the server but not the launcher keeps launching
 * on the OLD role tier while looking configured. Same shape (and same reasoning)
 * as `apps/operator/lib/mcp-proxy/budgets.mjs`: plain ESM here + a `.d.mts`
 * sibling so TypeScript callers stay type-checked without a build step.
 *
 * ⚠ MEMBERSHIP OF THIS LIST IS A SECURITY DECISION. A su-tier role launches with
 * the full engineer playbook AND the SUPERUSER MCP tier — it is a privilege
 * escalation relative to a role-scoped session. `planner` is here because the
 * owner asked for it explicitly (2026-06-17): planners should "be full su agents
 * and get the full su prompt, but just a few lines added about their planner
 * role." Do not add a role here casually.
 */

/**
 * Roles that launch as a full su agent (engineer playbook + superuser MCP) plus
 * a short role addendum, instead of via the role-scoped bootstrap.
 *
 * Planner's behavior comes from the built-in `su.specialist-planner` identity.
 * Admission remains this closed list; selecting an arbitrary identity cannot
 * mint a superuser principal.
 */
export const SU_TIER_ROLES = ['planner'];

/** Is this role name one that launches on the su tier? */
export function isSuTierRole(role) {
  return !!role && SU_TIER_ROLES.includes(role);
}

/** The addendum prompt-source filename for a su-tier role. Pure. */
export function suRoleAddendumFileName(role) {
  return `su-role-${role}.addendum.md`;
}
