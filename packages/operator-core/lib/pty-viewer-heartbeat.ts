/**
 * pty-viewer-heartbeat.ts — the cross-process "a human is CURRENTLY viewing this
 * agent session's terminal in the operator web/Tauri PTY panel" signal, so the
 * idle-session reaper never SIGKILLs a session a user is actively watching even
 * when it has NO OS window. This is the explicitly-deferred sibling of the
 * wmctrl-based on-desktop exemption (desktop-window-liveness.ts +
 * agent-insights/on-desktop-sessions-reaper-exemption, owner decision 2026-06-29):
 * on-desktop covers console/terminal-window launches; THIS covers the panel-viewed
 * case those can't see.
 *
 * WHY a DB table (migration 410), not in-memory: the PTY WebSocket server runs IN
 * the :3070 operator process (a per-process in-memory pty registry), but the reaper
 * runs on the SEPARATE bg-host (executor bg-host-3270). So the attach state must be
 * PERSISTED for the reaper to read it cross-process. Keyed by pty_id (one row per
 * live viewer connection) carrying owner_sid (the coord owner — PtyHandle.ownerSid
 * = PAPERCUSP_SID — that the reaper protects by). Multiple PTYs/viewers per owner
 * each get a row, so one viewer detaching never clears another's protection; the
 * reader's TTL (3x the pty-ws 30s ping) expires an ungraceful disconnect.
 *
 * Best-effort throughout: every write is fire-and-forget and the read fails to an
 * EMPTY set, so a DB hiccup (or the table not yet migrated) can only ever make the
 * reaper MORE conservative (over-protect) — it can NEVER crash the socket, block a
 * pong, or cause an extra kill.
 */
import { getOrgPg } from '@papercusp/db-org';

/** Freshness window: a viewer row older than this is treated as detached. 3x the
 *  pty-ws keepalive ping (PING_INTERVAL_MS = 30s), so a still-attached viewer
 *  (refreshed each pong) stays fresh, while a dropped one (terminate()d after two
 *  missed pongs ≈ 60s → ws close → row deleted) expires within ~90s even if the
 *  close handler never ran. */
export const VIEWER_ATTACH_TTL_MS = 90 * 1000;

/** Record a viewer attaching to a pty (upsert — a reconnect on the same pty_id just
 *  refreshes). No-op when ownerSid is unknown: without a coord owner there is
 *  nothing for the reaper to protect by. Best-effort → swallow. */
export async function recordViewerAttached(ptyId: string, ownerSid: string | null): Promise<void> {
  if (!ownerSid) return;
  try {
    const { sql } = getOrgPg();
    await sql`
      INSERT INTO harness_shared.pty_viewer_heartbeats (pty_id, owner_sid, viewer_attached_at)
      VALUES (${ptyId}, ${ownerSid}, now())
      ON CONFLICT (pty_id)
      DO UPDATE SET owner_sid = EXCLUDED.owner_sid, viewer_attached_at = now()`;
  } catch {
    /* best-effort: a viewer signal must never break the socket */
  }
}

/** Refresh the heartbeat for a live viewer connection (called on each WS pong).
 *  Best-effort → swallow. */
export async function refreshViewerAttached(ptyId: string): Promise<void> {
  try {
    const { sql } = getOrgPg();
    await sql`
      UPDATE harness_shared.pty_viewer_heartbeats
         SET viewer_attached_at = now()
       WHERE pty_id = ${ptyId}`;
  } catch {
    /* best-effort */
  }
}

/** Drop the viewer row on WS close. Best-effort → swallow (the TTL would expire it
 *  anyway, so a failed delete only delays the exemption dropping). */
export async function clearViewerAttached(ptyId: string): Promise<void> {
  try {
    const { sql } = getOrgPg();
    await sql`DELETE FROM harness_shared.pty_viewer_heartbeats WHERE pty_id = ${ptyId}`;
  } catch {
    /* best-effort */
  }
}

/**
 * The coord owners with a viewer attached within the TTL — the reaper folds these
 * into its protected (slice 1/3) AND busy (slice 2 live-idle) sets, hard-exempting
 * them exactly like on-desktop owners. Best-effort → EMPTY set (a missing table /
 * DB error reads as "nobody is viewing", so the reaper behaves as before).
 */
export async function gatherViewerAttachedOwners(ttlMs: number = VIEWER_ATTACH_TTL_MS): Promise<Set<string>> {
  try {
    const { sql } = getOrgPg();
    const ttlSec = Math.max(1, Math.round(ttlMs / 1000));
    const rows = await sql<Array<{ owner_sid: string }>>`
      SELECT DISTINCT owner_sid
        FROM harness_shared.pty_viewer_heartbeats
       WHERE owner_sid IS NOT NULL
         AND owner_sid <> ''
         AND viewer_attached_at > now() - make_interval(secs => ${ttlSec})`;
    return new Set(rows.map((r) => r.owner_sid));
  } catch {
    return new Set<string>();
  }
}
