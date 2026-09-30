import { createFileRoute } from '@tanstack/react-router';
import Page from '@/app/settings/plugins/tools/page';

/**
 * /settings/plugins/tools — translated from `apps/operator/app/settings/plugins/tools/page.tsx`.
 * Client page; re-exported via the page-import pattern (B-4).
 */
export const Route = createFileRoute('/settings/plugins/tools')({
  component: Page,
});
