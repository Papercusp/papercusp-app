/**
 * run-drain-reconcile — WI-254 (EI-1618 item 2): the periodic federation-drain
 * reconcile pass (single run).
 *
 * EI-1618's on-READ surface (federation-status route + the desktop) flips a
 * harness off "healthy" when its substrate_outbox is undrained past threshold —
 * but only when something READS it. This is the proactive half: one pass over the
 * LIVE booted harnesses that flags any whose outbox is stalled (captured but not
 * federating — the EI-681 class) and files a DEDUPED improvement, so a silent
 * stall is caught without a reader, and surfaced long before the
 * substrate-outbox-backstop-GC drops the undrained-orphaned rows (it GCs at 48h;
 * this alerts at 60s — a huge no-race margin).
 *
 * HOME (design, WI-254): this is an EPHEMERAL, idempotent health check, so per
 * EI-1622 it must NOT be a DBOS scheduled workflow (those wrote ~200k
 * workflow_status rows/day = the routine-engine-freeze source) NOR a routine-engine
 * action (wedge-prone). It is armed as a lightweight in-process-periodic check (a
 * plain setInterval, resilient to the routine-engine / bg-host cycling). This module
 * is the single-run body (parity with runStorageGrowthAlarmOnce); the in-process
 * tick lazy-imports + calls it.
 *
 * Over-reaction guard (aligned with the transient-signal-over-reaction runbook):
 * a healthy drain marks a row within seconds — UNLESS the host just self-recycled
 * (this dev box's `papercup-staging-api`/`papercup-dev-api` routinely SIGKILL-
 * restart every ~5-8min), which reliably produces a ~90-130s capture→drain
 * catch-up gap that is normal + self-healing, not a stall. 2026-07-19 live evidence
 * (24 duplicate "Federation stall" bugs filed against the papercusp harness in
 * ~12h, each manually investigated + closed as self-resolved) showed the ORIGINAL
 * 60s threshold sat inside that noise floor — see `plan-drain-reconcile.ts`'s
 * `DRAIN_STALLED_MS`/`DRAIN_UNHEALTHY_MS` doc comments for the raised thresholds
 * (5min / 20min) that clear it with margin while staying far tighter than
 * `outbox-drain.ts`'s own genuine-wedge detectors. The per-(workspace,harness)
 * watchdog dedup means one improvement per stall, never one per tick.
 *
 * RE-FILE COOLDOWN (2026-07-20, EI-18151359560402948 follow-up): raising the
 * thresholds above did NOT stop the storm — it just changed its shape. Because
 * `capture()` runs with `dedupScope:'open'`, a CLOSED duplicate is (by design,
 * for genuine regressions — see capture-core.ts's dedup doc) never suppressed,
 * so as soon as an agent closes one instance the very next 5min tick (if the
 * harness is still mid-flap) mints a brand-new issue. Live evidence: 20 distinct
 * "Federation stall: papercusp …" issues filed between 2026-07-19T19:39 and
 * 2026-07-20T04:29 (~9h), most closed within minutes as "self-resolved, root
 * cause already fixed by peers" — i.e. the SAME flapping episode re-filed as a
 * fresh ticket ~20 times, burning an agent-investigation each time instead of
 * being tracked as one recurring incident. `REFILE_COOLDOWN_MS` below adds a
 * caller-local (not capture-core-global — this repeat-regression shape is
 * specific to a flapping infra signal, not improvements in general) grace
 * period: if the SAME watchdogKey's most-recently-updated issue was closed more
 * recently than the cooldown, the recurrence is posted as a COMMENT on that
 * issue (visible, reopens the conversation) instead of minting a duplicate.
 *
 * COOLDOWN WIDENED TO 3h (2026-07-20, EI-18154505642725023 follow-up): the 30min
 * cooldown above cut the storm's rate but did not stop it recurring. Live
 * evidence post-fix: papercusp's outbox undrained-count DID fall steadily
 * (16578 -> 12154 -> 10494 -> 9337 over ~5h, a live-measured ~24 rows/min drain
 * rate), i.e. the backlog is genuinely, continuously self-healing, NOT stalled
 * -- but at that rate a 10-16k backlog takes several HOURS to clear, so the
 * 30min window kept elapsing and re-filing a fresh issue every ~50min-1h50m
 * even though nothing new or actionable had happened since the last close.
 * Root cause of the SLOW-not-stalled drain (confirmed live via journalctl on
 * the substrate-primary bg-host, 2026-07-20 ~05:00 EDT): individual outbox
 * rows occasionally hit the WI-3896 ROW STAGE TIMEOUT class on their
 * epoch-encrypt stage (45s no-settle, outbox-drain.ts's ROW_STAGE_TIMEOUT_MS)
 * -- and because papercusp's own bg-host process only lives ~30-90min between
 * recycles here, the in-memory rowTimeoutCounts consecutive-failure counter
 * (needs 3 IN THE SAME PROCESS to reach ROW_QUARANTINE_THRESHOLD) routinely
 * resets before a genuinely-slow row gets durably quarantined, so it can
 * re-block the head of the ORDER BY id queue across several restarts before a
 * lucky retry clears it. This throttles throughput without ever tripping
 * outbox-drain.ts's OWN zero-progress detector (drain_backlog_stalled -- the
 * drain IS moving, just slowly) -- this reconcile is the only thing that sees
 * it, and it was seeing it every ~30min. 3h is comfortably above the observed
 * natural full-drain timescale for a papercusp-scale (10-16k row) backlog at
 * the measured rate, so a backlog that is genuinely still shrinking stays
 * quiet across the whole recovery instead of re-triggering an
 * agent-investigation every cooldown window; a backlog that is NOT shrinking
 * (or a fresh, unrelated stall) still gets filed once the (now longer)
 * cooldown elapses. The real throughput fix (persisting rowTimeoutCounts
 * across restarts, or bounding queue-head poison rows some other way) is a
 * separate, higher-risk change to outbox-drain.ts itself -- out of scope
 * here; this only stops the SYMPTOM (repeat ticket noise) from costing an
 * agent-investigation every recurrence while that fix is pending.
 */
