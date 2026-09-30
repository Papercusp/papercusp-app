// Browser-side wrappers for the desktop app's version + auto-update
// commands. Web mode (papercuspai.com) returns nulls / no-ops so the
// caller can render conditionally without an @tauri-apps/api dep.
//
// Implementations call into the typed Tauri-Specta bindings, but the
// public API of this file is unchanged — callers don't need to touch
// the envelope shape returned by Specta-wrapped commands.

import { commands, type UpdateInfo as BindingsUpdateInfo } from './tauri-bindings';

export type UpdateInfo = BindingsUpdateInfo;

function isDesktopRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

export function isDesktop(): boolean {
  return isDesktopRuntime();
}

export async function appVersion(): Promise<string | null> {
  if (!isDesktopRuntime()) return null;
  return commands.appVersion();
}

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (!isDesktopRuntime()) return null;
  const r = await commands.checkForUpdate();
  if (r.status === 'error') throw new Error(r.error);
  return r.data;
}

export async function installUpdate(): Promise<void> {
  if (!isDesktopRuntime()) throw new Error('not in desktop mode');
  const r = await commands.installUpdate();
  if (r.status === 'error') throw new Error(r.error);
}

/**
 * Roll the desktop app BACK to an older, already-released `tag` (the Update
 * Center "Revert" action, desktop-update-center-and-release-tooling P-4). The
 * Rust `revert_to` command downloads that tag's asset, minisign-verifies it
 * against the baked updater pubkey, swaps the binary, and relaunches — the
 * deliberate-downgrade sibling of `installUpdate`. Web mode has nothing to
 * revert, so it throws the same not-in-desktop error installUpdate does.
 */
export async function revertTo(tag: string): Promise<void> {
  if (!isDesktopRuntime()) throw new Error('not in desktop mode');
  const r = await commands.revertTo(tag);
  if (r.status === 'error') throw new Error(r.error);
}
