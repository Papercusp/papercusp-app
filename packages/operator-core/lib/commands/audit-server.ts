/**
 * Server-only audit init. Imported by API routes (run-command, etc.) at
 * module load — registers the PG flush callback so subsequent
 * `audit()` calls actually persist. Idempotent.
 *
 * IMPORTANT: do NOT import this from any file that ends up in the client
 * bundle. The audit-writer pulls `postgres` which has node-only `fs`/`os`
 * imports that fail under Turbopack's client tree-shake.
 */

import { registerAuditFlush } from './audit';
import { writeAuditRows } from './audit-writer';

let registered = false;
export function ensureAuditServer(): void {
  if (registered) return;
  registered = true;
  registerAuditFlush(async (actions, queries) => {
    await writeAuditRows(actions, queries);
  });
}

// Auto-register on import (server-only; never reaches the browser).
ensureAuditServer();
