/**
 * `system:task-reconcile` — the task-manager reconciler's routine-engine
 * registration (task-manager-no-escape-2026-07-27, P-011).
 *
 * Thin adapter, matching `supervision-reconcile-action.ts`: all the parse/decide
 * logic lives in `../../task-manager/{scan,reconcile,reconcile-tick}.ts` (pure or
 * dependency-injected, no PG/DBOS coupling), and this module only wires
 * production deps — the real /sys + /proc reader, the repo-root foreign
 * signature, and the coord broadcast.
 *
 * REPORT-ONLY for the general population (task-manager D-010), with two narrow
 * enforcement carve-outs. First, since 2026-08-25: the AGENT-SESSION reaper (`./task-manager/reaper`,
 * WI-41607 / plan agent-session-scope-reaper-2026-08-25). D-010's precondition
 * ("classification right for a sustained window") was met by the censuses this
 * file already runs, and the owner directed enforcement twice after the third
 * residue accumulation. The reaper touches ONLY `class='agent-session'` rows,
 * consults `isAutoReapExempt` (terminal-psu-session-enrolment D-001), archives
 * log tails first, is capped per tick, and sits behind the
 * `papercusp-task-reaper` kill-switch flag (default ON, explicit OFF honored).
 * Second, memory-reduction D-010: a prompted agent may record a structured
 * process-lifecycle `kill` verdict, but only this trusted routine may enforce it,
 * through the existing exact task/scope control primitives. Everything else
 * here remains report-only.
 */
import { readlinkSync, statSync } from 'node:fs';

import { createSubPassHealth, registerSystemAction, type SystemActionCtx } from './system-actions';
import { sendMessage } from '../../agent-tools/coordination/messages';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';
import { REPO_ROOT } from '../../agent-tools/docs/_repo-paths';
import { isTaskManagerEnabled } from '../../task-manager/enabled';
import { reconcileTick } from '../../task-manager/reconcile-tick';
import { defaultForeignSignature } from '../../task-manager/scan';
import { gcTerminalTasks, listLiveTasks, listTasks, markStranded, residueTaskId } from '../../task-manager/store';
import {
  consultAnswerFacts,
  consultSettlement,
  decideReaps,
  evaluateReaperFloor,
  executeReaps,
  managedResidueCandidates,
  readScopeHolder,
  REAP_PRESENCE_FRESH_MS,
  residualAfterPass,
  type ConsultStateRow,
  type ReapDecision,
  type ReapEffects,
} from '../../task-manager/reaper';
import type { TaskRow } from '../../task-manager/types';
import type { ResidueGroup } from '../../task-manager/reconcile';
import { absCgroupDir, walkCgroupTree } from '../../task-manager/cgroup-read';
import { scopeCgroupRelPath, taskIdFromScopeUnit } from '../../task-manager/types';
import {
  LIFECYCLE_SWEEP_INTERVAL_MS,
  runLifecycleJudgementSweep,
} from '../../task-manager/lifecycle-judgement';
import {
  censusAgentSessionProgress,
  evaluateAgentSessionResidue,
} from '../../task-manager/agent-session-progress-census';
import { nodeCgroupFs } from '../../task-manager/cgroup-read';
import { nodeResidueLivenessProbe } from '../../task-manager/residue-liveness-probe';
import { collectStaleFailedTaskUnits } from '../../task-manager/failed-unit-collector';
import { sweepA11yBuses } from '../../desktop/a11y-bus-sweep';
import { sweepHost } from '../../desktop/a11y-bus-sweep-io';
import {
  appendResidueSample,
  censusTerminalResidue,
  evaluateResidueTrend,
  isMaintDue,
  resolveTerminalSliceAbs,
} from '../../task-manager/terminal-residue-census';
import {
  readLastCensusAtMs,
  readResidueSamples,
  writeResidueSamples,
} from '../../task-manager/terminal-residue-store';

/** Coord identity for the reconciler's own broadcasts (mirrors SUPERVISION_IDENTITY). */
const TASK_MANAGER_IDENTITY: AgentIdentity = {
  ownerId: 'task-manager',
  ownerLabel: 'task-manager',
  source: 'static-client',
  workspaceId: null,
  userId: null,
};

/** Terminal rows are the "what ran overnight and what did it cost" record. A week
 *  is long enough to answer that and short enough to keep the live index hot. */
const TERMINAL_RETENTION_HOURS = 168;
/** GC is cheap but pointless every 30s — hourly is ample. */
const GC_INTERVAL_MS = 60 * 60_000;
/** The residue census is a trend over DAYS; hourly is ample and keeps the ring small. */
const RESIDUE_INTERVAL_MS = 60 * 60_000;
/** Don't re-broadcast an accumulation report more than once every few hours. */
const RESIDUE_RENOTIFY_MS = 6 * 60 * 60_000;
/** Cap on the per-sample `unclaimedScopes` detail written into the routine row. */
const MAX_REPORTED_UNCLAIMED_SCOPES = 20;
/** The headless-agent progress census rides the same hourly cadence as the window one. */
const PROGRESS_INTERVAL_MS = 60 * 60_000;
const PROGRESS_RENOTIFY_MS = 6 * 60 * 60_000;
/**
 * The a11y session-bus sweep. Hourly is ample: the leak accrues at most one
 * daemon per desktop provision, and every candidate must ALSO be 6h old before
 * the sweep will touch it (see `a11y-bus-sweep`), so a tighter cadence would
 * only re-scan the same untouchable set.
 */
