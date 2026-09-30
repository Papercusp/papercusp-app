/**
 * orphaned-dispatch.ts — the orphaned-dispatch watchdog collector
 * (self-improvement-consume-edges-2026-06-12 P-011 / B-05, with B-04's ledger
 * the other half of EI-365's fix).
 *
 * The auto-implement lane dispatched for two days without a single resolve and
 * nothing noticed: a worker that dies silently (SIGTERM, crash, never spawned)
 * never calls `improvements:resolve`, and before the dispatch ledger (migration
 * 238) there was no record to notice it BY. This collector closes that edge —
 * the watchdog finally watches the implement lane itself:
 *
 *   1. An OPEN ledger row (outcome NULL) older than the threshold T means the
 *      worker is presumed dead. The collector drives it terminal
 *      (`markDispatchOrphaned` — the ledger's designated P-011 write) so a dead
 *      worker is permanently distinguishable from one in progress.
 *   2. Each affected ITEM files one `orphaned-dispatch` signal through the
 *      normal capture path (search-first dedup, known-open pre-filter,
 *      per-tick caps) — so repeated worker death generates queue pressure
 *      instead of silence.
 *
 * T defaults to 2h via `dispatchOverdueAfterMs()` (dispatch-ledger.ts, env
 * `PAPERCUSP_IMPROVEMENT_DISPATCH_OVERDUE_MS`) — ONE tunable shared with the
 * ledger's `overdue` read bucket, aligned with plan-implement's stale-claim
 * window and comfortably above the 45-min worker timeout. Already-orphaned rows
 * keep signaling for an evidence window so a signal deferred by the per-tick
 * cap re-fires next tick instead of dying with the row's terminal transition.
 *
 * Pure core (`scanOrphanedDispatches` + `buildOrphanedDispatchSignals`) + thin
 * PG glue (`collectOrphanedDispatchSignals`), mirroring insight-staleness.ts.
 * The glue skips with a note (not an error) while migration 238 is not yet
 * applied — a deploy-ordering gap must not self-escalate the watchdog.
 */

import type { WatchdogSignal } from './watchdog';
import type { CollectorResult } from './watchdog';
import {
  dispatchOverdueAfterMs,
  markDispatchOrphaned,
  readRecentDispatches,
  type DispatchOutcome,
  type ImprovementDispatchRow,
} from './dispatch-ledger';
import {
  releaseIssue,
  mergeIssuePayload,
  findIssuesByWatchdogKeys,
  commentIssue,
  setIssueState,
  markLeaderTriage,
  type EngineerIssue,
} from '../../issues-engineer';

/**
 * This process's boot time (ms). `process.uptime()` is import-timing-independent
 * (unlike a module-load `Date.now()`), so a dispatch row fired BEFORE this is from
 * a PREVIOUS process — its worker (a child of the dead host) cannot still be alive
 * (EI-403 Option B host-restart recovery). Single-host assumption for the implement
 * lane: the routine + its loopback-fired workers run on one host (the routine holds
 * a cross-host lock), so a row predating boot is a restart victim, not another live
 * host's in-flight worker.
 */
export function processBootMs(): number {
  return Date.now() - Math.floor(process.uptime() * 1000);
}

/**
 * How long an already-orphaned row keeps backing a signal (re-fire window). The
 * capture can be deferred by the watchdog's per-tick caps — the evidence must
 * outlive the deferral, not vanish the tick after the row goes terminal.
 */
export const ORPHAN_EVIDENCE_WINDOW_MS = 48 * 60 * 60 * 1000;

/** Cap signals per sweep (the watchdog has its own per-tick cap on top). */
export const ORPHAN_MAX_SIGNALS = 5;

/**
 * EI-7348: when orphaned dispatches affect many distinct items at once, the
 * actionable object is the spawn/dispatch storm, not N per-item EIs. Keep the
 * threshold above small coincidences so one or two broken items still surface
 * with their item-specific key.
 */
export const ORPHAN_STORM_MIN_ITEMS = 4;

/** Ledger rows the glue reads per sweep (newest-first; ~10 days at the lane's cadence). */
export const ORPHAN_SCAN_READ_LIMIT = 500;

/**
 * EI-1689 — host-restart re-dispatch circuit-breaker. EI-403 Option B rolls a
 * host-restart victim back + re-dispatches it every sweep; with NO cap, a single
 * item thrashes indefinitely while the host is unstable (EI-1405 was re-dispatched
 * 8× — every attempt orphaned by the next restart — and NEVER reached a terminal
 * outcome, burning a dispatch slot the whole time). After this many host-restart
 * recoveries inside {@link ORPHAN_THRASH_WINDOW_MS}, the breaker trips: instead of
 * re-dispatching, route the item to a human (`payload.needsHuman`, the same flag
 * resolve-core sets for attempts-exhausted items — policy.ts honors it and drops
 * the item from the auto-eligible pool). The source (bg-host recycle storm) is
 * addressed separately (EI-1613/EI-1607); this is the residual backstop so a doomed
 * item can't loop forever once the source regresses.
 */
