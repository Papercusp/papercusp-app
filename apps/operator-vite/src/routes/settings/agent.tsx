import { createFileRoute } from '@tanstack/react-router';
import Page from '@/app/settings/agent/page';

/**
 * /settings/agent — translated from `apps/operator/app/settings/agent/page.tsx`.
 * Client page; re-exported via the page-import pattern (B-4).
 */
export const Route = createFileRoute('/settings/agent')({
  component: Page,
});