const A11Y_SWEEP_INTERVAL_MS = 60 * 60_000;
/** Candidate filing is cheap but need not refresh condition-keyed work items on
 * every 30-second reconcile. Five minutes stays well below the 15-minute dead-
 * launcher grace; the judge launch itself is independently capped at one/hour. */
let lastLifecycleSweepAtMs: number | null = null;
/**
 * How many quiet agent-sessions before this reports (EI-21268871278252116).
 *
 * NOT zero, deliberately. A single session can be legitimately quiet for hours —
 * one parked on a long `events:await` writes nothing — and an indicator that
 * fires on every straggler gets muted within a day, which is the exact failure
 * D-016 recorded for the window census. What distinguishes residue is
 * ACCUMULATION: the 2026-08-23 incident was 33 scopes / 118 processes, and the
 * measured post-reap baseline was 0 quiet of 90 live. A floor of 5 therefore sits
 * far above observed noise while still catching that incident six times over.
 */
const AGENT_SESSION_QUIET_THRESHOLD = 5;

/**
 * EI-19407950136194410 — WALL-CLOCK watermarks, never tick counts.
 *
 * These two jobs used to be gated on `tickCount % 120` against a module-scoped
 * counter. A counter inside the process resets when the process does, so a host
 * restarting more often than hourly never reached 120 and ran NEITHER job, silently
 * and forever. See `isMaintDue` for the full account; the short version is that the
 * census is the leading indicator for residue that host CHURN creates, so the old
 * gate went blind exactly when it was needed and a restart meant to activate it
 * pushed it out another hour instead.
 *
 * The two jobs need DIFFERENT strategies because they differ in idempotence:
 *
 *  - GC is an idempotent, cheap DELETE with a time predicate. It needs no persisted
 *    watermark at all: `null` means "first tick of this process", which answers DUE,
 *    so a restart makes the GC run SOONER rather than never. Re-running it costs one
 *    near-no-op DELETE.
 *  - The CENSUS is NOT idempotent — every run appends a sample to a multi-week trend
 *    ring, and the trend is a floor comparison across that ring. Sampling on every
 *    restart would let a churning host inflate the ring and skew the very floor the
 *    indicator is built on. So it hydrates the watermark the store ALREADY persists
 *    (`lastCensusAtMs`) once per process, and gates on that.
 */
let lastGcAtMs: number | null = null;
let lastResidueAtMs: number | null = null;
let residueWatermarkHydrated = false;
let lastResidueNotifyAtMs = 0;
/** Own watermark, so a fault in either census can never suppress the other. */
let lastProgressAtMs: number | null = null;
let lastProgressNotifyAtMs = 0;
let lastA11ySweepAtMs: number | null = null;
/** The agent-session reaper's own cadence (WI-41607). 5 minutes: fast enough
 *  that "stop a session" visibly clears the box, slow enough that a wrong
 *  discriminator — already capped per pass — is caught by its own broadcasts
 *  long before it can matter. */
const REAPER_INTERVAL_MS = 5 * 60_000;
let lastReaperAtMs: number | null = null;

/**
 * Fallback collection for failed transient services which lost their immediate
 * close path. Five minutes keeps the systemd listing cheap while the collector's
 * own one-hour evidence window preserves fresh failures for normal provenance.
 */
const FAILED_UNIT_SWEEP_INTERVAL_MS = 5 * 60_000;
let lastFailedUnitSweepAtMs: number | null = null;
/**
 * WI-10005164: the fail-soft sub-passes below catch their own errors so the
 * kernel reconcile always runs. This tracker returns any still-failing one as
 * the routine's `softError` (its `last_error`) on every tick until that
 * sub-pass next succeeds. The lifecycle sweep threw 42703 on every hourly pass
 * for a day while this routine read healthy (WI-10005157).
 */
const subPassHealth = createSubPassHealth();
let failedUnitSweepCursor = 0;

/** Re-notify throttle for the enforcement alarm (P-006). Shorter than the
 *  dead-window census's 6h: that one reports a POPULATION worth watching, this
 *  one reports that enforcement has STOPPED WORKING, which is actionable now. */
const REAPER_FLOOR_RENOTIFY_MS = 60 * 60_000;
let lastReaperFloorNotifyAtMs = 0;

