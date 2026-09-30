/**
 * portfolio-throughput.ts — the resolver behind the `goal.portfolioThroughput`
 * cell (goal-mode-drift-guards-2026-08-31 P-002).
 *
 * ONE derivation. `activity.ts` owns the pure fold, `portfolio-acts.ts` owns the
 * verb set, and this module is the only place that MEASURES either against the
 * ledger. Every surface — the cell read, the subscription poll, the watchdog leg
 * — projects this result and none re-derives it (state-plane axis 5).
 *
 * ── WHO COUNTS AS "THE GOAL" ────────────────────────────────────────────────
 *
 * The subject is the goal's HOLDERS, not its descendants, and that line is load-
 * bearing rather than incidental. `kickoff-evidence.ts` already draws it for the
 * adjacent gate: "The gate applies only to the session that HOLDS mode='goal'.
 * Descendants may inherit goal provenance through session_briefs.goal_id, but
 * they implement the work and must not inherit the portfolio-manager kickoff
 * gate." The same asymmetry decides this measurement, and inverting it would be
 * self-defeating: a steward that placed one fleet and then went quiet for four
 * hours would keep reading BUSY on its fleet's activity, which is precisely the
 * $109 case wearing a disguise. A steward is measured on what IT places.
 *
 * ── AND WHY DEAD HOLDERS STILL COUNT ────────────────────────────────────────
 *
 * Every goal-mode row is included, not just the elected-and-live one. The
 * precedent is `spend-rollup.ts`, allowlisted out of the raw-holder-read guard
 * for exactly this reason: "A holder that has since died still SPENT what it
 * spent, so filtering the membership set by present-tense liveness would
 * silently under-report." An act is the same kind of fact as a dollar. A goal
 * whose holder placed three fleets and was then respawned has not become idle
 * because the agent that did the work is gone — and under-reporting here points
 * the wrong way, at a BUSY goal being called idle.
 *
 * The read goes through `resolveGoalHolders`, the sanctioned entry point, so no
 * allowlist entry in `check-no-raw-goal-holder-read.mjs` is needed or wanted.
 *
 * ── ONLY SUCCESSFUL ACTS COUNT ──────────────────────────────────────────────
 *
 * `status = 'ok'`. A REFUSED `fleet:launch-on-plan` placed nothing; counting the
 * attempt would let a steward look productive by failing repeatedly, which is a
 * worse state than idling and would read as healthier.
 */

import type { Sql } from 'postgres';

import {
  GOAL_PORTFOLIO_IDLE_AFTER_MS,
  resolveGoalPortfolioIdle,
  type GoalPortfolioVerdict,
} from './activity';
import { resolveGoalHolders, type GoalHolderLiveness, type GoalHolders } from './holder';
import {
  PORTFOLIO_ACT_TOOLS,
  PORTFOLIO_CONDITIONAL_ACTS,
  portfolioActFacet,
  type PortfolioActFacet,
} from './portfolio-acts';

/** The rate window. "Acts per hour" is the unit P-002 asks for, so an hour it is. */
export const GOAL_PORTFOLIO_WINDOW_MS = 60 * 60_000;

/**
 * How far back the ledger scan may reach when looking for the LAST act.
 *
 * The window above bounds the RATE; this bounds the search for `lastActAtMs`,
 * which must be able to precede the window or a goal quiet for two hours would
 * report "never placed anything" identically to one held for two minutes.
 *
 * Floored rather than unbounded, and the direction of the error is deliberate:
 * a goal held longer than the floor with no act inside it reports an idleMs of
 * (at most) the floor, i.e. it UNDER-states idleness. Under-stating can only
 * ever delay an alarm; over-stating would manufacture one against a steward
 * whose last act simply fell off the edge of the scan.
 */
export const GOAL_PORTFOLIO_LOOKBACK_FLOOR_MS = 7 * 24 * 60 * 60_000;

/** Why the measurement could not be made. Result-level, so a hurried caller cannot miss it. */
export interface GoalPortfolioUnavailable {
  code: 'no-holder-rows' | 'liveness-unresolved' | 'ledger-unreadable';
  detail: string;
}

