/**
 * sandbox.ts — the sandboxed drill harness: one drill, end-to-end, through the
 * REAL self-improvement machinery (self-learning-frontier-2026-06-12 P-031 /
 * FB-20).
 *
 * One cycle = plant → DETECT (a real `runWatchdogTick` over the sandbox
 * workspace with the class's collectors — same planning, key-dedup, capture
 * core, and tick records as the live watchdog) → TRIAGE (the real
 * buildDigest → triageIdea → applyTriageDecision path, explicitly opted into
 * origin='drill') → FIX (the class's known remedy + the real
 * resolveImprovement, with a post-heal collector re-sweep as evidence) →
 * MTTSH segments + the ZERO-LEAK assertion recorded on the drill row →
 * cleanup (always, even on failure).
 *
 * What MTTSH measures here is the loop MACHINERY's latency against known
 * ground truth (detect/triage/fix stage health + correctness), not cadence
 * lag: the v1 cycle heals via the drill's own remedy because the implement
 * lane is itself dark (IMPROVEMENT_AUTO_IMPLEMENT). When that lane arms, the
 * fix leg can hand off to it and a later tick measures the async heal — the
 * stage stamps on the drill row already support that split.
 *
 * The zero-leak record per run (D-002):
 *   - organicReadClean   — the default (organic-only) read seam returns NO row
 *     for this drill (id and watchdogKey both absent);
 *   - liveCollectorClean — the SAME collector wrappers swept over the LIVE
 *     workspace see none of the planted artifacts (the workspace partition);
 *   - capturedOriginIsDrill — the captured issue's stored signal_origin is
 *     exactly 'drill'.
 */

import type { Sql } from 'postgres';
import { getIssue, type EngineerIssue } from '../issues-engineer';
import {
  runWatchdogTick,
  watchdogKeyOf,
  type WatchdogTickOptions,
  type WatchdogTickResult,
  type WatchdogCollector,
  type WatchdogDeps,
} from '../harness/improvements/watchdog';
import { readImprovementItems, type ReadImprovementOpts } from '../harness/improvements/read-items';
import { buildDigest } from '../harness/improvements/digest';
import { triageIdea } from '../harness/improvements/triage';
import { applyTriageDecision, type ApplyTriageInput, type ApplyTriageResult } from '../harness/improvements/triage-core';
import {
  resolveImprovement,
  type ResolveImprovementInput,
  type ResolveImprovementResult,
} from '../harness/improvements/resolve-core';
import type { ImprovementCandidate } from '../harness/improvements/policy';
import { drillClassById, DRILL_CLASSES } from './drill-classes';
import {
  expireStaleDrills,
  insertDrillRow,
  markDrillFailed,
  readDrillOutcomes,
  updateDrillDetected,
  updateDrillResolved,
  updateDrillTriaged,
} from './store';
import {
  SANDBOX_WORKSPACE_ID,
  type DrillClass,
  type LeakCheckResult,
  type MttshSegments,
} from './types';
import { trackDetached } from '../detached-imports';

/** Injectable seam — unit tests run the whole cycle without PG. */
export interface DrillCycleDeps {
  sql: Sql;
  /** The LIVE workspace id (the leak check sweeps it; never planted into). */
  liveWorkspaceId: string;
  runTick: (
    workspaceId: string,
    opts: WatchdogTickOptions,
    deps: { collectors: WatchdogCollector[] } & Pick<WatchdogDeps, 'processAging' | 'processAutoClose'>,
  ) => Promise<WatchdogTickResult>;
  getIssue: (id: string) => Promise<EngineerIssue | null>;
  readItems: (opts: ReadImprovementOpts) => Promise<ImprovementCandidate[]>;
  applyTriage: (input: ApplyTriageInput) => Promise<ApplyTriageResult>;
  resolve: (input: ResolveImprovementInput) => Promise<ResolveImprovementResult>;
  store: {
    insert: typeof insertDrillRow;
    detected: typeof updateDrillDetected;
    triaged: typeof updateDrillTriaged;
    resolved: typeof updateDrillResolved;
    failed: typeof markDrillFailed;
    expireStale: typeof expireStaleDrills;
    readOutcomes: typeof readDrillOutcomes;
  };
  now: () => number;
  log: (msg: string) => void;
}

