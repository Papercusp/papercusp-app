/**
 * fleet-monitors.ts — the Phase-3 LIVE-FLEET invariants of
 * `shared-hive-loop-e2e-testing-2026-06-10` (P-012 + P-013): the scheduled
 * monitor family that watches the multi-swarm loop in production, built from
 * the failure modes the hermetic Phase-1 rig proved are real.
 *
 *  - `scanDoubleCompletionSignals` (P-012) — cross-swarm double-completion
 *    detector. The per-swarm detectable shape (claims are LOCAL per swarm;
 *    the loser's claim row is not globally visible): an item THIS swarm holds
 *    a LIVE lease on whose TERMINAL status arrived from a REMOTE author
 *    (origin='remote'), without a redundancy declaration ⇒ another swarm
 *    completed an item we believe is ours. Forensics carry both sides (the
 *    local claim + the remote author/fed_ts).
 *
 *  - `sweepOrphanedTakenBy` (P-013; the P-003 starvation fix) — a dead
 *    swarm's `taken_by` federates but never lapses, so `claim_next` can never
 *    steal its in-flight items. The sweep returns to the backlog every
 *    non-terminal item that is marked taken but has NO live lease row and no
 *    recent activity (grace window). Run it on the AUTHORITY swarm — the
 *    lease table consulted is authoritative there; elsewhere it would clear
 *    rows whose lease lives across the RPC boundary.
 *
 *  - `scanOutboxHealth` (P-013) — `substrate_outbox` depth/age vs SLO (the
 *    102GB lesson: alert BEFORE bloat).
 *
 *  - `detectPresenceGhosts` (P-013, pure) — presence rows stale beyond the
 *    window that still anchor live leases: a ghost holds work nobody is doing.
 *
 *  - `measureConvergenceLag` (P-013) — the write-on-A/arrive-on-B probe with
 *    an SLO verdict (the hermetic P-006 measured ~16s for a 2.5k storm; the
 *    production probe writes one marker row per pass).
 *
 * All scans are read-only except the sweep; every function takes its PG
 * client explicitly (no getOrgPg — monitor passes run against a CHOSEN swarm
 * DB). Scheduling/wiring: one routine home shared with the coord-system
 * monitor family (coord-system-e2e-testing P-013) — `runSharedHiveMonitorPass`
 * is the routine body; issue-filing is injected.
 */
import type postgres from 'postgres';
// EI-20723522274831539: the holder-liveness rule is IMPORTED, never restated. The sibling
// reaper's module header states the rule is "deliberately identical ... so the reapers can
// never disagree" — this sweep was the one reaper that never took it, which is exactly how
// it drifted into freeing live holders' claims. Importing the fragments makes a future
// change to the rule reach BOTH reapers or NEITHER.
import {
  liveHolderFragment,
  parkedHolderFragment,
  STALE_CLAIM_GRACE_MS,
  STALE_CLAIM_PARKED_GRACE_MS,
} from '../work-items-stale-claims';
import type { MergeCursorPeerLifecycleState } from '../sync/hyperbee/read-merge';

/** Feature-family terminal states (work-items.ts settled list). */
export const TERMINAL_STATUSES = ['passed', 'deprecated'] as const;

// ── P-012: cross-swarm double-completion detector ────────────────────────────

export interface DoubleCompletionSignal {
  workItemId: string;
  harnessSlug: string;
  /** The LOCAL side: the live lease this swarm holds. */
  localClaim: { owner: string; holderPubkey: string | null; acquiredTs: string; expiresTs: string };
  /** The REMOTE side: who authored the terminal write and when (CDC provenance). */
  remote: { authorPubkey: string | null; fedTs: number | null; status: string };
}

export async function scanDoubleCompletionSignals(
  sql: postgres.Sql,
  opts: { workspaceId: string; harness: string; terminalStatuses?: readonly string[] },
): Promise<DoubleCompletionSignal[]> {
  const terminal = [...(opts.terminalStatuses ?? TERMINAL_STATUSES)];
  const rows = await sql<
    Array<{
      work_item_id: string;
      owner: string;
      holder_pubkey: string | null;
      acquired_ts: string;
      expires_ts: string;
      author_pubkey: string | null;
      fed_ts: number | null;
      status: string;
    }>
  >`
    SELECT c.work_item_id, c.owner, c.holder_pubkey, c.acquired_ts, c.expires_ts,
           f.author_pubkey, f.fed_ts, f.status
      FROM harness_shared.work_item_claims c
      JOIN harness_shared.harness_features_consolidated f
        ON f.harness_slug = c.harness_slug AND f.feature_id = c.work_item_id
     WHERE c.workspace_id = ${opts.workspaceId} AND c.harness_slug = ${opts.harness}
       AND c.expires_ts > clock_timestamp()              -- our lease is LIVE
       AND f.status = ANY(${terminal}::text[])           -- yet the item is settled…
       AND f.origin = 'remote'                           -- …by a REMOTE author
       AND (f.redundancy IS NULL OR f.redundancy <= 1)   -- and not a declared fan-out
     ORDER BY c.work_item_id`;
  return rows.map((r) => ({
    workItemId: r.work_item_id,
    harnessSlug: opts.harness,
    localClaim: { owner: r.owner, holderPubkey: r.holder_pubkey, acquiredTs: r.acquired_ts, expiresTs: r.expires_ts },
    remote: { authorPubkey: r.author_pubkey, fedTs: r.fed_ts == null ? null : Number(r.fed_ts), status: r.status },
  }));
}

// ── P-013: orphaned-taken_by sweep (the P-003 starvation fix) ────────────────

export interface OrphanSweepResult {
  /** Items returned to the backlog (taken_by cleared). */
  cleared: Array<{ workItemId: string; takenBy: string; updatedTs: number }>;
}

/**
 * Return to the backlog every NON-terminal item marked taken whose HOLDER IS
 * DEAD, whose lease row is absent/lapsed, and whose last write is older than
 * `graceMs`. Run on the AUTHORITY swarm (see module header). The grace window
 * keeps a just-claimed item (lease write in flight) out of the sweep.
 *
 * EI-20723522274831539 — WHY THE HOLDER-LIVENESS GUARD EXISTS. Until this fix
 * the ONLY protection a live holder had here was the `work_item_claims` lease
 * row. That table is EMPTY on this deployment (0 rows, ever — the lease is
 * flag-gated behind workItemClaimLeaseEnabled and is not populated), so the
 * `NOT EXISTS` guard was unconditionally TRUE and this sweep freed EVERY claim
 * whose `updated_ts` was older than 5 minutes — no matter that the holder was
 * alive and actively working. `updated_ts` is bumped only by a WRITE to the
 * row, so an agent doing real work (edits, tool calls, tests) without
 * checkpointing crosses that threshold in normal operation: the sweep's
 * predicate selected working agents PREFERENTIALLY.
 *
 * Observed end-to-end 2026-08-17: the hourly `coord-invariant-monitor` fired at
 * 17:37:05.079Z and 9.7s later freed WI-39259 (held by a live agent since
 * 17:18:34Z) and WI-39264 (held by another live agent since 17:29:27Z) in ONE
 * bulk statement, 6ms apart. `scheduler:get_next` then handed both items to a
 * THIRD agent while the original two were still mid-flight on them — a genuine
 * double-placement. Neither holder released; both had to re-claim their own work.
 *
 * The fix takes the LIVE/PARKED half of the dead-holder rule the sibling reaper
 * already applies (`work-items-stale-claims.ts`, DEAD leg), via the same
 * imported fragments: a claim is reclaimable only if its holder is NOT live and
 * NOT briefly-parked. The sibling's THIRD clause — its WI-1999/WI-1964
 * known-holder requirement — is deliberately NOT copied here; see the inline
 * comment on the victim predicate for why (it defers this sweep's whole reason
 * to exist, the dead peer SWARM that never had a local presence row). The lease
 * check is retained as an ADDITIONAL guard rather than the only one, so it
 * starts protecting again the day the lease table is populated instead of
 * silently doing nothing.
 */
