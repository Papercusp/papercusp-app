/**
 * Papercusp's auth-tier → gate-bypass mapping — the host half of plan P-014 /
 * D-006.
 *
 * `@papercusp/tooldef`'s dispatcher reads a neutral `ctx.gateBypass`
 * (`{ role?, capability?, quota? }`) and knows nothing about superuser or
 * power-user tiers. This function encodes the mapping the engine used to
 * hardcode, so the transports can set `ctx.gateBypass` alongside the
 * `isSuperuser`/`isPowerUser` metadata they already populate.
 *
 * The matrix (unchanged from the pre-P-014 baked logic):
 *   - **superuser** (loopback + bearer): bypasses role, capability, AND quota.
 *   - **power-user** (`?power_user=1`): bypasses role + capability for the
 *     operator-tier catalog, but NOT quota — workspace quotas apply to end
 *     users (omp-power-user-bundle-2026-05-20 §4.1). Power-user calls also set
 *     `isSuperuser`, so the carve-out is `quota: superuser && !powerUser`.
 *   - **neither**: no bypass (every gate enforces).
 */

import type { GateBypass } from '@papercusp/tooldef';

/**
 * TESTING-PHASE FULL TOOL ACCESS (owner directive 2026-06-20, EI-2048).
 *
 * While the system is under heavy test, a capability- or role-allowlist gate
 * that silently denies a NEEDED tool masquerades as a different bug and makes
 * debugging harder. So these trusted agent roles get the SAME role+capability
 * bypass as superuser — they should never fail a tool call for lack of a grant.
 *
 * Scope of the bypass: role + capability ONLY. Deliberately NOT quota (cost/
 * rate-limit bugs must still surface) and NOT cross-workspace/identity (unlike
 * a real superuser, these keep their own principal slug + workspace scope, so
 * attribution and RLS are unchanged).
 *
 * RESTRICT LATER: this is a testing-phase widening. To return to least-privilege,
 * the runtime dial `auth:set_full_access_roles` (live-configurability-audit P-019, DARK behind
 * papercusp-auth-config-overrides) REPLACES this baked set, and the runtime master kill-switch is the
 * `papercusp-testing-full-access` flag. Both are reached SYNC through the host-installed resolver below
 * (set by operator-core at boot) — agent-mcp stays free of operator-core + flag/PG IO on the hot path;
 * with no resolver installed, the baked set applies (byte-identical to today). The legacy
 * `PAPERCUSP_TESTING_FULL_ACCESS_ROLES=off` env is KEPT as a test/launch-time override (still honoured
 * first), the flag being the operator-controllable runtime equivalent.
 *
 * KNOWN GAP: the capability-envelope DENY layer (ROLE_ENVELOPES — e.g. overwatch/
 * sentinel denied capability:fs-write/bash) is a SEPARATE gate; this bypass does
 * not lift it. If a watcher role needs code-exec tools under test, lift its
 * envelope too.
 */
export const TESTING_FULL_ACCESS_ROLES: ReadonlySet<string> = new Set([
  'operator',
  'mug',
  'cup',
  'kettle',
  'papercup',
  'blender',
]);

/**
 * Host-installed SYNC resolver (live-configurability-audit P-019). Returns a definitive boolean to
 * OVERRIDE the baked decision (the kill-switch off ⇒ false; the dark override set ⇒ membership in it),
 * or `null`/`undefined` to FALL THROUGH to the baked TESTING_FULL_ACCESS_ROLES set. operator-core
 * installs the real resolver (flag-gated, reading its sync-cached store) at boot; until then the
 * baked set governs.
 */
export type TestingFullAccessResolver = (role: string | null | undefined) => boolean | null | undefined;
let testingFullAccessResolver: TestingFullAccessResolver | undefined;

/** Install (or clear, with `undefined`) the host resolver. Called once by operator-core at boot. */
export function setTestingFullAccessResolver(fn: TestingFullAccessResolver | undefined): void {
  testingFullAccessResolver = fn;
}

export function testingFullAccess(role?: string | null): boolean {
  // Test/launch-time kill-switch (kept; the operator-controllable runtime equivalent is the
  // papercusp-testing-full-access flag, applied via the resolver below).
  if (process.env.PAPERCUSP_TESTING_FULL_ACCESS_ROLES === 'off') return false;
  const override = testingFullAccessResolver?.(role);
  if (typeof override === 'boolean') return override;
  return role != null && TESTING_FULL_ACCESS_ROLES.has(role);
}

export function papercuspGateBypass(opts: {
  isSuperuser?: boolean;
  isPowerUser?: boolean;
  /** Agent role of the caller (signed-URL spawns) — testing-phase full access. */
  role?: string | null;
}): GateBypass {
  const su = opts.isSuperuser === true;
  const pu = opts.isPowerUser === true;
  const testRole = testingFullAccess(opts.role);
  return {
    role: su || testRole,
    capability: su || testRole,
    // testing-phase roles still pass through the quota gate (don't mask cost/
    // rate bugs); only a real superuser (and not power-user) bypasses quota.
    quota: su && !pu,
  };
}
