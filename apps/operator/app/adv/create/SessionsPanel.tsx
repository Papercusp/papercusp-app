'use client';

/**
 * create:sessions dock panel — the live agent roster (list + dossier),
 * lifted from PlansClient's "sessions" view. Self-contained: the roster
 * polls via SessionsRosterProvider (enabled whenever the panel is mounted;
 * keepAlive keeps it polling while the tab is inactive). Selection + filters
 * round-trip through nuqs so they survive reloads + are agent-driveable.
 */

import { parseAsBoolean, parseAsString, useQueryState } from 'nuqs';
import type { PanelComponentProps } from '@/app/harness/dock/panel-registry';
import TwoPaneShell from '@/app/_components/layout/TwoPaneShell';
import {
  SessionsRosterList,
  SessionsRosterDetail,
  type RosterFilters,
} from '@/app/adv/sessions/SessionsRosterView';
import { SessionsRosterProvider } from '@/app/adv/sessions/SessionsRosterContext';
import { useWorkspaceId } from '@/lib/use-workspace-id';
import { useCreateScope, usePlanListMaps, useItemPlanFilter } from './use-create-data';

export default function SessionsPanel(_props?: Partial<PanelComponentProps>) {
  const scope = useCreateScope();
  const maps = usePlanListMaps(scope);
  const [itemPlans] = useItemPlanFilter();
  const [selectedAgent, setSelectedAgent] = useQueryState('agent', parseAsString);
  const [sClient, setSClient] = useQueryState('sClient', parseAsString);
  const [sLive, setSLive] = useQueryState('sLive', parseAsString);
  const [sRole, setSRole] = useQueryState('sRole', parseAsString);
  const [sFile, setSFile] = useQueryState('sFile', parseAsString.withDefault(''));
  const [sStale, setSStale] = useQueryState('sStale', parseAsBoolean.withDefault(false));
  // Scope the roster poll to THIS window's workspace so queen/scout/overwatch
  // (and every live agent) re-resolve when the workspace is switched. Omitting
  // it makes `/api/adv/roster` unscoped ("every workspace") — the switch then
  // appears to do nothing.
  const workspaceId = useWorkspaceId();

  return (
    <SessionsRosterProvider workspaceId={workspaceId} enabled>
      <TwoPaneShell
        className="pc-twopane--sessions"
        list={
          <SessionsRosterList
            planFilters={itemPlans}
            planTitleBySlug={maps.planTitleBySlug}
            selectedAgent={selectedAgent}
            onSelectAgent={(id) => void setSelectedAgent(id)}
            filters={{ client: sClient, liveness: sLive, role: sRole, file: sFile } as RosterFilters}
            onFilterChange={(next) => {
              void setSClient(next.client);
              void setSLive(next.liveness);
              void setSRole(next.role);
              void setSFile(next.file);
            }}
            showStale={sStale}
            onToggleStale={() => void setSStale(!sStale)}
          />
        }
        detail={
          <SessionsRosterDetail
            selectedAgent={selectedAgent}
            onSelectAgent={(id) => void setSelectedAgent(id)}
          />
        }
      />
    </SessionsRosterProvider>
  );
}