registerSystemAction('task-reconcile', async (ctx: SystemActionCtx) => {
  // WI-6499: the routine stays REGISTERED but no-ops while the task manager is
  // flag-OFF. Gating here rather than at seed time means a flip takes effect on
  // the next 30s tick instead of requiring an operator restart to re-seed.
  if (!(await isTaskManagerEnabled('routine:task-reconcile'))) return;

  const tick = await reconcileTick({
    scanOptions: { foreignSignature: defaultForeignSignature(REPO_ROOT) },
    notify: async ({ summary, kind }) =>
      void (await sendMessage(TASK_MANAGER_IDENTITY, {
        to: ['*'],
        summary,
        category: kind === 'escalation' ? undefined : 'task-manager',
        kind: kind === 'escalation' ? 'escalation' : 'message',
        harnessSlug: ctx.installSlug,
      })),
  });

  const nowMs = Date.now();

  if (isMaintDue({ lastAtMs: lastFailedUnitSweepAtMs, nowMs, intervalMs: FAILED_UNIT_SWEEP_INTERVAL_MS })) {
    // Stamp before awaiting so overlapping ticks cannot race evidence persistence
    // against reset-failed. The collector itself contains per-unit failures and
    // refuses reset unless terminal provenance is already durable.
    lastFailedUnitSweepAtMs = nowMs;
    try {
      const collected = await collectStaleFailedTaskUnits({
        workspaceId: ctx.workspaceId,
        harnessSlug: ctx.installSlug,
        cursor: failedUnitSweepCursor,
      });
      failedUnitSweepCursor = collected.nextCursor;
      if (collected.candidates > 0 || collected.errors > 0 || collected.refused > 0) {
        const summary =
          `[failed-task-unit-collector] listed=${collected.listed} inspected=${collected.inspected} ` +
          `old=${collected.candidates} evidence=${collected.evidenceDurable} reset=${collected.reset} ` +
          `refused=${collected.refused} reset_failed=${collected.resetFailed} errors=${collected.errors}` +
          (collected.truncated ? ' (bounded pass; more remain)' : '');
        if (collected.errors > 0 || collected.refused > 0 || collected.resetFailed > 0) console.warn(summary);
        else console.info(summary);
      }
      subPassHealth.record('failed-task-unit-collector', null);
    } catch (err) {
      // This maintenance pass may preserve a failed unit for the next attempt;
      // it must never suppress the kernel/ledger reconcile that carries it.
      console.warn('[failed-task-unit-collector] sweep failed', err);
      subPassHealth.record('failed-task-unit-collector', err);
    }
  }

  if (isMaintDue({ lastAtMs: lastLifecycleSweepAtMs, nowMs, intervalMs: LIFECYCLE_SWEEP_INTERVAL_MS })) {
    // Stamp before awaiting so overlapping/replayed routine ticks cannot fan out
    // filings. A process restart may run this early; the durable hourly spawn
    // idempotency key still prevents a second judge.
    lastLifecycleSweepAtMs = nowMs;
    try {
      const confirmedResidueTaskIds = [
        ...new Set(
          tick.confirmedUnaccounted.map(
            (group) => (group.scopeUnit && taskIdFromScopeUnit(group.scopeUnit)) || residueTaskId(group.cgroupPath),
          ),
        ),
      ];
      const lifecycle = await runLifecycleJudgementSweep({
        workspaceId: ctx.workspaceId,
        harnessSlug: ctx.installSlug,
        confirmedResidueTaskIds,
        nowMs,
      });
      console.info(
        `[task-lifecycle] pass: ${lifecycle.rowsInspected} ledger row(s), ` +
          `${lifecycle.candidates} candidate(s), ${lifecycle.candidateItems.length} filed/refreshed, ` +
          `${lifecycle.suppressedByKeep} keep-suppressed, ` +
          `${lifecycle.suppressedByVerdict} verdict-suppressed, ${lifecycle.openItems.length} open; ` +
          (lifecycle.judge.attempted
            ? `judge ${lifecycle.judge.ok ? 'admitted' : 'not admitted'}${lifecycle.judge.deduped ? ' (interval dedupe)' : ''}`
            : 'no judge needed'),
      );
      for (const outcome of lifecycle.enforcement) {
        console.info(
          `[task-lifecycle] verdict ${outcome.taskId}=${outcome.decision}: ` +
            `${outcome.settled ? 'settled' : 'not settled'} via ${outcome.target}` +
            `${outcome.targetId ? ` ${outcome.targetId}` : ''}` +
            `${outcome.error ? ` (${outcome.error})` : ''}` +
            `${outcome.detail ? ` — ${outcome.detail}` : ''}`,
        );
      }
      subPassHealth.record('task-lifecycle', null);
    } catch (err) {
      // This judgement layer must never break the kernel reconcile/reaper pass.
      console.warn('[task-lifecycle] sweep failed', err);
      subPassHealth.record('task-lifecycle', err);
    }
  }

  if (isMaintDue({ lastAtMs: lastGcAtMs, nowMs, intervalMs: GC_INTERVAL_MS })) {
    // Stamp BEFORE awaiting: a failed GC must not re-fire every 30s, and the stamp
    // also keeps two overlapping ticks from both entering.
    lastGcAtMs = nowMs;
    await gcTerminalTasks(TERMINAL_RETENTION_HOURS).catch(() => 0);
  }

  const target = { installSlug: ctx.installSlug, workspaceId: ctx.workspaceId };
  if (!residueWatermarkHydrated) {
    // Once per process. A read failure yields null, which reads as DUE — the census
    // erring toward one extra sample beats it going quiet on an unreadable store.
    residueWatermarkHydrated = true;
    lastResidueAtMs = await readLastCensusAtMs(target);
  }
  if (isMaintDue({ lastAtMs: lastResidueAtMs, nowMs, intervalMs: RESIDUE_INTERVAL_MS })) {
    lastResidueAtMs = nowMs;
    // EI-20369673282334981: hand the census the pids this very tick just CONFIRMED
    // alive against the task ledger. `nodeResidueLivenessProbe`'s own contract asks
    // for exactly this ("a caller that already holds the enrolled-task pids (the
    // reconcile tick does) should pass them"), and until now the sole production
    // call site passed nothing — so `knownLive` was `undefined` and listening
    // sockets were the only liveness evidence the census ever had.
    await sampleResidue(ctx, tick.scan.userManagerRoot, aliveEnrolledPids(tick));
  }

  if (isMaintDue({ lastAtMs: lastProgressAtMs, nowMs, intervalMs: PROGRESS_INTERVAL_MS })) {
    lastProgressAtMs = nowMs;
    await reportAgentSessionProgress(ctx);
  }

  if (isMaintDue({ lastAtMs: lastReaperAtMs, nowMs, intervalMs: REAPER_INTERVAL_MS })) {
    lastReaperAtMs = nowMs;
    await reapAgentSessionResidue(ctx, tick.scan.userManagerRoot, tick.confirmedUnaccounted);
  }

  if (isMaintDue({ lastAtMs: lastA11ySweepAtMs, nowMs, intervalMs: A11Y_SWEEP_INTERVAL_MS })) {
    lastA11ySweepAtMs = nowMs;
    // Unlike the two censuses above, this one TERMINATES processes. It is
    // narrowly targeted by construction: only a `dbus-daemon` whose
    // `--config-file` names one of OUR `pc-a11y-*` dirs, only when the X display
    // it was pinned to is gone, and only after a 6h margin. It can therefore
    // never reach an agent session, a fleet member, or the owner's desktop.
    try {
      sweepHost((io) => sweepA11yBuses(io));
      subPassHealth.record('a11y-bus-sweep', null);
    } catch (err) {
      // A sweep failure must never fail the reconcile tick that carries it.
      console.warn('[a11y-bus-sweep] sweep failed', err);
      subPassHealth.record('a11y-bus-sweep', err);
    }
  }

  return subPassHealth.result();
});

