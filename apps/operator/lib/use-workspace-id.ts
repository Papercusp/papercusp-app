'use client';

import { useState } from 'react';
import { getBrowserWorkspaceId } from '@papercusp/operator-core/lib/browser-workspace';

/**
 * Read the active workspace id — the host-injected `window.__PAPERCUSP_WS__`,
 * falling back to `?ws=` then `'default'` (see ./browser-workspace).
 *
 * Desktop-only: a workspace switch is a full app restart (the Tauri shell
 * calls `app.restart()`), so the id is constant for a process lifetime — no
 * live re-sync is needed. The previous `popstate` / `'workspacechange'`
 * listeners existed for in-app webapp switches without navigation; the webapp
 * is retired, so they never fired and have been removed.
 */
export function useWorkspaceId(): string {
  const [ws] = useState<string>(() => getBrowserWorkspaceId());
  return ws;
}
