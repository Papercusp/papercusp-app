/**
 * p2p/sandbox/pg-credential-isolation.ts — P-105 §3.2: the second X1 loopback
 * leg (DESIGN-p2p-P105-…md §3). A foreign session must never inherit
 * `DATABASE_URL` or resolve an admin credential via `getHarnessAdminUrl()` —
 * per the ratified decision it either gets its own scoped credential, or (v1)
 * NO Postgres access at all, forcing all state through the coord plane (which
 * already denies foreign sessions settings/grants mutation and secrets tools
 * per P-104's C2 capability envelope).
 *
 * v1 posture implemented here: NO PG access. `buildForeignProcessEnv` returns
 * an env object that is the host env MINUS every admin-PG-shaped variable, so
 * a foreign session spawned with it cannot resolve a live connection string
 * even if it inherits everything else. `assertNoAdminPgAccess` is the
 * complementary guard a supervision sweep (or a test) can run against a
 * foreign session's actual env to catch a leak.
 */

/** Every env var whose presence would hand a foreign session a live admin PG
 *  connection string, directly or via a resolver fallback. Deliberately
 *  case-sensitive + exact-match (no prefix guessing) so this stays legible
 *  and auditable — extend explicitly when a new admin-PG env var is added. */
export const ADMIN_PG_ENV_KEYS: readonly string[] = [
  'DATABASE_URL',
  'PAPERCUSP_DATABASE_URL',
  'PGHOST',
  'PGPORT',
  'PGUSER',
  'PGPASSWORD',
  'PGDATABASE',
  'PG_ADMIN_URL',
];

export interface AdminPgAccessViolation {
  ok: false;
  violation: string;
  offendingKeys: string[];
}
export type AdminPgAccessCheck = { ok: true } | AdminPgAccessViolation;

/** Fail-closed scan: any ADMIN_PG_ENV_KEYS entry present (even empty-string —
 *  a blank value can still satisfy a truthy-check resolver bug) is a
 *  violation. Returns every offending key, not just the first, so a fix
 *  addresses the whole leak in one pass. */
export function assertNoAdminPgAccess(env: NodeJS.ProcessEnv | Record<string, string | undefined>): AdminPgAccessCheck {
  const offendingKeys = ADMIN_PG_ENV_KEYS.filter((k) => env[k] !== undefined);
  if (offendingKeys.length > 0) {
    return {
      ok: false,
      violation: `foreign session env carries admin-PG-shaped var(s): ${offendingKeys.join(', ')} — X1 leg 2 violated`,
      offendingKeys,
    };
  }
  return { ok: true };
}

/**
 * Build the env a foreign session should be spawned with: the host env,
 * minus every ADMIN_PG_ENV_KEYS entry. Pure (does not mutate `hostEnv`).
 * v1: no replacement scoped credential is issued (no-PG-access posture); a
 * later build lane may add one and this becomes the seam that installs it.
 */
export function buildForeignProcessEnv(hostEnv: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...hostEnv };
  for (const k of ADMIN_PG_ENV_KEYS) delete out[k];
  return out;
}
