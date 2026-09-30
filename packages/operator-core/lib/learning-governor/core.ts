/**
 * Learning-governor CORE (self-learning-frontier-2026-06-12 P-003 / FB-01,
 * D-004) — the pure decision layer behind the ONE shared learning-spend
 * ledger (migration 244: harness_shared.learning_governor_loops +
 * learning_spend_events).
 *
 * The contract, generalizing the gym autoloop precedent (autoloop-tick.ts
 * `isEligibleAutoloop`: a null budget is deliberately INELIGIBLE for the
 * unattended path):
 *
 *   - Every unattended learning loop REGISTERS with the governor (a loop_id,
 *     a sub-budget, a priority). An UNREGISTERED or UNBUDGETED loop's
 *     preflight REFUSES — continuous operation requires an explicit cap.
 *   - All learning spend lands on one append-only event ledger, so total
 *     learning spend is a single visible number with per-loop drill-down.
 *   - Two budget kinds: 'lifetime' (accumulating cap the governor enforces —
 *     the gym pattern) and 'per-cycle' (each run capped by the loop itself —
 *     the scout pattern; the governor checks the cap EXISTS and ledgers the
 *     spend, the loop bounds each cycle).
 *   - Two enforcement modes: 'governor' (the preflight is the gate — every
 *     frontier loop, FB-04..FB-15) and 'native' (the loop's existing
 *     self-gate stays authoritative — the gym/scout registrant mirrors,
 *     zero behavior change per the P-003 migration requirement).
 *
 * Pure ⇒ unit-tested with zero PG / zero flags (core.test.ts). IO lives in
 * store.ts (injected Sql, control-plane style); the flag-gated glue the gym +
 * scout routine actions call lives in registrants.ts.
 */

/** Below this remaining lifetime budget a loop is not worth (or safe) firing — the gym floor, generalized. */
export const LEARNING_GOVERNOR_BUDGET_FLOOR_USD = 0.5;

/** 'lifetime' = accumulating cap enforced here (gym pattern); 'per-cycle' = each run capped by the loop (scout pattern). */
export type LearningBudgetKind = 'lifetime' | 'per-cycle';

/** 'governor' = the preflight gates the loop (frontier); 'native' = the loop self-gates, the row is a mirror (gym/scout). */
export type LearningEnforcement = 'governor' | 'native';

export interface LearningLoopRegistration {
  workspaceId: string;
  loopId: string;
  /** The pot the loop learns FOR (pot-scope-all-learnings P-004); null = pre-pot legacy or genuinely pot-less. */
  potSlug: string | null;
  displayName: string;
  budgetKind: LearningBudgetKind;
  /** NULL = unbudgeted ⇒ the unattended path refuses (D-004). */
  budgetUsd: number | null;
  spentUsd: number;
  /** Lower = more important when budgets contend. Gym mirrors 50, scout 60, frontier default 100. */
  priority: number;
  enabled: boolean;
  enforcement: LearningEnforcement;
  meta: Record<string, unknown> | null;
  registeredAt: number;
  updatedAt: number;
}

export type GovernorRefusal =
  /** The papercusp-learning-governor flag is OFF (the kill-switch) — nothing runs unattended through it. */
  | 'governor-dark'
  /** The preflight's IO failed — fail-CLOSED (an unattended loop must never spend on a broken ledger). */
  | 'governor-error'
  /** No registration row — register before running unattended. */
  | 'unregistered'
  /** Registration exists but enabled=false. */
  | 'disabled'
  /**
   * The POT this loop learns for is switched off (harness_shared.learning_pot_scope,
   * plan learning-pot-scope-gate-2026-08-30 D-001). Outranks 'disabled': it is the
   * master switch ABOVE the lane's own arming, and the lane's arming is deliberately
   * left untouched so switching the pot back on restores exactly what was armed.
   */
  | 'pot-disabled'
  /** budget_usd is NULL — an explicit cap is required for the unattended path. */
  | 'unbudgeted'
  /** Lifetime budget spent down to (or past) the floor. */
  | 'exhausted';

export interface GovernorVerdict {
  allow: boolean;
  reason?: GovernorRefusal;
  /**
   * lifetime: budget − spent (may be ≤ 0 when exhausted); per-cycle: the
   * per-run cap itself; null when there is no budget to reason about.
   */
  remainingUsd: number | null;
}

/** Remaining budget for a registration; per-cycle rows report their per-run cap. */
export function remainingLoopBudgetUsd(
  reg: Pick<LearningLoopRegistration, 'budgetKind' | 'budgetUsd' | 'spentUsd'>,
): number | null {
  if (reg.budgetUsd === null) return null;
  return reg.budgetKind === 'per-cycle' ? reg.budgetUsd : reg.budgetUsd - reg.spentUsd;
}

