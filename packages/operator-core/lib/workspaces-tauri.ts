// Browser-side wrapper around the workspace tauri commands defined in
// papercusp-desktop/src-tauri/src/main.rs.
//
// Two modes:
//   - desktop (Tauri shell injects __TAURI_INTERNALS__): use the native
//     commands, which also kill the sidecar + per-workspace PG backend
//     (embedded-postgres-server) on switch.
//   - webapp (no Tauri runtime): fall back to the operator's
//     /api/workspaces HTTP endpoints, which write the same registry.json
//     and let papercuspRoot() pick up the change on its next call.
//
// Tauri-side calls go through the typed tauri-bindings produced by
// tauri-specta; the public API of this file is unchanged.

import { commands, type Workspace as BindingsWorkspace, type Registry } from './tauri-bindings';
import { navigateClient } from './client-navigation';

export type Workspace = BindingsWorkspace;

export interface WorkspaceRegistry {
  current: string;
  workspaces: Workspace[];
}

function isDesktopRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

export function isDesktop(): boolean {
  return isDesktopRuntime();
}

/**
 * Tauri v2's app (non-plugin) commands are LOCAL-CONTENT-ONLY: `__TAURI_INTERNALS__` is
 * injected on EVERY origin the desktop shell can navigate to (dev/prod/staging/local), but
 * the runtime's ACL only grants app commands on the dev shell's `devUrl` origin. On every
 * other origin `commands.workspaces*()` throws `"<cmd> not allowed. Command not found"` /
 * `"...Plugin not found"` BEFORE the Rust handler ever runs — see
 * agent-insights/env-switcher-bar-one-in-webview-bar-tauri-sourced.mdx (the same mechanism
 * already fixed there for `list_envs` / `wsl_status`). WI-2143: `isDesktopRuntime()` alone
 * can't tell dev from a remote origin, so every desktop-first call below used to let this
 * denial propagate as an uncaught error (a recurring "workspaces: workspaces_list not
 * allowed. Command not found" toast on every WorkspaceSwitcher mount on a non-dev origin).
 * Because the handler never ran on a denial, falling back to the HTTP path — which performs
 * the exact same `registry.json` read/mutation — is always safe (no double-effect risk).
 * Narrowly matched so a GENUINE desktop-side error (e.g. `r.status === 'error'`) still
 * surfaces to the caller instead of silently degrading.
 */
function isAclDeniedError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /not allowed\.\s*(Command|Plugin) not found/i.test(msg);
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    cache: 'no-store',
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(((j as { error?: string }).error) ?? `HTTP ${r.status}`);
  return j as T;
}

export async function listWorkspaces(): Promise<WorkspaceRegistry> {
  if (isDesktopRuntime()) {
    try {
      return (await commands.workspacesList()) as Registry;
    } catch (e) {
      if (!isAclDeniedError(e)) throw e;
      // ACL-denied on a non-dev origin — fall through to the HTTP path below.
    }
  }
  return http<WorkspaceRegistry>('/api/workspaces');
}

export async function createWorkspace(name: string): Promise<Workspace> {
  if (isDesktopRuntime()) {
    try {
      const r = await commands.workspacesCreate(name);
      if (r.status === 'error') throw new Error(r.error);
      return r.data;
    } catch (e) {
      if (!isAclDeniedError(e)) throw e;
    }
  }
  return http<Workspace>('/api/workspaces', { method: 'POST', body: JSON.stringify({ name }) });
}

export async function renameWorkspace(id: string, name: string): Promise<void> {
  if (isDesktopRuntime()) {
    try {
      const r = await commands.workspacesRename(id, name);
      if (r.status === 'error') throw new Error(r.error);
      return;
    } catch (e) {
      if (!isAclDeniedError(e)) throw e;
    }
  }
  await http<unknown>(`/api/workspaces/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  });
}

export async function deleteWorkspace(id: string): Promise<void> {
  if (isDesktopRuntime()) {
    try {
      const r = await commands.workspacesDelete(id);
      if (r.status === 'error') throw new Error(r.error);
      return;
    } catch (e) {
      if (!isAclDeniedError(e)) throw e;
    }
  }
  await http<unknown>(`/api/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/**
 * Switch THIS window to a different workspace.
 *
 * Phase E (P-050): the desktop shell no longer kills the sidecar + restarts.
 * One shared sidecar serves every workspace and scoping is per-request
 * (`?ws=` / the workspace header → ALS → RLS GUC), so switching is just a
 * per-window navigation to `/harness?ws=<id>` — other windows are untouched
 * (P-031). The desktop branch first calls the Tauri command to persist
 * `registry.current` (the default for a fresh launch / the first window), then
 * navigates exactly like the webapp branch.
 *
 * In webapp mode the HTTP endpoint writes the same `registry.current`; the
 * operator's papercuspRoot() invalidates on registry mtime, and the navigation
 * re-scopes client-side state (cached fetches, plugin-host snapshots).
 */

export function resolveWorkspaceSwitchTarget(id: string, opts?: { resetTo?: string }): string {
  return opts?.resetTo ?? `/harness?ws=${encodeURIComponent(id)}`;
}
export async function switchWorkspace(id: string, opts?: { resetTo?: string }): Promise<void> {
  let handledByDesktop = false;
  if (isDesktopRuntime()) {
    try {
      const r = await commands.workspacesSwitch(id);
      if (r.status === 'error') throw new Error(r.error);
      handledByDesktop = true;
    } catch (e) {
      if (!isAclDeniedError(e)) throw e;
      // ACL-denied on a non-dev origin — fall through to the HTTP path below.
    }
  }
  if (!handledByDesktop) {
    await http<unknown>('/api/workspaces/switch', { method: 'POST', body: JSON.stringify({ id }) });
  }
  if (typeof window !== 'undefined') {
    // Force a hard navigation: the window must reload so the operator host
    // re-injects `__PAPERCUSP_WS__` for the new workspace. A soft SPA nav would
    // change the URL's `?ws=` but leave getBrowserWorkspaceId() (which prefers
    // the injected global) on the old workspace — the switch would silently
    // no-op and the window keeps showing the workspace it was already in.
    navigateClient(resolveWorkspaceSwitchTarget(id, opts), { hard: true });
  }
}

/**
 * Open an ADDITIONAL window pinned to a workspace (Phase E, P-053).
 *
 * Desktop: the Tauri shell opens a new `WebviewWindow` at `/harness?ws=<id>`
 * against the one shared sidecar; the window self-scopes via `?ws=`. Webapp:
 * there's no multi-window shell, so open a new browser tab at `?ws=<id>` — the
 * closest equivalent. Re-opening an already-open workspace window focuses it
 * (handled shell-side).
 */
export async function openWorkspaceWindow(id: string): Promise<void> {
  if (isDesktopRuntime()) {
    const r = await commands.workspacesOpenWindow(id);
    if (r.status === 'error') throw new Error(r.error);
    return;
  }
  if (typeof window !== 'undefined') {
    window.open(`/harness?ws=${encodeURIComponent(id)}`, '_blank', 'noopener');
  }
}
