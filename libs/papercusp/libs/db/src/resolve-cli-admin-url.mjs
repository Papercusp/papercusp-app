/**
 * Resolve the admin Postgres URL for the db-org CLI tooling (pull-schema.mjs,
 * drizzle.config.ts) — env > discovery-file > native-fallback, the SAME
 * resolution order `getHarnessAdminUrl()` uses at runtime
 * (packages/operator-core/lib/embedded-pg-discovery.ts) — via the shared
 * zero-domain-coupling primitive (`@papercusp/embedded-pg-discovery`'s
 * `resolvePgUrl`) rather than operator-core itself: db-org must NOT depend on
 * operator-core (see connect-retry.ts's layering note; @papercusp/db-org is a
 * dependency OF operator-core, so the reverse import would be circular).
 *
 * WHY THIS EXISTS (EI-19949168182332635): both pull-schema.mjs and
 * drizzle.config.ts used to hand-roll their OWN discovery-file read — a bare
 * `fs.readFileSync` + `JSON.parse` with no liveness check. The discovery file
 * is written once at desktop-boot and never cleaned up on an unclean exit, so
 * a STALE file (embedded PG crashed / desktop closed) silently wins over the
 * live native-PG fallback: `drizzle-kit pull` then connects to a dead port and
 * fails with a content-free "0 tables fetching ... drizzle-kit pull failed" —
 * indistinguishable from a real DB outage or an empty schema. `resolvePgUrl`
 * carries BOTH liveness gates (pid alive + port actually LISTENING via
 * /proc/net/tcp) that a hand-rolled read cannot cheaply replicate — reuse it
 * rather than re-diverging.
 */
import { resolvePgUrl } from '@papercusp/embedded-pg-discovery';
import { join } from 'node:path';

export const NATIVE_FALLBACK_ADMIN_URL =
  'postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp';

function discoveryFilePath() {
  // EI-13917 precedent (mirrored from embedded-pg-discovery.ts): honor an
  // isolated PAPERCUSP_HOME before the box-wide ~/.papercusp/.
  return process.env.PAPERCUSP_HOME
    ? join(process.env.PAPERCUSP_HOME, 'embedded-pg.json')
    : '.papercusp/embedded-pg.json';
}

/** { url, source: 'env' | 'discovery-file' | 'fallback' } */
export function resolveAdminUrlWithSource() {
  return resolvePgUrl({
    envVars: ['HARNESS_ADMIN_DATABASE_URL', 'DATABASE_URL', 'PAPERCUSP_PG_URL'],
    // PAPERCUSP_SKIP_PG_DISCOVERY=1 precedent (connection.ts, setup-hermetic-env.ts,
    // setup-no-real-pg.ts, …) — an isolated test/gate context that wants to force the
    // native fallback rather than risk picking up a box-wide discovery file.
    discoveryFile:
      process.env.PAPERCUSP_SKIP_PG_DISCOVERY === '1'
        ? undefined
        : { path: discoveryFilePath() },
    fallbackUrl: NATIVE_FALLBACK_ADMIN_URL,
  });
}

export function resolveAdminUrl() {
  return resolveAdminUrlWithSource().url;
}

/** Redact the password for safe printing (diagnostics, logs). */
export function redactAdminUrl(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = '****';
    return u.toString();
  } catch {
    return url;
  }
}
