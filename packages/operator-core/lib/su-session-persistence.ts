/**
 * Durable SU-session binding and runtime reconciliation (P-004).
 *
 * `adv_sessions` is the existing lifecycle ledger and remains the only
 * durable identity store.  This module adds the PUI agent-chat binding and a
 * restart-safe descriptor snapshot to that row.  All decisions are kept pure
 * where possible so stale-pid and duplicate-launch behaviour can be tested
 * without a process or a database.
 */
import { getOrgPg } from '@papercusp/db-org';
import type { SuSessionBackend, SuSessionDescriptor, SuSessionLifecycleState } from '@papercusp/chat-protocol';
import { activeWorkspaceId } from './workspace-registry';

export const SU_SESSION_LIFECYCLE_STATES: readonly SuSessionLifecycleState[] = [
  'starting', 'ready', 'running', 'waiting-for-owner', 'resuming',
  'compacting', 'interrupted', 'ended', 'failed',
] as const;

export interface DurableSuSessionRecord {
  advSessionId: number;
  workspaceId: string;
  agentChatId: string | null;
  backend: SuSessionBackend | null;
  nativeSessionId: string | null;
  ownerId: string | null;
  harnessSlug: string | null;
  lifecycle: SuSessionLifecycleState | null;
  runtimeGeneration: number;
  pid: number | null;
  endedAt: string | Date | null;
  descriptor: SuSessionDescriptor | null;
  /**
   * The directory the session was launched in (`adv_sessions.cwd`) — for a PUI
   * launch, the directory `pui` was started in. PUI scopes `/resume` and its
   * startup reattach to the current directory with it (pui-chat-first-ux P-010).
   */
  cwd: string | null;
}

export type SuSessionBindingResult =
  | { status: 'bound'; record: DurableSuSessionRecord }
  | { status: 'already_bound'; record: DurableSuSessionRecord }
  | { status: 'not_found' }
  | { status: 'conflict'; reason: 'chat_bound_elsewhere' | 'identity_mismatch' }
  /**
   * The bind could not be evaluated — a database fault, not a verdict about
   * the row. Distinct from `not_found` ON PURPOSE: collapsing the two is what
   * hid a bind that threw on EVERY call (the RETURNING clause referenced an
   * alias the UPDATE never declared, so Postgres raised 42703 and the blanket
   * catch reported it as an absent row). A caller may fail open on this, but
   * it must not read it as "no such session".
   */
  | { status: 'error'; reason: string };

export type RuntimeReconciliation =
  | { action: 'reattach'; reason: 'live_pid' | 'native_identity' | 'runtime_replacement'; stalePid: boolean }
  | { action: 'rematerialize'; reason: 'ended_archived'; stalePid: boolean }
  | { action: 'relaunch'; reason: 'stale_pid_without_native_identity'; stalePid: true }
  | { action: 'wait'; reason: 'pid_unknown'; stalePid: false };

function isLifecycle(value: unknown): value is SuSessionLifecycleState {
  return typeof value === 'string' && (SU_SESSION_LIFECYCLE_STATES as readonly string[]).includes(value);
}

function isBackend(value: unknown): value is SuSessionBackend {
  return value === 'claude' || value === 'codex' || value === 'omp';
}

function safeGeneration(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Strict descriptor validation before a persisted JSON snapshot is trusted. */
export function isPersistedSuSessionDescriptor(value: unknown): value is SuSessionDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const descriptor = value as Partial<SuSessionDescriptor>;
  const identity = descriptor.identity;
  return Boolean(
    identity && typeof identity === 'object' && !Array.isArray(identity) &&
      typeof identity.agentChatId === 'string' && identity.agentChatId.length > 0 &&
      Number.isSafeInteger(identity.advSessionId) && identity.advSessionId > 0 &&
      isBackend(identity.backend) && typeof identity.nativeSessionId === 'string' &&
      typeof identity.ownerId === 'string' && identity.ownerId.length > 0 &&
      typeof identity.workspaceId === 'string' && identity.workspaceId.length > 0 &&
      descriptor.role === 'su' && isLifecycle(descriptor.lifecycle) &&
      typeof descriptor.runtimeGeneration === 'number' &&
      Number.isSafeInteger(descriptor.runtimeGeneration) && descriptor.runtimeGeneration >= 0 &&
      descriptor.backendExtension && typeof descriptor.backendExtension === 'object',
  );
}

