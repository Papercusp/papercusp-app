/**
 * agent-plane-measurement-sweep.ts — P-015's DELIVERY half
 * (unified-agent-state-plane-2026-07-27 P-015, per D-030 / D-032 / D-089 / D-091).
 *
 * The composition is pure and lives in `agent-plane-measurement.ts`; this module
 * is the PG read, the once-per-window record, and the log line. Same chassis as
 * its sibling `agent-state-divergence-sweep.ts`.
 *
 * ── IT CONSUMES THE DIVERGENCE REPORT; IT DOES NOT RECOMPUTE IT ─────────────
 *
 * `DivergenceSweepResult.report` is documented as being "carried out so a caller
 * can log the fill rate without re-running anything", and this is that caller.
 * Recomputing the divergence numbers here would be wrong twice: it would be a
 * second read of `tool_invocations` in the same tick, and — worse — a SECOND
 * DERIVATION of a quantity that already has one, which is the axis-5 violation
 * (D-038) this plan has ruled against repeatedly. Two derivations that drift
 * apart produce a measurement that disagrees with the detector it is measuring,
 * and neither is wrong on its own terms.
 *
 * That is also why the window is not a parameter with its own default: it is
 * {@link SWEEP_LOOKBACK_MS}, the divergence sweep's own window. A row that mixed
 * a 24h clarification rate with a 30-minute divergence rate would not describe
 * any window at all.
 *
 * ── THE STALE-ACTION LEG REUSES THE SEND-TIME PRODUCER ─────────────────────
 *
 * WI-6548 replaces the original fact-dependency replay with the producer that
 * now exists at the action boundary: `coord:send` persists `staleValueQuotes`
 * for every registered-cell citation it can score against the sender's recent
 * reads. That workflow already has the real reader identity, so the background
 * sweep only aggregates stored verdicts. It never manufactures a principal or
 * re-dispatches a cell under somebody else's access context.
 *
 * All detected citations are `eligible`; only the two declared verdict values
 * are `comparable`, so malformed future rows cannot silently read as fresh.
 * Messages are the population, making a citation-free window visibly
 * `nothing-eligible` rather than a clean zero.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { STALE_QUOTE_FIELD } from './agent-tools/coordination/stale-quote-stamp';
import { SWEEP_LOOKBACK_MS } from './agent-state-divergence-sweep';
import type { DivergenceReport } from './agent-state-divergence';
import {
  basisHasMoved,
  classifyBasisMovement,
  isComparableAtDeclaration,
  wasStaleAtDeclaration,
  type AssumptionCondition,
} from './agent-facts/assumptions';
import { listCellsUnchecked } from './cell-registry';
import {
  composeCellTenure,
  formatCellTenureLog,
  CELL_TENURE_WINDOW_DAYS,
  type CellReadCount,
  type CellTenureLine,
  type CellTenureSubject,
} from './cell-tenure';
import {
  composePlaneMeasurement,
  isStructuralZero,
  isConcerningZero,
  metricVerdict,
  explainZero,
  type MetricCounts,
  type PlaneCounts,
  type PlaneMeasurement,
} from './agent-plane-measurement';

/**
 * Record at most one row per this interval. The routines tick runs far more often
 * than the sweep window is long, and a row per tick would produce a series of
 * heavily-overlapping windows in which the same failure is counted many times —
 * a trend line made of duplicates. One reading per window keeps the series
 * additive, which is what D-030's variance requirement needs.
 */
export const PLANE_MEASUREMENT_INTERVAL_MS = SWEEP_LOOKBACK_MS;

/** Bumped when the metric set or a derivation changes, so no trend is silently
 *  drawn across a definition change. */
export const PLANE_MEASUREMENT_PRODUCER_VERSION = 3;

/**
 * The calls that count as an agent stopping to ask rather than proceeding on an
 * unverified premise.
 *
 * ⚠ Deliberately NOT a substring match on "ask". `work_items:request_release`
 * asks a peer for an item, and `coord:ask-owner` and `coord:ask` are the two
 * genuine clarification verbs; a looser predicate would sweep in every tool whose
 * name happens to contain the word and make the rate uninterpretable in the
 * direction that flatters it.
 */
