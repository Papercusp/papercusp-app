/**
 * in-process-status — non-HTTP composer for substrate status.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24.
 *
 * Mirrors the shape of GET /api/admin/dogfood-substrate-status +
 * /dogfood-substrate-health for callers that already live inside the
 * operator process. Useful for:
 *
 *   - Long-running daemons that want substrate health without going
 *     back through the HTTP loopback.
 *   - Test harnesses that fake the in-process trackers and want the
 *     same shape the JSON endpoint returns.
 *   - CLIs / scripts launched in the same Node process (rare; the
 *     HTTP path is preferred for spawnable scripts).
 *
 * Pure logic — composes listBootedHandles + listBootstrapProgress +
 * assessHarnessSubstrateHealth + summariseWorkspaceSubstrate. No PG,
 * no FS, no fetch. Tests can swap the underlying trackers via the
 * existing `_setHandleForTests` / `_setNowForTests` seams.
 */

import { isSubstrateOwnerProcess } from '../../background-workers';
import { listBootedHandles, type BootedHandleSummary } from './boot-all';
import {
  collectHarnessContentConnectivity,
  isCompleteHealthInputs,
  type HarnessContentConnectivity,
  type RemoteBootedHandlesSnapshot,
} from './cluster-booted-handles-sync';
import { listBootstrapProgress } from './bootstrap-progress';
import {
  assessHarnessSubstrateHealth,
  type SubstrateHealthVerdict,
} from './health';
import {
  summariseWorkspaceSubstrate,
  type WorkspaceSubstrateSummary,
} from './summary';
import { collectSubstrateLogStats, type HarnessLogStats } from './log-stats';
import {
  getReplicationLiveness,
  type HarnessReplicationLiveness,
} from './replication-liveness';
import { getOwnLogForkState, type OwnLogForkState } from './own-log-fork-guard';

export interface InProcessHarnessHealth {
  workspaceId: string;
  harnessSlug: string;
  verdict: SubstrateHealthVerdict;
  reasons: string[];
  /**
   * EI-1618: substrate-outbox DRAIN stats for this harness. `undrainedCount` =
   * rows with `drained_at IS NULL`; `oldestUndrainedAgeMs` = age of the oldest
   * (null when none / not measured). A non-trivial stalled value is the
   * silent-stall (EI-681) signal that boot-health alone hides.
   */
  drain: { undrainedCount: number; oldestUndrainedAgeMs: number | null };
  /**
   * P-003 (own-log-fork-guard, WI-3535): does this harness's own writable log
   * currently sit in the (non-self-healing) fork/equivocation-loop state?
   * Also feeds the health verdict (`forked:true` ⇒ 'unhealthy').
   */
  ownLogFork: OwnLogForkState;
}

