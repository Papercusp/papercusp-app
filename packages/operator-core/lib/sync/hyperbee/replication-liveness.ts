/**
 * replication-liveness — per-peer replication-liveness registry + stall episodes.
 *
 * Plan: shared-hive-p2p-release-readiness-2026-07-03 P-004 (WI-1840). Closes the
 * WI-183 CLASS: connected-but-dead replication is SILENT — the substrate logs
 * "booted", `peer_connected` fires both ways, and no signal distinguishes a
 * healthy peer from a dead-replication one (the exact live failure of P-059:
 * tower↔VM fed_event replication delivering NOTHING both directions despite
 * healthy network + swarm connects).
 *
 * Relationship to the EXISTING WI-183 detector (`checkReplicationStall` in
 * boot.ts): that detector is peers-count-only and its `replication_stalled`
 * event lands ONLY in the process-local boot-history ring — invisible to the
 * health verdict, to every status surface, and to the durable issue ledger.
 * This module is the SIGNAL + SURFACE + ESCALATION layer on top:
 *
 *   - `sampleReplicationLiveness()` — fed once per admitted REMOTE log per
 *     merge pass (boot.ts `mergeOnePass`, same call site as
 *     `checkReplicationStall`). Tracks peers-count, the writer's known length,
 *     and the MERGE-CURSOR position (how far we've actually ingested).
 *   - `getReplicationLiveness()` — read-time per-log verdicts for status
 *     surfaces (in-process-status → federation-status → health verdict).
 *   - Edge-triggered STALL EPISODES (once per episode, cleared on recovery)
 *     routed to a reporter — production default files a durable EI
 *     (replication-stall-ei.ts), so a stall escalates even if nobody is
 *     watching a status page.
 *
 * Why merge-position (not `contiguousLength`) is the progress signal: a
 * snapshot-seeded joiner NEVER requests blocks before its snapshot index, so
 * `contiguousLength` legitimately stays 0 forever on a healthy sparse replica
 * (see peer-log.ts). The merge cursor's per-log position is seeded from the
 * snapshot index and advances exactly when ops are actually ingested — writer
 * ahead + no position advance for a sustained window IS a genuine freeze,
 * regardless of compaction/sparseness.
 *
 * Verdict ladder (per admitted remote log, derived at READ time):
 *   - 'live'            — replicator attached; caught up OR still ingesting.
 *   - 'never_connected' — never seen a live replicator peer (ordinary churn /
 *                          offline peer; NEVER alarms — mirrors WI-183 gating).
 *   - 'no_replicator'   — WAS replicating, has held 0 replicator peers past the
 *                          grace window (the WI-183 symptom).
 *   - 'frozen'          — replicator attached AND writer is ahead AND merge
 *                          position has not advanced past the grace window
 *                          (attached-but-dead: blocks/ingest not flowing).
 *   - 'sampling_stale'  — the registry itself hasn't been fed for this log
 *                          recently: the merge loop is dead/wedged — the
 *                          detector's own dead-man switch. EI-19328421457282435:
 *                          `getReplicationLiveness` NULLS every live-looking
 *                          field (mergedPosition/knownLength/msSince* etc.) on
 *                          a row with this verdict — a frozen sample must not
 *                          be diffable against a later read as if both were
 *                          live (that false "unchanged mergedPosition" read
 *                          produced a fully-written-up false root cause). Read
 *                          `harness_shared.substrate_merge_cursor` for ground
 *                          truth when a row comes back stale.
 *
 * Pure in-process state: no PG, no timers, no fetch. The registry lives in
 * whichever process runs the substrate merge loop (main process by default;
 * the sidecar when `papercusp-substrate-sidecar` is ON — surfaced there via
 * the additive `getReplicationLiveness` RPC method).
 */

import { recordBootEvent } from './boot-history';
import { trackDetached } from '../../detached-imports';

/** One merge-pass observation of an admitted remote log. */
export interface ReplicationLogSample {
  /** 64-char hex hypercore key of the admitted remote log. */
  keyHex: string;
  /**
   * Writer high-water known to this receiver: max of the locally replicated
   * `core.length` and any verified signed announce `log_length`. This is a
   * liveness comparison value only; merge reads remain bounded by local length.
   */
  knownLength: number;
  /**
   * Actual locally replicated `core.length`, when `knownLength` may also
   * include an announce-advertised high-water. Frozen-stage attribution uses
   * this value to decide whether replication delivered during the stall;
   * omitted callers retain the legacy `knownLength` behavior.
   */
  localLength?: number;
  /**
   * Merge-cursor position for this log — the next index the read-merge will
   * ingest (seeded from the snapshot index on a sparse joiner). `undefined`
   * when the caller can't resolve it (defensive; disables frozen-detection
   * for the sample, never alarms).
   */
  mergedPosition?: number;
  /**
   * Live replicator-peer count for THIS core (`RemoteLog.peersCount()`), or
   * `undefined` when the underlying core doesn't expose `.peers` (fakes in
   * tests) — disables no_replicator detection for the sample.
   */
  peersCount?: number;
  /**
   * Live swarm-connection count for the HARNESS TOPIC at sample time
   * (`SwarmHandle.liveConnectionCount`), or `undefined` when the caller has no
   * swarm handle — disables connected_never_replicated detection.
   *
   * This is the WI-183 ROOT-CAUSE axis (rig run m1783114921): after a restart
   * every re-admitted log is `never_connected` this process lifetime, and the
   * original never-alarms gating made the exact failure class SILENT — swarm
   * says peer_connected (zombie connections via a stale DHT announce record)
   * while the core never attaches a replicator. Swarm-connected + core
   * never-replicated held past grace IS the zombie signature; swarm 0 stays
   * the never-alarms churn case (peer genuinely offline).
   */
  swarmConnections?: number;
  /**
   * Zero-based position among logs with merge backlog in this pass's
   * smallest-backlog-first order. `0` is the active head; `>0` is waiting.
   * Omitted when the caller does not know the queue or this log has no backlog.
   */
  mergeQueueIndex?: number;
  /** Key of queue index 0, paired with `mergeQueueIndex` for diagnostics. */
  mergeQueueHeadKeyHex?: string;
}

/** An edge-triggered stall episode (fires ONCE per episode, per kind). */
export interface ReplicationStallEpisode {
  workspaceId: string;
  harnessSlug: string;
  logKeyHex: string;
  kind:
    | 'no_replicator'
    | 'frozen'
    | 'connected_never_replicated'
    // WI-5781: a peer log this harness is SUPPOSED to be replicating (its
    // signed announce arrived and was buffered) that never entered the
    // admitted set. Every other kind above describes an ADMITTED log; this one
    // is the axis that can see a log which never got that far.
    | 'expected_never_admitted';
  /** How long the stall condition had been held when the episode fired (ms). */
  stalledForMs: number;
  /**
   * EI-18778631943888326: WHICH STAGE is actually stuck, for `kind:'frozen'` only
   * (undefined on every other kind). 'transport' = blocks are not flowing — the
   * classic attached-but-dead reading. 'apply' = replication IS delivering (the
   * writer length advanced during the stall) but the merge/apply stage is not
   * consuming it, so the replicator is the WRONG place to look. Machine-readable
   * counterpart to the wording in `detail`, so a dashboard/triage can route on the
   * stage instead of regex-ing prose.
   */
  stalledStage?: 'transport' | 'apply';
  /** Human-readable one-liner for the boot event / EI body. */
  detail: string;
}

export type ReplicationLogVerdict =
  | 'live'
  | 'never_connected'
  | 'no_replicator'
  | 'frozen'
  | 'sampling_stale'
  // WI-3604: this harness's process resolved a DIFFERENT DHT universe than
  // the operator's declared expectation (see swarm.ts's assertDhtUniverse) —
  // EVERY admitted log in the harness reads this verdict instead of
  // no_replicator/frozen, so the split-DHT-universe outage class is a
  // DISTINCT diagnosis, not indistinguishable "connected-but-dead".
  | 'dht_universe_mismatch';

/** Read-time view of one tracked log. */
export interface ReplicationLogLiveness {
  keyHex: string;
  verdict: ReplicationLogVerdict;
  /**
   * EI-19328421457282435: `null` whenever `stale:true` below. A row whose
   * sample age has crossed `SAMPLING_STALE_AFTER_MS` is a frozen snapshot of
   * whatever the merge loop last reported before it stopped feeding the
   * registry — rendering it as a live number invites a caller to diff two
   * stale reads and conclude "unchanged" (a wedged-merge signature) when the
   * true cause is a dead SAMPLER, not a dead merge. Nulling every live-looking
   * field on a stale row makes that misreading structurally impossible: there
   * is nothing left to diff.
   */
  knownLength: number | null;
  /** Blocks physically present on this receiver, distinct from signed writer high-water. `null` when `stale:true` (see `knownLength`). */
  localLength: number | null;
  mergedPosition: number | null;
  peersCount: number | null;
  /** ms since the log last showed a live replicator peer; null = never, or `stale:true`. */
  msSinceReplicatorSeen: number | null;
  /** ms since the merge position last advanced (or since first sample); null when `stale:true`. */
  msSinceIngestProgress: number | null;
  /** ms since this log was last sampled (merge-loop dead-man input) — ALWAYS populated, staleness-detector input, never nulled. */
  msSinceSampled: number;
  /**
   * EI-19328421457282435: absolute epoch-ms of the last real sample (=
   * `Date.now() - msSinceSampled` at read time, but rendered directly so a
   * caller never has to reconstruct it, and so two reads of the SAME frozen
   * sample carry an identical, unmissable timestamp instead of two different-
   * looking `msSinceSampled` values that merely differ by the polling gap).
   * ALWAYS populated, even when `stale:true`.
   */
  sampledAt: number;
  /**
   * EI-19328421457282435: true when this row's sample age has crossed
   * `SAMPLING_STALE_AFTER_MS` (equivalently, `verdict === 'sampling_stale'`).
   * Every "as if current" field on this row (`knownLength`, `localLength`,
   * `mergedPosition`, `peersCount`, `msSinceReplicatorSeen`,
   * `msSinceIngestProgress`, `mergeQueueIndex`, `mergeQueueHeadKeyHex`,
   * `msSinceMergeQueueHead`, `lastSwarmConnections`) is nulled when this is
   * true — check this flag (or `verdict`) before trusting any of them, and
   * prefer `harness_shared.substrate_merge_cursor` (position + updated_at)
   * as ground truth for actual merge progress when a row reads stale.
   */
  stale: boolean;
  /** Current backlog queue index: 0=head, >0=waiting, null=not queued/unknown, or `stale:true`. */
  mergeQueueIndex: number | null;
  /** Current backlog head key, when queue position is known; null when `stale:true`. */
  mergeQueueHeadKeyHex: string | null;
  /** ms since this log most recently became queue head; null unless index=0, or `stale:true`. */
  msSinceMergeQueueHead: number | null;
  /**
   * The swarmConnections value the LAST sample carried — what the
   * connected_never_replicated axis actually sees. null = the sampler never
   * passed one (axis disabled at the source), or `stale:true`. Diagnostics:
   * the m1783120511 silent-detector incident was only diagnosable by
   * rebuilding with this field — keep it so the next "axis never fired" is
   * one RPC read.
   */
  lastSwarmConnections: number | null;
  /**
   * WI-6873: `max(0, knownLength - mergedPosition)` — how many ops this log
   * still has to replay before it is caught up. `null` when `stale:true` or
   * `mergedPosition` is unknown (same nulling convention as the other
   * derived fields above).
   *
   * Closes the WI-6873 class: a `verdict:'live'` log mid-replay after a
   * restart (e.g. ~600k ops / ~15 min backlog) and a `verdict:'live'` log
   * that is fully caught up were PREVIOUSLY INDISTINGUISHABLE on this row —
   * both just read "live". `knownLength`/`mergedPosition` were already
   * present and a caller COULD subtract them, but nothing named the
   * resulting number, so a consumer waiting on a specific just-published op
   * (e.g. a `spawn_request` offer) had no way to tell "still catching up,
   * give it a few minutes" from "broken, go investigate". See also
   * `counts.catchingUp`.
   */
  backlogOps: number | null;
}