export const HOST_RESTART_REDISPATCH_CAP = 3;
/** Window over which host-restart recoveries are counted toward the cap. */
export const ORPHAN_THRASH_WINDOW_MS = 6 * 60 * 60 * 1000; // 6h — spans a typical instability burst

/**
 * Env-outage detection (D-004 @ relight-self-learning-edges-2026-06-14): when the
 * fleet's shared credential pool is exhausted (rate-limit / weekly-limit / auth),
 * EVERY dispatch dies — and the ones the back-edge couldn't tag (durable fire lost,
 * or the worker killed before it reported) surface as CAUSE-UNKNOWN 2h-collector
 * orphans. Those are outage casualties, not lane breakage, yet they pass
 * isLaneBreakageOrphan (no env marker on the row) → a false "lane broken" EI →
 * which is itself auto-implement-eligible → DOA on the SAME outage → another orphan
 * EI: the EI-536/523/512/509 self-amplifying loop. So while a lane env-outage is
 * detected, cause-unknown orphans are suppressed too (the env outage is captured
 * separately as service-down; once it clears, a genuine orphan re-signals).
 */
export const ENV_OUTAGE_WINDOW_MS = 6 * 60 * 60 * 1000; // 6h — a credential window
export const ENV_OUTAGE_MIN_DEATHS = 2; // ≥2 env deaths in-window ⇒ the lane is in an outage

export interface OrphanScanOpts {
  nowMs: number;
  /** Open-row age past which the worker is presumed dead. Default dispatchOverdueAfterMs(). */
  orphanAfterMs?: number;
  /**
   * This process's boot time (ms). An OPEN row fired before it is a host-restart
   * victim — orphaned IMMEDIATELY, regardless of age (EI-403 Option B). Default 0
   * (disabled — no row predates the epoch), so the pure threshold semantics are
   * unchanged unless a caller opts in (the glue passes the live processBootMs()).
   */
  bootMs?: number;
}

/** True when an open row predates this process — its worker died with the old host. */
export function isHostRestartVictim(row: ImprovementDispatchRow, bootMs: number): boolean {
  if (row.outcome !== null || bootMs <= 0) return false;
  const firedMs = Date.parse(row.firedAt);
  return !Number.isNaN(firedMs) && firedMs < bootMs;
}

/**
 * Pure: which OPEN ledger rows mean a dead worker — either past the age threshold
 * (the worker timed out / silently died) OR fired before this process booted (a
 * host restart killed it mid-dispatch — EI-403 Option B, recovered now instead of
 * at the 2h threshold). A row whose fire already failed is terminal ('fire-failed')
 * and never reaches this; a row stuck at fire_result='pending' (the dispatcher died
 * mid-fire) does.
 */
export function scanOrphanedDispatches(
  rows: ImprovementDispatchRow[],
  opts: OrphanScanOpts,
): ImprovementDispatchRow[] {
  const orphanAfterMs = opts.orphanAfterMs ?? dispatchOverdueAfterMs();
  const bootMs = opts.bootMs ?? 0;
  return rows.filter((r) => {
    if (r.outcome !== null) return false;
    const firedMs = Date.parse(r.firedAt);
    const age = Number.isNaN(firedMs) ? Number.POSITIVE_INFINITY : opts.nowMs - firedMs;
    return age > orphanAfterMs || isHostRestartVictim(r, bootMs);
  });
}

export interface OrphanSignalOpts {
  nowMs: number;
  /** How long orphaned evidence keeps re-firing the signal. Default ORPHAN_EVIDENCE_WINDOW_MS. */
  evidenceWindowMs?: number;
  /** Cap signals per sweep. Default ORPHAN_MAX_SIGNALS. */
  maxSignals?: number;
  /**
   * When the lane is in a detected env outage ({@link laneInEnvOutage}), cause-unknown
   * orphans are outage casualties, not lane breakage — suppressed to break the EI-536
   * noise loop. Default false (healthy lane: a cause-unknown orphan IS worth a signal).
   */
  envOutage?: boolean;
  /**
   * EI-7795: the FULL recent-dispatch read (not just orphan evidence) — used to detect
   * an item that recovered on a LATER attempt after the orphaned evidence was recorded
   * (e.g. attempt 1 orphaned, attempt 2 later resolved 'fixed'). Without this, a signal
   * can fire on stale evidence from a lane that has since recovered (the storm's own
   * item ids can be living proof the lane already works again). Default: `evidence`
   * itself (no broader context available — matches the pre-fix behavior for callers
   * that don't pass it).
   */
  allRows?: ImprovementDispatchRow[];
}

/** Outcomes that mean the item's OWN dispatch genuinely settled (not a worker death). */
const RESOLVED_DISPATCH_OUTCOMES = new Set<DispatchOutcome>(['fixed', 'could-not-fix', 'needs-human']);

/**
 * Pure: item ids whose orphan evidence is STALE — a LATER attempt (higher `attempt`
 * number) on the SAME item reached a genuine resolved outcome. `allRows` should be the
 * full recent-dispatch read so later attempts are visible even when they fall outside
 * `evidence` (evidence is orphan-outcome-only). Compares by `attempt`, not timestamp,
 * per-item — unambiguous and immune to clock/formatting drift across rows.
 */
