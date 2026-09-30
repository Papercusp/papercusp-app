import { createFileRoute } from '@tanstack/react-router';
import Page from '@/app/settings/user/page';

/**
 * /settings/user/ — translated from `apps/operator/app/settings/user/page.tsx`.
 * Client page; re-exported via the page-import pattern (B-4).
 */
export const Route = createFileRoute('/settings/user/')({
  component: Page,
});
