/**
 * admin-tables — registry of drizzle tables that can be edited via the
 * generic `/api/admin/[table]` CRUD factory (Unlock 3).
 *
 * Tables NOT in this allowlist are refused; this prevents accidental
 * write access to operationally sensitive tables (e.g. `token_index`,
 * `voice_lease`) via the same admin surface used for editing tiers and
 * settings. Every entry declares:
 *
 *   - the table (the drizzle export from `@papercusp/db-org`)
 *   - the PK column(s) used to identify a row for PATCH/DELETE
 *   - an optional `editableColumns` filter — if present, only those
 *     columns are accepted on POST/PATCH bodies (others are stripped)
 *   - an optional `label` for the admin UI
 *
 * Plugins extend this registry at boot via `registerAdminTable()` so
 * a plugin's owned tables get an admin page without bespoke UI code.
 */
import { generated } from '@papercusp/db-org';
import type { Table } from 'drizzle-orm';

export interface AdminTableEntry {
  exportName: string;
  table: Table;
  label: string;
  /** Columns the user can set; others stripped from body. Default: all. */
  editableColumns?: readonly string[];
  /** Allow row deletion? Default: true. */
  allowDelete?: boolean;
}

const REGISTRY = new Map<string, AdminTableEntry>();

export function registerAdminTable(entry: AdminTableEntry): void {
  REGISTRY.set(entry.exportName, entry);
}

export function getAdminTable(exportName: string): AdminTableEntry | null {
  return REGISTRY.get(exportName) ?? null;
}

export function listAdminTables(): AdminTableEntry[] {
  return [...REGISTRY.values()].sort((a, b) => a.label.localeCompare(b.label));
}

// First-party admin tables — the same set that today has bespoke
// one-off admin pages. New plugins call registerAdminTable from their
// boot hook.
registerAdminTable({
  exportName: 'operatorBudgetTiersInHarnessShared',
  table: generated.operatorBudgetTiersInHarnessShared,
  label: 'Papercup budget tiers',
  editableColumns: ['ord', 'label', 'cap_usd', 'blurb'],
});

registerAdminTable({
  exportName: 'operatorSettingsInHarnessShared',
  table: generated.operatorSettingsInHarnessShared,
  label: 'Papercup settings',
  editableColumns: ['key', 'value', 'description'],
});

registerAdminTable({
  exportName: 'hiddenPluginsInHarnessShared',
  table: generated.hiddenPluginsInHarnessShared,
  label: 'Hidden plugins',
  editableColumns: ['basename', 'reason', 'hidden_by', 'workspace_id'],
});
