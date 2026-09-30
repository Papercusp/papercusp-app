/**
 * steering-churn.ts — the multi-Queen steering-thrash TRIPWIRE
 * (hive-network-surface-2026-06-11 P-010 / Brief B-12; D-004).
 *
 * Concurrent steering today is unarbitrated last-write-wins on
 * `harness_features_consolidated.feature_order` — the Queen's steer-don't-dispatch
 * lever (work-items.ts `setWorkItemPriority`). Safe at N=1 (one Queen wins every
 * write), but open to ping-pong/thrash the day a 2nd Swarm deploys: two Queens
 * re-steering the SAME backlog item against each other. D-004 ratified the FIX as
 * a single-steerer lease (P-011), hardware-gated on a 2nd Swarm existing; THIS is
 * the EVIDENCE that gates that build — it ships now so "zero churn at N=1" is
 * proven from data, and a real 2-Swarm churn signal triggers the lease build
 * (revisit condition a) while sustained zero closes it unbuilt (condition b).
 *
 * The instrumentation is a DB trigger (migration 232): every actual
 * `feature_order` change is recorded into `harness_shared.steering_churn_events`
 * with the WRITER IDENTITY derived from the federation provenance — '__local__'
 * for a local steer, the remote `author_pubkey` for a federated steer. One DB
 * chokepoint captures BOTH steer paths (local `setWorkItemPriority` AND a remote
 * Queen's steer applied via the harness-features projection).
 *
 * This module is the DETECTOR: it reads the ledger, counts how often the same
 * item flipped between DIFFERENT writers inside a window (the churn counter), and
 * — above a threshold — raises ONE debounced `coord:escalate` advisory to the
 * owner. `sweepSteeringChurn` runs it on a cadence (dbos/periodic-workflows.ts);
 * the ledger is the durable counter for after-the-fact queries.
 */

import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import { openEscalation } from './agent-tools/coordination/escalations';
import type { AgentIdentity } from './agent-tools/coordination/identity';

type Sql = ReturnType<typeof getOrgPg>['sql'];

/**
 * Window over which re-steers by different writers count as one churn episode.
 * 15 min mirrors the watchdog cadence — long enough to span a Queen turn pair,
 * short enough that an ancient handoff doesn't read as live thrash.
 */
export const STEERING_CHURN_WINDOW_MS = 15 * 60_000;

/**
 * Writer FLIPS within the window required to trip. A single flip (writer A then
 * writer B) is a legitimate handoff; sustained A→B→A→B ping-pong (>= 3 flips) is
 * thrash. "Above threshold" per the brief → `>=`.
 */
export const STEERING_CHURN_THRESHOLD = 3;

/** One escalation per item per cooldown (debounce). A thrashing item alerts once. */
export const STEERING_CHURN_COOLDOWN_MS = STEERING_CHURN_WINDOW_MS;

/** A single steer event read from the ledger (or supplied to the pure detector). */
export interface SteerEvent {
  /** The steering writer: '__local__' or a remote author_pubkey. */
  writer: string;
  /** epoch-ms of the steer (the federation LWW clock, or wall clock). */
  ts: number;
  /** The feature_order written (null = a clear / de-prioritize). */
  featureOrder: number | null;
}

export interface SteeringChurnResult {
  /** Distinct writer identities seen in the window. */
  distinctWriters: number;
  /** Writer FLIPS: events (chronological) whose writer differs from the previous one. */
  churnCount: number;
  /** Total steer events in the window. */
  steerCount: number;
  /** The distinct writers (sorted) — for the escalation body. */
  writers: string[];
  /** The tripwire: >= 2 distinct writers AND churnCount >= threshold. */
  trip: boolean;
}

/**
 * Pure: count writer flips over a window of steer events. A "flip" is an event
 * whose writer differs from the chronologically-previous event's — so the same
 * item steered A, A, A is 0 flips (one Queen, no churn), while A, B, A, B is 3.
 * Trip requires >= 2 distinct writers (a flip implies that) AND flips >= threshold.
 */
export function detectSteeringChurn(
  events: SteerEvent[],
  opts: { threshold?: number } = {},
): SteeringChurnResult {
  const threshold = opts.threshold ?? STEERING_CHURN_THRESHOLD;
  // Stable chronological order; ties keep input order (the ledger query already
  // orders by ts then id, so ties are deterministic on the IO path).
  const sorted = events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.ts - b.e.ts || a.i - b.i)
    .map((x) => x.e);

  const writers = new Set<string>();
  let churnCount = 0;
  let prev: string | undefined;
  for (const ev of sorted) {
    writers.add(ev.writer);
    if (prev !== undefined && ev.writer !== prev) churnCount += 1;
    prev = ev.writer;
  }
  const distinctWriters = writers.size;
  return {
    distinctWriters,
    churnCount,
    steerCount: sorted.length,
    writers: [...writers].sort(),
    trip: distinctWriters >= 2 && churnCount >= threshold,
  };
}