function stallSuperseded(
  evidenceByItem: Map<string, ImprovementDispatchRow[]>,
  allRows: ImprovementDispatchRow[],
): Set<string> {
  const superseded = new Set<string>();
  for (const [itemId, orphanRows] of evidenceByItem) {
    const maxOrphanAttempt = Math.max(...orphanRows.map((r) => r.attempt ?? 0));
    const laterResolved = allRows.some(
      (r) =>
        r.itemId === itemId &&
        r.outcome != null &&
        RESOLVED_DISPATCH_OUTCOMES.has(r.outcome) &&
        (r.attempt ?? 0) > maxOrphanAttempt,
    );
    if (laterResolved) superseded.add(itemId);
  }
  return superseded;
}

/**
 * Pure (EI-11986 class root cause, 2026-07-15): item ids that have BOTH an orphaned
 * dispatch row AND a LATER (higher-attempt) dispatch that reached a genuine resolved
 * outcome — i.e. the auto-implement lane recovered the item on retry after the
 * orphan. `stallSuperseded` already computed this per-tick to stop a NEW signal from
 * firing on stale evidence (EI-7795), but nothing used it to reconcile a bug ALREADY
 * FILED on the earlier (now-stale) evidence — so a transient env/gateway hiccup that
 * self-healed on the very next retry left a permanently open "orphaned worker died —
 * investigate" bug for the lane. Root-caused live: 6 duplicate EIs
 * (EI-11986/11988/12041/12503/12511/12530) each superseded within 1-3h by a
 * successful retry (`outcome: 'fixed'` on attempt+1/+2), yet all sat open — the
 * collector's own supersession logic never reached back to close them. Computed over
 * the FULL recent-dispatch read (not the windowed signal evidence), so it reconciles
 * even after the bug's original orphan evidence has aged out of
 * {@link ORPHAN_EVIDENCE_WINDOW_MS}.
 */
export function supersededOrphanItemIds(rows: ImprovementDispatchRow[]): Set<string> {
  const orphanedByItem = new Map<string, ImprovementDispatchRow[]>();
  for (const r of rows) {
    if (r.outcome !== 'orphaned') continue;
    const list = orphanedByItem.get(r.itemId) ?? [];
    list.push(r);
    orphanedByItem.set(r.itemId, list);
  }
  return stallSuperseded(orphanedByItem, rows);
}

/**
 * Which 'orphaned' rows indicate POSSIBLE LANE BREAKAGE worth a human signal, vs a
 * correctly-handled transient/infra death that needs no alarm. A worker death is NOT
 * lane breakage when it is:
 *   - a HOST-RESTART victim (resolved_by 'host-restart-recovery') — a deploy/restart
 *     killed it mid-dispatch; already recovered (claim released + attempt rolled back,
 *     EI-403 Option B). Infra, not the lane's fault.
 *   - an ENV-FAILURE death (resolved_by 'worker-exit-backedge-env', or a legacy
 *     'worker-exit-backedge' whose detail still carries '[env-failure') — rate-limit /
 *     auth / connectivity (EI-406); attempt rolled back, self-resolving (e.g. a
 *     weekly-limit reset). Filing a major "lane broken" EI for it is a FALSE ALARM —
 *     and since that EI is itself auto-implement-eligible, it would DOA on the SAME
 *     outage and file ANOTHER orphan EI: a self-amplifying backlog-noise loop (EI-536/
 *     523/512/509). The dispatch-stats rollup still counts it; the human signal does not.
 *   - a CONTEXT-OVERFLOW death (resolved_by 'worker-exit-backedge-context-overflow',
 *     WI-716) — the worker's session ran out of context window on an oversized item;
 *     says nothing about the DISPATCH lane (other items dispatch and run fine), only
 *     about that one item's scope. Its OWN escalation path (needsHuman after
 *     CONTEXT_OVERFLOW_ESCALATE_CAP deaths, implement-worker-exit.ts) is the correct
 *     human signal — filing a SECOND "lane broken" EI on top would be the same
 *     self-amplifying-noise failure mode as the env-failure case above.
 *   - a WORKER-TIMEOUT death (resolved_by 'worker-exit-backedge-timeout', WI-2162,
 *     root-caused live 2026-07-04) — the invoke route's OWN clock (45min) SIGTERM'd
 *     the worker while it was still investigating/fixing, not a crash. This was THE
 *     dominant driver of the 17+ duplicate "Auto-implement dispatch died — orphaned
 *     worker" EIs in the backlog: every one of those signals traced to exit 143 at
 *     ~2700-2850s runtime, always mid-investigation, never near a resolve. Same
 *     reasoning as context-overflow: says nothing about the lane, has its own bounded
 *     escalation (TIMEOUT_ESCALATE_CAP), filing a lane-broken EI on it is the same
 *     self-amplifying noise.
 *   - a PRE-INVOKE SKIP (resolved_by 'pre-invoke-skip:<reason>', EI-9759 /
 *     durable-spawn.ts's `closeSkippedImprovementDispatch`) — the fire was skipped
 *     BEFORE the /invoke POST ever ran (gateway-storm gate, gateway-wholesale-throttle,
 *     gone-target): there was no worker, so there is nothing that "died". The closer
 *     already rolls the attempt back (not charged) precisely so this is a no-op retry,
 *     not a lane failure — reusing the 'orphaned' outcome column (there is no separate
 *     DispatchOutcome for "closed pre-invoke") is what let this masquerade as a worker
 *     death here. EI-16428: a `pre-invoke-skip:gateway-wholesale-throttled` row (closed
 *     5min after fire, nowhere near the 2h collector threshold) filed a "died without
 *     resolving — orphaned worker" bug for a dispatch nothing ever ran.
 * INCLUDED (genuine breakage): the 2h orphan collector's catch-all + a genuine non-env
 * worker crash — a worker that actually died/hung for a reason that IS about the lane.
 *
 * Presumes the caller already established `outcome === 'orphaned'` (it only reads the
 * death-cause fields). Takes a structural Pick so non-collector consumers — e.g. the
 * perf-regression rig's dispatch-orphan-rate SLO — can share this ONE predicate over
 * bare ledger rows instead of re-encoding the benign-category list (the exact drift that
 * let the SLO count benign timeout/host-restart deaths as regressions — EI-7534).
 */
