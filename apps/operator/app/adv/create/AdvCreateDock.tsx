'use client';

/**
 * AdvCreateDock — the /adv "Create" tab (?tab=plans). A fixed two-region
 * dockview split used purely for its resizable, header-less divider:
 *
 *   ┌────┬──────────────┬─────────────────────────────┐
 *   │view│ create:filter│ create:main                 │
 *   │rail│ (sidebar)    │ (active ?view)              │
 *   │+New│ search       │ Plans → one full-width pane │
 *   │    │ plan list    │ Queue/Sessions → list|detail│
 *   └────┴──────────────┴─────────────────────────────┘
 *
 * The outer icon rail owns New-plan plus Plans/Queue/Sessions, create:filter
 * owns the plan-list filter, and create:main renders the active ?view.
 * Navigation is those buttons, NOT dockview tabs — so per-group tab headers
 * are hidden (adv-dock.css `.pc-adv-create`) and every group is locked, which
 * leaves only the sidebar|main sash draggable. Blue-frost theme via .pc-adv-dock.
 */

import { useEffect } from 'react';
import { HarnessDock } from '../../harness/dock/HarnessDock';
import { panelRegistry } from '../../harness/dock/panel-registry';
import { onDockApiBind } from '../../harness/dock/dock-actions';
import PlansListPanel, { CreateViewRail } from './PlansListPanel';
import MainViewPanel from './MainViewPanel';
import '../harnesses/adv-dock.css';
// This dock is loaded as an /adv tab chunk. Keep the Create panels' noncritical
// styles in that chunk instead of making the Overview route pay for them.
import '@/app/admin/plans/plans.css';

let registered = false;
export function ensureCreatePanelsRegistered(): void {
  if (registered) return;
  panelRegistry.register('create:filter', PlansListPanel, { title: 'Filter', keepAlive: true });
  panelRegistry.register('create:main', MainViewPanel, { title: 'Create', keepAlive: true });
  registered = true;
}

export default function AdvCreateDock() {
  useEffect(() => {
    ensureCreatePanelsRegistered();
  }, []);

  // Lock every group so the user can't drag-rearrange the fixed split (the
  // sidebar|main sash stays resizable; programmatic changes are unaffected).
  useEffect(() => {
    let disposers: Array<{ dispose: () => void }> = [];
    const unbind = onDockApiBind((dv) => {
      for (const d of disposers) d.dispose();
      disposers = [];
      if (!dv) return;
      for (const g of dv.groups) g.locked = true;
      disposers.push(
        dv.onDidAddGroup((g) => {
          g.locked = true;
        }),
      );
    });
    return () => {
      for (const d of disposers) d.dispose();
      unbind();
    };
  }, []);

  // Outer wrapper: flex-fill + position:relative so the absolute-inset
  // inner div resolves against THIS box, not <main data-route-transition-page>
  // (position:relative in globals.css) — a bare absolute wrapper here
  // overlaid the whole route and painted over AdvShell's header + tab strip.
  // The inner absolute fill stays: DockviewReact needs a definite box, and
  // WebKitGTK collapses height:100% chains under flex:1 (see HarnessesDock).
  return (
    <div className="pc-adv-create pc-adv-dock" style={{ flex: 1, minHeight: 0, position: 'relative' }}>
      <CreateViewRail />
      <div className="pc-adv-create__dock">
        <HarnessDock layoutName="adv-create2" className="dockview-theme-dark" />
      </div>
    </div>
  );
}