export async function sweepOrphanedTakenBy(
  sql: postgres.Sql,
  opts: {
    workspaceId: string;
    harness: string;
    graceMs?: number;
    nowMs?: number;
    terminalStatuses?: readonly string[];
  },
): Promise<OrphanSweepResult> {
  const terminal = [...(opts.terminalStatuses ?? TERMINAL_STATUSES)];
  const graceMs = opts.graceMs ?? 5 * 60_000;
  const nowMs = opts.nowMs ?? Date.now();
  const cutoff = nowMs - graceMs;
  // Liveness windows are the SIBLING REAPER's, not this sweep's `graceMs`. The two
  // are different axes and must not be conflated: `graceMs` bounds how stale the
  // ROW's last write is, while these bound how stale the HOLDER's heartbeat is.
  const liveGraceSec = Math.max(1, Math.round(STALE_CLAIM_GRACE_MS / 1000));
  const parkedGraceSec = Math.max(liveGraceSec, Math.round(STALE_CLAIM_PARKED_GRACE_MS / 1000));
  // CTE captures the OLD taken_by (RETURNING alone reflects the NEW row).
  const rows = await sql<Array<{ feature_id: string; taken_by: string; updated_ts: number }>>`
    WITH live_holder AS (${liveHolderFragment(sql, liveGraceSec)}),
    parked_holder AS (${parkedHolderFragment(sql, parkedGraceSec)}),
    victims AS (
      SELECT f.harness_slug, f.feature_id, f.taken_by, f.updated_ts
        FROM harness_shared.harness_features_consolidated f
       WHERE f.workspace_id = ${opts.workspaceId} AND f.harness_slug = ${opts.harness}
         AND f.taken_by IS NOT NULL AND f.taken_by <> ''
         AND NOT (f.status = ANY(${terminal}::text[]))
         AND f.updated_ts < ${cutoff}
         -- EI-20723522274831539: the holder must actually be DEAD. Identical rule to
         -- work-items-stale-claims.ts's DEAD leg, via the same imported fragments.
         AND NOT EXISTS (SELECT 1 FROM live_holder h WHERE h.alias = f.taken_by)
         AND NOT EXISTS (SELECT 1 FROM parked_holder p WHERE p.alias = f.taken_by)
         -- DELIBERATELY NOT COPIED FROM THE SIBLING: its WI-1999 known-holder
         -- requirement (only presume dead a holder this node has ever SEEN). That
         -- guard protects a live REMOTE holder invisible to local presence, but it is
         -- in direct tension with THIS sweep's reason to exist. The P-003 case is a
         -- peer SWARM that claimed, died, and never had a local coord_presence row at
         -- all; requiring known-holder here defers that reclaim by the 24h fallback
         -- and re-opens the very starvation this sweep was written to fix. Both
         -- existing integration tests (fleet-monitors, revoked-swarm) fail on exactly
         -- that, which is how the over-copy was caught. The live/parked guards above
         -- are what the incident actually needed: BOTH robbed holders had FRESH
         -- heartbeats, so they are fully covered without this clause.
         AND NOT EXISTS (
               SELECT 1 FROM harness_shared.work_item_claims c
                WHERE c.workspace_id = ${opts.workspaceId}
                  AND c.harness_slug = f.harness_slug
                  AND c.work_item_id = f.feature_id
                  AND c.expires_ts > clock_timestamp())
         FOR UPDATE
    )
    UPDATE harness_shared.harness_features_consolidated f
       -- WI-6303: clear last_progress_at with the claim — an orphaned reclaim must
       -- not leave a stale progress stamp that later reads as genuinely in-flight
       -- work (see work-items-stale-claims.ts's identical WI-6303 fix for the
       -- live-verified root-cause writeup).
       SET taken_by = NULL, taken_at = NULL, last_progress_at = NULL, updated_ts = ${nowMs},
           -- EI-20723522274831539 (the EI-18838076935151132 attribution fix, which
           -- landed on the sibling reaper but never reached THIS one): an INVOLUNTARY
           -- release must name the reaper, never stay blank. Left blank, this sweep's
           -- release was indistinguishable from "never released" to every reader — the
           -- reason the incident took a multi-hour hunt and was first misdiagnosed as
           -- "the peers worked without ever claiming". A reaper-prefixed marker can
           -- never equal a real ownerId, so the scheduler's release-cooldown floor
           -- (get-next.ts's last_released_by <> candidate) cannot misfire against it.
           last_released_by = 'reaper:orphan-sweep',
           last_released_at = now()
      FROM victims v
     WHERE f.harness_slug = v.harness_slug AND f.feature_id = v.feature_id
    RETURNING v.feature_id, v.taken_by, v.updated_ts`;
  return {
    cleared: rows.map((r) => ({ workItemId: r.feature_id, takenBy: r.taken_by, updatedTs: Number(r.updated_ts) })),
  };
}

// ── P-013: outbox health ─────────────────────────────────────────────────────

export interface OutboxHealth {
  undrainedDepth: number;
  oldestUndrainedAgeMs: number | null;
  breaches: string[];
  /**
   * EI-21096375006041139: true when an aged-backlog breach was withheld
   * because the caller told us this harness's substrate is NOT currently
   * resident in this process (see `residentInProcess` below). `false` when no
   * age breach applied regardless, or when residency is unknown/true.
   */
  ageBreachSuppressedDormant: boolean;
}