function mapRow(row: Record<string, unknown>): DurableSuSessionRecord {
  const descriptor = isPersistedSuSessionDescriptor(row.su_session_descriptor)
    ? row.su_session_descriptor
    : null;
  const identity = descriptor?.identity;
  return {
    advSessionId: Number(row.id),
    workspaceId: String(row.workspace_id ?? ''),
    agentChatId: typeof row.su_agent_chat_id === 'string' ? row.su_agent_chat_id : identity?.agentChatId ?? null,
    backend: isBackend(row.agent) ? row.agent : identity?.backend ?? null,
    nativeSessionId: typeof row.session_id === 'string' ? row.session_id : identity?.nativeSessionId ?? null,
    ownerId: typeof row.coord_owner_id === 'string' ? row.coord_owner_id : identity?.ownerId ?? null,
    harnessSlug: typeof row.harness_slug === 'string' ? row.harness_slug : identity?.harnessSlug ?? null,
    lifecycle: isLifecycle(row.su_session_state) ? row.su_session_state : descriptor?.lifecycle ?? null,
    runtimeGeneration: safeGeneration(row.su_runtime_generation ?? descriptor?.runtimeGeneration),
    pid: typeof row.pid === 'number' ? row.pid : row.pid == null ? null : Number(row.pid),
    endedAt: (row.ended_at as string | Date | null | undefined) ?? null,
    descriptor,
    cwd: typeof row.cwd === 'string' && row.cwd.trim() ? row.cwd : null,
  };
}

const RECORD_COLUMNS = `
  id, workspace_id, agent, session_id, coord_owner_id,
  to_jsonb(a)->>'harness_slug' AS harness_slug,
  pid, ended_at, su_agent_chat_id, su_session_descriptor,
  su_session_state, su_runtime_generation, cwd`;

/** Read one binding by its stable adv-session id or agent-chat id. */
export async function readDurableSuSession(input: {
  advSessionId?: number;
  agentChatId?: string;
  workspaceId?: string;
}): Promise<DurableSuSessionRecord | null> {
  if (input.advSessionId == null && !input.agentChatId) return null;
  try {
    const { sql } = getOrgPg();
    const workspaceId = input.workspaceId ?? activeWorkspaceId();
    const rows = await sql<Record<string, unknown>[]>`
      SELECT ${sql.unsafe(RECORD_COLUMNS)}
        FROM harness_shared.adv_sessions a
       WHERE workspace_id = ${workspaceId}
         AND (
           (${input.advSessionId ?? null}::bigint IS NOT NULL AND id = ${input.advSessionId ?? null})
           OR (${input.agentChatId ?? null}::text IS NOT NULL AND su_agent_chat_id = ${input.agentChatId ?? null})
         )
       ORDER BY started_at DESC
       LIMIT 1`;
    return rows[0] ? mapRow(rows[0]) : null;
  } catch {
    return null;
  }
}

/**
 * Bind one chat to one adv row. The UPDATE predicate and unique index make
 * concurrent duplicate launches converge on one winner; a different chat or
 * row is reported as a conflict rather than silently stealing identity.
 */
export async function bindSuSessionToAdvSession(input: {
  advSessionId: number;
  agentChatId: string;
  descriptor?: SuSessionDescriptor | null;
  workspaceId?: string;
}): Promise<SuSessionBindingResult> {
  if (!Number.isSafeInteger(input.advSessionId) || input.advSessionId <= 0 || !input.agentChatId.trim()) {
    return { status: 'not_found' };
  }
  if (input.descriptor && !isPersistedSuSessionDescriptor(input.descriptor)) {
    return { status: 'conflict', reason: 'identity_mismatch' };
  }
  try {
    const { sql } = getOrgPg();
    const workspaceId = input.workspaceId ?? activeWorkspaceId();
    const descriptorJson = input.descriptor ? JSON.stringify(input.descriptor) : null;
    // The alias `a` is REQUIRED, not cosmetic: RECORD_COLUMNS projects
    // `to_jsonb(a)` (adv_sessions has no harness_slug column of its own), and
    // an UPDATE's implicit alias is the unqualified table name — so without
    // `AS a` this RETURNING raised 42703 `column "a" does not exist` on every
    // call and the catch below turned it into a silent `not_found`.
    // `prev` carries the row's state from BEFORE this UPDATE. Without it the
    // bound/already_bound discriminator was computed from the post-update row,
    // so a bind that supplied a descriptor could only ever report
    // 'already_bound' — including the very first bind, which is the one case
    // it exists to distinguish. Its `id` is aliased so RECORD_COLUMNS' bare
    // `id` stays unambiguous. No FOR UPDATE on purpose: the unique index
    // (workspace_id, su_agent_chat_id) is what actually serializes concurrent
    // binders, and these two columns are informational — taking a row lock on
    // this hot table would add a lock-ordering hazard to buy nothing.
    const rows = await sql<Record<string, unknown>[]>`
      UPDATE harness_shared.adv_sessions AS a
         SET su_agent_chat_id = ${input.agentChatId.trim()},
             su_session_descriptor = COALESCE(${descriptorJson}::jsonb, a.su_session_descriptor),
             su_session_state = COALESCE(${input.descriptor?.lifecycle ?? null}, a.su_session_state),
             su_runtime_generation = COALESCE(${input.descriptor?.runtimeGeneration ?? null}, a.su_runtime_generation),
             su_session_updated_at = now()
        FROM (
          SELECT id AS prev_id,
                 su_agent_chat_id AS prior_agent_chat_id,
                 (su_session_descriptor IS NOT NULL) AS prior_has_descriptor
            FROM harness_shared.adv_sessions
           WHERE id = ${input.advSessionId} AND workspace_id = ${workspaceId}
        ) AS prev
       WHERE a.id = prev.prev_id
         AND (a.su_agent_chat_id IS NULL OR a.su_agent_chat_id = ${input.agentChatId.trim()})
       RETURNING ${sql.unsafe(RECORD_COLUMNS)}, prev.prior_agent_chat_id, prev.prior_has_descriptor`;
    if (rows[0]) {
      const record = mapRow(rows[0]);
      const priorChatId =
        typeof rows[0].prior_agent_chat_id === 'string' ? rows[0].prior_agent_chat_id : null;
      const alreadyBound = priorChatId === input.agentChatId.trim() && rows[0].prior_has_descriptor === true;
      return { status: alreadyBound ? 'already_bound' : 'bound', record };
    }
    const existing = await readDurableSuSession({ advSessionId: input.advSessionId, workspaceId });
    if (!existing) return { status: 'not_found' };
    return { status: 'conflict', reason: existing.agentChatId ? 'identity_mismatch' : 'chat_bound_elsewhere' };
  } catch (error) {
    if ((error as { code?: string })?.code === '23505') {
      return { status: 'conflict', reason: 'chat_bound_elsewhere' };
    }
    // NOT `not_found`: an exception says nothing about whether the row exists,
    // and reporting it as an absent row is precisely how a bind that could
    // never succeed went unnoticed through three adapters and the launch route.
    const code = (error as { code?: string })?.code;
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'error', reason: code ? `${code}: ${message}` : message };
  }
}

