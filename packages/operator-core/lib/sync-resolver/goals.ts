/**
 * goals.* sync-resolver reads — the client data path for GOAL mode
 * (goal-mode-2026-08-07 P-017).
 *
 * Before this there was NO goal-shaped query among the ~210 registered: the
 * goals table had a schema, write tools and an MCP resource, but nothing the
 * UI could subscribe to. Every surface in Phase 4 (the rail tab, the HUD goals
 * tab, the detail view) reads from exactly these two.
 *
 * ── The counting rule these queries encode ─────────────────────────────────
 * A pot can serve several goals (D-021), so a shared pot's spend counts
 * IN FULL against each of them and `goals.list`'s per-row spend figures DO NOT
 * SUM. The list therefore also returns `portfolioSpendUsd` — computed over
 * DISTINCT pots — so a client that wants a total has one to read and never
 * has to add the rows up itself. The `Σ rows ≠ portfolio` gap is real and
 * expected; it is the shared work, not a bug.
 */

// ⚠ `harness_shared.work_items` DOES NOT HAVE `closed_at` / `updated_at`. Its
// timestamps are BIGINT EPOCH-MS columns named `closed_ts` / `updated_ts` (and
// its primary key is `feature_id`, not `id`) — unlike `goals`, `goal_pots`
// and every other table this file touches, which all use real timestamptz
// `*_at` columns. Writing the `*_at` form here is the natural mistake and it
// throws at RUNTIME ONLY (`column wi.closed_at does not exist`): tsc cannot see
// into a SQL string, and every test that mocks the sync layer stays green. Both
// resolvers below shipped with exactly that bug and NOTHING caught it until the
// query was first run against a real database — see the integration test beside
// this file, which exists to make that impossible a second time.
//
// Convert on the way out (`to_timestamp(x / 1000.0)`) rather than passing the
// bigint through: the row mappers hand these to `iso()`, which expects a Date
// or an ISO string and would otherwise stringify the raw epoch number.
//
// NOTE: the `tx` handle inside `sql.begin` is deliberately left INFERRED below.
// Annotating it `Sql` is wrong and does not merely lose precision — postgres.js
// hands the callback a `TransactionSql`, which is not assignable to `Sql`, so
// the annotation fails to typecheck outright. Every other `sql.begin` in this
// package leaves it inferred for the same reason.

import { GOAL_SPEND_SNAPSHOT_SOURCE } from '@papercusp/db-org';
import { budgetSpendScope } from '../goal-launch-settings';
// P-001 — goal-live-holder-guarantee-2026-08-18: ROW PRESENCE IS NOT LIVENESS.
// A goal-mode row outlives the session that wrote it, so both surfaces below
// (the board and the popup) reported goals dark for days as staffed. The
// classification lives in ONE module; these are its read-side consumers.
import {
  goalHolderKey,
  resolveGoalHoldersBatchFromRows,
  resolveGoalHoldersFromRows,
  resolveHolderLiveness,
  type GoalHolderLiveness,
  type GoalHolderRow,
} from '../goals/holder';

export interface GoalTripwire {
  metric: string;
  label: string;
  threshold: number;
  current?: number;
  unit?: string;
  /**
   * Provenance for `current`, stamped by the platform refresh (goals/tripwire-refresh).
   * ABSENT means an agent hand-wrote the number — which is the ordinary case for a
   * domain metric, and which the detail view must not render as a measurement.
   * `parseTripwires` is a pass-through filter, so this rides the wire for free.
   */
  measuredBy?: { source: string; atMs: number; value: number } | null;
}

import {
  goalPackageUpdateInfo,
  makeGoalPackageLookup,
  type GoalPackageUpdateInfo,
} from '../goals/package-update';
import { listLocalGoalPackages, type LocalGoalPackage } from '../cupboard/goal-package-store';
// P-009 (work-on-everything-goal-2026-08-23): the packages-rail fold — pure,
// unit-tested in goals/package-board.test.ts, assembled here.
import {
  foldGoalPackageBoard,
  type GoalPackageBoardEntry,
  type GoalPackageInstanceRow,
} from '../goals/package-board';

export interface GoalSummaryRow {
  id: string;
  title: string;
  body: string | null;
  status: string;
  parentId: string | null;
  /** The agents working this goal (agent_modes mode='goal'), so the HUD Goals
   *  tab can filter by agent id. A LIST — see the subselect's comment.
   *
   *  P-001: each carries its LIVENESS, because the mode row alone does not mean
   *  anyone is there. The row outlives the session that wrote it and nothing
   *  clears it on death, so a board rendering `agents.length` was reporting
   *  goals dark for days as staffed. `live: null` means UNRESOLVABLE, never
   *  dead — see `holderLiveness`. */
  agents: Array<{ ownerId: string; live: boolean | null; sessionState: string | null }>;
  /** The goal's holder verdict, computed fresh on this read (P-001):
   *  `held` (someone is positively alive on it) | `unheld` (never picked up) |
   *  `lost` (holders exist, all resolved, none alive) | `unknown` (at least one
   *  holder could not be resolved — NOT evidence of death). */
  holderLiveness: GoalHolderLiveness;
  /**
   * The status a reader should USE (P-004): `status` verbatim, or `'dormant'`
   * when this goal requires a live holder and has none.
   *
   * DERIVED ON THIS READ, never persisted — `status` above keeps meaning
   * exactly what a human last put in it. Render this one; the raw column is for
   * showing what was DECLARED, not what is true now.
   */
  effectiveStatus: string | null;
  /** True when `effectiveStatus` differs from `status` for the P-004 reason. */
  deactivated: boolean;
  killCriterion: string | null;
  tripwires: GoalTripwire[];
  budgetCents: number | null;
  spentCents: number | null;
  /**
   * The population `spentCents` measured, in the SAME vocabulary the kickoff
   * brief renders — both resolve through `budgetSpendScope`, so the two
   * readouts cannot drift into disagreeing about the same number.
   *
   * Present because THIS row is the one every sync client receives, which made
   * a bare figure here the last unlabelled goal-spend readout in the tree
   * (spend-attribution-...-2026-09-04, acceptance criterion 1: the sync row was
   * neither labelled nor recorded out of scope).
   *
   * Always a string, including when `spentCents` is null:
   * `unverified-provenance:unmarked-snapshot` says the figure is ABSENT because
   * its provenance was unrecognised, which is a different claim from "no spend"
   * and is exactly the distinction a bare null erases.
   */
  spentCentsScope: string;
  createdAt: string | null;
  /**
   * When the goal's DEFINITION last changed — NOT when it last made progress.
   *
   * MEASURED (goals-tab-improvement-2026-08-09 P-004): the only writer of
   * `goals.updated_at` in the tree is `goals:update` (packages/agent-mcp/src/
   * tools/goals/update.ts), which fires on title/body/status/budget/parent/
   * kill-criterion/tripwires/metadata edits. Work items moving, agents
   * spending and sessions running do not touch it. Reading this field as
   * recency-of-activity is wrong in BOTH directions: a furiously-active goal
   * nobody has retitled looks stale, and a dead goal whose title was just
   * edited looks fresh. Use `lastActivityAt` for activity.
   */
  updatedAt: string | null;
  /**
   * When work under this goal last moved — the honest activity signal, and the
   * one the glance surface ages off. `null` means NO work item has ever been
   * stamped to this goal, which is a real state ("nothing has ever happened
   * here"), not a zero: it must render as unmeasured rather than as infinite
   * staleness (the P-002 unmeasured-is-not-zero rule, applied a third time).
   */
  lastActivityAt: string | null;
  potCount: number;
  /**
   * WHICH pots those are — a BOUNDED SAMPLE, capped at POT_SAMPLE_LIMIT
   * (goals-tab-improvement-2026-08-09 P-007, D-022).
   *
   * ⚠ NOT A TOTAL, and the difference is the whole reason it is a separate
   * field from `potCount`. `pots.length` is the number of names the query was
   * willing to carry, not the number of pots the goal has; a reader that counts
   * it reports a confident wrong number the moment a goal passes the cap. Read
   * `potCount` for the count and this for the names.
   */
  pots: GoalPotChip[];
  /** Open work-items stamped to this goal — the "is anything moving" signal. */
  openWorkItems: number;
  /** Items parked on the owner. The rail's "waiting on you" count. */
  needsHuman: number;
  /**
   * Goal-attributed spend over the goal's lifetime: the priced samples whose
   * `goal_id` was stamped at write time, from `created_at` on — the SAME stream
   * `lineageSpendForGoal` measures for the launch gate and the breach check
   * (WI-1074208, plan decisions D-011/D-012). Pot membership plays no part, so a
   * goal with no pots still shows what it cost.
   *
   * NULL when no priced sample is attributed to the goal. That is "unmeasured",
   * never "$0": the pot-based figure this replaced read 0 for a goal that had
   * spent $1,613 through no pot at all.
   *
   * The LEVEL judged against the ceiling is `spentCents`, not this — the ceiling
   * is per `budgetWindowSec`, and a lifetime figure judged against a weekly
   * ceiling would flag a standing goal for spend it made months ago.
   */
  spendUsd: number | null;
  /**
   * The same attributed stream inside the recent window — the RATE input
   * (goals-tab-improvement-2026-08-09 P-003). NULL when nothing priced was
   * attributed in the window, so the burn renders no rate rather than `$0/day`.
   */
  spendRecentUsd: number | null;
  /** The rolling window `budgetCents` applies to, in seconds; null = the goal's lifetime. */
  budgetWindowSec: number | null;
  /**
   * How wide that window is, in days.
   *
   * On the WIRE rather than a constant the UI imports, because the HUD
   * deliberately narrows this row into its own `HudGoalInput` instead of
   * importing it (see that type's docblock). A UI that hardcoded `7` would
   * silently keep saying "last 7 days" if this window were ever retuned;
   * reading the window from the same payload as the figure makes that
   * particular drift impossible rather than merely unlikely.
   */
  spendRecentWindowDays: number;
  /**
   * Present when this goal was minted from a Cupboard goal package
   * (metadata.goalPackageRef): the installed vs currently-shipped package
   * version and whether a newer one is available to OFFER (P-018 — the offer
   * is data; `goals:apply-package-update` is the accept). Null for unpackaged
   * goals and when the package no longer resolves on disk.
   */
  goalPackage: GoalPackageUpdateInfo | null;
}

