'use client';

import { useCallback, useEffect, useState } from 'react';
import type { StepStatus } from './types';

interface PersistentState {
  last_visited_step?: string;
  finished_at?: string;
}

interface SetupStatusResponse {
  statuses: Record<string, StepStatus>;
}

export function useWizardStatuses() {
  const [statuses, setStatuses] = useState<Record<string, StepStatus>>({});
  const [persisted, setPersisted] = useState<PersistentState>({});

  const refreshAll = useCallback(async () => {
    try {
      const [statusRes, persistedRes] = await Promise.all([
        fetch('/api/desktop/setup-status', { cache: 'no-store' }),
        fetch('/api/desktop/setup-wizard-state', { cache: 'no-store' }),
      ]);
      if (statusRes.ok) {
        const j = (await statusRes.json()) as SetupStatusResponse;
        setStatuses(j.statuses ?? {});
      }
      if (persistedRes.ok) {
        setPersisted((await persistedRes.json()) as PersistentState);
      }
    } catch {
      // network failures leave statuses unchanged
    }
  }, []);

  const setLastVisitedStep = useCallback(async (stepId: string) => {
    try {
      await fetch('/api/desktop/setup-wizard-state', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ last_visited_step: stepId }),
      });
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    const id = setInterval(() => void refreshAll(), 10000);
    return () => clearInterval(id);
  }, [refreshAll]);

  return { statuses, persisted, refreshAll, setLastVisitedStep };
}
