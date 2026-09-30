import postgres from 'postgres';

export interface MetricCollectorInput {
  runId: string;
  caseId: string;
  variant: string;
  workItemId?: string;
  workItemStatus?: string;
  workItemAttempts?: number;
  workItemCreatedAt?: Date;
  workItemResolvedAt?: Date;
  inputTokens?: number;
  outputTokens?: number;
  escalated?: boolean;
  retrievedSources?: string[];
  expectedSources?: string[];
}

export interface IQBatteryMetrics {
  runId: string;
  caseId: string;
  variant: string;
  success: boolean;
  tokensPerSolvedTask: number | null;
  timeToGreenSecs: number | null;
  firstAttemptPass: boolean;
  recurrence: number;
  escalation: boolean;
  recallHit: number;
}

class MetricsCollector {
  constructor(private sql: postgres.Sql) {}

  /**
   * Collect success metric: boolean task completion
   */
  private collectSuccess(input: MetricCollectorInput): boolean {
    const completionStatuses = ['done', 'resolved', 'closed'];
    return (
      completionStatuses.includes(input.workItemStatus || '') &&
      !input.escalated
    );
  }

  /**
   * Collect tokens-per-solved-task: total tokens consumed in successful attempts
   */
  private collectTokensPerSolvedTask(
    input: MetricCollectorInput
  ): number | null {
    if (!input.inputTokens || !input.outputTokens) return null;
    if (!this.collectSuccess(input)) return null;
    return input.inputTokens + input.outputTokens;
  }

  /**
   * Collect time-to-green: wall-clock seconds from task start to completion
   */
  private collectTimeToGreen(input: MetricCollectorInput): number | null {
    if (!input.workItemCreatedAt || !input.workItemResolvedAt) return null;
    if (!this.collectSuccess(input)) return null;

    const diffMs = input.workItemResolvedAt.getTime() - input.workItemCreatedAt.getTime();
    return diffMs / 1000; // convert to seconds
  }

  /**
   * Collect first-attempt-pass: was task solved on first run?
   */
  private collectFirstAttemptPass(input: MetricCollectorInput): boolean {
    return this.collectSuccess(input) && (input.workItemAttempts || 0) === 1;
  }

  /**
   * Collect recurrence: how many times this variant has been attempted historically
   */
  async collectRecurrence(input: MetricCollectorInput): Promise<number> {
    const result = await this.sql`
      SELECT COUNT(*) as count
      FROM iq_battery_metrics
      WHERE variant = ${input.variant}
    `;
    return (result?.[0]?.count as number) ?? 0;
  }

  /**
   * Collect escalation: did this task require human review?
   */
  private collectEscalation(input: MetricCollectorInput): boolean {
    return input.escalated || false;
  }

  /**
   * Collect recall-hit: did agent cite correct sources (semantic overlap)?
   */
  private collectRecallHit(input: MetricCollectorInput): number {
    if (!input.retrievedSources || !input.expectedSources) {
      return 0;
    }

    if (input.expectedSources.length === 0) {
      return input.retrievedSources.length === 0 ? 1.0 : 0.0;
    }

    // Compute Jaccard similarity: |intersection| / |union|
    const retrievedSet = new Set(input.retrievedSources);
    const expectedSet = new Set(input.expectedSources);

    const intersection = new Set(
      [...retrievedSet].filter((x) => expectedSet.has(x))
    );
    const union = new Set([...retrievedSet, ...expectedSet]);

    return union.size > 0 ? intersection.size / union.size : 0;
  }

  /**
   * Collect all seven metrics for a single run/case pair
   */
  async collectMetrics(input: MetricCollectorInput): Promise<IQBatteryMetrics> {
    const success = this.collectSuccess(input);
    const recurrence = await this.collectRecurrence(input);

    return {
      runId: input.runId,
      caseId: input.caseId,
      variant: input.variant,
      success,
      tokensPerSolvedTask: this.collectTokensPerSolvedTask(input),
      timeToGreenSecs: this.collectTimeToGreen(input),
      firstAttemptPass: this.collectFirstAttemptPass(input),
      recurrence,
      escalation: this.collectEscalation(input),
      recallHit: this.collectRecallHit(input),
    };
  }