/**
 * The rolling window behind `spendRecentUsd`.
 *
 * Rolling (`ts >= now - N days`), NOT calendar days. `spendByDay` further down
 * buckets by UTC calendar day for the chart, and the two windows genuinely
 * differ — deriving the burn from those buckets instead would guarantee the
 * card and the detail panel disagreed about the same goal.
 */
export const SPEND_RECENT_WINDOW_DAYS = 7;

/**
 * How many pot names the LIST query samples per goal (P-007/D-022).
 *
 * A SAMPLE, never the total. `potCount` remains the authoritative count and the
 * client renders overflow from the difference — the whole point of capping here
 * is that a goal with forty pots costs this hot read the same as one with two.
 * Six because the card's chip row is itself capped and a sample smaller than the
 * cap would make the overflow marker fire on goals that could have been shown
 * whole.
 */
export const POT_SAMPLE_LIMIT = 6;

/** One pot serving a goal, as the LIST query samples it (P-007/D-022). */
export interface GoalPotChip {
  harnessSlug: string;
  /** 'owner' | 'contributing' as stored; owner pots sort first. */
  role: string | null;
  /**
   * How many live goals this same pot serves — D-021's visible face.
   *
   * 1 is the ordinary case. Anything higher means this pot's spend is billed in
   * full against several goals, so the surface MUST say so rather than let a
   * reader add two goals' costs together as if they were independent.
   */
  servesGoals: number;
}

const SPEND_RECENT_WINDOW_MS = SPEND_RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** Rows are ordered so the goals that can still change sit at the top. */
const STATUS_RANK = `CASE g.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END`;

function parseTripwires(raw: unknown): GoalTripwire[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (t): t is GoalTripwire =>
      !!t && typeof t === 'object' && typeof (t as GoalTripwire).metric === 'string',
  );
}

function num(v: unknown): number {
  return v == null ? 0 : Number(v);
}

/** `num` without the 0 fallback, for readings where absent means unmeasured. */
function numOrNull(v: unknown): number | null {
  return v == null ? null : Number(v);
}

/**
 * The sampled pot names, as `json_agg` hands them back (P-007/D-022).
 *
 * Drops a row with no `harnessSlug` rather than rendering a nameless chip — the
 * chip's entire job is to answer "which", and a blank one answers it wrongly
 * while looking like data. `servesGoals` falls back to 1, the ordinary case,
 * because the alternative (0) would read as "serves no goals" on a pot that
 * demonstrably serves this one.
 */
function parsePotChips(raw: unknown): GoalPotChip[] {
  if (!Array.isArray(raw)) return [];
  const out: GoalPotChip[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const r = row as { harnessSlug?: unknown; role?: unknown; servesGoals?: unknown };
    if (typeof r.harnessSlug !== 'string' || !r.harnessSlug) continue;
    out.push({
      harnessSlug: r.harnessSlug,
      role: typeof r.role === 'string' ? r.role : null,
      servesGoals: Math.max(1, num(r.servesGoals) || 1),
    });
  }
  return out;
}

interface RawGoal {
  id: string;
  title: string;
  body: string | null;
  status: string;
  parent_id: string | null;
  /** json_agg output from the agents subselect — `unknown` because it arrives
   *  as parsed JSON from pg and is narrowed in toSummary, not trusted here. */
  agents: unknown;
  kill_criterion: string | null;
  tripwires: unknown;
  budget_cents: string | null;
  budget_window_sec: number | string | null;
  metadata: Record<string, unknown> | null;
  created_at: string | Date | null;
  updated_at: string | Date | null;
  last_activity_at: string | Date | null;
  /** Raw jsonb — parsed by `parseGoalLaunchSettings`, never trusted here. */
  launch_settings?: unknown;
  pot_count: string | null;
  /** json_agg of the sampled pots — shape validated by parsePotChips, not here. */
  pots: unknown;
  open_work_items: string | null;
  needs_human: string | null;
  spend_usd: string | null;
  spend_recent_usd: string | null;
}

function iso(v: string | Date | null): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

/**
 * A goal summary BEFORE its holder liveness is folded in (P-001).
 *
 * This type exists so `GoalSummaryRow` is UNCONSTRUCTIBLE without going through
 * `withHolderLiveness`. The liveness join was never hard to write — it was easy
 * to forget, and forgetting it is silent: a board rendering the raw mode rows
 * reports goals dark for days as staffed, and nothing anywhere fails. Making
 * the annotated shape the only reachable one moves that from a discipline
 * nobody can enforce to a thing the compiler will not let you skip.
 */
type GoalSummaryRowBase = Omit<
  GoalSummaryRow,
  'agents' | 'holderLiveness' | 'effectiveStatus' | 'deactivated'