/** Read-time view of one harness's replication liveness. */
export interface HarnessReplicationLiveness {
  workspaceId: string;
  harnessSlug: string;
  logs: ReplicationLogLiveness[];
  /** Rollup counts the health verdict consumes. */
  counts: {
    live: number;
    neverConnected: number;
    noReplicator: number;
    frozen: number;
    samplingStale: number;
    dhtUniverseMismatch: number;
    /**
     * WI-5781: peers whose announce we accepted but whose log has never been
     * admitted, so no other count above can represent them (they are not in
     * the merge set at all). Nonzero here means replication is expected and
     * NOT happening — read it alongside `logs`, never instead of it.
     */
    expectedNeverAdmitted: number;
    /**
     * WI-6873: how many of the `live` logs above are ALSO mid-backlog
     * (`backlogOps > 0`) — actively replaying, not frozen, not yet caught up.
     * A nonzero count here is the "still catching up" signal this axis was
     * missing: it means at least one op you are waiting on may simply not
     * have replayed yet, distinct from every other count in this object
     * (which all mean "something is actually wrong"). Never alarms; purely
     * informational. See `logs[].backlogOps` for the per-log ops-behind count.
     */
    catchingUp: number;
  };
  /** WI-5781: the expected-but-unadmitted peers backing the count above. */
  expectedNeverAdmitted: Array<{
    keyHex: string;
    pendingForMs: number;
    reason: string | null;
    alarmed: boolean;
  }>;
  /** WI-3604: true when this harness's process is currently flagged as having
   * resolved the wrong DHT universe (see `setDhtUniverseAssertion`). */
  dhtUniverseMismatch: boolean;
  /** Human-readable detail for the mismatch, when `dhtUniverseMismatch`. */
  dhtUniverseDetail?: string;
}

interface LogState {
  keyHex: string;
  lastSampleMs: number;
  knownLength: number;
  /** Last actual locally replicated core length observed. */
  localLength: number;
  mergedPosition: number | null;
  peersCount: number | null;
  /** Last time peersCount was observed > 0; null = never (never alarms). */
  lastNonZeroPeersMs: number | null;
  /** Last time mergedPosition advanced (seeded at first sample with a position). */
  lastIngestProgressMs: number | null;
  /**
   * EI-18778631943888326 + WI-38376: last time the ACTUAL local core length
   * advanced — i.e. replication delivered writer updates to this replica.
   * `knownLength` can now advance from a signed announce without local block
   * delivery, so it is not a valid stage-attribution signal by itself. null =
   * never observed advancing this process lifetime. Used only for attribution.
   */
  lastLocalLengthProgressMs: number | null;
  /**
   * Start of the current swarm-connected-while-NOT-replicating window; null
   * when the condition doesn't hold (sustained-offline, or a replicator is
   * attached right now). WI-183 zombie axis.
   *
   * WI-5639: this window used to be armed ONLY while the log had never
   * attached a replicator this process lifetime (`lastNonZeroPeersMs === null`).
   * It is now armed whenever NO replicator is attached *right now* — see the
   * axis body for why that gate left a whole failure class unrepairable.
   */
  connectedNeverReplSinceMs: number | null;
  /**
   * Last sample time with swarmConnections > 0. Zombie connections CHURN
   * (rig run m1783114921: ~10s lifetimes with reconnect gaps), so a swarm=0
   * sample resets the window only after a SUSTAINED offline stretch
   * (SWARM_CHURN_TOLERANCE_MS) — otherwise churn gaps would eternally reset
   * the clock and the detector would stay silent in exactly the zombie case.
   */
  lastSwarmSeenMs: number | null;
  /** Verbatim swarmConnections from the last sample (null = not passed). */
  lastSwarmConnections: number | null;
  /** Current smallest-backlog-first merge queue position (0=head). */
  mergeQueueIndex: number | null;
  /** Key currently at queue index 0, when the queue is known. */
  mergeQueueHeadKeyHex: string | null;
  /** Eligibility clock: when this log most recently became queue head. */
  lastMergeQueueHeadMs: number | null;
  alarmedNoReplicator: boolean;
  alarmedFrozen: boolean;
  alarmedConnectedNever: boolean;
  /**
   * WI-7011 — has this process ALREADY asked the durable ledger whether an EI is
   * open for this (log, axis)? One latch per axis, set on the FIRST healthy
   * observation of that axis and never cleared for the LogState's lifetime.
   *
   * Why a latch and not just "the alarm flag is false": for a RESTARTED process
   * there is no alarm→recovered TRANSITION to hang the probe on. The log reads
   * healthy from its very first sample and every sample after, so
   * "healthy && !alarmed" is true on EVERY merge pass — gating the probe on that
   * alone would be one PG read per pass per log, forever. The latch turns it into
   * at most ONE read per (log, axis) per process lifetime.
   *
   * Not persisted on purpose: it is a per-process memo of a per-process question
   * ("have I checked yet?"), and a fresh process SHOULD ask again — that is the
   * whole point of the rehydration.
   */
  durableProbedNoReplicator: boolean;
  durableProbedFrozen: boolean;
  durableProbedConnectedNever: boolean;
}

/** Registry: `${workspaceId}::${harnessSlug}` → keyHex → state. */
const registry = new Map<string, Map<string, LogState>>();

/**
 * WI-5781 — the EXPECTED-but-unadmitted axis.
 *
 * Every axis above samples logs drawn from the ADMITTED set, because the sole
 * caller of `sampleReplicationLiveness` runs inside the merge pass's
 * per-admitted-log loop. That makes the detector structurally incapable of
 * reporting the failure where a log is never admitted at all: it is never
 * iterated, so it is never sampled, so nothing is emitted — the monitor is
 * gated on its own precondition, and "broken" and "healthy" produce the same
 * observable (silence).
 *
 * This bit us for real. A member frame received the owner's signed announce,
 * buffered it on a membership miss, and never admitted it. Replication was
 * dead for the whole window and the member emitted ZERO detector lines, while
 * the owner frame — which HAD admitted the member's log — alarmed and repaired
 * correctly off the same code. The asymmetry is one line in
 * `classifySameHiveMember`: on a membership miss the owner admits, the member
 * buffers. A buffered peer then retries every ~5s for up to
 * BOOT_PENDING_GRACE_MS (30 min) and is dropped with `announce_rejected` —
 * without ever producing a liveness alarm or a durable EI.
 *
 * So liveness must ALSO be driven by what we are SUPPOSED to be replicating,
 * not only by what we already attached. A peer whose announce we accepted and
 * buffered is exactly that expectation, and it is the cheapest correct source
 * for it: no roster read, no new I/O, already in memory.
 *
 * Kept in its own map rather than folded into `LogState` on purpose — an
 * unadmitted peer has no knownLength / mergedPosition / peersCount, and
 * synthesising those to fit the shared shape would feed meaningless values to
 * the existing verdict logic and risk regressing the axes that DO work.
 * Same module, same registry keyspace, same episode + durable-EI machinery.
 */
interface UnadmittedState {
  keyHex: string;
  /** When this peer entered the pending buffer (its announce's arrival). */
  pendingSinceMs: number;
  /** Last time the merge pass observed it still unadmitted. */
  lastSampleMs: number;
  /** Why admission has not happened yet, verbatim for the EI body. */
  reason: string | null;
  alarmed: boolean;
}

/** Registry: `${workspaceId}::${harnessSlug}` → keyHex → unadmitted state. */
const unadmittedRegistry = new Map<string, Map<string, UnadmittedState>>();

const hKey = (workspaceId: string, harnessSlug: string): string =>
  `${workspaceId}::${harnessSlug}`;

/**
 * WI-3604: per-harness DHT-universe assertion state, set once per join
 * (boot.ts `joinForBinding`, right after `getSharedSwarm()` resolves) via
 * {@link setDhtUniverseAssertion}. Separate from `registry` because the
 * mismatch flag must be visible even for a harness with ZERO sampled logs
 * yet (or none at all) — `getReplicationLiveness` iterates the UNION of both
 * maps' keys.
 */
const dhtUniverseState = new Map<string, { mismatched: boolean; detail: string }>();

/**
 * Record this process's DHT-universe assertion result for one harness — feeds
 * the `dht_universe_mismatch` verdict axis. Call once per join, right after
 * `getSharedSwarm()` resolves (see boot.ts `joinForBinding`). `ok:true` clears
 * any previously-recorded mismatch for this harness (e.g. a later re-join
 * after the misconfiguration was fixed).
 */
export function setDhtUniverseAssertion(
  workspaceId: string,
  harnessSlug: string,
  assertion: { ok: boolean; detail: string },
): void {
  const key = hKey(workspaceId, harnessSlug);
  if (assertion.ok) {
    dhtUniverseState.delete(key);
  } else {
    dhtUniverseState.set(key, { mismatched: true, detail: assertion.detail });
  }
}

/**
 * Default grace (ms) a stall condition must hold before an episode fires.
 * Mirrors boot.ts's DEFAULT_REPLICATION_STALL_GRACE_MS rationale (3 min
 * comfortably exceeds the two-speed swarm re-peer cadence).
 */
export const DEFAULT_LIVENESS_GRACE_MS = 3 * 60 * 1000;

/**
 * Read-time dead-man threshold: a log not sampled for this long means the
 * merge loop itself is dead/wedged (the sampler rides the ~1s merge poll, so
 * 60s is ~60 missed passes). Not configurable per-sample — it's a property of
 * the READ, and reads pass `nowMs` in tests.
 */
