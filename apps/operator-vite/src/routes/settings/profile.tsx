import { createFileRoute } from '@tanstack/react-router';
import Page from '@/app/settings/profile/page';

/**
 * /settings/profile — translated from `apps/operator/app/settings/profile/page.tsx`.
 * Client page; re-exported via the page-import pattern (B-4).
 */
export const Route = createFileRoute('/settings/profile')({
  component: Page,
});
