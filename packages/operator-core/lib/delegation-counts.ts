/**
 * The ONE shared live provider behind the four delegation counts
 * (plan generic-acceptance-routing-and-live-plan-agent-brief-2026-09-20, P-005 / R-5):
 *
 *   1. active plan-execution agents
 *   2. actionable plans awaiting delegation
 *   3. plans awaiting acceptance
 *   4. active drain fleets
 *
 * R-5 requires all four to come from ONE provider whose value tracks the
 * underlying population on the NEXT read. Two design consequences, both load-bearing:
 *
 * ⚠ THERE IS NO CACHE, DELIBERATELY. Every `readDelegationCounts` call re-reads
 * each population. A memoised count is the exact failure R-5's falsifier probes
 * for ("end one plan-execution agent, then re-read") — and a stale count is far
 * worse than a slow one here, because the consumer (P-006's plan-agent brief)
 * SPAWNS AGENTS off these numbers. A cached zero spawns nothing; a cached
 * non-zero spawns into work that is already taken.
 *
 * ⚠ A FAILED READ IS AN EXPLICIT `unknown`, NEVER 0. This is the anti-false-zero
 * rule this repo keeps re-learning (a wrong-relation SQL zero-row, a `| head`
 * SIGPIPE, a `pgrep -q` usage error — each returns a confident, well-formed
 * empty result). "Nothing is awaiting delegation" and "I could not measure what
 * is awaiting delegation" are opposite instructions to a brief that decides
 * whether to spawn, so they must not share a representation. `ProviderRead`
 * already encodes that distinction; this module reuses it rather than inventing
 * a second three-valued shape.
 *
 * Population definitions are NOT re-spelled here. Each default dep delegates to
 * the population's canonical owner (see `defaultDelegationCountDeps`), because a
 * second hand-maintained copy of a population predicate is the derived-truth-ladder
 * failure — the copies drift and both look authoritative.
 */
import { withBoundedTimeout } from './bounded-timeout';
import type { ProviderRead } from './agent-obligation-providers';

type Sql = import('postgres').Sql;

export const DELEGATION_COUNTS_SCHEMA_VERSION = 'delegation-counts-v1' as const;

/** Default per-source budget. Matches the obligation reader's optional-read
 *  budget: this provider feeds a turn-start brief, so a slow source must degrade
 *  to an explicit unknown rather than hold the turn. */
export const DELEGATION_COUNT_READ_TIMEOUT_MS = 900;

/**
 * A measured population size, with its unmeasured residue ON the aggregate.
 *
 * `unmeasured` exists because the liveness oracle reports "not measured"
 * in band (`sessionState: null`) rather than by omission, and that unknown must
 * survive aggregation. A bare number cannot say "4 live, and 3 I could not
 * classify" — it would report 4 and read as complete, which is precisely the
 * bounded-measurement-rendered-as-a-verdict error the repo's aggregate rule
 * forbids. `unmeasured: 0` is the ordinary fully-measured case.
 */
export interface PopulationCount {
  count: number;
  unmeasured: number;
}

export interface DelegationCounts {
  schemaVersion: typeof DELEGATION_COUNTS_SCHEMA_VERSION;
  workspaceId: string;
  observedAt: string;
  elapsedMs: number;
  /** Live agents currently executing a plan. */
  planExecutionAgents: ProviderRead<PopulationCount>;
  /** Plans with unfinished work and no live agent on them. */
  plansAwaitingDelegation: ProviderRead<PopulationCount>;
  /** Plans gradeable now and not yet shipped. */
  plansAwaitingAcceptance: ProviderRead<PopulationCount>;
  /** Goal drain fleets with at least one live member. */
  activeDrainFleets: ProviderRead<PopulationCount>;
  /** Labels of the sources that degraded to `unknown` on this read. */
  degradedSources: string[];
}

/** One live presence row, already workspace-scoped. */
export interface DelegationPresenceRow {
  ownerId: string;
  currentPlanSlug: string | null;
  fleetSlug: string | null;
  heartbeatAt: string | null;
  host: string | null;
  pid: number | null;
  source: string | null;
}

/**
 * The per-call population context handed to every dep.
 *
 * `presence()` is memoised FOR THIS CALL ONLY: three of the four counts are
 * derived from the same live-presence snapshot, and letting each issue its own
 * read would make them mutually inconsistent (an agent that ends between two
 * reads is simultaneously counted and not counted). Memoising ACROSS calls would
 * break R-5's next-read property, so the cache lifetime is exactly one
 * `readDelegationCounts` invocation — not shorter, not longer.
 */
