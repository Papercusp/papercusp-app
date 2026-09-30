/**
 * tick-ledger.ts — Scout tick observability (learning-system-audit-improvements
 * P-034): the thin PG seam over `harness_shared.scout_ticks` (migration 208).
 *
 * The `scout-cycle` routine ticks frequently and SELF-GATES (idle-capacity /
 * friction cadence → autoloop circuit → budget), so the common tick is a silent
 * no-op — before this ledger there was no durable record of WHY each tick
 * withheld, and an always-gated Scout was indistinguishable from a dead one.
 * One row per tick, mirroring `watchdog_ticks` (migration 202): `gated` rows
 * name the self-gate that stopped the tick; `ran` rows carry the cycle's
 * generated/routed/deduped counts + spend; `error` rows carry the failure.
 *
 * Best-effort by contract: the scheduler swallows recording failures
 * (observability must never fail the tick). The recorder is injected into
 * {@link ScoutTickDeps.recordTick} so the tick composition unit-tests with a
 * fake (the watchdog recordTick pattern); THIS module is the production PG
 * edge, using the same access pattern as routed-ledger.ts.
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import { resolveLearningPotSlug } from '../learning/pot-scope';
import { trackDetached } from '../detached-imports';

/** Why a tick ended: a full cycle ran, a self-gate withheld it, or the cycle threw. */
export type ScoutTickStatus = 'ran' | 'gated' | 'error';

/**
 * One tick's outcome, as the scheduler reports it (pure data — no PG types).
 * `gate` names the self-gate that stopped a 'gated' tick:
 * 'min-interval' | 'no-trigger' (cadence) | 'circuit' (autoloop fire-gate).
 */
export interface ScoutTickRecord {
  status: ScoutTickStatus;
  gate?: string;
  /** Ideas the ideators produced (full cycle only). */
  ideasGenerated?: number;
  /** Routed-idea provenance rows persisted (full cycle only). */
  ideasRouted?: number;
  /** Ideas the critics pruned — scored − survivors (full cycle only). */
  ideasDeduped?: number;
  /** LLM spend of the cycle (USD); omitted when no cycle ran. */
  budgetUsedUsd?: number;
  /** Free-form extras: { reason, cycleId, stop, retryAfterSec, error, ... }. */
  detail?: Record<string, unknown>;
}

export interface RecordScoutTickInput extends ScoutTickRecord {
  /** The harness the tick ran for (the routine's install slug). */
  installSlug?: string;
  /** Override the active workspace (tests). */
  workspaceId?: string;
  /**
   * Provenance partition (migration 571). 'scout' (default) = the scout-cycle
   * routine; 'su-ideate' = an su ideate pass (blender:ideate-pass-record). Scout
   * cadence/health readers filter origin='scout', so a su-ideate tick rides this
   * ledger WITHOUT resetting Scout's cadence floor or faking Scout liveness.
   */
  origin?: string;
  /**
   * The pot the tick ran for (P-002 pot-scope-all-learnings) — wins outright when
   * set; otherwise resolved from installSlug's owning pot, then the env home pot.
   */
  potSlug?: string | null;
}

