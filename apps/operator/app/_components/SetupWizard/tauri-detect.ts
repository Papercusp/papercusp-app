'use client';

/**
 * Detect whether the operator app is being served inside the Tauri
 * desktop shell. Browser sessions hitting localhost:3055/3070/3088
 * directly will not have these globals — keep the wizard graceful
 * either way (button captions and behavior should change, not break).
 */
export function isTauri(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean(
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ ||
      (window as unknown as { __TAURI__?: unknown }).__TAURI__,
  );
}
