/**
 * Spawn-context primitives shared between the pty bridge (Pi tab) and
 * the native console launcher (the `+` button in the chrome).
 *
 * Both surfaces need to answer the same questions:
 *   - "what's the project dir for this harness slug?"
 *   - "what's the state dir?"
 *   - "what env should I inject so a process here can talk back to the operator?"
 *
 * Originally lived as closure-local helpers inside
 * `app/api/_hono/pty.ts`. Extracted so the console launcher can call
 * them without dragging in the pty router. No behavior change for
 * pty.ts — the existing functions delegate here.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { loadHarnessRegistry } from './harness-registry';
import { resolveLongLivedSessionMcpBaseUrl } from './mcp-base-url';

/**
 * Resolve a harness's filesystem project dir via the harness registry.
 * Returns null when the slug isn't registered. `workspaceId` scopes the
 * lookup to a specific workspace (harnesses are workspace-scoped);
 * omitted = the active workspace (preserves existing callers).
 */
export async function resolveProjectDir(slug: string, workspaceId?: string): Promise<string | null> {
  return (await loadHarnessRegistry(workspaceId)).projects.find((p) => p.slug === slug)?.path ?? null;
}

/** Resolve the harness's state directory (`<projectDir>/.papercusp`). */
export async function resolveStateDir(slug: string, workspaceId?: string): Promise<string | null> {
  const projectDir = await resolveProjectDir(slug, workspaceId);
  if (!projectDir) return null;
  return join(projectDir, '.papercusp');
}

/**
 * Pick the cwd for a spawned process. Defaults to projectDir; falls
 * back to a per-lane worktree if `laneId` is given and the worktree
 * directory exists.
 */
export function resolveSpawnCwd(opts: {
  projectDir: string;
  stateDir: string | null;
  laneId?: string;
}): string {
  if (opts.laneId && opts.stateDir) {
    const wt = join(opts.stateDir, 'worktrees', opts.laneId);
    if (existsSync(wt)) return wt;
  }
  return opts.projectDir;
}

/**
 * Build the env vars that any harness-scoped process should see — the
 * harness slug, the session-recording dir (for omp/pi), and the URL the
 * process can call back into the operator on.
 *
 * Used by:
 *   - Pi pty spawns (the existing pty bridge)
 *   - Native console launches (the `+` button)
 *
 * The console-launcher additionally folds in `PAPERCUSP_WORKSPACE` and
 * `PAPERCUSP_HOME`; those aren't included here because the pty bridge
 * doesn't currently set them and we want pure-refactor behavior parity.
 */
export function resolveContextEnv(opts: {
  slug: string;
  stateDir: string | null;
  requestUrl?: string;
}): Record<string, string> {
  const env: Record<string, string> = {};
  if (opts.stateDir) env.PI_CODING_AGENT_DIR = join(opts.stateDir, 'pi-sessions');
  env.PAPERCUSP_HARNESS_SLUG = opts.slug;
  // Browser PTYs inherit the operator host's ambient process env. On staging
  // that includes PAPERCUSP_OPERATOR_URL=:3170, which turns a terminal-opened
  // psu session into a long-lived direct client of the single UI request host.
  // Pin the agent/MCP path to the existing resilient proxy explicitly. Keep
  // PAPERCUSP_API_BASE below on the request origin: browser-side callbacks are
  // still staging/current-build scoped, while long-lived MCP + hook traffic is
  // isolated from that UI process. An explicit body.env supplied by the PTY
  // caller is spread after this result and remains the deliberate A/B override.
  env.PAPERCUSP_OPERATOR_URL = resolveLongLivedSessionMcpBaseUrl();
  if (opts.requestUrl) {
    try {
      const u = new URL(opts.requestUrl);
      env.PAPERCUSP_API_BASE = `${u.protocol}//${u.host}`;
    } catch { /* non-URL request */ }
  }
  return env;
}
