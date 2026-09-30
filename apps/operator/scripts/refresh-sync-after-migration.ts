/**
 * refresh-sync-after-migration — re-fire the sync-invalidate bus for the
 * live-query names whose backing tables were populated by RAW-SQL migration
 * (papercup → papercusp). Raw INSERTs bypass the producer-time
 * notifySyncInvalidate() (and tables like harness_tests have no
 * emit_change_notify PG trigger), so the desktop's cached live queries never
 * refetched — the data is in PG but the tab shows stale/empty.
 *
 * This calls notifySyncInvalidate (the same helper the producers use) with NO
 * args, so EVERY subscriber to each name refetches with its own args (incl.
 * papercusp). Read-only refresh — no data change. Works independent of the
 * routine scheduler (the SSE bus LISTEN is part of the live operator process).
 *
 * Usage: npx tsx scripts/refresh-sync-after-migration.ts
 */
import { notifySyncInvalidate } from '@papercusp/operator-core/lib/sync-sse';

// Query names (table-to-query-names.ts) for every table populated by the migration.
const NAMES = [
  'harnessTests.byHarness', // ← the Tests tab
  'harnessTextArtifact.byHarness',
  'featureNotes.byHarness',
  'featureAudit.byHarness',
  'agentChats.byHarness',
  'harnessEscalations.byHarness',
  'insightsFirstVisit.byHarness',
  'plans.list',
  'plans.get',
  'plans.items',
  'plans.attention',
  'plans.search',
  'plans.revisions',
  'featuresConsolidated.bySlug',
  'featuresConsolidated.byPlanSlug',
  'workItems.byHarness',
];

async function main(): Promise<void> {
  for (const name of NAMES) {
    await notifySyncInvalidate(name);
    console.log('invalidated', name);
  }
  await new Promise((r) => setTimeout(r, 750)); // let the pg_notify flush
  console.log(`done — fired ${NAMES.length} sync-invalidate events`);
  process.exit(0);
}

main().catch((e) => {
  console.error('FATAL:', e?.stack ?? e);
  process.exit(1);
});
