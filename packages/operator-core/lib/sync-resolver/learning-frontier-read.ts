/**
 * learning-frontier-read.ts — the read behind the Learning tab's "Frontier"
 * view (learning-tab-visibility-2026-07-18 P-003/P-004).
 *
 * One row per workspace-singleton learning loop, answering the three-gate
 * question the relight audit codified (a loop is live only when ALL of:
 * routine active + flag ON + governor budget):
 *
 *   1. **Liveness** — the SAME shared reader improvements:learning_loops
 *      renders from ({@link readLearningLoopHealth}) — firing / pending /
 *      stale / dark-by-design / should-be-on-but-dark / absent.
 *   2. **Flag gate** — each lane's feature flag, resolved live. The
 *      lane→flag map is pinned here and asserted complete against
 *      LEARNING_SINGLETONS by the unit test, so a new loop cannot be added
 *      without deciding its flag column.
 *   3. **Governor budget** — the FB-01 registration (READ-ONLY by owner
 *      decision 2026-07-18): budget / spent / enabled / enforcement. Rows
 *      that match no lane are surfaced in `unmatchedGovernor`, never hidden.
 *
 * Every leg fails soft (a missing migration blanks that leg, never a 500) —
 * the sibling learning.* reads' posture — and BOUNDED, so a leg that merely
 * HANGS degrades like one that throws (see FRONTIER_BUDGET_MS below).
 */
import type { Sql } from 'postgres';
import { FLAGS, type FlagKey } from '@papercusp/flags';
import type { LearningLoopHealth } from '../blueprint/learning-loop-health';
import { createReadDeadline, type WithinBudget } from './read-deadline';

/**
 * Whole-read budget for the Frontier grid, in ms — under the ~10s
 * RESOLVER_READ_TIMEOUT_MS (see ./read-deadline).
 *
 * Why this read needs a SHARED deadline rather than a per-leg budget: the four
 * legs below run SEQUENTIALLY, so four independent 6s budgets would total 24s
 * and overrun by 2.4x the very timeout the bound exists to stay under. One
 * deadline shared by every leg cannot — whatever leg 1 spends, leg 4 has less.
 *
 * The per-leg `try/catch`es fail-soft a leg that THROWS but bound nothing for a
 * leg that HANGS, and the resolver's outer catch only degrades on a throw too —
 * so one wedged reader blew the resolver timeout and 500'd the whole grid,
 * which could not then ship the `degraded()` snapshot it computes for exactly
 * this case (EI-20801200386596605; same defect as WI-39813 / releaseReadiness).
 */
const FRONTIER_BUDGET_MS = 6_000;

/** Untyped row bag from a raw tagged-template query (the gym control-plane idiom). */
type Row = Record<string, unknown>;

/**
 * blueprintId → the feature flag gating that lane's behavior, or null for a
 * lane with no flag gate (always-on by construction). Kept as data so the
 * grid's flag column derives from the flag registry, never a hardcoded
 * boolean. Completeness vs LEARNING_SINGLETONS is unit-asserted.
 */
export const FRONTIER_LANE_FLAGS: Record<string, FlagKey | null> = {
  graduation: FLAGS.GRADUATION_TRACKER,
  'negative-space': FLAGS.NEGATIVE_SPACE_MINER,
  neologism: FLAGS.NEOLOGISM_MINER,
  'fleet-ekg': FLAGS.FLEET_EKG,
  calibration: FLAGS.CALIBRATION_MARKETS,
  'deferral-interest': FLAGS.DEFERRAL_INTEREST,
  'prompt-ablation': FLAGS.PROMPT_ABLATION,
  regret: FLAGS.REGRET_MINING,
  transfer: FLAGS.TRANSFER_HARNESS,
  'red-queen': FLAGS.RED_QUEEN,
  'change-ledger': FLAGS.CHANGE_LEDGER,
  scout: null, // always-on by construction (ALWAYS_ON_LEARNING_LOOPS)
  'iq-battery': null, // always-on by construction
  'memory-precision': FLAGS.MEMORY_PRECISION_BENCH,
  'memory-live-recall-canary': FLAGS.MEMORY_LIVE_RECALL_CANARY,
};