export async function scanOutboxHealth(
  sql: postgres.Sql,
  opts: {
    maxDepth: number;
    maxAgeMs: number;
    nowMs?: number;
    workspaceId?: string;
    harness?: string;
    /**
     * EI-21096375006041139: does THIS process currently hold a booted
     * substrate handle (an active outbox-drain loop) for this harness?
     * `undefined` (the default) preserves today's unconditional behavior for
     * every existing caller that does not track boot residency — the age SLO
     * is judged exactly as before.
     *
     * `false` means no drain loop is resident here right now, so an aged
     * backlog is NOT evidence the drain is STUCK — outbox-drain.ts's own
     * header documents that it "runs an immediate catch-up drain on start",
     * so the backlog self-heals the moment this harness next boots. Measured
     * live (EI-21096375006041139): a 3h-old, 406-row backlog on a harness with
     * no resident drain loop drained completely in ~10s once it booted. Firing
     * the age breach in that state accuses a defect — a wedged/failing drain —
     * that provably does not exist: the loop is not failing, it simply is not
     * running yet, by ordinary boot orchestration, not by fault.
     *
     * The DEPTH leg is DELIBERATELY NEVER suppressed by this flag: unbounded
     * growth is the "102GB lesson" this scan exists to catch (see the module
     * header), and that storage-bloat risk is real regardless of WHY nothing
     * is draining the backlog right now.
     */
    residentInProcess?: boolean;
  },
): Promise<OutboxHealth> {
  const nowMs = opts.nowMs ?? Date.now();
  // WI-3896 / mig 645 follow-up (EI-21009625512310918): a QUARANTINED row
  // (`quarantined_at IS NOT NULL`) is left undrained ON PURPOSE by
  // outbox-drain.ts's poison-row triage — it is a deliberate decision, never a
  // silent stall — and must be excluded here exactly as `load-drain-stats.ts`'s
  // `loadSubstrateDrainStats` already excludes it (same table, same
  // "undrained" concept, same mig 645 fix). Before this exclusion, a single
  // permanently-quarantined row kept `oldestUndrainedAgeMs` growing without
  // bound forever, so this SLO scan re-alarmed on a harness that was in fact
  // healthy and draining fresh writes in near-real-time — the exact
  // perpetual-false-positive class the outbox-drain-quarantine-runbook
  // documents, just reached through this monitor's own independent query
  // instead of `loadSubstrateDrainStats`'s.
  // WI-6055: keep optional scopes out of nullable-parameter OR predicates so a
  // postgres.js GENERIC plan retains direct equality conditions for both
  // leading scope columns. TRUE is the exact unscoped identity predicate.
  const workspacePredicate = opts.workspaceId === undefined ? true : sql`workspace_id = ${opts.workspaceId}`;
  const harnessPredicate = opts.harness === undefined ? true : sql`harness_slug = ${opts.harness}`;
  const rows = await sql<Array<{ depth: number; oldest_ts: number | null }>>`
    SELECT COUNT(*)::int AS depth, MIN(ts) AS oldest_ts
      FROM harness_shared.substrate_outbox
     WHERE drained_at IS NULL
       AND quarantined_at IS NULL
       AND ${workspacePredicate}
       AND ${harnessPredicate}`;
  const depth = Number(rows[0]?.depth ?? 0);
  const oldest = rows[0]?.oldest_ts == null ? null : Number(rows[0].oldest_ts);
  const age = oldest == null ? null : Math.max(0, nowMs - oldest);
  const breaches: string[] = [];
  let ageBreachSuppressedDormant = false;
  if (depth > opts.maxDepth) breaches.push(`outbox depth ${depth} > SLO ${opts.maxDepth}`);
  if (age != null && age > opts.maxAgeMs) {
    if (opts.residentInProcess === false) {
      ageBreachSuppressedDormant = true;
    } else {
      breaches.push(`oldest undrained row age ${age}ms > SLO ${opts.maxAgeMs}ms`);
    }
  }
  return { undrainedDepth: depth, oldestUndrainedAgeMs: age, breaches, ageBreachSuppressedDormant };
}

// ── EI-20579195481991931: per-peer federation silence ────────────────────────
//
// `scanOutboxHealth` above is HOST-LOCAL BY CONSTRUCTION: `substrate_outbox`
// holds only THIS host's undrained writes, so the one failure a p2p system must
// never miss — a PEER that stops federating — is exactly the failure it cannot
// see. Measured 2026-08-16: peer machine B sat 100% undrained (5,832 rows,
// oldest 48h) while host A read 0 undrained and filed nothing.
//
// The locally-observable proxy is `substrate_merge_cursor`: one row per log
// (`log_keyhex`) recording how far we have folded it, re-stamped on every
// ADVANCE (pg-merge-cursor-store.ts `save`). ⚠ It holds a row for OUR OWN log
// as well as for remote ones — this comment claimed "one row per REMOTE log" for
// three weeks and the judge believed it, which is the whole of the false
// "N of M peers silent" reading described at the own-log split below. The judge
// therefore resolves the own key and excludes it rather than trusting the shape.
// A peer that stops producing — or
// that we can no longer reach — stops advancing ITS cursor while other peers'
// keep moving. Verified discriminating on host A: harness `papercusp` held 21
// logs spanning 0.00h to 509.71h since last advance.
//
// ⚠ THE ALL-SILENT CASE IS A DIFFERENT VERDICT, AND CONFLATING THE TWO IS THE
// WHOLE POINT. One silent log among live ones ⇒ that PEER went quiet. EVERY log
// silent ⇒ our own fold is wedged and we must not blame peers for it. That is a
// positive control expressed in code: the still-advancing logs are what license
// the per-peer reading, so when they vanish the reading is withdrawn rather than
// amplified into N false peer alarms.
//
// ⚠ WHAT THIS CANNOT DISTINGUISH, stated rather than hidden: from this host, a
// peer that is DOWN, a peer that is UNREACHABLE, and a peer that is merely IDLE
// all present identically as "no new ops from that log". The scan reports the
// observable (no inbound progress for N ms) and leaves the cause open; a
// retired/departed peer's log therefore goes silent forever, which is why the
// SLO wants to be generous and why `position` rides along in the forensics.

/** One remote log's fold progress, as `substrate_merge_cursor` records it. */
export interface MergeCursorRow {
  logKeyHex: string;
  position: number;
  updatedAtMs: number;
  /** Durable explicit lifecycle evidence; historical rows remain `unknown`. */
  lifecycleState: MergeCursorPeerLifecycleState;
  /**
   * The pot-home projection scope this row was folded under (migration 685).
   * REQUIRED because it decides whether the row is live at all: the fold only
   * ever loads cursors matching the binding it is currently running with, so a
   * row under any other binding is unreachable by construction.
   */
  applyBinding: string | null;
}

type MonitorableMergeCursorRow = MergeCursorRow & {
  lifecycleState: Exclude<MergeCursorPeerLifecycleState, 'retired'>;
};

export interface PeerSilence {
  logKeyHex: string;
  /** How long since we last folded anything new from this log. */
  silentForMs: number;
  /** Fold position reached before it went quiet (0 ⇒ we never folded it at all). */
  position: number;
  /** Whether this cursor belongs to the scope's current admitted set; null = unknown. */
  admitted: boolean | null;
  /** Active/unknown remain alertable; retired rows never enter this list. */
  lifecycleState: Exclude<MergeCursorPeerLifecycleState, 'retired'>;
}

