/**
 * Gym autoloop TICK core (learning-system-audit-improvements-2026-06-09
 * P-031 + P-032) — the pure, injected-deps decision + orchestration behind the
 * `system:gym-cycle` routine action (harness/routines/gym-actions.ts).
 *
 * Today gym cycles only ran via the manual CLI (`gym-loop-run.ts`);
 * `harness_shared.gym_autoloop_config` had enabled/budget/status but NOTHING
 * fired cycles. This tick gives the gym a pulse:
 *
 *   per tick: list autoloops → keep enabled=true + status='idle' + an EXPLICIT
 *   budget with remaining > the floor (~$0.50) → order by least-recently-run →
 *   take the FIRST whose autoloop fire-gate (error backoff / circuit, D-009)
 *   allows → run ONE bounded gym cycle for that harness via the injected
 *   `runCycle` (live wiring: runOneAutoloopCycle, in-process), with the
 *   triage-routed gym ideas (P-032) as proposer candidate directions →
 *   settle status + ACCUMULATE spend on the autoloop row.
 *
 * HARD COST GUARDS (all enforced here or inside the cycle machinery):
 *   - disabled / non-idle / no-explicit-budget / remaining ≤ floor ⇒ NOT eligible.
 *     A null budget is deliberately INELIGIBLE for the unattended path — continuous
 *     operation requires an explicit cap (set one via the gym UI's autoloop config).
 *   - ONE harness per tick (round-robin by least-recently-run lastCycleAt).
 *   - the cycle's own budget cap = the row's REMAINING budget (runOptimizationLoop
 *     hard-stops there), plus the in-loop rate-pause + arithmetic circuit breaker.
 *   - autoPromote stays FALSE — proposals remain human-decided (D-020).
 *
 * Status transitions: idle → running → idle (success), → 'paused' when the
 * loop's circuit breaker tripped, → 'exhausted' when the remaining budget fell
 * to ≤ the floor, → back to idle EVEN ON ERROR (the fire-gate's error backoff
 * is the retry brake, not a stuck 'running' status). Resuming a paused/
 * exhausted autoloop is a human act (gym UI), matching the human-gated design.
 *
 * Everything is injected (GymTickDeps), so selection, round-robin, budget
 * floors, routed-ideas assembly, and the status transitions are unit-tested
 * with zero PG / zero LLM / no docker (autoloop-tick.test.ts).
 */
import type { GymAutoloopConfig, SetAutoloopInput } from './control-plane';
import type { BlueprintRetirementInfo } from '@papercusp/orchestrator/blueprint';

/** Below this remaining budget an autoloop is not worth (or safe) firing. */
export const GYM_AUTOLOOP_BUDGET_FLOOR_USD = 0.5;

/**
 * A row 'running' longer than this is a crash artifact, not a live cycle.
 *
 * EI-18680423618217546: this used to be 45 min ("1.5 cadences … far past any
 * legitimate cycle") — empirically false. A real bounded cycle observed
 * 2026-07-26 (maxCycles=1, $50 budget, 6 runs) ran ~52 min wall-clock
 * (LLM-latency-bound, not budget-bound — it only spent $0.42 of the $50 cap),
 * so the old threshold could reclaim a LIVE cycle's row out from under it
 * (a ~9-min false-positive window observed: 45min-after-dispatch to actual
 * settle). `updatedAt` is only touched at dispatch and at settle (see
 * `runGymAutoloopTick` below) — there is no in-cycle heartbeat — so the
 * threshold must clear the SLOWEST plausible real cycle, not just a typical
 * one. 3h gives a wide margin over the observed ~52min while still staying
 * well clear of the durable-step replay window (a replayed tick sees a FRESH
 * 'running' row and must still skip it) and still reclaiming a genuine
 * crash-artifact row within a handful of the 30-min tick cadence.
 */
export const GYM_AUTOLOOP_STALE_RUNNING_MS = 3 * 60 * 60_000;

// ---------------------------------------------------------------------------
// P-032: triage-routed gym ideas → proposer candidate directions
// ---------------------------------------------------------------------------

