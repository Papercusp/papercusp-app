/**
 * session-brief.ts — durable successor brief for "continue where X left off" (EI-1742).
 *
 * GAP: an agent's declared LANE lives only in harness_shared.coord_presence, which the
 * idle-session-reaper DELETEs once the row goes stale. A successor told "continue where
 * X left off" then has no durable record of X's intent/plan/files and reconstructs the
 * lane from transcript / file-history archaeology (slow + lossy). Both observed cases
 * (su-226ad rate-limited, su-cf7b0 MCP-dropped) died ABRUPTLY — a session-end snapshot
 * hook would have missed them.
 *
 * FIX (consensus su-7dcd + su-cf7b0, EI-1742): persist the lane on the write path that
 * already runs throughout a session — coord:declare-intent → writePresence (see
 * presence.ts) — into harness_shared.session_briefs (migration 322), which the reaper
 * never touches. The LAST declare-intent before the session dies IS the durable brief.
 *
 * This module is the host adapter for that durable store. The write is best-effort and
 * fully isolated: any failure is swallowed so it can NEVER slow or break a presence
 * write (the change degrades to exactly today's behavior). Claimed items are NOT stored
 * here — they are already durable in work_items (queryable by assignee).
 *
 * Read side: getSessionBrief() is the seed a continuing session reads. Auto-injection
 * into assembleSpawnHydration's "## Handoff" block is the Phase-2 follow-up (it needs
 * the launch path to pass the continuation target; for native_session_id resolution see
 * the bootstrap-su adv row that records the Claude session UUID).
 */

import { getOrgPg } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import type { AgentIdentity } from './agent-tools/coordination/identity';

/** The subset of presence input that forms the durable brief. */
export interface SessionBriefInput {
  intent?: string;
  currentPlanSlug?: string | null;
  currentFiles?: string[];
  /** Omit to preserve; pass [] to clear the durable ambient-retrieval fence. */
  ambientExcludedRefs?: string[];
  /** Harness the work is in (the agent's home harness). */
  harnessSlug?: string | null;
  /** Resolved home hive, if any. */
  potSlug?: string | null;
  /**
   * The goal this session's work SERVES, inherited from its launcher at spawn
   * (goal-mode-hardening-2026-08-10 P-002, D-008). NOT the same fact as being
   * in GOAL mode — that lives in agent_modes and means the session RUNS the
   * goal. A descendant carries this and never that, which is what lets goal
   * provenance reach fleet members without turning them into portfolio
   * managers. Omitted ⇒ untouched (see the COALESCE-keep below).
   */
  goalId?: string | null;
  /**
   * The Claude/native session UUID, if the caller has it. declare-intent's context
   * carries only ownerId today, so this is usually null; reserved for the Phase-2
   * "continue where session <uuid> left off" lookup key.
   */
  nativeSessionId?: string | null;
}

/**
 * Durable lifecycle marker for a session that a fleet released during
 * wind-down. This lives inside the existing control_state projection rather
 * than in a second table, so queued wakes can make one authoritative read
 * before attempting any reanimation.
 */
export interface SessionBriefReleaseMarker {
  fleet: string;
  at: string;
  by: string;
}

/** A terminal verdict for one adv-session incarnation whose Claude transcript
 * repeatedly replayed an unavailable Papercusp tool reference. The adv-session
 * id + startedAt pair scopes the stop gate to this incarnation; a later resume
 * or fresh successor can proceed without deleting durable history. */
export interface SessionBriefPoisonMarker {
  advSessionId: number;
  sessionId: string;
  startedAt: string;
  at: string;
  by: string;
  reason: string;
  evidence: string;
}

export interface SessionBriefLifecycle {
  released?: SessionBriefReleaseMarker;
  poisoned?: SessionBriefPoisonMarker;
}

export interface SessionBriefRecord {
  ownerId: string;
  workspaceId: string;
  ownerLabel: string;
  source: string;
  intent: string;
  currentPlanSlug: string | null;
  currentFiles: string[];
  ambientExcludedRefs: string[] | null;
  harnessSlug: string | null;
  potSlug: string | null;
  goalId: string | null;
  nativeSessionId: string | null;
  lifecycle: SessionBriefLifecycle | null;
  /** Raw compact control projection. Consumers validate only the fields they own. */
  controlState?: unknown | null;
  firstSeenAt: string;
  updatedAt: string;
}

