/**
 * PG-backed cross-process GovernorStore (RB-007).
 *
 * The domain-free `RateLimitGovernor` (libs/papercusp-shared/src/resilience) exposes a
 * `GovernorStore` seam for its RATE + PAUSE budget — the account-wide part that causes 429s when
 * the fleet co-bursts a shared Anthropic/OpenAI account. This is the OPERATOR-side PG
 * implementation: one leased row per bucket key in `harness_shared.agent_rate_budget`, mutated
 * under a single transactional read-modify-write (`SELECT … FOR UPDATE` → UPSERT), mirroring
 * `operator-rate-limit.ts`. Installing it via `setGovernorStore` makes every operator process +
 * the gym + this dev session pace against ONE budget.
 *
 * CONCURRENCY stays per-process (the governor reserves its local slot before the shared-rate
 * await), so this row carries only the rate window + pause + auto-tuned limits — no in_flight/lease
 * column. The tumbling 60s window self-expires, so a crashed process leaks no shared state.
 *
 * Lib stays domain-free; all the PG coupling is here.
 */
import { getOrgPg } from '@papercusp/db-org';
import { initGovernorState, type GovernorState, type GovernorLimits, type GovernorStore } from '@papercusp/papercusp-shared/agent';

/** The postgres-js client shape `getOrgPg().sql` returns (supports `sql.begin` + tagged calls). */
type SqlClient = ReturnType<typeof getOrgPg>['sql'];

/** Coerce a postgres-js column (bigint → string, integer → number) to a finite number. */
function n(v: unknown, fallback = 0): number {
  const x = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(x) ? x : fallback;
}

interface BudgetRow {
  window_start: unknown;
  req_in_window: unknown;
  in_tok_in_window: unknown;
  out_tok_in_window: unknown;
  paused_until: unknown;
  pace_delay_ms: unknown;
  last_acquire_at: unknown;
  limits: Partial<GovernorLimits> | string | null;
  rpm_factor: unknown;
  rpm_factor_at: unknown;
}

function rowToState(row: BudgetRow, floor: GovernorLimits): GovernorState {
  const s = initGovernorState(floor);
  s.windowStart = n(row.window_start);
  s.reqInWindow = n(row.req_in_window);
  s.inTokInWindow = n(row.in_tok_in_window);
  s.outTokInWindow = n(row.out_tok_in_window);
  s.pausedUntil = n(row.paused_until);
  s.paceDelayMs = n(row.pace_delay_ms);
  s.lastAcquireAt = n(row.last_acquire_at);
  // C1 (inference-gateway-audit-2026-06-23): the adaptive-RPM learned factor must survive the cross-process
  // round-trip — without it, `transact` runs the rate gate on `effectiveRpmFactor === 1` every time and the
  // account never learns down off a soft-throttle. NULL ⇒ undefined (effectiveRpmFactor treats it as 1), NEVER
  // 0 (a real-but-wrong factor that would pace the account to a crawl). The pair is read/written atomically.
  s.rpmFactor = row.rpm_factor == null ? undefined : Number(row.rpm_factor);
  s.rpmFactorAt = row.rpm_factor_at == null ? undefined : n(row.rpm_factor_at);
  // Persisted (auto-tuned) limits win; the floor's maxConcurrent is local-only so keep it.
  // jsonb usually arrives parsed, but be defensive against a string-returning client config.
  const l: Partial<GovernorLimits> =
    typeof row.limits === 'string' ? (JSON.parse(row.limits) as Partial<GovernorLimits>) : row.limits ?? {};
  s.limits = {
    maxConcurrent: floor.maxConcurrent,
    ...(l.rpm !== undefined ? { rpm: l.rpm } : floor.rpm !== undefined ? { rpm: floor.rpm } : {}),
    ...(l.itpm !== undefined ? { itpm: l.itpm } : {}),
    ...(l.otpm !== undefined ? { otpm: l.otpm } : {}),
  };
  // inFlight is per-process (not shared) → always 0 on a freshly-loaded shared row.
  s.inFlight = 0;
  return s;
}

