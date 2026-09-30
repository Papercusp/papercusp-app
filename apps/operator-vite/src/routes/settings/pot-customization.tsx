import { createFileRoute } from '@tanstack/react-router';
import Page from '@/app/settings/pot-customization/page';

/**
 * /settings/pot-customization — the owner control surface for a hive's
 * per-instance customization (domain-generic-hive-architecture-2026-06-18
 * P-015 / D-005, D-007). Client page re-exported via the page-import pattern
 * (B-4), mirroring /settings/trust and /settings/autonomy.
 *
 * This wrapper was MISSING (the page shipped 2026-06-19 without it), so the
 * nav-listed page (FLAGS.BLUEPRINT_AWARE_SETTINGS defaults ON → link visible)
 * was unreachable in the live operator-vite router. Restored 2026-07-03
 * alongside the /settings/p2p fix; the settings-nav route-coverage test guards
 * the class from recurring.
 */
export const Route = createFileRoute('/settings/pot-customization')({
  component: Page,
});
