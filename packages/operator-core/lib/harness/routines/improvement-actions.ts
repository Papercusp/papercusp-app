/**
 * Self-improvement-loop system actions (papercusp-self-improvement-loop-2026-06-04,
 * Phase 2 + Phase 3; close-the-self-improvement-loop-2026-06-05 D-001/D-003).
 * Two routines, registered here so the routines engine can fire them; both
 * SEEDED INACTIVE (seed-improvement-routines.ts). (The former `improvement-digest`
 * routine was REMOVED — operator-learning-tab-2026-06-09 D-001: its only job was
 * pushing the triage headline to the human inbox, a dead-end notification. The
 * backlog is now PULLED in the Learning tab; see the note above the watchdog.)
 *
 *   - `system:improvement-watchdog` (close-loop D-003) — the HARD feed-in: sweep
 *     the operator's own telemetry (red tests, failing smokes, repeated tool
 *     errors, down services) and auto-capture each as a kind=bug improvement via
 *     the shared capture core (search-first dedup, per-tick cap). Capture only —
 *     builds nothing.
 *
 *   - `system:improvement-implement` (Phase 3) — the AUTO-implement loop, gated by
 *     the `papercusp-improvement-auto-implement` flag (default OFF). When OFF it
 *     no-ops (just reports the waiting count). When ON it dispatches up to a cap of
 *     auto-eligible bugs (D-004) to a DEDICATED runner harness (D-006) — never
 *     in-process — which lands them via the release gate (D-008) + the
 *     release-manager (D-005). The decision is the pure `planImplementRun`; this
 *     handler is thin glue + the dispatch. Each dispatch CLAIMS the item + bumps
 *     its attempt counter, and the worker closes the loop with
 *     `improvements:resolve` (close-loop D-001) — so a fixed bug leaves the queue
 *     and nothing double-dispatches.
 *
 * Runs as ONE durable step (the system-actions contract) — safe to re-run from the
 * top: the digest is a pure read; implement claims each item BEFORE firing
 * (close-the-self-improvement-loop-2026-06-05 D-001), so a re-run sees it
 * in-flight and skips it — no double dispatch. The loop CLOSES through the
 * `improvements:resolve` back-edge the worker calls on a verified fix.
 */

import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { registerSystemAction, type SystemActionCtx, type SystemActionResult } from './system-actions';
import { buildLaunchSpawnRequest } from '../../blueprint/launch-blueprint';
import type { DurableSpawnFireInput } from '../../dbos/durable-spawn';
import { readImprovementItems } from '../improvements/read-items';
import { planImplementRun } from '../improvements/plan-implement';
import { readAutoImplementPolicy } from '../../auto-implement-policy';
import { isShuttingDown } from '../../shutdown-state';
import { readOwnerFullAutonomyGrant } from '../improvements/full-autonomy-grant';
import { readRecentDispatches, recordDispatchFired, recordFireResult } from '../improvements/dispatch-ledger';
import { laneInEnvOutage } from '../improvements/orphaned-dispatch';
import { claimIssue, mergeIssuePayload } from '../../issues-engineer';
import { routeExhaustedImprovementToLeaderTriage } from '../improvements/resolve-core';
import { runWatchdogTick, watchdogOptionsFromPayload } from '../improvements/watchdog';
import { runDecaySweep } from '../improvements/decay';
import { runHygieneSweep } from '../improvements/hygiene';
import { runRecurrenceEscalation } from '../improvements/recurrence-escalation';
import { buildDigest, type ScoredItem } from '../improvements/digest';
import { triageIdea } from '../improvements/triage';
import { applyTriageDecision, selectUntriaged, type ApplyTriageInput, type ApplyTriageResult } from '../improvements/triage-core';
import { runInvalidArgsMinerTick } from '../improvements/invalid-args-miner';
import { runToolRejectionMinerTick } from '../improvements/tool-rejection-miner';
import { runCorrectionDecayMinerTick } from '../improvements/correction-decay-miner';
import { LEARNING_MODEL_SPEC } from '../../learning/model-policy';

/** The claim identity the dispatch stamps on an in-flight item (close-loop D-001). */
export const IMPROVEMENT_RUNNER_ASSIGNEE = 'improvement-runner';

/**
 * P-005 (infra round-4): is the auto-implement loop configured to STOP claiming
 * new dispatches while this process is draining (SIGTERM/deploy)? Default-OFF —
 * armed only by PAPERCUSP_IMPROVEMENT_DRAIN_STOPS_CLAIMS=1|true|on. Off ⇒ the
 * guard is byte-inert (the loop behaves exactly as it did before this landed), so
 * it ships safe and is flipped on alongside the lane re-arm — the codebase's
 * default-off-until-validated pattern (PAPERCUSP_SIGTERM_DRAIN,
 * PAPERCUSP_LAG_SELF_RESTART, PAPERCUSP_CLUSTER_LAG_WATCHDOG). Pure (env
 * injectable) so it is unit-tested without the flag system.
 */
export function drainStopsImprovementClaims(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.PAPERCUSP_IMPROVEMENT_DRAIN_STOPS_CLAIMS ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/**
 * P-005: the wired guard — true iff the drain-stop is ARMED *and* this process is
 * draining. Pure + injectable (draining/env) so it is unit-tested without PG, the
 * flag system, or a real signal; in production both default to live process state
 * (env + the shutdown-state flag the SIGTERM handlers set via markShuttingDown()).
 */
export function shouldStopClaimingForDrain(
  opts: { draining?: boolean; env?: NodeJS.ProcessEnv } = {},
): boolean {
  const draining = opts.draining ?? isShuttingDown();
  return drainStopsImprovementClaims(opts.env) && draining;
}

/**
 * Parse a non-negative integer env var, HONORING an explicit `0` (watchdog-robustness
 * P-005 / D-005). Returns `fallback` only when the var is unset/blank/non-numeric
 * (warning on a non-numeric value), then clamps to `min` (default 0). Replaces the
 * `Number(process.env.X ?? d) || d` idiom, which silently mapped an explicit `0`
 * (a legitimate "disable") AND any typo to the default.
 */
export function intFromEnv(name: string, fallback: number, opts: { min?: number } = {}): number {
  const min = opts.min ?? 0;
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return Math.max(min, fallback);
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n) || String(n) !== raw.trim()) {
    console.warn(`[improvement-routines] ${name}="${raw}" is not an integer — using ${fallback}`);
    return Math.max(min, fallback);
  }
  return Math.max(min, n);
}