export const SAMPLING_STALE_AFTER_MS = 60 * 1000;

/**
 * How long the swarm may sample 0 connections before the zombie-window clock
 * resets. Zombie connections churn (~10s lifetimes + reconnect gaps on rig run
 * m1783114921); a genuinely-offline peer shows a SUSTAINED zero stretch.
 */
export const SWARM_CHURN_TOLERANCE_MS = 60 * 1000;

export interface SampleReplicationLivenessOpts {
  /**
   * Stall grace window (ms) for the no_replicator and frozen axes. Default
   * DEFAULT_LIVENESS_GRACE_MS (180s).
   */
  graceMs?: number;
  /**
   * WI-5686: SEPARATE grace window (ms) for the connected_never_replicated
   * (WI-183 zombie-socket) axis ONLY. Defaults to `graceMs` when omitted —
   * unset behavior is unchanged. Exists because a caller may legitimately
   * want the zombie axis to fire much faster than the general axes (WI-5634:
   * a rig soak sizes it to ~15s, well inside its own SLA, so repair-on-detect
   * gets a chance to heal a genuine dead socket before the SLA expires)
   * WITHOUT that shortened window also collapsing no_replicator/frozen's
   * grace — a cold-restart+re-peer cycle legitimately holds 0 peers for far
   * longer than 15s while healthy, so sharing one grace value across all
   * three axes made no_replicator false-fire (and its repair-on-detect tear
   * down + re-open the session) on every ordinary restart, discovered as the
   * WI-5672/WI-5686 false-positive class.
   */
  connectedNeverReplicatedGraceMs?: number;
  /**
   * WI-38376: SEPARATE grace window (ms) for the `frozen` axis ONLY. Defaults
   * to `graceMs` when omitted — unset behavior is unchanged.
   *
   * WI-5686 gave the zombie axis its own knob so a rig could shorten it
   * without collapsing no_replicator's grace, and that reasoning stopped one
   * axis short. `frozen` is the ONLY axis that covers "a replicator IS
   * attached and the writer IS ahead, but nothing is arriving" — and it was
   * left sharing the 180s default with no_replicator. replication_soak
   * enforces a 90s SLA, so on run m1786592636 its cycle-3 A→B failure produced
   * ZERO detector events on any of the three frames: the scenario gave up at
   * 90s, the axis that would have explained it needed 180s. Three prior items
   * (WI-5448/WI-5634/WI-5639) chased load and host pressure for a signal that
   * was never going to be emitted.
   *
   * Unlike no_replicator, shortening THIS axis does not re-open the
   * WI-5672/WI-5686 false-positive class. That class came from a cold restart
   * legitimately holding 0 peers well past 15s; the frozen axis requires
   * `peersCount > 0` AND a writer-ahead position AND zero merge progress, so a
   * 0-peer re-peer window cannot arm it at all. It also carries the
   * transport-vs-apply discriminator (`stalledStage`), which is exactly the
   * question an SLA miss leaves open.
   */
  frozenGraceMs?: number;
  /** Test seam — clock override. */
  nowMs?: number;
  /**
   * Episode sink override. Omit for the module default (boot event +
   * durable-EI reporter). Pass explicitly in unit tests.
   */
  onStallEpisode?: (episode: ReplicationStallEpisode) => void;
  /**
   * EI-7110: recovery sink override — fires when a log transitions OUT of an
   * alarmed stall state (a live replicator peer / ingest progress is seen again
   * after having stalled past grace). Omit for the module default (auto-resolves
   * the durable EI `fileReplicationStallEi` filed for the stall). Pass explicitly
   * in unit tests. Wired for ALL THREE axes — no_replicator, frozen, AND
   * connected_never_replicated (EI-4643 class: a zombie-connection EI previously
   * sat open forever because only the no_replicator axis reported recovery; now
   * each axis auto-resolves its own EI when the underlying replication recovers).
   */
  // EI-16949: kept as a plain `=> void` (not `void | Promise<void>`) on
  // purpose — every call site fires this with `void onRecovery(...)`
  // (fire-and-forget), and TS's void-return bivariance already lets a
  // Promise-returning function (e.g. the default `reportRecovery`) satisfy
  // a `=> void` target. Widening this to a union broke that bivariance
  // exemption and red-lit every test callback that returns a non-void value
  // (e.g. `(e) => someCounter++`) under `tsc --noEmit`.
  onRecovery?: (recovery: ReplicationStallEpisode) => void;
}

/**
 * Module-level episode reporter seam. Production default: record a boot event
 * (`replication_stalled` / `replication_frozen`) AND file a durable EI via a
 * LAZY dynamic import (never at module load — keeps this module pure for unit
 * tests and avoids dragging PG into every importer). Both legs are
 * fire-and-forget + swallow-all: a reporter hiccup must never wedge the merge
 * pass the sampler rides.
 */
let episodeReporter: ((episode: ReplicationStallEpisode) => void) | null = null;

export function setReplicationStallEpisodeReporterForTests(
  fn: ((episode: ReplicationStallEpisode) => void) | null,
): void {
  episodeReporter = fn;
}

/**
 * EI-7110: module-level RECOVERY reporter seam — the counterpart to
 * episodeReporter above. Without this, a durable EI filed for a stall (P-004 /
 * WI-1840) never auto-clears even once the underlying replication recovers:
 * `sampleReplicationLiveness` already resets the in-process `alarmedX` latch on
 * recovery (so a FUTURE stall re-fires), but nothing ever told the durable EI
 * the stall is over — it just sits open forever, needing a human/agent to
 * manually re-verify + close it (the exact toil this closes: EI-7110 was hit
 * by a fleet member 20h after the stall likely self-healed, unable to cheaply
 * confirm current status). Production default: auto-resolve the matching open
 * EI via a LAZY dynamic import (same pattern as defaultEpisodeReporter).
 */
// EI-16949: kept as a plain `=> void` (not `void | Promise<void>`) — see the
// matching note on `onRecovery` above. `reportRecovery` below wraps whatever
// this returns in `Promise.resolve(...)`, so a Promise-returning production
// reporter (`defaultRecoveryReporter`) already works fine through this seam
// without widening the type; widening it broke the void-bivariance exemption
// for every non-void test callback passed to `setReplicationStallRecoveryReporterForTests`.
let episodeRecoveredReporter:
  | ((recovery: ReplicationStallEpisode) => void)
  | null = null;

/**
 * WI-7011 — the DURABLE-ALARM probe seam.
 *
 * THE BUG THIS CLOSES. Every recovery report above is gated on an in-process
 * `alarmedX` flag, and those flags live in `registry` — a module-scoped
 * in-memory Map that a fresh process initialises to `false`. So:
 *
 *   1. Process A observes the stall → `alarmedX = true` → files a durable EI.
 *   2. Process A exits (deploy, sidecar restart, crash).
 *   3. Process B starts → fresh registry → `alarmedX = false`.
 *   4. The log recovers → `wasAlarmed` is FALSE → no recovery is reported →
 *      `resolveReplicationStallEi` is never called.
 *   5. The EI stays open FOREVER, asserting a stall that ended days ago.
 *
 * Measured 2026-08-02: 43 of 47 open non-drain [replication-liveness] EIs had
 * been silent 5.7–27.5 days (the emitter re-pages a STANDING condition every
 * 24h, so multi-day silence means the condition is not standing). 36 of them sat
 * on the two most ACTIVE harnesses — which is the tell, and the opposite of the
 * intuition that busy systems get cleaned up best: the most-restarted harnesses
 * orphan the most alarms.
 *
 * THE FIX is to stop treating the in-process flag as the only evidence a stall
 * happened. An OPEN EI is the durable equivalent of `alarmedX = true`, and it is
 * the one signal that survives the reset — `hasOpenReplicationStallEi`'s own doc
 * says exactly that, and boot.ts's repair ladder already relies on it for the
 * very same per-process-reset problem. This path simply asks it too.
 *
 * Production default: a LAZY dynamic import (same pattern as the two reporters
 * above — the module never statically links PG). Pass a stub in unit tests.
 *
 * CLASS NOTE: third instance of one pattern (WI-6997 was the outbox-drain latch).
 * A recovery path gated on IN-PROCESS state cannot resolve a DURABLE artifact
 * filed by a PREVIOUS process. Any file/resolve pair whose file-side is durable
 * and whose resolve-side is gated on memory has this bug.
 */
export type OpenStallEiProbe = (episode: {
  harnessSlug: string;
  logKeyHex: string;
  kind: ReplicationStallEpisode['kind'];
}) => Promise<boolean>;

const defaultOpenStallEiProbe: OpenStallEiProbe = (episode) =>
  import('./replication-stall-ei').then((m) => m.hasOpenReplicationStallEi(episode));

let openStallEiProbe: OpenStallEiProbe | null = null;

export function setOpenStallEiProbeForTests(fn: OpenStallEiProbe | null): void {
  openStallEiProbe = fn;
}

/**
 * WI-7011: on the FIRST healthy observation of one axis for one log in THIS
 * process, ask the durable ledger whether a PREVIOUS process left an EI open for
 * it — and if so, report the recovery the in-process flag could not.
 *
 * Bounded by the `durableProbed*` latch to at most ONE read per (log, axis) per
 * process lifetime; see the latch's own doc for why "healthy && !alarmed" is NOT
 * a usable edge on its own.
 *
 * Best-effort in the same sense as every other reporter here: fire-and-forget,
 * swallow-all, and NEVER throws back into the merge pass it rides. A probe miss
 * just leaves the EI open for manual triage — exactly the status quo it improves
 * on, so a failure can never be worse than not having tried.
 *
 * Deliberately emits NO console line: this module's tests run under
 * vitest-fail-on-console, and a recovered-by-rehydration is not a fault worth a
 * diagnostic anyway — the recovery reporter it delegates to already logs.
 */
function probeDurableAlarm(
  st: LogState,
  latch: 'durableProbedNoReplicator' | 'durableProbedFrozen' | 'durableProbedConnectedNever',
  episode: ReplicationStallEpisode,
  onRecovery: (recovery: ReplicationStallEpisode) => void,
): void {
  if (st[latch]) return;
  // Latch BEFORE firing: the probe is async and the merge pass is re-entrant, so
  // latching afterwards would let every pass in the probe's flight window queue
  // another read (and, worse, report the same recovery N times).
  st[latch] = true;
  try {
    void Promise.resolve(
      (openStallEiProbe ?? defaultOpenStallEiProbe)({
        harnessSlug: episode.harnessSlug,
        logKeyHex: episode.logKeyHex,
        kind: episode.kind,
      }),
    )
      .then((isOpen) => {
        if (isOpen) onRecovery(episode);
      })
      .catch(() => {
        /* best-effort: a probe miss leaves the EI open, same as before this existed */
      });
  } catch {
    /* never let the probe throw back into the merge pass */
  }
}

