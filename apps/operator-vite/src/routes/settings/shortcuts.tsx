import { createFileRoute } from '@tanstack/react-router';
import Page from '@/app/settings/shortcuts/page';

/**
 * /settings/shortcuts — translated from `apps/operator/app/settings/shortcuts/page.tsx`.
 * Client page; re-exported via the page-import pattern (B-4).
 */
export const Route = createFileRoute('/settings/shortcuts')({
  component: Page,
});
