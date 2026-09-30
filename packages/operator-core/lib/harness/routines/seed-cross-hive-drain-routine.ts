/**
 * Seed the periodic cross-Hive outbox-drain routine
 * (hive-network-surface-2026-06-11 P-001, brief B-01).
 *
 * One routine, `cross-hive-outbox-drain` → `system:cross-hive-outbox-drain`,
 * every 2 minutes at second :30 (6-field cron, offset from git-sync's :00
 * ticks). Per fire it reconciles the boot-wired cross-Hive boundaries against
 * the directory-publish state, then runs one backoff-aware drain pass over
 * every wired Hive's durable outbox (cross-hive-drain-action.ts).
 *
 * Seeded ACTIVE by default: the action SELF-GATES — zero published Hives means
 * a no-op tick (one registry read), so an active routine is safe and goes live
 * the moment a Hive is published; finished work never ships dark (CLAUDE.md).
 * `--inactive` seeds it off for an explicit dark launch.
 *
 * payload_template tunables: `baseBackoffMs` (default 30s), `capBackoffMs`
 * (default 30min) — the per-peer retry window shape.
 *
 *   tsx seed-cross-hive-drain-routine.ts              # seed ACTIVE
 *   tsx seed-cross-hive-drain-routine.ts --inactive   # seed off
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';
import { armHiveCrossHiveDrainRoutine } from './arm-hive-cross-hive-drain';

const SLUG =
  process.env.CROSS_POT_DRAIN_SLUG ??
  process.env.CROSS_HIVE_DRAIN_SLUG ?? // legacy env name — dual-accept until callers migrate
  operatorHomeHarnessSlug(); // allow-scope-default: env-overridable operator-home routine install (no env ⇒ home hive, by design)

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  // Delegate to the shared arm helper (the per-hive twin used by pot:create) so
  // the seeded row never drifts from what a freshly-created hive gets.
  const { routineId } = await armHiveCrossHiveDrainRoutine({ sql, workspaceId: ws, potSlug: SLUG, active });
  console.log(`[seed-cross-hive-drain] routine ${routineId} seeded (install=${SLUG}, active=${active})`);
  await sql.end({ timeout: 5 });
}

void main();