/**
 * P-013 / D-017 — the LEADING indicator, sampled alongside the reconcile it cannot
 * be derived from.
 *
 * This deliberately does NOT read `tick.summary.unaccounted`. That number is
 * pinned near 0 for this residue class: the window-liveness probe sits downstream
 * of the scan's repo-root cmdline filter, so most dead-window scopes are never
 * classified at all (measured: 14 dead-window scopes / 59 processes live, while
 * the same reconcile reported `unaccounted: 0` with `degraded: false`). The census
 * walks the scopes itself, which needs no cmdline match.
 *
 * REPORT-ONLY (D-006 / D-010 / D-016). It broadcasts a message; nothing here
 * terminates anything, and 14 of 15 such scopes hold live agent sessions or shared
 * infra, so the wording must stay "a window closed but these kept running".
 *
 * Fail-soft end to end: a census or store failure must never break the reconcile
 * tick it rides alongside.
 */
/**
 * The pids this tick positively matched to a LIVE task-ledger row.
 *
 * Only `result.alive` — never `scannedProcesses`. The scan sees every process in
 * the user manager, so feeding it here would mark essentially the whole box "known
 * live" and turn the census's one remaining discriminator into a constant. What
 * makes this set meaningful is precisely that it is small and earned: a row the
 * reconciler just confirmed against a real process.
 *
 * A pid of 0/NaN is dropped rather than added — pid 0 is not a process, and a set
 * containing it would silently match nothing while looking populated.
 */
function aliveEnrolledPids(tick: { result: { alive: readonly { pid: number | null }[] } }): Set<number> {
  const out = new Set<number>();
  for (const a of tick.result.alive) {
    if (typeof a.pid === 'number' && Number.isFinite(a.pid) && a.pid > 0) out.add(a.pid);
  }
  return out;
}

async function sampleResidue(
  ctx: SystemActionCtx,
  userManagerRoot: string | null,
  knownLivePids: ReadonlySet<number>,
): Promise<void> {
  try {
    const sliceAbs = resolveTerminalSliceAbs(userManagerRoot);
    if (!sliceAbs || !nodeCgroupFs.isDir(sliceAbs)) return;

    // EI-19418147529720290: probe the dead scopes, so what we store and broadcast
    // distinguishes abandoned residue from a live service whose window was closed.
    // Un-probed, "15 dead scopes" reads as 15 things to clean up; measured, it was
    // 1 stale and 13 holding live tenants — and the largest was the staging
    // operator still serving :3170.
    const census = censusTerminalResidue(sliceAbs, nodeCgroupFs, {
      probe: nodeResidueLivenessProbe(knownLivePids),
    });
    const target = { installSlug: ctx.installSlug, workspaceId: ctx.workspaceId };
    const nowMs = Date.now();

    const ring = appendResidueSample(await readResidueSamples(target), {
      atMs: nowMs,
      scopesDead: census.scopesDead,
    });
    const verdict = evaluateResidueTrend(ring, { nowMs });

    await writeResidueSamples(target, ring, {
      lastCensusAtMs: nowMs,
      scopesTotal: census.scopesTotal,
      scopesDead: census.scopesDead,
      deadPids: census.deadPids,
      unprobeable: census.unprobeable,
      deadStale: census.deadStale,
      deadLiveServiceHeld: census.deadLiveServiceHeld,
      deadLiveServiceUnclaimed: census.deadLiveServiceUnclaimed,
      deadIndeterminate: census.deadIndeterminate,
      // EI-20369673282334981 asks for the new bucket's POPULATION to be measured
      // for a few days before anyone proposes acting on it, so persist the members
      // and not just the count — a count cannot tell you afterwards whether the 3
      // it saw were the same 3 every hour (accumulating residue) or 3 different
      // ones (ordinary churn), which is the whole question. Bounded so a pathological
      // host cannot bloat the routine row.
      unclaimedScopes: census.dead
        .filter((d) => d.disposition === 'live-service-unclaimed')
        .slice(0, MAX_REPORTED_UNCLAIMED_SCOPES)
        .map((d) => ({
          scope: d.scope,
          pidCount: d.pidCount,
          oldestPidAgeMs: d.oldestPidAgeMs,
          // Empty means "no PAPERCUSP_SID readable", NOT "no owner" — the majority
          // case on this box. Never render it as unowned.
          owningSessionIds: d.owningSessionIds,
        })),
      trend: verdict.trend,
      floorDelta: verdict.floorDelta,
    });

    if (!verdict.alarm) return;
    if (nowMs - lastResidueNotifyAtMs < RESIDUE_RENOTIFY_MS) return;
    lastResidueNotifyAtMs = nowMs;

    await sendMessage(TASK_MANAGER_IDENTITY, {
      to: ['*'],
      summary:
        `[task-manager] ${verdict.summary} ` +
        `Now ${census.scopesDead} dead-window scope(s) holding ${census.deadPids} process(es), ` +
        `of ${census.scopesTotal} terminal scope(s). ` +
        // The split, not just the total: a reader who acts on `scopesDead` will go
        // looking for things to kill, and most of them are live tenants.
        `Of those, ${census.deadStale} look STALE, ${census.deadLiveServiceHeld} hold a live ` +
        `service or tracked tenant (do not reap), ${census.deadIndeterminate} undecidable` +
        // EI-20369673282334981: the bucket that used to be invisible. Named
        // separately because "listening, old, and claimed by no tracked tenant" is
        // the shape a leaked server has — and also the shape the :3170 staging
        // operator has, which is why the wording asks for a LOOK, never a reap.
        (census.deadLiveServiceUnclaimed > 0
          ? `, and ${census.deadLiveServiceUnclaimed} hold a LISTENING socket that no tracked ` +
            `tenant claims and are past the staleness threshold — worth a look (this is where a ` +
            `leaked server hides), but NOT reapable: shared infra whose launching window closed ` +
            `looks identical from here.`
          : '.'),
      category: 'task-manager',
      kind: 'message',
      harnessSlug: ctx.installSlug,
    });
  } catch {
    /* the leading indicator must never break the reconcile it observes */
  }
}

