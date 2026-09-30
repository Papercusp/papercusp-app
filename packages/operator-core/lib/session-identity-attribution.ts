import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import type { SessionActivation } from '@papercusp/orchestrator/blueprint';

export type SessionIdentityActivationPhase = 'desired' | 'prepared' | 'applied' | 'failed';
export type SessionIdentityActivationSource = 'launch' | 'control' | 'restart';
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
  sql?: Sql;
}): Promise<SessionIdentityActivationRecordResult> {
  const sql = input.sql ?? getOrgPg().sql;
  const transitionId = sessionIdentityTransitionId(input.ownerId, input.generation, input.revision);
  const revisionJson = JSON.stringify(input.revision);
  const recordedAt = input.recordedAt ?? null;
  const rows = await sql<Array<{ id: number | string }>>`
    INSERT INTO harness_shared.session_identity_activation_events
      (workspace_id, owner_id, actor_id, principal_id, session_id,
       adv_session_id, native_session_id, transition_id, control_generation,
       phase, source, specification_revision, state_revision, stack_refs,
       failure, recorded_at)
    SELECT ${input.workspaceId}, ${input.ownerId},
           b.control_state #>> '{activation,attribution,actorId}',
           b.control_state #>> '{activation,attribution,principalId}',
           b.control_state #>> '{activation,attribution,sessionId}',
           av.id, COALESCE(av.session_id, b.native_session_id),
           ${transitionId}, ${input.generation}, ${input.phase}, ${input.source},
           ${input.revision.specificationRevision}, ${input.revision.stateRevision},
           COALESCE(b.control_state->'stack', '[]'::jsonb),
           ${input.phase === 'failed' ? input.failure?.trim() || 'activation failed' : null},
           COALESCE(${recordedAt}::timestamptz, now())
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
