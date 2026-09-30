import { createFileRoute } from '@tanstack/react-router';
import Page from '@/app/settings/p2p/page';

/**
 * /settings/p2p — the P2P work-sharing owner control surface
 * (p2p-work-distribution-2026-07-02 P-002). Client page re-exported via the
 * page-import pattern (B-4), mirroring /settings/trust and /settings/autonomy.
 *
 * The route is intentionally NOT flag-gated here (matching its siblings): the
 * left-nav gates visibility on FLAGS.P2P (settings/layout.tsx), and FLAGS.P2P
 * defaults ON as the fleet-wide kill-switch — the page itself is structurally
 * inert (opt-in off + zero grants by default), so a reachable route is safe.
 */
export const Route = createFileRoute('/settings/p2p')({
  component: Page,
});
