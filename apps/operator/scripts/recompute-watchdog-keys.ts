/**
 * recompute-watchdog-keys.ts — the deliberate POST-DEPLOY backfill that migrates
 * open improvement-EI watchdogKeys to the current key shape
 * (watchdog-and-exposed-systems-improvement-2026-06-18 P-012).
 *
 * WHEN to run: ONCE, AFTER the new watchdog collector has DEPLOYED (the staging→
 * green→release pipeline carries it to :3070). Running it BEFORE the new collector
 * is live would migrate keys the live (old) collector doesn't yet emit, re-orphaning
 * them — hence "post-deploy". It is idempotent + dry-run-by-default, so a premature
 * or repeated run is safe (a no-op once everything is migrated).
 *
 * WHAT it does: for every OPEN `repeated-tool-error:*` EI whose class is now
 * fingerprinted (caller/transient) but whose stored key lacks a fingerprint, it
 * recomputes the fingerprint from the EI's stored body sample and appends it — so
 * the open EI keeps matching what the live collector now emits, instead of being
 * orphaned + re-filed (re-file churn). The reusable engine is
 * operator-core/lib/harness/improvements/watchdog-key-migration.ts; this script is
 * just the live-PG wiring + CLI. Any FUTURE key-shape change = a new deriver + a
 * one-line swap here.
 *
 * Usage:
 *   tsx apps/operator/scripts/recompute-watchdog-keys.ts            # DRY RUN (default) — reports, writes nothing
 *   tsx apps/operator/scripts/recompute-watchdog-keys.ts --execute  # apply the migration
 *
 * Fail-soft: an unreachable DB is logged and exits 0.
 */

import postgres from 'postgres';
import { restoreRawJsonbSerializer } from '@papercusp/db-org';
import {
  recomputeWatchdogKeys,
  deriveToolErrorWatchdogKey,
  REPEATED_TOOL_ERROR_PREFIX,
  type RecomputeDeps,
} from '@papercusp/operator-core/lib/harness/improvements/watchdog-key-migration';
import type { ImprovementCandidate } from '@papercusp/operator-core/lib/harness/improvements/policy';

const url =
  process.env.HARNESS_ADMIN_DATABASE_URL ??
  'postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp';

async function main(): Promise<void> {
  const execute = process.argv.includes('--execute');
  const sql = postgres(url, { max: 1, connect_timeout: 3, idle_timeout: 1, onnotice: () => {} });
  // EI-18698602043482898: this script builds its OWN raw postgres() client
  // (not getOrgPg()), so it needs the hybrid jsonb serializer applied
  // explicitly — without it, `setWatchdogKey`'s `${JSON.stringify(x)}::jsonb`
  // bind below double-encodes into a jsonb scalar string instead of an
  // object (verified live against the same call shape via operator-cli.ts's
  // savePrefs). See connection.ts's `restoreRawJsonbSerializer` doc.
  restoreRawJsonbSerializer(sql);

  // EI-<n> ids are GLOBALLY allocated, so we read + update rows by issue_id across
  // every workspace — each row is migrated IN PLACE (its workspace_id is unchanged),
  // so the per-workspace watchdog dedup reads the migrated key in its own scope.
  const deps: RecomputeDeps = {
    listOpenKeyed: async (): Promise<ImprovementCandidate[]> => {
      const rows = await sql<{ issue_id: string; body: string | null; wk: string }[]>`
        SELECT issue_id, body, payload->>'watchdogKey' AS wk
          FROM harness_shared.engineer_issues
         WHERE state = 'open'
           AND payload ? 'watchdogKey'
           AND payload->>'watchdogKey' LIKE ${REPEATED_TOOL_ERROR_PREFIX + '%'}`;
      return rows.map((r) => ({
        id: r.issue_id,
        kind: 'bug',
        scope: 'operator',
        title: '',
        state: 'open',
        body: r.body ?? undefined,
        watchdogKey: r.wk,
      }));
    },
    setWatchdogKey: async (id, newKey) => {
      await sql`
        UPDATE harness_shared.engineer_issues
           SET payload = COALESCE(payload, '{}'::jsonb) || ${JSON.stringify({ watchdogKey: newKey })}::jsonb,
               origin = 'local'
         WHERE issue_id = ${id}`;
    },
  };

  try {
    const res = await recomputeWatchdogKeys(deriveToolErrorWatchdogKey, deps, { dryRun: !execute });
    const mode = res.dryRun ? 'DRY RUN (no writes — pass --execute to apply)' : 'EXECUTED';
    process.stdout.write(
      `\nwatchdog-key recompute — ${mode}\n` +
        `  scanned (open repeated-tool-error EIs): ${res.scanned}\n` +
        `  ${res.dryRun ? 'would migrate' : 'migrated'}: ${res.changed.length}\n` +
        `  collisions skipped: ${res.collisions.length}\n` +
        `  unchanged: ${res.unchanged}\n`,
    );
    for (const c of res.changed.slice(0, 50)) {
      process.stdout.write(`    ${c.id}: ${c.oldKey}\n        → ${c.newKey}\n`);
    }
    if (res.changed.length > 50) process.stdout.write(`    … +${res.changed.length - 50} more\n`);
    for (const c of res.collisions) {
      process.stdout.write(`    COLLISION ${c.id} → ${c.newKey} (already held by ${c.heldBy}) — left as-is\n`);
    }
  } catch (e) {
    process.stdout.write(`⚠ recompute-watchdog-keys: skipped (${e instanceof Error ? e.message : String(e)})\n`);
  } finally {
    try { await sql.end({ timeout: 1 }); } catch { /* swallow */ }
  }
}

void main();
