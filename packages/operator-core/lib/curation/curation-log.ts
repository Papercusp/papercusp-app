/**
 * Curation dedup-memory — the curator-operator's "already surfaced" record
 * (plan `curator-operator-2026-06-04`, P0).
 *
 * Backs the salience policy's idempotency overlay: a `FleetSignal` whose id is
 * here (within the window) is suppressed so the operator doesn't re-nag the
 * SAME fact every tick. PG-backed (`harness_shared.operator_curation_log`,
 * migration 150) so it's multi-tab / cross-machine safe, mirroring
 * the old operator-dismissed-cache (retired with the scanner, D-005).
 *
 * This is de-dup memory, NOT a suppression list — a NEW escalation/blocker is
 * always surfaced (it just won't repeat). The raw item is always reachable via
 * the coord inbox + the drill-in `ref` (D-005).
 */
import { withWorkspace } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';

/** How far back "already surfaced" looks. Beyond this, a still-relevant signal
 *  may re-surface as a reminder (the source still emits it). */
export const DEFAULT_SURFACED_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h

export interface SurfacedEntry {
  /** The FleetSignal id that was surfaced/batched. */
  id: string;
  /** The signal kind (for audit / the reactive-graph view). */
  kind: string;
  /** The signal's title at surface-time (P-003: backs the recovery diff — a
   *  `cleared:<id>` line needs the ORIGINAL title, and the source row that
   *  produced it may already be gone by the time it clears). Optional so
   *  callers that don't care about recovery (or don't have a title) still
   *  compile; a NULL title just means the eventual cleared-line has none. */
  title?: string;
}

/**
 * The set of signal ids surfaced within `windowMs`. Passed to the salience
 * policy as `SalienceState.alreadySurfaced`.
 */
export async function loadRecentSurfaced(
  windowMs: number = DEFAULT_SURFACED_WINDOW_MS,
): Promise<Set<string>> {
  const workspaceId = activeWorkspaceId();
  const cutoffMs = Math.max(1, Math.floor(windowMs));
  const rows = await withWorkspace(workspaceId, async (tx) => {
    return tx<{ signal_id: string }[]>`
      SELECT signal_id
        FROM harness_shared.operator_curation_log
       WHERE workspace_id = ${workspaceId}
         AND surfaced_at > now() - (${cutoffMs}::bigint * interval '1 millisecond')
    `;
  });
  return new Set(rows.map((r) => r.signal_id));
}

/**
 * Record that these signals were surfaced/batched this tick. Idempotent upsert
 * (re-surfacing refreshes `surfaced_at`). `policyVersion` is stamped for the
 * "why did this surface?" audit.
 */
export async function recordSurfaced(
  entries: readonly SurfacedEntry[],
  policyVersion: string,
): Promise<void> {
  if (entries.length === 0) return;
  const workspaceId = activeWorkspaceId();
  await withWorkspace(workspaceId, async (tx) => {
    for (const e of entries) {
      await tx`
        INSERT INTO harness_shared.operator_curation_log
          (workspace_id, signal_id, kind, policy_version, title, surfaced_at)
        VALUES (${workspaceId}, ${e.id}, ${e.kind}, ${policyVersion}, ${e.title ?? null}, now())
        ON CONFLICT (workspace_id, signal_id) DO UPDATE
          SET surfaced_at = EXCLUDED.surfaced_at,
              kind = EXCLUDED.kind,
              policy_version = EXCLUDED.policy_version,
              title = EXCLUDED.title
      `;
    }
  });
}

/** A previously-surfaced recoverable (escalation/blocker-kind) signal that has
 *  not yet had a corresponding `cleared:<id>` recorded SINCE it last
 *  surfaced. Backs P-003 (recovery close-the-loop): the curation loop diffs
 *  this set against the current gather to find what just disappeared. */
export interface OpenRecoverableEntry {
  id: string;
  kind: string;
  title: string | null;
}

/** Kinds treated as "recoverable" (D-004 always-surface, never-batch kinds
 *  whose disappearance is worth a "✓ cleared" line). Health-panel `crit`
 *  signals (P-002) map to kind 'blocker', so they fall in here for free. */
export const RECOVERABLE_KINDS: readonly string[] = ['escalation', 'blocker'];

/**
 * Rows of a recoverable kind that are still considered OPEN: they were
 * surfaced, and either no `cleared:<id>` row exists yet, or the last clear
 * predates the row's own last surface (i.e. it re-surfaced since — a genuine
 * reopen, not a flap). This is the flap guard (D-002 stable-id contract +
 * plan P-003): once `cleared:<id>` is recorded, the SAME id will not be
 * re-offered as "open" again until it is freshly re-surfaced (a strictly
 * later `surfaced_at`), so a rapid disappear/reappear/disappear cycle can
 * only ever emit ONE cleared line per genuine re-surface.
 */
export async function loadOpenRecoverable(
  kinds: readonly string[] = RECOVERABLE_KINDS,
  limit = 200,
): Promise<OpenRecoverableEntry[]> {
  if (kinds.length === 0) return [];
  const workspaceId = activeWorkspaceId();
  const cap = Math.max(1, Math.min(limit, 1000));
  const rows = await withWorkspace(workspaceId, async (tx) => {
    return tx<{ signal_id: string; kind: string; title: string | null }[]>`
      SELECT o.signal_id, o.kind, o.title
        FROM harness_shared.operator_curation_log o
       WHERE o.workspace_id = ${workspaceId}
         AND o.kind = ANY(${kinds}::text[])
         AND NOT EXISTS (
           SELECT 1 FROM harness_shared.operator_curation_log c
            WHERE c.workspace_id = o.workspace_id
              AND c.signal_id = 'cleared:' || o.signal_id
              AND c.surfaced_at >= o.surfaced_at
         )
       ORDER BY o.surfaced_at DESC
       LIMIT ${cap}
    `;
  });
  return rows.map((r) => ({ id: r.signal_id, kind: r.kind, title: r.title }));
}

/** Diagnostic: recent curation-log rows (newest first), for the audit view. */
export async function listRecentCuration(limit = 50): Promise<
  { id: string; kind: string; policyVersion: string; surfacedAt: string }[]
> {
  const workspaceId = activeWorkspaceId();
  const cap = Math.max(1, Math.min(limit, 500));
  const rows = await withWorkspace(workspaceId, async (tx) => {
    return tx<{ signal_id: string; kind: string; policy_version: string; surfaced_at: string }[]>`
      SELECT signal_id, kind, policy_version, surfaced_at::text
        FROM harness_shared.operator_curation_log
       WHERE workspace_id = ${workspaceId}
       ORDER BY surfaced_at DESC
       LIMIT ${cap}
    `;
  });
  return rows.map((r) => ({
    id: r.signal_id,
    kind: r.kind,
    policyVersion: r.policy_version,
    surfacedAt: new Date(r.surfaced_at).toISOString(),
  }));
}