/** The slice of an improvement candidate the gym cares about (structural — matches ImprovementCandidate). */
export interface RoutedIdeaSource {
  id: string;
  title: string;
  body?: string;
  ideaLifecycle?: { triageDecision?: string };
}

export interface RoutedGymIdea {
  id: string;
  title: string;
  body?: string;
}

/** Keep only items the triage pass routed to the gym (payload.ideaLifecycle.triageDecision='gym'). */
export function selectRoutedGymIdeas(items: readonly RoutedIdeaSource[]): RoutedGymIdea[] {
  return items
    .filter((it) => it.ideaLifecycle?.triageDecision === 'gym')
    .map((it) => ({ id: it.id, title: it.title, ...(it.body ? { body: it.body } : {}) }));
}

export interface FormatDirectionsOptions {
  /** Cap on ideas surfaced per cycle (prompt-size bound). */
  maxIdeas?: number;
  /** Per-idea character cap (title+body line). */
  maxCharsPerIdea?: number;
}

/**
 * Format routed ideas into the proposer's candidate-direction lines:
 * `<title> — <single-line body>` truncated per idea, capped in count.
 * Zero ideas ⇒ [] ⇒ the proposer prompt is unchanged (additive by construction).
 */
export function formatCandidateDirections(
  ideas: readonly RoutedGymIdea[],
  opts: FormatDirectionsOptions = {},
): string[] {
  const maxIdeas = Math.max(0, opts.maxIdeas ?? 8);
  const maxChars = Math.max(16, opts.maxCharsPerIdea ?? 400);
  return ideas.slice(0, maxIdeas).map((idea) => {
    const body = idea.body ? idea.body.replace(/\s+/g, ' ').trim() : '';
    const line = body ? `${idea.title} — ${body}` : idea.title;
    return line.length > maxChars ? `${line.slice(0, maxChars - 1)}…` : line;
  });
}

// ---------------------------------------------------------------------------
// Eligibility + round-robin selection
// ---------------------------------------------------------------------------

/** Shared empty set — the unwired / read-failed pot gate, allocated once. */
const EMPTY_POT_SET: ReadonlySet<string> = new Set<string>();

/** Remaining budget for an autoloop row; null when no explicit cap is set. */
export function remainingBudgetUsd(cfg: Pick<GymAutoloopConfig, 'budgetUsd' | 'spentUsd'>): number | null {
  return cfg.budgetUsd === null ? null : cfg.budgetUsd - cfg.spentUsd;
}

/**
 * Tick eligibility: enabled AND idle AND an EXPLICIT budget with remaining
 * above the floor. (Null budget = ineligible: the unattended path refuses to
 * spend without a cap — the hard cost guard.)
 *
 * `potEnabled` is the per-pot master switch (learning-pot-scope-gate-2026-08-30
 * D-001). Gym's governor rows are `enforcement:'native'`, meaning THIS predicate
 * IS gym's gate — routing gym through the governor's own `pot-disabled` refusal
 * would gate nothing — so the switch has to be applied right here. Omitted ⇒
 * enabled, which is both R-5's fail-open default and the pre-gate behaviour.
 */
export function isEligibleAutoloop(
  cfg: GymAutoloopConfig,
  budgetFloorUsd: number,
  potEnabled: boolean = true,
): boolean {
  if (!cfg.enabled) return false;
  if (!potEnabled) return false;
  if (cfg.status !== 'idle') return false;
  const remaining = remainingBudgetUsd(cfg);
  return remaining !== null && remaining > budgetFloorUsd;
}

/**
 * A 'running' row untouched for `staleMs` is a crash artifact: the tick sets
 * 'running' BEFORE the cycle and settles it after — even on a cycle error — so
 * the only way a row STAYS 'running' is a host death mid-cycle (deploy swap,
 * restart, OOM). Without reclaim such a row is never idle ⇒ never re-picked
 * and the autoloop dead-locks forever (observed live 2026-06-10: stuck
 * 'running' through four ticks after the 21:00 deploy/rollback window).
 */
