/**
 * Prompt-composition telemetry — async PG sink for per-invoke prompt
 * size breakdowns.
 *
 * Architectural rule (see docs/MEMORY_AND_CACHE.md): the log line emitted
 * synchronously at the call site is the *transport*; this PG row is the
 * *persistence*. We don't poll PG to learn what happened; the log line
 * already streamed. PG enables historical queries — "did substrate
 * size grow over the last week?" / "which features are blowing the
 * cap?" — that an in-memory log can't.
 */
import type { OrchestratorPg } from './invoke';

export interface PromptCompositionRow {
  workspaceId: string;
  harnessSlug: string;
  featureId: string | null;
  role: string;
  runId: string;
  totalChars: number;
  substrateChars: number;
  historyChars: number;
  /** Optional per-section breakdown; NULL when buildPrompt didn't expose them. */
  rolePromptChars?: number;
  memoryChars?: number;
  identityChars?: number;
  runtimeChars?: number;
}

/**
 * Best-effort fire-and-forget INSERT. Caller does NOT await this —
 * any failure is silently swallowed. The log line at the call site
 * is the durable transport for "did the invoke happen with what
 * sizes"; this row only adds queryability.
 */
export function recordPromptComposition(
  pg: OrchestratorPg,
  row: PromptCompositionRow,
): void {
  // Don't await; don't surface errors.
  void (async () => {
    try {
      await pg`
        INSERT INTO harness_shared.prompt_compositions
          (workspace_id, harness_slug, feature_id, role, run_id, ts_ms,
           total_chars, substrate_chars, history_chars,
           role_prompt_chars, memory_chars, identity_chars, runtime_chars)
        VALUES
          (${row.workspaceId}, ${row.harnessSlug}, ${row.featureId},
           ${row.role}, ${row.runId}, ${Date.now()},
           ${row.totalChars}, ${row.substrateChars}, ${row.historyChars},
           ${row.rolePromptChars ?? null}, ${row.memoryChars ?? null},
           ${row.identityChars ?? null}, ${row.runtimeChars ?? null})
      `;
    } catch {
      // Best-effort. The log line at the call site is the durable
      // record; PG persistence is a nice-to-have for the operator UI.
    }
  })();
}
