#!/usr/bin/env node
/**
 * Coarse revocation: rotate the spawn-URL signing key.
 *
 * Why: HMAC-signed per-spawn URLs are valid for `exp` (default 24h)
 * and cannot be individually revoked. If a key may be compromised, or
 * a bad batch of prompts shipped and you want every in-flight spawn
 * to fail closed, run this script. Every URL signed with the old key
 * will fail its next MCP call with `invalid_signature`; the
 * orchestrator will need to re-spawn affected workers.
 *
 * Usage:
 *   bun apps/operator/scripts/rotate-spawn-signing-key.mjs
 *   # or:
 *   node apps/operator/scripts/rotate-spawn-signing-key.mjs --yes
 *
 * Operates on the same harness_shared.operator_secrets row that the
 * operator's spawn-signing.ts module reads + libs/papercusp's
 * spawn-mcp.ts module writes. Both pick up the new key on next access
 * (5-minute in-process cache).
 */
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = new Set(process.argv.slice(2));
const yes = args.has('--yes') || args.has('-y');

// Resolve the admin DSN the same way getHarnessAdminUrl does (this is a plain
// .mjs, so it can't import the TS resolver): env → ~/.papercusp/embedded-pg.json
// `.url` → native fallback. Native PG `papercusp` was renamed `papercusp_legacy`,
// so the bare :5432 default only works on a non-desktop dev box.
function resolveDsn() {
  for (const name of ['HARNESS_ADMIN_DATABASE_URL', 'DATABASE_URL', 'PAPERCUSP_PG_DSN', 'PAPERCUSP_PG_URL']) {
    if (process.env[name]) return process.env[name];
  }
  try {
    const url = JSON.parse(readFileSync(join(homedir(), '.papercusp', 'embedded-pg.json'), 'utf8'))?.url;
    if (url) return url;
  } catch {
    // discovery file absent (desktop not running) — fall through
  }
  return 'postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp';
}

const dsn = resolveDsn();

const sql = postgres(dsn);

try {
  const cur = await sql`
    SELECT value_b64, rotated_at, created_at
    FROM harness_shared.operator_secrets
    WHERE name = 'spawn-signing-key' LIMIT 1
  `;
  if (cur.length === 0) {
    console.log('No spawn-signing-key row yet. The operator will mint one on first MCP call — nothing to rotate.');
    process.exit(0);
  }
  const last = cur[0].rotated_at ?? cur[0].created_at;
  console.log(`Current key: last set at ${last?.toISOString?.() ?? last}`);

  if (!yes) {
    console.log('');
    console.log('Rotating will INVALIDATE every signed per-spawn URL in flight.');
    console.log('All running workers will fail their next MCP call with `invalid_signature`');
    console.log('until the orchestrator re-spawns them with a fresh signed URL.');
    console.log('');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((r) => rl.question('Type ROTATE to confirm: ', r));
    rl.close();
    if (answer.trim() !== 'ROTATE') {
      console.log('Aborted.');
      process.exit(2);
    }
  }

  // Prefer the admin HTTP endpoint when the operator is reachable —
  // it rotates AND bumps the in-process cache, so the new key takes
  // effect within a single request (not the 5-min lazy-cache TTL).
  // Falls back to direct PG rotation only if the operator is down.
  const operatorUrl = process.env.PAPERCUSP_OPERATOR_URL ?? 'http://localhost:3070';
  const tokenPath = process.env.PAPERCUSP_SUPERUSER_TOKEN_FILE
    ?? `${process.env.HOME}/.papercusp/superuser-token`;
  let usedHttp = false;
  try {
    const { readFileSync } = await import('node:fs');
    const bearer = readFileSync(tokenPath, 'utf8').trim();
    const ping = await fetch(`${operatorUrl}/api/admin/spawn-signing/rotate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(10000),
    });
    if (ping.ok) {
      const body = await ping.json();
      console.log(`OK — rotated via operator (rotatedAt=${body.rotatedAt}).`);
      console.log('In-process cache bumped: new key takes effect on next MCP call.');
      usedHttp = true;
    } else {
      const body = await ping.text();
      console.warn(`HTTP rotate returned ${ping.status}: ${body.slice(0, 200)}; falling back to direct PG.`);
    }
  } catch (err) {
    console.warn(`Operator HTTP unreachable (${err instanceof Error ? err.message : err}); falling back to direct PG.`);
  }

  if (!usedHttp) {
    const fresh = randomBytes(32).toString('base64');
    await sql`
      INSERT INTO harness_shared.operator_secrets (name, value_b64, rotated_at)
      VALUES ('spawn-signing-key', ${fresh}, now())
      ON CONFLICT (name) DO UPDATE
        SET value_b64 = EXCLUDED.value_b64, rotated_at = now()
    `;
    console.log('OK — new key persisted directly to PG.');
    console.log('Operator + orchestrator caches expire within 5 minutes.');
    console.log('To force immediate effect, restart the operator process.');
  }
} finally {
  await sql.end({ timeout: 1 });
}
