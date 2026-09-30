import { defineConfig } from 'drizzle-kit';
import { resolveAdminUrl } from './src/resolve-cli-admin-url.mjs';

// Resolve PG URL: env > discovery file (~/.papercusp/embedded-pg.json,
// written by the desktop's Rust main on embedded-PG ready, LIVENESS-checked
// — pid alive + port actually listening) > native :5432 fallback. Lets
// `drizzle-kit pull` introspect the embedded PG when the desktop is running,
// instead of always hitting native :5432. See resolve-cli-admin-url.mjs for
// why this is no longer a hand-rolled fs.readFileSync (EI-19949168182332635:
// a STALE discovery file silently won over the live native fallback and
// drizzle-kit failed with a content-free "0 tables fetching" that read
// exactly like a DB outage).

/**
 * Drizzle config — INTROSPECTION ONLY.
 *
 * The `.sql` files in ./sql/ are the source of truth for DDL. This
 * config exists so `drizzle-kit pull` (alias: introspect) can regenerate
 * `src/schema/generated.ts` and `src/schema/generated-relations.ts`
 * from the live `papercusp` database after any new `.sql` migration.
 *
 * **Never run `drizzle-kit generate` or `drizzle-kit push` in this repo.**
 * They would produce broken DDL for tsvector generated columns, RLS
 * policies, the `ALTER PUBLICATION` calls, and the BEFORE INSERT
 * triggers. The `.sql` files cover all of those; Drizzle just mirrors.
 *
 * See PHASE0-AUDIT.md for known introspection quirks in v0.31.10.
 */
export default defineConfig({
  dialect: 'postgresql',
  schemaFilter: ['harness_shared', 'papercusp_shared'],
  out: './src/schema',
  dbCredentials: {
    url: resolveAdminUrl(),
  },
  introspect: {
    casing: 'camel',
  },
});
