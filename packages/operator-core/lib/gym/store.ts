/**
 * Gym PG data-access (P-012/P-013 read+write) against the dedicated gym database.
 *
 * Thin typed helpers over the harness_gym tables — used by the loop's persist seam,
 * the trace collector (run refs/signals), and the comparison read API (P-013). JSONB
 * columns are written as `${JSON.stringify(x)}::jsonb` (NOT sql.json(), which throws
 * under postgres-js v3.4 on this stack — peer-confirmed 2026-06-02).
 */
import type { Sql } from 'postgres';
import type { VariantOverlay } from './variant-overlay';
import type { GymScore } from './judge';
import { assertGymTaskNotContaminated } from './report-set-firewall';
import { asGymTaskCorpus, type GymTaskCorpus } from './task-corpus';
import { trackDetached } from '../detached-imports';

type Row = Record<string, unknown>;

export interface VariantRow {
  variantId: string;
  parentId?: string | null;
  label: string;
  overlay: VariantOverlay;
  diffFromParent?: string | null;
  proposerRationale?: string | null;
  status?: string;
}

export async function insertVariant(sql: Sql, v: VariantRow): Promise<void> {
  await sql`
    INSERT INTO harness_gym.gym_variants (variant_id, parent_id, label, prompt_overrides, diff_from_parent, proposer_rationale, status)
    VALUES (${v.variantId}, ${v.parentId ?? null}, ${v.label}, ${JSON.stringify(v.overlay.promptOverrides)}::text::jsonb,
            ${v.diffFromParent ?? null}, ${v.proposerRationale ?? null}, ${v.status ?? 'candidate'})
    ON CONFLICT (variant_id) DO UPDATE SET status = EXCLUDED.status, diff_from_parent = EXCLUDED.diff_from_parent`;
}

export interface TaskRow {
  taskId: string;
  pool: string;
  repoUrl: string;
  repoCommit: string;
  spec: string;
  intent: string;
  plantedBug?: unknown;
  generatedBy?: string;
  /** Provenance of the task substrate. Omitted remains fail-safe synthetic. */
  corpus?: GymTaskCorpus;
  /**
   * The declared source set this task came from (e.g. 'gym-synthetic'). Vetted by the
   * gym↔report-set firewall (P-012): a report-on benchmark set is refused here so the gym
   * can never tune on a set the impartial suite reports on. See report-set-firewall.ts.
   */
  sourceSet?: string;
}

export async function insertTask(sql: Sql, t: TaskRow): Promise<void> {
  // Firewall (P-012/D-005): refuse any task that originates from a report-on benchmark set
  // BEFORE it can enter the gym corpus — this is the single ingestion choke point.
  assertGymTaskNotContaminated({
    taskId: t.taskId,
    repoUrl: t.repoUrl,
    repoCommit: t.repoCommit,
    sourceSet: t.sourceSet,
    generatedBy: t.generatedBy,
  });
  await sql`
    INSERT INTO harness_gym.gym_tasks (task_id, pool, repo_url, repo_commit, spec, intent, planted_bug, generated_by, corpus)
    VALUES (${t.taskId}, ${t.pool}, ${t.repoUrl}, ${t.repoCommit}, ${t.spec}, ${t.intent},
            ${t.plantedBug ? JSON.stringify(t.plantedBug) : null}::text::jsonb, ${t.generatedBy ?? null},
            ${asGymTaskCorpus(t.corpus)})
    ON CONFLICT (task_id) DO NOTHING`;
}

export async function insertRun(
  sql: Sql,
  r: { runId: string; variantId: string; taskId: string; cycle: number; repeat?: number; harnessSlug?: string; workflowId?: string },
): Promise<void> {
  await sql`
    INSERT INTO harness_gym.gym_runs (run_id, variant_id, task_id, cycle, repeat, harness_slug, workflow_id)
    VALUES (${r.runId}, ${r.variantId}, ${r.taskId}, ${r.cycle}, ${r.repeat ?? 0}, ${r.harnessSlug ?? null}, ${r.workflowId ?? null})
    ON CONFLICT (run_id) DO NOTHING`;
}