export function isLaneBreakageOrphan(r: Pick<ImprovementDispatchRow, 'resolvedBy' | 'fireError'>): boolean {
  if (
    r.resolvedBy === 'host-restart-recovery' ||
    r.resolvedBy === 'worker-exit-backedge-env' ||
    r.resolvedBy === 'worker-exit-backedge-context-overflow' ||
    r.resolvedBy === 'worker-exit-backedge-timeout' ||
    (r.resolvedBy ?? '').startsWith('pre-invoke-skip:')
  )
    return false;
  if ((r.fireError ?? '').includes('[env-failure')) return false; // legacy rows (pre-distinct resolved_by)
  if ((r.fireError ?? '').includes('[context-overflow')) return false;
  return true;
}

/** An ENV-failure death (rate-limit / auth / credential, EI-406) — says nothing about the item. */
export function isEnvFailureDeath(r: ImprovementDispatchRow): boolean {
  return r.resolvedBy === 'worker-exit-backedge-env' || (r.fireError ?? '').includes('[env-failure');
}

/**
 * The lane is in an env outage when ≥ENV_OUTAGE_MIN_DEATHS dispatches died with an
 * env-failure signature inside the recent window — the shared credential pool is
 * exhausted, so a death says nothing about any one item. Pure over the ledger rows.
 */
export function laneInEnvOutage(
  rows: readonly ImprovementDispatchRow[],
  opts: { nowMs: number; windowMs?: number; minDeaths?: number },
): boolean {
  const windowMs = opts.windowMs ?? ENV_OUTAGE_WINDOW_MS;
  const minDeaths = opts.minDeaths ?? ENV_OUTAGE_MIN_DEATHS;
  let n = 0;
  for (const r of rows) {
    if (!isEnvFailureDeath(r)) continue;
    const ts = Date.parse(r.resolvedAt ?? r.firedAt);
    if (!Number.isNaN(ts) && opts.nowMs - ts <= windowMs) n += 1;
  }
  return n >= minDeaths;
}

/**
 * A CAUSE-UNKNOWN orphan: the 2h timeout collector drove it terminal with no
 * recorded death cause (no back-edge ever fired — durable-fire lost, or the worker
 * killed before it reported). Indistinguishable from an env casualty DURING an
 * outage; a genuine-breakage signal when the lane is healthy. Only suppressed while
 * {@link laneInEnvOutage} — a 2h-collector orphan that DID carry a real (non-env)
 * fireError is genuine breakage and still signals.
 */
export function isCauseUnknownOrphan(r: ImprovementDispatchRow): boolean {
  return r.resolvedBy === 'orphaned-dispatch-collector' && (r.fireError ?? '').trim() === '';
}

export function orphanStormSignature(r: ImprovementDispatchRow): string {
  const err = (r.fireError ?? '').toLowerCase();
  const exit = err.match(/\b(?:worker )?exit(?:ed)?\s+(-?\d+)\b/);
  if (exit?.[1]) return `worker-exit-${exit[1]}`;
  if (err.includes('empty') && err.includes('output')) return 'empty-output';
  if (r.fireResult === 'pending') return 'dispatcher-pending';
  if (r.fireResult && r.fireResult !== 'ok') return `fire-${r.fireResult}`;
  if (isCauseUnknownOrphan(r)) return 'collector-cause-unknown';
  if (r.resolvedBy) return r.resolvedBy.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  return 'worker-orphan';
}

function latestResolvedAt(rows: ImprovementDispatchRow[]): string {
  return rows.map((r) => r.resolvedAt as string).sort().at(-1) as string;
}

function newestDispatch(rows: ImprovementDispatchRow[]): ImprovementDispatchRow {
  return rows.reduce((a, b) => ((a.firedAt ?? '') > (b.firedAt ?? '') ? a : b));
}

