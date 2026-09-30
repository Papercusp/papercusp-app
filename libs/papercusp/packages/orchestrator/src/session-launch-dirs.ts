/**
 * session-launch-dirs.ts — the ONE source of truth for where a tracked agent
 * session's per-session isolation dirs live (unify-launch-mechanics-2026-06-09
 * P-002/P-003/P-004).
 *
 * Launch mechanics is where the coordination bugs live: EI-153 (cross-agent
 * conversation-store bleed) is exactly a "the config dir wasn't keyed the same
 * way on the launch leg and the resume leg" bug. The fix is to converge every
 * launch path AND the wake-executor resume leg onto these helpers, so the dir a
 * session is launched with and the dir it is resumed with are computed by the
 * SAME code — never two string literals that can drift.
 *
 * THE KEY is the session's **coord owner id** (`PAPERCUSP_SID` /
 * `adv_sessions.coord_owner_id`). On the orchestrator hive path that equals the
 * minted spawn id (`PAPERCUSP_SPAWN_ID`); on the interactive role path it is the
 * `role-<uuid>` sid bootstrap-role mints. Either way it is the value the resume
 * leg re-reads off the adv_sessions row, so keying every dir by it makes launch
 * and resume resolve the same path by construction.
 *
 * Pure path math + env reads — no I/O, no domain coupling. The credential-symlink
 * writer that actually provisions a claude config dir is `writeSpawnClaudeConfig`
 * (spawn-mcp.ts); it takes a `persistentDir` computed here.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Root for per-session claude `CLAUDE_CONFIG_DIR` isolation (transcript + plugin
 * isolation). Override via `PAPERCUSP_SESSION_CLAUDE_DIR` (tests + the
 * multi-session testbed point it at a tmp root).
 */
export function sessionClaudeRoot(): string {
  return (
    process.env.PAPERCUSP_SESSION_CLAUDE_DIR ||
    join(homedir(), '.papercusp', 'session-claude')
  );
}

/**
 * The per-session `CLAUDE_CONFIG_DIR` for a tracked launch, keyed by the
 * session's coord owner id. claude writes the conversation transcript under
 * `<dir>/projects/**`; a tracked launch keeps it persistent so
 * `claude --resume <sessionId>` at wake time finds the session file.
 */
export function sessionClaudeConfigDir(ownerId: string): string {
  return join(sessionClaudeRoot(), ownerId);
}

/** Root for the per-session signed MCP config (`.mcp.json`) of a tracked launch. */
export function sessionMcpRoot(): string {
  return (
    process.env.PAPERCUSP_SESSION_MCP_DIR ||
    join(homedir(), '.papercusp', 'session-mcp')
  );
}

/**
 * The per-session signed-MCP config dir for a tracked launch, keyed by coord
 * owner id. The launch writes `<dir>/.mcp.json`; the wake-executor resume leg
 * remounts it via `--mcp-config <dir>/.mcp.json --strict-mcp-config` so a
 * resumed session wakes with the SAME role-scoped tool surface it launched with.
 */
export function sessionMcpDir(ownerId: string): string {
  return join(sessionMcpRoot(), ownerId);
}

/** The `.mcp.json` path inside a session's MCP config dir. */
export function sessionMcpJsonPath(ownerId: string): string {
  return join(sessionMcpDir(ownerId), '.mcp.json');
}

/**
 * Root for per-session codex `CODEX_HOME` isolation. Override via
 * `PAPERCUSP_SU_CODEX_HOMES_DIR`. codex carries no forced native session id, so
 * its home is keyed by the adv-session row id (the resume leg recovers the
 * conversation uuid from the home's rollout); see `codexHomeForSessionKey`.
 */
export function codexHomesRoot(): string {
  return (
    process.env.PAPERCUSP_SU_CODEX_HOMES_DIR ||
    join(homedir(), '.papercusp', 'su-codex-homes')
  );
}

/** The per-session `CODEX_HOME` for a tracked codex session, keyed by a session key
 *  (the adv-session row id for tracked sessions). */
export function codexHomeForSessionKey(sessionKey: string | number): string {
  return join(codexHomesRoot(), `session-${sessionKey}`);
}