export interface InProcessSubstrateStatus {
  /**
   * Whether the substrate is active. At runtime this is ALWAYS `true` — the
   * Model B substrate always boots (the PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE
   * opt-in gate was removed in Stage 4d). This is NOT a feature gate; it is
   * `false` ONLY when a test forces the disabled-rendering path via
   * `forceDisabledForTest`. Treat it as "substrate active", not "flag on".
   */
  substrateActive: boolean;
  bootedCount: number;
  summary: WorkspaceSubstrateSummary;
  harnesses: InProcessHarnessHealth[];
  /**
   * EI-8816: was this read able to reach the substrate-owning process's actual boot
   * state? `true` when this process IS the owner (the primary, or single-process mode)
   * OR a genuine cluster worker had a fresh cached broadcast from the primary. `false`
   * means the read is a BLIND SPOT, not a true "nothing booted" — a worker with no (or
   * a stale) cached snapshot. Distinguishes the EI-8816 blind spot from the legitimate
   * idle-ground-state `bootedCount: 0`; callers should surface this explicitly rather
   * than let a `false` render identically to a genuinely-empty substrate.
   */
  reachedSubstrateOwner: boolean;
  /**
   * Per-harness log-growth + new-joiner replay-cost (substrate-peer-log-compaction
   * P-001/P-002). Surfaces the unbounded-growth signal P-009 flagged: `replayCostOps`
   * is what a fresh joiner folds; a future compaction must shrink it. Empty when no
   * harness is booted.
   */
  logStats: HarnessLogStats[];
  /**
   * P-004 (WI-1840, WI-183 class): per-harness replication-liveness snapshot —
   * per admitted remote log, is replication actually ALIVE (replicator attached
   * + ingest progressing), or connected-but-dead (`no_replicator` / `frozen`)?
   * Also feeds each harness's health verdict (any stalled log ⇒ 'unhealthy').
   * Empty when nothing is tracked (no remote logs sampled yet). NB: registry is
   * process-local — under SUBSTRATE_SIDECAR mode the authoritative copy lives in
   * the sidecar (read it via the `getReplicationLiveness` RPC method there).
   */
  replicationLiveness: HarnessReplicationLiveness[];
  /**
   * EI-21010563550057801: per-booted-harness content-topic reachability,
   * measured in the substrate owner and carried through the same complete
   * cross-process health snapshot as replication/fork/log inputs. Empty with
   * `healthInputsObserved:false` means unmeasured, never "zero peers".
   */
  contentConnectivity: HarnessContentConnectivity[];
  /**
   * EI-20575137548097507: did THIS process actually measure the process-local
   * health/readiness inputs (`replicationLiveness`, `logStats`, own-log-fork,
   * and `contentConnectivity`) for the harnesses reported above?
   *
   * `reachedSubstrateOwner` does NOT answer this and must not be read as if it
   * did: it is `true` on the owner path AND on the cached-snapshot path (see
   * `resolveEffectiveBootedHandles`), because it attests only that the BOOTED
   * HANDLE LIST was obtained — never that anything here could be assessed.
   * Conflating the two is what let a worker report "97/97 healthy, no issues
   * detected" while the replication-liveness detector was concurrently filing a
   * major stall EI for one of those very harnesses.
   *
   * `false` ⇒ `replicationLiveness` and `logStats` below are empty because they
   * were UNMEASURABLE here, not because there was nothing to report, and every
   * per-harness verdict carries a matching 'degraded' + reason.
   */
  healthInputsObserved: boolean;
}

export interface GetInProcessStatusOpts {
  /**
   * TEST SEAM ONLY — not a real gate. The Model B substrate always boots
   * (the PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE opt-in gate was removed in
   * Stage 4d), so production NEVER sets this. Tests pass `true` to exercise
   * the disabled-rendering path (`substrateActive: false`).
   */
  forceDisabledForTest?: boolean;
  /**
   * Per-harness claim stats fetcher — defaulted to a zero-stats
   * shape because the in-process path doesn't have PG and we don't
   * want to drag a PG dep in here. Production callers can pass a
   * resolver that hits `loadClaimAttemptStats`.
   */
  resolveClaimStats?: (
    workspaceId: string,
    harnessSlug: string,
  ) => { total: number; won: number; lost: number; error: number };
  /**
   * EI-1618 — per-harness substrate-outbox drain stats fetcher. Defaulted to
   * zero because this module is pure (no PG). Production callers (e.g. the
   * federation-status route) pass a resolver that queries `substrate_outbox`:
   *   undrainedCount = COUNT(*) WHERE drained_at IS NULL (for the scope),
   *   oldestUndrainedAgeMs = now - MIN(ts) of those rows (null if none). NB the
   *   capture-time column is `ts` (epoch-ms bigint), NOT `captured_ts`/`created_ts`
   *   (verified vs 000-baseline.sql; see load-drain-stats.ts).
   * This is what flips a stuck (captured-but-not-federating) harness off "healthy".
   */
  resolveDrainStats?: (
    workspaceId: string,
    harnessSlug: string,
  ) => { undrainedCount: number; oldestUndrainedAgeMs: number | null };
  /**
   * WI-899 (A): resolve SUBSTRATE_SIDECAR process liveness — `true`/`false` when
   * measured (sidecar mode is on), `null`/`undefined` when not applicable (sidecar
   * mode off, or the caller hasn't wired a resolver). Defaulted to a no-op (`null`)
   * because this module is pure (no IPC); production callers (e.g. the
   * dogfood-substrate-status/-health routes) pass a resolver backed by
   * `probeSubstrateSidecar` (service-health.ts) — see the route wiring for the
   * "handlePresent hardcoded true even for a dead sidecar" bug this closes.
   */
  resolveSidecarLive?: () => boolean | null;
  /**
   * WI-5777 — resolve the age (ms) since the EI-8892 isolated-DHT-bootstrap
   * liveness probe last succeeded, or `null` when not applicable (this
   * process isn't on the isolated DHT, or the probe state is unreadable).
   * Defaulted to a no-op (`null`) because this module is pure (no FS);
   * production callers (the federation-status route) pass a resolver that
   * reads `~/.papercusp/dht-liveness/last-ok`, gated on `PAPERCUSP_DHT_BOOTSTRAP`
   * being set. Resolved ONCE per call (process-wide — the isolated bootstrap
   * is a single shared resource, not per-harness, same as `resolveSidecarLive`)
   * and joined onto every booted harness's verdict below — see health.ts's
   * doc comment for WHY this matters (the `never_connected` gap it closes).
   */
  resolveDhtBootstrapProbeStaleMs?: () => number | null;
  /**
   * EI-8816 — resolve the primary's latest CACHED booted-handles broadcast (see
   * `cluster-booted-handles-sync.ts`'s `getCachedRemoteBootedHandles`). Only consulted
   * when this process is NOT the substrate owner (a genuine forked cluster worker);
   * defaulted to a no-op (`undefined` ⇒ always `null`) because this module is pure (no
   * IPC). Production callers (dogfood-substrate-status/-health) pass the real cache reader.
   */
  resolveRemoteBootedHandles?: () => RemoteBootedHandlesSnapshot | null;
  /**
   * TEST SEAM ONLY — overrides the real "is this process the substrate owner" check
   * (`nodeCluster.isPrimary && !requestOnlyHost()`: true for the primary AND for
   * single-process/non-clustered hosts, EXCLUDING a request-only secondary that never
   * boots the substrate at all; false inside a genuine forked cluster worker OR a
   * request-only host — see WI-5307). Production never sets this.
   */
  isSubstrateOwnerProcessForTest?: boolean;
}

