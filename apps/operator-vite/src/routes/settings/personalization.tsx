import { createFileRoute } from '@tanstack/react-router';
import Page from '@/app/settings/personalization/page';

/**
 * /settings/personalization — translated from `apps/operator/app/settings/personalization/page.tsx`.
 * Client page; re-exported via the page-import pattern (B-4).
 */
export const Route = createFileRoute('/settings/personalization')({
  component: Page,
});