function buildStormSignal(signature: string, rows: ImprovementDispatchRow[]): WatchdogSignal {
  const newest = newestDispatch(rows);
  const itemIds = [...new Set(rows.map((r) => r.itemId))].sort();
  const runIds = [...new Set(rows.map((r) => r.spawnedRunId).filter(Boolean))] as string[];
  return {
    source: 'orphaned-dispatch',
    key: `storm:${signature}`,
    // Stable title: no counts or timestamps, so search-first dedup folds repeats.
    title: `Auto-implement dispatch storm (${signature}) — orphaned workers across items`,
    body:
      `${rows.length} orphaned dispatch row(s) across ${itemIds.length} improvement item(s) share ` +
      `failure signature \`${signature}\`: ${itemIds.join(', ')}.\n` +
      `Latest: item ${newest.itemId}, attempt ${newest.attempt}, fired ${newest.firedAt}, ` +
      `fire_result=${newest.fireResult}` +
      (newest.runnerHarness ? `, runner '${newest.runnerHarness}'` : '') +
      (runIds.length ? `, spawned run(s): ${runIds.join(', ')}` : ', no spawn correlation recorded') +
      `.\n\nTreat this as a condition-level spawn/dispatch failure, not ${itemIds.length} unrelated ` +
      `item failures. Investigate the shared runner harness spawn path, worker timeout, or fire ` +
      `transport for this signature before filing or working per-item duplicates.`,
    severity: 'major',
    kind: 'bug',
    paths: [
      'packages/operator-core/lib/harness/routines/improvement-actions.ts',
      'packages/operator-core/lib/harness/improvements/dispatch-ledger.ts',
    ],
    latestAt: latestResolvedAt(rows),
  };
}

/**
 * Pure: one signal per ITEM with orphaned-dispatch evidence inside the window.
 * `evidence` is rows with outcome 'orphaned' (just-marked rows included, with
 * their fresh resolvedAt) — EXCLUDING correctly-handled env-failure + host-restart
 * deaths ({@link isLaneBreakageOrphan}), which are transient/infra, not lane
 * breakage. Titles are STABLE (no counts) — the cross-tick search-first dedup
 * matches on them; detail lives in the body.
 */
export function buildOrphanedDispatchSignals(
  evidence: ImprovementDispatchRow[],
  opts: OrphanSignalOpts,
): WatchdogSignal[] {
  const windowMs = opts.evidenceWindowMs ?? ORPHAN_EVIDENCE_WINDOW_MS;
  const maxSignals = opts.maxSignals ?? ORPHAN_MAX_SIGNALS;
  const envOutage = opts.envOutage ?? false;

  const inWindow = evidence.filter((r) => {
    if (r.outcome !== 'orphaned' || !isLaneBreakageOrphan(r)) return false;
    if (envOutage && isCauseUnknownOrphan(r)) return false; // env-outage casualty, not lane breakage
    const ts = r.resolvedAt ? Date.parse(r.resolvedAt) : NaN;
    return !Number.isNaN(ts) && opts.nowMs - ts <= windowMs;
  });

  const byItemAll = new Map<string, ImprovementDispatchRow[]>();
  for (const r of inWindow) {
    const list = byItemAll.get(r.itemId) ?? [];
    list.push(r);
    byItemAll.set(r.itemId, list);
  }

  // EI-7795: drop evidence for items that recovered on a later attempt — the storm/item
  // signal must not cry wolf on a condition that's already fixed.
  const superseded = stallSuperseded(byItemAll, opts.allRows ?? evidence);
  const liveEvidence = inWindow.filter((r) => !superseded.has(r.itemId));

  const byItem = new Map<string, ImprovementDispatchRow[]>();
  for (const r of liveEvidence) {
    const list = byItem.get(r.itemId) ?? [];
    list.push(r);
    byItem.set(r.itemId, list);
  }

  const bySignature = new Map<string, ImprovementDispatchRow[]>();
  for (const r of liveEvidence) {
    const signature = orphanStormSignature(r);
    const list = bySignature.get(signature) ?? [];
    list.push(r);
    bySignature.set(signature, list);
  }

  const stormGroups = [...bySignature.entries()]
    .map(([signature, rows]) => ({
      signature,
      rows,
      itemCount: new Set(rows.map((r) => r.itemId)).size,
      latestAt: latestResolvedAt(rows),
    }))
    .filter((g) => g.itemCount >= ORPHAN_STORM_MIN_ITEMS)
    .sort((a, b) => {
      const d = b.itemCount - a.itemCount;
      if (d !== 0) return d;
      return a.latestAt < b.latestAt ? 1 : -1;
    });

  const stormItemIds = new Set<string>();
  const stormSignals = stormGroups.slice(0, maxSignals).map((g) => {
    for (const r of g.rows) stormItemIds.add(r.itemId);
    return buildStormSignal(g.signature, g.rows);
  });

  const itemSignals = [...byItem.entries()]
    .filter(([itemId]) => !stormItemIds.has(itemId))
    .sort(([, a], [, b]) => (latestResolvedAt(a) < latestResolvedAt(b) ? 1 : -1))
    .map(([itemId, rows]) => {
      const newest = newestDispatch(rows);
      const runIds = [...new Set(rows.map((r) => r.spawnedRunId).filter(Boolean))] as string[];
      return {
        source: 'orphaned-dispatch' as const,
        key: itemId,
        // STABLE title (no counts) — the cross-tick search-first dedup matches on it.
        title: `Auto-implement dispatch for ${itemId} died without resolving — orphaned worker`,
        body:
          `${rows.length} dispatch(es) of improvement \`${itemId}\` went past the orphan threshold with no ` +
          `\`improvements:resolve\` ever recorded — the worker died silently (crashed, SIGTERM'd, or never spawned).\n` +
          `Latest: attempt ${newest.attempt}, fired ${newest.firedAt}, fire_result=${newest.fireResult}` +
          (newest.runnerHarness ? `, runner '${newest.runnerHarness}'` : '') +
          (runIds.length ? `, spawned run(s): ${runIds.join(', ')}` : ', no spawn correlation recorded') +
          `.\n\nThe ledger row(s) are now marked 'orphaned' (terminal); the exhaustion flip routes the item ` +
          `itself to a human once its attempts cap out. Investigate WHY the worker died: the runner harness ` +
          `spawn path, the worker timeout, or the fire transport — repeated orphans mean the implement lane ` +
          `is broken, not the item.`,
        severity: 'major' as const,
        kind: 'bug' as const,
        paths: [
          'packages/operator-core/lib/harness/routines/improvement-actions.ts',
          'packages/operator-core/lib/harness/improvements/dispatch-ledger.ts',
        ],
        latestAt: latestResolvedAt(rows),
      };
    });

  return [...stormSignals, ...itemSignals].slice(0, maxSignals);
}