export async function finishRun(
  sql: Sql,
  runId: string,
  fields: { terminalState: string; deterministicSignals: unknown; traceRef?: string; distilledRef?: string; elapsedMs?: number },
): Promise<void> {
  await sql`
    UPDATE harness_gym.gym_runs
       SET terminal_state = ${fields.terminalState},
           deterministic_signals = ${JSON.stringify(fields.deterministicSignals ?? {})}::text::jsonb,
           trace_ref = ${fields.traceRef ?? null},
           distilled_ref = ${fields.distilledRef ?? null},
           finished_at = now(),
           elapsed_ms = ${fields.elapsedMs ?? null}
     WHERE run_id = ${runId}`;
}

export async function insertScore(sql: Sql, runId: string, s: GymScore): Promise<void> {
  await sql`
    INSERT INTO harness_gym.gym_scores (run_id, judge_model, rubric_hash, judge_temp, weights, d1, d2, d3, composite, rationale)
    VALUES (${runId}, ${s.judgeModel}, ${s.rubricHash}, ${s.judgeTemp}, ${JSON.stringify(s.weights)}::text::jsonb,
            ${s.d1}, ${s.d2}, ${s.d3}, ${s.composite}, ${s.rationale})
    ON CONFLICT (run_id, rubric_hash) DO UPDATE
      SET d1 = EXCLUDED.d1, d2 = EXCLUDED.d2, d3 = EXCLUDED.d3, composite = EXCLUDED.composite, rationale = EXCLUDED.rationale`;
}

/** Recorded runner/rubric declarations, not measured loaded/runtime identity. */
export interface GymRunParams {
  harnessCommit: string;
  substrateCommit: string;
  mutableRoles?: unknown;
  judgeModel?: string;
  judgeTemp?: number;
  weights?: unknown;
  rubricHash?: string;
}

export async function insertRunParams(
  sql: Sql,
  runId: string,
  p: GymRunParams,
): Promise<void> {
  await sql`
    INSERT INTO harness_gym.gym_runs_params (run_id, harness_commit, substrate_commit, mutable_roles, judge_model, judge_temp, weights, rubric_hash)
    VALUES (${runId}, ${p.harnessCommit}, ${p.substrateCommit}, ${p.mutableRoles ? JSON.stringify(p.mutableRoles) : null}::text::jsonb,
            ${p.judgeModel ?? null}, ${p.judgeTemp ?? null}, ${p.weights ? JSON.stringify(p.weights) : null}::text::jsonb, ${p.rubricHash ?? null})
    ON CONFLICT (run_id) DO NOTHING`;
}

/**
 * Persist one optimization-loop cycle (P-022 audit trail → gym_cycles). The loop's
 * `deps.persistCycle` seam binds here. `cycleId` is deterministic per cycle so a retried
 * cycle is idempotent; `budgetSpentUsd` records the running spend at decision time.
 */
export async function insertCycle(
  sql: Sql,
  c: {
    cycleId: string;
    cycle: number;
    parentId: string;
    candidateId: string;
    decision: 'accept' | 'reject';
    gateResults: unknown;
    budgetSpentUsd?: number;
  },
): Promise<void> {
  await sql`
    INSERT INTO harness_gym.gym_cycles (cycle_id, cycle, parent_id, candidate_id, decision, gate_results, budget_spent_usd)
    VALUES (${c.cycleId}, ${c.cycle}, ${c.parentId}, ${c.candidateId}, ${c.decision},
            ${JSON.stringify(c.gateResults ?? {})}::text::jsonb, ${c.budgetSpentUsd ?? null})
    ON CONFLICT (cycle_id) DO UPDATE
      SET decision = EXCLUDED.decision, gate_results = EXCLUDED.gate_results, budget_spent_usd = EXCLUDED.budget_spent_usd`;
}

// ---------------------------------------------------------------------------
// Durable run-analytics copy (plan gym-repoint-live-coding-and-visible-runs-2026-07-20
// P-011). The cycle writes analytics into the EPHEMERAL gym PG (torn down at cycle end);
// this copies the lightweight rows into the LIVE operator DB's harness_gym schema
// (migration 650) so the gym UI's Cycles/Variants/Frontier tabs read persisted data.
// The run-analytics analogue of makeLoopProposalRecorder (control-plane.ts): a cycle-end
// bridge from the throwaway gym PG to the durable live DB, scoped by (workspace,harness).
// ---------------------------------------------------------------------------

export interface DurableAnalyticsScope {
  workspaceId: string;
  harnessSlug: string;
}