> & {
  agents: Array<{ ownerId: string; setAtMs: number }>;
  /**
   * Raw `goals.launch_settings`, carried only as far as `withHolderLiveness`,
   * which needs it to resolve the holder POLICY (P-004). Deliberately absent
   * from the public row: a board has no business re-deriving the policy itself,
   * and `effectiveStatus` is the answer it actually wants.
   */
  launchSettingsRaw: unknown;
};

function toSummary(
  r: RawGoal,
  pkgLookup: (ref: string) => LocalGoalPackage | null,
): GoalSummaryRowBase {
  const metadata = r.metadata ?? {};
  const spentCents =
    // Only the platform rollup's marker (spend-rollup.ts, D-011): a legacy
    // hand-entered value, or a snapshot from the retired pot-authoritative
    // rollup, carries a different marker and reads null until the next tick.
    metadata.spentCentsSource === GOAL_SPEND_SNAPSHOT_SOURCE && typeof metadata.spentCents === 'number'
      ? (metadata.spentCents as number)
      : null;
  // Resolved through the SAME helper the kickoff brief uses, over the SAME
  // provenance allowlist that gates `spentCents` directly above — so the label
  // cannot say "authoritative" about a figure this site just nulled out.
  const spentCentsScope = budgetSpendScope(
    typeof metadata.spentCentsSource === 'string' ? (metadata.spentCentsSource as string) : null,
  );
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    status: r.status,
    parentId: r.parent_id,
    // Already a json array from the subselect's COALESCE (never SQL NULL), but
    // narrowed defensively: a legacy/cached payload predating P-006 has no such
    // key, and `undefined.map` would take the whole board down over a filter.
    agents: Array.isArray(r.agents)
      ? (r.agents as Array<{ ownerId?: unknown; setAtMs?: unknown }>)
          .map((a) => ({
            ownerId: String(a?.ownerId ?? ''),
            setAtMs: Number(a?.setAtMs ?? 0),
          }))
          .filter((a) => a.ownerId.length > 0)
      : [],
    // Fall back to the pre-migration-765 home so a legacy goal still shows the
    // one string the whole GUI is built around, rather than rendering blank.
    killCriterion:
      r.kill_criterion ??
      (typeof metadata.killCriterion === 'string' ? (metadata.killCriterion as string) : null),
    tripwires: parseTripwires(r.tripwires),
    budgetCents: r.budget_cents == null ? null : Number(r.budget_cents),
    spentCents,
    spentCentsScope,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    lastActivityAt: iso(r.last_activity_at),
    potCount: num(r.pot_count),
    pots: parsePotChips(r.pots),
    openWorkItems: num(r.open_work_items),
    needsHuman: num(r.needs_human),
    spendUsd: numOrNull(r.spend_usd),
    spendRecentUsd: numOrNull(r.spend_recent_usd),
    spendRecentWindowDays: SPEND_RECENT_WINDOW_DAYS,
    budgetWindowSec: numOrNull(r.budget_window_sec),
    goalPackage: goalPackageUpdateInfo(metadata as Record<string, unknown> | null, pkgLookup),
    launchSettingsRaw: r.launch_settings ?? null,
  };
}

/**
 * Fold holder liveness onto goal summaries (P-001) — the ONLY way to produce a
 * `GoalSummaryRow`.
 *
 * ONE oracle call for the whole batch, not one per goal: a goals list is
 * rendered on every HUD tick, and the per-goal shape would be an N+1 on the hot
 * path this resolver was explicitly written to avoid.
 *
 * A goal whose holders all resolve dead comes back `holderLiveness: 'lost'` with
 * its (dead) holders still listed — the caller renders them greyed rather than
 * vanishing them, so "this goal HAD an agent and it died" stays legible. That is
 * the whole difference between the board this fixes and the board it replaces:
 * before, a dead holder was indistinguishable from a live one.
 */
async function withHolderLiveness(
  workspaceId: string,
  base: readonly GoalSummaryRowBase[],
): Promise<GoalSummaryRow[]> {
  const rows: GoalHolderRow[] = base.flatMap((g) =>
    g.agents.map((a) => ({
      goalId: g.id,
      workspaceId,
      ownerId: a.ownerId,
      setAtMs: a.setAtMs,
    })),
  );
  const verdicts = await resolveHolderLiveness(rows.map((r) => r.ownerId));
  const byGoal = resolveGoalHoldersBatchFromRows(
    base.map((g) => ({ goalId: g.id, workspaceId })),
    rows,
    verdicts,
  );
  // Dynamic for the same reason as `resolveGoalDetail`'s neighbour: this module
  // is imported by callers that must not pay for the store's server
  // dependencies at load, and `goal-launch-settings` statically imports them.
  const { parseGoalLaunchSettings } = await import('../goal-launch-settings');
  const { resolveGoalEffectiveActivity } = await import('../goals/activity');
  return base.map((g) => {
    // Always present: `byGoal` is built from `base` itself, so every goal has an
    // entry (an absent one would be a bug in resolveGoalHoldersBatchFromRows,
    // not a goal without holders — that case is `unheld`).
    const h = byGoal.get(goalHolderKey(workspaceId, g.id));
    const holderLiveness = h?.liveness ?? 'unheld';
    // P-004: the liveness we just paid for is exactly the input the activity
    // fold needs, so deriving here is free. Doing it HERE rather than in each
    // caller is the same argument `GoalSummaryRowBase` already makes about the
    // liveness join itself: easy to write, easy to forget, silent when
    // forgotten. An invalid `launch_settings` parses to null, which resolves to
    // the DEFAULT policy (requireLive: true) rather than opting the goal out —
    // a corrupt blob must not silently disable the guarantee.
    const { launchSettingsRaw, ...row } = g;
    const { settings } = parseGoalLaunchSettings(launchSettingsRaw);
    const activity = resolveGoalEffectiveActivity({
      status: g.status,
      launchSettings: settings,
      liveness: holderLiveness,
    });
    return {
      ...row,
      agents: (h?.holders ?? []).map((x) => ({
        ownerId: x.ownerId,
        live: x.live,
        sessionState: x.sessionState,
      })),
      holderLiveness,
      effectiveStatus: activity.effectiveStatus,
      deactivated: activity.deactivated,
    };
  });
}

/**
 * The goal cards: every goal in the workspace with its live counters.
 *
 * Counters are computed in ONE pass of correlated sub-selects rather than N+1
 * round-trips — a goals list is rendered on every HUD tick, and this is the
 * read most likely to become a hot path.
 */
