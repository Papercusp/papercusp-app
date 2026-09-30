'use client';

/**
 * useWorkspaceLabel — the active workspace's display NAME, for UI that wants to
 * show the workspace as a root header (the /adv selector's group label, the
 * Working-grid hive cards). Resolves from the workspace registry the same way
 * WorkspaceSwitcher does (listWorkspaces → resolveActiveWorkspaceId), and falls
 * back to the raw workspace id until the one cheap registry read lands.
 *
 * Lives in apps/operator/lib (not operator-vite) so BOTH the operator-vite
 * components and the apps/operator/app pages can import it via
 * `@/lib/useWorkspaceLabel` — same placement rationale as useLexicon.
 */
import { useEffect, useState } from 'react';

import { getBrowserWorkspaceId, resolveActiveWorkspaceId } from '@papercusp/operator-core/lib/browser-workspace';
import { listWorkspaces } from '@papercusp/operator-core/lib/workspaces-tauri';

export function useWorkspaceLabel(): string {
  const [label, setLabel] = useState<string>(() => getBrowserWorkspaceId());
  useEffect(() => {
    let cancelled = false;
    listWorkspaces()
      .then((reg) => {
        if (cancelled) return;
        const activeId = resolveActiveWorkspaceId(reg, getBrowserWorkspaceId());
        const name = reg?.workspaces?.find((w) => w.id === activeId)?.name;
        if (name) setLabel(name);
      })
      .catch(() => {
        /* keep the id fallback */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return label;
}