/** Persist one tick row. Callers treat this as best-effort (errors swallowed upstream). */
export async function recordScoutTick(input: RecordScoutTickInput): Promise<void> {
  const { sql } = getOrgPg();
  const ws = input.workspaceId ?? activeWorkspaceId();
  const origin = input.origin ?? 'scout';
  // P-002 (pot-scope-all-learnings): stamp the tick's pot at write time. Never
  // throws (the resolver degrades internally), so best-effort recording holds.
  const potSlug = await resolveLearningPotSlug({
    workspaceId: ws,
    potSlug: input.potSlug ?? null,
    harnessSlug: input.installSlug ?? null,
  });
  await sql`
    INSERT INTO harness_shared.scout_ticks
      (workspace_id, install_slug, status, gate,
       ideas_generated, ideas_routed, ideas_deduped, budget_used_usd, detail, origin, pot_slug)
    VALUES
      (${ws}, ${input.installSlug ?? null}, ${input.status}, ${input.gate ?? null},
       ${input.ideasGenerated ?? 0}, ${input.ideasRouted ?? 0}, ${input.ideasDeduped ?? 0},
       ${input.budgetUsedUsd ?? null}, ${JSON.stringify(input.detail ?? null)}::text::jsonb, ${origin},
       ${potSlug})`;
  // Push the Learning tab's Scout view (learning.scout shows the last tick) —
  // ONLY for Scout-origin ticks. A su-ideate pass rides this ledger but is not a
  // Scout tick, so it must not ping the Scout view (its own observability surface
  // lands with the Phase 3 observability item). Fire-and-forget via a lazy import
  // so the PG seam (+ its tests) never statically depends on the SSE layer.
  if (origin === 'scout') {
    void trackDetached(import('../sync-sse'))
      .then((m) => m.notifySyncInvalidate('learning.scout'))
      .catch(() => {});
    // WI-4274: an ERROR tick may complete a pageable streak — check-and-fire is
    // debounced + fail-soft inside the module, and fire-and-forget here so the
    // ledger write path never blocks on (or fails because of) paging.
    if (input.status === 'error') {
      void trackDetached(import('./error-streak-alarm'))
        .then((m) =>
          m.checkAndFireErrorStreakAlarm({
            ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
            installSlug: input.installSlug ?? null,
          }),
        )
        .catch(() => {});
    }
  }
}

/**
 * One tick row read back from the ledger — the camelCase mirror of the
 * migration-208 columns. Extends {@link ScoutTickRecord} so a read row IS a
 * valid pure-core tick snapshot (quality-metrics consumes exactly this shape).
 */
export interface ScoutTickRow extends ScoutTickRecord {
  /** The harness the tick ran for, when recorded. */
  installSlug?: string;
  /** ISO timestamp of the tick. */
  tickAt: string;
}

/** Read scope for {@link readScoutTicks}. */
export interface ReadScoutTicksOpts {
  /** Scoped su review selectors, applied before LIMIT; never scan a noisy workspace and filter afterward. */
  ownerId?: string;
  goalId?: string;
  /** Override the active workspace (tests). */
  workspaceId?: string;
  /** Filter to one harness's ticks. */
  installSlug?: string;
  /** Max rows, newest-first. Default 500 — the standing-quality window. */
  limit?: number;
  /**
   * Inclusive epoch-ms floor. When present without `limit`, the read is fully time-boxed
   * and does NOT apply the legacy newest-500 cap (release gates must not pin or hide errors
   * according to how many unrelated ticks happened to accrue).
   */
  sinceMs?: number;
  /**
   * Provenance partition to read (migration 571). Default 'scout' — a su-ideate
   * pass is not a Scout tick, so Scout consumers (quality-metrics, system-health)
   * never see one. Pass 'su-ideate' for the su-partition read.
   */
  origin?: string;
}

interface TickRow {
  install_slug: string | null;
  tick_at: string | Date;
  status: string;
  gate: string | null;
  ideas_generated: number | null;
  ideas_routed: number | null;
  ideas_deduped: number | null;
  budget_used_usd: string | number | null;
  detail: Record<string, unknown> | null;
}

/**
 * Read the last N tick rows (newest-first) for a workspace — the read seam the
 * Scout standing quality-metrics module (quality-metrics.ts) snapshots its tick
 * window from. Mirrors {@link readRoutedIdeas} in routed-ledger.ts: thin SQL,
 * camelCase mapping, no derivation (the pure math lives in quality-metrics.ts).
 */
