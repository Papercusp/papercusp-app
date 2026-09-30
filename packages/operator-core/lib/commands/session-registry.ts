/**
 * Server-side session registry — pairs a workspace with the active
 * leader browser tab so cross-process callers (Oracle, EL webhooks,
 * Pi) can deliver `browser: 'required'` commands to the right tab.
 *
 * See plan §3.3.
 *
 * In-memory only. Browser tabs subscribe via SSE
 * (`/api/agent-mcp/run-command/sse`); leader election is BroadcastChannel-
 * based on the browser side and reuses the existing voice-leader.ts
 * machinery. The leader tab POSTs heartbeats to keep its registration
 * live.
 *
 * Failure modes:
 *   - Tab closes — heartbeat times out (15s); registry drops the entry;
 *     subsequent `deliver()` returns 'no-active-session'.
 *   - Leader changes — new leader registers, old entry is replaced.
 *   - Process restart — registry is empty until tabs re-register; first
 *     few delivers fail with 'no-active-session' (retryable).
 */

import { randomUUID } from 'node:crypto';

import type { CommandResult } from './types';

interface SessionEntry {
  workspace: string;
  sessionId: string;            // tab-assigned; opaque to callers
  lastSeen: number;             // ms epoch
  /** SSE writer — pushes a command request to the tab and returns its result. */
  push: (request: PendingRequest) => void;
}

interface PendingRequest {
  requestId: string;
  command: { id: string; args: unknown };
  /** Resolves when the tab POSTs the result back via the result endpoint. */
  resolve: (result: CommandResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const sessions = new Map<string, SessionEntry>();           // workspace → entry
const pending = new Map<string, PendingRequest>();          // requestId → pending
const HEARTBEAT_TIMEOUT_MS = 15_000;
const COMMAND_TIMEOUT_MS = 10_000;

/** Called by the SSE route when a tab opens its stream. */
export function registerSession(opts: {
  workspace: string;
  sessionId: string;
  push: SessionEntry['push'];
}): void {
  // If the workspace already has an entry, the new one wins (newer leader).
  // The old SSE writer's stream will be closed by the route on detect.
  sessions.set(opts.workspace, {
    workspace: opts.workspace,
    sessionId: opts.sessionId,
    lastSeen: Date.now(),
    push: opts.push,
  });
}

export function heartbeatSession(workspace: string, sessionId: string): boolean {
  const entry = sessions.get(workspace);
  if (!entry || entry.sessionId !== sessionId) return false;
  entry.lastSeen = Date.now();
  return true;
}

export function unregisterSession(workspace: string, sessionId: string): void {
  const entry = sessions.get(workspace);
  if (entry && entry.sessionId === sessionId) sessions.delete(workspace);
}

export function getSession(workspace: string): SessionEntry | undefined {
  const entry = sessions.get(workspace);
  if (!entry) return undefined;
  if (Date.now() - entry.lastSeen > HEARTBEAT_TIMEOUT_MS) {
    sessions.delete(workspace);
    return undefined;
  }
  return entry;
}

/**
 * Deliver a command to the active leader tab and await its result.
 * Returns `{ok: false, error.code: 'no-active-session'}` if no live tab.
 */
export async function deliver(
  workspace: string,
  command: { id: string; args: unknown },
): Promise<CommandResult> {
  const entry = getSession(workspace);
  if (!entry) {
    return {
      ok: false,
      error: {
        code: 'no-active-session',
        message: `no live browser tab for workspace ${workspace}`,
        retryable: true,
        hint: 'open the workspace in a browser',
      },
    };
  }
  const requestId = randomUUID();
  return new Promise<CommandResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve({
        ok: false,
        error: {
          code: 'tab-timeout',
          message: `no response from leader tab in ${COMMAND_TIMEOUT_MS}ms`,
          retryable: true,
        },
      });
    }, COMMAND_TIMEOUT_MS);
    pending.set(requestId, { requestId, command, resolve, reject, timer });
    entry.push({ requestId, command, resolve, reject, timer });
  });
}

/** Called by the result endpoint when a tab POSTs back a command result. */
export function resolveRequest(requestId: string, result: CommandResult): boolean {
  const p = pending.get(requestId);
  if (!p) return false;
  pending.delete(requestId);
  clearTimeout(p.timer);
  p.resolve(result);
  return true;
}

/** Test/diagnostic — list active sessions. */
export function listSessions(): Array<Pick<SessionEntry, 'workspace' | 'sessionId' | 'lastSeen'>> {
  const out: Array<Pick<SessionEntry, 'workspace' | 'sessionId' | 'lastSeen'>> = [];
  for (const e of sessions.values()) {
    out.push({ workspace: e.workspace, sessionId: e.sessionId, lastSeen: e.lastSeen });
  }
  return out;
}
