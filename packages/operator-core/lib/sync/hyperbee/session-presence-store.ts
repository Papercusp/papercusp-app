/**
 * session-presence-store — the `harness_shared.shared_session_presence` writer
 * + TTL reader (cross-machine-coord-parity-and-trust-2026-07-01 P-005, mig 434).
 *
 * GOSSIP-ONLY surface: written by presence-gossip 'sessions' frames (remote
 * devices) and by the local announcer's self-apply (so this machine sees its
 * own sessions through the same table the roster merges). Never rides the
 * peer-log (plan D-002 — beats must not be immortalized).
 *
 * FULL-SET REPLACE semantics: one frame carries a device's WHOLE current
 * session set, so applying it upserts every entry and deletes the device's
 * rows NOT in the set — self-healing against missed frames, no per-session
 * tombstones needed. A stale frame (frameTs older than a device row's
 * last_seen_at) never regresses newer state: upserts are last_seen_at-guarded
 * and the not-in-set delete only removes rows older than the frame.
 */

import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import type { SessionPresenceEntry } from './presence-gossip';

export interface ApplySessionSetInput {
  workspaceId: string;
  devicePubkey: string;
  githubUserId: number;
  machineLabel: string;
  potSlug: string | null;
  sessions: SessionPresenceEntry[];
  /** The frame's ts (epoch ms) — the set's coherence point. */
  frameTs: number;
}

/**
 * WI-10002534 — a row whose CONTENT is unchanged is not rewritten until it is at
 * least this old. Senders re-announce an unchanged set every ~30s (keep-alive) and
 * the roster's staleness window is minutes, so skipping a same-content beat younger
 * than this never ages a live session out; it only absorbs duplicate frames.
 * Measured on the P-203 rig: one tower sent ~39 identical full-set frames per 10s
 * tick, and this writer rewrote every row for each (one statement per row).
 */
export const SESSION_ROW_REFRESH_FLOOR_MS = 15_000;