export interface DelegationCountContext {
  workspaceId: string;
  nowMs: number;
  presence: () => Promise<{ live: DelegationPresenceRow[]; unmeasured: number }>;
  sql: () => Promise<Sql>;
}

export interface DelegationCountDeps {
  planExecutionAgents: (ctx: DelegationCountContext) => Promise<PopulationCount>;
  plansAwaitingDelegation: (ctx: DelegationCountContext) => Promise<PopulationCount>;
  plansAwaitingAcceptance: (ctx: DelegationCountContext) => Promise<PopulationCount>;
  activeDrainFleets: (ctx: DelegationCountContext) => Promise<PopulationCount>;
}

const SOURCE_LABELS = {
  planExecutionAgents: 'plan-execution-agents',
  plansAwaitingDelegation: 'plans-awaiting-delegation',
  plansAwaitingAcceptance: 'plans-awaiting-acceptance',
  activeDrainFleets: 'active-drain-fleets',
} as const;

type SourceKey = keyof typeof SOURCE_LABELS;

/**
 * Run one source under a bounded timeout, mapping ANY failure to an explicit
 * unknown.
 *
 * The `fallback` is `null`, never a zero count — `withBoundedTimeout` resolves
 * with the fallback on timeout, so a zero fallback would silently manufacture
 * "the population is empty" out of a slow database.
 */
async function boundedCount(
  key: SourceKey,
  work: () => Promise<PopulationCount>,
  timeoutMs: number,
): Promise<ProviderRead<PopulationCount>> {
  const label = SOURCE_LABELS[key];
  let thrown: unknown;
  const result = await withBoundedTimeout<PopulationCount | null>(
    async () => {
      try {
        return await work();
      } catch (error) {
        thrown = error;
        return null;
      }
    },
    { fallback: null, timeoutMs, label: `delegation-counts:${label}` },
  );

  if (result.value && !result.degraded) {
    return { status: 'known', value: result.value };
  }

  const detail =
    thrown instanceof Error
      ? thrown.message
      : thrown != null
        ? String(thrown)
        : (result.errorMessage ?? result.reason ?? 'source unavailable');

  return {
    status: 'unknown',
    failure: {
      code: `delegation-count-unreadable:${label}`,
      detail,
      retry: `re-read delegation counts; this count is NOT zero, it was not measured (source ${label})`,
    },
  };
}

/**
 * Read all four counts in one concurrent wave.
 *
 * Every call re-reads. See the module header: the absence of a cache is the
 * mechanism by which R-5's next-read property holds, not an optimisation gap.
 */
export async function readDelegationCounts(input: {
  workspaceId: string;
  now?: Date;
  sourceTimeoutMs?: number;
  deps?: Partial<DelegationCountDeps>;
}): Promise<DelegationCounts> {
  const startedAt = Date.now();
  const now = input.now ?? new Date();
  const timeoutMs = input.sourceTimeoutMs ?? DELEGATION_COUNT_READ_TIMEOUT_MS;
  const deps: DelegationCountDeps = { ...defaultDelegationCountDeps(), ...(input.deps ?? {}) };

  let presenceOnce: Promise<{ live: DelegationPresenceRow[]; unmeasured: number }> | null = null;
  let sqlOnce: Promise<Sql> | null = null;

  const ctx: DelegationCountContext = {
    workspaceId: input.workspaceId,
    nowMs: now.getTime(),
    presence: () => {
      presenceOnce ??= readLivePresence(input.workspaceId, now.getTime(), () => ctx.sql());
      return presenceOnce;
    },
    sql: () => {
      sqlOnce ??= (async () => {
        const { getOrgPg } = await import('@papercusp/db-org');
        return getOrgPg().sql as unknown as Sql;
      })();
      return sqlOnce;
    },
  };

  const [planExecutionAgents, plansAwaitingDelegation, plansAwaitingAcceptance, activeDrainFleets] =
    await Promise.all([
      boundedCount('planExecutionAgents', () => deps.planExecutionAgents(ctx), timeoutMs),
      boundedCount('plansAwaitingDelegation', () => deps.plansAwaitingDelegation(ctx), timeoutMs),
      boundedCount('plansAwaitingAcceptance', () => deps.plansAwaitingAcceptance(ctx), timeoutMs),
      boundedCount('activeDrainFleets', () => deps.activeDrainFleets(ctx), timeoutMs),
    ]);

  const degradedSources = (
    [
      ['planExecutionAgents', planExecutionAgents],
      ['plansAwaitingDelegation', plansAwaitingDelegation],
      ['plansAwaitingAcceptance', plansAwaitingAcceptance],
      ['activeDrainFleets', activeDrainFleets],
    ] as Array<[SourceKey, ProviderRead<PopulationCount>]>
  )
    .filter(([, read]) => read.status === 'unknown')
    .map(([key]) => SOURCE_LABELS[key]);

  return {
    schemaVersion: DELEGATION_COUNTS_SCHEMA_VERSION,
    workspaceId: input.workspaceId,
    observedAt: now.toISOString(),
    elapsedMs: Date.now() - startedAt,
    planExecutionAgents,
    plansAwaitingDelegation,
    plansAwaitingAcceptance,
    activeDrainFleets,
    degradedSources,
  };
}

