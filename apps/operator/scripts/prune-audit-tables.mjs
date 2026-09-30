#!/usr/bin/env node
/**
 * Prune audit tables.
 *
 * agent_actions / agent_queries / voice_utterances all grow unbounded
 * with no built-in retention. On a moderately-active workspace each
 * table accumulates ~1M rows/year. Run this monthly (cron or manual)
 * to drop old rows past the retention window.
 *
 * el_conv_calls is INTENTIONALLY NOT pruned — the monthly minute cap
 * relies on summing rows in the current ym='YYYY-MM', and historical
 * months are useful for trend analysis. They're tiny (one row per
 * conversation, ~few KB total per year).
 *
 * Default retentions:
 *   agent_actions      30 days  (operational debugging window)
 *   agent_queries      14 days  (sampled, very high volume)
 *   voice_utterances   90 days  (drift detection runs weekly)
 *
 * Usage:
 *   node apps/operator/scripts/prune-audit-tables.mjs
 *   ACTIONS_DAYS=60 QUERIES_DAYS=30 UTTERANCES_DAYS=180 node ...
 *   DRY_RUN=1 node ...   # report only, no DELETE
 */

import postgres from 'postgres';

const PG_URL = process.env.PG_URL ?? 'postgres://harness_app:harness_app_pwd@localhost/papercusp';
const ACTIONS_DAYS = Number(process.env.ACTIONS_DAYS ?? '30');
const QUERIES_DAYS = Number(process.env.QUERIES_DAYS ?? '14');
const UTTERANCES_DAYS = Number(process.env.UTTERANCES_DAYS ?? '90');
const DRY_RUN = process.env.DRY_RUN === '1';

const sql = postgres(PG_URL);

async function pruneTable(table, days) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60_000);
  const tsCol = 'ts';
  // count first so we can report.
  let rows;
  try {
    rows = await sql`
      SELECT count(*)::int AS n
      FROM ${sql(`harness_shared.${table}`)}
      WHERE ${sql(tsCol)} < ${cutoff}
    `;
  } catch (e) {
    console.warn(`[prune] ${table}: skipped (${e.message?.slice(0, 100)})`);
    return { pruned: 0 };
  }
  const n = rows[0]?.n ?? 0;
  if (n === 0) {
    console.log(`[prune] ${table}: nothing older than ${days}d`);
    return { pruned: 0 };
  }
  if (DRY_RUN) {
    console.log(`[prune] ${table}: would prune ${n} rows older than ${days}d (dry-run)`);
    return { pruned: 0 };
  }
  // Delete in 10k chunks so we don't hold a giant lock.
  let total = 0;
  while (true) {
    const result = await sql`
      DELETE FROM ${sql(`harness_shared.${table}`)}
      WHERE id IN (
        SELECT id FROM ${sql(`harness_shared.${table}`)}
        WHERE ${sql(tsCol)} < ${cutoff}
        LIMIT 10000
      )
    `;
    total += result.count ?? 0;
    if (!result.count || result.count < 10000) break;
  }
  console.log(`[prune] ${table}: pruned ${total} rows older than ${days}d`);
  return { pruned: total };
}

async function main() {
  console.log('[prune] start' + (DRY_RUN ? ' (dry-run)' : ''));
  const a = await pruneTable('agent_actions', ACTIONS_DAYS);
  const q = await pruneTable('agent_queries', QUERIES_DAYS);
  const u = await pruneTable('voice_utterances', UTTERANCES_DAYS);
  console.log('[prune] done — agent_actions=' + a.pruned + ', agent_queries=' + q.pruned + ', voice_utterances=' + u.pruned);
  await sql.end();
}

main().catch((e) => {
  console.error('[prune] failed:', e?.message ?? e);
  process.exit(1);
});