/** Replace one device's session-presence set (upsert entries + drop absentees). */
export async function applySessionPresenceSet(
  input: ApplySessionSetInput,
  sqlIn?: postgres.Sql,
): Promise<void> {
  const sql = sqlIn ?? getOrgPg().sql;
  // One row per owner: a frame naming the same owner twice would otherwise abort
  // the batched upsert ("ON CONFLICT DO UPDATE command cannot affect row a second
  // time"). Last entry wins, as it did when each entry was its own statement.
  const byOwner = new Map<string, SessionPresenceEntry>();
  for (const s of input.sessions) byOwner.set(s.owner_id, s);
  const keep = [...byOwner.keys()];
  if (keep.length > 0) {
    const rows = [...byOwner.values()].map((s) => ({
      owner_id: s.owner_id,
      harness_slug: s.harness_slug,
      kind: s.kind,
      intent: s.intent ?? null,
      plan_slug: s.plan_slug ?? null,
      fleet_slug: s.fleet_slug ?? null,
      fleet_role: s.fleet_role ?? null,
    }));
    // ONE statement for the whole set. harness_slug is deliberately NOT part of the
    // change test: it is a sender-declared label outside the key, and pre-fix
    // senders stamp a different one on each duplicate frame. A label-only change
    // lands at the next refresh-floor rewrite.
    await sql`
      INSERT INTO harness_shared.shared_session_presence
        (workspace_id, pot_slug, harness_slug, owner_id, kind, intent, plan_slug,
         github_user_id, machine_label, device_pubkey, last_seen_at, schema_version,
         fleet_slug, fleet_role)
      SELECT ${input.workspaceId}::text, ${input.potSlug}::text, s.harness_slug, s.owner_id,
             s.kind, s.intent, s.plan_slug, ${input.githubUserId}::bigint,
             ${input.machineLabel}::text, ${input.devicePubkey}::text,
             to_timestamp(${input.frameTs} / 1000.0), 1,
             s.fleet_slug, s.fleet_role
      -- ::text first: a param the server types as jsonb is JSON-encoded AGAIN by
      -- postgres.js, turning the array into a scalar string.
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::text::jsonb) AS s(
        owner_id text, harness_slug text, kind text, intent text, plan_slug text,
        fleet_slug text, fleet_role text)
      ON CONFLICT (workspace_id, owner_id, machine_label) DO UPDATE SET
        pot_slug = EXCLUDED.pot_slug,
        harness_slug = EXCLUDED.harness_slug,
        kind = EXCLUDED.kind,
        intent = EXCLUDED.intent,
        plan_slug = EXCLUDED.plan_slug,
        github_user_id = EXCLUDED.github_user_id,
        device_pubkey = EXCLUDED.device_pubkey,
        last_seen_at = EXCLUDED.last_seen_at,
        fleet_slug = EXCLUDED.fleet_slug,
        fleet_role = EXCLUDED.fleet_role
      -- Never regress a newer beat with an out-of-order stale frame…
      WHERE shared_session_presence.last_seen_at <= EXCLUDED.last_seen_at
        -- …and skip a same-content rewrite until the row reaches the refresh floor.
        AND (
          (shared_session_presence.pot_slug, shared_session_presence.kind,
           shared_session_presence.intent, shared_session_presence.plan_slug,
           shared_session_presence.github_user_id, shared_session_presence.device_pubkey,
           shared_session_presence.fleet_slug, shared_session_presence.fleet_role)
            IS DISTINCT FROM
          (EXCLUDED.pot_slug, EXCLUDED.kind, EXCLUDED.intent, EXCLUDED.plan_slug,
           EXCLUDED.github_user_id, EXCLUDED.device_pubkey,
           EXCLUDED.fleet_slug, EXCLUDED.fleet_role)
          OR shared_session_presence.last_seen_at
               <= to_timestamp(${input.frameTs - SESSION_ROW_REFRESH_FLOOR_MS} / 1000.0)
        )
    `;
  }
  // Drop this device's rows absent from the set — but only rows OLDER than the
  // frame (an out-of-order stale frame must not delete a newer session row).
  // An empty set clears everything older ("all my agents ended").
  if (keep.length > 0) {
    await sql`
      DELETE FROM harness_shared.shared_session_presence
      WHERE workspace_id = ${input.workspaceId}
        AND device_pubkey = ${input.devicePubkey}
        AND machine_label = ${input.machineLabel}
        AND last_seen_at <= to_timestamp(${input.frameTs} / 1000.0)
        AND owner_id NOT IN ${sql(keep)}
    `;
  } else {
    await sql`
      DELETE FROM harness_shared.shared_session_presence
      WHERE workspace_id = ${input.workspaceId}
        AND device_pubkey = ${input.devicePubkey}
        AND machine_label = ${input.machineLabel}
        AND last_seen_at <= to_timestamp(${input.frameTs} / 1000.0)
    `;
  }
}

export interface SessionPresenceRowOut {
  workspace_id: string;
  pot_slug: string | null;
  harness_slug: string;
  owner_id: string;
  kind: string;
  intent: string | null;
  plan_slug: string | null;
  github_user_id: number;
  machine_label: string;
  device_pubkey: string;
  /** epoch ms */
  last_seen_ms: number;
  /** The remote session's named-fleet membership (mig 479, P-301). Null for a
   *  session in no fleet / a pre-mig-479 frame. */
  fleet_slug?: string | null;
  fleet_role?: string | null;
}

/** Live (within staleMs) session-presence rows, optionally hive-scoped —
 *  the unified roster's federated session leg (P-006). */