// The scheduled `improvement-digest` action was REMOVED (operator-learning-tab-2026-06-09
// D-001): its only job was pushing the triage headline to the human inbox, which
// rendered as a dead-end notification (web /coord row + zellij TUI bell, neither
// clickable, no improvements UI to open). The backlog is now surfaced by PULL in the
// Learning tab (`learning.improvements` sync resolver → the same readImprovementItems
// + buildDigest path the `improvements:digest` tool uses). The watchdog below still
// auto-files objective signals into the backlog silently.

// ── close-loop D-003: the watchdog hard feed-in (capture only) ───────────────
registerSystemAction('improvement-watchdog', async (ctx: SystemActionCtx) => {
  // Audit P-012: collector bars + caps tune from the routine's payload_template
  // (no deploy needed); the env var stays the emergency override for maxPerTick.
  const tuned = watchdogOptionsFromPayload(ctx.payloadTemplate);
  const maxPerTick = intFromEnv(
    'PAPERCUSP_IMPROVEMENT_WATCHDOG_MAX_PER_TICK',
    typeof tuned.maxPerTick === 'number' ? tuned.maxPerTick : 3,
    { min: 0 },
  );
  const result = await runWatchdogTick(ctx.workspaceId, { ...tuned, maxPerTick, installSlug: ctx.installSlug });
  if (result.status === 'skipped') {
    console.log('[improvement-watchdog] tick skipped — another host held the cross-host lock');
    return;
  }
  const failed = result.collectors.filter((c) => !c.ok).map((c) => c.name);
  console.log(
    `[improvement-watchdog] ${result.signals} signal(s) → captured ${result.captured.length}` +
      (result.captured.length ? ` (${result.captured.join(', ')})` : '') +
      `, ${result.knownOpen} known-open pre-filtered, ${result.staleResolved} stale-resolved pre-filtered` +
      `, ${result.declinedDuplicates} duplicate(s) declined, ${result.deferred} deferred by the per-tick cap` +
      (failed.length ? `, ${failed.length} collector(s) FAILED: ${failed.join(', ')}` : '') +
      (result.selfEscalations.length ? `, self-escalated ${result.selfEscalations.join(', ')}` : ''),
  );

  // Recurrence-decay verification rides the same cadence (P-013 of
  // learning-system-audit-improvements-2026-06-09): grade resolved+applied items
  // verified/recurred from post-resolution signature recurrence. Best-effort —
  // a sweep failure must never fail the capture tick.
  try {
    const decay = await runDecaySweep();
    if (decay.verified || decay.recurred || decay.initialized) {
      console.log(
        `[improvement-watchdog] decay sweep: ${decay.verified} verified, ${decay.recurred} recurred, ` +
          `${decay.initialized} legacy item(s) retro-entered the pipeline (scanned ${decay.scanned})`,
      );
    }
  } catch (e) {
    console.warn('[improvement-watchdog] decay sweep failed:', e instanceof Error ? e.message : e);
  }

  // NOTE: the observation-lane retention prune that used to ride this cadence
  // (turn-end-reflection-observations-2026-06-14 P-045) was REMOVED 2026-08-09 —
  // it hard-deleted observations past a 30d window, which the owner rejected
  // outright (learning-loop-identity-and-consumption-2026-08-08 D-001: "why would
  // we ever want to throw out observations?"; D-005: observations are a time
  // series). Nothing prunes this lane now, and nothing should: growth is bounded
  // by CONSUMPTION marking (observation-consumption.ts), and any future bound is
  // archive/rollup over consumed rows only. Do not re-add a delete here.
});

// ── P-011 (learning-system-audit): the scheduled triage pass ─────────────────
// The deterministic type-route (triageIdea: product→place, process→gate) applied
// on a cadence and PERSISTED, so every open idea carries a provisional routing
// lane instead of waiting for a Queen turn that never came. Decisions are
// re-takeable: the Queen/owner can re-triage any item via improvements:triage
// (triaged→triaged is a valid transition). The scheduled pass never rejects and
// never dispatches — it only records routing metadata.

/** The apply seam — injectable for tests (mirrors the implement fire seam). */
export type TriageApplyFn = (input: ApplyTriageInput) => Promise<ApplyTriageResult>;

let _applyTriage: TriageApplyFn | null = null;
/** Override the triage persistence (tests). Pass null to restore the default. */
export function setImprovementTriageApply(fn: TriageApplyFn | null): void {
  _applyTriage = fn;
}