export async function resolveGoalsList(args: {
  workspaceId: string;
  status?: string | null;
  limit?: number;
  /** Exact pot set inherited from /adv; omitted means workspace-wide. */
  harnessSlugs?: readonly string[];
}): Promise<{
  goals: GoalSummaryRow[];
  /**
   * The TRUE number of goals matching the same predicate, counted UNBOUNDED.
   *
   * ⚠ NOT `goals.length`. That array is capped by `limit`, and a capped list
   * length rendered as a total is the repeat-offender class this file already
   * defends against twice — see the note on `waitingTotalRow`, and the pot
   * sample whose overflow is computed from `potCount` rather than its own
   * length. The goals list was the one collection here without the guard
   * (dropped plan item P-014, goals-tab-improvement-2026-08-09).
   */
  totalGoals: number;
  /** True when `goals` is a prefix of a larger set — the client must say so. */
  truncatedByLimit: boolean;
  portfolioSpendUsd: number;
  portfolioPots: number;
  /** P-009: the HUD packages rail — the layered package catalog × stamped
   *  instance rows, folded from its OWN bounded query (never the capped list
   *  above, whose cap would misread an off-list instance as "never started"). */
  goalPackages: GoalPackageBoardEntry[];
}> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  const { workspaceId, status = null, limit = 100, harnessSlugs } = args;
  // Cut ONCE for the whole page, so two rows in the same render can never be
  // measured over windows that differ by the query's own duration.
  const recentSinceMs = Date.now() - SPEND_RECENT_WINDOW_MS;
  /* Captured from INSIDE the transaction below rather than returned out of it.
     `sql.begin` does not pass an arbitrary object return through — returning
     { rows, total } resolved to something whose `rows` was undefined, which
     surfaced as "Cannot read properties of undefined (reading 'map')" on the
     line after. The callback keeps returning the row array exactly as it did
     before, and the count rides out on this binding. */
  let totalGoals = 0;
  const rows = await sql.begin(async (tx) => {
    await tx.unsafe(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId]);
    const goalRows = (await tx`
      SELECT g.id, g.title, g.body, g.status, g.parent_id, g.kill_criterion, g.tripwires,
             g.budget_cents, g.budget_window_sec, g.metadata, g.launch_settings, g.created_at, g.updated_at,
             (SELECT COUNT(*) FROM harness_shared.goal_pots gp
               WHERE gp.workspace_id = g.workspace_id AND gp.goal_id = g.id
                 AND gp.removed_at IS NULL) AS pot_count,
             -- A BOUNDED SAMPLE of which pots those are (P-007/D-022), so the
             -- card can name them instead of rendering a bare count. Capped in
             -- SQL rather than fetched whole and sliced in the client: the cap
             -- is what keeps this a fixed-cost column on a read that runs every
             -- HUD tick. pot_count above stays the authoritative TOTAL -- this
             -- array is deliberately NOT it, and the client must not count it.
             -- Owner pots sort first: the reader's question is "whose goal is
             -- this" before "who else is helping".
             (SELECT COALESCE(
                       json_agg(json_build_object(
                         'harnessSlug', p.harness_slug,
                         'role', p.role,
                         'servesGoals', p.serves_goals
                       ) ORDER BY p.rank, p.harness_slug),
                       '[]'::json)
                FROM (
                  SELECT gp.harness_slug,
                         gp.role,
                         CASE WHEN gp.role = 'owner' THEN 0 ELSE 1 END AS rank,
                         -- D-021's visible face: how many LIVE goals this same
                         -- pot serves. A pot on two goals bills its spend in
                         -- full to EACH, so a chip that hid this would invite
                         -- the reader to add two goals costs together.
                         (SELECT COUNT(*) FROM harness_shared.goal_pots sib
                           WHERE sib.workspace_id = gp.workspace_id
                             AND sib.harness_slug = gp.harness_slug
                             AND sib.removed_at IS NULL) AS serves_goals
                    FROM harness_shared.goal_pots gp
                   WHERE gp.workspace_id = g.workspace_id AND gp.goal_id = g.id
                     AND gp.removed_at IS NULL
                   ORDER BY rank, gp.harness_slug
                   LIMIT ${POT_SAMPLE_LIMIT}
                ) p) AS pots,
             (SELECT COUNT(*) FROM harness_shared.work_items wi
               WHERE wi.goal_id = g.id AND wi.closed_ts IS NULL) AS open_work_items,
             (SELECT COUNT(*) FROM harness_shared.work_items wi
               WHERE wi.goal_id = g.id AND wi.closed_ts IS NULL
                 AND COALESCE((wi.payload->>'needsHuman')::boolean, false)) AS needs_human,
             -- Goal-attributed spend (WI-1074208, D-012): the lineage stream
             -- lineageSpendForGoal measures — samples stamped with this goal at
             -- write time, from the goal's creation on. No COALESCE: SUM over no
             -- priced sample is NULL, which the row carries as "unmeasured".
             -- s.ts is epoch MILLIS (bigint). Covered by
             -- agent_usage_samples_ws_goal_ts_idx (workspace_id, goal_id, ts DESC).
             (SELECT SUM(s.cost_usd)
                FROM harness_shared.agent_usage_samples s
               WHERE s.workspace_id = g.workspace_id
                 AND s.goal_id = g.id
                 AND s.ts >= (EXTRACT(EPOCH FROM g.created_at) * 1000)::bigint) AS spend_usd,
             -- The same stream over the recent window.
             (SELECT SUM(s.cost_usd)
                FROM harness_shared.agent_usage_samples s
               WHERE s.workspace_id = g.workspace_id
                 AND s.goal_id = g.id
                 AND s.ts >= GREATEST(${recentSinceMs}::bigint,
                                      (EXTRACT(EPOCH FROM g.created_at) * 1000)::bigint)) AS spend_recent_usd,
             -- ACTIVITY, as distinct from the definition-edit time in
             -- g.updated_at (P-004). Deliberately spans CLOSED items too: a
             -- goal whose last act was finishing its work has still been
             -- active, and filtering to open items would date it from whenever
             -- the last unfinished thing happened to stall. wi.updated_ts is
             -- epoch MILLIS (bigint) — the same shape the detail path's
             -- MAX(wi.updated_ts) aggregation already uses below.
             (SELECT to_timestamp(MAX(wi.updated_ts) / 1000.0)
                FROM harness_shared.work_items wi
               WHERE wi.goal_id = g.id) AS last_activity_at,
             -- The agents working this goal, so the HUD Goals tab can be
             -- filtered by agent id (hud-unified-search-filter-2026-08-10
             -- P-006). Same source and same predicate the DETAIL path uses
             -- (agent_modes mode='goal', subject=<goal id>) — deliberately
             -- not a second definition of "who is on this goal", which is how
             -- the board and the popup would come to disagree.
             --
             -- json_agg, not a scalar: D-006 makes this one agent in practice,
             -- but a goal with TWO is a coordination fault worth seeing, and
             -- picking one would hide it. COALESCE to '[]' so "no agents" is a
             -- list, never SQL NULL.
             -- P-001: setAtMs rides along because ROW PRESENCE IS NOT LIVENESS.
             -- The rows fetched here are folded through resolveHolderLiveness in
             -- withHolderLiveness before they can become a GoalSummaryRow, and
             -- set_at is that fold's evidence timestamp. This is NOT a second
             -- definition of who holds a goal — the classification lives in
             -- lib/goals/holder.ts.
             (SELECT COALESCE(
                       json_agg(json_build_object(
                                  'ownerId', am.owner_id,
                                  'setAtMs', (extract(epoch FROM am.set_at) * 1000)::bigint)
                                ORDER BY am.set_at DESC),
                       '[]'::json)
                FROM harness_shared.agent_modes am
               WHERE am.workspace_id = g.workspace_id
                 AND am.mode = 'goal'
                 AND am.subject = g.id) AS agents
        FROM harness_shared.goals g
       WHERE g.workspace_id = ${workspaceId}
         AND (${status}::text IS NULL OR g.status = ${status}::text)
         AND ${
           harnessSlugs
             ? sql`(
                 g.install_slug = ANY(${harnessSlugs as string[]}::text[])
                 OR EXISTS (
                   SELECT 1 FROM harness_shared.goal_pots scoped_gp
                    WHERE scoped_gp.workspace_id = g.workspace_id
                      AND scoped_gp.goal_id = g.id
                      AND scoped_gp.removed_at IS NULL
                      AND scoped_gp.harness_slug = ANY(${harnessSlugs as string[]}::text[])
                 )
               )`
             : sql`TRUE`
         }
       ORDER BY ${sql.unsafe(STATUS_RANK)}, g.updated_at DESC NULLS LAST
       LIMIT ${limit}
    `) as unknown as RawGoal[];

    // The TRUE count, over the SAME predicate as the row fetch above and inside
    // the SAME transaction — so the number and the rows it describes can never
    // be read from two different snapshots.
    //
    // Counted separately rather than by lifting the LIMIT: the payload stays
    // bounded while the aggregate stays honest. Both are needed — the rows to
    // render, the count to be truthful about how many there are.
    const [totalRow] = (await tx`
      SELECT COUNT(*)::int AS total
        FROM harness_shared.goals g
       WHERE g.workspace_id = ${workspaceId}
         AND (${status}::text IS NULL OR g.status = ${status}::text)
         AND ${
           harnessSlugs
             ? sql`(
                 g.install_slug = ANY(${harnessSlugs as string[]}::text[])
                 OR EXISTS (
                   SELECT 1 FROM harness_shared.goal_pots scoped_gp
                    WHERE scoped_gp.workspace_id = g.workspace_id
                      AND scoped_gp.goal_id = g.id
                      AND scoped_gp.removed_at IS NULL
                      AND scoped_gp.harness_slug = ANY(${harnessSlugs as string[]}::text[])
                 )
               )`
             : sql`TRUE`
         }
    `) as unknown as Array<{ total: number | string | null }>;

    totalGoals = totalRow?.total == null ? goalRows.length : Number(totalRow.total);
    return goalRows;
  });
  // P-001: liveness is folded in AFTER the transaction — the oracle is its own
  // read path (presence, wakeability, self-wake) and holding the goals tx open
  // across it would widen a hot-path transaction for no benefit.
  const pkgLookup = makeGoalPackageLookup();
  const goals = await withHolderLiveness(
    workspaceId,
    rows.map((r) => toSummary(r, pkgLookup)),
  );

  // The portfolio total, over DISTINCT pots. Deliberately returned
  // alongside the rows the client already has: the natural thing to do with a
  // list of spend figures is add them up, and that answer is wrong by exactly
  // the shared work. Handing over the correct total removes the temptation.
  const { portfolioSpend } = await import('@papercusp/db-org');
  const portfolio = await portfolioSpend(sql, {
    workspaceId,
    goalIds: goals.map((g) => g.id),
  });
  // P-009: the packages rail. A DEDICATED bounded query, deliberately not a
  // correlation against `rows`: that list is capped by `limit`, and a package
  // instance falling past the cap would read on the rail as "never started" —
  // the same confident-wrong-answer class the `totalGoals` guard above names.
  const pkgRows = (await sql`
    SELECT id, status, metadata
      FROM harness_shared.goals
     WHERE workspace_id = ${workspaceId}
       AND metadata->>'goalPackageRef' IS NOT NULL
     ORDER BY id
     LIMIT 200`) as unknown as GoalPackageInstanceRow[];
  const goalPackages = foldGoalPackageBoard(listLocalGoalPackages(), pkgRows);

  return {
    goals,
    goalPackages,
    portfolioSpendUsd: portfolio.costUsd,
    totalGoals,
    // Derived from the two numbers rather than from the caller's `limit`, so it
    // stays right if the cap ever moves or a caller passes its own.
    truncatedByLimit: totalGoals > goals.length,
    portfolioPots: portfolio.pots,
  };
}

