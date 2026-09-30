import { createFileRoute } from '@tanstack/react-router';
import Page from '@/app/settings/operator/page';

/**
 * /settings/operator — translated from `apps/operator/app/settings/operator/page.tsx`.
 * Client page; re-exported via the page-import pattern (B-4).
 */
export const Route = createFileRoute('/settings/operator')({
  component: Page,
});
