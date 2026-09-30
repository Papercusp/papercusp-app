/**
 * Short-TTL memo for "the most recently ACTIVE resumable session of one agent".
 *
 * WHY THIS EXISTS (WI-2147549): `GET /api/agent-config` fills its informational
 * `codexDiagnostics` field by calling `listResumableSessions(50)` and picking the
 * first codex row. That call is the WI-38226 activity-scored CTE (adv_sessions ⋈
 * coord_presence ⋈ tool_invocations) and measured ~410ms of the route's ~800ms —
 * paid on EVERY config read, including the portal's Settings page proxy, which
 * showed "Loading agent settings…" for ~1s (3.4s cold) because of it.
 *
 * The semantics are deliberately UNCHANGED: the memo wraps `listResumableSessions`
 * itself, so the "most recently active" ordering and the per-agent floor still
 * decide which row wins (a plain `ORDER BY started_at` query is the bug WI-38226
 * fixed — do not "optimise" this into one). Only the freshness changes: a
 * diagnostics readout may be up to `LATEST_AGENT_SESSION_TTL_MS` stale, exactly the
 * trade `detectBinariesCached` already makes for binary paths.
 *
 * Pinned through `pinModuleState` (repo rule: shared-package module state), so a
 * split module graph cannot hand two callers two independent caches.
 */
import { pinModuleState } from '@papercusp/module-singleton';

import { listResumableSessions, type AdvSessionRow } from './adv-sessions';

/** How stale a memoized "latest session for agent X" may be. */
export const LATEST_AGENT_SESSION_TTL_MS = 30_000;

/** The window `listResumableSessions` is asked for — the value the agent-config route always used. */
export const LATEST_AGENT_SESSION_SCAN = 50;

interface MemoEntry {
  at: number;
  row: AdvSessionRow | null;
}

const memo = pinModuleState(
  '@papercusp/operator-core.latest-agent-session-memo',
  () => new Map<string, MemoEntry>(),
);

export interface LatestAgentSessionOpts {
  /** Override the TTL (tests; a caller that needs fresher data). */
  ttlMs?: number;
  /** Clock seam for tests. */
  now?: () => number;
  /** The listing to memoize over — defaults to the real `listResumableSessions`. */
  list?: (limit: number) => Promise<AdvSessionRow[]>;
}

/**
 * Most recently ACTIVE resumable session whose `agent` is `agent`, or null when
 * none is in the window — memoized per agent for `ttlMs`.
 *
 * A null result is memoized too: "no codex session exists" is as expensive to
 * re-derive as a hit, and a settings page that polls would otherwise pay the full
 * scan on every read precisely when there is nothing to show.
 */
export async function latestResumableSessionForAgentCached(
  agent: string,
  opts: LatestAgentSessionOpts = {},
): Promise<AdvSessionRow | null> {
  const ttlMs = opts.ttlMs ?? LATEST_AGENT_SESSION_TTL_MS;
  const now = (opts.now ?? Date.now)();
  const hit = memo.get(agent);
  if (hit && now - hit.at < ttlMs) return hit.row;

  const list = opts.list ?? listResumableSessions;
  const row = (await list(LATEST_AGENT_SESSION_SCAN)).find((s) => s.agent === agent) ?? null;
  memo.set(agent, { at: now, row });
  return row;
}

/**
 * Drop every memoized entry. For tests that drive the agent-config route more
 * than once per process and assert on what the listing returned THIS time.
 */
export function resetLatestAgentSessionMemo(): void {
  memo.clear();
}