/**
 * The HEADLESS-agent residue indicator (EI-21268871278252116) — the blind spot
 * `sampleResidue` above cannot cover.
 *
 * That census walks the TERMINAL slice and decides liveness with the window
 * probe, which `scan.ts:218` gates behind `isTerminalWindowScope`. A headless
 * agent session has no window at all, so for this population the probe returns
 * `not-a-window` and the scope can never be observed dead. That is how 118
 * processes across 33 scopes accumulated over ~71h while every liveness surface
 * reported healthy.
 *
 * The discriminator here is log-mtime — direct progress evidence — chosen after
 * three plausible instruments gave confident WRONG answers (cmdline-tail match,
 * window-title token match, and a `coord_presence.pid` join that false-positived
 * on a live fleet member holding 97 processes). It needs no cmdline match, no
 * window, and no presence row, which matters because both root causes
 * (booted-but-never-woken, and the unbounded `psu-pty-host` CR resubmit loop,
 * WI-41044) never reach a first turn and so never declare `coord_presence`.
 *
 * REPORT-ONLY, same as its sibling and for the same reason (D-006 / D-010). A
 * quiet log is strong evidence of a stalled session, not proof of abandonment.
 * The one reap this evidence has authorised was run by hand with every log tail
 * preserved first.
 *
 * Fail-soft: an indicator must never break the reconcile it rides alongside.
 */
async function reportAgentSessionProgress(ctx: SystemActionCtx): Promise<void> {
  try {
    const rows = await listLiveTasks(ctx.workspaceId ?? undefined);
    const census = censusAgentSessionProgress(rows, {
      // MUST return null (never 0) when unreadable — `censusAgentSessionProgress`
      // counts that as `unreadable`, never as quiet. Collapsing the two is the
      // false-absence trap this whole module exists to avoid.
      statMtimeMs: (path) => {
        try {
          return statSync(path).mtimeMs;
        } catch {
          return null;
        }
      },
    });

    const verdict = evaluateAgentSessionResidue(census, AGENT_SESSION_QUIET_THRESHOLD);
    if (verdict.verdict === 'ok') return;

    const nowMs = Date.now();
    if (nowMs - lastProgressNotifyAtMs < PROGRESS_RENOTIFY_MS) return;
    lastProgressNotifyAtMs = nowMs;

    await sendMessage(TASK_MANAGER_IDENTITY, {
      to: ['*'],
      summary:
        `[task-manager] headless agent-session residue: ${verdict.summary} ` +
        `(${census.active} active, ${census.quiet} quiet, ${census.tooYoung} too young, ` +
        `${census.noLog} no-log, ${census.unreadable} unreadable of ${census.measured} live). ` +
        `These sessions hold a full agent process subtree and, if they never took a first ` +
        `turn, declare no coord_presence — so they are invisible to fleet/presence/reaper. ` +
        `REPORT ONLY: preserve each log tail before any reap, and never kill by pattern ` +
        `(processes:kill { taskId }).`,
      // 'unknown' means the instrument failed, which is an escalation: a census
      // that cannot measure must not read as a quiet, healthy box.
      category: verdict.verdict === 'unknown' ? undefined : 'task-manager',
      kind: verdict.verdict === 'unknown' ? 'escalation' : 'message',
      harnessSlug: ctx.installSlug,
    });
  } catch {
    /* the indicator must never break the reconcile it observes */
  }
}

/**
 * The `consult_state` rows that the LIVE consult answering sessions serve
 * (EI-24106882795589775), for the reaper's consult-settled class.
 *
 * `[]` when no live row is a consult answering session (nothing to read);
 * `null` when the read FAILS, which switches the class off for the tick rather
 * than letting an unreadable consult table read as "settled".
 *
 * Tagged rows are matched by conversation id. Legacy rows (written before the
 * `consultAnswer` tag) are matched by answering owner inside the consult's
 * `routing.selection.selected`, bounded to recent consults; `consultSettlement`
 * decides whether such a match is unambiguous enough to act on.
 */