export interface GoalPotCard {
  harnessSlug: string;
  role: 'owner' | 'contributing';
  killCriterion: string | null;
  note: string | null;
  addedAt: string;
  /** How many goals this pot serves — the "shared with N goals" badge. */
  servesGoals: number;
  spendUsd: number;
  openWorkItems: number;
}

/**
 * One PLAN associated with a goal (goals-tab-improvement-2026-08-09 P-019).
 *
 * ⚠ Read D-010 before changing how this is derived. A plan reaches this list by
 * EITHER of two legs, and the query below is a UNION of exactly those:
 *   DERIVED — a work item STAMPED with this goal came from that plan
 *             (`work_items.goal_id` → `work_items.source_plan_slug`).
 *   STAMPED — the plan itself carries `harness_plans.goal_id` (migration 791).
 *
 * ⚠ This paragraph USED TO SAY "harness_plans carries no goal_id and there is
 * no join table". That was true before migration 791 and is now FALSE — the
 * column exists, this resolver reads it, and the `stamped` field below is
 * documented off it. The stale wording survived the migration and was still
 * being read as current on 2026-08-10, when it nearly caused a goal→plan link
 * that already exists to be "rebuilt". Do not reintroduce it.
 *
 * The tempting alternative — every plan in a harness that `goal_pots` links
 * to the goal — is REJECTED and must not be reintroduced: a harness holds
 * hundreds of plans, so it answers "plans in a pot that serves this goal",
 * which would render the entire papercusp plan directory under a one-day-old
 * goal and call it association.
 *
 * Deriving it this way also inherits the stamp's provenance rule for free:
 * `stampGoalProvenance` writes `goal_id` only from the creator's live GOAL-mode
 * subject, never from an argument or a guess, so a plan cannot self-report its
 * way onto a goal.
 */
export interface GoalPlanCard {
  planSlug: string;
  harnessSlug: string;
  /** Null when the work items reference a plan slug that no longer resolves —
   *  rendered as the bare slug rather than dropped, because a plan that was
   *  deleted out from under live work items is worth SEEING, not hiding. */
  title: string | null;
  status: string | null;
  archived: boolean;
  /** Work items on this goal that came from this plan. NOT a count of the
   *  plan's own items — the plan may be far larger than its goal-stamped slice,
   *  and labelling this "plan progress" would overstate what the goal owns. */
  items: number;
  openItems: number;
  /**
   * True when the plan carries this goal's stamp (`harness_plans.goal_id`,
   * migration 791) — i.e. it was CREATED by an agent working this goal, rather
   * than merely being the source of some work item that is.
   *
   * The two are independent, and both matter: a stamped plan with `items: 0` is
   * the normal state of a plan the goal just started, while an unstamped plan
   * with items is work the goal inherited. The UI needs the flag because the
   * counts alone cannot tell those apart — "0 open of 0" on a freshly-started
   * plan reads as failure when it is simply new.
   */
  stamped: boolean;
  updatedAt: string | null;
}

/**
 * One goal, everything its page needs, in a single round-trip.
 *
 * ⚠ KILLED PROJECTS ARE INCLUDED, flagged rather than filtered. If kills
 * vanished from the page it would only ever show growth, and the single
 * behaviour the owner most needs to confirm — that the agent actually CLOSES
 * things (contract clause 4) — would be invisible precisely when it is working.
 */