/**
 * The assessment vocabulary. CLOSED, and deliberately disjoint from
 * `CellUnknownCode` — `evidence-unavailable` rather than `not-measured`, so a
 * domain finding about the goal can never be confused with the read apparatus
 * failing (the collision `validateCellSpec` refuses outright).
 */
export type GoalPortfolioAssessment =
  | 'placing'
  | 'within-grace'
  | 'idle-past-threshold'
  | 'not-held'
  | 'evidence-unavailable';

export interface GoalPortfolioThroughputRead {
  goalId: string;
  workspaceId: string;
  /** The rate window actually used, in minutes. */
  windowMinutes: number;
  /** Successful portfolio acts by this goal's holders inside the window. */
  actsInWindow: number;
  /** `actsInWindow` normalised to an hourly rate, 2dp. */
  actsPerHour: number;
  /** ms epoch of the most recent portfolio act found, or null if none in the lookback. */
  lastActAtMs: number | null;
  /** The tool name of that act — evidence that the count is measuring what it claims. */
  lastActTool: string | null;
  /** Which facet that act belonged to (create / place / steer). */
  lastActFacet: PortfolioActFacet | null;
  /**
   * THE HEADLINE. Minutes since the last portfolio act, or since the goal was
   * first held when there has never been one. Null only when unmeasurable.
   */
  idleMinutes: number | null;
  /** The threshold this reading is judged against, so the number carries its own scale. */
  idleAfterMinutes: number;
  /** How many holder identities the count ranged over — 0 explains an unavailable read. */
  measuredOwnerIds: number;
  /** Holder liveness as the fold saw it. */
  holderLiveness: GoalHolderLiveness | null;
  /** THE MATERIAL ANSWER: is this goal placing nothing? */
  idle: boolean;
  /** Why the verdict is what it is (see `GoalPortfolioVerdict`). */
  reason: GoalPortfolioVerdict['reason'];
  /** The declared semantic code. */
  assessment: GoalPortfolioAssessment;
  /** Result-level unknown hoist. Null on a measured read. */
  unavailable: GoalPortfolioUnavailable | null;
}

/**
 * Reason → assessment code. One mapping, so a surface never invents its own.
 *
 * EXPORTED so it can be PINNED. `readCell` enforces a CLOSED code vocabulary: a
 * code the cell's registration never declared is not passed through, it silently
 * DOWNGRADES the whole read to `unavailable`. So a drift between this function's
 * image and `GOAL_PORTFOLIO_THROUGHPUT_CELL.assessment.codes` would not fail
 * anywhere — it would quietly turn every read of a healthy resolver into "no
 * semantics available", which is indistinguishable from the cell being broken.
 * `portfolio-acts.test.ts` asserts the two sets are equal in both directions.
 */
export function portfolioAssessmentFor(
  reason: GoalPortfolioVerdict['reason'],
): GoalPortfolioAssessment {
  switch (reason) {
    case 'idle':
      return 'idle-past-threshold';
    case 'placing':
      return 'placing';
    case 'within-grace':
      return 'within-grace';
    case 'not-held':
      return 'not-held';
    case 'not-measured':
      return 'evidence-unavailable';
  }
}

function minutes(ms: number | null): number | null {
  return ms == null ? null : Math.max(0, Math.round(ms / 60_000));
}

