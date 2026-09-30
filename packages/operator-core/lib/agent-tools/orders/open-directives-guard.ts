/**
 * open-directives-guard (EI-11484 P4) — the shared soft-block for surfaces that
 * END a re-injection surface (loop:end, fleet:wind-down): while OPEN owner
 * directives exist for the caller's workspace, the first call WARNS and
 * refuses; re-calling with the acknowledge flag proceeds. Mechanical, not
 * judgment: ending the loop is exactly the moment a still-open owner order
 * would lose its wake surface, so the guard makes that loss a conscious act.
 *
 * Fail-open by contract: a store read error must never wedge loop:end (you can
 * always stop a loop you armed) — a read miss returns null (no guard).
 */
import type { Sql } from 'postgres';
import {
  listOpenOwnerDirectives,
  countOpenOwnerDirectives,
  renderOwnerDirectiveRow,
  type OwnerDirectiveRow,
} from '../../owner-directives';

export interface OpenDirectivesGuardResult {
  ok: false;
  error: 'open_owner_directives';
  openCount: number;
  directives: string[];
  note: string;
}

export const OPEN_DIRECTIVES_ACK_ARG = 'acknowledgeOpenDirectives';

/** Pure assembly — unit-testable without PG. */
export function buildOpenDirectivesGuard(
  rows: ReadonlyArray<OwnerDirectiveRow>,
  totalOpen: number,
  action: string,
  nowMs: number = Date.now(),
): OpenDirectivesGuardResult | null {
  if (totalOpen <= 0 || rows.length === 0) return null;
  return {
    ok: false,
    error: 'open_owner_directives',
    openCount: totalOpen,
    directives: rows.map((r) => renderOwnerDirectiveRow(r, nowMs).trim()),
    note:
      `${totalOpen} OPEN owner directive(s) still awaiting disposition — ${action} removes a surface that ` +
      're-renders them every wake. Close each finished/refused one first via orders:disposition { id, status, ' +
      `note }, or re-call with ${OPEN_DIRECTIVES_ACK_ARG}: true to proceed anyway (they stay open and keep ` +
      'rendering at orient / post-compaction).',
  };
}

/**
 * The IO wrapper the tools call: null ⇒ proceed (none open, acknowledged, or
 * read failed). GUARD_MAX_ROWS rows are listed; the count covers the rest.
 */
export async function checkOpenDirectivesGuard(opts: {
  workspaceId: string | null | undefined;
  acknowledged: boolean | undefined;
  action: string;
  sql?: Sql;
  /** The session being guarded; rows it cleared off its own agenda do not block it. */
  viewerOwnerId?: string | null;
}): Promise<OpenDirectivesGuardResult | null> {
  if (opts.acknowledged || !opts.workspaceId) return null;
  try {
    const rows = await listOpenOwnerDirectives(opts.workspaceId, 5, opts.sql, opts.viewerOwnerId);
    if (!rows.length) return null;
    const totalOpen =
      rows.length >= 5
        ? await countOpenOwnerDirectives(opts.workspaceId, opts.sql, opts.viewerOwnerId).catch(() => rows.length)
        : rows.length;
    return buildOpenDirectivesGuard(rows, totalOpen, opts.action);
  } catch {
    return null; // fail-open: never wedge an end/wind-down on a store read
  }
}
