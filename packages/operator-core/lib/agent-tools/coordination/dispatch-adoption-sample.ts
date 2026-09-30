/**
 * dispatch-adoption-sample.ts — the IO seam that FEEDS the `coord:dispatch`
 * retirement falsifier (`dispatch-adoption-falsifier.ts`, plan
 * `coordination-spec-adoption-2026-08-03` P-013 / D-100 / D-101 / D-102).
 *
 * WHY A SEPARATE FILE. The falsifier is deliberately PURE — it judges a sample
 * against a pre-committed bar and touches nothing. Putting SQL in it would make
 * the one part of this mechanism that must stay trivially reviewable depend on a
 * database. This file holds the measurement; that one holds the judgement. It
 * mirrors how `enforcement-tier-census.ts` keeps its IO seams beside its pure
 * builder rather than inside it.
 *
 * ⚠⚠ THE WINDOW IS BOUNDED BY RETENTION, NOT BY THE ASK — and that is the whole
 * reason this file is careful. `harness_shared.tool_invocations` is pruned to
 * **14 days** by `telemetry-retention` (`DEFAULT_RETENTION_TARGETS`,
 * telemetry-retention-action.ts). So a query written as "trailing 30 days"
 * silently returns ~14 days of rows and reports NOTHING about the truncation:
 * measured 2026-08-09, `interval '30 days'` and the full table returned the same
 * span (oldest row 14d 6h old), and the same `coord:send` count fell 3,724 -> 3,106
 * in five hours as the prune ran underneath it.
 *
 * Publishing that as `windowDays: 30` would break this plan's own **D-003** —
 * *"a ratio whose denominator is not stated is not an adoption metric, it is a
 * number that will be quoted as one"* — which is precisely the failure the
 * falsifier was written to avoid. So the sampler DERIVES the window it actually
 * covered from the oldest retained row and publishes THAT, and can only ever
 * report a window it can substantiate. Shortening retention tomorrow narrows the
 * published window instead of silently inflating it.
 *
 * ⚠ ALL TENANTS ON PURPOSE — do NOT add a `workspace_id` filter. The baseline in
 * `DISPATCH_BASELINE` was measured across every tenant, and a falsifier whose
 * sample is scoped differently from its baseline compares two different
 * populations while reporting a `liftVsBaseline`. `dev:pg_query` emits a
 * tenant-scope advisory on exactly this shape; here the unscoped read is the
 * correct one, which is why this note exists to stop a well-meaning "fix".
 */
import type { DispatchAdoptionSample } from './dispatch-adoption-falsifier';

/** The verb under test, and the denominator it is normalised against (D-101). */
export const DISPATCH_TOOL = 'coord:dispatch';
export const SEND_TOOL = 'coord:send';

/**
 * What we ASK for. Matches the live `tool-invocations` retention (14d) rather
 * than the 30 the baseline text originally claimed, so the ask is satisfiable in
 * the normal case and `coverage.shortfall` means something real when it fires.
 */
export const DISPATCH_SAMPLE_WINDOW_DAYS = 14;

/**
 * The seed lists a LIVE role can actually be handed. `QUEEN_MCP_TOOL_NAMES` is
 * deliberately absent: it belongs to `role === 'mug'`, the retired autonomous
 * tier, so presence there reaches no running agent.
 */
export const LIVE_SEED_LIST_NAMES = [
  'CORE_MCP_TOOL_NAMES',
  'BEE_MCP_TOOL_NAMES',
  'OVERWATCH_MCP_TOOL_NAMES',
] as const;

/**
 * Is the P-011 intervention — `coord:dispatch` on a seeded tool surface — actually
 * LIVE? This is the precondition the falsifier's `retire` branch asserts about
 * itself, lifted out to where it can be checked.
 *
 * MEASURED 2026-09-02 (WI-2142095): **true**, as of the P-011 delivery fix landed
 * the same day. `coord:dispatch` is now in `CORE_MCP_TOOL_NAMES`, so every live
 * role seeds it and an agent meets the verb without already knowing its name.
 *
 * It was **false** until that fix: the verb appeared exactly once in
 * `libs/papercusp/packages/orchestrator/src/invoke.ts`, inside
 * `QUEEN_MCP_TOOL_NAMES` — the retired mug tier — and in none of
 * {@link LIVE_SEED_LIST_NAMES}. That gap is why the falsifier's re-evaluation
 * date moved to 2026-09-16 (`DISPATCH_ADOPTION_FLOOR.reEvaluateAfter`, the
 * authority — do not restate the date elsewhere): a read must NOT count call
 * rate from before 2026-09-02 as demand evidence, because for that
 * whole window the verb was unreachable, so a low rate measures ABSENCE, not
 * rejection. Retiring on it would be the zero-call-count error this plan exists
 * to prevent.
 *
 * ⚠ WHY A PINNED CONSTANT AND NOT A RUNTIME IMPORT. Deriving this at runtime
 * means importing the orchestrator's seed lists into the sampler, and the only
 * export path is the package ROOT (`@papercusp/orchestrator`), which carries
 * `invoke()` and the whole agent main loop — far too much to pull into a
 * telemetry read. So this is rung 2 of the derived-truth ladder (PIN, not
 * DERIVE): the constant states the measurement, and
 * `dispatch-intervention-reachable.test.ts` imports the real seed lists and
 * FAILS if this value ever stops matching them. Flip it by making the code true,
 * never by editing this line to make a test pass.
 *
 * FALSIFIER: `coord:dispatch` appearing in any of {@link LIVE_SEED_LIST_NAMES}.
 * When seeding lands, that test goes red and tells you to set this to `true`.
 */