/** The governor registration slice the grid renders (read-only). */
export interface FrontierGovernorInfo {
  loopId: string;
  /** The pot the registration is keyed to (migration 659 / P-004 re-key); null
   *  for a pre-re-key row that the backfill could not attribute. */
  potSlug: string | null;
  budgetUsd: number | null;
  spentUsd: number;
  budgetKind: string;
  enabled: boolean;
  enforcement: string;
  priority: number;
}

export interface FrontierLaneSnapshot {
  blueprintId: string;
  alwaysOn: boolean;
  /** firing | pending | stale | dark-by-design | should-be-on-but-dark | absent */
  status: LearningLoopHealth['status'];
  active: boolean;
  collision: boolean;
  expectedMaterialized: boolean;
  lastFiredAt: string | null;
  daysSinceFire: number | null;
  activityLastAt: string | null;
  activitySource: string | null;
  /** The lane's gating feature flag key, or null when always-on/no gate. */
  flagKey: string | null;
  /** Resolved flag state; null when the lane has no flag or the read degraded. */
  flagOn: boolean | null;
  /** The lane's pot identity, via its matched governor registration; null when
   *  the lane has no registration (pot-agnostic workspace machinery). */
  potSlug: string | null;
  /** FB-01 governor registration (read-only), when one matches this lane. */
  governor: FrontierGovernorInfo | null;
  /** WI-5800: what this lane has produced; null when the lane has no outcome
   *  table wired yet (or its read degraded) — never a fabricated zero. */
  outcome?: FrontierLaneOutcome | null;
}

export interface FrontierSnapshot {
  lanes: FrontierLaneSnapshot[];
  /** Governor rows matching no lane — surfaced, never silently dropped. */
  unmatchedGovernor: FrontierGovernorInfo[];
  generatedAt: string;
}

/**
 * WI-5800 (owner ask 2026-07-25): what a lane has actually PRODUCED.
 *
 * The panel could previously only say a lane was firing — never whether it
 * yielded anything, so a loop that ticked forever and produced nothing (or
 * produced findings it never validated) read identically to a healthy one.
 * `closure` is the load-bearing field: it states whether the loop CLOSES,
 * which is the difference between "learning" and "burning tokens".
 */
export interface FrontierLaneOutcome {
  /** Artifacts produced all-time. */
  total: number;
  /** Produced in the last 7 days — is it still producing? */
  recent7d: number;
  /** ISO timestamp of the newest artifact; null when the lane produced none. */
  newestAt: string | null;
  /** Display chips, pre-ordered. */
  breakdown: Array<{ label: string; n: number; tone?: 'good' | 'warn' | 'bad' | 'mute' }>;
  /** One-line verdict on whether the loop closes. */
  closure: string;
  /** Tone for `closure` — 'bad'/'warn' means the loop is not closing. */
  closureTone: 'good' | 'warn' | 'bad' | 'mute';
}

/**
 * Leg 4 — per-lane outcome rollups, one query per producing lane. Every lane
 * degrades INDEPENDENTLY (a missing table ⇒ that lane reads no outcome, never
 * a failed snapshot), matching the other legs' fail-soft contract. Lanes with
 * no outcome table yet simply have no entry.
 *
 * PASS `withinBudget` (WI-39817). Without it the per-lane try/catch below is
 * fail-soft for a lane that THROWS and nothing at all for a lane that HANGS:
 * `Promise.all` waits for the slowest lane, so one wedged store costs all four
 * rollups — including the three that had already returned. That is the exact
 * "per-leg error handling is NOT leg isolation" distinction this class exists
 * to make (see read-deadline.ts, WI-39813). Bounding each lane by the caller's
 * SHARED deadline means a wedged lane loses only itself.
 *
 * The parameter is optional so the fail-soft contract still holds for a caller
 * that has no deadline to give — it simply degrades at whole-rollup
 * granularity, exactly as it did before.
 */
