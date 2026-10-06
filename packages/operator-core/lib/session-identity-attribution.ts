import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import type { SessionActivation } from '@papercusp/orchestrator/blueprint';

export type SessionIdentityActivationPhase = 'desired' | 'prepared' | 'applied' | 'failed';
export type SessionIdentityActivationSource = 'launch' | 'control' | 'restart' | 'reanchor';
export type SessionIdentityActivationRecordResult = 'inserted' | 'replayed' | 'missing';

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stable(child)]),
    );
  }
  return value;
}

/** Mutable worn-identity state revision; the immutable specification stays separate. */
export function sessionIdentityStateRevision(state: {
  modes: readonly string[];
  stack?: readonly string[];
  route: unknown;
}): string {
  return createHash('sha256')
    .update(JSON.stringify(stable({ modes: state.modes, stack: state.stack ?? [], route: state.route })), 'utf8')
    .digest('hex');
}

export function sessionIdentityTransitionId(
  ownerId: string,
  generation: number,
  revision: SessionActivation['desired'],
): string {
  return `session-activation:${ownerId}:${generation}:${revision.specificationRevision}:${revision.stateRevision}`;
}

/**
 * Append one phase from the current control anchor.  The SELECT is deliberately
 * anchored to the exact generation + revision so a delayed retry cannot write a
 * newer stack under an older transition id.  A duplicate is an idempotent replay.
 */
export async function recordCurrentSessionIdentityActivation(input: {
  workspaceId: string;
  ownerId: string;
  generation: number;
  phase: SessionIdentityActivationPhase;
  source: SessionIdentityActivationSource;
  revision: SessionActivation['desired'];
  failure?: string | null;
  recordedAt?: string;
  /** The native incarnation this event names. Default: the owner's launch row. */
  nativeSessionId?: string | null;
  /** Override for an event that is not itself a control transition (a re-anchor). */
  transitionId?: string;
  sql?: Sql;
}): Promise<SessionIdentityActivationRecordResult> {
  const sql = input.sql ?? getOrgPg().sql;
  const transitionId = input.transitionId
    ?? sessionIdentityTransitionId(input.ownerId, input.generation, input.revision);
  const revisionJson = JSON.stringify(input.revision);
  const nativeSessionId = input.nativeSessionId ?? null;
  const recordedAt = input.recordedAt ?? null;
  const rows = await sql<Array<{ id: number | string }>>`
    INSERT INTO harness_shared.session_identity_activation_events
      (workspace_id, owner_id, actor_id, principal_id, session_id,
       adv_session_id, native_session_id, transition_id, control_generation,
       phase, source, specification_revision, state_revision, stack_refs,
       failure, recorded_at, specification_layer_refs)
    SELECT ${input.workspaceId}, ${input.ownerId},
           b.control_state #>> '{activation,attribution,actorId}',
           b.control_state #>> '{activation,attribution,principalId}',
           b.control_state #>> '{activation,attribution,sessionId}',
           av.id, COALESCE(${nativeSessionId}::text, av.session_id, b.native_session_id),
           ${transitionId}, ${input.generation}, ${input.phase}, ${input.source},
           ${input.revision.specificationRevision}, ${input.revision.stateRevision},
           COALESCE(b.control_state->'stack', '[]'::jsonb),
           ${input.phase === 'failed' ? input.failure?.trim() || 'activation failed' : null},
           COALESCE(${recordedAt}::timestamptz, now()),
           -- WI-10004494 gap 3 (migration 1295): stamp the slotted layer set of the artifact for
           -- EXACTLY this revision now, while it is reachable. The launch record churns its
           -- revision on every relaunch and caps identityHistory, so a later re-resolution from
           -- the record loses it. Order: a stamp already taken for the revision (content hash, so
           -- owner-independent) -> the launch record (current artifact + identityHistory).
           -- blueprint_specifications is deliberately not consulted: it held 0 of the 4,354
           -- September revisions missing from launch records. NULL = no artifact reachable;
           -- '[]' = artifact known, none slotted.
           COALESCE(
             (SELECT p.specification_layer_refs
                FROM harness_shared.session_identity_activation_events p
               WHERE p.workspace_id = ${input.workspaceId}
                 AND p.specification_revision = ${input.revision.specificationRevision}
                 AND p.specification_layer_refs IS NOT NULL
               LIMIT 1),
             (SELECT harness_shared.identity_specification_layer_refs(c.artifact)
                FROM harness_shared.adv_sessions s
               CROSS JOIN LATERAL (
                 SELECT s.launch_spec->'specificationArtifact' AS artifact
                 UNION ALL
                 SELECT h->'specificationArtifact'
                   FROM jsonb_array_elements(
                          CASE WHEN jsonb_typeof(s.launch_spec->'identityHistory') = 'array'
                               THEN s.launch_spec->'identityHistory' ELSE '[]'::jsonb END) h
               ) c
               WHERE s.id = av.id
                 AND jsonb_typeof(c.artifact) = 'object'
                 AND c.artifact->>'specificationRevision' = ${input.revision.specificationRevision}
               LIMIT 1))
      FROM harness_shared.session_briefs b
      LEFT JOIN LATERAL (
        SELECT a.id, a.session_id
          FROM harness_shared.adv_sessions a
         WHERE a.workspace_id = b.workspace_id
           AND a.coord_owner_id = b.owner_id
         ORDER BY (a.ended_at IS NULL) DESC, a.started_at DESC, a.id DESC
         LIMIT 1
      ) av ON true
     WHERE b.owner_id = ${input.ownerId}
       AND b.workspace_id = ${input.workspaceId}
       -- WI-10003459: the transition's generation may be OLDER than the brief's.
       -- acknowledgeControlTransition and convergeActivationToLaunchRecord write
       -- under control_generation >= generation (a later non-identity control
       -- bump — loop, scope, orient — must not strand the prepared generation).
       -- Exact equality here made the recorder return 'missing' for exactly
       -- that case, so the applied write threw and rolled back on every turn.
       -- The phase-revision match below is the truth guard; this only refuses
       -- a generation the brief has not reached yet.
       AND b.control_generation >= ${input.generation}
       AND CASE ${input.phase}
             WHEN 'desired' THEN b.control_state->'activation'->'desired'
             WHEN 'prepared' THEN b.control_state->'activation'->'prepared'
             WHEN 'applied' THEN b.control_state->'activation'->'applied'
             ELSE b.control_state->'activation'->'desired'
           END = ${revisionJson}::text::jsonb
    ON CONFLICT (workspace_id, owner_id, transition_id, phase) DO NOTHING
    RETURNING id
  `;
  if (rows.length > 0) return 'inserted';
  const replay = await sql<Array<{ found: boolean }>>`
    SELECT true AS found
      FROM harness_shared.session_identity_activation_events
     WHERE workspace_id = ${input.workspaceId}
       AND owner_id = ${input.ownerId}
       AND transition_id = ${transitionId}
       AND phase = ${input.phase}
     LIMIT 1
  `;
  return replay.length > 0 ? 'replayed' : 'missing';
}

