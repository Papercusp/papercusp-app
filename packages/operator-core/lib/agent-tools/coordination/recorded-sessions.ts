/**
 * recorded-sessions.ts — synthesize roster rows from the AUTHORITATIVE session
 * log (presence-derive-from-session-log-2026-06-22 P-001).
 *
 * The fleet roster used to be anchored on the SELF-REGISTERED coord_presence
 * table: a session was visible only after it volunteered a coord heartbeat, so a
 * recorded-but-not-yet-registered live session — every console/queen/overwatch,
 * and any interactive session in its launch→first-turn window — was structurally
 * invisible AND undispatchable. This module makes presence a VIEW over the
 * authoritative `adv_sessions` log: for each recorded LIVE session not already
 * present in coord_presence, it projects a `UnifiedPresenceRecord` so the
 * snapshot surfaces it.
 *
 * CLI-AGNOSTIC by construction — it keys on the recorded row + its
 * `coordOwnerId`, never on which agent CLI (claude/codex/omp) backs the session.
 * The join key is uniform across CLIs (claude `s-<ts>-<hex>`, codex/su
 * `su-<uuid>`, …) because it is exactly the id the session later heartbeats
 * under.
 *
 * Pure (rows in → rows out); the IO seam is `listRecordedLiveSessions` in
 * adv-sessions.ts. Each synthesized row is marked `source: RECORDED_SESSION_SOURCE`
 * so the snapshot's wakeability pass renders it as `'recorded'` (authoritatively
 * live, but not inbox-wake-dispatchable) rather than `'ended'` (dead / relaunch).
 */

import type { AdvSessionRow } from '../../adv-sessions';
import type { UnifiedPresenceRecord } from './federated-presence';

/** The `source` marker stamped on a session-log-derived roster row. The snapshot
 *  keys the `'recorded'` session-state (alive but not inbox-wakeable) on this
 *  exact value, so it must match between the producer here and the consumer in
 *  presence-snapshot.ts. */
export const RECORDED_SESSION_SOURCE = 'session-log';

/** A session-log row with positive ended_at evidence. Keep this distinct from
 *  RECORDED_SESSION_SOURCE: the shared liveness oracle treats that marker as
 *  positive live evidence. */
export const RECORDED_ENDED_SESSION_SOURCE = 'session-log-ended';

/** A best, human-meaningful label for a recorded session: its launch label,
 *  else its pipeline role, else its CLI, else a generic fallback. */
function recordedLabel(r: AdvSessionRow): string {
  const label = r.label?.trim();
  if (label) return label;
  if (r.role) return r.role;
  if (r.agent) return r.agent;
  return 'session';
}

/**
 * Project the LIVE recorded sessions NOT already in the live roster
 * (`existingOwnerIds` = the coord_presence + federated owner ids) into roster
 * rows. Each becomes a `UnifiedPresenceRecord` keyed by its coord owner id,
 * marked `source: RECORDED_SESSION_SOURCE`, `stale: false` (authoritatively live
 * — its adv_sessions `ended_at IS NULL` is a better liveness signal than
 * heartbeat age). Identity (label/role/workspace/plan/pid) comes from the
 * recorded row.
 *
 * Dedup rules (both matter):
 *  - a row whose owner is ALREADY in `existingOwnerIds` is skipped, so a session
 *    that HAS self-registered keeps its richer coord_presence row (never shadowed);
 *  - within the recorded list, the first row per owner wins (callers pass a
 *    most-recent-first, owner-deduped list, so this is just defence-in-depth).
 *
 * A row with no `coordOwnerId` is skipped (unaddressable — it could never be
 * woken). Pure → unit-tested.
 */
/**
 * Reconcile the two liveness sources into ONE roster-row list (P-001 / P-002).
 * The precedence — the crux of why a resumed-but-idle session is now visible:
 *
 *  1. A FRESH (non-stale) presence row WINS — it carries the richest live
 *     enrichment (intent, files, wakeability), so a session-log record never
 *     shadows it.
 *  2. A live session-log record SUPERSEDES a STALE presence row — a dead
 *     heartbeat must NOT hide a running session. This is the resume case: an
 *     exited session's `coord_presence` row lingers stale (heartbeat > 10 min)
 *     while `psu --resume` revives the process and reactivates the `adv_sessions`
 *     row; the live record wins, the stale heartbeat row is dropped.
 *  3. An owner with ONLY a live session-log record (never self-registered) gets
 *     a synthesized `recorded` row.
 *
 * Pure (rows in → rows out) → unit-tested. Synthesized rows are appended in the
 * deterministic owner order `listRecordedLiveSessions` returns, preserving the
 * snapshot's byte-stability.
 */
