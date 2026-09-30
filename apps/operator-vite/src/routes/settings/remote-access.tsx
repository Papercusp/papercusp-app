import { createFileRoute } from '@tanstack/react-router';
import Page from '@/app/settings/remote-access/page';

/**
 * /settings/remote-access — Settings → Remote access (external-app-access P-010, D-025).
 * Client page; re-exported via the page-import pattern (B-4). Replaces /settings/mobile.
 */
export const Route = createFileRoute('/settings/remote-access')({
  component: Page,
});