export interface PeerFederationHealth {
  /** Remote logs considered. 0 ⇒ UNMEASURED — never read it as healthy. */
  totalLogs: number;
  /** False when there is nothing to judge; the caller must not infer health. */
  measured: boolean;
  /** Why we could not judge — so `measured:false` is never a bare shrug. */
  unmeasuredReason: 'no-remote-logs' | 'scope-dormant' | 'scan-failed' | 'own-log-only' | 'own-log-unknown' | null;
  /** Set with `scan-failed`: the error, kept so a broken scan is diagnosable. */
  scanError?: string;
  silent: PeerSilence[];
  /** Age of the MOST RECENTLY advanced log — the liveness of our own fold. */
  freshestAdvanceMs: number | null;
  /** Every known log is silent ⇒ suspect the LOCAL fold, not the peers. */
  allSilent: boolean;
  breaches: string[];
  /**
   * Cursors EXCLUDED from the judgement because they sit under a superseded
   * `apply_binding` (see the judge). Reported rather than silently dropped: they
   * are unreachable by the fold and will never advance, so a non-zero count is
   * schema residue to clean up, not peers to chase.
   */
  strandedCursors: number;
  /** Explicitly retired cursors excluded from every silence verdict. */
  retiredCursors: number;
  /** The binding the judged population shares — null is a legitimate value. */
  liveApplyBinding: string | null;
  /**
   * Our OWN log's cursor, excluded from the peer population (see the judge).
   * Reported because it is a genuine LOCAL-liveness reading — just not a peer
   * one — and because a reader who sees `own-log-only` needs to know we were
   * still folding our own writes while no remote log was admitted.
   */
  ownLogSilentForMs: number | null;
  /**
   * How many of the JUDGED (remote) logs are actually in this scope's live
   * ADMITTED set. `null` ⇒ we could not read the admitted set — deliberately
   * distinct from `0`, which is a determined "no peer is admitted here".
   *
   * WI-39489: a merge cursor OUTLIVES admission. The cursor table is durable PG
   * state; `handle.admitted` is rebuilt in memory each boot and only re-populated
   * when a peer RE-ANNOUNCES. So a host whose peers went away keeps their cursors
   * forever, and judging cursors alone cannot tell "the fold is wedged" from
   * "there is nothing to fold". This is the number that separates them.
   */
  admittedRemoteLogs: number | null;
  /**
   * EI-21322935352272541: whether THIS HOST admits any remote log in ANY booted
   * scope. `null` ⇒ unmeasured (never spelled the same as a determined `false`).
   *
   * `admittedRemoteLogs === 0` alone cannot tell a scope-local peer departure
   * ("our peers here went away") from a host-wide admission outage ("this host
   * admits nothing anywhere"), because the scan reads only its own scope. That
   * unmeasured distinction collapsed to the first branch, so ONE host-wide
   * condition was reported as N scope-local peer stories — measured on this host
   * 2026-08-24: all 80 booted scopes in the workspace admitted exactly ONE log,
   * their own (zero remote admitted anywhere), while 45 of them held durable
   * remote cursors, i.e. 45 latent per-scope majors for one condition. Worse,
   * WHICH of them alarmed was decided by the unrelated `scope-dormant` guard —
   * whether we happened to have written locally in the last SLO window — so the
   * alarming set was arbitrary with respect to the fault.
   *
   * ⚠ Count the WORKSPACE's scopes, not the status row's entries: the single
   * `substrate_booted_handles_status` row carried 101 `logStats` entries, but 21
   * of them belonged to OTHER workspaces. Both readings here keep the
   * `ls->>'workspaceId'` predicate for that reason.
   */
  hostAdmitsAnyRemoteLog: boolean | null;
  /**
   * The host-wide breach, kept OUT of `breaches` on purpose: it is NOT a fact
   * about this scope, so scoping it to this harness is the very error above. The
   * caller files it under a non-harness-scoped watchdog key (the same idiom
   * `monitor-scope-empty` already uses), which collapses N per-scope dedup
   * buckets into one. `null` when the host does admit remote logs somewhere, or
   * when admission is unmeasured.
   */
  hostWideAdmissionBreach: string | null;
}

/**
 * Pure verdict over merge-cursor rows (the SQL lives in
 * `scanPeerFederationSilence`). Split out so the judgement — which is where the
 * all-silent/some-silent distinction lives — is unit-testable without PG.
 */