export const DISPATCH_INTERVENTION_REACHABLE = true;

/** How much of the requested window the retained data could actually support. */
export interface DispatchAdoptionCoverage {
  /** the window we asked for. */
  requestedWindowDays: number;
  /** the window the retained rows actually cover (floored to whole days). */
  coveredWindowDays: number;
  /** true when retention could not serve the full ask — the published window was narrowed. */
  shortfall: boolean;
  /** oldest retained row, the fact the coverage is derived from. */
  oldestRetainedAt: string;
}

export interface DispatchAdoptionReading {
  sample: DispatchAdoptionSample;
  coverage: DispatchAdoptionCoverage;
}

/** `YYYY-MM-DD` — the shape the falsifier's `asOf < reEvaluateAfter` compare needs. */
export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Take a live adoption sample.
 *
 * Fail-soft to `undefined` (an empty telemetry table, an outage): the caller
 * removes ONE signal rather than publishing a zero. A zero dispatch count on an
 * unread table is indistinguishable from real disuse, and that conflation is the
 * exact error D-102 caught five times over — so it must never reach the evaluator
 * as data.
 */
export async function loadDispatchAdoptionSample(opts: {
  readonly windowDays?: number;
  readonly now?: Date;
  readonly getSql: () => {
    <T>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  };
}): Promise<DispatchAdoptionReading | undefined> {
  const requestedWindowDays = opts.windowDays ?? DISPATCH_SAMPLE_WINDOW_DAYS;
  const now = opts.now ?? new Date();
  const sql = opts.getSql();

  const rows = await sql<
    Array<{
      dispatch_calls: string | number;
      dispatch_agents: string | number;
      send_calls: string | number;
      oldest_retained: string | Date | null;
    }>
  >`
    SELECT
      count(*) FILTER (WHERE tool_name = ${DISPATCH_TOOL})                       AS dispatch_calls,
      count(DISTINCT coord_owner_id) FILTER (WHERE tool_name = ${DISPATCH_TOOL}) AS dispatch_agents,
      count(*) FILTER (WHERE tool_name = ${SEND_TOOL})                           AS send_calls,
      (SELECT min(invoked_at)
         FROM harness_shared.tool_invocations
        WHERE harness_shared.is_agent_coord_owner_id(coord_owner_id, role))      AS oldest_retained
      FROM harness_shared.tool_invocations
     WHERE tool_name IN (${DISPATCH_TOOL}, ${SEND_TOOL})
       AND harness_shared.is_agent_coord_owner_id(coord_owner_id, role)
       AND invoked_at >= now() - make_interval(days => ${requestedWindowDays})
  `;

  const row = rows?.[0];
  if (!row || row.oldest_retained == null) return undefined; // no telemetry at all — remove the signal, never publish a zero

  const oldest = new Date(row.oldest_retained as string);
  if (Number.isNaN(oldest.getTime())) return undefined;

  const coveredWindowDays = Math.max(
    0,
    Math.floor((now.getTime() - oldest.getTime()) / 86_400_000),
  );
  // Publish the window we can SUBSTANTIATE, never the one we asked for (D-003).
  const windowDays = Math.min(requestedWindowDays, coveredWindowDays);
  if (windowDays <= 0) return undefined;

  return {
    sample: {
      dispatchCalls: Number(row.dispatch_calls),
      dispatchAgents: Number(row.dispatch_agents),
      sendCalls: Number(row.send_calls),
      windowDays,
      asOf: isoDay(now),
      interventionReachable: DISPATCH_INTERVENTION_REACHABLE,
    },
    coverage: {
      requestedWindowDays,
      coveredWindowDays,
      shortfall: coveredWindowDays < requestedWindowDays,
      oldestRetainedAt: oldest.toISOString(),
    },
  };
}
