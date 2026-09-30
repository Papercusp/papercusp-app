/**
 * Audit-log writer for plugin action invocations.
 *
 * Every invocation produces one row capturing trigger source, action,
 * params, outcome, capabilities used, and timing. The CLI uses
 * `InMemoryAuditWriter` (rows are kept process-local, optionally dumped via
 * `PAPERCUSP_INVOKE_AUDIT=1`); the operator can swap in a Postgres-backed
 * writer (TODO v1.1) for cross-restart durability.
 */

export interface AuditRow {
  ts: number;
  pluginName: string;
  installSlug: string;
  actionName: string;
  triggerSource: 'cli' | 'ui' | 'mission-done' | 'webhook' | 'api';
  triggerId: string;
  params: unknown;
  outcome: 'ok' | 'error' | 'timeout' | 'capability-denied';
  durationMs: number;
  errorMessage?: string;
  /**
   * Subset of capabilities the plugin actually consulted during this
   * action. Populated for spawn + a few other gated host calls; empty
   * array when the action is pure compute. Rust-port-feedback item 6.
   */
  capabilitiesUsed?: string[];
  /**
   * Spawn-specific fields — populated only when the audit row is for a
   * `ctx.spawn` invocation. Lets the operator audit panel surface
   * "killed by timeout" or "output truncated" without parsing logs.
   * Rust-port-feedback item 11.
   */
  killedByTimeout?: boolean;
  stdoutBytes?: number;
  stderrBytes?: number;
  truncated?: boolean;
}

export interface AuditWriter {
  write(row: AuditRow): Promise<void> | void;
}

export class InMemoryAuditWriter implements AuditWriter {
  private rows: AuditRow[] = [];

  write(row: AuditRow): void {
    this.rows.push(row);
  }

  rowsForInspection(): AuditRow[] {
    return this.rows.slice();
  }

  clear(): void {
    this.rows = [];
  }
}
