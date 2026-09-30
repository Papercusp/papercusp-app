#!/usr/bin/env node
// Can the dev operator reach the database hono-host would use?
//
// `npm run dev` starts apps/operator/bin/hono-host.ts, which ASSUMES Postgres is
// already up: it resolves the admin URL exactly as getHarnessAdminUrl() does
// (packages/operator-core/lib/embedded-pg-discovery.ts) — env vars, then the
// embedded-pg.json discovery file, then native localhost:5432 as harness_admin.
// A developer box has one of those. A fresh clone has none, so hono-host
// crash-looped on "password authentication failed for user harness_admin"
// (open-source-release-2026-09-29 R-18 fresh-VM build). dev-operator-ifneeded.sh
// uses this probe to fall back to bin/serve.ts, which starts its own embedded
// Postgres — what the public README promises.
//
// Exit 0: reachable (print "reachable <source>"). Exit 1: not reachable.
// Usage: node dev-operator-pg-probe.mjs [--repo-root <dir>]

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ENV_VARS = ['HARNESS_ADMIN_DATABASE_URL', 'DATABASE_URL', 'PAPERCUSP_PG_URL'];
const NATIVE_FALLBACK = 'postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp';

/** Same order as getHarnessAdminUrlWithSource(); kept pure for tests. */
export function resolveDevPgUrl(env = process.env, home = homedir()) {
  for (const name of ENV_VARS) {
    if (env[name]) return { url: env[name], source: `env:${name}` };
  }
  if (env.PAPERCUSP_SKIP_PG_DISCOVERY !== '1') {
    const rel = env.PAPERCUSP_HOME ? join(env.PAPERCUSP_HOME, 'embedded-pg.json') : '.papercusp/embedded-pg.json';
    const file = isAbsolute(rel) ? rel : join(home, rel);
    if (existsSync(file)) {
      try {
        const doc = JSON.parse(readFileSync(file, 'utf8'));
        if (typeof doc.url === 'string' && doc.url) return { url: doc.url, source: 'discovery' };
      } catch {
        /* unreadable discovery file: fall through, as the resolver does */
      }
    }
  }
  const port = Number(env.PAPERCUSP_PG_PORT);
  if (Number.isInteger(port) && port > 0 && port <= 65_535) {
    return { url: `postgresql://harness_admin:harness_admin_pwd@localhost:${port}/papercusp`, source: 'native-fallback' };
  }
  return { url: NATIVE_FALLBACK, source: 'native-fallback' };
}

async function probe(url, repoRoot) {
  const require = createRequire(pathToFileURL(join(repoRoot, 'package.json')));
  const postgres = require('postgres');
  const sql = postgres(url, { max: 1, connect_timeout: 3, idle_timeout: 1, onnotice: () => {} });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

async function main(argv) {
  const i = argv.indexOf('--repo-root');
  const repoRoot = resolve(i >= 0 ? argv[i + 1] : join(fileURLToPath(new URL('.', import.meta.url)), '..', '..'));
  const { url, source } = resolveDevPgUrl();
  if (await probe(url, repoRoot)) {
    console.log(`reachable ${source}`);
    return 0;
  }
  console.log(`unreachable ${source}`);
  return 1;
}

// realpath both sides: node realpaths import.meta.url but keeps argv[1] as invoked.
const self = realpathSync(fileURLToPath(import.meta.url));
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === self) {
  main(process.argv.slice(2)).then((c) => process.exit(c), () => process.exit(1));
}
