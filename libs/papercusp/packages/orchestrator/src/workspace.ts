/**
 * Workspace resolution. The active workspace ID is the only piece of
 * orchestrator state that has to live on the filesystem before any DB
 * connection exists — chicken-and-egg: we can't query Postgres for "which
 * workspace are we in" without first knowing which DB to connect to.
 *
 * The registry at `~/.papercusp-workspaces/registry.json` is owned by
 * the operator (and the CLI's `papercusp workspace` commands). The
 * orchestrator only reads it; it never writes.
 *
 * Format mirrors `apps/operator/lib/workspace-registry.ts`:
 *   { current: 'default', workspaces: [{ id, name, dbName, ... }, ...] }
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_WORKSPACE_ID = 'default';

/**
 * Resolve the workspaces root (`~/.papercusp-workspaces`), honoring
 * `PAPERCUSP_WORKSPACES_ROOT` before falling back to `homedir()`.
 *
 * The orchestrator can run with `HOME` remapped to a per-workspace dir
 * (P-051 spawned-child case); a bare `homedir()` there resolves to a
 * NESTED registry that disagrees with the real one
 * (agent-insights/workspaces-root-vs-remapped-home). Mirrors
 * `workspacesRoot()` in `@papercusp/operator-core`'s `workspace-registry.ts`.
 */
function workspacesRootDir(): string {
  const env = process.env.PAPERCUSP_WORKSPACES_ROOT;
  if (env && env.trim()) return env;
  return join(homedir(), '.papercusp-workspaces');
}

function registryPath(): string {
  return join(workspacesRootDir(), 'registry.json');
}

interface WorkspaceRegistry {
  current?: string;
  workspaces?: Array<{ id: string; name?: string; dbName?: string }>;
}

/**
 * Returns the active workspace ID. Order of resolution:
 *   1. PAPERCUSP_WORKSPACE_ID env var (CLI/test override)
 *   2. registry.json `current` field
 *   3. 'default' fallback
 *
 * Synchronous + cached after first call. The registry is small and the
 * orchestrator queries it many times per run; cache amortizes I/O.
 */
let cached: string | null = null;

export function activeWorkspaceId(): string {
  if (cached !== null) return cached;
  const env = process.env.PAPERCUSP_WORKSPACE_ID;
  if (env && env.trim()) {
    cached = env.trim();
    return cached;
  }
  const registryFile = registryPath();
  if (existsSync(registryFile)) {
    try {
      const raw = JSON.parse(readFileSync(registryFile, 'utf8')) as WorkspaceRegistry;
      if (typeof raw.current === 'string' && raw.current.trim()) {
        cached = raw.current.trim();
        return cached;
      }
    } catch {
      /* malformed registry — fall through to default */
    }
  }
  cached = DEFAULT_WORKSPACE_ID;
  return cached;
}

/** Test-only: clear the cache so platform/env mocks take effect. */
export function _resetActiveWorkspaceCache(): void {
  cached = null;
}

/**
 * Absolute path of a workspace's fake-HOME dir (Phase E, P-051).
 *
 * In the shared-operator model (D-008) one sidecar serves every workspace under
 * a neutral process HOME, so each spawned child gets its OWN workspace's HOME
 * for filesystem-credential isolation (`~/.claude`, `~/.gitconfig`). The dir is
 * provisioned by the desktop shell (`workspaces.rs::link_workspace_credentials`).
 * Honors `PAPERCUSP_WORKSPACES_ROOT` (set by the shell) and falls back to
 * `~/.papercusp-workspaces`, mirroring `apps/operator/lib/workspace-registry.ts`.
 */
export function workspaceHomeDir(id: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = env.PAPERCUSP_WORKSPACES_ROOT?.trim() || workspacesRootDir();
  return join(root, id);
}