/**
 * The generalized gym rule: unregistered / disabled / unbudgeted ⇒ refuse;
 * a lifetime budget must have remaining strictly above the floor; a per-cycle
 * budget allows (the loop bounds each run at its cap — checkScoutBudget-style).
 *
 * `potEnabled` is the per-pot master switch (D-001). It is a PARAMETER rather
 * than a field on the registration because the pot gate lives in its own
 * relation and must stay readable — and overridable in tests — without a
 * registration row to hang it on. Pass `undefined` (the default) where the
 * caller has not resolved a pot: an UNRESOLVED pot is not a disabled pot, so
 * omitting it leaves the verdict exactly as it was before the gate existed.
 */
export function checkLoopVerdict(
  reg: LearningLoopRegistration | null | undefined,
  floorUsd: number = LEARNING_GOVERNOR_BUDGET_FLOOR_USD,
  potEnabled?: boolean,
): GovernorVerdict {
  if (!reg) return { allow: false, reason: 'unregistered', remainingUsd: null };
  // Checked BEFORE the lane's own arming: when a pot is switched off, every
  // lane under it must report the pot as the cause, not its own `disabled`
  // flag — which is not even set (the gate deliberately never writes it).
  if (potEnabled === false) {
    return { allow: false, reason: 'pot-disabled', remainingUsd: remainingLoopBudgetUsd(reg) };
  }
  if (!reg.enabled) return { allow: false, reason: 'disabled', remainingUsd: remainingLoopBudgetUsd(reg) };
  if (reg.budgetUsd === null) return { allow: false, reason: 'unbudgeted', remainingUsd: null };
  const remaining = remainingLoopBudgetUsd(reg)!;
  if (reg.budgetKind === 'per-cycle') return { allow: true, remainingUsd: remaining };
  if (remaining <= floorUsd) return { allow: false, reason: 'exhausted', remainingUsd: remaining };
  return { allow: true, remainingUsd: remaining };
}

// ---------------------------------------------------------------------------
// The one visible number (P-003 verification: total learning spend on one ledger)
// ---------------------------------------------------------------------------

export interface LearningLoopSummaryRow {
  loopId: string;
  displayName: string;
  budgetKind: LearningBudgetKind;
  budgetUsd: number | null;
  spentUsd: number;
  remainingUsd: number | null;
  priority: number;
  enabled: boolean;
  enforcement: LearningEnforcement;
}

export interface LearningSpendSummary {
  /** THE number: every registrant's ledgered spend, summed. */
  totalSpentUsd: number;
  /** Sum of explicit LIFETIME caps (per-cycle caps don't bound a total). Null when no lifetime budget is set anywhere. */
  totalLifetimeBudgetUsd: number | null;
  loopCount: number;
  /** Loops that would refuse unattended for want of a cap — the D-004 watch list. */
  unbudgetedLoopIds: string[];
  loops: LearningLoopSummaryRow[];
}

/** Pure rollup over the registry rows (priority order is the caller's listLearningLoops order). */
export function summarizeLearningSpend(regs: readonly LearningLoopRegistration[]): LearningSpendSummary {
  let totalSpent = 0;
  let totalLifetime: number | null = null;
  const unbudgeted: string[] = [];
  const loops: LearningLoopSummaryRow[] = [];
  for (const reg of regs) {
    totalSpent += reg.spentUsd;
    if (reg.budgetUsd === null) unbudgeted.push(reg.loopId);
    else if (reg.budgetKind === 'lifetime') totalLifetime = (totalLifetime ?? 0) + reg.budgetUsd;
    loops.push({
      loopId: reg.loopId,
      displayName: reg.displayName,
      budgetKind: reg.budgetKind,
      budgetUsd: reg.budgetUsd,
      spentUsd: reg.spentUsd,
      remainingUsd: remainingLoopBudgetUsd(reg),
      priority: reg.priority,
      enabled: reg.enabled,
      enforcement: reg.enforcement,
    });
  }
  return {
    totalSpentUsd: totalSpent,
    totalLifetimeBudgetUsd: totalLifetime,
    loopCount: regs.length,
    unbudgetedLoopIds: unbudgeted,
    loops,
  };
}

// ---------------------------------------------------------------------------
// Registrant mappings: gym + scout onto the governor (zero behavior change —
// their own budget stores stay authoritative; these rows mirror them)
// ---------------------------------------------------------------------------