export async function resolveGoalDetail(args: {
  workspaceId: string;
  goalId: string;
  activityLimit?: number;
}): Promise<unknown> {
  const { getOrgPg } = await import('@papercusp/db-org');
  // Dynamic like its neighbour above, and for the same reason: this module is
  // imported by callers that must not pay for the store's server dependencies at
  // module load. The TYPE it validates into is imported statically (erased).
  const { parseGoalLaunchSettings, LAUNCH_PROFILE_OPTIONS, GOAL_LAUNCH_DEFAULTS } = await import(
    '../goal-launch-settings'
  );
  const { sql } = getOrgPg();
  const { workspaceId, goalId, activityLimit = 40 } = args;
  // Same cut as resolveGoalsList — see the note there.
  const recentSinceMs = Date.now() - SPEND_RECENT_WINDOW_MS;

  const detail = await sql.begin(async (tx) => {
    await tx.unsafe(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId]);

    const [goalRow] = (await tx`
      SELECT g.id, g.title, g.body, g.status, g.parent_id, g.kill_criterion, g.tripwires,
             g.budget_cents, g.budget_window_sec, g.metadata, g.launch_settings, g.created_at, g.updated_at,
             0 AS pot_count, '[]'::json AS pots, 0 AS open_work_items, 0 AS needs_human,
             -- The goal-attributed stream, identical to the list query's, so the
             -- popup and the card it opened from report one figure.
             (SELECT SUM(s.cost_usd)
                FROM harness_shared.agent_usage_samples s
               WHERE s.workspace_id = g.workspace_id
                 AND s.goal_id = g.id
                 AND s.ts >= (EXTRACT(EPOCH FROM g.created_at) * 1000)::bigint) AS spend_usd,
             (SELECT SUM(s.cost_usd)
                FROM harness_shared.agent_usage_samples s
               WHERE s.workspace_id = g.workspace_id
                 AND s.goal_id = g.id
                 AND s.ts >= GREATEST(${recentSinceMs}::bigint,
                                      (EXTRACT(EPOCH FROM g.created_at) * 1000)::bigint)) AS spend_recent_usd
        FROM harness_shared.goals g
       WHERE g.workspace_id = ${workspaceId} AND g.id = ${goalId}
       LIMIT 1
    `) as unknown as RawGoal[];
    if (!goalRow) return { goal: null };

    // Pots, INCLUDING removed ones (see the note above) — `removedAt`
    // non-null is what the greyed-out card renders from.
    const potRows = (await tx`
      SELECT gp.harness_slug, gp.role, gp.kill_criterion, gp.note, gp.added_at, gp.removed_at,
             (SELECT COUNT(*) FROM harness_shared.goal_pots sib
               WHERE sib.workspace_id = gp.workspace_id
                 AND sib.harness_slug = gp.harness_slug
                 AND sib.removed_at IS NULL) AS serves_goals,
             (SELECT COALESCE(SUM(s.cost_usd), 0)
                FROM harness_shared.agent_usage_samples s
               WHERE s.workspace_id = gp.workspace_id
                 AND s.harness_slug = gp.harness_slug) AS spend_usd,
             (SELECT COUNT(*) FROM harness_shared.work_items wi
               WHERE wi.harness_slug = gp.harness_slug
                 AND wi.goal_id = gp.goal_id
                 AND wi.closed_ts IS NULL) AS open_work_items
        FROM harness_shared.goal_pots gp
       WHERE gp.workspace_id = ${workspaceId} AND gp.goal_id = ${goalId}
       ORDER BY (gp.removed_at IS NULL) DESC, (gp.role = 'owner') DESC, gp.added_at ASC
    `) as unknown as Array<Record<string, unknown>>;

    // Waiting on you — the asks only the owner can clear. This is the first
    // thing the detail view shows after the kill criterion, because it is the
    // only section the owner can ACT on.
    const waiting = (await tx`
      SELECT wi.feature_id AS id, wi.title, wi.harness_slug,
             to_timestamp(wi.updated_ts / 1000.0) AS updated_at
        FROM harness_shared.work_items wi
       WHERE wi.goal_id = ${goalId}
         AND wi.closed_ts IS NULL
         AND COALESCE((wi.payload->>'needsHuman')::boolean, false)
       ORDER BY wi.updated_ts DESC NULLS LAST
       LIMIT 25
    `) as unknown as Array<Record<string, unknown>>;

    // The TRUE number parked on the owner, counted UNBOUNDED against the SAME
    // predicate as the row fetch above.
    //
    // ⚠ THIS IS NOT REDUNDANT WITH `waiting.length`. That array is capped at 25,
    // and a capped list length rendered as an aggregate is the repeat-offender
    // class this repo has already paid for (CLAUDE.md: "a caller's `limit` bounds
    // ROW LISTS ONLY — never an aggregate"; measured in WI-37381, where a capped
    // fetch reported `terminal.total 0` against a true 1693). It matters most
    // HERE, because "waiting on you" is the one lane only the owner can clear, and
    // the failure direction is silent UNDER-reporting of the owner's own queue.
    //
    // Counted separately rather than by lifting the LIMIT: the payload stays
    // bounded while the aggregate stays honest. Both are needed — the rows to
    // render, the count to be truthful about how many there are.
    const [waitingTotalRow] = (await tx`
      SELECT COUNT(*)::int AS total
        FROM harness_shared.work_items wi
       WHERE wi.goal_id = ${goalId}
         AND wi.closed_ts IS NULL
         AND COALESCE((wi.payload->>'needsHuman')::boolean, false)
    `) as unknown as Array<Record<string, unknown>>;

    const activity = (await tx`
      SELECT wi.feature_id AS id, wi.title, wi.harness_slug, wi.status,
             to_timestamp(wi.closed_ts / 1000.0) AS closed_at,
             to_timestamp(wi.updated_ts / 1000.0) AS updated_at
        FROM harness_shared.work_items wi
       WHERE wi.goal_id = ${goalId}
       ORDER BY wi.updated_ts DESC NULLS LAST
       LIMIT ${activityLimit}
    `) as unknown as Array<Record<string, unknown>>;

    // Plans, DERIVED through the goal's stamped work items (D-010). The LEFT
    // JOIN is deliberate: a slug whose plan row is gone still returns a card
    // with a null title, because live work items pointing at a deleted plan is
    // exactly the state worth surfacing.
    // Migration 791 adds the SECOND leg: a plan CREATED under this goal, stamped
    // with `harness_plans.goal_id` from its creator's resolved goal context. The
    // two legs answer different questions and a goal needs both —
    //   derived  = "work on this goal came from that plan"  (may be a plan the goal
    //              never created; stays true after the goal agent is long gone)
    //   stamped  = "this goal's agent authored that plan"   (true from the instant
    //              it is created, before any work item exists)
    // — so this is a FULL OUTER JOIN, not a replacement. Dropping the derived leg
    // would lose plans a goal inherited work from; dropping the stamped leg is the
    // owner-reported bug (a brand-new goal's own plan showing nothing at all).
    //
    // The counts stay strictly the DERIVED ones: `items`/`openItems` mean "work
    // items on this goal that came from this plan", and a stamped-only plan
    // genuinely has zero of those. Coalescing them to the plan's own size here
    // would silently change what the number means — that is why `stamped` ships
    // as its own flag instead, so the UI can say "started by this goal" rather
    // than render a misleading "0 of 0".
    const planRows = (await tx`
      WITH derived AS (
        SELECT wi.source_plan_slug AS plan_slug,
               wi.harness_slug,
               COUNT(*) AS items,
               COUNT(*) FILTER (WHERE wi.closed_ts IS NULL) AS open_items,
               MAX(wi.updated_ts) AS updated_ms
          FROM harness_shared.work_items wi
         WHERE wi.goal_id = ${goalId}
           AND wi.source_plan_slug IS NOT NULL
         GROUP BY wi.source_plan_slug, wi.harness_slug
      ),
      stamped AS (
        SELECT p.plan_slug, p.harness_slug
          FROM harness_shared.harness_plans p
         WHERE p.workspace_id = ${workspaceId}
           AND p.goal_id = ${goalId}
      ),
      keys AS (
        SELECT plan_slug, harness_slug FROM derived
        UNION
        SELECT plan_slug, harness_slug FROM stamped
      )
      SELECT k.plan_slug,
             k.harness_slug,
             p.title, p.status, COALESCE(p.archived, false) AS archived,
             COALESCE(d.items, 0) AS items,
             COALESCE(d.open_items, 0) AS open_items,
             (s.plan_slug IS NOT NULL) AS stamped,
             to_timestamp(
               COALESCE(d.updated_ms, EXTRACT(EPOCH FROM p.updated_at) * 1000)
               / 1000.0
             ) AS updated_at
        FROM keys k
        -- LEFT JOIN, deliberately: a slug whose plan row is gone still returns a
        -- card with a null title, because live work items pointing at a deleted
        -- plan is exactly the state worth surfacing.
        LEFT JOIN harness_shared.harness_plans p
               ON p.workspace_id = ${workspaceId}
              AND p.harness_slug = k.harness_slug
              AND p.plan_slug = k.plan_slug
        LEFT JOIN derived d
               ON d.plan_slug = k.plan_slug AND d.harness_slug = k.harness_slug
        LEFT JOIN stamped s
               ON s.plan_slug = k.plan_slug AND s.harness_slug = k.harness_slug
       ORDER BY COALESCE(d.open_items, 0) DESC,
                COALESCE(d.updated_ms, EXTRACT(EPOCH FROM p.updated_at) * 1000) DESC NULLS LAST
    `) as unknown as Array<Record<string, unknown>>;

    // The agent(s) RUNNING this goal (P-018's conversation affordance). D-007:
    // the goal↔agent marker is `agent_modes.subject` — no dedicated column and
    // no migration was ever needed. `goals:start` writes this row, so the goal
    // popup can offer the ONE honest conversation affordance available to it:
    // a route to the agent's existing conversation, never a composer of its own
    // (see GoalDetailPanel's docblock and D-011).
    //
    // D-006 makes this a single agent in practice (one directed agent = one
    // goal), but it is returned as a LIST rather than a scalar: collapsing it
    // would silently hide a second stamp, and a goal with two agents is a
    // coordination fault worth SEEING rather than a row to discard.
    //
    // P-001: this read is RAW because the popup needs set_at/set_by, which the
    // shared holder read does not project — but the rows are folded through
    // `resolveGoalHoldersFromRows` below before anything renders them, so the
    // popup can never again show a dead holder as an available conversation.
    const agentRows = (await tx`
      SELECT am.owner_id, am.set_at, am.set_by,
             (extract(epoch FROM am.set_at) * 1000)::bigint AS set_ms
        FROM harness_shared.agent_modes am
       WHERE am.workspace_id = ${workspaceId}
         AND am.mode = 'goal'
         AND am.subject = ${goalId}
       ORDER BY am.set_at DESC
    `) as unknown as Array<Record<string, unknown>>;

    // Spend by day, stacked by harness — the shape the chart wants, computed
    // once here rather than bucketed client-side over a raw sample list. The
    // same goal-attributed stream as spend_usd above (WI-1074208), so the chart
    // adds up to the figure beside it; harness_slug may be NULL on those rows.
    const spendByDay = (await tx`
      SELECT to_char(to_timestamp(s.ts / 1000.0) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
             s.harness_slug,
             COALESCE(SUM(s.cost_usd), 0) AS cost
        FROM harness_shared.agent_usage_samples s
        JOIN harness_shared.goals g
          ON g.id = s.goal_id AND g.workspace_id = s.workspace_id
       WHERE s.workspace_id = ${workspaceId}
         AND s.goal_id = ${goalId}
         AND s.ts >= (EXTRACT(EPOCH FROM g.created_at) * 1000)::bigint
       GROUP BY day, s.harness_slug
       ORDER BY day ASC
    `) as unknown as Array<Record<string, unknown>>;

    const pots = potRows.map((p) => ({
      harnessSlug: String(p.harness_slug),
      role: p.role === 'owner' ? 'owner' : 'contributing',
      killCriterion: (p.kill_criterion as string | null) ?? null,
      note: (p.note as string | null) ?? null,
      addedAt: iso(p.added_at as string | Date | null),
      removedAt: iso(p.removed_at as string | Date | null),
      servesGoals: num(p.serves_goals),
      spendUsd: num(p.spend_usd),
      openWorkItems: num(p.open_work_items),
    }));

    // P-001: the popup's holder verdict, folded from the rows already fetched
    // above — one shared classifier, no second oracle round-trip, and the same
    // held/unheld/lost/unknown vocabulary the board uses.
    const detailHolderRows: GoalHolderRow[] = agentRows.map((a) => ({
      goalId,
      workspaceId,
      ownerId: String(a.owner_id),
      setAtMs: Number(a.set_ms ?? 0),
      setBy: (a.set_by as string | null) ?? null,
    }));
    const detailHolders = resolveGoalHoldersFromRows(
      goalId,
      workspaceId,
      detailHolderRows,
      await resolveHolderLiveness(detailHolderRows.map((r) => r.ownerId)),
    );
    /* PER-GOAL LAUNCH SETTINGS (P-005), read through the SAME schema that
       validates the write. Parsed here rather than handed over raw so the panel
       renders a document the launch resolver would actually honour — a raw blob
       would let the editor show, and re-save, a shape the ceiling code rejects.

       AN INVALID DOCUMENT IS REPORTED, NOT SWALLOWED. `readGoalLaunchSettings`
       makes the same call for the same reason: a settings blob that fails to
       parse means the owner's ceiling is NOT IN FORCE, and rendering that as
       "no settings" would show an unlimited goal as deliberately unlimited.
       The panel says so instead.

       HOISTED above `goal` (P-004) because the activity fold below needs it and
       `goal` carries the fold's result. */
    const {
      settings: launchSettings,
      error: launchSettingsInvalid,
      unknownKeys: launchSettingsUnknownKeys,
    } = parseGoalLaunchSettings(
      (goalRow as unknown as { launch_settings?: unknown }).launch_settings,
      `goal ${goalId} launch settings`,
    );

    /* P-004: fold status + holder policy + liveness into the reading the popup
       should actually show. Both inputs are already in hand — no extra query.

       NOTE the interaction with `launchSettingsInvalid` above: an unreadable
       document parses to `null`, which resolves to the DEFAULT policy
       (requireLive: true), so a corrupt blob makes the goal MORE guarded, not
       less. That is the opposite of the ceiling case, and deliberately so: a
       ceiling that fails open spends money, a holder requirement that fails
       open hides a dead goal. */
    const { resolveGoalEffectiveActivity } = await import('../goals/activity');
    const detailActivity = resolveGoalEffectiveActivity({
      status: (goalRow as unknown as { status?: string | null }).status ?? null,
      launchSettings,
      liveness: detailHolders.liveness,
    });

    const goal: GoalSummaryRow = {
      ...toSummary(goalRow, makeGoalPackageLookup()),
      agents: detailHolders.holders.map((h) => ({
        ownerId: h.ownerId,
        live: h.live,
        sessionState: h.sessionState,
      })),
      holderLiveness: detailHolders.liveness,
      effectiveStatus: detailActivity.effectiveStatus,
      deactivated: detailActivity.deactivated,
    };
    goal.potCount = pots.filter((p) => !p.removedAt).length;
    // From the UNBOUNDED count, never `waiting.length` — that array stops at 25,
    // so a goal with 31 parked items used to render "31 needs you" on the card
    // (goals.list counts unbounded) and "25 waiting on you" in this panel, with
    // nothing disclosing the cap. Sourcing both from the same predicate makes the
    // two surfaces agree BY CONSTRUCTION rather than by coincidence.
    goal.needsHuman = num(waitingTotalRow?.total);
    // spendUsd / spendRecentUsd stay as the goal row measured them (the
    // goal-attributed stream). They are NOT re-summed from the pots below: a
    // pot's spend is its harness's whole population, not this goal's, and a
    // goal with no pots would sum to a $0 nothing measured (WI-1074208).
    goal.openWorkItems = pots.reduce((acc, p) => acc + p.openWorkItems, 0);

    /* SUBDIRECTIVES + the parent, for the popup's hierarchy section
       (goals-tab-improvement-2026-08-09 P-017).

       Deliberately NARROW — id/title/status only. No spend, no ceiling, no
       counts: per D-006 one goal is one agent is one bill, so a child HAS no
       separable spend, and selecting a column that looks like one would invite
       the parent+children addition D-002 forbids. The columns are absent rather
       than zeroed, because a rendered 0 reads as a measurement.

       Ordered oldest-first: these are the directions the agent was pointed in,
       and that sequence is the readable story of how the goal got here. */
    const childRows = (await tx`
      SELECT g.id, g.title, g.status
        FROM harness_shared.goals g
       WHERE g.workspace_id = ${workspaceId} AND g.parent_id = ${goalId}
       ORDER BY g.created_at ASC
       LIMIT 200
    `) as unknown as Array<{ id: string; title: string | null; status: string | null }>;

    /* The parent's TITLE, so a child's popup can name what it serves instead of
       rendering a bare id the owner would have to go look up. Skipped entirely
       when this goal has no parent. */
    const parentId = (goalRow.parent_id as string | null) ?? null;
    const [parentRow] = parentId
      ? ((await tx`
          SELECT g.id, g.title
            FROM harness_shared.goals g
           WHERE g.workspace_id = ${workspaceId} AND g.id = ${parentId}
           LIMIT 1
        `) as unknown as Array<{ id: string; title: string | null }>)
      : [];

    return {
      goal,
      /** Null = none declared, and NOT an error. Since D-015 that means the
       *  SYSTEM DEFAULT ceilings (shipped below), not no ceiling — a goal that is
       *  deliberately ungoverned says so with an explicit 'unlimited'. */
      launchSettings,
      /** Non-null when the stored document could not be read — the ceilings are
       *  therefore NOT being enforced, which the panel must say out loud. */
      launchSettingsInvalid,
      /** WI-2140573: keys the lenient read STRIPPED (dotted paths). Every other
       *  key is in force; these bind nothing on this host — usually a key from a
       *  newer schema than the reader runs, else a typo. Never render them as
       *  configured. */
      launchSettingsUnknownKeys,
      /** What an UNPINNED ceiling actually resolves to (D-015). Shipped for the
       *  same reason as the option lists below: the editor must be able to say
       *  "default 12" without hand-spelling a number the resolver owns and can
       *  change underneath it. */
      launchSettingsDefaults: GOAL_LAUNCH_DEFAULTS,
      /** The closed sets the editor may offer, from the schema's own constants
       *  (D-011): shipped rather than re-spelled client-side so the form cannot
       *  drift from the validator. */
      launchSettingsOptions: LAUNCH_PROFILE_OPTIONS,
      /** Present and empty when this goal has none — never absent, so the panel
       *  can tell "no subdirectives" from "this payload predates P-017". */
      subGoals: childRows.map((c) => ({
        id: String(c.id),
        title: (c.title as string | null) ?? String(c.id),
        status: String(c.status ?? '').toLowerCase(),
      })),
      /** Null unless this goal IS a subdirective. */
      parent: parentRow
        ? { id: String(parentRow.id), title: (parentRow.title as string | null) ?? String(parentRow.id) }
        : null,
      pots,
      /** P-001: each holder carries its LIVENESS. `live: null` means the oracle
       *  could not resolve it — UNKNOWN, never dead. The popup's conversation
       *  affordance is only honest for a holder that is actually there. */
      agents: detailHolders.holders.map((h) => ({
        ownerId: h.ownerId,
        // From the holder row's own setAtMs — never a positional lookup back
        // into agentRows, which would silently mis-pair if the classifier ever
        // filtered or reordered.
        setAt: h.setAtMs > 0 ? new Date(h.setAtMs).toISOString() : null,
        setBy: h.setBy ?? null,
        live: h.live,
        sessionState: h.sessionState,
      })),
      /** held | unheld | lost | unknown — see GoalSummaryRow.holderLiveness. */
      holderLiveness: detailHolders.liveness,
      /** P-004: the status a reader should USE — `status` verbatim, or
       *  `'dormant'` when this goal requires a live holder and has none.
       *  Derived on this read from the settings and liveness already fetched
       *  above; the raw column is never written. */
      effectiveStatus: detailActivity.effectiveStatus,
      deactivated: detailActivity.deactivated,
      /** Why `deactivated` is what it is — the resolved policy the fold used,
       *  so the panel can say "inheriting the default" rather than re-deriving
       *  it from an absent key (D-008). */
      holderPolicy: detailActivity.policy,
      plans: planRows.map((p) => ({
        planSlug: String(p.plan_slug),
        harnessSlug: String(p.harness_slug),
        title: (p.title as string | null) ?? null,
        status: (p.status as string | null) ?? null,
        archived: p.archived === true,
        items: num(p.items),
        openItems: num(p.open_items),
        stamped: p.stamped === true,
        updatedAt: iso(p.updated_at as string | Date | null),
      })),
      /** The unbounded total, so the client can say "showing 25 of 31" instead of
       *  presenting a capped row count as the whole truth. */
      waitingOnYouTotal: num(waitingTotalRow?.total),
      waitingOnYou: waiting.map((w) => ({
        id: String(w.id),
        title: String(w.title),
        harnessSlug: (w.harness_slug as string | null) ?? null,
        updatedAt: iso(w.updated_at as string | Date | null),
      })),
      activity: activity.map((a) => ({
        id: String(a.id),
        title: String(a.title),
        harnessSlug: (a.harness_slug as string | null) ?? null,
        status: (a.status as string | null) ?? null,
        closedAt: iso(a.closed_at as string | Date | null),
        updatedAt: iso(a.updated_at as string | Date | null),
      })),
      spendByDay: spendByDay.map((d) => ({
        day: String(d.day),
        harnessSlug: (d.harness_slug as string | null) ?? null,
        costUsd: num(d.cost),
      })),
      // Repeated on the detail payload because this is the page most likely to
      // be screenshotted into a report, and a spend number without this caveat
      // invites the wrong comparison.
      spendLabel: 'goal-attributed spend',
      spendNote:
        'Priced usage stamped with this goal when it was recorded — the figure the budget is enforced on. No attributed usage reads as unmeasured, not $0. Per-pot figures are each pot harness’s whole spend and are not part of this total.',
    };
  });

  /* P-009 (shared-agent-obligations-and-briefs-2026-09-05): the goal popup
     shows the SAME bounded obligation projection the goal holder receives at
     turn start, plus the canonical portfolio snapshot that fed it.

     This deliberately runs AFTER the detail transaction. The policy reader
     owns several bounded canonical reads of its own; nesting those inside this
     transaction would hold one pool connection while waiting for sibling
     connections and would turn an optional read into a latency/deadlock risk
     for the otherwise healthy goal page. One client query still owns the whole
     response — this is a server composition boundary, not a second client
     clock or a client-side policy engine. */
  const shaped = detail as {
    goal: GoalSummaryRow | null;
    agents?: Array<{ ownerId: string }>;
    plans?: Array<{ planSlug: string }>;
  } & Record<string, unknown>;
  if (!shaped.goal) return detail;

  const { readAgentGoalModeState } = await import('../agent-obligation-reader');
  const goalModeState = await readAgentGoalModeState({
    workspaceId,
    goalId,
    // The popup and its conversation already define “the agent” as the most
    // recent canonical stamp (agents[0]); using that exact row prevents the
    // status section and the conversation control from disagreeing when a
    // coordination fault leaves two stamps visible.
    ownerId: shaped.agents?.[0]?.ownerId ?? null,
    planSlugs: [...new Set((shaped.plans ?? []).map((plan) => plan.planSlug).filter(Boolean))],
  });
  return { ...shaped, goalModeState };
}