export async function readScoutTicks(opts: ReadScoutTicksOpts = {}): Promise<ScoutTickRow[]> {
  const { sql } = getOrgPg();
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const sinceMs = opts.sinceMs != null && Number.isFinite(opts.sinceMs) ? opts.sinceMs : undefined;
  const limit = opts.limit ?? (sinceMs === undefined ? 500 : undefined);
  const origin = opts.origin ?? 'scout';
  const rows = await sql<TickRow[]>`
    SELECT install_slug, tick_at, status, gate, ideas_generated, ideas_routed,
           ideas_deduped, budget_used_usd, detail
      FROM harness_shared.scout_ticks
     WHERE workspace_id = ${ws}
       AND origin = ${origin}
       ${opts.ownerId ? sql`AND detail->>'owner' = ${opts.ownerId}` : sql``}
       ${opts.goalId ? sql`AND detail->'goalReview'->>'goalId' = ${opts.goalId}` : sql``}
       ${opts.installSlug ? sql`AND install_slug = ${opts.installSlug}` : sql``}
       ${sinceMs !== undefined ? sql`AND tick_at >= to_timestamp(${sinceMs} / 1000.0)` : sql``}
     ORDER BY tick_at DESC
     ${limit !== undefined ? sql`LIMIT ${limit}` : sql``}`;
  return rows.map((r) => {
    const spend = r.budget_used_usd == null ? null : Number(r.budget_used_usd);
    return {
      status: r.status as ScoutTickStatus,
      ...(r.gate ? { gate: r.gate } : {}),
      ideasGenerated: r.ideas_generated ?? 0,
      ideasRouted: r.ideas_routed ?? 0,
      ideasDeduped: r.ideas_deduped ?? 0,
      ...(spend != null && Number.isFinite(spend) ? { budgetUsedUsd: spend } : {}),
      ...(r.detail && typeof r.detail === 'object' ? { detail: r.detail } : {}),
      ...(r.install_slug ? { installSlug: r.install_slug } : {}),
      tickAt: r.tick_at instanceof Date ? r.tick_at.toISOString() : new Date(r.tick_at).toISOString(),
    };
  });
}

/**
 * The RUNNING scout code's content hash, as stamped on the newest scout-origin tick
 * (WI-5397) — i.e. what {@link ../scout-code-identity}'s `currentScoutCodeHash()`
 * resolved to inside the bg-host PROCESS that actually wrote that tick. This is how a
 * DIFFERENT process (e.g. the one serving `blender:success-metrics`) learns bg-host's
 * code identity without any new cross-process channel: the tick ledger IS the channel,
 * already shared. Null when no tick has ever stamped a hash (pre-WI-5397 history, or a
 * process whose scout source files were unreadable at hash time).
 *
 * `sinceMs` (WI-5451): an optional inclusive floor. Pass it when the CALLER explicitly
 * requested a window floor (an explicit `sinceMs`/`watermarkRef`) so "the running code"
 * is resolved from evidence AT OR AFTER that floor, never from a tick the previous
 * generation wrote before it. Omitting it (the default, un-floored rolling-window path)
 * preserves the pre-WI-5451 behavior of finding the literal newest tick regardless of
 * age — correct there because nothing narrower was asked for. See
 * {@link readScoutTicksByCodeHash}'s docblock for why this must NOT be applied
 * unconditionally.
 */
export async function readNewestScoutCodeHash(
  opts: { workspaceId?: string; installSlug?: string; origin?: string; sinceMs?: number } = {},
): Promise<string | null> {
  const { sql } = getOrgPg();
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const origin = opts.origin ?? 'scout';
  const rows = await sql<Array<{ hash: string | null }>>`
    SELECT detail->>'scoutCodeHash' AS hash
      FROM harness_shared.scout_ticks
     WHERE workspace_id = ${ws}
       AND origin = ${origin}
       ${opts.installSlug ? sql`AND install_slug = ${opts.installSlug}` : sql``}
       ${opts.sinceMs != null ? sql`AND tick_at >= to_timestamp(${opts.sinceMs} / 1000.0)` : sql``}
     ORDER BY tick_at DESC
     LIMIT 1`;
  const hash = rows[0]?.hash;
  return typeof hash === 'string' && hash.length > 0 ? hash : null;
}