export function gymLoopId(harnessSlug: string): string {
  return `gym:${harnessSlug}`;
}

export function scoutLoopId(harnessSlug: string): string {
  return `blender:${harnessSlug}`;
}

/** The `blender:` loop_id prefix — the workspace-ceiling rule sums every registrant under it. */
export const SCOUT_LOOP_ID_PREFIX = 'blender:';

/** Is this a per-hive scout registrant (`scout:<hive>`)? Used to scope the workspace ceiling. */
export function isScoutLoopId(loopId: string): boolean {
  return loopId.startsWith(SCOUT_LOOP_ID_PREFIX);
}

// ---------------------------------------------------------------------------
// P-051 — WORKSPACE-WIDE scout spend ceiling
//
// Scout is the one engine that multiplies (D-005): each hive carries its OWN
// `scout:<hive>` per-cycle registrant, and the per-cycle cap bounds ONE cycle —
// but it says nothing about the AGGREGATE across N hives. N armed hives, each
// individually under its small per-cycle cap, can still sum to a spend that
// saturates the shared Anthropic rate limit / operator daily budget. This rule
// is the missing aggregate gate: sum every `scout:<hive>` registrant's ledgered
// spend in the workspace and REFUSE a new scout cycle once the total crosses the
// ceiling — the per-hive caps bound each cycle, this bounds the fleet.
// ---------------------------------------------------------------------------

/**
 * Default workspace-wide scout spend ceiling (USD).
 *
 * OWNER-TUNABLE DESIGN POINT (P-051): this is the aggregate cap across ALL
 * `scout:<hive>` registrants before the workspace refuses new scout cycles. The
 * value is a deliberate, conservative starting point — ~$10 ≈ six full default
 * cycles (~$1.69 each) of headroom across the whole fleet per accounting window
 * — sized to protect the shared Anthropic rate limit + the operator daily budget,
 * NOT a researched optimum. Override per-workspace via the
 * `PAPERCUSP_SCOUT_WORKSPACE_CEILING_USD` env (see scout-ceiling.ts). Revisit
 * once real multi-hive scout spend data exists.
 */
export const DEFAULT_SCOUT_WORKSPACE_CEILING_USD = 10.0;

/**
 * The accounting window the ceiling is measured over — 24h rolling.
 *
 * The DEFAULT above was always documented as "headroom … per accounting window",
 * but until 2026-07-26 the gate summed LIFETIME `spent_usd` (which only ever
 * grows), so any long-lived workspace eventually froze scout permanently — live
 * incident: blender:papercusp had $456 of spend accumulated over a MONTH of
 * healthy operation judged against the $10 cap, gating every tick. The gate now
 * sums the governor's spend-EVENT ledger (learning_spend_events) within this
 * window, restoring the documented per-window semantics.
 */
export const SCOUT_WORKSPACE_CEILING_WINDOW_MS = 24 * 60 * 60 * 1000;

export type ScoutCeilingRefusal = 'workspace-ceiling-exceeded';

export interface ScoutWorkspaceCeilingVerdict {
  /** May a NEW scout cycle proceed (aggregate scout spend strictly below the ceiling)? */
  allow: boolean;
  reason?: ScoutCeilingRefusal;
  /** Σ ledgered spend across every `scout:<hive>` registrant in the workspace. */
  totalScoutSpentUsd: number;
  /** The ceiling this verdict was checked against. */
  ceilingUsd: number;
  /** ceiling − total (≤ 0 when exceeded). */
  remainingUsd: number;
  /** How many `scout:<hive>` registrants contributed to the sum (the fleet width). */
  scoutLoopCount: number;
}

/**
 * The pure workspace-ceiling rule: sum the ledgered `spentUsd` of EVERY
 * `scout:<hive>` registrant (gym + frontier loops are ignored — this gate is
 * scout-only), and refuse once that aggregate reaches the ceiling. A new cycle
 * is allowed only while the sum is STRICTLY below the cap (a cycle that would
 * land exactly on it is the first refusal), mirroring checkScoutBudget's
 * strictly-under semantics. Pure ⇒ unit-tested with zero PG.
 */
export function checkScoutWorkspaceCeiling(
  regs: readonly Pick<LearningLoopRegistration, 'loopId' | 'spentUsd'>[],
  ceilingUsd: number = DEFAULT_SCOUT_WORKSPACE_CEILING_USD,
): ScoutWorkspaceCeilingVerdict {
  let total = 0;
  let count = 0;
  for (const reg of regs) {
    if (!isScoutLoopId(reg.loopId)) continue;
    total += Math.max(0, reg.spentUsd);
    count += 1;
  }
  return scoutWorkspaceCeilingVerdict(total, count, ceilingUsd);
}