/** Persist the latest descriptor and monotonic runtime generation. */
export async function persistSuSessionDescriptor(
  advSessionId: number,
  descriptor: SuSessionDescriptor,
  workspaceId = activeWorkspaceId(),
): Promise<boolean> {
  if (!isPersistedSuSessionDescriptor(descriptor)) return false;
  const nativeId = descriptor.identity.nativeSessionId?.trim() || null;
  const backend = descriptor.identity.backend;
  if (descriptor.identity.advSessionId !== advSessionId || descriptor.identity.workspaceId !== workspaceId) return false;
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ id: number }[]>`
      UPDATE harness_shared.adv_sessions
         SET su_agent_chat_id = ${descriptor.identity.agentChatId},
             su_session_descriptor = ${JSON.stringify(descriptor)}::jsonb,
             su_session_state = ${descriptor.lifecycle},
             su_runtime_generation = GREATEST(su_runtime_generation, ${descriptor.runtimeGeneration}),
             su_session_updated_at = now(),
             session_id = CASE WHEN ${backend} = 'omp' THEN session_id ELSE COALESCE(${nativeId}, session_id) END,
             omp_thread_id = CASE WHEN ${backend} = 'omp' THEN COALESCE(${nativeId}, omp_thread_id) ELSE omp_thread_id END
       WHERE id = ${advSessionId} AND workspace_id = ${workspaceId}
         AND agent = ${backend} AND coord_owner_id = ${descriptor.identity.ownerId}
         AND (${nativeId}::text IS NULL OR
              CASE WHEN ${backend} = 'omp' THEN omp_thread_id ELSE session_id END IS NULL OR
              CASE WHEN ${backend} = 'omp' THEN omp_thread_id ELSE session_id END = ${nativeId})
         AND su_runtime_generation <= ${descriptor.runtimeGeneration}
       RETURNING id`;
    return rows.length > 0;
  } catch {
    return false;
  }
}

/** Pure stale-pid / native-identity decision used by startup reconciliation. */
export function classifySuSessionRuntime(
  record: Pick<DurableSuSessionRecord, 'pid' | 'nativeSessionId' | 'endedAt' | 'lifecycle'>,
  pidAlive: (pid: number) => boolean,
): RuntimeReconciliation {
  const stalePid = record.pid != null && !pidAlive(record.pid);
  if (record.endedAt != null || record.lifecycle === 'ended' || record.lifecycle === 'failed') {
    return { action: 'rematerialize', reason: 'ended_archived', stalePid };
  }
  if (stalePid && !record.nativeSessionId) {
    return { action: 'relaunch', reason: 'stale_pid_without_native_identity', stalePid: true };
  }
  if (record.nativeSessionId) {
    return {
      action: 'reattach',
      reason: stalePid ? 'runtime_replacement' : record.pid != null ? 'live_pid' : 'native_identity',
      stalePid,
    };
  }
  return { action: 'wait', reason: 'pid_unknown', stalePid: false };
}

/** Pure duplicate-launch guard: one active row may own a chat at a time. */
export function suppressDuplicateSuLaunch(
  existing: Pick<DurableSuSessionRecord, 'agentChatId' | 'advSessionId' | 'endedAt' | 'lifecycle'> | null,
  requested: { agentChatId?: string | null; advSessionId?: number | null },
): boolean {
  if (!existing || existing.endedAt != null || existing.lifecycle === 'ended' || existing.lifecycle === 'failed') return false;
  if (requested.agentChatId && existing.agentChatId === requested.agentChatId) return true;
  return requested.advSessionId != null && existing.advSessionId === requested.advSessionId;
}