/**
 * Best-effort upsert of the caller's durable successor brief. Called from
 * writePresence after the presence row is written. NEVER throws: a failure here must
 * not affect presence/declare-intent (the table may even be absent on a node that has
 * not yet applied migration 322 — that simply no-ops).
 */
export async function writeSessionBrief(
  identity: AgentIdentity,
  input: SessionBriefInput = {},
): Promise<void> {
  try {
    if (!identity?.ownerId) return;
    const sql = getOrgPg().sql;
    // EI-18776963284535761: same omitted-means-untouched sentinel as coord_presence
    // (see pg-store.write). The brief is what a SUCCESSOR reads after its predecessor
    // dies, so a wipe here loses the declared lane at exactly the moment it matters
    // most. Explicit [] still clears; NULL is the untouched sentinel (NOT NULL column).
    const filesJson = input.currentFiles === undefined ? null : JSON.stringify(input.currentFiles);
    const ambientExcludedRefsJson =
      input.ambientExcludedRefs === undefined ? null : JSON.stringify(input.ambientExcludedRefs);
    await sql`
      INSERT INTO harness_shared.session_briefs
        (owner_id, workspace_id, owner_label, source, intent,
         current_plan_slug, current_files, ambient_excluded_refs, harness_slug, pot_slug, goal_id,
         native_session_id, first_seen_at, updated_at)
      VALUES (
        ${identity.ownerId},
        ${identity.workspaceId ?? 'default'},
        ${identity.ownerLabel ?? ''},
        ${identity.source ?? ''},
        ${input.intent ?? ''},
        ${input.currentPlanSlug ?? null},
        COALESCE(${filesJson}::text::jsonb, '[]'::jsonb),
        ${ambientExcludedRefsJson}::text::jsonb,
        ${input.harnessSlug ?? null},
        ${input.potSlug ?? null},
        ${input.goalId ?? null},
        ${input.nativeSessionId ?? null},
        now(), now()
      )
      ON CONFLICT (owner_id) DO UPDATE SET
        workspace_id      = EXCLUDED.workspace_id,
        owner_label       = EXCLUDED.owner_label,
        source            = EXCLUDED.source,
        intent            = EXCLUDED.intent,
        current_plan_slug = EXCLUDED.current_plan_slug,
        -- omitted ⇒ untouched, explicit [] ⇒ clear (EI-18776963284535761); reads the
        -- parameter directly, not EXCLUDED (the VALUES row COALESCEd it to '[]').
        current_files     = COALESCE(${filesJson}::text::jsonb, harness_shared.session_briefs.current_files),
        -- omitted ⇒ untouched; explicit [] ⇒ clear (EI-21096338043071922).
        ambient_excluded_refs = COALESCE(
          ${ambientExcludedRefsJson}::text::jsonb,
          harness_shared.session_briefs.ambient_excluded_refs
        ),
        -- populate-once-then-keep: a write that omits harness/hive/session never WIPES
        -- a previously-resolved value (mirrors coord_presence D-004).
        harness_slug      = COALESCE(EXCLUDED.harness_slug, harness_shared.session_briefs.harness_slug),
        pot_slug         = COALESCE(EXCLUDED.pot_slug, harness_shared.session_briefs.pot_slug),
        -- Same populate-once-then-keep as the lanes above, and it matters more
        -- here: goal context is written ONCE at launch, while presence/intent
        -- writes fire constantly and all omit it. Plain assignment would erase
        -- a descendant's goal on its very next heartbeat (D-008).
        goal_id           = COALESCE(EXCLUDED.goal_id, harness_shared.session_briefs.goal_id),
        native_session_id = COALESCE(EXCLUDED.native_session_id, harness_shared.session_briefs.native_session_id),
        updated_at        = now()
    `;
  } catch {
    /* best-effort: the brief must never break a presence write (EI-1742). */
  }
}

