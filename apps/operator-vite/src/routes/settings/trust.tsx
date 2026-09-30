import { createFileRoute } from '@tanstack/react-router';
import Page from '@/app/settings/trust/page';

/**
 * /settings/trust — the owner's trusted-GitHub-user list control surface
 * (shared-hive-trust-admission-2026-06-14 Phase 4 / P-011, Trust A4). Client page
 * re-exported via the page-import pattern (B-4), mirroring /settings/autonomy.
 */
export const Route = createFileRoute('/settings/trust')({
  component: Page,
});