const ZERO_STATS = { total: 0, won: 0, lost: 0, error: 0 } as const;
const ZERO_DRAIN = { undrainedCount: 0, oldestUndrainedAgeMs: null } as const;
/** How stale a cached remote broadcast may be before a worker stops trusting it (3x the
 *  broadcaster's default 5s interval — generous for one missed beat, not so generous that
 *  a wedged/dead primary keeps rendering as "reached" for minutes). */
const DEFAULT_REMOTE_BOOTED_HANDLES_MAX_AGE_MS = 15_000;

/**
 * EI-8816 (+ WI-5307): decide which booted-handles list this read should trust, and
 * whether the read actually reached the substrate-owning process's real state.
 *
 *   - This process IS the owner (primary, or single-process mode — `nodeCluster.isPrimary`
 *     AND NOT a declared request-only secondary, see `isSubstrateOwnerProcess` below)
 *     ⇒ trust `local` directly; it's a direct read of the same process-local map the
 *     substrate boot itself populated. Always `reachedSubstrateOwner: true`, INCLUDING a
 *     legitimate zero-booted idle state (nothing has booted yet) — that is real data, not
 *     a blind spot.
 *   - This process is a genuine forked WORKER (never boots anything itself, so `local` is
 *     always `[]`), OR a REQUEST-ONLY secondary host under the dedicated-bg-host topology
 *     (`PAPERCUSP_BACKGROUND_WORKERS=0` / the :3170 staging port — host-bootstrap.ts skips
 *     the hyperbee substrate boot entirely there, so `local` is ALWAYS `[]` too) ⇒ fall
 *     back to the cached broadcast from the primary, if one exists and is fresh
 *     (`now - receivedAt <= maxAgeMs`). Stale/missing ⇒ `reachedSubstrateOwner: false` with
 *     an empty list — an explicit blind-spot marker, never silently identical to "nothing
 *     booted".
 *
 * WI-5307: `nodeCluster.isPrimary` alone answers "am I a node:cluster-forked worker", not
 * "did I boot the substrate" — the two used to coincide (EI-8816's true-cluster topology:
 * only the primary boots, workers are non-primary) but no longer do under the dedicated
 * `papercup-bg-host` topology: :3070/:3270 are each their OWN unforked `node:cluster`
 * primary (never a worker) yet are declared request-only and never boot the substrate —
 * bg-host does. Blindly trusting `local` there rendered a false-confident
 * `reachedSubstrateOwner:true, bootedCount:0` (looks like a verified-empty substrate) on
 * a process that never had the chance to boot anything, even while the real bg-host owner
 * had the harness live (corestore fd open, outbox draining). See `isSubstrateOwnerProcess`
 * below + `requestOnlyHost()` (background-workers.ts) for the fix.
 *
 * Pure + exported for direct unit testing without mocking `node:cluster`.
 */