async function readConsultStatesForReaper(
  live: readonly TaskRow[],
): Promise<(ConsultStateRow & { workspaceId: string })[] | null> {
  const consultRows = live.flatMap((row) => {
    const facts = consultAnswerFacts(row);
    return facts ? [{ row, facts }] : [];
  });
  if (consultRows.length === 0) return [];
  const workspaceIds = [...new Set(consultRows.map((x) => x.row.workspaceId))];
  const conversationIds = [
    ...new Set(consultRows.flatMap((x) => (x.facts.conversationId ? [x.facts.conversationId] : []))),
  ];
  const legacyOwnerIds = [
    ...new Set(
      consultRows.flatMap((x) =>
        !x.facts.conversationId && x.facts.answeringOwnerId ? [x.facts.answeringOwnerId] : [],
      ),
    ),
  ];
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const sql = getOrgPg().sql;
    const rows = await sql<
      {
        workspace_id: string;
        conversation_id: string;
        state: string;
        closed_at: Date | null;
        updated_at: Date | null;
        cascade_cursor: number | null;
        selected: unknown;
        responses: { authorId: string; kind: string; at: string | null }[] | null;
      }[]
    >`
      SELECT cs.workspace_id, cs.conversation_id, cs.state, cs.closed_at, cs.updated_at,
             cs.cascade_cursor, cs.routing #> '{selection,selected}' AS selected,
             (SELECT jsonb_agg(
                       jsonb_build_object('authorId', pm.author_id, 'kind', pm.kind, 'at', pm.created_at)
                       ORDER BY pm.created_at, pm.post_id)
                FROM harness_shared.consult_post_meta pm
               WHERE pm.workspace_id = cs.workspace_id
                 AND pm.conversation_id = cs.conversation_id
                 AND pm.kind IN ('answer', 'decline')) AS responses
        FROM harness_shared.consult_state cs
       WHERE cs.workspace_id = ANY(${workspaceIds}::text[])
         AND (
           cs.conversation_id = ANY(${conversationIds}::text[])
           OR (
             cardinality(${legacyOwnerIds}::text[]) > 0
             AND cs.created_at > now() - interval '30 days'
             AND EXISTS (
               SELECT 1
                 FROM jsonb_array_elements(
                        CASE WHEN jsonb_typeof(cs.routing #> '{selection,selected}') = 'array'
                             THEN cs.routing #> '{selection,selected}'
                             ELSE '[]'::jsonb END
                      ) sel
                WHERE sel->>'answeringOwnerId' = ANY(${legacyOwnerIds}::text[])
             )
           )
         )`;
    const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
    return rows.map((r) => ({
      workspaceId: r.workspace_id,
      conversationId: r.conversation_id,
      state: r.state,
      closedAt: iso(r.closed_at),
      updatedAt: iso(r.updated_at),
      cascadeCursor: r.cascade_cursor,
      selected: r.selected,
      responses: (r.responses ?? []).flatMap((p) =>
        typeof p?.authorId === 'string' && p.authorId
          ? [{ authorId: p.authorId, kind: String(p.kind), at: p.at == null ? null : String(p.at) }]
          : [],
      ),
    }));
  } catch (err) {
    console.warn(
      `[task-reaper] consult_state unreadable — consult-settled class off this pass: ${(err as Error)?.message ?? err}`,
    );
    return null;
  }
}

/**
 * The agent-session RESIDUE REAPER (WI-41607) — the enforcement pass.
 *
 * Decision logic is pure and lives in `../../task-manager/reaper` with its own
 * falsifiability suite; this function only assembles real inputs (ledger rows,
 * the log-mtime census, live cgroup pid counts, fresh presence heartbeats) and
 * wires real effects (tail archive → `systemctl --user stop` → ledger close).
 *
 * Fail-SAFE biases, distinct from the fail-open flag read:
 *   - presence unreadable ⇒ the quiet-zombie class is disabled for the tick
 *     (a missing safety input must never widen the kill set);
 *   - every pass that reaps anything broadcasts what it reaped and why, so a
 *     wrong discriminator is loud within one pass, not after a weekend.
 */
