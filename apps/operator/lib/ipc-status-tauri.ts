/**
 * Browser-side wrapper for the desktop `endpoint_ipc_status` command — "is /api
 * actually riding IPC right now, and if not, what precisely is stopping it".
 *
 * Mirrors the shape of packages/operator-core/lib/version-tauri.ts (guard on the
 * Tauri runtime, return null in web mode so a caller can render conditionally
 * without an @tauri-apps/api dependency). It lives HERE rather than beside that
 * file because operator-core's copy of the generated bindings is a second, stale
 * snapshot that does not carry this command (EI-18899708711154370); importing the
 * canonical `@/lib/tauri-bindings` is what makes the call typed at all.
 *
 * THE RETURN CONTRACT IS THREE-VALUED, on purpose:
 *   { kind: 'unavailable' }  — not the desktop shell; there is no IPC bridge to
 *                             report on. NOT a failure, and not zeros.
 *   { kind: 'error', error } — the command was reachable and refused.
 *   { kind: 'ok', status }   — a real reading.
 * Collapsing 'unavailable' into zeros/nulls is precisely the bug class this whole
 * observability pass exists to remove: a dead instrument must never be
 * indistinguishable from a healthy one (plan no-http-anywhere-2026-07-28, D-011).
 */

import { commands, type IpcStatus } from '@papercusp/operator-core/lib/tauri-bindings';

export type { IpcStatus };

export type IpcStatusRead =
  | { kind: 'unavailable' }
  | { kind: 'error'; error: string }
  | { kind: 'ok'; status: IpcStatus };

function isDesktopRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

export function isDesktop(): boolean {
  return isDesktopRuntime();
}

/**
 * Read IPC bridge health. Cheap and side-effect-free on the Rust side (one small
 * filesystem read), so it is safe to poll from a panel.
 */
export async function readIpcStatus(): Promise<IpcStatusRead> {
  if (!isDesktopRuntime()) return { kind: 'unavailable' };
  try {
    const r = await commands.endpointIpcStatus();
    if (r.status === 'error') return { kind: 'error', error: r.error };
    return { kind: 'ok', status: r.data };
  } catch (e) {
    // A rejected invoke (capability denied, command missing in an older shell) is
    // an error to SHOW, not an absence to hide.
    return { kind: 'error', error: e instanceof Error ? e.message : String(e) };
  }
}

/** Whether this shell's desktop owns the Server that served this document. */
export function ipcOwnsContentOrigin(read: IpcStatusRead): boolean {
  return read.kind === 'ok' && read.status.ownerIsContentOrigin === true;
}

/** Fail closed for browser, forwarded/hosted Server, ACL, and old-shell paths. */
export async function canUseContentOriginDesktopActions(): Promise<boolean> {
  return ipcOwnsContentOrigin(await readIpcStatus());
}