export function defaultDrillCycleDeps(sql: Sql, liveWorkspaceId: string): DrillCycleDeps {
  return {
    sql,
    liveWorkspaceId,
    runTick: (ws, opts, deps) => runWatchdogTick(ws, opts, deps),
    getIssue,
    readItems: readImprovementItems,
    applyTriage: applyTriageDecision,
    resolve: resolveImprovement,
    store: {
      insert: insertDrillRow,
      detected: updateDrillDetected,
      triaged: updateDrillTriaged,
      resolved: updateDrillResolved,
      failed: markDrillFailed,
      expireStale: expireStaleDrills,
      readOutcomes: readDrillOutcomes,
    },
    now: () => Date.now(),
    log: (m) => console.log(`[red-queen] ${m}`),
  };
}

export interface DrillCycleResult {
  ok: boolean;
  drillClass: string;
  drillId?: string;
  status: 'resolved' | 'failed' | 'skipped';
  issueId?: string;
  mttsh?: MttshSegments;
  leakCheck?: LeakCheckResult;
  reason?: string;
}

/** Fire the Learning tab's vital-sign refresh (capture-core's lazy idiom). */
function invalidateVitals(): void {
  void trackDetached(import('../sync-sse'))
    .then((m) => m.notifySyncInvalidate('learning.redQueen'))
    .catch(() => {});
}

/**
 * Run ONE drill cycle for a class. Always cleans planted artifacts, even on
 * failure; never throws (the result carries the failure).
 */
