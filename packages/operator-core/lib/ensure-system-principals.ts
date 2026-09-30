/**
 * Single source of truth for the system:<name> principal capability sets + the
 * provision loop that writes them. Used by BOTH the manual provision route
 * (POST /api/agent-mcp/provision) AND the boot-time auto-heal (host-bootstrap),
 * so the cap lists can't drift between the two call sites.
 *
 * EI-2048: the cap lists USED to live inline in the provision route, and a cap
 * added there (operator's memory + locks grant, 2026-06-20) only reached a live
 * `system_principals` row if someone re-POSTed provision — and the only force that
 * applied it rotated the bearer (breaking live connections). With
 * `provisionSystemPrincipal` now reconciling caps additively in place (no
 * rotation — see provisioning.ts), a forceless call from boot self-heals cap
 * drift on every deploy. This module is what boot calls.
 */
import { provisionSystemPrincipal } from '@papercusp/agent-mcp/provisioning';

/** Oracle (read-mostly survey) principal capabilities. */
export const ORACLE_CAPS = [
  'tasks:read',
  'goals:read',
  'harness:read',
  'docs:read',
  'messages:read',
  'audit:read',
  'intel:read',
  'search:read',
  'messages:write',
] as const;

/** Operator (the psu primary surface) capabilities = oracle + the read/write pairs
 *  the Pot operator surveys + curates each wake. Keep in lock-step with
 *  BLUEPRINT_ROLE_CAPS['operator'] (role-principal-caps.ts) — they union at load. */
export const OPERATOR_CAPS = [
  ...ORACLE_CAPS,
  'tasks:write',
  'proposals:write',
  'goals:write',
  'routines:write',
  'chat:write',
  // autoloop-pot-operator-rebuild P-004 — survey + harness-management surface.
  'harness:write',
  'work_items:read',
  'work_items:write',
  'curation:read',
  'activity:read',
  'coord:read',
  'coord:write',
  'plans:read',
  // EI-2048 (2026-06-20): the role=operator psu surface needs memory caps to curate
  // memory (the `bee` role already carries them for "psu engineering parity").
  'memory:read',
  'memory:write',
  // EI-2048 follow-up: same omission class — db:next-migration / db:check_drift /
  // multi-file holds need locks:*; the lower-privileged `bee` already carries them.
  'locks:read',
  'locks:write',
] as const;

export interface EnsuredPrincipal {
  name: string;
  /** A new bearer was minted (initial provision or `force` rotation). */
  rotated: boolean;
  /** An existing principal's caps were brought up to the code set in place (no rotation). */
  reconciled: boolean;
  configPath: string | null;
}

/**
 * Provision (or, for an existing row, additively reconcile) the system:oracle +
 * system:operator principals for a workspace. Forceless by default — safe to call
 * repeatedly (idempotent; a current row is a no-op, a drifted one reconciles in
 * place without rotating its bearer). Pass `force: true` only to rotate bearers.
 */
export async function provisionSystemPrincipals(opts: {
  workspaceId: string;
  papercuspRoot: string;
  force?: boolean;
}): Promise<EnsuredPrincipal[]> {
  const out: EnsuredPrincipal[] = [];
  for (const [name, caps] of [
    ['oracle', ORACLE_CAPS],
    ['operator', OPERATOR_CAPS],
  ] as const) {
    const r = await provisionSystemPrincipal({
      workspaceId: opts.workspaceId,
      name,
      capabilities: [...caps],
      papercuspRoot: opts.papercuspRoot,
      force: opts.force,
    });
    out.push(
      r
        ? { name: r.name, rotated: r.rotated, reconciled: r.reconciled === true, configPath: r.configPath }
        : { name, rotated: false, reconciled: false, configPath: null },
    );
  }
  return out;
}