/**
 * Read EVERY scout-origin tick whose stamped `detail.scoutCodeHash` matches `codeHash`
 * — the SOAK-METHOD read (WI-5397): the union of ticks across every bg-host generation
 * that happened to load byte-identical scout code, UNBOUNDED by time. This is what lets
 * the cycle-error-rate release bar accumulate a real evidence window despite bg-host
 * restarting far more often (observed 41min-3.9h between restarts) than a rolling
 * time-window's floor can absorb (a ~48h window needs ~20 organic ticks at a ~30min
 * cadence; a restart resets the window's tick history to zero every single time — fact
 * alpha-011-soak-unreachable-as-planned). Capped by `limit` (default 5000) as a sanity
 * bound, NOT a release-window definition — unlike {@link readScoutTicks}'s `sinceMs`,
 * there is no time floor here by design: two code-identical generations a month apart
 * are still the SAME evidence.
 *
 * `sinceMs` (WI-5451 — the intersect-not-replace fix): an optional inclusive floor,
 * ANDed with the code-hash predicate — the union answers "which code produced these?",
 * the floor answers "which period counts?", and a caller-requested floor must have BOTH
 * hold, never one replacing the other. Pass it ONLY when the caller explicitly requested
 * a window floor (an explicit `sinceMs`/`watermarkRef` arg reaching `buildProgramSuccessReport`)
 * — omitting it on the default rolling-window path is deliberate and load-bearing: that is
 * this reader's whole reason to exist (surviving a bg-host restart the rolling window can't
 * absorb; alpha-011-soak-unreachable-as-planned). Time-floor the union unconditionally and
 * you silently defeat the soak method on every call that doesn't ask for a floor.
 */
export async function readScoutTicksByCodeHash(opts: {
  codeHash: string;
  workspaceId?: string;
  installSlug?: string;
  limit?: number;
  origin?: string;
  sinceMs?: number;
}): Promise<ScoutTickRow[]> {
  const { sql } = getOrgPg();
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const origin = opts.origin ?? 'scout';
  const limit = opts.limit ?? 5000;
  const rows = await sql<TickRow[]>`
    SELECT install_slug, tick_at, status, gate, ideas_generated, ideas_routed,
           ideas_deduped, budget_used_usd, detail
      FROM harness_shared.scout_ticks
     WHERE workspace_id = ${ws}
       AND origin = ${origin}
       AND detail->>'scoutCodeHash' = ${opts.codeHash}
       ${opts.installSlug ? sql`AND install_slug = ${opts.installSlug}` : sql``}
       ${opts.sinceMs != null ? sql`AND tick_at >= to_timestamp(${opts.sinceMs} / 1000.0)` : sql``}
     ORDER BY tick_at DESC
     LIMIT ${limit}`;
  return rows.map((r) => {
    const spend = r.budget_used_usd == null ? null : Number(r.budget_used_usd);
    return {
      status: r.status as ScoutTickStatus,
      ...(r.gate ? { gate: r.gate } : {}),
      ideasGenerated: r.ideas_generated ?? 0,
      ideasRouted: r.ideas_routed ?? 0,
      ideasDeduped: r.ideas_deduped ?? 0,
      ...(spend != null && Number.isFinite(spend) ? { budgetUsedUsd: spend } : {}),
      ...(r.detail && typeof r.detail === 'object' ? { detail: r.detail } : {}),
      ...(r.install_slug ? { installSlug: r.install_slug } : {}),
      tickAt: r.tick_at instanceof Date ? r.tick_at.toISOString() : new Date(r.tick_at).toISOString(),
    };
  });
}

/**
 * The epoch-ms timestamp of the most-recent SUCCESSFUL Scout cycle RUN
 * (scout_ticks status='ran') for a workspace — the cadence min-interval floor's
 * "last run" clock — or null when no cycle has ever run.
 *
 * EI-1600: the floor MUST measure from the last cycle that actually RAN, NOT from
 * `autoloop_state.last_fired_at`. `recordFire` stamps `last_fired_at` on every
 * fire ATTEMPT (and on an 'error' outcome — e.g. a 429 "rate-limit pause exceeds
 * maxWait" cycle that generated 0 ideas), so reusing that clock as the floor let
 * every doomed hourly fire reset the 60-min floor — leaving Scout effectively
 * dark (every intervening tick gated 'min-interval', no real cycle ever clearing
 * the floor). A 'ran' tick is recorded ONLY when a budgeted cycle completed, so it
 * is the correct floor anchor; the autoloop clock stays the backoff/circuit anchor
 * (consecutive errors) + the single-flight CAS token.
 *
 * `installSlugs` are the workspace-brain READ-FALLBACK keys (workspaceBrainReadKeys)
 * — passing them reconciles the @singleton ↔ legacy-per-hive rows so the read picks
 * up runs recorded under either key (the install slug the tick recorder writes
 * under). Omit to read across all of the workspace's scout ticks.
 *
 * `origin` (migration 571) defaults to 'scout' — su-ideate ticks share this
 * ledger but must NOT reset the Scout cadence floor, so they are excluded here.
 */