/**
 * The live-presence snapshot shared by three of the four counts.
 *
 * ⚠ LIVENESS COMES FROM THE SHARED ORACLE, NOT A HEARTBEAT THRESHOLD.
 * `lib/liveness.ts` says it outright: heartbeat freshness is PROCESS KEEPALIVE,
 * not an agent-liveness verdict, and "new verdict consumers must use
 * `resolveSessionStates`". A warm-dead session heartbeats perfectly while being
 * `ended`, so a `heartbeat_at > now() - interval` filter would count dead agents
 * as executing plans — and the brief would then decline to spawn because the
 * work looks staffed.
 *
 * A subject the oracle could not classify (`sessionState: null` — reported in
 * band, never by omission) is counted in `unmeasured`, never silently dropped
 * and never collapsed into live or dead.
 */
async function readLivePresence(
  workspaceId: string,
  nowMs: number,
  getSql: () => Promise<Sql>,
): Promise<{ live: DelegationPresenceRow[]; unmeasured: number }> {
  const sql = await getSql();
  const rows = await sql<
    Array<{
      owner_id: string;
      current_plan_slug: string | null;
      fleet_slug: string | null;
      heartbeat_at: Date | null;
      host: string | null;
      pid: number | null;
      source: string | null;
    }>
  >`
    SELECT owner_id, current_plan_slug, fleet_slug, heartbeat_at, host, pid, source
      FROM harness_shared.coord_presence
     WHERE workspace_id = ${workspaceId}`;

  if (rows.length === 0) return { live: [], unmeasured: 0 };

  const { resolveSessionStates } = await import('./agent-tools/coordination/liveness-oracle');
  const verdicts = await resolveSessionStates(
    rows.map((r) => ({
      ownerId: r.owner_id,
      heartbeatAt: r.heartbeat_at ? new Date(r.heartbeat_at).toISOString() : null,
      host: r.host,
      pid: r.pid,
      source: r.source,
    })),
    { nowMs },
  );

  const live: DelegationPresenceRow[] = [];
  let unmeasured = 0;
  for (const r of rows) {
    const verdict = verdicts.get(r.owner_id);
    // An absent key means "you did not ask about this owner" — impossible here,
    // since every row was submitted. Treat it the same as an in-band null: not
    // measured, never collapsed into a definite state.
    if (!verdict || verdict.sessionState == null) {
      unmeasured += 1;
      continue;
    }
    if (verdict.sessionState !== 'live') continue;
    live.push({
      ownerId: r.owner_id,
      currentPlanSlug: r.current_plan_slug,
      fleetSlug: r.fleet_slug,
      heartbeatAt: r.heartbeat_at ? new Date(r.heartbeat_at).toISOString() : null,
      host: r.host,
      pid: r.pid,
      source: r.source,
    });
  }
  return { live, unmeasured };
}

/**
 * Production wiring. Each dep delegates to the population's canonical owner;
 * none of them re-spells a population predicate.
 */
