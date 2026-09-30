/**
 * wsl-tauri.ts — renderer-side wrapper for the WSL onboarding commands.
 *
 * On Windows, papercup's harness stack runs inside a WSL2 distro
 * because the rest of the codebase assumes POSIX. Rather than make
 * users `wsl --install` themselves, the desktop app drives the install
 * + bootstrap from the UI. See `papercusp-desktop/src-tauri/src/wsl_setup.rs`
 * for the state machine.
 *
 * This file is a thin wrapper around the typed Tauri-Specta bindings
 * (`./tauri-bindings.ts`), exposing the WSL state to React components
 * with the same isTauri-feature-detect pattern as `pty-tauri.ts`.
 */

import { invoke as __TAURI_INVOKE } from '@tauri-apps/api/core';

export type WslStateKind =
  | 'NotSupported'
  | 'NotInstalled'
  | 'PendingReboot'
  | 'InstalledNoDistro'
  | 'PendingBootstrap'
  | 'Ready'
  | 'Error';

export interface WslState {
  kind: WslStateKind;
  /** Only set when kind === 'Error'. */
  message?: string;
}

export interface WslStatus {
  state: WslState;
  wslExeAvailable: boolean;
  distros: string[];
  defaultVersion: number;
}

interface WindowWithTauri extends Window {
  __TAURI_INTERNALS__?: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
}

export function isTauri(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean((window as WindowWithTauri).__TAURI_INTERNALS__?.invoke);
}

export async function wslStatus(): Promise<WslStatus | null> {
  if (!isTauri()) return null;
  return await __TAURI_INVOKE<WslStatus>('wsl_status');
}

/**
 * Tagged variant returned by `wsl_install` failure path. `NeedsElevation`
 * means we hit Win32 ERROR_ELEVATION_REQUIRED — the frontend should
 * offer a one-click `wslRelaunchElevated` instead of showing a generic
 * error.
 */
export type WslOpError =
  | { kind: 'NeedsElevation'; message: string }
  | { kind: 'Failed'; message: string };

export async function wslInstall(): Promise<void> {
  // Tauri-Specta surfaces typed errors as a thrown value with `.kind`.
  // Re-throw so callers can `.catch((e: WslOpError) => …)`.
  await __TAURI_INVOKE('wsl_install');
}

export async function wslRelaunchElevated(): Promise<void> {
  await __TAURI_INVOKE('wsl_relaunch_elevated');
}

/**
 * Restart the app after WSL onboarding has reached Ready, so the Rust
 * setup() can spawn the sidecar through `wsl.exe`. This is a normal
 * restart — no UAC, no elevation. Control does not return.
 */
export async function wslFinalizeReady(): Promise<void> {
  await __TAURI_INVOKE('wsl_finalize_ready');
}

export async function wslImport(): Promise<void> {
  await __TAURI_INVOKE('wsl_import');
}

export async function wslBootstrap(): Promise<string> {
  return await __TAURI_INVOKE<string>('wsl_bootstrap');
}

export async function wslUninstall(): Promise<void> {
  await __TAURI_INVOKE('wsl_uninstall');
}