export function judgePeerFederationSilence(
  rows: readonly MergeCursorRow[],
  opts: {
    silentAfterMs: number;
    nowMs: number;
    /** Age of OUR OWN newest write in this scope; null = unknown, so judge anyway. */
    localActivityAgeMs?: number | null;
    /**
     * OUR OWN log's key in this scope. REQUIRED to judge: `substrate_merge_cursor`
     * holds a row for the own log too, and it is not a peer (see the judge).
     * `undefined` ⇒ we could not identify it, which is UNMEASURED, never "judge
     * anyway" — judging anyway is exactly the false-peer-alarm this prevents.
     */
    ownLogKeyHex?: string | null;
    /**
     * Every log key in this scope's LIVE ADMITTED set (own log included — the
     * judge already knows which one that is). `undefined` ⇒ we could not read it,
     * which is reported as `admittedRemoteLogs: null` and changes no verdict:
     * ignorance must not be spelled the same as a determined zero (WI-39489).
     */
    admittedLogKeysHex?: readonly string[];
    /**
     * EI-21322935352272541: the HOST-WIDE admission reading — how many remote
     * logs this host admits across EVERY booted scope, not just this one.
     * `undefined` ⇒ unmeasured, reported as `hostAdmitsAnyRemoteLog: null` and
     * changing no verdict (the same ignorance-is-not-a-fact rule as above).
     *
     * Read from the SAME snapshot as `admittedLogKeysHex` by the caller: two
     * reads could straddle a boot and disagree about whether admission exists,
     * which would be this defect's own shape one level up.
     */
    hostAdmission?: { remoteLogsAdmitted: number; scopesMeasured: number };
  },
): PeerFederationHealth {
  const admittedSet = opts.admittedLogKeysHex ? new Set(opts.admittedLogKeysHex) : null;
  const hostAdmitsAnyRemoteLog = opts.hostAdmission == null ? null : opts.hostAdmission.remoteLogsAdmitted > 0;
  if (rows.length === 0) {
    return {
      totalLogs: 0,
      measured: false,
      unmeasuredReason: 'no-remote-logs',
      silent: [],
      freshestAdvanceMs: null,
      allSilent: false,
      strandedCursors: 0,
      retiredCursors: 0,
      liveApplyBinding: null,
      ownLogSilentForMs: null,
      admittedRemoteLogs: admittedSet ? 0 : null,
      hostAdmitsAnyRemoteLog,
      hostWideAdmissionBreach: null,
      // Deliberately NOT a breach: "no remote logs" is the honest shape of a
      // host that has never federated. It is reported as UNMEASURED so a caller
      // that knows federation IS in use (outbox rows exist) can escalate it,
      // and one that does not cannot mistake it for a clean bill of health.
      breaches: [],
    };
  }
  // D-001 / WI-40017: ONLY explicit durable retirement removes a cursor from
  // the peer-silence population. Historical rows (`unknown`) and explicitly
  // active rows remain alertable even when they are not currently admitted.
  // Filter before choosing the live binding: a lifecycle transition has its own
  // timestamp and must never make a retired row's binding the monitor authority.
  const monitorableRows = rows.filter((r): r is MonitorableMergeCursorRow => r.lifecycleState !== 'retired');
  const retiredCursors = rows.length - monitorableRows.length;
  if (monitorableRows.length === 0) {
    return {
      totalLogs: 0,
      measured: false,
      unmeasuredReason: 'no-remote-logs',
      silent: [],
      freshestAdvanceMs: null,
      allSilent: false,
      breaches: [],
      strandedCursors: 0,
      retiredCursors,
      liveApplyBinding: null,
      ownLogSilentForMs: null,
      admittedRemoteLogs: admittedSet ? 0 : null,
      hostAdmitsAnyRemoteLog,
      hostWideAdmissionBreach: null,
    };
  }
  // EI-20617273180156712: a cursor only means anything under the `apply_binding`
  // the fold is CURRENTLY running with. `pg-merge-cursor-store.load` selects with
  // `apply_binding IS NOT DISTINCT FROM <binding>`, so a row written under a
  // SUPERSEDED binding is never loaded, never advanced, and never can be — dead
  // schema residue, not a silent peer. Counting those rows fabricated a
  // "20 of 21 logs silent, oldest 21.4 days" major on host A entirely out of 15
  // cursors stranded by migration 685, an alert no peer could ever clear.
  //
  // The live binding is read from the DATA (whichever binding owns the freshest
  // row), deliberately NOT re-derived: boot.ts resolves it through
  // `hiveHomeProjectionSlug ?? ownPotHomeSlug ?? memberHomeRebindSlug`, and a
  // second copy of that chain here would be free to drift out of agreement with
  // the fold — which is this very defect, one level up. Reading it from the data
  // cannot drift, because the fold is what writes the data.
  //
  // ⚠ A null binding is a LEGITIMATE live value (a non-hive harness folds with
  // applyBinding=null), so this must compare bindings, never truthiness.
  const freshestRow = monitorableRows.reduce((a, b) => (b.updatedAtMs > a.updatedAtMs ? b : a));
  const liveApplyBinding = freshestRow.applyBinding;
  const underLiveBinding = monitorableRows.filter((r) => r.applyBinding === liveApplyBinding);
  const strandedCursors = monitorableRows.length - underLiveBinding.length;

  // OUR OWN LOG IS NOT A PEER. `substrate_merge_cursor` holds a row for it too,
  // and it is re-stamped by our own writes — so while this host is active it is
  // an ETERNALLY-ADVANCING row. The comment at the top of this section says the
  // still-advancing logs are the positive control that "licenses the per-peer
  // reading"; our own log licenses that reading unconditionally, which means the
  // all-silent branch — the whole point of the discrimination — can never fire on
  // a host that is still writing. Measured 2026-08-16: this host had admitted ZERO
  // remote logs in all 95 booted scopes, yet `papercusp` reported "5 of 6 remote
  // logs silent while 1 keeps advancing" (the 1 was us) instead of LOCAL FOLD
  // SUSPECT, while `hive-canary` — where our own log was ALSO stale because we
  // stopped writing there — did reach the local verdict. Same condition, two
  // different verdicts, neither naming the cause.
  //
  // ⚠ An UNKNOWN own-log key is UNMEASURED, never "judge anyway": judging anyway
  // is precisely the false-peer-alarm above, and this module's rule is to degrade
  // to unmeasured rather than to a confident wrong reading.
  if (opts.ownLogKeyHex === undefined) {
    return {
      totalLogs: underLiveBinding.length,
      measured: false,
      unmeasuredReason: 'own-log-unknown',
      hostAdmitsAnyRemoteLog,
      hostWideAdmissionBreach: null,
      silent: [],
      freshestAdvanceMs: null,
      allSilent: false,
      breaches: [],
      strandedCursors,
      retiredCursors,
      liveApplyBinding,
      ownLogSilentForMs: null,
      admittedRemoteLogs: null,
    };
  }
  const ownRow = underLiveBinding.find((r) => r.logKeyHex === opts.ownLogKeyHex);
  const ownLogSilentForMs = ownRow ? Math.max(0, opts.nowMs - ownRow.updatedAtMs) : null;
  const judged = underLiveBinding.filter((r) => r.logKeyHex !== opts.ownLogKeyHex);
  // WI-39489: how many of the judged logs the fold could ACTUALLY advance. A
  // cursor is durable PG state and outlives admission, so a peer that went away
  // leaves a row that can never move again — indistinguishable, from the cursor
  // table alone, from a peer we are failing to fold. `null` (unknown) is kept
  // distinct from `0` (determined): only a determined zero may change a verdict.
  const admittedRemoteLogs = admittedSet ? judged.filter((r) => admittedSet.has(r.logKeyHex)).length : null;

  // No REMOTE log at all under the live binding. This is the honest shape of "we
  // have admitted no peers here" and it is the reading that was missing today —
  // it is deliberately NOT a peer breach (there are no peers to breach) and
  // deliberately NOT healthy. A caller that knows peers are expected escalates it.
  if (judged.length === 0) {
    return {
      totalLogs: 0,
      measured: false,
      unmeasuredReason: 'own-log-only',
      silent: [],
      freshestAdvanceMs: null,
      allSilent: false,
      breaches: [],
      strandedCursors,
      retiredCursors,
      liveApplyBinding,
      ownLogSilentForMs,
      admittedRemoteLogs,
      hostAdmitsAnyRemoteLog,
      hostWideAdmissionBreach: null,
    };
  }

  // A scope WE stopped writing to is one we are no longer federating. Every
  // remote log there is silent for the mundane reason that the whole scope is
  // retired — measured on host A, harness `sheets` held 75/75 logs silent while
  // our own newest write was ~44h old. Judging it would report a dead harness as
  // a wedged fold, forever, in a dedup bucket that never closes. Silence is only
  // evidence of a FAULT when we ourselves are still live in the scope.
  if (opts.localActivityAgeMs != null && opts.localActivityAgeMs > opts.silentAfterMs) {
    return {
      totalLogs: judged.length,
      measured: false,
      unmeasuredReason: 'scope-dormant',
      silent: [],
      freshestAdvanceMs: null,
      allSilent: false,
      breaches: [],
      strandedCursors,
      retiredCursors,
      liveApplyBinding,
      ownLogSilentForMs,
      admittedRemoteLogs,
      hostAdmitsAnyRemoteLog,
      hostWideAdmissionBreach: null,
    };
  }
  const ages = judged.map((r) => Math.max(0, opts.nowMs - r.updatedAtMs));
  const freshestAdvanceMs = Math.min(...ages);
  const silent = judged
    .map((r, i) => ({
      logKeyHex: r.logKeyHex,
      silentForMs: ages[i]!,
      position: r.position,
      admitted: admittedSet == null ? null : admittedSet.has(r.logKeyHex),
      lifecycleState: r.lifecycleState,
    }))
    .filter((s) => s.silentForMs > opts.silentAfterMs)
    .sort((a, b) => b.silentForMs - a.silentForMs);
  const allSilent = silent.length === judged.length;
  const admittedSilent = admittedSet == null ? null : silent.filter((s) => s.admitted === true);
  const unadmittedSilent = admittedSet == null ? null : silent.filter((s) => s.admitted === false);
  const breaches: string[] = [];
  // Only the live-binding population is described. `strandedCursors` rides on the
  // result instead so residue stays visible without inflating a peer verdict.
  const strandedNote =
    strandedCursors > 0
      ? ` (${strandedCursors} further cursor(s) ignored: stranded under a superseded apply_binding — schema residue, not peers)`
      : '';
  // EI-21322935352272541: the host-wide breach is computed BEFORE the per-scope
  // ladder and deliberately does not enter `breaches` — see the field's doc. When
  // this host admits no remote log in ANY scope, "this scope's peers are absent"
  // is a true sentence about a false subject: the subject is the host.
  let hostWideAdmissionBreach: string | null = null;
  if (
    admittedRemoteLogs === 0 &&
    hostAdmitsAnyRemoteLog === false &&
    unadmittedSilent != null &&
    unadmittedSilent.length > 0
  ) {
    const scopes = opts.hostAdmission?.scopesMeasured ?? 0;
    hostWideAdmissionBreach =
      `HOST ADMITS NO REMOTE LOGS: this host admits 0 remote log(s) across ALL ${scopes} booted scope(s) — its OWN log is the only member of every admitted set. ` +
      `The ${unadmittedSilent.length} silent durable cursor(s) here are therefore NOT a scope-local peer departure; every scope holding durable cursors reports this SAME condition, and which of them alarms is decided by whether we happened to write locally inside the SLO window, not by the fault. ` +
      `ONE host-wide condition: suspect the announce/admission path (no swarm announce frame has been admitted, and no seed log key was resolved) or this host having no reachable peers at all. Do NOT chase it per scope.${strandedNote}`;
  }
  if (admittedRemoteLogs != null && admittedSilent != null && unadmittedSilent != null) {
    // EI-20666095916420554: once admission is measured, it — not every durable
    // cursor — defines the positive-control population. WI-39489 corrected only
    // the all-historical-logs-silent case. With one live admitted peer advancing,
    // four departed peers' durable cursors still produced "4 of 5 peers slow".
    // Keep those cursors visible, but call them ABSENT; and never let a recently
    // updated *unadmitted* cursor license a local/per-peer verdict about admitted
    // logs. A cursor outlives admission, so conflating these populations makes a
    // permanent false major after ordinary peer churn.
    if (admittedRemoteLogs === 0 && unadmittedSilent.length > 0) {
      // EI-21322935352272541: this per-scope reading is only MEANINGFUL when the
      // host admits remote logs SOMEWHERE — that is what makes "our peers here
      // went away" a claim about this scope rather than about the host. When the
      // host admits none anywhere, `hostWideAdmissionBreach` above carries it
      // instead, unscoped and once; emitting both would re-file the same
      // condition in N per-harness dedup buckets, which is the defect.
      //
      // ⚠ Three-way, not two: `hostAdmitsAnyRemoteLog === null` is UNMEASURED and
      // must NOT borrow the `true` wording. Claiming "this host admits peers
      // elsewhere" from an absent measurement is the same ignorance-as-fact error
      // the `null`-vs-`0` split above exists to prevent, so the unmeasured case
      // keeps the original text, which asserts nothing host-wide.
      if (hostWideAdmissionBreach == null) {
        const elsewhere =
          hostAdmitsAnyRemoteLog === true
            ? ` This host DOES admit remote log(s) in other scope(s), so admission itself works and the absence is scope-local.`
            : '';
        breaches.push(
          `NO PEER ADMITTED: ${unadmittedSilent.length} of ${judged.length} durable remote cursor(s) have exceeded the ${opts.silentAfterMs}ms silence SLO, and NONE is in this scope's admitted set. The peers are ABSENT, not slow — nothing current can be folded. Suspect the announce/admission path or peer liveness, NOT this host's merge loop.${elsewhere}${strandedNote}`,
        );
      }
    } else if (admittedRemoteLogs > 0 && admittedSilent.length === admittedRemoteLogs) {
      const freshestAdmittedAdvanceMs = admittedSilent[admittedSilent.length - 1]!.silentForMs;
      const absentNote =
        unadmittedSilent.length > 0
          ? ` ${unadmittedSilent.length} further silent cursor(s) are NOT ADMITTED and represent absent active/unknown peers, not fold lag.`
          : '';
      breaches.push(
        `LOCAL FOLD SUSPECT: all ${admittedRemoteLogs} ADMITTED remote log(s) silent — freshest admitted advance ${freshestAdmittedAdvanceMs}ms ago > SLO ${opts.silentAfterMs}ms. Suspect this host's merge loop, NOT the admitted peers.${absentNote}${strandedNote}`,
      );
    } else if (admittedSilent.length > 0) {
      const absentNote =
        unadmittedSilent.length > 0
          ? ` ${unadmittedSilent.length} further silent cursor(s) are NOT ADMITTED and represent absent active/unknown peers, not slow federation.`
          : '';
      breaches.push(
        `${admittedSilent.length} of ${admittedRemoteLogs} ADMITTED remote log(s) have federated nothing for > SLO ${opts.silentAfterMs}ms (oldest ${admittedSilent[0]!.silentForMs}ms, log ${admittedSilent[0]!.logKeyHex.slice(0, 12)}…) while ${admittedRemoteLogs - admittedSilent.length} admitted log(s) keep advancing.${absentNote}${strandedNote}`,
      );
    } else if (unadmittedSilent.length > 0) {
      breaches.push(
        `PEERS ABSENT: ${unadmittedSilent.length} silent remote cursor(s) are NOT ADMITTED while all ${admittedRemoteLogs} admitted remote log(s) keep advancing inside the ${opts.silentAfterMs}ms SLO. The silent logs represent absent active/unknown peers, not slow federation; suspect peer liveness or the announce/admission path.${strandedNote}`,
      );
    }
  } else if (allSilent) {
    // Admission is unknown. With no advancing raw cursor left as a control, the
    // evidence points at our own fold; ignorance must not be upgraded to a
    // confident absent-peer reading.
    breaches.push(
      `LOCAL FOLD SUSPECT: all ${judged.length} remote log(s) silent — freshest advance ${freshestAdvanceMs}ms ago > SLO ${opts.silentAfterMs}ms. Suspect this host's merge loop, NOT the peers.${strandedNote}`,
    );
  } else if (silent.length > 0) {
    // Admission is unknown, so retain the legacy observable instead of inventing
    // a current-membership claim the scan did not measure.
    breaches.push(
      `${silent.length} of ${judged.length} remote log(s) have federated nothing for > SLO ${opts.silentAfterMs}ms (oldest ${silent[0]!.silentForMs}ms, log ${silent[0]!.logKeyHex.slice(0, 12)}…) while ${judged.length - silent.length} log(s) keep advancing.${strandedNote}`,
    );
  }
  return {
    totalLogs: judged.length,
    measured: true,
    unmeasuredReason: null,
    silent,
    freshestAdvanceMs,
    allSilent,
    breaches,
    strandedCursors,
    retiredCursors,
    liveApplyBinding,
    ownLogSilentForMs,
    admittedRemoteLogs,
    hostAdmitsAnyRemoteLog,
    hostWideAdmissionBreach,
  };
}

