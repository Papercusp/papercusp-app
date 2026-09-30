/**
 * cluster-booted-handles-sync.ts — EI-8816: the booted-handles PUSH-sync that closes
 * the true-cluster blind spot.
 *
 * Root cause (per cluster-fork.ts's own doc comment + P3-2's design): in true-cluster
 * mode (`PAPERCUSP_CLUSTER` on, `workers > 1`) the PRIMARY process alone runs the
 * background machinery — `onPrimary()` boots the substrate — and never itself serves
 * HTTP; only the N forked request-only WORKERS (`onWorker()`, `PAPERCUSP_BACKGROUND_WORKERS=0`)
 * serve requests, via `SO_REUSEPORT`. `listBootedHandles()` (boot-all.ts) reads a
 * process-local module-scope `Map`, populated ONLY inside whichever process actually
 * booted the substrate — the primary. So every HTTP request for substrate status lands
 * on a worker whose own local map is (correctly, but misleadingly) always empty:
 * `dev:dogfood_substrate_status` / `GET /admin/dogfood-substrate-health` report
 * `bootedCount:0` and empty `harnesses`/`replicationLiveness` even when the substrate is
 * genuinely booted on the primary (EI-8810/P-059 cost a false "substrate not booted"
 * diagnosis from exactly this).
 *
 * Fix: a PUSH model (not request/reply) — chosen so `getInProcessSubstrateStatus()`
 * stays a pure SYNCHRONOUS function (no async/shape change needed in either of its two
 * callers). The PRIMARY periodically broadcasts its `listBootedHandles()` snapshot to
 * every live worker over `node:cluster` IPC (`ClusterHandle.broadcast`, cluster-fork.ts);
 * each WORKER caches the latest snapshot + its receipt time and reads it back
 * SYNCHRONOUSLY. `in-process-status.ts`'s `resolveEffectiveBootedHandles` then decides,
 * per read, whether to trust the local map directly (this process IS the substrate
 * owner — `nodeCluster.isPrimary`, true for the primary AND for single-process mode) or
 * to fall back to the cached remote snapshot (a genuine forked worker) — and reports an
 * explicit `reachedSubstrateOwner: false` (never a silently-empty `bootedCount: 0`) when
 * neither is available (e.g. the cache hasn't received a first snapshot yet, or has gone
 * stale because the primary is wedged/dead).
 *
 * Mirrors `system-health/cluster-lag-watchdog.ts`'s established worker↔primary IPC
 * convention (a typed message constant, a worker-side emitter, a primary-side listener)
 * rather than inventing a second mechanism.
 */

import { managedSetInterval } from '@papercusp/scheduled-registry';
import { isSubstrateOwnerProcess } from '../../background-workers';
import {
  getBootedHarness,
  listBootedHandles,
  type BootedHandleSummary,
} from './boot-all';
import { collectSubstrateLogStats, type HarnessLogStats } from './log-stats';
import { getOwnLogForkState } from './own-log-fork-guard';
import {
  getReplicationLiveness,
  type HarnessReplicationLiveness,
} from './replication-liveness';
import {
  contentPeerCountForTopic,
  lastContentAnnounceRecvMs,
} from './swarm';

/** One harness whose own log the OWNER has latched as forked (local writes blocked). */
export interface OwnLogForkSummary {
  workspaceId: string;
  harnessSlug: string;
  detail?: string;
}

/**
 * EI-21010563550057801: one booted harness's topic-scoped content-connectivity
 * evidence, sampled inside the substrate-owning process.
 *
 * `contentPeers` is the live announce-channel gauge for THIS topic, never the
 * process-global swarm socket count. `lastContentAnnounceRecvMs` is the latest
 * inbound signed announce on that same topic. Together they distinguish "a
 * handle booted locally" from "this hive can currently exchange content with
 * a remote peer" — the destructive Phase A quarantine requires the latter.
 */
export interface HarnessContentConnectivity {
  workspaceId: string;
  harnessSlug: string;
  /** Exact 32-byte content topic in lowercase hex, or null before swarm join. */
  topicHex: string | null;
  /** Distinct live peers with an open content-announce channel on topicHex. */
  contentPeers: number;
  /** Latest inbound signed announce on topicHex, or null when none was seen. */
  lastContentAnnounceRecvMs: number | null;
}