export function defaultDelegationCountDeps(): DelegationCountDeps {
  return {
    /** Live agents with a declared plan lane. */
    planExecutionAgents: async (ctx) => {
      const { live, unmeasured } = await ctx.presence();
      const owners = new Set(live.filter((r) => r.currentPlanSlug).map((r) => r.ownerId));
      return { count: owners.size, unmeasured };
    },

    /**
     * Plans carrying unfinished work that NO live agent is executing.
     *
     * ⚠ SCOPE, STATED HONESTLY: this is the PLAN-level question ("does this plan
     * need an agent?"), which is what a delegation brief acts on. It is a strict
     * UPPER BOUND with respect to `plans:items { actionable: true }`, whose
     * item-level gating additionally withholds items with a linked blocked
     * work-item and items under partial/full live coverage. A plan whose only
     * `todo` items are blocked therefore counts here and would not yield a
     * pickable item there. That residue is deliberate and named rather than
     * silently folded in: narrowing it belongs to P-006's priority ordering,
     * where the brief already loads items, and re-deriving the item-level gate
     * here would be the second hand-maintained copy this module exists to avoid.
     */
    plansAwaitingDelegation: async (ctx) => {
      const [sql, { live, unmeasured }] = await Promise.all([ctx.sql(), ctx.presence()]);
      const staffed = new Set(
        live.map((r) => r.currentPlanSlug).filter((slug): slug is string => Boolean(slug)),
      );
      const rows = await sql<Array<{ plan_slug: string; harness_slug: string | null }>>`
        SELECT p.plan_slug, p.harness_slug
          FROM harness_shared.harness_plans p
         WHERE p.workspace_id = ${ctx.workspaceId}
           AND p.archived = FALSE
           AND p.is_legacy IS NOT TRUE
           AND p.status IN ('ready', 'active')
           AND p.template IS NULL
           AND EXISTS (
                 SELECT 1
                   FROM jsonb_array_elements(COALESCE(p.items, '[]'::jsonb)) AS item
                  WHERE item->>'status' = 'todo'
               )`;

      // PRIME BEFORE FILTERING — never drop this await. `isHarnessInScope`'s default
      // `policy` argument is the SYNC `workScopePolicy()`, which reads a
      // `placementOverride()` cache that starts EMPTY at boot and is filled by a 60s
      // managed refresh. An empty policy is "not enforced", and `isHarnessInScope` then
      // returns true for EVERY slug — it fails OPEN. Unprimed, this count therefore
      // includes out-of-scope plans for the first ~60s of a process, which is D-014's
      // measured 52-on-first-read / 51-thereafter, and this module's header states the
      // platform SPAWNS AGENTS off these numbers: a cold-start over-count can launch a
      // fleet against a harness the stored policy forbids. `primeWorkScopePolicy` is
      // memoised once per process, is a no-op under VITEST (where the sync cache IS the
      // fixture), and never throws — a failed refresh keeps the previous fail-open
      // contract rather than breaking the caller. Guarded by WI-10002448; the property
      // is R-5's "at decision time ... not a stale cached count".
      const { isHarnessInScope, primeWorkScopePolicy } = await import('./work-scope-policy');
      await primeWorkScopePolicy();
      const awaiting = rows.filter(
        (r) => isHarnessInScope(r.harness_slug) && !staffed.has(r.plan_slug),
      );
      return { count: awaiting.length, unmeasured };
    },

    /** Delegated wholesale to the grading sweep's own candidate definition. */
    plansAwaitingAcceptance: async (ctx) => {
      const [sql, { RUBRIC_TEMPLATE_NAME }, { countPlansAwaitingAcceptance }] = await Promise.all([
        ctx.sql(),
        import('./agent-tools/plans/rubric-template'),
        import('./acceptance-awaiting-plans'),
      ]);
      const count = await countPlansAwaitingAcceptance({
        sql,
        rubricTemplateName: RUBRIC_TEMPLATE_NAME,
        workspaceId: ctx.workspaceId,
      });
      return { count, unmeasured: 0 };
    },

    /**
     * Goal drain fleets with at least one LIVE member.
     *
     * "Active" is membership-live, not merely minted: a drain fleet whose members
     * have all ended is exactly the case the brief must treat as needing
     * attention, so counting the mint record would report coverage that does not
     * exist. The slug identity comes from `isDrainFleetSlug`, which shares the
     * prefix constant with `drainFleetSlugForGoal` — the minting side — so the
     * two cannot disagree about what a drain fleet is called.
     */
    activeDrainFleets: async (ctx) => {
      const [{ live, unmeasured }, { isDrainFleetSlug }] = await Promise.all([
        ctx.presence(),
        import('./goals/drain-fleet-mint'),
      ]);
      const fleets = new Set(
        live
          .map((r) => r.fleetSlug)
          .filter((slug): slug is string => Boolean(slug) && isDrainFleetSlug(slug as string)),
      );
      return { count: fleets.size, unmeasured };
    },
  };
}

/**
 * Render one count for a brief line, preserving the unknown.
 *
 * Exists so consumers cannot casually `?? 0` an unknown back into a confident
 * zero at the presentation layer — which would reintroduce, one layer up,
 * exactly the false-zero this module's three-valued reads prevent.
 */
export function renderDelegationCount(read: ProviderRead<PopulationCount>): string {
  if (read.status === 'unknown') return 'unknown (not measured)';
  if (read.value.unmeasured > 0) {
    return `${read.value.count} (+${read.value.unmeasured} unmeasured)`;
  }
  return String(read.value.count);
}
