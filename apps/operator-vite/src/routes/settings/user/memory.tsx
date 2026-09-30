import { createFileRoute } from '@tanstack/react-router';
import Page from '@/app/settings/user/memory/page';

/**
 * /settings/user/memory — translated from `apps/operator/app/settings/user/memory/page.tsx`.
 * Client page; re-exported via the page-import pattern (B-4).
 */
export const Route = createFileRoute('/settings/user/memory')({
  component: Page,
});