export function resolveEffectiveBootedHandles(
  local: BootedHandleSummary[],
  opts: {
    isSubstrateOwnerProcess: boolean;
    resolveRemote?: () => RemoteBootedHandlesSnapshot | null;
    now?: number;
    maxAgeMs?: number;
  },
): { booted: BootedHandleSummary[]; reachedSubstrateOwner: boolean } {
  if (opts.isSubstrateOwnerProcess) {
    return { booted: local, reachedSubstrateOwner: true };
  }
  const remote = opts.resolveRemote?.() ?? null;
  const now = opts.now ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_REMOTE_BOOTED_HANDLES_MAX_AGE_MS;
  if (remote && now - remote.receivedAt <= maxAgeMs) {
    return { booted: remote.handles, reachedSubstrateOwner: true };
  }
  return { booted: [], reachedSubstrateOwner: false };
}

export function getInProcessSubstrateStatus(
  opts: GetInProcessStatusOpts = {},
): InProcessSubstrateStatus {
  // Stage 4d: the substrate always boots; `substrateActive` is constant true
  // at runtime. `forceDisabledForTest` is a TEST-ONLY seam for exercising the
  // disabled-rendering path — production never passes it.
  const substrateActive = !opts.forceDisabledForTest;
  // WI-5307: a node:cluster primary that has DECLARED itself request-only (the
  // dedicated-bg-host topology's :3070/:3270 hosts) never boots the substrate — see the
  // resolveEffectiveBootedHandles doc comment above.
  // EI-18735338283879820: use the SHARED predicate (background-workers.ts) rather than an
  // inline copy. The inline copy here was correct, but its twin on the broadcast side was
  // missing entirely — one rule expressed in two places is what let the halves drift into
  // a confident false zero. Both sides now read the same function.
  const isSubstrateOwner =
    opts.isSubstrateOwnerProcessForTest ?? isSubstrateOwnerProcess();
  // EI-20575137548097507: resolve the remote snapshot EXACTLY ONCE and hand the
  // same object to `resolveEffectiveBootedHandles`, so the handle list and the
  // health inputs below provably come from ONE snapshot. Calling the resolver a
  // second time would risk `booted` and the liveness describing different
  // moments — the same class of quiet incoherence this fix exists to remove.
  const remoteSnapshot = isSubstrateOwner
    ? null
    : (opts.resolveRemoteBootedHandles?.() ?? null);
  const { booted, reachedSubstrateOwner } = resolveEffectiveBootedHandles(listBootedHandles(), {
    isSubstrateOwnerProcess: isSubstrateOwner,
    resolveRemote: () => remoteSnapshot,
  });
  const progress = listBootstrapProgress();
  const progressByKey = new Map<
    string,
    ReturnType<typeof listBootstrapProgress>[number]
  >();
  for (const p of progress) {
    progressByKey.set(`${p.workspaceId}::${p.harnessSlug}`, p);
  }
  const resolveStats = opts.resolveClaimStats ?? (() => ZERO_STATS);
  const resolveDrain = opts.resolveDrainStats ?? (() => ZERO_DRAIN);
  const resolveSidecarLive = opts.resolveSidecarLive ?? (() => null);
  const resolveDhtBootstrapProbeStaleMs = opts.resolveDhtBootstrapProbeStaleMs ?? (() => null);
  // WI-899 (A): resolved ONCE per call (process-wide, not per-harness — see the
  // opt's doc comment) rather than re-probing per booted harness.
  const sidecarLive = resolveSidecarLive();
  const dhtBootstrapProbeStaleMs = resolveDhtBootstrapProbeStaleMs();
  // P-004 (WI-1840): read-time replication-liveness snapshot, resolved once and
  // joined per-harness below (feeds the health verdict + the status payload).
  // EI-20575137548097507: the OWNER reads its own registry; a non-owner uses
  // the liveness the owner published alongside the handle list it is already
  // trusting for `booted`. Reading the local registry on a non-owner is what
  // produced the false green: those maps are empty by construction there, so
  // the per-harness join missed for every harness and each health input reached
  // the assessor as `undefined` — "not measured" rendered as "nothing wrong".
  // Only a snapshot that was actually USED may supply health inputs. On the
  // non-owner path `reachedSubstrateOwner` is true exactly when the freshness
  // check above accepted `remoteSnapshot`, so this reuses that one verdict
  // rather than re-deriving (and possibly disagreeing with) it: a snapshot too
  // stale to be trusted for `booted` is equally untrustworthy for health.
  // The completeness test is applied HERE, at the point the attestation is
  // made — not only at the two receiving legs that populate the caches. A leg
  // filters what it stores; this decides what we CLAIM. Enforcing it only on
  // the way in would leave the marker able to over-claim for any snapshot that
  // arrives by some other route (a third leg, a direct caller, a future
  // transport) — the same "one rule expressed in two places" drift that
  // produced EI-18735338283879820's confident false zero.
  const remoteHealthInputs =
    !isSubstrateOwner && reachedSubstrateOwner && isCompleteHealthInputs(remoteSnapshot?.healthInputs)
      ? remoteSnapshot.healthInputs
      : undefined;
  // Observable iff we measured it ourselves, or the snapshot's producer supplied
  // the WHOLE bundle. An older publisher omits it entirely — that is UNOBSERVED,
  // and must never be read as an empty-because-nothing-is-wrong registry.
  //
  // ⚠ This marker's coverage must equal the set of inputs it gates, or it is the
  // very defect it was added to fix. The first pass derived it from the presence
  // of `replicationLiveness` ALONE while `ownLogFork` and `logStats` were still
  // read from this process's (empty-by-construction) module state — so a forked
  // own log on the owner stayed invisible while the marker asserted the health
  // inputs had been observed. Exactly the shape of `reachedSubstrateOwner`,
  // which attested only to `booted` and read as a whole-payload trust marker.
  // The inputs now travel as ONE bundle so the claim and its evidence cannot
  // drift apart again; keep any future health input INSIDE that bundle.
  const healthInputsObserved = isSubstrateOwner || remoteHealthInputs !== undefined;
  const replicationLiveness = isSubstrateOwner
    ? getReplicationLiveness()
    : (remoteHealthInputs?.replicationLiveness ?? []);
  const contentConnectivity = isSubstrateOwner
    ? collectHarnessContentConnectivity()
    : (remoteHealthInputs?.contentConnectivity ?? []);
  // Non-owner: the owner publishes only FORKED harnesses, so a miss here means
  // "measured, not forked" — but ONLY because the bundle's presence is what
  // licenses that reading. Absent bundle ⇒ the map is empty AND
  // `healthInputsObserved` is false, so the verdict degrades rather than
  // silently reporting every own log as intact.
  const remoteForkByKey = new Map<string, { detail?: string }>();
  for (const f of remoteHealthInputs?.ownLogForks ?? []) {
    remoteForkByKey.set(`${f.workspaceId}::${f.harnessSlug}`, f);
  }
  const livenessByKey = new Map<string, HarnessReplicationLiveness>();
  for (const l of replicationLiveness) {
    livenessByKey.set(`${l.workspaceId}::${l.harnessSlug}`, l);
  }

  const harnesses: InProcessHarnessHealth[] = booted.map((h) => {
    const stats = resolveStats(h.workspaceId, h.harnessSlug);
    const drain = resolveDrain(h.workspaceId, h.harnessSlug);
    const bp = progressByKey.get(`${h.workspaceId}::${h.harnessSlug}`);
    // EI-20575137548097507: same owner/non-owner split as the liveness above —
    // reading the local registry on a non-owner always answers "not forked",
    // which is indistinguishable from never having looked.
    const ownLogFork = isSubstrateOwner
      ? getOwnLogForkState(h.workspaceId, h.harnessSlug)
      : ((): OwnLogForkState => {
          const f = remoteForkByKey.get(`${h.workspaceId}::${h.harnessSlug}`);
          return f
            ? { forked: true, keyHex: null, detectedAtMs: null, detail: f.detail ?? null }
            : { forked: false, keyHex: null, detectedAtMs: null, detail: null };
        })();
    const { verdict, reasons } = assessHarnessSubstrateHealth({
      // health.ts's `flagEnabled` is its real "is the substrate active" input
      // (drives the 'disabled' verdict); feed it `substrateActive`.
      flagEnabled: substrateActive,
      // WI-899 (A): this is a KNOWN LIE when the sidecar is dead — `listBootedHandles()`
      // still returns the boot-time proxy regardless. `sidecarLive: false` below is what
      // actually catches that case (forces `unhealthy` overriding this `true`).
      handlePresent: true,
      claimStats: stats,
      bootstrapProgress: bp ?? null,
      // EI-1618: a stalled outbox flips the verdict off 'healthy'.
      drainStats: drain,
      // P-004 (WI-1840): connected-but-dead replication flips to 'unhealthy'.
      replicationLiveness: (() => {
        const l = livenessByKey.get(`${h.workspaceId}::${h.harnessSlug}`);
        return l
          ? {
              noReplicator: l.counts.noReplicator,
              frozen: l.counts.frozen,
              samplingStale: l.counts.samplingStale,
              // WI-3604: split-DHT-universe recurrence guard.
              dhtUniverseMismatch: l.counts.dhtUniverseMismatch,
            }
          : undefined;
      })(),
      // P-003 (WI-3535): a forked own-log flips to 'unhealthy' — local writes blocked.
      ownLogFork: ownLogFork.forked ? { forked: true, detail: ownLogFork.detail ?? undefined } : undefined,
      // EI-20575137548097507: `replicationLiveness`, `ownLogFork` and the log
      // stats above are all read from THIS process's module-scope state, while
      // `booted` may have come from a node:cluster IPC snapshot or the PG
      // fallback. When we are not the substrate owner those local maps are
      // empty BY CONSTRUCTION, so the joins above miss for every harness and
      // each input arrives at the assessor as `undefined` — indistinguishable
      // from "measured, nothing to report". Say which it is.
      healthInputsObservable: healthInputsObserved,
      // WI-899 (A): a confirmed-dead sidecar overrides everything above.
      sidecarLive,
      // WI-5777: a stale isolated-DHT liveness probe degrades this harness's
      // verdict — closes the 'never_connected'-never-alarms observability gap.
      dhtBootstrapProbeStaleMs,
    });
    return {
      workspaceId: h.workspaceId,
      harnessSlug: h.harnessSlug,
      verdict,
      reasons,
      drain,
      ownLogFork,
    };
  });

  const baseSummary = summariseWorkspaceSubstrate(substrateActive, harnesses);
  // EI-22627350228756486: an unowned/non-owner read can have zero rows while
  // the substrate owner and health inputs are both unreachable. The generic
  // summary quite correctly treats zero rows as idle when the owner was
  // reached, but that same shape is a blind spot when neither attestation is
  // present. Preserve the empty row set (never fabricate a harness) while
  // downgrading the aggregate verdict so absence of measurement cannot read as
  // healthy.
  const summary: WorkspaceSubstrateSummary =
    (!reachedSubstrateOwner || !healthInputsObserved) && baseSummary.worstVerdict === 'healthy'
      ? { ...baseSummary, worstVerdict: 'degraded' }
      : baseSummary;

  return {
    substrateActive,
    bootedCount: booted.length,
    summary,
    harnesses,
    // P-001/P-002: read-only per-harness log-growth + replay-cost snapshot.
    // EI-20575137548097507: on a non-owner this collector walks the LOCAL
    // booted-handle map, which is empty by construction — it would render an
    // unmeasured `[]` beside a `bootedCount` of 97. Use what the owner
    // published instead; when nothing was published this stays empty AND
    // `healthInputsObserved` is false, which is what says so.
    logStats: isSubstrateOwner
      ? collectSubstrateLogStats()
      : (remoteHealthInputs?.logStats ?? []),
    // P-004 (WI-1840): per-log replication-liveness verdicts.
    replicationLiveness,
    // EI-21010563550057801: exact per-topic remote-content evidence. The
    // healthInputsObserved marker distinguishes measured-empty from absent.
    contentConnectivity,
    // EI-8816: explicit blind-spot marker — see resolveEffectiveBootedHandles above.
    reachedSubstrateOwner,
    // EI-20575137548097507: the SECOND blind-spot marker, and deliberately NOT
    // derived from `reachedSubstrateOwner` — that one goes true on the cached
    // path too, which is precisely how an unmeasured worker read as healthy.
    healthInputsObserved,
  };
}