export function setReplicationStallRecoveryReporterForTests(
  fn: ((recovery: ReplicationStallEpisode) => void) | null,
): void {
  episodeRecoveredReporter = fn;
}

/**
 * WI-3684 repair-on-detect: per-harness REPAIR handler, registered by the
 * process that owns the harness's substrate handle (boot.ts) and invoked for
 * EVERY stall episode this module fires — alongside the reporter, never
 * instead of it. The registry's defect class (WI-3684, unified from the
 * SESSION_CLOSED retry storm + the ef7a8160 connected_never_replicated fire)
 * was DETECT-WITHOUT-REPAIR: every axis alarmed correctly and nothing acted,
 * so each detection was a dead end a human had to convert into a restart.
 * The handler fires at exactly the right moment — the episode carries the
 * (workspace, harness, logKeyHex) triple while the stall is CURRENT — and the
 * registrant decides what a repair means (boot.ts: enqueue a session
 * re-attach applied under the merge gate). Episodes are edge-triggered (once
 * per stall), so a handler is naturally rate-limited to one invocation per
 * episode per kind; the registrant adds its own attempt cap on top.
 * Keyed per harness; cleared on `dropReplicationLiveness` (handle close) so a
 * closed harness's handler can never act on a stale `admitted` set.
 */
export type ReplicationRepairHandler = (episode: ReplicationStallEpisode) => void;
const repairHandlers = new Map<string, ReplicationRepairHandler>();

export function setReplicationRepairHandler(
  workspaceId: string,
  harnessSlug: string,
  handler: ReplicationRepairHandler | null,
): void {
  const key = hKey(workspaceId, harnessSlug);
  if (handler) repairHandlers.set(key, handler);
  else repairHandlers.delete(key);
}

function dispatchRepair(episode: ReplicationStallEpisode): void {
  const handler = repairHandlers.get(hKey(episode.workspaceId, episode.harnessSlug));
  if (!handler) return;
  try {
    handler(episode);
  } catch {
    /* a repair-handler throw must never wedge the merge pass the sampler rides */
  }
}

function defaultEpisodeReporter(episode: ReplicationStallEpisode): void {
  // Leg 0 — a LOUD process-log line carrying the grep-able event token. The b8
  // matrix scenario's detector-assert (and any live witness) greps serve.log
  // for `replication_stalled` / `replication_frozen`; the boot-history ring and
  // the EI are both invisible to a log grep, so without this line a firing
  // detector is indistinguishable from a silent one on the rig (the exact gap
  // rig run m1783114921 exposed).
  const eventName =
    episode.kind === 'frozen' ? 'replication_frozen' : 'replication_stalled';
  try {
     
    console.error(
      `[replication-liveness] ${eventName} (${episode.kind}) harness=${episode.harnessSlug} ${episode.detail}`,
    );
  } catch {
    /* diagnostic-only */
  }
  // Leg 1 — boot-history event (in-process timeline; same ring the legacy
  // WI-183 detector writes to). The legacy `checkReplicationStall` already
  // records `replication_stalled` for the no_replicator kind, so to avoid a
  // duplicate ring entry it is skipped here; the NEW `frozen` and
  // `connected_never_replicated` kinds are this module's own (the legacy
  // peers-only detector shares the never-was-replicating blind spot, so it
  // can never duplicate the zombie kind).
  if (episode.kind === 'frozen' || episode.kind === 'connected_never_replicated') {
    try {
      recordBootEvent(
        episode.workspaceId,
        episode.harnessSlug,
        eventName,
        episode.detail,
      );
    } catch {
      /* diagnostic-only */
    }
  }
  // Leg 2 — durable EI (the escalation P-004 requires: visible fleet-wide even
  // if nobody reads this process's status). Lazy import so the pure module
  // never statically links PG.
  void trackDetached(import('./replication-stall-ei'))
    .then((m) => m.fileReplicationStallEi(episode))
    .catch(() => {
      /* escalation is best-effort; the registry verdict still surfaces it */
    });
}

function reportEpisode(episode: ReplicationStallEpisode): void {
  try {
    (episodeReporter ?? defaultEpisodeReporter)(episode);
  } catch {
    /* never let a reporter throw back into the merge pass */
  }
}

// EI-16949/WI-183-orphan-class: this returns a Promise (previously void) so an
// INTENTIONAL close path (dropReplicationLiveness/dropReplicationLogState) can
// AWAIT the durable-EI auto-resolve write actually landing before the process
// that called it exits — see the header doc on dropReplicationLiveness. The hot
// merge-pass call sites in sampleReplicationLiveness below deliberately keep
// firing this WITHOUT awaiting (`void reportRecovery(...)`), so this change adds
// no latency to the sampling path — only a caller that explicitly awaits pays for
// the completion. The returned promise NEVER rejects (every internal failure is
// swallowed) so an unawaited call is exactly as safe as the old void-returning one.
function defaultRecoveryReporter(recovery: ReplicationStallEpisode): Promise<void> {
  try {
    console.error(
      `[replication-liveness] recovered (${recovery.kind}) harness=${recovery.harnessSlug} ${recovery.detail}`,
    );
  } catch {
    /* diagnostic-only */
  }
  // Auto-resolve the durable EI the stall filed (best-effort; a resolve miss
  // just leaves the EI open for manual triage, same as before this existed).
  // Lazy import so the pure module never statically links PG.
  return import('./replication-stall-ei')
    .then((m) => m.resolveReplicationStallEi(recovery))
    .then(() => undefined)
    .catch(() => {
      /* resolution is best-effort; the registry verdict already reads 'live' */
    });
}

function reportRecovery(recovery: ReplicationStallEpisode): Promise<void> {
  try {
    return Promise.resolve((episodeRecoveredReporter ?? defaultRecoveryReporter)(recovery));
  } catch {
    /* never let a reporter throw back into the merge pass */
    return Promise.resolve();
  }
}

/**
 * Feed one merge-pass observation of an admitted REMOTE log. Call once per
 * remote log per pass (boot.ts mergeOnePass). Never throws.
 */