registerSystemAction('improvement-triage', async (_ctx: SystemActionCtx) => {
  const maxPerRun = intFromEnv('PAPERCUSP_IMPROVEMENT_TRIAGE_MAX_PER_RUN', 25, { min: 0 });
  const items = await readImprovementItems({ state: 'open' });
  const digest = buildDigest(items);
  const batch = selectUntriaged(digest.autoEligible.concat(digest.humanQueue), maxPerRun);
  if (batch.length === 0) {
    console.log('[improvement-triage] nothing untriaged — backlog fully routed');
    return;
  }
  const apply = _applyTriage ?? applyTriageDecision;
  let applied = 0;
  const byDecision: Record<string, number> = {};
  for (const item of batch) {
    const triage = triageIdea(item);
    const res = await apply({
      id: item.id,
      decision: triage.decision,
      reason: triage.reason,
      by: 'improvement-triage',
      comment: false, // batch pass — no per-item thread spam; the lifecycle carries the decision
    });
    if (res.ok) {
      applied += 1;
      byDecision[triage.decision] = (byDecision[triage.decision] ?? 0) + 1;
    }
  }
  console.log(
    `[improvement-triage] routed ${applied}/${batch.length} untriaged item(s): ` +
      Object.entries(byDecision)
        .map(([d, n]) => `${d}=${n}`)
        .join(', '),
  );

  // Hygiene rides the triage cadence (P-014): dup-cluster closes + stale-minor
  // age-outs, small recurring cap (the one-time backlog cut runs separately).
  // Best-effort — hygiene failure must never fail the triage pass.
  try {
    const hygieneCap = intFromEnv('PAPERCUSP_IMPROVEMENT_HYGIENE_MAX_PER_RUN', 10, { min: 0 });
    const hygiene = await runHygieneSweep({ maxActions: hygieneCap });
    if (hygiene.planned.length > 0) {
      console.log(
        `[improvement-triage] hygiene: ${hygiene.dupClosed} dup-closed, ${hygiene.agedOut} aged out` +
          (hygiene.failed.length > 0 ? `, ${hygiene.failed.length} no-op (row not locally writable)` : '') +
          ` (scanned ${hygiene.scanned})`,
      );
    }
    // WI-7034: a no-op write (remote-origin row, EI-7833/migration 521) used to
    // be silently miscounted as closed and left a misleading "duplicate of X" comment on an
    // item that stayed open forever. Surface it loudly so it doesn't go unnoticed again.
    if (hygiene.failed.length > 0) {
      console.warn(
        `[improvement-triage] hygiene: ${hygiene.failed.length} item(s) could not actually be closed locally — ` +
          hygiene.failed.map((f) => `${f.id} (${f.reason})`).join(', '),
      );
    }
  } catch (e) {
    console.warn('[improvement-triage] hygiene sweep failed:', e instanceof Error ? e.message : e);
  }

  // Recurrence escalation (P-053 + P-052 lite): ≥3× signatures escalate severity /
  // route process-class to the gym / propose cross-scope lesson promotion.
  // Best-effort — never fails the triage pass.
  try {
    const esc = await runRecurrenceEscalation();
    if (esc.escalated || esc.gymRouted || esc.promotionsSuggested) {
      console.log(
        `[improvement-triage] recurrence escalation: ${esc.escalated} severity-escalated, ` +
          `${esc.gymRouted} routed to gym, ${esc.promotionsSuggested} lesson-promotion(s) proposed`,
      );
    }
  } catch (e) {
    console.warn('[improvement-triage] recurrence escalation failed:', e instanceof Error ? e.message : e);
  }

  // Fleet-lesson candidate auto-adopt (WI-5414 — owner reversal of the
  // owner-gate contract, 2026-07-19): every PENDING knowledge-pack candidate
  // (staged above or on an earlier tick) gets the automated review, then
  // auto-adopts/auto-dismisses via the machine identity — no human gate.
  // Best-effort — never fails the triage pass; a candidate whose decide()
  // itself fails (e.g. the transfer bar) just stays pending for the next tick.
  try {
    const autoAdoptCap = intFromEnv('PAPERCUSP_KNOWLEDGE_CANDIDATE_AUTO_ADOPT_MAX_PER_RUN', 10, { min: 0 });
    const { autoAdoptPendingCandidates } = await import('../../knowledge-packs/candidates');
    const auto = await autoAdoptPendingCandidates({ maxPerRun: autoAdoptCap });
    if (auto.reviewed > 0) {
      console.log(
        `[improvement-triage] fleet-lesson candidate auto-adopt: reviewed ${auto.reviewed}, ` +
          `adopted ${auto.adopted}, dismissed ${auto.dismissed}, ${auto.failed} still pending`,
      );
    }
  } catch (e) {
    console.warn('[improvement-triage] fleet-lesson candidate auto-adopt failed:', e instanceof Error ? e.message : e);
  }
});

// ── WI-5017: the weekly invalid-args miner (capture only) ────────────────────
// Mines harness_shared.tool_invocations invalid-input rows into (tool, offending
// key) aggregates and files a recurring pattern as a kind=change improvement —
// see invalid-args-miner.ts for the full rationale. Weekly cadence (not the
// 15-min watchdog tick): the signal is a slow-accumulating cross-agent DX
// pattern, not something needing sub-hour freshness.
registerSystemAction('improvement-invalid-args-miner', async (ctx: SystemActionCtx) => {
  const windowDays = intFromEnv('PAPERCUSP_INVALID_ARGS_MINER_WINDOW_DAYS', 7, { min: 1 });
  const minDistinctOwners = intFromEnv('PAPERCUSP_INVALID_ARGS_MINER_MIN_OWNERS', 3, { min: 1 });
  const minOccurrences = intFromEnv('PAPERCUSP_INVALID_ARGS_MINER_MIN_OCCURRENCES', 10, { min: 1 });
  const maxPerTick = intFromEnv('PAPERCUSP_INVALID_ARGS_MINER_MAX_PER_TICK', 5, { min: 0 });
  const result = await runInvalidArgsMinerTick(ctx.workspaceId, { windowDays, minDistinctOwners, minOccurrences, maxPerTick });
  console.log(
    `[improvement-invalid-args-miner] scanned ${result.scanned} invalid-input row(s) → ${result.candidates} ` +
      `(tool,key) pair(s) cleared the recurrence bar, captured ${result.captured.length}` +
      (result.captured.length ? ` (${result.captured.join(', ')})` : '') +
      `, ${result.declined} duplicate(s) declined` +
      (result.failed ? `, ${result.failed} capture(s) FAILED` : ''),
  );
});

