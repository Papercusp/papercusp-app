'use client';

import { LayoutGrid } from 'lucide-react';
import { FLAGS } from '@papercusp/flags';
import { AddPanelCatalog } from '../../harness/dock/AddPanelCatalog';
import { resetLayout } from '../../harness/dock/dock-actions';
import { Tooltip } from '../../harness/Tooltip';
import { useFlag } from '../../../lib/flag-hooks';
import { useLexicon } from '../../../lib/useLexicon';

interface Props {
  slug: string;
}

/**
 * /adv/harnesses top bar — DOCK-level actions only: add panel, reset layout.
 *
 * The POT-level actions that used to sit here — "Workspaces (N)"
 * (HarnessWorkspacesButton) and "Register sub-pots" (RegisterSubsButton) — moved
 * UP to the pot bar (AdvPotBar) on 2026-07-27 (owner ask: "in the work tab remove
 * these buttons they dont belong there … put those buttons on the pot selector bar
 * above it, and all tabs that have the pot selector bar should also have it").
 * They were pot administration wearing dock chrome, and keying them to the Work
 * tab's drilled-into MEMBER slug was the wrong scope besides. What is left here is
 * genuinely about THIS dock: which panels it shows and how they are laid out.
 * RegisterSubsButton now lives in ./RegisterSubsButton.tsx.
 *
 * The legacy coding-pipeline stat cards (pulse / lanes / passed/total /
 * $ spent / health) were removed 2026-06-30. They read the superseded
 * per-harness orchestrator-status model (`harnessStatus.snapshot` /
 * `harnessLanes.snapshot`), which the Queen/bee placement model replaced —
 * so they sat frozen/zero. The underlying `harness_status` / `harness_lanes`
 * tables and the `/orchestrator/status` endpoint are KEPT: `harness_lanes` is
 * the live agent-lane occupancy tracker (PID-swept every ~30s) and both
 * `harness_status` / `harness_lanes` are read by the device-harnesses /
 * device-feeds surfaces — so the tables stay. NOTE: the `harnessStatus.snapshot`
 * SYNC resolver was retired as a dead query (whole-app-sync-payload-audit-2026-07-19
 * P-001) — it had no consumer and shipped ~16MB per invalidation; `harnessStatus.byHarness`
 * (the live per-row status resolver) remains.
 *
 * The harness selector + Start/Stop + running-agents-thinking pills now
 * live in the AdvShell header (one global instance shared across every
 * /adv tab), so they are intentionally absent here.
 */
export default function HarnessTopBar({ slug }: Props) {
  const t = useLexicon();
  const workUnits = t('workUnit', { plural: true });
  // WI-259 P-006 — cross-member browse: the "Hive content" rollup panel is
  // registered always but only offered in the Add-panel catalog when the Hive
  // umbrella flag is on (inert outside a hive, so the gate is mostly a courtesy).
  const crossMemberBrowse = useFlag(FLAGS.THE_HIVE);

  return (
    <div className="pc-adv-topbar">
      <div className="pc-adv-topbar__actions">
        {slug && (
          <AddPanelCatalog
            defaultSlug={slug}
            allowedTypes={[
              'adv:work-items',
              'adv:detail',
              'adv:agents',
              'adv:logs',
              'adv:contributors',
              'adv:insights',
              // Registering a panel in HarnessesDock is NOT enough to make it
              // reachable — this allowlist is what the catalog renders, so a type
              // missing here is a panel that exists and nothing can open. Caught
              // live: adv:sync-health was registered, unit-green, and absent from
              // the running catalog for exactly this reason.
              'adv:sync-health',
              // adv:member-work was registered in HarnessesDock with the comment
              // "openable from the panel menu" — but it was never listed here, so
              // it has NOT been openable since it landed. Same trap, found by the
              // guard added alongside this line.
              'adv:member-work',
              // adv:dep-graph (dependency-health-pane-2026-08-02) landed the same
              // way for the third time: registered in HarnessesDock, unit-green,
              // never listed here — so it shipped unopenable. Caught by the same
              // guard, which is now three-for-three.
              'adv:dep-graph',
              ...(crossMemberBrowse ? ['adv:hive-content'] : []),
              'adv:chat',
            ]}
            className="pc-adv-topbar__add-panel"
          />
        )}
        {slug && (
          <Tooltip label={`Reset this ${t('pot', { lower: true })}'s panel layout to the default ${workUnits} / Detail split`}>
            <button
              type="button"
              className="pc-adv-topbar__reset-layout"
              onClick={() => resetLayout()}
              aria-label="Reset layout"
            >
              <LayoutGrid size={13} aria-hidden /> Reset layout
            </button>
          </Tooltip>
        )}
      </div>

      <style>{`
        .pc-adv-topbar {
          display: flex;
          align-items: center;
          gap: 16px;
          padding: 10px 18px;
          border-bottom: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
          background: var(--bg-2, rgba(255, 255, 255, 0.045));
          min-height: 48px;
        }
        .pc-adv-topbar__actions {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-shrink: 0;
        }
        .pc-adv-topbar__add-panel {
          background: color-mix(in oklab, var(--accent, #38bdf8), transparent 84%);
          color: var(--accent-strong, #7dd3fc);
          border: 1px solid color-mix(in oklab, var(--accent, #38bdf8), transparent 60%);
          border-radius: 999px;
          font-weight: 700;
          letter-spacing: 0;
        }
        .pc-adv-topbar__add-panel:hover {
          background: color-mix(in oklab, var(--accent, #38bdf8), transparent 72%);
          color: var(--fg, #e7f7ff);
        }
        .pc-adv-topbar__reset-layout {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          padding: 4px 10px;
          font-size: 11px;
          font-weight: 600;
          color: var(--fg-dim, #b9d4e8);
          background: var(--bg-2, rgba(255, 255, 255, 0.045));
          border: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
          border-radius: 999px;
          cursor: pointer;
        }
        .pc-adv-topbar__reset-layout:hover {
          color: var(--fg, #e7f7ff);
          border-color: var(--accent, #38bdf8);
        }
      `}</style>
    </div>
  );
}