export const CLARIFICATION_TOOLS = [
  'coord:ask',
  'coord:ask-owner',
  'conversations:post',
  'conversations:answer',
] as const;

/**
 * The surfaces this plane enriches, and therefore the ones whose payload is the
 * token cost it adds. Measured 2026-07-27 over 7d as the PRE-enrichment baseline:
 * work_items:get 2,591 calls @ ~7.5 KB · work_items:list 1,972 @ ~16.9 KB ·
 * coord:send 1,943 @ ~1.0 KB · scheduler:get_next 1,749 @ ~4.4 KB ·
 * coord:orient 1,675 @ ~17.3 KB · facts:assert 1,100 @ ~1.8 KB ·
 * locks:queue 647 @ ~0.2 KB · work_items:claim 602 @ ~5.2 KB ·
 * coord:presence 97 @ ~36.8 KB.
 */
export const ENRICHED_SURFACES = [
  'coord:orient',
  'coord:presence',
  'coord:send',
  'work_items:list',
  'work_items:get',
  'work_items:claim',
  'scheduler:get_next',
  'locks:queue',
  'facts:assert',
  'state:read',
] as const;

interface CallAggregateRow {
  calls: string | number;
  attributed: string | number;
  clarification_calls: string | number;
  enriched_calls: string | number;
  enriched_sized: string | number;
  enriched_bytes: string | number;
}

interface StaleQuoteAggregateRow {
  messages: string | number;
  detected_quotes: string | number;
  comparable_quotes: string | number;
  stale_quotes: string | number;
}

/** postgres-js returns count()/sum() as strings; coercing at the boundary is the
 *  same trap `loadRecentCalls` documents for bigint columns. */