/** Read one scope's remote-log fold progress and judge it. */
export async function scanPeerFederationSilence(
  sql: postgres.Sql,
  opts: { workspaceId: string; harness: string; silentAfterMs: number; nowMs?: number },
): Promise<PeerFederationHealth> {
  const nowMs = opts.nowMs ?? Date.now();
  try {
    return await readAndJudgePeerSilence(sql, opts, nowMs);
  } catch (err) {
    // FAIL SOFT, NEVER SILENT. This leg was ADDED to a pass whose other scans
    // (outbox health, double-completion, orphan sweep) already worked, and
    // `runSharedHiveLeg` wraps the whole pass in one try/catch — so a throw here
    // would take those working scans down with it and the scope would report
    // nothing at all. That is the very failure mode this work exists to remove,
    // so the new leg degrades to UNMEASURED (never to "healthy") and the rest of
    // the pass proceeds. Found the hard way: the composition rig's sliced schema
    // lacked substrate_merge_cursor and killed the entire pass with 42P01.
    return {
      totalLogs: 0,
      measured: false,
      unmeasuredReason: 'scan-failed',
      scanError: err instanceof Error ? err.message : String(err),
      // The scan threw, so admission was never read at ANY scope: unmeasured,
      // never a determined "this host admits nothing".
      hostAdmitsAnyRemoteLog: null,
      hostWideAdmissionBreach: null,
      silent: [],
      freshestAdvanceMs: null,
      allSilent: false,
      breaches: [],
      strandedCursors: 0,
      retiredCursors: 0,
      liveApplyBinding: null,
      ownLogSilentForMs: null,
      admittedRemoteLogs: null,
    };
  }
}