/** The escalation sink — injectable so the detector is testable without coord IO. */
export type SteeringChurnEscalator = (input: {
  workspaceId: string;
  harnessSlug: string;
  featureId: string;
  result: SteeringChurnResult;
  windowMs: number;
}) => Promise<void>;

/** Synthetic identity for the background tripwire's owner escalation. */
const STEERING_CHURN_IDENTITY: AgentIdentity = {
  ownerId: 'steering-churn-monitor',
  ownerLabel: 'system · steering-churn',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

/** Short, readable form of a writer id for the escalation body. */
function writerLabel(w: string): string {
  if (w === '__local__') return 'this Swarm';
  if (w === '__remote_unknown__') return 'an unattributed remote Swarm';
  return `peer ${w.slice(0, 12)}…`;
}

/**
 * Default escalator: a `coord:escalate` advisory to the human (the same
 * `openEscalation` path coord:escalate's tool handler uses). Advisory, not a
 * blocker — it is a telemetry tripwire, not a thing the owner must unblock.
 */
export const defaultSteeringChurnEscalator: SteeringChurnEscalator = async ({
  workspaceId,
  harnessSlug,
  featureId,
  result,
  windowMs,
}) => {
  const mins = Math.round(windowMs / 60_000);
  await openEscalation(STEERING_CHURN_IDENTITY, {
    severity: 'advisory',
    summary:
      `Steering churn: ${harnessSlug}/${featureId} re-steered by ${result.distinctWriters} writers ` +
      `(${result.churnCount} flips) in ${mins}m — multi-Mug LWW thrash`,
    body:
      `The backlog item ${featureId} (harness ${harnessSlug}, workspace ${workspaceId}) had its ` +
      `priority (feature_order) re-steered ${result.steerCount}× by ${result.distinctWriters} different ` +
      `writers within ${mins} minutes, flipping writer ${result.churnCount} times: ` +
      `${result.writers.map(writerLabel).join(', ')}.\n\n` +
      `This is the multi-Mug steering tripwire (D-004 @ hive-network-surface-2026-06-11): concurrent ` +
      `steering is unarbitrated last-write-wins on feature_order, and this item is ping-ponging between ` +
      `Queens. If this is sustained, it is the evidence that gates building the single-steerer lease ` +
      `(P-011, revisit condition a). Investigate which Swarms are contending this item; consider pinning ` +
      `it (work_items:co_locate) or building the lease.`,
    // WI-5848 (sweep of EI-18668025239634541's class): the caller's own DB-backed
    // steering_churn_escalations cooldown only RATE-LIMITS how often this fires — it
    // does not prevent a NEW permanently-open row per cooldown period for the SAME
    // feature, because the summary above embeds live counts (distinctWriters,
    // churnCount, mins) that vary every time. Key the dedup on the stable
    // (workspace, harness, feature) identity so repeated churn on the SAME item
    // coalesces onto one row (bumping repeatCount) instead of leaking a new one
    // every time the cooldown lapses and churn is still ongoing.
    meta: { subjectSignature: `steering-churn:${workspaceId}:${harnessSlug}:${featureId}` },
  });
};

export interface CheckSteeringChurnOpts {
  workspaceId: string;
  harnessSlug: string;
  featureId: string;
  now?: number;
  windowMs?: number;
  threshold?: number;
  cooldownMs?: number;
  sql?: Sql;
  /** Escalation sink (default: `defaultSteeringChurnEscalator`). */
  escalate?: SteeringChurnEscalator;
}

/**
 * Read the recent steer window for ONE item, detect cross-writer churn, and — on
 * a trip — raise a debounced owner escalation. The debounce is an atomic upsert
 * into `steering_churn_escalations` whose DO-UPDATE only fires once the cooldown
 * has elapsed, so concurrent checkers race-safely escalate at most once per
 * cooldown. Returns the detection result + whether it escalated this call.
 */
export async function checkAndEscalateSteeringChurn(
  opts: CheckSteeringChurnOpts,
): Promise<{ result: SteeringChurnResult; escalated: boolean }> {
  const now = opts.now ?? Date.now();
  const windowMs = opts.windowMs ?? STEERING_CHURN_WINDOW_MS;
  const threshold = opts.threshold ?? STEERING_CHURN_THRESHOLD;
  const cooldownMs = opts.cooldownMs ?? STEERING_CHURN_COOLDOWN_MS;
  const sql = opts.sql ?? getOrgPg().sql;
  const since = now - windowMs;

  const rows = await sql<{ writer: string; ts: string | number; feature_order: number | null }[]>`
    SELECT writer, ts, feature_order
      FROM harness_shared.steering_churn_events
     WHERE workspace_id = ${opts.workspaceId}
       AND harness_slug = ${opts.harnessSlug}
       AND feature_id = ${opts.featureId}
       AND ts >= ${since}
     ORDER BY ts ASC, id ASC`;

  const result = detectSteeringChurn(
    rows.map((r) => ({ writer: r.writer, ts: Number(r.ts), featureOrder: r.feature_order })),
    { threshold },
  );
  if (!result.trip) return { result, escalated: false };

  // Debounce atomically: insert-or-update the per-item escalation marker only
  // when the cooldown has elapsed. A DO-UPDATE that fails its WHERE returns no
  // row → already alerted this cooldown → suppress.
  const cutoff = now - cooldownMs;
  const marker = await sql<{ last_escalated_ts: string | number }[]>`
    INSERT INTO harness_shared.steering_churn_escalations
      (workspace_id, harness_slug, feature_id, last_escalated_ts, churn_count)
    VALUES (${opts.workspaceId}, ${opts.harnessSlug}, ${opts.featureId}, ${now}, ${result.churnCount})
    ON CONFLICT (workspace_id, harness_slug, feature_id) DO UPDATE
      SET last_escalated_ts = EXCLUDED.last_escalated_ts,
          churn_count = EXCLUDED.churn_count
      WHERE steering_churn_escalations.last_escalated_ts <= ${cutoff}
    RETURNING last_escalated_ts`;
  if (marker.length === 0) return { result, escalated: false };

  const escalate = opts.escalate ?? defaultSteeringChurnEscalator;
  await escalate({
    workspaceId: opts.workspaceId,
    harnessSlug: opts.harnessSlug,
    featureId: opts.featureId,
    result,
    windowMs,
  });
  return { result, escalated: true };
}

export interface SweepSteeringChurnOpts {
  now?: number;
  windowMs?: number;
  threshold?: number;
  cooldownMs?: number;
  sql?: Sql;
  escalate?: SteeringChurnEscalator;
}

/**
 * Periodic catch-all: across ALL workspaces, find items steered by >= 2 distinct
 * writers in the recent window and run `checkAndEscalateSteeringChurn` on each
 * (debounced). This catches every interleaving — including churn between two
 * REMOTE Swarms that this box never locally steered, which a synchronous local
 * steer hook would miss. Returns how many candidates it checked and how many it
 * escalated this sweep.
 */
export async function sweepSteeringChurn(
  opts: SweepSteeringChurnOpts = {},
): Promise<{ checked: number; escalated: number }> {
  const now = opts.now ?? Date.now();
  const windowMs = opts.windowMs ?? STEERING_CHURN_WINDOW_MS;
  const sql = opts.sql ?? getOrgPg().sql;
  const since = now - windowMs;

  const candidates = await sql<{ workspace_id: string; harness_slug: string; feature_id: string }[]>`
    SELECT workspace_id, harness_slug, feature_id
      FROM harness_shared.steering_churn_events
     WHERE ts >= ${since}
     GROUP BY workspace_id, harness_slug, feature_id
    HAVING count(DISTINCT writer) >= 2`;

  let escalated = 0;
  for (const c of candidates) {
    const r = await checkAndEscalateSteeringChurn({
      workspaceId: c.workspace_id,
      harnessSlug: c.harness_slug,
      featureId: c.feature_id,
      now,
      windowMs,
      threshold: opts.threshold,
      cooldownMs: opts.cooldownMs,
      sql,
      escalate: opts.escalate,
    });
    if (r.escalated) escalated += 1;
  }
  return { checked: candidates.length, escalated };
}

/** Retention horizon for ledger rows — far beyond any detection window. */
export const STEERING_CHURN_RETENTION_MS = 7 * 24 * 60 * 60_000;

/**
 * Bound the append-only ledger: drop steer events older than the retention
 * horizon (>> the detection window, so this never elides anything a check or
 * sweep would read). Single Queen steers accumulate here forever otherwise.
 * Called from the periodic sweep tick (kept separate from `sweepSteeringChurn`,
 * which is `now`-parameterized for tests). Returns the row count deleted.
 */
export async function pruneSteeringChurnEvents(
  opts: { now?: number; retentionMs?: number; sql?: Sql } = {},
): Promise<number> {
  const now = opts.now ?? Date.now();
  const retentionMs = opts.retentionMs ?? STEERING_CHURN_RETENTION_MS;
  const sql = opts.sql ?? getOrgPg().sql;
  const cutoff = now - retentionMs;
  const deleted = await sql`DELETE FROM harness_shared.steering_churn_events WHERE ts < ${cutoff}`;
  return deleted.count ?? 0;
}