export class PgGovernorStore implements GovernorStore {
  /** Defaults to the operator's admin client; an explicit client is injected by tests. */
  constructor(private readonly sqlClient?: SqlClient) {}

  async transact(key: string, floor: GovernorLimits, mutate: (s: GovernorState) => void): Promise<GovernorState> {
    const sql = this.sqlClient ?? getOrgPg().sql;
    return (await sql.begin(async (tx) => {
      const rows = (await tx`
        SELECT window_start, req_in_window, in_tok_in_window, out_tok_in_window,
               paused_until, pace_delay_ms, last_acquire_at, limits, rpm_factor, rpm_factor_at
          FROM harness_shared.agent_rate_budget
         WHERE bucket_key = ${key}
         FOR UPDATE
      `) as unknown as BudgetRow[];
      const s = rows.length > 0 ? rowToState(rows[0], floor) : initGovernorState(floor);
      mutate(s);
      // Persist ONLY rate+pause fields (the shared budget). limits carries auto-tuned rpm/itpm/otpm.
      // Bind jsonb as `${JSON.stringify(x)}::jsonb` — NOT sql.json() and NOT a bare object: both
      // THROW "Buffer.byteLength received Object" under the operator's getOrgPg runtime client
      // (verified live). `rowToState` reads it back shape-tolerantly because the *testcontainer*
      // client double-encodes this same form (the inverse divergence). See
      // /internal/docs/agent-insights/postgres-js-jsonb-binding.
      const limitsObj = {
        ...(s.limits.rpm !== undefined ? { rpm: s.limits.rpm } : {}),
        ...(s.limits.itpm !== undefined ? { itpm: s.limits.itpm } : {}),
        ...(s.limits.otpm !== undefined ? { otpm: s.limits.otpm } : {}),
      };
      await tx`
        INSERT INTO harness_shared.agent_rate_budget
          (bucket_key, window_start, req_in_window, in_tok_in_window, out_tok_in_window,
           paused_until, pace_delay_ms, last_acquire_at, limits, updated_at, rpm_factor, rpm_factor_at)
        VALUES
          (${key}, ${s.windowStart}, ${s.reqInWindow}, ${s.inTokInWindow}, ${s.outTokInWindow},
           ${s.pausedUntil}, ${s.paceDelayMs}, ${s.lastAcquireAt}, ${JSON.stringify(limitsObj)}::text::jsonb, ${Date.now()},
           ${s.rpmFactor ?? null}, ${s.rpmFactorAt ?? null})
        ON CONFLICT (bucket_key) DO UPDATE SET
          window_start      = EXCLUDED.window_start,
          req_in_window     = EXCLUDED.req_in_window,
          in_tok_in_window  = EXCLUDED.in_tok_in_window,
          out_tok_in_window = EXCLUDED.out_tok_in_window,
          paused_until      = EXCLUDED.paused_until,
          pace_delay_ms     = EXCLUDED.pace_delay_ms,
          last_acquire_at   = EXCLUDED.last_acquire_at,
          limits            = EXCLUDED.limits,
          updated_at        = EXCLUDED.updated_at,
          rpm_factor        = EXCLUDED.rpm_factor,
          rpm_factor_at     = EXCLUDED.rpm_factor_at
      `;
      return s;
    })) as GovernorState;
  }
}

/** Install the PG cross-process budget store on the shared governor registry, gated on
    `PAPERCUSP_AGENT_GOVERNOR_PG`. Idempotent; call once at operator boot (alongside the
    governor observer). No-op (in-memory governance) when the flag is off. */
export function maybeInstallPgGovernorStore(setStore: (s: PgGovernorStore | undefined) => void): boolean {
  const on = process.env.PAPERCUSP_AGENT_GOVERNOR_PG === '1' || process.env.PAPERCUSP_AGENT_GOVERNOR_PG === 'true';
  if (on) {
    setStore(new PgGovernorStore());
    return true;
  }
  return false;
}