export async function listLiveSessionPresence(
  opts: {
    workspaceId: string;
    potSlug?: string | null;
    staleMs: number;
    nowMs?: number;
    ownerIds?: readonly string[];
  },
  sqlIn?: postgres.Sql,
): Promise<SessionPresenceRowOut[]> {
  const sql = sqlIn ?? getOrgPg().sql;
  const now = opts.nowMs ?? Date.now();
  const floor = new Date(now - opts.staleMs);
  const ownerIds = [...new Set((opts.ownerIds ?? []).filter((ownerId) => ownerId.length > 0))];
  const ownerFilter =
    ownerIds.length === 0
      ? sql``
      : sql`
       AND (
         owner_id = ANY(${ownerIds}::text[])
         OR EXISTS (
           SELECT 1
             FROM unnest(${ownerIds}::text[]) AS requested(owner)
            WHERE strpos(owner_id, requested.owner) > 0
               OR strpos(requested.owner, owner_id) > 0
               OR strpos(kind || ' · ' || left(owner_id, 8) || ' @ ' || machine_label, requested.owner) > 0
               OR strpos(requested.owner, kind || ' · ' || left(owner_id, 8) || ' @ ' || machine_label) > 0
         )
       )`;
  const rows = await sql<
    Array<Omit<SessionPresenceRowOut, 'last_seen_ms'> & { last_seen_at: Date }>
  >`
    SELECT workspace_id, pot_slug, harness_slug, owner_id, kind, intent, plan_slug,
           github_user_id, machine_label, device_pubkey, last_seen_at,
           fleet_slug, fleet_role
    FROM harness_shared.shared_session_presence
    WHERE workspace_id = ${opts.workspaceId}
      AND last_seen_at > ${floor}
      ${opts.potSlug ? sql`AND pot_slug = ${opts.potSlug}` : sql``}
      ${ownerFilter}
    ORDER BY last_seen_at DESC
  `;
  const selected = rows.filter(
    (r) =>
      ownerIds.length === 0 ||
      ownerIds.some(
        (selector) =>
          r.owner_id === selector ||
          `${r.kind} · ${r.owner_id.slice(0, 8)} @ ${r.machine_label}` === selector ||
          r.owner_id.includes(selector) ||
          selector.includes(r.owner_id) ||
          `${r.kind} · ${r.owner_id.slice(0, 8)} @ ${r.machine_label}`.includes(selector) ||
          selector.includes(`${r.kind} · ${r.owner_id.slice(0, 8)} @ ${r.machine_label}`),
      ),
  );
  return selected.map((r) => ({
    workspace_id: r.workspace_id,
    pot_slug: r.pot_slug,
    harness_slug: r.harness_slug,
    owner_id: r.owner_id,
    kind: r.kind,
    intent: r.intent,
    plan_slug: r.plan_slug,
    github_user_id: Number(r.github_user_id),
    machine_label: r.machine_label,
    device_pubkey: r.device_pubkey,
    last_seen_ms: new Date(r.last_seen_at).getTime(),
    fleet_slug: r.fleet_slug ?? null,
    fleet_role: r.fleet_role ?? null,
  }));
}

/** A cross-machine fleet member as read from shared_session_presence (P-301). */
export interface FederatedFleetMemberRow {
  ownerId: string;
  fleetRole: string | null;
}

/**
 * The FEDERATED analogue of fleet-roster.liveFleetMemberIds: live remote sessions
 * (within staleMs) carrying `fleet_slug` = the given fleet, with their advertised
 * role (so the coord audience resolver can union cross-machine members AND derive a
 * cross-machine leader). Returns [] when shared_session_presence is empty (single
 * box) or on a query error — the local roster must always resolve regardless.
 *
 * `staleMs` is passed in (not imported) to keep this gossip-store module free of the
 * coordination-layer PRESENCE_STALE_MS constant; the caller supplies it.
 */
export async function listFederatedFleetMembers(
  opts: { workspaceId: string; fleetSlug: string; staleMs: number; nowMs?: number },
  sqlIn?: postgres.Sql,
): Promise<FederatedFleetMemberRow[]> {
  const sql = sqlIn ?? getOrgPg().sql;
  const now = opts.nowMs ?? Date.now();
  const floor = new Date(now - opts.staleMs);
  const rows = await sql<Array<{ owner_id: string; fleet_role: string | null }>>`
    SELECT owner_id, fleet_role
      FROM harness_shared.shared_session_presence
     WHERE workspace_id = ${opts.workspaceId}
       AND fleet_slug = ${opts.fleetSlug}
       AND last_seen_at > ${floor}
  `;
  return rows.map((r) => ({ ownerId: r.owner_id, fleetRole: r.fleet_role ?? null }));
}