export async function runDrillCycle(cls: DrillClass, deps: DrillCycleDeps): Promise<DrillCycleResult> {
  const { sql, store, log } = deps;

  // One open drill per class (the partial unique index is the real guard —
  // this read just gives a clean skip reason instead of a 23505).
  const open = await store
    .readOutcomes(sql, { workspaceId: SANDBOX_WORKSPACE_ID, classId: cls.id, limit: 1 })
    .then((rows) => rows.find((r) => r.status === 'planted' || r.status === 'detected' || r.status === 'triaged'))
    .catch(() => undefined);
  if (open) {
    return { ok: false, drillClass: cls.id, status: 'skipped', reason: `drill ${open.drillId} still in flight (${open.status})` };
  }

  let drillId: string | undefined;
  let planted: Awaited<ReturnType<DrillClass['plant']>> | undefined;
  try {
    planted = await cls.plant(sql, { drillId: 'pending' });
    const inserted = await store.insert(sql, {
      workspaceId: SANDBOX_WORKSPACE_ID,
      drillClass: cls.id,
      collectorFamily: cls.collectorFamily,
      expectedWatchdogKey: planted.expectedWatchdogKey,
      expectedKind: planted.expectedKind,
      expectedSeverity: planted.expectedSeverity,
      expectedDecision: planted.expectedDecision,
      artifacts: planted.artifacts,
      payload: planted.payload,
    });
    drillId = inserted.drillId;
    const plantedMs = Date.parse(inserted.plantedAt);
    log(`drill ${cls.id} planted (${drillId}) — expecting ${planted.expectedWatchdogKey}`);

    // ── DETECT: a REAL watchdog tick over the sandbox workspace ─────────────
    // EI-6933: processAging/processAutoClose are NOT workspace-scoped by the
    // sandbox's SANDBOX_WORKSPACE_ID the way the collectors above are — both
    // resolve their issue reads through issuesScopeWorkspace()/activeWorkspaceId()
    // (issues-engineer.ts), a PROCESS-GLOBAL "current workspace" concept the
    // watchdog tick's own workspaceId PARAMETER never reaches. So a drill tick
    // was silently running the auto-close sweep against the REAL, unscoped,
    // system-wide open-issue backlog (up to 500 rows + cross-referencing) on
    // every single drill — inflating (and scaling with backlog growth) every
    // drill's measured detect_ms, AND carrying a live correctness risk: a
    // "duplicate" among those real issues gets auto-closed as a side effect of
    // an unrelated sandbox test run. Neither sweep is part of what a drill
    // measures (drills test DETECTION — collector → capture — not the close/
    // aging machinery), so no-op both for the sandbox tick.
    const tick = await deps.runTick(
      SANDBOX_WORKSPACE_ID,
      { installSlug: 'red-queen-sandbox', maxPerTick: 5 },
      {
        collectors: cls.collectors(sql, planted, SANDBOX_WORKSPACE_ID),
        processAging: async () => [],
        processAutoClose: async () => [],
      },
    );
    if (tick.status === 'skipped') {
      await store.failed(sql, drillId, 'sandbox watchdog tick skipped (cross-host lock) — retry next cadence');
      return { ok: false, drillClass: cls.id, drillId, status: 'failed', reason: 'tick-skipped' };
    }
    let issue: EngineerIssue | null = null;
    for (const id of tick.captured) {
      const candidate = await deps.getIssue(id);
      const key = candidate?.payload && typeof candidate.payload === 'object'
        ? (candidate.payload as Record<string, unknown>).watchdogKey
        : undefined;
      if (key === planted.expectedWatchdogKey) { issue = candidate; break; }
    }
    if (!issue) {
      const why =
        `watchdog tick captured ${tick.captured.length} issue(s), none matching ${planted.expectedWatchdogKey} ` +
        `(signals=${tick.signals}, knownOpen=${tick.knownOpen}, declined=${tick.declinedDuplicates})`;
      await store.failed(sql, drillId, why);
      return { ok: false, drillClass: cls.id, drillId, status: 'failed', reason: why };
    }
    const detectedMs = deps.now();
    await store.detected(sql, drillId, {
      detectedAt: new Date(detectedMs).toISOString(),
      detectedWatchdogKey: planted.expectedWatchdogKey,
      detectedKind: issue.kind,
      issueId: issue.id,
    });

    // ── TRIAGE: the real digest → triage path, opted into the drill lane ────
    const candidates = await deps.readItems({
      state: 'open',
      origins: ['drill'],
    });
    const digest = buildDigest(candidates, { nowMs: deps.now() });
    const scored = [...digest.autoEligible, ...digest.humanQueue].find((s) => s.id === issue.id);
    if (!scored) {
      const why = 'captured drill issue missing from the drill-lane digest (triage leg cannot route it)';
      await store.failed(sql, drillId, why);
      return { ok: false, drillClass: cls.id, drillId, status: 'failed', reason: why };
    }
    const decision = triageIdea(scored);
    const applied = await deps.applyTriage({
      id: issue.id,
      decision: decision.decision,
      reason: `red-queen drill triage: ${decision.reason}`,
      target: decision.target,
      by: 'red-queen-sandbox',
      comment: false,
    });
    if (!applied.ok) {
      const why = `triage apply failed: ${applied.error ?? 'unknown'}`;
      await store.failed(sql, drillId, why);
      return { ok: false, drillClass: cls.id, drillId, status: 'failed', reason: why };
    }
    const triagedMs = deps.now();
    await store.triaged(sql, drillId, {
      triagedAt: new Date(triagedMs).toISOString(),
      triagedDecision: decision.decision,
      triagedIdeaType: scored.ideaType,
    });

    // ── FIX: the known remedy + a post-heal re-sweep as the evidence ────────
    await cls.heal(sql, planted);
    const postHeal = await collectAll(cls.collectors(sql, planted, SANDBOX_WORKSPACE_ID));
    const healClean = !postHeal.some((s) => watchdogKeyOf(s) === planted!.expectedWatchdogKey);
    const resolved = await deps.resolve({
      id: issue.id,
      outcome: 'fixed',
      summary: `red-queen drill heal: applied the ${cls.id} class's known remedy in the sandbox`,
      testsRun: `post-heal collector re-sweep over ${SANDBOX_WORKSPACE_ID}: ${healClean ? 'signal cleared' : 'SIGNAL STILL FIRING'}`,
      by: 'red-queen-sandbox',
    });
    if (!resolved.ok || !healClean) {
      const why = !resolved.ok ? `resolve failed: ${resolved.error ?? 'unknown'}` : 'post-heal re-sweep still fires — remedy did not clear the friction';
      await store.failed(sql, drillId, why);
      return { ok: false, drillClass: cls.id, drillId, status: 'failed', reason: why };
    }
    const resolvedMs = deps.now();

    // ── ZERO-LEAK assertion (recorded on the row; a failure is a loud alarm) ─
    const leakCheck = await runLeakCheck(deps, cls, planted, issue.id);

    const mttsh: MttshSegments = {
      detectMs: Math.max(0, detectedMs - plantedMs),
      triageMs: Math.max(0, triagedMs - detectedMs),
      fixMs: Math.max(0, resolvedMs - triagedMs),
      totalMs: Math.max(0, resolvedMs - plantedMs),
    };
    await store.resolved(sql, drillId, {
      resolvedAt: new Date(resolvedMs).toISOString(),
      resolvedWithEvidence: true,
      mttsh,
      leakCheck,
    });
    log(
      `drill ${cls.id} ROUND-TRIPPED: detect ${mttsh.detectMs}ms → triage ${mttsh.triageMs}ms → fix ${mttsh.fixMs}ms ` +
      `(total ${mttsh.totalMs}ms); leak check ${leakCheck.passed ? 'CLEAN' : 'FAILED'}`,
    );
    return { ok: leakCheck.passed, drillClass: cls.id, drillId, status: 'resolved', issueId: issue.id, mttsh, leakCheck };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    if (drillId) await store.failed(sql, drillId, why).catch(() => {});
    log(`drill ${cls.id} FAILED: ${why}`);
    return { ok: false, drillClass: cls.id, drillId, status: 'failed', reason: why };
  } finally {
    if (planted) await cls.cleanup(sql, planted).catch(() => {});
    invalidateVitals();
  }
}

