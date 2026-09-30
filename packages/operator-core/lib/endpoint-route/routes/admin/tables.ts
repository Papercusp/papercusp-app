/**
 * GET /api/admin/tables — list registered admin tables (the editable
 * allowlist managed by lib/admin-tables.ts).
 *
 * Ported from app/api/admin/tables/route.ts. `auth: 'public'`.
 */
import { listAdminTables } from '../../../admin-tables';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/admin/tables',
  // unverified-loopback: cookie-less desktop webview (EI-338) — the packaged
  // desktop app's TableAdmin pane bare-fetches this route from localhost with
  // no session cookie, so it only ever resolves 'unverified-loopback' trust.
  // Read-only listing of the admin-tables allowlist (EI-18834967602055309).
  auth: { trust: ['verified', 'trusted', 'unverified-loopback'] },
  handler() {
    const out = listAdminTables().map((e) => {
      const cfg = getTableConfig(e.table as unknown as PgTable);
      return {
        exportName: e.exportName,
        label: e.label,
        schema: cfg.schema,
        name: cfg.name,
        editableColumns: e.editableColumns ?? null,
        allowDelete: e.allowDelete ?? true,
      };
    });
    return Response.json({ tables: out });
  },
});
