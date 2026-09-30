/**
 * fleet-claude-token.ts — the dedicated long-lived Claude OAuth token for
 * BACKGROUND fleet sessions (claude-credential-sync-2026-06-10 P-003).
 *
 * Why: autonomous spawns (headless bees, wake-executor resumes, scheduled
 * sessions) that authenticate via the owner's interactive `~/.claude` OAuth
 * participate in its single-use refresh-token rotation — every fleet refresh
 * risks invalidating the owner's terminals (the every-terminal-relogin
 * cascade). A `claude setup-token` token (`sk-ant-oat01…`, no refresh token,
 * ~1y expiry) never rotates, so exporting it as `CLAUDE_CODE_OAUTH_TOKEN` on
 * fleet children removes them from the interactive token family entirely.
 *
 * The path mirrors the REMOTE frame convention: frame-bootstrap installs a
 * staged token at `$HOME/.papercusp/claude-token` and exports
 * `CLAUDE_CODE_OAUTH_TOKEN` for everything the frame spawns
 * (frame-bootstrap.ts `credentials` section). This module is the LOCAL-box
 * leg of the same convention. Mint + install:
 *
 *     claude setup-token            # owner, interactive (browser flow)
 *     # paste the sk-ant-oat01… token into ~/.papercusp/claude-token, 0600
 *
 * Absent file = feature off (children fall back to their config-dir
 * credentials exactly as before).
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where the box-local fleet token lives. Override via
 *  `PAPERCUSP_CLAUDE_TOKEN_PATH` (tests). */
export function fleetClaudeTokenPath(): string {
  return process.env.PAPERCUSP_CLAUDE_TOKEN_PATH || join(homedir(), '.papercusp', 'claude-token');
}

/**
 * The fleet token, or null when unset. Missing/empty/implausible content reads
 * as null — callers treat that as "no fleet token" and change nothing.
 */
export function readFleetClaudeToken(): string | null {
  try {
    const raw = readFileSync(fleetClaudeTokenPath(), 'utf8').trim();
    return raw.startsWith('sk-ant-') ? raw : null;
  } catch {
    return null;
  }
}
