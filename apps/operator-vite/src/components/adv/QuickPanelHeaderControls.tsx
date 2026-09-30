import AgentsRunningPill from './AgentsRunningPill';

/**
 * QuickPanelHeaderControls — the Quick Panel popup's header status strip
 * (quick-panel-status-pills-2026-07-13). It reuses the EXACT AdvShell header
 * pills, verbatim (owner ask, 2026-07-13: "use the same component"):
 *   - AgentsRunningPill → "⚡ N agents running · M thinking" + the fleet-grouped
 *     roster popover (inspect / wake / focus / message / kill).
 *
 * PotsRunningPill ("▶ N POT running" + a click-to-expand per-pot start/stop
 * control) used to be the FIRST pill here. It was deleted 2026-08-10 by owner
 * directive ([owner 2026-08-10] "remove the ... 'pots running' button", plan
 * retire-mug-kettle-su-only-2026-08-09 P-075) — a start/stop affordance for the
 * retired autonomous tier (D-010). It had TWO mounts, here and in the AdvShell
 * header; both went in the same change, because removing only one leaves the
 * pill alive in the other surface.
 *
 * WHY it lives here, not in the operator/app Quick Panel page: those pill
 * components live under operator-vite/src, and the Quick Panel page is under
 * operator/app — which must not import up-layer from operator-vite/src. So the
 * operator-vite /quick-panel route composes this control and passes it into the
 * page as its `headerSlot` (D-001). Each pill self-hides when there is nothing to
 * show (no local pot / no running agents), so the strip is empty in a quiet
 * workspace. Their styling travels via the shared adv-header-pills.css the pills
 * import, so they render identically here and in the AdvShell header.
 */
export default function QuickPanelHeaderControls() {
  return (
    <>
      <AgentsRunningPill />
    </>
  );
}