/**
 * WI-10004917: open an applied span for a native incarnation the owner's launch row
 * was just re-anchored to. Applied events are otherwise written only on control
 * transitions, so a CLI relaunch that changes no control state left the new native
 * id with no span: every owner-by-native-session oracle (the goal-brief R-3 probe,
 * identity usage attribution) read its turns as foreign.
 *
 * Re-records the brief's CURRENT applied revision under the new native id. Replays
 * when the owner's latest applied event already names that id. The transition id
 * names the event it supersedes, so a retried report converges on one row while a
 * later return to an earlier id (A -> B -> A) still opens a fresh span.
 */
export async function recordSessionIdentityReanchor(input: {
  workspaceId: string;
  ownerId: string;
  nativeSessionId: string;
  sql?: Sql;
}): Promise<SessionIdentityActivationRecordResult> {
  const sql = input.sql ?? getOrgPg().sql;
  const [anchor] = await sql<Array<{
    generation: number | string;
    applied: string | null;
    last_id: number | string | null;
    last_native: string | null;
  }>>`
    SELECT b.control_generation AS generation,
           (b.control_state->'activation'->'applied')::text AS applied,
           last.id AS last_id, last.native_session_id AS last_native
      FROM harness_shared.session_briefs b
      LEFT JOIN LATERAL (
        SELECT e.id, e.native_session_id
          FROM harness_shared.session_identity_activation_events e
         WHERE e.workspace_id = b.workspace_id
           AND e.owner_id = b.owner_id
           AND e.phase = 'applied'
         ORDER BY e.recorded_at DESC, e.id DESC
         LIMIT 1
      ) last ON true
     WHERE b.owner_id = ${input.ownerId}
       AND b.workspace_id = ${input.workspaceId}
  `;
  const applied = anchor?.applied ? JSON.parse(anchor.applied) as SessionActivation['desired'] | null : null;
  if (!anchor || !applied) return 'missing';
  if (anchor.last_native === input.nativeSessionId) return 'replayed';
  const generation = Number(anchor.generation);
  return recordCurrentSessionIdentityActivation({
    workspaceId: input.workspaceId,
    ownerId: input.ownerId,
    generation,
    phase: 'applied',
    source: 'reanchor',
    revision: applied,
    nativeSessionId: input.nativeSessionId,
    transitionId: `${sessionIdentityTransitionId(input.ownerId, generation, applied)}:reanchor:`
      + `${input.nativeSessionId}:after:${anchor.last_id ?? 0}`,
    sql,
  });
}
