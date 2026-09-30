/**
 * _workspace-guard.ts — workspace-data-isolation-leaks-2026-06-17 F-M7.
 *
 * ui_intents/tui_intents key on client_id alone (no workspace column); ui_clients carries
 * workspace_id. When papercusp-ui-workspace-guard is ON, ui:dispatch / ui:get_state /
 * tui:dispatch must refuse a target client that belongs to a DIFFERENT workspace than the
 * caller's active one — so a dispatch/read can't cross a workspace boundary. These tools are
 * SU-only, so this is a guard rail (low exploitability); the flag defaults OFF, in which case
 * the check is skipped entirely (byte-identical to today).
 */
import { getOrgPg } from '@papercusp/db-org';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { activeWorkspaceId } from '../../workspace-registry';
import { systemDistinctId } from '../../flag-distinct-id';

/**
 * Returns an error message when the flag is ON and `clientId` belongs to a different
 * workspace than the caller's active one; otherwise null (allow). Fail-open: any lookup
 * error returns null (never blocks a legitimate dispatch on infra trouble).
 */
export async function uiCrossWorkspaceBlock(clientId: string): Promise<string | null> {
  let on = false;
  try {
    on = await getFlag(FLAGS.UI_WORKSPACE_GUARD, systemDistinctId());
  } catch {
    on = false;
  }
  if (!on) return null;
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ workspace_id: string }[]>`
      SELECT workspace_id FROM harness_shared.ui_clients WHERE client_id = ${clientId} LIMIT 1
    `;
    const clientWs = rows[0]?.workspace_id;
    const active = activeWorkspaceId();
    if (clientWs && clientWs !== active) {
      return `cross_workspace_client: client_id=${clientId} belongs to workspace '${clientWs}', not the active workspace '${active}'. Scope to that workspace to act on its UI.`;
    }
  } catch {
    return null; // fail-open
  }
  return null;
}