/**
 * The ledger predicate for "this row is a portfolio act" — `isPortfolioAct`
 * stated once for SQL, derived from the same two constants so the TS and the
 * scan cannot disagree about membership.
 *
 * By NAME for the canonical set. By ARGUMENTS for a conditional act, in the two
 * polarities `PortfolioConditionalAct` defines:
 *
 *  • PRESENCE (default) — the row's `args_json` carries the act's key at the top
 *    level, or, batch form, any element of its `batchKey` array does. `?` is
 *    jsonb key-existence, so a deliberate `null` (a release) still counts,
 *    matching `argsCarryConditionalKey`. The `jsonb_typeof` guard keeps
 *    `jsonb_array_elements` off a scalar, which would otherwise raise and turn
 *    the whole read into `ledger-unreadable`.
 *  • `default-act` — the act is the DEFAULT and named clauses opt out, so the row
 *    matches unless one of them holds. A VALUED clause is equality on the raw
 *    jsonb; a VALUELESS one is truthiness, spelled as the four falsy JSON
 *    literals so it means exactly what `optOutHolds`'s `Boolean(v)` means.
 *
 * ⚠ The `jsonb_typeof(ti.args_json) = 'object'` guard on the default-act leg is
 * the SQL half of `argsSatisfyConditionalAct`'s conservative floor, and it is
 * load-bearing rather than defensive: a row whose `args_json` is NULL or a scalar
 * has no keys, so no opt-out clause can hold and EVERY argument-less row would
 * score as an act. `jsonb_typeof(NULL)` is NULL, so the one guard covers both
 * shapes.
 *
 * ⚠⚠ EVERY CLAUSE MUST BE NULL-SAFE, and this is the trap that actually bit —
 * caught only by EXECUTING the predicate, because a test that pins the rendered
 * SQL text agrees with a query that returns the wrong rows.
 *
 * `->` yields SQL NULL for an absent key, and three-valued logic then eats the
 * whole leg in BOTH obvious spellings:
 *   • `key <> value`                → NULL for an absent key.
 *   • `NOT (key = value OR …)`      → `NOT (NULL OR false)` → NULL.
 * Either way the row is not counted, and the DEFAULT filing — a capture with no
 * `lane` at all, i.e. the single most common real act — silently scores zero.
 * That is the exact false-IDLE bug this entry exists to fix, reintroduced one
 * layer down. Measured before the fix: 9 capture calls in the motivating window
 * scored 0 acts, not 5.
 *
 * So the valued clause is `IS NOT DISTINCT FROM` (NULL-safe equality: an absent
 * key is cleanly NOT the opt-out value), and the truthy clause guards with
 * `IS NOT NULL AND` before its `NOT IN`. Both then return a strict boolean, which
 * is what makes the enclosing `NOT (… OR …)` mean what it reads as.
 *
 * EXPORTED for the pin in `portfolio-acts.test.ts`, which renders it through a
 * recording tag and asserts every leg is present with the right parameters.
 */
export function portfolioActLedgerPredicate(sql: Sql) {
  const byName = sql`ti.tool_name = ANY(${PORTFOLIO_ACT_TOOLS as string[]}::text[])`;
  const byArgs = PORTFOLIO_CONDITIONAL_ACTS.map((act) => {
    if (act.rule === 'default-act') {
      const optedOut = act.optOut
        .map((clause) =>
          clause.value == null
            ? sql`((ti.args_json -> ${clause.key}::text) IS NOT NULL
                   AND (ti.args_json -> ${clause.key}::text) NOT IN ('false'::jsonb, 'null'::jsonb, '0'::jsonb, '""'::jsonb))`
            : sql`((ti.args_json -> ${clause.key}::text) IS NOT DISTINCT FROM to_jsonb(${clause.value}::text))`,
        )
        .reduce((acc, c) => sql`(${acc} OR ${c})`);
      return sql`(ti.tool_name = ${act.tool} AND jsonb_typeof(ti.args_json) = 'object'
            AND NOT ${optedOut})`;
    }
    return act.batchKey == null
      ? sql`(ti.tool_name = ${act.tool} AND ti.args_json ? ${act.argKey}::text)`
      : sql`(ti.tool_name = ${act.tool} AND (
            ti.args_json ? ${act.argKey}::text
            OR (jsonb_typeof(ti.args_json -> ${act.batchKey}::text) = 'array'
                AND EXISTS (SELECT 1 FROM jsonb_array_elements(ti.args_json -> ${act.batchKey}::text) el
                             WHERE el ? ${act.argKey}::text))
          ))`;
  });
  return [byName, ...byArgs].reduce((acc, p) => sql`(${acc} OR ${p})`);
}