async function reapAgentSessionResidue(
  ctx: SystemActionCtx,
  userManagerRoot: string | null,
  confirmedResidue: readonly ResidueGroup[] = [],
): Promise<void> {
  try {
    const { FLAGS } = await import('@papercusp/flags');
    const { getFlag } = await import('@papercusp/flags/server');
    // Kill-switch: default ON (the subsystem is shipped); an explicit OFF is
    // always honored, matching the task-manager flag's own bias.
    const on = await getFlag(FLAGS.TASK_REAPER, 'task-reaper').catch(() => true);
    if (!on) return;

    const workspaceId = ctx.workspaceId ?? undefined;
    const live = (await listLiveTasks(workspaceId)).filter((r) => r.class === 'agent-session');
    const dayAgoMs = Date.now() - 24 * 3600_000;
    const terminal = (
      await listTasks({
        workspaceId,
        classes: ['agent-session'],
        states: ['exited', 'killed', 'timed_out', 'stranded', 'ended_unobserved'],
        includeEnded: true,
        limit: 500,
      })
    ).filter((r) => r.scopeUnit && r.endedAt && Date.parse(r.endedAt) > dayAgoMs);

    const statMtimeMs = (path: string): number | null => {
      try {
        return statSync(path).mtimeMs;
      } catch {
        return null;
      }
    };
    const census = censusAgentSessionProgress(live, { statMtimeMs });
    const managedResidue = managedResidueCandidates(confirmedResidue).map((candidate) => ({
      ...candidate,
      logPath: fileBackedStdoutLogPath(candidate.pids),
    }));

    const scopePidCountForUnit = (scopeUnit: string): number | null => {
      const abs = absCgroupDir(scopeCgroupRelPath(userManagerRoot, 'agent-session', scopeUnit));
      if (!nodeCgroupFs.isDir(abs)) return 0; // scope absent — a real zero
      return walkCgroupTree(abs, nodeCgroupFs).reduce((s, g) => s + g.pids.length, 0);
    };

    // Presence heartbeats vouch for quiet-but-alive owners. Unreadable presence
    // must DISABLE the quiet class, never silently widen it.
    let freshOwners: ReadonlySet<string> | null = null;
    try {
      const { getOrgPg } = await import('@papercusp/db-org');
      const sql = getOrgPg().sql;
      const rows = await sql<{ owner_id: string }[]>`
        SELECT owner_id FROM harness_shared.coord_presence
         WHERE heartbeat_at > now() - (${REAP_PRESENCE_FRESH_MS} * interval '1 millisecond')`;
      freshOwners = new Set(rows.map((r) => r.owner_id));
    } catch {
      freshOwners = null;
    }

    // EI-24106882795589775: the consult each live answering session serves, so a
    // settled consult's session is stopped within a tick instead of idling on its
    // pty for days. Unreadable ⇒ the consult-settled class is simply off this tick
    // (the quiet-zombie backstop still applies); it never widens the kill set.
    const consultStates = await readConsultStatesForReaper(live);

    const verdict = decideReaps({
      rows: [...live, ...terminal],
      managedResidue,
      census:
        freshOwners === null
          ? { ...census, degraded: true, degradedReason: 'coord_presence unreadable — quiet class disabled' }
          : census,
      scopePidCount: (row) => {
        // Resolved from scopeUnit, NOT row.cgroupPath — see the contract on
        // ReaperInputs.scopePidCount. The ledger's cgroup_path is the cgroup seen
        // at enrolment and is stale for ~30% of rows (it names the spawner's own
        // service), which is what made an earlier pass count the operator's
        // processes as survivors.
        if (!row.scopeUnit) return null;
        return scopePidCountForUnit(row.scopeUnit);
      },
      scopePidCountForScope: scopePidCountForUnit,
      // A no-row scope whose spawner is still alive belongs to that spawner, which
      // is how an isolated store's operator looks from here (readScopeHolder).
      scopeHolderForScope: (scopeUnit) => {
        const abs = absCgroupDir(scopeCgroupRelPath(userManagerRoot, 'agent-session', scopeUnit));
        const pids = walkCgroupTree(abs, nodeCgroupFs).flatMap((g) => g.pids);
        return readScopeHolder(scopeUnit, pids);
      },
      freshOwners: freshOwners ?? new Set(),
      logQuietForMs: (row) => {
        const p = row.logPath?.trim();
        if (!p) return null;
        const m = statMtimeMs(p);
        return m === null ? null : Date.now() - m;
      },
      ...(consultStates
        ? {
            consultSettlementFor: (_row: TaskRow, facts: Parameters<typeof consultSettlement>[0]) =>
              consultSettlement(
                facts,
                consultStates.filter((c) => c.workspaceId === _row.workspaceId),
              ),
          }
        : {}),
      now: Date.now(),
    });

    // A pass ALWAYS records a sample — the zero-candidate case included. Two
    // reasons, both learned from this subsystem's own failures:
    //   1. Zero is the HEALTHY reading, and a floor is meaningless without it. An
    //      indicator that only samples non-zero ticks cannot distinguish "clear"
    //      from "switched off", which is how report-only eras stay quiet.
    //   2. Until now this function returned here with no trace whatsoever, so
    //      "no candidates" and "not wired at all" produced byte-identical
    //      evidence — nothing. Telling those apart cost a full diagnostic
    //      round-trip on 2026-08-25 against a subsystem whose entire purpose is
    //      to be verifiable.
    const reaperTarget = { installSlug: ctx.installSlug, workspaceId: ctx.workspaceId };
    const passAtMs = Date.now();
    const outcomes =
      verdict.reap.length > 0 ? await executeReaps(verdict.reap, nodeReapEffects()) : [];
    const okCount = outcomes.filter((o) => o.ok).length;
    const failed = outcomes.filter((o) => !o.ok);
    // Failed stops only — NOT deferred. A pass that deferred work past the
    // per-tick cap is rate-limited, not stuck, and counting deferral here made a
    // healthy backlog drain fire the alarm on its third pass. See the contract
    // on residualAfterPass.
    const residual = residualAfterPass(outcomes);

    const floorRing = appendResidueSample(await readResidueSamples(reaperTarget, 'reaper_floor'), {
      atMs: passAtMs,
      scopesDead: residual,
    });
    const floor = evaluateReaperFloor(floorRing, {});
    await writeResidueSamples(
      reaperTarget,
      floorRing,
      {
        lastPassAtMs: passAtMs,
        candidates: verdict.reap.length,
        reaped: okCount,
        failed: failed.length,
        deferred: verdict.deferred,
        spared: verdict.spared.length,
        quietClassDisabled: verdict.quietClassDisabled,
        residual,
        floorKind: floor.kind,
        floorSummary: floor.summary,
      },
      'reaper_floor',
    );

    // The per-tick heartbeat. Cheap, and it is the difference between a reaper
    // that is provably running and one that is merely not complaining.
    console.info(
      `[task-reaper] pass: ${verdict.reap.length} candidate(s), ${okCount} reaped, ` +
        `${failed.length} failed, ${verdict.deferred} deferred, ${verdict.spared.length} spared, ` +
        `residual=${residual}${verdict.quietClassDisabled ? ', quiet class DISABLED' : ''}`,
    );

    if (floor.alarm && passAtMs - lastReaperFloorNotifyAtMs >= REAPER_FLOOR_RENOTIFY_MS) {
      lastReaperFloorNotifyAtMs = passAtMs;
      // ESCALATION, not a message: the report-only era proved that a `message`
      // about accumulating residue is read as weather and actioned by no one.
      await sendMessage(TASK_MANAGER_IDENTITY, {
        to: ['*'],
        summary:
          `[task-reaper] ⚠ ENFORCEMENT ALARM (${floor.kind}): ${floor.summary}. ` +
          `This pass: ${verdict.reap.length} candidate(s), ${okCount} reaped, ${failed.length} failed, ` +
          `${verdict.deferred} deferred (residual ${residual}). ` +
          `The reaper is no longer clearing what it selects — inspect ` +
          `harness_shared.routines.metadata->'reaper_floor' and the [task-reaper] pass lines.`,
        category: 'task-manager',
        kind: 'escalation',
        harnessSlug: ctx.installSlug,
      });
    }

    if (outcomes.length === 0) return;

    await sendMessage(TASK_MANAGER_IDENTITY, {
      to: ['*'],
      summary:
        `[task-reaper] reaped ${okCount}/${outcomes.length} agent-session scope(s) ` +
        `(${verdict.reap.filter((r) => r.kind === 'terminal-residue').length} terminal-residue, ` +
        `${verdict.reap.filter((r) => r.kind === 'managed-residue').length} managed-residue, ` +
        `${verdict.reap.filter((r) => r.kind === 'consult-settled').length} consult-settled, ` +
        `${verdict.reap.filter((r) => r.kind === 'quiet-zombie').length} quiet-zombie` +
        `${verdict.deferred > 0 ? `; ${verdict.deferred} deferred to next pass` : ''}` +
        `${verdict.quietClassDisabled ? '; quiet class DISABLED this pass (census degraded)' : ''}). ` +
        `Log tails archived under ~/.papercusp/reap-archive/. ` +
        outcomes
          .slice(0, 6)
          .map((o) => `${o.ok ? '✓' : '✗'} ${o.taskId} (${o.kind})`)
          .join(' · ') +
        (failed.length > 0 ? ` — ${failed.length} FAILED: ${failed.map((f) => f.taskId).join(',')}` : ''),
      category: 'task-manager',
      kind: failed.length > 0 ? 'escalation' : 'message',
      harnessSlug: ctx.installSlug,
    });
  } catch (err) {
    // Enforcement must never break the reconcile tick that carries it.
    console.warn('[task-reaper] pass failed', err);
  }
}