/** True when the error is PG's undefined_table (migration 238 not applied yet).
 *  Exported so the sibling dispatcher-staleness collector reuses the SAME
 *  table-absent detection (EI-2150) rather than re-deriving the predicate. */
export function isMissingLedgerTable(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === '42P01') return true;
  const msg = e instanceof Error ? e.message : String(e);
  return /improvement_dispatches.*does not exist|relation.*improvement_dispatches/i.test(msg);
}

/**
 * Recovery seam (EI-403 Option B) — injectable so the glue is unit-testable. Default
 * wires the real issue back-edges: release the stale claim + roll the attempt back.
 *
 * EI-15486: each fn's Promise resolves to `null` on a genuine no-op (the underlying
 * conditional UPDATE matched zero rows — e.g. a wrong-workspace scope, WI-5261 class,
 * or the issue no longer exists) — the collector checks for `=== null` and counts it
 * as `recoveryNoOps`, NOT a success. A custom implementation should preserve this: a
 * failed/no-op recovery must be distinguishable from a real one, or a tripped breaker
 * (escalateThrash) can silently fail to stick while the collector reports it did.
 */
export interface OrphanRecoverDeps {
  releaseClaim: (id: string) => Promise<unknown>;
  rollbackAttempt: (id: string, attempts: number) => Promise<unknown>;
  /**
   * EI-1689: the host-restart re-dispatch breaker has tripped for this item — route it to
   * LEADER TRIAGE instead of re-dispatching (P-004/WI-5679: default sets status='blocked' via
   * markLeaderTriage, which the dispatcher's readItems({state:'open'}) fetch honors to drop it from
   * the auto-eligible pool — WITHOUT clogging the owner's inbox the way `payload.needsHuman` did; a
   * host-restart thrash is an operational failure, not a genuine human need).
   */
  escalateThrash: (id: string) => Promise<unknown>;
}

const defaultRecover: OrphanRecoverDeps = {
  releaseClaim: releaseIssue,
  rollbackAttempt: (id, attempts) => mergeIssuePayload(id, { implementAttempts: attempts }),
  // markLeaderTriage returns the setIssueState row (null on a no-op — remote/missing), preserving
  // the recoveryNoOps === null contract (EI-15486) the collector relies on.
  escalateThrash: (id) => markLeaderTriage(id, 'host-restart-thrash', 'orphaned-dispatch-breaker'),
};

/**
 * The supersession-close seam (EI-11986 class root fix) — injectable so the glue is
 * unit-testable without PG. Default wires the real issue back-edges: find every OPEN
 * issue carrying one of the given `orphaned-dispatch:<itemId>` watchdogKeys (the
 * SAME indexed dedup query the watchdog capture path already uses), comment with the
 * recovering evidence, then resolve — mirroring auto-close.ts's absence-based dedup
 * close (`skipCompletionGate: true`: this is a reconciliation of a now-stale signal,
 * not a genuine completion).
 */
export interface OrphanCloseDeps {
  findOpenByWatchdogKeys: (keys: string[]) => Promise<EngineerIssue[]>;
  comment: (id: string, body: string, by: string) => Promise<unknown>;
  resolve: (id: string, by: string) => Promise<unknown>;
}

function watchdogKeyOf(issue: EngineerIssue): string {
  const p = issue.payload && typeof issue.payload === 'object' ? (issue.payload as Record<string, unknown>) : {};
  return typeof p.watchdogKey === 'string' ? p.watchdogKey : '';
}