/**
 * The bare compare — verdict from an already-summed scout spend total. The gate
 * (scout-ceiling.ts) feeds it the WINDOWED sum (learning_spend_events within
 * SCOUT_WORKSPACE_CEILING_WINDOW_MS); checkScoutWorkspaceCeiling above feeds it
 * a lifetime registration sum (legacy shape, kept for the pure-rule tests).
 * A cycle is allowed only while the sum is STRICTLY below the cap.
 */
export function scoutWorkspaceCeilingVerdict(
  totalScoutSpentUsd: number,
  scoutLoopCount: number,
  ceilingUsd: number = DEFAULT_SCOUT_WORKSPACE_CEILING_USD,
): ScoutWorkspaceCeilingVerdict {
  const allow = totalScoutSpentUsd < ceilingUsd;
  return {
    allow,
    ...(allow ? {} : { reason: 'workspace-ceiling-exceeded' as const }),
    totalScoutSpentUsd,
    ceilingUsd,
    remainingUsd: ceilingUsd - totalScoutSpentUsd,
    scoutLoopCount,
  };
}

/** The mirror sync priority defaults (lower = more important when budgets contend). */
export const GYM_REGISTRANT_PRIORITY = 50;
export const SCOUT_REGISTRANT_PRIORITY = 60;

/** The slice of a gym autoloop row the mirror needs (structural — GymAutoloopConfig satisfies it). */
export interface GymAutoloopLike {
  workspaceId: string;
  harnessSlug: string;
  enabled: boolean;
  budgetUsd: number | null;
  spentUsd: number;
}

/** Shared registration-input shape (store.ts RegisterLearningLoopInput is a superset). */
export interface RegistrationInput {
  workspaceId: string;
  loopId: string;
  /** The pot the loop learns FOR (pot-scope-all-learnings P-004). */
  potSlug: string | null;
  displayName: string;
  budgetKind: LearningBudgetKind;
  budgetUsd: number | null;
  /** Mirror mode overwrites spent from the source of truth; omitted = preserve the ledgered value. */
  spentUsd?: number;
  priority: number;
  enabled: boolean;
  enforcement: LearningEnforcement;
}

/**
 * Gym autoloop row → governor mirror registration. gym_autoloop_config stays
 * the source of truth: budget AND spent are overwritten on every sync
 * (enforcement 'native' — the tick's own isEligibleAutoloop gate is the gate).
 */
export function gymRegistrationInput(cfg: GymAutoloopLike): RegistrationInput {
  return {
    workspaceId: cfg.workspaceId,
    loopId: gymLoopId(cfg.harnessSlug),
    // gym autoloops are per-hive by construction — the harness slug IS the pot.
    potSlug: cfg.harnessSlug,
    displayName: `Gym autoloop (${cfg.harnessSlug})`,
    budgetKind: 'lifetime',
    budgetUsd: cfg.budgetUsd,
    spentUsd: cfg.spentUsd,
    priority: GYM_REGISTRANT_PRIORITY,
    enabled: cfg.enabled,
    enforcement: 'native',
  };
}

/**
 * Scout cadence → governor mirror registration. Scout's budget is PER-CYCLE
 * (budget.ts maxCostUsd, resolved from the routine payload or the default);
 * spend ACCUMULATES on the governor ledger via recordLearningSpend, so spent
 * is never overwritten here (omitted = preserved).
 */
export function scoutRegistrationInput(opts: {
  workspaceId: string;
  harnessSlug: string;
  /**
   * The resolved pot the scout learns for (pot-scope-all-learnings P-004). When
   * present it is ALSO the loop-id grain — `blender:<pot>` — so the workspace-brain
   * scout ('papercusp-workspace' / '@singleton' install slugs) keys by its home pot
   * instead of minting workspace-shaped registrants. Null (unresolvable) falls back
   * to the install slug so a degraded process still budgets/ledgers consistently.
   */
  potSlug?: string | null;
  perCycleBudgetUsd: number;
}): RegistrationInput {
  const scope = opts.potSlug ?? opts.harnessSlug;
  return {
    workspaceId: opts.workspaceId,
    loopId: scoutLoopId(scope),
    potSlug: opts.potSlug ?? null,
    displayName: `Scout cadence (${scope})`,
    budgetKind: 'per-cycle',
    budgetUsd: opts.perCycleBudgetUsd,
    priority: SCOUT_REGISTRANT_PRIORITY,
    enabled: true,
    enforcement: 'native',
  };
}