/**
 * Recover a file-backed stdout/stderr path from a surviving scope when the
 * ledger row never made it to disk. Pipes, sockets, devices, and deleted files
 * are intentionally not returned: archiveTail must never be handed an
 * unverified path, and a missing path is safer than archiving the wrong file.
 */
function fileBackedStdoutLogPath(pids: readonly number[]): string | null {
  for (const pid of pids) {
    for (const fd of [1, 2]) {
      let target: string;
      try {
        target = readlinkSync(`/proc/${pid}/fd/${fd}`);
      } catch {
        continue;
      }
      if (!target.startsWith('/') || target.endsWith(' (deleted)')) continue;
      try {
        if (statSync(target).isFile()) return target;
      } catch {
        // The process can close its fd between readlink and stat; keep probing.
      }
    }
  }
  return null;
}

/** Real-IO effects for the reaper: tail archive, addressable subtree stop, ledger close. */
function nodeReapEffects(): ReapEffects {
  return {
    async archiveTail(d: ReapDecision): Promise<string | null> {
      if (!d.logPath) return null;
      const { mkdir, open, writeFile } = await import('node:fs/promises');
      const { homedir } = await import('node:os');
      const { join } = await import('node:path');
      const dir = join(homedir(), '.papercusp', 'reap-archive', new Date().toISOString().slice(0, 10));
      await mkdir(dir, { recursive: true });
      const dest = join(dir, `${d.taskId}.tail.log`);
      const fh = await open(d.logPath, 'r');
      try {
        const { size } = await fh.stat();
        const len = Math.min(size, 128 * 1024);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, size - len);
        await writeFile(dest, buf);
      } finally {
        await fh.close();
      }
      return dest;
    },
    async stopUnit(scopeUnit: string): Promise<boolean> {
      const { execFile } = await import('node:child_process');
      // Reject with the real stderr on failure so the outcome's `note` — and the
      // broadcast — carries WHY (the first live pass's bare ✗s cost a diagnosis
      // round-trip that this line would have answered).
      return await new Promise<boolean>((resolve, reject) => {
        execFile('systemctl', ['--user', 'stop', scopeUnit], { timeout: 20_000 }, (err, _stdout, stderr) => {
          if (err) reject(new Error(`systemctl stop ${scopeUnit}: ${String(stderr || err.message).slice(0, 160)}`));
          else resolve(true);
        });
      });
    },
    async closeAsReaped(taskId: string, why: string): Promise<void> {
      await markStranded([{ taskId, reason: `reaped: ${why}` }]);
    },
  };
}
