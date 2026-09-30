/**
 * PG-backed audit writer for plugin action invocations. Replaces the
 * in-memory writer in operator hosts so audit rows survive restarts and
 * can be queried from the audit panel UI.
 *
 * Rust-port-feedback items 6 + 9 + 11. Pairs with the host's "fail
 * closed" behavior: if the audit write fails, the action invocation is
 * rejected — a plugin that ran but isn't audited is worse than one that
 * didn't run.
 */

import type { AuditRow, AuditWriter } from '@papercusp/plugin-loader';
import { getOrgPg } from '@papercusp/db-org';

// The `plugin_audit_log` table is defined by migration
// `137-plugin-audit-log.sql` (schema = migrations only; NO runtime DDL).
// It used to be created lazily here via `ensureTable()` `CREATE TABLE IF NOT
// EXISTS`, but the invoke path is fail-closed on the audit write, and that
// runtime CREATE needs a privilege the least-privilege ship role lacks — so
// it failed every plugin action on a non-superuser role. See
// revive-plugin-system-2026-06-04 D-001.

export class PgAuditWriter implements AuditWriter {
  /** Resolves on success; throws on failure so the host can fail-closed. */
  async write(row: AuditRow): Promise<void> {
    const { sql } = getOrgPg();
    await sql`
      INSERT INTO harness_shared.plugin_audit_log
        (ts, plugin_name, install_slug, action_name, trigger_source, trigger_id,
         params_json, outcome, duration_ms, error_message, capabilities_used,
         killed_by_timeout, stdout_bytes, stderr_bytes, truncated)
      VALUES
        (to_timestamp(${row.ts / 1000}), ${row.pluginName}, ${row.installSlug},
         ${row.actionName}, ${row.triggerSource}, ${row.triggerId},
         ${JSON.stringify(row.params ?? null)}::text::jsonb, ${row.outcome}, ${row.durationMs},
         ${row.errorMessage ?? null}, ${row.capabilitiesUsed ?? null},
         ${row.killedByTimeout ?? null}, ${row.stdoutBytes ?? null},
         ${row.stderrBytes ?? null}, ${row.truncated ?? null})
    `;
  }
}