export function sampleReplicationLiveness(
  workspaceId: string,
  harnessSlug: string,
  sample: ReplicationLogSample,
  opts: SampleReplicationLivenessOpts = {},
): void {
  const now = opts.nowMs ?? Date.now();
  const graceMs = opts.graceMs ?? DEFAULT_LIVENESS_GRACE_MS;
  // WI-5686: the zombie axis gets its OWN grace, defaulting to `graceMs` when
  // the caller doesn't distinguish (unchanged behavior for every existing
  // caller/test that only ever set `graceMs`).
  const zombieGraceMs = opts.connectedNeverReplicatedGraceMs ?? graceMs;
  // WI-38376: same pattern for the frozen axis — its own grace, defaulting to
  // `graceMs` so every existing caller/test is unaffected.
  const frozenGraceMs = opts.frozenGraceMs ?? graceMs;
  const onEpisode = opts.onStallEpisode ?? reportEpisode;
  const onRecovery = opts.onRecovery ?? reportRecovery;
  const localLength = sample.localLength ?? sample.knownLength;

  let logs = registry.get(hKey(workspaceId, harnessSlug));
  if (!logs) {
    logs = new Map();
    registry.set(hKey(workspaceId, harnessSlug), logs);
  }
  let st = logs.get(sample.keyHex);
  if (!st) {
    st = {
      keyHex: sample.keyHex,
      lastSampleMs: now,
      knownLength: sample.knownLength,
      localLength,
      mergedPosition: sample.mergedPosition ?? null,
      peersCount: sample.peersCount ?? null,
      lastNonZeroPeersMs: null,
      // Seed progress clock at first sight so a pre-existing backlog doesn't
      // instantly alarm — it gets a full grace window from first observation.
      lastIngestProgressMs: sample.mergedPosition !== undefined ? now : null,
      // EI-18778631943888326: null (never observed advancing) rather than `now` —
      // seeding it to `now` would let the very first sample masquerade as "delivery
      // observed" and mis-attribute a genuine transport freeze to apply.
      lastLocalLengthProgressMs: null,
      connectedNeverReplSinceMs: null,
      lastSwarmSeenMs: null,
      lastSwarmConnections: null,
      mergeQueueIndex: sample.mergeQueueIndex ?? null,
      mergeQueueHeadKeyHex: sample.mergeQueueHeadKeyHex ?? null,
      lastMergeQueueHeadMs: sample.mergeQueueIndex === 0 ? now : null,
      alarmedNoReplicator: false,
      alarmedFrozen: false,
      alarmedConnectedNever: false,
      // WI-7011: nothing probed yet — the first healthy observation of each axis
      // asks the durable ledger once, then latches.
      durableProbedNoReplicator: false,
      durableProbedFrozen: false,
      durableProbedConnectedNever: false,
    };
    logs.set(sample.keyHex, st);
  }

  // Was this log ALREADY behind at the previous sample? Computed BEFORE the
  // overwrite: a caught-up→behind transition starts a FRESH grace window from
  // this observation (between samples we cannot know when the backlog
  // appeared, and an idle stretch must never pre-age the freeze clock).
  const wasBehind =
    st.mergedPosition !== null && st.knownLength > st.mergedPosition;
  const becameMergeQueueHead =
    sample.mergeQueueIndex === 0 && st.mergeQueueIndex !== 0;
  st.lastSampleMs = now;
  // WI-38376: `knownLength` may advance from the signed announce heartbeat even
  // when this receiver has delivered zero blocks. Preserve EI-18778631943888326's
  // transport-vs-apply attribution using the actual local core length instead.
  if (localLength > st.localLength) st.lastLocalLengthProgressMs = now;
  st.localLength = localLength;
  st.knownLength = sample.knownLength;
  st.lastSwarmConnections = sample.swarmConnections ?? null;
  st.mergeQueueIndex = sample.mergeQueueIndex ?? null;
  st.mergeQueueHeadKeyHex = sample.mergeQueueHeadKeyHex ?? null;
  if (becameMergeQueueHead) st.lastMergeQueueHeadMs = now;
  else if (sample.mergeQueueIndex !== 0) st.lastMergeQueueHeadMs = null;

  // ── peers-count axis (no_replicator) ──
  if (sample.peersCount !== undefined) {
    st.peersCount = sample.peersCount;
    if (sample.peersCount > 0) {
      // EI-7110: capture BOTH the prior alarm state and the stall duration
      // BEFORE overwriting lastNonZeroPeersMs — only a genuine alarm→recovered
      // transition is worth reporting (a log that never alarmed, or that was
      // merely flapping within grace, has no open EI to auto-resolve).
      const wasAlarmed = st.alarmedNoReplicator;
      const priorStallMs = st.lastNonZeroPeersMs !== null ? now - st.lastNonZeroPeersMs : 0;
      st.lastNonZeroPeersMs = now;
      st.alarmedNoReplicator = false; // recovered — a future stall re-fires
      if (!wasAlarmed) {
        // WI-7011: healthy, and THIS process never saw it stall — which is also
        // exactly what a restart looks like. Ask the durable ledger once whether a
        // previous process left an EI open for this log; if so, THAT is the alarm
        // this process lost, and the recovery is real.
        probeDurableAlarm(st, 'durableProbedNoReplicator', {
          workspaceId,
          harnessSlug,
          logKeyHex: sample.keyHex,
          kind: 'no_replicator',
          stalledForMs: 0, // the stall began in a previous process — unknown here
          detail:
            `log=${sample.keyHex.slice(0, 12)}… has a live replicator peer, and an EI ` +
            `filed by a previous process was still open (durable rehydration, WI-7011)`,
        }, onRecovery);
      }
      if (wasAlarmed) {
        // First-hand knowledge — nothing to rehydrate; latch so no read is spent
        // and no duplicate report can race the async resolve (see the zombie axis).
        st.durableProbedNoReplicator = true;
        void onRecovery({
          workspaceId,
          harnessSlug,
          logKeyHex: sample.keyHex,
          kind: 'no_replicator',
          stalledForMs: priorStallMs,
          detail:
            `log=${sample.keyHex.slice(0, 12)}… regained a live replicator peer after ` +
            `${Math.round(priorStallMs / 1000)}s with none`,
        });
      }
    } else {
      // peersCount === 0: the replicator has DETACHED.
      //
      // EI-7834: a prior FROZEN alarm's premise ("replicator ATTACHED but
      // ingesting nothing") no longer holds once no replicator is attached — the
      // log is now a no_replicator stall (fired just below), NOT frozen. Clear the
      // frozen latch and REPORT its recovery so the durable frozen EI auto-closes
      // instead of stranding open forever. Without this, a log that froze and then
      // lost its replicator kept `alarmedFrozen` latched (deriveVerdict keeps
      // reading 'frozen') and the per-log frozen-recovery path — which only fires
      // on ingest-progress / caught-up — can NEVER run with 0 peers, so the frozen
      // EI sat open permanently (the observed orphaned-frozen-EI pile-up: log
      // 298a676c froze → EI filed → replicator detached → no_replicator/zombie EIs
      // fired but the frozen EI never resolved). Mirrors the drop-path recovery
      // (EI-7788) and the ingest-resume recovery (EI-4643): a frozen condition that
      // ENDS — however it ends — must report so its EI does not orphan.
      if (st.alarmedFrozen) {
        const frozenStallMs =
          st.lastIngestProgressMs !== null ? now - st.lastIngestProgressMs : 0;
        st.alarmedFrozen = false;
        // Fresh freeze-clock: if the replicator later re-attaches while still
        // behind, it earns a full grace window from the re-attach, not an instant
        // re-alarm carried over the detached stretch.
        st.lastIngestProgressMs = now;
        void onRecovery({
          workspaceId,
          harnessSlug,
          logKeyHex: sample.keyHex,
          kind: 'frozen',
          stalledForMs: frozenStallMs,
          detail:
            `log=${sample.keyHex.slice(0, 12)}… frozen condition ended after ` +
            `${Math.round(frozenStallMs / 1000)}s — replicator detached ` +
            `(now tracked as no_replicator; the frozen-ingest concern no longer applies)`,
        });
      }
      // no_replicator alarm — a log that WAS replicating has held 0 peers past
      // grace (unchanged behavior).
      if (
        st.lastNonZeroPeersMs !== null &&
        !st.alarmedNoReplicator &&
        now - st.lastNonZeroPeersMs >= graceMs
      ) {
        st.alarmedNoReplicator = true;
        const episode: ReplicationStallEpisode = {
          workspaceId,
          harnessSlug,
          logKeyHex: sample.keyHex,
          kind: 'no_replicator',
          stalledForMs: now - st.lastNonZeroPeersMs,
          detail:
            `log=${sample.keyHex.slice(0, 12)}… has had 0 live replicator peers for ` +
            `${Math.round((now - st.lastNonZeroPeersMs) / 1000)}s (was previously replicating)`,
        };
        onEpisode(episode);
        dispatchRepair(episode);
      }
    }
  }

  // ── swarm-connected-but-NOT-replicating axis (WI-183 zombie connections) ──
  // Fires when the harness topic HAS live swarm connections yet this admitted
  // log has NO replicator attached, held ≥ grace.
  // Discriminates the zombie-connection class (stale DHT announce record →
  // relay handshake connects, data path dead — rig run m1783114921: 18min
  // silent window) from ordinary churn (swarm 0 → peer offline → never alarm).
  //
  // WI-5639: this axis used to be gated on `st.lastNonZeroPeersMs === null` —
  // i.e. it armed ONLY for a log that had never attached a replicator in this
  // process lifetime, and was PERMANENTLY disarmed for that log the moment one
  // attached (nothing resets lastNonZeroPeersMs; the only reset is the
  // drop path's `logs.delete()`, which fires on revoke / re-verify-drop /
  // handle-close — never on a PEER restart). That left the
  // "was replicating → peer restarted → replicator detached → swarm sockets
  // still live" state with NO repair path whatsoever, because every other rung
  // is also blind to it:
  //   - `no_replicator` fires (180s) but is EXCLUDED from boot.ts's
  //     REPAIRABLE_EPISODE_KINDS, so its dispatchRepair() is a no-op;
  //   - swarm.ts's severed-link escalation needs `liveConnectionCount === 0`
  //     (swarm.ts:1350) and these sockets are live, so it never trips;
  //   - `frozen` requires a replicator ATTACHED, which is the negation here.
  // Live proof (gate run 20260725-143908, frame a, harness=hello-world):
  // zombie repair healed the log at 18:48:29, `no_replicator` fired at
  // 18:48:44 with NO repair, and the link then sat dead for 25 MINUTES —
  // swallowing restart_durability's post-restart write and reconnect_catchup's
  // baseline. Arming on "no replicator attached RIGHT NOW" closes that hole and
  // needs no boot.ts change, since this kind is already repairable.
  //
  // This does NOT re-open the WI-5686 false-positive class. That regression
  // came from shortening the `no_replicator` grace UNCONDITIONALLY, so an
  // ordinary cold-restart re-peer — peer genuinely gone, swarmConnections === 0
  // — false-fired and tore sessions down. The `swarmConnections > 0` gate below
  // excludes exactly that case: while the peer is down the window is never
  // started, and once it reconnects this grants the same zombieGraceMs
  // attach-tolerance the never-attached path already gets.
  const replicatorAttachedNow = (st.peersCount ?? 0) > 0;
  if (sample.swarmConnections !== undefined && !replicatorAttachedNow) {
    if (sample.swarmConnections > 0) {
      st.lastSwarmSeenMs = now;
      if (st.connectedNeverReplSinceMs === null) st.connectedNeverReplSinceMs = now;
      if (
        !st.alarmedConnectedNever &&
        now - st.connectedNeverReplSinceMs >= zombieGraceMs
      ) {
        st.alarmedConnectedNever = true;
        // WI-5639: keep the episode KIND stable (`connected_never_replicated`
        // is persisted in boot_events/EI rows, matched by the rig's scenario
        // greps, and already listed in REPAIRABLE_EPISODE_KINDS — renaming it
        // would invalidate historical triage logs mid-release-stabilisation).
        // The sub-case is carried in `detail` behind a stable grep token so
        // forensics can still tell the two apart.
        const subCase = st.lastNonZeroPeersMs === null
          ? 'never_attached'
          : 'replicator_lost';
        // EI-18726252562537043: this used to read "this log has NEVER attached
        // a replicator" / "LOST its replicator and has not re-attached" —
        // phrasing that names a LOCAL cause (our attachTo never ran) the
        // observation does not establish. `peersCount` is `core.peers.length`,
        // which requires the REMOTE to also open/serve this core on the
        // connection; a verified unit probe (fact
        // wi-5673-lead-peerscount-requires-remote-to-serve) showed a fully-
        // attached local session sitting at peersCount=0 forever against a
        // remote that never served the key. That local-fault wording sent a
        // real investigation (WI-5673) down a dead end chasing our own attach
        // path — see fact dead-end:wi-5673-root-cause-hypothesis-attach-race —
        // and directly contradicted the "Common cause: ... PEER side" sentence
        // later in this same `detail` string. Report the OBSERVATION (no
        // replicator peer entry exists) and name both hypotheses; do not
        // assert which side is at fault.
        const attachPhrase =
          subCase === 'never_attached'
            ? 'no replicator has attached to this log — either this process never attached it, or (more commonly) the remote peer never opened/served this core on the connection'
            : 'this log has no replicator attached and has not re-attached — either our side has not re-attached, or the remote stopped serving this core on the connection';
        const episode: ReplicationStallEpisode = {
          workspaceId,
          harnessSlug,
          logKeyHex: sample.keyHex,
          kind: 'connected_never_replicated',
          stalledForMs: now - st.connectedNeverReplSinceMs,
          detail:
            `[${subCase}] log=${sample.keyHex.slice(0, 12)}… swarm has ${sample.swarmConnections} live ` +
            `connection(s) but ${attachPhrase} ` +
            `(${Math.round((now - st.connectedNeverReplSinceMs) / 1000)}s connected-but-dead — ` +
            `WI-183 zombie-connection class). Common cause: host-resource exhaustion on the ` +
            `PEER side (disk-full ENOSPC crash-looping its serve process, CPU/load starvation) ` +
            `— the connection itself looks alive while the peer never actually completes a ` +
            `handshake (EI-8982: a Mac VM's Data volume hit 100% and produced exactly this ` +
            `connect/drop-every-25s signature on the OTHER machine, undetected for hours). Check ` +
            `the peer's disk usage (\`df -h\`) and serve.log for ENOSPC/crash-loop before assuming ` +
            `a pure network/DHT issue.`,
        };
        onEpisode(episode);
        dispatchRepair(episode);
      }
    } else if (
      st.connectedNeverReplSinceMs !== null &&
      st.lastSwarmSeenMs !== null &&
      now - st.lastSwarmSeenMs > SWARM_CHURN_TOLERANCE_MS
    ) {
      // SUSTAINED offline (past churn tolerance) → genuinely-offline peer;
      // reset the window. A transient zero (zombie reconnect gap) keeps it.
      st.connectedNeverReplSinceMs = null;
      // WI-5639: the alarm latch MUST clear with the window it belongs to.
      // It used to leak: `alarmedConnectedNever` stayed true across a
      // sustained-offline reset, so (i) the fire guard `!st.alarmedConnectedNever`
      // suppressed the alarm FOREVER on the next zombie window for this log, and
      // (ii) deriveVerdict kept reading 'no_replicator' off the stale latch.
      // Previously near-unreachable (the axis only ran for never-replicated
      // logs, which rarely see a sustained-offline reset); now that the axis
      // arms for every currently-detached log, this is a live path.
      st.alarmedConnectedNever = false;
    }
  } else if (replicatorAttachedNow && st.connectedNeverReplSinceMs !== null) {
    // Replication established — recovered; a future zombie window re-fires.
    // WI-5639: keyed on "a replicator is attached RIGHT NOW", the exact
    // negation of the arming condition above. The old `lastNonZeroPeersMs !==
    // null` test meant "attached at SOME point this lifetime", which stayed
    // true forever once set — so a log that lost its replicator could report a
    // spurious recovery while still dead.
    // EI-4643: report the recovery so the durable EI a zombie episode filed
    // auto-closes. Previously only the no_replicator axis was wired, so a
    // connected_never_replicated EI (this exact class) sat open forever — it
    // could not auto-clear even once the log attached a replicator.
    const wasAlarmedConnectedNever = st.alarmedConnectedNever;
    const zombieStallMs = now - st.connectedNeverReplSinceMs;
    st.connectedNeverReplSinceMs = null;
    st.alarmedConnectedNever = false;
    if (wasAlarmedConnectedNever) {
      // This process HAS first-hand knowledge of the stall and just resolved it —
      // so there is nothing for the durable probe to rehydrate. Latch it (WI-7011)
      // to spend no read, and to make a duplicate report impossible: the resolve
      // above is async, so a probe racing it would still read the EI as open.
      st.durableProbedConnectedNever = true;
      void onRecovery({
        workspaceId,
        harnessSlug,
        logKeyHex: sample.keyHex,
        kind: 'connected_never_replicated',
        stalledForMs: zombieStallMs,
        detail:
          `log=${sample.keyHex.slice(0, 12)}… attached a live replicator after ` +
          `${Math.round(zombieStallMs / 1000)}s swarm-connected-but-dead`,
      });
    }
  }

  // WI-7011: the zombie axis needs its own healthy-observation probe, and it
  // CANNOT ride the recovery branch above — that branch requires
  // `connectedNeverReplSinceMs !== null` (a zombie window this process opened),
  // which is always null in a fresh process. So on a restart the branch is
  // structurally unreachable and the orphaned EI could never clear. Keyed on the
  // same "a replicator is attached RIGHT NOW" signal the branch uses.
  if (replicatorAttachedNow && !st.alarmedConnectedNever) {
    probeDurableAlarm(
      st,
      'durableProbedConnectedNever',
      {
        workspaceId,
        harnessSlug,
        logKeyHex: sample.keyHex,
        kind: 'connected_never_replicated',
        stalledForMs: 0, // the stall began in a previous process — unknown here
        detail:
          `log=${sample.keyHex.slice(0, 12)}… has a live replicator attached, and an EI ` +
          `filed by a previous process was still open (durable rehydration, WI-7011)`,
      },
      onRecovery,
    );
  }

  // ── ingest-progress axis (frozen) ──
  if (sample.mergedPosition !== undefined) {
    const prev = st.mergedPosition;
    st.mergedPosition = sample.mergedPosition;
    // EI-4643 follow-up: when a FROZEN alarm clears (ingest resumes or the log
    // catches up) report the recovery so the durable EI auto-closes — previously
    // the frozen axis reset its latch silently and left the EI open forever.
    const wasAlarmedFrozen = st.alarmedFrozen;
    const frozenStallMs =
      st.lastIngestProgressMs !== null ? now - st.lastIngestProgressMs : 0;
    const clearFrozen = (): void => {
      st.lastIngestProgressMs = now;
      st.alarmedFrozen = false;
      if (!wasAlarmedFrozen) {
        // WI-7011: ingest is healthy and THIS process never saw it freeze — the
        // restart signature. Ask the durable ledger once.
        probeDurableAlarm(
          st,
          'durableProbedFrozen',
          {
            workspaceId,
            harnessSlug,
            logKeyHex: sample.keyHex,
            kind: 'frozen',
            stalledForMs: 0, // the stall began in a previous process — unknown here
            detail:
              `log=${sample.keyHex.slice(0, 12)}… is ingesting normally, and an EI filed ` +
              `by a previous process was still open (durable rehydration, WI-7011)`,
          },
          onRecovery,
        );
      }
      if (wasAlarmedFrozen) {
        // First-hand knowledge — nothing to rehydrate; latch so no read is spent
        // and no duplicate report can race the async resolve (see the zombie axis).
        st.durableProbedFrozen = true;
        void onRecovery({
          workspaceId,
          harnessSlug,
          logKeyHex: sample.keyHex,
          kind: 'frozen',
          stalledForMs: frozenStallMs,
          detail:
            `log=${sample.keyHex.slice(0, 12)}… ingest resumed after ` +
            `${Math.round(frozenStallMs / 1000)}s frozen ` +
            `(merged to ${sample.mergedPosition} of ${st.knownLength})`,
        });
      }
    };
    const queuedBehindMergeHead = (sample.mergeQueueIndex ?? 0) > 0;
    const freezeClockMs =
      st.lastIngestProgressMs === null
        ? st.lastMergeQueueHeadMs
        : st.lastMergeQueueHeadMs === null
          ? st.lastIngestProgressMs
          : Math.max(st.lastIngestProgressMs, st.lastMergeQueueHeadMs);
    if (queuedBehindMergeHead || becameMergeQueueHead) {
      // EI-20317490590418053: zero movement is expected while another backlog
      // is ahead. Once this log becomes head it earns a fresh grace window;
      // otherwise its queued age becomes an instant false freeze before the
      // merge can attempt its first op.
      if (wasAlarmedFrozen) {
        st.alarmedFrozen = false;
        st.durableProbedFrozen = true;
        void onRecovery({
          workspaceId,
          harnessSlug,
          logKeyHex: sample.keyHex,
          kind: 'frozen',
          stalledForMs: frozenStallMs,
          detail: queuedBehindMergeHead
            ? `log=${sample.keyHex.slice(0, 12)}… is waiting at merge queue index ` +
              `${sample.mergeQueueIndex} behind ${sample.mergeQueueHeadKeyHex?.slice(0, 12) ?? 'unknown'}…; ` +
              `the prior frozen premise no longer applies`
            : `log=${sample.keyHex.slice(0, 12)}… became merge queue head and received a fresh ` +
              `ingest grace window; the prior frozen premise no longer applies`,
        });
      }
    } else if (prev === null || sample.mergedPosition > prev) {
      clearFrozen(); // ingesting — recovered
    } else if (st.knownLength <= sample.mergedPosition) {
      // Caught up: nothing to ingest. Healthy idle — keep the clock fresh so a
      // later backlog gets a full grace window.
      clearFrozen();
    } else if (!wasBehind) {
      // Just BECAME behind (caught-up → behind between samples): the freeze
      // window starts at this observation, not at the last idle refresh. Never a
      // recovery (a prior not-behind sample cannot have alarmed frozen).
      st.lastIngestProgressMs = now;
      st.alarmedFrozen = false;
    } else if (
      (st.peersCount ?? 0) > 0 &&
      freezeClockMs !== null &&
      !st.alarmedFrozen &&
      now - freezeClockMs >= frozenGraceMs
    ) {
      // Replicator attached, writer is ahead, and we have ingested NOTHING for
      // the whole grace window. Gated on peers>0 so a plainly-disconnected peer
      // alarms on the peers axis (or never, if it was never connected), not twice.
      //
      // EI-18778631943888326: this used to say, unconditionally, "replicator
      // attached but ingest frozen" — which names the REPLICATOR as the suspect.
      // That is only one of two causes, and during the WI-559 diagnosis it was the
      // WRONG one: replication was healthy (the peer was streaming, bytesReceived
      // climbing) while the MERGE PASS aborted every ~60s on an FK violation, so
      // mergedPosition never moved. The alarm sent the reader toward the
      // replicator/swarm layer while the actual defect sat in apply.
      //
      // Discriminate with actual local core progress. `knownLength` may include
      // WI-38376's signed announce high-water and can therefore move without a
      // single block arriving; only `localLength` proves delivery. Attribution
      // only — the episode still fires identically either way.
      st.alarmedFrozen = true;
      // STRICTLY greater, not >=: the sample where a log first becomes behind sets BOTH
      // clocks to the same instant, so `>=` would count the window-STARTING observation
      // as in-window delivery and mis-attribute a log that received updates and then went
      // dark to 'apply' forever. Delivery only counts if it happened strictly AFTER the
      // freeze window opened — the discriminator is scoped to THIS stall, not "ever
      // delivered". (Caught by the third attribution test, which failed on `>=`.)
      const deliveringDuringStall =
        st.lastLocalLengthProgressMs !== null &&
        st.lastLocalLengthProgressMs > freezeClockMs;
      const stalledSecs = Math.round((now - freezeClockMs) / 1000);
      const positions =
        `writer at ${st.knownLength}, merged to ${sample.mergedPosition}, ` +
        `no merge progress for ${stalledSecs}s`;
      const episode: ReplicationStallEpisode = {
        workspaceId,
        harnessSlug,
        logKeyHex: sample.keyHex,
        kind: 'frozen',
        stalledForMs: now - freezeClockMs,
        stalledStage: deliveringDuringStall ? 'apply' : 'transport',
        detail: deliveringDuringStall
          ? `log=${sample.keyHex.slice(0, 12)}… APPLY/MERGE frozen — replication is ` +
            `DELIVERING (writer length advanced during this stall) but the merge pass is ` +
            `not consuming it: ${positions}. Look at the MERGE/apply stage, NOT the ` +
            `replicator or swarm — e.g. a merge pass aborting mid-batch (a constraint ` +
            `violation rolls back the whole pass), or ops being quarantined/dropped at apply. ` +
            `Check the serve log for "merge pass FAILED" / quarantine lines for this harness.`
          : `log=${sample.keyHex.slice(0, 12)}… replicator attached but NOT DELIVERING ` +
            `(writer length has not advanced during this stall): ${positions}. ` +
            `Blocks are not flowing — look at the replicator/swarm layer.`,
      };
      onEpisode(episode);
      dispatchRepair(episode);
    }
  }
}