async function collectAll(collectors: WatchdogCollector[]) {
  const out = [];
  for (const c of collectors) {
    const res = await c.collect().catch(() => []);
    out.push(...(Array.isArray(res) ? res : res.signals));
  }
  return out;
}

/** The three-legged zero-leak assertion (see module doc). Never throws. */
export async function runLeakCheck(
  deps: DrillCycleDeps,
  cls: DrillClass,
  planted: NonNullable<Awaited<ReturnType<DrillClass['plant']>>>,
  issueId: string,
): Promise<LeakCheckResult> {
  let organicReadClean = false;
  let liveCollectorClean = false;
  let capturedOriginIsDrill = false;
  const notes: string[] = [];
  try {
    const organic = await deps.readItems({});
    organicReadClean = !organic.some(
      (c) => c.id === issueId || ('watchdogKey' in c && c.watchdogKey === planted.expectedWatchdogKey),
    );
    if (!organicReadClean) notes.push('drill row visible through the ORGANIC read seam');
  } catch (e) {
    notes.push(`organic read leg errored: ${e instanceof Error ? e.message : e}`);
  }
  try {
    const live = await collectAll(cls.collectors(deps.sql, planted, deps.liveWorkspaceId));
    liveCollectorClean = !live.some((s) => watchdogKeyOf(s) === planted.expectedWatchdogKey);
    if (!liveCollectorClean) notes.push('planted artifact visible to a LIVE-workspace collector sweep');
  } catch (e) {
    notes.push(`live collector leg errored: ${e instanceof Error ? e.message : e}`);
  }
  try {
    const issue = await deps.getIssue(issueId);
    capturedOriginIsDrill = issue?.signalOrigin === 'drill';
    if (!capturedOriginIsDrill) notes.push(`captured issue signal_origin is ${issue?.signalOrigin ?? '(null)'} — expected 'drill'`);
  } catch (e) {
    notes.push(`origin leg errored: ${e instanceof Error ? e.message : e}`);
  }
  return {
    passed: organicReadClean && liveCollectorClean && capturedOriginIsDrill,
    organicReadClean,
    liveCollectorClean,
    capturedOriginIsDrill,
    ...(notes.length ? { notes: notes.join('; ') } : {}),
  };
}

export interface RedQueenTickResult {
  status: 'ran' | 'idle';
  drillClass?: string;
  cycle?: DrillCycleResult;
  expired: number;
}

/**
 * One Red Queen cadence tick: expire stale drills, pick the least-recently
 * drilled class (never-drilled first, registry order), run ONE cycle. Bounded
 * by construction — one drill per tick.
 */
export async function runRedQueenTick(
  deps: DrillCycleDeps,
  opts: { classId?: string } = {},
): Promise<RedQueenTickResult> {
  const expired = await deps.store.expireStale(deps.sql, SANDBOX_WORKSPACE_ID, 24).catch(() => 0);
  let cls: DrillClass | undefined;
  if (opts.classId) {
    cls = drillClassById(opts.classId);
    if (!cls) return { status: 'idle', expired };
  } else {
    const recent = await deps.store
      .readOutcomes(deps.sql, { workspaceId: SANDBOX_WORKSPACE_ID, limit: 500 })
      .catch(() => []);
    const lastByClass = new Map<string, string>();
    for (const o of recent) {
      const prev = lastByClass.get(o.drillClass);
      if (!prev || o.plantedAt > prev) lastByClass.set(o.drillClass, o.plantedAt);
    }
    cls = [...DRILL_CLASSES].sort((a, b) => {
      const la = lastByClass.get(a.id) ?? '';
      const lb = lastByClass.get(b.id) ?? '';
      return la === lb ? 0 : la < lb ? -1 : 1;
    })[0];
  }
  if (!cls) return { status: 'idle', expired };
  const cycle = await runDrillCycle(cls, deps);
  return { status: 'ran', drillClass: cls.id, cycle, expired };
}