import type { SubstrateDrainStat } from './load-drain-stats';
import type { InProcessSubstrateStatus } from './in-process-status';
import {
  planDrainReconcile,
  drainStallWatchdogKey,
  type DrainStallFlag,
  type DrainReconcileInput,
} from './plan-drain-reconcile';

const ZERO_DRAIN: SubstrateDrainStat = { undrainedCount: 0, oldestUndrainedAgeMs: null };

/**
 * Minimum time since a same-watchdogKey issue was last updated (i.e. closed) before
 * a NEW stall observation for that same (workspace, harness) may mint a fresh issue.
 * Default 3h (raised 2026-07-20 from 30min — see the "COOLDOWN WIDENED TO 3h" doc
 * comment above): long enough to cover the observed natural full-drain timescale of
 * a papercusp-scale (10-16k row) backlog at its live-measured ~24 rows/min
 * self-healing drain rate, so a backlog that is genuinely still shrinking (not
 * stalled) doesn't re-trigger a fresh agent-investigation every recurrence tick;
 * still short enough that a genuinely NEW, unrelated multi-hour stall episode gets
 * its own tracked issue promptly. Tunable via `RunDrainReconcileDeps.refileCooldownMs`
 * (tests pass 0 to disable it and keep exercising the always-refile path).
 */
export const DEFAULT_REFILE_COOLDOWN_MS = 3 * 60 * 60_000;

/** The subset of EngineerIssue this module needs for the cooldown check. */
interface RecentWatchdogIssue {
  id: string;
  state: string;
  updatedAt: string;
}

/** Result of a capture attempt (the subset of captureImprovement's return we use). */
export interface CaptureResult {
  created: boolean;
  reason?: string;
  issue?: { id: string } | null;
}

export interface RunDrainReconcileDeps {
  /** Prefetch the per-(ws,harness) undrained drain stats. Default: loadSubstrateDrainStats over getOrgPg. */
  loadDrainStats?: () => Promise<Map<string, SubstrateDrainStat>>;
  /** The in-process substrate status, given a sync drain resolver. Default: getInProcessSubstrateStatus. */
  getStatus?: (opts: {
    resolveDrainStats: (ws: string, slug: string) => SubstrateDrainStat;
  }) => InProcessSubstrateStatus;
  /** File a deduped improvement for one stall. Default: captureImprovement. */
  capture?: (input: {
    title: string;
    kind: 'bug';
    severity: 'major' | 'minor';
    body: string;
    foundDuring: string;
    dedupScope: 'open';
    watchdogKey: string;
  }) => Promise<CaptureResult>;
  log?: (msg: string) => void;
  stalledMs?: number;
  unhealthyMs?: number;
  /** Look up prior issues (any state) carrying a watchdogKey, newest-updated first.
   *  Default: findIssuesByWatchdogKeys (harness/issues-engineer.ts). */
  findByWatchdogKey?: (key: string) => Promise<RecentWatchdogIssue[]>;
  /** Post a recurrence note on an existing issue instead of filing a duplicate.
   *  Default: commentIssue (harness/issues-engineer.ts). */
  commentOnRecurrence?: (issueId: string, body: string) => Promise<unknown>;
  /** See DEFAULT_REFILE_COOLDOWN_MS. */
  refileCooldownMs?: number;
  /** Override for tests; defaults to Date.now(). */
  nowMs?: number;
}