/**
 * EI-20453145044075727 — intra-pass liveness HEARTBEAT.
 *
 * `sampleReplicationLiveness` is fed exactly ONCE per merge pass, at the TOP
 * of the pass, before the (possibly long-running) fold body runs. A single
 * pass over one log's backlog is BOUNDED to `maxOpsPerPass` (the per-author
 * read budget, boot.ts), not to any wall-clock limit — read-merge.ts's own
 * docs say a pass over a large backlog can legitimately outlast the 240s
 * bg-host watchdog and never return within that window. The `sampling_stale`
 * dead-man axis (`SAMPLING_STALE_AFTER_MS`, 60s) cannot tell that apart from
 * a genuinely wedged merge loop, because nothing re-feeds the registry while
 * the fold is still running — so BOTH the actively-folding log AND any other
 * admitted log merely queued behind it (already sampled once at pass start,
 * untouched since) read `sampling_stale` for the whole legitimately-slow
 * pass, even while the substrate handle stays healthy/booted.
 *
 * `mergeAdmittedLogsIncremental`'s `onCursorAdvance` hook already fires
 * periodically (every `MERGE_PERSIST_EVERY_OPS`, and once more at the end of
 * each log's fold) DURING a pass, carrying the cursor's current per-log
 * positions — exactly the "the merge loop is still alive and making
 * progress" signal the dead-man axis is missing. Wire it here.
 *
 * Deliberately does NOT create new registry entries and touches ONLY
 * `lastSampleMs` — never `knownLength`/`mergedPosition`/`peersCount`/etc.
 * Those remain the sole responsibility of `sampleReplicationLiveness`'s
 * once-per-pass call (which has the real peers/swarm counts this hook does
 * not), so this cannot mask a genuine no_replicator/frozen stall — only the
 * sampling_stale dead-man axis, which is what a live cursor advance actually
 * proves. A key with no existing state (not yet sampled this process
 * lifetime, or already dropped) is silently ignored.
 */
