/**
 * Prompt-ablation run store (self-learning-frontier P-023 / FB-09) — IO over
 * `harness_shared.prompt_ablation_runs` (migration 249). Injected `Sql`
 * (control-plane style) so the integration suite runs against a migrated
 * testcontainer and unit callers fake it.
 *
 * NOTE timestamps travel as ISO STRINGS, never Date instances — the live
 * getOrgPg() client rejects Date params (agent-insights/
 * db-org-client-rejects-js-date-params). The SAME live-client gotcha applies
 * to jsonb params: `sql.json(<array>)` serializes fine on the testcontainers
 * clients but the live client throws ('Received an instance of Array'), so
 * every jsonb travels as a JSON STRING with an explicit `::text::jsonb` cast
 * (proven live in the FB-09 supervised cycle, 2026-06-12).
 */

import type { Sql } from 'postgres';
import type { AblationVerdict, ScenarioArmOutcome } from './scoring';

export interface AblationRunRow {
  id: string;
  workspaceId: string;
  startedAt: string;
  finishedAt: string;
  playbookPath: string;
  playbookHash: string;
  ruleKey: string;
  ruleHash: string;
  ruleExcerpt: string;
  origin: 'shadow';
  scenarioCount: number;
  baselinePassRate: number | null;
  ablatedPassRate: number | null;
  passRateDelta: number | null;
  verdict: AblationVerdict | string;
  capped: boolean;
  costUsd: number;
  ledgerContext: unknown[] | null;
  detail: { scenarios: ScenarioArmOutcome[] } & Record<string, unknown>;
  replayLeg: unknown | null;
  /** The pot the ablated playbook serves (P-002 pot-scope-all-learnings); null = pre-pot legacy or context-less. */
  potSlug: string | null;
}

export interface InsertAblationRunInput {
  workspaceId: string;
  startedAtMs: number;
  playbookPath: string;
  playbookHash: string;
  ruleKey: string;
  ruleHash: string;
  ruleExcerpt: string;
  scenarioCount: number;
  baselinePassRate: number | null;
  ablatedPassRate: number | null;
  passRateDelta: number | null;
  verdict: AblationVerdict;
  capped: boolean;
  costUsd: number;
  ledgerContext: unknown[] | null;
  detail: { scenarios: ScenarioArmOutcome[] } & Record<string, unknown>;
  replayLeg?: unknown | null;
  /**
   * The pot the ablated playbook serves (P-002 pot-scope-all-learnings) — resolve
   * via resolveLearningPotSlug at the runner. Required so no writer forgets the
   * scope; explicit null = genuinely context-less (D-002).
   */
  potSlug: string | null;
}

export async function insertAblationRun(sql: Sql, input: InsertAblationRunInput): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.prompt_ablation_runs
      (workspace_id, started_at, playbook_path, playbook_hash, rule_key, rule_hash,
       rule_excerpt, scenario_count, baseline_pass_rate, ablated_pass_rate,
       pass_rate_delta, verdict, capped, cost_usd, ledger_context, detail, replay_leg,
       pot_slug)
    VALUES
      (${input.workspaceId}, ${new Date(input.startedAtMs).toISOString()},
       ${input.playbookPath}, ${input.playbookHash}, ${input.ruleKey}, ${input.ruleHash},
       ${input.ruleExcerpt}, ${input.scenarioCount}, ${input.baselinePassRate},
       ${input.ablatedPassRate}, ${input.passRateDelta}, ${input.verdict},
       ${input.capped}, ${input.costUsd},
       ${input.ledgerContext ? JSON.stringify(input.ledgerContext) : null}::text::jsonb,
       ${JSON.stringify(input.detail)}::text::jsonb,
       ${input.replayLeg != null ? JSON.stringify(input.replayLeg) : null}::text::jsonb,
       ${input.potSlug})
    RETURNING id`;
  return rows[0]!.id;
}

interface RawRow {
  id: string;
  workspace_id: string;
  started_at: Date | string;
  finished_at: Date | string;
  playbook_path: string;
  playbook_hash: string;
  rule_key: string;
  rule_hash: string;
  rule_excerpt: string;
  origin: string;
  scenario_count: number;
  baseline_pass_rate: number | null;
  ablated_pass_rate: number | null;
  pass_rate_delta: number | null;
  verdict: string;
  capped: boolean;
  cost_usd: number;
  ledger_context: unknown[] | null;
  detail: AblationRunRow['detail'];
  replay_leg: unknown | null;
  pot_slug: string | null;
}

const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

function mapRow(r: RawRow): AblationRunRow {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
    playbookPath: r.playbook_path,
    playbookHash: r.playbook_hash,
    ruleKey: r.rule_key,
    ruleHash: r.rule_hash,
    ruleExcerpt: r.rule_excerpt,
    origin: r.origin as 'shadow',
    scenarioCount: r.scenario_count,
    baselinePassRate: r.baseline_pass_rate,
    ablatedPassRate: r.ablated_pass_rate,
    passRateDelta: r.pass_rate_delta,
    verdict: r.verdict,
    capped: r.capped,
    costUsd: r.cost_usd,
    ledgerContext: r.ledger_context,
    detail: r.detail,
    replayLeg: r.replay_leg,
    potSlug: r.pot_slug,
  };
}

export interface ListAblationRunsOptions {
  ruleKey?: string;
  limit?: number;
}

/** Newest-first run rows for a workspace (the report + tools read path). */
export async function listAblationRuns(
  sql: Sql,
  workspaceId: string,
  opts: ListAblationRunsOptions = {},
): Promise<AblationRunRow[]> {
  const limit = Math.min(Math.max(1, opts.limit ?? 200), 1000);
  const rows = await sql<RawRow[]>`
    SELECT id, workspace_id, started_at, finished_at, playbook_path, playbook_hash,
           rule_key, rule_hash, rule_excerpt, origin, scenario_count,
           baseline_pass_rate, ablated_pass_rate, pass_rate_delta, verdict, capped,
           cost_usd, ledger_context, detail, replay_leg, pot_slug
      FROM harness_shared.prompt_ablation_runs
     WHERE workspace_id = ${workspaceId}
       ${opts.ruleKey ? sql`AND rule_key = ${opts.ruleKey}` : sql``}
     ORDER BY finished_at DESC
     LIMIT ${limit}`;
  return rows.map(mapRow);
}

/** ruleKey → most recent finished_at (ISO). The rotation's recency map. */
export async function lastAblatedAtByRule(sql: Sql, workspaceId: string): Promise<Map<string, string>> {
  const rows = await sql<{ rule_key: string; last_at: Date | string }[]>`
    SELECT rule_key, max(finished_at) AS last_at
      FROM harness_shared.prompt_ablation_runs
     WHERE workspace_id = ${workspaceId}
     GROUP BY rule_key`;
  return new Map(rows.map((r) => [r.rule_key, iso(r.last_at)]));
}