/**
 * EI-20575137548097507 (second pass): the owner-process health/readiness inputs
 * consumers rely on, as ONE bundle.
 *
 * They travel together on purpose. The first pass published only
 * `replicationLiveness` and flipped a single "health inputs observed" marker on
 * its arrival — but `ownLogFork` and `logStats` stayed process-local, so a
 * non-owner still could not see a forked own log while now ASSERTING it had
 * observed the health inputs. That is the very defect this item exists to close
 * (a partial-coverage marker read as whole-coverage attestation), one level
 * down: `reachedSubstrateOwner` attested only to `booted`, and the first-pass
 * marker attested only to liveness. Bundling makes the marker's claim and its
 * evidence the same set by construction, so the two cannot drift apart again.
 */
export interface SubstrateHealthInputsBundle {
  replicationLiveness: HarnessReplicationLiveness[];
  /** Only FORKED harnesses. Present-and-empty = "measured, none forked". */
  ownLogForks: OwnLogForkSummary[];
  logStats: HarnessLogStats[];
  /**
   * Exact per-harness content-topic reachability sampled by the substrate
   * owner. Present-and-empty means no booted handle had a live swarm topic;
   * absent means an older publisher did not measure this input at all.
   */
  contentConnectivity: HarnessContentConnectivity[];
}

/**
 * Sample per-topic content reachability for every currently booted handle.
 *
 * The booted summary intentionally stays shape-stable; the health bundle is
 * the existing transport for owner-process metrics. A handle disappearing
 * between the summary and lookup is omitted, which is conservative: readers
 * then have no positive connectivity witness and destructive readiness fails.
 */
export function collectHarnessContentConnectivity(): HarnessContentConnectivity[] {
  const out: HarnessContentConnectivity[] = [];
  for (const { workspaceId, harnessSlug } of listBootedHandles()) {
    const handle = getBootedHarness(workspaceId, harnessSlug);
    if (!handle) continue;
    const topicHex = handle.swarm?.topicHex ?? null;
    out.push({
      workspaceId,
      harnessSlug,
      topicHex,
      contentPeers: topicHex ? contentPeerCountForTopic(topicHex) : 0,
      lastContentAnnounceRecvMs: topicHex
        ? lastContentAnnounceRecvMs(topicHex)
        : null,
    });
  }
  return out;
}

/**
 * Read the owner's health/readiness registries as one complete bundle.
 *
 * Shared by BOTH publishing legs (cluster IPC and the PG fallback) so the rule
 * is expressed exactly once. The last time one rule here lived in two places,
 * the halves drifted and produced a confident false zero (EI-18735338283879820)
 * — the send-side gate was correct in one copy and missing in the other.
 *
 * Only forked own-logs are carried: absence in the registry means healthy, so
 * an empty list is the full truth and costs nothing to send.
 */
export function collectSubstrateHealthInputs(): SubstrateHealthInputsBundle {
  const ownLogForks: OwnLogForkSummary[] = [];
  for (const { workspaceId, harnessSlug } of listBootedHandles()) {
    const st = getOwnLogForkState(workspaceId, harnessSlug);
    if (!st.forked) continue;
    ownLogForks.push({
      workspaceId,
      harnessSlug,
      ...(st.detail ? { detail: st.detail } : {}),
    });
  }
  return {
    replicationLiveness: getReplicationLiveness(),
    ownLogForks,
    logStats: collectSubstrateLogStats(),
    contentConnectivity: collectHarnessContentConnectivity(),
  };
}

/** IPC message type the primary broadcasts to every worker each interval. */
export const BOOTED_HANDLES_SNAPSHOT_TYPE = 'papercusp:booted-handles-snapshot' as const;

