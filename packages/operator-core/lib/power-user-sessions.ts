/**
 * power-user-sessions.ts — CRUD for `harness_shared.power_user_sessions`,
 * the revocation surface of the `workspace-power-user` auth tier.
 *
 * One row per active OMP power-user session. The refresh route joins
 * against this table; deleting or stamping `revoked_at` on a row stops
 * the refresh chain at the next refresh cycle. Access tokens issued
 * before revocation stay valid until their short TTL expires.
 *
 * The table is runtime-ensured (`ensurePowerUserSessionsTable`) rather
 * than drizzle-introspected, so this module uses the raw postgres-js
 * `sql` client instead of the typed `db` query builder.
 *
 * Server-only.
 */

import { getOrgPg } from '@papercusp/db-org';
import { newAuthSessionId } from './power-user-token';

export interface PowerUserSessionRow {
  authSessionId: string;
  workspaceId: string;
  userId: string;
  createdAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
}

/**
 * postgres-js returns `timestamptz` columns as JS `Date` (the org connection
 * customizes only `bigint→Number`, no timestamp parser — connection.ts), but the
 * row contract above is ISO-8601 strings. Normalize at the boundary so the
 * declared `string` type is honored (and a `Date | string` pool ever can't leak).
 */
function isoOrNull(v: Date | string | null): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

/** Open a new session row and return its freshly minted id. */
export async function createPowerUserSession(opts: {
  workspaceId: string;
  userId: string;
}): Promise<{ authSessionId: string }> {
  const { sql } = getOrgPg();
  const authSessionId = newAuthSessionId();
  await sql`
    INSERT INTO harness_shared.power_user_sessions
      (auth_session_id, workspace_id, user_id)
    VALUES (${authSessionId}, ${opts.workspaceId}, ${opts.userId})
  `;
  return { authSessionId };
}

/**
 * Returns the session row iff it exists and is not revoked, else null.
 * Side-effect: bumps `last_seen_at` so the (future) admin UI can show
 * session liveness. Call this from the refresh route before minting a
 * new access token.
 */
export async function getActivePowerUserSession(
  authSessionId: string,
): Promise<PowerUserSessionRow | null> {
  const { sql } = getOrgPg();
  const rows = await sql<
    Array<{
      auth_session_id: string;
      workspace_id: string;
      user_id: string;
      created_at: Date;
      last_seen_at: Date;
      revoked_at: Date | null;
    }>
  >`
    UPDATE harness_shared.power_user_sessions
       SET last_seen_at = now()
     WHERE auth_session_id = ${authSessionId}
       AND revoked_at IS NULL
    RETURNING auth_session_id, workspace_id, user_id,
              created_at, last_seen_at, revoked_at
  `;
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    authSessionId: r.auth_session_id,
    workspaceId: r.workspace_id,
    userId: r.user_id,
    createdAt: isoOrNull(r.created_at)!,
    lastSeenAt: isoOrNull(r.last_seen_at)!,
    revokedAt: isoOrNull(r.revoked_at),
  };
}

/** Stamp `revoked_at` — stops the refresh chain. Idempotent. */
export async function revokePowerUserSession(authSessionId: string): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    UPDATE harness_shared.power_user_sessions
       SET revoked_at = now()
     WHERE auth_session_id = ${authSessionId}
       AND revoked_at IS NULL
  `;
}

/**
 * Freshness window for the owner-present signal (flush-to-proceed-stretch-discipline-2026-07-04
 * P-004): a human power-user session whose last auth refresh (which bumps `last_seen_at` — see
 * getActivePowerUserSession) landed within this window counts the owner as PRESENT. The OMP/web
 * client refreshes its short-TTL access token on a periodic cadence while a human is logged in,
 * so a fresh `last_seen_at` is a MECHANICAL "the owner has a live authenticated session" signal —
 * not the message-provenance inference P-004 replaces. Generous enough (20 min) to bridge one
 * refresh gap without flapping "absent" while a human is still at the console.
 */
export const OWNER_PRESENCE_FRESH_MS = 20 * 60_000;

export interface OwnerPresence {
  /** A non-revoked power-user session refreshed within the freshness window exists. */
  present: boolean;
  /** ms since the most-recently-seen active session's last_seen_at (null when none exist). */
  lastSeenAgoMs: number | null;
  /** count of non-revoked sessions for the workspace. */
  activeSessions: number;
}

/**
 * owner-presence-human-turn-signal-2026-07-11 P-001: stamp the CLI/desktop
 * human-turn signal for a workspace (upsert one row/workspace, bumping
 * `last_human_turn_at` to now()). Called fire-and-forget from the
 * `/admin/owner-presence/touch` route, which the psu pty-host hits on every
 * human keystroke into an agent's terminal (onStdin) — the backend-agnostic
 * (claude/codex/omp) "the owner just drove a turn" signal that
 * `readOwnerPresence` folds in alongside the OMP/web token-refresh channel.
 * Idempotent and cheap. Never let a failure here break a turn — callers treat
 * it as fire-and-forget.
 */
export async function touchOwnerActivity(workspaceId: string): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    INSERT INTO harness_shared.owner_activity (workspace_id, last_human_turn_at)
    VALUES (${workspaceId}, now())
    ON CONFLICT (workspace_id)
      DO UPDATE SET last_human_turn_at = now()
  `;
}