export interface DurableCopyCounts {
  tasks: number;
  variants: number;
  runs: number;
  scores: number;
  cycles: number;
}

/**
 * Normalize a jsonb column value read back from postgres-js into a text payload for
 * re-insert via `::text::jsonb`. On this stack postgres-js returns jsonb as a raw JSON
 * STRING (store.integration.test.ts) — pass it straight through; if a caller/config returns
 * a parsed object instead, stringify it. `fallback` covers a null read on a NOT NULL column.
 */
function jsonbPassthrough(v: unknown, fallback: string | null): string | null {
  if (v == null) return fallback;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/**
 * Copy this cycle's run analytics from the ephemeral gym PG (`src`) into the durable
 * live-DB harness_gym tables (`dst`), stamping every row with (workspace_id, harness_slug)
 * so multiple gym harnesses share the tables without id collisions ('baseline',
 * 'gym-loop-health', 'cyc-0' repeat across harnesses). Idempotent upserts — a re-run of the
 * same cycle overwrites its own rows. Preserve the recorded deterministic signals (including
 * oracle pre/post receipts) and run parameters before the temporary source DB is destroyed.
 * Trace references keep their original identity; this does not retain the referenced files
 * or turn declared commits into complete runtime identity. Missing evidence stays NULL.
 * The whole copy runs in one `dst` transaction so a reader never sees a half-copied cycle.
 */
export async function copyRunAnalyticsToDurable(
  src: Sql,
  dst: Sql,
  scope: DurableAnalyticsScope,
): Promise<DurableCopyCounts> {
  const ws = scope.workspaceId;
  const hs = scope.harnessSlug;

  const [tasks, variants, runs, scores, cycles] = await Promise.all([
    src`SELECT task_id, pool, spec, intent, repo_url, repo_commit, generated_by, corpus, created_at
          FROM harness_gym.gym_tasks` as Promise<Row[]>,
    src`SELECT variant_id, parent_id, label, prompt_overrides, diff_from_parent, proposer_rationale, status, created_at
          FROM harness_gym.gym_variants` as Promise<Row[]>,
    src`SELECT r.run_id, r.variant_id, r.task_id, r.cycle, r.repeat, r.terminal_state,
               r.started_at, r.finished_at, r.elapsed_ms,
               row_to_json(r) AS run_evidence, row_to_json(p) AS run_params
          FROM harness_gym.gym_runs r
          LEFT JOIN harness_gym.gym_runs_params p ON p.run_id = r.run_id` as Promise<Row[]>,
    src`SELECT run_id, judge_model, rubric_hash, judge_temp, weights, d1, d2, d3, composite, rationale, scored_at
          FROM harness_gym.gym_scores` as Promise<Row[]>,
    src`SELECT cycle_id, cycle, parent_id, candidate_id, decision, gate_results, budget_spent_usd, created_at
          FROM harness_gym.gym_cycles` as Promise<Row[]>,
  ]);

  await dst.begin(async (tx) => {
    // A durable task row is history; `active` identifies the corpus from the
    // newest copy for this workspace+harness.  Deactivate first inside the same
    // transaction so readers see either the old complete generation or the new
    // complete generation, never a mixed corpus.  Historical task rows remain
    // available for old run/score joins.
    await tx`
      UPDATE harness_gym_durable.gym_tasks
         SET active = false
       WHERE workspace_id = ${ws} AND harness_slug = ${hs} AND active = true`;

    for (const r of tasks) {
      await tx`
        INSERT INTO harness_gym_durable.gym_tasks (workspace_id, harness_slug, task_id, pool, spec, intent, repo_url, repo_commit, generated_by, corpus, active, created_at)
        VALUES (${ws}, ${hs}, ${r.task_id as string}, ${r.pool as string}, ${(r.spec ?? null) as string | null}, ${(r.intent ?? null) as string | null},
                ${(r.repo_url ?? null) as string | null}, ${(r.repo_commit ?? null) as string | null}, ${(r.generated_by ?? null) as string | null},
                ${asGymTaskCorpus(r.corpus)}, true, ${(r.created_at ?? new Date()) as Date})
        ON CONFLICT (workspace_id, harness_slug, task_id) DO UPDATE
          SET pool = EXCLUDED.pool, spec = EXCLUDED.spec, intent = EXCLUDED.intent,
              repo_url = EXCLUDED.repo_url, repo_commit = EXCLUDED.repo_commit,
              generated_by = EXCLUDED.generated_by, corpus = EXCLUDED.corpus,
              active = true`;
    }
    for (const r of variants) {
      await tx`
        INSERT INTO harness_gym_durable.gym_variants (workspace_id, harness_slug, variant_id, parent_id, label, prompt_overrides, diff_from_parent, proposer_rationale, status, created_at)
        VALUES (${ws}, ${hs}, ${r.variant_id as string}, ${(r.parent_id ?? null) as string | null}, ${r.label as string},
                ${jsonbPassthrough(r.prompt_overrides, '{}')}::text::jsonb, ${(r.diff_from_parent ?? null) as string | null},
                ${(r.proposer_rationale ?? null) as string | null}, ${(r.status ?? 'candidate') as string}, ${(r.created_at ?? new Date()) as Date})
        ON CONFLICT (workspace_id, harness_slug, variant_id) DO UPDATE
          SET parent_id = EXCLUDED.parent_id, label = EXCLUDED.label, prompt_overrides = EXCLUDED.prompt_overrides,
              diff_from_parent = EXCLUDED.diff_from_parent, proposer_rationale = EXCLUDED.proposer_rationale, status = EXCLUDED.status`;
    }
    for (const r of runs) {
      await tx`
        INSERT INTO harness_gym_durable.gym_runs (workspace_id, harness_slug, run_id, variant_id, task_id, cycle, repeat, terminal_state, started_at, finished_at, elapsed_ms,
                                                run_evidence, run_params)
        VALUES (${ws}, ${hs}, ${r.run_id as string}, ${r.variant_id as string}, ${r.task_id as string}, ${Number(r.cycle ?? 0)}, ${Number(r.repeat ?? 0)},
                ${(r.terminal_state ?? null) as string | null}, ${(r.started_at ?? null) as Date | null}, ${(r.finished_at ?? null) as Date | null},
                ${r.elapsed_ms == null ? null : Number(r.elapsed_ms)},
                ${jsonbPassthrough(r.run_evidence, null)}::text::jsonb,
                ${jsonbPassthrough(r.run_params, null)}::text::jsonb)
        ON CONFLICT (workspace_id, harness_slug, run_id) DO UPDATE
          SET variant_id = EXCLUDED.variant_id, task_id = EXCLUDED.task_id, cycle = EXCLUDED.cycle, repeat = EXCLUDED.repeat,
              terminal_state = EXCLUDED.terminal_state, finished_at = EXCLUDED.finished_at, elapsed_ms = EXCLUDED.elapsed_ms,
              run_evidence = EXCLUDED.run_evidence, run_params = EXCLUDED.run_params`;
    }
    for (const r of scores) {
      await tx`
        INSERT INTO harness_gym_durable.gym_scores (workspace_id, harness_slug, run_id, judge_model, rubric_hash, judge_temp, weights, d1, d2, d3, composite, rationale, scored_at)
        VALUES (${ws}, ${hs}, ${r.run_id as string}, ${r.judge_model as string}, ${r.rubric_hash as string}, ${r.judge_temp == null ? null : Number(r.judge_temp)},
                ${jsonbPassthrough(r.weights, '{}')}::text::jsonb, ${Number(r.d1 ?? 0)}, ${Number(r.d2 ?? 0)}, ${Number(r.d3 ?? 0)}, ${Number(r.composite ?? 0)},
                ${(r.rationale ?? null) as string | null}, ${(r.scored_at ?? new Date()) as Date})
        ON CONFLICT (workspace_id, harness_slug, run_id, rubric_hash) DO UPDATE
          SET d1 = EXCLUDED.d1, d2 = EXCLUDED.d2, d3 = EXCLUDED.d3, composite = EXCLUDED.composite, rationale = EXCLUDED.rationale`;
    }
    for (const r of cycles) {
      await tx`
        INSERT INTO harness_gym_durable.gym_cycles (workspace_id, harness_slug, cycle_id, cycle, parent_id, candidate_id, decision, gate_results, budget_spent_usd, created_at)
        VALUES (${ws}, ${hs}, ${r.cycle_id as string}, ${Number(r.cycle ?? 0)}, ${(r.parent_id ?? null) as string | null}, ${(r.candidate_id ?? null) as string | null},
                ${(r.decision ?? null) as string | null}, ${jsonbPassthrough(r.gate_results, null)}::text::jsonb, ${r.budget_spent_usd == null ? null : Number(r.budget_spent_usd)},
                ${(r.created_at ?? new Date()) as Date})
        ON CONFLICT (workspace_id, harness_slug, cycle_id) DO UPDATE
          SET cycle = EXCLUDED.cycle, parent_id = EXCLUDED.parent_id, candidate_id = EXCLUDED.candidate_id,
              decision = EXCLUDED.decision, gate_results = EXCLUDED.gate_results, budget_spent_usd = EXCLUDED.budget_spent_usd`;
    }
  });

  // Push-on-write for the Learning tab's Gym view (owner report 2026-07-26:
  // the pane sat "as of 2h ago" through three cycles — learning.gym had NO
  // producer, so new durable rows never reached an open pane). pg_notify
  // fans out cross-process, so this works from the gym CLI and bg-host alike;
  // fire-and-forget so an SSE hiccup never fails the durable copy.
  void trackDetached(import('../sync-sse'))
    .then((m) => m.notifySyncInvalidate('learning.gym'))
    .catch(() => {});

  return { tasks: tasks.length, variants: variants.length, runs: runs.length, scores: scores.length, cycles: cycles.length };
}

export interface VariantComparisonRow {
  taskId: string;
  aComposite: number | null;
  bComposite: number | null;
  delta: number | null;
}

/**
 * P-013 per-task A-vs-B: each task's composite for variant A and B (under one rubric)
 * + the signed delta (B − A). Tasks evaluated by either variant appear; missing side null.
 */
export async function compareVariants(
  sql: Sql,
  variantA: string,
  variantB: string,
  rubricHash: string,
): Promise<VariantComparisonRow[]> {
  const rows = await sql<{ task_id: string; a: number | null; b: number | null }[]>`
    WITH scored AS (
      SELECT r.task_id, r.variant_id, s.composite
        FROM harness_gym.gym_runs r
        JOIN harness_gym.gym_scores s ON s.run_id = r.run_id AND s.rubric_hash = ${rubricHash}
       WHERE r.variant_id IN (${variantA}, ${variantB})
    )
    SELECT task_id,
           MAX(composite) FILTER (WHERE variant_id = ${variantA}) AS a,
           MAX(composite) FILTER (WHERE variant_id = ${variantB}) AS b
      FROM scored
     GROUP BY task_id
     ORDER BY task_id`;
  return rows.map((r) => ({
    taskId: r.task_id,
    aComposite: r.a,
    bComposite: r.b,
    delta: r.a !== null && r.b !== null ? r.b - r.a : null,
  }));
}

/**
 * Durable-DB (P-013) per-task A-vs-B — the same shape as compareVariants but against the
 * live-DB harness_gym read-cache, scoped by (workspace_id, harness_slug). Every join carries
 * the scope so a task/variant/run id shared across gym harnesses can't cross-contaminate.
 */
export async function compareDurableVariants(
  sql: Sql,
  scope: DurableAnalyticsScope,
  variantA: string,
  variantB: string,
  rubricHash: string,
): Promise<VariantComparisonRow[]> {
  const rows = await sql<{ task_id: string; a: number | null; b: number | null }[]>`
    WITH scored AS (
      SELECT r.task_id, r.variant_id, s.composite
        FROM harness_gym_durable.gym_runs r
        JOIN harness_gym_durable.gym_scores s
          ON s.workspace_id = r.workspace_id AND s.harness_slug = r.harness_slug
         AND s.run_id = r.run_id AND s.rubric_hash = ${rubricHash}
       WHERE r.workspace_id = ${scope.workspaceId} AND r.harness_slug = ${scope.harnessSlug}
         AND r.variant_id IN (${variantA}, ${variantB})
    )
    SELECT task_id,
           MAX(composite) FILTER (WHERE variant_id = ${variantA}) AS a,
           MAX(composite) FILTER (WHERE variant_id = ${variantB}) AS b
      FROM scored
     GROUP BY task_id
     ORDER BY task_id`;
  return rows.map((r) => ({
    taskId: r.task_id,
    aComposite: r.a,
    bComposite: r.b,
    delta: r.a !== null && r.b !== null ? r.b - r.a : null,
  }));
}