export interface BootedHandlesSnapshotMessage {
  type: typeof BOOTED_HANDLES_SNAPSHOT_TYPE;
  handles: BootedHandleSummary[];
  sentAt: number;
  /**
   * EI-20575137548097507: the owner's health-input registries, broadcast with
   * the handle list so a worker can ASSESS these harnesses instead of only
   * listing them. Optional so a worker running newer code against an older
   * primary mid-rolling-deploy degrades to health-unobserved (honest) rather
   * than healthy (a lie).
   *
   * Sent as ONE bundle rather than independent sibling fields: a reader must be able
   * to decide "did I observe the health inputs?" with a single test that cannot
   * be true for only part of what it claims — see SubstrateHealthInputsBundle.
   */
  healthInputs?: SubstrateHealthInputsBundle;
  /**
   * EI-18735338283879820: the sender's assertion that it genuinely OWNS the substrate
   * (booted it, holds the handle map) — not merely that it is a cluster primary.
   *
   * An empty `handles` array is only meaningful when it comes from the owner. From a
   * non-owner it means "I never booted anything", which is NOT the same claim and must
   * never be cached as though the substrate were verified-empty. Carrying provenance ON
   * the message means the receiver can reject a poisoned snapshot even if some future
   * call site forgets the send-side gate — the send-side check alone is exactly the kind
   * of single-point rule that already drifted once.
   */
  ownsSubstrate: boolean;
}

/**
 * Accept a health-input bundle only if EVERY member arrived.
 *
 * Shared by both receiving legs (worker IPC cache, PG fallback reader) for the
 * same reason the collector is shared. A partial bundle is rejected outright
 * rather than passed through with holes: the reader turns bundle-presence into
 * "I observed the health inputs", so tolerating a missing member here would
 * re-create the exact over-claim this item exists to remove.
 */
export function isCompleteHealthInputs(
  value: unknown,
): value is SubstrateHealthInputsBundle {
  const b = value as Partial<SubstrateHealthInputsBundle> | null | undefined;
  return (
    !!b &&
    Array.isArray(b.replicationLiveness) &&
    Array.isArray(b.ownLogForks) &&
    Array.isArray(b.logStats) &&
    Array.isArray(b.contentConnectivity)
  );
}

export interface BootedHandlesBroadcasterHandle {
  stop(): void;
}

/**
 * PRIMARY side: periodically broadcast `listBootedHandles()` to every live worker via
 * the caller-supplied `broadcast` (wire to `ClusterHandle.broadcast` from cluster-fork.ts).
 * Broadcasts immediately on start (so a freshly-forked worker's cache isn't empty for a
 * full interval) then every `intervalMs`. The timer is registered under
 * `managedSetInterval` (category 'watchdog') so it is visible in `schedule:inventory`,
 * matching the sibling cluster-lag-watchdog convention.
 */
export function startBootedHandlesBroadcaster(opts: {
  broadcast: (message: BootedHandlesSnapshotMessage) => void;
  intervalMs?: number;
  now?: () => number;
  /** Test seam / explicit override for "does this process own the substrate?". */
  ownsSubstrate?: boolean;
}): BootedHandlesBroadcasterHandle {
  const intervalMs = opts.intervalMs ?? 5_000;
  const now = opts.now ?? (() => Date.now());
  const beat = (): void => {
    // EI-18735338283879820: a process that does not OWN the substrate must never
    // broadcast. Its `listBootedHandles()` is unconditionally `[]` (it never booted
    // anything), and a punctual empty snapshot is indistinguishable to the receiver from
    // the real owner reporting a verified-empty substrate — so broadcasting it
    // MANUFACTURES a confident false zero rather than leaving an honest blind spot.
    //
    // Evaluated per-beat, not once at start, so a process whose role is established
    // after wiring still settles on the correct answer.
    //
    // With no broadcast the worker cache stays null and resolveEffectiveBootedHandles
    // falls through to `reachedSubstrateOwner: false` — an explicit "could not reach the
    // owner", which is the honest and strictly more useful answer.
    if (!(opts.ownsSubstrate ?? isSubstrateOwnerProcess())) return;
    try {
      opts.broadcast({
        type: BOOTED_HANDLES_SNAPSHOT_TYPE,
        handles: listBootedHandles(),
        // EI-20575137548097507: broadcast the means to ASSESS these handles,
        // not just the handles.
        healthInputs: collectSubstrateHealthInputs(),
        sentAt: now(),
        ownsSubstrate: true,
      });
    } catch {
      /* best-effort — a dead/draining worker channel never throws past broadcast() anyway */
    }
  };
  beat();
  const timer = managedSetInterval('booted-handles-broadcast', intervalMs, beat, {
    category: 'watchdog',
  });
  return {
    stop() {
      timer.stop();
    },
  };
}