// ── P-017: the weekly per-verb schema-rejection scorecard (capture only) ─────
// Reads the per-verb rejection RATE (never the fleet aggregate — that aggregate
// read 0.50% while one verb rejected 56 of 56 calls) and files against each verb
// sustaining >= 10% over >= 3 separate days. See tool-rejection-miner.ts.
//
// Weekly, and deliberately NOT on the 15-min watchdog tick: the daily aggregate
// scans ~3.4M rows over its window with a heap fetch for tenant scoping, and
// `TOOL_REJECTION_MIN_BREACH_DAYS` cannot be satisfied faster than 3 days anyway.
// Offset 30 min from the invalid-args miner so two heavy tool_invocations scans
// never land on the same minute.
registerSystemAction('improvement-tool-rejection-scorecard', async (ctx: SystemActionCtx) => {
  const windowDays = intFromEnv('PAPERCUSP_TOOL_REJECTION_WINDOW_DAYS', 7, { min: 1 });
  const maxPerTick = intFromEnv('PAPERCUSP_TOOL_REJECTION_MAX_PER_TICK', 5, { min: 0 });
  const result = await runToolRejectionMinerTick(ctx.workspaceId, { windowDays, maxPerTick });
  console.log(
    `[improvement-tool-rejection-scorecard] ${result.totalCalls} schema-boundary call(s) across ` +
      `${result.toolsSeen} verb(s)/${windowDays}d — fleet aggregate ${result.aggregatePct}%, ` +
      `${result.breaching} verb(s) breaching, captured ${result.captured.length}` +
      (result.captured.length ? ` (${result.captured.join(', ')})` : '') +
      `, ${result.declined} duplicate(s) declined` +
      (result.skippedSelf ? `, ${result.skippedSelf} improvement-loop verb(s) skipped` : '') +
      (result.failed ? `, ${result.failed} capture(s) FAILED` : ''),
  );
});

// ── P-019: D-104's endgame — does an auto-correction ever decay? ─────────────
// Reads the SHAPE AGENTS SENT out of `tool_invocations.args_json`, never the
// rejection status: a re-encoding rule moves its own population from
// `invalid-input` to `ok` the day it serves, so a status-keyed check would read
// a clean decay to zero while caller behaviour is unchanged (D-109/D-113).
// Folds each day into its own routine metadata, because the baseline is by
// definition older than the ~14d raw retention. See correction-decay-miner.ts.
registerSystemAction('improvement-correction-decay', async (ctx: SystemActionCtx) => {
  const windowDays = intFromEnv('PAPERCUSP_CORRECTION_DECAY_WINDOW_DAYS', 14, { min: 1 });
  const maxPerTick = intFromEnv('PAPERCUSP_CORRECTION_DECAY_MAX_PER_TICK', 3, { min: 0 });
  const result = await runCorrectionDecayMinerTick(ctx.installSlug, ctx.workspaceId, {
    windowDays,
    maxPerTick,
  });
  console.log(
    `[improvement-correction-decay] ${result.rulesSeen} rule(s) over ${result.daysSeen} day(s) ` +
      `(live ${windowDays}d + snapshot) — ${result.rating}: ${result.evidence} ` +
      `${result.notDecaying} not decaying, captured ${result.captured.length}` +
      (result.captured.length ? ` (${result.captured.join(', ')})` : '') +
      `, ${result.declined} duplicate(s) declined` +
      (result.snapshotted ? '' : ', snapshot NOT written') +
      (result.failed ? `, ${result.failed} capture(s) FAILED` : ''),
  );
});

// ── Phase 3: the auto-implement loop (flag-gated OFF) ────────────────────────

/**
 * The dispatch seam — injectable for tests (mirrors blueprint-run-action's fire fn).
 * EI-403-A: the default no longer FIRES inside the routine step (a child workflow
 * can't start there). It BUILDS a durable-spawn request and returns it as
 * `durableSpawn`; the dispatch loop collects these and returns them as
 * `SystemActionResult.durableSpawns`, which the routine workflow starts durably
 * AFTER the step. A seam that returns void / no `durableSpawn` (the test default)
 * dispatches nothing — exactly as before.
 */
export type ImplementFireFn = (input: {
  runnerHarness: string;
  workspaceId: string;
  candidate: ScoredItem;
  /** The dispatch ledger row id for THIS fire — threaded to the /invoke route so its
   *  worker-exit back-edge (EI-404) can record the death on this row. Null when the
   *  ledger insert failed (the orphan collector stays the 2h catch-all). */
  dispatchId?: string | null;
}) => void | ImplementFireResult | Promise<void | ImplementFireResult>;

export interface ImplementFireResult {
  /** spawn correlation recorded on the ledger row as spawned_run_id (NULL if absent). */
  spawnedRunId?: string | null;
  /** EI-403-A: the durable fire to start at the workflow layer after the step. */
  durableSpawn?: DurableSpawnFireInput;
}

let _fire: ImplementFireFn | null = null;
/** Override the dispatch fn (tests). Pass null to restore the default invoke fire. */
export function setImprovementImplementFire(fn: ImplementFireFn | null): void {
  _fire = fn;
}

/**
 * The kickoff the implement worker receives. It carries the WHOLE per-item
 * contract — which item, what to do, and the resolve back-edge it MUST call
 * (close-loop D-001) — so the loop closes even before the worker reads its
 * blueprint prompt (blueprints/implement/prompts/worker.md, the long form).
 */
