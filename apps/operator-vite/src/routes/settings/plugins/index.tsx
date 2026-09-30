import { createFileRoute } from '@tanstack/react-router';
import Page from '@/app/settings/plugins/page';

/**
 * /settings/plugins/ — translated from `apps/operator/app/settings/plugins/page.tsx`.
 * Client page; re-exported via the page-import pattern (B-4).
 */
export const Route = createFileRoute('/settings/plugins/')({
  component: Page,
});