function build(
  base: Pick<GoalPortfolioThroughputRead, 'goalId' | 'workspaceId'>,
  fields: Partial<GoalPortfolioThroughputRead>,
  verdict: GoalPortfolioVerdict,
): GoalPortfolioThroughputRead {
  return {
    goalId: base.goalId,
    workspaceId: base.workspaceId,
    windowMinutes: GOAL_PORTFOLIO_WINDOW_MS / 60_000,
    actsInWindow: 0,
    actsPerHour: 0,
    lastActAtMs: null,
    lastActTool: null,
    lastActFacet: null,
    idleMinutes: null,
    idleAfterMinutes: GOAL_PORTFOLIO_IDLE_AFTER_MS / 60_000,
    measuredOwnerIds: 0,
    holderLiveness: null,
    idle: verdict.idle,
    reason: verdict.reason,
    assessment: portfolioAssessmentFor(verdict.reason),
    unavailable: null,
    ...fields,
  };
}

/**
 * Measure one goal's portfolio throughput.
 *
 * Never throws for a ledger failure: an unreadable ledger becomes a hoisted
 * `ledger-unreadable` with `idle: false`, because the alternative — letting the
 * exception escape — turns a degraded read into a cell-level `resolver-failed`
 * that says nothing about WHICH leg broke, and a swallowed one that returned
 * zero acts would manufacture the alarm this module exists to make trustworthy.
 */