export function touchReplicationLivenessSamples(
  workspaceId: string,
  harnessSlug: string,
  keyHexes: Iterable<string>,
  opts: { nowMs?: number } = {},
): void {
  const logs = registry.get(hKey(workspaceId, harnessSlug));
  if (!logs) return;
  const now = opts.nowMs ?? Date.now();
  for (const keyHex of keyHexes) {
    const st = logs.get(keyHex);
    if (st) st.lastSampleMs = now;
  }
}

function deriveVerdict(
  st: LogState,
  now: number,
  graceMs: number,
  harnessMismatched = false,
  // WI-5686: defaults to `graceMs` — a caller that doesn't pass this (every
  // pre-existing call site) sees unchanged behavior.
  zombieGraceMs: number = graceMs,
  // WI-38376: likewise defaults to `graceMs`. This MUST track the sample-time
  // frozen arming condition — a read-time gate stricter than the alarm makes
  // the liveness RPC report 'live' for a log the sampler has already alarmed
  // on (the same trap WI-5639 fixed for the zombie axis).
  frozenGraceMs: number = graceMs,
): ReplicationLogVerdict {
  // WI-3604: a flagged DHT-universe mismatch overrides every other axis for
  // this harness's logs — the split-DHT-universe outage class must read as
  // ITS OWN distinct verdict, never indistinguishable "connected-but-dead"
  // (no_replicator/frozen) or a stale-sampler false alarm.
  if (harnessMismatched) return 'dht_universe_mismatch';
  if (now - st.lastSampleMs >= SAMPLING_STALE_AFTER_MS) return 'sampling_stale';
  // Alarm states (edge-latched) OR live-derived equivalents — read-time truth
  // even between samples.
  if (
    st.alarmedNoReplicator ||
    (st.peersCount === 0 &&
      st.lastNonZeroPeersMs !== null &&
      now - st.lastNonZeroPeersMs >= graceMs)
  ) {
    return 'no_replicator';
  }
  // WI-183 zombie axis: swarm-connected + not-replicating past grace reads as
  // no_replicator (the symptom bucket every consumer already treats as red) —
  // the episode kind carries the precise diagnosis for triage.
  // WI-5639: mirrors the sample-time arming condition exactly ("no replicator
  // attached RIGHT NOW", not "never attached this lifetime"). These two must
  // agree — a read-time gate stricter than the alarm makes the liveness RPC
  // report 'live' for a log the sampler has already alarmed on.
  if (
    st.alarmedConnectedNever ||
    ((st.peersCount ?? 0) === 0 &&
      st.connectedNeverReplSinceMs !== null &&
      now - st.connectedNeverReplSinceMs >= zombieGraceMs)
  ) {
    return 'no_replicator';
  }
  const queuedBehindMergeHead = (st.mergeQueueIndex ?? 0) > 0;
  const freezeClockMs =
    st.lastIngestProgressMs === null
      ? st.lastMergeQueueHeadMs
      : st.lastMergeQueueHeadMs === null
        ? st.lastIngestProgressMs
        : Math.max(st.lastIngestProgressMs, st.lastMergeQueueHeadMs);
  if (
    !queuedBehindMergeHead &&
    (st.alarmedFrozen ||
      ((st.peersCount ?? 0) > 0 &&
      st.mergedPosition !== null &&
      st.knownLength > st.mergedPosition &&
      freezeClockMs !== null &&
      now - freezeClockMs >= frozenGraceMs))
  ) {
    return 'frozen';
  }
  if (st.lastNonZeroPeersMs === null) return 'never_connected';
  return 'live';
}

/**
 * WI-5781 — sample a peer we EXPECT to be replicating but have NOT admitted.
 *
 * Called from the merge pass for each entry still sitting in the pending
 * buffer. Fires one episode (and its durable EI) once the peer has been
 * expected-but-unadmitted for longer than `graceMs`, then stays latched until
 * `clearUnadmittedPeer` reports the admission.
 *
 * Edge-triggered like every other axis: one alarm per episode, not one per
 * merge pass. Best-effort throughout — this rides the merge pass and must
 * never be able to break it.
 */
export function sampleUnadmittedPeer(
  workspaceId: string,
  harnessSlug: string,
  sample: { keyHex: string; pendingSinceMs: number; reason?: string | null },
  opts: { nowMs?: number; graceMs?: number; onStallEpisode?: (e: ReplicationStallEpisode) => void } = {},
): void {
  const now = opts.nowMs ?? Date.now();
  const graceMs = opts.graceMs ?? DEFAULT_LIVENESS_GRACE_MS;
  const onEpisode = opts.onStallEpisode ?? reportEpisode;

  const key = hKey(workspaceId, harnessSlug);
  let peers = unadmittedRegistry.get(key);
  if (!peers) {
    peers = new Map();
    unadmittedRegistry.set(key, peers);
  }
  let st = peers.get(sample.keyHex);
  if (!st) {
    st = {
      keyHex: sample.keyHex,
      pendingSinceMs: sample.pendingSinceMs,
      lastSampleMs: now,
      reason: sample.reason ?? null,
      alarmed: false,
    };
    peers.set(sample.keyHex, st);
  } else {
    st.lastSampleMs = now;
    // Keep the EARLIEST known pending time: a re-buffer must not reset the
    // clock, or a peer that re-announces every few seconds would never age
    // past the grace window and would be permanently invisible — the exact
    // absorbing-state shape this axis exists to break.
    st.pendingSinceMs = Math.min(st.pendingSinceMs, sample.pendingSinceMs);
    if (sample.reason != null) st.reason = sample.reason;
  }

  const pendingForMs = now - st.pendingSinceMs;
  if (!st.alarmed && pendingForMs > graceMs) {
    st.alarmed = true;
    onEpisode({
      workspaceId,
      harnessSlug,
      logKeyHex: st.keyHex,
      kind: 'expected_never_admitted',
      stalledForMs: pendingForMs,
      detail:
        `this peer's signed announce was accepted ${Math.round(pendingForMs / 1000)}s ago but its log has NEVER been ` +
        `admitted, so it is not in the merge set and NO other replication axis can see it` +
        (st.reason ? ` — pending reason: ${st.reason}` : '') +
        `. On a MEMBER frame the usual cause is a membership miss: the owner's hive_members row has not federated in ` +
        `yet, and the member buffers instead of admitting (the owner does the reverse). That is circular — the row ` +
        `arrives via the replication this admission gates — so it can persist until the pending grace expires.`,
    });
  }
}

/**
 * WI-5781 — a previously-unadmitted peer has been admitted (or dropped).
 * Clears the pending state and, if an episode had fired, reports the recovery
 * so the durable EI auto-resolves like every other axis.
 */
export function clearUnadmittedPeer(
  workspaceId: string,
  harnessSlug: string,
  keyHex: string,
  opts: { nowMs?: number; onRecovery?: (e: ReplicationStallEpisode) => void } = {},
): void {
  const key = hKey(workspaceId, harnessSlug);
  const peers = unadmittedRegistry.get(key);
  const st = peers?.get(keyHex);
  if (!st || !peers) return;
  peers.delete(keyHex);
  if (peers.size === 0) unadmittedRegistry.delete(key);
  if (!st.alarmed) return;
  const now = opts.nowMs ?? Date.now();
  const onRecovery = opts.onRecovery ?? ((e: ReplicationStallEpisode) => void reportRecovery(e));
  onRecovery({
    workspaceId,
    harnessSlug,
    logKeyHex: keyHex,
    kind: 'expected_never_admitted',
    stalledForMs: now - st.pendingSinceMs,
    detail: `log was admitted after ${Math.round((now - st.pendingSinceMs) / 1000)}s expected-but-unadmitted`,
  });
}

export interface GetReplicationLivenessOpts {
  workspaceId?: string;
  harnessSlug?: string;
  /** Test seam — clock override. */
  nowMs?: number;
  /** Grace used for read-time derivation. Default DEFAULT_LIVENESS_GRACE_MS. */
  graceMs?: number;
  /**
   * WI-5686: separate read-time grace for the connected_never_replicated
   * (zombie) axis — mirrors `SampleReplicationLivenessOpts.connectedNeverReplicatedGraceMs`.
   * Defaults to `graceMs` when omitted.
   */
  connectedNeverReplicatedGraceMs?: number;
  /**
   * WI-38376: separate read-time grace for the `frozen` axis — mirrors
   * `SampleReplicationLivenessOpts.frozenGraceMs`. Defaults to `graceMs` when
   * omitted. Must be fed from the same source as the sample-time value or the
   * RPC reports 'live' for a log the sampler has already alarmed on.
   */
  frozenGraceMs?: number;
}

