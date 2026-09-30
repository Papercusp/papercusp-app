/**
 * `system:sql-read-census` — the nightly SQL-read census
 * (plan `sql-escape-tool-routing-2026-08-12`, P-008).
 *
 * The recurring half of the raw-SQL escape-hatch work. Every night it reads the
 * `dev:pg_query` corpus, folds it into (relation, claiming intent) clusters,
 * writes one row per cluster to `harness_shared.sql_read_census`, and wakes an
 * agent ONLY when a threshold moves. The judgement lives entirely in
 * `bash-substitution/sql-census.ts` as pure functions; this file is the seam that
 * reads, writes, debounces and escalates.
 *
 * Config (routine `trigger_config`):
 *   - `window_days`        — corpus lookback (default 7).
 *   - `agent_threshold`    — (a) uncovered-demand floor in distinct agents.
 *   - `grace_days`         — (c) days after ship before the check applies.
 *   - `required_fall_pct`  — (c) fraction of pre-ship agents that must go away.
 *
 * Env kill switches (the `<=0` convention the sibling watchdog floors use, so a
 * noisy leg can be silenced without a code change or a deploy):
 *   - PAPERCUSP_SQL_CENSUS_AGENT_THRESHOLD  <= 0 disables (a).
 *   - PAPERCUSP_SQL_CENSUS_REQUIRED_FALL_PCT <= 0 disables (c).
 *
 * ⚠ THE WRITE IS IDEMPOTENT ON PURPOSE — `SET = EXCLUDED`, never `+= EXCLUDED`.
 * The census re-reads a trailing window every night, so accumulating would
 * inflate a cluster by roughly `window_days` within a week. This is the exact
 * semantic difference that disqualified reusing `tool_usage_rollup`, whose writer
 * is an incremental ingester that never re-reads bytes (migration 811).
 */
import { getOrgPg } from '@papercusp/db-org';
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { fetchSqlCorpusAtoms } from '../../bash-substitution/sql-corpus';
import { SQL_READ_NO_PAIR_DECISIONS, SQL_READ_PAIRS } from '../../bash-substitution/pairs';
import {
  buildCensusEscalation,
  computeSqlCensus,
  evaluateDeliberateNoPairDrift,
  evaluateNoFallAfterShip,
  evaluateUncoveredDemand,
  evaluateVerdictDrift,
  type CensusCluster,
  type PriorCensusRow,
} from '../../bash-substitution/sql-census';
import { recentWatchdogFires, recordFire } from '../../pot/watchdog';
import { openEscalation } from '../../agent-tools/coordination/escalations';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';

/** Corpus lookback when the routine row does not say. */
export const DEFAULT_CENSUS_WINDOW_DAYS = 7;

/** How far back the (c) check reads census history. Must exceed grace_days comfortably. */
export const CENSUS_HISTORY_DAYS = 120;

/** How long one alarm CLASS stays debounced. A gap that persists is not new news nightly. */
export const CENSUS_DEBOUNCE_HOURS = 7 * 24;

/**
 * (a)'s floor in DISTINCT AGENTS over the window. Default 10, the owner's proposed
 * N. `<=0` disables the leg.
 */
