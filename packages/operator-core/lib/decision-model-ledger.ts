/**
 * The decision-model call ledger writer — plan jev-decision-model-integration-2026-09-29
 * P-003 (D-006). Table: harness_shared.decision_model_calls (migration 1246).
 *
 * Wired as the `onCall` observer of the process-wide decision client
 * (`ensureJevDecisionClient` in lib/memory/jev-settings.ts). The client fires the
 * observer after the outcome is known and never awaits it, so this write is off
 * the decision's critical path by construction.
 *
 * Failure contract: a failed insert is SWALLOWED and COUNTED, never thrown and
 * never logged to the console (a warning on every failed insert would trip
 * vitest-fail-on-console everywhere the client runs without this table — the
 * EI-496/EI-499 class the dispatch decision-ledger hit). The counters are the
 * signal: `decisionModelLedgerStats()`.
 *
 * What is stored is `toDecisionLedgerEntry(record)` from @papercusp/decision-model:
 * hashes, option order, probabilities, subject ids — never the judged text.
 */
import { getOrgPg } from '@papercusp/db-org';
import { toDecisionLedgerEntry, type DecisionCallRecord, type DecisionPricing } from '@papercusp/decision-model';
import { pinModuleState } from '@papercusp/module-singleton';
import { activeWorkspaceId } from './workspace-registry';

export interface DecisionModelLedgerStats {
  /** Rows written. */
  readonly written: number;
  /** Inserts that failed (the row is lost; the decision was unaffected). */
  readonly failed: number;
  /** Message of the most recent failure, for a health surface. */
  readonly lastError: string | null;
  readonly lastErrorAt: string | null;
}

const state = pinModuleState('@papercusp/operator-core.decision-model-ledger', () => ({
  written: 0,
  failed: 0,
  lastError: null as string | null,
  lastErrorAt: null as string | null,
}));

export function decisionModelLedgerStats(): DecisionModelLedgerStats {
  return { written: state.written, failed: state.failed, lastError: state.lastError, lastErrorAt: state.lastErrorAt };
}

export function __resetDecisionModelLedgerStatsForTest(): void {
  state.written = 0;
  state.failed = 0;
  state.lastError = null;
  state.lastErrorAt = null;
}

export interface RecordDecisionModelCallOptions {
  /** Defaults to the active workspace at write time. */
  readonly workspaceId?: string;
  /**
   * Token rates. The provider's response carries token counts but no price, so
   * cost_usd stays null without these. The Jev caller passes JEV_PRICING
   * (lib/memory/jev-settings.ts).
   */
  readonly pricing?: DecisionPricing;
}

/**
 * Insert one ledger row. Resolves `true` when written, `false` when the insert
 * failed (counted). Never rejects.
 */
export async function recordDecisionModelCall(
  record: DecisionCallRecord,
  options: RecordDecisionModelCallOptions = {},
): Promise<boolean> {
  try {
    const e = toDecisionLedgerEntry(record, { pricing: options.pricing });
    const workspaceId = options.workspaceId ?? activeWorkspaceId();
    const { sql } = getOrgPg();
    await sql`
      INSERT INTO harness_shared.decision_model_calls (
        workspace_id, consumer, provider, requested_model, returned_model,
        question_ids, questions_schema_sha256, option_order, answers,
        outcome, inconclusive_reason, inconclusive_detail, http_status,
        attempts, latency_ms, input_tokens, output_tokens, cost_usd,
        subject_ids, state_sha256, started_at, surface,
        loop_busy_ms, loop_utilization, transport_latency_ms
      ) VALUES (
        ${workspaceId}, ${e.consumer}, ${e.provider}, ${e.requestedModel}, ${e.returnedModel},
        ${sql.array([...e.questionIds])}, ${e.questionsSchemaSha256},
        ${sql.json(e.optionOrder as Record<string, string[]>)},
        ${e.answers === null ? null : sql.json(e.answers as unknown as Record<string, never>)},
        ${e.outcome}, ${e.inconclusiveReason}, ${e.inconclusiveDetail}, ${e.httpStatus},
        ${e.attempts}, ${e.latencyMs}, ${e.inputTokens}, ${e.outputTokens}, ${e.costUsd},
        ${sql.array([...e.subjectIds])}, ${e.stateSha256}, ${e.startedAt}, ${e.surface},
        ${e.loopBusyMs}, ${e.loopUtilization}, ${e.transportLatencyMs}
      )
    `;
    state.written += 1;
    return true;
  } catch (err) {
    state.failed += 1;
    state.lastError = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    state.lastErrorAt = new Date().toISOString();
    return false;
  }
}