/** Read-time snapshot of every tracked (workspace, harness)'s per-log liveness. */
export function getReplicationLiveness(
  opts: GetReplicationLivenessOpts = {},
): HarnessReplicationLiveness[] {
  const now = opts.nowMs ?? Date.now();
  const graceMs = opts.graceMs ?? DEFAULT_LIVENESS_GRACE_MS;
  const zombieGraceMs = opts.connectedNeverReplicatedGraceMs ?? graceMs;
  const frozenGraceMs = opts.frozenGraceMs ?? graceMs;
  const out: HarnessReplicationLiveness[] = [];
  // WI-3604: iterate the UNION of registry keys ∪ dhtUniverseState keys — a
  // harness may have the mismatch flag set with zero sampled logs (e.g. it
  // just joined and hasn't admitted any remote logs yet, or has none).
  // WI-5781: include harnesses that have ONLY unadmitted peers. Such a harness
  // has zero sampled logs by definition — the whole point of the axis — so
  // omitting this key would hide exactly the case it was added to surface.
  const allKeys = new Set<string>([
    ...registry.keys(),
    ...dhtUniverseState.keys(),
    ...unadmittedRegistry.keys(),
  ]);
  for (const key of allKeys) {
    const sep = key.indexOf('::');
    const workspaceId = key.slice(0, sep);
    const harnessSlug = key.slice(sep + 2);
    if (opts.workspaceId && workspaceId !== opts.workspaceId) continue;
    if (opts.harnessSlug && harnessSlug !== opts.harnessSlug) continue;
    const logs = registry.get(key);
    const mismatch = dhtUniverseState.get(key);
    const harnessMismatched = mismatch?.mismatched ?? false;
    const rows: ReplicationLogLiveness[] = [];
    const counts = {
      live: 0,
      neverConnected: 0,
      noReplicator: 0,
      frozen: 0,
      samplingStale: 0,
      dhtUniverseMismatch: 0,
      expectedNeverAdmitted: 0,
      catchingUp: 0,
    };
    // WI-5781: expected-but-unadmitted peers for this harness.
    const unadmittedRows: HarnessReplicationLiveness['expectedNeverAdmitted'] = [];
    for (const u of unadmittedRegistry.get(key)?.values() ?? []) {
      unadmittedRows.push({
        keyHex: u.keyHex,
        pendingForMs: now - u.pendingSinceMs,
        reason: u.reason,
        alarmed: u.alarmed,
      });
    }
    counts.expectedNeverAdmitted = unadmittedRows.length;
    for (const st of logs?.values() ?? []) {
      const verdict = deriveVerdict(
        st,
        now,
        graceMs,
        harnessMismatched,
        zombieGraceMs,
        frozenGraceMs,
      );
      if (verdict === 'live') counts.live += 1;
      else if (verdict === 'never_connected') counts.neverConnected += 1;
      else if (verdict === 'no_replicator') counts.noReplicator += 1;
      else if (verdict === 'frozen') counts.frozen += 1;
      else if (verdict === 'dht_universe_mismatch') counts.dhtUniverseMismatch += 1;
      else counts.samplingStale += 1;
      // EI-19328421457282435: `sampling_stale` means the merge loop has not fed
      // this log's registry entry within SAMPLING_STALE_AFTER_MS — every other
      // field below is a FROZEN snapshot of whatever it last reported. Emitting
      // those as if current lets a caller diff two stale reads and conclude
      // "unchanged" (a wedged-merge signature) when the true fault is a dead
      // SAMPLER. Null every live-looking field on a stale row so there is
      // nothing left to misread as a live comparison; `msSinceSampled` and the
      // new `sampledAt`/`stale` markers remain populated — they ARE the
      // staleness signal.
      const stale = verdict === 'sampling_stale';
      // WI-6873: derived here (not stored on LogState) so it can never drift
      // from knownLength/mergedPosition — always max(0, …): a strictly-older
      // or momentarily-inconsistent sample must never render as a negative
      // backlog. Same stale-nulling convention as every other derived field.
      const backlogOps =
        stale || st.mergedPosition === null ? null : Math.max(0, st.knownLength - st.mergedPosition);
      if (verdict === 'live' && backlogOps !== null && backlogOps > 0) counts.catchingUp += 1;
      rows.push({
        keyHex: st.keyHex,
        verdict,
        stale,
        sampledAt: st.lastSampleMs,
        backlogOps,
        knownLength: stale ? null : st.knownLength,
        localLength: stale ? null : st.localLength,
        mergedPosition: stale ? null : st.mergedPosition,
        peersCount: stale ? null : st.peersCount,
        msSinceReplicatorSeen: stale
          ? null
          : st.lastNonZeroPeersMs === null
            ? null
            : now - st.lastNonZeroPeersMs,
        msSinceIngestProgress: stale
          ? null
          : st.lastIngestProgressMs === null
            ? null
            : now - st.lastIngestProgressMs,
        msSinceSampled: now - st.lastSampleMs,
        mergeQueueIndex: stale ? null : st.mergeQueueIndex,
        mergeQueueHeadKeyHex: stale ? null : st.mergeQueueHeadKeyHex,
        msSinceMergeQueueHead: stale
          ? null
          : st.lastMergeQueueHeadMs === null
            ? null
            : now - st.lastMergeQueueHeadMs,
        lastSwarmConnections: stale ? null : st.lastSwarmConnections,
      });
    }
    out.push({
      workspaceId,
      harnessSlug,
      logs: rows,
      counts,
      expectedNeverAdmitted: unadmittedRows,
      dhtUniverseMismatch: harnessMismatched,
      ...(mismatch?.detail ? { dhtUniverseDetail: mismatch.detail } : {}),
    });
  }
  return out;
}

/**
 * EI-7788: emit a recovery episode for EVERY active stall alarm a log holds,
 * BEFORE its state is discarded. A dropped log (revoked / re-verify-dropped /
 * handle-closed) is no longer admitted or sampled, so the per-log recovery path
 * in `sampleReplicationLiveness` will NEVER fire for it again — and its durable
 * EI (P-004 / WI-1840) would sit open forever, orphaned. That is the observed
 * pile-up class: a peer stalls (no_replicator → EI filed), then the peer is
 * revoked / disconnects and its log is dropped, stranding the EI open (it then
 * federates to peers as an `origin:remote` EI that never auto-closes).
 *
 * Dropping the log is itself the resolution: the "writes silently diverging"
 * concern no longer applies once we stop admitting/monitoring the peer, so the
 * honest state is resolved. If the log is re-admitted and re-stalls later, the
 * detector re-fires a fresh EI (edge-triggered, per-process latch). Only fires
 * for latched alarms — a healthy log with no open EI is a no-op, so live logs
 * dropped on revoke/close never spuriously resolve anything.
 */
// EI-16949: returns the in-flight recovery-report promises (never rejecting —
// see reportRecovery) instead of firing them fully fire-and-forget. The hot
// per-log drop call sites below don't need to await this (unchanged
// behavior), but the whole-harness `dropReplicationLiveness` — the path a
// process shutdown drives — awaits the combined set so its durable-EI
// auto-resolve writes get a real chance to land before the caller (e.g. a
// gracefully-shutting-down host) exits.
function reportDropRecoveries(
  workspaceId: string,
  harnessSlug: string,
  st: LogState,
  now: number,
): Promise<void>[] {
  const shortKey = `${st.keyHex.slice(0, 12)}…`;
  const droppedDetail = (concern: string): string =>
    `log=${shortKey} dropped from tracking (revoked / re-verify-dropped / handle-closed) — ` +
    `no longer admitted, so the ${concern} concern no longer applies`;
  const promises: Promise<void>[] = [];
  if (st.alarmedNoReplicator) {
    promises.push(
      reportRecovery({
        workspaceId,
        harnessSlug,
        logKeyHex: st.keyHex,
        kind: 'no_replicator',
        stalledForMs: st.lastNonZeroPeersMs !== null ? now - st.lastNonZeroPeersMs : 0,
        detail: droppedDetail('no_replicator'),
      }),
    );
  }
  if (st.alarmedConnectedNever) {
    promises.push(
      reportRecovery({
        workspaceId,
        harnessSlug,
        logKeyHex: st.keyHex,
        kind: 'connected_never_replicated',
        stalledForMs:
          st.connectedNeverReplSinceMs !== null ? now - st.connectedNeverReplSinceMs : 0,
        detail: droppedDetail('connected-but-dead'),
      }),
    );
  }
  if (st.alarmedFrozen) {
    promises.push(
      reportRecovery({
        workspaceId,
        harnessSlug,
        logKeyHex: st.keyHex,
        kind: 'frozen',
        stalledForMs: st.lastIngestProgressMs !== null ? now - st.lastIngestProgressMs : 0,
        detail: droppedDetail('frozen-ingest'),
      }),
    );
  }
  return promises;
}

/** Drop one log's tracking state (revoked / re-verify-dropped / removed from the admitted set).
 *  Returns once any durable-EI auto-resolve write this drop triggered has settled —
 *  existing fire-and-forget callers are unaffected (the promise was void before). */
export async function dropReplicationLogState(
  workspaceId: string,
  harnessSlug: string,
  keyHex: string,
): Promise<void> {
  const logs = registry.get(hKey(workspaceId, harnessSlug));
  const st = logs?.get(keyHex);
  if (!st) return; // already gone (idempotent — boot.ts double-calls on revoke)
  // EI-7788: auto-resolve any durable EI this log's stall filed before we forget it.
  const promises = reportDropRecoveries(workspaceId, harnessSlug, st, Date.now());
  logs!.delete(keyHex);
  await Promise.all(promises);
}

/**
 * Drop a whole harness's tracking state (handle close). AWAITS every
 * triggered durable-EI auto-resolve write (EI-16949): this is the path a
 * graceful process shutdown drives (boot.ts `close()`, and the shutdown-time
 * `dropAllReplicationLivenessTracking` sweep in boot-all.ts for the case where
 * the native substrate close itself is skipped — see host-recycle.ts), and
 * without awaiting here the fire-and-forget PG write used to race the
 * process's own exit — a lost race left the EI orphaned open forever even
 * though `dropReplicationLiveness` had already decided to resolve it. The
 * write itself never rejects (see reportRecovery), so this await can never
 * throw back into a caller.
 */
export async function dropReplicationLiveness(
  workspaceId: string,
  harnessSlug: string,
): Promise<void> {
  const logs = registry.get(hKey(workspaceId, harnessSlug));
  const promises: Promise<void>[] = [];
  if (logs) {
    // EI-7788: auto-resolve any durable EIs the closing harness's stalled logs filed.
    const now = Date.now();
    for (const st of logs.values()) promises.push(...reportDropRecoveries(workspaceId, harnessSlug, st, now));
  }
  registry.delete(hKey(workspaceId, harnessSlug));
  // WI-3684: a closed harness's repair handler closes over its (now torn-down)
  // admitted set — drop it so a later episode can never act on stale state.
  repairHandlers.delete(hKey(workspaceId, harnessSlug));
  await Promise.all(promises);
}

/** Test seam — wipe the registry between tests. */
export function _resetReplicationLivenessForTests(): void {
  registry.clear();
  unadmittedRegistry.clear();
  dhtUniverseState.clear();
  episodeReporter = null;
  episodeRecoveredReporter = null;
  // WI-7011: a stubbed probe MUST NOT leak into the next test — left set, it would
  // silently answer for suites that never opted into it (and a stub returning true
  // would manufacture phantom recoveries).
  openStallEiProbe = null;
  repairHandlers.clear();
}