const ORPHAN_WATCHDOG_KEY_PREFIX = 'orphaned-dispatch:';

const defaultOrphanClose: OrphanCloseDeps = {
  findOpenByWatchdogKeys: async (keys) => (await findIssuesByWatchdogKeys(keys)).filter((i) => i.state === 'open'),
  comment: (id, body, by) => commentIssue(id, body, by),
  resolve: (id, by) => setIssueState(id, 'resolved', by, undefined, { skipCompletionGate: true }),
};

/**
 * Reconcile: auto-resolve any already-filed per-item orphan bug whose item recovered
 * on a later dispatch attempt (see {@link supersededOrphanItemIds}). Best-effort per
 * issue + as a whole — a reconciliation failure must never break the collector sweep
 * (the signals above already ran). Returns how many bugs it closed.
 */
async function reconcileSupersededOrphanIssues(
  rows: ImprovementDispatchRow[],
  close: OrphanCloseDeps,
): Promise<number> {
  const superseded = supersededOrphanItemIds(rows);
  if (superseded.size === 0) return 0;
  let closed = 0;
  try {
    const keys = [...superseded].map((id) => `${ORPHAN_WATCHDOG_KEY_PREFIX}${id}`);
    const open = await close.findOpenByWatchdogKeys(keys);
    for (const issue of open) {
      const watchdogKey = watchdogKeyOf(issue);
      if (!watchdogKey.startsWith(ORPHAN_WATCHDOG_KEY_PREFIX)) continue;
      const itemId = watchdogKey.slice(ORPHAN_WATCHDOG_KEY_PREFIX.length);
      const resolvedRow = rows
        .filter((r) => r.itemId === itemId && r.outcome != null && RESOLVED_DISPATCH_OUTCOMES.has(r.outcome))
        .sort((a, b) => (b.attempt ?? 0) - (a.attempt ?? 0))[0];
      const evidenceNote = resolvedRow
        ? `a later dispatch (attempt ${resolvedRow.attempt}, outcome '${resolvedRow.outcome}', resolved ${resolvedRow.resolvedAt}) closed the loop for \`${itemId}\``
        : `a later dispatch attempt for \`${itemId}\` reached a genuine resolved outcome`;
      try {
        await close.comment(
          issue.id,
          `🟢 Auto-resolved: ${evidenceNote} — this orphan report is superseded (the implement lane ` +
            `recovered on retry, not broken). Re-files automatically if a genuine orphan recurs. (orphaned-dispatch reconciliation)`,
          'watchdog-orphan-superseded',
        );
        await close.resolve(issue.id, 'watchdog-orphan-superseded');
        closed += 1;
      } catch (e) {
        console.warn(`[orphaned-dispatch] supersession close failed for ${issue.id}:`, e instanceof Error ? e.message : e);
      }
    }
  } catch (e) {
    console.warn('[orphaned-dispatch] supersession reconciliation failed:', e instanceof Error ? e.message : e);
  }
  return closed;
}

/**
 * Thin PG glue: read recent ledger rows, drive overdue OPEN rows terminal
 * ('orphaned' — race-safe against a late resolve via the `outcome IS NULL`
 * guard), then signal per affected item. Rows a late resolve beat us to are
 * NOT evidence (the worker did resolve — nothing was silent).
 *
 * EI-403 Option B: a row fired before this process booted is a HOST-RESTART victim
 * (a deploy/crash killed the worker AND the /invoke route, so the EI-404 back-edge
 * couldn't fire). Recover it fast — release the item's claim so the next implement
 * tick re-dispatches (vs the 2h stale-claim window) and roll the attempt back (a
 * restart is an environment event, not the item's fault). `bootMs` defaults to the
 * live process boot; tests pin it (0 disables the host-restart leg).
 */
