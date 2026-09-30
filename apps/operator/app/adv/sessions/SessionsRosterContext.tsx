'use client';

/**
 * SessionsRosterContext — shares the single `advRoster.list` sync read between the
 * roster LIST and the dossier DETAIL, which now live in two separate slots of
 * the shared `TwoPaneShell` (plan: unified-2-pane-shell). Without this they'd
 * each call the roster resolver separately (and could show divergent snapshots).
 *
 * Mount `<SessionsRosterProvider>` only around the Sessions slots so it subscribes
 * only while the Sessions view is on screen.
 */

import { createContext, useContext } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import type { RosterResponse } from './SessionsRosterView';
import { advRosterArgs } from '@/lib/adv-roster-args';

export interface RosterState {
  data: RosterResponse | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
}

function useRoster(
  workspaceId: string | null | undefined,
  enabled: boolean,
): RosterState {
  const query = useSyncQuery<RosterResponse>({
    queryName: 'advRoster.list',
    args: advRosterArgs(workspaceId),
    enabled,
  });
  return {
    data: query.data?.[0] ?? null,
    error: query.error ? String(query.error) : null,
    loading: query.loading,
    refresh: () => query.invalidate?.(),
  };
}

const RosterCtx = createContext<RosterState | null>(null);

export function SessionsRosterProvider({
  workspaceId = null,
  enabled = true,
  children,
}: {
  workspaceId?: string | null;
  /** Poll only while true. Lets the provider stay mounted across views (so the
   *  shared shell isn't remounted) yet poll only on the Sessions view. */
  enabled?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const state = useRoster(workspaceId, enabled);
  return <RosterCtx.Provider value={state}>{children}</RosterCtx.Provider>;
}

export function useRosterData(): RosterState {
  const v = useContext(RosterCtx);
  if (!v) throw new Error('useRosterData must be used within <SessionsRosterProvider>');
  return v;
}
