/**
 * AgentsTab — everything that RUNS A MODEL, in two lanes.
 *
 * WHY THIS IS THE LLM HALF (owner, 2026-07-26): "Is everything in the agents tab an
 * llm? its an 'agents' tab, only the actual llm runs should show there, other things
 * that run in a schedule lets make a new tab for all the routines that are
 * deterministic." They were right — of the 140 non-loop schedules the tab rendered,
 * 55 spawn a model and 85 were git commits, GC, canary probes and outbox drains,
 * carrying equal visual weight to the things spending the weekly Claude limit.
 *
 * The split is now the tab boundary and it is derived, not curated: a row lands here
 * iff `spend !== 'none'`, computed from its `target_role` in
 * lib/automation/routine-classification. Everything else is the System tab. The two
 * lenses partition the catalog by construction, so the owner mandate ("no routines
 * that dont get surfaced") cannot be violated by a category nobody claimed — which
 * is exactly how `infra` once hid 40 routines.
 *
 * LANES (owner ask 2026-07-25: "The agents tab should have two subtabs the same
 * way the mugtab has the 'now' and 'work' subtab"), built from the SAME
 * `pc-auto__lane*` strip the Mug uses so the panes read as siblings in one rail:
 *
 *   • SCHEDULED — the model-backed schedules: armed continuation loops, the wake
 *     family, the learning pipeline (formerly the Blender tab) and doc repair
 *     (formerly the Docs tab). Ordered by STATE, not subject — see AutomationPane.
 *   • DYNAMIC — the LIVE agent roster (owner: "the agents tab used to have a list of
 *     all active agents, what happened to it? Bring that back"). That roster is
 *     SwarmTab, which left this rail for the op-chat sidebar under WI-5162; the pane
 *     itself never went anywhere, so this remounts it rather than growing a second
 *     roster that could disagree with the first about who is running.
 *
 * The two lanes are the honest split of what "an agent" means: a schedule is a plan
 * to spawn one, a dynamic agent is one running right now.
 *
 * ASK sits above both lanes (owner ask 2026-07-25: "the ask tab should be in the
 * agents pane not the conversations pane"). It is collapsed by default so it costs
 * one row of height, and belongs to neither lane because addressing an agent is the
 * tab's primary action, not a view.
 */
import { useMemo } from 'react';
import { Bot, CalendarClock, Users } from 'lucide-react';
import { parseAsStringLiteral, useQueryState } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import type { AutomationCatalog } from '@papercusp/operator-core/lib/automation/catalog';
import AutomationPane, { rowsForLens, scheduleLaneValue } from './AutomationPane';
import AskAgentPane from './AskAgentPane';
import SwarmTab from './SwarmTab';
// Relative, not `@/…`: the `@` alias points at the operator (Next) tree.
import { isRunningAgent, type RosterAgent } from '../adv/AgentsRunningPill';
import { advRosterArgs } from '@/lib/adv-roster-args';

export const AGENT_VIEWS = ['routines', 'dynamic'] as const;
export type AgentView = (typeof AGENT_VIEWS)[number];

/** advRoster.list returns a single-element array wrapping the roster object. */
interface RosterResponse {
  active: RosterAgent[];
}

export default function AgentsTab({ active }: { active: boolean }) {
  const [view, setView] = useQueryState(
    'qAgents',
    parseAsStringLiteral(AGENT_VIEWS).withDefault('routines'),
  );

  // Both reads are the SAME cached queries their lanes already issue (identical
  // queryName + args ⇒ one cache entry, one fetch), so summarising them on the
  // lane buttons costs nothing extra.
  const cat = useSyncQuery<AutomationCatalog>({
    queryName: 'automation.catalog',
    args: {},
    staleTime: 20_000,
    enabled: active,
  });
  const roster = useSyncQuery<RosterResponse>({
    queryName: 'advRoster.list',
    args: advRosterArgs(null),
    enabled: active,
    staleTime: 8_000,
  });

  const routineValue = useMemo(() => {
    const rows = rowsForLens(cat.data?.[0]?.routines ?? [], 'llm');
    return cat.loading && rows.length === 0 ? '…' : scheduleLaneValue(rows);
  }, [cat.data, cat.loading]);

  const runningCount = useMemo(
    () => (roster.data?.[0]?.active ?? []).filter(isRunningAgent).length,
    [roster.data],
  );
  // Guard on the DERIVED count, not on `!roster.data`, to match the Scheduled lane
  // above. The sync layer can hand back a present-but-empty `data` while the first
  // real read is still in flight, and `!roster.data` is false the moment that
  // happens — so the old guard flashed a confident "0 running" (and SwarmTab's
  // "fleet · 0 live") over a fleet of ~75, which reads as "the roster is broken"
  // in exactly the pane this tab exists to show. Verified live 2026-07-25: the
  // lane settled to "75 running" ~3s after the misleading 0.
  const dynamicValue = roster.loading && runningCount === 0 ? '…' : `${runningCount} running`;

  const lanes = [
    { id: 'routines' as const, label: 'Scheduled', value: routineValue, icon: CalendarClock },
    { id: 'dynamic' as const, label: 'Dynamic', value: dynamicValue, icon: Users },
  ];

  if (!active) return null;

  return (
    <div className="pclsb-agents" data-testid="agents-tab">
      <AskAgentPane active={active} />

      <div className="pc-auto__lanes" role="tablist" aria-label="Agents views">
        {lanes.map((lane) => {
          const Icon = lane.icon;
          const selected = lane.id === view;
          return (
            <button
              key={lane.id}
              id={`agents-lane-${lane.id}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`agents-panel-${lane.id}`}
              className="pc-auto__lane"
              onClick={() => void setView(lane.id)}
              data-testid={`agents-lane-${lane.id}`}
            >
              {/* Inner span carries the icon+copy row. WebKitGTK — the Tauri
                  webview this ships in — IGNORES flex set on a <button>
                  element, so declaring this row on the button itself stacked
                  the icon on top of the label on the real desktop while
                  looking correct in Chromium (EI-18135716653974462 / WI-5581,
                  the same defect the HUD board was migrated off after an
                  owner-screenshotted regression). Keep the layout in here. */}
              <span className="pc-auto__lane-inner">
                <span className="pc-auto__lane-icon">
                  <Icon size={13} aria-hidden />
                </span>
                <span className="pc-auto__lane-copy">
                  <span className="pc-auto__lane-label">{lane.label}</span>
                  <span className="pc-auto__lane-value">{lane.value}</span>
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <div
        id={`agents-panel-${view}`}
        role="tabpanel"
        aria-labelledby={`agents-lane-${view}`}
        className="pclsb-agents__panel"
      >
        {view === 'routines' ? (
          <AutomationPane
            active={active}
            lens="llm"
            title="Agents"
            subtitle="Scheduled model runs"
            icon={Bot}
            blurb="Everything on a schedule that RUNS A MODEL — armed continuation loops, the wake family, the learning pipeline and doc repair. Every row here can spend money when it fires; the free system sweeps live in the System tab."
          />
        ) : (
          // The live roster, unchanged — same membership rule, same fleet
          // colouring, same expandable rows as everywhere else it appears.
          <SwarmTab active={active} />
        )}
      </div>
    </div>
  );
}
