import { createFileRoute } from '@tanstack/react-router';
import Page from '@/app/settings/user/search/page';

/**
 * /settings/user/search — translated from `apps/operator/app/settings/user/search/page.tsx`.
 * Client page; re-exported via the page-import pattern (B-4).
 */
export const Route = createFileRoute('/settings/user/search')({
  component: Page,
});