async function readAndJudgePeerSilence(
  sql: postgres.Sql,
  opts: { workspaceId: string; harness: string; silentAfterMs: number },
  nowMs: number,
): Promise<PeerFederationHealth> {
  // `apply_binding` is SELECTed, never filtered on here: the judge decides which
  // binding is live from the data and reports the rest as stranded, so a scope
  // whose binding changed is measured rather than silently half-read
  // (EI-20617273180156712).
  const rows = await sql<
    Array<{
      log_keyhex: string;
      position: string | number;
      updated_at_ms: string;
      apply_binding: string | null;
      peer_lifecycle_state: MergeCursorPeerLifecycleState;
    }>
  >`
    SELECT log_keyhex, position, apply_binding, peer_lifecycle_state,
           (extract(epoch FROM updated_at) * 1000)::bigint::text AS updated_at_ms
      FROM harness_shared.substrate_merge_cursor
     WHERE workspace_id = ${opts.workspaceId} AND harness_slug = ${opts.harness}`;
  // OUR OWN newest write in this scope — the dormancy control (see the judge).
  // `substrate_outbox.ts` is this host's write clock regardless of drain state,
  // so it answers "are WE still live here?" without depending on the peers we
  // are about to judge.
  const [local] = await sql<Array<{ newest_ts: string | null }>>`
    SELECT MAX(ts)::text AS newest_ts FROM harness_shared.substrate_outbox
     WHERE workspace_id = ${opts.workspaceId} AND harness_slug = ${opts.harness}`;
  // NO local rows at all is the STRONGEST dormancy evidence, not "unknown": we
  // have never written in this scope, so we are not a participant in it. Passing
  // null here would mean "no evidence, judge anyway" and — measured on host A —
  // filed ~10 false `local-fold-suspect` majors for scopes we never joined
  // (`sheets` 75/75 silent, `papercup` last advance 984h). Infinity says exactly
  // what is true: our last local write was infinitely long ago.
  // ⚠ LIMITATION, stated rather than hidden: a scope we only ever READ from
  // (consume without writing) is indistinguishable from one we never joined, so
  // a genuine stall there reads as dormant. Every scope we actively federate
  // does write, so this trades an unreachable case for ~10 standing false majors.
  const newestLocal = local?.newest_ts == null ? Number.POSITIVE_INFINITY : Number(local.newest_ts);
  // OUR OWN log's key in this scope, so the judge can take it out of the peer
  // population. `substrate_booted_handles_status` is this host publishing its own
  // boot registry (`log-stats.ts` walks `handle.admitted`, stamping `isOwn`
  // against `handle.ownLog.keyHex`), so this reads the SAME authority the fold
  // boots from rather than re-deriving the identity here and being free to drift
  // from it — the failure mode that produced EI-20617273180156712.
  //
  // `undefined` when we cannot find it: the judge treats that as UNMEASURED, so a
  // missing/never-written status row can never silently reinstate the own log as
  // a phantom peer.
  //
  // WI-39489: the SAME row also carries the whole ADMITTED set for the scope
  // (`log-stats.ts` emits one `perLog` entry per member of `handle.admitted`), so
  // the admitted keys are read here rather than from a second source that would
  // be free to disagree with the own key. Selecting every entry and picking the
  // own one out in JS — instead of two queries, or one query with an `isOwn`
  // predicate plus another without — keeps both readings from the SAME snapshot;
  // two reads could straddle a boot and report an own log that is not in the
  // admitted set they are compared against.
  //
  // EI-21322935352272541: the scope predicate is applied in JS, not SQL, so the
  // SAME result set also answers the HOST-WIDE question ("does this host admit
  // ANY remote log, in ANY scope?"). Two queries could straddle a boot and
  // disagree about whether admission exists at all — and a scope reading compared
  // against a host reading from a different snapshot is precisely the
  // cross-population conflation this monitor keeps being bitten by. One read, one
  // snapshot, both readings. `perLog` is one row per admitted log per scope
  // (80 rows for this workspace on this host), so the widened read stays trivial.
  const allAdmittedRows = await sql<Array<{ key_hex: string; is_own: boolean | null; harness_slug: string }>>`
    SELECT pl->>'keyHex' AS key_hex, (pl->>'isOwn')::boolean AS is_own,
           ls->>'harnessSlug' AS harness_slug
      FROM harness_shared.substrate_booted_handles_status s,
           LATERAL jsonb_array_elements(s.payload->'healthInputs'->'logStats') ls,
           LATERAL jsonb_array_elements(ls->'perLog') pl
     WHERE s.workspace_id = ${opts.workspaceId}
       AND ls->>'workspaceId' = ${opts.workspaceId}`;
  const admittedRows = allAdmittedRows.filter((r) => r.harness_slug === opts.harness);
  // NO published boot status ANYWHERE ⇒ host-wide admission is UNKNOWN, not zero
  // — the same distinction the per-scope reading makes just below. Only a
  // measurement that actually saw scopes may report a determined `false`.
  const hostAdmission =
    allAdmittedRows.length > 0
      ? {
          remoteLogsAdmitted: allAdmittedRows.filter((r) => r.is_own !== true).length,
          scopesMeasured: new Set(allAdmittedRows.map((r) => r.harness_slug)).size,
        }
      : undefined;
  const ownLog = admittedRows.find((r) => r.is_own === true);
  // NO rows at all ⇒ this scope has no published boot status, so the admitted set
  // is UNKNOWN, not empty. Passing [] here would assert a determined "no peer is
  // admitted" from an absent measurement — the exact ignorance-as-fact error the
  // `null` reading exists to prevent. (The own-key branch of the judge already
  // returns `own-log-unknown` in this case; this keeps the two consistent if that
  // ever changes.)
  const admittedLogKeysHex = admittedRows.length > 0 ? admittedRows.map((r) => r.key_hex) : undefined;
  return judgePeerFederationSilence(
    rows.map((r) => ({
      logKeyHex: r.log_keyhex,
      position: Number(r.position),
      updatedAtMs: Number(r.updated_at_ms),
      applyBinding: r.apply_binding,
      lifecycleState: r.peer_lifecycle_state,
    })),
    {
      silentAfterMs: opts.silentAfterMs,
      nowMs,
      localActivityAgeMs: newestLocal == null ? null : Math.max(0, nowMs - newestLocal),
      ownLogKeyHex: ownLog?.key_hex,
      admittedLogKeysHex,
      hostAdmission,
    },
  );
}

// ── P-013: presence ghosts (pure) ────────────────────────────────────────────

export interface PresenceRow {
  devicePubkey: string;
  lastSeenMs: number;
}

export interface LeaseHolderRow {
  workItemId: string;
  holderPubkey: string | null;
  expiresTsMs: number;
}

export interface PresenceGhost {
  devicePubkey: string;
  staleForMs: number;
  /** Live leases the ghost still anchors — work nobody is doing. */
  heldItems: string[];
}

export function detectPresenceGhosts(
  presence: readonly PresenceRow[],
  liveLeases: readonly LeaseHolderRow[],
  opts: { staleMs: number; nowMs: number },
): PresenceGhost[] {
  const ghosts: PresenceGhost[] = [];
  for (const p of presence) {
    const staleFor = opts.nowMs - p.lastSeenMs;
    if (staleFor <= opts.staleMs) continue;
    const held = liveLeases
      .filter((l) => l.holderPubkey === p.devicePubkey && l.expiresTsMs > opts.nowMs)
      .map((l) => l.workItemId)
      .sort();
    if (held.length > 0) ghosts.push({ devicePubkey: p.devicePubkey, staleForMs: staleFor, heldItems: held });
  }
  return ghosts.sort((a, b) => (a.devicePubkey < b.devicePubkey ? -1 : 1));
}

// ── P-013: convergence-lag probe ─────────────────────────────────────────────

export interface ConvergenceLagResult {
  lagMs: number;
  arrived: boolean;
  breach: boolean;
}

/**
 * The write-on-A / measure-arrival-on-B probe. `write` performs the marker
 * write on the source swarm; `arrived` polls the destination swarm (and may
 * drive a merge pass). SLO verdict in the result; never throws on timeout —
 * the non-arrival IS the signal.
 */