export function implementKickoff(candidate: Pick<ScoredItem, 'id' | 'title' | 'attempts'>): string {
  return (
    `Auto-implement papercusp improvement ${candidate.id} (kind=bug): "${candidate.title}". ` +
    `Reproduce, fix with a regression test, run the affected tests, keep it self/inline-sized. ` +
    `When VERIFIED green, you MUST call improvements:resolve { id: '${candidate.id}', outcome: 'fixed', summary, testsRun } ` +
    `so the bug leaves the queue. If you cannot fix it, call improvements:resolve with outcome 'could-not-fix'. ` +
    `If the fix would touch operator-core safety / the deploy machinery / a migration, STOP and call ` +
    `improvements:resolve with outcome 'needs-human'. The change lands via the release gate.` +
    ((candidate.attempts ?? 0) > 0 ? ` (Dispatch attempt ${(candidate.attempts ?? 0) + 1} — earlier attempts failed; read the issue comments first.)` : '')
  );
}

/**
 * Default dispatch: fire the `implement` LAUNCH BLUEPRINT at the DEDICATED runner
 * harness (D-006) — `fireLaunchBlueprint` resolves the role from the blueprint
 * (decider worker) AND passes `BLUEPRINT_ID=implement`, so the worker gets the
 * blueprint-owned prompt (blueprints/implement/prompts/worker.md). The runner
 * implements + verifies, calls `improvements:resolve` (the back-edge), and the
 * change lands via the release gate (D-008). Fire-and-forget. (This path only
 * ever runs when an owner has flipped the flag AND configured the runner harness
 * — see planImplementRun's gates; until then it is unreachable.)
 */
/**
 * Worker lifetime for one implement dispatch. Reproduce + fix + regression test +
 * test:affected does not fit the invoke route's smaller defaults — the first armed
 * week ran at 280s and SIGTERM'd 51/58 workers mid-fix (exit 143,
 * learning-system-audit-improvements-2026-06-09 D-010). Must stay well under
 * plan-implement's DEFAULT_STALE_CLAIM_MS (2h) so a timed-out item's claim goes
 * stale only AFTER its worker is dead — never two workers on one item.
 */
export function implementTimeoutMs(): number {
  return intFromEnv('PAPERCUSP_IMPROVEMENT_IMPLEMENT_TIMEOUT_MS', 2_700_000, { min: 60_000 });
}

const defaultFire: ImplementFireFn = async ({ runnerHarness, workspaceId, candidate, dispatchId }) => {
  const attempt = (candidate.attempts ?? 0) + 1;
  // STABLE idempotency key (EI-403-A): derived from durable item state, never a
  // clock, so a recovery replay of THIS SAME dispatch (the outer routine workflow
  // crashing after this step already completed but before startDurableSpawns fired
  // it — system-actions.ts's documented recovery case) re-fires the SAME durable
  // workflow (`durable-spawn:<key>`) and dedups instead of double-dispatching.
  //
  // orphaned-dispatch root cause (EI-18117747280304049, live evidence: EI-10524 —
  // 88 dispatches, EI-8914 — 10, EI-13241 — 4, EVERY one attempt=1 with the
  // IDENTICAL spawned_run_id): keying on `attempt` collided across GENUINELY
  // DISTINCT dispatches (different cadence ticks, hours apart) whenever
  // payload.implementAttempts failed to advance between them — which
  // implement-worker-exit.ts's EI-406 rollback (`implementAttempts: attempt - 1`
  // on an env-failure/timeout/context-overflow death) makes a routine occurrence,
  // not an edge case: a flaky-infra death pins the counter at the SAME value
  // forever. Two dispatches sharing a key make DBOS.startWorkflow's
  // {workflowID, deduplicationID} treat the 2nd+ as a replay of the FIRST
  // (already-terminal) workflow — no NEW worker is ever spawned, so the dispatch
  // silently does nothing until the 2h orphan collector flags it "orphaned",
  // misleadingly implying a worker died when none ever ran. `dispatchId` is a
  // fresh ledger-row UUID minted for THIS fire (recordDispatchFired, immediately
  // before this runs) — unique per real dispatch, independent of the attempt
  // counter's health, so it can never collide across ticks. It's still STABLE
  // across the recovery-replay case above: that replay reuses this same
  // completed step's cached return value (and therefore the same dispatchId),
  // never re-executes this function body. Fall back to the attempt-keyed form
  // only on the rare NULL (the ledger insert itself failed), so a dispatch is
  // never blocked on the ledger.
  const idempotencyKey = dispatchId
    ? `implement:${candidate.id}:d${dispatchId}`
    : `implement:${candidate.id}:${attempt}`;
  const durableSpawn = await buildLaunchSpawnRequest(
    'implement',
    {
      installSlug: runnerHarness,
      workspaceId,
      kickoff: implementKickoff(candidate),
      timeoutMs: implementTimeoutMs(),
      // Correlation for the worker-exit back-edge (EI-404): the /invoke route records
      // the worker's death on THIS ledger row at close time (visible in seconds, vs
      // the 2h orphan threshold) and rolls back the attempt on an env-failure (EI-406).
      bodyExtra: {
        spawnModel: LEARNING_MODEL_SPEC,
        ...(dispatchId ? { improvementDispatch: { dispatchId, itemId: candidate.id, attempt } } : {}),
      },
    },
    idempotencyKey,
  );
  // The fire happens at the workflow layer (the engine drains durableSpawns); the
  // The durable workflow id is the eventual spawn correlation. The dispatch
  // ledger stays pending until startDurableSpawns confirms the enqueue outside
  // this checkpointed action step.
  return { spawnedRunId: `durable-spawn:${idempotencyKey}`, durableSpawn };
};