export function censusAgentThreshold(fallback = 10): number {
  const raw = process.env.PAPERCUSP_SQL_CENSUS_AGENT_THRESHOLD;
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** (c)'s required fall as a fraction of pre-ship agents. Default 0.3; `<=0` disables the leg. */
export function censusRequiredFallPct(fallback = 0.3): number {
  const raw = process.env.PAPERCUSP_SQL_CENSUS_REQUIRED_FALL_PCT;
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Synthetic identity for the background census escalation (mirrors the sibling watchdogs'). */
const CENSUS_IDENTITY: AgentIdentity = {
  ownerId: 'sql-read-census',
  ownerLabel: 'system · sql-read-census',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

/** UTC calendar date, which is the grain `ran_on` is keyed on. */
export function utcDate(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export interface CensusRunResult {
  outcome: 'wrote' | 'alerted' | 'debounced' | 'empty' | 'error';
  ranOn: string;
  clusters: number;
  uncovered: number;
  drift: number;
  noFall: number;
  deliberateNoPairDrift: number;
  reason?: string;
}

export interface SqlReadCensusDeps {
  fetchAtoms?: typeof fetchSqlCorpusAtoms;
  recentWatchdogFires?: typeof recentWatchdogFires;
  recordFire?: typeof recordFire;
  openEscalation?: typeof openEscalation;
  now?: number;
}

/** Persist tonight's clusters. Idempotent per (night, relation, intent). */
async function writeCensus(
  workspaceId: string,
  ranOn: string,
  windowDays: number,
  clusters: readonly CensusCluster[],
): Promise<void> {
  if (clusters.length === 0) return;
  const { sql } = getOrgPg();
  for (const c of clusters) {
    await sql`
      INSERT INTO harness_shared.sql_read_census (
        workspace_id, ran_on, window_days, relation, intent_label, relation_has_pairs,
        deliberately_unpaired, deliberate_decision_ref,
        deliberate_baseline_window_days, deliberate_baseline_calls,
        deliberate_baseline_atoms, deliberate_baseline_distinct_agents,
        covering_tool, equivalence_verdict, distinct_agents, calls,
        relation_distinct_agents, relation_calls, sample_atom
      ) VALUES (
        ${workspaceId}, ${ranOn}::date, ${windowDays}, ${c.relation}, ${c.intentLabel},
        ${c.relationHasPairs}, ${c.deliberatelyUnpaired},
        ${c.deliberateNoPairDecision?.decisionRef ?? null},
        ${c.deliberateNoPairDecision?.baseline.windowDays ?? null},
        ${c.deliberateNoPairDecision?.baseline.calls ?? null},
        ${c.deliberateNoPairDecision?.baseline.atoms ?? null},
        ${c.deliberateNoPairDecision?.baseline.distinctAgents ?? null},
        ${c.coveringTool}, ${c.equivalenceVerdict},
        ${c.distinctAgents}, ${c.calls}, ${c.relationDistinctAgents}, ${c.relationCalls},
        ${c.sampleAtom}
      )
      ON CONFLICT (workspace_id, ran_on, relation, (COALESCE(intent_label, ''))) DO UPDATE SET
        window_days              = EXCLUDED.window_days,
        relation_has_pairs       = EXCLUDED.relation_has_pairs,
        deliberately_unpaired    = EXCLUDED.deliberately_unpaired,
        deliberate_decision_ref = EXCLUDED.deliberate_decision_ref,
        deliberate_baseline_window_days = EXCLUDED.deliberate_baseline_window_days,
        deliberate_baseline_calls = EXCLUDED.deliberate_baseline_calls,
        deliberate_baseline_atoms = EXCLUDED.deliberate_baseline_atoms,
        deliberate_baseline_distinct_agents = EXCLUDED.deliberate_baseline_distinct_agents,
        covering_tool            = EXCLUDED.covering_tool,
        equivalence_verdict      = EXCLUDED.equivalence_verdict,
        distinct_agents          = EXCLUDED.distinct_agents,
        calls                    = EXCLUDED.calls,
        relation_distinct_agents = EXCLUDED.relation_distinct_agents,
        relation_calls           = EXCLUDED.relation_calls,
        sample_atom              = EXCLUDED.sample_atom,
        computed_at              = now()
    `;
  }
}

/** Census history STRICTLY BEFORE tonight — tonight's own rows are the `tonight` argument. */
async function readHistory(workspaceId: string, ranOn: string): Promise<PriorCensusRow[]> {
  const { sql } = getOrgPg();
  const rows = (await sql`
    SELECT ran_on::text AS ran_on, relation, intent_label, covering_tool,
           equivalence_verdict, distinct_agents, relation_distinct_agents
      FROM harness_shared.sql_read_census
     WHERE workspace_id = ${workspaceId}
       AND ran_on < ${ranOn}::date
       -- The ::integer cast is LOAD-BEARING, not decoration. Without it Postgres
       -- resolves the untyped bind against 'date - date -> integer' rather than
       -- 'date - integer -> date', and the whole predicate fails at runtime with
       -- "operator does not exist: date >= integer". Caught only by the live run --
       -- the pure tests never reach SQL (WI-38296).
       AND ran_on >= ${ranOn}::date - ${CENSUS_HISTORY_DAYS}::integer
     ORDER BY ran_on
  `) as unknown as Array<{
    ran_on: string;
    relation: string;
    intent_label: string | null;
    covering_tool: string | null;
    equivalence_verdict: string | null;
    distinct_agents: number;
    relation_distinct_agents: number;
  }>;
  return rows.map((r) => ({
    ranOn: r.ran_on,
    relation: r.relation,
    intentLabel: r.intent_label,
    coveringTool: r.covering_tool,
    equivalenceVerdict: (r.equivalence_verdict as PriorCensusRow['equivalenceVerdict']) ?? null,
    distinctAgents: Number(r.distinct_agents),
    relationDistinctAgents: Number(r.relation_distinct_agents),
  }));
}

/**
 * One census run.
 *
 * Fail-soft end to end: a census that throws must not fail the routines tick it
 * rides in, and an escalation that fails must not lose the measurement — so the
 * WRITE happens before the alarms are evaluated. That ordering matters more than
 * it looks: the row written tonight is the pre-ship baseline some future night's
 * (c) check reads, and losing it because a coord write failed would silently
 * blind the only alarm that reports a failed repair.
 */
export async function runSqlReadCensus(
  opts: { workspaceId?: string; installSlug?: string; windowDays?: number; agentThreshold?: number; graceDays?: number; requiredFallPct?: number } = {},
  deps: SqlReadCensusDeps = {},
): Promise<CensusRunResult> {
  const now = deps.now ?? Date.now();
  const ranOn = utcDate(now);
  const workspaceId = opts.workspaceId ?? 'papercusp-workspace';
  const installSlug = opts.installSlug ?? 'papercusp';
  const windowDays = Math.max(1, Math.floor(opts.windowDays ?? DEFAULT_CENSUS_WINDOW_DAYS));
  const base: CensusRunResult = {
    outcome: 'empty',
    ranOn,
    clusters: 0,
    uncovered: 0,
    drift: 0,
    noFall: 0,
    deliberateNoPairDrift: 0,
  };

  try {
    const atoms = await (deps.fetchAtoms ?? fetchSqlCorpusAtoms)({ workspaceId, windowDays });
    const clusters = computeSqlCensus(atoms, SQL_READ_PAIRS, SQL_READ_NO_PAIR_DECISIONS);
    if (clusters.length === 0) {
      return { ...base, reason: 'corpus held no plain single-relation reads' };
    }
    await writeCensus(workspaceId, ranOn, windowDays, clusters);

    const history = await readHistory(workspaceId, ranOn);
    const uncovered = evaluateUncoveredDemand(clusters, censusAgentThreshold(opts.agentThreshold ?? 10));
    const drift = evaluateVerdictDrift(clusters, history);
    const deliberateNoPairDrift = evaluateDeliberateNoPairDrift(clusters);
    const noFall = evaluateNoFallAfterShip(clusters, history, {
      today: ranOn,
      graceDays: opts.graceDays,
      requiredFallPct: censusRequiredFallPct(opts.requiredFallPct ?? 0.3),
    });

    const counts = {
      ...base,
      clusters: clusters.length,
      uncovered: uncovered.length,
      drift: drift.length,
      noFall: noFall.length,
      deliberateNoPairDrift: deliberateNoPairDrift.length,
    };

    const escalation = buildCensusEscalation({ uncovered, drift, noFall, deliberateNoPairDrift }, windowDays);
    if (!escalation) return { ...counts, outcome: 'wrote' };

    // Debounce per ALARM CLASS, not per run: a gap that persists for a fortnight is
    // not new news every night, but a NEW class crossing must not be suppressed by
    // an older one still inside its window — which is the failure the rubric
    // watchdog had to fix (EI-16071) when its key was source-only.
    const scopeKey = escalation.scopeKeys.join('+');
    const firedRecently =
      (await (deps.recentWatchdogFires ?? recentWatchdogFires)(
        workspaceId,
        installSlug,
        CENSUS_DEBOUNCE_HOURS,
        'sql-read-census',
        scopeKey,
      )) > 0;
    if (firedRecently) return { ...counts, outcome: 'debounced', reason: `fires-ledger debounce (${scopeKey})` };

    await (deps.recordFire ?? recordFire)({
      workspaceId,
      installSlug,
      source: 'sql-read-census',
      reason: `${escalation.summary} [${scopeKey}]`,
      wakeAt: null,
    });
    await (deps.openEscalation ?? openEscalation)(CENSUS_IDENTITY, {
      severity: 'advisory',
      summary: escalation.summary,
      body: escalation.body,
    });
    return { ...counts, outcome: 'alerted', reason: escalation.summary };
  } catch (e) {
    return { ...base, outcome: 'error', reason: e instanceof Error ? e.message : String(e) };
  }
}

registerSystemAction('sql-read-census', async (ctx: SystemActionCtx) => {
  const cfg = ctx.triggerConfig ?? {};
  const num = (v: unknown): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const result = await runSqlReadCensus({
    workspaceId: ctx.workspaceId,
    windowDays: num(cfg.window_days),
    agentThreshold: num(cfg.agent_threshold),
    graceDays: num(cfg.grace_days),
    requiredFallPct: num(cfg.required_fall_pct),
  });
  const line =
    `[sql-read-census] ${ctx.workspaceId} ${result.ranOn}: ${result.outcome} — ` +
    `${result.clusters} cluster(s), uncovered ${result.uncovered}, drift ${result.drift}, ` +
    `no-pair drift ${result.deliberateNoPairDrift}, no-fall ${result.noFall}` +
    (result.reason ? ` (${result.reason})` : '');
  if (result.outcome === 'error' || result.outcome === 'alerted') console.warn(line);
  else console.log(line);
});
