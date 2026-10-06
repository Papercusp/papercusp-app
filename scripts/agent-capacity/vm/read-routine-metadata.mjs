// Runs ON a Papercusp Server .deb VM, under the package's own node (the .deb ships no psql):
//   sudo "/usr/lib/Papercusp Server/sidecar/bin/node" read-routine-metadata.mjs <pgPort> <installSlug> [routine] [key]
// Reads harness_shared.routines.metadata-><key> for the routine on that install (default: the
// git-sync routine's worktree_divergence, plan agent-capacity-and-cost-gcp-2026-09-30 D-055) from the
// Server's embedded Postgres and prints ONE line the driver greps:
//   ROUTINE_META slug=<installSlug> routine=<routine> key=<key> rows=<n> value=<compact JSON | null>
// rows=0 means no such routine row (value=null too), so "not recorded" and "no row" stay distinct.
// Errors print ROUTINE_META_ERROR <message> and exit 1; usage errors exit 2.
// The embedded PG port changes on every restart: the driver reads it from `ss -ltnp` first.
// PAPERCUSP_PG_REQUIRE_FROM / PAPERCUSP_PG_URL override the pg module anchor and the URL (tests).
import { createRequire } from 'node:module';

const [port, slug, routine = 'git-sync', key = 'worktree_divergence'] = process.argv.slice(2);
if (!/^[0-9]+$/.test(port ?? '') || !slug) {
  console.error('usage: read-routine-metadata.mjs <pgPort> <installSlug> [routine] [key]');
  process.exit(2);
}
const anchor =
  process.env.PAPERCUSP_PG_REQUIRE_FROM ??
  '/usr/lib/Papercusp Server/sidecar/node_modules/@papercusp/embedded-postgres-server/x.js';
// The embedded Server's local-only admin role; not a secret (it listens on 127.0.0.1 only).
const url = process.env.PAPERCUSP_PG_URL ?? `postgres://harness_admin:${'harness_admin_pwd'}@127.0.0.1:${port}/papercusp`;

let client;
try {
  const { Client } = createRequire(anchor)('pg');
  client = new Client({ connectionString: url });
  await client.connect();
  const { rows } = await client.query(
    'SELECT metadata -> $3 AS v FROM harness_shared.routines WHERE install_slug = $1 AND name = $2',
    [slug, routine, key],
  );
  const value = rows.find((r) => r.v != null)?.v ?? null;
  console.log(`ROUTINE_META slug=${slug} routine=${routine} key=${key} rows=${rows.length} value=${JSON.stringify(value)}`);
} catch (e) {
  console.log(`ROUTINE_META_ERROR ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  await client?.end().catch(() => {});
}
