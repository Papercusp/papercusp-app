/**
 * Single source of truth for the operator's "Papercusp root" path.
 *
 * The substrate moved from ~/.papercusp/ to per-workspace storage at
 * ~/.papercusp-workspaces/<id>/.papercusp/. Callers should never join
 * `homedir() + '.papercusp'` directly — use {@link papercuspRoot} so the
 * workspace migration stays transparent.
 *
 * Resolution order:
 *   1. PAPERCUSP_HOME env var (escape hatch)
 *   2. Active workspace per ~/.papercusp-workspaces/registry.json `current`
 *   3. Default workspace (~/.papercusp-workspaces/default/.papercusp)
 *   4. Legacy ~/.papercusp/ (pre-workspaces installs)
 *
 * Resolution is cached per request (the same call within a tight loop
 * reuses the result), but invalidates on any input change — so a
 * registry.json edit, a workspace dir creation, or a PAPERCUSP_HOME env
 * flip is reflected on the next call. A naive lifetime cache (the
 * pre-2026-05-02 implementation) caused stale paths under Next dev when
 * registry.json changed mid-session: routes that had cached the old
 * workspace served data from it until the operator was restarted.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { workspacesRoot, activeWorkspaceId, DEFAULT_WORKSPACE_ID } from './workspace-registry';
import { homedir } from 'node:os';
import { join } from 'node:path';

interface CacheKey {
  env: string | undefined;
  /** The request-scoped active workspace — so two concurrent windows on
   *  different workspaces don't share one cached root (P-052). */
  workspace: string;
  registryMtime: number;
  registryContent: string | null;
}
let cached: { key: CacheKey; value: string } | null = null;

function currentKey(): CacheKey {
  const idx = join(workspacesRoot(), 'registry.json');
  let mtime = 0;
  let content: string | null = null;
  try {
    mtime = statSync(idx).mtimeMs;
    content = readFileSync(idx, 'utf8');
  } catch { /* missing/unreadable — both fields stay zero/null */ }
  return {
    env: process.env.PAPERCUSP_HOME,
    workspace: activeWorkspaceId(),
    registryMtime: mtime,
    registryContent: content,
  };
}

function keysEqual(a: CacheKey, b: CacheKey): boolean {
  return (
    a.env === b.env &&
    a.workspace === b.workspace &&
    a.registryMtime === b.registryMtime &&
    a.registryContent === b.registryContent
  );
}

export function papercuspRoot(): string {
  const key = currentKey();
  if (cached && keysEqual(cached.key, key)) return cached.value;
  const value = resolve();
  cached = { key, value };
  return value;
}

/** Test-only: clear the cache so a different env can be picked up. */
export function _resetPapercuspRootForTests(): void {
  cached = null;
}

function resolve(): string {
  if (process.env.PAPERCUSP_HOME) return process.env.PAPERCUSP_HOME;

  // Resolve against the REQUEST workspace (activeWorkspaceId → request-scoped
  // ALS, falling back to the global outside a request), NOT the registry
  // `current` directly — otherwise a request on workspace B reads A's
  // ~/.papercusp under the shared-operator model (P-052).
  const ws = activeWorkspaceId();
  if (ws) {
    const cand = join(workspacesRoot(), ws, '.papercusp');
    if (existsSync(cand)) return cand;
  }

  // Was a lazy `require()` — a vestige that crashed under a pure-ESM tsx
  // context on cloud frames ("require is not defined"; found live 2026-06-06).
  // The module is already statically imported above; no cycle exists.
  const def = join(workspacesRoot(), DEFAULT_WORKSPACE_ID, '.papercusp');
  if (existsSync(def)) return def;

  return join(homedir(), '.papercusp');
}

/** Convenience for "give me a path under the papercusp root". */
export function papercuspPath(...parts: string[]): string {
  return join(papercuspRoot(), ...parts);
}

/**
 * The Papercusp root for a **specific** workspace — NOT the active one.
 *
 * Use this when you build state/env that targets a workspace other than the
 * request's active one. The canonical case is the console/spawn envelope, which
 * sets `PAPERCUSP_HOME` for the *selected* workspace (`opts.workspaceId`) — which
 * is not necessarily `activeWorkspaceId()`. Resolving that via the global
 * {@link papercuspRoot} is the latent bug behind a spawned agent getting
 * `PAPERCUSP_WORKSPACE=<picked>` but `PAPERCUSP_HOME=<active>` (e.g. launching a
 * console for workspace B while `registry.current` is A). See the agent-insight
 * `workspace-id-pin-and-harness-membership`.
 *
 * Falls back to {@link papercuspRoot} when the workspace's dir isn't provisioned
 * yet, so a not-yet-created workspace never yields a non-existent home.
 */
export function papercuspRootForWorkspace(workspaceId: string): string {
  if (workspaceId) {
    const cand = join(workspacesRoot(), workspaceId, '.papercusp');
    if (existsSync(cand)) return cand;
  }
  return papercuspRoot();
}

/** Convenience for "give me a path under a specific workspace's papercusp root". */
export function papercuspPathForWorkspace(
  workspaceId: string,
  ...parts: string[]
): string {
  return join(papercuspRootForWorkspace(workspaceId), ...parts);
}