export interface RunDrainReconcileResult {
  flagged: DrainStallFlag[];
  captured: number;
  /** Flagged-but-in-cooldown: a recurrence comment was posted instead of a new issue. */
  coolingDown: number;
}

function bodyFor(f: DrainStallFlag): string {
  const ageS = Math.round(f.oldestUndrainedAgeMs / 1000);
  return (
    `Harness ${f.harnessSlug} (workspace ${f.workspaceId}) is BOOTED but its ` +
    `substrate_outbox has ${f.undrainedCount} row(s) undrained for ${ageS}s — content is ` +
    `captured but NOT federating (the EI-681 silent-stall class). A healthy drain marks a ` +
    `row within seconds, so this is a real stall, not a transient.\n\n` +
    `Likely causes: the per-harness outbox drain is wedged / the harness never joined its ` +
    `topic / a workspace mis-route (see substrate-outbox-backstop-gc). This was caught by ` +
    `the federation-drain reconcile (WI-254) BEFORE the 48h backstop-GC would drop the rows. ` +
    `Verdict: ${f.severity}.\n\n` +
    `TRIAGE FIRST (2026-07-20, EI-18154505642725023): for harness=papercusp specifically, ` +
    `check whether the undrained count is DECREASING across repeated reads (dev:pg_query \`SELECT ` +
    `count(*) FROM harness_shared.substrate_outbox WHERE drained_at IS NULL AND harness_slug=` +
    `'papercusp' AND workspace_id='${f.workspaceId}'\` a few minutes apart) before assuming a wedge — ` +
    `a live-confirmed root cause is the WI-3896 ROW STAGE TIMEOUT class on individual rows' ` +
    `epoch-encrypt stage (outbox-drain.ts), which throttles-but-doesn't-stop the drain because the ` +
    `bg-host process here recycles too often (~30-90min) for the in-memory 3-consecutive-timeout ` +
    `quarantine counter to reliably trip. If the count is falling, this is that KNOWN, self-healing, ` +
    `just-slow condition — no action needed beyond closing with the observed rate; do not re-diagnose ` +
    `from scratch (see run-drain-reconcile.ts's module doc comment for the full analysis). Only ` +
    `escalate/investigate further if the count is FLAT or GROWING across repeated reads.`
  );
}

/**
 * Run one drain-reconcile pass. Reads the undrained stats, maps them over the LIVE
 * booted harnesses, and files a deduped improvement per stalled one. Best-effort:
 * a single capture failure is logged + skipped (the others still fire); a fatal
 * read error propagates to the in-process tick wrapper (which logs + retries next
 * interval). Pure-core (planDrainReconcile) does the stall classification.
 */