export function isStaleRunning(
  cfg: Pick<GymAutoloopConfig, 'status' | 'updatedAt'>,
  nowMs: number,
  staleMs: number,
): boolean {
  return cfg.status === 'running' && nowMs - cfg.updatedAt >= staleMs;
}

/** Least-recently-run first (never-run rows lead), slug as the stable tiebreak. */
export function orderByLeastRecentlyRun(cfgs: readonly GymAutoloopConfig[]): GymAutoloopConfig[] {
  return [...cfgs].sort((a, b) => {
    const aT = a.lastCycleAt ?? -Infinity;
    const bT = b.lastCycleAt ?? -Infinity;
    if (aT !== bT) return aT - bT;
    return a.harnessSlug.localeCompare(b.harnessSlug);
  });
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

export interface GymCycleRequest {
  harnessSlug: string;
  workspaceId: string;
  /** The row's REMAINING budget — the cycle's hard spend cap. */
  budgetUsd: number;
  /** P-032: formatted routed-idea lines for the proposer ([] = none). */
  candidateDirections: string[];
}

export interface GymCycleResult {
  spentUsd: number;
  breakerTripped: boolean;
  cycles: number;
  accepts: number;
  skipped: number;
}

/** Mirrors the autoloop fire-gate verdict (lib/autoloop.ts) structurally. */
export interface TickFireGateVerdict {
  allow: boolean;
  reason?: string;
  retryAfterSec?: number;
}

export interface GymTickDeps {
  /** All autoloop rows for the workspace (listAutoloopsForWorkspace). */
  listAutoloops(): Promise<GymAutoloopConfig[]>;
  /** The shared autoloop fire-gate (error backoff / circuit, D-009) for role 'gym-cycle'. */
  checkFireGate(harnessSlug: string): Promise<TickFireGateVerdict>;
  /** Record a fire-path event ('attempt' preserves, 'ok' resets, 'error' increments the counter). */
  recordFire(harnessSlug: string, status: string, outcome: 'attempt' | 'ok' | 'error'): Promise<void>;
  /** Upsert the autoloop row (control-plane setAutoloop; omitted fields preserved). */
  setAutoloop(input: SetAutoloopInput): Promise<unknown>;
  /** Open improvements routed to the gym by triage (P-032). */
  readRoutedIdeas(): Promise<RoutedGymIdea[]>;
  /** Run ONE bounded gym cycle (live wiring: runOneAutoloopCycle, in-process). */
  runCycle(req: GymCycleRequest): Promise<GymCycleResult>;
  /**
   * P-020 cross-node SINGLE-RUNNER gate (live wiring: checkHiveSingleRunner). In a
   * SHARED Hive each NODE runs its OWN `system:gym-cycle` against its OWN embedded
   * PG over its OWN (node-local) `gym_autoloop_config` rows, so two nodes can each
   * pick + run a cycle for the SAME Hive member ⇒ double spend. This predicate keeps
   * in the candidate pool ONLY the autoloops whose Hive THIS node is the elected
   * authority for (lowest-live-pubkey, lockAuthorityForHive); a non-runner node's
   * candidate is dropped, so only one node fires the Hive's gym cycle. Optional:
   * unwired ⇒ no filter (the hermetic unit-test contract); at N=1 / standalone it
   * always resolves true (authority / not-in-hive), so behaviour is unchanged.
   */
  isHiveRunner?(harnessSlug: string): Promise<boolean>;
  /**
   * WI-5645 (no-retirement-launch-guard): does this autoloop's harness resolve to
   * a RETIRED blueprint (itself or any ancestor in its `extends` chain)? Live
   * wiring reads the harness's effective blueprint (`getEffectiveBlueprint`) and
   * `blueprintRetirement()`. Mirrors `isHiveRunner`'s optional-predicate shape:
   * unwired ⇒ no filter (the hermetic unit-test contract is unchanged); a check
   * failure fails OPEN (never stall the loop on an unresolvable gate — same
   * rationale as the fire-gate / hive-runner checks below), so this is a
   * best-effort cost guard, not a hard dependency.
   */
  isBlueprintRetired?(harnessSlug: string): Promise<BlueprintRetirementInfo | null>;
  /**
   * The per-pot learning master switch (learning-pot-scope-gate-2026-08-30
   * D-001): the pots switched OFF in this workspace (live wiring:
   * `disabledPotSlugs` over harness_shared.learning_pot_scope). Gym's
   * `harness_slug` IS the pot slug — per-hive by construction, the same
   * assumption the governor mirror already makes when it ledgers gym spend
   * (`potSlug: input.ran.harnessSlug`) — so the set is matched against it
   * directly. One indexed read per tick, not one per candidate.
   *
   * Same optional-predicate shape as the two gates above: unwired ⇒ no filter
   * (the hermetic unit-test contract is unchanged), and a read failure fails
   * OPEN — a pot gate that cannot be read must not stop the fleet learning,
   * which is R-5's whole posture.
   */
  disabledPots?(): Promise<ReadonlySet<string>>;
  /**
   * P-030 (B-09): finalize due post-acceptance champion-outcome windows
   * (live wiring: finalizePendingChampionOutcomes — cheap SQL, no LLM).
   * Optional; returns the finalized count. Failures log, never fail the tick.
   */
  finalizeOutcomes?(): Promise<number>;
  now?(): number;
  log?(msg: string): void;
}

export interface GymTickOutcome {
  action: 'idle' | 'ran' | 'error';
  /** Why an idle tick did nothing. 'not-hive-runner' (P-020): eligible autoloops
   *  existed but every one belongs to a SHARED Hive another node is the elected
   *  single runner for, so THIS node stood down. 'blueprint-retired' (WI-5645):
   *  eligible autoloops existed but every one's harness resolves to a RETIRED
   *  blueprint (itself or an ancestor). */
  /*  'pot-disabled' (learning-pot-scope-gate D-001): eligible autoloops existed
   *  but every one belongs to a pot switched off at the per-pot master gate —
   *  distinct from 'no-eligible-autoloop', which would read as "nothing to do". */
  reason?:
    | 'no-eligible-autoloop'
    | 'fire-gate-backoff'
    | 'not-hive-runner'
    | 'blueprint-retired'
    | 'pot-disabled';
  harnessSlug?: string;
  /** How many autoloops were eligible this tick (before the fire-gate walk). */
  eligibleCount: number;
  /** Eligible slugs withheld by the fire-gate (in LRU order, up to the chosen one). */
  gateBlocked: string[];
  /** WI-5645: eligible slugs withheld because their blueprint (or an ancestor) is
   *  retired — `{ slug, ...retirementInfo }` rows, for observability. */
  retiredBlocked?: Array<{ harnessSlug: string } & BlueprintRetirementInfo>;
  /** The routed-idea directions handed to the cycle (observability). */
  candidateDirections?: string[];
  result?: GymCycleResult;
  /** The status the autoloop row settled at ('idle' | 'paused' | 'exhausted'). */
  settledStatus?: string;
  error?: string;
  /** Slugs whose stale 'running' rows were reclaimed (crash recovery) this tick. */
  reclaimed?: string[];
  /** P-030: champion-outcome windows finalized this tick (absent when the dep is unwired). */
  outcomesFinalized?: number;
}

export interface GymTickOptions {
  budgetFloorUsd?: number;
  /** Age past which a 'running' row is reclaimed as a crash artifact. */
  staleRunningMs?: number;
}

/**
 * One tick of the gym autoloop routine. Runs AT MOST one cycle for at most one
 * harness; every skip reason is explicit in the outcome. Safe to re-run from
 * the top (the system-actions durable-step contract): a replayed tick sees the
 * previous attempt's row status ('running' rows are not idle ⇒ not re-picked).
 */
export async function runGymAutoloopTick(deps: GymTickDeps, opts: GymTickOptions = {}): Promise<GymTickOutcome> {
  const floor = opts.budgetFloorUsd ?? GYM_AUTOLOOP_BUDGET_FLOOR_USD;
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {});

  // P-030 (B-09): settle any post-acceptance outcome windows that have elapsed
  // BEFORE the cycle work — cheap SQL, independent of selection, and it feeds
  // the freshest champion verdicts into whatever cycle this tick may fire.
  let outcomesFinalized: number | undefined;
  if (deps.finalizeOutcomes) {
    try {
      outcomesFinalized = await deps.finalizeOutcomes();
      if (outcomesFinalized > 0) log(`finalized ${outcomesFinalized} champion outcome window(s)`);
    } catch (e) {
      log(`champion-outcome finalize failed (continuing): ${e instanceof Error ? e.message : e}`);
    }
  }

  const all = await deps.listAutoloops();

  // Crash recovery: settle stale 'running' rows (host died mid-cycle — see
  // isStaleRunning) back to idle so they compete in THIS tick's eligibility.
  // A reclaim failure is logged and the row stays busy (fail-safe: never run
  // a cycle against a row we could not settle).
  const staleMs = opts.staleRunningMs ?? GYM_AUTOLOOP_STALE_RUNNING_MS;
  const reclaimedSlugs: string[] = [];
  const pool: GymAutoloopConfig[] = [];
  for (const cfg of all) {
    if (!isStaleRunning(cfg, now(), staleMs)) {
      pool.push(cfg);
      continue;
    }
    try {
      const ts = now();
      await deps.setAutoloop({
        workspaceId: cfg.workspaceId,
        harnessSlug: cfg.harnessSlug,
        status: 'idle',
        now: ts,
      });
      reclaimedSlugs.push(cfg.harnessSlug);
      pool.push({ ...cfg, status: 'idle', updatedAt: ts });
      log(
        `reclaimed stale 'running' autoloop ${cfg.harnessSlug} ` +
          `(untouched ${Math.round((ts - cfg.updatedAt) / 60_000)} min — crashed mid-cycle)`,
      );
    } catch (e) {
      pool.push(cfg);
      log(`failed to reclaim stale 'running' row for ${cfg.harnessSlug}: ${e instanceof Error ? e.message : e}`);
    }
  }
  const reclaimExtra = {
    ...(reclaimedSlugs.length ? { reclaimed: reclaimedSlugs } : {}),
    ...(outcomesFinalized !== undefined ? { outcomesFinalized } : {}),
  };

  // The per-pot master switch (learning-pot-scope-gate D-001), read ONCE per
  // tick. Fail-open on a read error: an unreadable pot gate must never become a
  // fleet-wide learning outage (R-5), and the candidate simply stays eligible.
  let disabledPots: ReadonlySet<string> = EMPTY_POT_SET;
  if (deps.disabledPots) {
    try {
      disabledPots = await deps.disabledPots();
    } catch (e) {
      log(`pot-scope gate read failed — allowing every pot: ${e instanceof Error ? e.message : e}`);
    }
  }

  let eligiblePool = pool.filter((c) => isEligibleAutoloop(c, floor, !disabledPots.has(c.harnessSlug)));

  // Candidates existed but every one belongs to a pot the owner switched off.
  // Reported distinctly (like 'not-hive-runner') so an idle tick does not read
  // as "nothing to do" when the real answer is "you turned these pots off".
  if (eligiblePool.length === 0 && disabledPots.size > 0 && pool.some((c) => isEligibleAutoloop(c, floor))) {
    return { action: 'idle', reason: 'pot-disabled', eligibleCount: 0, gateBlocked: [], ...reclaimExtra };
  }

  // P-020 cross-node single-runner: drop candidates whose Hive THIS node is not the
  // elected authority for, so a SHARED Hive's gym cycle fires on exactly one node
  // (the per-NODE eligibility above can't see across nodes — each node sweeps its
  // own embedded PG). Per-candidate fail-open (mirrors the fire-gate check below):
  // a gate error keeps the candidate rather than starving the loop. Unwired ⇒ no
  // filter (the hermetic unit-test contract; at N=1 every verdict is true anyway).
  if (deps.isHiveRunner && eligiblePool.length > 0) {
    const verdicts = await Promise.all(
      eligiblePool.map(async (c) => {
        try {
          return await deps.isHiveRunner!(c.harnessSlug);
        } catch (e) {
          log(`hive-runner gate check failed for ${c.harnessSlug} — allowing: ${e instanceof Error ? e.message : e}`);
          return true; // fail-open: never stall the loop on an unresolvable gate
        }
      }),
    );
    const filtered = eligiblePool.filter((_, i) => verdicts[i]);
    if (filtered.length === 0) {
      // Candidates existed, but every one belongs to a Hive another node runs.
      return { action: 'idle', reason: 'not-hive-runner', eligibleCount: 0, gateBlocked: [], ...reclaimExtra };
    }
    eligiblePool = filtered;
  }

  // WI-5645 (no-retirement-launch-guard): drop candidates whose harness resolves to
  // a RETIRED blueprint (itself or any ancestor) — this is the hard cost guard that
  // stops a gym autoloop from spending against e.g. `external-bench` (which
  // `extends: coding-factory`, retired) the way EI-18177667809538623 did. Same
  // fail-open shape as the hive-runner gate above: a check error keeps the
  // candidate rather than starving the loop. Unwired ⇒ no filter (hermetic
  // unit-test contract unchanged).
  const retiredBlocked: Array<{ harnessSlug: string } & BlueprintRetirementInfo> = [];
  if (deps.isBlueprintRetired && eligiblePool.length > 0) {
    const verdicts = await Promise.all(
      eligiblePool.map(async (c) => {
        try {
          return await deps.isBlueprintRetired!(c.harnessSlug);
        } catch (e) {
          log(`blueprint-retirement check failed for ${c.harnessSlug} — allowing: ${e instanceof Error ? e.message : e}`);
          return null; // fail-open: never stall the loop on an unresolvable check
        }
      }),
    );
    const filtered = eligiblePool.filter((c, i) => {
      const verdict = verdicts[i];
      if (verdict) {
        retiredBlocked.push({ harnessSlug: c.harnessSlug, ...verdict });
        const detail = [verdict.at, verdict.reason].filter(Boolean).join(' — ');
        log(`skipping retired-blueprint autoloop ${c.harnessSlug}${detail ? `: ${detail}` : ''}`);
      }
      return !verdict;
    });
    if (filtered.length === 0) {
      // Candidates existed, but every one's harness resolves to a retired blueprint.
      return {
        action: 'idle',
        reason: 'blueprint-retired',
        eligibleCount: 0,
        gateBlocked: [],
        retiredBlocked,
        ...reclaimExtra,
      };
    }
    eligiblePool = filtered;
  }

  const eligible = orderByLeastRecentlyRun(eligiblePool);
  if (eligible.length === 0) {
    return { action: 'idle', reason: 'no-eligible-autoloop', eligibleCount: 0, gateBlocked: [], ...reclaimExtra };
  }

  // Round-robin walk: the first LRU-ordered autoloop whose fire-gate allows. A
  // harness in error backoff must not starve its peers, so blocked ones are
  // skipped (not retried) within the tick.
  const gateBlocked: string[] = [];
  let chosen: GymAutoloopConfig | null = null;
  for (const cfg of eligible) {
    let verdict: TickFireGateVerdict;
    try {
      verdict = await deps.checkFireGate(cfg.harnessSlug);
    } catch (e) {
      // The gate is a protection, not a dependency — fail OPEN (mirrors checkFireGate).
      log(`fire-gate check failed for ${cfg.harnessSlug} — allowing: ${e instanceof Error ? e.message : e}`);
      verdict = { allow: true };
    }
    if (verdict.allow) {
      chosen = cfg;
      break;
    }
    gateBlocked.push(cfg.harnessSlug);
    log(
      `fire-gate withheld ${cfg.harnessSlug} (${verdict.reason ?? 'backoff'}` +
        (verdict.retryAfterSec ? `, retry in ~${verdict.retryAfterSec}s` : '') +
        ')',
    );
  }
  if (!chosen) {
    return { action: 'idle', reason: 'fire-gate-backoff', eligibleCount: eligible.length, gateBlocked, ...reclaimExtra };
  }

  const remaining = remainingBudgetUsd(chosen);
  if (remaining === null) {
    // Unreachable per isEligibleAutoloop; belt-and-braces for the cost guard.
    return { action: 'idle', reason: 'no-eligible-autoloop', eligibleCount: eligible.length, gateBlocked, ...reclaimExtra };
  }

  // P-032 (additive): triage-routed gym ideas → proposer candidate directions.
  // Best-effort — a backlog read failure must never block the cycle.
  let directions: string[] = [];
  try {
    directions = formatCandidateDirections(await deps.readRoutedIdeas());
  } catch (e) {
    log(`routed-ideas read failed — running the cycle without directions: ${e instanceof Error ? e.message : e}`);
  }

  // Bookkeeping first: the fire attempt (counter preserved) + status running, so
  // a crash mid-cycle leaves an honest row (and the durable-step replay skips it).
  try {
    await deps.recordFire(chosen.harnessSlug, 'gym-cycle:dispatch', 'attempt');
  } catch (e) {
    log(`recordFire(attempt) failed (continuing): ${e instanceof Error ? e.message : e}`);
  }
  await deps.setAutoloop({
    workspaceId: chosen.workspaceId,
    harnessSlug: chosen.harnessSlug,
    status: 'running',
    now: now(),
  });

  try {
    const result = await deps.runCycle({
      harnessSlug: chosen.harnessSlug,
      workspaceId: chosen.workspaceId,
      budgetUsd: remaining,
      candidateDirections: directions,
    });

    // Settle: ACCUMULATE spend; breaker → paused; budget floor crossed → exhausted.
    const spentTotal = chosen.spentUsd + result.spentUsd;
    const left = chosen.budgetUsd! - spentTotal;
    const settledStatus = result.breakerTripped ? 'paused' : left > floor ? 'idle' : 'exhausted';
    const doneTs = now();
    await deps.setAutoloop({
      workspaceId: chosen.workspaceId,
      harnessSlug: chosen.harnessSlug,
      status: settledStatus,
      spentUsd: spentTotal,
      lastCycleAt: doneTs,
      now: doneTs,
    });
    try {
      await deps.recordFire(chosen.harnessSlug, `gym-cycle:${settledStatus}`, 'ok');
    } catch (e) {
      log(`recordFire(ok) failed: ${e instanceof Error ? e.message : e}`);
    }
    return {
      action: 'ran',
      harnessSlug: chosen.harnessSlug,
      eligibleCount: eligible.length,
      gateBlocked,
      candidateDirections: directions,
      result,
      settledStatus,
      ...reclaimExtra,
    };
  } catch (err) {
    // running → idle even on a cycle error: the fire-gate's error backoff is the
    // retry brake; a stuck 'running' status would dead-lock the autoloop instead.
    try {
      await deps.setAutoloop({
        workspaceId: chosen.workspaceId,
        harnessSlug: chosen.harnessSlug,
        status: 'idle',
        now: now(),
      });
    } catch (e) {
      log(`failed to settle status back to idle for ${chosen.harnessSlug}: ${e instanceof Error ? e.message : e}`);
    }
    try {
      // GYM-2 (gym-unwedge-scout-novelty-2026-07-02): record the VERBATIM error —
      // the bare 'gym-cycle:error' literal left a 12-day wedge undiagnosable (the
      // runbook's read-the-recorded-status-first rule found nothing to read).
      // Same EI-212 convention as blueprint-run's fire recorder.
      const detail = String(err instanceof Error ? err.message : err).replace(/\s+/g, ' ').slice(0, 200);
      await deps.recordFire(chosen.harnessSlug, `gym-cycle:error — ${detail}`, 'error');
    } catch (e) {
      log(`recordFire(error) failed: ${e instanceof Error ? e.message : e}`);
    }
    return {
      action: 'error',
      harnessSlug: chosen.harnessSlug,
      eligibleCount: eligible.length,
      gateBlocked,
      candidateDirections: directions,
      settledStatus: 'idle',
      error: err instanceof Error ? err.message : String(err),
      ...reclaimExtra,
    };
  }
}
