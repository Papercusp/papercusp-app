/**
 * Wake-handle capture (await-event-primitive-2026-06-05 D-003) — shared by
 * every verb that registers a wake await (events:await, locks:acquire's
 * wake_on_grant, future precondition waits).
 *
 * The caller's coord ownerId joins adv_sessions.coord_owner_id (latest row);
 * the stamped handle is what the wake executor re-reads at fire time. The
 * human-readable note tells the registering agent — honestly, up front —
 * how good its wake path is (injectable/resumable vs inbox-degraded).
 */

import { latestAdvSessionByCoordOwner } from '../../adv-sessions';
import type { WakeHandle } from './types';
import { codexHomeForSessionKey } from '@papercusp/orchestrator/session-launch-dirs';
import { findCodexRolloutSessionId } from './wake-executor';

export interface CapturedHandle {
  handle: WakeHandle | null;
  /** One line describing the wake path quality — surface it in the tool result. */
  note: string;
}

export async function captureWakeHandleForOwner(
  ownerId: string,
  opts: { planRunId?: number } = {},
): Promise<CapturedHandle> {
  if (opts.planRunId) {
    return {
      handle: { kind: 'plan-run', runId: opts.planRunId },
      note: `plan-run ${opts.planRunId} — woken via the plans:resume path`,
    };
  }
  const session = await latestAdvSessionByCoordOwner(ownerId);
  if (!session) {
    return {
      handle: null,
      note: 'no tracked session for your coord id — a live psu-host socket will still inject the wake in place; if no injectable socket is available when the event fires, delivery falls back to an inbox notification',
    };
  }
  const sessionId =
    session.agent === 'codex' && !session.sessionId
      ? findCodexRolloutSessionId(codexHomeForSessionKey(session.id))
      : session.sessionId;
  const handle: WakeHandle = {
    kind: 'adv-session',
    advSessionId: session.id,
    agent: session.agent,
    sessionId,
    ompThreadId: session.ompThreadId,
    cwd: session.cwd,
    pid: session.pid,
  };
  // Which clients the wake executor can re-invoke after the process exits:
  //   - claude  → `--resume <nativeUUID>` (needs the native session id; D-003);
  //   - omp     → `-r <threadId>`;
  //   - codex   → `exec resume <uuid>` (recover the conversation UUID from
  //               the per-session CODEX_HOME rollout when the row doesn't
  //               already carry one, matching executeWake's delivery path).
  const resumable =
    (session.agent === 'claude' && sessionId) ||
    (session.agent === 'omp' && session.ompThreadId) ||
    (session.agent === 'codex' && sessionId);
  return {
    handle,
    note: resumable
      ? `session #${session.id} (${session.agent}) — injectable/resumable`
      : `session #${session.id} (${session.agent ?? 'unknown client'}) — NOT safely resumable (no native session id); you will get an inbox nudge while alive, and the wake degrades to notify if your process exits`,
  };
}