export async function measureConvergenceLag(opts: {
  write: () => Promise<void>;
  arrived: () => Promise<boolean>;
  sloMs: number;
  pollMs?: number;
  timeoutMs?: number;
  nowFn?: () => number;
}): Promise<ConvergenceLagResult> {
  const now = opts.nowFn ?? Date.now;
  const pollMs = opts.pollMs ?? 250;
  const timeoutMs = opts.timeoutMs ?? Math.max(opts.sloMs * 4, 10_000);
  const t0 = now();
  await opts.write();
  for (;;) {
    if (await opts.arrived()) {
      const lagMs = now() - t0;
      return { lagMs, arrived: true, breach: lagMs > opts.sloMs };
    }
    if (now() - t0 >= timeoutMs) return { lagMs: now() - t0, arrived: false, breach: true };
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

// ── The monitor pass (the routine body) ──────────────────────────────────────

export interface MonitorIncident {
  kind:
    | 'double-completion'
    | 'outbox-health'
    | 'presence-ghost'
    | 'orphaned-taken-by'
    // EI-20579195481991931: a PEER stopped federating to us (or our own fold
    // wedged — the report says which).
    | 'peer-federation-silence'
    // EI-21322935352272541: this host admits NO remote log in ANY booted scope.
    // Deliberately its own kind rather than a per-scope `peer-federation-silence`:
    // it is a fact about the HOST, and filing it per harness re-files one
    // condition into N dedup buckets that no scope-local action can ever clear.
    | 'host-admits-no-remote-logs'
    // EI-20579195481991931: the monitor resolved ZERO scopes on a host that is
    // demonstrably federating — i.e. it did not actually run. Filed LOUDLY,
    // because the failure mode being closed is a monitor whose silence was
    // indistinguishable from health.
    | 'monitor-scope-empty';
  title: string;
  detail: unknown;
}

export interface MonitorPassReport {
  incidents: MonitorIncident[];
  sweptOrphans: number;
  outbox: OutboxHealth;
  /** EI-20579195481991931 — `measured:false` means UNMEASURED, not healthy. */
  peers: PeerFederationHealth;
}

/**
 * One scheduled monitor pass over one swarm's PG. Issue-filing is INJECTED
 * (`fileIncident`) so the scheduling home (shared with the coord-system
 * monitor family) decides dedup/severity; the pass itself stays pure-ish.
 * The orphan sweep only runs when `isAuthority` (see sweepOrphanedTakenBy).
 */
export async function runSharedHiveMonitorPass(opts: {
  sql: postgres.Sql;
  workspaceId: string;
  harness: string;
  isAuthority: boolean;
  presence?: readonly PresenceRow[];
  liveLeases?: readonly LeaseHolderRow[];
  /**
   * EI-21096375006041139: does THIS process currently hold a booted substrate
   * handle for `harness`? Passed straight through to `scanOutboxHealth`'s
   * same-named opt (see there for the full rationale) — a caller that does not
   * track boot residency may omit this; the outbox age SLO then behaves
   * exactly as it always has.
   */
  residentInProcess?: boolean;
  slo?: {
    outboxMaxDepth?: number;
    outboxMaxAgeMs?: number;
    presenceStaleMs?: number;
    orphanGraceMs?: number;
    /** EI-20579195481991931: inbound silence from ONE remote log before we call
     *  it a stall. Generous by design — an idle peer is indistinguishable from a
     *  stalled one from here, so a tight SLO buys false alarms, not sensitivity.
     *  EI-21364751809098626: 6h was NOT generous enough in practice for the
     *  deployment this default actually serves — a personal multi-device pot
     *  (one GitHub member here holds 9 registered device attestations). Traced
     *  a live "HOST ADMITS NO REMOTE LOGS" major-bug alert (187 repeats over 6
     *  days, never actionable) to the owner's OWN second device — verified
     *  admitted today, then simply not running for the rest of the day, which
     *  is ordinary personal usage, not a stalled fold or broken announce path.
     *  No caller overrides this default (grepped), so it IS the production
     *  value for this deployment shape. Raised to 72h: still catches a fold
     *  that stays broken for DAYS, while absorbing an overnight/weekend gap
     *  between a personal device's sessions. */
    peerSilentAfterMs?: number;
  };
  nowMs?: number;
  fileIncident?: (incident: MonitorIncident) => Promise<void>;
}): Promise<MonitorPassReport> {
  const nowMs = opts.nowMs ?? Date.now();
  const incidents: MonitorIncident[] = [];

  const doubles = await scanDoubleCompletionSignals(opts.sql, {
    workspaceId: opts.workspaceId,
    harness: opts.harness,
  });
  for (const d of doubles) {
    incidents.push({
      kind: 'double-completion',
      title: `cross-swarm double completion: ${d.workItemId} settled remotely (${d.remote.authorPubkey?.slice(0, 12) ?? 'unknown'}…) while ${d.localClaim.owner} holds the live lease`,
      detail: d,
    });
  }

  const outbox = await scanOutboxHealth(opts.sql, {
    maxDepth: opts.slo?.outboxMaxDepth ?? 10_000,
    maxAgeMs: opts.slo?.outboxMaxAgeMs ?? 30 * 60_000,
    nowMs,
    workspaceId: opts.workspaceId,
    harness: opts.harness,
    residentInProcess: opts.residentInProcess,
  });
  for (const b of outbox.breaches) {
    incidents.push({ kind: 'outbox-health', title: b, detail: outbox });
  }

  // EI-20579195481991931 — the leg `scanOutboxHealth` structurally cannot cover:
  // a PEER that stopped federating to us. See the block above this function's
  // `judgePeerFederationSilence` for why the all-silent case is a different
  // verdict rather than N peer alarms.
  const peers = await scanPeerFederationSilence(opts.sql, {
    workspaceId: opts.workspaceId,
    harness: opts.harness,
    silentAfterMs: opts.slo?.peerSilentAfterMs ?? 72 * 60 * 60_000,
    nowMs,
  });
  for (const b of peers.breaches) {
    incidents.push({ kind: 'peer-federation-silence', title: b, detail: peers });
  }
  // EI-21322935352272541: emitted per scope like everything else in this pass,
  // but filed under a NON-harness-scoped watchdog key, so the N scopes that all
  // observe this one host-wide condition dedup into a single item instead of N.
  if (peers.hostWideAdmissionBreach) {
    incidents.push({
      kind: 'host-admits-no-remote-logs',
      title: peers.hostWideAdmissionBreach,
      detail: peers,
    });
  }

  if (opts.presence && opts.liveLeases) {
    for (const g of detectPresenceGhosts(opts.presence, opts.liveLeases, {
      staleMs: opts.slo?.presenceStaleMs ?? 10 * 60_000,
      nowMs,
    })) {
      incidents.push({
        kind: 'presence-ghost',
        title: `presence ghost ${g.devicePubkey.slice(0, 12)}… still anchors ${g.heldItems.length} live lease(s)`,
        detail: g,
      });
    }
  }

  let sweptOrphans = 0;
  if (opts.isAuthority) {
    const swept = await sweepOrphanedTakenBy(opts.sql, {
      workspaceId: opts.workspaceId,
      harness: opts.harness,
      graceMs: opts.slo?.orphanGraceMs,
      nowMs,
    });
    sweptOrphans = swept.cleared.length;
    if (sweptOrphans > 0) {
      incidents.push({
        kind: 'orphaned-taken-by',
        title: `${sweptOrphans} orphaned item(s) returned to the backlog (dead holder, no live lease)`,
        detail: swept.cleared,
      });
    }
  }

  if (opts.fileIncident) {
    for (const i of incidents) await opts.fileIncident(i);
  }
  return { incidents, sweptOrphans, outbox, peers };
}
