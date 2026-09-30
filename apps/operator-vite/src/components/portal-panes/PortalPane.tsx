/**
 * PortalPane — the document frame for the two pane-only operator routes the
 * cloud portal hosts as its OWN sidebars (owner ask 2026-09-01: "make the two
 * middle panes — the one that houses the accounts and the one that houses the
 * Papercup chat — sidebars of the main cloud portal page, not of the papercusp
 * app").
 *
 * Each route under /portal-panes renders exactly one dock, `docked`, so it
 * fills the iframe the portal sizes for it. The routes are chromeless
 * (CHROMELESS_PREFIXES), so nothing else — no header, env bar, rail, or the
 * OTHER dock — mounts around it; and they are portal-embed locations
 * (PORTAL_EMBED_PATH_PREFIXES), so the theme bridge follows the portal's theme.
 * The path contract itself lives in operator-core's portal-embed.ts, which the
 * portal imports; this component only owns the frame.
 */
import type { ReactNode } from 'react';
import type { PortalPaneId } from '@papercusp/operator-core/lib/portal-embed';

const PORTAL_PANE_CSS = `
.pc-portal-pane {
  position: relative;
  width: 100%;
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
/* The docks size themselves to the frame; the frame must not scroll the page. */
html:has(.pc-portal-pane), body:has(.pc-portal-pane) {
  height: 100%;
  overflow: hidden;
}
`;

export function PortalPane({ pane, children }: { pane: PortalPaneId; children: ReactNode }) {
  return (
    <div
      className={`pc-portal-pane pc-portal-pane--${pane}`}
      data-testid={`portal-pane-${pane}`}
      data-portal-pane={pane}
    >
      <style>{PORTAL_PANE_CSS}</style>
      {children}
    </div>
  );
}