function rowToRecord(r: Record<string, unknown>): SessionBriefRecord {
  const lifecycle = parseSessionBriefLifecycle(r.control_state);
  const ambientExcludedRefs = parseAmbientExcludedRefs(r.ambient_excluded_refs);
  return {
    ownerId: String(r.owner_id),
    workspaceId: String(r.workspace_id),
    ownerLabel: String(r.owner_label ?? ''),
    source: String(r.source ?? ''),
    intent: String(r.intent ?? ''),
    currentPlanSlug: (r.current_plan_slug as string | null) ?? null,
    currentFiles: Array.isArray(r.current_files) ? (r.current_files as string[]) : [],
    ambientExcludedRefs: ambientExcludedRefs.valid
      ? ambientExcludedRefs.present
        ? ambientExcludedRefs.refs
        : null
      : null,
    harnessSlug: (r.harness_slug as string | null) ?? null,
    potSlug: (r.pot_slug as string | null) ?? null,
    goalId: (r.goal_id as string | null) ?? null,
    nativeSessionId: (r.native_session_id as string | null) ?? null,
    lifecycle,
    controlState: r.control_state ?? null,
    firstSeenAt: String(r.first_seen_at ?? ''),
    updatedAt: String(r.updated_at ?? ''),
  };
}

type AmbientExcludedRefsParse = { present: boolean; valid: boolean; refs: string[] };

function parseAmbientExcludedRefs(value: unknown): AmbientExcludedRefsParse {
  if (value === null || value === undefined) return { present: false, valid: true, refs: [] };
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return { present: true, valid: false, refs: [] };
    }
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((ref) => typeof ref !== 'string' || ref.trim().length === 0)
  ) {
    return { present: true, valid: false, refs: [] };
  }
  return {
    present: true,
    valid: true,
    refs: Array.from(new Set(parsed.map((ref) => ref.trim()))),
  };
}

export interface AmbientExcludedRefsFence {
  /** False means the durable fence could not be read; callers must fail closed. */
  available: boolean;
  refs: ReadonlySet<string>;
}

/** Resolve the caller's fence; missing/legacy rows are valid empty fences. */
export async function getSessionBriefAmbientExcludedRefs(
  ownerId: string,
): Promise<AmbientExcludedRefsFence> {
  try {
    if (!ownerId) return { available: false, refs: new Set<string>() };
    const rows = await getOrgPg().sql`
      SELECT ambient_excluded_refs
        FROM harness_shared.session_briefs
       WHERE owner_id = ${ownerId}
       LIMIT 1
    `;
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) return { available: true, refs: new Set<string>() };
    const parsed = parseAmbientExcludedRefs(row.ambient_excluded_refs);
    if (!parsed.valid) return { available: false, refs: new Set<string>() };
    return { available: true, refs: new Set(parsed.refs) };
  } catch {
    return { available: false, refs: new Set<string>() };
  }
}

