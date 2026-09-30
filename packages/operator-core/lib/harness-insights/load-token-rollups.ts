/**
 * load-token-rollups — B-TOK-ROLL ($-cost transparency + coordination-token
 * attribution). The COMPLEMENT of load-tokens.ts (su-f7cfc / B-TOK-UI), which
 * breaks cache-inclusive spend down by model/role/day from the stored cost_usd.
 * This file adds what that one does not:
 *
 *   1. loadModelPricingBook  — the per-MTok RATE reference (from model_pricing,
 *      migration 334) so the dashboard can SHOW the price tiers — especially the
 *      cache-read rate, which dominates because cache-read is ~82-92% of tokens.
 *   2. loadCoordTokenBreakdown — the COORD-COST LENS (B-TOK-4): LLM $ split by
 *      turn-trigger (coord-wake / cron / user / autoloop — once `turn_trigger`
 *      populates) AND by role-class (interactive=user-driven vs fleet=coord-driven),
 *      the latter queryable on EXISTING data today.
 *   3. loadCoordPollVolume — the QUANTIFIED coord-poll cost: the coord:* MCP-call
 *      volume from tool_invocations (≈0 LLM tokens — these are HTTP/MCP reads, not
 *      model calls), surfacing the wake-queue/wake-mode UI poll that is ~75% of all
 *      tool-invocation rows. The answer to the "327K coord:wake-queue mystery":
 *      cheap polling, not expensive context-injection.
 *
 * Pure logic — injectable runQuery (mirrors the per-card loaders). Each query is
 * INDEPENDENTLY defensive: a missing column/table (pre-migration / deploy-gated
 * turn_trigger) yields that section's empty shape rather than failing the whole
 * snapshot.
 */

