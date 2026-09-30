/**
 * Run-outcome derivation for the Harnesses-tab DetailPanel "Recent activity"
 * rows (adv-harness-tab-migration-2026-05-30 P-023).
 *
 * The consolidated run row carries the spawn outcome joined from
 * harness_shared.spawned_agents (sync-resolver `agentRunsConsolidated.*`):
 * `spawnStatus` (running|done|failed|cancelled|reaped|restarting), `exitCode`,
 * `errorMessage`. Rows that predate the spawn engine carry nulls — for those
 * the only signal is the consolidated `running` flag, and a *finished* legacy
 * run gets NO outcome chip (we don't know how it ended; don't invent one).
 *
 * Pure + standalone (no React) so the mapping is unit-tested without mounting
 * the panel — same seam style as ./harness-axis.ts.
 */

export interface RunOutcomeInput {
  running?: boolean | null;
  spawnStatus?: string | null;
  exitCode?: number | null;
  errorMessage?: string | null;
}

export interface RunOutcome {
  /** Styling bucket for the chip. */
  kind: 'running' | 'done' | 'failed' | 'cancelled' | 'muted';
  /** Short chip label. */
  label: string;
  /** Optional detail for the tooltip — error message, when one exists. */
  detail?: string;
}

export function runOutcome(r: RunOutcomeInput): RunOutcome | null {
  const status = r.spawnStatus?.trim() || null;
  const error = r.errorMessage?.trim() || undefined;
  switch (status) {
    case 'done':
      return { kind: 'done', label: 'done' };
    case 'failed': {
      const exit = r.exitCode != null && r.exitCode !== 0 ? ` (exit ${r.exitCode})` : '';
      return { kind: 'failed', label: `failed${exit}`, detail: error };
    }
    case 'cancelled':
      return { kind: 'cancelled', label: 'cancelled', detail: error };
    case 'reaped':
      // Reaped = the supervisor swept a dead spawn; outcome unknown, show muted.
      return { kind: 'muted', label: 'reaped', detail: error };
    case 'running':
    case 'restarting':
      return { kind: 'running', label: status };
    default:
      // No spawn row (legacy / pre-engine run): the consolidated `running`
      // flag is the only live signal; a finished legacy run renders no chip.
      return r.running ? { kind: 'running', label: 'running' } : null;
  }
}
