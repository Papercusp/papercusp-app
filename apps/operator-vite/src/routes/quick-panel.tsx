import { createFileRoute } from '@tanstack/react-router';
import Page from '@/app/quick-panel/page';
import QuickPanelHeaderControls from '../components/adv/QuickPanelHeaderControls';

/**
 * /quick-panel — the global-shortcut popup's tabbed body (saved prompts /
 * docs search / brainstorm). The desktop palette window
 * (papercusp-desktop/src-tauri/src/docs_search.rs) loads this route.
 * Client page; re-exported via the page-import pattern (B-4).
 * Plan: quick-panel-saved-prompts-2026-07-13 (P-005).
 *
 * The route composes the operator-vite AdvShell "N POT running" + "N agents
 * running" pills and injects them as the page's headerSlot — the pills live
 * under operator-vite/src, which the operator/app page cannot import up-layer,
 * so composition happens here (quick-panel-status-pills-2026-07-13 D-001).
 */
export const Route = createFileRoute('/quick-panel')({
  component: QuickPanelRoute,
});

function QuickPanelRoute() {
  return <Page headerSlot={<QuickPanelHeaderControls />} />;
}