export async function readLaneOutcomes(
  sql: Sql,
  workspaceId: string,
  withinBudget?: WithinBudget,
): Promise<Record<string, FrontierLaneOutcome>> {
  const out: Record<string, FrontierLaneOutcome> = {};
  const num = (v: unknown): number => Number(v ?? 0);
  const iso = (v: unknown): string | null =>
    v == null ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
  const leg = async (id: string, run: () => Promise<FrontierLaneOutcome | null>) => {
    try {
      // The bound must wrap the AWAITED promise, not sit downstream of it — a
      // deadline applied after the await cannot interrupt a hang.
      const r = await (withinBudget ? withinBudget(run(), `lane-outcome:${id}`) : run());
      if (r) out[id] = r;
    } catch (err) {
      console.warn(`[learning.frontier] outcome read failed for ${id}:`, err instanceof Error ? err.message : err);
    }
  };

  await Promise.all([
    leg('calibration', async () => {
      const [r] = (await sql`
        SELECT count(*) total,
               count(*) FILTER (WHERE created_at > now() - interval '7 days') recent7d,
               max(created_at) newest,
               count(*) FILTER (WHERE outcome IS TRUE) correct,
               count(*) FILTER (WHERE outcome IS FALSE) wrong,
               count(*) FILTER (WHERE resolved_at IS NULL) unresolved,
               count(*) FILTER (WHERE resolved_at IS NULL AND horizon_ts < now()) overdue
          FROM harness_shared.calibration_predictions
         WHERE workspace_id = ${workspaceId}`) as Row[];
      if (!r || num(r.total) === 0) return null;
      const correct = num(r.correct);
      const resolved = correct + num(r.wrong);
      const overdue = num(r.overdue);
      const pct = resolved > 0 ? Math.round((correct / resolved) * 100) : null;
      return {
        total: num(r.total),
        recent7d: num(r.recent7d),
        newestAt: iso(r.newest),
        breakdown: [
          { label: 'right', n: correct, tone: 'good' },
          { label: 'wrong', n: num(r.wrong), tone: 'mute' },
          { label: 'open', n: num(r.unresolved), tone: 'mute' },
          ...(overdue > 0 ? [{ label: 'overdue', n: overdue, tone: 'warn' as const }] : []),
        ],
        closure:
          pct == null
            ? 'no bets resolved yet'
            : `${resolved} bets resolved · ${pct}% called correctly`,
        closureTone: pct == null ? 'warn' : 'good',
      };
    }),

    leg('regret', async () => {
      const [r] = (await sql`
        SELECT count(*) total,
               count(*) FILTER (WHERE mined_at > now() - interval '7 days') recent7d,
               max(mined_at) newest,
               count(*) FILTER (WHERE replay_status = 'replayed') replayed,
               count(*) FILTER (WHERE replay_status = 'skipped') skipped
          FROM harness_shared.regret_findings
         WHERE workspace_id = ${workspaceId}`) as Row[];
      if (!r || num(r.total) === 0) return null;
      const replayed = num(r.replayed);
      const total = num(r.total);
      return {
        total,
        recent7d: num(r.recent7d),
        newestAt: iso(r.newest),
        breakdown: [
          { label: 'replayed', n: replayed, tone: 'good' },
          { label: 'skipped', n: num(r.skipped), tone: 'mute' },
        ],
        closure: `${replayed} of ${total} findings replayed`,
        closureTone: replayed === 0 ? 'bad' : replayed / total >= 0.5 ? 'good' : 'warn',
      };
    }),

    leg('transfer', async () => {
      const [r] = (await sql`
        SELECT count(*) total,
               count(*) FILTER (WHERE created_at > now() - interval '7 days') recent7d,
               max(created_at) newest,
               count(*) FILTER (WHERE test_count > 0) tested,
               count(*) FILTER (WHERE tier = 'probationary') probationary,
               count(*) FILTER (WHERE tier = 'trusted') trusted
          FROM harness_shared.transfer_lessons
         WHERE workspace_id = ${workspaceId}`) as Row[];
      if (!r || num(r.total) === 0) return null;
      const tested = num(r.tested);
      const total = num(r.total);
      return {
        total,
        recent7d: num(r.recent7d),
        newestAt: iso(r.newest),
        breakdown: [
          { label: 'trusted', n: num(r.trusted), tone: 'good' },
          { label: 'probationary', n: num(r.probationary), tone: 'mute' },
          { label: 'tested', n: tested, tone: tested === 0 ? 'bad' : 'good' },
        ],
        // The whole point of the transfer harness is to TEST a distilled lesson;
        // minting lessons nothing ever tests is the loop failing open.
        closure:
          tested === 0
            ? `${total} lessons distilled, none ever tested — loop does not close`
            : `${tested} of ${total} lessons tested`,
        closureTone: tested === 0 ? 'bad' : tested / total >= 0.5 ? 'good' : 'warn',
      };
    }),

    leg('prompt-ablation', async () => {
      const [r] = (await sql`
        SELECT count(*) total,
               count(*) FILTER (WHERE started_at > now() - interval '7 days') recent7d,
               max(started_at) newest,
               count(*) FILTER (WHERE verdict = 'load-bearing') load_bearing,
               count(*) FILTER (WHERE verdict = 'no-delta') no_delta,
               count(*) FILTER (WHERE verdict = 'inconclusive') inconclusive
          FROM harness_shared.prompt_ablation_runs
         WHERE workspace_id = ${workspaceId}`) as Row[];
      if (!r || num(r.total) === 0) return null;
      const total = num(r.total);
      const inconclusive = num(r.inconclusive);
      const decisive = total - inconclusive;
      return {
        total,
        recent7d: num(r.recent7d),
        newestAt: iso(r.newest),
        breakdown: [
          { label: 'load-bearing', n: num(r.load_bearing), tone: 'good' },
          { label: 'no-delta', n: num(r.no_delta), tone: 'mute' },
          { label: 'inconclusive', n: inconclusive, tone: inconclusive > decisive ? 'warn' : 'mute' },
        ],
        closure: `${decisive} of ${total} runs reached a verdict`,
        closureTone: decisive === 0 ? 'bad' : decisive / total >= 0.5 ? 'good' : 'warn',
      };
    }),
  ]);

  return out;
}