/**
 * The mechanical owner-present read: is a human live for this workspace? PRESENT iff the owner
 * was seen within `freshMs` on EITHER channel — (a) a non-revoked power-user session's
 * `last_seen_at` (bumped by the OMP/web token-refresh chain — original P-004 signal), OR (b) a
 * `owner_activity.last_human_turn_at` human-turn stamp (owner-presence-human-turn-signal-2026-07-11:
 * the owner driving an agent over the CLI/desktop pty channel, which the refresh chain is blind
 * to). Presence keys off whichever channel saw the owner most recently. Used by coord:orient (and
 * any wake-time bootstrap) so presence-adaptive cadence keys off this signal instead of inferring
 * from who sent the last message. Injectable clock/window for tests.
 */
export async function readOwnerPresence(
  workspaceId: string,
  opts: { freshMs?: number; now?: number } = {},
): Promise<OwnerPresence> {
  const freshMs = opts.freshMs ?? OWNER_PRESENCE_FRESH_MS;
  const now = opts.now ?? Date.now();
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ last_seen_at: Date | string | null; n: string }>>`
    SELECT max(last_seen_at) AS last_seen_at, count(*)::text AS n
      FROM harness_shared.power_user_sessions
     WHERE workspace_id = ${workspaceId}
       AND revoked_at IS NULL
  `;
  const r = rows[0];
  const activeSessions = r?.n ? Number(r.n) : 0;

  // Fold in the CLI/desktop human-turn channel. Defensive: an operator that has not yet run the
  // boot ensure (no `owner_activity` table) must degrade to the session-only read, never throw —
  // this is a read on the orient hot path.
  let humanTurnMs: number | null = null;
  try {
    const ar = await sql<Array<{ last_human_turn_at: Date | string | null }>>`
      SELECT max(last_human_turn_at) AS last_human_turn_at
        FROM harness_shared.owner_activity
       WHERE workspace_id = ${workspaceId}
    `;
    const v = ar[0]?.last_human_turn_at ?? null;
    if (v != null) humanTurnMs = v instanceof Date ? v.getTime() : new Date(v).getTime();
  } catch {
    humanTurnMs = null;
  }

  const sessionMs = r?.last_seen_at
    ? r.last_seen_at instanceof Date
      ? r.last_seen_at.getTime()
      : new Date(r.last_seen_at).getTime()
    : null;

  // Presence keys off whichever channel saw the owner most recently.
  const newestMs =
    sessionMs == null
      ? humanTurnMs
      : humanTurnMs == null
        ? sessionMs
        : Math.max(sessionMs, humanTurnMs);
  if (newestMs == null) return { present: false, lastSeenAgoMs: null, activeSessions };
  const lastSeenAgoMs = now - newestMs;
  return { present: lastSeenAgoMs <= freshMs, lastSeenAgoMs, activeSessions };
}

/** Active (non-revoked) sessions for a workspace — for the v2 admin UI. */
export async function listActivePowerUserSessions(
  workspaceId: string,
): Promise<PowerUserSessionRow[]> {
  const { sql } = getOrgPg();
  const rows = await sql<
    Array<{
      auth_session_id: string;
      workspace_id: string;
      user_id: string;
      created_at: Date;
      last_seen_at: Date;
      revoked_at: Date | null;
    }>
  >`
    SELECT auth_session_id, workspace_id, user_id,
           created_at, last_seen_at, revoked_at
      FROM harness_shared.power_user_sessions
     WHERE workspace_id = ${workspaceId}
       AND revoked_at IS NULL
     ORDER BY created_at DESC
  `;
  return rows.map((r) => ({
    authSessionId: r.auth_session_id,
    workspaceId: r.workspace_id,
    userId: r.user_id,
    createdAt: isoOrNull(r.created_at)!,
    lastSeenAt: isoOrNull(r.last_seen_at)!,
    revokedAt: isoOrNull(r.revoked_at),
  }));
}