const num = (v: string | number | null | undefined): number => {
  if (v == null) return 0;
  const n = typeof v === 'string' ? Number.parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : 0;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Minimum share of windowed SPEND that must carry a real `turn_trigger` before the
 *  by-trigger lens is reported as answerable (EI-22102999569306181). A majority, because the
 *  lens's whole claim is "here is where the money went" — a minority slice cannot support it. */
const TRIGGER_ATTRIBUTION_MIN_SHARE = 0.5;

/** The cache-inclusive token sum — the one expression every $ query reuses (matches load-tokens.ts). */
const TOKENS_EXPR = `COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)
                     + COALESCE(cache_read_tokens, 0) + COALESCE(cache_creation_tokens, 0)`;

export type RunQuery = <T = unknown>(query: string, params: unknown[]) => Promise<T[]>;

// ── 1. Pricing book ───────────────────────────────────────────────────────────

export interface ModelPricingBookRow {
  modelId: string;
  inputPerMtok: number;
  outputPerMtok: number;
  cacheReadPerMtok: number;
  cacheCreationPerMtok: number;
  effectiveDate: string | null;
  source: string | null;
}

/** Read the model_pricing book (migration 334) — the per-MTok rate reference for $ transparency. */
export async function loadModelPricingBook(runQuery: RunQuery): Promise<ModelPricingBookRow[]> {
  try {
    const rows = await runQuery<{
      model_id: string;
      input_per_mtok: string | number;
      output_per_mtok: string | number;
      cache_read_per_mtok: string | number;
      cache_creation_per_mtok: string | number;
      effective_date: string | null;
      source: string | null;
    }>(
      `SELECT model_id, input_per_mtok, output_per_mtok, cache_read_per_mtok,
              cache_creation_per_mtok, effective_date::text AS effective_date, source
         FROM harness_shared.model_pricing
        ORDER BY input_per_mtok DESC, model_id ASC`,
      [],
    );
    return rows.map((r) => ({
      modelId: r.model_id,
      inputPerMtok: num(r.input_per_mtok),
      outputPerMtok: num(r.output_per_mtok),
      cacheReadPerMtok: num(r.cache_read_per_mtok),
      cacheCreationPerMtok: num(r.cache_creation_per_mtok),
      effectiveDate: r.effective_date,
      source: r.source,
    }));
  } catch {
    return [];
  }
}

// ── 2. Coordination-token breakdown (the coord-cost lens) ───────────────────────

export interface CoordTriggerRow {
  /** 'coord-wake' | 'cron' | 'user' | 'autoloop' | 'unattributed' */
  trigger: string;
  tokens: number;
  costUsd: number;
  runs: number;
}
export interface CoordRoleClassRow {
  /** 'interactive' (user-driven) vs 'fleet' (queen/bee/overwatch/… — coord-driven). */
  roleClass: string;
  tokens: number;
  costUsd: number;
  runs: number;
}
export interface CoordTokenBreakdown {
  windowMs: number;
  /** $ by turn-trigger — populated once `turn_trigger` lands on live rows (deploy-gated). */
  byTrigger: CoordTriggerRow[];
  /**
   * Does this lens actually answer "which trigger is spending the money"?
   *
   * EI-22102999569306181: this was `byTrigger.some(r => r.trigger !== 'unattributed')` — an
   * EXISTENCE check standing in for a COVERAGE one. `turn_trigger` is stamped only from a
   * spawn-time env var (PAPERCUSP_TURN_TRIGGER), so a wake INJECTED into a live psu session
   * creates no process and can never receive one: measured 2026-09-03, 1856 of 1870 anthropic
   * samples were `unattributed` while 14 cron rows from two fixer roles flipped this true. The
   * lens then claimed attribution was available over a 99.3%-unattributed population.
   */
  triggerAttributionAvailable: boolean;
  /** Share (0..1) of windowed SPEND carrying a real `turn_trigger`. Read this before quoting
   *  any byTrigger figure: it is what makes a thin slice legible as thin rather than typical. */
  attributedCostShare: number;
  /** $ by role-class — the interactive-vs-fleet split, queryable on existing data NOW. */
  byRoleClass: CoordRoleClassRow[];
}

export interface LoadCoordTokenOpts {
  workspace_id: string;
  /** Omit to aggregate the whole workspace (coord cost is fleet-wide, not per-harness). */
  harness_slug?: string;
  windowMs?: number;
  runQuery: RunQuery;
}

/** Roles whose turns are coordination-driven (vs 'interactive' = a human chat turn). */
const FLEET_ROLE_CLASS_SQL = `CASE WHEN role = 'interactive' THEN 'interactive' ELSE 'fleet' END`;

export async function loadCoordTokenBreakdown(opts: LoadCoordTokenOpts): Promise<CoordTokenBreakdown> {
  const { workspace_id, harness_slug, runQuery } = opts;
  const windowMs = opts.windowMs ?? 7 * DAY_MS;
  const windowStart = Date.now() - windowMs;
  const harnessPred = harness_slug ? ` AND harness_slug = $2` : '';
  const params: unknown[] = harness_slug ? [workspace_id, harness_slug, windowStart] : [workspace_id, windowStart];
  const tsParam = harness_slug ? '$3' : '$2';

  // (a) by turn-trigger — guarded: `turn_trigger` is deploy-gated, so this section
  //     degrades to empty + triggerAttributionAvailable:false until it populates.
  let byTrigger: CoordTriggerRow[] = [];
  let triggerAttributionAvailable = false;
  let attributedCostShare = 0;
  try {
    const rows = await runQuery<{ trigger: string | null; tokens: string | number; cost_usd: string | number; runs: string | number }>(
      `SELECT COALESCE(NULLIF(turn_trigger, ''), 'unattributed') AS trigger,
              COALESCE(SUM(${TOKENS_EXPR}), 0)                    AS tokens,
              COALESCE(SUM(cost_usd), 0)                          AS cost_usd,
              COUNT(*)                                            AS runs
         FROM harness_shared.agent_usage_samples
        WHERE workspace_id = $1${harnessPred} AND ts >= ${tsParam}
        GROUP BY 1
        ORDER BY cost_usd DESC`,
      params,
    );
    byTrigger = rows.map((r) => ({
      trigger: r.trigger ?? 'unattributed',
      tokens: num(r.tokens),
      costUsd: num(r.cost_usd),
      runs: num(r.runs),
    }));
    // EI-22102999569306181: "available" is a COVERAGE question, not an existence one. A
    // single attributed row out of thousands does not make the lens answerable, so weight by
    // SPEND (the quantity the lens reports) and require a majority of it to carry a trigger.
    const totalCost = byTrigger.reduce((a, r) => a + r.costUsd, 0);
    const attributedCost = byTrigger.reduce((a, r) => (r.trigger === 'unattributed' ? a : a + r.costUsd), 0);
    attributedCostShare = totalCost > 0 ? attributedCost / totalCost : 0;
    triggerAttributionAvailable = attributedCostShare >= TRIGGER_ATTRIBUTION_MIN_SHARE;
  } catch {
    byTrigger = [];
    triggerAttributionAvailable = false;
    attributedCostShare = 0;
  }

  // (b) by role-class — interactive vs fleet — works on existing data.
  let byRoleClass: CoordRoleClassRow[] = [];
  try {
    const rows = await runQuery<{ role_class: string; tokens: string | number; cost_usd: string | number; runs: string | number }>(
      `SELECT ${FLEET_ROLE_CLASS_SQL}             AS role_class,
              COALESCE(SUM(${TOKENS_EXPR}), 0)    AS tokens,
              COALESCE(SUM(cost_usd), 0)          AS cost_usd,
              COUNT(*)                            AS runs
         FROM harness_shared.agent_usage_samples
        WHERE workspace_id = $1${harnessPred} AND ts >= ${tsParam}
        GROUP BY 1
        ORDER BY cost_usd DESC`,
      params,
    );
    byRoleClass = rows.map((r) => ({
      roleClass: r.role_class,
      tokens: num(r.tokens),
      costUsd: num(r.cost_usd),
      runs: num(r.runs),
    }));
  } catch {
    byRoleClass = [];
  }

  return { windowMs, byTrigger, triggerAttributionAvailable, attributedCostShare, byRoleClass };
}

// ── 3. Coord-poll volume (the quantified poll cost — ≈0 LLM tokens) ──────────────

export interface CoordPollRow {
  toolName: string;
  calls: number;
  distinctCallers: number;
}
export interface CoordPollVolume {
  windowMs: number;
  /** Top coord:* MCP-call volume. These are HTTP/MCP reads → ≈0 LLM tokens. */
  tools: CoordPollRow[];
  /** The wake-board UI poll (coord:wake-queue + coord:wake-mode) call total. */
  wakePollCalls: number;
  /** Share of ALL tool-invocation rows that are the wake poll pair (telemetry-write bloat). */
  wakePollRowSharePct: number;
}

export interface LoadCoordPollOpts {
  workspace_id: string;
  windowMs?: number;
  runQuery: RunQuery;
}

const WAKE_POLL_TOOLS = ['coord:wake-queue', 'coord:wake-mode'];

/**
 * Quantify the coord-poll cost from tool_invocations. The headline finding: the
 * wake-board UI poll (palette command-palette) is ~75% of all tool-invocation rows
 * yet spends ≈0 LLM tokens — cheap polling, not expensive context-injection.
 */
export async function loadCoordPollVolume(opts: LoadCoordPollOpts): Promise<CoordPollVolume> {
  const { workspace_id, runQuery } = opts;
  const windowMs = opts.windowMs ?? DAY_MS;
  const sinceIso = new Date(Date.now() - windowMs).toISOString();
  try {
    const [tools, totals] = await Promise.all([
      runQuery<{ tool_name: string; calls: string | number; distinct_callers: string | number }>(
        `SELECT tool_name,
                COUNT(*)               AS calls,
                COUNT(DISTINCT spawn_id) AS distinct_callers
           FROM harness_shared.tool_invocations
          WHERE workspace_id = $1 AND invoked_at >= $2 AND tool_name LIKE 'coord:%'
          GROUP BY tool_name
          ORDER BY calls DESC
          LIMIT 25`,
        [workspace_id, sinceIso],
      ),
      runQuery<{ total_rows: string | number; poll_rows: string | number }>(
        `SELECT COUNT(*) AS total_rows,
                COUNT(*) FILTER (WHERE tool_name = ANY($3)) AS poll_rows
           FROM harness_shared.tool_invocations
          WHERE workspace_id = $1 AND invoked_at >= $2`,
        [workspace_id, sinceIso, WAKE_POLL_TOOLS],
      ),
    ]);
    const toolRows: CoordPollRow[] = tools.map((r) => ({
      toolName: r.tool_name,
      calls: num(r.calls),
      distinctCallers: num(r.distinct_callers),
    }));
    const wakePollCalls = toolRows
      .filter((r) => WAKE_POLL_TOOLS.includes(r.toolName))
      .reduce((s, r) => s + r.calls, 0);
    const totalRows = num(totals[0]?.total_rows);
    const pollRows = num(totals[0]?.poll_rows);
    const wakePollRowSharePct = totalRows > 0 ? Math.round((1000 * pollRows) / totalRows) / 10 : 0;
    return { windowMs, tools: toolRows, wakePollCalls, wakePollRowSharePct };
  } catch {
    return { windowMs, tools: [], wakePollCalls: 0, wakePollRowSharePct: 0 };
  }
}