export async function readLastScoutRunAtMs(
  opts: { workspaceId?: string; installSlugs?: string[]; origin?: string } = {},
): Promise<number | null> {
  const { sql } = getOrgPg();
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const origin = opts.origin ?? 'scout';
  const slugs = (opts.installSlugs ?? []).filter((s) => typeof s === 'string' && s.length > 0);
  const rows = await sql<Array<{ tick_at: string | Date }>>`
    SELECT tick_at
      FROM harness_shared.scout_ticks
     WHERE workspace_id = ${ws}
       AND status = 'ran'
       AND origin = ${origin}
       ${slugs.length > 0 ? sql`AND install_slug IN ${sql(slugs)}` : sql``}
     ORDER BY tick_at DESC
     LIMIT 1`;
  if (rows.length === 0) return null;
  const t = rows[0].tick_at;
  const ms = t instanceof Date ? t.getTime() : new Date(t).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The epoch-ms timestamp of the last scout_ticks row that ACTUALLY RAN a cycle
 * (status IN ('ran','fired')) for the given install slug(s) — or null when a
 * cycle has never run. This is the cadence clock the scheduler measures the
 * min-interval / heartbeat floor from (EI-1600).
 *
 * Why NOT the autoloop `last_fired_at`: that clock is stamped on every fire
 * ATTEMPT (`recordFire('attempt')`) and by the single-flight `claimFire`, so it
 * advances even when a cycle HANGS or ERRORS without ever producing a cycle-run.
 * Measuring the cadence floor from it lets a hung/errored fire keep resetting the
 * floor, withholding every subsequent real cycle as `min-interval` indefinitely
 * (the observed ~24h Scout dormancy). Measuring it from the last RUN instead means
 * a hung/errored cycle never resets the cadence floor — repeated failures are
 * bounded by the autoloop fire-gate's error backoff/circuit instead, which is
 * exactly its job. A null result (never ran) reads as "never run" by the gate,
 * which fires idle/heartbeat freely — the correct fresh-install behaviour.
 *
 * `installSlugs` reconciles across the workspace-brain re-key (K1): pass the write
 * key plus its read-fallbacks (workspaceBrainReadKeys) so a sentinel/legacy split
 * still resolves the true last run. Empty/omitted ⇒ workspace-wide (all installs).
 *
 * `origin` (migration 571) defaults to 'scout' — a su-ideate pass's 'ran' tick
 * shares this ledger but is excluded so it never resets the Scout cadence floor.
 */
export async function readLastRanTickAtMs(
  opts: { installSlugs?: string[]; workspaceId?: string; origin?: string } = {},
): Promise<number | null> {
  const { sql } = getOrgPg();
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const origin = opts.origin ?? 'scout';
  const slugs = (opts.installSlugs ?? []).filter((s) => typeof s === 'string' && s.length > 0);
  const rows = await sql<Array<{ last_ran: string | Date | null }>>`
    SELECT max(tick_at) AS last_ran
      FROM harness_shared.scout_ticks
     WHERE workspace_id = ${ws}
       AND status IN ('ran', 'fired')
       AND origin = ${origin}
       ${slugs.length > 0 ? sql`AND install_slug = ANY(${slugs}::text[])` : sql``}`;
  const v = rows[0]?.last_ran ?? null;
  if (v == null) return null;
  const ms = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(ms) ? ms : null;
}