/**
 * The dispatch-bookkeeping seam (close-loop D-001) — stamps an item IN-FLIGHT
 * before the fire: claim it as `improvement-runner` (assignee + assigned_at →
 * the in-flight skip on the next tick) and bump `payload.implementAttempts`
 * (the anti-ping-pong counter improvements:resolve grades against). Injectable
 * so unit tests observe it without PG.
 */
// EI-18123303195363852: the return value is the CLAIM-TOOK-HOLD signal — `true` iff
// claimIssue actually matched a row (not a silent 0-row no-op). This closes the class
// behind the dispatch-orphan-rate SLO regression: harness_shared.engineer_issues is a
// compat VIEW over work_items, and its INSTEAD OF trigger UNCONDITIONALLY RETURN NULLs
// (0 rows, no throw) for ANY write against an origin='remote' (federated) row (EI-7833,
// mig 521) — so claimIssue/mergeIssuePayload silently do nothing for a federated item,
// on every dispatch, forever. classifyImprovement's workItemOrigin==='remote' gate
// (EI-15659) already keeps such items out of the auto-eligible set going forward, but
// that is a single, specific instance of a GENERAL failure mode: any reason a claim
// silently no-ops (this guard, a future guard, a race) must never be followed by firing
// a durable worker anyway — that is exactly how EI-10524/EI-8914/EI-13241 each
// re-dispatched every ~30min for days, always at attempt=1 (the counter frozen by the
// same no-op), replay-deduping at the DBOS layer until the 2h collector marked them
// "orphaned" with no recorded cause. Verifying the claim before firing turns a silent,
// endlessly-repeating no-op into a single loud skip.
export type MarkDispatchedFn = (candidate: ScoredItem) => boolean | Promise<boolean>;

let _markDispatched: MarkDispatchedFn | null = null;
/** Override the dispatch bookkeeping (tests). Pass null to restore the default. */
export function setImprovementMarkDispatched(fn: MarkDispatchedFn | null): void {
  _markDispatched = fn;
}

const defaultMarkDispatched: MarkDispatchedFn = async (candidate) => {
  const claimed = await claimIssue(candidate.id, IMPROVEMENT_RUNNER_ASSIGNEE);
  if (!claimed) return false;
  await mergeIssuePayload(candidate.id, {
    implementAttempts: (candidate.attempts ?? 0) + 1,
    lastDispatchAt: new Date().toISOString(),
  });
  return true;
};

/**
 * The dispatch-ledger seam (consume-edges P-010 / B-04) — the durable
 * dispatch → fire-result record in harness_shared.improvement_dispatches
 * (dispatch-ledger.ts; migration 238). Injectable so the handler test observes
 * the writes without PG. Both fns swallow + warn on PG failure — accounting
 * never blocks the dispatch itself.
 */
export interface DispatchLedgerFns {
  recordDispatchFired: typeof recordDispatchFired;
  recordFireResult: typeof recordFireResult;
}

let _ledger: DispatchLedgerFns | null = null;
/** Override the dispatch ledger (tests). Pass null to restore the PG-backed default. */
export function setImprovementDispatchLedger(fns: DispatchLedgerFns | null): void {
  _ledger = fns;
}

/**
 * The exhausted⇒leader-triage flip seam (consume-edges P-012) — injectable so the
 * handler test observes the flip without PG. Default: resolve-core's
 * routeExhaustedImprovementToLeaderTriage (comment + status='blocked' + release the stale
 * claim — a silent worker death is operational, so it goes to leader triage, not the owner's
 * inbox; P-004/WI-5679).
 */
export type ExhaustedFlipFn = (candidate: ScoredItem, maxAttempts?: number) => void | Promise<void>;

let _flipExhausted: ExhaustedFlipFn | null = null;
/** Override the exhausted flip (tests). Pass null to restore the default. */
export function setImprovementExhaustedFlip(fn: ExhaustedFlipFn | null): void {
  _flipExhausted = fn;
}

const defaultFlipExhausted: ExhaustedFlipFn = async (candidate, maxAttempts) => {
  await routeExhaustedImprovementToLeaderTriage({
    id: candidate.id,
    attempts: candidate.attempts,
    maxAttempts,
    by: 'improvement-implement',
  });
};