export function reconcileRosterSources(
  presence: readonly UnifiedPresenceRecord[],
  recordedLive: readonly AdvSessionRow[],
): UnifiedPresenceRecord[] {
  // Only a FRESH presence row blocks a session-log record (rule 1); a stale one
  // does not (rule 2).
  const freshPresentIds = new Set(
    presence.filter((r) => !r.stale).map((r) => r.ownerId),
  );
  const synthesized = synthesizeRecordedRosterRows(recordedLive, freshPresentIds);
  const synthOwnerIds = new Set(synthesized.map((r) => r.ownerId));
  // Drop a STALE presence row superseded by a live session-log record (rule 2) so
  // the owner isn't double-listed (once stale-dead, once recorded-live).
  const kept = presence.filter((r) => !(r.stale && synthOwnerIds.has(r.ownerId)));
  return [...kept, ...synthesized];
}

export function synthesizeRecordedRosterRows(
  recorded: readonly AdvSessionRow[],
  existingOwnerIds: ReadonlySet<string>,
): UnifiedPresenceRecord[] {
  const out: UnifiedPresenceRecord[] = [];
  const seen = new Set<string>();
  for (const r of recorded) {
    const ownerId = r.coordOwnerId;
    if (!ownerId) continue; // unaddressable — skip
    if (existingOwnerIds.has(ownerId)) continue; // already self-registered (richer row wins)
    if (seen.has(ownerId)) continue; // dedup within the recorded list
    seen.add(ownerId);
    out.push({
      ownerId,
      ownerLabel: recordedLabel(r),
      workspaceId: r.workspaceId,
      source: RECORDED_SESSION_SOURCE,
      intent: '',
      currentPlanSlug: r.planSlug,
      currentFiles: [],
      host: '',
      pid: r.pid,
      tty: null,
      startedAt: r.startedAt,
      // No heartbeat yet — the launch ts is the liveness baseline. `stale:false`
      // below means this never reads as heartbeat-stale (the adv_sessions
      // ended_at IS NULL is the authoritative liveness signal).
      heartbeatAt: r.startedAt,
      lastActiveAt: null,
      intentDeclaredAt: null, // no declared intent yet — unaddressable-until-registered
      agentRole: r.role,
      // adv_sessions carries no hive attribution yet → the synthesized leg is
      // workspace/all-scope only (P-002 adds hive_slug to the recording so the
      // hive-scoped Queen view can include un-self-registered bees too).
      potSlug: null,
      // WI-1546: synthesized from adv_sessions, which carries no capability
      // detection at all (pre-registration row) — same gap as intentDeclaredAt.
      capabilityTags: [],
      stale: false,
      userId: null,
      revoked: false,
      federated: false,
    });
  }
  return out;
}
/**
 * EI-21488009366204518 — the ENDED twin of {@link synthesizeRecordedRosterRows}:
 * synthesize roster rows for owners whose ONLY remaining evidence is a
 * session-log death record (adv_sessions.ended_at) because their coord_presence
 * row has been reaped. Without this leg, a targeted `coord:presence { owner }`
 * lookup — the documented "inspect one dead agent" door — renders a reaped dead
 * session as an EMPTY roster, indistinguishable from an id that never existed.
 *
 * The synthesized row is `stale: true` with its heartbeat pinned to `endedAt`,
 * so the oracle's deriveVerdict classifies it `'ended'` via the recordedEnded
 * branch (positive death evidence) rather than inventing liveness. Pure; the IO
 * seam is `listEndedAdvSessionsByOwners` in adv-sessions.ts.
 */
export function synthesizeEndedRosterRows(
  ended: readonly AdvSessionRow[],
  existingOwnerIds: ReadonlySet<string>,
): UnifiedPresenceRecord[] {
  const out: UnifiedPresenceRecord[] = [];
  const seen = new Set<string>();
  for (const r of ended) {
    const ownerId = r.coordOwnerId;
    if (!ownerId) continue; // unaddressable — skip
    if (existingOwnerIds.has(ownerId)) continue; // a live presence row wins
    if (seen.has(ownerId)) continue; // dedup within the ended list
    seen.add(ownerId);
    out.push({
      ownerId,
      ownerLabel: recordedLabel(r),
      workspaceId: r.workspaceId,
      source: RECORDED_ENDED_SESSION_SOURCE,
      intent: '',
      currentPlanSlug: r.planSlug,
      currentFiles: [],
      host: '',
      pid: r.pid,
      tty: null,
      startedAt: r.startedAt,
      // The death ts is the last truthful liveness reading. stale:true keeps the
      // row out of every dispatchable surface; the distinct ended-source marker
      // lets deriveVerdict emit `ended` without triggering the live-session
      // shortcut for RECORDED_SESSION_SOURCE.
      heartbeatAt: r.endedAt ?? r.startedAt,
      lastActiveAt: null,
      intentDeclaredAt: null,
      agentRole: r.role,
      potSlug: null,
      capabilityTags: [],
      stale: true,
      userId: null,
      revoked: false,
      federated: false,
    });
  }
  return out;
}