  /**
   * Store metrics in the database
   */
  async storeMetrics(metrics: IQBatteryMetrics): Promise<void> {
    await this.sql`
      INSERT INTO iq_battery_metrics (
        run_id, case_id, variant, success, tokens_per_solved_task,
        time_to_green_secs, first_attempt_pass, recurrence, escalation,
        recall_hit, collected_at
      ) VALUES (
        ${metrics.runId}, ${metrics.caseId}, ${metrics.variant},
        ${metrics.success}, ${metrics.tokensPerSolvedTask},
        ${metrics.timeToGreenSecs}, ${metrics.firstAttemptPass},
        ${metrics.recurrence}, ${metrics.escalation}, ${metrics.recallHit},
        NOW()
      )
      ON CONFLICT (run_id, case_id) DO UPDATE SET
        success = EXCLUDED.success,
        tokens_per_solved_task = EXCLUDED.tokens_per_solved_task,
        time_to_green_secs = EXCLUDED.time_to_green_secs,
        first_attempt_pass = EXCLUDED.first_attempt_pass,
        recurrence = EXCLUDED.recurrence,
        escalation = EXCLUDED.escalation,
        recall_hit = EXCLUDED.recall_hit,
        collected_at = NOW()
    `;
  }
}

export async function createMetricsCollector(
  sql: postgres.Sql
): Promise<MetricsCollector> {
  return new MetricsCollector(sql);
}

/**
 * Aggregate metrics across runs for analysis
 */
export async function getMetricsSummary(
  sql: postgres.Sql,
  variant?: string
): Promise<unknown[]> {
  if (variant) {
    const result = await sql`
      SELECT
        variant,
        COUNT(*) FILTER (WHERE success) as success_count,
        COUNT(*) as total_count,
        ROUND(100.0 * COUNT(*) FILTER (WHERE success) / NULLIF(COUNT(*), 0), 2) as success_rate,
        ROUND(AVG(tokens_per_solved_task) FILTER (WHERE success), 1) as avg_tokens,
        ROUND(AVG(time_to_green_secs) FILTER (WHERE success), 2) as avg_time_secs,
        ROUND(100.0 * COUNT(*) FILTER (WHERE first_attempt_pass) / NULLIF(COUNT(*), 0), 2) as first_attempt_rate,
        ROUND(AVG(recurrence), 1) as avg_recurrence,
        ROUND(100.0 * COUNT(*) FILTER (WHERE escalation) / NULLIF(COUNT(*), 0), 2) as escalation_rate,
        ROUND(AVG(recall_hit), 3) as avg_recall_hit,
        MAX(collected_at) as last_collected
      FROM iq_battery_metrics
      WHERE variant = ${variant}
      GROUP BY variant
    `;
    return result;
  }

  const result = await sql`
    SELECT
      variant,
      COUNT(*) FILTER (WHERE success) as success_count,
      COUNT(*) as total_count,
      ROUND(100.0 * COUNT(*) FILTER (WHERE success) / NULLIF(COUNT(*), 0), 2) as success_rate,
      ROUND(AVG(tokens_per_solved_task) FILTER (WHERE success), 1) as avg_tokens,
      ROUND(AVG(time_to_green_secs) FILTER (WHERE success), 2) as avg_time_secs,
      ROUND(100.0 * COUNT(*) FILTER (WHERE first_attempt_pass) / NULLIF(COUNT(*), 0), 2) as first_attempt_rate,
      ROUND(AVG(recurrence), 1) as avg_recurrence,
      ROUND(100.0 * COUNT(*) FILTER (WHERE escalation) / NULLIF(COUNT(*), 0), 2) as escalation_rate,
      ROUND(AVG(recall_hit), 3) as avg_recall_hit,
      MAX(collected_at) as last_collected
    FROM iq_battery_metrics
    GROUP BY variant
  `;

  return result;
}

/**
 * Get percentile distribution of metrics
 */
export async function getMetricsPercentiles(
  sql: postgres.Sql,
  variant?: string
): Promise<unknown[]> {
  if (variant) {
    const result = await sql`
      SELECT
        variant,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY tokens_per_solved_task)
          FILTER (WHERE success) as p50_tokens,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY tokens_per_solved_task)
          FILTER (WHERE success) as p95_tokens,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY time_to_green_secs)
          FILTER (WHERE success) as p50_time_secs,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY time_to_green_secs)
          FILTER (WHERE success) as p95_time_secs,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY recall_hit) as p50_recall,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY recall_hit) as p95_recall
      FROM iq_battery_metrics
      WHERE variant = ${variant}
      GROUP BY variant
    `;
    return result;
  }

  const result = await sql`
    SELECT
      variant,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY tokens_per_solved_task)
        FILTER (WHERE success) as p50_tokens,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY tokens_per_solved_task)
        FILTER (WHERE success) as p95_tokens,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY time_to_green_secs)
        FILTER (WHERE success) as p50_time_secs,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY time_to_green_secs)
        FILTER (WHERE success) as p95_time_secs,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY recall_hit) as p50_recall,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY recall_hit) as p95_recall
    FROM iq_battery_metrics
    GROUP BY variant
  `;

  return result;
}