registerSystemAction('improvement-implement', async (ctx: SystemActionCtx): Promise<void | SystemActionResult> => {
  const items = await readImprovementItems({ state: 'open' });
  const flagEnabled = await getFlag(FLAGS.IMPROVEMENT_AUTO_IMPLEMENT, `routine:${ctx.installSlug}`);
  // The OWNER FULL-AUTONOMY grant (queen-autonomy-and-selffeed-fix Phase 2): when ON,
  // the tier split lifts the protected-path/keyword TCB bars so a kind=bug touching the
  // deploy gate / flags / capability dispatch / migrations / the loop's own code is
  // dispatchable. Read at `autonomy:<ws>` (the same key the decider reads), so one owner
  // flip covers both the decision gate + this implement lane. Fail-DARK (helper).
  const ownerFullAutonomy = await readOwnerFullAutonomyGrant(ctx.workspaceId);
  // WI-290: default the runner harness to the routine's OWN install slug when the env
  // override is unset. This previously read ONLY a per-tree/per-process untracked
  // `.env.local` var — a config single-point-of-failure. When the executor that actually
  // runs the routines (the dedicated bg-host, on the staging tree) lacked it — a drift a
  // restart / routine-consolidation can silently introduce — `planImplementRun` returned
  // action='no-runner' EVERY tick and dispatched nothing, with only a console.log. The
  // routine's liveness signal (last_fired_at) kept advancing, so the lane went dark and
  // STAYED dark (35h after the 2026-06-19 host-restart orphan storm; ~200 dispatchable
  // bugs stranded) with nothing detecting it. The dispatch is ALWAYS a fresh durable child
  // spawn (EI-403-A) that lands via the release gate — never an in-process modification —
  // so the routine's own install slug is the correct default runner; the env now only
  // OVERRIDES it to a DIFFERENT harness. `planImplementRun`'s pure no-runner guard stays
  // intact (the `|| null` tail still trips it if neither resolves — e.g. an empty slug).
  const runnerHarness = process.env.PAPERCUSP_IMPROVEMENT_RUNNER_HARNESS || ctx.installSlug || null;
  // live-configurability-audit P-011: the stored auto-implement policy (riskTier + dispatch limits)
  // overrides the env value-gates / DEFAULT_RISK_TIER_POLICY; an empty store ⇒ env/default ⇒
  // byte-identical. Inert until IMPROVEMENT_AUTO_IMPLEMENT is armed (flagEnabled below).
  const storedAutoPolicy = await readAutoImplementPolicy();
  const maxPerRun = storedAutoPolicy.maxPerRun ?? intFromEnv('PAPERCUSP_IMPROVEMENT_MAX_PER_RUN', 1, { min: 0 });
  // maxAttempts is genuinely optional (undefined = no cap). Honor an explicit 0
  // (a valid "never dispatch" pause) when set; leave undefined when unset/blank.
  const maxAttemptsRaw = process.env.PAPERCUSP_IMPROVEMENT_MAX_ATTEMPTS;
  const maxAttempts =
    storedAutoPolicy.maxAttempts ??
    (maxAttemptsRaw && maxAttemptsRaw.trim() !== ''
      ? intFromEnv('PAPERCUSP_IMPROVEMENT_MAX_ATTEMPTS', 0, { min: 0 })
      : undefined);

  // P-032: PAUSE the lane during a fleet credential/env outage so it stops dispatching
  // workers that die instantly on rate-limit/auth (and stops generating orphan noise —
  // the capture side already suppresses it, P-010). Reuses laneInEnvOutage over the recent
  // dispatch ledger, with a tighter window than the capture side so the lane probes recovery
  // as soon as env deaths age out. Only when armed; a ledger-read failure ⇒ treat as no outage.
  let laneEnvOutage = false;
  // EI-14812 class fix: `payload.implementAttempts` (issueToCandidate's `attempts`)
  // is supposed to be the anti-ping-pong counter, bumped by `defaultMarkDispatched`
  // on every fire and rolled back/escalated by the worker-exit + orphan-collector
  // back-edges — but ALL of those are best-effort `mergeIssuePayload` writes that
  // can silently no-op (0 rows touched, no throw) or throw-and-get-swallowed with
  // no recurrence guard of their own. When that happens for a given item, its
  // payload counter freezes while the dispatch ledger keeps growing — root-caused
  // live: EI-10524's payload never left `implementAttempts: undefined` (frozen
  // since 2026-07-16 21:47:32) while the SAME item was re-dispatched 81 times over
  // ~50h, tripping the EI-1689 host-restart-thrash breaker's "routed to human, NOT
  // re-dispatched" branch more than a dozen times WITHOUT the needsHuman flip ever
  // actually landing — because that flip is just another `mergeIssuePayload` write
  // into the same frozen row. `readRecentDispatches` is the one write in this whole
  // lane that has NEVER been observed to desync (it is the unconditional fire-time
  // record dispatch-ledger.ts's own module doc describes as the accounting source
  // of truth) — so it is used here as a FLOOR under the payload-stamped counter:
  // an item's effective `attempts` can only read HIGHER than the ledger's actual
  // dispatch count, never lower. This can only make the loop MORE conservative
  // (a no-op for the vast majority of items whose payload counter tracks fine) and
  // durably closes the entire class of "stuck counter ⇒ infinite re-dispatch",
  // independent of whatever future cause freezes a payload write again.
  let ledgerDispatchCounts: Map<string, number> | null = null;
  if (flagEnabled) {
    try {
      const windowMs = intFromEnv('PAPERCUSP_IMPROVEMENT_ENV_PAUSE_WINDOW_MS', 90 * 60_000, { min: 60_000 });
      const recent = await readRecentDispatches(ctx.workspaceId, { limit: 500 });
      laneEnvOutage = laneInEnvOutage(recent, { nowMs: Date.now(), windowMs });
      ledgerDispatchCounts = new Map();
      for (const row of recent) {
        ledgerDispatchCounts.set(row.itemId, (ledgerDispatchCounts.get(row.itemId) ?? 0) + 1);
      }
    } catch (e) {
      console.warn('[improvement-implement] env-outage pause check skipped (ledger read failed):', e instanceof Error ? e.message : e);
    }
  }
  const itemsForPlan = ledgerDispatchCounts
    ? items.map((it) => {
        const ledgerCount = ledgerDispatchCounts!.get(it.id) ?? 0;
        return ledgerCount > (it.attempts ?? 0) ? { ...it, attempts: ledgerCount } : it;
      })
    : items;

  const plan = planImplementRun({ items: itemsForPlan, flagEnabled, runnerHarness, maxPerRun, maxAttempts, laneEnvOutage, ownerFullAutonomy, policy: storedAutoPolicy.riskTier });

  // Exhausted-without-resolve ⇒ needs-human (consume-edges P-012): an item whose
  // dispatch attempts exhausted with no improvements:resolve ever recorded (silent
  // worker death) is stranded — never dispatchable again, never human-routed. Flip
  // each to the human tier EVERY tick, whatever the plan action (a disarmed lane
  // still surfaces its strays). Best-effort per item: a flip failure never blocks
  // the dispatch loop; the flip is idempotent, so the next tick retries.
  const flipExhausted = _flipExhausted ?? defaultFlipExhausted;
  for (const stranded of plan.attemptsExhausted) {
    try {
      await flipExhausted(stranded, maxAttempts);
      console.log(
        `[improvement-implement] ${stranded.id} exhausted ${stranded.attempts ?? '?'} dispatch attempt(s) with no resolve recorded — routed to the human tier (P-012)`,
      );
    } catch (e) {
      console.warn(`[improvement-implement] exhausted⇒needs-human flip failed for ${stranded.id}:`, e instanceof Error ? e.message : e);
    }
  }

  if (plan.action !== 'dispatch') {
    console.log(`[improvement-implement] ${plan.action}: ${plan.message}`);
    return;
  }
  // P-005 (infra round-4): during a graceful drain (SIGTERM/deploy) do NOT START a
  // new dispatch batch. A worker spawned now runs for minutes and would be SIGKILL'd
  // by the drain's hard-exit backstop mid-fix, orphaning its claim and churning
  // re-dispatch across the deploy (the 2026-06-19 storm: 51/58 workers exited 143).
  // Items already in-flight stay claimed (stale-claim reclaim handles them); we only
  // stop ADDING to the doomed set. Default-OFF until armed (see the helper), so it
  // lands inert and is flipped on with the lane re-arm.
  if (shouldStopClaimingForDrain()) {
    console.log(
      `[improvement-implement] drain in progress (SIGTERM) — declining ${plan.candidates.length} ` +
        `new dispatch(es); in-flight claims unaffected (P-005)`,
    );
    return;
  }
  console.log(`[improvement-implement] ${plan.message}`);
  const fire = _fire ?? defaultFire;
  const markDispatched = _markDispatched ?? defaultMarkDispatched;
  const ledger = _ledger ?? { recordDispatchFired, recordFireResult };
  // EI-403-A: the action no longer fires inside this step — it COLLECTS the durable
  // fire requests and returns them; the routine workflow starts them durably AFTER
  // the step (where startWorkflow is legal). See routines-workflow.ts → startDurableSpawns.
  const durableSpawns: DurableSpawnFireInput[] = [];
  for (const candidate of plan.candidates) {
    // P-005: SIGTERM can land MID-batch (maxPerRun > 1). Re-check before claiming the
    // next item so the already-fired ones drain while the rest wait for the first
    // post-restart tick — never claimed-then-killed.
    if (shouldStopClaimingForDrain()) {
      console.log(`[improvement-implement] drain began mid-batch — stopping before ${candidate.id} (P-005)`);
      break;
    }
    // Bookkeeping FIRST (claim + attempt bump) so a fire that crashes mid-loop
    // still leaves the item in-flight rather than double-dispatchable.
    const claimed = await markDispatched(candidate);
    if (!claimed) {
      // EI-18123303195363852: the claim silently no-op'd (0 rows — a federated
      // origin='remote' row the engineer_issues view guard refuses to touch, EI-7833;
      // or any other reason a write matched nothing). Firing a worker anyway is
      // guaranteed-wasted: nothing can ever record its outcome, so it just re-queues
      // next tick and eventually orphans with no cause. Skip the fire entirely — an
      // honest, logged no-dispatch beats a silent doomed one.
      console.warn(
        `[improvement-implement] claim did not take for ${candidate.id} (0 rows — likely a federated/` +
          `remote-origin item the engineer_issues view guard refuses to write, or a claim race) — ` +
          `skipping fire, not dispatching a worker that could never report back`,
      );
      continue;
    }
    // Ledger row BEFORE the fire (P-010): a dispatcher crash between insert and
    // fire leaves a 'pending' row — visible, not silent. Direct fire success or
    // failure drives it here; a returned durableSpawn stays pending until the
    // workflow layer confirms enqueue. A fire failure no longer aborts the loop — the
    // item stays claimed (stale-claim reclaim backs it off; no hot re-dispatch)
    // and the remaining candidates still dispatch.
    // (per-hive-learning-loops P-012) Stamp the dispatch with the Hive that owns the
    // item — resolved from its scope tag (P-032) — so per-hive dispatch diagnostics
    // align with the per-hive improvement lens. Best-effort: NULL for an operator-
    // scoped item or any resolution failure; never blocks the dispatch.
    let dispatchPotSlug: string | null = null;
    const candidateScope = (candidate as { scope?: string }).scope;
    if (candidateScope && candidateScope.startsWith('harness:')) {
      const h = candidateScope.slice('harness:'.length);
      try {
        const { potHomeSlugForHarness } = await import('../../hive-federation');
        dispatchPotSlug = (await potHomeSlugForHarness(ctx.workspaceId, h)) ?? h;
      } catch {
        dispatchPotSlug = h;
      }
    }
    const dispatchId = await ledger.recordDispatchFired({
      workspaceId: ctx.workspaceId,
      itemId: candidate.id,
      attempt: (candidate.attempts ?? 0) + 1,
      runnerHarness,
      potSlug: dispatchPotSlug,
    });
    try {
      const fired = await fire({ runnerHarness: runnerHarness as string, workspaceId: ctx.workspaceId, candidate, dispatchId });
      const durableSpawn = fired && typeof fired === 'object' ? fired.durableSpawn : undefined;
      if (durableSpawn) durableSpawns.push(durableSpawn);
      if (dispatchId && !durableSpawn) {
        const spawnedRunId = fired && typeof fired === 'object' ? (fired.spawnedRunId ?? null) : null;
        await ledger.recordFireResult(dispatchId, { ok: true, spawnedRunId });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[improvement-implement] fire FAILED for ${candidate.id}: ${msg}`);
      if (dispatchId) await ledger.recordFireResult(dispatchId, { ok: false, error: msg });
    }
  }
  // Hand the collected fires to the engine to start durably at the workflow layer
  // (EI-403-A). Nothing to start ⇒ void (a build seam that returned no request).
  return durableSpawns.length ? { durableSpawns } : undefined;
});