export async function readGoalPortfolioThroughput(
  sql: Sql,
  opts: {
    workspaceId: string;
    goalId: string;
    windowMs?: number;
    idleAfterMs?: number;
    nowMs?: number;
    /**
     * An ALREADY-RESOLVED holder read, when the caller has one.
     *
     * `goals:get` resolves holders for its own `holderLiveness`/`deactivated`
     * fold immediately before calling this, and `resolveGoalHolders` costs a
     * ledger read plus a liveness-oracle round trip. Re-resolving would not just
     * be wasteful: two reads taken milliseconds apart can DISAGREE, and the door
     * would then report a liveness in one field that the throughput verdict in
     * the next field was not computed from. Threading the same object through is
     * axis 5 applied within one response — one derivation, many lenses.
     */
    holders?: GoalHolders;
  },
): Promise<GoalPortfolioThroughputRead> {
  const base = { goalId: opts.goalId, workspaceId: opts.workspaceId };
  const nowMs = opts.nowMs ?? Date.now();
  const windowMs = opts.windowMs ?? GOAL_PORTFOLIO_WINDOW_MS;
  const idleAfterMs = opts.idleAfterMs ?? GOAL_PORTFOLIO_IDLE_AFTER_MS;
  const windowMinutes = Math.max(1, Math.round(windowMs / 60_000));

  const holders =
    opts.holders ??
    (await resolveGoalHolders(sql, {
      workspaceId: opts.workspaceId,
      goalId: opts.goalId,
    }));
  const ownerIds = [...new Set(holders.holders.map((h) => h.ownerId))];

  if (ownerIds.length === 0) {
    // No goal-mode row at all. `holder.ts` already calls this `unheld`; the fold
    // renders it `not-held` and this hoists WHY, so the zero above is never read
    // as a measured zero.
    const verdict = resolveGoalPortfolioIdle({ liveness: holders.liveness, idleAfterMs });
    return build(base, {
      windowMinutes,
      holderLiveness: holders.liveness,
      unavailable: {
        code: 'no-holder-rows',
        detail: `no agent_modes goal-mode row names goal "${opts.goalId}", so there is no subject whose portfolio acts could be counted. This is an ABSENT subject, not a measured zero.`,
      },
    }, verdict);
  }

  // The earliest moment anyone held this goal — the clock a never-placing
  // steward is measured against.
  const heldSinceMs = Math.min(...holders.holders.map((h) => h.setAtMs));
  const windowStartMs = nowMs - windowMs;
  const lookbackStartMs = Math.max(
    nowMs - GOAL_PORTFOLIO_LOOKBACK_FLOOR_MS,
    Math.min(windowStartMs, heldSinceMs),
  );

  let actsInWindow = 0;
  let lastActAtMs: number | null = null;
  let lastActTool: string | null = null;
  let lastActArgs: unknown = null;
  try {
    const rows = await sql<
      {
        acts_in_window: string;
        last_act_ms: string | null;
        last_act_tool: string | null;
        last_act_args: unknown;
      }[]
    >`
      SELECT count(*) FILTER (
               WHERE ti.invoked_at >= to_timestamp(${windowStartMs}::bigint / 1000.0)
             ) AS acts_in_window,
             (extract(epoch FROM max(ti.invoked_at)) * 1000)::bigint AS last_act_ms,
             (array_agg(ti.tool_name ORDER BY ti.invoked_at DESC))[1] AS last_act_tool,
             (array_agg(ti.args_json ORDER BY ti.invoked_at DESC))[1] AS last_act_args
        FROM harness_shared.tool_invocations ti
       WHERE ti.workspace_id = ${opts.workspaceId}
         AND ti.coord_owner_id = ANY(${ownerIds}::text[])
         AND ti.status = 'ok'
         AND ${portfolioActLedgerPredicate(sql)}
         AND ti.invoked_at >= to_timestamp(${lookbackStartMs}::bigint / 1000.0)
    `;
    const row = rows[0];
    actsInWindow = Number(row?.acts_in_window ?? 0);
    lastActAtMs = row?.last_act_ms == null ? null : Number(row.last_act_ms);
    lastActTool = row?.last_act_tool ?? null;
    lastActArgs = row?.last_act_args ?? null;
  } catch (err) {
    const verdict = resolveGoalPortfolioIdle({
      liveness: holders.liveness,
      throughput: null,
      idleAfterMs,
    });
    return build(base, {
      windowMinutes,
      measuredOwnerIds: ownerIds.length,
      holderLiveness: holders.liveness,
      // The fold answered `not-held` for a non-held goal even though the LEDGER
      // is what failed. Force the honest code: we did not measure, and saying
      // anything else here would let an apparatus failure read as a finding.
      idle: false,
      reason: 'not-measured',
      assessment: 'evidence-unavailable',
      unavailable: {
        code: 'ledger-unreadable',
        detail: `tool_invocations could not be read for this goal's ${ownerIds.length} holder identit${
          ownerIds.length === 1 ? 'y' : 'ies'
        }: ${err instanceof Error ? err.message : String(err)}. Retry; do NOT substitute a raw ledger query, and do not read the absence of acts as idleness.`,
      },
    }, verdict);
  }

  // Never placed anything in the lookback ⇒ measure from the hold start. See
  // GoalPortfolioThroughput.idleMs: this is the clearest instance of the
  // condition, not an absence of evidence about it.
  const sinceMs = lastActAtMs ?? Math.max(heldSinceMs, lookbackStartMs);
  const idleMs = Math.max(0, nowMs - sinceMs);

  const verdict = resolveGoalPortfolioIdle({
    liveness: holders.liveness,
    throughput: { actsInWindow, idleMs },
    idleAfterMs,
  });

  return build(base, {
    windowMinutes,
    actsInWindow,
    actsPerHour: Math.round((actsInWindow / (windowMinutes / 60)) * 100) / 100,
    lastActAtMs,
    lastActTool,
    // The args ride along so a conditional act (`work_items:update { goal }`)
    // resolves to its facet; by name alone it would read as a non-act.
    lastActFacet: portfolioActFacet(lastActTool, lastActArgs),
    idleMinutes: minutes(idleMs),
    idleAfterMinutes: Math.round(idleAfterMs / 60_000),
    measuredOwnerIds: ownerIds.length,
    holderLiveness: holders.liveness,
    unavailable:
      verdict.reason === 'not-measured'
        ? {
            code: 'liveness-unresolved',
            detail:
              'the liveness oracle did not resolve this goal\'s holders, so whether anybody is there to place work is unknown. An unresolved holder is never evidence of idleness.',
          }
        : null,
  }, verdict);
}