function num(v: string | number | null | undefined): number {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

/** ONE aggregate over the window — not a row-level read, and not a second copy of
 *  the divergence sweep's scan. */
export async function loadCallAggregates(opts: {
  workspaceId: string;
  windowStartMs: number;
  windowEndMs: number;
  sql?: Sql;
}): Promise<CallAggregateRow> {
  const sql = opts.sql ?? getOrgPg().sql;
  const start = new Date(opts.windowStartMs).toISOString();
  const end = new Date(opts.windowEndMs).toISOString();
  const clarification = [...CLARIFICATION_TOOLS];
  const enriched = [...ENRICHED_SURFACES];
  const rows = await sql<CallAggregateRow[]>`
    SELECT count(*)                                                       AS calls,
           count(coord_owner_id)                                          AS attributed,
           count(*) FILTER (WHERE tool_name = ANY(${clarification}))       AS clarification_calls,
           count(*) FILTER (WHERE tool_name = ANY(${enriched}))            AS enriched_calls,
           count(*) FILTER (WHERE tool_name = ANY(${enriched})
                              AND output_size IS NOT NULL)                 AS enriched_sized,
           coalesce(sum(output_size) FILTER (WHERE tool_name = ANY(${enriched})), 0) AS enriched_bytes
      FROM harness_shared.tool_invocations
     WHERE workspace_id = ${opts.workspaceId}
       AND invoked_at >= ${start}
       AND invoked_at <  ${end}
  `;
  return rows[0] ?? { calls: 0, attributed: 0, clarification_calls: 0, enriched_calls: 0, enriched_sized: 0, enriched_bytes: 0 };
}

/**
 * P-008 — per-cell demand over the window, for the tenure verdict.
 *
 * Counts `state:read` rows, which is the SAME source the ADMISSION rule counts
 * ("a read with 0 calls is never promoted", measured from `tool_invocations`).
 * Deliberately not a second derivation of "how adopted is this cell": a tenure
 * rule that disagreed with the admission rule it is the counterpart to would be
 * the axis-5 / D-038 defect this module's header already refuses for the
 * divergence numbers.
 *
 * Cells that were never read simply do not appear — absence IS the signal, so the
 * caller must supply the registered population separately and treat a miss as zero.
 */
export async function loadCellReadCounts(opts: {
  workspaceId: string;
  windowStartMs: number;
  windowEndMs: number;
  sql?: Sql;
}): Promise<Map<string, CellReadCount>> {
  const sql = opts.sql ?? getOrgPg().sql;
  const start = new Date(opts.windowStartMs).toISOString();
  const end = new Date(opts.windowEndMs).toISOString();
  const rows = await sql<{ cell: string; reads: string | number; callers: string | number }[]>`
    SELECT args_json->>'cell'              AS cell,
           count(*)                        AS reads,
           count(DISTINCT coord_owner_id)  AS callers
      FROM harness_shared.tool_invocations
     WHERE workspace_id = ${opts.workspaceId}
       AND tool_name = 'state:read'
       AND args_json->>'cell' IS NOT NULL
       AND invoked_at >= ${start}
       AND invoked_at <  ${end}
     GROUP BY 1
  `;
  return new Map(rows.map((r) => [r.cell, { reads: num(r.reads), callers: num(r.callers) }]));
}

/**
 * P-008 — the OBSERVABILITY horizon: the oldest `tool_invocations` row still
 * retained, in epoch ms, or null when the table is empty.
 *
 * This is what stops "pruned history" being read as "no demand". It is measured
 * rather than assumed from {@link TOOL_INVOCATIONS_RETENTION_DAYS} on purpose: the
 * constant states the retention POLICY, and a policy is not evidence that the
 * pruning routine actually ran, or that the table is as old as it is allowed to be.
 * A fresh database is the obvious case — every cell would otherwise read as
 * dormant on day one.
 *
 * Not scoped to `state:read`: the horizon is a property of the TABLE's retention,
 * and scoping it to one tool would date the tool's first use instead — which for a
 * cell nobody reads is exactly the circularity the tenure rule exists to avoid.
 */
export async function loadTelemetryHorizonMs(opts: {
  workspaceId: string;
  sql?: Sql;
}): Promise<number | null> {
  const sql = opts.sql ?? getOrgPg().sql;
  const rows = await sql<{ oldest: Date | string | null }[]>`
    SELECT min(invoked_at) AS oldest
      FROM harness_shared.tool_invocations
     WHERE workspace_id = ${opts.workspaceId}
  `;
  const oldest = rows[0]?.oldest ?? null;
  if (oldest == null) return null;
  const ms = oldest instanceof Date ? oldest.getTime() : Date.parse(String(oldest));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * WI-6548 — the persisted send-time stale-value verdicts for this measurement
 * window. The send seam already resolved reader identity and cell access; this
 * aggregate consumes that result instead of replaying live reads under a guessed
 * background principal.
 */
export async function loadStaleQuoteAggregates(opts: {
  workspaceId: string;
  windowStartMs: number;
  windowEndMs: number;
  sql?: Sql;
}): Promise<StaleQuoteAggregateRow> {
  const sql = opts.sql ?? getOrgPg().sql;
  const start = new Date(opts.windowStartMs).toISOString();
  const end = new Date(opts.windowEndMs).toISOString();
  const rows = await sql<StaleQuoteAggregateRow[]>`
    SELECT count(*) AS messages,
           coalesce(sum(
             CASE WHEN jsonb_typeof(body -> ${STALE_QUOTE_FIELD}) = 'array'
               THEN jsonb_array_length(body -> ${STALE_QUOTE_FIELD}) ELSE 0 END
           ), 0) AS detected_quotes,
           coalesce(sum(
             CASE WHEN jsonb_typeof(body -> ${STALE_QUOTE_FIELD}) = 'array'
               THEN (SELECT count(*) FROM jsonb_array_elements(body -> ${STALE_QUOTE_FIELD}) q
                      WHERE q->>'verdict' IN ('fresh-read', 'quoted-without-fresh-read'))
               ELSE 0 END
           ), 0) AS comparable_quotes,
           coalesce(sum(
             CASE WHEN jsonb_typeof(body -> ${STALE_QUOTE_FIELD}) = 'array'
               THEN (SELECT count(*) FROM jsonb_array_elements(body -> ${STALE_QUOTE_FIELD}) q
                      WHERE q->>'verdict' = 'quoted-without-fresh-read')
               ELSE 0 END
           ), 0) AS stale_quotes
      FROM harness_shared.coord_event_log
     WHERE workspace_id = ${opts.workspaceId}
       AND surface = 'messages'
       AND ts >= ${start}
       AND ts <  ${end}
  `;
  return rows[0] ?? { messages: 0, detected_quotes: 0, comparable_quotes: 0, stale_quotes: 0 };
}

/**
 * One stored commitment declaration joined to the ledger's CURRENT state of the
 * same fact identity — the raw material for both commitment-backed legs.
 */
export interface CommitmentBasisRow {
  condition_at_close: string | null;
  pinned_version: string | number | null;
  current_version: string | number | null;
  retracted_now: boolean;
  expired_now: boolean;
}

/** Counts for the two commitment-backed legs (WI-6465 / D-102). */
export interface CommitmentBasisCounts {
  /** Closes carrying ANY declaration, incl. the literal 'none' — the population. */
  closesDeclaring: number;
  /** Of those, the ones that NAMED keys. The honest fillRate numerator: most
   *  closes say 'none', and a rate computed over all of them would be ~90%
   *  diluted (D-102's floor rule). */
  closesNamingKeys: number;
  /** Entries whose close-time condition supports a verdict. */
  comparableAtClose: number;
  /** Of those, entries already not-current when the close cited them. */
  staleAtClose: number;
  /** Entries whose CURRENT movement is determinable. */
  comparableNow: number;
  /** Of those, entries whose basis has since moved. */
  movedSince: number;
}

/**
 * Load every stored commitment declaration alongside the current state of the
 * fact identity it pinned.
 *
 * ⚠ THE JOIN IS ON THE FULL IDENTITY `(scope, scope_ref, key)`, NOT ON `key`
 * ALONE. `agent_facts` is keyed by scope + scope_ref, and the same slug legitimately
 * exists in several scopes at once — `assumptionSelectorsFor` is built entirely
 * around that fact (it resolves a bare key most-specific-first precisely BECAUSE
 * a workspace-wide fact can share a slug with an owner-scoped one). A key-only
 * join would compare the close's pinned version against some other tenant's
 * unrelated row and report a confident `superseded` for a fact that never moved.
 *
 * ⚠ `source_hive IS NULL` matches {@link resolveAssumptions}: a foreign hive's
 * fact with the same slug is not the one the closer pinned.
 */
export async function loadCommitmentBasisRows(opts: {
  workspaceId: string;
  sql?: Sql;
}): Promise<CommitmentBasisRow[]> {
  const sql = opts.sql ?? getOrgPg().sql;
  return sql<CommitmentBasisRow[]>`
    WITH declared AS (
      SELECT e.entry
        FROM harness_shared.work_items w
        CROSS JOIN LATERAL jsonb_array_elements(w.payload->'_assumptions'->'declared') AS e(entry)
       WHERE w.workspace_id = ${opts.workspaceId}
         AND jsonb_typeof(w.payload->'_assumptions'->'declared') = 'array'
    )
    SELECT d.entry->>'condition'                AS condition_at_close,
           (d.entry->>'versionId')              AS pinned_version,
           cur.current_version                  AS current_version,
           coalesce(cur.retracted_now, false)   AS retracted_now,
           coalesce(cur.expired_now, false)     AS expired_now
      FROM declared d
      LEFT JOIN LATERAL (
        SELECT a.id                            AS current_version,
               a.retracted_at IS NOT NULL      AS retracted_now,
               a.expires_at <= now()           AS expired_now
          FROM harness_shared.agent_facts a
         WHERE a.workspace_id = ${opts.workspaceId}
           AND a.source_hive IS NULL
           AND a.key = d.entry->>'key'
           AND a.scope = d.entry->>'scope'
           AND coalesce(a.scope_ref, '') = coalesce(d.entry->>'scopeRef', '')
         ORDER BY a.id DESC
         LIMIT 1
      ) cur ON true
  `;
}

/** How many closes carry a declaration at all, and how many named keys. */
export async function loadCommitmentDeclarationTotals(opts: {
  workspaceId: string;
  sql?: Sql;
}): Promise<{ closes_declaring: number; closes_naming_keys: number }> {
  const sql = opts.sql ?? getOrgPg().sql;
  const rows = await sql<Array<{ closes_declaring: string | number; closes_naming_keys: string | number }>>`
    SELECT count(*)                                                                    AS closes_declaring,
           count(*) FILTER (WHERE jsonb_typeof(payload->'_assumptions'->'declared') = 'array') AS closes_naming_keys
      FROM harness_shared.work_items
     WHERE workspace_id = ${opts.workspaceId}
       AND payload ? '_assumptions'
  `;
  const r = rows[0] ?? { closes_declaring: 0, closes_naming_keys: 0 };
  return { closes_declaring: num(r.closes_declaring), closes_naming_keys: num(r.closes_naming_keys) };
}

/**
 * Reduce the loaded rows to counts. PURE — and it classifies in JS through the
 * SHARED {@link classifyBasisMovement} rather than re-expressing the movement
 * rules as SQL `FILTER` clauses. That is D-038 axis 5 (one derivation, many
 * lenses) applied here deliberately: a second copy of "what counts as moved"
 * living in a query would drift from the exported one silently, and the unit
 * tests would keep passing against the copy nobody runs.
 */
export function reduceCommitmentBasis(
  rows: readonly CommitmentBasisRow[],
  totals: { closes_declaring: number; closes_naming_keys: number },
): CommitmentBasisCounts {
  let comparableAtClose = 0;
  let staleAtClose = 0;
  let comparableNow = 0;
  let movedSince = 0;

  for (const r of rows) {
    const condition = (r.condition_at_close ?? null) as AssumptionCondition | null;
    if (isComparableAtDeclaration(condition)) {
      comparableAtClose += 1;
      if (wasStaleAtDeclaration(condition)) staleAtClose += 1;
    }
    const movement = classifyBasisMovement({
      conditionAtClose: condition,
      pinnedVersion: intOrNull(r.pinned_version),
      currentVersion: intOrNull(r.current_version),
      retractedNow: r.retracted_now === true,
      expiredNow: r.expired_now === true,
    });
    if (movement !== 'undeterminable') {
      comparableNow += 1;
      if (basisHasMoved(movement)) movedSince += 1;
    }
  }

  return {
    closesDeclaring: totals.closes_declaring,
    closesNamingKeys: totals.closes_naming_keys,
    comparableAtClose,
    staleAtClose,
    comparableNow,
    movedSince,
  };
}

/** Postgres returns bigint as a string; a non-numeric value must read as "no
 *  pin", never as 0 — version 0 does not exist and would compare as superseded. */
function intOrNull(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

export interface PlaneMeasurementDeps {
  workspaceId?: string;
  harnessSlug?: string;
  now?: number;
  sql?: Sql;
  /** The divergence sweep's own report — CONSUMED, never recomputed. */
  divergence?: DivergenceReport | null;
  loadCallAggregates?: typeof loadCallAggregates;
  loadStaleQuoteAggregates?: typeof loadStaleQuoteAggregates;
  /** WI-6465 / D-102 — injected for tests only; these DO run by default. */
  loadCommitmentBasisRows?: typeof loadCommitmentBasisRows;
  loadCommitmentDeclarationTotals?: typeof loadCommitmentDeclarationTotals;
  /** Injected for tests; the default reads the series' newest row. */
  lastMeasuredAtMs?: () => Promise<number | null>;
  recordMeasurement?: (m: PlaneMeasurement, ctx: { workspaceId: string; harnessSlug: string }) => Promise<void>;
  /** P-008 — injected for tests; the defaults read PG and the live registry. */
  loadCellReadCounts?: typeof loadCellReadCounts;
  loadTelemetryHorizonMs?: typeof loadTelemetryHorizonMs;
  listRegisteredCells?: () => CellTenureSubject[];
}

export type PlaneSweepOutcome =
  | { outcome: 'recorded'; measurement: PlaneMeasurement; tenure?: CellTenureLine[] }
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'error'; reason: string };

/**
 * P-008 — the tenure verdict for every registered cell.
 *
 * FAIL-SOFT on its own, for the same reason the commitment leg is: a fault in the
 * newest leg must not cost the window every OTHER metric. It degrades to `null`,
 * which the caller reports as "not evaluated" rather than as an empty registry —
 * an empty tenure list would read as "no cells to assess", the precise misread the
 * whole rule is built to prevent.
 */
async function evaluateCellTenure(
  deps: PlaneMeasurementDeps,
  workspaceId: string,
  nowMs: number,
): Promise<CellTenureLine[] | null> {
  try {
    const windowStartMs = nowMs - CELL_TENURE_WINDOW_DAYS * 86_400_000;
    const [reads, horizon] = await Promise.all([
      (deps.loadCellReadCounts ?? loadCellReadCounts)({
        workspaceId,
        windowStartMs,
        windowEndMs: nowMs,
        sql: deps.sql,
      }),
      (deps.loadTelemetryHorizonMs ?? loadTelemetryHorizonMs)({ workspaceId, sql: deps.sql }),
    ]);
    const registered = (deps.listRegisteredCells ?? defaultListRegisteredCells)();
    return composeCellTenure({ registered, reads, nowMs, observableSinceMs: horizon });
  } catch {
    return null;
  }
}

/**
 * The registered population, from the LIVE registry.
 *
 * `listCellsUnchecked` is correct here and `listCells(reader)` is not: a background
 * sweep has NO reader identity, and manufacturing a synthetic principal to obtain
 * one is how P-030's enrichment broke (see this module's header). This is an
 * INVENTORY read — it counts the registry and never serves a cell's value to an
 * agent — which is the case cell-access-parity's CALL_SITE_ALLOWLIST exists for,
 * and this call site is listed there with that reason.
 */
function defaultListRegisteredCells(): CellTenureSubject[] {
  return listCellsUnchecked().map((c) => ({ cell: c.cell, registeredOn: c.registeredOn }));
}

/** Newest reading in the series, for the once-per-window gate. */
async function defaultLastMeasuredAtMs(
  workspaceId: string,
  harnessSlug: string,
  sql?: Sql,
): Promise<number | null> {
  const db = sql ?? getOrgPg().sql;
  const rows = await db<Array<{ measured_at: string | Date }>>`
    SELECT measured_at
      FROM harness_shared.agent_plane_measurements
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
     ORDER BY measured_at DESC
     LIMIT 1
  `;
  if (rows.length === 0) return null;
  const t = new Date(rows[0].measured_at).getTime();
  return Number.isFinite(t) ? t : null;
}

async function defaultRecordMeasurement(
  m: PlaneMeasurement,
  ctx: { workspaceId: string; harnessSlug: string },
  sql?: Sql,
): Promise<void> {
  const db = sql ?? getOrgPg().sql;
  await db`
    INSERT INTO harness_shared.agent_plane_measurements
      (workspace_id, harness_slug, measured_at, window_start, window_end,
       metrics, interpretable_count, metric_count, summary, producer_version)
    VALUES (${ctx.workspaceId}, ${ctx.harnessSlug}, ${m.measuredAt},
            ${new Date(m.windowStartMs).toISOString()}, ${new Date(m.windowEndMs).toISOString()},
            ${db.json(m.metrics as unknown as Parameters<typeof db.json>[0])}, ${m.interpretableCount}, ${m.metrics.length},
            ${m.summary}, ${PLANE_MEASUREMENT_PRODUCER_VERSION})
  `;
}

/**
 * Assemble one window's counts. PURE given its inputs — every read is injected —
 * so the whole funnel is unit-testable without PG.
 */
export function composeCounts(input: {
  divergence: DivergenceReport | null;
  calls: CallAggregateRow;
  staleQuotes: StaleQuoteAggregateRow;
  commitmentBasis: CommitmentBasisCounts | null;
}): PlaneCounts {
  const cov = input.divergence?.coverage ?? null;
  const callsExamined = cov?.callsExamined ?? num(input.calls.calls);

  // ⚠ Counted from the findings list, which DIVERGENCE_LIMIT can cut. `coverage`
  // carries no per-kind numerator, so on a truncated report this is a floor, not
  // an exact count — surfaced via the report's own `truncated` flag rather than
  // silently rounded away. Structurally 0 today (fill rate 0).
  const goalDrift =
    input.divergence?.divergences.filter((d) => d.kind === 'goal-drift-within-intent').length ?? 0;

  const attributed = num(input.calls.attributed);
  const enrichedCalls = num(input.calls.enriched_calls);

  const m = (population: number, eligible: number, comparable: number, observed: number): MetricCounts => ({
    population,
    eligible,
    comparable,
    observed,
  });

  return {
    'intent-action-divergence-stamped': m(
      callsExamined,
      cov?.stampedCalls ?? 0,
      cov?.comparableBuckets ?? 0,
      goalDrift,
    ),
    'intent-action-divergence-sampling': m(
      callsExamined,
      cov?.failuresSeen ?? 0,
      cov?.failuresSeen ?? 0,
      cov?.thrashRuns ?? 0,
    ),
    // Every attributed call is an opportunity to have asked instead of assumed,
    // so eligible === comparable === the attributed population and fillRate is 1.
    // This metric needs no producer of its own — which is exactly why it is the
    // one that stays interpretable while the stamped metrics wait for P-009.
    'clarification-rate': m(
      num(input.calls.calls),
      attributed,
      attributed,
      num(input.calls.clarification_calls),
    ),
    'acted-on-stale-or-wrong-value': m(
      num(input.staleQuotes.messages),
      num(input.staleQuotes.detected_quotes),
      num(input.staleQuotes.comparable_quotes),
      num(input.staleQuotes.stale_quotes),
    ),
    // WI-6465 / D-102. Both legs share a population (closes that declared
    // anything) and a fillRate numerator (closes that NAMED keys) — so the ~90%
    // of closes answering the literal 'none' depress the fill rate honestly
    // instead of vanishing from the denominator and flattering the rate.
    'acted-on-stale-declared-basis': m(
      input.commitmentBasis?.closesDeclaring ?? 0,
      input.commitmentBasis?.closesNamingKeys ?? 0,
      input.commitmentBasis?.comparableAtClose ?? 0,
      input.commitmentBasis?.staleAtClose ?? 0,
    ),
    'closed-work-basis-moved': m(
      input.commitmentBasis?.closesDeclaring ?? 0,
      input.commitmentBasis?.closesNamingKeys ?? 0,
      input.commitmentBasis?.comparableNow ?? 0,
      input.commitmentBasis?.movedSince ?? 0,
    ),
    // `observed` is BYTES and `comparable` is CALLS, so `rate` reads as mean
    // payload per enriched call — the baseline the eventual enrichment delta is
    // measured against. `verdictUnit: 'output byte'` on the spec says so.
    'plane-token-cost': m(
      num(input.calls.calls),
      enrichedCalls,
      num(input.calls.enriched_sized),
      num(input.calls.enriched_bytes),
    ),
  };
}

/**
 * One measurement: read the window's aggregates, compose, record at most once per
 * window. Fail-soft throughout — a measurement that throws would take down the
 * tick that carries the detector it is measuring.
 */
export async function planeMeasurementSweep(
  deps: PlaneMeasurementDeps = {},
): Promise<PlaneSweepOutcome> {
  const now = deps.now ?? Date.now();
  const workspaceId = deps.workspaceId ?? 'papercusp-workspace';
  const harnessSlug = deps.harnessSlug ?? 'papercusp';

  try {
    const lastAt = await (deps.lastMeasuredAtMs
      ? deps.lastMeasuredAtMs()
      : defaultLastMeasuredAtMs(workspaceId, harnessSlug, deps.sql));
    if (lastAt != null && now - lastAt < PLANE_MEASUREMENT_INTERVAL_MS) {
      return {
        outcome: 'skipped',
        reason: `last reading ${Math.round((now - lastAt) / 60_000)}min ago (< ${Math.round(PLANE_MEASUREMENT_INTERVAL_MS / 60_000)}min window)`,
      };
    }

    const windowStartMs = now - SWEEP_LOOKBACK_MS;
    const [calls, staleQuotes] = await Promise.all([
      (deps.loadCallAggregates ?? loadCallAggregates)({
        workspaceId,
        windowStartMs,
        windowEndMs: now,
        sql: deps.sql,
      }),
      (deps.loadStaleQuoteAggregates ?? loadStaleQuoteAggregates)({
        workspaceId,
        windowStartMs,
        windowEndMs: now,
        sql: deps.sql,
      }),
    ]);

    // WI-6465 / D-102 — the commitment-backed legs. Run UNCONDITIONALLY here;
    // like the stale-quote aggregate above, these need only SQL over stored
    // declarations and no background cell read. Fail-soft on their own so a
    // fault in the newest leg cannot cost the
    // window every OTHER metric — it degrades to the same null the injected leg
    // uses, which reports `nothing-comparable`, never a clean zero.
    let commitmentBasis: CommitmentBasisCounts | null = null;
    try {
      const [basisRows, basisTotals] = await Promise.all([
        (deps.loadCommitmentBasisRows ?? loadCommitmentBasisRows)({ workspaceId, sql: deps.sql }),
        (deps.loadCommitmentDeclarationTotals ?? loadCommitmentDeclarationTotals)({
          workspaceId,
          sql: deps.sql,
        }),
      ]);
      commitmentBasis = reduceCommitmentBasis(basisRows, basisTotals);
    } catch {
      commitmentBasis = null;
    }

    const measurement = composePlaneMeasurement({
      counts: composeCounts({
        divergence: deps.divergence ?? null,
        calls,
        staleQuotes,
        commitmentBasis,
      }),
      windowStartMs,
      windowEndMs: now,
    });

    await (deps.recordMeasurement
      ? deps.recordMeasurement(measurement, { workspaceId, harnessSlug })
      : defaultRecordMeasurement(measurement, { workspaceId, harnessSlug }, deps.sql));

    // P-008 — the tenure verdict rides the same window and the same once-per-window
    // gate, so the cut-or-keep line cannot be emitted more often than the metrics it
    // sits beside. Null (its leg failed) is omitted rather than reported as an empty
    // registry; see evaluateCellTenure.
    const tenure = await evaluateCellTenure(deps, workspaceId, now);

    return tenure ? { outcome: 'recorded', measurement, tenure } : { outcome: 'recorded', measurement };
  } catch (e) {
    return { outcome: 'error', reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * The log line. Leads with how much is MEASURABLE, then names each structural
 * zero and its producer — because a line reading "0 divergences, 0 conflicts" is
 * the exact misread D-087 and D-089 were both written to prevent.
 */
export function formatMeasurementLog(m: PlaneMeasurement): string {
  const parts = m.metrics.map((metric) => {
    // ONE place decides what a metric is saying — never a hand-rolled ternary.
    switch (metricVerdict(metric)) {
      case 'unmeasured':
        return `${metric.id}=UNMEASURED(${metric.zeroReason}; fill=${metric.fillRate ?? 'n/a'}; awaiting ${metric.inputProducer})`;
      // Measured, and the desirable behaviour did not occur. It must not print
      // like a defect count of 0, which is what "0/4142 (0)" reads as at a glance.
      case 'never-observed':
        return `${metric.id}=NEVER-OBSERVED(0 of ${metric.comparable} ${metric.unit}s — measured, not a pass)`;
      case 'gauge':
        return `${metric.id}=GAUGE(${metric.rate}/${metric.verdictUnit} over ${metric.comparable})`;
      default:
        return `${metric.id}=${metric.observed}/${metric.comparable}${metric.rate == null ? '' : ` (${metric.rate})`}`;
    }
  });
  return `[plane-measurement] ${m.summary} | ${parts.join(' · ')}`;
}

export { isStructuralZero, isConcerningZero, metricVerdict, explainZero };
/** P-008 — re-exported so the routine reads its tenure line from the sweep it called. */
export { formatCellTenureLog };