export async function collectOrphanedDispatchSignals(
  workspaceId: string,
  opts: { bootMs?: number; recover?: OrphanRecoverDeps; close?: OrphanCloseDeps } = {},
): Promise<CollectorResult> {
  const nowMs = Date.now();
  const bootMs = opts.bootMs ?? processBootMs();
  const recover = opts.recover ?? defaultRecover;
  const close = opts.close ?? defaultOrphanClose;
  let rows: ImprovementDispatchRow[];
  try {
    rows = await readRecentDispatches(workspaceId, { limit: ORPHAN_SCAN_READ_LIMIT });
  } catch (e) {
    if (isMissingLedgerTable(e)) {
      return { signals: [], note: 'dispatch ledger absent (migration 238 not applied yet) — skipped' };
    }
    throw e;
  }

  const toMark = scanOrphanedDispatches(rows, { nowMs, bootMs });
  const nowIso = new Date(nowMs).toISOString();
  const marked: ImprovementDispatchRow[] = [];
  let recovered = 0;
  let thrashEscalated = 0;
  let recoveryNoOps = 0;
  for (const row of toMark) {
    const hostRestart = isHostRestartVictim(row, bootMs);
    // EI-1689: count this item's PRIOR host-restart recoveries in the window — each
    // recovery cycle leaves one terminal `host-restart-recovery` row, and `rows`
    // (≤500, ~10d) comfortably spans the 6h window. The current row is still OPEN
    // (in toMark), so it is not yet counted; the breaker trips on the cap-th cycle.
    const priorRestartRecoveries = hostRestart
      ? rows.filter(
          (r) =>
            r.itemId === row.itemId &&
            r.resolvedBy === 'host-restart-recovery' &&
            r.resolvedAt != null &&
            nowMs - Date.parse(r.resolvedAt) <= ORPHAN_THRASH_WINDOW_MS,
        ).length
      : 0;
    const thrashTripped = hostRestart && priorRestartRecoveries >= HOST_RESTART_REDISPATCH_CAP;
    const ok = hostRestart
      ? await markDispatchOrphaned(
          row.id,
          'host-restart-recovery',
          `host restarted mid-dispatch (fired ${row.firedAt}, before process boot) — worker killed; ` +
            (thrashTripped
              ? `re-dispatch cap (${HOST_RESTART_REDISPATCH_CAP} in ${Math.round(ORPHAN_THRASH_WINDOW_MS / 3.6e6)}h) exceeded — routed to human, NOT re-dispatched (EI-1689 thrash breaker)`
              : `claim released + attempt rolled back for re-dispatch (EI-403 Option B)`),
        )
      : await markDispatchOrphaned(row.id);
    if (!ok) continue;
    marked.push({
      ...row,
      outcome: 'orphaned',
      resolvedAt: nowIso,
      resolvedBy: hostRestart ? 'host-restart-recovery' : 'orphaned-dispatch-collector',
    });
    if (hostRestart) {
      try {
        // Always release the dead worker's claim (cleanup). Then EITHER re-dispatch
        // (roll the attempt back) OR — if the breaker tripped — route to a human so
        // the item drops out of the auto-eligible pool instead of thrashing forever.
        //
        // EI-15486: each of these is a conditional UPDATE (`WHERE ... issue_id = id`)
        // that returns null on a ZERO-ROW match instead of throwing — the WI-5261
        // class silent no-op (a wrong-workspace write matches nothing). A caller that
        // ignores the return value can't tell "recovered" from "the write quietly did
        // nothing", which is exactly how EI-10524 thrashed for 11h past two tripped
        // breakers (escalateThrash no-op'd both times, never observed) and blew the
        // dispatch-orphan-rate SLO. Check every result; a null is NOT success.
        const releaseResult = await recover.releaseClaim(row.itemId);
        if (releaseResult === null) recoveryNoOps += 1;
        if (thrashTripped) {
          const escalateResult = await recover.escalateThrash(row.itemId);
          if (escalateResult === null) recoveryNoOps += 1;
          else thrashEscalated += 1;
        } else {
          const rollbackResult = await recover.rollbackAttempt(row.itemId, Math.max(0, (row.attempt ?? 1) - 1));
          if (rollbackResult === null) recoveryNoOps += 1;
          else recovered += 1;
        }
      } catch (e) {
        console.warn(
          `[orphaned-dispatch] host-restart recovery failed for ${row.itemId}:`,
          e instanceof Error ? e.message : e,
        );
      }
    }
  }

  const evidence = [...marked, ...rows.filter((r) => r.outcome === 'orphaned')];
  const envOutage = laneInEnvOutage(rows, { nowMs });
  // EI-7795: pass the FULL recent read (not just orphan evidence) so a later, already-
  // resolved attempt on the same item can supersede stale orphan evidence.
  const signals = buildOrphanedDispatchSignals(evidence, { nowMs, envOutage, allRows: rows });
  // EI-11986 class root fix: close any per-item orphan bug ALREADY FILED on evidence
  // that a later dispatch attempt has since superseded — the signal-suppression path
  // above (EI-7795) only stops a NEW bug from firing on stale evidence; this reaches
  // back to reconcile one that was already filed before the recovery landed.
  const closedSuperseded = await reconcileSupersededOrphanIssues(rows, close);
  const notes: string[] = [];
  if (marked.length) notes.push(`marked ${marked.length} open dispatch(es) orphaned (worker presumed dead)`);
  if (recovered) notes.push(`recovered ${recovered} host-restart victim(s) (claim released + attempt rolled back)`);
  if (thrashEscalated)
    notes.push(
      `routed ${thrashEscalated} thrashing item(s) to human — host-restart re-dispatch cap (${HOST_RESTART_REDISPATCH_CAP}) exceeded (EI-1689)`,
    );
  if (envOutage) notes.push('lane env-outage detected — cause-unknown orphans suppressed (EI-536 noise-loop guard)');
  if (closedSuperseded) notes.push(`auto-resolved ${closedSuperseded} superseded orphan bug(s) (item recovered on a later attempt)`);
  if (recoveryNoOps)
    notes.push(
      `⚠ ${recoveryNoOps} host-restart-recovery write(s) matched ZERO rows (silent no-op — WI-5261 class; ` +
        `an issue whose claim/attempt/thrash-escalation was reported recovered may NOT actually be)`,
    );
  return { signals, ...(notes.length ? { note: notes.join('; ') } : {}) };
}