export async function runDrainReconcileOnce(
  deps: RunDrainReconcileDeps = {},
): Promise<RunDrainReconcileResult> {
  const log = deps.log ?? ((m: string) => console.warn(`[federation-drain-reconcile] ${m}`));

  const loadDrainStats =
    deps.loadDrainStats ??
    (async () => {
      const { getOrgPg } = await import('@papercusp/db-org');
      const { loadSubstrateDrainStats } = await import('./load-drain-stats');
      const { sql } = getOrgPg();
      const runQuery = async <T,>(q: string, p: unknown[]): Promise<T[]> =>
        (await sql.unsafe(q, p as never)) as unknown as T[];
      return loadSubstrateDrainStats({ runQuery });
    });

  // getInProcessSubstrateStatus is sync; resolve it via await-import (ESM — no
  // require) so an injected getStatus keeps the test path PG/boot-free.
  let getStatus = deps.getStatus;
  if (!getStatus) {
    const mod = await import('./in-process-status');
    getStatus = mod.getInProcessSubstrateStatus;
  }

  const capture =
    deps.capture ??
    (async (input) => {
      const { captureImprovement } = await import('../../harness/improvements/capture-core');
      return (await captureImprovement(input)) as CaptureResult;
    });

  const findByWatchdogKey =
    deps.findByWatchdogKey ??
    (async (key: string) => {
      const { findIssuesByWatchdogKeys } = await import('../../issues-engineer');
      return findIssuesByWatchdogKeys([key]);
    });

  const commentOnRecurrence =
    deps.commentOnRecurrence ??
    (async (issueId: string, body: string) => {
      const { commentIssue } = await import('../../issues-engineer');
      return commentIssue(issueId, body);
    });

  const cooldownMs = deps.refileCooldownMs ?? DEFAULT_REFILE_COOLDOWN_MS;
  const now = deps.nowMs ?? Date.now();

  const drainByKey = await loadDrainStats();
  const status = getStatus({
    resolveDrainStats: (ws, slug) => drainByKey.get(`${ws}::${slug}`) ?? ZERO_DRAIN,
  });

  const inputs: DrainReconcileInput[] = status.harnesses.map((h) => ({
    workspaceId: h.workspaceId,
    harnessSlug: h.harnessSlug,
    drain: h.drain,
  }));
  const flagged = planDrainReconcile(inputs, {
    stalledMs: deps.stalledMs,
    unhealthyMs: deps.unhealthyMs,
  });

  let captured = 0;
  let coolingDown = 0;
  for (const f of flagged) {
    const watchdogKey = drainStallWatchdogKey(f.workspaceId, f.harnessSlug);
    try {
      let recent: RecentWatchdogIssue[] = [];
      try {
        recent = await findByWatchdogKey(watchdogKey);
      } catch (e) {
        log(`findByWatchdogKey failed for ${watchdogKey} (treating as no prior issue): ${e instanceof Error ? e.message : e}`);
      }
      // findIssuesByWatchdogKeys orders newest-updated first; an OPEN top hit is
      // capture()'s own dedup to handle (it will decline below). Only a CLOSED
      // top hit inside the cooldown window is this module's concern.
      const top = recent[0];
      const closedRecently =
        top &&
        top.state !== 'open' &&
        Number.isFinite(Date.parse(top.updatedAt)) &&
        now - Date.parse(top.updatedAt) < cooldownMs;
      if (closedRecently) {
        coolingDown += 1;
        const ageS = Math.round((now - Date.parse(top.updatedAt)) / 1000);
        log(
          `${watchdogKey}: recurrence within re-file cooldown (prior issue ${top.id} closed ${ageS}s ago) — ` +
            `posting a recurrence comment instead of a duplicate issue`,
        );
        try {
          await commentOnRecurrence(
            top.id,
            `Recurred: outbox undrained again ${Math.round(f.oldestUndrainedAgeMs / 1000)}s / ` +
              `${f.undrainedCount} row(s), ${ageS}s after this issue was last closed — within the ` +
              `${Math.round(cooldownMs / 1000)}s re-file cooldown, so no duplicate was filed. If this keeps ` +
              `recurring, the flapping itself (not any single occurrence) is the bug to root-cause.`,
          );
        } catch (e) {
          log(`comment-on-recurrence failed for ${top.id} (skipped): ${e instanceof Error ? e.message : e}`);
        }
        continue;
      }
      const res = await capture({
        title: `Federation stall: ${f.harnessSlug} outbox undrained ${Math.round(
          f.oldestUndrainedAgeMs / 1000,
        )}s (${f.undrainedCount} row(s))`,
        kind: 'bug',
        severity: f.severity === 'unhealthy' ? 'major' : 'minor',
        body: bodyFor(f),
        foundDuring: 'federation-drain-reconcile',
        dedupScope: 'open',
        watchdogKey,
      });
      if (res.created) captured += 1;
    } catch (e) {
      log(`capture failed for ${f.workspaceId}/${f.harnessSlug} (skipped): ${e instanceof Error ? e.message : e}`);
    }
  }

  if (flagged.length > 0) {
    log(
      `${flagged.length} stalled harness(es): ` +
        flagged.map((f) => `${f.harnessSlug}=${f.undrainedCount}u/${Math.round(f.oldestUndrainedAgeMs / 1000)}s[${f.severity}]`).join(', ') +
        ` (${captured} newly filed, ${coolingDown} cooling-down, rest deduped)`,
    );
  }
  return { flagged, captured, coolingDown };
}