export interface RemoteBootedHandlesSnapshot {
  handles: BootedHandleSummary[];
  receivedAt: number;
  /**
   * EI-20575137548097507: the owner's health-input registries, carried with the
   * handle list so a non-owner reader can ASSESS these harnesses rather than
   * merely enumerate them.
   *
   * `undefined` means the snapshot's producer did not supply them (an older
   * publisher, or a leg that does not carry them yet) — which the reader MUST
   * render as health-unobserved, never as healthy. That conflation is the
   * defect this field closes. A PARTIAL bundle is impossible by construction,
   * which is the point: the marker derived from this field would otherwise be
   * able to claim more coverage than it has.
   */
  healthInputs?: SubstrateHealthInputsBundle;
}

/** Process-local cache of the latest snapshot received from the primary. Only ever
 *  populated in a genuine forked WORKER process (the primary never broadcasts to
 *  itself); stays `null` for the lifetime of a primary / single-process host. */
let cachedRemote: RemoteBootedHandlesSnapshot | null = null;

/**
 * WORKER side: listen for the primary's booted-handles broadcast and cache the latest
 * snapshot + receipt time. Registers a `process.on('message', ...)` listener by default
 * (injectable `on`/`off` for tests — synthetically emitting on the REAL `process` object
 * risks colliding with the test runner's own worker IPC, which uses the same event) — a
 * no-op safe to call in any process (a primary/single-process host simply never receives
 * this message type, so the cache stays `null` there, which `resolveEffectiveBootedHandles`
 * never consults for the owner process anyway).
 */
export function startWorkerBootedHandlesCache(
  opts: {
    now?: () => number;
    on?: (event: 'message', cb: (message: unknown) => void) => void;
    off?: (event: 'message', cb: (message: unknown) => void) => void;
  } = {},
): { stop(): void } {
  const now = opts.now ?? (() => Date.now());
  const on = opts.on ?? ((event: 'message', cb: (message: unknown) => void) => process.on(event, cb));
  const off = opts.off ?? ((event: 'message', cb: (message: unknown) => void) => process.off(event, cb));
  const listener = (message: unknown): void => {
    const m = message as Partial<BootedHandlesSnapshotMessage> | null | undefined;
    if (m?.type !== BOOTED_HANDLES_SNAPSHOT_TYPE || !Array.isArray(m.handles)) return;
    // EI-18735338283879820: only a snapshot the sender AFFIRMATIVELY claims ownership for
    // may populate the cache. `ownsSubstrate !== true` also (deliberately) rejects a
    // legacy snapshot from an older process that predates the field: unknown provenance
    // is treated as untrusted, so a rolling deploy degrades to an honest
    // `reachedSubstrateOwner:false` blind spot rather than a confident false zero.
    if (m.ownsSubstrate !== true) return;
    cachedRemote = {
      handles: m.handles as BootedHandleSummary[],
      receivedAt: now(),
      // EI-20575137548097507: carried through only when the primary actually
      // sent it. An older primary omits it, and the reader must then report
      // health as UNOBSERVED — same conservative stance as the `ownsSubstrate`
      // provenance check above: unknown is treated as untrusted, never as green.
      // Every member must be present: a half-populated bundle would let the
      // observability marker over-claim, which is the defect itself.
      ...(isCompleteHealthInputs(m.healthInputs)
        ? { healthInputs: m.healthInputs }
        : {}),
    };
  };
  on('message', listener);
  return {
    stop() {
      off('message', listener);
    },
  };
}

/** Read the latest cached remote snapshot (or `null` if none has ever arrived). Pure
 *  sync read — this is the seam `in-process-status.ts` wires as `resolveRemoteBootedHandles`. */
export function getCachedRemoteBootedHandles(): RemoteBootedHandlesSnapshot | null {
  return cachedRemote;
}

/** Test seam only — set/clear the module-scope cache directly without a real `process.on('message')` round-trip. */
export function _setCachedRemoteBootedHandlesForTests(snapshot: RemoteBootedHandlesSnapshot | null): void {
  cachedRemote = snapshot;
}