/** Tolerant lane↔registration match: exact id, `<id>:…` (the gym:/blender:
 *  per-harness convention), or an id embedded in a longer loopId. */
export function governorRowMatchesLane(loopId: string, blueprintId: string): boolean {
  if (loopId === blueprintId) return true;
  if (loopId.startsWith(`${blueprintId}:`)) return true;
  // scout registers under the blender: prefix (scoutLoopId), not its blueprint id.
  if (blueprintId === 'scout' && loopId.startsWith('blender:')) return true;
  return loopId.includes(blueprintId);
}

export async function readFrontierSnapshot(
  sql: Sql,
  workspaceId: string,
  opts: { hive?: string | null; budgetMs?: number } = {},
): Promise<FrontierSnapshot> {
  const hive = typeof opts.hive === 'string' && opts.hive.trim() ? opts.hive.trim() : null;
  // ONE deadline shared by all four sequential legs, so a hung leg is routed
  // into the `catch` that already handles a failing one instead of taking the
  // whole grid down (FRONTIER_BUDGET_MS).
  const withinBudget = createReadDeadline(opts.budgetMs ?? FRONTIER_BUDGET_MS);

  // Leg 1 — liveness, from the shared reader (never re-derived).
  let health: LearningLoopHealth[] = [];
  try {
    const { readLearningLoopHealth } = await import('../blueprint/learning-loop-read');
    health = await withinBudget(readLearningLoopHealth(sql, workspaceId), 'loop-health');
  } catch (err) {
    console.warn('[learning.frontier] loop-health read failed:', err instanceof Error ? err.message : err);
  }

  // Leg 2 — flag gates, resolved live; a failed resolution reads null (unknown).
  const flagStates = new Map<string, boolean>();
  try {
    const { getFlag } = await import('@papercusp/flags/server');
    const keys = [...new Set(Object.values(FRONTIER_LANE_FLAGS).filter((k): k is FlagKey => k != null))];
    await withinBudget(
      Promise.all(
        keys.map(async (key) => {
          try {
            flagStates.set(key, await getFlag(key, 'system'));
          } catch {
            /* leave unknown */
          }
        }),
      ),
      'flag-gates',
    );
  } catch (err) {
    console.warn('[learning.frontier] flag read failed:', err instanceof Error ? err.message : err);
  }

  // Leg 3 — governor registrations (read-only slice).
  let governorRows: FrontierGovernorInfo[] = [];
  try {
    const { listLearningLoops } = await import('../learning-governor/store');
    const regs = await withinBudget(listLearningLoops(sql, { workspaceId }), 'governor-registrations');
    governorRows = regs.map((r) => ({
      loopId: r.loopId,
      potSlug: r.potSlug ?? null,
      budgetUsd: r.budgetUsd,
      spentUsd: r.spentUsd,
      budgetKind: r.budgetKind,
      enabled: r.enabled,
      enforcement: r.enforcement,
      priority: r.priority,
    }));
  } catch (err) {
    console.warn('[learning.frontier] governor read failed:', err instanceof Error ? err.message : err);
  }

  // Leg 4 — per-lane outcome rollups (WI-5800). Fail-soft as a whole AND per
  // lane, for a lane that HANGS as well as one that throws (WI-39817).
  //
  // The deadline is threaded IN rather than wrapped AROUND, deliberately. Each
  // lane is bounded individually, so `readLaneOutcomes` always resolves by the
  // deadline and returns whatever lanes did finish. Wrapping the whole call as
  // well would defeat that: both bounds expire on the same shared deadline, and
  // the outer rejection would discard the partial rollups the inner legs just
  // preserved. The try/catch stays as the backstop for a non-leg failure.
  let outcomes: Record<string, FrontierLaneOutcome> = {};
  try {
    outcomes = await readLaneOutcomes(sql, workspaceId, withinBudget);
  } catch (err) {
    console.warn('[learning.frontier] outcome rollup failed:', err instanceof Error ? err.message : err);
  }

  const matched = new Set<string>();
  const lanes: FrontierLaneSnapshot[] = health.map((h) => {
    const flagKey = FRONTIER_LANE_FLAGS[h.blueprintId] ?? null;
    const gov = governorRows.find((g) => governorRowMatchesLane(g.loopId, h.blueprintId)) ?? null;
    if (gov) matched.add(gov.loopId);
    return {
      blueprintId: h.blueprintId,
      alwaysOn: h.alwaysOn,
      status: h.status,
      active: h.active,
      collision: h.collision,
      expectedMaterialized: h.expectedMaterialized,
      lastFiredAt: h.lastFiredAt,
      daysSinceFire: h.daysSinceFire,
      activityLastAt: h.activityLastAt,
      activitySource: h.activitySource,
      flagKey,
      flagOn: flagKey == null ? null : (flagStates.get(flagKey) ?? null),
      potSlug: gov?.potSlug ?? null,
      governor: gov,
      outcome: outcomes[h.blueprintId] ?? null,
    };
  });

  const unmatched = governorRows.filter((g) => !matched.has(g.loopId));
  return {
    ...applyFrontierPotLens(lanes, unmatched, hive),
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Pot lens (pot-scope-all-learnings P-005), pure so the contract is pinnable:
 * a lane whose governor registration belongs to ANOTHER pot is dropped; a lane
 * with no pot identity is workspace MACHINERY liveness and stays visible under
 * every lens — hiding it would render most pot lenses as "every loop dead".
 * Governor registrations are pot-scoped rows, so the unmatched list filters
 * strictly (a null pot is excluded under any lens, D-002).
 */
export function applyFrontierPotLens(
  lanes: FrontierLaneSnapshot[],
  unmatchedGovernor: FrontierGovernorInfo[],
  hive: string | null,
): Pick<FrontierSnapshot, 'lanes' | 'unmatchedGovernor'> {
  if (!hive) return { lanes, unmatchedGovernor };
  return {
    lanes: lanes.filter((l) => l.potSlug == null || l.potSlug === hive),
    unmatchedGovernor: unmatchedGovernor.filter((g) => g.potSlug === hive),
  };
}