function parseSessionBriefLifecycle(value: unknown): SessionBriefLifecycle | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const lifecycle = (value as { lifecycle?: unknown }).lifecycle;
  if (!lifecycle || typeof lifecycle !== 'object' || Array.isArray(lifecycle)) return null;
  const released = (lifecycle as { released?: unknown }).released;
  const poisoned = (lifecycle as { poisoned?: unknown }).poisoned;
  const result: SessionBriefLifecycle = {};
  if (released && typeof released === 'object' && !Array.isArray(released)) {
    const marker = released as Partial<SessionBriefReleaseMarker>;
    if (
      typeof marker.fleet === 'string' && marker.fleet &&
      typeof marker.at === 'string' && marker.at &&
      typeof marker.by === 'string' && marker.by
    ) {
      result.released = { fleet: marker.fleet, at: marker.at, by: marker.by };
    }
  }
  if (poisoned && typeof poisoned === 'object' && !Array.isArray(poisoned)) {
    const marker = poisoned as Partial<SessionBriefPoisonMarker>;
    if (
      typeof marker.advSessionId === 'number' && Number.isSafeInteger(marker.advSessionId) && marker.advSessionId > 0 &&
      typeof marker.sessionId === 'string' && marker.sessionId &&
      typeof marker.startedAt === 'string' && marker.startedAt &&
      typeof marker.at === 'string' && marker.at &&
      typeof marker.by === 'string' && marker.by &&
      typeof marker.reason === 'string' && marker.reason &&
      typeof marker.evidence === 'string' && marker.evidence
    ) {
      result.poisoned = {
        advSessionId: Number(marker.advSessionId),
        sessionId: marker.sessionId,
        startedAt: marker.startedAt,
        at: marker.at,
        by: marker.by,
        reason: marker.reason,
        evidence: marker.evidence,
      };
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Read the durable lifecycle markers used by the wake executor. Fail-soft by
 * design: a temporary brief-store outage must not turn every ordinary wake
 * into a permanent drop; each marker is durable when the store is available.
 */
export async function getSessionBriefLifecycle(ownerId: string): Promise<SessionBriefLifecycle | null> {
  try {
    if (!ownerId) return null;
    const rows = await getOrgPg().sql`
      SELECT control_state
        FROM harness_shared.session_briefs
       WHERE owner_id = ${ownerId}
       LIMIT 1
    `;
    return parseSessionBriefLifecycle((rows[0] as Record<string, unknown> | undefined)?.control_state);
  } catch {
    return null;
  }
}

/**
 * Mark one live fleet member as released before its typed wind-down cue is
 * sent. The upsert also covers a member whose brief has not been written yet.
 * Existing control-anchor fields are preserved; a marker change advances the
 * anchor generation and clears its transition so the next consumer performs a
 * full resync from the authoritative row.
 */
export async function markSessionBriefReleased(
  ownerId: string,
  workspaceId: string,
  marker: SessionBriefReleaseMarker,
): Promise<boolean> {
  try {
    if (!ownerId || !workspaceId || !marker.fleet || !marker.at || !marker.by) return false;
    const markerJson = JSON.stringify(marker);
    await getOrgPg().sql`
      INSERT INTO harness_shared.session_briefs
        (owner_id, workspace_id, control_state, control_generation, control_updated_at)
      VALUES (
        ${ownerId}, ${workspaceId},
        jsonb_build_object('lifecycle', jsonb_build_object('released', ${markerJson}::text::jsonb)),
        1, now()
      )
      ON CONFLICT (owner_id) DO UPDATE SET
        workspace_id = EXCLUDED.workspace_id,
        control_state = CASE
          WHEN harness_shared.session_briefs.control_state #> '{lifecycle,released}'
               IS DISTINCT FROM EXCLUDED.control_state #> '{lifecycle,released}'
            THEN jsonb_set(
              COALESCE(harness_shared.session_briefs.control_state, '{}'::jsonb),
              '{lifecycle,released}',
              EXCLUDED.control_state #> '{lifecycle,released}',
              true
            )
          ELSE harness_shared.session_briefs.control_state
        END,
        control_generation = CASE
          WHEN harness_shared.session_briefs.control_state #> '{lifecycle,released}'
               IS DISTINCT FROM EXCLUDED.control_state #> '{lifecycle,released}'
            THEN harness_shared.session_briefs.control_generation + 1
          ELSE harness_shared.session_briefs.control_generation
        END,
        control_updated_at = CASE
          WHEN harness_shared.session_briefs.control_state #> '{lifecycle,released}'
               IS DISTINCT FROM EXCLUDED.control_state #> '{lifecycle,released}'
            THEN now()
          ELSE harness_shared.session_briefs.control_updated_at
        END,
        control_transition = CASE
          WHEN harness_shared.session_briefs.control_state #> '{lifecycle,released}'
               IS DISTINCT FROM EXCLUDED.control_state #> '{lifecycle,released}'
            THEN NULL
          ELSE harness_shared.session_briefs.control_transition
        END,
        updated_at = now()
    `;
    return true;
  } catch {
    return false;
  }
}

/**
 * Record a poison verdict for one exact session incarnation. This shares the
 * existing session_briefs control_state lifecycle envelope with fleet release,
 * so queued wakes can stop before they try to reanimate the same transcript.
 */
export async function markSessionBriefPoisoned(
  ownerId: string,
  workspaceId: string,
  marker: SessionBriefPoisonMarker,
): Promise<boolean> {
  try {
    if (
      !ownerId || !workspaceId || typeof marker.advSessionId !== 'number' ||
      !Number.isSafeInteger(marker.advSessionId) || marker.advSessionId <= 0 ||
      !marker.sessionId || !marker.startedAt || !marker.at || !marker.by || !marker.reason || !marker.evidence
    ) return false;
    const boundedMarker: SessionBriefPoisonMarker = {
      ...marker,
      reason: marker.reason.slice(0, 500),
      evidence: marker.evidence.slice(0, 400),
    };
    const markerJson = JSON.stringify(boundedMarker);
    await getOrgPg().sql`
      INSERT INTO harness_shared.session_briefs
        (owner_id, workspace_id, control_state, control_generation, control_updated_at)
      VALUES (
        ${ownerId}, ${workspaceId},
        jsonb_build_object('lifecycle', jsonb_build_object('poisoned', ${markerJson}::text::jsonb)),
        1, now()
      )
      ON CONFLICT (owner_id) DO UPDATE SET
        workspace_id = EXCLUDED.workspace_id,
        control_state = CASE
          WHEN harness_shared.session_briefs.control_state #> '{lifecycle,poisoned}'
               IS DISTINCT FROM EXCLUDED.control_state #> '{lifecycle,poisoned}'
            THEN jsonb_set(
              COALESCE(harness_shared.session_briefs.control_state, '{}'::jsonb),
              '{lifecycle,poisoned}',
              EXCLUDED.control_state #> '{lifecycle,poisoned}',
              true
            )
          ELSE harness_shared.session_briefs.control_state
        END,
        control_generation = CASE
          WHEN harness_shared.session_briefs.control_state #> '{lifecycle,poisoned}'
               IS DISTINCT FROM EXCLUDED.control_state #> '{lifecycle,poisoned}'
            THEN harness_shared.session_briefs.control_generation + 1
          ELSE harness_shared.session_briefs.control_generation
        END,
        control_updated_at = CASE
          WHEN harness_shared.session_briefs.control_state #> '{lifecycle,poisoned}'
               IS DISTINCT FROM EXCLUDED.control_state #> '{lifecycle,poisoned}'
            THEN now()
          ELSE harness_shared.session_briefs.control_updated_at
        END,
        control_transition = CASE
          WHEN harness_shared.session_briefs.control_state #> '{lifecycle,poisoned}'
               IS DISTINCT FROM EXCLUDED.control_state #> '{lifecycle,poisoned}'
            THEN NULL
          ELSE harness_shared.session_briefs.control_transition
        END,
        updated_at = now()
    `;
    return true;
  } catch {
    return false;
  }
}

/** Clear only this workspace/fleet's release markers when that fleet resumes. */
export async function clearSessionBriefReleasedForFleet(
  workspaceId: string,
  fleet: string,
): Promise<number> {
  try {
    if (!workspaceId || !fleet) return 0;
    const rows = await getOrgPg().sql<Array<{ owner_id: string }>>`
      UPDATE harness_shared.session_briefs
         SET control_state = CASE
               WHEN (control_state->'lifecycle' - 'released') = '{}'::jsonb
                 THEN control_state - 'lifecycle'
               ELSE control_state #- '{lifecycle,released}'
             END,
             control_generation = control_generation + 1,
             control_updated_at = now(),
             control_transition = NULL,
             updated_at = now()
       WHERE workspace_id = ${workspaceId}
         AND control_state #>> '{lifecycle,released,fleet}' = ${fleet}
       RETURNING owner_id
    `;
    return rows.length;
  } catch {
    return 0;
  }
}

/**
 * Read a durable successor brief for a continuing session. Resolve by ownerId
 * (the common "continue where owner X left off") or by nativeSessionId (the Claude
 * session UUID a "continue where session <uuid> left off" names — populated once the
 * write path carries it; Phase 2). Returns null when absent or on any error (fail-soft).
 */
export async function getSessionBrief(
  query: { ownerId?: string | null; nativeSessionId?: string | null },
  db?: Sql,
): Promise<SessionBriefRecord | null> {
  try {
    const sql = db ?? getOrgPg().sql;
    if (query.ownerId) {
      const rows = await sql`
        SELECT * FROM harness_shared.session_briefs WHERE owner_id = ${query.ownerId} LIMIT 1
      `;
      return rows[0] ? rowToRecord(rows[0] as Record<string, unknown>) : null;
    }
    if (query.nativeSessionId) {
      const rows = await sql`
        SELECT * FROM harness_shared.session_briefs
        WHERE native_session_id = ${query.nativeSessionId}
        ORDER BY updated_at DESC LIMIT 1
      `;
      return rows[0] ? rowToRecord(rows[0] as Record<string, unknown>) : null;
    }
    return null;
  } catch {
    return null;
  }
}
