/**
 * digest-snapshots.ts — the persisted per-cycle digest snapshot store
 * (blender-self-learning-2026-07-12 P-003 / WI-4319).
 *
 * THE PROBLEM: the corpus digest is rebuilt from scratch every fired cycle and
 * rendered whole, so the ideators keep re-seeing (and re-pitching) the same
 * standing top patterns — the stale-repetition → dedup-decline churn behind a
 * large chunk of the routed-vs-ledger gap.
 *
 * THE MECHANISM: at fire time the cycle seam (cycle-deps readCorpus) persists
 * the digest it built to harness_shared.scout_digest_snapshots (migration 582)
 * and stamps the PREVIOUS snapshot's refs on the fresh digest as
 * `previousCycleRefs` — renderDigest (lenses.ts) then leads the ideator prompt
 * with "NEW since your last cycle" before the standing patterns.
 *
 * Scoping: WORKSPACE-WIDE, freshest row wins — the Scout is one brain per
 * workspace and every narrower key in this area has already drifted
 * (scout_ticks' install_slug moved papercusp-workspace → @singleton), the same
 * reasoning as signal-accumulator.ts. Both legs are BEST-EFFORT by contract: a
 * snapshot outage must never disturb the digest or the cycle.
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import { flattenDigest } from './lenses';
import type { CorpusDigest } from './types';

/** Rows kept per workspace — one row lands per FIRED cycle (≤ hourly under the
 *  legacy cadence; burst-coalesced ~15min under volume firing), so 30 rows is
 *  days of history while bounding jsonb growth. */
const SNAPSHOT_KEEP = 30;

/**
 * Persist the digest a fired cycle ran with. Serializes via JSON (the org-pg
 * client rejects rich objects/Dates as params — the house `::jsonb` idiom),
 * then prunes to the newest {@link SNAPSHOT_KEEP} rows for the workspace.
 */
export async function persistDigestSnapshot(opts: {
  digest: CorpusDigest;
  workspaceId?: string;
  installSlug?: string | null;
  cycleId?: string | null;
  watermarkAt?: Date | null;
}): Promise<void> {
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const { sql } = getOrgPg();
  await sql`
    INSERT INTO harness_shared.scout_digest_snapshots
      (workspace_id, install_slug, cycle_id, watermark_at, digest)
    VALUES (${ws}, ${opts.installSlug ?? null}, ${opts.cycleId ?? null},
            ${opts.watermarkAt ? opts.watermarkAt.toISOString() : null},
            ${JSON.stringify(opts.digest)}::text::jsonb)`;
  await sql`
    DELETE FROM harness_shared.scout_digest_snapshots
     WHERE workspace_id = ${ws}
       AND id NOT IN (
         SELECT id FROM harness_shared.scout_digest_snapshots
          WHERE workspace_id = ${ws}
          ORDER BY created_at DESC
          LIMIT ${SNAPSHOT_KEEP})`;
}

/**
 * The refs the previous fired cycle's digest carried (its flattenDigest ref
 * set) — what renderDigest diffs the fresh digest against. Empty set when no
 * snapshot exists yet (first-ever cycle) or the stored digest doesn't parse.
 */
export async function readPreviousSnapshotRefs(
  opts: { workspaceId?: string } = {},
): Promise<Set<string>> {
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ digest: unknown }>>`
    SELECT digest
      FROM harness_shared.scout_digest_snapshots
     WHERE workspace_id = ${ws}
     ORDER BY created_at DESC
     LIMIT 1`;
  const raw = rows[0]?.digest;
  if (!raw || typeof raw !== 'object') return new Set();
  try {
    return new Set(flattenDigest(raw as CorpusDigest).map((p) => p.ref));
  } catch {
    return new Set();
  }
}
