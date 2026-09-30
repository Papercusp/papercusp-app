/**
 * Writes (and tears down) the session-scratch profile for a power-user
 * OMP session.
 *
 * The scratch dir holds everything OMP needs that is *not* the user's
 * own machine config: the appended system prompt, the MCP-client
 * config, bundled skills, and bundled hooks. Nothing here is global —
 * D-007. Cleanup-on-exit is the load-bearing teardown mechanism on
 * every platform (D-010).
 *
 * The refresh token is deliberately NOT written anywhere — it stays in
 * the connect process's memory only (D-009). Only the short-lived
 * access token reaches disk, inside `.mcp.json`.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentBundle } from './bundle-client.js';
import { sessionScratchDir } from './runtime-dir.js';

export interface SessionProfile {
  /** Root scratch dir for this session. */
  scratchDir: string;
  /** Path to the appended-system-prompt file (persona + toolsmd). */
  systemPromptPath: string;
  /** Path to the MCP-client config file. */
  mcpConfigPath: string;
  /** Absolute paths of every written hook file (for `--hook`). */
  hookPaths: string[];
  /** Absolute paths of every written skill file. */
  skillPaths: string[];
}

/** 0600 for files, 0700 for dirs — same-user-only. */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

function writeMcpConfig(path: string, bundle: AgentBundle, accessToken: string): void {
  const config = {
    mcpServers: {
      papercusp: {
        url: bundle.mcp_url,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          // OMP resolves leading-! header values against the spawned
          // process environment. Carry the per-launch session id so
          // MCP calls share identity with the OMP coordination hook.
          'x-papercusp-client': '!printf %s "${PAPERCUSP_SID:-}"',
        },
      },
    },
  };
  writeFileSync(path, JSON.stringify(config, null, 2), { mode: FILE_MODE });
}

/**
 * Materialise the scratch profile for a session. `accessToken` is the
 * current access token — it is written into `.mcp.json` and rewritten
 * later by `rewriteAccessToken` after each refresh.
 */
export function writeProfile(
  authSessionId: string,
  bundle: AgentBundle,
  accessToken: string,
): SessionProfile {
  const scratchDir = sessionScratchDir(authSessionId);
  mkdirSync(scratchDir, { recursive: true, mode: DIR_MODE });

  // System prompt — persona then the cross-tool playbook. An empty
  // persona (v1 has no separate persona file) just yields the playbook.
  const systemPromptPath = join(scratchDir, 'system-prompt.md');
  const systemPrompt = bundle.persona
    ? `${bundle.persona}\n\n${bundle.toolsmd}`
    : bundle.toolsmd;
  writeFileSync(systemPromptPath, systemPrompt, { mode: FILE_MODE });

  // MCP-client config — discovered by OMP from the project dir; see
  // connect.ts for how it is placed where OMP will find it.
  const mcpConfigPath = join(scratchDir, '.mcp.json');
  writeMcpConfig(mcpConfigPath, bundle, accessToken);

  // Skills.
  const skillPaths: string[] = [];
  if (bundle.skills.length > 0) {
    const skillsDir = join(scratchDir, 'skills');
    mkdirSync(skillsDir, { recursive: true, mode: DIR_MODE });
    for (const s of bundle.skills) {
      const p = join(skillsDir, s.name);
      writeFileSync(p, s.source, { mode: FILE_MODE });
      skillPaths.push(p);
    }
  }

  // Hooks — registered with OMP via `--hook=<path>` (no global install).
  const hookPaths: string[] = [];
  if (bundle.hooks.length > 0) {
    const hooksDir = join(scratchDir, 'hooks');
    mkdirSync(hooksDir, { recursive: true, mode: DIR_MODE });
    for (const h of bundle.hooks) {
      const p = join(hooksDir, h.name);
      writeFileSync(p, h.source, { mode: FILE_MODE });
      hookPaths.push(p);
    }
  }

  return { scratchDir, systemPromptPath, mcpConfigPath, hookPaths, skillPaths };
}

/** Rewrite `.mcp.json` with a freshly minted access token after refresh. */
export function rewriteAccessToken(
  profile: SessionProfile,
  bundle: AgentBundle,
  accessToken: string,
): void {
  writeMcpConfig(profile.mcpConfigPath, bundle, accessToken);
}

/** Recursively remove the scratch dir. Safe to call more than once. */
export function cleanupProfile(profile: SessionProfile): void {
  try {
    rmSync(profile.scratchDir, { recursive: true, force: true });
  } catch {
    /* best-effort — $XDG_RUNTIME_DIR / OS temp reclaim is the net */
  }
}
